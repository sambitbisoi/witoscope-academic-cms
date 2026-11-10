// npm run import:seed [-- --dry-run] [--file <…_vN.xlsx>]
//
// Loads a WitoScope Question Attributes workbook (v10 or later, from ~/WitoScope/ContentResearch/
// QuestionBank; never v2 or the witoscope-app repo) into cms, as cms_owner, in ONE transaction (design §7).
// Default file: the highest WitoScope_Question_Attributes_vN.xlsx in that folder.
//   1. cms_rule_versions + derived-field config (Derived Attributes, Engine Check); cms_config
//      current_rule_version moves to this version when it is at least as new (v11: Sambit, 10 Nov 2026)
//   2. catalogues: strategy types, insights, concepts (+ links, prerequisite topics),
//      misconceptions, typical sets (+ concepts)
//   3. rules: attribute defs, tagging rubric, calibration cases, keyed by rule version, so
//      versions load side by side
//   4. gold set: bank = 'gold' questions, + cms_gold_meta (use, reasoning, review notes)
// Re-runnable: catalogues are upserted with audit rows and never deleted. An existing gold
// question that the workbook changed gets, under the versioning rule, a typo fix in place or a
// new approved version (logged in cms_reviews) — only from the current or a newer workbook, so
// re-running an older one never turns gold back. A gold question with an open draft is left alone.
// Requires the topic lists to be imported first (topics are referenced).
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { applyTypo, enc, loadCatalog, textsFromDb, versionColumns, writeChildren } from './import-chapter.ts';
import { goldAction, ruleNo, workbookIsCurrent } from '../shared/rules.ts';
import { stableJson } from '../shared/json.ts';
import { checkFile } from '../shared/checks.ts';
import { derive } from '../shared/derive.ts';
import type { ChapterFile } from '../shared/types.ts';
import { classify, structureHash, textsOf } from '../shared/version.ts';
import { assertCmsOwner, connect } from './lib/db.ts';
import { upsertCatalogue, type UpsertCounts } from './lib/upsert.ts';
import { parseDerivedConfig } from './lib/v10-config.ts';
import { parseSeed, type SeedProblem } from './lib/v10-seed.ts';
import { readRaw } from './lib/xlsx.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fi = args.indexOf('--file');
const QB = join(homedir(), 'WitoScope', 'ContentResearch', 'QuestionBank');
const newest = () => {
  const found = readdirSync(QB).map((f) => /^WitoScope_Question_Attributes_v(\d+)\.xlsx$/.exec(f)).filter((x) => !!x).sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!found[0]) throw new Error(`no WitoScope_Question_Attributes_vN.xlsx in ${QB}`);
  return join(QB, found[0][0]);
};
const file = fi >= 0 ? args[fi + 1]! : newest();

const m = /_v(\d+)\.xlsx$/.exec(basename(file));
if (!m) throw new Error(`cannot tell the workbook version from the file name ${basename(file)} (expected …_vN.xlsx)`);
const ruleVersion = `v${m[1]}`;
if (ruleNo(ruleVersion) < 10) throw new Error(`only v10 or later is approved for the seed; got ${ruleVersion}`);

const wb = await readRaw(file);
const sheet = (name: string) => {
  const s = wb.sheets.get(name);
  if (!s) throw new Error(`sheet "${name}" is missing from ${basename(file)}`);
  return s;
};
const config = parseDerivedConfig(sheet('Derived Attributes'), sheet('Engine Check'));
const seed = parseSeed(wb.sheets, ruleVersion);
const problems: SeedProblem[] = [...seed.problems];
const counts: Record<string, UpsertCounts | Record<string, number>> = {};
const goldLog: string[] = [];

class DryRunRollback extends Error {}
const sql = connect();
let importId: number | null = null;
let result: 'ok' | 'partial' | 'failed' = 'ok';
try {
  await assertCmsOwner(sql);
  await sql.begin(async (tx) => {
    const [imp] = await tx`
      insert into cms.cms_imports (kind, file_path, file_hash, options)
      values ('seed', ${file.replace(homedir(), '~')}, ${wb.sha256}, ${tx.json({ dry_run: dryRun, rule_version: ruleVersion })})
      returning import_id`;
    importId = Number(imp!.import_id);
    // The current rule version (what Generate, tagging, the model check and the editor use) moves forward
    // only. An older workbook loads only its own rules (scoped to its version); config, catalogues, gold
    // and gold meta stay as the current version left them.
    const [cv] = await tx`select value from cms.cms_config where key = 'current_rule_version'`;
    const wasCurrent = typeof cv?.value === 'string' ? cv.value as string : null;
    const isCurrent = workbookIsCurrent(ruleVersion, wasCurrent);
    const up = async <T extends object>(table: string, keys: (keyof T & string)[], rows: T[], jsonCols: string[] = [], scope?: { col: string; value: string }) => {
      if (!isCurrent && !scope) { counts[table] = { skipped_older_workbook: rows.length }; return; }
      const r = await upsertCatalogue(tx, table, keys, rows, { jsonCols, byLabel: 'seed importer', importId: importId!, reason: `${basename(file)} (${ruleVersion})`, scope });
      counts[table] = r.counts;
      problems.push(...r.notes);
    };

    // 1. rule version + config
    await tx`
      insert into cms.cms_rule_versions (rule_version, notes, source_file, source_hash)
      values (${ruleVersion}, 'WitoScope Question Attributes', ${basename(file)}, ${wb.sha256})
      on conflict (rule_version) do update set source_file = excluded.source_file, source_hash = excluded.source_hash`;
    if (isCurrent && wasCurrent !== ruleVersion) {
      await tx`insert into cms.cms_config (key, value, note) values ('current_rule_version', ${tx.json(ruleVersion)}, ${`set by the seed from ${basename(file)}`})
               on conflict (key) do update set value = excluded.value, note = excluded.note`;
      await tx`insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, import_id, reason)
               values ('catalogue', 'cms_config', 'current_rule_version', 'edit_catalogue', ${tx.json({ value: { before: wasCurrent, after: ruleVersion } })},
                       'seed importer', ${importId}, ${`${basename(file)} (${ruleVersion})`})`;
    }
    if (!isCurrent) problems.push({ level: 'warning', where: 'rule version', message: `${ruleVersion} is older than the current ${wasCurrent}: only its rules are loaded; config, catalogues, gold and the current version are left unchanged` });
    const note = `from ${basename(file)} (${ruleVersion}), Derived Attributes + Engine Check`;
    // A key whose value is unchanged keeps its note (the version that first set it), so a new workbook with
    // the same derived-field config logs no edits.
    const oldCfg = new Map((await tx`select key, value, note from cms.cms_config`).map((r) => [r.key as string, r]));
    await up('cms_config', ['key'], Object.entries(config).map(([key, value]) => {
      const o = oldCfg.get(key);
      return { key, value, note: o && stableJson(o.value) === stableJson(value) ? o.note as string : note };
    }), ['value']);
    // The seed manages only the derived-field keys; other config (admin_user_id) is not its business.
    for (let i = problems.length - 1; i >= 0; i--) if (problems[i]!.where === 'cms_config') problems.splice(i, 1);
    if (isCurrent) (counts.cms_config as UpsertCounts).missing_from_source = 0;

    // References the catalogues need from the curriculum
    const topics = new Map((await tx`select topic_id, chapter_id, class from cms.cms_topics`).map((t) => [t.topic_id as string, t]));
    const chapters = new Set((await tx`select chapter_id from cms.cms_chapters`).map((c) => c.chapter_id as string));
    if (!topics.size) throw new Error('no topics in the CMS; run `npm run import:topics` first');
    const keep = <T>(rows: T[], ok: (r: T) => string | null, where: string, level: 'error' | 'warning' = 'error') =>
      rows.filter((r) => { const why = ok(r); if (why) problems.push({ level, where, message: `${why}; not loaded` }); return !why; });

    // 2. catalogues
    await up('cms_strategy_types', ['value'], seed.strategyTypes);
    const strategyValues = new Set(seed.strategyTypes.map((s) => s.value));
    await up('cms_insights', ['insight_id'], keep(seed.insights, (i) => (i.strategy_type && !strategyValues.has(i.strategy_type as string) ? `${i.insight_id}: strategy type "${i.strategy_type}" is not on Strategy Types` : null), 'Insight Catalogue'));

    const concepts = keep(seed.concepts, (c) => (c.topic_id && !topics.has(c.topic_id as string) ? `${c.concept_id}: topic ${c.topic_id} is not in the CMS` : null), 'Gold Concepts');
    for (const c of concepts) {
      const t = c.topic_id ? topics.get(c.topic_id as string) : undefined;
      if (t && t.class !== c.class) problems.push({ level: 'warning', where: 'Gold Concepts', message: `${c.concept_id}: grade ${c.class} but topic ${c.topic_id} is class ${t.class}` });
    }
    await up('cms_concepts', ['concept_id'], concepts);
    const conceptIds = new Set(concepts.map((c) => c.concept_id as string));
    await up('cms_misconceptions', ['misconception_id'], keep(seed.misconceptions, (x) => (!conceptIds.has(x.concept_id as string) ? `${x.misconception_id}: concept ${x.concept_id} is not loaded` : null), 'Misconceptions'));
    await up('cms_concept_links', ['from_concept', 'to_concept', 'kind'], keep(seed.conceptLinks, (l) => (!conceptIds.has(l.to_concept) ? `${l.from_concept} → ${l.to_concept} (${l.kind}): ${l.to_concept} is not a concept in the gold set` : null), 'Gold Concepts', 'warning'));
    await up('cms_concept_prereq_topics', ['concept_id', 'topic_id'], keep(seed.prereqTopics, (p) => (!topics.has(p.topic_id) ? `${p.concept_id}: prerequisite topic ${p.topic_id} is not in the CMS` : null), 'Gold Concepts', 'warning'));
    const sets = keep(seed.typicalSets, (s) => (!chapters.has(s.chapter_id as string) ? `${s.typical_set_id}: chapter ${s.chapter_id} is not in the CMS`
      : s.topic_id && !topics.has(s.topic_id as string) ? `${s.typical_set_id}: topic ${s.topic_id} is not in the CMS` : null), 'Typical Sets Catalogue');
    await up('cms_typical_sets', ['typical_set_id'], sets);
    const setIds = new Set(sets.map((s) => s.typical_set_id as string));
    await up('cms_typical_set_concepts', ['typical_set_id', 'concept_id'], keep(seed.setConcepts, (s) => (!setIds.has(s.typical_set_id) ? `${s.typical_set_id} not loaded` : !conceptIds.has(s.concept_id) ? `${s.typical_set_id}: concept ${s.concept_id} is not a concept in the gold set` : null), 'Typical Sets Catalogue', 'warning'));

    // 3. rules (scoped to this rule version)
    const scope = { col: 'rule_version', value: ruleVersion };
    await up('cms_attribute_defs', ['rule_version', 'attribute'], seed.attributeDefs, [], scope);
    await up('cms_tagging_rubric', ['rule_version', 'attribute'], seed.rubric, [], scope);
    await up('cms_calibration_cases', ['rule_version', 'case_id'], seed.calibration, [], scope);

    // 4. gold set, checked with the same §8 rules as chapter files (gold mode)
    const gc: Record<string, number> = { created: 0, unchanged: 0, typo_fixed: 0, new_version: 0, changed_not_updated: 0, blocked: 0 };
    const metas: ((typeof seed.gold)[number]['meta'] & { question_id: string })[] = [];
    counts.gold = gc;
    const cat = await loadCatalog(tx, { chapter_id: '' } as ChapterFile);
    const groups = new Map<string, typeof seed.gold>();
    for (const g of seed.gold) groups.set(`${g.chapter_id}|${g.class}`, [...(groups.get(`${g.chapter_id}|${g.class}`) ?? []), g]);
    for (const golds of groups.values()) {
      const g0 = golds[0]!;
      const synthetic: ChapterFile = { file_schema: 'cms-chapter/1.0', attribute_version: ruleVersion, subject: g0.subject, class: g0.class,
        chapter_id: g0.chapter_id, generated: { by: 'v10 seed', date: '2026-11-08' }, questions: golds.map((g) => g.question) };
      cat.chapter = chapters.has(g0.chapter_id) ? { chapter_id: g0.chapter_id, subject: g0.subject } : null;
      const ps = checkFile(synthetic, cat, { gold: true });
      problems.push(...ps.map((p) => ({ level: p.level, where: `Gold ${p.key}`, message: p.message })));
      const blocked = new Set(ps.filter((p) => p.level === 'error').map((p) => p.key));
      if (ps.some((p) => p.level === 'error' && p.key === 'file')) for (const g of golds) blocked.add(g.qid);

      for (const g of golds) {
        if (blocked.has(g.qid)) { gc.blocked!++; continue; }
        const q = g.question;
        const hash = structureHash(q, q.topic_id);
        const [existing] = await tx`select question_id, current_version, placement_note from cms.cms_questions where question_id = ${g.qid}`;
        const d = derive(q, g.class, (id) => cat.concepts.get(id)?.class, config);
        const cols = { ...versionColumns(q, q.topic_id, d, hash, importId!), created_from: 'seed' };
        if (existing) {
          const [cur] = await tx`select * from cms.cms_question_versions where question_id = ${g.qid} and version_no = ${existing.current_version}`;
          const change = classify({ structureHash: cur!.content_hash, texts: await textsFromDb(tx, Number(cur!.version_id)) }, { structureHash: hash, texts: textsOf(q) });
          const act = goldAction(change.kind, cur!.status, isCurrent);
          const target = `${g.qid} v${cur!.version_no}`;
          if (act === 'unchanged') gc.unchanged!++;
          else if (act === 'report_only' || act === 'blocked_open_version') {
            gc.changed_not_updated!++;
            problems.push({ level: 'warning', where: `Gold ${g.qid}`, message: act === 'report_only'
              ? `differs in this older workbook (${change.kind}); left unchanged`
              : `changed in the workbook, but v${cur!.version_no} is ${cur!.status} in the CMS; finish or withdraw that edit and re-run the seed` });
          } else if (act === 'typo_fix' && change.kind === 'typo') {
            await applyTypo(tx, Number(cur!.version_id), g.qid, q);
            await tx`insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, import_id, reason)
                     values ('question_version', 'cms_question_versions', ${target}, 'typo_fix', ${tx.json(change.diff as never)}, 'seed importer', ${importId}, ${`${basename(file)} (${ruleVersion}): wording only`})`;
            gc.typo_fixed!++;
            goldLog.push(`${g.qid}: typo fix in v${cur!.version_no} (${Object.keys(change.diff).join(', ')})`);
          } else {
            // A new approved version: gold is the reviewed reference set, and the workbook is its review.
            const next = Number(existing.current_version) + 1;
            const before = cur as Record<string, unknown>;
            const diff = Object.fromEntries(Object.entries(cols).filter(([k, v]) => k in before && !['import_id', 'content_hash', 'created_from'].includes(k)
              && stableJson(before[k] ?? null) !== stableJson(v ?? null)).map(([k, v]) => [k, { before: before[k] ?? null, after: v ?? null }]));
            const [v] = await tx`insert into cms.cms_question_versions ${tx({ question_id: g.qid, version_no: next, status: 'approved', ...enc(tx, cols) } as never)} returning version_id`;
            await writeChildren(tx, Number(v!.version_id), q);
            await tx`update cms.cms_questions set ${tx({ topic_id: q.topic_id, class: g.class, typical_set_id: q.typical_set_id, clone_batch_id: q.clone_batch_id,
              locale: q.locale, current_version: next, approved_version: next } as never)} where question_id = ${g.qid}`;
            await tx`insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, import_id, reason)
                     values ('question_version', 'cms_question_versions', ${`${g.qid} v${next}`}, 'new_version',
                             ${tx.json({ from_version: cur!.version_no, change: change.kind === 'new' ? change.reason : 'wording', fields: diff } as never)},
                             'seed importer', ${importId}, ${`${basename(file)} (${ruleVersion}); approved as gold from the workbook`})`;
            gc.new_version!++;
            goldLog.push(`${g.qid}: v${cur!.version_no} → v${next} approved (${Object.entries(diff).map(([k, x]) => `${k} ${JSON.stringify(x.before)}→${JSON.stringify(x.after)}`).join(', ') || (change.kind === 'new' ? change.reason : 'wording')})`);
          }
          metas.push({ question_id: g.qid, ...g.meta });
          continue;
        }
        if (!isCurrent) { gc.changed_not_updated!++; problems.push({ level: 'warning', where: `Gold ${g.qid}`, message: 'only in this older workbook; not created' }); continue; }
        await tx`insert into cms.cms_questions ${tx({ question_id: g.qid, bank: 'gold', subject: g.subject, file_key: null, chapter_id: g.chapter_id,
          topic_id: q.topic_id, class: g.class, typical_set_id: q.typical_set_id, pattern_id: null, clone_batch_id: q.clone_batch_id,
          locale: q.locale, current_version: 1, approved_version: 1 })}`;
        // [guess] gold questions are the reviewed reference set: version 1 is approved
        const [v] = await tx`insert into cms.cms_question_versions ${tx({ question_id: g.qid, version_no: 1, status: 'approved', ...enc(tx, cols) } as never)} returning version_id`;
        await writeChildren(tx, Number(v!.version_id), q);
        metas.push({ question_id: g.qid, ...g.meta });
        gc.created!++;
      }
    }
    // Gold meta (use, reasoning, review notes): inserted for new gold; changes (e.g. Test only → Prompt
    // example) are applied with an audit row, but only from the current or a newer workbook.
    await up('cms_gold_meta', ['question_id'], metas);

    const errors = problems.filter((p) => p.level === 'error').length;
    result = errors ? 'partial' : 'ok';
    await tx`update cms.cms_imports set finished_at = now(), result = ${result}, counts = ${tx.json(counts as never)},
             error_report = ${tx.json(problems as never)} where import_id = ${importId}`;
    if (dryRun) throw new DryRunRollback();
  });
} catch (e) {
  if (!(e instanceof DryRunRollback)) throw e;
} finally {
  await sql.end();
}

console.log(`\nSeed ${ruleVersion}${dryRun ? ' (DRY RUN — nothing saved)' : ` #${importId}`}: ${basename(file)} sha256 ${wb.sha256.slice(0, 12)} → ${result.toUpperCase()}`);
for (const [t, c] of Object.entries(counts)) {
  const x = c as Record<string, number>;
  console.log(`  ${t.padEnd(26)} ` + ('inserted' in x
    ? `+${x.inserted} new · ${x.updated} updated · ${x.unchanged} unchanged${x.missing_from_source ? ` · ${x.missing_from_source} not in workbook` : ''}`
    : Object.entries(x).map(([k, n]) => `${k} ${n}`).join(' · ')));
}
if (goldLog.length) { console.log(`\nGold changes:`); for (const l of goldLog) console.log(`  ${l}`); }
const errs = problems.filter((p) => p.level === 'error');
const warns = problems.filter((p) => p.level === 'warning');
if (errs.length) { console.log(`\n${errs.length} error(s) — those rows were not loaded:`); for (const p of errs) console.log(`  ✗ ${p.where}: ${p.message}`); }
if (warns.length) { console.log(`\n${warns.length} warning(s):`); for (const p of warns) console.log(`  ! ${p.where}: ${p.message}`); }

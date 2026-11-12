// npm run chapter -- validate <file.json>                      dry run: full report, nothing saved
// npm run chapter -- import   <file.json> [--force-new-version]
//
// Imports one chapter file (schema/chapter.schema.json) as cms_owner, in one
// transaction. Per question key (design §6, decisions 5–7):
//   new key                          → new MQ/SQ/GQ ID, version 1 (draft)
//   unchanged                        → skipped
//   open draft, created by an import
//     and not edited since           → draft replaced in place, logged in cms_reviews
//   open draft edited / in review    → blocked
//   typo only (no open version)      → same version, text fixed in place, logged as typo_fix
//   anything else                    → new draft version
// --force-new-version turns would-be typo fixes into new versions.
// Questions with errors are skipped (result "partial"); file-level errors fail the import.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';
import type postgres from 'postgres';
import { assertCmsOwner, connect } from './lib/db.ts';
import { checkFile, normaliseStem, resolveTopicId, type Catalog } from '../shared/checks.ts';
import { derive } from '../shared/derive.ts';
import { schemaProblems } from './lib/chapter/schema.ts';
import type { Answer, ChapterFile, Problem, Question } from '../shared/types.ts';
import { classify, structureHash, textsOf, type Texts } from '../shared/version.ts';
import type { DerivedConfig } from './lib/v10-config.ts';
import { questionFromDb } from '../shared/fromDb.ts';
import { loadBundle } from './lib/bundle.ts';
import { readOriginality } from './lib/originality-report.ts';

type Sql = ReturnType<typeof connect>;
type Tx = postgres.TransactionSql;

export interface Outcome { key: string; question_id?: string; result: 'created' | 'new_version' | 'typo_fix' | 'draft_replaced' | 'unchanged' | 'blocked'; version?: number; note?: string }
export interface ChapterReport {
  file: string; mode: 'validate' | 'import'; importId: number | null; result: 'ok' | 'partial' | 'failed';
  problems: Problem[]; outcomes: Outcome[]; counts: Record<string, number>;
}

const ID_PREFIX = { math: 'MQ', science: 'SQ', grammar: 'GQ' } as const;
const SEQ = { math: 'cms_mq_seq', science: 'cms_sq_seq', grammar: 'cms_gq_seq' } as const;

// ---------------------------------------------------------------- catalog
export async function loadCatalog(tx: Tx, file: ChapterFile): Promise<Catalog> {
  const [ruleVersions, chapter, topics, sets, patterns, concepts, miscs, insights, stems, keys, sourceItems] = await Promise.all([
    tx`select rule_version from cms.cms_rule_versions`,
    tx`select chapter_id, subject from cms.cms_chapters where chapter_id = ${file.chapter_id}`,
    tx`select topic_id, chapter_id, class, topic_kind, taught_in_school, status from cms.cms_topics`,
    tx`select typical_set_id, class, status from cms.cms_typical_sets`,
    tx`select pattern_id from cms.cms_patterns`,
    tx`select concept_id, class from cms.cms_concepts`,
    tx`select misconception_id from cms.cms_misconceptions`,
    tx`select insight_id, status from cms.cms_insights`,
    tx`select q.question_id, q.file_key, v.text from cms.cms_questions q
       join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
       where q.bank = 'production' and q.retired_at is null`,
    tx`select file_key, question_id from cms.cms_questions where file_key is not null`,
    tx`select ref_id from cms.cms_source_items`,
  ]);
  return {
    ruleVersions: new Set(ruleVersions.map((r) => r.rule_version)),
    chapter: (chapter[0] as Catalog['chapter']) ?? null,
    topics: new Map(topics.map((t) => [t.topic_id, t as never])),
    typicalSets: new Map(sets.map((s) => [s.typical_set_id, { class: s.class, status: s.status }])),
    patterns: new Set(patterns.map((p) => p.pattern_id)),
    concepts: new Map(concepts.map((c) => [c.concept_id, { class: c.class }])),
    misconceptions: new Set(miscs.map((m) => m.misconception_id)),
    insights: new Map(insights.map((i) => [i.insight_id, { status: i.status }])),
    stems: new Map(stems.map((s) => [normaliseStem(s.text), s.file_key ?? s.question_id])),
    keyToQuestionId: new Map(keys.map((k) => [k.file_key, k.question_id])),
    sourceItems: new Set(sourceItems.map((s) => s.ref_id)),
  };
}

export async function loadConfig(tx: Tx): Promise<DerivedConfig> {
  const rows = await tx`select key, value from cms.cms_config where key in ('multistep_bands', 'difficulty_points', 'load_thresholds')`;
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (!cfg.multistep_bands || !cfg.difficulty_points) throw new Error('derived-field config is missing from cms_config; run `npm run import:seed` first');
  return cfg as DerivedConfig;
}

// ---------------------------------------------------------------- previous version as texts
/** The stored version's free texts, rebuilt through the shared path (shared/fromDb.ts). */
export async function textsFromDb(tx: Tx, versionId: number): Promise<Texts> {
  return textsOf(questionFromDb(await loadBundle(tx, versionId)));
}

// ---------------------------------------------------------------- writing a version
export function versionColumns(q: Question, topicId: string, d: ReturnType<typeof derive>, hash: string, importId: number) {
  const s = q.signature;
  return {
    topic_id: topicId, typical_set_id: q.typical_set_id, pattern_id: q.pattern_id ?? null,
    text: q.text,
    figure_description: q.figure?.description ?? null,
    image_status: q.figure?.image_status ?? null,
    image_path: q.figure?.image_file ?? null,
    format: q.answer.format,
    correct: q.answer.format === 'Multi-part' ? null : q.answer.correct,
    accepted: q.answer.accepted ?? [],
    duration_s: q.duration_s,
    math_difficulty: s.math_difficulty, is_pure_fact: s.is_pure_fact, reading: s.reading,
    has_irrelevant_info: s.has_irrelevant_info, steps: s.steps, working_memory: s.working_memory,
    inhibition: s.inhibition, visual: s.visual, strategy: s.strategy,
    strategy_type: s.strategy_type ?? null, strategy_type_2: s.strategy_type_2 ?? null,
    strategy_other_note: s.strategy_other_note ?? null, insight_id: s.insight_id ?? null,
    proposed_insight: s.proposed_insight ?? null, trick_ref: s.trick_ref ?? null,
    ...d,
    tagging_why: q.tagging?.why ?? null, tagged_by: q.tagging?.tagged_by ?? null,
    tagging_summary: q.tagging?.summary ?? null, author_notes: q.author_notes ?? null,
    content_hash: hash, created_from: 'import', import_id: importId,
  };
}
const JSON_COLS = ['proposed_insight', 'tagging_why'];

export async function writeChildren(tx: Tx, versionId: number, q: Question) {
  const answers: [string, Answer][] = [['', q.answer], ...(q.parts ?? []).map((p) => [p.part_label, p.answer] as [string, Answer])];
  for (const p of q.parts ?? []) {
    await tx`insert into cms.cms_version_parts ${tx({ version_id: versionId, part_label: p.part_label, text: p.text, format: p.answer.format, correct: p.answer.correct, accepted: p.answer.accepted ?? [] })}`;
  }
  for (const [label, a] of answers) {
    const opts = a.options ?? [];
    if (opts.length) {
      await tx`insert into cms.cms_version_options ${tx(opts.map((text, i) => ({ version_id: versionId, part_label: label, position: i + 1, text, is_correct: text === a.correct })))}`;
    }
    for (const w of a.wrong_answers ?? []) {
      const pos = opts.indexOf(w.value);
      await tx`insert into cms.cms_version_wrong_answers ${tx({
        version_id: versionId, part_label: label, value: w.value, option_position: pos >= 0 ? pos + 1 : null, tag: w.tag,
        misconception_id: w.misconception_id ?? null, target_concept_id: w.target_concept_id ?? null, why: w.why ?? null,
      })}`;
    }
  }
  const concepts = [...q.concepts.map((c) => ({ ...c, part_label: '' })), ...(q.parts ?? []).flatMap((p) => p.concepts.map((c) => ({ ...c, part_label: p.part_label })))];
  await tx`insert into cms.cms_version_concepts ${tx(concepts.map((c) => ({ version_id: versionId, part_label: c.part_label, concept_id: c.concept_id, involvement: c.involvement })))}`;
  const sols = [{ version_id: versionId, slot: 1, text: q.solutions.school, type: null, strategy: null }];
  if (q.solutions.second) sols.push({ version_id: versionId, slot: 2, text: q.solutions.second.text, type: q.solutions.second.type as never, strategy: (q.solutions.second.strategy ?? null) as never });
  await tx`insert into cms.cms_version_solutions ${tx(sols)}`;
  await tx`insert into cms.cms_version_hints ${tx(q.hints.map((text, i) => ({ version_id: versionId, level: i + 1, text })))}`;
  if (q.source_refs?.length) await tx`insert into cms.cms_version_source_refs ${tx(q.source_refs.map((r) => ({ version_id: versionId, ...r })))}`;
}

async function deleteChildren(tx: Tx, versionId: number) {
  for (const t of ['cms_version_parts', 'cms_version_options', 'cms_version_wrong_answers', 'cms_version_concepts', 'cms_version_solutions', 'cms_version_hints', 'cms_version_source_refs']) {
    await tx`delete from ${tx(`cms.${t}`)} where version_id = ${versionId}`;
  }
}

export const enc = (tx: Tx, row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, JSON_COLS.includes(k) && v !== null ? tx.json(v as never) : v]));

// ---------------------------------------------------------------- typo fix in place
export async function applyTypo(tx: Tx, versionId: number, questionId: string, q: Question) {
  await tx`update cms.cms_question_versions set ${tx(enc(tx, {
    text: q.text, figure_description: q.figure?.description ?? null, tagging_why: q.tagging?.why ?? null,
    tagging_summary: q.tagging?.summary ?? null, author_notes: q.author_notes ?? null,
  }) as never)}, edited_at = now() where version_id = ${versionId}`;
  await tx`update cms.cms_version_solutions set text = ${q.solutions.school} where version_id = ${versionId} and slot = 1`;
  if (q.solutions.second) await tx`update cms.cms_version_solutions set text = ${q.solutions.second.text} where version_id = ${versionId} and slot = 2`;
  for (const [i, h] of q.hints.entries()) await tx`update cms.cms_version_hints set text = ${h} where version_id = ${versionId} and level = ${i + 1}`;
  const answers: [string, Answer][] = [['', q.answer], ...(q.parts ?? []).map((p) => [p.part_label, p.answer] as [string, Answer])];
  for (const [label, a] of answers) for (const w of a.wrong_answers ?? []) {
    await tx`update cms.cms_version_wrong_answers set why = ${w.why ?? null} where version_id = ${versionId} and part_label = ${label} and value = ${w.value}`;
  }
  for (const p of q.parts ?? []) await tx`update cms.cms_version_parts set text = ${p.text} where version_id = ${versionId} and part_label = ${p.part_label}`;
  await tx`update cms.cms_questions set placement_note = ${q.placement_note ?? null} where question_id = ${questionId}`;
}

// ---------------------------------------------------------------- main
class Rollback extends Error {}

export async function runChapter(sql: Sql, filePath: string, mode: 'validate' | 'import', forceNew = false): Promise<ChapterReport> {
  const abs = resolve(filePath);
  const raw = readFileSync(abs);
  const fileHash = createHash('sha256').update(raw).digest('hex');
  const rel = relative(process.cwd(), abs);
  // inside the repo: repo-relative; elsewhere: absolute, with ~ for the home folder
  const shown = rel.startsWith('..') ? abs.replace(homedir(), '~') : rel;
  const report: ChapterReport = { file: shown, mode, importId: null, result: 'failed', problems: [], outcomes: [], counts: {} };
  // the local originality check's report (citations and scores only), if it was run
  const orig = readOriginality(abs, fileHash);

  let data: unknown;
  try { data = JSON.parse(raw.toString('utf8')); } catch (e) {
    report.problems.push({ level: 'error', key: 'file', message: `not valid JSON: ${(e as Error).message}` });
    return report;
  }

  // Schema: file-level errors stop everything; question-level errors block that question only.
  const sp = schemaProblems(data);
  report.problems.push(...sp);
  if (sp.some((p) => p.key === 'file') || !Array.isArray((data as ChapterFile).questions)) return report;
  const schemaBlocked = new Set(sp.map((p) => p.key));
  const file = data as ChapterFile;
  const valid: ChapterFile = { ...file, questions: file.questions.filter((q) => !schemaBlocked.has(q.key)) };

  let gitCommit: string | null = null;
  try {
    const h = execFileSync('git', ['log', '-1', '--format=%h', '--', abs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', abs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    gitCommit = (h || 'uncommitted') + (dirty && h ? '+modified' : '');
  } catch { /* outside a repo */ }

  try {
    await sql.begin(async (tx) => {
      const [imp] = await tx`
        insert into cms.cms_imports (kind, file_path, git_commit, file_hash, chapter_id, options)
        values ('chapter', ${shown}, ${gitCommit}, ${fileHash},
                ${(await tx`select 1 from cms.cms_chapters where chapter_id = ${file.chapter_id}`).length ? file.chapter_id : null},
                ${tx.json({ mode, force_new_version: forceNew })})
        returning import_id`;
      const importId = Number(imp!.import_id);
      report.importId = importId;

      const cat = await loadCatalog(tx, valid);
      const problems = [...checkFile(valid, cat), ...orig.problems];
      report.problems.push(...problems);
      const fileErrors = problems.filter((p) => p.level === 'error' && (p.key === 'file' || p.key.startsWith('pattern ')));
      const blocked = new Set([...schemaBlocked, ...problems.filter((p) => p.level === 'error').map((p) => p.key)]);

      if (!fileErrors.length) {
        const cfg = await loadConfig(tx);

        // patterns from the file: new → insert; changed → update + audit
        for (const p of file.patterns ?? []) {
          const row = { pattern_id: p.pattern_id, topic_id: p.topic_id, typical_set_id: p.typical_set_id, name: p.name, template: p.template ?? null,
            variables: p.variables ?? {}, target_misconceptions: p.target_misconceptions ?? [], source_refs: p.source_refs ?? [], notes: p.notes ?? null };
          const [before] = await tx`select * from cms.cms_patterns where pattern_id = ${p.pattern_id}`;
          const encoded = { ...row, variables: tx.json(row.variables as never) };
          if (!before) { await tx`insert into cms.cms_patterns ${tx(encoded as never)}`; continue; }
          const changed = Object.keys(row).filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify((row as Record<string, unknown>)[k]));
          if (changed.length) {
            await tx`update cms.cms_patterns set ${tx(encoded as never)}, updated_at = now() where pattern_id = ${p.pattern_id}`;
            await tx`insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, import_id)
                     values ('catalogue', 'cms_patterns', ${p.pattern_id}, 'edit_catalogue',
                             ${tx.json(Object.fromEntries(changed.map((k) => [k, { before: before[k], after: (row as Record<string, unknown>)[k] }])) as never)},
                             'chapter importer', ${importId})`;
          }
        }

        for (const q of file.questions) {
          if (blocked.has(q.key)) { report.outcomes.push({ key: q.key, result: 'blocked' }); continue; }
          const topicId = resolveTopicId(q, file);
          const hash = structureHash(q, topicId);
          const d = derive(q, q.class_override ?? file.class, (id) => cat.concepts.get(id)?.class, cfg);
          const cols = versionColumns(q, topicId, d, hash, importId);
          const qFields = {
            topic_id: topicId, class: file.class, class_override: q.class_override ?? null, placement_note: q.placement_note ?? null,
            typical_set_id: q.typical_set_id, pattern_id: q.pattern_id ?? null, clone_batch_id: q.clone_batch_id, locale: q.locale,
          };

          const [existing] = await tx`select * from cms.cms_questions where file_key = ${q.key}`;
          if (!existing) {
            const [{ n }] = await tx`select nextval(${`cms.${SEQ[file.subject]}`}) as n` as unknown as [{ n: string }];
            const qid = `${ID_PREFIX[file.subject]}${String(n).padStart(6, '0')}`;
            await tx`insert into cms.cms_questions ${tx({ question_id: qid, bank: 'production', subject: file.subject, file_key: q.key, chapter_id: file.chapter_id, current_version: 1, ...qFields })}`;
            const [v] = await tx`insert into cms.cms_question_versions ${tx({ question_id: qid, version_no: 1, status: 'draft', ...enc(tx, cols) } as never)} returning version_id`;
            await writeChildren(tx, Number(v!.version_id), q);
            report.outcomes.push({ key: q.key, question_id: qid, result: 'created', version: 1 });
            continue;
          }

          const qid = existing.question_id as string;
          if (existing.retired_at) { blockWith(q.key, qid, `question ${qid} is retired; restore it before importing changes`); continue; }
          const [cur] = await tx`select version_id, version_no, status, content_hash, created_from, edited_at from cms.cms_question_versions
                                 where question_id = ${qid} and version_no = ${existing.current_version}`;
          const prevTexts = await textsFromDb(tx, Number(cur!.version_id));
          const change = classify({ structureHash: cur!.content_hash, texts: prevTexts }, { structureHash: hash, texts: textsOf(q) }, forceNew);

          if (change.kind === 'unchanged') { report.outcomes.push({ key: q.key, question_id: qid, result: 'unchanged', version: cur!.version_no }); continue; }

          if (cur!.status === 'in_review') { blockWith(q.key, qid, `v${cur!.version_no} is in review; approve or reject it before re-importing`); continue; }
          if (cur!.status === 'draft') {
            if (cur!.created_from !== 'import' || cur!.edited_at) {
              blockWith(q.key, qid, `v${cur!.version_no} is an open draft that was ${cur!.created_from !== 'import' ? `created by ${cur!.created_from}` : 'edited after import'}; it is never overwritten`);
              continue;
            }
            await deleteChildren(tx, Number(cur!.version_id));
            await tx`update cms.cms_question_versions set ${tx(enc(tx, cols) as never)}, created_at = now() where version_id = ${cur!.version_id}`;
            await writeChildren(tx, Number(cur!.version_id), q);
            await tx`update cms.cms_questions set ${tx(qFields as never)} where question_id = ${qid}`;
            await tx`insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, import_id, reason)
                     values ('question_version', 'cms_question_versions', ${`${qid} v${cur!.version_no}`}, 'import_replace_draft',
                             ${tx.json({ change: change.kind === 'new' ? change.reason : 'wording only', texts: change.kind === 'typo' ? change.diff : undefined } as never)},
                             'chapter importer', ${importId}, 'open draft created by an import, not edited since')`;
            report.outcomes.push({ key: q.key, question_id: qid, result: 'draft_replaced', version: cur!.version_no });
            continue;
          }

          if (change.kind === 'typo' && cur!.status === 'approved') {
            await applyTypo(tx, Number(cur!.version_id), qid, q);
            await tx`insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, import_id, reason)
                     values ('question_version', 'cms_question_versions', ${`${qid} v${cur!.version_no}`}, 'typo_fix',
                             ${tx.json(change.diff as never)}, 'chapter importer', ${importId}, 'wording only; numbers and structure unchanged')`;
            report.outcomes.push({ key: q.key, question_id: qid, result: 'typo_fix', version: cur!.version_no });
            continue;
          }

          const next = Number(existing.current_version) + 1;
          const [v] = await tx`insert into cms.cms_question_versions ${tx({ question_id: qid, version_no: next, status: 'draft', ...enc(tx, cols) } as never)} returning version_id`;
          await writeChildren(tx, Number(v!.version_id), q);
          await tx`update cms.cms_questions set ${tx({ ...qFields, current_version: next } as never)} where question_id = ${qid}`;
          report.outcomes.push({ key: q.key, question_id: qid, result: 'new_version', version: next,
            note: change.kind === 'new' ? change.reason : `previous v${cur!.version_no} is ${cur!.status}, so wording changes need a new version` });
        }
      } else {
        for (const q of file.questions) report.outcomes.push({ key: q.key, result: 'blocked' });
      }

      function blockWith(key: string, qid: string, message: string) {
        report.problems.push({ level: 'error', key, message });
        report.outcomes.push({ key, question_id: qid, result: 'blocked' });
      }

      // record the local originality check for every version this import wrote
      if (orig.report) {
        for (const o of report.outcomes) {
          const r = orig.report.questions.find((x) => x.key === o.key);
          if (!r || !o.question_id || !o.version || o.result === 'unchanged' || o.result === 'blocked') continue;
          const [v] = await tx`select version_id from cms.cms_question_versions where question_id = ${o.question_id} and version_no = ${o.version}`;
          await tx`insert into cms.cms_originality_checks ${tx({
            version_id: v!.version_id, checked_at: orig.report.checked_at, result: r.result, similarity: r.similarity, same_numbers: r.same_numbers,
            closest_ref: r.closest_ref, checked: tx.json(orig.report.checked as never), missing: tx.json(orig.report.missing as never),
            threshold: orig.report.threshold, near_copy_threshold: orig.report.near_copy_threshold, tool: orig.report.tool, import_id: importId,
          } as never)}`;
        }
      }

      // D7 (12 Nov 2026): the import registers the books its questions cite. Every source with a
      // citation used by an imported question is linked to this chapter (citations only).
      const cited = [...new Set(file.questions.filter((q) => report.outcomes.some((o) => o.key === q.key && o.result !== 'blocked'))
        .flatMap((q) => (q.source_refs ?? []).map((r) => r.ref_id)))];
      if (cited.length) {
        const srcs = await tx`select distinct source_id from cms.cms_source_items where ref_id in ${tx(cited)}`;
        let linked = 0;
        for (const s of srcs) {
          const r = await tx`insert into cms.cms_source_chapters (source_id, chapter_id) values (${s.source_id}, ${file.chapter_id}) on conflict do nothing returning source_id`;
          if (r.length) {
            linked++;
            await tx`insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label, import_id)
              values ('catalogue', 'cms_source_chapters', ${`${s.source_id} · ${file.chapter_id}`}, 'edit_catalogue', 'cited by imported questions (D7)',
                      ${tx.json({ chapter_id: { before: null, after: file.chapter_id } } as never)}, 'importer', ${importId})`;
          }
        }
        if (linked) report.counts.sources_linked = linked;
      }

      for (const o of report.outcomes) report.counts[o.result] = (report.counts[o.result] ?? 0) + 1;
      const done = report.outcomes.filter((o) => o.result !== 'blocked').length;
      report.result = fileErrors.length || done === 0 ? 'failed' : report.counts.blocked ? 'partial' : 'ok';
      await tx`update cms.cms_imports set finished_at = now(), result = ${report.result}, counts = ${tx.json(report.counts)},
               error_report = ${tx.json({ problems: report.problems, outcomes: report.outcomes } as never)} where import_id = ${importId}`;
      if (mode === 'validate') throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    report.importId = null;
  }
  return report;
}

// ---------------------------------------------------------------- CLI
export function printReport(r: ChapterReport) {
  const label: Record<Outcome['result'], string> = {
    created: 'new question', new_version: 'new version', typo_fix: 'typo fix (same version)',
    draft_replaced: 'draft replaced', unchanged: 'unchanged, skipped', blocked: 'BLOCKED',
  };
  console.log(`\n${r.mode === 'validate' ? 'Validate (DRY RUN — nothing saved)' : `Import #${r.importId}`}: ${r.file} → ${r.result.toUpperCase()}`);
  if (Object.keys(r.counts).length) console.log('  ' + Object.entries(r.counts).map(([k, n]) => `${label[k as Outcome['result']]} ${n}`).join(' · '));
  const byKey = new Map<string, Problem[]>();
  for (const p of r.problems) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p]);
  for (const p of byKey.get('file') ?? []) console.log(`  ✗ file: ${p.message}`);
  for (const o of r.outcomes) {
    const v = o.version ? ` v${o.version}` : '';
    console.log(`  ${o.result === 'blocked' ? '✗' : '✓'} ${o.key}${o.question_id ? ` (${o.question_id}${v})` : ''}: ${label[o.result]}${o.note ? ` — ${o.note}` : ''}`);
    for (const p of byKey.get(o.key) ?? []) console.log(`      ${p.level === 'error' ? 'error  ' : 'warning'} ${p.message}`);
  }
  for (const [k, ps] of byKey) if (k !== 'file' && !r.outcomes.some((o) => o.key === k)) for (const p of ps) console.log(`  ${p.level === 'error' ? '✗' : '!'} ${k}: ${p.message}`);
}

if (import.meta.filename === process.argv[1]) {
  const [mode, path, ...rest] = process.argv.slice(2);
  if ((mode !== 'validate' && mode !== 'import') || !path) {
    console.error('usage: npm run chapter -- validate|import <file.json> [--force-new-version]');
    process.exit(1);
  }
  const sql = connect();
  try {
    await assertCmsOwner(sql);
    const r = await runChapter(sql, path, mode, rest.includes('--force-new-version'));
    printReport(r);
    process.exitCode = r.result === 'failed' ? 1 : 0;
  } finally {
    await sql.end();
  }
}

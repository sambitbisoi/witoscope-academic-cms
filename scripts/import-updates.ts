// npm run import:updates -- [folder] [--dry-run] [--only question_levels.csv,…]
//
// Imports the Math data thread's CMS-updates (docs/queue-2026-11-12.md, "File contracts") into
// the LOCAL database. Default folder: ~/WitoScope/ContentResearch/CMS-updates. Whatever files
// are there are applied, in this order:
//   settings_catalogue.csv   → cms_settings (new rows with their status; an existing setting keeps
//                              the status it has in the CMS)
//   topic_classes.csv        → cms_topic_classes (D2)
//   question_levels.csv      → cms_questions.level (D1), by file_key
//   question_settings.csv    → cms_questions.setting_id / confidence / note (D8a), by file_key
//   key_fixes.csv            → each question is re-imported from its pipeline file under the new key
//   near_copy_rewrites/*.json→ originality check on this Mac, then the chapter importer (same keys:
//                              the blocked drafts come in as new questions, existing ones as new versions)
// Each file is one cms_imports row (kind 'updates'); every changed question gets an audit row
// (action 'import_update', before → after). Nothing is deleted. --dry-run rolls everything back.
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { checkChapterFile, checkStoredVersion, reportPathFor } from './check-originality.ts';
import { ORIGINALITY_TOOL } from '../shared/originality.ts';
import { runChapter, type ChapterReport } from './import-chapter.ts';
import { assertCmsOwner, connect, freshConnections, targetUrl, type UnitRunner } from './lib/db.ts';
import { hasPdftotext } from './lib/local-books.ts';
import { FolderBucket } from './lib/r2-local.ts';
import { upsertCatalogue } from './lib/upsert.ts';
import {
  convertPipelineFile, parseKeyFixes, parseOverrides, parseLevels, parseQuestionSettings, parseSettings, parseTopicClasses, type Problem,
  overrideAllowList,
} from './lib/updates.ts';
import { PIPELINE_ROOT } from './lib/local-import.ts';
import { STAGE_DIR } from './stage-pipeline.ts';

type Sql = ReturnType<typeof connect>;
type Tx = postgres.TransactionSql;
/** the folder being imported (runUpdates sets it); its override_requests.csv lets listed near-copies in as drafts */
let currentDir = '';
export const UPDATES_DIR = resolve(process.env.CMS_UPDATES_DIR ?? join(homedir(), 'WitoScope', 'ContentResearch', 'CMS-updates'));
// Order (data thread README, 12 Nov 2026): key fixes and rewrites come before levels and settings, which already use the new keys.
const CSV_ORDER = ['settings_catalogue.csv', 'topic_classes.csv', 'question_levels.csv', 'question_settings.csv', 'key_fixes.csv'] as const;
const BEFORE_REWRITES = ['settings_catalogue.csv', 'topic_classes.csv'];
class DryRun extends Error {}

export interface FileResult { file: string; importId: number | null; result: 'ok' | 'partial' | 'failed'; counts: Record<string, unknown>; problems: Problem[] }

const short = (p: string) => p.replace(homedir(), '~');

async function begin(tx: Tx, file: string, raw: Buffer | string, dryRun: boolean) {
  const [imp] = await tx`insert into cms.cms_imports (kind, file_path, file_hash, options)
    values ('updates', ${short(file)}, ${createHash('sha256').update(raw).digest('hex')}, ${tx.json({ dry_run: dryRun })}) returning import_id`;
  return Number(imp!.import_id);
}
async function finish(tx: Tx, importId: number, counts: Record<string, unknown>, problems: Problem[]) {
  const result = problems.some((p) => p.level === 'error') ? (Object.values(counts).some((c) => typeof c === 'number' && c > 0) ? 'partial' : 'failed') : 'ok';
  await tx`update cms.cms_imports set finished_at = now(), result = ${result}, counts = ${tx.json(counts as never)}, error_report = ${tx.json(problems as never)} where import_id = ${importId}`;
  return result as FileResult['result'];
}

/** Update question fields by file_key, one audit row per changed question. */
async function updateQuestions(tx: Tx, importId: number, rows: { file_key: string; set: Record<string, unknown> }[], reason: string, problems: Problem[], where: string) {
  const keys = rows.map((r) => r.file_key);
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r.set)))];
  const existing = new Map((keys.length ? await tx`select question_id, file_key, ${tx(cols)} from cms.cms_questions where file_key in ${tx(keys)}` : []).map((r) => [r.file_key as string, r]));
  const counts = { updated: 0, unchanged: 0, not_in_cms: 0 };
  const changes: { question_id: string; set: Record<string, unknown>; diff: Record<string, unknown> }[] = [];
  for (const r of rows) {
    const q = existing.get(r.file_key);
    if (!q) { counts.not_in_cms++; problems.push({ level: 'warning', where, message: `${r.file_key} is not in the CMS (not imported yet, or blocked); skipped` }); continue; }
    const diff = Object.fromEntries(Object.entries(r.set).filter(([k, v]) => (q[k] ?? null) !== (v ?? null)).map(([k, v]) => [k, { before: q[k] ?? null, after: v ?? null }]));
    if (!Object.keys(diff).length) { counts.unchanged++; continue; }
    changes.push({ question_id: q.question_id as string, set: r.set, diff });
  }
  // Set-based (go-live, 13 Nov 2026): per batch of 500, one UPDATE per changed column and one audit INSERT,
  // instead of two round trips per question. Same values and the same audit rows (before → after) as before.
  const INT_COLS = new Set(['level']);
  for (let i = 0; i < changes.length; i += 500) {
    const batch = changes.slice(i, i + 500);
    for (const k of cols) {
      const set = batch.filter((c) => k in c.diff).map((c) => ({ id: c.question_id, v: c.set[k] ?? null }));
      if (!set.length) continue;
      if (INT_COLS.has(k)) await tx`update cms.cms_questions q set ${tx(k)} = x.v from jsonb_to_recordset(${tx.json(set as never)}) as x(id text, v int) where q.question_id = x.id`;
      else await tx`update cms.cms_questions q set ${tx(k)} = x.v from jsonb_to_recordset(${tx.json(set as never)}) as x(id text, v text) where q.question_id = x.id`;
    }
    await tx`insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label, import_id)
      select 'question_version', 'cms_questions', x.id, 'import_update', ${reason}, x.diff, 'updates importer', ${importId}
      from jsonb_to_recordset(${tx.json(batch.map((c) => ({ id: c.question_id, diff: c.diff })) as never)}) as x(id text, diff jsonb)`;
    counts.updated += batch.length;
  }
  return counts;
}

async function csvFile(sql: Sql, dir: string, name: typeof CSV_ORDER[number], dryRun: boolean): Promise<FileResult> {
  const path = join(dir, name);
  const raw = readFileSync(path);
  const text = raw.toString('utf8');
  let out: FileResult = { file: path, importId: null, result: 'failed', counts: {}, problems: [] };
  try {
    await sql.begin(async (tx) => {
      await tx`set local statement_timeout = '10min'`; // the pooler's default is 2 min
      const importId = await begin(tx, path, raw, dryRun);
      const problems: Problem[] = []; const counts: Record<string, unknown> = {};
      const reason = `CMS-updates ${name}`;
      if (name === 'settings_catalogue.csv') {
        const p = parseSettings(text); problems.push(...p.problems);
        const have = new Set((await tx`select setting_id from cms.cms_settings`).map((r) => r.setting_id as string));
        // a setting already in the CMS keeps its status (Sambit may have approved it)
        const rows = p.rows.map((r) => (have.has(r.setting_id) ? { setting_id: r.setting_id, name: r.name, description: r.description, theme: r.theme } : { ...r, import_id: importId }));
        const u = await upsertCatalogue(tx, 'cms_settings', ['setting_id'], rows as never[], { byLabel: 'updates importer', importId, reason });
        counts.cms_settings = u.counts; problems.push(...u.notes);
      } else if (name === 'topic_classes.csv') {
        const p = parseTopicClasses(text); problems.push(...p.problems);
        const topics = new Map((await tx`select topic_id, class from cms.cms_topics`).map((r) => [r.topic_id as string, r.class as number]));
        const rows = p.rows.filter((r) => topics.has(r.topic_id) || (problems.push({ level: 'warning', where: name, message: `${r.topic_id} class ${r.class} skipped: ${r.topic_id} is not in the CMS yet (it comes with the next import:topics)` }), false));
        const homeOnly = rows.filter((r) => topics.get(r.topic_id) === r.class).length;
        const u = await upsertCatalogue(tx, 'cms_topic_classes', ['topic_id', 'class'], rows as never[], { byLabel: 'updates importer', importId, reason });
        counts.cms_topic_classes = { ...u.counts, home_class_rows: homeOnly, topics: new Set(rows.map((r) => r.topic_id)).size,
          multi_class_topics: [...new Set(rows.map((r) => r.topic_id))].filter((t) => new Set([topics.get(t), ...rows.filter((r) => r.topic_id === t).map((r) => r.class)]).size > 1).length };
        problems.push(...u.notes.slice(0, 20));
        if (u.notes.length > 20) problems.push({ level: 'warning', where: name, message: `… and ${u.notes.length - 20} more rows in the CMS but not in the file (kept)` });
      } else if (name === 'question_levels.csv') {
        const p = parseLevels(text); problems.push(...p.problems);
        counts.questions = await updateQuestions(tx, importId, p.rows.map((r) => ({ file_key: r.file_key, set: { level: r.level } })), reason, problems, name);
        counts.by_level = Object.fromEntries([1, 2, 3, 4, 5, 6].map((l) => [l, p.rows.filter((r) => r.level === l).length]).filter(([, n]) => n));
      } else if (name === 'question_settings.csv') {
        const p = parseQuestionSettings(text); problems.push(...p.problems);
        const settings = new Set((await tx`select setting_id from cms.cms_settings`).map((r) => r.setting_id as string));
        const rows = p.rows.filter((r) => settings.has(r.setting_id) || (problems.push({ level: 'error', where: name, message: `${r.file_key}: setting ${r.setting_id} is not in the settings catalogue` }), false));
        counts.questions = await updateQuestions(tx, importId, rows.map((r) => ({ file_key: r.file_key, set: { setting_id: r.setting_id, setting_confidence: r.confidence, setting_note: r.note } })), reason, problems, name);
        counts.by_confidence = Object.fromEntries(['high', 'medium', 'low'].map((c) => [c, rows.filter((r) => r.confidence === c).length]));
      } else {
        const p = parseKeyFixes(text); problems.push(...p.problems);
        counts.key_fixes = { listed: p.rows.length };
      }
      out = { file: path, importId, result: await finish(tx, importId, counts, problems), counts, problems };
      if (dryRun) throw new DryRun();
    });
  } catch (e) { if (!(e instanceof DryRun)) throw e; }
  return out;
}

/** Stage one chapter-file JSON (pipeline format) for the chapter importer: convert, store figures (local only). */
function stageJson(src: string, data: Record<string, unknown>, imagesDirs: string[], dryRun: boolean, label: string) {
  const bucket = new FolderBucket();
  const find = (name: string) => imagesDirs.map((d) => join(d, name)).find((p) => existsSync(p));
  const conv = convertPipelineFile(data as never, (name) => !!bucket.has(`figures/${name}`) || !!find(name));
  const toStore = dryRun ? [] : conv.images.filter((n) => find(n));
  const dir = join(STAGE_DIR, '_updates', label);
  mkdirSync(dir, { recursive: true });
  const staged = join(dir, basename(src));
  writeFileSync(staged, JSON.stringify(conv.file, null, 2) + '\n');
  return { staged, notes: conv.notes, store: async () => { for (const n of toStore) await bucket.put(`figures/${n}`, new Uint8Array(readFileSync(find(n)!)), { httpMetadata: { contentType: 'image/png' } }); return toStore.length; } };
}

async function checkAndImport(sql: Sql, staged: string, dryRun: boolean): Promise<{ report: ChapterReport; originality: Record<string, number> }> {
  const rep = await checkChapterFile(sql, staged);
  writeFileSync(reportPathFor(staged), JSON.stringify(rep, null, 2) + '\n');
  const originality: Record<string, number> = {};
  for (const q of rep.questions) originality[q.result] = (originality[q.result] ?? 0) + 1;
  // 13 Nov 2026: a near-copy with an override request for that question + field comes in as a draft (blocked from approval)
  const orq = join(currentDir, 'override_requests.csv');
  return { report: await runChapter(sql, staged, dryRun ? 'validate' : 'import', false, { overrideRequests: existsSync(orq) ? overrideAllowList(orq) : undefined }), originality };
}

async function rewrites(run: UnitRunner, dir: string, dryRun: boolean): Promise<FileResult[]> {
  const rdir = join(dir, 'near_copy_rewrites');
  const out: FileResult[] = [];
  for (const name of readdirSync(rdir).filter((n) => /^(MC|SC|GC)\d{2}-C\d\.json$/.test(n)).sort()) out.push(await run(`near_copy_rewrites/${name}`, (sql) => rewriteOne(sql, rdir, name, dryRun)));
  return out;
}
async function rewriteOne(sql: Sql, rdir: string, name: string, dryRun: boolean): Promise<FileResult> {
  {
    const src = join(rdir, name);
    const s = stageJson(src, JSON.parse(readFileSync(src, 'utf8')), [join(rdir, 'images')], dryRun, 'near_copy_rewrites');
    const { report, originality } = await checkAndImport(sql, s.staged, dryRun);
    const stored = await s.store();
    return { file: src, importId: report.importId, result: report.result, counts: { ...report.counts, originality, figures_stored: stored },
      problems: [...s.notes.map((m) => ({ level: 'warning' as const, where: name, message: m })), ...report.problems.map((p) => ({ level: p.level, where: p.key, message: p.message }))] };
  }
}

async function keyFixes(sql: Sql, dir: string, dryRun: boolean): Promise<FileResult[]> {
  const p = parseKeyFixes(readFileSync(join(dir, 'key_fixes.csv'), 'utf8'));
  const out: FileResult[] = [];
  for (const fx of p.rows) {
    const problems: Problem[] = [];
    const [have] = await sql`select question_id from cms.cms_questions where file_key = ${fx.new_file_key}`;
    if (have) { out.push({ file: `${fx.old_file_key} → ${fx.new_file_key}`, importId: null, result: 'ok', counts: { already_in_cms: have.question_id }, problems }); continue; }
    // source_file may be relative to QuestionBank, to ContentResearch (e.g. QuestionBank/NCERT-C6-07/…) or to the updates folder
    const src = isAbsolute(fx.source_file) ? fx.source_file
      : [join(PIPELINE_ROOT, fx.source_file), join(PIPELINE_ROOT, '..', fx.source_file), join(dir, fx.source_file)].find((x) => existsSync(x)) ?? join(PIPELINE_ROOT, fx.source_file);
    if (!existsSync(src)) { out.push({ file: `${fx.old_file_key} → ${fx.new_file_key}`, importId: null, result: 'failed', counts: {}, problems: [{ level: 'error', where: fx.source_file, message: 'source file not found' }] }); continue; }
    const data = JSON.parse(readFileSync(src, 'utf8')) as { questions: { key: string }[] } & Record<string, unknown>;
    const q = data.questions.find((x) => x.key === fx.old_file_key);
    if (!q) { out.push({ file: `${fx.old_file_key} → ${fx.new_file_key}`, importId: null, result: 'failed', counts: {}, problems: [{ level: 'error', where: fx.source_file, message: `${fx.old_file_key} is not in the file` }] }); continue; }
    const one = { ...data, chapter_id: fx.new_file_key.slice(0, 4), questions: [{ ...q, key: fx.new_file_key }] };
    const s = stageJson(join(dirnameOf(src), `${fx.new_file_key.slice(0, 4)}-C${String(data.class ?? 0)}.json`), one, [join(dirnameOf(src), 'images')], dryRun, `key-fix-${fx.new_file_key}`);
    const { report, originality } = await checkAndImport(sql, s.staged, dryRun);
    await s.store();
    out.push({ file: `${fx.old_file_key} → ${fx.new_file_key} (${basename(src)})`, importId: report.importId, result: report.result, counts: { ...report.counts, originality },
      problems: [...problems, ...s.notes.map((m) => ({ level: 'warning' as const, where: fx.new_file_key, message: m })), ...report.problems.map((x) => ({ level: x.level, where: x.key, message: x.message }))] });
  }
  return out;
}
const dirnameOf = (p: string) => p.slice(0, p.lastIndexOf('/'));

/**
 * override_requests.csv (Sambit, 12 Nov 2026): never applied automatically. For each row the
 * question's current version gets the every-field originality check (recorded), and a PENDING
 * override request is filed for Sambit to approve or decline one by one in the Review tab.
 */
async function overrides(sql: Sql, dir: string, dryRun: boolean): Promise<FileResult> {
  const path = join(dir, 'override_requests.csv');
  const raw = readFileSync(path);
  const p = parseOverrides(raw.toString('utf8'));
  let out: FileResult = { file: path, importId: null, result: 'failed', counts: {}, problems: [] };
  const cache = new Map();
  // the checks read the book PDFs on this Mac; do them before the transaction
  const checked: { row: typeof p.rows[number]; q: { question_id: string; version_id: string; version_no: number; chapter_id: string } | null; c: Awaited<ReturnType<typeof checkStoredVersion>> | null }[] = [];
  for (const row of p.rows) {
    const [q] = await sql`select q.question_id, v.version_id, v.version_no, q.chapter_id from cms.cms_questions q
      join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version where q.file_key = ${row.file_key}`;
    checked.push({ row, q: (q as never) ?? null, c: q ? await checkStoredVersion(sql, Number(q.version_id), q.chapter_id, cache) : null });
  }
  try {
    await sql.begin(async (tx) => {
      const importId = await begin(tx, path, raw, dryRun);
      const problems: Problem[] = [...p.problems];
      const counts = { requested: 0, already_requested: 0, not_needed: 0, not_in_cms: 0, checks_recorded: 0 };
      for (const { row, q, c } of checked) {
        const where = `${row.file_key} ${row.field}`;
        if (!q || !c) { counts.not_in_cms++; problems.push({ level: 'warning', where, message: 'not in the CMS; skipped' }); continue; }
        const r = c.result;
        const [chk] = await tx`insert into cms.cms_originality_checks ${tx({
          version_id: q.version_id, checked_at: new Date().toISOString(), result: r.result, similarity: r.similarity, same_numbers: r.same_numbers,
          closest_ref: r.closest_ref, field: r.field, checked: tx.json(c.checked as never), missing: tx.json(c.missing as never),
          threshold: c.th, near_copy_threshold: c.near, tool: ORIGINALITY_TOOL, import_id: importId } as never)} returning check_id`;
        counts.checks_recorded++;
        const hit = r.fields.find((f) => f.field === row.field || f.field.startsWith(`${row.field} (`));
        if (!hit || hit.result !== 'near_copy') {
          counts.not_needed++;
          problems.push({ level: 'warning', where, message: `the check finds no near-copy in ${row.field} (${hit ? hit.result : 'clear'}); no request filed` });
          continue;
        }
        if (r.result === 'near_copy' && r.field !== hit.field) problems.push({ level: 'warning', where, message: `the question is also a near-copy in ${r.field}; an override of ${row.field} alone will not let it be approved` });
        const [have] = await tx`select request_id, status from cms.cms_override_requests where version_id = ${q.version_id} and field = ${hit.field} order by request_id desc limit 1`;
        if (have) { counts.already_requested++; continue; }
        await tx`insert into cms.cms_override_requests (question_id, version_id, file_key, field, reason, requested_by, check_id, import_id)
          values (${q.question_id}, ${q.version_id}, ${row.file_key}, ${hit.field}, ${row.reason}, 'Math data thread', ${chk!.check_id}, ${importId})`;
        counts.requested++;
      }
      out = { file: path, importId, result: await finish(tx, importId, counts, problems), counts, problems };
      if (dryRun) throw new DryRun();
    });
  } catch (e) { if (!(e instanceof DryRun)) throw e; }
  return out;
}

/** opts.run: a unit runner (e.g. freshConnections()) that gives each file its own connection and retries a dropped one once. */
export async function runUpdates(sql: Sql, dir = UPDATES_DIR, opts: { dryRun?: boolean; only?: string[]; goLive?: boolean; run?: UnitRunner } = {}): Promise<FileResult[]> {
  const run: UnitRunner = opts.run ?? ((_label, fn) => fn(sql));
  currentDir = dir;
  const host = new URL(targetUrl()).hostname;
  // local only, except at go-live (scripts/golive.ts passes --go-live for the real project, with Sambit's OK)
  if (host !== '127.0.0.1' && host !== 'localhost' && !opts.goLive) throw new Error('import:updates runs against the local database only (queue 12 Nov 2026); go-live passes --go-live.');
  const want = (n: string) => !opts.only?.length || opts.only.includes(n);
  const out: FileResult[] = [];
  const has = (n: string) => want(n) && existsSync(join(dir, n));
  if ((has('key_fixes.csv') || has('near_copy_rewrites') || has('override_requests.csv')) && !hasPdftotext()) throw new Error('pdftotext is needed for the originality check (brew install poppler).');
  const dry = !!opts.dryRun;
  for (const name of CSV_ORDER.filter((n) => BEFORE_REWRITES.includes(n))) if (has(name)) out.push(await run(name, (c) => csvFile(c, dir, name, dry)));
  if (has('key_fixes.csv')) { out.push(await run('key_fixes.csv', (c) => csvFile(c, dir, 'key_fixes.csv', dry))); out.push(...await run('key fixes', (c) => keyFixes(c, dir, dry))); }
  if (has('near_copy_rewrites')) out.push(...await rewrites(run, dir, dry));
  // after the rewrites, so the requests attach to each question's latest version
  if (has('override_requests.csv')) out.push(await run('override_requests.csv', (c) => overrides(c, dir, dry)));
  for (const name of CSV_ORDER.filter((n) => !BEFORE_REWRITES.includes(n) && n !== 'key_fixes.csv')) if (has(name)) out.push(await run(name, (c) => csvFile(c, dir, name, dry)));
  return out;
}

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const dir = resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--only') ?? UPDATES_DIR);
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1]!.split(',') : undefined;
  const dryRun = args.includes('--dry-run');
  if (!existsSync(dir)) { console.error(`No folder ${short(dir)} yet.`); process.exit(1); }
  const sql = connect();
  try {
    await assertCmsOwner(sql);
    const perFile = args.includes('--go-live') || args.includes('--fresh-connections');
    if (perFile) await sql.end({ timeout: 5 }); // each file opens its own connection; don't keep this one idle for the whole run
    // --go-live: a fresh connection per file with keep-alive; a dropped connection is retried once, then the run stops
    const results = await runUpdates(sql, dir, { dryRun, only, goLive: args.includes('--go-live'), run: perFile ? freshConnections() : undefined });
    if (!results.length) console.log(`Nothing to import in ${short(dir)}.`);
    for (const r of results) {
      console.log(`\n${short(r.file)}${dryRun ? ' (DRY RUN — nothing saved)' : r.importId ? ` · import #${r.importId}` : ''} → ${r.result.toUpperCase()}`);
      console.log(`  ${JSON.stringify(r.counts)}`);
      const shown = r.problems.slice(0, 40);
      for (const p of shown) console.log(`  ${p.level === 'error' ? '✗' : '!'} ${p.where}: ${p.message}`);
      if (r.problems.length > shown.length) console.log(`  … ${r.problems.length - shown.length} more`);
    }
    process.exitCode = results.some((r) => r.result === 'failed') ? 1 : 0;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

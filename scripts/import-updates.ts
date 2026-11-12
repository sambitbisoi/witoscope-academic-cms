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
import { checkChapterFile, reportPathFor } from './check-originality.ts';
import { runChapter, type ChapterReport } from './import-chapter.ts';
import { assertCmsOwner, connect, targetUrl } from './lib/db.ts';
import { hasPdftotext } from './lib/local-books.ts';
import { FolderBucket } from './lib/r2-local.ts';
import { upsertCatalogue } from './lib/upsert.ts';
import {
  convertPipelineFile, parseKeyFixes, parseLevels, parseQuestionSettings, parseSettings, parseTopicClasses, type Problem,
} from './lib/updates.ts';
import { PIPELINE_ROOT } from './lib/local-import.ts';
import { STAGE_DIR } from './stage-pipeline.ts';

type Sql = ReturnType<typeof connect>;
type Tx = postgres.TransactionSql;
export const UPDATES_DIR = resolve(process.env.CMS_UPDATES_DIR ?? join(homedir(), 'WitoScope', 'ContentResearch', 'CMS-updates'));
const CSV_ORDER = ['settings_catalogue.csv', 'topic_classes.csv', 'question_levels.csv', 'question_settings.csv', 'key_fixes.csv'] as const;
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
  for (const r of rows) {
    const q = existing.get(r.file_key);
    if (!q) { counts.not_in_cms++; problems.push({ level: 'warning', where, message: `${r.file_key} is not in the CMS (not imported yet, or blocked); skipped` }); continue; }
    const diff = Object.fromEntries(Object.entries(r.set).filter(([k, v]) => (q[k] ?? null) !== (v ?? null)).map(([k, v]) => [k, { before: q[k] ?? null, after: v ?? null }]));
    if (!Object.keys(diff).length) { counts.unchanged++; continue; }
    await tx`update cms.cms_questions set ${tx(Object.fromEntries(Object.keys(diff).map((k) => [k, r.set[k] ?? null])) as never)} where question_id = ${q.question_id}`;
    await tx`insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label, import_id)
      values ('question_version', 'cms_questions', ${q.question_id}, 'import_update', ${reason}, ${tx.json(diff as never)}, 'updates importer', ${importId})`;
    counts.updated++;
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
        const rows = p.rows.filter((r) => topics.has(r.topic_id) || (problems.push({ level: 'error', where: name, message: `${r.topic_id} is not in the topic lists` }), false));
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
  return { report: await runChapter(sql, staged, dryRun ? 'validate' : 'import'), originality };
}

async function rewrites(sql: Sql, dir: string, dryRun: boolean): Promise<FileResult[]> {
  const rdir = join(dir, 'near_copy_rewrites');
  const out: FileResult[] = [];
  for (const name of readdirSync(rdir).filter((n) => /^(MC|SC|GC)\d{2}-C\d\.json$/.test(n)).sort()) {
    const src = join(rdir, name);
    const s = stageJson(src, JSON.parse(readFileSync(src, 'utf8')), [join(rdir, 'images')], dryRun, 'near_copy_rewrites');
    const { report, originality } = await checkAndImport(sql, s.staged, dryRun);
    const stored = await s.store();
    out.push({ file: src, importId: report.importId, result: report.result, counts: { ...report.counts, originality, figures_stored: stored },
      problems: [...s.notes.map((m) => ({ level: 'warning' as const, where: name, message: m })), ...report.problems.map((p) => ({ level: p.level, where: p.key, message: p.message }))] });
  }
  return out;
}

async function keyFixes(sql: Sql, dir: string, dryRun: boolean): Promise<FileResult[]> {
  const p = parseKeyFixes(readFileSync(join(dir, 'key_fixes.csv'), 'utf8'));
  const out: FileResult[] = [];
  for (const fx of p.rows) {
    const problems: Problem[] = [];
    const [have] = await sql`select question_id from cms.cms_questions where file_key = ${fx.new_file_key}`;
    if (have) { out.push({ file: `${fx.old_file_key} → ${fx.new_file_key}`, importId: null, result: 'ok', counts: { already_in_cms: have.question_id }, problems }); continue; }
    const src = isAbsolute(fx.source_file) ? fx.source_file : [join(PIPELINE_ROOT, fx.source_file), join(dir, fx.source_file)].find((x) => existsSync(x)) ?? join(PIPELINE_ROOT, fx.source_file);
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

export async function runUpdates(sql: Sql, dir = UPDATES_DIR, opts: { dryRun?: boolean; only?: string[] } = {}): Promise<FileResult[]> {
  const host = new URL(targetUrl()).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('import:updates runs against the local database only (queue 12 Nov 2026).');
  const want = (n: string) => !opts.only?.length || opts.only.includes(n);
  const out: FileResult[] = [];
  for (const name of CSV_ORDER) if (want(name) && existsSync(join(dir, name))) out.push(await csvFile(sql, dir, name, !!opts.dryRun));
  const needsBooks = (want('key_fixes.csv') && existsSync(join(dir, 'key_fixes.csv'))) || (want('near_copy_rewrites') && existsSync(join(dir, 'near_copy_rewrites')));
  if (needsBooks && !hasPdftotext()) throw new Error('pdftotext is needed for the originality check (brew install poppler).');
  if (want('key_fixes.csv') && existsSync(join(dir, 'key_fixes.csv'))) out.push(...await keyFixes(sql, dir, !!opts.dryRun));
  if (want('near_copy_rewrites') && existsSync(join(dir, 'near_copy_rewrites'))) out.push(...await rewrites(sql, dir, !!opts.dryRun));
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
    const results = await runUpdates(sql, dir, { dryRun, only });
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
    await sql.end();
  }
}

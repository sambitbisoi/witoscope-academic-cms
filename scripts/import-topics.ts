// npm run import:topics [-- --dry-run [--list]] [--math <xlsx>] [--science <xlsx>] [--english <xlsx>]
//
// Loads the master topic lists into cms_strands, cms_chapters and cms_topics,
// plus one ACH-<chapter>-<class> Achievers row per chapter and class.
// Runs as cms_owner. Re-runnable: new rows are inserted, changed rows are updated
// in place with an audit row in cms_reviews, and nothing is ever deleted
// (rows missing from the workbook are reported, not removed).
// --dry-run does everything inside a transaction and rolls it back.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertCmsOwner, connect } from './lib/db.ts';
import { refuseAfterCutover } from './lib/curriculum.ts';
import { achieversTopics, parseSubject, type Chapter, type Problem, type Strand, type Subject, type Topic } from './lib/topics.ts';
import { upsertCatalogue } from './lib/upsert.ts';
import { readWorkbook } from './lib/xlsx.ts';

const CR = join(homedir(), 'WitoScope', 'ContentResearch');
const DEFAULTS: Record<Subject, string> = {
  math: join(CR, 'Math', 'WitoScope_Math_Topics_Class1-6.xlsx'),
  science: join(CR, 'Science', 'WitoScope_Science_Topics_Class1-6.xlsx'),
  grammar: join(CR, 'English', 'WitoScope_English_Grammar_Topics_Class1-6.xlsx'),
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const arg = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const files: Record<Subject, string> = {
  math: arg('--math') ?? DEFAULTS.math,
  science: arg('--science') ?? DEFAULTS.science,
  grammar: arg('--english') ?? DEFAULTS.grammar,
};

// ---- parse and check (no database yet)
const strands: Strand[] = [];
const chapters: Chapter[] = [];
const topics: Topic[] = [];
const problems: Problem[] = [];
const fileInfo: { subject: Subject; path: string; sha256: string }[] = [];
for (const subject of Object.keys(files) as Subject[]) {
  const wb = await readWorkbook(files[subject]);
  fileInfo.push({ subject, path: files[subject].replace(homedir(), '~'), sha256: wb.sha256 });
  const p = parseSubject(subject, wb.sheets);
  strands.push(...p.strands); chapters.push(...p.chapters); topics.push(...p.topics); problems.push(...p.problems);
}
const achievers = achieversTopics(chapters, topics);
const allTopics = [...topics, ...achievers];
const errors = problems.filter((p) => p.level === 'error');

const gitCommit = (() => {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() ? '+dirty' : '';
    return head + dirty;
  } catch { return null; }
})();
const combinedHash = createHash('sha256').update(fileInfo.map((f) => f.sha256).join(':')).digest('hex');

// ---- write
type Counts = Record<string, { inserted: number; updated: number; unchanged: number; missing_from_workbook: number }>;
const counts: Counts = {};
const notes: Problem[] = [];

type Listing = { newChapters: string[]; newTopics: string[]; changed: { table: string; id: string; action: string; diff: Record<string, { before: unknown; after: unknown }> }[] };
let listing: Listing | null = null;
const sql = connect();
class DryRunRollback extends Error {}
let importId: number | null = null;
try {
  await assertCmsOwner(sql);
  await refuseAfterCutover(sql, 'import:topics');
  await sql.begin(async (tx) => {
    const [imp] = await tx`
      insert into cms.cms_imports (kind, file_path, git_commit, file_hash, options)
      values ('topics', ${fileInfo.map((f) => f.path).join(', ')}, ${gitCommit}, ${combinedHash},
              ${tx.json({ dry_run: dryRun, files: fileInfo })})
      returning import_id`;
    importId = Number(imp!.import_id);

    if (errors.length) return; // record the failed attempt only

    async function upsert<T extends object>(table: string, key: keyof T & string, rows: T[], jsonCols: string[] = []) {
      const r = await upsertCatalogue(tx, table, [key], rows, { jsonCols, byLabel: 'topic importer', importId: importId!, reason: 'master topic list re-import' });
      counts[table] = { inserted: r.counts.inserted, updated: r.counts.updated, unchanged: r.counts.unchanged, missing_from_workbook: r.counts.missing_from_source };
      notes.push(...r.notes.map((n) => ({ ...n, message: n.message.replace('not in the source', 'not in the workbook') })));
    }

    const before = args.includes('--list') ? {
      chapters: new Set((await tx`select chapter_id from cms.cms_chapters`).map((r) => r.chapter_id as string)),
      topics: new Set((await tx`select topic_id from cms.cms_topics`).map((r) => r.topic_id as string)),
    } : null;
    // `tx(\`cms.${table}\`)` is postgres.js identifier escaping: "cms"."cms_x".
    await upsert('cms_strands', 'strand_id', strands);
    await upsert('cms_chapters', 'chapter_id', chapters);
    await upsert('cms_topics', 'topic_id', allTopics, ['source_flags']);

    const report = [...problems, ...notes];
    await tx`
      update cms.cms_imports
      set finished_at = now(), result = 'ok', counts = ${tx.json(counts)}, error_report = ${tx.json(report as never)}
      where import_id = ${importId}`;
    if (before) {
      // --list: every new row and every changed field, for review before the real import
      const newCh = chapters.filter((c) => !before.chapters.has(c.chapter_id));
      const newT = allTopics.filter((t) => !before.topics.has(t.topic_id));
      const changed = await tx`select target_table, target_id, action, field_diff from cms.cms_reviews where import_id = ${importId} order by target_table, target_id`;
      listing = { newChapters: newCh.map((c) => `${c.chapter_id} ${c.name}`), newTopics: newT.map((t) => `${t.topic_id} · ${t.chapter_id} · class ${t.class} · ${t.name}`),
        changed: changed.map((c) => ({ table: c.target_table as string, id: c.target_id as string, action: c.action as string, diff: c.field_diff as Record<string, { before: unknown; after: unknown }> })) };
    }
    if (dryRun) throw new DryRunRollback();
  });
  if (errors.length) {
    await sql`update cms.cms_imports set finished_at = now(), result = 'failed', error_report = ${sql.json(problems as never)} where import_id = ${importId}`;
  }
} catch (e) {
  if (!(e instanceof DryRunRollback)) throw e;
} finally {
  await sql.end();
}

// ---- report, in plain words
const warnings = [...problems, ...notes].filter((p) => p.level === 'warning');
console.log(`\nTopic import${dryRun ? ' (DRY RUN — nothing saved)' : ''}${importId && !dryRun ? ` #${importId}` : ''}`);
for (const f of fileInfo) console.log(`  ${f.subject.padEnd(8)} ${f.path}  sha256 ${f.sha256.slice(0, 12)}`);
console.log(`  parsed: ${strands.length} strands, ${chapters.length} chapters, ${topics.length} topics (${topics.filter((t) => t.status === 'retired').length} retired), ${achievers.length} Achievers rows`);
if (errors.length) {
  console.log(`\n${errors.length} error(s) — nothing imported:`);
  for (const p of errors) console.log(`  ✗ ${p.where}: ${p.message}`);
} else {
  for (const [t, c] of Object.entries(counts)) {
    console.log(`  ${t.padEnd(13)} +${c.inserted} new · ${c.updated} updated · ${c.unchanged} unchanged${c.missing_from_workbook ? ` · ${c.missing_from_workbook} not in workbook` : ''}`);
  }
}
const L = listing as Listing | null;
if (L) {
  const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'string' ? v.replace(/\s+/g, ' ') : JSON.stringify(v));
  console.log(`\nNew chapters (${L.newChapters.length}):`); for (const c of L.newChapters) console.log(`  + ${c}`);
  console.log(`New topics (${L.newTopics.length}):`); for (const t of L.newTopics) console.log(`  + ${t}`);
  console.log(`Changed rows (${L.changed.length}):`);
  for (const c of L.changed) console.log(`  ~ ${c.table.replace('cms_', '')} ${c.id}${c.action !== 'edit_catalogue' ? ` (${c.action})` : ''}: ${Object.entries(c.diff).map(([k, d]) => `${k}: ${show(d.before)} → ${show(d.after)}`).join(' | ')}`);
}
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const p of warnings.slice(0, 50)) console.log(`  ! ${p.where}: ${p.message}`);
  if (warnings.length > 50) console.log(`  … ${warnings.length - 50} more in cms_imports.error_report`);
}
process.exit(errors.length ? 1 : 0);

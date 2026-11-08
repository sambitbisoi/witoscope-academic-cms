// npm run import:topics [-- --dry-run] [--math <xlsx>] [--science <xlsx>] [--english <xlsx>]
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
import { achieversTopics, diffRow, parseSubject, type Chapter, type Problem, type Strand, type Subject, type Topic } from './lib/topics.ts';
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

const sql = connect();
class DryRunRollback extends Error {}
let importId: number | null = null;
try {
  await assertCmsOwner(sql);
  await sql.begin(async (tx) => {
    const [imp] = await tx`
      insert into cms.cms_imports (kind, file_path, git_commit, file_hash, options)
      values ('topics', ${fileInfo.map((f) => f.path).join(', ')}, ${gitCommit}, ${combinedHash},
              ${tx.json({ dry_run: dryRun, files: fileInfo })})
      returning import_id`;
    importId = Number(imp!.import_id);

    if (errors.length) return; // record the failed attempt only

    async function upsert<T extends object>(table: string, key: keyof T & string, rows: T[], jsonCols: string[] = []) {
      const c = (counts[table] = { inserted: 0, updated: 0, unchanged: 0, missing_from_workbook: 0 });
      const existing = new Map<string, Record<string, unknown>>(
        (await tx.unsafe(`select * from cms.${table}`)).map((r) => [String(r[key]), r]),
      );
      const enc = (row: T) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, jsonCols.includes(k) ? tx.json(v as never) : v]));
      const fresh = rows.filter((r) => !existing.has(String(r[key])));
      for (let i = 0; i < fresh.length; i += 500) {
        await tx`insert into ${tx(`cms.${table}`)} ${tx(fresh.slice(i, i + 500).map(enc) as never[])}`;
      }
      c.inserted = fresh.length;
      for (const row of rows) {
        const before = existing.get(String(row[key]));
        if (!before) continue;
        const diff = diffRow(before as Partial<T>, row);
        if (!Object.keys(diff).length) { c.unchanged++; continue; }
        const set = Object.fromEntries(Object.keys(diff).map((k) => [k, enc(row)[k]]));
        await tx`update ${tx(`cms.${table}`)} set ${tx(set as never)} where ${tx(key as string)} = ${row[key] as string}`;
        const action = 'status' in diff ? (diff.status!.after === 'retired' ? 'retire' : 'restore') : 'edit_catalogue';
        await tx`
          insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, import_id, reason)
          values ('catalogue', ${table}, ${row[key] as string}, ${action}, ${tx.json(diff as never)}, 'topic importer', ${importId},
                  'master topic list re-import')`;
        c.updated++;
      }
      const inWorkbook = new Set(rows.map((r) => String(r[key])));
      for (const id of existing.keys()) {
        if (!inWorkbook.has(id)) {
          c.missing_from_workbook++;
          notes.push({ level: 'warning', where: table, message: `${id} is in the CMS but not in the workbook; left unchanged (never deleted)` });
        }
      }
    }

    // `tx(\`cms.${table}\`)` is postgres.js identifier escaping: "cms"."cms_x".
    await upsert('cms_strands', 'strand_id', strands);
    await upsert('cms_chapters', 'chapter_id', chapters);
    await upsert('cms_topics', 'topic_id', allTopics, ['source_flags']);

    const report = [...problems, ...notes];
    await tx`
      update cms.cms_imports
      set finished_at = now(), result = 'ok', counts = ${tx.json(counts)}, error_report = ${tx.json(report as never)}
      where import_id = ${importId}`;
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
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const p of warnings.slice(0, 50)) console.log(`  ! ${p.where}: ${p.message}`);
  if (warnings.length > 50) console.log(`  … ${warnings.length - 50} more in cms_imports.error_report`);
}
process.exit(errors.length ? 1 : 0);

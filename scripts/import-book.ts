// npm run import:book -- <file.book.json> [--dry-run]
//
// Imports one cms-book-chapter file (D3): updates the source's page offset, sets
// the page range on its chapter links, adds jump links per section, and loads the
// extracted items (internal only; no v11 tags). NCERT sources must already be
// registered (npm run import:sources). Audited; never deletes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseBook, type BookProblem } from './lib/book.ts';
import { assertCmsOwner, connect } from './lib/db.ts';
import { upsertCatalogue, type UpsertCounts } from './lib/upsert.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
if (!file) { console.error('usage: npm run import:book -- <file.book.json> [--dry-run]'); process.exit(1); }
const raw = readFileSync(resolve(file));

const sql = connect();
const counts: Record<string, UpsertCounts | Record<string, number>> = {};
let problems: BookProblem[] = [];
let importId: number | null = null;
let result: 'ok' | 'partial' | 'failed' = 'failed';
class DryRun extends Error {}
try {
  await assertCmsOwner(sql);
  await sql.begin(async (tx) => {
    const [imp] = await tx`insert into cms.cms_imports (kind, file_path, file_hash, options)
      values ('book', ${resolve(file).replace(homedir(), '~')}, ${createHash('sha256').update(raw).digest('hex')}, ${tx.json({ dry_run: dryRun })})
      returning import_id`;
    importId = Number(imp!.import_id);
    const topics = new Map((await tx`select topic_id, chapter_id from cms.cms_topics`).map((t) => [t.topic_id as string, t.chapter_id as string]));
    const p = parseBook(JSON.parse(raw.toString('utf8')), topics);
    problems = p.problems;
    if (problems.some((x) => x.level === 'error') || !('source' in p) || !p.source) {
      await tx`update cms.cms_imports set finished_at = now(), result = 'failed', error_report = ${tx.json(problems as never)} where import_id = ${importId}`;
      return;
    }
    const [existing] = await tx`select source_id from cms.cms_sources where source_id = ${p.source.source_id}`;
    if (!existing && p.source.publisher === 'NCERT') {
      problems.push({ level: 'error', where: 'file', message: `${p.source.source_id} is not registered; run npm run import:sources first` });
      await tx`update cms.cms_imports set finished_at = now(), result = 'failed', error_report = ${tx.json(problems as never)} where import_id = ${importId}`;
      return;
    }
    const opts = { byLabel: 'book importer', importId, reason: `book file ${file}` };
    // the source: only page_offset is this importer's (registry owns title/url; uploads own storage_path)
    const rs = await upsertCatalogue(tx, 'cms_sources', ['source_id'], [{ source_id: p.source.source_id, page_offset: p.source.page_offset }], { ...opts, scope: { col: 'source_id', value: p.source.source_id } });
    counts.cms_sources = rs.counts;
    const rl = await upsertCatalogue(tx, 'cms_source_chapters', ['source_id', 'chapter_id'], p.links, { ...opts, scope: { col: 'source_id', value: p.source.source_id } });
    counts.cms_source_chapters = rl.counts;
    // jumps have no natural key: match on (chapter, label); add new, move changed pages, never delete
    const old = await tx`select jump_id, chapter_id, label, pdf_page from cms.cms_source_jumps where source_id = ${p.source.source_id}`;
    const jc = { inserted: 0, updated: 0, unchanged: 0 };
    for (const j of p.jumps) {
      const o = old.find((x) => x.chapter_id === j.chapter_id && x.label === j.label);
      if (!o) { await tx`insert into cms.cms_source_jumps ${tx(j)}`; jc.inserted++; }
      else if (o.pdf_page !== j.pdf_page) { await tx`update cms.cms_source_jumps set pdf_page = ${j.pdf_page} where jump_id = ${o.jump_id}`; jc.updated++; }
      else jc.unchanged++;
    }
    counts.cms_source_jumps = jc;
    const ri = await upsertCatalogue(tx, 'cms_source_items', ['ref_id'], p.items, { ...opts, jsonCols: ['numbers'], scope: { col: 'source_id', value: p.source.source_id } });
    counts.cms_source_items = ri.counts;
    problems.push(...rs.notes, ...rl.notes, ...ri.notes);
    result = problems.some((x) => x.level === 'error') ? 'partial' : 'ok';
    await tx`update cms.cms_imports set finished_at = now(), result = ${result}, counts = ${tx.json(counts as never)}, error_report = ${tx.json(problems as never)}
             where import_id = ${importId}`;
    if (dryRun) throw new DryRun();
  });
} catch (e) {
  if (!(e instanceof DryRun)) throw e;
} finally {
  await sql.end();
}

console.log(`\nBook import${dryRun ? ' (DRY RUN — nothing saved)' : ` #${importId}`}: ${file} → ${(dryRun && result === 'failed' ? 'ok' : result).toUpperCase()}`);
for (const [t, c] of Object.entries(counts)) {
  const x = c as Record<string, number>;
  console.log(`  ${t.padEnd(20)} +${x.inserted} new · ${x.updated} updated · ${x.unchanged} unchanged${x.missing_from_source ? ` · ${x.missing_from_source} not in file` : ''}`);
}
for (const p of problems) console.log(`  ${p.level === 'error' ? '✗' : '!'} ${p.where}: ${p.message}`);
process.exitCode = problems.some((x) => x.level === 'error') ? 1 : 0;

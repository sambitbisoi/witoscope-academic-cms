// npm run import:sources [-- --dry-run]
//
// Registers every NCERT chapter PDF named in the topic workbooks' "NCERT (CBSE)"
// sheets as a cms_sources row (ID = NCERT-<pdf file stem>, url = the public NCERT
// link) and links it to the CMS chapters its mapped topics belong to.
// Owns only: title, kind, publisher, class, url, and the source→chapter links.
// Never touches page_offset (set by import:book)
// or page ranges and jumps (set by import:book). Audited; never deletes.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertCmsOwner, connect } from './lib/db.ts';
import { refuseAfterCutover } from './lib/curriculum.ts';
import { mappingRows, parseNcertSheet, type MapRow, type SourceProblem, type Subject } from './lib/sources.ts';
import { upsertCatalogue, type UpsertCounts } from './lib/upsert.ts';
import { readWorkbook } from './lib/xlsx.ts';

const dryRun = process.argv.includes('--dry-run');
const CR = join(homedir(), 'WitoScope', 'ContentResearch');
const FILES: Record<Subject, string> = {
  math: join(CR, 'Math', 'WitoScope_Math_Topics_Class1-6.xlsx'),
  science: join(CR, 'Science', 'WitoScope_Science_Topics_Class1-6.xlsx'),
  grammar: join(CR, 'English', 'WitoScope_English_Grammar_Topics_Class1-6.xlsx'),
};

const sql = connect();
const counts: Record<string, UpsertCounts> = {};
const problems: SourceProblem[] = [];
class DryRun extends Error {}
let importId: number | null = null;
let summary = '';
try {
  await assertCmsOwner(sql);
  // D5: after the cut-over, NCERT sources are kept in the CMS (import:book registers new books; Sources → Add a source)
  await refuseAfterCutover(sql, 'import:sources');
  const topicChapter = new Map((await sql`select topic_id, chapter_id from cms.cms_topics`).map((t) => [t.topic_id as string, t.chapter_id as string]));
  if (!topicChapter.size) throw new Error('no topics in the CMS; run import:topics first');
  const all = { sources: [] as ReturnType<typeof parseNcertSheet>['sources'], links: [] as ReturnType<typeof parseNcertSheet>['links'] };
  const hashes: string[] = [];
  const maps: MapRow[] = []; const droppedCols = new Set<string>();
  for (const subject of Object.keys(FILES) as Subject[]) {
    const wb = await readWorkbook(FILES[subject]);
    hashes.push(wb.sha256);
    const p = parseNcertSheet(subject, wb.sheets.get('NCERT (CBSE)') ?? [], topicChapter);
    all.sources.push(...p.sources); all.links.push(...p.links); problems.push(...p.problems);
    const m = mappingRows(subject, wb.sheets);
    maps.push(...m.rows); for (const [sh, cols] of Object.entries(m.dropped)) for (const c of cols) droppedCols.add(`${subject} · ${sh} · ${c}`);
  }
  summary = `${all.sources.length} NCERT chapter PDFs, ${all.links.length} chapter links, ${maps.length} source-mapping rows (left out: ${[...droppedCols].join('; ')})`;
  await sql.begin(async (tx) => {
    const [imp] = await tx`insert into cms.cms_imports (kind, file_path, file_hash, options)
      values ('sources', ${Object.values(FILES).map((f) => f.replace(homedir(), '~')).join(', ')},
              ${createHash('sha256').update(hashes.join(':')).digest('hex')}, ${tx.json({ dry_run: dryRun, sheet: 'NCERT (CBSE)' })})
      returning import_id`;
    importId = Number(imp!.import_id);
    const opts = { byLabel: 'source registry', importId, reason: 'NCERT (CBSE) sheets of the topic workbooks' };
    // scope: only NCERT rows are this importer's business
    const r1 = await upsertCatalogue(tx, 'cms_sources', ['source_id'], all.sources, { ...opts, scope: { col: 'publisher', value: 'NCERT' } });
    counts.cms_sources = r1.counts; problems.push(...r1.notes);
    const r2 = await upsertCatalogue(tx, 'cms_source_chapters', ['source_id', 'chapter_id'], all.links, opts);
    counts.cms_source_chapters = r2.counts;
    // links from other sources (book files, the browser) are not this importer's to judge
    problems.push(...r2.notes.filter((n) => n.message.startsWith('NCERT-')));
    // source-mapping tabs (citations only; evidence, notes and scan paths were dropped by mappingRows)
    const r3 = await upsertCatalogue(tx, 'cms_source_map', ['subject', 'sheet', 'row_no'], maps.map((m) => ({ ...m, cells: m.cells })), { ...opts, jsonCols: ['cells'], reason: 'source-mapping tabs of the topic workbooks' });
    counts.cms_source_map = r3.counts;
    const keep = new Set(maps.map((m) => `${m.subject} · ${m.sheet} · ${m.row_no}`));
    const gone = (await tx`select subject, sheet, row_no from cms.cms_source_map where status = 'active'`).filter((r) => !keep.has(`${r.subject} · ${r.sheet} · ${r.row_no}`));
    for (const g of gone) await tx`update cms.cms_source_map set status = 'retired', updated_at = now() where subject = ${g.subject} and sheet = ${g.sheet} and row_no = ${g.row_no}`;
    if (gone.length) problems.push({ level: 'warning', where: 'source-mapping tabs', message: `${gone.length} row(s) no longer in the workbooks: retired, not deleted` });
    await tx`update cms.cms_imports set finished_at = now(), result = ${problems.some((p) => p.level === 'error') ? 'partial' : 'ok'},
             counts = ${tx.json(counts as never)}, error_report = ${tx.json(problems as never)} where import_id = ${importId}`;
    if (dryRun) throw new DryRun();
  });
} catch (e) {
  if (!(e instanceof DryRun)) throw e;
} finally {
  await sql.end();
}

console.log(`\nNCERT source registry${dryRun ? ' (DRY RUN — nothing saved)' : ` #${importId}`}: ${summary}`);
for (const [t, c] of Object.entries(counts)) console.log(`  ${t.padEnd(20)} +${c.inserted} new · ${c.updated} updated · ${c.unchanged} unchanged${c.missing_from_source ? ` · ${c.missing_from_source} not in workbooks` : ''}`);
const errs = problems.filter((p) => p.level === 'error'); const warns = problems.filter((p) => p.level === 'warning');
if (errs.length) { console.log(`\n${errs.length} error(s):`); for (const p of errs) console.log(`  ✗ ${p.where}: ${p.message}`); }
if (warns.length) {
  const grouped = new Map<string, number>();
  for (const w of warns) { const k = w.message.replace(/\b(MT|ST|GT)\d{4}\b/, '<topic>').replace(/"[^"]*"/, '"…"'); grouped.set(k, (grouped.get(k) ?? 0) + 1); }
  console.log(`\n${warns.length} warning(s):`); for (const [m, n] of grouped) console.log(`  ! ${n} × ${m}`);
}

// Local originality check (Sambit, 10 Nov 2026): runs only on this Mac, reading the book
// PDFs and local book files here. Nothing from a book is sent anywhere; the CMS gets only
// citations and scores.
//
//   npm run check:originality -- <chapter.json>
//       Before an import. Checks every question in the file against the PDFs (and local
//       book files) of the chapter's sources and writes <chapter>.originality.json next to
//       it. import:chapter reads that report and records each result.
//   npm run check:originality -- --unchecked [--chapter MC27] [--dry-run]
//   npm run check:originality -- --all [--chapter MC27]
//       Every current version in the CMS, every field, LIST ONLY (nothing recorded): what the field
//       check (12 Nov 2026) flags beyond the old text-only check. CSV to .local-import/.
// Since 12 Nov 2026 every text field is checked: text (with parts), figure description, options,
// solutions, hints and wrong-answer notes; the question's result is its worst field.
//       Questions already in the CMS whose current version has never been checked (e.g.
//       drafts made by Generate). Records the results in cms_originality_checks.
//
// Results (Sambit, 10 Nov 2026): NEAR-COPY blocks the import — wording ≥ originality_near_copy
// (cms_config, 0.85) similar to a piece of a book page or book item, or the question's distinctive
// numbers all in one piece in the same order. FLAGGED is a warning — wording ≥ similarity_threshold
// (0.6), or those numbers in one piece in another order.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertCmsOwner, connect } from './lib/db.ts';
import { reportPathFor as reportPath } from './lib/originality-report.ts';
import { hasPdftotext, indexPdfs, localBookItems, pdfFor, pdfPages } from './lib/local-books.ts';
import { checkQuestion, checkText, corpus, NEAR_COPY_DEFAULT, ORIGINALITY_TOOL, REPORT_SCHEMA, type BookItem, type BookPage, type Corpus, type FieldResult, type OriginalityReport } from '../shared/originality.ts';
import { loadBundle } from './lib/bundle.ts';
import { questionFromDb } from '../shared/fromDb.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChapterFile, Question } from '../shared/types.ts';

type Sql = ReturnType<typeof connect>;
export const reportPathFor = (chapterFile: string) => reportPath(resolve(chapterFile));
export const questionText = (q: Pick<Question, 'text' | 'parts'>) => [q.text, ...(q.parts ?? []).map((p) => p.text)].join(' ');

/** Everything the chapter's book sources say, read from this Mac. */
export async function chapterCorpus(sql: Sql, chapterId: string, pdfs = indexPdfs(), books = localBookItems()) {
  const sources = await sql<{ source_id: string; page_from: number | null; page_to: number | null }[]>`
    select s.source_id, sc.page_from, sc.page_to from cms.cms_source_chapters sc join cms.cms_sources s on s.source_id = sc.source_id
     where sc.chapter_id = ${chapterId} and s.kind in ('pdf', 'scanned_pdf') order by s.source_id`;
  const pages: BookPage[] = [], items: BookItem[] = [];
  const checked: { source_id: string; pages: string }[] = [], missing: string[] = [];
  for (const s of sources) {
    const file = pdfFor(pdfs, s.source_id);
    const own = (books.get(s.source_id) ?? []).flatMap((b) => b.items);
    let read: BookPage[] = [];
    if (file) read = pdfPages(file, s.source_id, s.page_from, s.page_to);
    const hasText = read.reduce((n, p) => n + p.text.trim().length, 0) >= 200; // a scan without a text layer reads as almost nothing
    if (!hasText && !own.length) { missing.push(s.source_id); continue; }
    if (hasText) pages.push(...read);
    items.push(...own);
    checked.push({ source_id: s.source_id, pages: [hasText ? (s.page_from ? `pdf ${s.page_from}–${s.page_to ?? 'end'}` : 'all pages') : null, own.length ? `${own.length} book-file items` : null].filter(Boolean).join(' + ') });
  }
  return { corpus: corpus(pages, items) as Corpus, checked, missing };
}

async function thresholds(sql: Sql) {
  const rows = await sql`select key, value from cms.cms_config where key in ('similarity_threshold', 'originality_near_copy')`;
  const v = (k: string, d: number) => Number(rows.find((r) => r.key === k)?.value ?? d);
  return { th: v('similarity_threshold', 0.6), near: v('originality_near_copy', NEAR_COPY_DEFAULT) };
}

export async function checkChapterFile(sql: Sql, path: string): Promise<OriginalityReport> {
  const raw = readFileSync(resolve(path));
  const file = JSON.parse(raw.toString('utf8')) as ChapterFile;
  const { th, near } = await thresholds(sql);
  const { corpus: c, checked, missing } = await chapterCorpus(sql, file.chapter_id);
  return {
    file_schema: REPORT_SCHEMA, tool: ORIGINALITY_TOOL, chapter_file_sha256: createHash('sha256').update(raw).digest('hex'),
    chapter_id: file.chapter_id, checked_at: new Date().toISOString(), threshold: th, near_copy_threshold: near, checked, missing,
    questions: file.questions.map((q) => ({ key: q.key, ...checkQuestion(q, c, th, near) })),
  };
}

interface DbRow { version_id: string; question_id: string; version_no: number; chapter_id: string; file_key: string | null; status: string }
async function currentVersions(sql: Sql, chapter: string | null, uncheckedOnly: boolean) {
  return sql<DbRow[]>`
    select v.version_id, q.question_id, v.version_no, q.chapter_id, q.file_key, v.status
      from cms.cms_questions q join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
     where q.bank = 'production' and q.retired_at is null
       ${uncheckedOnly ? sql`and not exists (select 1 from cms.cms_originality_checks c where c.version_id = v.version_id)` : sql``}
       ${chapter ? sql`and q.chapter_id = ${chapter}` : sql``}
     order by q.chapter_id, q.question_id`;
}
/** Every field of each current version, chapter by chapter (the corpus is built once per chapter). */
async function checkVersions(sql: Sql, rows: DbRow[], each: (r: DbRow, res: ReturnType<typeof checkQuestion>, oldText: ReturnType<typeof checkText>, ctx: { checked: unknown; missing: unknown }) => void) {
  const { th, near } = await thresholds(sql);
  const pdfs = indexPdfs(), books = localBookItems();
  const chapters = [...new Set(rows.map((r) => r.chapter_id))];
  for (const [i, ch] of chapters.entries()) {
    const { corpus: c, checked, missing } = await chapterCorpus(sql, ch, pdfs, books);
    const mine = rows.filter((x) => x.chapter_id === ch);
    process.stderr.write(`  ${ch} (${i + 1}/${chapters.length}): ${mine.length} question(s)\n`);
    for (const r of mine) {
      const q = questionFromDb(await loadBundle(sql, Number(r.version_id)));
      each(r, checkQuestion(q, c, th, near), checkText(questionText(q), c, th, near), { checked, missing });
    }
  }
  return { th, near };
}

async function checkUnchecked(sql: Sql, chapter: string | null, dryRun: boolean) {
  const rows = await currentVersions(sql, chapter, true);
  const results: { version_id: string; label: string; chapter: string; r: FieldResult; checked: unknown; missing: unknown }[] = [];
  const { th, near } = await checkVersions(sql, rows, (r, res, _old, ctx) =>
    results.push({ version_id: r.version_id, label: `${r.question_id} v${r.version_no}`, chapter: r.chapter_id, r: res, ...ctx }));
  print(results.map((x) => ({ label: `${x.chapter} ${x.label}`, ...x.r })));
  if (dryRun || !results.length) { console.log(dryRun ? '\nDRY RUN: nothing recorded.' : 'Nothing to check.'); return; }
  await sql.begin(async (tx) => {
    const ids = results.map((x) => x.version_id).join(',');
    const counts = Object.fromEntries(['clear', 'flagged', 'near_copy', 'no_sources'].map((k) => [k, results.filter((x) => x.r.result === k).length]));
    const [imp] = await tx`insert into cms.cms_imports (kind, file_path, file_hash, chapter_id, options, finished_at, result, counts)
      values ('originality', ${'unchecked versions in the CMS'}, ${createHash('sha256').update(ids).digest('hex')}, ${chapter}, ${tx.json({ tool: ORIGINALITY_TOOL, threshold: th, near_copy_threshold: near })}, now(), 'ok', ${tx.json(counts)})
      returning import_id`;
    const now = new Date().toISOString();
    await tx`insert into cms.cms_originality_checks ${tx(results.map((x) => ({
      version_id: x.version_id, checked_at: now, result: x.r.result, similarity: x.r.similarity, same_numbers: x.r.same_numbers, closest_ref: x.r.closest_ref,
      field: x.r.field, checked: tx.json(x.checked as never), missing: tx.json(x.missing as never), threshold: th, near_copy_threshold: near, tool: ORIGINALITY_TOOL, import_id: imp!.import_id,
    })) as never)}`;
    console.log(`\nRecorded ${results.length} check${results.length === 1 ? '' : 's'} (import #${imp!.import_id}).`);
  });
}

/**
 * --all: every current version in the CMS, every field, LIST ONLY (nothing recorded, no question
 * changed). Reports what the field check flags beyond the old text-only check. Writes a CSV of
 * citations and scores (no book text) to .local-import/ on this Mac.
 */
async function checkAll(sql: Sql, chapter: string | null) {
  const rows = await currentVersions(sql, chapter, false);
  const fresh: { r: DbRow; f: FieldResult; old: ReturnType<typeof checkText> }[] = [];
  const tally: Record<string, number> = { clear: 0, flagged: 0, near_copy: 0, no_sources: 0 };
  await checkVersions(sql, rows, (r, res, old) => {
    tally[res.result] = (tally[res.result] ?? 0) + 1;
    // new = any field other than the text that is flagged or near-copy (the old check read only the text)
    for (const f of res.fields) if (f.field !== 'text') fresh.push({ r, f, old });
  });
  const dir = join(import.meta.dirname, '..', '.local-import'); mkdirSync(dir, { recursive: true });
  const out = join(dir, `originality-fields-${new Date().toISOString().slice(0, 10)}.csv`);
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  writeFileSync(out, ['question_id,file_key,chapter,status,field,result,similarity,same_numbers,closest_ref,text_only_result',
    ...fresh.map(({ r, f, old }) => [r.question_id, r.file_key, r.chapter_id, r.status, f.field, f.result, f.similarity, f.same_numbers, f.closest_ref, old.result].map(q).join(','))].join('\n') + '\n');
  const qs = new Set(fresh.map((x) => x.r.question_id));
  console.log(`\n${rows.length} questions checked (every field): ${tally.clear} clear · ${tally.flagged} close · ${tally.near_copy} near-copy · ${tally.no_sources} no book on this Mac`);
  console.log(`NEW beyond the text-only check: ${fresh.length} field(s) in ${qs.size} question(s): ${fresh.filter((x) => x.f.result === 'near_copy').length} near-copy, ${fresh.filter((x) => x.f.result === 'flagged').length} close`);
  for (const { r, f, old } of fresh) console.log(`  ${f.result === 'near_copy' ? '✗ NEAR-COPY' : '! close    '} ${r.question_id} ${r.file_key ?? ''} [${r.status}] ${f.field}: ${f.closest_ref} (${f.similarity}${f.same_numbers ? ', same numbers' : ''}) · text-only was ${old.result}`);
  console.log(`\nList only: nothing recorded, no question changed. CSV (citations and scores only): ${out}`);
}

function print(rows: ({ label: string; field?: string } & ReturnType<typeof checkText>)[]) {
  for (const r of rows) {
    const mark = r.result === 'near_copy' ? '✗ NEAR-COPY (blocks)' : r.result === 'flagged' ? '! close (warning)' : r.result === 'no_sources' ? '? no book on this Mac' : '✓ clear';
    console.log(`  ${mark.padEnd(22)} ${r.label}${r.closest_ref ? `  · closest ${r.closest_ref} (${r.similarity}${r.same_numbers ? ', same numbers' : ''}${r.field && r.field !== 'text' ? `; ${r.field}` : ''})` : ''}`);
  }
  const n = (k: string) => rows.filter((r) => r.result === k).length;
  console.log(`\n${rows.length} checked · ${n('clear')} clear · ${n('flagged')} close (warning) · ${n('near_copy')} near-copy (blocks the import) · ${n('no_sources')} with no book on this Mac`);
}

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] ?? null : null);
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--chapter');
  if (!file && !args.includes('--unchecked') && !args.includes('--all')) {
    console.error('usage: npm run check:originality -- <chapter.json>\n       npm run check:originality -- --unchecked [--chapter MC27] [--dry-run]\n       npm run check:originality -- --all [--chapter MC27]   (list only)');
    process.exit(1);
  }
  if (!hasPdftotext()) { console.error('pdftotext is needed (brew install poppler).'); process.exit(1); }
  const sql = connect();
  try {
    await assertCmsOwner(sql);
    if (file) {
      const rep = await checkChapterFile(sql, file);
      const out = reportPathFor(file);
      writeFileSync(out, JSON.stringify(rep, null, 2) + '\n');
      console.log(`Originality check of ${file} (${rep.chapter_id}; warning from ${rep.threshold}, near-copy from ${rep.near_copy_threshold})`);
      console.log(`  read on this Mac: ${rep.checked.map((c) => `${c.source_id} (${c.pages})`).join(', ') || 'nothing'}${rep.missing.length ? `\n  no file on this Mac: ${rep.missing.join(', ')}` : ''}`);
      print(rep.questions.map((q) => ({ label: q.key, ...q })));
      console.log(`Report: ${out} (citations and scores only; import:chapter records it)`);
    } else {
      if (args.includes('--all')) await checkAll(sql, opt('--chapter'));
      else await checkUnchecked(sql, opt('--chapter'), args.includes('--dry-run'));
    }
  } finally {
    await sql.end();
  }
}

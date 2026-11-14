// Local originality check (Sambit, 10 Nov 2026): runs only on this Mac, reading the book
// PDFs and local book files here. Nothing from a book is sent anywhere; the CMS gets only
// citations and scores.
//
//   npm run check:originality -- <chapter.json>
//       Before an import. Checks every question in the file against the PDFs (and local
//       book files) of the chapter's sources and writes <chapter>.originality.json next to
//       it. import:chapter reads that report and records each result.
//   npm run check:originality -- --unchecked [--chapter MC27] [--dry-run]
//   npm run check:originality -- --pending [--dry-run]
//       Questions added by hand or uploaded in the CMS (13 Nov 2026) whose check is pending. Run on
//       this Mac against the database in CMS_DATABASE_URL (the real project when it points there):
//       pulls their text, checks every field against the local book PDFs and book files, records
//       each result (citations and scores only), clears "originality pending" and logs it. Nothing
//       from a book is uploaded.
//   npm run check:originality -- --all [--chapter MC27] [--to-fix <file.csv>]
//       Every current version in the CMS, every field, LIST ONLY (nothing recorded): what the field
//       check (12 Nov 2026) flags beyond the old text-only check. CSV to .local-import/.
// Since 12 Nov 2026 every text field is checked: text (with parts), figure description, options,
// solutions, hints and wrong-answer notes; the question's result is its worst field. The numbers rule
// applies to the text, figure description and options only (option a); the others get the wording test.
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

export async function thresholds(sql: Sql) {
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

/** The every-field check of one stored version (corpus cached per chapter by the caller). */
export async function checkStoredVersion(sql: Sql, versionId: number, chapterId: string, cache = new Map<string, Awaited<ReturnType<typeof chapterCorpus>>>()) {
  const { th, near } = await thresholds(sql);
  if (!cache.has(chapterId)) cache.set(chapterId, await chapterCorpus(sql, chapterId));
  const { corpus: c, checked, missing } = cache.get(chapterId)!;
  const q = questionFromDb(await loadBundle(sql, versionId));
  return { result: checkQuestion(q, c, th, near), checked, missing, th, near };
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

/** --pending: the questions added or uploaded in the CMS that wait for their book check. */
export async function checkPending(sql: Sql, dryRun: boolean) {
  const rows = await sql<DbRow[]>`
    select v.version_id, q.question_id, v.version_no, q.chapter_id, q.file_key, v.status
      from cms.cms_questions q join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
     where v.originality_pending and q.retired_at is null
     order by q.chapter_id, q.question_id`;
  if (!rows.length) { console.log('No questions wait for their originality check.'); return { checked: 0 }; }
  const results: { row: DbRow; r: FieldResult; checked: unknown; missing: unknown }[] = [];
  const { th, near } = await checkVersions(sql, rows, (row, res, _old, ctx) => results.push({ row, r: res, ...ctx }));
  print(results.map((x) => ({ label: `${x.row.chapter_id} ${x.row.question_id} v${x.row.version_no}${x.row.file_key ? ` (${x.row.file_key})` : ''}`, ...x.r })));
  if (dryRun) { console.log('\nDRY RUN: nothing recorded; the questions stay "originality pending".'); return { checked: results.length }; }
  await sql.begin(async (tx) => {
    const counts = Object.fromEntries(['clear', 'flagged', 'near_copy', 'no_sources'].map((k) => [k, results.filter((x) => x.r.result === k).length]));
    const [imp] = await tx`insert into cms.cms_imports (kind, file_path, file_hash, options, finished_at, result, counts)
      values ('originality', ${'pending checks (questions added or uploaded in the CMS)'}, ${createHash('sha256').update(results.map((x) => x.row.version_id).join(',')).digest('hex')},
              ${tx.json({ tool: ORIGINALITY_TOOL, threshold: th, near_copy_threshold: near, mode: 'pending' })}, now(), 'ok', ${tx.json(counts)})
      returning import_id`;
    const now = new Date().toISOString();
    for (const x of results) {
      const [chk] = await tx`insert into cms.cms_originality_checks ${tx({ version_id: x.row.version_id, checked_at: now, result: x.r.result, similarity: x.r.similarity,
        same_numbers: x.r.same_numbers, closest_ref: x.r.closest_ref, field: x.r.field, checked: tx.json(x.checked as never), missing: tx.json(x.missing as never),
        threshold: th, near_copy_threshold: near, tool: ORIGINALITY_TOOL, import_id: imp!.import_id } as never)} returning check_id`;
      await tx`update cms.cms_question_versions set originality_pending = false where version_id = ${x.row.version_id}`;
      await tx`insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label, import_id)
        values ('question_version', 'cms_question_versions', ${`${x.row.question_id} v${x.row.version_no}`}, 'originality_check',
                ${`originality check on the Mac: ${x.r.result}${x.r.field ? ` (${x.r.field})` : ''}`},
                ${tx.json({ originality_pending: { before: true, after: false }, check_id: Number(chk!.check_id), result: x.r.result, field: x.r.field,
                            similarity: x.r.similarity, same_numbers: x.r.same_numbers, closest_ref: x.r.closest_ref, tool: ORIGINALITY_TOOL } as never)},
                'originality check (Mac)', ${imp!.import_id})`;
    }
    console.log(`\nRecorded ${results.length} check${results.length === 1 ? '' : 's'} (import #${imp!.import_id}); "originality pending" cleared on each.`);
  });
  return { checked: results.length };
}

/**
 * --all: every current version in the CMS, every field, LIST ONLY (nothing recorded, no question
 * changed). Reports what the field check flags beyond the old text-only check. Writes a CSV of
 * citations and scores (no book text) to .local-import/ on this Mac.
 */
async function checkAll(sql: Sql, chapter: string | null, toFix: string | null) {
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
  if (toFix) {
    // the hand-over list for the data thread (citations and scores only)
    writeFileSync(toFix, ['file_key,question_id,field,result,score,citation',
      ...fresh.map(({ r, f }) => [r.file_key, r.question_id, f.field, f.result, f.similarity, f.closest_ref].map(q).join(','))].join('\n') + '\n');
    console.log(`To-fix list: ${toFix}`);
  }
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

/** --science <master.xlsx>: every field of every content row and question of the Science master (13 Nov 2026). */
async function checkScience(sql: Sql, masterPath: string) {
  const { readMaster } = await import('./lib/science-master.ts');
  const { checkMaster, scienceReportPath } = await import('./lib/science-originality.ts');
  const master = await readMaster(masterPath);
  const errors = master.problems.filter((p) => p.level === 'error');
  if (errors.length) { for (const p of errors) console.error(`  ✗ ${p.where}: ${p.message}`); throw new Error('the master has errors; fix them first'); }
  const { th, near } = await thresholds(sql);
  console.log(`Originality check of the Science master (${master.rows.length} content rows, ${master.questions.length} questions; warning from ${th}, near-copy from ${near})`);
  const rep = checkMaster(master, join(masterPath, '..'), th, near, (s) => process.stderr.write(`${s}\n`));
  const out = scienceReportPath(masterPath);
  writeFileSync(out, JSON.stringify(rep, null, 2) + '\n');
  const tally = (xs: { result: string }[]) => ['clear', 'flagged', 'near_copy', 'no_sources'].map((k) => `${xs.filter((x) => x.result === k).length} ${k.replace('_', '-')}`).join(' · ');
  console.log(`  read on this Mac: ${rep.read.length} page sets from ${new Set(rep.read.map((r) => r.source_id)).size} books${rep.missing.length ? ` · no text on this Mac for ${rep.missing.join(', ')}` : ''}`);
  console.log(`  content rows: ${tally(rep.rows)}`);
  console.log(`  questions:    ${tally(rep.questions)}`);
  for (const x of [...rep.rows, ...rep.questions].filter((r) => r.result === 'near_copy')) console.log(`  ✗ NEAR-COPY ${x.key} · ${x.field}: ${x.closest_ref} (${x.similarity}${x.same_numbers ? ', same numbers' : ''})`);
  console.log(`Report: ${out} (citations and scores only; import:science reads it)`);
}

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.includes('--science')) {
    const path = resolve(opt2(args, '--science') ?? join(process.env.HOME ?? '', 'WitoScope', 'ContentResearch', 'Science', 'WitoScope_Science_Master.xlsx'));
    if (!hasPdftotext()) { console.error('pdftotext is needed (brew install poppler).'); process.exit(1); }
    const sql = connect();
    try { await assertCmsOwner(sql); await checkScience(sql, path); } finally { await sql.end(); }
    process.exit(0);
  }
  const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] ?? null : null);
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--chapter' && args[i - 1] !== '--to-fix');
  if (!file && !args.includes('--unchecked') && !args.includes('--all') && !args.includes('--pending')) {
    console.error('usage: npm run check:originality -- <chapter.json>\n       npm run check:originality -- --pending [--dry-run]\n       npm run check:originality -- --unchecked [--chapter MC27] [--dry-run]\n       npm run check:originality -- --all [--chapter MC27]   (list only)');
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
      if (args.includes('--pending')) {
        const target = new URL(process.env.CMS_DATABASE_URL ?? 'postgres://127.0.0.1').hostname;
        console.log(`Pending originality checks against ${target === '127.0.0.1' || target === 'localhost' ? 'the LOCAL database' : `the database at ${target}`}${args.includes('--dry-run') ? ' (dry run)' : ''}`);
        await checkPending(sql, args.includes('--dry-run'));
      } else if (args.includes('--all')) await checkAll(sql, opt('--chapter'), opt('--to-fix') ? resolve(opt('--to-fix')!) : null);
      else await checkUnchecked(sql, opt('--chapter'), args.includes('--dry-run'));
    }
  } finally {
    await sql.end();
  }
}

function opt2(args: string[], name: string) { const v = args[args.indexOf(name) + 1]; return v && !v.startsWith('--') ? v : null; }

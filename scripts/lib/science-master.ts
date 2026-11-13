// Reads WitoScope_Science_Master.xlsx (our own words; book pages as bare citations only) into typed
// content rows, questions and sources. Problems are collected, not thrown: the importer refuses to
// write when any is an error.
import { createHash } from 'node:crypto';
import {
  CONTENT_COLUMNS, CONTENT_TYPES, davPages, figureDescription, idList, LEGEND_COLUMNS, legendBooks, missingColumns, ncertPages, notesFlags, QUESTION_COLUMNS, QUESTION_USES,
  questionLinks, resolveCitation, sheetStatus, sourcesFromLegend, storedFormat, str, taughtIn, TIERS, yn, type LegendBook, type RowStatus, type ScienceSource,
} from '../../shared/science.ts';
import { stableJson } from '../../shared/json.ts';
import { readWorkbook } from './xlsx.ts';

export interface Citation { source_id: string; page_from: number; page_to: number; raw: string; for_row_id?: string }
export interface MasterRow {
  row_id: string; topic_id: string; chapter_id: string; row_class: number; type: string; chapter_role: string; content: string;
  why_it_matters: string | null; misconceptions: string | null; diagram_description: string | null; picture_question: boolean; question_use: string;
  safety: string | null; source: string; found_in: string | null; confidence: string | null; notes: string | null;
  time_sensitive: boolean; time_checked_year: number | null; accuracy_flag: boolean;
  master_file: string; book: string | null; book_chapter_no: number | null; book_chapter_title: string | null; appears_in: string | null; sort: number;
  citations: Citation[]; sheet_status: RowStatus | null; sheet: number;
}
export interface MasterQuestion {
  qid: string; topic_id: string; row_class: number; tier: string; sheet_format: string; format: 'MCQ-4' | 'True/False'; text: string; options: string[]; correct: string;
  explanation: string | null; misconception_targeted: string | null; picture_needed: boolean; figure_description: string | null; safety_note: string | null;
  confidence: string | null; notes: string | null; links: { row_id: string; role: 'direct' | 'supporting' }[]; citations: Citation[]; sheet: number; hash: string;
}
export interface MasterProblem { level: 'error' | 'warning'; where: string; message: string }
export interface Master { path: string; sha256: string; rows: MasterRow[]; questions: MasterQuestion[]; books: LegendBook[]; sources: ScienceSource[]; problems: MasterProblem[] }

const num = (v: unknown) => (str(v) === null ? null : Number(v));

/** The hash that decides whether a content row changed (every stored field and its citations). */
export const rowHash = (r: Omit<MasterRow, 'sheet' | 'sheet_status'>) => {
  const { citations, ...rest } = r;
  return createHash('sha256').update(stableJson({ ...rest, citations: [...citations].map((c) => `${c.source_id}|${c.page_from}|${c.page_to}|${c.raw}|${c.for_row_id ?? ''}`).sort() })).digest('hex');
};

export async function readMaster(path: string): Promise<Master> {
  const wb = await readWorkbook(path);
  const problems: MasterProblem[] = [];
  const err = (where: string, message: string) => problems.push({ level: 'error', where, message });
  const warn = (where: string, message: string) => problems.push({ level: 'warning', where, message });
  const sheet = (name: string, cols: readonly string[]) => {
    const rows = wb.sheets.get(name);
    if (!rows) { err(name, `the workbook has no "${name}" tab`); return []; }
    const have = new Set(rows.flatMap((r) => Object.keys(r.values)));
    const miss = missingColumns(have, cols);
    if (miss.length) err(name, `missing column(s): ${miss.join(', ')}`);
    return rows;
  };
  const C = sheet('Content', CONTENT_COLUMNS), Q = sheet('Questions', QUESTION_COLUMNS), L = sheet('Legend', LEGEND_COLUMNS);
  const books = legendBooks(L.map((r) => r.values));
  const sources = sourcesFromLegend(books);
  if (!books.length) err('Legend', 'no "Book short names" rows');

  const cite = (cs: ReturnType<typeof davPages>, rowClass: number, where: string): Citation[] => cs.flatMap((c) => {
    try { return resolveCitation(c, rowClass, books); } catch (e) { err(where, (e as Error).message); return []; }
  });

  const rows: MasterRow[] = [];
  const seen = new Set<string>();
  C.forEach((x, i) => {
    const v = x.values, where = `Content row ${x.row}`;
    const row_id = str(v['Row ID']);
    if (!row_id) { err(where, 'Row ID is empty'); return; }
    if (seen.has(row_id)) { err(where, `Row ID ${row_id} appears twice`); return; }
    seen.add(row_id);
    const w = `${where} (${row_id})`;
    const type = str(v.Type) ?? '', use = str(v['Question use']) ?? '', content = str(v.Content);
    if (!(CONTENT_TYPES as readonly string[]).includes(type)) err(w, `Type "${type}" is not one of ${CONTENT_TYPES.join(', ')}`);
    if (!(QUESTION_USES as readonly string[]).includes(use)) err(w, `Question use "${use}" is not one of ${QUESTION_USES.join(', ')}`);
    if (!content) err(w, 'Content is empty');
    const rowClass = Number(v['Row class']);
    if (!Number.isInteger(rowClass) || rowClass < 1 || rowClass > 6) err(w, `Row class "${v['Row class']}" is not 1–6`);
    let citations: Citation[] = [];
    try { citations = [...cite(ncertPages(v['NCERT printed pages']), rowClass, w), ...cite(davPages(v['DAV pages']), rowClass, w)]; } catch (e) { err(w, (e as Error).message); }
    const notes = str(v.Notes);
    const pic = yn(v['Picture question possible (Y/N)']);
    if (pic === null) warn(w, 'Picture question possible is not Y or N; read as N');
    const conf = str(v.Confidence)?.toLowerCase() ?? null;
    rows.push({
      row_id, topic_id: str(v['Topic ID']) ?? '', chapter_id: str(v['Master chapter ID']) ?? '', row_class: rowClass, type, chapter_role: str(v['Chapter role']) ?? '',
      content: content ?? '', why_it_matters: str(v['Why it matters / real-life link']), misconceptions: str(v['Common misconceptions']),
      diagram_description: str(v['Diagram description']), picture_question: pic ?? false, question_use: use, safety: str(v.Safety), source: str(v.Source) ?? '',
      found_in: str(v['Found in']), confidence: conf, notes, ...notesFlags(notes), master_file: str(v.File) ?? '', book: str(v.Book),
      book_chapter_no: num(v['Chapter no.']), book_chapter_title: str(v['Chapter title']), appears_in: str(v['Appears in (this chapter)']), sort: i + 1,
      citations, sheet_status: sheetStatus(str(v['Question status'])), sheet: x.row,
    });
  });

  const questions: MasterQuestion[] = [];
  const seenQ = new Set<string>();
  for (const x of Q) {
    const v = x.values, qid = str(v['Q ID']), where = `Questions row ${x.row}${qid ? ` (${qid})` : ''}`;
    if (!qid) { err(where, 'Q ID is empty'); continue; }
    if (seenQ.has(qid)) { err(where, `Q ID ${qid} appears twice`); continue; }
    seenQ.add(qid);
    const options = (['Option A', 'B', 'C', 'D'] as const).map((k) => str(v[k]));
    const letter = str(v.Answer)?.toUpperCase() ?? '';
    const tier = str(v.Level) ?? '';
    const sheetFormat = str(v.Format) ?? '';
    let format: 'MCQ-4' | 'True/False' = 'MCQ-4';
    try { format = storedFormat(sheetFormat, options); } catch (e) { err(where, (e as Error).message); }
    const opts = options.filter((o): o is string => o !== null);
    const idx = 'ABCD'.indexOf(letter);
    if (!(TIERS as readonly string[]).includes(tier)) err(where, `Level "${tier}" is not L1, L2 or L3`);
    if (idx < 0 || idx >= opts.length) err(where, `Answer "${letter}" is not one of the options`);
    const text = str(v.Question);
    if (!text) err(where, 'Question is empty');
    const pic = yn(v['Picture needed (Y/N)']);
    const fig = figureDescription(str(v['Image brief (question)']), str(v['Image briefs (options)']));
    if (pic && !fig) err(where, 'a picture is needed but there is no image brief');
    const rowClass = Number(v['Row class']);
    const links = questionLinks(v['Content row ID(s)'], v['Direct row ID(s)']);
    for (const d of idList(v['Direct row ID(s)'])) if (!idList(v['Content row ID(s)']).includes(d)) warn(where, `direct row ${d} is not in Content row ID(s); linked as direct`);
    if (!links.some((l) => l.role === 'direct')) warn(where, 'no direct content row');
    for (const l of links) if (!seen.has(l.row_id)) err(where, `content row ${l.row_id} is not in the Content tab`);
    let citations: Citation[] = [];
    try { citations = cite(taughtIn(v['Taught in']), rowClass, where); } catch (e) { err(where, (e as Error).message); }
    // True/False: options A–B are "True"/"False" in the sheet; the CMS stores the same two
    const correct = format === 'True/False' ? (opts[idx] ?? '') : (opts[idx] ?? '');
    if (format === 'True/False' && !['True', 'False'].includes(correct)) err(where, `a True/False answer must be "True" or "False" (it is "${correct}")`);
    const q: Omit<MasterQuestion, 'hash'> = {
      qid, topic_id: str(v['Topic ID']) ?? '', row_class: rowClass, tier, sheet_format: sheetFormat, format, text: text ?? '', options: opts, correct,
      explanation: str(v.Explanation), misconception_targeted: str(v['Misconception targeted']), picture_needed: pic ?? false, figure_description: fig,
      safety_note: str(v['Safety note']), confidence: str(v.Confidence)?.toLowerCase() ?? null, notes: str(v.Notes), links, citations, sheet: x.row,
    };
    const { sheet: _s, ...hashed } = q;
    questions.push({ ...q, hash: createHash('sha256').update(stableJson(hashed)).digest('hex') });
  }
  return { path, sha256: wb.sha256, rows, questions, books, sources, problems };
}

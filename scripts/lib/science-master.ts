// Reads WitoScope_Science_Master.xlsx (our own words; book pages as bare citations only) into typed
// content rows, questions and sources. Problems are collected, not thrown: the importer refuses to
// write when any is an error.
import { createHash } from 'node:crypto';
import {
  alsoInRows, CONTENT_COLUMNS, CONTENT_TYPES, davPages, figureDescription, idList, LEGEND_COLUMNS, legendBooks, missingColumns, ncertPages, notesFlags, QUESTION_COLUMNS, QUESTION_USES,
  questionLinks, resolveCitation, sheetStatus, sourcesFromLegend, storedFormat, str, taughtIn, TIERS, yn, familiarity, FAMILIARITY, goldUse, optionTag, scienceType, scienceDrivers, WRONG_TAGS, type LegendBook, type RowStatus, type ScienceSource,
} from '../../shared/science.ts';
import { stableJson } from '../../shared/json.ts';
import { formatTime, parseTime, typedTimeProblems } from '../../shared/typed-time.ts';
import { readWorkbook } from './xlsx.ts';

export interface Citation { source_id: string; page_from: number; page_to: number; raw: string; for_row_id?: string }
export interface MasterRow {
  row_id: string; topic_id: string; chapter_id: string; row_class: number; type: string; chapter_role: string; content: string;
  why_it_matters: string | null; misconceptions: string | null; diagram_description: string | null; picture_question: boolean; question_use: string;
  safety: string | null; source: string; found_in: string | null; confidence: string | null; notes: string | null;
  time_sensitive: boolean; time_checked_year: number | null; accuracy_flag: boolean;
  master_file: string; book: string | null; book_chapter_no: number | null; book_chapter_title: string | null; appears_in: string | null; sort: number;
  /** class information (0033): bare labels from the master; also_in_rows parsed strictly from Notes (unfiltered here) */
  topic_classes_mapped: string | null; topic_taught_in: string | null; revisit: string | null; also_in_rows: string[];
  citations: Citation[]; sheet_status: RowStatus | null; sheet: number;
}
export interface MasterQuestion {
  qid: string; topic_id: string; row_class: number; tier: string; sheet_format: string; format: 'MCQ-4' | 'True/False' | 'Typed-time'; text: string; options: string[]; correct: string;
  explanation: string | null; misconception_targeted: string | null; picture_needed: boolean; figure_description: string | null; safety_note: string | null;
  confidence: string | null; notes: string | null; links: { row_id: string; role: 'direct' | 'supporting' }[]; citations: Citation[]; sheet: number; hash: string;
  /** Q34 (Round 2): optional columns. Each is null when blank; option_tags is null when the file has no Tag columns
   *  (so an older master never clears tags set in the CMS). See docs/science-import-format.md. */
  science_question_type?: number | null; setting_id?: string | null; setting_familiarity?: string | null; has_hidden_idea?: boolean | null; has_experiment?: boolean | null;
  option_tags?: ({ tag: string; ref: string | null } | null)[] | null; gold_use?: 'prompt_example' | 'test_only' | null;
  /** Q35: the 5 drivers given in the file (absent = blank = attributes pending) */
  reading?: number; steps?: number; inhibition?: number; visual?: number; has_irrelevant_info?: boolean;
  /** Q35: a bad driver value. The question is HELD (nothing written for it); the other questions still import */
  held_reason?: string;
}
export interface MasterProblem { level: 'error' | 'warning'; where: string; message: string }
/** Notes that mention "also in" but gave no valid row ID, or carried tokens that are not row IDs. */
export interface AlsoInProblem { row_id: string; bad: string[] }
export interface Master { path: string; sha256: string; rows: MasterRow[]; also_in_unparsed?: AlsoInProblem[]; questions: MasterQuestion[]; books: LegendBook[]; sources: ScienceSource[]; problems: MasterProblem[] }

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
  const alsoUnparsed: AlsoInProblem[] = [];
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
    const also = alsoInRows(notes);
    if (also.mentioned && (!also.ids.length || also.bad.length)) alsoUnparsed.push({ row_id, bad: also.bad });
    rows.push({
      row_id, topic_id: str(v['Topic ID']) ?? '', chapter_id: str(v['Master chapter ID']) ?? '', row_class: rowClass, type, chapter_role: str(v['Chapter role']) ?? '',
      content: content ?? '', why_it_matters: str(v['Why it matters / real-life link']), misconceptions: str(v['Common misconceptions']),
      diagram_description: str(v['Diagram description']), picture_question: pic ?? false, question_use: use, safety: str(v.Safety), source: str(v.Source) ?? '',
      found_in: str(v['Found in']), confidence: conf, notes, ...notesFlags(notes), master_file: str(v.File) ?? '', book: str(v.Book),
      book_chapter_no: num(v['Chapter no.']), book_chapter_title: str(v['Chapter title']), appears_in: str(v['Appears in (this chapter)']), sort: i + 1,
      topic_classes_mapped: str(v['Topic class (mapped)']), topic_taught_in: str(v['Topic also taught in']), revisit: str(v.Revisit), also_in_rows: also.ids,
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
    let format: 'MCQ-4' | 'True/False' | 'Typed-time' = 'MCQ-4';
    try { format = storedFormat(sheetFormat, options); } catch (e) { err(where, (e as Error).message); }
    const opts = options.filter((o): o is string => o !== null);
    const idx = 'ABCD'.indexOf(letter);
    // Q27/Q34: the authored tier is retired; a new file may leave Level blank (kept as science_tier_legacy when given)
    if (tier && !(TIERS as readonly string[]).includes(tier)) err(where, `Level "${tier}" is not L1, L2 or L3 (or blank)`);
    // Q36: a Typed-time row gives the time itself in Answer (h:mm; 07:30 is stored 7:30), not an option letter
    const timeAnswer = format === 'Typed-time' ? (parseTime(str(v.Answer)) ? formatTime(parseTime(str(v.Answer))!) : (str(v.Answer) ?? '')) : null;
    if (timeAnswer !== null) for (const m of typedTimeProblems({ correct: timeAnswer }).errors) err(where, m);
    else if (idx < 0 || idx >= opts.length) err(where, `Answer "${letter}" is not one of the options`);
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
    const correct = timeAnswer ?? (opts[idx] ?? '');
    if (format === 'True/False' && !['True', 'False'].includes(correct)) err(where, `a True/False answer must be "True" or "False" (it is "${correct}")`);
    const q: Omit<MasterQuestion, 'hash'> = {
      qid, topic_id: str(v['Topic ID']) ?? '', row_class: rowClass, tier, sheet_format: sheetFormat, format, text: text ?? '', options: opts, correct,
      explanation: str(v.Explanation), misconception_targeted: str(v['Misconception targeted']), picture_needed: pic ?? false, figure_description: fig,
      safety_note: str(v['Safety note']), confidence: str(v.Confidence)?.toLowerCase() ?? null, notes: str(v.Notes), links, citations, sheet: x.row,
    };
    // Q34: the optional columns (only the ones that are set count for the hash, so an older master hashes as before)
    const extra: Partial<MasterQuestion> = {};
    const st = scienceType(v['Science question type']);
    if (Number.isNaN(st)) err(where, `Science question type "${str(v['Science question type'])}" is not 1–5`); else if (st !== null) extra.science_question_type = st;
    const fam = familiarity(v['Setting familiarity']);
    if (fam === undefined) err(where, `Setting familiarity "${str(v['Setting familiarity'])}" is not one of ${FAMILIARITY.join(', ')}`); else if (fam !== null) extra.setting_familiarity = fam;
    const setting = str(v.Setting);
    if (setting && !/^SET[0-9]{3,4}$/.test(setting)) err(where, `Setting "${setting}" is not a SET ID (blank = bare)`); else if (setting) extra.setting_id = setting;
    const hid = yn(v['Hidden idea (Y/N)']), exp = yn(v['Experiment (Y/N)']);
    if (hid !== null) extra.has_hidden_idea = hid;
    if (exp !== null) extra.has_experiment = exp;
    if (['Tag A', 'Tag B', 'Tag C', 'Tag D'].some((c) => c in v)) {
      const tags = (['Tag A', 'Tag B', 'Tag C', 'Tag D'] as const).slice(0, opts.length).map((c) => optionTag(v[c]));
      tags.forEach((t, i) => {
        const L = 'ABCD'[i];
        if (!t) return;
        if (i === idx) err(where, `Tag ${L}: option ${L} is the correct answer; only wrong options take a tag`);
        else if (!t.tag) err(where, `Tag ${L}: "${str(v[`Tag ${L}`])}" is not one of ${WRONG_TAGS.join(', ')}`);
        else if (t.tag === 'misconception' && !/^C\d-[A-Z0-9]+-\d+ #\d+$/.test(t.ref ?? '')) err(where, `Tag ${L}: a misconception names its row item, e.g. "misconception C6-04-014 #2"`);
        else if (t.tag === 'concept_error' && !links.some((l) => l.row_id === t.ref)) err(where, `Tag ${L}: a concept error names one of its content rows, e.g. "concept_error ${links[0]?.row_id ?? 'C6-04-001'}"`);
      });
      if (tags.some((t) => t)) extra.option_tags = tags;
    }
    const gu = goldUse(v['Gold use']);
    if (gu === undefined) err(where, `Gold use "${str(v['Gold use'])}" is not "Prompt example" or "Test only" (blank = production)`); else if (gu !== null) extra.gold_use = gu;
    // Q35: the 5 drivers (same rules as Edit). A bad value holds this question only, with the reason; never imported half-tagged
    const drv = scienceDrivers(v);
    Object.assign(extra, drv.values);
    if (drv.problems.length) {
      extra.held_reason = drv.problems.join('; ');
      warn(where, `held (not imported): ${extra.held_reason}`);
    }
    const { sheet: _s, held_reason: _h, ...hashed } = { ...q, ...extra };
    questions.push({ ...q, ...extra, hash: createHash('sha256').update(stableJson(hashed)).digest('hex') });
  }
  return { path, sha256: wb.sha256, rows, also_in_unparsed: alsoUnparsed, questions, books, sources, problems };
}

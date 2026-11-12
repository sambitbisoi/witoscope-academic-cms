// Originality check (Sambit, 10 Nov 2026): is a question of ours copied from a book?
// It runs ONLY on Sambit's Mac (scripts/check-originality.ts), because the book material
// it compares against (PDF page text, items in local book files) never goes to the cloud.
// Pure: the caller reads the PDFs and book files and passes their text in. The result
// holds citations and scores only, never book text, so it may be stored in the CMS.
import { dice, trigrams } from './generation.ts';
import type { Question } from './types.ts';
import { numbersIn } from './version.ts';

export const ORIGINALITY_TOOL = 'check-originality 3';
/** 1.1 (10 Nov 2026): adds near_copy (blocks the import) and near_copy_threshold.
 *  1.2 (12 Nov 2026): every text field is checked (text, parts, figure description, options,
 *  solutions, hints, wrong-answer notes); each question says which field decided its result. */
export const REPORT_SCHEMA = 'cms-originality/1.2';
/** A field needs this many words for the WORDING test (trigram similarity of a two-word option or a
 *  short hint against a one-line book window means nothing). The numbers rule applies to every field. [guess] */
export const MIN_WORDS = 6;
/** Default near-copy similarity (cms_config originality_near_copy). [guess] */
export const NEAR_COPY_DEFAULT = 0.85;
/** Window sizes, in lines of PDF text, compared with each question. */
const MAX_WINDOW_LINES = 6;

export interface BookPage { source_id: string; pdf_page: number; text: string }
export interface BookItem { ref_id: string; text: string }
export interface OriginalityResult {
  /** near_copy blocks the import; flagged (moderate) is a warning */
  result: 'clear' | 'flagged' | 'near_copy' | 'no_sources';
  similarity: number | null;
  same_numbers: boolean;
  /** a citation only: an item ref_id, or "<source_id> p<pdf page>" */
  closest_ref: string | null;
}

const nums = (s: string) => numbersIn({ s });
/** Numbers in reading order (numbersIn sorts them). */
export const orderedNums = (s: string) => s.match(/\d+(?:[.,/]\d+)*/g) ?? [];
/** `need` appears in `have` in the same order (gaps allowed). */
export function inOrder(have: string[], need: string[]) {
  let i = 0;
  for (const x of have) if (x === need[i]) i++;
  return i === need.length;
}
/** Numbers that make a question recognisable: at least 3, at least one with 2+ digits. [guess] */
export const distinctive = (n: string[]) => n.length >= 3 && n.some((x) => x.replace(/\D/g, '').length >= 2);
/** Every number of `need` appears in `have` (as many times). Both sorted, as numbersIn returns them. */
export function containsAll(have: string[], need: string[]) {
  const left = new Map<string, number>();
  for (const x of have) left.set(x, (left.get(x) ?? 0) + 1);
  for (const x of need) { const c = left.get(x) ?? 0; if (!c) return false; left.set(x, c - 1); }
  return true;
}

/** Pieces of a book page to compare with: 1…6 consecutive non-empty lines. */
export interface Piece { cite: string; text: string; numbers: string[]; ordered: string[]; tri: Map<string, number> }
export function windows(page: BookPage): Piece[] {
  const lines = page.text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out: Piece[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let n = 1; n <= MAX_WINDOW_LINES && i + n <= lines.length; n++) {
      const text = lines.slice(i, i + n).join(' ');
      out.push({ cite: `${page.source_id} p${page.pdf_page}`, text, numbers: nums(text), ordered: orderedNums(text), tri: trigrams(text) });
    }
  }
  return out;
}

export interface Corpus { items: Piece[] }
export const corpus = (pages: BookPage[], items: BookItem[]): Corpus =>
  ({ items: [...items.map((i) => ({ cite: i.ref_id, text: i.text, numbers: nums(i.text), ordered: orderedNums(i.text), tri: trigrams(i.text) })), ...pages.flatMap(windows)] });

/**
 * Sambit, 10 Nov 2026:
 *  - near_copy (blocks the import): wording ≥ nearCopy similar to a piece of a book, or the
 *    question's distinctive numbers all in one piece IN THE SAME ORDER (the same number set in
 *    the same pattern);
 *  - flagged (a warning): wording ≥ threshold similar, or those numbers in one piece in another order;
 *  - clear otherwise. Pieces are 1–6 consecutive lines of a book page, or a local book item.
 */
export function checkText(text: string, c: Corpus, threshold: number, nearCopy = NEAR_COPY_DEFAULT, opts: { wording?: boolean; numbers?: boolean } = {}): OriginalityResult {
  if (!c.items.length) return { result: 'no_sources', similarity: null, same_numbers: false, closest_ref: null };
  const qn = nums(text), qo = orderedNums(text);
  const strong = (opts.numbers ?? true) && distinctive(qn);
  const wording = opts.wording ?? true;
  const qt = trigrams(text);
  let best = { sim: -1, cite: '' }, sameSet: string | null = null, samePattern: string | null = null;
  for (const w of c.items) {
    const sim = wording ? dice(qt, w.tri) : 0;
    if (sim > best.sim) best = { sim, cite: w.cite };
    if (strong && !samePattern && containsAll(w.numbers, qn)) {
      if (inOrder(w.ordered, qo)) samePattern = w.cite;
      else sameSet ??= w.cite;
    }
  }
  const sim = wording ? Math.round(best.sim * 100) / 100 : 0;
  const result = sim >= nearCopy || samePattern ? 'near_copy' : sim >= threshold || sameSet ? 'flagged' : 'clear';
  // cite the piece that decided the result: the wording match, unless the numbers decided it
  const cite = result === 'near_copy' && sim < nearCopy ? samePattern : result === 'flagged' && sim < threshold ? sameSet : best.cite;
  return { result, similarity: sim, same_numbers: (samePattern ?? sameSet) !== null, closest_ref: cite };
}

// ---------------------------------------------------------------- every text field (12 Nov 2026)
export interface FieldText { field: string; text: string }
type Checkable = Pick<Question, 'text' | 'parts' | 'figure' | 'answer' | 'solutions' | 'hints'>;
/** Every text field of a question, labelled (e.g. "figure description", "hint 2", "options (b)"). */
export function questionFields(q: Checkable): FieldText[] {
  // the question text with its parts, exactly as the check has always read it (wording test always on)
  const out: FieldText[] = [{ field: 'text', text: [q.text, ...(q.parts ?? []).map((p) => p.text)].join(' ') }];
  if (q.figure?.description) out.push({ field: 'figure description', text: q.figure.description });
  const answers: [string, Question['answer']][] = [['', q.answer], ...(q.parts ?? []).map((p) => [p.part_label, p.answer] as [string, Question['answer']])];
  for (const [label, a] of answers) {
    const suffix = label ? ` (${label})` : '';
    if (a.options?.length) out.push({ field: `options${suffix}`, text: a.options.join(', ') });
    (a.wrong_answers ?? []).forEach((w, i) => { if (w.why) out.push({ field: `wrong-answer note${suffix} ${i + 1}`, text: w.why }); });
  }
  if (q.solutions?.school) out.push({ field: 'solution', text: q.solutions.school });
  if (q.solutions?.second?.text) out.push({ field: 'second solution', text: q.solutions.second.text });
  (q.hints ?? []).forEach((h, i) => out.push({ field: `hint ${i + 1}`, text: h }));
  return out.filter((f) => f.text && f.text.trim());
}
const RANK = { no_sources: 0, clear: 1, flagged: 2, near_copy: 3 } as const;
export const worse = (a: OriginalityResult, b: OriginalityResult) => RANK[a.result] > RANK[b.result] || (RANK[a.result] === RANK[b.result] && (a.similarity ?? 0) > (b.similarity ?? 0));
export type FieldResult = OriginalityResult & { field: string };
/** Fields where the numbers rule applies (Sambit, 12 Nov 2026, option a): what the child reads. Hints,
 *  solutions and wrong-answer notes repeat the question's numbers and their working, so they get the
 *  wording test only. */
export const NUMBERS_RULE_FIELD = (field: string) => field === 'text' || field === 'figure description' || field.startsWith('options');
/** Check every field; the question's result is its worst field, which is named. Same thresholds as checkText. */
export function checkQuestion(q: Checkable, c: Corpus, threshold: number, nearCopy = NEAR_COPY_DEFAULT): FieldResult & { fields: FieldResult[] } {
  const fields = questionFields(q).map((f) => ({ field: f.field, ...checkText(f.text, c, threshold, nearCopy, { wording: f.field === 'text' || f.text.trim().split(/\s+/).length >= MIN_WORDS, numbers: NUMBERS_RULE_FIELD(f.field) }) }));
  let worst = fields[0]!;
  for (const f of fields) if (worse(f, worst)) worst = f;
  return { ...worst, fields: fields.filter((f) => f.result === 'flagged' || f.result === 'near_copy') };
}

/** The local report written next to a chapter file and read by import:chapter. No book text. */
export interface OriginalityReport {
  file_schema: typeof REPORT_SCHEMA;
  tool: string;
  chapter_file_sha256: string;
  chapter_id: string;
  checked_at: string;
  threshold: number;
  near_copy_threshold: number;
  checked: { source_id: string; pages: string }[];
  missing: string[];
  /** per question: the worst field's result and name, plus every flagged or near-copy field */
  questions: ({ key: string; field?: string; fields?: FieldResult[] } & OriginalityResult)[];
}

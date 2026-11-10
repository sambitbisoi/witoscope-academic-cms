// Originality check (Sambit, 10 Nov 2026): is a question of ours copied from a book?
// It runs ONLY on Sambit's Mac (scripts/check-originality.ts), because the book material
// it compares against (PDF page text, items in local book files) never goes to the cloud.
// Pure: the caller reads the PDFs and book files and passes their text in. The result
// holds citations and scores only, never book text, so it may be stored in the CMS.
import { similarity } from './generation.ts';
import { numbersIn } from './version.ts';

export const ORIGINALITY_TOOL = 'check-originality 1';
export const REPORT_SCHEMA = 'cms-originality/1.0';
/** Window sizes, in lines of PDF text, compared with each question. */
const MAX_WINDOW_LINES = 6;

export interface BookPage { source_id: string; pdf_page: number; text: string }
export interface BookItem { ref_id: string; text: string }
export interface OriginalityResult {
  result: 'clear' | 'flagged' | 'no_sources';
  similarity: number | null;
  same_numbers: boolean;
  /** a citation only: an item ref_id, or "<source_id> p<pdf page>" */
  closest_ref: string | null;
}

const nums = (s: string) => numbersIn({ s });
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
export function windows(page: BookPage): { cite: string; text: string; numbers: string[] }[] {
  const lines = page.text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out: { cite: string; text: string; numbers: string[] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let n = 1; n <= MAX_WINDOW_LINES && i + n <= lines.length; n++) {
      const text = lines.slice(i, i + n).join(' ');
      out.push({ cite: `${page.source_id} p${page.pdf_page}`, text, numbers: nums(text) });
    }
  }
  return out;
}

export interface Corpus { items: { cite: string; text: string; numbers: string[] }[] }
export const corpus = (pages: BookPage[], items: BookItem[]): Corpus =>
  ({ items: [...items.map((i) => ({ cite: i.ref_id, text: i.text, numbers: nums(i.text) })), ...pages.flatMap(windows)] });

/** Flag a question whose wording is ≥ threshold similar to a piece of a book, or whose distinctive numbers all appear in one piece. */
export function checkText(text: string, c: Corpus, threshold: number): OriginalityResult {
  if (!c.items.length) return { result: 'no_sources', similarity: null, same_numbers: false, closest_ref: null };
  const qn = nums(text);
  const strong = distinctive(qn);
  let best = { sim: -1, cite: '' }, numHit: string | null = null;
  for (const w of c.items) {
    const sim = similarity(text, w.text);
    if (sim > best.sim) best = { sim, cite: w.cite };
    if (strong && !numHit && containsAll(w.numbers, qn)) numHit = w.cite;
  }
  const sim = Math.round(best.sim * 100) / 100;
  const flagged = sim >= threshold || numHit !== null;
  return { result: flagged ? 'flagged' : 'clear', similarity: sim, same_numbers: numHit !== null,
    closest_ref: numHit && sim < threshold ? numHit : best.cite };
}

/** The local report written next to a chapter file and read by import:chapter. No book text. */
export interface OriginalityReport {
  file_schema: typeof REPORT_SCHEMA;
  tool: string;
  chapter_file_sha256: string;
  chapter_id: string;
  checked_at: string;
  threshold: number;
  checked: { source_id: string; pages: string }[];
  missing: string[];
  questions: ({ key: string } & OriginalityResult)[];
}

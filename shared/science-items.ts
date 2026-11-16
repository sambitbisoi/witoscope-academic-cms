// Science misconception items and primary rows (Sambit, 16 Nov 2026; docs/plan-2026-11-16-q11-q18.md Q16 Q17 Q18).
// Pure functions, no I/O: used by import:science, science:rationalise and the web app. Content rows are our own words.

/** A reviewed split decision for one row (scripts/lib/science-splits.json). It applies only while the row's text is unchanged. */
export interface SplitDecision { text: string; action: 'split' | 'whole' | 'items'; items?: string[]; unclear?: boolean; note: string }
export interface SplitResult { items: string[]; unclear: boolean; note: string; rule: 'single' | 'sentences' | 'or' | 'decision' | 'kept-semicolon' | 'kept-correction' }

/** One item's text: trimmed, single spaces, leading "or," dropped, capital first letter, ends with a full stop. */
export function tidyItem(s: string): string {
  let t = s.replace(/\s+/g, ' ').trim().replace(/^or,?\s+/i, '');
  if (!t) return t;
  t = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?)]$/.test(t) ? t : `${t}.`;
}

/** "; in fact …" or a bracket of 4+ words / starting "Most|Not|Only|But|Actually" is a correction; "(steam)", "(hibernate)" are glosses */
const CORRECTION = /;\s*(in fact|actually|but really|really)\b|\((?:(?:most|not|only|but|actually|in fact)\b[^)]*|[^)\s]+(?:\s+[^)\s]+){3,})\)/i;
/** "J.C." / "e.g." / "St." — a full stop that does not end a sentence */
const ABBREV = /(\b[A-Z]\.|\be\.g\.|\bi\.e\.|\betc\.|\bSt\.|\bDr\.|\bMr\.|\bMrs\.)$/;

function sentences(t: string): string[] {
  const raw = t.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const out: string[] = [];
  for (const p of raw) {
    if (out.length && ABBREV.test(out[out.length - 1]!)) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}

/**
 * A row's "Common misconceptions" text → numbered items.
 * Rules: sentences are split; "; or," gives two items; a plain ";" is kept whole and marked unclear (one idea
 * or two? a reviewed decision settles it); a text that holds a correction ("; in fact …", brackets) is kept
 * whole and marked unclear. A reviewed decision for the same text wins.
 */
export function splitMisconceptions(text: string, decision?: SplitDecision | null): SplitResult {
  const t = text.replace(/\s+/g, ' ').trim();
  if (decision && decision.text.replace(/\s+/g, ' ').trim() === t) {
    const items = decision.action === 'items' ? decision.items ?? []
      : decision.action === 'whole' ? [t]
      : sentences(t).flatMap((s) => s.split(/;\s*(?:or,?\s+)?/i));
    return { items: items.map(tidyItem).filter(Boolean), unclear: !!decision.unclear, note: decision.note, rule: 'decision' };
  }
  if (CORRECTION.test(t)) return { items: [tidyItem(t)], unclear: true, note: 'holds a correction; kept whole', rule: 'kept-correction' };
  const parts = sentences(t).flatMap((s) => s.split(/;\s*or,?\s+/i));
  const rule: SplitResult['rule'] = parts.length === 1 ? 'single' : /;\s*or,?\s+/i.test(t) ? 'or' : 'sentences';
  const semicolon = parts.some((p) => p.includes(';'));
  return {
    items: parts.map(tidyItem).filter(Boolean),
    unclear: semicolon,
    note: semicolon ? '";" kept whole: one idea or two?' : parts.length === 1 ? 'one misconception' : `split: ${rule === 'or' ? '"; or,"' : 'sentences'}`,
    rule: semicolon && parts.length === 1 ? 'kept-semicolon' : rule,
  };
}

// ---------------------------------------------------------------- matching text to items
export const normText = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9°]+/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'and', 'in', 'on', 'it', 'is', 'are', 'be', 'that', 'this', 'its', 'as', 'at', 'by', 'for', 'with']);
/** plural / verb "s" dropped (magnets → magnet, attracts → attract), so near-identical wordings compare equal */
const stem = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
export const words = (s: string) => new Set(normText(s).split(' ').filter((w) => w && !STOP.has(w)).map(stem));
/** 0…1: word overlap (Dice, on stemmed words); 0.9 when one text holds the other whole (at least 3 words). */
export function similarity(a: string, b: string): number {
  const na = normText(a), nb = normText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const [s, l] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (s.split(' ').length >= 3 && ` ${l} `.includes(` ${s} `)) return 0.9;
  const A = words(a), B = words(b);
  const inter = [...A].filter((w) => B.has(w)).length;
  return (2 * inter) / (A.size + B.size || 1);
}

export interface ItemRef { row_id: string; item_no: number }
export interface Item extends ItemRef { text: string; status?: string }
export const itemRef = (i: ItemRef) => `${i.row_id} #${i.item_no}`;
export const parseItemRef = (s: string): ItemRef | null => { const m = /^(C[1-6]-[0-9A-Z]{2,4}-[0-9]{3})\s*#\s*([0-9]{1,2})$/.exec(s.trim()); return m ? { row_id: m[1]!, item_no: Number(m[2]) } : null; };

export type MatchKind = 'exact' | 'fuzzy' | 'ambiguous' | 'none';
export interface Match { kind: MatchKind; best: Item | null; candidates: { item: Item; score: number }[] }
export const FUZZY = 0.7, CANDIDATE = 0.5;

/**
 * A question's misconception text → one item. Items come in preference order (primary row first, then the
 * other direct rows, then supporting rows), so an identical text on two rows goes to the first.
 * exact: same text (after normalising) · fuzzy: one item ≥ 0.7 and clearly ahead · ambiguous: candidates ≥ 0.5
 * but none clearly ahead (the best one is proposed) · none.
 */
export function matchItem(text: string, items: Item[]): Match {
  const ref = parseItemRef(text);
  if (ref) { const it = items.find((i) => i.row_id === ref.row_id && i.item_no === ref.item_no); if (it) return { kind: 'exact', best: it, candidates: [{ item: it, score: 1 }] }; }
  const n = normText(text);
  const exact = items.find((i) => normText(i.text) === n);
  if (exact) return { kind: 'exact', best: exact, candidates: [{ item: exact, score: 1 }] };
  const scored = items.map((item) => ({ item, score: similarity(text, item.text) })).filter((c) => c.score >= CANDIDATE)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { kind: 'none', best: null, candidates: [] };
  const [top, second] = scored;
  if (top!.score >= FUZZY && (!second || top!.score - second.score >= 0.2)) return { kind: 'fuzzy', best: top!.item, candidates: scored.slice(0, 3) };
  return { kind: 'ambiguous', best: top!.item, candidates: scored.slice(0, 3) };
}

/** A wrong option whose own text states an item of the linked rows (exact or one clear fuzzy match); else null. */
export function optionItem(option: string, items: Item[]): Item | null {
  if (normText(option).split(' ').length < 3) return items.find((i) => normText(i.text) === normText(option)) ?? null;
  const m = matchItem(option, items);
  return m.kind === 'exact' || m.kind === 'fuzzy' ? m.best : null;
}

// ---------------------------------------------------------------- primary row
export interface DirectRow { row_id: string; content: string; sort: number }
/** The proposed primary among several direct rows: the row that holds the question's misconception item; else the
 *  row whose content is closest to the question and its answer; ties go to master order. */
export function proposePrimary(rows: DirectRow[], q: { text: string; correct: string }, misconceptionRow: string | null): { row_id: string; reason: string } {
  if (rows.length === 1) return { row_id: rows[0]!.row_id, reason: 'only direct row' };
  if (misconceptionRow && rows.some((r) => r.row_id === misconceptionRow)) return { row_id: misconceptionRow, reason: 'holds the question\'s misconception item' };
  const qText = `${q.text} ${q.correct}`;
  const scored = rows.map((r) => ({ r, s: similarity(qText, r.content) })).sort((a, b) => b.s - a.s || a.r.sort - b.r.sort);
  const [top, second] = scored;
  return { row_id: top!.r.row_id, reason: `closest wording to the question and answer (${top!.s.toFixed(2)}${second ? ` vs ${second.s.toFixed(2)} for ${second.r.row_id}` : ''})` };
}

// ---------------------------------------------------------------- Solution 1 (Q18)
export const SHORT_SOLUTION = 60;
/** Does Solution 1 say anything about a wrong option (its text, its letter, or "… is wrong / not")? */
export function mentionsWrongOption(solution: string, wrongOptions: { text: string; position: number }[]): boolean {
  const s = normText(solution);
  if (/\boption [a-d]\b|\([a-d]\)/i.test(solution) || /\b[A-D]\b (is|are) (wrong|incorrect|not)\b/.test(solution)) return true;
  return wrongOptions.some((o) => { const n = normText(o.text); return n.length >= 3 && !['true', 'false', 'yes', 'no'].includes(n) && ` ${s} `.includes(` ${n} `); });
}
/** The in-app "unsupported sentence" check (a sentence of Solution 1 that the linked rows don't support) needs the
 *  Claude API key, which the CMS doesn't have yet. Hook only: it reports "not available". */
export const checkSolutionSupport = (_solution: string, _rows: string[]): { available: false; note: string } =>
  ({ available: false, note: 'Row-support check: not available yet (needs the API key).' });

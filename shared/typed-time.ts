// Q36 (18 Nov 2026): the Typed-time answer format.
// The child sees two boxes, hh : mm, with the colon printed; no a.m./p.m. is typed (a.m./p.m. may stay in the question).
// The answer is stored as h:mm (hours without a leading zero, minutes always two digits, e.g. 7:30, 11:05).
// A child's answer is checked numerically per box: 3 = 03 in the hours box, 5 = 05 in the minutes box.
// Hours 0–23 and minutes 0–59 are allowed (most clock questions use 1–12).

export interface TimeParts { h: number; m: number }

const STORED = /^(\d{1,2}):(\d{2})$/;

/** A time written h:mm or hh:mm (as stored, or in an "also accepted" list); null when it isn't one. */
export function parseTime(s: string | null | undefined): TimeParts | null {
  const x = STORED.exec((s ?? '').trim());
  if (!x) return null;
  const h = Number(x[1]), m = Number(x[2]);
  return h <= 23 && m <= 59 ? { h, m } : null;
}

/** The stored form h:mm. */
export const formatTime = (t: TimeParts) => `${t.h}:${String(t.m).padStart(2, '0')}`;

/** The two boxes as the child typed them; each box holds digits only (1–2). null when a box is empty or not a number. */
export function boxesToTime(hh: string, mm: string): TimeParts | null {
  if (!/^\d{1,2}$/.test(hh.trim()) || !/^\d{1,2}$/.test(mm.trim())) return null;
  const h = Number(hh), m = Number(mm);
  return h <= 23 && m <= 59 ? { h, m } : null;
}

/** Is the child's answer (two boxes) right? Checked numerically per box against the stored answer and the accepted list. */
export function typedTimeMatches(hh: string, mm: string, correct: string, accepted: string[] = []): boolean {
  const t = boxesToTime(hh, mm);
  if (!t) return false;
  return [correct, ...accepted].some((a) => { const r = parseTime(a); return !!r && r.h === t.h && r.m === t.m; });
}

/** The two boxes for a stored answer (for the preview): hours as stored, minutes two digits. */
export function timeBoxes(s: string): [string, string] {
  const t = parseTime(s);
  return t ? [String(t.h), String(t.m).padStart(2, '0')] : ['', ''];
}

/** Problems with a Typed-time answer: errors and warnings (messages only). */
export function typedTimeProblems(a: { correct: string; accepted?: string[]; options?: string[]; wrong_answers?: { value: string }[] }): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  const c = (a.correct ?? '').trim();
  const t = parseTime(c);
  if (!c) errors.push('the correct answer is empty');
  else if (/[ap]\.?\s*m\.?\s*$/i.test(c)) errors.push(`Typed-time answer "${c}": no a.m./p.m. in the answer (store h:mm, e.g. 7:30)`);
  else if (!t) errors.push(`Typed-time answer "${c}" is not a time h:mm (e.g. 7:30; hours 0–23, minutes 00–59; no a.m./p.m.)`);
  else if (formatTime(t) !== c) errors.push(`Typed-time answer "${c}" must be stored as ${formatTime(t)} (h:mm, no leading zero on the hours)`);
  for (const x of a.accepted ?? []) if (!parseTime(x)) errors.push(`accepted answer "${x}" is not a time h:mm`);
  for (const w of a.wrong_answers ?? []) if (!parseTime(w.value)) warnings.push(`wrong answer "${w.value}" is not a time h:mm`);
  if (a.options?.length) warnings.push('Typed-time has options; they are ignored');
  return { errors, warnings };
}

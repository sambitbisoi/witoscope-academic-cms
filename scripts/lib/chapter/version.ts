// Same version vs new version (design §3, decision 6).
//
// A question is split into
//   - structure: everything except free text, with each text replaced by a
//     placeholder so the SHAPE (how many hints, whether there is a figure or a
//     second solution) still counts; plus topic / set / pattern / class override.
//   - texts: the free-text fields, by path.
// Equal structure + equal texts           → unchanged
// Equal structure + same numbers in texts → typo (same version, logged)
// Anything else                           → new version
import { createHash } from 'node:crypto';
import { stableJson } from '../topics.ts';
import type { Question } from './types.ts';

const T = '§text';
export type Texts = Record<string, string>;

export function structureOf(q: Question, topicId: string): unknown {
  const blankWhy = (a: Question['answer']) => ({ ...a, wrong_answers: (a.wrong_answers ?? []).map((w) => ({ ...w, why: w.why === undefined ? undefined : T })) });
  const { key: _k, question_id: _q, text: _t, placement_note, author_notes, tagging, figure, solutions, hints, parts, answer, topic_id: _tp, ...rest } = q;
  return {
    ...rest,
    topic_id: topicId,
    placement_note: placement_note === undefined ? undefined : T,
    author_notes: author_notes === undefined ? undefined : T,
    figure: figure && { ...figure, description: T },
    solutions: { school: T, second: solutions.second && { ...solutions.second, text: T } },
    hints: hints.map(() => T),
    answer: blankWhy(answer),
    parts: parts?.map((p) => ({ ...p, text: T, answer: blankWhy(p.answer) })),
    tagging: tagging && {
      tagged_by: tagging.tagged_by,
      why: tagging.why && Object.fromEntries(Object.entries(tagging.why).map(([a, w]) => [a, { why: T, confidence: w.confidence }])),
      summary: tagging.summary === undefined ? undefined : T,
    },
  };
}

export const structureHash = (q: Question, topicId: string) =>
  createHash('sha256').update(stableJson(structureOf(q, topicId))).digest('hex');

export function textsOf(q: Question): Texts {
  const t: Texts = { text: q.text, 'solution.1': q.solutions.school };
  if (q.figure) t['figure.description'] = q.figure.description;
  if (q.solutions.second) t['solution.2'] = q.solutions.second.text;
  q.hints.forEach((h, i) => (t[`hint.${i + 1}`] = h));
  const wrong = (label: string, a: Question['answer']) => (a.wrong_answers ?? []).forEach((w) => { if (w.why !== undefined) t[`wrong.${label}.${w.value}`] = w.why; });
  wrong('', q.answer);
  for (const p of q.parts ?? []) { t[`part.${p.part_label}.text`] = p.text; wrong(p.part_label, p.answer); }
  for (const [a, w] of Object.entries(q.tagging?.why ?? {})) t[`why.${a}`] = w.why;
  if (q.tagging?.summary !== undefined) t['tagging.summary'] = q.tagging.summary;
  if (q.author_notes !== undefined) t.author_notes = q.author_notes;
  if (q.placement_note !== undefined) t.placement_note = q.placement_note;
  return t;
}

/** Numbers as written (12, 3.5, 7/12, 1,000), as a sorted multiset. */
export const numbersIn = (texts: Texts) =>
  Object.values(texts).flatMap((s) => s.match(/\d+(?:[.,/]\d+)*/g) ?? []).sort();

export type Change =
  | { kind: 'unchanged' }
  | { kind: 'typo'; diff: Record<string, { before: string | null; after: string | null }> }
  | { kind: 'new'; reason: string };

export function classify(prev: { structureHash: string; texts: Texts }, next: { structureHash: string; texts: Texts }, forceNew = false): Change {
  const diff: Record<string, { before: string | null; after: string | null }> = {};
  for (const k of new Set([...Object.keys(prev.texts), ...Object.keys(next.texts)])) {
    if ((prev.texts[k] ?? null) !== (next.texts[k] ?? null)) diff[k] = { before: prev.texts[k] ?? null, after: next.texts[k] ?? null };
  }
  const sameStructure = prev.structureHash === next.structureHash;
  if (sameStructure && !Object.keys(diff).length) return { kind: 'unchanged' };
  if (forceNew) return { kind: 'new', reason: '--force-new-version' };
  if (!sameStructure) return { kind: 'new', reason: 'numbers, options, answers, format, parts, concepts, tags, signature, topic / set / pattern or image changed' };
  if (stableJson(numbersIn(prev.texts)) !== stableJson(numbersIn(next.texts))) return { kind: 'new', reason: `a number in the wording changed (${Object.keys(diff).join(', ')})` };
  return { kind: 'typo', diff };
}

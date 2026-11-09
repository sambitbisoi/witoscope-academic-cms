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
import { stableJson } from './json.ts';
import { sha256Hex } from './sha256.ts';
import type { Answer, ConceptRef, Question } from './types.ts';

const T = '§text';
export type Texts = Record<string, string>;

/**
 * Canonical structure: identical whether the question comes from a chapter file or is
 * rebuilt from database rows (shared/fromDb.ts). Absent and empty lists are the same,
 * numbers are numbers, unordered lists are sorted, every key is always present, and
 * each free text is a placeholder (only its presence counts).
 */
const t = (x: string | null | undefined) => (x === undefined || x === null || x === '' ? null : T);
const canonConcepts = (cs: ConceptRef[] | undefined) =>
  [...(cs ?? [])].map((c) => ({ concept_id: c.concept_id, involvement: Number(c.involvement) })).sort((a, b) => a.concept_id.localeCompare(b.concept_id));
const canonAnswer = (a: Answer) => ({
  format: a.format,
  options: a.options ?? [],
  correct: a.format === 'Multi-part' ? null : (a.correct ?? null),
  accepted: a.accepted ?? [],
  wrong_answers: [...(a.wrong_answers ?? [])]
    .map((w) => ({ value: w.value, tag: w.tag, misconception_id: w.misconception_id ?? null, target_concept_id: w.target_concept_id ?? null, why: t(w.why) }))
    .sort((x, y) => x.value.localeCompare(y.value)),
});

export function structureOf(q: Question, topicId: string): unknown {
  const s = q.signature;
  return {
    topic_id: topicId,
    typical_set_id: q.typical_set_id ?? null,
    pattern_id: q.pattern_id ?? null,
    clone_batch_id: q.clone_batch_id ?? null,
    locale: q.locale ?? 'IN',
    class_override: q.class_override ?? null,
    placement_note: t(q.placement_note),
    figure: q.figure ? { description: T, image_status: q.figure.image_status, image_file: q.figure.image_file ?? null } : null,
    answer: canonAnswer(q.answer),
    parts: [...(q.parts ?? [])].map((p) => ({ part_label: p.part_label, text: T, answer: canonAnswer(p.answer), concepts: canonConcepts(p.concepts) }))
      .sort((a, b) => a.part_label.localeCompare(b.part_label)),
    concepts: canonConcepts(q.concepts),
    signature: {
      math_difficulty: s.math_difficulty, is_pure_fact: s.is_pure_fact, reading: Number(s.reading), has_irrelevant_info: s.has_irrelevant_info,
      steps: Number(s.steps), working_memory: Number(s.working_memory), inhibition: Number(s.inhibition), visual: Number(s.visual), strategy: Number(s.strategy),
      strategy_type: s.strategy_type ?? null, strategy_type_2: s.strategy_type_2 ?? null, strategy_other_note: t(s.strategy_other_note),
      insight_id: s.insight_id ?? null, proposed_insight: s.proposed_insight ? stableJson(s.proposed_insight) : null, trick_ref: s.trick_ref ?? null,
    },
    duration_s: q.duration_s ?? null,
    solutions: { school: T, second: q.solutions.second ? { text: T, type: q.solutions.second.type, strategy: q.solutions.second.strategy ?? null } : null },
    hints: q.hints.map(() => T),
    source_refs: [...(q.source_refs ?? [])].map((r) => `${r.ref_id}|${r.relation}`).sort(),
    tagging: {
      tagged_by: q.tagging?.tagged_by ?? null,
      why: Object.keys(q.tagging?.why ?? {}).sort().map((k) => `${k}|${q.tagging!.why![k]!.confidence}`),
      summary: t(q.tagging?.summary),
    },
    author_notes: t(q.author_notes),
  };
}

export const structureHash = (q: Question, topicId: string) => sha256Hex(stableJson(structureOf(q, topicId)));

export function textsOf(q: Question): Texts {
  const t: Texts = {};
  const put = (k: string, v: string | null | undefined) => { if (v !== undefined && v !== null && v !== '') t[k] = v; };
  put('text', q.text);
  put('solution.1', q.solutions.school);
  if (q.figure) put('figure.description', q.figure.description);
  if (q.solutions.second) put('solution.2', q.solutions.second.text);
  q.hints.forEach((h, i) => put(`hint.${i + 1}`, h));
  const wrong = (label: string, a: Question['answer']) => (a.wrong_answers ?? []).forEach((w) => put(`wrong.${label}.${w.value}`, w.why));
  wrong('', q.answer);
  for (const p of q.parts ?? []) { put(`part.${p.part_label}.text`, p.text); wrong(p.part_label, p.answer); }
  for (const [a, w] of Object.entries(q.tagging?.why ?? {})) put(`why.${a}`, w.why);
  put('tagging.summary', q.tagging?.summary);
  put('author_notes', q.author_notes);
  put('placement_note', q.placement_note);
  put('signature.strategy_other_note', q.signature.strategy_other_note);
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

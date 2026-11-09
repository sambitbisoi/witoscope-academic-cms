import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { questionFromDb, type DbBundle } from '../shared/fromDb.ts';
import { sha256Hex } from '../shared/sha256.ts';
import type { ChapterFile, Question } from '../shared/types.ts';
import { classify, structureHash, textsOf } from '../shared/version.ts';

const q0 = (): Question => structuredClone((JSON.parse(readFileSync('content/examples/MC19-example.json', 'utf8')) as ChapterFile).questions[0]!);

/** What the database holds for a question, the way the importer writes it. */
function toDb(q: Question): DbBundle {
  const ans = (label: string, a: Question['answer']) => ({
    options: (a.options ?? []).map((text, i) => ({ part_label: label, position: i + 1, text, is_correct: text === a.correct })),
    wrong: (a.wrong_answers ?? []).map((w) => ({ part_label: label, value: w.value, tag: w.tag, misconception_id: w.misconception_id ?? null, target_concept_id: w.target_concept_id ?? null, why: w.why ?? null })),
  });
  const top = ans('', q.answer);
  const parts = (q.parts ?? []).map((p) => ({ p, a: ans(p.part_label, p.answer) }));
  const s = q.signature;
  return {
    question: { question_id: 'MQ000001', file_key: q.key, topic_id: q.topic_id, typical_set_id: q.typical_set_id, pattern_id: q.pattern_id ?? null,
      clone_batch_id: q.clone_batch_id, locale: q.locale, class_override: q.class_override ?? null, placement_note: q.placement_note ?? null },
    version: { topic_id: q.topic_id, typical_set_id: q.typical_set_id, pattern_id: q.pattern_id ?? null, text: q.text,
      figure_description: q.figure?.description ?? null, image_status: q.figure?.image_status ?? null, image_path: q.figure?.image_file ?? null,
      format: q.answer.format, correct: q.answer.format === 'Multi-part' ? null : q.answer.correct, accepted: q.answer.accepted ?? [], duration_s: q.duration_s,
      math_difficulty: s.math_difficulty, is_pure_fact: s.is_pure_fact, reading: s.reading, has_irrelevant_info: s.has_irrelevant_info, steps: s.steps,
      working_memory: s.working_memory, inhibition: s.inhibition, visual: s.visual, strategy: s.strategy, strategy_type: s.strategy_type ?? null,
      strategy_type_2: s.strategy_type_2 ?? null, strategy_other_note: s.strategy_other_note ?? null, insight_id: s.insight_id ?? null,
      proposed_insight: null, trick_ref: s.trick_ref ?? null, tagging_why: q.tagging?.why ?? null, tagged_by: q.tagging?.tagged_by ?? null,
      tagging_summary: q.tagging?.summary ?? null, author_notes: q.author_notes ?? null },
    parts: parts.map(({ p }) => ({ part_label: p.part_label, text: p.text, format: p.answer.format, correct: p.answer.correct, accepted: p.answer.accepted ?? [] })),
    options: [...top.options, ...parts.flatMap((x) => x.a.options)],
    // the database returns wrong answers and concepts in its own order, and involvement as "1.0"
    wrong: [...top.wrong, ...parts.flatMap((x) => x.a.wrong)].reverse(),
    concepts: [...q.concepts.map((c) => ({ part_label: '', concept_id: c.concept_id, involvement: c.involvement.toFixed(1) })),
      ...(q.parts ?? []).flatMap((p) => p.concepts.map((c) => ({ part_label: p.part_label, concept_id: c.concept_id, involvement: c.involvement.toFixed(1) })))].reverse(),
    solutions: [{ slot: 1, text: q.solutions.school, type: null, strategy: null },
      ...(q.solutions.second ? [{ slot: 2, text: q.solutions.second.text, type: q.solutions.second.type, strategy: q.solutions.second.strategy ?? null }] : [])],
    hints: q.hints.map((text, i) => ({ level: i + 1, text })),
    refs: (q.source_refs ?? []).map((r) => ({ ref_id: r.ref_id, relation: r.relation })),
  };
}

describe('sha256 (shared, browser-safe)', () => {
  it.each(['', 'abc', 'é ₹ 2¾ − 1⅚', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'q'.repeat(1000)])('matches node:crypto for %#', (s) => {
    expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
  });
});

describe('file ↔ database: same structure, same texts', () => {
  it('the worked example survives the round trip unchanged', () => {
    const q = q0(); const back = questionFromDb(toDb(q));
    expect(structureHash(back, back.topic_id)).toBe(structureHash(q, q.topic_id));
    expect(textsOf(back)).toEqual(textsOf(q));
    expect(classify({ structureHash: structureHash(q, q.topic_id), texts: textsOf(q) }, { structureHash: structureHash(back, back.topic_id), texts: textsOf(back) }).kind).toBe('unchanged');
  });

  it('a Multi-part question survives too', () => {
    const q = q0(); const part = (label: string) => ({ part_label: label, text: `(${label}) part`, answer: { ...structuredClone(q.answer) }, concepts: q.concepts });
    q.answer = { format: 'Multi-part', correct: '' }; q.parts = [part('b'), part('a')];
    const back = questionFromDb(toDb(q));
    expect(structureHash(back, back.topic_id)).toBe(structureHash(q, q.topic_id));
    expect(textsOf(back)).toEqual(textsOf(q));
  });

  it('representation differences are not changes; real ones are', () => {
    const q = q0(); const h = (x: Question) => structureHash(x, x.topic_id);
    const noAccepted = q0(); delete noAccepted.answer.accepted;
    const emptyAccepted = q0(); emptyAccepted.answer.accepted = [];
    expect(h(noAccepted)).toBe(h(emptyAccepted));
    const reordered = q0(); reordered.answer.wrong_answers!.reverse();
    expect(h(reordered)).toBe(h(q));
    const moved = q0(); moved.answer.options = [...moved.answer.options!].reverse();
    expect(h(moved)).not.toBe(h(q)); // option order is what the child sees
    const newHint = q0(); newHint.hints.push('Check.');
    expect(h(newHint)).not.toBe(h(q));
  });
});

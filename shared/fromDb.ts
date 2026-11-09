// Rebuild a question (chapter-file shape) from its database rows, so the editor,
// the importer and the tests compare like with like (see structureOf in version.ts).
import type { Answer, Question, WrongAnswer } from './types.ts';

export interface DbQuestion {
  question_id: string; file_key: string | null; topic_id: string; typical_set_id: string | null; pattern_id: string | null;
  clone_batch_id: string | null; locale: string; class_override: number | null; placement_note: string | null;
}
export interface DbVersion {
  topic_id: string | null; typical_set_id: string | null; pattern_id: string | null;
  text: string; figure_description: string | null; image_status: string | null; image_path: string | null;
  format: string; correct: string | null; accepted: string[] | null; duration_s: number | null;
  math_difficulty: string | null; is_pure_fact: boolean | null; reading: number | null; has_irrelevant_info: boolean | null; steps: number | null;
  working_memory: number | null; inhibition: number | null; visual: number | null; strategy: number | null;
  strategy_type: string | null; strategy_type_2: string | null; strategy_other_note: string | null; insight_id: string | null;
  proposed_insight: Record<string, string> | null; trick_ref: string | null;
  tagging_why: Record<string, { why: string; confidence: 'high' | 'medium' | 'low' }> | null; tagged_by: string | null;
  tagging_summary: string | null; author_notes: string | null;
}
export interface DbBundle {
  question: DbQuestion; version: DbVersion;
  parts: { part_label: string; text: string; format: string; correct: string; accepted: string[] | null }[];
  options: { part_label: string; position: number; text: string; is_correct: boolean }[];
  wrong: { part_label: string; value: string; tag: string; misconception_id: string | null; target_concept_id: string | null; why: string | null }[];
  concepts: { part_label: string; concept_id: string; involvement: number | string }[];
  solutions: { slot: number; text: string; type: string | null; strategy: string | null }[];
  hints: { level: number; text: string }[];
  refs: { ref_id: string; relation: string }[];
}

const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);

export function questionFromDb(b: DbBundle): Question {
  const v = b.version, q = b.question;
  const answerFor = (label: string, format: string, correct: string | null, accepted: string[] | null): Answer => {
    const options = b.options.filter((o) => o.part_label === label).sort((x, y) => x.position - y.position).map((o) => o.text);
    const wrong: WrongAnswer[] = b.wrong.filter((w) => w.part_label === label).map((w) => ({
      value: w.value, tag: w.tag as WrongAnswer['tag'],
      ...(w.misconception_id ? { misconception_id: w.misconception_id } : {}),
      ...(w.target_concept_id ? { target_concept_id: w.target_concept_id } : {}),
      ...(w.why !== null ? { why: w.why } : {}),
    }));
    return { format: format as Answer['format'], ...(options.length ? { options } : {}), correct: correct ?? '', accepted: accepted ?? [], wrong_answers: wrong };
  };
  const conceptsFor = (label: string) => b.concepts.filter((c) => c.part_label === label)
    .map((c) => ({ concept_id: c.concept_id, involvement: Number(c.involvement) as 1 | 0.5 | 0.2 }));
  const s1 = b.solutions.find((s) => s.slot === 1);
  const s2 = b.solutions.find((s) => s.slot === 2);
  const signature = {
    math_difficulty: v.math_difficulty as Question['signature']['math_difficulty'], is_pure_fact: !!v.is_pure_fact, reading: Number(v.reading),
    has_irrelevant_info: !!v.has_irrelevant_info, steps: Number(v.steps), working_memory: Number(v.working_memory), inhibition: Number(v.inhibition),
    visual: Number(v.visual), strategy: Number(v.strategy),
    ...(v.strategy_type ? { strategy_type: v.strategy_type } : {}), ...(v.strategy_type_2 ? { strategy_type_2: v.strategy_type_2 } : {}),
    ...(v.strategy_other_note ? { strategy_other_note: v.strategy_other_note } : {}), ...(v.insight_id ? { insight_id: v.insight_id } : {}),
    ...(v.proposed_insight ? { proposed_insight: v.proposed_insight } : {}), ...(v.trick_ref ? { trick_ref: v.trick_ref } : {}),
  };
  return {
    key: q.file_key ?? q.question_id,
    topic_id: v.topic_id ?? q.topic_id,
    typical_set_id: (v.typical_set_id ?? q.typical_set_id) as string,
    ...(opt(v.pattern_id ?? q.pattern_id) ? { pattern_id: (v.pattern_id ?? q.pattern_id)! } : {}),
    clone_batch_id: q.clone_batch_id ?? '',
    locale: (q.locale ?? 'IN') as 'IN',
    ...(q.class_override ? { class_override: q.class_override } : {}),
    ...(q.placement_note ? { placement_note: q.placement_note } : {}),
    text: v.text,
    ...(v.figure_description !== null ? { figure: { description: v.figure_description, image_status: (v.image_status ?? 'needs_image') as 'needs_image', ...(v.image_path ? { image_file: v.image_path } : {}) } } : {}),
    answer: answerFor('', v.format, v.format === 'Multi-part' ? '' : v.correct, v.accepted),
    ...(b.parts.length ? { parts: [...b.parts].sort((x, y) => x.part_label.localeCompare(y.part_label)).map((p) => ({
      part_label: p.part_label, text: p.text, answer: answerFor(p.part_label, p.format, p.correct, p.accepted), concepts: conceptsFor(p.part_label),
    })) } : {}),
    concepts: conceptsFor(''),
    signature,
    duration_s: v.duration_s as Question['duration_s'],
    solutions: { school: s1?.text ?? '', ...(s2 ? { second: { text: s2.text, type: s2.type as 'Smarter way', ...(s2.strategy ? { strategy: s2.strategy } : {}) } } : {}) },
    hints: [...b.hints].sort((x, y) => x.level - y.level).map((h) => h.text),
    ...(b.refs.length ? { source_refs: b.refs.map((r) => ({ ref_id: r.ref_id, relation: r.relation as 'modelled_on' })) } : {}),
    tagging: { ...(v.tagged_by ? { tagged_by: v.tagged_by as 'human' } : {}), ...(v.tagging_why ? { why: v.tagging_why } : {}), ...(v.tagging_summary ? { summary: v.tagging_summary } : {}) },
    ...(v.author_notes ? { author_notes: v.author_notes } : {}),
  };
}

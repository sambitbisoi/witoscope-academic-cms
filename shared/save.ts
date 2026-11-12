// The save, computed in the browser (E1, 9 Nov 2026): same or new version, the diff,
// derived fields and the exact payload for cms.cms_apply_save. The SQL function only
// applies it and enforces the hard rules.
import { derive } from './derive.ts';
import type { Answer, DerivedConfig, Question } from './types.ts';
import { classify, structureHash, textsOf, structureOf, type Change } from './version.ts';
import { stableJson } from './json.ts';

export type SaveMode = 'typo_fix' | 'update_draft' | 'new_version';
export interface SavePlan {
  mode: SaveMode | null;               // null = nothing to save, or blocked
  blocked: string | null;              // why the save can't happen
  summary: string;                     // what Save will do, in plain words
  change: Change;
  changedFields: string[];             // structure paths that differ (for the preview)
  payload: Record<string, unknown> | null;
}

/** Top-level structure keys that differ, e.g. ["answer", "signature"]. */
export function structureDiff(a: Question, b: Question): string[] {
  const sa = structureOf(a, a.topic_id) as Record<string, unknown>, sb = structureOf(b, b.topic_id) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(sb)) {
    const x = sa[k], y = sb[k];
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x)) {
      for (const kk of Object.keys(y as object)) if (stableJson((x as Record<string, unknown>)[kk]) !== stableJson((y as Record<string, unknown>)[kk])) out.push(`${k}.${kk}`);
    } else if (stableJson(x) !== stableJson(y)) out.push(k);
  }
  return out;
}

/** Version and child rows as cms_apply_save expects them. */
export function rowsFor(q: Question, cfg: DerivedConfig, questionClass: number, conceptClass: (id: string) => number | undefined) {
  const d = derive(q, questionClass, conceptClass, cfg);
  const s = q.signature;
  const version = {
    topic_id: q.topic_id, typical_set_id: q.typical_set_id, pattern_id: q.pattern_id ?? null,
    text: q.text, figure_description: q.figure?.description ?? null, image_status: q.figure?.image_status ?? null, image_path: q.figure?.image_file ?? null,
    format: q.answer.format, correct: q.answer.format === 'Multi-part' ? null : q.answer.correct, accepted: q.answer.accepted ?? [], duration_s: q.duration_s,
    math_difficulty: s.math_difficulty, is_pure_fact: s.is_pure_fact, reading: s.reading, has_irrelevant_info: s.has_irrelevant_info, steps: s.steps,
    working_memory: s.working_memory, inhibition: s.inhibition, visual: s.visual, strategy: s.strategy,
    strategy_type: s.strategy_type ?? null, strategy_type_2: s.strategy_type_2 ?? null, strategy_other_note: s.strategy_other_note ?? null,
    insight_id: s.insight_id ?? null, proposed_insight: s.proposed_insight ?? null, trick_ref: s.trick_ref ?? null,
    ...d,
    tagging_why: q.tagging?.why ?? null, tagged_by: q.tagging?.tagged_by ?? null, tagging_summary: q.tagging?.summary ?? null, author_notes: q.author_notes ?? null,
  };
  const answers: [string, Answer][] = [['', q.answer], ...(q.parts ?? []).map((p) => [p.part_label, p.answer] as [string, Answer])];
  const options = answers.flatMap(([label, a]) => (a.options ?? []).map((text, i) => ({ part_label: label, position: i + 1, text, is_correct: text === a.correct })));
  const wrong_answers = answers.flatMap(([label, a]) => (a.wrong_answers ?? []).map((w) => {
    const pos = (a.options ?? []).indexOf(w.value);
    return { part_label: label, value: w.value, option_position: pos >= 0 ? pos + 1 : null, tag: w.tag, misconception_id: w.misconception_id ?? null, target_concept_id: w.target_concept_id ?? null, why: w.why ?? null };
  }));
  return {
    version, derived: d, options, wrong_answers,
    parts: (q.parts ?? []).map((p) => ({ part_label: p.part_label, text: p.text, format: p.answer.format, correct: p.answer.correct, accepted: p.answer.accepted ?? [] })),
    concepts: [...q.concepts.map((c) => ({ part_label: '', concept_id: c.concept_id, involvement: c.involvement })),
      ...(q.parts ?? []).flatMap((p) => p.concepts.map((c) => ({ part_label: p.part_label, concept_id: c.concept_id, involvement: c.involvement })))],
    solutions: [{ slot: 1, text: q.solutions.school, type: null, strategy: null },
      ...(q.solutions.second ? [{ slot: 2, text: q.solutions.second.text, type: q.solutions.second.type, strategy: q.solutions.second.strategy ?? null }] : [])],
    hints: q.hints.map((text, i) => ({ level: i + 1, text })),
    source_refs: q.source_refs ?? [],
  };
}

export function planSave(args: {
  questionId: string; baseVersionNo: number; currentStatus: string; retired: boolean;
  before: Question; after: Question; cfg: DerivedConfig; questionClass: number; conceptClass: (id: string) => number | undefined;
  forceNewVersion?: boolean; reason?: string;
}): SavePlan {
  const { before, after } = args;
  const prev = { structureHash: structureHash(before, before.topic_id), texts: textsOf(before) };
  const next = { structureHash: structureHash(after, after.topic_id), texts: textsOf(after) };
  const change = classify(prev, next, args.forceNewVersion);
  const changedFields = structureDiff(before, after);
  const none = (summary: string, blocked: string | null = null): SavePlan => ({ mode: null, blocked, summary, change, changedFields, payload: null });

  if (args.retired) return none('This question is retired. Restore it to edit.', 'retired');
  if (change.kind === 'unchanged') return none('No changes to save.');
  let mode: SaveMode;
  let summary: string;
  if (args.currentStatus === 'in_review') {
    // D6 (12 Nov 2026): "Needs review" is a flag on an open version; editing keeps the flag.
    mode = 'update_draft'; summary = `Update v${args.baseVersionNo} in place; it stays flagged "Needs review".`;
  } else if (args.currentStatus === 'draft') {
    mode = 'update_draft'; summary = `Update the open draft v${args.baseVersionNo} in place (not reviewed yet).`;
  } else if (change.kind === 'typo' && args.currentStatus === 'approved') {
    mode = 'typo_fix'; summary = `Typo fix: same version v${args.baseVersionNo}, stays approved; logged with before and after.`;
  } else {
    mode = 'new_version';
    summary = `New version v${args.baseVersionNo + 1} (draft): ${change.kind === 'new' ? change.reason : `v${args.baseVersionNo} is ${args.currentStatus}, so any change needs a new version`}.`;
  }
  const rows = rowsFor(after, args.cfg, args.questionClass, args.conceptClass);
  const textDiff = change.kind === 'typo' ? change.diff : Object.fromEntries(
    [...new Set([...Object.keys(prev.texts), ...Object.keys(next.texts)])]
      .filter((k) => (prev.texts[k] ?? null) !== (next.texts[k] ?? null))
      .map((k) => [k, { before: prev.texts[k] ?? null, after: next.texts[k] ?? null }]));
  const payload = {
    question_id: args.questionId, mode, base_version_no: args.baseVersionNo, content_hash: next.structureHash,
    question: { topic_id: after.topic_id, typical_set_id: after.typical_set_id, pattern_id: after.pattern_id ?? null, clone_batch_id: after.clone_batch_id,
      class_override: after.class_override ?? null, placement_note: after.placement_note ?? null },
    version: rows.version, parts: rows.parts, options: rows.options, wrong_answers: rows.wrong_answers, concepts: rows.concepts,
    solutions: rows.solutions, hints: rows.hints, source_refs: rows.source_refs,
    diff: { structure: changedFields, texts: textDiff }, reason: args.reason ?? null,
  };
  return { mode, blocked: null, summary, change, changedFields, payload };
}

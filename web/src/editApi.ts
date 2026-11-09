// Phase 5: loading a question for editing, the checks' catalogue, and the three write
// functions (cms_apply_save, cms_set_status, cms_retire). No table is written directly.
import type { Catalog } from '../../shared/checks.ts';
import { questionFromDb, type DbBundle } from '../../shared/fromDb.ts';
import type { DerivedConfig } from '../../shared/types.ts';
import { questionDetail, type QuestionDetailData } from './api';
import { supabase } from './supabase';

const must = <T>(r: { data: T | null; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
};

export const bundleOf = (d: QuestionDetailData): DbBundle => ({
  question: d.question as never, version: d.version as never, parts: d.parts as never, options: d.options, wrong: d.wrong as never,
  concepts: d.concepts, solutions: d.solutions, hints: d.hints, refs: d.refs,
});

export interface EditContext {
  detail: QuestionDetailData;
  question: ReturnType<typeof questionFromDb>;
  cfg: DerivedConfig;
  catalog: Catalog;
  lists: {
    topics: { topic_id: string; name: string; class: number; topic_kind: string }[];
    sets: { typical_set_id: string; name: string; class: number }[];
    patterns: { pattern_id: string; name: string; typical_set_id: string }[];
    concepts: { concept_id: string; name: string; class: number }[];
    misconceptions: { misconception_id: string; description: string; concept_id: string | null }[];
    insights: { insight_id: string; name: string; status: string }[];
    strategyTypes: string[];
  };
  conceptClass: (id: string) => number | undefined;
}

export async function loadForEdit(questionId: string): Promise<EditContext> {
  const detail = await questionDetail(questionId, null);
  if (!detail) throw new Error(`Question ${questionId} doesn't exist.`);
  const chapter = detail.question.chapter_id;
  const [topics, sets, patterns, concepts, miscs, insights, strategies, cfgRows, rules] = await Promise.all([
    supabase.from('cms_topics').select('topic_id, name, class, topic_kind, chapter_id, taught_in_school, status').eq('chapter_id', chapter).order('topic_id'),
    supabase.from('cms_typical_sets').select('typical_set_id, name, class, status').order('typical_set_id'),
    supabase.from('cms_patterns').select('pattern_id, name, typical_set_id').order('pattern_id'),
    supabase.from('cms_concepts').select('concept_id, name, class').order('concept_id'),
    supabase.from('cms_misconceptions').select('misconception_id, description, concept_id').order('misconception_id'),
    supabase.from('cms_insights').select('insight_id, name, status').order('insight_id'),
    supabase.from('cms_strategy_types').select('value, active, sort').order('sort'),
    supabase.from('cms_config').select('key, value').in('key', ['multistep_bands', 'difficulty_points', 'load_thresholds']),
    supabase.from('cms_rule_versions').select('rule_version'),
  ]);
  const T = must<{ topic_id: string; name: string; class: number; topic_kind: string; chapter_id: string; taught_in_school: boolean; status: string }[]>(topics);
  const S = must<{ typical_set_id: string; name: string; class: number; status: string }[]>(sets);
  const P = must<{ pattern_id: string; name: string; typical_set_id: string }[]>(patterns);
  const C = must<{ concept_id: string; name: string; class: number }[]>(concepts);
  const M = must<{ misconception_id: string; description: string; concept_id: string | null }[]>(miscs);
  const I = must<{ insight_id: string; name: string; status: string }[]>(insights);
  const cfg = Object.fromEntries(must<{ key: string; value: unknown }[]>(cfgRows).map((r) => [r.key, r.value])) as unknown as DerivedConfig;
  if (!cfg.multistep_bands || !cfg.difficulty_points) throw new Error('The derived-field config is missing (run the v10 seed).');
  const conceptClasses = new Map(C.map((c) => [c.concept_id, c.class]));
  const catalog: Catalog = {
    ruleVersions: new Set(must<{ rule_version: string }[]>(rules).map((r) => r.rule_version)),
    chapter: { chapter_id: chapter, subject: detail.question.subject },
    topics: new Map(T.map((t) => [t.topic_id, { chapter_id: t.chapter_id, class: t.class, topic_kind: t.topic_kind as 'normal', taught_in_school: t.taught_in_school, status: t.status }])),
    typicalSets: new Map(S.map((s) => [s.typical_set_id, { class: s.class, status: s.status }])),
    patterns: new Set(P.map((p) => p.pattern_id)),
    concepts: new Map(C.map((c) => [c.concept_id, { class: c.class }])),
    misconceptions: new Set(M.map((m) => m.misconception_id)),
    insights: new Map(I.map((i) => [i.insight_id, { status: i.status }])),
    stems: new Map(),            // duplicate-stem warnings are an import-time check
    keyToQuestionId: new Map(),
    sourceItems: new Set(detail.refs.map((r) => r.ref_id)), // existing refs are not re-flagged here
  };
  return {
    detail, question: questionFromDb(bundleOf(detail)), cfg, catalog, conceptClass: (id) => conceptClasses.get(id),
    lists: { topics: T, sets: S, patterns: P, concepts: C, misconceptions: M, insights: I,
      strategyTypes: must<{ value: string; active: boolean }[]>(strategies).filter((s) => s.active).map((s) => s.value) },
  };
}

const rpc = async (fn: string, args: Record<string, unknown>) => {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
};
export const applySave = (payload: Record<string, unknown>) => rpc('cms_apply_save', { payload });
export const setStatus = (questionId: string, versionNo: number, action: 'submit' | 'withdraw' | 'approve' | 'reject', reason: string | null) =>
  rpc('cms_set_status', { p_question_id: questionId, p_version_no: versionNo, p_action: action, p_reason: reason });
export const retire = (questionId: string, doRetire: boolean, reason: string) => rpc('cms_retire', { p_question_id: questionId, p_retire: doRetire, p_reason: reason });

/** Drafts and in-review versions, oldest first (the review queue). */
export async function reviewQueue() {
  return must<{ question_id: string; bank: string; subject: string; chapter_id: string; topic_id: string; class: number; status: string; text: string;
    current_version: number; approved_version: number | null; version_created_at: string; math_difficulty: string | null }[]>(
    await supabase.from('cms_question_list').select('question_id, bank, subject, chapter_id, topic_id, class, status, text, current_version, approved_version, version_created_at, math_difficulty')
      .in('status', ['draft', 'in_review']).is('retired_at', null).order('version_created_at').limit(500));
}

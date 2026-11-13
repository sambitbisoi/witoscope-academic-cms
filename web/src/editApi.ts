// Phase 5: loading a question for editing, the checks' catalogue, and the three write
// functions (cms_apply_save, cms_set_status, cms_retire). No table is written directly.
import type { Catalog } from '../../shared/checks.ts';
import { questionFromDb, type DbBundle } from '../../shared/fromDb.ts';
import { currentRuleVersion } from '../../shared/rules.ts';
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
  ruleVersion: string;             // the current rule version (cms_config current_rule_version)
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
    supabase.from('cms_config').select('key, value').in('key', ['multistep_bands', 'difficulty_points', 'load_thresholds', 'current_rule_version']),
    supabase.from('cms_rule_versions').select('rule_version'),
  ]);
  const T = must<{ topic_id: string; name: string; class: number; topic_kind: string; chapter_id: string; taught_in_school: boolean; status: string }[]>(topics);
  const S = must<{ typical_set_id: string; name: string; class: number; status: string }[]>(sets);
  const P = must<{ pattern_id: string; name: string; typical_set_id: string }[]>(patterns);
  const C = must<{ concept_id: string; name: string; class: number }[]>(concepts);
  const M = must<{ misconception_id: string; description: string; concept_id: string | null }[]>(miscs);
  const I = must<{ insight_id: string; name: string; status: string }[]>(insights);
  const cfg = Object.fromEntries(must<{ key: string; value: unknown }[]>(cfgRows).map((r) => [r.key, r.value])) as unknown as DerivedConfig;
  if (!cfg.multistep_bands || !cfg.difficulty_points) throw new Error('The derived-field config is missing (run the seed).');
  const loadedRules = must<{ rule_version: string }[]>(rules).map((r) => r.rule_version);
  const ruleVersion = currentRuleVersion(loadedRules, (cfg as unknown as Record<string, unknown>).current_rule_version);
  if (!ruleVersion) throw new Error('No rule version is loaded (run the seed).');
  const conceptClasses = new Map(C.map((c) => [c.concept_id, c.class]));
  const catalog: Catalog = {
    ruleVersions: new Set(loadedRules),
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
    detail, question: questionFromDb(bundleOf(detail)), cfg, catalog, ruleVersion, conceptClass: (id) => conceptClasses.get(id),
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
/** overrideNearCopy: "override: reviewed, not a copy" for a near-copy of a book (needs a reason; logged). */
export const setStatus = (questionId: string, versionNo: number, action: 'submit' | 'withdraw' | 'approve' | 'reject', reason: string | null, overrideNearCopy = false) =>
  rpc('cms_set_status', { p_question_id: questionId, p_version_no: versionNo, p_action: action, p_reason: reason, p_override_near_copy: overrideNearCopy });
export const retire = (questionId: string, doRetire: boolean, reason: string) => rpc('cms_retire', { p_question_id: questionId, p_retire: doRetire, p_reason: reason });

/** The Review tab (D6): flagged ("Needs review") and rejected current versions with their latest note, oldest first. */
export async function reviewQueue() {
  return must<{ question_id: string; bank: string; subject: string; file_key: string | null; chapter_id: string; topic_id: string; class: number; status: string; text: string;
    current_version: number; approved_version: number | null; version_created_at: string; math_difficulty: string | null; note: string | null; note_action: string | null; noted_at: string | null;
    created_from: string; attributes_pending: boolean; originality_pending: boolean; image_pending: boolean; upload_file: string | null; uploaded_at: string | null }[]>(
    await supabase.from('cms_review_queue').select('*').order('noted_at', { ascending: true, nullsFirst: true }).order('version_created_at').limit(1000));
}

/** Override requests (Sambit, 12 Nov 2026): pending first, then decided; with the recorded check. */
export interface OverrideRequest { request_id: number; question_id: string; version_id: number; file_key: string | null; field: string; reason: string; requested_by: string;
  status: 'pending' | 'approved' | 'declined'; decided_at: string | null; decision_note: string | null; created_at: string;
  check: { result: string; similarity: number | null; same_numbers: boolean; closest_ref: string | null; field: string | null } | null;
  version_no: number | null; current_version: number | null; chapter_id: string | null; topic_id: string | null; class: number | null; text: string | null }
export async function overrideRequests(): Promise<OverrideRequest[]> {
  const reqs = must<(Omit<OverrideRequest, 'check' | 'version_no' | 'current_version' | 'chapter_id' | 'topic_id' | 'class' | 'text'> & { check_id: number | null })[]>(
    await supabase.from('cms_override_requests').select('*').order('status', { ascending: false }).order('request_id').limit(500));
  if (!reqs.length) return [];
  const ids = [...new Set(reqs.map((r) => r.question_id))];
  const [checks, qs, vs] = await Promise.all([
    supabase.from('cms_originality_checks').select('check_id, result, similarity, same_numbers, closest_ref, field').in('check_id', reqs.map((r) => r.check_id).filter((x): x is number => !!x)),
    supabase.from('cms_question_list').select('question_id, current_version, chapter_id, topic_id, class, text').in('question_id', ids),
    supabase.from('cms_question_versions').select('version_id, version_no').in('version_id', reqs.map((r) => r.version_id)),
  ]);
  const C = must<{ check_id: number; result: string; similarity: number | null; same_numbers: boolean; closest_ref: string | null; field: string | null }[]>(checks);
  const Q = must<{ question_id: string; current_version: number; chapter_id: string; topic_id: string; class: number; text: string }[]>(qs);
  const V = must<{ version_id: number; version_no: number }[]>(vs);
  return reqs.map((r) => {
    const q = Q.find((x) => x.question_id === r.question_id);
    return { ...r, check: C.find((c) => c.check_id === r.check_id) ?? null, version_no: V.find((v) => v.version_id === r.version_id)?.version_no ?? null,
      current_version: q?.current_version ?? null, chapter_id: q?.chapter_id ?? null, topic_id: q?.topic_id ?? null, class: q?.class ?? null, text: q?.text ?? null };
  });
}
export const decideOverride = (requestId: number, approve: boolean, note: string | null) =>
  rpc('cms_decide_override', { p_request_id: requestId, p_approve: approve, p_note: note });

/** U2: approve (active), retire, or put back to proposed, a catalogue item (audited). */
export const setCatalogueStatus = (kind: 'concept' | 'misconception' | 'typical_set' | 'pattern', id: string, status: 'active' | 'retired' | 'proposed', reason: string | null) =>
  rpc('cms_set_catalogue_status', { p_kind: kind, p_id: id, p_status: status, p_reason: reason });

/** The current rule version (cms_config current_rule_version, else the newest loaded): what Generate,
 *  tagging, the model check and the editor use. */
export async function loadCurrentRuleVersion(): Promise<string> {
  const [rv, cfg] = await Promise.all([
    supabase.from('cms_rule_versions').select('rule_version'),
    supabase.from('cms_config').select('value').eq('key', 'current_rule_version'),
  ]);
  const v = currentRuleVersion(must<{ rule_version: string }[]>(rv).map((r) => r.rule_version), must<{ value: unknown }[]>(cfg)[0]?.value);
  if (!v) throw new Error('No rule version is loaded (run the seed).');
  return v;
}
/** Review status per topic (manual only; logged before → after by the function). */
export const setTopicReview = (topicId: string, status: string, note: string | null) =>
  rpc('cms_set_topic_review', { p_topic_id: topicId, p_status: status, p_note: note }) as Promise<{ changed: boolean }>;
/** Add questions to a topic by hand or from an upload (no AI; status Needs review; flags set by the function). */
export const addQuestions = (p: { topic_id: string; origin: 'manual' | 'upload'; file_name?: string; file_hash?: string; questions: unknown[]; skipped?: unknown[]; warnings?: unknown[] }) =>
  rpc('cms_add_questions', { p }) as Promise<{ import_id: number | null; added: { row: number | null; question_id: string; file_key: string }[] }>;

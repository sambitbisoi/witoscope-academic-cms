// All Browse reads, typed. Everything goes through RLS as the signed-in admin;
// counts come from the security_invoker views in migration 0010.
import { safeSearch, SUBJECTS, type ListQuestion, type Subject, type TopicStats, type VersionRow } from './logic';
import { supabase } from './supabase';

const must = <T>(r: { data: T | null; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
};
const prefixOf = (s: Subject) => `${SUBJECTS.find((x) => x.id === s)!.prefix}C`;

// ---------------------------------------------------------------- Home
export interface HomeStats { subject: Subject; class: number; chapters: number; topics: number; questions: number; approved: number; draft: number;
  in_review: number; gold: number; topics_with_questions: number; topics_all_levels: number }
export const homeStats = async () => must<HomeStats[]>(await supabase.from('cms_home_stats').select('*'));

export interface Job { job_id: number; type: string; status: string; progress: number; started_at: string | null; finished_at: string | null; error: string | null }
export const activeJobs = async () =>
  must<Job[]>(await supabase.from('cms_jobs').select('*').in('status', ['queued', 'running']).order('job_id', { ascending: false }).limit(5));

export interface LastImport { import_id: number; kind: string; file_path: string; started_at: string; result: string | null; chapter_id: string | null }
export const lastImport = async () =>
  must<LastImport[]>(await supabase.from('cms_imports').select('import_id, kind, file_path, started_at, result, chapter_id').order('import_id', { ascending: false }).limit(1))[0] ?? null;

// ---------------------------------------------------------------- Workspace tree
export interface Chapter { chapter_id: string; name: string; strand_id: string; sort: number; display_code: string | null }
export interface Topic { topic_id: string; chapter_id: string; class: number; seq: number | null; name: string; topic_kind: 'normal' | 'achievers';
  taught_in_school: boolean; source_flags: Record<string, string>; status: string; sub_skills: string | null }
export type TopicWithStats = Topic & { stats?: TopicStats };

export async function tree(subject: Subject, cls: string) {
  const pre = `${prefixOf(subject)}*`;
  let tq = supabase.from('cms_topics').select('topic_id, chapter_id, class, seq, name, topic_kind, taught_in_school, source_flags, status, sub_skills').like('chapter_id', pre);
  let sq = supabase.from('cms_topic_stats').select('*').like('chapter_id', pre);
  if (cls !== 'all') { tq = tq.eq('class', Number(cls)); sq = sq.eq('class', Number(cls)); }
  const [chapters, topics, stats, strands] = await Promise.all([
    supabase.from('cms_chapters').select('chapter_id, name, strand_id, sort, display_code').eq('subject', subject).order('sort'),
    tq.order('class').order('seq', { nullsFirst: false }).order('topic_id'),
    sq,
    supabase.from('cms_strands').select('strand_id, name, sort').eq('subject', subject).order('sort'),
  ]);
  const byId = new Map(must<(TopicStats & { topic_id: string })[]>(stats).map((s) => [s.topic_id, s]));
  return {
    chapters: must<Chapter[]>(chapters),
    strands: must<{ strand_id: string; name: string; sort: number }[]>(strands),
    topics: must<Topic[]>(topics).map((t) => ({ ...t, stats: byId.get(t.topic_id) })) as TopicWithStats[],
  };
}

// ---------------------------------------------------------------- Topic
export type QuestionRow = ListQuestion & { subject: string; file_key: string | null; chapter_id: string; topic_id: string; class: number;
  version_id: number; format: string; tier: string | null; gold_use: string | null; clone_batch_id: string | null };
export interface TypicalSet { typical_set_id: string; name: string; class: number; instruction_pattern: string | null; variant_note: string | null;
  parent_visible: boolean; status: string; topic_id: string | null }
export interface Pattern { pattern_id: string; name: string; typical_set_id: string; target_misconceptions: string[]; status: string }
export interface Concept { concept_id: string; name: string; class: number; type: string | null; status: string; topic_id: string | null; description: string | null }

export async function topicData(topicId: string) {
  const questions = must<QuestionRow[]>(await supabase.from('cms_question_list').select('*').eq('topic_id', topicId));
  const setIds = [...new Set(questions.map((q) => q.typical_set_id).filter((x): x is string => !!x))];
  const [setsOwn, setsUsed, concepts, versionConcepts] = await Promise.all([
    supabase.from('cms_typical_sets').select('*').eq('topic_id', topicId).order('typical_set_id'),
    setIds.length ? supabase.from('cms_typical_sets').select('*').in('typical_set_id', setIds) : Promise.resolve({ data: [], error: null }),
    supabase.from('cms_concepts').select('concept_id, name, class, type, status, topic_id, description').eq('topic_id', topicId).order('concept_id'),
    questions.length
      ? supabase.from('cms_version_concepts').select('version_id, part_label, concept_id, involvement').in('version_id', questions.map((q) => q.version_id))
      : Promise.resolve({ data: [], error: null }),
  ]);
  const sets = new Map<string, TypicalSet>();
  for (const s of [...must<TypicalSet[]>(setsOwn), ...must<TypicalSet[]>(setsUsed)]) sets.set(s.typical_set_id, s);
  const allSetIds = [...sets.keys()];
  const [patterns, setConcepts] = await Promise.all([
    allSetIds.length ? supabase.from('cms_patterns').select('pattern_id, name, typical_set_id, target_misconceptions, status').in('typical_set_id', allSetIds) : Promise.resolve({ data: [], error: null }),
    allSetIds.length ? supabase.from('cms_typical_set_concepts').select('typical_set_id, concept_id, role').in('typical_set_id', allSetIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const vc = must<{ version_id: number; part_label: string; concept_id: string; involvement: number }[]>(versionConcepts);
  // concepts used by these questions but defined on other topics
  const known = new Set(must<Concept[]>(concepts).map((c) => c.concept_id));
  const extraIds = [...new Set(vc.map((x) => x.concept_id).filter((c) => !known.has(c)))];
  const extra = extraIds.length ? must<Concept[]>(await supabase.from('cms_concepts').select('concept_id, name, class, type, status, topic_id, description').in('concept_id', extraIds)) : [];
  return {
    questions,
    sets: [...sets.values()],
    patterns: must<Pattern[]>(patterns),
    setConcepts: must<{ typical_set_id: string; concept_id: string; role: string }[]>(setConcepts),
    concepts: [...must<Concept[]>(concepts), ...extra],
    versionConcepts: vc,
  };
}

// ---------------------------------------------------------------- Question detail
export type Version = VersionRow & {
  version_id: number; question_id: string; version_no: number; status: string; text: string; figure_description: string | null; image_status: string | null;
  image_path: string | null; format: string; correct: string | null; accepted: string[]; duration_s: number | null; proposed_insight: Record<string, string> | null;
  trick_ref: string | null; tagging_why: Record<string, { why: string; confidence: string }> | null; tagged_by: string | null; tagging_summary: string | null;
  author_notes: string | null; content_hash: string; created_from: string; created_at: string; edited_at: string | null;
  topic_id: string | null; typical_set_id: string | null; pattern_id: string | null;
};

export async function questionDetail(questionId: string, versionNo: number | null) {
  const q = must<Record<string, unknown> | null>(await supabase.from('cms_questions').select('*').eq('question_id', questionId).maybeSingle());
  if (!q) return null;
  const versions = must<{ version_id: number; version_no: number; status: string; created_from: string; created_at: string; edited_at: string | null }[]>(
    await supabase.from('cms_question_versions').select('version_id, version_no, status, created_from, created_at, edited_at').eq('question_id', questionId).order('version_no', { ascending: false }));
  const wanted = versionNo ?? (q.current_version as number);
  const meta = versions.find((v) => v.version_no === wanted) ?? versions[0];
  if (!meta) return null;
  const vid = meta.version_id;
  const [version, parts, options, wrong, concepts, solutions, hints, refs, gold, reviews] = await Promise.all([
    supabase.from('cms_question_versions').select('*').eq('version_id', vid).single(),
    supabase.from('cms_version_parts').select('*').eq('version_id', vid).order('part_label'),
    supabase.from('cms_version_options').select('*').eq('version_id', vid).order('part_label').order('position'),
    supabase.from('cms_version_wrong_answers').select('*').eq('version_id', vid).order('wrong_answer_id'),
    supabase.from('cms_version_concepts').select('*').eq('version_id', vid),
    supabase.from('cms_version_solutions').select('*').eq('version_id', vid).order('slot'),
    supabase.from('cms_version_hints').select('*').eq('version_id', vid).order('level'),
    supabase.from('cms_version_source_refs').select('*').eq('version_id', vid),
    supabase.from('cms_gold_meta').select('*').eq('question_id', questionId).maybeSingle(),
    supabase.from('cms_reviews').select('review_id, target_id, action, reason, field_diff, by_label, at').like('target_id', `${questionId} v%`).order('review_id', { ascending: false }).limit(50),
  ]);
  const v = must<Version>(version);
  const wa = must<{ part_label: string; value: string; option_position: number | null; tag: string; misconception_id: string | null; target_concept_id: string | null; why: string | null }[]>(wrong);
  const vc = must<{ part_label: string; concept_id: string; involvement: number }[]>(concepts);
  const miscIds = [...new Set(wa.map((w) => w.misconception_id).filter((x): x is string => !!x))];
  const conceptIds = [...new Set([...vc.map((c) => c.concept_id), ...wa.map((w) => w.target_concept_id).filter((x): x is string => !!x)])];
  const [miscs, conceptNames, insight, topic, set, pattern] = await Promise.all([
    miscIds.length ? supabase.from('cms_misconceptions').select('misconception_id, description, parent_description, status').in('misconception_id', miscIds) : Promise.resolve({ data: [], error: null }),
    conceptIds.length ? supabase.from('cms_concepts').select('concept_id, name, class, status').in('concept_id', conceptIds) : Promise.resolve({ data: [], error: null }),
    v.insight_id ? supabase.from('cms_insights').select('insight_id, name').eq('insight_id', v.insight_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    supabase.from('cms_topics').select('topic_id, name, class, chapter_id').eq('topic_id', (v.topic_id ?? q.topic_id) as string).maybeSingle(),
    (v.typical_set_id ?? q.typical_set_id) ? supabase.from('cms_typical_sets').select('typical_set_id, name, status').eq('typical_set_id', (v.typical_set_id ?? q.typical_set_id) as string).maybeSingle() : Promise.resolve({ data: null, error: null }),
    (v.pattern_id ?? q.pattern_id) ? supabase.from('cms_patterns').select('pattern_id, name, status').eq('pattern_id', (v.pattern_id ?? q.pattern_id) as string).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  return {
    question: q as { question_id: string; bank: string; subject: string; file_key: string | null; chapter_id: string; topic_id: string; class: number;
      class_override: number | null; placement_note: string | null; typical_set_id: string | null; pattern_id: string | null; clone_batch_id: string | null;
      current_version: number; approved_version: number | null; retired_at: string | null; created_at: string },
    version: v,
    versions,
    parts: must<{ part_label: string; text: string; format: string; correct: string; accepted: string[] }[]>(parts),
    options: must<{ part_label: string; position: number; text: string; is_correct: boolean }[]>(options),
    wrong: wa,
    concepts: vc,
    solutions: must<{ slot: number; text: string; type: string | null; strategy: string | null }[]>(solutions),
    hints: must<{ level: number; text: string }[]>(hints),
    refs: must<{ ref_id: string; relation: string }[]>(refs),
    gold: must<{ use: string; old_qid: string | null; final_reasoning: string | null; review_verdict: string | null; review_notes: string | null } | null>(gold),
    reviews: must<{ review_id: number; target_id: string; action: string; reason: string | null; field_diff: unknown; by_label: string; at: string }[]>(reviews),
    misconceptions: new Map(must<{ misconception_id: string; description: string; parent_description: string | null; status: string }[]>(miscs).map((m) => [m.misconception_id, m])),
    conceptNames: new Map(must<{ concept_id: string; name: string; class: number; status: string }[]>(conceptNames).map((c) => [c.concept_id, c])),
    insightName: (must<{ name: string } | null>(insight))?.name ?? null,
    topic: must<{ topic_id: string; name: string; class: number; chapter_id: string } | null>(topic),
    set: must<{ typical_set_id: string; name: string; status: string } | null>(set),
    pattern: must<{ pattern_id: string; name: string; status: string } | null>(pattern),
  };
}
export type QuestionDetailData = NonNullable<Awaited<ReturnType<typeof questionDetail>>>;

/** Where a question lives, to open it from #/q/<id> or search. */
export async function locateQuestion(questionId: string) {
  return must<{ question_id: string; topic_id: string; class: number; chapter_id: string } | null>(
    await supabase.from('cms_questions').select('question_id, topic_id, class, chapter_id').eq('question_id', questionId).maybeSingle());
}

// ---------------------------------------------------------------- Search
export interface SearchHit { kind: 'topic' | 'set' | 'pattern' | 'concept' | 'question'; id: string; label: string; topicId: string | null; chapterId: string | null; cls: number | null; questionId?: string }

export async function search(raw: string): Promise<SearchHit[]> {
  const s = safeSearch(raw);
  if (s.length < 2) return [];
  const like = `*${s}*`;
  const [topics, sets, patterns, concepts, questions] = await Promise.all([
    supabase.from('cms_topics').select('topic_id, name, chapter_id, class').or(`topic_id.ilike.${like},name.ilike.${like}`).order('topic_kind', { ascending: false }).order('topic_id').limit(8),
    supabase.from('cms_typical_sets').select('typical_set_id, name, topic_id, chapter_id, class').or(`typical_set_id.ilike.${like},name.ilike.${like}`).limit(6),
    supabase.from('cms_patterns').select('pattern_id, name, topic_id').or(`pattern_id.ilike.${like},name.ilike.${like}`).limit(6),
    supabase.from('cms_concepts').select('concept_id, name, topic_id, class').or(`concept_id.ilike.${like},name.ilike.${like}`).limit(6),
    supabase.from('cms_question_list').select('question_id, file_key, text, topic_id, chapter_id, class').or(`question_id.ilike.${like},file_key.ilike.${like}`).limit(8),
  ]);
  const hits: SearchHit[] = [];
  for (const t of must<{ topic_id: string; name: string; chapter_id: string; class: number }[]>(topics)) hits.push({ kind: 'topic', id: t.topic_id, label: t.name, topicId: t.topic_id, chapterId: t.chapter_id, cls: t.class });
  for (const t of must<{ typical_set_id: string; name: string; topic_id: string | null; chapter_id: string | null; class: number }[]>(sets)) hits.push({ kind: 'set', id: t.typical_set_id, label: t.name, topicId: t.topic_id, chapterId: t.chapter_id, cls: t.class });
  for (const t of must<{ pattern_id: string; name: string; topic_id: string }[]>(patterns)) hits.push({ kind: 'pattern', id: t.pattern_id, label: t.name, topicId: t.topic_id, chapterId: null, cls: null });
  for (const t of must<{ concept_id: string; name: string; topic_id: string | null; class: number }[]>(concepts)) hits.push({ kind: 'concept', id: t.concept_id, label: t.name, topicId: t.topic_id, chapterId: null, cls: t.class });
  for (const t of must<{ question_id: string; file_key: string | null; text: string; topic_id: string; chapter_id: string; class: number }[]>(questions)) {
    hits.push({ kind: 'question', id: t.question_id, label: `${t.file_key ? `${t.file_key} · ` : ''}${t.text}`, topicId: t.topic_id, chapterId: t.chapter_id, cls: t.class, questionId: t.question_id });
  }
  return hits;
}

/** Topic → chapter and class, for hits that only know the topic. */
export async function topicHome(topicId: string) {
  return must<{ topic_id: string; chapter_id: string; class: number } | null>(
    await supabase.from('cms_topics').select('topic_id, chapter_id, class').eq('topic_id', topicId).maybeSingle());
}

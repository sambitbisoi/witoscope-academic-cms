// Q21 (Sambit, 17 Nov 2026): the Held-out area. Read the held items; Place one on a topic (the rows are computed here with
// the importer's shared code: chapter-file checks, derived fields with Tier uses Level, structure fingerprint; the database
// re-checks placement and records originality from the stored result); Discard (kept, audited).
import { checkFile, type Catalog } from '../../shared/checks.ts';
import { tierBasis } from '../../shared/derive.ts';
import { rowsFor } from '../../shared/save.ts';
import type { ChapterFile, DerivedConfig, Problem, Question } from '../../shared/types.ts';
import { structureHash } from '../../shared/version.ts';
import { all } from './api';
import { loadCurrentRuleVersion } from './editApi';
import { supabase } from './supabase';

export interface HeldItem {
  held_id: number; subject: string; batch: string; import_id: number | null; file: string; chapter_id: string; file_key: string; class: number; level: number | null;
  reason_code: string; reason: string; recommended_topic_id: string | null; question: Question;
  catalogue: { concepts: Record<string, unknown>[]; misconceptions: Record<string, unknown>[]; typical_sets: Record<string, unknown>[]; patterns: Record<string, unknown>[] };
  proposed_by: string | null; originality: { result: string; similarity: number | null; same_numbers: boolean; closest_ref: string | null; field: string | null } | null;
  status: 'held' | 'placed' | 'discarded'; placed_question_id: string | null; placed_topic_id: string | null; decided_at: string | null; note: string | null; created_at: string;
}
const must = <T>(r: { data: unknown; error: { message: string } | null }): T => { if (r.error) throw new Error(r.error.message); return r.data as T; };

export const REASON_LABEL: Record<string, string> = {
  topic_missing: 'Topic not in the CMS', achievers_missing: 'Achievers row missing', topic_retired: 'Topic retired', topic_class: 'Topic in another class',
  topic_chapter: 'Topic in another chapter', typical_set_missing: 'Typical set missing', typical_set_class: 'Typical set in another class',
  pattern_missing: 'Pattern missing', concept_missing: 'Concept missing', misconception_missing: 'Misconception missing', row_missing: 'Content row missing', other_placement: 'Other placement',
};

export const heldItems = () => all<HeldItem>((a, b) => supabase.from('cms_held_out').select('*').order('created_at', { ascending: false }).order('held_id').range(a, b));

/** Topics an item can be placed on: same chapter and class, active (Achievers rows included). */
export async function placeTopics(chapterId: string, cls: number) {
  return must<{ topic_id: string; name: string; class: number; topic_kind: string; status: string }[]>(
    await supabase.from('cms_topics').select('topic_id, name, class, topic_kind, status').eq('chapter_id', chapterId).eq('class', cls).eq('status', 'active').order('topic_id'));
}

/** Everything the importer's checks read, for one chapter, plus the items held with the question (counted as present). */
async function catalogFor(h: HeldItem, ruleVersion: string): Promise<{ cat: Catalog; cfg: DerivedConfig; conceptClass: Map<string, number> }> {
  const [topics, sets, patterns, concepts, miscs, insights, rules, cfgRows] = await Promise.all([
    supabase.from('cms_topics').select('topic_id, chapter_id, class, topic_kind, taught_in_school, status').eq('chapter_id', h.chapter_id),
    all<{ typical_set_id: string; class: number; status: string }>((a, b) => supabase.from('cms_typical_sets').select('typical_set_id, class, status').range(a, b)),
    all<{ pattern_id: string }>((a, b) => supabase.from('cms_patterns').select('pattern_id').range(a, b)),
    all<{ concept_id: string; class: number }>((a, b) => supabase.from('cms_concepts').select('concept_id, class').range(a, b)),
    all<{ misconception_id: string }>((a, b) => supabase.from('cms_misconceptions').select('misconception_id').range(a, b)),
    supabase.from('cms_insights').select('insight_id, status'),
    supabase.from('cms_rule_versions').select('rule_version'),
    supabase.from('cms_config').select('key, value').in('key', ['multistep_bands', 'difficulty_points', 'load_thresholds']),
  ]);
  const conceptClass = new Map(concepts.map((c) => [c.concept_id, c.class]));
  for (const c of h.catalogue.concepts) conceptClass.set(String(c.concept_id), Number(c.class));
  const cat: Catalog = {
    ruleVersions: new Set(must<{ rule_version: string }[]>(rules).map((r) => r.rule_version).concat(ruleVersion)),
    chapter: { chapter_id: h.chapter_id, subject: h.subject },
    topics: new Map(must<{ topic_id: string; chapter_id: string; class: number; topic_kind: string; taught_in_school: boolean; status: string }[]>(topics).map((t) => [t.topic_id, t as never])),
    typicalSets: new Map([...sets.map((s) => [s.typical_set_id, { class: s.class, status: s.status }] as const),
      ...h.catalogue.typical_sets.map((s) => [String(s.typical_set_id), { class: Number(s.class), status: 'proposed' }] as const)]),
    patterns: new Set([...patterns.map((p) => p.pattern_id), ...h.catalogue.patterns.map((p) => String(p.pattern_id))]),
    concepts: new Map([...conceptClass].map(([id, cls]) => [id, { class: cls }])),
    misconceptions: new Set([...miscs.map((m) => m.misconception_id), ...h.catalogue.misconceptions.map((m) => String(m.misconception_id))]),
    insights: new Map(must<{ insight_id: string; status: string }[]>(insights).map((i) => [i.insight_id, { status: i.status }])),
    sourceItems: new Set(h.question.source_refs?.map((r) => r.ref_id) ?? []), stems: new Map(), keyToQuestionId: new Map(),
  };
  const cfg = Object.fromEntries(must<{ key: string; value: unknown }[]>(cfgRows).map((r) => [r.key, r.value])) as unknown as DerivedConfig;
  return { cat, cfg, conceptClass };
}

/** The importer's checks for this item on that topic, and the rows Place would write. */
export async function preparePlace(h: HeldItem, topicId: string): Promise<{ problems: Problem[]; payload: Record<string, unknown> | null }> {
  const ruleVersion = await loadCurrentRuleVersion();
  const { cat, cfg, conceptClass } = await catalogFor(h, ruleVersion);
  const q: Question = { ...structuredClone(h.question), topic_id: topicId };
  const file: ChapterFile = { file_schema: 'cms-chapter/1.0', attribute_version: ruleVersion, subject: h.subject as 'math', class: h.class, chapter_id: h.chapter_id,
    generated: { by: 'Held-out area', date: new Date().toISOString().slice(0, 10) }, questions: [q],
    patterns: h.catalogue.patterns.map((p) => ({ ...(p as never as NonNullable<ChapterFile['patterns']>[number]), topic_id: topicId })) };
  const problems = checkFile(file, cat, { gold: true }).filter((p) => p.key !== 'file' || p.level === 'error');
  if (problems.some((p) => p.level === 'error') || h.subject !== 'math') return { problems, payload: null };
  const rows = rowsFor(q, cfg, tierBasis({ level: h.level, class_override: q.class_override ?? null, class: h.class }), (id) => conceptClass.get(id));
  return { problems, payload: {
    held_id: h.held_id, topic_id: topicId, content_hash: structureHash(q, topicId),
    question: { class_override: q.class_override ?? null, placement_note: q.placement_note ?? null, typical_set_id: q.typical_set_id, pattern_id: q.pattern_id ?? null,
      clone_batch_id: q.clone_batch_id, locale: q.locale },
    version: rows.version, parts: rows.parts, options: rows.options, wrong_answers: rows.wrong_answers, concepts: rows.concepts,
    solutions: rows.solutions, hints: rows.hints, source_refs: rows.source_refs,
  } };
}

export async function placeHeld(payload: Record<string, unknown>, note: string | null) {
  const { data, error } = await supabase.rpc('cms_place_held_out', { p: { ...payload, note } });
  if (error) throw new Error(error.message);
  return data as { question_id: string; import_id: number };
}
export async function discardHeld(heldId: number, reason: string) {
  const { error } = await supabase.rpc('cms_discard_held_out', { p_held_id: heldId, p_reason: reason });
  if (error) throw new Error(error.message);
}

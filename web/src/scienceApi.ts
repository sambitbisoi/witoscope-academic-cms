// Science (13 Nov 2026; docs/science-plan.md): content rows (read-only), their questions and links.
import { all, type QuestionRow } from './api';
import { supabase } from './supabase';

export interface ContentRow {
  row_id: string; topic_id: string; chapter_id: string; row_class: number; type: string; chapter_role: string; content: string;
  why_it_matters: string | null; misconceptions: string | null; diagram_description: string | null; picture_question: boolean; question_use: string;
  safety: string | null; source: string; found_in: string | null; confidence: string | null; notes: string | null; time_sensitive: boolean;
  time_checked_year: number | null; accuracy_flag: boolean; book: string | null; book_chapter_no: number | null; book_chapter_title: string | null; sort: number;
  originality_result: string | null; originality_field: string | null; originality_score: number | null; originality_ref: string | null; originality_override: string | null;
  in_master: boolean;
  /** class information (0033): bare labels from the master; also_in_rows = row IDs from Notes "Also in C<n>: …" */
  topic_classes_mapped: string | null; topic_taught_in: string | null; revisit: string | null; also_in_rows: string[];
  appears_in: string | null;
}
export type RowStatus = 'direct' | 'supporting' | 'not_eligible' | 'none';
export type ScienceRow = ContentRow & { status: RowStatus; n_direct: number; n_supporting: number };
export type ScienceQuestion = QuestionRow & { level_tier: string | null; display_format: string | null; safety_note: string | null; links: { row_id: string; role: 'direct' | 'supporting' }[] };
export interface Citation { source_id: string; page_from: number; page_to: number; raw: string; for_row_id: string | null }

const ROW_COLS = 'row_id, topic_id, chapter_id, row_class, type, chapter_role, content, why_it_matters, misconceptions, diagram_description, picture_question, question_use, safety, source, found_in, confidence, notes, time_sensitive, time_checked_year, accuracy_flag, book, book_chapter_no, book_chapter_title, appears_in, sort, topic_classes_mapped, topic_taught_in, revisit, also_in_rows, originality_result, originality_field, originality_score, originality_ref, originality_override, in_master';

/** Everything the Science view shows, for one topic or every topic of a chapter. */
export async function scienceData(scope: { topicId: string } | { chapterId: string }) {
  const col = 'topicId' in scope ? 'topic_id' : 'chapter_id';
  const id = 'topicId' in scope ? scope.topicId : scope.chapterId;
  const [rows, status, questions] = await Promise.all([
    all<ContentRow>((a, b) => supabase.from('cms_content_rows').select(ROW_COLS).eq(col, id).order('sort').range(a, b)),
    all<{ row_id: string; status: RowStatus; n_direct: number; n_supporting: number }>((a, b) => supabase.from('cms_content_row_status').select('row_id, status, n_direct, n_supporting').eq(col, id).order('row_id').range(a, b)),
    all<QuestionRow>((a, b) => supabase.from('cms_question_list').select('*').eq(col, id).order('question_id').range(a, b)),
  ]);
  const vids = questions.map((q) => q.version_id);
  const [extra, links] = await Promise.all([
    vids.length ? all<{ version_id: number; level_tier: string | null; display_format: string | null; safety_note: string | null }>((a, b) => supabase.from('cms_question_versions').select('version_id, level_tier, display_format, safety_note').in('version_id', vids).range(a, b)) : Promise.resolve([]),
    vids.length ? all<{ version_id: number; row_id: string; role: 'direct' | 'supporting' }>((a, b) => supabase.from('cms_question_content_rows').select('version_id, row_id, role').in('version_id', vids).order('row_id').range(a, b)) : Promise.resolve([]),
  ]);
  const st = new Map(status.map((s) => [s.row_id, s]));
  const ex = new Map(extra.map((e) => [e.version_id, e]));
  return {
    rows: rows.map((r) => ({ ...r, status: st.get(r.row_id)?.status ?? 'none', n_direct: st.get(r.row_id)?.n_direct ?? 0, n_supporting: st.get(r.row_id)?.n_supporting ?? 0 })) as ScienceRow[],
    questions: questions.map((q) => ({ ...q, level_tier: ex.get(q.version_id)?.level_tier ?? null, display_format: ex.get(q.version_id)?.display_format ?? null,
      safety_note: ex.get(q.version_id)?.safety_note ?? null, links: links.filter((l) => l.version_id === q.version_id).map((l) => ({ row_id: l.row_id, role: l.role })) })) as ScienceQuestion[],
  };
}
export type ScienceData = Awaited<ReturnType<typeof scienceData>>;

/** The question detail's Science boxes: linked content rows (with their own fields) and the version's citations. */
export async function scienceDetail(versionId: number) {
  const links = (await supabase.from('cms_question_content_rows').select('row_id, role').eq('version_id', versionId)).data as { row_id: string; role: 'direct' | 'supporting' }[] ?? [];
  const [rows, cites, v] = await Promise.all([
    links.length ? supabase.from('cms_content_rows').select(ROW_COLS).in('row_id', links.map((l) => l.row_id)) : Promise.resolve({ data: [] }),
    supabase.from('cms_citations').select('source_id, page_from, page_to, raw, for_row_id').eq('version_id', versionId).order('citation_id'),
    supabase.from('cms_question_versions').select('level_tier, display_format, misconception_targeted, safety_note, confidence').eq('version_id', versionId).single(),
  ]);
  const byId = new Map(((rows.data ?? []) as ContentRow[]).map((r) => [r.row_id, r]));
  const citations = (cites.data ?? []) as Citation[];
  const srcIds = [...new Set(citations.map((c) => c.source_id))];
  const sources = srcIds.length ? ((await supabase.from('cms_sources').select('source_id, title, publisher').in('source_id', srcIds)).data ?? []) as { source_id: string; title: string; publisher: string }[] : [];
  return {
    links: links.map((l) => ({ ...l, row: byId.get(l.row_id) ?? null })).sort((a, b) => (a.role === b.role ? a.row_id.localeCompare(b.row_id) : a.role === 'direct' ? -1 : 1)),
    citations, sources: new Map(sources.map((s) => [s.source_id, s])),
    version: (v.data ?? {}) as { level_tier: string | null; display_format: string | null; misconception_targeted: string | null; safety_note: string | null; confidence: string | null },
  };
}

/** A content row's detail card: its citations (with source titles), the topic's approved classes
 *  (home class + active links) and where its "Also in" rows live (to open them). */
export async function rowDetail(r: Pick<ContentRow, 'row_id' | 'topic_id' | 'also_in_rows'>) {
  const [cites, classes, also] = await Promise.all([
    supabase.from('cms_citations').select('source_id, page_from, page_to, raw').eq('row_id', r.row_id).order('citation_id'),
    supabase.from('cms_topic_all_classes').select('class').eq('topic_id', r.topic_id),
    r.also_in_rows.length ? supabase.from('cms_content_rows').select('row_id, topic_id, chapter_id, content').in('row_id', r.also_in_rows) : Promise.resolve({ data: [], error: null }),
  ]);
  for (const x of [cites, classes, also]) if (x.error) throw new Error(x.error.message);
  const citations = (cites.data ?? []) as Omit<Citation, 'for_row_id'>[];
  const srcIds = [...new Set(citations.map((c) => c.source_id))];
  const sources = srcIds.length ? ((await supabase.from('cms_sources').select('source_id, title').in('source_id', srcIds)).data ?? []) as { source_id: string; title: string }[] : [];
  const where = new Map(((also.data ?? []) as { row_id: string; topic_id: string; chapter_id: string; content: string }[]).map((x) => [x.row_id, x]));
  return {
    citations, sources: new Map(sources.map((s) => [s.source_id, s.title])),
    classes: [...new Set(((classes.data ?? []) as { class: number }[]).map((c) => c.class))].sort(),
    alsoIn: r.also_in_rows.map((id) => ({ row_id: id, at: where.get(id) ?? null })),
  };
}

/** Content-row coverage per topic and row class (Home and the curriculum map). */
export async function contentRowStats() {
  return all<{ topic_id: string; chapter_id: string; class: number; n_rows: number; n_direct: number; n_supporting: number; n_not_eligible: number; n_none: number }>(
    (a, b) => supabase.from('cms_content_row_stats').select('*').order('topic_id').order('class').range(a, b));
}

/** Content rows that exist (Add question / bulk upload check the IDs). */
export async function knownContentRows(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { data, error } = await supabase.from('cms_content_rows').select('row_id').in('row_id', ids);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((r: { row_id: string }) => r.row_id));
}

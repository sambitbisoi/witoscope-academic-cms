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
  /** Q14 (17 Nov 2026): retired rows are kept (never deleted); cms_edited_at = changed in the CMS (the master) */
  retired_at: string | null; retired_reason: string | null; cms_edited_at: string | null;
}
export type RowStatus = 'direct' | 'supporting' | 'not_eligible' | 'none';
export type ScienceRow = ContentRow & { status: RowStatus; n_direct: number; n_supporting: number };
/** level_tier here = the retired authored tier (Q27: science_tier_legacy, or level_tier on versions from before 0041) */
export type ScienceQuestion = QuestionRow & { level_tier: string | null; science_question_type: number | null; /** Q29 (0042, cms_question_list) */ markers?: number | null; display_format: string | null; safety_note: string | null; links: { row_id: string; role: 'direct' | 'supporting'; rank?: string; rank_proposed?: boolean; /** 0048 */ primary_rejected?: boolean }[] };
export interface Citation { source_id: string; page_from: number; page_to: number; raw: string; for_row_id: string | null }

const ROW_COLS = 'row_id, topic_id, chapter_id, row_class, type, chapter_role, content, why_it_matters, misconceptions, diagram_description, picture_question, question_use, safety, source, found_in, confidence, notes, time_sensitive, time_checked_year, accuracy_flag, book, book_chapter_no, book_chapter_title, appears_in, sort, topic_classes_mapped, topic_taught_in, revisit, also_in_rows, originality_result, originality_field, originality_score, originality_ref, originality_override, in_master, retired_at, retired_reason, cms_edited_at';

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
    vids.length ? all<{ version_id: number; level_tier: string | null; science_tier_legacy: string | null; science_question_type: number | null; display_format: string | null; safety_note: string | null }>((a, b) => supabase.from('cms_question_versions').select('version_id, level_tier, science_tier_legacy, science_question_type, display_format, safety_note').in('version_id', vids).range(a, b)) : Promise.resolve([]),
    vids.length ? all<{ version_id: number; row_id: string; role: 'direct' | 'supporting'; rank: string; rank_proposed: boolean; primary_rejected: boolean }>((a, b) => supabase.from('cms_question_content_rows').select('version_id, row_id, role, rank, rank_proposed, primary_rejected').in('version_id', vids).order('row_id').range(a, b)) : Promise.resolve([]),
  ]);
  const st = new Map(status.map((s) => [s.row_id, s]));
  const ex = new Map(extra.map((e) => [e.version_id, e]));
  return {
    rows: rows.map((r) => ({ ...r, status: st.get(r.row_id)?.status ?? 'none', n_direct: st.get(r.row_id)?.n_direct ?? 0, n_supporting: st.get(r.row_id)?.n_supporting ?? 0 })) as ScienceRow[],
    questions: questions.map((q) => ({ ...q, level_tier: ex.get(q.version_id)?.science_tier_legacy ?? ex.get(q.version_id)?.level_tier ?? null,
      science_question_type: ex.get(q.version_id)?.science_question_type ?? null, display_format: ex.get(q.version_id)?.display_format ?? null,
      safety_note: ex.get(q.version_id)?.safety_note ?? null, links: links.filter((l) => l.version_id === q.version_id).map((l) => ({ row_id: l.row_id, role: l.role, rank: l.rank, rank_proposed: l.rank_proposed, primary_rejected: l.primary_rejected })) })) as ScienceQuestion[],
  };
}
export type ScienceData = Awaited<ReturnType<typeof scienceData>>;

/** 0035: a content row's misconception item ("C6-04-014 #2"). */
export interface RowItem { row_id: string; item_no: number; text: string; status: 'active' | 'needs_review' | 'retired'; source: string; unclear: boolean; split_note: string | null; proposed_by: string | null }
export type Rank = 'primary' | 'secondary' | 'context';
export interface Link { row_id: string; role: 'direct' | 'supporting'; rank: Rank; rank_proposed: boolean; weight: number; /** 0048 */ primary_rejected: boolean }
const ITEM_COLS = 'row_id, item_no, text, status, source, unclear, split_note, proposed_by';

/** Items of some content rows (row order kept by the caller), retired ones included only when asked. */
export async function rowItems(rowIds: string[], withRetired = false): Promise<RowItem[]> {
  if (!rowIds.length) return [];
  let q = supabase.from('cms_row_misconceptions').select(ITEM_COLS).in('row_id', rowIds);
  if (!withRetired) q = q.neq('status', 'retired');
  const { data, error } = await q.order('row_id').order('item_no');
  if (error) throw new Error(error.message);
  return (data ?? []) as RowItem[];
}

/** The question detail's Science boxes: linked content rows (with their own fields and items), the version's citations,
 *  its misconception item and the wrong options' items (0035). */
export async function scienceDetail(versionId: number) {
  const links = (await supabase.from('cms_question_content_rows').select('row_id, role, rank, rank_proposed, weight, primary_rejected').eq('version_id', versionId)).data as Link[] ?? [];
  const [rows, cites, v, items, wrong] = await Promise.all([
    links.length ? supabase.from('cms_content_rows').select(ROW_COLS).in('row_id', links.map((l) => l.row_id)) : Promise.resolve({ data: [] }),
    supabase.from('cms_citations').select('source_id, page_from, page_to, raw, for_row_id').eq('version_id', versionId).order('citation_id'),
    supabase.from('cms_question_versions').select('level_tier, science_tier_legacy, science_question_type, setting_familiarity, has_hidden_idea, has_experiment, display_format, misconception_targeted, misconception_targeted_legacy, misconception_row_id, misconception_item_no, safety_note, confidence').eq('version_id', versionId).single(),
    rowItems(links.map((l) => l.row_id), true),
    supabase.from('cms_version_wrong_answers').select('option_position, tag, mc_row_id, mc_item_no, target_row_id').eq('version_id', versionId).not('tag', 'is', null),
  ]);
  const byId = new Map(((rows.data ?? []) as ContentRow[]).map((r) => [r.row_id, r]));
  const citations = (cites.data ?? []) as Citation[];
  const srcIds = [...new Set(citations.map((c) => c.source_id))];
  const sources = srcIds.length ? ((await supabase.from('cms_sources').select('source_id, title, publisher').in('source_id', srcIds)).data ?? []) as { source_id: string; title: string; publisher: string }[] : [];
  return {
    links: links.map((l) => ({ ...l, weight: Number(l.weight), row: byId.get(l.row_id) ?? null }))
      .sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank] || a.row_id.localeCompare(b.row_id)),
    citations, sources: new Map(sources.map((s) => [s.source_id, s])),
    version: (v.data ?? {}) as { level_tier: string | null; science_tier_legacy: string | null; science_question_type: number | null; setting_familiarity: string | null;
      has_hidden_idea: boolean | null; has_experiment: boolean | null; display_format: string | null; misconception_targeted: string | null; misconception_targeted_legacy: string | null;
      misconception_row_id: string | null; misconception_item_no: number | null; safety_note: string | null; confidence: string | null },
    items,
    wrongItems: new Map(((wrong.data ?? []) as WrongTagRow[])
      .filter((w) => w.option_position !== null && w.mc_row_id).map((w) => [w.option_position!, `${w.mc_row_id} #${w.mc_item_no}`])),
    /** Q32 (0041): each tagged wrong option, encoded "tag|ref" (ref = "C6-04-014 #2" for a misconception, a row ID for a concept error) */
    wrongTags: new Map(((wrong.data ?? []) as WrongTagRow[]).filter((w) => w.option_position !== null)
      .map((w) => [w.option_position!, encodeWrongTag(w)])),
  };
}

/** A content row's detail card: its citations (with source titles), the topic's approved classes
 *  (home class + active links) and where its "Also in" rows live (to open them). */
export async function rowDetail(r: Pick<ContentRow, 'row_id' | 'topic_id' | 'also_in_rows'>) {
  const [cites, classes, also, home, items] = await Promise.all([
    supabase.from('cms_citations').select('source_id, page_from, page_to, raw').eq('row_id', r.row_id).order('citation_id'),
    supabase.from('cms_topic_all_classes').select('class').eq('topic_id', r.topic_id),
    r.also_in_rows.length ? supabase.from('cms_content_rows').select('row_id, topic_id, chapter_id, content').in('row_id', r.also_in_rows) : Promise.resolve({ data: [], error: null }),
    supabase.from('cms_topics').select('class').eq('topic_id', r.topic_id).maybeSingle(),
    rowItems([r.row_id], true),
  ]);
  for (const x of [cites, classes, also, home]) if (x.error) throw new Error(x.error.message);
  const citations = (cites.data ?? []) as Omit<Citation, 'for_row_id'>[];
  const srcIds = [...new Set(citations.map((c) => c.source_id))];
  const sources = srcIds.length ? ((await supabase.from('cms_sources').select('source_id, title').in('source_id', srcIds)).data ?? []) as { source_id: string; title: string }[] : [];
  const where = new Map(((also.data ?? []) as { row_id: string; topic_id: string; chapter_id: string; content: string }[]).map((x) => [x.row_id, x]));
  return {
    citations, sources: new Map(sources.map((s) => [s.source_id, s.title])),
    classes: [...new Set(((classes.data ?? []) as { class: number }[]).map((c) => c.class))].sort(),
    alsoIn: r.also_in_rows.map((id) => ({ row_id: id, at: where.get(id) ?? null })),
    /** Q12: the topic's home class (cms_topics.class) */
    homeClass: ((home.data ?? null) as { class: number } | null)?.class ?? null,
    /** 0035: the row's misconception items */
    items,
  };
}

const RANK_ORDER: Record<Rank, number> = { primary: 0, secondary: 1, context: 2 };
export type ScienceDetail = Awaited<ReturnType<typeof scienceDetail>>;

/** The Science review box (0035): misconception item, wrong options' items, primary row, Solution 1. Open drafts only; audited. */
type WrongTagRow = { option_position: number | null; tag: string; mc_row_id: string | null; mc_item_no: number | null; target_row_id: string | null };
export const encodeWrongTag = (w: { tag: string | null; mc_row_id?: string | null; mc_item_no?: number | null; target_row_id?: string | null }) =>
  !w.tag ? '' : `${w.tag}|${w.tag === 'misconception' && w.mc_row_id ? `${w.mc_row_id} #${w.mc_item_no}` : w.tag === 'concept_error' && w.target_row_id ? w.target_row_id : ''}`;
export async function saveScienceReview(p: { question_id: string; version_no: number; reason?: string; misconception?: { row_id: string; item_no: number } | null;
  wrong?: ({ position: number; mc: { row_id: string; item_no: number } | null } | { position: number; tag: string | null; mc?: { row_id: string; item_no: number }; target_row_id?: string })[];
  primary_row_id?: string; solution1?: string }) {
  const { data, error } = await supabase.rpc('cms_save_science_review', { p });
  if (error) throw new Error(error.message);
  return data as { changed: boolean };
}

/** Proposed → Misconception items: approve (active), retire (reason) or back to needs review. Audited. */
export async function setRowItemStatus(rowId: string, itemNo: number, status: 'active' | 'retired' | 'needs_review', reason: string | null) {
  const { error } = await supabase.rpc('cms_set_row_misconception_status', { p_row_id: rowId, p_item_no: itemNo, p_status: status, p_reason: reason });
  if (error) throw new Error(error.message);
}
/** Items for the Proposed tab, with the questions that use each (current versions). */
export async function itemsByStatus(status: 'active' | 'needs_review' | 'retired') {
  const items = await all<RowItem>((a, b) => supabase.from('cms_row_misconceptions').select(ITEM_COLS).eq('status', status).order('row_id').order('item_no').range(a, b));
  const rows = items.length ? await all<{ row_id: string; topic_id: string; row_class: number; content: string }>((a, b) =>
    supabase.from('cms_content_rows').select('row_id, topic_id, row_class, content').in('row_id', [...new Set(items.map((i) => i.row_id))]).range(a, b)) : [];
  const rowMap = new Map(rows.map((r) => [r.row_id, r]));
  return items.map((i) => ({ ...i, row: rowMap.get(i.row_id) ?? null }));
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

// ---------------------------------------------------------------- Q14: content rows edited in the CMS (cms_save_content_row)
export interface RowFields {
  row_class: number; type: string; chapter_role: string; content: string; why_it_matters: string | null; diagram_description: string | null;
  question_use: string; safety: string | null; also_in_rows: string[]; notes: string | null; picture_question: boolean; confidence: string | null;
}
export type ItemChange = { item_no: number | null; action: 'add' | 'edit' | 'retire' | 'restore'; text?: string };
export const ROW_TYPES = ['Fact', 'Concept', 'How it works', 'Experiment', 'Scenario-Case', 'Diagram', 'Vocabulary'] as const;
export const CHAPTER_ROLES = ['Core', 'Extension', 'Preview'] as const;
export const QUESTION_USES = ['OK', 'Misconception only', 'No questions'] as const;

export async function saveContentRow(p: { mode: 'create' | 'update' | 'retire' | 'restore'; row_id?: string; topic_id?: string; code?: string;
  fields?: Partial<RowFields>; items?: ItemChange[]; reason?: string | null }) {
  const { data, error } = await supabase.rpc('cms_save_content_row', { p });
  if (error) throw new Error(error.message);
  return data as { row_id: string; changed: boolean };
}

/** Chapter codes used by a topic's rows, per row class, most used first (the middle part of C6-04-014). */
export async function topicRowCodes(topicId: string): Promise<Map<number, { code: string; n: number }[]>> {
  const rows = await all<{ row_id: string }>((a, b) => supabase.from('cms_content_rows').select('row_id').eq('topic_id', topicId).range(a, b));
  const by = new Map<number, Map<string, number>>();
  for (const r of rows) {
    const m = /^C([1-6])-([0-9A-Z]{2,4})-\d{3}$/.exec(r.row_id); if (!m) continue;
    const cls = Number(m[1]), code = m[2]!;
    const x = by.get(cls) ?? new Map<string, number>(); x.set(code, (x.get(code) ?? 0) + 1); by.set(cls, x);
  }
  return new Map([...by].map(([c, m]) => [c, [...m].map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n || a.code.localeCompare(b.code))]));
}
/** The next free number of a prefix (the database assigns it again on Save; this is the preview). */
export async function nextRowId(cls: number, code: string): Promise<string> {
  const prefix = `C${cls}-${code}-`;
  const { data, error } = await supabase.from('cms_content_rows').select('row_id').like('row_id', `${prefix}%`).order('row_id', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  const last = (data ?? [])[0]?.row_id as string | undefined;
  return `${prefix}${String((last ? Number(last.slice(-3)) : 0) + 1).padStart(3, '0')}`;
}
/** Current (non-retired) questions that use a row: as a direct / supporting row, and per misconception item. */
export async function rowUsage(rowId: string) {
  const [links, targeted, wrong] = await Promise.all([
    supabase.from('cms_question_content_rows').select('version_id, role').eq('row_id', rowId),
    supabase.from('cms_question_versions').select('version_id, misconception_item_no').eq('misconception_row_id', rowId),
    supabase.from('cms_version_wrong_answers').select('version_id, mc_item_no').eq('mc_row_id', rowId),
  ]);
  for (const r of [links, targeted, wrong]) if (r.error) throw new Error(r.error.message);
  const vids = [...new Set([...(links.data ?? []), ...(targeted.data ?? []), ...(wrong.data ?? [])].map((x) => x.version_id as number))];
  const cur = vids.length ? await all<{ version_id: number; question_id: string; retired_at: string | null }>((a, b) =>
    supabase.from('cms_question_list').select('version_id, question_id, retired_at').in('version_id', vids).range(a, b)) : [];
  const q = new Map(cur.filter((c) => !c.retired_at).map((c) => [c.version_id, c.question_id]));
  const ids = (xs: { version_id: number }[]) => [...new Set(xs.map((x) => q.get(x.version_id)).filter((x): x is string => !!x))].sort();
  const items = new Map<number, string[]>();
  for (const x of [...(targeted.data ?? []).map((t) => ({ version_id: t.version_id as number, n: t.misconception_item_no as number })),
    ...(wrong.data ?? []).map((w) => ({ version_id: w.version_id as number, n: w.mc_item_no as number }))]) {
    const id = q.get(x.version_id); if (!id) continue;
    items.set(x.n, [...new Set([...(items.get(x.n) ?? []), id])].sort());
  }
  return { direct: ids((links.data ?? []).filter((l) => l.role === 'direct') as { version_id: number }[]),
    supporting: ids((links.data ?? []).filter((l) => l.role === 'supporting') as { version_id: number }[]), items };
}
/** The classes a topic is linked to (home + approved links). */
export async function topicClasses(topicId: string): Promise<number[]> {
  const { data, error } = await supabase.from('cms_topic_all_classes').select('class').eq('topic_id', topicId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((x) => x.class as number).sort();
}

// ---------------------------------------------------------------- Q23 (0044): linked content rows on a Science draft
export interface LinkedRow { row_id: string; rank: Rank; rank_proposed: boolean; row: { content: string; topic_id: string; chapter_id: string; row_class: number; retired_at: string | null } | null }
/** A version's links (with a short view of each row) and the references that keep rows on it. */
export async function linkedContent(versionId: number) {
  const [l, v, w] = await Promise.all([
    supabase.from('cms_question_content_rows').select('row_id, rank, rank_proposed').eq('version_id', versionId),
    supabase.from('cms_question_versions').select('misconception_row_id, misconception_item_no').eq('version_id', versionId).single(),
    supabase.from('cms_version_wrong_answers').select('option_position, mc_row_id, mc_item_no, target_row_id').eq('version_id', versionId).not('option_position', 'is', null),
  ]);
  for (const r of [l, v, w]) if (r.error) throw new Error(r.error.message);
  const links = (l.data ?? []) as { row_id: string; rank: Rank; rank_proposed: boolean }[];
  const rows = links.length ? must((await supabase.from('cms_content_rows').select('row_id, content, topic_id, chapter_id, row_class, retired_at').in('row_id', links.map((x) => x.row_id)))) : [];
  const byId = new Map((rows as ({ row_id: string } & NonNullable<LinkedRow['row']>)[]).map((r) => [r.row_id, r]));
  const refs: { row_id: string; what: string }[] = [];
  const vv = v.data as { misconception_row_id: string | null; misconception_item_no: number | null } | null;
  if (vv?.misconception_row_id) refs.push({ row_id: vv.misconception_row_id, what: `the misconception targeted (${vv.misconception_row_id} #${vv.misconception_item_no})` });
  for (const x of (w.data ?? []) as { option_position: number; mc_row_id: string | null; mc_item_no: number | null; target_row_id: string | null }[]) {
    const L = String.fromCharCode(64 + x.option_position);
    if (x.mc_row_id) refs.push({ row_id: x.mc_row_id, what: `option ${L}'s misconception (${x.mc_row_id} #${x.mc_item_no})` });
    if (x.target_row_id) refs.push({ row_id: x.target_row_id, what: `option ${L}'s concept-error target` });
  }
  return {
    links: links.map((x) => ({ ...x, row: byId.get(x.row_id) ?? null })).sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank] || a.row_id.localeCompare(b.row_id)) as LinkedRow[],
    refs,
  };
}
const must = <T,>(r: { data: T | null; error: { message: string } | null }) => { if (r.error) throw new Error(r.error.message); return (r.data ?? []) as T; };
/** "+ Link a row": rows (not retired) whose ID starts with, or whose text contains, the search. */
export async function searchContentRows(text: string, exclude: string[]) {
  const s = text.trim().replace(/[,()*%\\]/g, ' ').trim();
  if (s.length < 2) return [];
  const { data, error } = await supabase.from('cms_content_rows').select('row_id, content, topic_id, row_class')
    .is('retired_at', null).or(`row_id.ilike.${s}%,content.ilike.%${s}%`).order('row_id').limit(15);
  if (error) throw new Error(error.message);
  return ((data ?? []) as { row_id: string; content: string; topic_id: string; row_class: number }[]).filter((r) => !exclude.includes(r.row_id)).slice(0, 12);
}
/** Save the full set of links of an open Science draft (cms_save_content_links). Audited before → after. */
export async function saveContentLinks(p: { question_id: string; version_no: number; reason?: string; links: { row_id: string; rank: Rank }[] }) {
  const { data, error } = await supabase.rpc('cms_save_content_links', { p });
  if (error) throw new Error(error.message);
  return data as { changed: boolean; links: string[] };
}

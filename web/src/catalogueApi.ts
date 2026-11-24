// Review UX (15 Nov 2026), Q8 / Q10: proposed (and decided) catalogue items with their Kind, class,
// topic, chapter, strand and subject, and one item's details for the right-hand pane.
// Reads only, except decide(), which goes through the existing audited functions
// (cms_set_catalogue_status, cms_decide_topic_class). No new approval path; nothing is deleted.
import { all } from './api';
import { setCatalogueStatus } from './editApi';
import { catalogueClass, classFromId, subjectOfChapter, type Subject } from './logic';
import { supabase } from './supabase';

export { CAT_KINDS, KIND_LABEL, TAB_LABEL, decidable, kindLine, itemParam, parseItem, type CatKind, type Show, type CatItem } from './catalogueLogic';
import type { CatItem, CatKind, Show } from './catalogueLogic';

interface Place { topic_id: string; chapter_id: string; class: number; name: string }
interface ChapterRow { chapter_id: string; name: string; strand_id: string; subject: Subject }
export interface Places { topics: Map<string, Place>; chapters: Map<string, ChapterRow>; strands: Map<string, { strand_id: string; name: string; subject: string }> }

/** Topics, chapters and strands, to place every item (read once per screen). */
export async function loadPlaces(): Promise<Places> {
  const [topics, chapters, strands] = await Promise.all([
    all<Place>((a, b) => supabase.from('cms_topics').select('topic_id, chapter_id, class, name').order('topic_id').range(a, b)),
    all<ChapterRow>((a, b) => supabase.from('cms_chapters').select('chapter_id, name, strand_id, subject').order('chapter_id').range(a, b)),
    all<{ strand_id: string; name: string; subject: string }>((a, b) => supabase.from('cms_strands').select('strand_id, name, subject').order('strand_id').range(a, b)),
  ]);
  return { topics: new Map(topics.map((t) => [t.topic_id, t])), chapters: new Map(chapters.map((c) => [c.chapter_id, c])), strands: new Map(strands.map((s) => [s.strand_id, s])) };
}

const ROLE_TEXT: Record<string, string> = { lower: 'from a lower class', higher: 'from a higher class' };

/** Every item of every kind with this status, placed and classed (Q10). */
export async function loadItems(show: Show, places: Places): Promise<CatItem[]> {
  const [concepts, miscs, sets, patterns, settings, links, proposals] = await Promise.all([
    all<{ concept_id: string; name: string; class: number | null; topic_id: string | null; status: string; description: string | null }>((a, b) =>
      supabase.from('cms_concepts').select('concept_id, name, class, topic_id, status, description').eq('status', show).order('concept_id').range(a, b)),
    all<{ misconception_id: string; description: string; concept_id: string | null; status: string }>((a, b) =>
      supabase.from('cms_misconceptions').select('misconception_id, description, concept_id, status').eq('status', show).order('misconception_id').range(a, b)),
    all<{ typical_set_id: string; name: string; class: number | null; topic_id: string | null; chapter_id: string | null; status: string; instruction_pattern: string | null }>((a, b) =>
      supabase.from('cms_typical_sets').select('typical_set_id, name, class, topic_id, chapter_id, status, instruction_pattern').eq('status', show).order('typical_set_id').range(a, b)),
    all<{ pattern_id: string; name: string; typical_set_id: string; topic_id: string | null; status: string }>((a, b) =>
      supabase.from('cms_patterns').select('pattern_id, name, typical_set_id, topic_id, status').eq('status', show).order('pattern_id').range(a, b)),
    all<{ setting_id: string; name: string; description: string | null; theme: string | null; status: string; subject: Subject }>((a, b) =>
      supabase.from('cms_settings').select('setting_id, name, description, theme, status, subject').eq('status', show).order('setting_id').range(a, b)),
    all<{ topic_id: string; class: number; source: string; evidence: string | null; suggested_role: string; status: string }>((a, b) =>
      supabase.from('cms_topic_class_proposals').select('topic_id, class, source, evidence, suggested_role, status').eq('status', show).order('topic_id').order('class').range(a, b)),
    all<{ item_kind: string; item_id: string; proposed_by: string; used_by: string[] }>((a, b) =>
      supabase.from('cms_catalogue_proposals').select('item_kind, item_id, proposed_by, used_by').order('item_id').order('proposed_by').range(a, b)),
  ]);
  // the concepts behind misconceptions and the question types behind patterns (any status)
  const needConcepts = [...new Set(miscs.map((m) => m.concept_id).filter((x): x is string => !!x))];
  const needSets = [...new Set(patterns.map((p) => p.typical_set_id))];
  const [mConcepts, pSets] = await Promise.all([
    chunked(needConcepts, (ids) => supabase.from('cms_concepts').select('concept_id, class, topic_id').in('concept_id', ids)) as Promise<{ concept_id: string; class: number | null; topic_id: string | null }[]>,
    chunked(needSets, (ids) => supabase.from('cms_typical_sets').select('typical_set_id, class, topic_id').in('typical_set_id', ids)) as Promise<{ typical_set_id: string; class: number | null; topic_id: string | null }[]>,
  ]);
  const conceptOf = new Map(mConcepts.map((c) => [c.concept_id, c]));
  const setOf = new Map(pSets.map((s) => [s.typical_set_id, s]));
  const by = new Map<string, { p: string[]; u: Set<string> }>();
  for (const l of proposals) {
    const k = `${l.item_kind}:${l.item_id}`;
    const e = by.get(k) ?? { p: [], u: new Set<string>() };
    e.p.push(l.proposed_by); for (const u of l.used_by ?? []) e.u.add(u);
    by.set(k, e);
  }
  const place = (topicId: string | null, chapterId?: string | null) => {
    const t = topicId ? places.topics.get(topicId) : undefined;
    const ch = t?.chapter_id ?? chapterId ?? null;
    const c = ch ? places.chapters.get(ch) : undefined;
    return { topic_id: topicId, chapter_id: ch, strand_id: c?.strand_id ?? null, subject: c?.subject ?? (ch ? subjectOfChapter(ch) : null) };
  };
  const src = (kind: string, id: string) => { const l = by.get(`${kind}:${id}`); return { proposedBy: l?.p ?? [], usedBy: [...(l?.u ?? [])].sort() }; };
  const out: CatItem[] = [];
  for (const r of concepts) out.push({ kind: 'concept', id: r.concept_id, label: r.name, detail: r.description ?? '', status: r.status, ...place(r.topic_id),
    cls: catalogueClass(r.concept_id, r.class), via: r.class ? null : 'from its ID', ...src('concept', r.concept_id) });
  for (const r of miscs) {
    const c = r.concept_id ? conceptOf.get(r.concept_id) : undefined;
    const own = classFromId(r.misconception_id);
    out.push({ kind: 'misconception', id: r.misconception_id, label: r.description, detail: r.concept_id ? `concept ${r.concept_id}` : '', status: r.status, ...place(c?.topic_id ?? null),
      cls: own ?? c?.class ?? null, via: own ? null : c?.class ? 'via its concept' : null, ...src('misconception', r.misconception_id) });
  }
  for (const r of sets) out.push({ kind: 'typical_set', id: r.typical_set_id, label: r.name, detail: r.instruction_pattern ? `"${r.instruction_pattern}"` : '', status: r.status, ...place(r.topic_id, r.chapter_id),
    cls: catalogueClass(r.typical_set_id, r.class), via: r.class ? null : 'from its ID', ...src('typical_set', r.typical_set_id) });
  for (const r of patterns) {
    const s = setOf.get(r.typical_set_id);
    out.push({ kind: 'pattern', id: r.pattern_id, label: r.name, detail: `question type ${r.typical_set_id}`, status: r.status, ...place(r.topic_id ?? s?.topic_id ?? null),
      cls: s ? catalogueClass(r.typical_set_id, s.class) : classFromId(r.typical_set_id), via: 'via its question type', ...src('pattern', r.pattern_id) });
  }
  for (const r of links) {
    const t = places.topics.get(r.topic_id);
    out.push({ kind: 'topic_class', id: `${r.topic_id}·${r.class}`, label: `${t?.name ?? r.topic_id} → also in Class ${r.class}`,
      detail: `Home class ${t?.class ?? '?'} · suggested role: ${ROLE_TEXT[r.suggested_role] ?? r.suggested_role}${r.evidence ? ` · ${r.evidence}` : ''}`,
      status: r.status, ...place(r.topic_id), cls: r.class, via: null, proposedBy: [r.source], usedBy: [] });
  }
  for (const r of settings) out.push({ kind: 'setting', id: r.setting_id, label: r.name, detail: [r.theme, r.description].filter(Boolean).join(' · '), status: r.status,
    topic_id: null, chapter_id: null, strand_id: null, subject: r.subject ?? null, cls: null, via: null, ...src('setting', r.setting_id) }); // Q28: settings have a subject
  return out;
}

async function chunked<T>(ids: string[], q: (ids: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await q(ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

// ---------------------------------------------------------------- one item, for the right-hand pane
export interface QRef { question_id: string; file_key: string | null; topic_id: string; status: string; level: number | null; effective_level: number; text: string }
export interface ItemDetail {
  kind: CatKind; id: string; name: string; description: string | null; status: string; cls: number | null; via: string | null;
  topic: { topic_id: string; name: string; class: number } | null; chapter: { chapter_id: string; name: string } | null;
  facts: { k: string; v: string }[];
  linked: { label: string; items: { id: string; name: string; status?: string; kind?: CatKind }[] }[];
  questions: QRef[]; questionsMore: boolean;
  proposedBy: string[]; usedBy: string[];
  history: { review_id: number; action: string; reason: string | null; at: string; by_label: string }[];
  /** for Edit (pattern form): the question types of the topic */ setOptions: [string, string][];
  /** Q24: why the class is what it is (concepts lowered to "first taught in"), shown muted after the class */ classNote?: string;
}

const must = <T>(r: { data: unknown; error: { message: string } | null }): T => { if (r.error) throw new Error(r.error.message); return r.data as T; };
const QCOLS = 'question_id, file_key, topic_id, status, level, effective_level, text';
const QLIMIT = 100;

export async function itemDetail(kind: CatKind, id: string, places?: Places): Promise<ItemDetail | null> {
  const pl = places ?? await loadPlaces();
  const topicOf = (t: string | null | undefined) => { const x = t ? pl.topics.get(t) : undefined; return x ? { topic_id: x.topic_id, name: x.name, class: x.class } : null; };
  const chapterOf = (t: string | null | undefined, ch?: string | null) => { const c = (t ? pl.topics.get(t)?.chapter_id : null) ?? ch; const x = c ? pl.chapters.get(c) : undefined; return x ? { chapter_id: x.chapter_id, name: x.name } : null; };
  const [hist, props] = await Promise.all([
    supabase.from('cms_reviews').select('review_id, action, reason, at, by_label').eq('target_id', kind === 'topic_class' ? id.replace('·', ' · class ') : id).order('review_id', { ascending: false }).limit(8),
    kind === 'topic_class' ? Promise.resolve({ data: [], error: null }) : supabase.from('cms_catalogue_proposals').select('proposed_by, used_by').eq('item_kind', kind).eq('item_id', id),
  ]);
  const history = must<ItemDetail['history']>(hist);
  const pr = must<{ proposed_by: string; used_by: string[] }[]>(props);
  const proposedBy = pr.map((p) => p.proposed_by), usedBy = [...new Set(pr.flatMap((p) => p.used_by ?? []))].sort();
  const qBy = async (col: string, val: string) => {
    const rows = must<QRef[]>(await supabase.from('cms_question_list').select(QCOLS).eq(col, val).order('question_id').limit(QLIMIT + 1));
    return { questions: rows.slice(0, QLIMIT), questionsMore: rows.length > QLIMIT };
  };
  const qByVersions = async (versionIds: number[]) => {
    if (!versionIds.length) return { questions: [], questionsMore: false };
    const ids = [...new Set(versionIds)].slice(0, 500);
    const rows = must<QRef[]>(await supabase.from('cms_question_list').select(QCOLS).in('version_id', ids).order('question_id').limit(QLIMIT + 1));
    return { questions: rows.slice(0, QLIMIT), questionsMore: rows.length > QLIMIT || versionIds.length > 500 };
  };
  const base = { kind, id, proposedBy, usedBy, history, setOptions: [] as [string, string][] };

  if (kind === 'concept') {
    const c = must<{ concept_id: string; name: string; class: number | null; type: string | null; status: string; topic_id: string | null; description: string | null;
      class_legacy: number | null; class_basis: string | null } | null>(
      await supabase.from('cms_concepts').select('concept_id, name, class, type, status, topic_id, description, class_legacy, class_basis').eq('concept_id', id).maybeSingle());
    if (!c) return null;
    const [miscs, sets, vc] = await Promise.all([
      supabase.from('cms_misconceptions').select('misconception_id, description, status').eq('concept_id', id).order('misconception_id').limit(50),
      supabase.from('cms_typical_set_concepts').select('typical_set_id, role').eq('concept_id', id).limit(50),
      supabase.from('cms_version_concepts').select('version_id').eq('concept_id', id).limit(2000),
    ]);
    const setRows = must<{ typical_set_id: string; role: string }[]>(sets);
    const setNames = setRows.length ? must<{ typical_set_id: string; name: string; status: string }[]>(await supabase.from('cms_typical_sets').select('typical_set_id, name, status').in('typical_set_id', setRows.map((s) => s.typical_set_id))) : [];
    return { ...base, name: c.name, description: c.description, status: c.status, cls: catalogueClass(c.concept_id, c.class), via: c.class ? null : 'from its ID',
      classNote: c.class_basis === 'first_taught' && c.class_legacy ? `first taught in · was Class ${c.class_legacy}` : undefined,
      topic: topicOf(c.topic_id), chapter: chapterOf(c.topic_id), facts: c.type ? [{ k: 'Type', v: c.type }] : [],
      linked: [
        { label: 'Question types', items: setRows.map((s) => ({ id: s.typical_set_id, name: `${setNames.find((x) => x.typical_set_id === s.typical_set_id)?.name ?? ''}${s.role ? ` (${s.role})` : ''}`, status: setNames.find((x) => x.typical_set_id === s.typical_set_id)?.status, kind: 'typical_set' as const })) },
        { label: 'Misconceptions', items: must<{ misconception_id: string; description: string; status: string }[]>(miscs).map((m) => ({ id: m.misconception_id, name: m.description, status: m.status, kind: 'misconception' as const })) },
      ],
      ...(await qByVersions(must<{ version_id: number }[]>(vc).map((x) => x.version_id))) };
  }
  if (kind === 'typical_set') {
    const s = must<{ typical_set_id: string; name: string; class: number | null; status: string; topic_id: string | null; chapter_id: string | null; instruction_pattern: string | null; variant_note: string | null; parent_visible: boolean } | null>(
      await supabase.from('cms_typical_sets').select('typical_set_id, name, class, status, topic_id, chapter_id, instruction_pattern, variant_note, parent_visible').eq('typical_set_id', id).maybeSingle());
    if (!s) return null;
    const [pats, cons] = await Promise.all([
      supabase.from('cms_patterns').select('pattern_id, name, status').eq('typical_set_id', id).order('pattern_id'),
      supabase.from('cms_typical_set_concepts').select('concept_id, role').eq('typical_set_id', id),
    ]);
    const cr = must<{ concept_id: string; role: string }[]>(cons);
    const cn = cr.length ? must<{ concept_id: string; name: string; status: string }[]>(await supabase.from('cms_concepts').select('concept_id, name, status').in('concept_id', cr.map((x) => x.concept_id))) : [];
    return { ...base, name: s.name, description: s.variant_note, status: s.status, cls: catalogueClass(s.typical_set_id, s.class), via: s.class ? null : 'from its ID',
      topic: topicOf(s.topic_id), chapter: chapterOf(s.topic_id, s.chapter_id),
      facts: [...(s.instruction_pattern ? [{ k: 'Instruction', v: `"${s.instruction_pattern}"` }] : []), { k: 'Parents', v: s.parent_visible ? 'parent-visible' : 'hidden from parents' }],
      linked: [
        { label: 'Concepts', items: cr.map((x) => ({ id: x.concept_id, name: `${cn.find((c) => c.concept_id === x.concept_id)?.name ?? ''}${x.role ? ` (${x.role})` : ''}`, status: cn.find((c) => c.concept_id === x.concept_id)?.status, kind: 'concept' as const })) },
        { label: 'Patterns', items: must<{ pattern_id: string; name: string; status: string }[]>(pats).map((p) => ({ id: p.pattern_id, name: p.name, status: p.status, kind: 'pattern' as const })) },
      ],
      ...(await qBy('typical_set_id', id)) };
  }
  if (kind === 'pattern') {
    const p = must<{ pattern_id: string; name: string; typical_set_id: string; topic_id: string | null; status: string; target_misconceptions: string[] } | null>(
      await supabase.from('cms_patterns').select('pattern_id, name, typical_set_id, topic_id, status, target_misconceptions').eq('pattern_id', id).maybeSingle());
    if (!p) return null;
    const set = must<{ typical_set_id: string; name: string; class: number | null; topic_id: string | null; status: string } | null>(
      await supabase.from('cms_typical_sets').select('typical_set_id, name, class, topic_id, status').eq('typical_set_id', p.typical_set_id).maybeSingle());
    const topicId = p.topic_id ?? set?.topic_id ?? null;
    const [mis, setsOfTopic] = await Promise.all([
      p.target_misconceptions?.length ? supabase.from('cms_misconceptions').select('misconception_id, description, status').in('misconception_id', p.target_misconceptions) : Promise.resolve({ data: [], error: null }),
      topicId ? supabase.from('cms_typical_sets').select('typical_set_id, name').eq('topic_id', topicId).order('typical_set_id') : Promise.resolve({ data: [], error: null }),
    ]);
    return { ...base, name: p.name, description: null, status: p.status, cls: set ? catalogueClass(set.typical_set_id, set.class) : classFromId(p.typical_set_id), via: 'via its question type',
      topic: topicOf(topicId), chapter: chapterOf(topicId), facts: [],
      linked: [
        { label: 'Question type', items: [{ id: p.typical_set_id, name: set?.name ?? '', status: set?.status, kind: 'typical_set' as const }] },
        { label: 'Targets misconceptions', items: must<{ misconception_id: string; description: string; status: string }[]>(mis).map((m) => ({ id: m.misconception_id, name: m.description, status: m.status, kind: 'misconception' as const })) },
      ],
      setOptions: must<{ typical_set_id: string; name: string }[]>(setsOfTopic).map((x) => [x.typical_set_id, `${x.typical_set_id} · ${x.name}`] as [string, string]),
      ...(await qBy('pattern_id', id)) };
  }
  if (kind === 'misconception') {
    const m = must<{ misconception_id: string; description: string; parent_description: string | null; concept_id: string | null; root_prereq_concept: string | null; status: string } | null>(
      await supabase.from('cms_misconceptions').select('misconception_id, description, parent_description, concept_id, root_prereq_concept, status').eq('misconception_id', id).maybeSingle());
    if (!m) return null;
    const ids = [m.concept_id, m.root_prereq_concept].filter((x): x is string => !!x);
    const [cons, pats, wa] = await Promise.all([
      ids.length ? supabase.from('cms_concepts').select('concept_id, name, class, topic_id, status').in('concept_id', ids) : Promise.resolve({ data: [], error: null }),
      supabase.from('cms_patterns').select('pattern_id, name, status').contains('target_misconceptions', [id]).limit(50),
      supabase.from('cms_version_wrong_answers').select('version_id').eq('misconception_id', id).limit(2000),
    ]);
    const cs = must<{ concept_id: string; name: string; class: number | null; topic_id: string | null; status: string }[]>(cons);
    const main = cs.find((c) => c.concept_id === m.concept_id);
    const own = classFromId(m.misconception_id);
    return { ...base, name: m.description, description: m.parent_description, status: m.status, cls: own ?? main?.class ?? null, via: own ? null : main?.class ? 'via its concept' : null,
      topic: topicOf(main?.topic_id), chapter: chapterOf(main?.topic_id), facts: [],
      linked: [
        { label: 'Concept', items: cs.map((c) => ({ id: c.concept_id, name: `${c.name}${c.concept_id === m.root_prereq_concept ? ' (root prerequisite)' : ''}`, status: c.status, kind: 'concept' as const })) },
        { label: 'Patterns that target it', items: must<{ pattern_id: string; name: string; status: string }[]>(pats).map((p) => ({ id: p.pattern_id, name: p.name, status: p.status, kind: 'pattern' as const })) },
      ],
      ...(await qByVersions(must<{ version_id: number }[]>(wa).map((x) => x.version_id))) };
  }
  if (kind === 'setting') {
    const s = must<{ setting_id: string; name: string; description: string | null; theme: string | null; status: string; subject: string } | null>(
      await supabase.from('cms_settings').select('setting_id, name, description, theme, status, subject').eq('setting_id', id).maybeSingle());
    if (!s) return null;
    return { ...base, name: s.name, description: s.description, status: s.status, cls: null, via: null, topic: null, chapter: null,
      facts: [{ k: 'Subject', v: s.subject === 'science' ? 'Science' : s.subject === 'both' ? 'Math + Science (shared)' : 'Math' }, ...(s.theme ? [{ k: 'Theme', v: s.theme }] : [])], linked: [], ...(await qBy('setting_id', id)) };
  }
  // topic–class link: id = "MT0261·6"
  const [topicId, c] = id.split('·');
  const p = must<{ topic_id: string; class: number; source: string; evidence: string | null; suggested_role: string; status: string } | null>(
    await supabase.from('cms_topic_class_proposals').select('topic_id, class, source, evidence, suggested_role, status').eq('topic_id', topicId!).eq('class', Number(c)).maybeSingle());
  if (!p) return null;
  const t = topicOf(p.topic_id);
  return { ...base, proposedBy: [p.source], usedBy: [], name: `${t?.name ?? p.topic_id} → also in Class ${p.class}`, description: p.evidence, status: p.status, cls: p.class, via: null,
    topic: t, chapter: chapterOf(p.topic_id),
    facts: [{ k: 'Home class', v: t ? `Class ${t.class}` : '?' }, { k: 'Suggested role', v: ROLE_TEXT[p.suggested_role] ?? p.suggested_role }], linked: [],
    ...(await qBy('topic_id', p.topic_id)) };
}

/**
 * Approve (active), Reject (retired; kept, reversible) or Back to proposed, through the existing audited
 * functions only. A reject reason is stored in the audit for catalogue items; topic–class links take no
 * reason this round (decision 2). Settings are decided like catalogue items (Q38 PR 4, 0048).
 */
export async function decide(kind: CatKind, id: string, status: 'active' | 'retired' | 'proposed', reason: string | null, where: string) {
  if (kind === 'topic_class') {
    const [topic, cls] = id.split('·');
    const { error } = await supabase.rpc('cms_decide_topic_class', { p_topic_id: topic, p_class: Number(cls), p_status: status });
    if (error) throw new Error(error.message);
    return;
  }
  const why = status === 'active' ? `approved ${where}` : status === 'retired' ? `rejected ${where}${reason?.trim() ? `: ${reason.trim()}` : ''}` : 'back to proposed';
  await setCatalogueStatus(kind, id, status, why);
}

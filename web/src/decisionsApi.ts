// Q22 (Sambit, 17 Nov 2026): the Decisions inbox. Read-only: gathers everything waiting for Sambit, with where it is decided.
import { all } from './api';
import { supabase } from './supabase';

export interface DecisionItem { id: string; label?: string; href: string; subject: string | null; cls: number | null }
export interface DecisionCard { key: string; title: string; where: { label: string; href: string }; items: DecisionItem[];
  /** for big catalogue lists: the total count and whether the subject/class filters apply */ total?: number; filterable: boolean; note?: string }

const must = <T>(r: { data: unknown; error: { message: string } | null }): T => { if (r.error) throw new Error(r.error.message); return r.data as T; };
const q = (id: string) => `#/q/${encodeURIComponent(id)}`;
const prop = (kind: string, id?: string) => `#/proposed?kind=${kind}${id ? `&item=${encodeURIComponent(`${kind}:${id}`)}` : ''}`;
export const BLOCK_LABEL: Record<string, string> = {
  originality_pending: 'Originality check pending (run it on the Mac)', near_copy_no_override: 'Near-copy of a book, no approved override',
  picture_pending: 'Picture pending', attributes_pending: 'Attributes pending (fill in the signature)', science_solution1_empty: 'Science: Solution 1 empty',
  science_primary_not_confirmed: 'Science: primary row not confirmed', science_free_text_misconception: 'Science: misconception is free text',
  science_item_not_active: 'Science: misconception item not active', science_wrong_option_item_not_active: 'Science: a wrong option\'s item not active',
  science_type_missing: 'Science: question type not set', science_concept_error_row_not_linked: 'Science: a concept error\'s target row is not one of its rows',
  image_to_check: 'Image to check (mark it OK or Redo in the question\'s Image)',
};

export async function gatherDecisions(f: { subject: string; cls: string }): Promise<DecisionCard[]> {
  const subjOk = (s: string | null) => !f.subject || s === f.subject;
  const clsOk = (c: number | null) => !f.cls || String(c) === f.cls;
  const qlist = async (ids: string[]) => {
    if (!ids.length) return new Map<string, { subject: string; class: number; file_key: string | null }>();
    const rows: { question_id: string; subject: string; class: number; file_key: string | null }[] = [];
    for (let i = 0; i < ids.length; i += 300) rows.push(...must<typeof rows>(await supabase.from('cms_questions').select('question_id, subject, class, file_key').in('question_id', ids.slice(i, i + 300))));
    return new Map(rows.map((r) => [r.question_id, r]));
  };
  const [overrides, primaries, tcp, held, items, blockers, unplacedSets, unplacedConcepts, settings] = await Promise.all([
    all<{ request_id: number; question_id: string; field: string }>((a, b) => supabase.from('cms_override_requests').select('request_id, question_id, field').eq('status', 'pending').order('request_id').range(a, b)),
    all<{ version_id: number }>((a, b) => supabase.from('cms_question_content_rows').select('version_id').eq('rank_proposed', true).range(a, b)),
    all<{ topic_id: string; class: number; suggested_role: string }>((a, b) => supabase.from('cms_topic_class_proposals').select('topic_id, class, suggested_role').eq('status', 'proposed').order('topic_id').range(a, b)),
    all<{ held_id: number; file_key: string; subject: string; class: number; reason_code: string }>((a, b) => supabase.from('cms_held_out').select('held_id, file_key, subject, class, reason_code').eq('status', 'held').order('held_id').range(a, b)),
    all<{ row_id: string; item_no: number; text: string }>((a, b) => supabase.from('cms_row_misconceptions').select('row_id, item_no, text').eq('status', 'needs_review').order('row_id').range(a, b)),
    all<{ question_id: string; subject: string; class: number; reason: string; detail: string | null }>((a, b) => supabase.from('cms_approval_blockers').select('question_id, subject, class, reason, detail').order('question_id').range(a, b)),
    all<{ typical_set_id: string; subject: string; class: number; name: string; status: string }>((a, b) => supabase.from('cms_typical_sets').select('typical_set_id, subject, class, name, status').is('topic_id', null).neq('status', 'retired').range(a, b)),
    all<{ concept_id: string; subject: string; class: number; name: string; status: string }>((a, b) => supabase.from('cms_concepts').select('concept_id, subject, class, name, status').is('topic_id', null).neq('status', 'retired').range(a, b)),
    all<{ setting_id: string; name: string }>((a, b) => supabase.from('cms_settings').select('setting_id, name').eq('status', 'proposed').range(a, b)),
  ]);
  // proposed catalogue: counts (filtered where the table has subject / class) and the first 50 IDs
  const catCount = async (table: string, idCol: string, filterable: boolean) => {
    let x = supabase.from(table).select(idCol, { count: 'exact' }).eq('status', 'proposed');
    if (filterable && f.subject) x = x.eq('subject', f.subject);
    if (filterable && f.cls) x = x.eq('class', Number(f.cls));
    const r = await x.order(idCol).limit(50);
    if (r.error) throw new Error(r.error.message);
    return { total: r.count ?? 0, ids: ((r.data ?? []) as unknown as Record<string, string>[]).map((d) => d[idCol]!) };
  };
  const [pc, pm, ps, pp] = await Promise.all([catCount('cms_concepts', 'concept_id', true), catCount('cms_misconceptions', 'misconception_id', false),
    catCount('cms_typical_sets', 'typical_set_id', true), catCount('cms_patterns', 'pattern_id', false)]);

  const primaryVids = [...new Set(primaries.map((p) => p.version_id))];
  const cur = primaryVids.length ? await all<{ question_id: string; version_id: number; subject: string; class: number }>((a, b) =>
    supabase.from('cms_question_list').select('question_id, version_id, subject, class').in('version_id', primaryVids).range(a, b)) : [];
  const oq = await qlist([...new Set(overrides.map((o) => o.question_id))]);
  const tcTopics = tcp.length ? must<{ topic_id: string; name: string; chapter_id: string }[]>(await supabase.from('cms_topics').select('topic_id, name, chapter_id').in('topic_id', [...new Set(tcp.map((t) => t.topic_id))])) : [];

  const cards: DecisionCard[] = [
    { key: 'overrides', title: 'Pending overrides', where: { label: 'Review › Overrides', href: '#/review?show=overrides' }, filterable: true,
      items: overrides.map((o) => { const x = oq.get(o.question_id); return { id: x?.file_key ?? o.question_id, label: o.field, href: q(o.question_id), subject: x?.subject ?? null, cls: x?.class ?? null }; }) },
    { key: 'primaries', title: 'Proposed Science primary rows', where: { label: 'Question › Science review', href: cur[0] ? q(cur[0].question_id) : '#/review' }, filterable: true,
      items: cur.map((c) => ({ id: c.question_id, href: q(c.question_id), subject: c.subject, cls: c.class })) },
    { key: 'topic_class', title: 'Proposed topic–class links', where: { label: 'Proposed › Topic classes', href: prop('topic_class') }, filterable: true,
      items: tcp.map((t) => ({ id: `${t.topic_id} → Class ${t.class}`, label: tcTopics.find((x) => x.topic_id === t.topic_id)?.name, href: prop('topic_class'),
        subject: (tcTopics.find((x) => x.topic_id === t.topic_id)?.chapter_id ?? '').startsWith('SC') ? 'science' : 'math', cls: t.class })) },
    { key: 'catalogue', title: 'Proposed catalogue items', where: { label: 'Proposed', href: '#/proposed' }, filterable: true, total: pc.total + pm.total + ps.total + pp.total,
      note: `concepts ${pc.total} · misconceptions ${pm.total} · typical sets ${ps.total} · patterns ${pp.total} (subject / class filters apply to concepts and typical sets)`,
      items: [...pc.ids.map((id) => ({ id, label: 'concept', href: prop('concept', id) })), ...ps.ids.map((id) => ({ id, label: 'typical set', href: prop('typical_set', id) })),
        ...pm.ids.map((id) => ({ id, label: 'misconception', href: prop('misconception', id) })), ...pp.ids.map((id) => ({ id, label: 'pattern', href: prop('pattern', id) }))]
        .map((x) => ({ ...x, subject: null, cls: null })) },
    { key: 'settings', title: 'Proposed settings', where: { label: 'Proposed › Settings', href: prop('setting') }, filterable: false,
      items: settings.map((s) => ({ id: s.setting_id, label: s.name, href: prop('setting', s.setting_id), subject: null, cls: null })) },
    { key: 'unplaced', title: 'Catalogue items with no topic', where: { label: 'the item (Proposed)', href: '#/proposed' }, filterable: true,
      items: [...unplacedSets.map((s) => ({ id: s.typical_set_id, label: `typical set · ${s.name} · ${s.status}`, href: prop('typical_set', s.typical_set_id), subject: s.subject, cls: s.class })),
        ...unplacedConcepts.map((c) => ({ id: c.concept_id, label: `concept · ${c.name} · ${c.status}`, href: prop('concept', c.concept_id), subject: c.subject, cls: c.class }))] },
    { key: 'held', title: 'Held-out items', where: { label: 'Held out', href: '#/held-out' }, filterable: true,
      items: held.map((h) => ({ id: h.file_key, label: h.reason_code.replace(/_/g, ' '), href: `#/held-out?id=${h.held_id}`, subject: h.subject, cls: h.class })) },
    { key: 'row_items', title: 'Misconception items needing review', where: { label: 'Proposed › Misconception items', href: '#/proposed?kind=row_item' }, filterable: false,
      items: items.map((i) => ({ id: `${i.row_id} #${i.item_no}`, label: i.text, href: '#/proposed?kind=row_item', subject: 'science', cls: Number(i.row_id.slice(1, 2)) })) },
  ];
  // questions blocked from approval, one card per reason (a question can be under several)
  const reasons = [...new Set(blockers.map((b) => b.reason))].sort((a, b) => Object.keys(BLOCK_LABEL).indexOf(a) - Object.keys(BLOCK_LABEL).indexOf(b));
  for (const r of reasons) {
    cards.push({ key: `blocked:${r}`, title: `Blocked from approval: ${BLOCK_LABEL[r] ?? r}`, where: { label: 'the question (or Review)', href: '#/review' }, filterable: true,
      items: blockers.filter((b) => b.reason === r).map((b) => ({ id: b.question_id, label: b.detail ?? undefined, href: q(b.question_id), subject: b.subject, cls: b.class })) });
  }
  return cards.map((c) => (c.key === 'catalogue' || !c.filterable ? c : { ...c, items: c.items.filter((i) => subjOk(i.subject) && clsOk(i.cls)) }));
}

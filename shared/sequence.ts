// Sequencing (Sambit, 13 Nov 2026): the order of strands, chapters and topics in one class, from the
// per-class order tables (migration 0031), and its numbering: 1. strand · 1.2 chapter · 1.2.3 topic,
// with no gaps. Shared by the web app (Curriculum map, Browse) and the Excel export.
//
// Rules: only CORE rows are sequenced (a topic whose home class is this class). Extra rows (a topic
// from a lower / higher class) come after the core ones, unnumbered. Achievers rows are always last in
// their chapter, unnumbered. Retired topics and chapters are hidden (they keep their stored slot).
// Items with no stored position, or stored under another strand / chapter (they moved), go to the end.

export interface SeqStrand { strand_id: string; name: string; sort: number }
export interface SeqChapter { chapter_id: string; strand_id: string; name: string; sort: number; status?: string }
export interface SeqTopic { topic_id: string; chapter_id: string; class: number; name: string; status: string; topic_kind: string; seq?: number | null; classes?: number[] }
export interface SeqOrders {
  strands: { class: number; strand_id: string; position: number }[];
  chapters: { class: number; chapter_id: string; strand_id: string; position: number }[];
  topics: { class: number; topic_id: string; chapter_id: string; position: number }[];
}
export type SeqRole = 'core' | 'lower' | 'higher' | 'achievers';
export interface SeqTopicNode { topic: SeqTopic; no: string | null; role: SeqRole }
export interface SeqChapterNode { chapter: SeqChapter; no: string | null; core: boolean; topics: SeqTopicNode[] }
export interface SeqStrandNode { strand: SeqStrand; no: string | null; core: boolean; chapters: SeqChapterNode[] }

const BIG = 1e9;

/** Sort by stored position (when valid), then the fallback keys; items without a position go after. */
function ordered<T>(items: T[], pos: (x: T) => number | undefined, ...fallback: ((x: T) => number | string)[]): T[] {
  return [...items].sort((a, b) => {
    const pa = pos(a) ?? BIG, pb = pos(b) ?? BIG;
    if (pa !== pb) return pa - pb;
    for (const f of fallback) { const x = f(a), y = f(b); if (x !== y) return x < y ? -1 : 1; }
    return 0;
  });
}

/** The class's tree in order, with numbers. includeExtra adds topics from lower / higher classes (unnumbered). */
export function buildSequence(cls: number, strands: SeqStrand[], chapters: SeqChapter[], topics: SeqTopic[], orders: SeqOrders, opts: { includeExtra?: boolean } = {}): SeqStrandNode[] {
  const active = topics.filter((t) => t.status === 'active');
  const core = active.filter((t) => t.class === cls);
  const extra = opts.includeExtra ? active.filter((t) => t.class !== cls && (t.classes ?? []).includes(cls)) : [];
  const chapterOf = new Map(chapters.map((c) => [c.chapter_id, c]));
  const tPos = new Map(orders.topics.filter((o) => o.class === cls).map((o) => [o.topic_id, o]));
  const cPos = new Map(orders.chapters.filter((o) => o.class === cls).map((o) => [o.chapter_id, o]));
  const sPos = new Map(orders.strands.filter((o) => o.class === cls).map((o) => [o.strand_id, o.position]));
  const firstSeq = (ts: SeqTopic[]) => Math.min(BIG, ...ts.map((t) => t.seq ?? BIG));

  const byChapter = new Map<string, { core: SeqTopic[]; extra: SeqTopic[] }>();
  for (const t of core) { if (!chapterOf.has(t.chapter_id) || chapterOf.get(t.chapter_id)!.status === 'retired') continue; const e = byChapter.get(t.chapter_id) ?? { core: [], extra: [] }; e.core.push(t); byChapter.set(t.chapter_id, e); }
  for (const t of extra) { if (!chapterOf.has(t.chapter_id) || chapterOf.get(t.chapter_id)!.status === 'retired') continue; const e = byChapter.get(t.chapter_id) ?? { core: [], extra: [] }; e.extra.push(t); byChapter.set(t.chapter_id, e); }

  const chapterNodes = new Map<string, SeqChapterNode & { firstSeq: number }>();
  for (const [chId, e] of byChapter) {
    const c = chapterOf.get(chId)!;
    const normal = ordered(e.core.filter((t) => t.topic_kind !== 'achievers'),
      (t) => { const o = tPos.get(t.topic_id); return o && o.chapter_id === t.chapter_id ? o.position : undefined; }, (t) => t.seq ?? BIG, (t) => t.topic_id);
    const ach = e.core.filter((t) => t.topic_kind === 'achievers');
    const ext = [...e.extra].sort((a, b) => a.class - b.class || (a.seq ?? BIG) - (b.seq ?? BIG) || a.topic_id.localeCompare(b.topic_id));
    const isCore = e.core.length > 0;
    chapterNodes.set(chId, {
      chapter: c, no: null, core: isCore, firstSeq: firstSeq(e.core),
      topics: [...normal.map((t) => ({ topic: t, no: null, role: 'core' as SeqRole })),
        ...ext.map((t) => ({ topic: t, no: null, role: (t.class < cls ? 'lower' : 'higher') as SeqRole })),
        ...ach.map((t) => ({ topic: t, no: null, role: 'achievers' as SeqRole }))],
    });
  }

  const strandIds = new Set([...chapterNodes.values()].map((n) => n.chapter.strand_id));
  const strandNodes: SeqStrandNode[] = [];
  for (const s of strands.filter((x) => strandIds.has(x.strand_id))) {
    const chs = [...chapterNodes.values()].filter((n) => n.chapter.strand_id === s.strand_id);
    const coreChs = ordered(chs.filter((n) => n.core),
      (n) => { const o = cPos.get(n.chapter.chapter_id); return o && o.strand_id === n.chapter.strand_id ? o.position : undefined; },
      (n) => n.firstSeq, (n) => n.chapter.sort, (n) => n.chapter.chapter_id);
    const extraChs = ordered(chs.filter((n) => !n.core), () => undefined, (n) => n.chapter.sort, (n) => n.chapter.chapter_id);
    strandNodes.push({ strand: s, no: null, core: coreChs.length > 0, chapters: [...coreChs, ...extraChs] });
  }
  const minSeq = (n: SeqStrandNode) => Math.min(BIG, ...n.chapters.map((c) => (c as SeqChapterNode & { firstSeq: number }).firstSeq));
  const out = [
    ...ordered(strandNodes.filter((n) => n.core), (n) => sPos.get(n.strand.strand_id), minSeq, (n) => n.strand.sort, (n) => n.strand.strand_id),
    ...ordered(strandNodes.filter((n) => !n.core), () => undefined, (n) => n.strand.sort, (n) => n.strand.strand_id),
  ];
  // numbering, no gaps: only core strands, core chapters and core (non-Achievers) topics get numbers
  let si = 0;
  for (const s of out) {
    if (!s.core) continue;
    s.no = `${++si}`;
    let ci = 0;
    for (const c of s.chapters) {
      if (!c.core) continue;
      c.no = `${s.no}.${++ci}`;
      let ti = 0;
      for (const t of c.topics) if (t.role === 'core') t.no = `${c.no}.${++ti}`;
    }
  }
  for (const s of out) for (const c of s.chapters) delete (c as Partial<SeqChapterNode & { firstSeq: number }>).firstSeq;
  return out;
}

/** Numbers by ID for one class: strands, chapters and topics (core only). */
export function numbersOf(tree: SeqStrandNode[]) {
  const strand = new Map<string, string>(), chapter = new Map<string, string>(), topic = new Map<string, string>();
  const strandRank = new Map<string, number>(), chapterRank = new Map<string, number>(), topicRank = new Map<string, number>();
  let r = 0;
  for (const s of tree) {
    if (s.no) strand.set(s.strand.strand_id, s.no);
    strandRank.set(s.strand.strand_id, r++);
    for (const c of s.chapters) {
      if (c.no) chapter.set(c.chapter.chapter_id, c.no);
      chapterRank.set(c.chapter.chapter_id, r++);
      for (const t of c.topics) { if (t.no) topic.set(t.topic.topic_id, t.no); topicRank.set(t.topic.topic_id, r++); }
    }
  }
  return { strand, chapter, topic, strandRank, chapterRank, topicRank };
}

/** "1. Numbers & Place Value" (strand) or "1.2 Counting" (chapter / topic); the name alone when unnumbered. */
export const numbered = (no: string | null | undefined, name: string, level: 'strand' | 'other' = 'other') => (no ? `${no}${level === 'strand' ? '.' : ''} ${name}` : name);

/** Move one item within its own list (drag and drop or ↑/↓). Lists never mix parents, so nothing can cross. */
export function moveWithin<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x!);
  return out;
}

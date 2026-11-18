// Course builder, screens 6 and 7 (Q13, 18 Nov 2026): clone a display chapter from another course, and compare two
// display chapters. Pure; the result is a new outline that the screen saves with cms_save_course (one audited transaction).
import { placements, type OChapter, type Outline } from './course.ts';

export interface ClonePlan {
  outline: Outline;
  /** index of the new chapter in the outline */
  ci: number;
  /** CMS topics not copied because the target course already has them (label = where) */
  skipped: { topic: string; id: string; where: string }[];
  /** display topics not copied: unticked, or left with no CMS topics */
  dropped: { topic: string; why: 'unticked' | 'nothing left' }[];
  skippedAchievers: { id: string; where: string }[];
}

/** Clone `src` into `target`: at the end, or replacing chapter `replace` (its own topics and Achievers become free). */
export function cloneChapter(target: Outline, src: OChapter, o: { name: string; place: 'end' | { replace: number }; ticked: boolean[] }): ClonePlan {
  const replace = o.place === 'end' ? null : o.place.replace;
  const rest: Outline = { chapters: target.chapters.filter((_, i) => i !== replace) };
  const used = placements(rest);
  const skipped: ClonePlan['skipped'] = [], dropped: ClonePlan['dropped'] = [], skippedAchievers: ClonePlan['skippedAchievers'] = [];
  const topics: OChapter['topics'] = [];
  src.topics.forEach((t, i) => {
    if (o.ticked[i] === false) { dropped.push({ topic: t.name, why: 'unticked' }); return; }
    const cms = t.cms.filter((id) => { const u = used.topics.get(id); if (u) skipped.push({ topic: t.name, id, where: u.label }); return !u; });
    if (!cms.length) { dropped.push({ topic: t.name, why: 'nothing left' }); return; }
    topics.push({ name: t.name, cms });
  });
  const achievers = src.achievers.filter((a) => { const u = used.achievers.get(a); if (u) skippedAchievers.push({ id: a, where: u.label }); return !u; });
  const chapter: OChapter = { name: o.name.trim() || src.name, achievers, topics };
  const chapters = target.chapters.slice();
  let ci: number;
  if (replace === null) { chapters.push(chapter); ci = chapters.length - 1; } else { chapters.splice(replace, 1, chapter); ci = replace; }
  return { outline: { chapters }, ci, skipped, dropped, skippedAchievers };
}

export type Side = 'both' | 'a' | 'b';
export interface CompareRow { id: string; side: Side; a: { ti: number; name: string } | null; b: { ti: number; name: string } | null; elsewhereInA: string | null }

/** One row per CMS topic of chapter A or chapter B. A topic that is in B but sits in ANOTHER chapter of A is flagged. */
export function compareChapters(aOutline: Outline, aci: number, b: OChapter): { topics: CompareRow[]; achievers: CompareRow[] } {
  const a = aOutline.chapters[aci]!;
  const inA = new Map<string, { ti: number; name: string }>(), inB = new Map<string, { ti: number; name: string }>();
  a.topics.forEach((t, ti) => t.cms.forEach((id) => inA.set(id, { ti, name: t.name })));
  b.topics.forEach((t, ti) => t.cms.forEach((id) => inB.set(id, { ti, name: t.name })));
  const pl = placements(aOutline);
  const rows = (ids: string[], getA: (id: string) => CompareRow['a'], getB: (id: string) => CompareRow['b'], elsewhere: (id: string) => string | null) =>
    [...new Set(ids)].map((id) => { const x = getA(id), y = getB(id); return { id, a: x, b: y, side: (x && y ? 'both' : x ? 'a' : 'b') as Side, elsewhereInA: x ? null : elsewhere(id) }; })
      .sort((p, q) => (p.a?.ti ?? 99) - (q.a?.ti ?? 99) || (p.b?.ti ?? 99) - (q.b?.ti ?? 99) || p.id.localeCompare(q.id));
  return {
    topics: rows([...inA.keys(), ...inB.keys()], (id) => inA.get(id) ?? null, (id) => inB.get(id) ?? null,
      (id) => { const p = pl.topics.get(id); return p && p.ci !== aci ? p.label : null; }),
    achievers: rows([...a.achievers, ...b.achievers], (id) => (a.achievers.includes(id) ? { ti: -1, name: 'Achievers' } : null), (id) => (b.achievers.includes(id) ? { ti: -1, name: 'Achievers' } : null),
      (id) => { const p = pl.achievers.get(id); return p && p.ci !== aci ? p.label : null; }),
  };
}

/** "+ Add to A": put CMS topic `id` into display topic `ti` of chapter `aci` (or a new display topic named `newName`). */
export function addToA(aOutline: Outline, aci: number, id: string, to: { ti: number } | { newName: string }): Outline {
  return { chapters: aOutline.chapters.map((c, i) => {
    if (i !== aci) return c;
    if ('ti' in to) return { ...c, topics: c.topics.map((t, k) => (k === to.ti ? { ...t, cms: [...t.cms, id] } : t)) };
    return { ...c, topics: [...c.topics, { name: to.newName, cms: [id] }] };
  }) };
}
export const addAchieverToA = (aOutline: Outline, aci: number, chapterId: string): Outline =>
  ({ chapters: aOutline.chapters.map((c, i) => (i === aci ? { ...c, achievers: [...c.achievers, chapterId] } : c)) });

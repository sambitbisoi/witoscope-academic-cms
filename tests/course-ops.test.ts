// Course builder screens 6–7 (Q13): clone a display chapter; compare two display chapters.
import { describe, expect, it } from 'vitest';
import { addAchieverToA, addToA, cloneChapter, compareChapters } from '../shared/course-ops.ts';
import type { OChapter, Outline } from '../shared/course.ts';

const target: Outline = { chapters: [
  { id: 'DCH1', name: 'A', achievers: ['MC01'], topics: [{ id: 'T1', name: 'a1', cms: ['MT0001'] }] },
  { id: 'DCH2', name: 'B', achievers: ['MC02'], topics: [{ id: 'T2', name: 'b1', cms: ['MT0002', 'MT0003'] }] }] };
const src: OChapter = { id: 'DCH9', name: 'Source', achievers: ['MC01', 'MC02', 'MC03'], topics: [
  { name: 's1', cms: ['MT0001', 'MT0004'] }, { name: 's2', cms: ['MT0002'] }, { name: 's3', cms: ['MT0005'] }] };

describe('cloneChapter', () => {
  it('at the end: skips topics and Achievers already used; drops unticked and emptied topics; source unchanged', () => {
    const before = JSON.stringify(src);
    const p = cloneChapter(target, src, { name: 'Copy', place: 'end', ticked: [true, true, false] });
    expect(p.ci).toBe(2);
    expect(p.outline.chapters[2]).toEqual({ name: 'Copy', achievers: ['MC03'], topics: [{ name: 's1', cms: ['MT0004'] }] });
    expect(p.skipped).toEqual([{ topic: 's1', id: 'MT0001', where: '1.1 a1' }, { topic: 's2', id: 'MT0002', where: '2.1 b1' }]);
    expect(p.dropped).toEqual([{ topic: 's2', why: 'nothing left' }, { topic: 's3', why: 'unticked' }]);
    expect(p.skippedAchievers.map((a) => a.id)).toEqual(['MC01', 'MC02']);
    expect(JSON.stringify(src)).toBe(before);
    expect(p.outline.chapters.slice(0, 2)).toEqual(target.chapters);
  });
  it('replacing a chapter frees its own topics and Achievers; the clone takes its place', () => {
    const p = cloneChapter(target, src, { name: '', place: { replace: 1 }, ticked: [] });
    expect(p.ci).toBe(1);
    expect(p.outline.chapters.map((c) => c.name)).toEqual(['A', 'Source']);
    expect(p.outline.chapters[1]).toEqual({ name: 'Source', achievers: ['MC02', 'MC03'], topics: [{ name: 's1', cms: ['MT0004'] }, { name: 's2', cms: ['MT0002'] }, { name: 's3', cms: ['MT0005'] }] });
  });
});

describe('compareChapters', () => {
  const b: OChapter = { name: 'Other', achievers: ['MC02', 'MC05'], topics: [{ name: 'o1', cms: ['MT0001', 'MT0003'] }, { name: 'o2', cms: ['MT0007'] }] };
  it('rows per CMS topic: both / only A / only B; B-only found elsewhere in A is flagged', () => {
    const c = compareChapters(target, 0, b);
    expect(c.topics.map((r) => `${r.id} ${r.side} ${r.a?.name ?? '-'} ${r.b?.name ?? '-'} ${r.elsewhereInA ?? ''}`.trim())).toEqual([
      'MT0001 both a1 o1', 'MT0003 b - o1 2.1 b1', 'MT0007 b - o2']);
    expect(c.achievers.map((r) => `${r.id} ${r.side} ${r.elsewhereInA ?? ''}`.trim())).toEqual(['MC01 a', 'MC02 b 2 B', 'MC05 b']);
  });
  it('+ Add to A: into an existing display topic, or a new one; Achievers too', () => {
    expect(addToA(target, 0, 'MT0007', { ti: 0 }).chapters[0]!.topics[0]!.cms).toEqual(['MT0001', 'MT0007']);
    expect(addToA(target, 0, 'MT0007', { newName: 'o2' }).chapters[0]!.topics[1]).toEqual({ name: 'o2', cms: ['MT0007'] });
    expect(addAchieverToA(target, 0, 'MC05').chapters[0]!.achievers).toEqual(['MC01', 'MC05']);
  });
});

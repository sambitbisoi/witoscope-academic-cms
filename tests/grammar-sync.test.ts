// English E1: the Q41 sync planner (pure).
import { describe, expect, it } from 'vitest';
import { orderKey, planSync, type DbState, type DbTopic, type SheetTopic } from '../scripts/lib/grammar-sync.ts';

const T = (id: string, ch: string, cls: number, links: number[], name = id): DbTopic => ({ topic_id: id, chapter_id: ch, class: cls, name, status: 'active', topic_kind: 'normal',
  links: links.map((c) => ({ class: c, source: 'NCERT', evidence: null })) });
const S = (row: number, id: string, ch: string, home: number, ticks: number[], name = id): SheetTopic => ({ row, chapter_id: ch, chapter: '', sheet_id: id, name, home, ticks,
  ixl: '', ncert: '', dav: '', sub_skills: '', notes: '', strand: '' });
const db = (topics: DbTopic[], order: Record<string, string[]> = {}, reserved: [number, number][] = [[186, 194]]): DbState => ({
  topics: new Map(topics.map((t) => [t.topic_id, t])), chapters: new Set(['GC01', 'GC02']), order: new Map(Object.entries(order)), reservedGT: reserved });

describe('planSync', () => {
  const base = [T('GT0001', 'GC01', 1, [1, 2]), T('GT0002', 'GC01', 1, [1]), T('GT0003', 'GC01', 2, [2])];
  it('nothing to do when the sheet equals the CMS', () => {
    const p = planSync([S(2, 'GT0001', 'GC01', 1, [1, 2]), S(3, 'GT0002', 'GC01', 1, [1]), S(4, 'GT0003', 'GC01', 2, [2])], db(base), new Map(), 3);
    expect(p.problems).toEqual([]); expect(p.counts).toMatchObject({ unchanged: 3, created: 0, order_lists: 0 });
  });
  it('rename, home class (placed after its sheet neighbour in the new home class), class links; a removed tick removes that link only', () => {
    const p = planSync([S(2, 'GT0001', 'GC01', 1, [1, 2], 'New name'), S(3, 'GT0003', 'GC01', 1, [1, 2]), S(4, 'GT0002', 'GC01', 1, [1])],
      db(base, { [orderKey(1, 'GC01')]: ['GT0001', 'GT0002'], [orderKey(2, 'GC01')]: ['GT0003'] }), new Map(), 3);
    expect(p.problems).toEqual([]);
    expect(p.topics.find((x) => x.topic_id === 'GT0001')!.changes).toEqual(['rename "GT0001" → "New name"']);
    expect(p.topics.find((x) => x.topic_id === 'GT0003')!.changes).toEqual(['home class 2 → 1', 'classes 2 → 1,2']);
    expect(p.order).toEqual([{ class: 1, chapter_id: 'GC01', before: ['GT0001', 'GT0002'], after: ['GT0001', 'GT0003', 'GT0002'], placed: ['GT0003'] }]);
    const q = planSync([S(2, 'GT0001', 'GC01', 1, [1]), S(3, 'GT0002', 'GC01', 1, [1]), S(4, 'GT0003', 'GC01', 2, [2])], db(base), new Map(), 3);
    expect((q.topics[0]!.fields.classes as { class: number; source: string }[])).toEqual([{ class: 1, source: 'NCERT', evidence: null }]);   // kept with its evidence
  });
  it('a NEW topic needs a mapped, reserved ID; it goes first if nothing above it in its chapter is in the list', () => {
    const sheet = [S(2, 'NEW-01', 'GC01', 1, [1]), S(3, 'GT0001', 'GC01', 1, [1, 2]), S(4, 'GT0002', 'GC01', 1, [1]), S(5, 'GT0003', 'GC01', 2, [2])];
    expect(planSync(sheet, db(base), new Map(), 4).problems).toEqual(['row 2: NEW-01 has no GT ID in the mapping file']);
    expect(planSync(sheet, db(base, {}, []), new Map([['NEW-01', 'GT0186']]), 4).problems[0]).toMatch(/not in an open GT reservation/);
    const p = planSync(sheet, db(base, { [orderKey(1, 'GC01')]: ['GT0001', 'GT0002'] }), new Map([['NEW-01', 'GT0186']]), 4);
    expect(p.problems).toEqual([]);
    expect(p.order[0]!.after).toEqual(['GT0186', 'GT0001', 'GT0002']);
    expect(p.topics[0]!.fields).toMatchObject({ topic_id: 'GT0186', chapter_id: 'GC01', class: 1, classes: [{ class: 1, source: 'Grammar sheet r30' }] });
  });
  it('refuses: a wrong count, an unknown chapter, a home class not ticked, a CMS topic missing from the sheet, a chapter move', () => {
    const p = planSync([S(2, 'GT0001', 'GC09', 1, [2]), S(3, 'GT0002', 'GC02', 1, [1])], db(base), new Map(), 3);
    expect(p.problems).toEqual([
      'the sheet has 2 topics in rows 2–194; expected 3',
      'row 2: chapter GC09 is not a Grammar chapter in the CMS (new chapters are not part of Q41)',
      'row 2: GT0001 is not ticked for its home class 1',
      'row 2: GT0001 is in GC01 in the CMS, GC09 in the sheet (chapter moves are not part of Q41)',
      'row 3: GT0002 is in GC01 in the CMS, GC02 in the sheet (chapter moves are not part of Q41)',
      'GT0003 is active in the CMS but not in the sheet (Q41 removes no topic)',
    ]);
  });
});

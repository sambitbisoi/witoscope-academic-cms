// Course builder (Q13): checks, counts by Level ≤ class, placements, move.
import { describe, expect, it } from 'vitest';
import { blocksPublish, countFor, courseChecks, courseTotals, move, placements, type CheckContext, type Outline, type TopicInfo } from '../shared/course.ts';

const T = (topic_id: string, o: Partial<TopicInfo> = {}): TopicInfo =>
  ({ topic_id, name: `Topic ${topic_id}`, chapter_id: 'MC01', home_class: 5, status: 'active', kind: 'normal', classes: [5], counts: {}, ...o });
const topics = new Map<string, TopicInfo>([
  ['MT0001', T('MT0001', { counts: { 4: { n: 2, approved: 1 }, 5: { n: 2, approved: 0 }, 6: { n: 9, approved: 0 } } })],
  ['MT0002', T('MT0002', { counts: { 5: { n: 1, approved: 0 } } })],
  ['MT0003', T('MT0003', { status: 'retired', counts: { 5: { n: 10, approved: 0 } } })],
  ['MT0004', T('MT0004', { home_class: 4, classes: [4, 5] })],
  ['MT0005', T('MT0005')],
  ['MT0006', T('MT0006', { home_class: 6, classes: [6] })],
  ['ACH-MC01-5', T('ACH-MC01-5', { kind: 'achievers', name: 'Achievers: X', counts: { 5: { n: 3, approved: 0 } } })],
  ['ACH-MC02-5', T('ACH-MC02-5', { kind: 'achievers', name: 'Achievers: Y' })],
]);
const ctx: CheckContext = { cls: 5, subject: 'math', topics, minQuestions: 5 };
const kinds = (o: Outline) => courseChecks(o, ctx).map((c) => `${c.level} ${c.kind}${c.ids ? ` ${c.ids.join(',')}` : ''}`);

describe('countFor: Level ≤ class, never higher', () => {
  it('sums the levels at or below the class and counts the rest as left out', () => {
    expect(countFor(topics.get('MT0001')!.counts, 5)).toEqual({ n: 4, approved: 1, above: 9 });
    expect(countFor(topics.get('MT0001')!.counts, 4)).toEqual({ n: 2, approved: 1, above: 11 });
    expect(countFor(undefined, 5)).toEqual({ n: 0, approved: 0, above: 0 });
  });
});

describe('courseChecks', () => {
  it('an empty course: one error', () => {
    expect(kinds({ chapters: [] })).toEqual(['error no_chapters', 'warn core_unplaced MT0001,MT0002,MT0005', 'info extra_unplaced MT0004']);
  });
  it('errors: empty chapter, empty topic, retired topic, twice, unknown, missing Achievers; they block Publish', () => {
    const o: Outline = { chapters: [
      { name: 'A', achievers: ['MC03'], topics: [] },
      { name: 'B', achievers: [], topics: [{ name: 'x', cms: [] }, { name: 'y', cms: ['MT0003', 'MT0001'] }, { name: 'z', cms: ['MT0001', 'ST0001'] }] }] };
    const c = kinds(o);
    expect(c).toEqual(expect.arrayContaining(['error chapter_empty', 'error topic_empty', 'error topic_retired MT0003', 'error topic_twice MT0001',
      'error topic_unknown ST0001', 'error achievers_missing ACH-MC03-5']));
    expect(blocksPublish(courseChecks(o, ctx))).toBe(true);
  });
  it('warnings and info never block: too few (threshold edge), above class, Achievers with 0, unplaced core / extra', () => {
    const ok: Outline = { chapters: [{ name: 'A', achievers: ['MC01', 'MC02'], topics: [{ name: 'x', cms: ['MT0001', 'MT0002'] }, { name: 'y', cms: ['MT0005'] }] }] };
    expect(kinds(ok)).toEqual(['info above_class MT0001', 'warn topic_few', 'info achievers_zero ACH-MC02-5', 'info extra_unplaced MT0004']);
    expect(courseChecks(ok, ctx).find((c) => c.kind === 'topic_few')!.message).toContain('1.2 y has 0 questions');
    expect(blocksPublish(courseChecks(ok, ctx))).toBe(false);
    // 4 + 1 = 5 questions: not "too few" at threshold 5; 6 is
    expect(courseChecks(ok, { ...ctx, minQuestions: 6 }).filter((c) => c.kind === 'topic_few').map((c) => c.ti)).toEqual([0, 1]);
    // a Class 6 topic is not "class 5" and so never listed as unplaced
    expect(kinds(ok).join()).not.toContain('MT0006');
  });
  it('a class change re-resolves the Achievers topic', () => {
    const o: Outline = { chapters: [{ name: 'A', achievers: ['MC01'], topics: [{ name: 'x', cms: ['MT0001'] }] }] };
    expect(kinds(o)).not.toContain('error achievers_missing ACH-MC01-5');
    expect(courseChecks(o, { ...ctx, cls: 4 }).map((c) => c.kind)).toContain('achievers_missing');
  });
});

describe('totals, placements, move', () => {
  const o: Outline = { chapters: [{ name: 'A', achievers: ['MC01'], topics: [{ name: 'x', cms: ['MT0001'] }, { name: 'y', cms: ['MT0002', 'MT0005'] }] }, { name: 'B', achievers: [], topics: [] }] };
  it('totals use Level ≤ class', () => {
    expect(courseTotals(o, ctx)).toEqual({ chapters: 2, topics: 2, cms: 3, questions: 5, approved: 1, achievers: 3, achieversApproved: 0 });
  });
  it('placements say where each CMS topic and Achievers chapter is', () => {
    const p = placements(o);
    expect(p.topics.get('MT0005')!.label).toBe('1.2 y');
    expect(p.achievers.get('MC01')!.label).toBe('1 A');
  });
  it('move', () => {
    expect(move(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(move(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(move(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });
});

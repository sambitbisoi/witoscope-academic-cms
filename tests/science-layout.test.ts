// Science workspace layout (14 Nov 2026): tree | content | questions. Synthetic rows only.
import { describe, expect, it } from 'vitest';
import { classesLine, isDimmed, listedOrder, rightPane, rowQuestions, rowsForClass, rowsInOrder, topicGroups } from '../web/src/scienceLogic.ts';
import { parseRoute, browseHash } from '../web/src/logic.ts';

const row = (row_id: string, sort: number, extra: Partial<{ topic_id: string; row_class: number; question_use: string }> = {}) =>
  ({ row_id, sort, topic_id: 'ST0329', row_class: 6, question_use: 'OK', ...extra });
const q = (question_id: string, tier: string | null, links: { row_id: string; role: 'direct' | 'supporting' }[], topic_id = 'ST0329') => ({ question_id, topic_id, level_tier: tier, links });

describe('middle column: rows', () => {
  it('master order (sort), not grouped by type', () => {
    expect(rowsInOrder([row('C6-04-030', 30), row('C6-04-026', 26), row('C6-04-028', 28)]).map((r) => r.row_id)).toEqual(['C6-04-026', 'C6-04-028', 'C6-04-030']);
  });
  it('class N shows rows of class N and below; all shows every row', () => {
    const rs = [row('C5-01-001', 1, { row_class: 5 }), row('C6-01-001', 2)];
    expect(rowsForClass(rs, '5').map((r) => r.row_id)).toEqual(['C5-01-001']);
    expect(rowsForClass(rs, 'all')).toHaveLength(2);
  });
  it('"No questions" and "Misconception only" rows are dimmed, not hidden', () => {
    expect(isDimmed({ question_use: 'No questions' })).toBe(true);
    expect(isDimmed({ question_use: 'Misconception only' })).toBe(true);
    expect(isDimmed({ question_use: 'OK' })).toBe(false);
  });
});

describe('right column states', () => {
  const qs = [q('SQ2', 'L2', [{ row_id: 'R1', role: 'supporting' }]), q('SQ3', 'L1', [{ row_id: 'R1', role: 'direct' }]), q('SQ1', 'L3', [{ row_id: 'R1', role: 'direct' }]), q('SQ4', 'L1', [{ row_id: 'R2', role: 'direct' }])];
  it('no row → all questions; row → that row; question → its detail with a back link', () => {
    expect(rightPane(null, null, 'topic')).toEqual({ kind: 'all' });
    expect(rightPane('C6-04-028', null, 'topic')).toEqual({ kind: 'row', row: 'C6-04-028' });
    expect(rightPane('C6-04-028', 'SQ000225', 'topic')).toEqual({ kind: 'detail', q: 'SQ000225', back: '← Back to row C6-04-028' });
    expect(rightPane(null, 'SQ000225', 'chapter')).toEqual({ kind: 'detail', q: 'SQ000225', back: '← Back to all questions in this chapter' });
  });
  it('a row\'s questions: DIRECT then SUPPORTING, by tier', () => {
    const s = rowQuestions(qs, 'R1');
    expect(s.direct.map((x) => x.question_id)).toEqual(['SQ3', 'SQ1']);
    expect(s.supporting.map((x) => x.question_id)).toEqual(['SQ2']);
    expect(listedOrder(qs, 'R1')).toEqual(['SQ3', 'SQ1', 'SQ2']);
    expect(listedOrder(qs, null)).toEqual(['SQ3', 'SQ4', 'SQ2', 'SQ1']);
  });
});

describe('chapter view', () => {
  it('rows under each topic in master order; topics without rows are kept (shown as "no content rows")', () => {
    const g = topicGroups([row('B2', 5, { topic_id: 'T2' }), row('A1', 2, { topic_id: 'T1' }), row('B1', 1, { topic_id: 'T2' })], ['T1', 'T2', 'T3']);
    expect(g.map((x) => [x.topic_id, x.rows.map((r) => r.row_id)])).toEqual([['T1', ['A1']], ['T2', ['B1', 'B2']], ['T3', []]]);
  });
});

describe('deep links', () => {
  it('topic, row and question survive the URL hash', () => {
    const h = browseHash({ subject: 'science', cls: '6', ch: 'SC48', topic: 'ST0329', tab: 'content', row: 'C6-04-028', q: 'SQ000225' });
    expect(parseRoute(h)).toMatchObject({ name: 'browse', subject: 'science', cls: '6', ch: 'SC48', topic: 'ST0329', row: 'C6-04-028', q: 'SQ000225' });
    expect(parseRoute(browseHash({ subject: 'science', cls: 'all', ch: 'SC48', chview: true, row: 'C6-04-028' }))).toMatchObject({ chview: true, row: 'C6-04-028', topic: null });
  });
});

describe('Classes line (A3)', () => {
  it('an empty or "–" master cell reads "none" and is never a mismatch', () => {
    expect(classesLine(null, [6])).toEqual({ text: 'NCERT classes: none · CMS classes: 6', mismatch: [] });
    expect(classesLine('–', [4, 6])).toEqual({ text: 'NCERT classes: none · CMS classes: 4, 6', mismatch: [] });
    expect(classesLine('6', [6])).toEqual({ text: 'NCERT classes: 6 · CMS classes: 6', mismatch: [] });
    expect(classesLine('5–6', [6])).toEqual({ text: 'NCERT classes: 5–6 · CMS classes: 6', mismatch: [5] });
    expect(classesLine(null, null).text).toBe('NCERT classes: none · CMS classes: …');
  });
});

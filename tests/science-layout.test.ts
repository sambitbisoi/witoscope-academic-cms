// Science workspace layout (14 Nov 2026): tree | content | questions. Synthetic rows only.
import { describe, expect, it } from 'vitest';
import { classesLine, isDimmed, listedOrder, rightPane, rowClassLine, rowClassTag, rowQuestions, rowsForClass, rowsInOrder, rowSplit, rowSplitLabel, topicGroups } from '../web/src/scienceLogic.ts';
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
    expect(classesLine(null, [6])).toEqual({ text: 'Mapped classes: none · CMS classes: 6', mismatch: [] });
    expect(classesLine('–', [4, 6])).toEqual({ text: 'Mapped classes: none · CMS classes: 4, 6', mismatch: [] });
    expect(classesLine('6', [6])).toEqual({ text: 'Mapped classes: 6 · CMS classes: 6', mismatch: [] });
    expect(classesLine('5–6', [6])).toEqual({ text: 'Mapped classes: 5–6 · CMS classes: 6', mismatch: [5] });
    expect(classesLine(null, null).text).toBe('Mapped classes: none · CMS classes: …');
  });
});

describe('Q11 / Q12: row class (16 Nov 2026)', () => {
  const rs = [row('C5-01-001', 1, { row_class: 5 }), row('C6-01-001', 2), row('C6-01-002', 3)];
  it('Show higher-level also shows rows above the class; All is unaffected', () => {
    expect(rowsForClass(rs, '5', true)).toHaveLength(3);
    expect(rowsForClass(rs, '5', false)).toHaveLength(1);
    expect(rowsForClass(rs, 'all', false)).toHaveLength(3);
  });
  it('counts show the split', () => {
    expect(rowSplit(rs, '5')).toEqual({ within: 1, above: 2 });
    expect(rowSplitLabel(rowSplit(rs, '5'))).toBe('1 + 2 above class');
    expect(rowSplitLabel(rowSplit(rs, '6'))).toBe('3');
    expect(rowSplitLabel(rowSplit(rs, 'all'))).toBe('3');
  });
  it('tag on every row: own class, lower class, above class', () => {
    expect(rowClassTag(6, '6').text).toBe('Class 6');
    expect(rowClassTag(5, '6')).toMatchObject({ text: 'Class 5 row · lower class', kind: 'lower' });
    expect(rowClassTag(6, '5')).toMatchObject({ text: 'Class 6 row · above class', kind: 'above' });
    expect(rowClassTag(4, 'all')).toMatchObject({ text: 'Class 4', kind: 'here' });
  });
  it('row details line', () => {
    expect(rowClassLine(6, 3)).toBe('Row class 6 · topic home class 3');
    expect(rowClassLine(6, null)).toBe('Row class 6');
  });
});

describe('0035: ranks and Science approval blockers', () => {
  it('rank labels', async () => {
    const { rankLabel } = await import('../web/src/scienceLogic.ts');
    expect(rankLabel({ rank: 'primary', rank_proposed: true, weight: 1 })).toBe('Primary (proposed) · 1.0');
    expect(rankLabel({ rank: 'secondary', rank_proposed: false, weight: 0.5 })).toBe('Secondary · 0.5');
    expect(rankLabel({ rank: 'context', rank_proposed: false, weight: 0 })).toBe('Supporting · 0');
  });
  it('blockers', async () => {
    const { scienceBlockers } = await import('../web/src/scienceLogic.ts');
    const ok = { solution1: 'Y. Because…', links: [{ rank: 'primary', rank_proposed: false }], misconceptionText: null, misconception: { status: 'active' }, wrongItems: [] };
    expect(scienceBlockers(ok)).toEqual([]);
    expect(scienceBlockers({ ...ok, solution1: ' ', links: [{ rank: 'primary', rank_proposed: true }], misconception: { status: 'needs_review' } }))
      .toEqual(['Solution 1 is empty', 'primary row not confirmed', 'misconception item needs review']);
    expect(scienceBlockers({ ...ok, links: [], misconceptionText: 'x', wrongItems: [{ status: 'needs_review' }] })).toEqual(['no primary content row', 'misconception is free text', "a wrong option's item needs review"]);
  });
});

// Q38 PR 4 (24 Nov 2026): Previous / Next walk, primary line, proposal states. Synthetic rows only.
import { describe, expect, it } from 'vitest';
import { primaryConfirmedOnApproval, primaryOf, questionState, rowState, walkOrder, walkQuestions, walkStep } from '../web/src/scienceLogic.ts';

const row = (row_id: string, topic_id: string, sort: number) => ({ row_id, topic_id, sort, row_class: 3, question_use: 'OK', retired_at: null as string | null });
const q = (question_id: string, topic_id: string, primary: string | null, o: { proposed?: boolean; type?: number; rejected?: string } = {}) => ({
  question_id, topic_id, science_question_type: o.type ?? 2,
  links: [...(primary ? [{ row_id: primary, role: 'direct' as const, rank: 'primary', rank_proposed: !!o.proposed }] : []),
    ...(o.rejected ? [{ row_id: o.rejected, role: 'direct' as const, rank: 'secondary', rank_proposed: false, primary_rejected: true }] : [])] });

describe('(b) walk order', () => {
  const rows = [row('C3-01-002', 'ST1', 2), row('C3-01-001', 'ST1', 1), row('C3-02-001', 'ST2', 3)];
  it('topic → row (master order) → questions; each once, at its primary row, crossing topics; loose ones end their topic', () => {
    const qs = [q('SQ5', 'ST1', 'C3-01-002'), q('SQ4', 'ST1', 'C3-01-001', { type: 3 }), q('SQ3', 'ST1', 'C3-01-001', { type: 1 }),
      q('SQ2', 'ST2', 'C3-01-002'), q('SQ1', 'ST1', null), q('SQ6', 'ST2', 'C9-99-999'), q('SQ7', 'ST2', 'C3-02-001')];
    expect(walkOrder(rows, qs, ['ST1', 'ST2']).map((w) => `${w.question_id}@${w.row_id ?? w.topic_id}`))
      .toEqual(['SQ3@C3-01-001', 'SQ4@C3-01-001', 'SQ2@C3-01-002', 'SQ5@C3-01-002', 'SQ1@ST1', 'SQ7@C3-02-001', 'SQ6@ST2']);
  });
  it('position, previous, next; stops at the ends; only Needs review narrows it', () => {
    const w = walkOrder(rows, [q('A', 'ST1', 'C3-01-001'), q('B', 'ST1', 'C3-01-002'), q('C', 'ST2', 'C3-02-001')], ['ST1', 'ST2']);
    expect(walkStep(w, 'B')).toMatchObject({ pos: 2, total: 3, prev: { question_id: 'A' }, next: { question_id: 'C' } });
    expect(walkStep(w, 'A')).toMatchObject({ pos: 1, prev: null });
    expect(walkStep(w, 'C')).toMatchObject({ pos: 3, next: null });
    expect(walkStep(w, 'A', new Set(['A', 'C']))).toMatchObject({ pos: 1, total: 2, next: { question_id: 'C' } });
    expect(walkStep(w, 'B', new Set(['A', 'C']))).toMatchObject({ total: 2, prev: { question_id: 'A' }, next: { question_id: 'C' } });
  });
});

describe('(b) fix 24 Nov: the walk uses the Browse filters, so its total matches the chapter count', () => {
  // SC02 in the Class 3 view (Sambit's report): the tree shows 31 Qs (Level ≤ 3); ST0064 also has 8 Level-4 questions
  const lv = (id: string, topic_id: string, effective_level: number, o: { retired?: boolean; counted?: boolean } = {}) =>
    ({ ...q(id, topic_id, null), effective_level, retired_at: o.retired ? '2026-11-20' : null, counted: o.counted ?? true });
  const qs = [
    ...Array.from({ length: 20 }, (_, i) => lv(`A${i}`, 'ST0004', 3)),
    ...Array.from({ length: 11 }, (_, i) => lv(`B${i}`, 'ST0064', i % 2 ? 2 : 3)),
    ...Array.from({ length: 8 }, (_, i) => lv(`C${i}`, 'ST0064', 4)),
    lv('R1', 'ST0004', 3, { retired: true }), lv('G1', 'ST0004', 3, { counted: false }),
    ...Array.from({ length: 5 }, (_, i) => lv(`X${i}`, 'ST0099', 3)),   // an extra topic (lower / higher class), not shown in the tree
  ];
  const shown: { topic_id: string; ceiling: number | null }[] = [{ topic_id: 'ST0004', ceiling: 3 }, { topic_id: 'ST0064', ceiling: 3 }];
  it('Class 3, higher-level off, extra topics off: 31 (as the tree); higher on: 39; extra topic ticked: + its 5', () => {
    const total = (topics: typeof shown, higher: boolean) => walkStep(walkOrder([], walkQuestions(qs, topics, higher), topics.map((t) => t.topic_id)), null).total;
    expect(total(shown, false)).toBe(31);
    expect(total(shown, true)).toBe(39);
    expect(total([...shown, { topic_id: 'ST0099', ceiling: 3 }], false)).toBe(36);
    expect(total(shown.map((t) => ({ ...t, ceiling: null })), false)).toBe(39);   // All classes: no ceiling
  });
  it('a question of a topic not shown is never walked, even when its primary row is in a shown topic', () => {
    const rows = [row('C3-01-001', 'ST0004', 1)];
    const w = walkOrder(rows, walkQuestions([lv('A', 'ST0004', 3), { ...q('X', 'ST0099', 'C3-01-001'), effective_level: 3, counted: true }], shown, false), ['ST0004', 'ST0064']);
    expect(w.map((x) => x.question_id)).toEqual(['A']);
  });
  it('only Needs review narrows the same walk', () => {
    const w = walkOrder([], walkQuestions(qs, shown, false), ['ST0004', 'ST0064']);
    expect(walkStep(w, null, new Set(['A1', 'B2', 'C1'])).total).toBe(2);   // C1 is Level 4: not in the walk
  });
});

describe('(c)(e) primary line and proposal states', () => {
  it('primary: confirmed · proposed · rejected · none', () => {
    expect(primaryOf(q('A', 'ST1', 'C3-01-001'))).toEqual({ row_id: 'C3-01-001', state: 'confirmed' });
    expect(primaryOf(q('A', 'ST1', 'C3-01-001', { proposed: true }))).toEqual({ row_id: 'C3-01-001', state: 'proposed' });
    expect(primaryOf(q('A', 'ST1', null, { rejected: 'C3-01-002' }))).toEqual({ row_id: 'C3-01-002', state: 'rejected' });
    expect(primaryOf(q('A', 'ST1', null))).toEqual({ row_id: null, state: 'none' });
  });
  it('questions and rows', () => {
    expect(['draft', 'in_review', 'approved', 'rejected'].map((s) => questionState({ status: s }))).toEqual(['proposed', 'proposed', 'approved', 'rejected']);
    expect(questionState({ status: 'approved', retired_at: '2026-11-24' })).toBe('rejected');
    const r = row('C3-01-001', 'ST1', 1);
    expect(rowState(r, new Set(), [q('A', 'ST1', 'C3-01-001')])).toBe('approved');
    expect(rowState(r, new Set(), [q('A', 'ST1', 'C3-01-001', { proposed: true })])).toBe('proposed');
    expect(rowState(r, new Set(['C3-01-001']), [])).toBe('proposed');
    expect(rowState({ ...r, retired_at: 'x' }, new Set(), [])).toBe('rejected');
  });
  it('OL-044 (the 0048 (g) rule moved to the image status, 0049)', () => {
    const P = [{ rank: 'primary', rank_proposed: true }, { rank: 'secondary', rank_proposed: false }];
    expect(primaryConfirmedOnApproval('generation', P)).toBe(true);
    expect(primaryConfirmedOnApproval('import', P)).toBe(false);
    expect(primaryConfirmedOnApproval('generation', [{ rank: 'primary', rank_proposed: false }])).toBe(false);
  });
});

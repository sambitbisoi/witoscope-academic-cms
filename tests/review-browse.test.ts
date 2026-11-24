// Q38 PR 4 (24 Nov 2026): Previous / Next walk, primary line, proposal states. Synthetic rows only.
import { describe, expect, it } from 'vitest';
import { imageToRedo, primaryConfirmedOnApproval, primaryOf, questionState, rowState, walkOrder, walkStep } from '../web/src/scienceLogic.ts';

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
  it('OL-044 and (g)', () => {
    const P = [{ rank: 'primary', rank_proposed: true }, { rank: 'secondary', rank_proposed: false }];
    expect(primaryConfirmedOnApproval('generation', P)).toBe(true);
    expect(primaryConfirmedOnApproval('import', P)).toBe(false);
    expect(primaryConfirmedOnApproval('generation', [{ rank: 'primary', rank_proposed: false }])).toBe(false);
    expect(imageToRedo('science', 'generation', 'has_image')).toBe(true);
    expect(imageToRedo('science', 'manual', 'has_image')).toBe(false);
    expect(imageToRedo('math', 'generation', 'has_image')).toBe(false);
  });
});

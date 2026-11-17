// Q23 (0044): the screen's copy of the link rules (web/src/scienceLogic.ts linkChecks); the database applies the same ones.
import { describe, expect, it } from 'vitest';
import { linkChecks, type DraftLink } from '../web/src/scienceLogic.ts';

const saved: DraftLink[] = [{ row_id: 'A', rank: 'primary' }, { row_id: 'B', rank: 'secondary' }, { row_id: 'C', rank: 'context' }];
describe('linkChecks', () => {
  it('unchanged: no problem, not dirty', () => {
    expect(linkChecks(saved, saved, [])).toMatchObject({ problems: [], dirty: false });
  });
  it('exactly one primary', () => {
    expect(linkChecks([{ row_id: 'A', rank: 'secondary' }, saved[1]!], saved, []).problems).toEqual(['A Science question needs exactly one primary row (it now has 0).']);
    expect(linkChecks([saved[0]!, { row_id: 'B', rank: 'primary' }], saved, []).problems[0]).toMatch(/it now has 2/);
  });
  it('a referenced row: no removing; a direct one can not become supporting; primary → secondary is fine', () => {
    const refs = [{ row_id: 'B', what: 'the misconception targeted (B #1)' }, { row_id: 'C', what: "option A's misconception (C #1)" }];
    const c = linkChecks([saved[0]!, saved[2]!], saved, refs);
    expect(c.problems).toEqual(['Row B is still used by the misconception targeted (B #1); clear the reference first.']);
    expect(c.lock.get('B')).toEqual({ remove: 'Used by the misconception targeted (B #1): clear the reference first.', support: 'Used by the misconception targeted (B #1): clear the reference first, then make it supporting.' });
    expect(c.lock.get('C')!.support).toBeNull(); // already supporting: may stay supporting
    expect(linkChecks([saved[0]!, { row_id: 'B', rank: 'context' }, saved[2]!], saved, refs).problems[0]).toMatch(/then make it supporting/);
    expect(linkChecks([{ row_id: 'B', rank: 'primary' }, { row_id: 'A', rank: 'secondary' }, saved[2]!], saved, refs)).toMatchObject({ problems: [], dirty: true });
  });
});

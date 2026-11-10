import { describe, expect, it } from 'vitest';
import { scoreModelCheck } from '../shared/generation.ts';
import { currentRuleVersion, goldAction, ruleNo, workbookIsCurrent } from '../shared/rules.ts';

describe('current rule version', () => {
  it('reads the number', () => { expect(ruleNo('v11')).toBe(11); expect(ruleNo('11')).toBeNaN(); });
  it('uses cms_config when that version is loaded', () => expect(currentRuleVersion(['v10', 'v11'], 'v10')).toBe('v10'));
  it('falls back to the newest loaded version (numerically, not as text)', () => {
    expect(currentRuleVersion(['v9', 'v11', 'v10'], null)).toBe('v11');
    expect(currentRuleVersion(['v10', 'v11'], 'v12')).toBe('v11'); // configured but not loaded
  });
  it('is null when nothing is loaded', () => expect(currentRuleVersion([], 'v10')).toBeNull());
  it('a workbook is current when it is at least as new', () => {
    expect(workbookIsCurrent('v11', 'v10')).toBe(true);
    expect(workbookIsCurrent('v11', 'v11')).toBe(true);
    expect(workbookIsCurrent('v10', 'v11')).toBe(false);
    expect(workbookIsCurrent('v10', null)).toBe(true);
  });
});

describe('what the seed does with an existing gold question', () => {
  it('unchanged stays unchanged', () => expect(goldAction('unchanged', 'approved', false)).toBe('unchanged'));
  it('a changed value from the current workbook is a new approved version', () => expect(goldAction('new', 'approved', true)).toBe('new_version'));
  it('wording only is a typo fix in place', () => expect(goldAction('typo', 'approved', true)).toBe('typo_fix'));
  it('an older workbook never turns gold back', () => {
    expect(goldAction('new', 'approved', false)).toBe('report_only');
    expect(goldAction('typo', 'approved', false)).toBe('report_only');
  });
  it('an open edit in the CMS is never overwritten', () => {
    expect(goldAction('new', 'draft', true)).toBe('blocked_open_version');
    expect(goldAction('typo', 'in_review', true)).toBe('blocked_open_version');
  });
});

describe('model-check score over current test-only gold', () => {
  const s = (attribute: string, hits: number) => ({ attribute, hits, n: 1, near: false, gold: 'a', got: hits ? 'a' : 'b' });
  const results = [
    { qid: 'G1-001', scores: [s('Inhibition', 1), s('Reading', 1)] },
    { qid: 'G1-002', scores: [s('Inhibition', 0), s('Reading', 0)] }, // became a prompt example in v11
    { qid: 'G1-003', scores: [s('Inhibition', 0), s('Reading', 1)] },
  ];
  it('leaves out questions that are no longer test-only, and names them', () => {
    const r = scoreModelCheck(results, new Set(['G1-001', 'G1-003']));
    expect(r.excluded).toEqual(['G1-002']);
    expect(r.kept.map((x) => x.qid)).toEqual(['G1-001', 'G1-003']);
    expect(r.agreement.find((a) => a.attribute === 'Inhibition')).toMatchObject({ hits: 1, n: 2, pct: 50 });
    expect(r.agreement.find((a) => a.attribute === 'Reading')).toMatchObject({ hits: 2, n: 2, pct: 100 });
  });
});

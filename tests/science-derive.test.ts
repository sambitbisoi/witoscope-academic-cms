// Q29 + Q31 (Round 2, 17 Nov 2026): Science derived values and review warnings (unit).
import { describe, expect, it } from 'vitest';
import { scienceDerive, scienceTier, stepsBand } from '../shared/science-derive.ts';
import { scienceWarnings, type ScienceWarningInput } from '../shared/science-warnings.ts';

const base = { science_question_type: 2, reading: 1, steps: 1, inhibition: 0, has_hidden_idea: false, setting_familiarity: 'Bare', setting_id: null,
  links: [{ row_id: 'C6-04-001', role: 'direct', rank: 'primary' }], wrongTags: [] as string[] };

describe('scienceDerive', () => {
  it('tier from the type', () => {
    expect([1, 2, 3, 4, 5, null].map(scienceTier)).toEqual(['School', 'School', 'School', 'Achiever', 'Super Achiever', null]);
  });
  it('steps bands at every edge', () => {
    expect([1, 2, 3, 4, 5, 6, 8, 9, 20].map((n) => stepsBand(n))).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5]);
    expect(stepsBand(null)).toBeNull();
  });
  it('load = max(reading, steps band); a tie goes to reading; no working memory', () => {
    expect(scienceDerive({ ...base, reading: 2, steps: 3 })).toMatchObject({ load: 2, loadDriver: 'reading', stepsBand: 2 });
    expect(scienceDerive({ ...base, reading: 2, steps: 9 })).toMatchObject({ load: 5, loadDriver: 'multi_step' });
    expect(scienceDerive({ ...base, reading: null, steps: null })).toMatchObject({ load: null, loadDriver: null });
    expect(scienceDerive({ ...base, reading: null, steps: 4 })).toMatchObject({ load: 3, loadDriver: 'multi_step' });
  });
  it('markers: each one counted, none when unset', () => {
    expect(scienceDerive(base)).toMatchObject({ markers: 0, markerList: [] });
    const all = scienceDerive({ ...base, steps: 3, inhibition: 3, has_hidden_idea: true, setting_familiarity: 'Rare',
      links: [{ row_id: 'a', role: 'direct', rank: 'primary' }, { row_id: 'b', role: 'direct', rank: 'secondary' }, { row_id: 'c', role: 'supporting', rank: 'context' }] });
    expect(all.markers).toBe(5);
    expect(all.markerList).toEqual(['2+ direct rows', 'Steps ≥ 3', 'Inhibition 3', 'Hidden idea', 'Rare setting']);
    expect(scienceDerive({ ...base, steps: 2, inhibition: 2, links: [...base.links, { row_id: 'c', role: 'supporting', rank: 'context' }] }).markers).toBe(0);
  });
  it('trap level as Math; clone group = primary row + type + setting', () => {
    expect(scienceDerive({ ...base, wrongTags: ['misread', 'shortcut'] }).trapLevel).toBe(1);
    expect(scienceDerive({ ...base, wrongTags: ['shortcut', 'misconception'] }).trapLevel).toBe(2);
    expect(scienceDerive(base).cloneGroup).toBe('C6-04-001 · type 2 · bare');
    expect(scienceDerive({ ...base, setting_id: 'SET0101' }).cloneGroup).toBe('C6-04-001 · type 2 · SET0101');
    expect(scienceDerive({ ...base, science_question_type: null }).cloneGroup).toBeNull();
  });
});

describe('scienceWarnings (never block)', () => {
  const w = (o: Partial<ScienceWarningInput> & { markers?: number }) => {
    const x: ScienceWarningInput = { science_question_type: 2, has_irrelevant_info: false, has_hidden_idea: false, reading: 1, setting_familiarity: 'Bare', setting_id: null,
      level: 6, rows: [{ row_id: 'C6-04-001', role: 'direct', rank: 'primary', source: 'Book', chapter_role: 'Core', row_class: 6, safety: null, question_use: 'OK' }],
      derived: { markers: o.markers ?? 0, markerList: Array.from({ length: o.markers ?? 0 }, (_, i) => `m${i}`) }, ...o };
    return scienceWarnings(x).join(' | ');
  };
  it('a plain question has none', () => { expect(w({})).toBe(''); });
  it('type 1–3 with 2+ markers; type 5 with fewer than 2', () => {
    expect(w({ science_question_type: 3, markers: 2 })).toMatch(/Type 3 \(School\) has 2 markers/);
    expect(w({ science_question_type: 3, markers: 1 })).toBe('');
    expect(w({ science_question_type: 5, markers: 1 })).toMatch(/Type 5 .* 1 marker/);
    expect(w({ science_question_type: 5, markers: 2 })).toBe('');
  });
  it('type 1–2 with irrelevant info, a hidden idea or Reading > 2', () => {
    expect(w({ has_irrelevant_info: true })).toMatch(/irrelevant info/);
    expect(w({ science_question_type: 1, has_hidden_idea: true })).toMatch(/a hidden idea/);
    expect(w({ reading: 3 })).toMatch(/Reading 3/);
    expect(w({ science_question_type: 3, reading: 4, has_irrelevant_info: true })).toBe('');
  });
  it('type 1 whose primary row is not Book · Core', () => {
    const rows = [{ row_id: 'C6-04-007', role: 'direct', rank: 'primary', source: 'Claude-added', chapter_role: 'Extension', row_class: 6 }];
    expect(w({ science_question_type: 1, rows })).toMatch(/primary row C6-04-007 is Claude-added · Extension/);
    expect(w({ science_question_type: 2, rows })).toBe('');
  });
  it('primary / secondary row class above the Level; supporting rows do not count', () => {
    const rows = [{ row_id: 'C6-04-001', role: 'direct', rank: 'primary', source: 'Book', chapter_role: 'Core', row_class: 6 },
      { row_id: 'C7-04-002', role: 'direct', rank: 'secondary', row_class: 7 }, { row_id: 'C8-04-003', role: 'supporting', rank: 'context', row_class: 8 }];
    expect(w({ rows, level: 6 })).toMatch(/Secondary row C7-04-002 is Class 7, above the question's Level 6/);
    expect(w({ rows, level: 6 })).not.toMatch(/C8-04-003/);
  });
  it('a linked row with a safety note or "No questions"', () => {
    const rows = [{ row_id: 'C6-04-001', role: 'direct', rank: 'primary', source: 'Book', chapter_role: 'Core', row_class: 6, safety: 'Adult only.', question_use: 'No questions' }];
    expect(w({ rows })).toMatch(/safety note.*\| .*"No questions"/);
  });
  it('setting and familiarity agree (Bare ⇔ no setting)', () => {
    expect(w({ setting_familiarity: 'Everyday', setting_id: null })).toMatch(/no setting/);
    expect(w({ setting_familiarity: 'Bare', setting_id: 'SET0101' })).toMatch(/Bare but a setting/);
    expect(w({ setting_familiarity: 'Everyday', setting_id: 'SET0101' })).toBe('');
    expect(w({ setting_familiarity: null })).toBe('');
  });
});

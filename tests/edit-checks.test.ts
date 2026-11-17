// T1: subject-aware edit checks and Science save rows (unit).
import { describe, expect, it } from 'vitest';
import { checkFile, type Catalog } from '../shared/checks.ts';
import { checkEdit } from '../shared/edit-checks.ts';
import { rowsFor } from '../shared/save.ts';
import type { DerivedConfig, Question } from '../shared/types.ts';
import { structureHash } from '../shared/version.ts';

const cat: Catalog = {
  ruleVersions: new Set(['v11']), chapter: { chapter_id: 'MC97', subject: 'math' },
  topics: new Map([['MT9997', { chapter_id: 'MC97', class: 6, topic_kind: 'normal', taught_in_school: false, status: 'active' }],
    ['ST9997', { chapter_id: 'SC97', class: 6, topic_kind: 'normal', taught_in_school: false, status: 'active' }]]),
  typicalSets: new Map([['TS-G6-ZZ', { class: 6, status: 'active' }]]), patterns: new Set(), concepts: new Map([['G6-ZZ-C1', { class: 6 }]]),
  misconceptions: new Set(), insights: new Map(), sourceItems: new Set(), stems: new Map(), keyToQuestionId: new Map(),
};
const base = (): Question => ({
  key: 'MC97-0001', topic_id: 'MT9997', typical_set_id: 'TS-G6-ZZ', clone_batch_id: '', locale: 'IN', text: 'What is 2 + 3?',
  answer: { format: 'MCQ-4', options: ['4', '5', '6', '7'], correct: '5', wrong_answers: [{ value: '4', tag: 'misread' }] },
  concepts: [{ concept_id: 'G6-ZZ-C1', involvement: 1 }],
  signature: { math_difficulty: 'Simple', is_pure_fact: false, reading: 1, has_irrelevant_info: false, steps: 1, working_memory: 1, inhibition: 0, visual: 0, strategy: 0 },
  duration_s: 30, solutions: { school: '2 + 3 = 5' }, hints: [],
});
const sci = (): Question => ({
  ...base(), key: 'SQ1', topic_id: 'ST9997', typical_set_id: null as never, concepts: [],
  answer: { format: 'MCQ-4', options: ['a', 'b', 'c', 'd'], correct: 'b', wrong_answers: [] },
  science: { reading: null, steps: null, inhibition: null, visual: null, has_irrelevant_info: null, is_pure_fact: null },
});
const ctx = (subject: string) => ({ subject, ruleVersion: 'v11', cls: 6, chapterId: subject === 'science' ? 'SC97' : 'MC97', catalog: cat,
  linkedRows: ['C6-ZZ-001'], rowItems: [{ row_id: 'C6-ZZ-001', item_no: 1, text: 'A belief', status: 'active' }, { row_id: 'C6-ZZ-009', item_no: 1, text: 'Other', status: 'active' }] });
const cfg = { multistep_bands: [{ min: 1, max: null, band: 1 }], difficulty_points: { Simple: 1, Medium: 2, Complex: 3 } } as unknown as DerivedConfig;

describe('checkEdit', () => {
  it('Math: exactly the chapter-file checks', () => {
    for (const q of [base(), { ...base(), typical_set_id: 'TS-NOPE' }, { ...base(), concepts: [] }, { ...base(), answer: { ...base().answer, wrong_answers: [] } }]) {
      const file = { file_schema: 'cms-chapter/1.0' as const, attribute_version: 'v11', subject: 'math' as const, class: 6, chapter_id: 'MC97', generated: { by: 'CMS editor', date: '2026-11-17' }, questions: [q] };
      expect(checkEdit(q, ctx('math'))).toEqual(checkFile(file, cat, { gold: true }).filter((p) => p.key !== 'file' || p.level === 'error'));
    }
    expect(checkEdit({ ...base(), concepts: [] }, ctx('math')).some((p) => /involvement 1.0/.test(p.message))).toBe(true);
  });
  it('Science: no typical set, concept or untagged-option errors', () => {
    expect(checkEdit(sci(), ctx('science')).filter((p) => p.level === 'error')).toEqual([]);
  });
  it('Science: a wrong-option item must belong to a linked row and be usable', () => {
    const q = sci(); q.answer.wrong_answers = [{ value: 'a', tag: 'misconception', mc: { row_id: 'C6-ZZ-001', item_no: 1 } }];
    expect(checkEdit(q, ctx('science')).filter((p) => p.level === 'error')).toEqual([]);
    q.answer.wrong_answers = [{ value: 'a', tag: 'misconception', mc: { row_id: 'C6-ZZ-009', item_no: 1 } }];
    expect(checkEdit(q, ctx('science')).map((p) => p.message).join()).toMatch(/not an item of this question's content rows/);
    q.answer.wrong_answers = [{ value: 'a', tag: 'misconception', mc: { row_id: 'C6-ZZ-001', item_no: 7 } }];
    expect(checkEdit(q, ctx('science')).map((p) => p.message).join()).toMatch(/does not exist/);
    const r = ctx('science'); r.rowItems[0]!.status = 'retired';
    q.answer.wrong_answers = [{ value: 'a', tag: 'misconception', mc: { row_id: 'C6-ZZ-001', item_no: 1 } }];
    expect(checkEdit(q, r).map((p) => p.message).join()).toMatch(/retired/);
  });
  it('Science: signature values out of range are errors; unset is fine', () => {
    const q = sci(); q.science!.reading = 9;
    expect(checkEdit(q, ctx('science')).map((p) => p.message).join()).toMatch(/Reading/);
  });
});

describe('rowsFor (T1)', () => {
  it('Science: Math signature and derived fields are null; Science signature kept', () => {
    const q = sci(); q.science = { reading: 2, steps: 3, inhibition: 1, visual: 0, has_irrelevant_info: true, is_pure_fact: false };
    const r = rowsFor(q, cfg, 6, () => 6);
    expect(r.derived).toBeNull();
    const v = r.version as Record<string, unknown>;
    for (const k of ['math_difficulty', 'working_memory', 'strategy', 'tier', 'load', 'multistep_band', 'difficulty_points', 'trap_level', 'style']) expect(v[k]).toBeNull();
    expect([v.reading, v.steps, v.inhibition, v.visual, v.has_irrelevant_info, v.is_pure_fact]).toEqual([2, 3, 1, 0, true, false]);
  });
  it('Math: version unchanged by the split (derived fields present), structure hash ignores the Science block only when absent', () => {
    const r = rowsFor(base(), cfg, 6, () => 6);
    expect((r.version as Record<string, unknown>).tier).toBe('School');
    expect(r.derived?.tier).toBe('School');
    const a = sci(), b = sci(); b.science!.reading = 3;
    expect(structureHash(a, a.topic_id)).not.toBe(structureHash(b, b.topic_id));
  });
});

describe('Q20: tier uses Level', () => {
  it('judges concepts against Level, else the placement class', async () => {
    const { derive, tierBasis } = await import('../shared/derive.ts');
    const q = base();                                   // concept class 6, strategy 0
    expect(derive(q, tierBasis({ level: 5, class: 6 }), () => 6, cfg).tier).toBe('Super Achiever');
    expect(derive(q, tierBasis({ level: 6, class: 3 }), () => 6, cfg).tier).toBe('School');
    expect(derive(q, tierBasis({ level: null, class: 6 }), () => 6, cfg).tier).toBe('School');
    expect(derive(q, tierBasis({ level: null, class_override: 5, class: 6 }), () => 6, cfg).tier).toBe('Super Achiever');
    expect(derive({ ...q, signature: { ...q.signature, strategy: 2 } }, tierBasis({ level: 6, class: 6 }), () => 6, cfg).tier).toBe('Achiever');
    expect(derive({ ...q, signature: { ...q.signature, strategy: 3 } }, tierBasis({ level: 6, class: 6 }), () => 1, cfg).tier).toBe('Super Achiever');
  });
});

// 0041 (Round 2): Q26 S1 fields, Q28 settings, Q32 Science wrong-option tags
describe('Science attributes and tags (0041)', () => {
  const errs = (q: Question, c = ctx('science') as Parameters<typeof checkEdit>[1]) => checkEdit(q, c).filter((p) => p.level === 'error').map((p) => p.message);
  it('any of the 9 tags; a concept error targets one of its rows; a target row only with a concept error', () => {
    const q = sci();
    q.answer.wrong_answers = [{ value: 'a', tag: 'shortcut' }, { value: 'c', tag: 'concept_error', target_row_id: 'C6-ZZ-001' }, { value: 'd', tag: 'unit_slip', why: 'x' }];
    expect(errs(q)).toEqual([]);
    q.answer.wrong_answers = [{ value: 'c', tag: 'concept_error' }];
    expect(errs(q).join()).toMatch(/needs a target row/);
    q.answer.wrong_answers = [{ value: 'c', tag: 'concept_error', target_row_id: 'C6-ZZ-009' }];
    expect(errs(q).join()).toMatch(/not one of this question's content rows/);
    q.answer.wrong_answers = [{ value: 'c', tag: 'misread', target_row_id: 'C6-ZZ-001' }];
    expect(errs(q).join()).toMatch(/only with a concept error/);
  });
  it('S1 fields: unset is fine; a set value must be valid; the setting must be a Science setting', () => {
    const q = sci();
    q.science = { ...q.science!, science_question_type: 4, setting_familiarity: 'Rare', has_hidden_idea: true, has_experiment: false, setting_id: 'SET0101' };
    expect(errs(q, { ...ctx('science'), settings: new Set(['SET0101']) })).toEqual([]);
    expect(errs(q, { ...ctx('science'), settings: new Set() }).join()).toMatch(/not a Science setting/);
    q.science.science_question_type = 6 as never;
    expect(errs(q).join()).toMatch(/Science question type/);
    q.science.science_question_type = 1; q.science.setting_familiarity = 'Odd' as never;
    expect(errs(q).join()).toMatch(/setting familiarity/);
  });
  it('rowsFor writes S1 fields and target rows; the S1 fields are structure (a change = a new version)', () => {
    const q = sci();
    q.science = { ...q.science!, science_question_type: 3, setting_familiarity: 'Everyday', has_hidden_idea: false, has_experiment: true };
    q.answer.wrong_answers = [{ value: 'c', tag: 'concept_error', target_row_id: 'C6-ZZ-001' }];
    const r = rowsFor(q, cfg, 6, () => 6);
    expect(r.version).toMatchObject({ science_question_type: 3, setting_familiarity: 'Everyday', has_hidden_idea: false, has_experiment: true, tier: null });
    expect(r.wrong_answers[0]).toMatchObject({ tag: 'concept_error', target_row_id: 'C6-ZZ-001' });
    const h1 = structureHash(q, q.topic_id);
    q.science.science_question_type = 4;
    expect(structureHash(q, q.topic_id)).not.toBe(h1);
    q.science.science_question_type = 3; q.science.setting_id = 'SET0101';
    expect(structureHash(q, q.topic_id)).not.toBe(h1);
  });
  it('Math structure hashes are unchanged by the new fields', () => {
    const m = base();
    expect(structureHash(m, m.topic_id)).toBe(structureHash({ ...m, answer: { ...m.answer, wrong_answers: m.answer.wrong_answers!.map((w) => ({ ...w })) } }, m.topic_id));
    expect(rowsFor(m, cfg, 6, () => 6).version).not.toHaveProperty('science_question_type');
  });
});

// Q35: Edit and import:science use the same driver ranges (shared/science.ts SCIENCE_DRIVERS)
describe('Q35 driver ranges shared with the import', () => {
  it('Edit refuses the same values the import holds', () => {
    const q = sci(); q.science = { ...q.science!, reading: 6, steps: 21, inhibition: 4, visual: -1 };
    const msgs = checkEdit(q, ctx('science')).filter((p) => p.level === 'error').map((p) => p.message).join(' | ');
    for (const m of ['Reading must be a whole number from 1 to 5', 'Steps must be a whole number from 1 to 20', 'Inhibition must be a whole number from 0 to 3', 'Visual must be a whole number from 0 to 3'])
      expect(msgs).toContain(m);
    q.science = { ...q.science!, reading: 1, steps: 20, inhibition: 0, visual: 3 };
    expect(checkEdit(q, ctx('science')).filter((p) => p.level === 'error')).toEqual([]);
  });
});

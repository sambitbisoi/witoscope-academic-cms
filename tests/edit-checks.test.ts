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

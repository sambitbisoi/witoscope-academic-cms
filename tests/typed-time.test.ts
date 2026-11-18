// Q36 (18 Nov 2026): the Typed-time format: h:mm stored, two boxes hh : mm, checked numerically per box, no a.m./p.m.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkFile, type Catalog } from '../shared/checks.ts';
import { checkEdit } from '../shared/edit-checks.ts';
import { DRAFT_SCHEMA } from '../shared/generation.ts';
import { storedFormat } from '../shared/science.ts';
import { boxesToTime, formatTime, parseTime, timeBoxes, typedTimeMatches, typedTimeProblems } from '../shared/typed-time.ts';
import type { ChapterFile, Question } from '../shared/types.ts';
import { schemaProblems } from '../scripts/lib/chapter/schema.ts';
import { ADD_FORMATS, mandatoryErrors, normaliseTime, parseUploadRow, type UploadLookups } from '../web/src/logic.ts';

describe('typed-time helpers', () => {
  it('parses h:mm and hh:mm; refuses anything else', () => {
    expect(parseTime('7:30')).toEqual({ h: 7, m: 30 });
    expect(parseTime('07:30')).toEqual({ h: 7, m: 30 });
    expect(parseTime('11:05')).toEqual({ h: 11, m: 5 });
    for (const bad of ['7.30', '7:3', '7:60', '24:00', '7:30 am', '730', '', 'seven thirty']) expect(parseTime(bad)).toBeNull();
    expect(formatTime({ h: 3, m: 5 })).toBe('3:05');
    expect(timeBoxes('3:45')).toEqual(['3', '45']);
  });
  it('checks the child numerically per box: 3 = 03, 5 = 05', () => {
    expect(typedTimeMatches('3', '45', '3:45')).toBe(true);
    expect(typedTimeMatches('03', '45', '3:45')).toBe(true);
    expect(typedTimeMatches('7', '5', '7:05')).toBe(true);
    expect(typedTimeMatches('7', '05', '7:05')).toBe(true);
    expect(typedTimeMatches('7', '50', '7:05')).toBe(false);
    expect(typedTimeMatches('4', '45', '3:45')).toBe(false);
    expect(typedTimeMatches('', '45', '3:45')).toBe(false);
    expect(typedTimeMatches('3', 'x', '3:45')).toBe(false);
    expect(typedTimeMatches('15', '45', '3:45', ['15:45'])).toBe(true); // an accepted 24-hour reading
    expect(boxesToTime('123', '00')).toBeNull();
  });
  it('the stored answer must be h:mm, no leading zero, no a.m./p.m.', () => {
    expect(typedTimeProblems({ correct: '7:30' }).errors).toEqual([]);
    expect(typedTimeProblems({ correct: '07:30' }).errors[0]).toMatch(/stored as 7:30/);
    expect(typedTimeProblems({ correct: '7:30 a.m.' }).errors[0]).toMatch(/no a\.m\.\/p\.m\./);
    expect(typedTimeProblems({ correct: '7.30' }).errors[0]).toMatch(/not a time h:mm/);
    expect(typedTimeProblems({ correct: '' }).errors).toEqual(['the correct answer is empty']);
    expect(typedTimeProblems({ correct: '7:30', accepted: ['07:30', 'half past seven'] }).errors).toEqual(['accepted answer "half past seven" is not a time h:mm']);
    expect(typedTimeProblems({ correct: '7:30', wrong_answers: [{ value: '6:30' }, { value: 'x' }] }).warnings).toEqual(['wrong answer "x" is not a time h:mm']);
  });
});

const example: ChapterFile = JSON.parse(readFileSync('content/examples/MC19-example.json', 'utf8'));
const catalog: Catalog = {
  ruleVersions: new Set(['v10']), chapter: { chapter_id: 'MC19', subject: 'math' },
  topics: new Map([['MT0393', { chapter_id: 'MC19', class: 6, topic_kind: 'normal', taught_in_school: true, status: 'active' }]]),
  typicalSets: new Map([['TS-G6-FRAC-ADD-UNLIKE', { class: 6, status: 'draft' }]]), patterns: new Set(['MP0007']),
  concepts: new Map([['G6-FRC-C1', { class: 6 }], ['G6-FRC-C2', { class: 6 }]]), misconceptions: new Set(['G6-M-FRC1']),
  insights: new Map([['INS-LAST-STEP', { status: 'active' }]]), stems: new Map(), keyToQuestionId: new Map(), sourceItems: new Set(['N7-031']),
};
const timeQ = (correct: string, accepted: string[] = []): Question => {
  const q = structuredClone(example.questions[0]!);
  q.text = 'The clock shows a quarter to four. Write the time.';
  q.answer = { format: 'Typed-time', correct, accepted, wrong_answers: [{ value: '4:45', tag: 'misread' }] };
  return q;
};
const fileOf = (q: Question): ChapterFile => ({ ...structuredClone(example), questions: [q] });

describe('chapter files (schema + checkFile, used by import:chapter)', () => {
  it('a Typed-time question is schema-valid and passes the checks', () => {
    expect(schemaProblems(fileOf(timeQ('3:45', ['03:45'])))).toEqual([]);
    expect(checkFile(fileOf(timeQ('3:45', ['03:45'])), catalog).filter((p) => p.level === 'error')).toEqual([]);
  });
  it('a wrongly written answer blocks the file', () => {
    expect(checkFile(fileOf(timeQ('03:45')), catalog).filter((p) => p.level === 'error').map((p) => p.message)).toEqual(['Typed-time answer "03:45" must be stored as 3:45 (h:mm, no leading zero on the hours)']);
    expect(checkFile(fileOf(timeQ('3:45 pm')), catalog).some((p) => p.level === 'error' && /a\.m\./.test(p.message))).toBe(true);
  });
  it('the 6 DAV keys of DAV-typed-time-keys.csv are written as the format expects', () => {
    for (const [c, acc] of [['7:30', '07:30'], ['11:30', ''], ['7:35', '07:35'], ['10:35', ''], ['8:30', '08:30'], ['3:45', '03:45']] as const)
      expect(typedTimeProblems({ correct: c, accepted: acc ? [acc] : [] }).errors).toEqual([]);
  });
});

describe('editor (Math + Science), add / upload, Science import, generation', () => {
  it('the editor checks a Typed-time answer for Math and Science', () => {
    const ctx = { subject: 'math', ruleVersion: 'v10', cls: 6, chapterId: 'MC19', catalog };
    expect(checkEdit(timeQ('3:45'), ctx).filter((p) => p.level === 'error')).toEqual([]);
    expect(checkEdit(timeQ('3.45'), ctx).some((p) => p.level === 'error')).toBe(true);
    const sci: Question = { ...timeQ('3:45'), topic_id: 'MT0393', concepts: [], answer: { format: 'Typed-time', correct: '3:45' },
      science: { reading: null, steps: null, inhibition: null, visual: null, has_irrelevant_info: null, is_pure_fact: null } };
    expect(checkEdit(sci, { ...ctx, subject: 'science' }).filter((p) => p.level === 'error')).toEqual([]);
    expect(checkEdit({ ...sci, answer: { format: 'Typed-time', correct: '15:75' } }, { ...ctx, subject: 'science' }).some((p) => p.level === 'error')).toBe(true);
  });
  it('Add questions / Excel upload: Typed-time is in the list; 07:30 and an Excel time cell become 7:30', () => {
    expect(ADD_FORMATS).toContain('Typed-time');
    expect(normaliseTime('07:30')).toBe('7:30');
    expect(normaliseTime('0.3125')).toBe('7:30');
    expect(normaliseTime('half past')).toBe('half past');
    const look: UploadLookups = { concepts: new Set(), sets: new Set(), patterns: new Map(), settings: new Set(), sourceItems: new Set() };
    const r = parseUploadRow(2, { text: 'What time does the clock show?', format: 'typed-time', correct: '07:30', level: '2', picture: 'N' }, look);
    expect(r.errors).toEqual([]);
    expect(r.q!.format).toBe('Typed-time');
    expect(r.q!.correct).toBe('7:30');
    expect(mandatoryErrors({ ...r.q!, correct: '7:30 pm' })).toEqual(['Typed-time answer "7:30 pm": no a.m./p.m. in the answer (store h:mm, e.g. 7:30)']);
  });
  it('Science import: a "Typed-time" row has no options', () => {
    expect(storedFormat('Typed-time', [null, null, null, null])).toBe('Typed-time');
    expect(() => storedFormat('Typed time', ['a', null, null, null])).toThrow(/takes no options/);
  });
  it('generation schema offers Typed-time', () => {
    expect(JSON.stringify(DRAFT_SCHEMA)).toContain('Typed-time');
  });
});

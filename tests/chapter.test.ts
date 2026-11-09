import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkFile, type Catalog } from '../scripts/lib/chapter/checks.ts';
import { derive, multistepBand } from '../scripts/lib/chapter/derive.ts';
import { schemaProblems } from '../scripts/lib/chapter/schema.ts';
import type { ChapterFile, Question } from '../scripts/lib/chapter/types.ts';
import { classify, numbersIn, structureHash, textsOf } from '../scripts/lib/chapter/version.ts';
import type { DerivedConfig } from '../scripts/lib/v10-config.ts';

const example: ChapterFile = JSON.parse(readFileSync('content/examples/MC19-example.json', 'utf8'));
const clone = <T>(x: T): T => structuredClone(x);
const q0 = () => clone(example.questions[0]!);
const withQ = (...qs: Question[]): ChapterFile => ({ ...clone(example), questions: qs });

const cfg: DerivedConfig = {
  multistep_bands: [{ min: 1, max: 1, band: 1 }, { min: 2, max: 3, band: 2 }, { min: 4, max: 5, band: 3 }, { min: 6, max: 8, band: 4 }, { min: 9, max: null, band: 5 }],
  difficulty_points: { Simple: 3, Medium: 5, Complex: 8 },
  load_thresholds: { high: 3, very_high: 4 },
};

const catalog = (over: Partial<Catalog> = {}): Catalog => ({
  ruleVersions: new Set(['v10']),
  chapter: { chapter_id: 'MC19', subject: 'math' },
  topics: new Map([
    ['MT0393', { chapter_id: 'MC19', class: 6, topic_kind: 'normal', taught_in_school: true, status: 'active' }],
    ['ACH-MC19-6', { chapter_id: 'MC19', class: 6, topic_kind: 'achievers', taught_in_school: false, status: 'active' }],
    ['MT0100', { chapter_id: 'MC05', class: 6, topic_kind: 'normal', taught_in_school: true, status: 'active' }],
  ]),
  typicalSets: new Map([['TS-G6-FRAC-ADD-UNLIKE', { class: 6, status: 'draft' }], ['TS-G5-FRAC-X', { class: 5, status: 'draft' }]]),
  patterns: new Set(['MP0007']),
  concepts: new Map([['G6-FRC-C1', { class: 6 }], ['G6-FRC-C2', { class: 6 }]]),
  misconceptions: new Set(['G6-M-FRC1']),
  insights: new Map([['INS-LAST-STEP', { status: 'active' }]]),
  stems: new Map(),
  keyToQuestionId: new Map(),
  sourceItems: new Set(['N7-031']),
  ...over,
});
const msgs = (f: ChapterFile, c = catalog()) => checkFile(f, c).map((p) => `${p.level}: ${p.message}`);
const errs = (f: ChapterFile, c = catalog()) => checkFile(f, c).filter((p) => p.level === 'error').map((p) => p.message);

describe('schema', () => {
  it('the worked example is schema-valid', () => expect(schemaProblems(example)).toEqual([]));
  it('reports problems in plain words against the question key', () => {
    const q = q0() as unknown as Record<string, unknown>;
    delete q.hints; (q.signature as Record<string, unknown>).reading = 9; q.colour = 'red';
    const ps = schemaProblems(withQ(q as unknown as Question));
    expect(ps.every((p) => p.key === 'MC19-0001')).toBe(true);
    expect(ps.map((p) => p.message)).toEqual(expect.arrayContaining(['missing "hints"', 'unknown field "colour"', 'signature.reading must be <= 5']));
  });
});

describe('checks (design §8)', () => {
  it('the worked example passes, with the v10 Smart-calculation warning', () => {
    expect(msgs(example)).toEqual(['warning: solution 2 uses Smart calculation, so its type should be "Smarter way", not "Another way" (v10 rule)']);
  });

  it('every referenced ID must exist', () => {
    const q = q0(); q.typical_set_id = 'TS-G6-NOPE'; q.pattern_id = 'MP0999'; q.concepts.push({ concept_id: 'G6-FRC-C9', involvement: 0.5 });
    q.answer.wrong_answers![0]!.misconception_id = 'G6-M-FRC9'; q.signature.insight_id = 'INS-NOPE';
    expect(errs(withQ(q))).toEqual(expect.arrayContaining([
      'typical set TS-G6-NOPE does not exist', 'pattern MP0999 does not exist (not in the CMS or in this file\'s patterns)',
      'concept G6-FRC-C9 does not exist', 'misconception G6-M-FRC9 does not exist', 'insight INS-NOPE does not exist',
    ]));
  });

  it('a pattern defined in the same file counts as existing', () => {
    const f = withQ(Object.assign(q0(), { pattern_id: 'MP0123' }));
    f.patterns = [{ pattern_id: 'MP0123', topic_id: 'MT0393', typical_set_id: 'TS-G6-FRAC-ADD-UNLIKE', name: 'x' }];
    expect(errs(f)).toEqual([]);
  });

  it('typical set class must equal topic class', () => {
    expect(errs(withQ(Object.assign(q0(), { typical_set_id: 'TS-G5-FRAC-X' })))).toContain('typical set TS-G5-FRAC-X is class 5, but topic MT0393 is class 6');
  });

  it('needs a concept at involvement 1.0', () => {
    const q = q0(); q.concepts = [{ concept_id: 'G6-FRC-C1', involvement: 0.5 }];
    expect(errs(withQ(q))).toContain('needs at least one concept at involvement 1.0');
  });

  it('MCQ: correct must be an option; every wrong option tagged', () => {
    const q = q0(); q.answer.correct = '8/12';
    expect(errs(withQ(q))).toContain('correct answer "8/12" is not one of the options');
    const q2 = q0(); q2.answer.wrong_answers = q2.answer.wrong_answers!.slice(0, 1);
    expect(errs(withQ(q2))).toContain('wrong options not tagged: "4/12", "13/12"');
  });

  it('Achievers questions may leave wrong options untagged', () => {
    const q = q0(); q.topic_id = 'ACHIEVERS'; q.answer.wrong_answers = [];
    expect(errs(withQ(q))).toEqual([]);
  });

  it('ACHIEVERS outside Math is an error (no Achiever rule yet)', () => {
    const f = withQ(Object.assign(q0(), { topic_id: 'ACHIEVERS' }));
    expect(errs({ ...f, subject: 'science' }, catalog({ chapter: { chapter_id: 'MC19', subject: 'science' } })))
      .toContain('topic ACHIEVERS is Math only for now; science has no Achiever rule yet');
  });

  it('a source ref not in the CMS is a warning until Phase 4', () => {
    expect(msgs(example, catalog({ sourceItems: new Set() }))).toContain('warning: source ref N7-031 is not in the CMS yet (sources arrive in Phase 4)');
    expect(errs(example, catalog({ sourceItems: new Set() }))).toEqual([]);
  });

  it('ACHIEVERS with no Achievers row is an error', () => {
    const c = catalog(); c.topics.delete('ACH-MC19-6');
    expect(errs(withQ(Object.assign(q0(), { topic_id: 'ACHIEVERS' })), c)).toContain('topic ACHIEVERS: there is no Achievers row ACH-MC19-6 for MC19 class 6');
  });

  it('option counts per format; Multi-part ⇔ parts', () => {
    const q = q0(); q.answer.options = q.answer.options!.slice(0, 3);
    expect(errs(withQ(q))).toContain('MCQ-4 needs 4 options, found 3');
    const q2 = q0(); q2.answer.format = 'Multi-part';
    expect(errs(withQ(q2))).toContain('Multi-part needs at least two parts');
  });

  it('topic must be in this chapter and this class', () => {
    expect(errs(withQ(Object.assign(q0(), { topic_id: 'MT0100' })))).toContain('topic MT0100 belongs to chapter MC05, not MC19');
  });

  it('duplicate key in file is an error; duplicate stem is a warning', () => {
    const f = withQ(q0(), q0());
    expect(errs(f)).toContain('key appears twice in this file (questions 1 and 2)');
    expect(msgs(f)).toContain('warning: same question text as MC19-0001 in this file');
    expect(msgs(example, catalog({ stems: new Map([['5/6 − 1/4 =', 'MC19-0200']]) }))).toContain('warning: same question text as MC19-0200 already in the bank');
  });

  it('strategy warnings', () => {
    const q = q0(); q.signature.strategy = 2;
    expect(msgs(withQ(q))).toEqual(expect.arrayContaining([
      'warning: strategy 2 needs a strategy_type',
      'warning: strategy 2 on a topic taught in school (NCERT/DAV); check it isn\'t a School question',
    ]));
    const q2 = q0(); q2.signature.strategy_type = 'Other';
    expect(msgs(withQ(q2))).toContain('warning: strategy type "Other" needs strategy_other_note');
  });

  it('visual and working-memory warnings', () => {
    const q = q0(); q.signature.visual = 2; q.signature.working_memory = 4;
    expect(msgs(withQ(q))).toEqual(expect.arrayContaining([
      'warning: visual 2 but the question has no figure',
      'warning: working memory 4 but the text doesn\'t say to work without writing',
    ]));
  });

  it('file-level: unknown attribute version, chapter or subject mismatch', () => {
    expect(errs({ ...example, attribute_version: 'v9' })).toContain('attribute version v9 is not loaded in the CMS (loaded: v10)');
    expect(errs(example, catalog({ chapter: { chapter_id: 'MC19', subject: 'science' } }))).toContain('chapter MC19 is science, but the file says math');
  });

  it('question_id must match the key\'s existing ID', () => {
    const q = Object.assign(q0(), { question_id: 'MQ000009' });
    expect(errs(withQ(q))).toContain('question_id MQ000009 given, but this key has never been imported; leave question_id out on first import');
    expect(errs(withQ(q), catalog({ keyToQuestionId: new Map([['MC19-0001', 'MQ000001']]) }))).toContain('question_id MQ000009 does not match MQ000001, the ID this key already has');
  });
});

describe('derived fields (design §4)', () => {
  const cls = (id: string) => (id === 'G7-FRC-C1' ? 7 : 6);
  it('the worked example', () => {
    expect(derive(q0(), 6, cls, cfg)).toEqual({
      multistep_band: 1, load: 1, load_driver: 'reading', style: 'one-liner', tier: 'School',
      trap_level: 2, is_isolating: true, difficulty_points: 5,
    });
  });
  it.each([[1, 1], [2, 2], [3, 2], [4, 3], [5, 3], [6, 4], [8, 4], [9, 5], [20, 5]])('steps %i → band %i', (steps, band) => {
    expect(multistepBand(steps, cfg.multistep_bands)).toBe(band);
  });
  it('load driver ties: reading > multi-step > memory', () => {
    const q = q0(); Object.assign(q.signature, { reading: 2, steps: 2, working_memory: 2 });
    expect(derive(q, 6, cls, cfg)).toMatchObject({ load: 2, load_driver: 'reading', style: 'word' });
    Object.assign(q.signature, { reading: 1, steps: 4, working_memory: 3 });
    expect(derive(q, 6, cls, cfg)).toMatchObject({ load: 3, load_driver: 'multi_step' });
    Object.assign(q.signature, { reading: 1, steps: 1, working_memory: 4 });
    expect(derive(q, 6, cls, cfg)).toMatchObject({ load: 4, load_driver: 'memory' });
  });
  it('tier: strategy 2 → Achiever; 3 or a beyond-grade concept → Super Achiever', () => {
    const q = q0(); q.signature.strategy = 2;
    expect(derive(q, 6, cls, cfg).tier).toBe('Achiever');
    q.signature.strategy = 3;
    expect(derive(q, 6, cls, cfg).tier).toBe('Super Achiever');
    const q2 = q0(); q2.concepts.push({ concept_id: 'G7-FRC-C1', involvement: 0.2 });
    expect(derive(q2, 6, cls, cfg).tier).toBe('Super Achiever');
  });
  it('trap level and isolating', () => {
    const q = q0(); q.answer.wrong_answers = [{ value: '4/2', tag: 'shortcut' }];
    expect(derive(q, 6, cls, cfg).trap_level).toBe(1);
    q.answer.wrong_answers = [];
    expect(derive(q, 6, cls, cfg).trap_level).toBe(0);
    q.concepts.push({ concept_id: 'G6-FRC-C2', involvement: 0.5 });
    expect(derive(q, 6, cls, cfg).is_isolating).toBe(false);
  });
});

describe('same version vs new version (design §3)', () => {
  const snap = (q: Question) => ({ structureHash: structureHash(q, 'MT0393'), texts: textsOf(q) });
  const base = snap(q0());

  it('identical → unchanged', () => expect(classify(base, snap(q0())).kind).toBe('unchanged'));

  it('wording only, same numbers → typo, with a before/after diff', () => {
    const q = q0(); q.hints[0] = 'Make the denominators equal.';
    expect(classify(base, snap(q))).toEqual({ kind: 'typo', diff: { 'hint.1': { before: 'Make the denominators the same.', after: 'Make the denominators equal.' } } });
  });

  it('why notes and summary are wording too', () => {
    const q = q0(); q.tagging!.why!.reading!.why = 'A bare calculation with no story.';
    expect(classify(base, snap(q)).kind).toBe('typo');
  });

  it('a number in the wording → new version', () => {
    const q = q0(); q.solutions.school = q.solutions.school.replace('LCM of 6 and 4 is 12', 'LCM of 6 and 4 is 24');
    expect(classify(base, snap(q))).toMatchObject({ kind: 'new', reason: expect.stringContaining('a number in the wording changed') });
  });

  it.each<[string, (q: Question) => void]>([
    ['option', (q) => { q.answer.options![3] = '11/12'; q.answer.wrong_answers![2]!.value = '11/12'; }],
    ['correct answer', (q) => { q.answer.accepted = ['14/24', '21/36']; }],
    ['format', (q) => { q.answer.format = 'MCQ-3'; }],
    ['concept involvement', (q) => { q.concepts[0]!.involvement = 0.5; }],
    ['wrong-answer tag', (q) => { q.answer.wrong_answers![2]!.tag = 'implausible'; }],
    ['signature value', (q) => { q.signature.inhibition = 2; }],
    ['typical set', (q) => { q.typical_set_id = 'TS-G6-FRAC-OTHER'; }],
    ['pattern', (q) => { q.pattern_id = 'MP0008'; }],
    ['added hint', (q) => { q.hints.push('Check your answer.'); }],
    ['image added', (q) => { q.figure = { description: 'x', image_status: 'has_image', image_file: 'a.png' }; }],
    ['tag confidence', (q) => { q.tagging!.why!.reading!.confidence = 'low'; }],
  ])('%s change → new version', (_n, mutate) => {
    const q = q0(); mutate(q);
    expect(classify(base, snap(q)).kind).toBe('new');
  });

  it('topic move → new version', () => {
    expect(classify(base, { structureHash: structureHash(q0(), 'MT0394'), texts: textsOf(q0()) }).kind).toBe('new');
  });

  it('--force-new-version turns a typo into a new version', () => {
    const q = q0(); q.hints[0] = 'Make the denominators equal.';
    expect(classify(base, snap(q), true)).toEqual({ kind: 'new', reason: '--force-new-version' });
  });

  it('numbersIn reads fractions, decimals and grouped numbers', () => {
    expect(numbersIn({ a: '5/6 − 1/4 = 7/12; 3.5 and 1,000' })).toEqual(['1,000', '1/4', '3.5', '5/6', '7/12']);
  });
});

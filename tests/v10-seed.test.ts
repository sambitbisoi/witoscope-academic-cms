import { describe, expect, it } from 'vitest';
import { parseSeed, typedFormat } from '../scripts/lib/v10-seed.ts';
import type { Cell } from '../scripts/lib/xlsx.ts';

// Minimal workbook in v10's shape: title row, note row, header row, data rows.
const sheet = (header: string[], ...rows: Cell[][]): Cell[][] => [['Title'], ['Note'], header, ...rows];
const GQ_HEAD = ['QID', 'Old QID', 'Use', 'Class', 'Chapter (Class View)', 'Topic (Class View)', 'CloneBatchID', 'TypicalSetID', 'Locale', 'Question text',
  'Figure / table (describe)', 'Format', 'Options (separated by |)', 'Correct answer', 'Accepted equivalents', 'Concept 1', 'Inv 1', 'Concept 2', 'Inv 2',
  'Concept 3', 'Inv 3', 'Math difficulty (bare math)', 'IsPureFact', 'Reading (1–5)', 'Has_Irrelevant_Info', 'Steps (1–20)', 'MultiStep band',
  'WorkingMemory (1–5)', 'Inhibition (0–3)', 'Visual (0–3)', 'Strategy (0–3)', 'Strategy_type', 'Strategy_type_2', 'Strategy_other_note', 'Insight_ID',
  'Load', 'Load driver', 'Style', 'Tier', 'Expected duration (s)', 'Solution 1 (school method)', 'Solution 2', 'Solution 2 type', 'Solution 2 strategy',
  'Hint 1', 'Hint 2', 'Hint 3', 'Why (final reasoning)', 'Please re-check', 'Your verdict', 'Your notes'];
const gq = (o: Record<string, Cell>) => GQ_HEAD.map((h) => o[h] ?? null);
const base = { Use: 'Prompt example', Class: 6, 'Chapter (Class View)': 'MC16 Integers', 'Topic (Class View)': 'MT0455 Add integers', CloneBatchID: 'b1',
  TypicalSetID: 'TS-G6-INT-ADD', Locale: 'IN', 'Question text': '−7 + 3 = ?', Format: 'Typed', 'Correct answer': '-4', 'Accepted equivalents': '−4 | minus 4',
  'Concept 1': 'G6-INT-C2', 'Inv 1': 1, 'Math difficulty (bare math)': 'Simple', IsPureFact: 'No', 'Reading (1–5)': 1, Has_Irrelevant_Info: 'No',
  'Steps (1–20)': 1, 'MultiStep band': null, 'WorkingMemory (1–5)': 1, 'Inhibition (0–3)': 1, 'Visual (0–3)': 0, 'Strategy (0–3)': 0,
  'Expected duration (s)': 30, 'Solution 1 (school method)': 'Number line.', 'Hint 1': 'Use a number line.', 'Why (final reasoning)': 'Simple.', 'Your verdict': 'OK' };

function workbook(goldRows: Cell[][] = [gq({ QID: 'G6-001', ...base })]) {
  return new Map<string, Cell[][]>([
    ['Strategy Types', sheet(['#', 'Value', 'Example (Class 3–6)', 'Kid-friendly hint 1', 'Active'], [1, 'Pattern', 'x', 'h', 'Yes'], [14, 'Other', 'n', null, 'No'])],
    ['Insight Catalogue', sheet(['Insight_ID', 'Name', 'Strategy_type', 'Structure', 'Recognition test', 'Includes', 'Excludes', 'Parent line', 'Kid hint', 'Status'], ['INS-A', 'A', 'Pattern', 's', 'r', null, null, null, null, 'Active'])],
    ['Gold Concepts', sheet(['Concept_ID', 'Grade', 'Chapter', 'Topic', 'Name', 'Type', 'Builds_on', 'Misconceptions (ID: description)', 'Description', 'Includes', 'Excludes', 'Example question', 'Prerequisite topics', 'Prerequisite concepts (in gold set)', 'Curriculum tags'],
      ['G6-ARE-A1', 6, 'MC45 Area', 'MT0510 Paths', 'Paths', 'Applied', 'G5-MEN-C2 (Class 5, flagged), G6-FRC-C1', 'G6-M-ARE1: x', 'd', 'i', 'e', 'q', 'MT0289 Area (Class 5); MT0290 x', 'G4-ANG-C1', 'DAV 6; IXL 6'])],
    ['Misconceptions', sheet(['Misconception_ID', 'Concept_ID', 'Description', 'Parent description', 'Root prerequisite', 'Status'], ['G6-M-ARE1', 'G6-ARE-A1', 'd', 'p', null, 'Draft: review parent line'])],
    ['Typical Sets Catalogue', sheet(['TypicalSetID', 'Name', 'Instruction pattern', 'Class', 'Chapter', 'Topic', 'Concepts', 'Variant note', 'Parent-visible', 'Gold examples', 'Status'],
      ['TS-G6-A', 'A', 'Find', '6', 'MC45 Area', 'MT0510 Paths', 'G6-ARE-A1, G6-FRC-C1', 'v', 'Yes', null, 'Draft: review name'],
      ['TS-G5-NET', 'Net', 'Find', '5', 'MC58 Puzzles', 'Achievers (chapter level)', 'G5-PUZ-A1', 'v', 'No', null, 'Draft: review name'])],
    ['Question Attributes', sheet(['#', 'Attribute', 'Group', 'Meaning', 'Potential values', 'Used in', 'Needed by gap engine?'], [1, 'ID', 'Identity', 'm', 'v', 'u', 'Yes (MCQ only)'], [2, 'Notes', 'Workflow', 'm', 'v', 'u', 'No (report only)'])],
    ['Tagging Rubric', sheet(['Attribute', 'Definition', 'Levels and anchors (gold QIDs)', 'Rules', 'Edge cases', 'Calibration cases'], ['Reading (1–5)', 'd', 'l', 'r', 'e', 'CC-34, CC-35'])],
    ['Calibration Cases', sheet(['Case', 'QID', 'Attribute', 'First value', 'Final value', 'Why the first value was wrong', 'Rule it established'], ['CC-01', 'G5-001', 'Inhibition', '2', '1', 'w', 'r'])],
    ['Gold Wrong Answers', sheet(['QID', 'Wrong value', 'Tag type', 'Misconception_Ref', 'Target_Concept', 'Why'], ['G6-001', '-10', 'misconception', 'G6-M-INT2', null, 'adds'], ['G6-001', 4, 'unit_slip', null, null, 'sign'])],
    ['Gold Questions', [['Gold Questions'], ['Note'], ['Identity'], GQ_HEAD, ...goldRows]],
  ]);
}

describe('typedFormat [guess]', () => {
  it.each([['-4', 'Typed-number'], ['−4', 'Typed-number'], ['13,800', 'Typed-number'], ['4.4', 'Typed-decimal'], ['11/12', 'Typed-fraction'],
    ['2 3/4', 'Typed-fraction'], ['8:36 am', 'Typed-text'], ['12 and 18', 'Typed-text']])('%s → %s', (c, f) => expect(typedFormat(c)).toBe(f));
});

describe('parseSeed', () => {
  const s = parseSeed(workbook(), 'v10');

  it('catalogues: strategy types, insights, concepts, misconceptions', () => {
    expect(s.strategyTypes).toEqual([{ value: 'Pattern', example: 'x', hint_1: 'h', sort: 1, active: true }, { value: 'Other', example: 'n', hint_1: null, sort: 14, active: false }]);
    expect(s.insights[0]).toMatchObject({ insight_id: 'INS-A', status: 'active', strategy_type: 'Pattern' });
    expect(s.concepts[0]).toMatchObject({ concept_id: 'G6-ARE-A1', subject: 'math', class: 6, topic_id: 'MT0510', type: 'applied', status: 'draft', curriculum_tags: ['DAV 6', 'IXL 6'] });
    expect(s.misconceptions[0]).toMatchObject({ misconception_id: 'G6-M-ARE1', concept_id: 'G6-ARE-A1', status: 'draft' });
  });

  it('builds_on keeps the "flagged" marker per concept; prerequisites become links and topics', () => {
    expect(s.conceptLinks).toEqual([
      { from_concept: 'G6-ARE-A1', to_concept: 'G5-MEN-C2', kind: 'builds_on', flagged: true },
      { from_concept: 'G6-ARE-A1', to_concept: 'G6-FRC-C1', kind: 'builds_on', flagged: false },
      { from_concept: 'G6-ARE-A1', to_concept: 'G4-ANG-C1', kind: 'prerequisite', flagged: false },
    ]);
    expect(s.prereqTopics.map((p) => p.topic_id)).toEqual(['MT0289', 'MT0290']);
  });

  it('typical sets: first concept is main [guess]; "Achievers (chapter level)" → ACH row', () => {
    expect(s.setConcepts).toEqual([
      { typical_set_id: 'TS-G6-A', concept_id: 'G6-ARE-A1', role: 'main' }, { typical_set_id: 'TS-G6-A', concept_id: 'G6-FRC-C1', role: 'other' },
      { typical_set_id: 'TS-G5-NET', concept_id: 'G5-PUZ-A1', role: 'main' },
    ]);
    expect(s.typicalSets.map((t) => [t.typical_set_id, t.topic_id, t.class, t.parent_visible, t.status])).toEqual([
      ['TS-G6-A', 'MT0510', 6, true, 'draft'], ['TS-G5-NET', 'ACH-MC58-5', 5, false, 'draft']]);
  });

  it('rules', () => {
    expect(s.attributeDefs.map((a) => [a.attribute, a.needed_by_engine])).toEqual([['ID', true], ['Notes', false]]);
    expect(s.rubric[0]).toMatchObject({ rule_version: 'v10', calibration_case_ids: ['CC-34', 'CC-35'] });
    expect(s.calibration[0]).toMatchObject({ case_id: 'CC-01', question_id: 'G5-001', first_value: '2', final_value: '1' });
  });

  it('gold question → chapter-file question shape, with wrong answers and meta', () => {
    expect(s.problems).toEqual([]);
    const g = s.gold[0]!;
    expect(g).toMatchObject({ qid: 'G6-001', class: 6, chapter_id: 'MC16', subject: 'math',
      meta: { use: 'prompt_example', old_qid: null, final_reasoning: 'Simple.', review_verdict: 'OK', review_notes: null } });
    expect(g.question.answer).toEqual({ format: 'Typed-number', correct: '-4', accepted: ['−4', 'minus 4'],
      wrong_answers: [{ value: '-10', tag: 'misconception', misconception_id: 'G6-M-INT2', why: 'adds' }, { value: '4', tag: 'unit_slip', why: 'sign' }] });
    expect(g.question.signature).toEqual({ math_difficulty: 'Simple', is_pure_fact: false, reading: 1, has_irrelevant_info: false, steps: 1,
      working_memory: 1, inhibition: 1, visual: 0, strategy: 0 });
    expect(g.question.tagging).toEqual({ tagged_by: 'human' });
  });

  it('gold Achievers topic and True/False default options', () => {
    const s2 = parseSeed(workbook([gq({ ...base, QID: 'G5-009', Class: 5, 'Chapter (Class View)': 'MC58 Puzzles', 'Topic (Class View)': 'Achievers (chapter level)',
      Format: 'True/False', 'Correct answer': 'True' })]), 'v10');
    expect(s2.gold[0]!.question.topic_id).toBe('ACH-MC58-5');
    expect(s2.gold[0]!.question.answer.options).toEqual(['True', 'False']);
  });

  it('errors in plain words', () => {
    const s3 = parseSeed(workbook([gq({ ...base, QID: 'X-1' }), gq({ ...base, QID: 'G6-002', Use: 'Maybe' }),
      gq({ ...base, QID: 'G6-003', 'Solution 2': 'Faster.', 'Solution 2 type': null })]), 'v10');
    expect(s3.problems.map((p) => p.message)).toEqual(expect.arrayContaining([
      'QID "X-1" has the wrong form', 'G6-002: Use must be "Prompt example" or "Test only"', 'G6-003: Solution 2 has no valid type ("null")',
    ]));
  });
});

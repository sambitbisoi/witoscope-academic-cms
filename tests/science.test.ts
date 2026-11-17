// Science master parsing (13 Nov 2026). Synthetic cells only: no book text in the repo.
import { describe, expect, it } from 'vitest';
import {
  alsoInRows, classMismatch, classSet, davPages, extraRole, figureDescription, idList, legendBooks, ncertPages, notesFlags, pageList, questionLinks, resolveCitation, rowStatus, sheetStatus, sourceIdFor,
  sourcesFromLegend, storedFormat, taughtIn,
} from '../shared/science.ts';
import { nearCopyCover, scienceOverrides } from '../scripts/lib/science-import.ts';
import { corpusPlan, ocrFileFor, scienceRootFor } from '../scripts/lib/science-originality.ts';

const LEGEND = [
  { Section: 'Book short names', Name: 'NCERT C6 Ch4', Description: 'Curiosity – Ch 4 Exploring Magnets', File: 'NCERT/Class6_Curiosity/Class-6-Chapter-4.pdf', Class: 6, 'Offset (printed = PDF + offset)': 60, 'Printed pages': '61–78' },
  { Section: 'Book short names', Name: 'NCERT C6 Ch5', Description: 'Curiosity – Ch 5', File: 'NCERT/Class6_Curiosity/Class-6-Chapter-5.pdf', Class: 6, 'Offset (printed = PDF + offset)': 78, 'Printed pages': '79–100' },
  { Section: 'Book short names', Name: 'NCERT C5 Ch10', Description: 'OWW – Ch 10', File: 'NCERT/Class5_Our_Wondrous_World/Class-5-EVS-10.pdf', Class: 5, 'Offset (printed = PDF + offset)': 160, 'Printed pages': "161–176 (Seasons' Journal pp.177–182 and Notes pp.183–184 unnumbered)" },
  { Section: 'Book short names', Name: 'Mag', Description: 'DAV Class 6 – Magnets', File: 'DAV/Source/Class 6/Magnets.pdf', Class: 6, 'Offset (printed = PDF + offset)': 202, 'Printed pages': null },
  { Section: 'Book short names', Name: 'Env', Description: 'DAV Class 6 – Our Environment', File: 'DAV/Source/Class 6/class 06 Chapter 1-5.pdf', Class: 6, 'Offset (printed = PDF + offset)': 0, 'Printed pages': null },
  { Section: 'Book short names', Name: 'Food', Description: 'DAV Class 6 – Food', File: 'DAV/Source/Class 6/class 06 Chapter 1-5.pdf', Class: 6, 'Offset (printed = PDF + offset)': 0, 'Printed pages': null },
  { Section: 'Column meanings (content columns)', Name: 'Row ID', Description: 'Stable ID' },
];
const books = legendBooks(LEGEND);

describe('cells', () => {
  it('reads ID lists, Y/N and notes flags', () => {
    expect(idList('C6-04-001, C6-04-014;C6-04-001')).toEqual(['C6-04-001', 'C6-04-014']);
    expect(notesFlags('TIME-SENSITIVE: checked 2026; record can change. ACCURACY: the book says …')).toEqual({ time_sensitive: true, time_checked_year: 2026, accuracy_flag: true });
    expect(notesFlags('Also in C6: C6-11-023.')).toEqual({ time_sensitive: false, time_checked_year: null, accuracy_flag: false });
    expect(notesFlags(null).time_sensitive).toBe(false);
  });
  it('splits a question\'s rows into direct and supporting', () => {
    expect(questionLinks('C6-04-001, C6-04-014', 'C6-04-014')).toEqual([{ row_id: 'C6-04-014', role: 'direct' }, { row_id: 'C6-04-001', role: 'supporting' }]);
    expect(questionLinks('C6-04-002', 'C6-04-002')).toEqual([{ row_id: 'C6-04-002', role: 'direct' }]);
  });
  it('reads every page shape in the master', () => {
    expect(pageList('61–62, 78')).toEqual([{ from: 61, to: 62 }, { from: 78, to: 78 }]);
    expect(pageList('3-4')).toEqual([{ from: 3, to: 4 }]);
    expect(pageList(5)).toEqual([{ from: 5, to: 5 }]);
    expect(() => pageList('p. ten')).toThrow();
    expect(() => pageList('9–3')).toThrow(/backwards/);
    expect(davPages('Mag pp.205, 213')).toEqual([{ book: 'Mag', pages: [{ from: 205, to: 205 }, { from: 213, to: 213 }], raw: 'Mag pp.205, 213' }]);
    expect(davPages('Mag p.205, p.207').map((c) => c.pages)).toEqual([[{ from: 205, to: 205 }, { from: 207, to: 207 }]]);
    expect(davPages('Env p.3; Food p.17').map((c) => c.book)).toEqual(['Env', 'Food']);
    expect(davPages('Mag 205–206')[0]!.pages).toEqual([{ from: 205, to: 206 }]);
    expect(davPages('Mag pp.205-206')[0]!.pages).toEqual([{ from: 205, to: 206 }]);
    expect(ncertPages('61–62')).toEqual([{ book: 'NCERT', pages: [{ from: 61, to: 62 }], raw: 'NCERT p.61–62' }]);
    expect(ncertPages(null)).toEqual([]);
  });
  it('reads Taught in: plain, per row and Claude-added', () => {
    expect(taughtIn('NCERT p.61–62; DAV Mag p.203').map((c) => c.book)).toEqual(['NCERT', 'Mag']);
    const per = taughtIn('C6-04-001: NCERT p.61–62; DAV Mag p.203 | C6-04-014: Claude-added (extends NCERT p.64)');
    expect(per.map((c) => [c.book, c.for_row_id, c.claude_added ?? false])).toEqual([['NCERT', 'C6-04-001', false], ['Mag', 'C6-04-001', false], ['NCERT', 'C6-04-014', true]]);
    expect(() => taughtIn('IXL lesson 3')).toThrow();
  });
});

describe('class information (0033)', () => {
  it('parses "Also in" strictly: valid row IDs only, the rest reported', () => {
    expect(alsoInRows('Also in C6: C6-11-023, C6-11-024.')).toEqual({ ids: ['C6-11-023', 'C6-11-024'], bad: [], mentioned: true });
    expect(alsoInRows('Seen before. Also in C5: C5-02-004; TIME-SENSITIVE: checked 2026')).toEqual({ ids: ['C5-02-004'], bad: [], mentioned: true });
    expect(alsoInRows('Also in C6: C6-11-23, see chapter 9.')).toEqual({ ids: [], bad: ['C6-11-23', 'see', 'chapter', '9'], mentioned: true });
    expect(alsoInRows('Also in the class 6 book.')).toEqual({ ids: [], bad: [], mentioned: true });
    expect(alsoInRows('Also includes social well-being.').mentioned).toBe(false);
    expect(alsoInRows(null)).toEqual({ ids: [], bad: [], mentioned: false });
  });
  it('reads class cells and compares them with the approved classes', () => {
    expect(classSet('5–6')).toEqual([5, 6]);
    expect(classSet('3, 5–6')).toEqual([3, 5, 6]);
    expect(classSet('3–4, 6')).toEqual([3, 4, 6]);
    expect(classSet('4')).toEqual([4]);
    expect(classSet(null)).toBeNull();
    expect(classSet('Class 5')).toBeNull();
    expect(classMismatch('5–6', [6, 5])).toBeNull();
    expect(classMismatch('3, 5–6', [6])).toEqual({ onlyMaster: [3, 5] });
    expect(classMismatch('5', [6])).toEqual({ onlyMaster: [5] });
    expect(classMismatch('5', [4, 5, 6])).toBeNull();                 // extra CMS classes are not a mismatch
    expect(classMismatch('4, 6', [2, 4, 5, 6])).toBeNull();
    expect(classMismatch(null, [6])).toBeNull();
  });
});

describe('books and citations', () => {
  it('one source per PDF, offsets in the CMS sense (printed = pdf − offset)', () => {
    const s = sourcesFromLegend(books);
    expect(s.map((x) => x.source_id)).toEqual(['NCERT-class-6-chapter-4', 'NCERT-class-6-chapter-5', 'NCERT-class-5-evs-10', 'DAV-magnets', 'DAV-class-06-chapter-1-5']);
    expect(s.find((x) => x.source_id === 'DAV-class-06-chapter-1-5')!.shorts).toEqual(['Env', 'Food']);
    expect(s.find((x) => x.source_id === 'DAV-magnets')).toMatchObject({ publisher: 'DAV', kind: 'scanned_pdf', page_offset: -202 });
    expect(s.find((x) => x.source_id === 'NCERT-class-6-chapter-4')).toMatchObject({ publisher: 'NCERT', kind: 'pdf', page_offset: -60 });
    expect(sourceIdFor('DAV/Source/Class 5/Std 5 Science.pdf')).toBe('DAV-std-5-science');
  });
  it('NCERT pages find their chapter by printed page; unnumbered end pages count', () => {
    expect(resolveCitation({ book: 'NCERT', pages: [{ from: 79, to: 80 }], raw: 'NCERT p.79–80' }, 6, books)).toEqual([{ source_id: 'NCERT-class-6-chapter-5', page_from: 79, page_to: 80, raw: 'NCERT p.79–80' }]);
    expect(resolveCitation({ book: 'NCERT', pages: [{ from: 177, to: 177 }], raw: 'NCERT p.177' }, 5, books)[0]!.source_id).toBe('NCERT-class-5-evs-10');
    expect(() => resolveCitation({ book: 'NCERT', pages: [{ from: 300, to: 300 }], raw: 'x' }, 6, books)).toThrow(/no chapter/);
    expect(() => resolveCitation({ book: 'Zzz', pages: [{ from: 1, to: 1 }], raw: 'x' }, 6, books)).toThrow(/not in the Legend/);
    expect(resolveCitation({ book: 'Mag', pages: [{ from: 205, to: 205 }], raw: 'Mag p.205', for_row_id: 'C6-04-001' }, 6, books)[0]).toMatchObject({ source_id: 'DAV-magnets', for_row_id: 'C6-04-001' });
  });
  it('the DAV OCR file sits beside the scans on the Mac', () => {
    expect(ocrFileFor('/S', 'DAV/Source/Class 6/class 06 Chapter 1-5.pdf', 6)).toBe('/S/DAV_OCR/Class_6__class_06_Chapter_1-5.txt');
  });
});

describe('questions and status', () => {
  it('stored format: four options → MCQ-4, True/False → True/False', () => {
    expect(storedFormat('Scenario MCQ', ['a', 'b', 'c', 'd'])).toBe('MCQ-4');
    expect(storedFormat('True/False', ['True', 'False', null, null])).toBe('True/False');
    expect(() => storedFormat('Match', ['a', 'b', null, null])).toThrow();
  });
  it('figure description joins the question and option briefs', () => {
    expect(figureDescription('A magnet.', 'A: nail\nB: pin')).toBe('A magnet.\n\nOptions:\nA: nail\nB: pin');
    expect(figureDescription(null, null)).toBeNull();
  });
  it('row status: direct beats supporting beats not eligible beats none', () => {
    expect(rowStatus('OK', 1, 3)).toBe('direct');
    expect(rowStatus('Misconception only', 0, 1)).toBe('supporting');
    expect(rowStatus('No questions', 0, 0)).toBe('not_eligible');
    expect(rowStatus('OK', 0, 0)).toBe('none');
    expect(sheetStatus('Not eligible (Misconception only)')).toBe('not_eligible');
    expect(sheetStatus('Has questions (direct)')).toBe('direct');
  });
  it('extra-class role', () => { expect(extraRole(3, 6)).toBe('lower'); expect(extraRole(6, 5)).toBe('higher'); });
});

describe('near-copy overrides (Sambit, 13 Nov 2026)', () => {
  const near = { key: 'C5-01-072', result: 'near_copy' as const, similarity: 0.91, same_numbers: false, closest_ref: 'NCERT-class-5-evs-1 p16', field: 'content',
    fields: [{ field: 'content', result: 'near_copy' as const, similarity: 0.91, same_numbers: false, closest_ref: 'x' }, { field: 'notes', result: 'flagged' as const, similarity: 0.7, same_numbers: false, closest_ref: 'y' }] };
  it('held out unless the CSV lists that row AND field', () => {
    const { map } = scienceOverrides('file_key,field,reason\nC5-01-072,content,"a standard definition that cannot be reworded further"\nC5-01-011,notes,"not the near-copy field at all, though"\n');
    expect(nearCopyCover(near, map)).toMatchObject({ near: true, covered: true, fields: ['content'] });
    expect(nearCopyCover(near, new Map([['C5-01-072|notes', 'a reason long enough']]))).toMatchObject({ near: true, covered: false });
    expect(nearCopyCover({ ...near, result: 'flagged' }, map)).toMatchObject({ near: false });
  });
  it('a request needs a reason', () => {
    expect(scienceOverrides('file_key,field,reason\nC5-01-072,content,short\n').problems).toHaveLength(1);
  });
});

describe('scienceRootFor (15 Nov 2026: imports read a dated snapshot of the master)', () => {
  it('uses the master folder, or its parent for a copy in _snapshots/', () => {
    expect(scienceRootFor('/m/Science/WitoScope_Science_Master.xlsx')).toBe('/m/Science');
    expect(scienceRootFor('/m/Science/_snapshots/WitoScope_Science_Master_2026-11-15_import.xlsx')).toBe('/m/Science');
  });
});

describe('DAV Class 1–2 spread scans (15 Nov 2026)', () => {
  it('use the named OCR file and the whole book; other DAV sources keep the cited range', () => {
    expect(ocrFileFor('/S', 'DAV/Source/Class 1/My Living World Class 1.pdf', 1, 'DAV-my-living-world-class-1')).toBe('/S/DAV_OCR/Class_1__My_living_world_class_1_(evs).txt');
    expect(ocrFileFor('/S', 'DAV/Source/Class 6/Magnets.pdf', 6, 'DAV-magnets')).toBe('/S/DAV_OCR/Class_6__Magnets.txt');
    const sources = [
      { source_id: 'DAV-my-living-world-class-1', publisher: 'DAV', page_offset: 2 },
      { source_id: 'DAV-magnets', publisher: 'DAV', page_offset: 1 },
    ] as never[];
    const rows = [{ citations: [{ source_id: 'DAV-my-living-world-class-1', page_from: 58, page_to: 58 }, { source_id: 'DAV-magnets', page_from: 10, page_to: 11 }] }] as never[];
    const plan = corpusPlan(rows, sources);
    expect(plan.get('DAV-my-living-world-class-1')).toBe('all');
    expect(plan.get('DAV-magnets')).toEqual({ from: 8, to: 15 });
  });
});

// Q34 (Round 2): optional question columns
import { familiarity as _fam, goldUse as _gold, optionTag as _tag, scienceType as _type } from '../shared/science.ts';
describe('Q34 column parsers', () => {
  it('Science question type, familiarity, gold Use', () => {
    expect(['2', '2 · Basic understanding', '5 Super Achiever', '', '6', 'two'].map(_type)).toEqual([2, 2, 5, null, NaN, NaN]);
    expect(['everyday', 'Less familiar', '', 'Odd'].map(_fam)).toEqual(['Everyday', 'Less familiar', null, undefined]);
    expect(['Prompt example', 'test only', 'Test_only', '', 'gold'].map(_gold)).toEqual(['prompt_example', 'test_only', 'test_only', null, undefined]);
  });
  it('wrong-option tags', () => {
    expect(_tag('shortcut')).toEqual({ tag: 'shortcut', ref: null });
    expect(_tag('misconception C6-04-014 #2')).toEqual({ tag: 'misconception', ref: 'C6-04-014 #2' });
    expect(_tag('concept_error: C6-04-002')).toEqual({ tag: 'concept_error', ref: 'C6-04-002' });
    expect(_tag('')).toBeNull();
    expect(_tag('guess')!.tag).toBe('');
  });
});

// Q35 (17 Nov 2026): the 5 drivers as optional columns, same rules as Edit
import { scienceDrivers as _drv } from '../shared/science.ts';
describe('Q35 driver columns', () => {
  it('reads valid values; blank stays blank', () => {
    expect(_drv({ Reading: 2, Steps: '4', Inhibition: 0, Visual: '3', 'Irrelevant info (Y/N)': 'Y' })).toEqual({
      values: { reading: 2, steps: 4, inhibition: 0, visual: 3, has_irrelevant_info: true }, problems: [], present: true });
    expect(_drv({ Reading: '', Steps: null, 'Irrelevant info (Y/N)': 'no' })).toEqual({ values: { has_irrelevant_info: false }, problems: [], present: true });
    expect(_drv({ Question: 'x' })).toEqual({ values: {}, problems: [], present: false });
  });
  it('accepts a header with its range', () => {
    expect(_drv({ 'Reading (1–5)': 5, 'Steps (1–20)': 20, 'Inhibition (0–3)': 3, 'Visual (0–3)': 0 }).values).toEqual({ reading: 5, steps: 20, inhibition: 3, visual: 0 });
  });
  it('lists every bad value (the row is held)', () => {
    const r = _drv({ Reading: 0, Steps: 21, Inhibition: '1.5', Visual: 'two', 'Irrelevant info (Y/N)': 'maybe' });
    expect(r.values).toEqual({});
    expect(r.problems).toEqual(['Reading "0" is not a whole number from 1 to 5', 'Steps "21" is not a whole number from 1 to 20',
      'Inhibition "1.5" is not a whole number from 0 to 3', 'Visual "two" is not a whole number from 0 to 3', 'Irrelevant info "maybe" is not Y or N']);
    expect(_drv({ Reading: 6 }).problems).toHaveLength(1);
    expect(_drv({ Visual: -1 }).problems).toHaveLength(1);
  });
});

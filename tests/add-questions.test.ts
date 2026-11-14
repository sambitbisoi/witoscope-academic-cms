// Add / bulk-upload questions (13 Nov 2026): mandatory-field checks, Excel row parsing, flag filters.
import { describe, expect, it } from 'vitest';
import { contentRowLinks, mandatoryErrors, matchesFlag, parseUploadRow, UPLOAD_COLUMNS, uploadColumns, type UploadLookups } from '../web/src/logic.ts';

const look: UploadLookups = { concepts: new Set(['G6-FRC-C1']), sets: new Set(['TS-A', 'TS-B']), patterns: new Map([['P-A1', 'TS-A']]), settings: new Set(['SET01']), sourceItems: new Set(['N6-01-004']) };
const base = { text: 'Which is largest?', format: 'MCQ-4', a: '12', b: '21', c: '102', d: '120', correct: '120', level: 6, picture: 'N' };

describe('mandatory fields only', () => {
  it('a complete MCQ row has no errors', () => expect(parseUploadRow(2, base, look).errors).toEqual([]));
  it('names each missing mandatory field', () => {
    const r = parseUploadRow(3, { format: 'MCQ-4', a: '1', b: '2', picture: '' }, look);
    expect(r.errors).toEqual(expect.arrayContaining(['question text is missing', 'correct answer is missing', 'MCQ-4 needs 4 options (has 2)', 'level must be 1–6', '"Picture needed" must be Y or N']));
  });
  it('picture needed → figure description required', () => {
    expect(parseUploadRow(4, { ...base, picture: 'Y' }, look).errors).toEqual(['a picture is needed, so the figure description is required']);
    expect(parseUploadRow(4, { ...base, picture: 'yes', figure: 'four cards' }, look).errors).toEqual([]);
  });
  it('format must be on the allowed list (no Multi-part)', () => {
    expect(parseUploadRow(5, { ...base, format: 'Multi-part' }, look).errors[0]).toMatch(/not allowed/);
    expect(mandatoryErrors({ text: 't', format: 'Typed-number', options: [], correct: '5', level: 3, picture_needed: false })).toEqual([]);
  });
  it('a level that is not 1–6 is one error', () => expect(parseUploadRow(6, { ...base, level: 'seven' }, look).errors).toEqual(['level "seven" is not 1–6']));
});

describe('row parsing', () => {
  it('True/False fills its own options; answers t / F are normalised', () => {
    const r = parseUploadRow(2, { text: '0 is even.', format: 'true/false', correct: 't', level: 6, picture: 'N' }, look);
    expect(r.q).toMatchObject({ format: 'True/False', options: ['True', 'False'], correct: 'True' });
    expect(r.errors).toEqual([]);
  });
  it('an MCQ answer given as a letter becomes that option', () => expect(parseUploadRow(2, { ...base, correct: 'c' }, look).q!.correct).toBe('102'));
  it('the correct answer must be one of the options', () => expect(parseUploadRow(2, { ...base, correct: '7' }, look).errors).toEqual(['the correct answer must be one of the options']));
  it('unknown optional IDs are left out with a warning, never an error', () => {
    const r = parseUploadRow(2, { ...base, concepts: 'G6-FRC-C1, X-1', set: 'TS-B', pattern: 'P-A1', setting: 'NOPE', difficulty: 'hard' }, look);
    expect(r.errors).toEqual([]);
    expect(r.q).toMatchObject({ concepts: ['G6-FRC-C1'], typical_set_id: 'TS-B', pattern_id: undefined, setting_id: undefined, math_difficulty: undefined });
    expect(r.warnings).toEqual(['concept X-1 is not known here; left out', 'pattern P-A1 belongs to another typical set; left out', 'setting NOPE is not known here; left out', 'difficulty guess "hard" is not Simple, Medium or Complex; left out']);
  });
  it('a known book item becomes a source ref; any other citation goes into the notes', () => {
    expect(parseUploadRow(2, { ...base, source: 'N6-01-004' }, look).q).toMatchObject({ source_refs: ['N6-01-004'] });
    expect(parseUploadRow(2, { ...base, source: 'DAV 6 · ch 3 · p 41 · Q7', notes: 'check' }, look).q).toMatchObject({ source_refs: [], author_notes: 'check\nSource: DAV 6 · ch 3 · p 41 · Q7' });
  });
  it('wrong-answer notes split into value and why', () => {
    expect(parseUploadRow(2, { ...base, wrong: '102: last digit only; 12' }, look).q!.wrong_answers).toEqual([{ value: '102', why: 'last digit only' }, { value: '12', why: '' }]);
  });
  it('the example row is left out', () => expect(parseUploadRow(2, { ...base, notes: 'EXAMPLE — delete this row' }, look)).toMatchObject({ q: null, example: true }));
  it('the template has no topic column and marks the mandatory ones', () => {
    expect(UPLOAD_COLUMNS.some((c) => /topic/i.test(c.header))).toBe(false);
    expect(UPLOAD_COLUMNS.filter((c) => c.required).map((c) => c.header)).toEqual(['Question text', 'Format', 'Correct answer', 'Level', 'Picture needed (Y/N)']);
  });
});

describe('flag filters', () => {
  const q = { created_from: 'upload', attributes_pending: true, originality_pending: false, image_pending: true };
  it('filters on origin and each pending flag', () => {
    expect(['all', 'manual', 'upload', 'attributes', 'image', 'originality'].filter((f) => matchesFlag(f as never, q))).toEqual(['all', 'upload', 'attributes', 'image']);
  });
});

describe('Science content-row columns (13 Nov 2026)', () => {
  const sci: UploadLookups = { ...look, contentRows: new Set(['C6-04-001', 'C6-04-014']) };
  it('direct and supporting IDs become links; a row in both is direct; unknown IDs are left out with a warning', () => {
    const r = parseUploadRow(2, { ...base, rows_direct: 'C6-04-001', rows_supporting: 'c6-04-014, C6-04-001; C6-99-999' }, sci);
    expect(r.q!.content_rows).toEqual([{ row_id: 'C6-04-001', role: 'direct' }, { row_id: 'C6-04-014', role: 'supporting' }]);
    expect(r.warnings).toEqual(['content row C6-99-999 is not known; left out']);
    expect(r.errors).toEqual([]);
  });
  it('the template has the content-row columns for Science only', () => {
    expect(uploadColumns(true).map((c) => c.key)).toEqual(expect.arrayContaining(['rows_direct', 'rows_supporting']));
    expect(uploadColumns(false).some((c) => c.key.startsWith('rows_'))).toBe(false);
    expect(contentRowLinks('', '')).toEqual([]);
  });
});

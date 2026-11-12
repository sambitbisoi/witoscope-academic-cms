// The local originality check (shared/originality.ts): pure, no database, no book files.
import { describe, expect, it } from 'vitest';
import { checkQuestion, checkText, containsAll, corpus, distinctive, inOrder, questionFields, windows } from '../shared/originality.ts';

const page = (text: string, pdf_page = 5) => ({ source_id: 'NCERT-fegp101', pdf_page, text });
const BOOK = page([
  'Figure it out',
  '1. Can you find a pattern in the sequence 1, 3, 6, 10, 15?',
  'What are the next three numbers?',
  '2. Draw the next shape in the triangle pattern.',
].join('\n'));

describe('originality check (local only)', () => {
  it('cuts a page into pieces of 1–6 lines, cited by source and PDF page', () => {
    const w = windows(BOOK);
    expect(w.length).toBe(4 + 3 + 2 + 1);
    expect(w.every((x) => x.cite === 'NCERT-fegp101 p5')).toBe(true);
    expect(w[1]!.numbers).toEqual(['1', '1', '10', '15', '3', '6']);
  });

  it('near-copy (blocks the import): copied wording, or the same numbers in the same order', () => {
    const c = corpus([BOOK], []);
    const copied = checkText('Can you find a pattern in the sequence 1, 3, 6, 10, 15? What are the next three numbers?', c, 0.6, 0.85);
    expect(copied).toEqual({ result: 'near_copy', similarity: expect.any(Number), same_numbers: true, closest_ref: 'NCERT-fegp101 p5' });
    expect(copied.similarity!).toBeGreaterThan(0.85);
    // new wording, the book's number sequence in the book's order: still a near-copy
    const pattern = checkText('Riya writes 1, 3, 6, 10, 15 on a board. Which number comes next?', c, 0.6, 0.85);
    expect(pattern).toMatchObject({ result: 'near_copy', same_numbers: true, closest_ref: 'NCERT-fegp101 p5' });
    expect(pattern.similarity!).toBeLessThan(0.6);
    expect(JSON.stringify(pattern)).not.toContain('Figure it out');
  });

  it('a warning (flagged) for moderate similarity, or the same numbers in another order', () => {
    const c = corpus([BOOK], []);
    const reordered = checkText('Riya writes 15, 10, 6, 3 and 1 on a board. Which is the largest?', c, 0.6, 0.85);
    expect(reordered).toMatchObject({ result: 'flagged', same_numbers: true, closest_ref: 'NCERT-fegp101 p5' });
    const moderate = checkText('Can you find a pattern in the sequence of shapes? What are the next three shapes?', c, 0.6, 0.85);
    expect(moderate.similarity!).toBeGreaterThanOrEqual(0.6);
    expect(moderate.similarity!).toBeLessThan(0.85);
    expect(moderate).toMatchObject({ result: 'flagged', same_numbers: false });
    expect(inOrder(['1', '3', '6', '10'], ['3', '10'])).toBe(true);
    expect(inOrder(['1', '3', '6', '10'], ['10', '3'])).toBe(false);
  });

  it('our own question is clear; small numbers alone are not distinctive', () => {
    const c = corpus([BOOK], []);
    expect(checkText('Aman has 4 pencils and buys 7 more packs of 12. How many pencils now?', c, 0.6).result).toBe('clear');
    expect(distinctive(['1', '2', '3'])).toBe(false);
    expect(distinctive(['1', '3', '10'])).toBe(true);
    expect(containsAll(['1', '1', '3'], ['1', '1'])).toBe(true);
    expect(containsAll(['1', '3'], ['1', '1'])).toBe(false);
  });

  it('local book-file items are compared too and cited by ref_id; nothing to compare → no_sources', () => {
    const c = corpus([], [{ ref_id: 'N6-01-004', text: 'Rewrite each sequence of odd numbers starting at 21, 23, 25.' }]);
    expect(checkText('Rewrite each sequence of odd numbers starting at 21, 23, 25.', c, 0.6)).toMatchObject({ result: 'near_copy', closest_ref: 'N6-01-004' });
    expect(checkText('anything', corpus([], []), 0.6)).toEqual({ result: 'no_sources', similarity: null, same_numbers: false, closest_ref: null });
  });
});

describe('every text field (12 Nov 2026)', () => {
  const book = corpus([], [{ ref_id: 'N5-09-012', text: 'The needle of the weighing scale points between the two marks after six hundred grams' }]);
  const base = { text: 'How heavy is the bag of rice?', answer: { format: 'MCQ-4' as const, correct: '700 g', options: ['700 g', '600 g', '7 kg', '70 g'], wrong_answers: [{ value: '600 g', tag: 'misread' as const, why: 'Read the mark before the needle.' }] },
    solutions: { school: 'Count the small steps after 600 g.' }, hints: ['Look at the needle.'] };
  it('a figure description copied from a book is caught even when the text is clean (the MC39 gap)', () => {
    const q = { ...base, figure: { description: 'The needle of the weighing scale points between the two marks after six hundred grams', image_status: 'has_image' as const } };
    const r = checkQuestion(q, book, 0.6, 0.85);
    expect([r.result, r.field, r.closest_ref]).toEqual(['near_copy', 'figure description', 'N5-09-012']);
    expect(checkText(q.text, book, 0.6, 0.85).result).toBe('clear'); // the old check missed it
  });
  it('lists every field, labelled; the question text keeps the old reading (text + parts)', () => {
    expect(questionFields({ ...base, parts: [{ part_label: 'a', text: 'Part a?', answer: { format: 'Typed-number', correct: '3' }, concepts: [] }] }).map((f) => f.field))
      .toEqual(['text', 'options', 'wrong-answer note 1', 'solution', 'hint 1']);
  });
  it('the numbers rule applies to the text, figure description and options only (option a); hints get the wording test only', () => {
    const nums = corpus([], [{ ref_id: 'N5-01-001', text: 'Add 23, 45 and 67 together.' }]);
    const hint = checkQuestion({ ...base, hints: ['23, 45, 67'] }, nums, 0.6, 0.85);
    expect(hint.fields).toEqual([]);
    const opts = checkQuestion({ ...base, answer: { ...base.answer, options: ['23', '45', '67'] } }, nums, 0.6, 0.85);
    expect([opts.result, opts.field, opts.same_numbers]).toEqual(['near_copy', 'options', true]);
    const short = checkQuestion({ ...base, hints: ['Look at the needle.'] }, corpus([], [{ ref_id: 'X', text: 'Look at the needle.' }]), 0.6, 0.85);
    expect(short.fields.map((f) => f.field)).toEqual([]); // 4 words: no wording test
  });
});

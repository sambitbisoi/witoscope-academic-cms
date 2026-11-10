// The local originality check (shared/originality.ts): pure, no database, no book files.
import { describe, expect, it } from 'vitest';
import { checkText, containsAll, corpus, distinctive, inOrder, windows } from '../shared/originality.ts';

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

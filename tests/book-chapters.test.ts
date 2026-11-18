// import:book-chapters normaliser (Q13): one row per book chapter; several DAV chapters per cell; "(part)" dropped.
import { describe, expect, it } from 'vitest';
import { normaliseBookChapters } from '../scripts/lib/book-chapters.ts';
import type { Row } from '../scripts/lib/xlsx.ts';

const row = (n: number, v: Record<string, string | number | null>): Row => ({ row: n, values: v });
describe('normaliseBookChapters', () => {
  it('splits multi-line DAV cells, drops (part), merges repeats, skips the Read Me and books with no chapter', () => {
    const sheets = new Map<string, Row[]>([
      ['Read Me', [row(2, { Class: 'x' })]],
      ['Math C5', [
        row(2, { Class: 5, 'NCERT book': 'Maths Mela', 'NCERT ch no': 1, 'NCERT chapter name': 'Ch One', 'DAV book': 'DAV CMC Mathematics', 'DAV ch no': '1\n9', 'DAV chapter name': 'Big Numbers\nRounding' }),
        row(3, { Class: 5, 'NCERT book': 'Maths Mela', 'NCERT ch no': 2, 'NCERT chapter name': 'Ch Two', 'DAV book': 'DAV CMC Mathematics', 'DAV ch no': '2 (part)', 'DAV chapter name': 'Operations (part)' }),
        row(4, { Class: 5, 'NCERT book': 'Maths Mela', 'NCERT ch no': 3, 'NCERT chapter name': 'Ch Three', 'DAV book': 'DAV CMC Mathematics', 'DAV ch no': '2 (part)', 'DAV chapter name': 'Operations (part)' })]],
      ['Science C1', [row(2, { Class: 1, 'NCERT book': '— none', 'NCERT ch no': null, 'DAV book': 'My Living World (DAV CMC)', 'DAV ch no': '1', 'DAV chapter name': 'About me' })]],
    ]);
    const r = normaliseBookChapters(sheets);
    expect(r.problems).toEqual([]);
    expect(r.chapters.map((c) => `${c.subject} C${c.class} ${c.book} ${c.ch_no} ${c.ch_name}`)).toEqual([
      'math C5 DAV 1 Big Numbers', 'math C5 DAV 2 Operations', 'math C5 DAV 9 Rounding',
      'math C5 NCERT 1 Ch One', 'math C5 NCERT 2 Ch Two', 'math C5 NCERT 3 Ch Three', 'science C1 DAV 1 About me']);
  });
  it('problems: a mismatched DAV cell, a non-number, a wrong class', () => {
    const r = normaliseBookChapters(new Map([['Math C2', [
      row(2, { Class: 2, 'DAV book': 'D', 'DAV ch no': '1\n2', 'DAV chapter name': 'Only one' }),
      row(3, { Class: 2, 'NCERT book': 'N', 'NCERT ch no': 'A', 'NCERT chapter name': 'x' }),
      row(4, { Class: 3, 'NCERT book': 'N', 'NCERT ch no': 1, 'NCERT chapter name': 'x' })]]]));
    expect(r.problems).toHaveLength(3);
    expect(r.chapters).toEqual([]);
  });
});

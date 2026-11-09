import { describe, expect, it } from 'vitest';
import { parseBook } from '../scripts/lib/book.ts';
import { ncertSourceId, parseNcertSheet } from '../scripts/lib/sources.ts';
import type { Row } from '../scripts/lib/xlsx.ts';

const rows = (...r: Record<string, string | number>[]): Row[] => r.map((values, i) => ({ row: i + 2, values }));
const topics = new Map([['MT0087', 'MC27'], ['MT0090', 'MC27'], ['MT0001', 'MC01'], ['MT0393', 'MC19']]);

describe('NCERT source registry', () => {
  it('source ID = NCERT + PDF file stem', () => {
    expect(ncertSourceId('https://ncert.nic.in/textbook/pdf/fegp101.pdf')).toBe('NCERT-fegp101');
    expect(ncertSourceId('https://ncert.nic.in/textbook/pdf/AEJM1PS.PDF')).toBe('NCERT-aejm1ps');
    expect(ncertSourceId('https://ncert.nic.in/textbook/')).toBeNull();
  });

  it('one source per PDF, linked to the CMS chapters of its mapped topics', () => {
    const p = parseNcertSheet('math', rows(
      { Grade: 6, 'NCERT Book': 'Ganita Prakash', 'Chapter No': 1, 'Chapter (NCERT title)': 'Patterns in Mathematics', 'Source PDF': 'https://ncert.nic.in/textbook/pdf/fegp101.pdf', 'Master Topic ID(s)': 'MT0087, MT0090' },
      { Grade: 6, 'NCERT Book': 'Ganita Prakash', 'Chapter No': 1, 'Chapter (NCERT title)': 'Patterns in Mathematics', 'Source PDF': 'https://ncert.nic.in/textbook/pdf/fegp101.pdf', 'Master Topic ID(s)': 'MT0001' },
      { Grade: 6, 'NCERT Book': 'Ganita Prakash', 'Chapter No': 7, 'Chapter (NCERT title)': 'Fractions', 'Source PDF': 'https://ncert.nic.in/textbook/pdf/fegp107.pdf', 'Master Topic ID(s)': 'MT0393; MT9999' },
    ), topics);
    expect(p.sources).toEqual([
      { source_id: 'NCERT-fegp101', kind: 'pdf', title: 'NCERT Ganita Prakash, Class 6 · Ch 1 Patterns in Mathematics', publisher: 'NCERT', class: 6, url: 'https://ncert.nic.in/textbook/pdf/fegp101.pdf' },
      { source_id: 'NCERT-fegp107', kind: 'pdf', title: 'NCERT Ganita Prakash, Class 6 · Ch 7 Fractions', publisher: 'NCERT', class: 6, url: 'https://ncert.nic.in/textbook/pdf/fegp107.pdf' },
    ]);
    expect(p.links).toEqual([{ source_id: 'NCERT-fegp101', chapter_id: 'MC01' }, { source_id: 'NCERT-fegp101', chapter_id: 'MC27' }, { source_id: 'NCERT-fegp107', chapter_id: 'MC19' }]);
    expect(p.problems.map((x) => x.message)).toEqual(['topic MT9999 is not in the CMS; not linked']);
  });

  it('English lessons sharing one PDF: "(+n more)" and the Lesson column', () => {
    const p = parseNcertSheet('grammar', rows(
      { Grade: 1, 'NCERT Book': 'Mridang', 'Chapter/Unit No': 2, Lesson: 'Lesson B', 'Source PDF': 'https://x/aemr102.pdf', 'Master Topic ID(s)': '' },
      { Grade: 1, 'NCERT Book': 'Mridang', 'Chapter/Unit No': 1, Lesson: 'Lesson A', 'Source PDF': 'https://x/aemr102.pdf', 'Master Topic ID(s)': '' },
    ), topics);
    expect(p.sources[0]!.title).toBe('NCERT Mridang, Class 1 · Ch 1 Lesson A (+1 more)');
    expect(p.problems.map((x) => x.message)).toEqual(['no mapped topic is in the CMS; the source is registered but linked to no chapter']);
  });
});

const book = () => ({
  file_schema: 'cms-book-chapter/0.1', attribute_version: 'v11', subject: 'math', internal_only: true,
  source: { publisher: 'NCERT', book_title: 'Ganita Prakash', book_class: 6, kind: 'pdf', file_path: '~/WitoScope/ContentResearch/Math/NCERT/Class6_Ganita_Prakash/fegp101.pdf', page_offset: 2 },
  chapter: { chapter_no: 1, chapter_name: 'Patterns in Mathematics', page_from: 1, page_to: 12, answer_key_pdf_pages: '13–17',
    sections: [{ section_no: '1.1', title: 'What is Mathematics?', page: 1 }, { section_no: '1.2', title: 'Patterns in Numbers', page: 2 }] },
  items: [
    { ref_id: 'N6-01-004', page: 3, text: 'Rewrite each sequence…', numbers: ['1'], assessable: true, placement: { chapter_id: 'MC27', topic_id: 'MT0090' },
      tags: { pattern_id: 'MP0037', signature: { math_difficulty: 'Simple' } } },
    { ref_id: 'N6-01-001', page: 2, text: 'Can you think of…', assessable: false, placement: { chapter_id: 'MC27', topic_id: 'MT0087' } },
    { ref_id: 'N6-01-050', page: 9, text: 'Unknown topic', placement: { chapter_id: 'MC99', topic_id: 'MT9999' } },
  ],
});

describe('book-chapter files (D3)', () => {
  it('source, PDF-page links and jumps (printed page + offset), items without v11 tags', () => {
    const p = parseBook(book(), topics);
    expect(p.source).toMatchObject({ source_id: 'NCERT-fegp101', page_offset: 2, class: 6 });
    expect(p.links).toEqual([{ source_id: 'NCERT-fegp101', chapter_id: 'MC27', page_from: 3, page_to: 14 }, { source_id: 'NCERT-fegp101', chapter_id: 'MC99', page_from: 3, page_to: 14 }]);
    expect(p.jumps!.filter((j) => j.chapter_id === 'MC27')).toEqual([
      { source_id: 'NCERT-fegp101', chapter_id: 'MC27', label: '1.1 What is Mathematics?', pdf_page: 3 },
      { source_id: 'NCERT-fegp101', chapter_id: 'MC27', label: '1.2 Patterns in Numbers', pdf_page: 4 },
      { source_id: 'NCERT-fegp101', chapter_id: 'MC27', label: 'Answers', pdf_page: 13 },
    ]);
    expect(p.items![0]).toEqual({ ref_id: 'N6-01-004', source_id: 'NCERT-fegp101', page: 3, item_text: 'Rewrite each sequence…', topic_id: 'MT0090', pattern_id: null, numbers: ['1'] });
    expect(p.items![2]).toMatchObject({ ref_id: 'N6-01-050', topic_id: null });
    expect(p.problems.map((x) => x.message)).toEqual(expect.arrayContaining([
      'attribute_version v11: item tags are not imported (D3); only source and item rows',
      'topic MT9999 is not in the CMS; item kept without a topic',
    ]));
  });

  it('refuses files that are not marked internal, have the wrong schema, or repeat a ref_id', () => {
    expect(parseBook({ ...book(), internal_only: false }, topics).problems.map((x) => x.message)).toContain('internal_only must be true: book text never leaves the CMS');
    expect(parseBook({ ...book(), file_schema: 'x' }, topics).problems[0]!.message).toBe('file_schema must be cms-book-chapter/0.1 or cms-book-chapter/0.2, got "x"');
    const v2 = { ...book(), file_schema: 'cms-book-chapter/0.2' }; (v2.items[0] as Record<string, unknown>).snapshot_image = 'images/N6-01-004.png';
    expect(parseBook(v2, topics).problems.filter((x) => x.level === 'error')).toEqual([]);
    expect(parseBook(v2, topics).problems.map((x) => x.message)).toContain('1 item snapshot image not imported yet (they need the admin\'s Storage upload; follow-up)');
    const dup = book(); dup.items.push({ ...dup.items[0]! });
    expect(parseBook(dup, topics).problems.map((x) => x.message)).toContain('ref_id appears twice');
  });
});

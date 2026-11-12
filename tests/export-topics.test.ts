// D5 Export to Excel: same sheets and column order as the workbooks, plus the new columns.
import { describe, expect, it } from 'vitest';
import { buildSheets } from '../scripts/lib/export-topics.ts';

const strands = [{ strand_id: 'math-NUM', code: 'NUM', name: 'Numbers', sort: 1 }];
const chapters = [{ chapter_id: 'MC01', strand_id: 'math-NUM', name: 'Counting', display_code: 'NUM-01', scope: 'counting', sort: 1, status: 'active' }];
const topic = (o: Partial<Parameters<typeof buildSheets>[3][number]>) => ({ topic_id: 'MT0001', chapter_id: 'MC01', class: 2, seq: 1, name: 'Count to 20', level: 1, sub_skills: 'a; b',
  topic_kind: 'normal', source_flags: { ncert: '2', dav: '–', ixl: '1–2', imo: '–' }, notes: null, status: 'active', classes: [2, 3], prereqs: ['MT0000'], questions: 4, ...o });

describe('buildSheets', () => {
  const sheets = buildSheets('math', strands, chapters, [topic({}), topic({ topic_id: 'MT0002', status: 'retired', classes: [2] }), topic({ topic_id: 'ACH-MC01-2', topic_kind: 'achievers', name: 'Achievers' })], '2026-11-12T00:00:00Z');
  const by = (n: string) => sheets.find((s) => s.name === n)!;
  it('has the workbook sheets in order, plus Read me and Achievers', () => {
    expect(sheets.map((s) => s.name)).toEqual(['Read me', 'Master Chapters', 'Master Topics', 'Class View', 'Achievers']);
  });
  it('keeps the workbook column order and adds the new columns at the end', () => {
    expect(by('Class View').columns.slice(0, 10)).toEqual(['Class', 'Seq', 'Strand', 'Chapter ID', 'Chapter', 'Topic ID', 'Topic', 'Level', 'Sub-skills', "Also taught in (other sources' classes)"]);
    expect(by('Class View').columns.slice(10)).toEqual(['Classes (all)', 'Prerequisites', 'Questions']);
    expect(by('Master Topics').rows[0]).toEqual(['MT0001', 'MC01', 'Numbers', 'Counting', 'Count to 20', 'a; b', 1, '2', '–', '1–2', '–', null, 2, '2, 3', 'MT0000', 'active', 4]);
  });
  it('Class View lists active topics only; Master Topics keeps retired ones with their status; chapters count active topics', () => {
    expect(by('Class View').rows.map((r) => r[5])).toEqual(['MT0001']);
    expect(by('Class View').rows[0]![9]).toBe('NCERT 2 · IXL 1–2');
    expect(by('Master Topics').rows.map((r) => [r[0], r[15]])).toEqual([['MT0001', 'active'], ['MT0002', 'retired']]);
    expect(by('Master Chapters').rows[0]).toEqual(['MC01', 'NUM', 'Numbers', 'NUM-01', 'Counting', 'counting', 1, 'active']);
    expect(by('Achievers').rows[0]![0]).toBe('ACH-MC01-2');
  });
});

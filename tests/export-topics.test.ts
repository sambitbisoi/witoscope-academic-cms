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

describe('source-mapping tabs in the export', () => {
  it('written in workbook order with their columns; book-text columns never written', async () => {
    const { mappingSheets } = await import('../scripts/lib/export-topics.ts');
    const s = mappingSheets([
      { sheet: 'DAV', row_no: 3, cells: [['S.No', 2], ['Grade', 1], ['Master Topic ID(s)', 'MT0002']] },
      { sheet: 'NCERT (CBSE)', row_no: 2, cells: [['S.No', 1], ['Grade', 1], ['Topic', 'Positional words'], ['Evidence (from chapter text)', 'X'], ['Master Topic ID(s)', 'MT0092']] },
      { sheet: 'DAV', row_no: 2, cells: [['S.No', 1], ['Grade', 1], ['Master Topic ID(s)', 'MT0001']] },
    ]);
    expect(s.map((x) => x.name)).toEqual(['NCERT (CBSE)', 'DAV']);
    expect(s[0]!.columns).toEqual(['S.No', 'Grade', 'Topic', 'Master Topic ID(s)']);
    expect(s[1]!.rows).toEqual([[1, 1, 'MT0001'], [2, 1, 'MT0002']]);
  });
});

describe('per-subject source columns', () => {
  it('Science has NCERT, DAV, ISO; English IXL, NCERT, DAV', () => {
    const cols = (s: 'science' | 'grammar') => buildSheets(s, strands, chapters, [], 'x').find((x) => x.name === 'Master Topics')!.columns.filter((c) => c.startsWith('Classes – '));
    expect(cols('science')).toEqual(['Classes – NCERT', 'Classes – DAV', 'Classes – ISO']);
    expect(cols('grammar')).toEqual(['Classes – IXL', 'Classes – NCERT', 'Classes – DAV']);
  });
});

describe('publish (after the cut-over)', () => {
  it('archives each original once, then puts the export in place read-only', async () => {
    const { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'cms-publish-'));
    const out = join(home, 'out'); mkdirSync(out);
    for (const d of ['Math', 'Science', 'English']) mkdirSync(join(home, 'WitoScope', 'ContentResearch', d), { recursive: true });
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => home }));
    const mod = await import('../scripts/export-topics.ts');
    for (const [s, f] of Object.entries(mod.PIPELINE_PATHS)) { writeFileSync(f, `original ${s}`); writeFileSync(join(out, f.split('/').pop()!), `export ${s}`); }
    mod.publish(out, '2026-11-12');
    mod.publish(out, '2026-11-13');
    const m = mod.PIPELINE_PATHS.math;
    expect(readFileSync(m, 'utf8')).toBe('export math');
    expect(statSync(m).mode & 0o222).toBe(0);
    const arch = readdirSync(join(m, '..', '_archive'));
    expect(arch).toEqual(['WitoScope_Math_Topics_Class1-6.final-before-cutover-2026-11-12.xlsx']);
    expect(readFileSync(join(m, '..', '_archive', arch[0]!), 'utf8')).toBe('original math');
    vi.doUnmock('node:os');
  });
});

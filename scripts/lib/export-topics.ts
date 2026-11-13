// D5 "Export to Excel": the topic workbooks regenerated from the CMS, read-only, for the
// content pipelines. Same sheet names and column order as the workbooks' Master Chapters,
// Master Topics and Class View, then the new columns (all classes, prerequisites, status,
// question count). Pure: builds the sheets from rows; scripts/export-topics.ts writes them.
// The source-mapping tabs (NCERT (CBSE), DAV, IXL, ISO / IMO Olympiad) are written from cms_source_map:
// book · class · chapter · topic → master topic IDs. Their evidence columns (book text), notes and scan
// paths are never stored and never exported (Sambit, 12 Nov 2026).
import { buildSequence, type SeqOrders } from '../../shared/sequence.ts';

export type Subject = 'math' | 'science' | 'grammar';
export const EXPORT_FILES: Record<Subject, string> = {
  math: 'WitoScope_Math_Topics_Class1-6.xlsx',
  science: 'WitoScope_Science_Topics_Class1-6.xlsx',
  grammar: 'WitoScope_English_Grammar_Topics_Class1-6.xlsx',
};
export interface XStrand { strand_id: string; code: string; name: string; sort: number }
export interface XChapter { chapter_id: string; strand_id: string; name: string; display_code: string | null; scope: string | null; sort: number; status: string }
export interface XTopic {
  topic_id: string; chapter_id: string; class: number; seq: number | null; name: string; level: number | null; sub_skills: string | null;
  topic_kind: string; source_flags: Record<string, string>; notes: string | null; status: string;
  classes: number[]; prereqs: string[]; questions: number;
}
export interface Sheet { name: string; columns: string[]; rows: (string | number | null)[][] }
export interface XMapRow { sheet: string; row_no: number; cells: [string, string | number | boolean | null][] }
const DROPPED_COLUMN = /evidence|^notes?\b|source scan/i;
const MAP_ORDER = ['NCERT (CBSE)', 'DAV', 'IXL', 'ISO Olympiad (SOF)', 'IMO Olympiad (SOF)'];

/** One sheet per source-mapping tab, columns in workbook order, book-text columns left out (again). */
export function mappingSheets(rows: XMapRow[]): Sheet[] {
  const sheets = [...new Set(rows.map((r) => r.sheet))].sort((a, b) => MAP_ORDER.indexOf(a) - MAP_ORDER.indexOf(b));
  return sheets.map((name) => {
    const list = rows.filter((r) => r.sheet === name).sort((a, b) => a.row_no - b.row_no);
    const columns = [...new Set(list.flatMap((r) => r.cells.map(([h]) => h)))].filter((h) => !DROPPED_COLUMN.test(h));
    return { name, columns, rows: list.map((r) => { const m = new Map(r.cells); return columns.map((c) => { const v = m.get(c); return v === undefined || v === null ? null : typeof v === 'boolean' ? String(v) : v; }); }) };
  });
}

const FLAG = (f: Record<string, string>, k: string) => f[k] ?? '–';
/** Each workbook's own "Classes – <source>" columns, in its order. */
const SOURCE_COLS: Record<Subject, [string, string][]> = {
  math: [['ncert', 'NCERT'], ['dav', 'DAV'], ['ixl', 'IXL'], ['imo', 'IMO']],
  science: [['ncert', 'NCERT'], ['dav', 'DAV'], ['iso', 'ISO']],
  grammar: [['ixl', 'IXL'], ['ncert', 'NCERT'], ['dav', 'DAV']],
};
const alsoTaught = (f: Record<string, string>) =>
  Object.entries(f).filter(([, v]) => v && !['–', '-', '—'].includes(v)).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(' · ');

/** Class View rows in the stored per-class order (13 Nov 2026): Seq = position in the class, No. = 1.2.3. */
function classView(strands: XStrand[], chapters: XChapter[], topics: XTopic[], orders: SeqOrders | null) {
  const normal = topics.filter((t) => t.topic_kind === 'normal' && t.status === 'active');
  if (!orders) return normal.sort((a, b) => a.class - b.class || (a.seq ?? 9999) - (b.seq ?? 9999) || a.topic_id.localeCompare(b.topic_id)).map((t) => ({ t, seq: t.seq, no: '' }));
  const out: { t: XTopic; seq: number | null; no: string }[] = [];
  for (const cls of [1, 2, 3, 4, 5, 6]) {
    let n = 0;
    for (const s of buildSequence(cls, strands, chapters, topics, orders)) for (const c of s.chapters) for (const x of c.topics)
      if (x.role === 'core') out.push({ t: x.topic as XTopic, seq: ++n, no: x.no ?? '' });
  }
  return out;
}

export function buildSheets(subject: Subject, strands: XStrand[], chapters: XChapter[], topics: XTopic[], exportedAt: string, maps: XMapRow[] = [], orders: SeqOrders | null = null): Sheet[] {
  const strand = new Map(strands.map((s) => [s.strand_id, s]));
  const chapter = new Map(chapters.map((c) => [c.chapter_id, c]));
  const normal = topics.filter((t) => t.topic_kind === 'normal').sort((a, b) => a.topic_id.localeCompare(b.topic_id));
  const ach = topics.filter((t) => t.topic_kind === 'achievers').sort((a, b) => a.chapter_id.localeCompare(b.chapter_id) || a.class - b.class);
  const sortedCh = [...chapters].sort((a, b) => a.sort - b.sort || a.chapter_id.localeCompare(b.chapter_id));
  const classesCell = (t: XTopic) => t.classes.join(', ');
  return [
    { name: 'Read me', columns: ['Item', 'Value'], rows: [
      ['Exported from', 'WitoScope Academic CMS (the CMS owns the curriculum; work queue D5, 12 Nov 2026)'],
      ['Exported at', exportedAt],
      ['Subject', subject],
      ['Read-only', 'Do not edit this file. Change chapters and topics in the CMS, then export again.'],
      ['Source tabs', 'NCERT (CBSE), DAV, IXL and the Olympiad tab: book, class, chapter, topic and master topic ID(s). The evidence columns (book text), notes and scan paths are not in the CMS and not exported; the archived final workbooks keep them.'],
      ['Order', 'Class View follows the order set in the CMS (Curriculum → Reorder): Seq = position in the class; No. = strand.chapter.topic (e.g. 1.2.3).'],
      ['New columns', 'Classes (all) = the topic\'s own class plus the classes it is mapped to (D2). Prerequisites = topic IDs (D4). Questions = production questions counted for coverage.'],
    ] },
    { name: 'Master Chapters', columns: ['Chapter ID', 'Strand Code', 'Strand', 'Display Code', 'Chapter', 'Scope (what belongs here)', '# Topics', 'Status'],
      rows: sortedCh.map((c) => [c.chapter_id, strand.get(c.strand_id)?.code ?? '', strand.get(c.strand_id)?.name ?? '', c.display_code, c.name, c.scope,
        normal.filter((t) => t.chapter_id === c.chapter_id && t.status === 'active').length, c.status]) },
    { name: 'Master Topics', columns: ['Topic ID', 'Chapter ID', 'Strand', 'Chapter', 'Topic', 'Sub-skills', 'Level', ...SOURCE_COLS[subject].map(([, l]) => `Classes – ${l}`), 'Notes',
      'Home class', 'Classes (all)', 'Prerequisites', 'Status', 'Questions'],
      rows: normal.map((t) => { const c = chapter.get(t.chapter_id); return [t.topic_id, t.chapter_id, c ? strand.get(c.strand_id)?.name ?? '' : '', c?.name ?? '', t.name, t.sub_skills, t.level,
        ...SOURCE_COLS[subject].map(([k]) => FLAG(t.source_flags, k)), t.notes,
        t.class, classesCell(t), t.prereqs.join(', '), t.status, t.questions]; }) },
    { name: 'Class View', columns: ['Class', 'Seq', 'Strand', 'Chapter ID', 'Chapter', 'Topic ID', 'Topic', 'Level', 'Sub-skills', "Also taught in (other sources' classes)",
      'Classes (all)', 'Prerequisites', 'Questions', 'No.'],
      rows: classView(strands, chapters, topics, orders)
        .map(({ t, seq, no }) => { const c = chapter.get(t.chapter_id); return [t.class, seq, c ? strand.get(c.strand_id)?.name ?? '' : '', t.chapter_id, c?.name ?? '', t.topic_id, t.name, t.level, t.sub_skills,
          alsoTaught(t.source_flags), classesCell(t), t.prereqs.join(', '), t.questions, no]; }) },
    { name: 'Achievers', columns: ['Topic ID', 'Chapter ID', 'Chapter', 'Class', 'Name', 'Status', 'Questions'],
      rows: ach.map((t) => [t.topic_id, t.chapter_id, chapter.get(t.chapter_id)?.name ?? '', t.class, t.name, t.status, t.questions]) },
    ...mappingSheets(maps),
  ];
}

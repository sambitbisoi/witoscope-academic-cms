// NCERT source registry (Phase 4): one cms_sources row per NCERT chapter PDF, from
// the topic workbooks' "NCERT (CBSE)" sheets, linked to the CMS chapters its
// mapped topics belong to. Pure: topics are passed in.
import type { Row } from './xlsx.ts';

export type Subject = 'math' | 'science' | 'grammar';
export interface SourceRow { source_id: string; kind: 'pdf'; title: string; publisher: 'NCERT'; class: number; url: string }
export interface SourceProblem { level: 'error' | 'warning'; where: string; message: string }

/** [guess] Source ID = NCERT's own PDF file stem: https://ncert.nic.in/textbook/pdf/fegp101.pdf → NCERT-fegp101 */
export const ncertSourceId = (url: string) => {
  const m = /\/([a-z0-9]+)\.pdf$/i.exec(url.trim());
  return m ? `NCERT-${m[1]!.toLowerCase()}` : null;
};
export const pdfStem = (url: string) => /\/([a-z0-9]+)\.pdf$/i.exec(url.trim())?.[1]?.toLowerCase() ?? null;

const TOPIC_RE = /\b(?:MT|ST|GT)\d{4}\b/g;
const s = (v: unknown) => (v === null || v === undefined ? null : String(v).trim() || null);

export function parseNcertSheet(subject: Subject, rows: Row[], topicChapter: Map<string, string>) {
  const label = { math: 'Math', science: 'Science', grammar: 'English' }[subject];
  const problems: SourceProblem[] = [];
  const bySource = new Map<string, { url: string; grade: number; book: string; chapters: Map<string, string>; cmsChapters: Set<string> }>();
  for (const { row, values: v } of rows) {
    const where = `${label} · NCERT (CBSE) row ${row}`;
    const url = s(v['Source PDF']);
    const id = url ? ncertSourceId(url) : null;
    if (!url || !id) { problems.push({ level: 'warning', where, message: `no usable Source PDF ("${url ?? ''}"); row skipped` }); continue; }
    const grade = Number(v['Grade']);
    if (!Number.isInteger(grade) || grade < 1 || grade > 6) { problems.push({ level: 'error', where, message: `grade "${v['Grade']}" is not 1–6` }); continue; }
    const no = s(v['Chapter No']) ?? s(v['Chapter/Unit No']) ?? '?';
    const title = s(v['Chapter (NCERT title)']) ?? s(v['Lesson']) ?? '';
    const src = bySource.get(id) ?? { url, grade, book: s(v['NCERT Book']) ?? 'NCERT', chapters: new Map(), cmsChapters: new Set<string>() };
    if (src.grade !== grade) problems.push({ level: 'warning', where, message: `${id} appears under grade ${src.grade} and ${grade}; using ${src.grade}` });
    if (!src.chapters.has(no)) src.chapters.set(no, title);
    for (const t of String(v['Master Topic ID(s)'] ?? '').match(TOPIC_RE) ?? []) {
      const ch = topicChapter.get(t);
      if (ch) src.cmsChapters.add(ch);
      else problems.push({ level: 'warning', where, message: `topic ${t} is not in the CMS; not linked` });
    }
    bySource.set(id, src);
  }
  const sources: SourceRow[] = [];
  const links: { source_id: string; chapter_id: string }[] = [];
  for (const [id, x] of bySource) {
    const chs = [...x.chapters].sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b));
    const [no, title] = chs[0]!;
    const more = chs.length > 1 ? ` (+${chs.length - 1} more)` : '';
    sources.push({ source_id: id, kind: 'pdf', title: `NCERT ${x.book}, Class ${x.grade} · Ch ${no} ${title}${more}`.trim(), publisher: 'NCERT', class: x.grade, url: x.url });
    if (!x.cmsChapters.size) problems.push({ level: 'warning', where: `${label} · ${id}`, message: 'no mapped topic is in the CMS; the source is registered but linked to no chapter' });
    for (const c of [...x.cmsChapters].sort()) links.push({ source_id: id, chapter_id: c });
  }
  return { sources, links, problems };
}

// ---------------------------------------------------------------- source-mapping tabs (12 Nov 2026)
/** The workbook tabs that map books, classes and chapters to master topics. */
export const MAPPING_SHEETS = ['NCERT (CBSE)', 'DAV', 'IXL', 'ISO Olympiad (SOF)', 'IMO Olympiad (SOF)'];
/** Columns never stored or exported: book text (evidence snippets, OCR), free notes, local scan paths. */
export const DROPPED_COLUMN = /evidence|^notes?\b|source scan/i;
export interface MapRow { subject: Subject; sheet: string; row_no: number; cells: [string, string | number | boolean | null][]; topic_ids: string[]; status: 'active' }

export function mappingRows(subject: Subject, sheets: Map<string, Row[]>): { rows: MapRow[]; dropped: Record<string, string[]> } {
  const rows: MapRow[] = []; const dropped: Record<string, string[]> = {};
  for (const sheet of MAPPING_SHEETS) {
    const data = sheets.get(sheet);
    if (!data) continue;
    const headers = [...new Set(data.flatMap((r) => Object.keys(r.values)))];
    dropped[sheet] = headers.filter((h) => DROPPED_COLUMN.test(h));
    for (const r of data) {
      const cells = Object.entries(r.values).filter(([h]) => !DROPPED_COLUMN.test(h)) as MapRow['cells'];
      const ids = Object.entries(r.values).filter(([h]) => /master topic id/i.test(h)).flatMap(([, v]) => String(v ?? '').match(TOPIC_RE) ?? []);
      rows.push({ subject, sheet, row_no: r.row, cells, topic_ids: [...new Set(ids)], status: 'active' });
    }
  }
  return { rows, dropped };
}

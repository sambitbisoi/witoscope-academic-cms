// Science master (Sambit, 13 Nov 2026; docs/science-plan.md): pure parsing of the master workbook's
// cells. No I/O. The workbook is our own words; book pages appear only as bare citations
// (book + printed page), which is all that reaches the CMS.

export const CONTENT_TYPES = ['Fact', 'Concept', 'How it works', 'Experiment', 'Scenario-Case', 'Diagram', 'Vocabulary'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];
export const QUESTION_USES = ['OK', 'Misconception only', 'No questions'] as const;
export const TIERS = ['L1', 'L2', 'L3'] as const;

/** Columns the importer needs; the master may have more (they are ignored). */
export const CONTENT_COLUMNS = ['File', 'Class', 'Book', 'Chapter no.', 'Chapter title', 'Row ID', 'Topic ID', 'Master chapter ID', 'Row class', 'Appears in (this chapter)',
  'Type', 'Chapter role', 'Content', 'Why it matters / real-life link', 'Common misconceptions', 'Diagram description', 'Picture question possible (Y/N)', 'Question use',
  'Questions (direct)', 'Questions (supporting)', 'Question status', 'Safety', 'Source', 'Found in', 'NCERT printed pages', 'DAV pages', 'Confidence', 'Notes'] as const;
export const QUESTION_COLUMNS = ['File', 'Class', 'Q ID', 'Content row ID(s)', 'Direct row ID(s)', 'Topic ID', 'Row class', 'Row type', 'Level', 'Format', 'Question',
  'Option A', 'B', 'C', 'D', 'Answer', 'Explanation', 'Misconception targeted', 'Picture needed (Y/N)', 'Image brief (question)', 'Image briefs (options)', 'Safety note',
  'Taught in', 'Confidence', 'Notes'] as const;
export const LEGEND_COLUMNS = ['Section', 'Name', 'Description', 'File', 'Class', 'Offset (printed = PDF + offset)', 'Printed pages'] as const;

export const missingColumns = (have: Iterable<string>, need: readonly string[]) => { const h = new Set(have); return need.filter((c) => !h.has(c)); };

// ---------------------------------------------------------------- small cell helpers
export const str = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' || String(v).trim() === '—' || String(v).trim() === '–' ? null : String(v).trim());
export const yn = (v: unknown): boolean | null => { const s = str(v)?.toUpperCase(); return s === 'Y' || s === 'YES' ? true : s === 'N' || s === 'NO' ? false : null; };
/** "C6-04-001, C6-04-014" (commas, semicolons or new lines) → ['C6-04-001', 'C6-04-014'], de-duplicated, order kept. */
export const idList = (v: unknown): string[] => [...new Set((str(v) ?? '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean))];

/** Flags carried in Notes: "TIME-SENSITIVE: checked <year>" and "ACCURACY:". */
export function notesFlags(notes: string | null) {
  const n = notes ?? '';
  const t = n.match(/TIME-SENSITIVE:\s*checked\s+(\d{4})/i);
  return { time_sensitive: /TIME-SENSITIVE/i.test(n), time_checked_year: t ? Number(t[1]) : null, accuracy_flag: /\bACCURACY:/.test(n) };
}

/** A question's content rows: "Direct row ID(s)" are direct, the rest of "Content row ID(s)" supporting.
 *  A direct row missing from the content list still counts (and is reported by the caller). */
export function questionLinks(allCell: unknown, directCell: unknown): { row_id: string; role: 'direct' | 'supporting' }[] {
  const all = idList(allCell), direct = idList(directCell);
  return [...direct.map((row_id) => ({ row_id, role: 'direct' as const })), ...all.filter((x) => !direct.includes(x)).map((row_id) => ({ row_id, role: 'supporting' as const }))];
}

// ---------------------------------------------------------------- pages
export interface PageRange { from: number; to: number }
/** "61–62, 78" / "3-4" / "5" / 5 → ranges. Throws on anything else. */
export function pageList(cell: string | number): PageRange[] {
  const s = String(cell).trim();
  if (!s) return [];
  return s.split(/\s*,\s*(?:pp?\.\s*)?/).map((part) => {
    const m = part.match(/^(\d+)\s*(?:[–-]\s*(\d+))?$/);
    if (!m) throw new Error(`can't read the page "${part}" in "${s}"`);
    const from = Number(m[1]), to = m[2] ? Number(m[2]) : from;
    if (to < from) throw new Error(`page range ${part} runs backwards in "${s}"`);
    return { from, to };
  });
}

/** One bare citation: a book short name ("NCERT" = the row class's NCERT book) and printed pages. */
export interface CellCitation { book: string; pages: PageRange[]; raw: string; for_row_id?: string; claude_added?: boolean }

/** DAV pages cell: "D5Wat p.70" · "Mag pp.205, 213" · "SFA p.151, p.153" · "Env p.3; Food p.17" · "MM 92–93". */
export function davPages(cell: unknown): CellCitation[] {
  const s = str(cell);
  if (!s) return [];
  return s.split(/\s*;\s*/).filter(Boolean).map((part) => {
    const m = part.match(/^([A-Za-z][A-Za-z0-9]*)\s+(?:pp?\.\s*)?(.+)$/);
    if (!m) throw new Error(`can't read the DAV pages "${part}"`);
    return { book: m[1]!, pages: pageList(m[2]!), raw: part };
  });
}

/** NCERT printed pages cell: "61–62, 78" → one citation of the row class's NCERT book. */
export function ncertPages(cell: unknown): CellCitation[] {
  const s = str(cell);
  return s ? [{ book: 'NCERT', pages: pageList(s), raw: `NCERT p.${s}` }] : [];
}

/** One "Taught in" segment: "NCERT p.61–62; DAV Mag p.203" or "Claude-added (extends NCERT p.65)". */
function taughtSegment(seg: string, forRow?: string): CellCitation[] {
  const out: CellCitation[] = [];
  const claude = seg.match(/^Claude-added\s*\(extends NCERT pp?\.\s*([^)]+)\)$/i);
  if (claude) return [{ book: 'NCERT', pages: pageList(claude[1]!), raw: seg, claude_added: true, ...(forRow ? { for_row_id: forRow } : {}) }];
  for (const part of seg.split(/\s*;\s*/).filter(Boolean)) {
    const n = part.match(/^NCERT\s+pp?\.\s*(.+)$/);
    const d = part.match(/^DAV\s+(.+)$/);
    if (n) out.push({ book: 'NCERT', pages: pageList(n[1]!), raw: part });
    else if (d) out.push(...davPages(d[1]));
    else throw new Error(`can't read "${part}" in Taught in`);
  }
  return out.map((c) => (forRow ? { ...c, for_row_id: forRow } : c));
}
/** "Taught in": a plain list, or per content row "C6-04-001: … | C6-04-014: …". */
export function taughtIn(cell: unknown): CellCitation[] {
  const s = str(cell);
  if (!s) return [];
  return s.split(/\s*\|\s*/).flatMap((seg) => {
    const m = seg.match(/^(C[1-6]-[0-9A-Z]{2,4}-\d{3}):\s*(.+)$/);
    return m ? taughtSegment(m[2]!, m[1]) : taughtSegment(seg);
  });
}

// ---------------------------------------------------------------- books (Legend → sources)
export interface LegendBook { short: string; title: string; file: string; class: number; offset: number; printed: PageRange | null }
export interface ScienceSource { source_id: string; publisher: 'NCERT' | 'DAV'; kind: 'pdf' | 'scanned_pdf'; title: string; class: number; page_offset: number; file: string; shorts: string[] }

/** "Our Wondrous World … – Ch 1 Water" etc. Legend rows of section "Book short names". */
export function legendBooks(rows: Record<string, unknown>[]): LegendBook[] {
  return rows.filter((r) => str(r.Section) === 'Book short names').map((r) => {
    // "161–176 (Seasons' Journal pp.177–182 and Notes pp.183–184 unnumbered)": the chapter's PDF runs to the highest page named
    const cell = str(r['Printed pages']);
    const printed = cell?.match(/^(\d+)\s*[–-]\s*(\d+)/);
    const highest = Math.max(...(cell?.match(/\d+/g) ?? []).map(Number));
    return {
      short: str(r.Name)!, title: str(r.Description) ?? str(r.Name)!, file: str(r.File)!, class: Number(r.Class),
      offset: Number(r['Offset (printed = PDF + offset)'] ?? 0), printed: printed ? { from: Number(printed[1]), to: Math.max(Number(printed[2]), highest) } : null,
    };
  });
}

/** Source ID from the file name: NCERT-class-6-chapter-4, DAV-magnets, DAV-class-06-chapter-1-5. [the official NCERT code is not known; Q3] */
export function sourceIdFor(file: string): string {
  const publisher = /^NCERT\//.test(file) ? 'NCERT' : 'DAV';
  const stem = file.split('/').pop()!.replace(/\.pdf$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${publisher}-${stem}`;
}

/** One CMS source per PDF. CMS page_offset is "printed = pdf − offset", the Legend's is "printed = PDF + offset". */
export function sourcesFromLegend(books: LegendBook[]): ScienceSource[] {
  const byFile = new Map<string, ScienceSource>();
  for (const b of books) {
    const id = sourceIdFor(b.file);
    const ex = byFile.get(id);
    if (ex) { ex.shorts.push(b.short); continue; }
    const ncert = id.startsWith('NCERT-');
    const title = ncert ? b.title : `DAV Class ${b.class} – ${b.file.split('/').pop()!.replace(/\.pdf$/i, '')}`;
    byFile.set(id, { source_id: id, publisher: ncert ? 'NCERT' : 'DAV', kind: ncert ? 'pdf' : 'scanned_pdf', title, class: b.class, page_offset: -b.offset, file: b.file, shorts: [b.short] });
  }
  return [...byFile.values()];
}

/** Resolve a cell citation to sources: DAV short names directly; NCERT pages through the class's chapter page ranges
 *  (NCERT printed pages run on through a class's book, so a page belongs to exactly one chapter PDF). */
export function resolveCitation(c: CellCitation, rowClass: number, books: LegendBook[]): { source_id: string; page_from: number; page_to: number; raw: string; for_row_id?: string }[] {
  if (c.book === 'NCERT') {
    const chapters = books.filter((b) => b.class === rowClass && /^NCERT\//.test(b.file) && b.printed);
    return c.pages.map((p) => {
      const b = chapters.find((x) => p.from >= x.printed!.from && p.from <= x.printed!.to);
      if (!b) throw new Error(`NCERT class ${rowClass} p.${p.from} is in no chapter of the Legend`);
      return { source_id: sourceIdFor(b.file), page_from: p.from, page_to: p.to, raw: clip(c.raw), ...(c.for_row_id ? { for_row_id: c.for_row_id } : {}) };
    });
  }
  const b = books.find((x) => x.short === c.book);
  if (!b) throw new Error(`book short name "${c.book}" is not in the Legend`);
  return c.pages.map((p) => ({ source_id: sourceIdFor(b.file), page_from: p.from, page_to: p.to, raw: clip(c.raw), ...(c.for_row_id ? { for_row_id: c.for_row_id } : {}) }));
}
const clip = (s: string) => (s.length <= 80 ? s : `${s.slice(0, 79)}…`);

// ---------------------------------------------------------------- question mapping
/** The stored format: four options → MCQ-4; True/False (options A–B) → True/False. */
export function storedFormat(sheetFormat: string, options: (string | null)[]): 'MCQ-4' | 'True/False' {
  const n = options.filter((o) => o !== null).length;
  if (/^true\s*\/\s*false$/i.test(sheetFormat.trim())) return 'True/False';
  if (n === 4) return 'MCQ-4';
  throw new Error(`format "${sheetFormat}" with ${n} options is not MCQ-4 or True/False`);
}

/** Figure description from the image briefs: the question brief, then "Options: A: … B: …". */
export function figureDescription(question: string | null, options: string | null): string | null {
  const parts = [question, options ? `Options:\n${options}` : null].filter(Boolean);
  return parts.length ? parts.join('\n\n') : null;
}

/** Content row status shown in the CMS (computed from links; the sheet's own column is only cross-checked). */
export type RowStatus = 'direct' | 'supporting' | 'not_eligible' | 'none';
export function rowStatus(questionUse: string, nDirect: number, nSupporting: number): RowStatus {
  return nDirect > 0 ? 'direct' : nSupporting > 0 ? 'supporting' : questionUse !== 'OK' ? 'not_eligible' : 'none';
}
/** The sheet's "Question status" in the same terms. */
export function sheetStatus(s: string | null): RowStatus | null {
  if (!s) return null;
  if (/^Has questions/i.test(s)) return 'direct';
  if (/^Supporting/i.test(s)) return 'supporting';
  if (/^Not eligible/i.test(s)) return 'not_eligible';
  if (/^None yet/i.test(s)) return 'none';
  return null;
}

/** Topic–class role of an extra class link. */
export const extraRole = (home: number, cls: number): 'lower' | 'higher' => (home < cls ? 'lower' : 'higher');

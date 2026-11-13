// Science originality check (Sambit, 13 Nov 2026). Runs ONLY on this Mac: it reads the Science book
// PDFs (NCERT, text layer via pdftotext) and the local OCR text of the DAV scans (Science/DAV_OCR, whose
// "=== PAGE n ===" markers are PDF pages), and compares EVERY field of every content row and question
// in the master with them. The report holds citations and scores only, never book text.
//
// Content rows: the wording test on every field (the numbers rule is off: a fact's numbers are the
// book's facts). Questions: as for Math (12 Nov 2026): wording on every field of 6+ words, the
// numbers rule on the text, figure description and options.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkText, corpus, MIN_WORDS, NEAR_COPY_DEFAULT, NUMBERS_RULE_FIELD, worse, type BookPage, type Corpus, type FieldResult, type OriginalityResult } from '../../shared/originality.ts';
import type { LegendBook, ScienceSource } from '../../shared/science.ts';
import { pdfPages } from './local-books.ts';
import type { MasterQuestion, MasterRow } from './science-master.ts';

export const SCIENCE_REPORT_SCHEMA = 'cms-science-originality/1';
export const SCIENCE_TOOL = 'check-originality science 1';
/** DAV pages read around the cited ones (printed pages ± this), so a row's neighbourhood is covered. [guess] */
const DAV_MARGIN = 3;

export interface ScienceCheck extends OriginalityResult { key: string; field?: string; fields?: FieldResult[] }
export interface ScienceReport {
  file_schema: typeof SCIENCE_REPORT_SCHEMA; tool: string; master_sha256: string; checked_at: string;
  threshold: number; near_copy_threshold: number;
  read: { source_id: string; pages: string }[]; missing: string[];
  rows: ScienceCheck[]; questions: ScienceCheck[];
}

/** The local OCR text file of a DAV scan: DAV/Source/Class 6/Magnets.pdf → DAV_OCR/Class_6__Magnets.txt */
export const ocrFileFor = (scienceRoot: string, file: string, cls: number) =>
  join(scienceRoot, 'DAV_OCR', `Class_${cls}__${file.split('/').pop()!.replace(/\.pdf$/i, '').replace(/ /g, '_')}.txt`);

export function ocrPages(path: string, sourceId: string, from?: number, to?: number): BookPage[] {
  const out: BookPage[] = [];
  const text = readFileSync(path, 'utf8');
  const re = /^\f?=== PAGE (\d+) ===[ \t\r]*$/gm;
  const marks = [...text.matchAll(re)];
  marks.forEach((m, i) => {
    const page = Number(m[1]);
    if ((from && page < from) || (to && page > to)) return;
    const body = text.slice(m.index! + m[0].length, i + 1 < marks.length ? marks[i + 1]!.index : text.length);
    if (body.trim()) out.push({ source_id: sourceId, pdf_page: page, text: body });
  });
  return out;
}

/** Pages to read for one content file: its NCERT chapter (whole PDF) and the DAV pages its rows cite (± margin). */
export function corpusPlan(rows: MasterRow[], sources: ScienceSource[]) {
  const want = new Map<string, { from: number; to: number } | 'all'>();
  for (const r of rows) {
    for (const c of r.citations) {
      const s = sources.find((x) => x.source_id === c.source_id)!;
      if (s.publisher === 'NCERT') { want.set(s.source_id, 'all'); continue; }
      // printed → pdf: pdf = printed + page_offset (CMS convention: printed = pdf − offset)
      const a = Math.max(1, c.page_from + s.page_offset - DAV_MARGIN), b = c.page_to + s.page_offset + DAV_MARGIN;
      const w = want.get(s.source_id);
      want.set(s.source_id, w === 'all' ? 'all' : { from: Math.min(w?.from ?? a, a), to: Math.max(w?.to ?? b, b) });
    }
  }
  return want;
}

export class ScienceBooks {
  readonly read = new Map<string, string>();
  readonly missing = new Set<string>();
  private cache = new Map<string, BookPage[]>();
  constructor(private scienceRoot: string, private sources: ScienceSource[]) {}
  pages(sourceId: string, range: { from: number; to: number } | 'all'): BookPage[] {
    const key = `${sourceId}|${range === 'all' ? 'all' : `${range.from}-${range.to}`}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const s = this.sources.find((x) => x.source_id === sourceId)!;
    const from = range === 'all' ? undefined : range.from, to = range === 'all' ? undefined : range.to;
    let pages: BookPage[] = [];
    if (s.publisher === 'NCERT') {
      const pdf = join(this.scienceRoot, s.file);
      if (existsSync(pdf)) pages = pdfPages(pdf, sourceId, from ?? null, to ?? null);
    } else {
      const ocr = ocrFileFor(this.scienceRoot, s.file, s.class);
      if (existsSync(ocr)) pages = ocrPages(ocr, sourceId, from, to);
    }
    if (!pages.length) this.missing.add(sourceId);
    else this.read.set(key, `${sourceId} (${s.publisher === 'NCERT' ? 'pdftotext' : 'local OCR'}, ${range === 'all' ? 'all pages' : `pdf ${from}–${to}`})`);
    this.cache.set(key, pages);
    return pages;
  }
}

export function rowFields(r: MasterRow): { field: string; text: string }[] {
  return ([['content', r.content], ['why it matters', r.why_it_matters], ['misconceptions', r.misconceptions], ['diagram description', r.diagram_description],
    ['notes', r.notes], ['safety', r.safety]] as [string, string | null][]).filter(([, t]) => t && t.trim()).map(([field, text]) => ({ field, text: text! }));
}
export function questionFields(q: MasterQuestion): { field: string; text: string }[] {
  return ([['text', q.text], ['figure description', q.figure_description], ['options', q.options.join(', ')], ['solution', q.explanation],
    ['misconception targeted', q.misconception_targeted], ['safety note', q.safety_note]] as [string, string | null][])
    .filter(([, t]) => t && t.trim()).map(([field, text]) => ({ field, text: text! }));
}

function checkFields(key: string, fields: { field: string; text: string }[], c: Corpus, th: number, near: number, numbers: (f: string) => boolean): ScienceCheck {
  const res = fields.map((f) => ({ field: f.field, ...checkText(f.text, c, th, near, { wording: f.field === 'text' || f.text.trim().split(/\s+/).length >= MIN_WORDS, numbers: numbers(f.field) }) }));
  if (!res.length) return { key, result: 'clear', similarity: 0, same_numbers: false, closest_ref: null };
  let w = res[0]!;
  for (const f of res) if (worse(f, w)) w = f;
  return { key, ...w, fields: res.filter((f) => f.result === 'flagged' || f.result === 'near_copy') };
}

/** Check every content row and question of the master against the books on this Mac. */
export function checkMaster(master: { sha256: string; rows: MasterRow[]; questions: MasterQuestion[]; sources: ScienceSource[]; books: LegendBook[] }, scienceRoot: string,
  th: number, near = NEAR_COPY_DEFAULT, progress: (s: string) => void = () => {}): ScienceReport {
  const books = new ScienceBooks(scienceRoot, master.sources);
  const byFile = new Map<string, MasterRow[]>();
  for (const r of master.rows) byFile.set(r.master_file, [...(byFile.get(r.master_file) ?? []), r]);
  const corpora = new Map<string, Corpus>();
  const corpusOf = (file: string) => {
    if (!corpora.has(file)) {
      const pages = [...corpusPlan(byFile.get(file)!, master.sources)].flatMap(([id, range]) => books.pages(id, range));
      corpora.set(file, corpus(pages, []));
    }
    return corpora.get(file)!;
  };
  const rows: ScienceCheck[] = [];
  let i = 0;
  for (const [file, list] of byFile) {
    progress(`  ${file} (${++i}/${byFile.size}): ${list.length} rows`);
    const c = corpusOf(file);
    for (const r of list) rows.push(checkFields(r.row_id, rowFields(r), c, th, near, () => false));
  }
  const fileOfRow = new Map(master.rows.map((r) => [r.row_id, r.master_file]));
  const questions = master.questions.map((q) => {
    const files = [...new Set(q.links.map((l) => fileOfRow.get(l.row_id)).filter((f): f is string => !!f))];
    const c: Corpus = { items: files.flatMap((f) => corpusOf(f).items) };
    return checkFields(q.qid, questionFields(q), c, th, near, NUMBERS_RULE_FIELD);
  });
  return {
    file_schema: SCIENCE_REPORT_SCHEMA, tool: SCIENCE_TOOL, master_sha256: master.sha256, checked_at: new Date().toISOString(), threshold: th, near_copy_threshold: near,
    read: [...books.read.values()].sort().map((x) => ({ source_id: x.split(' ')[0]!, pages: x.slice(x.indexOf('(') + 1, -1) })), missing: [...books.missing].sort(), rows, questions,
  };
}

export const scienceReportPath = (masterPath: string) => masterPath.replace(/\.xlsx$/i, '') + '.originality.json';
export const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

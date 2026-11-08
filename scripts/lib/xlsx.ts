// Minimal, defensive .xlsx reading: one record per row, keyed by the header row.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';

export type Cell = string | number | boolean | null;
export interface Row { row: number; values: Record<string, Cell> }

/** Normalise an ExcelJS cell value: rich text, formulas, hyperlinks, dates. Empty → null. */
export function cellValue(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return cellValue((o.richText as { text: string }[]).map((t) => t.text).join(''));
    if ('result' in o) return cellValue(o.result);
    if ('text' in o) return cellValue(o.text);
    if ('error' in o) return null;
  }
  return String(v);
}

export interface Workbook { path: string; sha256: string; sheets: Map<string, Row[]> }

export async function readWorkbook(path: string): Promise<Workbook> {
  const buf = readFileSync(path);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheets = new Map<string, Row[]>();
  for (const ws of wb.worksheets) {
    const header = (ws.getRow(1).values as unknown[]).map((h) => {
      const c = cellValue(h);
      return c === null ? null : String(c).replace(/\s+/g, ' ').trim();
    });
    const rows: Row[] = [];
    ws.eachRow((r, i) => {
      if (i === 1) return;
      const values: Record<string, Cell> = {};
      let any = false;
      (r.values as unknown[]).forEach((v, ci) => {
        const key = header[ci];
        if (!key) return;
        const c = cellValue(v);
        values[key] = c;
        if (c !== null) any = true;
      });
      if (any) rows.push({ row: i, values });
    });
    sheets.set(ws.name, rows);
  }
  return { path, sha256: createHash('sha256').update(buf).digest('hex'), sheets };
}

/** Every sheet as raw rows of normalised cells (row 1 first), for sheets whose header is not in row 1. */
export async function readRaw(path: string): Promise<{ sha256: string; sheets: Map<string, Cell[][]> }> {
  const buf = readFileSync(path);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheets = new Map<string, Cell[][]>();
  for (const ws of wb.worksheets) {
    const rows: Cell[][] = [];
    ws.eachRow((r) => rows.push((r.values as unknown[]).slice(1).map(cellValue)));
    sheets.set(ws.name, rows);
  }
  return { sha256: createHash('sha256').update(buf).digest('hex'), sheets };
}

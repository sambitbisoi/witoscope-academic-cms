// Course builder (Q13): read an uploaded .xlsx into plain rows, and write the template, in the browser (exceljs, loaded
// only when needed). The file never leaves the browser; only its name and SHA-256 are recorded with the save.
import type { Cell, Sheets } from '../../shared/course-excel.ts';

type ExcelMod = typeof import('exceljs');
async function excel(): Promise<ExcelMod> {
  const m = (await import('exceljs')) as unknown as { default?: ExcelMod } & ExcelMod;
  return m.default ?? m;
}

function cellValue(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return cellValue((o.richText as { text: string }[]).map((t) => t.text).join(''));
    if ('result' in o) return cellValue(o.result);
    if ('text' in o) return cellValue(o.text);
    return null;
  }
  return String(v);
}

export async function readCourseXlsx(file: File): Promise<{ sheets: Sheets; sha256: string }> {
  const buf = await file.arrayBuffer();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ExcelJS = await excel();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheets: Sheets = new Map();
  for (const ws of wb.worksheets) {
    const header = (ws.getRow(1).values as unknown[]).map((h) => { const c = cellValue(h); return c === null ? null : String(c).trim().toLowerCase(); });
    const rows: { row: number; values: Record<string, Cell> }[] = [];
    ws.eachRow((r, i) => {
      if (i === 1) return;
      const values: Record<string, Cell> = {};
      let any = false;
      (r.values as unknown[]).forEach((v, ci) => { const k = header[ci]; if (!k) return; const c = cellValue(v); values[k] = c; if (c !== null) any = true; });
      if (any) rows.push({ row: i, values });
    });
    sheets.set(ws.name, rows);
  }
  return { sheets, sha256: hash };
}

export async function downloadCourseXlsx(fileName: string, sheets: { name: string; columns: string[]; rows: Cell[][] }[]) {
  const ExcelJS = await excel();
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.addRow(s.columns);
    ws.getRow(1).font = { bold: true };
    for (const r of s.rows) ws.addRow(r);
    s.columns.forEach((c, i) => { ws.getColumn(i + 1).width = /name|chapter$|notes|placed/.test(c) ? 44 : Math.max(10, c.length + 2); });
  }
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url; a.download = fileName; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

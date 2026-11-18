// Book chapter reference (Q13, 18 Nov 2026): NCERT and DAV chapter numbers and titles from
// ContentResearch/Books_NCERT_DAV_Chapter_Map_Class1-6.xlsx (one sheet per subject and class, one row per NCERT chapter
// with the DAV chapter(s) beside it). Bare citations only: the "Covers", "Notes" and Olympiad columns are never read.
import type { Cell, Row } from './xlsx.ts';

export interface BookChapter { book: 'NCERT' | 'DAV'; book_title: string; class: number; subject: 'math' | 'science'; ch_no: number; ch_name: string }
export interface Normalised { chapters: BookChapter[]; problems: string[]; notes: string[] }

const str = (c: Cell | undefined) => (c === null || c === undefined ? '' : String(c).trim());
const part = (s: string) => s.replace(/\s*\(part\)\s*$/i, '').trim();
const SHEET = /^(Math|Science) C([1-6])$/;

/** Normalise the subject/class sheets. Problems block the import; notes are information. */
export function normaliseBookChapters(sheets: Map<string, Row[]>): Normalised {
  const out = new Map<string, BookChapter>();
  const problems: string[] = [];
  const notes: string[] = [];
  const add = (c: BookChapter, where: string) => {
    if (!c.ch_name) { problems.push(`${where}: ${c.book} chapter ${c.ch_no} has no name`); return; }
    if (c.ch_name.length > 120) { problems.push(`${where}: ${c.book} chapter ${c.ch_no} name is over 120 characters`); return; }
    const k = `${c.book}|${c.class}|${c.subject}|${c.ch_no}`;
    const had = out.get(k);
    if (!had) { out.set(k, c); return; }
    if (had.ch_name !== c.ch_name) notes.push(`${where}: ${c.book} C${c.class} ${c.subject} ch ${c.ch_no} named "${c.ch_name}" here and "${had.ch_name}" before (first kept)`);
  };
  for (const [name, rows] of sheets) {
    const m = SHEET.exec(name);
    if (!m) continue;
    const subject = m[1] === 'Math' ? 'math' : 'science';
    const cls = Number(m[2]);
    for (const r of rows) {
      const v = r.values;
      const where = `${name} row ${r.row}`;
      if (Number(v['Class']) !== cls) { problems.push(`${where}: Class is ${str(v['Class'])}, the sheet says ${cls}`); continue; }
      const nBook = str(v['NCERT book']);
      const nNo = str(v['NCERT ch no']);
      if (nNo) {
        if (!/^\d{1,2}$/.test(nNo)) problems.push(`${where}: NCERT ch no "${nNo}" is not a number`);
        else add({ book: 'NCERT', book_title: nBook, class: cls, subject, ch_no: Number(nNo), ch_name: str(v['NCERT chapter name']) }, where);
      }
      const dNos = str(v['DAV ch no']).split('\n').map((s) => part(s)).filter(Boolean);
      const dNames = str(v['DAV chapter name']).split('\n').map((s) => part(s)).filter(Boolean);
      if (!dNos.length) continue;
      if (dNos.length !== dNames.length) { problems.push(`${where}: ${dNos.length} DAV chapter numbers but ${dNames.length} names`); continue; }
      dNos.forEach((no, i) => {
        if (!/^\d{1,2}$/.test(no)) problems.push(`${where}: DAV ch no "${no}" is not a number`);
        else add({ book: 'DAV', book_title: str(v['DAV book']), class: cls, subject, ch_no: Number(no), ch_name: dNames[i]! }, where);
      });
    }
  }
  const chapters = [...out.values()].sort((a, b) => a.subject.localeCompare(b.subject) || a.class - b.class || a.book.localeCompare(b.book) || a.ch_no - b.ch_no);
  return { chapters, problems, notes };
}

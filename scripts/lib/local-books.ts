// Book material on THIS Mac (Sambit, 10 Nov 2026): the PDFs under ~/WitoScope/ContentResearch
// and the local book files (QuestionBank/**/*.book.json). Read here, compared here, never
// sent anywhere: only citations and scores leave this module.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BookItem, BookPage } from '../../shared/originality.ts';
import { pdfStem } from './sources.ts';

export const CONTENT_ROOT = process.env.CMS_CONTENT_ROOT ?? join(homedir(), 'WitoScope', 'ContentResearch');

function walk(dir: string, test: (name: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, test, out);
    else if (test(e.name)) out.push(p);
  }
  return out;
}

/** PDF file stem (lower case) → path, e.g. fegp101 → …/Math/NCERT/Class6/fegp101.pdf */
export function indexPdfs(root = CONTENT_ROOT): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of walk(root, (n) => /\.pdf$/i.test(n))) m.set(p.split('/').pop()!.replace(/\.pdf$/i, '').toLowerCase(), p);
  return m;
}
/** A source's PDF on this Mac: the source ID without its publisher prefix is the file stem (P1). */
export const pdfFor = (pdfs: Map<string, string>, sourceId: string) => pdfs.get(sourceId.replace(/^[A-Z]+-/, '').toLowerCase());

/** Page texts of a PDF (PDF pages from…to, or all), via poppler's pdftotext. */
export function pdfPages(file: string, sourceId: string, from?: number | null, to?: number | null): BookPage[] {
  const args = ['-enc', 'UTF-8', ...(from ? ['-f', String(from)] : []), ...(to ? ['-l', String(to)] : []), file, '-'];
  const out = execFileSync('pdftotext', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return out.split('\f').map((text, i) => ({ source_id: sourceId, pdf_page: (from ?? 1) + i, text })).filter((p) => p.text.trim());
}

/** Items of the local book files, by source ID (book items keep their text only here). */
export function localBookItems(root = CONTENT_ROOT): Map<string, { file: string; items: BookItem[] }[]> {
  const m = new Map<string, { file: string; items: BookItem[] }[]>();
  for (const file of walk(join(root, 'QuestionBank'), (n) => n.endsWith('.book.json'))) {
    try {
      const b = JSON.parse(readFileSync(file, 'utf8')) as { source?: { publisher?: string; file_path?: string }; items?: { ref_id?: string; text?: string }[] };
      const stem = pdfStem(b.source?.file_path ?? '');
      if (!stem) continue;
      const id = `${b.source?.publisher ?? 'NCERT'}-${stem}`;
      const items = (b.items ?? []).filter((i) => i.ref_id && i.text).map((i) => ({ ref_id: i.ref_id!, text: i.text! }));
      m.set(id, [...(m.get(id) ?? []), { file, items }]);
    } catch { /* not a book file; skipped */ }
  }
  return m;
}

export const hasPdftotext = () => {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
};

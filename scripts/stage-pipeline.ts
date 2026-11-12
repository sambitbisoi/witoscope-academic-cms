// npm run stage:pipeline -- <QuestionBank/NCERT-C6-01> [more folders…] [--out .local-import]
//
// Local converter from the book-to-question pipeline's output to what the importers expect.
// Reads ONLY the folder's chapter files (MC##-C#.json) and lists images/; never opens
// *.book.json or source_images/. The pipeline files are not changed: converted copies go
// to <out>/<folder>/ (git-ignored), where check:originality writes its report next to them.
//
// Differences handled (reported per file):
//   D1 patterns[] in chapter files duplicate the folder's proposals.json; they are dropped
//      here because import:proposals loads them as 'proposed' (the chapter importer would
//      add them as 'active').
//   D2 figure.image_file "images/MC02-0015.png" (a folder path) → the storage key
//      "figures/MC02-0015.png" that the local stand-in and R2 use. The PNG is the figure;
//      the .svg next to it is its drawing source and is not stored (the file service
//      accepts PNG/JPEG/WebP only).
//   D3 figure.image_status is set to has_image when the PNG exists, needs_image when it doesn't.
// --skip KEY[,KEY…] leaves questions out of the staged copy (e.g. a key the CMS already uses
// for a different question); each skip is reported.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export const STAGE_DIR = resolve(import.meta.dirname, '..', '.local-import');
const CHAPTER_FILE = /^(MC|SC|GC)\d{2}-C\d\.json$/;

export interface StageResult { folder: string; files: { file: string; staged: string; questions: number; notes: string[] }[]; images: { key: string; from: string }[] }

export function stageFolder(dir: string, out = STAGE_DIR, skip = new Set<string>()): StageResult {
  const folder = basename(resolve(dir));
  const target = join(out, folder);
  mkdirSync(target, { recursive: true });
  const res: StageResult = { folder, files: [], images: [] };
  for (const name of readdirSync(dir).filter((n) => CHAPTER_FILE.test(n)).sort()) {
    const data = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    const notes: string[] = [];
    const before = (data.questions ?? []).length;
    data.questions = (data.questions ?? []).filter((q: { key: string }) => !skip.has(q.key) || (notes.push(`${q.key}: skipped (--skip)`), false));
    if (!data.questions.length) { notes.push(`all ${before} question(s) skipped; file not staged`); res.files.push({ file: join(dir, name), staged: '', questions: 0, notes }); continue; }
    if (data.patterns?.length) { notes.push(`D1: ${data.patterns.length} pattern(s) left to import:proposals`); delete data.patterns; }
    let moved = 0, missing = 0;
    for (const q of data.questions ?? []) {
      const fig = q.figure;
      if (!fig?.image_file) continue;
      const src = resolve(dir, fig.image_file);
      if (!src.startsWith(resolve(dir, 'images') + '/')) { notes.push(`${q.key}: image ${fig.image_file} is not under images/; left out`); delete fig.image_file; fig.image_status = 'needs_image'; continue; }
      const key = `figures/${basename(src)}`;
      if (existsSync(src) && /\.png$/i.test(src)) {
        fig.image_file = key; fig.image_status = 'has_image'; moved++;
        res.images.push({ key, from: src });
      } else {
        delete fig.image_file; fig.image_status = 'needs_image'; missing++;
        notes.push(`${q.key}: ${basename(src)} is missing or not a PNG; marked needs_image`);
      }
    }
    if (moved) notes.push(`D2/D3: ${moved} figure path(s) → figures/<key>.png`);
    if (missing) notes.push(`D3: ${missing} figure(s) without an image`);
    const staged = join(target, name);
    writeFileSync(staged, JSON.stringify(data, null, 2) + '\n');
    res.files.push({ file: join(dir, name), staged, questions: (data.questions ?? []).length, notes });
  }
  return res;
}

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const out = args.includes('--out') ? resolve(args[args.indexOf('--out') + 1]!) : STAGE_DIR;
  const skip = new Set(args.includes('--skip') ? args[args.indexOf('--skip') + 1]!.split(',') : []);
  const dirs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out' && args[i - 1] !== '--skip');
  if (!dirs.length) { console.error('usage: npm run stage:pipeline -- <pipeline folder> [more…] [--out dir]'); process.exit(1); }
  for (const d of dirs) {
    const r = stageFolder(d, out, skip);
    console.log(`${r.folder}: ${r.files.length} chapter file(s), ${r.files.reduce((n, f) => n + f.questions, 0)} questions, ${r.images.length} figure image(s) → ${join(out, r.folder)}`);
    for (const f of r.files) for (const n of f.notes) console.log(`  ${basename(f.file)}  ${n}`);
  }
}

// U3 (queue 12 Nov 2026): the Import screen's LOCAL mode. Served only by `npm run dev:files`
// on Sambit's Mac (127.0.0.1, behind the local Access token); the live site has no /api/local
// and its Import screen shows the history only.
//
// It runs the same commands as the command line, in the same order, on this Mac:
//   Check  : stage:pipeline → import:proposals --dry-run → import:book --dry-run →
//            check:originality (each chosen file) → chapter validate (each chosen file)
//   Import : stage:pipeline → import:proposals → import:book → check:originality →
//            chapter import (each chosen file) → import:figures
// Book files are read here only (pdftotext, local book files); the browser gets the commands'
// printed reports (keys, citations, scores), never book text. Writes go to the LOCAL database
// only: the commands default to this repo's local container, and this refuses to run if
// CMS_DATABASE_URL points anywhere else.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { STAGE_DIR } from '../stage-pipeline.ts';

export const PIPELINE_ROOT = resolve(process.env.CMS_PIPELINE_ROOT ?? join(homedir(), 'WitoScope', 'ContentResearch', 'QuestionBank'));
const REPO = resolve(import.meta.dirname, '..', '..');
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const CHAPTER_FILE = /^(MC|SC|GC)\d{2}-C\d\.json$/;

export interface LocalFolder { folder: string; files: { name: string; questions: number; modified: string }[]; proposals: boolean; book: boolean; staged: boolean }
export interface StepResult { label: string; command: string; code: number; output: string }

export function isLocalTarget(): boolean {
  const url = process.env.CMS_DATABASE_URL;
  if (!url) return true;
  const h = new URL(url).hostname;
  return h === '127.0.0.1' || h === 'localhost';
}

/** Pipeline folders (e.g. NCERT-C5-01) with their chapter files. Never lists book files' contents. */
export function listFolders(root = PIPELINE_ROOT): LocalFolder[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => FOLDER.test(n) && !n.startsWith('_') && statSync(join(root, n)).isDirectory()).sort().map((folder) => {
    const dir = join(root, folder);
    const names = readdirSync(dir);
    const files = names.filter((n) => CHAPTER_FILE.test(n)).sort().map((name) => {
      let questions = 0;
      try { questions = (JSON.parse(readFileSync(join(dir, name), 'utf8')).questions ?? []).length; } catch { questions = -1; }
      return { name, questions, modified: statSync(join(dir, name)).mtime.toISOString() };
    });
    return { folder, files, proposals: names.includes(`${folder}.proposals.json`), book: names.includes(`${folder}.book.json`), staged: existsSync(join(STAGE_DIR, folder)) };
  }).filter((f) => f.files.length > 0);
}

/** The command list for a check or an import. Pure: tested in tests/local-import.test.ts. */
export function plan(kind: 'check' | 'import', folder: string, files: string[], has: { proposals: boolean; book: boolean }, root = PIPELINE_ROOT): { label: string; args: string[] }[] {
  if (!FOLDER.test(folder)) throw new Error('bad folder name');
  for (const f of files) if (!CHAPTER_FILE.test(f)) throw new Error(`bad chapter file name ${f}`);
  const dir = join(root, folder);
  const staged = (f: string) => join(STAGE_DIR, folder, f);
  const dry = kind === 'check' ? ['--dry-run'] : [];
  const steps: { label: string; args: string[] }[] = [{ label: 'Stage the pipeline files (converted copies, git-ignored)', args: ['scripts/stage-pipeline.ts', dir] }];
  if (has.proposals) steps.push({ label: `Proposed catalogue items${kind === 'check' ? ' (dry run)' : ''}`, args: ['scripts/import-proposals.ts', join(dir, `${folder}.proposals.json`), ...dry] });
  if (has.book) steps.push({ label: `Book citations${kind === 'check' ? ' (dry run)' : ''}`, args: ['scripts/import-book.ts', join(dir, `${folder}.book.json`), ...dry] });
  for (const f of files) steps.push({ label: `Originality check · ${f} (on this Mac)`, args: ['scripts/check-originality.ts', staged(f)] });
  for (const f of files) steps.push({ label: `${kind === 'check' ? 'Validate' : 'Import'} · ${f}`, args: ['scripts/import-chapter.ts', kind === 'check' ? 'validate' : 'import', staged(f)] });
  if (kind === 'import') steps.push({ label: 'Figure images → local file store', args: ['scripts/import-figures.ts', dir] });
  return steps;
}

function runOne(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    execFile(process.execPath, ['--import', 'tsx', ...args], { cwd: REPO, env: { ...process.env }, maxBuffer: 20 * 1024 * 1024, timeout: 15 * 60 * 1000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      done({ code, output: `${stdout}${stderr ? `\n${stderr}` : ''}`.trim() });
    });
  });
}

/** Run a check or an import; stops at the first step that fails to start or exits with an error before the chapter steps. */
export async function run(kind: 'check' | 'import', folder: string, files: string[] | null): Promise<StepResult[]> {
  if (!isLocalTarget()) throw new Error('Local import runs against the local database only.');
  const f = listFolders().find((x) => x.folder === folder);
  if (!f) throw new Error(`No pipeline folder ${folder} in ${PIPELINE_ROOT}.`);
  const chosen = files?.length ? files : f.files.map((x) => x.name);
  for (const c of chosen) if (!f.files.some((x) => x.name === c)) throw new Error(`${c} is not in ${folder}.`);
  const out: StepResult[] = [];
  for (const s of plan(kind, folder, chosen, f)) {
    const r = await runOne(s.args);
    out.push({ label: s.label, command: `npx tsx ${s.args.join(' ').replaceAll(homedir(), '~').replaceAll(REPO + '/', '')}`, ...r });
    // staging, proposals and book citations must succeed before questions are checked or imported
    if (r.code !== 0 && /stage-pipeline|import-proposals|import-book/.test(s.args[0]!)) break;
  }
  return out;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** /api/local/… (the caller has already verified the local Access token). */
export async function handleLocal(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/^\/api\/local\/?/, '');
  if (path === 'status' && req.method === 'GET') return json(200, { local: true, root: PIPELINE_ROOT.replace(homedir(), '~'), database: isLocalTarget() ? 'local' : 'not local' });
  if (path === 'folders' && req.method === 'GET') return json(200, listFolders());
  if ((path === 'check' || path === 'import') && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { folder?: string; files?: string[] };
    if (!body.folder || !FOLDER.test(body.folder)) return json(400, { error: 'pick a pipeline folder' });
    try { return json(200, { steps: await run(path, body.folder, Array.isArray(body.files) ? body.files : null) }); } catch (e) { return json(400, { error: (e as Error).message }); }
  }
  return json(404, { error: 'not found' });
}

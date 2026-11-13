// Go-live runner (Sambit, 13 Nov 2026): builds the bank on a target database with the same import
// sequence that built the local bank. The target is CMS_DATABASE_URL (cms_owner only):
//   rehearsal: a restored copy of the real project's backup in the local container (database cms_rehearsal)
//   Step B   : the real project (npx tsx --env-file=.env.real scripts/golive.ts --go-live), only with Sambit's OK
//
//   npx tsx scripts/golive.ts [--go-live] [--from <step>] [--to <step>] [--list]
//
// Steps (in order):
//   1 migrate      migrations up to 0030 (0031 seeds the order from the topics, so it runs after the imports)
//   2 topics       import:topics from the ARCHIVED final workbooks (the real project is not cut over yet)
//   3 sources      import:sources from the same archived workbooks
//   4 ncert        each NCERT-C5-01…15 / C6-01…10 folder: stage (to .local-import/golive) → proposals → book
//                  citations → every-field originality check on this Mac (reused if a matching 1.2 report exists)
//                  → chapter import (a near-copy is let in as a draft only if override_requests.csv lists that
//                  question + field; Sambit, 13 Nov 2026). MC19-0001 is left out of NCERT-C6-07's MC19-C6.json: key_fixes.csv imports
//                  it as MC19-0039 in step 5 (as in the local bank, where the worked example held MC19-0001).
//   5 updates      import:updates from CMS-updates/ (settings, topic classes, key fix, near-copy rewrites
//                  batches 1–2, override requests → PENDING, levels, question settings)
//   6 sequence     migration 0031 (the per-class order, seeded from the Class View Seq)
//   7 cutover      curriculum:cutover --confirm
//   8 verify       db:verify
// Figures are not uploaded here: real R2 uploads go through wrangler under Sambit's login (see the runbook).
// Nothing book-derived leaves this Mac: the checks read the PDFs here and only citations and scores are stored.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPORT_SCHEMA } from '../shared/originality.ts';

const REPO = resolve(import.meta.dirname, '..');
const CR = join(homedir(), 'WitoScope', 'ContentResearch');
const QB = join(CR, 'QuestionBank');
const ARCHIVE = {
  math: join(CR, 'Math', '_archive', 'WitoScope_Math_Topics_Class1-6.final-before-cutover-2026-11-12.xlsx'),
  science: join(CR, 'Science', '_archive', 'WitoScope_Science_Topics_Class1-6.final-before-cutover-2026-11-12.xlsx'),
  english: join(CR, 'English', '_archive', 'WitoScope_English_Grammar_Topics_Class1-6.final-before-cutover-2026-11-12.xlsx'),
};
const OUT = join(REPO, '.local-import', 'golive');
const UPDATES = join(CR, 'CMS-updates');
const STEPS = ['migrate', 'topics', 'sources', 'ncert', 'updates', 'sequence', 'cutover', 'verify'] as const;
type Step = (typeof STEPS)[number];

const args = process.argv.slice(2);
const opt = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const goLive = args.includes('--go-live');
const target = process.env.CMS_DATABASE_URL ?? "";
if (!target) { console.error('Set CMS_DATABASE_URL (the rehearsal copy or, for Step B, --env-file=.env.real).'); process.exit(1); }
const host = new URL(target).hostname;
const local = host === '127.0.0.1' || host === 'localhost';
if (!local && !goLive) { console.error(`Target ${host} is not local: Step B needs --go-live (and Sambit's OK).`); process.exit(1); }
if (local && new URL(target).pathname === '/postgres') { console.error('Refusing to run on the local bank itself (database postgres); use the cms_rehearsal copy.'); process.exit(1); }
const from = STEPS.indexOf((opt('--from') ?? 'migrate') as Step), to = STEPS.indexOf((opt('--to') ?? 'verify') as Step);
if (from < 0 || to < 0) { console.error(`steps: ${STEPS.join(', ')}`); process.exit(1); }
const label = local ? 'rehearsal' : 'real';
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, `run-${label}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.log`);
const log = (s: string) => { process.stdout.write(s + '\n'); appendFileSync(LOG, s.replaceAll(target, '<target>') + '\n'); };

function run(title: string, script: string, a: string[], { allowFail = false } = {}) {
  log(`\n$ ${title}\n  npx tsx ${script} ${a.join(' ').replaceAll(homedir(), '~')}`);
  const r = spawnSync(process.execPath, ['--import', 'tsx', script, ...a], { cwd: REPO, env: process.env, encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
  const outp = `${r.stdout ?? ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
  appendFileSync(LOG, outp.replaceAll(target, '<target>') + `\n  → exit ${r.status}\n`);
  const tail = outp.split('\n').slice(-6).join('\n  ');
  process.stdout.write(`  ${tail}\n  → exit ${r.status}\n`);
  // 13 Nov 2026: a crash ALWAYS stops the run, allowFail or not: an exit code other than 0/1, a signal,
  // an uncaught error (stack trace) or an unsettled top-level await. allowFail only lets a content result through
  // (exit 1 = some questions blocked or a file failed its checks).
  const crashed = r.status === null || ![0, 1].includes(r.status) || /^\s+at .+:\d+:\d+\)?$/m.test(outp) || /unsettled top-level await/i.test(outp);
  if (crashed) throw new Error(`${title} CRASHED (exit ${r.status ?? r.signal}); the run stops here. See ${LOG}`);
  if (r.status !== 0 && !allowFail) throw new Error(`${title} failed (exit ${r.status}); see ${LOG}`);
  return { code: r.status ?? 1, out: outp };
}
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const reportOk = (file: string) => {
  const rp = file.replace(/\.json$/, '.originality.json');
  if (!existsSync(rp)) return false;
  try { const r = JSON.parse(readFileSync(rp, 'utf8')); return r.file_schema === REPORT_SCHEMA && r.chapter_file_sha256 === sha(file); } catch { return false; }
};

const steps: Record<Step, () => void> = {
  migrate: () => run('1 migrate (to 0030)', 'scripts/migrate.ts', ['--to', '0030_approval_needs_ready.sql']),
  topics: () => run('2 import:topics (archived final workbooks)', 'scripts/import-topics.ts', ['--math', ARCHIVE.math, '--science', ARCHIVE.science, '--english', ARCHIVE.english]),
  sources: () => run('3 import:sources (archived final workbooks)', 'scripts/import-sources.ts', ['--math', ARCHIVE.math, '--science', ARCHIVE.science, '--english', ARCHIVE.english]),
  ncert: () => {
    const folders = readdirSync(QB).filter((f) => /^NCERT-C[56]-\d{2}$/.test(f)).sort();
    log(`\n# 4 NCERT folders: ${folders.length} (stage all → proposals, two passes: patterns may use typical sets from another folder → book citations → check + import per folder)`);
    for (const f of folders) {
      run(`4 ${f} · stage`, 'scripts/stage-pipeline.ts', [join(QB, f), '--out', OUT]);
      // MC19-0001 → MC19-0039 comes from key_fixes.csv in step 5 (as in the local bank)
      const mc19 = join(OUT, f, 'MC19-C6.json');
      if (f === 'NCERT-C6-07' && existsSync(mc19)) {
        const d = JSON.parse(readFileSync(mc19, 'utf8'));
        const before = d.questions.length; d.questions = d.questions.filter((q: { key: string }) => q.key !== 'MC19-0001');
        if (d.questions.length !== before) { writeFileSync(mc19, JSON.stringify(d, null, 2) + '\n'); log('  MC19-C6.json: MC19-0001 left out (imported as MC19-0039 by key_fixes.csv in step 5)'); }
      }
    }
    const props = folders.filter((f) => existsSync(join(QB, f, `${f}.proposals.json`)));
    const failed = props.filter((f) => run(`4 ${f} · proposals (pass 1)`, 'scripts/import-proposals.ts', [join(QB, f, `${f}.proposals.json`)], { allowFail: true }).code !== 0);
    for (const f of failed) run(`4 ${f} · proposals (pass 2)`, 'scripts/import-proposals.ts', [join(QB, f, `${f}.proposals.json`)]);
    for (const f of folders) if (existsSync(join(QB, f, `${f}.book.json`))) run(`4 ${f} · book citations`, 'scripts/import-book.ts', [join(QB, f, `${f}.book.json`)]);
    for (const f of folders) {
      const files = readdirSync(join(OUT, f)).filter((n) => /^(MC|SC|GC)\d{2}-C\d\.json$/.test(n)).sort();
      for (const n of files) {
        const p = join(OUT, f, n);
        if (reportOk(p)) log(`  ${n}: originality report reused (${REPORT_SCHEMA}, same file)`);
        else run(`4 ${f} · originality ${n}`, 'scripts/check-originality.ts', [p]);
        // near-copies listed in CMS-updates/override_requests.csv (that question + field only) come in as drafts, blocked from approval
        run(`4 ${f} · import ${n}`, 'scripts/import-chapter.ts', ['import', p, '--override-requests', join(UPDATES, 'override_requests.csv')], { allowFail: true }); // a blocked question is not a failed run
      }
    }
  },
  updates: () => run('5 import:updates (CMS-updates)', 'scripts/import-updates.ts', [UPDATES, ...(local ? [] : ['--go-live'])], { allowFail: true }),
  sequence: () => run('6 migrate (0031 sequencing seed)', 'scripts/migrate.ts', []),
  cutover: () => run('7 curriculum:cutover --confirm (checks the archived workbooks the final import read)', 'scripts/curriculum-cutover.ts', ['--confirm', '--math', ARCHIVE.math, '--science', ARCHIVE.science, '--english', ARCHIVE.english]),
  verify: () => run('8 db:verify', 'scripts/db-verify.ts', [], { allowFail: true }),
};

if (args.includes('--list')) { STEPS.forEach((s, i) => console.log(`${i + 1} ${s}`)); process.exit(0); }
log(`Go-live runner · target ${label} (${host}${local ? new URL(target).pathname : ''}) · steps ${STEPS[from]}…${STEPS[to]} · ${new Date().toISOString()}`);
try { execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }); } catch { /* not a repo */ }
for (const s of STEPS.slice(from, to + 1)) steps[s]();
log(`\nDone. Log: ${LOG}`);

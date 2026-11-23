// Q38 PR 1: import a generation pack into the CMS (Science first). Plan: docs/plan-2026-11-23-q38-direct-generation.md §2.
//
//   npm run gen:import -- --pack <run>/generation-pack.json --review <review pack.xlsx>          pilot (default): only Approve / Rescue rows
//   npm run gen:import -- --pack … --mode steady                                                 steady state (needs gen_steady_state on in the CMS)
//   … --dry-run            everything in one transaction, rolled back (no figures uploaded)
//   … --batch 10           questions per batch (default: cms_config gen_batch_size)
//   Real project: npx tsx --env-file=.env.real scripts/gen-import.ts … --dry-run, then the same with --confirm-real.
//
// Safe to re-run: imported items with the same content are "unchanged"; an item imported earlier with different content
// is reported as "changed" and never touched (exit 1). A dropped connection retries the open batch once on a fresh one.
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertCmsOwner, connect, freshConnections, targetUrl } from './lib/db.ts';
import { LocalFigures, RealFigures } from './lib/gen-figures.ts';
import { packProblems, planItems, readReviewPack, runPackImport, type Mode, type Pack } from './lib/gen-pack.ts';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1]! : null; };
const home = (p: string) => resolve(p.replace(/^~/, homedir()));
const packArg = opt('--pack');
if (!packArg) { console.error('usage: npm run gen:import -- --pack <generation-pack.json> [--review <xlsx>] [--mode pilot|steady] [--dry-run] [--confirm-real] [--batch N]'); process.exit(1); }
const packPath = home(packArg);
const mode = (opt('--mode') ?? 'pilot') as Mode;
if (!['pilot', 'steady'].includes(mode)) { console.error('--mode is pilot or steady'); process.exit(1); }
const dryRun = args.includes('--dry-run');
const host = new URL(targetUrl()).hostname;
const target = host === '127.0.0.1' || host === 'localhost' ? 'local' as const : 'real' as const;

const pack = JSON.parse(readFileSync(packPath, 'utf8')) as Pack;
const problems = packProblems(pack, dirname(packPath));
console.log(`gen:import ${packPath.replace(homedir(), '~')} → ${target === 'local' ? 'the LOCAL database' : `the database at ${host}`} · mode ${mode}${dryRun ? ' (dry run)' : ''}`);
if (problems.length) { for (const p of problems) console.log(`  ✗ ${p}`); console.error(`Refused: ${problems.length} problem(s) in the pack.`); process.exit(1); }
const reviewPath = opt('--review');
if (mode === 'pilot' && !reviewPath && !pack.questions.some((q) => q.review?.decision)) {
  console.error('Refused: a pilot import takes only questions Sambit approved in the Mac review pack. Pass --review <review pack.xlsx>.'); process.exit(1);
}
const review = reviewPath ? await readReviewPack(home(reviewPath)) : null;
if (review) {
  const unknown = [...review.decisions.keys()].filter((k) => !pack.questions.some((q) => q.local_id === k));
  if (unknown.length) { console.error(`Refused: the review pack names ${unknown.length} slot(s) that are not in this pack (${unknown.slice(0, 5).join(', ')}). Wrong file?`); process.exit(1); }
}
const plan = planItems(pack, mode, review);
const tally = plan.reduce((m: Record<string, number>, p) => (m[p.drop?.status ?? 'to import'] = (m[p.drop?.status ?? 'to import'] ?? 0) + 1, m), {});
console.log(`plan: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(' · ')}`);
if (target === 'real' && !dryRun && !args.includes('--confirm-real')) { console.error('Refused: a real-project import needs a dry run first, then --confirm-real.'); process.exit(1); }

let gitCommit: string | null = null;
try { gitCommit = execSync('git rev-parse HEAD', { cwd: import.meta.dirname, encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }
const sql = connect();
try {
  await assertCmsOwner(sql);
  const [cfg] = await sql<{ n: number }[]>`select coalesce((select value::text::int from cms.cms_config where key = 'gen_batch_size'), 10) as n`;
  const batchSize = Number(opt('--batch') ?? cfg!.n);
  const r = await runPackImport({ packPath, pack, mode, review, dryRun, batchSize, gitCommit, log: (s) => console.log(s),
    runUnit: freshConnections({ log: (s) => console.log(s) }), figures: target === 'local' ? new LocalFigures() : new RealFigures(), dryRunSql: sql });
  console.log(`\n${r.run_code}${dryRun ? ' (dry run, rolled back)' : ''}: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(' · ')} · figures ${r.figures.uploaded} uploaded, ${r.figures.present} already there`);
  if (r.closed) console.log(`run status ${r.closed.status} · all passes: ${Object.entries(r.closed.items).map(([k, v]) => `${v} ${k}`).join(' · ')}`);
  for (const x of r.items.filter((i) => i.status === 'failed')) console.log(`  ✗ ${x.local_id}: ${x.error}`);
  for (const x of r.items.filter((i) => i.status === 'held')) console.log(`  held ${x.local_id}: ${x.reason}`);
  for (const id of r.changed) console.log(`  ! ${id}: imported earlier with different content; not touched (make a new run, or roll this one back)`);
  const dir = join(import.meta.dirname, '..', '.local-import'); mkdirSync(dir, { recursive: true });
  const out = join(dir, `gen-import-${r.run_code}-${target}${dryRun ? '-dry-run' : ''}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`);
  writeFileSync(out, JSON.stringify({ ...r, items: r.items.map(({ error, ...x }) => ({ ...x, error })) }, null, 2) + '\n');
  console.log(`\nReport (IDs and counts only): ${out}`);
  if (r.changed.length || r.items.some((i) => i.status === 'failed')) process.exitCode = 1;
} catch (e) {
  console.error(`gen:import failed: ${(e as Error).message}\nRe-run the same command to continue: imported questions are kept and skipped.`);
  process.exitCode = 1;
} finally {
  await sql.end();
}

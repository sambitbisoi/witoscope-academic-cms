// Q38 PR 1: import a generation pack into the CMS (Science first). Plan: docs/plan-2026-11-23-q38-direct-generation.md §2.
//
//   npm run gen:import -- --pack <run>/generation-pack.json --review <review pack.xlsx>          pilot (default): only Approve / Rescue rows
//   npm run gen:import -- --pack … --mode steady                                                 steady state (needs gen_steady_state on in the CMS)
//   … --dry-run            everything in one transaction, rolled back (no figures uploaded)
//   … --batch 10           questions per batch (default: cms_config gen_batch_size)
//   … --approve            pilot only (PR 1b, plan §2.7): then approve the imported questions marked Approve / Rescue in the
//                          review pack, through cms_set_status (every approval rule applies); blocked ones stay Needs review
//                          and are listed with the reason. Audit by_label "pack-approved <run>". Re-runs skip approved ones.
//   Real project: npx tsx --env-file=.env.real scripts/gen-import.ts … --dry-run, then the same with --confirm-real.
//
// Safe to re-run: imported items with the same content are "unchanged"; an item imported earlier with different content
// is reported as "changed" and never touched (exit 1). A dropped connection retries the open batch once on a fresh one.
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertRole, connect, freshConnections, takeLease, targetUrl, type Lease } from './lib/db.ts';
import { LocalFigures, RealFigures } from './lib/gen-figures.ts';
import { approvePlanProblem, packProblems, planItems, readReviewPack, runPackImport, type Mode, type Pack } from './lib/gen-pack.ts';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1]! : null; };
const home = (p: string) => resolve(p.replace(/^~/, homedir()));
const packArg = opt('--pack');
if (!packArg) { console.error('usage: npm run gen:import -- --pack <generation-pack.json> [--review <xlsx>] [--mode pilot|steady] [--dry-run] [--confirm-real] [--batch N] [--approve]'); process.exit(1); }
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
const reviewPath = opt('--review') ?? opt('--approved-only');   // --approved-only <review pack.xlsx> = the same
if (mode === 'pilot' && !reviewPath && !pack.questions.some((q) => q.review?.decision)) {
  console.error('Refused: a pilot import takes only questions Sambit approved in the Mac review pack. Pass --review <review pack.xlsx>.'); process.exit(1);
}
const review = reviewPath ? await readReviewPack(home(reviewPath)) : null;
const approve = args.includes('--approve');
if (approve) { const why = approvePlanProblem(mode, pack, review); if (why) { console.error(`Refused: ${why}.`); process.exit(1); } }
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
let lease: Lease | null = null;
try {
  // Q38 PR 2: cms_owner (as before) or cms_gen_writer (Route B: the generation functions only). --approve needs the admin path.
  const role = await assertRole(sql, ['cms_owner', 'cms_gen_writer']);
  if (approve && role !== 'cms_owner') throw new Error('--approve runs as cms_owner (approval is an admin action); cms_gen_writer can only import');
  const [cfg] = await sql<{ c: { batch_size: number } }[]>`select cms.cms_gen_config() as c`;
  const batchSize = Number(opt('--batch') ?? cfg!.c.batch_size);
  // one CMS writer at a time (plan §10): refused while someone else holds the work lease
  lease = await takeLease({ kind: 'gen_import', holder: `gen:import ${pack.run.source_run} (pid ${process.pid})`, note: `${mode}${dryRun ? ' dry run' : ''}` });
  const r = await runPackImport({ packPath, pack, mode, review, dryRun, batchSize, gitCommit, log: (s) => console.log(s),
    runUnit: freshConnections({ log: (s) => console.log(s) }), figures: target === 'local' ? new LocalFigures() : new RealFigures(), dryRunSql: sql, approve });
  console.log(`\n${r.run_code}${dryRun ? ' (dry run, rolled back)' : ''}: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(' · ')} · figures ${r.figures.uploaded} uploaded, ${r.figures.present} already there`);
  if (r.briefs.set + r.briefs.unchanged + r.briefs.skipped) console.log(`image briefs: ${r.briefs.set} set · ${r.briefs.unchanged} unchanged · ${r.briefs.skipped} skipped`);
  const u = r.setting_use;
  console.log(`settings (imported questions): ${u.existing} on ${u.existing_settings} existing SETs · ${u.new} on ${u.new_settings} new settings (Proposed) · ${u.bare} bare`
    + `${Object.keys(r.shared).length ? ` · shared with ${pack.run.subject}: ${Object.entries(r.shared).map(([k, v]) => `${k} (was ${v})`).join(', ')}` : ''}`);
  console.log(`topic–class links proposed: ${r.links_proposed.length ? r.links_proposed.join(', ') : 'none'}`);
  if (r.closed) console.log(`run status ${r.closed.status} · all passes: ${Object.entries(r.closed.items).map(([k, v]) => `${v} ${k}`).join(' · ')}`);
  if (r.approve) {
    const a = r.approve;
    console.log(`approve (by_label "pack-approved ${r.run_code}"): ${a.approved.length} approved · ${a.blocked.length} blocked (stay Needs review) · ${a.already.length} already approved`
      + `${a.not_imported.length ? ` · ${a.not_imported.length} marked Approve but not imported (see above)` : ''}`);
    for (const x of a.blocked) console.log(`  blocked ${x.question_id} (${x.local_id}): ${x.reason}`);
  }
  for (const x of r.items.filter((i) => i.status === 'failed')) console.log(`  ✗ ${x.local_id}: ${x.error}`);
  for (const x of r.items.filter((i) => i.status === 'held')) console.log(`  held ${x.local_id}: ${x.reason}`);
  for (const id of r.changed) console.log(`  ! ${id}: imported earlier with different content; not touched (make a new run, or roll this one back)`);
  const dir = join(import.meta.dirname, '..', '.local-import'); mkdirSync(dir, { recursive: true });
  const out = join(dir, `gen-import-${r.run_code}-${target}${dryRun ? '-dry-run' : ''}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`);
  writeFileSync(out, JSON.stringify({ ...r, items: r.items.map(({ error, ...x }) => ({ ...x, error })) }, null, 2) + '\n');
  console.log(`\nReport (IDs and counts only): ${out}`);
  if (r.changed.length || r.items.some((i) => i.status === 'failed')) process.exitCode = 1;
} catch (e) {
  const busy = (e as { code?: string }).code === '55P03' && !lease;
  console.error(busy ? `gen:import refused: ${(e as Error).message}\nNothing was written. Run it again once the other writer is done (npm run lease -- status).`
    : `gen:import failed: ${(e as Error).message}\nRe-run the same command to continue: imported questions are kept and skipped.`);
  process.exitCode = 1;
} finally {
  if (lease?.lost) { console.error('Warning: the work lease was lost during the import (heartbeat). Check the run with a re-run.'); process.exitCode = 1; }
  await lease?.release().catch((e: Error) => console.error(`Could not release the work lease: ${e.message}`));
  await sql.end();
}

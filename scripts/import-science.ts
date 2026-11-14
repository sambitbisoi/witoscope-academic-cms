// import:science (Sambit, 13 Nov 2026; docs/science-plan.md)
//
//   npm run import:science -- [<master.xlsx>] [--dry-run] [--override-requests <csv>]
//
// Reads the Science master (our own words; book pages as bare citations) and its originality report
// (made on this Mac by `npm run check:originality -- --science`), then upserts sources, content rows,
// citations, PROPOSED topic–class links and the questions, in one transaction. --dry-run rolls back.
// Default target: this repo's LOCAL database. The real project only with
// `npx tsx --env-file=.env.real scripts/import-science.ts … --dry-run` (and Sambit's OK before a real run).
// On the real project a near-copy content row is held out unless override_requests.csv lists it + field.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertCmsOwner, connect, targetUrl } from './lib/db.ts';
import { readMaster } from './lib/science-master.ts';
import { scienceReportPath, type ScienceReport } from './lib/science-originality.ts';
import { runScience, scienceOverrides, type ScienceResult } from './lib/science-import.ts';

export const DEFAULT_MASTER = join(homedir(), 'WitoScope', 'ContentResearch', 'Science', 'WitoScope_Science_Master.xlsx');
export const DEFAULT_OVERRIDES = join(homedir(), 'WitoScope', 'ContentResearch', 'Science', 'override_requests.csv');

export function printResult(r: ScienceResult) {
  const n = (x: { length: number } | number) => (typeof x === 'number' ? x : x.length);
  console.log(`\n${r.dry_run ? 'DRY RUN (rolled back) · ' : ''}target: ${r.target.toUpperCase()}${r.import_id ? ` · import #${r.import_id}${r.dry_run ? ' (not kept)' : ''}` : ''}`);
  console.log(`Sources:       ${r.sources.inserted} new · ${r.sources.updated} changed · ${r.sources.unchanged} unchanged`);
  console.log(`Content rows:  ${r.rows.inserted} new · ${r.rows.updated} changed · ${r.rows.unchanged} unchanged · ${r.rows.flagged_missing} flagged "not in master" · ${r.rows.back_in_master} back in master`);
  console.log(`               originality: ${Object.entries(r.originality.rows).map(([k, v]) => `${v} ${k.replace('_', '-')}`).join(' · ')}`);
  if (r.rows.near_copy_badged.length) console.log(`               imported with "Originality flagged" (local only): ${r.rows.near_copy_badged.join(', ')}`);
  if (r.rows.held_out.length) console.log(`               HELD OUT (near-copy, no override request): ${r.rows.held_out.join(', ')}`);
  if (r.rows.overridden.length) console.log(`               near-copy let in by override_requests.csv: ${r.rows.overridden.join(', ')}`);
  console.log(`Citations:     ${r.citations.rows} for content rows · ${r.citations.questions} for questions`);
  console.log(`Topic–class links PROPOSED (not active; approve in Proposed): ${r.proposals.length}${r.proposals.some((p) => !p.isNew) ? ` (${r.proposals.filter((p) => p.isNew).length} new)` : ''}`);
  for (const p of r.proposals) console.log(`  ${p.topic_id} ${p.name} · home class ${p.home_class} · row class ${p.row_class} · suggested role: from a ${p.role} class · ${p.rows} row${p.rows === 1 ? '' : 's'}`);
  console.log(`Questions:     ${n(r.questions.created)} new · ${n(r.questions.replaced)} drafts replaced · ${r.questions.unchanged} unchanged · ${n(r.questions.skipped)} skipped · ${n(r.questions.blocked)} blocked`);
  console.log(`               originality: ${Object.entries(r.originality.questions).map(([k, v]) => `${v} ${k.replace('_', '-')}`).join(' · ')}`);
  for (const s of r.questions.skipped) console.log(`  skipped ${s.qid}: ${s.why}`);
  for (const s of r.questions.blocked) console.log(`  BLOCKED ${s.qid}: ${s.why}`);
  if (r.questions.not_in_master.length) console.log(`  in the CMS but not in the master (kept): ${r.questions.not_in_master.join(', ')}`);
  console.log(`Links:         ${r.links.direct} direct · ${r.links.supporting} supporting`);
  if (r.status_mismatch.length) {
    console.log(`Row status differs from the sheet's "Question status" for ${r.status_mismatch.length} row(s):`);
    for (const m of r.status_mismatch.slice(0, 20)) console.log(`  ${m.row_id}: sheet ${m.sheet} · CMS ${m.cms}`);
  }
}

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1]! : null; };
  const path = resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--override-requests') ?? DEFAULT_MASTER);
  const dryRun = args.includes('--dry-run');
  const host = new URL(targetUrl()).hostname;
  const target = host === '127.0.0.1' || host === 'localhost' ? 'local' as const : 'real' as const;
  const ovPath = opt('--override-requests') ?? (existsSync(DEFAULT_OVERRIDES) ? DEFAULT_OVERRIDES : null);
  let overrides = new Map<string, string>();
  if (ovPath) {
    const o = scienceOverrides(readFileSync(resolve(ovPath), 'utf8'));
    if (o.problems.length) { console.error(`${ovPath}: ${o.problems.join('; ')}`); process.exit(1); }
    overrides = o.map;
  }
  console.log(`import:science ${path.replace(homedir(), '~')} → ${target === 'local' ? 'the LOCAL database' : `the database at ${host}`}${dryRun ? ' (dry run)' : ''}`);
  console.log(`override requests: ${ovPath ? `${ovPath.replace(homedir(), '~')} (${overrides.size})` : 'none'}`);
  if (target === 'real' && !dryRun && !args.includes('--confirm-real')) { console.error('Refused: a real-project import needs Sambit\'s OK on a dry run first, then --confirm-real.'); process.exit(1); }
  const master = await readMaster(path);
  for (const p of master.problems) console.log(`  ${p.level === 'error' ? '✗' : '!'} ${p.where}: ${p.message}`);
  const repPath = scienceReportPath(path);
  const report = existsSync(repPath) ? JSON.parse(readFileSync(repPath, 'utf8')) as ScienceReport : null;
  const sql = connect();
  try {
    await assertCmsOwner(sql);
    const r = await runScience(sql, master, report, { dryRun, target, overrides });
    printResult(r);
    const dir = join(import.meta.dirname, '..', '.local-import'); mkdirSync(dir, { recursive: true });
    const out = join(dir, `science-import-${target}${dryRun ? '-dry-run' : ''}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`);
    writeFileSync(out, JSON.stringify(r, null, 2) + '\n');
    console.log(`\nReport (IDs, counts and citations only): ${out}`);
  } catch (e) {
    console.error(`import:science failed: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

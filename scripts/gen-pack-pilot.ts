// Q38 PR 1: make the generation pack of a Science PILOT04-style run folder (Mac only; our own content only).
//   npm run gen:pack-pilot -- ~/WitoScope/ContentResearch/Science/generation/runs/PILOT04 [--out <file>]
// Writes <run>/generation-pack.json and lists any problem; nothing touches the database.
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pilotToPack } from './lib/gen-adapters/science-pilot04.ts';
import { packProblems } from './lib/gen-pack.ts';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) { console.error('usage: npm run gen:pack-pilot -- <run folder> [--out <file>]'); process.exit(1); }
const runDir = resolve(dir.replace(/^~/, homedir()));
const out = args.includes('--out') ? resolve(args[args.indexOf('--out') + 1]!) : join(runDir, 'generation-pack.json');
const { pack, problems } = pilotToPack(runDir);
// file paths in a pack are relative to the pack itself
const rel = (f: string) => relative(dirname(out), join(runDir, f));
if (dirname(out) !== runDir) {
  for (const q of pack.questions) if (q.figure) q.figure = { ...q.figure, file: rel(q.figure.file), svg: q.figure.svg ? rel(q.figure.svg) : null };
  if (pack.originality?.report_file) pack.originality.report_file = rel(pack.originality.report_file);
}
writeFileSync(out, JSON.stringify(pack, null, 1) + '\n');
const all = [...problems, ...packProblems(pack, dirname(out))];
const q = pack.questions;
console.log(`${out.replace(homedir(), '~')}: run ${pack.run.source_run} · ${q.length} questions (${q.filter((x) => x.passed).length} passed checks) · `
  + `${pack.catalogue_new?.settings?.length ?? 0} new settings · ${q.filter((x) => x.figure).length} figures · cost $${pack.run.cost_usd}`);
for (const p of all) console.log(`  ✗ ${p}`);
console.log(all.length ? `\n${all.length} problem(s): fix them in the run before importing.`
  : '\nNo problems. Next: npm run gen:import -- --pack <file> --review <review pack xlsx>   (pilot: only Approve rows are imported)');
process.exitCode = all.length ? 1 : 0;

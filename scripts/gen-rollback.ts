// Q38 PR 1: roll back a generation run. Retires (never deletes) the run's questions that were never approved or edited,
// discards its open held-out items and retires the new settings nothing else uses. Approved or edited questions are kept
// and listed. Audited (by_label gen:<run>).
//   npm run gen:rollback -- --run GR0001 --reason "…"            (real: npx tsx --env-file=.env.real scripts/gen-rollback.ts … --confirm-real)
import { assertCmsOwner, connect, takeLease, targetUrl, type Lease } from './lib/db.ts';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null; };
const run = opt('--run'), reason = opt('--reason');
if (!run || !reason) { console.error('usage: npm run gen:rollback -- --run GR0001 --reason "…" [--confirm-real]'); process.exit(1); }
const host = new URL(targetUrl()).hostname;
const real = !(host === '127.0.0.1' || host === 'localhost');
if (real && !args.includes('--confirm-real')) { console.error(`Refused: rolling back ${run} on the real project needs --confirm-real.`); process.exit(1); }
const sql = connect();
let lease: Lease | null = null;
try {
  await assertCmsOwner(sql);
  lease = await takeLease({ kind: 'script', holder: `gen:rollback ${run} (pid ${process.pid})`, note: reason });   // Q38 PR 2: one writer at a time
  const [r] = await sql<{ r: { retired: string[]; kept: { question_id: string; why: string }[]; held_discarded: number; settings_retired: string[]; settings_unshared: number; links_retired: number } }[]>`
    select cms.cms_gen_rollback(${sql.json({ run_code: run, reason } as never)}) as r`;
  console.log(`${run} rolled back on ${real ? host : 'the LOCAL database'}: ${r!.r.retired.length} questions retired · ${r!.r.held_discarded} held-out items discarded · `
    + `${r!.r.settings_retired.length} new settings retired · ${r!.r.settings_unshared} shared settings given back · ${r!.r.links_retired} proposed links retired · ${r!.r.kept.length} kept (approved or edited)`);
  for (const k of r!.r.kept) console.log(`  kept ${k.question_id} (${k.why})`);
} catch (e) {
  console.error(`gen:rollback failed: ${(e as Error).message}`); process.exitCode = 1;
} finally {
  await lease?.release().catch(() => {});
  await sql.end();
}

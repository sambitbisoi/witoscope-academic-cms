// Images PR (DL-040; Sambit, 24 Nov 2026): attach the structured image briefs a Science run wrote (image_briefs.json,
// file_schema image-briefs/1) to the questions that run imported. Matched by the run's local IDs only; written through
// cms_gen_set_briefs (open versions only, audited, idempotent). The brief text becomes figure_description.
//   npm run images:briefs -- <run folder>/image_briefs.json [--run GR0013] [--dry-run]
//   Real: npx tsx --env-file=.env.real scripts/images-briefs.ts … --dry-run, then --confirm-real
// The CMS run is the live run whose source_run is the folder name (C3B01), unless --run names it.
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { assertCmsOwner, connect, freshConnections, targetUrl } from './lib/db.ts';
import { briefProblem, inferLayout, type ImageBrief } from '../shared/image-brief.ts';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? null : null; };
const file = args.find((a) => !a.startsWith('--') && a !== opt('--run'));
if (!file) { console.error('usage: npm run images:briefs -- <image_briefs.json> [--run GR0013] [--dry-run] [--confirm-real]'); process.exit(1); }
const path = resolve(file.replace(/^~/, homedir()));
const dryRun = args.includes('--dry-run');
const host = new URL(targetUrl()).hostname;
const real = !(host === '127.0.0.1' || host === 'localhost');
if (real && !dryRun && !args.includes('--confirm-real')) { console.error('Refused: on the real project run --dry-run first, then --confirm-real.'); process.exit(1); }

type Raw = { local_id: string; shown: string; style?: string | null; must_not_show?: string | null; layout?: ImageBrief['layout']; labels?: ImageBrief['labels']; passed?: boolean };
const doc = JSON.parse(readFileSync(path, 'utf8')) as { file_schema?: string; briefs?: Raw[] };
if (doc.file_schema !== 'image-briefs/1' || !Array.isArray(doc.briefs)) { console.error(`Refused: ${path} is not an image-briefs/1 file.`); process.exit(1); }
let inferred = 0;
const briefs = doc.briefs.map((b) => {
  const brief: ImageBrief = { shown: b.shown, style: b.style ?? null, must_not_show: b.must_not_show ?? null, labels: (b.labels ?? []).map((l) => ({ label: l.label, points_to: l.points_to })) };
  // the Science session writes layout on every brief (Q2); reading "shown" is only the fallback, and it is counted
  if (b.layout) brief.layout = b.layout; else { brief.layout = inferLayout(brief); inferred++; }
  return { local_id: b.local_id, brief, problem: briefProblem(brief) };
});
const bad = briefs.filter((b) => b.problem);
for (const b of bad) console.log(`  ✗ ${b.local_id}: ${b.problem}`);
if (bad.length) { console.error(`Refused: ${bad.length} brief(s) are not valid.`); process.exit(1); }

const sql = connect();
try {
  await assertCmsOwner(sql);
  const runCode = opt('--run') ?? (await sql<{ run_code: string }[]>`select run_code from cms.cms_generation_runs
    where source_run = ${basename(dirname(path))} and status not in ('rolled_back') order by run_id desc limit 1`)[0]?.run_code;
  if (!runCode) throw new Error(`no CMS run for ${basename(dirname(path))}; pass --run GR####`);
  console.log(`images:briefs ${path.replace(homedir(), '~')} → ${runCode} on ${real ? host : 'the LOCAL database'}${dryRun ? ' (dry run)' : ''} · ${briefs.length} briefs${inferred ? ` · layout inferred for ${inferred}` : ''}`);
  const tot = { set: 0, unchanged: 0, skipped: [] as { local_id: string; why: string }[] };
  const unit = freshConnections();
  for (let i = 0; i < briefs.length; i += 25) {
    const chunk = briefs.slice(i, i + 25).map(({ local_id, brief }) => ({ local_id, brief }));
    const r = await unit(`briefs ${i / 25 + 1}`, async (s) => {
      let out: { set: number; unchanged: number; skipped: { local_id: string; why: string }[] } | null = null;
      await s.begin(async (tx) => {
        out = (await tx`select cms.cms_gen_set_briefs(${tx.json({ run_code: runCode, briefs: chunk } as never)}) as r`)[0]!.r as never;
        if (dryRun) throw Object.assign(new Error('dry run'), { dry: true });
      }).catch((e) => { if (!(e as { dry?: boolean }).dry) throw e; });
      return out!;
    });
    tot.set += r.set; tot.unchanged += r.unchanged; tot.skipped.push(...r.skipped);
  }
  console.log(`${runCode}${dryRun ? ' (dry run, rolled back)' : ''}: ${tot.set} set · ${tot.unchanged} unchanged · ${tot.skipped.length} skipped`);
  for (const s of tot.skipped) console.log(`  skipped ${s.local_id}: ${s.why}`);
} catch (e) {
  console.error(`images:briefs failed: ${(e as Error).message}`); process.exitCode = 1;
} finally {
  await sql.end();
}

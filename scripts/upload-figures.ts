// Go-live (Sambit, 13 Nov 2026): our own figure images → the real R2 bucket `cms-sources`, under figures/ only.
//
//   npx tsx --env-file=.env.real scripts/upload-figures.ts            list what would be uploaded (default)
//   npx tsx --env-file=.env.real scripts/upload-figures.ts --run      upload with wrangler under Sambit's Cloudflare login
//   … --run --from figures/MC34-0016.png                             resume at that key (keys are uploaded in sorted order)
// A failed upload (e.g. a network blip) is retried once after 5 s; a second failure stops with the key to resume from.
//   … --verify                                                         fetch every referenced figure back from R2 (6 at a time)
//                                                                      and compare size and sha256 with the local file
//
// Uploads exactly the figures the target database's questions reference (image_path), from the local R2
// stand-in .r2-local/cms-sources/ where the importers stored them. Refuses any key outside figures/ and
// anything that is not a PNG we drew (never PDFs, book snapshots or source_images/). Each upload is
// `npx wrangler r2 object put cms-sources/<key> --file … --content-type image/png --remote` (Phase 4, P17).
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertCmsOwner, connect } from './lib/db.ts';

const REPO = resolve(import.meta.dirname, '..');
const LOCAL = join(REPO, '.r2-local', 'cms-sources');
const KEY = /^figures\/[A-Za-z0-9._-]+\.png$/;
const runIt = process.argv.includes('--run');
const fromKey = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : null;

const sql = connect();
try {
  await assertCmsOwner(sql);
  const rows = await sql<{ image_path: string }[]>`
    select distinct v.image_path from cms.cms_question_versions v where v.image_path is not null order by 1`;
  const bad = rows.filter((r) => !KEY.test(r.image_path));
  const missing = rows.filter((r) => KEY.test(r.image_path) && !existsSync(join(LOCAL, r.image_path)));
  const ok = rows.filter((r) => KEY.test(r.image_path) && existsSync(join(LOCAL, r.image_path)));
  const mb = ok.reduce((n, r) => n + statSync(join(LOCAL, r.image_path)).size, 0) / 1e6;
  console.log(`${rows.length} figure keys referenced · ${ok.length} found locally (${mb.toFixed(1)} MB) · ${missing.length} missing · ${bad.length} refused (not figures/*.png)`);
  for (const r of bad) console.log(`  ✗ refused: ${r.image_path}`);
  for (const r of missing.slice(0, 30)) console.log(`  ! not in .r2-local: ${r.image_path}`);
  if (process.argv.includes('--verify')) {
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const get = (key: string) => new Promise<Buffer | null>((res) => execFile('npx', ['wrangler', 'r2', 'object', 'get', `cms-sources/${key}`, '--remote', '--pipe'],
      { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 }, (err, out) => res(err ? null : out as Buffer)));
    const bad: string[] = []; let good = 0, i = 0;
    const worker = async () => { while (i < ok.length) { const key = ok[i++]!.image_path; let b = await get(key); if (!b) b = await get(key);
      const local = readFileSync(join(LOCAL, key)); if (b && b.length === local.length && sha(b) === sha(local)) good++; else bad.push(`${key} (${b ? `${b.length} B, local ${local.length} B` : 'not found'})`); } };
    await Promise.all(Array.from({ length: 6 }, worker));
    console.log(`Verified in R2: ${good} of ${ok.length} identical to the local file (size and sha256) · ${bad.length} missing or different`);
    for (const x of bad.slice(0, 50)) console.log(`  ✗ ${x}`);
    process.exitCode = bad.length ? 1 : 0;
    process.exit();
  }
  if (!runIt) { console.log('\nList only. Add --run to upload them with wrangler (Cloudflare login needed).'); process.exit(0); }
  if (bad.length) throw new Error('Refusing to upload: some keys are outside figures/.');
  if (fromKey && !ok.some((r) => r.image_path === fromKey)) throw new Error(`--from ${fromKey}: not one of the referenced figure keys.`);
  const todo = fromKey ? ok.filter((r) => r.image_path >= fromKey) : ok;
  if (fromKey) console.log(`Resuming at ${fromKey}: ${todo.length} of ${ok.length} left.`);
  const put = (key: string) => execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `cms-sources/${key}`, '--file', join(LOCAL, key), '--content-type', 'image/png', '--remote'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let n = 0;
  for (const r of todo) {
    try { put(r.image_path); } catch {
      console.log(`  ! ${r.image_path}: upload failed; retrying once in 5 s`);
      await new Promise((res) => setTimeout(res, 5000));
      try { put(r.image_path); } catch (e) {
        console.log(`Stopped: ${r.image_path} failed twice (${String((e as Error).message).split('\n')[0]}). ${n} uploaded in this run. Resume with: --run --from ${r.image_path}`);
        process.exitCode = 1; break;
      }
    }
    if (++n % 50 === 0) console.log(`  ${n} / ${todo.length}`);
  }
  if (!process.exitCode) console.log(`Uploaded ${n} figures to cms-sources/figures/.`);
} finally {
  await sql.end();
}

// Go-live (Sambit, 13 Nov 2026): our own figure images → the real R2 bucket `cms-sources`, under figures/ only.
//
//   npx tsx --env-file=.env.real scripts/upload-figures.ts            list what would be uploaded (default)
//   npx tsx --env-file=.env.real scripts/upload-figures.ts --run      upload with wrangler under Sambit's Cloudflare login
//
// Uploads exactly the figures the target database's questions reference (image_path), from the local R2
// stand-in .r2-local/cms-sources/ where the importers stored them. Refuses any key outside figures/ and
// anything that is not a PNG we drew (never PDFs, book snapshots or source_images/). Each upload is
// `npx wrangler r2 object put cms-sources/<key> --file … --content-type image/png --remote` (Phase 4, P17).
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertCmsOwner, connect } from './lib/db.ts';

const REPO = resolve(import.meta.dirname, '..');
const LOCAL = join(REPO, '.r2-local', 'cms-sources');
const KEY = /^figures\/[A-Za-z0-9._-]+\.png$/;
const runIt = process.argv.includes('--run');

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
  if (!runIt) { console.log('\nList only. Add --run to upload them with wrangler (Cloudflare login needed).'); process.exit(0); }
  if (bad.length) throw new Error('Refusing to upload: some keys are outside figures/.');
  let n = 0;
  for (const r of ok) {
    execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `cms-sources/${r.image_path}`, '--file', join(LOCAL, r.image_path), '--content-type', 'image/png', '--remote'], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (++n % 50 === 0) console.log(`  ${n} / ${ok.length}`);
  }
  console.log(`Uploaded ${n} figures to cms-sources/figures/.`);
} finally {
  await sql.end();
}

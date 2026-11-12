// npm run import:figures -- <QuestionBank/NCERT-C6-01> [more folders…] [--dry-run]
//
// LOCAL ONLY. Copies our own figure images (the PNGs in the folder's images/) into the local
// R2 stand-in (.r2-local/cms-sources, served by npm run dev:files) under the same keys the
// staged chapter files use and R2 will use later: figures/<file key>.png. Reads only
// images/; never source_images/ (book snapshots) or anything else. The real bucket is
// reached only through the /api/files Pages Function, not by this script.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { assertCmsOwner, connect, targetUrl } from './lib/db.ts';
import { FolderBucket } from './lib/r2-local.ts';
import { STAGE_DIR } from './stage-pipeline.ts';
import { KEY_RE, PUT_PREFIX } from '../functions/_lib/files.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dirs = args.filter((a) => !a.startsWith('--'));
if (!dirs.length) { console.error('usage: npm run import:figures -- <pipeline folder> [more…] [--dry-run]'); process.exit(1); }
const host = new URL(targetUrl()).hostname;
if (host !== '127.0.0.1' && host !== 'localhost') { console.error('import:figures is local only; the real R2 bucket is filled through /api/files.'); process.exit(1); }

const bucket = new FolderBucket();
const sql = connect();
let failed = false;
try {
  await assertCmsOwner(sql);
  for (const d of dirs) {
    const dir = resolve(d);
    const folder = basename(dir);
    const imagesDir = join(dir, 'images');
    const staged = join(STAGE_DIR, folder);
    if (!existsSync(staged)) { console.error(`${folder}: not staged; run npm run stage:pipeline first`); failed = true; continue; }
    const keys = new Set<string>();
    for (const f of readdirSync(staged).filter((n) => /^(MC|SC|GC)\d{2}-C\d\.json$/.test(n))) {
      for (const q of JSON.parse(readFileSync(join(staged, f), 'utf8')).questions ?? []) if (q.figure?.image_file) keys.add(q.figure.image_file);
    }
    const counts = { stored: 0, unchanged: 0, missing: 0, refused: 0, not_used: 0 };
    const problems: string[] = [];
    for (const key of [...keys].sort()) {
      if (!key.startsWith(PUT_PREFIX) || !KEY_RE.test(key) || !/\.png$/i.test(key)) { counts.refused++; problems.push(`${key}: not a figures/…png key`); continue; }
      const src = join(imagesDir, basename(key));
      if (!existsSync(src)) { counts.missing++; problems.push(`${key}: ${basename(key)} not in images/`); continue; }
      const body = readFileSync(src);
      const had = bucket.has(key);
      const prev = had ? (await bucket.get(key))!.body : null;
      if (prev && Buffer.from(prev).equals(body)) { counts.unchanged++; continue; }
      if (!dryRun) await bucket.put(key, new Uint8Array(body), { httpMetadata: { contentType: 'image/png' } });
      counts.stored++;
    }
    const pngs = readdirSync(imagesDir).filter((n) => /\.png$/i.test(n));
    counts.not_used = pngs.filter((n) => !keys.has(`${PUT_PREFIX}${n}`)).length;
    if (!dryRun) {
      await sql`insert into cms.cms_imports (kind, file_path, file_hash, options, finished_at, result, counts, error_report)
        values ('figures', ${imagesDir.replace(homedir(), '~')}, ${createHash('sha256').update([...keys].sort().join('\n')).digest('hex')},
                ${sql.json({ target: 'local R2 stand-in (.r2-local/cms-sources)' })}, now(), ${problems.length ? 'partial' : 'ok'}, ${sql.json(counts)}, ${sql.json(problems)})`;
    }
    console.log(`${folder}: ${counts.stored} stored${dryRun ? ' (dry run)' : ''} · ${counts.unchanged} unchanged · ${counts.missing} missing · ${counts.refused} refused · ${counts.not_used} PNG(s) in images/ not used by any question`);
    for (const p of problems) console.log(`  ! ${p}`);
    if (counts.missing || counts.refused) failed = true;
  }
} finally {
  await sql.end();
}
process.exitCode = failed ? 1 : 0;

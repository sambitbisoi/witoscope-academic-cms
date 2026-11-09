// npm run upload:sources [-- --dry-run] [--only NCERT-fegp101,…]          (local stack)
// npx tsx --env-file=.env.real scripts/upload-sources.ts [--dry-run]     (real project)
//
// Uploads the local PDF of every registered source that has one on this Mac into
// the private bucket cms-sources/<source_id>/<file name>, then records storage_path.
// The upload runs AS THE ADMIN through the Storage API (bootstrap 02's policies
// apply); the storage_path update runs as cms_owner with an audit row.
// Real project: sign-in from CMS_VERIFY_EMAIL / CMS_VERIFY_PASSWORD (shell only),
// URL and anon key from VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env.real.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { assertCmsOwner, connect, targetUrl } from './lib/db.ts';
import { envApi, localApi, signIn, signInOrUp, type Api, type Session } from './lib/supabase-session.ts';
import { LOCAL_ADMIN } from './verify-uid.ts';

const MAX = 50 * 1024 * 1024; // bucket limit (bootstrap 02)
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1]!.split(',')) : null;
const isLocal = ['127.0.0.1', 'localhost'].includes(new URL(targetUrl()).hostname);

/** stem (lower case) → path, for every PDF under ContentResearch */
function indexPdfs(dir: string, out = new Map<string, string>()): Map<string, string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) indexPdfs(p, out);
    else if (/\.pdf$/i.test(e.name)) out.set(e.name.replace(/\.pdf$/i, '').toLowerCase(), p);
  }
  return out;
}

const files = indexPdfs(join(homedir(), 'WitoScope', 'ContentResearch'));
const sql = connect();
try {
  await assertCmsOwner(sql);
  const sources = await sql<{ source_id: string; storage_path: string | null }[]>`
    select source_id, storage_path from cms.cms_sources where kind in ('pdf', 'scanned_pdf') order by source_id`;
  const todo = sources
    .filter((s) => !only || only.has(s.source_id))
    .map((s) => ({ ...s, file: files.get(s.source_id.replace(/^[A-Z]+-/, '').toLowerCase()) }))
    .filter((s) => s.file);
  const already = todo.filter((s) => s.storage_path);
  const pending = todo.filter((s) => !s.storage_path);
  const tooBig = pending.filter((s) => statSync(s.file!).size > MAX);
  const ok = pending.filter((s) => statSync(s.file!).size <= MAX);
  const mb = ok.reduce((n, s) => n + statSync(s.file!).size, 0) / 1048576;
  console.log(`${isLocal ? 'LOCAL' : 'REAL PROJECT'}: ${sources.length} PDF sources · ${todo.length} have a file on this Mac · ${already.length} already uploaded · ${ok.length} to upload (${mb.toFixed(1)} MB)${tooBig.length ? ` · ${tooBig.length} over 50 MB (split per chapter first)` : ''}`);
  for (const s of tooBig) console.log(`  ✗ ${s.source_id}: ${(statSync(s.file!).size / 1048576).toFixed(1)} MB > 50 MB`);
  if (dryRun || ok.length === 0) process.exit(0);

  let api: Api, admin: Session;
  if (isLocal) { api = localApi(); admin = await signInOrUp(api, LOCAL_ADMIN.email, LOCAL_ADMIN.password); }
  else {
    const email = process.env.CMS_VERIFY_EMAIL, password = process.env.CMS_VERIFY_PASSWORD;
    if (!email || !password) throw new Error('Set CMS_VERIFY_EMAIL and CMS_VERIFY_PASSWORD in your shell (read -s for the password).');
    api = envApi(); admin = await signIn(api, email, password);
  }

  let done = 0;
  for (const s of ok) {
    const path = `${s.source_id}/${basename(s.file!)}`;
    const r = await fetch(`${api.url}/storage/v1/object/cms-sources/${path}`, {
      method: 'POST', body: readFileSync(s.file!),
      headers: { apikey: api.anonKey, authorization: `Bearer ${admin.accessToken}`, 'content-type': 'application/pdf', 'x-upsert': 'true' },
    });
    if (!r.ok) { console.log(`  ✗ ${s.source_id}: upload refused (${r.status}) ${(await r.text()).slice(0, 160)}`); continue; }
    await sql.begin(async (tx) => {
      await tx`update cms.cms_sources set storage_path = ${path} where source_id = ${s.source_id}`;
      await tx`insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, reason)
               values ('catalogue', 'cms_sources', ${s.source_id}, 'edit_catalogue', ${tx.json({ storage_path: { before: null, after: path } })},
                       'upload script', 'PDF uploaded to cms-sources')`;
    });
    done++;
    if (done % 10 === 0) console.log(`  … ${done}/${ok.length}`);
  }
  console.log(`uploaded ${done}/${ok.length}`);
} finally {
  await sql.end();
}

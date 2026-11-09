// Upload source PDFs into the private R2 bucket cms-sources and record each file's
// R2 key in cms_sources.storage_path (Supabase keeps only text and metadata).
//
//   npm run upload:sources [-- --dry-run] [--class 6] [--subject math] [--only NCERT-fegp101,…] [--reupload]
//       local dev: writes into the R2 stand-in (.r2-local/cms-sources)
//   npx tsx --env-file=.env.real scripts/upload-sources.ts --class 6 --subject math [--dry-run]
//       real project: uploads with `wrangler r2 object put --remote` under YOUR Cloudflare
//       login (run `npx wrangler@4.151.2 login` once); no R2 keys in the repo or on disk.
// Key: <source_id>/<file name>, e.g. NCERT-fegp101/fegp101.pdf. Files over 50 MB are refused.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { MAX_BYTES } from '../functions/_lib/files.ts';
import { assertCmsOwner, connect, targetUrl } from './lib/db.ts';
import { FolderBucket } from './lib/r2-local.ts';

const WRANGLER = 'wrangler@4.151.2';
const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = args.includes('--dry-run');
const reupload = args.includes('--reupload');
const only = opt('--only') ? new Set(opt('--only')!.split(',')) : null;
const cls = opt('--class') ? Number(opt('--class')) : null;
const subject = opt('--subject') ?? null;
const isLocal = ['127.0.0.1', 'localhost'].includes(new URL(targetUrl()).hostname);
if (subject && !['math', 'science', 'grammar'].includes(subject)) throw new Error('--subject must be math, science or grammar');

function indexPdfs(dir: string, out = new Map<string, string>()): Map<string, string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) indexPdfs(p, out);
    else if (/\.pdf$/i.test(e.name)) out.set(e.name.replace(/\.pdf$/i, '').toLowerCase(), p);
  }
  return out;
}

const files = indexPdfs(join(homedir(), 'WitoScope', 'ContentResearch'));
const bucket = new FolderBucket();
const sql = connect();
try {
  await assertCmsOwner(sql);
  const sources = await sql<{ source_id: string; storage_path: string | null; class: number | null; subjects: string[] }[]>`
    select s.source_id, s.storage_path, s.class,
           coalesce(array_agg(distinct c.subject) filter (where c.subject is not null), '{}') as subjects
    from cms.cms_sources s
    left join cms.cms_source_chapters sc on sc.source_id = s.source_id
    left join cms.cms_chapters c on c.chapter_id = sc.chapter_id
    where s.kind in ('pdf', 'scanned_pdf')
    group by s.source_id order by s.source_id`;
  const picked = sources
    .filter((s) => (!only || only.has(s.source_id)) && (cls === null || s.class === cls) && (!subject || s.subjects.includes(subject)))
    .map((s) => ({ ...s, file: files.get(s.source_id.replace(/^[A-Z]+-/, '').toLowerCase()) }))
    .filter((s) => s.file);
  const todo = picked.filter((s) => reupload || !s.storage_path);
  const tooBig = todo.filter((s) => statSync(s.file!).size > MAX_BYTES);
  const ok = todo.filter((s) => statSync(s.file!).size <= MAX_BYTES);
  const mb = ok.reduce((n, s) => n + statSync(s.file!).size, 0) / 1048576;
  const scope = [cls !== null && `class ${cls}`, subject, only && `${only.size} named`].filter(Boolean).join(', ') || 'all';
  console.log(`${isLocal ? 'LOCAL (R2 stand-in)' : 'REAL PROJECT (R2 via wrangler)'} · scope: ${scope} · ${picked.length} sources with a file on this Mac · ${picked.length - todo.length} already uploaded · ${ok.length} to upload (${mb.toFixed(1)} MB)${tooBig.length ? ` · ${tooBig.length} over 50 MB` : ''}`);
  for (const s of ok) console.log(`  ${s.source_id} ← ${s.file!.replace(homedir(), '~')} (${(statSync(s.file!).size / 1048576).toFixed(1)} MB)`);
  for (const s of tooBig) console.log(`  ✗ ${s.source_id}: ${(statSync(s.file!).size / 1048576).toFixed(1)} MB > 50 MB — split it per chapter first`);
  if (dryRun || ok.length === 0) process.exit(0);

  let done = 0;
  for (const s of ok) {
    const key = `${s.source_id}/${basename(s.file!)}`;
    try {
      if (isLocal) await bucket.put(key, readFileSync(s.file!), { httpMetadata: { contentType: 'application/pdf' } });
      else execFileSync('npx', ['--yes', WRANGLER, 'r2', 'object', 'put', `cms-sources/${key}`, '--file', s.file!, '--content-type', 'application/pdf', '--remote'], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      console.log(`  ✗ ${s.source_id}: upload failed — ${String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim().split('\n').pop()}`);
      continue;
    }
    if (s.storage_path !== key) {
      await sql.begin(async (tx) => {
        await tx`update cms.cms_sources set storage_path = ${key} where source_id = ${s.source_id}`;
        await tx`insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, reason)
                 values ('catalogue', 'cms_sources', ${s.source_id}, 'edit_catalogue', ${tx.json({ storage_path: { before: s.storage_path, after: key } })},
                         'upload script', ${isLocal ? 'PDF copied to the local R2 stand-in' : 'PDF uploaded to R2 cms-sources'})`;
      });
    }
    done++;
    if (done % 10 === 0) console.log(`  … ${done}/${ok.length}`);
  }
  console.log(`uploaded ${done}/${ok.length}`);
} finally {
  await sql.end();
}

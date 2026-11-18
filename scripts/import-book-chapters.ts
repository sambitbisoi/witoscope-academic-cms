// import:book-chapters (Q13, 18 Nov 2026): load the NCERT / DAV chapter numbers and titles (bare citations) into the
// read-only reference table cms_ref_book_chapters. Idempotent: upsert by (book, class, subject, chapter number); a
// second run changes 0 rows. Rows no longer in the file are reported, never deleted.
//
//   npm run import:book-chapters -- --file ~/WitoScope/ContentResearch/Books_NCERT_DAV_Chapter_Map_Class1-6.xlsx [--dry-run]
//
// Default target: the LOCAL database; real only with `npx tsx --env-file=.env.real scripts/import-book-chapters.ts … --confirm-real`.
import { resolve } from 'node:path';
import { assertCmsOwner, connect, targetUrl } from './lib/db.ts';
import { normaliseBookChapters } from './lib/book-chapters.ts';
import { diffFingerprints, fingerprint, maxId } from './lib/fingerprint.ts';
import { readWorkbook } from './lib/xlsx.ts';

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
if (!opt('--file')) { console.error('usage: npm run import:book-chapters -- --file <Books_NCERT_DAV_Chapter_Map_Class1-6.xlsx> [--dry-run] [--confirm-real]'); process.exit(1); }
const path = resolve(opt('--file')!.replace(/^~/, process.env.HOME ?? '~'));
const dryRun = args.includes('--dry-run');
const u = new URL(targetUrl());
const target = u.hostname === '127.0.0.1' || u.hostname === 'localhost' ? (u.pathname === '/cms_rehearsal' ? 'rehearsal' : 'local') : 'real';
if (target === 'real' && !dryRun && !args.includes('--confirm-real')) { console.error('Real project: add --confirm-real (after a rehearsal and a dry run).'); process.exit(1); }

const wb = await readWorkbook(path);
const { chapters, problems, notes } = normaliseBookChapters(wb.sheets);
const by = (book: string, subject: string) => chapters.filter((c) => c.book === book && c.subject === subject).length;
console.log(`import:book-chapters → ${target.toUpperCase()}${dryRun ? ' (dry run)' : ''} · ${chapters.length} chapters (NCERT math ${by('NCERT', 'math')} · science ${by('NCERT', 'science')} · DAV math ${by('DAV', 'math')} · science ${by('DAV', 'science')})`);
for (const n of notes) console.log(`  i ${n}`);
if (problems.length) { for (const p of problems) console.error(`  ✗ ${p}`); console.error(`${problems.length} problem(s): nothing loaded.`); process.exit(2); }

const sql = connect();
await assertCmsOwner(sql);
const upTo = { cms_reviews: { col: 'review_id', max: await maxId(sql, 'cms_reviews', 'review_id') }, cms_imports: { col: 'import_id', max: await maxId(sql, 'cms_imports', 'import_id') } };
const before = await fingerprint(sql, { upTo });
class DryRun extends Error {}
try {
  await sql.begin(async (tx) => {
    const [imp] = await tx`insert into cms.cms_imports (kind, file_path, file_hash, options)
      values ('book_chapters', ${path.replace(/^\/Users\/[^/]+/, '~')}, ${wb.sha256}, ${tx.json({ dry_run: dryRun } as never)}) returning import_id`;
    const importId = Number(imp!.import_id);
    const rows = await tx`
      with f as (select * from jsonb_to_recordset(${tx.json(chapters as never)}) x(book text, book_title text, class int, subject text, ch_no int, ch_name text)),
      up as (
        insert into cms.cms_ref_book_chapters (book, book_title, class, subject, ch_no, ch_name, import_id)
          select book, book_title, class, subject, ch_no, ch_name, ${importId} from f
        on conflict (book, class, subject, ch_no) do update
          set book_title = excluded.book_title, ch_name = excluded.ch_name, import_id = excluded.import_id, updated_at = now()
          where (cms_ref_book_chapters.book_title, cms_ref_book_chapters.ch_name) is distinct from (excluded.book_title, excluded.ch_name)
        returning (xmax = 0) as inserted)
      select count(*) filter (where inserted)::int as added, count(*) filter (where not inserted)::int as changed from up`;
    const [gone] = await tx`select count(*)::int as n from cms.cms_ref_book_chapters r
      where not exists (select 1 from jsonb_to_recordset(${tx.json(chapters as never)}) x(book text, class int, subject text, ch_no int)
                         where x.book = r.book and x.class = r.class and x.subject = r.subject and x.ch_no = r.ch_no)`;
    const counts = { in_file: chapters.length, added: rows[0]!.added, changed: rows[0]!.changed, not_in_file: gone!.n };
    await tx`update cms.cms_imports set finished_at = now(), result = 'ok', counts = ${tx.json(counts as never)} where import_id = ${importId}`;
    console.log(`import #${importId}${dryRun ? ' (rolled back)' : ''}: ${counts.added} added · ${counts.changed} changed · ${counts.in_file - counts.added - counts.changed} unchanged · ${counts.not_in_file} in the table but not in the file (kept)`);
    if (dryRun) throw new DryRun();
  });
} catch (e) { if (!(e instanceof DryRun)) { console.error(`import:book-chapters failed: ${(e as Error).message}`); process.exitCode = 1; } }
const diff = diffFingerprints(before, await fingerprint(sql, { upTo }), ['cms_ref_book_chapters']);
console.log(`fingerprint (all cms tables but cms_ref_book_chapters; reviews/imports up to before): ${diff.length ? `CHANGED: ${diff.join('; ')}` : 'unchanged'}`);
if (diff.length) process.exitCode = 3;
await sql.end();

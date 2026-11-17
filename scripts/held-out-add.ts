// held-out:add (Q21, Sambit 17 Nov 2026): put questions of a chapter file into the Held-out area by hand (e.g. the MC58
// backfill of 16 Nov). Only items blocked for a placement / catalogue reason are accepted; the local originality check
// runs first on this Mac and only its result is stored (scores + citations). A near-copy is refused (it stays on the Mac).
//
//   npm run held-out:add -- --file <chapter.json> --keys K1,K2 --batch "<label>" [--proposals <file.proposals.json>] [--dry-run]
//
// Default target: the LOCAL database; real only with `npx tsx --env-file=.env.real scripts/held-out-add.ts … --confirm-real`.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { checkFile } from '../shared/checks.ts';
import type { ChapterFile } from '../shared/types.ts';
import { checkChapterFile } from './check-originality.ts';
import { loadCatalog } from './import-chapter.ts';
import { assertCmsOwner, connect, targetUrl } from './lib/db.ts';
import { diffFingerprints, fingerprint, maxId } from './lib/fingerprint.ts';
import { heldCatalogue, inCmsSets, insertHeld, originalityFor, placementReason, recommendTopic, type ProposalsLike } from './lib/held-out.ts';

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const path = resolve(opt('--file') ?? '');
const keys = (opt('--keys') ?? '').split(',').map((k) => k.trim()).filter(Boolean);
const batch = opt('--batch');
const dryRun = args.includes('--dry-run');
if (!opt('--file') || !keys.length || !batch) { console.error('usage: npm run held-out:add -- --file <chapter.json> --keys K1,K2 --batch "<label>" [--proposals <file>] [--dry-run]'); process.exit(1); }
const host = new URL(targetUrl()).hostname;
const target = host === '127.0.0.1' || host === 'localhost' ? (new URL(targetUrl()).pathname === '/cms_rehearsal' ? 'rehearsal' : 'local') : 'real';
if (target === 'real' && !dryRun && !args.includes('--confirm-real')) { console.error('Real project: add --confirm-real (after a rehearsal and a dry run).'); process.exit(1); }
const raw = readFileSync(path);
const file = JSON.parse(raw.toString('utf8')) as ChapterFile;
const props = opt('--proposals') ? JSON.parse(readFileSync(resolve(opt('--proposals')!), 'utf8')) as ProposalsLike : undefined;
const qs = keys.map((k) => file.questions.find((q) => q.key === k) ?? (() => { throw new Error(`${k} is not in ${basename(path)}`); })());

const sql = connect();
await assertCmsOwner(sql);
console.log(`held-out:add → ${target.toUpperCase()}${dryRun ? ' (dry run)' : ''} · ${basename(path)} · ${keys.join(', ')}`);
const orig = await checkChapterFile(sql, path);   // reads the book PDFs on this Mac; only the result is kept
// guard: only cms_held_out and NEW review / import rows may change
const upTo = { cms_reviews: { col: 'review_id', max: await maxId(sql, 'cms_reviews', 'review_id') }, cms_imports: { col: 'import_id', max: await maxId(sql, 'cms_imports', 'import_id') } };
const before = await fingerprint(sql, { upTo });
class DryRun extends Error {}
try {
  await sql.begin(async (tx) => {
    const cat = await loadCatalog(tx, file);
    const problems = checkFile({ ...file, questions: qs }, cat);
    const [imp] = await tx`insert into cms.cms_imports (kind, file_path, file_hash, chapter_id, options)
      values ('held_out', ${path.replace(/^\/Users\/[^/]+/, '~')}, ${createHash('sha256').update(raw).digest('hex')}, ${file.chapter_id},
              ${tx.json({ keys, batch, dry_run: dryRun } as never)}) returning import_id`;
    const importId = Number(imp!.import_id);
    const sets = await inCmsSets(tx);
    const done: string[] = [];
    for (const q of qs) {
      const why = placementReason(problems, q.key);
      if (!why) throw new Error(`${q.key}: not held for a placement reason (${problems.filter((p) => p.key === q.key && p.level === 'error').map((p) => p.message).join('; ') || 'it has no error: import it instead'})`);
      const [lv] = await tx`select level from cms.cms_questions where file_key = ${q.key}`;
      const level = (lv?.level as number | undefined) ?? file.class;   // [inferred] Level = the book class, as the C1+C2 import set it
      const catalogue = heldCatalogue(q, file, sets, props);
      const h = await insertHeld(tx, { subject: file.subject, batch: batch!, import_id: importId, file: basename(path), chapter_id: file.chapter_id, file_key: q.key,
        class: file.class, level, reason_code: why.code, reason: why.reason, recommended_topic_id: await recommendTopic(tx, q, file, why.code), question: q, catalogue,
        proposed_by: opt('--proposals') ? basename(opt('--proposals')!).replace(/\.proposals\.json$/, '') : null, originality: originalityFor(orig, q.key) }, 'held-out:add (Sambit, CMS build session)');
      const o = orig.questions.find((x) => x.key === q.key);
      console.log(`  ${q.key}: ${h.new ? `held #${h.held_id}` : `already held (#${h.held_id})`} · ${why.code} · Level ${level} · catalogue ${catalogue.concepts.length} concept(s), ${catalogue.typical_sets.length} set(s), ${catalogue.patterns.length} pattern(s), ${catalogue.misconceptions.length} misconception(s) · originality ${o?.result ?? 'not checked'}${o?.similarity != null ? ` ${o.similarity}` : ''}`);
      done.push(q.key);
    }
    await tx`update cms.cms_imports set finished_at = now(), result = 'ok', counts = ${tx.json({ held: done.length } as never)} where import_id = ${importId}`;
    console.log(`import #${importId}${dryRun ? ' (rolled back)' : ''}: ${done.length} held`);
    if (dryRun) throw new DryRun();
  });
} catch (e) { if (!(e instanceof DryRun)) { console.error(`held-out:add failed: ${(e as Error).message}`); process.exitCode = 1; } }
const diff = diffFingerprints(before, await fingerprint(sql, { upTo }), ['cms_held_out']);
console.log(`fingerprint (all cms tables but cms_held_out; reviews/imports up to before): ${diff.length ? `CHANGED: ${diff.join('; ')}` : 'unchanged'}`);
if (diff.length) process.exitCode = 3;
await sql.end();

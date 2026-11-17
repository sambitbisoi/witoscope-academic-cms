// tier:recompute (Q20, Sambit 17 Nov 2026): rewrite stored tiers that disagree with "Tier uses Level".
//
//   npm run tier:recompute -- [--preview | --dry-run] [--batch 20] [--expect <preview.json>] [--reason Q24] [--confirm-real]
//
// Default target: this repo's LOCAL database (or CMS_DATABASE_URL, e.g. the cms_rehearsal copy). The real project only with
// `npx tsx --env-file=.env.real scripts/tier-recompute.ts … --confirm-real`.
//   --expect  the planned list (question_id, version_no, before, after): any difference stops the run before writing.
//   --dry-run one rolled-back transaction with the before/after fingerprint of every cms table (only `tier`,
//             new review rows and the new import row may change).
// Real run: fingerprint → one import row → batches, each its own transaction on a fresh connection (retried once;
// a dropped session is ended first) → fingerprint again → nothing left to change. Idempotent: re-running changes 0.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { assertCmsOwner, connect, freshConnections, targetUrl } from './lib/db.ts';
import { diffFingerprints, fingerprint, maxId } from './lib/fingerprint.ts';
import { applyTierChanges, tierChanges, type TierChange } from './lib/tier.ts';

const argv = process.argv.slice(2);
// --reason "Q24": the tier change follows concept:first-taught (concept classes changed), not a Level change.
const reasonArg = argv.includes('--reason') ? argv[argv.indexOf('--reason') + 1] : null;
const REASON = reasonArg === 'Q24' ? 'Tier recomputed after concept class = first taught in (Q24, Sambit 17 Nov 2026)'
  : reasonArg ? reasonArg : 'Tier uses Level (Q20, Sambit 17 Nov 2026)';
const BY = 'tier recompute (Sambit, CMS build session)';
const key = (c: { question_id: string; version_no: number; before: string; after: string }) => `${c.question_id} v${c.version_no}: ${c.before} → ${c.after}`;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const previewOnly = args.includes('--preview');   // read-only: list + compare with --expect, no transaction (safe on real)
const batch = Number(args[args.indexOf('--batch') + 1] || 20) || 20;
const expectPath = args.includes('--expect') ? args[args.indexOf('--expect') + 1] : null;
const url = targetUrl();
const host = new URL(url).hostname;
const target = host === '127.0.0.1' || host === 'localhost' ? (new URL(url).pathname === '/cms_rehearsal' ? 'rehearsal' : 'local') : 'real';
if (target === 'real' && !dryRun && !previewOnly && !args.includes('--confirm-real')) { console.error('Real project: add --confirm-real (after the rehearsal and a real --dry-run).'); process.exit(1); }

const sql = connect(url);
await assertCmsOwner(sql);
const changes = await tierChanges(sql);
console.log(`target: ${target.toUpperCase()} · ${changes.length} version(s) to change${dryRun ? ' (dry run)' : ''}`);
if (expectPath) {
  const want = (JSON.parse(readFileSync(expectPath, 'utf8')) as TierChange[]).map(key).sort();
  const got = changes.map(key).sort();
  const missing = want.filter((x) => !got.includes(x)), extra = got.filter((x) => !want.includes(x));
  if (missing.length || extra.length) {
    console.error(`STOP: the changes differ from ${expectPath}\n  planned but not found (${missing.length}): ${missing.slice(0, 20).join(' | ')}\n  found but not planned (${extra.length}): ${extra.slice(0, 20).join(' | ')}`);
    await sql.end(); process.exit(2);
  }
  console.log(`  = the planned list (${want.length})`);
}
const summary = summarise(changes);
if (previewOnly) { console.log(JSON.stringify(summary, null, 1)); await sql.end(); process.exit(0); }
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(4, 15).replace('T', '-');
mkdirSync('.local-import', { recursive: true });
const base = `.local-import/tier-recompute-${target}${dryRun ? '-dry-run' : ''}-2026-${stamp}`;
let result: Record<string, unknown> = { target, dry_run: dryRun, changes: changes.length, summary };

const ROW_TABLES_THAT_GROW = ['cms_reviews', 'cms_imports'];
if (dryRun) {
  class Rollback extends Error {}
  await sql.begin(async (tx) => {
    const upTo = { cms_reviews: { col: 'review_id', max: await maxId(tx, 'cms_reviews', 'review_id') }, cms_imports: { col: 'import_id', max: await maxId(tx, 'cms_imports', 'import_id') } };
    const fpOpts = { exclude: { cms_question_versions: ['tier'] }, upTo };
    const before = await fingerprint(tx, fpOpts);
    const n = await applyTierChanges(tx, changes, { importId: null, reason: REASON, by: BY });
    const left = await tierChanges(tx);
    const after = await fingerprint(tx, fpOpts);
    const diff = diffFingerprints(before, after);
    const [aud] = await tx`select count(*)::int as n from cms.cms_reviews where review_id > ${upTo.cms_reviews.max} and action = 'derived_update'`;
    result = { ...result, written: n, left: left.length, fingerprint_diff: diff, audit_rows: aud!.n };
    console.log(`  written ${n} · audit rows ${aud!.n} · left to change ${left.length} · fingerprint (all but tier, new reviews/imports): ${diff.length ? `CHANGED: ${diff.join('; ')}` : 'unchanged'}`);
    throw new Rollback();
  }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
} else if (changes.length) {
  const upTo = { cms_reviews: { col: 'review_id', max: await maxId(sql, 'cms_reviews', 'review_id') }, cms_imports: { col: 'import_id', max: await maxId(sql, 'cms_imports', 'import_id') } };
  const fpOpts = { exclude: { cms_question_versions: ['tier'] }, upTo };
  const before = await fingerprint(sql, fpOpts);
  const [imp] = await sql`insert into cms.cms_imports (kind, file_path, file_hash, options, counts)
    values ('tier_recompute', ${reasonArg === 'Q24' ? 'tier:recompute (Q24)' : 'tier:recompute (Q20)'}, md5(${changes.map(key).join('\n')}), ${sql.json({ batch, expect: expectPath } as never)}, ${sql.json({ planned: changes.length } as never)})
    returning import_id`;
  const importId = Number(imp!.import_id);
  const unit = freshConnections({ url });
  let written = 0;
  for (let i = 0; i < changes.length; i += batch) {
    const part = changes.slice(i, i + batch);
    written += await unit(`batch ${i / batch + 1}`, (s) => s.begin((tx) => applyTierChanges(tx, part, { importId, reason: REASON, by: BY })) as Promise<number>);
    console.log(`  batch ${i / batch + 1}: ${Math.min(i + batch, changes.length)}/${changes.length}`);
  }
  // Round 2: the final checks run on a fresh connection (the pooler dropped the long-lived one on real, 17 Nov 2026)
  const fin = connect(url);
  const left = await tierChanges(fin);
  const after = await fingerprint(fin, fpOpts);
  const diff = diffFingerprints(before, after);
  await fin`update cms.cms_imports set finished_at = now(), result = ${left.length || diff.length ? 'partial' : 'ok'},
    counts = ${sql.json({ planned: changes.length, written, left: left.length, ...summary } as never)} where import_id = ${importId}`;
  await fin.end();
  result = { ...result, import_id: importId, written, left: left.length, fingerprint_diff: diff };
  console.log(`  import #${importId}: written ${written} · left ${left.length} · fingerprint: ${diff.length ? `CHANGED: ${diff.join('; ')}` : 'unchanged'}`);
}
writeFileSync(`${base}.json`, JSON.stringify({ ...result, list: changes }, null, 1));
writeFileSync(`${base}.md`, report(result, changes));
console.log(`report: ${base}.md`);
await sql.end();
if ((result.fingerprint_diff as string[] | undefined)?.length || (result.left as number | undefined)) process.exit(3);

function summarise(cs: TierChange[]) {
  const by: Record<string, number> = {};
  for (const c of cs) { const k = `C${c.placement} L${c.level ?? '–'} ${c.before} → ${c.after}`; by[k] = (by[k] ?? 0) + 1; }
  return { to_super_achiever: cs.filter((c) => c.after === 'Super Achiever').length, from_super_achiever: cs.filter((c) => c.before === 'Super Achiever').length,
    approved: cs.filter((c) => c.status === 'approved').length, gold: cs.filter((c) => c.bank === 'gold').length, by };
}
function report(r: Record<string, unknown>, cs: TierChange[]) {
  const s = r.summary as ReturnType<typeof summarise>;
  return [`# tier:recompute · ${String(r.target)}${r.dry_run ? ' (dry run, rolled back)' : ''}`, '',
    `${cs.length} version(s): → Super Achiever ${s.to_super_achiever} · from Super Achiever ${s.from_super_achiever} · approved ${s.approved} · gold ${s.gold}`, '',
    '| Placement · Level · change | n |', '|---|---|', ...Object.entries(s.by).sort().map(([k, n]) => `| ${k} | ${n} |`), '',
    `Fingerprint: ${(r.fingerprint_diff as string[] | undefined)?.length ? (r.fingerprint_diff as string[]).join('; ') : 'unchanged (all but tier)'}`, '',
    '| Question | v | Status | Placement | Level | Strategy | Highest concept class | Before | After |', '|---|---|---|---|---|---|---|---|---|',
    ...cs.map((c) => `| ${c.question_id} | ${c.version_no} | ${c.status} | ${c.placement} | ${c.level ?? '—'} | ${c.strategy ?? '—'} | ${c.max_concept_class ?? '—'} | ${c.before} | ${c.after} |`), ''].join('\n');
}

// concept:first-taught (Q24, Sambit 17 Nov 2026): a concept's class = "first taught in" (lower only).
//
//   npm run concept:first-taught -- [--preview | --dry-run] [--batch 25] [--expect <list.json>] [--confirm-real] [--as-written]
//
// Rule (scripts/lib/concept-class.ts): class = min(catalogued class, lowest Level of the book-derived questions that test
// it). The catalogued class is kept in class_legacy. Re-run it after every Math import (docs/sambit-checklist.md), then
// `npm run tier:recompute -- --reason "Q24"`: tiers use concept classes, so they must be recomputed right after.
// Between the two steps db:verify's tier check fails by design.
//
// Default target: this repo's LOCAL database (or CMS_DATABASE_URL, e.g. the cms_rehearsal copy). The real project only with
// `npx tsx --env-file=.env.real scripts/concept-first-taught.ts … --confirm-real`.
//   --preview    read-only: the list and the tier changes it would cause (classes passed as an override); no writes, safe on real
//   --dry-run    one rolled-back transaction: write, fingerprint every cms table (only the class columns and new reviews
//                may change), then the tier changes that would follow
//   --expect     the planned list (concept_id, before, after): any difference stops the run before writing
//   --as-written report only: the rule as first written (the class may also go up). Never writes
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { assertCmsOwner, connect, freshConnections, targetUrl } from './lib/db.ts';
import { applyConceptClassChanges, conceptClassChanges, type ConceptClassChange } from './lib/concept-class.ts';
import { diffFingerprints, fingerprint, maxId } from './lib/fingerprint.ts';
import { tierChanges, type TierChange } from './lib/tier.ts';

const REASON = 'Concept class = first taught in (Q24, Sambit 17 Nov 2026)';
const BY = 'concept first-taught (Sambit, CMS build session)';
const key = (c: { concept_id: string; before: number; after: number }) => `${c.concept_id}: ${c.before} → ${c.after}`;
const CLASS_COLS = ['class', 'class_legacy', 'class_basis', 'class_basis_at', 'updated_at'];

const args = process.argv.slice(2);
const asWritten = args.includes('--as-written');
const dryRun = args.includes('--dry-run');
const previewOnly = args.includes('--preview') || asWritten;
const batch = Number(args[args.indexOf('--batch') + 1] || 25) || 25;
const expectPath = args.includes('--expect') ? args[args.indexOf('--expect') + 1] : null;
const url = targetUrl();
const host = new URL(url).hostname;
const target = host === '127.0.0.1' || host === 'localhost' ? (new URL(url).pathname === '/cms_rehearsal' ? 'rehearsal' : 'local') : 'real';
if (target === 'real' && !dryRun && !previewOnly && !args.includes('--confirm-real')) { console.error('Real project: add --confirm-real (after the rehearsal and a real --dry-run).'); process.exit(1); }

const sql = connect(url);
await assertCmsOwner(sql);
const changes = await conceptClassChanges(sql, { lowerOnly: !asWritten });
console.log(`target: ${target.toUpperCase()} · ${changes.length} concept(s) to change${asWritten ? ' (rule as first written, report only)' : ''}${dryRun ? ' (dry run)' : ''}`);
if (expectPath) {
  const want = (JSON.parse(readFileSync(expectPath, 'utf8')) as { list: ConceptClassChange[] }).list.map(key).sort();
  const got = changes.map(key).sort();
  const missing = want.filter((x) => !got.includes(x)), extra = got.filter((x) => !want.includes(x));
  if (missing.length || extra.length) {
    console.error(`STOP: the changes differ from ${expectPath}\n  planned but not found (${missing.length}): ${missing.slice(0, 20).join(' | ')}\n  found but not planned (${extra.length}): ${extra.slice(0, 20).join(' | ')}`);
    await sql.end(); process.exit(2);
  }
  console.log(`  = the planned list (${want.length})`);
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(4, 15).replace('T', '-');
mkdirSync('.local-import', { recursive: true });
const base = `.local-import/concept-first-taught-${target}${asWritten ? '-as-written' : previewOnly ? '-preview' : dryRun ? '-dry-run' : ''}-2026-${stamp}`;
let result: Record<string, unknown> = { target, dry_run: dryRun, preview: previewOnly, as_written: asWritten, changes: changes.length, summary: summarise(changes) };
let tiers: TierChange[] = [];

class Rollback extends Error {}
if (previewOnly) {
  // Read-only (no transaction, safe on real): the tiers are judged with the new classes as an override.
  tiers = await tierChanges(sql, undefined, new Map(changes.map((c) => [c.concept_id, c.after])));
  result = { ...result, tier_changes_after: tiers.length, tier_summary: tierSummary(tiers) };
  console.log(`  tier changes that follow (tier:recompute): ${tiers.length} · ${JSON.stringify(tierSummary(tiers).by_bank)}`);
} else if (dryRun) {
  await sql.begin(async (tx) => {
    const upTo = { cms_reviews: { col: 'review_id', max: await maxId(tx, 'cms_reviews', 'review_id') }, cms_imports: { col: 'import_id', max: await maxId(tx, 'cms_imports', 'import_id') } };
    const fpOpts = { exclude: { cms_concepts: CLASS_COLS }, upTo };
    const before = await fingerprint(tx, fpOpts);
    const n = await applyConceptClassChanges(tx, changes, { importId: null, reason: REASON, by: BY });
    tiers = await tierChanges(tx);
    const left = await conceptClassChanges(tx);
    const diff = diffFingerprints(before, await fingerprint(tx, fpOpts));
    const [aud] = await tx`select count(*)::int as n from cms.cms_reviews where review_id > ${upTo.cms_reviews.max} and action = 'derived_update'`;
    result = { ...result, written: n, left: left.length, fingerprint_diff: diff, audit_rows: aud!.n, tier_changes_after: tiers.length, tier_summary: tierSummary(tiers) };
    console.log(`  written ${n} · audit rows ${aud!.n} · left ${left.length} · fingerprint (all but the class columns, new reviews/imports): ${diff.length ? `CHANGED: ${diff.join('; ')}` : 'unchanged'}`);
    console.log(`  tier changes that follow (tier:recompute): ${tiers.length} · ${JSON.stringify(tierSummary(tiers).by_bank)}`);
    throw new Rollback();
  }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
} else if (changes.length) {
  const upTo = { cms_reviews: { col: 'review_id', max: await maxId(sql, 'cms_reviews', 'review_id') }, cms_imports: { col: 'import_id', max: await maxId(sql, 'cms_imports', 'import_id') } };
  const fpOpts = { exclude: { cms_concepts: CLASS_COLS }, upTo };
  const before = await fingerprint(sql, fpOpts);
  const [imp] = await sql`insert into cms.cms_imports (kind, file_path, file_hash, options, counts)
    values ('concept_class', 'concept:first-taught (Q24)', md5(${changes.map(key).join('\n')}), ${sql.json({ batch, expect: expectPath, lower_only: true } as never)}, ${sql.json({ planned: changes.length } as never)})
    returning import_id`;
  const importId = Number(imp!.import_id);
  const unit = freshConnections({ url });
  let written = 0;
  for (let i = 0; i < changes.length; i += batch) {
    const part = changes.slice(i, i + batch);
    written += await unit(`batch ${i / batch + 1}`, (s) => s.begin((tx) => applyConceptClassChanges(tx, part, { importId, reason: REASON, by: BY })) as Promise<number>);
    console.log(`  batch ${i / batch + 1}: ${Math.min(i + batch, changes.length)}/${changes.length}`);
  }
  // Round 2: the final checks run on a fresh connection (the pooler dropped the long-lived one on real, 17 Nov 2026)
  const fin = connect(url);
  const left = await conceptClassChanges(fin);
  const diff = diffFingerprints(before, await fingerprint(fin, fpOpts));
  tiers = await tierChanges(fin);
  await fin`update cms.cms_imports set finished_at = now(), result = ${left.length || diff.length ? 'partial' : 'ok'},
    counts = ${sql.json({ planned: changes.length, written, left: left.length, tier_changes_to_follow: tiers.length } as never)} where import_id = ${importId}`;
  await fin.end();
  result = { ...result, import_id: importId, written, left: left.length, fingerprint_diff: diff, tier_changes_after: tiers.length, tier_summary: tierSummary(tiers) };
  console.log(`  import #${importId}: written ${written} · left ${left.length} · fingerprint: ${diff.length ? `CHANGED: ${diff.join('; ')}` : 'unchanged'}`);
  console.log(`  next: npm run tier:recompute -- --reason "Q24" (${tiers.length} version(s) to change)`);
}
writeFileSync(`${base}.json`, JSON.stringify({ ...result, list: changes, tiers }, null, 1));
writeFileSync(`${base}.md`, report(result, changes, tiers));
console.log(`report: ${base}.md`);
await sql.end();
if ((result.fingerprint_diff as string[] | undefined)?.length || (!previewOnly && (result.left as number | undefined))) process.exit(3);

function summarise(cs: ConceptClassChange[]) {
  const by: Record<string, number> = {};
  for (const c of cs) { const k = `${c.before} → ${c.after}`; by[k] = (by[k] ?? 0) + 1; }
  return { up: cs.filter((c) => c.after > c.before).length, down: cs.filter((c) => c.after < c.before).length, by };
}
function tierSummary(ts: TierChange[]) {
  const by_bank: Record<string, number> = {}, by: Record<string, number> = {};
  for (const t of ts) {
    by_bank[t.bank] = (by_bank[t.bank] ?? 0) + 1;
    const k = `${t.bank} C${t.placement} ${t.before} → ${t.after}`; by[k] = (by[k] ?? 0) + 1;
  }
  return { by_bank, by };
}
function report(r: Record<string, unknown>, cs: ConceptClassChange[], ts: TierChange[]) {
  const s = r.summary as ReturnType<typeof summarise>;
  const t = tierSummary(ts);
  return [`# concept:first-taught · ${String(r.target)}${r.as_written ? ' (rule as first written: report only)' : r.dry_run ? ' (dry run, rolled back)' : r.preview ? ' (preview, rolled back)' : ''}`, '',
    `${cs.length} concept(s): up ${s.up} · down ${s.down}`, '',
    '| Old → new class | n |', '|---|---|', ...Object.entries(s.by).sort().map(([k, n]) => `| ${k} | ${n} |`), '',
    `Fingerprint: ${(r.fingerprint_diff as string[] | undefined)?.length ? (r.fingerprint_diff as string[]).join('; ') : r.dry_run || !r.preview ? 'unchanged (all but the class columns)' : 'not taken (preview)'}`, '',
    `## Tier changes that follow (${ts.length})`, '', '| Bank · placement · change | n |', '|---|---|', ...Object.entries(t.by).sort().map(([k, n]) => `| ${k} | ${n} |`), '',
    '| Question | v | Bank | Placement | Level | Strategy | Highest concept class | Before | After |', '|---|---|---|---|---|---|---|---|---|',
    ...ts.map((x) => `| ${x.question_id} | ${x.version_no} | ${x.bank} | ${x.placement} | ${x.level ?? '—'} | ${x.strategy ?? '—'} | ${x.max_concept_class ?? '—'} | ${x.before} | ${x.after} |`), '',
    '## Concepts', '', '| Concept | Name | Status | Catalogued | Before | After | Book questions |', '|---|---|---|---|---|---|---|',
    ...cs.map((c) => `| ${c.concept_id} | ${c.name.replace(/\|/g, '/')} | ${c.status} | ${c.catalogued} | ${c.before} | ${c.after} | ${c.book_questions} |`), ''].join('\n');
}

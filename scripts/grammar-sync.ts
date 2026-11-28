// English (Grammar) E1: Q41 curriculum sync from the Grammar sheet. Plan docs/plan-2026-11-28-english-grammar.md §2.
//
//   npm run grammar:sync -- --sheet ~/WitoScope/ContentResearch/English/WitoScope_English_Grammar_2026-11-28.xlsx
//                            [--mapping docs/grammar/new-id-mapping-2026-11-28.csv] [--dry-run] [--confirm-real]
//   Real project: npx tsx --env-file=.env.real scripts/grammar-sync.ts … --dry-run, then the same with --confirm-real.
//
// First reserve the new topic IDs (the mapping file names them): npm run keys -- reserve --kind topic --prefix GT --count 9 --purpose "Q41 NEW-01…09".
// Writes only through cms_save_curriculum / cms_save_order as the admin (audited before → after, by_label "grammar:sync r30"),
// one topic per transaction on a fresh connection, under the work lease. Safe to re-run: what already matches is "unchanged".
// A dry run does everything in one transaction and rolls it back.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertCmsOwner, connect, freshConnections, takeLease, targetUrl, type Lease, type Sql } from './lib/db.ts';
import { applyOrder, applyTopic, planSync, readDbState, readSheetTopics, readTopicMapping, type ApplyResult } from './lib/grammar-sync.ts';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? null : null; };
const home = (p: string) => resolve(p.replace(/^~/, homedir()));
const sheetPath = opt('--sheet');
if (!sheetPath) { console.error('usage: npm run grammar:sync -- --sheet <xlsx> [--mapping <csv>] [--dry-run] [--confirm-real]'); process.exit(1); }
const mappingPath = home(opt('--mapping') ?? join(import.meta.dirname, '..', 'docs', 'grammar', 'new-id-mapping-2026-11-28.csv'));
const dryRun = args.includes('--dry-run');
const url = targetUrl(), host = new URL(url).hostname;
const target = host === '127.0.0.1' || host === 'localhost' ? (new URL(url).pathname === '/cms_rehearsal' ? 'rehearsal' : 'local') : 'real';
if (target === 'real' && !dryRun && !args.includes('--confirm-real')) { console.error('Refused: a real-project sync needs a dry run first, then --confirm-real.'); process.exit(1); }
class DryRollback extends Error {}

const sheet = await readSheetTopics(home(sheetPath));
const mapping = readTopicMapping(mappingPath);
console.log(`grammar:sync ${home(sheetPath).replace(homedir(), '~')} (sha ${sheet.sha256.slice(0, 12)}) → ${target}${dryRun ? ' (dry run)' : ''}: ${sheet.topics.length} topics in rows 2–194 · ${sheet.reading_rows} Reading rows skipped (F2) · mapping ${mapping.size} new IDs`);
const sql = connect();
let lease: Lease | null = null;
const results: ApplyResult[] = [];
try {
  await assertCmsOwner(sql);
  const admin = (await sql<{ admin: string }[]>`select value #>> '{}' as admin from cms.cms_config where key = 'admin_user_id'`)[0]!.admin;
  const plan = planSync(sheet.topics, await readDbState(sql), mapping);
  console.log(`plan: ${Object.entries(plan.counts).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(' · ')}`);
  for (const p of plan.topics.filter((x) => x.action !== 'unchanged')) console.log(`  ${p.action.padEnd(6)} ${p.topic_id}${p.sheet_id !== p.topic_id ? ` (${p.sheet_id})` : ''}: ${p.changes.join('; ')}`);
  for (const o of plan.order) console.log(`  order  class ${o.class} ${o.chapter_id}: ${o.after.join(' ')}  (placed ${o.placed.join(', ')})`);
  if (plan.problems.length) { for (const x of plan.problems) console.log(`  ✗ ${x}`); throw new Error(`${plan.problems.length} problem(s); nothing written`); }
  lease = await takeLease({ kind: 'script', holder: `grammar:sync (pid ${process.pid})`, note: `Q41 from the Grammar sheet${dryRun ? ' (dry run)' : ''}` });
  const todo = plan.topics.filter((p) => p.action !== 'unchanged');
  const ach = async (s: Sql) => (await s<{ n: number }[]>`select count(*)::int as n from cms.cms_topics t join cms.cms_chapters c on c.chapter_id = t.chapter_id where c.subject = 'grammar' and t.topic_kind = 'achievers'`)[0]!.n;
  const achBefore = await ach(sql);
  const run = async (unit: (label: string, fn: (s: Sql) => Promise<unknown>) => Promise<unknown>) => {
    for (const p of todo) results.push(await unit(`topic ${p.topic_id}`, (s) => inTx(s, (tx) => applyTopic(tx, admin!, p))) as ApplyResult);
    for (const o of plan.order) await unit(`order ${o.class} ${o.chapter_id}`, (s) => inTx(s, (tx) => applyOrder(tx, admin!, o)));
  };
  if (dryRun) {
    await sql.begin(async (tx) => { await run(async (_l, fn) => fn(tx as unknown as Sql)); const after = planSync(sheet.topics, await readDbState(tx as unknown as Sql), mapping);
      console.log(`after (inside the dry run): ${Object.entries(after.counts).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(' · ')} · Achievers rows ${achBefore} → ${await ach(tx as unknown as Sql)}`); throw new DryRollback(); })
      .catch((e) => { if (!(e instanceof DryRollback)) throw e; });
  } else {
    await run(freshConnections({ log: (s) => console.log(s) }) as never);
    const after = planSync(sheet.topics, await readDbState(sql), mapping);
    console.log(`after: ${Object.entries(after.counts).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(' · ')} · Achievers rows ${achBefore} → ${await ach(sql)}`);
  }
  console.log(`${dryRun ? 'dry run (rolled back): ' : ''}${results.filter((r) => r.action === 'create').length} created · ${results.filter((r) => r.action === 'update').length} updated · ${plan.order.length} order lists`);
  const dir = join(import.meta.dirname, '..', '.local-import'); mkdirSync(dir, { recursive: true });
  const out = join(dir, `grammar-sync-${target}${dryRun ? '-dry-run' : ''}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`);
  writeFileSync(out, JSON.stringify({ target, dry_run: dryRun, sheet_sha256: sheet.sha256, counts: plan.counts, topics: plan.topics, order: plan.order, results }, null, 1) + '\n');
  console.log(`Report: ${out}`);
} catch (e) {
  console.error(`grammar:sync failed: ${(e as Error).message}`); process.exitCode = 1;
} finally {
  await lease?.release().catch(() => {});
  await sql.end();
}

async function inTx<T>(s: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  const x = s as unknown as { begin?: (f: (t: unknown) => Promise<T>) => Promise<T>; savepoint: (f: (t: unknown) => Promise<T>) => Promise<T> };
  return typeof x.begin === 'function' ? x.begin((t) => fn(t as Sql)) : x.savepoint((t) => fn(t as Sql));
}

// Q38 PR 3: the CMS key registry (plan §1). The CMS issues every key and catalogue number; id_blocks.md is a read-only mirror.
//
//   npm run keys -- reserve --kind file_key --prefix MC19 --count 30 --purpose "DAV-C4 w_b125" [--by "QB build"] [--dry-run]
//   npm run keys -- reserve --kind block --purpose "NCERT-C6-11 …" [--by …] [--dry-run]     → block b: MP b×50…, C b01…, b01…
//   npm run keys -- close --id 12 --status used|released [--note "…"]
//   npm run keys -- list [--all]                                     open reservations (or every one)
//   npm run keys -- import-blocks [--file <id_blocks.md>] [--dry-run] one-off: id_blocks.md blocks 0–124 as "used" (idempotent)
//   npm run keys -- mirror [--out <file>]                            id_blocks.md as a read-only mirror of the registry
// Real project: npx tsx --env-file=.env.real scripts/keys.ts …  (reserve / close also as cms_gen_writer; list / mirror as cms_reader).
// A reservation is one atomic call (advisory lock), so it needs no work lease. import-blocks takes the lease and writes in
// batches of 25 blocks, one transaction each.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertRole, connect, freshConnections, takeLease, targetUrl, type Lease } from './lib/db.ts';
import { blockRow, ID_BLOCKS, QB_DIR, readIdBlocks } from './lib/id-blocks.ts';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] ?? null : null; };
const has = (n: string) => rest.includes(n);
const host = new URL(targetUrl()).hostname;
const target = host === '127.0.0.1' || host === 'localhost' ? (new URL(targetUrl()).pathname === '/cms_rehearsal' ? 'rehearsal' : 'local') : 'real';
const usage = 'usage: npm run keys -- reserve --kind file_key|block [--prefix MC19 --count N] --purpose "…" [--by "…"] [--dry-run] | close --id N --status used|released [--note "…"] | list [--all] | import-blocks [--file …] [--dry-run] | mirror [--out …]';
if (!cmd || !['reserve', 'close', 'list', 'import-blocks', 'mirror'].includes(cmd)) { console.error(usage); process.exit(1); }

type R = Record<string, unknown>;
/** Highest key of a chapter prefix in the QuestionBank chapter files on the Mac (our own questions; *.book.json never opened). */
function bankMax(prefix: string): { max: number; files: number } {
  let max = 0, files = 0;
  if (!existsSync(QB_DIR)) return { max, files };
  for (const d of readdirSync(QB_DIR, { withFileTypes: true }).filter((x) => x.isDirectory() && !x.name.startsWith('_'))) {
    for (const f of readdirSync(join(QB_DIR, d.name)).filter((n) => n.startsWith(`${prefix}-C`) && n.endsWith('.json'))) {
      files++;
      try { for (const q of JSON.parse(readFileSync(join(QB_DIR, d.name, f), 'utf8')).questions ?? []) {
        const m = new RegExp(`^${prefix}-(\\d+)$`).exec(q.key ?? ''); if (m && Number(m[1]) < 5000) max = Math.max(max, Number(m[1]));
      } } catch { /* not a chapter file */ }
    }
  }
  return { max, files };
}
const show = (r: R) => r.kind === 'file_key'
  ? `#${r.reservation_id} file keys ${r.first} … ${r.last} (${r.count}) · ${r.status} · ${r.purpose} · by ${r.reserved_by}`
  : `#${r.reservation_id} block ${r.block}: patterns ${r.patterns} · concepts ${r.concepts} · misconceptions ${r.misconceptions} · ${r.status} · ${r.purpose} · by ${r.reserved_by}`;
class DryRollback extends Error { constructor(public r: unknown) { super('dry run'); } }

const sql = connect();
let lease: Lease | null = null;
try {
  if (cmd === 'reserve') {
    await assertRole(sql, ['cms_owner', 'cms_gen_writer']);
    const prefix = opt('--prefix')?.toUpperCase() ?? null;
    const bm = opt('--kind') === 'file_key' && prefix ? bankMax(prefix) : null;
    if (bm) console.log(`QuestionBank files: ${bm.files} ${prefix} chapter file(s), highest key ${bm.max ? `${prefix}-${String(bm.max).padStart(4, '0')}` : 'none'}`);
    const p = { kind: opt('--kind'), prefix, count: opt('--count') ? Number(opt('--count')) : null, purpose: opt('--purpose'), by: opt('--by'), at_least: bm ? bm.max + 1 : null };
    const run = (tx: typeof sql) => tx`select cms.cms_reserve_keys(${tx.json(p as never)}) as r`.then((x) => x[0]!.r as R);
    if (has('--dry-run')) {
      const r = await sql.begin(async (tx) => { throw new DryRollback(await run(tx as unknown as typeof sql)); }).catch((e) => { if (e instanceof DryRollback) return e.r as R; throw e; });
      console.log(`dry run on ${target} (rolled back; nothing reserved): would reserve ${show(r).replace(/^#\d+ /, '')}`);
    } else console.log(`reserved on ${target}: ${show(await run(sql))}`);
  }
  if (cmd === 'close') {
    await assertRole(sql, ['cms_owner', 'cms_gen_writer']);
    const r = (await sql`select cms.cms_close_keys(${sql.json({ reservation_id: Number(opt('--id')), status: opt('--status'), note: opt('--note'), by: opt('--by') } as never)}) as r`)[0]!.r as R;
    console.log(`closed on ${target}: ${show(r)}`);
  }
  if (cmd === 'list' || cmd === 'mirror') {
    const rows = await sql<R[]>`select cms.cms_key_reservation_json(r) as j from cms.cms_key_reservations r
      where ${has('--all') || cmd === 'mirror'} or r.status = 'reserved' order by r.kind, r.block_no nulls last, r.prefix, r.first_no`.then((x) => x.map((y) => y.j as R));
    if (cmd === 'list') { console.log(`${rows.length} ${has('--all') ? '' : 'open '}reservation(s) on ${target}`); for (const r of rows) console.log(`  ${show(r)}`); }
    else {
      const blocks = rows.filter((r) => r.kind === 'block'), keys = rows.filter((r) => r.kind === 'file_key');
      const next = Math.max(-1, ...blocks.map((r) => Number(r.block))) + 1;
      const md = [
        '# ID blocks per chapter — READ-ONLY MIRROR',
        '',
        `> Generated from the CMS key registry (cms_key_reservations) on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by \`npm run keys -- mirror\`.`,
        '> **Do not edit.** Reserve a block or file keys through the CMS: `npm run keys -- reserve --kind block --purpose "…"`',
        '> or `npm run keys -- reserve --kind file_key --prefix MC19 --count 30 --purpose "…"` (witoscope-academic-cms).',
        '',
        'Block b gives a chapter: patterns MP(b×50) … MP(b×50+49); concept numbers C{b}01 … C{b}99 (or A{b}01 …); misconception numbers {AREA}{b}01 ….',
        '',
        '| Block | Purpose | Patterns | Status | Source | Note |',
        '|---|---|---|---|---|---|',
        ...blocks.map((r) => `| ${r.block} | ${String(r.purpose).replace(/\|/g, '/')} | ${r.patterns} | ${r.status} | ${r.source} | ${String(r.note ?? '').replace(/\|/g, '/').replace(/\n/g, ' ')} |`),
        `| ${next}–199 | free: reserve through the CMS | | | | |`,
        '',
        '## File-key reservations (book pipelines; keys below 5000 — the CMS mints its own from 5001)',
        '',
        '| # | Keys | Status | Purpose | By |',
        '|---|---|---|---|---|',
        ...(keys.length ? keys.map((r) => `| ${r.reservation_id} | ${r.first} … ${r.last} (${r.count}) | ${r.status} | ${String(r.purpose).replace(/\|/g, '/')} | ${r.reserved_by} |`) : ['| | none yet | | | |']),
        '',
      ].join('\n');
      const out = resolve((opt('--out') ?? join(import.meta.dirname, '..', '.local-import', 'id_blocks.mirror.md')).replace(/^~/, homedir()));
      mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, md);
      console.log(`mirror of ${blocks.length} blocks + ${keys.length} file-key reservations → ${out.replace(homedir(), '~')}`);
    }
  }
  if (cmd === 'import-blocks') {
    await assertRole(sql, ['cms_owner']);
    const file = (opt('--file') ?? ID_BLOCKS).replace(/^~/, homedir());
    const rows = readIdBlocks(file).filter((b) => b.last === undefined).map(blockRow);
    if (!rows.length) throw new Error(`${file}: no blocks found`);
    console.log(`import-blocks ${file.replace(homedir(), '~')} → ${target}${has('--dry-run') ? ' (dry run)' : ''}: ${rows.length} blocks (${rows[0]!.block_no}–${rows.at(-1)!.block_no})`);
    if (target === 'real' && !has('--dry-run') && !has('--confirm-real')) throw new Error('a real-project load needs a dry run first, then --confirm-real');
    lease = await takeLease({ kind: 'script', holder: `keys import-blocks (pid ${process.pid})`, note: 'id_blocks.md → cms_key_reservations' });
    const tally: Record<string, number> = {}; const conflicts: number[] = [];
    const batch = async (tx: typeof sql, chunk: typeof rows) => (await tx`select cms.cms_import_key_blocks(${tx.json({ blocks: chunk } as never)}) as r`)[0]!.r as { blocks: { block: number; result: string }[] };
    const add = (r: { blocks: { block: number; result: string }[] }) => { for (const b of r.blocks) { tally[b.result] = (tally[b.result] ?? 0) + 1; if (b.result === 'conflict') conflicts.push(b.block); } };
    if (has('--dry-run')) {
      await sql.begin(async (tx) => { for (let i = 0; i < rows.length; i += 25) add(await batch(tx as unknown as typeof sql, rows.slice(i, i + 25))); throw new DryRollback(null); })
        .catch((e) => { if (!(e instanceof DryRollback)) throw e; });
    } else {
      const unit = freshConnections({ log: (s) => console.log(s) });
      for (let i = 0; i < rows.length; i += 25) { const r = await unit(`blocks ${i}–${i + 24}`, (c) => batch(c, rows.slice(i, i + 25))); add(r); console.log(`  batch ${i / 25 + 1}: ${Object.entries(r.blocks.reduce((m: Record<string, number>, x) => (m[x.result] = (m[x.result] ?? 0) + 1, m), {})).map(([k, v]) => `${v} ${k}`).join(' · ')}`); }
    }
    console.log(`${has('--dry-run') ? 'dry run (rolled back): ' : ''}${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(' · ')}${conflicts.length ? ` · CONFLICT blocks ${conflicts.join(', ')} (already loaded with another purpose; not changed)` : ''}`);
    if (conflicts.length) process.exitCode = 1;
  }
} catch (e) {
  console.error(`keys ${cmd} failed: ${(e as Error).message}`); process.exitCode = 1;
} finally {
  await lease?.release().catch(() => {});
  await sql.end();
}

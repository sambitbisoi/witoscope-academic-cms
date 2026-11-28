// Q38 PR 3: the key-registry audit (read-only). Plan docs/plan-2026-11-23-q38-direct-generation.md §1 ("keys:audit").
//
//   npm run keys:audit [-- --md <file>]                         local database
//   npx tsx --env-file=.env.real.reader scripts/keys-audit.ts   real project, as cms_reader (read-only role)
//
// Compares three registers, keys and counts only (never question text in the output):
//   1. the CMS: question keys (file_key, question ID), catalogue IDs (patterns, concepts, misconceptions), sequences
//   2. the QuestionBank key registry: keys in QuestionBank/*/(MC|SC|GC)##-C#.json (our own questions; *.book.json is never opened)
//   3. QuestionBank/_pipeline/id_blocks.md: the hand-kept catalogue number blocks
// A bank key counts as the same question when the bank text (spaces normalised) equals the CMS v1 or current text.
// Everything runs in one read-only transaction. Writes a JSON report to .local-import and, with --md, a Markdown summary.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, targetUrl } from './lib/db.ts';
import { readIdBlocks } from './lib/id-blocks.ts';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? null : null; };
const QB = opt('--qb') ?? join(homedir(), 'WitoScope', 'ContentResearch', 'QuestionBank');
const BLOCKS = join(QB, '_pipeline', 'id_blocks.md');
const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const num = (s: string) => Number(/(\d+)$/.exec(s)?.[1] ?? NaN);
const count = <T,>(xs: T[], f: (x: T) => string) => xs.reduce((m: Record<string, number>, x) => (m[f(x)] = (m[f(x)] ?? 0) + 1, m), {});

// ---------------------------------------------------------------- 2. the bank (read on the Mac)
interface BankKey { key: string; file: string; text: string; topic: string | null }
const bank = new Map<string, BankKey>(); const bankDup: { key: string; files: string[] }[] = [];
for (const d of readdirSync(QB, { withFileTypes: true }).filter((x) => x.isDirectory() && !x.name.startsWith('_'))) {
  for (const f of readdirSync(join(QB, d.name)).filter((n) => /^(MC|SC|GC)\d{2}-C\d\.json$/.test(n))) {
    let qs: { key?: string; text?: string; topic_id?: string }[] = [];
    try { qs = JSON.parse(readFileSync(join(QB, d.name, f), 'utf8')).questions ?? []; } catch { continue; }
    for (const q of qs) {
      if (!q.key) continue;
      const file = `${d.name}/${f}`, prev = bank.get(q.key);
      if (prev && prev.text !== norm(q.text)) bankDup.push({ key: q.key, files: [prev.file, file] });
      bank.set(q.key, { key: q.key, file, text: norm(q.text), topic: q.topic_id ?? null });
    }
  }
}

// ---------------------------------------------------------------- 3. id_blocks.md
const blocks = readIdBlocks(BLOCKS);
const assigned = blocks.filter((b) => b.last === undefined);
const blockOf = new Map(assigned.map((b) => [b.block, b]));
const freeFrom = blocks.find((b) => b.last !== undefined)?.block ?? (Math.max(-1, ...assigned.map((b) => b.block)) + 1);

// ---------------------------------------------------------------- 1. the CMS (one read-only transaction)
const url = targetUrl(), host = new URL(url).hostname;
const target = host === '127.0.0.1' || host === 'localhost' ? (new URL(url).pathname === '/cms_rehearsal' ? 'rehearsal' : 'local') : 'real';
const sql = connect();
type Q = { question_id: string; file_key: string | null; subject: string; bank: string; t1: string; tc: string; created_from: string | null; run_code: string | null; import_kind: string | null; v1_at: string };
const db = await sql.begin('read only', async (tx) => {
  const role = (await tx`select session_user::text as r`)[0]!.r as string;
  const qs = await tx<Q[]>`select q.question_id, q.file_key, q.subject, q.bank, v1.text as t1, vc.text as tc, v1.created_from, r.run_code, i.kind as import_kind, v1.created_at::date::text as v1_at
    from cms.cms_questions q
    join cms.cms_question_versions v1 on v1.question_id = q.question_id and v1.version_no = 1
    join cms.cms_question_versions vc on vc.question_id = q.question_id and vc.version_no = q.current_version
    left join cms.cms_generation_runs r on r.run_id = v1.run_id
    left join cms.cms_imports i on i.import_id = v1.import_id
    order by q.question_id`;
  const patterns = (await tx`select pattern_id as id, status from cms.cms_patterns`) as unknown as { id: string; status: string }[];
  const concepts = (await tx`select concept_id as id, subject, status from cms.cms_concepts`) as unknown as { id: string; subject: string; status: string }[];
  const miscon = (await tx`select misconception_id as id, status from cms.cms_misconceptions`) as unknown as { id: string; status: string }[];
  const sets = (await tx`select count(*)::int as n from cms.cms_typical_sets`)[0]!.n as number;
  const seqs = await tx`select 'MQ' as k, last_value, is_called from cms.cms_mq_seq union all select 'SQ', last_value, is_called from cms.cms_sq_seq
                        union all select 'GQ', last_value, is_called from cms.cms_gq_seq union all select 'GR', last_value, is_called from cms.cms_gr_seq`;
  const runs = (await tx`select run_code, status, mode from cms.cms_generation_runs where run_code is not null order by run_code`) as unknown as { run_code: string; status: string; mode: string | null }[];
  const rsv = await tx`select to_regclass('cms.cms_key_reservations') is not null as has`;
  return { role, qs, patterns, concepts, miscon, sets, seqs, runs, reservations: rsv[0]!.has as boolean };
});
await sql.end();

// ---------------------------------------------------------------- compare
const cmsByKey = new Map(db.qs.filter((q) => q.file_key).map((q) => [q.file_key!, q]));
const origin = (q: Q) => q.bank === 'gold' ? 'gold seed'
  : q.created_from === 'generation' ? 'generation run'
  : q.import_kind === 'science' ? 'Science master import'
  : q.import_kind === 'chapter' ? 'chapter import (QuestionBank)'
  : q.import_kind === null ? `created in the CMS (${q.created_from ?? '?'})` : `import ${q.import_kind}`;
const keyRows = db.qs.filter((q) => q.file_key).map((q) => {
  const b = bank.get(q.file_key!);
  const status = !b ? 'not_in_bank' : (b.text === norm(q.t1) || b.text === norm(q.tc)) ? 'same' : 'bank_text_differs';
  return { key: q.file_key!, qid: q.question_id, subject: q.subject, bank: q.bank, status, origin: origin(q), bank_file: b?.file ?? null, run: q.run_code };
});
const notInCms = [...bank.values()].filter((b) => !cmsByKey.has(b.key)).map((b) => ({ key: b.key, file: b.file }));
const prefix = (k: string) => k.split('-')[0]!;
const maxBy = (keys: string[]) => keys.reduce((m: Record<string, number>, k) => (m[prefix(k)] = Math.max(m[prefix(k)] ?? 0, num(k)), m), {});
const bankMax = maxBy([...bank.keys()]), cmsMax = maxBy([...cmsByKey.keys()]);
// a bank pipeline that takes "max + 1 over the bank files" collides wherever the CMS already holds a higher key of that chapter
const collisionRisk = Object.keys(cmsMax).filter((p) => bankMax[p] !== undefined && cmsMax[p]! > bankMax[p]!)
  .map((p) => ({ prefix: p, bank_max: bankMax[p]!, cms_max: cmsMax[p]!, cms_keys_above_bank_max: [...cmsByKey.keys()].filter((k) => prefix(k) === p && num(k) > bankMax[p]!).sort() }));
const below5000 = (p: string) => [...cmsByKey.keys()].filter((k) => prefix(k) === p && num(k) < 5000).map(num);

// catalogue numbers vs id_blocks
const mpNums = db.patterns.filter((p) => /^MP\d+$/.test(p.id)).map((p) => ({ id: p.id, n: num(p.id), status: p.status }));
const mpByBlock = new Map<number, typeof mpNums>(); for (const p of mpNums) { const b = Math.floor(p.n / 50); mpByBlock.set(b, [...(mpByBlock.get(b) ?? []), p]); }
const mpOutside = mpNums.filter((p) => !blockOf.has(Math.floor(p.n / 50))).map((p) => p.id).sort();
const mpOutsideStated = mpNums.filter((p) => { const b = blockOf.get(Math.floor(p.n / 50)); return b && b.mp.length > 0 && !b.mp.some(([a, z]) => p.n >= a && p.n <= z); }).map((p) => p.id).sort();
const blockNo = (id: string) => { const m = /-(?:[A-Z]+-)?[A-Z]*?(?:C|A)?(\d{3,5})$/.exec(id); return m ? Math.floor(Number(m[1]) / 100) : null; };
const catalogue = (rows: { id: string }[]) => {
  const numbered = rows.map((r) => ({ id: r.id, b: blockNo(r.id) })).filter((r) => r.b !== null && r.b > 0);
  return { total: rows.length, numbered: numbered.length, unnumbered: rows.length - numbered.length,
    outside_blocks: numbered.filter((r) => !blockOf.has(r.b!)).map((r) => r.id).sort(), max_block_used: Math.max(0, ...numbered.map((r) => r.b!)) };
};
const seq = Object.fromEntries(db.seqs.map((s) => [s.k as string, { last_value: Number(s.last_value), is_called: s.is_called as boolean }]));
const idsOf = (pfx: string) => db.qs.filter((q) => q.question_id.startsWith(pfx)).map((q) => num(q.question_id));
const seqRow = (k: string, ids: number[]) => ({ last_value: seq[k]!.is_called ? seq[k]!.last_value : 0, max_id: Math.max(0, ...ids), ids: ids.length,
  numbers_taken_not_stored: (seq[k]!.is_called ? seq[k]!.last_value : 0) - ids.length });
const grNums = db.runs.map((r) => num(r.run_code));
const grMissing: number[] = []; for (let i = 1; i <= (seq.GR!.is_called ? seq.GR!.last_value : 0); i++) if (!grNums.includes(i)) grMissing.push(i);

const report = {
  generated_at: new Date().toISOString(), target, role: db.role,
  bank: { files_read_from: QB.replace(homedir(), '~'), keys: bank.size, duplicate_keys_with_different_text: bankDup },
  cms: { questions: db.qs.length, with_file_key: cmsByKey.size, by_subject_bank: count(db.qs, (q) => `${q.subject}/${q.bank}`) },
  keys: {
    same_question: keyRows.filter((r) => r.status === 'same').length,
    bank_text_differs: { n: keyRows.filter((r) => r.status === 'bank_text_differs').length, by_prefix: count(keyRows.filter((r) => r.status === 'bank_text_differs'), (r) => prefix(r.key)),
      keys: keyRows.filter((r) => r.status === 'bank_text_differs').map((r) => `${r.key}=${r.qid}`) },
    cms_key_not_in_bank: { n: keyRows.filter((r) => r.status === 'not_in_bank').length, by_origin: count(keyRows.filter((r) => r.status === 'not_in_bank'), (r) => `${r.subject}/${r.bank}: ${r.origin}`),
      math_production: keyRows.filter((r) => r.status === 'not_in_bank' && r.subject === 'math' && r.bank === 'production').map((r) => `${r.key}=${r.qid} (${r.origin})`),
      generation_runs: [...new Set(keyRows.filter((r) => r.status === 'not_in_bank' && r.run).map((r) => r.run!))].sort() },
    bank_key_not_in_cms: notInCms,
    collision_risk_bank_next_key: collisionRisk,
    generated_key_ranges: Object.fromEntries(Object.entries(count(keyRows.filter((r) => r.origin === 'generation run'), (r) => prefix(r.key))).map(([p, n]) => {
      const ns = keyRows.filter((r) => r.origin === 'generation run' && prefix(r.key) === p).map((r) => num(r.key));
      return [p, { n, from: Math.min(...ns), to: Math.max(...ns), below_5000_in_chapter: below5000(p).length }];
    })),
  },
  id_blocks: {
    file: existsSync(BLOCKS) ? BLOCKS.replace(homedir(), '~') : 'missing', blocks_assigned: assigned.length, last_assigned: Math.max(-1, ...assigned.map((b) => b.block)), free_from_block: freeFrom,
    awaiting_review: assigned.filter((b) => /awaiting review/i.test(b.status)).length, done: assigned.filter((b) => /^done/i.test(b.status)).length,
    patterns: { cms_mp: mpNums.length, cms_max: mpNums.length ? `MP${Math.max(...mpNums.map((p) => p.n))}` : null, proposed: mpNums.filter((p) => p.status === 'proposed').length,
      outside_any_assigned_block: mpOutside, inside_a_block_but_outside_its_stated_ranges: mpOutsideStated,
      blocks_with_cms_patterns: mpByBlock.size, blocks_assigned_with_no_cms_pattern: assigned.filter((b) => !mpByBlock.has(b.block) && b.block > 0).map((b) => b.block),
      next_free_block_first_mp: `MP${String(freeFrom * 50).padStart(4, '0')}`, mp_4_digit_limit_block: 199 },
    concepts: catalogue(db.concepts.filter((c) => c.subject === 'math')), misconceptions: catalogue(db.miscon),
    typical_sets: { cms: db.sets, note: 'typical sets are named (TS-…), not numbered: no block rule applies' },
  },
  sequences: {
    MQ: seqRow('MQ', idsOf('MQ')), SQ: seqRow('SQ', idsOf('SQ')), GQ: seqRow('GQ', idsOf('GQ')),
    GR: { last_value: seq.GR!.is_called ? seq.GR!.last_value : 0, runs: db.runs.length, codes_taken_with_no_run: grMissing.length, first_missing: grMissing.slice(0, 20) },
  },
  key_reservations_table: db.reservations,
};

const dir = join(import.meta.dirname, '..', '.local-import'); mkdirSync(dir, { recursive: true });
const out = join(dir, `keys-audit-${target}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`);
writeFileSync(out, JSON.stringify(report, null, 1) + '\n');
const k = report.keys, ib = report.id_blocks, s = report.sequences;
const lines = [
  `keys:audit on ${target} as ${db.role} (read only) · ${report.generated_at.slice(0, 16)}Z`,
  `bank keys ${bank.size} (duplicates with different text: ${bankDup.length}) · CMS questions ${db.qs.length}, with a file key ${cmsByKey.size}`,
  `same key, same question: ${k.same_question}`,
  `bank holds different text: ${k.bank_text_differs.n} ${JSON.stringify(k.bank_text_differs.by_prefix)}`,
  `CMS key not in bank: ${k.cms_key_not_in_bank.n} ${JSON.stringify(k.cms_key_not_in_bank.by_origin)}`,
  `  Math production not in bank: ${k.cms_key_not_in_bank.math_production.join(', ') || 'none'}`,
  `  generation runs: ${k.cms_key_not_in_bank.generation_runs.length} (${k.cms_key_not_in_bank.generation_runs[0] ?? '–'} … ${k.cms_key_not_in_bank.generation_runs.at(-1) ?? '–'})`,
  `bank key not in CMS: ${k.bank_key_not_in_cms.length} ${k.bank_key_not_in_cms.map((x) => x.key).join(', ')}`,
  `collision risk (CMS holds a key above the bank max of that chapter): ${k.collision_risk_bank_next_key.map((c) => `${c.prefix} bank ${c.bank_max} < CMS ${c.cms_max}`).join(', ') || 'none'}`,
  `id_blocks: ${ib.blocks_assigned} blocks (0–${ib.last_assigned}), free from ${ib.free_from_block}; awaiting review ${ib.awaiting_review}, done ${ib.done}`,
  `  patterns: ${ib.patterns.cms_mp} MP in CMS (max ${ib.patterns.cms_max}, proposed ${ib.patterns.proposed}); outside any block: ${ib.patterns.outside_any_assigned_block.length}; outside the stated ranges: ${ib.patterns.inside_a_block_but_outside_its_stated_ranges.length}; next free MP${String(ib.free_from_block * 50).padStart(4, '0')}`,
  `  concepts (Math): ${ib.concepts.total} (${ib.concepts.numbered} numbered, outside blocks ${ib.concepts.outside_blocks.length}) · misconceptions: ${ib.misconceptions.total} (${ib.misconceptions.numbered} numbered, outside blocks ${ib.misconceptions.outside_blocks.length})`,
  `sequences: MQ last ${s.MQ.last_value} / ${s.MQ.ids} IDs (${s.MQ.numbers_taken_not_stored} taken, never stored) · SQ last ${s.SQ.last_value} / ${s.SQ.ids} (${s.SQ.numbers_taken_not_stored}) · GQ last ${s.GQ.last_value} / ${s.GQ.ids} · GR last ${s.GR.last_value}, ${s.GR.runs} runs, ${s.GR.codes_taken_with_no_run} codes with no run`,
  `\nReport (keys and counts only): ${out}`,
];
console.log(lines.join('\n'));
const md = opt('--md');
if (md) writeFileSync(md, JSON.stringify(report, null, 1));

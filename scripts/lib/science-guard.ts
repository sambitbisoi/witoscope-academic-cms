// Stop-condition guard for Science data work (Sambit, 16 Nov 2026; docs/plan-2026-11-16-q11-q18.md §3):
// a fingerprint (md5) of every row that Science work must NOT change: all Math / Grammar questions and their
// versions and version children, plus the content rows and citations themselves. The columns added by 0035 are
// left out, so the fingerprint is the same before and after the migration.
import type { Sql } from './db.ts';

const NEW_0035 = ['misconception_row_id', 'misconception_item_no', 'misconception_targeted_legacy', 'mc_row_id', 'mc_item_no', 'rank', 'rank_proposed', 'weight'];
const NON_SCI_VERSIONS = `select v.version_id from cms.cms_question_versions v join cms.cms_questions q on q.question_id = v.question_id where q.subject <> 'science'`;

const PARTS: [name: string, from: string, order: string][] = [
  ['questions (not Science)', `cms.cms_questions t where t.subject <> 'science'`, 't.question_id'],
  ['versions (not Science)', `cms.cms_question_versions t where t.version_id in (${NON_SCI_VERSIONS})`, 't.version_id'],
  ['options (not Science)', `cms.cms_version_options t where t.version_id in (${NON_SCI_VERSIONS})`, 't.version_id, t.part_label, t.position'],
  ['solutions (not Science)', `cms.cms_version_solutions t where t.version_id in (${NON_SCI_VERSIONS})`, 't.version_id, t.slot'],
  ['hints (not Science)', `cms.cms_version_hints t where t.version_id in (${NON_SCI_VERSIONS})`, 't.version_id, t.level'],
  ['wrong answers (not Science)', `cms.cms_version_wrong_answers t where t.version_id in (${NON_SCI_VERSIONS})`, 't.wrong_answer_id'],
  ['concepts (not Science)', `cms.cms_version_concepts t where t.version_id in (${NON_SCI_VERSIONS})`, 't.version_id, t.part_label, t.concept_id'],
  ['parts (not Science)', `cms.cms_version_parts t where t.version_id in (${NON_SCI_VERSIONS})`, 't.version_id, t.part_label'],
  ['content-row links (not Science)', `cms.cms_question_content_rows t where t.version_id in (${NON_SCI_VERSIONS})`, 't.version_id, t.row_id'],
  ['content rows', `cms.cms_content_rows t`, 't.row_id'],
  ['row citations', `cms.cms_citations t where t.row_id is not null`, 't.citation_id'],
];

export type Digest = Record<string, { n: number; md5: string }>;

export async function guardDigest(sql: Sql): Promise<Digest> {
  const out: Digest = {};
  const excl = `array[${NEW_0035.map((c) => `'${c}'`).join(', ')}]`;
  for (const [name, from, order] of PARTS) {
    const [r] = await sql.unsafe(`select count(*)::int as n, md5(coalesce(string_agg((to_jsonb(t) - ${excl}::text[])::text, '|' order by ${order}), '')) as md5 from ${from}`);
    out[name] = { n: Number(r!.n), md5: String(r!.md5) };
  }
  return out;
}

/** The parts whose fingerprint differs (empty = nothing outside Science changed). */
export const guardDiff = (a: Digest, b: Digest) => Object.keys(a).filter((k) => a[k]!.md5 !== b[k]?.md5 || a[k]!.n !== b[k]?.n);

if (import.meta.filename === process.argv[1]) {
  // npx tsx scripts/lib/science-guard.ts [--save <file>] [--compare <file>]
  const { connect, assertCmsOwner } = await import('./db.ts');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const args = process.argv.slice(2);
  const sql = connect();
  try {
    await assertCmsOwner(sql);
    const d = await guardDigest(sql);
    const save = args.indexOf('--save'), cmp = args.indexOf('--compare');
    if (save >= 0) writeFileSync(args[save + 1]!, JSON.stringify(d, null, 2));
    for (const [k, v] of Object.entries(d)) console.log(`${k.padEnd(32)} ${String(v.n).padStart(7)}  ${v.md5}`);
    if (cmp >= 0) {
      const diff = guardDiff(JSON.parse(readFileSync(args[cmp + 1]!, 'utf8')) as Digest, d);
      console.log(diff.length ? `CHANGED: ${diff.join(', ')}` : 'guard: unchanged');
      if (diff.length) process.exitCode = 1;
    }
  } finally { await sql.end(); }
}

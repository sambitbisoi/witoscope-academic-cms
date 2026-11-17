// Before/after fingerprint of every cms table (a stop condition for real data steps, as in 0035): one md5 per table
// over its rows, with chosen columns left out (the ones the step is allowed to change). Tables that only grow
// (reviews, imports) are compared by the rows that existed before.
import type postgres from 'postgres';
import type { Sql } from './db.ts';

type Tx = Sql | postgres.TransactionSql;
export interface Fingerprint { [table: string]: { rows: number; md5: string } }

/** @param exclude columns to leave out per table, e.g. { cms_question_versions: ['tier'] }
 *  @param growOnly tables compared only on rows with an id up to the "before" maximum: { cms_reviews: 'review_id' } */
export async function fingerprint(tx: Tx, o: { exclude?: Record<string, string[]>; upTo?: Record<string, { col: string; max: number }> } = {}): Promise<Fingerprint> {
  const tables = (await tx`select table_name from information_schema.tables where table_schema = 'cms' and table_type = 'BASE TABLE' order by 1`).map((r) => r.table_name as string);
  const out: Fingerprint = {};
  for (const t of tables) {
    const ex = o.exclude?.[t] ?? [];
    const lim = o.upTo?.[t];
    const exprJson = ex.length ? `to_jsonb(t) - array[${ex.map((c) => `'${c.replace(/'/g, "''")}'`).join(',')}]::text[]` : 'to_jsonb(t)';
    const where = lim ? `where t.${lim.col} <= ${Number(lim.max)}` : '';
    const [r] = await tx.unsafe(`select count(*)::int as n, coalesce(md5(string_agg(h, '' order by h)), '') as md5
                                   from (select md5((${exprJson})::text) as h from cms.${t} t ${where}) s`);
    out[t] = { rows: Number(r!.n), md5: String(r!.md5) };
  }
  return out;
}
export async function maxId(tx: Tx, table: string, col: string) {
  const [r] = await tx.unsafe(`select coalesce(max(${col}), 0)::bigint as m from cms.${table}`);
  return Number(r!.m);
}
export function diffFingerprints(a: Fingerprint, b: Fingerprint, ignoreTables: string[] = []): string[] {
  const out: string[] = [];
  for (const t of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (ignoreTables.includes(t)) continue;
    if (!a[t] || !b[t]) { out.push(`${t}: table ${a[t] ? 'gone' : 'new'}`); continue; }
    if (a[t]!.rows !== b[t]!.rows || a[t]!.md5 !== b[t]!.md5) out.push(`${t}: rows ${a[t]!.rows} → ${b[t]!.rows}, md5 ${a[t]!.md5.slice(0, 8)} → ${b[t]!.md5.slice(0, 8)}`);
  }
  return out;
}

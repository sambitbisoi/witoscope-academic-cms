// Catalogue upsert shared by the importers: insert new rows, update changed rows
// in place with an audit row in cms_reviews, never delete (rows missing from the
// source are reported). Runs inside the caller's transaction, as cms_owner.
import type postgres from 'postgres';
import { diffRow } from './topics.ts';

export interface UpsertCounts { inserted: number; updated: number; unchanged: number; missing_from_source: number }
export interface UpsertNote { level: 'warning'; where: string; message: string }

export async function upsertCatalogue<T extends object>(
  tx: postgres.TransactionSql,
  table: string,
  keyCols: (keyof T & string)[],
  rows: T[],
  opts: { jsonCols?: string[]; byLabel: string; importId: number; reason: string; scope?: { col: string; value: string } },
): Promise<{ counts: UpsertCounts; notes: UpsertNote[] }> {
  const counts: UpsertCounts = { inserted: 0, updated: 0, unchanged: 0, missing_from_source: 0 };
  const notes: UpsertNote[] = [];
  const keyOf = (r: Record<string, unknown>) => keyCols.map((k) => String(r[k])).join(' · ');
  const scoped = opts.scope ? ` where ${opts.scope.col} = '${opts.scope.value.replace(/'/g, "''")}'` : '';
  const existing = new Map<string, Record<string, unknown>>(
    (await tx.unsafe(`select * from cms.${table}${scoped}`)).map((r) => [keyOf(r), r]),
  );
  const enc = (row: T) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, opts.jsonCols?.includes(k) && v !== null ? tx.json(v as never) : v]));

  const fresh = rows.filter((r) => !existing.has(keyOf(r as Record<string, unknown>)));
  for (let i = 0; i < fresh.length; i += 500) await tx`insert into ${tx(`cms.${table}`)} ${tx(fresh.slice(i, i + 500).map(enc) as never[])}`;
  counts.inserted = fresh.length;

  for (const row of rows) {
    const key = keyOf(row as Record<string, unknown>);
    const before = existing.get(key);
    if (!before) continue;
    const diff = diffRow(before as Partial<T>, row);
    if (!Object.keys(diff).length) { counts.unchanged++; continue; }
    const set = Object.fromEntries(Object.keys(diff).map((k) => [k, enc(row)[k]]));
    const where = keyCols.map((k) => tx`${tx(k as string)} = ${(row as Record<string, unknown>)[k] as string}`)
      .reduce((a, b) => tx`${a} and ${b}`);
    await tx`update ${tx(`cms.${table}`)} set ${tx(set as never)} where ${where}`;
    const action = 'status' in diff ? (diff.status!.after === 'retired' ? 'retire' : diff.status!.before === 'retired' ? 'restore' : 'edit_catalogue') : 'edit_catalogue';
    await tx`
      insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, import_id, reason)
      values ('catalogue', ${table}, ${key}, ${action}, ${tx.json(diff as never)}, ${opts.byLabel}, ${opts.importId}, ${opts.reason})`;
    counts.updated++;
  }

  const inSource = new Set(rows.map((r) => keyOf(r as Record<string, unknown>)));
  for (const k of existing.keys()) {
    if (!inSource.has(k)) {
      counts.missing_from_source++;
      notes.push({ level: 'warning', where: table, message: `${k} is in the CMS but not in the source; left unchanged (never deleted)` });
    }
  }
  return { counts, notes };
}

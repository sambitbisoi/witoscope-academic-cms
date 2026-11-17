// Science misconception items in the database (Q16, 16 Nov 2026): keep each content row's items in step with
// its "Common misconceptions" text. Used by science:rationalise (first split) and import:science (re-runs).
// Rules: item numbers are permanent. Same text at the same position → unchanged; changed text → updated in
// place (audited; every question that references the item is listed); extra item → next number; an item the
// text no longer has → retired (audited, referencing questions listed). Items "from question" are never touched.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { splitMisconceptions, type SplitDecision } from '../../shared/science-items.ts';

export const SPLITS_PATH = new URL('./science-splits.json', import.meta.url);
export const loadSplitDecisions = (): Record<string, SplitDecision> =>
  (JSON.parse(readFileSync(SPLITS_PATH, 'utf8')) as { rows: Record<string, SplitDecision> }).rows;

export interface ItemChange { ref: string; before: string; after: string; questions: string[] }
export interface ItemSyncResult {
  rows_with_text: number; rows_split: number; rows_whole: number; items_created: number; items_unchanged: number;
  updated: ItemChange[]; retired: { ref: string; text: string; questions: string[] }[];
  unclear: { row_id: string; text: string; items: string[]; note: string; decided: boolean }[];
  decisions_used: number; decisions_stale: string[];
}

type Tx = postgres.TransactionSql | postgres.Sql;

/** Questions whose CURRENT version references an item (misconception targeted or a wrong option). */
export async function questionsUsing(tx: Tx, row_id: string, item_no: number): Promise<string[]> {
  const r = await tx`select distinct q.question_id from cms.cms_questions q join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
    where (v.misconception_row_id = ${row_id} and v.misconception_item_no = ${item_no})
       or exists (select 1 from cms.cms_version_wrong_answers w where w.version_id = v.version_id and w.mc_row_id = ${row_id} and w.mc_item_no = ${item_no})
    order by 1`;
  return r.map((x) => x.question_id as string);
}

export async function syncRowItems(tx: Tx, rows: { row_id: string; misconceptions: string | null }[], importId: number, by: string): Promise<ItemSyncResult> {
  const decisions = loadSplitDecisions();
  const res: ItemSyncResult = { rows_with_text: 0, rows_split: 0, rows_whole: 0, items_created: 0, items_unchanged: 0, updated: [], retired: [], unclear: [], decisions_used: 0, decisions_stale: [] };
  const ids = rows.map((r) => r.row_id);
  const existing = new Map<string, { item_no: number; text: string; status: string; source: string }[]>();
  for (const it of await tx<{ row_id: string; item_no: number; text: string; status: string; source: string }[]>`
      select row_id, item_no, text, status, source from cms.cms_row_misconceptions where row_id = any(${ids}) order by row_id, item_no`) {
    existing.set(it.row_id, [...(existing.get(it.row_id) ?? []), it]);
  }
  const fresh: Record<string, unknown>[] = [];
  for (const r of rows) {
    const text = r.misconceptions?.trim() ? r.misconceptions.trim() : null;
    const d = decisions[r.row_id];
    const all = existing.get(r.row_id) ?? [];
    const mine = all.filter((i) => i.source === 'row split' && i.status !== 'retired');
    let next = all.reduce((m, i) => Math.max(m, i.item_no), 0) + 1;
    let pieces: string[] = [];
    if (text) {
      res.rows_with_text++;
      const s = splitMisconceptions(text, d);
      if (d && s.rule === 'decision') res.decisions_used++;
      else if (d) res.decisions_stale.push(r.row_id);
      pieces = s.items;
      if (pieces.length > 1) res.rows_split++; else res.rows_whole++;
      if (s.unclear) res.unclear.push({ row_id: r.row_id, text, items: pieces, note: s.note, decided: s.rule === 'decision' });
      const note = s.note;
      for (const [k, p] of pieces.entries()) {
        const ex = mine[k];
        if (!ex) {
          fresh.push({ row_id: r.row_id, item_no: next++, text: p, status: 'active', source: 'row split', unclear: s.unclear, split_note: note, import_id: importId });
          continue;
        }
        if (ex.text === p) { res.items_unchanged++; continue; }
        await tx`update cms.cms_row_misconceptions set text = ${p}, unclear = ${s.unclear}, split_note = ${note}, import_id = ${importId}, updated_at = now()
                 where row_id = ${r.row_id} and item_no = ${ex.item_no}`;
        await tx`insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, import_id, reason)
          values ('catalogue', 'cms_row_misconceptions', ${`${r.row_id} #${ex.item_no}`}, 'science_row', ${tx.json({ text: { before: ex.text, after: p } } as never)}, ${by}, ${importId}, 'the row''s misconceptions text changed')`;
        res.updated.push({ ref: `${r.row_id} #${ex.item_no}`, before: ex.text, after: p, questions: await questionsUsing(tx, r.row_id, ex.item_no) });
      }
    }
    for (const ex of mine.slice(pieces.length)) {
      await tx`update cms.cms_row_misconceptions set status = 'retired', import_id = ${importId}, updated_at = now() where row_id = ${r.row_id} and item_no = ${ex.item_no}`;
      await tx`insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, import_id, reason)
        values ('catalogue', 'cms_row_misconceptions', ${`${r.row_id} #${ex.item_no}`}, 'retire', ${tx.json({ status: { before: ex.status, after: 'retired' } } as never)}, ${by}, ${importId}, 'no longer in the row''s misconceptions text (kept, retired)')`;
      res.retired.push({ ref: `${r.row_id} #${ex.item_no}`, text: ex.text, questions: await questionsUsing(tx, r.row_id, ex.item_no) });
    }
  }
  for (let i = 0; i < fresh.length; i += 500) {
    const chunk = fresh.slice(i, i + 500);
    await tx`insert into cms.cms_row_misconceptions ${tx(chunk as never[])}`;
    await tx`insert into cms.cms_reviews ${tx(chunk.map((it) => ({ target: 'catalogue', target_table: 'cms_row_misconceptions', target_id: `${it.row_id} #${it.item_no}`, action: 'create',
      field_diff: tx.json({ text: { before: null, after: it.text }, source: 'row split' } as never), by_label: by, import_id: importId, reason: 'split from the row\'s misconceptions text' })) as never[])}`;
  }
  res.items_created = fresh.length;
  return res;
}

// Q20 (Sambit, 17 Nov 2026): Tier uses Level. The same rule as shared/derive.ts, in SQL, for stored tiers:
//   Super Achiever = strategy 3, or any tested concept (question + parts, any involvement) catalogued in a class
//   above the question's Level (the placement class class_override ?? class when Level is empty);
//   Achiever = strategy 2; School otherwise. Only versions that have a tier (Math) are judged; Science's level_tier
//   (L1–L3) is a different field and is never touched.
import type postgres from 'postgres';
import type { Sql } from './db.ts';

type Tx = Sql | postgres.TransactionSql;
export interface TierChange { version_id: number; question_id: string; version_no: number; status: string; bank: string; level: number | null;
  placement: number; strategy: number | null; max_concept_class: number | null; before: string; after: string }

/** Versions whose stored tier differs from the rule (optionally only these questions). */
export async function tierChanges(tx: Tx, questionIds?: string[]): Promise<TierChange[]> {
  const rows = await tx`
    with v as (
      select v.version_id, v.question_id, v.version_no, v.status, q.bank, q.level, coalesce(q.class_override, q.class) as placement,
             v.strategy, v.tier,
             (select max(c.class) from cms.cms_version_concepts vc join cms.cms_concepts c on c.concept_id = vc.concept_id
               where vc.version_id = v.version_id) as max_cc
        from cms.cms_question_versions v join cms.cms_questions q on q.question_id = v.question_id
       where v.tier is not null ${questionIds ? tx`and v.question_id in ${tx(questionIds.length ? questionIds : [''])}` : tx``})
    select version_id, question_id, version_no, status, bank, level, placement, strategy, max_cc, tier as before,
           case when strategy >= 3 or coalesce(max_cc, 0) > coalesce(level, placement) then 'Super Achiever'
                when strategy = 2 then 'Achiever' else 'School' end as after
      from v
     order by question_id, version_no`;
  return rows.filter((r) => r.before !== r.after).map((r) => ({
    version_id: Number(r.version_id), question_id: r.question_id, version_no: Number(r.version_no), status: r.status, bank: r.bank,
    level: r.level === null ? null : Number(r.level), placement: Number(r.placement), strategy: r.strategy === null ? null : Number(r.strategy),
    max_concept_class: r.max_cc === null ? null : Number(r.max_cc), before: r.before, after: r.after,
  }));
}

/** Write the new tiers in place (a derived field; no new version), one audit row each (before → after). Idempotent:
 *  a row is written only while its stored tier still equals `before`. */
export async function applyTierChanges(tx: Tx, changes: TierChange[], o: { importId: number | null; reason: string; by: string }) {
  if (!changes.length) return 0;
  const data = changes.map((c) => ({ id: c.version_id, before: c.before, after: c.after }));
  const done = await tx`
    update cms.cms_question_versions v set tier = x.after
      from jsonb_to_recordset(${tx.json(data as never)}) as x(id bigint, before text, after text)
     where v.version_id = x.id and v.tier = x.before
    returning v.version_id`;
  const ok = new Set(done.map((r) => Number(r.version_id)));
  const audit = changes.filter((c) => ok.has(c.version_id)).map((c) => ({
    id: `${c.question_id} v${c.version_no}`,
    diff: { tier: { before: c.before, after: c.after }, judged_at: c.level !== null ? { level: c.level } : { placement_class: c.placement, level: null },
      strategy: c.strategy, highest_concept_class: c.max_concept_class },
  }));
  if (audit.length) await tx`
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label, import_id)
    select 'question_version', 'cms_question_versions', x.id, 'derived_update', ${o.reason}, x.diff, ${o.by}, ${o.importId}
      from jsonb_to_recordset(${tx.json(audit as never)}) as x(id text, diff jsonb)`;
  return ok.size;
}

// Q24 (Sambit, 17 Nov 2026): a concept's class = "first taught in".
//   new class = min(catalogued class, lowest Level of the book-derived questions that test it)   ("lower only", §10.1)
//   book-derived = production Math, not retired, current version with any source ref (modelled_on / same_idea);
//   "test it" = question or part concept, any involvement (as Q20).
// The catalogued class is class_legacy once set (kept forever), so a re-run is judged against the same catalogue and is
// idempotent. Concepts no book-derived question tests keep their class. With lowerOnly = false the rule as first
// written is used (the class may also go up); it is only for reports.
import type postgres from 'postgres';
import type { Sql } from './db.ts';

type Tx = Sql | postgres.TransactionSql;
export interface ConceptClassChange { concept_id: string; name: string; status: string; catalogued: number; before: number; after: number; book_questions: number }

export async function conceptClassChanges(tx: Tx, o: { lowerOnly?: boolean } = {}): Promise<ConceptClassChange[]> {
  const lowerOnly = o.lowerOnly ?? true;
  const rows = await tx`
    with bd as (
      select v.version_id, q.level
        from cms.cms_questions q
        join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
       where q.subject = 'math' and q.bank = 'production' and q.retired_at is null and q.level is not null
         and exists (select 1 from cms.cms_version_source_refs r where r.version_id = v.version_id)),
    lo as (
      select vc.concept_id, min(bd.level) as lowest, count(distinct bd.version_id) as n
        from cms.cms_version_concepts vc join bd on bd.version_id = vc.version_id
       group by vc.concept_id)
    select c.concept_id, c.name, c.status, coalesce(c.class_legacy, c.class) as catalogued, c.class as before, lo.lowest, lo.n
      from cms.cms_concepts c join lo on lo.concept_id = c.concept_id
     where c.subject = 'math'
     order by c.concept_id`;
  return rows.map((r) => {
    const catalogued = Number(r.catalogued), lowest = Number(r.lowest);
    const after = lowerOnly ? Math.min(catalogued, lowest) : lowest;
    return { concept_id: r.concept_id, name: r.name, status: r.status, catalogued, before: Number(r.before), after, book_questions: Number(r.n) };
  }).filter((c) => c.before !== c.after);
}

/** Write the new classes (only while the stored class still equals `before`), keep the catalogued class in class_legacy,
 *  and write one audit row per concept (before → after). */
export async function applyConceptClassChanges(tx: Tx, changes: ConceptClassChange[], o: { importId: number | null; reason: string; by: string }) {
  if (!changes.length) return 0;
  const data = changes.map((c) => ({ id: c.concept_id, before: c.before, after: c.after, catalogued: c.catalogued }));
  const done = await tx`
    update cms.cms_concepts c set class = x.after,
           class_legacy = coalesce(c.class_legacy, x.catalogued),
           class_basis = case when x.after = x.catalogued then 'catalogue' else 'first_taught' end,
           class_basis_at = now(), updated_at = now()
      from jsonb_to_recordset(${tx.json(data as never)}) as x(id text, before int, after int, catalogued int)
     where c.concept_id = x.id and c.class = x.before
    returning c.concept_id`;
  const ok = new Set(done.map((r) => String(r.concept_id)));
  const audit = changes.filter((c) => ok.has(c.concept_id)).map((c) => ({
    id: c.concept_id,
    diff: { class: { before: c.before, after: c.after }, class_legacy: c.catalogued, basis: 'first taught in: lowest Level of the book-derived questions that test it', book_questions: c.book_questions },
  }));
  if (audit.length) await tx`
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label, import_id)
    select 'catalogue', 'cms_concepts', x.id, 'derived_update', ${o.reason}, x.diff, ${o.by}, ${o.importId}
      from jsonb_to_recordset(${tx.json(audit as never)}) as x(id text, diff jsonb)`;
  return ok.size;
}

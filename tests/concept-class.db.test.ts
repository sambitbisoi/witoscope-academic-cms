// Q24 (17 Nov 2026): concept class = "first taught in" (lower only). Local DB, rolled back.
import type postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { connect } from '../scripts/lib/db.ts';
import { assertLocal, LOCAL_CMS_OWNER_URL } from '../scripts/local-bootstrap.ts';
import { applyConceptClassChanges, conceptClassChanges } from '../scripts/lib/concept-class.ts';
import { diffFingerprints, fingerprint } from '../scripts/lib/fingerprint.ts';
import { tierChanges } from '../scripts/lib/tier.ts';

assertLocal(LOCAL_CMS_OWNER_URL);
const sql = connect(LOCAL_CMS_OWNER_URL);
afterAll(() => sql.end());
class Done extends Error {}
const rolledBack = (fn: (tx: postgres.TransactionSql) => Promise<void>) =>
  sql.begin(async (tx) => { await fn(tx); throw new Done(); }).catch((e) => { if (!(e instanceof Done)) throw e; });

/** A concept tested by book-derived production Math current versions, with the lowest Level among them. */
async function bookConcept(tx: postgres.TransactionSql) {
  const [c] = await tx`
    select vc.concept_id, min(q.level)::int as lowest
      from cms.cms_questions q
      join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
      join cms.cms_version_concepts vc on vc.version_id = v.version_id
     where q.subject = 'math' and q.bank = 'production' and q.retired_at is null and q.level between 2 and 5
       and exists (select 1 from cms.cms_version_source_refs r where r.version_id = v.version_id)
     group by vc.concept_id having min(q.level) between 2 and 5 order by vc.concept_id limit 1`;
  return { id: c!.concept_id as string, lowest: Number(c!.lowest) };
}

describe('Q24 concept class = first taught in (local, rolled back)', () => {
  it('lowers a class above the lowest book Level, keeps the catalogued class, audits it; a second run changes nothing', async () => {
    await rolledBack(async (tx) => {
      const c = await bookConcept(tx);
      await tx`update cms.cms_concepts set class = ${c.lowest + 1}, class_legacy = null, class_basis = 'catalogue' where concept_id = ${c.id}`;
      const changes = await conceptClassChanges(tx);
      const mine = changes.find((x) => x.concept_id === c.id)!;
      expect(mine).toMatchObject({ before: c.lowest + 1, after: c.lowest, catalogued: c.lowest + 1 });
      const [m] = await tx`select coalesce(max(review_id), 0)::bigint as m from cms.cms_reviews`;
      expect(await applyConceptClassChanges(tx, changes, { importId: null, reason: 'test', by: 'test' })).toBe(changes.length);
      const [row] = await tx`select class, class_legacy, class_basis from cms.cms_concepts where concept_id = ${c.id}`;
      expect(row).toMatchObject({ class: c.lowest, class_legacy: c.lowest + 1, class_basis: 'first_taught' });
      const [a] = await tx`select count(*)::int as n from cms.cms_reviews where review_id > ${m!.m} and action = 'derived_update' and target = 'catalogue'`;
      expect(a!.n).toBe(changes.length);
      expect(await conceptClassChanges(tx)).toEqual([]);
      expect(await applyConceptClassChanges(tx, changes, { importId: null, reason: 'test', by: 'test' })).toBe(0);
    });
  });

  it('never raises a class (lower only); the rule as first written would', async () => {
    await rolledBack(async (tx) => {
      const c = await bookConcept(tx);
      await tx`update cms.cms_concepts set class = ${c.lowest - 1}, class_legacy = null, class_basis = 'catalogue' where concept_id = ${c.id}`;
      expect((await conceptClassChanges(tx)).find((x) => x.concept_id === c.id)).toBeUndefined();
      expect((await conceptClassChanges(tx, { lowerOnly: false })).find((x) => x.concept_id === c.id)).toMatchObject({ before: c.lowest - 1, after: c.lowest });
    });
  });

  it('writes only the class columns and reviews (fingerprint), and the preview override gives the same tiers as writing', async () => {
    await rolledBack(async (tx) => {
      const c = await bookConcept(tx);
      await tx`update cms.cms_concepts set class = 6, class_legacy = null, class_basis = 'catalogue' where concept_id = ${c.id}`;
      const changes = await conceptClassChanges(tx);
      const preview = await tierChanges(tx, undefined, new Map(changes.map((x) => [x.concept_id, x.after])));
      const opts = { exclude: { cms_concepts: ['class', 'class_legacy', 'class_basis', 'class_basis_at', 'updated_at'] } };
      const before = await fingerprint(tx, opts);
      await applyConceptClassChanges(tx, changes, { importId: null, reason: 'test', by: 'test' });
      expect(diffFingerprints(before, await fingerprint(tx, opts), ['cms_reviews'])).toEqual([]);
      const after = await tierChanges(tx);
      const k = (t: { version_id: number; after: string }) => `${t.version_id} ${t.after}`;
      expect(after.map(k).sort()).toEqual(preview.map(k).sort());
    });
  });

  it('the DB refuses first_taught without the catalogued class', async () => {
    await rolledBack(async (tx) => {
      const c = await bookConcept(tx);
      await expect(tx`update cms.cms_concepts set class_basis = 'first_taught', class_legacy = null where concept_id = ${c.id}`).rejects.toThrow(/first_taught_legacy/);
    });
  });
});

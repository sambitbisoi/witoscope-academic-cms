// Q20 (17 Nov 2026): Tier uses Level. The SQL rule (scripts/lib/tier.ts) equals shared/derive.ts, and the
// recompute is idempotent and audited (local DB, rolled back).
import { afterAll, describe, expect, it } from 'vitest';
import { loadBundle } from '../scripts/lib/bundle.ts';
import { connect } from '../scripts/lib/db.ts';
import { assertLocal, LOCAL_CMS_OWNER_URL } from '../scripts/local-bootstrap.ts';
import { applyTierChanges, tierChanges } from '../scripts/lib/tier.ts';
import { derive, tierBasis } from '../shared/derive.ts';
import { questionFromDb } from '../shared/fromDb.ts';
import type { DerivedConfig } from '../shared/types.ts';

assertLocal(LOCAL_CMS_OWNER_URL);
const sql = connect(LOCAL_CMS_OWNER_URL);
afterAll(() => sql.end());
class Done extends Error {}

describe('Q20 tier (local, rolled back)', () => {
  it('the SQL rule agrees with derive() on 300 Math versions (Level or placement as the basis)', async () => {
    const cfg = Object.fromEntries((await sql`select key, value from cms.cms_config where key in ('multistep_bands', 'difficulty_points', 'load_thresholds')`).map((r) => [r.key, r.value])) as unknown as DerivedConfig;
    const cc = new Map((await sql`select concept_id, class from cms.cms_concepts`).map((r) => [r.concept_id as string, Number(r.class)]));
    const vs = await sql`select v.version_id, q.question_id, q.level, q.class_override, q.class from cms.cms_question_versions v join cms.cms_questions q on q.question_id = v.question_id
      where v.tier is not null order by (q.level is null), v.version_id desc limit 300`;
    const off = new Map((await tierChanges(sql)).map((c) => [c.version_id, c.after]));
    const [stored] = [new Map((await sql`select version_id, tier from cms.cms_question_versions where version_id in ${sql(vs.map((v) => v.version_id))}`).map((r) => [Number(r.version_id), r.tier as string]))];
    let checked = 0;
    for (const v of vs) {
      const q = questionFromDb(await loadBundle(sql, Number(v.version_id)));
      const ts = derive(q, tierBasis({ level: v.level as number | null, class_override: v.class_override as number | null, class: Number(v.class) }), (id) => cc.get(id), cfg).tier;
      const sqlTier = off.get(Number(v.version_id)) ?? stored.get(Number(v.version_id));
      expect(`${v.question_id} ${ts}`).toBe(`${v.question_id} ${sqlTier}`);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('recompute writes only tier, one audit row each, and a second run changes nothing', async () => {
    await sql.begin(async (tx) => {
      const changes = await tierChanges(tx);
      const [m] = await tx`select coalesce(max(review_id), 0)::bigint as m from cms.cms_reviews`;
      const n = await applyTierChanges(tx, changes, { importId: null, reason: 'test', by: 'test' });
      expect(n).toBe(changes.length);
      expect(await tierChanges(tx)).toEqual([]);
      const [a] = await tx`select count(*)::int as n from cms.cms_reviews where review_id > ${m!.m} and action = 'derived_update'`;
      expect(a!.n).toBe(changes.length);
      expect(await applyTierChanges(tx, changes, { importId: null, reason: 'test', by: 'test' })).toBe(0);
      throw new Done();
    }).catch((e) => { if (!(e instanceof Done)) throw e; });
  });
});

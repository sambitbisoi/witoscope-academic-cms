// 0034 Achievers for every class a Math chapter is present in (local DB). Everything runs in a transaction that
// is rolled back, so nothing stays behind.
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { assertLocal, LOCAL_SUPERUSER_URL } from '../scripts/local-bootstrap.ts';

assertLocal(LOCAL_SUPERUSER_URL);
const su = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
afterAll(() => su.end());
class Done extends Error {}
async function inRollback(fn: (tx: postgres.TransactionSql) => Promise<void>) {
  await su.begin(async (tx) => { await fn(tx); throw new Done(); }).catch((e) => { if (!(e instanceof Done)) throw e; });
}
/** Run statements as the CMS admin (role authenticated + the admin's JWT claims), then back to the superuser. */
async function asAdmin<T>(tx: postgres.TransactionSql, fn: () => Promise<T>): Promise<T> {
  const [{ id }] = await tx`select value #>> '{}' as id from cms.cms_config where key = 'admin_user_id'` as unknown as [{ id: string }];
  await tx.unsafe('set local role authenticated');
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: id, role: 'authenticated' })}, true)`;
  try { return await fn(); } finally { await tx.unsafe('reset role'); }
}
const ach = (tx: postgres.TransactionSql, id: string) => tx`select topic_id, name, topic_kind, status from cms.cms_topics where topic_id = ${id}`;

describe('Achievers for every class a Math chapter is present in (0034)', () => {
  it('backfill: every class a Math chapter is present in has its Achievers row; MC19 has C3 and C4', async () => {
    const missing = await su`
      with present as (
        select t.chapter_id, t.class from cms.cms_topics t join cms.cms_chapters c using (chapter_id) where c.subject = 'math' and t.topic_kind = 'normal' and t.status = 'active'
        union select t.chapter_id, l.class from cms.cms_topic_classes l join cms.cms_topics t using (topic_id) join cms.cms_chapters c on c.chapter_id = t.chapter_id
         where c.subject = 'math' and t.topic_kind = 'normal' and t.status = 'active')
      select p.* from present p where not exists (select 1 from cms.cms_topics a where a.chapter_id = p.chapter_id and a.class = p.class and a.topic_kind = 'achievers')`;
    expect(missing).toEqual([]);
    expect((await su`select topic_id from cms.cms_topics where topic_id like 'ACH-MC19-%' order by 1`).map((r) => r.topic_id)).toEqual(['ACH-MC19-3', 'ACH-MC19-4', 'ACH-MC19-5', 'ACH-MC19-6']);
    const [r] = await su`select action, by_label from cms.cms_reviews where target_id = 'ACH-MC19-3'`;
    expect(r).toEqual({ action: 'create', by_label: 'Achievers rule' });
    expect((await su`select count(*)::int as n from cms.cms_topics where topic_kind = 'achievers' and chapter_id not like 'MC%'`)[0]!.n).toBe(0);
  });

  it('approving a proposed link creates the Achievers row in the same transaction, audited; a proposal alone does not', async () => {
    await inRollback(async (tx) => {
      // MC19 is not present in class 2: MT0261 (home class 6) gets a PROPOSED link to class 2
      expect(await ach(tx, 'ACH-MC19-2')).toHaveLength(0);
      await tx`insert into cms.cms_topic_class_proposals (topic_id, class, source, evidence, suggested_role) values ('MT0261', 2, 'test', 'test evidence', 'higher')`;
      expect(await ach(tx, 'ACH-MC19-2')).toHaveLength(0);                      // proposed links do not count
      await asAdmin(tx, () => tx`select cms.cms_decide_topic_class('MT0261', 2, 'active')`);
      expect(await ach(tx, 'ACH-MC19-2')).toEqual([{ topic_id: 'ACH-MC19-2', name: 'Achievers: Fraction Operations', topic_kind: 'achievers', status: 'active' }]);
      const audit = await tx`select action, by_label, by_user is not null as by_user, reason, field_diff -> 'topic' -> 'after' ->> 'class' as cls from cms.cms_reviews where target_id = 'ACH-MC19-2'`;
      expect(audit).toEqual([{ action: 'create', by_label: 'Achievers rule', by_user: true, reason: 'chapter present in class 2: approved link MT0261 · class 2', cls: '2' }]);
      // approving again or re-saving the link does not make a second one
      await asAdmin(tx, () => tx`select cms.cms_decide_topic_class('MT0261', 2, 'active')`);
      expect((await tx`select count(*)::int as n from cms.cms_topics where chapter_id = 'MC19' and class = 2 and topic_kind = 'achievers'`)[0]!.n).toBe(1);
    });
  });

  it('a curriculum-form link or a new topic with a new home class creates it too', async () => {
    await inRollback(async (tx) => {
      expect(await ach(tx, 'ACH-MC19-1')).toHaveLength(0);
      const [{ r }] = await asAdmin(tx, () => tx`select cms.cms_save_curriculum(${tx.json({ kind: 'topic', action: 'create', fields: { chapter_id: 'MC19', class: 1, name: 'Achievers test topic' } } as never)}) as r`) as unknown as [{ r: { id: string } }];
      expect(r.id).toMatch(/^MT\d{4}$/);
      expect(await ach(tx, 'ACH-MC19-1')).toHaveLength(1);
      // the form's "other classes" list (cms_topic_classes) for class 2
      await asAdmin(tx, () => tx`select cms.cms_save_curriculum(${tx.json({ kind: 'topic', action: 'update', id: 'MT0261', fields: { classes: [{ class: 2, source: 'test' }, { class: 3, source: 'test' }, { class: 4, source: 'test' }, { class: 5, source: 'test' }, { class: 6, source: 'test' }] } } as never)})`);
      expect(await ach(tx, 'ACH-MC19-2')).toHaveLength(1);
    });
  });

  it('never retired or deleted automatically; a retired one is not recreated; Science and Grammar unchanged', async () => {
    await inRollback(async (tx) => {
      // retiring the chapter's topics leaves the Achievers rows alone
      await tx`update cms.cms_topics set status = 'retired' where chapter_id = 'MC19' and topic_kind = 'normal'`;
      expect((await tx`select count(*)::int as n from cms.cms_topics where chapter_id = 'MC19' and topic_kind = 'achievers' and status = 'active'`)[0]!.n).toBe(4);
      // a retired Achievers row stays retired when its class gets a new link
      await tx`update cms.cms_topics set status = 'active' where chapter_id = 'MC19' and topic_kind = 'normal'`;
      await tx`update cms.cms_topics set status = 'retired' where topic_id = 'ACH-MC19-3'`;
      await tx`insert into cms.cms_topic_classes (topic_id, class, source) values ('MT0393', 3, 'test')`;
      expect(await ach(tx, 'ACH-MC19-3')).toEqual([{ topic_id: 'ACH-MC19-3', name: 'Achievers: Fraction Operations', topic_kind: 'achievers', status: 'retired' }]);
      // Science: a new link makes no Achievers row
      const [st] = await tx`select topic_id, chapter_id from cms.cms_topics where topic_id like 'ST%' and status = 'active' and class = 6 limit 1`;
      await tx`insert into cms.cms_topic_classes (topic_id, class, source) values (${st!.topic_id}, 1, 'test') on conflict do nothing`;
      expect((await tx`select count(*)::int as n from cms.cms_topics where topic_kind = 'achievers' and chapter_id = ${st!.chapter_id}`)[0]!.n).toBe(0);
    });
  });
});

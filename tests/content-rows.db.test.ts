// Q14 (17 Nov 2026): content rows and misconception items edited in the CMS (cms_save_content_row). Local DB, rolled back.
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { assertLocal, LOCAL_SUPERUSER_URL } from '../scripts/local-bootstrap.ts';

assertLocal(LOCAL_SUPERUSER_URL);
const su = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
afterAll(() => su.end());
class Done extends Error {}
const OTHER = '00000000-0000-4000-8000-000000000002';

/** As the admin (or another user), inside one transaction that is always rolled back. */
async function asUser(uid: string | 'admin', fn: (tx: postgres.TransactionSql, save: (p: unknown) => Promise<Record<string, unknown>>) => Promise<void>) {
  await su.begin(async (tx) => {
    const [a] = await tx`select value #>> '{}' as id from cms.cms_config where key = 'admin_user_id'`;
    await tx.unsafe('set local role authenticated');
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid === 'admin' ? a!.id : uid, role: 'authenticated' })}, true)`;
    // each call in its own savepoint, so an expected refusal does not abort the test's transaction
    const save = async (p: unknown) => (await tx.savepoint((sp) => sp`select cms.cms_save_content_row(${sp.json(p as never)}) as r`))[0]!.r as Record<string, unknown>;
    await fn(tx, save);
    throw new Done();
  }).catch((e) => { if (!(e instanceof Done)) throw e; });
}
const fields = { row_class: 6, type: 'Fact', chapter_role: 'Core', content: 'A test fact in our own words.', question_use: 'OK' };

async function aTopicWithRows(tx: postgres.TransactionSql) {
  const [r] = await tx`select r.topic_id, r.row_class, split_part(r.row_id, '-', 2) as code from cms.cms_content_rows r where r.retired_at is null order by r.row_id limit 1`;
  return r as { topic_id: string; row_class: number; code: string } | undefined;
}

describe('Q14 content rows (local, rolled back)', () => {
  it('creates rows with the next ID of a topic code or the CMS series, audited, no originality', async () => {
    await asUser('admin', async (tx, save) => {
      const t = await aTopicWithRows(tx); if (!t) return;
      const prefix = `C${t.row_class}-${t.code}-`;
      const [m] = await tx`select max(substring(row_id from '-([0-9]{3})$')::int) as n from cms.cms_content_rows where row_id like ${prefix + '%'}`;
      const a = await save({ mode: 'create', topic_id: t.topic_id, code: t.code, fields: { ...fields, row_class: t.row_class },
        items: [{ item_no: null, action: 'add', text: 'First belief.' }, { item_no: null, action: 'add', text: 'Second belief.' }] });
      expect(a.row_id).toBe(`${prefix}${String(Number(m!.n) + 1).padStart(3, '0')}`);
      const [row] = await tx`select * from cms.cms_content_rows where row_id = ${a.row_id as string}`;
      expect([row!.source, row!.originality_result, row!.misconceptions, row!.cms_edited_at !== null]).toEqual(['CMS', null, 'First belief. Second belief.', true]);
      const items = await tx`select item_no, text, status, source from cms.cms_row_misconceptions where row_id = ${a.row_id as string} order by 1`;
      expect(items.map((i) => `${i.item_no} ${i.status} ${i.source}`)).toEqual(['1 active cms', '2 active cms']);
      const aud = await tx`select action, target_table from cms.cms_reviews where target_id like ${`${a.row_id}%`} order by review_id`;
      expect(aud.map((x) => `${x.target_table} ${x.action}`)).toEqual(['cms_row_misconceptions create', 'cms_row_misconceptions create', 'cms_content_rows create']);
      const b = await save({ mode: 'create', topic_id: t.topic_id, code: 'CMS', fields: { ...fields, row_class: t.row_class } });
      expect(b.row_id).toMatch(new RegExp(`^C${t.row_class}-CMS-\\d{3}$`));
      await expect(save({ mode: 'create', topic_id: t.topic_id, code: 'ZZZ', fields: { ...fields, row_class: t.row_class } })).rejects.toThrow(/not used by the Class/);
    });
  });

  it('edits fields and items in place; numbers are never reused; the legacy text follows the active items', async () => {
    await asUser('admin', async (tx, save) => {
      const t = await aTopicWithRows(tx); if (!t) return;
      const { row_id: id } = await save({ mode: 'create', topic_id: t.topic_id, code: 'CMS', fields: { ...fields, row_class: t.row_class },
        items: [{ item_no: null, action: 'add', text: 'One.' }, { item_no: null, action: 'add', text: 'Two.' }] }) as { row_id: string };
      const u = await save({ mode: 'update', row_id: id, fields: { content: 'Changed content.', safety: 'Adult help.' },
        items: [{ item_no: 1, action: 'edit', text: 'One, reworded.' }, { item_no: 2, action: 'retire' }, { item_no: null, action: 'add', text: 'Three.' }] });
      expect(u.changed).toBe(true);
      const [row] = await tx`select content, safety, misconceptions from cms.cms_content_rows where row_id = ${id}`;
      expect([row!.content, row!.safety, row!.misconceptions]).toEqual(['Changed content.', 'Adult help.', 'One, reworded. Three.']);
      const items = await tx`select item_no, status from cms.cms_row_misconceptions where row_id = ${id} order by 1`;
      expect(items.map((i) => `${i.item_no}:${i.status}`)).toEqual(['1:active', '2:retired', '3:active']);
      expect((await save({ mode: 'update', row_id: id, fields: { content: 'Changed content.' } })).changed).toBe(false);
      await expect(save({ mode: 'update', row_id: id, fields: { also_in_rows: ['C9-ZZ-999'] } })).rejects.toThrow(/not a content row|row_id_check|C9/);
      const [d] = await tx`select field_diff from cms.cms_reviews where target_id = ${id} and action = 'science_row' order by review_id desc limit 1`;
      expect(Object.keys(d!.field_diff as object).sort()).toEqual(['content', 'misconceptions', 'safety']);
    });
  });

  it('retire: needs a reason, blocked while a current question uses the row as direct; restore', async () => {
    await asUser('admin', async (tx, save) => {
      const [used] = await tx`select l.row_id, q.question_id from cms.cms_question_content_rows l join cms.cms_question_versions v on v.version_id = l.version_id
        join cms.cms_questions q on q.question_id = v.question_id and q.current_version = v.version_no and q.retired_at is null where l.role = 'direct' limit 1`;
      if (used) await expect(save({ mode: 'retire', row_id: used.row_id, reason: 'test' })).rejects.toThrow(new RegExp(`direct row of .*${used.question_id}`));
      const t = await aTopicWithRows(tx); if (!t) return;
      const { row_id: id } = await save({ mode: 'create', topic_id: t.topic_id, code: 'CMS', fields: { ...fields, row_class: t.row_class } }) as { row_id: string };
      await expect(save({ mode: 'retire', row_id: id })).rejects.toThrow(/needs a reason/);
      await save({ mode: 'retire', row_id: id, reason: 'duplicate' });
      await expect(save({ mode: 'update', row_id: id, fields: { content: 'x' } })).rejects.toThrow(/retired/);
      await save({ mode: 'restore', row_id: id, reason: 'needed after all' });
      const [r] = await tx`select retired_at from cms.cms_content_rows where row_id = ${id}`;
      expect(r!.retired_at).toBeNull();
      const aud = await tx`select action from cms.cms_reviews where target_id = ${id} order by review_id`;
      expect(aud.map((x) => x.action)).toEqual(['create', 'retire', 'restore']);
    });
  });

  it('a row with misconception text but no items keeps its text when edited (nothing is lost)', async () => {
    await asUser('admin', async (tx, save) => {
      const [r] = await tx`select row_id, misconceptions from cms.cms_content_rows r where r.retired_at is null and btrim(coalesce(r.misconceptions, '')) <> ''
        and not exists (select 1 from cms.cms_row_misconceptions m where m.row_id = r.row_id) limit 1`;
      if (!r) return;
      await save({ mode: 'update', row_id: r.row_id, fields: { notes: 'test note' } });
      const [a] = await tx`select misconceptions from cms.cms_content_rows where row_id = ${r.row_id}`;
      expect(a!.misconceptions).toBe(r.misconceptions);
    });
  });

  it('only the admin can save', async () => {
    await asUser(OTHER, async (_tx, save) => {
      await expect(save({ mode: 'create', topic_id: 'ST0325', code: 'CMS', fields })).rejects.toThrow(/Only the CMS admin/);
    });
  });
});

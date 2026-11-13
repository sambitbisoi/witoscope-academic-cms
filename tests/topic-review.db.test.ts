// Review status per topic (13 Nov 2026): cms_set_topic_review is admin only, logs before → after,
// skips the log when nothing changes, and never deletes a row. Local DB; the test topic is restored.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from '../scripts/lib/db.ts';
import { assertLocal, LOCAL_CMS_OWNER_URL, LOCAL_SUPERUSER_URL } from '../scripts/local-bootstrap.ts';

assertLocal(LOCAL_SUPERUSER_URL);
const owner = connect(LOCAL_CMS_OWNER_URL);
const su = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
const TOPIC = 'MT0445';
let adminId = '';
let firstReview = 0;

const setReview = (status: string, note: string | null, uid = adminId) => su.begin(async (tx) => {
  await tx.unsafe('set local role authenticated');
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`;
  return (await tx`select cms.cms_set_topic_review(${TOPIC}, ${status}, ${note}) as r`)[0]!.r as { changed: boolean };
});
const logs = () => owner`select field_diff, reason from cms.cms_reviews where target_table = 'cms_topic_reviews' and target_id = ${TOPIC} and review_id > ${firstReview} order by review_id`;

beforeAll(async () => {
  adminId = (await owner`select value #>> '{}' as id from cms.cms_config where key = 'admin_user_id'`)[0]!.id;
  const have = await owner`select 1 from cms.cms_topic_reviews where topic_id = ${TOPIC}`;
  if (have.length) throw new Error(`${TOPIC} already has a review status; pick another test topic`);
  firstReview = Number((await owner`select coalesce(max(review_id), 0) as m from cms.cms_reviews`)[0]!.m);
});
afterAll(async () => {
  await owner`delete from cms.cms_reviews where target_table = 'cms_topic_reviews' and target_id = ${TOPIC} and review_id > ${firstReview}`;
  await owner`delete from cms.cms_topic_reviews where topic_id = ${TOPIC}`;
  await Promise.all([owner.end(), su.end()]);
});

describe('cms_set_topic_review', () => {
  it('sets a status and logs before → after', async () => {
    expect(await setReview('in_progress', '  checked MC03 so far ')).toMatchObject({ changed: true });
    const [row] = await owner`select status, note, updated_by from cms.cms_topic_reviews where topic_id = ${TOPIC}`;
    expect(row).toMatchObject({ status: 'in_progress', note: 'checked MC03 so far', updated_by: adminId });
    expect((await logs()).map((l) => l.field_diff.status)).toEqual([{ before: 'not_started', after: 'in_progress' }]);
  });
  it('no change → no log', async () => {
    expect(await setReview('in_progress', 'checked MC03 so far')).toMatchObject({ changed: false });
    expect(await logs()).toHaveLength(1);
  });
  it('done, then back to not started keeps the row (never deleted)', async () => {
    await setReview('done', null);
    await setReview('not_started', null);
    const [row] = await owner`select status, note from cms.cms_topic_reviews where topic_id = ${TOPIC}`;
    expect(row).toMatchObject({ status: 'not_started', note: null });
    expect((await logs()).map((l) => `${l.field_diff.status.before}→${l.field_diff.status.after}`)).toEqual(['not_started→in_progress', 'in_progress→done', 'done→not_started']);
  });
  it('refuses a non-admin, an unknown status and an unknown topic', async () => {
    await expect(setReview('done', null, '00000000-0000-0000-0000-000000000001')).rejects.toThrow(/Only the CMS admin/);
    await expect(setReview('finished', null)).rejects.toThrow(/Unknown review status/);
    await expect(su.begin(async (tx) => {
      await tx.unsafe('set local role authenticated');
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: adminId, role: 'authenticated' })}, true)`;
      await tx`select cms.cms_set_topic_review('MT9998', 'done', null)`;
    })).rejects.toThrow(/does not exist/);
  });
  it('authenticated cannot write the table directly', async () => {
    await expect(su.begin(async (tx) => {
      await tx.unsafe('set local role authenticated');
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: adminId, role: 'authenticated' })}, true)`;
      await tx`update cms.cms_topic_reviews set status = 'done' where topic_id = ${TOPIC}`;
    })).rejects.toThrow(/permission denied/);
  });
});

// Sequencing (13 Nov 2026): cms_save_order: no crossing, core only, hidden items keep their slot, audit.
// Test strands math-ZS / math-ZT, chapters MC87 / MC88 and topics MT9960–MT9965 are made and removed.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from '../scripts/lib/db.ts';
import { assertLocal, LOCAL_CMS_OWNER_URL, LOCAL_SUPERUSER_URL } from '../scripts/local-bootstrap.ts';

assertLocal(LOCAL_SUPERUSER_URL);
const owner = connect(LOCAL_CMS_OWNER_URL);
const su = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
let adminId = '';
const T = ['MT9960', 'MT9961', 'MT9962', 'MT9963', 'ACH-MC88-6', 'MT9965'];

const save = (lists: unknown[], uid = adminId, cls = 6) => su.begin(async (tx) => {
  await tx.unsafe('set local role authenticated');
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`;
  return (await tx`select cms.cms_save_order(${tx.json({ subject: 'math', class: cls, lists } as never)}) as r`)[0]!.r;
});
const topicOrder = async () => (await owner`select topic_id from cms.cms_topic_order where class = 6 and chapter_id = 'MC88' order by position`).map((r) => r.topic_id);

async function cleanup() {
  await owner`delete from cms.cms_reviews where action = 'reorder' and target_id like any (${['math C6 math-ZS%', 'math C6 MC88%', 'math C6 strands']}) and at > now() - interval '1 hour' and field_diff::text like '%ZS%' or (action = 'reorder' and field_diff::text like '%MT996%')`;
  await owner`delete from cms.cms_topic_order where topic_id = any(${T})`;
  await owner`delete from cms.cms_chapter_order where chapter_id in ('MC87', 'MC88')`;
  await owner`delete from cms.cms_strand_order where strand_id in ('math-ZS', 'math-ZT')`;
  await owner`delete from cms.cms_topics where topic_id = any(${T})`;
  await owner`delete from cms.cms_reviews where target_id like 'ACH-%' and split_part(target_id, '-', 2) = any(${['MC87', 'MC88']})`;
  await owner`delete from cms.cms_topics where topic_kind = 'achievers' and chapter_id = any(${['MC87', 'MC88']})`; // 0034: Achievers rows the trigger made
  await owner`delete from cms.cms_chapters where chapter_id in ('MC87', 'MC88')`;
  await owner`delete from cms.cms_strands where strand_id in ('math-ZS', 'math-ZT')`;
}
beforeAll(async () => {
  adminId = (await owner`select value #>> '{}' as id from cms.cms_config where key = 'admin_user_id'`)[0]!.id;
  await cleanup();
  await owner`insert into cms.cms_strands (strand_id, subject, code, name, sort) values ('math-ZS', 'math', 'ZS', 'Test strand S', 97), ('math-ZT', 'math', 'ZT', 'Test strand T', 98)`;
  await owner`insert into cms.cms_chapters (chapter_id, subject, strand_id, name, sort) values ('MC88', 'math', 'math-ZS', 'Test chapter 88', 97), ('MC87', 'math', 'math-ZT', 'Test chapter 87', 98)`;
  await owner`insert into cms.cms_topics (topic_id, chapter_id, class, name, topic_kind, status) values
    ('MT9960', 'MC88', 6, 'A', 'normal', 'active'), ('MT9961', 'MC88', 6, 'B (retired)', 'normal', 'retired'), ('MT9962', 'MC88', 6, 'C', 'normal', 'active'),
    ('MT9963', 'MC88', 5, 'From class 5', 'normal', 'active'), ('ACH-MC88-6', 'MC88', 6, 'Achievers', 'achievers', 'active'), ('MT9965', 'MC87', 6, 'Other chapter', 'normal', 'active')`;
  await owner`insert into cms.cms_topic_order (class, topic_id, chapter_id, position) values (6, 'MT9960', 'MC88', 1), (6, 'MT9961', 'MC88', 2), (6, 'MT9962', 'MC88', 3)`;
});
afterAll(async () => { await cleanup(); await Promise.all([owner.end(), su.end()]); });

describe('cms_save_order', () => {
  it('reorders topics within their chapter; a hidden (retired) topic keeps its slot; the change is audited', async () => {
    await save([{ level: 'topic', parent_id: 'MC88', ids: ['MT9962', 'MT9960'] }]);
    expect(await topicOrder()).toEqual(['MT9962', 'MT9961', 'MT9960']);
    const [log] = await owner`select action, field_diff from cms.cms_reviews where target_table = 'cms_topic_order' and target_id = 'math C6 MC88 topics' order by review_id desc limit 1`;
    expect(log!.field_diff.order).toEqual({ before: ['MT9960', 'MT9961', 'MT9962'], after: ['MT9962', 'MT9961', 'MT9960'] });
  });
  it('no change → nothing written or logged', async () => {
    expect(await save([{ level: 'topic', parent_id: 'MC88', ids: ['MT9962', 'MT9960'] }])).toMatchObject({ lists_changed: 0 });
  });
  it('no crossing: a topic only within its chapter, a chapter only within its strand', async () => {
    await expect(save([{ level: 'topic', parent_id: 'MC88', ids: ['MT9965', 'MT9960'] }])).rejects.toThrow(/moves only within its own chapter/);
    await expect(save([{ level: 'chapter', parent_id: 'math-ZS', ids: ['MC87', 'MC88'] }])).rejects.toThrow(/moves only within its own strand/);
  });
  it('only core topics are sequenced; the Achievers row is not', async () => {
    await expect(save([{ level: 'topic', parent_id: 'MC88', ids: ['MT9963', 'MT9960'] }])).rejects.toThrow(/only core topics/);
    await expect(save([{ level: 'topic', parent_id: 'MC88', ids: ['ACH-MC88-6', 'MT9960'] }])).rejects.toThrow(/Achievers/);
  });
  it('strands of the subject only; a new strand goes where the list puts it', async () => {
    await expect(save([{ level: 'strand', ids: ['science-LIV'] }])).rejects.toThrow(/not a math strand/);
    const before = (await owner`select strand_id from cms.cms_strand_order where class = 6 and subject = 'math' order by position`).map((r) => r.strand_id);
    await save([{ level: 'strand', ids: ['math-ZS', ...before] }]);
    const after = (await owner`select strand_id from cms.cms_strand_order where class = 6 and subject = 'math' order by position`).map((r) => r.strand_id);
    expect(after).toEqual(['math-ZS', ...before]);
    await save([{ level: 'strand', ids: [...before, 'math-ZS'] }]); // put it back at the end
    await owner`delete from cms.cms_strand_order where strand_id = 'math-ZS'`;
    await save([{ level: 'strand', ids: before }]);
    expect((await owner`select strand_id from cms.cms_strand_order where class = 6 and subject = 'math' order by position`).map((r) => r.strand_id)).toEqual(before);
  });
  it('admin only; one class and one subject', async () => {
    await expect(save([{ level: 'topic', parent_id: 'MC88', ids: ['MT9960'] }], '00000000-0000-0000-0000-000000000001')).rejects.toThrow(/Only the CMS admin/);
    await expect(save([], adminId, 9)).rejects.toThrow(/one class and one subject/);
  });
});

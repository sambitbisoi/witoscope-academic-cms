// R1 (13 Nov 2026): every topic–class link has a role from the topic's home class (local DB, read-only).
import { afterAll, describe, expect, it } from 'vitest';
import { connect } from '../scripts/lib/db.ts';
import { assertLocal, LOCAL_CMS_OWNER_URL } from '../scripts/local-bootstrap.ts';

assertLocal(LOCAL_CMS_OWNER_URL);
const sql = connect(LOCAL_CMS_OWNER_URL);
afterAll(() => sql.end());

describe('topic–class roles', () => {
  it('core = home class, lower = home < class, higher = home > class', async () => {
    const bad = await sql`select a.topic_id, a.class, a.role, t.class as home from cms.cms_topic_all_classes a join cms.cms_topics t using (topic_id)
      where a.home_class <> t.class or a.role <> case when t.class = a.class then 'core' when t.class < a.class then 'lower' else 'higher' end`;
    expect(bad).toEqual([]);
  });
  it('each topic has exactly one core link (its home class) and the stats view carries the role', async () => {
    const [x] = await sql`select (select count(*) from cms.cms_topics)::int as topics,
      (select count(*) from cms.cms_topic_all_classes where role = 'core')::int as core,
      (select count(*) from cms.cms_topic_class_stats)::int as stats, (select count(*) from cms.cms_topic_all_classes)::int as links,
      (select count(*) from cms.cms_topic_class_stats where role is null)::int as no_role`;
    expect(x!.core).toBe(x!.topics);
    expect(x!.stats).toBe(x!.links);
    expect(x!.no_role).toBe(0);
  });
});

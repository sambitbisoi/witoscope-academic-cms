// D5: cms_save_curriculum (local DB). Test rows are removed after; the cut-over flag is restored.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from '../scripts/lib/db.ts';
import { assertLocal, LOCAL_CMS_OWNER_URL, LOCAL_SUPERUSER_URL } from '../scripts/local-bootstrap.ts';

assertLocal(LOCAL_SUPERUSER_URL);
const owner = connect(LOCAL_CMS_OWNER_URL);
const su = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
let adminId = '';
const made: { chapters: string[]; topics: string[]; concepts: string[]; sets: string[]; patterns: string[] } = { chapters: [], topics: [], concepts: [], sets: [], patterns: [] };
let ownerBefore: unknown = null;

const save = (p: unknown, uid = adminId) => su.begin(async (tx) => {
  await tx.unsafe('set local role authenticated');
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`;
  return (await tx`select cms.cms_save_curriculum(${tx.json(p as never)}) as r`)[0]!.r as { id: string; changed: boolean };
});
const setOwner = (v: string) => owner`update cms.cms_config set value = ${owner.json(v as never)} where key = 'curriculum_owner'`;

async function cleanup() {
  const all = [...made.chapters, ...made.topics, ...made.concepts, ...made.sets, ...made.patterns, 'MT9993'];
  if (all.length) await owner`delete from cms.cms_reviews where target_id = any(${all})`;
  if (made.patterns.length) await owner`delete from cms.cms_patterns where pattern_id = any(${made.patterns})`;
  if (made.sets.length) await owner`delete from cms.cms_typical_sets where typical_set_id = any(${made.sets})`;
  if (made.concepts.length) await owner`delete from cms.cms_concepts where concept_id = any(${made.concepts})`;
  await owner`delete from cms.cms_topic_classes where topic_id = any(${[...made.topics, 'MT9993']})`;
  await owner`delete from cms.cms_topic_prereqs where topic_id = any(${[...made.topics, 'MT9993']})`;
  if (made.topics.length) await owner`delete from cms.cms_topics where topic_id = any(${made.topics})`;
  await owner`delete from cms.cms_topics where chapter_id = 'MC93'`;
  if (made.chapters.length) await owner`delete from cms.cms_chapters where chapter_id = any(${made.chapters})`;
  await owner`delete from cms.cms_chapters where chapter_id = 'MC93'`;
  await owner`delete from cms.cms_strands where strand_id = 'math-ZT'`;
}

beforeAll(async () => {
  adminId = (await owner`select value #>> '{}' as id from cms.cms_config where key = 'admin_user_id'`)[0]!.id;
  ownerBefore = (await owner`select value from cms.cms_config where key = 'curriculum_owner'`)[0]?.value ?? 'workbooks';
  await cleanup();
  await owner`insert into cms.cms_strands (strand_id, subject, code, name, sort) values ('math-ZT', 'math', 'ZT', 'Curriculum test strand', 993)`;
  await owner`insert into cms.cms_chapters (chapter_id, subject, strand_id, name, sort) values ('MC93', 'math', 'math-ZT', 'Curriculum test chapter', 993)`;
  await owner`insert into cms.cms_topics (topic_id, chapter_id, class, name) values ('MT9993', 'MC93', 5, 'Curriculum test topic')`;
});
afterAll(async () => { await setOwner(ownerBefore as string); await cleanup(); await Promise.all([owner.end(), su.end()]); });

describe('cms_save_curriculum (D5)', () => {
  it('before the cut-over: chapters and topics are read-only; topic classes and prerequisites can be edited', async () => {
    await setOwner('workbooks');
    await expect(save({ kind: 'chapter', action: 'create', fields: { subject: 'math', strand_id: 'math-ZT', name: 'x' } })).rejects.toThrow(/until the one-time cut-over/);
    await expect(save({ kind: 'topic', action: 'update', id: 'MT9993', fields: { name: 'renamed' } })).rejects.toThrow(/until the one-time cut-over/);
    const r = await save({ kind: 'topic', action: 'update', id: 'MT9993', fields: { classes: [{ class: 6, source: 'NCERT', evidence: 'test' }], prereqs: ['MT0001'] } });
    expect(r.changed).toBe(true);
    const [rev] = await owner`select action, field_diff from cms.cms_reviews where target_id = 'MT9993' order by review_id desc limit 1`;
    expect(rev!.action).toBe('edit_catalogue');
    expect(rev!.field_diff).toEqual({ classes: { before: [], after: [{ class: 6, source: 'NCERT', evidence: 'test' }] }, prereqs: { before: [], after: ['MT0001'] } });
    expect((await save({ kind: 'topic', action: 'update', id: 'MT9993', fields: { classes: [{ class: 6, source: 'NCERT', evidence: 'test' }] } })).changed).toBe(false);
  });

  it('only the admin', async () => {
    await expect(save({ kind: 'concept', action: 'create', fields: {} }, '00000000-0000-4000-8000-000000000001')).rejects.toThrow(/Only the CMS admin/);
  });

  it('after the cut-over: chapters and topics get automatic IDs; edits are audited before → after; retire and restore, never delete', async () => {
    await setOwner('cms');
    const ch = await save({ kind: 'chapter', action: 'create', fields: { subject: 'math', strand_id: 'math-ZT', name: 'Made in the CMS' } });
    made.chapters.push(ch.id);
    expect(ch.id).toMatch(/^MC\d{2}$/);
    const t = await save({ kind: 'topic', action: 'create', fields: { chapter_id: ch.id, class: 4, name: 'New topic', sub_skills: 'a; b' } });
    made.topics.push(t.id);
    expect(t.id).toMatch(/^MT\d{4}$/);
    const ach = await save({ kind: 'topic', action: 'create', fields: { chapter_id: ch.id, class: 4, name: 'Achievers', topic_kind: 'achievers' } });
    made.topics.push(ach.id);
    expect(ach.id).toBe(`ACH-${ch.id}-4`);
    await expect(save({ kind: 'topic', action: 'create', fields: { chapter_id: ch.id, class: 4, name: 'again', topic_kind: 'achievers' } })).rejects.toThrow(/already exists/);
    await save({ kind: 'topic', action: 'update', id: t.id, fields: { name: 'Renamed topic', topic_id: 'MT0001' }, reason: 'clearer name' });
    const [row] = await owner`select topic_id, name from cms.cms_topics where topic_id = ${t.id}`;
    expect(row).toEqual({ topic_id: t.id, name: 'Renamed topic' }); // the ID never changes
    const [rev] = await owner`select reason, field_diff from cms.cms_reviews where target_id = ${t.id} and action = 'edit_catalogue'`;
    expect(rev).toEqual({ reason: 'clearer name', field_diff: { name: { before: 'New topic', after: 'Renamed topic' } } });
    await save({ kind: 'topic', action: 'retire', id: t.id });
    expect((await owner`select status from cms.cms_topics where topic_id = ${t.id}`)[0]!.status).toBe('retired');
    await save({ kind: 'topic', action: 'restore', id: t.id });
    expect((await owner`select status from cms.cms_topics where topic_id = ${t.id}`)[0]!.status).toBe('active');
  });

  it('concepts, question types and patterns: automatic IDs, start proposed', async () => {
    const c1 = await save({ kind: 'concept', action: 'create', fields: { topic_id: 'MT9993', code: 'zyq', type: 'core', name: 'Test concept one' } });
    const c2 = await save({ kind: 'concept', action: 'create', fields: { topic_id: 'MT9993', code: 'ZYQ', type: 'core', name: 'Test concept two' } });
    const c3 = await save({ kind: 'concept', action: 'create', fields: { topic_id: 'MT9993', code: 'ZYQ', type: 'applied', name: 'Applied one' } });
    made.concepts.push(c1.id, c2.id, c3.id);
    expect([c1.id, c2.id, c3.id]).toEqual(['G5-ZYQ-C1', 'G5-ZYQ-C2', 'G5-ZYQ-A1']);
    const s1 = await save({ kind: 'typical_set', action: 'create', fields: { topic_id: 'MT9993', name: 'Zyq test: read the lift!' } });
    const s2 = await save({ kind: 'typical_set', action: 'create', fields: { topic_id: 'MT9993', name: 'Zyq test read the lift' } });
    made.sets.push(s1.id, s2.id);
    expect([s1.id, s2.id]).toEqual(['TS-G5-ZYQ-TEST-READ-THE-LIFT', 'TS-G5-ZYQ-TEST-READ-THE-LIFT-2']);
    const p = await save({ kind: 'pattern', action: 'create', fields: { topic_id: 'MT9993', typical_set_id: s1.id, name: 'Lift crossing zero', template: 'a − b < 0' } });
    made.patterns.push(p.id);
    expect(p.id).toMatch(/^MP\d{4}$/);
    const statuses = await owner`select status from cms.cms_concepts where concept_id = ${c1.id} union all select status from cms.cms_typical_sets where typical_set_id = ${s1.id} union all select status from cms.cms_patterns where pattern_id = ${p.id}`;
    expect(statuses.map((x) => x.status)).toEqual(['proposed', 'proposed', 'proposed']);
    await expect(save({ kind: 'concept', action: 'create', fields: { topic_id: 'MT9993', code: 'Z1', name: 'x' } })).rejects.toThrow(/2–4 capital letters/);
  });
});

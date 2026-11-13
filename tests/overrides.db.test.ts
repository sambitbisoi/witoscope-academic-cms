// Override requests (12 Nov 2026), local DB, test-only IDs (MC94 / MT9994x), removed after.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChapter } from '../scripts/import-chapter.ts';
import { connect } from '../scripts/lib/db.ts';
import { assertLocal, LOCAL_CMS_OWNER_URL, LOCAL_SUPERUSER_URL } from '../scripts/local-bootstrap.ts';

assertLocal(LOCAL_SUPERUSER_URL);
const sql = connect(LOCAL_CMS_OWNER_URL);
const su = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
let adminId = ''; let qid = ''; let vid = 0;
const as = <T>(uid: string, f: (tx: postgres.TransactionSql) => Promise<T>) => su.begin(async (tx) => {
  await tx.unsafe('set local role authenticated');
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`;
  return f(tx);
}) as Promise<T>;
const decide = (id: number, ok: boolean, note: string | null, uid = adminId) => as(uid, async (tx) => (await tx`select cms.cms_decide_override(${id}, ${ok}, ${note}) as r`)[0]!.r);
const approve = (uid = adminId) => as(uid, async (tx) => (await tx`select cms.cms_set_status(${qid}, 1, 'approve', null) as r`)[0]!.r);

async function cleanup() {
  const qids = (await sql`select question_id from cms.cms_questions where file_key like 'MC94-%'`).map((r) => r.question_id as string);
  if (qids.length) {
    const vids = (await sql`select version_id from cms.cms_question_versions where question_id = any(${qids})`).map((r) => r.version_id);
    await sql`delete from cms.cms_override_requests where question_id = any(${qids})`;
    for (const t of ['cms_version_parts', 'cms_version_options', 'cms_version_wrong_answers', 'cms_version_concepts', 'cms_version_solutions', 'cms_version_hints', 'cms_version_source_refs', 'cms_originality_checks'])
      await sql`delete from ${sql(`cms.${t}`)} where version_id = any(${vids})`;
    await sql`delete from cms.cms_reviews where target_id like any (${qids.flatMap((q) => [q, `${q} v%`])})`;
    await sql`delete from cms.cms_question_versions where question_id = any(${qids})`;
    await sql`delete from cms.cms_questions where question_id = any(${qids})`;
  }
  await sql`delete from cms.cms_reviews where import_id in (select import_id from cms.cms_imports where chapter_id = 'MC94')`;
  await sql`delete from cms.cms_imports where chapter_id = 'MC94'`;
  await sql`delete from cms.cms_typical_sets where typical_set_id = 'TS-G6-ZU-TEST'`;
  await sql`delete from cms.cms_misconceptions where misconception_id = 'G6-M-ZUZ1'`;
  await sql`delete from cms.cms_concepts where concept_id = 'G6-ZUZ-C1'`;
  await sql`delete from cms.cms_topics where chapter_id = 'MC94'`;
  await sql`delete from cms.cms_chapters where chapter_id = 'MC94'`;
  await sql`delete from cms.cms_strands where strand_id = 'math-ZU'`;
}
beforeAll(async () => {
  await cleanup();
  adminId = (await sql`select value #>> '{}' as id from cms.cms_config where key = 'admin_user_id'`)[0]!.id;
  await sql`insert into cms.cms_strands (strand_id, subject, code, name, sort) values ('math-ZU', 'math', 'ZU', 'Override test strand', 994)`;
  await sql`insert into cms.cms_chapters (chapter_id, subject, strand_id, name, sort) values ('MC94', 'math', 'math-ZU', 'Override test chapter', 994)`;
  await sql`insert into cms.cms_topics (topic_id, chapter_id, class, name) values ('MT9984', 'MC94', 6, 'Override test topic')`;
  await sql`insert into cms.cms_concepts (concept_id, subject, class, topic_id, name) values ('G6-ZUZ-C1', 'math', 6, 'MT9984', 'Test concept')`;
  await sql`insert into cms.cms_misconceptions (misconception_id, concept_id, description) values ('G6-M-ZUZ1', 'G6-ZUZ-C1', 'Test misconception')`;
  await sql`insert into cms.cms_typical_sets (typical_set_id, subject, class, chapter_id, topic_id, name) values ('TS-G6-ZU-TEST', 'math', 6, 'MC94', 'MT9984', 'Override test set')`;
  const f = JSON.parse(readFileSync('content/examples/MC19-example.json', 'utf8').replaceAll('MC19', 'MC94').replaceAll('MT0393', 'MT9984')
    .replaceAll('TS-G6-FRAC-ADD-UNLIKE', 'TS-G6-ZU-TEST').replaceAll('G6-M-FRC1', 'G6-M-ZUZ1').replaceAll('G6-FRC-C1', 'G6-ZUZ-C1'));
  delete f.questions[0].source_refs;
  const p = join(mkdtempSync(join(tmpdir(), 'cms-override-test-')), 'f.json'); writeFileSync(p, JSON.stringify(f));
  qid = (await runChapter(sql, p, 'import')).outcomes[0]!.question_id!;
  vid = Number((await sql`select version_id from cms.cms_question_versions where question_id = ${qid}`)[0]!.version_id);
});
afterAll(async () => { await cleanup(); await Promise.all([sql.end(), su.end()]); });

describe('override requests', () => {
  it('a near-copy blocks approval; a pending request does not change that', async () => {
    const [chk] = await sql`insert into cms.cms_originality_checks (version_id, checked_at, result, similarity, same_numbers, closest_ref, field, threshold, near_copy_threshold, tool)
      values (${vid}, now(), 'near_copy', 0.31, true, 'N5-10-009', 'options', 0.6, 0.85, 'check-originality 3') returning check_id`;
    const [req] = await sql`insert into cms.cms_override_requests (question_id, version_id, file_key, field, reason, requested_by, check_id)
      values (${qid}, ${vid}, 'MC94-0001', 'options', 'the options are the standard turn fractions the skill is about', 'test', ${chk!.check_id}) returning request_id`;
    await expect(approve()).rejects.toThrow(/near-copy/);
    await expect(sql`insert into cms.cms_override_requests (question_id, version_id, field, reason, requested_by) values (${qid}, ${vid}, 'options', 'again again', 'test')`).rejects.toThrow(/one_pending/);
    (globalThis as { req?: number }).req = Number(req!.request_id);
  });
  it('only the admin decides; declining needs a note', async () => {
    const id = (globalThis as { req?: number }).req!;
    await expect(decide(id, true, null, '00000000-0000-4000-8000-000000000001')).rejects.toThrow(/Only the CMS admin/);
    await expect(decide(id, false, ' ')).rejects.toThrow(/needs a note/);
  });
  it('approving logs override_near_copy with the reason; the question can then be approved; a request is decided once', async () => {
    const id = (globalThis as { req?: number }).req!;
    expect(await decide(id, true, 'checked against the book myself')).toMatchObject({ status: 'approved' });
    const [rev] = await sql`select action, reason, field_diff from cms.cms_reviews where target_table = 'cms_override_requests' and target_id = ${`${qid} v1`}`;
    expect(rev!.action).toBe('override_near_copy');
    expect(rev!.reason).toBe('the options are the standard turn fractions the skill is about — checked against the book myself');
    expect(rev!.field_diff).toMatchObject({ field: 'options', closest_ref: 'N5-10-009', override: 'reviewed, not a copy' });
    expect(await approve()).toMatchObject({ status: 'approved' });
    await expect(decide(id, false, 'no')).rejects.toThrow(/already approved/);
  });
});

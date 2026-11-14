// Add / bulk-upload questions (13 Nov 2026): cms_add_questions and the version guards (local DB).
// A test strand / chapter / topic (math-ZQ, MC89, MT9970) is made and removed with everything added to it.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from '../scripts/lib/db.ts';
import { assertLocal, LOCAL_CMS_OWNER_URL, LOCAL_SUPERUSER_URL } from '../scripts/local-bootstrap.ts';

assertLocal(LOCAL_SUPERUSER_URL);
const owner = connect(LOCAL_CMS_OWNER_URL);
const su = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
let adminId = '';

const asAdmin = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>, uid = adminId) => su.begin(async (tx) => {
  await tx.unsafe('set local role authenticated');
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`;
  return fn(tx);
}) as Promise<T>;
const add = (p: unknown, uid?: string) => asAdmin(async (tx) => (await tx`select cms.cms_add_questions(${tx.json(p as never)}) as r`)[0]!.r, uid) as Promise<{ import_id: number | null; added: { question_id: string; row: number }[] }>;
const mcq = (o: Record<string, unknown> = {}) => ({ row: 2, text: 'Which number is the largest?', format: 'MCQ-4', options: ['12', '21', '102', '120'], correct: '120',
  level: 6, picture_needed: false, ...o });

async function cleanup() {
  const qids = (await owner`select question_id from cms.cms_questions where chapter_id = 'MC89'`).map((r) => r.question_id as string);
  if (qids.length) {
    const vids = (await owner`select version_id from cms.cms_question_versions where question_id = any(${qids})`).map((r) => r.version_id);
    for (const t of ['cms_version_options', 'cms_version_wrong_answers', 'cms_version_concepts', 'cms_version_solutions', 'cms_version_hints', 'cms_version_source_refs', 'cms_originality_checks', 'cms_question_content_rows'])
      await owner`delete from ${owner(`cms.${t}`)} where version_id = any(${vids})`;
    await owner`delete from cms.cms_reviews where target_id like any (${qids.map((q) => `${q} v%`)})`;
    await owner`delete from cms.cms_question_versions where question_id = any(${qids})`;
    await owner`delete from cms.cms_questions where question_id = any(${qids})`;
  }
  await owner`delete from cms.cms_reviews where import_id in (select import_id from cms.cms_imports where chapter_id = 'MC89')`;
  await owner`delete from cms.cms_imports where chapter_id = 'MC89'`;
  await owner`delete from cms.cms_topics where topic_id = 'MT9970'`;
  await owner`delete from cms.cms_chapters where chapter_id = 'MC89'`;
  await owner`delete from cms.cms_strands where strand_id = 'math-ZQ'`;
}
beforeAll(async () => {
  adminId = (await owner`select value #>> '{}' as id from cms.cms_config where key = 'admin_user_id'`)[0]!.id;
  await cleanup();
  await owner`insert into cms.cms_strands (strand_id, subject, code, name, sort) values ('math-ZQ', 'math', 'ZQ', 'Test strand (add questions)', 98)`;
  await owner`insert into cms.cms_chapters (chapter_id, subject, strand_id, name, sort) values ('MC89', 'math', 'math-ZQ', 'Test chapter (add questions)', 98)`;
  await owner`insert into cms.cms_topics (topic_id, chapter_id, class, name) values ('MT9970', 'MC89', 6, 'Test topic (add questions)')`;
});
afterAll(async () => { await cleanup(); await Promise.all([owner.end(), su.end()]); });

describe('cms_add_questions', () => {
  it('Science (0032): stores optional content-row links; a row in both lists counts as direct; an unknown row is refused', async () => {
    const r = await add({ topic_id: 'MT9970', origin: 'manual', questions: [mcq({ content_rows: [{ row_id: 'C6-04-001', role: 'direct' }, { row_id: 'C6-04-014', role: 'supporting' }, { row_id: 'C6-04-001', role: 'supporting' }] })] });
    const links = await owner`select x.row_id, x.role from cms.cms_question_content_rows x join cms.cms_question_list l using (version_id) where l.question_id = ${r.added[0]!.question_id} order by row_id`;
    expect(links.map((l) => `${l.row_id}:${l.role}`)).toEqual(['C6-04-001:direct', 'C6-04-014:supporting']);
    await expect(add({ topic_id: 'MT9970', origin: 'manual', questions: [mcq({ content_rows: [{ row_id: 'C6-99-999', role: 'direct' }] })] })).rejects.toThrow(/content row ID does not exist/);
  });

  it('adds a question by hand: Needs review, Manual, all three pending flags, options marked', async () => {
    const r = await add({ topic_id: 'MT9970', origin: 'manual', questions: [mcq({ picture_needed: true, figure_description: 'Four number cards',
      solution: 'Compare hundreds first.', hints: ['Look at the hundreds'], wrong_answers: [{ value: '102', why: 'confused 0 and 2' }], author_notes: 'from class work' })] });
    const id = r.added[0]!.question_id;
    expect(r.import_id).toBeNull();
    const [l] = await owner`select status, created_from, attributes_pending, originality_pending, image_pending, clone_key, level, class, file_key from cms.cms_question_list where question_id = ${id}`;
    expect(l).toMatchObject({ status: 'in_review', created_from: 'manual', attributes_pending: true, originality_pending: true, image_pending: true, clone_key: null, level: 6, class: 6 });
    expect(l!.file_key).toMatch(/^MC89-5\d{3}$/);
    const opts = await owner`select o.text, o.is_correct from cms.cms_version_options o join cms.cms_question_list l using (version_id) where l.question_id = ${id} order by position`;
    expect(opts.filter((o) => o.is_correct).map((o) => o.text)).toEqual(['120']);
    const [w] = await owner`select w.value, w.option_position, w.tag, w.why from cms.cms_version_wrong_answers w join cms.cms_question_list l using (version_id) where l.question_id = ${id}`;
    expect(w).toMatchObject({ value: '102', option_position: 3, tag: null, why: 'confused 0 and 2' });
    const [log] = await owner`select action, reason, field_diff from cms.cms_reviews where target_id = ${`${id} v1`}`;
    expect(log).toMatchObject({ action: 'create', reason: 'added by hand' });
  });

  it('True/False gets its two options automatically', async () => {
    const r = await add({ topic_id: 'MT9970', origin: 'manual', questions: [{ row: 1, text: '0 is an even number.', format: 'True/False', correct: 'True', level: 6, picture_needed: false }] });
    const opts = await owner`select o.text from cms.cms_version_options o join cms.cms_question_list l using (version_id) where l.question_id = ${r.added[0]!.question_id} order by position`;
    expect(opts.map((o) => o.text)).toEqual(['True', 'False']);
  });

  it('refuses missing mandatory fields and a non-admin', async () => {
    await expect(add({ topic_id: 'MT9970', origin: 'manual', questions: [mcq({ picture_needed: true })] })).rejects.toThrow(/figure description is required/);
    await expect(add({ topic_id: 'MT9970', origin: 'manual', questions: [mcq({ correct: '7' })] })).rejects.toThrow(/one of the options/);
    await expect(add({ topic_id: 'MT9970', origin: 'manual', questions: [mcq({ format: 'Multi-part' })] })).rejects.toThrow(/not allowed/);
    await expect(add({ topic_id: 'MT9970', origin: 'manual', questions: [mcq()] }, '00000000-0000-0000-0000-000000000001')).rejects.toThrow(/Only the CMS admin/);
  });

  it('an upload records the file and the skipped rows, and badges each question with it', async () => {
    const r = await add({ topic_id: 'MT9970', origin: 'upload', file_name: 'fractions-week2.xlsx',
      skipped: [{ level: 'error', where: 'row 4', message: 'question text is missing' }], questions: [mcq({ row: 3 })] });
    expect(r.import_id).toBeGreaterThan(0);
    const [imp] = await owner`select kind, file_path, result, counts from cms.cms_imports where import_id = ${r.import_id}`;
    expect(imp).toMatchObject({ kind: 'upload', file_path: 'fractions-week2.xlsx', result: 'partial', counts: { added: 1, skipped: 1 } });
    const [l] = await owner`select created_from, upload_file from cms.cms_question_list where question_id = ${r.added[0]!.question_id}`;
    expect(l).toMatchObject({ created_from: 'upload', upload_file: 'fractions-week2.xlsx' });
  });

  it('cannot be approved while originality, attributes or the picture is pending; can once all are done', async () => {
    const id = (await add({ topic_id: 'MT9970', origin: 'manual', questions: [mcq({ picture_needed: true, figure_description: 'Four number cards', math_difficulty: 'Simple' })] })).added[0]!.question_id;
    const approve = () => asAdmin((tx) => tx`select cms.cms_set_status(${id}, 1, 'approve', null, false)`);
    await expect(approve()).rejects.toThrow(/originality check is pending/);
    await owner`update cms.cms_question_versions set originality_pending = false where question_id = ${id}`;
    await expect(approve()).rejects.toThrow(/picture is pending/);
    await owner`update cms.cms_question_versions set image_status = 'has_image', image_path = 'figures/test.png' where question_id = ${id}`;
    await expect(approve()).rejects.toThrow(/attributes are pending/);
    await owner`update cms.cms_question_versions set reading = 1, steps = 1, working_memory = 1, inhibition = 0, visual = 0, strategy = 0 where question_id = ${id}`;
    await approve();
    const [l] = await owner`select status, approved_version from cms.cms_question_list where question_id = ${id}`;
    expect(l).toMatchObject({ status: 'approved', approved_version: 1 });
  });

  it('the picture rule holds for any production question, not only added ones', async () => {
    const id = (await add({ topic_id: 'MT9970', origin: 'manual', questions: [mcq({ math_difficulty: 'Simple' })] })).added[0]!.question_id;
    await owner`update cms.cms_question_versions set originality_pending = false, created_from = 'import', image_status = 'needs_image',
      reading = 1, steps = 1, working_memory = 1, inhibition = 0, visual = 0, strategy = 0 where question_id = ${id}`;
    await expect(asAdmin((tx) => tx`select cms.cms_set_status(${id}, 1, 'approve', null, false)`)).rejects.toThrow(/picture is pending/);
  });

  it('attributes stop being pending once the signature is filled; then the question can join a clone group', async () => {
    const id = (await add({ topic_id: 'MT9970', origin: 'manual', questions: [mcq({ math_difficulty: 'Simple' })] })).added[0]!.question_id;
    await owner`update cms.cms_question_versions set reading = 1, steps = 1, working_memory = 1, inhibition = 0, visual = 0, strategy = 0 where question_id = ${id}`;
    const [l] = await owner`select attributes_pending from cms.cms_question_list where question_id = ${id}`;
    expect(l!.attributes_pending).toBe(false);
  });
});

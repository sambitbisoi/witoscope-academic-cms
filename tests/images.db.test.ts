// 0049 (Images PR, DL-040, 24 Nov 2026): image status, structured brief, history + Undo, the approval rules,
// Generate-missing runs (resumable, per-run cap). Local DB; each test in ONE transaction that is rolled back.
// Synthetic rows (our own words) on topic ST0325 / chapter SC48.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertLocal, LOCAL_SUPERUSER_URL } from '../scripts/local-bootstrap.ts';

assertLocal(LOCAL_SUPERUSER_URL);
const su = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
let adminId = '';
beforeAll(async () => { adminId = (await su`select value #>> '{}' as id from cms.cms_config where key = 'admin_user_id'`)[0]!.id; });
afterAll(() => su.end());
class Done extends Error {}
type Tx = postgres.TransactionSql;
type H = { as: (uid?: string) => Promise<void>; owner: () => Promise<void> };
async function rolledBack(fn: (tx: Tx, h: H) => Promise<void>) {
  await su.begin(async (tx) => {
    const as = async (uid = adminId) => { await tx.unsafe('set local role authenticated'); await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`; };
    const owner = async () => { await tx.unsafe('reset role'); };
    await fn(tx, { as, owner });
    throw new Done();
  }).catch((e) => { if (!(e instanceof Done)) throw e; });
}
const fails = (tx: Tx, fn: (sp: Tx) => Promise<unknown>, re: RegExp) => expect(tx.savepoint((sp) => fn(sp as unknown as Tx))).rejects.toThrow(re);

const ROW = 'C6-ZI-001';
const BRIEF = { shown: 'Four separate fruits in a row: a mango, a banana, an apple and a guava.', style: 'simple flat colour drawing', must_not_show: 'no words',
  layout: 'row4', labels: [{ label: 'A', points_to: 'the mango' }, { label: 'B', points_to: 'the banana' }, { label: 'C', points_to: 'the apple' }, { label: 'D', points_to: 'the guava' }] };
async function q(tx: Tx, h: H, o: { image?: 'needs_image' | 'has_image'; approved?: boolean } = {}) {
  await h.owner();
  if (!(await tx`select 1 from cms.cms_content_rows where row_id = ${ROW}`).length) {
    await tx`insert into cms.cms_content_rows (row_id, topic_id, chapter_id, row_class, type, chapter_role, content, question_use, source, sort, content_hash)
      values (${ROW}, 'ST0325', 'SC48', 6, 'Fact', 'Core', 'Test content: fruits grow on plants.', 'OK', 'Claude-added', 9100, 'x')`;
  }
  await h.as();
  const [r] = await tx`select cms.cms_add_questions(${tx.json({ topic_id: 'ST0325', origin: 'manual', questions: [{ row: 1, text: 'Which picture shows a mango?', format: 'MCQ-4',
    options: ['A', 'B', 'C', 'D'], correct: 'A', level: 6, picture_needed: true, figure_description: 'Four fruits in a row.', solution: 'A. The mango is the oval yellow fruit.', content_rows: [{ row_id: ROW, role: 'direct' }] }] } as never)}) as r`;
  const id = (r!.r as { added: { question_id: string }[] }).added[0]!.question_id;
  await h.owner();
  await tx`update cms.cms_question_versions set reading = 2, steps = 1, inhibition = 1, visual = 1, has_irrelevant_info = false, science_question_type = 1,
    originality_pending = false, status = 'in_review', image_status = ${o.image ?? 'needs_image'}, image_path = ${o.image === 'has_image' ? 'figures/GR9999-old.png' : null},
    created_from = 'generation' where question_id = ${id}`;
  await h.as();
  return id;
}
const ver = async (tx: Tx, id: string) => (await tx`select v.* from cms.cms_questions q join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version where q.question_id = ${id}`)[0]!;
const call = (tx: Tx, fn: string, p: Record<string, unknown>) => tx.unsafe(`select cms.${fn}($1::text::jsonb) as r`, [JSON.stringify(p)]).then((x) => x[0]!.r);
const hist = async (tx: Tx, id: string) => (await tx`select i.image_path, i.source, i.state from cms.cms_version_images i join cms.cms_question_versions v on v.version_id = i.version_id
  where v.question_id = ${id} order by i.image_id`).map((x) => `${x.source}:${x.state}:${x.image_path}`);
const blockers = async (tx: Tx, id: string) => (await tx`select reason from cms.cms_approval_blockers where question_id = ${id} order by reason`).map((x) => x.reason);
const approve = (tx: Tx, id: string) => tx`select cms.cms_approve_questions(${[id]}, null) as r`.then((x) => x[0]!.r as { approved: unknown[]; blocked: { reason: string }[] });

describe('image status and approval (0049)', () => {
  it('needed → to check → OK; approval is blocked until OK; the 0048 "Image to redo" rule is gone', async () => {
    await rolledBack(async (tx, h) => {
      const id = await q(tx, h);
      expect(await blockers(tx, id)).toEqual(['picture_pending']);
      await call(tx, 'cms_set_image_brief', { question_id: id, version_no: 1, brief: BRIEF });
      expect((await ver(tx, id)).figure_description).toBe('Shown: Four separate fruits in a row: a mango, a banana, an apple and a guava. · Style: simple flat colour drawing · Must NOT show: no words · Labels: A -> the mango; B -> the banana; C -> the apple; D -> the guava');
      await call(tx, 'cms_set_image', { question_id: id, version_no: 1, image_path: 'figures/img/t-1.png', base_path: 'figures/img/t-1-base.png', source: 'generated', provider: 'fake', cost_usd: 0.04 });
      expect((await ver(tx, id)).image_status).toBe('to_check');
      expect(await blockers(tx, id)).toEqual(['image_to_check']);
      expect((await approve(tx, id)).blocked[0]!.reason).toMatch(/image is to check/);
      await fails(tx, (sp) => call(sp, 'cms_check_image', { question_id: id, version_no: 1, decision: 'redo' }), /needs a reason/);
      await call(tx, 'cms_check_image', { question_id: id, version_no: 1, decision: 'ok' });
      expect(await blockers(tx, id)).toEqual([]);
      expect((await approve(tx, id)).approved).toHaveLength(1);
      // a generated Science question with a picture that is OK can be approved: no "Image to redo" any more
      expect((await tx`select count(*)::int n from pg_trigger where tgname = 'cms_version_image_redo'`)[0]!.n).toBe(0);
      await fails(tx, (sp) => call(sp, 'cms_set_image', { question_id: id, version_no: 1, image_path: 'figures/img/t-2.png', source: 'upload' }), /Edit makes a new version first/);
    });
  });

  it('history: a new image makes the old one previous; Undo swaps them; Redo sends it back to Image needed; audited', async () => {
    await rolledBack(async (tx, h) => {
      const id = await q(tx, h);
      await call(tx, 'cms_set_image', { question_id: id, version_no: 1, image_path: 'figures/img/a.png', source: 'upload' });
      await call(tx, 'cms_set_image', { question_id: id, version_no: 1, image_path: 'figures/img/b.png', source: 'generated', provider: 'fake' });
      expect(await hist(tx, id)).toEqual(['upload:previous:figures/img/a.png', 'generated:current:figures/img/b.png']);
      await call(tx, 'cms_undo_image', { question_id: id, version_no: 1 });
      expect(await hist(tx, id)).toEqual(['upload:current:figures/img/a.png', 'generated:previous:figures/img/b.png']);
      expect(await ver(tx, id)).toMatchObject({ image_path: 'figures/img/a.png', image_status: 'to_check' });
      await call(tx, 'cms_check_image', { question_id: id, version_no: 1, decision: 'redo', reason: 'the banana looks like a moon' });
      expect((await ver(tx, id)).image_status).toBe('needs_image');
      const audit = (await tx`select action from cms.cms_reviews where target_id = ${`${id} v1`} and action like 'image_%' order by review_id`).map((x) => x.action);
      expect(audit).toEqual(['image_set', 'image_set', 'image_undo', 'image_check']);
      await fails(tx, (sp) => call(sp, 'cms_set_image', { question_id: id, version_no: 1, image_path: 'books/x.pdf', source: 'upload' }), /under figures/);
    });
  });

  it('a drawn figure kept as previous (svg_render, as 0049 does for the 182): Undo brings it back as Image needed', async () => {
    await rolledBack(async (tx, h) => {
      const id = await q(tx, h, { image: 'has_image' });
      await h.owner();
      const v = await ver(tx, id);
      await tx`insert into cms.cms_version_images (version_id, image_path, source, state, by_label) values (${v.version_id}, 'figures/GR9999-old.png', 'svg_render', 'previous', 'migration 0049')`;
      await tx`update cms.cms_question_versions set image_path = null, image_status = 'needs_image' where version_id = ${v.version_id}`;
      await h.as();
      await call(tx, 'cms_set_image', { question_id: id, version_no: 1, image_path: 'figures/img/new.png', source: 'generated' });
      await call(tx, 'cms_undo_image', { question_id: id, version_no: 1 });
      expect(await ver(tx, id)).toMatchObject({ image_path: null, image_status: 'needs_image' });
      expect(await hist(tx, id)).toEqual(['svg_render:current:figures/GR9999-old.png', 'generated:previous:figures/img/new.png']);
    });
  });

  it('brief: shape checked; a new version keeps it', async () => {
    await rolledBack(async (tx, h) => {
      const id = await q(tx, h);
      await fails(tx, (sp) => call(sp, 'cms_set_image_brief', { question_id: id, version_no: 1, brief: { ...BRIEF, layout: 'grid3x3' } }), /layout is row4/);
      await fails(tx, (sp) => call(sp, 'cms_set_image_brief', { question_id: id, version_no: 1, brief: { ...BRIEF, labels: [{ label: 'A', points_to: 'x' }, { label: 'A', points_to: 'y' }] } }), /appears twice/);
      await fails(tx, (sp) => call(sp, 'cms_set_image_brief', { question_id: id, version_no: 1, brief: { shown: '' } }), /needs "shown"/);
      await call(tx, 'cms_set_image_brief', { question_id: id, version_no: 1, brief: BRIEF });
      await h.owner();
      const v = await ver(tx, id);
      expect(v.image_brief).toEqual(BRIEF);
      await tx`update cms.cms_question_versions set status = 'rejected' where version_id = ${v.version_id}`;   // one open version at a time
      // a new version (as Edit makes one): every column copied except the brief, which the trigger carries over
      const cols = (await tx`select column_name from information_schema.columns where table_schema = 'cms' and table_name = 'cms_question_versions'
        and column_name not in ('version_id', 'version_no', 'status', 'image_brief', 'created_at') and is_generated = 'NEVER' order by ordinal_position`).map((x) => x.column_name as string);
      await tx.unsafe(`insert into cms.cms_question_versions (version_no, status, ${cols.join(', ')}) select 2, 'draft', ${cols.join(', ')} from cms.cms_question_versions where version_id = $1`, [v.version_id]);
      expect((await tx`select image_brief from cms.cms_question_versions where question_id = ${id} and version_no = 2`)[0]!.image_brief).toEqual(BRIEF);
    });
  });
});

describe('Generate missing: runs (0049)', () => {
  it('lists Science questions at Image needed; the cap limits each claim; a done image is spent; re-open continues; admin only', async () => {
    await rolledBack(async (tx, h) => {
      const a = await q(tx, h), b = await q(tx, h), c = await q(tx, h), ok = await q(tx, h, { image: 'has_image' });
      const r = await call(tx, 'cms_image_run_open', { scope_kind: 'topic', scope_id: 'ST0325', provider: 'fake', price_usd: 2, cap_usd: 5 });
      expect(r).toMatchObject({ continued: false, cap_usd: 5, pending: expect.any(Number) });
      const items = (await tx`select question_id from cms.cms_image_run_items i join cms.cms_image_runs r on r.run_id = i.run_id where r.run_code = ${r.run_code}`).map((x) => x.question_id);
      expect(items).toEqual(expect.arrayContaining([a, b, c]));
      expect(items).not.toContain(ok);
      const claim = (n: number) => tx`select cms.cms_image_run_claim(${r.run_code}, ${n}) as r`.then((x) => x[0]!.r as { question_ids: string[]; cap_reached: boolean });
      const c1 = await claim(5);
      expect(c1.question_ids).toHaveLength(2);               // $5 cap at $2 an image: 2 now
      await call(tx, 'cms_set_image', { question_id: c1.question_ids[0], version_no: 1, image_path: 'figures/img/r1.png', source: 'generated', cost_usd: 2, run_code: r.run_code });
      await call(tx, 'cms_image_run_item', { run_code: r.run_code, question_id: c1.question_ids[1], status: 'failed', error: 'provider refused', cost_usd: 2 });
      expect(await claim(5)).toMatchObject({ question_ids: [], cap_reached: true });
      const again = await call(tx, 'cms_image_run_open', { scope_kind: 'topic', scope_id: 'ST0325', provider: 'fake', price_usd: 2 });
      expect(again).toMatchObject({ run_code: r.run_code, continued: true, spent_usd: 4 });
      expect((await call(tx, 'cms_image_run_close', { run_code: r.run_code, status: 'stopped', note: 'cap reached' })).status).toBe('stopped');
      await h.as('00000000-0000-0000-0000-000000000001');
      await fails(tx, (sp) => call(sp, 'cms_image_run_open', { scope_kind: 'topic', scope_id: 'ST0325', provider: 'fake', price_usd: 2 }), /Only the CMS admin/);
    });
  });
});

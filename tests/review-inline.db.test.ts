// 0048 (Q38 PR 4, 24 Nov 2026): bulk approve + OL-044, decide a proposed primary in place, settings approval,
// "Image to redo (DL-040)". Local DB; every test runs in ONE transaction that is rolled back.
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

const ROWS = ['C6-ZY-001', 'C6-ZY-002', 'C6-ZY-003'];
async function setup(tx: Tx) {
  for (const [i, id] of ROWS.entries()) {
    await tx`insert into cms.cms_content_rows (row_id, topic_id, chapter_id, row_class, type, chapter_role, content, misconceptions, question_use, source, sort, content_hash)
      values (${id}, 'ST0325', 'SC48', 6, 'Fact', 'Core', ${`Test content ${id}: magnets pull iron clips.`}, ${`Test belief ${i + 1}a.`}, 'OK', 'Claude-added', ${9000 + i}, 'x')`;
    await tx`insert into cms.cms_row_misconceptions (row_id, item_no, text, source) values (${id}, 1, ${`Test belief ${i + 1}a.`}, 'row split')`;
  }
}
const newQ = (o: Record<string, unknown> = {}) => ({ row: 1, text: 'Which one does a magnet pull?', format: 'MCQ-4', options: ['Wood', 'Iron nail', 'Glass', 'Paper'], correct: 'Iron nail',
  level: 6, picture_needed: false, solution: 'Iron nail. A magnet pulls iron; wood, glass and paper are not magnetic.',
  content_rows: [{ row_id: 'C6-ZY-001', role: 'direct' }, { row_id: 'C6-ZY-002', role: 'direct' }, { row_id: 'C6-ZY-003', role: 'supporting' }], ...o });
/** A question ready for approval except its primary: generated (or not), primary C6-ZY-001 proposed. */
async function q(tx: Tx, h: H, o: { generated?: boolean; proposed?: boolean; image?: boolean } = {}) {
  await h.as();
  const [r] = await tx`select cms.cms_add_questions(${tx.json({ topic_id: 'ST0325', origin: 'manual', questions: [newQ()] } as never)}) as r`;
  const id = (r!.r as { added: { question_id: string }[] }).added[0]!.question_id;
  await h.owner();
  await tx`update cms.cms_question_versions set reading = 2, steps = 1, inhibition = 1, visual = 0, has_irrelevant_info = false, science_question_type = 2,
    originality_pending = false, status = 'in_review', created_from = ${o.generated === false ? 'manual' : 'generation'},
    image_status = ${o.image ? 'has_image' : null}, image_path = ${o.image ? 'figures/GR9999-T-01.png' : null} where question_id = ${id}`;
  if (o.proposed !== false) await tx`update cms.cms_question_content_rows l set rank_proposed = true from cms.cms_question_versions v
    where v.version_id = l.version_id and v.question_id = ${id} and l.rank = 'primary'`;
  await h.as();
  return id;
}
const ver = async (tx: Tx, id: string) => (await tx`select v.* from cms.cms_questions q join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version where q.question_id = ${id}`)[0]!;
const links = async (tx: Tx, id: string) => (await tx`select l.row_id, l.rank, l.rank_proposed, l.primary_rejected from cms.cms_question_content_rows l
  join cms.cms_questions q on q.question_id = ${id} join cms.cms_question_versions v on v.version_id = l.version_id and v.question_id = q.question_id and v.version_no = q.current_version
  where l.role = 'direct' order by l.row_id`).map((l) => `${l.row_id}:${l.rank}${l.rank_proposed ? '?' : ''}${l.primary_rejected ? ':rejected' : ''}`);
type Res = { approved: { question_id: string; primary_confirmed: string | null }[]; blocked: { question_id: string; reason: string }[]; already: { question_id: string }[] };
const approveMany = async (tx: Tx, ids: string[], reason: string | null = null) => (await tx`select cms.cms_approve_questions(${ids}, ${reason}) as r`)[0]!.r as Res;
const blockers = async (tx: Tx, id: string) => (await tx`select reason, detail from cms.cms_approval_blockers where question_id = ${id} order by reason`).map((b) => `${b.reason}${b.detail ? ` (${b.detail})` : ''}`);

describe('bulk approve + OL-044 (0048)', () => {
  it('a generated question: approving confirms its proposed primary; one audit row each; not listed as blocked by the primary', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx);
      const a = await q(tx, h), b = await q(tx, h);
      expect(await blockers(tx, a)).toEqual([]);
      const r = await approveMany(tx, [a, b, a], 'pack review');
      expect(r.approved.map((x) => [x.question_id, x.primary_confirmed])).toEqual([[a, 'C6-ZY-001'], [b, 'C6-ZY-001']].sort());
      expect(r.blocked).toEqual([]);
      expect((await ver(tx, a)).status).toBe('approved');
      expect(await links(tx, a)).toEqual(['C6-ZY-001:primary', 'C6-ZY-002:secondary']);
      const audit = await tx`select action, reason from cms.cms_reviews where target_id = ${`${a} v1`} and action in ('approve', 'science_review') order by review_id`;
      expect(audit.map((x) => `${x.action}: ${x.reason}`)).toEqual(['science_review: proposed primary confirmed as the question is approved (OL-044)', 'approve: pack review']);
      expect((await approveMany(tx, [a])).already.map((x) => x.question_id)).toEqual([a]);   // re-run: already approved, nothing written
    });
  });

  it('a non-generated question keeps its proposed primary: blocked, with the reason; the others in the batch still go through', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx);
      const manual = await q(tx, h, { generated: false }), gen = await q(tx, h);
      expect(await blockers(tx, manual)).toEqual(['science_primary_not_confirmed']);
      const r = await approveMany(tx, [manual, gen]);
      expect(r.approved.map((x) => x.question_id)).toEqual([gen]);
      expect(r.blocked).toEqual([{ question_id: manual, reason: expect.stringMatching(/confirmed primary/) }]);
      expect((await ver(tx, manual)).status).toBe('in_review');
      expect(await links(tx, manual)).toEqual(['C6-ZY-001:primary?', 'C6-ZY-002:secondary']);
    });
  });

  // 0049 replaced 0048's "Image to redo (DL-040)" with the image status: a picture still "to check" blocks approval
  it('(g → 0049) a generated question whose picture is still to check: bulk approve skips it and rolls back its primary', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx);
      const pic = await q(tx, h, { image: true }), manualPic = await q(tx, h, { image: true, generated: false, proposed: false });
      await h.owner(); await tx`update cms.cms_question_versions set image_status = 'to_check' where question_id = ${pic}`; await h.as();
      expect(await blockers(tx, pic)).toEqual(['image_to_check']);
      expect(await blockers(tx, manualPic)).toEqual([]);
      const r = await approveMany(tx, [pic, manualPic]);
      expect(r.blocked).toEqual([{ question_id: pic, reason: expect.stringMatching(/image is to check/) }]);
      expect(r.approved.map((x) => x.question_id)).toEqual([manualPic]);
      expect(await links(tx, pic)).toEqual(['C6-ZY-001:primary?', 'C6-ZY-002:secondary']);   // its confirmation was rolled back with it
      expect((await tx`select count(*)::int as n from cms.cms_reviews where target_id = ${`${pic} v1`} and action in ('approve', 'science_review')`)[0]!.n).toBe(0);
      // the trigger blocks every approval path, also a direct one with the primary confirmed
      await tx`select cms.cms_decide_primary(${tx.json({ question_id: pic, version_no: 1, decision: 'confirm', row_id: 'C6-ZY-001' } as never)})`;
      await fails(tx, (sp) => sp`select cms.cms_set_status(${pic}, 1, 'approve', null)`, /image is to check/);
    });
  });

  it('admin only; at most 100 per call', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx);
      const a = await q(tx, h);
      await h.as('00000000-0000-0000-0000-000000000001');
      await fails(tx, (sp) => approveMany(sp, [a]), /Only the CMS admin/);
      await h.as();
      await fails(tx, (sp) => approveMany(sp, Array.from({ length: 101 }, (_, i) => `SQ${i}`)), /At most 100/);
    });
  });
});

describe('decide a proposed primary in place (0048)', () => {
  const decide = (tx: Tx, p: Record<string, unknown>) => tx`select cms.cms_decide_primary(${tx.json({ version_no: 1, ...p } as never)}) as r`;
  it('reject keeps the row as a secondary, marked rejected; undo restores it as proposed; change picks another and clears the mark', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx);
      const id = await q(tx, h, { generated: false });
      await decide(tx, { question_id: id, decision: 'reject', row_id: 'C6-ZY-001' });
      expect(await links(tx, id)).toEqual(['C6-ZY-001:secondary:rejected', 'C6-ZY-002:secondary']);
      expect(await blockers(tx, id)).toEqual(['science_primary_not_confirmed (rejected: C6-ZY-001)']);
      await decide(tx, { question_id: id, decision: 'undo', row_id: 'C6-ZY-001' });
      expect(await links(tx, id)).toEqual(['C6-ZY-001:primary?', 'C6-ZY-002:secondary']);
      await decide(tx, { question_id: id, decision: 'reject', row_id: 'C6-ZY-001' });
      await decide(tx, { question_id: id, decision: 'change', row_id: 'C6-ZY-002' });
      expect(await links(tx, id)).toEqual(['C6-ZY-001:secondary:rejected', 'C6-ZY-002:primary']);
      await fails(tx, (sp) => decide(sp, { question_id: id, decision: 'undo', row_id: 'C6-ZY-001' }), /has a primary row now/);
      await decide(tx, { question_id: id, decision: 'change', row_id: 'C6-ZY-001' });   // picked after all: no longer rejected
      expect(await links(tx, id)).toEqual(['C6-ZY-001:primary', 'C6-ZY-002:secondary']);
      const audit = await tx`select reason, field_diff from cms.cms_reviews where target_id = ${`${id} v1`} and action = 'science_review' order by review_id`;
      expect(audit.map((a) => a.reason)).toEqual(['proposed primary rejected', 'rejected primary restored as proposed', 'proposed primary rejected', 'primary changed', 'primary changed']);
    });
  });
  it('confirm; refuses a row that is not the proposed primary, a stale version and a non-admin', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx);
      const id = await q(tx, h, { generated: false });
      await fails(tx, (sp) => decide(sp, { question_id: id, decision: 'confirm', row_id: 'C6-ZY-002' }), /not the proposed primary/);
      await fails(tx, (sp) => decide(sp, { question_id: id, decision: 'confirm', row_id: 'C6-ZY-001', version_no: 2 }), /changed since you opened it/);
      await decide(tx, { question_id: id, decision: 'confirm', row_id: 'C6-ZY-001' });
      expect(await links(tx, id)).toEqual(['C6-ZY-001:primary', 'C6-ZY-002:secondary']);
      await h.as('00000000-0000-0000-0000-000000000001');
      await fails(tx, (sp) => decide(sp, { question_id: id, decision: 'reject', row_id: 'C6-ZY-001' }), /Only the CMS admin/);
    });
  });
});

describe('settings approval path (0048, Q2)', () => {
  it('approve, reject (kept), back to proposed; audited', async () => {
    await rolledBack(async (tx, h) => {
      await h.owner();
      await tx`insert into cms.cms_settings (setting_id, name, subject, status) values ('SET9999', 'Test kitchen shelf', 'science', 'proposed')`;
      await h.as();
      const set = (s: string) => tx`select cms.cms_set_catalogue_status('setting', 'SET9999', ${s}, ${`test ${s}`})`;
      await set('active');
      await set('retired');
      await set('proposed');
      await fails(tx, (sp) => sp`select cms.cms_set_catalogue_status('setting', 'SET9999', 'proposed', null)`, /already proposed/);
      const audit = await tx`select target_table, field_diff from cms.cms_reviews where target_id = 'SET9999' order by review_id`;
      expect(audit.map((a) => `${a.target_table}:${a.field_diff.status.before}→${a.field_diff.status.after}`)).toEqual(['cms_settings:proposed→active', 'cms_settings:active→retired', 'cms_settings:retired→proposed']);
    });
  });
});

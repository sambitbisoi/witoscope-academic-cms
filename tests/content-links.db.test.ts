// Q23 (0044, 17 Nov 2026): edit the linked content rows of a Science draft (cms_save_content_links). One test per rule.
// Local DB; every test runs in ONE transaction that is rolled back. Synthetic rows (our own words) on topic ST0325 / chapter SC48.
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

const ROWS = ['C6-ZX-001', 'C6-ZX-002', 'C6-ZX-003', 'C6-ZX-004', 'C6-ZX-005'];
async function setup(tx: Tx, h: H) {
  for (const [i, id] of ROWS.entries()) {
    await tx`insert into cms.cms_content_rows (row_id, topic_id, chapter_id, row_class, type, chapter_role, content, misconceptions, question_use, source, sort, content_hash)
      values (${id}, 'ST0325', 'SC48', 6, 'Fact', 'Core', ${`Test content ${id}: a magnet pulls iron clips.`}, ${`Test belief ${i + 1}a.`}, 'OK', 'Claude-added', ${9100 + i}, 'x')`;
    await tx`insert into cms.cms_row_misconceptions (row_id, item_no, text, source) values (${id}, 1, ${`Test belief ${i + 1}a.`}, 'row split')`;
  }
  await tx`update cms.cms_content_rows set retired_at = now(), retired_reason = 'test' where row_id = 'C6-ZX-005'`;
  await h.as();
  const [r] = await tx`select cms.cms_add_questions(${tx.json({ topic_id: 'ST0325', origin: 'manual', questions: [{ row: 1, text: 'Which one does a magnet pull?', format: 'MCQ-4',
    options: ['Wood', 'Iron nail', 'Glass', 'Paper'], correct: 'Iron nail', level: 6, picture_needed: false, solution: 'Iron nail. A magnet pulls iron.',
    content_rows: [{ row_id: 'C6-ZX-001', role: 'direct' }, { row_id: 'C6-ZX-002', role: 'direct' }, { row_id: 'C6-ZX-003', role: 'supporting' }] }] } as never)}) as r`;
  return (r!.r as { added: { question_id: string }[] }).added[0]!.question_id;
}
const fails = (tx: Tx, fn: (sp: Tx) => Promise<unknown>, re: RegExp) => expect(tx.savepoint((sp) => fn(sp as unknown as Tx))).rejects.toThrow(re);
const save = (tx: Tx, qid: string, links: [string, string][], vno = 1) =>
  tx`select cms.cms_save_content_links(${tx.json({ question_id: qid, version_no: vno, reason: 'test', links: links.map(([row_id, rank]) => ({ row_id, rank })) } as never)}) as r`;
const links = async (tx: Tx, qid: string) => (await tx`select l.row_id, l.role, l.rank, l.rank_proposed from cms.cms_question_content_rows l
  join cms.cms_questions q on q.question_id = ${qid} join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version and v.version_id = l.version_id order by l.row_id`)
  .map((l) => `${l.row_id} ${l.role}/${l.rank}${l.rank_proposed ? ' proposed' : ''}`);
const START = ['C6-ZX-001', 'primary'], SEC = ['C6-ZX-002', 'secondary'], SUP = ['C6-ZX-003', 'context'];

describe('Linked content (0044)', () => {
  it('adds, changes the role of and removes links; one audit row before → after; the draft is marked edited', async () => {
    await rolledBack(async (tx, h) => {
      const id = await setup(tx, h);
      expect(await links(tx, id)).toEqual(['C6-ZX-001 direct/primary', 'C6-ZX-002 direct/secondary', 'C6-ZX-003 supporting/context']);
      // + Link a row (supporting), switch the primary to 002, remove 003
      const [r] = await save(tx, id, [['C6-ZX-002', 'primary'], ['C6-ZX-001', 'secondary'], ['C6-ZX-004', 'context']]);
      expect((r!.r as { changed: boolean }).changed).toBe(true);
      expect(await links(tx, id)).toEqual(['C6-ZX-001 direct/secondary', 'C6-ZX-002 direct/primary', 'C6-ZX-004 supporting/context']);
      // supporting → secondary
      await save(tx, id, [['C6-ZX-002', 'primary'], ['C6-ZX-001', 'secondary'], ['C6-ZX-004', 'secondary']]);
      expect(await links(tx, id)).toContain('C6-ZX-004 direct/secondary');
      await h.owner();
      const audit = await tx`select action, target_table, reason, field_diff from cms.cms_reviews where target_id = ${`${id} v1`} and target_table = 'cms_question_content_rows' order by review_id`;
      expect(audit.map((a) => a.action)).toEqual(['science_review', 'science_review']);
      expect(audit[0]!.field_diff).toEqual({ links: {
        before: ['C6-ZX-001 primary', 'C6-ZX-002 secondary', 'C6-ZX-003 context'],
        after: ['C6-ZX-002 primary', 'C6-ZX-001 secondary', 'C6-ZX-004 context'] } });
      const [v] = await tx`select edited_at from cms.cms_question_versions where question_id = ${id} and version_no = 1`;
      expect(v!.edited_at).not.toBeNull();
      // no change → no audit row
      await h.as();
      const [same] = await save(tx, id, [['C6-ZX-002', 'primary'], ['C6-ZX-001', 'secondary'], ['C6-ZX-004', 'secondary']]);
      expect((same!.r as { changed: boolean }).changed).toBe(false);
      await h.owner();
      expect((await tx`select count(*)::int as n from cms.cms_reviews where target_id = ${`${id} v1`} and target_table = 'cms_question_content_rows'`)[0]!.n).toBe(2);
    });
  });

  it('exactly one primary; saving confirms a proposed primary', async () => {
    await rolledBack(async (tx, h) => {
      const id = await setup(tx, h);
      await fails(tx, (sp) => save(sp, id, [['C6-ZX-001', 'secondary'], SEC as [string, string]]), /exactly one primary row \(it now has 0\)/);
      await fails(tx, (sp) => save(sp, id, [START as [string, string], ['C6-ZX-002', 'primary']]), /exactly one primary row \(it now has 2\)/);
      await fails(tx, (sp) => save(sp, id, []), /exactly one primary/);
      await h.owner(); await tx`update cms.cms_question_content_rows l set rank_proposed = true from cms.cms_question_versions v where v.version_id = l.version_id and v.question_id = ${id} and l.rank = 'primary'`; await h.as();
      expect(await links(tx, id)).toContain('C6-ZX-001 direct/primary proposed');
      await save(tx, id, [START, SEC, SUP] as [string, string][]);
      expect(await links(tx, id)).toContain('C6-ZX-001 direct/primary');
    });
  });

  it('refuses an unknown row, a retired row linked anew, a row twice and an unknown role', async () => {
    await rolledBack(async (tx, h) => {
      const id = await setup(tx, h);
      await fails(tx, (sp) => save(sp, id, [START as [string, string], ['C6-ZX-999', 'context']]), /Content row C6-ZX-999 does not exist/);
      await fails(tx, (sp) => save(sp, id, [START as [string, string], ['C6-ZX-005', 'context']]), /C6-ZX-005 is retired; it can't be linked/);
      await fails(tx, (sp) => save(sp, id, [START as [string, string], ['C6-ZX-002', 'secondary'], ['C6-ZX-002', 'context']]), /C6-ZX-002 is linked twice/);
      await fails(tx, (sp) => save(sp, id, [START as [string, string], ['C6-ZX-002', 'direct']]), /role must be primary, secondary or supporting/);
    });
  });

  it('the misconception targeted stays on a linked row: no removing, no demoting to supporting; primary → secondary is fine', async () => {
    await rolledBack(async (tx, h) => {
      const id = await setup(tx, h);
      await tx`select cms.cms_save_science_review(${tx.json({ question_id: id, version_no: 1, misconception: { row_id: 'C6-ZX-002', item_no: 1 } } as never)})`;
      await fails(tx, (sp) => save(sp, id, [START, SUP] as [string, string][]), /Row C6-ZX-002 is still used by the misconception targeted \(C6-ZX-002 #1\); clear the reference first/);
      await fails(tx, (sp) => save(sp, id, [START as [string, string], ['C6-ZX-002', 'context'], SUP as [string, string]]), /clear the reference first, then make it supporting/);
      await save(tx, id, [['C6-ZX-002', 'primary'], ['C6-ZX-001', 'secondary'], SUP] as [string, string][]);
      await save(tx, id, [['C6-ZX-001', 'primary'], ['C6-ZX-002', 'secondary'], SUP] as [string, string][]);
      // an item on a supporting row may stay supporting
      await tx`select cms.cms_save_science_review(${tx.json({ question_id: id, version_no: 1, misconception: { row_id: 'C6-ZX-003', item_no: 1 } } as never)})`;
      await save(tx, id, [START, SEC, SUP] as [string, string][]);
      await fails(tx, (sp) => save(sp, id, [START, SEC] as [string, string][]), /C6-ZX-003 is still used by the misconception targeted/);
      // cleared → removable
      await tx`select cms.cms_save_science_review(${tx.json({ question_id: id, version_no: 1, misconception: null } as never)})`;
      await save(tx, id, [START, SEC] as [string, string][]);
      expect(await links(tx, id)).toEqual(['C6-ZX-001 direct/primary', 'C6-ZX-002 direct/secondary']);
    });
  });

  it("a wrong option's misconception item and a concept-error target row stay on linked rows", async () => {
    await rolledBack(async (tx, h) => {
      const id = await setup(tx, h);
      await tx`select cms.cms_save_science_review(${tx.json({ question_id: id, version_no: 1, wrong: [
        { position: 1, tag: 'misconception', mc: { row_id: 'C6-ZX-003', item_no: 1 } }, { position: 3, tag: 'concept_error', target_row_id: 'C6-ZX-002' }] } as never)})`;
      await fails(tx, (sp) => save(sp, id, [START, SEC] as [string, string][]), /C6-ZX-003 is still used by option A's misconception \(C6-ZX-003 #1\)/);
      await fails(tx, (sp) => save(sp, id, [START, SUP] as [string, string][]), /C6-ZX-002 is still used by option C's concept-error target/);
      await fails(tx, (sp) => save(sp, id, [START as [string, string], ['C6-ZX-002', 'context'], SUP as [string, string]]), /option C's concept-error target; clear the reference first, then make it supporting/);
      // untag C → 002 can go
      await tx`select cms.cms_save_science_review(${tx.json({ question_id: id, version_no: 1, wrong: [{ position: 3, tag: null }] } as never)})`;
      await save(tx, id, [START, SUP] as [string, string][]);
      expect(await links(tx, id)).toEqual(['C6-ZX-001 direct/primary', 'C6-ZX-003 supporting/context']);
    });
  });

  it('open drafts only: an approved version is refused (Edit → new version keeps the links); a stale version is refused', async () => {
    await rolledBack(async (tx, h) => {
      const id = await setup(tx, h);
      await fails(tx, (sp) => save(sp, id, [START, SEC, SUP] as [string, string][], 2), /changed since you opened it/);
      await h.owner();
      await tx`update cms.cms_question_versions set reading = 2, steps = 1, inhibition = 1, visual = 0, has_irrelevant_info = false, science_question_type = 2, originality_pending = false where question_id = ${id}`;
      await h.as();
      await tx`select cms.cms_set_status(${id}, 1, 'approve', null)`;
      await fails(tx, (sp) => save(sp, id, [START, SEC] as [string, string][]), /v1 is approved; use Edit to make a new version first/);
      expect(await links(tx, id)).toEqual(['C6-ZX-001 direct/primary', 'C6-ZX-002 direct/secondary', 'C6-ZX-003 supporting/context']);
    });
  });

  it('Science only, admin only', async () => {
    await rolledBack(async (tx, h) => {
      const id = await setup(tx, h);
      await h.owner();
      const [m] = await tx`select question_id, current_version from cms.cms_questions where subject = 'math' and retired_at is null limit 1`;
      await h.as();
      await fails(tx, (sp) => save(sp, m!.question_id, [START] as [string, string][], m!.current_version), /Science questions only/);
      await h.as('00000000-0000-4000-8000-000000000000');
      await fails(tx, (sp) => save(sp, id, [START, SEC, SUP] as [string, string][]), /Only the CMS admin/);
    });
  });
});

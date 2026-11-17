// 0035 (16 Nov 2026): Science review box, approval rules, Edit → new version keeps the Science links, Add question
// with items, RLS on cms_row_misconceptions. Local DB; every test runs in ONE transaction that is rolled back.
// Synthetic rows (our own words) on topic ST0325 / chapter SC48.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertLocal, LOCAL_SUPERUSER_URL } from '../scripts/local-bootstrap.ts';
import { tierChanges } from '../scripts/lib/tier.ts';
import { scienceDerive } from '../shared/science-derive.ts';

assertLocal(LOCAL_SUPERUSER_URL);
const su = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
let adminId = '';
beforeAll(async () => { adminId = (await su`select value #>> '{}' as id from cms.cms_config where key = 'admin_user_id'`)[0]!.id; });
afterAll(() => su.end());

class Done extends Error {}
type Tx = postgres.TransactionSql;
/** fn gets helpers: as(uid) switches to the app user (RLS on), owner() back to the superuser for setup. Always rolled back. */
async function rolledBack(fn: (tx: Tx, h: { as: (uid?: string) => Promise<void>; owner: () => Promise<void> }) => Promise<void>) {
  await su.begin(async (tx) => {
    const as = async (uid = adminId) => { await tx.unsafe('set local role authenticated'); await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`; };
    const owner = async () => { await tx.unsafe('reset role'); };
    await fn(tx, { as, owner });
    throw new Done();
  }).catch((e) => { if (!(e instanceof Done)) throw e; });
}

const ROWS = ['C6-ZY-001', 'C6-ZY-002', 'C6-ZY-003'];
async function setup(tx: Tx) {
  for (const [i, id] of ROWS.entries()) {
    await tx`insert into cms.cms_content_rows (row_id, topic_id, chapter_id, row_class, type, chapter_role, content, misconceptions, question_use, source, sort, content_hash)
      values (${id}, 'ST0325', 'SC48', 6, 'Fact', 'Core', ${`Test content ${id}: magnets pull iron clips.`}, ${`Test belief ${i + 1}a. Test belief ${i + 1}b.`}, 'OK', 'Claude-added', ${9000 + i}, 'x')`;
    await tx`insert into cms.cms_row_misconceptions (row_id, item_no, text, source) values (${id}, 1, ${`Test belief ${i + 1}a.`}, 'row split'), (${id}, 2, ${`Test belief ${i + 1}b.`}, 'row split')`;
  }
}
const newQ = (o: Record<string, unknown> = {}) => ({ row: 1, text: 'Which one does a magnet pull?', format: 'MCQ-4', options: ['Wood', 'Iron nail', 'Glass', 'Paper'], correct: 'Iron nail',
  level: 6, picture_needed: false, solution: 'Iron nail. A magnet pulls iron; wood, glass and paper are not magnetic.',
  content_rows: [{ row_id: 'C6-ZY-001', role: 'direct' }, { row_id: 'C6-ZY-002', role: 'direct' }, { row_id: 'C6-ZY-003', role: 'supporting' }], ...o });
async function addQ(tx: Tx, q: Record<string, unknown>) {
  const [r] = await tx`select cms.cms_add_questions(${tx.json({ topic_id: 'ST0325', origin: 'manual', questions: [q] } as never)}) as r`;
  return (r!.r as { added: { question_id: string }[] }).added[0]!.question_id;
}
/** An expected failure inside a savepoint, so the test transaction goes on. */
const fails = (tx: Tx, fn: (sp: Tx) => Promise<unknown>, re: RegExp) => expect(tx.savepoint((sp) => fn(sp as unknown as Tx))).rejects.toThrow(re);
const ver = async (tx: Tx, qid: string) => (await tx`select v.* from cms.cms_questions q join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version where q.question_id = ${qid}`)[0]!;
const review = (tx: Tx, p: Record<string, unknown>) => tx`select cms.cms_save_science_review(${tx.json(p as never)}) as r`;
const approve = (tx: Tx, qid: string, vno: number) => tx`select cms.cms_set_status(${qid}, ${vno}, 'approve', null)`;
async function readyForApproval(tx: Tx, h: { as: () => Promise<void>; owner: () => Promise<void> }, qid: string) {
  await h.owner();
  await tx`update cms.cms_question_versions set reading = 2, steps = 1, inhibition = 1, visual = 0, has_irrelevant_info = false, science_question_type = 2, originality_pending = false where question_id = ${qid}`;
  await h.as();
}

describe('Science review (0035)', () => {
  it('Add question: first direct row is primary; misconception and wrong options are items of its rows; an off-row item is refused', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx); await h.as();
      const id = await addQ(tx, newQ({ misconception: { row_id: 'C6-ZY-002', item_no: 1 }, wrong_answers: [{ value: 'Wood', mc: { row_id: 'C6-ZY-003', item_no: 2 } }] }));
      const v = await ver(tx, id);
      expect(v).toMatchObject({ misconception_row_id: 'C6-ZY-002', misconception_item_no: 1, misconception_targeted: null });
      expect((await tx`select row_id, rank, weight::text from cms.cms_question_content_rows where version_id = ${v.version_id} order by row_id`).map((r) => `${r.row_id}:${r.rank}:${r.weight}`))
        .toEqual(['C6-ZY-001:primary:1.0', 'C6-ZY-002:secondary:0.5', 'C6-ZY-003:context:0.0']);
      expect((await tx`select value, option_position, tag, mc_row_id, mc_item_no from cms.cms_version_wrong_answers where version_id = ${v.version_id}`)[0])
        .toMatchObject({ value: 'Wood', option_position: 1, tag: 'misconception', mc_row_id: 'C6-ZY-003', mc_item_no: 2 });
      await fails(tx, (sp) => addQ(sp, newQ({ misconception: { row_id: 'C6-04-014', item_no: 1 } })), /item of one of its content rows/);
    });
  });

  it('an explicit primary must be a direct row; only one primary', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx); await h.as();
      const id = await addQ(tx, newQ({ content_rows: [{ row_id: 'C6-ZY-001', role: 'direct' }, { row_id: 'C6-ZY-002', role: 'direct', rank: 'primary' }] }));
      expect((await tx`select row_id from cms.cms_question_content_rows where version_id = ${(await ver(tx, id)).version_id} and rank = 'primary'`)[0]!.row_id).toBe('C6-ZY-002');
      await fails(tx, (sp) => addQ(sp, newQ({ content_rows: [{ row_id: 'C6-ZY-003', role: 'supporting', rank: 'primary' }] })), /primary content row must be a direct row/);
    });
  });

  it('approval: needs Solution 1, a confirmed primary, no free text, active items of its rows', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx); await h.as();
      const id = await addQ(tx, newQ({ solution: '' }));
      await readyForApproval(tx, h, id);
      await fails(tx, (sp) => approve(sp, id, 1), /Solution 1 is empty/);
    });
    await rolledBack(async (tx, h) => {
      await setup(tx); await h.as();
      const id = await addQ(tx, newQ());
      await readyForApproval(tx, h, id);
      const v = await ver(tx, id);
      await h.owner(); await tx`update cms.cms_question_content_rows set rank_proposed = true where version_id = ${v.version_id} and rank = 'primary'`; await h.as();
      await fails(tx, (sp) => approve(sp, id, 1), /confirmed primary/);
      await review(tx, { question_id: id, version_no: 1, primary_row_id: 'C6-ZY-001' });
      await h.owner(); await tx`update cms.cms_question_versions set misconception_targeted = 'Free text.' where version_id = ${v.version_id}`; await h.as();
      await fails(tx, (sp) => approve(sp, id, 1), /free text/);
      await review(tx, { question_id: id, version_no: 1, misconception: { row_id: 'C6-ZY-001', item_no: 2 } });  // clears the free text
      await h.owner(); await tx`update cms.cms_row_misconceptions set status = 'needs_review' where row_id = 'C6-ZY-001' and item_no = 2`; await h.as();
      await fails(tx, (sp) => approve(sp, id, 1), /not an active item/);
      await tx`select cms.cms_set_row_misconception_status('C6-ZY-001', 2, 'active', null)`;
      await approve(tx, id, 1);
      expect((await ver(tx, id)).status).toBe('approved');
    });
  });

  it('the review box: drafts only, items of its rows only, one audit row with before → after', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx); await h.as();
      const id = await addQ(tx, newQ());
      await fails(tx, (sp) => review(sp, { question_id: id, version_no: 1, misconception: { row_id: 'C6-04-014', item_no: 1 } }), /item of one of this question/);
      await fails(tx, (sp) => review(sp, { question_id: id, version_no: 1, primary_row_id: 'C6-ZY-003' }), /direct rows/);
      await fails(tx, (sp) => review(sp, { question_id: id, version_no: 1, wrong: [{ position: 2, mc: { row_id: 'C6-ZY-001', item_no: 1 } }] }), /correct answer/);
      await review(tx, { question_id: id, version_no: 1, misconception: { row_id: 'C6-ZY-003', item_no: 1 }, primary_row_id: 'C6-ZY-002',
        wrong: [{ position: 1, mc: { row_id: 'C6-ZY-003', item_no: 1 } }, { position: 3, mc: { row_id: 'C6-ZY-002', item_no: 2 } }], solution1: 'Iron nail. Only iron is pulled.' });
      const [a] = await tx`select action, field_diff from cms.cms_reviews where target_id = ${`${id} v1`} and action = 'science_review'`;
      expect(a!.field_diff).toMatchObject({ misconception: { before: null, after: 'C6-ZY-003 #1' }, primary: { before: 'C6-ZY-001', after: 'C6-ZY-002' },
        wrong_options: { after: { 1: 'C6-ZY-003 #1', 3: 'C6-ZY-002 #2' } }, solution1: { after: 'Iron nail. Only iron is pulled.' } });
      await review(tx, { question_id: id, version_no: 1, wrong: [{ position: 3, mc: null }] });
      expect((await tx`select count(*)::int as n from cms.cms_version_wrong_answers where version_id = ${(await ver(tx, id)).version_id} and mc_row_id is not null`)[0]!.n).toBe(1);
    });
  });

  it('Edit → new version keeps links (with rank), citations, Science fields and items', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx); await h.as();
      const id = await addQ(tx, newQ({ misconception: { row_id: 'C6-ZY-002', item_no: 2 } }));
      await readyForApproval(tx, h, id);
      await approve(tx, id, 1);
      const v1 = await ver(tx, id);
      await h.owner();
      await tx`update cms.cms_question_versions set science_tier_legacy = 'L2', safety_note = 'Adult only.' where version_id = ${v1.version_id}`;
      await tx`insert into cms.cms_citations (version_id, source_id, page_from, page_to, raw) select ${v1.version_id}, source_id, 1, 1, 'NCERT p.1' from cms.cms_sources limit 1`;
      await h.as();
      const payload = { question_id: id, mode: 'new_version', base_version_no: 1, content_hash: 'a'.repeat(64), reason: 'test',
        version: { topic_id: 'ST0325', text: 'Which one does a magnet pull? (v2)', format: 'MCQ-4', correct: 'Iron nail', accepted: [] },
        question: { topic_id: 'ST0325' }, options: ['Wood', 'Iron nail', 'Glass', 'Paper'].map((t, i) => ({ part_label: '', position: i + 1, text: t, is_correct: t === 'Iron nail' })),
        wrong_answers: [{ part_label: '', value: 'Wood', option_position: 1, tag: 'misconception', mc_row_id: 'C6-ZY-001', mc_item_no: 1 }],
        solutions: [{ slot: 1, text: 'Iron nail.' }] };
      await tx`select cms.cms_apply_save(${tx.json(payload as never)})`;
      const v2 = await ver(tx, id);
      expect(v2).toMatchObject({ version_no: 2, level_tier: null, science_tier_legacy: 'L2', safety_note: 'Adult only.', misconception_row_id: 'C6-ZY-002', misconception_item_no: 2 });
      expect((await tx`select row_id, role, rank from cms.cms_question_content_rows where version_id = ${v2.version_id} order by row_id`).map((r) => `${r.row_id}:${r.rank}`))
        .toEqual(['C6-ZY-001:primary', 'C6-ZY-002:secondary', 'C6-ZY-003:context']);
      expect((await tx`select count(*)::int as n from cms.cms_citations where version_id = ${v2.version_id}`)[0]!.n).toBe(1);
      expect((await tx`select mc_row_id from cms.cms_version_wrong_answers where version_id = ${v2.version_id}`)[0]!.mc_row_id).toBe('C6-ZY-001');
      await fails(tx, (sp) => review(sp, { question_id: id, version_no: 1, solution1: 'x' }), /changed since you opened it/);
    });
  });

  it('RLS: another user sees no items and cannot decide one', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx); await h.as('00000000-0000-0000-0000-000000000001');
      expect((await tx`select count(*)::int as n from cms.cms_row_misconceptions`)[0]!.n).toBe(0);
      await fails(tx, (sp) => sp`select cms.cms_set_row_misconception_status('C6-ZY-001', 1, 'retired', 'x')`, /Only the CMS admin/);
    });
  });

  it('retiring an item needs a reason; decisions are audited', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx); await h.as();
      await fails(tx, (sp) => sp`select cms.cms_set_row_misconception_status('C6-ZY-001', 1, 'retired', '')`, /needs a reason/);
      await tx`select cms.cms_set_row_misconception_status('C6-ZY-001', 1, 'retired', 'duplicate')`;
      expect((await tx`select action from cms.cms_reviews where target_id = 'C6-ZY-001 #1'`).map((r) => r.action)).toEqual(['retire']);
    });
  });
});

// 0041 (Round 2, 17 Nov 2026): Q26 Science question attributes, Q27 the retired authored tier, Q28 settings by subject,
// Q32 Science wrong-option tags. Same fixtures as above; each test rolled back.
describe('Science attributes (0041)', () => {
  const save = (tx: Tx, p: Record<string, unknown>) => tx`select cms.cms_apply_save(${tx.json(p as never)})`;
  const opts = ['Wood', 'Iron nail', 'Glass', 'Paper'].map((t, i) => ({ part_label: '', position: i + 1, text: t, is_correct: t === 'Iron nail' }));
  const draftSave = (id: string, o: { version?: Record<string, unknown>; question?: Record<string, unknown>; wrong?: Record<string, unknown>[] } = {}) => ({
    question_id: id, mode: 'update_draft', base_version_no: 1, content_hash: 'b'.repeat(64), reason: 'test',
    version: { topic_id: 'ST0325', text: 'Which one does a magnet pull?', format: 'MCQ-4', correct: 'Iron nail', accepted: [], reading: 2, steps: 1, inhibition: 1, visual: 0,
      has_irrelevant_info: false, ...o.version },
    question: { topic_id: 'ST0325', ...o.question }, options: opts, wrong_answers: o.wrong ?? [], solutions: [{ slot: 1, text: 'Iron nail.' }] });

  it('saves the S1 fields and a Science setting; refuses a Math setting and S1 fields on a Math version', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx);
      await tx`insert into cms.cms_settings (setting_id, name, status, subject) values ('SET9901', 'Test kitchen (science)', 'proposed', 'science'), ('SET9902', 'Test shop (math)', 'proposed', 'math')`;
      await h.as();
      const id = await addQ(tx, newQ());
      await save(tx, draftSave(id, { version: { science_question_type: 3, setting_familiarity: 'Everyday', has_hidden_idea: true, has_experiment: false }, question: { setting_id: 'SET9901' } }));
      expect(await ver(tx, id)).toMatchObject({ science_question_type: 3, setting_familiarity: 'Everyday', has_hidden_idea: true, has_experiment: false });
      expect((await tx`select setting_id from cms.cms_questions where question_id = ${id}`)[0]!.setting_id).toBe('SET9901');
      await fails(tx, (sp) => save(sp, { ...draftSave(id, { question: { setting_id: 'SET9902' } }) }), /not a science setting/);
      // a save without setting_id leaves the setting alone; an explicit null clears it (bare)
      await save(tx, draftSave(id));
      expect((await tx`select setting_id from cms.cms_questions where question_id = ${id}`)[0]!.setting_id).toBe('SET9901');
      await save(tx, draftSave(id, { question: { setting_id: null } }));
      expect((await tx`select setting_id from cms.cms_questions where question_id = ${id}`)[0]!.setting_id).toBeNull();
      await h.owner();
      const [m] = await tx`select v.version_id from cms.cms_question_versions v join cms.cms_questions q on q.question_id = v.question_id where q.subject = 'math' limit 1`;
      await fails(tx, (sp) => sp`update cms.cms_question_versions set science_question_type = 1 where version_id = ${m!.version_id}`, /Science-only fields/);
      await fails(tx, (sp) => sp`update cms.cms_question_versions set setting_familiarity = 'Rare' where version_id = ${m!.version_id}`, /Science-only fields/);
    });
  });

  it('the authored tier is frozen: no new level_tier, no change; a new version carries science_tier_legacy only', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx); await h.as();
      const id = await addQ(tx, newQ());
      const v = await ver(tx, id);
      await h.owner();
      await fails(tx, (sp) => sp`update cms.cms_question_versions set level_tier = 'L1' where version_id = ${v.version_id}`, /retired/);
      await tx`update cms.cms_question_versions set science_tier_legacy = 'L3' where version_id = ${v.version_id}`;
      await h.as();
      await readyForApproval(tx, h, id);
      await approve(tx, id, 1);
      await save(tx, { ...draftSave(id), mode: 'new_version' });
      expect(await ver(tx, id)).toMatchObject({ version_no: 2, level_tier: null, science_tier_legacy: 'L3' });
    });
  });

  it('approval needs the type; the blockers view says so and agrees with the trigger', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx); await h.as();
      const id = await addQ(tx, newQ());
      await readyForApproval(tx, h, id);
      const v = await ver(tx, id);
      await h.owner(); await tx`update cms.cms_question_versions set science_question_type = null where version_id = ${v.version_id}`; await h.as();
      expect((await tx`select reason from cms.cms_approval_blockers where question_id = ${id}`).map((r) => r.reason)).toEqual(['science_type_missing']);
      await fails(tx, (sp) => approve(sp, id, 1), /Science question type is not set/);
      await save(tx, draftSave(id, { version: { science_question_type: 1 } }));
      expect((await tx`select reason from cms.cms_approval_blockers where question_id = ${id}`).length).toBe(0);
      await approve(tx, id, 1);
      expect((await ver(tx, id)).status).toBe('approved');
    });
  });

  it('wrong options: the 9 tags; concept_error needs one of its rows; untagged never blocks approval; review box audited', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx);
      await tx`insert into cms.cms_content_rows (row_id, topic_id, chapter_id, row_class, type, chapter_role, content, misconceptions, question_use, source, sort, content_hash)
        values ('C6-ZY-009', 'ST0325', 'SC48', 6, 'Fact', 'Core', 'Test content C6-ZY-009: not linked.', '', 'OK', 'Claude-added', 9009, 'x')`;
      await h.as();
      const id = await addQ(tx, newQ());
      await readyForApproval(tx, h, id);
      // the save path: concept_error with a linked target row, shortcut with only a why, one option untagged
      await save(tx, draftSave(id, { version: { science_question_type: 2 }, wrong: [
        { part_label: '', value: 'Wood', option_position: 1, tag: 'concept_error', target_row_id: 'C6-ZY-002' },
        { part_label: '', value: 'Glass', option_position: 3, tag: 'shortcut', why: 'picks the shiny one' }] }));
      // concept_error without any target is refused by the CHECK; a target row goes only with concept_error
      await fails(tx, (sp) => save(sp, draftSave(id, { wrong: [{ part_label: '', value: 'Wood', option_position: 1, tag: 'concept_error' }] })), /check1|violates check/);
      await fails(tx, (sp) => save(sp, draftSave(id, { wrong: [{ part_label: '', value: 'Wood', option_position: 1, tag: 'misread', target_row_id: 'C6-ZY-002' }] })), /target_row_only_concept_error/);
      // the review box: a concept error must target one of its rows; any other tag is fine; null clears
      await fails(tx, (sp) => review(sp, { question_id: id, version_no: 1, wrong: [{ position: 4, tag: 'concept_error', target_row_id: 'C6-ZY-009' }] }), /target row from this question/);
      await review(tx, { question_id: id, version_no: 1, wrong: [{ position: 4, tag: 'misread' }, { position: 3, tag: null }] });
      const tags = (await tx`select option_position, tag, target_row_id from cms.cms_version_wrong_answers w join cms.cms_question_versions v on v.version_id = w.version_id
        where v.question_id = ${id} order by option_position`).map((r) => `${r.option_position}:${r.tag ?? '-'}:${r.target_row_id ?? ''}`);
      expect(tags).toEqual(['1:concept_error:C6-ZY-002', '3:-:', '4:misread:']);
      const [aud] = await tx`select field_diff from cms.cms_reviews where target_id = ${`${id} v1`} and action = 'science_review' order by review_id desc limit 1`;
      expect(aud!.field_diff).toMatchObject({ wrong_options: { after: { 1: 'concept_error → C6-ZY-002', 4: 'misread' } } });
      // an unlinked concept-error row blocks approval (trigger + view), a linked one does not
      const v = await ver(tx, id);
      await h.owner(); await tx`update cms.cms_version_wrong_answers set target_row_id = 'C6-ZY-009' where version_id = ${v.version_id} and tag = 'concept_error'`; await h.as();
      expect((await tx`select reason from cms.cms_approval_blockers where question_id = ${id}`).map((r) => r.reason)).toEqual(['science_concept_error_row_not_linked']);
      await fails(tx, (sp) => approve(sp, id, 1), /concept error needs a target row/);
      await h.owner(); await tx`update cms.cms_version_wrong_answers set target_row_id = 'C6-ZY-002' where version_id = ${v.version_id} and tag = 'concept_error'`; await h.as();
      await approve(tx, id, 1);
      expect((await ver(tx, id)).status).toBe('approved');
    });
  });
});

// 0042 (Round 2, Q29): the stored Science tier, the computed values (TS = SQL), Math-only tier recompute.
describe('Science derived (0042)', () => {
  it('the trigger sets the tier from the type; tier:recompute never judges Science', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx); await h.as();
      const id = await addQ(tx, newQ());
      const v = await ver(tx, id);
      expect(v.tier).toBeNull();
      await h.owner();
      for (const [t, tier] of [[1, 'School'], [3, 'School'], [4, 'Achiever'], [5, 'Super Achiever'], [null, null]] as const) {
        await tx`update cms.cms_question_versions set science_question_type = ${t} where version_id = ${v.version_id}`;
        expect((await ver(tx, id)).tier).toBe(tier);
      }
      await tx`update cms.cms_question_versions set science_question_type = 5 where version_id = ${v.version_id}`;
      expect((await tierChanges(tx as never)).some((c) => c.question_id === id)).toBe(false);
      expect((await tx`select science_question_type, markers from cms.cms_question_list where question_id = ${id}`)[0]).toMatchObject({ science_question_type: 5 });
    });
  });

  it('TS = SQL: markers, load, steps band, trap level and clone group on every Science version, plus a full fixture', async () => {
    await rolledBack(async (tx, h) => {
      await setup(tx); await h.as();
      const id = await addQ(tx, newQ());
      const v = await ver(tx, id);
      await h.owner();
      await tx`update cms.cms_question_versions set science_question_type = 4, reading = 2, steps = 6, inhibition = 3, has_hidden_idea = true, setting_familiarity = 'Rare' where version_id = ${v.version_id}`;
      await tx`delete from cms.cms_version_wrong_answers where version_id = ${v.version_id} and option_position = 3`;
      await tx`insert into cms.cms_version_wrong_answers (version_id, part_label, value, option_position, tag) values (${v.version_id}, '', 'Glass', 3, 'shortcut')`;
      const rows = await tx`
        select d.*, v.science_question_type, v.reading, v.steps, v.inhibition, v.has_hidden_idea, v.setting_familiarity, q.setting_id,
               (select coalesce(json_agg(json_build_object('row_id', l.row_id, 'role', l.role, 'rank', l.rank)), '[]') from cms.cms_question_content_rows l where l.version_id = d.version_id) as links,
               (select coalesce(json_agg(w.tag), '[]') from cms.cms_version_wrong_answers w where w.version_id = d.version_id) as tags
          from cms.cms_science_derived d join cms.cms_question_versions v on v.version_id = d.version_id join cms.cms_questions q on q.question_id = d.question_id`;
      expect(rows.length).toBeGreaterThan(1);
      for (const r of rows) {
        const ts = scienceDerive({ science_question_type: r.science_question_type, reading: r.reading, steps: r.steps, inhibition: r.inhibition, has_hidden_idea: r.has_hidden_idea,
          setting_familiarity: r.setting_familiarity, setting_id: r.setting_id, links: r.links, wrongTags: r.tags });
        expect(`${r.question_id} ${r.markers} ${(r.marker_list as string[]).join(',')} ${r.load} ${r.load_driver} ${r.steps_band} ${r.trap_level} ${r.primary_row_id} ${r.clone_key !== null}`)
          .toBe(`${r.question_id} ${ts.markers} ${ts.markerList.join(',')} ${ts.load} ${ts.loadDriver} ${ts.stepsBand} ${ts.trapLevel} ${ts.primaryRow} ${ts.cloneGroup !== null}`);
      }
      const mine = rows.find((r) => r.question_id === id)!;
      expect(mine).toMatchObject({ markers: 5, load: 4, load_driver: 'multi_step', steps_band: 4, trap_level: 1 });
      // same primary + type + setting → same clone group
      const id2 = await addQ(tx, newQ({ text: 'Which one does a magnet pull? (twin)' }));
      const v2 = await ver(tx, id2);
      await tx`update cms.cms_question_versions set science_question_type = 4 where version_id = ${v2.version_id}`;
      const ck = await tx`select question_id, clone_key from cms.cms_question_list where question_id in (${id}, ${id2})`;
      expect(ck[0]!.clone_key).toBe(ck[1]!.clone_key);
    });
  });
});

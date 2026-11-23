// Q38 PR 1: the generation pack import against THIS repo's local database (npm run test:db). Synthetic content rows and
// questions in our own words (no book text), each test inside one transaction that is rolled back (sequences never roll
// back; IDs are never reused anyway). The batches run inside that transaction, exactly as gen:import sends them.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../scripts/lib/db.ts';
import { assertLocal, LOCAL_CMS_OWNER_URL, LOCAL_SUPERUSER_URL } from '../scripts/local-bootstrap.ts';
import { runPackImport, type FigureStore, type Mode, type Pack, type PackQuestion, type ReviewDecisions } from '../scripts/lib/gen-pack.ts';

assertLocal(LOCAL_CMS_OWNER_URL);
const sql = connect(LOCAL_CMS_OWNER_URL);
const su = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
afterAll(async () => { await sql.end(); await su.end(); });
class Done extends Error {}
async function inRollback(fn: (tx: postgres.TransactionSql) => Promise<void>, conn: postgres.Sql = sql) {
  await conn.begin(async (tx) => { await fn(tx); throw new Done(); }).catch((e) => { if (!(e instanceof Done)) throw e; });
}

const dir = mkdtempSync(join(tmpdir(), 'gen-pack-'));
const TOPIC = 'ST0003';   // local: SC01, home class 2, also linked to classes 1 and 6
const R1 = 'C2-ZQ-001', R2 = 'C2-ZQ-002', R3 = 'C2-ZQ-003', MISSING = 'C2-ZQ-009';
async function fixtures(tx: postgres.TransactionSql) {
  for (const [id, sort] of [[R1, 1], [R2, 2], [R3, 3]] as const) {
    await tx`insert into cms.cms_content_rows (row_id, topic_id, chapter_id, row_class, type, chapter_role, content, question_use, source, sort, content_hash)
      values (${id}, ${TOPIC}, 'SC01', 2, 'Fact', 'Core', ${`Test content of ${id}, our own words.`}, 'OK', 'CMS', ${9000 + sort}, ${`h-${id}`})`;
    await tx`insert into cms.cms_row_misconceptions (row_id, item_no, text, status, source) values (${id}, 1, ${`A test belief about ${id}.`}, 'active', 'row split')`;
  }
}
const q = (lid: string, extra: Partial<PackQuestion> = {}): PackQuestion => ({
  local_id: lid, subject: 'science', topic_id: TOPIC, class: 2, level: 2, format: 'MCQ-4', display_format: 'Scenario MCQ',
  text: `Test question ${lid}: which one is right?`, options: ['wa', 'wb', 'right', 'wd'], answer: 'C', solution_1: 'Because it is right.',
  figure_needed: false, figure: null,
  linked_rows: [{ row_id: R1, role: 'primary' }, { row_id: R2, role: 'secondary' }, { row_id: R3, role: 'supporting' }],
  misconception: { row_id: R1, item_no: 1 },
  wrong_option_tags: [{ option: 'A', tag: 'misconception', row_id: R1, item_no: 1 }, { option: 'B', tag: 'concept_error', row_id: R3 }, { option: 'D', tag: 'partial' }],
  science_question_type: 2, setting: { new: 'garden-pond' }, setting_familiarity: 'Everyday', hidden_idea: false, experiment: false,
  drivers: { reading: 2, steps: 1, inhibition: 1, visual: 0, irrelevant_info: false },
  passed: true, warnings: [{ kind: 'type', reason: 'type 3 -> 2' }], warning_reason: 'type 3 -> 2', checks: { blind_solve: 'C = key' },
  originality: { result: 'clear', similarity: 0.31, same_numbers: false, closest_ref: 'TEST-BOOK p3', field: 'text' }, review: null, ...extra,
});
const pack = (questions: PackQuestion[], source_run = `ZZTEST-${Math.random().toString(36).slice(2, 8)}`): Pack => ({
  file_schema: 'generation-pack/1',
  run: { source_run, subject: 'science', route: 'B', engine: 'test', models: { writer: 'claude-sonnet-5-5' }, rule_version: 'v11', cost_usd: 0.5 },
  originality: { tool: 'test', checked_at: '2026-11-23T00:00:00Z', threshold: 0.6, near_copy_threshold: 0.85, read: ['TEST-BOOK (local OCR)'], missing: [] },
  catalogue_new: { settings: [{ local_id: 'garden-pond', name: `Test garden pond ${source_run}` }] },
  questions,
});
const review = (d: Record<string, 'approve' | 'fix' | 'drop' | 'rescue'>): ReviewDecisions =>
  ({ sha256: 'f'.repeat(64), decisions: new Map(Object.entries(d).map(([k, v]) => [k, { decision: v, comment: null, sheet: 'Questions' }])) });
class MemFigures implements FigureStore { keys = new Map<string, number>(); async ensure(key: string, b: Buffer) { const had = this.keys.has(key); this.keys.set(key, b.length); return had ? 'present' as const : 'uploaded' as const; } }
const run = (tx: postgres.TransactionSql, p: Pack, mode: Mode, r: ReviewDecisions | null, figures: FigureStore = new MemFigures()) => {
  const path = join(dir, `${p.run.source_run}.json`);
  writeFileSync(path, JSON.stringify(p));
  return runPackImport({ packPath: path, pack: p, mode, review: r, dryRun: false, batchSize: 2, figures, runUnit: async (_l, fn) => fn(tx as unknown as Sql) });
};

describe('gen:import (local, rolled back)', () => {
  it('pilot: imports only approved questions as Needs review, with every Science field; the rest is recorded, held or dropped; nothing outside the run changes', async () => {
    await inRollback(async (tx) => {
      await fixtures(tx);
      const [before] = await tx`select count(*)::int as n, md5(string_agg(row_id || coalesce(updated_at::text, ''), ',' order by row_id)) as h from cms.cms_content_rows`;
      const [tc] = await tx`select (select count(*)::int from cms.cms_topic_classes) + (select count(*)::int from cms.cms_topic_class_proposals) as n`;
      writeFileSync(join(dir, 'fig.png'), Buffer.alloc(30));
      const p = pack([
        q('T-01', { figure_needed: true, figure: { file: 'fig.png', sha256: 'a'.repeat(64) } }),
        q('T-02', { linked_rows: [{ row_id: MISSING, role: 'primary' }], misconception: null, wrong_option_tags: [] }),
        q('T-03'),
        q('T-04', { originality: { result: 'near_copy', similarity: 0.91, closest_ref: 'TEST-BOOK p9', field: 'text' } }),
        q('T-05', { passed: false }),
        q('T-06', { class: 5 }),
      ]);
      const figs = new MemFigures();
      const r = await run(tx, p, 'pilot', review({ 'T-01': 'approve', 'T-02': 'approve', 'T-03': 'fix', 'T-04': 'approve', 'T-06': 'approve' }), figs);
      expect(r.created).toBe(true);
      expect(r.run_code).toMatch(/^GR\d{4}$/);
      expect(Object.fromEntries(r.items.map((i) => [i.local_id, i.status]))).toEqual({
        'T-01': 'imported', 'T-02': 'held', 'T-03': 'dropped_review', 'T-04': 'dropped_near_copy', 'T-05': 'dropped_checks', 'T-06': 'held' });
      expect([...figs.keys.keys()]).toEqual([`figures/${r.run_code}-T-01.png`]);   // uploaded before its batch
      expect(r.closed!.status).toBe('imported');

      const qid = r.items.find((i) => i.local_id === 'T-01')!.question_id!;
      const [qq] = await tx`select q.*, s.status as set_status, s.subject as set_subject from cms.cms_questions q left join cms.cms_settings s using (setting_id) where q.question_id = ${qid}`;
      expect(qq).toMatchObject({ bank: 'production', subject: 'science', chapter_id: 'SC01', topic_id: TOPIC, class: 2, level: 2, source_qid: null, set_status: 'proposed', set_subject: 'science' });
      expect(qq!.file_key).toMatch(/^SC01-(5\d{3}|[6-9]\d{3})$/);
      expect(qq!.setting_id).toBe(r.settings['garden-pond']);
      const [v] = await tx`select * from cms.cms_question_versions where question_id = ${qid}`;
      expect(v).toMatchObject({ version_no: 1, status: 'in_review', created_from: 'generation', run_id: String(r.run_id), import_id: String(r.import_id),
        format: 'MCQ-4', correct: 'right', display_format: 'Scenario MCQ', science_question_type: 2, setting_familiarity: 'Everyday', has_hidden_idea: false,
        has_experiment: false, reading: 2, steps: 1, inhibition: 1, visual: 0, has_irrelevant_info: false, misconception_row_id: R1, misconception_item_no: 1,
        image_status: 'has_image', image_path: `figures/${r.run_code}-T-01.png`, originality_pending: false, attributes_pending: false });
      expect((await tx`select row_id, role, rank, rank_proposed from cms.cms_question_content_rows where version_id = ${v!.version_id} order by row_id`).map((x) => ({ ...x })))
        .toEqual([{ row_id: R1, role: 'direct', rank: 'primary', rank_proposed: false }, { row_id: R2, role: 'direct', rank: 'secondary', rank_proposed: false },
                  { row_id: R3, role: 'supporting', rank: 'context', rank_proposed: false }]);
      expect((await tx`select option_position, value, tag, mc_row_id, mc_item_no, target_row_id from cms.cms_version_wrong_answers where version_id = ${v!.version_id} order by 1`).map((x) => ({ ...x })))
        .toEqual([{ option_position: 1, value: 'wa', tag: 'misconception', mc_row_id: R1, mc_item_no: 1, target_row_id: null },
                  { option_position: 2, value: 'wb', tag: 'concept_error', mc_row_id: null, mc_item_no: null, target_row_id: R3 },
                  { option_position: 4, value: 'wd', tag: 'partial', mc_row_id: null, mc_item_no: null, target_row_id: null }]);
      expect((await tx`select position, is_correct from cms.cms_version_options where version_id = ${v!.version_id} order by 1`).map((x) => x.is_correct)).toEqual([false, false, true, false]);
      expect((await tx`select slot, text from cms.cms_version_solutions where version_id = ${v!.version_id}`).map((x) => x.slot)).toEqual([1]);
      const [oc] = await tx`select result, similarity::float, closest_ref, tool, threshold::float from cms.cms_originality_checks where version_id = ${v!.version_id}`;
      expect(oc).toEqual({ result: 'clear', similarity: 0.31, closest_ref: 'TEST-BOOK p3', tool: 'test', threshold: 0.6 });
      const [gi] = await tx`select * from cms.cms_generation_items where run_id = ${r.run_id} and local_id = 'T-01'`;
      expect(gi).toMatchObject({ status: 'imported', question_id: qid, warning_reason: 'type 3 -> 2', review: { decision: 'approve', comment: null } });
      expect(gi!.warnings).toEqual([{ kind: 'type', reason: 'type 3 -> 2' }]);
      // held: missing row (and class 5 not linked), kept with the pack item
      const held = await tx`select file_key, reason_code, run_id, question ->> 'local_id' as lid from cms.cms_held_out where run_id = ${r.run_id} order by file_key`;
      expect(held.map((h) => [h.file_key, h.reason_code])).toEqual([[`${r.run_code}/T-02`, 'row_missing'], [`${r.run_code}/T-06`, 'class_not_linked']]);
      // the audit names the run
      expect((await tx`select count(*)::int as n from cms.cms_reviews where by_label = ${`gen:${r.run_code}`}`)[0]!.n).toBeGreaterThanOrEqual(5);
      // nothing outside the run: content rows and topic–class links untouched
      const [after] = await tx`select count(*)::int as n, md5(string_agg(row_id || coalesce(updated_at::text, ''), ',' order by row_id)) as h from cms.cms_content_rows`;
      expect(after).toEqual(before);
      expect((await tx`select (select count(*)::int from cms.cms_topic_classes) + (select count(*)::int from cms.cms_topic_class_proposals) as n`)[0]).toEqual(tc);
    });
  });

  it('re-runs: same content is unchanged; a later approval imports in the same run; changed content is never touched', async () => {
    await inRollback(async (tx) => {
      await fixtures(tx);
      const p = pack([q('T-01'), q('T-03')]);
      const a = await run(tx, p, 'pilot', review({ 'T-01': 'approve' }));
      expect(a.items.map((i) => i.status)).toEqual(['imported', 'dropped_review']);
      const b = await run(tx, p, 'pilot', review({ 'T-01': 'approve', 'T-03': 'approve' }));
      expect(b.run_code).toBe(a.run_code);
      expect(b.created).toBe(false);
      expect(b.items.map((i) => i.status)).toEqual(['unchanged', 'imported']);
      const changed = { ...p, questions: [q('T-01', { text: 'A different question?' }), q('T-03')] };
      const c = await run(tx, changed, 'pilot', review({ 'T-01': 'approve', 'T-03': 'approve' }));
      expect(c.items.map((i) => i.status)).toEqual(['changed', 'unchanged']);
      expect(c.changed).toEqual(['T-01']);
      const [v] = await tx`select v.text from cms.cms_question_versions v where v.question_id = ${a.items[0]!.question_id!}`;
      expect(v!.text).toBe('Test question T-01: which one is right?');
    });
  });

  it('a bad value fails only that item; the rest of the batch imports', async () => {
    await inRollback(async (tx) => {
      await fixtures(tx);
      // bypassing the pack checks: the database refuses a tag on the correct option, and a misconception from another row
      const p = pack([q('T-01', { wrong_option_tags: [{ option: 'C', tag: 'partial' }] }),
                      q('T-02', { wrong_option_tags: [{ option: 'A', tag: 'misconception', row_id: 'C2-ZQ-777', item_no: 1 }] }), q('T-03')]);
      const r = await tx.savepoint((sp) => run(sp, p, 'steady', null)).catch((e) => e as Error);
      expect((r as Error).message).toMatch(/Steady state is not enabled/);
      const ok = await run(tx, p, 'pilot', review({ 'T-01': 'approve', 'T-02': 'approve', 'T-03': 'approve' }));
      expect(ok.items.map((i) => [i.local_id, i.status])).toEqual([['T-01', 'failed'], ['T-02', 'failed'], ['T-03', 'imported']]);
      expect(ok.items[0]!.error).toMatch(/correct option \(C\) can't be tagged/);
      expect(ok.items[1]!.error).toMatch(/not an item of its linked rows/);
      expect(ok.closed!.status).toBe('partial');
      expect((await tx`select count(*)::int as n from cms.cms_questions where question_id in (select question_id from cms.cms_generation_items where run_id = ${ok.run_id} and question_id is not null)`)[0]!.n).toBe(1);
    });
  });

  it('steady state (once switched on): everything that passed lands as Needs review with a PROPOSED primary', async () => {
    await inRollback(async (tx) => {
      await fixtures(tx);
      await tx`update cms.cms_config set value = '{"math": {}, "science": {"2": true}}' where key = 'gen_steady_state'`;
      const r = await run(tx, pack([q('T-01'), q('T-05', { passed: false }), q('T-07', { review: { decision: 'drop' } })]), 'steady', null);
      expect(r.items.map((i) => i.status)).toEqual(['imported', 'dropped_checks', 'dropped_review']);
      const [l] = await tx`select l.rank_proposed from cms.cms_question_content_rows l join cms.cms_question_versions v using (version_id) where v.question_id = ${r.items[0]!.question_id!} and l.rank = 'primary'`;
      expect(l!.rank_proposed).toBe(true);
      // Route A: originality not checked → pending (approval blocked until the Mac sweep)
      const a = await run(tx, { ...pack([q('A-01', { originality: 'not_checked' })]), run: { ...pack([]).run, route: 'A', source_run: 'ZZA-1' } }, 'steady', null);
      const [va] = await tx`select originality_pending from cms.cms_question_versions where question_id = ${a.items[0]!.question_id!}`;
      expect(va!.originality_pending).toBe(true);
      await expect(tx.savepoint((sp) => sp`update cms.cms_question_versions set status = 'approved' where question_id = ${a.items[0]!.question_id!}`)).rejects.toThrow(/originality check is pending/);
    });
  });

  it('held-out generated items are placed from the Held-out area with the same writer', async () => {
    await inRollback(async (tx) => {
      await fixtures(tx);
      const r = await run(tx, pack([q('T-02', { linked_rows: [{ row_id: MISSING, role: 'primary' }], misconception: null, wrong_option_tags: [] })]), 'pilot', review({ 'T-02': 'approve' }));
      const held = r.items[0]!.held_id!;
      await expect(tx.savepoint((sp) => sp`select cms.cms_gen_place_held(${sp.json({ held_id: held } as never)})`)).rejects.toThrow(/still can't be placed: content row C2-ZQ-009/);
      await tx`insert into cms.cms_content_rows (row_id, topic_id, chapter_id, row_class, type, chapter_role, content, question_use, source, sort, content_hash)
        values (${MISSING}, ${TOPIC}, 'SC01', 2, 'Fact', 'Core', 'Added in the CMS, our own words.', 'OK', 'CMS', 9009, 'h')`;
      const [p] = await tx`select cms.cms_gen_place_held(${tx.json({ held_id: held, note: 'row added' } as never)}) as r`;
      const [h] = await tx`select status, placed_question_id from cms.cms_held_out where held_id = ${held}`;
      expect(h).toEqual({ status: 'placed', placed_question_id: p!.r.question_id });
      const [gi] = await tx`select status, question_id, held_id from cms.cms_generation_items where run_id = ${r.run_id}`;
      expect(gi).toEqual({ status: 'imported', question_id: p!.r.question_id, held_id: String(held) });
    });
  });

  it('rollback retires unapproved, unedited questions, keeps edited ones, discards held items and unused new settings', async () => {
    await inRollback(async (tx) => {
      await fixtures(tx);
      const r = await run(tx, pack([q('T-01'), q('T-03', { setting: null }), q('T-02', { linked_rows: [{ row_id: MISSING, role: 'primary' }], misconception: null, wrong_option_tags: [] })]),
        'pilot', review({ 'T-01': 'approve', 'T-02': 'approve', 'T-03': 'approve' }));
      expect(r.items.map((i) => [i.local_id, i.status, i.error ?? ''])).toEqual([['T-01', 'imported', ''], ['T-02', 'held', ''], ['T-03', 'imported', '']]);
      const [q1, q3] = [r.items.find((i) => i.local_id === 'T-01')!.question_id!, r.items.find((i) => i.local_id === 'T-03')!.question_id!];
      await tx`update cms.cms_question_versions set edited_at = now() where question_id = ${q3}`;
      await expect(tx.savepoint((sp) => sp`select cms.cms_gen_rollback(${sp.json({ run_code: r.run_code } as never)})`)).rejects.toThrow(/needs a reason/);
      const [rb] = await tx`select cms.cms_gen_rollback(${tx.json({ run_code: r.run_code, reason: 'test' } as never)}) as r`;
      expect(rb!.r).toMatchObject({ retired: [q1], kept: [{ question_id: q3, why: 'edited' }], held_discarded: 1, settings_retired: [r.settings['garden-pond']] });
      expect((await tx`select retired_at is not null as gone from cms.cms_questions where question_id in (${q1}, ${q3}) order by question_id`).map((x) => x.gone)).toEqual([true, false]);
      expect((await tx`select count(*)::int as n from cms.cms_questions where question_id = ${q1}`)[0]!.n).toBe(1);   // retired, never deleted
      const again = await run(tx, pack([q('T-01')], (await tx`select source_run from cms.cms_generation_runs where run_id = ${r.run_id}`)[0]!.source_run), 'pilot', review({ 'T-01': 'approve' }));
      expect(again.run_code).not.toBe(r.run_code);   // a rolled-back run is closed; the same engine run opens a new CMS run
      // its setting was retired by the rollback only, so it comes back as Proposed (same ID, audited)
      expect(again.settings['garden-pond']).toBe(r.settings['garden-pond']);
      expect((await tx`select status from cms.cms_settings where setting_id = ${r.settings['garden-pond']!}`)[0]!.status).toBe('proposed');
    });
  });

  it('only the CMS admin or a Mac import session may call the generation functions', async () => {
    const [{ value: adminId }] = await sql`select value #>> '{}' as value from cms.cms_config where key = 'admin_user_id'` as unknown as [{ value: string }];
    await inRollback(async (tx) => {
      await tx.unsafe('set local role authenticated');
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: '00000000-0000-0000-0000-000000000001', role: 'authenticated' })}, true)`;
      await expect(tx.savepoint((sp) => sp`select cms.cms_gen_open_run('{}'::jsonb)`)).rejects.toMatchObject({ code: '42501' });
      await expect(tx.savepoint((sp) => sp`select cms.cms_gen_write_item(null, 1, 1, 'x', 'x', '{}', null, false)`)).rejects.toThrow(/permission denied/);
    }, su);
    await inRollback(async (tx) => {
      await tx.unsafe('set local role authenticated');
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: adminId, role: 'authenticated' })}, true)`;
      await expect(tx`select cms.cms_gen_open_run('{}'::jsonb)`).rejects.toThrow(/needs subject math or science/);   // past the admin check
    }, su);
  });
});

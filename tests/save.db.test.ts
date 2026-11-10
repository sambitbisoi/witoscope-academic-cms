// Phase 5 write path end to end (local Supabase): the shared TypeScript computes each
// save (planSave), the SQL functions apply it. Test-only IDs (MC97, MT9997, …), removed after.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChapter } from '../scripts/import-chapter.ts';
import { loadBundle } from '../scripts/lib/bundle.ts';
import { connect } from '../scripts/lib/db.ts';
import { assertLocal, LOCAL_CMS_OWNER_URL, LOCAL_SUPERUSER_URL } from '../scripts/local-bootstrap.ts';
import { questionFromDb } from '../shared/fromDb.ts';
import { planSave, rowsFor } from '../shared/save.ts';
import type { ChapterFile, DerivedConfig, Question } from '../shared/types.ts';
import { structureHash } from '../shared/version.ts';

assertLocal(LOCAL_SUPERUSER_URL);
const owner = connect(LOCAL_CMS_OWNER_URL);
const su = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
let adminId = ''; let cfg: DerivedConfig; let qid = '';
const APP_USER_ID = '00000000-0000-4000-8000-000000000001';

/** Run as `authenticated` with the given user's claims, and COMMIT. */
async function as<T>(uid: string | null, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return su.begin(async (tx) => {
    await tx.unsafe('set local role authenticated');
    if (uid) await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`;
    return fn(tx);
  }) as Promise<T>;
}
const apply = (payload: unknown, uid = adminId) => as(uid, async (tx) => (await tx`select cms.cms_apply_save(${tx.json(payload as never)}) as r`)[0]!.r);
const status = (id: string, v: number, action: string, reason: string | null = null, uid = adminId) =>
  as(uid, async (tx) => (await tx`select cms.cms_set_status(${id}, ${v}, ${action}, ${reason}) as r`)[0]!.r);

async function current(id = qid) {
  const [q] = await owner`select * from cms.cms_questions where question_id = ${id}`;
  const [v] = await owner`select * from cms.cms_question_versions where question_id = ${id} and version_no = ${q!.current_version}`;
  return { q: q!, v: v!, question: questionFromDb(await loadBundle(owner, Number(v!.version_id))) };
}
async function plan(edit: (q: Question) => void, opts: { forceNewVersion?: boolean; id?: string } = {}) {
  const c = await current(opts.id);
  const after = structuredClone(c.question); edit(after);
  return planSave({ questionId: c.q.question_id, baseVersionNo: c.q.current_version, currentStatus: c.v.status, retired: !!c.q.retired_at,
    before: c.question, after, cfg, questionClass: 6, conceptClass: () => 6, forceNewVersion: opts.forceNewVersion });
}

async function cleanup() {
  const qids = (await owner`select question_id from cms.cms_questions where file_key like 'MC97-%' or question_id = 'G6-997'`).map((r) => r.question_id as string);
  await owner`delete from cms.cms_reviews where target_table = 'cms_generation_runs'`;
  if (qids.length) {
    const vids = (await owner`select version_id from cms.cms_question_versions where question_id in ${owner(qids)}`).map((r) => r.version_id);
    for (const t of ['cms_version_parts', 'cms_version_options', 'cms_version_wrong_answers', 'cms_version_concepts', 'cms_version_solutions', 'cms_version_hints', 'cms_version_source_refs', 'cms_originality_checks']) {
      if (vids.length) await owner`delete from ${owner(`cms.${t}`)} where version_id in ${owner(vids)}`;
    }
    await owner`delete from cms.cms_reviews where target_id like any (${qids.flatMap((q) => [q, `${q} v%`])})`;
    await owner`delete from cms.cms_question_versions where question_id in ${owner(qids)}`;
    await owner`delete from cms.cms_gold_meta where question_id in ${owner(qids)}`;
    await owner`delete from cms.cms_questions where question_id in ${owner(qids)}`;
  }
  await owner`delete from cms.cms_reviews where import_id in (select import_id from cms.cms_imports where chapter_id = 'MC97')`;
  await owner`delete from cms.cms_generation_runs where model = 'claude-test-model'`;
  await owner`delete from cms.cms_tagging_packs where pack_version like 'test-pack-%'`;
  await owner`delete from cms.cms_jobs where type = 'test_batch'`;
  await owner`delete from cms.cms_imports where chapter_id = 'MC97'`;
  await owner`delete from cms.cms_typical_sets where typical_set_id = 'TS-G6-ZX-TEST'`;
  await owner`delete from cms.cms_misconceptions where misconception_id = 'G6-M-ZXZ1'`;
  await owner`delete from cms.cms_concepts where concept_id like 'G6-ZXZ-%'`;
  await owner`delete from cms.cms_topics where chapter_id = 'MC97'`;
  await owner`delete from cms.cms_chapters where chapter_id = 'MC97'`;
  await owner`delete from cms.cms_strands where strand_id = 'math-ZX'`;
}

beforeAll(async () => {
  await cleanup();
  adminId = (await owner`select value #>> '{}' as id from cms.cms_config where key = 'admin_user_id'`)[0]!.id;
  cfg = Object.fromEntries((await owner`select key, value from cms.cms_config where key in ('multistep_bands','difficulty_points','load_thresholds')`).map((r) => [r.key, r.value])) as DerivedConfig;
  await owner`insert into cms.cms_strands (strand_id, subject, code, name, sort) values ('math-ZX', 'math', 'ZX', 'Save test strand', 997)`;
  await owner`insert into cms.cms_chapters (chapter_id, subject, strand_id, name, sort) values ('MC97', 'math', 'math-ZX', 'Save test chapter', 997)`;
  await owner`insert into cms.cms_topics (topic_id, chapter_id, class, name) values ('MT9997', 'MC97', 6, 'Save test topic')`;
  await owner`insert into cms.cms_concepts (concept_id, subject, class, topic_id, name) values ('G6-ZXZ-C1', 'math', 6, 'MT9997', 'Test concept')`;
  await owner`insert into cms.cms_misconceptions (misconception_id, concept_id, description) values ('G6-M-ZXZ1', 'G6-ZXZ-C1', 'Test misconception')`;
  await owner`insert into cms.cms_typical_sets (typical_set_id, subject, class, chapter_id, topic_id, name) values ('TS-G6-ZX-TEST', 'math', 6, 'MC97', 'MT9997', 'Save test set')`;
  const f = JSON.parse(readFileSync('content/examples/MC19-example.json', 'utf8')
    .replaceAll('MC19', 'MC97').replaceAll('MT0393', 'MT9997').replaceAll('TS-G6-FRAC-ADD-UNLIKE', 'TS-G6-ZX-TEST')
    .replaceAll('G6-M-FRC1', 'G6-M-ZXZ1').replaceAll('G6-FRC-C1', 'G6-ZXZ-C1')) as ChapterFile;
  delete f.questions[0]!.source_refs;
  const p = join(mkdtempSync(join(tmpdir(), 'cms-save-test-')), 'f.json');
  writeFileSync(p, JSON.stringify(f));
  const r = await runChapter(owner, p, 'import');
  qid = r.outcomes[0]!.question_id!;
});
afterAll(async () => { await cleanup(); await Promise.all([owner.end(), su.end()]); });

describe('save path (planSave → cms_apply_save)', () => {
  it('a freshly imported question rebuilds to its stored fingerprint', async () => {
    const c = await current();
    expect(structureHash(c.question, c.question.topic_id)).toBe(c.v.content_hash);
    expect((await plan(() => {})).mode).toBeNull();
  });

  it('approve v1, then a wording-only change is a typo fix: same version, still approved, logged', async () => {
    expect((await status(qid, 1, 'approve')).status).toBe('approved');
    const p = await plan((q) => { q.hints[0] = 'Make both denominators the same.'; });
    expect(p.mode).toBe('typo_fix');
    await apply(p.payload);
    const c = await current();
    expect([c.v.version_no, c.v.status, c.q.approved_version]).toEqual([1, 'approved', 1]);
    expect(c.question.hints[0]).toBe('Make both denominators the same.');
    expect(c.v.edited_at).not.toBeNull();
    expect(structureHash(c.question, c.question.topic_id)).toBe(c.v.content_hash);
    const [rev] = await owner`select action, by_label from cms.cms_reviews where target_id = ${`${qid} v1`} order by review_id desc limit 1`;
    expect(rev).toEqual({ action: 'typo_fix', by_label: 'Sambit' });
  });

  it('hard rule 1: a "typo fix" that changes structure is refused, even if the browser sends it', async () => {
    const p = await plan((q) => { q.answer.options![3] = '11/12'; q.answer.wrong_answers![2]!.value = '11/12'; });
    expect(p.mode).toBe('new_version');
    await expect(apply({ ...p.payload, mode: 'typo_fix' })).rejects.toThrow(/typo fix cannot change/);
    expect((await current()).v.version_no).toBe(1);
  });

  it('a structure change makes v2 (draft); v1 stays approved', async () => {
    const p = await plan((q) => { q.signature.inhibition = 2; });
    expect(p.summary).toMatch(/^New version v2/);
    expect((await apply(p.payload)).version_no).toBe(2);
    const c = await current();
    expect([c.v.version_no, c.v.status, c.q.current_version, c.q.approved_version, c.v.inhibition]).toEqual([2, 'draft', 2, 1, 2]);
    expect(structureHash(c.question, c.question.topic_id)).toBe(c.v.content_hash);
  });

  it('hard rule 2: no second open version', async () => {
    const p = await plan((q) => { q.signature.visual = 1; });
    await expect(apply({ ...p.payload, mode: 'new_version' })).rejects.toThrow(/already has an open version \(v2\)/);
  });

  it('a draft is updated in place', async () => {
    const p = await plan((q) => { q.signature.visual = 1; q.text = '5/6 − 1/4 = ? (draft edit)'; });
    expect(p.mode).toBe('update_draft');
    await apply(p.payload);
    const c = await current();
    expect([c.v.version_no, c.v.visual, c.v.text]).toEqual([2, 1, '5/6 − 1/4 = ? (draft edit)']);
  });

  it('in review: editing is blocked; withdraw brings it back to draft', async () => {
    await status(qid, 2, 'submit');
    expect((await plan((q) => { q.hints[1] = 'x'; })).blocked).toBe('in_review');
    const draftPayload = (await (async () => { await status(qid, 2, 'withdraw'); return plan((q) => { q.hints[1] = 'x'; }); })()).payload;
    await status(qid, 2, 'submit');
    await expect(apply(draftPayload)).rejects.toThrow(/Only an open draft can be edited in place; v2 is in_review/);
  });

  it('reject needs a reason; v1 stays the approved version', async () => {
    await expect(status(qid, 2, 'reject', '  ')).rejects.toThrow(/needs a reason/);
    expect((await status(qid, 2, 'reject', 'Inhibition 2 is not justified')).status).toBe('rejected');
    const c = await current();
    expect([c.v.status, c.q.approved_version]).toEqual(['rejected', 1]);
  });

  it('after a rejection, any change (even wording) is a new version', async () => {
    const p = await plan((q) => { q.hints[2] = 'Rewritten hint.'; });
    expect(p.mode).toBe('new_version');
    await apply(p.payload);
    expect((await current()).v.version_no).toBe(3);
  });

  it('a stale save (the question moved on) is refused', async () => {
    const p = await plan((q) => { q.hints[0] = 'Stale.'; });
    await apply(p.payload);                              // v3 draft updated in place
    await status(qid, 3, 'approve');
    const stale = { ...p.payload!, base_version_no: 2 };
    await expect(apply(stale)).rejects.toThrow(/changed since you opened it/);
  });

  it('an app user is refused by every function; anon cannot call them at all', async () => {
    const p = await plan((q) => { q.hints[0] = 'App user.'; });
    await expect(apply(p.payload, APP_USER_ID)).rejects.toThrow(/Only the CMS admin/);
    await expect(status(qid, 3, 'reject', 'x', APP_USER_ID)).rejects.toThrow(/Only the CMS admin/);
    await expect(as(APP_USER_ID, (tx) => tx`select cms.cms_retire(${qid}, true, 'x')`)).rejects.toThrow(/Only the CMS admin/);
    await expect(su.begin(async (tx) => { await tx.unsafe('set local role anon'); await tx`select cms.cms_apply_save('{}'::jsonb)`; })).rejects.toThrow(/permission denied/);
  });

  it('no write grant: even the admin cannot update question tables directly', async () => {
    await expect(as(adminId, (tx) => tx`update cms.cms_question_versions set inhibition = 3 where question_id = ${qid}`)).rejects.toThrow(/permission denied/);
    await expect(as(adminId, (tx) => tx`update cms.cms_questions set bank = 'production' where question_id = ${qid}`)).rejects.toThrow(/permission denied/);
  });

  it('hard rule 3: gold stays gold whatever the payload says', async () => {
    // a gold copy of the test question (owner-only setup)
    await owner`insert into cms.cms_questions (question_id, bank, subject, chapter_id, topic_id, class, typical_set_id, clone_batch_id, locale, current_version, approved_version)
                select 'G6-997', 'gold', subject, chapter_id, topic_id, class, typical_set_id, clone_batch_id, locale, 1, 1 from cms.cms_questions where question_id = ${qid}`;
    const [{ version_id: src }] = await owner`select version_id from cms.cms_question_versions where question_id = ${qid} and version_no = 1` as unknown as [{ version_id: number }];
    const [{ version_id: gv }] = await owner`insert into cms.cms_question_versions (question_id, version_no, status, topic_id, typical_set_id, text, format, correct, accepted, duration_s,
        math_difficulty, is_pure_fact, reading, has_irrelevant_info, steps, working_memory, inhibition, visual, strategy, content_hash, created_from)
      select 'G6-997', 1, 'approved', topic_id, typical_set_id, text, format, correct, accepted, duration_s, math_difficulty, is_pure_fact, reading,
             has_irrelevant_info, steps, working_memory, inhibition, visual, strategy, content_hash, 'seed'
      from cms.cms_question_versions where version_id = ${src} returning version_id` as unknown as [{ version_id: number }];
    for (const t of ['cms_version_options', 'cms_version_wrong_answers', 'cms_version_concepts', 'cms_version_solutions', 'cms_version_hints']) {
      const cols = (await owner`select string_agg(column_name, ', ') as c from information_schema.columns where table_schema = 'cms' and table_name = ${t}
                                and column_name not in ('version_id', 'wrong_answer_id')`)[0]!.c as string;
      await owner.unsafe(`insert into cms.${t} (version_id, ${cols}) select ${gv}, ${cols} from cms.${t} where version_id = ${src}`);
    }
    const c = await current('G6-997');
    await owner`update cms.cms_question_versions set content_hash = ${structureHash(c.question, c.question.topic_id)} where version_id = ${gv}`;
    const p = await plan((q) => { (q as unknown as Record<string, unknown>).new_field_ignored = 1; q.text = '5/6 − 1/4 = ? (gold wording)'; }, { id: 'G6-997' });
    expect(p.mode).toBe('typo_fix');
    await apply({ ...p.payload, bank: 'production', question_id: 'G6-997' });
    const g = await current('G6-997');
    expect([g.q.bank, g.q.question_id, g.v.text]).toEqual(['gold', 'G6-997', '5/6 − 1/4 = ? (gold wording)']);
  });

  it('retire and restore need a reason; a retired question cannot be saved', async () => {
    await expect(as(adminId, (tx) => tx`select cms.cms_retire(${qid}, true, '')`)).rejects.toThrow(/needs a reason/);
    await as(adminId, (tx) => tx`select cms.cms_retire(${qid}, true, 'Duplicate of another question')`);
    expect((await plan((q) => { q.hints[0] = 'x'; })).blocked).toBe('retired');
    await expect(status(qid, 3, 'approve')).rejects.toThrow(/is retired/);
    await as(adminId, (tx) => tx`select cms.cms_retire(${qid}, false, 'Restored after review')`);
    expect((await current()).q.retired_at).toBeNull();
    const actions = (await owner`select action from cms.cms_reviews where target_id = ${qid} order by review_id`).map((r) => r.action);
    expect(actions).toEqual(['retire', 'restore']);
  });
});

describe('Phase 6: generated drafts, runs and jobs', () => {
  const createPayload = async (runId: number | null, text: string) => {
    const c = await current();
    const q = structuredClone(c.question); q.text = text; q.clone_batch_id = 'gen-test'; delete q.pattern_id;
    const rows = rowsFor(q, cfg, 6, () => 6);
    return { mode: 'create', base_version_no: null, content_hash: structureHash(q, q.topic_id), run_id: runId,
      question: { subject: 'math', chapter_id: 'MC97', class: 6, topic_id: q.topic_id, typical_set_id: q.typical_set_id, pattern_id: null, clone_batch_id: q.clone_batch_id, class_override: null, placement_note: null },
      version: { ...rows.version, tagged_by: 'ai' }, parts: rows.parts, options: rows.options, wrong_answers: rows.wrong_answers, concepts: rows.concepts,
      solutions: rows.solutions, hints: rows.hints, source_refs: [], diff: { generated: true }, reason: 'generated draft' };
  };
  let runId = 0;

  it('a run is logged with its tagging pack; tokens and cost are added when it finishes', async () => {
    runId = Number(await as(adminId, async (tx) => (await tx`select cms.cms_record_run(${tx.json({ kind: 'generate_similar', model: 'claude-test-model',
      pack: { version: 'test-pack-1', rule_version: 'v10', content: 'PACK', hash: 'h' }, params: { count: 2 } } as never)}) as id`)[0]!.id));
    await as(adminId, (tx) => tx`select cms.cms_record_run(${tx.json({ run_id: runId, tokens_in: 1200, tokens_out: 900, cost: 0.0114, status: 'ok', params: { usage: { cache_read_input_tokens: 8000 } } } as never)})`);
    const [r] = await owner`select kind, model, pack_version, tokens_in, tokens_out, cost::float as cost, status, params from cms.cms_generation_runs where run_id = ${runId}`;
    expect(r).toMatchObject({ kind: 'generate_similar', model: 'claude-test-model', pack_version: 'test-pack-1', tokens_in: 1200, tokens_out: 900, cost: 0.0114, status: 'ok' });
    expect(r!.params).toEqual({ count: 2, usage: { cache_read_input_tokens: 8000 } });
  });

  it('create: a new PRODUCTION draft with the next MQ id and a reserved file key, linked to its run', async () => {
    const res = await as(adminId, async (tx) => (await tx`select cms.cms_apply_save(${tx.json(await createPayload(runId, '7/8 − 1/3 = ?') as never)}) as r`)[0]!.r);
    expect(res.question_id).toMatch(/^MQ\d{6}$/);
    const [q] = await owner`select bank, file_key, current_version from cms.cms_questions where question_id = ${res.question_id}`;
    const [v] = await owner`select version_no, status, created_from, run_id, content_hash from cms.cms_question_versions where question_id = ${res.question_id}`;
    expect(q).toEqual({ bank: 'production', file_key: 'MC97-5001', current_version: 1 });
    expect([v!.version_no, v!.status, v!.created_from, Number(v!.run_id)]).toEqual([1, 'draft', 'generation', runId]);
    const back = questionFromDb(await loadBundle(owner, Number((await owner`select version_id from cms.cms_question_versions where question_id = ${res.question_id}`)[0]!.version_id)));
    expect(structureHash(back, back.topic_id)).toBe(v!.content_hash);
    const res2 = await as(adminId, async (tx) => (await tx`select cms.cms_apply_save(${tx.json(await createPayload(runId, '9/10 − 1/5 = ?') as never)}) as r`)[0]!.r);
    expect((await owner`select file_key from cms.cms_questions where question_id = ${res2.question_id}`)[0]!.file_key).toBe('MC97-5002');
  });

  it('create never makes gold, whatever the payload says', async () => {
    const p = await createPayload(runId, '11/12 − 1/6 = ?') as Record<string, any>;
    p.bank = 'gold'; p.question.bank = 'gold';
    const res = await as(adminId, async (tx) => (await tx`select cms.cms_apply_save(${tx.json(p as never)}) as r`)[0]!.r);
    expect((await owner`select bank from cms.cms_questions where question_id = ${res.question_id}`)[0]!.bank).toBe('production');
  });

  it('a near-copy draft is approved only with "override: reviewed, not a copy" and a reason, logged', async () => {
    const res = await as(adminId, async (tx) => (await tx`select cms.cms_apply_save(${tx.json(await createPayload(runId, '13/14 − 1/7 = ? (near-copy probe)') as never)}) as r`)[0]!.r);
    const id = res.question_id as string;
    const [v] = await owner`select version_id from cms.cms_question_versions where question_id = ${id} and version_no = 1`;
    await owner`insert into cms.cms_originality_checks (version_id, checked_at, result, similarity, same_numbers, closest_ref, threshold, near_copy_threshold, tool)
                values (${v!.version_id}, now(), 'near_copy', 0.91, true, 'N6-01-004', 0.6, 0.85, 'test')`;
    const approve = (override: boolean, reason: string | null) =>
      as(adminId, async (tx) => (await tx`select cms.cms_set_status(${id}, 1, 'approve', ${reason}, ${override}) as r`)[0]!.r);
    await expect(status(id, 1, 'approve')).rejects.toThrow(/near-copy of a book \(N6-01-004\)/);
    await expect(approve(true, '  ')).rejects.toThrow(/needs a reason/);
    expect((await current(id)).v.status).toBe('draft');
    expect((await approve(true, 'Compared with p3: different context and numbers')).status).toBe('approved');
    const log = await owner`select action, reason, field_diff from cms.cms_reviews where target_id = ${`${id} v1`} and action in ('override_near_copy', 'approve') order by review_id`;
    expect(log.map((r) => r.action)).toEqual(['override_near_copy', 'approve']);
    expect(log[0]).toMatchObject({ reason: 'Compared with p3: different context and numbers',
      field_diff: { closest_ref: 'N6-01-004', similarity: 0.91, same_numbers: true, override: 'reviewed, not a copy' } });
  });

  it('jobs: a batch job is recorded, updated and finished', async () => {
    const jid = Number(await as(adminId, async (tx) => (await tx`select cms.cms_save_job(${tx.json({ type: 'test_batch', payload: { batch_id: 'msgbatch_x', run_id: runId } } as never)}) as id`)[0]!.id));
    await as(adminId, (tx) => tx`select cms.cms_save_job(${tx.json({ job_id: jid, status: 'ok', progress: 100, result: { saved: 3 } } as never)})`);
    const [j] = await owner`select status, progress::int as progress, payload, result, finished_at is not null as done from cms.cms_jobs where job_id = ${jid}`;
    expect(j).toEqual({ status: 'ok', progress: 100, payload: { batch_id: 'msgbatch_x', run_id: runId }, result: { saved: 3 }, done: true });
  });

  it('an app user can neither create drafts nor log runs or jobs', async () => {
    await expect(as(APP_USER_ID, async (tx) => tx`select cms.cms_apply_save(${tx.json(await createPayload(null, '1/2 + 1/3 = ?') as never)})`)).rejects.toThrow(/Only the CMS admin/);
    await expect(as(APP_USER_ID, (tx) => tx`select cms.cms_record_run(${tx.json({ kind: 'tag', model: 'claude-test-model' } as never)})`)).rejects.toThrow(/Only the CMS admin/);
    await expect(as(APP_USER_ID, (tx) => tx`select cms.cms_save_job(${tx.json({ type: 'test_batch' } as never)})`)).rejects.toThrow(/Only the CMS admin/);
  });
});

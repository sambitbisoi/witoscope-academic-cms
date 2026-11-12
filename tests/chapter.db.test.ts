// Chapter importer end to end, against THIS repo's local Supabase (npm run test:db).
// Uses test-only IDs (strand math-ZY, chapter MC98, topic MT9998, …) and removes them afterwards.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { runChapter } from '../scripts/import-chapter.ts';
import { connect } from '../scripts/lib/db.ts';
import { LOCAL_CMS_OWNER_URL } from '../scripts/local-bootstrap.ts';

// Database tests write and delete test rows: they ONLY ever use this repo's local
// container, whatever CMS_DATABASE_URL says (connect() also checks the container).
import type { ChapterFile, Question } from '../shared/types.ts';

const sql = connect(LOCAL_CMS_OWNER_URL);
const dir = mkdtempSync(join(tmpdir(), 'cms-chapter-test-'));

const STRATEGY_TYPES = ['Pattern', 'Work backwards', 'Table / list', 'Cases', 'Guess and check', 'Draw / bar model', 'Eliminate',
  'Logic / clues', 'Simplify', 'Smart calculation', 'Unitary method', 'Odd / even (parity)', 'Act it out / model', 'Other'];

/** The worked example, moved onto test-only IDs. */
function baseFile(): ChapterFile {
  const s = readFileSync('content/examples/MC19-example.json', 'utf8')
    .replaceAll('MC19', 'MC98').replaceAll('MT0393', 'MT9998').replaceAll('TS-G6-FRAC-ADD-UNLIKE', 'TS-G6-ZZ-TEST')
    .replaceAll('MP0007', 'MP9998').replaceAll('G6-M-FRC1', 'G6-M-ZZZ1').replaceAll('G6-FRC-C1', 'G6-ZZZ-C1');
  const f = JSON.parse(s) as ChapterFile;
  f.patterns = [{ pattern_id: 'MP9998', topic_id: 'MT9998', typical_set_id: 'TS-G6-ZZ-TEST', name: 'Test pattern' }];
  f.questions[0]!.pattern_id = 'MP9998';
  return f;
}
let n = 0;
async function run(f: ChapterFile, mode: 'validate' | 'import' = 'import', force = false) {
  const p = join(dir, `f${++n}.json`);
  writeFileSync(p, JSON.stringify(f, null, 2));
  return runChapter(sql, p, mode, force);
}
const q1 = (f: ChapterFile) => f.questions[0]!;
const outcome = (r: Awaited<ReturnType<typeof run>>, key = 'MC98-0001') => r.outcomes.find((o) => o.key === key)!;

async function cleanup() {
  const qids = (await sql`select question_id from cms.cms_questions where file_key like 'MC98-%'`).map((r) => r.question_id as string);
  const vids = qids.length ? (await sql`select version_id from cms.cms_question_versions where question_id in ${sql(qids)}`).map((r) => r.version_id) : [];
  if (vids.length) {
    for (const t of ['cms_version_parts', 'cms_version_options', 'cms_version_wrong_answers', 'cms_version_concepts', 'cms_version_solutions', 'cms_version_hints', 'cms_version_source_refs', 'cms_originality_checks']) {
      await sql`delete from ${sql(`cms.${t}`)} where version_id in ${sql(vids)}`;
    }
  }
  await sql`delete from cms.cms_reviews where import_id in (select import_id from cms.cms_imports where chapter_id = 'MC98' or file_path like ${'%cms-chapter-test-%'})`;
  if (qids.length) {
    await sql`delete from cms.cms_reviews where target_id like any (${qids.map((q) => `${q} v%`)})`;
    await sql`delete from cms.cms_question_versions where question_id in ${sql(qids)}`;
    await sql`delete from cms.cms_questions where question_id in ${sql(qids)}`;
  }
  await sql`delete from cms.cms_imports where chapter_id = 'MC98' or file_path like ${'%cms-chapter-test-%'}`;
  await sql`delete from cms.cms_patterns where pattern_id like 'MP99%'`;
  await sql`delete from cms.cms_typical_sets where typical_set_id = 'TS-G6-ZZ-TEST'`;
  await sql`delete from cms.cms_misconceptions where misconception_id = 'G6-M-ZZZ1'`;
  await sql`delete from cms.cms_concepts where concept_id like 'G6-ZZZ-%'`;
  await sql`delete from cms.cms_topics where chapter_id = 'MC98'`;
  await sql`delete from cms.cms_chapters where chapter_id = 'MC98'`;
  await sql`delete from cms.cms_strands where strand_id = 'math-ZY'`;
}

beforeAll(async () => {
  await cleanup();
  const [cfg] = await sql`select count(*)::int as n from cms.cms_config where key in ('multistep_bands', 'difficulty_points')`;
  if (cfg!.n !== 2) throw new Error('run `npm run import:seed` first (derived-field config)');
  await sql`insert into cms.cms_strategy_types ${sql(STRATEGY_TYPES.map((value, i) => ({ value, sort: i + 1 })))} on conflict do nothing`;
  await sql`insert into cms.cms_strands (strand_id, subject, code, name, sort) values ('math-ZY', 'math', 'ZY', 'Importer test strand', 998)`;
  await sql`insert into cms.cms_chapters (chapter_id, subject, strand_id, name, sort) values ('MC98', 'math', 'math-ZY', 'Importer test chapter', 998)`;
  await sql`insert into cms.cms_topics (topic_id, chapter_id, class, name, taught_in_school) values ('MT9998', 'MC98', 6, 'Importer test topic', true)`;
  await sql`insert into cms.cms_concepts (concept_id, subject, class, topic_id, name) values ('G6-ZZZ-C1', 'math', 6, 'MT9998', 'Test concept')`;
  await sql`insert into cms.cms_misconceptions (misconception_id, concept_id, description) values ('G6-M-ZZZ1', 'G6-ZZZ-C1', 'Test misconception')`;
  await sql`insert into cms.cms_typical_sets (typical_set_id, subject, class, chapter_id, topic_id, name) values ('TS-G6-ZZ-TEST', 'math', 6, 'MC98', 'MT9998', 'Test set')`;
});
afterAll(async () => { await cleanup(); await sql.end(); });

async function state() {
  const [q] = await sql`select * from cms.cms_questions where file_key = 'MC98-0001'`;
  const versions = q ? await sql`select version_id, version_no, status, edited_at, text, multistep_band, load, load_driver, style, tier, trap_level, is_isolating, difficulty_points
                                 from cms.cms_question_versions where question_id = ${q.question_id} order by version_no` : [];
  return { q, versions };
}

describe('chapter importer', () => {
  it('validate is a dry run: full report, nothing saved', async () => {
    const r = await run(baseFile(), 'validate');
    expect(r.result).toBe('ok');
    expect(outcome(r).result).toBe('created');
    expect(r.importId).toBeNull();
    expect((await state()).q).toBeUndefined();
    expect((await sql`select count(*)::int as n from cms.cms_patterns where pattern_id = 'MP9998'`)[0]!.n).toBe(0);
  });

  it('first import: new MQ ID, v1 draft, derived fields, child rows, import record', async () => {
    const r = await run(baseFile());
    expect(r.result).toBe('ok');
    const { q, versions } = await state();
    expect(q!.question_id).toMatch(/^MQ\d{6}$/);
    expect(q).toMatchObject({ bank: 'production', class: 6, chapter_id: 'MC98', topic_id: 'MT9998', current_version: 1, approved_version: null });
    const [placement] = await sql`select topic_id, typical_set_id, pattern_id from cms.cms_question_versions where question_id = ${q!.question_id}`;
    expect(placement).toEqual({ topic_id: 'MT9998', typical_set_id: 'TS-G6-ZZ-TEST', pattern_id: 'MP9998' });
    expect(r.problems.map((p) => p.message)).toContain('source ref N7-031 is not in the CMS yet (sources arrive in Phase 4)');
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version_no: 1, status: 'draft', multistep_band: 1, load: 1, load_driver: 'reading', style: 'one-liner',
      tier: 'School', trap_level: 2, is_isolating: true, difficulty_points: 5 });
    const vid = versions[0]!.version_id;
    const [c] = await sql`select
      (select count(*) from cms.cms_version_options where version_id = ${vid})::int as options,
      (select count(*) from cms.cms_version_options where version_id = ${vid} and is_correct)::int as correct,
      (select count(*) from cms.cms_version_wrong_answers where version_id = ${vid} and option_position is not null)::int as wrong,
      (select count(*) from cms.cms_version_concepts where version_id = ${vid})::int as concepts,
      (select count(*) from cms.cms_version_solutions where version_id = ${vid})::int as solutions,
      (select count(*) from cms.cms_version_hints where version_id = ${vid})::int as hints,
      (select count(*) from cms.cms_version_source_refs where version_id = ${vid})::int as refs`;
    expect(c).toEqual({ options: 4, correct: 1, wrong: 3, concepts: 1, solutions: 2, hints: 3, refs: 1 });
    const [imp] = await sql`select kind, result, chapter_id, file_hash, counts from cms.cms_imports where import_id = ${r.importId}`;
    expect(imp).toMatchObject({ kind: 'chapter', result: 'ok', chapter_id: 'MC98', counts: { created: 1 } });
    expect((await sql`select count(*)::int as n from cms.cms_patterns where pattern_id = 'MP9998'`)[0]!.n).toBe(1);
  });

  it('same file again → unchanged', async () => {
    expect(outcome(await run(baseFile())).result).toBe('unchanged');
  });

  it('open draft from an import, not edited → replaced in place and logged', async () => {
    const f = baseFile(); q1(f).answer.options![3] = '11/12'; q1(f).answer.wrong_answers![2]!.value = '11/12';
    const r = await run(f);
    expect(outcome(r)).toMatchObject({ result: 'draft_replaced', version: 1 });
    const { versions } = await state();
    expect(versions).toHaveLength(1);
    const opts = await sql`select text from cms.cms_version_options where version_id = ${versions[0]!.version_id} order by position`;
    expect(opts.map((o) => o.text)).toEqual(['7/12', '4/2', '4/12', '11/12']);
    const [rev] = await sql`select action, field_diff from cms.cms_reviews where import_id = ${r.importId}`;
    expect(rev!.action).toBe('import_replace_draft');
  });

  it('approved version + wording-only change → typo fix, same version, still approved', async () => {
    const { q } = await state();
    await sql`update cms.cms_question_versions set status = 'approved' where question_id = ${q!.question_id} and version_no = 1`;
    await sql`update cms.cms_questions set approved_version = 1 where question_id = ${q!.question_id}`;
    const f = baseFile(); q1(f).answer.options![3] = '11/12'; q1(f).answer.wrong_answers![2]!.value = '11/12';
    q1(f).hints[0] = 'Make the denominators equal.';
    const r = await run(f);
    expect(outcome(r)).toMatchObject({ result: 'typo_fix', version: 1 });
    const { versions } = await state();
    expect(versions).toHaveLength(1);
    expect(versions[0]!.status).toBe('approved');
    expect(versions[0]!.edited_at).not.toBeNull();
    const [h] = await sql`select text from cms.cms_version_hints where version_id = ${versions[0]!.version_id} and level = 1`;
    expect(h!.text).toBe('Make the denominators equal.');
    const [rev] = await sql`select action, field_diff from cms.cms_reviews where import_id = ${r.importId}`;
    expect(rev).toEqual({ action: 'typo_fix', field_diff: { 'hint.1': { before: 'Make the denominators the same.', after: 'Make the denominators equal.' } } });
  });

  it('--force-new-version turns a typo into a new draft version', async () => {
    const f = baseFile(); q1(f).answer.options![3] = '11/12'; q1(f).answer.wrong_answers![2]!.value = '11/12';
    q1(f).hints[0] = 'Make both denominators equal.';
    const r = await run(f, 'import', true);
    expect(outcome(r)).toMatchObject({ result: 'new_version', version: 2, note: '--force-new-version' });
    const { q, versions } = await state();
    expect(versions.map((v) => [v.version_no, v.status])).toEqual([[1, 'approved'], [2, 'draft']]);
    expect(q).toMatchObject({ current_version: 2, approved_version: 1 });
  });

  it('open draft edited after import → blocked, never overwritten', async () => {
    const { q } = await state();
    await sql`update cms.cms_question_versions set edited_at = now() where question_id = ${q!.question_id} and version_no = 2`;
    const f = baseFile(); q1(f).signature.inhibition = 2;
    const r = await run(f);
    expect(r.result).toBe('failed');
    expect(outcome(r).result).toBe('blocked');
    expect(r.problems.map((p) => p.message)).toContain('v2 is an open draft that was edited after import; it is never overwritten');
    expect((await state()).versions).toHaveLength(2);
  });

  it('in-review version → blocked', async () => {
    const { q } = await state();
    await sql`update cms.cms_question_versions set status = 'in_review', edited_at = null where question_id = ${q!.question_id} and version_no = 2`;
    const f = baseFile(); q1(f).signature.inhibition = 2;
    const r = await run(f);
    expect(r.problems.map((p) => p.message)).toContain('v2 is in review; approve or reject it before re-importing');
  });

  it('approved + a number changed in the wording → new version, not a typo', async () => {
    const { q } = await state();
    await sql`update cms.cms_question_versions set status = 'approved' where question_id = ${q!.question_id} and version_no = 2`;
    await sql`update cms.cms_questions set approved_version = 2 where question_id = ${q!.question_id}`;
    const f = baseFile(); q1(f).answer.options![3] = '11/12'; q1(f).answer.wrong_answers![2]!.value = '11/12';
    q1(f).hints[0] = 'Make both denominators equal.';
    q1(f).solutions.school = q1(f).solutions.school.replace('LCM of 6 and 4 is 12', 'The LCM of 6 and 4 is 12, not 24');
    const r = await run(f);
    expect(outcome(r)).toMatchObject({ result: 'new_version', version: 3 });
    expect(outcome(r).note).toMatch(/a number in the wording changed/);
  });

  it('one bad question in a file → partial: the good one imports, the bad one is skipped', async () => {
    const f = baseFile();
    const good = structuredClone(q1(f)) as Question; good.key = 'MC98-0002'; good.text = '3/4 − 1/8 = ?';
    const bad = structuredClone(q1(f)) as Question; bad.key = 'MC98-0003'; bad.text = '1/2 + 1/3 = ?'; bad.answer.correct = '9/9';
    f.questions = [good, bad];
    const r = await run(f);
    expect(r.result).toBe('partial');
    expect(outcome(r, 'MC98-0002').result).toBe('created');
    expect(outcome(r, 'MC98-0003').result).toBe('blocked');
    expect(r.problems.filter((p) => p.key === 'MC98-0003').map((p) => p.message)).toContain('correct answer "9/9" is not one of the options');
    expect((await sql`select count(*)::int as n from cms.cms_questions where file_key = 'MC98-0003'`)[0]!.n).toBe(0);
  });

  it('file-level error → failed, nothing written but the failed import record', async () => {
    const f = baseFile(); f.subject = 'science';
    q1(f).key = 'MC98-0009';
    const r = await run(f);
    expect(r.result).toBe('failed');
    expect(r.problems.map((p) => p.message)).toContain('chapter MC98 is math, but the file says science');
    expect((await sql`select count(*)::int as n from cms.cms_questions where file_key = 'MC98-0009'`)[0]!.n).toBe(0);
    expect((await sql`select result from cms.cms_imports where import_id = ${r.importId}`)[0]!.result).toBe('failed');
  });

  it('retired question → blocked', async () => {
    await sql`update cms.cms_questions set retired_at = now() where file_key = 'MC98-0002'`;
    const f = baseFile(); const q = structuredClone(q1(f)) as Question; q.key = 'MC98-0002'; q.text = '3/4 − 1/8 = ?'; q.signature.inhibition = 3;
    f.questions = [q];
    const r = await run(f);
    expect(r.problems.map((p) => p.message)).toEqual(expect.arrayContaining([expect.stringMatching(/is retired; restore it before importing changes/)]));
  });

  it('schema error → that question is blocked with a plain-words message', async () => {
    const f = baseFile(); (q1(f).signature as unknown as Record<string, unknown>).reading = 9;
    const r = await run(f, 'validate');
    expect(outcome(r).result).toBe('blocked');
    expect(r.problems).toContainEqual({ level: 'error', key: 'MC98-0001', message: 'signature.reading must be <= 5' });
  });

  // The local originality check (10 Nov 2026): the importer records only its result.
  function withReport(f: ChapterFile, edit: (r: Record<string, unknown>) => void = () => {}) {
    const p = join(dir, `f${++n}.json`);
    const body = JSON.stringify(f, null, 2);
    writeFileSync(p, body);
    const rep: Record<string, unknown> = {
      file_schema: 'cms-originality/1.2', tool: 'check-originality 3', chapter_file_sha256: createHash('sha256').update(body).digest('hex'),
      chapter_id: 'MC98', checked_at: '2026-11-10T06:00:00.000Z', threshold: 0.6, near_copy_threshold: 0.85, checked: [{ source_id: 'NCERT-fegp101', pages: 'pdf 1–12' }], missing: [],
      questions: f.questions.map((q) => ({ key: q.key, result: 'flagged', similarity: 0.72, same_numbers: false, closest_ref: 'NCERT-fegp101 p5' })),
    };
    edit(rep);
    writeFileSync(p.replace(/\.json$/, '.originality.json'), JSON.stringify(rep));
    return p;
  }

  it('records the local originality result (a citation and scores, no book text) for each version it writes', async () => {
    const f = baseFile(); q1(f).text = `${q1(f).text} (originality probe)`;
    const r = await runChapter(sql, withReport(f), 'import');
    expect(outcome(r).result).not.toBe('blocked');
    expect(r.problems).toContainEqual({ level: 'warning', key: 'MC98-0001', message: 'close to a book: NCERT-fegp101 p5 (similarity 0.72); check it is original before approving' });
    const [c] = await sql`select c.result, c.similarity::float as similarity, c.same_numbers, c.closest_ref, c.checked, c.import_id, c.near_copy_threshold::float as near from cms.cms_originality_checks c
      join cms.cms_question_versions v on v.version_id = c.version_id where v.question_id = ${outcome(r).question_id!} and v.version_no = ${outcome(r).version!}`;
    expect(c).toMatchObject({ result: 'flagged', similarity: 0.72, same_numbers: false, closest_ref: 'NCERT-fegp101 p5', near: 0.85, checked: [{ source_id: 'NCERT-fegp101', pages: 'pdf 1–12' }] });
    expect(Number(c!.import_id)).toBe(r.importId);
  });

  it('a near-copy blocks that question (nothing recorded for it); the rest of the file imports', async () => {
    const f = baseFile(); q1(f).text = `${q1(f).text} (near-copy probe)`;
    const r = await runChapter(sql, withReport(f, (rep) => {
      (rep.questions as Record<string, unknown>[])[0] = { key: 'MC98-0001', result: 'near_copy', similarity: 0.93, same_numbers: true, closest_ref: 'N6-01-004' };
    }), 'import');
    expect(outcome(r).result).toBe('blocked');
    expect(r.problems).toContainEqual({ level: 'error', key: 'MC98-0001', message: 'near-copy of a book: N6-01-004 (similarity 0.93, same numbers in the same order); rewrite it with new wording and numbers' });
  });

  it('an old 1.0 report is refused (re-run the check)', async () => {
    const r = await runChapter(sql, withReport(baseFile(), (rep) => { rep.file_schema = 'cms-originality/1.0'; }), 'validate');
    expect(r.result).toBe('failed');
  });

  it('no report → a warning; a report for another version of the file → the import fails', async () => {
    const plain = await run(baseFile(), 'validate');
    expect(plain.problems).toContainEqual({ level: 'warning', key: 'file', message: 'not checked for copying from books: run npm run check:originality -- <this file> on this Mac first' });
    const stale = await runChapter(sql, withReport(baseFile(), (rep) => { rep.chapter_file_sha256 = 'x'; }), 'validate');
    expect(stale.result).toBe('failed');
    expect(stale.problems).toContainEqual({ level: 'error', key: 'file', message: 'the originality report was made for a different version of this file; re-run npm run check:originality' });
  });
});

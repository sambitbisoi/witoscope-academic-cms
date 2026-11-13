// import:science against THIS repo's local database (npm run test:db). Synthetic rows and questions
// (no book text), run inside one transaction that is rolled back, so nothing stays behind
// (except used SQ numbers: sequences never roll back, and IDs are never reused anyway).
import type postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { connect } from '../scripts/lib/db.ts';
import { assertLocal, LOCAL_CMS_OWNER_URL } from '../scripts/local-bootstrap.ts';
import { runScience, type ScienceOptions } from '../scripts/lib/science-import.ts';
import { rowHash, type Master, type MasterQuestion, type MasterRow } from '../scripts/lib/science-master.ts';
import { SCIENCE_REPORT_SCHEMA, type ScienceReport } from '../scripts/lib/science-originality.ts';

assertLocal(LOCAL_CMS_OWNER_URL);
const sql = connect(LOCAL_CMS_OWNER_URL);
afterAll(() => sql.end());
class Done extends Error {}
/** Run fn in a transaction that is always rolled back. */
async function inRollback(fn: (tx: postgres.TransactionSql) => Promise<void>) {
  await sql.begin(async (tx) => { await fn(tx); throw new Done(); }).catch((e) => { if (!(e instanceof Done)) throw e; });
}

const SRC = { source_id: 'DAV-zz-test-book', publisher: 'DAV' as const, kind: 'scanned_pdf' as const, title: 'DAV Class 6 – test book', class: 6, page_offset: -200, file: 'DAV/Source/Class 6/zz.pdf', shorts: ['ZZ'] };
const row = (id: string, cls: number, extra: Partial<MasterRow> = {}): MasterRow => ({
  row_id: id, topic_id: 'ST0325', chapter_id: 'SC48', row_class: cls, type: 'Fact', chapter_role: 'Core', content: `Test content of ${id} in our own words.`,
  why_it_matters: null, misconceptions: 'A test belief.', diagram_description: null, picture_question: false, question_use: 'OK', safety: null, source: 'Book',
  found_in: 'DAV only', confidence: 'high', notes: null, time_sensitive: false, time_checked_year: null, accuracy_flag: false, master_file: 'Class6_ZZ_content',
  book: 'DAV Class 6', book_chapter_no: 4, book_chapter_title: 'Test', appears_in: 'DAV C6 test', sort: 1,
  citations: [{ source_id: SRC.source_id, page_from: 203, page_to: 204, raw: 'ZZ pp.203–204' }], sheet_status: null, sheet: 2, ...extra,
});
const question = (qid: string, links: MasterQuestion['links'], text = `Test question ${qid}?`): MasterQuestion => ({
  qid, topic_id: 'ST0325', row_class: 6, tier: 'L2', sheet_format: 'Scenario MCQ', format: 'MCQ-4', text, options: ['w', 'x', 'y', 'z'], correct: 'y',
  explanation: 'Because y.', misconception_targeted: 'Thinks w.', picture_needed: true, figure_description: 'A test picture.', safety_note: 'Adult only.',
  confidence: 'high', notes: null, links, citations: [{ source_id: SRC.source_id, page_from: 203, page_to: 203, raw: 'DAV ZZ p.203' }], sheet: 2, hash: `hash-${qid}-${text}`,
});
function master(rows: MasterRow[], questions: MasterQuestion[], sha = 'sha-test'): Master {
  return { path: '/tmp/zz.xlsx', sha256: sha, rows, questions, books: [], sources: [SRC], problems: [] };
}
const clear = (key: string) => ({ key, result: 'clear' as const, similarity: 0.2, same_numbers: false, closest_ref: `${SRC.source_id} p3` });
function report(m: Master, near: string[] = []): ScienceReport {
  return {
    file_schema: SCIENCE_REPORT_SCHEMA, tool: 'test', master_sha256: m.sha256, checked_at: new Date().toISOString(), threshold: 0.6, near_copy_threshold: 0.85, read: [], missing: [],
    rows: m.rows.map((r) => (near.includes(r.row_id) ? { key: r.row_id, result: 'near_copy' as const, similarity: 0.91, same_numbers: false, closest_ref: `${SRC.source_id} p3`, field: 'content',
      fields: [{ field: 'content', result: 'near_copy' as const, similarity: 0.91, same_numbers: false, closest_ref: `${SRC.source_id} p3` }] } : clear(r.row_id))),
    questions: m.questions.map((q) => clear(q.qid)),
  };
}
const R1 = row('C6-ZZ-001', 6), R2 = row('C6-ZZ-002', 6, { type: 'Concept', question_use: 'Misconception only' }), R3 = row('C1-ZZ-003', 1), R4 = row('C6-ZZ-004', 6);
const Q1 = question('ZZ-Q001', [{ row_id: 'C6-ZZ-001', role: 'direct' }, { row_id: 'C6-ZZ-002', role: 'supporting' }]);
const Q2 = question('ZZ-Q002', [{ row_id: 'C6-ZZ-004', role: 'direct' }]);
const run = (tx: postgres.TransactionSql, m: Master, o: Partial<ScienceOptions> & { near?: string[] } = {}) =>
  runScience(sql, m, report(m, o.near), { dryRun: false, target: 'local', ...o, inTx: tx });

describe('import:science (local, rolled back)', () => {
  it('imports rows, citations, proposed links and questions; a re-run changes nothing; edits are audited; nothing is deleted', async () => {
    await inRollback(async (tx) => {
      const [before] = await tx`select count(*)::int as n from cms.cms_content_rows`;
      const m1 = master([R1, R2, R3, R4], [Q1, Q2]);
      const a = await run(tx, m1, { near: ['C6-ZZ-004'] });
      expect(a.rows.inserted).toBe(4);
      expect(a.rows.near_copy_badged).toEqual(['C6-ZZ-004']);         // local: imported with the badge
      expect(a.questions.created).toHaveLength(2);
      expect(a.links).toEqual({ direct: 2, supporting: 1 });
      expect(a.citations).toEqual({ rows: 4, questions: 2 });
      // real rows already in the CMS that this synthetic master lacks are flagged, never deleted
      const [after] = await tx`select count(*)::int as n, count(*) filter (where in_master)::int as live from cms.cms_content_rows`;
      expect(after!.n).toBe(before!.n + 4);
      expect(after!.live).toBe(4);
      expect(a.rows.flagged_missing).toBe(before!.n);

      // the class-1 row proposes a topic–class link; nothing becomes active
      const p = a.proposals.find((x) => x.topic_id === 'ST0325' && x.row_class === 1)!;
      expect(p).toMatchObject({ home_class: 6, role: 'higher' });
      const [link] = await tx`select count(*)::int as n from cms.cms_topic_classes where topic_id = 'ST0325' and class = 1`;
      expect(link!.n).toBe(0);
      const [prop] = await tx`select status, source from cms.cms_topic_class_proposals where topic_id = 'ST0325' and class = 1`;
      expect(prop).toEqual({ status: 'proposed', source: 'Science master' });

      // the question: Needs review, attributes pending, image pending, tier stored apart from the class Level
      const [v] = await tx`select q.subject, q.level, q.class, q.source_qid, v.status, v.created_from, v.attributes_pending, v.originality_pending, v.image_status, v.level_tier,
          v.display_format, v.misconception_targeted, v.safety_note, v.format, v.correct, v.version_id,
          (select count(*)::int from cms.cms_originality_checks c where c.version_id = v.version_id) as checks
        from cms.cms_questions q join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version where q.source_qid = 'ZZ-Q001'`;
      expect(v).toMatchObject({ subject: 'science', level: 6, class: 6, status: 'in_review', created_from: 'import', attributes_pending: true, originality_pending: false,
        image_status: 'needs_image', level_tier: 'L2', display_format: 'Scenario MCQ', misconception_targeted: 'Thinks w.', safety_note: 'Adult only.', format: 'MCQ-4', correct: 'y', checks: 1 });
      const links = await tx`select row_id, role from cms.cms_question_content_rows where version_id = ${v!.version_id} order by row_id`;
      expect(links.map((l) => `${l.row_id}:${l.role}`)).toEqual(['C6-ZZ-001:direct', 'C6-ZZ-002:supporting']);
      const st = await tx`select row_id, status, n_direct, n_supporting from cms.cms_content_row_status where row_id in ('C6-ZZ-001', 'C6-ZZ-002', 'C1-ZZ-003') order by row_id`;
      expect(st.map((s) => `${s.row_id}:${s.status}:${s.n_direct}:${s.n_supporting}`)).toEqual(['C1-ZZ-003:none:0:0', 'C6-ZZ-001:direct:1:0', 'C6-ZZ-002:supporting:0:1']);

      // a re-run of the same master changes nothing
      const b = await run(tx, m1, { near: ['C6-ZZ-004'] });
      expect(b.rows).toMatchObject({ inserted: 0, updated: 0, unchanged: 4 });
      expect(b.questions).toMatchObject({ created: [], replaced: [], unchanged: 2 });
      expect(b.proposals.every((x) => !x.isNew)).toBe(true);

      // a changed row is updated with an audit diff; a dropped row is flagged; a changed unedited draft is replaced;
      // an edited one is skipped (the CMS keeps it)
      await tx`update cms.cms_question_versions set edited_at = now() where question_id = (select question_id from cms.cms_questions where source_qid = 'ZZ-Q002')`;
      const m2 = master([R1, { ...R2, content: 'Changed wording.' }, R4], [question('ZZ-Q001', Q1.links, 'Changed question?'), question('ZZ-Q002', Q2.links, 'Also changed?')], 'sha-2');
      const c = await run(tx, m2, { near: ['C6-ZZ-004'] });
      expect(c.rows).toMatchObject({ updated: 1, flagged_missing: 1 });
      expect(c.questions.replaced).toHaveLength(1);
      expect(c.questions.skipped.map((s) => s.qid)).toEqual(['ZZ-Q002']);
      const [audit] = await tx`select action, field_diff from cms.cms_reviews where target_table = 'cms_content_rows' and target_id = 'C6-ZZ-002' and action = 'science_row'`;
      expect(audit!.field_diff.content).toEqual({ before: R2.content, after: 'Changed wording.' });
      const [gone] = await tx`select in_master, missing_since is not null as since from cms.cms_content_rows where row_id = 'C1-ZZ-003'`;
      expect(gone).toEqual({ in_master: false, since: true });
      const [replaced] = await tx`select v.text from cms.cms_questions q join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version where q.source_qid = 'ZZ-Q001'`;
      expect(replaced!.text).toBe('Changed question?');
    });
  });

  it('real project: a near-copy row is held out (and its questions blocked) unless override_requests.csv lists row + field', async () => {
    await inRollback(async (tx) => {
      const m = master([R1, R2, R4], [Q1, Q2]);
      const a = await run(tx, m, { target: 'real', near: ['C6-ZZ-004'] });
      expect(a.rows.held_out).toEqual(['C6-ZZ-004']);
      expect(a.questions.blocked.map((b) => b.qid)).toEqual(['ZZ-Q002']);
      const [x] = await tx`select count(*)::int as n from cms.cms_content_rows where row_id = 'C6-ZZ-004'`;
      expect(x!.n).toBe(0);
    });
    await inRollback(async (tx) => {
      const m = master([R1, R2, R4], [Q1, Q2]);
      const a = await run(tx, m, { target: 'real', near: ['C6-ZZ-004'], overrides: new Map([['C6-ZZ-004|content', 'a standard definition that cannot be reworded']]) });
      expect(a.rows.held_out).toEqual([]);
      expect(a.rows.overridden).toEqual(['C6-ZZ-004']);
      const [r] = await tx`select originality_result, originality_override from cms.cms_content_rows where row_id = 'C6-ZZ-004'`;
      expect(r).toEqual({ originality_result: 'near_copy', originality_override: 'a standard definition that cannot be reworded' });
    });
  });

  it('refuses a stale originality report', async () => {
    const m = master([R1], []);
    await expect(runScience(sql, m, { ...report(m), master_sha256: 'other' }, { dryRun: true, target: 'local' })).rejects.toThrow(/another version of the master/);
    await expect(runScience(sql, m, null, { dryRun: true, target: 'local' })).rejects.toThrow(/no originality report/);
  });

  it('the local Science import is in place: 2,407 rows, 134 questions, 12 proposed links, row hashes current', async () => {
    const [x] = await sql`select (select count(*)::int from cms.cms_content_rows where in_master) as rows,
      (select count(*)::int from cms.cms_questions where subject = 'science' and source_qid like 'C6-04-Q%') as qs,
      (select count(*)::int from cms.cms_topic_class_proposals where source = 'Science master') as props,
      (select count(*)::int from cms.cms_topic_class_proposals p join cms.cms_topic_classes c using (topic_id, class)) as active_props`;
    expect(x).toEqual({ rows: 2407, qs: 134, props: 12, active_props: 0 });
    expect(rowHash(R1)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// Q13 Course builder (0045, 18 Nov 2026). Local DB; every test runs in ONE transaction that is rolled back.
// Uses the local curriculum (real-like) for CMS topic and chapter IDs, picked by query.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertLocal, LOCAL_SUPERUSER_URL } from '../scripts/local-bootstrap.ts';

assertLocal(LOCAL_SUPERUSER_URL);
const su = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
let adminId = '';
let M: string[] = [];          // active normal Math topics
let S = '';                    // an active normal Science topic
let ACH = '';                  // an Achievers topic
let CH5: string[] = [];        // Math chapters with an active ACH-<ch>-5
let CH_NO6 = '';               // a Math chapter with ACH-<ch>-5 but no ACH-<ch>-6 (or the reverse is fine): used for the class-change check
let SCH = '';                  // a Science chapter
beforeAll(async () => {
  adminId = (await su`select value #>> '{}' as id from cms.cms_config where key = 'admin_user_id'`)[0]!.id;
  M = (await su`select t.topic_id from cms.cms_topics t join cms.cms_chapters c using (chapter_id)
                where c.subject = 'math' and t.topic_kind = 'normal' and t.status = 'active' order by t.topic_id limit 8`).map((r) => r.topic_id);
  S = (await su`select t.topic_id from cms.cms_topics t join cms.cms_chapters c using (chapter_id)
                where c.subject = 'science' and t.topic_kind = 'normal' and t.status = 'active' order by t.topic_id limit 1`)[0]!.topic_id;
  ACH = (await su`select topic_id from cms.cms_topics where topic_kind = 'achievers' order by topic_id limit 1`)[0]!.topic_id;
  CH5 = (await su`select chapter_id from cms.cms_topics where topic_kind = 'achievers' and class = 5 and status = 'active' order by chapter_id limit 3`).map((r) => r.chapter_id);
  CH_NO6 = (await su`select a.chapter_id from cms.cms_topics a where a.topic_kind = 'achievers' and a.class = 5
                     and not exists (select 1 from cms.cms_topics b where b.topic_id = 'ACH-' || a.chapter_id || '-1') order by 1 limit 1`)[0]?.chapter_id ?? '';
  SCH = (await su`select chapter_id from cms.cms_chapters where subject = 'science' order by 1 limit 1`)[0]!.chapter_id;
});
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

type Outline = { chapters: { id?: string; name: string; achievers?: string[]; topics: { id?: string; name: string; cms: string[] }[] }[] };
type Res = { course_id: string; rev: number; topic_links_changed: number; achievers_changed: number; chapters: { new: number; retired: number }; topics: { new: number; retired: number } };
const save = async (tx: Tx, p: Record<string, unknown>) => ((await tx`select cms.cms_save_course(${tx.json(p as never)}) as r`)[0]!.r as Res);
const create = (tx: Tx, outline?: Outline, course: Record<string, unknown> = {}) =>
  save(tx, { course: { name: `Test course ${Math.random().toString(36).slice(2, 8)}`, board_id: 'BRD01', class: 5, subject: 'math', ...course }, outline });
// the course's outline as the screen would load it (with IDs)
async function load(tx: Tx, cid: string): Promise<Outline> {
  const chs = await tx`select course_chapter_id, name from cms.cms_course_chapters where course_id = ${cid} and status = 'active' order by position`;
  const out: Outline = { chapters: [] };
  for (const c of chs) {
    const tps = await tx`select course_topic_id, name from cms.cms_course_topics where course_chapter_id = ${c.course_chapter_id} and status = 'active' order by position`;
    const topics = [];
    for (const t of tps) topics.push({ id: t.course_topic_id, name: t.name, cms: (await tx`select topic_id from cms.cms_course_topic_items where course_topic_id = ${t.course_topic_id} and removed_at is null order by position`).map((r) => r.topic_id) });
    const achievers = (await tx`select chapter_id from cms.cms_course_achievers where course_chapter_id = ${c.course_chapter_id} and removed_at is null order by position`).map((r) => r.chapter_id);
    out.chapters.push({ id: c.course_chapter_id, name: c.name, achievers, topics });
  }
  return out;
}
const rev = async (tx: Tx, cid: string) => Number((await tx`select rev from cms.cms_courses where course_id = ${cid}`)[0]!.rev);
const strip = (o: Outline) => o.chapters.map((c) => ({ name: c.name, achievers: c.achievers ?? [], topics: c.topics.map((t) => ({ name: t.name, cms: t.cms })) }));

describe('Course builder (0045)', () => {
  it('creates a course with its outline; IDs, positions and one audit row per change', async () => {
    await rolledBack(async (tx, h) => {
      await h.as();
      const r = await create(tx, { chapters: [
        { name: 'Big numbers', achievers: [CH5[0]!], topics: [{ name: 'Reading big numbers', cms: [M[0]!, M[1]!] }, { name: 'Comparing', cms: [M[2]!] }] },
        { name: 'Shapes', topics: [{ name: 'Angles', cms: [M[3]!] }] }] });
      expect(r.course_id).toMatch(/^CRS\d{3}$/);
      expect(r.rev).toBe(2);
      expect(r.chapters.new).toBe(2); expect(r.topics.new).toBe(3); expect(r.topic_links_changed).toBe(3); expect(r.achievers_changed).toBe(1);
      const o = await load(tx, r.course_id);
      expect(o.chapters.map((c) => c.id)).toEqual(expect.arrayContaining([expect.stringMatching(/^DCH\d{4}$/)]));
      expect(strip(o)).toEqual([
        { name: 'Big numbers', achievers: [CH5[0]], topics: [{ name: 'Reading big numbers', cms: [M[0], M[1]] }, { name: 'Comparing', cms: [M[2]] }] },
        { name: 'Shapes', achievers: [], topics: [{ name: 'Angles', cms: [M[3]] }] }]);
      await h.owner();
      const audit = await tx`select target_table, action, field_diff from cms.cms_reviews where target = 'course' and (target_id = ${r.course_id}
        or target_id in (select course_chapter_id from cms.cms_course_chapters where course_id = ${r.course_id})
        or target_id in (select course_topic_id from cms.cms_course_topics where course_id = ${r.course_id})) order by review_id`;
      expect(audit.map((a) => `${a.target_table} ${a.action}`)).toEqual([
        'cms_courses create', 'cms_course_chapters create', 'cms_course_chapters create',
        'cms_course_topics create', 'cms_course_topics create', 'cms_course_topics create',
        'cms_course_topic_items course_save', 'cms_course_topic_items course_save', 'cms_course_topic_items course_save',
        'cms_course_achievers course_save', 'cms_courses course_save']);
      expect(audit.find((a) => a.target_table === 'cms_course_achievers')!.field_diff).toEqual({ achievers: { before: [], after: [CH5[0]] } });
      await tx.unsafe('set constraints all immediate');   // the deferred position rules hold
    });
  });

  it('a CMS topic is in at most one display topic per course; other courses may use it; free again once removed', async () => {
    await rolledBack(async (tx, h) => {
      await h.as();
      await fails(tx, (sp) => create(sp, { chapters: [{ name: 'A', topics: [{ name: 'x', cms: [M[0]!] }, { name: 'y', cms: [M[0]!] }] }] }), /used twice in this course \(1\.1 and 1\.2\)/);
      const a = await create(tx, { chapters: [{ name: 'A', topics: [{ name: 'x', cms: [M[0]!] }, { name: 'y', cms: [M[1]!] }] }] });
      await create(tx, { chapters: [{ name: 'B', topics: [{ name: 'x', cms: [M[0]!] }] }] });   // another course: fine
      // move M0 from x to y in one save (remove + add): allowed, and the link row is kept (moved), not duplicated
      const o = await load(tx, a.course_id);
      o.chapters[0]!.topics[0]!.cms = [M[2]!]; o.chapters[0]!.topics[1]!.cms = [M[1]!, M[0]!];
      await save(tx, { course_id: a.course_id, rev: await rev(tx, a.course_id), outline: o });
      expect(strip(await load(tx, a.course_id))[0]!.topics.map((t) => t.cms)).toEqual([[M[2]], [M[1], M[0]]]);
      await h.owner();
      const rows = await tx`select topic_id, removed_at is null as active from cms.cms_course_topic_items where course_id = ${a.course_id} order by item_id`;
      expect(rows.filter((x) => x.topic_id === M[0]).length).toBe(1);
      // the DB index itself refuses a second active link
      const [t] = await tx`select course_topic_id from cms.cms_course_topics where course_id = ${a.course_id} order by position limit 1`;
      await fails(tx, (sp) => sp`insert into cms.cms_course_topic_items (course_id, course_topic_id, position, topic_id) values (${a.course_id}, ${t!.course_topic_id}, 3, ${M[0]!})`, /cms_course_topic_items_once/);
    });
  });

  it('at most 4 CMS topics per display topic (function and DB); Achievers topics, other subjects and retired topics are refused', async () => {
    await rolledBack(async (tx, h) => {
      await h.as();
      await fails(tx, (sp) => create(sp, { chapters: [{ name: 'A', topics: [{ name: 'x', cms: M.slice(0, 5) }] }] }), /at most 4 CMS topics/);
      await fails(tx, (sp) => create(sp, { chapters: [{ name: 'A', topics: [{ name: 'x', cms: [ACH] }] }] }), /Achievers topic/);
      await fails(tx, (sp) => create(sp, { chapters: [{ name: 'A', topics: [{ name: 'x', cms: [S] }] }] }), /not a math topic/);
      await fails(tx, (sp) => create(sp, { chapters: [{ name: 'A', topics: [{ name: 'x', cms: ['MT9999'] }] }] }), /does not exist/);
      await fails(tx, (sp) => create(sp, { chapters: [{ name: '', topics: [] }] }), /needs a name/);
      const a = await create(tx, { chapters: [{ name: 'A', topics: [{ name: 'x', cms: M.slice(0, 4) }] }] });
      await h.owner();
      const [t] = await tx`select course_topic_id from cms.cms_course_topics where course_id = ${a.course_id}`;
      await fails(tx, (sp) => sp`insert into cms.cms_course_topic_items (course_id, course_topic_id, position, topic_id) values (${a.course_id}, ${t!.course_topic_id}, 5, ${M[5]!})`, /check/);
      await tx`update cms.cms_topics set status = 'retired' where topic_id = ${M[6]!}`;
      await h.as();
      await fails(tx, (sp) => create(sp, { chapters: [{ name: 'A', topics: [{ name: 'x', cms: [M[6]!] }] }] }), /retired; it can't be placed/);
    });
  });

  it('Achievers: once per course, Math only, resolved from the course class; a missing ACH topic blocks Publish', async () => {
    await rolledBack(async (tx, h) => {
      await h.as();
      await fails(tx, (sp) => create(sp, { chapters: [{ name: 'A', achievers: [CH5[0]!], topics: [] }, { name: 'B', achievers: [CH5[0]!], topics: [] }] }), /used twice in this course \(chapters 1 and 2\)/);
      await fails(tx, (sp) => create(sp, { chapters: [{ name: 'A', achievers: [SCH], topics: [] }] }), /not a math chapter/);
      await fails(tx, (sp) => create(sp, { chapters: [{ name: 'A', achievers: [SCH], topics: [{ name: 'x', cms: [S] }] }] }, { subject: 'science' }), /Science has no Achievers/);
      const a = await create(tx, { chapters: [{ name: 'A', achievers: [CH5[0]!, CH5[1]!], topics: [{ name: 'x', cms: [M[0]!] }] }] });
      expect((await tx`select kind from cms.cms_course_errors(${a.course_id})`).length).toBe(0);
      await tx`select cms.cms_set_course_status(${tx.json({ course_id: a.course_id, rev: await rev(tx, a.course_id), status: 'published' } as never)})`;
      expect((await tx`select status from cms.cms_courses where course_id = ${a.course_id}`)[0]!.status).toBe('published');
      if (CH_NO6) {
        const b = await create(tx, { chapters: [{ name: 'A', achievers: [CH_NO6], topics: [{ name: 'x', cms: [M[1]!] }] }] });
        await save(tx, { course_id: b.course_id, rev: await rev(tx, b.course_id), course: { class: 1 } });
        const errs = await tx`select kind, ref from cms.cms_course_errors(${b.course_id})`;
        expect(errs.map((e) => `${e.kind} ${e.ref}`)).toEqual([`achievers_missing ACH-${CH_NO6}-1`]);
        await fails(tx, async (sp) => sp`select cms.cms_set_course_status(${sp.json({ course_id: b.course_id, rev: await rev(sp, b.course_id), status: 'published' } as never)})`, /Can't publish: achievers missing/);
      }
    });
  });

  it('Publish needs no ✗; published is read-only until Back to draft; a stale rev is refused; all audited', async () => {
    await rolledBack(async (tx, h) => {
      await h.as();
      const a = await create(tx, { chapters: [{ name: 'A', topics: [] }] });
      await fails(tx, async (sp) => sp`select cms.cms_set_course_status(${sp.json({ course_id: a.course_id, rev: a.rev, status: 'published' } as never)})`, /chapter empty/);
      const o = await load(tx, a.course_id);
      o.chapters[0]!.topics.push({ name: 'x', cms: [] });
      await save(tx, { course_id: a.course_id, rev: a.rev, outline: o });
      await fails(tx, (sp) => save(sp, { course_id: a.course_id, rev: a.rev, course: { name: 'stale' } }), /changed since you opened it/);
      await fails(tx, async (sp) => sp`select cms.cms_set_course_status(${sp.json({ course_id: a.course_id, rev: await rev(sp, a.course_id), status: 'published' } as never)})`, /topic empty/);
      const o2 = await load(tx, a.course_id);
      o2.chapters[0]!.topics[0]!.cms = [M[0]!];
      await save(tx, { course_id: a.course_id, rev: await rev(tx, a.course_id), outline: o2 });
      await tx`select cms.cms_set_course_status(${tx.json({ course_id: a.course_id, rev: await rev(tx, a.course_id), status: 'published' } as never)})`;
      await fails(tx, async (sp) => save(sp, { course_id: a.course_id, rev: await rev(sp, a.course_id), course: { name: 'Renamed' } }), /is published; use "Back to draft"/);
      await tx`select cms.cms_set_course_status(${tx.json({ course_id: a.course_id, rev: await rev(tx, a.course_id), status: 'draft' } as never)})`;
      await save(tx, { course_id: a.course_id, rev: await rev(tx, a.course_id), course: { name: 'Renamed' } });
      await fails(tx, async (sp) => save(sp, { course_id: a.course_id, rev: await rev(sp, a.course_id), course: { subject: 'science' } }), /subject of a course can't change/);
      await h.owner();
      const st = await tx`select reason, field_diff from cms.cms_reviews where target_id = ${a.course_id} and action = 'course_status' order by review_id`;
      expect(st.map((s) => `${s.reason}: ${s.field_diff.status.before}→${s.field_diff.status.after}`)).toEqual(['Publish: draft→published', 'Back to draft: published→draft']);
      const [nm] = await tx`select field_diff from cms.cms_reviews where target_id = ${a.course_id} and action = 'course_save' and field_diff ? 'name'`;
      expect(nm!.field_diff).toEqual({ name: { before: `${(await tx`select field_diff from cms.cms_reviews where target_id = ${a.course_id} and action = 'create'`)[0]!.field_diff.course.after.name}`, after: 'Renamed' } });
    });
  });

  it('leaving rows out retires them (kept, with IDs) and frees their CMS topics; reorder swaps positions', async () => {
    await rolledBack(async (tx, h) => {
      await h.as();
      const a = await create(tx, { chapters: [
        { name: 'A', achievers: [CH5[0]!], topics: [{ name: 'x', cms: [M[0]!] }, { name: 'y', cms: [M[1]!] }] },
        { name: 'B', achievers: [CH5[1]!], topics: [{ name: 'z', cms: [M[2]!] }] }] });
      const o = await load(tx, a.course_id);
      const [A, B] = o.chapters;
      // swap the chapters, drop topic y (and with it M1), drop chapter B entirely
      const r = await save(tx, { course_id: a.course_id, rev: a.rev, outline: { chapters: [{ ...A!, topics: [A!.topics[0]!] }] } });
      expect(r.chapters.retired).toBe(1); expect(r.topics.retired).toBe(2);
      await h.owner();
      const ret = await tx`select course_chapter_id, status, position from cms.cms_course_chapters where course_id = ${a.course_id} order by course_chapter_id`;
      expect(ret.map((x) => `${x.status} ${x.position}`)).toEqual(['active 1', 'retired null']);
      expect((await tx`select count(*)::int as n from cms.cms_course_topic_items where course_id = ${a.course_id}`)[0]!.n).toBe(3);   // rows kept
      await h.as();
      // M1 and M2, and B's Achievers chapter, are free again
      const o2 = await load(tx, a.course_id);
      o2.chapters.push({ name: 'C', achievers: [CH5[1]!], topics: [{ name: 'w', cms: [M[1]!, M[2]!] }] });
      o2.chapters.reverse();
      await save(tx, { course_id: a.course_id, rev: await rev(tx, a.course_id), outline: o2 });
      expect(strip(await load(tx, a.course_id)).map((c) => c.name)).toEqual(['C', 'A']);
      // reorder two topics in place (deferred unique position)
      const o3 = await load(tx, a.course_id);
      o3.chapters[0]!.topics.push({ name: 'v', cms: [M[3]!] });
      await save(tx, { course_id: a.course_id, rev: await rev(tx, a.course_id), outline: o3 });
      const o4 = await load(tx, a.course_id);
      o4.chapters[0]!.topics.reverse(); o4.chapters[0]!.topics[1]!.cms.reverse();
      await save(tx, { course_id: a.course_id, rev: await rev(tx, a.course_id), outline: o4 });
      expect(strip(await load(tx, a.course_id))[0]!.topics).toEqual([{ name: 'v', cms: [M[3]] }, { name: 'w', cms: [M[2], M[1]] }]);
      await tx.unsafe('set constraints all immediate');
      expect(B).toBeTruthy();
    });
  });

  it('Start from copies everything into a new draft; the source is unchanged', async () => {
    await rolledBack(async (tx, h) => {
      await h.as();
      const src = await create(tx, { chapters: [{ name: 'A', achievers: [CH5[0]!], topics: [{ name: 'x', cms: [M[0]!, M[1]!] }] }, { name: 'B', topics: [{ name: 'y', cms: [M[2]!] }] }] });
      const before = strip(await load(tx, src.course_id));
      const [c] = await tx`select cms.cms_copy_course(${tx.json({ from_course: src.course_id, course: { name: 'Copy of it', board_id: 'BRD02', class: 4, subject: 'science' } } as never)}) as r`;
      const cp = (c!.r as Res).course_id;
      expect(strip(await load(tx, cp))).toEqual(before);
      expect(strip(await load(tx, src.course_id))).toEqual(before);
      const [row] = await tx`select subject, class, board_id, started_from, status from cms.cms_courses where course_id = ${cp}`;
      expect(row).toEqual({ subject: 'math', class: 4, board_id: 'BRD02', started_from: src.course_id, status: 'draft' });
      await h.owner();
      expect((await tx`select action from cms.cms_reviews where target_id = ${cp} and target_table = 'cms_courses' order by review_id`).map((x) => x.action)).toEqual(['create', 'course_copy']);
    });
  });

  it('boards: an editable, audited list; a retired board can\'t be picked; names are unique among live courses', async () => {
    await rolledBack(async (tx, h) => {
      await h.as();
      const [b] = await tx`select cms.cms_save_course_board(${tx.json({ action: 'create', fields: { label: 'Test board', book: 'DAV' } } as never)}) as r`;
      const id = (b!.r as { board_id: string }).board_id;
      expect(id).toMatch(/^BRD\d{2}$/);
      await tx`select cms.cms_save_course_board(${tx.json({ action: 'update', id, fields: { label: 'Test board 2', book: '' } } as never)})`;
      await tx`select cms.cms_save_course_board(${tx.json({ action: 'retire', id } as never)})`;
      await fails(tx, (sp) => create(sp, undefined, { board_id: id }), /not an active board/);
      await create(tx, undefined, { name: 'Same name' });
      await fails(tx, (sp) => create(sp, undefined, { name: 'same NAME' }), /already exists/);
      await h.owner();
      const au = await tx`select action, field_diff from cms.cms_reviews where target_table = 'cms_course_boards' and target_id = ${id} order by review_id`;
      expect(au.map((a) => a.action)).toEqual(['create', 'course_save', 'retire']);
      expect(au[1]!.field_diff.board.after).toMatchObject({ label: 'Test board 2', book: null });
      const seed = await tx`select board_id, label, book from cms.cms_course_boards where board_id in ('BRD01','BRD02','BRD03','BRD04') order by 1`;
      expect(seed.map((s) => `${s.label}/${s.book ?? '-'}`)).toEqual(['CBSE·NCERT/NCERT', 'CBSE·DAV/DAV', 'ICSE/-', 'IMO/-']);
    });
  });

  it('question counts: production only, by Level; a course sums Level ≤ its class', async () => {
    await rolledBack(async (tx, h) => {
      await h.as();
      const [t] = await tx`select topic_id from cms.cms_question_list where counted group by topic_id having count(distinct effective_level) > 1 limit 1`;
      if (!t) return;
      const rows = await tx`select level, n_questions from cms.cms_topic_level_counts where topic_id = ${t.topic_id} order by level`;
      const [d] = await tx`select count(*) filter (where counted)::int as all_n, count(*) filter (where counted and effective_level <= ${rows[0]!.level})::int as low,
                                  count(*) filter (where bank = 'gold')::int as gold from cms.cms_question_list where topic_id = ${t.topic_id}`;
      expect(rows.reduce((s, r) => s + r.n_questions, 0)).toBe(d!.all_n);
      expect(rows[0]!.n_questions).toBe(d!.low);
      const gold = await tx`select l.topic_id from cms.cms_question_list l where l.bank = 'gold' limit 1`;
      if (gold.length) {
        const [g] = await tx`select coalesce(sum(n_questions), 0)::int as n from cms.cms_topic_level_counts where topic_id = ${gold[0]!.topic_id}`;
        const [p] = await tx`select count(*)::int as n from cms.cms_question_list where topic_id = ${gold[0]!.topic_id} and bank = 'production' and counted`;
        expect(g!.n).toBe(p!.n);
      }
    });
  });

  it('RLS: another user sees no rows and can\'t save; nobody writes the book chapter reference from the browser', async () => {
    await rolledBack(async (tx, h) => {
      await h.as();
      await create(tx, { chapters: [{ name: 'A', topics: [] }] });
      await h.as('00000000-0000-0000-0000-000000000001');
      expect((await tx`select count(*)::int as n from cms.cms_courses`)[0]!.n).toBe(0);
      expect((await tx`select count(*)::int as n from cms.cms_course_boards`)[0]!.n).toBe(0);
      await fails(tx, (sp) => create(sp), /Only the CMS admin/);
      await fails(tx, (sp) => sp`select cms.cms_save_course_board(${sp.json({ action: 'create', fields: { label: 'x' } } as never)})`, /Only the CMS admin/);
      await h.as();
      await fails(tx, (sp) => sp`insert into cms.cms_ref_book_chapters (book, book_title, class, subject, ch_no, ch_name) values ('NCERT', 'x', 5, 'math', 1, 'x')`, /permission denied/);
      await fails(tx, (sp) => sp`insert into cms.cms_courses (course_id, name, board_id, class, subject) values ('CRS999', 'x', 'BRD01', 5, 'math')`, /permission denied/);
    });
  });

  it('upload: a new course and a replace of a draft, each recorded in cms_imports (file name and hash only) and audited as course_upload; clone audited as course_clone', async () => {
    await rolledBack(async (tx, h) => {
      await h.as();
      const a = await save(tx, { source: 'upload', file: { name: 'pilot.xlsx', sha256: 'abc' }, course: { name: 'Uploaded', board_id: 'BRD01', class: 5, subject: 'math' },
        outline: { chapters: [{ name: 'A', achievers: [], topics: [{ name: 'x', cms: [M[0]!] }] }] } }) as Res & { import_id: number };
      const o = await load(tx, a.course_id);
      o.chapters[0]!.name = 'A renamed'; o.chapters[0]!.topics.push({ name: 'y', cms: [M[1]!] });
      const b = await save(tx, { course_id: a.course_id, rev: a.rev, source: 'upload', file: { name: 'pilot v2.xlsx', sha256: 'def' }, outline: o }) as Res & { import_id: number };
      expect(strip(await load(tx, a.course_id))).toEqual([{ name: 'A renamed', achievers: [], topics: [{ name: 'x', cms: [M[0]] }, { name: 'y', cms: [M[1]] }] }]);
      const o2 = await load(tx, a.course_id);
      await save(tx, { course_id: a.course_id, rev: await rev(tx, a.course_id), source: 'clone', reason: 'cloned from CRS999 › DCH9999', outline: { chapters: [...o2.chapters, { name: 'C', achievers: [], topics: [{ name: 'z', cms: [M[2]!] }] }] } });
      await h.owner();
      const imps = await tx`select kind, file_path, file_hash, options, counts from cms.cms_imports where import_id in (${a.import_id}, ${b.import_id}) order by import_id`;
      expect(imps.map((i) => `${i.kind} ${i.file_path} ${i.file_hash} ${i.options.new_course}`)).toEqual(['course_upload pilot.xlsx abc true', 'course_upload pilot v2.xlsx def false']);
      expect(imps[1]!.counts).toMatchObject({ chapters_changed: 1, topics_new: 1, topic_links_changed: 1 });
      const acts = await tx`select action, reason, import_id from cms.cms_reviews where target_id = ${a.course_id} and target_table = 'cms_courses' order by review_id`;
      expect(acts.map((x) => x.action)).toEqual(['create', 'course_upload', 'course_upload', 'course_clone']);
      expect(acts[3]!.reason).toBe('cloned from CRS999 › DCH9999');
      expect(Number(acts[2]!.import_id)).toBe(Number(b.import_id));
    });
  });
});

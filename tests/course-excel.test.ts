// Course builder screen 5 (Q13): Excel parser — every ✗ and ! of the plan, replace keeps IDs by position, template round trip.
import { describe, expect, it } from 'vitest';
import { outlineDiff, parseUpload, readCourseSheet, templateSheets, type Cell, type Sheets, type UploadContext } from '../shared/course-excel.ts';
import type { Outline, TopicInfo } from '../shared/course.ts';

const T = (topic_id: string, o: Partial<TopicInfo> = {}): TopicInfo =>
  ({ topic_id, name: `Topic ${topic_id}`, chapter_id: 'MC01', home_class: 5, status: 'active', kind: 'normal', classes: [5], counts: { 5: { n: 3, approved: 0 } }, ...o });
const topics = new Map<string, TopicInfo>(['MT0001', 'MT0002', 'MT0003', 'MT0004', 'MT0005', 'MT0006'].map((id) => [id, T(id)]));
topics.set('MT0009', T('MT0009', { status: 'retired' }));
topics.set('ACH-MC01-5', T('ACH-MC01-5', { kind: 'achievers' }));
const boards = [{ board_id: 'BRD01', label: 'CBSE·NCERT', status: 'active' }, { board_id: 'BRD09', label: 'Old', status: 'retired' }];
const ctx = (o: Partial<UploadContext> = {}): UploadContext => ({ boards, topics, chapters: [{ chapter_id: 'MC01', name: 'One' }, { chapter_id: 'MC02', name: 'Two' }], courseNames: new Map([['taken', 'CRS009']]), replace: null, ...o });
const rows = (cols: string[], data: Cell[][]) => data.map((d, i) => ({ row: i + 2, values: Object.fromEntries(cols.map((c, k) => [c, d[k] ?? null])) }));
function book(o: { course?: Cell[]; chapters?: Cell[][]; topics?: Cell[][]; items?: Cell[][]; achievers?: Cell[][] } = {}): Sheets {
  return new Map([
    ['1 Course', rows(['course_name', 'board', 'class', 'subject'], [o.course ?? ['Pilot', 'CBSE-NCERT', 5, 'Math']])],
    ['2 Display chapters', rows(['chapter_no', 'chapter_name'], o.chapters ?? [[1, 'A'], [2, 'B']])],
    ['3 Display topics', rows(['chapter_no', 'topic_no', 'display_topic_name'], o.topics ?? [[1, 1, 'a1'], [1, 2, 'a2'], [2, 1, 'b1']])],
    ['4 Display topic → CMS topics', rows(['chapter_no', 'topic_no', 'order', 'cms_topic_id', 'cms_topic_name'], o.items ?? [[1, 1, 1, 'MT0001', 'Topic MT0001'], [1, 2, 1, 'MT0002', ''], [2, 1, 1, 'MT0003', '']])],
    ['5 Achievers CMS chapters', rows(['chapter_no', 'order', 'cms_chapter_id'], o.achievers ?? [[1, 1, 'MC01']])],
  ]);
}
const msgs = (r: ReturnType<typeof parseUpload>, level: 'error' | 'warn') => r.problems.filter((p) => p.level === level).map((p) => p.message);

describe('parseUpload', () => {
  it('a valid file: head and outline, no problems', () => {
    const r = parseUpload(book(), ctx());
    expect(r.problems).toEqual([]);
    expect(r.head).toEqual({ name: 'Pilot', board_id: 'BRD01', class: 5, subject: 'math' });
    expect(r.outline).toEqual({ chapters: [
      { name: 'A', achievers: ['MC01'], topics: [{ name: 'a1', cms: ['MT0001'] }, { name: 'a2', cms: ['MT0002'] }] },
      { name: 'B', achievers: [], topics: [{ name: 'b1', cms: ['MT0003'] }] }] });
  });
  it('course sheet errors: board, class, subject, name taken', () => {
    expect(readCourseSheet(book({ course: ['x', 'Nope', 7, 'Art'] }), boards).problems.map((p) => p.message)).toEqual([
      expect.stringContaining('Board "Nope" is not in the board list'), expect.stringContaining('class must be 1–6'), expect.stringContaining('subject must be Math or Science')]);
    expect(readCourseSheet(book({ course: ['x', 'Old', 5, 'Math'] }), boards).problems[0]!.message).toContain('retired');
    expect(msgs(parseUpload(book({ course: ['Taken', 'CBSE·NCERT', 5, 'math'] }), ctx()), 'error')[0]).toContain('already exists (CRS009)');
  });
  it('✗ errors: unknown / retired / Achievers / twice CMS topic, unknown and twice Achievers chapter, bad references', () => {
    const r = parseUpload(book({
      topics: [[1, 1, 'a1'], [1, 1, 'dup'], [3, 1, 'orphan'], [2, 1, '']],
      items: [[1, 1, 1, 'MT0001'], [1, 1, 2, 'MT0001'], [1, 1, 3, 'MT7777'], [1, 1, 4, 'ST0001'], [1, 1, 5, 'MT0009'], [1, 1, 6, 'ACH-MC01-5'], [9, 9, 1, 'MT0002']],
      achievers: [[1, 1, 'MC01'], [2, 1, 'MC01'], [2, 2, 'MC77'], [5, 1, 'MC02']] }), ctx());
    expect(msgs(r, 'error')).toEqual([
      'Topic 1.1 is listed twice (rows 2 and 3).', 'Topic 3.1: there is no chapter 3 in sheet 2.', 'Topic 2.1 has no name.',
      'MT0001 (Topic MT0001) is used twice in the course: 1.1 (row 2) and 1.1 (row 3).', 'Unknown CMS topic ID MT7777 (not a math topic).', 'Unknown CMS topic ID ST0001 (not a math topic).',
      'MT0009 (Topic MT0009) is retired.', 'ACH-MC01-5 is an Achievers topic; put its CMS chapter in sheet 5.', 'MT0002: there is no display topic 9.9 in sheet 3.',
      'MC01 (One) is used twice: chapters 1 and 2.', 'Unknown CMS chapter MC77 (not a math chapter).', 'MC02: there is no chapter 5 in sheet 2.']);
  });
  it('! warnings: name differs (ID wins), > 4 CMS topics (first 4 by order kept), no ACH topic for the class, empty, gaps', () => {
    const r = parseUpload(book({
      chapters: [[1, 'A'], [3, 'C']], topics: [[1, 1, 'a1'], [1, 3, 'a3']],
      items: [[1, 1, 5, 'MT0005', 'Other name'], [1, 1, 1, 'MT0001'], [1, 1, 2, 'MT0002'], [1, 1, 3, 'MT0003'], [1, 1, 4, 'MT0004']],
      achievers: [[1, 1, 'MC02']] }), ctx());
    expect(msgs(r, 'error')).toEqual([]);
    expect(msgs(r, 'warn')).toEqual([
      'Chapter numbers have gaps (1, 3); they are renumbered 1–2.',
      'MT0005: the file says "Other name", the CMS says "Topic MT0005" (the ID wins).',
      expect.stringContaining('MC02 (Two) has no Achievers topic for Class 5'),
      'Chapter 1: topic numbers have gaps (1, 3); renumbered.',
      'Topic 1.1: 5 CMS topics; only the first 4 by order are saved (not saved: MT0005).',
      'Topic 1.3 "a3" has no CMS topics (Publish will be blocked until it has one).',
      'Chapter 3 "C" has no display topics.']);
    expect(r.outline.chapters[0]!.topics[0]!.cms).toEqual(['MT0001', 'MT0002', 'MT0003', 'MT0004']);
  });
  it('Science: Achievers are refused', () => {
    expect(msgs(parseUpload(book({ course: ['S', 'CBSE·NCERT', 5, 'Science'], items: [] }), ctx()), 'error')).toContain('Science has no Achievers topics yet; leave sheet 5 empty.');
  });
  it('replace a draft: keeps IDs by position; refuses a published course, another class or subject; name kept', () => {
    const prev: Outline = { chapters: [{ id: 'DCH0001', name: 'Old A', achievers: [], topics: [{ id: 'DTP00001', name: 'x', cms: ['MT0006'] }] }, { id: 'DCH0002', name: 'B', achievers: [], topics: [] }, { id: 'DCH0003', name: 'gone', achievers: [], topics: [] }] };
    const replace = { course_id: 'CRS001', name: 'Mine', board_id: 'BRD01', class: 5, subject: 'math', status: 'draft', outline: prev };
    const r = parseUpload(book(), ctx({ replace }));
    expect(msgs(r, 'error')).toEqual([]);
    expect(msgs(r, 'warn')).toEqual(['The file says "Pilot"; the draft keeps its name "Mine".']);
    expect(r.outline.chapters.map((c) => [c.id, c.topics.map((t) => t.id ?? 'new')])).toEqual([['DCH0001', ['DTP00001', 'new']], ['DCH0002', ['new']]]);
    expect(outlineDiff(prev, r.outline)).toEqual({ chaptersAdded: 0, chaptersRenamed: 1, chaptersRetired: 1, topicsAdded: 2, topicsRenamed: 1, topicsRetired: 0, linksAdded: 3, linksRemoved: 1, achieversChanged: 1 });
    expect(msgs(parseUpload(book(), ctx({ replace: { ...replace, status: 'published', class: 4 } })), 'error')).toEqual(['CRS001 is published; only a draft can be replaced.', 'The file is for Class 5, CRS001 is Class 4.']);
  });
  it('template round trip: a course written with templateSheets reads back the same', () => {
    const outline: Outline = { chapters: [{ name: 'A', achievers: ['MC01'], topics: [{ name: 'a1', cms: ['MT0001', 'MT0002'] }] }, { name: 'B', achievers: [], topics: [{ name: 'b1', cms: ['MT0003'] }] }] };
    const sh = templateSheets({ head: { name: 'Round', board_label: 'CBSE·NCERT', class: 5, subject: 'math' }, cls: 5, outline, topics, chapters: [{ chapter_id: 'MC01', name: 'One', strand_id: 'math-X' }], strands: [{ strand_id: 'math-X', name: 'X' }], notes: { topics: { '1.1': 'guess' } } });
    expect(sh.map((s) => s.name)).toEqual(['1 Course', '2 Display chapters', '3 Display topics', '4 Display topic → CMS topics', '5 Achievers CMS chapters', '6 CMS topics (read-only)']);
    expect(sh[2]!.columns).toEqual(['chapter_no', 'topic_no', 'display_topic_name', 'notes']);
    expect(sh[5]!.rows[0]!.slice(0, 2)).toEqual(['MT0001', 'Topic MT0001']);
    const back: Sheets = new Map(sh.map((s) => [s.name, rows(s.columns, s.rows)]));
    const r = parseUpload(back, ctx());
    expect(r.problems).toEqual([]);
    expect(r.outline).toEqual(outline);
  });
});

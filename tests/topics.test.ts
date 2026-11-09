import { describe, expect, it } from 'vitest';
import { achieversTopics, diffRow, parseSubject, sourceKey, stableJson } from '../scripts/lib/topics.ts';
import type { Cell, Row } from '../scripts/lib/xlsx.ts';

const rows = (...r: Record<string, Cell>[]): Row[] => r.map((values, i) => ({ row: i + 2, values }));

function science(over: { chapters?: Row[]; topics?: Row[]; classView?: Row[] } = {}) {
  return new Map<string, Row[]>([
    ['Master Chapters', over.chapters ?? rows(
      { 'Chapter ID': 'SC01', 'Strand Code': 'LIV', Strand: 'Living World', 'Display Code': 'LIV-01', Chapter: 'Living Things' },
      { 'Chapter ID': 'SC02', 'Strand Code': 'LR', Strand: 'Logical Reasoning', Chapter: 'Puzzles' },
    )],
    ['Master Topics', over.topics ?? rows(
      { 'Topic ID': 'ST0001', 'Chapter ID': 'SC01', Topic: 'Living or not', Level: 1, 'Reference Grade': 2, 'Classes – NCERT': '6', 'Classes – DAV': '–', 'Classes – ISO': '1', Status: 'Active' },
      { 'Topic ID': 'ST0002', 'Chapter ID': 'SC01', Topic: 'Needs of living things', Level: 2, 'Reference Grade': 2, 'Classes – NCERT': '–', 'Classes – DAV': '–', 'Classes – ISO': '2', Status: 'Active' },
      { 'Topic ID': 'ST0003', 'Chapter ID': 'SC02', Topic: 'Old puzzle', 'Reference Grade': 4, 'Classes – NCERT': '–', 'Classes – DAV': '4', Status: 'Retired' },
    )],
    ['Class View', over.classView ?? rows(
      { Class: 2, Seq: 1, Strand: 'Living World', 'Chapter ID': 'SC01', 'Topic ID': 'ST0001', Topic: 'Living or not' },
      { Class: 2, Seq: 2, Strand: 'Living World', 'Chapter ID': 'SC01', 'Topic ID': 'ST0002', Topic: 'Needs of living things' },
    )],
  ]);
}
const errors = (p: ReturnType<typeof parseSubject>) => p.problems.filter((x) => x.level === 'error').map((x) => x.message);

describe('parseSubject', () => {
  it('parses strands (subject-prefixed IDs), chapters and topics', () => {
    const p = parseSubject('science', science());
    expect(errors(p)).toEqual([]);
    expect(p.strands.map((s) => s.strand_id)).toEqual(['science-LIV', 'science-LR']);
    expect(p.chapters.map((c) => [c.chapter_id, c.strand_id, c.sort])).toEqual([['SC01', 'science-LIV', 1], ['SC02', 'science-LR', 2]]);
    const t1 = p.topics.find((t) => t.topic_id === 'ST0001')!;
    expect(t1).toMatchObject({ class: 2, seq: 1, status: 'active', taught_in_school: true, source_flags: { ncert: '6', iso: '1' } });
  });

  it('taught_in_school only from NCERT or DAV, never from olympiad or IXL', () => {
    const t2 = parseSubject('science', science()).topics.find((t) => t.topic_id === 'ST0002')!;
    expect(t2.taught_in_school).toBe(false);
    expect(t2.source_flags).toEqual({ iso: '2' });
  });

  it('retired topic missing from Class View takes its class from Reference Grade', () => {
    const t3 = parseSubject('science', science()).topics.find((t) => t.topic_id === 'ST0003')!;
    expect(t3).toMatchObject({ status: 'retired', class: 4, seq: null, taught_in_school: true });
  });

  it('English uses Class (placement) for retired topics', () => {
    const sheets = new Map<string, Row[]>([
      ['Master Chapters', rows({ 'Chapter ID': 'GC01', 'Strand Code': 'SEN', Strand: 'Sentences', Chapter: 'Basics' })],
      ['Master Topics', rows({ 'Topic ID': 'GT0011', 'Chapter ID': 'GC01', Topic: 'Old', 'Class (placement)': 4, Status: 'Retired' })],
      ['Class View', []],
    ]);
    const p = parseSubject('grammar', sheets);
    expect(errors(p)).toEqual([]);
    expect(p.topics[0]).toMatchObject({ topic_id: 'GT0011', class: 4, status: 'retired' });
    expect(p.strands[0]!.strand_id).toBe('grammar-SEN');
  });

  it.each([
    ['active topic not in Class View', { classView: rows({ Class: 2, 'Topic ID': 'ST0001' }) }, /ST0002 is Active but not in Class View/],
    ['Class View topic not in Master Topics', { classView: [...science().get('Class View')!, ...rows({ Class: 3, 'Topic ID': 'ST0099' })] }, /ST0099 is not in Master Topics/],
    ['topic listed twice in Class View', { classView: rows({ Class: 2, 'Topic ID': 'ST0001' }, { Class: 3, 'Topic ID': 'ST0001' }, { Class: 2, 'Topic ID': 'ST0002' }) }, /ST0001 is listed twice/],
    ['class out of range', { classView: rows({ Class: 7, 'Topic ID': 'ST0001' }, { Class: 2, 'Topic ID': 'ST0002' }) }, /class must be 1–6/],
    ['wrong chapter prefix', { chapters: rows({ 'Chapter ID': 'MC01', 'Strand Code': 'LIV', Strand: 'Living World', Chapter: 'x' }) }, /should look like SC01/],
    ['strand code with two names', { chapters: rows(
      { 'Chapter ID': 'SC01', 'Strand Code': 'LIV', Strand: 'Living World', Chapter: 'a' },
      { 'Chapter ID': 'SC02', 'Strand Code': 'LIV', Strand: 'Life', Chapter: 'b' }) }, /strand code LIV is "Living World" elsewhere but "Life" here/],
    ['topic in unknown chapter', { topics: rows({ 'Topic ID': 'ST0001', 'Chapter ID': 'SC77', Topic: 'x' }) }, /chapter SC77 is not in Master Chapters/],
    ['bad status', { topics: rows({ 'Topic ID': 'ST0001', 'Chapter ID': 'SC01', Topic: 'x', Status: 'Maybe' }), classView: rows({ Class: 2, 'Topic ID': 'ST0001' }) }, /status must be Active or Retired/],
  ])('error: %s', (_n, over, msg) => {
    expect(errors(parseSubject('science', science(over)))).toEqual(expect.arrayContaining([expect.stringMatching(msg)]));
  });

  it('reports a missing sheet', () => {
    const s = science(); s.delete('Class View');
    expect(errors(parseSubject('science', s))).toContain('sheet "Class View" is missing');
  });
});

describe('achieversTopics', () => {
  const asMath = () => {
    const p = parseSubject('science', science());
    // same data, relabelled as Math
    const chapters = p.chapters.map((c) => ({ ...c, subject: 'math' as const, chapter_id: c.chapter_id.replace('SC', 'MC') }));
    const topics = p.topics.map((t) => ({ ...t, chapter_id: t.chapter_id.replace('SC', 'MC') }));
    return { chapters, topics };
  };

  it('Math: one ACH-<chapter>-<class> per chapter-class with an active topic; retired topics do not count', () => {
    const { chapters, topics } = asMath();
    const ach = achieversTopics(chapters, topics);
    expect(ach.map((a) => a.topic_id)).toEqual(['ACH-MC01-2']);
    expect(ach[0]).toMatchObject({ topic_kind: 'achievers', class: 2, chapter_id: 'MC01', name: 'Achievers: Living Things', status: 'active' });
  });

  it('Science and English: none for now', () => {
    const p = parseSubject('science', science());
    expect(achieversTopics(p.chapters, p.topics)).toEqual([]);
  });
});

describe('helpers', () => {
  it('sourceKey', () => {
    expect(sourceKey('Classes – NCERT')).toBe('ncert');
    expect(sourceKey('Classes - IMO')).toBe('imo');
    expect(sourceKey('Reference Grade')).toBeNull();
  });

  it('diff ignores jsonb key order but sees real changes', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(diffRow({ name: 'x', source_flags: { dav: '1', ncert: '2' } }, { name: 'x', source_flags: { ncert: '2', dav: '1' } })).toEqual({});
    expect(diffRow({ name: 'x', level: null }, { name: 'y', level: null })).toEqual({ name: { before: 'x', after: 'y' } });
  });
});

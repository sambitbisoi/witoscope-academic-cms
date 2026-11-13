// Sequencing (13 Nov 2026): order and numbering per class, no crossing, extras and Achievers last.
import { describe, expect, it } from 'vitest';
import { buildSequence, moveWithin, numbered, numbersOf, type SeqOrders, type SeqTopic } from '../shared/sequence.ts';

const strands = [{ strand_id: 'math-NUM', name: 'Numbers & Place Value', sort: 1 }, { strand_id: 'math-OPS', name: 'Operations', sort: 2 }];
const chapters = [
  { chapter_id: 'MC02', strand_id: 'math-NUM', name: 'Counting', sort: 2 }, { chapter_id: 'MC03', strand_id: 'math-NUM', name: 'Numerals', sort: 3 },
  { chapter_id: 'MC08', strand_id: 'math-OPS', name: 'Addition', sort: 8 }, { chapter_id: 'MC09', strand_id: 'math-OPS', name: 'Subtraction', sort: 9, status: 'retired' },
];
const t = (topic_id: string, chapter_id: string, cls: number, o: Partial<SeqTopic> = {}): SeqTopic =>
  ({ topic_id, chapter_id, class: cls, name: topic_id, status: 'active', topic_kind: 'normal', seq: null, classes: [cls], ...o });
const topics = [
  t('T1', 'MC02', 6, { seq: 2 }), t('T2', 'MC02', 6, { seq: 1 }), t('T3', 'MC03', 6, { seq: 3 }), t('T4', 'MC08', 6, { seq: 4 }),
  t('ACH', 'MC02', 6, { topic_kind: 'achievers' }), t('OLD', 'MC02', 6, { status: 'retired', seq: 0 }),
  t('LOW', 'MC02', 3, { classes: [3, 6] }), t('HIGH', 'MC08', 6 + 0, { class: 5, classes: [5, 6] }), t('X', 'MC09', 6, { seq: 9 }),
];
const none: SeqOrders = { strands: [], chapters: [], topics: [] };
const flat = (cls: number, o = none, includeExtra = true) =>
  buildSequence(cls, strands, chapters, topics, o, { includeExtra }).flatMap((s) => [`${s.no ?? '-'} ${s.strand.strand_id}`,
    ...s.chapters.flatMap((c) => [`${c.no ?? '-'} ${c.chapter.chapter_id}`, ...c.topics.map((x) => `${x.no ?? '-'} ${x.topic.topic_id}`)])]);

describe('numbering', () => {
  it('falls back to the Class View Seq; no gaps; retired hidden; extras after core, Achievers last, both unnumbered', () => {
    expect(flat(6)).toEqual(['1 math-NUM', '1.1 MC02', '1.1.1 T2', '1.1.2 T1', '- LOW', '- ACH', '1.2 MC03', '1.2.1 T3',
      '2 math-OPS', '2.1 MC08', '2.1.1 T4', '- HIGH']);
  });
  it('without extras, extra-only chapters and strands disappear', () => {
    expect(flat(6, none, false)).not.toContain('- LOW');
  });
  it('follows the stored order; numbers stay gap-free', () => {
    const o: SeqOrders = { strands: [{ class: 6, strand_id: 'math-OPS', position: 1 }, { class: 6, strand_id: 'math-NUM', position: 2 }],
      chapters: [{ class: 6, chapter_id: 'MC03', strand_id: 'math-NUM', position: 1 }, { class: 6, chapter_id: 'MC02', strand_id: 'math-NUM', position: 5 }],
      topics: [{ class: 6, topic_id: 'T1', chapter_id: 'MC02', position: 1 }, { class: 6, topic_id: 'OLD', chapter_id: 'MC02', position: 2 }, { class: 6, topic_id: 'T2', chapter_id: 'MC02', position: 3 }] };
    expect(flat(6, o, false)).toEqual(['1 math-OPS', '1.1 MC08', '1.1.1 T4', '2 math-NUM', '2.1 MC03', '2.1.1 T3', '2.2 MC02', '2.2.1 T1', '2.2.2 T2', '- ACH']);
  });
  it('an item stored under another parent (it moved) or with no position goes to the end', () => {
    const o: SeqOrders = { ...none, topics: [{ class: 6, topic_id: 'T2', chapter_id: 'MC03', position: 1 }, { class: 6, topic_id: 'T1', chapter_id: 'MC02', position: 1 }] };
    expect(flat(6, o, false).slice(1, 4)).toEqual(['1.1 MC02', '1.1.1 T1', '1.1.2 T2']);
  });
  it('another class only numbers its own core topics', () => {
    expect(flat(3, none, false)).toEqual(['1 math-NUM', '1.1 MC02', '1.1.1 LOW']);
  });
  it('numbersOf and labels', () => {
    const n = numbersOf(buildSequence(6, strands, chapters, topics, none));
    expect([n.strand.get('math-OPS'), n.chapter.get('MC03'), n.topic.get('T1'), n.topic.get('LOW')]).toEqual(['2', '1.2', '1.1.2', undefined]);
    expect(numbered('1', 'Numbers & Place Value', 'strand')).toBe('1. Numbers & Place Value');
    expect(numbered('1.2.3', 'Place numbers')).toBe('1.2.3 Place numbers');
    expect(numbered(null, 'Extra topic')).toBe('Extra topic');
  });
});

describe('moving within one list (no crossing)', () => {
  it('moves an item and keeps the rest in order', () => {
    expect(moveWithin(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveWithin(['a', 'b', 'c'], 0, 9)).toEqual(['b', 'c', 'a']);
    expect(moveWithin(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  applyFilters, browseHash, countsLabel, sameWording, cloneGroups, classesLabel, distinctTexts, involvementOf, summarize, statusCountsLabel, gapLabel, groupBySet, NO_FILTERS, parseRoute, mapHash, roleOf, roleLabel, showMatches, safeSearch, signatureRows, derivedRows, statusLabel,
  subjectOfChapter, type ListQuestion, type TopicStats, type VersionRow,
} from '../web/src/logic.ts';

const stats = (o: Partial<TopicStats>): TopicStats => ({ n_questions: 0, n_simple: 0, n_medium: 0, n_complex: 0, n_gold: 0, n_draft: 0, n_in_review: 0, n_approved: 0, ...o });
const q = (o: Partial<ListQuestion>): ListQuestion => ({ question_id: 'MQ000001', bank: 'production', typical_set_id: null, pattern_id: null,
  math_difficulty: 'Medium', status: 'draft', text: 't', current_version: 1, approved_version: null, retired_at: null, ...o });

describe('routes', () => {
  it.each([
    ['', { name: 'home', grade: null }],
    ['#/?grade=6', { name: 'home', grade: '6' }],
    ['#/imports', { name: 'imports' }],
    ['#/review', { name: 'review' }],
    ['#/generate?q=MQ000010', { name: 'generate', q: 'MQ000010', set: null, topic: null }],
    ['#/generate?set=TS-G6-X&topic=MT0393', { name: 'generate', q: null, set: 'TS-G6-X', topic: 'MT0393' }],
    ['#/run/12', { name: 'run', id: 12 }],
    ['#/browse/math/6/MT0393?q=MQ000010&edit=1', { name: 'browse', subject: 'math', cls: '6', strand: null, ch: null, topic: 'MT0393', q: 'MQ000010', v: null, tab: 'types', edit: true }],
    ['#/imports/12', { name: 'import', id: 12 }],
    ['#/q/G5-007', { name: 'question', id: 'G5-007' }],
    ['#/browse/math/6', { name: 'browse', subject: 'math', cls: '6', strand: null, ch: null, topic: null, q: null, v: null, tab: 'types', edit: false }],
    ['#/browse/science/all/ST0001?q=SQ000001&v=2&tab=concepts', { name: 'browse', subject: 'science', cls: 'all', strand: null, ch: null, topic: 'ST0001', q: 'SQ000001', v: 2, tab: 'concepts', edit: false }],
    ['#/browse/math/6/MT0393?tab=sources', { name: 'browse', subject: 'math', cls: '6', strand: null, ch: null, topic: 'MT0393', q: null, v: null, tab: 'sources', edit: false }],
    ['#/browse/math/9', { name: 'browse', subject: 'math', cls: 'all', strand: null, ch: null, topic: null, q: null, v: null, tab: 'types', edit: false }],
    ['#/browse/art/6', { name: 'notfound' }],
  ])('%s', (hash, route) => expect(parseRoute(hash)).toEqual(route));

  it('R3: strand in Browse round-trips; a bad strand is dropped', () => {
    const h = browseHash({ subject: 'math', cls: '6', strand: 'math-OPS', ch: 'MC10' });
    expect(h).toBe('#/browse/math/6?strand=math-OPS&ch=MC10');
    expect(parseRoute(h)).toMatchObject({ strand: 'math-OPS', ch: 'MC10' });
    expect(parseRoute('#/browse/math/6?strand=x%27y')).toMatchObject({ strand: null });
  });

  it('R2: map route keeps strand, show and the chapter / topic checkboxes', () => {
    expect(parseRoute('#/map')).toMatchObject({ name: 'map', strand: null, show: 'all', chapters: true, topics: true });
    const h = mapHash({ cls: '6', subject: 'math', strand: 'math-OPS', ch: null, show: 'extra', q: '', chapters: false, topics: false });
    expect(h).toBe('#/map?cls=6&subject=math&strand=math-OPS&show=extra&chapters=0&topics=0');
    expect(parseRoute(h)).toMatchObject({ cls: '6', subject: 'math', strand: 'math-OPS', show: 'extra', chapters: false, topics: false });
    expect(parseRoute('#/map?show=gaps')).toMatchObject({ show: 'all' }); // old values fall back to all
  });

  it('R1: role of a topic–class link from the home class', () => {
    expect(roleOf(6, 6)).toBe('core');
    expect(roleOf(1, 6)).toBe('lower');
    expect(roleOf(6, 4)).toBe('higher');
    expect(roleLabel(6, 6)).toBe('core');
    expect(roleLabel(3, 6)).toBe('from Class 3');
    expect(['core', 'lower', 'higher'].filter((r) => showMatches('extra', r as never))).toEqual(['lower', 'higher']);
    expect(showMatches('all', 'higher') && showMatches('core', 'core') && !showMatches('lower', 'higher')).toBe(true);
  });

  it('browseHash round-trips', () => {
    const h = browseHash({ subject: 'math', cls: '6', topic: 'ACH-MC19-6', q: 'MQ000010', v: 2, tab: 'concepts', edit: false });
    expect(h).toBe('#/browse/math/6/ACH-MC19-6?q=MQ000010&v=2&tab=concepts');
    expect(parseRoute(h)).toMatchObject({ topic: 'ACH-MC19-6', q: 'MQ000010', v: 2, tab: 'concepts', edit: false });
  });

  it('subject from chapter ID', () => {
    expect([subjectOfChapter('MC19'), subjectOfChapter('SC05'), subjectOfChapter('GC01')]).toEqual(['math', 'science', 'grammar']);
  });
});

describe('coverage labels', () => {
  it('counts: production only, gold separately', () => {
    expect(countsLabel(stats({}))).toBe('no questions');
    expect(countsLabel(stats({ n_gold: 3 }))).toBe('no questions · gold 3');
    expect(countsLabel(stats({ n_questions: 1, n_medium: 1 }))).toBe('1 Q · Simple 0 · Medium 1 · Complex 0');
    expect(countsLabel(stats({ n_questions: 12, n_simple: 4, n_medium: 6, n_complex: 2, n_gold: 1 }))).toBe('12 Qs · Simple 4 · Medium 6 · Complex 2 · gold 1');
  });
  it('gap: only for topics that have questions [guess]', () => {
    expect(gapLabel(stats({}))).toBeNull();
    expect(gapLabel(stats({ n_gold: 5 }))).toBeNull();
    expect(gapLabel(stats({ n_questions: 3, n_simple: 1, n_medium: 2 }))).toBe('no Complex');
    expect(gapLabel(stats({ n_questions: 1, n_medium: 1 }))).toBe('no Simple, no Complex');
    expect(gapLabel(stats({ n_questions: 3, n_simple: 1, n_medium: 1, n_complex: 1 }))).toBeNull();
  });
});

describe('status', () => {
  it('shows both when the approved version is older', () => {
    expect(statusLabel({ status: 'draft', current_version: 1, approved_version: null })).toBe('Draft');
    expect(statusLabel({ status: 'draft', current_version: 2, approved_version: 1 })).toBe('Approved v1 · Draft v2');
    expect(statusLabel({ status: 'approved', current_version: 2, approved_version: 2 })).toBe('Approved');
    expect(statusLabel({ status: 'approved', current_version: 1, approved_version: 1, retired_at: '2026-11-09' })).toBe('Retired');
  });
});

describe('group by question type', () => {
  const qs = [
    q({ question_id: 'MQ3', typical_set_id: 'TS-B', pattern_id: 'MP2', math_difficulty: 'Complex' }),
    q({ question_id: 'MQ1', typical_set_id: 'TS-B', pattern_id: 'MP2', math_difficulty: 'Simple' }),
    q({ question_id: 'MQ2', typical_set_id: 'TS-B', pattern_id: null }),
    q({ question_id: 'MQ4', typical_set_id: null }),
    q({ question_id: 'MQ5', typical_set_id: 'TS-Z' }),
  ];
  it('known sets first (even empty), unknown sets next, no set last; patterns then Simple → Complex', () => {
    const g = groupBySet(qs, ['TS-A', 'TS-B']);
    expect(g.map((x) => [x.setId, x.count])).toEqual([['TS-A', 0], ['TS-B', 3], ['TS-Z', 1], [null, 1]]);
    expect(g[1]!.patterns.map((p) => [p.patternId, p.questions.map((x) => x.question_id)])).toEqual([['MP2', ['MQ1', 'MQ3']], [null, ['MQ2']]]);
  });
  it('filters', () => {
    expect(applyFilters(qs, { ...NO_FILTERS, difficulty: 'Simple' }).map((x) => x.question_id)).toEqual(['MQ1']);
    expect(applyFilters([...qs, q({ question_id: 'G1', bank: 'gold' })], { ...NO_FILTERS, bank: 'gold' }).map((x) => x.question_id)).toEqual(['G1']);
    expect(applyFilters([q({ retired_at: 'x' }), q({ question_id: 'MQ9' })], { ...NO_FILTERS, status: 'draft' }).map((x) => x.question_id)).toEqual(['MQ9']);
  });
});

describe('v10 signature', () => {
  const v: VersionRow = { math_difficulty: 'Medium', is_pure_fact: false, reading: 2, has_irrelevant_info: true, steps: 4, multistep_band: 3,
    working_memory: 2, inhibition: 1, visual: 0, strategy: 2, tier: 'Achiever', strategy_type: 'Work backwards', strategy_type_2: null,
    strategy_other_note: null, insight_id: 'INS-LAST-STEP', load: 3, load_driver: 'multi_step', style: 'word', trap_level: 2,
    is_isolating: true, difficulty_points: 5 };
  it('authored fields in v10 order, with band and tier beside steps and strategy', () => {
    expect(signatureRows(v, 'The last step is different')).toEqual([
      { k: 'Math difficulty', v: 'Medium' }, { k: 'Reading', v: '2' }, { k: 'Steps', v: '4 → band 3' }, { k: 'Working memory', v: '2' },
      { k: 'Inhibition', v: '1' }, { k: 'Visual', v: '0' }, { k: 'Strategy', v: '2 → Achiever' }, { k: 'Strategy type', v: 'Work backwards' },
      { k: 'Insight', v: 'INS-LAST-STEP · The last step is different' }, { k: 'Pure fact', v: 'No' }, { k: 'Irrelevant info', v: 'Yes' },
    ]);
  });
  it('derived fields', () => {
    expect(derivedRows(v)).toEqual([
      { k: 'Load', v: '3 · multi-step' }, { k: 'Style', v: 'word' }, { k: 'Tier', v: 'Achiever' }, { k: 'Trap level', v: '2 · misconception' },
      { k: 'Isolating', v: 'Yes' }, { k: 'Difficulty points', v: '5' },
    ]);
  });
  it('search input is made safe for PostgREST filters', () => {
    expect(safeSearch('MT0393),or(x.eq.1')).toBe('MT0393 or x.eq.1');
    expect(safeSearch('  unlike   fractions ')).toBe('unlike fractions');
  });
});

describe('queue 12 Nov 2026 (PR A)', () => {
  it('U4: the chapter is kept in the browse URL', () => {
    const h = browseHash({ subject: 'math', cls: '5', ch: 'MC34', topic: 'MT0429', q: 'MQ000001' });
    expect(h).toBe('#/browse/math/5/MT0429?ch=MC34&q=MQ000001');
    expect(parseRoute(h)).toMatchObject({ name: 'browse', ch: 'MC34', topic: 'MT0429', q: 'MQ000001' });
    expect(parseRoute('#/browse/math/5?ch=bad')).toMatchObject({ ch: null });
  });
  it('U2: the proposed list route', () => {
    expect(parseRoute('#/proposed?kind=pattern')).toEqual({ name: 'proposed', kind: 'pattern' });
  });
  it('U8: texts that share a long opening show the part that differs', () => {
    const a = 'A fish made a quarter turn. Look at it before and after. Did it turn clockwise or anti-clockwise? (red fish)';
    const b = 'A fish made a quarter turn. Look at it before and after. Did it turn clockwise or anti-clockwise? (blue fish)';
    const [x, y, z] = distinctTexts([a, b, 'Something else entirely']);
    expect(x!.startsWith('…')).toBe(true);
    expect(x).toContain('(red fish)');
    expect(y).toContain('(blue fish)');
    expect(z).toBe('Something else entirely');
    expect(distinctTexts([a, a])).toEqual([a, a]); // identical texts: nothing differs, keep them
  });
  it('U9 / U7: involvement labels and group summaries', () => {
    expect(involvementOf(1).label).toBe('main');
    expect(involvementOf(0.5).label).toBe('secondary');
    expect(involvementOf(0.2).label).toBe('minor');
    const s = summarize([
      { math_difficulty: 'Simple', status: 'draft', retired_at: null },
      { math_difficulty: 'Complex', status: 'approved', retired_at: null },
      { math_difficulty: 'Simple', status: 'in_review', retired_at: null },
    ]);
    expect(s).toEqual({ count: 3, simple: 2, medium: 0, complex: 1, byStatus: { draft: 1, approved: 1, in_review: 1 } });
    expect(statusCountsLabel(s.byStatus)).toBe('1 approved · 1 needs review · 1 draft');
  });
});

describe('U8 same wording', () => {
  it('counts identical texts', () => {
    expect(sameWording(['a', 'b', 'a', 'a'])).toEqual([3, 1, 3, 3]);
  });
});

describe('PR B helpers', () => {
  it('D8c: clones sit together, biggest group first, with n of size and near-identical wording', () => {
    const qs = [
      { question_id: 'Q1', clone_key: 'a', text: 'A lift is on floor 3. It goes down 5 floors.' },
      { question_id: 'Q2', clone_key: 'b', text: 'Something else' },
      { question_id: 'Q3', clone_key: 'a', text: 'A lift is on floor 4. It goes down 7 floors.' },
      { question_id: 'Q4', clone_key: 'a', text: 'The temperature is 2 °C and falls by 6 degrees.' },
      { question_id: 'Q5', clone_key: null, text: 'No pattern' },
    ];
    const g = cloneGroups(qs);
    expect(g.ordered.map((q) => q.question_id)).toEqual(['Q1', 'Q3', 'Q4', 'Q2', 'Q5']);
    expect(g.groups).toBe(3);
    expect(g.info.get('Q3')).toMatchObject({ size: 3, index: 2, nearIdentical: true });
    expect(g.info.get('Q4')!.nearIdentical).toBe(false);
    expect(g.info.get('Q2')).toMatchObject({ size: 1, nearIdentical: false });
  });
  it('U15: the multi-class label', () => {
    expect(classesLabel([5, 4, 6, 5])).toBe('Classes 4 · 5 · 6');
    expect(classesLabel([5])).toBeNull();
  });
});

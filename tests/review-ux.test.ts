// Review UX (15 Nov 2026, docs/plan-2026-11-15-review-ux.md): pure helpers.
import { describe, expect, it } from 'vitest';
import { catalogueClass, classFromId, conceptClassesByVersion, higherCount, levelTag, matchesAny, showsAtLevel, splitLabel, valueCounts } from '../web/src/logic.ts';

describe('Q2 / Q7: catalogue class', () => {
  it('own field first, else the ID prefix', () => {
    expect(catalogueClass('G6-FRC-C1', 4)).toBe(4);
    expect(catalogueClass('G6-FRC-C1', null)).toBe(6);
    expect(classFromId('TS-G3-FRAC-LEFT')).toBe(3);
    expect(classFromId('G5-M-FRC2')).toBe(5);
    expect(classFromId('MT0261')).toBeNull();
    expect(classFromId(null)).toBeNull();
  });
});

describe('Q3: Level tag', () => {
  it('here, revision, above class; all classes = plain Level', () => {
    expect(levelTag({ level: 4, effective_level: 4 }, 4)).toMatchObject({ text: 'Level 4', kind: 'here', unset: false });
    expect(levelTag({ level: 2, effective_level: 2 }, 4)).toMatchObject({ text: 'Level 2 · revision', kind: 'revision' });
    expect(levelTag({ level: 6, effective_level: 6 }, 4)).toMatchObject({ text: 'Level 6 · above class', kind: 'above' });
    expect(levelTag({ level: 6, effective_level: 6 }, null)).toMatchObject({ text: 'Level 6', kind: 'here' });
  });
  it('no Level yet: says the class used, never invents a Level', () => {
    expect(levelTag({ level: null, effective_level: 3 }, 3)).toMatchObject({ text: 'Level — (class 3 used)', unset: true, kind: 'here' });
    expect(levelTag({ level: null, effective_level: 3 }, 5).text).toBe('Level — (class 3 used) · revision');
  });
});

describe('Q1: higher-level questions', () => {
  it('default: Level ≤ class only; with the box: every Level; all classes: everything', () => {
    expect(showsAtLevel(5, 4, false)).toBe(false);
    expect(showsAtLevel(4, 4, false)).toBe(true);
    expect(showsAtLevel(2, 4, false)).toBe(true);
    expect(showsAtLevel(6, 4, true)).toBe(true);
    expect(showsAtLevel(6, null, false)).toBe(true);
  });
  it('split counts: "0 + 113 higher"; plain when the box is off or nothing is higher', () => {
    expect(splitLabel(0, 113, true)).toBe('0 + 113 higher');
    expect(splitLabel(106, 0, true)).toBe('106');
    expect(splitLabel(106, 113, false)).toBe('106');
    expect(higherCount([5, 6, 4, 3], 4)).toBe(2);
    expect(higherCount([5, 6], null)).toBe(0);
    expect(higherCount(undefined, 4)).toBe(0);
  });
});

describe('Q6: Concept class and Question Level filters', () => {
  it('nothing chosen = all; ANY of the question\'s concept classes matches', () => {
    expect(matchesAny([], [])).toBe(true);
    expect(matchesAny([5], [4, 5])).toBe(true);
    expect(matchesAny([6], [4, 5])).toBe(false);
    expect(matchesAny([6], [])).toBe(false);
  });
  it('concept classes per version (all parts), from the concept or its ID', () => {
    const m = conceptClassesByVersion([{ version_id: 1, concept_id: 'G5-A' }, { version_id: 1, concept_id: 'G6-B' }, { version_id: 2, concept_id: 'X' }],
      (id) => (id === 'X' ? null : classFromId(id)));
    expect([...m.get(1)!]).toEqual([5, 6]);
    expect(m.has(2)).toBe(false);
  });
  it('option counts: an item with a value twice counts once', () => {
    expect(Object.fromEntries(valueCounts([[5, 5, 6], [6]], (x) => x))).toEqual({ 5: 1, 6: 2 });
  });
});

describe('Q8: Kind line and the item in the URL', async () => {
  const { kindLine, itemParam, parseItem, decidable } = await import('../web/src/catalogueLogic.ts');
  const { parseRoute, browseHash } = await import('../web/src/logic.ts');
  it('says Kind and Class', () => {
    expect(kindLine({ kind: 'typical_set', id: 'TS-G3-X', status: 'proposed', cls: 3, via: null, topic_id: null })).toBe('Proposed question type · Class 3');
    expect(kindLine({ kind: 'pattern', id: 'MP1', status: 'proposed', cls: 3, via: 'via its question type', topic_id: null })).toBe('Proposed pattern · Class 3 (via its question type)');
    expect(kindLine({ kind: 'topic_class', id: 'MT0261·6', status: 'proposed', cls: 6, via: null, topic_id: 'MT0261' })).toBe('Proposed topic–class link MT0261 → Class 6');
    expect(kindLine({ kind: 'concept', id: 'G6-A', status: 'active', cls: 6, via: null, topic_id: null })).toBe('Concept · Class 6');
    expect(kindLine({ kind: 'setting', id: 'SET001', status: 'proposed', cls: null, via: null, topic_id: null })).toBe('Proposed setting');
  });
  it('settings are read-only; every other kind can be decided', () => {
    expect(decidable('setting')).toBe(false);
    expect(decidable('pattern')).toBe(true);
  });
  it('item=kind:id round-trips through Browse and Proposed routes; a question closes it', () => {
    expect(parseItem(itemParam('pattern', 'MP0376'))).toEqual({ kind: 'pattern', id: 'MP0376' });
    expect(parseItem('topic_class:MT0261·6')).toEqual({ kind: 'topic_class', id: 'MT0261·6' });
    expect(parseItem('bogus:X')).toBeNull();
    const h = browseHash({ subject: 'math', cls: '4', topic: 'MT0332', item: 'pattern:MP0376' });
    const r = parseRoute(h);
    expect(r.name === 'browse' && r.item).toBe('pattern:MP0376');
    expect(browseHash({ subject: 'math', cls: '4', topic: 'MT0332', item: 'pattern:MP0376', q: 'MQ1' })).not.toContain('item=');
    const p = parseRoute('#/proposed?kind=pattern&item=pattern%3AMP0376');
    expect(p.name === 'proposed' && p.item).toBe('pattern:MP0376');
    expect(parseRoute('#/proposed?kind=pattern&item=x%3Cscript').name === 'proposed' && (parseRoute('#/proposed?item=x%3Cscript') as { item: string | null }).item).toBeNull();
  });
});

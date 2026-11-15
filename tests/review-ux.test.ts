// Review UX (15 Nov 2026, docs/plan-2026-11-15-review-ux.md): pure helpers.
import { describe, expect, it } from 'vitest';
import { catalogueClass, classFromId, levelTag } from '../web/src/logic.ts';

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

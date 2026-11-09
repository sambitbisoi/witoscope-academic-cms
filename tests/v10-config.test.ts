import { describe, expect, it } from 'vitest';
import { parseBands, parseDerivedConfig } from '../scripts/lib/v10-config.ts';

// Shapes copied from the v10 workbook (title rows above the header row).
const derived = (bands = '1 step → 1 · 2–3 → 2 · 4–5 → 3 · 6–8 → 4 · 9+ → 5', load = "Gap engine: 'high load' = load ≥ 3 (HIGH_LOAD); 'very high' = load ≥ 4 (VERY_HIGH_LOAD); load flavour") => [
  ['Derived Attributes'], ['Computed by the system…'],
  ['Derived attribute', 'Derived from', 'Rule', 'Used in'],
  ['Load + load driver', 'Reading, MultiStep band, WorkingMemory', 'Load = highest of the three', load],
  ['MultiStep band', 'Steps', bands, 'Derived load'],
];
const engine = (diff = 'Math difficulty (bare math): Simple = 3, Medium = 5, Complex = 8', load = 'Derived load …, all on 1–5; high = ≥ 3, very high = ≥ 4') => [
  ['Engine Check'], ['Every input…'],
  ['Engine input (spec)', 'Comes from', 'Status'],
  ['Difficulty 3 / 5 / 8', diff, 'OK (mapping)'],
  ["Load + 'high load'", load, 'OK'],
];

describe('v10 derived config', () => {
  it('reads bands, difficulty points and load thresholds', () => {
    expect(parseDerivedConfig(derived(), engine())).toEqual({
      multistep_bands: [
        { min: 1, max: 1, band: 1 }, { min: 2, max: 3, band: 2 }, { min: 4, max: 5, band: 3 },
        { min: 6, max: 8, band: 4 }, { min: 9, max: null, band: 5 },
      ],
      difficulty_points: { Simple: 3, Medium: 5, Complex: 8 },
      load_thresholds: { high: 3, very_high: 4 },
    });
  });

  it('fails when the two sheets disagree on load thresholds', () => {
    expect(() => parseDerivedConfig(derived(), engine(undefined, 'high = ≥ 2, very high = ≥ 4'))).toThrow(/disagree/);
  });

  it('fails instead of guessing when wording changes', () => {
    expect(() => parseDerivedConfig(derived(), engine('Simple is three'))).toThrow(/cannot read Simple/);
    expect(() => parseDerivedConfig(derived(undefined, 'load is high from three'), engine())).toThrow(/HIGH_LOAD/);
  });

  it.each([
    ['gap', '1 step → 1 · 3–4 → 2 · 5+ → 3'],
    ['not open-ended', '1 step → 1 · 2–3 → 2'],
    ['misnumbered', '1 step → 1 · 2–3 → 3 · 4+ → 2'],
    ['unreadable', 'one band only'],
  ])('rejects bad bands: %s', (_n, rule) => {
    expect(() => parseBands(rule)).toThrow();
  });
});

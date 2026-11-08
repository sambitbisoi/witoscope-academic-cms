// Derived fields (design §4, v10 "Derived Attributes"), computed on import/save.
import type { DerivedConfig } from '../v10-config.ts';
import type { Question } from './types.ts';

export interface Derived {
  multistep_band: number; load: number; load_driver: 'reading' | 'multi_step' | 'memory';
  style: 'one-liner' | 'word'; tier: 'School' | 'Achiever' | 'Super Achiever';
  trap_level: 0 | 1 | 2; is_isolating: boolean; difficulty_points: number;
}

export function multistepBand(steps: number, bands: DerivedConfig['multistep_bands']): number {
  const b = bands.find((x) => steps >= x.min && (x.max === null || steps <= x.max));
  if (!b) throw new Error(`no MultiStep band for ${steps} steps`);
  return b.band;
}

/**
 * @param questionClass the class the question is placed in (class_override ?? class)
 * @param conceptClass  class of each concept, to spot beyond-grade concepts
 */
export function derive(q: Question, questionClass: number, conceptClass: (id: string) => number | undefined, cfg: DerivedConfig): Derived {
  const s = q.signature;
  const band = multistepBand(s.steps, cfg.multistep_bands);

  // Load = highest of reading, band, WM; ties: reading > multi-step > memory.
  const load = Math.max(s.reading, band, s.working_memory);
  const load_driver = s.reading === load ? 'reading' : band === load ? 'multi_step' : 'memory';

  const allConcepts = [...q.concepts, ...(q.parts ?? []).flatMap((p) => p.concepts)];
  const beyondGrade = allConcepts.some((c) => (conceptClass(c.concept_id) ?? 0) > questionClass);
  const tier = s.strategy >= 3 || beyondGrade ? 'Super Achiever' : s.strategy === 2 ? 'Achiever' : 'School';

  const tags = [q.answer, ...(q.parts ?? []).map((p) => p.answer)].flatMap((a) => a.wrong_answers ?? []).map((w) => w.tag);
  const trap_level = tags.includes('misconception') ? 2 : tags.includes('shortcut') ? 1 : 0;

  return {
    multistep_band: band, load, load_driver,
    style: s.reading === 1 ? 'one-liner' : 'word',
    tier, trap_level,
    is_isolating: q.concepts.filter((c) => c.involvement >= 0.5).length === 1,
    difficulty_points: cfg.difficulty_points[s.math_difficulty],
  };
}

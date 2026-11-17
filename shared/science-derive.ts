// Q29 (S4, Round 2, 17 Nov 2026): derived values for a Science question. The same formulas are in SQL
// (0042: the version trigger sets the stored tier; the view cms_science_derived computes the rest); a DB test checks
// that TS = SQL. Only Tier is stored (as Math's tier is); markers, load, trap level and clone group are computed.
//   Tier        type 1–3 → School · 4 → Achiever · 5 → Super Achiever (untyped → none)
//   Markers     count of: 2+ direct rows (primary + secondary, proposed included) · Steps ≥ 3 · Inhibition = 3 ·
//               Hidden idea = Y · Setting familiarity = Rare
//   Load        max(Reading, Steps band); Steps band 1→1 · 2–3→2 · 4–5→3 · 6–8→4 · 9+→5 (cms_config science_steps_bands);
//               a tie goes to reading (as Math); no working memory
//   Trap level  as Math: 2 if any wrong option is tagged misconception, 1 if any is shortcut, else 0
//   Clone group primary row + type + setting (none until the type is set)
export type ScienceTier = 'School' | 'Achiever' | 'Super Achiever';
export interface StepsBand { min: number; max: number | null; band: number }
export const SCIENCE_STEPS_BANDS: StepsBand[] = [
  { min: 1, max: 1, band: 1 }, { min: 2, max: 3, band: 2 }, { min: 4, max: 5, band: 3 }, { min: 6, max: 8, band: 4 }, { min: 9, max: null, band: 5 },
];
export interface ScienceDeriveInput {
  science_question_type?: number | null; reading: number | null; steps: number | null; inhibition: number | null;
  has_hidden_idea?: boolean | null; setting_familiarity?: string | null; setting_id?: string | null;
  links: { row_id: string; role: string; rank?: string | null }[];
  wrongTags: (string | null | undefined)[];
}
export interface ScienceDerived {
  tier: ScienceTier | null; markers: number; markerList: string[]; load: number | null; loadDriver: 'reading' | 'multi_step' | null;
  stepsBand: number | null; trapLevel: 0 | 1 | 2; primaryRow: string | null; cloneGroup: string | null;
}

export const scienceTier = (type: number | null | undefined): ScienceTier | null =>
  type === 1 || type === 2 || type === 3 ? 'School' : type === 4 ? 'Achiever' : type === 5 ? 'Super Achiever' : null;

export function stepsBand(steps: number | null, bands: StepsBand[] = SCIENCE_STEPS_BANDS): number | null {
  if (steps === null || steps === undefined) return null;
  return bands.find((b) => steps >= b.min && (b.max === null || steps <= b.max))?.band ?? null;
}

export function scienceDerive(x: ScienceDeriveInput, bands: StepsBand[] = SCIENCE_STEPS_BANDS): ScienceDerived {
  const direct = x.links.filter((l) => l.role === 'direct').length;
  const markerList = [
    direct >= 2 && '2+ direct rows',
    x.steps !== null && x.steps >= 3 && 'Steps ≥ 3',
    x.inhibition === 3 && 'Inhibition 3',
    x.has_hidden_idea === true && 'Hidden idea',
    x.setting_familiarity === 'Rare' && 'Rare setting',
  ].filter((m): m is string => !!m);
  const band = stepsBand(x.steps, bands);
  const load = x.reading === null && band === null ? null : Math.max(x.reading ?? 0, band ?? 0);
  const loadDriver = load === null ? null : x.reading !== null && x.reading >= (band ?? 0) ? 'reading' : 'multi_step';
  const trapLevel = x.wrongTags.includes('misconception') ? 2 : x.wrongTags.includes('shortcut') ? 1 : 0;
  const primaryRow = x.links.find((l) => l.rank === 'primary')?.row_id ?? null;
  const type = x.science_question_type ?? null;
  return {
    tier: scienceTier(type), markers: markerList.length, markerList, load, loadDriver, stepsBand: band, trapLevel, primaryRow,
    cloneGroup: type === null ? null : `${primaryRow ?? 'no primary'} · type ${type} · ${x.setting_id ?? 'bare'}`,
  };
}

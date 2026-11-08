// Derived-field config from the v10 workbook (decision 8): sheets
// "Derived Attributes" and "Engine Check". The values live in rule text, so
// they are extracted strictly: if the wording no longer matches, this fails
// instead of falling back to defaults. Where both sheets state a value, they
// must agree.
import type { Row } from './xlsx.ts';

export interface Band { min: number; max: number | null; band: number }
export interface DerivedConfig {
  multistep_bands: Band[];
  difficulty_points: { Simple: number; Medium: number; Complex: number };
  load_thresholds: { high: number; very_high: number };
}

/** Rows of a sheet whose header row (title rows above it) contains `firstHeader`. */
export function tableRows(raw: unknown[][], firstHeader: string): Record<string, string>[] {
  const h = raw.findIndex((r) => String(r[0] ?? '').trim() === firstHeader);
  if (h < 0) throw new Error(`header "${firstHeader}" not found`);
  const headers = raw[h]!.map((c) => String(c ?? '').trim());
  return raw.slice(h + 1)
    .filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((k, i) => [k, String(r[i] ?? '').trim()])));
}

const find = (rows: Record<string, string>[], col: string, starts: string, sheet: string) => {
  const r = rows.find((x) => (x[col] ?? '').toLowerCase().startsWith(starts.toLowerCase()));
  if (!r) throw new Error(`${sheet}: row "${starts}…" not found`);
  return r;
};

/** "1 step → 1 · 2–3 → 2 · 4–5 → 3 · 6–8 → 4 · 9+ → 5" */
export function parseBands(rule: string): Band[] {
  const parts = [...rule.matchAll(/(\d+)\s*(?:[–-]\s*(\d+)|(\+))?\s*(?:steps?)?\s*→\s*(\d+)/g)];
  if (parts.length < 2) throw new Error(`cannot read MultiStep bands from "${rule}"`);
  const bands = parts.map((m) => ({ min: Number(m[1]), max: m[3] ? null : Number(m[2] ?? m[1]), band: Number(m[4]) }));
  bands.forEach((b, i) => {
    const prev = bands[i - 1];
    if (prev && (prev.max === null || b.min !== prev.max + 1)) throw new Error(`MultiStep bands are not contiguous: ${rule}`);
    if (b.band !== i + 1) throw new Error(`MultiStep bands must be numbered 1, 2, 3…: ${rule}`);
  });
  if (bands[0]!.min !== 1 || bands.at(-1)!.max !== null) throw new Error(`MultiStep bands must start at 1 and end open ("9+"): ${rule}`);
  return bands;
}

export function parseDerivedConfig(derivedRaw: unknown[][], engineRaw: unknown[][]): DerivedConfig {
  const derived = tableRows(derivedRaw, 'Derived attribute');
  const engine = tableRows(engineRaw, 'Engine input (spec)');

  const multistep_bands = parseBands(find(derived, 'Derived attribute', 'MultiStep band', 'Derived Attributes')['Rule']!);

  const diffText = find(engine, 'Engine input (spec)', 'Difficulty', 'Engine Check')['Comes from']!;
  const dp = (name: string) => {
    const m = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(diffText);
    if (!m) throw new Error(`Engine Check: cannot read ${name} difficulty points from "${diffText}"`);
    return Number(m[1]);
  };
  const difficulty_points = { Simple: dp('Simple'), Medium: dp('Medium'), Complex: dp('Complex') };

  // Load thresholds: stated in both sheets; they must agree.
  const usedIn = find(derived, 'Derived attribute', 'Load', 'Derived Attributes')['Used in']!;
  const dHigh = /load\s*≥\s*(\d+)\s*\(HIGH_LOAD\)/.exec(usedIn);
  const dVery = /load\s*≥\s*(\d+)\s*\(VERY_HIGH_LOAD\)/.exec(usedIn);
  const loadText = find(engine, 'Engine input (spec)', 'Load', 'Engine Check')['Comes from']!;
  const eHigh = /(?<!very )high\s*=\s*≥\s*(\d+)/.exec(loadText);
  const eVery = /very high\s*=\s*≥\s*(\d+)/.exec(loadText);
  if (!dHigh || !dVery) throw new Error(`Derived Attributes: cannot read HIGH_LOAD / VERY_HIGH_LOAD from "${usedIn}"`);
  if (!eHigh || !eVery) throw new Error(`Engine Check: cannot read high / very high load from "${loadText}"`);
  if (dHigh[1] !== eHigh[1] || dVery[1] !== eVery[1]) {
    throw new Error(`load thresholds disagree: Derived Attributes ${dHigh[1]}/${dVery[1]}, Engine Check ${eHigh[1]}/${eVery[1]}`);
  }
  return { multistep_bands, difficulty_points, load_thresholds: { high: Number(dHigh[1]), very_high: Number(dVery[1]) } };
}

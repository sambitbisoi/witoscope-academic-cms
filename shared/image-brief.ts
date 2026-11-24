// Images PR (DL-040; Sambit, 24 Nov 2026): the structured image brief, shared by the browser, the image service
// (Pages Function) and gen:import. Pure: no network. The SQL check cms_image_brief_problem (0049) applies the same rules.
//   shown · style · must_not_show · layout (row4 | grid2x2 | single) · labels [{label A–D, points_to, x?, y?}]
// The CMS draws the letters A–D itself (labels overlay): the picture is generated WITHOUT any letters or words.

export type ImageLayout = 'row4' | 'grid2x2' | 'single';
export const LAYOUTS: ImageLayout[] = ['row4', 'grid2x2', 'single'];
export const LAYOUT_LABEL: Record<ImageLayout, string> = { row4: 'Four panels in a row', grid2x2: 'Four panels, 2 × 2', single: 'One scene (place the labels)' };
export interface BriefLabel { label: 'A' | 'B' | 'C' | 'D'; points_to: string; /** a placed label (single scene), 0–1 of the width / height */ x?: number | null; y?: number | null }
export interface ImageBrief { shown: string; style?: string | null; must_not_show?: string | null; layout?: ImageLayout | null; labels?: BriefLabel[] }

/** Why a brief is not valid (null = valid). Same rules as the database. */
export function briefProblem(b: unknown): string | null {
  if (b === null || b === undefined) return null;
  if (typeof b !== 'object' || Array.isArray(b)) return 'the brief must be an object';
  const x = b as Record<string, unknown>;
  if (typeof x.shown !== 'string' || !x.shown.trim()) return 'the brief needs "shown"';
  if (x.layout !== undefined && x.layout !== null && !LAYOUTS.includes(x.layout as ImageLayout)) return 'layout is row4, grid2x2 or single';
  if (x.labels !== undefined && !Array.isArray(x.labels)) return 'labels must be a list';
  const seen = new Set<string>();
  for (const l of (x.labels ?? []) as Record<string, unknown>[]) {
    if (typeof l?.label !== 'string' || !/^[A-D]$/.test(l.label)) return 'each label is A, B, C or D';
    if (seen.has(l.label)) return `label ${l.label} appears twice`;
    seen.add(l.label);
    if (typeof l.points_to !== 'string' || !l.points_to.trim()) return `label ${l.label} needs a target`;
    for (const k of ['x', 'y'] as const) if (l[k] !== undefined && l[k] !== null && (typeof l[k] !== 'number' || (l[k] as number) < 0 || (l[k] as number) > 1)) return 'label positions are 0–1';
  }
  return null;
}

/** The brief as one line (stored in figure_description; the same text as cms_image_brief_text). */
export function briefText(b: ImageBrief): string {
  const labels = [...(b.labels ?? [])].sort((x, y) => x.label.localeCompare(y.label)).map((l) => `${l.label} -> ${l.points_to}`).join('; ');
  return [`Shown: ${b.shown.trim()}`, b.style?.trim() ? `Style: ${b.style.trim()}` : null, b.must_not_show?.trim() ? `Must NOT show: ${b.must_not_show.trim()}` : null,
    labels ? `Labels: ${labels}` : null].filter(Boolean).join(' · ');
}

/** Fallback only (the Science session writes `layout`): four labelled things "in a row" → row4; "boxes"/"grid" → grid2x2;
 *  labels pointing at parts of one thing → single; no labels → single. */
export function inferLayout(b: Pick<ImageBrief, 'shown' | 'labels'>): ImageLayout {
  const s = b.shown.toLowerCase();
  if (!(b.labels ?? []).length) return 'single';
  if (/\b(2\s*[x×]\s*2|grid|four (equal )?boxes|boxes)\b/.test(s)) return 'grid2x2';
  if (/\bin a row\b|\bside by side\b|\bfour (separate|small)\b/.test(s)) return 'row4';
  if (/\bpoint(s|ing)? to\b|\blines?\b.*\bparts?\b/.test(s)) return 'single';
  return 'row4';
}
export const layoutOf = (b: ImageBrief): ImageLayout => b.layout ?? inferLayout(b);

/** A brief from free text (questions imported before structured briefs): "Shown: … · Style: … · Must NOT show: … · Labels: A -> …",
 *  or plain text as "shown". */
export function briefFromText(text: string): ImageBrief {
  const part = (name: string) => new RegExp(`${name}:\\s*(.*?)(?=\\s·\\s(?:Shown|Style|Must NOT show|Labels):|$)`, 'is').exec(text)?.[1]?.trim() ?? null;
  const shown = part('Shown');
  if (!shown) return { shown: text.trim(), labels: [] };
  const labels = (part('Labels') ?? '').split(';').map((x) => /^\s*([A-D])\s*->\s*(.+?)\s*$/.exec(x)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ label: m[1] as BriefLabel['label'], points_to: m[2]! }));
  return { shown, style: part('Style'), must_not_show: part('Must NOT show'), labels };
}

/** The prompt for an image model: our own wording only (book rule). The picture has NO letters or words: the CMS draws A–D. */
export function imagePrompt(b: ImageBrief): string {
  const layout = layoutOf(b);
  const labels = [...(b.labels ?? [])].sort((x, y) => x.label.localeCompare(y.label));
  const panels = layout === 'row4' ? 'Four equal panels side by side, left to right, with a thin gap between them.'
    : layout === 'grid2x2' ? 'Four equal panels in a 2 × 2 grid (top left, top right, bottom left, bottom right), with a thin gap between them.' : 'One scene.';
  const order = layout === 'single' ? (labels.length ? `The scene must clearly show: ${labels.map((l) => l.points_to).join('; ')}.` : '')
    : labels.length ? `Panel contents in order: ${labels.map((l, i) => `${i + 1}) ${l.points_to}`).join('; ')}.` : '';
  return [
    'A clear, friendly picture for a children\'s science question (ages 6–12), Indian everyday context.',
    panels, `What it shows: ${b.shown.trim()}`, order,
    b.style?.trim() ? `Style: ${b.style.trim()}.` : 'Style: simple flat colour drawing, clean outlines, plain background.',
    `Do NOT show: ${[b.must_not_show?.trim(), 'any letters, numbers, words, labels or captions (labels are added later)', 'anything that marks or singles out one answer'].filter(Boolean).join('; ')}.`,
  ].filter(Boolean).join('\n');
}

/** Where the CMS draws each letter, as fractions of the picture (top-left corner of each panel, or the placed point). */
export function labelPositions(b: ImageBrief): { label: string; x: number; y: number; placed: boolean }[] {
  const layout = layoutOf(b);
  const labels = [...(b.labels ?? [])].sort((x, y) => x.label.localeCompare(y.label));
  return labels.map((l, i) => {
    if (layout === 'row4') return { label: l.label, x: (i + 0.08) / 4, y: 0.08, placed: true };
    if (layout === 'grid2x2') return { label: l.label, x: ((i % 2) + 0.08) / 2, y: (Math.floor(i / 2) + 0.1) / 2, placed: true };
    return { label: l.label, x: l.x ?? 0, y: l.y ?? 0, placed: l.x != null && l.y != null };
  });
}
/** A single scene needs every label placed before the labelled picture can be made. */
export const labelsToPlace = (b: ImageBrief) => labelPositions(b).filter((p) => !p.placed).map((p) => p.label);
/** The picture size the service asks for: wide for a row of four, square otherwise. */
export const imageSize = (b: ImageBrief) => (layoutOf(b) === 'row4' ? { width: 2048, height: 768 } : { width: 1536, height: 1536 });

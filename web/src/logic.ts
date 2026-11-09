// Pure helpers for Browse (no React, no network): unit-tested in tests/browse-logic.test.ts.

export type Subject = 'math' | 'science' | 'grammar';
export const SUBJECTS: { id: Subject; label: string; prefix: string }[] = [
  { id: 'math', label: 'Math', prefix: 'M' },
  { id: 'science', label: 'Science', prefix: 'S' },
  { id: 'grammar', label: 'English Grammar', prefix: 'G' },
];
export const subjectLabel = (s: string) => SUBJECTS.find((x) => x.id === s)?.label ?? s;
export const subjectOfChapter = (chapterId: string): Subject =>
  (SUBJECTS.find((x) => chapterId.startsWith(`${x.prefix}C`))?.id ?? 'math');

// ---------------------------------------------------------------- routes (hash)
export type Route =
  | { name: 'home'; grade: string | null }
  | { name: 'browse'; subject: Subject; cls: string; topic: string | null; q: string | null; v: number | null; tab: 'types' | 'concepts' | 'sources'; edit: boolean }
  | { name: 'review' }
  | { name: 'generate'; q: string | null; set: string | null; topic: string | null }
  | { name: 'run'; id: number }
  | { name: 'question'; id: string }
  | { name: 'imports' }
  | { name: 'import'; id: number }
  | { name: 'notfound' };

export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  const p = path.split('/').filter(Boolean).map(decodeURIComponent);
  const qs = new URLSearchParams(query);
  if (p.length === 0) return { name: 'home', grade: qs.get('grade') };
  if (p[0] === 'imports') return p[1] && /^\d+$/.test(p[1]) ? { name: 'import', id: Number(p[1]) } : { name: 'imports' };
  if (p[0] === 'q' && p[1]) return { name: 'question', id: p[1] };
  if (p[0] === 'review') return { name: 'review' };
  if (p[0] === 'generate') return { name: 'generate', q: qs.get('q'), set: qs.get('set'), topic: qs.get('topic') };
  if (p[0] === 'run' && p[1] && /^\d+$/.test(p[1])) return { name: 'run', id: Number(p[1]) };
  if (p[0] === 'browse' && SUBJECTS.some((s) => s.id === p[1])) {
    const cls = p[2] && /^([1-6]|all)$/.test(p[2]) ? p[2] : 'all';
    const v = qs.get('v');
    return { name: 'browse', subject: p[1] as Subject, cls, topic: p[3] ?? null, q: qs.get('q'), v: v && /^\d+$/.test(v) ? Number(v) : null,
      tab: qs.get('tab') === 'concepts' ? 'concepts' : qs.get('tab') === 'sources' ? 'sources' : 'types', edit: qs.get('edit') === '1' };
  }
  return { name: 'notfound' };
}

export function browseHash(r: { subject: string; cls: string; topic?: string | null; q?: string | null; v?: number | null; tab?: string; edit?: boolean }): string {
  const parts = ['#/browse', r.subject, r.cls, ...(r.topic ? [encodeURIComponent(r.topic)] : [])].join('/');
  const qs = new URLSearchParams();
  if (r.q) qs.set('q', r.q);
  if (r.v) qs.set('v', String(r.v));
  if (r.tab && r.tab !== 'types') qs.set('tab', r.tab);
  if (r.edit && r.q) qs.set('edit', '1');
  const s = qs.toString();
  return s ? `${parts}?${s}` : parts;
}

// ---------------------------------------------------------------- coverage
export interface TopicStats { n_questions: number; n_simple: number; n_medium: number; n_complex: number; n_gold: number; n_draft: number; n_in_review: number; n_approved: number }

/** "3 Qs · S1 M2 C0" — production questions only; gold is shown separately. */
export function countsLabel(s: TopicStats | undefined): string {
  if (!s || s.n_questions === 0) return s?.n_gold ? `no questions · gold ${s.n_gold}` : 'no questions';
  const base = `${s.n_questions} Q${s.n_questions === 1 ? '' : 's'} · S${s.n_simple} M${s.n_medium} C${s.n_complex}`;
  return s.n_gold ? `${base} · gold ${s.n_gold}` : base;
}

/**
 * [guess, plan §4] A gap is only flagged for a topic that HAS production questions
 * but is missing a difficulty level; empty topics are "no questions", not gaps.
 */
export function gapLabel(s: TopicStats | undefined): string | null {
  if (!s || s.n_questions === 0) return null;
  const missing = [s.n_simple ? null : 'Simple', s.n_medium ? null : 'Medium', s.n_complex ? null : 'Complex'].filter(Boolean);
  return missing.length ? `no ${missing.join(', no ')}` : null;
}

// ---------------------------------------------------------------- status
export const STATUS_LABEL: Record<string, string> = { draft: 'Draft', in_review: 'In review', approved: 'Approved', rejected: 'Rejected' };
export function statusLabel(q: { status: string; current_version: number; approved_version: number | null; retired_at?: string | null }): string {
  if (q.retired_at) return 'Retired';
  const cur = STATUS_LABEL[q.status] ?? q.status;
  if (q.approved_version && q.approved_version !== q.current_version) return `Approved v${q.approved_version} · ${cur} v${q.current_version}`;
  return cur;
}

// ---------------------------------------------------------------- grouping
export interface ListQuestion {
  question_id: string; bank: string; typical_set_id: string | null; pattern_id: string | null; math_difficulty: string | null;
  status: string; text: string; current_version: number; approved_version: number | null; retired_at: string | null;
}
export interface SetGroup<Q> { setId: string | null; patterns: { patternId: string | null; questions: Q[] }[]; count: number }

const DIFF_ORDER: Record<string, number> = { Simple: 0, Medium: 1, Complex: 2 };
const byDifficulty = <Q extends ListQuestion>(a: Q, b: Q) =>
  (DIFF_ORDER[a.math_difficulty ?? ''] ?? 9) - (DIFF_ORDER[b.math_difficulty ?? ''] ?? 9) || a.question_id.localeCompare(b.question_id);

/**
 * "By question type": typical sets (parent-facing) with patterns (generation
 * templates) under them. Sets in `knownSets` come first in that order, even when
 * empty; questions without a set go last. Within a pattern: Simple → Complex.
 */
export function groupBySet<Q extends ListQuestion>(questions: Q[], knownSets: string[]): SetGroup<Q>[] {
  const sets = new Map<string | null, Map<string | null, Q[]>>();
  for (const id of knownSets) sets.set(id, new Map());
  for (const q of questions) {
    if (!sets.has(q.typical_set_id)) sets.set(q.typical_set_id, new Map());
    const pats = sets.get(q.typical_set_id)!;
    pats.set(q.pattern_id, [...(pats.get(q.pattern_id) ?? []), q]);
  }
  const ordered = [...sets.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    const ia = knownSets.indexOf(a), ib = knownSets.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
  });
  return ordered.map((setId) => {
    const pats = sets.get(setId)!;
    const patterns = [...pats.entries()]
      .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
      .map(([patternId, qs]) => ({ patternId, questions: [...qs].sort(byDifficulty) }));
    return { setId, patterns, count: patterns.reduce((n, p) => n + p.questions.length, 0) };
  });
}

export interface Filters { difficulty: string; status: string; bank: string }
export const NO_FILTERS: Filters = { difficulty: 'all', status: 'all', bank: 'all' };
export function applyFilters<Q extends ListQuestion>(qs: Q[], f: Filters): Q[] {
  return qs.filter((q) =>
    (f.difficulty === 'all' || q.math_difficulty === f.difficulty)
    && (f.status === 'all' || (f.status === 'retired' ? !!q.retired_at : q.status === f.status && !q.retired_at))
    && (f.bank === 'all' || q.bank === f.bank));
}

// ---------------------------------------------------------------- signature (v10)
export interface VersionRow {
  math_difficulty: string | null; is_pure_fact: boolean | null; reading: number | null; has_irrelevant_info: boolean | null;
  steps: number | null; multistep_band: number | null; working_memory: number | null; inhibition: number | null; visual: number | null;
  strategy: number | null; tier: string | null; strategy_type: string | null; strategy_type_2: string | null; strategy_other_note: string | null;
  insight_id: string | null; load: number | null; load_driver: string | null; style: string | null; trap_level: number | null;
  is_isolating: boolean | null; difficulty_points: number | null;
}
const yesNo = (b: boolean | null) => (b === null ? '—' : b ? 'Yes' : 'No');
const n = (x: number | null) => (x === null ? '—' : String(x));
const DRIVER: Record<string, string> = { reading: 'reading', multi_step: 'multi-step', memory: 'memory' };
const TRAP: Record<number, string> = { 0: '0 · none', 1: '1 · shortcut', 2: '2 · misconception' };

/** Authored v10 signature, in the v10 order, with the derived value next to its source. */
export function signatureRows(v: VersionRow, insightName?: string | null): { k: string; v: string }[] {
  const strategyTypes = [v.strategy_type, v.strategy_type_2].filter(Boolean).join(' + ');
  return [
    { k: 'Math difficulty', v: v.math_difficulty ?? '—' },
    { k: 'Reading', v: n(v.reading) },
    { k: 'Steps', v: v.steps === null ? '—' : `${v.steps} → band ${n(v.multistep_band)}` },
    { k: 'Working memory', v: n(v.working_memory) },
    { k: 'Inhibition', v: n(v.inhibition) },
    { k: 'Visual', v: n(v.visual) },
    { k: 'Strategy', v: v.strategy === null ? '—' : `${v.strategy} → ${v.tier ?? '—'}` },
    { k: 'Strategy type', v: strategyTypes ? strategyTypes + (v.strategy_other_note ? ` (${v.strategy_other_note})` : '') : '—' },
    { k: 'Insight', v: v.insight_id ? (insightName ? `${v.insight_id} · ${insightName}` : v.insight_id) : '—' },
    { k: 'Pure fact', v: yesNo(v.is_pure_fact) },
    { k: 'Irrelevant info', v: yesNo(v.has_irrelevant_info) },
  ];
}

/** Derived fields (design §4), computed on save. */
export function derivedRows(v: VersionRow): { k: string; v: string }[] {
  return [
    { k: 'Load', v: v.load === null ? '—' : `${v.load}${v.load_driver ? ` · ${DRIVER[v.load_driver] ?? v.load_driver}` : ''}` },
    { k: 'Style', v: v.style ?? '—' },
    { k: 'Tier', v: v.tier ?? '—' },
    { k: 'Trap level', v: v.trap_level === null ? '—' : (TRAP[v.trap_level] ?? String(v.trap_level)) },
    { k: 'Isolating', v: yesNo(v.is_isolating) },
    { k: 'Difficulty points', v: n(v.difficulty_points) },
  ];
}

export const TAG_LABEL: Record<string, string> = {
  misconception: 'Misconception', concept_error: 'Concept error', shortcut: 'Shortcut', partial: 'Partial', lost_step: 'Lost step',
  used_irrelevant: 'Used irrelevant info', misread: 'Misread', unit_slip: 'Unit slip', implausible: 'Implausible',
};

/** Keep only characters that are safe inside a PostgREST or() filter. */
export const safeSearch = (s: string) => s.replace(/[^\p{L}\p{N}\s\-_.]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

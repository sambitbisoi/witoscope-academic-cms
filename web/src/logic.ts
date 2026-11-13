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
  | { name: 'browse'; subject: Subject; cls: string; strand: string | null; ch: string | null; topic: string | null; q: string | null; v: number | null; tab: 'types' | 'concepts' | 'sources'; edit: boolean }
  | { name: 'review' }
  | { name: 'proposed'; kind: string | null }
  | { name: 'map'; tab: 'topics' | 'sources'; cls: string; subject: string; strand: string | null; ch: string | null; show: MapShow; q: string; chapters: boolean; topics: boolean }
  | { name: 'generate'; q: string | null; set: string | null; topic: string | null }
  | { name: 'run'; id: number }
  | { name: 'model-check'; id: number | null }
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
  if (p[0] === 'proposed') return { name: 'proposed', kind: qs.get('kind') };
  if (p[0] === 'map') {
    const show = qs.get('show');
    return { name: 'map', tab: p[1] === 'sources' ? 'sources' : 'topics', cls: /^[1-6]$/.test(qs.get('cls') ?? '') ? qs.get('cls')! : 'all',
      subject: SUBJECTS.some((x) => x.id === qs.get('subject')) ? qs.get('subject')! : 'all', strand: strandParam(qs.get('strand')), ch: qs.get('ch'),
      show: MAP_SHOWS.find((x) => x === show) ?? 'all', q: qs.get('q') ?? '', chapters: qs.get('chapters') !== '0', topics: qs.get('topics') !== '0' };
  }
  if (p[0] === 'generate') return { name: 'generate', q: qs.get('q'), set: qs.get('set'), topic: qs.get('topic') };
  if (p[0] === 'run' && p[1] && /^\d+$/.test(p[1])) return { name: 'run', id: Number(p[1]) };
  if (p[0] === 'model-check') return { name: 'model-check', id: p[1] && /^\d+$/.test(p[1]) ? Number(p[1]) : null };
  if (p[0] === 'browse' && SUBJECTS.some((s) => s.id === p[1])) {
    const cls = p[2] && /^([1-6]|all)$/.test(p[2]) ? p[2] : 'all';
    const v = qs.get('v');
    const ch = qs.get('ch');
    return { name: 'browse', subject: p[1] as Subject, cls, strand: strandParam(qs.get('strand')), ch: ch && /^(MC|SC|GC)[0-9]{2}$/.test(ch) ? ch : null, topic: p[3] ?? null, q: qs.get('q'), v: v && /^\d+$/.test(v) ? Number(v) : null,
      tab: qs.get('tab') === 'concepts' ? 'concepts' : qs.get('tab') === 'sources' ? 'sources' : 'types', edit: qs.get('edit') === '1' };
  }
  return { name: 'notfound' };
}

const strandParam = (x: string | null) => (x && /^(math|science|grammar)-[A-Z]{2,4}$/.test(x) ? x : null);

export function browseHash(r: { subject: string; cls: string; strand?: string | null; ch?: string | null; topic?: string | null; q?: string | null; v?: number | null; tab?: string; edit?: boolean }): string {
  const parts = ['#/browse', r.subject, r.cls, ...(r.topic ? [encodeURIComponent(r.topic)] : [])].join('/');
  const qs = new URLSearchParams();
  if (r.strand) qs.set('strand', r.strand);
  if (r.ch) qs.set('ch', r.ch);
  if (r.q) qs.set('q', r.q);
  if (r.v) qs.set('v', String(r.v));
  if (r.tab && r.tab !== 'types') qs.set('tab', r.tab);
  if (r.edit && r.q) qs.set('edit', '1');
  const s = qs.toString();
  return s ? `${parts}?${s}` : parts;
}

/** R2: which topic–class links the curriculum map shows (by role, R1). */
export const MAP_SHOWS = ['all', 'core', 'lower', 'higher', 'extra'] as const;
export type MapShow = (typeof MAP_SHOWS)[number];
export function mapHash(r: { tab?: string; cls: string; subject: string; strand?: string | null; ch: string | null; show: string; q: string; chapters?: boolean; topics?: boolean }): string {
  const qs = new URLSearchParams();
  if (r.cls !== 'all') qs.set('cls', r.cls);
  if (r.subject !== 'all') qs.set('subject', r.subject);
  if (r.strand) qs.set('strand', r.strand);
  if (r.ch) qs.set('ch', r.ch);
  if (r.show !== 'all') qs.set('show', r.show);
  if (r.q) qs.set('q', r.q);
  if (r.chapters === false) qs.set('chapters', '0');
  if (r.topics === false) qs.set('topics', '0');
  const s = qs.toString();
  return `#/map${r.tab === 'sources' ? '/sources' : ''}${s ? `?${s}` : ''}`;
}

// ---------------------------------------------------------------- R1: roles of topic–class links
/** core = the topic's home class; lower = it comes from a lower class; higher = from a higher class. */
export type Role = 'core' | 'lower' | 'higher';
export const roleOf = (homeClass: number, cls: number): Role => (homeClass === cls ? 'core' : homeClass < cls ? 'lower' : 'higher');
export const roleLabel = (homeClass: number, cls: number) => (homeClass === cls ? 'core' : `from Class ${homeClass}`);
export const showMatches = (show: MapShow, role: Role) =>
  show === 'all' || (show === 'extra' ? role !== 'core' : show === role);

// ---------------------------------------------------------------- review status per topic (13 Nov 2026)
export type ReviewStatus = 'not_started' | 'in_progress' | 'done';
export const REVIEW_STATUSES: { id: ReviewStatus; label: string; icon: string }[] = [
  { id: 'not_started', label: 'Not started', icon: '○' },
  { id: 'in_progress', label: 'In progress', icon: '◐' },
  { id: 'done', label: 'Done', icon: '✓' },
];
export type ReviewFilter = 'all' | ReviewStatus;
export interface RollUp { state: 'done' | 'partial' | 'none'; done: number; inProgress: number; total: number }
/**
 * Roll-up for a chapter or strand within one class: only its CORE topics for that class count
 * (extra rows from a lower / higher class, retired topics and Achievers rows are ignored).
 * done = every counted topic done; partial = at least one in progress or done but not all done;
 * none = nothing started (or nothing to count).
 */
export function rollUp(items: { status: ReviewStatus; core: boolean; active: boolean; achievers?: boolean }[]): RollUp {
  const counted = items.filter((x) => x.core && x.active && !x.achievers);
  const done = counted.filter((x) => x.status === 'done').length;
  const inProgress = counted.filter((x) => x.status === 'in_progress').length;
  const total = counted.length;
  const state = total > 0 && done === total ? 'done' : done + inProgress > 0 ? 'partial' : 'none';
  return { state, done, inProgress, total };
}
export const rollUpTitle = (r: RollUp) =>
  r.total === 0 ? 'No core topics in this class' : `Reviewed ${r.done} of ${r.total} core topic${r.total === 1 ? '' : 's'}${r.inProgress ? ` · ${r.inProgress} in progress` : ''}`;
export const matchesReview = (f: ReviewFilter, s: ReviewStatus) => f === 'all' || f === s;

// ---------------------------------------------------------------- coverage
export interface TopicStats { n_questions: number; n_simple: number; n_medium: number; n_complex: number; n_gold: number; n_draft: number; n_in_review: number; n_approved: number }

/** "Simple 1 · Medium 2 · Complex 0" (U6: spelled out, not S1 M2 C0). */
export const mixLabel = (m: { simple: number; medium: number; complex: number }) => `Simple ${m.simple} · Medium ${m.medium} · Complex ${m.complex}`;

/** "3 Qs · Simple 1 · Medium 2 · Complex 0" — production questions only; gold is shown separately. */
export function countsLabel(s: TopicStats | undefined): string {
  if (!s || s.n_questions === 0) return s?.n_gold ? `no questions · gold ${s.n_gold}` : 'no questions';
  const base = `${s.n_questions} Q${s.n_questions === 1 ? '' : 's'} · ${mixLabel({ simple: s.n_simple, medium: s.n_medium, complex: s.n_complex })}`;
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
/** D6 (12 Nov 2026): in_review is shown as "Needs review" (a flag with an optional note). */
export const STATUS_LABEL: Record<string, string> = { draft: 'Draft', in_review: 'Needs review', approved: 'Approved', rejected: 'Rejected' };
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

export interface Filters { difficulty: string; status: string; bank: string; flag?: FlagFilter }
export const NO_FILTERS: Filters = { difficulty: 'all', status: 'all', bank: 'all', flag: 'all' };
export function applyFilters<Q extends ListQuestion>(qs: Q[], f: Filters): Q[] {
  return qs.filter((q) =>
    (f.difficulty === 'all' || q.math_difficulty === f.difficulty)
    && (f.status === 'all' || (f.status === 'retired' ? !!q.retired_at : q.status === f.status && !q.retired_at))
    && (f.bank === 'all' || q.bank === f.bank)
    && matchesFlag(f.flag ?? 'all', q as Flagged));
}

// ---------------------------------------------------------------- added / uploaded questions (13 Nov 2026)
/** Flags of a question added by hand or uploaded (Browse and Review filter on them). */
export interface Flagged { created_from?: string | null; attributes_pending?: boolean | null; originality_pending?: boolean | null; image_pending?: boolean | null }
export type FlagFilter = 'all' | 'manual' | 'upload' | 'attributes' | 'image' | 'originality';
export const FLAG_FILTERS: [FlagFilter, string][] = [
  ['all', 'Flags: all'], ['manual', 'Manual'], ['upload', 'Uploaded'], ['attributes', 'Attributes pending'], ['image', 'Image pending'], ['originality', 'Originality pending'],
];
export function matchesFlag(f: FlagFilter, q: Flagged): boolean {
  switch (f) {
    case 'manual': return q.created_from === 'manual';
    case 'upload': return q.created_from === 'upload';
    case 'attributes': return !!q.attributes_pending;
    case 'image': return !!q.image_pending;
    case 'originality': return !!q.originality_pending;
    default: return true;
  }
}

/** The formats a question added by hand or uploaded may have (no Multi-part). */
export const ADD_FORMATS = ['MCQ-4', 'MCQ-3', 'True/False', 'Typed-number', 'Typed-decimal', 'Typed-fraction', 'Typed-text'] as const;
export const DIFFICULTIES = ['Simple', 'Medium', 'Complex'] as const;
/** A new question as the form or one Excel row gives it (the topic is fixed by where you are). */
export interface NewQuestion {
  row?: number; text: string; format: string; options: string[]; correct: string; level: number | null; picture_needed: boolean | null;
  figure_description?: string; solution?: string; hints?: string[]; wrong_answers?: { value: string; why: string }[]; concepts?: string[];
  typical_set_id?: string; pattern_id?: string; setting_id?: string; math_difficulty?: string; source_refs?: string[]; author_notes?: string;
}
/** Missing or broken MANDATORY fields only (no similarity, duplicate or quality checks). */
export function mandatoryErrors(q: NewQuestion): string[] {
  const e: string[] = [];
  if (!q.text?.trim()) e.push('question text is missing');
  if (!q.format?.trim()) e.push('format is missing');
  else if (!(ADD_FORMATS as readonly string[]).includes(q.format)) e.push(`format "${q.format}" is not allowed (${ADD_FORMATS.join(', ')})`);
  if (!q.correct?.trim()) e.push('correct answer is missing');
  const n = q.format === 'MCQ-4' ? 4 : q.format === 'MCQ-3' ? 3 : 0;
  const opts = q.options.map((o) => o.trim()).filter(Boolean);
  if (n && opts.length !== n) e.push(`${q.format} needs ${n} options (has ${opts.length})`);
  if (n && opts.length === n && q.correct?.trim() && !opts.includes(q.correct.trim())) e.push('the correct answer must be one of the options');
  if (q.format === 'True/False' && q.correct?.trim() && !['True', 'False'].includes(q.correct.trim())) e.push('a True/False answer must be True or False');
  if (q.level === null || !Number.isInteger(q.level) || q.level < 1 || q.level > 6) e.push('level must be 1–6');
  if (q.picture_needed === null) e.push('"Picture needed" must be Y or N');
  if (q.picture_needed && !q.figure_description?.trim()) e.push('a picture is needed, so the figure description is required');
  return e;
}

/** The Excel template's columns, in order (the topic is fixed by where you upload, so there is no topic column). */
export const UPLOAD_COLUMNS: { key: string; header: string; required: boolean; help: string }[] = [
  { key: 'text', header: 'Question text', required: true, help: 'The question as the child reads it.' },
  { key: 'format', header: 'Format', required: true, help: `One of: ${'MCQ-4, MCQ-3, True/False, Typed-number, Typed-decimal, Typed-fraction, Typed-text'}.` },
  { key: 'a', header: 'Option A', required: false, help: 'MCQ only: MCQ-4 needs A–D, MCQ-3 needs A–C. True/False fills its options itself.' },
  { key: 'b', header: 'Option B', required: false, help: 'MCQ only.' },
  { key: 'c', header: 'Option C', required: false, help: 'MCQ only.' },
  { key: 'd', header: 'Option D', required: false, help: 'MCQ-4 only.' },
  { key: 'correct', header: 'Correct answer', required: true, help: 'MCQ: the text of the right option (or just A, B, C or D). True/False: True or False. Typed: the answer.' },
  { key: 'level', header: 'Level', required: true, help: 'The class level 1–6 the question is for; the template fills in the topic\'s home class. Check it.' },
  { key: 'picture', header: 'Picture needed (Y/N)', required: true, help: 'Y if the question needs a picture; then the figure description is required.' },
  { key: 'figure', header: 'Figure description', required: false, help: 'Required when Picture needed is Y: what the picture shows (our own words).' },
  { key: 'solution', header: 'Solution', required: false, help: 'The worked solution.' },
  { key: 'hint1', header: 'Hint 1', required: false, help: 'Up to three hints, gentlest first.' },
  { key: 'hint2', header: 'Hint 2', required: false, help: '' },
  { key: 'hint3', header: 'Hint 3', required: false, help: '' },
  { key: 'wrong', header: 'Wrong-answer notes', required: false, help: 'One per line or separated by ";", as  wrong answer: why  (e.g.  102: compared the last digit only).' },
  { key: 'concepts', header: 'Concepts', required: false, help: 'Concept IDs of this topic, separated by commas (e.g. G6-FRC-C1). Unknown IDs are left out with a warning.' },
  { key: 'set', header: 'Typical set', required: false, help: 'Typical set ID of this topic (e.g. TS-G6-FRAC-LEFT). Unknown IDs are left out with a warning.' },
  { key: 'pattern', header: 'Pattern', required: false, help: 'Pattern ID of that typical set. Unknown IDs are left out with a warning.' },
  { key: 'setting', header: 'Setting', required: false, help: 'Setting ID (the story or context). Unknown IDs are left out with a warning.' },
  { key: 'difficulty', header: 'Difficulty guess', required: false, help: 'Simple, Medium or Complex (a guess; the attributes are evaluated later).' },
  { key: 'source', header: 'Source citation', required: false, help: 'A citation only (book item ID such as N6-01-004, or book · class · chapter · page · item). Never paste book text.' },
  { key: 'notes', header: 'Notes', required: false, help: 'Anything else for the reviewer.' },
];
export const EXAMPLE_MARK = 'EXAMPLE';

/** IDs the topic knows, to check an upload's optional IDs against. */
export interface UploadLookups { concepts: Set<string>; sets: Set<string>; patterns: Map<string, string>; settings: Set<string>; sourceItems: Set<string> }
export interface ParsedRow { row: number; q: NewQuestion | null; errors: string[]; warnings: string[]; example?: boolean }
const cellText = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
const splitList = (s: string, sep: RegExp) => s.split(sep).map((x) => x.trim()).filter(Boolean);

/** One Excel row (values keyed by column key) → a new question, its mandatory-field errors and its warnings. */
export function parseUploadRow(row: number, cells: Record<string, unknown>, look: UploadLookups): ParsedRow {
  const c = (k: string) => cellText(cells[k]);
  if (c('notes').toUpperCase().startsWith(EXAMPLE_MARK)) return { row, q: null, errors: [], warnings: ['the example row; left out'], example: true };
  const warnings: string[] = [];
  const format = c('format');
  const tf = format.toLowerCase() === 'true/false';
  const fmt = tf ? 'True/False' : (ADD_FORMATS.find((f) => f.toLowerCase() === format.toLowerCase()) ?? format);
  const options = fmt === 'True/False' ? ['True', 'False'] : fmt === 'MCQ-4' ? ['a', 'b', 'c', 'd'].map(c) : fmt === 'MCQ-3' ? ['a', 'b', 'c'].map(c) : [];
  if (!fmt.startsWith('MCQ') && ['a', 'b', 'c', 'd'].some((k) => c(k))) warnings.push(`options are ignored for ${fmt || 'this format'}`);
  let correct = c('correct');
  if (fmt.startsWith('MCQ') && /^[A-D]$/i.test(correct)) { const i = correct.toUpperCase().charCodeAt(0) - 65; if (options[i]) correct = options[i]!; }
  if (fmt === 'True/False') correct = /^t(rue)?$/i.test(correct) ? 'True' : /^f(alse)?$/i.test(correct) ? 'False' : correct;
  const lv = c('level');
  const level = /^[1-6]$/.test(lv) ? Number(lv) : lv === '' ? null : NaN;
  const pic = c('picture').toUpperCase();
  const picture_needed = ['Y', 'YES'].includes(pic) ? true : ['N', 'NO'].includes(pic) ? false : null;
  const known = <T extends string>(ids: string[], ok: (id: T) => boolean, what: string) => ids.filter((id) => { const good = ok(id as T); if (!good) warnings.push(`${what} ${id} is not known here; left out`); return good; });
  const concepts = known(splitList(c('concepts'), /[,;\n]/), (id) => look.concepts.has(id), 'concept');
  const setId = c('set') && known([c('set')], (id) => look.sets.has(id), 'typical set')[0];
  let patternId = c('pattern') && known([c('pattern')], (id) => look.patterns.has(id), 'pattern')[0];
  if (patternId && setId && look.patterns.get(patternId) !== setId) { warnings.push(`pattern ${patternId} belongs to another typical set; left out`); patternId = ''; }
  const settingId = c('setting') && known([c('setting')], (id) => look.settings.has(id), 'setting')[0];
  const diff = c('difficulty');
  const math_difficulty = DIFFICULTIES.find((d) => d.toLowerCase() === diff.toLowerCase());
  if (diff && !math_difficulty) warnings.push(`difficulty guess "${diff}" is not Simple, Medium or Complex; left out`);
  const src = c('source');
  const isItem = !!src && look.sourceItems.has(src);
  const notes = [c('notes'), src && !isItem ? `Source: ${src}` : ''].filter(Boolean).join('\n');
  const wrong_answers = splitList(c('wrong'), /[;\n]/).map((w) => { const i = w.indexOf(':'); return i > 0 ? { value: w.slice(0, i).trim(), why: w.slice(i + 1).trim() } : { value: w, why: '' }; });
  const q: NewQuestion = {
    row, text: c('text'), format: fmt, options, correct, level: Number.isNaN(level) ? null : level, picture_needed,
    figure_description: c('figure') || undefined, solution: c('solution') || undefined, hints: [c('hint1'), c('hint2'), c('hint3')].filter(Boolean),
    wrong_answers, concepts, typical_set_id: setId || undefined, pattern_id: patternId || undefined, setting_id: settingId || undefined,
    math_difficulty, source_refs: isItem ? [src] : [], author_notes: notes || undefined,
  };
  let errors = mandatoryErrors(q);
  if (Number.isNaN(level)) errors = [...errors.filter((e) => !e.startsWith('level')), `level "${lv}" is not 1–6`];
  return { row, q, errors: [...new Set(errors)], warnings };
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

// ---------------------------------------------------------------- U8: rows that look the same
/**
 * Row texts that would look identical when cut off: for each text that shares a long
 * opening with another text in the list, show "…" + the part from where they differ
 * (backed up to a word start). Texts that are unique early on are returned unchanged.
 */
export function distinctTexts(texts: string[], minShared = 40): string[] {
  const common = (a: string, b: string) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
  return texts.map((t, i) => {
    let shared = 0;
    texts.forEach((o, j) => { if (j !== i) shared = Math.max(shared, common(t, o)); });
    if (shared < minShared || shared >= t.length) return t;
    let cut = shared;
    while (cut > 0 && !/\s/.test(t[cut - 1]!)) cut--;
    const start = Math.max(0, cut - 12);
    let from = start;
    while (from > 0 && !/\s/.test(t[from - 1]!)) from--;
    return `…${t.slice(from)}`;
  });
}

/** How many texts in the list have exactly this wording (U8: identical stems differ only in the figure or answer). */
export const sameWording = (texts: string[]) => { const n = new Map<string, number>(); for (const t of texts) n.set(t, (n.get(t) ?? 0) + 1); return texts.map((t) => n.get(t)!); };

// ---------------------------------------------------------------- U9: concept involvement
export const INVOLVEMENT: Record<string, { label: string; title: string }> = {
  '1.0': { label: 'main', title: 'Involvement 1.0: the main concept of the question' },
  '0.5': { label: 'secondary', title: 'Involvement 0.5: a secondary concept' },
  '0.2': { label: 'minor', title: 'Involvement 0.2: a minor concept' },
};
export const involvementOf = (n: number) => INVOLVEMENT[Number(n).toFixed(1)] ?? { label: Number(n).toFixed(1), title: `Involvement ${n}` };

// ---------------------------------------------------------------- U7: group summaries
export interface GroupSummary { count: number; simple: number; medium: number; complex: number; byStatus: Record<string, number> }
export function summarize(qs: Pick<ListQuestion, 'math_difficulty' | 'status' | 'retired_at'>[]): GroupSummary {
  const s: GroupSummary = { count: qs.length, simple: 0, medium: 0, complex: 0, byStatus: {} };
  for (const q of qs) {
    if (q.math_difficulty === 'Simple') s.simple++; else if (q.math_difficulty === 'Medium') s.medium++; else if (q.math_difficulty === 'Complex') s.complex++;
    const k = q.retired_at ? 'retired' : q.status;
    s.byStatus[k] = (s.byStatus[k] ?? 0) + 1;
  }
  return s;
}
export const statusCountsLabel = (b: Record<string, number>) =>
  ['approved', 'in_review', 'draft', 'rejected', 'retired'].filter((k) => b[k]).map((k) => `${b[k]} ${(STATUS_LABEL[k] ?? 'Retired').toLowerCase()}`).join(' · ');

// ---------------------------------------------------------------- D8c: clone groups (PR B)
/** Wording with the numbers taken out: two clones whose texts match here differ only in numbers. */
export const skeleton = (t: string) => t.toLowerCase().replace(/\d+([.,/]\d+)*/g, '#').replace(/\s+/g, ' ').trim();

export interface CloneInfo { key: string; size: number; index: number; nearIdentical: boolean }
/**
 * Orders questions so that clones (same clone_key) sit together, biggest group first, and says
 * for each question "n of size" and whether its wording is near-identical to another clone's
 * (the same once numbers are ignored). Questions without a clone key are their own group.
 */
export function cloneGroups<Q extends { question_id: string; clone_key?: string | null; text: string }>(qs: Q[]): { ordered: Q[]; info: Map<string, CloneInfo>; groups: number } {
  const by = new Map<string, Q[]>();
  for (const q of qs) { const k = q.clone_key ?? `solo:${q.question_id}`; by.set(k, [...(by.get(k) ?? []), q]); }
  const keys = [...by.keys()].sort((a, b) => by.get(b)!.length - by.get(a)!.length || qs.indexOf(by.get(a)![0]!) - qs.indexOf(by.get(b)![0]!));
  const info = new Map<string, CloneInfo>();
  const ordered: Q[] = [];
  for (const k of keys) {
    const list = by.get(k)!;
    const sk = list.map((q) => skeleton(q.text));
    list.forEach((q, i) => {
      ordered.push(q);
      info.set(q.question_id, { key: k, size: list.length, index: i + 1, nearIdentical: list.length > 1 && sk.some((s, j) => j !== i && s === sk[i]) });
    });
  }
  return { ordered, info, groups: keys.length };
}

/** U15: "Classes 4 · 5 · 6" for a topic in several classes; null for one class. */
export const classesLabel = (classes: number[]) => {
  const c = [...new Set(classes)].sort((a, b) => a - b);
  return c.length > 1 ? `Classes ${c.join(' · ')}` : null;
};

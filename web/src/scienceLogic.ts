// Science workspace layout (Sambit, 14 Nov 2026): tree | content | questions. Pure helpers (no React, no network),
// unit-tested in tests/science-layout.test.ts.
import { classMismatch } from '../../shared/science.ts';

export interface RowLike { row_id: string; topic_id: string; sort: number; row_class: number; question_use: string }
export interface QuestionLike { question_id: string; topic_id: string; level_tier: string | null; links: { row_id: string; role: 'direct' | 'supporting' }[] }

/** Content rows in MASTER ORDER (cms_content_rows.sort), not grouped by type. */
export const rowsInOrder = <T extends RowLike>(rows: T[]): T[] => [...rows].sort((a, b) => a.sort - b.sort || a.row_id.localeCompare(b.row_id));

/** Rows written for class N show in class N and above (D3); "all" shows every row.
 *  Q11 (16 Nov 2026): with "Show higher-level questions" on, rows above the class are shown too (tagged "above class"). */
export const rowsForClass = <T extends RowLike>(rows: T[], cls: string, higher = false): T[] => rows.filter((r) => cls === 'all' || higher || r.row_class <= Number(cls));

/** Q11: how many of the rows are at or below the class viewed, and how many above it (0 above under All classes). */
export function rowSplit(rows: Pick<RowLike, 'row_class'>[], cls: string): { within: number; above: number } {
  const above = cls === 'all' ? 0 : rows.filter((r) => r.row_class > Number(cls)).length;
  return { within: rows.length - above, above };
}
/** Q11: "52" or "40 + 12 above class". */
export const rowSplitLabel = (s: { within: number; above: number }) => (s.above > 0 ? `${s.within} + ${s.above} above class` : String(s.within));

/** Q12: the row-class tag on every content row: "Class 6" · "Class 5 row · lower class" · "Class 6 row · above class". */
export type RowClassKind = 'here' | 'lower' | 'above';
export function rowClassTag(rowClass: number, cls: string): { text: string; kind: RowClassKind; title: string } {
  const c = cls === 'all' ? null : Number(cls);
  const kind: RowClassKind = c === null || rowClass === c ? 'here' : rowClass < c ? 'lower' : 'above';
  const text = kind === 'lower' ? `Class ${rowClass} row · lower class` : kind === 'above' ? `Class ${rowClass} row · above class` : `Class ${rowClass}`;
  const title = `Row class ${rowClass}: the class this content is written for.`
    + (kind === 'lower' ? ` Shown in Class ${c} as a lower-class row.` : kind === 'above' ? ` Above Class ${c}: shown only with "Show higher-level questions".` : '');
  return { text, kind, title };
}

/** Q12: the row details' class line, e.g. "Row class 6 · topic home class 3" (replaces the master's Revisit line). */
export const rowClassLine = (rowClass: number, homeClass: number | null) => `Row class ${rowClass}${homeClass !== null ? ` · topic home class ${homeClass}` : ''}`;

/** "No questions" and "Misconception only" rows are dimmed in the list (not hidden). */
export const isDimmed = (r: Pick<RowLike, 'question_use'>) => r.question_use !== 'OK';

const byTier = <Q extends QuestionLike>(a: Q, b: Q) => (a.level_tier ?? 'L9').localeCompare(b.level_tier ?? 'L9') || a.question_id.localeCompare(b.question_id);

/** A row's questions: DIRECT (tests this row) then SUPPORTING (uses it as background). */
export function rowQuestions<Q extends QuestionLike>(questions: Q[], rowId: string): { direct: Q[]; supporting: Q[] } {
  const role = (q: Q) => q.links.find((l) => l.row_id === rowId)?.role ?? null;
  return { direct: questions.filter((q) => role(q) === 'direct').sort(byTier), supporting: questions.filter((q) => role(q) === 'supporting').sort(byTier) };
}

/** What the right column shows: a question's detail, one row's questions, or every question of the topic / chapter. */
export type RightPane = { kind: 'detail'; q: string; back: string } | { kind: 'row'; row: string } | { kind: 'all' };
export function rightPane(row: string | null, q: string | null, scope: 'topic' | 'chapter'): RightPane {
  if (q) return { kind: 'detail', q, back: row ? `← Back to row ${row}` : `← Back to all questions in this ${scope}` };
  return row ? { kind: 'row', row } : { kind: 'all' };
}

/** The question order the keyboard (↓ ↑) steps through: what the right column lists. */
export function listedOrder<Q extends QuestionLike>(questions: Q[], row: string | null): string[] {
  if (!row) return [...questions].sort(byTier).map((q) => q.question_id);
  const { direct, supporting } = rowQuestions(questions, row);
  return [...direct, ...supporting].map((q) => q.question_id);
}

/** Chapter view: rows under each topic (topics in the given order, empty topics kept), master order inside each. */
export function topicGroups<T extends RowLike>(rows: T[], topicIds: string[]): { topic_id: string; rows: T[] }[] {
  const ordered = rowsInOrder(rows);
  const ids = [...topicIds, ...[...new Set(ordered.map((r) => r.topic_id))].filter((id) => !topicIds.includes(id))];
  return ids.map((topic_id) => ({ topic_id, rows: ordered.filter((r) => r.topic_id === topic_id) }));
}

/** The open row's Classes line: "Mapped classes: <mapped or none> · CMS classes: <approved>". An empty or "–" master cell
 *  (DAV-only rows) reads "none" and never raises Class mismatch (Sambit, 14 Nov 2026). */
export function classesLine(mapped: string | null, approved: number[] | null): { text: string; mismatch: number[] } {
  const m = mapped && mapped.trim() !== '' && mapped.trim() !== '–' && mapped.trim() !== '—' ? mapped.trim() : null;
  const cms = approved === null ? '…' : [...approved].sort().join(', ') || '—';
  return { text: `Mapped classes: ${m ?? 'none'} · CMS classes: ${cms}`, mismatch: approved && m ? classMismatch(m, approved)?.onlyMaster ?? [] : [] };
}

// ---------------------------------------------------------------- 0035: ranks, items, approval (Q16 Q17 Q18)
export const RANK_LABEL = { primary: 'Primary', secondary: 'Secondary', context: 'Supporting' } as const;
/** "Primary · 1.0" · "Primary (proposed) · 1.0" · "Secondary · 0.5" · "Supporting · 0" */
export const rankLabel = (l: { rank: keyof typeof RANK_LABEL; rank_proposed: boolean; weight: number }) =>
  `${RANK_LABEL[l.rank]}${l.rank_proposed ? ' (proposed)' : ''} · ${l.weight === 0 ? '0' : l.weight.toFixed(1)}`;

export interface BlockerInput {
  solution1: string | null;
  links: { rank: string; rank_proposed: boolean }[];
  misconceptionText: string | null;
  misconception: { status: string } | null;
  wrongItems: { status: string }[];
  /** Q26/Q32 (0041) */ typeSet?: boolean; conceptErrorRowsOk?: boolean;
}
/** Why a Science version can't be approved yet (the SQL trigger enforces the same, 0035). */
export function scienceBlockers(x: BlockerInput): string[] {
  const out: string[] = [];
  if (!x.solution1?.trim()) out.push('Solution 1 is empty');
  const primaries = x.links.filter((l) => l.rank === 'primary');
  if (primaries.length !== 1) out.push('no primary content row');
  else if (primaries[0]!.rank_proposed) out.push('primary row not confirmed');
  if (x.misconceptionText?.trim()) out.push('misconception is free text');
  if (x.misconception && x.misconception.status !== 'active') out.push('misconception item needs review');
  if (x.wrongItems.some((w) => w.status !== 'active')) out.push("a wrong option's item needs review");
  if (x.typeSet === false) out.push('Science question type not set');
  if (x.conceptErrorRowsOk === false) out.push("a concept error's target row is not one of its content rows");
  return out;
}

/** Q34 (Round 2, 17 Nov 2026): Browse filters for Science questions: Science question type, tier, markers. '' = any. */
export interface SciFilter { type: string; tier: string; markers: string }
export const SCI_FILTER_NONE: SciFilter = { type: '', tier: '', markers: '' };
export function sciFilter<Q extends { science_question_type: number | null; tier: string | null; markers?: number | null }>(qs: Q[], f: SciFilter): Q[] {
  return qs.filter((q) =>
    (f.type === '' || (f.type === 'none' ? !q.science_question_type : q.science_question_type === Number(f.type)))
    && (f.tier === '' || (f.tier === 'none' ? !q.tier : q.tier === f.tier))
    && (f.markers === '' || (f.markers === '3+' ? (q.markers ?? 0) >= 3 : (q.markers ?? 0) === Number(f.markers))));
}

// ---------------------------------------------------------------- Q23 (0044): linked content rows on a Science draft
export type LinkRank = 'primary' | 'secondary' | 'context';
export const LINK_ROLE_LABEL: Record<LinkRank, string> = { primary: 'Primary', secondary: 'Secondary', context: 'Supporting' };
export interface DraftLink { row_id: string; rank: LinkRank }
/** A reference that keeps a row on the question: the misconception targeted, a wrong option's item, a concept-error target. */
export interface LinkRef { row_id: string; what: string }
/** The same rules the database applies (cms_save_content_links), so the screen can say why before Save.
 *  `saved` = the links as stored now (a referenced row that is direct now can't become supporting). */
export function linkChecks(draft: DraftLink[], saved: DraftLink[], refs: LinkRef[]) {
  const primaries = draft.filter((l) => l.rank === 'primary').length;
  const problems: string[] = [];
  if (primaries !== 1) problems.push(`A Science question needs exactly one primary row (it now has ${primaries}).`);
  const lock = new Map<string, { remove: string | null; support: string | null }>();
  for (const r of refs) {
    const wasDirect = saved.some((s) => s.row_id === r.row_id && s.rank !== 'context');
    const x = lock.get(r.row_id) ?? { remove: null, support: null };
    x.remove ??= `Used by ${r.what}: clear the reference first.`;
    if (wasDirect) x.support ??= `Used by ${r.what}: clear the reference first, then make it supporting.`;
    lock.set(r.row_id, x);
    const d = draft.find((l) => l.row_id === r.row_id);
    if (!d) problems.push(`Row ${r.row_id} is still used by ${r.what}; clear the reference first.`);
    else if (wasDirect && d.rank === 'context') problems.push(`Row ${r.row_id} is still used by ${r.what}; clear the reference first, then make it supporting.`);
  }
  const key = (ls: DraftLink[]) => ls.map((l) => `${l.row_id}:${l.rank}`).sort().join();
  return { problems, lock, dirty: key(draft) !== key(saved) };
}

// ---------------------------------------------------------------- Q38 PR 4 (Sambit, 24 Nov 2026): review in Browse
type PLink = { row_id: string; role: 'direct' | 'supporting'; rank?: string; rank_proposed?: boolean; primary_rejected?: boolean };
/** A question's primary row and its state: "Primary C3-05-008 · proposed" (c). */
export function primaryOf(q: { links: PLink[] }): { row_id: string | null; state: 'confirmed' | 'proposed' | 'rejected' | 'none' } {
  const p = q.links.find((l) => l.rank === 'primary');
  if (p) return { row_id: p.row_id, state: p.rank_proposed ? 'proposed' : 'confirmed' };
  const r = q.links.find((l) => l.primary_rejected);
  return r ? { row_id: r.row_id, state: 'rejected' } : { row_id: null, state: 'none' };
}

/** (b) Previous / Next: the whole chapter in master order: topic → content row → its questions, each question ONCE, at its
 *  primary row (wherever that row sits in the chapter, so it crosses topics). A question whose primary row is not a row of
 *  this chapter (or that has none) comes at the end of its own topic. Questions under a row: by type then ID. */
export function walkOrder<R extends RowLike, Q extends { question_id: string; topic_id: string; science_question_type?: number | null; links: PLink[] }>(
  rows: R[], questions: Q[], topicIds: string[]): { question_id: string; topic_id: string; row_id: string | null }[] {
  const rowTopic = new Map(rows.map((r) => [r.row_id, r.topic_id]));
  const byRow = new Map<string, Q[]>(), loose = new Map<string, Q[]>();
  for (const q of questions) {
    const p = q.links.find((l) => l.rank === 'primary')?.row_id ?? null;
    if (p && rowTopic.has(p)) byRow.set(p, [...(byRow.get(p) ?? []), q]);
    else loose.set(q.topic_id, [...(loose.get(q.topic_id) ?? []), q]);
  }
  const sort = (qs: Q[]) => [...qs].sort((a, b) => (a.science_question_type ?? 9) - (b.science_question_type ?? 9) || a.question_id.localeCompare(b.question_id));
  // only the topics given (the ones the tree shows); a question of another topic is never walked (PR 4b, 24 Nov 2026)
  const topics = topicIds;
  questions = questions.filter((q) => topicIds.includes(q.topic_id));
  const out: { question_id: string; topic_id: string; row_id: string | null }[] = [];
  for (const t of topics) {
    for (const r of rowsInOrder(rows.filter((x) => x.topic_id === t))) for (const q of sort(byRow.get(r.row_id) ?? [])) out.push({ question_id: q.question_id, topic_id: t, row_id: r.row_id });
    for (const q of sort(loose.get(t) ?? [])) out.push({ question_id: q.question_id, topic_id: t, row_id: null });
  }
  return out;
}
/** Where a question sits in the walk and its neighbours ("12 / 87"); onlyIds narrows the walk (e.g. only Needs review). */
/** PR 4b (Sambit, 24 Nov 2026): the walk uses EXACTLY the Browse filters of the tree and the question list, so its total
 *  matches the chapter count: the topics the tree shows (core, plus extra ones when "Include extra topics" is ticked), each
 *  topic's class ceiling (its highest selected class) unless "Show higher-level questions" is on, and only counted
 *  questions (not retired). "only Needs review" narrows it further (walkStep). */
export interface WalkTopic { topic_id: string; ceiling: number | null }
export function walkQuestions<Q extends { topic_id: string; effective_level: number; retired_at?: string | null; counted?: boolean | null }>(
  questions: Q[], topics: WalkTopic[], higher: boolean): Q[] {
  const ceil = new Map(topics.map((t) => [t.topic_id, t.ceiling]));
  return questions.filter((q) => ceil.has(q.topic_id) && !q.retired_at && q.counted !== false
    && (ceil.get(q.topic_id) === null || higher || q.effective_level <= ceil.get(q.topic_id)!));
}

export function walkStep<W extends { question_id: string }>(walk: W[], current: string | null, onlyIds?: Set<string>) {
  const list = onlyIds ? walk.filter((w) => onlyIds.has(w.question_id) || w.question_id === current) : walk;
  const i = current ? list.findIndex((w) => w.question_id === current) : -1;
  return { pos: i + 1, total: onlyIds ? list.filter((w) => onlyIds.has(w.question_id)).length : list.length, prev: i > 0 ? list[i - 1]! : null, next: i >= 0 && i < list.length - 1 ? list[i + 1]! : null };
}

/** (e) One visual state for every proposal in Browse. */
export type PState = 'proposed' | 'approved' | 'rejected';
export type PFilter = 'all' | PState;
export const PFILTERS: [PFilter, string][] = [['all', 'All'], ['proposed', 'Proposed'], ['approved', 'Approved'], ['rejected', 'Rejected']];
/** A question: Needs review / draft = proposed · approved · rejected (Q4). Retired counts as rejected. */
export const questionState = (q: { status: string; retired_at?: string | null }): PState =>
  q.retired_at || q.status === 'rejected' ? 'rejected' : q.status === 'approved' ? 'approved' : 'proposed';
/** A content row (Q4, inferred): retired = rejected; a pending proposal on it (a needs-review item, or a question whose
 *  primary on this row is proposed) = proposed; otherwise approved. */
export function rowState(r: { row_id: string; retired_at: string | null }, pendingItems: Set<string>, questions: { links: PLink[] }[]): PState {
  if (r.retired_at) return 'rejected';
  if (pendingItems.has(r.row_id)) return 'proposed';
  return questions.some((q) => q.links.some((l) => l.row_id === r.row_id && l.rank === 'primary' && l.rank_proposed)) ? 'proposed' : 'approved';
}
/** OL-044: approving a GENERATED question also confirms its single proposed primary (cms_approve_questions). */
export const primaryConfirmedOnApproval = (createdFrom: string | null | undefined, links: { rank: string; rank_proposed: boolean }[]) =>
  createdFrom === 'generation' && !links.some((l) => l.rank === 'primary' && !l.rank_proposed) && links.filter((l) => l.rank === 'primary' && l.rank_proposed).length === 1;

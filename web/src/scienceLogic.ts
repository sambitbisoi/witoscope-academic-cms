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

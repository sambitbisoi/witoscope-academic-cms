// Review UX (15 Nov 2026), Q8 / Q10: pure helpers for catalogue items (no network): Kind labels, the
// "Proposed question type · Class 3" line and the item=kind:id URL value. Unit-tested in tests/review-ux.test.ts.
import type { Subject } from './logic';

export type CatKind = 'concept' | 'misconception' | 'typical_set' | 'pattern' | 'setting' | 'topic_class';
export const CAT_KINDS: CatKind[] = ['concept', 'misconception', 'typical_set', 'pattern', 'topic_class', 'setting'];
/** The Kind as a reader says it (Q8). */
export const KIND_LABEL: Record<CatKind, string> = {
  concept: 'Concept', misconception: 'Misconception', typical_set: 'Question type', pattern: 'Pattern', setting: 'Setting', topic_class: 'Topic–class link',
};
export const TAB_LABEL: Record<CatKind, string> = {
  concept: 'Concepts', misconception: 'Misconceptions', typical_set: 'Typical sets', pattern: 'Patterns', topic_class: 'Topic classes', setting: 'Settings',
};
/** Kinds that Approve / Reject can decide (settings have no approval path: shown read-only, decision 1). */
export const decidable = (k: CatKind) => k !== 'setting';
export type Show = 'proposed' | 'active' | 'retired';

export interface CatItem {
  kind: CatKind; id: string; label: string; detail: string; status: string;
  topic_id: string | null; chapter_id: string | null; strand_id: string | null; subject: Subject | null;
  /** the class shown (information only); via says where it comes from when it is not the item's own */
  cls: number | null; via: string | null;
  proposedBy: string[]; usedBy: string[];
}

/** "Proposed question type · Class 3", "Topic–class link MT0261 → Class 6" (Q8). */
export function kindLine(i: Pick<CatItem, 'kind' | 'id' | 'status' | 'cls' | 'via' | 'topic_id'>): string {
  const state = i.status === 'proposed' ? 'Proposed ' : '';
  if (i.kind === 'topic_class') return `${state}${state ? 'topic–class link' : 'Topic–class link'} ${i.topic_id ?? ''} → Class ${i.cls ?? '?'}`;
  const k = KIND_LABEL[i.kind];
  const cls = i.cls ? ` · Class ${i.cls}${i.via ? ` (${i.via})` : ''}` : '';
  return `${state}${state ? k.toLowerCase() : k}${cls}`;
}

/** Q8 in Browse: `item=kind:id` in the URL. */
export const itemParam = (kind: CatKind, id: string) => `${kind}:${id}`;
export function parseItem(s: string | null | undefined): { kind: CatKind; id: string } | null {
  const m = /^(concept|misconception|typical_set|pattern|setting|topic_class):(.{1,60})$/.exec(s ?? '');
  return m ? { kind: m[1] as CatKind, id: m[2]! } : null;
}


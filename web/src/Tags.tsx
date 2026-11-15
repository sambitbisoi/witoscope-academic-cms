// Small tags shared by Browse, the Science view and the question panel (review UX, 15 Nov 2026).
import { levelTag } from './logic';

/** Q3: the question's Level on its row ("Level 3", "Level 2 · revision", "Level 5 · above class"). The Level is never changed. */
export function LevelTag({ q, ceiling }: { q: { level: number | null; effective_level: number }; ceiling: number | null }) {
  const t = levelTag(q, ceiling);
  return <span className={`tag level lv-${t.kind}${t.unset ? ' lv-unset' : ''}`} title={t.title}>{t.text}</span>;
}

/** Q2 / Q7 / Q8: where a concept, question type or misconception was first catalogued. Information only: it never changes what is shown. */
export function ClassTag({ cls, what, via }: { cls: number | null; what: string; via?: string }) {
  if (!cls) return null;
  return <span className="tag cat-class" title={`The ${what}'s class${via ? ` (${via})` : ''}: where it was first catalogued. Information only; it does not change what is shown.`}>{via ? `Class ${cls} · ${via}` : `Class ${cls}`}</span>;
}

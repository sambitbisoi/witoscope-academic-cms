// Reorder mode of the Curriculum map (Sambit, 13 Nov 2026). One class + one subject. The draggable
// level follows the Show checkboxes: none ticked → strands; Show chapter → chapters (within their
// strand); Show topic → topics (within their chapter). Drag and drop, or ↑ / ↓. Numbers update live.
// Only core rows move; extra rows (from a lower / higher class) and Achievers rows sit after them,
// unnumbered and fixed. Lists never mix parents, so nothing can cross a strand or chapter.
import { useEffect, useMemo, useRef, useState } from 'react';
import { moveWithin, numbered, type SeqStrandNode } from '../../shared/sequence.ts';
import { saveOrder } from './editApi';
import { Id } from './Id';

export type ReorderLevel = 'strand' | 'chapter' | 'topic';
type Lists = Record<string, string[]>; // parent key ('' for strands) → core ids in order

function initialLists(tree: SeqStrandNode[], level: ReorderLevel): Lists {
  if (level === 'strand') return { '': tree.filter((s) => s.core).map((s) => s.strand.strand_id) };
  const out: Lists = {};
  for (const s of tree) {
    if (level === 'chapter') { if (s.chapters.some((c) => c.core)) out[s.strand.strand_id] = s.chapters.filter((c) => c.core).map((c) => c.chapter.chapter_id); continue; }
    for (const c of s.chapters) { const ids = c.topics.filter((t) => t.role === 'core').map((t) => t.topic.topic_id); if (ids.length) out[c.chapter.chapter_id] = ids; }
  }
  return out;
}

export function ReorderPanel({ subject, cls, tree, level, strandFilter, onDirty, onDone }: {
  subject: string; cls: number; tree: SeqStrandNode[]; level: ReorderLevel; strandFilter: string | null;
  onDirty: (dirty: boolean) => void; onDone: (saved: boolean) => void;
}) {
  const start = useMemo(() => initialLists(tree, level), [tree, level]);
  const [lists, setLists] = useState<Lists>(start);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const drag = useRef<{ parent: string; id: string } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  useEffect(() => { setLists(start); }, [start]);
  const changed = Object.keys(lists).filter((k) => lists[k]!.join('|') !== (start[k] ?? []).join('|'));
  useEffect(() => { onDirty(changed.length > 0); }, [changed.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (parent: string, id: string, to: number) => setLists((l) => { const list = l[parent]!; return { ...l, [parent]: moveWithin(list, list.indexOf(id), to) }; });
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await saveOrder({ subject, class: cls, lists: changed.map((k) => ({ level, parent_id: k || null, ids: lists[k]! })) });
      onDirty(false); onDone(true);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  // live numbers from the lists being edited
  const strandOrder = level === 'strand' ? lists['']! : tree.filter((s) => s.core).map((s) => s.strand.strand_id);
  const strandNo = (id: string) => { const i = strandOrder.indexOf(id); return i >= 0 ? `${i + 1}` : null; };
  const chapterNo = (s: SeqStrandNode, id: string) => {
    const sn = strandNo(s.strand.strand_id); if (!sn) return null;
    const order = level === 'chapter' ? lists[s.strand.strand_id] ?? [] : s.chapters.filter((c) => c.core).map((c) => c.chapter.chapter_id);
    const i = order.indexOf(id); return i >= 0 ? `${sn}.${i + 1}` : null;
  };

  /** One draggable row (a core item of the level being reordered). */
  // plain render functions (not components), so the dragged row keeps its DOM node while the list re-renders
  const item = ({ parent, id, label, no, sub }: { parent: string; id: string; label: string; no: string | null; sub?: string }) => {
    const list = lists[parent]!; const i = list.indexOf(id);
    return (
      <li key={id} className={`ro-item ${dragging === id ? 'dragging' : ''}`} draggable
        onDragStart={(e) => { drag.current = { parent, id }; setDragging(id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); }}
        onDragEnd={() => { drag.current = null; setDragging(null); }}
        onDragOver={(e) => {
          const d = drag.current;
          if (!d || d.parent !== parent) return; // never across strands or chapters
          e.preventDefault();
          if (d.id !== id) move(parent, d.id, list.indexOf(id)); // live: numbers follow while dragging
        }}
        onDrop={(e) => e.preventDefault()}>
        <span className="ro-handle" aria-hidden>⠿</span>
        <span className="ro-no">{no ?? ''}</span>
        <span className="ro-name">{label} {sub && <Id>{sub}</Id>}</span>
        <span className="ro-btns">
          <button className="link" aria-label={`Move ${label} up`} disabled={i === 0} onClick={() => move(parent, id, i - 1)}>↑</button>
          <button className="link" aria-label={`Move ${label} down`} disabled={i === list.length - 1} onClick={() => move(parent, id, i + 1)}>↓</button>
        </span>
      </li>
    );
  };
  const fixed = ({ key, label, sub, note }: { key: string; label: string; sub?: string; note: string }) => (
    <li key={key} className="ro-item fixed" title="Not sequenced here"><span className="ro-handle" /><span className="ro-no" /><span className="ro-name">{label} {sub && <Id>{sub}</Id>}</span><span className="muted small">{note}</span></li>
  );

  const shown = tree.filter((s) => !strandFilter || level === 'strand' || s.strand.strand_id === strandFilter);
  const byId = new Map(tree.map((s) => [s.strand.strand_id, s]));
  return (
    <div className="reorder card">
      <div className="ro-head">
        <strong>Reorder {level === 'strand' ? 'strands' : level === 'chapter' ? 'chapters (within their strand)' : 'topics (within their chapter)'}</strong>
        <span className="muted small">Class {cls} · drag, or use ↑ / ↓. Extra rows and Achievers rows stay after the core ones.</span>
        <span className="spacer" />
        <button disabled={busy || !changed.length} onClick={save}>{busy ? 'Saving…' : `Save order${changed.length ? ` (${changed.length} list${changed.length === 1 ? '' : 's'})` : ''}`}</button>
        <button className="secondary" disabled={busy} onClick={() => { if (!changed.length || confirm('Discard the order changes?')) { onDirty(false); onDone(false); } }}>Cancel</button>
      </div>
      {err && <p className="error small">{err}</p>}
      {level === 'strand' ? (
        <ol className="ro-list">
          {lists['']!.map((id) => item({ parent: '', id, label: byId.get(id)!.strand.name, no: strandNo(id) ? `${strandNo(id)}.` : null }))}
          {tree.filter((s) => !s.core).map((s) => fixed({ key: s.strand.strand_id, label: s.strand.name, note: 'extra (no core topics in this class)' }))}
        </ol>
      ) : shown.map((s) => (
        <div key={s.strand.strand_id} className="ro-group">
          <div className="ro-strand">{numbered(strandNo(s.strand.strand_id), s.strand.name, 'strand')}</div>
          {level === 'chapter' ? (
            <ol className="ro-list">
              {(lists[s.strand.strand_id] ?? []).map((id) => { const c = s.chapters.find((x) => x.chapter.chapter_id === id)!;
                return item({ parent: s.strand.strand_id, id, label: c.chapter.name, sub: id, no: chapterNo(s, id) }); })}
              {s.chapters.filter((c) => !c.core).map((c) => fixed({ key: c.chapter.chapter_id, label: c.chapter.name, sub: c.chapter.chapter_id, note: 'extra rows only' }))}
            </ol>
          ) : s.chapters.map((c) => (
            <div key={c.chapter.chapter_id} className="ro-chapter">
              <div className="ro-chapter-name">{numbered(chapterNo(s, c.chapter.chapter_id), c.chapter.name)} <Id>{c.chapter.chapter_id}</Id></div>
              <ol className="ro-list">
                {(lists[c.chapter.chapter_id] ?? []).map((id, i) => { const t = c.topics.find((x) => x.topic.topic_id === id)!; const cn = chapterNo(s, c.chapter.chapter_id);
                  return item({ parent: c.chapter.chapter_id, id, label: t.topic.name, sub: id, no: cn ? `${cn}.${i + 1}` : null }); })}
                {c.topics.filter((t) => t.role !== 'core').map((t) => fixed({ key: t.topic.topic_id, label: t.topic.name, sub: t.role === 'achievers' ? undefined : t.topic.topic_id,
                  note: t.role === 'achievers' ? 'Achievers · always last' : `from Class ${t.topic.class}` }))}
              </ol>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// U2 (queue 12 Nov 2026): one list of every PROPOSED concept, misconception, typical set and
// pattern (from the book pipeline, migration 0018), with who proposed it and which question
// keys use it. Approve (→ active) or Retire from here, one by one or the ticked ones.
// Audited through cms_set_catalogue_status; nothing is deleted.
import { useEffect, useMemo, useState } from 'react';
import { all } from './api';
import { setCatalogueStatus } from './editApi';
import { browseHash, safeSearch } from './logic';
import { Proposed } from './QuestionDetail';
import { supabase } from './supabase';

type Kind = 'concept' | 'misconception' | 'typical_set' | 'pattern' | 'topic_class';
const KINDS: { id: Kind; label: string; table: string; key: string; cols: string }[] = [
  { id: 'concept', label: 'Concepts', table: 'cms_concepts', key: 'concept_id', cols: 'concept_id, name, class, topic_id, status, description' },
  { id: 'misconception', label: 'Misconceptions', table: 'cms_misconceptions', key: 'misconception_id', cols: 'misconception_id, description, concept_id, status' },
  { id: 'typical_set', label: 'Typical sets', table: 'cms_typical_sets', key: 'typical_set_id', cols: 'typical_set_id, name, class, topic_id, status, instruction_pattern' },
  { id: 'pattern', label: 'Patterns', table: 'cms_patterns', key: 'pattern_id', cols: 'pattern_id, name, typical_set_id, topic_id, status' },
  // Science (13 Nov 2026): topic–class links the Science master suggests; approving makes the link (audited)
  { id: 'topic_class', label: 'Topic classes', table: 'cms_topic_class_proposals', key: 'topic_id', cols: 'topic_id, class, source, evidence, suggested_role, status' },
];
const ROLE_TEXT = { lower: 'from a lower class', higher: 'from a higher class' } as Record<string, string>;
async function loadTopicClasses(show: Show): Promise<Item[]> {
  const rows = await all<{ topic_id: string; class: number; source: string; evidence: string | null; suggested_role: string; status: string }>((a, b) =>
    supabase.from('cms_topic_class_proposals').select('topic_id, class, source, evidence, suggested_role, status').eq('status', show).order('topic_id').order('class').range(a, b));
  const ids = [...new Set(rows.map((r) => r.topic_id))];
  const topics = ids.length ? ((await supabase.from('cms_topics').select('topic_id, name, class').in('topic_id', ids)).data ?? []) as { topic_id: string; name: string; class: number }[] : [];
  return rows.map((r) => {
    const t = topics.find((x) => x.topic_id === r.topic_id);
    return { kind: 'topic_class', id: `${r.topic_id}·${r.class}`, label: `${t?.name ?? r.topic_id} → also in Class ${r.class}`,
      detail: `Home class ${t?.class ?? '?'} · row class ${r.class} · suggested role: ${ROLE_TEXT[r.suggested_role] ?? r.suggested_role}${r.evidence ? ` · ${r.evidence}` : ''}`,
      topic: r.topic_id, status: r.status, proposedBy: [r.source], usedBy: [] };
  });
}
interface Item { kind: Kind; id: string; label: string; detail: string; topic: string | null; status: string; proposedBy: string[]; usedBy: string[] }
type Show = 'proposed' | 'active' | 'retired';

async function load(kind: Kind, show: Show): Promise<Item[]> {
  if (kind === 'topic_class') return loadTopicClasses(show);
  const k = KINDS.find((x) => x.id === kind)!;
  const [rows, links] = await Promise.all([
    all<Record<string, unknown>>((a, b) => supabase.from(k.table).select(k.cols).eq('status', show).order(k.key).range(a, b)),
    all<{ item_id: string; proposed_by: string; used_by: string[] }>((a, b) => supabase.from('cms_catalogue_proposals').select('item_id, proposed_by, used_by').eq('item_kind', kind).order('item_id').order('proposed_by').range(a, b)),
  ]);
  const by = new Map<string, { p: string[]; u: Set<string> }>();
  for (const l of links) {
    const e = by.get(l.item_id) ?? { p: [], u: new Set<string>() };
    e.p.push(l.proposed_by); for (const u of l.used_by) e.u.add(u);
    by.set(l.item_id, e);
  }
  return rows.map((r) => {
    const id = String(r[k.key]);
    const l = by.get(id);
    const label = String(r.name ?? r.description ?? '');
    const detail = kind === 'concept' ? `Class ${r.class}${r.description ? ` · ${r.description}` : ''}`
      : kind === 'misconception' ? (r.concept_id ? `concept ${r.concept_id}` : '')
      : kind === 'typical_set' ? `Class ${r.class}${r.instruction_pattern ? ` · "${r.instruction_pattern}"` : ''}`
      : `set ${r.typical_set_id}`;
    return { kind, id, label, detail, topic: (r.topic_id as string | null) ?? null, status: String(r.status), proposedBy: l?.p ?? [], usedBy: [...(l?.u ?? [])].sort() };
  });
}

const topicLink = (t: string) => browseHash({ subject: t.startsWith('S') ? 'science' : t.startsWith('G') ? 'grammar' : 'math', cls: 'all', topic: t });

export function ProposedList({ kind: routeKind }: { kind: string | null }) {
  const kind: Kind = KINDS.some((k) => k.id === routeKind) ? routeKind as Kind : 'concept';
  const [show, setShow] = useState<Show>('proposed');
  const [items, setItems] = useState<Item[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setItems(null); setError(null); setPicked(new Set());
    load(kind, show).then(setItems).catch((e) => setError(e.message));
  }, [kind, show, reload]);
  useEffect(() => {
    Promise.all(KINDS.map(async (k) => {
      const { count } = await supabase.from(k.table).select(k.key, { count: 'exact', head: true }).eq('status', 'proposed');
      return [k.id, count ?? 0] as const;
    })).then((x) => setCounts(Object.fromEntries(x))).catch(() => setCounts({}));
  }, [reload]);

  const q = safeSearch(text).toLowerCase();
  const shown = useMemo(() => (items ?? []).filter((i) => !q || `${i.id} ${i.label} ${i.detail} ${i.topic ?? ''} ${i.proposedBy.join(' ')}`.toLowerCase().includes(q)), [items, q]);

  async function act(ids: string[], status: 'active' | 'retired' | 'proposed') {
    setBusy(true); setError(null);
    let done = 0;
    try {
      for (const id of ids) {
        if (kind === 'topic_class') {
          const [topic, cls] = id.split('·');
          const { error } = await supabase.rpc('cms_decide_topic_class', { p_topic_id: topic, p_class: Number(cls), p_status: status });
          if (error) throw new Error(error.message);
          done++; continue;
        }
        await setCatalogueStatus(kind, id, status, status === 'active' ? 'approved from the Proposed list' : status === 'retired' ? 'retired from the Proposed list' : 'back to proposed'); done++; }
      setFlash(`${done} ${status === 'active' ? 'approved' : status === 'retired' ? 'retired' : 'put back to proposed'}.`);
    } catch (e) {
      setError(`${(e as Error).message} (${done} of ${ids.length} done)`);
    } finally {
      setBusy(false); setReload((x) => x + 1);
    }
  }
  const tick = (id: string) => { const n = new Set(picked); if (n.has(id)) n.delete(id); else n.add(id); setPicked(n); };

  return (
    <>
      <div className="section-head">
        <h2>Proposed catalogue items</h2>
        <div className="grades">
          {(['proposed', 'active', 'retired'] as const).map((s) => (
            <button key={s} className={`pill small ${s === show ? 'on' : ''}`} aria-pressed={s === show} onClick={() => setShow(s)}>{s === 'proposed' ? 'Proposed' : s === 'active' ? 'Approved' : 'Retired'}</button>
          ))}
        </div>
      </div>
      <p className="muted small">{kind === 'topic_class' ? 'Topic–class links the Science master suggests (content rows of a class the topic is not linked to yet). Approving adds the link; the topic then shows in that class as an extra topic. ' : 'Concepts, misconceptions, typical sets and patterns proposed by the book pipeline. They can already be used as tags; approving makes them part of the catalogue. '}
        Nothing is deleted: retire an item you don't want. Every change is logged.</p>
      <div role="tablist" className="tabs">
        {KINDS.map((k) => (
          <button key={k.id} role="tab" aria-selected={k.id === kind} className={k.id === kind ? 'on' : ''} onClick={() => { location.hash = `#/proposed?kind=${k.id}`; }}>
            {k.label}{counts[k.id] !== undefined ? ` · ${counts[k.id]}` : ''}
          </button>
        ))}
      </div>
      <div className="filters">
        <input className="search-in" placeholder="Filter by ID, name, topic or book chapter" value={text} onChange={(e) => setText(e.target.value)} />
        {items && <span className="muted small">{shown.length} of {items.length}</span>}
        <span className="spacer" />
        {show === 'proposed' && <>
          <button className="link small" onClick={() => setPicked(new Set(shown.map((i) => i.id)))} disabled={!shown.length}>Tick all shown</button>
          <button className="link small" onClick={() => setPicked(new Set())} disabled={!picked.size}>Clear</button>
          <button className="approve" disabled={busy || !picked.size} onClick={() => act([...picked], 'active')}>Approve ticked · {picked.size}</button>
        </>}
      </div>
      {flash && <div className="notice small">{flash}</div>}
      {error && <p className="error">{error}</p>}
      {!items && !error && <p className="muted">Loading…</p>}
      {items && shown.length === 0 && <p className="muted">Nothing here.</p>}
      {items && shown.length > 0 && (
        <table className="list proposed-table">
          <thead><tr>{show === 'proposed' && <th aria-label="Tick" />}<th>ID</th><th>Name</th><th>Topic</th><th>Proposed by</th><th>Used by</th><th /></tr></thead>
          <tbody>
            {shown.slice(0, 500).map((i) => (
              <tr key={i.id} className={picked.has(i.id) ? 'picked' : ''}>
                {show === 'proposed' && <td><input type="checkbox" aria-label={`Tick ${i.id}`} checked={picked.has(i.id)} onChange={() => tick(i.id)} /></td>}
                <td className="mono nowrap">{i.id}<Proposed status={i.status} /></td>
                <td><div>{i.label}</div>{i.detail && <div className="muted small">{i.detail}</div>}</td>
                <td className="nowrap">{i.topic ? <a href={topicLink(i.topic)}>{i.topic}</a> : <span className="muted">—</span>}</td>
                <td className="small">{i.proposedBy.join(', ') || <span className="muted">—</span>}</td>
                <td className="small" title={i.usedBy.join(', ')}>{i.usedBy.length ? `${i.usedBy.length} question${i.usedBy.length === 1 ? '' : 's'}: ${i.usedBy.slice(0, 3).join(', ')}${i.usedBy.length > 3 ? ' …' : ''}` : <span className="muted">none</span>}</td>
                <td className="nowrap">
                  {i.status === 'proposed' && <><button className="approve small-btn" disabled={busy} onClick={() => act([i.id], 'active')}>Approve</button>{' '}
                    <button className="link small" disabled={busy} onClick={() => act([i.id], 'retired')}>Retire</button></>}
                  {i.status !== 'proposed' && !(i.kind === 'topic_class' && i.status === 'active') && <button className="link small" disabled={busy} onClick={() => act([i.id], 'proposed')}>Back to proposed</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {items && shown.length > 500 && <p className="muted small">Showing the first 500 of {shown.length}; filter to narrow the list.</p>}
    </>
  );
}

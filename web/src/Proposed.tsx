// U2 (queue 12 Nov 2026) + review UX (15 Nov 2026, Q8 / Q10): every PROPOSED concept, misconception,
// question type (typical set), pattern, topic–class link and setting, with its Kind and Class, who
// proposed it and which question keys use it. Filters: Subject, Class, Strand, Chapter, Topic
// (multi-select, with counts). Selecting a row opens its details in the right-hand pane, with
// Approve and Reject (reason). Decisions go through the existing audited functions; nothing is deleted.
import { useEffect, useMemo, useState } from 'react';
import { CatalogueDetail } from './CatalogueDetail';
import { CAT_KINDS, decidable, decide, itemParam, kindLine, loadItems, loadPlaces, parseItem, TAB_LABEL, type CatItem, type CatKind, type Places, type Show } from './catalogueApi';
import { Id } from './Id';
import { browseHash, safeSearch, subjectLabel, SUBJECTS, valueCounts } from './logic';
import { MultiSelect, type MOption } from './MultiSelect';
import { RowItemsTab } from './ProposedItems';

type Facet = 'subject' | 'cls' | 'strand' | 'chapter' | 'topic';
const FACETS: { id: Facet; label: string }[] = [
  { id: 'subject', label: 'Subject' }, { id: 'cls', label: 'Class' }, { id: 'strand', label: 'Strand' }, { id: 'chapter', label: 'Chapter' }, { id: 'topic', label: 'Topic' },
];
const valueOf = (i: CatItem, f: Facet): string | null =>
  f === 'subject' ? i.subject : f === 'cls' ? (i.cls ? String(i.cls) : null) : f === 'strand' ? i.strand_id : f === 'chapter' ? i.chapter_id : i.topic_id;
const NONE = '—';
const topicLink = (i: CatItem) => browseHash({ subject: i.subject ?? 'math', cls: 'all', ch: i.chapter_id, topic: i.topic_id });

export function ProposedList({ kind: routeKind, item: routeItem }: { kind: string | null; item?: string | null }) {
  const kind: CatKind = CAT_KINDS.includes(routeKind as CatKind) ? routeKind as CatKind : 'concept';
  const sel = parseItem(routeItem);
  /** 0035: Science misconception items (status only), a tab of its own */
  const rowItemsTab = routeKind === 'row_item';
  const [show, setShow] = useState<Show>('proposed');
  const [places, setPlaces] = useState<Places | null>(null);
  const [items, setItems] = useState<CatItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [facets, setFacets] = useState<Record<Facet, string[]>>({ subject: [], cls: [], strand: [], chapter: [], topic: [] });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [rejectId, setRejectId] = useState<string | null>(null);

  useEffect(() => { loadPlaces().then(setPlaces).catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    if (!places) return;
    setItems(null); setError(null); setPicked(new Set());
    loadItems(show, places).then(setItems).catch((e) => setError(e.message));
  }, [show, places, reload]);

  const open = (k: CatKind, id: string | null, reject = false) => { setRejectId(reject ? id : null); location.hash = `#/proposed?kind=${k}${id ? `&item=${encodeURIComponent(itemParam(k, id))}` : ''}`; };
  const q = safeSearch(text).toLowerCase();
  const matchText = (i: CatItem) => !q || `${i.id} ${i.label} ${i.detail} ${i.topic_id ?? ''} ${i.proposedBy.join(' ')}`.toLowerCase().includes(q);
  const matchFacet = (i: CatItem, f: Facet) => !facets[f].length || facets[f].includes(valueOf(i, f) ?? NONE);
  const passes = (i: CatItem, except?: Facet) => matchText(i) && FACETS.every((f) => f.id === except || matchFacet(i, f.id));
  // tab counts follow the filters; the list is the tab's items that pass them
  const tabCounts = useMemo(() => valueCounts((items ?? []).filter((i) => passes(i)), (i) => [i.kind]), [items, facets, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const ofKind = useMemo(() => (items ?? []).filter((i) => i.kind === kind), [items, kind]);
  const shown = useMemo(() => ofKind.filter((i) => passes(i)), [ofKind, facets, q]); // eslint-disable-line react-hooks/exhaustive-deps
  // facet options: values of this tab's items that pass the OTHER filters, with counts
  const options = useMemo(() => {
    const out = {} as Record<Facet, MOption[]>;
    for (const f of FACETS) {
      const counts = valueCounts(ofKind.filter((i) => passes(i, f.id)), (i) => [valueOf(i, f.id) ?? NONE]);
      out[f.id] = [...counts].map(([v, n]) => ({ value: v, label: facetLabel(f.id, v, places), count: n }))
        .sort((a, b) => (a.value === NONE ? 1 : b.value === NONE ? -1 : f.id === 'cls' ? Number(a.value) - Number(b.value) : a.label.localeCompare(b.label)));
    }
    return out;
  }, [ofKind, facets, q, places]); // eslint-disable-line react-hooks/exhaustive-deps

  async function approveMany(ids: string[]) {
    setBusy(true); setError(null);
    let done = 0;
    try {
      for (const id of ids) { await decide(kind, id, 'active', null, 'from the Proposed list'); done++; }
      setFlash(`${done} approved.`);
    } catch (e) {
      setError(`${(e as Error).message} (${done} of ${ids.length} done)`);
    } finally { setBusy(false); setReload((x) => x + 1); }
  }
  const tick = (id: string) => { const n = new Set(picked); if (n.has(id)) n.delete(id); else n.add(id); setPicked(n); };
  const canDecide = decidable(kind);
  const anyFilter = FACETS.some((f) => facets[f.id].length > 0);

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
      <p className="muted small">{kind === 'topic_class' ? 'Topics the Science master suggests adding to another class. Confirm adds the topic to that class (it shows there as an extra topic); Reject keeps the proposal, undoable. Hover a row for the evidence. '
        : kind === 'setting' ? 'Settings (the story or context of a question) proposed by the pipeline or a generation run. Approve makes one active; Reject keeps it (retired) and can be undone. '
        : 'Concepts, misconceptions, question types and patterns proposed by the book pipeline. They can already be used as tags; approving makes them part of the catalogue. '}
        A class is where an item was first catalogued; it is information only. Nothing is deleted: Reject retires an item and keeps it. Every change is logged. Select a row to see its details.</p>
      <div role="tablist" className="tabs">
        {CAT_KINDS.map((k) => (
          <button key={k} role="tab" aria-selected={k === kind && !rowItemsTab} className={k === kind && !rowItemsTab ? 'on' : ''} onClick={() => open(k, null)}>
            {TAB_LABEL[k]}{items ? ` · ${tabCounts.get(k) ?? 0}` : ''}
          </button>
        ))}
        <button role="tab" aria-selected={rowItemsTab} className={rowItemsTab ? 'on' : ''} onClick={() => { location.hash = '#/proposed?kind=row_item'; }}>Misconception items</button>
      </div>
      {rowItemsTab ? <RowItemsTab show={show} /> : <>
      <div className="filters">
        {/* Q28: settings have only a subject (one shared SET list) */}
        {(kind === 'setting' ? FACETS.filter((f) => f.id === 'subject') : FACETS).map((f) => (
          <MultiSelect key={f.id} label={f.label} options={options[f.id] ?? []} selected={facets[f.id]} onChange={(v) => { setFacets({ ...facets, [f.id]: v }); setPicked(new Set()); }} />
        ))}
        {anyFilter && <button className="link small" onClick={() => setFacets({ subject: [], cls: [], strand: [], chapter: [], topic: [] })}>Clear filters</button>}
        <input className="search-in" placeholder="Filter by ID, name, topic or book chapter" value={text} onChange={(e) => setText(e.target.value)} />
        {items && <span className="muted small">{shown.length} of {ofKind.length}</span>}
        <span className="spacer" />
        {show === 'proposed' && canDecide && <>
          <button className="link small" onClick={() => setPicked(new Set(shown.map((i) => i.id)))} disabled={!shown.length}>Tick all shown</button>
          <button className="link small" onClick={() => setPicked(new Set())} disabled={!picked.size}>Clear</button>
          <button className="approve" disabled={busy || !picked.size} onClick={() => approveMany([...picked])}>Approve ticked · {picked.size}</button>
        </>}
      </div>
      {flash && <div className="notice small">{flash}</div>}
      {error && <p className="error">{error}</p>}
      {!items && !error && <p className="muted">Loading…</p>}
      <div className={`proposed-layout ${sel ? 'with-pane' : ''}`}>
        <div>
          {items && shown.length === 0 && <p className="muted">Nothing here.</p>}
          {items && shown.length > 0 && (
            <table className="list proposed-table">
              <thead><tr>{show === 'proposed' && canDecide && <th aria-label="Tick" />}<th>ID</th><th>Name</th><th>Class</th><th>Topic</th><th className="col-wide">Proposed by</th><th className="col-wide">Used by</th><th /></tr></thead>
              <tbody>
                {shown.slice(0, 500).map((i) => (
                  <tr key={i.id} className={`row-pick ${picked.has(i.id) ? 'picked' : ''} ${sel?.kind === i.kind && sel.id === i.id ? 'sel' : ''}`}
                    onClick={(e) => { if (!(e.target as HTMLElement).closest('button, input, a')) open(i.kind, i.id); }}>
                    {show === 'proposed' && canDecide && <td><input type="checkbox" aria-label={`Tick ${i.id}`} checked={picked.has(i.id)} onChange={() => tick(i.id)} /></td>}
                    <td className="mono nowrap">{i.kind === 'topic_class' ? i.id.replace('·', ' → ') : i.id}</td>
                    <td className="col-name" title={i.kind === 'topic_class' ? i.detail : undefined}><div className={`kind-line ${i.status === 'proposed' ? '' : 'decided'}`}>{kindLine({ ...i, via: null })}</div><div>{i.label}</div>
                      {i.detail && i.kind !== 'topic_class' && <div className="muted small">{i.detail}</div>}</td>
                    <td className="nowrap">{i.cls ? <>Class {i.cls}{i.via && <div className="muted small">{i.via}</div>}</> : <span className="muted">—</span>}</td>
                    <td className="col-topic">{i.topic_id ? <><a href={topicLink(i)}>{places?.topics.get(i.topic_id)?.name ?? i.topic_id}</a> <Id>{i.topic_id}</Id></> : <span className="muted">—</span>}</td>
                    <td className="small col-wide nowrap">{i.proposedBy.join(', ') || <span className="muted">—</span>}</td>
                    <td className="small col-wide nowrap" title={i.usedBy.join(', ')}>{i.usedBy.length ? `${i.usedBy.length} question${i.usedBy.length === 1 ? '' : 's'}` : <span className="muted">none</span>}</td>
                    <td className="nowrap">
                      {i.status === 'proposed' && canDecide && <><button className="approve small-btn" disabled={busy} onClick={() => approveMany([i.id])}>{i.kind === 'topic_class' ? 'Confirm' : 'Approve'}</button>{' '}
                        <button className="link small" disabled={busy} onClick={() => open(i.kind, i.id, true)}>{i.kind === 'topic_class' ? 'Reject' : 'Reject…'}</button></>}
                      {i.status !== 'proposed' && <button className="link small" onClick={() => open(i.kind, i.id)}>Details</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {items && shown.length > 500 && <p className="muted small">Showing the first 500 of {shown.length}; filter to narrow the list.</p>}
        </div>
        {sel && (
          <aside className="proposed-pane" aria-label="Item details">
            <CatalogueDetail key={`${sel.kind}:${sel.id}`} kind={sel.kind} id={sel.id} places={places} where="from the Proposed list" startReject={rejectId === sel.id}
              onDecided={() => setReload((x) => x + 1)} onOpenItem={(k, id) => open(k, id)} onClose={() => open(kind, null)} />
          </aside>
        )}
      </div>
      </>}
    </>
  );
}

function facetLabel(f: Facet, v: string, places: Places | null): string {
  if (v === NONE) return f === 'cls' ? 'No class' : `No ${f}`;
  if (f === 'subject') return subjectLabel(v) || (SUBJECTS.find((s) => s.id === v)?.label ?? v);
  if (f === 'cls') return `Class ${v}`;
  if (f === 'strand') return places?.strands.get(v)?.name ?? v;
  if (f === 'chapter') return `${places?.chapters.get(v)?.name ?? ''} · ${v}`;
  const t = places?.topics.get(v);
  return t ? `${t.name} · ${v} · C${t.class}` : v;
}

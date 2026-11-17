// Q22 (Sambit, 17 Nov 2026): the Decisions inbox: everything waiting for Sambit, with counts, filters and a link to where it
// is decided. Read-only; it does not replace any screen.
import { useEffect, useState } from 'react';
import { gatherDecisions, type DecisionCard } from './decisionsApi';

export function DecisionsScreen() {
  const [cards, setCards] = useState<DecisionCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ subject: '', cls: '' });
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => { setCards(null); gatherDecisions(f).then(setCards).catch((e) => setError(e.message)); }, [f]);
  const n = (c: DecisionCard) => c.total ?? c.items.length;
  const toggle = (k: string) => setOpen((x) => { const y = new Set(x); if (y.has(k)) y.delete(k); else y.add(k); return y; });
  return (
    <div className="decisions">
      <div className="topic-head"><h1>Decisions</h1>
        <div className="muted small">Everything waiting for you, gathered from the other screens. Nothing is decided here: each card links to where it is decided.</div></div>
      <div className="filters small">
        <select value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} aria-label="Subject"><option value="">All subjects</option><option value="math">Math</option><option value="science">Science</option><option value="grammar">English Grammar</option></select>
        <select value={f.cls} onChange={(e) => setF({ ...f, cls: e.target.value })} aria-label="Class"><option value="">All classes</option>{[1, 2, 3, 4, 5, 6].map((c) => <option key={c} value={c}>Class {c}</option>)}</select>
      </div>
      {error && <p className="error">Couldn't gather the decisions: {error}</p>}
      {!cards && !error && <p className="muted">Gathering…</p>}
      {cards && <>
        <p className="small"><strong>{cards.filter((c) => n(c) > 0).length}</strong> kinds of decision waiting · {cards.filter((c) => n(c) === 0).length} clear</p>
        <div className="decision-grid">
          {cards.map((c) => (
            <div key={c.key} className={`decision-card ${n(c) === 0 ? 'clear' : ''}`}>
              <div className="decision-head">
                <span className="decision-count">{n(c).toLocaleString('en-IN')}</span>
                <span className="decision-title">{c.title}</span>
              </div>
              {c.note && <div className="muted small">{c.note}</div>}
              {!c.filterable && (f.subject || f.cls) && <div className="muted small">(filters don't apply here)</div>}
              <div className="small">Decide in: <a href={c.where.href}>{c.where.label}</a></div>
              {c.items.length > 0 && <button className="link small" aria-expanded={open.has(c.key)} onClick={() => toggle(c.key)}>{open.has(c.key) ? '▾ Hide' : `▸ Show${c.items.length > 50 ? ' the first 50' : ''}`}</button>}
              {open.has(c.key) && <ul className="plain small decision-items">{c.items.slice(0, 50).map((i, k) => (
                <li key={`${i.id}-${k}`}><a href={i.href} className="mono">{i.id}</a>{i.label ? <span className="muted"> · {i.label.length > 90 ? `${i.label.slice(0, 90)}…` : i.label}</span> : null}</li>))}</ul>}
            </div>))}
        </div>
      </>}
    </div>
  );
}

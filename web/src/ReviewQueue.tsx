// Review tab (D6, 12 Nov 2026): questions flagged "Needs review" and rejected ones, with the
// note given (optional for Needs review, required for Reject). Drafts are reviewed in Browse
// (keys A / R / F, ↓↑); they are not listed here.
import { useEffect, useState } from 'react';
import { decideOverrides, overrideExtras, overrideRequests, reviewQueue, type OverrideExtras, type OverrideRequest } from './editApi';
import { browseHash, FLAG_FILTERS, matchesFlag, STATUS_LABEL, subjectLabel, subjectOfChapter, type FlagFilter } from './logic';
import { OriginFlags } from './AddQuestions';

type Item = Awaited<ReturnType<typeof reviewQueue>>[number];
type Show = 'all' | 'in_review' | 'rejected' | 'overrides';

export function ReviewQueue({ initial }: { initial?: string | null } = {}) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<Show>(initial === 'overrides' ? 'overrides' : 'all');
  const [flag, setFlag] = useState<FlagFilter>('all');
  const [nOverrides, setNOverrides] = useState<number | null>(null);
  useEffect(() => { overrideRequests().then((r) => setNOverrides(r.filter((x) => x.status === 'pending').length)).catch(() => setNOverrides(null)); }, []);
  useEffect(() => { reviewQueue().then(setItems).catch((e) => setError(e.message)); }, []);
  if (error) return <p className="error">Couldn't load the review queue: {error}</p>;
  if (!items) return <p className="muted">Loading…</p>;
  const shown = items.filter((i) => (show === 'all' || i.status === show) && matchesFlag(flag, i));
  const groups = new Map<string, Item[]>();
  for (const i of shown) { const k = `${i.subject}|${i.class}`; groups.set(k, [...(groups.get(k) ?? []), i]); }
  const age = (iso: string | null) => {
    if (!iso) return '';
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    return d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'} ago`;
  };
  const n = (s: Show) => (s === 'overrides' ? nOverrides ?? '…' : s === 'all' ? items.length : items.filter((i) => i.status === s).length);
  return (
    <>
      <div className="section-head">
        <h2>Review</h2>
        <div className="grades">
          {(['all', 'in_review', 'rejected', 'overrides'] as const).map((s) => (
            <button key={s} className={`pill ${s === show ? 'on' : ''} ${s === 'overrides' && nOverrides ? 'attention' : ''}`} aria-pressed={s === show} onClick={() => setShow(s)}>
              {s === 'all' ? 'All' : s === 'overrides' ? 'Overrides' : STATUS_LABEL[s]} · {n(s)}
            </button>
          ))}
          {show !== 'overrides' && <select className={`small-select ${flag !== 'all' ? 'active' : ''}`} aria-label="Flags" value={flag} onChange={(e) => setFlag(e.target.value as FlagFilter)}>
            {FLAG_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}{v !== 'all' ? ` · ${items.filter((i) => matchesFlag(v, i)).length}` : ''}</option>)}
          </select>}
        </div>
      </div>
      {show === 'overrides' ? <OverrideRequests onCount={setNOverrides} /> : <>
      <p className="muted small">Questions flagged <strong>Needs review</strong> and <strong>rejected</strong> ones, with their notes, oldest first.
        Drafts are reviewed in Browse: open a topic and use <kbd>A</kbd> approve · <kbd>R</kbd> reject · <kbd>F</kbd> needs review · <kbd>↓</kbd><kbd>↑</kbd>.
        A rejected question stays; edit it to make a new version.</p>
      {shown.length === 0 ? <p className="muted">{flag !== 'all' ? 'Nothing with this flag.' : 'Nothing flagged or rejected.'}</p> : [...groups.entries()].sort().map(([k, list]) => {
        const [subject, cls] = k.split('|');
        return (
          <div key={k} className="group">
            <div className="group-head static"><div className="group-title">{subjectLabel(subject!)} · Class {cls} · {list.length}</div></div>
            {list.map((i) => (
              <a key={i.question_id} className="qrow review-row" href={browseHash({ subject: subjectOfChapter(i.chapter_id), cls: String(i.class), ch: i.chapter_id, topic: i.topic_id, q: i.question_id })}>
                <span className="qid mono">{i.question_id}</span>
                <span className="review-main">
                  <span className="qtext">{i.text}</span>
                  <span className={`note small ${i.status}`}>
                    {i.status === 'rejected' ? 'Rejected' : '⚑ Needs review'}{i.note ? <>: <strong>{i.note}</strong></> : i.created_from === 'manual' ? <span className="muted"> (added by hand)</span> : i.created_from === 'upload' ? <span className="muted"> (uploaded from {i.upload_file})</span> : <span className="muted"> (no note)</span>}
                    <span className="muted"> · {i.topic_id}{i.file_key ? ` · ${i.file_key}` : ''} · {age(i.noted_at ?? i.version_created_at)}</span>
                  </span>
                </span>
                {i.bank === 'gold' && <span className="tag gold">Gold</span>}
                <OriginFlags q={i} compact />
                <span className={`lvl ${i.math_difficulty ?? ''}`}>{i.math_difficulty ?? '—'}</span>
                <span className="qstatus small">v{i.current_version}{i.approved_version ? ` · approved v${i.approved_version}` : ''}</span>
              </a>
            ))}
          </div>
        );
      })}
      </>}
    </>
  );
}

/**
 * Override requests (Sambit, 12 Nov 2026): near-copy fields whose values are standard and cannot
 * change, asked for by the data thread. Never applied automatically.
 * Q19 (17 Nov 2026): filters (reason, batch, class, field), tick boxes and Approve / Reject selected:
 * one transaction, one audit row per override; unticked ones stay Pending.
 */
export function OverrideRequests({ onCount }: { onCount?: (n: number) => void }) {
  const [rows, setRows] = useState<OverrideRequest[] | null>(null);
  const [extras, setExtras] = useState<OverrideExtras | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ reason: '', batch: '', cls: '', field: '' });
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState<'approve' | 'reject' | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    overrideRequests().then(async (r) => { setRows(r); onCount?.(r.filter((x) => x.status === 'pending').length); setExtras(await overrideExtras(r)); }).catch((e) => setError(e.message));
  }, [reload]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error && !rows) return <p className="error">Couldn't load override requests: {error}</p>;
  if (!rows) return <p className="muted">Loading…</p>;
  const batchOf = (r: OverrideRequest) => (r.import_id ? extras?.batch.get(r.import_id) ?? `import #${r.import_id}` : 'by hand');
  const pending = rows.filter((r) => r.status === 'pending'), decided = rows.filter((r) => r.status !== 'pending');
  const pass = (r: OverrideRequest) => (!f.reason || r.reason === f.reason) && (!f.batch || batchOf(r) === f.batch) && (!f.cls || String(r.class) === f.cls) && (!f.field || r.field === f.field);
  const shown = pending.filter(pass);
  const picked = shown.filter((r) => sel.has(r.request_id));
  const opts = (k: (r: OverrideRequest) => string) => [...valueCount(pending, k)].sort((a, b) => a[0].localeCompare(b[0]));
  const link = (r: OverrideRequest) => (r.chapter_id ? browseHash({ subject: subjectOfChapter(r.chapter_id), cls: String(r.class ?? 'all'), ch: r.chapter_id, topic: r.topic_id, q: r.question_id }) : `#/q/${r.question_id}`);
  const toggle = (id: number) => setSel((x) => { const n = new Set(x); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOn = shown.length > 0 && shown.every((r) => sel.has(r.request_id));
  async function decide(approve: boolean) {
    setBusy(true); setError(null); setDone(null);
    try {
      const r = await decideOverrides(picked.map((x) => x.request_id), approve, note.trim() || null);
      setDone(`${approve ? 'Approved' : 'Rejected'} ${r.decided} override${r.decided === 1 ? '' : 's'} (one audit record each).`);
      setSel(new Set()); setConfirm(null); setNote(''); setReload((x) => x + 1);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const cite = (r: OverrideRequest) => (r.check?.closest_ref ? extras?.citation.get(r.check.closest_ref) ?? r.check.closest_ref : '—');
  return (
    <>
      <p className="muted small">Near-copy fields whose values are standard and can't change (e.g. the ½, ¼, ¾ turns a skill is about), asked for by the data thread. Nothing is applied automatically.
        Approving one logs it as <span className="mono">override_near_copy</span> with its reason; the question can then be approved as usual. A rejected request leaves the near-copy blocking approval.</p>
      <div className="filters small override-filters">
        <select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}><option value="">All reasons</option>{opts((r) => r.reason).map(([v, n]) => <option key={v} value={v}>{v.length > 70 ? `${v.slice(0, 70)}…` : v} · {n}</option>)}</select>
        <select value={f.batch} onChange={(e) => setF({ ...f, batch: e.target.value })}><option value="">All imports</option>{opts(batchOf).map(([v, n]) => <option key={v} value={v}>{v} · {n}</option>)}</select>
        <select value={f.cls} onChange={(e) => setF({ ...f, cls: e.target.value })}><option value="">All classes</option>{opts((r) => String(r.class ?? '—')).map(([v, n]) => <option key={v} value={v}>Class {v} · {n}</option>)}</select>
        <select value={f.field} onChange={(e) => setF({ ...f, field: e.target.value })}><option value="">All fields</option>{opts((r) => r.field).map(([v, n]) => <option key={v} value={v}>{v} · {n}</option>)}</select>
        {(f.reason || f.batch || f.cls || f.field) && <button className="link" onClick={() => setF({ reason: '', batch: '', cls: '', field: '' })}>Clear filters</button>}
      </div>
      {pending.length === 0 ? <p className="muted">No pending override requests.</p> : <>
        <div className="override-bulk">
          <label className="check"><input type="checkbox" checked={allOn} onChange={() => setSel((x) => { const n = new Set(x); for (const r of shown) { if (allOn) n.delete(r.request_id); else n.add(r.request_id); } return n; })} /> Select all shown ({shown.length})</label>
          <span className="muted small">{picked.length} selected · {pending.length} pending in all</span>
          <button className="approve" disabled={!picked.length || busy} onClick={() => setConfirm('approve')}>Approve selected ({picked.length})</button>
          <button className="reject" disabled={!picked.length || busy} onClick={() => setConfirm('reject')}>Reject selected ({picked.length})</button>
        </div>
        {confirm && <div className="confirm-box small">
          <strong>{confirm === 'approve' ? 'Approve' : 'Reject'} {picked.length} override{picked.length === 1 ? '' : 's'}?</strong> Each gets its own audit record; unticked ones stay Pending.
          <input placeholder={confirm === 'reject' ? 'Note (required to reject)' : 'Note (optional)'} value={note} onChange={(e) => setNote(e.target.value)} />
          <button onClick={() => decide(confirm === 'approve')} disabled={busy || (confirm === 'reject' && !note.trim())}>{busy ? 'Working…' : `Yes, ${confirm} ${picked.length}`}</button>
          <button className="secondary" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button>
        </div>}
        {done && <p className="small ok">{done}</p>}
        {error && <p className="error small">{error}</p>}
        <table className="override-table small">
          <thead><tr><th></th><th>Key</th><th>Field</th><th>Score</th><th>Citation</th><th>Class</th><th>Reason</th><th>Import</th></tr></thead>
          <tbody>{shown.map((r) => (
            <tr key={r.request_id} className={sel.has(r.request_id) ? 'sel' : ''}>
              <td><input type="checkbox" aria-label={`Select ${r.file_key ?? r.question_id}`} checked={sel.has(r.request_id)} onChange={() => toggle(r.request_id)} /></td>
              <td><a href={link(r)} title={r.text ?? undefined}>{r.file_key ?? r.question_id}</a> <span className="muted mono">{r.question_id}</span></td>
              <td>{r.field}</td>
              <td>{r.check ? `${r.check.similarity ?? '—'}${r.check.same_numbers ? ' · same numbers' : ''}` : '—'}</td>
              <td>{cite(r)}</td>
              <td>{r.class ?? '—'}</td>
              <td className="override-reason">{r.reason}</td>
              <td className="muted">{batchOf(r)}</td>
            </tr>))}</tbody>
        </table>
      </>}
      {decided.length > 0 && <details className="override-decided"><summary>Decided · {decided.length}</summary>
        <table className="override-table small"><tbody>{decided.map((r) => (
          <tr key={r.request_id}><td><a href={link(r)}>{r.file_key ?? r.question_id}</a></td><td>{r.field}</td><td>{r.status === 'approved' ? 'Approved' : 'Rejected'}</td>
            <td className="muted">{r.decided_at ? new Date(r.decided_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}{r.decision_note ? ` — ${r.decision_note}` : ''}</td></tr>))}</tbody></table>
      </details>}
    </>
  );
}

function valueCount<T>(xs: T[], k: (x: T) => string) {
  const m = new Map<string, number>();
  for (const x of xs) m.set(k(x), (m.get(k(x)) ?? 0) + 1);
  return m;
}

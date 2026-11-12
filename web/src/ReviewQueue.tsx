// Review tab (D6, 12 Nov 2026): questions flagged "Needs review" and rejected ones, with the
// note given (optional for Needs review, required for Reject). Drafts are reviewed in Browse
// (keys A / R / F, ↓↑); they are not listed here.
import { useEffect, useState } from 'react';
import { decideOverride, overrideRequests, reviewQueue, type OverrideRequest } from './editApi';
import { browseHash, STATUS_LABEL, subjectLabel, subjectOfChapter } from './logic';

type Item = Awaited<ReturnType<typeof reviewQueue>>[number];
type Show = 'all' | 'in_review' | 'rejected' | 'overrides';

export function ReviewQueue() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<Show>('all');
  const [nOverrides, setNOverrides] = useState<number | null>(null);
  useEffect(() => { overrideRequests().then((r) => setNOverrides(r.filter((x) => x.status === 'pending').length)).catch(() => setNOverrides(null)); }, []);
  useEffect(() => { reviewQueue().then(setItems).catch((e) => setError(e.message)); }, []);
  if (error) return <p className="error">Couldn't load the review queue: {error}</p>;
  if (!items) return <p className="muted">Loading…</p>;
  const shown = items.filter((i) => show === 'all' || i.status === show);
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
        </div>
      </div>
      {show === 'overrides' ? <OverrideRequests onCount={setNOverrides} /> : <>
      <p className="muted small">Questions flagged <strong>Needs review</strong> and <strong>rejected</strong> ones, with their notes, oldest first.
        Drafts are reviewed in Browse: open a topic and use <kbd>A</kbd> approve · <kbd>R</kbd> reject · <kbd>F</kbd> needs review · <kbd>↓</kbd><kbd>↑</kbd>.
        A rejected question stays; edit it to make a new version.</p>
      {shown.length === 0 ? <p className="muted">Nothing flagged or rejected.</p> : [...groups.entries()].sort().map(([k, list]) => {
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
                    {i.status === 'rejected' ? 'Rejected' : '⚑ Needs review'}{i.note ? <>: <strong>{i.note}</strong></> : <span className="muted"> (no note)</span>}
                    <span className="muted"> · {i.topic_id}{i.file_key ? ` · ${i.file_key}` : ''} · {age(i.noted_at ?? i.version_created_at)}</span>
                  </span>
                </span>
                {i.bank === 'gold' && <span className="tag gold">Gold</span>}
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
 * change, asked for by the data thread. Never applied automatically: approve or decline each one.
 * Approving logs override_near_copy with the reason; the question can then be approved as usual.
 */
export function OverrideRequests({ onCount }: { onCount?: (n: number) => void }) {
  const [rows, setRows] = useState<OverrideRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => { overrideRequests().then((r) => { setRows(r); onCount?.(r.filter((x) => x.status === 'pending').length); }).catch((e) => setError(e.message)); }, [reload]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <p className="error">Couldn't load override requests: {error}</p>;
  if (!rows) return <p className="muted">Loading…</p>;
  const decide = async (r: OverrideRequest, approve: boolean) => {
    const note = (notes[r.request_id] ?? '').trim();
    if (!approve && !note) { setError('Declining an override needs a note.'); return; }
    setBusy(r.request_id); setError(null);
    try { await decideOverride(r.request_id, approve, note || null); setReload((x) => x + 1); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const pending = rows.filter((r) => r.status === 'pending'), done = rows.filter((r) => r.status !== 'pending');
  const link = (r: OverrideRequest) => (r.chapter_id ? browseHash({ subject: subjectOfChapter(r.chapter_id), cls: String(r.class ?? 'all'), ch: r.chapter_id, topic: r.topic_id, q: r.question_id }) : `#/q/${r.question_id}`);
  const row = (r: OverrideRequest) => (
    <div key={r.request_id} className={`override-row ${r.status}`}>
      <div className="override-main">
        <div><a className="mono" href={link(r)}>{r.question_id}</a> <span className="muted small">{r.file_key} · v{r.version_no}{r.current_version && r.version_no !== r.current_version ? ` (now v${r.current_version})` : ''}</span> · <strong>{r.field}</strong>
          {r.check && <span className={`small book-check-inline ${r.check.result}`}> · {r.check.result === 'near_copy' ? 'near-copy' : r.check.result} of {r.check.closest_ref} ({r.check.similarity}{r.check.same_numbers ? ', same numbers in the same order' : ''})</span>}</div>
        {r.text && <div className="small qtext-wrap">{r.text}</div>}
        <div className="small"><span className="muted">Reason ({r.requested_by}):</span> {r.reason}</div>
        {r.status !== 'pending' && <div className="small muted">{r.status === 'approved' ? 'Approved' : 'Declined'} {r.decided_at ? new Date(r.decided_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}{r.decision_note ? ` — ${r.decision_note}` : ''}</div>}
      </div>
      {r.status === 'pending' && (
        <div className="override-actions">
          <input placeholder="Note (needed to decline)" value={notes[r.request_id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.request_id]: e.target.value })} />
          <button className="approve" disabled={busy === r.request_id} onClick={() => decide(r, true)}>Approve override</button>
          <button className="reject" disabled={busy === r.request_id} onClick={() => decide(r, false)}>Decline</button>
        </div>
      )}
    </div>
  );
  return (
    <>
      <p className="muted small">Near-copy fields whose values are standard and can't change (e.g. the ½, ¼, ¾ turns a skill is about), asked for by the data thread. Nothing is applied automatically.
        Approving one logs it as <span className="mono">override_near_copy</span> with its reason; the question can then be approved as usual. A declined request leaves the near-copy blocking approval.</p>
      {pending.length === 0 ? <p className="muted">No pending override requests.</p> : <div className="group">{pending.map(row)}</div>}
      {done.length > 0 && <><h3>Decided</h3><div className="group">{done.map(row)}</div></>}
    </>
  );
}

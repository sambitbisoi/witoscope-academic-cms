// Review status per topic (Sambit, 13 Nov 2026): icons for the tree and the curriculum map, and
// the topic-header control (explicit Save, like the rest of the CMS). Manual only.
import { useEffect, useState } from 'react';
import { REVIEW_STATUSES, rollUpTitle, type ReviewFilter, type ReviewStatus, type RollUp } from './logic';
import type { TopicReview } from './api';
import { setTopicReview } from './editApi';
import { supabase } from './supabase';

/** Topic: green ✓ = done, orange ◐ = in progress, nothing = not started. */
export function TopicReviewIcon({ status }: { status: ReviewStatus }) {
  if (status === 'not_started') return null;
  return <span className={`rv-icon ${status === 'done' ? 'done' : 'partial'}`} title={status === 'done' ? 'Review: done' : 'Review: in progress'} aria-label={status === 'done' ? 'Review done' : 'Review in progress'}>{status === 'done' ? '✓' : '◐'}</span>;
}

/** Chapter / strand within a class: green ✓ when every core topic is done, orange ◐ when started, nothing otherwise. */
export function RollUpIcon({ r }: { r: RollUp | undefined }) {
  if (!r || r.state === 'none') return null;
  return <span className={`rv-icon ${r.state}`} title={rollUpTitle(r)} aria-label={rollUpTitle(r)}>{r.state === 'done' ? '✓' : '◐'}</span>;
}

export function ReviewFilterSelect({ value, onChange }: { value: ReviewFilter; onChange: (v: ReviewFilter) => void }) {
  return (
    <select className={`small-select ${value !== 'all' ? 'active' : ''}`} aria-label="Review status" value={value} onChange={(e) => onChange(e.target.value as ReviewFilter)}>
      <option value="all">Review status: all</option>
      {REVIEW_STATUSES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
    </select>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Topic header: ○ Not started · ◐ In progress · ✓ Done, an optional note, and an explicit Save. */
export function ReviewControl({ topicId, review, onSaved }: { topicId: string; review: TopicReview | undefined; onSaved: () => void }) {
  const saved = { status: review?.status ?? 'not_started', note: review?.note ?? '' };
  const [status, setStatus] = useState<ReviewStatus>(saved.status);
  const [note, setNote] = useState(saved.note);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(null);
  useEffect(() => { setStatus(saved.status); setNote(saved.note); setErr(null); }, [topicId, review?.status, review?.note]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { supabase.auth.getUser().then(({ data }) => setMe(data.user?.id ?? null)).catch(() => {}); }, []);
  const dirty = status !== saved.status || note.trim() !== saved.note;
  const save = async () => {
    setBusy(true); setErr(null);
    try { await setTopicReview(topicId, status, note.trim() || null); onSaved(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="review-control small">
      <span className="muted">Review status</span>
      <div className="seg" role="radiogroup" aria-label="Review status">
        {REVIEW_STATUSES.map((x) => (
          <button key={x.id} role="radio" aria-checked={status === x.id} className={`seg-btn ${x.id} ${status === x.id ? 'on' : ''}`} onClick={() => setStatus(x.id)}>
            <span aria-hidden>{x.icon}</span> {x.label}
          </button>
        ))}
      </div>
      <input className="review-note" placeholder="Note (optional)" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
      {dirty && <><button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        <button className="link" disabled={busy} onClick={() => { setStatus(saved.status); setNote(saved.note); }}>Cancel</button></>}
      {!dirty && review && <span className="muted">Set {when(review.updated_at)}{review.updated_by && review.updated_by === me ? ' by you' : ''}</span>}
      {err && <span className="error">{err}</span>}
    </div>
  );
}

// Review tab (D6, 12 Nov 2026): questions flagged "Needs review" and rejected ones, with the
// note given (optional for Needs review, required for Reject). Drafts are reviewed in Browse
// (keys A / R / F, ↓↑); they are not listed here.
import { useEffect, useState } from 'react';
import { reviewQueue } from './editApi';
import { browseHash, STATUS_LABEL, subjectLabel, subjectOfChapter } from './logic';

type Item = Awaited<ReturnType<typeof reviewQueue>>[number];
type Show = 'all' | 'in_review' | 'rejected';

export function ReviewQueue() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<Show>('all');
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
  const n = (s: Show) => (s === 'all' ? items.length : items.filter((i) => i.status === s).length);
  return (
    <>
      <div className="section-head">
        <h2>Review</h2>
        <div className="grades">
          {(['all', 'in_review', 'rejected'] as const).map((s) => (
            <button key={s} className={`pill ${s === show ? 'on' : ''}`} aria-pressed={s === show} onClick={() => setShow(s)}>
              {s === 'all' ? 'All' : STATUS_LABEL[s]} · {n(s)}
            </button>
          ))}
        </div>
      </div>
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
    </>
  );
}

// Phase 5: drafts and versions in review, oldest first, grouped by subject and class.
import { useEffect, useState } from 'react';
import { reviewQueue } from './editApi';
import { browseHash, STATUS_LABEL, subjectLabel, subjectOfChapter } from './logic';

type Item = Awaited<ReturnType<typeof reviewQueue>>[number];

export function ReviewQueue() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'all' | 'draft' | 'in_review'>('all');
  useEffect(() => { reviewQueue().then(setItems).catch((e) => setError(e.message)); }, []);
  if (error) return <p className="error">Couldn't load the review queue: {error}</p>;
  if (!items) return <p className="muted">Loading…</p>;
  const shown = items.filter((i) => status === 'all' || i.status === status);
  const groups = new Map<string, Item[]>();
  for (const i of shown) { const k = `${i.subject}|${i.class}`; groups.set(k, [...(groups.get(k) ?? []), i]); }
  const age = (iso: string) => { const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); return d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'}`; };
  return (
    <>
      <div className="section-head">
        <h2>Review queue</h2>
        <div className="grades">
          {(['all', 'draft', 'in_review'] as const).map((s) => (
            <button key={s} className={`pill ${s === status ? 'on' : ''}`} aria-pressed={s === status} onClick={() => setStatus(s)}>
              {s === 'all' ? `All · ${items.length}` : `${STATUS_LABEL[s]} · ${items.filter((i) => i.status === s).length}`}
            </button>
          ))}
        </div>
      </div>
      <p className="muted small">Drafts and versions in review, oldest first. Open one to read it, edit it, submit, approve or reject it.</p>
      {shown.length === 0 ? <p className="muted">Nothing waiting.</p> : [...groups.entries()].sort().map(([k, list]) => {
        const [subject, cls] = k.split('|');
        return (
          <div key={k} className="group">
            <div className="group-head"><div className="group-title">{subjectLabel(subject!)} · Class {cls} · {list.length}</div></div>
            {list.map((i) => (
              <a key={i.question_id} className="qrow" href={browseHash({ subject: subjectOfChapter(i.chapter_id), cls: String(i.class), topic: i.topic_id, q: i.question_id })}>
                <span className="qid mono">{i.question_id}</span>
                <span className="qtext">{i.text}</span>
                {i.bank === 'gold' && <span className="tag gold">Gold</span>}
                <span className={`lvl ${i.math_difficulty ?? ''}`}>{i.math_difficulty ?? '—'}</span>
                <span className="qstatus small">{STATUS_LABEL[i.status]} v{i.current_version}{i.approved_version ? ` · approved v${i.approved_version}` : ''} · {age(i.version_created_at)}</span>
              </a>
            ))}
          </div>
        );
      })}
    </>
  );
}

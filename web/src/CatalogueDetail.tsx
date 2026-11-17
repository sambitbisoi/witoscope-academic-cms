// Review UX (15 Nov 2026), Q8: one catalogue item in the right-hand pane — name, description, class,
// topic / chapter, linked items, the questions that use it, source and history — with Approve,
// Reject (reason) and Edit. Decisions go through the existing audited functions (catalogueApi.decide).
import { Fragment, useEffect, useState } from 'react';
import { decidable, decide, itemDetail, kindLine, KIND_LABEL, type CatKind, type ItemDetail, type Places } from './catalogueApi';
import { CurriculumForm } from './CurriculumForms';
import { Id } from './Id';
import { browseHash, STATUS_LABEL, subjectOfChapter } from './logic';
import { ClassTag, LevelTag } from './Tags';

const STATUS_TEXT: Record<string, string> = { proposed: 'Proposed', active: 'Approved (active)', retired: 'Rejected / retired', draft: 'Draft' };
const EDITABLE: Partial<Record<CatKind, 'concept' | 'typical_set' | 'pattern'>> = { concept: 'concept', typical_set: 'typical_set', pattern: 'pattern' };

export function CatalogueDetail({ kind, id, places, where, startReject, onDecided, onOpenItem, onOpenQuestion, onClose }: {
  kind: CatKind; id: string; places?: Places | null; /** for the audit reason: "from the Proposed list" / "in Browse" */ where: string;
  /** open with the reject reason showing */ startReject?: boolean;
  onDecided: (kind: CatKind, id: string, status: 'active' | 'retired' | 'proposed') => void;
  onOpenItem?: (kind: CatKind, id: string) => void; onOpenQuestion?: (questionId: string) => void; onClose?: () => void;
}) {
  const [d, setD] = useState<ItemDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [rejecting, setRejecting] = useState(!!startReject);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setRejecting(!!startReject); }, [startReject, kind, id]);
  useEffect(() => {
    setError(null);
    itemDetail(kind, id, places ?? undefined).then(setD).catch((e) => { setError(e.message); setD(null); });
  }, [kind, id, reload, places]);

  async function act(status: 'active' | 'retired' | 'proposed') {
    if (status === 'retired' && kind !== 'topic_class' && !reason.trim()) { setError('Give a reason for the reject.'); return; }
    setBusy(true); setError(null);
    try {
      await decide(kind, id, status, reason, where);
      setFlash(status === 'active' ? 'Approved.' : status === 'retired' ? 'Rejected (retired; kept, and it can be put back to proposed).' : 'Back to proposed.');
      setRejecting(false); setReason('');
      onDecided(kind, id, status);
      setReload((x) => x + 1);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (d === undefined) return <div className="detail cat-detail"><p className="muted">Loading {id}…</p></div>;
  if (d === null) return <div className="detail cat-detail">{error ? <p className="error">Couldn't load {id}: {error}</p> : <p>{KIND_LABEL[kind]} {id} doesn't exist.</p>}</div>;
  const topicHref = (topicId: string) => browseHash({ subject: subjectOfChapter(d.chapter?.chapter_id ?? 'MC'), cls: 'all', ch: d.chapter?.chapter_id ?? null, topic: topicId });
  const proposed = d.status === 'proposed';
  const edit = EDITABLE[kind];
  return (
    <div className="detail cat-detail">
      <div className="detail-head">
        <div>
          <div className="eyebrow">{kindLine({ kind, id, status: d.status, cls: d.cls, via: d.via, topic_id: d.topic?.topic_id ?? null })}</div>
          <div className="detail-id">{d.name} <Id>{kind === 'topic_class' ? id.replace('·', ' → Class ') : id}</Id></div>
        </div>
        <div className="right small">
          <span className={`tag ${proposed ? 'proposed' : d.status === 'retired' ? 'blocked' : 'created'}`}>{STATUS_TEXT[d.status] ?? d.status}</span>
          {onClose && <div><button className="link small" onClick={onClose}>Close ✕</button></div>}
        </div>
      </div>
      {d.description && <p className="cat-desc">{d.description}</p>}

      <dl className="facts cat-facts">
        <dt>Kind</dt><dd>{KIND_LABEL[kind]}</dd>
        {kind !== 'setting' && <><dt>Class</dt><dd>{d.cls ? <ClassTag cls={d.cls} what={KIND_LABEL[kind].toLowerCase()} via={d.via ?? undefined} /> : <span className="muted">—</span>}
          {d.classNote && <span className="muted small" title="Q24: the lowest Level of the book questions that test it (the catalogued class is kept)"> · {d.classNote}</span>}</dd></>}
        {d.topic && <><dt>Topic</dt><dd><a href={topicHref(d.topic.topic_id)}>{d.topic.name}</a> <Id>{d.topic.topic_id}</Id> <span className="muted small">· Class {d.topic.class}</span></dd></>}
        {d.chapter && <><dt>Chapter</dt><dd>{d.chapter.name} <Id>{d.chapter.chapter_id}</Id></dd></>}
        {d.facts.map((f) => <Fragment key={f.k}><dt>{f.k}</dt><dd>{f.v}</dd></Fragment>)}
        <dt>Source</dt><dd>{d.proposedBy.length ? d.proposedBy.join(', ') : <span className="muted">—</span>}</dd>
      </dl>

      {flash && <div className="notice small">{flash}</div>}
      {error && <p className="error small">{error}</p>}
      <div className="cat-actions">
        {proposed && decidable(kind) && <>
          <button className="approve" disabled={busy} onClick={() => act('active')}>Approve</button>
          {!rejecting && <button className="reject" disabled={busy} onClick={() => setRejecting(true)}>Reject…</button>}
        </>}
        {proposed && kind === 'setting' && <p className="muted small">Settings can't be approved here yet: there is no approval path for them. Shown for information.</p>}
        {!proposed && decidable(kind) && !(kind === 'topic_class' && d.status === 'active') && <button className="link small" disabled={busy} onClick={() => act('proposed')}>Back to proposed</button>}
        {edit && !editing && <button className="link small" onClick={() => setEditing(true)}>Edit</button>}
      </div>
      {rejecting && proposed && decidable(kind) && (
        <div className="cat-reject">
          <label className="small" htmlFor={`rej-${id}`}>Reason for the reject {kind === 'topic_class' ? '' : '(required, kept in the log)'}</label>
          <textarea id={`rej-${id}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} disabled={kind === 'topic_class'}
            placeholder={kind === 'topic_class' ? 'Topic–class links take no reason this round' : 'e.g. duplicate of G5-FRC-C1'} />
          {kind === 'topic_class' && <p className="muted small">Topic–class links can't store a reason yet (the existing function has none). The reject is still logged.</p>}
          <div><button className="reject" disabled={busy || (kind !== 'topic_class' && !reason.trim())} onClick={() => act('retired')}>Reject</button>{' '}
            <button className="link small" onClick={() => { setRejecting(false); setReason(''); setError(null); }}>Cancel</button></div>
          <p className="muted small">Reject retires the item: it is kept with its ID and history, and can be put back to proposed.</p>
        </div>
      )}
      {editing && edit && <CurriculumForm key={`${edit}-${id}`} kind={edit} id={id} options={{ typical_set_id: d.setOptions }}
        onDone={(saved) => { setEditing(false); if (saved) setReload((x) => x + 1); }} />}

      {d.linked.filter((l) => l.items.length).map((l) => (
        <div key={l.label} className="cat-linked">
          <div className="eyebrow">{l.label} · {l.items.length}</div>
          <ul className="plain small">
            {l.items.map((x) => <li key={x.id}>
              {x.kind && onOpenItem ? <button className="link" onClick={() => onOpenItem(x.kind!, x.id)}>{x.id}</button> : <span className="mono">{x.id}</span>} {x.name}
              {x.status === 'proposed' && <span className="tag proposed">Proposed</span>}{x.status === 'retired' && <span className="tag">retired</span>}</li>)}
          </ul>
        </div>
      ))}

      <div className="cat-linked">
        <div className="eyebrow">{kind === 'topic_class' ? 'Questions on this topic' : 'Questions that use it'} · {d.questions.length}{d.questionsMore ? '+' : ''}</div>
        {d.questions.length === 0 ? <p className="muted small">None yet.{d.usedBy.length ? ` The pipeline named ${d.usedBy.length} question key${d.usedBy.length === 1 ? '' : 's'}: ${d.usedBy.slice(0, 6).join(', ')}${d.usedBy.length > 6 ? ' …' : ''}` : ''}</p> : (
          <ul className="plain cat-qs">
            {d.questions.map((q) => <li key={q.question_id}>
              {onOpenQuestion ? <button className="link mono" onClick={() => onOpenQuestion(q.question_id)}>{q.question_id}</button> : <a className="mono" href={`#/q/${encodeURIComponent(q.question_id)}`}>{q.question_id}</a>}
              <LevelTag q={q} ceiling={null} />
              <span className="muted small"> {STATUS_LABEL[q.status] ?? q.status}</span>
              <div className="small cat-qtext">{q.text.length > 120 ? `${q.text.slice(0, 120)}…` : q.text}</div>
            </li>)}
          </ul>
        )}
        {d.questionsMore && <p className="muted small">Showing the first {d.questions.length}.</p>}
      </div>

      {d.history.length > 0 && (
        <div className="cat-linked">
          <div className="eyebrow">History</div>
          <ul className="plain small">
            {d.history.map((h) => <li key={h.review_id}><span className="muted">{new Date(h.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span> · {h.action.replace(/_/g, ' ')}{h.reason ? ` · ${h.reason}` : ''} · {h.by_label}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Q8 in topic views: a proposed header's chip — "Proposed question type · Class 3" — that opens the item in the right-hand pane. */
export function ProposedChip({ kind, id, cls, via, onOpen }: { kind: CatKind; id: string; cls: number | null; via?: string | null; onOpen: (kind: CatKind, id: string) => void }) {
  return (
    <button type="button" className="tag proposed chip-btn" title="Proposed: not approved yet. Click to see its details and approve or reject it."
      onClick={(e) => { e.stopPropagation(); onOpen(kind, id); }}>
      {kindLine({ kind, id, status: 'proposed', cls, via: via ?? null, topic_id: null })}
    </button>
  );
}

/** Q9: Approve / Reject (reason) on a proposed header, in place (existing audited function). */
export function InlineDecide({ kind, id, where, onDone }: { kind: CatKind; id: string; where: string; onDone: (status: 'active' | 'retired') => void }) {
  const [mode, setMode] = useState<'idle' | 'reject'>('idle');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(status: 'active' | 'retired') {
    setBusy(true); setError(null);
    try { await decide(kind, id, status, reason, where); onDone(status); setMode('idle'); setReason(''); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <span className="inline-decide" onClick={stop} onKeyDown={stop}>
      {mode === 'idle' ? <>
        <button className="approve" disabled={busy} onClick={() => act('active')} title={`Approve this ${KIND_LABEL[kind].toLowerCase()} (logged)`}>Approve</button>
        <button className="reject" disabled={busy} onClick={() => setMode('reject')}>Reject…</button>
      </> : <>
        <input aria-label="Reason for the reject" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        <button className="reject" disabled={busy || !reason.trim()} onClick={() => act('retired')}>Reject</button>
        <button className="link small" onClick={() => { setMode('idle'); setReason(''); setError(null); }}>Cancel</button>
      </>}
      {error && <span className="error small">{error}</span>}
    </span>
  );
}

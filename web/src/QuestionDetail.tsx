import { useEffect, useRef, useState } from 'react';
import { questionDetail, type QuestionDetailData } from './api';
import { browseHash, classesLabel, derivedRows, involvementOf, signatureRows, STATUS_LABEL, subjectOfChapter, TAG_LABEL } from './logic';
import { latestOriginality, officialLink, sourceItems, type OriginalityCheck } from './sourcesApi';
import { questionFromDb } from '../../shared/fromDb.ts';
import { structureDiff } from '../../shared/save.ts';
import { textsOf } from '../../shared/version.ts';
import { bundleOf, retire, setStatus } from './editApi';
import { supabase } from './supabase';

/** A keyboard review command from Browse (D6): A approve · R reject · F needs review. */
export interface ReviewCommand { kind: 'approve' | 'reject' | 'flag'; n: number }

export function QuestionDetail({ id, versionNo, onVersion, onEdit, reloadKey = 0, onChanged, command, onAdvance }: {
  id: string; versionNo: number | null; onVersion: (v: number | null) => void; onEdit?: () => void; reloadKey?: number; onChanged?: () => void;
  command?: ReviewCommand | null; onAdvance?: () => void;
}) {
  const [d, setD] = useState<QuestionDetailData | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [compare, setCompare] = useState<number | null>(null);
  useEffect(() => {
    setD(undefined); setError(null);
    questionDetail(id, versionNo).then(setD).catch((e) => setError(e.message));
  }, [id, versionNo, reloadKey, tick]);

  if (error) return <p className="error">Couldn't load {id}: {error}</p>;
  if (d === undefined) return <p className="muted">Loading {id}…</p>;
  if (d === null) return <p>Question {id} doesn't exist.</p>;

  const { question: q, version: v } = d;
  const isCurrent = v.version_no === q.current_version;
  const labelOf = (part: string) => (part ? `(${part}) ` : '');
  const answerBlocks = d.parts.length
    ? d.parts.map((p) => ({ part: p.part_label, text: p.text, format: p.format, correct: p.correct, accepted: p.accepted }))
    : [{ part: '', text: null as string | null, format: v.format, correct: v.correct ?? '', accepted: v.accepted }];

  return (
    <div className="detail">
      <div className="detail-head">
        <div>
          <div className="detail-id">{q.question_id}{q.bank === 'gold' && <span className="tag gold">Gold · never published</span>}
            {classesLabel(d.topicClasses) && <span className="pill-multi" title="Its topic is taught in several classes">{classesLabel(d.topicClasses)}</span>}</div>
          <div className="muted small">{q.file_key ? `${q.file_key} · ` : ''}{v.format}</div>
        </div>
        <div className="muted small right">
          {STATUS_LABEL[v.status] ?? v.status} · v{v.version_no}{!isCurrent && <> of {q.current_version}</>}
          {q.approved_version && q.approved_version !== v.version_no ? <> · approved v{q.approved_version}</> : null}
          {q.retired_at && <strong> · retired</strong>}
        </div>
      </div>
      {isCurrent && <Actions key={v.version_id} d={d} onEdit={onEdit} onChanged={() => { setTick((t) => t + 1); onChanged?.(); }} command={command} onAdvance={onAdvance} />}
      {!isCurrent && <div className="notice small">You're looking at an older version. <button className="link" onClick={() => onVersion(null)}>Show current (v{q.current_version})</button></div>}

      <div className="preview">
        <div className="eyebrow">Preview (as the child sees it)</div>
        <div className="stem">{v.text}</div>
        {v.image_path && <FigureImage path={v.image_path} alt={v.figure_description ?? 'Figure'} />}
        {v.figure_description && (
          <div className="figure small">
            <span className="tag">{v.image_status === 'has_image' ? 'Image' : 'Image needed'}</span> {v.figure_description}
          </div>
        )}
        {answerBlocks.map((a) => {
          const opts = d.options.filter((o) => o.part_label === a.part);
          const wrong = d.wrong.filter((w) => w.part_label === a.part);
          return (
            <div key={a.part || 'q'} className="answer-block">
              {a.text && <div className="part-text">{a.text}</div>}
              {opts.length > 0 ? (
                <div className="options">
                  {opts.map((o) => {
                    const w = wrong.find((x) => x.value === o.text || x.option_position === o.position);
                    return (
                      <div key={o.position} className={`option ${o.is_correct ? 'correct' : ''}`}>
                        <span className="opt-label">{String.fromCharCode(64 + o.position)} · {o.text}{o.is_correct ? ' ✓' : ''}</span>
                        <span className="small muted">{o.is_correct ? 'Correct' : w ? <Tag w={w} d={d} /> : <span className="untagged">Not tagged</span>}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="typed small">
                  {a.text ? '' : labelOf(a.part)}Answer: <strong>{a.correct}</strong> <span className="muted">({a.format}{a.accepted?.length ? `; also accepted: ${a.accepted.join(', ')}` : ''})</span>
                  {wrong.length > 0 && (
                    <ul className="wrong-list">{wrong.map((w, i) => <li key={i}><strong>{w.value}</strong> — <Tag w={w} d={d} /></li>)}</ul>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Section title="Solution">
        {d.solutions.map((s) => (
          <div key={s.slot} className="small sol">
            {s.slot === 2 && <span className="muted">{s.type ?? 'Second way'}{s.strategy ? ` · ${s.strategy}` : ''}: </span>}
            <span className="prewrap">{s.text}</span>
          </div>
        ))}
      </Section>
      {d.hints.length > 0 && (
        <Section title="Hints (after a wrong answer)">
          <ol className="hints small">{d.hints.map((h) => <li key={h.level} className="prewrap">{h.text}</li>)}</ol>
        </Section>
      )}

      <div className="tint-box signature">
        <div className="tint-title">Signature — review</div>
        <KV rows={signatureRows(v, d.insightName)} />
      </div>
      <div className="tint-box derived">
        <div className="tint-title">Derived <span className="muted small">(computed on save)</span></div>
        <KV rows={derivedRows(v)} />
      </div>

      <Section title="Concepts · involvement (main 1.0 · secondary 0.5 · minor 0.2)">
        {d.concepts.length === 0 ? <div className="muted small">None.</div> : (
          <ul className="plain small">
            {[...d.concepts].sort((a, b) => a.part_label.localeCompare(b.part_label) || b.involvement - a.involvement).map((c) => (
              <li key={`${c.part_label}-${c.concept_id}`}>
                {c.part_label && <span className="muted">({c.part_label}) </span>}
                <span className="mono">{c.concept_id}</span> {d.conceptNames.get(c.concept_id)?.name ?? ''}<Proposed status={d.conceptNames.get(c.concept_id)?.status} />{' '}
                <span className="muted inv" title={involvementOf(c.involvement).title}>{involvementOf(c.involvement).label} {Number(c.involvement).toFixed(1)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Placement">
        <div className="placement small">
          <div><span className="muted">Level</span> <strong>{q.level ?? '—'}</strong>{q.level ? ` (written for class ${q.level})` : ` (not set yet; class ${q.class} is used)`}</div>
          <div><span className="muted">Appears in</span>{' '}
            {d.placements.length === 0 ? <strong className="error">no class: the level is above every class its topic is in</strong>
              : d.placements.map((pl, i) => <span key={pl.class}>{i > 0 && ' · '}
                <a href={browseHash({ subject: subjectOfChapter(q.chapter_id), cls: String(pl.class), ch: q.chapter_id, topic: q.topic_id, q: q.question_id })}>Class {pl.class}</a>
                <span className="muted"> ({pl.is_home ? 'home' : 'revision'})</span></span>)}
          </div>
          <div><span className="muted">Setting</span> {d.setting ? <><strong>{d.setting.name}</strong>{d.setting.status === 'proposed' && <Proposed status="proposed" />}
            {q.setting_confidence && <span className="muted"> · {q.setting_confidence} confidence</span>}{q.setting_note && <span className="muted"> · {q.setting_note}</span>}</> : <span className="muted">—</span>}</div>
          <div><span className="muted">Clone group</span>{' '}
            {d.clones.length > 1 ? <>{d.clones.findIndex((c) => c.question_id === q.question_id) + 1} of {d.clones.length} clones ·{' '}
              {d.clones.filter((c) => c.question_id !== q.question_id).slice(0, 8).map((c, i) => <span key={c.question_id}>{i > 0 && ', '}<a href={`#/q/${c.question_id}`}>{c.question_id}</a></span>)}
              {d.clones.length > 9 && ' …'}</>
              : <span className="muted">{q.pattern_id ? 'no clones (unique signature in its pattern)' : '— (no pattern)'}</span>}</div>
        </div>
        <KV one rows={[
          { k: 'Topic', v: d.topic ? `${d.topic.topic_id} · ${d.topic.name}` : (v.topic_id ?? q.topic_id) },
          { k: 'Class', v: `${q.class}${q.class_override ? ` (shown in class ${q.class_override})` : ''}` },
          { k: 'Typical set', v: d.set ? `${d.set.typical_set_id} · ${d.set.name}${d.set.status === 'proposed' ? ' · PROPOSED (not approved)' : ''}` : '—' },
          { k: 'Pattern', v: d.pattern ? `${d.pattern.pattern_id} · ${d.pattern.name}${d.pattern.status === 'proposed' ? ' · PROPOSED (not approved)' : ''}` : '—' },
          { k: 'Clone batch', v: q.clone_batch_id ?? '—' },
          { k: 'Duration', v: v.duration_s ? `${v.duration_s} s` : '—' },
          ...(q.placement_note ? [{ k: 'Placement note', v: q.placement_note }] : []),
        ]} />
      </Section>

      <div className="background-divider"><span>Background — tagging, sources, history</span></div>
      <div className="background">
          <Section title={`Tagging${v.tagged_by ? ` (by ${v.tagged_by})` : ''}`}>
            {v.tagging_summary && <div className="small prewrap">{v.tagging_summary}</div>}
            {v.tagging_why && Object.keys(v.tagging_why).length > 0 ? (
              <ul className="plain small">{Object.entries(v.tagging_why).map(([k, w]) => <li key={k}><strong>{k}</strong> <span className="muted">({w.confidence})</span>: {w.why}</li>)}</ul>
            ) : !v.tagging_summary && <div className="muted small">No tagging notes.</div>}
            {v.author_notes && <div className="small"><span className="muted">Author notes:</span> {v.author_notes}</div>}
          </Section>
          {d.gold && (
            <Section title="Gold set">
              <KV rows={[
                { k: 'Use', v: d.gold.use === 'prompt_example' ? 'Prompt example' : 'Test only' },
                ...(d.gold.old_qid ? [{ k: 'Old IDs', v: d.gold.old_qid }] : []),
                ...(d.gold.review_verdict ? [{ k: 'Verdict', v: d.gold.review_verdict }] : []),
              ]} />
              {d.gold.final_reasoning && <div className="small prewrap"><span className="muted">Final reasoning:</span> {d.gold.final_reasoning}</div>}
              {d.gold.review_notes && <div className="small prewrap"><span className="muted">Review notes:</span> {d.gold.review_notes}</div>}
            </Section>
          )}
          <Section title="Source refs (internal, never published)">
            {d.refs.length === 0 ? <div className="muted small">None.</div> : <Refs refs={d.refs} />}
            <BookCheck versionId={d.version.version_id} bank={d.question.bank} />
          </Section>
          <Section title="Versions">
            <ul className="plain small">
              {d.versions.map((x) => (
                <li key={x.version_no}>
                  {x.version_no === v.version_no ? <strong>v{x.version_no}</strong> : <button className="link" onClick={() => onVersion(x.version_no === q.current_version ? null : x.version_no)}>v{x.version_no}</button>}
                  {' '}· {STATUS_LABEL[x.status] ?? x.status} · {x.created_from} · {new Date(x.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                  {x.edited_at && <span className="muted"> · edited</span>}
                  {x.version_no !== v.version_no && <> · <button className="link" onClick={() => setCompare(compare === x.version_no ? null : x.version_no)}>{compare === x.version_no ? 'hide comparison' : `compare with v${v.version_no}`}</button></>}
                </li>
              ))}
            </ul>
            {compare !== null && <Compare id={q.question_id} a={compare} b={v.version_no} />}
          </Section>
          <Section title="Audit log">
            {d.reviews.length === 0 ? <div className="muted small">Nothing logged yet.</div> : (
              <ul className="plain small">{d.reviews.map((r) => (
                <li key={r.review_id}>{new Date(r.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} {r.target_id.split(' ')[1] ? ` · ${r.target_id.split(' ')[1]}` : ''} · {ACTION_LABEL[r.action] ?? r.action.replace(/_/g, ' ')} · {r.by_label}{r.reason ? <span className="muted"> — {r.reason}</span> : null}{r.action === 'import_update' && r.field_diff ? <span className="muted"> ({Object.entries(r.field_diff as Record<string, { before: unknown; after: unknown }>).map(([k, x]) => `${k} ${String(x.before ?? '—')} → ${String(x.after ?? '—')}`).join(', ')})</span> : null}</li>
              ))}</ul>
            )}
          </Section>
      </div>
    </div>
  );
}

/** Source refs resolved to their citations (book, page, section, item; never the item's text). */
function Refs({ refs }: { refs: QuestionDetailData['refs'] }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof sourceItems>> | null>(null);
  const [sources, setSources] = useState<Map<string, { source_id: string; title: string; kind: 'pdf' | 'scanned_pdf' | 'web'; url: string | null; page_offset: number }>>(new Map());
  useEffect(() => {
    sourceItems(refs.map((r) => r.ref_id)).then(async (it) => {
      setItems(it);
      const ids = [...new Set(it.map((x) => x.source_id))];
      if (!ids.length) return;
      const { data } = await supabase.from('cms_sources').select('source_id, title, kind, url, page_offset').in('source_id', ids);
      setSources(new Map((data ?? []).map((x) => [x.source_id, x])));
    }).catch(() => setItems([]));
  }, [refs.map((r) => r.ref_id).join()]);
  return (
    <ul className="plain small">
      {refs.map((r) => {
        const it = items?.find((x) => x.ref_id === r.ref_id);
        const src = it ? sources.get(it.source_id) : undefined;
        const link = src && it?.page ? officialLink(src, it.page + src.page_offset) : null;
        return (
          <li key={r.ref_id + r.relation} className="ref">
            <span className="mono">{r.ref_id}</span> · {r.relation.replace('_', ' ')}
            {items === null ? null : !it ? <span className="muted"> · not in the CMS yet</span> : (
              <>
                {src && <> · {src.title}</>}{it.page ? `, p${it.page}` : ''}{it.section ? ` · §${it.section}` : ''}{it.item_label ? ` · ${it.item_label}` : ''}
                {link && <> <a href={link} target="_blank" rel="noopener noreferrer">official ↗</a></>}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The local originality check of this version (run on Sambit's Mac; citations and scores only). */
function BookCheck({ versionId, bank }: { versionId: number; bank: string }) {
  const [c, setC] = useState<OriginalityCheck | null | undefined>(undefined);
  useEffect(() => { latestOriginality(versionId).then(setC).catch(() => setC(undefined)); }, [versionId]);
  if (bank === 'gold' || c === undefined) return null; // best-effort; gold is never published
  const when = c ? new Date(c.checked_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  return (
    <div className={`small book-check ${c?.result ?? 'none'}`}>
      Book check: {!c ? <span className="muted">not run yet · on your Mac: <span className="mono">npm run check:originality -- --unchecked</span></span>
        : c.result === 'clear' ? <>clear ({when}; closest {c.closest_ref}, {c.similarity})</>
        : c.result === 'near_copy' ? <strong>near-copy{c.field && c.field !== 'text' ? ` (${c.field})` : ''} of {c.closest_ref} (similarity {c.similarity}{c.same_numbers ? ', same numbers in the same order' : ''}; {when}) · rewrite it before approving</strong>
        : c.result === 'flagged' ? <strong>close{c.field && c.field !== 'text' ? ` (${c.field})` : ''} to {c.closest_ref} (similarity {c.similarity}{c.same_numbers ? ', same numbers' : ''}; {when}) · make sure it is original</strong>
        : <span className="muted">no book for this chapter on your Mac ({when})</span>}
    </div>
  );
}

function Tag({ w, d }: { w: QuestionDetailData['wrong'][number]; d: QuestionDetailData }) {
  const m = w.misconception_id ? d.misconceptions.get(w.misconception_id) : null;
  const c = w.target_concept_id ? d.conceptNames.get(w.target_concept_id) : null;
  return (
    <span title={w.why ?? undefined}>
      {TAG_LABEL[w.tag] ?? w.tag}
      {w.misconception_id && <> · <span className="mono">{w.misconception_id}</span>{m ? ` ${m.description}` : ''}<Proposed status={m?.status} /></>}
      {w.target_concept_id && <> · <span className="mono">{w.target_concept_id}</span>{c ? ` ${c.name}` : ''}<Proposed status={c?.status} /></>}
      {w.why && !m && <span className="muted"> · {w.why}</span>}
    </span>
  );
}

const ACTION_LABEL: Record<string, string> = { submit: 'needs review', withdraw: 'review flag cleared', reject: 'rejected', approve: 'approved', import_update: 'updated by import' };

/**
 * D6 (12 Nov 2026): Edit · Needs review · Approve · Reject on the current version. Needs review
 * takes an optional note; Reject needs a comment; both show in the Review tab. Nothing is
 * deleted and there is no Retire button here (a question retired earlier can be restored).
 * Keyboard (from Browse): A / R / F; after a keyboard action Browse moves to the next question.
 */
function Actions({ d, onEdit, onChanged, command, onAdvance }: { d: QuestionDetailData; onEdit?: () => void; onChanged: () => void; command?: ReviewCommand | null; onAdvance?: () => void }) {
  const [ask, setAsk] = useState<null | 'reject' | 'flag' | 'restore' | 'override'>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [override, setOverride] = useState(false);
  const [check, setCheck] = useState<OriginalityCheck | null>(null);
  const viaKey = useRef(false);
  const mounted = useRef(Date.now());
  const q = d.question, v = d.version;
  useEffect(() => { setCheck(null); setOverride(false); latestOriginality(v.version_id).then(setCheck).catch(() => setCheck(null)); }, [v.version_id]);
  const nearCopy = check?.result === 'near_copy';
  const open = v.status === 'draft' || v.status === 'in_review';
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try {
      await f(); setAsk(null); setReason('');
      const advance = viaKey.current; viaKey.current = false;
      onChanged();
      if (advance) onAdvance?.();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const approve = () => (nearCopy ? setAsk('override') : run(() => setStatus(q.question_id, v.version_no, 'approve', null)));
  useEffect(() => {
    if (!command || command.n < mounted.current || busy || q.retired_at || !open) return;
    viaKey.current = true;
    if (command.kind === 'approve') approve();
    else if (command.kind === 'reject') { setReason(''); setAsk('reject'); }
    else if (command.kind === 'flag' && v.status === 'draft') { setReason(''); setAsk('flag'); }
  }, [command?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.retired_at) {
    return (
      <div className="actions">
        <span className="muted small">Retired (hidden from coverage and Publish; nothing is deleted).</span>
        {ask === 'restore' ? null : <button className="secondary" onClick={() => setAsk('restore')}>Restore…</button>}
        {ask === 'restore' && <Reason label="Why restore it?" value={reason} set={setReason} busy={busy} go={() => run(() => retire(q.question_id, false, reason))} cancel={() => setAsk(null)} />}
        {err && <div className="error small">{err}</div>}
      </div>
    );
  }
  return (
    <div className="actions">
      {onEdit && <button className="secondary" onClick={onEdit}>Edit</button>}
      {v.status === 'draft' && <button className="secondary flag" disabled={busy} onClick={() => { viaKey.current = false; setAsk(ask === 'flag' ? null : 'flag'); }} title="F">Needs review…</button>}
      {v.status === 'in_review' && <button className="secondary flag on" disabled={busy} title="Clear the Needs review flag (back to draft)" onClick={() => run(() => setStatus(q.question_id, v.version_no, 'withdraw', null))}>⚑ Needs review · clear</button>}
      {open && <>
        <button className="approve" disabled={busy} title="A" onClick={() => { viaKey.current = false; approve(); }}>Approve{nearCopy ? '…' : ''}</button>
        <button className="reject" disabled={busy} title="R" onClick={() => { viaKey.current = false; setAsk(ask === 'reject' ? null : 'reject'); }}>Reject…</button>
      </>}
      {v.status === 'approved' && <span className="muted small">Approved. Edit makes a new version (a typo fix keeps this one).</span>}
      {v.status === 'rejected' && <span className="muted small">Rejected. Edit to make a new version.</span>}
      {q.bank === 'production' && <a className="small" href={`#/generate?q=${encodeURIComponent(q.question_id)}`}>Generate similar</a>}
      {ask === 'flag' && <Reason label="Needs review: note (optional; shown in the Review tab)" optional value={reason} set={setReason} busy={busy} go={() => run(() => setStatus(q.question_id, v.version_no, 'submit', reason.trim() || null))} cancel={() => { viaKey.current = false; setAsk(null); }} />}
      {ask === 'reject' && <Reason label="Why reject it? (required; kept with the version and shown in the Review tab)" value={reason} set={setReason} busy={busy} go={() => run(() => setStatus(q.question_id, v.version_no, 'reject', reason))} cancel={() => { viaKey.current = false; setAsk(null); }} />}
      {ask === 'override' && (
        <div className="reason override">
          <div className="small error">Near-copy of {check?.closest_ref} (similarity {check?.similarity}{check?.same_numbers ? ', same numbers in the same order' : ''}). Approve only if you have compared it with the book yourself.</div>
          <label className="check small"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> override: reviewed, not a copy</label>
          <label className="small">Why is it not a copy? (logged)<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <button className="approve" disabled={busy || !override || !reason.trim()} onClick={() => run(() => setStatus(q.question_id, v.version_no, 'approve', reason, true))}>Approve with override</button>{' '}
          <button className="link" onClick={() => { viaKey.current = false; setAsk(null); setOverride(false); }}>Cancel</button>
        </div>
      )}
      {err && <div className="error small">{err}</div>}
    </div>
  );
}

function Reason({ label, value, set, busy, go, cancel, optional }: { label: string; value: string; set: (s: string) => void; busy: boolean; go: () => void; cancel: () => void; optional?: boolean }) {
  const ok = optional || !!value.trim();
  return (
    <div className="reason">
      <label className="small">{label}<input autoFocus value={value} onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && ok && !busy) { e.preventDefault(); go(); } if (e.key === 'Escape') { e.preventDefault(); cancel(); } }} /></label>
      <button disabled={busy || !ok} onClick={go}>Confirm</button> <button className="link" onClick={cancel}>Cancel</button>
      <span className="muted small">Enter to confirm · Esc to cancel</span>
    </div>
  );
}

/** U1: our own figure image, through /api/files (a 5-minute signed link). Best effort. */
function FigureImage({ path, alt }: { path: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setSrc(null); setFailed(false);
    if (!path.startsWith('figures/')) { setFailed(true); return; }
    fetch(`/api/files/sign?key=${encodeURIComponent(path)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { url: string }) => setSrc(j.url)).catch(() => setFailed(true));
  }, [path]);
  if (failed) return <div className="figure-img missing small muted">Figure image {path} isn't available here{import.meta.env.DEV ? ' (start the local file service: npm run dev:files)' : ''}.</div>;
  if (!src) return <div className="figure-img small muted">Loading the figure…</div>;
  return <div className="figure-img"><img src={src} alt={alt} onError={() => setFailed(true)} /></div>;
}

/** Field-by-field comparison of two versions, using the shared structure and texts. */
function Compare({ id, a, b }: { id: string; a: number; b: number }) {
  const [rows, setRows] = useState<{ k: string; before: string; after: string }[] | null>(null);
  useEffect(() => {
    Promise.all([questionDetail(id, a), questionDetail(id, b)]).then(([x, y]) => {
      if (!x || !y) { setRows([]); return; }
      const qa = questionFromDb(bundleOf(x)), qb = questionFromDb(bundleOf(y));
      const ta = textsOf(qa), tb = textsOf(qb);
      const out = structureDiff(qa, qb).map((k) => {
        const pick = (q: typeof qa) => JSON.stringify(k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], q as unknown) ?? null);
        return { k, before: pick(qa), after: pick(qb) };
      });
      for (const k of new Set([...Object.keys(ta), ...Object.keys(tb)])) if (ta[k] !== tb[k]) out.push({ k, before: ta[k] ?? '—', after: tb[k] ?? '—' });
      setRows(out);
    }).catch(() => setRows([]));
  }, [id, a, b]);
  if (!rows) return <div className="muted small">Comparing…</div>;
  return (
    <div className="compare small">
      <div className="muted">v{a} → v{b}{rows.length === 0 ? ': no differences' : ''}</div>
      {rows.map((r) => <div key={r.k}><span className="muted">{r.k}:</span> <del>{r.before}</del> → <ins>{r.after}</ins></div>)}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="dsec"><div className="eyebrow">{title}</div>{children}</div>;
}

/** Catalogue items proposed by the book pipeline (migration 0018): usable as tags, not approved. */
export function Proposed({ status }: { status?: string | null }) {
  return status === 'proposed' ? <span className="tag proposed" title="Proposed by the book pipeline; not approved yet">Proposed</span> : null;
}

function KV({ rows, one }: { rows: { k: string; v: string }[]; one?: boolean }) {
  return <dl className={`kv${one ? ' one' : ''}`}>{rows.map((r) => <div key={r.k}><dt>{r.k}</dt><dd>{r.v}</dd></div>)}</dl>;
}

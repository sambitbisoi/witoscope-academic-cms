import { useEffect, useRef, useState, type ReactNode } from 'react';
import { questionDetail, type QuestionDetailData } from './api';
import { browseHash, classesLabel, derivedRows, involvementOf, signatureRows, STATUS_LABEL, subjectOfChapter, TAG_LABEL } from './logic';
import { latestOriginality, officialLink, sourceItems, type OriginalityCheck } from './sourcesApi';
import { questionFromDb } from '../../shared/fromDb.ts';
import { structureDiff } from '../../shared/save.ts';
import { textsOf } from '../../shared/version.ts';
import { bundleOf, retire, setStatus } from './editApi';
import { supabase } from './supabase';
import { OriginFlags } from './AddQuestions';
import { Id } from './Id';
import { scienceDetail } from './scienceApi';

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
      {q.subject === 'science' ? <ScienceBody d={d} isCurrent={isCurrent} onVersion={onVersion}
        actions={isCurrent ? <Actions key={v.version_id} d={d} onEdit={onEdit} onChanged={() => { setTick((t) => t + 1); onChanged?.(); }} command={command} onAdvance={onAdvance} /> : null} /> : <>
      {!isCurrent && <div className="notice small">You're looking at an older version. <button className="link" onClick={() => onVersion(null)}>Show current (v{q.current_version})</button></div>}
      {isCurrent && <Actions key={v.version_id} d={d} onEdit={onEdit} onChanged={() => { setTick((t) => t + 1); onChanged?.(); }} command={command} onAdvance={onAdvance} />}

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
          { k: 'Chapter', v: d.topic ? <>{d.topic.cms_chapters?.name ?? ''} <Id>{d.topic.chapter_id}</Id></> : q.chapter_id },
          { k: 'Topic', v: d.topic ? <>{d.topic.name} <Id>{d.topic.topic_id}</Id></> : (v.topic_id ?? q.topic_id) },
          { k: 'Class', v: `${q.class}${q.class_override ? ` (shown in class ${q.class_override})` : ''}` },
          { k: 'Typical set', v: d.set ? `${d.set.typical_set_id} · ${d.set.name}${d.set.status === 'proposed' ? ' · PROPOSED (not approved)' : ''}` : '—' },
          { k: 'Pattern', v: d.pattern ? `${d.pattern.pattern_id} · ${d.pattern.name}${d.pattern.status === 'proposed' ? ' · PROPOSED (not approved)' : ''}` : '—' },
          { k: 'Clone batch', v: q.clone_batch_id ?? '—' },
          { k: 'Duration', v: v.duration_s ? `${v.duration_s} s` : '—' },
          ...(q.placement_note ? [{ k: 'Placement note', v: q.placement_note }] : []),
        ]} />
      </Section>

      {isCurrent && d.flags && <PendingBanners f={d.flags} gold={q.bank === 'gold'} />}
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

      </>}
      <details className="background-fold">
        <summary className="background-divider"><span>Background — tagging, sources, history</span></summary>
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
      </details>
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
/** "NCERT-class-6-chapter-4 p7" (a PDF page) → "Curiosity … Ch 4, p.67" (the printed page, as Taught in shows it);
 *  "… PDF p.7" when the page can't be converted; a book item ID stays as it is. */
async function bookPage(ref: string): Promise<string> {
  const m = ref.match(/^(\S+) p(\d+)$/);
  if (!m) return ref;
  const { data } = await supabase.from('cms_sources').select('title, page_offset').eq('source_id', m[1]!).maybeSingle();
  const pdf = Number(m[2]);
  if (!data) return `${m[1]}, PDF p.${pdf}`;
  const printed = pdf - Number(data.page_offset ?? 0);
  return printed > 0 ? `${data.title}, p.${printed}` : `${data.title}, PDF p.${pdf}`;
}

function BookCheck({ versionId, bank }: { versionId: number; bank: string }) {
  const [c, setC] = useState<OriginalityCheck | null | undefined>(undefined);
  const [ov, setOv] = useState<{ field: string; status: string; reason: string }[]>([]);
  const [where, setWhere] = useState<string | null>(null);
  useEffect(() => {
    latestOriginality(versionId).then((x) => { setC(x); if (x?.closest_ref) bookPage(x.closest_ref).then(setWhere).catch(() => setWhere(null)); }).catch(() => setC(undefined));
    supabase.from('cms_override_requests').select('field, status, reason').eq('version_id', versionId).order('request_id').then(({ data }) => setOv(data ?? []));
  }, [versionId]);
  if (bank === 'gold' || c === undefined) return null; // best-effort; gold is never published
  const when = c ? new Date(c.checked_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  return (
    <div className={`small book-check ${c?.result ?? 'none'}`}>
      Book check: {!c ? <span className="muted">not run yet · on your Mac: <span className="mono">npm run check:originality -- --unchecked</span></span>
        : c.result === 'clear' ? <>clear ({when}; closest {where ?? c.closest_ref}, {c.similarity})</>
        : c.result === 'near_copy' ? <strong>near-copy{c.field && c.field !== 'text' ? ` (${c.field})` : ''} of {where ?? c.closest_ref} (similarity {c.similarity}{c.same_numbers ? ', same numbers in the same order' : ''}; {when}) · rewrite it before approving</strong>
        : c.result === 'flagged' ? <strong>close{c.field && c.field !== 'text' ? ` (${c.field})` : ''} to {where ?? c.closest_ref} (similarity {c.similarity}{c.same_numbers ? ', same numbers' : ''}; {when}) · make sure it is original</strong>
        : <span className="muted">no book for this chapter on your Mac ({when})</span>}
      {ov.map((o, i) => <div key={i}>Override of the {o.field}: <strong>{o.status === 'pending' ? 'requested, waiting for you (Review → Overrides)' : o.status}</strong> <span className="muted">— {o.reason}</span></div>)}
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
  const [overrides, setOverrides] = useState<{ field: string; status: string }[]>([]);
  useEffect(() => {
    setCheck(null); setOverride(false); latestOriginality(v.version_id).then(setCheck).catch(() => setCheck(null));
    supabase.from('cms_override_requests').select('field, status').eq('version_id', v.version_id).then(({ data }) => setOverrides(data ?? []));
  }, [v.version_id]);
  // an override approved one by one in Review → Overrides covers the near-copy (the SQL checks it too)
  const overridden = overrides.some((o) => o.status === 'approved' && (!check?.field || o.field === check.field));
  const nearCopy = check?.result === 'near_copy' && !overridden;
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
  // 13 Nov 2026: "Approved" means ready for the app: no approval while the book check, the picture
  // (production only) or the attributes are pending. The SQL trigger enforces the same rules.
  const blockers = approvalBlockers(d.flags, q.bank);
  const approve = () => (blockers.length ? setErr(`Can't approve yet: ${blockers.join('; ')}.`) : nearCopy ? setAsk('override') : run(() => setStatus(q.question_id, v.version_no, 'approve', null)));
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
        <button className={`approve ${blockers.length ? 'blocked' : ''}`} disabled={busy || blockers.length > 0} aria-disabled={busy || blockers.length > 0} title={blockers.length ? `Can't approve yet: ${blockers.join('; ')}` : 'A'} onClick={() => { viaKey.current = false; approve(); }}>Approve{nearCopy ? '…' : ''}</button>
        <button className="reject" disabled={busy} title="R" onClick={() => { viaKey.current = false; setAsk(ask === 'reject' ? null : 'reject'); }}>Reject…</button>
      </>}
      {open && blockers.length > 0 && <span className="muted small blockers">Approve is off until: {blockers.join(' · ')}</span>}
      {v.status === 'approved' && <span className="muted small">Approved. Edit makes a new version (a typo fix keeps this one).</span>}
      {v.status === 'rejected' && <span className="muted small">Rejected. Edit to make a new version.</span>}
      {q.bank === 'production' && q.subject !== 'science' && <a className="small" href={`#/generate?q=${encodeURIComponent(q.question_id)}`}>Generate similar</a>}
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

function KV({ rows, one }: { rows: { k: string; v: ReactNode }[]; one?: boolean }) {
  return <dl className={`kv${one ? ' one' : ''}`}>{rows.map((r) => <div key={r.k}><dt>{r.k}</dt><dd>{r.v}</dd></div>)}</dl>;
}

/** 13 Nov 2026: what is still open on a question added by hand or uploaded. */
/** Why a version can't be approved yet ("Approved" = ready for the app). Pictures and attributes don't apply to gold. */
function approvalBlockers(f: QuestionDetailData['flags'], bank: string): string[] {
  if (!f) return [];
  const out: string[] = [];
  if (f.originality_pending) out.push('originality check pending (runs on the Mac)');
  if (bank === 'production' && f.image_pending) out.push('picture pending');
  if (bank === 'production' && f.attributes_pending) out.push('attributes pending');
  return out;
}

function PendingBanners({ f, gold }: { f: NonNullable<QuestionDetailData['flags']>; gold: boolean }) {
  const added = f.created_from === 'manual' || f.created_from === 'upload';
  if (!added && !f.originality_pending && (gold || (!f.image_pending && !f.attributes_pending))) return null;
  return (
    <div className="pending-banners small">
      {added && <div className="origin-line"><OriginFlags q={f} /></div>}
      {!gold && f.attributes_pending && <div className="banner pending">Attributes pending: the signature and derived fields are not evaluated yet, so this question is left out of clone groups and can't be approved. Edit it and fill in the signature to evaluate them.</div>}
      {!gold && f.image_pending && <div className="banner pending">Image pending: a picture is needed and not added yet (see the figure description), so it can't be approved.</div>}
      {f.originality_pending && <div className="banner pending orig">Originality pending: the book check has not run yet, so it can't be approved. It runs on the Mac: <span className="mono">npm run check:originality -- --pending</span>.</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Science (13 Nov 2026; docs/science-plan.md §4)
const PENDING = <span className="muted">Pending</span>;
const SCIENCE_ATTRS: { k: string; col: 'reading' | 'steps' | 'inhibition' | 'has_irrelevant_info' | 'visual'; label: string }[] = [
  { k: 'Reading load', col: 'reading', label: '1–5' }, { k: 'Steps', col: 'steps', label: 'count' }, { k: 'Misconception pull', col: 'inhibition', label: 'inhibition 0–3' },
  { k: 'Irrelevant info', col: 'has_irrelevant_info', label: 'yes / no' }, { k: 'Visual', col: 'visual', label: '0–3' },
];

/** Column (c) for a Science question: Linked content first, then attributes, preview, safety, taught in, buttons. */
function ScienceBody({ d, isCurrent, onVersion, actions }: { d: QuestionDetailData; isCurrent: boolean; onVersion: (v: number | null) => void; actions: ReactNode }) {
  const [x, setX] = useState<Awaited<ReturnType<typeof scienceDetail>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { question: q, version: v } = d;
  useEffect(() => { setX(null); scienceDetail(v.version_id).then(setX).catch((e) => setErr(e.message)); }, [v.version_id]);
  const vr = v as unknown as Record<string, unknown>;
  const attr = (c: (typeof SCIENCE_ATTRS)[number]['col']) => (vr[c] === null || vr[c] === undefined ? PENDING : typeof vr[c] === 'boolean' ? (vr[c] ? 'yes' : 'no') : String(vr[c]));
  const subj = subjectOfChapter(q.chapter_id);
  // Order (Sambit, 14 Nov 2026): actions · preview · explanation · misconception · safety / taught in / level and placement
  // · the boxes (attributes pending · linked content · attributes) · background (folded, shared with Math)
  const hasCites = !!x && (x.citations.length > 0 || !!x.version.confidence);
  return (
    <>
      {!isCurrent && <div className="notice small">You're looking at an older version. <button className="link" onClick={() => onVersion(null)}>Show current (v{q.current_version})</button></div>}
      {actions}
      {err && <p className="error small">Couldn't load the linked content: {err}</p>}

      <div className="preview">
        <div className="eyebrow">Preview (as the child sees it){x?.version.display_format ? ` · ${x.version.display_format}` : ''}</div>
        <div className="stem">{v.text}</div>
        {v.image_path && <FigureImage path={v.image_path} alt={v.figure_description ?? 'Figure'} />}
        {v.figure_description && <div className="figure small prewrap"><span className="tag">{v.image_status === 'has_image' ? 'Image' : 'Image needed'}</span> {v.figure_description}</div>}
        <div className="options">
          {d.options.filter((o) => o.part_label === '').map((o) => (
            <div key={o.position} className={`option ${o.is_correct ? 'correct' : ''}`}><span className="opt-label">{String.fromCharCode(64 + o.position)} · {o.text}{o.is_correct ? ' ✓' : ''}</span></div>
          ))}
        </div>
      </div>
      {d.solutions[0] && <Section title="Explanation"><div className="small prewrap">{d.solutions[0].text}</div></Section>}
      {x?.version.misconception_targeted && <Section title="Misconception targeted"><div className="small">{x.version.misconception_targeted}</div></Section>}
      {x?.version.safety_note && <Section title="Safety note"><div className="small banner safety">{x.version.safety_note}</div></Section>}
      {hasCites && <Section title="Taught in (citations)">
        {x!.citations.length > 0 && <ul className="plain small">{x!.citations.map((c, i) => (
          <li key={i}>{c.for_row_id && <span className="mono muted">{c.for_row_id}: </span>}{x!.sources.get(c.source_id)?.title ?? c.source_id}, p.{c.page_from}{c.page_to !== c.page_from ? `–${c.page_to}` : ''}
            {/^Claude-added/.test(c.raw) && <span className="muted"> (Claude-added, extends this page)</span>}</li>))}</ul>}
        {x!.version.confidence && <div className="muted small">Confidence: {x!.version.confidence}</div>}
      </Section>}
      <Section title="Level / class and placement">
        <KV one rows={[
          { k: 'Level (class)', v: q.level ? `${q.level} (written for class ${q.level})` : '—' },
          { k: 'Class', v: String(q.class) },
          { k: 'Chapter', v: d.topic ? <>{d.topic.cms_chapters?.name ?? ''} <Id>{d.topic.chapter_id}</Id></> : q.chapter_id },
          { k: 'Topic', v: d.topic ? <>{d.topic.name} <Id>{d.topic.topic_id}</Id></> : q.topic_id },
        ]} />
      </Section>

      {isCurrent && d.flags && <PendingBanners f={d.flags} gold={q.bank === 'gold'} />}
      <div className="tint-box linked">
        <div className="tint-title">Linked content{x ? ` · ${x.links.filter((l) => l.role === 'direct').length} direct · ${x.links.filter((l) => l.role === 'supporting').length} supporting` : ''}</div>
        {!x ? <div className="muted small">Loading…</div> : x.links.length === 0 ? <div className="muted small">No content rows linked.</div> : (
          <ul className="plain linked-rows">
            {x.links.map((l) => (
              <li key={l.row_id} className={`linked-row ${l.role}`}>
                <div className="small"><span className={`tag role-${l.role}`}>{l.role}</span>
                  {l.row && <> <span className="muted">{l.row.type} · {l.row.chapter_role} · {l.row.source === 'Claude-added' ? <span className="tag claude">Claude-added</span> : `Book · ${l.row.found_in === 'Both' ? 'NCERT + DAV' : l.row.found_in === 'DAV only' ? 'DAV' : l.row.found_in ?? '—'}`}</span>
                    {l.row.question_use !== 'OK' && <span className="tag use">{l.row.question_use}</span>}</>}
                  {' '}<a className="small" href={browseHash({ subject: subj, cls: String(l.row?.row_class ?? 'all'), topic: l.row?.topic_id ?? q.topic_id, row: l.row_id, q: q.question_id, tab: 'content' })}><Id>{l.row_id}</Id></a></div>
                {l.row ? <div className="linked-text">{l.row.content}</div> : <div className="muted small">Row not found.</div>}
                {l.row?.misconceptions && <div className="small"><span className="muted">Misconception:</span> {l.row.misconceptions}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="tint-box signature">
        <div className="tint-title">Attributes{d.flags?.attributes_pending ? <span className="muted small"> · pending</span> : ''}</div>
        <KV rows={[
          ...SCIENCE_ATTRS.map((a) => ({ k: a.k, v: attr(a.col) })),
          { k: 'Tier', v: x?.version.level_tier ?? '—' },
          { k: 'Level (class)', v: q.level ?? '—' },
        ]} />
      </div>

    </>
  );
}

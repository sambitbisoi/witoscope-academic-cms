import { useEffect, useState } from 'react';
import { questionDetail, type QuestionDetailData } from './api';
import { derivedRows, signatureRows, STATUS_LABEL, TAG_LABEL } from './logic';

export function QuestionDetail({ id, versionNo, onVersion }: { id: string; versionNo: number | null; onVersion: (v: number | null) => void }) {
  const [d, setD] = useState<QuestionDetailData | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    setD(undefined); setError(null);
    questionDetail(id, versionNo).then(setD).catch((e) => setError(e.message));
  }, [id, versionNo]);

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
          <div className="detail-id">{q.question_id}{q.bank === 'gold' && <span className="tag gold">Gold · never published</span>}</div>
          <div className="muted small">{q.file_key ? `${q.file_key} · ` : ''}{v.format}</div>
        </div>
        <div className="muted small right">
          {STATUS_LABEL[v.status] ?? v.status} · v{v.version_no}{!isCurrent && <> of {q.current_version}</>}
          {q.approved_version && q.approved_version !== v.version_no ? <> · approved v{q.approved_version}</> : null}
          {q.retired_at && <strong> · retired</strong>}
        </div>
      </div>
      {!isCurrent && <div className="notice small">You're looking at an older version. <button className="link" onClick={() => onVersion(null)}>Show current (v{q.current_version})</button></div>}

      <div className="preview">
        <div className="eyebrow">Preview (as the child sees it)</div>
        <div className="stem">{v.text}</div>
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

      <Section title="Signature (v10)">
        <KV rows={signatureRows(v, d.insightName)} />
      </Section>
      <Section title="Derived">
        <KV rows={derivedRows(v)} />
      </Section>

      <Section title="Concepts">
        {d.concepts.length === 0 ? <div className="muted small">None.</div> : (
          <ul className="plain small">
            {[...d.concepts].sort((a, b) => a.part_label.localeCompare(b.part_label) || b.involvement - a.involvement).map((c) => (
              <li key={`${c.part_label}-${c.concept_id}`}>
                {c.part_label && <span className="muted">({c.part_label}) </span>}
                <span className="mono">{c.concept_id}</span> {d.conceptNames.get(c.concept_id)?.name ?? ''} <span className="muted">× {Number(c.involvement).toFixed(1)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Placement">
        <KV one rows={[
          { k: 'Topic', v: d.topic ? `${d.topic.topic_id} · ${d.topic.name}` : (v.topic_id ?? q.topic_id) },
          { k: 'Class', v: `${q.class}${q.class_override ? ` (shown in class ${q.class_override})` : ''}` },
          { k: 'Typical set', v: d.set ? `${d.set.typical_set_id} · ${d.set.name}` : '—' },
          { k: 'Pattern', v: d.pattern ? `${d.pattern.pattern_id} · ${d.pattern.name}` : '—' },
          { k: 'Clone batch', v: q.clone_batch_id ?? '—' },
          { k: 'Duration', v: v.duration_s ? `${v.duration_s} s` : '—' },
          ...(q.placement_note ? [{ k: 'Placement note', v: q.placement_note }] : []),
        ]} />
      </Section>

      <button className="link more" aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'Less' : 'More'}: tagging notes, sources, history</button>
      {more && (
        <>
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
            {d.refs.length === 0 ? <div className="muted small">None.</div> : <ul className="plain small">{d.refs.map((r) => <li key={r.ref_id + r.relation}><span className="mono">{r.ref_id}</span> · {r.relation.replace('_', ' ')}</li>)}</ul>}
          </Section>
          <Section title="Versions">
            <ul className="plain small">
              {d.versions.map((x) => (
                <li key={x.version_no}>
                  {x.version_no === v.version_no ? <strong>v{x.version_no}</strong> : <button className="link" onClick={() => onVersion(x.version_no === q.current_version ? null : x.version_no)}>v{x.version_no}</button>}
                  {' '}· {STATUS_LABEL[x.status] ?? x.status} · {x.created_from} · {new Date(x.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                  {x.edited_at && <span className="muted"> · edited</span>}
                </li>
              ))}
            </ul>
          </Section>
          {d.reviews.length > 0 && (
            <Section title="Audit log">
              <ul className="plain small">{d.reviews.map((r) => (
                <li key={r.review_id}>{new Date(r.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {r.target_id.split(' ')[1]} · {r.action.replace(/_/g, ' ')} · {r.by_label}{r.reason ? <span className="muted"> — {r.reason}</span> : null}</li>
              ))}</ul>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function Tag({ w, d }: { w: QuestionDetailData['wrong'][number]; d: QuestionDetailData }) {
  const m = w.misconception_id ? d.misconceptions.get(w.misconception_id) : null;
  const c = w.target_concept_id ? d.conceptNames.get(w.target_concept_id) : null;
  return (
    <span title={w.why ?? undefined}>
      {TAG_LABEL[w.tag] ?? w.tag}
      {w.misconception_id && <> · <span className="mono">{w.misconception_id}</span>{m ? ` ${m.description}` : ''}</>}
      {w.target_concept_id && <> · <span className="mono">{w.target_concept_id}</span>{c ? ` ${c.name}` : ''}</>}
      {w.why && !m && <span className="muted"> · {w.why}</span>}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="dsec"><div className="eyebrow">{title}</div>{children}</div>;
}

function KV({ rows, one }: { rows: { k: string; v: string }[]; one?: boolean }) {
  return <dl className={`kv${one ? ' one' : ''}`}>{rows.map((r) => <div key={r.k}><dt>{r.k}</dt><dd>{r.v}</dd></div>)}</dl>;
}

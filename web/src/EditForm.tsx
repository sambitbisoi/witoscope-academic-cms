// Phase 5: edit a question. The save is computed here by the shared TypeScript
// (planSave: same or new version, diff, derived fields, checks) and applied by
// cms_apply_save in one transaction. Explicit Save; the preview says what will happen.
import { useEffect, useMemo, useState } from 'react';
import { checkFile } from '../../shared/checks.ts';
import { planSave } from '../../shared/save.ts';
import type { Answer, ChapterFile, Question, WrongAnswer } from '../../shared/types.ts';
import { applySave, loadForEdit, type EditContext } from './editApi';
import { TAG_LABEL } from './logic';

const FORMATS: Answer['format'][] = ['MCQ-4', 'MCQ-3', 'True/False', 'Typed-number', 'Typed-decimal', 'Typed-fraction', 'Typed-text', 'Multi-part'];
const OPTION_COUNT: Partial<Record<Answer['format'], number>> = { 'MCQ-4': 4, 'MCQ-3': 3, 'True/False': 2 };
const TAGS = Object.keys(TAG_LABEL) as WrongAnswer['tag'][];
const clone = <T,>(x: T): T => structuredClone(x);
const n = (v: string) => Number(v);

export function EditForm({ questionId, onDone }: { questionId: string; onDone: (saved: boolean) => void }) {
  const [ctx, setCtx] = useState<EditContext | null>(null);
  const [q, setQ] = useState<Question | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [forceNew, setForceNew] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    loadForEdit(questionId).then((c) => { setCtx(c); setQ(clone(c.question)); }).catch((e) => setError(e.message));
  }, [questionId]);

  const plan = useMemo(() => {
    if (!ctx || !q) return null;
    const d = ctx.detail;
    return planSave({ questionId, baseVersionNo: d.question.current_version, currentStatus: d.version.status, retired: !!d.question.retired_at,
      before: ctx.question, after: q, cfg: ctx.cfg, questionClass: q.class_override ?? d.question.class, conceptClass: ctx.conceptClass,
      forceNewVersion: forceNew, reason: reason.trim() || undefined });
  }, [ctx, q, forceNew, reason, questionId]);
  const problems = useMemo(() => {
    if (!ctx || !q) return [];
    const d = ctx.detail;
    const file: ChapterFile = { file_schema: 'cms-chapter/1.0', attribute_version: ctx.ruleVersion, subject: d.question.subject as 'math',
      class: d.question.class, chapter_id: d.question.chapter_id, generated: { by: 'CMS editor', date: new Date().toISOString().slice(0, 10) }, questions: [q] };
    return checkFile(file, ctx.catalog, { gold: true }).filter((p) => p.key !== 'file' || p.level === 'error');
  }, [ctx, q]);

  if (error) return <p className="error">Couldn't open {questionId} for editing: {error}</p>;
  if (!ctx || !q || !plan) return <p className="muted">Loading the editor…</p>;
  const set = (f: (x: Question) => void) => setQ((cur) => { const x = clone(cur!); f(x); return x; });
  const errors = problems.filter((p) => p.level === 'error');
  const L = ctx.lists;
  const canSave = !!plan.mode && errors.length === 0 && !busy;

  async function save() {
    if (!plan?.payload) return;
    setBusy(true); setError(null);
    try { await applySave(plan.payload); onDone(true); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="editor-page">
      <div className="topic-head">
        <h1>Edit {questionId}</h1>
        <div className="muted small">v{ctx.detail.question.current_version} · {ctx.detail.version.status}{ctx.detail.question.bank === 'gold' ? ' · gold (never published)' : ''}</div>
      </div>

      <Sec title="Question">
        <label className="wide">Text<textarea rows={3} value={q.text} onChange={(e) => set((x) => { x.text = e.target.value; })} /></label>
        <label className="check"><input type="checkbox" checked={!!q.figure} onChange={(e) => set((x) => { if (e.target.checked) x.figure = { description: '', image_status: 'needs_image' }; else delete x.figure; })} /> Has a figure or table</label>
        {q.figure && <>
          <label className="wide">Figure (describe it, to scale)<textarea rows={2} value={q.figure.description} onChange={(e) => set((x) => { x.figure!.description = e.target.value; })} /></label>
          <label>Image<select value={q.figure.image_status} onChange={(e) => set((x) => { x.figure!.image_status = e.target.value as 'needs_image'; })}><option value="needs_image">Image needed</option><option value="has_image">Has image</option></select></label>
        </>}
      </Sec>

      <Sec title="Answer">
        <label>Format<select value={q.answer.format} onChange={(e) => set((x) => {
          const f = e.target.value as Answer['format']; x.answer.format = f;
          const need = OPTION_COUNT[f];
          if (need) { x.answer.options = [...(x.answer.options ?? []), '', '', '', ''].slice(0, need); if (f === 'True/False') x.answer.options = ['True', 'False']; }
          else delete x.answer.options;
        })}>{FORMATS.map((f) => <option key={f}>{f}</option>)}</select></label>
        {q.answer.format === 'Multi-part' ? <PartsEditor q={q} set={set} /> : <AnswerEditor a={q.answer} onChange={(f) => set((x) => f(x.answer))} lists={L} />}
      </Sec>

      <Sec title="Concepts">
        {q.concepts.map((c, i) => (
          <div key={i} className="row3">
            <input list="concept-ids" value={c.concept_id} onChange={(e) => set((x) => { x.concepts[i]!.concept_id = e.target.value.trim(); })} placeholder="G6-FRC-C1" />
            <select value={c.involvement} onChange={(e) => set((x) => { x.concepts[i]!.involvement = n(e.target.value) as 1; })}>{[1, 0.5, 0.2].map((v) => <option key={v} value={v}>× {v.toFixed(1)}</option>)}</select>
            <button className="link" onClick={() => set((x) => { x.concepts.splice(i, 1); })}>Remove</button>
          </div>
        ))}
        {q.concepts.length < 3 && <button className="link" onClick={() => set((x) => { x.concepts.push({ concept_id: '', involvement: 0.5 }); })}>+ Concept</button>}
        <datalist id="concept-ids">{L.concepts.map((c) => <option key={c.concept_id} value={c.concept_id}>{c.name}</option>)}</datalist>
      </Sec>

      <Sec title={`Signature (${ctx.ruleVersion} rules)`}>
        <div className="form-grid">
          <label>Math difficulty<select value={q.signature.math_difficulty} onChange={(e) => set((x) => { x.signature.math_difficulty = e.target.value as 'Simple'; })}>{['Simple', 'Medium', 'Complex'].map((v) => <option key={v}>{v}</option>)}</select></label>
          <Num label="Reading (1–5)" v={q.signature.reading} min={1} max={5} on={(v) => set((x) => { x.signature.reading = v; })} />
          <Num label="Steps (1–20)" v={q.signature.steps} min={1} max={20} on={(v) => set((x) => { x.signature.steps = v; })} />
          <Num label="Working memory (1–5)" v={q.signature.working_memory} min={1} max={5} on={(v) => set((x) => { x.signature.working_memory = v; })} />
          <Num label="Inhibition (0–3)" v={q.signature.inhibition} min={0} max={3} on={(v) => set((x) => { x.signature.inhibition = v; })} />
          <Num label="Visual (0–3)" v={q.signature.visual} min={0} max={3} on={(v) => set((x) => { x.signature.visual = v; })} />
          <Num label="Strategy (0–3)" v={q.signature.strategy} min={0} max={3} on={(v) => set((x) => { x.signature.strategy = v; })} />
          <label>Strategy type<select value={q.signature.strategy_type ?? ''} onChange={(e) => set((x) => { if (e.target.value) x.signature.strategy_type = e.target.value; else delete x.signature.strategy_type; })}><option value="">—</option>{L.strategyTypes.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label>Insight<select value={q.signature.insight_id ?? ''} onChange={(e) => set((x) => { if (e.target.value) x.signature.insight_id = e.target.value; else delete x.signature.insight_id; })}><option value="">—</option>{L.insights.map((s) => <option key={s.insight_id} value={s.insight_id}>{s.insight_id} · {s.name}</option>)}</select></label>
          <label className="check"><input type="checkbox" checked={q.signature.is_pure_fact} onChange={(e) => set((x) => { x.signature.is_pure_fact = e.target.checked; })} /> Pure fact</label>
          <label className="check"><input type="checkbox" checked={q.signature.has_irrelevant_info} onChange={(e) => set((x) => { x.signature.has_irrelevant_info = e.target.checked; })} /> Has irrelevant info</label>
          <label>Duration<select value={q.duration_s} onChange={(e) => set((x) => { x.duration_s = n(e.target.value) as 60; })}>{[30, 60, 90, 120].map((d) => <option key={d} value={d}>{d} s</option>)}</select></label>
        </div>
        {(q.signature.strategy_type === 'Other' || q.signature.strategy_other_note) && <label className="wide">Strategy note (for "Other")<input value={q.signature.strategy_other_note ?? ''} onChange={(e) => set((x) => { x.signature.strategy_other_note = e.target.value; })} /></label>}
      </Sec>

      <Sec title="Solutions and hints">
        <label className="wide">Solution 1 (school method)<textarea rows={2} value={q.solutions.school} onChange={(e) => set((x) => { x.solutions.school = e.target.value; })} /></label>
        <label className="check"><input type="checkbox" checked={!!q.solutions.second} onChange={(e) => set((x) => { if (e.target.checked) x.solutions.second = { text: '', type: 'Another way' }; else delete x.solutions.second; })} /> Solution 2</label>
        {q.solutions.second && <div className="form-grid">
          <label className="wide">Solution 2<textarea rows={2} value={q.solutions.second.text} onChange={(e) => set((x) => { x.solutions.second!.text = e.target.value; })} /></label>
          <label>Type<select value={q.solutions.second.type} onChange={(e) => set((x) => { x.solutions.second!.type = e.target.value as 'Another way'; })}><option>Smarter way</option><option>Another way</option></select></label>
          <label>Strategy<select value={q.solutions.second.strategy ?? ''} onChange={(e) => set((x) => { if (e.target.value) x.solutions.second!.strategy = e.target.value; else delete x.solutions.second!.strategy; })}><option value="">—</option>{L.strategyTypes.map((s) => <option key={s}>{s}</option>)}</select></label>
        </div>}
        {q.hints.map((h, i) => (
          <div key={i} className="row2">
            <label className="wide">Hint {i + 1}<input value={h} onChange={(e) => set((x) => { x.hints[i] = e.target.value; })} /></label>
            {q.hints.length > 1 && <button className="link" onClick={() => set((x) => { x.hints.splice(i, 1); })}>Remove</button>}
          </div>
        ))}
        {q.hints.length < 3 && <button className="link" onClick={() => set((x) => { x.hints.push(''); })}>+ Hint</button>}
      </Sec>

      <Sec title="Placement">
        <div className="form-grid">
          <label>Topic<select value={q.topic_id} onChange={(e) => set((x) => { x.topic_id = e.target.value; })}>{L.topics.map((t) => <option key={t.topic_id} value={t.topic_id}>{t.topic_kind === 'achievers' ? t.name : `${t.topic_id} ${t.name}`} (C{t.class})</option>)}</select></label>
          <label>Typical set<select value={q.typical_set_id} onChange={(e) => set((x) => { x.typical_set_id = e.target.value; })}>{L.sets.map((s) => <option key={s.typical_set_id} value={s.typical_set_id}>{s.typical_set_id} · {s.name}</option>)}</select></label>
          <label>Pattern<select value={q.pattern_id ?? ''} onChange={(e) => set((x) => { if (e.target.value) x.pattern_id = e.target.value; else delete x.pattern_id; })}><option value="">—</option>{L.patterns.filter((p) => p.typical_set_id === q.typical_set_id || p.pattern_id === q.pattern_id).map((p) => <option key={p.pattern_id} value={p.pattern_id}>{p.pattern_id} · {p.name}</option>)}</select></label>
        </div>
      </Sec>

      <button className="link more" aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'Less' : 'More'}: clone batch, class override, notes, tagging, force a new version</button>
      {more && <Sec title="More">
        <div className="form-grid">
          <label>Clone batch<input value={q.clone_batch_id} onChange={(e) => set((x) => { x.clone_batch_id = e.target.value; })} /></label>
          <label>Class override<select value={q.class_override ?? ''} onChange={(e) => set((x) => { if (e.target.value) x.class_override = n(e.target.value); else delete x.class_override; })}><option value="">—</option>{[1, 2, 3, 4, 5, 6].map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="wide">Placement note<input value={q.placement_note ?? ''} onChange={(e) => set((x) => { x.placement_note = e.target.value; })} /></label>
          <label className="wide">Tagging summary<textarea rows={2} value={q.tagging?.summary ?? ''} onChange={(e) => set((x) => { x.tagging = { ...(x.tagging ?? {}), summary: e.target.value }; })} /></label>
          <label className="wide">Author notes<textarea rows={2} value={q.author_notes ?? ''} onChange={(e) => set((x) => { x.author_notes = e.target.value; })} /></label>
          <label className="check wide"><input type="checkbox" checked={forceNew} onChange={(e) => setForceNew(e.target.checked)} /> Save as a new version even if it's only a wording change</label>
        </div>
      </Sec>}

      <div className={`save-preview ${plan.blocked ? 'blocked' : plan.mode ? '' : 'idle'}`}>
        <div className="eyebrow">When you click Save</div>
        <div><strong>{plan.summary}</strong></div>
        {plan.changedFields.length > 0 && <div className="small muted">Changed: {plan.changedFields.join(', ')}</div>}
        {plan.payload && Object.keys((plan.payload.diff as { texts: object }).texts).length > 0 && (
          <ul className="small diff">{Object.entries((plan.payload.diff as { texts: Record<string, { before: string | null; after: string | null }> }).texts).map(([k, d]) => (
            <li key={k}><span className="muted">{k}:</span> <del>{d.before ?? '—'}</del> → <ins>{d.after ?? '—'}</ins></li>))}</ul>
        )}
        {problems.length > 0 && <ul className="small">{problems.map((p, i) => <li key={i} className={p.level === 'error' ? 'error' : 'warn'}>{p.level === 'error' ? 'Error' : 'Warning'}: {p.message}</li>)}</ul>}
        {plan.mode && <label className="wide small">Reason (optional, kept in the audit log)<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
        {error && <p className="error small">{error}</p>}
        <div className="editor-actions">
          <button onClick={save} disabled={!canSave}>{busy ? 'Saving…' : 'Save'}</button>
          <button className="secondary" onClick={() => onDone(false)} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function AnswerEditor({ a, onChange, lists }: { a: Answer; onChange: (f: (a: Answer) => void) => void; lists: EditContext['lists'] }) {
  const opts = a.options ?? [];
  const wrongFor = (v: string) => (a.wrong_answers ?? []).find((w) => w.value === v);
  const setWrong = (value: string, patch: Partial<WrongAnswer> | null) => onChange((x) => {
    const list = x.wrong_answers ?? (x.wrong_answers = []);
    const i = list.findIndex((w) => w.value === value);
    if (patch === null) { if (i >= 0) list.splice(i, 1); return; }
    if (i >= 0) Object.assign(list[i]!, patch); else list.push({ value, tag: 'misread', ...patch } as WrongAnswer);
  });
  return (
    <>
      {opts.length > 0 ? (
        <table className="opts small">
          <thead><tr><th>Correct</th><th>Option</th><th>Mistake tag (wrong options)</th><th>Misconception / concept</th><th>Why</th></tr></thead>
          <tbody>{opts.map((o, i) => {
            const w = wrongFor(o);
            return (
              <tr key={i}>
                <td><input type="radio" name="correct" checked={a.correct === o} onChange={() => onChange((x) => { x.correct = o; x.wrong_answers = (x.wrong_answers ?? []).filter((y) => y.value !== o); })} /></td>
                <td><input value={o} onChange={(e) => onChange((x) => {
                  const old = x.options![i]!; x.options![i] = e.target.value;
                  if (x.correct === old) x.correct = e.target.value;
                  for (const y of x.wrong_answers ?? []) if (y.value === old) y.value = e.target.value;
                })} /></td>
                {a.correct === o ? <td colSpan={3} className="muted">Correct answer</td> : <>
                  <td><select value={w?.tag ?? ''} onChange={(e) => setWrong(o, e.target.value ? { tag: e.target.value as WrongAnswer['tag'] } : null)}><option value="">Not tagged</option>{TAGS.map((t) => <option key={t} value={t}>{TAG_LABEL[t]}</option>)}</select></td>
                  <td>{w?.tag === 'misconception' ? <select value={w.misconception_id ?? ''} onChange={(e) => setWrong(o, { misconception_id: e.target.value })}><option value="">Choose…</option>{lists.misconceptions.map((m) => <option key={m.misconception_id} value={m.misconception_id}>{m.misconception_id} · {m.description}</option>)}</select>
                    : w ? <input list="concept-ids" placeholder="target concept" value={w.target_concept_id ?? ''} onChange={(e) => setWrong(o, { target_concept_id: e.target.value || undefined })} /> : null}</td>
                  <td>{w && <input value={w.why ?? ''} onChange={(e) => setWrong(o, { why: e.target.value })} />}</td>
                </>}
              </tr>
            );
          })}</tbody>
        </table>
      ) : (
        <div className="form-grid">
          <label>Correct answer<input value={a.correct} onChange={(e) => onChange((x) => { x.correct = e.target.value; })} /></label>
          <label className="wide">Also accepted (separate with |)<input value={(a.accepted ?? []).join(' | ')} onChange={(e) => onChange((x) => { x.accepted = e.target.value.split('|').map((s) => s.trim()).filter(Boolean); })} /></label>
        </div>
      )}
      {opts.length > 0 && <label className="wide small">Also accepted (separate with |)<input value={(a.accepted ?? []).join(' | ')} onChange={(e) => onChange((x) => { x.accepted = e.target.value.split('|').map((s) => s.trim()).filter(Boolean); })} /></label>}
      {opts.length === 0 && (a.wrong_answers ?? []).length > 0 && (
        <div className="small"><span className="muted">Tagged typed wrong answers:</span> {(a.wrong_answers ?? []).map((w) => `${w.value} (${TAG_LABEL[w.tag] ?? w.tag})`).join(', ')}</div>
      )}
    </>
  );
}

/** [guess] Phase 5 edits each part's wording and answer; adding or removing parts comes later. */
function PartsEditor({ q, set }: { q: Question; set: (f: (x: Question) => void) => void }) {
  return (
    <>
      {(q.parts ?? []).map((p, i) => (
        <div key={p.part_label} className="part-edit">
          <label className="wide">Part ({p.part_label})<input value={p.text} onChange={(e) => set((x) => { x.parts![i]!.text = e.target.value; })} /></label>
          <div className="form-grid">
            <label>Answer<input value={p.answer.correct} onChange={(e) => set((x) => { x.parts![i]!.answer.correct = e.target.value; })} /></label>
            <label className="wide">Also accepted (|)<input value={(p.answer.accepted ?? []).join(' | ')} onChange={(e) => set((x) => { x.parts![i]!.answer.accepted = e.target.value.split('|').map((s) => s.trim()).filter(Boolean); })} /></label>
          </div>
        </div>
      ))}
    </>
  );
}

function Sec({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="edit-sec"><div className="eyebrow">{title}</div>{children}</div>;
}
function Num({ label, v, min, max, on }: { label: string; v: number; min: number; max: number; on: (v: number) => void }) {
  return <label>{label}<input type="number" min={min} max={max} value={v} onChange={(e) => on(Number(e.target.value))} /></label>;
}

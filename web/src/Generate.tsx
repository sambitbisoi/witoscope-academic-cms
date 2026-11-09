// Phase 6 screens: Generate (settings → run) and Run results (review the drafts).
import { useEffect, useMemo, useState } from 'react';
import { buildPrompt, difficultiesFor, type GenerateSettings } from '../../shared/generation.ts';
import { setStatus } from './editApi';
import { estimateUsd, loadContext, loadPack, runBatch, runNow, runRecord, type DraftOutcome, type GenContext } from './genApi';
import { browseHash, STATUS_LABEL, subjectOfChapter } from './logic';
import { supabase } from './supabase';

type Lvl = 'Simple' | 'Medium' | 'Complex';
const usd = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;

export function GenerateScreen({ questionId, setId, topicId }: { questionId: string | null; setId: string | null; topicId: string | null }) {
  const [ctx, setCtx] = useState<GenContext | null>(null);
  const [pack, setPack] = useState<Awaited<ReturnType<typeof loadPack>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(5);
  const [level, setLevel] = useState<'same' | 'missing' | Lvl>('same');
  const [vary, setVary] = useState({ numbers: true, story: false, format: false });
  const [batch, setBatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    loadContext(questionId ? { questionId } : { setId: setId ?? '', topicId: topicId ?? '' })
      .then(async (c) => { setCtx(c); setLevel(questionId ? 'same' : 'missing'); setPack(await loadPack(c.classLevel)); })
      .catch((e) => setError(e.message));
  }, [questionId, setId, topicId]);

  const settings: GenerateSettings | null = useMemo(() => {
    if (!ctx) return null;
    const same = (ctx.source?.signature.math_difficulty ?? 'Medium') as Lvl;
    const difficulties = level === 'missing' ? difficultiesFor(count, ctx.missing, same) : level === 'same' ? difficultiesFor(count, [], same) : difficultiesFor(count, [], level);
    return { count, difficulties, vary, classLevel: ctx.classLevel, topicName: ctx.topicName, setName: ctx.setName, patternName: ctx.patternName,
      concepts: ctx.concepts, misconceptions: ctx.misconceptions };
  }, [ctx, count, level, vary]);

  if (error) return <main><p className="error">Couldn't prepare generation: {error}</p></main>;
  if (!ctx || !settings) return <main><p className="muted">Preparing…</p></main>;
  const prompt = buildPrompt(ctx.source, settings);
  const estimate = pack ? estimateUsd(ctx.config, pack.text.length, prompt.length, count, batch) : null;
  const left = ctx.config.dailyCapUsd - ctx.spentToday;
  const overCap = estimate !== null && estimate > left;

  async function go() {
    if (!ctx || !settings || !pack) return;
    setBusy(true); setError(null);
    try {
      if (batch) { const b = await runBatch(ctx, settings, pack); setDone(`Batch submitted (run ${b.runId}). It usually finishes within an hour; collect it from Jobs on Home.`); }
      else { const runId = await runNow(ctx, settings, pack); location.hash = `#/run/${runId}`; }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <main className="wide gen">
      <h2>{ctx.mode === 'similar' ? `Generate similar to ${ctx.sourceId}` : `Fill question type ${ctx.setId}`}</h2>
      <div className="muted small">{ctx.topicId} {ctx.topicName} · Class {ctx.classLevel} · {ctx.setId} {ctx.setName}{ctx.patternId ? ` · ${ctx.patternId}` : ''}
        {ctx.missing.length ? ` · missing levels: ${ctx.missing.join(', ')}` : ' · all three levels present'}</div>
      <div className="gen-cols">
        <div className="card">
          <div className="eyebrow">Source</div>
          {ctx.source ? <><div className="stem">{ctx.source.text}</div><div className="small muted">{ctx.source.answer.format} · answer {ctx.source.answer.correct || (ctx.source.parts ?? []).map((p) => p.answer.correct).join(' / ')} · {ctx.source.signature.math_difficulty}</div></>
            : <div className="muted">No question in this set yet; the drafts follow the question type.</div>}
        </div>
        <div className="card">
          <div className="eyebrow">Settings</div>
          <label className="small">How many (1–{ctx.config.maxDrafts})<input type="number" min={1} max={ctx.config.maxDrafts} value={count} onChange={(e) => setCount(Math.max(1, Math.min(ctx.config.maxDrafts, Number(e.target.value) || 1)))} /></label>
          <label className="small">Difficulty<select value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>
            {ctx.source && <option value="same">Same as the source ({ctx.source.signature.math_difficulty})</option>}
            <option value="missing">Missing levels first{ctx.missing.length ? ` (${ctx.missing.join(', ')})` : ''}</option>
            {(['Simple', 'Medium', 'Complex'] as const).map((l) => <option key={l} value={l}>All {l}</option>)}
          </select></label>
          <div className="small">Vary: {(['numbers', 'story', 'format'] as const).map((k) => (
            <label key={k} className="check inline"><input type="checkbox" checked={vary[k]} onChange={(e) => setVary({ ...vary, [k]: e.target.checked })} /> {k}</label>))}</div>
          <div className="small">Run: <label className="check inline"><input type="radio" checked={!batch} onChange={() => setBatch(false)} /> now</label>
            <label className="check inline"><input type="radio" checked={batch} onChange={() => setBatch(true)} /> as a batch (half price, up to 24 h)</label></div>
        </div>
      </div>
      <div className="save-preview">
        <div className="small">Model <strong>{ctx.config.model}</strong> · today {usd(ctx.spentToday)} of {usd(ctx.config.dailyCapUsd)} · estimate up to {estimate === null ? '…' : usd(estimate)}
          {' '}· {settings.difficulties.join(', ')}</div>
        {overCap && <div className="error small">This run could pass today's cap ({usd(left)} left). Ask for fewer drafts, use a batch, or raise ai_daily_cap_usd.</div>}
        {done && <div className="notice small">{done} <a href="#/">Home</a></div>}
        {error && <div className="error small">{error}</div>}
        <div className="editor-actions">
          <button onClick={go} disabled={busy || !pack || overCap || !!done}>{busy ? (batch ? 'Submitting…' : 'Generating…') : batch ? 'Submit batch' : `Generate ${count}`}</button>
          <a className="secondary-link" href={ctx.sourceId ? `#/q/${ctx.sourceId}` : browseHash({ subject: subjectOfChapter(ctx.chapterId), cls: String(ctx.classLevel), topic: ctx.topicId })}>Back</a>
        </div>
      </div>
    </main>
  );
}

export function RunScreen({ runId }: { runId: number }) {
  const [run, setRun] = useState<Awaited<ReturnType<typeof runRecord>> | null>(null);
  const [status, setStatusMap] = useState<Map<string, { status: string; topic_id: string; chapter_id: string; class: number }>>(new Map());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [reject, setReject] = useState<{ id: string; reason: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    runRecord(runId).then(async (r) => {
      setRun(r);
      const ids = (r.params.outcomes ?? []).map((o) => o.question_id).filter((x): x is string => !!x);
      if (ids.length) {
        const { data } = await supabase.from('cms_question_list').select('question_id, status, topic_id, chapter_id, class').in('question_id', ids);
        setStatusMap(new Map((data ?? []).map((x) => [x.question_id, x])));
      }
    }).catch((e) => setError(e.message));
  }, [runId, tick]);
  if (error) return <main><p className="error">{error}</p></main>;
  if (!run) return <main><p className="muted">Loading run {runId}…</p></main>;
  const outcomes = run.params.outcomes ?? [];
  const act = async (f: () => Promise<unknown>) => { setError(null); try { await f(); setSel(new Set()); setReject(null); setTick((t) => t + 1); } catch (e) { setError((e as Error).message); } };
  const drafts = outcomes.filter((o) => o.question_id && status.get(o.question_id)?.status === 'draft');
  return (
    <main className="wide gen">
      <h2>Run {run.run_id} · {run.kind === 'fill_set' ? 'fill a question type' : 'generate similar'}</h2>
      <div className="muted small">{run.model} · {run.status}{run.params.batch ? ' · batch' : ''} · {run.tokens_in ?? 0} in / {run.tokens_out ?? 0} out tokens · cost {usd(Number(run.cost ?? 0))}
        {run.params.usage?.cache_read_input_tokens ? ` · ${run.params.usage.cache_read_input_tokens} cached` : ''}</div>
      {run.params.error && <p className="error">{run.params.error}</p>}
      {outcomes.length === 0 && !run.params.error && <p className="muted">No drafts yet{run.params.batch ? ': collect the batch from Jobs on Home.' : '.'}</p>}
      {drafts.length > 0 && (
        <div className="actions">
          <label className="check"><input type="checkbox" checked={sel.size === drafts.length} onChange={(e) => setSel(e.target.checked ? new Set(drafts.map((d) => d.question_id!)) : new Set())} /> Select all drafts</label>
          <button className="approve" disabled={!sel.size} onClick={() => act(async () => { for (const id of sel) await setStatus(id, 1, 'approve', null); })}>Approve selected ({sel.size})</button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      {outcomes.map((o: DraftOutcome) => {
        const st = o.question_id ? status.get(o.question_id) : undefined;
        return (
          <div key={o.index} className={`draft-card ${o.errors.length ? 'blocked' : ''}`}>
            <div className="draft-head">
              {st?.status === 'draft' && <input type="checkbox" checked={sel.has(o.question_id!)} onChange={(e) => { const s = new Set(sel); if (e.target.checked) s.add(o.question_id!); else s.delete(o.question_id!); setSel(s); }} />}
              <strong>Draft {o.index}</strong> <span className={`lvl ${o.difficulty}`}>{o.difficulty}</span>
              {o.question_id ? <a className="mono" href={browseHash({ subject: subjectOfChapter(st?.chapter_id ?? 'MC'), cls: String(st?.class ?? 'all'), topic: st?.topic_id, q: o.question_id })}>{o.question_id}</a> : <span className="error small">not saved</span>}
              {st && <span className="muted small">{STATUS_LABEL[st.status] ?? st.status}</span>}
            </div>
            <div className="stem">{o.text}</div>
            {o.errors.map((m, i) => <div key={i} className="error small">Error: {m}</div>)}
            {o.warnings.map((m, i) => <div key={i} className="warn small">Warning: {m}</div>)}
            {o.hits.map((h) => <div key={h.id} className="warn small">{h.kind === 'source_item' ? 'Close to book item' : 'Close to'} {h.id}: similarity {h.similarity}{h.sameNumbers ? ', same numbers' : ''}</div>)}
            {st?.status === 'draft' && (
              <div className="actions">
                <a href={browseHash({ subject: subjectOfChapter(st.chapter_id), cls: String(st.class), topic: st.topic_id, q: o.question_id!, edit: true })}>Edit</a>
                {reject?.id === o.question_id ? (
                  <span className="reason"><input placeholder="Why reject it? (kept with the draft)" value={reject.reason} onChange={(e) => setReject({ id: o.question_id!, reason: e.target.value })} />
                    <button disabled={!reject.reason.trim()} onClick={() => act(() => setStatus(o.question_id!, 1, 'reject', reject.reason))}>Reject</button></span>
                ) : <button className="link" onClick={() => setReject({ id: o.question_id!, reason: '' })}>Reject…</button>}
              </div>
            )}
          </div>
        );
      })}
    </main>
  );
}

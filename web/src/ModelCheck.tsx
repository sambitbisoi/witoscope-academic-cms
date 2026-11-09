// Model check (Phase 6 update): run a model on the test-only gold questions with their values
// hidden, and report agreement with the gold values per attribute, to choose the tagging model.
import { useEffect, useState } from 'react';
import { FallbackNotice } from './Generate';
import { estimateUsd, loadAiConfig, loadRules, modelCheckRuns, runModelCheck, runRecord, spentTodayUsd, testOnlyGold, type AiConfig } from './genApi';

const usd = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
const CONTEXT_CHARS = 5000, OUTPUT_TOKENS = 2500; // per question, for the estimate [guess: generous]

export function ModelCheckScreen({ runId }: { runId: number | null }) {
  return runId ? <ModelCheckReport runId={runId} /> : <ModelCheckStart />;
}

function ModelCheckStart() {
  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [n, setN] = useState<number | null>(null);
  const [rulesChars, setRulesChars] = useState(0);
  const [spent, setSpent] = useState(0);
  const [model, setModel] = useState('');
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof modelCheckRuns>>>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([loadAiConfig(), testOnlyGold(), loadRules('tag'), spentTodayUsd()]).then(([c, g, r, s]) => {
      setCfg(c); setN(g.length); setRulesChars(r.text.length); setSpent(s); setModel(c.models.tag);
    }).catch((e) => setError(e.message));
    modelCheckRuns().then(setRuns).catch(() => setRuns([])); // best-effort list
  }, []);
  if (error && !cfg) return <main><p className="error">{error}</p></main>;
  if (!cfg || n === null) return <main><p className="muted">Loading…</p></main>;
  const models = [...new Set([cfg.models.tag, cfg.models.generate, cfg.fallbackModel, ...Object.keys(cfg.prices)])];
  const estimate = n * estimateUsd(cfg, model, rulesChars + CONTEXT_CHARS, OUTPUT_TOKENS, false);
  const over = spent + estimate > cfg.dailyCapUsd;
  async function go() {
    setError(null); setProgress(`0 / ${n}`);
    try { const id = await runModelCheck(model, (d, t) => setProgress(`${d} / ${t}`)); location.hash = `#/model-check/${id}`; }
    catch (e) { setError((e as Error).message); setProgress(null); }
  }
  return (
    <main className="wide gen">
      <h2>Model check</h2>
      <p className="muted small">Tags the {n} test-only gold questions with their values hidden (no concepts, signature, duration, wrong-answer tags, solutions or hints)
        and reports how often the model agrees with the gold values, per attribute. Nothing is saved to the question bank.</p>
      <div className="save-preview">
        <label className="small">Model <select value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => <option key={m} value={m}>{m}{m === cfg.models.tag ? ' (current tagging model)' : ''}</option>)}
        </select></label>
        <div className="small">Estimate up to {usd(estimate)} · today {usd(spent)} of {usd(cfg.dailyCapUsd)}{cfg.prices[model] ? '' : ' · no price for this model in ai_prices (estimated high)'}</div>
        {over && <div className="error small">This could pass today's cap; the check stops when the cap is reached.</div>}
        {error && <div className="error small">{error}</div>}
        <div className="editor-actions">
          <button onClick={go} disabled={!!progress}>{progress ? `Checking… ${progress}` : `Run the check on ${n} questions`}</button>
          <a className="secondary-link" href="#/">Back</a>
        </div>
      </div>
      {runs.length > 0 && (
        <section>
          <h3>Earlier checks</h3>
          <table className="report"><thead><tr><th>Run</th><th>Model</th><th>When</th><th>Overall</th><th>Cost</th></tr></thead>
            <tbody>{runs.map((r) => {
              const a = r.params.agreement ?? [];
              const hits = a.reduce((x, y) => x + y.hits, 0), tot = a.reduce((x, y) => x + y.n, 0);
              return <tr key={r.run_id}><td><a href={`#/model-check/${r.run_id}`}>{r.run_id}</a></td><td>{r.model}{r.params.fallback ? ' ⚠ fallback' : ''}</td>
                <td>{new Date(r.created_at).toLocaleString()}</td><td>{tot ? `${Math.round((hits / tot) * 100)}%` : r.status}</td><td>{usd(Number(r.cost ?? 0))}</td></tr>;
            })}</tbody></table>
        </section>
      )}
    </main>
  );
}

function ModelCheckReport({ runId }: { runId: number }) {
  const [run, setRun] = useState<Awaited<ReturnType<typeof runRecord>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { runRecord(runId).then(setRun).catch((e) => setError(e.message)); }, [runId]);
  if (error) return <main><p className="error">{error}</p></main>;
  if (!run) return <main><p className="muted">Loading check {runId}…</p></main>;
  const p = run.params;
  const results = p.check ?? [];
  const failed = results.filter((r) => r.error);
  return (
    <main className="wide gen">
      <h2>Model check {run.run_id} · {run.model}</h2>
      <div className="muted small">{new Date(run.created_at).toLocaleString()} · {results.length - failed.length} of {p.questions ?? results.length} questions tagged · {run.tokens_in ?? 0} in / {run.tokens_out ?? 0} out tokens · cost {usd(Number(run.cost ?? 0))}
        {p.usage?.cache_read_input_tokens ? ` · ${p.usage.cache_read_input_tokens} cached` : ''}</div>
      <FallbackNotice params={p} />
      {results.some((r) => r.fallback) && <div className="warn small">Answered after a fallback: {results.filter((r) => r.fallback).map((r) => `${r.qid} (${r.models.join(' → ')})`).join(', ')}</div>}
      {p.stopped && <div className="warn small">The check {p.stopped}.</div>}
      {failed.length > 0 && <div className="error small">Not tagged: {failed.map((r) => `${r.qid} (${r.error})`).join('; ')}</div>}
      <table className="report">
        <thead><tr><th>Attribute</th><th>Agreement</th><th>Off by one</th><th>Compared</th></tr></thead>
        <tbody>{(p.agreement ?? []).map((a) => (
          <tr key={a.attribute}><td>{a.attribute}</td><td><strong>{a.pct}%</strong> <span className="muted small">({a.hits})</span></td><td>{a.near || ''}</td><td>{a.n}{a.attribute === 'Wrong-answer tags' ? ' wrong answers' : ''}</td></tr>
        ))}</tbody>
      </table>
      <h3>Disagreements</h3>
      {(p.agreement ?? []).map((a) => {
        const rows = results.flatMap((r) => r.scores.filter((s) => s.attribute === a.attribute && s.hits < s.n).map((s) => ({ qid: r.qid, s })));
        if (!rows.length) return null;
        return (
          <details key={a.attribute}><summary>{a.attribute}: {rows.length} question{rows.length === 1 ? '' : 's'}</summary>
            <ul className="small">{rows.map(({ qid, s }) => <li key={qid}><a className="mono" href={`#/q/${qid}`}>{qid}</a> gold <strong>{s.gold || '—'}</strong> · model <strong>{s.got || '—'}</strong>{s.near ? ' (off by one)' : ''}{s.note ? ` · ${s.note}` : ''}</li>)}</ul>
          </details>
        );
      })}
      <p><a href="#/model-check">Run another check</a> · <a href="#/">Home</a></p>
    </main>
  );
}

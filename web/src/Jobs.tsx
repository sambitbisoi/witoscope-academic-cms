// Jobs on Home (Phase 6): batch generation runs, checked and collected from the browser
// (no database credentials in the cloud, so nothing polls on its own).
import { useEffect, useState } from 'react';
import { batchStatus, collectBatch, startOfTodayIst } from './genApi';
import { supabase } from './supabase';

interface JobRow { job_id: number; type: string; status: string; progress: number; payload: Record<string, unknown>; started_at: string | null }

export function Jobs() {
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [runs, setRuns] = useState<{ run_id: number; kind: string; status: string; cost: number | null }[]>([]);
  const [fallbacks, setFallbacks] = useState<{ run_id: number; kind: string; model: string; params: { fallback?: { from: string; to: string; answered: boolean } } }[]>([]);
  const [msg, setMsg] = useState<Record<number, string>>({});
  const [tick, setTick] = useState(0);
  useEffect(() => {
    supabase.from('cms_jobs').select('*').in('status', ['queued', 'running']).order('job_id', { ascending: false }).limit(10)
      .then(({ data }) => setJobs((data ?? []) as JobRow[]));
    supabase.from('cms_generation_runs').select('run_id, kind, status, cost').gte('created_at', startOfTodayIst()).order('run_id', { ascending: false })
      .then(({ data }) => setRuns((data ?? []) as never));
    // refusal fallbacks in the last 30 days: always visible on Home when one fired (best-effort)
    supabase.from('cms_generation_runs').select('run_id, kind, model, params').not('params->fallback->>kind', 'is', null)
      .gte('created_at', new Date(Date.now() - 30 * 86400_000).toISOString()).order('run_id', { ascending: false }).limit(10)
      .then(({ data }) => setFallbacks((data ?? []) as never), () => setFallbacks([]));
  }, [tick]);
  const say = (id: number, m: string) => setMsg((x) => ({ ...x, [id]: m }));
  async function check(j: JobRow) {
    try {
      const s = await batchStatus(String(j.payload.batch_id));
      if (s.processing_status !== 'ended') { say(j.job_id, `Still running (${JSON.stringify(s.request_counts)})`); return; }
      say(j.job_id, 'Ended. Collecting drafts…');
      const runId = await collectBatch(j);
      location.hash = `#/run/${runId}`;
    } catch (e) { say(j.job_id, (e as Error).message); setTick((t) => t + 1); }
  }
  const spent = runs.reduce((n, r) => n + Number(r.cost ?? 0), 0);
  return (
    <>
      {jobs === null ? <div className="muted">…</div> : jobs.length === 0 ? <div className="muted">No jobs running.</div> : jobs.map((j) => (
        <div key={j.job_id} className="job">
          <div><strong>{j.type === 'generation_batch' ? 'Generation batch' : j.type}</strong> · run {String(j.payload.run_id ?? '')} · {j.status}</div>
          {j.type === 'generation_batch' && <button className="secondary" onClick={() => check(j)}>Check / collect</button>}
          {msg[j.job_id] && <div className="small muted">{msg[j.job_id]}</div>}
        </div>
      ))}
      {fallbacks.length > 0 && (
        <div className="warn small fallback-notice" role="status">Refusal fallback fired in {fallbacks.length} run{fallbacks.length === 1 ? '' : 's'} (last 30 days):{' '}
          {fallbacks.map((f, i) => <span key={f.run_id}>{i ? ', ' : ''}<a href={`#/${f.kind === 'tag' ? 'model-check' : 'run'}/${f.run_id}`}>run {f.run_id}</a> ({f.params.fallback?.from} → {f.params.fallback?.to}{f.params.fallback?.answered ? '' : ', declined'})</span>)}
        </div>
      )}
      {runs.length > 0 && <div className="small">AI today: {runs.length} run{runs.length === 1 ? '' : 's'}, ${spent.toFixed(4)} · latest <a href={`#/${runs[0]!.kind === 'tag' ? 'model-check' : 'run'}/${runs[0]!.run_id}`}>run {runs[0]!.run_id}</a></div>}
      <div className="small"><a href="#/model-check">Model check</a> <span className="muted">(tagging agreement on the test-only gold)</span></div>
    </>
  );
}

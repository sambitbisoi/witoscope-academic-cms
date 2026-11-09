// Jobs on Home (Phase 6): batch generation runs, checked and collected from the browser
// (no database credentials in the cloud, so nothing polls on its own).
import { useEffect, useState } from 'react';
import { batchStatus, collectBatch, startOfTodayIst } from './genApi';
import { supabase } from './supabase';

interface JobRow { job_id: number; type: string; status: string; progress: number; payload: Record<string, unknown>; started_at: string | null }

export function Jobs() {
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [runs, setRuns] = useState<{ run_id: number; kind: string; status: string; cost: number | null }[]>([]);
  const [msg, setMsg] = useState<Record<number, string>>({});
  const [tick, setTick] = useState(0);
  useEffect(() => {
    supabase.from('cms_jobs').select('*').in('status', ['queued', 'running']).order('job_id', { ascending: false }).limit(10)
      .then(({ data }) => setJobs((data ?? []) as JobRow[]));
    supabase.from('cms_generation_runs').select('run_id, kind, status, cost').gte('created_at', startOfTodayIst()).order('run_id', { ascending: false })
      .then(({ data }) => setRuns((data ?? []) as never));
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
      {runs.length > 0 && <div className="small">AI today: {runs.length} run{runs.length === 1 ? '' : 's'}, ${spent.toFixed(4)} · latest <a href={`#/run/${runs[0]!.run_id}`}>run {runs[0]!.run_id}</a></div>}
    </>
  );
}

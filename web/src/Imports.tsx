// Imports: read-only history of every import (chapter files, topic lists, v10 seed)
// with the report in plain words. Data comes from cms_imports (RLS: admin only).
import { useEffect, useState } from 'react';
import { supabase } from './supabase';

interface ImportRow {
  import_id: number; kind: 'chapter' | 'topics' | 'seed' | 'sources' | 'book' | 'originality' | 'proposals' | 'figures'; file_path: string; git_commit: string | null; file_hash: string;
  chapter_id: string | null; options: Record<string, unknown>; started_at: string; finished_at: string | null;
  result: 'ok' | 'partial' | 'failed' | null; counts: Record<string, unknown>; error_report: unknown;
}
interface Problem { level: 'error' | 'warning'; key?: string; where?: string; message: string }
interface Outcome { key: string; question_id?: string; result: string; version?: number; note?: string }

const KIND: Record<ImportRow['kind'], string> = { chapter: 'Chapter file', topics: 'Topic lists', seed: 'Rules seed', sources: 'Source registry', book: 'Book citations',
  originality: 'Originality check', proposals: 'Proposed items', figures: 'Figure images' };
/** "v11 seed" from the workbook's file name (…_v11.xlsx). */
export const seedLabel = (path: string) => `${/_v(\d+)\.xlsx$/.exec(path)?.[0].slice(1, -5) ?? 'rules'} seed`;
const kindOf = (r: { kind: ImportRow['kind']; file_path: string }) => (r.kind === 'seed' ? seedLabel(r.file_path) : KIND[r.kind]);
const OUTCOME: Record<string, string> = {
  created: 'New question', new_version: 'New version', typo_fix: 'Typo fix', draft_replaced: 'Draft replaced',
  unchanged: 'Unchanged', blocked: 'Blocked',
};
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fileName = (p: string) => p.split('/').pop() ?? p;

/** "created 1 · blocked 1" for chapter imports; "cms_topics +12 new · 3 updated" lines for catalogue imports. */
function countLines(counts: Record<string, unknown>): string[] {
  const order = (k: string) => (k === 'gold' ? 'zz' : k);
  return Object.entries(counts).sort(([a], [b]) => order(a).localeCompare(order(b))).map(([k, v]) => {
    if (typeof v === 'number') return `${OUTCOME[k] ?? k} ${v}`;
    const c = v as Record<string, number>;
    if ('inserted' in c) {
      const parts = [`+${c.inserted} new`, `${c.updated} updated`, `${c.unchanged} unchanged`];
      const missing = c.missing_from_source ?? c.missing_from_workbook;
      if (missing) parts.push(`${missing} not in source`);
      return `${k.replace(/^cms_/, '')}: ${parts.join(' · ')}`;
    }
    return `${k}: ${Object.entries(c).map(([a, n]) => `${a.replace(/_/g, ' ')} ${n}`).join(' · ')}`;
  });
}
const summary = (r: ImportRow) => (r.kind === 'chapter' ? countLines(r.counts).join(' · ') : `${countLines(r.counts).length} tables`);

function splitReport(r: ImportRow): { problems: Problem[]; outcomes: Outcome[] } {
  const rep = r.error_report as { problems?: Problem[]; outcomes?: Outcome[] } | Problem[] | null;
  if (Array.isArray(rep)) return { problems: rep, outcomes: [] };
  return { problems: rep?.problems ?? [], outcomes: rep?.outcomes ?? [] };
}

export function ImportsList() {
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    supabase.from('cms_imports').select('*').order('import_id', { ascending: false }).limit(200)
      .then(({ data, error }) => (error ? setError(error.message) : setRows(data as ImportRow[])));
  }, []);

  if (error) return <p className="error">Couldn't load imports: {error}</p>;
  if (!rows) return <p className="muted">Loading…</p>;
  return (
    <>
      <h2>Imports</h2>
      <LocalImport />
      <p className="muted">Every import run, newest first. On the live site this page only shows them; imports run on your Mac.</p>
      {rows.length === 0 ? <p className="muted">No imports yet.</p> : (
        <table className="list">
          <thead><tr><th>#</th><th>When</th><th>What</th><th>File</th><th>Result</th><th>Summary</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.import_id} onClick={() => (location.hash = `#/imports/${r.import_id}`)}>
                <td><a href={`#/imports/${r.import_id}`}>{r.import_id}</a></td>
                <td>{when(r.started_at)}</td>
                <td>{kindOf(r)}{r.chapter_id ? ` · ${r.chapter_id}` : ''}</td>
                <td className="file" title={r.file_path}>{r.kind === 'topics' ? '3 workbooks' : fileName(r.file_path)}</td>
                <td><Result r={r.result} /></td>
                <td className="muted">{summary(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export function ImportDetail({ id }: { id: number }) {
  const [row, setRow] = useState<ImportRow | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    supabase.from('cms_imports').select('*').eq('import_id', id).maybeSingle()
      .then(({ data, error }) => (error ? setError(error.message) : setRow(data as ImportRow | null)));
  }, [id]);

  if (error) return <p className="error">Couldn't load import #{id}: {error}</p>;
  if (row === undefined) return <p className="muted">Loading…</p>;
  if (row === null) return <p>Import #{id} doesn't exist. <a href="#/imports">Back to imports</a></p>;

  const { problems, outcomes } = splitReport(row);
  const fileLevel = problems.filter((p) => !p.key || p.key === 'file' || !outcomes.some((o) => o.key === p.key));
  const errors = problems.filter((p) => p.level === 'error').length;
  const warnings = problems.length - errors;
  return (
    <>
      <p><a href="#/imports">← Imports</a></p>
      <h2>Import #{row.import_id} <Result r={row.result} /></h2>
      <dl className="facts">
        <dt>What</dt><dd>{kindOf(row)}{row.chapter_id ? ` · ${row.chapter_id}` : ''}{row.options?.force_new_version ? ' · --force-new-version' : ''}</dd>
        <dt>When</dt><dd>{when(row.started_at)}</dd>
        <dt>File</dt><dd className="file">{row.file_path}</dd>
        <dt>Commit</dt><dd>{row.git_commit ?? '—'}</dd>
        <dt>File hash</dt><dd className="mono">{row.file_hash.slice(0, 12)}…</dd>
        <dt>Counts</dt><dd>{countLines(row.counts).map((l) => <div key={l}>{l}</div>)}</dd>
        <dt>Problems</dt><dd>{errors} error{errors === 1 ? '' : 's'} · {warnings} warning{warnings === 1 ? '' : 's'}</dd>
      </dl>

      {outcomes.length > 0 && (
        <>
          <h3>Questions</h3>
          <ul className="report">
            {outcomes.map((o) => (
              <li key={o.key} className={o.result === 'blocked' ? 'blocked' : ''}>
                <div><strong>{o.key}</strong>{o.question_id ? <span className="muted"> · {o.question_id}{o.version ? ` v${o.version}` : ''}</span> : null}
                  {' '}<span className={`tag ${o.result}`}>{OUTCOME[o.result] ?? o.result}</span>{o.note ? <span className="muted"> — {o.note}</span> : null}</div>
                {problems.filter((p) => p.key === o.key).map((p, i) => <Line key={i} p={p} />)}
              </li>
            ))}
          </ul>
        </>
      )}
      {fileLevel.length > 0 && (
        <>
          <h3>{outcomes.length ? 'File' : 'Report'}</h3>
          <ul className="report">{fileLevel.map((p, i) => <li key={i}><Line p={p} where={p.where ?? (p.key !== 'file' ? p.key : undefined)} /></li>)}</ul>
        </>
      )}
      {problems.length === 0 && outcomes.length === 0 && <p className="muted">No problems reported.</p>}
    </>
  );
}

function Line({ p, where }: { p: Problem; where?: string }) {
  return <div className={`line ${p.level}`}><span className="lvl">{p.level === 'error' ? 'Error' : 'Warning'}</span>{where ? <span className="muted">{where}: </span> : null}{p.message}</div>;
}

function Result({ r }: { r: ImportRow['result'] }) {
  const label = r === 'ok' ? 'OK' : r === 'partial' ? 'Partial' : r === 'failed' ? 'Failed' : 'Running';
  return <span className={`badge ${r ?? 'running'}`}>{label}</span>;
}

// ---------------------------------------------------------------- U3: local mode
interface LocalFolder { folder: string; files: { name: string; questions: number; modified: string }[]; proposals: boolean; book: boolean; staged: boolean }
interface Step { label: string; command: string; code: number; output: string }

/**
 * Local mode only (npm run dev:files on your Mac serves /api/local): pick a pipeline folder
 * and chapter file → Check (originality on this Mac + validation, nothing saved) → Import.
 * The live site has no /api/local, so this panel does not appear there.
 */
function LocalImport() {
  const [status, setStatus] = useState<{ root: string; database: string } | null>(null);
  const [folders, setFolders] = useState<LocalFolder[] | null>(null);
  const [folder, setFolder] = useState('');
  const [file, setFile] = useState('');
  const [steps, setSteps] = useState<{ kind: 'check' | 'import'; steps: Step[] } | null>(null);
  const [busy, setBusy] = useState<null | 'check' | 'import'>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/local/status').then(async (r) => {
      const j = r.ok && (r.headers.get('content-type') ?? '').includes('json') ? await r.json() : null;
      if (j?.local === true) { setStatus(j); setFolders(await (await fetch('/api/local/folders')).json()); }
    }).catch(() => setStatus(null));
  }, []);
  if (!status) return null;
  const f = folders?.find((x) => x.folder === folder);
  const go = async (kind: 'check' | 'import') => {
    setBusy(kind); setError(null); if (kind === 'check') setSteps(null);
    try {
      const r = await fetch(`/api/local/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder, files: file ? [file] : null }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setSteps({ kind, steps: j.steps });
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const checked = steps?.kind === 'check' && steps.steps.length > 0 && !steps.steps.some((s) => s.code !== 0 && /^Stage|^Proposed|^Book/.test(s.label));
  return (
    <div className="local-import card wide-card">
      <div className="group-title">Import from this Mac <span className="tag">local mode</span></div>
      <div className="muted small">Pipeline folders in <span className="mono">{status.root}</span> · database: {status.database}. Book files are read here only; nothing book-derived leaves the Mac.
        Check first (originality + validation, nothing saved), then Import. A near-copy blocks that question; a close match is a warning.</div>
      <div className="filters">
        <select value={folder} onChange={(e) => { setFolder(e.target.value); setFile(''); setSteps(null); }} aria-label="Pipeline folder">
          <option value="">Pick a pipeline folder…</option>
          {(folders ?? []).map((x) => <option key={x.folder} value={x.folder}>{x.folder} · {x.files.length} chapter file{x.files.length === 1 ? '' : 's'}</option>)}
        </select>
        {f && <select value={file} onChange={(e) => { setFile(e.target.value); setSteps(null); }} aria-label="Chapter file">
          <option value="">All {f.files.length} chapter files</option>
          {f.files.map((x) => <option key={x.name} value={x.name}>{x.name} · {x.questions} questions</option>)}
        </select>}
        <button className="secondary" disabled={!f || !!busy} onClick={() => go('check')}>{busy === 'check' ? 'Checking…' : '1 · Check'}</button>
        <button disabled={!f || !!busy || !checked} onClick={() => go('import')} title={checked ? '' : 'Run Check first'}>{busy === 'import' ? 'Importing…' : '2 · Import'}</button>
        {f && <span className="muted small">{[f.proposals && 'proposals', f.book && 'book citations'].filter(Boolean).join(' + ') || 'questions only'}</span>}
      </div>
      {error && <p className="error">{error}</p>}
      {busy && <p className="muted small">Running on this Mac… (the originality check reads the book PDFs; this can take a minute)</p>}
      {steps && (
        <div className="steps">
          <div className="small"><strong>{steps.kind === 'check' ? 'Check' : 'Import'}</strong> · {steps.steps.filter((s) => s.code === 0).length} of {steps.steps.length} steps OK
            {steps.kind === 'import' && <> · <a href="#/imports" onClick={() => location.reload()}>refresh the history</a></>}</div>
          {steps.steps.map((s, i) => (
            <details key={i} open={s.code !== 0 || /Originality|Validate|Import ·/.test(s.label)}>
              <summary><span className={`badge ${s.code === 0 ? 'ok' : 'failed'}`}>{s.code === 0 ? 'OK' : `exit ${s.code}`}</span> {s.label}</summary>
              <div className="mono small muted">{s.command}</div>
              <pre className="step-out">{s.output || '(no output)'}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

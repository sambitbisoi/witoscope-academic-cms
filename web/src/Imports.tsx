// Imports: read-only history of every import (chapter files, topic lists, v10 seed)
// with the report in plain words. Data comes from cms_imports (RLS: admin only).
import { useEffect, useState } from 'react';
import { supabase } from './supabase';

interface ImportRow {
  import_id: number; kind: 'chapter' | 'topics' | 'seed'; file_path: string; git_commit: string | null; file_hash: string;
  chapter_id: string | null; options: Record<string, unknown>; started_at: string; finished_at: string | null;
  result: 'ok' | 'partial' | 'failed' | null; counts: Record<string, unknown>; error_report: unknown;
}
interface Problem { level: 'error' | 'warning'; key?: string; where?: string; message: string }
interface Outcome { key: string; question_id?: string; result: string; version?: number; note?: string }

const KIND: Record<ImportRow['kind'], string> = { chapter: 'Chapter file', topics: 'Topic lists', seed: 'v10 seed' };
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
      <p className="muted">Every import run, newest first. Imports run from the command line; this page only shows them.</p>
      {rows.length === 0 ? <p className="muted">No imports yet.</p> : (
        <table className="list">
          <thead><tr><th>#</th><th>When</th><th>What</th><th>File</th><th>Result</th><th>Summary</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.import_id} onClick={() => (location.hash = `#/imports/${r.import_id}`)}>
                <td><a href={`#/imports/${r.import_id}`}>{r.import_id}</a></td>
                <td>{when(r.started_at)}</td>
                <td>{KIND[r.kind]}{r.chapter_id ? ` · ${r.chapter_id}` : ''}</td>
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
        <dt>What</dt><dd>{KIND[row.kind]}{row.chapter_id ? ` · ${row.chapter_id}` : ''}{row.options?.force_new_version ? ' · --force-new-version' : ''}</dd>
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

// S2 (queue 12 Nov 2026): every source with its publisher, class, kind, link, chapters, citations,
// the questions citing it and when it last changed; chapters with no source and sources linked
// to no chapter are highlighted. D7: a source is retired (hidden), never deleted. Citations and
// official links only; the books stay on Sambit's Mac.
import { useEffect, useMemo, useState } from 'react';
import { all } from './api';
import { browseHash, safeSearch, subjectOfChapter } from './logic';
import { officialLink } from './sourcesApi';
import { supabase } from './supabase';

interface Src { source_id: string; kind: 'pdf' | 'scanned_pdf' | 'web'; title: string; publisher: string; class: number | null; url: string | null; status: string;
  captured_at: string | null; chapters: string[]; n_citations: number; n_questions: number; last_updated: string | null }

export function SourcesOverview({ subject, cls, ch, q }: { subject: string; cls: string; ch: string | null; q: string }) {
  const [rows, setRows] = useState<Src[] | null>(null);
  const [chapters, setChapters] = useState<{ chapter_id: string; name: string; subject: string; status: string }[]>([]);
  const [linked, setLinked] = useState<Set<string>>(new Set());
  const [showRetired, setShowRetired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    Promise.all([
      all<Src>((a, b) => supabase.from('cms_source_overview').select('*').order('publisher').order('class').order('title').range(a, b)),
      all<{ chapter_id: string; name: string; subject: string; status: string }>((a, b) => supabase.from('cms_chapters').select('chapter_id, name, subject, status').order('chapter_id').range(a, b)),
      all<{ chapter_id: string }>((a, b) => supabase.from('cms_source_chapters').select('chapter_id').range(a, b)),
    ]).then(([s, c, l]) => { setRows(s); setChapters(c); setLinked(new Set(l.map((x) => x.chapter_id))); }).catch((e) => setError(e.message));
  }, [reload]);

  const text = safeSearch(q).toLowerCase();
  const inScope = (chapterIds: string[]) => (subject === 'all' || chapterIds.some((c) => subjectOfChapter(c) === subject)) && (!ch || chapterIds.includes(ch));
  const shown = useMemo(() => (rows ?? []).filter((s) => (showRetired || s.status !== 'retired')
    && (cls === 'all' || s.class === Number(cls) || s.class === null)
    && (s.chapters.length === 0 ? !ch : inScope(s.chapters))
    && (!text || `${s.source_id} ${s.title} ${s.publisher} ${s.chapters.join(' ')}`.toLowerCase().includes(text))), [rows, showRetired, cls, ch, text, subject]); // eslint-disable-line react-hooks/exhaustive-deps
  const bare = chapters.filter((c) => c.status === 'active' && !linked.has(c.chapter_id) && (subject === 'all' || c.subject === subject) && (!ch || c.chapter_id === ch));
  const unlinked = (rows ?? []).filter((s) => s.status !== 'retired' && s.chapters.length === 0);

  async function retire(s: Src, to: 'retired' | 'active') {
    const why = to === 'retired' ? prompt(`Why retire ${s.source_id}? (hidden, never deleted; logged)`) : 'restored';
    if (!why?.trim()) return;
    setBusy(s.source_id);
    try {
      const { data: u } = await supabase.auth.getUser();
      const r1 = await supabase.from('cms_sources').update({ status: to, updated_at: new Date().toISOString() }).eq('source_id', s.source_id);
      if (r1.error) throw new Error(r1.error.message);
      const r2 = await supabase.from('cms_reviews').insert({ target: 'catalogue', target_table: 'cms_sources', target_id: s.source_id, action: to === 'retired' ? 'retire' : 'restore',
        reason: why.trim(), field_diff: { status: { before: s.status, after: to } }, by_user: u.user!.id, by_label: 'Sambit' });
      if (r2.error) throw new Error(r2.error.message);
      setReload((x) => x + 1);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  if (error) return <p className="error">Couldn't load sources: {error}</p>;
  if (!rows) return <p className="muted">Loading…</p>;
  return (
    <>
      <p className="muted small">Every book and link the CMS cites. Imports register their books and citations; add a source from a chapter's Sources tab. Citations and official links only: the books stay on your Mac.
        Nothing is deleted; retire a source you no longer use.</p>
      {(bare.length > 0 || unlinked.length > 0) && (
        <div className="notice small">
          {bare.length > 0 && <div><strong>{bare.length} chapter{bare.length === 1 ? '' : 's'} with no source:</strong>{' '}
            {bare.slice(0, 40).map((c, i) => <span key={c.chapter_id}>{i > 0 && ', '}<a href={browseHash({ subject: c.subject, cls: 'all', ch: c.chapter_id })}>{c.chapter_id}</a></span>)}{bare.length > 40 && ' …'}</div>}
          {unlinked.length > 0 && <div><strong>{unlinked.length} source{unlinked.length === 1 ? '' : 's'} linked to no chapter:</strong> {unlinked.map((s) => s.source_id).join(', ')}</div>}
        </div>
      )}
      <div className="filters"><span className="muted small">{shown.length} of {rows.length} sources</span>
        <label className="check small"><input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> show retired</label></div>
      <table className="list map-table">
        <thead><tr><th>Source</th><th>Publisher</th><th>Class</th><th>Kind</th><th>Chapters</th><th>Citations</th><th>Questions</th><th>Last updated</th><th /></tr></thead>
        <tbody>
          {shown.slice(0, 600).map((s) => {
            const link = officialLink(s);
            return (
              <tr key={s.source_id} className={`${s.status === 'retired' ? 'retired' : ''} ${s.chapters.length === 0 ? 'warn-row' : ''}`}>
                <td><div>{s.title}</div><div className="mono small muted">{s.source_id}{link && <> · <a href={link} target="_blank" rel="noopener noreferrer">official ↗</a></>}</div></td>
                <td>{s.publisher}</td>
                <td>{s.class ?? '—'}</td>
                <td className="small">{s.kind === 'scanned_pdf' ? 'Scanned PDF' : s.kind === 'pdf' ? 'PDF' : 'Web'}</td>
                <td className="small">{s.chapters.length === 0 ? <span className="gap">none</span> : s.chapters.map((c, i) => <span key={c}>{i > 0 && ', '}
                  <a href={browseHash({ subject: subjectOfChapter(c), cls: s.class ? String(s.class) : 'all', ch: c })}>{c}</a></span>)}</td>
                <td>{s.n_citations}</td>
                <td>{s.n_questions}</td>
                <td className="small nowrap">{s.last_updated ? new Date(s.last_updated).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</td>
                <td>{s.status === 'retired' ? <button className="link small" disabled={busy === s.source_id} onClick={() => retire(s, 'active')}>Restore</button>
                  : <button className="link small" disabled={busy === s.source_id} onClick={() => retire(s, 'retired')}>Retire…</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

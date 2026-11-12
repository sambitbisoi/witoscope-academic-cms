// Sources tab (Phase 4; 10 Nov 2026): book citations for cross-checking. Internal only.
// The books themselves stay on Sambit's Mac: the tab shows titles, pages and sections as
// text, plus the official public link (ncert.nic.in) where there is one.
import { useEffect, useState } from 'react';
import {
  chapterSources, idTaken, topicSourceCounts, officialLink, saveSource, sortSources, suggestId, validate,
  type ChapterSource, type Jump, type SourceForm,
} from './sourcesApi';
import { supabase } from './supabase';

const KIND_LABEL: Record<ChapterSource['kind'], string> = { pdf: 'PDF', scanned_pdf: 'Scanned PDF', web: 'Web' };

export function SourcesTab({ chapterId, chapterName, cls, topicId }: { chapterId: string; chapterName: string; cls: number; topicId?: string }) {
  const [data, setData] = useState<{ sources: ChapterSource[]; jumps: Jump[] } | null>(null);
  // U17: "This topic" shows only the sources with citations for the open topic.
  const [thisTopic, setThisTopic] = useState(false);
  const [topicCounts, setTopicCounts] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    setTopicCounts(null);
    if (topicId) topicSourceCounts(topicId).then(setTopicCounts).catch(() => setTopicCounts(new Map()));
  }, [topicId]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ChapterSource | 'new' | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const load = () => { setError(null); chapterSources(chapterId).then(setData).catch((e) => setError(e.message)); };
  useEffect(() => { setData(null); setEditing(null); load(); }, [chapterId]);

  return (
    <>
      <div className="sources-head">
        <div className="muted small">Book citations for {chapterId} (all its topics) · internal only, never published · the books stay on your Mac; here only titles, pages and sections, and the official link.</div>
        <div className="source-actions">
          {topicId && <button className={`pill small ${thisTopic ? 'on' : ''}`} aria-pressed={thisTopic} onClick={() => setThisTopic(!thisTopic)}>
            This topic{topicCounts ? ` · ${topicCounts.size}` : ''}</button>}
          {!editing && <button className="secondary" onClick={() => setEditing('new')}>+ Add a citation</button>}
        </div>
      </div>
      {flash && <div className="notice small">{flash}</div>}
      {editing && (
        <SourceEditor chapterId={chapterId} chapterName={chapterName} cls={cls} before={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)} onSaved={(id) => { setEditing(null); setFlash(`Saved ${id}.`); load(); }} />
      )}
      {error && <p className="error">Couldn't load sources: {error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && data.sources.length === 0 && <p className="muted">No sources for {chapterId} yet.</p>}
      {data && thisTopic && topicCounts && !data.sources.some((s) => topicCounts.has(s.source_id)) && <p className="muted">No source cites {topicId} yet.</p>}
      {data && sortSources(data.sources, cls).filter((s) => !thisTopic || !topicCounts || topicCounts.has(s.source_id)).map((s) => {
        const jumps = data.jumps.filter((j) => j.source_id === s.source_id);
        const link = officialLink(s);
        const printed = (p: number) => p - s.page_offset;
        return (
          <div key={s.source_id} className="source-card">
            <div className="source-top">
              <div>
                <div className="group-title">{s.title}</div>
                <div className="muted small">
                  <span className="tag">{KIND_LABEL[s.kind]}</span> {s.publisher}{s.class ? ` · Class ${s.class}` : ''}
                  {s.page_from ? ` · pdf pages ${s.page_from}–${s.page_to ?? '?'}${s.page_offset ? ` (printed ${printed(s.page_from)}–${s.page_to ? printed(s.page_to) : '?'})` : ''}` : ''}
                  {s.n_items ? ` · ${s.n_items} item${s.n_items === 1 ? '' : 's'} cited${s.n_items_in_chapter !== s.n_items ? ` (${s.n_items_in_chapter} in ${chapterId})` : ''}` : ''}
                  {topicId && topicCounts?.get(s.source_id) ? ` · ${topicCounts.get(s.source_id)} for ${topicId}` : ''}
                </div>
                <div className="muted small">
                  {link ? <span className="mono">{link}</span> : 'No official link · the book is on your Mac'}
                  {s.captured_at ? ` · checked ${new Date(s.captured_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
                  <span className="mono"> · {s.source_id}</span>
                </div>
              </div>
              <div className="source-actions">
                {link && <a className="button" href={officialLink(s, s.page_from)!} target="_blank" rel="noopener noreferrer">{s.kind === 'web' ? 'Open link ↗' : 'Official PDF ↗'}</a>}
                <button className="link" onClick={() => setEditing(s)}>Edit</button>
              </div>
            </div>
            {jumps.length > 0 && (
              <ul className="jumps-text small">
                {jumps.map((j) => (
                  <li key={j.jump_id}>{j.label} · {link
                    ? <a href={officialLink(s, j.pdf_page)!} target="_blank" rel="noopener noreferrer">p{j.pdf_page}</a>
                    : <>p{j.pdf_page}</>}{s.page_offset ? <span className="muted"> (printed {printed(j.pdf_page)})</span> : null}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {data && data.sources.length > 0 && (
        <p className="muted small">Pages are PDF pages; an official link opens ncert.nic.in at that page in a new tab. Your own copies (and DAV scans) are on your Mac, at the same page.</p>
      )}
    </>
  );
}

function SourceEditor({ chapterId, chapterName, cls, before, onCancel, onSaved }: {
  chapterId: string; chapterName: string; cls: number; before: ChapterSource | null; onCancel: () => void; onSaved: (id: string) => void;
}) {
  const [f, setF] = useState<SourceForm>(() => ({
    source_id: before?.source_id ?? '', isNew: !before, title: before?.title ?? '', publisher: before?.publisher ?? 'NCERT',
    kind: before?.kind ?? 'pdf', class: before?.class ?? cls, url: before?.url ?? '', page_offset: before?.page_offset ?? 0,
    captured_at: before?.captured_at?.slice(0, 10) ?? '', chapter_id: chapterId, page_from: before?.page_from ?? null, page_to: before?.page_to ?? null,
    newJumps: [],
  }));
  const [idTouched, setIdTouched] = useState(!!before);
  const [more, setMore] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<SourceForm>) => setF((x) => {
    const n = { ...x, ...p };
    if (!idTouched && x.isNew && ('title' in p || 'publisher' in p)) n.source_id = suggestId(n.publisher, n.title);
    return n;
  });
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const isFile = f.kind === 'pdf' || f.kind === 'scanned_pdf';

  async function save() {
    const e = validate(f);
    if (f.isNew && !e.length && await idTaken(f.source_id)) e.push(`Source ID ${f.source_id} is already used; change it under More.`);
    setErrors(e);
    if (e.length) return;
    setBusy(true);
    try {
      const { data } = await supabase.auth.getUser();
      await saveSource(f, before, data.user!.id);
      onSaved(f.source_id);
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="editor card">
      <div className="group-title">{before ? `Edit ${before.source_id}` : `Add a source to ${chapterId} ${chapterName}`}</div>
      <div className="form-grid">
        <label className="wide">Title<input value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="NCERT Ganita Prakash, Class 6 · Ch 7 Fractions" /></label>
        <label>Publisher<select value={f.publisher} onChange={(e) => set({ publisher: e.target.value })}>{['NCERT', 'DAV', 'IXL', 'SOF', 'other'].map((p) => <option key={p}>{p}</option>)}</select></label>
        <label>Kind<select value={f.kind} onChange={(e) => set({ kind: e.target.value as SourceForm['kind'] })}>
          {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>Class<select value={f.class ?? ''} onChange={(e) => set({ class: num(e.target.value) })}><option value="">—</option>{[1, 2, 3, 4, 5, 6].map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        <label className="wide">{isFile ? 'Official PDF link' : 'Link'}{isFile ? <span className="muted small"> — optional; NCERT: https://ncert.nic.in/…</span> : null}
          <input value={f.url} onChange={(e) => set({ url: e.target.value })} placeholder={f.publisher === 'NCERT' ? 'https://ncert.nic.in/textbook/pdf/fegp107.pdf' : 'https://…'} /></label>
        {isFile && <>
          <label>PDF pages for {chapterId}: from<input type="number" min={1} value={f.page_from ?? ''} onChange={(e) => set({ page_from: num(e.target.value) })} /></label>
          <label>to<input type="number" min={1} value={f.page_to ?? ''} onChange={(e) => set({ page_to: num(e.target.value) })} /></label>
        </>}
      </div>
      <button className="link more" aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'Less' : 'More'}: source ID, page offset, jumps, date checked</button>
      {more && (
        <div className="form-grid">
          <label>Source ID{!f.isNew && <span className="muted small"> (permanent)</span>}<input value={f.source_id} disabled={!f.isNew} onChange={(e) => { setIdTouched(true); setF({ ...f, source_id: e.target.value }); }} /></label>
          {isFile && <label>Page offset<span className="muted small"> printed page = PDF page − offset</span><input type="number" value={f.page_offset} onChange={(e) => set({ page_offset: Number(e.target.value) })} /></label>}
          <label>Checked on<input type="date" value={f.captured_at} onChange={(e) => set({ captured_at: e.target.value })} /></label>
          {isFile && (
            <div className="wide">
              <div className="small">New "open at" jumps for {chapterId} <span className="muted">(existing jumps are kept)</span></div>
              {f.newJumps.map((j, i) => (
                <div key={i} className="jump-row">
                  <input placeholder="7.5 Mixed fractions" value={j.label} onChange={(e) => set({ newJumps: f.newJumps.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)) })} />
                  <input type="number" min={1} placeholder="PDF page" value={Number.isNaN(j.pdf_page) ? '' : j.pdf_page} onChange={(e) => set({ newJumps: f.newJumps.map((x, k) => (k === i ? { ...x, pdf_page: Number(e.target.value) } : x)) })} />
                  <button className="link" onClick={() => set({ newJumps: f.newJumps.filter((_, k) => k !== i) })}>Remove</button>
                </div>
              ))}
              <button className="link" onClick={() => set({ newJumps: [...f.newJumps, { label: '', pdf_page: NaN }] })}>+ Add a jump</button>
            </div>
          )}
        </div>
      )}
      {errors.length > 0 && <ul className="errors">{errors.map((e) => <li key={e} className="error small">{e}</li>)}</ul>}
      <div className="editor-actions">
        <button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

// Sources tab (Phase 4): source books for cross-checking. Internal only.
import { useEffect, useState } from 'react';
import {
  chapterSources, idTaken, openSource, saveSource, signedUrl, sortSources, sourceAssets, suggestId, validate,
  type Asset, type ChapterSource, type Jump, type SourceForm,
} from './sourcesApi';
import { supabase } from './supabase';

const KIND_LABEL: Record<ChapterSource['kind'], string> = { pdf: 'PDF', scanned_pdf: 'Scanned PDF', web: 'Web', screenshots: 'Screenshots' };

export function SourcesTab({ chapterId, chapterName, cls }: { chapterId: string; chapterName: string; cls: number }) {
  const [data, setData] = useState<{ sources: ChapterSource[]; jumps: Jump[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ChapterSource | 'new' | null>(null);
  const [gallery, setGallery] = useState<ChapterSource | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const load = () => { setError(null); chapterSources(chapterId).then(setData).catch((e) => setError(e.message)); };
  useEffect(() => { setData(null); setEditing(null); load(); }, [chapterId]);

  return (
    <>
      <div className="sources-head">
        <div className="muted small">Source books for cross-checking · internal only, never published · each opens full screen in its own tab, so you can put two side by side.</div>
        {!editing && <button className="secondary" onClick={() => setEditing('new')}>+ Add PDF, link or screenshots</button>}
      </div>
      {flash && <div className="notice small">{flash}</div>}
      {editing && (
        <SourceEditor chapterId={chapterId} chapterName={chapterName} cls={cls} before={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)} onSaved={(id) => { setEditing(null); setFlash(`Saved ${id}.`); load(); }} />
      )}
      {error && <p className="error">Couldn't load sources: {error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && data.sources.length === 0 && <p className="muted">No sources for {chapterId} yet.</p>}
      {data && sortSources(data.sources, cls).map((s) => {
        const jumps = data.jumps.filter((j) => j.source_id === s.source_id);
        const stored = !!s.storage_path;
        const isFile = s.kind === 'pdf' || s.kind === 'scanned_pdf';
        return (
          <div key={s.source_id} className="source-card">
            <div className="source-top">
              <div>
                <div className="group-title">{s.title}</div>
                <div className="muted small">
                  <span className="tag">{KIND_LABEL[s.kind]}</span> {s.publisher}{s.class ? ` · Class ${s.class}` : ''}
                  {s.page_from ? ` · pdf pages ${s.page_from}–${s.page_to ?? '?'}` : ''}
                  {s.n_items ? ` · ${s.n_items} item${s.n_items === 1 ? '' : 's'} mapped${s.n_items_in_chapter !== s.n_items ? ` (${s.n_items_in_chapter} in ${chapterId})` : ''}` : ''}
                </div>
                <div className="muted small">
                  {isFile ? (stored ? 'Stored privately' : s.url ? 'Not uploaded yet · opens the public link' : 'No file yet') : s.kind === 'web' ? (s.url ?? '') : `${s.n_assets} screenshot${s.n_assets === 1 ? '' : 's'}`}
                  {s.captured_at ? ` · captured ${new Date(s.captured_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
                  <span className="mono"> · {s.source_id}</span>
                </div>
              </div>
              <div className="source-actions">
                {(stored || s.url) && <button onClick={() => openSource(s, s.page_from)}>{isFile ? 'Open full screen ↗' : 'Open in browser ↗'}</button>}
                {s.n_assets > 0 && <button className="secondary" onClick={() => setGallery(s)}>Screenshots · {s.n_assets} ↗</button>}
                <button className="link" onClick={() => setEditing(s)}>Edit</button>
              </div>
            </div>
            {jumps.length > 0 && (
              <div className="jumps">
                <span className="muted small">Open full screen at</span>
                {jumps.map((j) => <button key={j.jump_id} className="pill small" onClick={() => openSource(s, j.pdf_page)}>{j.label} p{j.pdf_page} ↗</button>)}
              </div>
            )}
          </div>
        );
      })}
      {data && data.sources.length > 0 && (
        <p className="muted small">PDFs open in the browser's own viewer at the chosen page. Web links open in a new tab. Screenshots, for pages that change or need a login, open as a full-screen gallery.</p>
      )}
      {gallery && <Gallery source={gallery} onClose={() => setGallery(null)} />}
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
    file: null, screenshots: [], newJumps: [],
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
        {isFile && <label className="wide">PDF file{before?.storage_path ? <span className="muted small"> (stored: {before.storage_path.split('/').pop()}; choose a file only to replace it)</span> : null}
          <input type="file" accept="application/pdf" onChange={(e) => set({ file: e.target.files?.[0] ?? null })} /></label>}
        {(f.kind === 'web' || isFile) && <label className="wide">{isFile ? 'Or a link to the PDF' : 'Link'}<input value={f.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://…" /></label>}
        {f.kind === 'screenshots' || f.kind === 'web' ? (
          <label className="wide">Screenshots (PNG, JPEG, WebP){f.kind === 'web' ? <span className="muted small"> — optional dated copy</span> : null}
            <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(e) => set({ screenshots: [...(e.target.files ?? [])] })} /></label>
        ) : null}
        {isFile && <>
          <label>PDF pages for {chapterId}: from<input type="number" min={1} value={f.page_from ?? ''} onChange={(e) => set({ page_from: num(e.target.value) })} /></label>
          <label>to<input type="number" min={1} value={f.page_to ?? ''} onChange={(e) => set({ page_to: num(e.target.value) })} /></label>
        </>}
      </div>
      <button className="link more" aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'Less' : 'More'}: source ID, page offset, jumps, capture date</button>
      {more && (
        <div className="form-grid">
          <label>Source ID{!f.isNew && <span className="muted small"> (permanent)</span>}<input value={f.source_id} disabled={!f.isNew} onChange={(e) => { setIdTouched(true); setF({ ...f, source_id: e.target.value }); }} /></label>
          {isFile && <label>Page offset<span className="muted small"> printed page = PDF page − offset</span><input type="number" value={f.page_offset} onChange={(e) => set({ page_offset: Number(e.target.value) })} /></label>}
          <label>Captured on<input type="date" value={f.captured_at} onChange={(e) => set({ captured_at: e.target.value })} /></label>
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

function Gallery({ source, onClose }: { source: ChapterSource; onClose: () => void }) {
  const [items, setItems] = useState<(Asset & { href?: string })[] | null>(null);
  const [i, setI] = useState(0);
  useEffect(() => {
    sourceAssets(source.source_id).then(async (a) => setItems(await Promise.all(a.map(async (x) => ({ ...x, href: await signedUrl(x.storage_path).catch(() => undefined) })))))
      .catch(() => setItems([]));
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight') setI((n) => n + 1); if (e.key === 'ArrowLeft') setI((n) => Math.max(0, n - 1)); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [source.source_id]);
  const cur = items?.[Math.min(i, (items?.length ?? 1) - 1)];
  return (
    <div className="gallery" role="dialog" aria-label={`Screenshots: ${source.title}`}>
      <div className="gallery-bar">
        <span>{source.title}{items?.length ? ` · ${Math.min(i, items.length - 1) + 1} of ${items.length}` : ''}</span>
        <span><button className="secondary" onClick={() => setI(Math.max(0, i - 1))}>←</button> <button className="secondary" onClick={() => setI(Math.min((items?.length ?? 1) - 1, i + 1))}>→</button> <button onClick={onClose}>Close</button></span>
      </div>
      {!items ? <p className="muted">Loading…</p> : !cur ? <p className="muted">No screenshots.</p> : (
        <figure>{cur.href ? <img src={cur.href} alt={cur.caption ?? ''} /> : <p className="error">Couldn't load this image.</p>}<figcaption className="small">{cur.caption}</figcaption></figure>
      )}
    </div>
  );
}

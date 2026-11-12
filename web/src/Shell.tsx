import { useEffect, useRef, useState, type ReactNode } from 'react';
import { locateQuestion, search, topicHome, type SearchHit } from './api';
import { browseHash, subjectOfChapter, type Route } from './logic';
import { supabase } from './supabase';

export function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

const LAST_BROWSE = 'cms.lastBrowse';
export const rememberBrowse = (hash: string) => { try { localStorage.setItem(LAST_BROWSE, hash); } catch { /* best effort */ } };
const lastBrowse = () => { try { return localStorage.getItem(LAST_BROWSE) ?? '#/browse/math/6'; } catch { return '#/browse/math/6'; } };

export function Shell({ email, route, children }: { email?: string; route: Route; children: ReactNode }) {
  const section = route.name === 'browse' || route.name === 'question' ? 'browse' : route.name === 'imports' || route.name === 'import' ? 'imports' : route.name === 'review' ? 'review' : route.name === 'proposed' ? 'proposed' : route.name === 'map' ? 'map' : 'home';
  return (
    <div className="page">
      <header>
        <nav>
          <a href="#/" className="brand">WitoScope CMS</a>
          <a href="#/" className={section === 'home' ? 'active' : ''}>Home</a>
          <a href={lastBrowse()} className={section === 'browse' ? 'active' : ''}>Browse</a>
          <a href="#/map" className={section === 'map' ? 'active' : ''}>Curriculum</a>
          <a href="#/review" className={section === 'review' ? 'active' : ''}>Review</a>
          <a href="#/proposed" className={section === 'proposed' ? 'active' : ''}>Proposed</a>
          <a href="#/imports" className={section === 'imports' ? 'active' : ''}>Imports</a>
        </nav>
        <div className="header-right">
          <Search />
          <span className="who"><span className="email">{email}</span> <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button></span>
        </div>
      </header>
      {children}
    </div>
  );
}

const KIND_LABEL: Record<SearchHit['kind'], string> = { topic: 'Topics', set: 'Typical sets', pattern: 'Patterns', concept: 'Concepts', question: 'Questions' };

/** Where a search hit opens. Hits that only know a topic look up its chapter and class. */
export async function openHit(h: SearchHit) {
  if (h.kind === 'question') { location.hash = `#/q/${encodeURIComponent(h.id)}`; return; }
  const t = h.topicId ? await topicHome(h.topicId) : null;
  if (!t) { if (h.chapterId) location.hash = browseHash({ subject: subjectOfChapter(h.chapterId), cls: h.cls ? String(h.cls) : 'all' }); return; }
  location.hash = browseHash({ subject: subjectOfChapter(t.chapter_id), cls: String(t.class), ch: t.chapter_id, topic: t.topic_id, tab: h.kind === 'concept' ? 'concepts' : 'types' });
}

function Search() {
  const [text, setText] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (text.trim().length < 2) { setHits(null); return; }
    const t = setTimeout(() => { search(text).then(setHits).catch(() => setHits([])); }, 250);
    return () => clearTimeout(t);
  }, [text]);
  const hash = useHash();
  useEffect(() => { setOpen(false); }, [hash]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const go = (h: SearchHit) => { setOpen(false); setText(''); void openHit(h); };
  const kinds = hits ? [...new Set(hits.map((h) => h.kind))] : [];
  return (
    <div className="search" ref={box}>
      <label htmlFor="search" className="sr-only">Search</label>
      <input id="search" placeholder="Search topic, set, pattern, concept or question ID" value={text}
        onChange={(e) => { setText(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Enter' && hits?.[0]) go(hits[0]); if (e.key === 'Escape') setOpen(false); }} />
      {open && hits && (
        <div className="search-results" role="listbox">
          {hits.length === 0 ? <div className="muted pad">Nothing found.</div> : kinds.map((k) => (
            <div key={k}>
              <div className="search-kind">{KIND_LABEL[k]}</div>
              {hits.filter((h) => h.kind === k).map((h) => (
                <button key={`${k}-${h.id}`} className="search-hit" role="option" onClick={() => go(h)}>
                  <span className="mono">{h.id}</span> <span className="hit-label">{h.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** #/q/<id>: find the question's topic and open it there. */
export function OpenQuestion({ id }: { id: string }) {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    locateQuestion(id).then((q) => {
      if (!q) { setMissing(true); return; }
      location.replace(browseHash({ subject: subjectOfChapter(q.chapter_id), cls: String(q.class), ch: q.chapter_id, topic: q.topic_id, q: q.question_id }));
    }).catch(() => setMissing(true));
  }, [id]);
  return <main><p className={missing ? '' : 'muted'}>{missing ? <>Question {id} doesn't exist. <a href="#/">Home</a></> : 'Opening…'}</p></main>;
}

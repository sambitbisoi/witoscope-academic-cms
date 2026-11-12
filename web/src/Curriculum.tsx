// S1 (queue 12 Nov 2026): the curriculum map. One row per topic and class it is in (D2), with
// its question counts under the display rule (D3), the other classes it is in, and its
// prerequisites (D4). Chapter → Browse at the chapter; topic → Browse at the topic.
import { useEffect, useMemo, useState } from 'react';
import { all, topicsWithClasses, type ClassStats, type TopicWithStats } from './api';
import { ClassesPill } from './Workspace';
import { browseHash, gapLabel, mapHash, mixLabel, safeSearch, SUBJECTS, subjectLabel, type MapShow, type Subject } from './logic';
import { supabase } from './supabase';

type R = { tab: 'topics' | 'sources'; cls: string; subject: string; ch: string | null; show: MapShow; q: string };
interface Row { topic: TopicWithStats; subject: Subject; cls: number; stats?: ClassStats; chapter: { chapter_id: string; name: string } | undefined }

async function load(subjects: Subject[]) {
  const out: { rows: Row[]; prereqs: Map<string, { id: string; name: string; chapter_id: string; class: number }[]>; chapters: { chapter_id: string; name: string; subject: Subject }[] } = { rows: [], prereqs: new Map(), chapters: [] };
  const [pre, names] = await Promise.all([
    all<{ topic_id: string; prereq_topic_id: string }>((a, b) => supabase.from('cms_topic_prereqs').select('topic_id, prereq_topic_id').order('topic_id').range(a, b)),
    Promise.resolve(new Map<string, TopicWithStats>()),
  ]);
  for (const subject of subjects) {
    const p = `${SUBJECTS.find((x) => x.id === subject)!.prefix}C*`;
    const [topics, stats, chapters] = await Promise.all([
      topicsWithClasses(subject),
      all<ClassStats & { topic_id: string; class: number }>((a, b) => supabase.from('cms_topic_class_stats').select('*').like('chapter_id', p).order('topic_id').order('class').range(a, b)),
      supabase.from('cms_chapters').select('chapter_id, name').eq('subject', subject).order('sort'),
    ]);
    const ch = (chapters.data ?? []) as { chapter_id: string; name: string }[];
    out.chapters.push(...ch.map((c) => ({ ...c, subject })));
    const st = new Map(stats.map((x) => [`${x.topic_id}|${x.class}`, x]));
    for (const t of topics) {
      names.set(t.topic_id, t);
      if (t.status !== 'active') continue;
      for (const c of t.classes) out.rows.push({ topic: t, subject, cls: c, stats: st.get(`${t.topic_id}|${c}`), chapter: ch.find((x) => x.chapter_id === t.chapter_id) });
    }
  }
  for (const x of pre) {
    const t = names.get(x.prereq_topic_id);
    out.prereqs.set(x.topic_id, [...(out.prereqs.get(x.topic_id) ?? []), { id: x.prereq_topic_id, name: t?.name ?? '', chapter_id: t?.chapter_id ?? '', class: t?.class ?? 0 }]);
  }
  return out;
}

export function CurriculumMap(r: R) {
  const [data, setData] = useState<Awaited<ReturnType<typeof load>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(r.q);
  const subjects = (r.subject === 'all' ? SUBJECTS.map((s) => s.id) : [r.subject]) as Subject[];
  useEffect(() => { setData(null); setError(null); load(subjects).then(setData).catch((e) => setError(e.message)); }, [r.subject]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(() => { if (text !== r.q) location.replace(mapHash({ ...r, q: text })); }, 300); return () => clearTimeout(t); }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (p: Partial<R>) => { location.hash = mapHash({ ...r, ...p }); };

  const q = safeSearch(r.q).toLowerCase();
  const rows = useMemo(() => (data?.rows ?? []).filter((x) =>
    (r.cls === 'all' || x.cls === Number(r.cls))
    && (!r.ch || x.topic.chapter_id === r.ch)
    && (r.show === 'all' || (r.show === 'multi' ? x.topic.classes.length > 1 : r.show === 'gaps' ? !!gapLabel(x.stats) : (x.stats?.n_questions ?? 0) === 0))
    && (!q || `${x.topic.topic_id} ${x.topic.name} ${x.chapter?.chapter_id ?? ''} ${x.chapter?.name ?? ''}`.toLowerCase().includes(q)))
    .sort((a, b) => a.cls - b.cls || SUBJECTS.findIndex((s) => s.id === a.subject) - SUBJECTS.findIndex((s) => s.id === b.subject)
      || (a.chapter?.chapter_id ?? '').localeCompare(b.chapter?.chapter_id ?? '') || (a.topic.topic_kind === 'achievers' ? 1 : 0) - (b.topic.topic_kind === 'achievers' ? 1 : 0)
      || (a.topic.seq ?? 999) - (b.topic.seq ?? 999) || a.topic.topic_id.localeCompare(b.topic.topic_id)), [data, r.cls, r.ch, r.show, q]);
  const chapters = (data?.chapters ?? []).filter((c) => r.cls === 'all' || data!.rows.some((x) => x.cls === Number(r.cls) && x.topic.chapter_id === c.chapter_id));

  return (
    <>
      <div className="section-head">
        <h2>Curriculum</h2>
      </div>
      <div className="filters">
        <select value={r.cls} onChange={(e) => go({ cls: e.target.value, ch: null })} aria-label="Class" className={r.cls !== 'all' ? 'active' : ''}>
          <option value="all">All classes</option>{[1, 2, 3, 4, 5, 6].map((c) => <option key={c} value={c}>Class {c}</option>)}
        </select>
        <select value={r.subject} onChange={(e) => go({ subject: e.target.value, ch: null })} aria-label="Subject" className={r.subject !== 'all' ? 'active' : ''}>
          <option value="all">All subjects</option>{SUBJECTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <select value={r.ch ?? ''} onChange={(e) => go({ ch: e.target.value || null })} aria-label="Chapter" className={`chapter-select ${r.ch ? 'active' : ''}`}>
          <option value="">All chapters</option>{chapters.map((c) => <option key={c.chapter_id} value={c.chapter_id}>{c.chapter_id} · {c.name}</option>)}
        </select>
        <select value={r.show} onChange={(e) => go({ show: e.target.value as MapShow })} aria-label="Show" className={r.show !== 'all' ? 'active' : ''}>
          <option value="all">Show: all topics</option><option value="multi">In several classes</option><option value="gaps">With gaps</option><option value="empty">No questions</option>
        </select>
        <input className="search-in" placeholder="Search topic or chapter" value={text} onChange={(e) => setText(e.target.value)} />
        {data && <span className="muted small">{rows.length} row{rows.length === 1 ? '' : 's'}</span>}
      </div>
      {error && <p className="error">Couldn't load the curriculum: {error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <table className="list map-table">
          <thead><tr><th>Class</th><th>Subject</th><th>Chapter</th><th>Topic</th><th>Questions</th><th>Also in</th><th>Prerequisites</th></tr></thead>
          <tbody>
            {rows.slice(0, 800).map((x) => {
              const s = x.stats; const gap = gapLabel(s);
              const pre = data.prereqs.get(x.topic.topic_id) ?? [];
              return (
                <tr key={`${x.topic.topic_id}-${x.cls}`} className={x.topic.topic_kind === 'achievers' ? 'ach' : ''}>
                  <td>{x.cls}</td>
                  <td>{subjectLabel(x.subject)}</td>
                  <td><a className="chapter-name" href={browseHash({ subject: x.subject, cls: String(x.cls), ch: x.topic.chapter_id })}>{x.topic.chapter_id} · {x.chapter?.name ?? ''}</a></td>
                  <td><a href={browseHash({ subject: x.subject, cls: String(x.cls), ch: x.topic.chapter_id, topic: x.topic.topic_id })}>
                    {x.topic.topic_kind === 'achievers' ? x.topic.name : <><span className="mono">{x.topic.topic_id}</span> {x.topic.name}</>}</a>
                    {x.cls !== x.topic.class && <span className="muted small"> · mapped (home class {x.topic.class})</span>}</td>
                  <td className="nowrap">{!s || s.n_questions === 0 ? <span className="muted">none</span> : <>
                    <strong>{s.n_questions}</strong> <span className="muted small">{mixLabel({ simple: s.n_simple, medium: s.n_medium, complex: s.n_complex })}</span>
                    {gap && <div className="gap small">⚠ {gap}</div>}</>}</td>
                  <td>{x.topic.classes.filter((c) => c !== x.cls).map((c) => <a key={c} className="class-badge" href={browseHash({ subject: x.subject, cls: String(c), ch: x.topic.chapter_id, topic: x.topic.topic_id })}>{c}</a>)}
                    {x.topic.classes.length > 1 && <ClassesPill classes={x.topic.classes} />}</td>
                  <td className="small">{pre.length === 0 ? <span className="muted">—</span> : pre.map((p, i) => <span key={p.id}>{i > 0 && ', '}
                    <a href={browseHash({ subject: x.subject, cls: String(p.class || x.cls), ch: p.chapter_id, topic: p.id })}>{p.id} {p.name}</a></span>)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {data && rows.length > 800 && <p className="muted small">Showing the first 800 of {rows.length}; filter to narrow the list.</p>}
    </>
  );
}

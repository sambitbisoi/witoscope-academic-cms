// S1 (queue 12 Nov 2026), R2 (13 Nov 2026): the curriculum map. One row per topic and class it is
// in (D2), with its role there (R1: core, or from a lower / higher class), its question counts
// under the display rule (D3) and its prerequisites (D4). Unticking "Show topic" (and "Show
// chapter") rolls the rows up to Strand → Chapter or Strand totals. Strand, chapter and topic
// links open Browse there.
import { useEffect, useMemo, useState } from 'react';
import { all, reviewOf, topicReviews, topicsWithClasses, type ClassStats, type TopicWithStats } from './api';
import { ReviewFilterSelect, RollUpIcon, TopicReviewIcon } from './ReviewStatus';
import { browseHash, gapLabel, mapHash, matchesReview, mixLabel, roleLabel, roleOf, rollUp, safeSearch, showMatches, type ReviewFilter, type ReviewStatus, type RollUp, SUBJECTS, subjectLabel, type MapShow, type Role, type Subject } from './logic';
import { supabase } from './supabase';
import { CurriculumForm, curriculumOwner, type Kind } from './CurriculumForms';
import { SourcesOverview } from './SourcesOverview';

type R = { tab: 'topics' | 'sources'; cls: string; subject: string; strand: string | null; ch: string | null; show: MapShow; q: string; chapters: boolean; topics: boolean };
interface ChapterRow { chapter_id: string; name: string; strand_id: string; sort: number }
interface StrandRow { strand_id: string; name: string; sort: number }
interface Row { topic: TopicWithStats; subject: Subject; cls: number; role: Role; review: ReviewStatus; stats?: ClassStats; chapter: ChapterRow | undefined; strand: StrandRow | undefined }
/** A rolled-up row (Show topic unticked): one per class · subject · strand (· chapter). */
interface Group { key: string; cls: number; subject: Subject; strand?: StrandRow; chapter?: ChapterRow; topics: number; questions: number; split: Record<Role, number>; qsplit: Record<Role, number> }

async function load(subjects: Subject[]) {
  const out: { rows: Row[]; prereqs: Map<string, { id: string; name: string; chapter_id: string; class: number }[]>; chapters: (ChapterRow & { subject: Subject })[]; strands: (StrandRow & { subject: Subject })[] } = { rows: [], prereqs: new Map(), chapters: [], strands: [] };
  const [pre, names, reviews] = await Promise.all([
    all<{ topic_id: string; prereq_topic_id: string }>((a, b) => supabase.from('cms_topic_prereqs').select('topic_id, prereq_topic_id').order('topic_id').range(a, b)),
    Promise.resolve(new Map<string, TopicWithStats>()),
    topicReviews(),
  ]);
  for (const subject of subjects) {
    const p = `${SUBJECTS.find((x) => x.id === subject)!.prefix}C*`;
    const [topics, stats, chapters, strands] = await Promise.all([
      topicsWithClasses(subject),
      all<ClassStats & { topic_id: string; class: number }>((a, b) => supabase.from('cms_topic_class_stats').select('*').like('chapter_id', p).order('topic_id').order('class').range(a, b)),
      supabase.from('cms_chapters').select('chapter_id, name, strand_id, sort').eq('subject', subject).order('sort'),
      supabase.from('cms_strands').select('strand_id, name, sort').eq('subject', subject).order('sort'),
    ]);
    const ch = (chapters.data ?? []) as ChapterRow[];
    const sts = (strands.data ?? []) as StrandRow[];
    out.chapters.push(...ch.map((c) => ({ ...c, subject })));
    out.strands.push(...sts.map((x) => ({ ...x, subject })));
    const st = new Map(stats.map((x) => [`${x.topic_id}|${x.class}`, x]));
    for (const t of topics) {
      names.set(t.topic_id, t);
      if (t.status !== 'active') continue;
      const chapter = ch.find((x) => x.chapter_id === t.chapter_id);
      const strand = sts.find((x) => x.strand_id === chapter?.strand_id);
      for (const c of t.classes) out.rows.push({ topic: t, subject, cls: c, role: roleOf(t.class, c), review: reviewOf(reviews, t.topic_id), stats: st.get(`${t.topic_id}|${c}`), chapter, strand });
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
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const subjects = (r.subject === 'all' ? SUBJECTS.map((s) => s.id) : [r.subject]) as Subject[];
  useEffect(() => { setData(null); setError(null); load(subjects).then(setData).catch((e) => setError(e.message)); }, [r.subject]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(() => { if (text !== r.q) location.replace(mapHash({ ...r, q: text })); }, 300); return () => clearTimeout(t); }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (p: Partial<R>) => { location.hash = mapHash({ ...r, ...p }); };

  const q = safeSearch(r.q).toLowerCase();
  const rows = useMemo(() => (data?.rows ?? []).filter((x) =>
    (r.cls === 'all' || x.cls === Number(r.cls))
    && (!r.strand || x.strand?.strand_id === r.strand)
    && showMatches(r.show, x.role)
    && matchesReview(reviewFilter, x.review)
    && (!q || `${x.topic.topic_id} ${x.topic.name} ${x.chapter?.chapter_id ?? ''} ${x.chapter?.name ?? ''} ${x.strand?.name ?? ''}`.toLowerCase().includes(q)))
    .sort((a, b) => a.cls - b.cls || SUBJECTS.findIndex((s) => s.id === a.subject) - SUBJECTS.findIndex((s) => s.id === b.subject)
      || (a.strand?.sort ?? 999) - (b.strand?.sort ?? 999) || (a.chapter?.sort ?? 999) - (b.chapter?.sort ?? 999) || (a.chapter?.chapter_id ?? '').localeCompare(b.chapter?.chapter_id ?? '')
      || (a.topic.topic_kind === 'achievers' ? 1 : 0) - (b.topic.topic_kind === 'achievers' ? 1 : 0) || a.topic.class - b.topic.class
      || (a.topic.seq ?? 999) - (b.topic.seq ?? 999) || a.topic.topic_id.localeCompare(b.topic.topic_id)), [data, r.cls, r.strand, r.show, q, reviewFilter]);
  // Review roll-ups per class · strand and class · chapter, over core topics only (whatever the filters)
  const rolls = useMemo(() => {
    const acc = new Map<string, { status: ReviewStatus; core: boolean; active: boolean; achievers: boolean }[]>();
    const add = (k: string, x: Row) => acc.set(k, [...(acc.get(k) ?? []), { status: x.review, core: x.role === 'core', active: x.topic.status === 'active', achievers: x.topic.topic_kind === 'achievers' }]);
    for (const x of data?.rows ?? []) { add(`${x.cls}|st|${x.strand?.strand_id ?? ''}`, x); add(`${x.cls}|ch|${x.topic.chapter_id}`, x); }
    return new Map([...acc].map(([k, v]) => [k, rollUp(v)]));
  }, [data]);
  const rollOf = (cls: number, kind: 'st' | 'ch', id: string | undefined): RollUp | undefined => rolls.get(`${cls}|${kind}|${id ?? ''}`);
  // R2: Show topic unticked → Strand → Chapter totals; Show chapter unticked too → Strand totals
  const groups = useMemo(() => {
    if (r.topics) return [];
    const m = new Map<string, Group>();
    for (const x of rows) {
      const key = `${x.cls}|${x.subject}|${x.strand?.strand_id ?? ''}${r.chapters ? `|${x.topic.chapter_id}` : ''}`;
      const g = m.get(key) ?? { key, cls: x.cls, subject: x.subject, strand: x.strand, chapter: r.chapters ? x.chapter : undefined, topics: 0, questions: 0, split: { core: 0, lower: 0, higher: 0 }, qsplit: { core: 0, lower: 0, higher: 0 } };
      g.topics++; g.questions += x.stats?.n_questions ?? 0; g.split[x.role]++; g.qsplit[x.role] += x.stats?.n_questions ?? 0;
      m.set(key, g);
    }
    return [...m.values()];
  }, [rows, r.topics, r.chapters]);
  const [form, setForm] = useState<{ kind: Kind; id: string | null } | null>(null);
  const [owner, setOwner] = useState<'workbooks' | 'cms' | null>(null);
  const [strands, setStrands] = useState<[string, string][]>([]);
  const [reload, setReload] = useState(0);
  const [exp, setExp] = useState<{ local: boolean; busy: boolean; out: string | null; err: string | null }>({ local: false, busy: false, out: null, err: null });
  useEffect(() => {
    curriculumOwner().then(setOwner).catch(() => setOwner(null));
    supabase.from('cms_strands').select('strand_id, subject, name').order('subject').order('sort').then(({ data }) => setStrands((data ?? []).map((x) => [x.strand_id, `${x.subject} · ${x.name}`])));
    fetch('/api/local/status').then(async (res) => { const j = res.ok && (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : null; setExp((e) => ({ ...e, local: j?.local === true })); }).catch(() => {});
  }, []);
  useEffect(() => { if (reload) load(subjects).then(setData).catch(() => {}); }, [reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const exportNow = async () => {
    setExp((e) => ({ ...e, busy: true, out: null, err: null }));
    try {
      const res = await fetch('/api/local/export', { method: 'POST' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setExp((e) => ({ ...e, busy: false, out: j.output }));
    } catch (err) { setExp((e) => ({ ...e, busy: false, err: (err as Error).message })); }
  };
  const chapters = (data?.chapters ?? []).filter((c) => r.cls === 'all' || data!.rows.some((x) => x.cls === Number(r.cls) && x.topic.chapter_id === c.chapter_id));
  const strandOptions = (data?.strands ?? []).filter((x) => r.cls === 'all' || data!.rows.some((y) => y.cls === Number(r.cls) && y.strand?.strand_id === x.strand_id));
  const strandLink = (cls: number, subject: Subject, st?: StrandRow) => st ? <><a href={browseHash({ subject, cls: String(cls), strand: st.strand_id })}>{st.name}</a><RollUpIcon r={rollOf(cls, 'st', st.strand_id)} /></> : <span className="muted">—</span>;
  const chapterLink = (cls: number, subject: Subject, c?: ChapterRow) => c ? <><a className="chapter-name" href={browseHash({ subject, cls: String(cls), strand: c.strand_id, ch: c.chapter_id })}>{c.chapter_id} · {c.name}</a><RollUpIcon r={rollOf(cls, 'ch', c.chapter_id)} /></> : <span className="muted">—</span>;
  const reviewedCell = (g: Group) => { const ru = g.chapter ? rollOf(g.cls, 'ch', g.chapter.chapter_id) : rollOf(g.cls, 'st', g.strand?.strand_id);
    return !ru || ru.total === 0 ? <span className="muted">—</span> : <span title={`${ru.inProgress} in progress`}>{ru.done} of {ru.total} reviewed</span>; };
  const part = (n: number, q: number, label: string, cls?: Role) => <span className={cls}>{n} {label} <span className="muted">({q} Q{q === 1 ? '' : 's'})</span></span>;
  const splitEl = (g: Group) => <span className="role-split small">{part(g.split.core, g.qsplit.core, 'core')}
    {g.split.lower ? <> · {part(g.split.lower, g.qsplit.lower, 'from lower', 'lower')}</> : null}{g.split.higher ? <> · {part(g.split.higher, g.qsplit.higher, 'from higher', 'higher')}</> : null}</span>;
  const groupRole = (sp: Record<Role, number>): Role | null => (sp.core === 0 && (sp.lower === 0) !== (sp.higher === 0) ? (sp.lower ? 'lower' : 'higher') : null);

  return (
    <>
      <div className="section-head">
        <h2>Curriculum</h2>
        <div role="tablist" className="tabs inline">
          <button role="tab" aria-selected={r.tab === 'topics'} className={r.tab === 'topics' ? 'on' : ''} onClick={() => go({ tab: 'topics' })}>Map</button>
          <button role="tab" aria-selected={r.tab === 'sources'} className={r.tab === 'sources' ? 'on' : ''} onClick={() => go({ tab: 'sources' })}>Sources</button>
        </div>
        <span className="spacer" />
        <div className="curriculum-actions top">
          <button className="secondary" onClick={() => setForm({ kind: 'chapter', id: null })}>+ Add chapter</button>
          <button className="secondary" onClick={() => setForm({ kind: 'topic', id: null })}>+ Add topic</button>
          {exp.local && <button className="secondary" disabled={exp.busy} onClick={exportNow} title="Writes the three topic workbooks from the CMS on this Mac (read-only exports)">{exp.busy ? 'Exporting…' : 'Export to Excel'}</button>}
        </div>
      </div>
      <div className="muted small owner-line">
        {owner === 'cms' ? 'The CMS owns the curriculum: add and edit chapters and topics here; the workbooks are read-only exports.'
          : owner === 'workbooks' ? <>Chapters and topics still come from the topic workbooks until the one-time cut-over (<span className="mono">docs/curriculum-cutover.md</span>). Topic classes, prerequisites, concepts, question types and patterns can be edited now.</> : null}
      </div>
      {exp.out && <pre className="step-out">{exp.out}</pre>}
      {exp.err && <p className="error small">Export failed: {exp.err}</p>}
      {form && <CurriculumForm key={`${form.kind}-${form.id}`} kind={form.kind} id={form.id}
        fixed={form.kind === 'topic' && !form.id && r.ch ? { chapter_id: r.ch } : form.kind === 'chapter' && !form.id && r.subject !== 'all' ? { subject: r.subject } : {}}
        options={{ strand_id: strands.filter(([id]) => r.subject === 'all' || id.startsWith(`${r.subject}-`)), chapter_id: chapters.map((c) => [c.chapter_id, `${c.chapter_id} · ${c.name}`] as [string, string]) }}
        onDone={(saved) => { setForm(null); if (saved) setReload((x) => x + 1); }} />}
      <div className="filters">
        <select value={r.cls} onChange={(e) => go({ cls: e.target.value, ch: null })} aria-label="Class" className={r.cls !== 'all' ? 'active' : ''}>
          <option value="all">All classes</option>{[1, 2, 3, 4, 5, 6].map((c) => <option key={c} value={c}>Class {c}</option>)}
        </select>
        <select value={r.subject} onChange={(e) => go({ subject: e.target.value, strand: null, ch: null })} aria-label="Subject" className={r.subject !== 'all' ? 'active' : ''}>
          <option value="all">All subjects</option>{SUBJECTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        {r.tab === 'topics' ? <>
          <select value={r.strand ?? ''} onChange={(e) => go({ strand: e.target.value || null })} aria-label="Strand" className={r.strand ? 'active' : ''}>
            <option value="">All strands</option>{strandOptions.map((x) => <option key={x.strand_id} value={x.strand_id}>{r.subject === 'all' ? `${subjectLabel(x.subject)} · ` : ''}{x.name}</option>)}
          </select>
          <select value={r.show} onChange={(e) => go({ show: e.target.value as MapShow })} aria-label="Show" className={r.show !== 'all' ? 'active' : ''}>
            <option value="all">Show: all</option><option value="core">Core only</option><option value="lower">From lower class</option><option value="higher">From higher class</option><option value="extra">All extra</option>
          </select>
          <ReviewFilterSelect value={reviewFilter} onChange={setReviewFilter} />
          <label className="check inline small"><input type="checkbox" checked={r.chapters} onChange={(e) => go({ chapters: e.target.checked })} /> Show chapter</label>
          <label className="check inline small"><input type="checkbox" checked={r.topics} onChange={(e) => go({ topics: e.target.checked })} /> Show topic</label>
        </> : <select value={r.ch ?? ''} onChange={(e) => go({ ch: e.target.value || null })} aria-label="Chapter" className={`chapter-select ${r.ch ? 'active' : ''}`}>
          <option value="">All chapters</option>{chapters.map((c) => <option key={c.chapter_id} value={c.chapter_id}>{c.chapter_id} · {c.name}</option>)}
        </select>}
        <input className="search-in" placeholder="Search topic or chapter" value={text} onChange={(e) => setText(e.target.value)} />
        {data && r.tab === 'topics' && <span className="muted small">{r.topics ? rows.length : groups.length} row{(r.topics ? rows.length : groups.length) === 1 ? '' : 's'}</span>}
      </div>
      {r.tab === 'sources' ? <SourcesOverview subject={r.subject} cls={r.cls} ch={r.ch} q={r.q} /> : <>
      {error && <p className="error">Couldn't load the curriculum: {error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && <div className="map-legend" aria-label="Row colours"><span><span className="sw core" />core (home class)</span><span><span className="sw lower" />from a lower class</span><span><span className="sw higher" />from a higher class</span></div>}
      {data && !r.topics && (
        <table className="list map-table">
          <thead><tr><th>Class</th><th>Subject</th><th>Strand</th>{r.chapters && <th>Chapter</th>}<th>Topics</th><th>Questions</th><th>Reviewed</th><th>Shown here as</th></tr></thead>
          <tbody>
            {groups.map((g) => {
              const role = groupRole(g.split);
              return (
                <tr key={g.key} className={role ? `role-${role}` : ''}>
                  <td>{g.cls}</td>
                  <td>{subjectLabel(g.subject)}</td>
                  <td>{strandLink(g.cls, g.subject, g.strand)}</td>
                  {r.chapters && <td>{chapterLink(g.cls, g.subject, g.chapter)}</td>}
                  <td>{g.topics}</td>
                  <td>{g.questions ? <strong>{g.questions}</strong> : <span className="muted">none</span>}</td>
                  <td className="nowrap">{reviewedCell(g)}</td>
                  <td>{splitEl(g)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {data && r.topics && (
        <table className="list map-table">
          <thead><tr><th>Class</th><th>Subject</th><th>Strand</th>{r.chapters && <th>Chapter</th>}<th>Topic</th><th>Questions</th><th>Shown here as</th><th>Prerequisites</th></tr></thead>
          <tbody>
            {rows.slice(0, 800).map((x) => {
              const s = x.stats; const gap = gapLabel(s);
              const pre = data.prereqs.get(x.topic.topic_id) ?? [];
              return (
                <tr key={`${x.topic.topic_id}-${x.cls}`} className={`${x.topic.topic_kind === 'achievers' ? 'ach' : ''} ${x.role !== 'core' ? `role-${x.role}` : ''}`}>
                  <td>{x.cls}</td>
                  <td>{subjectLabel(x.subject)}</td>
                  <td>{strandLink(x.cls, x.subject, x.strand)}</td>
                  {r.chapters && <td>{chapterLink(x.cls, x.subject, x.chapter)}
                    <button className="link small" title="Edit chapter" onClick={() => setForm({ kind: 'chapter', id: x.topic.chapter_id })}>✎</button></td>}
                  <td><TopicReviewIcon status={x.review} /><a href={browseHash({ subject: x.subject, cls: String(x.cls), strand: x.strand?.strand_id, ch: x.topic.chapter_id, topic: x.topic.topic_id })}>
                    {x.topic.topic_kind === 'achievers' ? x.topic.name : <><span className="mono">{x.topic.topic_id}</span> {x.topic.name}</>}</a>
                    <button className="link small" title="Edit topic" onClick={() => setForm({ kind: 'topic', id: x.topic.topic_id })}>✎</button></td>
                  <td className="nowrap">{!s || s.n_questions === 0 ? <span className="muted">none</span> : <>
                    <strong>{s.n_questions}</strong> <span className="muted small">{mixLabel({ simple: s.n_simple, medium: s.n_medium, complex: s.n_complex })}</span>
                    {gap && <div className="gap small">⚠ {gap}</div>}</>}</td>
                  <td className="nowrap">{x.role === 'core' ? <span className="muted">core</span> : <span className={`role-tag ${x.role}`}>{roleLabel(x.topic.class, x.cls)}</span>}</td>
                  <td className="small">{pre.length === 0 ? <span className="muted">—</span> : pre.map((p, i) => <span key={p.id}>{i > 0 && ', '}
                    <a href={browseHash({ subject: x.subject, cls: String(p.class || x.cls), ch: p.chapter_id, topic: p.id })}>{p.id} {p.name}</a></span>)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {data && r.topics && rows.length > 800 && <p className="muted small">Showing the first 800 of {rows.length}; filter to narrow the list.</p>}
      </>}
    </>
  );
}

// Course builder (Q13, Sambit 16–18 Nov 2026; docs/plan-2026-11-18-q13-course-builder.md).
// 0 Courses list · 1 Details · 2 Display chapters (+ Achievers sections, read-only Book chapters / CMS content panel)
// · 3 Display topics (CMS topic picker) · 4 Review & publish. One working copy of the outline is kept while you move
// between steps; nothing is written until you press Save (one audited transaction). Published / retired = read-only.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Id } from './Id';
import { downloadTemplate } from './CourseTools';
import {
  achId, blocksPublish, chapterNo, countFor, courseChecks, courseTotals, MAX_ACHIEVERS_PER_CHAPTER, MAX_CMS_PER_TOPIC, move, placements, sameOutline, topicNo,
  type CourseCheck, type CourseHead, type Outline,
} from '../../shared/course.ts';
import {
  bookChapters, boards as loadBoards, cmsSide, copyCourse, course as loadCourse, courses as loadCourses, minQuestions, outline as loadOutline, saveBoard, saveCourse, setCourseStatus,
  type Board, type BookChapter, type CmsSide, type CourseRow,
} from './courseApi';

export type CourseStep = 'details' | 'chapters' | 'topics' | 'review';
export const courseHash = (id: string, step: CourseStep = 'chapters', ch?: string | null) => `#/course/${id}/${step}${ch ? `?ch=${encodeURIComponent(ch)}` : ''}`;
const SUBJ: Record<string, string> = { math: 'Math', science: 'Science' };
const STATUS: Record<string, string> = { draft: 'Draft', published: 'Published', retired: 'Retired' };
const statusBadge = (s: string) => <span className={`badge crs-st-${s}`}>{STATUS[s] ?? s}</span>;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ================================================================ 0 · Courses
export function CoursesScreen() {
  const [rows, setRows] = useState<CourseRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [subject, setSubject] = useState('all');
  const [cls, setCls] = useState('all');
  const [status, setStatus] = useState('live');
  const [more, setMore] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => { loadCourses().then(setRows).catch((e) => setErr((e as Error).message)); }, [reload]);
  const shown = (rows ?? []).filter((r) => (subject === 'all' || r.subject === subject) && (cls === 'all' || String(r.class) === cls)
    && (status === 'all' ? true : status === 'live' ? r.status !== 'retired' : r.status === status));
  return (
    <main className="wide crs">
      <div className="section-head">
        <h1>Courses</h1>
        <span className="spacer" />
        <a className="button-link" href="#/courses/new">+ Add a course</a>
        <a className="button-link" href="#/courses/upload">Upload from Excel</a>
        <a className="button-link" href="#/courses/compare">Compare</a>
      </div>
      <p className="muted small">A course arranges CMS topics for one board, class and subject. It shows only questions with Level ≤ the course class. Publishing is a status change only; nothing goes to the app yet.</p>
      <div className="filters">
        <select value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject"><option value="all">All subjects</option><option value="math">Math</option><option value="science">Science</option></select>
        <select value={cls} onChange={(e) => setCls(e.target.value)} aria-label="Class"><option value="all">All classes</option>{[1, 2, 3, 4, 5, 6].map((c) => <option key={c} value={c}>Class {c}</option>)}</select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="live">Draft and published</option><option value="draft">Draft</option><option value="published">Published</option><option value="retired">Retired</option><option value="all">All</option>
        </select>
      </div>
      {err && <p className="error">{err}</p>}
      {!rows ? <p className="muted">Loading…</p> : !shown.length ? <p className="muted">{rows.length ? 'No course matches these filters.' : 'No courses yet. Add the first one.'}</p> : (
        <table className="list">
          <thead><tr><th>Name</th><th>Board</th><th>Class</th><th>Subject</th><th>Chapters · topics</th><th>Status</th></tr></thead>
          <tbody>{shown.map((r) => (
            <tr key={r.course_id} onClick={() => { location.hash = courseHash(r.course_id, 'chapters'); }}>
              <td><a href={courseHash(r.course_id, 'chapters')} onClick={(e) => e.stopPropagation()}>{r.name}</a> <Id>{r.course_id}</Id></td>
              <td>{r.board_label}</td><td>{r.class}</td><td>{SUBJ[r.subject]}</td>
              <td>{r.n_chapters} · {r.n_topics} <span className="muted small">({plural(r.n_cms_topics, 'CMS topic')})</span></td>
              <td>{statusBadge(r.status)}</td>
            </tr>))}
          </tbody>
        </table>)}
      <p><button className="link more" onClick={() => setMore((m) => !m)}>{more ? 'Hide' : 'More'}: board list</button></p>
      {more && <BoardsPanel onChange={() => setReload((x) => x + 1)} />}
    </main>
  );
}

/** The editable, audited board list (Sambit, 18 Nov 2026). */
function BoardsPanel({ onChange }: { onChange: () => void }) {
  const [list, setList] = useState<Board[] | null>(null);
  const [edit, setEdit] = useState<Record<string, { label: string; book: string }>>({});
  const [add, setAdd] = useState({ label: '', book: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => loadBoards().then((b) => { setList(b); setEdit({}); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, []);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); await load(); onChange(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  if (!list) return <p className="muted">Loading…</p>;
  return (
    <div className="crs-panel">
      <h2>Boards</h2>
      <p className="muted small">Used on courses. "Book" picks the Book chapters tab (NCERT, DAV or none). A retired board stays on its courses but can't be picked for a new one. Every change is logged.</p>
      <table className="opts crs-boards">
        <thead><tr><th>Label</th><th>Book</th><th>Status</th><th /></tr></thead>
        <tbody>{list.map((b) => { const e = edit[b.board_id]; return (
          <tr key={b.board_id}>
            <td><input value={e?.label ?? b.label} onChange={(x) => setEdit({ ...edit, [b.board_id]: { label: x.target.value, book: e?.book ?? b.book ?? '' } })} /> <Id>{b.board_id}</Id></td>
            <td><select value={e?.book ?? b.book ?? ''} onChange={(x) => setEdit({ ...edit, [b.board_id]: { label: e?.label ?? b.label, book: x.target.value } })}><option value="">none</option><option>NCERT</option><option>DAV</option></select></td>
            <td>{b.status === 'active' ? 'active' : <span className="muted">retired</span>}</td>
            <td className="nowrap">
              {e && <button disabled={busy} onClick={() => run(() => saveBoard({ action: 'update', id: b.board_id, fields: { label: e.label, book: (e.book || null) as Board['book'] } }))}>Save</button>}
              <button className="link" disabled={busy} onClick={() => run(() => saveBoard({ action: b.status === 'active' ? 'retire' : 'restore', id: b.board_id }))}>{b.status === 'active' ? 'Retire' : 'Restore'}</button>
            </td>
          </tr>); })}
          <tr>
            <td><input placeholder="New board, e.g. CBSE·Oxford" value={add.label} onChange={(x) => setAdd({ ...add, label: x.target.value })} /></td>
            <td><select value={add.book} onChange={(x) => setAdd({ ...add, book: x.target.value })}><option value="">none</option><option>NCERT</option><option>DAV</option></select></td>
            <td /><td><button disabled={busy || !add.label.trim()} onClick={() => run(async () => { await saveBoard({ action: 'create', fields: { label: add.label.trim(), book: (add.book || null) as Board['book'] } }); setAdd({ label: '', book: '' }); })}>Add board</button></td>
          </tr>
        </tbody>
      </table>
      {err && <p className="error small">{err}</p>}
    </div>
  );
}

// ================================================================ the editor (steps 1–4)
interface Loaded { row: CourseRow | null; boards: Board[]; side: CmsSide | null; saved: Outline; minQ: number; all?: CourseRow[] }

export function CourseEditor({ id, step, ch }: { id: string | null; step: CourseStep; ch: string | null }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [head, setHead] = useState<CourseHead | null>(null);
  const [work, setWork] = useState<Outline>({ chapters: [] });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [from, setFrom] = useState('');

  useEffect(() => {
    let live = true;
    setErr(null);
    (async () => {
      const [bs, minQ] = await Promise.all([loadBoards(), minQuestions()]);
      if (!id) {
        const allCourses = await loadCourses();
        if (!live) return;
        setData({ row: null, boards: bs, side: null, saved: { chapters: [] }, minQ, all: allCourses });
        setHead((h) => h ?? { name: '', board_id: bs.find((b) => b.status === 'active')?.board_id ?? '', class: 5, subject: 'math', status: 'draft' });
        return;
      }
      const row = await loadCourse(id);
      if (!row) throw new Error(`Course ${id} doesn't exist.`);
      const [side, saved] = await Promise.all([cmsSide(row.subject), loadOutline(id)]);
      if (!live) return;
      setData({ row, boards: bs, side, saved, minQ });
      setHead({ course_id: row.course_id, name: row.name, board_id: row.board_id, class: row.class, subject: row.subject, status: row.status, rev: row.rev });
      setWork(saved);
    })().catch((e) => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [id, reload]);

  const row = data?.row ?? null;
  const headDirty = !!row && !!head && (head.name !== row.name || head.board_id !== row.board_id || head.class !== row.class);
  const outlineDirty = !!data && !sameOutline(work, data.saved);
  const dirty = headDirty || outlineDirty;
  const readOnly = !!row && row.status !== 'draft';

  // warn about unsaved changes when leaving the course (steps of the same course keep the working copy)
  const dirtyRef = useRef(false); dirtyRef.current = dirty;
  const idRef = useRef(id); idRef.current = id;
  useEffect(() => {
    let reverting = false;
    const onHash = (e: HashChangeEvent) => {
      if (reverting) { reverting = false; return; }
      const stays = idRef.current && new RegExp(`^#/course/${idRef.current}/(details|chapters|topics|review)(\\?|$)`).test(new URL(e.newURL).hash);
      if (dirtyRef.current && !stays && !confirm('You have unsaved course changes. Leave without saving?')) { reverting = true; history.replaceState(null, '', e.oldURL); window.dispatchEvent(new HashChangeEvent('hashchange')); }
    };
    const onUnload = (e: BeforeUnloadEvent) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('hashchange', onHash); window.addEventListener('beforeunload', onUnload);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('beforeunload', onUnload); };
  }, []);

  const save = async () => {
    if (!head) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      if (!row) {
        const r = from
          ? await copyCourse({ from_course: from, course: { name: head.name.trim(), board_id: head.board_id, class: head.class } })
          : await saveCourse({ course: { name: head.name.trim(), board_id: head.board_id, class: head.class, subject: head.subject } });
        dirtyRef.current = false;
        location.hash = courseHash(r.course_id, 'chapters');
        return;
      }
      const r = await saveCourse({ course_id: row.course_id, rev: row.rev, course: headDirty ? { name: head.name.trim(), board_id: head.board_id, class: head.class } : undefined, outline: outlineDirty ? work : undefined });
      setMsg(`Saved: ${[r.chapters.new && plural(r.chapters.new, 'chapter') + ' added', r.chapters.retired && plural(r.chapters.retired, 'chapter') + ' retired',
        r.topics.new && plural(r.topics.new, 'display topic') + ' added', r.topics.retired && plural(r.topics.retired, 'display topic') + ' retired',
        r.topic_links_changed && plural(r.topic_links_changed, 'display topic') + ' with changed CMS topics', r.achievers_changed && plural(r.achievers_changed, 'Achievers section') + ' changed']
        .filter(Boolean).join(' · ') || 'details and order'}.`);
      setReload((x) => x + 1);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const discard = () => { if (!data || !row) return; if (!confirm('Discard all unsaved changes?')) return; setWork(data.saved); setHead({ ...head!, name: row.name, board_id: row.board_id, class: row.class }); };
  const status = async (to: 'draft' | 'published' | 'retired', label: string) => {
    if (!row) return;
    if (to !== 'draft' && !confirm(`${label} "${row.name}"?`)) return;
    setBusy(true); setErr(null); setMsg(null);
    try { await setCourseStatus({ course_id: row.course_id, rev: row.rev, status: to }); setMsg(`${label}: done.`); setReload((x) => x + 1); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (err && !data) return <main className="wide"><p className="error">{err}</p><p><a href="#/courses">All courses</a></p></main>;
  if (!data || !head) return <main className="wide"><p className="muted">Loading…</p></main>;
  const cls = head.class;
  const ctx = data.side ? { cls, subject: head.subject, topics: data.side.topics, minQuestions: data.minQ } : null;
  const checks = ctx ? courseChecks(work, ctx) : [];
  const steps: [CourseStep, string][] = [['details', '1 Details'], ['chapters', '2 Chapters'], ['topics', '3 Topics'], ['review', '4 Review & publish']];
  const board = data.boards.find((b) => b.board_id === head.board_id);

  return (
    <main className="wide crs">
      <p className="small"><a href="#/courses">← All courses</a></p>
      <div className="section-head">
        <h1>{row ? row.name : 'New course'}</h1>
        {row && <><Id>{row.course_id}</Id> {statusBadge(row.status)}<span className="muted small">{board?.label} · Class {row.class} · {SUBJ[row.subject]}</span></>}
      </div>
      {row && <nav className="crs-steps" aria-label="Steps">{steps.map(([s, label]) => <a key={s} className={s === step ? 'on' : ''} href={courseHash(row.course_id, s, ch)}>{label}</a>)}</nav>}
      {readOnly && <p className="notice small">This course is {row!.status}, so it is read-only. {row!.status === 'published' ? <>Use <strong>Back to draft</strong> (Review step) to change it.</> : <>Restore it (Review step) to change it.</>}</p>}
      {(dirty || msg || err) && (
        <div className={`crs-savebar ${dirty ? 'dirty' : ''}`}>
          {dirty ? <span>Unsaved changes{headDirty ? ' · details' : ''}{outlineDirty ? ' · chapters and topics' : ''}</span> : <span className="ok">{msg}</span>}
          <span className="spacer" />
          {err && <span className="error small">{err}</span>}
          {dirty && row && <button className="secondary" disabled={busy} onClick={discard}>Discard</button>}
          {dirty && row && <button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>}
        </div>)}
      {!row || step === 'details' ? <DetailsStep head={head} setHead={setHead} boards={data.boards} isNew={!row} readOnly={readOnly} busy={busy} onCreate={save} courses={data.all ?? []} from={from} setFrom={setFrom} />
        : step === 'chapters' ? <ChaptersStep head={head} board={board} work={work} setWork={setWork} side={data.side!} readOnly={readOnly} />
        : step === 'topics' ? <TopicsStep head={head} work={work} setWork={setWork} side={data.side!} readOnly={readOnly} ch={ch} />
        : <ReviewStep head={head} row={row} work={work} side={data.side!} checks={checks} ctx={ctx!} dirty={dirty} busy={busy} onSave={save} onStatus={status} />}
    </main>
  );
}

// ================================================================ 1 · Details
function DetailsStep({ head, setHead, boards, isNew, readOnly, busy, onCreate, courses, from, setFrom }: {
  head: CourseHead; setHead: (h: CourseHead) => void; boards: Board[]; isNew: boolean; readOnly: boolean; busy: boolean; onCreate: () => void;
  courses: CourseRow[]; from: string; setFrom: (s: string) => void;
}) {
  const src = courses.find((c) => c.course_id === from);
  const choosable = boards.filter((b) => b.status === 'active' || b.board_id === head.board_id);
  return (
    <div className="crs-panel crs-details">
      <label>Name<input value={head.name} disabled={readOnly} maxLength={120} onChange={(e) => setHead({ ...head, name: e.target.value })} placeholder="e.g. CBSE NCERT Class 5 Math" autoFocus={isNew} /></label>
      <label>Board / book series
        <select value={head.board_id} disabled={readOnly} onChange={(e) => setHead({ ...head, board_id: e.target.value })}>
          {choosable.map((b) => <option key={b.board_id} value={b.board_id}>{b.label}{b.status === 'retired' ? ' (retired)' : ''}</option>)}
        </select>
      </label>
      <label>Class
        <select value={head.class} disabled={readOnly} onChange={(e) => setHead({ ...head, class: Number(e.target.value) })}>{[1, 2, 3, 4, 5, 6].map((c) => <option key={c} value={c}>Class {c}</option>)}</select>
        {!isNew && <span className="muted small">Changing the class changes which questions count (Level ≤ class) and which Achievers topics are used.</span>}
      </label>
      <label>Subject
        <select value={head.subject} disabled={!isNew || !!src} onChange={(e) => setHead({ ...head, subject: e.target.value as CourseHead['subject'] })}><option value="math">Math</option><option value="science">Science</option></select>
        {!isNew && <span className="muted small">The subject can't change once the course is saved.</span>}
      </label>
      {isNew && <>
        <label>Start from (optional)
          <select value={from} onChange={(e) => { setFrom(e.target.value); const c = courses.find((x) => x.course_id === e.target.value); if (c) setHead({ ...head, subject: c.subject }); }}>
            <option value="">Nothing: an empty course</option>
            {courses.filter((c) => c.status !== 'retired').map((c) => <option key={c.course_id} value={c.course_id}>{c.name} ({c.course_id} · {c.board_label} · C{c.class} · {SUBJ[c.subject]} · {plural(c.n_chapters, 'chapter')})</option>)}
          </select>
          <span className="muted small">{src ? `Copies all ${plural(src.n_chapters, 'display chapter')}, ${plural(src.n_topics, 'display topic')}, ${plural(src.n_cms_topics, 'CMS topic link')} and its Achievers sections into the new draft. ${src.course_id} is not changed.${src.class !== head.class ? ` Counts will use Class ${head.class}.` : ''}` : 'Copy all display chapters, display topics, CMS topic links and Achievers sections of another course.'}</span>
        </label>
        <div><button disabled={busy || !head.name.trim() || !head.board_id} onClick={onCreate}>{busy ? 'Saving…' : 'Save and continue'}</button></div>
      </>}
    </div>
  );
}

// ================================================================ 2 · Display chapters
function ChaptersStep({ head, board, work, setWork, side, readOnly }: {
  head: CourseHead; board?: Board; work: Outline; setWork: (o: Outline) => void; side: CmsSide; readOnly: boolean;
}) {
  const cls = head.class;
  const [newName, setNewName] = useState('');
  const drag = useRef<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const pl = useMemo(() => placements(work), [work]);
  const chapters = work.chapters;
  const set = (i: number, patch: Partial<Outline['chapters'][number]>) => setWork({ chapters: chapters.map((c, k) => (k === i ? { ...c, ...patch } : c)) });
  const reorder = (from: number, to: number) => setWork({ chapters: move(chapters, from, to) });
  const remove = (i: number) => {
    const c = chapters[i]!;
    if (c.topics.length && !confirm(`Retire chapter "${c.name}" and its ${plural(c.topics.length, 'display topic')}? Their CMS topics become free to place again. (Kept in the history; applied when you Save.)`)) return;
    setWork({ chapters: chapters.filter((_, k) => k !== i) });
  };
  const qOf = (c: Outline['chapters'][number]) => c.topics.reduce((s, t) => s + t.cms.reduce((x, id) => x + countFor(side.topics.get(id)?.counts, cls).n, 0), 0);
  return (
    <div className="crs-cols">
      <div className="crs-main">
        <h2>Display chapters</h2>
        <p className="muted small">The names children see, in order. Drag or use ↑ / ↓. Questions = Level ≤ {cls}. {head.subject === 'math' ? 'Each chapter can have an Achievers section (1–4 CMS chapters).' : 'Science has no Achievers topics yet.'}</p>
        {!chapters.length && <p className="muted">No chapters yet.</p>}
        <ol className="crs-list">
          {chapters.map((c, i) => (
            <li key={c.id ?? `new-${i}`} className={`crs-ch ${dragging === i ? 'dragging' : ''}`}
              draggable={!readOnly}
              onDragStart={(e) => { drag.current = i; setDragging(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); }}
              onDragEnd={() => { drag.current = null; setDragging(null); }}
              onDragOver={(e) => { const d = drag.current; if (d === null) return; e.preventDefault(); if (d !== i) { reorder(d, i); drag.current = i; setDragging(i); } }}
              onDrop={(e) => e.preventDefault()}>
              <div className="crs-ch-row">
                {!readOnly && <span className="ro-handle" aria-hidden>⠿</span>}
                <span className="crs-no">{chapterNo(i)}</span>
                <input className="crs-name" value={c.name} disabled={readOnly} maxLength={120} aria-label={`Chapter ${i + 1} name`} onChange={(e) => set(i, { name: e.target.value })} />
                <span className="muted small nowrap">{plural(c.topics.length, 'topic')} · {qOf(c)} q</span>
                <a className="small" href={courseHash(head.course_id!, 'topics', c.id ?? null)} onClick={(e) => { if (!c.id) { e.preventDefault(); alert('Save first, then open its topics.'); } }}>Topics →</a>
                {c.id && <Id>{c.id}</Id>}
                {!readOnly && <span className="ro-btns">
                  <button className="link" aria-label={`Move ${c.name} up`} disabled={i === 0} onClick={() => reorder(i, i - 1)}>↑</button>
                  <button className="link" aria-label={`Move ${c.name} down`} disabled={i === chapters.length - 1} onClick={() => reorder(i, i + 1)}>↓</button>
                  <button className="link" onClick={() => remove(i)}>Retire</button>
                </span>}
              </div>
              {head.subject === 'math' && <AchieversRow head={head} chapterIndex={i} achievers={c.achievers} side={side} used={pl.achievers} readOnly={readOnly} onChange={(a) => set(i, { achievers: a })} />}
            </li>))}
        </ol>
        {!readOnly && (
          <form className="crs-add" onSubmit={(e) => { e.preventDefault(); if (!newName.trim()) return; setWork({ chapters: [...chapters, { name: newName.trim(), achievers: [], topics: [] }] }); setNewName(''); }}>
            <input value={newName} maxLength={120} placeholder="New display chapter name" onChange={(e) => setNewName(e.target.value)} />
            <button type="submit" disabled={!newName.trim()}>+ Add chapter</button>
            <a className="small" href={`#/course/${head.course_id}/clone`}>Clone a chapter</a>
            <a className="small" href={`#/courses/compare?a=${chapters.find((c) => c.id)?.id ?? ''}`}>Compare</a>
          </form>)}
      </div>
      <aside className="crs-side"><ReferencePanel head={head} board={board} side={side} work={work} /></aside>
    </div>
  );
}

function AchieversRow({ head, chapterIndex, achievers, side, used, readOnly, onChange }: {
  head: CourseHead; chapterIndex: number; achievers: string[]; side: CmsSide; used: Map<string, { ci: number; label: string }>; readOnly: boolean; onChange: (a: string[]) => void;
}) {
  const cls = head.class;
  return (
    <div className="crs-ach">
      <span className="crs-ach-label">Achievers</span>
      {!achievers.length && <span className="muted small">none</span>}
      {achievers.map((chId, k) => {
        const ch = side.chapters.find((x) => x.chapter_id === chId);
        const a = side.topics.get(achId(chId, cls));
        const n = countFor(a?.counts, cls).n;
        const ok = !!a && a.status === 'active';
        return (
          <span key={chId} className={`crs-ach-chip ${ok ? '' : 'bad'}`} title={ok ? `${a!.name}` : `${achId(chId, cls)} doesn't exist`}>
            {ch?.name ?? chId} <Id>{chId}</Id> → {ok ? <><Id>{a!.topic_id}</Id> {n} q</> : <span className="error">✗ no Achievers topic for Class {cls}</span>}
            {!readOnly && <>
              {k > 0 && <button className="link" aria-label="Move left" onClick={() => onChange(move(achievers, k, k - 1))}>←</button>}
              <button className="link" aria-label={`Remove ${chId}`} onClick={() => onChange(achievers.filter((x) => x !== chId))}>✕</button>
            </>}
          </span>);
      })}
      {!readOnly && achievers.length < MAX_ACHIEVERS_PER_CHAPTER && (
        <select className="small-select" value="" aria-label="Add an Achievers chapter" onChange={(e) => e.target.value && onChange([...achievers, e.target.value])}>
          <option value="">+ CMS chapter…</option>
          {side.chapters.filter((c) => c.status === 'active').map((c) => {
            const u = used.get(c.chapter_id);
            const has = side.topics.get(achId(c.chapter_id, cls));
            return <option key={c.chapter_id} value={c.chapter_id} disabled={!!u}>{c.name} ({c.chapter_id}){u ? ` · in ${u.ci === chapterIndex ? 'this chapter' : u.label}` : has ? ` · ${countFor(has.counts, cls).n} q` : ' · no Achievers topic for this class'}</option>;
          })}
        </select>)}
    </div>
  );
}

/** Right panel of screen 2, read-only: the board's book chapters, and the CMS content tree. */
function ReferencePanel({ head, board, side, work }: { head: CourseHead; board?: Board; side: CmsSide; work: Outline }) {
  const [tab, setTab] = useState<'book' | 'cms'>('book');
  const [book, setBook] = useState<'NCERT' | 'DAV'>(board?.book ?? 'NCERT');
  const [rows, setRows] = useState<BookChapter[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { setBook(board?.book ?? 'NCERT'); }, [board?.book]);
  useEffect(() => { bookChapters(head.class, head.subject).then(setRows).catch(() => setRows([])); }, [head.class, head.subject]);
  const pl = useMemo(() => placements(work), [work]);
  const cls = head.class;
  const list = (rows ?? []).filter((r) => r.book === book);
  return (
    <div className="crs-panel">
      <div className="tabs"><button className={tab === 'book' ? 'on' : ''} onClick={() => setTab('book')}>Book chapters</button><button className={tab === 'cms' ? 'on' : ''} onClick={() => setTab('cms')}>CMS content</button></div>
      {tab === 'book' ? <>
        <div className="crs-switch">{(['NCERT', 'DAV'] as const).map((b) => <button key={b} className={`pill ${book === b ? 'on' : ''}`} onClick={() => setBook(b)}>{b}</button>)}</div>
        <p className="muted small">Class {cls} · {SUBJ[head.subject]}{list[0] ? ` · ${list[0].book_title}` : ''}. Reference only (chapter numbers and titles).</p>
        {!rows ? <p className="muted">Loading…</p> : !list.length ? <p className="muted small">No {book} book for this class and subject.</p> : (
          <ol className="crs-book">{list.map((r) => <li key={r.ch_no}><span className="crs-no">{r.ch_no}</span> {r.ch_name}</li>)}</ol>)}
      </> : <>
        <p className="muted small">Strand › CMS chapter. Click a chapter for its topics (home class, questions at Level ≤ {cls}, where placed).</p>
        {side.strands.map((s) => {
          const chs = side.chapters.filter((c) => c.strand_id === s.strand_id && c.status === 'active');
          if (!chs.length) return null;
          return (
            <div key={s.strand_id} className="crs-tree">
              <div className="crs-strand">{s.name}</div>
              {chs.map((c) => {
                const ts = [...side.topics.values()].filter((t) => t.chapter_id === c.chapter_id && t.kind === 'normal' && t.status === 'active');
                const inCls = ts.filter((t) => t.classes.includes(cls)).length;
                return (
                  <div key={c.chapter_id}>
                    <button className="link crs-tree-ch" onClick={() => setOpen(open === c.chapter_id ? null : c.chapter_id)}>{open === c.chapter_id ? '▾' : '▸'} {c.name} <Id>{c.chapter_id}</Id> <span className="muted small">{inCls}/{ts.length} in Class {cls}</span></button>
                    {open === c.chapter_id && <ul className="crs-tree-topics">{ts.sort((a, b) => a.home_class - b.home_class || a.topic_id.localeCompare(b.topic_id)).map((t) => {
                      const p = pl.topics.get(t.topic_id);
                      return <li key={t.topic_id} className={t.classes.includes(cls) ? '' : 'muted'}>{t.name} <Id>{t.topic_id}</Id> <ClassTag t={t.home_class} cls={cls} /> <span className="small">{countFor(t.counts, cls).n} q</span> {p ? <span className="small crs-used">in {p.label}</span> : null}</li>;
                    })}</ul>}
                  </div>);
              })}
            </div>);
        })}
      </>}
    </div>
  );
}

export function ClassTag({ t, cls }: { t: number; cls: number }) {
  return <span className={`crs-cls ${t === cls ? 'core' : t < cls ? 'lower' : 'higher'}`} title={t === cls ? 'home class = course class' : t < cls ? 'from a lower class' : 'from a higher class'}>C{t}</span>;
}

// ================================================================ 3 · Display topics
function TopicsStep({ head, work, setWork, side, readOnly, ch }: {
  head: CourseHead; work: Outline; setWork: (o: Outline) => void; side: CmsSide; readOnly: boolean; ch: string | null;
}) {
  const cls = head.class;
  const [sel, setSel] = useState(() => Math.max(0, work.chapters.findIndex((c) => c.id === ch)));
  const [target, setTarget] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [q, setQ] = useState('');
  const [strand, setStrand] = useState('');
  const [fCls, setFCls] = useState<string>(String(cls));
  const [fCh, setFCh] = useState('');
  const [hideUsed, setHideUsed] = useState(true);
  const drag = useRef<{ kind: 'topic'; ti: number } | { kind: 'cms'; ti: number; id: string } | null>(null);
  useEffect(() => { const i = work.chapters.findIndex((c) => c.id === ch); if (i >= 0) setSel(i); }, [ch]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setTarget(null); }, [sel]);
  const pl = useMemo(() => placements(work), [work]);
  const chapter = work.chapters[sel];
  const setTopics = (topics: Outline['chapters'][number]['topics']) => setWork({ chapters: work.chapters.map((c, k) => (k === sel ? { ...c, topics } : c)) });
  const topics = chapter?.topics ?? [];
  const setTopic = (ti: number, patch: Partial<(typeof topics)[number]>) => setTopics(topics.map((t, k) => (k === ti ? { ...t, ...patch } : t)));
  const addCms = (ti: number, id: string) => { const t = topics[ti]!; if (t.cms.length >= MAX_CMS_PER_TOPIC || pl.topics.has(id)) return; setTopic(ti, { cms: [...t.cms, id] }); };
  const moveCms = (from: number, id: string, to: number) => {
    if (from === to || topics[to]!.cms.length >= MAX_CMS_PER_TOPIC) return;
    setTopics(topics.map((t, k) => (k === from ? { ...t, cms: t.cms.filter((x) => x !== id) } : k === to ? { ...t, cms: [...t.cms, id] } : t)));
  };
  const retireTopic = (ti: number) => {
    const t = topics[ti]!;
    if (t.cms.length && !confirm(`Retire display topic "${t.name}"? Its ${plural(t.cms.length, 'CMS topic')} become free to place again. (Applied when you Save.)`)) return;
    setTopics(topics.filter((_, k) => k !== ti)); setTarget(null);
  };

  const picks = useMemo(() => {
    const words = q.trim().toLowerCase();
    return [...side.topics.values()].filter((t) => t.kind === 'normal' && t.status === 'active'
      && (!words || t.name.toLowerCase().includes(words) || t.topic_id.toLowerCase().includes(words))
      && (!strand || side.chapters.find((c) => c.chapter_id === t.chapter_id)?.strand_id === strand)
      && (fCls === 'any' || t.classes.includes(Number(fCls)))
      && (!fCh || t.chapter_id === fCh)
      && (!hideUsed || !pl.topics.has(t.topic_id)))
      .sort((a, b) => a.chapter_id.localeCompare(b.chapter_id) || a.home_class - b.home_class || a.topic_id.localeCompare(b.topic_id));
  }, [side, q, strand, fCls, fCh, hideUsed, pl]);

  if (!work.chapters.length) return <p className="muted">Add display chapters first (step 2).</p>;
  const chName = (id: string) => side.chapters.find((c) => c.chapter_id === id)?.name ?? id;
  return (
    <div className="crs-cols3">
      <aside className="crs-left">
        <div className="crs-strand">Display chapters</div>
        <ol className="crs-chlist">{work.chapters.map((c, i) => (
          <li key={c.id ?? `new-${i}`}><button className={`link ${i === sel ? 'on' : ''}`} onClick={() => setSel(i)}>{chapterNo(i)} {c.name}</button> <span className="muted small">{c.topics.length}</span></li>))}
        </ol>
      </aside>
      <div className="crs-main">
        <h2>{chapterNo(sel)} {chapter!.name}</h2>
        <p className="muted small">{readOnly ? 'Read-only.' : 'Click a display topic to make it the target, then + topics from the picker. Drag CMS topics between display topics, or use ↑ / ↓.'} Each display topic holds 1–{MAX_CMS_PER_TOPIC} CMS topics. Questions = Level ≤ {cls}.</p>
        {!topics.length && <p className="muted">No display topics in this chapter yet.</p>}
        {topics.map((t, ti) => {
          const n = t.cms.reduce((s, id) => s + countFor(side.topics.get(id)?.counts, cls).n, 0);
          return (
            <div key={t.id ?? `new-${ti}`} className={`crs-topic ${target === ti ? 'target' : ''}`} onClick={() => !readOnly && setTarget(ti)}
              draggable={!readOnly}
              onDragStart={(e) => { if (drag.current?.kind === 'cms') return; drag.current = { kind: 'topic', ti }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', `t${ti}`); }}
              onDragEnd={() => { drag.current = null; }}
              onDragOver={(e) => { const d = drag.current; if (!d) return; e.preventDefault(); if (d.kind === 'topic' && d.ti !== ti) { setTopics(move(topics, d.ti, ti)); drag.current = { kind: 'topic', ti }; } }}
              onDrop={(e) => { e.preventDefault(); const d = drag.current; if (d?.kind === 'cms') moveCms(d.ti, d.id, ti); drag.current = null; }}>
              <div className="crs-topic-head">
                {!readOnly && <span className="ro-handle" aria-hidden>⠿</span>}
                <span className="crs-no">{topicNo(sel, ti)}</span>
                <input className="crs-name" value={t.name} disabled={readOnly} maxLength={120} aria-label={`Display topic ${topicNo(sel, ti)} name`} onChange={(e) => setTopic(ti, { name: e.target.value })} onClick={(e) => e.stopPropagation()} />
                <span className={`small nowrap ${t.cms.length >= MAX_CMS_PER_TOPIC ? 'warn-text' : 'muted'}`}>{t.cms.length} of max {MAX_CMS_PER_TOPIC}</span>
                <span className="small nowrap">{n} q</span>
                {t.id && <Id>{t.id}</Id>}
                {!readOnly && <span className="ro-btns">
                  <button className="link" aria-label="Move up" disabled={ti === 0} onClick={(e) => { e.stopPropagation(); setTopics(move(topics, ti, ti - 1)); }}>↑</button>
                  <button className="link" aria-label="Move down" disabled={ti === topics.length - 1} onClick={(e) => { e.stopPropagation(); setTopics(move(topics, ti, ti + 1)); }}>↓</button>
                  <button className="link" onClick={(e) => { e.stopPropagation(); retireTopic(ti); }}>Retire</button>
                </span>}
              </div>
              {!t.cms.length ? <p className="muted small crs-empty">No CMS topics yet{target === ti ? ': pick from the right →' : ''}.</p> : (
                <ul className="crs-cms">{t.cms.map((id, k) => {
                  const info = side.topics.get(id);
                  const c = countFor(info?.counts, cls);
                  return (
                    <li key={id} draggable={!readOnly} onDragStart={(e) => { e.stopPropagation(); drag.current = { kind: 'cms', ti, id }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); }}
                      onDragEnd={() => { drag.current = null; }} className={info?.status === 'active' ? '' : 'bad'}>
                      <span className="crs-cms-name">{info?.name ?? id} <Id>{id}</Id></span> {info && <ClassTag t={info.home_class} cls={cls} />}
                      <span className="small nowrap">{c.n} q{c.approved ? ` (${c.approved} approved)` : ''}</span>
                      {info && info.status !== 'active' && <span className="error small">retired</span>}
                      {!readOnly && <span className="ro-btns">
                        <button className="link" aria-label="Up" disabled={k === 0} onClick={(e) => { e.stopPropagation(); setTopic(ti, { cms: move(t.cms, k, k - 1) }); }}>↑</button>
                        <button className="link" aria-label="Down" disabled={k === t.cms.length - 1} onClick={(e) => { e.stopPropagation(); setTopic(ti, { cms: move(t.cms, k, k + 1) }); }}>↓</button>
                        <button className="link" aria-label={`Remove ${id}`} onClick={(e) => { e.stopPropagation(); setTopic(ti, { cms: t.cms.filter((x) => x !== id) }); }}>✕</button>
                      </span>}
                    </li>);
                })}</ul>)}
            </div>);
        })}
        {!readOnly && (
          <form className="crs-add" onSubmit={(e) => { e.preventDefault(); if (!newName.trim()) return; setTopics([...topics, { name: newName.trim(), cms: [] }]); setTarget(topics.length); setNewName(''); }}>
            <input value={newName} maxLength={120} placeholder="New display topic name" onChange={(e) => setNewName(e.target.value)} />
            <button type="submit" disabled={!newName.trim()}>+ Add display topic</button>
          </form>)}
      </div>
      <aside className="crs-side">
        <div className="crs-panel">
          <h2>CMS topics</h2>
          <p className="muted small">{readOnly ? 'Read-only.' : target === null ? 'Choose a display topic in the middle first.' : `Adding to ${topicNo(sel, target)} ${topics[target]?.name ?? ''}.`}</p>
          <input placeholder="Search name or ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search CMS topics" />
          <div className="filters crs-pick-filters">
            <select value={strand} onChange={(e) => { setStrand(e.target.value); setFCh(''); }} aria-label="Strand"><option value="">All strands</option>{side.strands.map((s) => <option key={s.strand_id} value={s.strand_id}>{s.name}</option>)}</select>
            <select value={fCls} onChange={(e) => setFCls(e.target.value)} aria-label="Class"><option value="any">Any class</option>{[1, 2, 3, 4, 5, 6].map((c) => <option key={c} value={c}>Linked to Class {c}</option>)}</select>
            <select value={fCh} onChange={(e) => setFCh(e.target.value)} aria-label="CMS chapter"><option value="">All CMS chapters</option>{side.chapters.filter((c) => !strand || c.strand_id === strand).map((c) => <option key={c.chapter_id} value={c.chapter_id}>{c.name}</option>)}</select>
            <label className="check small"><input type="checkbox" checked={hideUsed} onChange={(e) => setHideUsed(e.target.checked)} /> Hide already used</label>
          </div>
          <p className="muted small">{plural(picks.length, 'topic')}</p>
          <ul className="crs-picks">{picks.slice(0, 300).map((t) => {
            const p = pl.topics.get(t.topic_id);
            const full = target !== null && (topics[target]?.cms.length ?? 0) >= MAX_CMS_PER_TOPIC;
            return (
              <li key={t.topic_id} className={p ? 'used' : ''}>
                {!readOnly && <button className="crs-plus" disabled={!!p || target === null || full} title={p ? `in ${p.label}` : target === null ? 'Choose a display topic first' : full ? `${MAX_CMS_PER_TOPIC} already` : 'Add'} onClick={() => target !== null && addCms(target, t.topic_id)}>+</button>}
                <span className="crs-pick-name">{t.name} <Id>{t.topic_id}</Id></span> <ClassTag t={t.home_class} cls={cls} />
                <span className="small nowrap">{countFor(t.counts, cls).n} q</span>
                <span className="muted small crs-pick-sub">{chName(t.chapter_id)}{p && <span className="crs-used"> · in {p.label}</span>}</span>
              </li>);
          })}</ul>
          {picks.length > 300 && <p className="muted small">Showing 300 of {picks.length}; narrow the filters.</p>}
        </div>
      </aside>
    </div>
  );
}

// ================================================================ 4 · Review & publish
function ReviewStep({ head, row, work, side, checks, ctx, dirty, busy, onSave, onStatus }: {
  head: CourseHead; row: CourseRow; work: Outline; side: CmsSide; checks: CourseCheck[]; ctx: Parameters<typeof courseTotals>[1]; dirty: boolean; busy: boolean;
  onSave: () => void; onStatus: (to: 'draft' | 'published' | 'retired', label: string) => void;
}) {
  const [more, setMore] = useState(false);
  const cls = head.class;
  const tot = courseTotals(work, ctx);
  const errors = checks.filter((c) => c.level === 'error'), warns = checks.filter((c) => c.level === 'warn'), infos = checks.filter((c) => c.level === 'info');
  const fix = (c: CourseCheck) => {
    const chId = c.ci !== undefined ? work.chapters[c.ci]?.id ?? null : null;
    return c.ci === undefined ? null : <a className="small" href={courseHash(row.course_id, c.ti !== undefined ? 'topics' : 'chapters', chId)}>Fix →</a>;
  };
  const list = (title: string, cs: CourseCheck[], icon: ReactNode, cls2: string) => cs.length ? (
    <div className={`crs-checks ${cls2}`}><strong>{icon} {title} ({cs.length})</strong>
      <ul>{cs.map((c, k) => <li key={k}>{c.message} {fix(c)}{c.ids && (c.kind === 'core_unplaced' || c.kind === 'extra_unplaced') && <TopicIds ids={c.ids} side={side} cls={cls} />}</li>)}</ul></div>) : null;
  const canPublish = row.status === 'draft' && !blocksPublish(checks) && !dirty;
  return (
    <div className="crs-review">
      <div className="crs-totals">
        <span><strong>{tot.chapters}</strong> chapters</span><span><strong>{tot.topics}</strong> display topics</span><span><strong>{tot.cms}</strong> CMS topics</span>
        <span><strong>{tot.questions}</strong> questions at Level ≤ {cls} <span className="muted small">({tot.approved} approved)</span></span>
        {head.subject === 'math' && <span><strong>{tot.achievers}</strong> Achievers questions</span>}
      </div>
      {!errors.length && !warns.length && <p className="ok">✓ No problems found.</p>}
      {list('Must fix before Publish', errors, '✗', 'err')}
      {list('Warnings (do not block)', warns, '!', 'warn')}
      {infos.length > 0 && <p><button className="link more" onClick={() => setMore((m) => !m)}>{more ? 'Hide' : 'More'}: {plural(infos.length, 'note')}</button></p>}
      {more && list('Notes', infos, 'i', 'info')}
      <div className="crs-actions">
        {row.status === 'draft' && <>
          <button className="secondary" disabled={busy || !dirty} onClick={onSave}>{dirty ? 'Save as draft' : 'Saved as draft'}</button>
          <button className="approve" disabled={busy || !canPublish} title={dirty ? 'Save first' : blocksPublish(checks) ? 'Fix the ✗ checks first' : ''} onClick={() => onStatus('published', 'Publish')}>Publish</button>
          <span className="muted small">Publish only marks the course as published; nothing goes to the app yet.</span>
        </>}
        {row.status === 'published' && <button className="secondary" disabled={busy} onClick={() => onStatus('draft', 'Back to draft')}>Back to draft</button>}
        <button className="link" disabled={busy || dirty} title={dirty ? 'Save first' : ''} onClick={() => void downloadTemplate({ course: row, outline: work, cls, subject: head.subject, side })}>Download as Excel</button>
        {row.status === 'draft' && <a className="small" href={`#/courses/upload?replace=${row.course_id}`}>Replace from Excel</a>}
        {row.status === 'retired' ? <button className="secondary" disabled={busy} onClick={() => onStatus('draft', 'Restore')}>Restore (as draft)</button>
          : <button className="link" disabled={busy || dirty} onClick={() => onStatus('retired', 'Retire course')}>Retire course</button>}
      </div>
      <h2>Outline</h2>
      <ol className="crs-outline">{work.chapters.map((c, ci) => (
        <li key={c.id ?? ci}><strong>{chapterNo(ci)} {c.name}</strong> {c.id && <Id>{c.id}</Id>}
          <ul>{c.topics.map((t, ti) => (
            <li key={t.id ?? ti}>{topicNo(ci, ti)} {t.name} — {t.cms.length ? t.cms.map((id) => <span key={id} className="crs-cmsid"><Id>{id}</Id> {countFor(side.topics.get(id)?.counts, cls).n}</span>) : <span className="error small">no CMS topics</span>}</li>))}
            {c.achievers.length > 0 && <li className="muted">Achievers: {c.achievers.map((a) => <span key={a} className="crs-cmsid"><Id>{achId(a, cls)}</Id> {countFor(side.topics.get(achId(a, cls))?.counts, cls).n}</span>)}</li>}
          </ul></li>))}
      </ol>
    </div>
  );
}

function TopicIds({ ids, side, cls }: { ids: string[]; side: CmsSide; cls: number }) {
  const [open, setOpen] = useState(false);
  return <> <button className="link small" onClick={() => setOpen((o) => !o)}>{open ? 'hide' : 'show'}</button>
    {open && <ul className="crs-unplaced">{ids.map((id) => { const t = side.topics.get(id); return <li key={id}>{t?.name ?? id} <Id>{id}</Id> {t && <ClassTag t={t.home_class} cls={cls} />} <span className="small">{countFor(t?.counts, cls).n} q</span></li>; })}</ul>}</>;
}

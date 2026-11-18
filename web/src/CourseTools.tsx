// Course builder, Iteration 2 (Q13, 18 Nov 2026): 5 Upload from Excel · 6 Clone a display chapter · 7 Compare two
// display chapters. Each ends in ONE save through cms_save_course (one audited transaction; source upload / clone / compare).
import { useEffect, useMemo, useState } from 'react';
import { Id } from './Id';
import { ClassTag, courseHash } from './Courses';
import { chapterNo, countFor, MAX_ACHIEVERS_PER_CHAPTER, MAX_CMS_PER_TOPIC, topicNo, type Outline } from '../../shared/course.ts';
import { outlineDiff, parseUpload, readCourseSheet, templateSheets, type UploadProblem, type UploadResult } from '../../shared/course-excel.ts';
import { addAchieverToA, addToA, cloneChapter, compareChapters, type Side } from '../../shared/course-ops.ts';
import { boards as loadBoards, chapterCourse, cmsSide, courses as loadCourses, outline as loadOutline, saveCourse, type Board, type CmsSide, type CourseRow } from './courseApi';
import { downloadCourseXlsx, readCourseXlsx } from './courseExcel';

const SUBJ: Record<string, string> = { math: 'Math', science: 'Science' };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const courseLabel = (c: CourseRow) => `${c.name} (${c.course_id} · ${c.board_label} · C${c.class} · ${SUBJ[c.subject]} · ${c.status})`;
const safeName = (s: string) => s.replace(/[^\w\-·. ]+/g, '').replace(/\s+/g, '-').slice(0, 80);

/** Download the template (empty, or filled from a course) for a class and subject. */
export async function downloadTemplate(o: { course?: CourseRow | null; outline?: Outline | null; cls: number; subject: 'math' | 'science'; side?: CmsSide }) {
  const side = o.side ?? await cmsSide(o.subject);
  const sheets = templateSheets({ head: o.course ? { name: o.course.name, board_label: o.course.board_label, class: o.course.class, subject: o.course.subject } : null,
    cls: o.cls, outline: o.outline, topics: side.topics, chapters: side.chapters, strands: side.strands });
  await downloadCourseXlsx(o.course ? `${safeName(o.course.name)}-${o.course.course_id}.xlsx` : `course-template-C${o.cls}-${o.subject}.xlsx`, sheets);
}

// ================================================================ 5 · Upload from Excel
export function UploadScreen({ replace: replaceParam }: { replace: string | null }) {
  const [courses, setCourses] = useState<CourseRow[] | null>(null);
  const [boards, setBoards] = useState<Board[]>([]);
  const [mode, setMode] = useState<'new' | 'replace'>(replaceParam ? 'replace' : 'new');
  const [target, setTarget] = useState(replaceParam ?? '');
  const [tCls, setTCls] = useState(5);
  const [tSubj, setTSubj] = useState<'math' | 'science'>('math');
  const [file, setFile] = useState<{ name: string; sha256: string } | null>(null);
  const [res, setRes] = useState<(UploadResult & { prev: Outline | null; side: CmsSide }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showOutline, setShowOutline] = useState(false);
  const [lastSheets, setLastSheets] = useState<Awaited<ReturnType<typeof readCourseXlsx>>['sheets'] | null>(null);
  useEffect(() => { Promise.all([loadCourses(), loadBoards()]).then(([c, b]) => { setCourses(c); setBoards(b); }).catch((e) => setErr((e as Error).message)); }, []);
  const drafts = (courses ?? []).filter((c) => c.status === 'draft');
  const tgt = mode === 'replace' ? drafts.find((c) => c.course_id === target) ?? null : null;
  useEffect(() => { if (tgt) { setTCls(tgt.class); setTSubj(tgt.subject); } }, [tgt?.course_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = async (sheets: Awaited<ReturnType<typeof readCourseXlsx>>['sheets']) => {
    setErr(null); setRes(null);
    const first = readCourseSheet(sheets, boards);
    if (!first.head) { setRes({ head: null, outline: { chapters: [] }, problems: first.problems, prev: null, side: null as unknown as CmsSide }); return; }
    const [side, prev] = await Promise.all([cmsSide(first.head.subject), tgt ? loadOutline(tgt.course_id) : Promise.resolve(null)]);
    const r = parseUpload(sheets, {
      boards, topics: side.topics, chapters: side.chapters,
      courseNames: new Map((courses ?? []).filter((c) => c.status !== 'retired').map((c) => [c.name.toLowerCase(), c.course_id])),
      replace: tgt && prev ? { course_id: tgt.course_id, name: tgt.name, board_id: tgt.board_id, class: tgt.class, subject: tgt.subject, status: tgt.status, outline: prev } : null,
    });
    setRes({ ...r, prev, side });
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try { const x = await readCourseXlsx(f); setFile({ name: f.name, sha256: x.sha256 }); setLastSheets(x.sheets); await check(x.sheets); }
    catch (e) { setErr(`Couldn't read ${f.name}: ${(e as Error).message}`); } finally { setBusy(false); }
  };
  // re-check when the mode or target changes after a file was dropped
  useEffect(() => { if (lastSheets) void check(lastSheets); }, [mode, target]); // eslint-disable-line react-hooks/exhaustive-deps

  const errors = res?.problems.filter((p) => p.level === 'error') ?? [];
  const warns = res?.problems.filter((p) => p.level === 'warn') ?? [];
  const save = async () => {
    if (!res?.head || errors.length || !file) return;
    if (mode === 'replace' && !tgt) { setErr('Choose the draft to replace.'); return; }
    setBusy(true); setErr(null);
    try {
      const r = mode === 'replace'
        ? await saveCourse({ course_id: tgt!.course_id, rev: tgt!.rev, source: 'upload', reason: `Upload ${file.name}`, outline: res.outline, file })
        : await saveCourse({ source: 'upload', reason: `Upload ${file.name}`, course: res.head, outline: res.outline, file });
      location.hash = courseHash(r.course_id, 'review');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const diff = res && res.prev ? outlineDiff(res.prev, res.outline) : null;
  const totals = res ? { ch: res.outline.chapters.length, tp: res.outline.chapters.reduce((s, c) => s + c.topics.length, 0), cms: res.outline.chapters.reduce((s, c) => s + c.topics.reduce((x, t) => x + t.cms.length, 0), 0) } : null;
  const cls = res?.head?.class ?? tCls;

  return (
    <main className="wide crs">
      <p className="small"><a href="#/courses">← All courses</a></p>
      <h1>Upload a course from Excel</h1>
      <div className="crs-panel crs-upload">
        <div className="crs-row">
          <label className="check"><input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> New course</label>
          <label className="check"><input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Replace a draft</label>
          {mode === 'replace' && <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Draft to replace">
            <option value="">Choose a draft…</option>{drafts.map((c) => <option key={c.course_id} value={c.course_id}>{courseLabel(c)}</option>)}</select>}
        </div>
        {mode === 'replace' && <p className="muted small">Replace keeps the draft's name and IDs: chapter n and topic n.m of the file update chapter n and topic n.m of the draft; anything not in the file is retired (kept in the history). Board, class and subject must match. Only drafts can be replaced.</p>}
        <div className="crs-row">
          <strong>1. Template</strong>
          {!tgt && <>
            <select value={tCls} onChange={(e) => setTCls(Number(e.target.value))} aria-label="Template class">{[1, 2, 3, 4, 5, 6].map((c) => <option key={c} value={c}>Class {c}</option>)}</select>
            <select value={tSubj} onChange={(e) => setTSubj(e.target.value as 'math' | 'science')} aria-label="Template subject"><option value="math">Math</option><option value="science">Science</option></select>
          </>}
          <button className="secondary" disabled={busy} onClick={async () => { setBusy(true); try { await downloadTemplate({ cls: tCls, subject: tSubj }); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }}>Download empty template</button>
          {tgt && <button className="secondary" disabled={busy} onClick={async () => { setBusy(true); try { await downloadTemplate({ course: tgt, outline: await loadOutline(tgt.course_id), cls: tgt.class, subject: tgt.subject }); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }}>Download {tgt.course_id} as Excel</button>}
        </div>
        <p className="muted small">Sheets: 1 Course · 2 Display chapters · 3 Display topics · 4 Display topic → CMS topics · 5 Achievers CMS chapters · 6 CMS topics for Class {tCls} (read-only, ignored on upload). Extra columns (e.g. notes) are ignored.</p>
        <div className="crs-row">
          <strong>2. File</strong>
          <label className="crs-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void onFile(e.dataTransfer.files[0]); }}>
            <input type="file" accept=".xlsx" onChange={(e) => void onFile(e.target.files?.[0])} />
            <span>{file ? `${file.name}` : 'Drop an .xlsx here or choose a file'}</span>
          </label>
        </div>
      </div>
      {err && <p className="error">{err}</p>}
      {busy && <p className="muted">Working…</p>}
      {res && <>
        {!errors.length ? <p className="ok">✓ No errors{warns.length ? `; ${plural(warns.length, 'warning')}` : ''}.</p> : null}
        <Problems title="Errors: fix them in the file, then upload again" items={errors} cls="err" icon="✗" />
        <Problems title="Warnings (do not block saving)" items={warns} cls="warn" icon="!" />
        {res.head && totals && <div className="crs-totals">
          <span><strong>{res.head.name}</strong></span><span>{boards.find((b) => b.board_id === res.head!.board_id)?.label} · Class {res.head.class} · {SUBJ[res.head.subject]}</span>
          <span><strong>{totals.ch}</strong> chapters</span><span><strong>{totals.tp}</strong> display topics</span><span><strong>{totals.cms}</strong> CMS topics</span>
        </div>}
        {diff && <p className="small">Changes to <strong>{tgt?.course_id}</strong>: {[
          diff.chaptersAdded && `+${diff.chaptersAdded} chapters`, diff.chaptersRenamed && `${diff.chaptersRenamed} renamed`, diff.chaptersRetired && `${diff.chaptersRetired} chapters retired`,
          diff.topicsAdded && `+${diff.topicsAdded} display topics`, diff.topicsRenamed && `${diff.topicsRenamed} renamed`, diff.topicsRetired && `${diff.topicsRetired} retired`,
          diff.linksAdded && `+${diff.linksAdded} CMS links`, diff.linksRemoved && `−${diff.linksRemoved} CMS links`, diff.achieversChanged && `${diff.achieversChanged} Achievers sections changed`].filter(Boolean).join(' · ') || 'none'}</p>}
        {res.head && <p><button className="link more" onClick={() => setShowOutline((x) => !x)}>{showOutline ? 'Hide' : 'Show'} the outline</button></p>}
        {showOutline && res.side && <ol className="crs-outline">{res.outline.chapters.map((c, ci) => (
          <li key={ci}><strong>{chapterNo(ci)} {c.name}</strong> {c.id && <Id>{c.id}</Id>}
            <ul>{c.topics.map((t, ti) => <li key={ti}>{topicNo(ci, ti)} {t.name} {t.id && <Id>{t.id}</Id>} — {t.cms.map((id) => <span key={id} className="crs-cmsid">{res.side.topics.get(id)?.name} <Id>{id}</Id> {countFor(res.side.topics.get(id)?.counts, cls).n}</span>)}</li>)}
              {c.achievers.length > 0 && <li className="muted">Achievers: {c.achievers.join(', ')}</li>}</ul></li>))}</ol>}
        <div className="crs-actions">
          <button disabled={busy || !!errors.length || !res.head || (mode === 'replace' && !tgt)} onClick={save}>{mode === 'replace' ? `Replace ${tgt?.course_id ?? 'draft'}` : 'Save as a new draft course'}</button>
          {errors.length > 0 && <span className="muted small">Saving is blocked while there are errors.</span>}
        </div>
      </>}
    </main>
  );
}

function Problems({ title, items, cls, icon }: { title: string; items: UploadProblem[]; cls: string; icon: string }) {
  if (!items.length) return null;
  return (
    <div className={`crs-checks ${cls}`}><strong>{icon} {title} ({items.length})</strong>
      <ul>{items.map((p, k) => <li key={k}><span className="muted small">{p.sheet}{p.row ? ` · row ${p.row}` : ''}:</span> {p.message}</li>)}</ul></div>);
}

// ================================================================ 6 · Clone a display chapter
export function CloneScreen({ id }: { id: string }) {
  const [courses, setCourses] = useState<CourseRow[] | null>(null);
  const [target, setTarget] = useState<{ row: CourseRow; outline: Outline; side: CmsSide } | null>(null);
  const [srcCourse, setSrcCourse] = useState('');
  const [srcOutline, setSrcOutline] = useState<Outline | null>(null);
  const [srcCh, setSrcCh] = useState(0);
  const [name, setName] = useState('');
  const [place, setPlace] = useState('end');
  const [ticked, setTicked] = useState<boolean[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const cs = await loadCourses();
      const row = cs.find((c) => c.course_id === id);
      if (!row) throw new Error(`Course ${id} doesn't exist.`);
      const [outline, side] = await Promise.all([loadOutline(id), cmsSide(row.subject)]);
      setCourses(cs); setTarget({ row, outline, side });
    })().catch((e) => setErr((e as Error).message));
  }, [id]);
  useEffect(() => { setSrcOutline(null); setSrcCh(0); if (srcCourse) loadOutline(srcCourse).then(setSrcOutline).catch((e) => setErr((e as Error).message)); }, [srcCourse]);
  const src = srcOutline?.chapters[srcCh] ?? null;
  useEffect(() => { setName(src?.name ?? ''); setTicked(src ? src.topics.map(() => true) : []); }, [src?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const plan = useMemo(() => (target && src ? cloneChapter(target.outline, src, { name, place: place === 'end' ? 'end' : { replace: Number(place) }, ticked }) : null), [target, src, name, place, ticked]);
  if (err && !target) return <main className="wide"><p className="error">{err}</p></main>;
  if (!target || !courses) return <main className="wide"><p className="muted">Loading…</p></main>;
  const { row, side } = target;
  const sources = courses.filter((c) => c.subject === row.subject && c.course_id !== row.course_id);
  const cls = row.class;
  const srcRow = courses.find((c) => c.course_id === srcCourse);
  const usedNow = (() => { const m = new Map<string, string>(); target.outline.chapters.forEach((c, ci) => { if (place !== 'end' && ci === Number(place)) return; c.topics.forEach((t, ti) => t.cms.forEach((x) => m.set(x, `${topicNo(ci, ti)} ${t.name}`))); }); return m; })();
  const save = async () => {
    if (!plan || !src) return;
    setBusy(true); setErr(null);
    try {
      await saveCourse({ course_id: row.course_id, rev: row.rev, source: 'clone', reason: `Cloned from ${srcRow?.course_id} › ${src.id} "${src.name}"`, outline: plan.outline });
      const fresh = await loadOutline(row.course_id);
      location.hash = courseHash(row.course_id, 'topics', fresh.chapters[plan.ci]?.id ?? null);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <main className="wide crs">
      <p className="small"><a href={courseHash(row.course_id, 'chapters')}>← {row.name}</a></p>
      <h1>Clone a display chapter into {row.name} <Id>{row.course_id}</Id></h1>
      {row.status !== 'draft' && <p className="notice small">{row.course_id} is {row.status}; only a draft can change. Use Back to draft first.</p>}
      <div className="crs-panel">
        <div className="crs-row">
          <label>Source course<select value={srcCourse} onChange={(e) => setSrcCourse(e.target.value)}><option value="">Choose…</option>{sources.map((c) => <option key={c.course_id} value={c.course_id}>{courseLabel(c)}</option>)}</select></label>
          {srcOutline && <label>Chapter<select value={srcCh} onChange={(e) => setSrcCh(Number(e.target.value))}>{srcOutline.chapters.map((c, i) => <option key={c.id} value={i}>{chapterNo(i)} {c.name}</option>)}</select></label>}
        </div>
        {!sources.length && <p className="muted small">No other {SUBJ[row.subject]} course yet.</p>}
        {src && <div className="crs-row">
          <label>New name<input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></label>
          <label>Place<select value={place} onChange={(e) => setPlace(e.target.value)}>
            <option value="end">At the end (chapter {target.outline.chapters.length + 1})</option>
            {target.outline.chapters.map((c, i) => <option key={c.id} value={i}>Replace {chapterNo(i)} {c.name}</option>)}</select></label>
        </div>}
        {srcRow && srcRow.class !== cls && <p className="notice small">{srcRow.course_id} is Class {srcRow.class}; counts here use Class {cls} (Level ≤ {cls}) and Class {cls} Achievers topics.</p>}
      </div>
      {src && plan && <>
        <h2>Preview</h2>
        <p className="muted small">Untick display topics you don't want. CMS topics already in {row.course_id} are skipped (struck through). The source course is never changed.</p>
        <ul className="crs-clone">{src.topics.map((t, i) => (
          <li key={i}>
            <label className="check"><input type="checkbox" checked={ticked[i] !== false} onChange={(e) => setTicked(ticked.map((x, k) => (k === i ? e.target.checked : x)))} /> <strong>{t.name}</strong></label>
            <span className="crs-clone-cms">{t.cms.map((x) => { const u = usedNow.get(x); const info = side.topics.get(x); return (
              <span key={x} className={u ? 'skip' : ''} title={u ? `skipped: already in ${u}` : ''}>{info?.name ?? x} <Id>{x}</Id> {countFor(info?.counts, cls).n} q{u ? ` (in ${u})` : ''}</span>); })}</span>
          </li>))}
          {src.achievers.length > 0 && <li className="muted">Achievers: {src.achievers.map((a) => <span key={a} className={plan.skippedAchievers.some((s) => s.id === a) ? 'skip' : ''}>{a} </span>)}</li>}
        </ul>
        <p className="small">Result: chapter {plan.ci + 1} "{plan.outline.chapters[plan.ci]!.name}" with {plural(plan.outline.chapters[plan.ci]!.topics.length, 'display topic')}{plan.skipped.length ? ` · ${plural(plan.skipped.length, 'CMS topic')} skipped` : ''}{plan.dropped.length ? ` · ${plural(plan.dropped.length, 'display topic')} not copied` : ''}{place !== 'end' ? ` · chapter ${Number(place) + 1} "${target.outline.chapters[Number(place)]!.name}" is retired` : ''}.</p>
        {err && <p className="error">{err}</p>}
        <div className="crs-actions"><button disabled={busy || row.status !== 'draft' || !plan.outline.chapters[plan.ci]!.topics.length} onClick={save}>{busy ? 'Saving…' : 'Save and open its topics'}</button></div>
      </>}
    </main>
  );
}

// ================================================================ 7 · Compare two display chapters
export function CompareScreen({ a, b }: { a: string | null; b: string | null }) {
  const [courses, setCourses] = useState<CourseRow[] | null>(null);
  const [aCourse, setACourse] = useState(''); const [bCourse, setBCourse] = useState('');
  const [A, setA] = useState<{ row: CourseRow; saved: Outline; side: CmsSide } | null>(null);
  const [B, setB] = useState<{ row: CourseRow; saved: Outline; side: CmsSide } | null>(null);
  const [work, setWork] = useState<Outline | null>(null);
  const [chip, setChip] = useState<'all' | Side>('all');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const cs = await loadCourses(); setCourses(cs);
      if (a) setACourse((await chapterCourse(a)) ?? ''); if (b) setBCourse((await chapterCourse(b)) ?? '');
    })().catch((e) => setErr((e as Error).message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const load = async (cid: string) => { const row = (await loadCourses()).find((c) => c.course_id === cid)!; const [saved, side] = await Promise.all([loadOutline(cid), cmsSide(row.subject)]); return { row, saved, side }; };
  useEffect(() => { setA(null); setWork(null); if (aCourse) load(aCourse).then((x) => { setA(x); setWork(x.saved); }).catch((e) => setErr((e as Error).message)); }, [aCourse]);
  useEffect(() => { setB(null); if (bCourse) load(bCourse).then(setB).catch((e) => setErr((e as Error).message)); }, [bCourse]);
  const go = (na: string | null, nb: string | null) => { location.hash = `#/courses/compare?${new URLSearchParams({ ...(na ? { a: na } : {}), ...(nb ? { b: nb } : {}) })}`; };
  const aci = A && work ? Math.max(0, work.chapters.findIndex((c) => c.id === a)) : 0;
  const bch = B ? B.saved.chapters.find((c) => c.id === b) ?? B.saved.chapters[0] ?? null : null;
  const cmp = useMemo(() => (work && work.chapters[aci] && bch ? compareChapters(work, aci, bch) : null), [work, aci, bch]);
  const dirty = !!A && !!work && JSON.stringify(work) !== JSON.stringify(A.saved);
  const editable = A?.row.status === 'draft';
  const save = async () => {
    if (!A || !work) return;
    setBusy(true); setErr(null);
    try {
      await saveCourse({ course_id: A.row.course_id, rev: A.row.rev, source: 'compare', reason: `Added from compare with ${B?.row.course_id} › ${bch?.id}`, outline: work });
      const x = await load(A.row.course_id); setA(x); setWork(x.saved); setMsg('Saved.');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (!courses) return <main className="wide"><p className="muted">{err ?? 'Loading…'}</p></main>;
  const pick = (label: string, course: string, setCourse: (s: string) => void, x: typeof A, chId: string | null, setCh: (s: string) => void) => (
    <div className="crs-panel">
      <strong>{label}</strong>
      <select value={course} onChange={(e) => setCourse(e.target.value)} aria-label={`${label} course`}><option value="">Choose a course…</option>{courses.map((c) => <option key={c.course_id} value={c.course_id}>{courseLabel(c)}</option>)}</select>
      {x && <select value={chId ?? x.saved.chapters[0]?.id ?? ''} onChange={(e) => setCh(e.target.value)} aria-label={`${label} chapter`}>{x.saved.chapters.map((c, i) => <option key={c.id} value={c.id}>{chapterNo(i)} {c.name}</option>)}</select>}
    </div>);
  const nameOf = (id: string) => A?.side.topics.get(id) ?? B?.side.topics.get(id);
  const rows = cmp ? cmp.topics.filter((r) => chip === 'all' || r.side === chip) : [];
  const achRows = cmp ? cmp.achievers.filter((r) => chip === 'all' || r.side === chip) : [];
  const aCh = work?.chapters[aci];
  const count = (r: 'both' | 'a' | 'b') => cmp?.topics.filter((x) => x.side === r).length ?? 0;
  return (
    <main className="wide crs">
      <p className="small"><a href="#/courses">← All courses</a></p>
      <h1>Compare two display chapters</h1>
      <div className="crs-cols">
        {pick('A', aCourse, (s) => { setACourse(s); go(null, b); }, A, a, (s) => go(s, b))}
        {pick('B', bCourse, (s) => { setBCourse(s); go(a, null); }, B, b, (s) => go(a, s))}
      </div>
      {cmp && A && B && aCh && bch && <>
        <div className="filters crs-chips">
          {(['all', 'both', 'a', 'b'] as const).map((c) => <button key={c} className={`pill ${chip === c ? 'on' : ''}`} onClick={() => setChip(c)}>{c === 'all' ? `All (${cmp.topics.length})` : c === 'both' ? `In both (${count('both')})` : c === 'a' ? `Only in A (${count('a')})` : `Only in B (${count('b')})`}</button>)}
          <span className="spacer" />
          {!editable && <span className="muted small">A is {A.row.status}: "+ Add to A" needs an editable draft.</span>}
          {dirty && <><span className="small">Unsaved additions to {A.row.course_id}</span><button className="secondary" onClick={() => setWork(A.saved)}>Discard</button><button disabled={busy} onClick={save}>Save to A</button></>}
          {msg && !dirty && <span className="ok small">{msg}</span>}
        </div>
        {err && <p className="error">{err}</p>}
        <table className="list crs-cmp">
          <thead><tr><th>CMS topic</th><th>A · {chapterNo(aci)} {aCh.name} <span className="muted small">(C{A.row.class})</span></th><th>B · {bch.name} <span className="muted small">(C{B.row.class})</span></th><th /></tr></thead>
          <tbody>{rows.map((r) => {
            const t = nameOf(r.id);
            return (
              <tr key={r.id} className={`side-${r.side}`}>
                <td>{t?.name ?? r.id} <Id>{r.id}</Id> {t && <ClassTag t={t.home_class} cls={A.row.class} />}</td>
                <td>{r.a ? <>{topicNo(aci, r.a.ti)} {r.a.name} <span className="small">{countFor(A.side.topics.get(r.id)?.counts, A.row.class).n} q</span></> : r.elsewhereInA ? <span className="warn-text small">in A › {r.elsewhereInA}</span> : <span className="muted">—</span>}</td>
                <td>{r.b ? <>{r.b.name} <span className="small">{countFor(B.side.topics.get(r.id)?.counts, B.row.class).n} q</span></> : <span className="muted">—</span>}</td>
                <td>{r.side === 'b' && !r.elsewhereInA && editable && A.row.subject === B.row.subject && <AddToA aCh={aCh} bName={r.b!.name} onAdd={(to) => setWork(addToA(work!, aci, r.id, to))} />}</td>
              </tr>);
          })}</tbody>
        </table>
        {(achRows.length > 0) && <>
          <h2>Achievers chapters</h2>
          <table className="list crs-cmp"><tbody>{achRows.map((r) => (
            <tr key={r.id}><td>{A.side.chapters.find((c) => c.chapter_id === r.id)?.name ?? r.id} <Id>{r.id}</Id></td>
              <td>{r.a ? '✓ in A' : r.elsewhereInA ? <span className="warn-text small">in A › {r.elsewhereInA}</span> : '—'}</td><td>{r.b ? '✓ in B' : '—'}</td>
              <td>{r.side === 'b' && !r.elsewhereInA && editable && A.row.subject === 'math' && aCh.achievers.length < MAX_ACHIEVERS_PER_CHAPTER && <button className="link" onClick={() => setWork(addAchieverToA(work!, aci, r.id))}>+ Add to A</button>}</td></tr>))}
          </tbody></table></>}
      </>}
    </main>
  );
}

function AddToA({ aCh, bName, onAdd }: { aCh: Outline['chapters'][number]; bName: string; onAdd: (to: { ti: number } | { newName: string }) => void }) {
  return (
    <select className="small-select" value="" aria-label="Add to A" onChange={(e) => { const v = e.target.value; if (!v) return; onAdd(v === 'new' ? { newName: bName } : { ti: Number(v) }); }}>
      <option value="">+ Add to A…</option>
      {aCh.topics.map((t, ti) => <option key={ti} value={ti} disabled={t.cms.length >= MAX_CMS_PER_TOPIC}>into {t.name}{t.cms.length >= MAX_CMS_PER_TOPIC ? ' (full)' : ''}</option>)}
      <option value="new">into a new display topic "{bName}"</option>
    </select>);
}

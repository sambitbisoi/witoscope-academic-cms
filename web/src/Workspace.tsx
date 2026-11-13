import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { reviewOf, topicData, tree, type Chapter, type QuestionRow, type TopicReview, type TopicWithStats } from './api';
import { AddQuestionForm, BulkUpload, OriginFlags } from './AddQuestions';
import { ReviewControl, ReviewFilterSelect, RollUpIcon, TopicReviewIcon } from './ReviewStatus';
import {
  applyFilters, browseHash, classesLabel, FLAG_FILTERS, matchesReview, roleOf, rollUp, type ReviewFilter, type RollUp, cloneGroups, countsLabel, distinctTexts, sameWording, type CloneInfo, gapLabel, groupBySet, involvementOf, mixLabel, NO_FILTERS, statusCountsLabel, statusLabel,
  subjectLabel, SUBJECTS, summarize, type Filters, type Subject,
} from './logic';
import { EditForm } from './EditForm';
import { CurriculumForm, type Kind } from './CurriculumForms';
import { Proposed, QuestionDetail, type ReviewCommand } from './QuestionDetail';
import { SourcesTab } from './Sources';
import { chapterSourceCount } from './sourcesApi';
import { rememberBrowse } from './Shell';

type R = { subject: Subject; cls: string; strand: string | null; ch: string | null; topic: string | null; q: string | null; v: number | null; tab: 'types' | 'concepts' | 'sources'; edit: boolean };
const SOURCE_LABEL: Record<string, string> = { ncert: 'NCERT', dav: 'DAV', ixl: 'IXL', imo: 'IMO', iso: 'ISO', ieo: 'IEO' };

// ---------------------------------------------------------------- small persisted preferences (best effort)
function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => { try { const s = localStorage.getItem(key); return s === null ? initial : JSON.parse(s) as T; } catch { return initial; } });
  const set = useCallback((x: T) => { setV(x); try { localStorage.setItem(key, JSON.stringify(x)); } catch { /* best effort */ } }, [key]);
  return [v, set];
}

// U11: pane widths and the pinned tree, remembered.
const PANES = { tree: 300, detail: 440 };
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function Workspace(r: R) {
  const [data, setData] = useState<Awaited<ReturnType<typeof tree>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gapsOnly, setGapsOnly] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  // R1: core topics only unless extra ones (from a lower / higher class) are asked for
  const [extra, setExtra] = usePref('cms.extraTopics', false);
  const [openState, setOpenState] = usePref<Record<string, boolean>>('cms.treeOpen', {});
  const [panes, setPanes] = usePref('cms.panes', { tree: PANES.tree, detail: PANES.detail, pinned: true });
  const [overlay, setOverlay] = useState(false);
  const [reload, setReload] = useState(0);
  const [order, setOrder] = useState<string[]>([]);
  const [command, setCommand] = useState<ReviewCommand | null>(null);
  useEffect(() => { rememberBrowse(browseHash(r)); });
  useEffect(() => {
    setData(null); setError(null);
    tree(r.subject, r.cls).then(setData).catch((e) => setError(e.message));
  }, [r.subject, r.cls]);
  useEffect(() => { if (reload) tree(r.subject, r.cls).then(setData).catch(() => {}); }, [reload]); // refresh counts quietly

  const go = useCallback((patch: Partial<R>) => { location.hash = browseHash({ ...r, ...patch }); }, [r.subject, r.cls, r.strand, r.ch, r.topic, r.q, r.v, r.tab, r.edit]);
  const topic = data?.topics.find((t) => t.topic_id === r.topic) ?? null;
  const step = useCallback((d: 1 | -1) => {
    if (!order.length) return;
    const i = r.q ? order.indexOf(r.q) : -1;
    const next = order[Math.min(order.length - 1, Math.max(0, i < 0 ? 0 : i + d))];
    if (next && next !== r.q) go({ q: next, v: null, edit: false });
  }, [order, r.q, go]);

  // Keyboard: A approve · R reject · F needs review · ↓↑ (or J/K) next/previous · [ toggles the tree.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || r.edit) return;
      if (e.key === '[') { e.preventDefault(); setPanes({ ...panes, pinned: !panes.pinned }); setOverlay(false); return; }
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); step(1); return; }
      if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); step(-1); return; }
      if (!r.q || r.v) return;
      const kind = ({ a: 'approve', r: 'reject', f: 'flag' } as const)[e.key.toLowerCase() as 'a' | 'r' | 'f'];
      if (kind) { e.preventDefault(); setCommand({ kind, n: Date.now() }); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [step, r.q, r.v, r.edit, panes, setPanes]);

  // R1: the topics this class shows (core, plus extra ones when asked); the selected topic always shows
  const shownTopics = useMemo(() => (data?.topics ?? []).filter((t) => r.cls === 'all' || extra || t.class === Number(r.cls) || t.topic_id === r.topic), [data, r.cls, extra, r.topic]);
  const nExtra = useMemo(() => (r.cls === 'all' ? 0 : (data?.topics ?? []).filter((t) => t.class !== Number(r.cls)).length), [data, r.cls]);
  const chapterOf = useMemo(() => new Map((data?.chapters ?? []).map((c) => [c.chapter_id, c])), [data]);
  const { strands, chapters } = useMemo(() => {
    if (!data) return { strands: [], chapters: [] };
    const n = new Map<string, number>();
    for (const t of shownTopics) n.set(t.chapter_id, (n.get(t.chapter_id) ?? 0) + (t.stats?.n_questions ?? 0));
    const chs = data.chapters.filter((c) => n.has(c.chapter_id)).map((c) => ({ ...c, n: n.get(c.chapter_id)! }));
    return { strands: data.strands.filter((s) => chs.some((c) => c.strand_id === s.strand_id)), chapters: chs.filter((c) => !r.strand || c.strand_id === r.strand) };
  }, [data, shownTopics, r.strand]);
  // Review roll-ups per chapter and strand within this class: core topics only (extra rows ignored)
  const rolls = useMemo(() => {
    const ch = new Map<string, RollUp>(); const st = new Map<string, RollUp>();
    if (!data) return { ch, st };
    const items = data.topics.map((t) => ({ t, x: { status: reviewOf(data.reviews, t.topic_id), core: r.cls === 'all' || t.class === Number(r.cls), active: t.status === 'active', achievers: t.topic_kind === 'achievers' } }));
    for (const c of data.chapters) ch.set(c.chapter_id, rollUp(items.filter((i) => i.t.chapter_id === c.chapter_id).map((i) => i.x)));
    for (const x of data.strands) { const ids = new Set(data.chapters.filter((c) => c.strand_id === x.strand_id).map((c) => c.chapter_id)); st.set(x.strand_id, rollUp(items.filter((i) => ids.has(i.t.chapter_id)).map((i) => i.x))); }
    return { ch, st };
  }, [data, r.cls]);
  // R3: every branch is open by default (Sambit, 13 Nov); a branch closed with its arrow stays closed (remembered)
  const selChapter = topicChapter(data?.topics, r.topic);
  // a newly selected topic re-opens its branch even if it was closed before
  useEffect(() => {
    if (!selChapter) return;
    const st = chapterOf.get(selChapter)?.strand_id;
    if (openState[selChapter] === false || (st && openState[st] === false)) setOpenState({ ...openState, [selChapter]: true, ...(st ? { [st]: true } : {}) });
  }, [r.topic, selChapter]); // eslint-disable-line react-hooks/exhaustive-deps
  const isOpen = (id: string) => openState[id] ?? true;
  const toggle = (id: string) => setOpenState({ ...openState, [id]: !isOpen(id) });

  const treeEl = (
    <>
      <div className="tree-head">
        <span className="eyebrow">Strands · chapters · topics</span>
        <button className="pin" title={panes.pinned ? 'Unpin: fold the tree into a rail ([)' : 'Pin the tree open ([)'} aria-pressed={panes.pinned}
          onClick={() => { setPanes({ ...panes, pinned: !panes.pinned }); setOverlay(false); }}>{panes.pinned ? '⇤ Unpin' : '📌 Pin'}</button>
      </div>
      <div className="tree-toggles">
        <button className={`pill small ${gapsOnly ? 'on' : ''}`} aria-pressed={gapsOnly} onClick={() => setGapsOnly(!gapsOnly)}>Gaps only</button>
        <ReviewFilterSelect value={reviewFilter} onChange={setReviewFilter} />
      </div>
      {error && <p className="error">Couldn't load topics: {error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && <Tree strands={strands.filter((x) => !r.strand || x.strand_id === r.strand)} chapters={chapters.filter((c) => !r.ch || c.chapter_id === r.ch)} topics={shownTopics} cls={r.cls}
        selected={r.topic} gapsOnly={gapsOnly} reviews={data.reviews} reviewFilter={reviewFilter} rolls={rolls} isOpen={isOpen} onToggle={toggle} onPick={(t) => { setOverlay(false); go({ topic: t, q: null, v: null }); }} />}
    </>
  );

  const style = { '--tree-w': `${panes.pinned ? panes.tree : 34}px`, '--detail-w': `${panes.detail}px` } as CSSProperties;
  return (
    <div className="workspace">
      <div className="ws-bar">
        <label className="sr-only" htmlFor="ws-class">Class</label>
        <select id="ws-class" value={r.cls} onChange={(e) => go({ cls: e.target.value, topic: null, q: null, v: null })}>
          <option value="all">All classes</option>
          {['1', '2', '3', '4', '5', '6'].map((c) => <option key={c} value={c}>Class {c}</option>)}
        </select>
        <label className="sr-only" htmlFor="ws-subject">Subject</label>
        <select id="ws-subject" value={r.subject} onChange={(e) => go({ subject: e.target.value as Subject, ch: null, topic: null, q: null, v: null })}>
          {SUBJECTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <label className="sr-only" htmlFor="ws-strand">Strand</label>
        <select id="ws-strand" className={r.strand ? 'active' : ''} value={r.strand ?? ''} onChange={(e) => go({ strand: e.target.value || null, ch: null, topic: null, q: null, v: null })}>
          <option value="">All strands</option>
          {strands.map((x) => <option key={x.strand_id} value={x.strand_id}>{x.name}</option>)}
          {r.strand && !strands.some((x) => x.strand_id === r.strand) && <option value={r.strand}>{r.strand} (no topics in this class)</option>}
        </select>
        <label className="sr-only" htmlFor="ws-chapter">Chapter</label>
        <select id="ws-chapter" className={`chapter-select ${r.ch ? 'active' : ''}`} value={r.ch ?? ''} onChange={(e) => go({ ch: e.target.value || null, topic: null, q: null, v: null })}>
          <option value="">All chapters</option>
          {chapters.map((c) => <option key={c.chapter_id} value={c.chapter_id}>{c.chapter_id} · {c.name} · {c.n} Q{c.n === 1 ? '' : 's'}</option>)}
          {r.ch && !chapters.some((c) => c.chapter_id === r.ch) && <option value={r.ch}>{r.ch} (no topics in this class)</option>}
        </select>
        {r.cls !== 'all' && <label className="check small extra-toggle" title="Topics whose home class is another class but that are also taught in this one">
          <input type="checkbox" checked={extra} onChange={(e) => setExtra(e.target.checked)} /> Include extra topics (lower / higher class){nExtra ? <span className="muted"> · {nExtra}</span> : null}</label>}
        <span className="muted small keys" title="Keyboard shortcuts in Browse">Keys: <kbd>A</kbd> approve · <kbd>R</kbd> reject · <kbd>F</kbd> needs review · <kbd>↓</kbd><kbd>↑</kbd> next / previous · <kbd>[</kbd> tree</span>
      </div>
      <div className={`ws-cols ${panes.pinned ? '' : 'unpinned'}`} style={style}>
        {panes.pinned ? <nav className="ws-tree" aria-label="Chapters and topics">{treeEl}</nav> : (
          <nav className="ws-rail" aria-label="Chapters and topics">
            <button className="rail-btn" title="Show the topic tree ([)" onClick={() => setOverlay(!overlay)}>☰<span>Topics</span></button>
            {overlay && <div className="ws-tree overlay" style={{ width: panes.tree }}>{treeEl}</div>}
          </nav>
        )}
        <Handle side="tree" disabled={!panes.pinned} onDrag={(dx) => setPanes({ ...panes, tree: clamp(panes.tree + dx, 200, 560) })} onReset={() => setPanes({ ...panes, tree: PANES.tree })} />
        <section className="ws-main" aria-label="Questions">
          {r.edit && r.q ? <EditForm key={r.q} questionId={r.q} onDone={(saved) => { go({ edit: false, v: null }); if (saved) setReload((x) => x + 1); }} />
            : !r.topic ? <Pick subject={r.subject} cls={r.cls} ch={chapters.find((c) => c.chapter_id === r.ch)} n={data ? shownTopics.filter((t) => (!r.ch || t.chapter_id === r.ch) && (!r.strand || chapterOf.get(t.chapter_id)?.strand_id === r.strand)).length : undefined} />
            : !data ? <p className="muted">Loading…</p>
            : !topic ? <p>Topic {r.topic} isn't in {subjectLabel(r.subject)}{r.cls !== 'all' ? ` class ${r.cls}` : ''}. <a href={browseHash({ ...r, cls: 'all' })}>Look in all classes</a></p>
            : <TopicView key={topic.topic_id} reload={reload} topic={topic} review={data.reviews.get(topic.topic_id)} chapter={data.chapters.find((c) => c.chapter_id === topic.chapter_id)} r={r} go={go} onOrder={setOrder} onChanged={() => setReload((x) => x + 1)} />}
        </section>
        <Handle side="detail" onDrag={(dx) => setPanes({ ...panes, detail: clamp(panes.detail - dx, 320, 900) })} onReset={() => setPanes({ ...panes, detail: PANES.detail })} />
        <aside className="ws-detail" aria-label="Question detail">
          {r.q ? <QuestionDetail id={r.q} versionNo={r.v} reloadKey={reload} onVersion={(v) => go({ v })} onEdit={() => go({ edit: true, v: null })}
              onChanged={() => setReload((x) => x + 1)} command={command} onAdvance={() => step(1)} />
            : <p className="muted">Select a question to see it here.</p>}
        </aside>
      </div>
    </div>
  );
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** U11: a drag handle between two panes; double-click resets the width. */
function Handle({ side, onDrag, onReset, disabled }: { side: string; onDrag: (dx: number) => void; onReset: () => void; disabled?: boolean }) {
  const last = useRef(0);
  const drag = useRef(onDrag);
  drag.current = onDrag;
  const down = (e: React.MouseEvent) => {
    if (disabled) return;
    e.preventDefault();
    last.current = e.clientX;
    document.body.classList.add('resizing');
    const move = (m: MouseEvent) => { const dx = m.clientX - last.current; if (dx) { last.current = m.clientX; drag.current(dx); } };
    const up = () => { document.body.classList.remove('resizing'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return <div className={`ws-handle ${side} ${disabled ? 'off' : ''}`} role="separator" aria-orientation="vertical" title={disabled ? undefined : 'Drag to resize · double-click to reset'}
    onMouseDown={down} onDoubleClick={disabled ? undefined : onReset} />;
}

function Pick({ subject, cls, ch, n }: { subject: Subject; cls: string; ch?: Chapter & { n: number }; n?: number }) {
  return (
    <div className="empty">
      <h1>{subjectLabel(subject)} · {cls === 'all' ? 'all classes' : `Class ${cls}`}</h1>
      {ch && <div className="chapter-name">Chapter {ch.chapter_id} · {ch.name}</div>}
      <p className="muted">{n === undefined ? 'Loading…' : `${n} topics. Pick one on the left.`}</p>
    </div>
  );
}

const topicChapter = (topics: TopicWithStats[] | undefined, id: string | null) => (id ? topics?.find((t) => t.topic_id === id)?.chapter_id ?? null : null);
const qsLabel = (n: number) => `${n} Q${n === 1 ? '' : 's'}`;

/** R3: Strand ▸ Chapter ▸ Topic; each branch opens and closes with the arrow on its left. */
function Tree({ strands, chapters, topics, cls, selected, gapsOnly, reviews, reviewFilter, rolls, isOpen, onToggle, onPick }: {
  strands: { strand_id: string; name: string }[]; chapters: Chapter[]; topics: TopicWithStats[]; cls: string; selected: string | null;
  gapsOnly: boolean; reviews: Map<string, TopicReview>; reviewFilter: ReviewFilter; rolls: { ch: Map<string, RollUp>; st: Map<string, RollUp> }; isOpen: (id: string) => boolean; onToggle: (id: string) => void; onPick: (t: string) => void;
}) {
  const visible = topics.filter((t) => t.status === 'active' || t.topic_id === selected)
    .filter((t) => !gapsOnly || gapLabel(t.stats) || t.topic_id === selected)
    .filter((t) => matchesReview(reviewFilter, reviewOf(reviews, t.topic_id)) || t.topic_id === selected);
  const byChapter = new Map<string, TopicWithStats[]>();
  for (const t of visible) byChapter.set(t.chapter_id, [...(byChapter.get(t.chapter_id) ?? []), t]);
  const shown = chapters.filter((c) => byChapter.has(c.chapter_id));
  if (!shown.length) return <p className="muted">{reviewFilter !== 'all' ? 'No topics with this review status.' : gapsOnly ? 'No gaps: every topic with questions has all 3 levels.' : 'No topics.'}</p>;
  const total = (ts: TopicWithStats[]) => ts.reduce((n, t) => n + (t.stats?.n_questions ?? 0), 0);
  const meta = (ts: TopicWithStats[]) => `${ts.length} topic${ts.length === 1 ? '' : 's'} · ${qsLabel(total(ts))}`;
  const arrow = (id: string) => <span className="tree-arrow" aria-hidden>{isOpen(id) ? '▾' : '▸'}</span>;
  const chapterEl = (c: Chapter) => {
    const ts = byChapter.get(c.chapter_id)!.sort((a, b) =>
      (a.topic_kind === 'achievers' ? 1 : 0) - (b.topic_kind === 'achievers' ? 1 : 0) || a.class - b.class || (a.seq ?? 999) - (b.seq ?? 999) || a.topic_id.localeCompare(b.topic_id));
    const open = isOpen(c.chapter_id);
    return (
      <div key={c.chapter_id} className="tree-chapter">
        <button className="tree-branch tree-chapter-name chapter-name" aria-expanded={open} onClick={() => onToggle(c.chapter_id)}>
          {arrow(c.chapter_id)}<span className="tb-name">{c.chapter_id} · {c.name}<RollUpIcon r={rolls.ch.get(c.chapter_id)} /></span><span className="tb-meta">{meta(ts)}</span>
        </button>
        {open && <div className="tree-kids">{ts.map((t) => {
          const gap = gapLabel(t.stats);
          const role = cls === 'all' ? 'core' : roleOf(t.class, Number(cls));
          return (
            <button key={t.topic_id} className={`tree-topic role-${role} ${t.topic_id === selected ? 'sel' : ''} ${t.topic_kind === 'achievers' ? 'ach' : ''}`} onClick={() => onPick(t.topic_id)}
              ref={t.topic_id === selected ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
              <span className="tt-name"><TopicReviewIcon status={reviewOf(reviews, t.topic_id)} />{t.topic_kind === 'achievers' ? t.name : <>{t.topic_id} {t.name}</>}{cls === 'all' && <span className="cls"> · C{t.class}</span>}
                {role !== 'core' && <span className={`role-tag ${role}`}> from Class {t.class}</span>}<ClassesPill classes={t.classes} /></span>
              <span className="tt-meta">{countsLabel(t.stats)}{gap && <span className="gap"> · ⚠ {gap}</span>}</span>
            </button>
          );
        })}</div>}
      </div>
    );
  };
  return (
    <>
      {strands.filter((x) => shown.some((c) => c.strand_id === x.strand_id)).map((x) => {
        const chs = shown.filter((c) => c.strand_id === x.strand_id);
        const open = isOpen(x.strand_id);
        return (
          <div key={x.strand_id} className="tree-strand">
            <button className="tree-branch tree-strand-name" aria-expanded={open} onClick={() => onToggle(x.strand_id)}>
              {arrow(x.strand_id)}<span className="tb-name">{x.name}<RollUpIcon r={rolls.st.get(x.strand_id)} /></span><span className="tb-meta">{meta(chs.flatMap((c) => byChapter.get(c.chapter_id)!))}</span>
            </button>
            {open && <div className="tree-kids">{chs.map(chapterEl)}</div>}
          </div>
        );
      })}
    </>
  );
}

/** U7: which groups are open, per topic and tab; collapsed by default; remembered. */
function useOpenGroups(topicId: string, tab: string) {
  const key = `cms.open.${topicId}.${tab}`;
  const [open, setOpenState] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]); } catch { return new Set(); } });
  const setOpen = useCallback((s: Set<string>) => { setOpenState(s); try { localStorage.setItem(key, JSON.stringify([...s])); } catch { /* best effort */ } }, [key]);
  useEffect(() => { try { setOpenState(new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[])); } catch { setOpenState(new Set()); } }, [key]);
  return [open, setOpen] as const;
}

function TopicView({ topic, review, chapter, r, go, reload, onOrder, onChanged }: { topic: TopicWithStats; review?: TopicReview; chapter?: Chapter; r: R; go: (p: Partial<R>) => void; reload: number; onOrder: (ids: string[]) => void; onChanged: () => void }) {
  // D5: the add / edit form open on this topic (one at a time)
  const [form, setForm] = useState<{ kind: Kind; id: string | null; fixed?: Record<string, unknown> } | null>(null);
  // 13 Nov 2026: add a question by hand or bulk-upload an Excel file (this topic only; no AI)
  const [adding, setAdding] = useState<'form' | 'upload' | null>(null);
  const edit = (kind: Kind, id: string | null, fixed?: Record<string, unknown>) => (e?: { stopPropagation: () => void }) => { e?.stopPropagation(); setForm({ kind, id, fixed }); };
  const [data, setData] = useState<Awaited<ReturnType<typeof topicData>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [setting, setSetting] = useState('all');
  const [nSources, setNSources] = useState<number | null>(null);
  const tab = r.tab === 'concepts' ? 'concepts' : 'types';
  const [open, setOpen] = useOpenGroups(topic.topic_id, tab);
  useEffect(() => {
    setError(null);
    topicData(topic.topic_id).then(setData).catch((e) => setError(e.message));
  }, [topic.topic_id, reload]);
  useEffect(() => { setNSources(null); chapterSourceCount(topic.chapter_id).then(setNSources).catch(() => setNSources(null)); }, [topic.chapter_id]);

  const sources = Object.entries(topic.source_flags ?? {}).map(([k, v]) => `${SOURCE_LABEL[k] ?? k.toUpperCase()} ${v}`).join(' · ');
  const s = topic.stats;
  const filtered = filters.difficulty !== 'all' || filters.status !== 'all' || filters.bank !== 'all' || (filters.flag ?? 'all') !== 'all';
  // D3: in class N, only questions whose level ≤ N (lower levels are revision here)
  const inClass = useMemo(() => (data ? data.questions.filter((q) => r.cls === 'all' || q.effective_level <= Number(r.cls)) : []), [data, r.cls]);
  const qs = useMemo(() => applyFilters(inClass, filters).filter((q) => setting === 'all' || (setting === 'none' ? !q.setting_id : q.setting_id === setting)), [inClass, filters, setting]);
  // D8c: clones sit together inside each pattern
  const { groups, clones } = useMemo(() => {
    const info = new Map<string, CloneInfo>();
    const gs = data ? groupBySet(qs, data.sets.filter((x) => x.topic_id === topic.topic_id).map((x) => x.typical_set_id)).map((g) => ({
      ...g, patterns: g.patterns.map((p) => { const c = cloneGroups(p.questions); c.info.forEach((v, k) => info.set(k, v)); return { ...p, questions: c.ordered }; }),
    })) : [];
    return { groups: gs, clones: info };
  }, [data, qs, topic.topic_id]);
  const nGroups = useMemo(() => new Set(inClass.filter((q) => q.bank === 'production' && !q.retired_at).map((q) => q.clone_key ?? `solo:${q.question_id}`)).size, [inClass]);
  const nRevision = r.cls === 'all' ? 0 : inClass.filter((q) => q.effective_level < Number(r.cls)).length;
  const hiddenHigher = r.cls === 'all' || !data ? 0 : data.questions.length - inClass.length;
  const settingsUsed = useMemo(() => (data ? [...data.settings.values()].sort((a, b) => a.name.localeCompare(b.name)) : []), [data]);
  const conceptGroups = useMemo(() => (data ? conceptLists(data, new Set(qs.map((q) => q.question_id))) : []), [data, qs]);

  // the display order (for ↓↑), and the group each question is in (to open it when selected)
  const lists = useMemo(() => (tab === 'types'
    ? groups.map((g) => ({ id: g.setId ?? 'none', ids: g.patterns.flatMap((p) => p.questions.map((q) => q.question_id)) }))
    : conceptGroups.map((g) => ({ id: g.concept.concept_id, ids: g.qs.map((x) => x.q.question_id) }))), [tab, groups, conceptGroups]);
  useEffect(() => { onOrder([...new Set(lists.flatMap((l) => l.ids))]); }, [lists, onOrder]);
  useEffect(() => () => onOrder([]), [onOrder]);
  useEffect(() => {
    if (!r.q) return;
    const home = lists.find((l) => l.ids.includes(r.q!));
    if (home && !open.has(home.id) && !lists.some((l) => open.has(l.id) && l.ids.includes(r.q!))) setOpen(new Set([...open, home.id]));
  }, [r.q, lists]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => { const n = new Set(open); if (n.has(id)) n.delete(id); else n.add(id); setOpen(n); };

  return (
    <>
      <div className="topic-head">
        <h1>{topic.topic_kind === 'achievers' ? topic.name : `${topic.topic_id} · ${topic.name}`}<ClassesPill classes={topic.classes} /></h1>
        <div className="small">
          <span className="chapter-name">Chapter {chapter ? `${chapter.chapter_id} · ${chapter.name}` : topic.chapter_id}</span>
          <span className="muted"> · Class {topic.class}
            {topic.topic_kind === 'achievers' ? ' · Achievers (chapter level)' : topic.taught_in_school ? ' · taught in school' : ' · not in NCERT / DAV'}
            {sources && ` · ${sources}`}</span>
        </div>
        <div className="muted small">
          {data ? `${data.sets.length} question type${data.sets.length === 1 ? '' : 's'} · ` : ''}{countsLabel(s)}
          {data && <> · <strong>{nGroups} clone group{nGroups === 1 ? '' : 's'}</strong></>}
          {nRevision > 0 && ` · ${nRevision} revision (lower level)`}
          {hiddenHigher > 0 && ` · ${hiddenHigher} above Class ${r.cls} not shown`}
          {topic.status !== 'active' && <strong> · {topic.status}</strong>}
        </div>
        <div className="small prereqs">Prerequisites: {!data ? '…' : data.prereqs.length === 0 ? <span className="muted">—</span>
          : data.prereqs.map((p, i) => <span key={p.prereq_topic_id}>{i > 0 && ' · '}<a href={browseHash({ subject: r.subject, cls: p.class ? String(p.class) : 'all', ch: p.chapter_id, topic: p.prereq_topic_id })}>{p.prereq_topic_id}{p.name ? ` ${p.name}` : ''}</a></span>)}</div>
        {topic.sub_skills && <div className="muted small subskills">Sub-skills: {topic.sub_skills.replace(/\s*;\s*\n?/g, '; ')}</div>}
        <ReviewControl topicId={topic.topic_id} review={review} onSaved={onChanged} />
      </div>

      <div className="curriculum-actions small">
        <button className="link" onClick={edit('topic', topic.topic_id)}>Edit topic</button>
        <button className="link" onClick={edit('typical_set', null, { topic_id: topic.topic_id })}>+ Question type</button>
        <button className="link" onClick={edit('pattern', null, { topic_id: topic.topic_id })}>+ Pattern</button>
        <button className="link" onClick={edit('concept', null, { topic_id: topic.topic_id })}>+ Concept</button>
        {topic.status === 'active' && <>
          <span className="sep" aria-hidden>|</span>
          <button className="link strong" onClick={() => setAdding(adding === 'form' ? null : 'form')}>+ Add question</button>
          <button className="link strong" onClick={() => setAdding(adding === 'upload' ? null : 'upload')}>Bulk upload (Excel)</button>
        </>}
      </div>
      {adding === 'form' && <AddQuestionForm topic={topic} onDone={(id) => { setAdding(null); if (id) { onChanged(); go({ q: id, v: null }); } }} />}
      {adding === 'upload' && <BulkUpload topic={topic} onDone={(changed) => { setAdding(null); if (changed) onChanged(); }} />}
      {form && <CurriculumForm key={`${form.kind}-${form.id}`} kind={form.kind} id={form.id} fixed={form.fixed}
        options={{ typical_set_id: (data?.sets ?? []).map((x) => [x.typical_set_id, `${x.typical_set_id} · ${x.name}`] as [string, string]) }}
        onDone={(saved) => { setForm(null); if (saved) onChanged(); }} />}

      <div role="tablist" className="tabs">
        <button role="tab" aria-selected={r.tab === 'types'} className={r.tab === 'types' ? 'on' : ''} onClick={() => go({ tab: 'types' })}>By question type</button>
        <button role="tab" aria-selected={r.tab === 'concepts'} className={r.tab === 'concepts' ? 'on' : ''} onClick={() => go({ tab: 'concepts' })}>
          By concept{data ? ` · ${data.concepts.length}` : ''}
        </button>
        <button role="tab" aria-selected={r.tab === 'sources'} className={r.tab === 'sources' ? 'on' : ''} onClick={() => go({ tab: 'sources' })}>
          Chapter sources{nSources !== null ? ` · ${nSources}` : ''}
        </button>
      </div>
      {r.tab === 'sources' ? <SourcesTab chapterId={topic.chapter_id} chapterName={chapter?.name ?? ''} cls={topic.class} topicId={topic.topic_id} /> : <>

      <div className="filters">
        <span className="muted small">Filter</span>
        <Select label="Difficulty" value={filters.difficulty} onChange={(v) => setFilters({ ...filters, difficulty: v })} options={[['all', 'Difficulty: all'], ['Simple', 'Simple'], ['Medium', 'Medium'], ['Complex', 'Complex']]} />
        <Select label="Status" value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} options={[['all', 'Status: all'], ['draft', 'Draft'], ['in_review', 'Needs review'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['retired', 'Retired']]} />
        <Select label="Bank" value={filters.bank} onChange={(v) => setFilters({ ...filters, bank: v })} options={[['all', 'Bank: all'], ['production', 'Production'], ['gold', 'Gold']]} />
        <Select label="Flags" value={filters.flag ?? 'all'} onChange={(v) => setFilters({ ...filters, flag: v as never })} options={FLAG_FILTERS} />
        {settingsUsed.length > 0 && <Select label="Setting" value={setting} onChange={setSetting}
          options={[['all', 'Setting: all'], ...settingsUsed.map((x) => [x.setting_id, x.name] as [string, string]), ['none', 'No setting yet']]} />}
        {data && <span className="muted small">{qs.length} of {inClass.length} shown</span>}
        <span className="spacer" />
        {data && lists.length > 0 && <>
          <button className="link small" onClick={() => setOpen(new Set(lists.map((l) => l.id)))}>Expand all</button>
          <button className="link small" onClick={() => setOpen(new Set())}>Collapse all</button>
        </>}
      </div>

      {error && <p className="error">Couldn't load this topic: {error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && r.tab === 'types' && (
        groups.length === 0 ? <p className="muted">No questions or question types for this topic yet.</p> : groups.map((g) => {
          const set = data.sets.find((x) => x.typical_set_id === g.setId);
          const main = data.setConcepts.filter((c) => c.typical_set_id === g.setId).sort((a) => (a.role === 'main' ? -1 : 1)).map((c) => c.concept_id);
          const id = g.setId ?? 'none';
          const all = g.patterns.flatMap((p) => p.questions);
          const shown = distinctTexts(all.map((q) => q.text));
          const same = sameWording(all.map((q) => q.text));
          const textOf = new Map(all.map((q, i) => [q.question_id, shown[i]!]));
          const sameOf = new Map(all.map((q, i) => [q.question_id, same[i]!]));
          return (
            <Group key={id} open={open.has(id)} onToggle={() => toggle(id)} summary={summarize(all)}
              title={g.setId ? <>{g.setId} · {set?.name ?? ''}<Proposed status={set?.status} /></> : 'No typical set'}
              extra={g.setId && <><a className="small fill-link" href={`#/generate?set=${encodeURIComponent(g.setId)}&topic=${encodeURIComponent(topic.topic_id)}`} onClick={(e) => e.stopPropagation()}>Fill gaps</a>
                <button className="link small" onClick={edit('typical_set', g.setId)}>Edit</button></>}
              sub={set && <>Class {set.class} · {set.parent_visible ? 'parent-visible' : 'hidden from parents'} · {set.status}
                {set.instruction_pattern && ` · "${set.instruction_pattern}"`}{main.length ? ` · concepts ${main.join(', ')}` : ''}
                {set.topic_id && set.topic_id !== topic.topic_id ? ` · set belongs to ${set.topic_id}` : ''}</>}>
              {g.count === 0 && <div className="muted small pad">No questions yet{filtered ? ' (with these filters)' : ''}.</div>}
              {g.patterns.map((p) => {
                const pat = data.patterns.find((x) => x.pattern_id === p.patternId);
                return (
                  <div key={p.patternId ?? 'none'}>
                    {(p.patternId || g.patterns.length > 1) && (
                      <div className="pattern-head small">{p.patternId ? <>{p.patternId} · {pat?.name ?? ''}<Proposed status={pat?.status} />{pat?.target_misconceptions?.length ? <span className="muted"> · targets {pat.target_misconceptions.join(', ')}</span> : null}
                        <button className="link small" onClick={edit('pattern', p.patternId)}>Edit</button></> : <span className="muted">No pattern</span>}</div>
                    )}
                    {p.questions.map((q, i) => {
                      const c = clones.get(q.question_id);
                      const first = c && c.size > 1 && c.index === 1 && i > 0 ? true : false;
                      return <div key={q.question_id}>
                        {c && c.size > 1 && c.index === 1 && <div className={`clone-head small ${first ? 'gap' : ''}`}>Clone group · {c.size} interchangeable</div>}
                        <QRow q={q} shown={textOf.get(q.question_id)} same={sameOf.get(q.question_id)} clone={c} setting={q.setting_id ? data.settings.get(q.setting_id)?.name : undefined}
                          revision={r.cls !== 'all' && q.effective_level < Number(r.cls) ? q.effective_level : undefined}
                          selected={q.question_id === r.q} onPick={() => go({ q: q.question_id, v: null, edit: false })} />
                      </div>;
                    })}
                  </div>
                );
              })}
            </Group>
          );
        })
      )}
      {data && r.tab === 'concepts' && (
        !data.concepts.length ? <p className="muted">No concepts defined for this topic yet.</p> : <>
          <p className="muted small involvement-note" title="How much each question uses the concept">Involvement: <strong>main</strong> 1.0 · <strong>secondary</strong> 0.5 · <strong>minor</strong> 0.2</p>
          {conceptGroups.map(({ concept: c, qs: list }) => {
            const shown = distinctTexts(list.map((x) => x.q.text));
            const same = sameWording(list.map((x) => x.q.text));
            return (
              <Group key={c.concept_id} open={open.has(c.concept_id)} onToggle={() => toggle(c.concept_id)} summary={summarize(list.map((x) => x.q))}
                title={<>{c.concept_id} · {c.name}<Proposed status={c.status} /><button className="link small" onClick={edit('concept', c.concept_id)}>Edit</button></>}
                sub={<>Class {c.class}{c.type ? ` · ${c.type}` : ''} · {c.status}{c.description ? ` · ${c.description}` : ''}</>}>
                {list.length === 0 ? <div className="muted small pad">No questions use this concept{qs.length < data.questions.length ? ' (with these filters)' : ''}.</div>
                  : list.map(({ q, inv }, i) => {
                    const lab = involvementOf(inv);
                    return <QRow key={q.question_id} q={q} shown={shown[i]} same={same[i]} selected={q.question_id === r.q} onPick={() => go({ q: q.question_id, v: null, edit: false })}
                      extra={<span className="inv" title={lab.title}>{lab.label} {Number(inv).toFixed(1)}</span>} />;
                  })}
              </Group>
            );
          })}
        </>
      )}
      </>}
    </>
  );
}

function conceptLists(data: Awaited<ReturnType<typeof topicData>>, visible: Set<string>) {
  const byVersion = new Map(data.questions.map((q) => [q.version_id, q]));
  return data.concepts.map((concept) => {
    const links = data.versionConcepts.filter((v) => v.concept_id === concept.concept_id && v.part_label === '');
    const qs = links.map((l) => ({ q: byVersion.get(l.version_id), inv: l.involvement }))
      .filter((x): x is { q: QuestionRow; inv: number } => !!x.q && visible.has(x.q.question_id))
      .sort((a, b) => b.inv - a.inv || a.q.question_id.localeCompare(b.q.question_id));
    return { concept, qs };
  });
}

/** U7: a collapsible block; the collapsed header keeps the summary. */
function Group({ open, onToggle, title, sub, extra, summary, children }: {
  open: boolean; onToggle: () => void; title: ReactNode; sub?: ReactNode; extra?: ReactNode; summary: ReturnType<typeof summarize>; children: ReactNode;
}) {
  return (
    <div className={`group ${open ? 'open' : 'closed'}`}>
      <div className="group-head" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
        <div className="group-title"><span className="caret" aria-hidden>{open ? '▾' : '▸'}</span>{title}{extra}</div>
        {sub && <div className="muted small">{sub}</div>}
        <div className="group-summary small">
          <strong>{summary.count} Q{summary.count === 1 ? '' : 's'}</strong>
          {summary.count > 0 && <> · <span className="muted">{mixLabel(summary)}</span>{statusCountsLabel(summary.byStatus) && <span className="muted"> · {statusCountsLabel(summary.byStatus)}</span>}</>}
        </div>
      </div>
      {open && children}
    </div>
  );
}

/** U15: "Classes 4 · 5 · 6" for a topic taught in several classes (teal: one colour per meaning). */
export function ClassesPill({ classes }: { classes: number[] }) {
  const l = classesLabel(classes);
  return l ? <span className="pill-multi" title="This topic is taught in several classes (D2)">{l}</span> : null;
}

function QRow({ q, shown, same, clone, setting, revision, selected, onPick, extra }: {
  q: QuestionRow; shown?: string; same?: number; clone?: CloneInfo; setting?: string; revision?: number; selected: boolean; onPick: () => void; extra?: ReactNode;
}) {
  return (
    <button className={`qrow ${selected ? 'sel' : ''}`} onClick={onPick} title={q.text}
      ref={selected ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
      <span className="qid mono">{q.question_id}</span>
      <span className="qtext">{shown ?? q.text}</span>
      {same && same > 1 ? <span className="tag same" title="These questions have exactly the same wording; they differ in the figure or the answer">same wording ×{same}</span>
        : clone?.nearIdentical ? <span className="tag same" title="A clone with the same wording apart from the numbers (kept; never removed)">near-identical</span> : null}
      {clone && clone.size > 1 && <span className="muted small nowrap" title="Clones: same pattern, signature and concepts">{clone.index} of {clone.size}</span>}
      {setting && <span className="tag setting" title="Setting (the story or context)">{setting}</span>}
      {revision !== undefined && <span className="tag revision" title={`Level ${revision}: revision in this class`}>Revision · L{revision}</span>}
      {q.bank === 'gold' && <span className="tag gold">Gold</span>}
      <OriginFlags q={q} compact />
      {extra && <span className="muted small">{extra}</span>}
      <span className={`lvl ${q.math_difficulty ?? ''}`}>{q.math_difficulty ?? '—'}</span>
      <span className={`qstatus small st-${q.retired_at ? 'retired' : q.status}`}>{statusLabel(q)}</span>
    </button>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="filter">
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={value !== 'all' ? 'active' : ''}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}


// Science topic and chapter views. Layout (Sambit, 14 Nov 2026): tree | content | questions, no fourth column.
//   Middle: content rows in MASTER ORDER (not grouped by type, no filters); a row opens IN PLACE (one at a time)
//           with every field of its detail card. Chapter view: rows under collapsible topic headers.
//   Right:  no row → all questions · row → "For row <ID>": DIRECT then SUPPORTING · question → its detail with "← Back".
// Content rows are read-only here. Selected topic, row and question live in the URL hash.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Id } from './Id';
import { SCIENCE_QUESTION_TYPES } from '../../shared/types.ts';
import { LevelTag, RowClassTag } from './Tags';
import { AddQuestionForm, OriginFlags } from './AddQuestions';
import { ContentRowForm } from './ContentRowForm';
import { rowDetail, scienceData, type ScienceData, type ScienceQuestion, type ScienceRow } from './scienceApi';
import { clamp, Handle } from './Handle';
import { ItemDecide, PrimaryDecide, TopicClassDecide } from './Proposals';
import { pendingItems } from './reviewApi';
import { ImageRunBar } from './ImageRun';
import { browseHash, showsAtLevel, statusLabel } from './logic';
import { sciFilter, SCI_FILTER_NONE, type SciFilter } from './scienceLogic';
import { classesLine, isDimmed, listedOrder, rightPane, rowClassLine, rowQuestions, rowsForClass, rowsInOrder, rowSplit, rowSplitLabel, topicGroups } from './scienceLogic';
import { PFILTERS, primaryOf, questionState, rowState, walkOrder, walkQuestions, walkStep, type PFilter, type WalkTopic } from './scienceLogic';
import { mainRowLook, proposedPrimariesOn, writersPick } from './scienceLogic';
import { decidePrimary, currentVersion } from './reviewApi';

export const CONTENT_TYPES = ['Fact', 'Concept', 'How it works', 'Experiment', 'Scenario-Case', 'Diagram', 'Vocabulary'] as const;
const STATUS: Record<ScienceRow['status'], { icon: string; label: string; cls: string }> = {
  direct: { icon: '✓', label: 'has questions', cls: 'ok' },
  supporting: { icon: '✓', label: 'supporting only', cls: 'sup' },
  not_eligible: { icon: '○', label: 'not eligible', cls: 'ne' },
  none: { icon: '⚠', label: 'none yet', cls: 'none' },
};
const TIERS = ['L1', 'L2', 'L3'] as const;
const typeSlug = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, '-');

/** "6 with direct questions · 1 supporting only · 4 not eligible · 40 none yet" + questions by tier. */
export function Coverage({ rows, questions, cls = 'all' }: { rows: ScienceRow[]; questions: ScienceQuestion[]; /** Q11: the class viewed, for the "+ N above class" split */ cls?: string }) {
  const n = (s: ScienceRow['status']) => rows.filter((r) => r.status === s).length;
  const live = questions.filter((q) => !q.retired_at && q.bank === 'production');
  return (
    <div className="sci-coverage small">
      <span><strong>{rowSplitLabel(rowSplit(rows, cls))}</strong> content rows:</span>
      <span className="cov ok">✓ {n('direct')} with direct questions</span>
      <span className="cov sup">✓ {n('supporting')} supporting only</span>
      <span className="cov ne">○ {n('not_eligible')} not eligible</span>
      <span className="cov none">⚠ {n('none')} none yet</span>
      <span className="sep" aria-hidden>|</span>
      {/* Q27 (0041): L1–L3 is the retired authored tier (legacy); Q26: the Science question type, once set */}
      <span><strong>{live.length}</strong> question{live.length === 1 ? '' : 's'}: {live.some((q) => q.science_question_type) ? `typed ${live.filter((q) => q.science_question_type).length} · untyped ${live.filter((q) => !q.science_question_type).length} · ` : 'untyped · '}
        <span className="muted" title="The authored L1–L3 tier is retired (Q27); kept read-only">old tier {TIERS.map((t) => `${t} ${live.filter((q) => q.level_tier === t).length}`).join(' · ')}
        {live.some((q) => !q.level_tier) ? ` · none ${live.filter((q) => !q.level_tier).length}` : ''}</span></span>
    </div>
  );
}

export function ScienceView({ scope, cls, higher = false, topicNames, row, q, onRow, onQuestion, onBack, onOrder, reload, detail, walk }: {
  scope: { topicId: string } | { chapterId: string }; cls: string; /** Q1: also questions above the class */ higher?: boolean;
  /** the topics to show, in their order (chapter view keeps topics without rows) */ topicNames: Map<string, { name: string; no: string | null }>;
  row: string | null; q: string | null; onRow: (row: string | null) => void; onQuestion: (id: string) => void; onBack: () => void;
  onOrder: (ids: string[]) => void; reload: number; /** the question detail shown in the right column when q is set */ detail: ReactNode;
  /** Q38 PR 4 (b): Previous / Next through the whole chapter (its topics in order); a step may open another topic */
  walk?: { chapterId: string; /** the topics the tree shows, in order, each with its class ceiling */ topics: WalkTopic[]; /** Show higher-level questions */ higher: boolean;
    onGo: (topicId: string, questionId: string) => void };
}) {
  const [data, setData] = useState<ScienceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = 'topicId' in scope ? scope.topicId : scope.chapterId;
  const chapterMode = 'chapterId' in scope;
  const [closed, setClosed] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(`cms.sci.topics.${key}`) ?? '[]') as string[]); } catch { return new Set(); } });
  const toggle = (k: string) => { const n = new Set(closed); if (n.has(k)) n.delete(k); else n.add(k); setClosed(n); try { localStorage.setItem(`cms.sci.topics.${key}`, JSON.stringify([...n])); } catch { /* best effort */ } };
  const [tick, setTick] = useState(0);
  /** Q15: "+ Add question" on an open row: the right column shows the add form for that row */
  const [addFor, setAddFor] = useState<ScienceRow | null>(null);
  /** Q14: the row form in the right column: a new row (row undefined) or edit an open row */
  const [rowForm, setRowForm] = useState<{ row?: ScienceRow } | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  // Q38 PR 4 (e): All · Proposed · Approved · Rejected (rows and questions; default All)
  const [pf, setPf] = useState<PFilter>('all');
  const [pending, setPending] = useState<Set<string>>(new Set());
  // Q38 PR 4 (a): the content pane's width, remembered (null = the default split)
  const [split, setSplitState] = useState<number | null>(() => { try { const v = localStorage.getItem('cms.sci.split'); return v ? Number(v) : null; } catch { return null; } });
  const setSplit = (w: number | null) => { setSplitState(w); try { if (w === null) localStorage.removeItem('cms.sci.split'); else localStorage.setItem('cms.sci.split', String(Math.round(w))); } catch { /* best effort */ } };
  const contentRef = useRef<HTMLElement>(null);
  useEffect(() => { setError(null); scienceData(scope).then(setData).catch((e) => setError(e.message)); }, [key, reload, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (data) pendingItems(data.rows.map((r) => r.row_id)).then(setPending).catch(() => setPending(new Set())); }, [data]);
  useEffect(() => { if (addFor && row !== addFor.row_id) setAddFor(null); }, [row]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (rowForm?.row && row !== rowForm.row.row_id) setRowForm(null); }, [row]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rows written for class N show in class N and above (as questions do, D3); lower-class rows are marked.
  // Q14: retired rows are kept but hidden unless asked for
  const live = useMemo(() => (data?.rows ?? []).filter((r) => showRetired || pf === 'rejected' || !r.retired_at)
    .filter((r) => pf === 'all' || rowState(r, pending) === pf), [data, showRetired, pf, pending]);
  const nRetired = (data?.rows ?? []).filter((r) => r.retired_at).length;
  const rows = useMemo(() => rowsInOrder(rowsForClass(live, cls, higher)), [live, cls, higher]);
  const hidden = live.length - rows.length;
  const ceiling = cls === 'all' ? null : Number(cls);
  const qsAll = useMemo(() => (data?.questions ?? []).filter((x) => showsAtLevel(x.effective_level, ceiling, higher)), [data, ceiling, higher]);
  // Q34: Science question type / tier / markers filters (narrow the question lists; the coverage line counts all)
  const [sf, setSf] = useState<SciFilter>(SCI_FILTER_NONE);
  // 25 Nov 2026: why a question's main row needs a look (amber); [] = plain "Main row: …" and Approve confirms it
  const lookOf = useMemo(() => new Map((data?.questions ?? []).map((x) => [x.question_id, mainRowLook(x, data!.rowFacts, data!.genWarnings.get(x.question_id))])), [data]);
  const [lookOnly, setLookOnly] = useState(false);
  const qs = useMemo(() => sciFilter(qsAll, sf).filter((x) => (pf === 'all' || questionState(x) === pf) && (!lookOnly || (lookOf.get(x.question_id) ?? []).length > 0)),
    [qsAll, sf, pf, lookOnly, lookOf]);
  const order = useMemo(() => listedOrder(qs, row), [qs, row]);
  useEffect(() => { onOrder(order); }, [order, onOrder]);
  useEffect(() => () => onOrder([]), [onOrder]);
  const groups = useMemo(() => topicGroups(rows, [...topicNames.keys()]), [rows, topicNames]);

  if (error) return <p className="error">Couldn't load the content rows: {error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const selRow = row ? data.rows.find((r) => r.row_id === row) ?? null : null;
  const inScope = (id: string) => data.rows.some((x) => x.row_id === id);
  const list = (rs: ScienceRow[]) => (
    <ol className="sci-list">
      {rs.map((r, i) => <RowItem key={r.row_id} n={i + 1} r={r} cls={cls} state={rowState(r, pending)} proposedHere={proposedPrimariesOn(r.row_id, data.questions).filter((x) => !(lookOf.get(x.question_id) ?? []).length)}
        flaggedHere={proposedPrimariesOn(r.row_id, data.questions).filter((x) => (lookOf.get(x.question_id) ?? []).length).length} onConfirmed={() => setTick((t) => t + 1)} open={r.row_id === row} onPick={() => onRow(r.row_id === row ? null : r.row_id)} inScope={inScope} onRow={onRow}
        onAdd={() => { setRowForm(null); setAddFor(r); onBack(); }} onEdit={() => { setAddFor(null); setRowForm({ row: r }); onBack(); }} />)}
    </ol>
  );
  const pane = rightPane(row, q, chapterMode ? 'chapter' : 'topic');
  const where = chapterMode ? 'chapter' : 'topic';

  return (
    <div className="sci">
      {/* PR 4b (Sambit, 24 Nov 2026): one compact row: filters, then the proposal filter, then the topic summary behind (i) */}
      <div className="sci-bar small">
        <select aria-label="Science question type" className={sf.type ? 'active' : ''} value={sf.type} onChange={(e) => setSf({ ...sf, type: e.target.value })}>
          <option value="">Type: any</option><option value="none">Type: not set</option>
          {(Object.entries(SCIENCE_QUESTION_TYPES) as [string, string][]).map(([k, l]) => <option key={k} value={k}>Type {k} · {l}</option>)}</select>
        <select aria-label="Tier" className={sf.tier ? 'active' : ''} value={sf.tier} onChange={(e) => setSf({ ...sf, tier: e.target.value })}>
          <option value="">Tier: any</option><option value="none">Tier: none (no type)</option>{['School', 'Achiever', 'Super Achiever'].map((t) => <option key={t} value={t}>{t}</option>)}</select>
        <select aria-label="Markers" className={sf.markers ? 'active' : ''} value={sf.markers} onChange={(e) => setSf({ ...sf, markers: e.target.value })}>
          <option value="">Markers: any</option>{['0', '1', '2', '3+'].map((m) => <option key={m} value={m}>{m} marker{m === '1' ? '' : 's'}</option>)}</select>
        {(sf.type || sf.tier || sf.markers) && <span><span className="muted">{qs.length} of {qsAll.length}</span> <button className="link small" onClick={() => setSf(SCI_FILTER_NONE)}>Clear</button></span>}
        <span className="pfilter" role="group" aria-label="Show proposals" title="Rows, links and questions: Proposed = waiting for a decision (Needs review, a proposed primary, an item to review) · Rejected = rejected or retired">
          {PFILTERS.map(([v, l]) => <button key={v} className={`pill small ${pf === v ? 'on' : ''}`} aria-pressed={pf === v} onClick={() => setPf(v)}>{l}</button>)}</span>
        <button className={`pill small ${lookOnly ? 'on' : ''}`} aria-pressed={lookOnly} onClick={() => setLookOnly(!lookOnly)}
          title="Questions whose main row is in another topic, above the question's Level, or has a checker warning about the row choice">
          Main row needs a look · {qsAll.filter((x) => (lookOf.get(x.question_id) ?? []).length).length}</button>
        <InfoPop label={`Summary of this ${chapterMode ? 'chapter' : 'topic'}`}
          attention={rows.some((r) => !r.retired_at && r.status === 'none') || qsAll.some((x) => !x.retired_at && x.bank === 'production' && !x.science_question_type) || pending.size > 0}
          attentionText={[rows.some((r) => !r.retired_at && r.status === 'none') ? 'content rows with no question yet' : null,
            qsAll.some((x) => !x.retired_at && x.bank === 'production' && !x.science_question_type) ? 'questions without a type' : null,
            pending.size > 0 ? 'misconception items to review' : null].filter(Boolean).join(' · ')}>
          <Coverage rows={rows.filter((r) => !r.retired_at)} questions={qsAll} cls={cls} />
        </InfoPop>
      </div>
      {'topicId' in scope && <TopicClassDecide topicId={scope.topicId} />}
      <ImageRunBar scope={scope} onChanged={() => setTick((t) => t + 1)} />
      <div className={`sci-cols split ${split !== null ? 'sized' : ''}`} style={split !== null ? { '--sci-left': `${split}px` } as CSSProperties : undefined}>
        <section className="sci-content" aria-label="Content rows" ref={contentRef}>
          <div className="eyebrow sci-content-head"><span>Content · master order{hidden > 0 ? <span className="muted"> · {hidden} row{hidden === 1 ? '' : 's'} of a higher class not shown (tick "Show higher-level questions")</span> : null}</span>
            {nRetired > 0 && <button className="link small" onClick={() => setShowRetired(!showRetired)}>{showRetired ? 'Hide' : 'Show'} retired ({nRetired})</button>}
            {!chapterMode && <button className="secondary small" onClick={() => { setAddFor(null); onRow(null); setRowForm({}); onBack(); }}>+ Add content row</button>}</div>
          {!chapterMode ? (rows.length ? list(rows) : <p className="muted small">No content rows for this topic yet.</p>)
            : groups.map((g) => {
              const t = topicNames.get(g.topic_id);
              const open = !closed.has(g.topic_id) || g.rows.some((r) => r.row_id === row);
              const nq = qs.filter((x) => x.topic_id === g.topic_id).length;
              return (
                <div key={g.topic_id} className={`sci-topic ${open ? 'open' : ''}`}>
                  <button className="sci-topic-head" aria-expanded={open} onClick={() => toggle(g.topic_id)}>
                    <span className="caret" aria-hidden>{open ? '▾' : '▸'}</span>
                    <span className="sci-topic-name">{t?.no ? `${t.no} ` : ''}{t?.name ?? g.topic_id} <Id>{g.topic_id}</Id></span>
                    <span className="muted small">{g.rows.length ? `${g.rows.length} row${g.rows.length === 1 ? '' : 's'}` : 'no content rows'} · {nq} question{nq === 1 ? '' : 's'}</span>
                  </button>
                  {open && (g.rows.length ? list(g.rows) : <p className="muted small sci-empty">no content rows</p>)}
                </div>
              );
            })}
        </section>
        <Handle side="sci" onDrag={(dx) => setSplit(clamp((split ?? contentRef.current?.getBoundingClientRect().width ?? 600) + dx, 320, 1200))} onReset={() => setSplit(null)} />
        <section className="sci-questions" aria-label={pane.kind === 'detail' ? 'Question detail' : 'Questions'}>
          {rowForm && !q && 'topicId' in scope ? <>
            <div className="sci-q-head sci-detail-nav"><button className="link" onClick={() => setRowForm(null)}>← Back{rowForm.row ? ` to row ${rowForm.row.row_id}` : ''}</button></div>
            <ContentRowForm key={rowForm.row?.row_id ?? 'new'} topic={{ topic_id: scope.topicId, name: topicNames.get(scope.topicId)?.name ?? scope.topicId }}
              defaultClass={cls === 'all' ? (data.rows[0]?.row_class ?? 6) : Number(cls)} row={rowForm.row}
              onDone={(id) => { setRowForm(null); setTick((t) => t + 1); if (id) onRow(id); }} />
          </> : rowForm && !q && rowForm.row ? <>
            <div className="sci-q-head sci-detail-nav"><button className="link" onClick={() => setRowForm(null)}>← Back to row {rowForm.row.row_id}</button></div>
            <ContentRowForm key={rowForm.row.row_id} topic={{ topic_id: rowForm.row.topic_id, name: topicNames.get(rowForm.row.topic_id)?.name ?? rowForm.row.topic_id }}
              defaultClass={rowForm.row.row_class} row={rowForm.row} onDone={(id) => { setRowForm(null); setTick((t) => t + 1); if (id) onRow(id); }} />
          </> : addFor && !q ? <>
            <div className="sci-q-head sci-detail-nav"><button className="link" onClick={() => setAddFor(null)}>← Back to row {addFor.row_id}</button></div>
            <AddQuestionForm key={addFor.row_id} topic={{ topic_id: addFor.topic_id, name: topicNames.get(addFor.topic_id)?.name ?? addFor.topic_id, class: addFor.row_class, chapter_id: addFor.chapter_id }}
              prefill={{ level: addFor.row_class, row_id: addFor.row_id }}
              onDone={(id) => { setAddFor(null); setTick((t) => t + 1); if (id) onQuestion(id); }} />
          </> : pane.kind === 'detail' ? <>
            <div className="sci-q-head sci-detail-nav">
              <button className="link" onClick={onBack}>{pane.back}</button>
              {walk && <WalkBar walk={walk} q={pane.q} reload={reload + tick} />}
              <a className="small" href={`#/q/${encodeURIComponent(pane.q)}`}>Open full page ↗</a>
            </div>
            <div className="sci-q-detail">{detail}</div>
          </> : pane.kind === 'row' ? (() => {
            const s = rowQuestions(qs, pane.row);
            return <>
              <div className="sci-q-head">
                <div className="eyebrow">Questions</div>
                <div className="sci-for-row"><strong>For row {pane.row}</strong>{' '}
                  <button className="link small" onClick={() => onRow(null)}>show all {qs.length} in {where}</button></div>
                {selRow && <div className="muted small sci-for-text">{selRow.content.length > 110 ? `${selRow.content.slice(0, 110)}…` : selRow.content}</div>}
              </div>
              <QSection title="Direct" hint="tests this row (primary or secondary)" items={s.direct} rowId={pane.row} q={q} ceiling={ceiling} onQuestion={onQuestion} onDone={() => setTick((t) => t + 1)} lookOf={lookOf}
                empty={selRow && selRow.question_use !== 'OK' ? `No questions: this row is "${selRow.question_use}".` : 'No question tests this row yet.'} />
              <QSection title="Supporting" hint="uses it as background" items={s.supporting} q={q} ceiling={ceiling} onQuestion={onQuestion} onDone={() => setTick((t) => t + 1)} lookOf={lookOf} empty="None." />
            </>;
          })() : <>
            <div className="sci-q-head">
              <div className="eyebrow">Questions · {qs.length}</div>
              <div className="small muted">All for this {where} · open a content row to narrow</div>
            </div>
            {qs.length === 0 ? <p className="muted small sci-empty">No questions yet.</p>
              : chapterMode ? [...topicNames.keys()].filter((tid) => qs.some((x) => x.topic_id === tid)).map((tid) => (
                <div key={tid}><div className="sci-q-topic small">{topicNames.get(tid)?.name ?? tid} <Id>{tid}</Id></div>
                  {order.map((id) => qs.find((x) => x.question_id === id)!).filter((x) => x.topic_id === tid).map((x) => <QItem key={x.question_id} q={x} ceiling={ceiling} showPrimary look={lookOf.get(x.question_id) ?? []} selected={x.question_id === q} onPick={() => onQuestion(x.question_id)} onDone={() => setTick((t) => t + 1)} />)}</div>))
              : order.map((id) => qs.find((x) => x.question_id === id)!).map((x) => <QItem key={x.question_id} q={x} ceiling={ceiling} showPrimary look={lookOf.get(x.question_id) ?? []} selected={x.question_id === q} onPick={() => onQuestion(x.question_id)} onDone={() => setTick((t) => t + 1)} />)}
          </>}
        </section>
      </div>
    </div>
  );
}

function QSection({ title, hint, items, rowId, q, ceiling, onQuestion, onDone, empty, lookOf }: { title: string; hint: string; items: ScienceQuestion[]; /** 0035: show each question's rank for this row */ rowId?: string; q: string | null; ceiling: number | null; onQuestion: (id: string) => void; onDone: () => void; empty: string; lookOf: Map<string, string[]> }) {
  return (
    <div className="sci-q-section">
      <div className="sci-q-section-head"><span className="eyebrow">{title} · {items.length}</span> <span className="muted small">{hint}</span></div>
      {items.length ? items.map((x) => <QItem key={x.question_id} q={x} rowId={rowId} ceiling={ceiling} look={lookOf.get(x.question_id) ?? []} selected={x.question_id === q} onPick={() => onQuestion(x.question_id)} onDone={onDone} />) : <p className="muted small sci-empty">{empty}</p>}
    </div>
  );
}

function RowItem({ n, r, cls, open, onPick, inScope, onRow, onAdd, onEdit, state, proposedHere, flaggedHere, onConfirmed }: { n: number; r: ScienceRow; cls: string; open: boolean; onPick: () => void; inScope: (id: string) => boolean; onRow: (id: string) => void; onAdd: () => void; onEdit: () => void;
  /** Q38 PR 4 (e) */ state: 'proposed' | 'approved' | 'rejected';
  /** 25 Nov: open questions whose main row here is still proposed (no reason to look) / those that need a look */ proposedHere: ScienceQuestion[]; flaggedHere: number; onConfirmed: () => void }) {
  const s = STATUS[r.status];
  return (
    <li className={`sci-row ${open ? 'sel open' : ''} ${isDimmed(r) ? 'dim' : ''} ${r.in_master ? '' : 'gone'} pstate-row ${state}`} ref={open ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
      <button className="sci-row-head" onClick={onPick} aria-expanded={open}>
        <span className="sci-row-no" aria-label={`Row ${n}`}>{n}</span>
        <span className="sci-row-body">
          <span className="sci-row-tags small">
            <span className={`tag type type-${typeSlug(r.type)}`} title="Type">{r.type}</span>
            {r.chapter_role && <span className={`tag role-${r.chapter_role.toLowerCase()}`} title="Chapter role">{r.chapter_role}</span>}
          </span>
          <span className="sci-row-text">{r.content}</span>
          <span className="sci-row-meta small">
            <span className={`cov ${s.cls}`} title={`Row status: ${s.label}`}>{s.icon} {s.label}</span>
            <span className="muted" title="Links from questions to this row; one question can be linked to several rows">&nbsp;· {r.n_direct} direct link{r.n_direct === 1 ? '' : 's'} · {r.n_supporting} supporting link{r.n_supporting === 1 ? '' : 's'}</span>
            <RowClassTag rowClass={r.row_class} cls={cls} />
            <RowTags r={r} />
            {r.retired_at && <span className="tag gone" title={r.retired_reason ?? undefined}>Retired</span>}
            {r.source === 'CMS' && <span className="tag" title="Added in the CMS (the master); no originality check: own writing">CMS</span>}
            <Id>{r.row_id}</Id>
          </span>
        </span>
      </button>
      {(proposedHere.length > 0 || flaggedHere > 0) && <RowPrimaries rowId={r.row_id} qs={proposedHere} flagged={flaggedHere} onDone={onConfirmed} />}
      {/* T2 (17 Nov 2026): the row's actions sit at the top of its details */}
      {open && <div className="sci-add-row sci-add-top">
        {r.question_use !== 'No questions' && !r.retired_at && <><button className="secondary" onClick={onAdd}>+ Add question</button>
          <span className="muted small"> from this row: Level {r.row_class} (row class), linked direct · primary</span></>}
        <button className="link small sci-edit-row" onClick={onEdit}>{r.retired_at ? 'Restore row…' : 'Edit row'}</button></div>}
      {open && <RowDetail r={r} inScope={inScope} onRow={onRow} />}
    </li>
  );
}

/** The row's flags: question use, Claude-added, Safety, Time-sensitive, Accuracy, Originality, Not in master. */
function RowTags({ r }: { r: ScienceRow }) {
  return <>
    {r.question_use !== 'OK' && <span className="tag use">{r.question_use}</span>}
    {r.source === 'Claude-added' && <span className="tag claude" title="Not in the books: added by Claude">Claude-added</span>}
    {r.safety && <span className="tag safety" title={r.safety}>Safety</span>}
    {r.time_sensitive && <span className="tag time" title={`Checked ${r.time_checked_year ?? '?'}: questions must say "as of ${r.time_checked_year ?? 'year'}"`}>Time-sensitive {r.time_checked_year ?? ''}</span>}
    {r.accuracy_flag && <span className="tag accuracy" title="The notes correct a book's statement (ACCURACY)">Accuracy</span>}
    {r.originality_result === 'near_copy' && <span className="tag flagged" title={`Originality: ${r.originality_field} is ${r.originality_score} similar to ${r.originality_ref}${r.originality_override ? ` · override requested: ${r.originality_override}` : ''}`}>Originality flagged</span>}
    {!r.in_master && <span className="tag gone" title="This row is no longer in the Science master; kept, never deleted">Not in master</span>}
  </>;
}

/** The open row's fields (the 0033 detail card), shown in place under the row. Empty fields are hidden. */
function RowDetail({ r, inScope, onRow }: { r: ScienceRow; inScope: (id: string) => boolean; onRow: (id: string) => void }) {
  const [d, setD] = useState<Awaited<ReturnType<typeof rowDetail>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [itemsTick, setItemsTick] = useState(0);
  useEffect(() => { setErr(null); rowDetail(r).then(setD).catch((e) => setErr(e.message)); }, [r.row_id, itemsTick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setD(null); }, [r.row_id]);
  const cl = classesLine(r.topic_classes_mapped, d ? d.classes : null);
  const F = ({ label, children }: { label: string; children: ReactNode }) => <div className="sci-f"><div className="sci-f-l">{label}</div><div className="sci-f-v">{children}</div></div>;
  const book = [r.book, r.book_chapter_no !== null ? `Ch ${r.book_chapter_no}${r.book_chapter_title ? ` ${r.book_chapter_title}` : ''}` : r.book_chapter_title].filter(Boolean).join(' · ');
  return (
    <div className="sci-detail" aria-label={`Details of ${r.row_id}`}>
      {r.why_it_matters && <F label="Why it matters / real-life link">{r.why_it_matters}</F>}
      {r.misconceptions && <F label="Common misconceptions">
        {d && d.items.length > 0 ? <ol className="plain sci-items">{d.items.map((i) => (
          <li key={i.item_no} className={i.status === 'retired' ? 'pstate-item rejected' : i.status === 'needs_review' ? 'pstate-item proposed' : ''}><span className="mono muted">#{i.item_no}</span> {i.text}
            {i.status === 'needs_review' && <span className="tag proposed" title={i.proposed_by ? `Proposed from ${i.proposed_by}` : undefined}>Needs review</span>}
            {i.status === 'retired' && <span className="pstate-tag">Rejected</span>}
            <ItemDecide rowId={r.row_id} itemNo={i.item_no} status={i.status} onDone={() => setItemsTick((t) => t + 1)} />
            {i.unclear && <span className="tag mismatch" title={i.split_note ?? ''}>Split unclear</span>}
            <span className="mono muted small"> {r.row_id} #{i.item_no}</span></li>))}</ol>
          : r.misconceptions}
      </F>}
      {r.diagram_description && <F label="Diagram description">{r.diagram_description}</F>}
      {/* "Topic class (mapped)" empty or "–" (DAV-only rows): still shown, as "none"; never a Class mismatch */}
      <F label="Classes">{cl.text}
        {cl.mismatch.length > 0 && <span className="tag mismatch" title={`Master names class ${cl.mismatch.join(', ')}, which this topic is not linked to. Nothing is changed.`}>Class mismatch</span>}</F>
      {r.topic_taught_in && <F label="Also taught in">{r.topic_taught_in}</F>}
      {/* Q12: the Revisit line is replaced by the row's class and the topic's home class (the master's Revisit text stays as the tooltip) */}
      <F label="Row class"><span title={r.revisit ? `Master "Revisit": ${r.revisit}` : undefined}>{rowClassLine(r.row_class, d ? d.homeClass : null)}</span></F>
      {r.also_in_rows.length > 0 && <F label="Also in">
        {(d?.alsoIn ?? r.also_in_rows.map((id) => ({ row_id: id, at: null }))).map((x, i) => <span key={x.row_id}>{i > 0 && ' · '}
          {inScope(x.row_id) ? <button className="link" onClick={() => onRow(x.row_id)} title={x.at?.content}>{x.row_id}</button>
            : x.at ? <a href={browseHash({ subject: 'science', cls: 'all', ch: x.at.chapter_id, topic: x.at.topic_id, tab: 'content', row: x.row_id })} title={x.at.content}>{x.row_id}</a>
            : <span className="muted">{x.row_id}</span>}</span>)}
      </F>}
      {(r.source || r.found_in) && <F label="Source / Found in">{[r.source, r.found_in].filter(Boolean).join(' · ')}{r.confidence ? <span className="muted small"> · confidence {r.confidence}</span> : null}</F>}
      {(book || r.appears_in || (d?.citations.length ?? 0) > 0) && <F label="Citation">
        {book && <div><span className="muted">Filed under:</span> {book}</div>}
        {r.appears_in && <div className="muted small">{r.appears_in}</div>}
        {d?.citations.map((c, i) => <div key={i} className="small">{d.sources.get(c.source_id) ?? c.source_id} · {c.raw}</div>)}
      </F>}
      {r.notes && <F label="Notes">{r.notes}</F>}
      {err && <p className="error small">Couldn't load the citations and classes: {err}</p>}
    </div>
  );
}

function QItem({ q, rowId, ceiling, selected, onPick, showPrimary, onDone, look }: { q: ScienceQuestion; rowId?: string; /** the class being viewed (null = all) */ ceiling: number | null; selected: boolean; onPick: () => void;
  /** Q38 PR 4 (c): no row selected: each question's primary row and its state */ showPrimary?: boolean; onDone: () => void; /** 25 Nov: why its main row needs a look */ look: string[] }) {
  const nd = q.links.filter((l) => l.role === 'direct').length, ns = q.links.length - nd;
  const here = rowId ? q.links.find((l) => l.row_id === rowId) : undefined;
  const p = primaryOf(q);
  const open = q.status === 'draft' || q.status === 'in_review';
  // (d): the primary decided in place (open versions only); a row list shows it on the row's own chip
  // 25 Nov 2026 (Sambit): every generated question has a proposed main row, and Approve confirms it. So the amber chip with
  // Confirm / Change / Reject shows ONLY when there is a reason to look (`look`) or a rejected main row waits for Undo;
  // otherwise plain "Main row: <row> · Change" (type 4–5 generated: "· writer's pick", neutral grey).
  const primaryChip = (rid: string, state: 'confirmed' | 'proposed' | 'rejected') => {
    if (open && !q.retired_at && (state === 'rejected' || (state === 'proposed' && look.length)))
      return <span title={look.length ? `Main row needs a look: ${look.join('; ')}` : undefined}><PrimaryDecide questionId={q.question_id} rowId={rid} state={state} onChange={onPick} onDone={onDone} /></span>;
    return <span className={`main-row ${look.length ? 'look' : ''}`} title={look.length ? `Main row needs a look: ${look.join('; ')}` : state === 'proposed' ? 'Proposed by the generator; Approve confirms it' : 'Confirmed main row'}>
      Main row: {rid}{writersPick(q) && <span className="muted"> · writer's pick</span>}{look.length > 0 && <span> · needs a look</span>}
      {open && !q.retired_at && <> · <button type="button" className="link small" onClick={(e) => { e.stopPropagation(); onPick(); }}>Change</button></>}</span>;
  };
  return (
    <div role="button" tabIndex={0} className={`qrow sci-qrow pstate-q ${questionState(q)} ${selected ? 'sel' : ''}`} onClick={onPick} onKeyDown={(e) => { if (e.key === 'Enter') onPick(); }} title={q.text} ref={selected ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
      <span className="qtext">{q.text}</span>
      <span className="sci-q-meta small">
        {q.science_question_type ? <span className="tag tier" title={`Science question type ${q.science_question_type} · ${SCIENCE_QUESTION_TYPES[q.science_question_type as 1]}`}>Type {q.science_question_type}{q.tier ? ` · ${q.tier}` : ''}</span>
          : q.level_tier && <span className="muted" title="Old tier (legacy, retired): the type is not set yet">{q.level_tier}</span>}
        {(q.markers ?? 0) > 0 && <span className="muted" title="Markers (Q29)">{q.markers} marker{q.markers === 1 ? '' : 's'}</span>}
        <LevelTag q={q} ceiling={ceiling} />
        {here && here.rank === 'primary' && primaryChip(here.row_id, here.rank_proposed ? 'proposed' : 'confirmed')}
        {here && here.rank === 'secondary' && (here.primary_rejected ? primaryChip(here.row_id, 'rejected') : <span className="tag rank-secondary" title="This row's rank for the question">Secondary</span>)}
        {showPrimary && (p.row_id ? primaryChip(p.row_id, p.state as 'confirmed' | 'proposed' | 'rejected') : <span className="muted">Primary · none</span>)}
        <span className="muted">{nd} direct{ns ? ` · ${ns} supporting` : ''}</span>
        {q.display_format && <span className="muted">{q.display_format}</span>}
        {q.safety_note && <span className="tag safety" title={q.safety_note}>Safety</span>}
        <OriginFlags q={q} compact />
        <span className={`qstatus st-${q.retired_at ? 'retired' : q.status}`}>{statusLabel(q)}</span>
        <Id>{q.question_id}</Id>
      </span>
    </div>
  );
}

/** Q38 PR 4 (b): Previous / Next through the whole chapter in master order (topic → content row → question, each question
 *  once at its primary row), crossing topics, stopping at the chapter's end. "12 / 87" · keys ← / → · only Needs review. */
const walkCache = new Map<string, Promise<ScienceData>>();
function WalkBar({ walk, q, reload }: { walk: NonNullable<Parameters<typeof ScienceView>[0]['walk']>; q: string; reload: number }) {
  const [data, setData] = useState<ScienceData | null>(null);
  const [onlyReview, setOnlyReview] = useState<boolean>(() => { try { return localStorage.getItem('cms.walk.review') === '1'; } catch { return false; } });
  useEffect(() => {
    const k = `${walk.chapterId}|${reload}`;
    if (!walkCache.has(k)) { walkCache.clear(); walkCache.set(k, scienceData({ chapterId: walk.chapterId })); }
    let live = true; walkCache.get(k)!.then((d) => live && setData(d)).catch(() => live && setData(null));
    return () => { live = false; };
  }, [walk.chapterId, reload]);
  const order = useMemo(() => (data ? walkOrder(data.rows.filter((r) => !r.retired_at), walkQuestions(data.questions, walk.topics, walk.higher), walk.topics.map((t) => t.topic_id)) : []),
    [data, walk.topics, walk.higher]);
  const only = useMemo(() => (onlyReview && data ? new Set(data.questions.filter((x) => x.status === 'in_review' && !x.retired_at).map((x) => x.question_id)) : undefined), [onlyReview, data]);
  const st = walkStep(order, q, only);
  const go = (w: { topic_id: string; question_id: string } | null) => { if (w) walk.onGo(w.topic_id, w.question_id); };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)))) return;
      if (e.key === 'ArrowLeft' && st.prev) { e.preventDefault(); go(st.prev); }
      if (e.key === 'ArrowRight' && st.next) { e.preventDefault(); go(st.next); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });
  if (!data) return <span className="muted small walkbar">…</span>;
  return (
    <span className="walkbar small" aria-label="Previous / Next in this chapter">
      <button className="secondary small" disabled={!st.prev} onClick={() => go(st.prev)} title="Previous in this chapter (←)">← Previous</button>
      <span className="walk-pos" title="Position in the chapter: topic → content row → question">{st.pos ? `${st.pos} / ${st.total}` : `– / ${st.total}`}</span>
      <button className="secondary small" disabled={!st.next} onClick={() => go(st.next)} title="Next in this chapter (→)">Next →</button>
      <label className="check"><input type="checkbox" checked={onlyReview} onChange={(e) => { setOnlyReview(e.target.checked); try { localStorage.setItem('cms.walk.review', e.target.checked ? '1' : '0'); } catch { /* best effort */ } }} /> only Needs review</label>
    </span>
  );
}

export function Box({ title, children, tone }: { title: ReactNode; children: ReactNode; tone?: string }) {
  return <div className={`tint-box ${tone ?? ''}`}><div className="tint-title">{title}</div>{children}</div>;
}

/** PR 4b: a summary behind an (i) button (popover; Escape or a click outside closes it). An amber dot asks for attention. */
function InfoPop({ label, attention, attentionText, children }: { label: string; attention: boolean; attentionText: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <span className="info-pop" ref={box}>
      <button type="button" className={`info-btn ${open ? 'on' : ''}`} aria-expanded={open} aria-label={label} title={attention ? `${label} · needs attention: ${attentionText}` : label} onClick={() => setOpen(!open)}>
        i{attention && <span className="info-dot" aria-hidden />}</button>
      {open && <div className="info-panel" role="dialog" aria-label={label}>{attention && <div className="info-attn small">Needs attention: {attentionText}</div>}{children}</div>}
    </span>
  );
}

/** 25 Nov 2026 (Sambit): a row whose questions have a proposed main row stays normal, with a small badge and Confirm all
 *  (the same audited function as a question's Confirm, one question at a time). Questions whose main row needs a look are
 *  left out of Confirm all and counted separately. */
function RowPrimaries({ rowId, qs, flagged, onDone }: { rowId: string; qs: { question_id: string }[]; flagged: number; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const all = async () => {
    setErr(null);
    let done = 0;
    try {
      for (const x of qs) {
        setBusy(`${done} / ${qs.length}`);
        await decidePrimary({ question_id: x.question_id, version_no: await currentVersion(x.question_id), decision: 'confirm', row_id: rowId, reason: 'main row confirmed (Confirm all on the row)' });
        done++;
      }
    } catch (e) { setErr(`${done} confirmed; then: ${(e as Error).message}`); }
    setBusy(null); onDone();
  };
  return (
    <div className="row-primaries small">
      {qs.length > 0 && <><span className="muted">{qs.length} question{qs.length === 1 ? '' : 's'}: primary proposed</span>
        <button type="button" className="secondary small-btn" disabled={!!busy} onClick={all}>{busy ? `Confirming ${busy}` : 'Confirm all'}</button></>}
      {flagged > 0 && <span className="main-row look">{flagged} need{flagged === 1 ? 's' : ''} a look (decide on the question)</span>}
      {err && <span className="error">{err}</span>}
    </div>
  );
}

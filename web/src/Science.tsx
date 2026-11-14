// Science topic and chapter views. Layout (Sambit, 14 Nov 2026): tree | content | questions, no fourth column.
//   Middle: content rows in MASTER ORDER (not grouped by type, no filters); a row opens IN PLACE (one at a time)
//           with every field of its detail card. Chapter view: rows under collapsible topic headers.
//   Right:  no row → all questions · row → "For row <ID>": DIRECT then SUPPORTING · question → its detail with "← Back".
// Content rows are read-only here. Selected topic, row and question live in the URL hash.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Id } from './Id';
import { OriginFlags } from './AddQuestions';
import { rowDetail, scienceData, type ScienceData, type ScienceQuestion, type ScienceRow } from './scienceApi';
import { browseHash, statusLabel } from './logic';
import { isDimmed, listedOrder, rightPane, rowQuestions, rowsForClass, rowsInOrder, topicGroups } from './scienceLogic';
import { classMismatch } from '../../shared/science.ts';

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
export function Coverage({ rows, questions }: { rows: ScienceRow[]; questions: ScienceQuestion[] }) {
  const n = (s: ScienceRow['status']) => rows.filter((r) => r.status === s).length;
  const live = questions.filter((q) => !q.retired_at && q.bank === 'production');
  return (
    <div className="sci-coverage small">
      <span><strong>{rows.length}</strong> content rows:</span>
      <span className="cov ok">✓ {n('direct')} with direct questions</span>
      <span className="cov sup">✓ {n('supporting')} supporting only</span>
      <span className="cov ne">○ {n('not_eligible')} not eligible</span>
      <span className="cov none">⚠ {n('none')} none yet</span>
      <span className="sep" aria-hidden>|</span>
      <span><strong>{live.length}</strong> question{live.length === 1 ? '' : 's'}: {TIERS.map((t) => `${t} ${live.filter((q) => q.level_tier === t).length}`).join(' · ')}
        {live.some((q) => !q.level_tier) ? ` · no tier ${live.filter((q) => !q.level_tier).length}` : ''}</span>
    </div>
  );
}

export function ScienceView({ scope, cls, topicNames, row, q, onRow, onQuestion, onBack, onOrder, reload, detail }: {
  scope: { topicId: string } | { chapterId: string }; cls: string;
  /** the topics to show, in their order (chapter view keeps topics without rows) */ topicNames: Map<string, { name: string; no: string | null }>;
  row: string | null; q: string | null; onRow: (row: string | null) => void; onQuestion: (id: string) => void; onBack: () => void;
  onOrder: (ids: string[]) => void; reload: number; /** the question detail shown in the right column when q is set */ detail: ReactNode;
}) {
  const [data, setData] = useState<ScienceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = 'topicId' in scope ? scope.topicId : scope.chapterId;
  const chapterMode = 'chapterId' in scope;
  const [closed, setClosed] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(`cms.sci.topics.${key}`) ?? '[]') as string[]); } catch { return new Set(); } });
  const toggle = (k: string) => { const n = new Set(closed); if (n.has(k)) n.delete(k); else n.add(k); setClosed(n); try { localStorage.setItem(`cms.sci.topics.${key}`, JSON.stringify([...n])); } catch { /* best effort */ } };
  useEffect(() => { setError(null); scienceData(scope).then(setData).catch((e) => setError(e.message)); }, [key, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rows written for class N show in class N and above (as questions do, D3); lower-class rows are marked.
  const rows = useMemo(() => rowsInOrder(rowsForClass(data?.rows ?? [], cls)), [data, cls]);
  const hidden = (data?.rows.length ?? 0) - rows.length;
  const qs = useMemo(() => (data?.questions ?? []).filter((x) => cls === 'all' || x.effective_level <= Number(cls)), [data, cls]);
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
      {rs.map((r, i) => <RowItem key={r.row_id} n={i + 1} r={r} cls={cls} open={r.row_id === row} onPick={() => onRow(r.row_id === row ? null : r.row_id)} inScope={inScope} onRow={onRow} />)}
    </ol>
  );
  const pane = rightPane(row, q, chapterMode ? 'chapter' : 'topic');
  const where = chapterMode ? 'chapter' : 'topic';

  return (
    <div className="sci">
      <Coverage rows={rows} questions={qs} />
      <div className="sci-cols">
        <section className="sci-content" aria-label="Content rows">
          <div className="eyebrow">Content · master order{hidden > 0 ? <span className="muted"> · {hidden} row{hidden === 1 ? '' : 's'} of a higher class not shown</span> : null}</div>
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
                    <span className="muted small">{g.rows.length ? `${g.rows.length} row${g.rows.length === 1 ? '' : 's'}` : 'no content rows'} · {nq} Q{nq === 1 ? '' : 's'}</span>
                  </button>
                  {open && (g.rows.length ? list(g.rows) : <p className="muted small sci-empty">no content rows</p>)}
                </div>
              );
            })}
        </section>
        <section className="sci-questions" aria-label={pane.kind === 'detail' ? 'Question detail' : 'Questions'}>
          {pane.kind === 'detail' ? <>
            <div className="sci-q-head sci-detail-nav">
              <button className="link" onClick={onBack}>{pane.back}</button>
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
              <QSection title="Direct" hint="tests this row" items={s.direct} q={q} onQuestion={onQuestion}
                empty={selRow && selRow.question_use !== 'OK' ? `No questions: this row is "${selRow.question_use}".` : 'No question tests this row yet.'} />
              <QSection title="Supporting" hint="uses it as background" items={s.supporting} q={q} onQuestion={onQuestion} empty="None." />
            </>;
          })() : <>
            <div className="sci-q-head">
              <div className="eyebrow">Questions · {qs.length}</div>
              <div className="small muted">All for this {where} · open a content row to narrow</div>
            </div>
            {qs.length === 0 ? <p className="muted small sci-empty">No questions yet.</p>
              : chapterMode ? [...topicNames.keys()].filter((tid) => qs.some((x) => x.topic_id === tid)).map((tid) => (
                <div key={tid}><div className="sci-q-topic small">{topicNames.get(tid)?.name ?? tid} <Id>{tid}</Id></div>
                  {order.map((id) => qs.find((x) => x.question_id === id)!).filter((x) => x.topic_id === tid).map((x) => <QItem key={x.question_id} q={x} selected={x.question_id === q} onPick={() => onQuestion(x.question_id)} />)}</div>))
              : order.map((id) => qs.find((x) => x.question_id === id)!).map((x) => <QItem key={x.question_id} q={x} selected={x.question_id === q} onPick={() => onQuestion(x.question_id)} />)}
          </>}
        </section>
      </div>
    </div>
  );
}

function QSection({ title, hint, items, q, onQuestion, empty }: { title: string; hint: string; items: ScienceQuestion[]; q: string | null; onQuestion: (id: string) => void; empty: string }) {
  return (
    <div className="sci-q-section">
      <div className="sci-q-section-head"><span className="eyebrow">{title} · {items.length}</span> <span className="muted small">{hint}</span></div>
      {items.length ? items.map((x) => <QItem key={x.question_id} q={x} selected={x.question_id === q} onPick={() => onQuestion(x.question_id)} />) : <p className="muted small sci-empty">{empty}</p>}
    </div>
  );
}

function RowItem({ n, r, cls, open, onPick, inScope, onRow }: { n: number; r: ScienceRow; cls: string; open: boolean; onPick: () => void; inScope: (id: string) => boolean; onRow: (id: string) => void }) {
  const s = STATUS[r.status];
  return (
    <li className={`sci-row ${open ? 'sel open' : ''} ${isDimmed(r) ? 'dim' : ''} ${r.in_master ? '' : 'gone'}`} ref={open ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
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
            <span className="muted">&nbsp;· {r.n_direct} direct · {r.n_supporting} supporting</span>
            {cls !== 'all' && r.row_class < Number(cls) && <span className="tag revision" title="Written for a lower class">Class {r.row_class} row</span>}
            <RowTags r={r} />
            <Id>{r.row_id}</Id>
          </span>
        </span>
      </button>
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
  useEffect(() => { setD(null); setErr(null); rowDetail(r).then(setD).catch((e) => setErr(e.message)); }, [r.row_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const mm = d ? classMismatch(r.topic_classes_mapped, d.classes) : null;
  const F = ({ label, children }: { label: string; children: ReactNode }) => <div className="sci-f"><div className="sci-f-l">{label}</div><div className="sci-f-v">{children}</div></div>;
  const book = [r.book, r.book_chapter_no !== null ? `Ch ${r.book_chapter_no}${r.book_chapter_title ? ` ${r.book_chapter_title}` : ''}` : r.book_chapter_title].filter(Boolean).join(' · ');
  return (
    <div className="sci-detail" aria-label={`Details of ${r.row_id}`}>
      {r.why_it_matters && <F label="Why it matters / real-life link">{r.why_it_matters}</F>}
      {r.misconceptions && <F label="Common misconceptions">{r.misconceptions}</F>}
      {r.diagram_description && <F label="Diagram description">{r.diagram_description}</F>}
      {r.topic_classes_mapped && <F label="Classes">NCERT classes: {r.topic_classes_mapped} · CMS classes: {d ? (d.classes.join(', ') || '—') : '…'}
        {mm && <span className="tag mismatch" title={`Master names class ${mm.onlyMaster.join(', ')}, which this topic is not linked to. Nothing is changed.`}>Class mismatch</span>}</F>}
      {r.topic_taught_in && <F label="Also taught in">{r.topic_taught_in}</F>}
      {r.revisit && <F label="Revisit">{r.revisit}</F>}
      {r.also_in_rows.length > 0 && <F label="Also in">
        {(d?.alsoIn ?? r.also_in_rows.map((id) => ({ row_id: id, at: null }))).map((x, i) => <span key={x.row_id}>{i > 0 && ' · '}
          {inScope(x.row_id) ? <button className="link" onClick={() => onRow(x.row_id)} title={x.at?.content}>{x.row_id}</button>
            : x.at ? <a href={browseHash({ subject: 'science', cls: 'all', ch: x.at.chapter_id, topic: x.at.topic_id, tab: 'content', row: x.row_id })} title={x.at.content}>{x.row_id}</a>
            : <span className="muted">{x.row_id}</span>}</span>)}
      </F>}
      {(r.source || r.found_in) && <F label="Source / Found in">{[r.source, r.found_in].filter(Boolean).join(' · ')}{r.confidence ? <span className="muted small"> · confidence {r.confidence}</span> : null}</F>}
      {(book || r.appears_in || (d?.citations.length ?? 0) > 0) && <F label="Citation">
        {book && <div>{book}</div>}
        {r.appears_in && <div className="muted small">{r.appears_in}</div>}
        {d?.citations.map((c, i) => <div key={i} className="small">{d.sources.get(c.source_id) ?? c.source_id} · {c.raw}</div>)}
      </F>}
      {r.notes && <F label="Notes">{r.notes}</F>}
      {err && <p className="error small">Couldn't load the citations and classes: {err}</p>}
    </div>
  );
}

function QItem({ q, selected, onPick }: { q: ScienceQuestion; selected: boolean; onPick: () => void }) {
  const nd = q.links.filter((l) => l.role === 'direct').length, ns = q.links.length - nd;
  return (
    <button className={`qrow sci-qrow ${selected ? 'sel' : ''}`} onClick={onPick} title={q.text} ref={selected ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
      <span className="qtext">{q.text}</span>
      <span className="sci-q-meta small">
        {q.level_tier && <span className={`tag tier tier-${q.level_tier}`} title="Tier (L1–L3)">{q.level_tier}</span>}
        <span className="muted">{nd} direct{ns ? ` · ${ns} supporting` : ''}</span>
        {q.display_format && <span className="muted">{q.display_format}</span>}
        {q.safety_note && <span className="tag safety" title={q.safety_note}>Safety</span>}
        <OriginFlags q={q} compact />
        <span className={`qstatus st-${q.retired_at ? 'retired' : q.status}`}>{statusLabel(q)}</span>
        <Id>{q.question_id}</Id>
      </span>
    </button>
  );
}

export function Box({ title, children, tone }: { title: ReactNode; children: ReactNode; tone?: string }) {
  return <div className={`tint-box ${tone ?? ''}`}><div className="tint-title">{title}</div>{children}</div>;
}

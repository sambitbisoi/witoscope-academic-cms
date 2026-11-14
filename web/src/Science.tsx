// Science topic and chapter views (Sambit, 13 Nov 2026; docs/science-plan.md §4).
// Three columns: (a) content rows, in collapsible blocks per Type · (b) the questions of the selected row
// (or all) · (c) the question detail (the workspace's right pane). Content rows are read-only here.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Id } from './Id';
import { OriginFlags } from './AddQuestions';
import { rowDetail, scienceData, type ScienceData, type ScienceQuestion, type ScienceRow } from './scienceApi';
import { browseHash, statusLabel } from './logic';
import { classMismatch } from '../../shared/science.ts';

export const CONTENT_TYPES = ['Fact', 'Concept', 'How it works', 'Experiment', 'Scenario-Case', 'Diagram', 'Vocabulary'] as const;
const STATUS: Record<ScienceRow['status'], { icon: string; label: string; cls: string }> = {
  direct: { icon: '✓', label: 'has questions', cls: 'ok' },
  supporting: { icon: '✓', label: 'supporting only', cls: 'sup' },
  not_eligible: { icon: '○', label: 'not eligible', cls: 'ne' },
  none: { icon: '⚠', label: 'none yet', cls: 'none' },
};
const TIERS = ['L1', 'L2', 'L3'] as const;

interface Filters { type: string; status: string; use: string; safety: string; time: string; source: string; flag: string }
const NO_FILTERS: Filters = { type: 'all', status: 'all', use: 'all', safety: 'all', time: 'all', source: 'all', flag: 'all' };

function matches(r: ScienceRow, f: Filters) {
  return (f.type === 'all' || r.type === f.type) && (f.status === 'all' || r.status === f.status) && (f.use === 'all' || r.question_use === f.use)
    && (f.safety === 'all' || (f.safety === 'yes') === !!r.safety) && (f.time === 'all' || (f.time === 'yes') === r.time_sensitive)
    && (f.source === 'all' || r.source === f.source)
    && (f.flag === 'all' || (f.flag === 'originality' ? r.originality_result === 'near_copy' : f.flag === 'accuracy' ? r.accuracy_flag : f.flag === 'missing' ? !r.in_master : f.flag === 'picture' ? r.picture_question : true));
}

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

export function ScienceView({ scope, cls, topicNames, row, q, onRow, onQuestion, onOrder, reload }: {
  scope: { topicId: string } | { chapterId: string }; cls: string; topicNames: Map<string, { name: string; no: string | null }>; row: string | null; q: string | null;
  onRow: (row: string | null) => void; onQuestion: (id: string) => void; onOrder: (ids: string[]) => void; reload: number;
}) {
  const [data, setData] = useState<ScienceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [more, setMore] = useState(false);
  const key = 'topicId' in scope ? scope.topicId : scope.chapterId;
  const [closed, setClosed] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(`cms.sci.closed.${key}`) ?? '[]') as string[]); } catch { return new Set(); } });
  const toggle = (k: string) => { const n = new Set(closed); if (n.has(k)) n.delete(k); else n.add(k); setClosed(n); try { localStorage.setItem(`cms.sci.closed.${key}`, JSON.stringify([...n])); } catch { /* best effort */ } };
  useEffect(() => { setError(null); scienceData(scope).then(setData).catch((e) => setError(e.message)); }, [key, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rows written for class N show in class N and above (as questions do, D3); lower-class rows are marked.
  const inClass = useMemo(() => (data?.rows ?? []).filter((r) => cls === 'all' || r.row_class <= Number(cls)), [data, cls]);
  const hidden = (data?.rows.length ?? 0) - inClass.length;
  const shown = useMemo(() => inClass.filter((r) => matches(r, f)), [inClass, f]);
  const qs = useMemo(() => (data?.questions ?? []).filter((x) => cls === 'all' || x.effective_level <= Number(cls)), [data, cls]);
  const selRow = row ? data?.rows.find((r) => r.row_id === row) ?? null : null;
  const listed = useMemo(() => {
    const roleOf = (x: ScienceQuestion) => (row ? x.links.find((l) => l.row_id === row)?.role ?? null : null);
    const list = row ? qs.filter((x) => roleOf(x)) : qs;
    return list.map((x) => ({ q: x, role: roleOf(x) }))
      .sort((a, b) => (a.role === b.role ? 0 : a.role === 'direct' ? -1 : 1) || (a.q.level_tier ?? 'L9').localeCompare(b.q.level_tier ?? 'L9') || a.q.question_id.localeCompare(b.q.question_id));
  }, [qs, row]);
  useEffect(() => { onOrder(listed.map((x) => x.q.question_id)); }, [listed, onOrder]);
  useEffect(() => () => onOrder([]), [onOrder]);
  const chapterMode = 'chapterId' in scope;
  const byTopic = useMemo(() => {
    const m = new Map<string, ScienceRow[]>();
    for (const r of shown) m.set(r.topic_id, [...(m.get(r.topic_id) ?? []), r]);
    return [...m].sort((a, b) => (topicNames.get(a[0])?.no ?? '~').localeCompare(topicNames.get(b[0])?.no ?? '~', undefined, { numeric: true }) || a[0].localeCompare(b[0]));
  }, [shown, topicNames]);

  if (error) return <p className="error">Couldn't load the content rows: {error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const set = (k: keyof Filters) => (v: string) => setF({ ...f, [k]: v });
  const filtered = Object.values(f).some((v) => v !== 'all');

  const typeBlocks = (rows: ScienceRow[], prefix: string) => CONTENT_TYPES.filter((t) => rows.some((r) => r.type === t)).map((t) => {
    const list = rows.filter((r) => r.type === t);
    const k = `${prefix}${t}`;
    const open = !closed.has(k);
    const nq = list.filter((r) => r.status === 'direct').length;
    return (
      <div key={k} className={`sci-block ${open ? 'open' : ''}`}>
        <button className="sci-block-head" aria-expanded={open} onClick={() => toggle(k)}>
          <span className="caret" aria-hidden>{open ? '▾' : '▸'}</span><strong>{t}</strong>
          <span className="muted small"> · {list.length} row{list.length === 1 ? '' : 's'} · {nq} with direct questions</span>
        </button>
        {open && list.map((r) => <RowItem key={r.row_id} r={r} cls={cls} selected={r.row_id === row} onPick={() => onRow(r.row_id === row ? null : r.row_id)} />)}
      </div>
    );
  });

  return (
    <div className="sci">
      <Coverage rows={inClass} questions={qs} />
      <div className="filters sci-filters">
        <span className="muted small">Filter</span>
        <Sel label="Type" value={f.type} onChange={set('type')} options={[['all', 'Type: all'], ...CONTENT_TYPES.map((t) => [t, t] as [string, string])]} />
        <Sel label="Row status" value={f.status} onChange={set('status')} options={[['all', 'Row status: all'], ['direct', '✓ Has questions'], ['supporting', '✓ Supporting only'], ['none', '⚠ None yet'], ['not_eligible', '○ Not eligible']]} />
        <Sel label="Question use" value={f.use} onChange={set('use')} options={[['all', 'Question use: all'], ['OK', 'OK'], ['Misconception only', 'Misconception only'], ['No questions', 'No questions']]} />
        <Sel label="Safety" value={f.safety} onChange={set('safety')} options={[['all', 'Safety: all'], ['yes', 'Has a safety note'], ['no', 'No safety note']]} />
        <Sel label="Time-sensitive" value={f.time} onChange={set('time')} options={[['all', 'Time-sensitive: all'], ['yes', 'Time-sensitive'], ['no', 'Not time-sensitive']]} />
        <button className="link small" onClick={() => setMore(!more)}>{more ? 'Less' : 'More'}</button>
        {more && <>
          <Sel label="Source" value={f.source} onChange={set('source')} options={[['all', 'Source: all'], ['Book', 'Book'], ['Claude-added', 'Claude-added']]} />
          <Sel label="Flags" value={f.flag} onChange={set('flag')} options={[['all', 'Flags: all'], ['originality', 'Originality flagged'], ['accuracy', 'Accuracy note'], ['picture', 'Picture question possible'], ['missing', 'Not in master']]} />
        </>}
        <span className="muted small">{shown.length} of {inClass.length} rows{hidden > 0 ? ` · ${hidden} of a higher class not shown` : ''}</span>
        {filtered && <button className="link small" onClick={() => setF(NO_FILTERS)}>Clear</button>}
      </div>
      <div className="sci-cols">
        <section className="sci-content" aria-label="Content rows">
          <div className="eyebrow">Content</div>
          {shown.length === 0 && <p className="muted small">{inClass.length ? 'No rows with these filters.' : 'No content rows for this topic yet.'}</p>}
          {chapterMode ? byTopic.map(([tid, rows]) => (
            <div key={tid} className="sci-topic">
              <div className="sci-topic-name">{topicNames.get(tid)?.no ? `${topicNames.get(tid)!.no} ` : ''}{topicNames.get(tid)?.name ?? tid} <Id>{tid}</Id>
                <span className="muted small"> · {rows.length} rows · {qs.filter((x) => x.topic_id === tid).length} Qs</span></div>
              {typeBlocks(rows, `${tid}:`)}
            </div>
          )) : typeBlocks(shown, '')}
        </section>
        <section className="sci-questions" aria-label="Questions">
          <div className="sci-q-head">
            <div className="eyebrow">Questions</div>
            {selRow ? <div className="small"><span className="sel-row">For row: {selRow.content.length > 90 ? `${selRow.content.slice(0, 90)}…` : selRow.content} <Id>{selRow.row_id}</Id></span>
              {' '}<button className="link small" onClick={() => onRow(null)}>All for this {chapterMode ? 'chapter' : 'topic'}</button></div>
              : <div className="small muted">All for this {chapterMode ? 'chapter' : 'topic'} · pick a content row to narrow</div>}
          </div>
          {selRow && <RowDetail r={selRow} inScope={(id) => !!data.rows.some((x) => x.row_id === id)} onRow={onRow} />}
          {selRow && <div className="eyebrow sci-q-sub">Questions for this row</div>}
          {listed.length === 0 ? <p className="muted small">{selRow ? (selRow.question_use !== 'OK' ? `No questions: this row is "${selRow.question_use}".` : 'No questions use this row yet.') : 'No questions yet.'}</p>
            : chapterMode && !row ? [...new Set(listed.map((x) => x.q.topic_id))].map((tid) => (
              <div key={tid}><div className="sci-topic-name small">{topicNames.get(tid)?.name ?? tid} <Id>{tid}</Id></div>
                {listed.filter((x) => x.q.topic_id === tid).map((x) => <QItem key={x.q.question_id} x={x} selected={x.q.question_id === q} onPick={() => onQuestion(x.q.question_id)} />)}</div>))
            : listed.map((x) => <QItem key={x.q.question_id} x={x} selected={x.q.question_id === q} onPick={() => onQuestion(x.q.question_id)} />)}
        </section>
      </div>
    </div>
  );
}

function RowItem({ r, cls, selected, onPick }: { r: ScienceRow; cls: string; selected: boolean; onPick: () => void }) {
  const s = STATUS[r.status];
  return (
    <button className={`sci-row ${selected ? 'sel' : ''} ${r.in_master ? '' : 'gone'}`} onClick={onPick} aria-pressed={selected}
      ref={selected ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
      <span className="sci-row-text">{r.content}</span>
      <span className="sci-row-meta small">
        <span className={`cov ${s.cls}`} title={`Row status: ${s.label}`}>{s.icon} {s.label}</span>
        <span className="muted">&nbsp;· {r.n_direct} direct · {r.n_supporting} supporting</span>
        {r.chapter_role && <span className={`tag role-${r.chapter_role.toLowerCase()}`} title="Chapter role">{r.chapter_role}</span>}
        {cls !== 'all' && r.row_class < Number(cls) && <span className="tag revision" title="Written for a lower class">Class {r.row_class} row</span>}
        <RowTags r={r} />
        <Id>{r.row_id}</Id>
      </span>
    </button>
  );
}

/** The row's flags (list and detail card): question use, Claude-added, Safety, Time-sensitive, Accuracy, Originality, Not in master. */
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

/** Detail card of the selected content row (read-only). Empty fields are hidden. */
function RowDetail({ r, inScope, onRow }: { r: ScienceRow; inScope: (id: string) => boolean; onRow: (id: string) => void }) {
  const [d, setD] = useState<Awaited<ReturnType<typeof rowDetail>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setD(null); setErr(null); rowDetail(r).then(setD).catch((e) => setErr(e.message)); }, [r.row_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const mm = d ? classMismatch(r.topic_classes_mapped, d.classes) : null;
  const F = ({ label, children }: { label: string; children: ReactNode }) => <div className="sci-f"><div className="sci-f-l">{label}</div><div className="sci-f-v">{children}</div></div>;
  const book = [r.book, r.book_chapter_no !== null ? `Ch ${r.book_chapter_no}${r.book_chapter_title ? ` ${r.book_chapter_title}` : ''}` : r.book_chapter_title].filter(Boolean).join(' · ');
  return (
    <div className="sci-detail" aria-label="Content row detail">
      <div className="sci-detail-tags small"><RowTags r={r} /><Id>{r.row_id}</Id></div>
      <F label="Type">{r.type}</F>
      {r.chapter_role && <F label="Chapter role">{r.chapter_role}</F>}
      <F label="Content">{r.content}</F>
      {r.why_it_matters && <F label="Why it matters / real-life link">{r.why_it_matters}</F>}
      {r.misconceptions && <F label="Common misconceptions">{r.misconceptions}</F>}
      {r.diagram_description && <F label="Diagram description">{r.diagram_description}</F>}
      {(r.topic_classes_mapped || r.topic_taught_in || r.revisit) && <F label="Classes">
        {r.topic_classes_mapped && <div>NCERT classes: {r.topic_classes_mapped} · CMS classes: {d ? (d.classes.join(', ') || '—') : '…'}
          {mm && <span className="tag mismatch" title={`Master names class ${mm.onlyMaster.join(', ')}, which this topic is not linked to. Nothing is changed.`}>Class mismatch</span>}</div>}
        {r.topic_taught_in && <div className="muted small">Also taught in: {r.topic_taught_in}</div>}
        {r.revisit && <div className="muted small">Revisit: {r.revisit}</div>}
      </F>}
      {r.also_in_rows.length > 0 && <F label="Also in">
        {(d?.alsoIn ?? r.also_in_rows.map((id) => ({ row_id: id, at: null }))).map((x, i) => <span key={x.row_id}>{i > 0 && ' · '}
          {inScope(x.row_id) ? <button className="link" onClick={() => onRow(x.row_id)} title={x.at?.content}>{x.row_id}</button>
            : x.at ? <a href={browseHash({ subject: 'science', cls: 'all', ch: x.at.chapter_id, topic: x.at.topic_id, tab: 'content', row: x.row_id })} title={x.at.content}>{x.row_id}</a>
            : <span className="muted">{x.row_id}</span>}</span>)}
      </F>}
      {(r.source || r.found_in) && <F label="Source / Found in">{[r.source, r.found_in].filter(Boolean).join(' · ')}{r.confidence ? <span className="muted small"> · confidence {r.confidence}</span> : null}</F>}
      {(book || r.appears_in || (d?.citations.length ?? 0) > 0) && <F label="Book citation">
        {book && <div>{book}</div>}
        {r.appears_in && <div className="muted small">{r.appears_in}</div>}
        {d?.citations.map((c, i) => <div key={i} className="small">{d.sources.get(c.source_id) ?? c.source_id} · {c.raw}</div>)}
      </F>}
      {r.notes && <F label="Notes">{r.notes}</F>}
      {err && <p className="error small">Couldn't load the citations and classes: {err}</p>}
    </div>
  );
}

function QItem({ x, selected, onPick }: { x: { q: ScienceQuestion; role: 'direct' | 'supporting' | null }; selected: boolean; onPick: () => void }) {
  const { q, role } = x;
  const nd = q.links.filter((l) => l.role === 'direct').length, ns = q.links.length - nd;
  return (
    <button className={`qrow sci-qrow ${selected ? 'sel' : ''}`} onClick={onPick} title={q.text} ref={selected ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
      <span className="qtext">{q.text}</span>
      <span className="sci-q-meta small">
        {q.level_tier && <span className={`tag tier tier-${q.level_tier}`} title="Tier (L1–L3)">{q.level_tier}</span>}
        {role ? <span className={`tag role-${role}`}>{role}</span> : <span className="muted">{nd} direct{ns ? ` · ${ns} supporting` : ''}</span>}
        {q.display_format && <span className="muted">{q.display_format}</span>}
        {q.safety_note && <span className="tag safety" title={q.safety_note}>Safety</span>}
        <OriginFlags q={q} compact />
        <span className={`qstatus st-${q.retired_at ? 'retired' : q.status}`}>{statusLabel(q)}</span>
        <Id>{q.question_id}</Id>
      </span>
    </button>
  );
}

function Sel({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="filter"><span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={value !== 'all' ? 'active' : ''}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

export function Box({ title, children, tone }: { title: ReactNode; children: ReactNode; tone?: string }) {
  return <div className={`tint-box ${tone ?? ''}`}><div className="tint-title">{title}</div>{children}</div>;
}

import { useEffect, useMemo, useState } from 'react';
import { topicData, tree, type Chapter, type QuestionRow, type TopicWithStats } from './api';
import {
  applyFilters, browseHash, countsLabel, gapLabel, groupBySet, NO_FILTERS, statusLabel, subjectLabel, SUBJECTS, type Filters, type Subject,
} from './logic';
import { QuestionDetail } from './QuestionDetail';
import { rememberBrowse } from './Shell';

type R = { subject: Subject; cls: string; topic: string | null; q: string | null; v: number | null; tab: 'types' | 'concepts' };
const SOURCE_LABEL: Record<string, string> = { ncert: 'NCERT', dav: 'DAV', ixl: 'IXL', imo: 'IMO', iso: 'ISO', ieo: 'IEO' };

export function Workspace(r: R) {
  const [data, setData] = useState<Awaited<ReturnType<typeof tree>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gapsOnly, setGapsOnly] = useState(false);
  useEffect(() => { rememberBrowse(browseHash(r)); });
  useEffect(() => {
    setData(null); setError(null);
    tree(r.subject, r.cls).then(setData).catch((e) => setError(e.message));
  }, [r.subject, r.cls]);

  const go = (patch: Partial<R>) => { location.hash = browseHash({ ...r, ...patch }); };
  const topic = data?.topics.find((t) => t.topic_id === r.topic) ?? null;

  return (
    <div className="workspace">
      <div className="ws-bar">
        <label className="sr-only" htmlFor="ws-class">Class</label>
        <select id="ws-class" value={r.cls} onChange={(e) => go({ cls: e.target.value, topic: null, q: null, v: null })}>
          <option value="all">All classes</option>
          {['1', '2', '3', '4', '5', '6'].map((c) => <option key={c} value={c}>Class {c}</option>)}
        </select>
        <label className="sr-only" htmlFor="ws-subject">Subject</label>
        <select id="ws-subject" value={r.subject} onChange={(e) => go({ subject: e.target.value as Subject, topic: null, q: null, v: null })}>
          {SUBJECTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>
      <div className="ws-cols">
        <nav className="ws-tree" aria-label="Chapters and topics">
          <div className="tree-head">
            <span className="eyebrow">Chapters · topics</span>
            <button className={`pill small ${gapsOnly ? 'on' : ''}`} aria-pressed={gapsOnly} onClick={() => setGapsOnly(!gapsOnly)}>Gaps only</button>
          </div>
          {error && <p className="error">Couldn't load topics: {error}</p>}
          {!data && !error && <p className="muted">Loading…</p>}
          {data && <Tree chapters={data.chapters} topics={data.topics} cls={r.cls} selected={r.topic} gapsOnly={gapsOnly} onPick={(t) => go({ topic: t, q: null, v: null })} />}
        </nav>
        <section className="ws-main" aria-label="Questions">
          {!r.topic ? <Pick subject={r.subject} cls={r.cls} n={data?.topics.length} />
            : !data ? <p className="muted">Loading…</p>
            : !topic ? <p>Topic {r.topic} isn't in {subjectLabel(r.subject)}{r.cls !== 'all' ? ` class ${r.cls}` : ''}. <a href={browseHash({ ...r, cls: 'all' })}>Look in all classes</a></p>
            : <TopicView topic={topic} chapter={data.chapters.find((c) => c.chapter_id === topic.chapter_id)} r={r} go={go} />}
        </section>
        <aside className="ws-detail" aria-label="Question detail">
          {r.q ? <QuestionDetail id={r.q} versionNo={r.v} onVersion={(v) => go({ v })} /> : <p className="muted">Select a question to see it here.</p>}
        </aside>
      </div>
    </div>
  );
}

function Pick({ subject, cls, n }: { subject: Subject; cls: string; n?: number }) {
  return (
    <div className="empty">
      <h1>{subjectLabel(subject)} · {cls === 'all' ? 'all classes' : `Class ${cls}`}</h1>
      <p className="muted">{n === undefined ? 'Loading…' : `${n} topics. Pick one on the left.`}</p>
    </div>
  );
}

function Tree({ chapters, topics, cls, selected, gapsOnly, onPick }: { chapters: Chapter[]; topics: TopicWithStats[]; cls: string; selected: string | null; gapsOnly: boolean; onPick: (t: string) => void }) {
  const visible = topics.filter((t) => t.status === 'active' || t.topic_id === selected).filter((t) => !gapsOnly || gapLabel(t.stats) || t.topic_id === selected);
  const byChapter = new Map<string, TopicWithStats[]>();
  for (const t of visible) byChapter.set(t.chapter_id, [...(byChapter.get(t.chapter_id) ?? []), t]);
  const shown = chapters.filter((c) => byChapter.has(c.chapter_id));
  if (!shown.length) return <p className="muted">{gapsOnly ? 'No gaps: every topic with questions has all 3 levels.' : 'No topics.'}</p>;
  return (
    <>
      {shown.map((c) => {
        const ts = byChapter.get(c.chapter_id)!.sort((a, b) =>
          (a.topic_kind === 'achievers' ? 1 : 0) - (b.topic_kind === 'achievers' ? 1 : 0) || a.class - b.class || (a.seq ?? 999) - (b.seq ?? 999) || a.topic_id.localeCompare(b.topic_id));
        return (
          <div key={c.chapter_id} className="tree-chapter">
            <div className="tree-chapter-name">{c.chapter_id} {c.name}</div>
            {ts.map((t) => {
              const gap = gapLabel(t.stats);
              return (
                <button key={t.topic_id} className={`tree-topic ${t.topic_id === selected ? 'sel' : ''} ${t.topic_kind === 'achievers' ? 'ach' : ''}`} onClick={() => onPick(t.topic_id)}
                  ref={t.topic_id === selected ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
                  <span className="tt-name">{t.topic_kind === 'achievers' ? t.name : <>{t.topic_id} {t.name}</>}{cls === 'all' && <span className="cls"> · C{t.class}</span>}</span>
                  <span className="tt-meta">{countsLabel(t.stats)}{gap && <span className="gap"> · ⚠ {gap}</span>}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

function TopicView({ topic, chapter, r, go }: { topic: TopicWithStats; chapter?: Chapter; r: R; go: (p: Partial<R>) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof topicData>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  useEffect(() => {
    setData(null); setError(null); setFilters(NO_FILTERS);
    topicData(topic.topic_id).then(setData).catch((e) => setError(e.message));
  }, [topic.topic_id]);

  const sources = Object.entries(topic.source_flags ?? {}).map(([k, v]) => `${SOURCE_LABEL[k] ?? k.toUpperCase()} ${v}`).join(' · ');
  const s = topic.stats;
  const filtered = filters.difficulty !== 'all' || filters.status !== 'all' || filters.bank !== 'all';
  const qs = useMemo(() => (data ? applyFilters(data.questions, filters) : []), [data, filters]);
  const groups = useMemo(() => (data ? groupBySet(qs, data.sets.filter((x) => x.topic_id === topic.topic_id).map((x) => x.typical_set_id)) : []), [data, qs, topic.topic_id]);

  return (
    <>
      <div className="topic-head">
        <h1>{topic.topic_kind === 'achievers' ? topic.name : `${topic.topic_id} · ${topic.name}`}</h1>
        <div className="muted small">
          {chapter ? `${chapter.chapter_id} ${chapter.name}` : topic.chapter_id} · Class {topic.class}
          {topic.topic_kind === 'achievers' ? ' · Achievers (chapter level)' : topic.taught_in_school ? ' · taught in school' : ' · not in NCERT / DAV'}
          {sources && ` · ${sources}`}
        </div>
        <div className="muted small">
          {data ? `${data.sets.length} question type${data.sets.length === 1 ? '' : 's'} · ` : ''}{countsLabel(s)}
          {topic.status !== 'active' && <strong> · {topic.status}</strong>}
        </div>
        {topic.sub_skills && <div className="muted small subskills">Sub-skills: {topic.sub_skills.replace(/\s*;\s*\n?/g, '; ')}</div>}
      </div>

      <div role="tablist" className="tabs">
        <button role="tab" aria-selected={r.tab === 'types'} className={r.tab === 'types' ? 'on' : ''} onClick={() => go({ tab: 'types' })}>By question type</button>
        <button role="tab" aria-selected={r.tab === 'concepts'} className={r.tab === 'concepts' ? 'on' : ''} onClick={() => go({ tab: 'concepts' })}>
          By concept{data ? ` · ${data.concepts.length}` : ''}
        </button>
      </div>

      <div className="filters">
        <span className="muted small">Filter</span>
        <Select label="Difficulty" value={filters.difficulty} onChange={(v) => setFilters({ ...filters, difficulty: v })} options={[['all', 'Difficulty: all'], ['Simple', 'Simple'], ['Medium', 'Medium'], ['Complex', 'Complex']]} />
        <Select label="Status" value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} options={[['all', 'Status: all'], ['draft', 'Draft'], ['in_review', 'In review'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['retired', 'Retired']]} />
        <Select label="Bank" value={filters.bank} onChange={(v) => setFilters({ ...filters, bank: v })} options={[['all', 'Bank: all'], ['production', 'Production'], ['gold', 'Gold']]} />
        {data && <span className="muted small">{qs.length} of {data.questions.length} shown</span>}
      </div>

      {error && <p className="error">Couldn't load this topic: {error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && r.tab === 'types' && (
        groups.length === 0 ? <p className="muted">No questions or question types for this topic yet.</p> : groups.map((g) => {
          const set = data.sets.find((x) => x.typical_set_id === g.setId);
          const main = data.setConcepts.filter((c) => c.typical_set_id === g.setId).sort((a) => (a.role === 'main' ? -1 : 1)).map((c) => c.concept_id);
          return (
            <div key={g.setId ?? 'none'} className="group">
              <div className="group-head">
                <div className="group-title">{g.setId ? <>{g.setId} · {set?.name ?? ''}</> : 'No typical set'}</div>
                {set && <div className="muted small">
                  Class {set.class} · {set.parent_visible ? 'parent-visible' : 'hidden from parents'} · {set.status}
                  {set.instruction_pattern && ` · "${set.instruction_pattern}"`}{main.length ? ` · concepts ${main.join(', ')}` : ''}
                  {set.topic_id && set.topic_id !== topic.topic_id ? ` · set belongs to ${set.topic_id}` : ''}
                </div>}
              </div>
              {g.count === 0 && <div className="muted small pad">No questions yet{filtered ? ' (with these filters)' : ''}.</div>}
              {g.patterns.map((p) => {
                const pat = data.patterns.find((x) => x.pattern_id === p.patternId);
                return (
                  <div key={p.patternId ?? 'none'}>
                    {(p.patternId || g.patterns.length > 1) && (
                      <div className="pattern-head small">{p.patternId ? <>{p.patternId} · {pat?.name ?? ''}{pat?.target_misconceptions?.length ? <span className="muted"> · targets {pat.target_misconceptions.join(', ')}</span> : null}</> : <span className="muted">No pattern</span>}</div>
                    )}
                    {p.questions.map((q) => <QRow key={q.question_id} q={q} selected={q.question_id === r.q} onPick={() => go({ q: q.question_id, v: null })} />)}
                  </div>
                );
              })}
            </div>
          );
        })
      )}
      {data && r.tab === 'concepts' && <ConceptsTab data={data} visible={new Set(qs.map((q) => q.question_id))} selected={r.q} onPick={(q) => go({ q, v: null })} />}
    </>
  );
}

function ConceptsTab({ data, visible, selected, onPick }: { data: Awaited<ReturnType<typeof topicData>>; visible: Set<string>; selected: string | null; onPick: (q: string) => void }) {
  if (!data.concepts.length) return <p className="muted">No concepts defined for this topic yet.</p>;
  const byVersion = new Map(data.questions.map((q) => [q.version_id, q]));
  return (
    <>
      {data.concepts.map((c) => {
        const links = data.versionConcepts.filter((v) => v.concept_id === c.concept_id && v.part_label === '');
        const qs = links.map((l) => ({ q: byVersion.get(l.version_id), inv: l.involvement })).filter((x): x is { q: QuestionRow; inv: number } => !!x.q && visible.has(x.q.question_id));
        return (
          <div key={c.concept_id} className="group">
            <div className="group-head">
              <div className="group-title">{c.concept_id} · {c.name}</div>
              <div className="muted small">Class {c.class}{c.type ? ` · ${c.type}` : ''} · {c.status}{c.description ? ` · ${c.description}` : ''}</div>
            </div>
            {qs.length === 0 ? <div className="muted small pad">No questions use this concept{visible.size < data.questions.length ? ' (with these filters)' : ''}.</div>
              : qs.sort((a, b) => b.inv - a.inv).map(({ q, inv }) => <QRow key={q.question_id} q={q} selected={q.question_id === selected} onPick={() => onPick(q.question_id)} extra={`× ${Number(inv).toFixed(1)}`} />)}
          </div>
        );
      })}
    </>
  );
}

function QRow({ q, selected, onPick, extra }: { q: QuestionRow; selected: boolean; onPick: () => void; extra?: string }) {
  return (
    <button className={`qrow ${selected ? 'sel' : ''}`} onClick={onPick}>
      <span className="qid mono">{q.question_id}</span>
      <span className="qtext">{q.text}</span>
      {q.bank === 'gold' && <span className="tag gold">Gold</span>}
      {extra && <span className="muted small">{extra}</span>}
      <span className={`lvl ${q.math_difficulty ?? ''}`}>{q.math_difficulty ?? '—'}</span>
      <span className="qstatus small">{statusLabel(q)}</span>
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

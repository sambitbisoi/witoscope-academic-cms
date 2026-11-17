// Q21 (Sambit, 17 Nov 2026): the Held-out area. Items an import could not place for a placement or catalogue reason,
// with what is needed to bring them in: Place on a topic (the importer's checks first; same audit and originality as an
// import) or Discard (kept, audited). Near-copies are never here (they stay on the Mac).
import { useEffect, useMemo, useState } from 'react';
import { Id } from './Id';
import { discardHeld, heldItems, placeHeld, placeTopics, preparePlace, REASON_LABEL, type HeldItem } from './heldOutApi';
import type { Problem } from '../../shared/types.ts';

const go = (id: number | null, status: string) => { location.hash = `#/held-out?${new URLSearchParams({ ...(id ? { id: String(id) } : {}), ...(status !== 'held' ? { status } : {}) })}`; };

export function HeldOutScreen({ id, status }: { id: number | null; status: string }) {
  const [items, setItems] = useState<HeldItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [f, setF] = useState({ subject: '', batch: '', cls: '', reason: '' });
  useEffect(() => { heldItems().then(setItems).catch((e) => setError(e.message)); }, [tick]);
  const byStatus = useMemo(() => (items ?? []).filter((h) => status === 'all' || h.status === status), [items, status]);
  const shown = byStatus.filter((h) => (!f.subject || h.subject === f.subject) && (!f.batch || h.batch === f.batch) && (!f.cls || String(h.class) === f.cls) && (!f.reason || h.reason_code === f.reason));
  const open = items?.find((h) => h.held_id === id) ?? null;
  const opts = (k: (h: HeldItem) => string) => [...new Set(byStatus.map(k))].sort();
  const count = (s: string) => (items ?? []).filter((h) => h.status === s).length;

  if (error) return <p className="error">Couldn't load the held-out items: {error}</p>;
  if (!items) return <p className="muted">Loading…</p>;
  return (
    <div className="held">
      <div className="topic-head"><h1>Held out</h1>
        <div className="muted small">Questions an import could not place (topic, Achievers row or catalogue item missing, or in another class or chapter), kept with their catalogue items. Place one on a topic, or discard it. Near-copies of a book are never here: they stay on the Mac.</div></div>
      <div className="held-tabs">{(['held', 'placed', 'discarded', 'all'] as const).map((s) => (
        <button key={s} className={`tab ${status === s ? 'active' : ''}`} onClick={() => go(null, s)}>{s === 'held' ? 'Held' : s === 'placed' ? 'Placed' : s === 'discarded' ? 'Discarded' : 'All'}{s !== 'all' ? ` · ${count(s)}` : ''}</button>))}</div>
      <div className="filters small">
        <select value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })}><option value="">All subjects</option>{opts((h) => h.subject).map((x) => <option key={x}>{x}</option>)}</select>
        <select value={f.batch} onChange={(e) => setF({ ...f, batch: e.target.value })}><option value="">All batches</option>{opts((h) => h.batch).map((x) => <option key={x}>{x}</option>)}</select>
        <select value={f.cls} onChange={(e) => setF({ ...f, cls: e.target.value })}><option value="">All classes</option>{opts((h) => String(h.class)).map((x) => <option key={x} value={x}>Class {x}</option>)}</select>
        <select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}><option value="">All reasons</option>{opts((h) => h.reason_code).map((x) => <option key={x} value={x}>{REASON_LABEL[x] ?? x}</option>)}</select>
      </div>
      <div className="held-cols">
        <ul className="plain held-list">
          {shown.length === 0 && <li className="muted small">Nothing here.</li>}
          {shown.map((h) => (
            <li key={h.held_id}><button className={`qrow ${h.held_id === id ? 'sel' : ''}`} onClick={() => go(h.held_id, status)}>
              <span className="qtext">{h.question.text}</span>
              <span className="small"><span className="tag">{REASON_LABEL[h.reason_code] ?? h.reason_code}</span> <span className="muted">Class {h.class}{h.level ? ` · Level ${h.level}` : ''} · {h.batch}</span>
                {h.status !== 'held' && <span className={`tag ${h.status === 'placed' ? 'ok' : 'gone'}`}>{h.status === 'placed' ? `Placed → ${h.placed_question_id}` : 'Discarded'}</span>}
                <Id>{h.file_key}</Id></span>
            </button></li>))}
        </ul>
        <div className="held-detail">{open ? <HeldDetail key={open.held_id} h={open} onChanged={() => setTick((t) => t + 1)} /> : <p className="muted small">Open an item to see it and place or discard it.</p>}</div>
      </div>
    </div>
  );
}

function HeldDetail({ h, onChanged }: { h: HeldItem; onChanged: () => void }) {
  const q = h.question;
  const [topics, setTopics] = useState<{ topic_id: string; name: string; topic_kind: string }[] | null>(null);
  const [topic, setTopic] = useState('');
  const [check, setCheck] = useState<{ problems: Problem[]; payload: Record<string, unknown> | null } | null>(null);
  const [note, setNote] = useState('');
  const [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const achievers = `ACH-${h.chapter_id}-${h.class}`;
  useEffect(() => {
    placeTopics(h.chapter_id, h.class).then((ts) => {
      setTopics(ts);
      const rec = h.recommended_topic_id ?? (h.reason_code === 'achievers_missing' ? achievers : null);
      setTopic(ts.some((t) => t.topic_id === rec) ? rec! : '');
    }).catch((e) => setError(e.message));
  }, [h.held_id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setCheck(null); if (topic && h.status === 'held') preparePlace(h, topic).then(setCheck).catch((e) => setError(e.message)); }, [topic]); // eslint-disable-line react-hooks/exhaustive-deps
  const errors = check?.problems.filter((p) => p.level === 'error') ?? [];
  const achieversMissing = h.reason_code === 'achievers_missing' && topics && !topics.some((t) => t.topic_id === achievers);
  const cat = h.catalogue;
  const catLine = [...cat.concepts.map((c) => `concept ${c.concept_id} (${c.name})`), ...cat.typical_sets.map((s) => `typical set ${s.typical_set_id} (${s.name})`),
    ...cat.patterns.map((p) => `pattern ${p.pattern_id} (${p.name})`), ...cat.misconceptions.map((m) => `misconception ${m.misconception_id}`)];

  async function place() {
    setBusy(true); setError(null);
    try { const r = await placeHeld(check!.payload!, note.trim() || null); setDone(`Placed as ${r.question_id} (import #${r.import_id}).`); onChanged(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function discard() {
    setBusy(true); setError(null);
    try { await discardHeld(h.held_id, note.trim()); setDone('Discarded (kept in the list, audited).'); onChanged(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="held-card">
      <div className="eyebrow">{REASON_LABEL[h.reason_code] ?? h.reason_code} · held #{h.held_id}</div>
      <h2>{q.text}</h2>
      <div className="kv small">
        <Row k="Batch">{h.batch}</Row>
        <Row k="File · key">{h.file} · <span className="mono">{h.file_key}</span></Row>
        <Row k="Class · Level">{h.class} · {h.level ?? '—'}</Row>
        <Row k="Reason">{h.reason}</Row>
        <Row k="Recommended topic">{h.recommended_topic_id ?? (h.reason_code === 'achievers_missing' ? `${achievers} (it exists once a ${h.chapter_id} topic is linked to Class ${h.class})` : '—')}</Row>
        <Row k="Answer">{q.answer.format}{q.answer.options ? ` · ${q.answer.options.join(' / ')}` : ''} · correct: <strong>{q.answer.correct}</strong></Row>
        <Row k="Attributes">{q.signature.math_difficulty} · reading {q.signature.reading} · steps {q.signature.steps} · WM {q.signature.working_memory} · strategy {q.signature.strategy}{q.signature.strategy_type ? ` (${q.signature.strategy_type})` : ''} · typical set {q.typical_set_id}{q.pattern_id ? ` · pattern ${q.pattern_id}` : ''} · concepts {q.concepts.map((c) => `${c.concept_id} ×${c.involvement}`).join(', ')}</Row>
        <Row k="Held with it">{catLine.length ? catLine.join(' · ') : 'no catalogue items'}{h.proposed_by ? <span className="muted"> (from {h.proposed_by})</span> : null}</Row>
        <Row k="Originality (on the Mac)">{h.originality ? `${h.originality.result}${h.originality.similarity !== null ? ` ${h.originality.similarity}` : ''}${h.originality.closest_ref ? ` · ${h.originality.closest_ref}` : ''}` : 'not checked: it will be pending after placing'}</Row>
        {q.solutions.school && <Row k="Solution 1">{q.solutions.school}</Row>}
      </div>

      {h.status !== 'held' ? <p className="small">{h.status === 'placed' ? <>Placed on {h.placed_topic_id} as <a href={`#/q/${h.placed_question_id}`}>{h.placed_question_id}</a></> : 'Discarded'} · {h.decided_at?.slice(0, 10)}{h.note ? ` · ${h.note}` : ''}</p>
        : done ? <p className="small ok">{done}</p> : h.subject !== 'math' ? <p className="small muted">{h.subject} items are placed by re-running import:science --from-excel once their topic exists. You can discard it here.</p> : (
        <div className="save-preview">
          <div className="eyebrow">Place on a topic</div>
          {achieversMissing && <p className="small warn">{achievers} does not exist yet. Link a {h.chapter_id} topic to Class {h.class} (topic screen → other classes); its Achievers row is then made automatically.</p>}
          <label className="wide">Topic (Class {h.class}, {h.chapter_id})<select value={topic} onChange={(e) => setTopic(e.target.value)}>
            <option value="">Choose…</option>{(topics ?? []).map((t) => <option key={t.topic_id} value={t.topic_id}>{t.topic_kind === 'achievers' ? t.name : `${t.topic_id} ${t.name}`}{t.topic_id === h.recommended_topic_id ? ' (recommended)' : ''}</option>)}</select></label>
          {topic && !check && <p className="small muted">Running the importer's checks…</p>}
          {check && (errors.length ? <ul className="small">{errors.map((p, i) => <li key={i} className="error">{p.message}</li>)}</ul>
            : <p className="small ok">The importer's checks pass on {topic}. Place makes a new question with key {h.file_key} (v1 draft), {catLine.length ? `creates ${catLine.length} catalogue item${catLine.length === 1 ? '' : 's'} as Proposed, ` : ''}and records the originality result.</p>)}
          {check?.problems.filter((p) => p.level === 'warning').map((p, i) => <div key={i} className="small warn">Warning: {p.message}</div>)}
          <label className="wide small">Note (optional for Place; required to Discard)<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
          {error && <p className="error small">{error}</p>}
          <div className="editor-actions">
            <button onClick={place} disabled={busy || !check?.payload}>{busy ? 'Working…' : 'Place'}</button>
            {!discarding ? <button className="link small" onClick={() => setDiscarding(true)}>Discard…</button>
              : <button className="secondary" onClick={discard} disabled={busy || !note.trim()}>Discard {h.file_key}</button>}
          </div>
        </div>)}
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="held-kv"><span className="muted">{k}</span><span>{children}</span></div>;
}

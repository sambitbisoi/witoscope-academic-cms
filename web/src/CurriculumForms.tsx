// D5 (queue 12 Nov 2026): add and edit chapters, topics, concepts, question types (typical sets)
// and patterns. Explicit Save; IDs are given by the CMS and never change; no delete, only
// Retire / Restore; every change is audited (history below the form). Saves go through
// cms_save_curriculum. Until the cut-over, chapters and topics are read-only here except a
// topic's classes (D2) and prerequisites (D4).
import { useEffect, useState, type ReactNode } from 'react';
import { supabase } from './supabase';

export type Kind = 'chapter' | 'topic' | 'concept' | 'typical_set' | 'pattern';
const LABEL: Record<Kind, string> = { chapter: 'chapter', topic: 'topic', concept: 'concept', typical_set: 'question type', pattern: 'pattern' };
const TABLE: Record<Kind, { table: string; key: string }> = {
  chapter: { table: 'cms_chapters', key: 'chapter_id' }, topic: { table: 'cms_topics', key: 'topic_id' }, concept: { table: 'cms_concepts', key: 'concept_id' },
  typical_set: { table: 'cms_typical_sets', key: 'typical_set_id' }, pattern: { table: 'cms_patterns', key: 'pattern_id' },
};

export async function saveCurriculum(p: { kind: Kind; action: 'create' | 'update' | 'retire' | 'restore'; id?: string; fields?: Record<string, unknown>; reason?: string }) {
  const { data, error } = await supabase.rpc('cms_save_curriculum', { p });
  if (error) throw new Error(error.message);
  return data as { id: string; changed: boolean };
}
export async function curriculumOwner(): Promise<'workbooks' | 'cms'> {
  const { data } = await supabase.from('cms_config').select('value').eq('key', 'curriculum_owner').maybeSingle();
  return data?.value === 'cms' ? 'cms' : 'workbooks';
}

type Field = { key: string; label: string; type?: 'text' | 'area' | 'number' | 'check' | 'select'; options?: [string, string][]; createOnly?: boolean; more?: boolean; hint?: string; required?: boolean };
const FIELDS: Record<Kind, Field[]> = {
  chapter: [
    { key: 'subject', label: 'Subject', type: 'select', options: [['math', 'Math'], ['science', 'Science'], ['grammar', 'English Grammar']], createOnly: true, required: true },
    { key: 'strand_id', label: 'Strand', type: 'select', required: true },
    { key: 'name', label: 'Chapter name', required: true },
    { key: 'display_code', label: 'Display code', hint: 'e.g. NUM-01' },
    { key: 'scope', label: 'Scope (what belongs here)', type: 'area' },
    { key: 'sort', label: 'Sort order', type: 'number', more: true },
  ],
  topic: [
    { key: 'chapter_id', label: 'Chapter', type: 'select', createOnly: true, required: true },
    { key: 'class', label: 'Class', type: 'select', options: [1, 2, 3, 4, 5, 6].map((c) => [String(c), `Class ${c}`]), createOnly: true, required: true },
    { key: 'topic_kind', label: 'Kind', type: 'select', options: [['normal', 'Topic'], ['achievers', 'Achievers row (chapter level)']], createOnly: true },
    { key: 'name', label: 'Topic name', required: true },
    { key: 'sub_skills', label: 'Sub-skills', type: 'area', hint: 'separated by ;' },
    { key: 'level', label: 'Level', type: 'number' },
    { key: 'seq', label: 'Seq (Class View order)', type: 'number', more: true },
    { key: 'taught_in_school', label: 'Taught in school (NCERT or DAV)', type: 'check', more: true },
    { key: 'notes', label: 'Notes', type: 'area', more: true },
  ],
  concept: [
    { key: 'code', label: 'Code', hint: '2–4 capital letters, e.g. FRC; the ID becomes G<class>-<code>-C<n>', createOnly: true, required: true },
    { key: 'type', label: 'Type', type: 'select', options: [['core', 'Core (C)'], ['applied', 'Applied (A)']], createOnly: true },
    { key: 'name', label: 'Concept name', required: true },
    { key: 'description', label: 'Description', type: 'area' },
    { key: 'includes', label: 'Includes', type: 'area', more: true },
    { key: 'excludes', label: 'Excludes', type: 'area', more: true },
    { key: 'example_question', label: 'Example question (our own wording)', type: 'area', more: true },
  ],
  typical_set: [
    { key: 'name', label: 'Question type name', required: true, hint: 'the ID is made from it: TS-G<class>-NAME' },
    { key: 'instruction_pattern', label: 'Instruction the child sees', hint: 'e.g. "Which is bigger?"' },
    { key: 'parent_visible', label: 'Visible to parents', type: 'check' },
    { key: 'variant_note', label: 'Variant note', type: 'area', more: true },
  ],
  pattern: [
    { key: 'typical_set_id', label: 'Question type', type: 'select', createOnly: true, required: true },
    { key: 'name', label: 'Pattern name', required: true, hint: 'the maths skeleton and every skill-changing constraint, never the story' },
    { key: 'template', label: 'Template', type: 'area' },
    { key: 'notes', label: 'Notes', type: 'area', more: true },
  ],
};

interface Link { class: number; source: string; evidence: string }

/**
 * The form. `id` null = add. `fixed` = values set by where the form was opened (e.g. topic_id).
 * `options` fills selects (strands, chapters, question types).
 */
export function CurriculumForm({ kind, id, fixed = {}, options = {}, onDone }: {
  kind: Kind; id: string | null; fixed?: Record<string, unknown>; options?: Record<string, [string, string][]>; onDone: (savedId: string | null) => void;
}) {
  const [row, setRow] = useState<Record<string, unknown> | null>(id ? null : { parent_visible: true, type: 'core', topic_kind: 'normal', ...fixed });
  const [before, setBefore] = useState<Record<string, unknown>>({});
  const [classes, setClasses] = useState<Link[] | null>(null);
  const [prereqs, setPrereqs] = useState<string>('');
  const [prereqNames, setPrereqNames] = useState<Map<string, string>>(new Map());
  const [owner, setOwner] = useState<'workbooks' | 'cms' | null>(null);
  const [more, setMore] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [history, setHistory] = useState<{ at: string; action: string; reason: string | null; field_diff: Record<string, { before: unknown; after: unknown }> | null; by_label: string }[]>([]);
  const t = TABLE[kind];

  useEffect(() => {
    curriculumOwner().then(setOwner).catch(() => setOwner('workbooks'));
    if (!id) return;
    supabase.from(t.table).select('*').eq(t.key, id).maybeSingle().then(({ data }) => { setRow(data ?? {}); setBefore(data ?? {}); });
    supabase.from('cms_reviews').select('at, action, reason, field_diff, by_label').eq('target_id', id).order('review_id', { ascending: false }).limit(20)
      .then(({ data }) => setHistory((data ?? []) as never));
    if (kind === 'topic') {
      supabase.from('cms_topic_classes').select('class, source, evidence').eq('topic_id', id).order('class').then(({ data }) => setClasses(((data ?? []) as Link[]).map((x) => ({ ...x, evidence: x.evidence ?? '' }))));
      supabase.from('cms_topic_prereqs').select('prereq_topic_id').eq('topic_id', id).order('prereq_topic_id').then(({ data }) => setPrereqs((data ?? []).map((x) => x.prereq_topic_id).join(', ')));
    }
  }, [kind, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const prereqIds = prereqs.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  useEffect(() => {
    if (!prereqIds.length) { setPrereqNames(new Map()); return; }
    const h = setTimeout(() => supabase.from('cms_topics').select('topic_id, name').in('topic_id', prereqIds).then(({ data }) => setPrereqNames(new Map((data ?? []).map((x) => [x.topic_id, x.name])))), 250);
    return () => clearTimeout(h);
  }, [prereqs]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!row || owner === null) return <div className="editor card"><p className="muted">Loading…</p></div>;
  const locked = (kind === 'chapter' || kind === 'topic') && owner !== 'cms';
  const status = String(row.status ?? 'new');
  const set = (k: string, v: unknown) => setRow({ ...row, [k]: v });
  const fields = FIELDS[kind].filter((f) => !(id && f.createOnly) && !(f.key in fixed));

  async function save(action: 'create' | 'update' | 'retire' | 'restore') {
    setBusy(true); setErr(null);
    try {
      const f: Record<string, unknown> = {};
      if (action === 'create' || action === 'update') {
        for (const x of FIELDS[kind]) {
          if (locked && kind === 'topic') continue;
          if (id && x.createOnly) continue;
          const v = row![x.key];
          if (action === 'create' || JSON.stringify(v ?? null) !== JSON.stringify(before[x.key] ?? null)) f[x.key] = x.type === 'number' ? (v === '' || v === null || v === undefined ? null : Number(v)) : v;
        }
        if (action === 'create') Object.assign(f, fixed);
        if (kind === 'topic' && id) {
          if (classes) f.classes = classes.filter((c) => c.class).map((c) => ({ class: Number(c.class), source: c.source.trim(), evidence: c.evidence.trim() || null }));
          f.prereqs = prereqIds;
        }
      }
      const r = await saveCurriculum({ kind, action, id: id ?? undefined, fields: f, reason: reason.trim() || undefined });
      onDone(r.id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const input = (x: Field): ReactNode => {
    const v = row[x.key];
    const dis = locked;
    const opts = x.options ?? options[x.key] ?? [];
    if (x.type === 'check') return <label key={x.key} className="check small"><input type="checkbox" disabled={dis} checked={!!v} onChange={(e) => set(x.key, e.target.checked)} /> {x.label}</label>;
    return (
      <label key={x.key} className={x.type === 'area' ? 'wide' : ''}>{x.label}{x.required && ' *'}{x.hint && <span className="muted small"> — {x.hint}</span>}
        {x.type === 'area' ? <textarea rows={2} disabled={dis} value={String(v ?? '')} onChange={(e) => set(x.key, e.target.value)} />
          : x.type === 'select' ? <select disabled={dis} value={String(v ?? '')} onChange={(e) => set(x.key, e.target.value)}><option value="">—</option>{opts.map(([a, b]) => <option key={a} value={a}>{b}</option>)}</select>
          : <input type={x.type === 'number' ? 'number' : 'text'} disabled={dis} value={String(v ?? '')} onChange={(e) => set(x.key, e.target.value)} />}
      </label>
    );
  };
  return (
    <div className="editor card curriculum-form">
      <div className="group-title">{id ? <>Edit {LABEL[kind]} <span className="mono">{id}</span> <span className={`tag ${status}`}>{status}</span></> : <>Add a {LABEL[kind]}</>}</div>
      {!id && <div className="muted small">The ID is given by the CMS when you save, and never changes.{kind !== 'chapter' && kind !== 'topic' ? ' New items start as Proposed.' : ''}</div>}
      {locked && <div className="notice small">Chapters and topics still come from the topic workbooks until the one-time cut-over{kind === 'topic' && id ? '; you can already set this topic\'s classes and prerequisites below.' : '. This form saves after the cut-over.'}</div>}
      <div className="form-grid">{fields.filter((x) => !x.more).map(input)}</div>
      {fields.some((x) => x.more) && <button className="link more" aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'Less' : 'More'}: {fields.filter((x) => x.more).map((x) => x.label.toLowerCase()).join(', ')}</button>}
      {more && <div className="form-grid">{fields.filter((x) => x.more).map(input)}</div>}
      {kind === 'topic' && id && (
        <div className="links-edit">
          <div className="small"><strong>Also taught in</strong> <span className="muted">(D2: other classes besides its own class {String(row.class)}; source and evidence)</span></div>
          {(classes ?? []).map((c, i) => (
            <div key={i} className="jump-row three">
              <select value={c.class || ''} onChange={(e) => setClasses(classes!.map((x, k) => (k === i ? { ...x, class: Number(e.target.value) } : x)))}><option value="">Class…</option>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>Class {n}</option>)}</select>
              <select value={c.source} onChange={(e) => setClasses(classes!.map((x, k) => (k === i ? { ...x, source: e.target.value } : x)))}>{['NCERT', 'DAV', 'ISO', 'IXL', 'workbook-default', 'CMS'].map((s) => <option key={s}>{s}</option>)}</select>
              <input placeholder="evidence (citation, not book text)" value={c.evidence} onChange={(e) => setClasses(classes!.map((x, k) => (k === i ? { ...x, evidence: e.target.value } : x)))} />
              <button className="link" onClick={() => setClasses(classes!.filter((_, k) => k !== i))}>Remove</button>
            </div>
          ))}
          <button className="link" onClick={() => setClasses([...(classes ?? []), { class: 0, source: 'NCERT', evidence: '' }])}>+ Add a class</button>
          <label className="small">Prerequisites <span className="muted">(D4: topic IDs, comma separated)</span>
            <input value={prereqs} onChange={(e) => setPrereqs(e.target.value)} placeholder="MT0393, MT0401" /></label>
          {prereqIds.length > 0 && <div className="small">{prereqIds.map((p) => <span key={p} className={prereqNames.has(p) ? '' : 'error'}>{p} {prereqNames.get(p) ?? '(not a topic)'} · </span>)}</div>}
        </div>
      )}
      <label className="small">Reason <span className="muted">(optional; logged with the change)</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      {err && <p className="error small">{err}</p>}
      <div className="editor-actions">
        <button disabled={busy || (locked && !(kind === 'topic' && id))} onClick={() => save(id ? 'update' : 'create')}>{busy ? 'Saving…' : 'Save'}</button>
        <button className="secondary" disabled={busy} onClick={() => onDone(null)}>Cancel</button>
        <span className="spacer" />
        {id && status !== 'retired' && <button className="link" disabled={busy || locked} onClick={() => save('retire')} title="Hidden from Browse and new work; the ID and history are kept">Retire…</button>}
        {id && status === 'retired' && <button className="link" disabled={busy || locked} onClick={() => save('restore')}>Restore</button>}
      </div>
      {id && history.length > 0 && (
        <div className="history small">
          <div className="eyebrow">History</div>
          <ul className="plain">{history.map((h, i) => (
            <li key={i}>{new Date(h.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} · {h.action.replace(/_/g, ' ')} · {h.by_label}{h.reason ? ` — ${h.reason}` : ''}
              {h.field_diff && Object.keys(h.field_diff).length > 0 && <div className="muted">{Object.entries(h.field_diff).map(([k, d]) => `${k}: ${short(d?.before)} → ${short(d?.after)}`).join(' · ')}</div>}</li>
          ))}</ul>
        </div>
      )}
    </div>
  );
}
const short = (v: unknown) => { const s = v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v); return s.length > 80 ? `${s.slice(0, 77)}…` : s; };

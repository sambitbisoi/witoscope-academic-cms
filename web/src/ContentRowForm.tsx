// Q14 (Sambit, 17 Nov 2026): add and edit Science content rows in the CMS (the master since 17 Nov 2026).
// One form for "+ Add content row" (on a topic) and "Edit row" (on an open row), with an explicit Save through
// cms_save_content_row: fields, misconception items (add / edit text / retire / restore; numbers never reused),
// Retire / Restore of the row. No originality check: Sambit's own writing (source "CMS").
import { useEffect, useMemo, useState } from 'react';
import { CHAPTER_ROLES, nextRowId, QUESTION_USES, ROW_TYPES, rowItems, rowUsage, saveContentRow, topicClasses, topicRowCodes,
  type ItemChange, type RowFields, type RowItem, type ScienceRow } from './scienceApi';

type Usage = Awaited<ReturnType<typeof rowUsage>>;
interface ItemDraft { item_no: number | null; text: string; was: string; status: RowItem['status']; retire: boolean; restore: boolean }
const blank = (cls: number): RowFields => ({ row_class: cls, type: 'Fact', chapter_role: 'Core', content: '', why_it_matters: null, diagram_description: null,
  question_use: 'OK', safety: null, also_in_rows: [], notes: null, picture_question: false, confidence: null });
const fieldsOf = (r: ScienceRow): RowFields => ({ row_class: r.row_class, type: r.type, chapter_role: r.chapter_role, content: r.content, why_it_matters: r.why_it_matters,
  diagram_description: r.diagram_description, question_use: r.question_use, safety: r.safety, also_in_rows: r.also_in_rows, notes: r.notes,
  picture_question: r.picture_question, confidence: r.confidence });
const norm = (v: unknown) => (typeof v === 'string' ? v.trim() || null : v);
const LABEL: Record<keyof RowFields, string> = { row_class: 'Row class', type: 'Type', chapter_role: 'Chapter role', content: 'Content', why_it_matters: 'Why it matters',
  diagram_description: 'Diagram description', question_use: 'Question use', safety: 'Safety', also_in_rows: 'Also in', notes: 'Notes', picture_question: 'Picture question', confidence: 'Confidence' };

export function ContentRowForm({ topic, defaultClass, row, onDone }: {
  topic: { topic_id: string; name: string }; defaultClass: number; /** edit this row; absent = a new row */ row?: ScienceRow;
  onDone: (rowId: string | null) => void;
}) {
  const [f, setF] = useState<RowFields>(() => (row ? fieldsOf(row) : blank(defaultClass)));
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [codes, setCodes] = useState<Map<number, { code: string; n: number }[]> | null>(null);
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState('');
  const [linked, setLinked] = useState<number[] | null>(null);
  const [alsoIn, setAlsoIn] = useState((row?.also_in_rows ?? []).join(', '));
  const [reason, setReason] = useState('');
  const [retiring, setRetiring] = useState(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    topicClasses(topic.topic_id).then(setLinked).catch(() => setLinked(null));
    if (row) {
      rowItems([row.row_id], true).then((xs) => setItems(xs.map((i) => ({ item_no: i.item_no, text: i.text, was: i.text, status: i.status, retire: false, restore: false })))).catch((e) => setError(e.message));
      rowUsage(row.row_id).then(setUsage).catch((e) => setError(e.message));
    } else topicRowCodes(topic.topic_id).then(setCodes).catch((e) => setError(e.message));
  }, [topic.topic_id, row?.row_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // a new row: the codes this topic already uses for the chosen row class (most used first), else the CMS series
  const classCodes = useMemo(() => (codes?.get(f.row_class) ?? []), [codes, f.row_class]);
  useEffect(() => { if (!row && codes) setCode(classCodes[0]?.code ?? 'CMS'); }, [classCodes, codes, row]);
  useEffect(() => { if (!row && code) nextRowId(f.row_class, code).then(setPreview).catch(() => setPreview('')); }, [row, code, f.row_class]);

  const set = <K extends keyof RowFields>(k: K, v: RowFields[K]) => setF((x) => ({ ...x, [k]: v }));
  const alsoIds = alsoIn.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  const after: RowFields = { ...f, also_in_rows: alsoIds };
  const before = row ? fieldsOf(row) : null;
  const changedFields = (Object.keys(after) as (keyof RowFields)[]).filter((k) => !before || JSON.stringify(norm(after[k])) !== JSON.stringify(norm(before[k])));
  const itemChanges: ItemChange[] = [
    ...items.filter((i) => i.item_no !== null && i.status !== 'retired' && !i.retire && i.text.trim() !== i.was).map((i) => ({ item_no: i.item_no, action: 'edit' as const, text: i.text })),
    ...items.filter((i) => i.item_no !== null && i.retire && i.status !== 'retired').map((i) => ({ item_no: i.item_no, action: 'retire' as const })),
    ...items.filter((i) => i.item_no !== null && i.restore && i.status === 'retired').map((i) => ({ item_no: i.item_no, action: 'restore' as const })),
    ...items.filter((i) => i.item_no === null && i.text.trim()).map((i) => ({ item_no: null, action: 'add' as const, text: i.text })),
  ];
  const touchedUsers = itemChanges.filter((c) => c.item_no !== null && (c.action === 'edit' || c.action === 'retire'))
    .map((c) => ({ ref: `${row?.row_id} #${c.item_no}`, action: c.action, qs: usage?.items.get(c.item_no!) ?? [] })).filter((x) => x.qs.length);
  const errors = [
    ...(!f.content.trim() ? ['Content is required.'] : []),
    ...(items.some((i) => i.item_no !== null && i.status !== 'retired' && !i.retire && !i.text.trim()) ? ['An item has no text; retire it instead.'] : []),
    ...(alsoIds.filter((x) => !/^C[1-6]-[0-9A-Z]{2,4}-\d{3}$/.test(x)).map((x) => `Also in: "${x}" is not a row ID.`)),
  ];
  const nothing = !!row && changedFields.length === 0 && itemChanges.length === 0;
  const classWarn = linked && !linked.includes(f.row_class) ? `Class ${f.row_class} isn't linked to this topic (it is linked to ${linked.join(', ')}). Add the link on the topic screen if this row belongs there; nothing is linked automatically.` : null;

  async function save() {
    setBusy(true); setError(null);
    try {
      const fields = row ? Object.fromEntries(changedFields.map((k) => [k, after[k]])) : after;
      const r = await saveContentRow(row ? { mode: 'update', row_id: row.row_id, fields, items: itemChanges, reason: reason.trim() || null }
        : { mode: 'create', topic_id: topic.topic_id, code, fields, items: itemChanges, reason: reason.trim() || null });
      onDone(r.row_id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function retireOrRestore(mode: 'retire' | 'restore') {
    setBusy(true); setError(null);
    try { await saveContentRow({ mode, row_id: row!.row_id, reason: reason.trim() || null }); onDone(row!.row_id); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (row?.retired_at) return (
    <div className="row-form">
      <h2>Row {row.row_id} <span className="tag gone">Retired</span></h2>
      <p className="small muted">Retired: {row.retired_reason}. Restore it to edit it again.</p>
      <label className="wide small">Reason (optional, kept in the audit log)<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      {error && <p className="error small">{error}</p>}
      <div className="editor-actions"><button onClick={() => retireOrRestore('restore')} disabled={busy}>Restore row</button><button className="secondary" onClick={() => onDone(null)}>Cancel</button></div>
    </div>
  );

  return (
    <div className="row-form">
      <h2>{row ? <>Edit row <span className="mono">{row.row_id}</span></> : 'New content row'}</h2>
      <div className="muted small">{topic.name} · <span className="mono">{topic.topic_id}</span> · the CMS is the master for content rows; no originality check (your own writing)</div>

      <div className="edit-sec">
        <div className="form-grid">
          <label>Row class<select value={f.row_class} onChange={(e) => set('row_class', Number(e.target.value))}>{[1, 2, 3, 4, 5, 6].map((c) => <option key={c} value={c}>Class {c}</option>)}</select></label>
          {!row && <label>Chapter code (row ID)<select value={code} onChange={(e) => setCode(e.target.value)}>
            {classCodes.map((c) => <option key={c.code} value={c.code}>{c.code} ({c.n} row{c.n === 1 ? "" : "s"})</option>)}
            <option value="CMS">CMS · the CMS series</option></select></label>}
          <label>Type<select value={f.type} onChange={(e) => set('type', e.target.value)}>{ROW_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
          <label>Chapter role<select value={f.chapter_role} onChange={(e) => set('chapter_role', e.target.value)}>{CHAPTER_ROLES.map((t) => <option key={t}>{t}</option>)}</select></label>
          <label>Question use<select value={f.question_use} onChange={(e) => set('question_use', e.target.value)}>{QUESTION_USES.map((t) => <option key={t}>{t}</option>)}</select></label>
        </div>
        {!row && <p className="small"><span className="muted">New ID:</span> <strong className="mono">{preview || '…'}</strong> <span className="muted">(given on Save; never changes)</span></p>}
        {classWarn && <p className="small warn">{classWarn}</p>}
        <label className="wide">Content<textarea rows={3} value={f.content} onChange={(e) => set('content', e.target.value)} /></label>
        <label className="wide">Why it matters / real-life link<textarea rows={2} value={f.why_it_matters ?? ''} onChange={(e) => set('why_it_matters', e.target.value)} /></label>
      </div>

      <div className="edit-sec">
        <div className="eyebrow">Common misconceptions · items</div>
        {items.length === 0 && <p className="small muted">{row?.misconceptions ? <>No items yet. The row's text stays as it is until you add an item: “{row.misconceptions}”</> : 'No items yet.'}</p>}
        <ol className="plain row-items">{items.map((i, n) => (
          <li key={i.item_no ?? `new-${n}`} className={i.status === 'retired' && !i.restore ? 'muted' : ''}>
            <span className="mono muted">{i.item_no ? `#${i.item_no}` : 'new'}</span>
            <input value={i.text} disabled={(i.status === 'retired' && !i.restore) || i.retire} onChange={(e) => setItems((xs) => xs.map((x, k) => (k === n ? { ...x, text: e.target.value } : x)))} />
            {i.item_no === null ? <button className="link small" onClick={() => setItems((xs) => xs.filter((_, k) => k !== n))}>Remove</button>
              : i.status === 'retired' ? <label className="check small"><input type="checkbox" checked={i.restore} onChange={(e) => setItems((xs) => xs.map((x, k) => (k === n ? { ...x, restore: e.target.checked } : x)))} /> Restore</label>
              : <label className="check small"><input type="checkbox" checked={i.retire} onChange={(e) => setItems((xs) => xs.map((x, k) => (k === n ? { ...x, retire: e.target.checked } : x)))} /> Retire</label>}
            {i.status === 'retired' && <span className="tag gone">Retired</span>}
            {i.status === 'needs_review' && <span className="tag proposed">Needs review</span>}
            {i.item_no !== null && (usage?.items.get(i.item_no)?.length ?? 0) > 0 && <span className="muted small"> used by {usage!.items.get(i.item_no)!.length}</span>}
          </li>))}</ol>
        <button className="link" onClick={() => setItems((xs) => [...xs, { item_no: null, text: '', was: '', status: 'active', retire: false, restore: false }])}>+ Add item</button>
        <p className="small muted">New items are active at once. Numbers are never reused; a retired item keeps its number.</p>
      </div>

      <div className="edit-sec">
        <label className="wide">Diagram description<textarea rows={2} value={f.diagram_description ?? ''} onChange={(e) => set('diagram_description', e.target.value)} /></label>
        <label className="wide">Safety<input value={f.safety ?? ''} onChange={(e) => set('safety', e.target.value)} /></label>
        <label className="wide">Also in (row IDs, separated by commas)<input value={alsoIn} onChange={(e) => setAlsoIn(e.target.value)} placeholder="C5-03-012, C6-04-001" /></label>
        <label className="wide">Notes<textarea rows={2} value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></label>
        <button className="link more small" aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'Less' : 'More'}: picture question, confidence</button>
        {more && <div className="form-grid">
          <label className="check"><input type="checkbox" checked={f.picture_question} onChange={(e) => set('picture_question', e.target.checked)} /> Picture question</label>
          <label>Confidence<select value={f.confidence ?? ''} onChange={(e) => set('confidence', e.target.value || null)}><option value="">—</option>{['high', 'medium', 'low'].map((c) => <option key={c}>{c}</option>)}</select></label>
        </div>}
      </div>

      <div className={`save-preview ${nothing ? 'idle' : ''}`}>
        <div className="eyebrow">When you click Save</div>
        <div><strong>{nothing ? 'No changes to save.' : row ? `Update ${row.row_id}: ${[...changedFields.map((k) => LABEL[k]), ...(itemChanges.length ? [`${itemChanges.length} item change${itemChanges.length === 1 ? '' : 's'}`] : [])].join(', ')}.`
          : `Add ${preview || 'a new row'} to ${topic.topic_id}${itemChanges.length ? ` with ${itemChanges.length} item${itemChanges.length === 1 ? '' : 's'}` : ''}.`}</strong></div>
        {touchedUsers.map((u) => <div key={u.ref} className="small warn">{u.ref} is used by {u.qs.join(', ')}; {u.action === 'retire' ? 'retiring it blocks their approval until they pick another item.' : 'they keep the reference and show the new text.'}</div>)}
        {errors.map((e) => <div key={e} className="small error">{e}</div>)}
        {!nothing && <label className="wide small">Reason (optional, kept in the audit log)<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
        {error && <p className="error small">{error}</p>}
        <div className="editor-actions">
          <button onClick={save} disabled={busy || nothing || errors.length > 0 || (!row && !code)}>{busy ? 'Saving…' : 'Save'}</button>
          <button className="secondary" onClick={() => onDone(null)} disabled={busy}>Cancel</button>
          {row && !retiring && <button className="link small" onClick={() => setRetiring(true)}>Retire row…</button>}
        </div>
        {row && retiring && <div className="retire-box small">
          {usage && usage.direct.length > 0 ? <p className="error">Can't retire: it is the direct row of {usage.direct.join(', ')}. Move or retire those questions first.</p> : <>
            {usage && usage.supporting.length > 0 && <p className="warn">It is a supporting row of {usage.supporting.join(', ')}; they keep the link.</p>}
            <label className="wide">Why retire it (required)<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            <div className="editor-actions"><button onClick={() => retireOrRestore('retire')} disabled={busy || !reason.trim()}>Retire {row.row_id}</button>
              <button className="secondary" onClick={() => setRetiring(false)}>Keep it</button></div>
          </>}
        </div>}
      </div>
    </div>
  );
}

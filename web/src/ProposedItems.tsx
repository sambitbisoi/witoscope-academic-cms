// Proposed → Misconception items (Sambit, 16 Nov 2026; Q16 decision 2): status only. Items proposed "from question"
// (and any item set back to needs review) are approved or retired here; a question that uses a needs-review item
// can't be approved. No text editing (that is Q14, content-row editing). Every decision is logged; nothing is deleted.
import { useEffect, useState } from 'react';
import { Id } from './Id';
import { browseHash } from './logic';
import { itemsByStatus, setRowItemStatus } from './scienceApi';

type Show = 'proposed' | 'active' | 'retired';
const STATUS = { proposed: 'needs_review', active: 'active', retired: 'retired' } as const;

export function RowItemsTab({ show }: { show: Show }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof itemsByStatus>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retire, setRetire] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reload, setReload] = useState(0);
  const [text, setText] = useState('');
  useEffect(() => { setItems(null); setErr(null); itemsByStatus(STATUS[show]).then(setItems).catch((e) => setErr(e.message)); }, [show, reload]);

  const act = async (row: string, no: number, status: 'active' | 'retired' | 'needs_review', why: string | null) => {
    setBusy(true); setErr(null);
    try { await setRowItemStatus(row, no, status, why); setRetire(null); setReason(''); setReload((x) => x + 1); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const q = text.trim().toLowerCase();
  const shown = (items ?? []).filter((i) => !q || `${i.row_id} #${i.item_no} ${i.text} ${i.proposed_by ?? ''} ${i.row?.topic_id ?? ''}`.toLowerCase().includes(q));

  return (
    <>
      <p className="muted small">Misconception items of Science content rows ("C6-04-014 #2"). Items proposed from an existing question's misconception start as <strong>needs review</strong>: approve one to let its questions be approved, or retire it (reason needed; kept, never deleted). Status only: item text is not edited here.</p>
      <div className="filters">
        <input className="search-in" placeholder="Filter by item, text, question or topic" value={text} onChange={(e) => setText(e.target.value)} />
        {items && <span className="muted small">{shown.length} of {items.length}</span>}
      </div>
      {err && <p className="error">{err}</p>}
      {!items && !err && <p className="muted">Loading…</p>}
      {items && shown.length === 0 && <p className="muted">Nothing here.</p>}
      {items && shown.length > 0 && (
        <table className="list proposed-table">
          <thead><tr><th>Item</th><th>Misconception</th><th>Row</th><th className="col-wide">Source</th><th /></tr></thead>
          <tbody>
            {shown.slice(0, 500).map((i) => {
              const key = `${i.row_id} #${i.item_no}`;
              return (
                <tr key={key}>
                  <td className="mono nowrap">{key}</td>
                  <td className="col-name"><div>{i.text}</div>{i.split_note && <div className="muted small">{i.split_note}</div>}</td>
                  <td className="small">{i.row ? <><a href={browseHash({ subject: 'science', cls: String(i.row.row_class), topic: i.row.topic_id, row: i.row_id, tab: 'content' })}>Class {i.row.row_class} row</a> <Id>{i.row.topic_id}</Id>
                    <div className="muted">{i.row.content.slice(0, 90)}{i.row.content.length > 90 ? '…' : ''}</div></> : i.row_id}</td>
                  <td className="small col-wide nowrap">{i.source}{i.proposed_by ? <> · <a href={`#/q/${encodeURIComponent(i.proposed_by)}`}>{i.proposed_by}</a></> : null}</td>
                  <td className="nowrap">
                    {i.status === 'needs_review' && <><button className="approve small-btn" disabled={busy} onClick={() => act(i.row_id, i.item_no, 'active', null)}>Approve</button>{' '}</>}
                    {i.status !== 'retired' && (retire === key
                      ? <span className="reason"><input autoFocus placeholder="Why retire it? (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
                          <button disabled={busy || !reason.trim()} onClick={() => act(i.row_id, i.item_no, 'retired', reason)}>Confirm</button> <button className="link small" onClick={() => setRetire(null)}>Cancel</button></span>
                      : <button className="link small" disabled={busy} onClick={() => { setRetire(key); setReason(''); }}>Retire…</button>)}
                    {i.status !== 'needs_review' && <> <button className="link small" disabled={busy} onClick={() => act(i.row_id, i.item_no, 'needs_review', 'back to needs review')}>Back to needs review</button></>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {items && shown.length > 500 && <p className="muted small">Showing the first 500 of {shown.length}; filter to narrow the list.</p>}
    </>
  );
}

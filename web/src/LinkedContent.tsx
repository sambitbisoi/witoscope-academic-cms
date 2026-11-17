// Q23 (Sambit, 17 Nov 2026; docs/plan-2026-11-17-q23-q35.md): edit the linked content rows of a Science question, in the
// Science review box and the Science Edit form. "+ Link a row" (search by row ID or text), change a link's role
// (primary / secondary / supporting), remove a link. Exactly one primary, confirmed by Save. A row still used by the
// misconception targeted, a wrong option's item or a concept-error target can't be removed or made supporting.
// Open drafts only; explicit Save; one audit row (cms_save_content_links, 0044).
import { useEffect, useState } from 'react';
import { Id } from './Id';
import { linkedContent, saveContentLinks, searchContentRows, type LinkedRow } from './scienceApi';
import { linkChecks, LINK_ROLE_LABEL, type DraftLink, type LinkRank } from './scienceLogic';

type Data = Awaited<ReturnType<typeof linkedContent>>;
type Found = Awaited<ReturnType<typeof searchContentRows>>[number];
const RANKS: LinkRank[] = ['primary', 'secondary', 'context'];
const short = (s: string | undefined, n = 110) => (!s ? '' : s.length > n ? `${s.slice(0, n)}…` : s);

export function LinkedContent({ questionId, versionId, versionNo, status, onSaved, compact = false }: {
  questionId: string; versionId: number; versionNo: number; status: string; onSaved?: () => void;
  /** in the review box: the label column layout of the box */ compact?: boolean;
}) {
  const open = status === 'draft' || status === 'in_review';
  const [data, setData] = useState<Data | null>(null);
  const [draft, setDraft] = useState<DraftLink[]>([]);
  const [extra, setExtra] = useState<Map<string, Found>>(new Map());
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [addRank, setAddRank] = useState<LinkRank>('secondary');
  const [found, setFound] = useState<Found[]>([]);

  useEffect(() => {
    let live = true;
    linkedContent(versionId).then((d) => { if (!live) return; setData(d); setDraft(d.links.map((l) => ({ row_id: l.row_id, rank: l.rank }))); setExtra(new Map()); })
      .catch((e) => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [versionId, tick]);
  useEffect(() => {
    if (!adding) return;
    let live = true;
    const t = setTimeout(() => { searchContentRows(search, draft.map((l) => l.row_id)).then((r) => live && setFound(r)).catch((e) => live && setErr((e as Error).message)); }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [search, adding, draft]);

  if (!data) return err ? <div className="error small">{err}</div> : <div className="muted small">Loading linked content…</div>;
  const savedLinks: DraftLink[] = data.links.map((l) => ({ row_id: l.row_id, rank: l.rank }));
  const chk = linkChecks(draft, savedLinks, data.refs);
  const proposed = data.links.find((l) => l.rank === 'primary' && l.rank_proposed);
  const dirty = chk.dirty || (!!proposed && draft.some((l) => l.rank === 'primary'));
  const rowOf = (id: string): Pick<NonNullable<LinkedRow['row']>, 'content' | 'row_class'> & { retired_at?: string | null } | null =>
    data.links.find((l) => l.row_id === id)?.row ?? extra.get(id) ?? null;

  const setRank = (id: string, rank: LinkRank) => setDraft((d) => d.map((l) => l.row_id === id ? { ...l, rank }
    : rank === 'primary' && l.rank === 'primary' ? { ...l, rank: 'secondary' } : l));
  const remove = (id: string) => setDraft((d) => d.filter((l) => l.row_id !== id));
  const add = (r: Found) => {
    setExtra((m) => new Map(m).set(r.row_id, r));
    setDraft((d) => [...(addRank === 'primary' ? d.map((l) => l.rank === 'primary' ? { ...l, rank: 'secondary' as LinkRank } : l) : d), { row_id: r.row_id, rank: addRank }]);
    setSearch(''); setFound([]); setAdding(false);
  };
  const reset = () => { setDraft(savedLinks); setErr(null); setAdding(false); };
  const save = async () => {
    setBusy(true); setErr(null); setSaved(false);
    try {
      await saveContentLinks({ question_id: questionId, version_no: versionNo, reason: 'Linked content', links: draft });
      setSaved(true); setTick((t) => t + 1); onSaved?.();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const ordered = [...draft].sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank));
  const body = (
    <div className="lc">
      {ordered.length === 0 && <div className="muted small">No linked rows.</div>}
      <ul className="lc-list">
        {ordered.map((l) => {
          const r = rowOf(l.row_id); const lock = chk.lock.get(l.row_id); const isNew = !savedLinks.some((s) => s.row_id === l.row_id);
          const was = savedLinks.find((s) => s.row_id === l.row_id)?.rank;
          return (
            <li key={l.row_id} className={`lc-row rank-${l.rank}`}>
              <div className="lc-head">
                {open ? <select aria-label={`Role of ${l.row_id}`} value={l.rank} onChange={(e) => setRank(l.row_id, e.target.value as LinkRank)}>
                  {RANKS.map((k) => <option key={k} value={k} disabled={k === 'context' && !!lock?.support} title={k === 'context' ? lock?.support ?? '' : ''}>{LINK_ROLE_LABEL[k]}</option>)}
                </select> : <span className={`tag rank-${l.rank}`}>{LINK_ROLE_LABEL[l.rank]}</span>}
                {isNew && <span className="tag proposed">new</span>}
                {!isNew && was !== l.rank && <span className="tag proposed">was {LINK_ROLE_LABEL[was!].toLowerCase()}</span>}
                {r?.retired_at && <span className="tag">retired row</span>}
                {open && <button className="link small lc-remove" disabled={!!lock?.remove} title={lock?.remove ?? 'Remove this link'} onClick={() => remove(l.row_id)}>Remove</button>}
              </div>
              <div className="lc-text small">
                {short(r?.content, 160) || <span className="muted">Row not found.</span>} <Id>{l.row_id}</Id>
                {lock?.remove && <div className="muted">Keeps it linked: {data.refs.filter((x) => x.row_id === l.row_id).map((x) => x.what).join(' · ')}</div>}
              </div>
            </li>
          );
        })}
      </ul>
      {open && (adding ? (
        <div className="lc-add">
          <input autoFocus aria-label="Search content rows" placeholder="Row ID or words from the row" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="lc-add-bar">
            <label className="small">Link as <select aria-label="Role of the new link" value={addRank} onChange={(e) => setAddRank(e.target.value as LinkRank)}>
              {RANKS.map((k) => <option key={k} value={k}>{LINK_ROLE_LABEL[k]}</option>)}</select></label>
            <button className="link small" onClick={() => { setAdding(false); setSearch(''); setFound([]); }}>Cancel</button>
          </div>
          {search.trim().length >= 2 && <ul className="lc-found">
            {found.length === 0 && <li className="muted small">No row found (retired rows and rows already linked are left out).</li>}
            {found.map((r) => <li key={r.row_id}><button className="secondary small" onClick={() => add(r)}>Link</button>
              <span className="small">{short(r.content, 120)} <span className="muted">· Class {r.row_class}</span> <Id>{r.row_id}</Id></span></li>)}
          </ul>}
        </div>
      ) : <button className="link small lc-plus" onClick={() => setAdding(true)}>+ Link a row</button>)}
      {open && <>
        {proposed && <div className="small warn-text">Primary {proposed.row_id} was proposed by the rationaliser: keep or change it, then Save to confirm it.</div>}
        {chk.problems.map((p) => <div key={p} className="small warn-text">{p}</div>)}
        <div className="sci-rv-actions">
          <button disabled={busy || !dirty || chk.problems.length > 0} onClick={save}>Save links</button>{' '}
          <button className="link" disabled={busy || !chk.dirty} onClick={reset}>Reset</button>
          {saved && !chk.dirty && <span className="muted small"> Saved.</span>}
          <span className="muted small"> Primary and secondary rows are tested by the question; supporting rows are background.</span>
        </div>
      </>}
      {!open && <div className="muted small">v{versionNo} is {status.replace('_', ' ')}: Edit makes a new version (its links are carried), then change the links on that draft.</div>}
      {err && <div className="error small">{err}</div>}
    </div>
  );
  return compact ? <div className="sci-rv-f"><div className="sci-rv-l">Linked content</div>{body}</div> : body;
}

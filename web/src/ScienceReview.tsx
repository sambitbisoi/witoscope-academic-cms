// Science review box (Sambit, 16 Nov 2026; docs/plan-2026-11-16-q11-q18.md Q16 Q17 Q18): on an open Science draft,
// pick the misconception item (no free text), each wrong option's item, confirm the primary content row and write
// Solution 1. Only items of the question's own content rows can be picked. Explicit Save; one audit row.
// A misconception that is not an item yet can't be added here (that needs Q14, content-row editing).
import { useMemo, useState } from 'react';
import { saveScienceReview, type ScienceDetail } from './scienceApi';
import { checkSolutionSupport } from '../../shared/science-items.ts';

const ref = (r: { row_id: string; item_no: number }) => `${r.row_id} #${r.item_no}`;
const parse = (s: string) => { const m = /^(.+) #(\d+)$/.exec(s); return m ? { row_id: m[1]!, item_no: Number(m[2]) } : null; };

export function ScienceReview({ questionId, versionNo, x, options, solution1, onSaved }: {
  questionId: string; versionNo: number; x: ScienceDetail; options: { position: number; text: string; is_correct: boolean }[]; solution1: string | null; onSaved: () => void;
}) {
  const linked = new Set(x.links.map((l) => l.row_id));
  const items = useMemo(() => x.items.filter((i) => i.status !== 'retired' && linked.has(i.row_id))
    .sort((a, b) => x.links.findIndex((l) => l.row_id === a.row_id) - x.links.findIndex((l) => l.row_id === b.row_id) || a.item_no - b.item_no), [x]); // eslint-disable-line react-hooks/exhaustive-deps
  const direct = x.links.filter((l) => l.role === 'direct');
  const curPrimary = x.links.find((l) => l.rank === 'primary') ?? null;
  const curMisc = x.version.misconception_row_id ? `${x.version.misconception_row_id} #${x.version.misconception_item_no}` : '';
  const wrongOpts = options.filter((o) => !o.is_correct);

  const [misc, setMisc] = useState(curMisc);
  const [wrong, setWrong] = useState<Record<number, string>>(() => Object.fromEntries(wrongOpts.map((o) => [o.position, x.wrongItems.get(o.position) ?? ''])));
  const [primary, setPrimary] = useState(curPrimary?.row_id ?? '');
  const [primaryTouched, setPrimaryTouched] = useState(false);
  const [sol, setSol] = useState(solution1 ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const wrongChanged = wrongOpts.filter((o) => (wrong[o.position] ?? '') !== (x.wrongItems.get(o.position) ?? ''));
  const primaryChange = primaryTouched && (primary !== curPrimary?.row_id || curPrimary?.rank_proposed);
  const dirty = misc !== curMisc || wrongChanged.length > 0 || primaryChange || sol.trim() !== (solution1 ?? '').trim();

  const save = async () => {
    setBusy(true); setErr(null); setSaved(false);
    try {
      await saveScienceReview({
        question_id: questionId, version_no: versionNo, reason: 'Science review',
        ...(misc !== curMisc ? { misconception: misc ? parse(misc) : null } : {}),
        ...(wrongChanged.length ? { wrong: wrongChanged.map((o) => ({ position: o.position, mc: wrong[o.position] ? parse(wrong[o.position]!) : null })) } : {}),
        ...(primaryChange && primary ? { primary_row_id: primary } : {}),
        ...(sol.trim() !== (solution1 ?? '').trim() ? { solution1: sol } : {}),
      });
      setSaved(true); setPrimaryTouched(false); onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const reset = () => { setMisc(curMisc); setWrong(Object.fromEntries(wrongOpts.map((o) => [o.position, x.wrongItems.get(o.position) ?? '']))); setPrimary(curPrimary?.row_id ?? ''); setPrimaryTouched(false); setSol(solution1 ?? ''); setErr(null); };

  const itemSelect = (value: string, set: (v: string) => void, label: string) => (
    <select aria-label={label} value={value} onChange={(e) => set(e.target.value)}>
      <option value="">— none —</option>
      {items.map((i) => <option key={ref(i)} value={ref(i)}>{ref(i)} · {i.text}{i.status === 'needs_review' ? ' (needs review)' : ''}</option>)}
    </select>
  );

  return (
    <div className="tint-box sci-review" aria-label="Science review">
      <div className="tint-title">Science review <span className="muted small">· explicit Save · logged</span></div>

      <div className="sci-rv-f">
        <div className="sci-rv-l">Primary row</div>
        <div>
          {direct.length === 0 ? <span className="muted small">No direct row: link one first.</span> : direct.map((l) => (
            <label key={l.row_id} className="check small sci-rv-radio">
              <input type="radio" name={`primary-${questionId}`} checked={primary === l.row_id} onChange={() => { setPrimary(l.row_id); setPrimaryTouched(true); }} />
              <span className="mono">{l.row_id}</span> <span className="muted">{(l.row?.content ?? '').slice(0, 80)}{(l.row?.content.length ?? 0) > 80 ? '…' : ''}</span>
            </label>
          ))}
          {curPrimary?.rank_proposed && !primaryTouched && <div className="small warn-text">Proposed by the rationaliser: pick the primary row (it can be the same one) and Save to confirm it.</div>}
        </div>
      </div>

      <div className="sci-rv-f">
        <div className="sci-rv-l">Misconception targeted</div>
        <div>
          {itemSelect(misc, setMisc, 'Misconception targeted')}
          {x.version.misconception_targeted_legacy && <div className="muted small">Before 16 Nov: “{x.version.misconception_targeted_legacy}”</div>}
          {items.length === 0 && <div className="muted small">Its content rows have no misconception items.</div>}
        </div>
      </div>

      {wrongOpts.length > 0 && <div className="sci-rv-f">
        <div className="sci-rv-l">Wrong options</div>
        <div className="sci-rv-wrong">
          {wrongOpts.map((o) => (
            <div key={o.position} className="small"><span className="opt-label">{String.fromCharCode(64 + o.position)} · {o.text}</span>
              {itemSelect(wrong[o.position] ?? '', (v) => setWrong({ ...wrong, [o.position]: v }), `Misconception of option ${String.fromCharCode(64 + o.position)}`)}</div>
          ))}
        </div>
      </div>}

      <div className="sci-rv-f">
        <div className="sci-rv-l">Solution 1</div>
        <div>
          <textarea rows={4} value={sol} onChange={(e) => setSol(e.target.value)} aria-label="Solution 1" />
          <div className="muted small">The answer + short reasoning: why it is right, and why the key wrong options are wrong (name the misconception). Use only what its content rows say, at the row class's depth. Approve needs it.</div>
          <div className="muted small">{checkSolutionSupport(sol, []).note}</div>
        </div>
      </div>

      <div className="sci-rv-actions">
        <button disabled={busy || !dirty} onClick={save}>Save</button>{' '}
        <button className="link" disabled={busy || !dirty} onClick={reset}>Reset</button>
        {saved && !dirty && <span className="muted small"> Saved.</span>}
        <span className="muted small"> A misconception that is not an item yet can't be added here (content-row editing, Q14, is not built).</span>
      </div>
      {err && <div className="error small">{err}</div>}
    </div>
  );
}

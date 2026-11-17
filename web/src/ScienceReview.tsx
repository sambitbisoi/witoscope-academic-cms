// Science review box (Sambit, 16 Nov 2026; docs/plan-2026-11-16-q11-q18.md Q16 Q17 Q18): on an open Science draft,
// pick the misconception item (no free text), each wrong option's item, confirm the primary content row and write
// Solution 1. Only items of the question's own content rows can be picked. Explicit Save; one audit row.
// A misconception that is not an item yet is added on its row (Q14). Q23: linked content rows are edited here too (own Save).
import { useMemo, useState } from 'react';
import { browseHash, TAG_LABEL } from './logic';
import { saveScienceReview, type ScienceDetail } from './scienceApi';
import { LinkedContent } from './LinkedContent';
import { checkSolutionSupport } from '../../shared/science-items.ts';
import type { ScienceDerived } from '../../shared/science-derive.ts';

const ref = (r: { row_id: string; item_no: number }) => `${r.row_id} #${r.item_no}`;
const parse = (s: string) => { const m = /^(.+) #(\d+)$/.exec(s); return m ? { row_id: m[1]!, item_no: Number(m[2]) } : null; };

export function ScienceReview({ questionId, versionNo, versionId, status, x, options, solution1, onSaved, derived = null, warnings = [] }: {
  questionId: string; versionNo: number; /** Q23 */ versionId: number; status: string; x: ScienceDetail; options: { position: number; text: string; is_correct: boolean }[]; solution1: string | null; onSaved: () => void;
  /** Q29/Q31 (0042): read-only derived values and review warnings (never block approval) */ derived?: ScienceDerived | null; warnings?: string[];
}) {
  const linked = new Set(x.links.map((l) => l.row_id));
  const items = useMemo(() => x.items.filter((i) => i.status !== 'retired' && linked.has(i.row_id))
    .sort((a, b) => x.links.findIndex((l) => l.row_id === a.row_id) - x.links.findIndex((l) => l.row_id === b.row_id) || a.item_no - b.item_no), [x]); // eslint-disable-line react-hooks/exhaustive-deps
  const curMisc = x.version.misconception_row_id ? `${x.version.misconception_row_id} #${x.version.misconception_item_no}` : '';
  const wrongOpts = options.filter((o) => !o.is_correct);

  const [misc, setMisc] = useState(curMisc);
  // Q32 (0041): per wrong option "tag|ref" ("" = not tagged); see encodeWrongTag
  const [wrong, setWrong] = useState<Record<number, string>>(() => Object.fromEntries(wrongOpts.map((o) => [o.position, x.wrongTags.get(o.position) ?? ''])));
  const [sol, setSol] = useState(solution1 ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const wrongChanged = wrongOpts.filter((o) => (wrong[o.position] ?? '') !== (x.wrongTags.get(o.position) ?? ''));
  const incomplete = wrongOpts.some((o) => /^(misconception|concept_error)\|$/.test(wrong[o.position] ?? ''));
  const dirty = misc !== curMisc || wrongChanged.length > 0 || sol.trim() !== (solution1 ?? '').trim();

  const save = async () => {
    setBusy(true); setErr(null); setSaved(false);
    try {
      await saveScienceReview({
        question_id: questionId, version_no: versionNo, reason: 'Science review',
        ...(misc !== curMisc ? { misconception: misc ? parse(misc) : null } : {}),
        ...(wrongChanged.length ? { wrong: wrongChanged.map((o) => {
          const [tag, r] = (wrong[o.position] ?? '').split('|');
          return { position: o.position, tag: tag || null, ...(tag === 'misconception' && r ? { mc: parse(r)! } : {}), ...(tag === 'concept_error' && r ? { target_row_id: r } : {}) };
        }) } : {}),
        ...(sol.trim() !== (solution1 ?? '').trim() ? { solution1: sol } : {}),
      });
      setSaved(true); onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const reset = () => { setMisc(curMisc); setWrong(Object.fromEntries(wrongOpts.map((o) => [o.position, x.wrongTags.get(o.position) ?? '']))); setSol(solution1 ?? ''); setErr(null); };

  const itemSelect = (value: string, set: (v: string) => void, label: string) => (
    <select aria-label={label} value={value} onChange={(e) => set(e.target.value)}>
      <option value="">— none —</option>
      {items.map((i) => <option key={ref(i)} value={ref(i)}>{ref(i)} · {i.text}{i.status === 'needs_review' ? ' (needs review)' : ''}</option>)}
    </select>
  );

  return (
    <div className="tint-box sci-review" aria-label="Science review">
      <div className="tint-title">Science review <span className="muted small">· explicit Save · logged</span></div>
      {derived && <div className="small sci-rv-derived"><span className="muted">Derived:</span> Tier {derived.tier ?? '— (no type)'} · Markers {derived.markers} · Load {derived.load ?? '—'} · Trap {derived.trapLevel}
        <span className="muted"> · type and attributes are set in Edit</span></div>}
      {warnings.length > 0 && <ul className="small sci-rv-warn">{warnings.map((w, i) => <li key={i} className="warn">Review: {w}</li>)}</ul>}

      {/* Q23 (0044): linked content rows (own Save): add, change role (primary / secondary / supporting), remove. Replaces the
          primary-row radio of Q16: the role select sets the primary, and Save links confirms a proposed one. */}
      <LinkedContent compact questionId={questionId} versionId={versionId} versionNo={versionNo} status={status} onSaved={onSaved} />

      <div className="sci-rv-f">
        <div className="sci-rv-l">Misconception targeted</div>
        <div>
          {itemSelect(misc, setMisc, 'Misconception targeted')}
          {x.version.misconception_targeted_legacy && <div className="muted small">Before 16 Nov: “{x.version.misconception_targeted_legacy}”</div>}
          {items.length === 0 && <div className="muted small">Its content rows have no misconception items.</div>}
          {/* Q14: a missing item is added on its row (Edit row), then picked here */}
          <div className="muted small">No item fits? Add one on the row ({x.links.filter((l) => l.row).map((l, k) => <span key={l.row_id}>{k > 0 && ' · '}
            <a href={browseHash({ subject: 'science', cls: String(l.row!.row_class), ch: l.row!.chapter_id, topic: l.row!.topic_id, tab: 'content', row: l.row_id })}>{l.row_id}</a></span>)}): open it, then Edit row.</div>
        </div>
      </div>

      {wrongOpts.length > 0 && <div className="sci-rv-f">
        <div className="sci-rv-l">Wrong options</div>
        <div className="sci-rv-wrong">
          {wrongOpts.map((o) => {
            const L = String.fromCharCode(64 + o.position);
            const [tag = '', r = ''] = (wrong[o.position] ?? '').split('|');
            const put = (t: string, ref: string) => setWrong({ ...wrong, [o.position]: t ? `${t}|${ref}` : '' });
            return (
              <div key={o.position} className="small"><span className="opt-label">{L} · {o.text}</span>
                <select aria-label={`Mistake tag of option ${L}`} value={tag} onChange={(e) => put(e.target.value, '')}>
                  <option value="">Not tagged</option>{Object.entries(TAG_LABEL).map(([t, label]) => <option key={t} value={t}>{label}</option>)}</select>
                {tag === 'misconception' && itemSelect(r, (v) => put('misconception', v), `Misconception of option ${L}`)}
                {tag === 'concept_error' && <select aria-label={`Target row of option ${L}`} value={r} onChange={(e) => put('concept_error', e.target.value)}>
                  <option value="">Choose a target row…</option>{x.links.map((l) => <option key={l.row_id} value={l.row_id}>{l.row_id} · {(l.row?.content ?? '').slice(0, 60)}</option>)}</select>}
                {tag === 'misconception' && !r && <span className="warn-text"> choose an item</span>}
                {tag === 'concept_error' && !r && <span className="warn-text"> choose a target row</span>}
              </div>
            );
          })}
          <div className="muted small">Tag where confident; untagged is fine and never blocks approval.</div>
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
        <button disabled={busy || !dirty || incomplete} onClick={save}>Save</button>{' '}
        <button className="link" disabled={busy || !dirty} onClick={reset}>Reset</button>
        {saved && !dirty && <span className="muted small"> Saved.</span>}
        <span className="muted small"> A misconception that is not an item yet can't be added here (content-row editing, Q14, is not built).</span>
      </div>
      {err && <div className="error small">{err}</div>}
    </div>
  );
}

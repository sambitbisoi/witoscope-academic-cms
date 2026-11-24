// Q38 PR 4 (Sambit, 24 Nov 2026), items (d) and (e): proposals decided IN PLACE in Browse, with one visual state.
//   proposed = amber dashed border + light amber background · approved = normal look · rejected = grey, struck out,
//   "Rejected" label, still visible and undoable. Red stays for Safety and errors.
// Every decision goes through the same audited function as the Proposed tab or the Science review, so both stay in sync:
//   primary row → cms_decide_primary · setting → cms_set_catalogue_status('setting') · topic–class link → cms_decide_topic_class
//   · misconception item → cms_set_row_misconception_status.
import { useEffect, useState, type ReactNode } from 'react';
import { Id } from './Id';
import { currentVersion, decidePrimary, decideSetting, decideTopicClass, topicClassProposals, type PrimaryDecision, type TopicClassProposal } from './reviewApi';
import { setRowItemStatus } from './scienceApi';
import { topicClassLine } from './catalogueLogic';

/** Runs one decision; shows "…" while busy and the error in place. */
function useDecide(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = (f: () => Promise<unknown>) => async (e?: React.MouseEvent) => {
    e?.stopPropagation(); e?.preventDefault();
    setBusy(true); setErr(null);
    try { await f(); onDone(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return { busy, err, go };
}
const Btn = ({ children, onClick, busy, title, kind = '' }: { children: ReactNode; onClick: (e: React.MouseEvent) => void; busy: boolean; title?: string; kind?: string }) =>
  <button type="button" className={`link small pdecide ${kind}`} disabled={busy} title={title} onClick={onClick}>{children}</button>;

/** A proposal chip in its state, with its decisions. */
export function PState({ state, label, title, children }: { state: 'proposed' | 'approved' | 'rejected'; label: ReactNode; title?: string; children?: ReactNode }) {
  return <span className={`pstate ${state}`} title={title}>
    <span className="pstate-label">{label}</span>{state === 'rejected' && <span className="pstate-tag">Rejected</span>}
    {children && <span className="pstate-actions">{children}</span>}
  </span>;
}

/** A question's primary row: proposed → Confirm · Change · Reject; rejected → Undo; confirmed → plain. */
export function PrimaryDecide({ questionId, versionNo, rowId, state, onChange, onDone }: { questionId: string; versionNo?: number; rowId: string; state: 'confirmed' | 'proposed' | 'rejected';
  /** "Change": where another primary is picked (Linked content of the question) */ onChange?: () => void; onDone: () => void }) {
  const { busy, err, go } = useDecide(onDone);
  const act = (decision: PrimaryDecision) => go(async () => decidePrimary({ question_id: questionId, version_no: versionNo ?? await currentVersion(questionId), decision, row_id: rowId, reason: `${decision} in Browse` }));
  if (state === 'confirmed') return <span className="tag rank-primary" title="Confirmed primary row">Primary {rowId}</span>;
  return <>
    <PState state={state === 'proposed' ? 'proposed' : 'rejected'} label={<>Primary {rowId}{state === 'proposed' ? ' · proposed' : ''}</>}
      title={state === 'proposed' ? 'Proposed primary row: confirm it, pick another (Change) or reject it' : 'Rejected as the primary; kept as a secondary row'}>
      {state === 'proposed' ? <>
        <Btn busy={busy} onClick={act('confirm')} kind="ok" title="Confirm this row as the primary">Confirm</Btn>
        {onChange && <Btn busy={busy} onClick={(e) => { e.stopPropagation(); e.preventDefault(); onChange(); }} title="Pick another direct row as the primary">Change</Btn>}
        <Btn busy={busy} onClick={act('reject')} kind="no" title="Not the primary: kept as a secondary row, marked Rejected (undoable)">Reject</Btn>
      </> : <Btn busy={busy} onClick={act('undo')} title="Make it the proposed primary again">Undo</Btn>}
    </PState>
    {err && <span className="error small"> {err}</span>}
  </>;
}

/** A question's setting: proposed → Approve · Reject; rejected (retired) → Undo. */
export function SettingDecide({ setting, onDone }: { setting: { setting_id: string; name: string; status: string }; onDone: () => void }) {
  const { busy, err, go } = useDecide(onDone);
  const st = setting.status === 'proposed' ? 'proposed' : setting.status === 'retired' ? 'rejected' : 'approved';
  if (st === 'approved') return <><strong>{setting.name}</strong> <Id>{setting.setting_id}</Id></>;
  return <>
    <PState state={st} label={<><strong>{setting.name}</strong> <Id>{setting.setting_id}</Id>{st === 'proposed' ? ' · proposed' : ''}</>}>
      {st === 'proposed' ? <>
        <Btn busy={busy} kind="ok" onClick={go(() => decideSetting(setting.setting_id, 'active', 'in Browse'))}>Approve</Btn>
        <Btn busy={busy} kind="no" onClick={go(() => decideSetting(setting.setting_id, 'retired', 'in Browse'))}>Reject</Btn>
      </> : <Btn busy={busy} onClick={go(() => decideSetting(setting.setting_id, 'proposed', 'in Browse'))}>Undo</Btn>}
    </PState>
    {err && <span className="error small"> {err}</span>}
  </>;
}

/** A row's misconception item: needs review → Approve · Reject; retired → Undo. */
export function ItemDecide({ rowId, itemNo, status, onDone }: { rowId: string; itemNo: number; status: string; onDone: () => void }) {
  const { busy, err, go } = useDecide(onDone);
  if (status === 'active') return null;
  return <>
    {status === 'needs_review' ? <span className="pstate-actions">
      <Btn busy={busy} kind="ok" onClick={go(() => setRowItemStatus(rowId, itemNo, 'active', 'approved in Browse'))}>Approve</Btn>
      <Btn busy={busy} kind="no" onClick={go(() => setRowItemStatus(rowId, itemNo, 'retired', 'rejected in Browse'))}>Reject</Btn>
    </span> : <span className="pstate-actions"><Btn busy={busy} onClick={go(() => setRowItemStatus(rowId, itemNo, 'needs_review', 'undo in Browse'))}>Undo</Btn></span>}
    {err && <span className="error small"> {err}</span>}
  </>;
}

/** The topic's proposed (and rejected) topic–class links, decided in place. Nothing when there are none. */
export function TopicClassDecide({ topicId, onDone }: { topicId: string; onDone?: () => void }) {
  const [list, setList] = useState<TopicClassProposal[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { topicClassProposals([topicId]).then(setList).catch(() => setList([])); }, [topicId, tick]);
  const { busy, err, go } = useDecide(() => { setTick((t) => t + 1); onDone?.(); });
  const shown = (list ?? []).filter((p) => p.status !== 'active');
  if (!shown.length) return null;
  return (
    <div className="small topic-class-props">
      {/* PR 4b: "Add topic to Class 6 · proposed" [Confirm] [Reject]; no explanation on the line, the evidence only as a tooltip */}
      {shown.map((p) => <span key={p.class} className="tc-prop">
        <PState state={p.status === 'proposed' ? 'proposed' : 'rejected'} label={topicClassLine(p.class, p.status)}
          title={[p.evidence, p.source ? `Suggested by ${p.source}` : null].filter(Boolean).join(' · ') || undefined} />
        {p.status === 'proposed' ? <>
          <button type="button" className="approve small-btn" disabled={busy} onClick={go(() => decideTopicClass(topicId, p.class, 'active'))}>Confirm</button>
          <button type="button" className="secondary small-btn" disabled={busy} onClick={go(() => decideTopicClass(topicId, p.class, 'retired'))}>Reject</button>
        </> : <button type="button" className="link small" disabled={busy} onClick={go(() => decideTopicClass(topicId, p.class, 'proposed'))}>Undo</button>}
      </span>)}
      {err && <span className="error small"> {err}</span>}
    </div>
  );
}

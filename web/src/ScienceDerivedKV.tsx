// Q29/Q30 (Round 2, 0042): a Science question's derived values, read-only (Edit, question page, Science review box).
import type { ScienceDerived } from '../../shared/science-derive.ts';

export function ScienceDerivedKV({ d, storedTier }: { d: ScienceDerived; /** the tier stored on the version, if it differs from the preview */ storedTier?: string | null }) {
  const rows: [string, React.ReactNode][] = [
    ['Tier', d.tier ?? <span className="muted">— (set the Science question type)</span>],
    ['Markers', <>{d.markers}{d.markerList.length ? <span className="muted"> · {d.markerList.join(' · ')}</span> : null}</>],
    ['Load · driver', d.load === null ? '—' : <>{d.load} <span className="muted">· {d.loadDriver === 'reading' ? 'reading' : `steps (band ${d.stepsBand})`}</span></>],
    ['Trap level', String(d.trapLevel)],
    ['Clone group', d.cloneGroup ?? <span className="muted">— (needs the type)</span>],
  ];
  return (
    <div className="kv small sci-derived">
      {rows.map(([k, v]) => <div key={k} className="held-kv"><span className="muted">{k}</span><span>{v}</span></div>)}
      {storedTier !== undefined && storedTier !== d.tier && <div className="muted small">Stored tier: {storedTier ?? '—'} (it follows the type when saved).</div>}
    </div>
  );
}

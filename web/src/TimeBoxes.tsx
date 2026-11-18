// Q36: the Typed-time answer as the child sees it: two boxes hh : mm with the colon printed, no a.m./p.m.
import { timeBoxes } from '../../shared/typed-time.ts';

/** Preview: the two boxes filled with the stored answer (h:mm). */
export function TimeBoxes({ value }: { value: string }) {
  const [hh, mm] = timeBoxes(value);
  return (
    <span className="time-boxes" aria-label={`time ${value}`}>
      <span className="time-box">{hh}</span><span className="time-colon">:</span><span className="time-box">{mm}</span>
    </span>
  );
}

/** Editor: two boxes that write the stored answer h:mm (each box is digits only; 3 = 03). */
export function TimeBoxesInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const m = /^(\d{0,2}):(\d{0,2})$/.exec(value);
  const [hh, mm] = m ? [m[1]!, m[2]!] : [value, ''];
  const write = (h: string, mi: string) => {
    const hd = h.replace(/\D/g, '').slice(0, 2), md = mi.replace(/\D/g, '').slice(0, 2);
    // store h:mm once both boxes hold a number; while typing keep what was typed
    onChange(hd && md.length === 2 ? `${Number(hd)}:${md}` : `${hd}:${md}`);
  };
  return (
    <span className="time-boxes">
      <input className="time-box" inputMode="numeric" aria-label="hours" placeholder="hh" value={hh} onChange={(e) => write(e.target.value, mm)} />
      <span className="time-colon">:</span>
      <input className="time-box" inputMode="numeric" aria-label="minutes" placeholder="mm" value={mm} onChange={(e) => write(hh, e.target.value)} />
    </span>
  );
}

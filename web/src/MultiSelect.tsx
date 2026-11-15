// A small multi-select (review UX, 15 Nov 2026): a button that opens a list of checkboxes with counts.
// Nothing ticked = all. Used by the topic filters (Q6), the Proposed filters (Q10) and Browse (Q5).
import { useEffect, useRef, useState } from 'react';

export interface MOption { value: string; label: string; count?: number }

export function MultiSelect({ label, options, selected, onChange, allText = 'all', className }: {
  label: string; options: MOption[]; selected: string[]; onChange: (v: string[]) => void; allText?: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const sel = new Set(selected);
  const names = options.filter((o) => sel.has(o.value)).map((o) => o.label);
  // a selected value that is not in the options any more still counts (e.g. from the URL)
  const unknown = selected.filter((v) => !options.some((o) => o.value === v));
  const summary = !selected.length ? allText : names.length + unknown.length <= 2 ? [...names, ...unknown].join(', ') : `${selected.length} selected`;
  const flip = (v: string) => onChange(sel.has(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <div className={`msel ${className ?? ''}`} ref={box}>
      <button type="button" className={`msel-btn ${selected.length ? 'active' : ''}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="msel-label">{label}:</span> {summary} <span aria-hidden className="msel-caret">▾</span>
      </button>
      {open && (
        <div className="msel-pop" role="listbox" aria-multiselectable="true" aria-label={label}>
          <button type="button" className="link small msel-all" onClick={() => onChange([])} disabled={!selected.length}>Show all</button>
          {options.length === 0 && <div className="muted small">Nothing to choose.</div>}
          {options.map((o) => (
            <label key={o.value} className="msel-opt">
              <input type="checkbox" checked={sel.has(o.value)} onChange={() => flip(o.value)} />
              <span className="msel-name">{o.label}</span>
              {o.count !== undefined && <span className="muted small msel-count">{o.count}</span>}
            </label>
          ))}
          {unknown.map((v) => (
            <label key={v} className="msel-opt">
              <input type="checkbox" checked onChange={() => flip(v)} />
              <span className="msel-name">{v}</span><span className="muted small msel-count">0</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

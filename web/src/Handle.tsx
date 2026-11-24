// U11: a drag handle between two panes (moved out of Workspace for Q38 PR 4 (a): also between the Science content and question panes).
import { useRef } from 'react';

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** U11: a drag handle between two panes; double-click resets the width. */
export function Handle({ side, onDrag, onReset, disabled }: { side: string; onDrag: (dx: number) => void; onReset: () => void; disabled?: boolean }) {
  const last = useRef(0);
  const drag = useRef(onDrag);
  drag.current = onDrag;
  const down = (e: React.MouseEvent) => {
    if (disabled) return;
    e.preventDefault();
    last.current = e.clientX;
    document.body.classList.add('resizing');
    const move = (m: MouseEvent) => { const dx = m.clientX - last.current; if (dx) { last.current = m.clientX; drag.current(dx); } };
    const up = () => { document.body.classList.remove('resizing'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return <div className={`ws-handle ${side} ${disabled ? 'off' : ''}`} role="separator" aria-orientation="vertical" title={disabled ? undefined : 'Drag to resize · double-click to reset'}
    onMouseDown={down} onDoubleClick={disabled ? undefined : onReset} />;
}


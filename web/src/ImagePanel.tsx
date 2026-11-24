// Images PR (DL-040; Sambit, 24 Nov 2026): a question's image. Status Image needed → Image to check → OK; the structured
// brief (shown · style · must NOT show · layout · labels A–D with their targets), edited with an explicit Save; Generate /
// Regenerate (Science; the brief opens first), Upload (our own picture, PNG / JPEG / WebP), Place labels (one scene),
// OK / Redo, and every earlier image with Undo. Gold questions are never generated. Writes: the audited functions of 0049.
import { useEffect, useRef, useState } from 'react';
import { briefFromText, briefProblem, imagePrompt, LAYOUT_LABEL, LAYOUTS, layoutOf, labelsToPlace, inferLayout, type BriefLabel, type ImageBrief, type ImageLayout } from '../../shared/image-brief.ts';
import { checkImage, fileBlob, imageHistory, imageService, putFile, setBrief, setImage, signedUrl, undoImage, type HistoryImage, type ImageService } from './imageApi';
import { drawLabels, makeImage } from './labels';

export const IMAGE_STATUS_LABEL: Record<string, string> = { needs_image: 'Image needed', to_check: 'Image to check', has_image: 'Image OK' };
const SOURCE_LABEL: Record<HistoryImage['source'], string> = { svg_render: 'Previous (drawn)', generated: 'Generated', upload: 'Uploaded' };
const LETTERS = ['A', 'B', 'C', 'D'] as const;

export function ImagePanel({ q, onChanged }: {
  q: { question_id: string; version_no: number; version_id: number; status: string; subject: string; bank: string; image_status: string | null; image_path: string | null;
    image_brief: ImageBrief | null; figure_description: string | null };
  onChanged: () => void;
}) {
  const open = q.status === 'draft' || q.status === 'in_review';
  const [svc, setSvc] = useState<ImageService | null>(null);
  const [hist, setHist] = useState<HistoryImage[] | null>(null);
  const [mode, setMode] = useState<null | 'edit' | 'regenerate' | 'redo' | 'place' | 'upload'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { imageService().then(setSvc); }, []);
  useEffect(() => { imageHistory(q.version_id).then(setHist).catch(() => setHist([])); }, [q.version_id, tick, q.image_path]);
  const saved: ImageBrief | null = q.image_brief ?? (q.figure_description ? { ...briefFromText(q.figure_description) } : null);
  const fromText = !q.image_brief && !!q.figure_description;
  const canGenerate = q.subject === 'science' && q.bank === 'production';
  const ver = { question_id: q.question_id, version_no: q.version_no };
  const run = (label: string, f: () => Promise<unknown>) => async () => {
    setBusy(label); setErr(null);
    try { await f(); setMode(null); setTick((t) => t + 1); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  if (!q.image_status && !q.image_brief && !q.figure_description) return null;
  const current = hist?.find((h) => h.state === 'current') ?? null;
  const previous = (hist ?? []).filter((h) => h.state === 'previous');
  const status = q.image_status ?? 'needs_image';
  const notSetUp = svc && !svc.configured;
  return (
    <div className={`tint-box image-panel img-${status}`} aria-label="Image">
      <div className="tint-title image-head">
        <span>Image</span> <span className={`tag image-status ${status}`}>{IMAGE_STATUS_LABEL[status] ?? status}</span>
        {current && <span className="muted small"> · {SOURCE_LABEL[current.source]}{current.provider ? ` (${current.provider})` : ''}{Number(current.cost_usd) ? ` · $${Number(current.cost_usd).toFixed(2)}` : ''}{current.note ? ` · ${current.note}` : ''}</span>}
      </div>

      {mode === 'edit' || mode === 'regenerate'
        ? <BriefForm initial={saved ?? { shown: '', labels: [] }} busy={!!busy} submitLabel={mode === 'regenerate' ? (svc?.configured ? `Save and generate${svc.price_usd ? ` ($${svc.price_usd.toFixed(2)})` : ''}` : 'Save') : 'Save brief'}
            onCancel={() => setMode(null)}
            onSave={(b) => run(mode === 'regenerate' ? 'Generating…' : 'Saving…', async () => {
              await setBrief(ver, b, mode === 'regenerate' ? 'image brief edited before regenerating' : 'image brief');
              if (mode === 'regenerate' && svc?.configured) await makeImage(ver, b);
            })()} />
        : saved && <BriefView b={saved} fromText={fromText} />}

      {open && mode === null && <div className="image-actions small">
        <button className="link" onClick={() => setMode('edit')}>{q.image_brief ? 'Edit brief' : 'Write the brief'}</button>
        {canGenerate && (svc?.configured
          ? <button className="secondary small" disabled={!!busy || !saved?.shown} title={saved ? imagePrompt({ ...saved, layout: layoutOf(saved) }) : 'Write the brief first'}
              onClick={() => (q.image_path || current ? setMode('regenerate') : run('Generating…', () => makeImage(ver, { ...saved!, layout: layoutOf(saved!) }, { storeBrief: !q.image_brief }))())}>
              {q.image_path || current ? 'Regenerate…' : `Generate${svc.price_usd ? ` ($${svc.price_usd.toFixed(2)})` : ''}`}</button>
          : <button className="secondary small" disabled title="No image service is configured yet (the provider is chosen after the Gemini / OpenAI pilot)">{notSetUp ? 'Image service not set up' : '…'}</button>)}
        <button className="secondary small" onClick={() => setMode('upload')}>Upload…</button>
        {saved && layoutOf(saved) === 'single' && (saved.labels ?? []).length > 0 && current?.base_path && <button className="secondary small" onClick={() => setMode('place')}>Place labels</button>}
        {status === 'to_check' && <>
          <button className="approve small" disabled={!!busy} onClick={run('Saving…', () => checkImage({ ...ver, decision: 'ok' }))} title="The picture matches the brief and shows no answer">OK</button>
          <button className="reject small" disabled={!!busy} onClick={() => setMode('redo')}>Redo…</button></>}
        {current && previous.length > 0 && <button className="link" disabled={!!busy} onClick={run('Undoing…', () => undoImage(ver))} title="Bring the previous image back (this one is kept)">Undo</button>}
      </div>}
      {!open && <div className="muted small">{q.status === 'approved' ? 'Approved: Edit makes a new version first, then change its image.' : `v${q.version_no} is ${q.status}.`}</div>}
      {mode === 'redo' && <Redo busy={!!busy} onCancel={() => setMode(null)} onGo={(reason) => run('Saving…', () => checkImage({ ...ver, decision: 'redo', reason }))()} />}
      {mode === 'upload' && <Upload brief={saved} busy={!!busy} onCancel={() => setMode(null)}
        onGo={(file, withLabels) => run('Uploading…', async () => {
          const stamp = Date.now().toString(36), ext = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/webp' ? 'webp' : 'png';
          const base = `figures/img/${q.question_id}-${stamp}-base.${ext}`;
          await putFile(base, file);
          let path = base;
          if (withLabels && saved) { path = `figures/img/${q.question_id}-${stamp}.png`; await putFile(path, await drawLabels(file, saved)); }
          await setImage({ ...ver, image_path: path, base_path: base, source: 'upload' });
        })()} />}
      {mode === 'place' && saved && current?.base_path && <PlaceLabels brief={saved} basePath={current.base_path} busy={!!busy} onCancel={() => setMode(null)}
        onSave={(b) => run('Saving…', async () => {
          await setBrief(ver, b, 'labels placed');
          const path = current.base_path!.replace(/-base\.(png|jpg|webp)$/, `-${Date.now().toString(36)}.png`);
          await putFile(path, await drawLabels(await fileBlob(current.base_path!), b));
          await setImage({ ...ver, image_path: path, base_path: current.base_path, source: current.source === 'upload' ? 'upload' : 'generated', provider: current.provider ?? undefined, note: 'labels placed' });
        })()} />}
      {busy && <div className="small muted">{busy}</div>}
      {err && <div className="error small">{err}</div>}

      {(hist ?? []).length > 0 && <details className="image-history small" open={!q.image_path && previous.length > 0}>
        <summary>Images of this version · {hist!.length}</summary>
        <div className="image-thumbs">{hist!.map((h) => <Thumb key={h.image_id} h={h} />)}</div>
      </details>}
    </div>
  );
}

function BriefView({ b, fromText }: { b: ImageBrief; fromText: boolean }) {
  const layout = b.layout ?? inferLayout(b);
  return (
    <dl className="brief small">
      {fromText && <div className="muted">From the figure description (no structured brief yet; the Science session's image_briefs.json will fill it).</div>}
      <dt>Shown</dt><dd>{b.shown}</dd>
      {b.style && <><dt>Style</dt><dd>{b.style}</dd></>}
      {b.must_not_show && <><dt>Must NOT show</dt><dd>{b.must_not_show}</dd></>}
      <dt>Layout</dt><dd>{LAYOUT_LABEL[layout]}{!b.layout && <span className="muted"> (inferred)</span>}</dd>
      {(b.labels ?? []).length > 0 && <><dt>Labels</dt><dd>{[...b.labels!].sort((x, y) => x.label.localeCompare(y.label)).map((l) => (
        <span key={l.label} className="brief-label"><strong>{l.label}</strong> → {l.points_to}{layout === 'single' && (l.x == null ? <span className="muted"> (not placed)</span> : null)}</span>))}</dd></>}
    </dl>
  );
}

function BriefForm({ initial, onSave, onCancel, busy, submitLabel }: { initial: ImageBrief; onSave: (b: ImageBrief) => void; onCancel: () => void; busy: boolean; submitLabel: string }) {
  const [b, setB] = useState<ImageBrief>({ ...initial, layout: initial.layout ?? inferLayout(initial), labels: initial.labels ?? [] });
  const label = (L: string) => b.labels!.find((l) => l.label === L);
  const setLabel = (L: BriefLabel['label'], points_to: string) => setB({ ...b, labels: [...b.labels!.filter((l) => l.label !== L), ...(points_to.trim() ? [{ ...(label(L) ?? {}), label: L, points_to }] : [])]
    .sort((x, y) => x.label.localeCompare(y.label)) });
  const problem = briefProblem({ ...b, labels: b.labels!.map((l) => ({ ...l, points_to: l.points_to.trim() })) });
  return (
    <div className="brief-form small">
      <label>Shown<textarea rows={3} value={b.shown} onChange={(e) => setB({ ...b, shown: e.target.value })} /></label>
      <label>Style<input value={b.style ?? ''} onChange={(e) => setB({ ...b, style: e.target.value })} placeholder="simple flat colour drawing" /></label>
      <label>Must NOT show<textarea rows={2} value={b.must_not_show ?? ''} onChange={(e) => setB({ ...b, must_not_show: e.target.value })} placeholder="no marks that single out the answer; no words" /></label>
      <label>Layout<select value={b.layout ?? 'single'} onChange={(e) => setB({ ...b, layout: e.target.value as ImageLayout })}>
        {LAYOUTS.map((l) => <option key={l} value={l}>{LAYOUT_LABEL[l]}</option>)}</select></label>
      <div className="brief-labels">{LETTERS.map((L) => <label key={L}>{L} →<input value={label(L)?.points_to ?? ''} onChange={(e) => setLabel(L, e.target.value)} placeholder={L === 'A' ? 'what A points to (empty = no label)' : ''} /></label>)}</div>
      <div className="muted">The picture is made without any letters or words; the CMS draws A–D {b.layout === 'single' ? 'where you place them' : 'on the panels, in order'}.</div>
      {problem && <div className="error">{problem}</div>}
      <div><button className="approve small" disabled={busy || !!problem} onClick={() => onSave({ ...b, shown: b.shown.trim(), style: b.style?.trim() || null, must_not_show: b.must_not_show?.trim() || null,
        labels: b.labels!.map((l) => ({ ...l, points_to: l.points_to.trim() })) })}>{submitLabel}</button> <button className="link" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

function Redo({ onGo, onCancel, busy }: { onGo: (reason: string) => void; onCancel: () => void; busy: boolean }) {
  const [r, setR] = useState('');
  return <div className="reason small"><label>What is wrong with it? (required; it guides the next brief)<input value={r} onChange={(e) => setR(e.target.value)} /></label>
    <button className="reject" disabled={busy || !r.trim()} onClick={() => onGo(r.trim())}>Back to Image needed</button> <button className="link" onClick={onCancel}>Cancel</button></div>;
}

function Upload({ brief, onGo, onCancel, busy }: { brief: ImageBrief | null; onGo: (f: File, withLabels: boolean) => void; onCancel: () => void; busy: boolean }) {
  const [f, setF] = useState<File | null>(null);
  const [withLabels, setWithLabels] = useState(false);
  const canLabel = !!brief && (brief.labels ?? []).length > 0 && labelsToPlace(brief).length === 0;
  const bad = f && (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type) ? 'PNG, JPEG or WebP only' : f.size > 50 * 1024 * 1024 ? 'over 50 MB' : null);
  return <div className="reason small">
    <label>Our own picture (PNG / JPEG / WebP; never a book scan or screenshot)<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setF(e.target.files?.[0] ?? null)} /></label>
    {canLabel && <label className="check"><input type="checkbox" checked={withLabels} onChange={(e) => setWithLabels(e.target.checked)} /> Draw A–D on it (from the brief's layout)</label>}
    {bad && <div className="error">{bad}</div>}
    <button className="approve" disabled={busy || !f || !!bad} onClick={() => f && onGo(f, withLabels)}>Upload</button> <button className="link" onClick={onCancel}>Cancel</button>
  </div>;
}

/** One scene: click on the picture to place each label in turn; Save stores the points and redraws the letters. */
function PlaceLabels({ brief, basePath, onSave, onCancel, busy }: { brief: ImageBrief; basePath: string; onSave: (b: ImageBrief) => void; onCancel: () => void; busy: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [labels, setLabels] = useState<BriefLabel[]>([...(brief.labels ?? [])].sort((x, y) => x.label.localeCompare(y.label)));
  const [i, setI] = useState(() => Math.max(0, labels.findIndex((l) => l.x == null)));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { signedUrl(basePath).then(setSrc).catch(() => setSrc(null)); }, [basePath]);
  const click = (e: React.MouseEvent) => {
    const r = box.current!.getBoundingClientRect();
    const x = +((e.clientX - r.left) / r.width).toFixed(3), y = +((e.clientY - r.top) / r.height).toFixed(3);
    setLabels((ls) => ls.map((l, k) => (k === i ? { ...l, x, y } : l)));
    setI((k) => Math.min(labels.length - 1, k + 1));
  };
  return <div className="place-labels small">
    <div>Click where <strong>{labels[i]?.label}</strong> should go: {labels[i]?.points_to}. {labels.map((l, k) => <button key={l.label} className={`pill small ${k === i ? 'on' : ''}`} onClick={() => setI(k)}>{l.label}{l.x != null ? ' ✓' : ''}</button>)}</div>
    <div className="place-box" ref={box} onClick={click}>{src ? <img src={src} alt="The picture without letters" /> : <span className="muted">Loading…</span>}
      {labels.filter((l) => l.x != null).map((l) => <span key={l.label} className="place-dot" style={{ left: `${l.x! * 100}%`, top: `${l.y! * 100}%` }}>{l.label}</span>)}</div>
    <button className="approve" disabled={busy || labels.some((l) => l.x == null)} onClick={() => onSave({ ...brief, layout: 'single', labels })}>Save positions and draw the labels</button> <button className="link" onClick={onCancel}>Cancel</button>
  </div>;
}

function Thumb({ h }: { h: HistoryImage }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { if (h.image_path) signedUrl(h.image_path).then(setSrc).catch(() => setSrc(null)); }, [h.image_path]);
  return <figure className={`thumb ${h.state}`}>
    {src ? <img src={src} alt={SOURCE_LABEL[h.source]} /> : <div className="thumb-missing muted">{h.image_path ? 'not available here' : 'no image'}</div>}
    <figcaption>{h.state === 'current' ? 'Current · ' : h.source === 'svg_render' ? '' : 'Previous · '}{SOURCE_LABEL[h.source]}{h.provider ? ` (${h.provider})` : ''} · {new Date(h.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</figcaption>
  </figure>;
}

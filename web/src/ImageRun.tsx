// Images PR (DL-040; Sambit, 24 Nov 2026): "Generate missing" for a Science topic or chapter. Count + estimated cost +
// per-run cap (default $5, cms_config image_run_cap_usd) + explicit Confirm; small batches (5) with progress; resumable
// (an open run of the same topic / chapter is continued); stops at the cap, on 2 failures in a row, or on Cancel.
// Every picture lands as "Image to check", never OK. Gold is never generated (the run lists production questions only).
import { useEffect, useRef, useState } from 'react';
import { briefFromText, layoutOf, type ImageBrief } from '../../shared/image-brief.ts';
import { imageCounts, imageRunCap, imageService, openVersion, runClaim, runClose, runItem, runOpen, type ImageService } from './imageApi';
import { makeImage } from './labels';

const BATCH = 5;
export function ImageRunBar({ scope, onChanged }: { scope: { topicId: string } | { chapterId: string }; onChanged: () => void }) {
  const [n, setN] = useState<{ needs_image: number; to_check: number } | null>(null);
  const [svc, setSvc] = useState<ImageService | null>(null);
  const [ask, setAsk] = useState(false);
  const [cap, setCap] = useState(5);
  const [prog, setProg] = useState<{ run: string; done: number; failed: number; total: number; spent: number; note?: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const stop = useRef(false);
  const key = 'topicId' in scope ? scope.topicId : scope.chapterId;
  useEffect(() => { imageCounts(scope).then(setN).catch(() => setN(null)); }, [key, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { imageService().then(setSvc); imageRunCap().then(setCap).catch(() => {}); }, []);
  if (!n || (n.needs_image === 0 && n.to_check === 0 && !prog && !msg)) return null;
  const price = svc?.price_usd ?? 0;
  const est = Math.min(n.needs_image * price * 1.1, cap);   // +10% for retries; never above the cap

  const go = async () => {
    setAsk(false); setMsg(null); stop.current = false;
    let run = '', done = 0, failed = 0, inARow = 0, spent = 0, total = 0;
    try {
      const r = await runOpen({ scope_kind: 'topicId' in scope ? 'topic' : 'chapter', scope_id: key, provider: svc!.provider!, price_usd: price, cap_usd: cap });
      run = r.run_code; spent = Number(r.spent_usd); total = Number(r.pending);
      setProg({ run, done, failed, total, spent, note: r.continued ? `continuing ${run}` : undefined });
      for (;;) {
        if (stop.current) {
          await runClose({ run_code: run, status: 'cancelled', note: 'cancelled in the CMS' });
          setMsg(`${run} cancelled: ${done} made, ${failed} failed, $${spent.toFixed(2)} spent. Generate missing again to continue.`); break;
        }
        const c = await runClaim(run, BATCH);
        if (!c.question_ids.length) {
          if (c.cap_reached) {
            await runClose({ run_code: run, status: 'stopped', note: 'cap reached' });
            setMsg(`${run} stopped at the $${cap.toFixed(2)} cap: ${done} made, ${failed} failed, ${c.pending} left. Raise the cap to continue.`);
          } else {
            await runClose({ run_code: run, status: 'done' });
            setMsg(`${run} done: ${done} made${failed ? `, ${failed} failed` : ''}, $${spent.toFixed(2)} spent. Every picture is "Image to check".`);
          }
          break;
        }
        for (const qid of c.question_ids) {
          try {
            const v = await openVersion(qid);
            if (v.image_status !== 'needs_image') { await runItem({ run_code: run, question_id: qid, status: 'skipped', error: `now ${v.image_status}` }); continue; }
            const brief: ImageBrief = v.image_brief ?? { ...briefFromText(v.figure_description ?? '') };
            if (!brief.shown) { await runItem({ run_code: run, question_id: qid, status: 'skipped', error: 'no brief' }); continue; }
            const m = await makeImage({ question_id: qid, version_no: v.version_no }, { ...brief, layout: layoutOf(brief) }, { storeBrief: !v.image_brief, runCode: run });
            done++; inARow = 0; spent += m.cost;
          } catch (e) {
            failed++; inARow++;
            await runItem({ run_code: run, question_id: qid, status: 'failed', error: (e as Error).message }).catch(() => {});
          }
          setProg({ run, done, failed, total, spent });
          if (inARow >= 2) break;
        }
        if (inARow >= 2) {
          await runClose({ run_code: run, status: 'stopped', note: '2 failures in a row' });
          setMsg(`${run} stopped after 2 failures in a row (${done} made). Check the image service, then Generate missing again to continue.`); break;
        }
      }
    } catch (e) { setMsg(`Generate missing failed${run ? ` (${run})` : ''}: ${(e as Error).message}`); }
    setProg(null); setTick((t) => t + 1); onChanged();
  };

  return (
    <div className="image-run small">
      <span className="muted">Images:</span> <strong>{n.needs_image}</strong> needed · <strong>{n.to_check}</strong> to check
      {!prog && n.needs_image > 0 && (svc?.configured
        ? <button className="secondary small" onClick={() => setAsk(!ask)}>Generate missing ({n.needs_image})…</button>
        : <button className="secondary small" disabled title="No image service is configured yet (the provider is chosen after the Gemini / OpenAI pilot)">{svc ? 'Image service not set up' : '…'}</button>)}
      {ask && svc?.configured && <div className="reason image-run-confirm">
        <div>Generate <strong>{n.needs_image}</strong> picture{n.needs_image === 1 ? '' : 's'} with {svc.provider} ({svc.model}) at ${price.toFixed(2)} each: about <strong>${est.toFixed(2)}</strong>.
          Each lands as "Image to check". It runs {BATCH} at a time and can be continued later.</div>
        <label>Spend cap for this run (USD) <input type="number" min={0.5} step={0.5} value={cap} onChange={(e) => setCap(Math.max(0.5, Number(e.target.value) || 5))} /></label>
        <button className="approve" onClick={go}>Confirm · generate {n.needs_image}</button> <button className="link" onClick={() => setAsk(false)}>Cancel</button>
      </div>}
      {prog && <div className="image-run-progress"><progress max={Math.max(1, prog.total)} value={prog.done + prog.failed} /> {prog.run}: {prog.done} made · {prog.failed} failed · ${prog.spent.toFixed(2)}{prog.note ? ` · ${prog.note}` : ''}
        <button className="link small" onClick={() => { stop.current = true; }}>Cancel</button></div>}
      {msg && <div className="image-run-msg">{msg} <button className="link small" onClick={() => setMsg(null)}>Hide</button></div>}
    </div>
  );
}

// Images PR (DL-040): the CMS draws the letters A–D on the picture (the model never writes them). Row of four / 2 × 2 grid:
// one letter per panel, the panel that shows its target; one scene: at the point placed for each label.
import { labelPositions, labelsToPlace, layoutOf, type ImageBrief } from '../../shared/image-brief.ts';
import { fileBlob, generateBase, putFile, setBrief, setImage } from './imageApi';

/** The base picture with A–D drawn in: a white disc with a dark letter, sized to the picture. Returns a PNG. */
export async function drawLabels(base: Blob, brief: ImageBrief): Promise<Blob> {
  const missing = labelsToPlace(brief);
  if (missing.length) throw new Error(`Place label${missing.length > 1 ? 's' : ''} ${missing.join(', ')} first.`);
  const img = await createImageBitmap(base);
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);
  const r = Math.max(18, Math.round(Math.min(img.width, img.height) * 0.045));
  const corner = layoutOf(brief) !== 'single';   // panels: inside the panel's top-left corner; a scene: centred on the placed point
  for (const p of labelPositions(brief)) {
    const off = corner ? r : 0;
    const x = Math.min(img.width - r - 2, Math.max(r + 2, p.x * img.width + off)), y = Math.min(img.height - r - 2, Math.max(r + 2, p.y * img.height + off));
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = '#ffffff'; g.fill();
    g.lineWidth = Math.max(2, r * 0.12); g.strokeStyle = '#1d2330'; g.stroke();
    g.fillStyle = '#1d2330'; g.font = `700 ${Math.round(r * 1.2)}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(p.label, x, y + r * 0.05);
  }
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('could not draw the labels'))), 'image/png'));
}

/** One image for one question: the service draws the picture (no letters), the CMS draws A–D (unless a scene still needs its
 *  labels placed), both are kept, and the question goes to "Image to check". The brief used is stored first. */
export async function makeImage(q: { question_id: string; version_no: number }, brief: ImageBrief, o: { storeBrief?: boolean; runCode?: string } = {}) {
  if (o.storeBrief) await setBrief(q, brief, 'image brief (before generating)');
  const g = await generateBase(q.question_id, brief);
  const unplaced = (brief.labels ?? []).length > 0 && labelsToPlace(brief).length > 0;
  let image_path = g.base_path;
  if ((brief.labels ?? []).length && !unplaced) {
    image_path = g.base_path.replace(/-base\.(png|jpg|webp)$/, '.png');
    await putFile(image_path, await drawLabels(await fileBlob(g.base_path), brief));
  }
  await setImage({ ...q, image_path, base_path: g.base_path, source: 'generated', provider: g.provider, model: g.model, prompt_sha: g.prompt_sha, cost_usd: g.cost_usd,
    ...(o.runCode ? { run_code: o.runCode } : {}), ...(unplaced ? { note: 'labels still to place' } : {}) });
  return { cost: g.cost_usd, unplaced };
}

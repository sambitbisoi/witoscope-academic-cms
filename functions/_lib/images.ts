// Images PR (DL-040; Sambit, 24 Nov 2026): the CMS image service, as one Web-standard handler (Pages Function + local dev).
//   GET  /api/images/status     Access → { configured, provider, model, price_usd }  ("Image service not set up" when not)
//   POST /api/images/generate   Access, { question_id, brief } → the picture WITHOUT letters, stored in R2 under
//                               figures/img/…  → { base_path, provider, model, cost_usd, prompt_sha }
// The provider's key lives ONLY in this function's secrets (never in the browser, the repo or the database); the database
// is written by the browser through the admin functions (no database credentials in the cloud).
// Providers are pluggable: no real provider in this PR (Sambit, Q1 24 Nov). A real adapter (Gemini / OpenAI, after the
// pilot) implements ImageProvider and is added to resolveProvider. The fake one is for local work and tests only.
import { AccessError, verifyAccess, type AccessEnv } from './access.ts';
import type { Bucket } from './files.ts';
import { briefProblem, imagePrompt, imageSize, layoutOf, type ImageBrief } from '../../shared/image-brief.ts';

export interface ImageProvider {
  id: string; model: string; /** USD per image, for the estimate and the run ledger */ priceUsd: number;
  generate(prompt: string, size: { width: number; height: number }, brief: ImageBrief): Promise<{ bytes: Uint8Array; contentType: 'image/png' | 'image/jpeg' | 'image/webp'; costUsd: number }>;
}
export interface ImagesEnv extends AccessEnv {
  /** which provider: unset = not set up. 'fake' only where IMAGE_ALLOW_FAKE = '1' (local dev, tests). */
  IMAGE_PROVIDER?: string; IMAGE_ALLOW_FAKE?: string;
  /** reserved for the real adapter: its key (secret) and model */ IMAGE_API_KEY?: string; IMAGE_MODEL?: string;
  /** reserved (Q6, deferred until a real provider): daily cap in USD, enforced here with a KV counter binding */ IMAGE_DAILY_CAP_USD?: string;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
});

/** The configured provider, or null ("Image service not set up"). */
export function resolveProvider(env: ImagesEnv): ImageProvider | null {
  if (env.IMAGE_PROVIDER === 'fake' && env.IMAGE_ALLOW_FAKE === '1') return fakeProvider;
  // Real adapters go here after the Gemini / OpenAI pilot, e.g. if (env.IMAGE_PROVIDER === 'gemini' && env.IMAGE_API_KEY) return gemini(env);
  return null;
}

/** Q6 hook (deferred): before a real provider is called, check and add to today's spend (KV counter) against
 *  IMAGE_DAILY_CAP_USD; throw to refuse. No-op until a real provider and the KV binding exist. */
export async function checkDailyCap(_env: ImagesEnv, _costUsd: number): Promise<void> { /* added with the first real provider */ }

const QID = /^(SQ|MQ)\d{6}$/;
export async function handleImages(req: Request, env: ImagesEnv, bucket: Bucket, provider = resolveProvider(env), now = Date.now()): Promise<Response> {
  const action = new URL(req.url).pathname.replace(/^\/api\/images\/?/, '');
  try { await verifyAccess(req, env, now); } catch (e) {
    return json(403, { error: `Access required: ${e instanceof AccessError ? e.message : 'invalid token'}` });
  }
  if (action === 'status' && req.method === 'GET') {
    return json(200, provider ? { configured: true, provider: provider.id, model: provider.model, price_usd: provider.priceUsd } : { configured: false });
  }
  if (action === 'generate' && req.method === 'POST') {
    if (!provider) return json(503, { error: 'Image service not set up' });
    let body: { question_id?: string; brief?: ImageBrief };
    try { body = await req.json(); } catch { return json(400, { error: 'bad request' }); }
    if (!QID.test(body.question_id ?? '')) return json(400, { error: 'bad question_id' });
    const bad = briefProblem(body.brief) ?? (body.brief ? null : 'missing brief');
    if (bad) return json(400, { error: `Image brief: ${bad}` });
    const brief = body.brief!;
    const prompt = imagePrompt(brief);
    const promptSha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prompt)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    try {
      await checkDailyCap(env, provider.priceUsd);
      const img = await provider.generate(prompt, imageSize(brief), brief);
      const ext = img.contentType === 'image/png' ? 'png' : img.contentType === 'image/jpeg' ? 'jpg' : 'webp';
      const key = `figures/img/${body.question_id}-${now.toString(36)}-base.${ext}`;
      await bucket.put(key, img.bytes, { httpMetadata: { contentType: img.contentType } });
      return json(200, { base_path: key, provider: provider.id, model: provider.model, cost_usd: img.costUsd, prompt_sha: promptSha, layout: layoutOf(brief) });
    } catch (e) {
      return json(502, { error: `The image service failed: ${(e as Error).message}` });
    }
  }
  return json(404, { error: 'not found' });
}

// ---------------------------------------------------------------- fake provider (local / tests): placeholder panels, no letters
export const fakeProvider: ImageProvider = {
  id: 'fake', model: 'placeholder-panels', priceUsd: 0.04,
  async generate(_prompt, size, brief) {
    const { width: w, height: h } = { width: Math.round(size.width / 2), height: Math.round(size.height / 2) };
    const px = new Uint8Array(w * h * 3).fill(250);
    const layout = layoutOf(brief);
    const boxes = layout === 'row4' ? [0, 1, 2, 3].map((i) => [i * w / 4, 0, w / 4, h]) : layout === 'grid2x2'
      ? [0, 1, 2, 3].map((i) => [(i % 2) * w / 2, Math.floor(i / 2) * h / 2, w / 2, h / 2]) : [[0, 0, w, h]];
    const colours = [[120, 190, 120], [110, 160, 220], [230, 170, 90], [200, 120, 170]];
    boxes.forEach(([bx, by, bw, bh], i) => {
      const [r, g, b] = colours[i % 4]!;
      const cx = bx! + bw! / 2, cy = by! + bh! * 0.55, rad = Math.min(bw!, bh!) * 0.28;
      for (let y = Math.floor(by!); y < by! + bh!; y++) for (let x = Math.floor(bx!); x < bx! + bw!; x++) {
        const o = (y * w + x) * 3;
        const edge = x - bx! < 3 || bx! + bw! - x <= 3 || y - by! < 3 || by! + bh! - y <= 3;
        if (edge) { px.set([200, 200, 200], o); continue; }
        if ((x - cx) ** 2 + (y - cy) ** 2 < rad * rad) { px.set([r!, g!, b!], o); }
      }
    });
    return { bytes: await encodePng(w, h, px), contentType: 'image/png', costUsd: this.priceUsd };
  },
};

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** A minimal RGB PNG encoder (deflate via CompressionStream: Workers and Node both have it). */
export async function encodePng(w: number, h: number, rgb: Uint8Array): Promise<Uint8Array> {
  const raw = new Uint8Array(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out;
  };
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

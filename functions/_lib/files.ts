// The CMS file service (R2), as one Web-standard handler:
//   GET  /api/files/sign?key=…   Access required → { url, expires } (a signed download URL, 5 minutes)
//   GET  /api/files/get?key=…&exp=…&sig=…        → the file, only with a valid, unexpired signature
//   PUT  /api/files/put?key=figures/…  Access required → stores the body (PNG / JPEG / WebP, ≤ 50 MB)
// The bucket is private; nothing is ever deleted or listed.
// Only OUR OWN content (question figure images) may be stored (Sambit, 10 Nov 2026):
// book PDFs, scans and screenshots stay on Sambit's Mac, so PDFs are refused and
// every stored key must sit under figures/.
// Production: Cloudflare Pages Function with an R2 binding. Dev: scripts/dev-files.ts
// runs this same code against a local folder (the R2 stand-in).
import { AccessError, verifyAccess, type AccessEnv } from './access.ts';

/** The subset of R2Bucket this service uses (so a local stand-in can provide it). */
export interface Bucket {
  get(key: string): Promise<{ body: ReadableStream | ArrayBuffer | Uint8Array; httpMetadata?: { contentType?: string }; size: number } | null>;
  put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array, opts: { httpMetadata: { contentType: string } }): Promise<unknown>;
}
export interface FilesEnv extends AccessEnv { FILES_SIGNING_KEY: string }

export const MAX_BYTES = 50 * 1024 * 1024;
export const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const PUT_PREFIX = 'figures/';
export const TTL_SECONDS = 300;
/** Keys look like figures/MQ000123-v2.png: no leading slash, no "..", no odd characters. */
export const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
});
const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(secret: string, msg: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}
/** Constant-time comparison of two strings. */
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function signedPath(env: FilesEnv, key: string, now = Date.now()) {
  const exp = Math.floor(now / 1000) + TTL_SECONDS;
  const sig = await hmac(env.FILES_SIGNING_KEY, `${key}\n${exp}`);
  return { url: `/api/files/get?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`, expires: exp };
}

export async function handleFiles(req: Request, env: FilesEnv, bucket: Bucket, now = Date.now()): Promise<Response> {
  const url = new URL(req.url);
  const action = url.pathname.replace(/^\/api\/files\/?/, '');
  const key = url.searchParams.get('key') ?? '';
  if (!env.FILES_SIGNING_KEY || env.FILES_SIGNING_KEY.length < 32) return json(500, { error: 'file service is not configured' });
  if (!KEY_RE.test(key) || key.includes('..') || key.length > 300) return json(400, { error: 'bad key' });

  if (action === 'get' && req.method === 'GET') {
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig') ?? '';
    if (!Number.isInteger(exp) || exp < now / 1000) return json(403, { error: 'link expired' });
    if (exp > now / 1000 + TTL_SECONDS + 5) return json(403, { error: 'bad link' });
    if (!same(sig, await hmac(env.FILES_SIGNING_KEY, `${key}\n${exp}`))) return json(403, { error: 'bad link' });
    const obj = await bucket.get(key);
    if (!obj) return json(404, { error: 'not found' });
    return new Response(obj.body as BodyInit, { headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'content-disposition': 'inline',
      'cache-control': 'private, no-store', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff',
    } });
  }

  // Everything else needs a valid Cloudflare Access JWT.
  try { await verifyAccess(req, env, now); } catch (e) {
    return json(403, { error: `Access required: ${e instanceof AccessError ? e.message : 'invalid token'}` });
  }

  if (action === 'sign' && req.method === 'GET') return json(200, await signedPath(env, key, now));

  if (action === 'put' && req.method === 'PUT') {
    const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!key.startsWith(PUT_PREFIX)) return json(403, { error: 'only question figures (figures/…) can be stored; book files stay on the Mac' });
    if (!TYPES.includes(type)) return json(415, { error: 'only PNG, JPEG or WebP figure images' });
    const len = Number(req.headers.get('content-length') ?? NaN);
    if (!Number.isFinite(len)) return json(411, { error: 'content-length required' });
    if (len > MAX_BYTES) return json(413, { error: 'file over 50 MB' });
    const body = await req.arrayBuffer();
    if (body.byteLength > MAX_BYTES) return json(413, { error: 'file over 50 MB' });
    await bucket.put(key, body, { httpMetadata: { contentType: type } });
    return json(200, { key, size: body.byteLength });
  }
  return json(405, { error: 'method not allowed' });
}

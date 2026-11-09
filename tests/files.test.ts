// The R2 file service and its Cloudflare Access check, with real RS256 tokens.
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyAccess, type AccessEnv } from '../functions/_lib/access.ts';
import { handleFiles, MAX_BYTES, TTL_SECONDS, type Bucket, type FilesEnv } from '../functions/_lib/files.ts';

const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
let pair: CryptoKeyPair; let other: CryptoKeyPair; let env: FilesEnv;

async function token(claims: Record<string, unknown>, opts: { kid?: string; key?: CryptoKey; alg?: string } = {}) {
  const h = b64url(new TextEncoder().encode(JSON.stringify({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' })));
  const p = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opts.key ?? pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}
const good = () => ({ aud: ['aud-tag'], iss: 'https://team.cloudflareaccess.com', email: 'sambit@example.com', sub: 'u1', exp: NOW / 1000 + 600, nbf: NOW / 1000 - 10 });
const req = (path: string, init: RequestInit & { jwt?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.jwt) headers.set('cf-access-jwt-assertion', init.jwt);
  return new Request(`https://cms.example${path}`, { ...init, headers });
};

class MemoryBucket implements Bucket {
  m = new Map<string, { body: Uint8Array; type: string }>();
  async get(k: string) { const o = this.m.get(k); return o ? { body: o.body, httpMetadata: { contentType: o.type }, size: o.body.byteLength } : null; }
  async put(k: string, body: ArrayBuffer | Uint8Array | ReadableStream, o: { httpMetadata: { contentType: string } }) {
    this.m.set(k, { body: new Uint8Array(body as ArrayBuffer), type: o.httpMetadata.contentType });
  }
}

beforeAll(async () => {
  const gen = () => crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
  pair = await gen(); other = await gen();
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  env = { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud-tag', ACCESS_ALLOWED_EMAILS: 'sambit@example.com',
    ACCESS_JWKS_JSON: JSON.stringify({ keys: [{ ...jwk, kid: 'k1' }] }), FILES_SIGNING_KEY: 'x'.repeat(40) };
});

describe('Cloudflare Access JWT', () => {
  const check = async (jwt: string | null, e: Partial<AccessEnv> = {}) => verifyAccess(req('/', jwt ? { jwt } : {}), { ...env, ...e }, NOW);
  it('accepts a valid token for the allowed email', async () => {
    expect(await check(await token(good()))).toEqual({ email: 'sambit@example.com', sub: 'u1' });
  });
  it('also reads the CF_Authorization cookie', async () => {
    const t = await token(good());
    expect((await verifyAccess(req('/', { headers: { cookie: `x=1; CF_Authorization=${t}` } }), env, NOW)).email).toBe('sambit@example.com');
  });
  it.each<[string, () => Promise<string | null>, RegExp]>([
    ['no token at all', async () => null, /no Access token/],
    ['garbage', async () => 'abc', /malformed/],
    ['signed by another key', async () => token(good(), { key: other.privateKey }), /bad signature/],
    ['unknown key id', async () => token(good(), { kid: 'k9' }), /unknown signing key/],
    ['alg none', async () => { const t = await token(good()); const [, p] = t.split('.'); return `${b64url(new TextEncoder().encode('{"alg":"none","kid":"k1"}'))}.${p}.`; }, /unexpected algorithm|malformed/],
    ['wrong audience', async () => token({ ...good(), aud: ['other-app'] }), /wrong audience/],
    ['wrong issuer', async () => token({ ...good(), iss: 'https://evil.cloudflareaccess.com' }), /wrong issuer/],
    ['expired', async () => token({ ...good(), exp: NOW / 1000 - 1 }), /expired/],
    ['another email', async () => token({ ...good(), email: 'someone@else.com' }), /email not allowed/],
    ['a service token with no email', async () => token({ ...good(), email: undefined, common_name: 'svc' }), /email not allowed/],
  ])('refuses: %s', async (_n, make, msg) => {
    await expect(check(await make())).rejects.toThrow(msg);
  });
  it('refuses everything when Access is not configured', async () => {
    await expect(check(await token(good()), { ACCESS_AUD: '' })).rejects.toThrow(/not configured/);
  });
});

describe('file service (R2)', () => {
  const PDF = new TextEncoder().encode('%PDF-1.4 test');
  const run = (r: Request, bucket: Bucket, t = NOW) => handleFiles(r, env, bucket, t);

  it('a request without Access is refused (sign and put)', async () => {
    const b = new MemoryBucket();
    expect((await run(req('/api/files/sign?key=NCERT-fegp101/fegp101.pdf'), b)).status).toBe(403);
    const put = await run(req('/api/files/put?key=a/b.pdf', { method: 'PUT', body: PDF, headers: { 'content-type': 'application/pdf', 'content-length': String(PDF.byteLength) } }), b);
    expect(put.status).toBe(403);
    expect(b.m.size).toBe(0);
  });

  it('with Access: upload, sign, then download through the signed URL', async () => {
    const b = new MemoryBucket(); const jwt = await token(good());
    const put = await run(req('/api/files/put?key=NCERT-fegp101/fegp101.pdf', { method: 'PUT', jwt, body: PDF, headers: { 'content-type': 'application/pdf', 'content-length': String(PDF.byteLength) } }), b);
    expect(put.status).toBe(200);
    const s = await run(req('/api/files/sign?key=NCERT-fegp101/fegp101.pdf', { jwt }), b);
    const { url, expires } = await s.json() as { url: string; expires: number };
    expect(expires).toBe(NOW / 1000 + TTL_SECONDS);
    const g = await run(req(url), b); // a signed URL works without the JWT (the browser opens it in a new tab)
    expect(g.status).toBe(200);
    expect(g.headers.get('content-type')).toBe('application/pdf');
    expect(g.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await g.arrayBuffer())).toEqual(PDF);
  });

  it('signed URLs expire, and a tampered key or signature is refused', async () => {
    const b = new MemoryBucket(); await b.put('a/x.pdf', PDF, { httpMetadata: { contentType: 'application/pdf' } });
    await b.put('a/y.pdf', PDF, { httpMetadata: { contentType: 'application/pdf' } });
    const { url } = await (await run(req('/api/files/sign?key=a/x.pdf', { jwt: await token(good()) }), b)).json() as { url: string };
    expect((await run(req(url), b, NOW + (TTL_SECONDS + 1) * 1000)).status).toBe(403);
    expect((await run(req(url.replace('a%2Fx.pdf', 'a%2Fy.pdf')), b)).status).toBe(403);
    expect((await run(req(url.replace(/sig=./, 'sig=A')), b)).status).toBe(403);
    expect((await run(req(url.replace(/exp=\d+/, `exp=${NOW / 1000 + 86400}`)), b)).status).toBe(403);
    expect((await run(req('/api/files/get?key=a/x.pdf'), b)).status).toBe(403);
  });

  it('rejects bad keys, wrong types and files over 50 MB', async () => {
    const b = new MemoryBucket(); const jwt = await token(good());
    for (const k of ['../etc/passwd', '/abs.pdf', 'a/../b.pdf', 'a//b.pdf', 'sp ace.pdf']) {
      expect((await run(req(`/api/files/sign?key=${encodeURIComponent(k)}`, { jwt }), b)).status, k).toBe(400);
    }
    const txt = await run(req('/api/files/put?key=a/x.txt', { method: 'PUT', jwt, body: 'hi', headers: { 'content-type': 'text/plain', 'content-length': '2' } }), b);
    expect(txt.status).toBe(415);
    const big = await run(req('/api/files/put?key=a/big.pdf', { method: 'PUT', jwt, body: PDF, headers: { 'content-type': 'application/pdf', 'content-length': String(MAX_BYTES + 1) } }), b);
    expect(big.status).toBe(413);
    expect(b.m.size).toBe(0);
  });

  it('refuses to run without a strong signing key; no delete or list', async () => {
    const b = new MemoryBucket(); const jwt = await token(good());
    expect((await handleFiles(req('/api/files/sign?key=a/x.pdf', { jwt }), { ...env, FILES_SIGNING_KEY: 'short' }, b, NOW)).status).toBe(500);
    expect((await run(req('/api/files/put?key=a/x.pdf', { method: 'DELETE', jwt }), b)).status).toBe(405);
    expect((await run(req('/api/files/list?key=a', { jwt }), b)).status).toBe(405);
  });
});

// Images PR (DL-040, 24 Nov 2026): the structured brief (shared/image-brief.ts) and the image service (functions/_lib/images.ts)
// with the fake provider and real RS256 Access tokens. Synthetic briefs in our own words.
import { beforeAll, describe, expect, it } from 'vitest';
import { briefFromText, briefProblem, briefText, imagePrompt, imageSize, inferLayout, labelPositions, labelsToPlace, type ImageBrief } from '../shared/image-brief.ts';
import { encodePng, fakeProvider, handleImages, resolveProvider, type ImagesEnv } from '../functions/_lib/images.ts';
import type { Bucket } from '../functions/_lib/files.ts';

const ROW4: ImageBrief = { shown: 'Four separate fruits in a row: a mango, a banana, an apple and a guava.', style: 'flat colour', must_not_show: 'no words', layout: 'row4',
  labels: [{ label: 'B', points_to: 'the banana' }, { label: 'A', points_to: 'the mango' }, { label: 'C', points_to: 'the apple' }, { label: 'D', points_to: 'the guava' }] };

describe('the structured brief', () => {
  it('shape rules (same as the database)', () => {
    expect(briefProblem(ROW4)).toBeNull();
    expect(briefProblem(null)).toBeNull();
    expect(briefProblem({ shown: ' ' })).toMatch(/needs "shown"/);
    expect(briefProblem({ ...ROW4, layout: 'grid3x3' })).toMatch(/layout/);
    expect(briefProblem({ ...ROW4, labels: [{ label: 'E', points_to: 'x' }] })).toMatch(/A, B, C or D/);
    expect(briefProblem({ ...ROW4, labels: [{ label: 'A', points_to: 'x' }, { label: 'A', points_to: 'y' }] })).toMatch(/twice/);
    expect(briefProblem({ ...ROW4, labels: [{ label: 'A', points_to: 'x', x: 1.2 }] })).toMatch(/0–1/);
  });
  it('as text (figure_description) and back', () => {
    const t = briefText(ROW4);
    expect(t).toBe('Shown: Four separate fruits in a row: a mango, a banana, an apple and a guava. · Style: flat colour · Must NOT show: no words · Labels: A -> the mango; B -> the banana; C -> the apple; D -> the guava');
    expect(briefFromText(t)).toEqual({ shown: ROW4.shown, style: 'flat colour', must_not_show: 'no words', labels: [
      { label: 'A', points_to: 'the mango' }, { label: 'B', points_to: 'the banana' }, { label: 'C', points_to: 'the apple' }, { label: 'D', points_to: 'the guava' }] });
    expect(briefFromText('A girl holds a cold bottle with water drops on it.')).toEqual({ shown: 'A girl holds a cold bottle with water drops on it.', labels: [] });
  });
  it('layout fallback (the Science session writes layout; this is only used without it)', () => {
    const L = ROW4.labels;
    expect(inferLayout({ shown: 'Four separate body parts drawn at the same size in a row', labels: L })).toBe('row4');
    expect(inferLayout({ shown: 'Four separate houses, one in each of four equal boxes labelled A, B, C, D', labels: L })).toBe('grid2x2');
    expect(inferLayout({ shown: 'A tomato plant. Four thin lines point to four parts of it.', labels: L })).toBe('single');
    expect(inferLayout({ shown: 'A girl with a bottle.', labels: [] })).toBe('single');
  });
  it('the prompt: panels in label order, no letters or words, our own wording only', () => {
    const p = imagePrompt(ROW4);
    expect(p).toMatch(/Four equal panels side by side, left to right/);
    expect(p).toMatch(/Panel contents in order: 1\) the mango; 2\) the banana; 3\) the apple; 4\) the guava\./);
    expect(p).toMatch(/Do NOT show: no words; any letters, numbers, words, labels or captions \(labels are added later\)/);
    expect(imageSize(ROW4)).toEqual({ width: 2048, height: 768 });
    expect(imagePrompt({ ...ROW4, layout: 'single' })).toMatch(/One scene\.\nWhat it shows: .*\nThe scene must clearly show: the mango; the banana; the apple; the guava\./);
  });
  it('label positions: one per panel (row4 / grid2x2); placed points for a single scene', () => {
    expect(labelPositions(ROW4).map((l) => [l.label, +l.x.toFixed(2), l.y])).toEqual([['A', 0.02, 0.08], ['B', 0.27, 0.08], ['C', 0.52, 0.08], ['D', 0.77, 0.08]]);
    expect(labelPositions({ ...ROW4, layout: 'grid2x2' }).map((l) => [l.label, +l.x.toFixed(2), +l.y.toFixed(2)])).toEqual([['A', 0.04, 0.05], ['B', 0.54, 0.05], ['C', 0.04, 0.55], ['D', 0.54, 0.55]]);
    const single: ImageBrief = { ...ROW4, layout: 'single', labels: [{ label: 'A', points_to: 'the roots', x: 0.4, y: 0.9 }, { label: 'B', points_to: 'the stem' }] };
    expect(labelsToPlace(single)).toEqual(['B']);
    expect(labelsToPlace(ROW4)).toEqual([]);
  });
});

// ---------------------------------------------------------------- the image service
const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
let pair: CryptoKeyPair; let env: ImagesEnv;
async function token() {
  const h = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })));
  const p = b64url(new TextEncoder().encode(JSON.stringify({ aud: ['aud-tag'], iss: 'https://team.cloudflareaccess.com', email: 'sambit@example.com', sub: 'u1', exp: NOW / 1000 + 600, nbf: NOW / 1000 - 10 })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}
class MemoryBucket implements Bucket {
  m = new Map<string, { body: Uint8Array; type: string }>();
  async get(k: string) { const o = this.m.get(k); return o ? { body: o.body, httpMetadata: { contentType: o.type }, size: o.body.byteLength } : null; }
  async put(k: string, body: ArrayBuffer | Uint8Array | ReadableStream, o: { httpMetadata: { contentType: string } }) { this.m.set(k, { body: new Uint8Array(body as ArrayBuffer), type: o.httpMetadata.contentType }); }
}
const req = async (path: string, init: RequestInit & { auth?: boolean } = {}) => {
  const headers = new Headers(init.headers);
  if (init.auth !== false) headers.set('cf-access-jwt-assertion', await token());
  return new Request(`https://cms.example${path}`, { ...init, headers });
};
beforeAll(async () => {
  pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  env = { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud-tag', ACCESS_ALLOWED_EMAILS: 'sambit@example.com', ACCESS_JWKS_JSON: JSON.stringify({ keys: [{ ...jwk, kid: 'k1' }] }) };
});

describe('the image service', () => {
  it('Access is required', async () => {
    const r = await handleImages(await req('/api/images/status', { auth: false }), env, new MemoryBucket(), fakeProvider, NOW);
    expect(r.status).toBe(403);
  });
  it('no provider (the real project in this PR): "Image service not set up"; the fake one never runs without IMAGE_ALLOW_FAKE', async () => {
    expect(resolveProvider(env)).toBeNull();
    expect(resolveProvider({ ...env, IMAGE_PROVIDER: 'fake' })).toBeNull();
    expect(resolveProvider({ ...env, IMAGE_PROVIDER: 'fake', IMAGE_ALLOW_FAKE: '1' })).toBe(fakeProvider);
    expect(await (await handleImages(await req('/api/images/status'), env, new MemoryBucket(), null, NOW)).json()).toEqual({ configured: false });
    const g = await handleImages(await req('/api/images/generate', { method: 'POST', body: JSON.stringify({ question_id: 'SQ000001', brief: ROW4 }) }), env, new MemoryBucket(), null, NOW);
    expect([g.status, (await g.json() as { error: string }).error]).toEqual([503, 'Image service not set up']);
  });
  it('fake provider: a PNG without letters stored under figures/img/; cost and prompt sha returned; no key in the answer', async () => {
    const bucket = new MemoryBucket();
    const s = await (await handleImages(await req('/api/images/status'), { ...env, IMAGE_API_KEY: 'secret-key-xyz' }, bucket, fakeProvider, NOW)).json();
    expect(s).toEqual({ configured: true, provider: 'fake', model: 'placeholder-panels', price_usd: 0.04 });
    const r = await handleImages(await req('/api/images/generate', { method: 'POST', body: JSON.stringify({ question_id: 'SQ001313', brief: ROW4 }) }), { ...env, IMAGE_API_KEY: 'secret-key-xyz' }, bucket, fakeProvider, NOW);
    const text = await r.clone().text();
    const body = await r.json() as { base_path: string; cost_usd: number; prompt_sha: string; layout: string };
    expect(r.status).toBe(200);
    expect(body.base_path).toMatch(/^figures\/img\/SQ001313-[a-z0-9]+-base\.png$/);
    expect(body).toMatchObject({ cost_usd: 0.04, layout: 'row4', prompt_sha: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(text).not.toContain('secret-key-xyz');
    const png = bucket.m.get(body.base_path)!;
    expect(png.type).toBe('image/png');
    expect([...png.body.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
  it('refuses a bad question ID or a bad brief', async () => {
    const send = async (b: unknown) => (await handleImages(await req('/api/images/generate', { method: 'POST', body: JSON.stringify(b) }), env, new MemoryBucket(), fakeProvider, NOW)).status;
    expect(await send({ question_id: 'figures/../x', brief: ROW4 })).toBe(400);
    expect(await send({ question_id: 'SQ000001', brief: { shown: '' } })).toBe(400);
    expect(await send({ question_id: 'SQ000001' })).toBe(400);
  });
  it('encodePng: a valid PNG header and size', async () => {
    const b = await encodePng(3, 2, new Uint8Array(18).fill(255));
    expect(Buffer.from(b).readUInt32BE(16)).toBe(3);
    expect(Buffer.from(b).readUInt32BE(20)).toBe(2);
  });
});

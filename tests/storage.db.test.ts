// Storage policies (bootstrap 02) against THIS repo's local Supabase, through the real
// Storage API with real sessions. Needs `npm run db:local:storage` once.
import { beforeAll, describe, expect, it } from 'vitest';
import { localApi, signInOrUp, type Api, type Session } from '../scripts/lib/supabase-session.ts';
import { LOCAL_ADMIN } from '../scripts/verify-uid.ts';

const APP_USER = { email: 'app-user@cms.local.test', password: 'local-test-pw-2' };
const PATH = 'tests/storage-probe.pdf';
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

let api: Api; let admin: Session; let app: Session;
const storage = (s: Session | null, method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) =>
  fetch(`${api.url}/storage/v1/${path}`, {
    method, body,
    headers: { apikey: api.anonKey, authorization: `Bearer ${s ? s.accessToken : api.anonKey}`, ...headers },
  });

beforeAll(async () => {
  api = localApi();
  admin = await signInOrUp(api, LOCAL_ADMIN.email, LOCAL_ADMIN.password);
  app = await signInOrUp(api, APP_USER.email, APP_USER.password);
  // the admin ID must be the local admin (the RLS tests set it too)
  const r = await fetch(`${api.url}/rest/v1/rpc/cms_is_admin`, { method: 'POST', headers: { apikey: api.anonKey, authorization: `Bearer ${admin.accessToken}`, 'content-profile': 'cms', 'content-type': 'application/json' }, body: JSON.stringify({ uid: admin.userId }) });
  if ((await r.json()) !== true) throw new Error('local admin_user_id is not the local test admin; run npm run test:db (rls) first');
});

describe('bucket cms-sources (bootstrap 02)', () => {
  it('admin can upload and replace (upsert) a PDF', async () => {
    const r = await storage(admin, 'POST', `object/cms-sources/${PATH}`, PDF, { 'content-type': 'application/pdf', 'x-upsert': 'true' });
    expect(r.status, await r.clone().text()).toBe(200);
  });

  it('admin can read it, and get a signed URL that works', async () => {
    expect((await storage(admin, 'GET', `object/authenticated/cms-sources/${PATH}`)).status).toBe(200);
    const s = await storage(admin, 'POST', `object/sign/cms-sources/${PATH}`, JSON.stringify({ expiresIn: 60 }), { 'content-type': 'application/json' });
    const { signedURL } = await s.json() as { signedURL: string };
    const f = await fetch(`${api.url}/storage/v1${signedURL}`);
    expect(f.status).toBe(200);
    expect(new Uint8Array(await f.arrayBuffer()).slice(0, 5)).toEqual(PDF.slice(0, 5));
  });

  it('admin cannot delete (no delete policy: source files are never deleted)', async () => {
    await storage(admin, 'DELETE', `object/cms-sources/${PATH}`);
    expect((await storage(admin, 'GET', `object/authenticated/cms-sources/${PATH}`)).status).toBe(200);
  });

  it('only PDF and images are accepted', async () => {
    const r = await storage(admin, 'POST', 'object/cms-sources/tests/not-allowed.txt', 'hello', { 'content-type': 'text/plain', 'x-upsert': 'true' });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it('an app user can neither read nor upload', async () => {
    expect((await storage(app, 'GET', `object/authenticated/cms-sources/${PATH}`)).status).toBeGreaterThanOrEqual(400);
    const up = await storage(app, 'POST', 'object/cms-sources/tests/app-user.pdf', PDF, { 'content-type': 'application/pdf' });
    expect(up.status).toBeGreaterThanOrEqual(400);
    const list = await storage(app, 'POST', 'object/list/cms-sources', JSON.stringify({ prefix: 'tests', limit: 10 }), { 'content-type': 'application/json' });
    expect(list.status === 200 ? (await list.json() as unknown[]).length : 0).toBe(0);
  });

  it('anon gets nothing', async () => {
    expect((await storage(null, 'GET', `object/authenticated/cms-sources/${PATH}`)).status).toBeGreaterThanOrEqual(400);
    expect((await storage(null, 'GET', `object/public/cms-sources/${PATH}`)).status).toBeGreaterThanOrEqual(400);
  });
});

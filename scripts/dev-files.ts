// npm run dev:files — local stand-ins (dev only) for the R2 file service and the AI
// service (/api/ai, with a fake model: no API key, no cost).
// Serves functions/_lib/files.ts (the same code as the Pages Function) on
// http://127.0.0.1:8790 against .r2-local/cms-sources, with a LOCAL Access key:
// .dev-access/ holds a generated RSA key, its JWKS and a dev token for
// admin@cms.local.test. Also serves /api/local/… (U3: the Import screen's local mode; scripts/lib/local-import.ts).
// The Vite dev server forwards /api here and adds that
// token, playing Cloudflare Access's part. Without the token, requests are refused.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { handleAi } from '../functions/_lib/ai.ts';
import { handleFiles, type FilesEnv } from '../functions/_lib/files.ts';
import { fakeAiClient } from './lib/fake-ai.ts';
import { handleLocal } from './lib/local-import.ts';
import { verifyAccess } from '../functions/_lib/access.ts';
import { FolderBucket } from './lib/r2-local.ts';

export const DEV_ACCESS_DIR = resolve(import.meta.dirname, '..', '.dev-access');
export const DEV = { team: 'local-dev.cloudflareaccess.com', aud: 'local-dev-aud', email: 'admin@cms.local.test' };
const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');

export async function ensureDevAccess() {
  mkdirSync(DEV_ACCESS_DIR, { recursive: true });
  const keyFile = join(DEV_ACCESS_DIR, 'key.json');
  if (!existsSync(keyFile)) {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    writeFileSync(keyFile, JSON.stringify({ private: await crypto.subtle.exportKey('jwk', pair.privateKey), public: await crypto.subtle.exportKey('jwk', pair.publicKey) }));
    writeFileSync(join(DEV_ACCESS_DIR, 'signing-key'), b64url(crypto.getRandomValues(new Uint8Array(32))));
  }
  const { private: priv, public: pub } = JSON.parse(readFileSync(keyFile, 'utf8'));
  const key = await crypto.subtle.importKey('jwk', priv, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid: 'dev', typ: 'JWT' })));
  const p = b64url(new TextEncoder().encode(JSON.stringify({ aud: [DEV.aud], iss: `https://${DEV.team}`, email: DEV.email, sub: 'dev', iat: now, exp: now + 7 * 86400 })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`));
  const token = `${h}.${p}.${b64url(sig)}`;
  writeFileSync(join(DEV_ACCESS_DIR, 'token'), token);
  const env: FilesEnv = {
    ACCESS_TEAM_DOMAIN: DEV.team, ACCESS_AUD: DEV.aud, ACCESS_ALLOWED_EMAILS: DEV.email,
    ACCESS_JWKS_JSON: JSON.stringify({ keys: [{ ...pub, kid: 'dev' }] }),
    FILES_SIGNING_KEY: readFileSync(join(DEV_ACCESS_DIR, 'signing-key'), 'utf8'),
  };
  return { env, token };
}

if (import.meta.filename === process.argv[1]) {
  const { env } = await ensureDevAccess();
  const bucket = new FolderBucket();
  const ai = fakeAiClient(); // local dev never calls the real Claude API
  const port = Number(process.env.DEV_FILES_PORT ?? 8790);
  createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers, body: chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined });
      const path = new URL(request.url).pathname;
      // U3: local-mode import (this Mac only; the live site has no /api/local). Same Access check as the file service.
      const r = path.startsWith('/api/local/') ? await verifyAccess(request, env).then(() => handleLocal(request), () => new Response(JSON.stringify({ error: 'Access required' }), { status: 403 }))
        : path.startsWith('/api/ai/') ? await handleAi(request, env, ai) : await handleFiles(request, env, bucket);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: (e as Error).message }));
    }
  }).listen(port, '127.0.0.1', () => console.log(`dev file service (R2 stand-in) on http://127.0.0.1:${port} · bucket ${bucket ? '.r2-local/cms-sources' : ''}`));
}

// Cloudflare Access JWT validation (Web Crypto only; runs in Pages Functions and Node).
// Every file request that is not a signed download must carry a valid Access JWT:
// RS256 signature from the team's keys, the application's audience (AUD tag),
// the team issuer, not expired, and an allowed email.

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN: string;         // e.g. witoscope.cloudflareaccess.com
  ACCESS_AUD: string;                 // the Access application's AUD tag
  ACCESS_ALLOWED_EMAILS: string;      // comma-separated; Sambit only
  ACCESS_JWKS_JSON?: string;          // local dev / tests only: inline JWKS instead of fetching the team's certs
}
export interface AccessIdentity { email: string; sub: string }
export class AccessError extends Error {}

type Jwk = JsonWebKey & { kid?: string };
const b64urlBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const b64urlJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

let jwksCache: { url: string; keys: Jwk[]; at: number } | null = null;
async function keys(env: AccessEnv): Promise<Jwk[]> {
  if (env.ACCESS_JWKS_JSON) return (JSON.parse(env.ACCESS_JWKS_JSON) as { keys: Jwk[] }).keys;
  const url = `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  if (jwksCache && jwksCache.url === url && Date.now() - jwksCache.at < 10 * 60_000) return jwksCache.keys;
  const r = await fetch(url);
  if (!r.ok) throw new AccessError(`could not load Access certs (${r.status})`);
  const k = ((await r.json()) as { keys: Jwk[] }).keys;
  jwksCache = { url, keys: k, at: Date.now() };
  return k;
}

/** The Access JWT from the header Access adds, or from its cookie. */
export function accessToken(req: Request): string | null {
  const h = req.headers.get('cf-access-jwt-assertion');
  if (h) return h;
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get('cookie') ?? '');
  return m ? decodeURIComponent(m[1]!) : null;
}

export async function verifyAccess(req: Request, env: AccessEnv, now = Date.now()): Promise<AccessIdentity> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ACCESS_ALLOWED_EMAILS) throw new AccessError('Access is not configured');
  const token = accessToken(req);
  if (!token) throw new AccessError('no Access token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new AccessError('malformed token');
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string }, payload: Record<string, unknown>;
  try { header = b64urlJson(h); payload = b64urlJson(p); } catch { throw new AccessError('malformed token'); }
  if (header.alg !== 'RS256') throw new AccessError('unexpected algorithm');
  const jwk = (await keys(env)).find((k) => k.kid === header.kid);
  if (!jwk) throw new AccessError('unknown signing key');
  const key = await crypto.subtle.importKey('jwk', { ...jwk, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new AccessError('bad signature');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new AccessError('wrong audience');
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) throw new AccessError('wrong issuer');
  const sec = now / 1000;
  if (typeof payload.exp !== 'number' || payload.exp < sec) throw new AccessError('expired');
  if (typeof payload.nbf === 'number' && payload.nbf > sec + 60) throw new AccessError('not yet valid');
  const email = String(payload.email ?? '').toLowerCase();
  const allowed = env.ACCESS_ALLOWED_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!email || !allowed.includes(email)) throw new AccessError('email not allowed');
  return { email, sub: String(payload.sub ?? '') };
}

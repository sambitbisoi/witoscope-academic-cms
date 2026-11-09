// Real signed-in sessions against Supabase Auth, using only the public anon key.
// Never uses service_role.
import { execFileSync } from 'node:child_process';

export interface Api { url: string; anonKey: string }

/** Local stack only: read API URL and anon key from `supabase status`. */
export function localApi(): Api {
  const s = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  if (!String(s.API_URL).includes(':55421')) throw new Error(`Unexpected local API ${s.API_URL}; expected this repo's stack on 55421.`);
  return { url: s.API_URL, anonKey: s.ANON_KEY };
}

/** Hosted (or explicit) project: from env. */
export function envApi(): Api {
  const url = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  return { url, anonKey };
}

export interface Session { accessToken: string; userId: string; claims: Record<string, unknown> }

export function decodeClaims(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('not a JWT');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function authCall(api: Api, path: string, body: unknown) {
  const res = await fetch(`${api.url}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: api.anonKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, json: (await res.json()) as any };
}

export async function signIn(api: Api, email: string, password: string): Promise<Session> {
  const r = await authCall(api, 'token?grant_type=password', { email, password });
  if (!r.ok) throw new Error(`sign-in failed for ${email}: ${r.status} ${r.json?.msg ?? r.json?.error_description ?? ''}`);
  return { accessToken: r.json.access_token, userId: r.json.user.id, claims: decodeClaims(r.json.access_token) };
}

/** Local test users only: sign in, or sign up first if the user does not exist. */
export async function signInOrUp(api: Api, email: string, password: string): Promise<Session> {
  try {
    return await signIn(api, email, password);
  } catch {
    const r = await authCall(api, 'signup', { email, password });
    if (!r.ok) throw new Error(`sign-up failed for ${email}: ${r.status} ${JSON.stringify(r.json)}`);
    return signIn(api, email, password);
  }
}

/** Call PostgREST in schema cms, as the session (or as anon when session is null). */
export async function rest(api: Api, session: Session | null, path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${api.url}/rest/v1/${path}`, {
    method: init.method ?? 'GET',
    headers: {
      apikey: api.anonKey,
      authorization: `Bearer ${session ? session.accessToken : api.anonKey}`,
      'accept-profile': 'cms',
      'content-profile': 'cms',
      'content-type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

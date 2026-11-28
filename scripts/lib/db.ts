// The one way scripts connect to the database: as cms_owner (migrations, admin scripts), cms_reader (read-only reports,
// keys:audit, the engine snapshot) or cms_gen_writer (Route B imports; EXECUTE on the generation functions only).
// Never service_role or any other role (Q38 PR 2, plan §8).
import postgres from 'postgres';
import { assertLocal, LOCAL_CMS_OWNER_URL } from '../local-bootstrap.ts';

// Default: THIS repo's local container. The real project is reached only by naming
// it explicitly: `npx tsx --env-file=.env.real scripts/<script>.ts` (runbook).
// npm scripts never read .env, so a .env pointing at the real project is harmless.
export const targetUrl = () => process.env.CMS_DATABASE_URL ?? LOCAL_CMS_OWNER_URL;

export const CMS_ROLES = ['cms_owner', 'cms_reader', 'cms_gen_writer'] as const;
export type CmsRole = (typeof CMS_ROLES)[number];
/** The login role a URL names (the pooler adds ".<project ref>"). */
export const urlRole = (url = targetUrl()) => decodeURIComponent(new URL(url).username).split('.')[0] ?? '';

export function connect(url = targetUrl(), opts: { keepAliveSeconds?: number } = {}) {
  const user = decodeURIComponent(new URL(url).username).split('.')[0];
  if (!(CMS_ROLES as readonly string[]).includes(user ?? '')) {
    throw new Error(`Refusing to connect as "${user}". Scripts connect as ${CMS_ROLES.join(', ')} only.`);
  }
  const host = new URL(url).hostname;
  if (host === '127.0.0.1' || host === 'localhost') assertLocal(url);
  // prepare: false keeps this working through the Supabase pooler.
  return postgres(url, { prepare: false, onnotice: () => {}, connection: { application_name: 'witoscope-cms' },
    ...(opts.keepAliveSeconds ? { keep_alive: opts.keepAliveSeconds, connect_timeout: 30 } : {}) });
}

// Go-live, 13 Nov 2026: a fresh connection per unit of work (one file), with TCP keep-alive and a watchdog.
// A dropped connection is retried ONCE: the old server session (if still there) is ended first and waited for,
// so the retry is not blocked by a half-dead transaction (which rolls back). A second drop stops the run.
export type Sql = ReturnType<typeof connect>;
export type UnitRunner = <T>(label: string, fn: (sql: Sql) => Promise<T>) => Promise<T>;
const DROPPED = /ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|CONNECTION_(CLOSED|ENDED|DESTROYED)|connection (terminated|closed)|terminating connection|57P0[123]|^08\d{3}|watchdog/i;
export const isDropped = (e: unknown) => { const x = e as { code?: string; message?: string }; return DROPPED.test(`${x?.code ?? ''}`) || DROPPED.test(`${x?.message ?? ''}`); };
export function freshConnections(o: { watchdogMs?: number; log?: (s: string) => void; url?: string } = {}): UnitRunner {
  const watchdogMs = o.watchdogMs ?? 10 * 60_000;
  const log = o.log ?? ((s: string) => console.log(s));
  return async (label, fn) => {
    let lastPid: number | null = null;
    for (let attempt = 1; ; attempt++) {
      const sql = connect(o.url, { keepAliveSeconds: 10 });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        lastPid = Number((await sql`select pg_backend_pid() as pid`)[0]!.pid);
        const watchdog = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`watchdog: no answer for ${watchdogMs / 60_000} min`)), watchdogMs); });
        return await Promise.race([fn(sql), watchdog]);
      } catch (e) {
        const msg = (e as Error).message;
        if (!isDropped(e)) throw e;
        if (attempt >= 2) throw new Error(`${label}: the connection dropped again (${msg}); stopped`);
        log(`  ! ${label}: connection dropped (${msg}); ending the old session and retrying once on a fresh connection`);
        await endSession(lastPid, o.url, log);
      } finally {
        if (timer) clearTimeout(timer);
        await sql.end({ timeout: 2 }).catch(() => {});
      }
    }
  };
}
/** End a (half-dead) server session of ours and wait until it is gone (its open transaction rolls back). */
async function endSession(pid: number | null, url: string | undefined, log: (s: string) => void) {
  if (!pid) return;
  const sql = connect(url, { keepAliveSeconds: 10 });
  try {
    for (let i = 0; i < 60; i++) {
      const [row] = await sql`select pid from pg_stat_activity where pid = ${pid} and usename = current_user`;
      if (!row) { log(`    old session ${pid} is gone`); return; }
      if (i === 0) { await sql`select pg_terminate_backend(${pid})`; log(`    ended old session ${pid}`); }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`old session ${pid} did not end within 2 minutes`);
  } finally { await sql.end({ timeout: 2 }).catch(() => {}); }
}

/** Belt and braces: confirm the server agrees we are one of these roles; returns it. */
export async function assertRole(sql: ReturnType<typeof connect>, roles: readonly CmsRole[]): Promise<CmsRole> {
  const [row] = await sql<{ session_user: string }[]>`select session_user`;
  if (!roles.includes(row?.session_user as CmsRole)) throw new Error(`Connected as ${row?.session_user}, expected ${roles.join(' or ')}.`);
  return row!.session_user as CmsRole;
}

/** Belt and braces: confirm the server agrees we are cms_owner. */
export async function assertCmsOwner(sql: ReturnType<typeof connect>) {
  const [row] = await sql<{ current_user: string }[]>`select current_user`;
  if (row?.current_user !== 'cms_owner') throw new Error(`Connected as ${row?.current_user}, expected cms_owner.`);
}

// ---------------------------------------------------------------- the work lease (Q38 PR 2, plan §10: one CMS writer at a time)
export interface LeaseState { holder: string | null; kind: string | null; note: string | null; taken_by: string | null; taken_at: string | null; heartbeat_at: string | null; expires_at: string | null; live: boolean }
export interface Lease { holder: string; taken: 'new' | 'renewed' | 'takeover'; /** true when the heartbeat found the lease gone */ lost: boolean; release(): Promise<void> }
/** Take the work lease for the length of a script, on a connection of its own, kept alive by a heartbeat
 *  (every minutes/3). Refuses (throws) while another holder's lease is live. With CMS_LEASE_HOLDER set
 *  (a CMS session that took the lease with `npm run lease -- take`), the script runs under that lease and leaves it held. */
export async function takeLease(o: { kind: 'gen_import' | 'cms_session' | 'route_a_collect' | 'script'; holder: string; note?: string | null; minutes?: number; url?: string; log?: (s: string) => void }): Promise<Lease> {
  const log = o.log ?? ((s: string) => console.log(s));
  const outer = process.env.CMS_LEASE_HOLDER?.trim() || null;
  const holder = outer ?? o.holder, minutes = o.minutes ?? 15;
  const sql = connect(o.url, { keepAliveSeconds: 10 });
  let r: { taken: Lease['taken']; lease: LeaseState };
  try {
    const rows = await sql<{ r: typeof r }[]>`select cms.cms_take_lease(${sql.json({ holder, kind: outer ? 'cms_session' : o.kind, note: o.note ?? null, minutes } as never)}) as r`;
    r = rows[0]!.r;
  } catch (e) { await sql.end({ timeout: 2 }).catch(() => {}); throw e; }
  const lease: Lease = { holder, taken: r.taken, lost: false, release: async () => {} };
  const timer = setInterval(() => {
    sql`select cms.cms_heartbeat_lease(${holder}, ${minutes})`.catch((e: Error) => {
      if (/Lost the work lease/.test(e.message)) { lease.lost = true; log(`  ! ${e.message}`); }
      else log(`  ! lease heartbeat failed (${e.message}); retrying at the next beat`);
    });
  }, Math.max(20_000, (minutes * 60_000) / 3));
  timer.unref();
  lease.release = async () => {
    clearInterval(timer);
    try { if (!outer) await sql`select cms.cms_release_lease(${holder}, false)`; }
    finally { await sql.end({ timeout: 2 }).catch(() => {}); }
  };
  if (r.taken === 'takeover') log(`  (took over an expired work lease)`);
  return lease;
}

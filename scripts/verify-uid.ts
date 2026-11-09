// npm run verify:uid -- local            (this repo's local stack; runs everything)
// npm run verify:uid -- hosted           (real project, BEFORE exposing cms)
//
// Proves that, for a real signed-in session, cms.cms_current_uid() equals
// auth.uid() (option A, docs/phase2-plan.md).
//
// hosted: signs in with CMS_VERIFY_EMAIL / CMS_VERIFY_PASSWORD (env only, never
// in the repo) using the public anon key, then prints a SQL check for the
// Supabase SQL editor. The check sets the session's claims exactly as PostgREST
// does, compares both functions, and rolls back. It needs no exposed schema
// and no postgres password in any script.
import postgres from 'postgres';
import { assertLocal, LOCAL_SUPERUSER_URL } from './local-bootstrap.ts';
import { envApi, localApi, rest, signIn, signInOrUp, type Session } from './lib/supabase-session.ts';

export const LOCAL_ADMIN = { email: 'admin@cms.local.test', password: 'local-test-pw-1' };

export function uidCheckSql(claims: Record<string, unknown>): string {
  const literal = JSON.stringify(claims).replace(/'/g, "''");
  return [
    'begin;',
    'set local role authenticated;',
    `select set_config('request.jwt.claims', '${literal}', true);`,
    'select cms.cms_current_uid() as cms_uid,',
    '       auth.uid()            as auth_uid,',
    '       auth.uid() is not null and cms.cms_current_uid() is not distinct from auth.uid() as matches,',
    '       cms.cms_is_admin(cms.cms_current_uid()) as is_admin;',
    'rollback;',
  ].join('\n');
}

/** Local: compare both functions in SQL under the session's claims. */
export async function compareLocally(session: Session) {
  assertLocal(LOCAL_SUPERUSER_URL);
  const sql = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
  try {
    let row: any;
    await sql.begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(session.claims)}, true)`;
      [row] = await tx`select cms.cms_current_uid() as cms_uid, auth.uid() as auth_uid`;
      throw new RollBack();
    }).catch((e) => { if (!(e instanceof RollBack)) throw e; });
    return row as { cms_uid: string | null; auth_uid: string | null };
  } finally {
    await sql.end();
  }
}
class RollBack extends Error {}

if (import.meta.filename === process.argv[1]) {
  const mode = process.argv[2];
  if (mode === 'local') {
    const api = localApi();
    const session = await signInOrUp(api, LOCAL_ADMIN.email, LOCAL_ADMIN.password);
    const sqlRow = await compareLocally(session);
    const rpc = await rest(api, session, 'rpc/cms_current_uid', { method: 'POST', body: {} });
    const ok = sqlRow.cms_uid === session.userId && sqlRow.auth_uid === session.userId && rpc.json === session.userId;
    console.log({ user: session.userId, sql_cms_uid: sqlRow.cms_uid, sql_auth_uid: sqlRow.auth_uid, rest_cms_uid: rpc.json });
    console.log(ok ? 'verify:uid local: MATCH' : 'verify:uid local: MISMATCH');
    process.exit(ok ? 0 : 1);
  } else if (mode === 'hosted') {
    const email = process.env.CMS_VERIFY_EMAIL;
    const password = process.env.CMS_VERIFY_PASSWORD;
    if (!email || !password) throw new Error('Set CMS_VERIFY_EMAIL and CMS_VERIFY_PASSWORD in your shell (not in the repo).');
    const session = await signIn(envApi(), email, password);
    console.log(`Signed in as ${session.userId}.`);
    const expected = process.env.CMS_ADMIN_USER_ID?.trim();
    if (expected) {
      console.log(session.userId === expected
        ? 'Session user ID = CMS_ADMIN_USER_ID: the stored admin ID is your account.'
        : `MISMATCH: your session user is ${session.userId}, but CMS_ADMIN_USER_ID is ${expected}. Do not expose cms; re-run set-admin with the right ID.`);
    }
    console.log('Paste this into the Supabase SQL editor and run it. "matches" and "is_admin" must both be true.');
    console.log('It contains your session claims: do not save or share it.\n');
    console.log(uidCheckSql(session.claims));
  } else {
    console.error('usage: npm run verify:uid -- local | hosted');
    process.exit(1);
  }
}

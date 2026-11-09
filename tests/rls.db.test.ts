// RLS tests against THIS repo's local Supabase (npm run test:db).
// Decisions 3 and 4, option A (docs/phase2-plan.md):
//   anon gets nothing · an app user gets zero rows · the admin sees rows ·
//   missing or malformed claims mean deny · cms_current_uid() = auth.uid().
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertLocal, LOCAL_SUPERUSER_URL } from '../scripts/local-bootstrap.ts';
import { connect } from '../scripts/lib/db.ts';
import { localApi, rest, signInOrUp, type Api, type Session } from '../scripts/lib/supabase-session.ts';
import { compareLocally, LOCAL_ADMIN } from '../scripts/verify-uid.ts';

const APP_USER = { email: 'app-user@cms.local.test', password: 'local-test-pw-2' };

assertLocal(LOCAL_SUPERUSER_URL);
const su = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} }); // role switching (tests only)
const owner = connect(process.env.CMS_DATABASE_URL ?? 'postgres://cms_owner:cms_owner_local@127.0.0.1:55422/postgres');

let api: Api;
let admin: Session;
let app: Session;
let tables: string[];

class RollBack extends Error {}

/** Run fn as `authenticated` (or anon) with the given claim settings, then roll back. */
async function as<T>(
  opts: { role?: 'authenticated' | 'anon'; claims?: string | null; legacySub?: string | null },
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  let out!: T;
  await su.begin(async (tx) => {
    await tx.unsafe(`set local role ${opts.role ?? 'authenticated'}`);
    if (opts.claims != null) await tx`select set_config('request.jwt.claims', ${opts.claims}, true)`;
    if (opts.legacySub != null) await tx`select set_config('request.jwt.claim.sub', ${opts.legacySub}, true)`;
    out = await fn(tx);
    throw new RollBack();
  }).catch((e) => { if (!(e instanceof RollBack)) throw e; });
  return out;
}
const claimsFor = (uid: string) => JSON.stringify({ sub: uid, role: 'authenticated' });

beforeAll(async () => {
  api = localApi();
  admin = await signInOrUp(api, LOCAL_ADMIN.email, LOCAL_ADMIN.password);
  app = await signInOrUp(api, APP_USER.email, APP_USER.password);

  // Fixtures, written as cms_owner (the importers' role).
  await owner`
    insert into cms.cms_config (key, value) values ('admin_user_id', ${owner.json(admin.userId)})
    on conflict (key) do update set value = excluded.value`;
  await owner`insert into cms.cms_strands (strand_id, subject, code, name, sort) values ('math-ZZ', 'math', 'ZZ', 'RLS test strand', 999) on conflict do nothing`;
  await owner`insert into cms.cms_chapters (chapter_id, subject, strand_id, name, sort) values ('MC99', 'math', 'math-ZZ', 'RLS test chapter', 999) on conflict do nothing`;
  await owner`insert into cms.cms_topics (topic_id, chapter_id, class, name) values ('MT9999', 'MC99', 1, 'RLS test topic') on conflict do nothing`;

  tables = (await su<{ t: string }[]>`select tablename as t from pg_tables where schemaname = 'cms' order by 1`).map((r) => r.t);
  await su`notify pgrst, 'reload schema'`;
});

afterAll(async () => {
  await owner`delete from cms.cms_topics where topic_id = 'MT9999'`;
  await owner`delete from cms.cms_chapters where chapter_id = 'MC99'`;
  await owner`delete from cms.cms_strands where strand_id = 'math-ZZ'`;
  await Promise.all([su.end(), owner.end()]);
});

describe('catalog: every table is locked the same way', () => {
  it('has 38 tables, all with RLS enabled', async () => {
    expect(tables).toHaveLength(38);
    const off = await su`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                         where n.nspname = 'cms' and c.relkind = 'r' and not c.relrowsecurity`;
    expect(off).toEqual([]);
  });

  it('every table but the migration history has exactly the admin policy, for authenticated only', async () => {
    const pols = await su<{ tablename: string; roles: string[]; qual: string; with_check: string }[]>`
      select tablename, roles, qual, with_check from pg_policies where schemaname = 'cms'`;
    const expected = 'cms.cms_is_admin(( SELECT cms.cms_current_uid() AS cms_current_uid))';
    expect(pols.map((p) => p.tablename).sort()).toEqual(tables.filter((t) => t !== 'cms_schema_migrations'));
    for (const p of pols) {
      expect(p.roles, p.tablename).toEqual(['authenticated']);
      expect(p.qual, p.tablename).toBe(expected);
      expect(p.with_check, p.tablename).toBe(expected);
    }
  });

  it('authenticated has SELECT only; anon and public have nothing', async () => {
    const grants = await su<{ grantee: string; privilege_type: string; table_name: string }[]>`
      select grantee, privilege_type, table_name from information_schema.role_table_grants
      where table_schema = 'cms' and grantee <> 'cms_owner' and grantee <> 'postgres'`;
    expect(grants.filter((g) => g.grantee !== 'authenticated')).toEqual([]);
    expect([...new Set(grants.map((g) => g.privilege_type))]).toEqual(['SELECT']);
    expect(grants.map((g) => g.table_name).sort()).toEqual(tables.filter((t) => t !== 'cms_schema_migrations'));
    const [s] = await su`select has_schema_privilege('anon', 'cms', 'usage') as anon_usage,
                                has_schema_privilege('authenticated', 'cms', 'usage') as auth_usage`;
    expect(s).toEqual({ anon_usage: false, auth_usage: true });
  });

  it('functions: cms_current_uid invoker, cms_is_admin definer; both stable, empty search_path, authenticated only', async () => {
    const fns = await su`
      select p.proname, p.prosecdef, p.provolatile, p.proconfig,
             has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
             has_function_privilege('anon', p.oid, 'execute')          as anon_exec,
             p.proacl::text ~ '(^|,|\\{)=X' as public_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'cms' order by p.proname`;
    expect(fns).toEqual([
      { proname: 'cms_current_uid', prosecdef: false, provolatile: 's', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_is_admin', prosecdef: true, provolatile: 's', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
    ]);
  });
});

describe('cms_current_uid() equals auth.uid()', () => {
  it('for a real signed-in session (local; run `npm run verify:uid -- hosted` on the real project)', async () => {
    const r = await compareLocally(admin);
    expect(r).toEqual({ cms_uid: admin.userId, auth_uid: admin.userId });
  });

  it.each([
    ['claims JSON', { claims: claimsFor('11111111-2222-4333-8444-555555555555') }],
    ['legacy claim.sub', { legacySub: '11111111-2222-4333-8444-555555555555' }],
    ['legacy wins over claims, like auth.uid()', { legacySub: '11111111-2222-4333-8444-555555555555', claims: claimsFor('99999999-2222-4333-8444-555555555555') }],
    ['no claims at all (both null)', {}],
    ['empty claims (both null)', { claims: '' }],
    ['claims without sub (both null)', { claims: '{"role":"authenticated"}' }],
  ])('%s', async (_n, opts) => {
    const r = await as(opts, (tx) => tx`select cms.cms_current_uid() is not distinct from auth.uid() as same`);
    expect(r[0]!.same).toBe(true);
  });
});

describe('missing or malformed claim means deny', () => {
  it.each([
    ['no claims', {}],
    ['empty string', { claims: '' }],
    ['not JSON', { claims: '{not json' }],
    ['sub not a uuid', { claims: '{"sub":"not-a-uuid"}' }],
    ['sub empty', { claims: '{"sub":""}' }],
    ['sub is a number', { claims: '{"sub":42}' }],
    ['JSON array', { claims: '[1,2]' }],
    ['JSON string', { claims: '"x"' }],
    ['legacy sub malformed', { legacySub: 'nope' }],
  ])('%s → null uid, not admin, zero rows, no error', async (_n, opts) => {
    const r = await as(opts, async (tx) => {
      const [u] = await tx`select cms.cms_current_uid() as uid, cms.cms_is_admin(cms.cms_current_uid()) as is_admin`;
      const [c] = await tx`select (select count(*) from cms.cms_strands)::int as strands, (select count(*) from cms.cms_config)::int as config`;
      return { ...u, ...c };
    });
    expect(r).toEqual({ uid: null, is_admin: false, strands: 0, config: 0 });
  });
});

describe('anon gets nothing', () => {
  it('SQL: no access to schema cms at all', async () => {
    await expect(as({ role: 'anon' }, (tx) => tx`select count(*) from cms.cms_strands`)).rejects.toThrow(/permission denied for schema cms/);
    await expect(as({ role: 'anon' }, (tx) => tx`select cms.cms_current_uid()`)).rejects.toThrow(/permission denied for schema cms/);
  });

  it('REST with the anon key: refused', async () => {
    const r = await rest(api, null, 'cms_strands?select=strand_id');
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.json?.code).toBe('42501');
  });
});

describe('an app user gets zero rows', () => {
  it('SQL: zero rows in every cms table', async () => {
    const counts = await as({ claims: claimsFor(app.userId) }, async (tx) => {
      const out: Record<string, number> = {};
      for (const t of tables.filter((x) => x !== 'cms_schema_migrations')) {
        const [r] = await tx.unsafe(`select count(*)::int as n from cms.${t}`);
        out[t] = r!.n;
      }
      return out;
    });
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    expect(Object.keys(counts)).toHaveLength(37);
  });

  it('SQL: not admin, and cannot write', async () => {
    const [r] = await as({ claims: claimsFor(app.userId) }, (tx) => tx`select cms.cms_is_admin(cms.cms_current_uid()) as a`);
    expect(r!.a).toBe(false);
    await expect(as({ claims: claimsFor(app.userId) }, (tx) =>
      tx`insert into cms.cms_strands (strand_id, subject, code, name, sort) values ('math-YY', 'math', 'YY', 'x', 1)`)).rejects.toThrow(/permission denied/);
  });

  it('REST with a real app-user session: empty results, including cms_config', async () => {
    for (const path of ['cms_strands?select=strand_id', 'cms_topics?select=topic_id', 'cms_config?select=key']) {
      const r = await rest(api, app, path);
      expect(r.status, path).toBe(200);
      expect(r.json, path).toEqual([]);
    }
  });
});

describe('the admin sees rows', () => {
  it('SQL: fixtures visible', async () => {
    const [r] = await as({ claims: claimsFor(admin.userId) }, (tx) => tx`
      select (select count(*) from cms.cms_strands where strand_id = 'math-ZZ')::int as strand,
             (select count(*) from cms.cms_topics  where topic_id  = 'MT9999')::int  as topic,
             (select count(*) from cms.cms_config  where key = 'admin_user_id')::int as config`);
    expect(r).toEqual({ strand: 1, topic: 1, config: 1 });
  });

  it('REST with the real admin session: rows returned', async () => {
    const r = await rest(api, admin, 'cms_topics?select=topic_id,chapter_id&topic_id=eq.MT9999');
    expect(r.status).toBe(200);
    expect(r.json).toEqual([{ topic_id: 'MT9999', chapter_id: 'MC99' }]);
  });

  it('REST: a tampered token is rejected', async () => {
    const forged = { ...admin, accessToken: admin.accessToken.slice(0, -4) + 'AAAA' };
    const r = await rest(api, forged, 'cms_strands?select=strand_id');
    expect(r.status).toBe(401);
  });
});

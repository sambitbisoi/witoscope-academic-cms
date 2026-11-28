// RLS tests against THIS repo's local Supabase (npm run test:db).
// Decisions 3 and 4, option A (docs/phase2-plan.md):
//   anon gets nothing · an app user gets zero rows · the admin sees rows ·
//   missing or malformed claims mean deny · cms_current_uid() = auth.uid().
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertLocal, LOCAL_CMS_OWNER_URL, LOCAL_SUPERUSER_URL } from '../scripts/local-bootstrap.ts';
import { connect } from '../scripts/lib/db.ts';
import { unexpectedGrants, WRITE_GRANTS } from '../scripts/lib/grants.ts';
import { localApi, rest, signInOrUp, type Api, type Session } from '../scripts/lib/supabase-session.ts';
import { compareLocally, LOCAL_ADMIN } from '../scripts/verify-uid.ts';

const APP_USER = { email: 'app-user@cms.local.test', password: 'local-test-pw-2' };

assertLocal(LOCAL_SUPERUSER_URL);
const su = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} }); // role switching (tests only)
const owner = connect(LOCAL_CMS_OWNER_URL);

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
  await owner`delete from cms.cms_reviews where target_id like 'ACH-%' and split_part(target_id, '-', 2) = any(${['MC99']})`;
  await owner`delete from cms.cms_topics where topic_kind = 'achievers' and chapter_id = any(${['MC99']})`; // 0034: Achievers rows the trigger made
  await owner`delete from cms.cms_chapters where chapter_id = 'MC99'`;
  await owner`delete from cms.cms_strands where strand_id = 'math-ZZ'`;
  await Promise.all([su.end(), owner.end()]);
});

describe('catalog: every table is locked the same way', () => {
  it('has 44 tables, all with RLS enabled', async () => {
    expect(tables).toHaveLength(66); // 0051 cms_work_lease; 0018 added cms_catalogue_proposals; 0032 the four Science tables; 0035 cms_row_misconceptions; 0038 cms_held_out; 0045 the 7 course tables; 0047 cms_generation_items; 0049 cms_version_images, cms_image_runs, cms_image_run_items
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

  it('authenticated: SELECT plus only the listed writes; anon and public have nothing', async () => {
    const grants = await su<{ grantee: string; privilege_type: string; table_name: string }[]>`
      select grantee, privilege_type, table_name from information_schema.role_table_grants
      where table_schema = 'cms' and grantee <> 'cms_owner' and grantee <> 'postgres'`;
    // 0051 (Q38 PR 2): cms_reader has SELECT on every cms table (migration history included) and nothing else;
    // cms_gen_writer has no table rights at all
    const reader = grants.filter((g) => g.grantee === 'cms_reader');
    expect(reader.filter((g) => g.privilege_type !== 'SELECT')).toEqual([]);
    expect(reader.map((g) => g.table_name).sort()).toEqual([...tables, ...(await su<{ v: string }[]>`select viewname as v from pg_views where schemaname = 'cms'`).map((r) => r.v)].sort());
    expect(grants.filter((g) => g.grantee !== 'authenticated' && g.grantee !== 'cms_reader')).toEqual([]);
    expect(unexpectedGrants(grants.filter((g) => g.grantee === 'authenticated'))).toEqual([]);
    expect(grants.some((g) => g.privilege_type === 'DELETE' || g.privilege_type === 'TRUNCATE')).toBe(false);
    expect(grants.filter((g) => g.grantee === 'authenticated' && g.privilege_type !== 'SELECT').map((g) => `${g.privilege_type} ${g.table_name}`).sort()).toEqual(
      Object.entries(WRITE_GRANTS).flatMap(([t, ps]) => ps.map((p) => `${p} ${t}`)).sort());
    const views = (await su<{ v: string }[]>`select viewname as v from pg_views where schemaname = 'cms'`).map((r) => r.v);
    expect([...new Set(grants.filter((g) => g.grantee === 'authenticated').map((g) => g.table_name))].sort()).toEqual([...tables.filter((t) => t !== 'cms_schema_migrations'), ...views].sort());
    const [s] = await su`select has_schema_privilege('anon', 'cms', 'usage') as anon_usage,
                                has_schema_privilege('authenticated', 'cms', 'usage') as auth_usage`;
    expect(s).toEqual({ anon_usage: false, auth_usage: true });
  });

  it('functions: empty search_path, authenticated only; the write path is the three admin-checked definer functions', async () => {
    const fns = await su`
      select p.proname, p.prosecdef, p.provolatile, p.proconfig,
             has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
             has_function_privilege('anon', p.oid, 'execute')          as anon_exec,
             p.proacl::text ~ '(^|,|\\{)=X' as public_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'cms' order by p.proname`;
    expect(fns).toEqual([
      { proname: 'cms_add_questions', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_apply_save', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      // 0048 (Q38 PR 4): bulk approve (OL-044) and a proposed primary decided in place
      { proname: 'cms_approve_questions', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      // 0050 (Q38 PR 1b): the same with p_by_label (the 2-argument form now calls it)
      { proname: 'cms_approve_questions', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_check_image', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      // 0035: rank default for links written without one (trigger)
      { proname: 'cms_content_link_rank', prosecdef: false, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      // 0044 (Q23): linked content rows edited on a Science draft
      { proname: 'cms_content_links_state', prosecdef: false, provolatile: 's', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      // 0045 (Q13): course builder
      { proname: 'cms_copy_course', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_course_achievers_state', prosecdef: false, provolatile: 's', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      { proname: 'cms_course_errors', prosecdef: false, provolatile: 's', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_course_items_state', prosecdef: false, provolatile: 's', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      { proname: 'cms_current_uid', prosecdef: false, provolatile: 's', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_decide_override', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      // 0039 (Q19): several overrides in one transaction
      { proname: 'cms_decide_overrides', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_decide_primary', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_decide_topic_class', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      // 0034 Achievers rule: invoker helpers, not callable by the app user
      // 0038 (Q21): the Held-out area
      { proname: 'cms_discard_held_out', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_ensure_achievers', prosecdef: false, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      // 0035 helpers of the Science review (invoker, not callable by the app user)
      // 0047 (Q38): generation pack import (admin, or a Mac import session: cms_owner / cms_gen_writer); caller + writer are helpers
      { proname: 'cms_gen_caller', prosecdef: false, provolatile: 's', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      { proname: 'cms_gen_close_run', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      // 0051 (Q38 PR 2): generation settings and the work lease
      { proname: 'cms_gen_config', prosecdef: true, provolatile: 's', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_gen_import_batch', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_gen_open_run', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_gen_place_held', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_gen_rollback', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_gen_set_briefs', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_gen_write_item', prosecdef: false, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      { proname: 'cms_heartbeat_lease', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_image_audit', prosecdef: false, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      { proname: 'cms_image_brief_problem', prosecdef: false, provolatile: 'i', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      { proname: 'cms_image_brief_text', prosecdef: false, provolatile: 'i', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      { proname: 'cms_image_open_version', prosecdef: false, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      { proname: 'cms_image_run_claim', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_image_run_close', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_image_run_item', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_image_run_open', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_is_admin', prosecdef: true, provolatile: 's', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_lease_json', prosecdef: false, provolatile: 's', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      { proname: 'cms_lease_state', prosecdef: true, provolatile: 's', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_linked_item', prosecdef: false, provolatile: 's', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      { proname: 'cms_place_held_out', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_record_run', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_release_lease', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_retire', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      // 0037 (Q14): content rows and their items edited in the CMS
      { proname: 'cms_save_content_links', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_save_content_row', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_save_course', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_save_course_board', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_save_curriculum', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_save_job', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_save_order', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_save_science_review', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_science_review_state', prosecdef: false, provolatile: 's', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      { proname: 'cms_set_catalogue_status', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_set_course_status', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_set_image', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_set_image_brief', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_set_row_misconception_status', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_set_status', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      // 0050 (Q38 PR 1b): the same with p_by_label (the 5-argument form now calls it)
      { proname: 'cms_set_status', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_set_topic_review', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_take_lease', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      // trigger functions (not callable by anyone)
      { proname: 'cms_topic_achievers', prosecdef: false, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      { proname: 'cms_topic_class_achievers', prosecdef: false, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      { proname: 'cms_undo_image', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: true, anon_exec: false, public_exec: false },
      { proname: 'cms_version_flags', prosecdef: false, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      { proname: 'cms_version_image_check', prosecdef: false, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
      { proname: 'cms_version_keep_brief', prosecdef: false, provolatile: 'v', proconfig: ['search_path=""'], auth_exec: false, anon_exec: false, public_exec: false },
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
    expect(Object.keys(counts)).toHaveLength(65); // + cms_work_lease (0051) + the four Science tables (0032) + cms_row_misconceptions (0035) + cms_held_out (0038) + 7 course tables (0045) + cms_generation_items (0047) + 3 image tables (0049)
  });

  it('SQL: zero rows from every cms view (views are security_invoker)', async () => {
    const views = (await su<{ v: string }[]>`select viewname as v from pg_views where schemaname = 'cms' order by 1`).map((r) => r.v);
    expect(views.length).toBeGreaterThan(0);
    const counts = await as({ claims: claimsFor(app.userId) }, async (tx) => {
      const out: Record<string, number> = {};
      for (const v of views) out[v] = (await tx.unsafe(`select count(*)::int as n from cms.${v}`))[0]!.n;
      return out;
    });
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    const adminTopicStats = await as({ claims: claimsFor(admin.userId) }, (tx) => tx`select count(*)::int as n from cms.cms_topic_stats where topic_id = 'MT9999'`);
    expect(adminTopicStats[0]!.n).toBe(1);
  });

  it('SQL: not admin, and cannot write', async () => {
    const [r] = await as({ claims: claimsFor(app.userId) }, (tx) => tx`select cms.cms_is_admin(cms.cms_current_uid()) as a`);
    expect(r!.a).toBe(false);
    await expect(as({ claims: claimsFor(app.userId) }, (tx) =>
      tx`insert into cms.cms_strands (strand_id, subject, code, name, sort) values ('math-YY', 'math', 'YY', 'x', 1)`)).rejects.toThrow(/permission denied/);
  });

  it('REST with a real app-user session: empty results, including cms_config', async () => {
    for (const path of ['cms_strands?select=strand_id', 'cms_topics?select=topic_id', 'cms_config?select=key', 'cms_home_stats?select=subject', 'cms_question_list?select=question_id']) {
      const r = await rest(api, app, path);
      expect(r.status, path).toBe(200);
      expect(r.json, path).toEqual([]);
    }
  });
});

describe('Phase 4 writes (D2): the grant alone is not enough, RLS decides', () => {
  const row = { source_id: 'TEST-RLS-1', kind: 'web', title: 'RLS probe', publisher: 'other', url: 'https://example.invalid' };
  it('an app user cannot insert a source (RLS with check)', async () => {
    await expect(as({ claims: claimsFor(app.userId) }, (tx) => tx`insert into cms.cms_sources ${tx(row)}`)).rejects.toThrow(/row-level security/);
  });
  it('an app user cannot write the audit log', async () => {
    await expect(as({ claims: claimsFor(app.userId) }, (tx) =>
      tx`insert into cms.cms_reviews (target, target_table, target_id, action, by_label) values ('catalogue', 'cms_sources', 'x', 'edit_catalogue', 'x')`)).rejects.toThrow(/row-level security/);
  });
  it('the admin can insert (rolled back) but never delete', async () => {
    const [r] = await as({ claims: claimsFor(admin.userId) }, async (tx) => {
      await tx`insert into cms.cms_sources ${tx(row)}`;
      return tx`select count(*)::int as n from cms.cms_sources where source_id = 'TEST-RLS-1'`;
    });
    expect(r!.n).toBe(1);
    await expect(as({ claims: claimsFor(admin.userId) }, (tx) => tx`delete from cms.cms_sources where source_id = 'TEST-RLS-1'`)).rejects.toThrow(/permission denied/);
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

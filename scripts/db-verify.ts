// npm run db:verify — run against the real project BEFORE exposing schema cms
// (docs/phase2-plan.md §3, step 3). Read-only; connects as cms_owner.
// Every check must pass; any failure exits non-zero and says what is wrong.
import { assertCmsOwner, connect } from './lib/db.ts';
import { unexpectedGrants } from './lib/grants.ts';

const sql = connect();
const results: { check: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => results.push({ check: name, ok, detail });
const EXPECTED_POLICY = 'cms.cms_is_admin(( SELECT cms.cms_current_uid() AS cms_current_uid))';

try {
  await assertCmsOwner(sql);

  const tables = (await sql`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                            where n.nspname = 'cms' and c.relkind = 'r' order by 1`) as unknown as { relname: string; relrowsecurity: boolean }[];
  check('every cms table has RLS enabled', tables.every((t) => t.relrowsecurity), tables.filter((t) => !t.relrowsecurity).map((t) => t.relname).join(', '));
  check('no table outside the cms_ naming rule', tables.every((t) => t.relname.startsWith('cms_')), tables.filter((t) => !t.relname.startsWith('cms_')).map((t) => t.relname).join(', '));

  const views = await sql`select c.relname, coalesce(c.reloptions, '{}') as opts from pg_class c join pg_namespace n on n.oid = c.relnamespace
                          where n.nspname = 'cms' and c.relkind in ('v', 'm')`;
  const unsafeViews = views.filter((v) => !(v.opts as string[]).includes('security_invoker=true'));
  check('every cms view is security_invoker (RLS applies through it)', unsafeViews.length === 0, unsafeViews.map((v) => v.relname).join(', '));

  const policies = await sql`select tablename, roles::text[] as roles, qual, with_check from pg_policies where schemaname = 'cms'`;
  const want = tables.map((t) => t.relname).filter((t) => t !== 'cms_schema_migrations');
  const bad = want.filter((t) => {
    const p = policies.filter((x) => x.tablename === t);
    return p.length !== 1 || p[0]!.qual !== EXPECTED_POLICY || p[0]!.with_check !== EXPECTED_POLICY || p[0]!.roles.join() !== 'authenticated';
  });
  check('every table (but migration history) has exactly the admin policy, for authenticated', bad.length === 0, bad.join(', '));
  check('migration history has no policy (owner only)', !policies.some((p) => p.tablename === 'cms_schema_migrations'));

  const grants = await sql`select grantee, privilege_type, table_name from information_schema.role_table_grants
                           where table_schema = 'cms' and grantee not in ('cms_owner', 'postgres')`;
  const others = grants.filter((g) => g.grantee !== 'authenticated');
  check('table grants: nobody but authenticated', others.length === 0, others.map((g) => `${g.grantee} ${g.privilege_type} ${g.table_name}`).join(', '));
  const extra = unexpectedGrants(grants.filter((g) => g.grantee === 'authenticated') as never);
  check('authenticated: SELECT, plus only the listed writes (no DELETE anywhere)', extra.length === 0, extra.join(', '));

  const [s] = await sql`select has_schema_privilege('anon', 'cms', 'usage') as anon_usage,
                               has_schema_privilege('authenticated', 'cms', 'usage') as auth_usage,
                               has_schema_privilege('service_role', 'cms', 'usage') as service_usage,
                               has_schema_privilege('cms_owner', 'auth', 'usage') as owner_auth,
                               has_schema_privilege('cms_owner', 'public', 'create') as owner_public_create`;
  check('anon has no USAGE on cms', s!.anon_usage === false);
  check('authenticated has USAGE on cms', s!.auth_usage === true);
  check('service_role has no USAGE on cms', s!.service_usage === false);
  check('cms_owner has no USAGE on auth', s!.owner_auth === false);
  check('cms_owner cannot create in public', s!.owner_public_create === false);

  const fns = await sql`select p.proname, p.prosecdef, p.provolatile, p.proconfig,
                               has_function_privilege('anon', p.oid, 'execute') as anon_exec,
                               has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
                        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'cms'`;
  const fn = (name: string) => fns.find((f) => f.proname === name);
  const uid = fn('cms_current_uid');
  const adm = fn('cms_is_admin');
  check('cms_current_uid: security invoker, stable, empty search_path, authenticated only',
    !!uid && !uid.prosecdef && uid.provolatile === 's' && uid.proconfig?.[0] === 'search_path=""' && uid.auth_exec && !uid.anon_exec);
  check('cms_is_admin: security definer, stable, empty search_path, authenticated only',
    !!adm && adm.prosecdef && adm.provolatile === 's' && adm.proconfig?.[0] === 'search_path=""' && adm.auth_exec && !adm.anon_exec);

  const DEFINER_ALLOWED = ['cms_is_admin', 'cms_apply_save', 'cms_set_status', 'cms_retire', 'cms_record_run', 'cms_save_job', 'cms_set_catalogue_status', 'cms_save_curriculum', 'cms_decide_override', 'cms_set_topic_review', 'cms_add_questions'];
  const badFns = fns.filter((f) => f.proconfig?.[0] !== 'search_path=""' || f.anon_exec || (f.prosecdef && !DEFINER_ALLOWED.includes(f.proname)));
  check('every cms function: empty search_path, no anon access; only the listed functions run as owner', badFns.length === 0, badFns.map((f) => f.proname).join(', '));

  // Book material stays on the Mac (Sambit, 10 Nov 2026): the cloud holds citations only.
  const cols = await sql`select table_name, column_name from information_schema.columns where table_schema = 'cms'
                         and table_name in ('cms_source_items', 'cms_sources')`;
  const itemCols = cols.filter((c) => c.table_name === 'cms_source_items').map((c) => c.column_name as string).sort();
  const CITATION = ['item_label', 'page', 'pattern_id', 'ref_id', 'section', 'source_id', 'topic_id'];
  check('book items are citations only (no item text or numbers)', itemCols.join() === CITATION.join(), itemCols.join(', '));
  check('sources hold no file key (book files stay on the Mac)', !cols.some((c) => c.table_name === 'cms_sources' && c.column_name === 'storage_path'));
  check('no screenshot table', !tables.some((t) => t.relname === 'cms_source_assets'));
  const [badUrl] = await sql`select count(*)::int as n from cms.cms_sources where publisher = 'NCERT' and url !~ '^https://ncert\\.nic\\.in/'`;
  check('NCERT sources link only to ncert.nic.in', badUrl!.n === 0, `${badUrl!.n} other links`);

  const [mapCols] = await sql`select count(*)::int as n from cms.cms_source_map m, jsonb_array_elements(m.cells) c where c ->> 0 ~* '(evidence|^notes?\y|source scan)'`;
  check('source-mapping rows hold no evidence, notes or scan paths (book text stays on the Mac)', mapCols!.n === 0, `${mapCols!.n} such cells`);

  const [admin] = await sql`select value #>> '{}' as id from cms.cms_config where key = 'admin_user_id'`;
  check('cms_config.admin_user_id is set to a UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(admin?.id ?? ''), admin?.id ?? 'not set');

  const cfg = await sql`select key from cms.cms_config where key in ('multistep_bands', 'difficulty_points', 'load_thresholds')`;
  check('derived-field config loaded (import:seed)', cfg.length === 3, `${cfg.length}/3 keys`);
  const [counts] = await sql`select (select count(*) from cms.cms_topics)::int as topics, (select count(*) from cms.cms_questions where bank = 'gold')::int as gold`;
  check('topic lists imported', counts!.topics > 0, `${counts!.topics} topics`);
  check('gold set seeded', counts!.gold > 0, `${counts!.gold} gold questions`);
} finally {
  await sql.end();
}

for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.check}${r.detail ? `  (${r.detail})` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\ndb:verify: ${failed} check(s) FAILED — do not expose schema cms.` : '\ndb:verify: all checks passed.');
process.exit(failed ? 1 : 0);

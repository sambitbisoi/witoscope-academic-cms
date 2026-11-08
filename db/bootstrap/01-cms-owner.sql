-- WitoScope Academic CMS — one-time bootstrap. NOT a migration.
--
-- Run once, as `postgres`, in the Supabase SQL editor (real project) or via
-- scripts on the local dev database. Everything else is done by migrations
-- running as cms_owner.
--
-- Before running: replace CHANGE_ME with a strong password. Do not save the
-- edited file; keep the password in your password manager and in a local,
-- git-ignored .env only.
--
-- This is the only place that touches anything outside schema cms, and it does
-- exactly these things (decision 1, docs/phase2-plan.md):
--   1. creates role cms_owner (no rights outside cms)
--   2. creates schema cms, owned by cms_owner
--   3. grants cms_owner USAGE on schema auth and EXECUTE on auth.uid()
--   4. grants authenticated USAGE on cms (anon gets nothing)

begin;

-- 1. Dedicated role. NOINHERIT and no special attributes.
create role cms_owner
  login
  noinherit
  nosuperuser nocreatedb nocreaterole noreplication nobypassrls
  password 'CHANGE_ME';

-- 2. The CMS namespace, owned by cms_owner.
create schema cms authorization cms_owner;
revoke all on schema cms from public;

-- 3. Explicit, minimal access to auth: only auth.uid().
grant usage on schema auth to cms_owner;
grant execute on function auth.uid() to cms_owner;

-- 4. Logged-in users can see the namespace; RLS decides row access.
--    anon gets no USAGE on cms.
grant usage on schema cms to authenticated;
revoke all on schema cms from anon;

commit;

-- Verification: every column must be true. Paste the result into the PR
-- checklist.
select
  exists (select 1 from pg_roles where rolname = 'cms_owner')                         as role_exists,
  (select not rolsuper and not rolbypassrls and not rolcreaterole and not rolcreatedb
     from pg_roles where rolname = 'cms_owner')                                          as role_unprivileged,
  (select nspowner::regrole::text = 'cms_owner' from pg_namespace where nspname = 'cms') as cms_owned_by_cms_owner,
  has_schema_privilege('cms_owner', 'auth', 'usage')                                    as owner_auth_usage,
  has_function_privilege('cms_owner', 'auth.uid()', 'execute')                          as owner_uid_execute,
  has_schema_privilege('authenticated', 'cms', 'usage')                                 as authenticated_cms_usage,
  not has_schema_privilege('anon', 'cms', 'usage')                                      as anon_no_cms_usage;

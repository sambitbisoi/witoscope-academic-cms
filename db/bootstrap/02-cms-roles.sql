-- WitoScope Academic CMS — Q38 PR 2 bootstrap: two more login roles. NOT a migration (migrations can't create roles, R3).
--
-- Run once, as `postgres`, in the Supabase SQL editor (real project), BEFORE migration 0051; locally
-- `npm run db:local:bootstrap` runs it. Replace both CHANGE_ME passwords with new strong ones first. Do not save the
-- edited file; keep the passwords in your password manager and in the git-ignored `.env.real.reader` /
-- `.env.real.genwriter` only (plan docs/plan-2026-11-23-q38-direct-generation.md §8).
--
--   cms_reader      read-only. Migration 0051 grants it USAGE on cms and SELECT on cms tables and sequences, nothing else.
--                   BYPASSRLS so it sees the rows (every cms table's RLS policy admits only the admin's browser session;
--                   cms_owner sees rows as the owner). Sessions are read-only by default and time out after 60 s.
--                   Used by keys:audit, reports and the engine snapshot.
--   cms_gen_writer  the Route B write path. No table rights at all; 0051 grants EXECUTE on the generation import
--                   functions and the work lease only. NOBYPASSRLS.
-- Neither gets anything outside schema cms. On Supabase, postgres has CREATEROLE and BYPASSRLS (checked 28 Nov 2026),
-- which Postgres 17 needs to create a BYPASSRLS role.

begin;

create role cms_reader
  login noinherit
  nosuperuser nocreatedb nocreaterole noreplication bypassrls
  connection limit 5
  password 'CHANGE_ME';
alter role cms_reader set default_transaction_read_only = on;
alter role cms_reader set statement_timeout = '60s';

create role cms_gen_writer
  login noinherit
  nosuperuser nocreatedb nocreaterole noreplication nobypassrls
  connection limit 5
  password 'CHANGE_ME';

commit;

-- Verification: every column must be true (before 0051; after 0051, run `npm run db:verify`).
select
  (select count(*) = 2 from pg_roles where rolname in ('cms_reader', 'cms_gen_writer'))                       as roles_exist,
  (select not rolsuper and not rolcreaterole and not rolcreatedb and rolbypassrls from pg_roles where rolname = 'cms_reader') as reader_attrs,
  (select not rolsuper and not rolcreaterole and not rolcreatedb and not rolbypassrls from pg_roles where rolname = 'cms_gen_writer') as genwriter_attrs,
  not has_schema_privilege('cms_reader', 'auth', 'usage')        as reader_no_auth,
  not has_schema_privilege('cms_gen_writer', 'auth', 'usage')    as genwriter_no_auth,
  not has_schema_privilege('cms_reader', 'public', 'create')     as reader_no_public_create,
  not has_schema_privilege('cms_gen_writer', 'public', 'create') as genwriter_no_public_create;

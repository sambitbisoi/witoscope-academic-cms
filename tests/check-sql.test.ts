import { describe, expect, it } from 'vitest';
import { checkSql } from '../scripts/lib/check-sql.ts';

const rules = (sql: string) => checkSql(sql, 'x.sql').map((p) => p.rule);

describe('check-migrations: allowed', () => {
  it('accepts a normal cms table, index, grant and RLS policy', () => {
    const sql = `
      create table cms.cms_topics (
        topic_id text primary key,
        chapter_id text not null references cms.cms_chapters (chapter_id) on delete restrict
      );
      create index cms_topics_chapter on cms.cms_topics (chapter_id);
      alter table cms.cms_topics enable row level security;
      grant select, insert, update on cms.cms_topics to authenticated;
      create policy admin_all on cms.cms_topics for all to authenticated
        using (cms.cms_is_admin()) with check (cms.cms_is_admin());
      alter default privileges in schema cms grant select on tables to authenticated;
    `;
    expect(rules(sql)).toEqual([]);
  });

  it('allows auth.uid() and an empty search_path in a cms function', () => {
    const sql = `
      create function cms.cms_is_admin() returns boolean
        language sql stable security definer set search_path = ''
        as $$ select exists (select 1 from cms.cms_config c
                             where c.key = 'admin_user_id' and c.value #>> '{}' = auth.uid()::text) $$;
      revoke execute on function cms.cms_is_admin() from public;
      grant execute on function cms.cms_is_admin() to authenticated;
    `;
    expect(rules(sql)).toEqual([]);
  });

  it('accepts a security_invoker view with joins on aliases', () => {
    const sql = `create view cms.cms_x with (security_invoker = true) as
      select q.question_id from cms.cms_questions q
      join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
      left join cms.cms_gold_meta g on g.question_id = q.question_id;
      grant select on cms.cms_x to authenticated;`;
    expect(rules(sql)).toEqual([]);
  });

  it('ignores schema names inside comments', () => {
    expect(rules(`-- never touch public.users\n/* or auth.users */\nselect 1;`)).toEqual([]);
  });
});

describe('check-migrations: rejected', () => {
  it.each([
    ['public table', 'create table public.cms_x (id int);', 'other-schema'],
    ['FK into app schema', 'create table cms.cms_x (u uuid references auth.users (id));', 'other-schema'],
    ['quoted schema', 'select * from "public"."profiles";', 'other-schema'],
    ['other auth function', 'select auth.jwt();', 'other-schema'],
    ['auth.uid without call', 'select auth.uid;', 'other-schema'],
    ['unqualified table', 'create table cms_x (id int);', 'unqualified-object'],
    ['missing cms_ prefix', 'create table cms.topics (id int);', 'table-prefix'],
    ['grant on public schema', 'grant usage on schema public to authenticated;', 'other-schema'],
    ['create schema', 'create schema cms;', 'bootstrap-only'],
    ['create role', 'create role x;', 'bootstrap-only'],
    ['grant to anon', 'grant select on cms.cms_x to anon;', 'grantee'],
    ['grant to service_role', 'grant select on cms.cms_x to service_role;', 'grantee'],
    ['extension outside cms', 'create extension vector;', 'extension'],
    ['search_path public', "create function cms.f() returns int language sql set search_path = public as $$ select 1 $$;", 'search-path'],
    ['dynamic SQL', "do $$ begin execute format('drop table %I', 'x'); end $$;", 'dynamic-sql'],
    ['policy on unqualified table', 'create policy p on profiles using (true);', 'unqualified-target'],
    ['view without security_invoker', 'create view cms.cms_v as select 1;', 'view-security'],
    ['materialized view', 'create materialized view cms.cms_v as select 1;', 'view-security'],
    ['join onto a public table', 'create view cms.cms_v with (security_invoker = true) as select 1 from cms.cms_a a join public.profiles p on p.id = a.id;', 'other-schema'],
    ['trigger on public table', 'create trigger t after insert on public.profiles for each row execute function cms.f();', 'other-schema'],
  ])('%s', (_name, sql, rule) => {
    expect(rules(sql)).toContain(rule);
  });

  it('reports the right line number', () => {
    const [p] = checkSql('select 1;\n\ncreate table public.x (id int);', 'x.sql');
    expect(p?.line).toBe(3);
  });
});

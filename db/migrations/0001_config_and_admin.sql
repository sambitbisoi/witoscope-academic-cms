-- Settings the rules depend on, and the single admin check used by every RLS policy.
-- Design §2F (cms_config); decision 4, option 1 (docs/phase2-plan.md).

create table cms.cms_config (
  key        text primary key,
  value      jsonb not null,
  note       text,
  updated_at timestamptz not null default now()
);

-- True only when uid is the admin user ID stored as cms_config.admin_user_id.
-- Policies call it as cms.cms_is_admin((select auth.uid())): auth.uid() runs as
-- the caller (authenticated), so cms_owner needs no access to schema auth.
-- security definer: runs as cms_owner (the table owner), so it can read
-- cms_config without recursing into cms_config's own RLS policy.
create function cms.cms_is_admin(uid uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select uid is not null and exists (
    select 1
    from cms.cms_config c
    where c.key = 'admin_user_id'
      and c.value #>> '{}' = uid::text
  );
$$;

revoke execute on function cms.cms_is_admin(uuid) from public;
grant execute on function cms.cms_is_admin(uuid) to authenticated;

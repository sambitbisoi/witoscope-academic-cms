-- Q38 PR 2 (plan docs/plan-2026-11-23-q38-direct-generation.md §8 and §10). Schema cms only; adds only.
-- Needs the roles of db/bootstrap/02-cms-roles.sql (Sambit runs it in the SQL editor first; the grants below fail if not).
--
--  Roles   cms_reader: USAGE on cms + SELECT on every cms table and sequence (now and later: default privileges of
--          cms_owner). cms_gen_writer: USAGE on cms + EXECUTE on the generation import functions, cms_gen_config and the
--          lease functions only; no table rights. Neither may approve, roll back, edit or read tables.
--  Lease   cms_work_lease: one row, "one CMS writer at a time" (gen:import, a Claude CMS session doing real data work, later
--          Route A collection). Taken with cms_take_lease (renewed by the same holder, refused while another holder's
--          lease is live, taken over once it has expired), kept alive with cms_heartbeat_lease, given back with
--          cms_release_lease. Take, take-over and release are audited (target 'lease'); heartbeats are not.
--          Callers: the CMS admin (JWT) or a Mac script logged in as cms_owner / cms_gen_writer (cms_gen_caller, 0047,
--          now never 'admin' for a cms_gen_writer login); only the admin or cms_owner may force a release.
--  Default New cms functions get no PUBLIC EXECUTE (alter default privileges), so the login roles reach only what is granted.

-- ---------------------------------------------------------------- roles
grant usage on schema cms to cms_reader, cms_gen_writer;
grant select on all tables in schema cms to cms_reader;
grant select on all sequences in schema cms to cms_reader;
alter default privileges in schema cms grant select on tables to cms_reader;
alter default privileges in schema cms grant select on sequences to cms_reader;
-- Postgres gives PUBLIC EXECUTE on every new function by default. Every migration so far revoked it by hand; from now
-- on cms_owner's new functions start with no EXECUTE for anyone, so a forgotten revoke can never open one to the
-- new login roles (or anyone else). Existing functions: none is executable by PUBLIC (checked 28 Nov; rls test).
-- (A schema-level default can only add to the built-in one, so this is cms_owner's own default; cms_owner creates
-- objects in schema cms only.)
alter default privileges for role cms_owner revoke execute on functions from public;

-- cms_gen_caller (0047): a cms_gen_writer login is always 'cms_gen_writer', even if the session sets admin JWT claims
-- (any login role can set request.jwt.claims). Unchanged for the browser (admin) and cms_owner scripts.
create or replace function cms.cms_gen_caller()
  returns text
  language sql
  stable
  set search_path = ''
as $$
  select case when session_user::text = 'cms_gen_writer' then 'cms_gen_writer'
              when cms.cms_is_admin(cms.cms_current_uid()) then 'admin'
              when session_user::text = 'cms_owner' then 'cms_owner' end;
$$;

grant execute on function cms.cms_gen_open_run(jsonb) to cms_gen_writer;
grant execute on function cms.cms_gen_import_batch(jsonb) to cms_gen_writer;
grant execute on function cms.cms_gen_close_run(jsonb) to cms_gen_writer;
grant execute on function cms.cms_gen_set_briefs(jsonb) to cms_gen_writer;

/** What gen:import reads from cms_config, for a caller with no table rights (cms_gen_writer). */
create function cms.cms_gen_config()
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = ''
as $$
begin
  if cms.cms_gen_caller() is null then raise exception 'Only the CMS admin or a Mac import session can read the generation settings.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'batch_size', coalesce((select value::text::int from cms.cms_config where key = 'gen_batch_size'), 10),
    'steady_state', coalesce((select value from cms.cms_config where key = 'gen_steady_state'), '{}'::jsonb));
end;
$$;
revoke execute on function cms.cms_gen_config() from public;
grant execute on function cms.cms_gen_config() to authenticated, cms_gen_writer;

-- ---------------------------------------------------------------- the work lease
create table cms.cms_work_lease (
  lease_id     boolean primary key default true check (lease_id),
  holder       text check (holder is null or length(btrim(holder)) between 1 and 120),
  kind         text check (kind in ('gen_import', 'cms_session', 'route_a_collect', 'script')),
  note         text,
  taken_by     text,                          -- 'admin', 'cms_owner' or 'cms_gen_writer'
  taken_at     timestamptz,
  heartbeat_at timestamptz,
  expires_at   timestamptz,
  check ((holder is null) = (kind is null) and (holder is null) = (expires_at is null))
);
alter table cms.cms_work_lease enable row level security;
grant select on cms.cms_work_lease to authenticated, cms_reader;
create policy cms_admin_only on cms.cms_work_lease for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));
insert into cms.cms_work_lease (lease_id) values (true);

alter table cms.cms_reviews drop constraint cms_reviews_target_check;
alter table cms.cms_reviews add constraint cms_reviews_target_check check (target in ('question_version', 'catalogue', 'course', 'lease'));
alter table cms.cms_reviews drop constraint cms_reviews_action_check;
alter table cms.cms_reviews add constraint cms_reviews_action_check check (action in (
  'submit', 'approve', 'reject', 'typo_fix', 'retire', 'restore', 'edit_catalogue', 'import_replace_draft',
  'edit_draft', 'new_version', 'withdraw', 'create', 'remove_book_material', 'override_near_copy', 'import_update',
  'decline_override', 'review_status', 'originality_check', 'reorder', 'science_row', 'science_review', 'science_rationalise',
  'derived_update', 'held_out', 'held_out_place', 'held_out_discard',
  'course_save', 'course_status', 'course_upload', 'course_clone', 'course_copy',
  'gen_run_open', 'gen_run_close', 'gen_rollback',
  'image_brief', 'image_set', 'image_check', 'image_undo', 'image_run',
  'lease_take', 'lease_takeover', 'lease_release'));

/** The lease as a jsonb (free = holder null; a lease past expires_at counts as free). */
create function cms.cms_lease_json(l cms.cms_work_lease)
  returns jsonb
  language sql
  stable
  set search_path = ''
as $$
  select jsonb_build_object('holder', l.holder, 'kind', l.kind, 'note', l.note, 'taken_by', l.taken_by, 'taken_at', l.taken_at,
           'heartbeat_at', l.heartbeat_at, 'expires_at', l.expires_at, 'live', l.holder is not null and l.expires_at > now());
$$;
revoke execute on function cms.cms_lease_json(cms.cms_work_lease) from public;

-- p = { holder, kind, note?, minutes? (1–240, default 15) }. Returns { taken: 'new' | 'renewed' | 'takeover', lease }.
create function cms.cms_take_lease(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  who text := cms.cms_gen_caller();
  h text := nullif(btrim(p->>'holder'), '');
  k text := p->>'kind';
  mins int := coalesce((p->>'minutes')::int, 15);
  l cms.cms_work_lease;
  how text;
begin
  if who is null then raise exception 'Only the CMS admin or a Mac script session can take the work lease.' using errcode = '42501'; end if;
  if h is null then raise exception 'The lease needs a holder name.'; end if;
  if k is null or k not in ('gen_import', 'cms_session', 'route_a_collect', 'script') then raise exception 'Lease kind % is not gen_import, cms_session, route_a_collect or script.', coalesce(k, 'null'); end if;
  if mins < 1 or mins > 240 then raise exception 'A lease lasts 1 to 240 minutes (got %).', mins; end if;
  select * into l from cms.cms_work_lease where lease_id for update;
  if l.holder is not null and l.expires_at > now() and l.holder <> h then
    raise exception 'The CMS is busy: % (%) holds the write lease since %; it expires at % unless renewed.',
      l.holder, l.kind, to_char(l.taken_at at time zone 'Asia/Kolkata', 'DD Mon HH24:MI'), to_char(l.expires_at at time zone 'Asia/Kolkata', 'HH24:MI')
      using errcode = '55P03';
  end if;
  how := case when l.holder = h and l.expires_at > now() then 'renewed' when l.holder is not null then 'takeover' else 'new' end;
  update cms.cms_work_lease set holder = h, kind = k, note = coalesce(nullif(btrim(p->>'note'), ''), case when how = 'renewed' then l.note end),
         taken_by = case when how = 'renewed' then l.taken_by else who end, taken_at = case when how = 'renewed' then l.taken_at else now() end,
         heartbeat_at = now(), expires_at = now() + make_interval(mins => mins)
   where lease_id returning * into l;
  if how <> 'renewed' then
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
      values ('lease', 'cms_work_lease', 'lease', case when how = 'new' then 'lease_take' else 'lease_takeover' end, l.note,
              jsonb_build_object('kind', k, 'expires_at', l.expires_at, 'taken_by', who), case when who = 'admin' then cms.cms_current_uid() end, h);
  end if;
  return jsonb_build_object('taken', how, 'lease', cms.cms_lease_json(l));
end;
$$;

-- Keeps the holder's lease alive (minutes as at take, default 15). Raises if the holder no longer holds it.
create function cms.cms_heartbeat_lease(p_holder text, p_minutes int default 15)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  l cms.cms_work_lease;
begin
  if cms.cms_gen_caller() is null then raise exception 'Only the CMS admin or a Mac script session can renew the work lease.' using errcode = '42501'; end if;
  if p_minutes < 1 or p_minutes > 240 then raise exception 'A lease lasts 1 to 240 minutes (got %).', p_minutes; end if;
  update cms.cms_work_lease set heartbeat_at = now(), expires_at = now() + make_interval(mins => p_minutes)
   where lease_id and holder = p_holder and expires_at > now() returning * into l;
  if not found then raise exception 'Lost the work lease: % no longer holds it.', p_holder using errcode = '55P03'; end if;
  return cms.cms_lease_json(l);
end;
$$;

-- Gives the lease back. Only its holder, or (p_force) the admin / cms_owner. Returns { released: bool, lease }.
create function cms.cms_release_lease(p_holder text, p_force boolean default false)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  who text := cms.cms_gen_caller();
  l cms.cms_work_lease;
  prev cms.cms_work_lease;
begin
  if who is null then raise exception 'Only the CMS admin or a Mac script session can release the work lease.' using errcode = '42501'; end if;
  if p_force and who not in ('admin', 'cms_owner') then raise exception 'Only the CMS admin or cms_owner can force a release.' using errcode = '42501'; end if;
  select * into prev from cms.cms_work_lease where lease_id for update;
  if prev.holder is null or (prev.holder <> p_holder and not p_force) then
    return jsonb_build_object('released', false, 'lease', cms.cms_lease_json(prev));
  end if;
  update cms.cms_work_lease set holder = null, kind = null, note = null, taken_by = null, taken_at = null, heartbeat_at = null, expires_at = null
   where lease_id returning * into l;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('lease', 'cms_work_lease', 'lease', 'lease_release', case when prev.holder <> p_holder then 'forced by ' || p_holder end,
            jsonb_build_object('holder', prev.holder, 'kind', prev.kind, 'taken_at', prev.taken_at, 'forced', prev.holder <> p_holder),
            case when who = 'admin' then cms.cms_current_uid() end, p_holder);
  return jsonb_build_object('released', true, 'lease', cms.cms_lease_json(l));
end;
$$;

create function cms.cms_lease_state()
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = ''
as $$
begin
  if cms.cms_gen_caller() is null then raise exception 'Only the CMS admin or a Mac script session can read the work lease.' using errcode = '42501'; end if;
  return (select cms.cms_lease_json(l) from cms.cms_work_lease l where l.lease_id);
end;
$$;

revoke execute on function cms.cms_take_lease(jsonb) from public;
revoke execute on function cms.cms_heartbeat_lease(text, int) from public;
revoke execute on function cms.cms_release_lease(text, boolean) from public;
revoke execute on function cms.cms_lease_state() from public;
grant execute on function cms.cms_take_lease(jsonb) to authenticated, cms_gen_writer;
grant execute on function cms.cms_heartbeat_lease(text, int) to authenticated, cms_gen_writer;
grant execute on function cms.cms_release_lease(text, boolean) to authenticated, cms_gen_writer;
grant execute on function cms.cms_lease_state() to authenticated, cms_gen_writer;

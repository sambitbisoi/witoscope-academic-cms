-- Images PR (DL-040; Sambit, 24 Nov 2026). Schema cms only; adds only (the 0048 "Image to redo" trigger is REPLACED, as 0048 said).
-- Plan: docs/plan-2026-11-23-q38-direct-generation.md §14 (Images PR) and the 24 Nov answers.
--
--  Status   image_status: needs_image (Image needed) → to_check (Image to check) → has_image (OK). A production question can't
--           be approved at needed or to check. Drops trigger cms_version_image_redo and blocker image_to_redo (0048);
--           blockers: picture_pending (needed) and image_to_check.
--  Brief    cms_question_versions.image_brief: {shown, style, must_not_show, layout: row4|grid2x2|single,
--           labels: [{label A–D, points_to, x?, y?}]} (x, y = a placed label, 0–1, for a single scene). A new version keeps it.
--  History  cms_version_images: every image a version has had (svg_render / generated / upload), current or previous,
--           with its base (no letters) and labelled keys, provider, model, prompt sha, the brief used and the cost. Undo.
--  Runs     cms_image_runs / cms_image_run_items: "Generate missing" for a topic or chapter, resumable, per-run cap
--           (cms_config image_run_cap_usd, $5). A daily cap belongs in the image service (hook) once a real provider is set.
--  The 182  open generated Science versions with a drawn figure: Image needed; the PNG (the SVG render) kept as the
--           previous image (svg_render); image_path cleared. One audit row each.
--  All writes: admin-checked definer functions, audited (actions image_brief, image_set, image_check, image_undo, image_run).

-- ---------------------------------------------------------------- status, brief
alter table cms.cms_question_versions drop constraint cms_question_versions_image_status_check;
alter table cms.cms_question_versions add constraint cms_question_versions_image_status_check
  check (image_status in ('needs_image', 'to_check', 'has_image'));

alter table cms.cms_question_versions add column image_brief jsonb;

/** A brief's shape (the same rules as shared/image-brief.ts). */
create function cms.cms_image_brief_problem(b jsonb)
  returns text
  language plpgsql
  immutable
  set search_path = ''
as $$
declare
  l jsonb;
  seen text[] := '{}';
begin
  if b is null then return null; end if;
  if jsonb_typeof(b) <> 'object' then return 'the brief must be an object'; end if;
  if coalesce(btrim(b ->> 'shown'), '') = '' then return 'the brief needs "shown"'; end if;
  if b ? 'layout' and b ->> 'layout' not in ('row4', 'grid2x2', 'single') then return 'layout is row4, grid2x2 or single'; end if;
  if b ? 'labels' and jsonb_typeof(b -> 'labels') <> 'array' then return 'labels must be a list'; end if;
  for l in select * from jsonb_array_elements(coalesce(b -> 'labels', '[]')) loop
    if l ->> 'label' is null or l ->> 'label' !~ '^[A-D]$' then return 'each label is A, B, C or D'; end if;
    if l ->> 'label' = any(seen) then return 'label ' || (l ->> 'label') || ' appears twice'; end if;
    seen := seen || (l ->> 'label');
    if coalesce(btrim(l ->> 'points_to'), '') = '' then return 'label ' || (l ->> 'label') || ' needs a target'; end if;
    if (l ? 'x' and jsonb_typeof(l -> 'x') <> 'null' and ((l ->> 'x')::numeric < 0 or (l ->> 'x')::numeric > 1))
       or (l ? 'y' and jsonb_typeof(l -> 'y') <> 'null' and ((l ->> 'y')::numeric < 0 or (l ->> 'y')::numeric > 1)) then
      return 'label positions are 0–1';
    end if;
  end loop;
  return null;
end;
$$;
revoke execute on function cms.cms_image_brief_problem(jsonb) from public;
alter table cms.cms_question_versions add constraint cms_question_versions_image_brief_shape check (cms.cms_image_brief_problem(image_brief) is null);

/** The brief as one line of text (kept in figure_description, so every older screen and export still reads it). */
create function cms.cms_image_brief_text(b jsonb)
  returns text
  language sql
  immutable
  set search_path = ''
as $$
  select concat_ws(' · ', 'Shown: ' || btrim(b ->> 'shown'),
                   'Style: ' || nullif(btrim(b ->> 'style'), ''),
                   'Must NOT show: ' || nullif(btrim(b ->> 'must_not_show'), ''),
                   'Labels: ' || nullif((select string_agg((l ->> 'label') || ' -> ' || (l ->> 'points_to'), '; ' order by l ->> 'label')
                                          from jsonb_array_elements(coalesce(b -> 'labels', '[]')) l), ''));
$$;
revoke execute on function cms.cms_image_brief_text(jsonb) from public;

-- a new version (Edit) keeps the brief of the version it came from
create function cms.cms_version_keep_brief()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if new.image_brief is null and new.version_no > 1 then
    new.image_brief := (select v.image_brief from cms.cms_question_versions v where v.question_id = new.question_id and v.version_no = new.version_no - 1);
  end if;
  return new;
end;
$$;
revoke execute on function cms.cms_version_keep_brief() from public;
create trigger cms_version_keep_brief before insert on cms.cms_question_versions for each row execute function cms.cms_version_keep_brief();

-- ---------------------------------------------------------------- approval: replaces 0048's Image to redo
drop trigger cms_version_image_redo on cms.cms_question_versions;
drop function cms.cms_version_image_redo();

create function cms.cms_version_image_check()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') and new.image_status = 'to_check'
     and exists (select 1 from cms.cms_questions q where q.question_id = new.question_id and q.bank = 'production') then
    raise exception 'v% of % can''t be approved yet: its image is to check (mark it OK or Redo).', new.version_no, new.question_id;
  end if;
  return new;
end;
$$;
revoke execute on function cms.cms_version_image_check() from public;
create trigger cms_version_image_check before insert or update of status on cms.cms_question_versions
  for each row execute function cms.cms_version_image_check();

-- ---------------------------------------------------------------- history
create table cms.cms_version_images (
  image_id     bigint generated always as identity primary key,
  version_id   bigint not null references cms.cms_question_versions (version_id),
  image_path   text,                          -- what the child sees (labels drawn in); null = none
  base_path    text,                          -- the same picture without letters (generated / labelled ones)
  source       text not null check (source in ('svg_render', 'generated', 'upload')),
  state        text not null check (state in ('current', 'previous')),
  provider     text, model text, prompt_sha text,
  brief        jsonb,                         -- the brief this image was made from
  cost_usd     numeric(10, 4) not null default 0,
  run_id       bigint,                        -- cms_image_runs (Generate missing)
  note         text,
  created_by   uuid, by_label text not null default 'Sambit',
  created_at   timestamptz not null default now(),
  check (image_path is null or image_path ~ '^figures/'), check (base_path is null or base_path ~ '^figures/')
);
create unique index cms_version_images_one_current on cms.cms_version_images (version_id) where state = 'current';
create index cms_version_images_version on cms.cms_version_images (version_id, image_id);
alter table cms.cms_version_images enable row level security;
grant select on cms.cms_version_images to authenticated;
create policy cms_admin_only on cms.cms_version_images for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

-- ---------------------------------------------------------------- Generate missing (resumable runs)
create sequence cms.cms_ir_seq;
create table cms.cms_image_runs (
  run_id      bigint generated always as identity primary key,
  run_code    text not null unique default 'IR' || lpad(nextval('cms.cms_ir_seq')::text, 4, '0'),
  scope_kind  text not null check (scope_kind in ('topic', 'chapter')),
  scope_id    text not null,
  provider    text not null,
  price_usd   numeric(10, 4) not null check (price_usd >= 0),
  cap_usd     numeric(10, 2) not null check (cap_usd > 0),
  spent_usd   numeric(10, 4) not null default 0,
  status      text not null default 'open' check (status in ('open', 'done', 'stopped', 'cancelled')),
  note        text,
  created_by  uuid, created_at timestamptz not null default now(), finished_at timestamptz
);
create unique index cms_image_runs_one_open on cms.cms_image_runs (scope_kind, scope_id) where status = 'open';
create table cms.cms_image_run_items (
  run_id      bigint not null references cms.cms_image_runs (run_id),
  question_id text not null references cms.cms_questions (question_id),
  status      text not null default 'pending' check (status in ('pending', 'claimed', 'done', 'failed', 'skipped')),
  cost_usd    numeric(10, 4) not null default 0,
  error       text,
  updated_at  timestamptz not null default now(),
  primary key (run_id, question_id)
);
alter table cms.cms_version_images add constraint cms_version_images_run foreign key (run_id) references cms.cms_image_runs (run_id);
alter table cms.cms_image_runs enable row level security;
alter table cms.cms_image_run_items enable row level security;
grant select on cms.cms_image_runs, cms.cms_image_run_items to authenticated;
create policy cms_admin_only on cms.cms_image_runs for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));
create policy cms_admin_only on cms.cms_image_run_items for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

insert into cms.cms_config (key, value, note) values
  ('image_run_cap_usd', '5', 'Images PR (DL-040): default spend cap per "Generate missing" run, USD')
on conflict (key) do nothing;

alter table cms.cms_reviews drop constraint cms_reviews_action_check;
alter table cms.cms_reviews add constraint cms_reviews_action_check check (action in (
  'submit', 'approve', 'reject', 'typo_fix', 'retire', 'restore', 'edit_catalogue', 'import_replace_draft',
  'edit_draft', 'new_version', 'withdraw', 'create', 'remove_book_material', 'override_near_copy', 'import_update',
  'decline_override', 'review_status', 'originality_check', 'reorder', 'science_row', 'science_review', 'science_rationalise',
  'derived_update', 'held_out', 'held_out_place', 'held_out_discard',
  'course_save', 'course_status', 'course_upload', 'course_clone', 'course_copy',
  'gen_run_open', 'gen_run_close', 'gen_rollback',
  'image_brief', 'image_set', 'image_check', 'image_undo', 'image_run'));

-- ---------------------------------------------------------------- write functions (admin; open versions only)
/** The current version of a question, locked, if it is open (draft / Needs review). */
create function cms.cms_image_open_version(p_question_id text, p_version_no int)
  returns cms.cms_question_versions
  language plpgsql
  set search_path = ''
as $$
declare
  q cms.cms_questions;
  v cms.cms_question_versions;
begin
  select * into q from cms.cms_questions where question_id = p_question_id for update;
  if not found then raise exception 'Question % does not exist.', p_question_id; end if;
  if q.retired_at is not null then raise exception 'Question % is retired.', p_question_id; end if;
  if p_version_no is distinct from q.current_version then
    raise exception 'Question % changed since you opened it (it is now at v%). Reload and try again.', p_question_id, q.current_version;
  end if;
  select * into v from cms.cms_question_versions where question_id = p_question_id and version_no = q.current_version for update;
  if v.status not in ('draft', 'in_review') then
    raise exception 'v% is %; Edit makes a new version first, then change its image.', v.version_no, v.status;
  end if;
  return v;
end;
$$;
revoke execute on function cms.cms_image_open_version(text, int) from public;

create function cms.cms_image_audit(v cms.cms_question_versions, p_action text, p_reason text, p_diff jsonb, p_label text default 'Sambit')
  returns void
  language sql
  set search_path = ''
as $$
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
  values ('question_version', 'cms_question_versions', v.question_id || ' v' || v.version_no, p_action, p_reason, p_diff, cms.cms_current_uid(), p_label);
$$;
revoke execute on function cms.cms_image_audit(cms.cms_question_versions, text, text, jsonb, text) from public;

-- p: {question_id, version_no, brief, reason?}
create function cms.cms_set_image_brief(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v cms.cms_question_versions;
  bad text;
begin
  if not cms.cms_is_admin(cms.cms_current_uid()) then raise exception 'Only the CMS admin can change images.' using errcode = '42501'; end if;
  v := cms.cms_image_open_version(p ->> 'question_id', (p ->> 'version_no')::int);
  bad := cms.cms_image_brief_problem(p -> 'brief');
  if bad is not null or p -> 'brief' is null then raise exception 'Image brief: %.', coalesce(bad, 'missing'); end if;
  if v.image_brief is not distinct from p -> 'brief' then return jsonb_build_object('changed', false); end if;
  update cms.cms_question_versions set image_brief = p -> 'brief', figure_description = cms.cms_image_brief_text(p -> 'brief'),
         image_status = coalesce(image_status, 'needs_image'), edited_at = now()
   where version_id = v.version_id;
  perform cms.cms_image_audit(v, 'image_brief', coalesce(nullif(btrim(p ->> 'reason'), ''), 'image brief'),
    jsonb_build_object('image_brief', jsonb_build_object('before', v.image_brief, 'after', p -> 'brief')));
  return jsonb_build_object('changed', true);
end;
$$;

-- p: {question_id, version_no, image_path, base_path?, source: generated|upload, provider?, model?, prompt_sha?, cost_usd?, run_code?, note?}
-- The new image becomes current (the old one previous) and the question goes to "Image to check".
create function cms.cms_set_image(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v cms.cms_question_versions;
  r cms.cms_image_runs;
  img bigint;
  cost numeric := coalesce((p ->> 'cost_usd')::numeric, 0);
begin
  if not cms.cms_is_admin(cms.cms_current_uid()) then raise exception 'Only the CMS admin can change images.' using errcode = '42501'; end if;
  v := cms.cms_image_open_version(p ->> 'question_id', (p ->> 'version_no')::int);
  if coalesce(p ->> 'source', '') not in ('generated', 'upload') then raise exception 'source is generated or upload.'; end if;
  if coalesce(p ->> 'image_path', '') !~ '^figures/[A-Za-z0-9][A-Za-z0-9._/-]*\.(png|jpe?g|webp)$' or p ->> 'image_path' like '%..%' then
    raise exception 'The image must be a PNG / JPEG / WebP under figures/.';
  end if;
  if p ->> 'base_path' is not null and (p ->> 'base_path' !~ '^figures/[A-Za-z0-9][A-Za-z0-9._/-]*\.(png|jpe?g|webp)$' or p ->> 'base_path' like '%..%') then
    raise exception 'The base image must be a PNG / JPEG / WebP under figures/.';
  end if;
  if cost < 0 then raise exception 'cost_usd can''t be negative.'; end if;
  if p ->> 'run_code' is not null then
    select * into r from cms.cms_image_runs where run_code = p ->> 'run_code' for update;
    if not found or r.status <> 'open' then raise exception 'Image run % is not open.', p ->> 'run_code'; end if;
  end if;
  update cms.cms_version_images set state = 'previous' where version_id = v.version_id and state = 'current';
  insert into cms.cms_version_images (version_id, image_path, base_path, source, state, provider, model, prompt_sha, brief, cost_usd, run_id, note, created_by)
    values (v.version_id, p ->> 'image_path', p ->> 'base_path', p ->> 'source', 'current', p ->> 'provider', p ->> 'model', p ->> 'prompt_sha',
            v.image_brief, cost, r.run_id, nullif(btrim(p ->> 'note'), ''), cms.cms_current_uid())
    returning image_id into img;
  update cms.cms_question_versions set image_path = p ->> 'image_path', image_status = 'to_check', edited_at = now() where version_id = v.version_id;
  if r.run_id is not null then
    update cms.cms_image_run_items set status = 'done', cost_usd = cost, error = null, updated_at = now() where run_id = r.run_id and question_id = v.question_id;
    update cms.cms_image_runs set spent_usd = spent_usd + cost where run_id = r.run_id;
  end if;
  perform cms.cms_image_audit(v, 'image_set', coalesce(nullif(btrim(p ->> 'note'), ''), (p ->> 'source') || coalesce(' · ' || (p ->> 'run_code'), '')),
    jsonb_build_object('image_path', jsonb_build_object('before', v.image_path, 'after', p ->> 'image_path'),
                       'image_status', jsonb_build_object('before', v.image_status, 'after', 'to_check'),
                       'source', p ->> 'source', 'provider', p ->> 'provider', 'cost_usd', cost));
  return jsonb_build_object('image_id', img, 'image_status', 'to_check');
end;
$$;

-- p: {question_id, version_no, decision: ok|redo, reason?}  ok → OK (has_image) · redo → Image needed (the image stays in the history)
create function cms.cms_check_image(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v cms.cms_question_versions;
  next text;
begin
  if not cms.cms_is_admin(cms.cms_current_uid()) then raise exception 'Only the CMS admin can change images.' using errcode = '42501'; end if;
  v := cms.cms_image_open_version(p ->> 'question_id', (p ->> 'version_no')::int);
  if p ->> 'decision' = 'ok' then
    if v.image_path is null then raise exception 'There is no image to mark OK.'; end if;
    if v.image_status <> 'to_check' then raise exception 'Only an image to check can be marked OK (it is %).', coalesce(v.image_status, 'none'); end if;
    next := 'has_image';
  elsif p ->> 'decision' = 'redo' then
    if p ->> 'decision' = 'redo' and coalesce(btrim(p ->> 'reason'), '') = '' then raise exception 'Redo needs a reason (it guides the next brief).'; end if;
    next := 'needs_image';
  else
    raise exception 'decision is ok or redo.';
  end if;
  update cms.cms_question_versions set image_status = next, edited_at = now() where version_id = v.version_id;
  perform cms.cms_image_audit(v, 'image_check', coalesce(nullif(btrim(p ->> 'reason'), ''), case next when 'has_image' then 'image OK' else 'image to redo' end),
    jsonb_build_object('image_status', jsonb_build_object('before', v.image_status, 'after', next)));
  return jsonb_build_object('image_status', next);
end;
$$;

-- p: {question_id, version_no, reason?}: the previous image comes back (current ↔ previous). A drawn SVG render (DL-040)
-- comes back as "Image needed" (still to be redone); any other image as "Image to check".
create function cms.cms_undo_image(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v cms.cms_question_versions;
  cur cms.cms_version_images;
  prev cms.cms_version_images;
  next text;
begin
  if not cms.cms_is_admin(cms.cms_current_uid()) then raise exception 'Only the CMS admin can change images.' using errcode = '42501'; end if;
  v := cms.cms_image_open_version(p ->> 'question_id', (p ->> 'version_no')::int);
  select * into cur from cms.cms_version_images where version_id = v.version_id and state = 'current' for update;
  select * into prev from cms.cms_version_images where version_id = v.version_id and state = 'previous' order by image_id desc limit 1 for update;
  if prev.image_id is null then raise exception 'There is no previous image to go back to.'; end if;
  if cur.image_id is not null then update cms.cms_version_images set state = 'previous' where image_id = cur.image_id; end if;
  update cms.cms_version_images set state = 'current' where image_id = prev.image_id;
  next := case when prev.source = 'svg_render' then 'needs_image' else 'to_check' end;
  update cms.cms_question_versions set image_path = case when prev.source = 'svg_render' then null else prev.image_path end,
         image_status = next, edited_at = now() where version_id = v.version_id;
  perform cms.cms_image_audit(v, 'image_undo', coalesce(nullif(btrim(p ->> 'reason'), ''), 'previous image back'),
    jsonb_build_object('image_path', jsonb_build_object('before', v.image_path, 'after', case when prev.source = 'svg_render' then null else prev.image_path end),
                       'image_status', jsonb_build_object('before', v.image_status, 'after', next), 'restored', prev.image_id));
  return jsonb_build_object('image_status', next, 'image_path', case when prev.source = 'svg_render' then null else prev.image_path end);
end;
$$;

-- ---------------------------------------------------------------- Generate missing: runs
-- p: {scope_kind: topic|chapter, scope_id, provider, price_usd, cap_usd?}. The open run of the same scope is CONTINUED
-- (resumable); otherwise a new one lists every open Science production question of the scope at Image needed.
create function cms.cms_image_run_open(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  r cms.cms_image_runs;
  n int;
  cap numeric := coalesce((p ->> 'cap_usd')::numeric, (select value::text::numeric from cms.cms_config where key = 'image_run_cap_usd'), 5);
begin
  if not cms.cms_is_admin(cms.cms_current_uid()) then raise exception 'Only the CMS admin can generate images.' using errcode = '42501'; end if;
  if coalesce(p ->> 'scope_kind', '') not in ('topic', 'chapter') then raise exception 'scope_kind is topic or chapter.'; end if;
  select * into r from cms.cms_image_runs where scope_kind = p ->> 'scope_kind' and scope_id = p ->> 'scope_id' and status = 'open' for update;
  if found then
    update cms.cms_image_run_items set status = 'pending', updated_at = now() where run_id = r.run_id and status = 'claimed';  -- a run left mid-batch
    return jsonb_build_object('run_code', r.run_code, 'continued', true, 'cap_usd', r.cap_usd, 'spent_usd', r.spent_usd, 'price_usd', r.price_usd,
      'pending', (select count(*) from cms.cms_image_run_items i where i.run_id = r.run_id and i.status = 'pending'));
  end if;
  if coalesce(btrim(p ->> 'provider'), '') = '' then raise exception 'No image service is set up.'; end if;
  insert into cms.cms_image_runs (scope_kind, scope_id, provider, price_usd, cap_usd, created_by)
    values (p ->> 'scope_kind', p ->> 'scope_id', p ->> 'provider', coalesce((p ->> 'price_usd')::numeric, 0), cap, cms.cms_current_uid()) returning * into r;
  insert into cms.cms_image_run_items (run_id, question_id)
    select r.run_id, q.question_id
      from cms.cms_questions q join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
     where q.subject = 'science' and q.bank = 'production' and q.retired_at is null and v.status in ('draft', 'in_review') and v.image_status = 'needs_image'
       and (case p ->> 'scope_kind' when 'topic' then q.topic_id else q.chapter_id end) = p ->> 'scope_id';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Nothing to generate: no Science question here is at Image needed.'; end if;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('catalogue', 'cms_image_runs', r.run_code, 'image_run', 'Generate missing images: ' || (p ->> 'scope_kind') || ' ' || (p ->> 'scope_id'),
            jsonb_build_object('questions', n, 'cap_usd', cap, 'price_usd', r.price_usd, 'provider', r.provider), cms.cms_current_uid(), 'Sambit');
  return jsonb_build_object('run_code', r.run_code, 'continued', false, 'cap_usd', cap, 'spent_usd', 0, 'price_usd', r.price_usd, 'pending', n);
end;
$$;

-- The next questions of a run, only as many as the cap still allows (spent + n × price ≤ cap). [] = done or cap reached.
create function cms.cms_image_run_claim(p_run_code text, p_n int)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  r cms.cms_image_runs;
  allowed int;
  ids text[];
begin
  if not cms.cms_is_admin(cms.cms_current_uid()) then raise exception 'Only the CMS admin can generate images.' using errcode = '42501'; end if;
  select * into r from cms.cms_image_runs where run_code = p_run_code for update;
  if not found or r.status <> 'open' then raise exception 'Image run % is not open.', p_run_code; end if;
  allowed := case when r.price_usd = 0 then greatest(p_n, 0) else least(greatest(p_n, 0), floor((r.cap_usd - r.spent_usd) / r.price_usd)::int) end;
  select coalesce(array_agg(question_id order by question_id), '{}') into ids from (
    select question_id from cms.cms_image_run_items where run_id = r.run_id and status = 'pending' order by question_id limit greatest(allowed, 0)) x;
  update cms.cms_image_run_items set status = 'claimed', updated_at = now() where run_id = r.run_id and question_id = any(ids);
  return jsonb_build_object('question_ids', to_jsonb(ids),
    'cap_reached', allowed < 1 and exists (select 1 from cms.cms_image_run_items where run_id = r.run_id and status = 'pending'),
    'spent_usd', r.spent_usd, 'cap_usd', r.cap_usd,
    'pending', (select count(*) from cms.cms_image_run_items where run_id = r.run_id and status = 'pending'));
end;
$$;

-- p: {run_code, question_id, status: failed|skipped, error?, cost_usd?} (a done item is written by cms_set_image)
create function cms.cms_image_run_item(p jsonb)
  returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  r cms.cms_image_runs;
begin
  if not cms.cms_is_admin(cms.cms_current_uid()) then raise exception 'Only the CMS admin can generate images.' using errcode = '42501'; end if;
  if coalesce(p ->> 'status', '') not in ('failed', 'skipped', 'pending') then raise exception 'status is failed, skipped or pending.'; end if;
  select * into r from cms.cms_image_runs where run_code = p ->> 'run_code' for update;
  if not found then raise exception 'Image run % does not exist.', p ->> 'run_code'; end if;
  update cms.cms_image_run_items set status = p ->> 'status', error = left(p ->> 'error', 500), cost_usd = cost_usd + coalesce((p ->> 'cost_usd')::numeric, 0), updated_at = now()
   where run_id = r.run_id and question_id = p ->> 'question_id';
  if not found then raise exception '% is not in run %.', p ->> 'question_id', p ->> 'run_code'; end if;
  update cms.cms_image_runs set spent_usd = spent_usd + coalesce((p ->> 'cost_usd')::numeric, 0) where run_id = r.run_id;
end;
$$;

-- p: {run_code, status: done|stopped|cancelled, note?}
create function cms.cms_image_run_close(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  r cms.cms_image_runs;
begin
  if not cms.cms_is_admin(cms.cms_current_uid()) then raise exception 'Only the CMS admin can generate images.' using errcode = '42501'; end if;
  if coalesce(p ->> 'status', '') not in ('done', 'stopped', 'cancelled') then raise exception 'status is done, stopped or cancelled.'; end if;
  select * into r from cms.cms_image_runs where run_code = p ->> 'run_code' for update;
  if not found or r.status <> 'open' then raise exception 'Image run % is not open.', p ->> 'run_code'; end if;
  update cms.cms_image_run_items set status = 'pending' where run_id = r.run_id and status = 'claimed';
  update cms.cms_image_runs set status = p ->> 'status', finished_at = now(), note = nullif(btrim(p ->> 'note'), '') where run_id = r.run_id;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('catalogue', 'cms_image_runs', r.run_code, 'image_run', 'image run ' || (p ->> 'status') || coalesce(': ' || nullif(btrim(p ->> 'note'), ''), ''),
            jsonb_build_object('spent_usd', r.spent_usd, 'items', (select jsonb_object_agg(s, n) from (select status s, count(*) n from cms.cms_image_run_items where run_id = r.run_id group by 1) x)),
            cms.cms_current_uid(), 'Sambit');
  return jsonb_build_object('run_code', r.run_code, 'status', p ->> 'status', 'spent_usd', r.spent_usd);
end;
$$;

-- ---------------------------------------------------------------- briefs from a generation run (gen:import, images:briefs)
-- p: {run_code, briefs: [{local_id, brief}]}. Admin, or a Mac import session (cms_gen_caller). Only questions the run
-- imported, at their open version. Audited (by_label gen:<run>). Returns counts.
create function cms.cms_gen_set_briefs(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  r cms.cms_generation_runs;
  b jsonb;
  v cms.cms_question_versions;
  bad text;
  n_set int := 0; n_same int := 0;
  skipped jsonb := '[]';
begin
  if cms.cms_gen_caller() is null then raise exception 'Only the CMS admin or a generation import can set image briefs.' using errcode = '42501'; end if;
  select * into r from cms.cms_generation_runs where run_code = p ->> 'run_code';
  if not found then raise exception 'Run % does not exist.', p ->> 'run_code'; end if;
  for b in select * from jsonb_array_elements(coalesce(p -> 'briefs', '[]')) loop
    bad := cms.cms_image_brief_problem(b -> 'brief');
    select v2.* into v from cms.cms_generation_items i
      join cms.cms_questions q on q.question_id = i.question_id
      join cms.cms_question_versions v2 on v2.question_id = q.question_id and v2.version_no = q.current_version
     where i.run_id = r.run_id and i.local_id = b ->> 'local_id' and i.status = 'imported' and q.retired_at is null;
    if v.version_id is null or bad is not null or b -> 'brief' is null or v.status not in ('draft', 'in_review') then
      skipped := skipped || jsonb_build_object('local_id', b ->> 'local_id', 'why',
        case when v.version_id is null then 'not imported by this run' when bad is not null or b -> 'brief' is null then coalesce(bad, 'no brief') else 'v' || v.version_no || ' is ' || v.status end);
      v := null; continue;
    end if;
    if v.image_brief is not distinct from b -> 'brief' then n_same := n_same + 1; v := null; continue; end if;
    update cms.cms_question_versions set image_brief = b -> 'brief', figure_description = cms.cms_image_brief_text(b -> 'brief') where version_id = v.version_id;
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
      values ('question_version', 'cms_question_versions', v.question_id || ' v' || v.version_no, 'image_brief', 'image brief from ' || r.run_code,
              jsonb_build_object('image_brief', jsonb_build_object('before', v.image_brief, 'after', b -> 'brief')), cms.cms_current_uid(), 'gen:' || r.run_code);
    n_set := n_set + 1; v := null;
  end loop;
  return jsonb_build_object('set', n_set, 'unchanged', n_same, 'skipped', skipped);
end;
$$;

revoke execute on function cms.cms_set_image_brief(jsonb) from public;
grant execute on function cms.cms_set_image_brief(jsonb) to authenticated;
revoke execute on function cms.cms_set_image(jsonb) from public;
grant execute on function cms.cms_set_image(jsonb) to authenticated;
revoke execute on function cms.cms_check_image(jsonb) from public;
grant execute on function cms.cms_check_image(jsonb) to authenticated;
revoke execute on function cms.cms_undo_image(jsonb) from public;
grant execute on function cms.cms_undo_image(jsonb) to authenticated;
revoke execute on function cms.cms_image_run_open(jsonb) from public;
grant execute on function cms.cms_image_run_open(jsonb) to authenticated;
revoke execute on function cms.cms_image_run_claim(text, integer) from public;
grant execute on function cms.cms_image_run_claim(text, integer) to authenticated;
revoke execute on function cms.cms_image_run_item(jsonb) from public;
grant execute on function cms.cms_image_run_item(jsonb) to authenticated;
revoke execute on function cms.cms_image_run_close(jsonb) from public;
grant execute on function cms.cms_image_run_close(jsonb) to authenticated;
revoke execute on function cms.cms_gen_set_briefs(jsonb) from public;
grant execute on function cms.cms_gen_set_briefs(jsonb) to authenticated;

-- ---------------------------------------------------------------- blockers view (same columns): image_to_redo → picture_pending / image_to_check
create or replace view cms.cms_approval_blockers with (security_invoker = true) as
with cur as (
  select q.question_id, q.subject, q.class, q.chapter_id, q.topic_id, v.version_id, v.version_no, v.status, v.originality_pending, v.attributes_pending,
         v.image_status, v.misconception_targeted, v.misconception_row_id, v.misconception_item_no, v.created_from
    from cms.cms_questions q
    join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
   where q.bank = 'production' and q.retired_at is null and v.status in ('draft', 'in_review')
), latest as (
  select distinct on (c.version_id) c.version_id, c.result, c.field, c.closest_ref
    from cms.cms_originality_checks c join cur on cur.version_id = c.version_id
   order by c.version_id, c.check_id desc
)
select cur.question_id, cur.subject, cur.class, cur.chapter_id, cur.topic_id, cur.version_no, cur.status, r.reason, r.detail
  from cur
  cross join lateral (
    select 'originality_pending'::text as reason, null::text as detail where cur.originality_pending
    union all
    select 'near_copy_no_override', l.closest_ref from latest l
     where l.version_id = cur.version_id and l.result = 'near_copy'
       and not exists (select 1 from cms.cms_override_requests o where o.version_id = cur.version_id and o.status = 'approved' and (l.field is null or o.field = l.field))
    union all
    select 'picture_pending', null where cur.image_status = 'needs_image'
    union all
    select 'image_to_check', null where cur.image_status = 'to_check'
    union all
    select 'attributes_pending', null where cur.attributes_pending
    union all
    select 'science_solution1_empty', null where cur.subject = 'science'
       and not exists (select 1 from cms.cms_version_solutions s where s.version_id = cur.version_id and s.slot = 1 and btrim(s.text) <> '')
    union all
    select 'science_primary_not_confirmed',
           (select 'rejected: ' || string_agg(l.row_id, ', ' order by l.row_id) from cms.cms_question_content_rows l where l.version_id = cur.version_id and l.primary_rejected)
     where cur.subject = 'science'
       and (select count(*) from cms.cms_question_content_rows l where l.version_id = cur.version_id and l.rank = 'primary' and not l.rank_proposed) <> 1
       and not (cur.created_from = 'generation'
                and not exists (select 1 from cms.cms_question_content_rows l where l.version_id = cur.version_id and l.rank = 'primary' and not l.rank_proposed)
                and (select count(*) from cms.cms_question_content_rows l where l.version_id = cur.version_id and l.rank = 'primary' and l.rank_proposed) = 1)
    union all
    select 'science_free_text_misconception', null where cur.subject = 'science' and btrim(coalesce(cur.misconception_targeted, '')) <> ''
    union all
    select 'science_item_not_active', cur.misconception_row_id || ' #' || cur.misconception_item_no where cur.subject = 'science' and cur.misconception_row_id is not null
       and not exists (select 1 from cms.cms_row_misconceptions m join cms.cms_question_content_rows l on l.row_id = m.row_id and l.version_id = cur.version_id
                        where m.row_id = cur.misconception_row_id and m.item_no = cur.misconception_item_no and m.status = 'active')
    union all
    select 'science_wrong_option_item_not_active', null where cur.subject = 'science'
       and exists (select 1 from cms.cms_version_wrong_answers w where w.version_id = cur.version_id and w.tag = 'misconception'
                     and (w.mc_row_id is null or not exists (
                       select 1 from cms.cms_row_misconceptions m join cms.cms_question_content_rows l on l.row_id = m.row_id and l.version_id = cur.version_id
                        where m.row_id = w.mc_row_id and m.item_no = w.mc_item_no and m.status = 'active')))
    union all
    select 'science_type_missing', null where cur.subject = 'science'
       and (select v.science_question_type from cms.cms_question_versions v where v.version_id = cur.version_id) is null
    union all
    select 'science_concept_error_row_not_linked', null where cur.subject = 'science'
       and exists (select 1 from cms.cms_version_wrong_answers w where w.version_id = cur.version_id and w.tag = 'concept_error'
                     and (w.target_row_id is null or not exists (select 1 from cms.cms_question_content_rows l where l.version_id = cur.version_id and l.row_id = w.target_row_id)))
  ) r;

-- ---------------------------------------------------------------- the 182 (DL-040): drawn figures → Image needed, PNG kept as previous
with t as (
  select v.version_id, v.question_id, v.version_no, v.image_path
    from cms.cms_question_versions v
    join cms.cms_questions q on q.question_id = v.question_id and q.current_version = v.version_no
   where q.subject = 'science' and q.bank = 'production' and q.retired_at is null and v.created_from = 'generation'
     and v.status in ('draft', 'in_review') and v.image_status = 'has_image' and v.image_path is not null
), hist as (
  insert into cms.cms_version_images (version_id, image_path, source, state, note, by_label)
  select t.version_id, t.image_path, 'svg_render', 'previous', 'drawn figure (SVG render), kept as the previous image (DL-040)', 'migration 0049' from t
  returning version_id
), aud as (
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label)
  select 'question_version', 'cms_question_versions', t.question_id || ' v' || t.version_no, 'image_set',
         'DL-040: drawn figure to redo; its PNG is kept as the previous image',
         jsonb_build_object('image_path', jsonb_build_object('before', t.image_path, 'after', null),
                            'image_status', jsonb_build_object('before', 'has_image', 'after', 'needs_image')), 'migration 0049'
    from t
  returning target_id
)
update cms.cms_question_versions v set image_path = null, image_status = 'needs_image'
  from t where v.version_id = t.version_id;
-- the svg_render rows are "previous": nothing is current until a new image is made (Undo brings the render back)

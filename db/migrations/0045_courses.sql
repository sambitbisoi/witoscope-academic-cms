-- Q13 Course builder (Sambit, 16–18 Nov 2026; docs/plan-2026-11-18-q13-course-builder.md). Schema cms only; adds only
-- (new tables, functions and views; three CHECKs widened; one config key). No existing row changes.
--
-- Course = name · board (an editable, audited list) · class 1–6 · subject (math / science) · status draft / published / retired.
-- Course → display chapters (ordered, child-facing name) → display topics (ordered, child-facing name) → 1–4 CMS topics each.
--   * a CMS topic sits in at most ONE display topic per course (it may be in other courses); no role field
--   * questions shown for a course = questions of its CMS topics with Level ≤ course class (never higher)
--   * Achievers section per display chapter (Math only): 1–4 CMS chapters; the section uses ACH-<chapter>-<course class>
--     (resolved, never stored); a CMS chapter's Achievers sit in at most one display chapter per course
--   * nothing is deleted: display chapters / topics are retired; a removed CMS-topic or Achievers link keeps its row
--     (removed_at). Positions are null on retired / removed rows, so "one per position" is a deferrable unique constraint
--   * every change writes cms_reviews (target 'course') with before → after
--   * publishing is a status change only; nothing goes to the app (Phase 8)
-- Reference: cms_ref_book_chapters = NCERT / DAV chapter numbers and titles (bare citations), loaded only by the local
-- script `npm run import:book-chapters`; read-only here.

-- ---------------------------------------------------------------- widened CHECKs
alter table cms.cms_reviews drop constraint cms_reviews_target_check;
alter table cms.cms_reviews add constraint cms_reviews_target_check check (target in ('question_version', 'catalogue', 'course'));
alter table cms.cms_reviews drop constraint cms_reviews_action_check;
alter table cms.cms_reviews add constraint cms_reviews_action_check check (action in (
  'submit', 'approve', 'reject', 'typo_fix', 'retire', 'restore', 'edit_catalogue', 'import_replace_draft',
  'edit_draft', 'new_version', 'withdraw', 'create', 'remove_book_material', 'override_near_copy', 'import_update',
  'decline_override', 'review_status', 'originality_check', 'reorder', 'science_row', 'science_review', 'science_rationalise',
  'derived_update', 'held_out', 'held_out_place', 'held_out_discard',
  'course_save', 'course_status', 'course_upload', 'course_clone', 'course_copy'));
alter table cms.cms_imports drop constraint cms_imports_kind_check;
alter table cms.cms_imports add constraint cms_imports_kind_check check (kind in (
  'chapter', 'topics', 'seed', 'sources', 'book', 'originality', 'proposals', 'figures', 'updates', 'upload', 'science', 'science_rationalise',
  'tier_recompute', 'held_out', 'held_out_place', 'concept_class', 'book_chapters', 'course_upload'));

insert into cms.cms_config (key, value, note) values
  ('course_min_questions', '5', 'Course builder (Q13): a display topic with fewer questions at Level ≤ course class than this gets a warning')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- tables
create table cms.cms_course_boards (
  board_id   text primary key check (board_id ~ '^BRD[0-9]{2,3}$'),
  label      text not null check (btrim(label) <> '' and length(label) <= 60),
  book       text check (book in ('NCERT', 'DAV')),           -- the book series shown in the Book chapters tab (none: switch only)
  sort       int  not null,
  status     text not null default 'active' check (status in ('active', 'retired')),
  updated_at timestamptz not null default now()
);
create unique index cms_course_boards_label on cms.cms_course_boards (lower(label));

create table cms.cms_courses (
  course_id    text primary key check (course_id ~ '^CRS[0-9]{3,4}$'),
  name         text not null check (btrim(name) <> '' and length(name) <= 120),
  board_id     text not null references cms.cms_course_boards (board_id),
  class        int  not null check (class between 1 and 6),
  subject      text not null check (subject in ('math', 'science')),
  status       text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  started_from text references cms.cms_courses (course_id),
  rev          int  not null default 1,                        -- +1 on every save; a save from a stale screen is refused
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  published_at timestamptz
);
create unique index cms_courses_name on cms.cms_courses (lower(name)) where status <> 'retired';

create table cms.cms_course_chapters (
  course_chapter_id text primary key check (course_chapter_id ~ '^DCH[0-9]{4,5}$'),
  course_id         text not null references cms.cms_courses (course_id),
  position          int check (position >= 1),
  name              text not null check (btrim(name) <> '' and length(name) <= 120),
  status            text not null default 'active' check (status in ('active', 'retired')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((status = 'active') = (position is not null)),
  unique (course_chapter_id, course_id),
  constraint cms_course_chapters_position unique (course_id, position) deferrable initially deferred
);

create table cms.cms_course_topics (
  course_topic_id   text primary key check (course_topic_id ~ '^DTP[0-9]{5,6}$'),
  course_id         text not null,
  course_chapter_id text not null,
  position          int check (position >= 1),
  name              text not null check (btrim(name) <> '' and length(name) <= 120),
  status            text not null default 'active' check (status in ('active', 'retired')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((status = 'active') = (position is not null)),
  unique (course_topic_id, course_id),
  foreign key (course_chapter_id, course_id) references cms.cms_course_chapters (course_chapter_id, course_id),
  constraint cms_course_topics_position unique (course_chapter_id, position) deferrable initially deferred
);
create index cms_course_topics_course on cms.cms_course_topics (course_id);

create table cms.cms_course_topic_items (
  item_id         bigint generated always as identity primary key,
  course_id       text not null,
  course_topic_id text not null,
  position        int check (position between 1 and 4),      -- at most 4 CMS topics per display topic
  topic_id        text not null references cms.cms_topics (topic_id),
  added_at        timestamptz not null default now(),
  removed_at      timestamptz,
  check ((removed_at is null) = (position is not null)),
  foreign key (course_topic_id, course_id) references cms.cms_course_topics (course_topic_id, course_id),
  constraint cms_course_topic_items_position unique (course_topic_id, position) deferrable initially deferred
);
-- a CMS topic in at most one display topic per course
create unique index cms_course_topic_items_once on cms.cms_course_topic_items (course_id, topic_id) where removed_at is null;
create index cms_course_topic_items_topic on cms.cms_course_topic_items (topic_id);

create table cms.cms_course_achievers (
  item_id           bigint generated always as identity primary key,
  course_id         text not null,
  course_chapter_id text not null,
  position          int check (position between 1 and 4),
  chapter_id        text not null references cms.cms_chapters (chapter_id),
  added_at          timestamptz not null default now(),
  removed_at        timestamptz,
  check ((removed_at is null) = (position is not null)),
  foreign key (course_chapter_id, course_id) references cms.cms_course_chapters (course_chapter_id, course_id),
  constraint cms_course_achievers_position unique (course_chapter_id, position) deferrable initially deferred
);
create unique index cms_course_achievers_once on cms.cms_course_achievers (course_id, chapter_id) where removed_at is null;

create table cms.cms_ref_book_chapters (
  ref_id     bigint generated always as identity primary key,
  book       text not null check (book in ('NCERT', 'DAV')),
  book_title text not null check (length(book_title) <= 80),
  class      int  not null check (class between 1 and 6),
  subject    text not null check (subject in ('math', 'science')),
  ch_no      int  not null check (ch_no between 1 and 99),
  ch_name    text not null check (btrim(ch_name) <> '' and length(ch_name) <= 120),
  import_id  bigint references cms.cms_imports (import_id),
  updated_at timestamptz not null default now(),
  unique (book, class, subject, ch_no)
);

-- ---------------------------------------------------------------- seed: boards (audited)
with made as (
  insert into cms.cms_course_boards (board_id, label, book, sort) values
    ('BRD01', 'CBSE·NCERT', 'NCERT', 1), ('BRD02', 'CBSE·DAV', 'DAV', 2), ('BRD03', 'ICSE', null, 3), ('BRD04', 'IMO', null, 4)
  returning board_id, label, book, sort
)
insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label)
  select 'course', 'cms_course_boards', m.board_id, 'create', 'seed (0045): board list',
         jsonb_build_object('board', jsonb_build_object('before', null, 'after', jsonb_build_object('label', m.label, 'book', m.book, 'sort', m.sort))), 'Course builder'
    from made m;

-- ---------------------------------------------------------------- RLS (as 0008)
alter table cms.cms_course_boards enable row level security;
alter table cms.cms_courses enable row level security;
alter table cms.cms_course_chapters enable row level security;
alter table cms.cms_course_topics enable row level security;
alter table cms.cms_course_topic_items enable row level security;
alter table cms.cms_course_achievers enable row level security;
alter table cms.cms_ref_book_chapters enable row level security;
grant select on cms.cms_course_boards, cms.cms_courses, cms.cms_course_chapters, cms.cms_course_topics,
                cms.cms_course_topic_items, cms.cms_course_achievers, cms.cms_ref_book_chapters to authenticated;
create policy cms_admin_only on cms.cms_course_boards for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));
create policy cms_admin_only on cms.cms_courses for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));
create policy cms_admin_only on cms.cms_course_chapters for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));
create policy cms_admin_only on cms.cms_course_topics for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));
create policy cms_admin_only on cms.cms_course_topic_items for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));
create policy cms_admin_only on cms.cms_course_achievers for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));
create policy cms_admin_only on cms.cms_ref_book_chapters for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

-- ---------------------------------------------------------------- boards: create / update / retire / restore
-- p = { action: 'create' | 'update' | 'retire' | 'restore', id?, fields: { label?, book?, sort? }, reason? }
create function cms.cms_save_course_board(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  act text := p ->> 'action';
  f jsonb := coalesce(p -> 'fields', '{}'::jsonb);
  rid text := nullif(p ->> 'id', '');
  b jsonb; a jsonb; n int;
begin
  if not cms.cms_is_admin(uid) then raise exception 'Only the CMS admin can change the board list.' using errcode = '42501'; end if;
  if act not in ('create', 'update', 'retire', 'restore') then raise exception 'Unknown action "%".', act; end if;
  if f ? 'book' and nullif(f ->> 'book', '') is not null and f ->> 'book' not in ('NCERT', 'DAV') then raise exception 'Book must be NCERT, DAV or none.'; end if;
  if act = 'create' then
    if coalesce(btrim(f ->> 'label'), '') = '' then raise exception 'A board needs a label.'; end if;
    lock table cms.cms_course_boards in share row exclusive mode;
    select coalesce(max(substr(x.board_id, 4)::int), 0) + 1 into n from cms.cms_course_boards x;
    rid := 'BRD' || lpad(n::text, 2, '0');
    insert into cms.cms_course_boards (board_id, label, book, sort)
      values (rid, btrim(f ->> 'label'), nullif(f ->> 'book', ''), coalesce((f ->> 'sort')::int, (select coalesce(max(x.sort), 0) + 1 from cms.cms_course_boards x)));
  else
    select to_jsonb(x) - 'updated_at' into b from cms.cms_course_boards x where x.board_id = rid for update;
    if b is null then raise exception 'Board % does not exist.', rid; end if;
    update cms.cms_course_boards x set
      label = case when act = 'update' and f ? 'label' then btrim(f ->> 'label') else x.label end,
      book = case when act = 'update' and f ? 'book' then nullif(f ->> 'book', '') else x.book end,
      sort = case when act = 'update' and f ? 'sort' then (f ->> 'sort')::int else x.sort end,
      status = case act when 'retire' then 'retired' when 'restore' then 'active' else x.status end,
      updated_at = now()
     where x.board_id = rid;
  end if;
  select to_jsonb(x) - 'updated_at' into a from cms.cms_course_boards x where x.board_id = rid;
  if b is distinct from a then
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
      values ('course', 'cms_course_boards', rid, case act when 'update' then 'course_save' else act end, nullif(btrim(coalesce(p ->> 'reason', '')), ''),
              jsonb_build_object('board', jsonb_build_object('before', b, 'after', a)), uid, 'Sambit');
  end if;
  return jsonb_build_object('board_id', rid, 'changed', b is distinct from a);
end;
$$;
revoke execute on function cms.cms_save_course_board(jsonb) from public;
grant execute on function cms.cms_save_course_board(jsonb) to authenticated;

-- ---------------------------------------------------------------- helpers (not callable from the browser)
-- the CMS topics of a display topic, in order (for the audit)
create function cms.cms_course_items_state(p_topic text)
  returns jsonb
  language sql
  stable
  set search_path = ''
as $$
  select coalesce(jsonb_agg(i.topic_id order by i.position), '[]'::jsonb)
    from cms.cms_course_topic_items i where i.course_topic_id = p_topic and i.removed_at is null;
$$;
revoke execute on function cms.cms_course_items_state(text) from public;

create function cms.cms_course_achievers_state(p_chapter text)
  returns jsonb
  language sql
  stable
  set search_path = ''
as $$
  select coalesce(jsonb_agg(x.chapter_id order by x.position), '[]'::jsonb)
    from cms.cms_course_achievers x where x.course_chapter_id = p_chapter and x.removed_at is null;
$$;
revoke execute on function cms.cms_course_achievers_state(text) from public;

-- ---------------------------------------------------------------- save a course (details and/or the whole outline)
-- p = { course_id?            -- absent: a new draft course
--       rev?                  -- the course's rev when the screen loaded it (required to change an existing course)
--       source?: 'form' | 'upload' | 'clone' | 'compare' | 'start_from', reason?,
--       file?: { name, sha256 } -- upload only: recorded in cms_imports (the file itself is not stored)
--       course?: { name?, board_id?, class?, subject? },
--       outline?: { chapters: [ { id?, name, achievers: [chapter_id…], topics: [ { id?, name, cms: [topic_id…] } ] } ] } }
-- The outline is the WANTED state, in order. Rows left out are retired (chapters, topics) or removed (links).
create function cms.cms_save_course(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  src text := coalesce(nullif(p ->> 'source', ''), 'form');
  why text := nullif(btrim(coalesce(p ->> 'reason', '')), '');
  cid text := nullif(p ->> 'course_id', '');
  cf jsonb := coalesce(p -> 'course', '{}'::jsonb);
  o jsonb := p -> 'outline';
  crs cms.cms_courses;
  is_new boolean := false;
  b jsonb; a jsonb; d jsonb;
  w_ch jsonb := '[]'; w_tp jsonb := '[]'; w_it jsonb := '[]'; w_ac jsonb := '[]';
  ch jsonb; tp jsonb; x jsonb;
  ci int; ti int; n int;
  chid text; tpid text; bad text; bad2 text;
  ch_ids text[] := '{}';
  tp_ids jsonb := '{}';          -- "ci.ti" → course_topic_id
  imp bigint;
  k_ch_new int := 0; k_ch_chg int := 0; k_ch_ret int := 0;
  k_tp_new int := 0; k_tp_chg int := 0; k_tp_ret int := 0;
  k_it int := 0; k_ac int := 0;
  r record;
begin
  if not cms.cms_is_admin(uid) then raise exception 'Only the CMS admin can change courses.' using errcode = '42501'; end if;
  if src not in ('form', 'upload', 'clone', 'compare', 'start_from') then raise exception 'Unknown source "%".', src; end if;

  -- ------------------------------------------------------------ the course row
  if cid is null then
    is_new := true;
    if coalesce(btrim(cf ->> 'name'), '') = '' then raise exception 'A course needs a name.'; end if;
    if not exists (select 1 from cms.cms_course_boards x where x.board_id = cf ->> 'board_id' and x.status = 'active') then
      raise exception 'Choose a board from the list (% is not an active board).', coalesce(cf ->> 'board_id', 'none');
    end if;
    if coalesce(cf ->> 'subject', '') not in ('math', 'science') then raise exception 'Subject must be Math or Science.'; end if;
    if coalesce((cf ->> 'class')::int, 0) not between 1 and 6 then raise exception 'Class must be 1–6.'; end if;
    if exists (select 1 from cms.cms_courses x where lower(x.name) = lower(btrim(cf ->> 'name')) and x.status <> 'retired') then
      raise exception 'A course called "%" already exists.', btrim(cf ->> 'name');
    end if;
    lock table cms.cms_courses in share row exclusive mode;
    select coalesce(max(substr(x.course_id, 4)::int), 0) + 1 into n from cms.cms_courses x;
    cid := 'CRS' || lpad(n::text, 3, '0');
    insert into cms.cms_courses (course_id, name, board_id, class, subject, started_from)
      values (cid, btrim(cf ->> 'name'), cf ->> 'board_id', (cf ->> 'class')::int, cf ->> 'subject', nullif(p ->> 'from_course', ''))
      returning * into crs;
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
      values ('course', 'cms_courses', cid, 'create', why,
              jsonb_build_object('course', jsonb_build_object('before', null, 'after',
                jsonb_build_object('name', crs.name, 'board_id', crs.board_id, 'class', crs.class, 'subject', crs.subject, 'status', crs.status, 'started_from', crs.started_from))),
              uid, 'Sambit');
  else
    select * into crs from cms.cms_courses x where x.course_id = cid for update;
    if not found then raise exception 'Course % does not exist.', cid; end if;
    if crs.status <> 'draft' then raise exception 'Course % is %; use "Back to draft" first.', cid, crs.status; end if;
    if (p ->> 'rev') is null or (p ->> 'rev')::int <> crs.rev then
      raise exception 'Course % was changed since you opened it (another tab?). Reload and try again.', cid;
    end if;
    if cf ? 'subject' and cf ->> 'subject' is distinct from crs.subject then raise exception 'The subject of a course can''t change.'; end if;
    if cf ? 'board_id' and cf ->> 'board_id' is distinct from crs.board_id
       and not exists (select 1 from cms.cms_course_boards x where x.board_id = cf ->> 'board_id' and x.status = 'active') then
      raise exception 'Choose a board from the list (% is not an active board).', cf ->> 'board_id';
    end if;
    if cf ? 'class' and coalesce((cf ->> 'class')::int, 0) not between 1 and 6 then raise exception 'Class must be 1–6.'; end if;
    if cf ? 'name' and coalesce(btrim(cf ->> 'name'), '') = '' then raise exception 'A course needs a name.'; end if;
    if cf ? 'name' and exists (select 1 from cms.cms_courses x where lower(x.name) = lower(btrim(cf ->> 'name')) and x.status <> 'retired' and x.course_id <> cid) then
      raise exception 'A course called "%" already exists.', btrim(cf ->> 'name');
    end if;
    b := jsonb_build_object('name', crs.name, 'board_id', crs.board_id, 'class', crs.class);
    update cms.cms_courses x set
      name = case when cf ? 'name' then btrim(cf ->> 'name') else x.name end,
      board_id = case when cf ? 'board_id' then cf ->> 'board_id' else x.board_id end,
      class = case when cf ? 'class' then (cf ->> 'class')::int else x.class end
     where x.course_id = cid returning * into crs;
    a := jsonb_build_object('name', crs.name, 'board_id', crs.board_id, 'class', crs.class);
    if a is distinct from b then
      select coalesce(jsonb_object_agg(k.key, jsonb_build_object('before', b -> k.key, 'after', a -> k.key)), '{}') into d
        from jsonb_object_keys(a) k(key) where (a -> k.key) is distinct from (b -> k.key);
      insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
        values ('course', 'cms_courses', cid, 'course_save', why, d, uid, 'Sambit');
    end if;
  end if;

  -- ------------------------------------------------------------ the outline
  if o is not null then
    if jsonb_typeof(o -> 'chapters') is distinct from 'array' then raise exception 'outline.chapters must be a list.'; end if;
    -- flatten (positions 1…n, in the order given)
    ci := 0;
    for ch in select value from jsonb_array_elements(o -> 'chapters') loop
      ci := ci + 1;
      if coalesce(btrim(ch ->> 'name'), '') = '' then raise exception 'Chapter %: a display chapter needs a name.', ci; end if;
      w_ch := w_ch || jsonb_build_object('ci', ci, 'id', nullif(ch ->> 'id', ''), 'name', btrim(ch ->> 'name'));
      if jsonb_array_length(coalesce(ch -> 'achievers', '[]')) > 4 then raise exception 'Chapter % "%": at most 4 Achievers chapters.', ci, btrim(ch ->> 'name'); end if;
      n := 0;
      for x in select value from jsonb_array_elements(coalesce(ch -> 'achievers', '[]')) loop
        n := n + 1; w_ac := w_ac || jsonb_build_object('ci', ci, 'pos', n, 'chapter_id', x #>> '{}');
      end loop;
      ti := 0;
      for tp in select value from jsonb_array_elements(coalesce(ch -> 'topics', '[]')) loop
        ti := ti + 1;
        if coalesce(btrim(tp ->> 'name'), '') = '' then raise exception 'Topic %.%: a display topic needs a name.', ci, ti; end if;
        if jsonb_array_length(coalesce(tp -> 'cms', '[]')) > 4 then raise exception 'Topic %.% "%": at most 4 CMS topics.', ci, ti, btrim(tp ->> 'name'); end if;
        w_tp := w_tp || jsonb_build_object('ci', ci, 'ti', ti, 'id', nullif(tp ->> 'id', ''), 'name', btrim(tp ->> 'name'));
        n := 0;
        for x in select value from jsonb_array_elements(coalesce(tp -> 'cms', '[]')) loop
          n := n + 1; w_it := w_it || jsonb_build_object('ci', ci, 'ti', ti, 'pos', n, 'topic_id', x #>> '{}');
        end loop;
      end loop;
    end loop;

    -- ids: each once, of this course, active
    select w.id into bad from jsonb_to_recordset(w_ch) w(id text) where w.id is not null group by w.id having count(*) > 1 limit 1;
    if found then raise exception 'Display chapter % is listed twice.', bad; end if;
    select w.id into bad from jsonb_to_recordset(w_tp) w(id text) where w.id is not null group by w.id having count(*) > 1 limit 1;
    if found then raise exception 'Display topic % is listed twice.', bad; end if;
    select w.id into bad from jsonb_to_recordset(w_ch) w(id text)
     where w.id is not null and not exists (select 1 from cms.cms_course_chapters c where c.course_chapter_id = w.id and c.course_id = cid and c.status = 'active') limit 1;
    if found then raise exception 'Display chapter % is not an active chapter of %.', bad, cid; end if;
    select w.id into bad from jsonb_to_recordset(w_tp) w(id text)
     where w.id is not null and not exists (select 1 from cms.cms_course_topics t where t.course_topic_id = w.id and t.course_id = cid and t.status = 'active') limit 1;
    if found then raise exception 'Display topic % is not an active topic of %.', bad, cid; end if;

    -- CMS topics: once per course, exist, normal, of the subject; a newly placed one must be active
    select w.topic_id, string_agg(w.ci || '.' || w.ti, ' and ' order by w.ci, w.ti) into bad, bad2
      from jsonb_to_recordset(w_it) w(ci int, ti int, topic_id text) group by w.topic_id having count(*) > 1 limit 1;
    if found then raise exception 'CMS topic % is used twice in this course (%).', bad, bad2; end if;
    select w.topic_id into bad from jsonb_to_recordset(w_it) w(topic_id text) where not exists (select 1 from cms.cms_topics t where t.topic_id = w.topic_id) limit 1;
    if found then raise exception 'CMS topic % does not exist.', bad; end if;
    select w.topic_id into bad from jsonb_to_recordset(w_it) w(topic_id text) join cms.cms_topics t on t.topic_id = w.topic_id where t.topic_kind <> 'normal' limit 1;
    if found then raise exception '% is an Achievers topic; Achievers go in the chapter''s Achievers section.', bad; end if;
    select w.topic_id into bad from jsonb_to_recordset(w_it) w(topic_id text) join cms.cms_topics t on t.topic_id = w.topic_id
      join cms.cms_chapters c on c.chapter_id = t.chapter_id where c.subject <> crs.subject limit 1;
    if found then raise exception 'CMS topic % is not a % topic.', bad, crs.subject; end if;
    select w.topic_id into bad from jsonb_to_recordset(w_it) w(topic_id text) join cms.cms_topics t on t.topic_id = w.topic_id
     where t.status <> 'active' and not exists (select 1 from cms.cms_course_topic_items i where i.course_id = cid and i.topic_id = w.topic_id and i.removed_at is null) limit 1;
    if found then raise exception 'CMS topic % is retired; it can''t be placed.', bad; end if;

    -- Achievers chapters: Math only, once per course, exist, of the subject
    if crs.subject <> 'math' and jsonb_array_length(w_ac) > 0 then raise exception 'Science has no Achievers topics yet; Achievers sections are for Math courses.'; end if;
    select w.chapter_id, string_agg(w.ci::text, ' and ' order by w.ci) into bad, bad2
      from jsonb_to_recordset(w_ac) w(ci int, chapter_id text) group by w.chapter_id having count(*) > 1 limit 1;
    if found then raise exception 'CMS chapter %''s Achievers are used twice in this course (chapters %).', bad, bad2; end if;
    select w.chapter_id into bad from jsonb_to_recordset(w_ac) w(chapter_id text) where not exists (select 1 from cms.cms_chapters c where c.chapter_id = w.chapter_id) limit 1;
    if found then raise exception 'CMS chapter % does not exist.', bad; end if;
    select w.chapter_id into bad from jsonb_to_recordset(w_ac) w(chapter_id text) join cms.cms_chapters c on c.chapter_id = w.chapter_id where c.subject <> crs.subject limit 1;
    if found then raise exception 'CMS chapter % is not a % chapter.', bad, crs.subject; end if;

    -- ---------------------------------------------------------- apply: chapters
    lock table cms.cms_course_chapters in share row exclusive mode;
    lock table cms.cms_course_topics in share row exclusive mode;
    for r in select * from jsonb_to_recordset(w_ch) w(ci int, id text, name text) order by w.ci loop
      if r.id is null then
        select coalesce(max(substr(c.course_chapter_id, 4)::int), 0) + 1 into n from cms.cms_course_chapters c;
        chid := 'DCH' || lpad(n::text, 4, '0');
        insert into cms.cms_course_chapters (course_chapter_id, course_id, position, name) values (chid, cid, r.ci, r.name);
        insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
          values ('course', 'cms_course_chapters', chid, 'create', why,
                  jsonb_build_object('chapter', jsonb_build_object('before', null, 'after', jsonb_build_object('course_id', cid, 'name', r.name, 'position', r.ci))), uid, 'Sambit');
        k_ch_new := k_ch_new + 1;
      else
        chid := r.id;
        select jsonb_build_object('name', c.name, 'position', c.position) into b from cms.cms_course_chapters c where c.course_chapter_id = chid for update;
        a := jsonb_build_object('name', r.name, 'position', r.ci);
        if a is distinct from b then
          update cms.cms_course_chapters c set name = r.name, position = r.ci, updated_at = now() where c.course_chapter_id = chid;
          select coalesce(jsonb_object_agg(k.key, jsonb_build_object('before', b -> k.key, 'after', a -> k.key)), '{}') into d
            from jsonb_object_keys(a) k(key) where (a -> k.key) is distinct from (b -> k.key);
          insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
            values ('course', 'cms_course_chapters', chid, 'course_save', why, d, uid, 'Sambit');
          k_ch_chg := k_ch_chg + 1;
        end if;
      end if;
      ch_ids := ch_ids || chid;
    end loop;

    -- ---------------------------------------------------------- apply: topics (new, renamed, moved)
    for r in select * from jsonb_to_recordset(w_tp) w(ci int, ti int, id text, name text) order by w.ci, w.ti loop
      chid := ch_ids[r.ci];
      if r.id is null then
        select coalesce(max(substr(t.course_topic_id, 4)::int), 0) + 1 into n from cms.cms_course_topics t;
        tpid := 'DTP' || lpad(n::text, 5, '0');
        insert into cms.cms_course_topics (course_topic_id, course_id, course_chapter_id, position, name) values (tpid, cid, chid, r.ti, r.name);
        insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
          values ('course', 'cms_course_topics', tpid, 'create', why,
                  jsonb_build_object('topic', jsonb_build_object('before', null, 'after', jsonb_build_object('course_chapter_id', chid, 'name', r.name, 'position', r.ti))), uid, 'Sambit');
        k_tp_new := k_tp_new + 1;
      else
        tpid := r.id;
        select jsonb_build_object('course_chapter_id', t.course_chapter_id, 'name', t.name, 'position', t.position) into b from cms.cms_course_topics t where t.course_topic_id = tpid for update;
        a := jsonb_build_object('course_chapter_id', chid, 'name', r.name, 'position', r.ti);
        if a is distinct from b then
          update cms.cms_course_topics t set course_chapter_id = chid, name = r.name, position = r.ti, updated_at = now() where t.course_topic_id = tpid;
          select coalesce(jsonb_object_agg(k.key, jsonb_build_object('before', b -> k.key, 'after', a -> k.key)), '{}') into d
            from jsonb_object_keys(a) k(key) where (a -> k.key) is distinct from (b -> k.key);
          insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
            values ('course', 'cms_course_topics', tpid, 'course_save', why, d, uid, 'Sambit');
          k_tp_chg := k_tp_chg + 1;
        end if;
      end if;
      tp_ids := tp_ids || jsonb_build_object(r.ci || '.' || r.ti, tpid);
    end loop;

    -- ---------------------------------------------------------- CMS-topic links (audited per display topic)
    -- before: every active display topic's list (incl. ones about to be retired)
    select coalesce(jsonb_object_agg(t.course_topic_id, cms.cms_course_items_state(t.course_topic_id)), '{}') into b
      from cms.cms_course_topics t where t.course_id = cid and t.status = 'active';
    -- removed: active links whose CMS topic is no longer wanted anywhere
    update cms.cms_course_topic_items i set removed_at = now(), position = null
     where i.course_id = cid and i.removed_at is null
       and not exists (select 1 from jsonb_to_recordset(w_it) w(topic_id text) where w.topic_id = i.topic_id);
    -- kept (maybe moved to another display topic / position) and new
    for r in select * from jsonb_to_recordset(w_it) w(ci int, ti int, pos int, topic_id text) loop
      tpid := tp_ids ->> (r.ci || '.' || r.ti);
      update cms.cms_course_topic_items i set course_topic_id = tpid, position = r.pos
       where i.course_id = cid and i.topic_id = r.topic_id and i.removed_at is null
         and (i.course_topic_id, i.position) is distinct from (tpid, r.pos);
      if not exists (select 1 from cms.cms_course_topic_items i where i.course_id = cid and i.topic_id = r.topic_id and i.removed_at is null) then
        insert into cms.cms_course_topic_items (course_id, course_topic_id, position, topic_id) values (cid, tpid, r.pos, r.topic_id);
      end if;
    end loop;

    -- ---------------------------------------------------------- retire display topics and chapters that were left out
    for r in select t.course_topic_id, t.name, t.position, t.course_chapter_id from cms.cms_course_topics t
              where t.course_id = cid and t.status = 'active'
                and not exists (select 1 from jsonb_each_text(tp_ids) m where m.value = t.course_topic_id) loop
      if exists (select 1 from cms.cms_course_topic_items i where i.course_topic_id = r.course_topic_id and i.removed_at is null) then
        raise exception 'Display topic % is left out but still holds CMS topics.', r.course_topic_id;   -- cannot happen: its links were moved or removed above
      end if;
      update cms.cms_course_topics t set status = 'retired', position = null, updated_at = now() where t.course_topic_id = r.course_topic_id;
      insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
        values ('course', 'cms_course_topics', r.course_topic_id, 'retire', why,
                jsonb_build_object('topic', jsonb_build_object('before', jsonb_build_object('course_chapter_id', r.course_chapter_id, 'name', r.name, 'position', r.position, 'status', 'active'),
                                                               'after', jsonb_build_object('status', 'retired'))), uid, 'Sambit');
      k_tp_ret := k_tp_ret + 1;
    end loop;

    -- link audit: one row per display topic whose list changed
    for r in select k.tid, coalesce(b -> k.tid, '[]'::jsonb) as before_l, cms.cms_course_items_state(k.tid) as after_l
               from (select jsonb_object_keys(b) as tid
                     union select x.course_topic_id from cms.cms_course_topics x where x.course_id = cid and x.status = 'active') k loop
      if r.before_l is distinct from r.after_l then
        insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
          values ('course', 'cms_course_topic_items', r.tid, 'course_save', why,
                  jsonb_build_object('cms_topics', jsonb_build_object('before', r.before_l, 'after', r.after_l)), uid, 'Sambit');
        k_it := k_it + 1;
      end if;
    end loop;

    -- ---------------------------------------------------------- Achievers links (audited per display chapter)
    select coalesce(jsonb_object_agg(c.course_chapter_id, cms.cms_course_achievers_state(c.course_chapter_id)), '{}') into b
      from cms.cms_course_chapters c where c.course_id = cid and c.status = 'active';
    update cms.cms_course_achievers x set removed_at = now(), position = null
     where x.course_id = cid and x.removed_at is null
       and not exists (select 1 from jsonb_to_recordset(w_ac) w(chapter_id text) where w.chapter_id = x.chapter_id);
    for r in select * from jsonb_to_recordset(w_ac) w(ci int, pos int, chapter_id text) loop
      chid := ch_ids[r.ci];
      update cms.cms_course_achievers x set course_chapter_id = chid, position = r.pos
       where x.course_id = cid and x.chapter_id = r.chapter_id and x.removed_at is null
         and (x.course_chapter_id, x.position) is distinct from (chid, r.pos);
      if not exists (select 1 from cms.cms_course_achievers x where x.course_id = cid and x.chapter_id = r.chapter_id and x.removed_at is null) then
        insert into cms.cms_course_achievers (course_id, course_chapter_id, position, chapter_id) values (cid, chid, r.pos, r.chapter_id);
      end if;
    end loop;

    for r in select c.course_chapter_id, c.name, c.position from cms.cms_course_chapters c
              where c.course_id = cid and c.status = 'active' and not (c.course_chapter_id = any (ch_ids)) loop
      if exists (select 1 from cms.cms_course_topics t where t.course_chapter_id = r.course_chapter_id and t.status = 'active') then
        raise exception 'Display chapter % is left out but its display topics are not; move or remove them too.', r.course_chapter_id;
      end if;
      update cms.cms_course_chapters c set status = 'retired', position = null, updated_at = now() where c.course_chapter_id = r.course_chapter_id;
      insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
        values ('course', 'cms_course_chapters', r.course_chapter_id, 'retire', why,
                jsonb_build_object('chapter', jsonb_build_object('before', jsonb_build_object('name', r.name, 'position', r.position, 'status', 'active'),
                                                                 'after', jsonb_build_object('status', 'retired'))), uid, 'Sambit');
      k_ch_ret := k_ch_ret + 1;
    end loop;

    for r in select k.cid2, coalesce(b -> k.cid2, '[]'::jsonb) as before_l, cms.cms_course_achievers_state(k.cid2) as after_l
               from (select jsonb_object_keys(b) as cid2
                     union select y.course_chapter_id from cms.cms_course_chapters y where y.course_id = cid and y.status = 'active') k loop
      if r.before_l is distinct from r.after_l then
        insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
          values ('course', 'cms_course_achievers', r.cid2, 'course_save', why,
                  jsonb_build_object('achievers', jsonb_build_object('before', r.before_l, 'after', r.after_l)), uid, 'Sambit');
        k_ac := k_ac + 1;
      end if;
    end loop;
  end if;

  -- ------------------------------------------------------------ upload record, summary row, rev
  if src = 'upload' then
    insert into cms.cms_imports (kind, file_path, file_hash, options, finished_at, result, counts)
      values ('course_upload', coalesce(nullif(p #>> '{file,name}', ''), '(browser upload)'), coalesce(nullif(p #>> '{file,sha256}', ''), '-'),
              jsonb_build_object('course_id', cid, 'new_course', is_new), now(), 'ok',
              jsonb_build_object('chapters_new', k_ch_new, 'chapters_changed', k_ch_chg, 'chapters_retired', k_ch_ret,
                                 'topics_new', k_tp_new, 'topics_changed', k_tp_chg, 'topics_retired', k_tp_ret, 'topic_links_changed', k_it, 'achievers_changed', k_ac))
      returning import_id into imp;
  end if;
  update cms.cms_courses x set rev = x.rev + 1, updated_at = now() where x.course_id = cid returning * into crs;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label, import_id)
    values ('course', 'cms_courses', cid,
            case src when 'upload' then 'course_upload' when 'clone' then 'course_clone' when 'start_from' then 'course_copy' else 'course_save' end,
            coalesce(why, case src when 'form' then 'Saved in the course builder' else src end),
            jsonb_build_object('summary', jsonb_build_object('source', src, 'chapters_new', k_ch_new, 'chapters_changed', k_ch_chg, 'chapters_retired', k_ch_ret,
                                 'topics_new', k_tp_new, 'topics_changed', k_tp_chg, 'topics_retired', k_tp_ret, 'topic_links_changed', k_it, 'achievers_changed', k_ac)),
            uid, 'Sambit', imp);
  return jsonb_build_object('course_id', cid, 'rev', crs.rev, 'new', is_new, 'import_id', imp,
                            'chapters', jsonb_build_object('new', k_ch_new, 'changed', k_ch_chg, 'retired', k_ch_ret),
                            'topics', jsonb_build_object('new', k_tp_new, 'changed', k_tp_chg, 'retired', k_tp_ret),
                            'topic_links_changed', k_it, 'achievers_changed', k_ac);
end;
$$;
revoke execute on function cms.cms_save_course(jsonb) from public;
grant execute on function cms.cms_save_course(jsonb) to authenticated;

-- ---------------------------------------------------------------- the structural (✗) problems of a course
-- Each is a reason Publish is refused. Same rules as shared/course-checks.ts (errors).
create function cms.cms_course_errors(p_course text)
  returns table (kind text, ref text, detail text)
  language sql
  stable
  set search_path = ''
as $$
  select 'no_chapters', c.course_id, 'The course has no display chapters'
    from cms.cms_courses c where c.course_id = p_course
     and not exists (select 1 from cms.cms_course_chapters x where x.course_id = c.course_id and x.status = 'active')
  union all
  select 'chapter_empty', ch.course_chapter_id, ch.position || '. ' || ch.name
    from cms.cms_course_chapters ch where ch.course_id = p_course and ch.status = 'active'
     and not exists (select 1 from cms.cms_course_topics t where t.course_chapter_id = ch.course_chapter_id and t.status = 'active')
  union all
  select 'topic_empty', t.course_topic_id, ch.position || '.' || t.position || ' ' || t.name
    from cms.cms_course_topics t join cms.cms_course_chapters ch on ch.course_chapter_id = t.course_chapter_id
   where t.course_id = p_course and t.status = 'active'
     and not exists (select 1 from cms.cms_course_topic_items i where i.course_topic_id = t.course_topic_id and i.removed_at is null)
  union all
  select 'topic_retired', i.topic_id, ch.position || '.' || t.position || ' ' || t.name
    from cms.cms_course_topic_items i join cms.cms_course_topics t on t.course_topic_id = i.course_topic_id
    join cms.cms_course_chapters ch on ch.course_chapter_id = t.course_chapter_id
    join cms.cms_topics x on x.topic_id = i.topic_id
   where i.course_id = p_course and i.removed_at is null and x.status <> 'active'
  union all
  select 'achievers_missing', 'ACH-' || a.chapter_id || '-' || c.class, ch.position || '. ' || ch.name
    from cms.cms_course_achievers a join cms.cms_courses c on c.course_id = a.course_id
    join cms.cms_course_chapters ch on ch.course_chapter_id = a.course_chapter_id
   where a.course_id = p_course and a.removed_at is null
     and not exists (select 1 from cms.cms_topics x where x.topic_id = 'ACH-' || a.chapter_id || '-' || c.class and x.status = 'active');
$$;
revoke execute on function cms.cms_course_errors(text) from public;
grant execute on function cms.cms_course_errors(text) to authenticated;

-- ---------------------------------------------------------------- status: Publish · Back to draft · Retire · Restore
-- p = { course_id, rev, status: 'published' | 'draft' | 'retired', reason? }
create function cms.cms_set_course_status(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  crs cms.cms_courses;
  want text := p ->> 'status';
  e record;
begin
  if not cms.cms_is_admin(uid) then raise exception 'Only the CMS admin can change courses.' using errcode = '42501'; end if;
  select * into crs from cms.cms_courses x where x.course_id = p ->> 'course_id' for update;
  if not found then raise exception 'Course % does not exist.', p ->> 'course_id'; end if;
  if (p ->> 'rev') is null or (p ->> 'rev')::int <> crs.rev then raise exception 'Course % was changed since you opened it. Reload and try again.', crs.course_id; end if;
  if want not in ('draft', 'published', 'retired') then raise exception 'Unknown status "%".', want; end if;
  if want = crs.status then return jsonb_build_object('course_id', crs.course_id, 'rev', crs.rev, 'changed', false); end if;
  if want = 'published' then
    if crs.status <> 'draft' then raise exception 'Only a draft can be published (this course is %).', crs.status; end if;
    select * into e from cms.cms_course_errors(crs.course_id) limit 1;
    if found then raise exception 'Can''t publish: % (%). Fix the ✗ checks first.', replace(e.kind, '_', ' '), e.detail; end if;
  end if;
  if want = 'draft' and crs.status = 'retired'
     and exists (select 1 from cms.cms_courses x where lower(x.name) = lower(crs.name) and x.status <> 'retired' and x.course_id <> crs.course_id) then
    raise exception 'Another course is now called "%"; rename it before restoring this one.', crs.name;
  end if;
  update cms.cms_courses x set status = want, rev = x.rev + 1, updated_at = now(),
         published_at = case when want = 'published' then now() else x.published_at end
   where x.course_id = crs.course_id;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('course', 'cms_courses', crs.course_id, 'course_status',
            coalesce(nullif(btrim(coalesce(p ->> 'reason', '')), ''), case want when 'published' then 'Publish' when 'retired' then 'Retire'
                     else case crs.status when 'retired' then 'Restore' else 'Back to draft' end end),
            jsonb_build_object('status', jsonb_build_object('before', crs.status, 'after', want)), uid, 'Sambit');
  return jsonb_build_object('course_id', crs.course_id, 'rev', crs.rev + 1, 'changed', true);
end;
$$;
revoke execute on function cms.cms_set_course_status(jsonb) from public;
grant execute on function cms.cms_set_course_status(jsonb) to authenticated;

-- ---------------------------------------------------------------- Start from: a new draft copied from another course
-- p = { from_course, course: { name, board_id, class }, reason? }  (subject = the source's)
create function cms.cms_copy_course(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  src cms.cms_courses;
  outline jsonb;
begin
  if not cms.cms_is_admin(cms.cms_current_uid()) then raise exception 'Only the CMS admin can change courses.' using errcode = '42501'; end if;
  select * into src from cms.cms_courses x where x.course_id = p ->> 'from_course';
  if not found then raise exception 'Course % does not exist.', p ->> 'from_course'; end if;
  select jsonb_build_object('chapters', coalesce(jsonb_agg(jsonb_build_object(
           'name', ch.name,
           'achievers', (select coalesce(jsonb_agg(a.chapter_id order by a.position), '[]') from cms.cms_course_achievers a where a.course_chapter_id = ch.course_chapter_id and a.removed_at is null),
           'topics', (select coalesce(jsonb_agg(jsonb_build_object('name', t.name,
                        'cms', (select coalesce(jsonb_agg(i.topic_id order by i.position), '[]') from cms.cms_course_topic_items i where i.course_topic_id = t.course_topic_id and i.removed_at is null))
                        order by t.position), '[]') from cms.cms_course_topics t where t.course_chapter_id = ch.course_chapter_id and t.status = 'active'))
         order by ch.position), '[]'))
    into outline from cms.cms_course_chapters ch where ch.course_id = src.course_id and ch.status = 'active';
  return cms.cms_save_course(jsonb_build_object(
    'source', 'start_from', 'from_course', src.course_id,
    'reason', coalesce(nullif(btrim(coalesce(p ->> 'reason', '')), ''), 'Started from ' || src.course_id || ' (' || src.name || ')'),
    'course', (coalesce(p -> 'course', '{}'::jsonb) - 'subject') || jsonb_build_object('subject', src.subject),
    'outline', outline));
end;
$$;
revoke execute on function cms.cms_copy_course(jsonb) from public;
grant execute on function cms.cms_copy_course(jsonb) to authenticated;

-- ---------------------------------------------------------------- views (security invoker: RLS applies through them)
-- Questions per CMS topic and Level (counted = production, not retired, not rejected-only; gold never counts).
-- A course sums the rows with level ≤ its class.
create view cms.cms_topic_level_counts with (security_invoker = true) as
select l.topic_id, l.effective_level as level,
       count(*)::int as n_questions,
       (count(*) filter (where l.approved_version is not null))::int as n_approved
  from cms.cms_question_list l
 where l.counted
 group by l.topic_id, l.effective_level;

create view cms.cms_course_list with (security_invoker = true) as
select c.course_id, c.name, c.board_id, b.label as board_label, b.book, c.class, c.subject, c.status, c.rev, c.started_from,
       c.created_at, c.updated_at, c.published_at,
       (select count(*) from cms.cms_course_chapters x where x.course_id = c.course_id and x.status = 'active')::int as n_chapters,
       (select count(*) from cms.cms_course_topics x where x.course_id = c.course_id and x.status = 'active')::int as n_topics,
       (select count(*) from cms.cms_course_topic_items x where x.course_id = c.course_id and x.removed_at is null)::int as n_cms_topics
  from cms.cms_courses c join cms.cms_course_boards b on b.board_id = c.board_id;

grant select on cms.cms_topic_level_counts, cms.cms_course_list to authenticated;

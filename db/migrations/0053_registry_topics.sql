-- English (Grammar) E1 (plan docs/plan-2026-11-28-english-grammar.md §1–§2; Sambit 28 Nov 2026). Schema cms only; adds only.
--
--  Registry  cms_key_reservations gains kind 'topic' (prefix GT | MT | ST: the next topic numbers after every stored or
--            reserved one) and 'grammar_concept' (prefix a Grammar topic ID: its next concept numbers C01–C99).
--            cms_reserve_keys / cms_key_reservation_json handle them; the CMS's own topic numbering skips open
--            reservations (cms_next_free_in).
--  Topics    cms_save_curriculum, re-created from its live body with only these changes (re-derived by tests/grammar-sync.db.test.ts):
--            · create takes fields.topic_id when it is in an open topic reservation of that subject's prefix; a
--              reservation whose numbers all exist is closed as used (audited);
--            · without one it mints max + 1, skipping reserved numbers;
--            · update may change the home class (fields.class; not for an Achievers row), audited before → after;
--            · optional p.by_label for the audit row (default 'Sambit'), e.g. 'grammar:sync r30'.
--  Nothing is deleted; existing IDs never change.

alter table cms.cms_key_reservations drop constraint cms_key_reservations_kind_check;
alter table cms.cms_key_reservations add constraint cms_key_reservations_kind_check check (kind in ('file_key', 'block', 'topic', 'grammar_concept'));
alter table cms.cms_key_reservations drop constraint cms_key_reservations_prefix_check;
alter table cms.cms_key_reservations add constraint cms_key_reservations_prefix_check check (
  (kind = 'file_key' and prefix ~ '^(MC|SC|GC)[0-9]{2}$') or (kind = 'topic' and prefix in ('GT', 'MT', 'ST'))
  or (kind = 'grammar_concept' and prefix ~ '^GT[0-9]{4}$') or (kind = 'block' and prefix is null));
alter table cms.cms_key_reservations drop constraint cms_key_reservations_check;
alter table cms.cms_key_reservations add constraint cms_key_reservations_check check ((kind <> 'block') = (prefix is not null) and (kind = 'block') = (block_no is not null));
alter table cms.cms_key_reservations add constraint cms_key_reservations_topic_range check (kind <> 'topic' or (first_no >= 1 and last_no <= 9999));
alter table cms.cms_key_reservations add constraint cms_key_reservations_concept_range check (kind <> 'grammar_concept' or (first_no >= 1 and last_no <= 99));
drop index cms.cms_key_reservations_prefix;
create index cms_key_reservations_prefix on cms.cms_key_reservations (kind, prefix, last_no) where prefix is not null;

/** n, or the first number after any open reservation of this kind and prefix that n falls into (topic numbers). */
create function cms.cms_next_free_in(k text, pre text, n int)
  returns int
  language plpgsql
  stable
  set search_path = ''
as $$
declare
  hi int;
begin
  loop
    select r.last_no into hi from cms.cms_key_reservations r
     where r.kind = k and r.prefix = pre and r.status = 'reserved' and n between r.first_no and r.last_no limit 1;
    exit when not found;
    n := hi + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function cms.cms_next_free_in(text, text, int) from public;

/** Close (as used, audited) every open topic reservation of this prefix whose numbers all exist as topics. */
create function cms.cms_close_used_topic_reservations(pre text)
  returns void
  language plpgsql
  set search_path = ''
as $$
declare
  r cms.cms_key_reservations;
begin
  for r in select * from cms.cms_key_reservations x where x.kind = 'topic' and x.prefix = pre and x.status = 'reserved'
             and not exists (select 1 from generate_series(x.first_no, x.last_no) g
                              where not exists (select 1 from cms.cms_topics t where t.topic_id = pre || lpad(g::text, 4, '0')))
           for update loop
    update cms.cms_key_reservations set status = 'used', closed_at = now(), note = coalesce(note, 'all topics created') where reservation_id = r.reservation_id;
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
      values ('keys', 'cms_key_reservations', r.reservation_id::text, 'keys_close', 'all reserved topics created',
              jsonb_build_object('status', jsonb_build_object('before', 'reserved', 'after', 'used')), cms.cms_current_uid(), 'cms_save_curriculum');
  end loop;
end;
$$;
revoke execute on function cms.cms_close_used_topic_reservations(text) from public;

-- ---------------------------------------------------------------- reservations: the new kinds (0052 bodies + the branches)
create or replace function cms.cms_key_reservation_json(r cms.cms_key_reservations)
  returns jsonb
  language sql
  stable
  set search_path = ''
as $$
  select jsonb_build_object('reservation_id', r.reservation_id, 'kind', r.kind, 'status', r.status, 'purpose', r.purpose, 'source', r.source,
    'reserved_by', r.reserved_by, 'created_at', r.created_at, 'closed_at', r.closed_at, 'note', r.note)
    || case when r.kind = 'topic' then jsonb_build_object('prefix', r.prefix, 'first', r.prefix || lpad(r.first_no::text, 4, '0'),
                                                           'last', r.prefix || lpad(r.last_no::text, 4, '0'), 'count', r.last_no - r.first_no + 1)
            when r.kind = 'grammar_concept' then jsonb_build_object('prefix', r.prefix, 'first', r.prefix || '-C' || lpad(r.first_no::text, 2, '0'),
                                                           'last', r.prefix || '-C' || lpad(r.last_no::text, 2, '0'), 'count', r.last_no - r.first_no + 1)
            when r.kind = 'file_key' then jsonb_build_object('prefix', r.prefix, 'first', r.prefix || '-' || lpad(r.first_no::text, 4, '0'),
                                                              'last', r.prefix || '-' || lpad(r.last_no::text, 4, '0'), 'count', r.last_no - r.first_no + 1)
       else jsonb_build_object('block', r.block_no, 'patterns', 'MP' || lpad(r.first_no::text, 4, '0') || '–MP' || lpad(r.last_no::text, 4, '0'),
                               'concepts', 'C' || r.block_no || '01–C' || r.block_no || '99', 'misconceptions', r.block_no || '01–' || r.block_no || '99') end;
$$;

create or replace function cms.cms_reserve_keys(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  who text := cms.cms_gen_caller();
  k text := p ->> 'kind';
  pre text := upper(btrim(coalesce(p ->> 'prefix', '')));   -- 0053: also GT/MT/ST (topic) and a GT topic ID (grammar_concept)
  cnt int := coalesce((p ->> 'count')::int, 0);
  purpose text := btrim(coalesce(p ->> 'purpose', ''));
  first int;
  b int;
  r cms.cms_key_reservations;
begin
  if who is null then raise exception 'Only the CMS admin or a Mac script session can reserve keys.' using errcode = '42501'; end if;
  if purpose = '' then raise exception 'A reservation needs a purpose (book, chapter, worker).'; end if;
  if k = 'file_key' then
    if pre !~ '^(MC|SC|GC)[0-9]{2}$' then raise exception 'File keys are reserved per chapter prefix (e.g. MC19), not %.', coalesce(nullif(pre, ''), 'nothing'); end if;
    if cnt < 1 or cnt > 500 then raise exception 'Reserve 1 to 500 file keys at a time (got %).', cnt; end if;
    perform pg_advisory_xact_lock(hashtext('cms_keys:file_key:' || pre));
    first := greatest(
      (select max(substring(q.file_key from '-([0-9]+)$')::int) from cms.cms_questions q
        where q.file_key like pre || '-%' and substring(q.file_key from '-([0-9]+)$')::int < 5000),
      (select max(substring(h.file_key from '-([0-9]+)$')::int) from cms.cms_held_out h
        where h.file_key like pre || '-%' and substring(h.file_key from '-([0-9]+)$')::int < 5000),   -- held-out keys stay taken
      (select max(x.last_no) from cms.cms_key_reservations x where x.kind = 'file_key' and x.prefix = pre),
      coalesce((p ->> 'at_least')::int, 1) - 1,
      0) + 1;
    if first + cnt - 1 > 4999 then raise exception 'Chapter % has no % free book-pipeline keys left below 5000 (next is %).', pre, cnt, first; end if;
    insert into cms.cms_key_reservations (kind, prefix, first_no, last_no, purpose, reserved_by)
      values ('file_key', pre, first, first + cnt - 1, purpose, coalesce(nullif(btrim(p ->> 'by'), ''), who)) returning * into r;
  elsif k = 'block' then
    perform pg_advisory_xact_lock(hashtext('cms_keys:block'));
    b := cms.cms_key_block_floor() + 1;
    if b > 199 then raise exception 'No id block is left (MP numbers have 4 digits; block 199 is the last).'; end if;
    insert into cms.cms_key_reservations (kind, block_no, first_no, last_no, purpose, reserved_by)
      values ('block', b, b * 50, b * 50 + 49, purpose, coalesce(nullif(btrim(p ->> 'by'), ''), who)) returning * into r;
  elsif k = 'topic' then
    if pre not in ('GT', 'MT', 'ST') then raise exception 'Topic IDs are reserved per subject prefix GT, MT or ST, not %.', coalesce(nullif(pre, ''), 'nothing'); end if;
    if cnt < 1 or cnt > 100 then raise exception 'Reserve 1 to 100 topic IDs at a time (got %).', cnt; end if;
    perform pg_advisory_xact_lock(hashtext('cms_keys:topic:' || pre));
    first := greatest(
      (select max(substr(t.topic_id, 3)::int) from cms.cms_topics t where t.topic_id ~ ('^' || pre || '[0-9]{4}$')),
      (select max(x.last_no) from cms.cms_key_reservations x where x.kind = 'topic' and x.prefix = pre),
      0) + 1;
    if first + cnt - 1 > 9999 then raise exception 'No % free % topic IDs left (next is %).', cnt, pre, first; end if;
    insert into cms.cms_key_reservations (kind, prefix, first_no, last_no, purpose, reserved_by)
      values ('topic', pre, first, first + cnt - 1, purpose, coalesce(nullif(btrim(p ->> 'by'), ''), who)) returning * into r;
  elsif k = 'grammar_concept' then
    if pre !~ '^GT[0-9]{4}$' or not exists (select 1 from cms.cms_topics t join cms.cms_chapters c on c.chapter_id = t.chapter_id
                                             where t.topic_id = pre and c.subject = 'grammar') then
      raise exception 'Grammar concept numbers are reserved per Grammar topic (e.g. GT0049), not %.', coalesce(nullif(pre, ''), 'nothing');
    end if;
    if cnt < 1 or cnt > 99 then raise exception 'Reserve 1 to 99 concept numbers at a time (got %).', cnt; end if;
    perform pg_advisory_xact_lock(hashtext('cms_keys:grammar_concept:' || pre));
    first := greatest(
      (select max(substring(x.concept_id from '-C([0-9]{2})$')::int) from cms.cms_concepts x where x.concept_id like pre || '-C%'),
      (select max(x.last_no) from cms.cms_key_reservations x where x.kind = 'grammar_concept' and x.prefix = pre),
      0) + 1;
    if first + cnt - 1 > 99 then raise exception 'Topic % has no % free concept numbers left (next is C%).', pre, cnt, lpad(first::text, 2, '0'); end if;
    insert into cms.cms_key_reservations (kind, prefix, first_no, last_no, purpose, reserved_by)
      values ('grammar_concept', pre, first, first + cnt - 1, purpose, coalesce(nullif(btrim(p ->> 'by'), ''), who)) returning * into r;
  else
    raise exception 'Reservation kind % is not file_key, block, topic or grammar_concept.', coalesce(k, 'null');
  end if;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('keys', 'cms_key_reservations', r.reservation_id::text, 'keys_reserve', purpose, cms.cms_key_reservation_json(r),
            case when who = 'admin' then cms.cms_current_uid() end, r.reserved_by);
  return cms.cms_key_reservation_json(r);
end;
$$;

-- ---------------------------------------------------------------- cms_save_curriculum (generated from the live body; tests re-derive it)
CREATE OR REPLACE FUNCTION cms.cms_save_curriculum(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  uid uuid := cms.cms_current_uid();
  kind text := p ->> 'kind';
  act text := p ->> 'action';
  f jsonb := coalesce(p -> 'fields', '{}'::jsonb);
  rid text := p ->> 'id';
  reason text := nullif(btrim(coalesce(p ->> 'reason', '')), '');
  owner text;
  tbl text;
  b jsonb;               -- the row before
  a jsonb;               -- the row after
  links_b jsonb := null; -- topic classes / prerequisites before
  links_a jsonb := null;
  subj text; pre text; n int; cls int; code text; letter text; slug text;
  t cms.cms_topics;
  diff jsonb;
  audit_action text;
begin
  if not cms.cms_is_admin(uid) then
    raise exception 'Only the CMS admin can change the curriculum.' using errcode = '42501';
  end if;
  if act not in ('create', 'update', 'retire', 'restore') then raise exception 'Unknown action "%".', act; end if;
  if act <> 'create' and rid is null then raise exception 'Which % ? (id missing)', kind; end if;
  owner := coalesce((select c.value #>> '{}' from cms.cms_config c where c.key = 'curriculum_owner'), 'workbooks');
  if kind in ('chapter', 'topic') and owner <> 'cms'
     and not (kind = 'topic' and act = 'update' and (f - 'classes' - 'prereqs') = '{}'::jsonb) then
    raise exception 'Chapters and topics still come from the topic workbooks until the one-time cut-over (docs/curriculum-cutover.md). Topic classes and prerequisites can be edited now.';
  end if;

  -- ------------------------------------------------------------ chapter
  if kind = 'chapter' then
    tbl := 'cms_chapters';
    if act = 'create' then
      subj := f ->> 'subject';
      pre := case subj when 'math' then 'MC' when 'science' then 'SC' when 'grammar' then 'GC' end;
      if pre is null then raise exception 'Subject must be math, science or grammar.'; end if;
      if coalesce(btrim(f ->> 'name'), '') = '' then raise exception 'A chapter needs a name.'; end if;
      lock table cms.cms_chapters in share row exclusive mode;
      select coalesce(max(substr(c.chapter_id, 3)::int), 0) + 1 into n from cms.cms_chapters c where c.chapter_id like pre || '%';
      if n > 99 then raise exception 'No chapter numbers left for %.', subj; end if;
      rid := pre || lpad(n::text, 2, '0');
      insert into cms.cms_chapters (chapter_id, subject, strand_id, name, display_code, scope, sort)
        values (rid, subj, f ->> 'strand_id', btrim(f ->> 'name'), nullif(f ->> 'display_code', ''), nullif(f ->> 'scope', ''),
                coalesce((f ->> 'sort')::int, (select coalesce(max(c.sort), 0) + 1 from cms.cms_chapters c where c.subject = subj)));
    else
      select to_jsonb(c) into b from cms.cms_chapters c where c.chapter_id = rid for update;
      if b is null then raise exception 'Chapter % does not exist.', rid; end if;
      update cms.cms_chapters c set
        strand_id = case when f ? 'strand_id' then f ->> 'strand_id' else c.strand_id end,
        name = case when f ? 'name' then btrim(f ->> 'name') else c.name end,
        display_code = case when f ? 'display_code' then nullif(f ->> 'display_code', '') else c.display_code end,
        scope = case when f ? 'scope' then nullif(f ->> 'scope', '') else c.scope end,
        sort = case when f ? 'sort' then (f ->> 'sort')::int else c.sort end,
        status = case act when 'retire' then 'retired' when 'restore' then 'active' else c.status end
        where c.chapter_id = rid;
    end if;
    select to_jsonb(c) into a from cms.cms_chapters c where c.chapter_id = rid;

  -- ------------------------------------------------------------ topic (normal or Achievers)
  elsif kind = 'topic' then
    tbl := 'cms_topics';
    if act = 'create' then
      select c.subject into subj from cms.cms_chapters c where c.chapter_id = f ->> 'chapter_id';
      if subj is null then raise exception 'Chapter % does not exist.', f ->> 'chapter_id'; end if;
      cls := (f ->> 'class')::int;
      if cls is null or cls not between 1 and 6 then raise exception 'Class must be 1–6.'; end if;
      if coalesce(btrim(f ->> 'name'), '') = '' then raise exception 'A topic needs a name.'; end if;
      lock table cms.cms_topics in share row exclusive mode;
      if coalesce(f ->> 'topic_kind', 'normal') = 'achievers' then
        rid := 'ACH-' || (f ->> 'chapter_id') || '-' || cls;
        if exists (select 1 from cms.cms_topics x where x.topic_id = rid) then raise exception '% already exists (one Achievers row per chapter and class).', rid; end if;
      else
        pre := case subj when 'math' then 'MT' when 'science' then 'ST' else 'GT' end;
        if coalesce(btrim(f ->> 'topic_id'), '') <> '' then   -- 0053: an ID the key registry reserved (npm run keys -- reserve --kind topic)
          rid := btrim(f ->> 'topic_id');
          if rid !~ ('^' || pre || '[0-9]{4}$') or not exists (select 1 from cms.cms_key_reservations r where r.kind = 'topic' and r.prefix = pre
               and r.status = 'reserved' and substr(rid, 3)::int between r.first_no and r.last_no) then
            raise exception 'Topic ID % is not in an open % reservation (npm run keys -- reserve --kind topic --prefix %).', rid, pre, pre;
          end if;
          if exists (select 1 from cms.cms_topics x where x.topic_id = rid) then raise exception 'Topic % already exists.', rid; end if;
        else
          select coalesce(max(substr(x.topic_id, 3)::int), 0) + 1 into n from cms.cms_topics x where x.topic_id ~ ('^' || pre || '[0-9]{4}$');
          n := cms.cms_next_free_in('topic', pre, n);   -- 0053: skip numbers a reservation holds
          rid := pre || lpad(n::text, 4, '0');
        end if;
      end if;
      insert into cms.cms_topics (topic_id, chapter_id, class, seq, name, level, sub_skills, topic_kind, taught_in_school, source_flags, notes)
        values (rid, f ->> 'chapter_id', cls, (f ->> 'seq')::int, btrim(f ->> 'name'), (f ->> 'level')::int, nullif(f ->> 'sub_skills', ''),
                coalesce(f ->> 'topic_kind', 'normal'), coalesce((f ->> 'taught_in_school')::boolean, false), coalesce(f -> 'source_flags', '{}'::jsonb), nullif(f ->> 'notes', ''));
      if pre is not null then perform cms.cms_close_used_topic_reservations(pre); end if;   -- 0053
    else
      select to_jsonb(x) into b from cms.cms_topics x where x.topic_id = rid for update;
      if b is null then raise exception 'Topic % does not exist.', rid; end if;
      if f ? 'class' and ((f ->> 'class')::int is null or (f ->> 'class')::int not between 1 and 6) then raise exception 'Class must be 1–6.'; end if;   -- 0053
      if f ? 'class' and b ->> 'topic_kind' = 'achievers' then raise exception 'An Achievers row keeps its class.'; end if;   -- 0053
      update cms.cms_topics x set
        name = case when f ? 'name' then btrim(f ->> 'name') else x.name end,
        class = case when f ? 'class' then (f ->> 'class')::int else x.class end,   -- 0053: the home class (core); audited before → after
        seq = case when f ? 'seq' then (f ->> 'seq')::int else x.seq end,
        level = case when f ? 'level' then (f ->> 'level')::int else x.level end,
        sub_skills = case when f ? 'sub_skills' then nullif(f ->> 'sub_skills', '') else x.sub_skills end,
        taught_in_school = case when f ? 'taught_in_school' then (f ->> 'taught_in_school')::boolean else x.taught_in_school end,
        source_flags = case when f ? 'source_flags' then f -> 'source_flags' else x.source_flags end,
        notes = case when f ? 'notes' then nullif(f ->> 'notes', '') else x.notes end,
        status = case act when 'retire' then 'retired' when 'restore' then 'active' else x.status end
        where x.topic_id = rid;
    end if;
    select * into t from cms.cms_topics x where x.topic_id = rid;
    -- D2 classes and D4 prerequisites: the given list replaces the old one (link rows, audited)
    if f ? 'classes' or f ? 'prereqs' then
      select jsonb_build_object(
          'classes', coalesce((select jsonb_agg(jsonb_build_object('class', c.class, 'source', c.source, 'evidence', c.evidence) order by c.class) from cms.cms_topic_classes c where c.topic_id = rid), '[]'),
          'prereqs', coalesce((select jsonb_agg(r.prereq_topic_id order by r.prereq_topic_id) from cms.cms_topic_prereqs r where r.topic_id = rid), '[]'))
        into links_b;
    end if;
    if f ? 'classes' then
      if exists (select 1 from jsonb_array_elements(f -> 'classes') e where (e ->> 'class')::int not between 1 and 6 or coalesce(btrim(e ->> 'source'), '') = '') then
        raise exception 'Each class needs a class 1–6 and a source.';
      end if;
      delete from cms.cms_topic_classes c where c.topic_id = rid
        and c.class not in (select (e ->> 'class')::int from jsonb_array_elements(f -> 'classes') e);
      insert into cms.cms_topic_classes (topic_id, class, source, evidence)
        select rid, (e ->> 'class')::int, btrim(e ->> 'source'), nullif(e ->> 'evidence', '') from jsonb_array_elements(f -> 'classes') e
        on conflict (topic_id, class) do update set source = excluded.source, evidence = excluded.evidence, updated_at = now();
    end if;
    if f ? 'prereqs' then
      if exists (select 1 from jsonb_array_elements_text(f -> 'prereqs') x where not exists (select 1 from cms.cms_topics y where y.topic_id = x)) then
        raise exception 'A prerequisite is not a topic ID.';
      end if;
      if exists (select 1 from jsonb_array_elements_text(f -> 'prereqs') x where x = rid) then raise exception 'A topic cannot be its own prerequisite.'; end if;
      delete from cms.cms_topic_prereqs r where r.topic_id = rid and r.prereq_topic_id not in (select jsonb_array_elements_text(f -> 'prereqs'));
      insert into cms.cms_topic_prereqs (topic_id, prereq_topic_id) select rid, x from jsonb_array_elements_text(f -> 'prereqs') x on conflict do nothing;
    end if;
    if links_b is not null then
      select jsonb_build_object(
          'classes', coalesce((select jsonb_agg(jsonb_build_object('class', c.class, 'source', c.source, 'evidence', c.evidence) order by c.class) from cms.cms_topic_classes c where c.topic_id = rid), '[]'),
          'prereqs', coalesce((select jsonb_agg(r.prereq_topic_id order by r.prereq_topic_id) from cms.cms_topic_prereqs r where r.topic_id = rid), '[]'))
        into links_a;
    end if;
    a := to_jsonb(t);

  -- ------------------------------------------------------------ concept
  elsif kind = 'concept' then
    tbl := 'cms_concepts';
    if act = 'create' then
      select x.* into t from cms.cms_topics x where x.topic_id = f ->> 'topic_id';
      if t.topic_id is null then raise exception 'Topic % does not exist.', f ->> 'topic_id'; end if;
      select c.subject into subj from cms.cms_chapters c where c.chapter_id = t.chapter_id;
      cls := coalesce((f ->> 'class')::int, t.class);
      code := upper(btrim(coalesce(f ->> 'code', '')));
      if code !~ '^[A-Z]{2,4}$' then raise exception 'The concept code is 2–4 capital letters (e.g. FRC).'; end if;
      letter := case f ->> 'type' when 'applied' then 'A' else 'C' end;
      if coalesce(btrim(f ->> 'name'), '') = '' then raise exception 'A concept needs a name.'; end if;
      lock table cms.cms_concepts in share row exclusive mode;
      select coalesce(max(substring(x.concept_id from '[0-9]+$')::int), 0) + 1 into n from cms.cms_concepts x
        where x.concept_id ~ ('^G' || cls || '-' || code || '-' || letter || '[0-9]+$');
      n := cms.cms_next_free('concept', n);   -- 0052: skip numbers inside a block a pipeline holds (cms_key_reservations)
      rid := 'G' || cls || '-' || code || '-' || letter || n;
      insert into cms.cms_concepts (concept_id, subject, class, topic_id, name, type, description, includes, excludes, example_question, status)
        values (rid, subj, cls, t.topic_id, btrim(f ->> 'name'), coalesce(f ->> 'type', 'core'), nullif(f ->> 'description', ''), nullif(f ->> 'includes', ''),
                nullif(f ->> 'excludes', ''), nullif(f ->> 'example_question', ''), 'proposed');
    else
      select to_jsonb(x) into b from cms.cms_concepts x where x.concept_id = rid for update;
      if b is null then raise exception 'Concept % does not exist.', rid; end if;
      update cms.cms_concepts x set
        name = case when f ? 'name' then btrim(f ->> 'name') else x.name end,
        description = case when f ? 'description' then nullif(f ->> 'description', '') else x.description end,
        includes = case when f ? 'includes' then nullif(f ->> 'includes', '') else x.includes end,
        excludes = case when f ? 'excludes' then nullif(f ->> 'excludes', '') else x.excludes end,
        example_question = case when f ? 'example_question' then nullif(f ->> 'example_question', '') else x.example_question end,
        status = case act when 'retire' then 'retired' when 'restore' then 'proposed' else x.status end,
        updated_at = now()
        where x.concept_id = rid;
    end if;
    select to_jsonb(x) into a from cms.cms_concepts x where x.concept_id = rid;

  -- ------------------------------------------------------------ typical set (question type)
  elsif kind = 'typical_set' then
    tbl := 'cms_typical_sets';
    if act = 'create' then
      select x.* into t from cms.cms_topics x where x.topic_id = f ->> 'topic_id';
      if t.topic_id is null then raise exception 'Topic % does not exist.', f ->> 'topic_id'; end if;
      select c.subject into subj from cms.cms_chapters c where c.chapter_id = t.chapter_id;
      cls := coalesce((f ->> 'class')::int, t.class);
      if coalesce(btrim(f ->> 'name'), '') = '' then raise exception 'A question type needs a name.'; end if;
      slug := left(btrim(regexp_replace(upper(coalesce(nullif(f ->> 'slug', ''), f ->> 'name')), '[^A-Z0-9]+', '-', 'g'), '-'), 30);
      slug := btrim(slug, '-');
      if slug = '' then raise exception 'The question type name needs letters or digits.'; end if;
      lock table cms.cms_typical_sets in share row exclusive mode;
      rid := 'TS-G' || cls || '-' || slug;
      n := 1;
      while exists (select 1 from cms.cms_typical_sets x where x.typical_set_id = rid) loop
        n := n + 1; rid := 'TS-G' || cls || '-' || slug || '-' || n;
      end loop;
      insert into cms.cms_typical_sets (typical_set_id, subject, class, chapter_id, topic_id, name, instruction_pattern, variant_note, parent_visible, status)
        values (rid, subj, cls, t.chapter_id, t.topic_id, btrim(f ->> 'name'), nullif(f ->> 'instruction_pattern', ''), nullif(f ->> 'variant_note', ''),
                coalesce((f ->> 'parent_visible')::boolean, true), 'proposed');
    else
      select to_jsonb(x) into b from cms.cms_typical_sets x where x.typical_set_id = rid for update;
      if b is null then raise exception 'Question type % does not exist.', rid; end if;
      update cms.cms_typical_sets x set
        name = case when f ? 'name' then btrim(f ->> 'name') else x.name end,
        instruction_pattern = case when f ? 'instruction_pattern' then nullif(f ->> 'instruction_pattern', '') else x.instruction_pattern end,
        variant_note = case when f ? 'variant_note' then nullif(f ->> 'variant_note', '') else x.variant_note end,
        parent_visible = case when f ? 'parent_visible' then (f ->> 'parent_visible')::boolean else x.parent_visible end,
        status = case act when 'retire' then 'retired' when 'restore' then 'proposed' else x.status end,
        updated_at = now()
        where x.typical_set_id = rid;
    end if;
    select to_jsonb(x) into a from cms.cms_typical_sets x where x.typical_set_id = rid;

  -- ------------------------------------------------------------ pattern
  elsif kind = 'pattern' then
    tbl := 'cms_patterns';
    if act = 'create' then
      select x.* into t from cms.cms_topics x where x.topic_id = f ->> 'topic_id';
      if t.topic_id is null then raise exception 'Topic % does not exist.', f ->> 'topic_id'; end if;
      if not exists (select 1 from cms.cms_typical_sets s where s.typical_set_id = f ->> 'typical_set_id') then
        raise exception 'Question type % does not exist.', f ->> 'typical_set_id';
      end if;
      select c.subject into subj from cms.cms_chapters c where c.chapter_id = t.chapter_id;
      if coalesce(btrim(f ->> 'name'), '') = '' then raise exception 'A pattern needs a name.'; end if;
      pre := case subj when 'math' then 'MP' when 'science' then 'SP' else 'GP' end;
      lock table cms.cms_patterns in share row exclusive mode;
      select coalesce(max(substr(x.pattern_id, 3)::int), 0) + 1 into n from cms.cms_patterns x where x.pattern_id like pre || '%';
      if pre = 'MP' then n := cms.cms_next_free('pattern', n); end if;   -- 0052: skip MP numbers inside a held block
      rid := pre || lpad(n::text, 4, '0');
      insert into cms.cms_patterns (pattern_id, topic_id, typical_set_id, name, template, notes, status)
        values (rid, t.topic_id, f ->> 'typical_set_id', btrim(f ->> 'name'), nullif(f ->> 'template', ''), nullif(f ->> 'notes', ''), 'proposed');
    else
      select to_jsonb(x) into b from cms.cms_patterns x where x.pattern_id = rid for update;
      if b is null then raise exception 'Pattern % does not exist.', rid; end if;
      update cms.cms_patterns x set
        name = case when f ? 'name' then btrim(f ->> 'name') else x.name end,
        template = case when f ? 'template' then nullif(f ->> 'template', '') else x.template end,
        notes = case when f ? 'notes' then nullif(f ->> 'notes', '') else x.notes end,
        status = case act when 'retire' then 'retired' when 'restore' then 'proposed' else x.status end,
        updated_at = now()
        where x.pattern_id = rid;
    end if;
    select to_jsonb(x) into a from cms.cms_patterns x where x.pattern_id = rid;
  else
    raise exception 'Unknown curriculum kind "%".', kind;
  end if;

  -- audit: before → after of every changed field (updated_at left out)
  select coalesce(jsonb_object_agg(k, jsonb_build_object('before', coalesce(b, '{}'::jsonb) -> k, 'after', a -> k)), '{}'::jsonb) into diff
    from jsonb_object_keys(a) k
    where k <> 'updated_at' and (b is null or (b -> k) is distinct from (a -> k)) and (b is not null or a -> k <> 'null'::jsonb);
  if links_b is not null and links_b is distinct from links_a then
    if links_b -> 'classes' is distinct from links_a -> 'classes' then diff := diff || jsonb_build_object('classes', jsonb_build_object('before', links_b -> 'classes', 'after', links_a -> 'classes')); end if;
    if links_b -> 'prereqs' is distinct from links_a -> 'prereqs' then diff := diff || jsonb_build_object('prereqs', jsonb_build_object('before', links_b -> 'prereqs', 'after', links_a -> 'prereqs')); end if;
  end if;
  if act <> 'create' and diff = '{}'::jsonb then
    return jsonb_build_object('kind', kind, 'id', rid, 'action', act, 'changed', false);
  end if;
  audit_action := case act when 'create' then 'create' when 'retire' then 'retire' when 'restore' then 'restore' else 'edit_catalogue' end;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('catalogue', tbl, rid, audit_action, coalesce(reason, act || ' ' || kind), diff, uid, coalesce(nullif(btrim(p ->> 'by_label'), ''), 'Sambit'));   -- 0053: optional label
  return jsonb_build_object('kind', kind, 'id', rid, 'action', act, 'changed', true);
end;
$function$;

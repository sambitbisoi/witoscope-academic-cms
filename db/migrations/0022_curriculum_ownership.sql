-- D5 (Sambit, option B, 12 Nov 2026; docs/queue-2026-11-12.md): the CMS owns the curriculum.
-- Chapters, topics (Achievers rows included), concepts, typical sets and patterns are added and
-- edited in the CMS through ONE admin-checked, audited function, cms_save_curriculum:
--   * IDs are given by the CMS (next free number under a table lock) and never change;
--   * nothing is deleted: Retire hides a row and keeps its ID and history (Restore brings it back);
--   * every change writes cms_reviews with the before → after values;
--   * new concepts, typical sets and patterns start 'proposed';
--   * the topic screen also sets the topic's other classes (D2) and its prerequisites (D4).
-- One-time cut-over: until Sambit confirms the workbooks are final and the last workbook
-- import is done, cms_config.curriculum_owner = 'workbooks' and chapter / topic rows stay
-- read-only here (import:topics still owns them). Topic classes, prerequisites, concepts,
-- typical sets and patterns are CMS data and can be edited now. The switch is
-- `npm run curriculum:cutover` (docs/curriculum-cutover.md).
-- D7: sources are retired, never deleted (cms_sources.status).

insert into cms.cms_config (key, value, note) values
  ('curriculum_owner', '"workbooks"', 'Who owns chapters and topics: "workbooks" (import:topics) until the one-time cut-over, then "cms" (D5)')
on conflict (key) do nothing;

alter table cms.cms_sources add column status text not null default 'active' check (status in ('active', 'retired'));
alter table cms.cms_sources add column updated_at timestamptz not null default now();

create function cms.cms_save_curriculum(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
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
        select coalesce(max(substr(x.topic_id, 3)::int), 0) + 1 into n from cms.cms_topics x where x.topic_id ~ ('^' || pre || '[0-9]{4}$');
        rid := pre || lpad(n::text, 4, '0');
      end if;
      insert into cms.cms_topics (topic_id, chapter_id, class, seq, name, level, sub_skills, topic_kind, taught_in_school, source_flags, notes)
        values (rid, f ->> 'chapter_id', cls, (f ->> 'seq')::int, btrim(f ->> 'name'), (f ->> 'level')::int, nullif(f ->> 'sub_skills', ''),
                coalesce(f ->> 'topic_kind', 'normal'), coalesce((f ->> 'taught_in_school')::boolean, false), coalesce(f -> 'source_flags', '{}'::jsonb), nullif(f ->> 'notes', ''));
    else
      select to_jsonb(x) into b from cms.cms_topics x where x.topic_id = rid for update;
      if b is null then raise exception 'Topic % does not exist.', rid; end if;
      update cms.cms_topics x set
        name = case when f ? 'name' then btrim(f ->> 'name') else x.name end,
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
    values ('catalogue', tbl, rid, audit_action, coalesce(reason, act || ' ' || kind), diff, uid, 'Sambit');
  return jsonb_build_object('kind', kind, 'id', rid, 'action', act, 'changed', true);
end;
$$;

revoke execute on function cms.cms_save_curriculum(jsonb) from public;
grant execute on function cms.cms_save_curriculum(jsonb) to authenticated;

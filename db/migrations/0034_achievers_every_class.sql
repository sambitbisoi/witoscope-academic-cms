-- Achievers for every class a Math chapter is present in (Sambit, 14 Nov 2026). Schema cms only.
--
-- Rule: a Math chapter gets one Achievers topic per class it is present in. "Present in class N" = an ACTIVE
-- normal topic of the chapter has home class N, or an active normal topic of the chapter has an approved
-- topic–class link (a row in cms_topic_classes) to class N. Proposed links (cms_topic_class_proposals) do not count.
-- Achievers rows follow the existing convention: ACH-<chapter>-<class>, topic_kind 'achievers',
-- name "Achievers: <chapter name>", no seq, no ordering row (they always sit last).
--
--  a) backfill the missing rows now (audited, one 'create' review each);
--  b) from now on, triggers on cms_topics (new topic, home class change, restore) and cms_topic_classes (new link,
--     moved link) create the chapter's Achievers row for that class in the same transaction, audited;
--  c) Achievers rows are never deleted or retired automatically (a retired one is left as it is). Math only.

-- ---------------------------------------------------------------- create one if missing (Math only)
create function cms.cms_ensure_achievers(p_chapter text, p_class int, p_why text)
  returns boolean
  language plpgsql
  set search_path = ''
as $$
declare
  ch cms.cms_chapters;
  rid text;
begin
  select * into ch from cms.cms_chapters c where c.chapter_id = p_chapter;
  if not found or ch.subject <> 'math' or p_class not between 1 and 6 then return false; end if;
  -- one Achievers row per chapter and class, whatever its status (a retired one is never recreated)
  if exists (select 1 from cms.cms_topics t where t.chapter_id = p_chapter and t.class = p_class and t.topic_kind = 'achievers') then return false; end if;
  rid := 'ACH-' || p_chapter || '-' || p_class;
  insert into cms.cms_topics (topic_id, chapter_id, class, name, topic_kind)
    values (rid, p_chapter, p_class, 'Achievers: ' || ch.name, 'achievers');
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('catalogue', 'cms_topics', rid, 'create', p_why,
            jsonb_build_object('topic', jsonb_build_object('before', null, 'after',
              jsonb_build_object('chapter_id', p_chapter, 'class', p_class, 'name', 'Achievers: ' || ch.name, 'topic_kind', 'achievers'))),
            cms.cms_current_uid(), 'Achievers rule');
  return true;
end;
$$;
revoke execute on function cms.cms_ensure_achievers(text, int, text) from public;

-- ---------------------------------------------------------------- (b) triggers
create function cms.cms_topic_achievers()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if new.topic_kind = 'normal' and new.status = 'active'
     and (tg_op = 'INSERT' or new.class is distinct from old.class or old.status is distinct from 'active' or new.chapter_id is distinct from old.chapter_id) then
    perform cms.cms_ensure_achievers(new.chapter_id, new.class,
      'chapter present in class ' || new.class || ': home class of ' || new.topic_id);
    -- a topic restored or moved to another chapter also brings its approved extra classes
    perform cms.cms_ensure_achievers(new.chapter_id, c.class, 'chapter present in class ' || c.class || ': approved link ' || new.topic_id || ' · class ' || c.class)
      from cms.cms_topic_classes c where c.topic_id = new.topic_id;
  end if;
  return null;
end;
$$;
revoke execute on function cms.cms_topic_achievers() from public;
create trigger cms_topic_achievers after insert or update of class, status, chapter_id on cms.cms_topics
  for each row execute function cms.cms_topic_achievers();

create function cms.cms_topic_class_achievers()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
declare
  t cms.cms_topics;
begin
  if tg_op = 'UPDATE' and new.class = old.class and new.topic_id = old.topic_id then return null; end if;
  select * into t from cms.cms_topics x where x.topic_id = new.topic_id;
  if found and t.topic_kind = 'normal' and t.status = 'active' then
    perform cms.cms_ensure_achievers(t.chapter_id, new.class, 'chapter present in class ' || new.class || ': approved link ' || new.topic_id || ' · class ' || new.class);
  end if;
  return null;
end;
$$;
revoke execute on function cms.cms_topic_class_achievers() from public;
create trigger cms_topic_class_achievers after insert or update of class, topic_id on cms.cms_topic_classes
  for each row execute function cms.cms_topic_class_achievers();

-- ---------------------------------------------------------------- (a) backfill (one statement each, audited)
with present as (
  select t.chapter_id, t.class from cms.cms_topics t
    join cms.cms_chapters c on c.chapter_id = t.chapter_id
   where c.subject = 'math' and t.topic_kind = 'normal' and t.status = 'active'
  union
  select t.chapter_id, l.class from cms.cms_topic_classes l
    join cms.cms_topics t on t.topic_id = l.topic_id
    join cms.cms_chapters c on c.chapter_id = t.chapter_id
   where c.subject = 'math' and t.topic_kind = 'normal' and t.status = 'active'
), missing as (
  select p.chapter_id, p.class, c.name from present p join cms.cms_chapters c on c.chapter_id = p.chapter_id
   where not exists (select 1 from cms.cms_topics a where a.chapter_id = p.chapter_id and a.class = p.class and a.topic_kind = 'achievers')
), made as (
  insert into cms.cms_topics (topic_id, chapter_id, class, name, topic_kind)
    select 'ACH-' || m.chapter_id || '-' || m.class, m.chapter_id, m.class, 'Achievers: ' || m.name, 'achievers' from missing m
  returning topic_id, chapter_id, class, name
)
insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label)
  select 'catalogue', 'cms_topics', m.topic_id, 'create', 'backfill (0034): chapter present in class ' || m.class,
         jsonb_build_object('topic', jsonb_build_object('before', null, 'after',
           jsonb_build_object('chapter_id', m.chapter_id, 'class', m.class, 'name', m.name, 'topic_kind', 'achievers'))),
         'Achievers rule'
    from made m;

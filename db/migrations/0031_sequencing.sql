-- Sequencing strands, chapters and topics per class (Sambit, 13 Nov 2026).
-- Order is stored per class (and subject), never on the strand, chapter or topic itself:
--   cms_strand_order  : strand order per class + subject
--   cms_chapter_order : chapter order within its strand, per class (strand_id = the strand it was ordered in)
--   cms_topic_order   : topic order within its chapter, per class (core rows only; chapter_id = where it was ordered)
-- A row whose stored strand / chapter no longer matches the item's current one is ignored (the item
-- moved, so it counts as new and goes to the end). Items with no row go to the end. Retired items
-- keep their slot but are hidden. Achievers rows are never sequenced (always last in their chapter).
-- Extra rows (a topic from a lower / higher class) are never sequenced; they show after the core ones.
-- Numbering (1. / 1.2 / 1.2.3) is computed from this order with no gaps (shared/sequence.ts).
-- Seeded once from the Class View Seq, so today's order is kept. Reorders go through
-- cms_save_order (admin only) and are audited before → after.

create table cms.cms_strand_order (
  subject    text not null check (subject in ('math', 'science', 'grammar')),
  class      int  not null check (class between 1 and 6),
  strand_id  text not null references cms.cms_strands (strand_id),
  position   int  not null check (position >= 1),
  updated_at timestamptz not null default now(),
  primary key (class, strand_id)
);
create table cms.cms_chapter_order (
  class      int  not null check (class between 1 and 6),
  chapter_id text not null references cms.cms_chapters (chapter_id),
  strand_id  text not null references cms.cms_strands (strand_id),
  position   int  not null check (position >= 1),
  updated_at timestamptz not null default now(),
  primary key (class, chapter_id)
);
create table cms.cms_topic_order (
  class      int  not null check (class between 1 and 6),
  topic_id   text not null references cms.cms_topics (topic_id),
  chapter_id text not null references cms.cms_chapters (chapter_id),
  position   int  not null check (position >= 1),
  updated_at timestamptz not null default now(),
  primary key (class, topic_id)
);
alter table cms.cms_strand_order enable row level security;
alter table cms.cms_chapter_order enable row level security;
alter table cms.cms_topic_order enable row level security;
grant select on cms.cms_strand_order, cms.cms_chapter_order, cms.cms_topic_order to authenticated;
create policy cms_admin_only on cms.cms_strand_order for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));
create policy cms_admin_only on cms.cms_chapter_order for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));
create policy cms_admin_only on cms.cms_topic_order for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_reviews drop constraint cms_reviews_action_check;
alter table cms.cms_reviews add constraint cms_reviews_action_check check (action in (
  'submit', 'approve', 'reject', 'typo_fix', 'retire', 'restore', 'edit_catalogue', 'import_replace_draft',
  'edit_draft', 'new_version', 'withdraw', 'create', 'remove_book_material', 'override_near_copy', 'import_update',
  'decline_override', 'review_status', 'originality_check', 'reorder'));

-- Seed once from the Class View Seq (core, normal topics; retired ones keep their slot).
insert into cms.cms_topic_order (class, topic_id, chapter_id, position)
select t.class, t.topic_id, t.chapter_id,
       row_number() over (partition by t.class, t.chapter_id order by t.seq nulls last, t.topic_id)
from cms.cms_topics t
where t.topic_kind = 'normal';

insert into cms.cms_chapter_order (class, chapter_id, strand_id, position)
select x.class, x.chapter_id, x.strand_id,
       row_number() over (partition by x.class, x.strand_id order by x.first_seq nulls last, x.sort, x.chapter_id)
from (select t.class, c.chapter_id, c.strand_id, c.sort, min(t.seq) as first_seq
        from cms.cms_topics t join cms.cms_chapters c on c.chapter_id = t.chapter_id
       where t.topic_kind = 'normal'
       group by t.class, c.chapter_id, c.strand_id, c.sort) x;

insert into cms.cms_strand_order (subject, class, strand_id, position)
select x.subject, x.class, x.strand_id,
       row_number() over (partition by x.subject, x.class order by x.first_seq nulls last, x.sort, x.strand_id)
from (select s.subject, t.class, s.strand_id, s.sort, min(t.seq) as first_seq
        from cms.cms_topics t join cms.cms_chapters c on c.chapter_id = t.chapter_id join cms.cms_strands s on s.strand_id = c.strand_id
       where t.topic_kind = 'normal'
       group by s.subject, t.class, s.strand_id, s.sort) x;

-- Save a new order. p = { subject, class, lists: [ { level: 'strand' | 'chapter' | 'topic', parent_id, ids: [...] } ] }.
-- ids = the visible items of one list in their new order. No crossing: a chapter moves only within its
-- strand, a topic only within its chapter, and only core, non-Achievers topics are sequenced. Hidden
-- (retired) items keep their slots; items not ordered before are placed where the list puts them.
create function cms.cms_save_order(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  subj text := p ->> 'subject';
  cls int := (p ->> 'class')::int;
  l jsonb;
  lvl text;
  parent text;
  ids text[];
  old_ids text[];
  new_ids text[];
  hidden boolean;
  i int;
  k int;
  bad text;
  changed int := 0;
begin
  if not cms.cms_is_admin(uid) then
    raise exception 'Only the CMS admin can change the order.' using errcode = '42501';
  end if;
  if subj not in ('math', 'science', 'grammar') or cls is null or cls not between 1 and 6 then
    raise exception 'Reorder needs one class and one subject.';
  end if;
  for l in select * from jsonb_array_elements(coalesce(p -> 'lists', '[]')) loop
    lvl := l ->> 'level';
    parent := nullif(l ->> 'parent_id', '');
    ids := array(select jsonb_array_elements_text(coalesce(l -> 'ids', '[]')));
    if cardinality(ids) <> (select count(distinct x) from unnest(ids) x) then raise exception 'An item is listed twice.'; end if;

    if lvl = 'strand' then
      select x into bad from unnest(ids) x where not exists (select 1 from cms.cms_strands s where s.strand_id = x and s.subject = subj) limit 1;
      if bad is not null then raise exception 'Strand % is not a % strand.', bad, subj; end if;
      old_ids := array(select o.strand_id from cms.cms_strand_order o where o.class = cls and o.subject = subj order by o.position, o.strand_id);
    elsif lvl = 'chapter' then
      if not exists (select 1 from cms.cms_strands s where s.strand_id = parent and s.subject = subj) then raise exception 'Unknown strand %.', parent; end if;
      select x into bad from unnest(ids) x where not exists (select 1 from cms.cms_chapters c where c.chapter_id = x and c.strand_id = parent) limit 1;
      if bad is not null then raise exception 'Chapter % is not in strand %: a chapter moves only within its own strand.', bad, parent; end if;
      old_ids := array(select o.chapter_id from cms.cms_chapter_order o join cms.cms_chapters c on c.chapter_id = o.chapter_id and c.strand_id = o.strand_id
                        where o.class = cls and o.strand_id = parent order by o.position, o.chapter_id);
    elsif lvl = 'topic' then
      if not exists (select 1 from cms.cms_chapters c where c.chapter_id = parent and c.subject = subj) then raise exception 'Unknown chapter %.', parent; end if;
      select x into bad from unnest(ids) x where not exists (select 1 from cms.cms_topics t where t.topic_id = x and t.chapter_id = parent) limit 1;
      if bad is not null then raise exception 'Topic % is not in chapter %: a topic moves only within its own chapter.', bad, parent; end if;
      select x into bad from unnest(ids) x join cms.cms_topics t on t.topic_id = x where t.class <> cls limit 1;
      if bad is not null then raise exception 'Topic % comes from another class here; only core topics are sequenced.', bad; end if;
      select x into bad from unnest(ids) x join cms.cms_topics t on t.topic_id = x where t.topic_kind = 'achievers' limit 1;
      if bad is not null then raise exception 'The Achievers row % always stays last; it is not sequenced.', bad; end if;
      old_ids := array(select o.topic_id from cms.cms_topic_order o join cms.cms_topics t on t.topic_id = o.topic_id and t.chapter_id = o.chapter_id
                        where o.class = cls and o.chapter_id = parent and t.class = cls order by o.position, o.topic_id);
    else
      raise exception 'Unknown level %.', lvl;
    end if;

    -- keep hidden items in their slots; fill the visible slots with the new order; anything new goes after
    new_ids := '{}'; k := 1;
    for i in 1 .. coalesce(cardinality(old_ids), 0) loop
      hidden := not (old_ids[i] = any(ids));
      if hidden then new_ids := new_ids || old_ids[i];
      elsif k <= cardinality(ids) then new_ids := new_ids || ids[k]; k := k + 1;
      end if;
    end loop;
    while k <= cardinality(ids) loop new_ids := new_ids || ids[k]; k := k + 1; end loop;
    if new_ids = old_ids then continue; end if;

    if lvl = 'strand' then
      insert into cms.cms_strand_order (subject, class, strand_id, position, updated_at)
        select subj, cls, x, n, now() from unnest(new_ids) with ordinality as u(x, n)
        on conflict (class, strand_id) do update set position = excluded.position, subject = excluded.subject, updated_at = now();
    elsif lvl = 'chapter' then
      insert into cms.cms_chapter_order (class, chapter_id, strand_id, position, updated_at)
        select cls, x, parent, n, now() from unnest(new_ids) with ordinality as u(x, n)
        on conflict (class, chapter_id) do update set position = excluded.position, strand_id = excluded.strand_id, updated_at = now();
    else
      insert into cms.cms_topic_order (class, topic_id, chapter_id, position, updated_at)
        select cls, x, parent, n, now() from unnest(new_ids) with ordinality as u(x, n)
        on conflict (class, topic_id) do update set position = excluded.position, chapter_id = excluded.chapter_id, updated_at = now();
    end if;
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
      values ('catalogue', 'cms_' || lvl || '_order', subj || ' C' || cls || coalesce(' ' || parent, '') || ' ' || lvl || 's', 'reorder', null,
              jsonb_build_object('order', jsonb_build_object('before', to_jsonb(old_ids), 'after', to_jsonb(new_ids))), uid, 'Sambit');
    changed := changed + 1;
  end loop;
  return jsonb_build_object('lists_changed', changed);
end;
$$;
revoke execute on function cms.cms_save_order(jsonb) from public;
grant execute on function cms.cms_save_order(jsonb) to authenticated;

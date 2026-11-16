-- Science: misconception items, one primary content row, Solution 1 rule (Sambit, 16 Nov 2026;
-- docs/plan-2026-11-16-q11-q18.md, Q16 Q17 Q18). Schema cms only. Nothing is dropped or renamed
-- (one CHECK constraint on cms_version_wrong_answers is replaced by a wider one).
--
--  * cms_row_misconceptions: each content row's "Common misconceptions" text as numbered items, referenced as
--    "C6-04-014 #2". Items are never deleted and numbers are never reused (status retired). Source 'row split'
--    (from the row's own text: import:science and science:rationalise, as cms_owner) or 'from question'
--    (proposed from an existing question's text; starts needs_review, decided in Proposed).
--  * A Science question's misconception targeted is a reference to an item (misconception_row_id + _item_no);
--    the old free text is kept in misconception_targeted_legacy. A wrong option's misconception tag is a
--    reference too (mc_row_id + mc_item_no on cms_version_wrong_answers).
--  * cms_question_content_rows.rank: primary (weight 1.0) · secondary (0.5, other direct rows) · context
--    (0, supporting rows). One primary per version; rank_proposed marks a primary the rationaliser proposed.
--  * Approval of a production Science version needs: Solution 1 · exactly one confirmed primary row · no free
--    misconception text · references only to ACTIVE items of its own linked rows.
--  * Edit → new version of a Science question now keeps its links, citations and Science fields.

-- ---------------------------------------------------------------- misconception items
create table cms.cms_row_misconceptions (
  row_id      text not null references cms.cms_content_rows (row_id),
  item_no     int  not null check (item_no between 1 and 99),
  text        text not null check (char_length(btrim(text)) between 1 and 300),
  status      text not null default 'active' check (status in ('active', 'needs_review', 'retired')),
  source      text not null check (source in ('row split', 'from question')),
  unclear     boolean not null default false,  -- the split needs Sambit's look (listed in the report)
  split_note  text,                            -- why it was split / kept whole
  proposed_by text,                            -- 'from question': the question it came from
  import_id   bigint references cms.cms_imports (import_id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (row_id, item_no)
);

alter table cms.cms_question_versions
  add column misconception_row_id          text,
  add column misconception_item_no         int,
  add column misconception_targeted_legacy text,
  add constraint cms_question_versions_mc_pair check ((misconception_row_id is null) = (misconception_item_no is null)),
  add constraint cms_question_versions_mc_item foreign key (misconception_row_id, misconception_item_no)
    references cms.cms_row_misconceptions (row_id, item_no);
create index cms_question_versions_mc on cms.cms_question_versions (misconception_row_id, misconception_item_no) where misconception_row_id is not null;

alter table cms.cms_version_wrong_answers
  add column mc_row_id  text,
  add column mc_item_no int,
  add constraint cms_version_wrong_answers_mc_pair check ((mc_row_id is null) = (mc_item_no is null)),
  add constraint cms_version_wrong_answers_mc_item foreign key (mc_row_id, mc_item_no)
    references cms.cms_row_misconceptions (row_id, item_no);
alter table cms.cms_version_wrong_answers drop constraint cms_version_wrong_answers_check;
alter table cms.cms_version_wrong_answers add constraint cms_version_wrong_answers_check
  check (tag <> 'misconception' or misconception_id is not null or mc_row_id is not null);

-- ---------------------------------------------------------------- primary / secondary / context
alter table cms.cms_question_content_rows
  add column rank          text,
  add column rank_proposed boolean not null default false;
update cms.cms_question_content_rows set rank = case role when 'supporting' then 'context' else 'secondary' end;
alter table cms.cms_question_content_rows
  alter column rank set not null,
  add constraint cms_question_content_rows_rank check (rank in ('primary', 'secondary', 'context')),
  add constraint cms_question_content_rows_rank_role check ((role = 'supporting') = (rank = 'context')),
  add constraint cms_question_content_rows_proposed check (not rank_proposed or rank = 'primary'),
  add column weight numeric(2, 1) generated always as (case rank when 'primary' then 1.0 when 'secondary' then 0.5 else 0 end) stored;
create unique index cms_question_content_rows_one_primary on cms.cms_question_content_rows (version_id) where rank = 'primary';

-- A link written without a rank (older code paths) gets secondary (direct) or context (supporting).
create function cms.cms_content_link_rank()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if new.rank is null then new.rank := case new.role when 'supporting' then 'context' else 'secondary' end; end if;
  return new;
end;
$$;
revoke execute on function cms.cms_content_link_rank() from public;
create trigger cms_content_link_rank before insert or update on cms.cms_question_content_rows
  for each row execute function cms.cms_content_link_rank();

-- Row status (0032) + primary / secondary counts appended (existing columns unchanged).
create or replace view cms.cms_content_row_status with (security_invoker = true) as
select r.row_id, r.topic_id, r.chapter_id, r.row_class, r.type, r.question_use, r.in_master,
       coalesce(l.n_direct, 0)::int as n_direct, coalesce(l.n_supporting, 0)::int as n_supporting,
       case when coalesce(l.n_direct, 0) > 0 then 'direct'
            when coalesce(l.n_supporting, 0) > 0 then 'supporting'
            when r.question_use <> 'OK' then 'not_eligible'
            else 'none' end as status,
       coalesce(l.n_primary, 0)::int as n_primary, coalesce(l.n_secondary, 0)::int as n_secondary
from cms.cms_content_rows r
left join (
  select x.row_id, count(*) filter (where x.role = 'direct') as n_direct, count(*) filter (where x.role = 'supporting') as n_supporting,
         count(*) filter (where x.rank = 'primary') as n_primary, count(*) filter (where x.rank = 'secondary') as n_secondary
    from cms.cms_question_content_rows x
    join cms.cms_question_list q on q.version_id = x.version_id and q.counted
   group by x.row_id) l on l.row_id = r.row_id;

alter table cms.cms_reviews drop constraint cms_reviews_action_check;
alter table cms.cms_reviews add constraint cms_reviews_action_check check (action in (
  'submit', 'approve', 'reject', 'typo_fix', 'retire', 'restore', 'edit_catalogue', 'import_replace_draft',
  'edit_draft', 'new_version', 'withdraw', 'create', 'remove_book_material', 'override_near_copy', 'import_update',
  'decline_override', 'review_status', 'originality_check', 'reorder', 'science_row', 'science_review', 'science_rationalise'));
alter table cms.cms_imports drop constraint cms_imports_kind_check;
alter table cms.cms_imports add constraint cms_imports_kind_check check (kind in (
  'chapter', 'topics', 'seed', 'sources', 'book', 'originality', 'proposals', 'figures', 'updates', 'upload', 'science', 'science_rationalise'));

-- ---------------------------------------------------------------- security
alter table cms.cms_row_misconceptions enable row level security;
grant select on cms.cms_row_misconceptions to authenticated;
create policy cms_admin_only on cms.cms_row_misconceptions for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

-- ---------------------------------------------------------------- approval rules (0032 + Science, 0035)
create or replace function cms.cms_version_flags()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
declare
  bank text;
  subj text;
  becoming_approved boolean;
begin
  if tg_op = 'INSERT' and new.created_from = 'edit' then
    new.originality_pending := coalesce((select v.originality_pending from cms.cms_question_versions v
                                          where v.question_id = new.question_id and v.version_no = new.version_no - 1), false);
  end if;
  select q.bank, q.subject into bank, subj from cms.cms_questions q where q.question_id = new.question_id;
  if new.attributes_pending and new.reading is not null and new.steps is not null and new.inhibition is not null and new.visual is not null
     and (case when subj = 'science' then new.has_irrelevant_info is not null
               else new.working_memory is not null and new.strategy is not null and new.math_difficulty is not null end) then
    new.attributes_pending := false;
  end if;
  becoming_approved := new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved');
  if becoming_approved then
    if new.originality_pending then
      raise exception 'v% of % can''t be approved yet: its originality check is pending (run the pending originality check from the Mac).',
        new.version_no, new.question_id;
    end if;
    if coalesce(bank, 'production') = 'production' then
      if new.image_status = 'needs_image' then
        raise exception 'v% of % can''t be approved yet: its picture is pending (a picture is needed and not added yet).', new.version_no, new.question_id;
      end if;
      if new.attributes_pending then
        raise exception 'v% of % can''t be approved yet: its attributes are pending (edit it and fill in the signature).', new.version_no, new.question_id;
      end if;
      -- Science (0035, Sambit 16 Nov 2026): Solution 1, one confirmed primary row, misconceptions only as items of its own rows
      if subj = 'science' then
        if not exists (select 1 from cms.cms_version_solutions s where s.version_id = new.version_id and s.slot = 1 and btrim(s.text) <> '') then
          raise exception 'v% of % can''t be approved yet: Solution 1 is empty (answer + short reasoning from its content rows).', new.version_no, new.question_id;
        end if;
        if (select count(*) from cms.cms_question_content_rows l where l.version_id = new.version_id and l.rank = 'primary' and not l.rank_proposed) <> 1 then
          raise exception 'v% of % can''t be approved yet: it needs one confirmed primary content row (confirm the proposed primary).', new.version_no, new.question_id;
        end if;
        if btrim(coalesce(new.misconception_targeted, '')) <> '' then
          raise exception 'v% of % can''t be approved yet: its misconception is free text; pick an item of its content rows.', new.version_no, new.question_id;
        end if;
        if new.misconception_row_id is not null and not exists (
             select 1 from cms.cms_row_misconceptions m join cms.cms_question_content_rows l on l.row_id = m.row_id and l.version_id = new.version_id
              where m.row_id = new.misconception_row_id and m.item_no = new.misconception_item_no and m.status = 'active') then
          raise exception 'v% of % can''t be approved yet: its misconception % #% is not an active item of its content rows (approve the item in Proposed first).',
            new.version_no, new.question_id, new.misconception_row_id, new.misconception_item_no;
        end if;
        if exists (select 1 from cms.cms_version_wrong_answers w where w.version_id = new.version_id and w.tag = 'misconception'
                     and (w.mc_row_id is null or not exists (
                       select 1 from cms.cms_row_misconceptions m join cms.cms_question_content_rows l on l.row_id = m.row_id and l.version_id = new.version_id
                        where m.row_id = w.mc_row_id and m.item_no = w.mc_item_no and m.status = 'active'))) then
          raise exception 'v% of % can''t be approved yet: a wrong option''s misconception is not an active item of its content rows.', new.version_no, new.question_id;
        end if;
      end if;
    end if;
  end if;
  return new;
end;
$$;


-- ---------------------------------------------------------------- saves (0019): a new Science version keeps its links; wrong options keep their row items
create or replace function cms.cms_apply_save(payload jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  qid text := payload ->> 'question_id';
  mode text := payload ->> 'mode';
  v jsonb := payload -> 'version';
  pq jsonb := payload -> 'question';
  r cms.cms_question_versions;
  q cms.cms_questions;
  cur cms.cms_question_versions;
  vid bigint;
  vno int;
  open_no int;
  act text;
  subj text;
  ch text;
  keyno int;
begin
  if not cms.cms_is_admin(uid) then
    raise exception 'Only the CMS admin can save questions.' using errcode = '42501';
  end if;
  if coalesce(payload ->> 'content_hash', '') !~ '^[0-9a-f]{64}$' then raise exception 'The save has no valid structure fingerprint.'; end if;
  r := jsonb_populate_record(null::cms.cms_question_versions, v);

  if mode = 'create' then
    -- A new PRODUCTION question from generation (Phase 6). Never gold. File keys
    -- <chapter>-5001…9999 are reserved for CMS-generated drafts, so they never collide
    -- with keys that chapter files assign.
    subj := pq ->> 'subject'; ch := pq ->> 'chapter_id';
    if subj is null or subj not in ('math', 'science', 'grammar') then raise exception 'A new question needs a subject.'; end if;
    select coalesce(max(substring(file_key from '-([0-9]+)$')::int), 5000) + 1 into keyno
      from cms.cms_questions where chapter_id = ch and substring(file_key from '-([0-9]+)$')::int between 5001 and 9999;
    if keyno > 9999 then raise exception 'Chapter % has used all generated-draft keys.', ch; end if;
    qid := case subj when 'math' then 'MQ' || lpad(nextval('cms.cms_mq_seq')::text, 6, '0')
                     when 'science' then 'SQ' || lpad(nextval('cms.cms_sq_seq')::text, 6, '0')
                     else 'GQ' || lpad(nextval('cms.cms_gq_seq')::text, 6, '0') end;
    insert into cms.cms_questions (question_id, bank, subject, file_key, chapter_id, topic_id, class, class_override, placement_note,
                                   typical_set_id, pattern_id, clone_batch_id, locale, current_version)
      values (qid, 'production', subj, ch || '-' || keyno, ch, pq ->> 'topic_id', (pq ->> 'class')::int, (pq ->> 'class_override')::int,
              pq ->> 'placement_note', pq ->> 'typical_set_id', pq ->> 'pattern_id', pq ->> 'clone_batch_id', 'IN', 1);
    vno := 1; act := 'create';
    insert into cms.cms_question_versions (
      question_id, version_no, status, topic_id, typical_set_id, pattern_id, text, figure_description, image_status, image_path,
      format, correct, accepted, duration_s, math_difficulty, is_pure_fact, reading, has_irrelevant_info, steps, working_memory,
      inhibition, visual, strategy, strategy_type, strategy_type_2, strategy_other_note, insight_id, proposed_insight, trick_ref,
      multistep_band, load, load_driver, style, tier, trap_level, is_isolating, difficulty_points,
      tagging_why, tagged_by, tagging_summary, author_notes, content_hash, created_from, run_id)
    values (
      qid, 1, 'draft', r.topic_id, r.typical_set_id, r.pattern_id, r.text, r.figure_description, r.image_status, r.image_path,
      r.format, r.correct, coalesce(r.accepted, '{}'), r.duration_s, r.math_difficulty, r.is_pure_fact, r.reading, r.has_irrelevant_info,
      r.steps, r.working_memory, r.inhibition, r.visual, r.strategy, r.strategy_type, r.strategy_type_2, r.strategy_other_note,
      r.insight_id, r.proposed_insight, r.trick_ref, r.multistep_band, r.load, r.load_driver, r.style, r.tier, r.trap_level,
      r.is_isolating, r.difficulty_points, r.tagging_why, r.tagged_by, r.tagging_summary, r.author_notes,
      payload ->> 'content_hash', 'generation', (payload ->> 'run_id')::bigint)
    returning version_id into vid;
  else
  select * into q from cms.cms_questions where question_id = qid for update;
  if not found then raise exception 'Question % does not exist.', qid; end if;
  if q.retired_at is not null then raise exception 'Question % is retired; restore it before editing.', qid; end if;
  if (payload ->> 'base_version_no')::int is distinct from q.current_version then
    raise exception 'Question % changed since you opened it (it is now at v%). Reload and edit again.', qid, q.current_version;
  end if;
  select * into cur from cms.cms_question_versions where question_id = qid and version_no = q.current_version for update;

  if mode = 'typo_fix' then
    -- Hard rule 1: wording only. Structure must be unchanged, and only text columns are written.
    if payload ->> 'content_hash' is distinct from cur.content_hash then
      raise exception 'A typo fix cannot change numbers, options, answers, format, parts, concepts, tags, signature, placement or image. Save it as a new version.';
    end if;
    update cms.cms_question_versions
      set text = r.text, figure_description = case when figure_description is null then null else r.figure_description end,
          strategy_other_note = case when strategy_other_note is null then null else r.strategy_other_note end,
          tagging_why = case when tagging_why is null or r.tagging_why is null then tagging_why
                             else (select jsonb_object_agg(k, jsonb_set(tagging_why -> k, '{why}', coalesce(r.tagging_why -> k -> 'why', tagging_why -> k -> 'why')))
                                   from jsonb_object_keys(tagging_why) as k) end,
          tagging_summary = r.tagging_summary, author_notes = r.author_notes, edited_at = now()
      where version_id = cur.version_id;
    update cms.cms_version_solutions s set text = x.text
      from jsonb_to_recordset(payload -> 'solutions') as x(slot int, text text)
      where s.version_id = cur.version_id and s.slot = x.slot and x.text is not null and x.text <> '';
    update cms.cms_version_hints h set text = x.text
      from jsonb_to_recordset(payload -> 'hints') as x(level int, text text)
      where h.version_id = cur.version_id and h.level = x.level and x.text is not null and x.text <> '';
    update cms.cms_version_wrong_answers w set why = x.why
      from jsonb_to_recordset(payload -> 'wrong_answers') as x(part_label text, value text, why text)
      where w.version_id = cur.version_id and w.part_label = x.part_label and w.value = x.value;
    update cms.cms_version_parts p set text = x.text
      from jsonb_to_recordset(payload -> 'parts') as x(part_label text, text text)
      where p.version_id = cur.version_id and p.part_label = x.part_label and x.text is not null and x.text <> '';
    update cms.cms_questions set placement_note = pq ->> 'placement_note' where question_id = qid;
    vid := cur.version_id; vno := cur.version_no; act := 'typo_fix';

  elsif mode = 'update_draft' then
    if cur.status not in ('draft', 'in_review') then
      raise exception 'Only an open draft can be edited in place; v% is %.', cur.version_no, cur.status;
    end if;
    vid := cur.version_id; vno := cur.version_no; act := 'edit_draft';
    delete from cms.cms_version_parts where version_id = vid;
    delete from cms.cms_version_options where version_id = vid;
    delete from cms.cms_version_wrong_answers where version_id = vid;
    delete from cms.cms_version_concepts where version_id = vid;
    delete from cms.cms_version_solutions where version_id = vid;
    delete from cms.cms_version_hints where version_id = vid;
    delete from cms.cms_version_source_refs where version_id = vid;
    update cms.cms_question_versions set
      topic_id = r.topic_id, typical_set_id = r.typical_set_id, pattern_id = r.pattern_id, text = r.text,
      figure_description = r.figure_description, image_status = r.image_status, image_path = r.image_path, format = r.format,
      correct = r.correct, accepted = coalesce(r.accepted, '{}'), duration_s = r.duration_s, math_difficulty = r.math_difficulty,
      is_pure_fact = r.is_pure_fact, reading = r.reading, has_irrelevant_info = r.has_irrelevant_info, steps = r.steps,
      working_memory = r.working_memory, inhibition = r.inhibition, visual = r.visual, strategy = r.strategy,
      strategy_type = r.strategy_type, strategy_type_2 = r.strategy_type_2, strategy_other_note = r.strategy_other_note,
      insight_id = r.insight_id, proposed_insight = r.proposed_insight, trick_ref = r.trick_ref,
      multistep_band = r.multistep_band, load = r.load, load_driver = r.load_driver, style = r.style, tier = r.tier,
      trap_level = r.trap_level, is_isolating = r.is_isolating, difficulty_points = r.difficulty_points,
      tagging_why = r.tagging_why, tagged_by = r.tagged_by, tagging_summary = r.tagging_summary, author_notes = r.author_notes,
      content_hash = payload ->> 'content_hash', edited_at = now()
      where version_id = vid;

  elsif mode = 'new_version' then
    -- Hard rule 2: one open version per question (the unique index backs this up).
    select version_no into open_no from cms.cms_question_versions where question_id = qid and status in ('draft', 'in_review');
    if found then
      raise exception 'Question % already has an open version (v%). Finish, withdraw or reject it first.', qid, open_no;
    end if;
    vno := q.current_version + 1; act := 'new_version';
    insert into cms.cms_question_versions (
      question_id, version_no, status, topic_id, typical_set_id, pattern_id, text, figure_description, image_status, image_path,
      format, correct, accepted, duration_s, math_difficulty, is_pure_fact, reading, has_irrelevant_info, steps, working_memory,
      inhibition, visual, strategy, strategy_type, strategy_type_2, strategy_other_note, insight_id, proposed_insight, trick_ref,
      multistep_band, load, load_driver, style, tier, trap_level, is_isolating, difficulty_points,
      tagging_why, tagged_by, tagging_summary, author_notes, content_hash, created_from)
    values (
      qid, vno, 'draft', r.topic_id, r.typical_set_id, r.pattern_id, r.text, r.figure_description, r.image_status, r.image_path,
      r.format, r.correct, coalesce(r.accepted, '{}'), r.duration_s, r.math_difficulty, r.is_pure_fact, r.reading, r.has_irrelevant_info,
      r.steps, r.working_memory, r.inhibition, r.visual, r.strategy, r.strategy_type, r.strategy_type_2, r.strategy_other_note,
      r.insight_id, r.proposed_insight, r.trick_ref, r.multistep_band, r.load, r.load_driver, r.style, r.tier, r.trap_level,
      r.is_isolating, r.difficulty_points, r.tagging_why, r.tagged_by, r.tagging_summary, r.author_notes,
      payload ->> 'content_hash', 'edit')
    returning version_id into vid;
    if q.subject = 'science' then
      -- 0035: a new Science version keeps its content-row links (with rank), citations and Science fields
      update cms.cms_question_versions set level_tier = cur.level_tier, display_format = cur.display_format, safety_note = cur.safety_note,
             confidence = cur.confidence, misconception_row_id = cur.misconception_row_id, misconception_item_no = cur.misconception_item_no,
             misconception_targeted_legacy = coalesce(cur.misconception_targeted_legacy, cur.misconception_targeted)
       where version_id = vid;
      insert into cms.cms_question_content_rows (version_id, row_id, role, rank, rank_proposed)
        select vid, l.row_id, l.role, l.rank, l.rank_proposed from cms.cms_question_content_rows l where l.version_id = cur.version_id;
      insert into cms.cms_citations (version_id, for_row_id, source_id, page_from, page_to, raw)
        select vid, c.for_row_id, c.source_id, c.page_from, c.page_to, c.raw from cms.cms_citations c where c.version_id = cur.version_id order by c.citation_id;
    end if;
  else
    raise exception 'Unknown save mode "%".', mode;
  end if;
  end if;

  if mode in ('update_draft', 'new_version', 'create') then
    insert into cms.cms_version_parts (version_id, part_label, text, format, correct, accepted)
      select vid, x.part_label, x.text, x.format, x.correct, coalesce(x.accepted, '{}')
      from jsonb_populate_recordset(null::cms.cms_version_parts, coalesce(payload -> 'parts', '[]')) as x;
    insert into cms.cms_version_options (version_id, part_label, position, text, is_correct)
      select vid, x.part_label, x.position, x.text, x.is_correct
      from jsonb_populate_recordset(null::cms.cms_version_options, coalesce(payload -> 'options', '[]')) as x;
    insert into cms.cms_version_wrong_answers (version_id, part_label, value, option_position, tag, misconception_id, target_concept_id, why, mc_row_id, mc_item_no)
      select vid, x.part_label, x.value, x.option_position, x.tag, x.misconception_id, x.target_concept_id, x.why, x.mc_row_id, x.mc_item_no
      from jsonb_populate_recordset(null::cms.cms_version_wrong_answers, coalesce(payload -> 'wrong_answers', '[]')) as x;
    insert into cms.cms_version_concepts (version_id, part_label, concept_id, involvement)
      select vid, x.part_label, x.concept_id, x.involvement
      from jsonb_populate_recordset(null::cms.cms_version_concepts, coalesce(payload -> 'concepts', '[]')) as x;
    insert into cms.cms_version_solutions (version_id, slot, text, type, strategy)
      select vid, x.slot, x.text, x.type, x.strategy
      from jsonb_populate_recordset(null::cms.cms_version_solutions, coalesce(payload -> 'solutions', '[]')) as x;
    insert into cms.cms_version_hints (version_id, level, text)
      select vid, x.level, x.text
      from jsonb_populate_recordset(null::cms.cms_version_hints, coalesce(payload -> 'hints', '[]')) as x;
    insert into cms.cms_version_source_refs (version_id, ref_id, relation)
      select vid, x.ref_id, x.relation
      from jsonb_populate_recordset(null::cms.cms_version_source_refs, coalesce(payload -> 'source_refs', '[]')) as x;
    -- Hard rule 3: bank and question_id are never written; only the current placement pointers.
    update cms.cms_questions set
      topic_id = pq ->> 'topic_id', typical_set_id = pq ->> 'typical_set_id', pattern_id = pq ->> 'pattern_id',
      clone_batch_id = pq ->> 'clone_batch_id', class_override = (pq ->> 'class_override')::int,
      placement_note = pq ->> 'placement_note', current_version = vno
      where question_id = qid;
  end if;

  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('question_version', 'cms_question_versions', qid || ' v' || vno, act, payload ->> 'reason', payload -> 'diff', uid, 'Sambit');
  return jsonb_build_object('question_id', qid, 'version_no', vno, 'mode', mode);
end;
$$;


-- ---------------------------------------------------------------- Add question / bulk upload (0032): rank, misconception items
create or replace function cms.cms_add_questions(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  t cms.cms_topics;
  ch cms.cms_chapters;
  origin text := p ->> 'origin';
  imp bigint;
  x jsonb;
  qid text;
  keyno int;
  vid bigint;
  fmt text;
  opts text[];
  correct text;
  lvl int;
  pic boolean;
  i int;
  out_ids jsonb := '[]'::jsonb;
begin
  if not cms.cms_is_admin(uid) then
    raise exception 'Only the CMS admin can add questions.' using errcode = '42501';
  end if;
  if origin not in ('manual', 'upload') then raise exception 'Unknown origin %.', origin; end if;
  select * into t from cms.cms_topics where topic_id = p ->> 'topic_id';
  if not found then raise exception 'Topic % does not exist.', p ->> 'topic_id'; end if;
  if t.status <> 'active' then raise exception 'Topic % is retired.', t.topic_id; end if;
  select * into ch from cms.cms_chapters where chapter_id = t.chapter_id;
  if jsonb_array_length(coalesce(p -> 'questions', '[]')) = 0 and origin = 'manual' then raise exception 'Nothing to add.'; end if;
  if origin = 'upload' then
    if coalesce(btrim(p ->> 'file_name'), '') = '' then raise exception 'An upload needs its file name.'; end if;
    insert into cms.cms_imports (kind, file_path, file_hash, chapter_id, options, finished_at, result, counts, error_report)
      values ('upload', p ->> 'file_name', coalesce(p ->> 'file_hash', encode(sha256(convert_to(p::text, 'UTF8')), 'hex')), t.chapter_id,
              jsonb_build_object('topic_id', t.topic_id, 'by', 'Bulk upload (Excel)'), now(),
              case when jsonb_array_length(coalesce(p -> 'skipped', '[]')) = 0 then 'ok' else 'partial' end,
              jsonb_build_object('added', jsonb_array_length(coalesce(p -> 'questions', '[]')), 'skipped', jsonb_array_length(coalesce(p -> 'skipped', '[]'))),
              coalesce(p -> 'skipped', '[]') || coalesce(p -> 'warnings', '[]'))
      returning import_id into imp;
  end if;

  for x in select * from jsonb_array_elements(coalesce(p -> 'questions', '[]')) loop
    fmt := x ->> 'format';
    correct := nullif(btrim(coalesce(x ->> 'correct', '')), '');
    lvl := (x ->> 'level')::int;
    pic := (x ->> 'picture_needed')::boolean;
    opts := array(select btrim(o) from jsonb_array_elements_text(coalesce(x -> 'options', '[]')) as o where btrim(o) <> '');
    if coalesce(btrim(x ->> 'text'), '') = '' then raise exception 'Row %: question text is missing.', x ->> 'row'; end if;
    if fmt is null or fmt not in ('MCQ-4', 'MCQ-3', 'True/False', 'Typed-number', 'Typed-decimal', 'Typed-fraction', 'Typed-text') then
      raise exception 'Row %: format "%" is not allowed.', x ->> 'row', fmt;
    end if;
    if correct is null then raise exception 'Row %: correct answer is missing.', x ->> 'row'; end if;
    if lvl is null or lvl not between 1 and 6 then raise exception 'Row %: level must be 1–6.', x ->> 'row'; end if;
    if pic is null then raise exception 'Row %: say whether a picture is needed.', x ->> 'row'; end if;
    if pic and coalesce(btrim(x ->> 'figure_description'), '') = '' then raise exception 'Row %: a picture is needed, so the figure description is required.', x ->> 'row'; end if;
    if fmt = 'True/False' then
      opts := array['True', 'False'];
      if correct not in ('True', 'False') then raise exception 'Row %: a True/False answer must be True or False.', x ->> 'row'; end if;
    elsif fmt in ('MCQ-4', 'MCQ-3') then
      if cardinality(opts) <> (case fmt when 'MCQ-4' then 4 else 3 end) then
        raise exception 'Row %: % needs % options.', x ->> 'row', fmt, case fmt when 'MCQ-4' then 4 else 3 end;
      end if;
      if not correct = any(opts) then raise exception 'Row %: the correct answer must be one of the options.', x ->> 'row'; end if;
    else
      opts := '{}';
    end if;
    -- 0035: misconception targeted and wrong options' misconceptions are items of the question's own content rows
    if x -> 'misconception' ->> 'row_id' is not null and (
         not exists (select 1 from jsonb_array_elements(coalesce(x -> 'content_rows', '[]')) c where c ->> 'row_id' = x -> 'misconception' ->> 'row_id')
         or not exists (select 1 from cms.cms_row_misconceptions m where m.row_id = x -> 'misconception' ->> 'row_id'
                          and m.item_no = (x -> 'misconception' ->> 'item_no')::int and m.status <> 'retired')) then
      raise exception 'Row %: the misconception must be an item of one of its content rows.', x ->> 'row';
    end if;
    if exists (select 1 from jsonb_array_elements(coalesce(x -> 'wrong_answers', '[]')) w
                where w -> 'mc' ->> 'row_id' is not null and (
                  not exists (select 1 from jsonb_array_elements(coalesce(x -> 'content_rows', '[]')) c where c ->> 'row_id' = w -> 'mc' ->> 'row_id')
                  or not exists (select 1 from cms.cms_row_misconceptions m where m.row_id = w -> 'mc' ->> 'row_id'
                                   and m.item_no = (w -> 'mc' ->> 'item_no')::int and m.status <> 'retired'))) then
      raise exception 'Row %: a wrong option''s misconception must be an item of one of its content rows.', x ->> 'row';
    end if;
    if (select count(*) from jsonb_array_elements(coalesce(x -> 'content_rows', '[]')) c where c ->> 'rank' = 'primary') > 1 then
      raise exception 'Row %: only one content row can be primary.', x ->> 'row';
    end if;
    if exists (select 1 from jsonb_array_elements(coalesce(x -> 'content_rows', '[]')) c where c ->> 'rank' = 'primary' and c ->> 'role' <> 'direct') then
      raise exception 'Row %: the primary content row must be a direct row.', x ->> 'row';
    end if;

    select coalesce(max(substring(file_key from '-([0-9]+)$')::int), 5000) + 1 into keyno
      from cms.cms_questions where chapter_id = t.chapter_id and substring(file_key from '-([0-9]+)$')::int between 5001 and 9999;
    if keyno > 9999 then raise exception 'Chapter % has used all CMS question keys.', t.chapter_id; end if;
    qid := case ch.subject when 'math' then 'MQ' || lpad(nextval('cms.cms_mq_seq')::text, 6, '0')
                           when 'science' then 'SQ' || lpad(nextval('cms.cms_sq_seq')::text, 6, '0')
                           else 'GQ' || lpad(nextval('cms.cms_gq_seq')::text, 6, '0') end;
    insert into cms.cms_questions (question_id, bank, subject, file_key, chapter_id, topic_id, class, level, setting_id,
                                   typical_set_id, pattern_id, locale, current_version)
      values (qid, 'production', ch.subject, t.chapter_id || '-' || keyno, t.chapter_id, t.topic_id, t.class, lvl, nullif(x ->> 'setting_id', ''),
              nullif(x ->> 'typical_set_id', ''), nullif(x ->> 'pattern_id', ''), 'IN', 1);
    insert into cms.cms_question_versions (question_id, version_no, status, topic_id, typical_set_id, pattern_id, text,
        figure_description, image_status, format, correct, accepted, math_difficulty, author_notes, content_hash,
        created_from, import_id, attributes_pending, originality_pending)
      values (qid, 1, 'in_review', t.topic_id, nullif(x ->> 'typical_set_id', ''), nullif(x ->> 'pattern_id', ''), btrim(x ->> 'text'),
        nullif(btrim(coalesce(x ->> 'figure_description', '')), ''), case when pic then 'needs_image' end, fmt, correct, '{}',
        nullif(x ->> 'math_difficulty', ''), nullif(btrim(coalesce(x ->> 'author_notes', '')), ''),
        encode(sha256(convert_to(jsonb_build_object('text', btrim(x ->> 'text'), 'format', fmt, 'options', to_jsonb(opts), 'correct', correct,
          'level', lvl, 'figure', x ->> 'figure_description', 'concepts', x -> 'concepts', 'set', x ->> 'typical_set_id', 'pattern', x ->> 'pattern_id')::text, 'UTF8')), 'hex'),
        origin, imp, true, true)
      returning version_id into vid;
    for i in 1 .. coalesce(cardinality(opts), 0) loop
      insert into cms.cms_version_options (version_id, part_label, position, text, is_correct) values (vid, '', i, opts[i], opts[i] = correct);
    end loop;
    if coalesce(btrim(x ->> 'solution'), '') <> '' then
      insert into cms.cms_version_solutions (version_id, slot, text) values (vid, 1, btrim(x ->> 'solution'));
    end if;
    insert into cms.cms_version_hints (version_id, level, text)
      select vid, h.n, btrim(h.v) from jsonb_array_elements_text(coalesce(x -> 'hints', '[]')) with ordinality as h(v, n)
       where btrim(h.v) <> '' and h.n <= 3;
    insert into cms.cms_version_wrong_answers (version_id, part_label, value, option_position, tag, why, mc_row_id, mc_item_no)
      select vid, '', btrim(w ->> 'value'), nullif(array_position(opts, btrim(w ->> 'value')), 0),
             case when w -> 'mc' ->> 'row_id' is not null then 'misconception' end, nullif(btrim(coalesce(w ->> 'why', '')), ''),
             w -> 'mc' ->> 'row_id', (w -> 'mc' ->> 'item_no')::int
        from jsonb_array_elements(coalesce(x -> 'wrong_answers', '[]')) as w where coalesce(btrim(w ->> 'value'), '') <> '';
    insert into cms.cms_version_concepts (version_id, part_label, concept_id, involvement)
      select distinct vid, '', c, 1.0 from jsonb_array_elements_text(coalesce(x -> 'concepts', '[]')) as c where c <> '';
    insert into cms.cms_version_source_refs (version_id, ref_id, relation)
      select distinct vid, s, 'modelled_on' from jsonb_array_elements_text(coalesce(x -> 'source_refs', '[]')) as s where s <> '';
    -- Science (0032): optional content-row links [{row_id, role: direct | supporting}]; each row must exist
    if exists (select 1 from jsonb_array_elements(coalesce(x -> 'content_rows', '[]')) c
                where coalesce(c ->> 'role', '') not in ('direct', 'supporting')
                   or not exists (select 1 from cms.cms_content_rows r where r.row_id = c ->> 'row_id')) then
      raise exception 'Row %: a content row ID does not exist or its role is not direct / supporting.', x ->> 'row';
    end if;
    insert into cms.cms_question_content_rows (version_id, row_id, role)
      select distinct on (c ->> 'row_id') vid, c ->> 'row_id', c ->> 'role'
        from jsonb_array_elements(coalesce(x -> 'content_rows', '[]')) c
       order by c ->> 'row_id', (c ->> 'role') = 'supporting';
    -- 0035: one primary row: the row given as primary, else the first direct row given; the misconception item
    update cms.cms_question_content_rows l set rank = 'primary'
     where l.version_id = vid and l.role = 'direct' and l.row_id = coalesce(
       (select c.v ->> 'row_id' from jsonb_array_elements(coalesce(x -> 'content_rows', '[]')) with ordinality as c(v, n) where c.v ->> 'rank' = 'primary' limit 1),
       (select c.v ->> 'row_id' from jsonb_array_elements(coalesce(x -> 'content_rows', '[]')) with ordinality as c(v, n) where c.v ->> 'role' = 'direct' order by c.n limit 1));
    if x -> 'misconception' ->> 'row_id' is not null then
      update cms.cms_question_versions set misconception_row_id = x -> 'misconception' ->> 'row_id', misconception_item_no = (x -> 'misconception' ->> 'item_no')::int
       where version_id = vid;
    end if;
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label, import_id)
      values ('question_version', 'cms_question_versions', qid || ' v1', 'create',
              case origin when 'manual' then 'added by hand' else 'uploaded from ' || (p ->> 'file_name') || coalesce(' (row ' || (x ->> 'row') || ')', '') end,
              jsonb_build_object('status', jsonb_build_object('before', null, 'after', 'in_review'), 'origin', origin,
                                 'flags', jsonb_build_array('attributes_pending', 'originality_pending') || case when pic then '["image_pending"]'::jsonb else '[]'::jsonb end),
              uid, 'Sambit', imp);
    out_ids := out_ids || jsonb_build_object('row', x -> 'row', 'question_id', qid, 'file_key', t.chapter_id || '-' || keyno);
  end loop;
  return jsonb_build_object('import_id', imp, 'added', out_ids);
end;
$$;


-- ---------------------------------------------------------------- Science review box (Q16 Q17 Q18)
-- p = { question_id, version_no, reason?,
--       misconception?: {row_id, item_no} | null,           -- key present = set it (null clears it)
--       wrong?: [{position, mc: {row_id, item_no} | null}], -- wrong options (MCQ / True-False), by option position
--       primary_row_id?: text,                              -- confirms the primary (one of the direct rows)
--       solution1?: text }
-- Open drafts only (an approved question: Edit → new version first). Every reference must be an item (not
-- retired) of one of the version's own content rows. One cms_reviews row, before → after.
create function cms.cms_save_science_review(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  q cms.cms_questions;
  cur cms.cms_question_versions;
  vid bigint;
  w jsonb;
  pos int;
  opt cms.cms_version_options;
  before jsonb;
  after jsonb;
begin
  if not cms.cms_is_admin(uid) then raise exception 'Only the CMS admin can review questions.' using errcode = '42501'; end if;
  select * into q from cms.cms_questions where question_id = p ->> 'question_id' for update;
  if not found then raise exception 'Question % does not exist.', p ->> 'question_id'; end if;
  if q.subject <> 'science' then raise exception 'The Science review is for Science questions only.'; end if;
  if q.retired_at is not null then raise exception 'Question % is retired.', q.question_id; end if;
  if (p ->> 'version_no')::int is distinct from q.current_version then
    raise exception 'Question % changed since you opened it (it is now at v%). Reload and try again.', q.question_id, q.current_version;
  end if;
  select * into cur from cms.cms_question_versions where question_id = q.question_id and version_no = q.current_version for update;
  if cur.status not in ('draft', 'in_review') then
    raise exception 'v% is %; use Edit to make a new version first, then review it.', cur.version_no, cur.status;
  end if;
  vid := cur.version_id;
  before := cms.cms_science_review_state(vid);

  if p ? 'misconception' then
    if jsonb_typeof(p -> 'misconception') = 'null' then
      update cms.cms_question_versions set misconception_row_id = null, misconception_item_no = null where version_id = vid;
    else
      if not cms.cms_linked_item(vid, p -> 'misconception' ->> 'row_id', (p -> 'misconception' ->> 'item_no')::int) then
        raise exception 'The misconception must be an item of one of this question''s content rows (% #%).', p -> 'misconception' ->> 'row_id', p -> 'misconception' ->> 'item_no';
      end if;
      update cms.cms_question_versions set misconception_row_id = p -> 'misconception' ->> 'row_id',
             misconception_item_no = (p -> 'misconception' ->> 'item_no')::int, misconception_targeted = null where version_id = vid;
    end if;
  end if;

  for w in select * from jsonb_array_elements(coalesce(p -> 'wrong', '[]')) loop
    pos := (w ->> 'position')::int;
    select * into opt from cms.cms_version_options where version_id = vid and part_label = '' and position = pos;
    if not found then raise exception 'Option % does not exist.', pos; end if;
    if opt.is_correct then raise exception 'Option % is the correct answer; only wrong options take a misconception.', pos; end if;
    if jsonb_typeof(w -> 'mc') = 'object' then
      if not cms.cms_linked_item(vid, w -> 'mc' ->> 'row_id', (w -> 'mc' ->> 'item_no')::int) then
        raise exception 'Option %: the misconception must be an item of one of this question''s content rows.', pos;
      end if;
      update cms.cms_version_wrong_answers set tag = 'misconception', misconception_id = null,
             mc_row_id = w -> 'mc' ->> 'row_id', mc_item_no = (w -> 'mc' ->> 'item_no')::int
       where version_id = vid and part_label = '' and option_position = pos;
      if not found then
        insert into cms.cms_version_wrong_answers (version_id, part_label, value, option_position, tag, mc_row_id, mc_item_no)
          values (vid, '', opt.text, pos, 'misconception', w -> 'mc' ->> 'row_id', (w -> 'mc' ->> 'item_no')::int);
      end if;
    else
      update cms.cms_version_wrong_answers set tag = null, mc_row_id = null, mc_item_no = null
       where version_id = vid and part_label = '' and option_position = pos and mc_row_id is not null;
    end if;
  end loop;

  if p ? 'primary_row_id' then
    if not exists (select 1 from cms.cms_question_content_rows where version_id = vid and row_id = p ->> 'primary_row_id' and role = 'direct') then
      raise exception 'The primary row must be one of this question''s direct rows (%).', p ->> 'primary_row_id';
    end if;
    update cms.cms_question_content_rows set rank = 'secondary', rank_proposed = false where version_id = vid and role = 'direct';
    update cms.cms_question_content_rows set rank = 'primary' where version_id = vid and row_id = p ->> 'primary_row_id';
  end if;

  if p ? 'solution1' then
    if coalesce(btrim(p ->> 'solution1'), '') = '' then raise exception 'Solution 1 can''t be empty.'; end if;
    update cms.cms_version_solutions set text = btrim(p ->> 'solution1') where version_id = vid and slot = 1;
    if not found then insert into cms.cms_version_solutions (version_id, slot, text) values (vid, 1, btrim(p ->> 'solution1')); end if;
  end if;

  after := cms.cms_science_review_state(vid);
  if after is distinct from before then
    update cms.cms_question_versions set edited_at = now() where version_id = vid;
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
      values ('question_version', 'cms_question_versions', q.question_id || ' v' || cur.version_no, 'science_review',
              coalesce(nullif(btrim(p ->> 'reason'), ''), 'Science review'),
              (select jsonb_object_agg(k, jsonb_build_object('before', before -> k, 'after', after -> k))
                 from jsonb_object_keys(after) as k where before -> k is distinct from after -> k),
              uid, 'Sambit');
  end if;
  return jsonb_build_object('question_id', q.question_id, 'version_no', cur.version_no, 'changed', after is distinct from before);
end;
$$;

-- Is (row, item) a not-retired item of one of the version's content rows?
create function cms.cms_linked_item(p_version_id bigint, p_row_id text, p_item_no int)
  returns boolean
  language sql
  stable
  set search_path = ''
as $$
  select exists (select 1 from cms.cms_row_misconceptions m
                   join cms.cms_question_content_rows l on l.row_id = m.row_id and l.version_id = p_version_id
                  where m.row_id = p_row_id and m.item_no = p_item_no and m.status <> 'retired');
$$;

-- What the Science review box sets, as one JSON value (for the audit's before → after).
create function cms.cms_science_review_state(p_version_id bigint)
  returns jsonb
  language sql
  stable
  set search_path = ''
as $$
  select jsonb_build_object(
    'misconception', (select case when v.misconception_row_id is null then null else v.misconception_row_id || ' #' || v.misconception_item_no end
                        from cms.cms_question_versions v where v.version_id = p_version_id),
    'wrong_options', coalesce((select jsonb_object_agg(w.option_position::text, w.mc_row_id || ' #' || w.mc_item_no)
                                 from cms.cms_version_wrong_answers w where w.version_id = p_version_id and w.mc_row_id is not null and w.option_position is not null), '{}'::jsonb),
    'primary', (select l.row_id || case when l.rank_proposed then ' (proposed)' else '' end from cms.cms_question_content_rows l
                 where l.version_id = p_version_id and l.rank = 'primary'),
    'solution1', (select s.text from cms.cms_version_solutions s where s.version_id = p_version_id and s.slot = 1));
$$;
revoke execute on function cms.cms_save_science_review(jsonb) from public;
revoke execute on function cms.cms_linked_item(bigint, text, int) from public;
revoke execute on function cms.cms_science_review_state(bigint) from public;
grant execute on function cms.cms_save_science_review(jsonb) to authenticated;

-- ---------------------------------------------------------------- decide a proposed item (Proposed → Misconception items)
create function cms.cms_set_row_misconception_status(p_row_id text, p_item_no int, p_status text, p_reason text)
  returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  m cms.cms_row_misconceptions;
begin
  if not cms.cms_is_admin(uid) then raise exception 'Only the CMS admin can decide misconception items.' using errcode = '42501'; end if;
  if p_status not in ('active', 'retired', 'needs_review') then raise exception 'Unknown status %.', p_status; end if;
  select * into m from cms.cms_row_misconceptions where row_id = p_row_id and item_no = p_item_no for update;
  if not found then raise exception 'No misconception item % #%.', p_row_id, p_item_no; end if;
  if m.status = p_status then return; end if;
  if p_status = 'retired' and coalesce(btrim(p_reason), '') = '' then raise exception 'Retiring an item needs a reason.'; end if;
  update cms.cms_row_misconceptions set status = p_status, updated_at = now() where row_id = p_row_id and item_no = p_item_no;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('catalogue', 'cms_row_misconceptions', p_row_id || ' #' || p_item_no,
            case p_status when 'active' then 'edit_catalogue' when 'retired' then 'retire' else 'restore' end,
            coalesce(nullif(btrim(p_reason), ''), case p_status when 'active' then 'approved from the Proposed list' else 'back to needs review' end),
            jsonb_build_object('status', jsonb_build_object('before', m.status, 'after', p_status), 'text', m.text, 'source', m.source),
            uid, 'Sambit');
end;
$$;
revoke execute on function cms.cms_set_row_misconception_status(text, int, text, text) from public;
grant execute on function cms.cms_set_row_misconception_status(text, int, text, text) to authenticated;

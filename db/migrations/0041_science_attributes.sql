-- Round 2, Iteration 1 (Sambit, 17 Nov 2026): Science question attributes. Schema cms only; adds only.
-- Plan: docs/plan-2026-11-17-round2.md §1 and §3; decisions §10.
--
-- Q26 (S1) New Science version fields: science_question_type (1 Fact · 2 Basic understanding · 3 Curiosity/application ·
--   4 Achiever · 5 Super Achiever; required to approve a Science production question), setting_familiarity (Bare ·
--   Everyday · Less familiar · Rare), has_hidden_idea, has_experiment. The setting is the existing
--   cms_questions.setting_id (SET catalogue; blank = bare), now saved by cms_apply_save when the payload names it.
--   The trigger refuses all of them on a non-Science version. Every change is audited (the save's before → after).
-- Q27 (S2) The authored Science tier (level_tier, L1–L3) is retired: copied to science_tier_legacy (one audit row per
--   version, never lost) and frozen (the trigger refuses any write). New versions carry only science_tier_legacy.
--   The 134 Magnets questions stay untyped (the Science thread types them later).
-- Q28 (S3) cms_settings.subject (math / science): one shared SET list; the existing 41 → math (audited).
-- Q32 (S7) Science wrong options may use Math's 9 tags. misconception → an item of a linked row (0035); concept_error →
--   a target row from the linked rows (new target_row_id). Untagged is valid and never blocks approval.
--
-- CHECKs are only made wider (cms_version_wrong_answers concept_error rule). Nothing is dropped or renamed.

-- ---------------------------------------------------------------- columns
alter table cms.cms_question_versions
  add column science_question_type smallint check (science_question_type between 1 and 5),
  add column setting_familiarity   text check (setting_familiarity in ('Bare', 'Everyday', 'Less familiar', 'Rare')),
  add column has_hidden_idea       boolean,
  add column has_experiment        boolean,
  add column science_tier_legacy   text check (science_tier_legacy in ('L1', 'L2', 'L3'));

alter table cms.cms_settings
  add column subject text not null default 'math' check (subject in ('math', 'science'));

alter table cms.cms_version_wrong_answers
  add column target_row_id text references cms.cms_content_rows (row_id),
  add constraint cms_version_wrong_answers_target_row_only_concept_error check (target_row_id is null or tag = 'concept_error');
alter table cms.cms_version_wrong_answers drop constraint cms_version_wrong_answers_check1;
alter table cms.cms_version_wrong_answers add constraint cms_version_wrong_answers_check1
  check (tag <> 'concept_error' or target_concept_id is not null or target_row_id is not null);
create index cms_version_wrong_answers_target_row on cms.cms_version_wrong_answers (target_row_id) where target_row_id is not null;

-- ---------------------------------------------------------------- data (small, set-based; audited)
-- Q27: keep every authored tier as science_tier_legacy (134 versions on real, 17 Nov 2026)
insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label)
select 'question_version', 'cms_question_versions', v.question_id || ' v' || v.version_no, 'derived_update',
       'Authored Science tier retired; kept as science_tier_legacy (Q27, Sambit 17 Nov 2026)',
       jsonb_build_object('science_tier_legacy', jsonb_build_object('before', null, 'after', v.level_tier)), 'migration 0041'
  from cms.cms_question_versions v
 where v.level_tier is not null and v.science_tier_legacy is null;
update cms.cms_question_versions set science_tier_legacy = level_tier where level_tier is not null and science_tier_legacy is null;

-- Q28: the existing settings are Math settings (41 on real, all used by Math questions)
insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label)
select 'catalogue', 'cms_settings', s.setting_id, 'edit_catalogue', 'Settings get a subject; existing settings are Math (Q28, Sambit 17 Nov 2026)',
       jsonb_build_object('subject', jsonb_build_object('before', null, 'after', s.subject)), 'migration 0041'
  from cms.cms_settings s;

-- ---------------------------------------------------------------- approval rules + Science-only fields + frozen legacy tier
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
  -- 0041 (Q26/Q27): Science question attributes are Science-only; the authored Science tier (level_tier) is retired and frozen
  if subj is distinct from 'science' and (new.science_question_type is not null or new.setting_familiarity is not null
       or new.has_hidden_idea is not null or new.has_experiment is not null or new.science_tier_legacy is not null) then
    raise exception 'v% of %: Science question type, setting familiarity, hidden idea, experiment and the legacy tier are Science-only fields.', new.version_no, new.question_id;
  end if;
  if (tg_op = 'INSERT' and new.level_tier is not null) or (tg_op = 'UPDATE' and new.level_tier is distinct from old.level_tier) then
    raise exception 'v% of %: the authored Science tier (L1–L3) is retired and kept read-only in science_tier_legacy (Q27). Set the Science question type instead.', new.version_no, new.question_id;
  end if;
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
        if new.science_question_type is null then
          raise exception 'v% of % can''t be approved yet: its Science question type is not set (1 Fact · 2 Basic understanding · 3 Curiosity/application · 4 Achiever · 5 Super Achiever).', new.version_no, new.question_id;
        end if;
        if exists (select 1 from cms.cms_version_wrong_answers w where w.version_id = new.version_id and w.tag = 'concept_error'
                     and (w.target_row_id is null or not exists (select 1 from cms.cms_question_content_rows l where l.version_id = new.version_id and l.row_id = w.target_row_id))) then
          raise exception 'v% of % can''t be approved yet: a wrong option tagged concept error needs a target row from its own content rows.', new.version_no, new.question_id;
        end if;
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

-- ---------------------------------------------------------------- saves: S1 fields, the setting, the legacy tier, concept_error rows
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
      tagging_why, tagged_by, tagging_summary, author_notes, content_hash, created_from, run_id,
      science_question_type, setting_familiarity, has_hidden_idea, has_experiment)
    values (
      qid, 1, 'draft', r.topic_id, r.typical_set_id, r.pattern_id, r.text, r.figure_description, r.image_status, r.image_path,
      r.format, r.correct, coalesce(r.accepted, '{}'), r.duration_s, r.math_difficulty, r.is_pure_fact, r.reading, r.has_irrelevant_info,
      r.steps, r.working_memory, r.inhibition, r.visual, r.strategy, r.strategy_type, r.strategy_type_2, r.strategy_other_note,
      r.insight_id, r.proposed_insight, r.trick_ref, r.multistep_band, r.load, r.load_driver, r.style, r.tier, r.trap_level,
      r.is_isolating, r.difficulty_points, r.tagging_why, r.tagged_by, r.tagging_summary, r.author_notes,
      payload ->> 'content_hash', 'generation', (payload ->> 'run_id')::bigint,
      r.science_question_type, r.setting_familiarity, r.has_hidden_idea, r.has_experiment)
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
      science_question_type = r.science_question_type, setting_familiarity = r.setting_familiarity,
      has_hidden_idea = r.has_hidden_idea, has_experiment = r.has_experiment,
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
      tagging_why, tagged_by, tagging_summary, author_notes, content_hash, created_from,
      science_question_type, setting_familiarity, has_hidden_idea, has_experiment)
    values (
      qid, vno, 'draft', r.topic_id, r.typical_set_id, r.pattern_id, r.text, r.figure_description, r.image_status, r.image_path,
      r.format, r.correct, coalesce(r.accepted, '{}'), r.duration_s, r.math_difficulty, r.is_pure_fact, r.reading, r.has_irrelevant_info,
      r.steps, r.working_memory, r.inhibition, r.visual, r.strategy, r.strategy_type, r.strategy_type_2, r.strategy_other_note,
      r.insight_id, r.proposed_insight, r.trick_ref, r.multistep_band, r.load, r.load_driver, r.style, r.tier, r.trap_level,
      r.is_isolating, r.difficulty_points, r.tagging_why, r.tagged_by, r.tagging_summary, r.author_notes,
      payload ->> 'content_hash', 'edit',
      r.science_question_type, r.setting_familiarity, r.has_hidden_idea, r.has_experiment)
    returning version_id into vid;
    if q.subject = 'science' then
      -- 0035: a new Science version keeps its content-row links (with rank), citations and Science fields
      -- 0041 (Q27): the retired authored tier travels only as science_tier_legacy (level_tier stays on the old versions, frozen)
      update cms.cms_question_versions set science_tier_legacy = coalesce(cur.science_tier_legacy, cur.level_tier), display_format = cur.display_format, safety_note = cur.safety_note,
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
    insert into cms.cms_version_wrong_answers (version_id, part_label, value, option_position, tag, misconception_id, target_concept_id, why, mc_row_id, mc_item_no, target_row_id)
      select vid, x.part_label, x.value, x.option_position, x.tag, x.misconception_id, x.target_concept_id, x.why, x.mc_row_id, x.mc_item_no, x.target_row_id
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
    -- 0041 (Q26/Q28): a question's setting (SET catalogue; blank = bare) is saved when the payload names it, and must
    -- be a setting of the question's own subject.
    if pq ? 'setting_id' and nullif(pq ->> 'setting_id', '') is not null and not exists (
         select 1 from cms.cms_settings s where s.setting_id = pq ->> 'setting_id' and s.status <> 'retired'
            and s.subject = coalesce(q.subject, subj)) then
      raise exception 'Setting % is not a % setting (or it is retired).', pq ->> 'setting_id', coalesce(q.subject, subj);
    end if;
    -- Hard rule 3: bank and question_id are never written; only the current placement pointers.
    update cms.cms_questions set
      setting_id = case when pq ? 'setting_id' then nullif(pq ->> 'setting_id', '') else setting_id end,
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

-- ---------------------------------------------------------------- Science review box: the 9 tags on wrong options (Q32)
create or replace function cms.cms_save_science_review(p jsonb)
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
    if w ? 'tag' then
      -- 0041 (Q32): any of Math's 9 tags. misconception → an item of a linked row; concept_error → a linked row;
      -- the other 7 → the tag only. A null tag clears it (untagged is valid).
      if jsonb_typeof(w -> 'tag') = 'null' then
        update cms.cms_version_wrong_answers set tag = null, mc_row_id = null, mc_item_no = null, target_row_id = null, misconception_id = null, target_concept_id = null
         where version_id = vid and part_label = '' and option_position = pos;
        continue;
      end if;
      if w ->> 'tag' = 'misconception' and (jsonb_typeof(w -> 'mc') <> 'object' or not cms.cms_linked_item(vid, w -> 'mc' ->> 'row_id', (w -> 'mc' ->> 'item_no')::int)) then
        raise exception 'Option %: a misconception must be an item of one of this question''s content rows.', pos;
      end if;
      if w ->> 'tag' = 'concept_error' and not exists (select 1 from cms.cms_question_content_rows l where l.version_id = vid and l.row_id = w ->> 'target_row_id') then
        raise exception 'Option %: a concept error needs a target row from this question''s content rows.', pos;
      end if;
      update cms.cms_version_wrong_answers set tag = w ->> 'tag', misconception_id = null, target_concept_id = null,
             mc_row_id = case when w ->> 'tag' = 'misconception' then w -> 'mc' ->> 'row_id' end,
             mc_item_no = case when w ->> 'tag' = 'misconception' then (w -> 'mc' ->> 'item_no')::int end,
             target_row_id = case when w ->> 'tag' = 'concept_error' then w ->> 'target_row_id' end,
             why = coalesce(nullif(btrim(w ->> 'why'), ''), why)
       where version_id = vid and part_label = '' and option_position = pos;
      if not found then
        insert into cms.cms_version_wrong_answers (version_id, part_label, value, option_position, tag, mc_row_id, mc_item_no, target_row_id, why)
          values (vid, '', opt.text, pos, w ->> 'tag',
                  case when w ->> 'tag' = 'misconception' then w -> 'mc' ->> 'row_id' end,
                  case when w ->> 'tag' = 'misconception' then (w -> 'mc' ->> 'item_no')::int end,
                  case when w ->> 'tag' = 'concept_error' then w ->> 'target_row_id' end, nullif(btrim(w ->> 'why'), ''));
      end if;
    elsif jsonb_typeof(w -> 'mc') = 'object' then
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

create or replace function cms.cms_science_review_state(p_version_id bigint)
  returns jsonb
  language sql
  stable
  set search_path = ''
as $$
  select jsonb_build_object(
    'misconception', (select case when v.misconception_row_id is null then null else v.misconception_row_id || ' #' || v.misconception_item_no end
                        from cms.cms_question_versions v where v.version_id = p_version_id),
    'wrong_options', coalesce((select jsonb_object_agg(w.option_position::text,
                                   case when w.mc_row_id is not null then w.mc_row_id || ' #' || w.mc_item_no
                                        else w.tag || coalesce(' → ' || w.target_row_id, '') end)
                                 from cms.cms_version_wrong_answers w where w.version_id = p_version_id and w.tag is not null and w.option_position is not null), '{}'::jsonb),
    'primary', (select l.row_id || case when l.rank_proposed then ' (proposed)' else '' end from cms.cms_question_content_rows l
                 where l.version_id = p_version_id and l.rank = 'primary'),
    'solution1', (select s.text from cms.cms_version_solutions s where s.version_id = p_version_id and s.slot = 1));
$$;

-- ---------------------------------------------------------------- Q22 blockers view: the two new reasons (same columns)
create or replace view cms.cms_approval_blockers with (security_invoker = true) as
with cur as (
  select q.question_id, q.subject, q.class, q.chapter_id, q.topic_id, v.version_id, v.version_no, v.status, v.originality_pending, v.attributes_pending,
         v.image_status, v.misconception_targeted, v.misconception_row_id, v.misconception_item_no
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
    select 'attributes_pending', null where cur.attributes_pending
    union all
    select 'science_solution1_empty', null where cur.subject = 'science'
       and not exists (select 1 from cms.cms_version_solutions s where s.version_id = cur.version_id and s.slot = 1 and btrim(s.text) <> '')
    union all
    select 'science_primary_not_confirmed', null where cur.subject = 'science'
       and (select count(*) from cms.cms_question_content_rows l where l.version_id = cur.version_id and l.rank = 'primary' and not l.rank_proposed) <> 1
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

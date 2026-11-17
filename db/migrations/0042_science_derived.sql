-- Round 2, Iteration 2, Q29 (S4, Sambit 17 Nov 2026): derived values for Science, subject-aware. Schema cms only; adds only.
-- Plan: docs/plan-2026-11-17-round2.md §2 and §3; decisions §10.13–14.
--
-- Only Tier is stored (as Math's tier is): the version trigger sets it from the Science question type
--   (1–3 School · 4 Achiever · 5 Super Achiever; untyped → none). Math is unchanged (Strategy + Level, shared/derive.ts).
-- Computed, never stored, in view cms_science_derived (same formulas as shared/science-derive.ts; a DB test checks TS = SQL):
--   markers     count of: 2+ direct rows (primary + secondary) · Steps ≥ 3 · Inhibition = 3 · Hidden idea · Familiarity Rare
--   load        max(Reading, Steps band); bands in cms_config.science_steps_bands (1→1 · 2–3→2 · 4–5→3 · 6–8→4 · 9+→5);
--               a tie goes to reading; no working memory
--   trap_level  as Math: 2 if a wrong option is tagged misconception, 1 if shortcut, else 0
--   clone_key   primary row + type + setting (null until the type is set)
-- cms_question_list keeps its columns (clone_key gets a Science branch) and appends science_question_type and markers.

insert into cms.cms_config (key, value, note) values
  ('science_steps_bands', '[{"min":1,"max":1,"band":1},{"min":2,"max":3,"band":2},{"min":4,"max":5,"band":3},{"min":6,"max":8,"band":4},{"min":9,"max":null,"band":5}]',
   'Q29 (Round 2): Science load = max(Reading, Steps band)')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- the stored tier
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
  -- 0042 (Q29): a Science version's tier is derived from its Science question type and stored (as Math's tier is):
  -- type 1–3 → School · 4 → Achiever · 5 → Super Achiever; untyped → none. Math tiers are untouched (shared/derive.ts).
  if subj = 'science' then
    new.tier := case when new.science_question_type between 1 and 3 then 'School' when new.science_question_type = 4 then 'Achiever'
                     when new.science_question_type = 5 then 'Super Achiever' end;
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

-- Typed Science versions get their tier now (none on real on 17 Nov 2026: the 134 are untyped). Audited, before → after.
insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label)
select 'question_version', 'cms_question_versions', v.question_id || ' v' || v.version_no, 'derived_update', 'Science tier from the Science question type (Q29)',
       jsonb_build_object('tier', jsonb_build_object('before', v.tier, 'after',
         case when v.science_question_type between 1 and 3 then 'School' when v.science_question_type = 4 then 'Achiever' when v.science_question_type = 5 then 'Super Achiever' end)),
       'migration 0042'
  from cms.cms_question_versions v join cms.cms_questions q on q.question_id = v.question_id
 where q.subject = 'science' and v.tier is distinct from
       case when v.science_question_type between 1 and 3 then 'School' when v.science_question_type = 4 then 'Achiever' when v.science_question_type = 5 then 'Super Achiever' end;
update cms.cms_question_versions v set tier = case when v.science_question_type between 1 and 3 then 'School' when v.science_question_type = 4 then 'Achiever'
                                                   when v.science_question_type = 5 then 'Super Achiever' end
  from cms.cms_questions q
 where q.question_id = v.question_id and q.subject = 'science' and v.tier is distinct from
       case when v.science_question_type between 1 and 3 then 'School' when v.science_question_type = 4 then 'Achiever' when v.science_question_type = 5 then 'Super Achiever' end;

-- ---------------------------------------------------------------- computed values
create view cms.cms_science_derived with (security_invoker = true) as
select v.version_id, v.question_id, v.version_no,
       mk.n as markers, mk.list as marker_list,
       sb.band as steps_band,
       case when v.reading is null and sb.band is null then null else greatest(coalesce(v.reading, 0), coalesce(sb.band, 0)) end as load,
       case when v.reading is null and sb.band is null then null
            when v.reading is not null and v.reading >= coalesce(sb.band, 0) then 'reading' else 'multi_step' end as load_driver,
       case when exists (select 1 from cms.cms_version_wrong_answers w where w.version_id = v.version_id and w.tag = 'misconception') then 2
            when exists (select 1 from cms.cms_version_wrong_answers w where w.version_id = v.version_id and w.tag = 'shortcut') then 1 else 0 end as trap_level,
       pr.row_id as primary_row_id,
       case when v.science_question_type is null then null::text
            else md5(concat_ws('|', 'science', coalesce(pr.row_id, '-'), v.science_question_type::text, coalesce(q.setting_id, 'bare'))) end as clone_key
  from cms.cms_question_versions v
  join cms.cms_questions q on q.question_id = v.question_id and q.subject = 'science'
  left join lateral (select l.row_id from cms.cms_question_content_rows l where l.version_id = v.version_id and l.rank = 'primary' limit 1) pr on true
  left join lateral (
    select (b ->> 'band')::int as band
      from cms.cms_config c, jsonb_array_elements(c.value) b
     where c.key = 'science_steps_bands' and v.steps >= (b ->> 'min')::int and (b ->> 'max' is null or v.steps <= (b ->> 'max')::int)
     limit 1) sb on true
  cross join lateral (
    select count(*)::int as n, coalesce(array_agg(m.label order by m.ord), '{}') as list
      from (values (1, '2+ direct rows', (select count(*) from cms.cms_question_content_rows l where l.version_id = v.version_id and l.role = 'direct') >= 2),
                   (2, 'Steps ≥ 3', coalesce(v.steps >= 3, false)),
                   (3, 'Inhibition 3', coalesce(v.inhibition = 3, false)),
                   (4, 'Hidden idea', coalesce(v.has_hidden_idea, false)),
                   (5, 'Rare setting', coalesce(v.setting_familiarity = 'Rare', false))) as m(ord, label, hit)
     where m.hit) mk;
grant select on cms.cms_science_derived to authenticated;

-- ---------------------------------------------------------------- the list view: Science clone groups, type and markers
create or replace view cms.cms_question_list with (security_invoker = true) as
select q.question_id, q.bank, q.subject, q.file_key, q.chapter_id, q.topic_id, q.class, q.class_override, q.typical_set_id,
       q.pattern_id, q.clone_batch_id, q.current_version, q.approved_version, q.retired_at, v.version_id, v.status, v.text,
       v.format, v.math_difficulty, v.tier, v.strategy, v.load, v.trap_level, v.created_from, v.created_at as version_created_at,
       g.use as gold_use,
       q.bank = 'production' and q.retired_at is null and (v.status <> 'rejected' or q.approved_version is not null) as counted,
       q.level, coalesce(q.level, q.class) as effective_level, q.setting_id,
       case when q.subject = 'science' then sd.clone_key
            when q.pattern_id is null or v.attributes_pending then null::text
            else md5(concat_ws('|', q.pattern_id, v.math_difficulty, v.is_pure_fact, v.reading, v.has_irrelevant_info, v.steps, v.working_memory,
                               v.inhibition, v.visual, v.strategy, v.strategy_type, v.strategy_type_2, v.insight_id,
                               (select string_agg(c.part_label || ':' || c.concept_id || ':' || c.involvement::text, ',' order by c.part_label, c.concept_id)
                                  from cms.cms_version_concepts c where c.version_id = v.version_id)))
       end as clone_key,
       v.attributes_pending, v.originality_pending, v.image_status = 'needs_image' as image_pending,
       v.import_id, case when v.created_from = 'upload' then i.file_path end as upload_file,
       case when v.created_from = 'upload' then i.started_at end as uploaded_at,
       -- 0042 (Q29/Q34): Science question type and markers, for Browse filters (columns appended; Math rows get null)
       v.science_question_type, sd.markers
from cms.cms_questions q
join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
left join cms.cms_gold_meta g on g.question_id = q.question_id
left join cms.cms_imports i on i.import_id = v.import_id
left join cms.cms_science_derived sd on sd.version_id = v.version_id;

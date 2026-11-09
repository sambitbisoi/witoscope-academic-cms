-- Phase 6 (docs/phase6-plan.md, G1–G3, 9 Nov 2026): generated drafts are saved by the
-- browser through cms_apply_save (new "create" mode); runs and batch jobs are logged by
-- two admin-checked functions; the generation settings live in cms_config.

alter table cms.cms_reviews drop constraint cms_reviews_action_check;
alter table cms.cms_reviews add constraint cms_reviews_action_check check (action in (
  'submit', 'approve', 'reject', 'typo_fix', 'retire', 'restore', 'edit_catalogue', 'import_replace_draft',
  'edit_draft', 'new_version', 'withdraw', 'create'));

-- G3 defaults (configurable; never overwritten here).
insert into cms.cms_config (key, value, note) values
  ('ai_model', '"claude-sonnet-5-5"', 'Model for generation and tagging (G3)'),
  ('ai_effort', '"high"', 'Effort for generation (the API default)'),
  ('ai_max_drafts_per_run', '20', 'Drafts per run (G3); the AI function also caps this'),
  ('ai_daily_cap_usd', '5', 'Daily spend cap in USD (G3), Asia/Kolkata day'),
  ('similarity_threshold', '0.6', 'Duplicate / copy-from-source text similarity (G2)'),
  ('ai_prices', '{"claude-sonnet-5-5": {"input": 2, "output": 10, "cache_write": 2.5, "cache_read": 0.2}}', 'USD per million tokens; batch runs cost half')
on conflict (key) do nothing;

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
    if cur.status <> 'draft' then
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
    insert into cms.cms_version_wrong_answers (version_id, part_label, value, option_position, tag, misconception_id, target_concept_id, why)
      select vid, x.part_label, x.value, x.option_position, x.tag, x.misconception_id, x.target_concept_id, x.why
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


create function cms.cms_record_run(p jsonb)
  returns bigint
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  rid bigint;
begin
  if not cms.cms_is_admin(uid) then
    raise exception 'Only the CMS admin can log generation runs.' using errcode = '42501';
  end if;
  if p -> 'pack' is not null and jsonb_typeof(p -> 'pack') = 'object' then
    insert into cms.cms_tagging_packs (pack_version, rule_version, content, content_hash)
      values (p -> 'pack' ->> 'version', p -> 'pack' ->> 'rule_version', p -> 'pack' ->> 'content', p -> 'pack' ->> 'hash')
      on conflict (pack_version) do nothing;
  end if;
  if p ->> 'run_id' is null then
    insert into cms.cms_generation_runs (kind, model, pack_version, params, tokens_in, tokens_out, cost, status)
      values (p ->> 'kind', p ->> 'model', p -> 'pack' ->> 'version', coalesce(p -> 'params', '{}'),
              (p ->> 'tokens_in')::int, (p ->> 'tokens_out')::int, (p ->> 'cost')::numeric, coalesce(p ->> 'status', 'running'))
      returning run_id into rid;
  else
    update cms.cms_generation_runs set
      tokens_in = coalesce((p ->> 'tokens_in')::int, tokens_in), tokens_out = coalesce((p ->> 'tokens_out')::int, tokens_out),
      cost = coalesce((p ->> 'cost')::numeric, cost), status = coalesce(p ->> 'status', status),
      params = params || coalesce(p -> 'params', '{}')
      where run_id = (p ->> 'run_id')::bigint
      returning run_id into rid;
    if rid is null then raise exception 'Run % does not exist.', p ->> 'run_id'; end if;
  end if;
  return rid;
end;
$$;

create function cms.cms_save_job(p jsonb)
  returns bigint
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  jid bigint;
begin
  if not cms.cms_is_admin(uid) then
    raise exception 'Only the CMS admin can record jobs.' using errcode = '42501';
  end if;
  if p ->> 'job_id' is null then
    insert into cms.cms_jobs (type, status, progress, payload, started_at)
      values (p ->> 'type', coalesce(p ->> 'status', 'running'), coalesce((p ->> 'progress')::numeric, 0), coalesce(p -> 'payload', '{}'), now())
      returning job_id into jid;
  else
    update cms.cms_jobs set
      status = coalesce(p ->> 'status', status), progress = coalesce((p ->> 'progress')::numeric, progress),
      payload = payload || coalesce(p -> 'payload', '{}'), result = coalesce(p -> 'result', result), error = coalesce(p ->> 'error', error),
      finished_at = case when coalesce(p ->> 'status', status) in ('ok', 'failed', 'cancelled') then now() else finished_at end
      where job_id = (p ->> 'job_id')::bigint
      returning job_id into jid;
    if jid is null then raise exception 'Job % does not exist.', p ->> 'job_id'; end if;
  end if;
  return jid;
end;
$$;

revoke execute on function cms.cms_record_run(jsonb) from public;
revoke execute on function cms.cms_save_job(jsonb) from public;
grant execute on function cms.cms_record_run(jsonb) to authenticated;
grant execute on function cms.cms_save_job(jsonb) to authenticated;

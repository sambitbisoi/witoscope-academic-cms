-- Q38 PR 1 (Sambit, 23 Nov 2026): generation pack import, Science first. Schema cms only; adds only.
-- Plan: docs/plan-2026-11-23-q38-direct-generation.md §2 (pack mode), §9 (held-out generated), decisions §14.
--
--  * A generation run (cms_generation_runs kind 'pack') gets a CMS-issued run code GR0001…, its subject, route, engine
--    version, prompt hashes, models, CMS commit, rule version, mode (pilot / steady), counts and cost.
--  * cms_generation_items: one row per question of the run, keyed (run, local_id). It is the only matching there is
--    (never source_qid, never another run), the resume ledger (content hash per item) and the store of the engine's
--    warnings / "Warning reason" / check summary shown in review.
--  * Writes go only through admin-checked definer functions: the CMS admin (browser) or a Mac script whose session
--    user is cms_owner or cms_gen_writer (Route B, plan §8). One batch = one call = one transaction; each item runs in
--    its own sub-transaction, so one bad item is recorded as failed and never half-written.
--  * A generated question: bank production (never gold), status Needs review (in_review), created_from 'generation',
--    run_id, file key <chapter>-5001…9999 (the CMS-generated range, so QuestionBank's own keys can't collide),
--    attributes pending unless all drivers are set, originality pending when the pack says "not_checked" (Route A).
--  * Science: S1 fields, the 5 drivers, the setting (an existing Science setting, or a new one from the run, created
--    Proposed with a CMS SET id), linked rows with roles (primary / secondary / supporting; primary confirmed in pilot
--    runs, proposed in steady state), the misconception item, Solution 1 (+ optional 2), S7 wrong-option tags as row
--    items (never on the correct option), the local originality result (citations and scores only).
--  * The import never adds, edits or flags content rows, topics or catalogue items outside the run. A question whose topic is not
--    linked to its class is imported and the link is PROPOSED (Sambit decides it in Proposed; rollback retires it if still proposed).
--  * Level = the class of the question's primary row (DL-011), never the pack's or the run's class.
--  * Settings are one shared SET list (Q28). A Science run maps each free-text scene to the closest existing SET (or a new one,
--    Proposed); the scene text stays on the question as its setting note. A Math SET a Science run uses becomes subject 'both'
--    (audited; a rollback gives it back only when no question of that subject, retired ones included, uses it). cms_apply_save accepts a shared setting (one line changed).
--  * Unplaceable items go to the Held-out area with the pack item, and are placed from there (cms_gen_place_held).
--  * Rollback by run retires (never deletes) the run's questions that were never approved or edited.
--
-- CHECKs are only made wider. Nothing is dropped or renamed.

-- ---------------------------------------------------------------- runs
create sequence cms.cms_gr_seq;   -- GR0001 …

alter table cms.cms_generation_runs
  add column run_code       text unique check (run_code ~ '^GR[0-9]{4,6}$'),
  add column subject        text check (subject in ('math', 'science', 'grammar')),
  add column route          text check (route in ('A', 'B')),
  add column source_run     text,                          -- the engine's own run label, e.g. PILOT04
  add column engine_version text,
  add column prompt_hashes  jsonb not null default '{}',
  add column models         jsonb not null default '{}',   -- {writer, tagger, solver, quality, …}
  add column cms_commit     text,
  add column snapshot_id    text,
  add column rule_version   text,
  add column topics         text[] not null default '{}',
  add column mode           text check (mode in ('pilot', 'steady')),
  add column pack_sha256    text,
  add column review_sha256  text,                          -- the Mac review pack the approvals came from (pilot)
  add column counts         jsonb not null default '{}',
  add column cost_detail    jsonb not null default '{}',
  add column catalogue_map  jsonb not null default '{}',   -- {"settings": {"<local>": "SET042"}}
  add column import_id      bigint references cms.cms_imports (import_id),
  add column finished_at    timestamptz,
  add column rolled_back_at timestamptz,
  add column note           text;
alter table cms.cms_generation_runs drop constraint cms_generation_runs_kind_check;
alter table cms.cms_generation_runs add constraint cms_generation_runs_kind_check
  check (kind in ('generate_similar', 'fill_set', 'chapter', 'tag', 'pack'));
alter table cms.cms_generation_runs drop constraint cms_generation_runs_status_check;
alter table cms.cms_generation_runs add constraint cms_generation_runs_status_check
  check (status in ('running', 'ok', 'failed', 'importing', 'imported', 'partial', 'cancelled', 'rolled_back'));
alter table cms.cms_generation_runs add constraint cms_generation_runs_pack_fields
  check (kind <> 'pack' or (run_code is not null and subject is not null and route is not null and mode is not null and source_run is not null));
-- one live CMS run per engine run: a re-run of the same pack (or a later pass with more approvals) continues it
create unique index cms_generation_runs_one_live on cms.cms_generation_runs (subject, source_run)
  where kind = 'pack' and status <> 'rolled_back';

-- ---------------------------------------------------------------- items of a run
create table cms.cms_generation_items (
  run_id         bigint not null references cms.cms_generation_runs (run_id),
  local_id       text   not null check (local_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  status         text   not null check (status in ('imported', 'held', 'failed', 'dropped_near_copy', 'dropped_review', 'dropped_checks')),
  content_hash   text   not null check (content_hash ~ '^[0-9a-f]{64}$'),
  batch_no       int,
  question_id    text   references cms.cms_questions (question_id),
  version_id     bigint references cms.cms_question_versions (version_id),
  held_id        bigint references cms.cms_held_out (held_id),
  warnings       jsonb  not null default '[]',             -- [{kind, reason}] from the engine's checks
  warning_reason text,
  checks         jsonb  not null default '{}',             -- check summary (blind solve, quality, linked rows as the engine gave them)
  review         jsonb,                                    -- {decision, comment} from the Mac review pack
  error          text,                                     -- why it failed / was dropped
  import_id      bigint references cms.cms_imports (import_id),
  updated_at     timestamptz not null default now(),
  primary key (run_id, local_id),
  check ((status = 'imported') = (question_id is not null and version_id is not null)),
  check (status <> 'held' or held_id is not null)
);
create index cms_generation_items_question on cms.cms_generation_items (question_id) where question_id is not null;
create index cms_generation_items_status on cms.cms_generation_items (run_id, status);

alter table cms.cms_generation_items enable row level security;
grant select on cms.cms_generation_items to authenticated;
create policy cms_admin_only on cms.cms_generation_items for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

-- ---------------------------------------------------------------- held out: generated items keep their run
alter table cms.cms_held_out add column run_id bigint references cms.cms_generation_runs (run_id);
alter table cms.cms_held_out drop constraint cms_held_out_reason_code_check;
alter table cms.cms_held_out add constraint cms_held_out_reason_code_check check (reason_code in (
  'topic_missing', 'achievers_missing', 'topic_retired', 'topic_class', 'topic_chapter',
  'typical_set_missing', 'typical_set_class', 'pattern_missing', 'concept_missing',
  'misconception_missing', 'row_missing', 'other_placement', 'setting_missing', 'class_not_linked'));

-- ---------------------------------------------------------------- settings: one shared list (a setting may serve both subjects)
alter table cms.cms_settings drop constraint cms_settings_subject_check;
alter table cms.cms_settings add constraint cms_settings_subject_check check (subject in ('math', 'science', 'both'));

-- cms_apply_save as in 0041, with one change: a question may use a setting of its own subject OR a shared one ('both')
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
            and s.subject in (coalesce(q.subject, subj), 'both')) then
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

-- ---------------------------------------------------------------- imports + audit
alter table cms.cms_imports drop constraint cms_imports_kind_check;
alter table cms.cms_imports add constraint cms_imports_kind_check check (kind in (
  'chapter', 'topics', 'seed', 'sources', 'book', 'originality', 'proposals', 'figures', 'updates', 'upload', 'science', 'science_rationalise',
  'tier_recompute', 'held_out', 'held_out_place', 'concept_class', 'book_chapters', 'course_upload', 'generation_pack'));
alter table cms.cms_reviews drop constraint cms_reviews_action_check;
alter table cms.cms_reviews add constraint cms_reviews_action_check check (action in (
  'submit', 'approve', 'reject', 'typo_fix', 'retire', 'restore', 'edit_catalogue', 'import_replace_draft',
  'edit_draft', 'new_version', 'withdraw', 'create', 'remove_book_material', 'override_near_copy', 'import_update',
  'decline_override', 'review_status', 'originality_check', 'reorder', 'science_row', 'science_review', 'science_rationalise',
  'derived_update', 'held_out', 'held_out_place', 'held_out_discard',
  'course_save', 'course_status', 'course_upload', 'course_clone', 'course_copy',
  'gen_run_open', 'gen_run_close', 'gen_rollback'));

-- ---------------------------------------------------------------- settings
insert into cms.cms_config (key, value, note) values
  ('gen_steady_state', '{"math": {}, "science": {}}', 'Q38: per subject and class, true = steady state (everything that passed checks lands as Needs review); false or missing = pilot (only questions Sambit approved in the Mac review pack)'),
  ('gen_batch_size', '10', 'Q38: questions per import batch (one transaction each)')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- who may write (helper, not callable by the app user)
-- The CMS admin (browser, JWT) or a Mac script connected as cms_owner / cms_gen_writer. session_user is the login role
-- of the connection; a security definer function does not change it, and PostgREST logs in as authenticator.
create function cms.cms_gen_caller()
  returns text
  language sql
  stable
  set search_path = ''
as $$
  select case when cms.cms_is_admin(cms.cms_current_uid()) then 'admin'
              when session_user::text in ('cms_owner', 'cms_gen_writer') then session_user::text end;
$$;
revoke execute on function cms.cms_gen_caller() from public;

-- ---------------------------------------------------------------- open (or continue) a run
-- p = { subject, route, source_run, mode, engine_version, prompt_hashes, models, model, cms_commit, snapshot_id, rule_version,
--       topics, pack_sha256, review_sha256, cost, cost_detail, tokens_in, tokens_out, note,
--       settings: [{local_id, name, description?}],          new settings of the run (created Proposed, CMS SET ids)
--       import: {file_path, git_commit, file_hash, options} } one cms_imports row per import pass
create function cms.cms_gen_open_run(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  who text := cms.cms_gen_caller();
  uid uuid := cms.cms_current_uid();
  run cms.cms_generation_runs;
  imp bigint;
  s jsonb;
  sid text;
  smap jsonb;
  created boolean := false;
  steady boolean;
  shared jsonb;
  prev text;
begin
  if who is null then raise exception 'Only the CMS admin or the generation import can open a generation run.' using errcode = '42501'; end if;
  if coalesce(p ->> 'subject', '') not in ('math', 'science') then raise exception 'A generation run needs subject math or science.'; end if;
  if coalesce(p ->> 'route', '') not in ('A', 'B') then raise exception 'A generation run needs route A or B.'; end if;
  if coalesce(p ->> 'mode', '') not in ('pilot', 'steady') then raise exception 'A generation run needs mode pilot or steady.'; end if;
  if coalesce(btrim(p ->> 'source_run'), '') = '' then raise exception 'A generation run needs the engine''s run label (source_run).'; end if;
  -- steady state only where Sambit switched it on, for every class of the run (plan §2.7)
  if p ->> 'mode' = 'steady' then
    select bool_and(coalesce((c.value -> (p ->> 'subject') ->> x.cls)::boolean, false)) into steady
      from cms.cms_config c, jsonb_array_elements_text(coalesce(p -> 'classes', '[]')) as x(cls) where c.key = 'gen_steady_state';
    if not coalesce(steady, false) then
      raise exception 'Steady state is not enabled for every class of this run (cms_config gen_steady_state); import only the questions approved in the Mac review pack.';
    end if;
  end if;

  select * into run from cms.cms_generation_runs
   where kind = 'pack' and subject = p ->> 'subject' and source_run = p ->> 'source_run' and status <> 'rolled_back' for update;
  if not found then
    insert into cms.cms_generation_runs (kind, model, params, tokens_in, tokens_out, cost, status, run_code, subject, route, source_run,
                                         engine_version, prompt_hashes, models, cms_commit, snapshot_id, rule_version, topics, mode,
                                         pack_sha256, review_sha256, cost_detail, note)
      values ('pack', coalesce(p ->> 'model', p -> 'models' ->> 'writer', 'unknown'), '{}', (p ->> 'tokens_in')::int, (p ->> 'tokens_out')::int,
              (p ->> 'cost')::numeric, 'importing', 'GR' || lpad(nextval('cms.cms_gr_seq')::text, 4, '0'), p ->> 'subject', p ->> 'route',
              btrim(p ->> 'source_run'), p ->> 'engine_version', coalesce(p -> 'prompt_hashes', '{}'), coalesce(p -> 'models', '{}'),
              p ->> 'cms_commit', p ->> 'snapshot_id', p ->> 'rule_version',
              coalesce(array(select jsonb_array_elements_text(coalesce(p -> 'topics', '[]'))), '{}'), p ->> 'mode',
              p ->> 'pack_sha256', p ->> 'review_sha256', coalesce(p -> 'cost_detail', '{}'), p ->> 'note')
      returning * into run;
    created := true;
  else
    if run.route <> p ->> 'route' then raise exception 'Run % (%) is route %, not %.', run.run_code, run.source_run, run.route, p ->> 'route'; end if;
    update cms.cms_generation_runs set status = 'importing', mode = p ->> 'mode', pack_sha256 = coalesce(p ->> 'pack_sha256', pack_sha256),
           review_sha256 = coalesce(p ->> 'review_sha256', review_sha256), cms_commit = coalesce(p ->> 'cms_commit', cms_commit),
           cost = coalesce((p ->> 'cost')::numeric, cost), cost_detail = coalesce(p -> 'cost_detail', cost_detail)
     where run_id = run.run_id returning * into run;
  end if;

  insert into cms.cms_imports (kind, file_path, git_commit, file_hash, options)
    values ('generation_pack', coalesce(p -> 'import' ->> 'file_path', run.source_run), p -> 'import' ->> 'git_commit', p -> 'import' ->> 'file_hash',
            coalesce(p -> 'import' -> 'options', '{}') || jsonb_build_object('run_code', run.run_code, 'by', who))
    returning import_id into imp;
  update cms.cms_generation_runs set import_id = coalesce(import_id, imp) where run_id = run.run_id;

  -- new settings of the run: an existing setting of the same subject and name is reused; otherwise created Proposed
  smap := coalesce(run.catalogue_map -> 'settings', '{}');
  for s in select * from jsonb_array_elements(coalesce(p -> 'settings', '[]')) loop
    if smap ? (s ->> 'local_id') then continue; end if;
    if coalesce(btrim(s ->> 'name'), '') = '' then raise exception 'New setting % has no name.', s ->> 'local_id'; end if;
    select setting_id into sid from cms.cms_settings where lower(name) = lower(btrim(s ->> 'name')) and subject = run.subject and status <> 'retired';
    -- a setting retired only by a generation rollback comes back as Proposed (one Sambit retired stays retired)
    if sid is null then
      select st.setting_id into sid from cms.cms_settings st
       where lower(st.name) = lower(btrim(s ->> 'name')) and st.subject = run.subject and st.status = 'retired'
         and (select r.action from cms.cms_reviews r where r.target_table = 'cms_settings' and r.target_id = st.setting_id order by r.review_id desc limit 1) = 'gen_rollback';
      if sid is not null then
        update cms.cms_settings set status = 'proposed', updated_at = now() where setting_id = sid;
        insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label, import_id)
          values ('catalogue', 'cms_settings', sid, 'restore', 'used again by generation run ' || run.run_code || ' after a rollback',
                  jsonb_build_object('status', jsonb_build_object('before', 'retired', 'after', 'proposed')), uid, 'gen:' || run.run_code, imp);
      end if;
    end if;
    if sid is null then
      if exists (select 1 from cms.cms_settings where lower(name) = lower(btrim(s ->> 'name'))) then
        raise exception 'Setting "%" already exists for another subject or is retired; rename it in the pack.', btrim(s ->> 'name');
      end if;
      lock table cms.cms_settings in share row exclusive mode;
      select 'SET' || lpad((coalesce(max(substring(setting_id from '[0-9]+$')::int), 0) + 1)::text, 3, '0') into sid from cms.cms_settings;
      insert into cms.cms_settings (setting_id, name, description, status, subject, import_id)
        values (sid, btrim(s ->> 'name'), nullif(btrim(coalesce(s ->> 'description', '')), ''), 'proposed', run.subject, imp);
      insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label, import_id)
        values ('catalogue', 'cms_settings', sid, 'create', 'new setting from generation run ' || run.run_code || ' (' || run.source_run || ')',
                jsonb_build_object('status', jsonb_build_object('before', null, 'after', 'proposed'), 'name', btrim(s ->> 'name'), 'subject', run.subject),
                uid, 'gen:' || run.run_code, imp);
    end if;
    smap := smap || jsonb_build_object(s ->> 'local_id', sid);
    sid := null;
  end loop;
  update cms.cms_generation_runs set catalogue_map = catalogue_map || jsonb_build_object('settings', smap) where run_id = run.run_id;
  -- existing SETs the run maps its scenes to: a setting of the other subject becomes shared ('both'), audited
  shared := coalesce(run.catalogue_map -> 'shared', '{}');
  for sid in select jsonb_array_elements_text(coalesce(p -> 'share_settings', '[]')) loop
    select subject into prev from cms.cms_settings where setting_id = sid and status <> 'retired';
    if prev is null then raise exception 'Setting % is not in the CMS (or retired).', sid; end if;
    if prev in (run.subject, 'both') then continue; end if;
    update cms.cms_settings set subject = 'both', updated_at = now() where setting_id = sid;
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label, import_id)
      values ('catalogue', 'cms_settings', sid, 'edit_catalogue', 'shared with ' || run.subject || ': generation run ' || run.run_code || ' maps scenes to it',
              jsonb_build_object('subject', jsonb_build_object('before', prev, 'after', 'both')), uid, 'gen:' || run.run_code, imp);
    shared := shared || jsonb_build_object(sid, prev);
  end loop;
  sid := null;
  update cms.cms_generation_runs set catalogue_map = catalogue_map || jsonb_build_object('shared', shared) where run_id = run.run_id;

  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label, import_id)
    values ('catalogue', 'cms_generation_runs', run.run_code, 'gen_run_open',
            case when created then 'generation run opened' else 'generation run continued' end || ' (' || run.source_run || ', route ' || run.route || ', ' || run.mode || ')',
            jsonb_build_object('status', jsonb_build_object('before', case when created then null else 'continued' end, 'after', 'importing'),
                               'pack_sha256', p ->> 'pack_sha256', 'review_sha256', p ->> 'review_sha256'), uid, 'gen:' || run.run_code, imp);
  return jsonb_build_object('run_id', run.run_id, 'run_code', run.run_code, 'import_id', imp, 'created', created, 'settings', smap, 'shared', shared);
end;
$$;
revoke execute on function cms.cms_gen_open_run(jsonb) from public;
grant execute on function cms.cms_gen_open_run(jsonb) to authenticated;

-- ---------------------------------------------------------------- write ONE generated item (helper, not callable by the app user)
-- Returns {status: 'imported', question_id, version_id} or {status: 'held', held_id, reason}. Raises on a bad value
-- (the batch records it as failed). p_placing = true (from the Held-out area): a placement problem raises instead.
create function cms.cms_gen_write_item(run cms.cms_generation_runs, imp bigint, batch int, lid text, hash text, it jsonb,
                                       topic_override text, p_placing boolean)
  returns jsonb
  language plpgsql
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  t cms.cms_topics;
  tid text := coalesce(topic_override, it ->> 'topic_id');
  cls int := (it ->> 'class')::int;
  lvl int;                -- DL-011: the level is the class of the question's primary row (set below), never a run-level class
  link_proposed boolean := false;
  hold_code text;
  hold_why text;
  ch text;
  sid text;
  opts jsonb := coalesce(it -> 'options', '[]');
  nopt int;
  need int;
  ans int;
  fmt text := it ->> 'format';
  lr jsonb := coalesce(it -> 'linked_rows', '[]');
  l jsonb;
  w jsonb;
  wpos int;
  orig jsonb := it -> 'originality';
  not_checked boolean;
  keyno int;
  qid text;
  vid bigint;
  hid bigint;
  img_status text;
  img_path text;
begin
  if it ->> 'subject' is distinct from run.subject then raise exception 'Item % is %, but run % is %.', lid, it ->> 'subject', run.run_code, run.subject; end if;
  if run.subject <> 'science' then raise exception 'Only Science packs can be imported yet (Math pack import is PR 5 of Q38).'; end if;
  if cls is null or cls not between 1 and 6 then raise exception 'Item % needs a class 1–6.', lid; end if;
  select r.row_class into lvl from cms.cms_content_rows r
   where r.row_id = (select x ->> 'row_id' from jsonb_array_elements(lr) x where x ->> 'role' = 'primary' limit 1);

  -- ------------------------------------------------ placement (held out, never a failure)
  select * into t from cms.cms_topics where topic_id = tid;
  if not found then hold_code := 'topic_missing'; hold_why := format('topic %s is not in the CMS', tid);
  elsif left(t.topic_id, 2) <> 'ST' then raise exception 'Item %: topic % is not a Science topic.', lid, tid;
  elsif t.status <> 'active' then hold_code := 'topic_retired'; hold_why := format('topic %s is retired', tid);
  end if;
  if hold_code is null then
    select format('content row %s is not in the CMS (or retired)', x ->> 'row_id') into hold_why
      from jsonb_array_elements(lr) x
     where not exists (select 1 from cms.cms_content_rows r where r.row_id = x ->> 'row_id' and r.retired_at is null) limit 1;
    if hold_why is not null then hold_code := 'row_missing'; end if;
  end if;
  if hold_code is null and it -> 'setting' is not null and jsonb_typeof(it -> 'setting') = 'object' then
    sid := coalesce(it -> 'setting' ->> 'setting_id', run.catalogue_map -> 'settings' ->> (it -> 'setting' ->> 'new'));
    if sid is null or not exists (select 1 from cms.cms_settings s where s.setting_id = sid and s.subject in ('science', 'both') and s.status <> 'retired') then
      hold_code := 'setting_missing';
      hold_why := format('setting %s is not a Science setting in the CMS', coalesce(it -> 'setting' ->> 'setting_id', 'new ' || (it -> 'setting' ->> 'new')));
    end if;
  end if;
  if hold_code is not null then
    if p_placing then raise exception 'It still can''t be placed: %.', hold_why; end if;
    ch := coalesce(t.chapter_id, (select r.chapter_id from cms.cms_content_rows r join jsonb_array_elements(lr) x on (x ->> 'row_id' = r.row_id) limit 1));
    if ch is null then raise exception 'Item %: % and no chapter is known for it.', lid, hold_why; end if;
    if orig is not null and jsonb_typeof(orig) = 'object' and orig ->> 'result' = 'near_copy' then raise exception 'Item % is a near-copy; it is never stored.', lid; end if;
    insert into cms.cms_held_out (subject, batch, import_id, file, chapter_id, file_key, class, level, reason_code, reason, question, catalogue,
                                  proposed_by, originality, run_id)
      values ('science', 'generation ' || run.run_code || ' (' || run.source_run || ')', imp, 'pack ' || run.source_run, ch, run.run_code || '/' || lid,
              cls, lvl, hold_code, hold_why, it, '{}', null,
              case when orig is not null and jsonb_typeof(orig) = 'object' then orig end, run.run_id)
      returning held_id into hid;
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label, import_id)
      values ('question_version', 'cms_held_out', 'held #' || hid || ' ' || run.run_code || '/' || lid, 'held_out', hold_why,
              jsonb_build_object('status', jsonb_build_object('before', null, 'after', 'held'), 'reason_code', hold_code), uid, 'gen:' || run.run_code, imp);
    insert into cms.cms_generation_items (run_id, local_id, status, content_hash, batch_no, held_id, warnings, warning_reason, checks, review, error, import_id)
      values (run.run_id, lid, 'held', hash, batch, hid, coalesce(it -> 'warnings', '[]'), it ->> 'warning_reason', coalesce(it -> 'checks', '{}'), it -> 'review', hold_why, imp)
      on conflict (run_id, local_id) do update set status = 'held', content_hash = excluded.content_hash, batch_no = excluded.batch_no, held_id = excluded.held_id,
        question_id = null, version_id = null, warnings = excluded.warnings, warning_reason = excluded.warning_reason, checks = excluded.checks,
        review = excluded.review, error = excluded.error, import_id = excluded.import_id, updated_at = now();
    return jsonb_build_object('status', 'held', 'held_id', hid, 'reason', hold_why);
  end if;

  -- ------------------------------------------------ the topic is not linked to the question's class: import it and PROPOSE the link
  -- (Sambit decides it in Proposed, as for the links the Math and Science imports propose). An existing proposal of any status is left alone.
  if not exists (select 1 from cms.cms_topic_all_classes a where a.topic_id = t.topic_id and a.class = cls)
     and not exists (select 1 from cms.cms_topic_class_proposals pr where pr.topic_id = t.topic_id and pr.class = cls) then
    insert into cms.cms_topic_class_proposals (topic_id, class, source, evidence, suggested_role, import_id)
      values (t.topic_id, cls, 'generation ' || run.run_code, format('generated question %s (%s) is for class %s', lid, run.source_run, cls),
              case when t.class < cls then 'lower' else 'higher' end, imp);
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label, import_id)
      values ('catalogue', 'cms_topic_class_proposals', t.topic_id || ' · class ' || cls, 'create',
              'proposed by generation run ' || run.run_code || ': its questions are for this class, no link yet',
              jsonb_build_object('status', jsonb_build_object('before', null, 'after', 'proposed'), 'role', case when t.class < cls then 'lower' else 'higher' end,
                                 'home_class', t.class), uid, 'gen:' || run.run_code, imp);
    link_proposed := true;
  end if;

  -- ------------------------------------------------ values (a bad value fails this item only)
  if coalesce(btrim(it ->> 'text'), '') = '' then raise exception 'Item %: the question text is empty.', lid; end if;
  if fmt not in ('MCQ-4', 'MCQ-3', 'True/False') then raise exception 'Item %: format % is not MCQ-4, MCQ-3 or True/False.', lid, fmt; end if;
  nopt := jsonb_array_length(opts);
  need := case fmt when 'MCQ-4' then 4 when 'MCQ-3' then 3 else 2 end;
  if nopt <> need then raise exception 'Item %: % needs % options, it has %.', lid, fmt, need, nopt; end if;
  if fmt = 'True/False' and (btrim(opts ->> 0) <> 'True' or btrim(opts ->> 1) <> 'False') then raise exception 'Item %: True/False options must be "True", "False".', lid; end if;
  if exists (select 1 from jsonb_array_elements_text(opts) o where btrim(o) = '') then raise exception 'Item %: an option is empty.', lid; end if;
  if (select count(distinct lower(btrim(o))) from jsonb_array_elements_text(opts) o) <> nopt then raise exception 'Item %: two options are the same.', lid; end if;
  ans := position(upper(coalesce(it ->> 'answer', '')) in 'ABCD');
  if length(coalesce(it ->> 'answer', '')) <> 1 or ans = 0 or ans > nopt then raise exception 'Item %: answer "%" is not one of the options (A–%).', lid, it ->> 'answer', chr(64 + nopt); end if;
  if coalesce(btrim(it ->> 'solution_1'), '') = '' then raise exception 'Item %: Solution 1 is empty.', lid; end if;
  if jsonb_array_length(lr) = 0 then raise exception 'Item %: no linked content rows.', lid; end if;
  if (select count(*) from jsonb_array_elements(lr) x where x ->> 'role' = 'primary') <> 1 then raise exception 'Item %: it needs exactly one primary row.', lid; end if;
  if exists (select 1 from jsonb_array_elements(lr) x where coalesce(x ->> 'role', '') not in ('primary', 'secondary', 'supporting')) then
    raise exception 'Item %: a linked row role is not primary, secondary or supporting.', lid; end if;
  if (select count(distinct x ->> 'row_id') from jsonb_array_elements(lr) x) <> jsonb_array_length(lr) then raise exception 'Item %: a content row is linked twice.', lid; end if;
  if it -> 'misconception' is not null and jsonb_typeof(it -> 'misconception') = 'object' then
    if not exists (select 1 from jsonb_array_elements(lr) x where x ->> 'row_id' = it -> 'misconception' ->> 'row_id') then
      raise exception 'Item %: misconception % #% is not an item of one of its linked rows.', lid, it -> 'misconception' ->> 'row_id', it -> 'misconception' ->> 'item_no'; end if;
    if not exists (select 1 from cms.cms_row_misconceptions m where m.row_id = it -> 'misconception' ->> 'row_id' and m.item_no = (it -> 'misconception' ->> 'item_no')::int and m.status <> 'retired') then
      raise exception 'Item %: misconception % #% is not an item in the CMS.', lid, it -> 'misconception' ->> 'row_id', it -> 'misconception' ->> 'item_no'; end if;
  end if;
  for w in select * from jsonb_array_elements(coalesce(it -> 'wrong_option_tags', '[]')) loop
    wpos := position(upper(coalesce(w ->> 'option', '')) in 'ABCD');
    if length(coalesce(w ->> 'option', '')) <> 1 or wpos = 0 or wpos > nopt then raise exception 'Item %: a tag names option "%", which is not an option.', lid, w ->> 'option'; end if;
    if wpos = ans then raise exception 'Item %: the correct option (%) can''t be tagged.', lid, w ->> 'option'; end if;
    if w ->> 'tag' = 'misconception' then
      if not exists (select 1 from jsonb_array_elements(lr) x where x ->> 'row_id' = w ->> 'row_id')
         or not exists (select 1 from cms.cms_row_misconceptions m where m.row_id = w ->> 'row_id' and m.item_no = (w ->> 'item_no')::int and m.status <> 'retired') then
        raise exception 'Item %: option % misconception % #% is not an item of its linked rows.', lid, w ->> 'option', w ->> 'row_id', w ->> 'item_no'; end if;
    elsif w ->> 'tag' = 'concept_error' then
      if not exists (select 1 from jsonb_array_elements(lr) x where x ->> 'row_id' = w ->> 'row_id') then
        raise exception 'Item %: option % concept error needs a target row from its linked rows (%).', lid, w ->> 'option', coalesce(w ->> 'row_id', 'none'); end if;
    end if;
  end loop;
  if (select count(*) from jsonb_array_elements(coalesce(it -> 'wrong_option_tags', '[]')) x group by upper(x ->> 'option') order by 1 desc limit 1) > 1 then
    raise exception 'Item %: an option is tagged twice.', lid; end if;
  not_checked := orig is null or orig = '"not_checked"'::jsonb;
  if not not_checked then
    if jsonb_typeof(orig) <> 'object' or coalesce(orig ->> 'result', '') not in ('clear', 'flagged', 'no_sources') then
      raise exception 'Item %: originality must be "not_checked" or a result clear / flagged / no_sources (a near-copy is never stored).', lid; end if;
  end if;
  if it -> 'figure' is not null and jsonb_typeof(it -> 'figure') = 'object' then
    img_path := it -> 'figure' ->> 'key';
    if img_path !~ '^figures/[A-Za-z0-9._-]+\.png$' then raise exception 'Item %: figure key % is not figures/<name>.png.', lid, img_path; end if;
    img_status := 'has_image';
  elsif coalesce((it ->> 'figure_needed')::boolean, false) then
    img_status := 'needs_image';
  end if;

  -- ------------------------------------------------ write
  ch := t.chapter_id;
  perform pg_advisory_xact_lock(hashtext('cms_file_key:' || ch));
  select coalesce(max(substring(file_key from '-([0-9]+)$')::int), 5000) + 1 into keyno
    from cms.cms_questions where chapter_id = ch and substring(file_key from '-([0-9]+)$')::int between 5001 and 9999;
  if keyno > 9999 then raise exception 'Chapter % has used all generated keys (5001–9999).', ch; end if;
  qid := 'SQ' || lpad(nextval('cms.cms_sq_seq')::text, 6, '0');
  insert into cms.cms_questions (question_id, bank, subject, file_key, chapter_id, topic_id, class, level, locale, current_version, setting_id, setting_note)
    values (qid, 'production', 'science', ch || '-' || keyno, ch, t.topic_id, t.class, lvl, 'IN', 1, sid, nullif(btrim(coalesce(it ->> 'setting_note', '')), ''));
  insert into cms.cms_question_versions (
    question_id, version_no, status, topic_id, text, figure_description, image_status, image_path, format, correct, accepted, display_format,
    reading, steps, inhibition, visual, has_irrelevant_info, science_question_type, setting_familiarity, has_hidden_idea, has_experiment,
    misconception_row_id, misconception_item_no, safety_note, author_notes, tagging_why, content_hash, created_from, run_id, import_id,
    attributes_pending, originality_pending)
  values (
    qid, 1, 'in_review', t.topic_id, btrim(it ->> 'text'), nullif(btrim(coalesce(it ->> 'figure_description', '')), ''), img_status, img_path,
    fmt, btrim(opts ->> (ans - 1)), '{}', it ->> 'display_format',
    (it -> 'drivers' ->> 'reading')::int, (it -> 'drivers' ->> 'steps')::int, (it -> 'drivers' ->> 'inhibition')::int, (it -> 'drivers' ->> 'visual')::int,
    (it -> 'drivers' ->> 'irrelevant_info')::boolean, (it ->> 'science_question_type')::smallint, it ->> 'setting_familiarity',
    (it ->> 'hidden_idea')::boolean, (it ->> 'experiment')::boolean,
    it -> 'misconception' ->> 'row_id', (it -> 'misconception' ->> 'item_no')::int, it ->> 'safety_note', it ->> 'author_notes',
    case when jsonb_typeof(it -> 'tagging_why') = 'object' then it -> 'tagging_why' end,
    hash, 'generation', run.run_id, imp, true, not_checked)
  returning version_id into vid;
  insert into cms.cms_version_options (version_id, part_label, position, text, is_correct)
    select vid, '', o.n, btrim(o.v), o.n = ans from jsonb_array_elements_text(opts) with ordinality as o(v, n);
  insert into cms.cms_version_solutions (version_id, slot, text) values (vid, 1, btrim(it ->> 'solution_1'));
  if coalesce(btrim(it ->> 'solution_2'), '') <> '' then insert into cms.cms_version_solutions (version_id, slot, text, type) values (vid, 2, btrim(it ->> 'solution_2'), 'Another way'); end if;
  for l in select * from jsonb_array_elements(lr) loop
    insert into cms.cms_question_content_rows (version_id, row_id, role, rank, rank_proposed)
      values (vid, l ->> 'row_id', case l ->> 'role' when 'supporting' then 'supporting' else 'direct' end,
              case l ->> 'role' when 'primary' then 'primary' when 'secondary' then 'secondary' else 'context' end,
              l ->> 'role' = 'primary' and run.mode = 'steady');
  end loop;
  insert into cms.cms_version_wrong_answers (version_id, part_label, value, option_position, tag, mc_row_id, mc_item_no, target_row_id, why)
    select vid, '', btrim(opts ->> (position(upper(x ->> 'option') in 'ABCD') - 1)), position(upper(x ->> 'option') in 'ABCD'), x ->> 'tag',
           case when x ->> 'tag' = 'misconception' then x ->> 'row_id' end, case when x ->> 'tag' = 'misconception' then (x ->> 'item_no')::int end,
           case when x ->> 'tag' = 'concept_error' then x ->> 'row_id' end, nullif(btrim(coalesce(x ->> 'why', '')), '')
      from jsonb_array_elements(coalesce(it -> 'wrong_option_tags', '[]')) x;
  if not not_checked then
    insert into cms.cms_originality_checks (version_id, checked_at, result, similarity, same_numbers, closest_ref, field, checked, missing,
                                            threshold, near_copy_threshold, tool, import_id)
      values (vid, coalesce((orig ->> 'checked_at')::timestamptz, now()), orig ->> 'result', (orig ->> 'similarity')::numeric,
              coalesce((orig ->> 'same_numbers')::boolean, false), orig ->> 'closest_ref', orig ->> 'field',
              coalesce(orig -> 'checked', '[]'), coalesce(orig -> 'missing', '[]'), (orig ->> 'threshold')::numeric,
              (orig ->> 'near_copy_threshold')::numeric, orig ->> 'tool', imp);
  end if;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label, import_id)
    values ('question_version', 'cms_question_versions', qid || ' v1', 'create', 'generated (' || run.run_code || ', ' || lid || ')',
            jsonb_build_object('status', jsonb_build_object('before', null, 'after', 'in_review'), 'origin', 'generation', 'run', run.run_code,
                               'mode', run.mode, 'originality', case when not_checked then 'not_checked' else orig ->> 'result' end,
                               'flags', to_jsonb(array_remove(array['attributes_pending', case when img_status = 'needs_image' then 'image_pending' end,
                                                                      case when not_checked then 'originality_pending' end], null))),
            uid, 'gen:' || run.run_code, imp);
  insert into cms.cms_generation_items (run_id, local_id, status, content_hash, batch_no, question_id, version_id, warnings, warning_reason, checks, review, error, import_id)
    values (run.run_id, lid, 'imported', hash, batch, qid, vid, coalesce(it -> 'warnings', '[]'), it ->> 'warning_reason', coalesce(it -> 'checks', '{}'), it -> 'review', null, imp)
    on conflict (run_id, local_id) do update set status = 'imported', content_hash = excluded.content_hash, batch_no = coalesce(cms_generation_items.batch_no, excluded.batch_no),
      question_id = excluded.question_id, version_id = excluded.version_id, warnings = excluded.warnings, warning_reason = excluded.warning_reason,
      checks = excluded.checks, review = excluded.review, error = null, import_id = excluded.import_id, updated_at = now();
  return jsonb_build_object('status', 'imported', 'question_id', qid, 'version_id', vid, 'file_key', ch || '-' || keyno, 'level', lvl,
                            'link_proposed', case when link_proposed then t.topic_id || ' · class ' || cls end);
end;
$$;
revoke execute on function cms.cms_gen_write_item(cms.cms_generation_runs, bigint, int, text, text, jsonb, text, boolean) from public;

-- ---------------------------------------------------------------- one batch
-- p = { run_code, import_id, batch_no, items: [{local_id, content_hash, item} | {local_id, content_hash, drop: {status, reason}, item?}] }
-- Per item: already imported/held with the same hash → unchanged; with a different hash → 'changed' (never touched; stop and
-- look); failed or dropped before → tried again. Each item is its own sub-transaction: a bad value marks it failed.
create function cms.cms_gen_import_batch(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  who text := cms.cms_gen_caller();
  run cms.cms_generation_runs;
  imp bigint := (p ->> 'import_id')::bigint;
  batch int := (p ->> 'batch_no')::int;
  e jsonb;
  lid text;
  hash text;
  gi cms.cms_generation_items;
  r jsonb;
  res jsonb := '[]';
begin
  if who is null then raise exception 'Only the CMS admin or the generation import can import generated questions.' using errcode = '42501'; end if;
  select * into run from cms.cms_generation_runs where run_code = p ->> 'run_code' and kind = 'pack' for update;
  if not found then raise exception 'Generation run % does not exist.', p ->> 'run_code'; end if;
  if run.status not in ('importing', 'partial', 'imported') then raise exception 'Run % is %; it takes no more questions.', run.run_code, run.status; end if;
  if imp is null or not exists (select 1 from cms.cms_imports i where i.import_id = imp and i.kind = 'generation_pack') then raise exception 'The batch needs this pass''s import_id.'; end if;
  for e in select * from jsonb_array_elements(coalesce(p -> 'items', '[]')) loop
    lid := e ->> 'local_id'; hash := e ->> 'content_hash';
    if lid is null or coalesce(hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'A batch item needs local_id and a sha256 content_hash.'; end if;
    select * into gi from cms.cms_generation_items where run_id = run.run_id and local_id = lid for update;
    if found and gi.status in ('imported', 'held') then
      res := res || jsonb_build_object('local_id', lid, 'status', case when gi.content_hash = hash then 'unchanged' else 'changed' end,
                                       'question_id', gi.question_id, 'held_id', gi.held_id, 'was', gi.status);
      continue;
    end if;
    if e -> 'drop' is not null then
      if coalesce(e -> 'drop' ->> 'status', '') not in ('dropped_near_copy', 'dropped_review', 'dropped_checks') then raise exception 'Item %: unknown drop status.', lid; end if;
      insert into cms.cms_generation_items (run_id, local_id, status, content_hash, batch_no, warnings, warning_reason, checks, review, error, import_id)
        values (run.run_id, lid, e -> 'drop' ->> 'status', hash, batch, coalesce(e -> 'item' -> 'warnings', '[]'), e -> 'item' ->> 'warning_reason',
                coalesce(e -> 'item' -> 'checks', '{}'), e -> 'item' -> 'review', e -> 'drop' ->> 'reason', imp)
        on conflict (run_id, local_id) do update set status = excluded.status, content_hash = excluded.content_hash, batch_no = excluded.batch_no,
          warnings = excluded.warnings, warning_reason = excluded.warning_reason, checks = excluded.checks, review = excluded.review,
          error = excluded.error, import_id = excluded.import_id, updated_at = now();
      res := res || jsonb_build_object('local_id', lid, 'status', e -> 'drop' ->> 'status');
      continue;
    end if;
    begin
      r := cms.cms_gen_write_item(run, imp, batch, lid, hash, e -> 'item', null, false);
      res := res || (r || jsonb_build_object('local_id', lid));
    exception when others then
      insert into cms.cms_generation_items (run_id, local_id, status, content_hash, batch_no, warnings, warning_reason, checks, review, error, import_id)
        values (run.run_id, lid, 'failed', hash, batch, coalesce(e -> 'item' -> 'warnings', '[]'), e -> 'item' ->> 'warning_reason',
                coalesce(e -> 'item' -> 'checks', '{}'), e -> 'item' -> 'review', sqlerrm, imp)
        on conflict (run_id, local_id) do update set status = 'failed', content_hash = excluded.content_hash, batch_no = excluded.batch_no,
          error = excluded.error, import_id = excluded.import_id, updated_at = now();
      res := res || jsonb_build_object('local_id', lid, 'status', 'failed', 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('run_code', run.run_code, 'batch_no', batch, 'items', res);
end;
$$;
revoke execute on function cms.cms_gen_import_batch(jsonb) from public;
grant execute on function cms.cms_gen_import_batch(jsonb) to authenticated;

-- ---------------------------------------------------------------- close a pass
-- p = { run_code, import_id, counts?, note? } → run status imported (nothing failed) or partial; counts from the items
create function cms.cms_gen_close_run(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  who text := cms.cms_gen_caller();
  uid uuid := cms.cms_current_uid();
  run cms.cms_generation_runs;
  imp bigint := (p ->> 'import_id')::bigint;
  c jsonb;
  st text;
begin
  if who is null then raise exception 'Only the CMS admin or the generation import can close a generation run.' using errcode = '42501'; end if;
  select * into run from cms.cms_generation_runs where run_code = p ->> 'run_code' and kind = 'pack' for update;
  if not found then raise exception 'Generation run % does not exist.', p ->> 'run_code'; end if;
  select coalesce(jsonb_object_agg(status, n), '{}') into c from (select status, count(*) as n from cms.cms_generation_items where run_id = run.run_id group by status) x;
  st := case when coalesce((c ->> 'failed')::int, 0) > 0 then 'partial' else 'imported' end;
  update cms.cms_generation_runs set status = st, counts = coalesce(p -> 'counts', '{}') || jsonb_build_object('items', c), finished_at = now(), note = coalesce(p ->> 'note', note)
   where run_id = run.run_id;
  update cms.cms_imports set finished_at = now(), result = case st when 'imported' then 'ok' else 'partial' end,
         counts = coalesce(p -> 'counts', '{}') || jsonb_build_object('items', c), error_report = coalesce(p -> 'error_report', '[]')
   where import_id = imp and kind = 'generation_pack';
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label, import_id)
    values ('catalogue', 'cms_generation_runs', run.run_code, 'gen_run_close', 'import pass finished', jsonb_build_object('status', jsonb_build_object('before', run.status, 'after', st), 'items', c),
            uid, 'gen:' || run.run_code, imp);
  return jsonb_build_object('run_code', run.run_code, 'status', st, 'items', c);
end;
$$;
revoke execute on function cms.cms_gen_close_run(jsonb) from public;
grant execute on function cms.cms_gen_close_run(jsonb) to authenticated;

-- ---------------------------------------------------------------- rollback by run (retire, never delete)
-- p = { run_code, reason }. Retires the run's questions that were never approved and never edited (still v1, as imported);
-- lists and keeps the rest. Discards the run's open held-out items. Retires new settings of the run that nothing else uses.
create function cms.cms_gen_rollback(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  who text := cms.cms_gen_caller();
  uid uuid := cms.cms_current_uid();
  run cms.cms_generation_runs;
  why text := nullif(btrim(coalesce(p ->> 'reason', '')), '');
  x record;
  retired text[] := '{}';
  kept jsonb := '[]';
  discarded int := 0;
  sets text[] := '{}';
  links int := 0;
  unshared int := 0;
begin
  if who is null then raise exception 'Only the CMS admin or the generation import can roll back a generation run.' using errcode = '42501'; end if;
  if why is null then raise exception 'A rollback needs a reason.'; end if;
  select * into run from cms.cms_generation_runs where run_code = p ->> 'run_code' and kind = 'pack' for update;
  if not found then raise exception 'Generation run % does not exist.', p ->> 'run_code'; end if;
  if run.status = 'rolled_back' then raise exception 'Run % is already rolled back.', run.run_code; end if;
  for x in select q.question_id, q.approved_version, q.current_version, q.retired_at, v.edited_at, v.created_from, v.run_id
             from cms.cms_generation_items i join cms.cms_questions q on q.question_id = i.question_id
             join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
            where i.run_id = run.run_id and i.status = 'imported' order by q.question_id loop
    if x.retired_at is not null then continue; end if;
    if x.approved_version is not null or x.current_version <> 1 or x.edited_at is not null or x.run_id is distinct from run.run_id then
      kept := kept || jsonb_build_object('question_id', x.question_id, 'why', case when x.approved_version is not null then 'approved' else 'edited' end);
      continue;
    end if;
    update cms.cms_questions set retired_at = now() where question_id = x.question_id;
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
      values ('question_version', 'cms_questions', x.question_id, 'gen_rollback', 'rollback of ' || run.run_code || ': ' || why,
              jsonb_build_object('retired', jsonb_build_object('before', false, 'after', true)), uid, 'gen:' || run.run_code);
    retired := retired || x.question_id;
  end loop;
  for x in select h.held_id, h.file_key from cms.cms_held_out h where h.run_id = run.run_id and h.status = 'held' loop
    update cms.cms_held_out set status = 'discarded', decided_at = now(), decided_by = uid, note = 'rollback of ' || run.run_code || ': ' || why where held_id = x.held_id;
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
      values ('question_version', 'cms_held_out', 'held #' || x.held_id || ' ' || x.file_key, 'held_out_discard', 'rollback of ' || run.run_code || ': ' || why,
              jsonb_build_object('status', jsonb_build_object('before', 'held', 'after', 'discarded')), uid, 'gen:' || run.run_code);
    discarded := discarded + 1;
  end loop;
  -- settings this run created (import_id of one of its passes) that no live question uses
  for x in select s.setting_id from cms.cms_settings s
            where s.status = 'proposed' and s.setting_id in (select m.value from jsonb_each_text(coalesce(run.catalogue_map -> 'settings', '{}')) as m)
              and s.import_id in (select i.import_id from cms.cms_imports i where i.kind = 'generation_pack' and i.options ->> 'run_code' = run.run_code)
              and not exists (select 1 from cms.cms_questions q where q.setting_id = s.setting_id and q.retired_at is null) loop
    update cms.cms_settings set status = 'retired', updated_at = now() where setting_id = x.setting_id;
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
      values ('catalogue', 'cms_settings', x.setting_id, 'gen_rollback', 'rollback of ' || run.run_code || ': ' || why,
              jsonb_build_object('status', jsonb_build_object('before', 'proposed', 'after', 'retired')), uid, 'gen:' || run.run_code);
    sets := sets || x.setting_id;
  end loop;
  for x in select pr.topic_id, pr.class from cms.cms_topic_class_proposals pr
            where pr.status = 'proposed' and pr.source = 'generation ' || run.run_code loop
    update cms.cms_topic_class_proposals set status = 'retired', decided_at = now() where topic_id = x.topic_id and class = x.class;
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
      values ('catalogue', 'cms_topic_class_proposals', x.topic_id || ' · class ' || x.class, 'gen_rollback', 'rollback of ' || run.run_code || ': ' || why,
              jsonb_build_object('status', jsonb_build_object('before', 'proposed', 'after', 'retired')), uid, 'gen:' || run.run_code);
    links := links + 1;
  end loop;
  for x in select e.key as setting_id, e.value as prev from jsonb_each_text(coalesce(run.catalogue_map -> 'shared', '{}')) e loop
    -- given back only when no question of this subject uses it at all (retired ones keep their setting too)
    if exists (select 1 from cms.cms_questions q where q.setting_id = x.setting_id and q.subject = run.subject) then continue; end if;
    update cms.cms_settings set subject = x.prev, updated_at = now() where setting_id = x.setting_id and subject = 'both';
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
      values ('catalogue', 'cms_settings', x.setting_id, 'gen_rollback', 'rollback of ' || run.run_code || ': no ' || run.subject || ' question uses it any more',
              jsonb_build_object('subject', jsonb_build_object('before', 'both', 'after', x.prev)), uid, 'gen:' || run.run_code);
    unshared := unshared + 1;
  end loop;
  update cms.cms_generation_runs set status = 'rolled_back', rolled_back_at = now(), note = coalesce(note || ' · ', '') || 'rolled back: ' || why where run_id = run.run_id;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('catalogue', 'cms_generation_runs', run.run_code, 'gen_rollback', why,
            jsonb_build_object('status', jsonb_build_object('before', run.status, 'after', 'rolled_back'), 'retired', to_jsonb(retired), 'kept', kept,
                               'held_discarded', discarded, 'settings_retired', to_jsonb(sets), 'links_retired', links, 'settings_unshared', unshared), uid, 'gen:' || run.run_code);
  return jsonb_build_object('run_code', run.run_code, 'retired', to_jsonb(retired), 'kept', kept, 'held_discarded', discarded, 'settings_retired', to_jsonb(sets),
                            'links_retired', links, 'settings_unshared', unshared);
end;
$$;
revoke execute on function cms.cms_gen_rollback(jsonb) from public;
grant execute on function cms.cms_gen_rollback(jsonb) to authenticated;

-- ---------------------------------------------------------------- place a generated held-out item (Held-out area)
-- p = { held_id, topic_id?, note? }: the stored pack item is written exactly as the import would (same checks), on the
-- given topic (default: the item's own). Replaces the "re-run import:science --from-excel" path for generated Science.
create function cms.cms_gen_place_held(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  who text := cms.cms_gen_caller();
  uid uuid := cms.cms_current_uid();
  h cms.cms_held_out;
  run cms.cms_generation_runs;
  gi cms.cms_generation_items;
  imp bigint;
  r jsonb;
  why text := nullif(btrim(coalesce(p ->> 'note', '')), '');
begin
  if who is null then raise exception 'Only the CMS admin can place held-out items.' using errcode = '42501'; end if;
  select * into h from cms.cms_held_out where held_id = (p ->> 'held_id')::bigint for update;
  if not found then raise exception 'Held-out item % does not exist.', p ->> 'held_id'; end if;
  if h.run_id is null then raise exception 'Held-out item % is not from a generation run; place it with cms_place_held_out.', h.held_id; end if;
  if h.status <> 'held' then raise exception 'Held-out item % is already %.', h.held_id, h.status; end if;
  select * into run from cms.cms_generation_runs where run_id = h.run_id;
  if run.status = 'rolled_back' then raise exception 'Run % was rolled back; its items can''t be placed.', run.run_code; end if;
  select * into gi from cms.cms_generation_items where run_id = run.run_id and held_id = h.held_id;
  if not found then raise exception 'Held-out item % has no generation item.', h.held_id; end if;
  insert into cms.cms_imports (kind, file_path, file_hash, chapter_id, options)
    values ('held_out_place', h.file || ' · ' || h.file_key, gi.content_hash, h.chapter_id,
            jsonb_build_object('held_id', h.held_id, 'topic_id', coalesce(p ->> 'topic_id', h.question ->> 'topic_id'), 'batch', h.batch, 'run_code', run.run_code, 'by', 'Held-out area'))
    returning import_id into imp;
  r := cms.cms_gen_write_item(run, imp, gi.batch_no, gi.local_id, gi.content_hash, h.question, nullif(p ->> 'topic_id', ''), true);
  update cms.cms_held_out set status = 'placed', placed_question_id = r ->> 'question_id', placed_topic_id = coalesce(nullif(p ->> 'topic_id', ''), h.question ->> 'topic_id'),
         decided_at = now(), decided_by = uid, note = why where held_id = h.held_id;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label, import_id)
    values ('question_version', 'cms_held_out', 'held #' || h.held_id || ' ' || h.file_key, 'held_out_place', why,
            jsonb_build_object('status', jsonb_build_object('before', 'held', 'after', 'placed'), 'question_id', r ->> 'question_id'), uid,
            case who when 'admin' then 'Sambit' else 'gen:' || run.run_code end, imp);
  update cms.cms_imports set finished_at = now(), result = 'ok', counts = jsonb_build_object('placed', 1, 'question_id', r ->> 'question_id') where import_id = imp;
  return jsonb_build_object('question_id', r ->> 'question_id', 'import_id', imp);
end;
$$;
revoke execute on function cms.cms_gen_place_held(jsonb) from public;
grant execute on function cms.cms_gen_place_held(jsonb) to authenticated;

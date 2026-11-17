-- Round 1, Q21 (Sambit, 17 Nov 2026): the Held-out area. Schema cms only; adds only (new table, functions, wider CHECKs).
--
-- Items an import could not place for a PLACEMENT or CATALOGUE reason (topic or Achievers row missing or retired, topic in
-- another class or chapter, typical set / pattern / concept / misconception not in the CMS) are kept here with everything
-- needed to import them later: the question (our own wording, as in the chapter file), the catalogue items held with it
-- (in table-row shape), Level, the reason, a recommended topic and the local originality result (scores + citations only).
--
-- Book rule (CLAUDE.md): a NEAR-COPY is never stored here; it stays on the Mac (CHECK below + importers).
--
-- Actions (admin only, audited):
--   cms_place_held_out(p)      → imports it on a topic: new question ID with the ORIGINAL file key, v1 draft, the held catalogue
--                                items created as Proposed, the originality check recorded as the import would have (pending if none),
--                                one cms_imports row (kind held_out_place) and reviews. The browser computes the rows with the same
--                                shared code as the importer (checks, derived fields, Tier uses Level); the database re-checks placement.
--   cms_discard_held_out(id, reason) → Discarded (kept, never deleted).
-- Science items can be held and discarded here; they are placed by re-running import:science (not from this screen).

create table cms.cms_held_out (
  held_id              bigint generated always as identity primary key,
  subject              text not null check (subject in ('math', 'science', 'grammar')),
  batch                text not null,                 -- e.g. "2026-11-16 Math C1+C2" (where it came from)
  import_id            bigint references cms.cms_imports (import_id),
  file                 text not null,                 -- the chapter file (or master) name, e.g. MC58-C1.json
  chapter_id           text not null references cms.cms_chapters (chapter_id),
  file_key             text not null,
  class                int  not null check (class between 1 and 6),
  level                int  check (level between 1 and 6),
  reason_code          text not null check (reason_code in ('topic_missing', 'achievers_missing', 'topic_retired', 'topic_class', 'topic_chapter',
                                                             'typical_set_missing', 'typical_set_class', 'pattern_missing', 'concept_missing',
                                                             'misconception_missing', 'row_missing', 'other_placement')),
  reason               text not null,
  recommended_topic_id text references cms.cms_topics (topic_id),
  question             jsonb not null,                -- the chapter-file question (our own wording)
  catalogue            jsonb not null default '{}',   -- {concepts, misconceptions, typical_sets, patterns}: rows held with it
  proposed_by          text,                          -- the proposals file the catalogue items came from
  originality          jsonb,                         -- {checked_at, result, similarity, same_numbers, closest_ref, field, checked, missing,
                                                      --  threshold, near_copy_threshold, tool}; null = not checked yet
  status               text not null default 'held' check (status in ('held', 'placed', 'discarded')),
  placed_question_id   text references cms.cms_questions (question_id),
  placed_topic_id      text references cms.cms_topics (topic_id),
  decided_at           timestamptz,
  decided_by           uuid,
  note                 text,
  created_at           timestamptz not null default now(),
  check (originality is null or originality ->> 'result' in ('clear', 'flagged', 'no_sources')),   -- never a near-copy (book rule)
  check ((status = 'placed') = (placed_question_id is not null)),
  check ((status = 'held') = (decided_at is null))
);
create unique index cms_held_out_one_open on cms.cms_held_out (subject, file_key) where status = 'held';
create index cms_held_out_status on cms.cms_held_out (status, chapter_id);

alter table cms.cms_held_out enable row level security;
grant select on cms.cms_held_out to authenticated;
create policy cms_admin_only on cms.cms_held_out for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_reviews drop constraint cms_reviews_action_check;
alter table cms.cms_reviews add constraint cms_reviews_action_check check (action in (
  'submit', 'approve', 'reject', 'typo_fix', 'retire', 'restore', 'edit_catalogue', 'import_replace_draft',
  'edit_draft', 'new_version', 'withdraw', 'create', 'remove_book_material', 'override_near_copy', 'import_update',
  'decline_override', 'review_status', 'originality_check', 'reorder', 'science_row', 'science_review', 'science_rationalise',
  'derived_update', 'held_out', 'held_out_place', 'held_out_discard'));
alter table cms.cms_imports drop constraint cms_imports_kind_check;
alter table cms.cms_imports add constraint cms_imports_kind_check check (kind in (
  'chapter', 'topics', 'seed', 'sources', 'book', 'originality', 'proposals', 'figures', 'updates', 'upload', 'science', 'science_rationalise',
  'tier_recompute', 'held_out', 'held_out_place'));

-- ---------------------------------------------------------------- Place
-- p = { held_id, topic_id, content_hash, note?,
--       question: {class_override, placement_note, typical_set_id, pattern_id, clone_batch_id, locale},
--       version: {...version columns, as shared/save.ts rowsFor()}, parts, options, wrong_answers, concepts, solutions, hints, source_refs }
create function cms.cms_place_held_out(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  h cms.cms_held_out;
  t cms.cms_topics;
  ch cms.cms_chapters;
  pq jsonb := p -> 'question';
  v jsonb := p -> 'version';
  x jsonb;
  r cms.cms_question_versions;
  imp bigint;
  qid text;
  vid bigint;
  set_class int;
  why text := nullif(btrim(coalesce(p ->> 'note', '')), '');
begin
  if not cms.cms_is_admin(uid) then
    raise exception 'Only the CMS admin can place held-out items.' using errcode = '42501';
  end if;
  select * into h from cms.cms_held_out where held_id = (p ->> 'held_id')::bigint for update;
  if not found then raise exception 'Held-out item % does not exist.', p ->> 'held_id'; end if;
  if h.status <> 'held' then raise exception 'Held-out item % is already %.', h.held_id, h.status; end if;
  if h.subject <> 'math' then raise exception '% items are placed by re-running their importer (import:science --from-excel), not from here.', initcap(h.subject); end if;
  select * into t from cms.cms_topics where topic_id = p ->> 'topic_id';
  if not found then raise exception 'Topic % does not exist.', p ->> 'topic_id'; end if;
  if t.status <> 'active' then raise exception 'Topic % is retired.', t.topic_id; end if;
  if t.chapter_id <> h.chapter_id then raise exception 'Topic % belongs to chapter %, not %.', t.topic_id, t.chapter_id, h.chapter_id; end if;
  if t.class <> h.class then raise exception 'Topic % is Class %, but the item is Class % (its chapter file''s class).', t.topic_id, t.class, h.class; end if;
  if v ->> 'topic_id' is distinct from t.topic_id then raise exception 'The prepared rows are for topic %, not %.', v ->> 'topic_id', t.topic_id; end if;
  if coalesce(p ->> 'content_hash', '') !~ '^[0-9a-f]{64}$' then raise exception 'The rows have no valid structure fingerprint.'; end if;
  if exists (select 1 from cms.cms_questions q where q.file_key = h.file_key) then raise exception 'Key % is already in the CMS.', h.file_key; end if;
  select * into ch from cms.cms_chapters where chapter_id = h.chapter_id;

  insert into cms.cms_imports (kind, file_path, file_hash, chapter_id, options)
    values ('held_out_place', h.file || ' · ' || h.file_key, md5(p::text), h.chapter_id,
            jsonb_build_object('held_id', h.held_id, 'topic_id', t.topic_id, 'batch', h.batch, 'by', 'Held-out area'))
    returning import_id into imp;

  -- catalogue items held with it: created as Proposed when not in the CMS yet ('@topic' = the topic it is placed on);
  -- the same columns import:proposals writes
  for x in select * from jsonb_array_elements(coalesce(h.catalogue -> 'concepts', '[]')) loop
    if exists (select 1 from cms.cms_concepts c where c.concept_id = x ->> 'concept_id') then continue; end if;
    insert into cms.cms_concepts (concept_id, subject, class, topic_id, name, type, description, includes, excludes, example_question, curriculum_tags, status)
      select j.concept_id, j.subject, j.class, case when x ->> 'topic_id' = '@topic' then t.topic_id else j.topic_id end, j.name, j.type, j.description,
             j.includes, j.excludes, j.example_question, coalesce(j.curriculum_tags, '{}'), 'proposed'
        from jsonb_populate_record(null::cms.cms_concepts, x - 'topic_id' || jsonb_build_object('topic_id', nullif(x ->> 'topic_id', '@topic'))) j;
    insert into cms.cms_catalogue_proposals (item_kind, item_id, proposed_by, used_by, proposed_at, import_id)
      values ('concept', x ->> 'concept_id', coalesce(h.proposed_by, 'held out'), array[h.file_key], current_date, imp) on conflict (item_kind, item_id, proposed_by) do nothing;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(h.catalogue -> 'misconceptions', '[]')) loop
    if exists (select 1 from cms.cms_misconceptions m where m.misconception_id = x ->> 'misconception_id') then continue; end if;
    insert into cms.cms_misconceptions (misconception_id, concept_id, description, parent_description, status)
      select j.misconception_id, j.concept_id, j.description, j.parent_description, 'proposed' from jsonb_populate_record(null::cms.cms_misconceptions, x) j;
    insert into cms.cms_catalogue_proposals (item_kind, item_id, proposed_by, used_by, proposed_at, import_id)
      values ('misconception', x ->> 'misconception_id', coalesce(h.proposed_by, 'held out'), array[h.file_key], current_date, imp) on conflict (item_kind, item_id, proposed_by) do nothing;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(h.catalogue -> 'typical_sets', '[]')) loop
    if exists (select 1 from cms.cms_typical_sets s where s.typical_set_id = x ->> 'typical_set_id') then continue; end if;
    insert into cms.cms_typical_sets (typical_set_id, subject, class, chapter_id, topic_id, name, instruction_pattern, variant_note, status)
      select j.typical_set_id, j.subject, j.class, j.chapter_id, case when x ->> 'topic_id' = '@topic' then t.topic_id else j.topic_id end, j.name,
             j.instruction_pattern, j.variant_note, 'proposed'
        from jsonb_populate_record(null::cms.cms_typical_sets, x - 'topic_id' - 'concept_ids' || jsonb_build_object('topic_id', nullif(x ->> 'topic_id', '@topic'))) j;
    -- the set's concepts: the first listed is the main one (as import:proposals)
    insert into cms.cms_typical_set_concepts (typical_set_id, concept_id, role)
      select x ->> 'typical_set_id', c.v, case when c.n = 1 then 'main' else 'other' end
        from jsonb_array_elements_text(coalesce(x -> 'concept_ids', '[]')) with ordinality as c(v, n)
       where exists (select 1 from cms.cms_concepts k where k.concept_id = c.v)
      on conflict do nothing;
    insert into cms.cms_catalogue_proposals (item_kind, item_id, proposed_by, used_by, proposed_at, import_id)
      values ('typical_set', x ->> 'typical_set_id', coalesce(h.proposed_by, 'held out'), array[h.file_key], current_date, imp) on conflict (item_kind, item_id, proposed_by) do nothing;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(h.catalogue -> 'patterns', '[]')) loop
    if exists (select 1 from cms.cms_patterns q where q.pattern_id = x ->> 'pattern_id') then continue; end if;
    insert into cms.cms_patterns (pattern_id, topic_id, typical_set_id, name, template, variables, target_misconceptions, source_refs, notes, status)
      select j.pattern_id, t.topic_id, j.typical_set_id, j.name, j.template, coalesce(j.variables, '{}'), coalesce(j.target_misconceptions, '{}'),
             coalesce(j.source_refs, '{}'), j.notes, 'proposed'
        from jsonb_populate_record(null::cms.cms_patterns, x - 'topic_id') j;
    insert into cms.cms_catalogue_proposals (item_kind, item_id, proposed_by, used_by, proposed_at, import_id)
      values ('pattern', x ->> 'pattern_id', coalesce(h.proposed_by, 'held out'), array[h.file_key], current_date, imp) on conflict (item_kind, item_id, proposed_by) do nothing;
  end loop;

  -- the same placement checks the importer makes (the browser ran the full chapter-file checks first)
  if pq ->> 'typical_set_id' is not null then
    select s.class into set_class from cms.cms_typical_sets s where s.typical_set_id = pq ->> 'typical_set_id';
    if set_class is null then raise exception 'Typical set % does not exist.', pq ->> 'typical_set_id'; end if;
    if set_class <> t.class then raise exception 'Typical set % is Class %, but topic % is Class %.', pq ->> 'typical_set_id', set_class, t.topic_id, t.class; end if;
  end if;

  qid := case ch.subject when 'math' then 'MQ' || lpad(nextval('cms.cms_mq_seq')::text, 6, '0')
                         when 'science' then 'SQ' || lpad(nextval('cms.cms_sq_seq')::text, 6, '0')
                         else 'GQ' || lpad(nextval('cms.cms_gq_seq')::text, 6, '0') end;
  insert into cms.cms_questions (question_id, bank, subject, file_key, chapter_id, topic_id, class, class_override, placement_note,
                                 typical_set_id, pattern_id, clone_batch_id, locale, current_version, level)
    values (qid, 'production', ch.subject, h.file_key, h.chapter_id, t.topic_id, h.class, (pq ->> 'class_override')::int, pq ->> 'placement_note',
            pq ->> 'typical_set_id', pq ->> 'pattern_id', coalesce(pq ->> 'clone_batch_id', ''), coalesce(pq ->> 'locale', 'IN'), 1, h.level);
  r := jsonb_populate_record(null::cms.cms_question_versions, v);
  insert into cms.cms_question_versions (
    question_id, version_no, status, topic_id, typical_set_id, pattern_id, text, figure_description, image_status, image_path,
    format, correct, accepted, duration_s, math_difficulty, is_pure_fact, reading, has_irrelevant_info, steps, working_memory,
    inhibition, visual, strategy, strategy_type, strategy_type_2, strategy_other_note, insight_id, proposed_insight, trick_ref,
    multistep_band, load, load_driver, style, tier, trap_level, is_isolating, difficulty_points,
    tagging_why, tagged_by, tagging_summary, author_notes, content_hash, created_from, import_id, originality_pending)
  values (
    qid, 1, 'draft', t.topic_id, r.typical_set_id, r.pattern_id, r.text, r.figure_description, r.image_status, r.image_path,
    r.format, r.correct, coalesce(r.accepted, '{}'), r.duration_s, r.math_difficulty, r.is_pure_fact, r.reading, r.has_irrelevant_info,
    r.steps, r.working_memory, r.inhibition, r.visual, r.strategy, r.strategy_type, r.strategy_type_2, r.strategy_other_note,
    r.insight_id, r.proposed_insight, r.trick_ref, r.multistep_band, r.load, r.load_driver, r.style, r.tier, r.trap_level,
    r.is_isolating, r.difficulty_points, r.tagging_why, r.tagged_by, r.tagging_summary, r.author_notes,
    p ->> 'content_hash', 'import', imp, h.originality is null)
  returning version_id into vid;
  insert into cms.cms_version_parts (version_id, part_label, text, format, correct, accepted)
    select vid, y.part_label, y.text, y.format, y.correct, coalesce(y.accepted, '{}') from jsonb_populate_recordset(null::cms.cms_version_parts, coalesce(p -> 'parts', '[]')) y;
  insert into cms.cms_version_options (version_id, part_label, position, text, is_correct)
    select vid, y.part_label, y.position, y.text, y.is_correct from jsonb_populate_recordset(null::cms.cms_version_options, coalesce(p -> 'options', '[]')) y;
  insert into cms.cms_version_wrong_answers (version_id, part_label, value, option_position, tag, misconception_id, target_concept_id, why)
    select vid, y.part_label, y.value, y.option_position, y.tag, y.misconception_id, y.target_concept_id, y.why
      from jsonb_populate_recordset(null::cms.cms_version_wrong_answers, coalesce(p -> 'wrong_answers', '[]')) y;
  insert into cms.cms_version_concepts (version_id, part_label, concept_id, involvement)
    select vid, y.part_label, y.concept_id, y.involvement from jsonb_populate_recordset(null::cms.cms_version_concepts, coalesce(p -> 'concepts', '[]')) y;
  insert into cms.cms_version_solutions (version_id, slot, text, type, strategy)
    select vid, y.slot, y.text, y.type, y.strategy from jsonb_populate_recordset(null::cms.cms_version_solutions, coalesce(p -> 'solutions', '[]')) y;
  insert into cms.cms_version_hints (version_id, level, text)
    select vid, y.level, y.text from jsonb_populate_recordset(null::cms.cms_version_hints, coalesce(p -> 'hints', '[]')) y;
  insert into cms.cms_version_source_refs (version_id, ref_id, relation)
    select vid, y.ref_id, y.relation from jsonb_populate_recordset(null::cms.cms_version_source_refs, coalesce(p -> 'source_refs', '[]')) y;
  -- the local originality check, exactly as the import would have recorded it (scores + citations only)
  if h.originality is not null then
    insert into cms.cms_originality_checks (version_id, checked_at, result, similarity, same_numbers, closest_ref, field, checked, missing,
                                            threshold, near_copy_threshold, tool, import_id)
      values (vid, (h.originality ->> 'checked_at')::timestamptz, h.originality ->> 'result', (h.originality ->> 'similarity')::numeric,
              coalesce((h.originality ->> 'same_numbers')::boolean, false), h.originality ->> 'closest_ref', h.originality ->> 'field',
              coalesce(h.originality -> 'checked', '[]'), coalesce(h.originality -> 'missing', '[]'), (h.originality ->> 'threshold')::numeric,
              (h.originality ->> 'near_copy_threshold')::numeric, h.originality ->> 'tool', imp);
  end if;

  update cms.cms_held_out set status = 'placed', placed_question_id = qid, placed_topic_id = t.topic_id, decided_at = now(), decided_by = uid, note = why
   where held_id = h.held_id;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label, import_id) values
    ('question_version', 'cms_question_versions', qid || ' v1', 'create', 'placed from the Held-out area (' || h.batch || ', ' || h.file || ')',
     jsonb_build_object('status', jsonb_build_object('before', null, 'after', 'draft'), 'file_key', h.file_key, 'topic_id', t.topic_id,
                        'originality', coalesce(h.originality ->> 'result', 'pending')), uid, 'Sambit', imp),
    ('question_version', 'cms_held_out', 'held #' || h.held_id || ' ' || h.file_key, 'held_out_place', why,
     jsonb_build_object('status', jsonb_build_object('before', 'held', 'after', 'placed'), 'question_id', qid, 'topic_id', t.topic_id), uid, 'Sambit', imp);
  update cms.cms_imports set finished_at = now(), result = 'ok', counts = jsonb_build_object('placed', 1, 'question_id', qid) where import_id = imp;
  return jsonb_build_object('question_id', qid, 'import_id', imp);
end;
$$;
revoke execute on function cms.cms_place_held_out(jsonb) from public;
grant execute on function cms.cms_place_held_out(jsonb) to authenticated;

-- ---------------------------------------------------------------- Discard (kept, never deleted)
create function cms.cms_discard_held_out(p_held_id bigint, p_reason text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  h cms.cms_held_out;
begin
  if not cms.cms_is_admin(uid) then
    raise exception 'Only the CMS admin can discard held-out items.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Discarding needs a reason.'; end if;
  select * into h from cms.cms_held_out where held_id = p_held_id for update;
  if not found then raise exception 'Held-out item % does not exist.', p_held_id; end if;
  if h.status <> 'held' then raise exception 'Held-out item % is already %.', h.held_id, h.status; end if;
  update cms.cms_held_out set status = 'discarded', decided_at = now(), decided_by = uid, note = btrim(p_reason) where held_id = h.held_id;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('question_version', 'cms_held_out', 'held #' || h.held_id || ' ' || h.file_key, 'held_out_discard', btrim(p_reason),
            jsonb_build_object('status', jsonb_build_object('before', 'held', 'after', 'discarded')), uid, 'Sambit');
  return jsonb_build_object('held_id', h.held_id, 'status', 'discarded');
end;
$$;
revoke execute on function cms.cms_discard_held_out(bigint, text) from public;
grant execute on function cms.cms_discard_held_out(bigint, text) to authenticated;

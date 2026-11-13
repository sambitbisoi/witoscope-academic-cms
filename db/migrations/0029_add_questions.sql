-- Add and bulk-upload questions (Sambit, 13 Nov 2026). No AI anywhere in this feature.
-- Questions are added inside a topic in Browse, by hand ("+ Add question") or from an Excel
-- file ("Bulk upload"). Each one starts as Needs review (in_review) with flags:
--   created_from 'manual' | 'upload'  → badge "Manual" / "Uploaded (file, date)" (the upload is a cms_imports row)
--   attributes_pending                → signature and derived fields not evaluated yet (left out of clone groups)
--   image_status 'needs_image'        → "Image pending" (picture needed)
--   originality_pending               → the book check has not run yet; such a version cannot be approved
-- The originality check runs only on Sambit's Mac (npm run check:originality -- --pending), which
-- records the result and clears the flag. Book material never enters the CMS.

alter table cms.cms_question_versions
  add column attributes_pending  boolean not null default false,
  add column originality_pending boolean not null default false;

alter table cms.cms_question_versions drop constraint cms_question_versions_created_from_check;
alter table cms.cms_question_versions add constraint cms_question_versions_created_from_check
  check (created_from in ('import', 'edit', 'generation', 'seed', 'manual', 'upload'));

-- A wrong-answer note can be added before its tag is known (the tag is an attribute, set later).
alter table cms.cms_version_wrong_answers alter column tag drop not null;

alter table cms.cms_imports drop constraint cms_imports_kind_check;
alter table cms.cms_imports add constraint cms_imports_kind_check check (kind in (
  'chapter', 'topics', 'seed', 'sources', 'book', 'originality', 'proposals', 'figures', 'updates', 'upload'));

alter table cms.cms_reviews drop constraint cms_reviews_action_check;
alter table cms.cms_reviews add constraint cms_reviews_action_check check (action in (
  'submit', 'approve', 'reject', 'typo_fix', 'retire', 'restore', 'edit_catalogue', 'import_replace_draft',
  'edit_draft', 'new_version', 'withdraw', 'create', 'remove_book_material', 'override_near_copy', 'import_update',
  'decline_override', 'review_status', 'originality_check'));

-- Guards on every version write, whichever path it takes:
--  * a version whose originality check is pending can't become approved;
--  * attributes stop being pending once the signature is filled in (an Edit → Save that tags it);
--  * a new version of a question inherits "originality pending" from the version it replaces.
create function cms.cms_version_flags()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.created_from = 'edit' then
    new.originality_pending := coalesce((select v.originality_pending from cms.cms_question_versions v
                                          where v.question_id = new.question_id and v.version_no = new.version_no - 1), false);
  end if;
  if new.attributes_pending and new.reading is not null and new.steps is not null and new.working_memory is not null
     and new.inhibition is not null and new.visual is not null and new.strategy is not null and new.math_difficulty is not null then
    new.attributes_pending := false;
  end if;
  if new.status = 'approved' and new.originality_pending
     and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    raise exception 'v% of % can''t be approved yet: its originality check is pending (run the pending originality check from the Mac).',
      new.version_no, new.question_id;
  end if;
  return new;
end;
$$;
revoke execute on function cms.cms_version_flags() from public;
create trigger cms_version_flags before insert or update on cms.cms_question_versions
  for each row execute function cms.cms_version_flags();

-- Add questions to one topic: p = { topic_id, origin: 'manual' | 'upload', file_name?, skipped?: [...],
-- warnings?: [...], questions: [ { text, format, options[], correct, level, picture_needed, figure_description,
-- solution, hints[], wrong_answers[{value, why}], concepts[], typical_set_id, pattern_id, setting_id,
-- math_difficulty, source_refs[], author_notes, row } ] }. Admin only. Mandatory fields are checked
-- again here; optional IDs must exist (the browser drops unknown ones with a warning first).
create function cms.cms_add_questions(p jsonb)
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
    insert into cms.cms_version_wrong_answers (version_id, part_label, value, option_position, tag, why)
      select vid, '', btrim(w ->> 'value'), nullif(array_position(opts, btrim(w ->> 'value')), 0), null, nullif(btrim(coalesce(w ->> 'why', '')), '')
        from jsonb_array_elements(coalesce(x -> 'wrong_answers', '[]')) as w where coalesce(btrim(w ->> 'value'), '') <> '';
    insert into cms.cms_version_concepts (version_id, part_label, concept_id, involvement)
      select distinct vid, '', c, 1.0 from jsonb_array_elements_text(coalesce(x -> 'concepts', '[]')) as c where c <> '';
    insert into cms.cms_version_source_refs (version_id, ref_id, relation)
      select distinct vid, s, 'modelled_on' from jsonb_array_elements_text(coalesce(x -> 'source_refs', '[]')) as s where s <> '';
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
revoke execute on function cms.cms_add_questions(jsonb) from public;
grant execute on function cms.cms_add_questions(jsonb) to authenticated;

-- Browse / Review: the new flags, the upload behind an "Uploaded" badge; attributes-pending
-- questions are left out of clone groups. Columns are appended; clone_key is unchanged otherwise.
create or replace view cms.cms_question_list with (security_invoker = true) as
select q.question_id, q.bank, q.subject, q.file_key, q.chapter_id, q.topic_id, q.class, q.class_override, q.typical_set_id,
       q.pattern_id, q.clone_batch_id, q.current_version, q.approved_version, q.retired_at, v.version_id, v.status, v.text,
       v.format, v.math_difficulty, v.tier, v.strategy, v.load, v.trap_level, v.created_from, v.created_at as version_created_at,
       g.use as gold_use,
       q.bank = 'production' and q.retired_at is null and (v.status <> 'rejected' or q.approved_version is not null) as counted,
       q.level, coalesce(q.level, q.class) as effective_level, q.setting_id,
       case when q.pattern_id is null or v.attributes_pending then null::text
            else md5(concat_ws('|', q.pattern_id, v.math_difficulty, v.is_pure_fact, v.reading, v.has_irrelevant_info, v.steps, v.working_memory,
                               v.inhibition, v.visual, v.strategy, v.strategy_type, v.strategy_type_2, v.insight_id,
                               (select string_agg(c.part_label || ':' || c.concept_id || ':' || c.involvement::text, ',' order by c.part_label, c.concept_id)
                                  from cms.cms_version_concepts c where c.version_id = v.version_id)))
       end as clone_key,
       v.attributes_pending, v.originality_pending, v.image_status = 'needs_image' as image_pending,
       v.import_id, case when v.created_from = 'upload' then i.file_path end as upload_file,
       case when v.created_from = 'upload' then i.started_at end as uploaded_at
from cms.cms_questions q
join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
left join cms.cms_gold_meta g on g.question_id = q.question_id
left join cms.cms_imports i on i.import_id = v.import_id;

create or replace view cms.cms_review_queue with (security_invoker = true) as
select l.question_id, l.bank, l.subject, l.file_key, l.chapter_id, l.topic_id, l.class, l.typical_set_id, l.pattern_id,
       l.current_version, l.approved_version, l.version_id, l.status, l.text, l.math_difficulty, l.version_created_at,
       n.action as note_action, n.reason as note, n.at as noted_at,
       l.created_from, l.attributes_pending, l.originality_pending, l.image_pending, l.upload_file, l.uploaded_at
from cms.cms_question_list l
left join lateral (
  select r.action, r.reason, r.at from cms.cms_reviews r
   where r.target_id = l.question_id || ' v' || l.current_version and r.action in ('submit', 'reject')
   order by r.review_id desc limit 1) n on true
where l.status in ('in_review', 'rejected') and l.retired_at is null;

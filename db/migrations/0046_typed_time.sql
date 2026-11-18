-- 0046 · Q36 (18 Nov 2026): the Typed-time answer format.
-- The child sees two boxes hh : mm with the colon printed (no a.m./p.m. typed); the answer is stored h:mm
-- (e.g. 7:30, 11:05) and is checked numerically per box (3 = 03). Adds only:
--   1. the two format CHECKs (versions, parts) gain 'Typed-time' (every existing row still passes);
--   2. cms_add_questions (add by hand / Excel upload) accepts Typed-time and checks the h:mm shape.
--      The function below is 0035's, unchanged except for the format list and the Typed-time branch (marked Q36).
-- No data changes.

alter table cms.cms_question_versions drop constraint cms_question_versions_format_check;
alter table cms.cms_question_versions add constraint cms_question_versions_format_check
  check (format in ('MCQ-4', 'MCQ-3', 'True/False', 'Typed-number', 'Typed-decimal', 'Typed-fraction', 'Typed-text', 'Typed-time', 'Multi-part'));
alter table cms.cms_version_parts drop constraint cms_version_parts_format_check;
alter table cms.cms_version_parts add constraint cms_version_parts_format_check
  check (format in ('MCQ-4', 'MCQ-3', 'True/False', 'Typed-number', 'Typed-decimal', 'Typed-fraction', 'Typed-text', 'Typed-time'));

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
    if fmt is null or fmt not in ('MCQ-4', 'MCQ-3', 'True/False', 'Typed-number', 'Typed-decimal', 'Typed-fraction', 'Typed-text', 'Typed-time') then  -- Q36: + Typed-time
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
    elsif fmt = 'Typed-time' then
      -- Q36: stored h:mm (hours 0–23 without a leading zero, minutes 00–59); no a.m./p.m.
      opts := '{}';
      if correct !~ '^([0-9]|1[0-9]|2[0-3]):[0-5][0-9]$' then
        raise exception 'Row %: a Typed-time answer must be h:mm (e.g. 7:30; hours without a leading zero; no a.m./p.m.), not "%".', x ->> 'row', correct;
      end if;
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

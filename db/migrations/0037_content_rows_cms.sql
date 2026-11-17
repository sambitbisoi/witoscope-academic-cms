-- Round 1, Q14 (Sambit, 17 Nov 2026): the CMS is the master for Science content rows (the Excel master is retired).
-- Schema cms only; adds only (wider CHECKs, new columns, one new admin function, a view re-created with a column appended).
--
--  * "+ Add content row" and "Edit" save through ONE admin-checked, audited function, cms_save_content_row(p):
--    create / update / retire / restore a row, and add / edit / retire / restore its misconception items in the same Save.
--  * New rows: source 'CMS', no originality check (Sambit's own writing; the originality fields stay empty).
--    ID = C<row class>-<code>-<next>: <code> is a chapter code already used by the topic's rows of that row class, or 'CMS'
--    (a separate CMS series); <next> = highest number ever used for that prefix + 1 (retired rows count). IDs never change.
--  * Rows and items are never deleted: Retire / Restore. A row can't be retired while a current, non-retired question
--    uses it as a DIRECT row (the function names them); supporting links are allowed (the screen warns).
--  * Items added in the CMS are active at once (source 'cms'); numbers are never reused. An item's text can be edited
--    in place (audited; the screen lists the questions that use it first). The row's legacy `misconceptions` text is
--    kept equal to its active items, in order (joined by a space after end punctuation, else by "; ").
--  * Every change: one cms_reviews row (before → after). cms_edited_at marks rows changed in the CMS, which
--    import:science (now only with --from-excel) never overwrites.

alter table cms.cms_content_rows
  add column retired_at     timestamptz,
  add column retired_reason text,
  add column cms_edited_at  timestamptz,
  add constraint cms_content_rows_retired_reason check (retired_at is null or coalesce(btrim(retired_reason), '') <> '');
alter table cms.cms_content_rows drop constraint cms_content_rows_source_check;
alter table cms.cms_content_rows add constraint cms_content_rows_source_check check (source in ('Book', 'Claude-added', 'CMS'));
alter table cms.cms_row_misconceptions drop constraint cms_row_misconceptions_source_check;
alter table cms.cms_row_misconceptions add constraint cms_row_misconceptions_source_check check (source in ('row split', 'from question', 'cms'));

insert into cms.cms_config (key, value, note) values
  ('content_rows_owner', '"cms"', 'Who owns Science content rows: "cms" since 17 Nov 2026 (Q14). import:science runs only with --from-excel and never overwrites rows edited in the CMS')
on conflict (key) do nothing;

-- Row status (0035) + retired_at appended (existing columns unchanged).
create or replace view cms.cms_content_row_status with (security_invoker = true) as
select r.row_id, r.topic_id, r.chapter_id, r.row_class, r.type, r.question_use, r.in_master,
       coalesce(l.n_direct, 0)::int as n_direct, coalesce(l.n_supporting, 0)::int as n_supporting,
       case when coalesce(l.n_direct, 0) > 0 then 'direct'
            when coalesce(l.n_supporting, 0) > 0 then 'supporting'
            when r.question_use <> 'OK' then 'not_eligible'
            else 'none' end as status,
       coalesce(l.n_primary, 0)::int as n_primary, coalesce(l.n_secondary, 0)::int as n_secondary,
       r.retired_at
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
  'decline_override', 'review_status', 'originality_check', 'reorder', 'science_row', 'science_review', 'science_rationalise',
  'derived_update'));

-- ---------------------------------------------------------------- the one write path
-- p = { mode: 'create' | 'update' | 'retire' | 'restore', row_id? (not for create), reason?,
--       create: topic_id, code,  (row_class is part of `fields`)
--       fields?: { row_class, type, chapter_role, content, why_it_matters, diagram_description, question_use, safety,
--                  also_in_rows: [row ids], notes, picture_question, confidence },
--       items?: [ { item_no: null (new) | n, text?, action: 'add' | 'edit' | 'retire' | 'restore' } ] }
create function cms.cms_save_content_row(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  mode text := p ->> 'mode';
  f jsonb := coalesce(p -> 'fields', '{}'::jsonb);
  t cms.cms_topics;
  subj text;
  r cms.cms_content_rows;
  b jsonb;          -- row before (editable fields)
  a jsonb;          -- row after
  rid text;
  code text;
  cls int;
  prefix text;
  nextno int;
  it jsonb;
  item cms.cms_row_misconceptions;
  ino int;
  using_q text[];
  diff jsonb;
  k text;
  n_items int := 0;
  mtext text;
  editable text[] := array['row_class', 'type', 'chapter_role', 'content', 'why_it_matters', 'diagram_description', 'question_use',
                           'safety', 'also_in_rows', 'notes', 'picture_question', 'confidence'];
  why text := nullif(btrim(coalesce(p ->> 'reason', '')), '');
begin
  if not cms.cms_is_admin(uid) then
    raise exception 'Only the CMS admin can edit content rows.' using errcode = '42501';
  end if;
  if mode is null or mode not in ('create', 'update', 'retire', 'restore') then raise exception 'Unknown mode "%".', mode; end if;

  -- field checks (create and update)
  if mode in ('create', 'update') then
    if f ? 'content' and coalesce(btrim(f ->> 'content'), '') = '' then raise exception 'Content is required.'; end if;
    if f ? 'row_class' and ((f ->> 'row_class') !~ '^[1-6]$') then raise exception 'Row class must be 1–6.'; end if;
    if f ? 'type' and (f ->> 'type') not in ('Fact', 'Concept', 'How it works', 'Experiment', 'Scenario-Case', 'Diagram', 'Vocabulary') then
      raise exception 'Type "%" is not allowed.', f ->> 'type'; end if;
    if f ? 'chapter_role' and (f ->> 'chapter_role') not in ('Core', 'Extension', 'Preview') then raise exception 'Chapter role "%" is not allowed.', f ->> 'chapter_role'; end if;
    if f ? 'question_use' and (f ->> 'question_use') not in ('OK', 'Misconception only', 'No questions') then raise exception 'Question use "%" is not allowed.', f ->> 'question_use'; end if;
    if f ? 'confidence' and f ->> 'confidence' is not null and (f ->> 'confidence') not in ('high', 'medium', 'low') then raise exception 'Confidence "%" is not allowed.', f ->> 'confidence'; end if;
    if f ? 'also_in_rows' then
      select string_agg(x, ', ') into k from jsonb_array_elements_text(coalesce(f -> 'also_in_rows', '[]')) x
       where not exists (select 1 from cms.cms_content_rows c where c.row_id = x);
      if k is not null then raise exception 'Also in: % is not a content row.', k; end if;
    end if;
  end if;

  if mode = 'create' then
    select * into t from cms.cms_topics where topic_id = p ->> 'topic_id';
    if not found then raise exception 'Topic % does not exist.', p ->> 'topic_id'; end if;
    if t.status <> 'active' then raise exception 'Topic % is retired.', t.topic_id; end if;
    select c.subject into subj from cms.cms_chapters c where c.chapter_id = t.chapter_id;
    if subj <> 'science' then raise exception 'Content rows are Science only; % is %.', t.topic_id, subj; end if;
    if coalesce(btrim(f ->> 'content'), '') = '' then raise exception 'Content is required.'; end if;
    cls := (f ->> 'row_class')::int;
    if cls is null then raise exception 'Row class is required.'; end if;
    code := upper(btrim(coalesce(p ->> 'code', '')));
    if code !~ '^[0-9A-Z]{2,4}$' then raise exception 'Chapter code "%" must be 2–4 letters or digits.', code; end if;
    if code <> 'CMS' and not exists (select 1 from cms.cms_content_rows c where c.topic_id = t.topic_id and c.row_id like 'C' || cls || '-' || code || '-%') then
      raise exception 'Code % is not used by the Class % rows of topic %; use one of its codes or CMS.', code, cls, t.topic_id;
    end if;
    prefix := 'C' || cls || '-' || code || '-';
    perform pg_advisory_xact_lock(hashtext('cms_content_rows ' || prefix));
    select coalesce(max(substring(row_id from '-([0-9]{3})$')::int), 0) + 1 into nextno from cms.cms_content_rows where row_id like prefix || '%';
    if nextno > 999 then raise exception 'All 999 numbers of % are used.', prefix; end if;
    rid := prefix || lpad(nextno::text, 3, '0');
    insert into cms.cms_content_rows (row_id, topic_id, chapter_id, row_class, type, chapter_role, content, why_it_matters, misconceptions,
        diagram_description, picture_question, question_use, safety, source, confidence, notes, master_file, book, book_chapter_no, book_chapter_title,
        sort, in_master, content_hash, also_in_rows, cms_edited_at)
      select rid, t.topic_id, t.chapter_id, cls, f ->> 'type', f ->> 'chapter_role', btrim(f ->> 'content'), nullif(btrim(coalesce(f ->> 'why_it_matters', '')), ''), null,
             nullif(btrim(coalesce(f ->> 'diagram_description', '')), ''), coalesce((f ->> 'picture_question')::boolean, false), coalesce(f ->> 'question_use', 'OK'),
             nullif(btrim(coalesce(f ->> 'safety', '')), ''), 'CMS', f ->> 'confidence', nullif(btrim(coalesce(f ->> 'notes', '')), ''), null,
             -- "Filed under" (a citation) is taken from the prefix's other rows; a CMS-series row has none
             s.book, s.book_chapter_no, s.book_chapter_title,
             (select coalesce(max(sort), 0) + 1 from cms.cms_content_rows), true, 'cms',
             coalesce(array(select jsonb_array_elements_text(coalesce(f -> 'also_in_rows', '[]'))), '{}'), now()
        from (select null) x
        left join lateral (select c.book, c.book_chapter_no, c.book_chapter_title from cms.cms_content_rows c
                            where code <> 'CMS' and c.row_id like prefix || '%' order by c.row_id desc limit 1) s on true;
    select * into r from cms.cms_content_rows where row_id = rid;
    b := null;
  else
    rid := p ->> 'row_id';
    select * into r from cms.cms_content_rows where row_id = rid for update;
    if not found then raise exception 'Content row % does not exist.', rid; end if;
    select c.subject into subj from cms.cms_chapters c where c.chapter_id = r.chapter_id;
    b := (select jsonb_object_agg(e.key, e.value) from jsonb_each(to_jsonb(r)) e where e.key = any(editable || array['misconceptions']));
  end if;

  if mode = 'retire' then
    if r.retired_at is not null then raise exception 'Row % is already retired.', rid; end if;
    if why is null then raise exception 'Retiring a row needs a reason.'; end if;
    select array_agg(distinct q.question_id order by q.question_id) into using_q
      from cms.cms_question_content_rows l
      join cms.cms_question_versions v on v.version_id = l.version_id
      join cms.cms_questions q on q.question_id = v.question_id and q.current_version = v.version_no and q.retired_at is null
     where l.row_id = rid and l.role = 'direct';
    if using_q is not null then
      raise exception 'Row % is the direct row of %; move or retire those questions first.', rid, array_to_string(using_q, ', ');
    end if;
    update cms.cms_content_rows set retired_at = now(), retired_reason = why, cms_edited_at = now(), updated_at = now() where row_id = rid;
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
      values ('catalogue', 'cms_content_rows', rid, 'retire', why, jsonb_build_object('retired', jsonb_build_object('before', false, 'after', true)), uid, 'Sambit');
    return jsonb_build_object('row_id', rid, 'changed', true);
  elsif mode = 'restore' then
    if r.retired_at is null then raise exception 'Row % is not retired.', rid; end if;
    update cms.cms_content_rows set retired_at = null, retired_reason = null, cms_edited_at = now(), updated_at = now() where row_id = rid;
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
      values ('catalogue', 'cms_content_rows', rid, 'restore', why, jsonb_build_object('retired', jsonb_build_object('before', true, 'after', false)), uid, 'Sambit');
    return jsonb_build_object('row_id', rid, 'changed', true);
  end if;

  if mode = 'update' then
    if r.retired_at is not null then raise exception 'Row % is retired; restore it first.', rid; end if;
    update cms.cms_content_rows c set
      row_class           = case when f ? 'row_class' then (f ->> 'row_class')::int else c.row_class end,
      type                = case when f ? 'type' then f ->> 'type' else c.type end,
      chapter_role        = case when f ? 'chapter_role' then f ->> 'chapter_role' else c.chapter_role end,
      content             = case when f ? 'content' then btrim(f ->> 'content') else c.content end,
      why_it_matters      = case when f ? 'why_it_matters' then nullif(btrim(coalesce(f ->> 'why_it_matters', '')), '') else c.why_it_matters end,
      diagram_description = case when f ? 'diagram_description' then nullif(btrim(coalesce(f ->> 'diagram_description', '')), '') else c.diagram_description end,
      question_use        = case when f ? 'question_use' then f ->> 'question_use' else c.question_use end,
      safety              = case when f ? 'safety' then nullif(btrim(coalesce(f ->> 'safety', '')), '') else c.safety end,
      also_in_rows        = case when f ? 'also_in_rows' then coalesce(array(select jsonb_array_elements_text(f -> 'also_in_rows')), '{}') else c.also_in_rows end,
      notes               = case when f ? 'notes' then nullif(btrim(coalesce(f ->> 'notes', '')), '') else c.notes end,
      picture_question    = case when f ? 'picture_question' then coalesce((f ->> 'picture_question')::boolean, false) else c.picture_question end,
      confidence          = case when f ? 'confidence' then f ->> 'confidence' else c.confidence end
     where c.row_id = rid;
  end if;

  -- items
  for it in select * from jsonb_array_elements(coalesce(p -> 'items', '[]')) loop
    if it ->> 'action' = 'add' then
      if coalesce(btrim(it ->> 'text'), '') = '' then continue; end if;
      select coalesce(max(item_no), 0) + 1 into ino from cms.cms_row_misconceptions where row_id = rid;
      insert into cms.cms_row_misconceptions (row_id, item_no, text, status, source) values (rid, ino, btrim(it ->> 'text'), 'active', 'cms');
      insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
        values ('catalogue', 'cms_row_misconceptions', rid || ' #' || ino, 'create', why,
                jsonb_build_object('text', jsonb_build_object('before', null, 'after', btrim(it ->> 'text')), 'status', jsonb_build_object('before', null, 'after', 'active')), uid, 'Sambit');
      n_items := n_items + 1;
      continue;
    end if;
    select * into item from cms.cms_row_misconceptions where row_id = rid and item_no = (it ->> 'item_no')::int for update;
    if not found then raise exception 'Item % #% does not exist.', rid, it ->> 'item_no'; end if;
    select array_agg(distinct q.question_id order by q.question_id) into using_q
      from cms.cms_questions q join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
     where (v.misconception_row_id = rid and v.misconception_item_no = item.item_no)
        or exists (select 1 from cms.cms_version_wrong_answers w where w.version_id = v.version_id and w.mc_row_id = rid and w.mc_item_no = item.item_no);
    if it ->> 'action' = 'edit' then
      if coalesce(btrim(it ->> 'text'), '') = '' then raise exception 'Item % #% needs text (retire it instead).', rid, item.item_no; end if;
      if item.status = 'retired' then raise exception 'Item % #% is retired; restore it first.', rid, item.item_no; end if;
      if btrim(it ->> 'text') = item.text then continue; end if;
      update cms.cms_row_misconceptions set text = btrim(it ->> 'text'), updated_at = now() where row_id = rid and item_no = item.item_no;
      insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
        values ('catalogue', 'cms_row_misconceptions', rid || ' #' || item.item_no, 'edit_catalogue', why,
                jsonb_build_object('text', jsonb_build_object('before', item.text, 'after', btrim(it ->> 'text')), 'used_by', coalesce(to_jsonb(using_q), '[]'::jsonb)), uid, 'Sambit');
    elsif it ->> 'action' in ('retire', 'restore') then
      if (it ->> 'action' = 'retire') = (item.status = 'retired') then continue; end if;
      update cms.cms_row_misconceptions set status = case when it ->> 'action' = 'retire' then 'retired' else 'active' end, updated_at = now()
       where row_id = rid and item_no = item.item_no;
      insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
        values ('catalogue', 'cms_row_misconceptions', rid || ' #' || item.item_no, it ->> 'action', why,
                jsonb_build_object('status', jsonb_build_object('before', item.status, 'after', case when it ->> 'action' = 'retire' then 'retired' else 'active' end),
                                   'used_by', coalesce(to_jsonb(using_q), '[]'::jsonb)), uid, 'Sambit');
    else
      raise exception 'Unknown item action "%".', it ->> 'action';
    end if;
    n_items := n_items + 1;
  end loop;

  -- the legacy text mirrors the active items; a row that has never had items keeps its text (nothing is lost)
  if exists (select 1 from cms.cms_row_misconceptions m where m.row_id = rid) then
    select rtrim(string_agg(case when m.text ~ '[.!?]$' then m.text else m.text || ';' end, ' ' order by m.item_no), ';') into mtext from cms.cms_row_misconceptions m where m.row_id = rid and m.status = 'active';
    update cms.cms_content_rows set misconceptions = mtext where row_id = rid and misconceptions is distinct from mtext;
  end if;

  select * into r from cms.cms_content_rows where row_id = rid;
  a := (select jsonb_object_agg(e.key, e.value) from jsonb_each(to_jsonb(r)) e where e.key = any(editable || array['misconceptions']));
  diff := (select jsonb_object_agg(e.key, jsonb_build_object('before', case when b is null then null else b -> e.key end, 'after', e.value))
             from jsonb_each(a) e where b is null or (b -> e.key) is distinct from e.value);
  if diff is null and n_items = 0 and mode = 'update' then
    return jsonb_build_object('row_id', rid, 'changed', false);
  end if;
  update cms.cms_content_rows set cms_edited_at = now(), updated_at = now(),
         content_hash = encode(sha256(convert_to(a::text, 'UTF8')), 'hex')
   where row_id = rid;
  if diff is not null then
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
      values ('catalogue', 'cms_content_rows', rid, case when mode = 'create' then 'create' else 'science_row' end,
              coalesce(why, case when mode = 'create' then 'added in the CMS' else 'edited in the CMS' end),
              diff || case when mode = 'create' then jsonb_build_object('source', 'CMS', 'originality', 'not checked (own writing)') else '{}'::jsonb end, uid, 'Sambit');
  end if;
  return jsonb_build_object('row_id', rid, 'changed', true, 'items_changed', n_items);
end;
$$;

revoke execute on function cms.cms_save_content_row(jsonb) from public;
grant execute on function cms.cms_save_content_row(jsonb) to authenticated;

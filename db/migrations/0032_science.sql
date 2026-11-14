-- Science (Sambit, 13 Nov 2026; docs/science-plan.md). Schema cms only.
--
--  * cms_content_rows: the Science master's content rows (our own words), keyed by the master's Row ID.
--    Read-only in the CMS: the app user may only SELECT; import:science (cms_owner) writes them, with an
--    audit row per change. Rows are never deleted: a row that leaves the master gets in_master = false.
--  * cms_citations: bare citations (source + printed pages) for content rows and question versions.
--  * cms_question_content_rows: which content rows a question version tests (direct) or uses (supporting).
--  * cms_topic_class_proposals: topic–class links the master suggests. They stay PROPOSED until Sambit
--    approves one in Proposed; approving writes the cms_topic_classes link (audited).
--  * Science columns on the question tables: tier L1–L3 (level_tier; not the class Level D1), the sheet's
--    display format, misconception targeted, safety note, confidence, and the master's Q ID.
--  * Attributes for Science: reading, steps, inhibition, irrelevant info and visual (working memory,
--    strategy and math difficulty are unused), so "attributes pending" clears on those five.

-- ---------------------------------------------------------------- content rows
create table cms.cms_content_rows (
  row_id               text primary key check (row_id ~ '^C[1-6]-[0-9A-Z]{2,4}-[0-9]{3}$'),
  topic_id             text not null references cms.cms_topics (topic_id),
  chapter_id           text not null references cms.cms_chapters (chapter_id),
  row_class            int  not null check (row_class between 1 and 6),
  type                 text not null check (type in ('Fact', 'Concept', 'How it works', 'Experiment', 'Scenario-Case', 'Diagram', 'Vocabulary')),
  chapter_role         text not null check (chapter_role in ('Core', 'Extension', 'Preview')),
  content              text not null,
  why_it_matters       text,
  misconceptions       text,
  diagram_description  text,
  picture_question     boolean not null default false,
  question_use         text not null check (question_use in ('OK', 'Misconception only', 'No questions')),
  safety               text,
  source               text not null check (source in ('Book', 'Claude-added')),
  found_in             text check (found_in in ('NCERT', 'DAV only', 'Both')),
  confidence           text check (confidence in ('high', 'medium', 'low')),
  notes                text,
  time_sensitive       boolean not null default false,
  time_checked_year    int,
  accuracy_flag        boolean not null default false,
  master_file          text,           -- content-map file the row comes from, e.g. Class6_Ch04_content
  book                 text,           -- e.g. "NCERT Class 6 (Curiosity)" (a citation)
  book_chapter_no      int,
  book_chapter_title   text,
  appears_in           text,           -- book, class, chapter (and DAV file / printed pages): a citation
  sort                 int  not null,  -- order in the master
  -- originality of every field, checked on the Mac (scores and citations only)
  originality_result   text check (originality_result in ('clear', 'flagged', 'near_copy', 'no_sources')),
  originality_field    text,
  originality_score    numeric(3, 2),
  originality_ref      text,           -- a citation: "<source_id> p<pdf page>"
  originality_override text,           -- the override request's reason, when one lets a near-copy in
  in_master            boolean not null default true,
  missing_since        timestamptz,
  content_hash         text not null,
  import_id            bigint references cms.cms_imports (import_id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index cms_content_rows_topic on cms.cms_content_rows (topic_id, row_class);
create index cms_content_rows_chapter on cms.cms_content_rows (chapter_id);

-- ---------------------------------------------------------------- citations (bare: source + printed pages)
create table cms.cms_citations (
  citation_id bigint generated always as identity primary key,
  row_id      text   references cms.cms_content_rows (row_id),
  version_id  bigint references cms.cms_question_versions (version_id),
  for_row_id  text,                                  -- a question's "Taught in" given per content row
  source_id   text   not null references cms.cms_sources (source_id),
  page_from   int    not null check (page_from >= 0),
  page_to     int    not null,
  raw         text   not null check (char_length(raw) <= 80),   -- the cell's own citation, e.g. "Mag pp.205, 213"
  check ((row_id is null) <> (version_id is null)),
  check (page_to >= page_from)
);
create index cms_citations_row on cms.cms_citations (row_id);
create index cms_citations_version on cms.cms_citations (version_id);

-- ---------------------------------------------------------------- question ↔ content row
create table cms.cms_question_content_rows (
  version_id bigint not null references cms.cms_question_versions (version_id),
  row_id     text   not null references cms.cms_content_rows (row_id),
  role       text   not null check (role in ('direct', 'supporting')),
  primary key (version_id, row_id)
);
create index cms_question_content_rows_row on cms.cms_question_content_rows (row_id);

-- ---------------------------------------------------------------- proposed topic–class links
create table cms.cms_topic_class_proposals (
  topic_id       text not null references cms.cms_topics (topic_id),
  class          int  not null check (class between 1 and 6),
  source         text not null,              -- 'Science master'
  evidence       text,                       -- e.g. "12 content rows of class 5 (C5-02-004, …)"
  suggested_role text not null check (suggested_role in ('lower', 'higher')),
  status         text not null default 'proposed' check (status in ('proposed', 'active', 'retired')),
  import_id      bigint references cms.cms_imports (import_id),
  created_at     timestamptz not null default now(),
  decided_at     timestamptz,
  primary key (topic_id, class)
);

-- ---------------------------------------------------------------- Science columns on questions
alter table cms.cms_questions add column source_qid text unique;      -- the master's Q ID, e.g. C6-04-Q001
alter table cms.cms_question_versions
  add column level_tier             text check (level_tier in ('L1', 'L2', 'L3')),
  add column display_format         text,   -- the sheet's Format: Scenario MCQ, Why does, Picture MCQ …
  add column misconception_targeted text,
  add column safety_note            text,
  add column confidence             text check (confidence in ('high', 'medium', 'low'));

alter table cms.cms_imports drop constraint cms_imports_kind_check;
alter table cms.cms_imports add constraint cms_imports_kind_check check (kind in (
  'chapter', 'topics', 'seed', 'sources', 'book', 'originality', 'proposals', 'figures', 'updates', 'upload', 'science'));

alter table cms.cms_reviews drop constraint cms_reviews_action_check;
alter table cms.cms_reviews add constraint cms_reviews_action_check check (action in (
  'submit', 'approve', 'reject', 'typo_fix', 'retire', 'restore', 'edit_catalogue', 'import_replace_draft',
  'edit_draft', 'new_version', 'withdraw', 'create', 'remove_book_material', 'override_near_copy', 'import_update',
  'decline_override', 'review_status', 'originality_check', 'reorder', 'science_row'));

-- ---------------------------------------------------------------- attributes for Science
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
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function cms.cms_version_flags() from public;

-- ---------------------------------------------------------------- coverage per topic and row class
-- status of a row: direct (≥1 direct question) · supporting (only supporting) · not_eligible (Question use ≠ OK)
-- · none (eligible, no question yet). Counts only current, counted versions of production questions.
create view cms.cms_content_row_status with (security_invoker = true) as
select r.row_id, r.topic_id, r.chapter_id, r.row_class, r.type, r.question_use, r.in_master,
       coalesce(l.n_direct, 0)::int as n_direct, coalesce(l.n_supporting, 0)::int as n_supporting,
       case when coalesce(l.n_direct, 0) > 0 then 'direct'
            when coalesce(l.n_supporting, 0) > 0 then 'supporting'
            when r.question_use <> 'OK' then 'not_eligible'
            else 'none' end as status
from cms.cms_content_rows r
left join (
  select x.row_id, count(*) filter (where x.role = 'direct') as n_direct, count(*) filter (where x.role = 'supporting') as n_supporting
    from cms.cms_question_content_rows x
    join cms.cms_question_list q on q.version_id = x.version_id and q.counted
   group by x.row_id) l on l.row_id = r.row_id;

create view cms.cms_content_row_stats with (security_invoker = true) as
select s.topic_id, s.chapter_id, s.row_class as class,
       count(*)::int as n_rows,
       (count(*) filter (where s.status = 'direct'))::int as n_direct,
       (count(*) filter (where s.status = 'supporting'))::int as n_supporting,
       (count(*) filter (where s.status = 'not_eligible'))::int as n_not_eligible,
       (count(*) filter (where s.status = 'none'))::int as n_none
from cms.cms_content_row_status s
where s.in_master
group by s.topic_id, s.chapter_id, s.row_class;

-- ---------------------------------------------------------------- approve / retire a proposed topic–class link
create function cms.cms_decide_topic_class(p_topic_id text, p_class int, p_status text)
  returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  p cms.cms_topic_class_proposals;
begin
  if not cms.cms_is_admin(uid) then raise exception 'Only the CMS admin can decide topic–class links.' using errcode = '42501'; end if;
  if p_status not in ('active', 'retired', 'proposed') then raise exception 'Unknown status %.', p_status; end if;
  select * into p from cms.cms_topic_class_proposals where topic_id = p_topic_id and class = p_class for update;
  if not found then raise exception 'No proposed link for % in class %.', p_topic_id, p_class; end if;
  if p.status = p_status then return; end if;
  if p_status = 'active' then
    insert into cms.cms_topic_classes (topic_id, class, source, evidence)
      values (p.topic_id, p.class, p.source, p.evidence)
      on conflict (topic_id, class) do nothing;
  elsif p.status = 'active' then
    raise exception 'The link % · class % is already approved; edit the topic to change it.', p_topic_id, p_class;
  end if;
  update cms.cms_topic_class_proposals set status = p_status, decided_at = case when p_status = 'proposed' then null else now() end
   where topic_id = p_topic_id and class = p_class;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('catalogue', 'cms_topic_class_proposals', p_topic_id || ' · class ' || p_class,
            case p_status when 'active' then 'edit_catalogue' when 'retired' then 'retire' else 'restore' end,
            case p_status when 'active' then 'topic–class link approved from the Proposed list' when 'retired' then 'topic–class link retired from the Proposed list' else 'back to proposed' end,
            jsonb_build_object('status', jsonb_build_object('before', p.status, 'after', p_status), 'role', p.suggested_role, 'source', p.source),
            uid, 'Sambit');
end;
$$;
revoke execute on function cms.cms_decide_topic_class(text, int, text) from public;
grant execute on function cms.cms_decide_topic_class(text, int, text) to authenticated;

-- ---------------------------------------------------------------- security: read-only for the app user
-- The usual admin-only policy; read-only because authenticated gets SELECT only (writes: import:science as cms_owner,
-- and cms_add_questions / cms_decide_topic_class, which are admin-checked definer functions).
alter table cms.cms_content_rows enable row level security;
alter table cms.cms_citations enable row level security;
alter table cms.cms_question_content_rows enable row level security;
alter table cms.cms_topic_class_proposals enable row level security;
grant select on cms.cms_content_rows, cms.cms_citations, cms.cms_question_content_rows, cms.cms_topic_class_proposals to authenticated;
grant select on cms.cms_content_row_status, cms.cms_content_row_stats to authenticated;
create policy cms_admin_only on cms.cms_content_rows for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));
create policy cms_admin_only on cms.cms_citations for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));
create policy cms_admin_only on cms.cms_question_content_rows for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));
create policy cms_admin_only on cms.cms_topic_class_proposals for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

-- ---------------------------------------------------------------- Add question / bulk upload: content-row links (Science)
-- Same as 0029, plus x.content_rows = [{row_id, role}] (optional). A row given as both direct and supporting counts as direct.
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

-- Q38 PR 3 (plan docs/plan-2026-11-23-q38-direct-generation.md §1; Sambit 28 Nov 2026). Schema cms only; adds only.
-- Audit before this: docs/q38-key-registry-audit-2026-11-28.md (keys:audit, read-only).
--
--  Dry runs  take no numbers. cms_mint(k) gives the next MQ / SQ / GQ question ID or GR run code: nextval normally;
--            in a dry run (the transaction set cms.dry_run = on) the number nextval WOULD give (greatest of the
--            sequence's last value and the highest stored ID, + 1), without touching the sequence. So a dry run shows
--            the IDs the real run will get, and the sequence never moves. A transaction that minted in dry-run mode
--            can never commit (deferred constraint trigger on cms_questions / cms_generation_runs).
--            (Identity columns such as import_id or version_id are internal row numbers, not keys; they still advance.)
--  Registry  cms_key_reservations: the CMS issues every key and catalogue number a book pipeline needs.
--            kind file_key: a range of chapter file keys below 5000 (the CMS mints its own from 5001, so the two never
--              meet), e.g. MC19-0072…0101, next after the highest stored, held-out or reserved key of that chapter (and the
--              QuestionBank files' highest, which keys:reserve reads on the Mac and passes as at_least).
--            kind block: one id_blocks block b (patterns MP b×50…b×50+49; concept and misconception numbers b01…b99),
--              the next after every stored or reserved number. Blocks stop at 199 (MP has 4 digits).
--            Reservations are reserved → used | released, never deleted or reused; every change is audited.
--            While a block is reserved, the CMS's own concept / MP numbering skips it (cms_next_free).
--            id_blocks.md blocks 0–124 are loaded once (npm run keys:import-blocks) as used, so id_blocks.md becomes
--            a read-only mirror (npm run keys:mirror). Existing keys and IDs are never changed.
--  Callers   cms_reserve_keys / cms_close_keys: the admin, cms_owner or cms_gen_writer. cms_import_key_blocks: the admin
--            or cms_owner.

-- ---------------------------------------------------------------- dry runs take no numbers
create function cms.cms_mint(k text)
  returns text
  language plpgsql
  volatile
  set search_path = ''
as $$
declare
  n bigint;
  last bigint;
  called boolean;
  top text;
begin
  if k is null or k not in ('MQ', 'SQ', 'GQ', 'GR') then raise exception 'cms_mint: % is not MQ, SQ, GQ or GR.', coalesce(k, 'null'); end if;
  if coalesce(current_setting('cms.dry_run', true), '') <> 'on' then
    if k = 'MQ' then n := nextval('cms.cms_mq_seq');
    elsif k = 'SQ' then n := nextval('cms.cms_sq_seq');
    elsif k = 'GQ' then n := nextval('cms.cms_gq_seq');
    else n := nextval('cms.cms_gr_seq');
    end if;
  else
    if k = 'MQ' then select s.last_value, s.is_called into last, called from cms.cms_mq_seq s;
    elsif k = 'SQ' then select s.last_value, s.is_called into last, called from cms.cms_sq_seq s;
    elsif k = 'GQ' then select s.last_value, s.is_called into last, called from cms.cms_gq_seq s;
    else select s.last_value, s.is_called into last, called from cms.cms_gr_seq s;
    end if;
    if k = 'GR' then
      select r.run_code into top from cms.cms_generation_runs r where r.run_code like 'GR%' order by r.run_code desc limit 1;
    else
      select q.question_id into top from cms.cms_questions q where q.question_id like k || '%' order by q.question_id desc limit 1;
    end if;
    n := greatest(case when called then last else 0 end, coalesce(substring(top from '[0-9]+$')::bigint, 0)) + 1;
    perform set_config('cms.dry_minted', 'on', true);
  end if;
  return k || lpad(n::text, case when k = 'GR' then 4 else 6 end, '0');
end;
$$;
revoke execute on function cms.cms_mint(text) from public;

create function cms.cms_refuse_dry_commit()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if coalesce(current_setting('cms.dry_run', true), '') = 'on' or coalesce(current_setting('cms.dry_minted', true), '') = 'on' then
    raise exception 'A dry run can''t be committed: its IDs were not taken from the sequences. Roll it back.';
  end if;
  return null;
end;
$$;
revoke execute on function cms.cms_refuse_dry_commit() from public;
create constraint trigger cms_dry_run_guard after insert on cms.cms_questions
  deferrable initially deferred for each row execute function cms.cms_refuse_dry_commit();
create constraint trigger cms_dry_run_guard after insert on cms.cms_generation_runs
  deferrable initially deferred for each row execute function cms.cms_refuse_dry_commit();

-- ---------------------------------------------------------------- the key registry
create table cms.cms_key_reservations (
  reservation_id bigint generated always as identity primary key,
  kind         text not null check (kind in ('file_key', 'block')),
  prefix       text check (prefix ~ '^(MC|SC|GC)[0-9]{2}$'),
  block_no     int check (block_no between 0 and 199),
  first_no     int not null,
  last_no      int not null,
  purpose      text not null check (length(btrim(purpose)) between 1 and 300),
  status       text not null default 'reserved' check (status in ('reserved', 'used', 'released')),
  source       text not null default 'cms' check (source in ('cms', 'id_blocks.md')),
  reserved_by  text not null,
  created_at   timestamptz not null default now(),
  closed_at    timestamptz,
  note         text,
  check ((kind = 'file_key') = (prefix is not null) and (kind = 'block') = (block_no is not null)),
  check (first_no >= 0 and last_no >= first_no),
  check (kind <> 'file_key' or (first_no >= 1 and last_no <= 4999)),
  check (kind <> 'block' or (first_no = block_no * 50 and last_no = block_no * 50 + 49))
);
create unique index cms_key_reservations_block on cms.cms_key_reservations (block_no) where kind = 'block';
create index cms_key_reservations_prefix on cms.cms_key_reservations (prefix, last_no) where kind = 'file_key';
alter table cms.cms_key_reservations enable row level security;
grant select on cms.cms_key_reservations to authenticated;
create policy cms_admin_only on cms.cms_key_reservations for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_reviews drop constraint cms_reviews_target_check;
alter table cms.cms_reviews add constraint cms_reviews_target_check check (target in ('question_version', 'catalogue', 'course', 'lease', 'keys'));
alter table cms.cms_reviews drop constraint cms_reviews_action_check;
alter table cms.cms_reviews add constraint cms_reviews_action_check check (action in (
  'submit', 'approve', 'reject', 'typo_fix', 'retire', 'restore', 'edit_catalogue', 'import_replace_draft',
  'edit_draft', 'new_version', 'withdraw', 'create', 'remove_book_material', 'override_near_copy', 'import_update',
  'decline_override', 'review_status', 'originality_check', 'reorder', 'science_row', 'science_review', 'science_rationalise',
  'derived_update', 'held_out', 'held_out_place', 'held_out_discard',
  'course_save', 'course_status', 'course_upload', 'course_clone', 'course_copy',
  'gen_run_open', 'gen_run_close', 'gen_rollback',
  'image_brief', 'image_set', 'image_check', 'image_undo', 'image_run',
  'lease_take', 'lease_takeover', 'lease_release',
  'keys_reserve', 'keys_close', 'keys_import'));

/** The next number a CMS save may give a new concept ('concept', the number after the letter) or MP pattern ('pattern'):
 *  n, or the first number after any block a pipeline holds (status reserved) that n falls into. */
create function cms.cms_next_free(k text, n int)
  returns int
  language plpgsql
  stable
  set search_path = ''
as $$
declare
  size int := case k when 'pattern' then 50 when 'concept' then 100 end;
  b int;
begin
  if size is null then raise exception 'cms_next_free: % is not pattern or concept.', coalesce(k, 'null'); end if;
  loop
    select r.block_no into b from cms.cms_key_reservations r
     where r.kind = 'block' and r.status = 'reserved' and n between r.block_no * size and r.block_no * size + size - 1 limit 1;
    exit when not found;
    n := (b + 1) * size;
  end loop;
  return n;
end;
$$;
revoke execute on function cms.cms_next_free(text, int) from public;

/** Highest block any stored or reserved number already uses (MP b×50; concept and misconception numbers b×100). */
create function cms.cms_key_block_floor()
  returns int
  language sql
  stable
  set search_path = ''
as $$
  select greatest(
    (select max(r.block_no) from cms.cms_key_reservations r where r.kind = 'block'),
    (select max(substr(p.pattern_id, 3)::int / 50) from cms.cms_patterns p where p.pattern_id ~ '^MP[0-9]{4}$'),
    (select max(substring(c.concept_id from '-[CA]([0-9]+)$')::int / 100) from cms.cms_concepts c where c.subject = 'math' and c.concept_id ~ '-[CA][0-9]{3,5}$'),
    (select max(substring(m.misconception_id from '([0-9]+)$')::int / 100) from cms.cms_misconceptions m where m.misconception_id ~ '[A-Z][0-9]{3,5}$'),
    -1);
$$;
revoke execute on function cms.cms_key_block_floor() from public;

/** A reservation as the callers see it. */
create function cms.cms_key_reservation_json(r cms.cms_key_reservations)
  returns jsonb
  language sql
  stable
  set search_path = ''
as $$
  select jsonb_build_object('reservation_id', r.reservation_id, 'kind', r.kind, 'status', r.status, 'purpose', r.purpose, 'source', r.source,
    'reserved_by', r.reserved_by, 'created_at', r.created_at, 'closed_at', r.closed_at, 'note', r.note)
    || case when r.kind = 'file_key' then jsonb_build_object('prefix', r.prefix, 'first', r.prefix || '-' || lpad(r.first_no::text, 4, '0'),
                                                              'last', r.prefix || '-' || lpad(r.last_no::text, 4, '0'), 'count', r.last_no - r.first_no + 1)
       else jsonb_build_object('block', r.block_no, 'patterns', 'MP' || lpad(r.first_no::text, 4, '0') || '–MP' || lpad(r.last_no::text, 4, '0'),
                               'concepts', 'C' || r.block_no || '01–C' || r.block_no || '99', 'misconceptions', r.block_no || '01–' || r.block_no || '99') end;
$$;
revoke execute on function cms.cms_key_reservation_json(cms.cms_key_reservations) from public;

-- p = { kind: 'file_key' | 'block', prefix? (file_key: MC19 …), count? (file_key: 1–500), purpose, by? (a name for the audit),
--       at_least? (file_key: the first number may not be lower; keys:reserve passes the QuestionBank files' max + 1) }
create function cms.cms_reserve_keys(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  who text := cms.cms_gen_caller();
  k text := p ->> 'kind';
  pre text := upper(btrim(coalesce(p ->> 'prefix', '')));
  cnt int := coalesce((p ->> 'count')::int, 0);
  purpose text := btrim(coalesce(p ->> 'purpose', ''));
  first int;
  b int;
  r cms.cms_key_reservations;
begin
  if who is null then raise exception 'Only the CMS admin or a Mac script session can reserve keys.' using errcode = '42501'; end if;
  if purpose = '' then raise exception 'A reservation needs a purpose (book, chapter, worker).'; end if;
  if k = 'file_key' then
    if pre !~ '^(MC|SC|GC)[0-9]{2}$' then raise exception 'File keys are reserved per chapter prefix (e.g. MC19), not %.', coalesce(nullif(pre, ''), 'nothing'); end if;
    if cnt < 1 or cnt > 500 then raise exception 'Reserve 1 to 500 file keys at a time (got %).', cnt; end if;
    perform pg_advisory_xact_lock(hashtext('cms_keys:file_key:' || pre));
    first := greatest(
      (select max(substring(q.file_key from '-([0-9]+)$')::int) from cms.cms_questions q
        where q.file_key like pre || '-%' and substring(q.file_key from '-([0-9]+)$')::int < 5000),
      (select max(substring(h.file_key from '-([0-9]+)$')::int) from cms.cms_held_out h
        where h.file_key like pre || '-%' and substring(h.file_key from '-([0-9]+)$')::int < 5000),   -- held-out keys stay taken
      (select max(x.last_no) from cms.cms_key_reservations x where x.kind = 'file_key' and x.prefix = pre),
      coalesce((p ->> 'at_least')::int, 1) - 1,
      0) + 1;
    if first + cnt - 1 > 4999 then raise exception 'Chapter % has no % free book-pipeline keys left below 5000 (next is %).', pre, cnt, first; end if;
    insert into cms.cms_key_reservations (kind, prefix, first_no, last_no, purpose, reserved_by)
      values ('file_key', pre, first, first + cnt - 1, purpose, coalesce(nullif(btrim(p ->> 'by'), ''), who)) returning * into r;
  elsif k = 'block' then
    perform pg_advisory_xact_lock(hashtext('cms_keys:block'));
    b := cms.cms_key_block_floor() + 1;
    if b > 199 then raise exception 'No id block is left (MP numbers have 4 digits; block 199 is the last).'; end if;
    insert into cms.cms_key_reservations (kind, block_no, first_no, last_no, purpose, reserved_by)
      values ('block', b, b * 50, b * 50 + 49, purpose, coalesce(nullif(btrim(p ->> 'by'), ''), who)) returning * into r;
  else
    raise exception 'Reservation kind % is not file_key or block.', coalesce(k, 'null');
  end if;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('keys', 'cms_key_reservations', r.reservation_id::text, 'keys_reserve', purpose, cms.cms_key_reservation_json(r),
            case when who = 'admin' then cms.cms_current_uid() end, r.reserved_by);
  return cms.cms_key_reservation_json(r);
end;
$$;

-- p = { reservation_id, status: 'used' | 'released', note?, by? }
create function cms.cms_close_keys(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  who text := cms.cms_gen_caller();
  st text := p ->> 'status';
  r cms.cms_key_reservations;
begin
  if who is null then raise exception 'Only the CMS admin or a Mac script session can close a reservation.' using errcode = '42501'; end if;
  if st is null or st not in ('used', 'released') then raise exception 'A reservation is closed as used or released, not %.', coalesce(st, 'null'); end if;
  select * into r from cms.cms_key_reservations where reservation_id = (p ->> 'reservation_id')::bigint for update;
  if not found then raise exception 'Reservation % does not exist.', p ->> 'reservation_id'; end if;
  if r.status <> 'reserved' then raise exception 'Reservation % is already %.', r.reservation_id, r.status; end if;
  update cms.cms_key_reservations set status = st, closed_at = now(), note = coalesce(nullif(btrim(p ->> 'note'), ''), note)
   where reservation_id = r.reservation_id returning * into r;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('keys', 'cms_key_reservations', r.reservation_id::text, 'keys_close', r.note,
            jsonb_build_object('status', jsonb_build_object('before', 'reserved', 'after', st)),
            case when who = 'admin' then cms.cms_current_uid() end, coalesce(nullif(btrim(p ->> 'by'), ''), who));
  return cms.cms_key_reservation_json(r);
end;
$$;

-- One-off: id_blocks.md blocks as reservations of source 'id_blocks.md'. p = { blocks: [{ block_no, purpose, status: used | released, note }] }.
-- Idempotent by block number: a block already loaded with the same purpose is 'unchanged'; with another purpose 'conflict'
-- (never overwritten). Admin or cms_owner only.
create function cms.cms_import_key_blocks(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  who text := cms.cms_gen_caller();
  x jsonb;
  b int;
  r cms.cms_key_reservations;
  res jsonb := '[]';
begin
  if who is null or who = 'cms_gen_writer' then raise exception 'Only the CMS admin or cms_owner can load id_blocks.md.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('cms_keys:block'));
  for x in select * from jsonb_array_elements(coalesce(p -> 'blocks', '[]')) loop
    b := (x ->> 'block_no')::int;
    select * into r from cms.cms_key_reservations where kind = 'block' and block_no = b;
    if found then
      res := res || jsonb_build_object('block', b, 'result', case when r.purpose = btrim(x ->> 'purpose') then 'unchanged' else 'conflict' end);
      continue;
    end if;
    if coalesce(x ->> 'status', '') not in ('used', 'released') then raise exception 'Block %: status % is not used or released.', b, x ->> 'status'; end if;
    insert into cms.cms_key_reservations (kind, block_no, first_no, last_no, purpose, status, source, reserved_by, closed_at, note)
      values ('block', b, b * 50, b * 50 + 49, btrim(x ->> 'purpose'), x ->> 'status', 'id_blocks.md', 'id_blocks.md', now(), nullif(btrim(coalesce(x ->> 'note', '')), ''))
      returning * into r;
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
      values ('keys', 'cms_key_reservations', r.reservation_id::text, 'keys_import', 'loaded from QuestionBank/_pipeline/id_blocks.md',
              cms.cms_key_reservation_json(r), case when who = 'admin' then cms.cms_current_uid() end, 'keys:import-blocks');
    res := res || jsonb_build_object('block', b, 'result', 'added');
  end loop;
  return jsonb_build_object('blocks', res);
end;
$$;

revoke execute on function cms.cms_reserve_keys(jsonb) from public;
revoke execute on function cms.cms_close_keys(jsonb) from public;
revoke execute on function cms.cms_import_key_blocks(jsonb) from public;
grant execute on function cms.cms_reserve_keys(jsonb) to authenticated, cms_gen_writer;
grant execute on function cms.cms_close_keys(jsonb) to authenticated, cms_gen_writer;
grant execute on function cms.cms_import_key_blocks(jsonb) to authenticated;

-- ---------------------------------------------------------------- the minting functions, re-created (generated)
-- Each body below is the live definition (pg_get_functiondef, identical on local and real) with ONLY these changes:
--   'MQ'/'SQ'/'GQ' || lpad(nextval(…), 6, '0') → cms.cms_mint('MQ'/'SQ'/'GQ');  'GR' || lpad(nextval(…), 4, '0') → cms.cms_mint('GR')
--   cms_save_curriculum: n := cms.cms_next_free('concept' | 'pattern', n) after the max + 1 of a new concept / MP pattern.
-- tests/keys.db.test.ts re-derives every body from its previous migration text and checks this.

CREATE OR REPLACE FUNCTION cms.cms_apply_save(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    qid := case subj when 'math' then cms.cms_mint('MQ')
                     when 'science' then cms.cms_mint('SQ')
                     else cms.cms_mint('GQ') end;
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
$function$;

CREATE OR REPLACE FUNCTION cms.cms_add_questions(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    qid := case ch.subject when 'math' then cms.cms_mint('MQ')
                           when 'science' then cms.cms_mint('SQ')
                           else cms.cms_mint('GQ') end;
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
$function$;

CREATE OR REPLACE FUNCTION cms.cms_place_held_out(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  qid := case ch.subject when 'math' then cms.cms_mint('MQ')
                         when 'science' then cms.cms_mint('SQ')
                         else cms.cms_mint('GQ') end;
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
$function$;

CREATE OR REPLACE FUNCTION cms.cms_gen_write_item(run cms.cms_generation_runs, imp bigint, batch integer, lid text, hash text, it jsonb, topic_override text, p_placing boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  qid := cms.cms_mint('SQ');
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
$function$;

CREATE OR REPLACE FUNCTION cms.cms_gen_open_run(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
              (p ->> 'cost')::numeric, 'importing', cms.cms_mint('GR'), p ->> 'subject', p ->> 'route',
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
$function$;

CREATE OR REPLACE FUNCTION cms.cms_save_curriculum(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  uid uuid := cms.cms_current_uid();
  kind text := p ->> 'kind';
  act text := p ->> 'action';
  f jsonb := coalesce(p -> 'fields', '{}'::jsonb);
  rid text := p ->> 'id';
  reason text := nullif(btrim(coalesce(p ->> 'reason', '')), '');
  owner text;
  tbl text;
  b jsonb;               -- the row before
  a jsonb;               -- the row after
  links_b jsonb := null; -- topic classes / prerequisites before
  links_a jsonb := null;
  subj text; pre text; n int; cls int; code text; letter text; slug text;
  t cms.cms_topics;
  diff jsonb;
  audit_action text;
begin
  if not cms.cms_is_admin(uid) then
    raise exception 'Only the CMS admin can change the curriculum.' using errcode = '42501';
  end if;
  if act not in ('create', 'update', 'retire', 'restore') then raise exception 'Unknown action "%".', act; end if;
  if act <> 'create' and rid is null then raise exception 'Which % ? (id missing)', kind; end if;
  owner := coalesce((select c.value #>> '{}' from cms.cms_config c where c.key = 'curriculum_owner'), 'workbooks');
  if kind in ('chapter', 'topic') and owner <> 'cms'
     and not (kind = 'topic' and act = 'update' and (f - 'classes' - 'prereqs') = '{}'::jsonb) then
    raise exception 'Chapters and topics still come from the topic workbooks until the one-time cut-over (docs/curriculum-cutover.md). Topic classes and prerequisites can be edited now.';
  end if;

  -- ------------------------------------------------------------ chapter
  if kind = 'chapter' then
    tbl := 'cms_chapters';
    if act = 'create' then
      subj := f ->> 'subject';
      pre := case subj when 'math' then 'MC' when 'science' then 'SC' when 'grammar' then 'GC' end;
      if pre is null then raise exception 'Subject must be math, science or grammar.'; end if;
      if coalesce(btrim(f ->> 'name'), '') = '' then raise exception 'A chapter needs a name.'; end if;
      lock table cms.cms_chapters in share row exclusive mode;
      select coalesce(max(substr(c.chapter_id, 3)::int), 0) + 1 into n from cms.cms_chapters c where c.chapter_id like pre || '%';
      if n > 99 then raise exception 'No chapter numbers left for %.', subj; end if;
      rid := pre || lpad(n::text, 2, '0');
      insert into cms.cms_chapters (chapter_id, subject, strand_id, name, display_code, scope, sort)
        values (rid, subj, f ->> 'strand_id', btrim(f ->> 'name'), nullif(f ->> 'display_code', ''), nullif(f ->> 'scope', ''),
                coalesce((f ->> 'sort')::int, (select coalesce(max(c.sort), 0) + 1 from cms.cms_chapters c where c.subject = subj)));
    else
      select to_jsonb(c) into b from cms.cms_chapters c where c.chapter_id = rid for update;
      if b is null then raise exception 'Chapter % does not exist.', rid; end if;
      update cms.cms_chapters c set
        strand_id = case when f ? 'strand_id' then f ->> 'strand_id' else c.strand_id end,
        name = case when f ? 'name' then btrim(f ->> 'name') else c.name end,
        display_code = case when f ? 'display_code' then nullif(f ->> 'display_code', '') else c.display_code end,
        scope = case when f ? 'scope' then nullif(f ->> 'scope', '') else c.scope end,
        sort = case when f ? 'sort' then (f ->> 'sort')::int else c.sort end,
        status = case act when 'retire' then 'retired' when 'restore' then 'active' else c.status end
        where c.chapter_id = rid;
    end if;
    select to_jsonb(c) into a from cms.cms_chapters c where c.chapter_id = rid;

  -- ------------------------------------------------------------ topic (normal or Achievers)
  elsif kind = 'topic' then
    tbl := 'cms_topics';
    if act = 'create' then
      select c.subject into subj from cms.cms_chapters c where c.chapter_id = f ->> 'chapter_id';
      if subj is null then raise exception 'Chapter % does not exist.', f ->> 'chapter_id'; end if;
      cls := (f ->> 'class')::int;
      if cls is null or cls not between 1 and 6 then raise exception 'Class must be 1–6.'; end if;
      if coalesce(btrim(f ->> 'name'), '') = '' then raise exception 'A topic needs a name.'; end if;
      lock table cms.cms_topics in share row exclusive mode;
      if coalesce(f ->> 'topic_kind', 'normal') = 'achievers' then
        rid := 'ACH-' || (f ->> 'chapter_id') || '-' || cls;
        if exists (select 1 from cms.cms_topics x where x.topic_id = rid) then raise exception '% already exists (one Achievers row per chapter and class).', rid; end if;
      else
        pre := case subj when 'math' then 'MT' when 'science' then 'ST' else 'GT' end;
        select coalesce(max(substr(x.topic_id, 3)::int), 0) + 1 into n from cms.cms_topics x where x.topic_id ~ ('^' || pre || '[0-9]{4}$');
        rid := pre || lpad(n::text, 4, '0');
      end if;
      insert into cms.cms_topics (topic_id, chapter_id, class, seq, name, level, sub_skills, topic_kind, taught_in_school, source_flags, notes)
        values (rid, f ->> 'chapter_id', cls, (f ->> 'seq')::int, btrim(f ->> 'name'), (f ->> 'level')::int, nullif(f ->> 'sub_skills', ''),
                coalesce(f ->> 'topic_kind', 'normal'), coalesce((f ->> 'taught_in_school')::boolean, false), coalesce(f -> 'source_flags', '{}'::jsonb), nullif(f ->> 'notes', ''));
    else
      select to_jsonb(x) into b from cms.cms_topics x where x.topic_id = rid for update;
      if b is null then raise exception 'Topic % does not exist.', rid; end if;
      update cms.cms_topics x set
        name = case when f ? 'name' then btrim(f ->> 'name') else x.name end,
        seq = case when f ? 'seq' then (f ->> 'seq')::int else x.seq end,
        level = case when f ? 'level' then (f ->> 'level')::int else x.level end,
        sub_skills = case when f ? 'sub_skills' then nullif(f ->> 'sub_skills', '') else x.sub_skills end,
        taught_in_school = case when f ? 'taught_in_school' then (f ->> 'taught_in_school')::boolean else x.taught_in_school end,
        source_flags = case when f ? 'source_flags' then f -> 'source_flags' else x.source_flags end,
        notes = case when f ? 'notes' then nullif(f ->> 'notes', '') else x.notes end,
        status = case act when 'retire' then 'retired' when 'restore' then 'active' else x.status end
        where x.topic_id = rid;
    end if;
    select * into t from cms.cms_topics x where x.topic_id = rid;
    -- D2 classes and D4 prerequisites: the given list replaces the old one (link rows, audited)
    if f ? 'classes' or f ? 'prereqs' then
      select jsonb_build_object(
          'classes', coalesce((select jsonb_agg(jsonb_build_object('class', c.class, 'source', c.source, 'evidence', c.evidence) order by c.class) from cms.cms_topic_classes c where c.topic_id = rid), '[]'),
          'prereqs', coalesce((select jsonb_agg(r.prereq_topic_id order by r.prereq_topic_id) from cms.cms_topic_prereqs r where r.topic_id = rid), '[]'))
        into links_b;
    end if;
    if f ? 'classes' then
      if exists (select 1 from jsonb_array_elements(f -> 'classes') e where (e ->> 'class')::int not between 1 and 6 or coalesce(btrim(e ->> 'source'), '') = '') then
        raise exception 'Each class needs a class 1–6 and a source.';
      end if;
      delete from cms.cms_topic_classes c where c.topic_id = rid
        and c.class not in (select (e ->> 'class')::int from jsonb_array_elements(f -> 'classes') e);
      insert into cms.cms_topic_classes (topic_id, class, source, evidence)
        select rid, (e ->> 'class')::int, btrim(e ->> 'source'), nullif(e ->> 'evidence', '') from jsonb_array_elements(f -> 'classes') e
        on conflict (topic_id, class) do update set source = excluded.source, evidence = excluded.evidence, updated_at = now();
    end if;
    if f ? 'prereqs' then
      if exists (select 1 from jsonb_array_elements_text(f -> 'prereqs') x where not exists (select 1 from cms.cms_topics y where y.topic_id = x)) then
        raise exception 'A prerequisite is not a topic ID.';
      end if;
      if exists (select 1 from jsonb_array_elements_text(f -> 'prereqs') x where x = rid) then raise exception 'A topic cannot be its own prerequisite.'; end if;
      delete from cms.cms_topic_prereqs r where r.topic_id = rid and r.prereq_topic_id not in (select jsonb_array_elements_text(f -> 'prereqs'));
      insert into cms.cms_topic_prereqs (topic_id, prereq_topic_id) select rid, x from jsonb_array_elements_text(f -> 'prereqs') x on conflict do nothing;
    end if;
    if links_b is not null then
      select jsonb_build_object(
          'classes', coalesce((select jsonb_agg(jsonb_build_object('class', c.class, 'source', c.source, 'evidence', c.evidence) order by c.class) from cms.cms_topic_classes c where c.topic_id = rid), '[]'),
          'prereqs', coalesce((select jsonb_agg(r.prereq_topic_id order by r.prereq_topic_id) from cms.cms_topic_prereqs r where r.topic_id = rid), '[]'))
        into links_a;
    end if;
    a := to_jsonb(t);

  -- ------------------------------------------------------------ concept
  elsif kind = 'concept' then
    tbl := 'cms_concepts';
    if act = 'create' then
      select x.* into t from cms.cms_topics x where x.topic_id = f ->> 'topic_id';
      if t.topic_id is null then raise exception 'Topic % does not exist.', f ->> 'topic_id'; end if;
      select c.subject into subj from cms.cms_chapters c where c.chapter_id = t.chapter_id;
      cls := coalesce((f ->> 'class')::int, t.class);
      code := upper(btrim(coalesce(f ->> 'code', '')));
      if code !~ '^[A-Z]{2,4}$' then raise exception 'The concept code is 2–4 capital letters (e.g. FRC).'; end if;
      letter := case f ->> 'type' when 'applied' then 'A' else 'C' end;
      if coalesce(btrim(f ->> 'name'), '') = '' then raise exception 'A concept needs a name.'; end if;
      lock table cms.cms_concepts in share row exclusive mode;
      select coalesce(max(substring(x.concept_id from '[0-9]+$')::int), 0) + 1 into n from cms.cms_concepts x
        where x.concept_id ~ ('^G' || cls || '-' || code || '-' || letter || '[0-9]+$');
      n := cms.cms_next_free('concept', n);   -- 0052: skip numbers inside a block a pipeline holds (cms_key_reservations)
      rid := 'G' || cls || '-' || code || '-' || letter || n;
      insert into cms.cms_concepts (concept_id, subject, class, topic_id, name, type, description, includes, excludes, example_question, status)
        values (rid, subj, cls, t.topic_id, btrim(f ->> 'name'), coalesce(f ->> 'type', 'core'), nullif(f ->> 'description', ''), nullif(f ->> 'includes', ''),
                nullif(f ->> 'excludes', ''), nullif(f ->> 'example_question', ''), 'proposed');
    else
      select to_jsonb(x) into b from cms.cms_concepts x where x.concept_id = rid for update;
      if b is null then raise exception 'Concept % does not exist.', rid; end if;
      update cms.cms_concepts x set
        name = case when f ? 'name' then btrim(f ->> 'name') else x.name end,
        description = case when f ? 'description' then nullif(f ->> 'description', '') else x.description end,
        includes = case when f ? 'includes' then nullif(f ->> 'includes', '') else x.includes end,
        excludes = case when f ? 'excludes' then nullif(f ->> 'excludes', '') else x.excludes end,
        example_question = case when f ? 'example_question' then nullif(f ->> 'example_question', '') else x.example_question end,
        status = case act when 'retire' then 'retired' when 'restore' then 'proposed' else x.status end,
        updated_at = now()
        where x.concept_id = rid;
    end if;
    select to_jsonb(x) into a from cms.cms_concepts x where x.concept_id = rid;

  -- ------------------------------------------------------------ typical set (question type)
  elsif kind = 'typical_set' then
    tbl := 'cms_typical_sets';
    if act = 'create' then
      select x.* into t from cms.cms_topics x where x.topic_id = f ->> 'topic_id';
      if t.topic_id is null then raise exception 'Topic % does not exist.', f ->> 'topic_id'; end if;
      select c.subject into subj from cms.cms_chapters c where c.chapter_id = t.chapter_id;
      cls := coalesce((f ->> 'class')::int, t.class);
      if coalesce(btrim(f ->> 'name'), '') = '' then raise exception 'A question type needs a name.'; end if;
      slug := left(btrim(regexp_replace(upper(coalesce(nullif(f ->> 'slug', ''), f ->> 'name')), '[^A-Z0-9]+', '-', 'g'), '-'), 30);
      slug := btrim(slug, '-');
      if slug = '' then raise exception 'The question type name needs letters or digits.'; end if;
      lock table cms.cms_typical_sets in share row exclusive mode;
      rid := 'TS-G' || cls || '-' || slug;
      n := 1;
      while exists (select 1 from cms.cms_typical_sets x where x.typical_set_id = rid) loop
        n := n + 1; rid := 'TS-G' || cls || '-' || slug || '-' || n;
      end loop;
      insert into cms.cms_typical_sets (typical_set_id, subject, class, chapter_id, topic_id, name, instruction_pattern, variant_note, parent_visible, status)
        values (rid, subj, cls, t.chapter_id, t.topic_id, btrim(f ->> 'name'), nullif(f ->> 'instruction_pattern', ''), nullif(f ->> 'variant_note', ''),
                coalesce((f ->> 'parent_visible')::boolean, true), 'proposed');
    else
      select to_jsonb(x) into b from cms.cms_typical_sets x where x.typical_set_id = rid for update;
      if b is null then raise exception 'Question type % does not exist.', rid; end if;
      update cms.cms_typical_sets x set
        name = case when f ? 'name' then btrim(f ->> 'name') else x.name end,
        instruction_pattern = case when f ? 'instruction_pattern' then nullif(f ->> 'instruction_pattern', '') else x.instruction_pattern end,
        variant_note = case when f ? 'variant_note' then nullif(f ->> 'variant_note', '') else x.variant_note end,
        parent_visible = case when f ? 'parent_visible' then (f ->> 'parent_visible')::boolean else x.parent_visible end,
        status = case act when 'retire' then 'retired' when 'restore' then 'proposed' else x.status end,
        updated_at = now()
        where x.typical_set_id = rid;
    end if;
    select to_jsonb(x) into a from cms.cms_typical_sets x where x.typical_set_id = rid;

  -- ------------------------------------------------------------ pattern
  elsif kind = 'pattern' then
    tbl := 'cms_patterns';
    if act = 'create' then
      select x.* into t from cms.cms_topics x where x.topic_id = f ->> 'topic_id';
      if t.topic_id is null then raise exception 'Topic % does not exist.', f ->> 'topic_id'; end if;
      if not exists (select 1 from cms.cms_typical_sets s where s.typical_set_id = f ->> 'typical_set_id') then
        raise exception 'Question type % does not exist.', f ->> 'typical_set_id';
      end if;
      select c.subject into subj from cms.cms_chapters c where c.chapter_id = t.chapter_id;
      if coalesce(btrim(f ->> 'name'), '') = '' then raise exception 'A pattern needs a name.'; end if;
      pre := case subj when 'math' then 'MP' when 'science' then 'SP' else 'GP' end;
      lock table cms.cms_patterns in share row exclusive mode;
      select coalesce(max(substr(x.pattern_id, 3)::int), 0) + 1 into n from cms.cms_patterns x where x.pattern_id like pre || '%';
      if pre = 'MP' then n := cms.cms_next_free('pattern', n); end if;   -- 0052: skip MP numbers inside a held block
      rid := pre || lpad(n::text, 4, '0');
      insert into cms.cms_patterns (pattern_id, topic_id, typical_set_id, name, template, notes, status)
        values (rid, t.topic_id, f ->> 'typical_set_id', btrim(f ->> 'name'), nullif(f ->> 'template', ''), nullif(f ->> 'notes', ''), 'proposed');
    else
      select to_jsonb(x) into b from cms.cms_patterns x where x.pattern_id = rid for update;
      if b is null then raise exception 'Pattern % does not exist.', rid; end if;
      update cms.cms_patterns x set
        name = case when f ? 'name' then btrim(f ->> 'name') else x.name end,
        template = case when f ? 'template' then nullif(f ->> 'template', '') else x.template end,
        notes = case when f ? 'notes' then nullif(f ->> 'notes', '') else x.notes end,
        status = case act when 'retire' then 'retired' when 'restore' then 'proposed' else x.status end,
        updated_at = now()
        where x.pattern_id = rid;
    end if;
    select to_jsonb(x) into a from cms.cms_patterns x where x.pattern_id = rid;
  else
    raise exception 'Unknown curriculum kind "%".', kind;
  end if;

  -- audit: before → after of every changed field (updated_at left out)
  select coalesce(jsonb_object_agg(k, jsonb_build_object('before', coalesce(b, '{}'::jsonb) -> k, 'after', a -> k)), '{}'::jsonb) into diff
    from jsonb_object_keys(a) k
    where k <> 'updated_at' and (b is null or (b -> k) is distinct from (a -> k)) and (b is not null or a -> k <> 'null'::jsonb);
  if links_b is not null and links_b is distinct from links_a then
    if links_b -> 'classes' is distinct from links_a -> 'classes' then diff := diff || jsonb_build_object('classes', jsonb_build_object('before', links_b -> 'classes', 'after', links_a -> 'classes')); end if;
    if links_b -> 'prereqs' is distinct from links_a -> 'prereqs' then diff := diff || jsonb_build_object('prereqs', jsonb_build_object('before', links_b -> 'prereqs', 'after', links_a -> 'prereqs')); end if;
  end if;
  if act <> 'create' and diff = '{}'::jsonb then
    return jsonb_build_object('kind', kind, 'id', rid, 'action', act, 'changed', false);
  end if;
  audit_action := case act when 'create' then 'create' when 'retire' then 'retire' when 'restore' then 'restore' else 'edit_catalogue' end;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('catalogue', tbl, rid, audit_action, coalesce(reason, act || ' ' || kind), diff, uid, 'Sambit');
  return jsonb_build_object('kind', kind, 'id', rid, 'action', act, 'changed', true);
end;
$function$;


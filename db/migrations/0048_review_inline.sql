-- Q38 PR 4 (Sambit, 24 Nov 2026): review in the CMS. Schema cms only; adds only. Plan: docs/plan-2026-11-23-q38-direct-generation.md §7.
--
--  OL-044  cms_approve_questions(ids, reason): approve several questions, each in its own sub-transaction, through
--          cms_set_status (every approval rule applies; one audit row per question). A GENERATED Science question with
--          exactly one proposed primary and no confirmed one gets that primary confirmed first (cms_save_science_review,
--          audited); if its approval is then blocked, the confirmation is rolled back with it. Returns approved and
--          blocked (with the reason) lists. The single Approve of the question screen uses it too.
--  Q3      Reject a proposed primary: the row stays linked as a secondary, marked primary_rejected (visible, undoable).
--          cms_decide_primary(p): confirm · change (another direct row) · reject · undo.
--  Q2      Settings get an approval path: cms_set_catalogue_status takes kind 'setting' (proposed / active / retired).
--  (g)     Until the Images PR (DL-040): a generated Science question with a drawn figure can't be approved
--          ("Image to redo (DL-040)"). Trigger cms_version_image_redo + reason image_to_redo in cms_approval_blockers.
--          The Images PR replaces this with the Image needed → Image to check → OK status.
--  cms_approval_blockers: + image_to_redo; a generated question whose single proposed primary is confirmed on approval
--          is no longer listed as "primary not confirmed"; a rejected primary is named in the detail.

-- ---------------------------------------------------------------- Q3: a rejected proposed primary stays visible
alter table cms.cms_question_content_rows
  add column primary_rejected boolean not null default false;
alter table cms.cms_question_content_rows
  add constraint cms_question_content_rows_rejected check (not primary_rejected or (rank <> 'primary' and not rank_proposed));

-- ---------------------------------------------------------------- (g) Image to redo (DL-040)
create function cms.cms_version_image_redo()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved')
     and new.created_from = 'generation' and new.image_status = 'has_image'
     and exists (select 1 from cms.cms_questions q where q.question_id = new.question_id and q.subject = 'science' and q.bank = 'production') then
    raise exception 'v% of % can''t be approved yet: Image to redo (DL-040). Its drawn figure is replaced in the Images PR.', new.version_no, new.question_id;
  end if;
  return new;
end;
$$;
revoke execute on function cms.cms_version_image_redo() from public;
create trigger cms_version_image_redo before insert or update of status on cms.cms_question_versions
  for each row execute function cms.cms_version_image_redo();

-- ---------------------------------------------------------------- Q2: settings in the catalogue status path
create or replace function cms.cms_set_catalogue_status(p_kind text, p_id text, p_status text, p_reason text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  before_status text;
  tbl text;
begin
  if not cms.cms_is_admin(uid) then
    raise exception 'Only the CMS admin can change the catalogue.' using errcode = '42501';
  end if;
  if p_status not in ('proposed', 'active', 'retired') then
    raise exception 'Unknown status "%".', p_status;
  end if;
  if p_kind = 'concept' then
    tbl := 'cms_concepts';
    select status into before_status from cms.cms_concepts where concept_id = p_id for update;
    if found then update cms.cms_concepts set status = p_status, updated_at = now() where concept_id = p_id; end if;
  elsif p_kind = 'misconception' then
    tbl := 'cms_misconceptions';
    select status into before_status from cms.cms_misconceptions where misconception_id = p_id for update;
    if found then update cms.cms_misconceptions set status = p_status, updated_at = now() where misconception_id = p_id; end if;
  elsif p_kind = 'typical_set' then
    tbl := 'cms_typical_sets';
    select status into before_status from cms.cms_typical_sets where typical_set_id = p_id for update;
    if found then update cms.cms_typical_sets set status = p_status, updated_at = now() where typical_set_id = p_id; end if;
  elsif p_kind = 'pattern' then
    tbl := 'cms_patterns';
    select status into before_status from cms.cms_patterns where pattern_id = p_id for update;
    if found then update cms.cms_patterns set status = p_status, updated_at = now() where pattern_id = p_id; end if;
  elsif p_kind = 'setting' then   -- 0048 (Q2)
    tbl := 'cms_settings';
    select status into before_status from cms.cms_settings where setting_id = p_id for update;
    if found then update cms.cms_settings set status = p_status, updated_at = now() where setting_id = p_id; end if;
  else
    raise exception 'Unknown catalogue kind "%".', p_kind;
  end if;
  if before_status is null then raise exception '% % does not exist.', p_kind, p_id; end if;
  if before_status = p_status then raise exception '% is already %.', p_id, p_status; end if;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('catalogue', tbl, p_id, 'edit_catalogue', coalesce(nullif(btrim(p_reason), ''), p_status),
            jsonb_build_object('status', jsonb_build_object('before', before_status, 'after', p_status)), uid, 'Sambit');
  return jsonb_build_object('kind', p_kind, 'id', p_id, 'status', p_status);
end;
$$;

-- ---------------------------------------------------------------- Q3: decide a proposed primary in place
-- p: {question_id, version_no, decision: confirm|change|reject|undo, row_id, reason?}
--   confirm  row_id = the proposed primary → confirmed (cms_save_science_review)
--   change   row_id = another direct row → the confirmed primary; the old one becomes secondary (cms_save_science_review)
--   reject   row_id = the proposed primary → secondary, marked primary_rejected; the question then needs a primary
--   undo     row_id = a rejected row → the proposed primary again (only while no primary is confirmed)
create function cms.cms_decide_primary(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  q cms.cms_questions;
  cur cms.cms_question_versions;
  d text := p ->> 'decision';
  rid text := p ->> 'row_id';
  l cms.cms_question_content_rows;
  res jsonb;
begin
  if not cms.cms_is_admin(uid) then raise exception 'Only the CMS admin can review questions.' using errcode = '42501'; end if;
  if d is null or d not in ('confirm', 'change', 'reject', 'undo') then raise exception 'Unknown decision "%".', d; end if;
  select * into q from cms.cms_questions where question_id = p ->> 'question_id' for update;
  if not found then raise exception 'Question % does not exist.', p ->> 'question_id'; end if;
  if q.subject <> 'science' then raise exception 'Primary rows are for Science questions only.'; end if;
  if q.retired_at is not null then raise exception 'Question % is retired.', q.question_id; end if;
  if (p ->> 'version_no')::int is distinct from q.current_version then
    raise exception 'Question % changed since you opened it (it is now at v%). Reload and try again.', q.question_id, q.current_version;
  end if;
  select * into cur from cms.cms_question_versions where question_id = q.question_id and version_no = q.current_version for update;
  if cur.status not in ('draft', 'in_review') then
    raise exception 'v% is %; use Edit to make a new version first, then review it.', cur.version_no, cur.status;
  end if;
  select * into l from cms.cms_question_content_rows where version_id = cur.version_id and row_id = rid for update;
  if not found then raise exception '% is not one of this question''s content rows.', rid; end if;

  if d in ('confirm', 'change') then
    if d = 'confirm' and not (l.rank = 'primary' and l.rank_proposed) then raise exception '% is not the proposed primary.', rid; end if;
    -- a rejected row picked as the primary after all is no longer "rejected" (cleared first: the check forbids a rejected primary)
    update cms.cms_question_content_rows set primary_rejected = false where version_id = cur.version_id and row_id = rid and primary_rejected;
    res := cms.cms_save_science_review(jsonb_build_object('question_id', q.question_id, 'version_no', cur.version_no, 'primary_row_id', rid,
             'reason', coalesce(nullif(btrim(p ->> 'reason'), ''), case d when 'confirm' then 'primary confirmed' else 'primary changed' end)));
    return res || jsonb_build_object('decision', d, 'row_id', rid);
  end if;

  if d = 'reject' then
    if not (l.rank = 'primary' and l.rank_proposed) then raise exception '% is not the proposed primary.', rid; end if;
    update cms.cms_question_content_rows set rank = 'secondary', rank_proposed = false, primary_rejected = true
     where version_id = cur.version_id and row_id = rid;
  else  -- undo
    if not l.primary_rejected then raise exception '% is not a rejected primary.', rid; end if;
    if exists (select 1 from cms.cms_question_content_rows x where x.version_id = cur.version_id and x.rank = 'primary') then
      raise exception 'This question has a primary row now; use Change to pick % instead.', rid;
    end if;
    update cms.cms_question_content_rows set rank = 'primary', rank_proposed = true, primary_rejected = false
     where version_id = cur.version_id and row_id = rid;
  end if;
  update cms.cms_question_versions set edited_at = now() where version_id = cur.version_id;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('question_version', 'cms_question_versions', q.question_id || ' v' || cur.version_no, 'science_review',
            coalesce(nullif(btrim(p ->> 'reason'), ''), case d when 'reject' then 'proposed primary rejected' else 'rejected primary restored as proposed' end),
            jsonb_build_object('primary', jsonb_build_object('before', case d when 'reject' then rid || ' (proposed)' end,
                                                             'after', case d when 'undo' then rid || ' (proposed)' end),
                               'primary_rejected', jsonb_build_object('row_id', rid, 'before', d = 'undo', 'after', d = 'reject')),
            uid, 'Sambit');
  return jsonb_build_object('question_id', q.question_id, 'version_no', cur.version_no, 'decision', d, 'row_id', rid, 'changed', true);
end;
$$;
revoke execute on function cms.cms_decide_primary(jsonb) from public;
grant execute on function cms.cms_decide_primary(jsonb) to authenticated;

-- ---------------------------------------------------------------- OL-044 + bulk approve
create function cms.cms_approve_questions(p_ids text[], p_reason text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  qid text;
  q cms.cms_questions;
  cur cms.cms_question_versions;
  prop text;
  confirmed boolean;
  approved jsonb := '[]';
  blocked jsonb := '[]';
  already jsonb := '[]';
begin
  if not cms.cms_is_admin(uid) then raise exception 'Only the CMS admin can review questions.' using errcode = '42501'; end if;
  if coalesce(cardinality(p_ids), 0) = 0 then raise exception 'No questions selected.'; end if;
  if cardinality(p_ids) > 100 then raise exception 'At most 100 questions per call (got %).', cardinality(p_ids); end if;
  foreach qid in array (select array_agg(distinct x order by x) from unnest(p_ids) x) loop
    begin
      select * into q from cms.cms_questions where question_id = qid;
      if not found then raise exception 'Question % does not exist.', qid; end if;
      select * into cur from cms.cms_question_versions where question_id = qid and version_no = q.current_version;
      if cur.status = 'approved' then
        already := already || jsonb_build_object('question_id', qid, 'version_no', cur.version_no);
        continue;
      end if;
      confirmed := false;
      -- OL-044 (Sambit, 24 Nov 2026): approving a generated question also confirms its proposed primary
      if q.subject = 'science' and cur.created_from = 'generation'
         and not exists (select 1 from cms.cms_question_content_rows l where l.version_id = cur.version_id and l.rank = 'primary' and not l.rank_proposed)
         and (select count(*) from cms.cms_question_content_rows l where l.version_id = cur.version_id and l.rank = 'primary' and l.rank_proposed) = 1 then
        select l.row_id into prop from cms.cms_question_content_rows l where l.version_id = cur.version_id and l.rank = 'primary' and l.rank_proposed;
        perform cms.cms_save_science_review(jsonb_build_object('question_id', qid, 'version_no', cur.version_no, 'primary_row_id', prop,
                  'reason', 'proposed primary confirmed as the question is approved (OL-044)'));
        confirmed := true;
      end if;
      perform cms.cms_set_status(qid, cur.version_no, 'approve', p_reason);
      approved := approved || jsonb_build_object('question_id', qid, 'version_no', cur.version_no, 'primary_confirmed', case when confirmed then prop end);
    exception when others then
      if sqlstate = '42501' then raise; end if;
      blocked := blocked || jsonb_build_object('question_id', qid, 'reason', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('approved', approved, 'blocked', blocked, 'already', already);
end;
$$;
revoke execute on function cms.cms_approve_questions(text[], text) from public;
grant execute on function cms.cms_approve_questions(text[], text) to authenticated;

-- ---------------------------------------------------------------- blockers view (same columns)
create or replace view cms.cms_approval_blockers with (security_invoker = true) as
with cur as (
  select q.question_id, q.subject, q.class, q.chapter_id, q.topic_id, v.version_id, v.version_no, v.status, v.originality_pending, v.attributes_pending,
         v.image_status, v.misconception_targeted, v.misconception_row_id, v.misconception_item_no, v.created_from
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
    select 'image_to_redo', 'DL-040' where cur.subject = 'science' and cur.created_from = 'generation' and cur.image_status = 'has_image'
    union all
    select 'attributes_pending', null where cur.attributes_pending
    union all
    select 'science_solution1_empty', null where cur.subject = 'science'
       and not exists (select 1 from cms.cms_version_solutions s where s.version_id = cur.version_id and s.slot = 1 and btrim(s.text) <> '')
    union all
    select 'science_primary_not_confirmed',
           (select 'rejected: ' || string_agg(l.row_id, ', ' order by l.row_id) from cms.cms_question_content_rows l where l.version_id = cur.version_id and l.primary_rejected)
     where cur.subject = 'science'
       and (select count(*) from cms.cms_question_content_rows l where l.version_id = cur.version_id and l.rank = 'primary' and not l.rank_proposed) <> 1
       -- OL-044: a generated question's single proposed primary gets confirmed as the question is approved
       and not (cur.created_from = 'generation'
                and not exists (select 1 from cms.cms_question_content_rows l where l.version_id = cur.version_id and l.rank = 'primary' and not l.rank_proposed)
                and (select count(*) from cms.cms_question_content_rows l where l.version_id = cur.version_id and l.rank = 'primary' and l.rank_proposed) = 1)
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

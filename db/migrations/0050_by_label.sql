-- Q38 PR 1b (plan §2.7 / §11, Sambit 23 Nov 2026). Schema cms only; adds only. Plan: docs/plan-2026-11-23-q38-direct-generation.md.
--
--  by_label  cms_set_status and cms_approve_questions get a 6- / 3-argument form with p_by_label: the label written on the
--            audit rows (cms_reviews.by_label) of that approval, e.g. 'pack-approved GR0140' for gen:import --approve.
--            Null or blank = 'Sambit' (as today); at most 80 characters. Every approval rule is unchanged: the body is
--            the 0026 / 0048 one with only the label threaded through.
--            The existing 5- / 2-argument functions stay (same names, same arguments, same defaults, so every caller and
--            PostgREST resolve exactly as before) and now call the new form with a null label. The new forms have no
--            defaults, so no call can become ambiguous. Nothing else changes; no data is written.

-- ---------------------------------------------------------------- cms_set_status (0026 body + p_by_label)
create function cms.cms_set_status(p_question_id text, p_version_no int, p_action text, p_reason text,
                                   p_override_near_copy boolean, p_by_label text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  q cms.cms_questions;
  cur cms.cms_question_versions;
  next_status text;
  chk cms.cms_originality_checks;
  lbl text := coalesce(nullif(btrim(p_by_label), ''), 'Sambit');
begin
  if not cms.cms_is_admin(uid) then
    raise exception 'Only the CMS admin can review questions.' using errcode = '42501';
  end if;
  if length(lbl) > 80 then raise exception 'by_label is at most 80 characters.'; end if;
  select * into q from cms.cms_questions where question_id = p_question_id for update;
  if not found then raise exception 'Question % does not exist.', p_question_id; end if;
  if q.retired_at is not null then raise exception 'Question % is retired.', p_question_id; end if;
  if p_version_no is distinct from q.current_version then
    raise exception 'Only the current version (v%) can be reviewed.', q.current_version;
  end if;
  select * into cur from cms.cms_question_versions where question_id = p_question_id and version_no = p_version_no for update;
  next_status := case
    when p_action = 'submit' and cur.status = 'draft' then 'in_review'
    when p_action = 'withdraw' and cur.status = 'in_review' then 'draft'
    when p_action = 'approve' and cur.status in ('draft', 'in_review') then 'approved'
    when p_action = 'reject' and cur.status in ('draft', 'in_review') then 'rejected'
  end;
  if next_status is null then
    raise exception 'Can''t %: v% is %.', p_action, cur.version_no, cur.status;
  end if;
  if p_action = 'reject' and coalesce(btrim(p_reason), '') = '' then
    raise exception 'A rejection needs a reason.';
  end if;
  -- A near-copy of a book (latest local originality check) is approved only with an explicit,
  -- reasoned override, logged in cms_reviews (Sambit, 10 Nov 2026).
  if p_action = 'approve' then
    select * into chk from cms.cms_originality_checks where version_id = cur.version_id order by check_id desc limit 1;
    if found and chk.result = 'near_copy' then
      if not coalesce(p_override_near_copy, false)
         and exists (select 1 from cms.cms_override_requests o where o.version_id = cur.version_id and o.status = 'approved'
                      and (chk.field is null or o.field = chk.field)) then
        -- approved one by one in the Review tab (already logged as override_near_copy)
        null;
      elsif not coalesce(p_override_near_copy, false) then
        raise exception 'v% is a near-copy of a book (%). To approve it, tick "override: reviewed, not a copy" and give a reason.', cur.version_no, chk.closest_ref;
      end if;
      if coalesce(p_override_near_copy, false) then  -- a one-off override typed with the approval
      if coalesce(btrim(p_reason), '') = '' then
        raise exception 'Overriding a near-copy needs a reason.';
      end if;
      insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
        values ('question_version', 'cms_question_versions', p_question_id || ' v' || cur.version_no, 'override_near_copy', btrim(p_reason),
                jsonb_build_object('check_id', chk.check_id, 'closest_ref', chk.closest_ref, 'similarity', chk.similarity,
                                   'same_numbers', chk.same_numbers, 'override', 'reviewed, not a copy'), uid, lbl);
      end if;
    end if;
  end if;
  update cms.cms_question_versions set status = next_status where version_id = cur.version_id;
  if next_status = 'approved' then
    update cms.cms_questions set approved_version = cur.version_no where question_id = p_question_id;
  end if;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('question_version', 'cms_question_versions', p_question_id || ' v' || cur.version_no, p_action, nullif(btrim(p_reason), ''),
            jsonb_build_object('status', jsonb_build_object('before', cur.status, 'after', next_status)), uid, lbl);
  return jsonb_build_object('question_id', p_question_id, 'version_no', cur.version_no, 'status', next_status);
end;
$$;
revoke execute on function cms.cms_set_status(text, int, text, text, boolean, text) from public;
grant execute on function cms.cms_set_status(text, int, text, text, boolean, text) to authenticated;

create or replace function cms.cms_set_status(p_question_id text, p_version_no int, p_action text, p_reason text,
                                   p_override_near_copy boolean default false)
  returns jsonb
  language sql
  security definer
  set search_path = ''
as $$
  select cms.cms_set_status(p_question_id, p_version_no, p_action, p_reason, p_override_near_copy, null::text);
$$;

-- ---------------------------------------------------------------- cms_approve_questions (0048 body + p_by_label)
create function cms.cms_approve_questions(p_ids text[], p_reason text, p_by_label text)
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
      perform cms.cms_set_status(qid, cur.version_no, 'approve', p_reason, false, p_by_label);
      approved := approved || jsonb_build_object('question_id', qid, 'version_no', cur.version_no, 'primary_confirmed', case when confirmed then prop end);
    exception when others then
      if sqlstate = '42501' then raise; end if;
      blocked := blocked || jsonb_build_object('question_id', qid, 'reason', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('approved', approved, 'blocked', blocked, 'already', already);
end;
$$;
revoke execute on function cms.cms_approve_questions(text[], text, text) from public;
grant execute on function cms.cms_approve_questions(text[], text, text) to authenticated;

create or replace function cms.cms_approve_questions(p_ids text[], p_reason text)
  returns jsonb
  language sql
  security definer
  set search_path = ''
as $$
  select cms.cms_approve_questions(p_ids, p_reason, null::text);
$$;

-- A near-copy draft (latest local originality check = near_copy) can't be approved unless
-- Sambit ticks "override: reviewed, not a copy" and gives a reason; the override is logged
-- in cms_reviews (action override_near_copy) next to the approval (Sambit, 10 Nov 2026).
-- cms_set_status gains p_override_near_copy (default false); the old 4-argument form is
-- dropped so nothing can approve around the check.

alter table cms.cms_reviews drop constraint cms_reviews_action_check;
alter table cms.cms_reviews add constraint cms_reviews_action_check check (action in (
  'submit', 'approve', 'reject', 'typo_fix', 'retire', 'restore', 'edit_catalogue', 'import_replace_draft',
  'edit_draft', 'new_version', 'withdraw', 'create', 'remove_book_material', 'override_near_copy'));

drop function cms.cms_set_status(text, int, text, text);

create function cms.cms_set_status(p_question_id text, p_version_no int, p_action text, p_reason text,
                                   p_override_near_copy boolean default false)
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
begin
  if not cms.cms_is_admin(uid) then
    raise exception 'Only the CMS admin can review questions.' using errcode = '42501';
  end if;
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
      if not coalesce(p_override_near_copy, false) then
        raise exception 'v% is a near-copy of a book (%). To approve it, tick "override: reviewed, not a copy" and give a reason.', cur.version_no, chk.closest_ref;
      end if;
      if coalesce(btrim(p_reason), '') = '' then
        raise exception 'Overriding a near-copy needs a reason.';
      end if;
      insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
        values ('question_version', 'cms_question_versions', p_question_id || ' v' || cur.version_no, 'override_near_copy', btrim(p_reason),
                jsonb_build_object('check_id', chk.check_id, 'closest_ref', chk.closest_ref, 'similarity', chk.similarity,
                                   'same_numbers', chk.same_numbers, 'override', 'reviewed, not a copy'), uid, 'Sambit');
    end if;
  end if;
  update cms.cms_question_versions set status = next_status where version_id = cur.version_id;
  if next_status = 'approved' then
    update cms.cms_questions set approved_version = cur.version_no where question_id = p_question_id;
  end if;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('question_version', 'cms_question_versions', p_question_id || ' v' || cur.version_no, p_action, nullif(btrim(p_reason), ''),
            jsonb_build_object('status', jsonb_build_object('before', cur.status, 'after', next_status)), uid, 'Sambit');
  return jsonb_build_object('question_id', p_question_id, 'version_no', cur.version_no, 'status', next_status);
end;
$$;

revoke execute on function cms.cms_set_status(text, int, text, text, boolean) from public;
grant execute on function cms.cms_set_status(text, int, text, text, boolean) to authenticated;

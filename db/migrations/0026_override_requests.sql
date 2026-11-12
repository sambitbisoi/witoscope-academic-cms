-- Override requests (Sambit, 12 Nov 2026). The Math data thread asks for an override when a
-- near-copy field holds standard values that cannot change (e.g. the ½ / ¼ / ¾ turns a skill is
-- about). Nothing is applied automatically: import:updates records the every-field originality
-- check of the question's current version and files a PENDING request; Sambit approves or
-- declines each one in the Review tab. Approving logs override_near_copy with the reason; an
-- approved override then lets that version be approved without ticking the override again.
-- Declining needs a note. Rows are never deleted.

create table cms.cms_override_requests (
  request_id   bigint generated always as identity primary key,
  question_id  text not null references cms.cms_questions (question_id),
  version_id   bigint not null references cms.cms_question_versions (version_id),
  file_key     text,
  field        text not null,                    -- e.g. "options", "figure description"
  reason       text not null,                    -- why the values must stay (from the request)
  requested_by text not null,                    -- e.g. 'Math data thread'
  check_id     bigint references cms.cms_originality_checks (check_id),
  import_id    bigint references cms.cms_imports (import_id),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  decided_at   timestamptz,
  decided_by   uuid,
  decision_note text,
  created_at   timestamptz not null default now(),
  check ((status = 'pending') = (decided_at is null))
);
create unique index cms_override_requests_one_pending on cms.cms_override_requests (version_id, field) where status = 'pending';
create index cms_override_requests_question on cms.cms_override_requests (question_id);

alter table cms.cms_override_requests enable row level security;
grant select on cms.cms_override_requests to authenticated;
create policy cms_admin_only on cms.cms_override_requests for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_reviews drop constraint cms_reviews_action_check;
alter table cms.cms_reviews add constraint cms_reviews_action_check check (action in (
  'submit', 'approve', 'reject', 'typo_fix', 'retire', 'restore', 'edit_catalogue', 'import_replace_draft',
  'edit_draft', 'new_version', 'withdraw', 'create', 'remove_book_material', 'override_near_copy', 'import_update',
  'decline_override'));

-- Approve or decline one request (admin only, logged).
create function cms.cms_decide_override(p_request_id bigint, p_approve boolean, p_note text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  r cms.cms_override_requests;
  v cms.cms_question_versions;
  chk cms.cms_originality_checks;
begin
  if not cms.cms_is_admin(uid) then
    raise exception 'Only the CMS admin can decide overrides.' using errcode = '42501';
  end if;
  select * into r from cms.cms_override_requests where request_id = p_request_id for update;
  if not found then raise exception 'Override request % does not exist.', p_request_id; end if;
  if r.status <> 'pending' then raise exception 'Override request % is already %.', p_request_id, r.status; end if;
  if not p_approve and coalesce(btrim(p_note), '') = '' then raise exception 'Declining an override needs a note.'; end if;
  select * into v from cms.cms_question_versions where version_id = r.version_id;
  if r.check_id is not null then select * into chk from cms.cms_originality_checks where check_id = r.check_id; end if;
  update cms.cms_override_requests set status = case when p_approve then 'approved' else 'declined' end,
         decided_at = now(), decided_by = uid, decision_note = nullif(btrim(p_note), '')
   where request_id = p_request_id;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('question_version', 'cms_override_requests', r.question_id || ' v' || v.version_no,
            case when p_approve then 'override_near_copy' else 'decline_override' end,
            r.reason || coalesce(' — ' || nullif(btrim(p_note), ''), ''),
            jsonb_build_object('request_id', r.request_id, 'field', r.field, 'check_id', r.check_id, 'closest_ref', chk.closest_ref,
                               'similarity', chk.similarity, 'same_numbers', chk.same_numbers, 'requested_by', r.requested_by,
                               'override', case when p_approve then 'reviewed, not a copy' else 'declined' end), uid, 'Sambit');
  return jsonb_build_object('request_id', p_request_id, 'status', case when p_approve then 'approved' else 'declined' end);
end;
$$;

revoke execute on function cms.cms_decide_override(bigint, boolean, text) from public;
grant execute on function cms.cms_decide_override(bigint, boolean, text) to authenticated;

-- cms_set_status (from 0017): a near-copy version may also be approved when an override for it
-- (the field its latest check names) has been approved one by one.
create or replace function cms.cms_set_status(p_question_id text, p_version_no int, p_action text, p_reason text,
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
                                   'same_numbers', chk.same_numbers, 'override', 'reviewed, not a copy'), uid, 'Sambit');
      end if;
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


-- Round 1, Q19 + Q22 (Sambit, 17 Nov 2026). Schema cms only; adds only (one function, one view).
--
--  Q19  cms_decide_overrides(ids, approve, note): decide several pending override requests in ONE transaction. Each one goes
--       through the existing cms_decide_override, so each gets its own cms_reviews row (override_near_copy / decline_override),
--       exactly as when decided one by one. If any ID is not pending, nothing is written. Unticked requests stay Pending.
--  Q22  cms_approval_blockers: why each open (not approved) current version of a production question can't be approved yet,
--       one row per reason, mirroring the approval rules of cms_version_flags (0035) and cms_set_status (0026). Read-only;
--       security_invoker, so RLS applies. The Decisions inbox reads it.

create function cms.cms_decide_overrides(p_ids bigint[], p_approve boolean, p_note text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  bad text;
  i bigint;
  n int := 0;
begin
  if not cms.cms_is_admin(uid) then
    raise exception 'Only the CMS admin can decide overrides.' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_ids), 0) = 0 then raise exception 'No override requests selected.'; end if;
  if not p_approve and coalesce(btrim(p_note), '') = '' then raise exception 'Declining overrides needs a note.'; end if;
  perform 1 from cms.cms_override_requests where request_id = any(p_ids) order by request_id for update;
  select string_agg(x::text || coalesce(' (' || o.status || ')', ' (does not exist)'), ', ') into bad
    from unnest(p_ids) x left join cms.cms_override_requests o on o.request_id = x
   where o.status is distinct from 'pending';
  if bad is not null then raise exception 'Not pending: %. Nothing was decided.', bad; end if;
  foreach i in array (select array_agg(distinct x order by x) from unnest(p_ids) x) loop
    perform cms.cms_decide_override(i, p_approve, p_note);
    n := n + 1;
  end loop;
  return jsonb_build_object('decided', n, 'status', case when p_approve then 'approved' else 'declined' end);
end;
$$;
revoke execute on function cms.cms_decide_overrides(bigint[], boolean, text) from public;
grant execute on function cms.cms_decide_overrides(bigint[], boolean, text) to authenticated;

-- ---------------------------------------------------------------- Q22: approval blockers (one row per reason)
create view cms.cms_approval_blockers with (security_invoker = true) as
with cur as (
  select q.question_id, q.subject, q.class, q.chapter_id, q.topic_id, v.version_id, v.version_no, v.status, v.originality_pending, v.attributes_pending,
         v.image_status, v.misconception_targeted, v.misconception_row_id, v.misconception_item_no
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
    select 'attributes_pending', null where cur.attributes_pending
    union all
    select 'science_solution1_empty', null where cur.subject = 'science'
       and not exists (select 1 from cms.cms_version_solutions s where s.version_id = cur.version_id and s.slot = 1 and btrim(s.text) <> '')
    union all
    select 'science_primary_not_confirmed', null where cur.subject = 'science'
       and (select count(*) from cms.cms_question_content_rows l where l.version_id = cur.version_id and l.rank = 'primary' and not l.rank_proposed) <> 1
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
  ) r;
grant select on cms.cms_approval_blockers to authenticated;

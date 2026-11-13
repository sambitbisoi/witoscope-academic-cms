-- Review status per topic (Sambit, 13 Nov 2026): not started (default, no row) · in progress ·
-- done, with who / when and an optional short note. One status per topic, shared by every class
-- the topic appears in. Manual only: nothing sets it automatically. Every change goes through
-- cms_set_topic_review and is logged in cms_reviews (before → after). Rows are never deleted;
-- going back to "not started" keeps the row with that status.

create table cms.cms_topic_reviews (
  topic_id   text primary key references cms.cms_topics (topic_id),
  status     text not null check (status in ('not_started', 'in_progress', 'done')),
  note       text check (note is null or char_length(note) <= 300),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table cms.cms_topic_reviews enable row level security;
grant select on cms.cms_topic_reviews to authenticated;
create policy cms_admin_only on cms.cms_topic_reviews for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_reviews drop constraint cms_reviews_action_check;
alter table cms.cms_reviews add constraint cms_reviews_action_check check (action in (
  'submit', 'approve', 'reject', 'typo_fix', 'retire', 'restore', 'edit_catalogue', 'import_replace_draft',
  'edit_draft', 'new_version', 'withdraw', 'create', 'remove_book_material', 'override_near_copy', 'import_update',
  'decline_override', 'review_status'));

-- Set a topic's review status (admin only, logged before → after; no log when nothing changes).
create function cms.cms_set_topic_review(p_topic_id text, p_status text, p_note text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  old cms.cms_topic_reviews;
  new_note text := nullif(btrim(coalesce(p_note, '')), '');
  old_status text;
begin
  if not cms.cms_is_admin(uid) then
    raise exception 'Only the CMS admin can set a review status.' using errcode = '42501';
  end if;
  if p_status not in ('not_started', 'in_progress', 'done') then
    raise exception 'Unknown review status %.', p_status;
  end if;
  if not exists (select 1 from cms.cms_topics where topic_id = p_topic_id) then
    raise exception 'Topic % does not exist.', p_topic_id;
  end if;
  if char_length(coalesce(new_note, '')) > 300 then raise exception 'The note is limited to 300 characters.'; end if;
  select * into old from cms.cms_topic_reviews where topic_id = p_topic_id for update;
  old_status := coalesce(old.status, 'not_started');
  if old_status = p_status and old.note is not distinct from new_note then
    return jsonb_build_object('topic_id', p_topic_id, 'status', p_status, 'changed', false);
  end if;
  insert into cms.cms_topic_reviews (topic_id, status, note, updated_at, updated_by)
    values (p_topic_id, p_status, new_note, now(), uid)
    on conflict (topic_id) do update set status = excluded.status, note = excluded.note, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
    values ('catalogue', 'cms_topic_reviews', p_topic_id, 'review_status', new_note,
            jsonb_build_object('status', jsonb_build_object('before', old_status, 'after', p_status),
                               'note', jsonb_build_object('before', old.note, 'after', new_note)), uid, 'Sambit');
  return jsonb_build_object('topic_id', p_topic_id, 'status', p_status, 'changed', true);
end;
$$;

revoke execute on function cms.cms_set_topic_review(text, text, text) from public;
grant execute on function cms.cms_set_topic_review(text, text, text) to authenticated;

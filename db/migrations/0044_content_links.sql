-- Q23 (Sambit, 17 Nov 2026; docs/plan-2026-11-17-q23-q35.md): edit the linked content rows of an existing Science
-- question (review box and Science Edit form). Schema cms only; adds only (two functions). No table change, no data change.
--
-- p = { question_id, version_no, reason?, links: [{ row_id, rank: 'primary' | 'secondary' | 'context' }] }
--   the FULL wanted set of links of the current version. primary / secondary = direct rows; context = a supporting row.
-- Rules:
--   * open drafts only (draft / in review); an approved question: Edit → new version first (its links are carried)
--   * every row exists; a row linked anew must not be retired; no row twice
--   * exactly one primary, and this Save confirms it (rank_proposed = false)
--   * the misconception targeted, a wrong option's misconception item and a concept-error target row must stay on linked
--     rows: removing such a row, or demoting it from direct to supporting, is refused ("clear the reference first")
-- One cms_reviews row, before → after: action science_review (an action the CHECK already allows, so no constraint is
-- replaced), target_table cms_question_content_rows, field_diff key "links". The draft is marked edited (an import never replaces it).

-- The version's links as one sorted list ("C6-04-001 primary"), for the audit.
create function cms.cms_content_links_state(p_version_id bigint)
  returns jsonb
  language sql
  stable
  set search_path = ''
as $$
  select coalesce(jsonb_agg(l.row_id || ' ' || l.rank || case when l.rank_proposed then ' (proposed)' else '' end
                            order by case l.rank when 'primary' then 0 when 'secondary' then 1 else 2 end, l.row_id), '[]'::jsonb)
    from cms.cms_question_content_rows l where l.version_id = p_version_id;
$$;

create function cms.cms_save_content_links(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := cms.cms_current_uid();
  q cms.cms_questions;
  cur cms.cms_question_versions;
  vid bigint;
  wanted jsonb := coalesce(p -> 'links', '[]'::jsonb);
  bad text;
  ref record;
  before jsonb;
  after jsonb;
begin
  if not cms.cms_is_admin(uid) then raise exception 'Only the CMS admin can change linked content.' using errcode = '42501'; end if;
  select * into q from cms.cms_questions where question_id = p ->> 'question_id' for update;
  if not found then raise exception 'Question % does not exist.', p ->> 'question_id'; end if;
  if q.subject <> 'science' then raise exception 'Linked content rows are for Science questions only.'; end if;
  if q.retired_at is not null then raise exception 'Question % is retired.', q.question_id; end if;
  if (p ->> 'version_no')::int is distinct from q.current_version then
    raise exception 'Question % changed since you opened it (it is now at v%). Reload and try again.', q.question_id, q.current_version;
  end if;
  select * into cur from cms.cms_question_versions where question_id = q.question_id and version_no = q.current_version for update;
  if cur.status not in ('draft', 'in_review') then
    raise exception 'v% is %; use Edit to make a new version first (its links are carried), then change its links.', cur.version_no, cur.status;
  end if;
  vid := cur.version_id;
  if jsonb_typeof(wanted) <> 'array' then raise exception 'links must be a list.'; end if;

  -- shape: known ranks, no row twice, rows exist, a new row is not retired
  select c ->> 'row_id' into bad from jsonb_array_elements(wanted) c where coalesce(c ->> 'rank', '') not in ('primary', 'secondary', 'context') limit 1;
  if found then raise exception 'Row %: the role must be primary, secondary or supporting.', coalesce(bad, '(no row ID)'); end if;
  select c ->> 'row_id' into bad from jsonb_array_elements(wanted) c group by c ->> 'row_id' having count(*) > 1 limit 1;
  if found then raise exception 'Row % is linked twice.', bad; end if;
  select c ->> 'row_id' into bad from jsonb_array_elements(wanted) c
   where not exists (select 1 from cms.cms_content_rows r where r.row_id = c ->> 'row_id') limit 1;
  if found then raise exception 'Content row % does not exist.', bad; end if;
  select c ->> 'row_id' into bad from jsonb_array_elements(wanted) c
    join cms.cms_content_rows r on r.row_id = c ->> 'row_id'
   where r.retired_at is not null
     and not exists (select 1 from cms.cms_question_content_rows l where l.version_id = vid and l.row_id = r.row_id) limit 1;
  if found then raise exception 'Content row % is retired; it can''t be linked.', bad; end if;
  if (select count(*) from jsonb_array_elements(wanted) c where c ->> 'rank' = 'primary') <> 1 then
    raise exception 'A Science question needs exactly one primary row (it now has %).', (select count(*) from jsonb_array_elements(wanted) c where c ->> 'rank' = 'primary');
  end if;

  -- references must stay on linked rows, and on a direct row if they are on one now
  for ref in
    select x.row_id, x.what from (
      select v.misconception_row_id as row_id, 'the misconception targeted (' || v.misconception_row_id || ' #' || v.misconception_item_no || ')' as what
        from cms.cms_question_versions v where v.version_id = vid and v.misconception_row_id is not null
      union all
      select w.mc_row_id, 'option ' || chr(64 + w.option_position) || '''s misconception (' || w.mc_row_id || ' #' || w.mc_item_no || ')'
        from cms.cms_version_wrong_answers w where w.version_id = vid and w.mc_row_id is not null and w.option_position is not null
      union all
      select w.target_row_id, 'option ' || chr(64 + w.option_position) || '''s concept-error target'
        from cms.cms_version_wrong_answers w where w.version_id = vid and w.target_row_id is not null and w.option_position is not null
    ) x
  loop
    if not exists (select 1 from jsonb_array_elements(wanted) c where c ->> 'row_id' = ref.row_id) then
      raise exception 'Row % is still used by %; clear the reference first.', ref.row_id, ref.what;
    end if;
    if exists (select 1 from cms.cms_question_content_rows l where l.version_id = vid and l.row_id = ref.row_id and l.role = 'direct')
       and exists (select 1 from jsonb_array_elements(wanted) c where c ->> 'row_id' = ref.row_id and c ->> 'rank' = 'context') then
      raise exception 'Row % is still used by %; clear the reference first, then make it supporting.', ref.row_id, ref.what;
    end if;
  end loop;

  before := cms.cms_content_links_state(vid);

  -- apply: remove, then move every kept / new row to its role without primary, then set the one primary
  delete from cms.cms_question_content_rows l
   where l.version_id = vid and not exists (select 1 from jsonb_array_elements(wanted) c where c ->> 'row_id' = l.row_id);
  update cms.cms_question_content_rows l
     set role = case c ->> 'rank' when 'context' then 'supporting' else 'direct' end,
         rank = case c ->> 'rank' when 'context' then 'context' else 'secondary' end, rank_proposed = false
    from jsonb_array_elements(wanted) c
   where l.version_id = vid and l.row_id = c ->> 'row_id'
     and (l.role, l.rank, l.rank_proposed) is distinct from (case c ->> 'rank' when 'context' then 'supporting' else 'direct' end,
                                                           case c ->> 'rank' when 'context' then 'context' else 'secondary' end, false);
  insert into cms.cms_question_content_rows (version_id, row_id, role, rank, rank_proposed)
    select vid, c ->> 'row_id', case c ->> 'rank' when 'context' then 'supporting' else 'direct' end,
           case c ->> 'rank' when 'context' then 'context' else 'secondary' end, false
      from jsonb_array_elements(wanted) c
     where not exists (select 1 from cms.cms_question_content_rows l where l.version_id = vid and l.row_id = c ->> 'row_id');
  update cms.cms_question_content_rows l set rank = 'primary', rank_proposed = false
   where l.version_id = vid and l.row_id = (select c ->> 'row_id' from jsonb_array_elements(wanted) c where c ->> 'rank' = 'primary');

  after := cms.cms_content_links_state(vid);
  if after is distinct from before then
    update cms.cms_question_versions set edited_at = now() where version_id = vid;
    insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_user, by_label)
      values ('question_version', 'cms_question_content_rows', q.question_id || ' v' || cur.version_no, 'science_review',
              coalesce(nullif(btrim(p ->> 'reason'), ''), 'Linked content'),
              jsonb_build_object('links', jsonb_build_object('before', before, 'after', after)), uid, 'Sambit');
  end if;
  return jsonb_build_object('question_id', q.question_id, 'version_no', cur.version_no, 'changed', after is distinct from before, 'links', after);
end;
$$;

revoke execute on function cms.cms_content_links_state(bigint) from public;
revoke execute on function cms.cms_save_content_links(jsonb) from public;
grant execute on function cms.cms_save_content_links(jsonb) to authenticated;

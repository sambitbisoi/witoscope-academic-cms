-- "Approved" means ready for the app (Sambit, 13 Nov 2026, decision 2 on #18). Besides a pending
-- originality check, a version can't be approved while
--   * its picture is still pending (image_status = 'needs_image': a picture is needed, none yet), or
--   * its attributes are pending (signature and derived fields not evaluated).
-- This holds for every production question, not only added or uploaded ones. Gold questions are
-- never published, so the picture and attribute rules don't apply to them. Versions already
-- approved stay approved; the rule applies when a version becomes approved.

create or replace function cms.cms_version_flags()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
declare
  bank text;
  becoming_approved boolean;
begin
  if tg_op = 'INSERT' and new.created_from = 'edit' then
    new.originality_pending := coalesce((select v.originality_pending from cms.cms_question_versions v
                                          where v.question_id = new.question_id and v.version_no = new.version_no - 1), false);
  end if;
  if new.attributes_pending and new.reading is not null and new.steps is not null and new.working_memory is not null
     and new.inhibition is not null and new.visual is not null and new.strategy is not null and new.math_difficulty is not null then
    new.attributes_pending := false;
  end if;
  becoming_approved := new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved');
  if becoming_approved then
    if new.originality_pending then
      raise exception 'v% of % can''t be approved yet: its originality check is pending (run the pending originality check from the Mac).',
        new.version_no, new.question_id;
    end if;
    select q.bank into bank from cms.cms_questions q where q.question_id = new.question_id;
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

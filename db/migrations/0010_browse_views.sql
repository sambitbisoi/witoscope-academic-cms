-- Read-only views for Browse (Phase 3, docs/phase3-plan.md §3).
-- The REST API caps a response at 1,000 rows, so counts are computed here.
-- Every view is security_invoker: it runs with the caller's rights, so the RLS
-- on the underlying tables still applies (an app user sees zero rows).

-- One row per question, with its current version and gold use.
create view cms.cms_question_list with (security_invoker = true) as
select
  q.question_id, q.bank, q.subject, q.file_key, q.chapter_id, q.topic_id, q.class, q.class_override,
  q.typical_set_id, q.pattern_id, q.clone_batch_id, q.current_version, q.approved_version, q.retired_at,
  v.version_id, v.status, v.text, v.format, v.math_difficulty, v.tier, v.strategy, v.load, v.trap_level,
  v.created_from, v.created_at as version_created_at,
  g.use as gold_use,
  -- counts towards coverage: production, not retired, and either the current
  -- version is not rejected or an earlier version is approved
  (q.bank = 'production' and q.retired_at is null and (v.status <> 'rejected' or q.approved_version is not null)) as counted
from cms.cms_questions q
join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
left join cms.cms_gold_meta g on g.question_id = q.question_id;

-- One row per topic: question counts by difficulty, status and bank.
create view cms.cms_topic_stats with (security_invoker = true) as
select
  t.topic_id, t.chapter_id, t.class, t.topic_kind, t.status,
  (count(l.question_id) filter (where l.counted))::int                                         as n_questions,
  (count(l.question_id) filter (where l.counted and l.math_difficulty = 'Simple'))::int        as n_simple,
  (count(l.question_id) filter (where l.counted and l.math_difficulty = 'Medium'))::int        as n_medium,
  (count(l.question_id) filter (where l.counted and l.math_difficulty = 'Complex'))::int       as n_complex,
  (count(l.question_id) filter (where l.counted and l.status = 'draft'))::int                  as n_draft,
  (count(l.question_id) filter (where l.counted and l.status = 'in_review'))::int              as n_in_review,
  (count(l.question_id) filter (where l.counted and l.approved_version is not null))::int      as n_approved,
  (count(l.question_id) filter (where l.bank = 'gold' and l.retired_at is null))::int          as n_gold
from cms.cms_topics t
left join cms.cms_question_list l on l.topic_id = t.topic_id
group by t.topic_id;

-- One row per subject and class, for the Home cards.
create view cms.cms_home_stats with (security_invoker = true) as
select
  c.subject, s.class,
  (count(distinct s.chapter_id))::int                                                            as chapters,
  (count(*) filter (where s.topic_kind = 'normal' and s.status = 'active'))::int                 as topics,
  (sum(s.n_questions))::int                                                                      as questions,
  (sum(s.n_approved))::int                                                                       as approved,
  (sum(s.n_draft))::int                                                                          as draft,
  (sum(s.n_in_review))::int                                                                      as in_review,
  (sum(s.n_gold))::int                                                                           as gold,
  (count(*) filter (where s.topic_kind = 'normal' and s.status = 'active' and s.n_questions > 0))::int as topics_with_questions,
  (count(*) filter (where s.topic_kind = 'normal' and s.status = 'active'
                      and s.n_simple > 0 and s.n_medium > 0 and s.n_complex > 0))::int          as topics_all_levels
from cms.cms_topic_stats s
join cms.cms_chapters c on c.chapter_id = s.chapter_id
group by c.subject, s.class;

grant select on cms.cms_question_list to authenticated;
grant select on cms.cms_topic_stats to authenticated;
grant select on cms.cms_home_stats to authenticated;

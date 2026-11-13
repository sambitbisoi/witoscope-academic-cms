-- Round 2, R1 (Sambit, 13 Nov 2026): every topic–class link gets a role, from the topic's home
-- class (the class it sits in on the Class View):
--   core   = home class = this class
--   lower  = from a lower class  (home < this class)
--   higher = from a higher class (home > this class)
-- Browse shows core topics by default; the lower / higher ones are "extra" and appear only when
-- asked for. The Level ≤ class display rule (D3) is unchanged. Columns are only appended, so the
-- views that read these two keep working.

create or replace view cms.cms_topic_all_classes with (security_invoker = true) as
select t.topic_id, t.class, 'home'::text as source, null::text as evidence, 'core'::text as role, t.class as home_class
from cms.cms_topics t
union
select c.topic_id, c.class, c.source, c.evidence,
       case when t.class < c.class then 'lower' else 'higher' end as role, t.class as home_class
from cms.cms_topic_classes c
join cms.cms_topics t on t.topic_id = c.topic_id
where t.class <> c.class;

create or replace view cms.cms_topic_class_stats with (security_invoker = true) as
select
  a.topic_id, a.class, t.chapter_id, t.topic_kind, t.status,
  (count(l.question_id) filter (where l.counted))::int                                    as n_questions,
  (count(l.question_id) filter (where l.counted and l.math_difficulty = 'Simple'))::int   as n_simple,
  (count(l.question_id) filter (where l.counted and l.math_difficulty = 'Medium'))::int   as n_medium,
  (count(l.question_id) filter (where l.counted and l.math_difficulty = 'Complex'))::int  as n_complex,
  (count(l.question_id) filter (where l.counted and l.status = 'draft'))::int             as n_draft,
  (count(l.question_id) filter (where l.counted and l.status = 'in_review'))::int         as n_in_review,
  (count(l.question_id) filter (where l.counted and l.approved_version is not null))::int as n_approved,
  (count(l.question_id) filter (where l.bank = 'gold' and l.retired_at is null))::int     as n_gold,
  (count(l.question_id) filter (where l.counted and l.effective_level < a.class))::int    as n_revision,
  (count(distinct l.clone_key) filter (where l.counted and l.clone_key is not null))::int as n_clone_groups,
  a.role, a.home_class
from cms.cms_topic_all_classes a
join cms.cms_topics t on t.topic_id = a.topic_id
left join cms.cms_question_list l on l.topic_id = a.topic_id and l.effective_level <= a.class
group by a.topic_id, a.class, t.chapter_id, t.topic_kind, t.status, a.role, a.home_class;

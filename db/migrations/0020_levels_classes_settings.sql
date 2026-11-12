-- Data model from the work queue of 12 Nov 2026 (docs/queue-2026-11-12.md, PR B), agreed by Sambit.
--   D1 Question Level (1–6): the class a question is written for (from the book class). On the
--      question, like its placement note; set by the updates importer (audited) and shown in
--      question detail. Null = not set yet; the question's class stands in for it.
--   D2 Topic ↔ many classes: cms_topic_classes. A topic's own class (cms_topics.class) always
--      counts; this table adds the other classes it is taught in, with the evidence.
--   D3 Display rule: a question shows in class N when its topic is in class N AND its level ≤ N.
--      Lower-level questions are revision in higher classes; a higher level never shows in a
--      lower class. Views cms_question_classes and cms_topic_class_stats.
--   D4 Topic prerequisites: cms_topic_prereqs, a placeholder (no data yet; edited from PR C).
--   D8a Setting: the story/context of a question (Lift, Thermometer, Bare …), from a small
--      catalogue (cms_settings, status proposed/active/retired); one per question.
--   D8c Clone groups (computed, never stored): same pattern + same authored signature + same
--      concepts and involvement = interchangeable. cms_question_list gains clone_key.
-- Everything is in schema cms; nothing is deleted.

alter table cms.cms_questions add column level int check (level between 1 and 6);

create table cms.cms_topic_classes (
  topic_id   text not null references cms.cms_topics (topic_id),
  class      int  not null check (class between 1 and 6),
  source     text not null,                -- NCERT / DAV / ISO / IXL / workbook-default / CMS
  evidence   text,
  import_id  bigint references cms.cms_imports (import_id),
  updated_at timestamptz not null default now(),
  primary key (topic_id, class)
);

create table cms.cms_topic_prereqs (
  topic_id        text not null references cms.cms_topics (topic_id),
  prereq_topic_id text not null references cms.cms_topics (topic_id),
  note            text,
  updated_at      timestamptz not null default now(),
  primary key (topic_id, prereq_topic_id),
  check (topic_id <> prereq_topic_id)
);

create table cms.cms_settings (
  setting_id  text primary key check (setting_id ~ '^SET[0-9]{3,4}$'),
  name        text not null,
  description text,
  theme       text,
  status      text not null default 'proposed' check (status in ('proposed', 'active', 'retired')),
  import_id   bigint references cms.cms_imports (import_id),
  updated_at  timestamptz not null default now()
);
create unique index cms_settings_name on cms.cms_settings (lower(name));

alter table cms.cms_questions
  add column setting_id         text references cms.cms_settings (setting_id),
  add column setting_confidence text check (setting_confidence in ('high', 'medium', 'low')),
  add column setting_note       text;

create index cms_questions_setting on cms.cms_questions (setting_id);
create index cms_topic_classes_class on cms.cms_topic_classes (class);

alter table cms.cms_topic_classes enable row level security;
alter table cms.cms_topic_prereqs enable row level security;
alter table cms.cms_settings enable row level security;
grant select on cms.cms_topic_classes, cms.cms_topic_prereqs, cms.cms_settings to authenticated;
create policy cms_admin_only on cms.cms_topic_classes for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));
create policy cms_admin_only on cms.cms_topic_prereqs for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));
create policy cms_admin_only on cms.cms_settings for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_imports drop constraint cms_imports_kind_check;
alter table cms.cms_imports add constraint cms_imports_kind_check check (kind in ('chapter', 'topics', 'seed', 'sources', 'book', 'originality', 'proposals', 'figures', 'updates'));

-- cms_question_list gains the D1 / D8 columns at the end (create or replace keeps dependants).
create or replace view cms.cms_question_list with (security_invoker = true) as
select
  q.question_id, q.bank, q.subject, q.file_key, q.chapter_id, q.topic_id, q.class, q.class_override,
  q.typical_set_id, q.pattern_id, q.clone_batch_id, q.current_version, q.approved_version, q.retired_at,
  v.version_id, v.status, v.text, v.format, v.math_difficulty, v.tier, v.strategy, v.load, v.trap_level,
  v.created_from, v.created_at as version_created_at,
  g.use as gold_use,
  (q.bank = 'production' and q.retired_at is null and (v.status <> 'rejected' or q.approved_version is not null)) as counted,
  q.level,
  coalesce(q.level, q.class) as effective_level,
  q.setting_id,
  -- D8c: questions with a pattern and the same signature and concepts share a clone key
  case when q.pattern_id is null then null else md5(concat_ws('|',
    q.pattern_id, v.math_difficulty, v.is_pure_fact, v.reading, v.has_irrelevant_info, v.steps, v.working_memory,
    v.inhibition, v.visual, v.strategy, v.strategy_type, v.strategy_type_2, v.insight_id,
    (select string_agg(c.part_label || ':' || c.concept_id || ':' || c.involvement::text, ',' order by c.part_label, c.concept_id)
       from cms.cms_version_concepts c where c.version_id = v.version_id))) end as clone_key
from cms.cms_questions q
join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
left join cms.cms_gold_meta g on g.question_id = q.question_id;

-- Every class a topic is in: its own class plus the mapped ones.
create view cms.cms_topic_all_classes with (security_invoker = true) as
select t.topic_id, t.class, 'home'::text as source, null::text as evidence from cms.cms_topics t
union
select c.topic_id, c.class, c.source, c.evidence from cms.cms_topic_classes c
where not exists (select 1 from cms.cms_topics t where t.topic_id = c.topic_id and t.class = c.class);

-- D3: where each question shows (home = the class of its level; revision = higher classes).
create view cms.cms_question_classes with (security_invoker = true) as
select l.question_id, l.topic_id, a.class, l.effective_level, (a.class = l.effective_level) as is_home
from cms.cms_question_list l
join cms.cms_topic_all_classes a on a.topic_id = l.topic_id
where l.effective_level <= a.class;

-- Topic counts per class, applying D3 (the tree and the curriculum map for one class).
create view cms.cms_topic_class_stats with (security_invoker = true) as
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
  (count(distinct l.clone_key) filter (where l.counted and l.clone_key is not null))::int as n_clone_groups
from cms.cms_topic_all_classes a
join cms.cms_topics t on t.topic_id = a.topic_id
left join cms.cms_question_list l on l.topic_id = a.topic_id and l.effective_level <= a.class
group by a.topic_id, a.class, t.chapter_id, t.topic_kind, t.status;

grant select on cms.cms_topic_all_classes, cms.cms_question_classes, cms.cms_topic_class_stats to authenticated;

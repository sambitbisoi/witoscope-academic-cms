-- Each version records where it was placed (approved by Sambit, 9 Nov 2026).
-- A topic / typical set / pattern move creates a new version (design §3), so the
-- placement belongs to the version. cms_questions keeps the same fields as
-- pointers to the CURRENT placement.

alter table cms.cms_question_versions
  add column topic_id       text references cms.cms_topics (topic_id),
  add column typical_set_id text references cms.cms_typical_sets (typical_set_id),
  add column pattern_id     text references cms.cms_patterns (pattern_id);

-- Backfill from the current pointers (no-op on an empty bank).
update cms.cms_question_versions v
set topic_id = q.topic_id, typical_set_id = q.typical_set_id, pattern_id = q.pattern_id
from cms.cms_questions q
where q.question_id = v.question_id and v.topic_id is null;

alter table cms.cms_question_versions alter column topic_id set not null;

create index cms_question_versions_topic on cms.cms_question_versions (topic_id);

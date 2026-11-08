-- B. Catalogues: tagging vocabulary (design §2B). Edited in place with an audit
-- row in cms_reviews; never deleted (retire, deactivate or merge).

create table cms.cms_concepts (
  concept_id       text primary key check (concept_id ~ '^G[1-6]-[A-Z]{2,4}-[CA][0-9]+$'),
  subject          text not null check (subject in ('math', 'science', 'grammar')),
  class            int  not null check (class between 1 and 6),
  topic_id         text references cms.cms_topics (topic_id),
  name             text not null,
  type             text check (type in ('core', 'applied')),
  description      text,
  includes         text,
  excludes         text,
  example_question text,
  curriculum_tags  text[] not null default '{}',
  status           text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  updated_at       timestamptz not null default now()
);

create table cms.cms_concept_links (
  from_concept text not null references cms.cms_concepts (concept_id),
  to_concept   text not null references cms.cms_concepts (concept_id),
  kind         text not null check (kind in ('builds_on', 'prerequisite')),
  flagged      boolean not null default false,  -- target is in an earlier chapter
  primary key (from_concept, to_concept, kind),
  check (from_concept <> to_concept)
);

create table cms.cms_concept_prereq_topics (
  concept_id text not null references cms.cms_concepts (concept_id),
  topic_id   text not null references cms.cms_topics (topic_id),
  primary key (concept_id, topic_id)
);

create table cms.cms_misconceptions (
  misconception_id    text primary key check (misconception_id ~ '^G[1-6]-M-[A-Z]{2,4}[0-9]+$'),
  concept_id          text references cms.cms_concepts (concept_id),
  description         text not null,
  parent_description  text,
  root_prereq_concept text references cms.cms_concepts (concept_id),
  alias               text,                -- legacy MM###
  status              text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  updated_at          timestamptz not null default now()
);
create unique index cms_misconceptions_alias on cms.cms_misconceptions (alias) where alias is not null;

create table cms.cms_typical_sets (
  typical_set_id      text primary key check (typical_set_id ~ '^TS-G[1-6]-[A-Z0-9-]+$'),
  subject             text not null check (subject in ('math', 'science', 'grammar')),
  class               int  not null check (class between 1 and 6),
  chapter_id          text references cms.cms_chapters (chapter_id),
  topic_id            text references cms.cms_topics (topic_id),
  name                text not null,
  instruction_pattern text,
  variant_note        text,
  parent_visible      boolean not null default true,
  status              text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  updated_at          timestamptz not null default now()
);

create table cms.cms_typical_set_concepts (
  typical_set_id text not null references cms.cms_typical_sets (typical_set_id),
  concept_id     text not null references cms.cms_concepts (concept_id),
  role           text not null check (role in ('main', 'other')),
  primary key (typical_set_id, concept_id)
);

create table cms.cms_strategy_types (
  value   text primary key,                -- 13 moves + Other
  example text,
  hint_1  text,
  sort    int,
  active  boolean not null default true
);

create table cms.cms_insights (
  insight_id       text primary key check (insight_id ~ '^INS-[A-Z0-9-]+$'),
  name             text not null,
  strategy_type    text references cms.cms_strategy_types (value),
  structure        text,
  recognition_test text,
  includes         text,
  excludes         text,
  parent_line      text,
  kid_hint         text,
  status           text not null default 'proposed' check (status in ('proposed', 'active', 'merged', 'inactive')),
  merged_into      text references cms.cms_insights (insight_id),
  updated_at       timestamptz not null default now(),
  check ((status = 'merged') = (merged_into is not null))
);

create table cms.cms_patterns (
  pattern_id            text primary key check (pattern_id ~ '^(MP|SP|GP)[0-9]{4}$'),
  topic_id              text not null references cms.cms_topics (topic_id),
  typical_set_id        text not null references cms.cms_typical_sets (typical_set_id),
  name                  text not null,
  template              text,
  variables             jsonb not null default '{}',
  target_misconceptions text[] not null default '{}',
  source_refs           text[] not null default '{}',  -- internal only
  notes                 text,
  status                text not null default 'active' check (status in ('draft', 'active', 'retired')),
  updated_at            timestamptz not null default now()
);

create index cms_concepts_topic on cms.cms_concepts (topic_id);
create index cms_typical_sets_topic on cms.cms_typical_sets (topic_id);
create index cms_patterns_topic on cms.cms_patterns (topic_id);

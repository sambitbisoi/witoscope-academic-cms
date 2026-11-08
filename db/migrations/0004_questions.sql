-- C. Questions, versioned (design §2C, §3, §4).
-- Versions are immutable except for logged typo fixes (design §3).

create sequence cms.cms_mq_seq;   -- MQ000001 …
create sequence cms.cms_sq_seq;   -- SQ000001 …
create sequence cms.cms_gq_seq;   -- GQ000001 …

create table cms.cms_questions (
  question_id      text primary key,
  bank             text not null default 'production' check (bank in ('production', 'gold')),
  subject          text not null check (subject in ('math', 'science', 'grammar')),
  file_key         text unique check (file_key ~ '^(MC|SC|GC)[0-9]{2}-[0-9]{3,4}$'),
  chapter_id       text not null references cms.cms_chapters (chapter_id),
  topic_id         text not null references cms.cms_topics (topic_id),
  class            int  not null check (class between 1 and 6),
  class_override   int  check (class_override between 1 and 6),
  placement_note   text,
  typical_set_id   text references cms.cms_typical_sets (typical_set_id),
  pattern_id       text references cms.cms_patterns (pattern_id),
  clone_batch_id   text,
  locale           text not null default 'IN',
  current_version  int,
  approved_version int,
  created_at       timestamptz not null default now(),
  retired_at       timestamptz,
  -- Gold questions keep their G6-001 style IDs; production ones are MQ/SQ/GQ######.
  -- Gold can therefore never be mistaken for, or published as, production (decision 3).
  check (case bank
           when 'gold' then question_id ~ '^G[1-6]-[0-9]{3}(-[a-z])?$'
           else question_id ~ '^(MQ|SQ|GQ)[0-9]{6}$' end),
  check (bank = 'gold' or file_key is not null),
  check (approved_version is null or approved_version <= current_version)
);

create table cms.cms_question_versions (
  version_id          bigint generated always as identity primary key,
  question_id         text not null references cms.cms_questions (question_id),
  version_no          int  not null check (version_no >= 1),
  status              text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'rejected')),
  text                text not null,
  figure_description  text,
  image_status        text check (image_status in ('needs_image', 'has_image')),
  image_path          text,
  format              text not null check (format in ('MCQ-4', 'MCQ-3', 'True/False', 'Typed-number', 'Typed-decimal', 'Typed-fraction', 'Typed-text', 'Multi-part')),
  correct             text,                -- null only for Multi-part (answers live on parts)
  accepted            text[] not null default '{}',
  duration_s          int check (duration_s in (30, 60, 90, 120)),
  -- signature
  math_difficulty     text check (math_difficulty in ('Simple', 'Medium', 'Complex')),
  is_pure_fact        boolean,
  reading             int check (reading between 1 and 5),
  has_irrelevant_info boolean,
  steps               int check (steps between 1 and 20),
  working_memory      int check (working_memory between 1 and 5),
  inhibition          int check (inhibition between 0 and 3),
  visual              int check (visual between 0 and 3),
  strategy            int check (strategy between 0 and 3),
  strategy_type       text references cms.cms_strategy_types (value),
  strategy_type_2     text references cms.cms_strategy_types (value),
  strategy_other_note text,
  insight_id          text references cms.cms_insights (insight_id),
  proposed_insight    jsonb,
  trick_ref           text,
  -- derived (design §4), computed on save / import; "recompute" refreshes them in place
  multistep_band      int,
  load                int,
  load_driver         text check (load_driver in ('reading', 'multi_step', 'memory')),
  style               text check (style in ('one-liner', 'word')),
  tier                text check (tier in ('School', 'Achiever', 'Super Achiever')),
  trap_level          int check (trap_level between 0 and 2),
  is_isolating        boolean,
  difficulty_points   int,
  -- provenance
  tagging_why         jsonb,
  tagged_by           text check (tagged_by in ('human', 'ai')),
  tagging_summary     text,
  author_notes        text,
  content_hash        text not null,       -- hash of structured fields (decides typo vs new version)
  created_from        text not null check (created_from in ('import', 'edit', 'generation', 'seed')),
  import_id           bigint,
  run_id              bigint,
  created_at          timestamptz not null default now(),
  edited_at           timestamptz,         -- set by any in-place change (typo fix, UI edit); import may only replace a draft where this is null
  unique (question_id, version_no),
  check (format = 'Multi-part' or correct is not null)
);

-- At most one draft or in_review version per question (design §3).
create unique index cms_question_versions_one_open on cms.cms_question_versions (question_id)
  where status in ('draft', 'in_review');

create table cms.cms_version_parts (
  version_id bigint not null references cms.cms_question_versions (version_id),
  part_label text   not null check (part_label ~ '^[a-z]$'),
  text       text   not null,
  format     text   not null check (format in ('MCQ-4', 'MCQ-3', 'True/False', 'Typed-number', 'Typed-decimal', 'Typed-fraction', 'Typed-text')),
  correct    text   not null,
  accepted   text[] not null default '{}',
  primary key (version_id, part_label)
);

-- part_label '' = the question itself (not a part); keeps keys simple.
create table cms.cms_version_options (
  version_id bigint  not null references cms.cms_question_versions (version_id),
  part_label text    not null default '',
  position   int     not null check (position between 1 and 4),
  text       text    not null,
  is_correct boolean not null,
  primary key (version_id, part_label, position)
);

create table cms.cms_version_wrong_answers (
  wrong_answer_id   bigint generated always as identity primary key,
  version_id        bigint not null references cms.cms_question_versions (version_id),
  part_label        text   not null default '',
  value             text   not null,
  option_position   int,
  tag               text   not null check (tag in ('misconception', 'concept_error', 'shortcut', 'partial', 'lost_step', 'used_irrelevant', 'misread', 'unit_slip', 'implausible')),
  misconception_id  text references cms.cms_misconceptions (misconception_id),
  target_concept_id text references cms.cms_concepts (concept_id),
  why               text,
  check (tag <> 'misconception' or misconception_id is not null),
  check (tag <> 'concept_error' or target_concept_id is not null)
);

create table cms.cms_version_concepts (
  version_id  bigint  not null references cms.cms_question_versions (version_id),
  part_label  text    not null default '',
  concept_id  text    not null references cms.cms_concepts (concept_id),
  involvement numeric(2, 1) not null check (involvement in (1.0, 0.5, 0.2)),
  primary key (version_id, part_label, concept_id)
);

create table cms.cms_version_solutions (
  version_id bigint not null references cms.cms_question_versions (version_id),
  slot       int    not null check (slot in (1, 2)),
  text       text   not null,
  type       text   check (type in ('Smarter way', 'Another way')),
  strategy   text   references cms.cms_strategy_types (value),
  primary key (version_id, slot),
  check (slot = 1 or type is not null)
);

create table cms.cms_version_hints (
  version_id bigint not null references cms.cms_question_versions (version_id),
  level      int    not null check (level between 1 and 3),
  text       text   not null,
  primary key (version_id, level)
);

-- Internal only: never read by Publish (Phase 8).
create table cms.cms_version_source_refs (
  version_id bigint not null references cms.cms_question_versions (version_id),
  ref_id     text   not null,              -- soft link to cms_source_items.ref_id (item may be extracted later)
  relation   text   not null check (relation in ('modelled_on', 'same_idea', 'checked_against')),
  primary key (version_id, ref_id, relation)
);

create table cms.cms_gold_meta (
  question_id    text primary key references cms.cms_questions (question_id),
  use            text not null check (use in ('prompt_example', 'test_only')),
  old_qid        text,
  final_reasoning text,
  review_verdict text,
  review_notes   text
);

create index cms_questions_topic on cms.cms_questions (topic_id);
create index cms_questions_set on cms.cms_questions (typical_set_id);
create index cms_question_versions_question on cms.cms_question_versions (question_id);
create index cms_version_wrong_answers_version on cms.cms_version_wrong_answers (version_id);

-- D. Tagging rules, versioned per workbook version (design §2D).

create table cms.cms_rule_versions (
  rule_version text primary key check (rule_version ~ '^v[0-9]+$'),
  notes        text,
  source_file  text,                       -- workbook file name it was loaded from
  source_hash  text,                       -- sha256 of that workbook
  created_at   timestamptz not null default now()
);

create table cms.cms_attribute_defs (
  rule_version     text not null references cms.cms_rule_versions (rule_version),
  attribute        text not null,
  "group"          text,
  meaning          text,
  "values"         text,
  needed_by_engine boolean,
  sort             int,
  primary key (rule_version, attribute)
);

create table cms.cms_tagging_rubric (
  rule_version          text not null references cms.cms_rule_versions (rule_version),
  attribute             text not null,
  definition            text,
  levels_anchors        text,
  rules                 text,
  edge_cases            text,
  calibration_case_ids  text[] not null default '{}',
  primary key (rule_version, attribute)
);

create table cms.cms_calibration_cases (
  case_id      text not null,
  rule_version text not null references cms.cms_rule_versions (rule_version),
  question_id  text,                       -- soft link: may name a gold or legacy question
  attribute    text,
  first_value  text,
  final_value  text,
  why_wrong    text,
  rule         text,
  primary key (rule_version, case_id)
);

-- Built in Phase 6; created now so the model is complete.
create table cms.cms_tagging_packs (
  pack_version text primary key,
  rule_version text not null references cms.cms_rule_versions (rule_version),
  content      text,
  content_hash text not null,
  built_at     timestamptz not null default now()
);

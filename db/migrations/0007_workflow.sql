-- F. Workflow (design §2F). cms_releases / cms_release_items wait for Phase 8.

create table cms.cms_imports (
  import_id    bigint generated always as identity primary key,
  kind         text not null default 'chapter' check (kind in ('chapter', 'topics', 'seed')),
  file_path    text not null,
  git_commit   text,
  file_hash    text not null,
  chapter_id   text references cms.cms_chapters (chapter_id),
  options      jsonb not null default '{}',     -- e.g. {"force_new_version": true}
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  result       text check (result in ('ok', 'partial', 'failed')),
  counts       jsonb not null default '{}',
  error_report jsonb not null default '[]'
);

-- Audit trail. Append-only: authenticated gets no UPDATE on it (0008).
create table cms.cms_reviews (
  review_id  bigint generated always as identity primary key,
  target     text not null check (target in ('question_version', 'catalogue')),
  target_table text not null,
  target_id  text not null,
  action     text not null check (action in ('submit', 'approve', 'reject', 'typo_fix', 'retire', 'restore', 'edit_catalogue', 'import_replace_draft')),
  reason     text,
  field_diff jsonb,
  by_user    uuid,                         -- auth user, null when a script acted
  by_label   text not null,                -- 'Sambit', 'importer', 'seed'
  import_id  bigint references cms.cms_imports (import_id),
  at         timestamptz not null default now()
);

create table cms.cms_generation_runs (
  run_id       bigint generated always as identity primary key,
  kind         text not null check (kind in ('generate_similar', 'fill_set', 'chapter', 'tag')),
  model        text not null,
  pack_version text references cms.cms_tagging_packs (pack_version),
  params       jsonb not null default '{}',
  tokens_in    int,
  tokens_out   int,
  cost         numeric(10, 4),
  status       text not null default 'running' check (status in ('running', 'ok', 'failed')),
  created_at   timestamptz not null default now()
);

create table cms.cms_jobs (
  job_id      bigint generated always as identity primary key,
  type        text not null,
  status      text not null default 'queued' check (status in ('queued', 'running', 'ok', 'failed', 'cancelled')),
  progress    numeric(5, 2) not null default 0 check (progress between 0 and 100),
  payload     jsonb not null default '{}',
  result      jsonb,
  error       text,
  started_at  timestamptz,
  finished_at timestamptz
);

-- Version provenance links (columns created in 0004, before these tables existed).
alter table cms.cms_question_versions
  add constraint cms_question_versions_import_fk foreign key (import_id) references cms.cms_imports (import_id),
  add constraint cms_question_versions_run_fk    foreign key (run_id)    references cms.cms_generation_runs (run_id);

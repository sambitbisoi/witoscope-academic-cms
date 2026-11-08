-- E. Sources: internal only, never published (design §2E). Filled from Phase 4.

create table cms.cms_sources (
  source_id    text primary key,
  kind         text not null check (kind in ('pdf', 'scanned_pdf', 'web', 'screenshots')),
  title        text not null,
  publisher    text not null check (publisher in ('NCERT', 'DAV', 'IXL', 'SOF', 'other')),
  class        int  check (class between 1 and 6),
  storage_path text,                       -- in private bucket cms-sources
  url          text,
  page_offset  int not null default 0,     -- printed page = pdf page − offset
  captured_at  timestamptz,
  check (storage_path is not null or url is not null)
);

create table cms.cms_source_chapters (
  source_id  text not null references cms.cms_sources (source_id),
  chapter_id text not null references cms.cms_chapters (chapter_id),
  page_from  int,
  page_to    int,
  primary key (source_id, chapter_id),
  check (page_to is null or page_from is null or page_to >= page_from)
);

create table cms.cms_source_jumps (
  jump_id    bigint generated always as identity primary key,
  source_id  text not null references cms.cms_sources (source_id),
  chapter_id text not null references cms.cms_chapters (chapter_id),
  label      text not null,
  pdf_page   int  not null
);

create table cms.cms_source_assets (
  asset_id     bigint generated always as identity primary key,
  source_id    text not null references cms.cms_sources (source_id),
  storage_path text not null,
  caption      text,
  captured_at  timestamptz
);

create table cms.cms_source_items (
  ref_id     text primary key,             -- N7-031, D5-012 …
  source_id  text not null references cms.cms_sources (source_id),
  page       int,
  item_text  text not null,
  topic_id   text references cms.cms_topics (topic_id),
  pattern_id text references cms.cms_patterns (pattern_id),
  numbers    jsonb                         -- for the originality check
);

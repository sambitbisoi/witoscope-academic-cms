-- A. Curriculum, loaded from the master topic lists (design §2A, plan §4).

create table cms.cms_strands (
  strand_id  text primary key,             -- <subject>-<Strand Code>, e.g. math-LR
  subject    text not null check (subject in ('math', 'science', 'grammar')),
  code       text not null,                -- Strand Code from Master Chapters
  name       text not null,
  sort       int  not null,
  unique (subject, code),
  check (strand_id = subject || '-' || code)
);

create table cms.cms_chapters (
  chapter_id   text primary key check (chapter_id ~ '^(MC|SC|GC)[0-9]{2}$'),
  subject      text not null check (subject in ('math', 'science', 'grammar')),
  strand_id    text not null references cms.cms_strands (strand_id),
  name         text not null,
  display_code text,                       -- e.g. NUM-01
  scope        text,
  sort         int  not null,
  status       text not null default 'active' check (status in ('active', 'retired')),
  check (left(chapter_id, 1) = case subject when 'math' then 'M' when 'science' then 'S' else 'G' end)
);

create table cms.cms_topics (
  topic_id         text primary key check (topic_id ~ '^(MT|ST|GT)[0-9]{4}$' or topic_id ~ '^ACH-(MC|SC|GC)[0-9]{2}-[1-6]$'),
  chapter_id       text not null references cms.cms_chapters (chapter_id),
  class            int  not null check (class between 1 and 6),
  seq              int,                    -- Class View "Seq"
  name             text not null,
  level            int,
  sub_skills       text,
  topic_kind       text not null default 'normal' check (topic_kind in ('normal', 'achievers')),
  taught_in_school boolean not null default false,  -- NCERT or DAV column not "–"
  source_flags     jsonb not null default '{}',     -- {"ncert":"1, 3","dav":"1","ixl":"1–2","imo":"–"}
  notes            text,
  status           text not null default 'active' check (status in ('active', 'retired')),
  check ((topic_kind = 'achievers') = (topic_id like 'ACH-%'))
);

-- One Achievers row per chapter and class (decision 4).
create unique index cms_topics_one_achievers on cms.cms_topics (chapter_id, class) where topic_kind = 'achievers';
create index cms_topics_chapter on cms.cms_topics (chapter_id);
create index cms_chapters_strand on cms.cms_chapters (strand_id);

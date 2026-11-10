-- Book material stays on Sambit's Mac (Sambit, 10 Nov 2026). Only our own content may
-- be in the cloud; third-party book material (NCERT/DAV/IXL/SOF PDFs, scans, screenshots,
-- item text, their numbers) is never stored in Supabase or R2. The cloud keeps bare
-- citations only: book, class, chapter, page, section, item number.
--   1. log every removal in the audit trail (no book text in the log)
--   2. book items: drop item_text and numbers; the rows stay as citations (+ section, item label)
--   3. sources: drop the R2 file key and the screenshot sets; links only to official URLs
--   4. originality checks: results of the local pre-import check (no book text)

alter table cms.cms_reviews drop constraint cms_reviews_action_check;
alter table cms.cms_reviews add constraint cms_reviews_action_check check (action in (
  'submit', 'approve', 'reject', 'typo_fix', 'retire', 'restore', 'edit_catalogue', 'import_replace_draft',
  'edit_draft', 'new_version', 'withdraw', 'create', 'remove_book_material'));

-- 1. The log, written before anything is removed.
insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label)
select 'catalogue', 'cms_source_items', i.ref_id, 'remove_book_material',
       'Sambit approved 10 Nov 2026: book item text and numbers are never stored in the cloud; kept as a citation',
       jsonb_build_object('removed', jsonb_build_array('item_text', 'numbers'), 'kept', jsonb_build_array('ref_id', 'source_id', 'page', 'topic_id', 'pattern_id')),
       'migration 0015'
  from cms.cms_source_items i;

insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label)
select 'catalogue', 'cms_sources', s.source_id, 'remove_book_material',
       'Sambit approved 10 Nov 2026: book files are never stored in the cloud; the file key is removed',
       jsonb_build_object('storage_path', jsonb_build_object('before', s.storage_path, 'after', null)),
       'migration 0015'
  from cms.cms_sources s where s.storage_path is not null;

insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label)
select 'catalogue', 'cms_source_assets', a.source_id, 'remove_book_material',
       'Sambit approved 10 Nov 2026: screenshots of book or web material are never stored in the cloud; the screenshot row is removed',
       jsonb_build_object('asset_id', a.asset_id, 'storage_path', a.storage_path),
       'migration 0015'
  from cms.cms_source_assets a;

-- 2. Book items become citations.
alter table cms.cms_source_items drop column item_text;
alter table cms.cms_source_items drop column numbers;
alter table cms.cms_source_items add column section text;     -- e.g. "1.2"
alter table cms.cms_source_items add column item_label text;  -- e.g. "Figure it out, Q3"
comment on table cms.cms_source_items is 'Citations of book items (book via source_id, page, section, item label). Never the item text or its numbers, which are kept only locally.';

-- 3. Sources: no stored files, no screenshot sets.
drop view cms.cms_chapter_sources;
alter table cms.cms_sources drop constraint cms_sources_check;
alter table cms.cms_sources drop column storage_path;
alter table cms.cms_sources add constraint cms_sources_ncert_official_url
  check (publisher <> 'NCERT' or url is null or url ~ '^https://ncert\.nic\.in/');
-- url: the official public link only (NCERT: ncert.nic.in); the book file itself is kept only locally.
drop table cms.cms_source_assets;

create view cms.cms_chapter_sources with (security_invoker = true) as
select
  sc.chapter_id, sc.page_from, sc.page_to,
  s.source_id, s.kind, s.title, s.publisher, s.class, s.url, s.page_offset, s.captured_at,
  (select count(*) from cms.cms_source_items i where i.source_id = s.source_id)::int                    as n_items,
  (select count(*) from cms.cms_source_items i join cms.cms_topics t on t.topic_id = i.topic_id
    where i.source_id = s.source_id and t.chapter_id = sc.chapter_id)::int                              as n_items_in_chapter
from cms.cms_source_chapters sc
join cms.cms_sources s on s.source_id = sc.source_id;
grant select on cms.cms_chapter_sources to authenticated;

-- 4. Results of the local originality check (scripts/check-originality.ts), one row per
--    check of a version. Citations and scores only. Written by local scripts (cms_owner).
alter table cms.cms_imports drop constraint cms_imports_kind_check;
alter table cms.cms_imports add constraint cms_imports_kind_check check (kind in ('chapter', 'topics', 'seed', 'sources', 'book', 'originality'));

create table cms.cms_originality_checks (
  check_id     bigint generated always as identity primary key,
  version_id   bigint not null references cms.cms_question_versions (version_id),
  checked_at   timestamptz not null,
  result       text not null check (result in ('clear', 'flagged', 'no_sources')),
  similarity   numeric(4, 2),          -- closest match, 0–1
  same_numbers boolean not null default false,
  closest_ref  text,                   -- a citation: a book item ref_id, or "<source_id> p<pdf page>"
  checked      jsonb not null default '[]',  -- [{source_id, pages}] that were read on the Mac
  missing      jsonb not null default '[]',  -- source_ids with no file on the Mac
  threshold    numeric(4, 2) not null,
  tool         text not null,
  import_id    bigint references cms.cms_imports (import_id)
);
create index cms_originality_checks_version on cms.cms_originality_checks (version_id);
alter table cms.cms_originality_checks enable row level security;
grant select on cms.cms_originality_checks to authenticated;
create policy cms_admin_only on cms.cms_originality_checks for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

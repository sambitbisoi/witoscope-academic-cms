-- Phase 4 (docs/phase4-plan.md): the first browser writes (D2) and the Sources tab view.

-- D2: the admin can add and edit sources from the browser. Still admin-only through
-- RLS (the "for all" policies' WITH CHECK). No DELETE: catalogue rows are never deleted.
grant insert, update on cms.cms_sources to authenticated;
grant insert, update on cms.cms_source_chapters to authenticated;
grant insert, update on cms.cms_source_jumps to authenticated;
grant insert, update on cms.cms_source_assets to authenticated;
grant usage on sequence cms.cms_source_jumps_jump_id_seq to authenticated;
grant usage on sequence cms.cms_source_assets_asset_id_seq to authenticated;

-- Every browser save is logged in the audit trail.
grant insert on cms.cms_reviews to authenticated;
grant usage on sequence cms.cms_reviews_review_id_seq to authenticated;

-- New import kinds: the NCERT source registry and book-chapter files.
alter table cms.cms_imports drop constraint cms_imports_kind_check;
alter table cms.cms_imports add constraint cms_imports_kind_check check (kind in ('chapter', 'topics', 'seed', 'sources', 'book'));

-- One row per (chapter, source) for the Sources tab, with item counts.
create view cms.cms_chapter_sources with (security_invoker = true) as
select
  sc.chapter_id, sc.page_from, sc.page_to,
  s.source_id, s.kind, s.title, s.publisher, s.class, s.storage_path, s.url, s.page_offset, s.captured_at,
  (select count(*) from cms.cms_source_items i where i.source_id = s.source_id)::int                    as n_items,
  (select count(*) from cms.cms_source_items i join cms.cms_topics t on t.topic_id = i.topic_id
    where i.source_id = s.source_id and t.chapter_id = sc.chapter_id)::int                              as n_items_in_chapter,
  (select count(*) from cms.cms_source_assets a where a.source_id = s.source_id)::int                   as n_assets
from cms.cms_source_chapters sc
join cms.cms_sources s on s.source_id = sc.source_id;

grant select on cms.cms_chapter_sources to authenticated;

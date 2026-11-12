-- D7 + S2 (queue 12 Nov 2026): sources kept up to date, and one overview of them.
-- cms_chapter_sources gains the source's status (retired sources are hidden by default).
-- cms_source_overview: every source with its chapters, citations, the questions whose current
-- version cites it, and when it last changed (its own row or its audit trail). Citations only.

create or replace view cms.cms_chapter_sources with (security_invoker = true) as
select
  sc.chapter_id, sc.page_from, sc.page_to,
  s.source_id, s.kind, s.title, s.publisher, s.class, s.url, s.page_offset, s.captured_at,
  (select count(*) from cms.cms_source_items i where i.source_id = s.source_id)::int                    as n_items,
  (select count(*) from cms.cms_source_items i join cms.cms_topics t on t.topic_id = i.topic_id
    where i.source_id = s.source_id and t.chapter_id = sc.chapter_id)::int                              as n_items_in_chapter,
  s.status
from cms.cms_source_chapters sc
join cms.cms_sources s on s.source_id = sc.source_id;

create view cms.cms_source_overview with (security_invoker = true) as
select
  s.source_id, s.kind, s.title, s.publisher, s.class, s.url, s.status, s.captured_at,
  coalesce((select array_agg(sc.chapter_id order by sc.chapter_id) from cms.cms_source_chapters sc where sc.source_id = s.source_id), '{}') as chapters,
  (select count(*) from cms.cms_source_items i where i.source_id = s.source_id)::int as n_citations,
  (select count(distinct v.question_id) from cms.cms_source_items i
     join cms.cms_version_source_refs r on r.ref_id = i.ref_id
     join cms.cms_question_versions v on v.version_id = r.version_id
     join cms.cms_questions q on q.question_id = v.question_id and q.current_version = v.version_no
    where i.source_id = s.source_id)::int as n_questions,
  greatest(s.updated_at, (select max(rv.at) from cms.cms_reviews rv where rv.target_table = 'cms_sources' and rv.target_id = s.source_id)) as last_updated
from cms.cms_sources s;

grant select on cms.cms_source_overview to authenticated;

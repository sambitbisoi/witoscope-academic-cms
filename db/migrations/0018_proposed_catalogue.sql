-- Proposed catalogue items (Sambit, 12 Nov 2026; small design change approved with the
-- NCERT Class 5/6 local import). The book-to-question pipeline proposes new concepts,
-- misconceptions, typical sets and patterns per book chapter (*.proposals.json). They are
-- imported with status 'proposed': usable as tags by draft questions, shown as Proposed in
-- the UI, and never counted as approved ('active'). Sambit promotes them later.
--
-- cms_catalogue_proposals keeps who proposed an item and which question keys use it. The
-- same ID proposed by several book chapters stays ONE catalogue row with one link row per
-- proposing chapter. Rows are never deleted.

alter table cms.cms_concepts drop constraint cms_concepts_status_check;
alter table cms.cms_concepts add constraint cms_concepts_status_check check (status in ('proposed', 'draft', 'active', 'retired'));

alter table cms.cms_misconceptions drop constraint cms_misconceptions_status_check;
alter table cms.cms_misconceptions add constraint cms_misconceptions_status_check check (status in ('proposed', 'draft', 'active', 'retired'));

alter table cms.cms_typical_sets drop constraint cms_typical_sets_status_check;
alter table cms.cms_typical_sets add constraint cms_typical_sets_status_check check (status in ('proposed', 'draft', 'active', 'retired'));

alter table cms.cms_patterns drop constraint cms_patterns_status_check;
alter table cms.cms_patterns add constraint cms_patterns_status_check check (status in ('proposed', 'draft', 'active', 'retired'));

create table cms.cms_catalogue_proposals (
  item_kind    text not null check (item_kind in ('concept', 'misconception', 'typical_set', 'pattern')),
  item_id      text not null,
  proposed_by  text not null,                       -- the pipeline's book chapter, e.g. NCERT-C6-01
  used_by      text[] not null default '{}',        -- chapter-file question keys, e.g. MC27-0005
  proposed_at  date,                                -- from the proposals file's "from" line
  import_id    bigint references cms.cms_imports (import_id),
  updated_at   timestamptz not null default now(),
  primary key (item_kind, item_id, proposed_by)
);
create index cms_catalogue_proposals_item on cms.cms_catalogue_proposals (item_kind, item_id);

alter table cms.cms_catalogue_proposals enable row level security;
grant select on cms.cms_catalogue_proposals to authenticated;
create policy cms_admin_only on cms.cms_catalogue_proposals for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_imports drop constraint cms_imports_kind_check;
alter table cms.cms_imports add constraint cms_imports_kind_check check (kind in ('chapter', 'topics', 'seed', 'sources', 'book', 'originality', 'proposals', 'figures'));

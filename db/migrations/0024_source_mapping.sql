-- Source-mapping rows (Sambit, 12 Nov 2026): the topic workbooks' NCERT (CBSE), DAV, IXL and
-- ISO / IMO Olympiad tabs, as book · class · chapter · topic → master topic ID(s), so the CMS
-- keeps them after the D5 cut-over and Export to Excel can write them back (the Science pipeline
-- reads the NCERT tab). Citations only: the evidence columns (chapter text, OCR), notes and
-- local scan paths are never stored (import:sources drops them; db:verify checks it).
-- cells = the row's kept columns in workbook order, as [[header, value], …].
create table cms.cms_source_map (
  subject    text not null check (subject in ('math', 'science', 'grammar')),
  sheet      text not null,
  row_no     int  not null,
  cells      jsonb not null,
  topic_ids  text[] not null default '{}',
  status     text not null default 'active' check (status in ('active', 'retired')),
  import_id  bigint references cms.cms_imports (import_id),
  updated_at timestamptz not null default now(),
  primary key (subject, sheet, row_no)
);
create index cms_source_map_topics on cms.cms_source_map using gin (topic_ids);

alter table cms.cms_source_map enable row level security;
grant select on cms.cms_source_map to authenticated;
create policy cms_admin_only on cms.cms_source_map for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

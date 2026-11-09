-- WitoScope Academic CMS — one-time Storage bootstrap. NOT a migration.
-- Decision D1 = a (Sambit, 9 Nov 2026; docs/phase4-plan.md).
--
-- Run once, as `postgres`, in the Supabase SQL editor (real project), or with
-- `npm run db:local:storage` on the local dev database.
--
-- This touches schema `storage`, outside cms, and does exactly this:
--   1. creates the PRIVATE bucket `cms-sources` (≤ 50 MB per file; PDF and images only)
--   2. adds three policies on storage.objects (read, upload, replace), each limited
--      to bucket 'cms-sources' AND to the CMS admin (the same check as every cms
--      table's RLS). No delete policy: source files are never deleted.
-- The app's own buckets and policies are not touched. App users and anon get nothing.

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cms-sources', 'cms-sources', false, 52428800,
        array['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create policy cms_sources_admin_read on storage.objects
  for select to authenticated
  using (bucket_id = 'cms-sources' and cms.cms_is_admin((select cms.cms_current_uid())));

create policy cms_sources_admin_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'cms-sources' and cms.cms_is_admin((select cms.cms_current_uid())));

create policy cms_sources_admin_replace on storage.objects
  for update to authenticated
  using (bucket_id = 'cms-sources' and cms.cms_is_admin((select cms.cms_current_uid())))
  with check (bucket_id = 'cms-sources' and cms.cms_is_admin((select cms.cms_current_uid())));

commit;

-- Verification: every column must be true. Paste the result into the checklist.
select
  exists (select 1 from storage.buckets where id = 'cms-sources')                                   as bucket_exists,
  (select not public from storage.buckets where id = 'cms-sources')                                 as bucket_private,
  (select file_size_limit = 52428800 from storage.buckets where id = 'cms-sources')                 as limit_50mb,
  (select count(*) = 3 from pg_policies where schemaname = 'storage' and tablename = 'objects'
     and policyname like 'cms_sources_%')                                                            as three_policies,
  (select bool_and(roles = '{authenticated}' and coalesce(qual, with_check) like '%cms-sources%'
                   and coalesce(qual, with_check) like '%cms_is_admin%')
     from pg_policies where schemaname = 'storage' and tablename = 'objects'
     and policyname like 'cms_sources_%')                                                            as policies_admin_only,
  not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
     and policyname like 'cms_sources_%' and cmd = 'DELETE')                                         as no_delete_policy;

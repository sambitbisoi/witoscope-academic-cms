-- RLS on every cms table; only the admin (cms_config.admin_user_id) sees rows.
-- Decisions 3 and 4, option A (docs/phase2-plan.md). Written out per table: no dynamic SQL.
--
-- Grants: authenticated gets SELECT only for now (Phases 2–4 only read in the app;
-- importers write as cms_owner). Write grants are added per table in Phase 5.
-- anon gets nothing: it has no USAGE on schema cms (bootstrap).

-- The signed-in user's ID, read from the request's JWT claims exactly as
-- Supabase's auth.uid() does (legacy request.jwt.claim.sub first, then
-- request.jwt.claims ->> 'sub'), without referencing schema auth, which
-- cms_owner cannot use. Missing, empty or malformed claims return null, and
-- cms_is_admin(null) is false: deny. Tests prove it equals auth.uid() for a
-- real signed-in session (tests/rls.db.test.ts, scripts/verify-uid.ts).
create function cms.cms_current_uid()
  returns uuid
  language plpgsql
  stable
  security invoker
  set search_path = ''
as $$
declare
  sub text;
begin
  sub := coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  );
  return sub::uuid;
exception
  -- malformed JSON (22P02 / 22032) or a sub that is not a uuid: deny
  when invalid_text_representation or invalid_json_text then
    return null;
end;
$$;

revoke execute on function cms.cms_current_uid() from public;
grant execute on function cms.cms_current_uid() to authenticated;

-- Migration history: owner only, no grants, RLS on with no policy.
alter table cms.cms_schema_migrations enable row level security;

alter table cms.cms_config enable row level security;
grant select on cms.cms_config to authenticated;
create policy cms_admin_only on cms.cms_config for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_strands enable row level security;
grant select on cms.cms_strands to authenticated;
create policy cms_admin_only on cms.cms_strands for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_chapters enable row level security;
grant select on cms.cms_chapters to authenticated;
create policy cms_admin_only on cms.cms_chapters for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_topics enable row level security;
grant select on cms.cms_topics to authenticated;
create policy cms_admin_only on cms.cms_topics for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_concepts enable row level security;
grant select on cms.cms_concepts to authenticated;
create policy cms_admin_only on cms.cms_concepts for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_concept_links enable row level security;
grant select on cms.cms_concept_links to authenticated;
create policy cms_admin_only on cms.cms_concept_links for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_concept_prereq_topics enable row level security;
grant select on cms.cms_concept_prereq_topics to authenticated;
create policy cms_admin_only on cms.cms_concept_prereq_topics for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_misconceptions enable row level security;
grant select on cms.cms_misconceptions to authenticated;
create policy cms_admin_only on cms.cms_misconceptions for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_typical_sets enable row level security;
grant select on cms.cms_typical_sets to authenticated;
create policy cms_admin_only on cms.cms_typical_sets for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_typical_set_concepts enable row level security;
grant select on cms.cms_typical_set_concepts to authenticated;
create policy cms_admin_only on cms.cms_typical_set_concepts for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_strategy_types enable row level security;
grant select on cms.cms_strategy_types to authenticated;
create policy cms_admin_only on cms.cms_strategy_types for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_insights enable row level security;
grant select on cms.cms_insights to authenticated;
create policy cms_admin_only on cms.cms_insights for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_patterns enable row level security;
grant select on cms.cms_patterns to authenticated;
create policy cms_admin_only on cms.cms_patterns for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_questions enable row level security;
grant select on cms.cms_questions to authenticated;
create policy cms_admin_only on cms.cms_questions for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_question_versions enable row level security;
grant select on cms.cms_question_versions to authenticated;
create policy cms_admin_only on cms.cms_question_versions for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_version_parts enable row level security;
grant select on cms.cms_version_parts to authenticated;
create policy cms_admin_only on cms.cms_version_parts for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_version_options enable row level security;
grant select on cms.cms_version_options to authenticated;
create policy cms_admin_only on cms.cms_version_options for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_version_wrong_answers enable row level security;
grant select on cms.cms_version_wrong_answers to authenticated;
create policy cms_admin_only on cms.cms_version_wrong_answers for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_version_concepts enable row level security;
grant select on cms.cms_version_concepts to authenticated;
create policy cms_admin_only on cms.cms_version_concepts for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_version_solutions enable row level security;
grant select on cms.cms_version_solutions to authenticated;
create policy cms_admin_only on cms.cms_version_solutions for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_version_hints enable row level security;
grant select on cms.cms_version_hints to authenticated;
create policy cms_admin_only on cms.cms_version_hints for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_version_source_refs enable row level security;
grant select on cms.cms_version_source_refs to authenticated;
create policy cms_admin_only on cms.cms_version_source_refs for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_gold_meta enable row level security;
grant select on cms.cms_gold_meta to authenticated;
create policy cms_admin_only on cms.cms_gold_meta for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_rule_versions enable row level security;
grant select on cms.cms_rule_versions to authenticated;
create policy cms_admin_only on cms.cms_rule_versions for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_attribute_defs enable row level security;
grant select on cms.cms_attribute_defs to authenticated;
create policy cms_admin_only on cms.cms_attribute_defs for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_tagging_rubric enable row level security;
grant select on cms.cms_tagging_rubric to authenticated;
create policy cms_admin_only on cms.cms_tagging_rubric for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_calibration_cases enable row level security;
grant select on cms.cms_calibration_cases to authenticated;
create policy cms_admin_only on cms.cms_calibration_cases for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_tagging_packs enable row level security;
grant select on cms.cms_tagging_packs to authenticated;
create policy cms_admin_only on cms.cms_tagging_packs for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_sources enable row level security;
grant select on cms.cms_sources to authenticated;
create policy cms_admin_only on cms.cms_sources for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_source_chapters enable row level security;
grant select on cms.cms_source_chapters to authenticated;
create policy cms_admin_only on cms.cms_source_chapters for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_source_jumps enable row level security;
grant select on cms.cms_source_jumps to authenticated;
create policy cms_admin_only on cms.cms_source_jumps for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_source_assets enable row level security;
grant select on cms.cms_source_assets to authenticated;
create policy cms_admin_only on cms.cms_source_assets for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_source_items enable row level security;
grant select on cms.cms_source_items to authenticated;
create policy cms_admin_only on cms.cms_source_items for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_imports enable row level security;
grant select on cms.cms_imports to authenticated;
create policy cms_admin_only on cms.cms_imports for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_reviews enable row level security;
grant select on cms.cms_reviews to authenticated;
create policy cms_admin_only on cms.cms_reviews for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_generation_runs enable row level security;
grant select on cms.cms_generation_runs to authenticated;
create policy cms_admin_only on cms.cms_generation_runs for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

alter table cms.cms_jobs enable row level security;
grant select on cms.cms_jobs to authenticated;
create policy cms_admin_only on cms.cms_jobs for all to authenticated
  using (cms.cms_is_admin((select cms.cms_current_uid()))) with check (cms.cms_is_admin((select cms.cms_current_uid())));

-- Sequences: no access for authenticated until Phase 5.
revoke all on sequence cms.cms_mq_seq, cms.cms_sq_seq, cms.cms_gq_seq from authenticated;

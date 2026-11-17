-- Round 1, Q20 (Sambit, 17 Nov 2026): Tier uses Level. Schema cms only; adds only.
--
-- Tier stays a stored, derived field (cms_question_versions.tier). From now on it is judged against the question's
-- Level (placement class when Level is empty): shared/derive.ts for imports and saves, and scripts/lib/tier.ts for
-- stored versions (import:updates recomputes it when a Level changes; tier:recompute fixes the existing ones).
-- A recomputed tier is written in place (no new version) with one 'derived_update' review row (before → after).
--
-- The only change here: two CHECK constraints get wider (same pattern as 0026 / 0035; nothing is dropped from data).

alter table cms.cms_reviews drop constraint cms_reviews_action_check;
alter table cms.cms_reviews add constraint cms_reviews_action_check check (action in (
  'submit', 'approve', 'reject', 'typo_fix', 'retire', 'restore', 'edit_catalogue', 'import_replace_draft',
  'edit_draft', 'new_version', 'withdraw', 'create', 'remove_book_material', 'override_near_copy', 'import_update',
  'decline_override', 'review_status', 'originality_check', 'reorder', 'science_row', 'science_review', 'science_rationalise',
  'derived_update'));
alter table cms.cms_imports drop constraint cms_imports_kind_check;
alter table cms.cms_imports add constraint cms_imports_kind_check check (kind in (
  'chapter', 'topics', 'seed', 'sources', 'book', 'originality', 'proposals', 'figures', 'updates', 'upload', 'science', 'science_rationalise',
  'tier_recompute'));

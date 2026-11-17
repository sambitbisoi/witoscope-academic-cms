-- Round 2, Q24 (Sambit, 17 Nov 2026): a concept's class means "first taught in". Schema cms only; adds only.
--
-- concept:first-taught sets cms_concepts.class to min(catalogued class, lowest Level of the book-derived questions
-- that test it): production Math current versions with a source ref, question + parts, any involvement ("lower only",
-- decision §10.1 of docs/plan-2026-11-17-round2.md). The catalogued class is kept in class_legacy and is never lost.
-- Each change gets one cms_reviews row (target catalogue, action derived_update, before → after). Tiers are then
-- recomputed with the Q20 rule (tier:recompute). Concept IDs (G<n>-…) never change; class is a field, never derived
-- from an ID.
--
-- Changes: three new columns, plus one CHECK made wider (same pattern as 0036 / 0038; nothing is dropped from data).

alter table cms.cms_concepts
  add column class_legacy   int check (class_legacy between 1 and 6),
  add column class_basis    text not null default 'catalogue' check (class_basis in ('catalogue', 'first_taught')),
  add column class_basis_at timestamptz,
  add constraint cms_concepts_first_taught_legacy check (class_basis = 'catalogue' or class_legacy is not null);

-- class_legacy: the catalogued class before "first taught in" was applied (kept, never lost).
-- class_basis: catalogue = class as catalogued; first_taught = lowered to the lowest Level of the book-derived questions that test it.

alter table cms.cms_imports drop constraint cms_imports_kind_check;
alter table cms.cms_imports add constraint cms_imports_kind_check check (kind in (
  'chapter', 'topics', 'seed', 'sources', 'book', 'originality', 'proposals', 'figures', 'updates', 'upload', 'science', 'science_rationalise',
  'tier_recompute', 'held_out', 'held_out_place', 'concept_class'));

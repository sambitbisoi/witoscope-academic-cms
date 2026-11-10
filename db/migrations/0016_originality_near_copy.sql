-- Originality check (Sambit, 10 Nov 2026): a near-copy of a book blocks the import;
-- moderate similarity stays a warning. A near-copy = similarity at or above
-- originality_near_copy (default 0.85), or the question's distinctive numbers appearing in
-- one piece of the book in the same order. Moderate = at or above similarity_threshold.

alter table cms.cms_originality_checks drop constraint cms_originality_checks_result_check;
alter table cms.cms_originality_checks add constraint cms_originality_checks_result_check
  check (result in ('clear', 'flagged', 'near_copy', 'no_sources'));
alter table cms.cms_originality_checks add column near_copy_threshold numeric(4, 2);

insert into cms.cms_config (key, value, note) values
  ('originality_near_copy', '0.85', 'Book similarity at which the originality check calls a near-copy and blocks the import (moderate similarity from similarity_threshold is a warning)')
on conflict (key) do nothing;

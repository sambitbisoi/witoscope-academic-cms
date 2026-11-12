-- The originality check reads every text field since 12 Nov 2026 (text, figure description,
-- options, solutions, hints, wrong-answer notes): each check records which field decided it,
-- e.g. "figure description". Citations and scores only, as before.
alter table cms.cms_originality_checks add column field text;

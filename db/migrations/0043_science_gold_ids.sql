-- Round 2, Iteration 2, Q34 (S9, Sambit 17 Nov 2026; decision §10.12 of docs/plan-2026-11-17-round2.md): Science gold
-- questions get IDs GS<class>-NNN (Math gold keeps G<class>-NNN; the two never clash). Schema cms only; adds only.
-- The question-ID CHECK is replaced by a wider one (same pattern as 0036–0041); nothing is dropped from data.
alter table cms.cms_questions drop constraint cms_questions_check;
alter table cms.cms_questions add constraint cms_questions_check check (
  case bank
    when 'gold' then question_id ~ '^G[1-6]-[0-9]{3}(-[a-z])?$' or (subject = 'science' and question_id ~ '^GS[1-6]-[0-9]{3}$')
    else question_id ~ '^(MQ|SQ|GQ)[0-9]{6}$' end);

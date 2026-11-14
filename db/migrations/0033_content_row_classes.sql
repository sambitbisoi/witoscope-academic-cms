-- Science content rows: class information (Sambit, 14 Nov 2026). Schema cms only.
--
-- Four columns from the Science master's Content tab, filled by import:science (cms_owner; audited as
-- 'science_row', content_hash updated). Our own bare labels, no book text:
--   topic_classes_mapped  "Topic class (mapped)", e.g. "5–6" (the detail card compares it with the topic's
--                         approved classes and shows "Class mismatch"; nothing is changed from it)
--   topic_taught_in       "Topic also taught in", e.g. "DAV 4–5 · ISO 4–5 · NCERT 5–6"
--   revisit               "Revisit"
--   also_in_rows          row IDs parsed strictly from Notes "Also in C<n>: C6-11-023, …"; only IDs of rows
--                         that exist in cms_content_rows are kept (import:science reports the others)
-- RLS and grants are unchanged: the app user still only SELECTs content rows.

alter table cms.cms_content_rows
  add column topic_classes_mapped text,
  add column topic_taught_in      text,
  add column revisit              text,
  add column also_in_rows         text[] not null default '{}'
    check (array_to_string(also_in_rows, ',') ~ '^(C[1-6]-[0-9A-Z]{2,4}-[0-9]{3}(,C[1-6]-[0-9A-Z]{2,4}-[0-9]{3})*)?$');

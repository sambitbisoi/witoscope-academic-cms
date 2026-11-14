# Data log

Changes to real (non-test) data that Sambit approved, with what was done and where the audit trail is.

## 14 Nov 2026: Science content rows — class information (0033)

**Approval (Sambit, 14 Nov 2026):** "Review OK, with one change before going real" (Class mismatch = only a class the master names that the topic is not linked to), "Then go ahead: apply 0033 to real → import:science --confirm-real → db:verify on real → push, open the PR, merge, deploy."

| Step | Result |
|---|---|
| Backup | `~/WitoScope/CMS-backups/real-cms-2026-11-14-pre-0033.dump` (schema `cms`, read-only file) |
| Local | 0033 applied; `db:verify` passes; unit + DB tests pass; Class mismatch 0 |
| First dry run | 0033 + import in one rolled-back transaction (real had no 0033 yet): 2,403 rows, 0 citations rewritten, Also in 374 IDs / 0 unknown / 0 unparsed |
| Schema | `migrate.ts` applied **0033_content_row_classes.sql** on real; `db:verify` passes |
| First real run | **Failed, nothing committed**: one statement per row (≈4,800) through the pooler hit the 2-min statement timeout; a timed rolled-back retry stalled on a dropped connection (its stale server session was ended with `pg_terminate_backend`). Fix: changed rows are written in batches of 200 (commit "write changed content rows in batches") |
| Real import | `import-science.ts --confirm-real` → **import #362**: 2,403 rows updated (4 near-copies still held out), 2,403 `science_row` audits (diff: the four new columns only), 0 citations rewritten (still 2,636), 0 question changes · Also in: 314 rows, 374 IDs, 0 unknown, 0 unparsed · Class mismatch **0** |
| Checked afterwards | migrations 0001–0033; 2,403 rows with Revisit, 1,684 with Topic class (mapped), 314 with Also in (374 IDs); `db:verify` on real: all checks passed |

Report: `.local-import/science-import-real-2026-11-140438.json` (IDs, counts and citations only).

## 14 Nov 2026: Science — real import (step e)

**Approval (Sambit, 14 Nov 2026):** "Dry-run report OK. Run (e), the real import with --confirm-real." Backup before: `~/WitoScope/CMS-backups/real-cms-2026-11-14-pre-science.{dump,sql}` (taken for step b; nothing else changed on the real project since).

`npx tsx --env-file=.env.real scripts/import-science.ts --confirm-real` → **import #357** (result "partial" only because 4 rows were held out, as decided).

| Checked on the real project afterwards | Result |
|---|---|
| Content rows | **2,403**; the 4 near-copy rows (C5-01-011, C5-01-072, C5-06-009, C6-08-018) are **not** in the CMS (held out until rewritten in the master) |
| Science questions | **134**, SQ000135–SQ000268, all Needs review · Import, attributes pending, originality recorded (134 checks: 117 clear, 17 close) |
| Question ↔ row links | **189** (155 direct, 34 supporting) |
| Topic–class links | **12 proposed, 0 active** (for Sambit to approve in Proposed) |
| Sources / citations | 33 sources · 2,636 row citations · 293 question citations |
| Audit (`cms_reviews`, import #357) | 2,403 `create` (cms_content_rows) · 134 `create` (cms_question_versions) · 12 `create` (cms_topic_class_proposals) |
| `db:verify` | all checks pass |

Report: `.local-import/science-import-real-2026-11-131900.json` (IDs, counts and citations only). The live UI still runs `main` until #22 + #23 are merged and deployed (step f).

## 14 Nov 2026: Science — migration 0032 on the REAL project + import:science dry run (no data written)

**Request (Sambit, 14 Nov 2026):** "continue §9 steps (b)–(d): back up the real DB, apply 0032 + db:verify, run import:science --dry-run on real. No real import and no merge yet." (`docs/science-plan.md` §9)

| Step | Result |
|---|---|
| (b) Backup | `~/WitoScope/CMS-backups/real-cms-2026-11-14-pre-science.{dump,sql}` (schema `cms`, 48 tables; read-only files). Before: migrations 0001–0031, 2,278 questions, 0 Science questions |
| (c) Schema | `migrate.ts` applied **0032_science.sql** only (4 empty tables, question columns, 2 views, `cms_decide_topic_class`, updated `cms_version_flags` and `cms_add_questions`). `db:verify`: all checks pass. The live UI (`main`) does not use the new objects |
| (d) Dry run | `import-science.ts --dry-run`, import #356 rolled back: 33 sources · 2,403 rows (4 near-copies held out: C5-01-011, C5-01-072, C5-06-009, C6-08-018) · 2,636 + 293 citations · 134 questions · 155 direct + 34 supporting links · 12 proposed topic–class links. Checked afterwards: 0 content rows, 0 Science questions, 0 Science sources, 0 proposals, import #356 absent. Only `cms_sq_seq` advanced (to 134), so the real import's questions will start at SQ000135 |

Report: `.local-import/science-import-real-dry-run-2026-11-131840.json` (IDs, counts and citations only). Next, only with Sambit's OK: (e) the real import with `--confirm-real`, then (f) merge #22 + #23 and deploy.

## 12 Nov 2026: MC19-5011 originality re-check — LOCAL ONLY

**Request (Sambit, 12 Nov 2026):** replace the stale ui-probe check with a real every-field check (logged); don't delete history.

MC19-5011 (MQ000104 v1, approved) carried check #21 (near-copy 0.91, tool "ui-probe", 10 Nov), left by a UI test. The every-field check (`check-originality 3`, import #2010) recorded check #6188: **clear**. Highest score 0.44 (wrong-answer note 2, closest NCERT-fegp107 p22); no field flagged; numbers rule not triggered. The latest check is the one the CMS uses, so #6188 now decides. Checks #13 and #21 stay in the history. Audit: `cms_reviews` #11554 (`import_update`, before → after). The question was not changed.

## 12 Nov 2026: batch 2 of the Math rewrites + override requests — LOCAL ONLY

**Request (Sambit, 12 Nov 2026):** import batch 2 (field-only rewrites after the every-field originality check) and file `override_requests.csv` as pending overrides for him to approve one by one. Backup before: `pg_dump` of schema `cms` (session scratchpad). The real project was not touched.

| What | Count | Audit trail |
|---|---|---|
| Rewrites (`near_copy_rewrites/`, 69 files, 607 questions) | **541 drafts replaced** (unreviewed drafts are replaced in place, logged), 66 unchanged; every-field check: 534 clear, 73 close (the known question-text warnings), 0 near-copy; 214 figure PNGs written to the local file store (192 are unchanged copies) | one `chapter` import per file, `cms_originality_checks` (tool `check-originality 3`) |
| Question settings | 521 updated: 3 confidence changes, 518 note text only; no setting changed | `cms_imports` #2009, `import_update` rows |
| Levels, topic classes, settings catalogue, key fix | unchanged | `cms_imports` kind `updates`, #1935–2009 for the whole run |
| `override_requests.csv` | 7 rows → every-field check recorded for each current version (all 7 near-copy in `options`, by the numbers rule) and **7 PENDING override requests** (`cms_override_requests`, migration 0026). Nothing approved | #2007 |

## 12 Nov 2026: curriculum cut-over (D5) — LOCAL ONLY

**Approval (Sambit, 12 Nov 2026):** "OK for the cut-over. Run the six steps in order." The real project was not touched. Backup before: `pg_dump` of schema `cms` (session scratchpad).

| # | Step | Result | Audit trail |
|---|---|---|---|
| 1 | `import:topics` (final workbook import) | +2 topics (MT0516 Painted cube puzzles; ACH-MC32-5), 30 Class 5 Seq shifts; nothing else | `cms_imports` #1552 |
| 2 | `import:sources` | unchanged (180 NCERT sources, 647 links, 4,771 source-mapping rows) | #1553 |
| 3 | NCERT-C5-07: proposals, then `MC32-C5.json` | pattern MP0872 added (proposed); MC32-0002…0005 → MQ004764–MQ004767, originality clear | #1556, #1558 |
| 4 | `import:updates` (levels, settings, topic classes) | MC32-0002…0005: level 5 (as in `question_levels.csv`), setting SET035 (high); MT0516 class 5 row | #1560–1562 |
| 5 | `curriculum:cutover --confirm` | `curriculum_owner` = `cms`; `import:topics` / `import:sources` refuse from now on | `cms_reviews` #8126 (workbook sha256s recorded) |
| 6 | `export:topics --publish` | Exports in `ContentResearch/CMS-exports/2026-11-12/`; originals archived to `ContentResearch/{Math,Science,English}/_archive/*.final-before-cutover-2026-11-12.xlsx` (byte-identical to the hashes in #8126; read-only); the exports published at the usual `ContentResearch/{Math,Science,English}/WitoScope_*_Topics_Class1-6.xlsx` paths (read-only) | — |

## 12 Nov 2026: Math data thread's CMS-updates imported — LOCAL ONLY

**Request (Sambit, 12 Nov 2026):** run `import:updates` into the local DB and report the counts. **The real project was not touched.** Source: `~/WitoScope/ContentResearch/CMS-updates/` (see its README). Backup before: a `pg_dump` of schema `cms` in the session scratchpad.

| What | Count | Audit trail |
|---|---|---|
| Settings catalogue (`cms_settings`) | 41 new, all proposed | `cms_imports` #1472 (kind `updates`) |
| Topic ↔ classes (`cms_topic_classes`) | 2,671 rows for 1,051 topics (730 in more than one class); the 1 row for MT0516 is waiting for the topic import | #1473 |
| Key fix MC19-0001 → **MC19-0039** | imported as MQ004668 (originality clear) | #1474–1475 |
| Near-copy rewrites (32 files) | 86 questions: **77 new** (the blocked near-copies) + **9 drafts replaced** (the follow-up rewrites; unreviewed drafts are replaced in place and logged); all 86 originality **clear**; 20 new figure PNGs in the local file store | one `chapter` import per file |
| Question levels | 2,196 set (level 5: 1,271 · level 6: 929 in the file); 4 waiting (MC32-0002…0005) | #1508, one `import_update` audit row per question |
| Question settings | 2,196 set (high 1,632 · medium 498 · low 70 in the file); 4 waiting (MC32) | #1509 |
| Source-mapping tabs (`cms_source_map`, migration 0024, by `import:sources`) | 4,771 rows (Math 2,403 · Science 1,327 · English 1,041); evidence columns, notes and scan paths left out (`db:verify` checks) | `cms_imports` kind `sources` |

Waiting for the next `import:topics` (Sambit's OK; `docs/curriculum-cutover.md` step 2): MT0516 (+ ACH-MC32-5), its class row, and MC32-0002…0005 with their level and setting.

## 12 Nov 2026: NCERT Class 5 and Class 6 Math imported — LOCAL ONLY

**Request (Sambit, 12 Nov 2026):** import NCERT Class 5 (Maths Mela ch 1–15) and Class 6 (Ganita Prakash ch 1–10) Math into the **local** CMS for review; the real project only after his OK. **The real project was not touched.**

| Where | What | Audit trail |
|---|---|---|
| Local only | Migration 0018: catalogue status `proposed`, table `cms_catalogue_proposals` | `cms_schema_migrations` |
| Local only | 232 concepts, 132 misconceptions, 302 typical sets, 769 patterns as **proposed** (1 pattern, MP0872, not imported: no Achievers row ACH-MC32-5 in the topic workbook) | `cms_imports` kind `proposals` |
| Local only | 2,685 book item citations (citations only; `db:verify` passes) | `cms_imports` kind `book` |
| Local only | 2,118 questions as **draft** (of 2,200): 77 near-copies blocked, 4 blocked by the missing ACH-MC32-5, 1 skipped (MC19-0001: key already used by the worked example) | `cms_imports` kind `chapter`, `cms_originality_checks` |
| Local only | 814 figure PNGs in `.r2-local/cms-sources/figures/` | `cms_imports` kind `figures` |

## 10 Nov 2026: Question Attributes v11 loaded (rules, gold set)

**Approval (Sambit, 10 Nov 2026):** "v11: go ahead. Lift the v10 lock, load v11 rules alongside v10, apply the 16 gold value changes as new gold versions and the 13 use changes in cms_gold_meta, add G1-013 with its concept and typical set, make the generator follow the loaded rule version, and exclude the 13 test-to-prompt questions from model-check scores. Local first, then the real project."

**Source:** `QuestionBank/WitoScope_Question_Attributes_v11.xlsx` (sha256 `c06796b9d14a…`). This is a byte-identical copy of `_pipeline/rules/WitoScope_Question_Attributes_v11.xlsx`; the pipeline copy was not touched.

| Where | What changed | Audit trail |
|---|---|---|
| **Real project** (seed import #12) and **local** (#494) | v11 rules added **alongside v10**: 32 attribute defs, 13 rubric rows, 51 calibration cases (v10's 32 / 13 / 37 stay). `cms_config.current_rule_version` = `v11` | `cms_imports`; config change logged as `edit_catalogue` |
| Same | **12 gold questions got an approved v2.** This is the "16 gold value changes": 14 value changes in 13 workbook rows (G5-007's parts a and b are one question). G6-013 WM 4→3 · G5-007, G5-012, G2-003, G2-005, G1-010 Inhibition 1→0 · G4-008 Inhibition 2→1 · G2-010, G1-006 Inhibition 2→0 · G3-008 Complex→Medium · G1-002 Medium→Simple · G1-012 Complex→Medium and Inhibition 2→0. v1 is kept | `new_version` rows in `cms_reviews` with the field diff |
| Same | `cms_gold_meta` updated for 16 questions: the 13 Test only → Prompt example (G6-013, G5-012, G5-014, G4-005, G4-008, G3-001, G3-002, G3-008, G2-003, G2-010, G1-002, G1-006, G1-012), plus the new final reasoning, verdict and notes. Gold is now 49 prompt examples / 29 test-only questions | `edit_catalogue` rows |
| Same | New: gold G1-013 (prompt example, with 2 wrong answers), concept G1-SUB-C3, typical set TS-G1-MISSING-SUB (draft) | `cms_imports` counts |

**Not changed:** the v10 rows. Re-running the v10 workbook now loads only its own rules; it leaves the gold set, the catalogues and the current version alone.

## 10 Nov 2026: book material removed from the cloud

**Approval (Sambit, 10 Nov 2026):** "I approve deleting the 42 NCERT-C6-01 book items (and any stored item text or numbers) from the real and local databases; keep only the citation fields. Log it."

**Rule:** only our own content leaves Sambit's Mac (CLAUDE.md, design §0 and §2E).

| Where | What was removed | What was kept | Audit trail |
|---|---|---|---|
| **Real project** | The `item_text` and `numbers` of the 42 NCERT-C6-01 items (N6-01-001 … N6-01-042), by dropping both columns | The 42 rows as citations: ref_id, source NCERT-fegp101, page, topic. The section and item label were then filled from the local book file (`import:book` #10, 42 updated); labels are item numbers only, e.g. "Figure it Out Q2" | 42 `cms_reviews` rows, action `remove_book_material`, by "migration 0015"; 42 `edit_catalogue` rows by "book importer" for the new citation fields |
| Real project | Nothing else held book material: no stored files (`storage_path` was empty on all 180 sources) and no screenshot rows | 180 NCERT sources, all linking to ncert.nic.in; jumps (section titles + PDF pages) | — |
| **Local** | The same 42 item texts and numbers; 77 R2 file keys (the local stand-in's PDFs); 2 test screenshot rows (IXL test sources) | Citations, as on the real project | 42 + 77 + 2 `remove_book_material` rows. 20 local `edit_catalogue` rows from a first label import briefly held long item labels with book wording; those phrases were redacted the same day, and the label rule was fixed before anything ran on the real project |
| **Schema (both)** | `cms_sources.storage_path`; `cms_source_assets` table | — | Migration 0015 |

**Not covered by this log:**
- The PDFs copied into the local R2 stand-in folder `.r2-local/`: Sambit deleted the folder on 10 Nov 2026.
- `ContentResearch/QuestionBank/_uploads/` (old-pipeline zips, parts and scratch folders; many contain book material): moved to `QuestionBank/_archive-old-rule-uploads/` on 10 Nov 2026, with a README saying "do not upload to any chat". Nothing was deleted. The old worker brief is kept there as `BRIEF-old-rule-2026-11-09.md`.
- The Cloudflare R2 bucket: Sambit confirmed **0 objects** on 10 Nov 2026 (checklist D0); no book file was ever uploaded.

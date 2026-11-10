# Data log

Changes to real (non-test) data that Sambit approved, with what was done and where the audit trail is.

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

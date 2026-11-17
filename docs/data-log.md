# Data log

Changes to real (non-test) data that Sambit approved, with what was done and where the audit trail is.

## 17 Nov 2026: Round 1 (plan `docs/plan-2026-11-17-round1.md`)

**Request (Sambit, 17 Nov 2026):** Round 1 items T1, T2, Q14, Q19, Q20, Q21, Q22, D18; "go" with decisions §10. Real data steps in small batches, each checked on a fresh restore first.

### Q20: Tier uses Level (migration 0036, `tier:recompute`)

| Step | Result |
|---|---|
| Backup | `~/WitoScope/CMS-backups/real-cms-2026-11-17-pre-0036.dump` (schema `cms`, read-only file); restored to the local DB `cms_rehearsal` |
| Rehearsal | 0036 + `db:verify` ✓. Dry run: 88 versions = the plan's list exactly, 88 audit rows, fingerprint of every cms table (all but `tier`) unchanged. Batched run (5 × 20) then a re-run: 0 left; `db:verify` ✓ |
| Real | 0036 applied, `db:verify` ✓. Read-only preview = the plan's 88. Run: **import #856**, 5 batches of 20 (own transaction each), **88 written** (54 → Super Achiever, 34 → School; all drafts, 0 approved, 0 gold), fingerprint unchanged, 0 left. `db:verify` ✓ (incl. the new tier check) |

Each change is a `derived_update` row in `cms_reviews` (before → after, judged at Level / placement class). Report: `.local-import/tier-recompute-real-2026-1117-061543.md` (+ `.json`).

### Q14: content rows edited in the CMS (migration 0037)

| Step | Result |
|---|---|
| Backup | `~/WitoScope/CMS-backups/real-cms-2026-11-17-pre-0037.dump`; restored to `cms_rehearsal` |
| Rehearsal | 0037 with the fingerprint guard (`scripts/migrate-guarded.ts`: every cms table, new columns left out; only `cms_config` may change, for the new key `content_rows_owner`): unchanged. `db:verify` ✓. Smoke test, rolled back: create C6-04-054 with an item, add an item to a row, retire. |
| Real | 0037 with the same guard: unchanged. `db:verify` ✓. No data step: content rows change only when Sambit saves them in the CMS |

### Q21 + D18: the Held-out area (migration 0038) and the MC58 backfill

| Step | Result |
|---|---|
| Backup | `~/WitoScope/CMS-backups/real-cms-2026-11-17-pre-0038.dump`; restored to `cms_rehearsal` |
| Rehearsal | 0038 with the fingerprint guard (only the new `cms_held_out` and the migration record): unchanged. `db:verify` ✓. `held-out:add` dry run, then run: 3 held, fingerprint of every other table unchanged, `db:verify` ✓ |
| Real | 0038 (guard unchanged), `db:verify` ✓. Backfill dry run = rehearsal. Run: **import #858**, held **#4 MC58-0051, #5 MC58-0052, #6 MC58-0053** (reason: Achievers row ACH-MC58-1 missing; Level 1; held with concept G1-LR-C7703, typical set TS-G1-UPSIDE-DOWN-DIGITS and patterns MP3853 / MP3865 / MP3866 from NCERT-C1-13.proposals.json; originality clear 0.50 / 0.38 / 0.39, run on this Mac, result only). Fingerprint unchanged, `db:verify` ✓ |
| D18 | **Not linked, not placed** (Sambit's condition): only MC58-0051 ("Who am I? … upside down") fits MT0203 "Guess the number from clues"; MC58-0052 and -0053 are "pick 3 balls for a total / the biggest total" puzzles. The three stay in Held out; the alternative is in the Round 1 report |

### Q19 + Q22: bulk override decisions, approval blockers (migration 0039)

| Step | Result |
|---|---|
| Backup | `~/WitoScope/CMS-backups/real-cms-2026-11-17-pre-0039.dump`; restored to `cms_rehearsal` |
| Rehearsal | 0039 with the fingerprint guard: unchanged. `db:verify` ✓. `cms_approval_blockers` = the plan's §6: near-copy without override 61 · attributes pending 134 · picture pending 38 (Math 13, Science 25) · Science primary not confirmed 19 |
| Real | 0039 (guard unchanged), `db:verify` ✓. No data step: overrides are decided by Sambit |

## 16–17 Nov 2026: Science misconception items, primary rows, Solution 1 (migration 0035, science:rationalise)

**Request (Sambit, 16 Nov 2026):** Q16 Q17 Q18 (`docs/plan-2026-11-16-q11-q18.md`, decisions §8): split content-row misconceptions into items, tie each Science question's misconception and wrong options to items, one primary row per question, Solution 1 drafts for short ones; dry run on a restored copy first, then real.

| Step | Result |
|---|---|
| Backup | `~/WitoScope/CMS-backups/real-cms-2026-11-16-pre-0035.dump` (schema `cms`, read-only file); restored to the local DB `cms_rehearsal` |
| Fresh §0 counts (real copy) | 3,505 rows (Classes 1–6; the plan's 2,407 came from an old local copy), 1,408 with misconceptions, 27 split candidates; 134 questions (90 with misconception text, 82 exact on a linked row); 19 with 2–3 direct rows; 0 Science wrong-answer rows; 3 Solution 1 under 60 characters |
| Rehearsal | 0035 + `db:verify` ✓; dry run: 16 rows split, 4 unclear (0.3%), 1,424 items; 81 exact + 1 ambiguous + 8 via an unlinked row (linked as supporting); 0 unmatched; 115 primary + 19 proposed; 6 wrong options tagged; 3 solutions drafted; guard (all non-Science rows) unchanged; a second run changes nothing |
| Real | 0035 applied, `db:verify` ✓, guard unchanged. Dry run identical to the rehearsal. Real run: the pooler dropped long transactions (nothing committed by the failed tries), so it ran with `--batch` (units of 5, each its own transaction, retried; orphaned sessions ended first): imports #816 (items) and #820–#855. Result identical to the dry run. `db:verify` ✓, guard unchanged |

Report: `.local-import/science-rationalise-real-2026-11-170015.md` (+ `.json`).

## 15 Nov 2026: Science master with Classes 1–3 (import #369)

**Request (Sambit, 15 Nov 2026):** import the rebuilt Science master (Classes 1–3 added; Classes 4–6 unchanged) into the real CMS from a dated snapshot, same process as import #365, with stop conditions.

| Step | Result |
|---|---|
| Snapshot | `~/WitoScope/ContentResearch/Science/_snapshots/WitoScope_Science_Master_2026-11-15_import2.xlsx` (byte-identical to the master when copied, sha256 `32625790…1da7`; 3,509 rows) |
| Originality | First run: 256 rows (all of C1–C2) "no-sources": the Legend's file name for the DAV "My Living World" Class 1–2 scans differs from their OCR text, and the scans are two-page spreads the single page offset cannot map. Fixed (`DAV_WHOLE_BOOK`: those two sources are checked against the whole book, 46 and 54 scans; no other source changes) and re-run: 58 books, rows 3,325 clear · 180 flagged · **4 near-copy** (the known C5-01-011, C5-01-072, C5-06-009, C6-08-018; no new ones) · 0 no-sources; questions 117 clear · 17 flagged · 0 near-copy |
| Backup | `~/WitoScope/CMS-backups/real-cms-2026-11-15-pre-science-c1-3.dump` (schema `cms`, read-only file) |
| Dry run | import #366 rolled back (#367–368: the column-check runs, also rolled back): same numbers as below. Column check: the 2,866 existing rows change only `sort` (+639 on every row, order kept); 0 citations rewritten; 12 NCERT Class 3 sources (ceev101–112) get the Legend title, 11 a page offset (their 255 citations all belong to the new Class 3 rows) |
| Real | `import-science.ts <snapshot> --confirm-real` → **import #369**: sources 3 new (DAV-std-3-science, DAV-my-living-world-class-1, -class-2) · 12 changed · 44 unchanged; content rows **639 new** (C1 104 · C2 152 · C3 383; C1-DWA-007 is a Class 2 row) · **2,866 updated** (`sort` only) · 0 flagged "not in master"; **4 held out**; 691 citations for the new rows; 17 topic–class links proposed (4 new: ST0021 · 1, ST0032 · 3, ST0042 · 2, ST0043 · 3; not approved); questions 134 unchanged; Also in 799 of 800 IDs kept (C3-06-029 names C4-01-002, not a row; C3-07-014's note is not fully parsed); Class mismatch **0**. `db:verify` on real: all checks passed |

Report: `.local-import/science-import-real-2026-11-151343.json` (IDs, counts and citations only).

## 15 Nov 2026: Science master with Class 4 (import #365)

**Request (Sambit, 15 Nov 2026):** import the rebuilt Science master (Class 4 added; Classes 5–6: "Topic class (mapped)" = the topic's home class, Revisit fixed) into the real CMS from a dated snapshot, with stop conditions; then rename the card line "NCERT classes" to "Mapped classes" and ship.

| Step | Result |
|---|---|
| Snapshot | `~/WitoScope/ContentResearch/Science/_snapshots/WitoScope_Science_Master_2026-11-15_import.xlsx` (byte-identical to the master when copied, sha256 `4bf2b994…1258`); everything below read only this copy |
| Originality | `check:originality -- --science <snapshot>` (book texts from `Science/`, 44 books, 83 page sets): rows 2,688 clear · 178 flagged · **4 near-copy** (the known C5-01-011, C5-01-072, C5-06-009, C6-08-018; no new ones) · questions 117 clear · 17 flagged · 0 near-copy. First run read 0 books because the book folder was taken as the snapshot's folder; fixed (`scienceRootFor`) and re-run |
| Backup | `~/WitoScope/CMS-backups/real-cms-2026-11-15-pre-science-c4.dump` (schema `cms`, read-only file) |
| Dry run | import #363 rolled back: same numbers as the real run below. Column check (importer run in a rolled-back transaction, audit diffs tallied): Class 5–6 rows change only `topic_classes_mapped`, `revisit` and `sort`; `sort` moves by exactly +463 on all 2,403 rows (Class 4 takes 1–463, order unchanged); 0 citations rewritten; 10 Class 4 NCERT sources (deev101–110, 0 citations) get the Legend title, 9 of them a page offset |
| Real | `import-science.ts <snapshot> --confirm-real` → **import #365**: sources 1 new (DAV-class-iv-science) · 10 changed · 33 unchanged; content rows **463 new** (Class 4) · **2,403 updated** · 0 flagged "not in master"; **4 held out** (near-copy); 501 citations for the new rows; 13 topic–class links proposed (1 new: ST0088 · class 4); questions 134 unchanged; Also in 558 IDs kept, 0 unknown; Class mismatch **0**. `db:verify` on real: all checks passed |

Report: `.local-import/science-import-real-2026-11-151213.json` (IDs, counts and citations only).

## 14 Nov 2026: Achievers for every class a Math chapter is present in (0034)

**Approval (Sambit, 14 Nov 2026):** "PR #27 review: OK, with one screen rule added to #27 before going real" (an Achievers row of a chapter that is in a class only through links is extra: shown only with "Include extra topics", unnumbered), "Then: tests + db:verify on local → apply 0034 to real (batched) → db:verify on real → merge #27 → deploy."

| Step | Result |
|---|---|
| Backup | `~/WitoScope/CMS-backups/real-cms-2026-11-14-pre-0034.dump` (schema `cms`, read-only file) |
| Local | 0034 applied; `db:verify` passes; 305 unit + 120 DB tests pass; 80 Achievers rows backfilled |
| Real dry run | 0034 in one rolled-back transaction (186 ms): 80 rows (C1 3 · C2 14 · C3 10 · C4 12 · C5 15 · C6 26); MC19 gets C3 and C4; a new link made ACH-MC19-2 (audited); real unchanged afterwards |
| Real | `migrate.ts` applied **0034_achievers_every_class.sql** (the backfill is one batched statement): Achievers rows 184 → **264** (none outside Math), 80 `create` audits ("Achievers rule"), MC19: C3–C6, triggers `cms_topic_achievers` and `cms_topic_class_achievers` in place. `db:verify` on real: all checks passed |

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

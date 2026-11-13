# Science plan (13 Nov 2026): content rows, Magnets questions, Science workspace

**Status (13 Nov 2026): built and imported on the LOCAL database with Sambit's OK (changes to Q2 and Q6 below). The real project is untouched; see §8 and §9.** Everything is built and tested on the **local DB**. The real project is touched only after Sambit's OK on a dry-run report.

Source: `~/WitoScope/ContentResearch/Science/WitoScope_Science_Master.xlsx` (build date 13 Nov 2026; our own words). Book rule: CLAUDE.md, "Book material rule". The cloud gets the master's text plus bare citations (book, class, chapter, printed page). Book PDFs and the `DAV_OCR` text are read only on the Mac, by the originality check.

## 0. What I found (read-only checks, 13 Nov)

| Check | Result |
|---|---|
| Content tab | 2,407 rows, all Row IDs unique (`C5-01-001`, `C6-DMA-012`, …), 7 Types, 251 topics, 48 master chapters, class 5: 964 / class 6: 1,443 |
| Questions tab | 134 questions (C6 Ch 4 Magnets, 6 topics ST0325–ST0330, all Row class 6); Level L1 46 / L2 61 / L3 27; 127 with options A–D, 7 True/False with A–B |
| Links | 155 direct + 34 supporting; every linked row exists |
| Topic and chapter IDs vs local CMS | **All 251 topics and 48 chapters exist, with the same chapter** (local DB, curriculum owner = `cms`) |
| Topic × row class | 168 of 314 pairs are the topic's home class. 134 have an extra-class link. **12 pairs have no link for the row's class** (e.g. ST0241 is home class 6, rows are class 5). See Q2 |
| Flags in Notes | TIME-SENSITIVE 26, ACCURACY 85; Safety filled on 75 rows |
| Question use | OK 2,288 · Misconception only 82 · No questions 37 |
| Books | 48 short names (Legend) over 33 PDFs: 22 NCERT (C5 *Our Wondrous World* ch 1–10, C6 *Curiosity* ch 1–12) and 11 DAV scans (OCR text in `Science/DAV_OCR`) |
| Science sources in CMS | none yet; `import:sources` refuses since the cut-over, so Science sources are registered by the new importer |
| Home / Curriculum map | already loop over all three subjects; Science shows with 0 questions today |

## 1. Data model (one migration, `0032_science.sql`, schema `cms` only, RLS admin-only on every new table)

| Table / column | Holds | Notes |
|---|---|---|
| **`cms_content_rows`** (new) | `row_id` PK (the master's Row ID, permanent), `topic_id`, `row_class`, `chapter_id` (master chapter, for the chapter view), `type`, `chapter_role`, `content`, `why_it_matters`, `misconceptions`, `diagram_description`, `picture_question` bool, `question_use`, `safety`, `source` (Book / Claude-added), `found_in`, `confidence`, `notes`, `time_sensitive` bool, `time_checked_year`, `accuracy_flag` bool, `book_ref` (file, chapter no., chapter title), `in_master` bool + `missing_since`, `content_hash`, `import_id`, `updated_at` | Read-only in the UI (select-only RLS for the app user; writes only by the importer as `cms_owner`). Flags are parsed from Notes (`TIME-SENSITIVE: checked <year>`, `ACCURACY:`). Question count and status are **computed** from links, not copied from the sheet; the importer cross-checks them against the sheet's columns and reports any difference |
| **`cms_citations`** (new) | `owner_kind` ('content_row' / 'question_version'), `owner_id`, `source_id`, `page_from`, `page_to`, `raw` (the cell text, e.g. `D5Wat p.70`) | Bare citations only: book, class, chapter (via source), printed pages. `db:verify` checks the shape: no text over 80 chars, `raw` matches a page pattern |
| **`cms_question_content_rows`** (new) | `version_id`, `row_id`, `role` ('direct' / 'supporting') | Per version, so a change of links makes a new version (CLAUDE.md versioning) |
| `cms_question_versions` + columns | `tier` **is already used** (School/Achiever/Super Achiever), so the sheet's L1/L2/L3 goes into a new **`level_tier`** ('L1','L2','L3'). Also `display_format` (the sheet's Format: Scenario MCQ, Why does, …), `misconception_targeted`, `safety_note`, `confidence` | Class Level (D1) stays `cms_questions.level` = Row class (6) |
| `cms_questions` + column | `source_qid` (unique; e.g. `C6-04-Q001`) | Makes `import:science` re-runnable; the CMS still gives `SQ000001…` IDs and `file_key` `SC48-001…` |
| `cms_imports.kind` | adds `'science'` | |
| `cms_reviews.action` | adds `'science_row_change'`, `'science_row_missing'` | Audit of every row change, before → after |
| `cms_sources` | 33 rows: `NCERT-class-6-chapter-4` style IDs (= local file stem, so the originality check finds the PDF), `DAV-magnets`, … with `page_offset` from the Legend | See Q3 on official NCERT IDs/links |
| `cms_source_chapters` | which master chapters each book covers, from the content rows | |

## 2. `import:science` (re-runnable, local first)

| Step | What it does |
|---|---|
| Read | Content, Questions and Legend tabs only. Refuses if the header row differs from what it expects (reports the difference) |
| Validate | Every topic and chapter exists in the CMS; every row's class is the topic's home class or one of its linked classes (Q2); every link target exists; every page cell parses |
| Sources | Upserts the 33 sources and their chapter links (no deletes) |
| Content rows | Upsert by Row ID. New → insert; changed → update + one audit row with the changed fields before → after; unchanged → skip. **Rows not in the file are never deleted**: `in_master = false`, `missing_since` set, audited, and shown with a "Not in master" badge |
| Citations | Content-row citations are replaced with the file's (they are bare page numbers, not content) |
| Questions | Needs the originality report (step 3). New Q ID → new question (Needs review · Import, attributes pending; image pending if Picture needed = Y). Existing Q ID with no change → skip. Changed and the draft is unedited in the CMS → replace the draft (as import:chapter does). Changed but approved or edited → new version as a draft, or skip with a report line (Q5) |
| `--dry-run` | Does everything in one transaction and rolls back; prints the counts and the change list. This is the report for the real project |

### Question field mapping

| Sheet | CMS |
|---|---|
| Q ID | `source_qid`; CMS gives `SQ…` and `file_key` |
| Topic ID, Row class | `topic_id`, `chapter_id` (from the topic), `class` = `level` = 6 |
| Level L1/L2/L3 | `level_tier` |
| Format | `display_format`; the stored `format` is `MCQ-4` (A–D) or `True/False` (the 7 with A–B) |
| Question, A–D, Answer | `text`, options with `is_correct`, `correct` |
| Explanation | solution slot 1 |
| Misconception targeted | `misconception_targeted` (text; not linked to the misconception catalogue) |
| Picture needed, Image brief (question), Image briefs (options) | `figure_description` = question brief + "Options: A: … B: …"; `image_status = 'needs_image'` when Y |
| Safety note, Confidence, Notes | `safety_note`, `confidence`, `author_notes` |
| Taught in | `cms_citations` for the version (`NCERT p.61–62; DAV Mag p.203`, also the per-row form `C6-04-001: … \| C6-04-014: …`) |
| Content row ID(s) + Direct row ID(s) | `cms_question_content_rows`: direct = the Direct list, supporting = the rest |
| Attributes | reading, steps, inhibition, irrelevant info, visual left **empty**, `attributes_pending = true`. Working memory and strategy are hidden for Science |
| Typical set, pattern, clone group | none |

## 3. Originality check (Mac only, before import)

| Item | Plan |
|---|---|
| Command | `npm run check:originality -- --science <master.xlsx>`: every field of the 134 questions (text, options, explanation, figure description, misconception) against the PDFs of the books each question cites, and the chapter's other Science books |
| DAV scans | `pdftotext` gives no text, so the check reads the matching `Science/DAV_OCR/*.txt` on the Mac (new lookup in `local-books.ts`) |
| Output | `<master>.originality.json` next to the workbook (scores and citations only; no book text) |
| Gate | `import:science` refuses questions without a current report. A near-copy is imported but blocked from approval, as for Math; flagged = warning |
| Optional (Q6) | A list-only run on the 2,407 content rows, as a report for Sambit; nothing recorded |

## 4. Screens

| Screen | Change |
|---|---|
| **Science topic workspace** | Tabs: **Content** (new, default) and **Chapter sources** (kept). By question type and By concept are hidden for Science topics |
| Header | Coverage: rows with direct questions · supporting only · not eligible · none yet; questions by tier L1/L2/L3 |
| Column (a) Content | Collapsible block per Type (Fact, Concept, How it works, Experiment, Scenario-Case, Diagram, Vocabulary). Each row: text, status (✓ has questions · ⚠ none yet · ○ not eligible), "x direct · y supporting", badges (Safety, Time-sensitive, Accuracy, Claude-added, Not in master), Row ID last (muted). "All for this topic" at the top |
| Column (b) Questions | For the selected row (or all): name/text first, tier badge, direct/supporting badge, status, SQ ID last |
| Column (c) Detail | **Linked content** box first (each row: direct/supporting, type, chapter role, Book vs Claude-added, misconceptions), then the attributes box (Pending), preview, safety note, taught in (citations), the existing buttons (edit, submit, approve…). No Generate |
| Filters | Type, row status, Question use, Safety, Time-sensitive. Optional ones behind "More" |
| **Chapter view** | Same 3 columns over all topics of a chapter, grouped by topic (topic order from `cms_topic_order`). Opened from the chapter in the Browse tree (a new "Chapter view" link on Science chapters) |
| Add question / bulk upload | As for Math, plus an optional "Content row IDs (direct / supporting)" field (form) and two optional columns (upload), checked against existing rows |
| Home, Curriculum map | Science question counts and review status already flow through. I'll add content-row counts (rows, with questions, none yet) to Science cards and map rows. Wording only, no layout change |
| Browse tree, Curriculum, Review, Proposed | Unchanged; Science questions appear in Review like any other |

I'll send screenshots of the topic and chapter views before committing the UI (local data).

## 5. Work items and size

| # | Item | Size |
|---|---|---|
| 1 | Migration 0032 + RLS + check-migrations + `db:verify` citation shape | M |
| 2 | Master reader + parsers (flags, page cells, Taught in, links) with unit tests | M |
| 3 | `import:science` (sources, rows, citations, missing-row flags, audit, dry run) | L |
| 4 | Question import (mapping above, versions, links, re-run rules) | M |
| 5 | Originality: `--science` mode + DAV OCR lookup | M |
| 6 | Science workspace (topic view, 3 columns, filters) | L |
| 7 | Chapter view + Browse link | M |
| 8 | Add / upload: content-row field | S |
| 9 | Home / map content-row counts | S |
| 10 | DB tests: idempotent re-run, no deletes, missing-row flag, audit rows, RLS on new tables, links per version | M |
| 11 | Local run, counts report, screenshots, real-project dry-run plan | S |

PRs: **PR A** data + importer + originality (items 1–5, 10); **PR B** screens (6–9), stacked on A.

## 6. Questions for Sambit (my proposal in **bold**)

| # | Question | Proposal |
|---|---|---|
| Q1 | Tier field name: the existing `tier` column holds School/Achiever/Super Achiever | **New column `level_tier` (L1–L3), shown as "Tier L2"** |
| Q2 | 12 topic × class pairs have rows in a class the topic isn't linked to (e.g. ST0241 home 6, rows class 5; ST0034 home 1, rows class 6) | **The importer adds the missing extra-class links (source "Science master", audited)**, so the rows show in Browse for that class. Otherwise they only show under the home class |
| Q3 | NCERT source IDs: Math uses the official file code (`NCERT-aejm101`) + ncert.nic.in link; the Science PDFs are renamed locally (`Class-6-Chapter-4.pdf`) | **Use the local stem (`NCERT-class-6-chapter-4`) with no link for now** [guess: I don't know the official codes, *Curiosity* may be `fecu1xx`]; links can be added later without changing IDs |
| Q4 | Imported questions: status | **Needs review · Import, attributes pending, image pending where Picture needed = Y** (same as uploaded) |
| Q5 | Re-run when a question changed in the master but was already edited or approved in the CMS | **Skip it and list it in the report** (the CMS wins once someone has touched it) |
| Q6 | Originality on the 2,407 content rows too? | **Yes, list-only report** (no gate), since content rows reach the cloud |
| Q7 | "Misconception targeted" | **Plain text on the version**, not linked to the misconception catalogue (Science has no catalogue yet) |
| Q8 | Chapter view entry point | **A "Chapter view" link next to each Science chapter in the Browse tree** |

## 7. Real project (after local is done; not before Sambit's OK)

The real project is still waiting for its own go-live (migrations 0019–0031). Science comes after it: migration 0032, then `import:science --dry-run` against the real project (`.env.real`), with a report of counts and changes. Nothing is written there until Sambit OKs that report.

### Decisions (Sambit, 13 Nov 2026)
Q1, Q3, Q4, Q5, Q7, Q8: as proposed. **Q2 changed:** the 12 topic–class links are created as **proposed** links (source "Science master", audited) and appear under Proposed → Topic classes. Approving one there makes the link. Nothing is made active by the importer. **Q6 changed:** all 2,407 content rows get the every-field originality check. On the **real** import, a row at near-copy (≥ 0.85) is held out unless `override_requests.csv` lists that row + field. **Locally** it is imported with an "Originality flagged" badge.

## 8. Local results (13 Nov 2026)

| Item | Result |
|---|---|
| Migration | `0032_science.sql` applied locally; `check-migrations` ok; `db:verify` all checks pass (2 new Science citation checks) |
| Originality (Mac, 1 min 33 s) | All 33 books read: 22 NCERT PDFs (pdftotext) and 11 DAV scans (local OCR in `Science/DAV_OCR`). **Content rows: 2,225 clear · 178 close (0.60–0.85, warning) · 4 near-copy · 0 no book.** Questions: 117 clear · 17 close · 0 near-copy |
| Near-copy rows (imported locally with the badge, held out of the real import) | C5-01-011 diagram description 0.89 (NCERT C5 Ch1 pdf p6) · C5-01-072 content 0.91 (NCERT C5 Ch1 pdf p16) · C5-06-009 why it matters 1.00 (NCERT C5 Ch6 pdf p3) · C6-08-018 diagram description 0.97 (NCERT C6 Ch8 pdf p3) |
| Close questions (warning only) | 17: misconception targeted ×9, solution (Explanation) ×5, text ×3 |
| Import | 33 sources · **2,407 content rows** · 2,640 row citations · **134 questions** (SQ000135–SQ000268, Needs review · Import, attributes pending, 25 image pending) · 293 question citations · **155 direct + 34 supporting links** · 12 proposed topic–class links |
| Cross-check | The CMS row status equals the sheet's "Question status" on all 2,407 rows (48 with direct questions, 119 not eligible, 2,240 none yet) |
| Re-run | 0 new · 0 changed · 2,407 unchanged; 134 questions unchanged; 0 new proposals |
| Note | A first re-run compared the stored score "0.40" with 0.4 and logged 221 spurious `science_row` audit rows (import #2569, local only, score-format diffs only). Fixed (numbers now compare as numbers). The rows are kept: audit history is not deleted |
| Note | Question IDs start at SQ000135: the dry run used SQ000001–134 (sequences never roll back). IDs are never reused, so the gap is harmless; the real project will show the same gap after its dry run |

### The 12 proposed topic–class links

| Topic | Name | Home class | Row class | Suggested role | Rows |
|---|---|---|---|---|---|
| ST0005 | Leaves of different shapes, sizes and textures | 3 | 6 | from a lower class | 4 |
| ST0034 | Why we wear clothes | 1 | 6 | from a lower class | 5 |
| ST0090 | Avoiding food waste | 3 | 6 | from a lower class | 2 |
| ST0106 | Plants and animals need each other | 3 | 6 | from a lower class | 1 |
| ST0142 | Reading food labels: ingredients and expiry date | 4 | 6 | from a lower class | 3 |
| ST0151 | Shadows through the day and sundials | 4 | 6 | from a lower class | 4 |
| ST0162 | Uses of flowers and fruits | 4 | 6 | from a lower class | 6 |
| ST0207 | Conditions for life on Earth | 5 | 6 | from a lower class | 1 |
| ST0217 | Seed dispersal: wind, water, animals and bursting | 5 | 6 | from a lower class | 4 |
| ST0218 | Vegetative propagation: new plants without seeds | 5 | 6 | from a lower class | 1 |
| ST0241 | Characteristics of living things: respiration, excretion and response | 6 | 5 | from a higher class | 4 |
| ST0301 | Asteroids and comets | 6 | 5 | from a higher class | 5 |

## 9. Real-project dry-run plan (waits for Sambit's OK; nothing has run there)

The real project is still waiting for its own go-live (migrations 0019–0031, imports, cut-over: `docs/queue-2026-11-12.md`). Science comes **after** go-live.

| Step | Command (on the Mac) | Writes to the real project? |
|---|---|---|
| 0 | Backup: `pg_dump` of schema `cms` to `~/WitoScope/CMS-backups/real-cms-<date>-pre-science.{dump,sql}` | No |
| 1 | `npx tsx --env-file=.env.real scripts/migrate.ts` → applies 0032 (4 tables, columns, views, 2 functions). `check-migrations` runs first | **Yes, schema only.** Needs your OK |
| 2 | `npx tsx --env-file=.env.real scripts/db-verify.ts` | No |
| 3 | `npm run check:originality -- --science` (Mac only; already done for today's master) | No |
| 4 | `npx tsx --env-file=.env.real scripts/import-science.ts --dry-run` → report to `.local-import/science-import-real-dry-run-*.json` | No (one rolled-back transaction; only the SQ sequence advances) |
| 5 | You review the dry-run report. Expected: 33 sources, **2,403 rows** (4 near-copies held out unless `Science/override_requests.csv` lists row + field), 2,636 row citations, 134 questions, 155 + 34 links, 12 proposed links | — |
| 6 | Only with your OK: `npx tsx --env-file=.env.real scripts/import-science.ts --confirm-real` (the script refuses a real run without `--confirm-real`) | **Yes** |

Expected held-out rows: C5-01-011, C5-01-072, C5-06-009, C6-08-018. None of them is linked to a question, so no question is blocked. To let one in, add a line to `~/WitoScope/ContentResearch/Science/override_requests.csv` (`file_key,field,reason`, e.g. `C5-01-072,content,"<why the wording must stay>"`) or reword the row in the content map and re-run the check.

## 10. Assumptions and guesses (flagged)

- **[guess]** NCERT source IDs use the local file names (`NCERT-class-6-chapter-4`), with no ncert.nic.in link (Q3).
- **[inferred]** Legend offsets are "printed = PDF + offset"; the CMS stores `page_offset` as "printed = pdf − offset", so the sign is flipped.
- **[inferred]** NCERT printed pages run on through a class's book, so a page finds its chapter PDF from the Legend's printed ranges. C5 Ch 10's Seasons' Journal (pp.177–184) counts as part of Ch 10.
- **[guess]** Content rows get the wording test only, on every field (content, why it matters, misconceptions, diagram description, notes, safety). The numbers rule is off for rows, because a fact's numbers are the book's facts. Questions get the Math rules (numbers rule on text, figure description and options).
- **[guess]** DAV pages are read around the cited pages ± 3; rows without a DAV citation are compared with the pages their file cites.
- **[inferred]** Rows written for class N show in class N and above (like question levels, D3); a lower-class row is marked "Class 5 row".
- **[guess]** Attributes for Science clear "pending" when reading, steps, inhibition (misconception pull), irrelevant info and visual are all set; working memory, strategy and math difficulty are not needed (migration 0032 trigger).
- **[inferred]** The sheet's Format is stored as `display_format`; the stored format is MCQ-4 or True/False. Explanation → solution 1; Notes → author notes; Q ID → `source_qid` (re-runs match on it).
- Imported questions are Needs review · Import with originality already recorded (the report is checked against the master's SHA-256), so they are not "originality pending".
- Science topics hide "+ Question type / + Pattern / + Concept" and the Simple/Medium/Complex mix; no Generate link for Science questions.

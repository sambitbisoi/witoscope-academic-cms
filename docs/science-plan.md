# Science plan (13 Nov 2026): content rows, Magnets questions, Science workspace

**Status: plan only. Nothing is built yet.** I'll write code once Sambit confirms this plan (CLAUDE.md, "How Sambit works"). Everything is built and tested on the **local DB**. The real project is touched only after Sambit's OK on a dry-run report.

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

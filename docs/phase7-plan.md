# Phase 7 plan (re-planned 10 Nov 2026): new source → extract → tag → match, local-only

**Status: plan only. Not built.** Phase 7 waits until Sambit has used the CMS for real.

**Decided (Sambit, 10 Nov 2026):** Q4: "Generate from this book item" is dropped. **Q1 is reopened:** the rule was restated later on 10 Nov (CLAUDE.md, "Book material rule"): AI threads *may* read the book PDFs on the Mac, as long as nothing book-derived is stored or uploaded outside it. The other questions keep my proposals until Sambit says otherwise.

This replaces the 9 Nov draft (branch `phase-7-extract`, never pushed). That draft uploaded PDFs to R2 and had the cloud AI function read them, which the new rule forbids.

**The rule:** CLAUDE.md, "Book material rule" (the single source). In short: book material stays on Sambit's Mac; AI threads may read it there, but it is never stored in or uploaded to Supabase, R2 or any cloud. The cloud holds only:
- our original content;
- bare citations (book, class, chapter, page, section, exercise/item number);
- official public links.

## 1. What Phase 7 delivers

Every step that touches book material runs on the Mac. Only the last column ever reaches the CMS.

| Step | On the Mac | What reaches the CMS |
|---|---|---|
| **Register** | The PDF or scan stays where it is, under `~/WitoScope/ContentResearch/…` | A `cms_sources` citation: title, publisher, class, chapter pages, page offset, official link if one exists |
| **Extract** | A local script reads the chapter with `pdftotext` (text PDFs such as NCERT) or local OCR (scans such as DAV; see Q1). It splits the chapter into sections and items and writes a **local book file** (`cms-book-chapter/0.2`) with each item's text and numbers | Nothing yet |
| **Review** | A local-only review page lists the items in page order beside the PDF page. Sambit fixes splits and labels, marks items assessable or not, and saves. The page edits only the local book file (Q2) | Nothing yet |
| **Tag** | Sambit picks each item's CMS topic, typical set and pattern from the chapter's catalogue, with local suggestions (Q3). Any v11 item tags stay in the local file | — |
| **Import** | `import:book` (already citation-only) | Per item: ref_id, page, section, item label (exercise/item number only), topic, pattern. Never the text |
| **Match** | A local script compares each item with our bank's questions for the topic. It downloads our own questions only, using the same similarity and number check as the originality check | `cms_version_source_refs` (`same_idea` / `checked_against`), and per-topic coverage: book items with and without an app question |
| **Fill gaps** | For an item with no app question: Generate starts from the topic's typical set or pattern, which is our own content, never from the item text (Q4). The new drafts then go through the local originality check | Our own drafts and their check results |

## 2. Open questions (my proposals)

| # | Question | Proposal |
|---|---|---|
| **Q1 (reopened)** | **May an AI read book pages?** *First decided "no"; the rule now allows an AI thread on the Mac to read them, with nothing stored or uploaded outside the Mac.* | **My proposal: keep local, non-AI extraction as the default** (deterministic and free), with an AI thread on the Mac allowed for pages where it does clearly better (e.g. poor OCR on DAV scans). The CMS's cloud AI function (`/api/ai`) still never receives book text. Extraction is local: `pdftotext` for NCERT (text PDFs; tested on Ganita Prakash), and **Tesseract OCR** (`brew install tesseract`) for DAV scans. The `ai_model_extract` key (a cloud-function setting) stays unused |
| Q1b | **The 20 existing book files** (`QuestionBank/NCERT-C5-*`, `NCERT-C6-*`) | They stay on the Mac and are used as they are (citations, the originality check). **[I don't know how they were made.** If book pages were sent to an AI service to make them, that already happened under the old rules; nothing in the CMS depends on it.**]** |
| **Q2** | **Where the review page runs** | Inside the local dev app only (`npm run dev`). A route plus a `127.0.0.1` file endpoint in `scripts/dev-files.ts` read and write the local book files. The route is left out of production builds, and a test fails the build if the deployed bundle contains it. Nothing goes through Supabase, R2 or a Pages Function |
| Q3 | Topic, set and pattern suggestions | Local and rule-based: keywords from the topic master lists, the item's section, and the nearest existing bank question (by similarity). Sambit confirms every one. No AI (follows Q1) |
| **Q4 ✓** | **"Generate from this book item"** *Decided: dropped.* | **Dropped.** It would send book text to the Claude API. Instead, *Fill gaps* on the item's typical set or pattern, then the local originality check flags anything too close to the book |
| Q5 | Item IDs | As in the book files: `N6-01-004` (NCERT, class 6, chapter 1, item 4); DAV `D6-…` |
| Q6 | Approving drafts that were never book-checked | A warning, not a block, on the review screen ("Book check: not run yet"). Phase 8 (Publish) can refuse anything never checked or flagged; that is decided with Phase 8 |

## 3. Work items (after Q1–Q4)

| # | Item | Size |
|---|---|---|
| 1 | `extract:book`: `pdftotext` per page → sections and items (numbering heuristics for NCERT "Figure it Out", examples and in-text questions) → local book file; Tesseract path for scans | L |
| 2 | Local-only review page (dev app route + `dev-files` endpoint on 127.0.0.1) with a build guard so it never ships | L |
| 3 | Local topic, set and pattern suggestions | M |
| 4 | `match:book`: local matching → `cms_version_source_refs` + coverage counts (citations only); coverage on the Sources tab | M |
| 5 | Building it: extraction is developed and tested on synthetic fixture pages, so the tests and the repo hold no book text. Real chapters run on the Mac; only counts and citations go into the repo, PRs or the CMS | — |
| 6 | Tests: no book text in any cloud write (fixtures with marker text, asserted absent from DB rows and requests), plus build-guard, extraction and matching tests | M |

## 4. Already in place (10 Nov 2026)

- **Citations only in the cloud:** migration 0015, with `db:verify` checking the shape.
- **`import:book` is citation-only:** it never sends item text or numbers.
- **Local originality check:** `npm run check:originality`. It reads the chapter's PDFs and local book files on the Mac, and the CMS records only results.
- **File function:** it refuses PDFs and anything outside `figures/`.

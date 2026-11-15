# Plan: CMS review improvements Q1–Q10 (15 Nov 2026)

> Approved by Sambit, 15 Nov 2026, with the decisions below. Built as PRs A–D.

## Context
On 15 Nov we found that the Fractions strand has 219 questions under All classes, but by default only 106 of them show in any single class. The other 113 sit on Class 3/4 topics with Level 5/6. For a review, Sambit needs to see those questions in place, see each question's Level and the catalogue items' classes at a glance, filter by several classes, strands or chapters at once, and decide proposed items without leaving the screen he is on. **Fixed rules:** a question's Level is never changed. The default visibility (core topics, Level ≤ class) stays as it is. A catalogue item's class is information only and never changes what is shown.

## Summary
**Screen only. No migration is needed.** Every count can come from views that already exist (`cms_question_list.counted`, `cms_topic_class_stats`). Approve and Reject reuse `cms_set_catalogue_status` and `cms_decide_topic_class`, which are already audited. **No 0035 migration** (decision 1).

## Per item

| # | On screen | Files | Data source | Tests |
|---|---|---|---|---|
| Q1 | A **"Show higher-level questions"** checkbox in the Browse bar, next to "Include extra topics". It is off by default and remembered (`usePref`). When it is on, class N also shows the topic's questions with Level > N, tagged **"Level L · above class"**. Tree, chapter and topic counts read "106 + 113 higher". The topic header's "X above Class N not shown" turns into a hint for the checkbox. Works for Math and Science (`ScienceView` gets a `higher` prop). Has no effect under All classes. | `Workspace.tsx`, `Science.tsx`, `api.ts` (new `higherCounts(subject)`), `logic.ts` | `cms_question_list` (`topic_id, effective_level, math_difficulty` where `counted`, filtered by subject prefix, read in pages), loaded only when the box is ticked | logic: `visibleLevel(level, cls, higher)`, `countSplit` |
| Q2 | Concept header ("By concept"): a **`Class N` tag** in place of the plain "Class N" text. | `Workspace.tsx`, `styles.css` | `cms_concepts.class`. Fallback: the ID prefix (`G6-…`) | logic: `catalogueClass(id, class)` |
| Q3 | Every question row (under question types, patterns and concepts) gets a **Level tag**. One tag covers all three cases: "Level 3", "Level 2 · revision" (replaces today's "Revision · L2") and "Level 5 · above class". When Level is empty, the tag reads "Level — (class used)". | `Workspace.tsx` `QRow`, `Science.tsx` `QItem` | `effective_level`, `level` (already loaded) | logic: `levelTag(q, cls)` |
| Q4 | Question panel and detail: the topic's "Classes 5 · 6" pill is replaced by **"Level N"** for the question alone. | `QuestionDetail.tsx:46` | `d.question.level` / `d.effectiveLevel` | — |
| Q5 | Browse **Classes, Strands and Chapters become multi-select**; Subject stays single. Tree, counts and chapter list follow the combined selection. The URL keeps it (`/browse/math/3,4?strand=a,b&ch=MC01,MC02`), and old single-value links still work. Rule [inferred]: a topic shows if it is core (or extra, when that box is ticked) in any selected class. Its questions follow **Level ≤ the highest selected class the topic is in**. Numbers (1. / 1.2) show only when exactly one class is selected, as with All today. | `logic.ts` (route + `ClassSel` helper), `Workspace.tsx` (replaces every `r.cls === 'all'` / `Number(r.cls)`), `api.ts` `tree()` (`.in('class', …)`), new `MultiSelect.tsx`, `Shell.tsx` / `Home.tsx` links | `cms_topic_class_stats` per class. A topic uses the row of its highest selected class, so nothing is added up twice | routes round-trip (single, multi, legacy); `ClassSel` |
| Q6 | Topic view filter row gets **"Concept class"** and **"Question Level"**, both multi-select. Each shows only the values present, with counts. A question matches Concept class if any of its concepts has one of the chosen classes. | `Workspace.tsx` `TopicView`, `MultiSelect.tsx`, `logic.ts` | `topicData()` concepts and versionConcepts (already loaded) | logic: `matchConceptClass`, `matchLevel` |
| Q7 | Question-type header: a **`Class N` tag**, the same style as Q2. | `Workspace.tsx` | `cms_typical_sets.class`. Fallback: the `TS-G3-` prefix | as Q2 |
| Q8 | Every proposed row shows **Kind · Class/Level**, e.g. "Proposed question type · Class 3" or "Topic–class link MT0261 → Class 6". This applies on the Proposed screen and on proposed headers in topic views. Clicking a row or header opens a **right-hand detail pane**: name, description, class, topic and chapter, linked concepts / patterns / misconceptions, the questions that use it (each opens), source (`proposed_by`), and **Approve** and **Reject (reason required)** buttons, plus Edit (the existing `CurriculumForm`, for concepts, question types and patterns). Reject = status `retired` (kept, reversible with "Back to proposed"). In Browse the pane takes the question-detail slot, through a new URL param `item=kind:id`. The A/R/F keys stay disabled while an item is open. | new `CatalogueDetail.tsx` + `catalogueApi.ts`, `Proposed.tsx` (two columns), `Workspace.tsx`, `logic.ts` (route), `editApi.ts` (reuse `setCatalogueStatus`) | tables: `cms_concepts`, `cms_typical_sets`, `cms_patterns`, `cms_misconceptions`, `cms_typical_set_concepts`, `cms_catalogue_proposals`, `cms_question_list`, `cms_version_concepts`, `cms_topic_class_proposals`. Writes go only through `cms_set_catalogue_status` / `cms_decide_topic_class` (already audited) | logic: `kindLabel`, `itemParam` round-trip; DB: the existing tests for both functions still pass |
| Q9 | A proposed pattern header inside a question type gets **Approve** and **Reject (reason)** buttons, shown only while the pattern is proposed. On success the header updates in place (Proposed → Active) without reloading the topic. | `Workspace.tsx` (pattern head, local patch of `data.patterns`) | `cms_set_catalogue_status('pattern', …)` | logic: in-place patch helper |
| Q10 | Proposed tabs (Concepts · Misconceptions · Typical sets · Patterns, plus the existing Topic classes) get a **Class column**. Concepts and typical sets show their own class. Misconceptions take it from the `G6-M-…` ID, falling back to the linked concept. Patterns show "via question type, Class N". New multi-select filters for **Subject, Class, Strand, Chapter, Topic**, each with counts, and tab counts follow the filters. Clicking a row opens the Q8 pane. | `Proposed.tsx`, `MultiSelect.tsx`, `logic.ts` | all proposed rows of the four kinds, loaded once, plus `cms_topics` → `cms_chapters` → strand and subject, joined on screen | logic: class derivation per kind, facet counts |

## Decisions (Sambit, 15 Nov 2026: answers to the open questions)
1. **Settings:** proposed settings are shown read-only (their Kind and the detail pane, no Approve). **Topic fix** is left out. **No 0035 migration.**
2. **Topic–class link reject:** no reason this round. The reason field is shown disabled with a note.
3. **Home:** unchanged for Q1.
4. **Science:** Level tag on question rows, yes. No Concept class / Level filters.
5. **Q5 rule confirmed:** a topic shows if it is core (or extra, when that box is ticked) in any selected class. Its questions follow Level ≤ the highest selected class the topic is in.
6. **Q6:** a question matches if ANY of its concepts has a chosen class.

## Build order and PR split
Each PR is a feature branch off `main` with small commits. **No stops between PRs** (Sambit, 15 Nov): no interim screenshots or PR-review requests. All screenshots go in the final report.
1. **PR A: labels** (Q2, Q3, Q4, Q7). Small, no data changes.
2. **PR B: higher-level questions + topic filters** (Q1, Q6). Adds `MultiSelect.tsx`.
3. **PR C: proposed review** (Q8, Q9, Q10). Reuses `MultiSelect`.
4. **PR D: Browse multi-select** (Q5). Last, because it changes the route and every class check in Workspace.

## Risks
- **Q5 touches every `r.cls` use** (tree, numbering, Science view, saved browse link, search hits). A single `ClassSel` helper and route tests limit this, and legacy URLs must still parse.
- **Q1 could make higher questions look like they belong to the class.** The tag and the split count make it explicit, and approval and placement (`cms_question_classes`) are unchanged.
- **The Q8 pane could catch the A/R/F keys meant for a question** (approving a question by mistake). Keys are disabled while an item is open.
- **Reject = retire.** It is reversible, and the pane says so.
- **Proposed screen load size.** Every proposed row is now loaded at once [guess: a few thousand rows, fine with `all()`]. Paged reads; first 500 rows rendered, as today.

## Ship steps (per PR, A → B → C → D)
1. **Before shipping, all of these must pass:** `npm run typecheck`, `npm test`, `npm run test:db` (local, ports 5542x), `npm run check-migrations`, and `db:verify` on local. Check the screens at 1440 px and 1280 px widths, and save screenshots to `~/WitoScope/screenshots/review-ux/`.
2. `db:verify` on real, as a check only (no migration).
3. Push, open the PR and merge it into `main`.
4. Deploy Cloudflare Pages production.
5. Smoke check on the live site, read-only. **The build never approves, rejects or edits any real content**; Approve and Reject are tested on local only.
6. **If anything breaks on real:** stop, roll back the deploy to the previous Pages deployment, and report.
7. **One report at the end:** each item built or not built (plus anything unsure), PR numbers and merge commits, the deploy result, the `db:verify` results, a test checklist for Sambit on the LIVE CMS (one line per item, saying where to click), and the screenshot folder.
8. Save this plan as `docs/plan-2026-11-15-review-ux.md` in PR A.

## Verification
- **Fractions, Class 3 + 4, checkbox off → 0 questions** (the 106 are in Classes 5–6). **Checkbox on → about +113 higher**, all tagged "above class". The `cms_questions.level` checksum is the same before and after.
- On local: Approve and Reject from the pane and from the pattern header each write one `cms_reviews` row, and the header flips in place.
- Old single-value Browse links still open the same view.

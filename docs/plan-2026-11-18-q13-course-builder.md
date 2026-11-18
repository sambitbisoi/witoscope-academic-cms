# Plan: Q13 · Course builder: Iteration 1 (migration, reference table, screens 0–4) · Iteration 2 (screens 5–7, Start from, pilot file), 18 Nov 2026

> Phase 1 (plan only). Nothing is built yet and nothing has been written to any database. All numbers come from **read-only** queries on real
> (`begin read only … rollback`, 18 Nov 2026). The file is not committed yet. After "go", step 0 commits it on branch `q13-a`, then Iteration 1 starts.
> Waiting for Sambit's "go" and his answers in §11.

## Context
A **course** is what the child's app will follow: a board / book series, a class and a subject, laid out as display chapters and display topics with child-facing names. Each display topic points at 1–4 CMS topics. The course builder only **arranges** the CMS curriculum. It never writes questions, topics, chapters or Question Level. Publishing is a status change only. Nothing goes to the app yet (Phase 8).

## 0. What I found (read-only, real)

| Check | Result |
|---|---|
| Migration head | 0044 · `curriculum_owner = cms` · rule version v11 |
| Existing course tables | **None** (no `cms_course*`, no book-chapter table) |
| CMS curriculum | Math: 58 chapters, 516 active topics, **264 Achievers** (ACH-MC..-1…6). Science: 58 chapters, 350 active topics, **0 Achievers** (the Achievers rule in 0034 is Math-only). Grammar is out of scope |
| Questions | Math production 4,959 (all have a Level; 0 approved) · Math gold 78 (excluded) · Science production 134 (all SC48 Magnets, Class 6) |
| Math topics linked to Class 5 | **247**: core (home class 5) 97 · from a lower class 139 · from a higher class 11 |
| Level ≤ 5 questions on them | **2,251** (core 521 · lower 1,730 · higher 0). The rule leaves out **572** questions with Level 6 on these topics |
| Class-5 topics by question count (Level ≤ 5) | 0: **97** (core 49) · 1–4: 39 · 5–9: 29 · 10–19: 38 · 20+: 44. Median 3 (core 0 · lower 7) |
| Threshold sensitivity (CMS topics below the threshold, all / core) | < 1: 97 / 49 · < 3: 118 / 55 · **< 5: 136 / 62** · < 10: 165 / 77 |
| Class 5 by strand (chapters · core · extra · Q ≤ 5) | Numbers & Place Value 6·11·14·184 · Operations 7·8·40·727 · Number Theory 1·6·4·91 · Fractions/Decimals/% 5·27·9·127 · Money/Ratio 4·6·7·49 · Patterns & Algebra 2·1·5·66 · Geometry 6·10·22·370 · Measurement 8·21·21·488 · Data 4·4·13·93 · Logical Reasoning 8·3·15·56 |
| **Achievers per class (Math)** | C1 30 · C2 37 · C3 46 · C4 47 · C5 51 · C6 53 topics. Questions at Level ≤ class: C1 0 · C2 0 · C3 2 · C4 1 · **C5 7** (ACH-MC32-5 4 · ACH-MC58-5 3) · C6 3. Every Math chapter present in Class 5 (51) has its ACH-…-5 |
| Science Class 5 | 164 topic links, **0** with any question at Level ≤ 5 |
| Reference workbook `Books_NCERT_DAV_Chapter_Map_Class1-6.xlsx` | 12 sheets (Math C1–C6, Science C1–C6) + Read Me. One row per NCERT chapter with the DAV chapter(s) beside it (some "2 (part)", some several per cell). Distinct chapters: **NCERT 121** (Math 77 · Science 44; no NCERT book for Science C1–C2) · **DAV 161** (Math 85 · Science 76). The Read Me says the file holds only bare citations and our own descriptions |

**What this means:** most courses will start with many "too few questions" warnings, and every Achievers section will have 0–4 questions until Achievers content is written. Science courses can be built, but today they will show 0 questions everywhere.

## 1. Data model: migration **0045_courses.sql** (schema `cms` only, adds only)

| Table | Columns | Constraints |
|---|---|---|
| **cms_courses** | `course_id text` PK `CRS001`…, `name`, `board`, `class int`, `subject`, `status`, `started_from text` (course ID), `created_at`, `updated_at`, `published_at` | `board in ('CBSE-NCERT','CBSE-DAV','ICSE','IMO')` (labels CBSE·NCERT …; can be widened later) · class 1–6 · `subject in ('math','science')` · `status in ('draft','published','retired')` · unique `lower(name)` among non-retired |
| **cms_course_chapters** (display chapters) | `course_chapter_id text` PK `DCH0001`…, `course_id` FK, `position int`, `name` (child-facing), `status active/retired`, `updated_at` | position ≥ 1; unique (course_id, position) where active |
| **cms_course_topics** (display topics) | `course_topic_id text` PK `DTP00001`…, `course_id` FK, `course_chapter_id` FK, `position`, `name`, `status`, `updated_at` | unique (course_chapter_id, position) where active |
| **cms_course_topic_items** (display topic → CMS topic) | `item_id bigint` identity PK, `course_id`, `course_topic_id` FK, `position 1–4`, `topic_id` FK `cms_topics`, `added_at`, `removed_at` | **unique (course_id, topic_id) where removed_at is null** (a CMS topic sits in at most one display topic per course) · unique (course_topic_id, position) where active, with `position between 1 and 4` (so the DB itself caps it at 4) · the CMS topic is a normal topic (not ACH) of the course's subject (checked in the save function) |
| **cms_course_achievers** (display chapter → Achievers CMS chapters) | `item_id` PK, `course_id`, `course_chapter_id` FK, `position 1–4`, `chapter_id` FK `cms_chapters`, `added_at`, `removed_at` | **unique (course_id, chapter_id) where active** · unique (course_chapter_id, position) where active, 1–4 · chapter of the course's subject. The ACH topic is **never stored**: it is resolved as `ACH-<chapter_id>-<course class>`, so a class change re-resolves it |
| **cms_ref_book_chapters** (read-only reference) | `ref_id` PK, `book` (`NCERT`/`DAV`), `book_title` (e.g. Maths Mela), `class`, `subject`, `ch_no int`, `ch_label` (as printed, e.g. "2"), `ch_name`, `import_id` | unique (book, class, subject, ch_no). **SELECT only** for authenticated; no write function. Loaded only by the local script |
| `cms_config` | `course_min_questions = 5` (§11 Q4) | key added, no data elsewhere |

Order uses positions (shown as 1 / 1.2 with no gaps, computed); IDs are shown last and muted. **Nothing is deleted.** A display chapter or topic is retired, and retiring it also releases its CMS-topic and Achievers links (`removed_at` is set and audited), so those topics can be placed again. A removed link keeps its row.

**Widened CHECKs:** `cms_reviews.target` + `'course'` · `cms_reviews.action` + `course_save`, `course_status`, `course_upload`, `course_clone`, `course_copy` · `cms_imports.kind` + `book_chapters`, `course_upload`.

**RLS** on all 6 tables: the `cms_admin_only` policy and SELECT for `authenticated` (as 0008). Writes go only through admin-checked `security definer` functions with `search_path = ''`. `check-migrations` must pass (no other schema, no EXECUTE, views `security_invoker`).

## 2. Functions and views (0045)

| Object | What it does |
|---|---|
| **`cms_save_course(p jsonb)`** | One transaction, admin only. `p = {course_id?, course:{name, board, class, subject}, outline?:{chapters:[{id?, name, topics:[{id?, name, cms:[topic_id…]}], achievers:[chapter_id…]}]}, expect_updated_at, source:'form'/'upload'/'clone'/'compare'/'start_from', from_course?, reason?}`. The outline is the **desired state** in order. The function diffs it against the DB: new rows get IDs (next free number under a lock); renamed or moved rows are updated; rows that are left out are retired (chapters and topics) or removed (links); positions are renumbered 1…n. Refused: the course is not a draft (except creating one) · `expect_updated_at` is stale (another tab saved) · a CMS topic appears twice · more than 4 per display topic · a CMS topic is retired, an ACH row or of another subject · an Achievers chapter is used twice or is of another subject · the subject changes after create. **Audit:** one `cms_reviews` row (`target 'course'`, `action course_save` or the source's action) per changed row, with before → after, plus one summary row per call that lists the counts |
| **`cms_set_course_status(p)`** | draft → published (**Publish**; blocked while any ✗ check is open, §5) · published → draft (**Back to draft**) · any → retired · retired → draft (Restore). Audited (`course_status`). Changes only `cms_courses.status` / `published_at` |
| `cms_copy_course(p)` (It2) | "Start from": creates a new draft from another course of the same subject (any status), copying its active chapters, topics, links and Achievers. The class may differ. Audited (`course_copy`, source course in the reason) |
| **view `cms_course_item_stats`** | Per course × display topic × CMS topic: `n_questions` = counted questions with `effective_level ≤ course.class` · `n_approved` · `n_higher` (left out, Level > class) · topic home class, status, kind |
| **view `cms_course_achiever_stats`** | Per Achievers link: resolved `ach_topic_id`, `ach_exists`, `ach_status`, `n_questions` (Level ≤ class) |
| view `cms_course_list` | Per course: chapters · topics · CMS topics · questions at Level ≤ class · status (screen 0) |

**Question count rule** (as D3 for the class tree, applied to the course class):
```sql
select count(*) from cms.cms_question_list l
 where l.topic_id = :cms_topic and l.counted            -- production, not retired, not rejected-only; gold never counts
   and l.effective_level <= :course_class;              -- effective_level = Level, else the question's class (0 blank today)
-- Achievers: the same, with l.topic_id = 'ACH-' || :chapter_id || '-' || :course_class
```

## 3. Reference data: `npm run import:book-chapters` (local, cms_owner)

| Step | Detail |
|---|---|
| Read | `~/WitoScope/ContentResearch/Books_NCERT_DAV_Chapter_Map_Class1-6.xlsx` (path as an argument), sheets `Math C1…Science C6`. Columns used: Class, Subject, NCERT book, NCERT ch no, NCERT chapter name, DAV book, DAV ch no, DAV chapter name. **Covers, Notes and the Olympiad columns are not loaded** |
| Normalise | One row per (book, class, subject, chapter number). A DAV cell with several lines → several chapters. "(part)" is dropped. Duplicates merge, keeping the first name. Science C1–C2 have no NCERT book, so the tab shows "No NCERT book for this class" |
| Write | One transaction (about 280 rows), upsert by key. `cms_imports` kind `book_chapters`, with the file hash and counts. A second run changes 0 rows. Report in `.local-import/` |
| Book rule | Chapter numbers and titles are bare citations (CLAUDE.md allows them in the cloud). No chapter text, exercises or pages. `db:verify` adds a check that the table holds only these columns and that `ch_name` is ≤ 120 characters |

## 4. Screens (route `#/courses`, a new **Courses** link in the top bar)

Steps 1–4 share a stepper (Details · Chapters · Topics · Review). Each screen has an **explicit Save**, warns about unsaved changes when you leave, and shows names first with IDs last and muted. Published and retired courses open read-only, with a "Back to draft" button.

| # | Screen | Behaviour |
|---|---|---|
| 0 | **Courses** `#/courses` | Table: name · board · class · subject · chapters · topics · status. Filters: subject, class, status (retired hidden; shown under "More"). Buttons: **Add a course**, **Upload from Excel** (It2), **Compare** (It2). Click a row → Details |
| 1 | **Details** `#/course/CRS001` | Name, board, class, subject (subject is fixed once saved; class can be edited while draft, and the counts then recompute). "Start from" another course (It2; a new course only) |
| 2 | **Display chapters** `…/chapters` | List: number, name (editable inline), topics count, questions count, ↑ ↓ and drag (the Reorder pattern), Retire. "+ Add chapter". Buttons Clone a chapter / Compare (It2). Each chapter has an **Achievers** row: a picker for 1–4 CMS chapters of the subject (chapters already used in this course are greyed, with where they are), and per pick the resolved `ACH-MC31-5`, its name and question count, or ✗ "no Achievers topic for Class 5". **Right panel (read-only):** tab **Book chapters**: chapter number · name for the course's book (NCERT for CBSE·NCERT, DAV for CBSE·DAV), class and subject, with an NCERT/DAV switch. Tab **CMS content**: strand › CMS chapter; click a chapter → its topics (home class, Level ≤ class count, where used in this course). Math only: Science shows "Science has no Achievers topics yet" in place of the Achievers row |
| 3 | **Display topics** `…/topics?ch=DCH0003` | Left: display chapters (counts). Middle: the selected chapter's display topics: name (editable), the CMS topics inside (name · ID muted · home class · Level ≤ class count · ✕), "n of max 4", drag to reorder topics, and drag CMS topics within or between display topics of this chapter; Retire; "+ Add display topic". Right: **CMS topic picker**: search (name or ID), filters strand / class (default = topics linked to the course class; "any class" possible) / CMS chapter, "Hide already used" (on by default). Used topics are greyed with where they are ("in 3.2 Big numbers"). Click "+" → adds to the selected display topic. Retired and Achievers topics are not listed |
| 4 | **Review & publish** `…/review` | Counts: chapters · display topics · CMS topics · questions at Level ≤ class (approved n) · Achievers questions. **Checks** (§5), each opening the place to fix it. **Outline**: chapter › display topic › CMS IDs with counts. Buttons **Save as draft** (stays a draft) and **Publish** (disabled while a ✗ is open) |
| 5 | **Upload from Excel** `#/courses/upload` (It2) | **Download template** (the 6 sheets; sheet 6 = the CMS topics list for the chosen class and subject, built in the browser with exceljs). Drop a file → parse → error/warning list → choose **New course** or **Replace draft …** (drafts only) → preview of the changes ("+4 chapters, 2 renamed, 3 retired, +18 CMS links") → Save. ✗ blocks saving |
| 6 | **Clone a chapter** `…/clone` (It2) | Source course (any) + its chapter → new name (default: the source name) → place **at the end** or **replace chapter n**. Preview: tick boxes per display topic; CMS topics already used in this course are struck through ("skipped: in 4.2"); a display topic left with none is unticked; Achievers chapters are carried, skipping those already used. Save → opens screen 3 on the new chapter. The source is never changed |
| 7 | **Compare** `#/courses/compare?a=DCH…&b=DCH…` (It2) | Pick A and B (course › chapter, any two courses). Chips: **All · In both · Only in A · Only in B**. One row per CMS topic: name · ID · A's display topic · B's display topic · counts at each course's class. For B-only rows: "+ Add to A" → choose A's display topic (those with < 4) or "new display topic (B's name)", then Save. A must be an editable draft. A topic found in **another chapter of A** is flagged "in A › 4.2" and has no Add button. Achievers chapters are compared the same way, below |

## 5. Checks (`shared/course-checks.ts`: pure, used by screen 4, the upload and db:verify)

| Check | Level | Detail |
|---|---|---|
| A display chapter has no display topics | ✗ | blocks Publish |
| A display topic has no CMS topics | ✗ | blocks Publish |
| A placed CMS topic has been retired since | ✗ | blocks Publish |
| An Achievers section's ACH topic doesn't exist (or is retired) | ✗ | e.g. a chapter not taught in that class; always for Science |
| Class-N CMS topics not placed anywhere | ! | **core** (home class N) listed as a warning; extra (from a lower/higher class) listed under "More" as info |
| A display topic has too few questions | ! | sum over its CMS topics at Level ≤ class < `course_min_questions` (default **5**) |
| An Achievers section has 0 questions | i | info only (today almost all of them) |
| A CMS topic has questions above the class | i | "n questions with Level > N are not shown" |

## 6. Excel format and parser (It2; `shared/course-excel.ts`, pure, unit-tested; the web uses exceljs to read the cells)

| Sheet | Columns |
|---|---|
| 1 Course | course_name, board, class, subject |
| 2 Display chapters | chapter_no, chapter_name |
| 3 Display topics | chapter_no, topic_no, display_topic_name |
| 4 Display topic → CMS topics | chapter_no, topic_no, order, cms_topic_id, cms_topic_name |
| 5 Display chapter → Achievers CMS chapters | chapter_no, order, cms_chapter_id |
| 6 CMS topics (read-only, ignored on upload) | topic_id, name, strand, CMS chapter, home class, linked to class N (core/lower/higher), Level ≤ N count |

| ✗ Errors (block saving) | ! Warnings |
|---|---|
| Missing sheet or column · bad board/class/subject · course name already used (new course) · chapter_no or (chapter_no, topic_no) repeated or blank · a topic row on an unknown chapter_no · **unknown CMS topic ID** · CMS topic retired / an ACH row / of another subject · **topic used twice in the course** · **unknown CMS chapter in Achievers** · **Achievers chapter used twice** · replace target is not a draft | **name differs from CMS (the ID wins)** · **more than 4 CMS topics** in a display topic (the first 4 by order are saved and the rest are listed as not saved, §11 Q9) · more than 4 Achievers chapters (same) · an Achievers chapter with no ACH topic for the class · empty display chapter or topic · Excel order gaps (renumbered) |

Replace = the same desired-state save (`source 'upload'`): left-out rows are retired or removed, all of it audited, and `cms_imports` (kind `course_upload`) records the file name, hash and counts. The file itself is not uploaded.

## 7. Clone, Start from and Compare logic (It2; `shared/course-ops.ts`, pure)

| Operation | Rule |
|---|---|
| Clone chapter | Input: source outline, target outline, chapter, ticks, place. The output is the new target outline. Skip CMS topics already in the target (when replacing, the replaced chapter's own topics don't count as used). Drop display topics left empty. Carry Achievers, skipping chapters used elsewhere in the target. The subject must match. A different class only gives a note ("counts use Class 5"). Saved by `cms_save_course` with `source 'clone'` and the reason "cloned from CRS002 › DCH0011" |
| Start from | Server-side copy (`cms_copy_course`). All of it, the same subject |
| Compare | Union of the CMS topics of chapter A and chapter B → rows with side A/B/both. A B-only topic used elsewhere in A → flagged, with no Add. "+ Add to A" edits A's outline in the browser, and Save sends it |

## 8. Tests

| Kind | Cases |
|---|---|
| Unit | Checks (each on and off; threshold edge 4/5) · numbering after a reorder or retire · Excel parser: every ✗ and ! above, a valid template round-trip, >4 kept/dropped · clone (skip used, replace frees own topics, empty topic dropped, Achievers carry) · compare (chips, flag elsewhere-in-A) · book-chapter normaliser (multi-line DAV, "(part)", NCERT-less Science C1–2) |
| DB | Course CRUD and audit rows (before → after per row) · unique course + CMS topic (same topic in two courses OK, twice in one refused, OK again after removal) · 5th link refused (function and index) · other-subject / ACH / retired topic refused · Achievers unique and subject · published not editable; Back to draft; Publish blocked by ✗ · stale `expect_updated_at` refused · retire releases links · view counts: fixture with Levels 4/5/6 in a Class-5 course = 2 shown, 1 left out; gold never counts; ACH resolution follows a class change · RLS: another user sees 0 rows and can't call the functions; authenticated can't write `cms_ref_book_chapters` · `import:book-chapters` idempotent · fingerprint: no existing table changes |
| Gates | `typecheck`, `test`, `test:db` (local 5542x), `check-migrations`, `db:verify`, `web build`, one at a time |
| Screens | Screenshots of screens 0–4 (It1) and 5–7 (It2) at 1440 and 1280 px → `~/WitoScope/screenshots/q13/` |

## 9. Real data steps, PRs, deploy order, rollback

| Iter | PR | Contents | DB on real |
|---|---|---|---|
| 1 | **A** `q13-a` | This plan · 0045 · `import:book-chapters` · shared checks · DB tests · db:verify checks | 0045 (schema + 1 config key; 0 rows changed elsewhere) · then the reference load (~280 rows, 1 tx) |
| 1 | **B** `q13-b` | Screens 0–2 incl. the right panel and the Achievers sections | — |
| 1 | **C** `q13-c` | Screens 3–4 (picker, checks, Publish) | — |
| 2 | **D** `q13-d` | Screen 5 + parser + template | — (0046 only if Iteration 1 testing needs a schema change; adds only) |
| 2 | **E** `q13-e` | Screens 6–7 + Start from (`cms_copy_course`, in 0045 already) | — |
| 2 | — | Pilot file `ContentResearch/CMS-updates/2026-11-18-course-pilot/CBSE-NCERT-C5-Math.xlsx` (template format): 15 display chapters from the Maths Mela 5 chapter names, my proposed CMS topic mappings (from CMS topic names and our own "Covers" notes, **inferred**) with Level-5 counts in sheet 6 and a notes column. Built by a local script; **not loaded** | none |

**Order for each migration/data step:** backup (`~/WitoScope/CMS-backups/real-cms-2026-11-18-pre-0045.dump`, `backup-real.sh`) → `rehearsal-restore.sh` into `cms_rehearsal` → fingerprint → `migrate-guarded.ts` → `import:book-chapters` → fingerprint (only the new tables, `cms_config` +1 key and `cms_imports` +1 differ) → `db:verify` → real, the same steps (`--env-file=.env.real`) → `db:verify` on a fresh connection → counts equal the rehearsal → merge A → B → C → deploy → the live site loads `#/courses` → STOP for Sambit's test. Iteration 2: merge D → E → deploy → the pilot file → final report → drop `cms_rehearsal`. Round tooling goes to `ContentResearch/CMS-updates/2026-11-18-q13/scripts/`.

**Stop conditions:** db:verify fails · a step changes rows outside its scope · a migration needs a drop or rename · any content would be lost · real differs from the rehearsal · a deploy fails.

**Rollback:** screens → the previous Pages deployment. 0045 only adds tables, keys and wider CHECKs, so the old UI ignores them. Course data → `cms_reviews` before → after (nothing is deleted). Reference table → re-run, or leave it (read-only). A full restore from the pre-0045 dump only with Sambit's OK.

## 10. Not in scope
Nothing goes to the app (Phase 8) · no Grammar courses · no role field (core/revision/extension) · the course never changes Question Level, topics or classes · no Olympiad (SOF) topic reference (backlog).

## 11. Open questions for Sambit (my proposal in **bold**)

| # | Question | Proposal |
|---|---|---|
| 1 | Board values | **Fixed list CBSE·NCERT, CBSE·DAV, ICSE, IMO (can be widened later). The Book chapters tab shows NCERT for CBSE·NCERT and DAV for CBSE·DAV, with a switch; nothing is loaded for ICSE/IMO** |
| 2 | Which questions count | **Production, not retired, not rejected-only (as Browse); gold never; Level ≤ class, using the question's class if Level is blank (0 blank today). Approved shown beside** |
| 3 | What "class-N topics not placed" lists | **Core topics of class N as a warning; extra topics (lower/higher) as info under More** |
| 4 | "Too few questions" threshold | **5 per display topic (sum of its CMS topics), in `cms_config.course_min_questions`.** For Class 5 Math, 136 of 247 CMS topics are below 5 on their own |
| 5 | What blocks Publish | **Only structural ✗ (empty chapter, empty display topic, retired CMS topic, missing ACH topic); warnings never block** |
| 6 | Editing a published course | **Read-only; "Back to draft" (audited) to edit; then Publish again** |
| 7 | Removing things | **Display chapters/topics are retired (kept, with IDs); removed links keep their row with `removed_at`; retiring a chapter or topic releases its CMS topics** |
| 8 | Achievers for Science (no ACH topics exist) | **Math only for now; Science shows "no Achievers topics yet"** |
| 9 | Excel: > 4 CMS topics | **Warning; the first 4 by `order` are saved and the rest are listed as not saved** (alternative: make it an error) |
| 10 | Changing class/subject | **Subject fixed after create; class editable while draft** |
| 11 | IDs | **CRS001 · DCH0001 · DTP00001 (permanent, never reused); numbers 1 / 1.2 from position** |
| 12 | Picker scope | **Any active normal CMS topic of the subject, any class; default filter = topics linked to the course class; home class shown as info** |
| 13 | Clone "replace chapter n" | **Retire chapter n and put the clone at its position (its topics are free to be re-used by the clone)** |
| 14 | Pilot names | **The display chapter names are the 15 Maths Mela titles, as placeholders for review. Display topic names = the CMS topic name when there is one CMS topic, otherwise a short name of mine (inferred). Whether the app may show book titles to children is decided with Phase 8** |
| 15 | Course name unique | **Yes, among non-retired courses (case-insensitive)** |
| 16 | Load our "Covers" text from the workbook into the Book chapters tab? | **No; names only, as asked** |

## 12. Decisions (Sambit, 18 Nov 2026): approved, "go" (Iteration 1: PR A → B → C, deploy, STOP)
- 2–16: as proposed.
- **1 (changed):** board values live in an **editable, audited list**, table `cms_course_boards` (ID `BRD01`…, label, matching book NCERT / DAV / none, sort, active/retired), edited through `cms_save_course_board`. Seeded with CBSE·NCERT (NCERT), CBSE·DAV (DAV), ICSE (none), IMO (none). A course refers to a board by ID. A retired board stays on the courses that use it and can't be picked for a new one. The Book chapters tab shows the board's book, with an NCERT / DAV switch.
- Build detail: positions are `null` on retired or removed rows, so the "one per position" rules are deferrable unique constraints. A save renumbers positions in one transaction. Each course has a `rev` counter: a save from a stale tab is refused.

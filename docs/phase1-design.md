# WitoScope Academic CMS — Phase 1 design (draft for review)

v1.0 · 8 Nov 2026 · attribute rules: Question Attributes **v10** · status: **APPROVED by Sambit, 8 Nov 2026** (section 9 decisions recorded)

Companion files: `schema/chapter.schema.json` (chapter file schema) · `content/examples/MC19-example.json` (one worked question, validates against the schema).

Items marked **[guess]** are inferred and need your check.

---

## 0. Ground rules (go into the repo's CLAUDE.md)

| Rule | Detail |
|---|---|
| Own namespace only | Everything in schema `cms`; every table prefixed `cms_`. |
| Never touch existing objects | No CREATE/ALTER/DROP outside `cms`. No foreign keys, views, triggers, functions or policies that reference `public`, `app` or any other schema. A repo check fails any migration that mentions another schema. |
| One exception, read-only | RLS policies call Supabase's built-in `auth.uid()` to recognise your login. It reads nothing from app tables. |
| Dedicated DB role | `cms_owner` owns `cms`, with no rights elsewhere. Migrations and server functions use it, never `service_role`. |
| Locked by default | RLS on every table; only your user ID (stored in `cms_config`) may read or write. App users get nothing. |
| Shared items (approved) | Login = your existing Supabase account · our own figure images in the private **Cloudflare R2** bucket `cms-sources` (changed 9 Nov 2026 from Supabase Storage; book files removed 10 Nov 2026; see §9) · `cms` added to exposed schemas **[default, not yet confirmed]** · pgvector later, installed into `cms`. |
| Explicit Save | No auto-save anywhere. |
| Book content is internal | Source refs never leave the CMS; the Publish step (Phase 8) can't read them. |
| Book material stays on the Mac (10 Nov 2026) | **The rule is defined in CLAUDE.md ("Book material rule"), which wins over this summary.** AI threads may read the book PDFs on the Mac, but nothing book-derived is stored or uploaded outside it. Only our own content leaves Sambit's Mac. Third-party book material (NCERT/DAV/IXL/SOF PDFs, scans, screenshots, extracted item text, their numbers) is never stored in Supabase, R2 or any cloud. The cloud holds only our original content, bare citations (book, class, chapter, page, section, exercise/item number) and official public links. The originality check runs on the Mac. |

---

## 1. IDs

| Thing | ID | Example | Who assigns |
|---|---|---|---|
| Chapter / topic | MC##/MT####, SC##/ST####, GC##/GT#### | MC19, MT0393 | Master topic lists until the cut-over; then the CMS (next free number, D5, 12 Nov 2026) |
| Strand | `<subject>-<name>` **[guess: the topic lists may already have strand IDs]** | math-logical-reasoning | Topic import |
| Question | MQ######, SQ######, GQ###### | MQ000001 | CMS, on first import |
| File key | `<chapter>-####` | MC19-0001 | Generation thread; permanent, links the file row to its MQ ID |
| Gold question | G6-001 … | G5-007-a | Gold set only |
| Concept | `G{class}-{area}-C#` / `-A#` | G6-FRC-C1 | Author; in the CMS the next free number for the code (D5) |
| Misconception | `G{class}-M-{area}#`; legacy MM### in `alias` | G6-M-FRC1 | Author |
| Typical set | `TS-G{class}-…` | TS-G6-FRAC-ADD-UNLIKE | Author; in the CMS made from the name (D5) |
| Pattern | MP####, SP####, GP#### | MP0007 | Author / generation; in the CMS the next free number (D5) |
| Insight | INS-… | INS-LAST-STEP | Author |
| Source item | N7-###, D5-### … | N7-031 | Source extraction |
| Release | integer, rising | 1, 2, 3 | Publish step |

All IDs are permanent and never reused. Class is a field, never inferred from an ID after creation.

---

## 2. Tables (all in schema `cms`)

### A. Curriculum (owned by the CMS after the one-time cut-over; until then from the master topic lists)

> **Changed 12 Nov 2026 (D5, Sambit, option B):** the CMS owns the curriculum. Chapters, topics, concepts, typical sets and patterns are added and edited in the CMS (`cms_save_curriculum`: automatic permanent IDs, Retire instead of delete, every change audited, new catalogue items Proposed). The topic workbooks become read-only exports (`npm run export:topics`). Until the cut-over (`docs/curriculum-cutover.md`, `cms_config.curriculum_owner`), `import:topics` still owns chapters and topics. Topic ↔ classes (`cms_topic_classes`) and prerequisites (`cms_topic_prereqs`) are CMS data from the start.

| Table | Purpose | Key columns |
|---|---|---|
| `cms_strands` | Strands per subject (e.g. Logical Reasoning MC51–58) | strand_id, subject, name, sort |
| `cms_chapters` | Chapters | chapter_id, subject, strand_id, name, sort |
| `cms_topics` | Topics with Class View placement | topic_id, chapter_id, class, name, topic_kind (normal / achievers), taught_in_school (has NCERT or DAV source), source_flags (ncert, dav, ixl, imo / iso / ieo), status (active / retired) |

> **Round 2 (Sambit, 13 Nov 2026):** terminology is **strand → chapter → topic**. The child sees strand, then topic; our chapter is an internal grouping. **R1:** every topic–class link has a role from the topic's home class (its Class View class): **core** (home = this class), **from a lower class** (home < this class) or **from a higher class** (home > this class); views `cms_topic_all_classes` and `cms_topic_class_stats` carry `role` and `home_class` (migration 0027). Browse shows core topics by default, with "Include extra topics (lower / higher class)"; the Level ≤ class display rule (D3) is unchanged.

> **Review status per topic (Sambit, 13 Nov 2026):** `cms_topic_reviews` (topic_id, status not_started / in_progress / done, note, updated_at, updated_by; migration 0028). One status per topic, shared by every class it appears in; manual only, set in Browse with an explicit Save through `cms_set_topic_review` (admin only, logged `review_status` before → after). A chapter or strand within a class rolls up its **core** topics for that class (extra rows, retired topics and Achievers rows are not counted): all done = green ✓, some started = orange ◐, none = no icon.

One "Achievers" topic row per chapter-class (topic_kind = achievers) **[guess: ID scheme for these rows; proposed `ACH-MC19-6`]**.

> **Sequencing (Sambit, 13 Nov 2026; migration 0031):** the order of strands, chapters and topics is stored per class, never on the item: `cms_strand_order` (class + subject), `cms_chapter_order` (within its strand, per class), `cms_topic_order` (within its chapter, per class; core topics only). Seeded once from the Class View Seq. A chapter belongs to one strand; a row stored under another strand / chapter than the item's current one is ignored (the item moved, so it goes to the end), as are items with no row. Retired items keep their slot but are hidden; Achievers rows are always last in their chapter; extra rows (from a lower / higher class) come after the core ones, unnumbered. Numbering is computed with no gaps (`shared/sequence.ts`): strand `1.`, chapter `1.2`, topic `1.2.3`, shown in the Curriculum map, the Browse tree and the Excel export (Class View: Seq = position in the class, No. = 1.2.3). Names come first with the ID last, smaller and muted. Reorder mode on the map (one class + one subject; the level follows Show chapter / Show topic) saves through `cms_save_order` (admin only; no crossing; audited `reorder` before → after).

### B. Catalogues (tagging vocabulary)

| Table | Purpose | Key columns |
|---|---|---|
| `cms_concepts` | Concept cards | concept_id, subject, class, topic_id, name, type (core / applied), description, includes, excludes, example_question, curriculum_tags[], status (draft / active / retired) |
| `cms_concept_links` | Builds_on and prerequisites | from_concept, to_concept, kind (builds_on / prerequisite), flagged (earlier chapter) |
| `cms_concept_prereq_topics` | Prerequisite topics with no concept yet | concept_id, topic_id |
| `cms_misconceptions` | Misconceptions | misconception_id, concept_id, description, parent_description, root_prereq_concept, **alias** (MM###), status |
| `cms_typical_sets` | Parent-facing question groups | typical_set_id, subject, class, chapter_id, topic_id, name, instruction_pattern, variant_note, parent_visible, status |
| `cms_typical_set_concepts` | Concepts a set exercises | typical_set_id, concept_id, role (main / other) |
| `cms_strategy_types` | 13 moves + Other | value, example, hint_1, active |
| `cms_insights` | Achiever insight catalogue | insight_id, name, strategy_type, structure, recognition_test, includes, excludes, parent_line, kid_hint, status (proposed / active / merged / inactive), merged_into |
| `cms_patterns` | Internal generation templates | pattern_id, topic_id, typical_set_id (one), name, template, variables (json), target_misconceptions[], notes, status |

Catalogue rows are edited in place with an audit row in `cms_reviews` (they're vocabulary, not content). Never deleted: retire, deactivate or merge.

### C. Questions (versioned)

| Table | Purpose | Key columns |
|---|---|---|
| `cms_questions` | Stable identity | question_id, **bank** (production / gold), subject, file_key, chapter_id, topic_id, class (+ class_override, placement_note), typical_set_id, pattern_id, clone_batch_id, locale, current_version, approved_version, retired_at. topic_id / typical_set_id / pattern_id here are pointers to the **current** placement (9 Nov 2026) |
| `cms_question_versions` | **Immutable** content + tags, one row per version | question_id, version_no, status, **topic_id, typical_set_id, pattern_id** (placement of this version; added 9 Nov 2026, since a move creates a new version), text, figure_description, image_status, image_path (R2 key), format, correct, accepted[], duration_s, signature columns (math_difficulty, is_pure_fact, reading, has_irrelevant_info, steps, working_memory, inhibition, visual, strategy, strategy_type, strategy_type_2, strategy_other_note, insight_id, trick_ref), derived columns (§4), tagging_why (json), tagged_by, tagging_summary, content_hash, created_from (import / edit / generation), import_id or run_id, created_at |
| `cms_version_parts` | Multi-part: one row per part | version_id, part_label, text, format, correct, accepted[] |
| `cms_version_options` | MCQ / T-F options | version_id, part_label, position, text, is_correct |
| `cms_version_wrong_answers` | Tagged wrong options or typed values | version_id, part_label, value, option_position, tag, misconception_id, target_concept_id, why |
| `cms_version_concepts` | Concepts + involvement | version_id, part_label, concept_id, involvement (1.0 / 0.5 / 0.2) |
| `cms_version_solutions` | Solution 1 (school) and 2 | version_id, slot (1 / 2), text, type (Smarter way / Another way), strategy |
| `cms_version_hints` | Hint ladder | version_id, level (1–3), text |
| `cms_version_source_refs` | Book items it was modelled on (internal) | version_id, ref_id, relation (modelled_on / same_idea / checked_against) |

**Gold set: a change from my earlier note.** Instead of a separate gold table, gold questions use the same tables with `bank = 'gold'` and their G6-001 IDs. This reuses options, tags and concepts without duplicating structure. A check constraint and the Publish query both exclude `bank = 'gold'`, so they can never ship. Gold-only fields live in:

| Table | Key columns |
|---|---|
| `cms_gold_meta` | question_id, use (prompt_example / test_only), old_qid, final_reasoning, review_verdict, review_notes |

> **Add and bulk-upload questions (Sambit, 13 Nov 2026; migration 0029; no AI):** inside a topic in Browse, "+ Add question" (form) and "Bulk upload (Excel)" (Download template → upload → preview with per-row errors for missing mandatory fields only → import valid rows, skip the rest with reasons → summary). The topic is fixed by where you are. Mandatory: text, format (MCQ-4, MCQ-3, True/False, Typed-number / -decimal / -fraction / -text), correct answer, options for MCQ (True/False automatic), Level (pre-filled with the topic's home class, confirmed), Picture needed Y/N (Y needs a figure description). Saved through `cms_add_questions` (admin only; logged `create`) as **Needs review**, `created_from` manual / upload (an upload is a `cms_imports` row, kind `upload`), with `attributes_pending` (left out of clone groups; cleared once the signature is filled), `image_status = needs_image` when a picture is needed, and `originality_pending`. A version can't be approved while its originality check, its picture (`needs_image`) or its attributes are pending, so "Approved" always means ready for the app (trigger `cms_version_flags`, migrations 0029–0030; picture and attributes apply to production questions, not gold); `npm run check:originality -- --pending` on the Mac records the check (logged `originality_check`) and clears the flag. No similarity, duplicate or quality checks at upload.

### D. Tagging rules (versioned)

| Table | Purpose | Key columns |
|---|---|---|
| `cms_rule_versions` | One row per workbook version | rule_version (v10…), notes, created_at |
| `cms_attribute_defs` | Question Attributes sheet | rule_version, attribute, group, meaning, values, needed_by_engine |
| `cms_tagging_rubric` | Per judged attribute | rule_version, attribute, definition, levels_anchors, rules, edge_cases, calibration_case_ids[] |
| `cms_calibration_cases` | Contested judgements | case_id, rule_version, question_id, attribute, first_value, final_value, why_wrong, rule |
| `cms_tagging_packs` | The cached AI prompt pack built from the above | pack_version, rule_version, content_hash, built_at (Phase 6) |

### E. Sources (internal only; citations only since 10 Nov 2026)

| Table | Purpose | Key columns |
|---|---|---|
| `cms_sources` | Book and web citations | source_id, kind (pdf / scanned_pdf / web), title, publisher (NCERT / DAV / IXL / SOF / other), class, url (the **official public link** only; NCERT must be `https://ncert.nic.in/…`, enforced), page_offset (printed page = pdf page − offset), captured_at (date checked). ~~storage_path~~ dropped: book files stay on the Mac |
| `cms_source_chapters` | Which part of a source covers a chapter | source_id, chapter_id, page_from, page_to |
| `cms_source_jumps` | Section citations ("1.2 Patterns in Numbers · p2"), shown as text with a link to the official PDF at that page | source_id, chapter_id, label, pdf_page |
| ~~`cms_source_assets`~~ | ~~Screenshots~~ — dropped 10 Nov 2026 | |
| `cms_source_items` | Book item **citations** (N6-01-004…) | ref_id, source_id, page, section, item_label (the exercise/item number only, e.g. "Figure it Out Q2"), topic_id, pattern_id. ~~item_text, numbers~~ dropped: they stay in the local book files |
| `cms_originality_checks` | Results of the local originality check | version_id, checked_at, result (clear / flagged / near_copy / no_sources), similarity, same_numbers, closest_ref (a citation), checked / missing sources, threshold, tool, import_id |

### F. Workflow

| Table | Purpose | Key columns |
|---|---|---|
| `cms_imports` | Each chapter-file import | import_id, file_path, git_commit, file_hash, started_at, result (ok / partial / failed), counts (json), error_report (json) |
| `cms_reviews` | Audit trail | target (question version / catalogue row), action (submit / approve / reject / typo_fix / retire / restore / edit_catalogue), reason, field_diff (json), by, at |
| `cms_generation_runs` | Each AI generation | run_id, kind (generate_similar / fill_set / chapter / tag), model, pack_version, params (json), tokens_in/out, cost, status, created_at |
| `cms_jobs` | Long-running jobs shown on Home | job_id, type, status, progress, payload, result, error, started_at, finished_at |
| `cms_releases` | Numbered publish releases (Phase 8) | release_no, notes, published_at, rolled_back_at |
| `cms_release_items` | Which version went out | release_no, question_id, version_id |
| `cms_config` | Settings the rules depend on | key, value (json): admin_user_id, multistep_bands, difficulty_points (3/5/8), load thresholds (3 / 4) |

~~Later (Phase 6): `cms_embeddings`~~ dropped: no pgvector (see §9).

Total: 39 tables now, 40 with embeddings.

---

## 3. Status and versioning

| Rule | Detail |
|---|---|
| Version statuses | draft → in_review → approved / rejected |
| Question-level | retired_at (hides it from Publish; never deleted) |
| One open version | At most one draft or in_review version per question at a time |
| Pointers | `current_version` = latest; `approved_version` = latest approved (what Publish uses) |
| Rejected | Kept with its reason; a new version can follow |

**Same version vs new version**

| Change | Result |
|---|---|
| Spelling, punctuation or wording that doesn't change the math, in text, solutions, hints or the why notes | **Same version.** Edited in place and logged as `typo_fix` with a before/after diff. An approved version stays approved. |
| Any number, option, correct answer, accepted answer, format or part | **New version** (status draft) |
| Concepts, involvement, wrong-answer tags, any signature value | **New version** **[guess: you said numbers, options, answer; I've extended it to tags, since they change what the engine does]** |
| Topic, typical set or pattern move | **New version** **[guess]** |
| Figure image added for a "needs image" figure | **New version** **[guess: changes what the child sees]** |

"Immutable" therefore means immutable except for logged typo fixes. The CMS's Save button decides which case applies and tells you before saving.

---

## 4. Derived fields (computed on Save and stored on the version)

| Field | Rule (from Derived Attributes, v10) |
|---|---|
| multistep_band | Steps → 1/2/3/4/5 using `cms_config.multistep_bands` |
| load, load_driver | Highest of reading, band, WM; ties: reading > multi-step > memory |
| style | reading = 1 → one-liner, else word |
| tier | strategy 0–1 School · 2 Achiever · 3 or beyond-grade concept → Super Achiever |
| trap_level | any misconception tag → 2 · any shortcut tag → 1 · else 0 |
| is_isolating | exactly one concept with involvement ≥ 0.5 |
| difficulty_points | Simple 3 · Medium 5 · Complex 8 |

If a config value changes, a one-click "recompute" refreshes these without creating new versions.

---

## 5. Access

| Who | Can do |
|---|---|
| You, logged in (user ID in `cms_config`) | Everything, through RLS |
| `cms_owner` role | Migrations and server functions (AI jobs, imports) |
| App users, anon | Nothing: no grants on `cms`, RLS denies |
| Phase 8 Publish | Reads approved production versions only; the target design comes later |

---

## 6. Chapter file (JSON)

- One file per chapter: `content/<subject>/<chapter_id>.json`, with an Excel review copy generated from it.
- Shape: file header (schema version, attribute version, subject, class, chapter, generated-by) + optional `patterns[]` + `questions[]`.
- Each question carries a permanent `key` (MC19-0001). On re-import the key finds its MQ ID: unchanged → skipped; typo-only → typo fix; anything else → new draft version.
- The full schema is in `schema/chapter.schema.json`; the worked example is in `content/examples/MC19-example.json`.

---

## 7. How the seed loads (Phase 2; v10, then v11 on 10 Nov 2026)

| Source (v10 CSV / sheet) | Into |
|---|---|
| Master topic lists (Mac), until the D5 cut-over | cms_strands, cms_chapters, cms_topics |
| gold_concepts | cms_concepts, cms_concept_links, cms_concept_prereq_topics |
| misconceptions | cms_misconceptions |
| typical_sets | cms_typical_sets, cms_typical_set_concepts |
| strategy_types, insight_catalogue | cms_strategy_types, cms_insights |
| question_attributes, tagging_rubric, calibration_cases | cms_rule_versions (v10), cms_attribute_defs, cms_tagging_rubric, cms_calibration_cases |
| gold_questions, gold_wrong_answers | cms_questions (bank = gold) + version tables + cms_gold_meta |

All seed rows marked **draft** where v10 marks them draft.

**Later versions (v11, Sambit, 10 Nov 2026).** `npm run import:seed` takes the highest `WitoScope_Question_Attributes_vN.xlsx` in `QuestionBank/` (or `--file`), v10 or later:
- The rules (attribute defs, rubric, calibration cases) are keyed by rule version, so versions load **side by side**. `cms_config.current_rule_version` moves forward to the newest loaded version. Generate, tagging, the model check and the editor use that version.
- From the current or a newer workbook, catalogues are upserted as before. A gold question whose values changed gets a **new approved version**, following the versioning rule (logged as `new_version` with the field diff). A wording-only change is a typo fix in place. `cms_gold_meta` changes, such as Test only → Prompt example, are updated with an audit row. A gold question with an open draft is never overwritten.
- An older workbook loads only its own rules. Config, catalogues, gold and the current version stay as they are.
- Model-check scores count only the gold questions that are test-only *now*, earlier runs included. A question that became a prompt example is left out and named.

---

## 8. Importer checks beyond the schema (Phase 2)

| Check | Blocks import? |
|---|---|
| Every topic, set, pattern, concept, misconception, insight ID exists | Yes |
| Typical set's class = topic's class | Yes |
| At least one concept at involvement 1.0 | Yes |
| MCQ / T-F: correct answer is one of the options; every wrong option is tagged (except Achievers) | Yes |
| Strategy ≥ 2 needs strategy_type; Other needs a note; Strategy 2–3 on a taught topic | Warning |
| Solution 2 strategy = Smart calculation but type = Another way | Warning (v10 rule) |
| Visual ≥ 2 without a figure; WM ≥ 4 without "no writing" wording | Warning |
| Duplicate key in file; duplicate stem in bank | Yes / warning |

Errors are listed per question key, in plain words.

---

## 9. Decisions (approved 8 Nov 2026)

| # | Item | Decision |
|---|---|---|
| 1 | Browser access to `cms` | Expose `cms` in Supabase's API settings; RLS restricts it to Sambit's user ID |
| 2 | Versioning | Tags, signature values, topic / set / pattern moves and added images also create a new version (§3) |
| 3 | Gold questions | Same tables, `bank = 'gold'`; never publishable |
| 4 | Achievers topics | One row per chapter and class, ID `ACH-<chapter>-<class>` (e.g. ACH-MC19-6) |
| 5 | Strand IDs | Use the topic workbooks' IDs if they exist; otherwise `<subject>-<name>`. Check in Phase 2 |
| 6 | Formats | Typed split into Typed-number / Typed-decimal / Typed-fraction / Typed-text |
| — | Login | Sambit's existing Supabase account |
| — | Storage | ~~Supabase Storage bucket~~ → **Cloudflare R2** private bucket `cms-sources` (Sambit, 9 Nov 2026) |
| — | Book material (10 Nov 2026; rule restated the same day: CLAUDE.md "Book material rule" is the single source) | Only our own content leaves the Mac; AI threads may read the PDFs on the Mac, nothing book-derived is stored or uploaded outside it. No book PDFs, scans, screenshots, item text or item numbers in Supabase, R2 or any cloud; citations and official links only (migration 0015, logged in `cms_reviews` as `remove_book_material`). The originality check runs locally (`npm run check:originality`, PDFs read with `pdftotext`) before every import; `import:chapter` records its result. A **near-copy** (similarity ≥ `originality_near_copy`, 0.85, or the same distinctive numbers in the same order) **blocks** that question; moderate similarity (≥ `similarity_threshold`, 0.6, or the same numbers in another order) is a warning (migration 0016). A near-copy draft already in the CMS (e.g. from Generate) is approved only with "override: reviewed, not a copy" and a reason, logged as `override_near_copy` (migration 0017). No AI reads book pages; generation threads work from citations, topics, patterns and the v10 rules (`claude/question-bank/generation-prompt.md`). Phase 7 is re-planned local-only (`docs/phase7-plan.md`) |
| — | Files (9 Nov 2026; narrowed 10 Nov) | ~~All files (PDFs, scans, screenshots, figure images)~~ Only our own figure images (`figures/…`, PNG/JPEG/WebP) live in R2; Supabase keeps text, metadata and each file's R2 key (`storage_path`, `image_path`). Files are served only by the Pages Function `/api/files`: `sign` and `put` require a valid Cloudflare Access JWT (team keys, AUD, issuer, expiry, allowed email); `get` serves a file only with a 5-minute HMAC-signed link. The bucket is private and reached through an R2 binding (no R2 API keys); no list, no delete. Dev uses a local stand-in running the same code |
| — | pgvector | ~~Phase 6, installed into `cms`~~ → **not used** (Sambit, 9 Nov 2026): duplicate and copy checks are shared TypeScript (number sets + text similarity, threshold in `cms_config`); the copy-from-book check runs only on the Mac (10 Nov 2026) |
| — | AI calls (9 Nov 2026) | A Cloudflare Pages Function (`/api/ai/*`) behind Access, holding only the Claude API key; it returns drafts and the browser saves them through `cms_apply_save`. Bulk runs use the Batch API, tracked in `cms_jobs`. No Supabase Edge Function and no database credentials in the cloud. A model per task (generate, tag, extract; default `claude-haiku-5-5`), the refusal-fallback model, per-run limit (20), daily cap ($5), similarity threshold and prices live in `cms_config`; every request stays under 100K tokens (cached fixed rules + the topic's concept cards and relevant calibration cases); tokens and cost are logged per run in `cms_generation_runs` |
| — | Levels, classes, settings, clones (work queue 12 Nov 2026, D1–D4, D8; migrations 0020–0021) | **Level** (`cms_questions.level`, 1–6): the class a question is written for; not versioned, changed only by the updates importer or (later) the editor, audited as `import_update`. **Topic ↔ classes** (`cms_topic_classes`): the classes a topic is taught in besides its own `class`, with source and evidence. **Display rule:** a question shows in class N when its topic is in N and its level ≤ N (lower levels are revision; a higher level never shows lower); views `cms_question_classes`, `cms_topic_class_stats`. **Prerequisites** (`cms_topic_prereqs`): placeholder. **Setting** (`cms_settings`, SET###; `cms_questions.setting_id` + confidence + note): the story or context, one per question, not versioned. **Pattern rule:** a pattern is the pure maths skeleton plus every skill-changing constraint, never the story (`claude/question-bank/generation-prompt.md`, Generate's fixed rules). **Clone groups** are computed (`cms_question_list.clone_key`: same pattern + authored signature + concepts and involvement), never stored. Hierarchy: Topic → Typical set → Pattern → Clone group → Question (+ setting). The Math data thread's files are imported with `npm run import:updates` (local only) |
| — | The CMS owns the curriculum (D5, Sambit, 12 Nov 2026, option B; migration 0022) | Replaces "the topic workbooks are the source of truth; the CMS never edits them". See §2A and CLAUDE.md. Add / edit forms for chapters, topics (Achievers rows included), concepts, question types and patterns; IDs automatic and permanent; Retire, never delete; audit before → after; Export to Excel regenerates the three topic workbooks (Read me, Master Chapters, Master Topics, Class View, Achievers; the source-evidence sheets hold book text and are not in the CMS). One-time cut-over with `npm run curriculum:cutover -- --confirm` after the final workbook import; then `import:topics` / `import:sources` refuse. Sources (D7) are registered by every import (book files; chapter imports link the books their questions cite), added by hand on a chapter's Sources tab, and retired, never deleted (`cms_sources.status`); overview under Curriculum → Sources (S2, migration 0023) |

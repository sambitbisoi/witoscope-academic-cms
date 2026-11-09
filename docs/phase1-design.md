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
| Shared items (approved) | Login = your existing Supabase account · files in the private **Cloudflare R2** bucket `cms-sources` (changed 9 Nov 2026 from Supabase Storage; see §9) · `cms` added to exposed schemas **[default, not yet confirmed]** · pgvector later, installed into `cms`. |
| Explicit Save | No auto-save anywhere. |
| Book content is internal | Source refs, PDFs and screenshots never leave the CMS. The Publish step (Phase 8) can't read them. |

---

## 1. IDs

| Thing | ID | Example | Who assigns |
|---|---|---|---|
| Chapter / topic | MC##/MT####, SC##/ST####, GC##/GT#### | MC19, MT0393 | Master topic lists |
| Strand | `<subject>-<name>` **[guess: the topic lists may already have strand IDs]** | math-logical-reasoning | Topic import |
| Question | MQ######, SQ######, GQ###### | MQ000001 | CMS, on first import |
| File key | `<chapter>-####` | MC19-0001 | Generation thread; permanent, links the file row to its MQ ID |
| Gold question | G6-001 … | G5-007-a | Gold set only |
| Concept | `G{class}-{area}-C#` / `-A#` | G6-FRC-C1 | Author |
| Misconception | `G{class}-M-{area}#`; legacy MM### in `alias` | G6-M-FRC1 | Author |
| Typical set | `TS-G{class}-…` | TS-G6-FRAC-ADD-UNLIKE | Author |
| Pattern | MP####, SP####, GP#### | MP0007 | Author / generation |
| Insight | INS-… | INS-LAST-STEP | Author |
| Source item | N7-###, D5-### … | N7-031 | Source extraction |
| Release | integer, rising | 1, 2, 3 | Publish step |

All IDs are permanent and never reused. Class is a field, never inferred from an ID after creation.

---

## 2. Tables (all in schema `cms`)

### A. Curriculum (from the master topic lists)

| Table | Purpose | Key columns |
|---|---|---|
| `cms_strands` | Strands per subject (e.g. Logical Reasoning MC51–58) | strand_id, subject, name, sort |
| `cms_chapters` | Chapters | chapter_id, subject, strand_id, name, sort |
| `cms_topics` | Topics with Class View placement | topic_id, chapter_id, class, name, topic_kind (normal / achievers), taught_in_school (has NCERT or DAV source), source_flags (ncert, dav, ixl, imo / iso / ieo), status (active / retired) |

One "Achievers" topic row per chapter-class (topic_kind = achievers) **[guess: ID scheme for these rows; proposed `ACH-MC19-6`]**.

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

### D. Tagging rules (versioned)

| Table | Purpose | Key columns |
|---|---|---|
| `cms_rule_versions` | One row per workbook version | rule_version (v10…), notes, created_at |
| `cms_attribute_defs` | Question Attributes sheet | rule_version, attribute, group, meaning, values, needed_by_engine |
| `cms_tagging_rubric` | Per judged attribute | rule_version, attribute, definition, levels_anchors, rules, edge_cases, calibration_case_ids[] |
| `cms_calibration_cases` | Contested judgements | case_id, rule_version, question_id, attribute, first_value, final_value, why_wrong, rule |
| `cms_tagging_packs` | The cached AI prompt pack built from the above | pack_version, rule_version, content_hash, built_at (Phase 6) |

### E. Sources (internal only)

| Table | Purpose | Key columns |
|---|---|---|
| `cms_sources` | Books, links, screenshot sets | source_id, kind (pdf / scanned_pdf / web / screenshots), title, publisher (NCERT / DAV / IXL / SOF / other), class, storage_path (the file's **R2 key**, e.g. `NCERT-fegp101/fegp101.pdf`) or url, page_offset (printed page = pdf page − offset), captured_at |
| `cms_source_chapters` | Which part of a source covers a chapter | source_id, chapter_id, page_from, page_to |
| `cms_source_jumps` | "Open at" buttons | source_id, chapter_id, label, pdf_page |
| `cms_source_assets` | Screenshots | source_id, storage_path (R2 key), caption, captured_at |
| `cms_source_items` | Extracted book items (N7-031…) | ref_id, source_id, page, item_text, topic_id, pattern_id, numbers (json) for the originality check |

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

## 7. How the v10 seed loads (Phase 2)

| Source (v10 CSV / sheet) | Into |
|---|---|
| Master topic lists (Mac) | cms_strands, cms_chapters, cms_topics |
| gold_concepts | cms_concepts, cms_concept_links, cms_concept_prereq_topics |
| misconceptions | cms_misconceptions |
| typical_sets | cms_typical_sets, cms_typical_set_concepts |
| strategy_types, insight_catalogue | cms_strategy_types, cms_insights |
| question_attributes, tagging_rubric, calibration_cases | cms_rule_versions (v10), cms_attribute_defs, cms_tagging_rubric, cms_calibration_cases |
| gold_questions, gold_wrong_answers | cms_questions (bank = gold) + version tables + cms_gold_meta |

All seed rows marked **draft** where v10 marks them draft.

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
| — | Files (9 Nov 2026) | All files (PDFs, scans, screenshots, figure images) live in R2; Supabase keeps text, metadata and each file's R2 key (`storage_path`, `image_path`). Files are served only by the Pages Function `/api/files`: `sign` and `put` require a valid Cloudflare Access JWT (team keys, AUD, issuer, expiry, allowed email); `get` serves a file only with a 5-minute HMAC-signed link. The bucket is private and reached through an R2 binding (no R2 API keys); no list, no delete. Dev uses a local stand-in running the same code |
| — | pgvector | ~~Phase 6, installed into `cms`~~ → **not used** (Sambit, 9 Nov 2026): duplicate and copy checks are shared TypeScript (number sets + text similarity, threshold in `cms_config`) |
| — | AI calls (9 Nov 2026) | A Cloudflare Pages Function (`/api/ai/*`) behind Access, holding only the Claude API key; it returns drafts and the browser saves them through `cms_apply_save`. Bulk runs use the Batch API, tracked in `cms_jobs`. No Supabase Edge Function and no database credentials in the cloud. Model, per-run limit (20), daily cap ($5), similarity threshold and prices live in `cms_config`; tokens and cost are logged per run in `cms_generation_runs` |

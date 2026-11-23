# Plan: Q38 · Direct-to-CMS generation (Math + Science), 23 Nov 2026

> Phase 1 (plan only). No code, no migrations, no DB writes. Read-only queries on real only (as `cms_owner`, `begin read only`).
> **Approved by Sambit, 23 Nov 2026** (answers in §14). Key-registry audit: `docs/q38-key-registry-audit-2026-11-23.md`.
> PR 1 starts on Sambit's "go".
> Guessed or inferred points are marked **[inferred]**.

## Context
Today generated questions reach the CMS through ad-hoc import rounds: QuestionBank builds chapter files with keys it works out
itself (`existing_max` + `id_blocks.md`), and each round gets its own stage/run scripts (2026-11-18-dav-math/run.mts). That gave the
MC19-0039 collision and 87 stale bank keys. Science PILOT04 (76 questions, 62 passed, $7.04) has no CMS write path at all.
The goal is one engine with two routes (A: the CMS Generate button via the API; B: Claude Code on the Mac). Both routes write
through one pack import, and the CMS issues every key and ID.

## 0. What I found (read-only)

### 0.1 Step 0: 18 Nov follow-ups (OL-022), from real + cms_reviews
| Item | Status | Evidence |
|---|---|---|
| Override MC02-0308 | **done** | Request #64 approved 18 Nov 10:02, note "accidental numbers-only match — allowed (17 Nov decision)". Audit `override_near_copy` by Sambit (MQ004973 v1) |
| 33 DAV topic–class links | **done** | `cms_topic_class_proposals` source DAV: 33 active. 33 audit rows `edit_catalogue` "approved from the Proposed list" (10:02:04–12) |
| MC19-0039 re-key + import | **done** | The DAV item is now MC19-0071 = MQ006339 (MT0261, 10:06). Held-out #7 discarded with a note. MC19-0039 stays MQ002060 (the 13 Nov rewrite) |
| MC31-0137 set + MP6072 → MT0517 | **done** | MQ006223, TS-G6-POLYGON-ANGLE-SUM and MP6072 are all on MT0517 (audited 10:07, "Sambit (via CMS session)"). **Note:** MP6072 is still status *proposed* |

Real today:
- Questions: 6,328 Math production, 78 gold, 134 Science.
- 63 override requests pending; 3 Math held out (MC58-0051…53).
- `cms_generation_runs` and `cms_jobs` are empty.
- Sequences: `cms_mq_seq` 6339, `cms_sq_seq` 268. Highest pattern is MP6172.
- `ai_daily_cap_usd` = 5, `ai_model_generate` = Haiku 5.5.

### 0.2 Key-registry audit (read-only; real vs `QuestionBank/*/(MC|SC|GC)##-C#.json`)
| Check | Result |
|---|---|
| Bank keys / CMS file keys | 6,331 / 6,462 |
| Same key, same question (text = CMS v1 or current) | 6,240 |
| **Bank holds different text** | **87**: the 86 near-copy rewrites of 13 Nov (MC15 22, MC27 11, MC39 8, …), never written back to QB, plus MC50-0001 (Achievers slot, the known false positive). The 18 Nov audit's 88 included MC19-0039, which is now resolved |
| CMS key not in bank | 134 Science (SC48, never from QB) + 1 Math: MC19-0039 (QB NCERT-C6-07 still calls it MC19-0001) |
| Bank key not in CMS | MC19-0001 (same case) and MC58-0051…53 (held out) |
| Duplicate keys inside the bank | 0 |
| `_work/*/chapter_data.json` keys not yet built | 0 |

Risk:
- The bank's "next free key" only collides where the CMS holds a key the bank lacks. Today that is MC19 (bank max 0071 = CMS max; safe now).
- Field-level rewrites (hints, solutions; about 537) are **not detected** by a text-only compare. QB is stale there too **[inferred from the 18 Nov notes]**.
- Proposal: **the CMS text wins; QB is re-synced from a CMS export** (`npm run export:bank-sync`, which writes the current CMS version per key into QB chapter files and logs the diff). After cut-over, QB chapter files become read-only history.

### 0.3 What exists to reuse
- **Science import** (`scripts/lib/science-import.ts`):
  - `versionColumns` (S1 + drivers, l.343), `writeTags` (wrong-option tags, l.364), content-row links + primary rank (l.297–340), Solution 1 (l.293), `insertHeld`.
  - It is a single transaction with no checkpoints.
  - It also writes `topic_class_proposals`, row items and content rows. **The pack import must not do that.**
- **Math chapter import** (`scripts/import-chapter.ts`, `writeChildren` l.118). New questions get status `draft` (Science gets `in_review`).
- **CMS save path in SQL:** `cms_apply_save` (0041; create / new_version, Science fields, wrong tags, primary row, Solution 1), `cms_add_questions` (0046), `cms_save_science_review`. All are admin-checked, `security definer`, audited.
- **Provenance today:** `cms_question_versions.created_from` already allows `'generation'`, plus `run_id` and `import_id`. `cms_generation_runs` (kind `generate_similar|fill_set|chapter|tag`) and `cms_jobs` exist but are unused.
- **Phase 6 Generate** (`web/src/Generate.tsx`, `genApi.ts`, `functions/_lib/ai.ts`):
  - Math only, runs in the browser, drafts saved as `draft`.
  - Batch API support exists.
  - Jobs are collected by the browser (no DB credentials in the cloud).
- **Robustness:** `freshConnections` (`scripts/lib/db.ts`) for pooler drops; `migrate-guarded.ts`; `fingerprint.ts`; `backup-real.sh` / `rehearsal-restore.sh` (18 Nov).
- **Originality:**
  - `check:originality --pending` already writes `cms_originality_checks` and clears `originality_pending`.
  - Math uses `chapterCorpus`; Science uses `science-originality.ts` (OCR + cited PDFs).
  - The approval block is the trigger `cms_version_flags` (0042) plus the near-copy rule in `cms_set_status`.
- **Science engine** (ContentResearch/Science/generation):
  - Python, direct API (`api_client.py`).
  - Slot IDs are run-local (`PILOT04-ST0127-09`).
  - Linked rows and wrong-option tags are flat strings; Setting is free text; Grade is empty.
  - Approvals exist only in the pack xlsx (all 76 blank).
  - Prompts are unversioned inline strings (`writer_rules.txt` dump only).
  - Mirrored rules: `MIRRORED_RULES` in `run_pilot04.py:225–247` (21 rows).
- **Math pipeline** (QB `_pipeline`):
  - Claude Code workers follow `BRIEF.md` / DAV `worker_brief.md` → `chapter_data.json` → `build_chapter.py` under `_BUILD_LOCK`.
  - Keys come from `existing_max` (max+1 over bank files); catalogue IDs from `id_blocks.md` blocks (MP b×50; blocks 125–199 free; MP 4 digits only up to block 199).
  - Rules: v11 xlsx + `rules_pack.md`. The 17 Nov wrong-answer rule ("v12") exists only as prose.
  - The DAV and NCERT pipelines share nothing with Science on the engine side.

**Not on the Mac:** the OL-016/017/030/032 entries (`claude/witoscope-open-loops.md` isn't on the Mac); worked from the one-line
descriptions in the Q38 brief. The 23 Nov Science import-gaps answer was pasted by Sambit and is reconciled in §2.4.

**Discrepancy:** `runs/PILOT04/step3/step3_report.json` says `passed: false`. Inhibition is 57.9% exact and 94.7% within ±1 against a bar of 95; every other attribute passes. The brief says the tagger passed. See open question Q1.

## 1. Keys and IDs from the CMS only

**Principle:**
- Packs use **run-local IDs only**: `local_id` for questions; `new:<local>` for new patterns, typical sets, concepts and misconceptions.
- The **pack import mints the final IDs** inside its transaction with the existing CMS rules:
  - file key `<chapter>-NNNN` max+1 below 5000
  - MQ/SQ from the sequences
  - MP/SP and TS / concept / misconception rules as in `cms_save_curriculum` (0022)
- Nothing needs reserving for generated packs, and no collision is possible.

**For the book pipelines still building chapter files** (NCERT twins, DAV) during the transition:
- Migration 0048 adds `cms.cms_key_reservations`: id, kind (`file_key|pattern|concept|misconception|typical_set`), prefix (e.g. `MC19`, `MP`, `G6-GEO-C`), `first_no`, `last_no`, `purpose`, `reserved_by`, status `reserved|used|released`, `created_at`, and the audit row.
- Function `cms_reserve_keys(kind, prefix, count, purpose)`: admin JWT or `session_user = 'cms_gen_writer'`. It takes an advisory lock per (kind, prefix). The next number is greatest(max in table, max reserved) + 1, and it returns the range. It never reuses a number.
- All key-minting code (pack import, `cms_add_questions`, `cms_save_curriculum`, chapter import) also skips reserved ranges. One helper, `cms._next_no(kind, prefix)`, used everywhere.
- `build_chapter.py` calls `npm run keys:reserve -- --kind file_key --prefix MC19 --count 30 --purpose "DAV-C4 w_b125"` (QB hand-off) instead of `existing_max`. `id_blocks.md` becomes a **read-only mirror**, regenerated by `npm run keys:mirror` with a header saying so.

**Reconcile existing reservations:**
- A one-off script loads `id_blocks.md` blocks 0–124 as `used` / `released` rows (MP ranges, concept and misconception number spaces). Blocks marked "awaiting review" with unused numbers become `released`.
- MC keys already in the CMS need no rows, because max+1 already covers them.

**Registry audit as a command:**
- `npm run keys:audit` (read-only, the §0.2 script, no text in output). It runs before every import and in the run report.
- Stale-text policy: **the CMS wins, QB is re-synced** (§0.2).

## 2. Generation import ("pack mode")

### 2.1 Pack format `schema/generation-pack.schema.json` (`generation-pack/1`)
- **`run`:** `run_code` (CMS-issued, see 2.3), subject, route `A|B`, engine_version, prompt hashes per stage, models per stage, cms_commit, snapshot id/date, rule version, counts, cost, started/finished.
- **`catalogue_new[]`:** `{local_id, kind, fields}`. These arrive as Proposed.
- **`questions[]`:** `{local_id, topic_id, class, level, format, text, options[], answer, parts?, solution_1, solution_2?, hints?, figure?{file, sha256, width, height, alt}, checks{passed, warnings[{kind, reason}], warning_reason}, originality{result, similarity, closest_ref, tool, checked_at} | "not_checked", review{decision: approve|fix|drop|null, comment}}` plus a subject block:
  - **Science:** science_question_type, setting_id (SET###), setting_familiarity, hidden_idea, experiment; the 5 drivers (reading, steps, inhibition, visual, irrelevant_info); `linked_rows[{row_id, role: primary|secondary|supporting}]`; misconception `{row_id, item_no}`; `wrong_option_tags[{option, tag, row_id?, item_no?}]` (S7 tags as row items).
  - **Math:** everything `chapter.schema.json` carries today (typical_set_id / `new:`, pattern_id / `new:`, concepts, signature, duration, source_refs as citations only, tagging, parts, accepted answers).
- Derived values (tier, load, markers) are **not imported**. The CMS recomputes them (0042), and the importer warns when the engine's value differs.
- JSON is the input. xlsx is only the Mac review pack, whose decisions are read back by `local_id`.

### 2.2 Rules the import enforces
- It never adds, edits or flags content rows, topics, topic–class links or catalogue items that are not in the run's `catalogue_new`.
  (`import:science` flags every non-CMS row missing from its file, `science-import.ts:225-233`; the pack import has no such step.)
- It never matches on `cms_questions.source_qid` (unique across subjects, so a pack ID equal to an old Q ID would update or skip
  an unrelated question). It leaves `source_qid` null; identity is `(run_id, local_id)` only.
- Generated questions are always `bank = 'production'`. The pack import never creates gold (no `GS<class>-NNN` path).
- Linked rows, topics, settings and existing catalogue IDs must exist and be active. Otherwise the question goes to `cms_held_out` with `row_missing`, `topic_missing`, etc. (add codes `setting_missing` and `class_not_linked`).
- `catalogue_new` items are inserted as **proposed** (and `cms_catalogue_proposals` rows) with CMS-minted IDs. Question references are rewritten in the same transaction.
- Matching happens only inside the run: `(run_id, local_id)` is unique (2.3). There is no similarity matching against other imports. A clone of an existing question only gives a warning, which comes from the engine.
- Every version gets `created_from = 'generation'`, `run_id`, `import_id` and status `in_review` (Needs review, for Math too). Attributes are pending unless the pack carries them all. Originality is pending if `"not_checked"`.
- `source = generated (<run_code>)` is shown wherever the source shows today (detail, Browse column, export).
- Book rule:
  - `source_refs` and citations are citation-only shapes (db:verify).
  - A near-copy is never imported; it is listed in the run report only.
  - "flagged" imports with a warning.

### 2.3 Data model: migration `0047_generation_packs.sql` (schema `cms`, adds only)
- **`cms_generation_runs` add:**
  - `run_code text unique` (`GR0001`, CMS-issued)
  - `subject`, `route` (`A|B`), `engine_version`, `prompt_hashes jsonb`, `models jsonb`, `cms_commit`, `snapshot_id`, `rule_version`, `topics text[]`
  - `mode` (`pilot|steady`), `counts jsonb`, `cost_detail jsonb`, `review_pack_sha`, `import_id`, `finished_at`, `cancelled_at`, `rolled_back_at`, `note`
  - widen `kind` with `'pack'`
  - widen `status` to `planned|running|paused|generated|importing|imported|partial|failed|cancelled|rolled_back`
- **New `cms_generation_items`:**
  - `(run_id, local_id)` primary key
  - `question_id`, `version_id`, `batch_no`, `content_hash`
  - status `imported|held|dropped_near_copy|dropped_review|failed`
  - `held_id`, `warnings jsonb`, `warning_reason text`, `checks jsonb`, `review jsonb`, `imported_at`
  - This is the in-run map, the warnings store and the resume ledger.
- **`cms_imports.kind`** add `'generation_pack'`. **`cms_reviews.action`** add `gen_import`, `gen_rollback`, `gen_run_open`, `gen_run_close`.
- **`cms_held_out.reason_code`** add `setting_missing`, `class_not_linked`. Add `run_id` and `pack_item jsonb`, the question in pack format (generated held-out, OL-030; §9).
- **`cms_config`:** `gen_steady_state` (`{"science": {"6": false, …}, "math": {…}}`), `gen_batch_size` (10), `gen_run_cap_usd`, `gen_daily_cap_usd`.
- **Functions** (security definer, `search_path ''`; caller = admin JWT **or** `session_user = 'cms_gen_writer'`):
  - `cms_gen_open_run(p)` returns run_code.
  - `cms_gen_import_batch(run_code, items jsonb)` does one batch in one transaction:
    - per item: skip if `(run, local_id)` is already imported with the same hash; stop if it was imported with a different hash
    - otherwise mint IDs and write the question + version + children through the **same internal writer as `cms_apply_save` create** (refactored into `cms._write_new_version(...)`, not granted)
    - write the items row and the audit row
  - `cms_gen_close_run(run_code, counts)`.
  - `cms_gen_rollback(run_code, reason)` **retires** (never deletes) the run's questions that were never approved and never edited by hand. It retires Proposed catalogue items minted by the run and used by nothing else, and marks the run `rolled_back`. Anything approved or edited is listed and kept.
  - With one write function, the browser (Route A), the Mac (Route B / `gen:import`) and the held-out Place all write the same way.
  - **[inferred]** `cms_apply_save` covers every Science field we need. I verified Science fields, wrong tags, primary row and Solution 1. Secondary vs supporting roles and S7 row items are checked in PR 1, and any gap is closed in the internal writer.

### 2.4 Science: gaps, reconciled with the 23 Nov answer
Verdict of 23 Nov: `import:science` is **not safe for packs as is**. The pack import is a new path (`gen:import` → `cms_gen_import_batch`).
It reuses the Science validation and writer rules that already hold.

| Check (23 Nov answer) | 23 Nov verdict | Pack import (this plan) |
|---|---|---|
| CMS assigns keys | Supported | Same: SQ from sequence, `SC…-NNNN` chapter max+1 in the batch transaction (skipping reserved ranges, §1). The pack never supplies a CMS key |
| Collision risk (Q ID matched across subjects) | Partly | Closed: identity is `(run_id, local_id)`; `source_qid` is never read or set (§2.2) |
| `source = generated (run)` | Not | Closed: `created_from = 'generation'`, `run_id`, `import_id`, one `cms_generation_runs` row (0047) |
| S1 fields (type 1–5, familiarity, hidden idea, experiment) | Supported | Same validation (shared `versionColumns` rules) |
| S7 tags as row items | Supported | Same rules: misconception = an existing item on a linked row (`C6-04-014 #2`); concept_error = a linked row; untagged OK; **the correct option can't be tagged** (a tag on it holds that question) |
| 5 drivers | Supported | Same; a bad value holds only that question |
| Setting | Supported | Same: SET### must be an active Science setting. A missing or free-text setting holds the question (`setting_missing`). The engine must choose from snapshot SET ids |
| Setting group | Not | Still not in the DB; needs a definition first (§9, OL-016) |
| Linked rows with roles | Partly (direct/supporting only; CMS proposes the primary; no primary vs secondary in the file) | The pack carries `role: primary/secondary/supporting`. Mapping (Q4 accepted): primary → direct + primary; secondary → direct; supporting → supporting. The pack's own roles are kept in `cms_generation_items.checks.linked_rows`. **[inferred] Primary confirmation:** in pilot runs (`--approved-only`, Sambit approved in the Mac pack) the primary is confirmed (`rank = 'primary'`); in steady state it is written as `rank_proposed` and confirmed in CMS review (approval still needs a confirmed primary). All rows must already exist in the CMS (no rows from the file, Q5) |
| Solution 1 | Supported (no Solution 2) | Solution 1 required; optional `solution_2` written to `cms_version_solutions` slot 2 if present |
| Figures to R2 | Not | Closed in §2.5: upload first to `figures/gen/<run>/<local_id>.png`, verify size + sha256, then write `image_path`. Route A: image pending until the Mac sweep |
| Needs review status | Supported | Same: new = Needs review, attributes pending unless complete; near-copy never imported; unplaceable → Held out with `pack_item` |
| Originality | Supported (step) | Route B: every `local_id` needs a result in the pack, plus the report sha must match, or the import stops. Route A: `not_checked` → pending → Mac sweep (§3) |
| Small resumable batches | Partly (one transaction per file) | Closed: batches of 10, one transaction each, fresh connection, resume ledger (§2.6). No row-flagging step, so small batches are safe |
| `--from-excel` required | Required | Not used: pack mode reads JSON. `import:science` stays as is for the retired master |
| JSON input | Not | Closed: `generation-pack/1` JSON (§2.1); xlsx only as the Mac review pack |

**Field mapping from the engine** (PILOT04 `questions_checked.json` → pack; adapter `engine/adapters/science-pilot.ts`):
- slot ID (repaired `.r1` wins) → `local_id`
- Grade (empty) → `class`, written explicitly by the engine (topic core class or the run's target class)
- Primary / Secondary / Supporting row strings → `linked_rows[]`
- "Misconception targeted" `<row> #n` and the Wrong-option tags string → structured `{row_id, item_no}` and `wrong_option_tags[]`
- the drivers and S1 columns → as is
- derived Tier / Load / Markers / Trap → not imported (CMS recomputes, warning on mismatch)
- `_warnings` / `Warning reason` / `_type_warn` → `cms_generation_items.warnings` / `warning_reason`
- `_figure_file` → `figure` (+ sha256, size)
- xlsx Decision / Comment → `review`
- `_originality` → `originality`

### 2.5 Figures in the same step
1. Validate each figure:
   - Math size rule (18 Nov): SVG `viewBox` + `preserveAspectRatio`, width ≥ 900, PNG ≥ 1800 px, plus the protractor rules where `figure_kind` applies.
   - Science: PNG ≥ 1800 px wide **[inferred; same rule proposed]**.
   - Either: PNG/JPEG/WebP ≤ 50 MB (`functions/_lib/files.ts`).
2. **Upload first**, to `figures/gen/<run_code>/<local_id>[-A..D].png` (stable before keys exist, so no rename), with the `upload-figures` code path (wrangler, 5 at a time, retry once).
3. Verify size + sha256 (`--verify`).
4. Then the DB batch writes `image_path` to that key. A failed upload means the item isn't imported in this pass and is retried on re-run.
- R2 never gets a DB reference to a missing file. An orphan uploaded file is harmless and is listed by `--verify`.

### 2.6 Batches, resume, rollback
- `npm run gen:import -- --run GR0012 --pack <file> [--approved-only <review.xlsx>] [--dry-run] [--confirm-real]`.
- Batches of `gen_batch_size` (10). Each batch is **one transaction on a fresh connection** via `freshConnections`, with one retry after ending the orphan session (real-pooler rule).
- A pooler drop or usage pause rolls back only the open batch. Re-running continues from `cms_generation_items` (idempotent by hash).
- The run status moves `importing → imported` or `partial`.
- Rollback: `npm run gen:rollback -- --run GR0012 --reason "…"` calls `cms_gen_rollback`.

### 2.7 Pilot vs steady state
- `cms_config.gen_steady_state[subject][class] = false` (default): import **refuses** unless `--approved-only` is given. Only rows Sambit marked Approve in the Mac pack are imported (pack sha recorded on the run). Fix and Drop are reported.
- Sambit flips a subject+class to steady state in the CMS (Settings, "More"). From then on, everything that passed checks lands as Needs review, and review happens in the CMS (§7).
- Route A always lands as Needs review. It is allowed only for subject+class pairs in steady state.

## 3. Book rule
- Book text, extracts, OCR and the originality checker stay on the Mac. Packs carry only our questions, citations and scores.
- **Route B** runs originality before writing: the engine step `originality` reuses `shared/originality.ts` + `science-originality.ts` / `chapterCorpus`.
  - The pack carries the result and the report sha.
  - The import refuses a pack whose report sha doesn't match.
  - Near-copies are dropped (reported).
- **Route A** cannot check, so `originality: "not_checked"` → `originality_pending = true`. The existing trigger already blocks approval.
- **Mac sweep:** `npm run check:originality -- --generated [--run GR0012] [--since …]`.
  - It extends `--pending` to Science (row citations → OCR/PDF corpus) and to Math topic chapters.
  - It writes `cms_imports` kind `originality`, one `cms_originality_checks` row per version, clears `originality_pending`, adds a `cms_reviews` row, and updates `cms_generation_items.warnings` (kind `originality_flagged`).
  - A near-copy stays blocked by the `cms_set_status` rule (override flow as today). It is listed on the run page as "near-copy: rewrite or retire".
- The CMS shows "Originality: not checked — run the Mac sweep" on the run page and on each question, with a copy-command button.

## 4. Shared engine
- **Location:** a repo package, `engine/` (TypeScript, shared by Node on the Mac and Cloudflare Workers, like `shared/`). It holds no book material: only our rules, prompts and schemas.
  - `engine/stages/<subject>/<stage>.md`: prompt templates with front-matter `id`, `version`, `model_default`, `effort`.
  - `engine/schemas/`: output JSON schemas per stage (writer, tagger, solver, quality, repair, figure).
  - `engine/checks/`: deterministic checks (port of `checks.py` + `code_checks()` + Math `build_chapter.py` checks, many already in `scripts/lib/chapter/*`).
  - `engine/blueprint/`: slots per topic, type mix, setting rotation, gap check, coverage flag (OL-017).
  - `engine/pack/`: pack builder + review-pack xlsx (exceljs).
  - `engine/executors/api.ts` (Claude API; Mac or Worker) and `engine/executors/claude-code.ts` (prompt files out, JSON in, for Route B).
- **Rules source:** a read-only CMS snapshot (`engine snapshot`, using the new `cms_reader` role): topics, rows, items, settings, catalogue, attribute rules for the current rule version.
  - The v12 wrong-answer prose moves into the prompt files and rules.
  - `engine_version` = package version + git commit. Each stage's prompt hash is stored on the run, so any rule fix is one commit that reaches both routes.
- **Science Python → TS:**
  - Port in PR 7 with a **parity test**: re-score PILOT04's saved outputs (`gen/`, `tag/`, `solve/`, `quality/`) with the TS checks and expect the same pass/fail and warnings per slot.
  - Python stays as frozen reference (read-only) until parity holds. No new Python features.
- **Math:**
  - The DAV-gen worker brief becomes `engine/stages/math/*` (topic/blueprint-driven new questions).
  - The NCERT twin pipeline (book-item driven) stays in QuestionBank for now. It emits `generation-pack/1` via a `collate`-side exporter and uses `keys:reserve` only if it still needs keys. One import path either way.
- **Mirrored rules:** `engine/rules/<subject>/mirrored.yaml`. Each writer rule id lists the checker clauses (quality, solver, code/tagger) that judge the same property.
  - `npm run engine:check` (in `npm test`) fails if a writer clause hash changes without its mirrored clauses being touched or re-acknowledged.
  - The review pack keeps the "Mirrored rules" tab, generated from the YAML.

## 5. Route A: CMS "Generate" (API)
- **UI:** Topic workspace / Browse → "Generate". Pick topics (multi), class filter, count per topic, question types, model (default Sonnet 5.5 writer/tagger, Haiku solver), Batch API on/off. The estimated cost is shown before Start, with an explicit Start button.
- **Runtime:** a separate Worker `witoscope-cms-gen` with **Cloudflare Workflows** (durable steps, `step.sleep`, built-in retries with exponential backoff).
  - It has no public route, so it is reached only through a service binding from the Pages Function `/api/gen/*` behind Access (Access JWT checked as in `functions/_lib/access.ts`).
  - One Workflow instance per topic, 3–5 at a time (run-level semaphore).
  - Fallback if Workflows doesn't fit: Queues + a Durable Object state machine.
  - **[to verify]** current Workflows step/CPU/state limits before PR 9.
- **No DB credentials in the cloud** (unchanged rule):
  - The browser opens the run (`cms_gen_open_run`) and sends the topic snapshot (our own rows and rules) in the payload.
  - The Workflow keeps stage outputs in its own step state.
  - The browser collects completed topics while the CMS is open (Run page or Home Jobs tile, polling) and writes them with `cms_gen_import_batch` as admin.
  - Questions land when Sambit next opens the CMS. Collection is idempotent.
- **Figures:** Route A has no rasteriser. It marks figure questions **image pending** with the SVG kept in the pack item. The Mac sweep (§3) renders the PNG, uploads it and clears the flag (`--generated --figures`). A later option is resvg-wasm in the Worker.
- **Spend:**
  - Per-run cap (`gen_run_cap_usd`) and per-day cap (`gen_daily_cap_usd`), enforced in the Worker with a Durable Object spend ledger before every call, and checked in the browser before Start.
  - Hard backstop: the API key belongs to **its own Anthropic workspace "WitoScope CMS gen" with a workspace spend limit**, stored as a Worker secret. The Pages Function keeps no key once `/api/ai` moves behind the same Worker.
- **Batch API option:** each stage is submitted as one batch per run (50% price), the Workflow sleeps and polls, with no fallback (as today). Default is on above 40 questions.
- **Progress view:** the Run page shows each topic × stage, counts, spend, warnings so far, ETA. **Cancel** terminates the Workflow instances. Collected questions stay; "Roll back run" is offered.

## 6. Route B: Claude Code on the Mac
- **Skill:** `.claude/skills/generate/SKILL.md` in the repo, plus `engine/cli.ts`. Input: topic IDs, or `--chapter SC04 --class 6`, plus count and types.
- **Flow:**
  1. `engine plan` snapshots via `cms_reader`, opens the run via `cms_gen_writer` (`GR0012`), writes the blueprint plus the run folder `~/WitoScope/ContentResearch/Generation/runs/GR0012/` (outside the repo).
  2. Per stage: `engine prompts --stage write` writes prompt files. The skill runs 3–5 Agent workers in parallel (writer and tagger on **Sonnet 5.5**, as used in the calibration re-check; solver on **Haiku 5.5**; quality on Sonnet), and each writes JSON.
  3. `engine ingest --stage write` validates against the stage schema and re-asks once.
  4. `engine checks`, then `originality` (Mac), then `pack` (JSON + review xlsx), then `gen:import` (pilot: `--approved-only`).
- **Resumable:** `state.json` per slot × stage (output file exists = done, as PILOT04). A usage-limit pause stops between slots and `engine resume GR0012` continues. Nothing is written to the CMS until `gen:import`.
- **Tagger:** uses PILOT04's `build_tagger v0.4` prompt. Inhibition (57.9% exact) is shown as a known weak field in the pack (open question Q1).

## 7. Review in the CMS
- **Browse / Review queue:** a new filter **Run** (`logic.ts` `Filters` + `FLAG_FILTERS` gets `generated`; dropdown of run codes). The source column shows "generated (GR0012)".
- **Run summary page** `#/runs/GR0012`:
  - counts (planned / generated / passed / imported / held / dropped near-copy / dropped in review)
  - pass/fail by check, warnings by kind
  - cost (per stage, per question), models, engine version, CMS commit, rule version
  - originality status, buttons (collect, cancel, roll back), and links to the filtered Review queue
  - Runs list on the Imports page.
- **Question detail:** a "Generation" panel with run, local ID, warnings with "Warning reason" and check summary. It extends `PendingBanners`/`approvalBlockers` to `created_from='generation'`. Science review warnings stay "never block approval".
- Screens: screenshots first (rule).

## 8. Security and hygiene
- **Roles** (created by a one-off `scripts/roles-setup.ts`, local first, then real by Sambit's command, since migrations can't create roles):
  - `cms_reader`: SELECT on `cms` only (OL-032). Used by the engine snapshot, `keys:audit` and reports.
  - `cms_gen_writer`: no table rights; EXECUTE only on `cms_gen_open_run`, `cms_gen_import_batch`, `cms_gen_close_run`, `cms_reserve_keys`. It is the Route B write path.
  - `cms_owner` stays for migrations and admin scripts.
  - `db.ts connect()` accepts these three users only.
  - `grants.ts` / `db-verify` / `tests/rls.db.test.ts` are extended. **[to verify]** that check-sql R-rules allow `grant … to cms_reader` (they bar anon/public/service_role only).
- Every write is audited in `cms_reviews` (by_label `gen:<run_code>`, `import_id`).
- `.env.real.reader` / `.env.real.genwriter` live on the Mac only. Secrets are never in the repo.

## 9. Small related items
| Item | Proposal |
|---|---|
| Setting group (OL-016) | **Defined 23 Nov (§14).** PR 10: `cms_setting_groups` (SG01…, name, status) + `cms_settings.setting_group_id`, edited on the Settings screen through the curriculum save pattern; the engine rotates settings by group. Until then, the writer prompt keeps its rotation text |
| Coverage flag (OL-017) | **Include (PR 10):** read-only query "topic linked to class N with no content rows of class N". Badge on the topic screen + Coverage; the engine blueprint skips such topic×class pairs with a warning |
| Held-out generated (OL-030) | **Include (PR 1):** held items keep `pack_item`. Place works in the CMS (Held-out screen → `cms_place_held_out` calls the same internal writer with the pack item), so there is no Excel-only path for generated Science. The old master-sourced Science held-out keeps its current path |

## 10. Safety
- **Backups:** `backup-real.sh <label>` (`pg_dump -n cms`) before every import into real while in pilot, and daily in steady state.
- **Rehearsal:**
  - The first run per subject × class goes in order: local, then `cms_rehearsal` restored from a fresh dump (`rehearsal-restore.sh`), then `keys:audit` + `db:verify` + row-diff (`fingerprint`/`rowsnap`), then real.
- **Straight to real is allowed** only when all of these hold:
  - the subject × class is in steady state
  - a previous run for it imported cleanly
  - the run is ≤ 200 questions and has no new catalogue kinds
  - `--dry-run` on real passes (rolled back)
- **Stop conditions:** the import or the run stops when any of these happen:
  - pass rate < 60% after the first 20
  - spend > cap
  - any import error that isn't a pooler drop
  - two drops in a row
  - `db:verify` fails
  - a near-copy rate > 5%
  - a hash mismatch on re-run
- **One CMS session at a time:**
  - Table `cms_work_lease` (single row: holder, kind `route_a_collect|gen_import|cms_session`, since, heartbeat, expires 15 min).
  - Functions `cms_take_lease` / `cms_release_lease`.
  - `gen:import`, real-data scripts (opt-in helper in `db.ts`) and Route A collection all take the lease. Route A Workflows themselves generate freely (they write nothing).
  - The CMS shows "Mac import running — collection paused".

## 11. PR split (build order), effort
| # | PR | Contents | Effort |
|---|---|---|---|
| 1 | **Science pack import** | 0047; pack schema (Science profile); `cms_gen_*` functions with the refactored internal writer; `gen:import` / `gen:rollback`; PILOT04 adapter + `--approved-only` xlsx reader; figure upload-first; held-out `pack_item` + Place; tests (local DB, re-run idempotency, pooler-drop simulation, rollback) | 3.5 d |
| 2 | Roles + lease | `roles-setup.ts`, `cms_reader`/`cms_gen_writer`, `db.ts`, grants/db-verify, `cms_work_lease` (0048a) | 1 d |
| 3 | Key registry | 0048 `cms_key_reservations`, `_next_no` everywhere, `keys:reserve`, `keys:mirror`, `keys:audit`, id_blocks import, `export:bank-sync` | 1.5 d |
| 4 | Review in CMS | Run filter, Run page, Generation panel, warnings (screenshots first) | 2 d |
| 5 | Math pack import | Math profile (parts, options, hints, concepts, `new:` patterns/sets/concepts/misconceptions → Proposed), Math figure rule check | 2 d |
| 6 | Originality sweep | `check:originality --generated` (Math + Science), `--figures` render/upload | 1 d |
| 7 | Engine + Route B | `engine/` package, Science TS port + PILOT04 parity, mirrored-rules check, skill + CLI, review xlsx | 5 d |
| 8 | Math engine adapter | DAV-gen brief → `engine/stages/math`, checks from `build_chapter.py`, NCERT-pipeline pack exporter | 3 d |
| 9 | Route A | gen Worker + Workflows, `/api/gen`, spend ledger, Batch option, Generate/progress/cancel UI, browser collect; Phase 6 Generate reuses it | 5 d |
| 10 | Small items | Setting groups, coverage flag | 1 d |

Total ≈ 25 working days. PR 1 alone lets Science production import PILOT04-style runs (approved-only) right away. It uses `cms_owner` until PR 2 lands, and the function already accepts both.

## 12. QuestionBank-side hand-off list (do not edit from here)
1. `build_chapter.py`: replace `existing_max` with `keys:reserve` (or emit packs; then no keys at all). Drop `_BUILD_LOCK` key serialisation, the "null twin.key" rule and the `merge.py` key reset.
2. `id_blocks.md`: becomes a read-only mirror (`keys:mirror`). Rewrite BRIEF step 10 and the HANDOFF key sections.
3. Catalogue validation reads the CMS snapshot (approved + proposed) instead of the v11 xlsx + local proposals. TS-name uniqueness is checked against the CMS.
4. Re-sync QB from the CMS:
   - MC19-0001 → MC19-0039 in NCERT-C6-07
   - the 86 rewrite keys + field-level rewrites
   - mark the 78 gold keys as reserved
5. `realbuild.sh` collision check becomes `keys:audit`. `progress_log.md` gets run codes.
6. Science generation: freeze the Python engine after parity. Future runs go through `engine` / skill. HANDOFF-PILOT04 points to this plan.
7. Write the v12 wrong-answer prose into the rules (engine prompts) and bump `attribute_version` when Sambit names it.

## 13. Open questions (my proposal in **bold**)
- **Q1** The tagger re-check shows `passed: false` (inhibition 94.7% within ±1, bar 95). **Accept it for pilot runs, with inhibition shown as "check" in the review pack; re-calibrate after 2 runs.**
- **Q2** Route A lands questions only when the CMS is open (browser collects; no DB credentials in the cloud). **Keep the rule; no cloud DB credential.**
- **Q3** Generated Math status: today the chapter import uses `draft`. **Needs review (`in_review`) for both subjects.**
- **Q4** Engine primary / secondary / supporting → CMS direct+primary / direct / supporting. **Yes.**
- **Q5** New content rows proposed by a run: **not created by the import; the question is held `row_missing` and the row is added in the CMS, then Place.**
- **Q6** Rollback = retire (never delete) unapproved, unedited questions of the run. **Yes.**
- **Q7** Where the engine lives: **repo `engine/` (TS); Python frozen after parity.**
- **Q8** Route A figures: **image pending, rendered by the Mac sweep.**
- **Q9** Stale QB text: **the CMS wins; QB re-synced by export.**
- **Q10** Separate Anthropic workspace + spend limit for Route A; caps **$15 per run / $25 per day** to start (PILOT04 = $0.09 per question).
- **Q11** The 23 Nov "Science import gaps" answer: **reconcile it with §2.4** (done, see §14).

## 14. Decisions (Sambit, 23 Nov 2026)
- **Q1:** The step3 bar is outdated. DL-028 sets the ±1 bar at 90% for n = 19 (one miss allowed), so inhibition at 94.7% within ±1 **passes**. Fix the bar in `tagger_claude_code.py` score (ContentResearch side, hand-off item 8). Keep inhibition exact shown as "check" in the pack.
- **Q2–Q10:** the proposals are accepted.
- **Q11:** reconcile §2.4 with the 23 Nov gap answer. **Done:** §2.4 now lists each check with its 23 Nov verdict and how the pack import closes it. Added rules: no `source_qid` matching, no gold, no tag on the correct option, primary confirmed in pilot runs and proposed in steady state **[inferred]**, Setting group needs a definition first.
- **Clone check:** the engine snapshot includes, per topic, the existing CMS questions (current version text, options, answer, primary row, type, setting) **and the gold questions**, for the duplicate/clone check as in PILOT04 (`checks.py` similarity vs existing + gold; an in-run clone is an error). It is our own wording only, read via `cms_reader`.
- **Build order:** 1→10. **Checkpoint after PR 4**: report to Sambit and wait for his review before PR 7 and before PR 9.
- One CMS session at a time. PR 1 starts on "go".
- **Primary row (23 Nov, later):** keep it as planned. Pilot runs (`--approved-only`) write a confirmed primary; steady state writes it as `rank_proposed`, confirmed in CMS review.
- **Setting group definition (23 Nov, for PR 10):** a broad family of everyday settings, used to spread settings across a topic's questions. Each setting belongs to exactly one group. Start with about 10–15 groups, e.g. Food & cooking, Home & chores, Play & sport, Garden & plants, Travel & transport, Weather & seasons, Body & health habits, School & classroom, Nature walk & animals, Market & shopping, Festivals & gatherings, Science activity. Claude proposes a group for each existing setting; Sambit approves in the CMS (groups and assignments start Proposed).
- **"go" for PR 1** given 23 Nov.
- Hand-off item 8 (QB/Science side): update the step3 bar to DL-028 (±1 ≥ 90% at n = 19).

## Verification (when built)
- `npm test`, `npm run typecheck`, `npm run check-migrations`, `npm run test:db` (new: pack import idempotency, batch rollback on a killed connection, rollback by run, role grants, lease).
- PILOT04 dry run on local, then on `cms_rehearsal`. `keys:audit` + `db:verify` + row diff show only the run's rows changed.
- Engine parity: TS checks on PILOT04 saved outputs = Python results per slot.
- Route A: fake-AI executor (`scripts/lib/fake-ai.ts`) end-to-end on local Wrangler, plus one tiny real run (1 topic × 3) with the cap set to $1.

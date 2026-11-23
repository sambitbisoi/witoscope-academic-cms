# Generation pack format (`generation-pack/1`)

This is for whoever builds generation runs (the Science and Math engines, Route A and Route B). It covers how a run's questions get into the CMS. Design: `docs/plan-2026-11-23-q38-direct-generation.md` §2. Schema: `schema/generation-pack.schema.json`.

## Rules
- **Our own content only.** Never include book text, extracts or book numbers. Originality goes in as a result, a score and a bare citation (`closest_ref`).
- **Run-local IDs only.** `local_id` must be unique in the run, e.g. `PILOT04-ST0127-09`. The CMS mints the question ID (SQ…), the file key (`<chapter>-5001…`) and the setting IDs (SET…). A pack never carries CMS keys.
- **One live CMS run per engine run** (`run.source_run`). Re-importing the same pack continues that run. An item imported before with the same content is "unchanged". An item imported before with different content is "changed" and never touched.
- **Linked rows, topics and settings must already be in the CMS** (or be new settings of the run). If one is missing, the question is held out, and you place it from the Held-out area once the CMS has it. New settings go in `catalogue_new.settings` and arrive as Proposed.
- **The import never adds, edits or flags** content rows, topics, topic–class links or catalogue items outside the run.

## Route B (Mac) checklist
1. Run the originality check on the Mac. Every question needs a result, and a near-copy is never imported.
2. Make the pack. For a PILOT04-style folder, run `npm run gen:pack-pilot -- <run folder>`.
3. Pilot runs: Sambit marks Approve, Fix or Drop in the review pack (Questions tab) and Rescue in the Failed checks tab.
4. Dry run on the target, then import:
   ```
   npm run gen:import -- --pack <run>/generation-pack.json --review <review pack.xlsx> [--dry-run]
   ```
   For the real project, use `npx tsx --env-file=.env.real scripts/gen-import.ts …`. Run it with `--dry-run` first, then again with `--confirm-real`.
5. Steady state: once Sambit switches `gen_steady_state` on for the subject and class, run with `--mode steady`. Everything that passed the checks lands as Needs review.
6. To undo a run: `npm run gen:rollback -- --run GR0001 --reason "…"`. It retires questions; it never deletes them.

## Field mapping (Science)
| Pack | CMS |
|---|---|
| `class`, `level` | `cms_questions.class` = the topic's home class; `level` = the class of the question's **primary row** (DL-011), taken from the CMS row. `class` is the class the question is for: if the topic isn't linked to it, the question is imported and the link is **proposed** |
| `linked_rows[{row_id, role}]` | primary → direct + primary (confirmed in pilot runs, proposed in steady state) · secondary → direct + secondary · supporting → supporting + context |
| `misconception {row_id, item_no}` | `misconception_row_id` / `_item_no`. It must be an item on a linked row |
| `wrong_option_tags[]` | `cms_version_wrong_answers`. A misconception tag needs an item on a linked row; concept_error needs a linked row as target; the correct option is never tagged |
| `science_question_type`, `setting_familiarity`, `hidden_idea`, `experiment`, `drivers.*` | version columns. Attributes stay pending until all five drivers are set |
| `setting`, `setting_note` | `setting` is `{setting_id}` (an existing setting: a Math SET becomes shared, subject `both`, audited), `{new}` (from `catalogue_new.settings`, Proposed), or null (bare). `setting_note` is the specific scene, kept on every question as its setting note (DL-007). The mapping of scenes to SETs is a reviewed `settings-map.json` (`gen:pack-pilot --draft-settings-map`, then `--settings-map`) |
| `solution_1` (+ `solution_2`) | `cms_version_solutions` slots 1 and 2 |
| `figure {file, sha256}` | PNG, at least 1800 px wide. It is uploaded to R2 as `figures/<run>-<local_id>.png` and verified before its batch is written. With `figure_needed` but no figure, the question is marked "picture pending" |
| `originality` | a `cms_originality_checks` row. `"not_checked"` (Route A) leaves originality pending, and approval is blocked until the Mac sweep has run |
| `passed`, `warnings`, `warning_reason`, `checks`, `review` | `cms_generation_items` (shown in review). Derived values (tier, load, markers) are recomputed by the CMS |

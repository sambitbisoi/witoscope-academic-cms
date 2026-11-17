# Science import format (Questions tab)

Written for the Science generation thread and for `npm run import:science`. Round 2, Q34 (Sambit, 17 Nov 2026, decision §10.11 of `docs/plan-2026-11-17-round2.md`).

The Science file is the workbook `import:science -- <file.xlsx> --from-excel` reads: tabs **Content**, **Questions** and **Legend**. The Content and Legend tabs are unchanged. This page covers the **Questions** tab.

**Book rule (CLAUDE.md):** every cell is our own wording. Book references are bare citations only (`Taught in`: book short name + pages). No book text, scans or page images go in the file. The originality check runs on the Mac before every import (`npm run check:originality -- --science`). A near-copy is blocked.

## Required columns (unchanged)

`File` · `Class` · `Q ID` · `Content row ID(s)` · `Direct row ID(s)` · `Topic ID` · `Row class` · `Row type` · `Level` · `Format` · `Question` · `Option A` · `B` · `C` · `D` · `Answer` · `Explanation` · `Misconception targeted` · `Picture needed (Y/N)` · `Image brief (question)` · `Image briefs (options)` · `Safety note` · `Taught in` · `Confidence` · `Notes`

- **Level** is the retired authored tier (L1–L3). It may now be **blank**. When given, it is kept read-only as the legacy tier (Q27). New files should leave it blank and set the Science question type.
- **Explanation** becomes Solution 1. Approval needs it.

## Optional columns (Q34): a file without them imports exactly as before

| Column | Values | Stored as |
|---|---|---|
| `Science question type` | `1`–`5`, optionally with its name: 1 Fact · 2 Basic understanding · 3 Curiosity/application · 4 Achiever · 5 Super Achiever | `science_question_type`. Required before approval (not for import). Sets the stored tier: 1–3 School · 4 Achiever · 5 Super Achiever |
| `Setting` | A SET ID of a **Science** setting already in the CMS (e.g. `SET0123`). Blank = bare | `cms_questions.setting_id`. An unknown or Math setting blocks that question |
| `Setting familiarity` | `Bare` · `Everyday` · `Less familiar` · `Rare` | `setting_familiarity` (Rare counts as a marker). Keep Bare ⇔ no setting (a review warning otherwise) |
| `Hidden idea (Y/N)` | Y / N | `has_hidden_idea` (Y counts as a marker) |
| `Experiment (Y/N)` | Y / N | `has_experiment` |
| `Tag A` … `Tag D` | One per option, blank = untagged (fine: v12 "tag where confident"). One of the 9 tags: `misconception`, `concept_error`, `shortcut`, `partial`, `lost_step`, `used_irrelevant`, `misread`, `unit_slip`, `implausible`. **misconception** names its row item: `misconception C6-04-014 #2` (an item of one of the question's content rows). **concept_error** names one of the question's content rows: `concept_error C6-04-002` | `cms_version_wrong_answers` (`mc_row_id`/`mc_item_no` or `target_row_id`). The correct option takes no tag. When any Tag column is present, the file's tags **replace** that question's tags. When none is present, the tags are left as they are |
| `Gold use` | `Prompt example` · `Test only`. Blank = production | A **Science gold** question, ID `GS<class>-NNN`, never published, with its gold Use. A question never changes bank: a production question marked gold (or the other way round) is skipped and reported. The Use of an existing gold question is updated (audited) |

## What the import does with them

- **New question:** written with the fields above; status *Needs review*; attributes pending until Reading, Steps, Inhibition, Visual and Irrelevant info are set in the CMS.
- **Changed question:** replaced only while it is an unedited imported draft (as before), now with these fields. A question edited in the CMS is kept, and reported as skipped.
- **Derived in the CMS, never imported:** Tier (from the type), Markers, Load, Trap level, Clone group (primary row + type + setting).
- **Blocked** (listed in the report, nothing written for that question): near-copy, unknown setting, or a misconception item that is not an item of its rows. The file check itself (before anything is written) reports any bad value in these columns, with the row number.

## Not yet

- A coverage view per content row / topic (questions by type and tier): noted in `docs/backlog.md`.
- The Reading / Steps / Inhibition / Visual / Irrelevant-info columns: still set in the CMS (Edit). Ask if the Science thread should send them too.

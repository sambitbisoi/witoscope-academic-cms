# Plan: English (Grammar) in the CMS, 28 Nov 2026

> Plan only: no code, no migrations, no DB writes. Read-only checks on real ran as `cms_reader`.
> Inputs:
> - `docs/grammar/grammar-handoff-2026-11-28.md`, `docs/grammar/cms-queue-grammar.md` (Q39, Q40, Q41; F1 and F2 are design notes only), `docs/grammar/english-question-attributes.md`.
> - `~/WitoScope/ContentResearch/English/WitoScope_English_Grammar_2026-11-28.xlsx` (sheet revision 30).
>
> Built on Q38 PR 1b–3 (0050–0052, all on real). Guessed or inferred points are marked **[inferred]**. Open questions have my proposal in **bold** (§9).
> Companion files in `docs/grammar/`:
> - `new-id-mapping-2026-11-28.csv` (NEW-xx → GT IDs, for updating the sheet);
> - `regional-review-2026-11-28.csv` (regional flags and item rules to decide).

## 0. What I found (read-only)

### 0.1 The workbook
| Check | Result |
|---|---|
| Topic map, in scope (rows 2–194) | **193 topics** = 184 GT + NEW-01…NEW-09 (green rows 21, 93, 123, 132–134, 154, 173, 194). Sambit, 28 Nov: 193 active; GT0011 stays retired; NEW-01…09 → GT0186–GT0194 |
| Topic map, out of scope | rows 195–223 (purple) = Reading: GC42–GC48, RD-01…RD-29 (F2, not synced) |
| Concepts | **566**, all unique, IDs `GTxxxx-Cnn` (543) or `NEW-xx-Cnn` (23). Every in-scope topic has concepts (193). Column O is "Proposed" on all 566; the catalogue was accepted by Sambit (column O review waived 28 Nov) |
| Concept columns | A ID · B Topic ID · C Topic · D Concept · E Rule · F Examples · G First taught (1–6) · H Classes (list, e.g. "3, 4, 5") · I Frequency (Common 419 / Less common 147) · J Exception (Y 145 / N 421) · K UK/India vs US (filled **88**) · L Misconceptions (all 566 filled; **600 items**: 532 with one, 34 with two separated by ";") · M Secondary topics (310 filled, GT IDs) · N Source · O Review · P Check notes · Q Notes |
| Tick cells | "✓" or empty |

### 0.2 Sheet vs real CMS (exact diff)
Run read-only as `cms_reader`; the diff matches Q41 exactly.
| Change | Topics |
|---|---|
| Add (9) | NEW-01…09, all in **existing** chapters (GC04, GC20, GC27, GC28 ×3, GC33, GC37, GC41) |
| Rename (3) | GT0062 "Adverbs of Frequency" → "Adverbs of Frequency, Degree and Certainty" · GT0111 "Capitals for Nationalities and Languages" → "…, Languages and Events" · GT0143 "Animals and Their Young Ones" → "Animals: Young Ones and Homes" |
| Home class (6) | GT0026 4→3 · GT0069 5→3 · GT0078 5→3 · GT0092 5→1 · GT0096 4→1 · GT0132 5→3 |
| Class links (9) | Add: GT0026 +3 · GT0049 +5 · GT0069 +3 · GT0078 +3 · GT0086 +5 · GT0092 +2, +3 · GT0096 +2, +3 · GT0132 +3, +4. **Remove: GT0032 Class 1** |
| Not changed | 0 chapter moves, 0 new chapters, 0 chapter renames; all other 175 topics identical. GT0011 (retired in the CMS) is not in the sheet: stays retired |

Real today: 185 GT topics (184 active + GT0011 retired; max GT0185) in 41 chapters GC01–GC41 and 5 strands. No Grammar concepts and no Grammar questions yet. `curriculum_owner = cms`. Class links carry their evidence (`source`, e.g. "NCERT; DAV; IXL").

### 0.3 What the schema does not allow yet
- `cms_concepts.concept_id` must match `^G[1-6]-[A-Z]{2,4}-[CA][0-9]+$` (the Math form), so `GTxxxx-Cnn` is refused.
- `cms_misconceptions.misconception_id` must match `^G[1-6]-M-…`.
- Formats: `Typed-text` exists; Typed word, Typed sentence, Reorder words and Spot the error don't.
- Wrong-answer tags: the 9 Math types; no `l1_interference`.
- Gold IDs: `G[1-6]-NNN` (Math) or `GS[1-6]-NNN` (Science) only.
- `cms_settings.subject` is `math | science | both`.
- `science_question_type` (1–5), `has_hidden_idea`, `has_irrelevant_info`, `is_pure_fact`, `setting_familiarity`, `reading`, `steps`, `inhibition` and `visual` already exist on every version.
- Load / Trap / clone key come from the view `cms_science_derived` (Science only).
- Subject value: `grammar` everywhere (topics, chapters, concepts check, questions check, `GQ` IDs, `GC` file keys, `GP` patterns).

## 1. How each step uses the PR 3 key registry
| ID | Issued by | How |
|---|---|---|
| Topic IDs GT0186–GT0194 | **registry** (new kind `topic`, 0053) | `npm run keys -- reserve --kind topic --prefix GT --count 9 --purpose "Q41 NEW-01…09"` returns GT0186–GT0194 before anything is created. The mapping file is final from that moment. E1 creates each topic with its reserved ID (`cms_save_curriculum` accepts a `topic_id` that matches an open reservation, then closes it `used`). Later topics: the CMS mints max + 1, skipping reserved ranges |
| Concept IDs `GTxxxx-Cnn` | the sheet's own (543), the mapping (23), then **registry** (kind `concept`, prefix = topic ID, numbers 1–99) | E2 imports the sheet IDs as they are. `NEW-xx-Cnn` → `GTnnnn-Cnn` from the mapping. Later concepts: CMS next Cnn in the topic (skipping a reserved range); the Grammar session reserves with `--kind concept --prefix GT0049 --count 3` |
| Misconception items | derived, never free: `<concept_id>-M<n>` | Deterministic from the concept and the item order in column L; no registry needed |
| Item types IT1–IT12 (+ later) | the CMS catalogue (max + 1) | Like settings; admin adds, never deletes |
| Question IDs `GQ######` | `cms_mint('GQ')` | Dry runs take no number (0052) |
| File keys `GCnn-5001…9999` | the CMS (generated / added questions) | A Grammar book pipeline, if one ever exists, reserves below 5000 (`--kind file_key --prefix GC28`) |
| Gold IDs `GE<class>-NNN` | the CMS, max + 1 per class | E6 |
| GR run codes | `cms_mint('GR')` | as Science |

## 2. E1 · Q41 curriculum sync (BUILD-READY)

**Migration 0053 `0053_registry_topics_concepts.sql`** (adds only):
- `cms_key_reservations.kind` gains `topic` (prefix `GT|MT|ST`, numbers 1–9999, after the highest stored or reserved topic number of that prefix) and `concept` (prefix = a `GT` topic ID, numbers 1–99).
- Check constraints widened. `cms_reserve_keys` / `cms_close_keys` handle both kinds (same advisory lock, audit and rules). `keys` CLI: `--kind topic|concept`.
- `cms_save_curriculum` (re-created from its live body, as 0052 did; the test re-derives the body):
  - topic `create` accepts `topic_id` only if it equals a number of an open `topic` reservation for that prefix, and closes the reservation as `used` when its last number is created;
  - without `topic_id` it mints max + 1 via `cms_next_free('topic', …)`;
  - nothing else changes.
- `cms_next_free` gains kinds `topic` / `concept` (skip open reservations).

**Script `npm run grammar:sync -- --sheet <xlsx> [--dry-run] [--confirm-real]`** (`scripts/grammar-sync.ts`):
1. Reads Topic map rows 2–194 only. Refuses if any purple Reading row (RD-/GC42–48) would be touched, if the count isn't 193 + 0 new chapters, or if a NEW row has no reservation.
2. Plans per topic, comparing the sheet with the CMS:
   - **create** (NEW, with its reserved ID, chapter, home class, sub-skills, notes, class links from the ticks with `source 'Grammar sheet r30'`);
   - **rename**; **home class**;
   - **class links** (the given list replaces the old one; existing rows keep their `source`/`evidence`, added ones get `Grammar sheet r30`).
   - Everything else → `unchanged`.
3. Writes through `cms_save_curriculum` as the admin (JWT claims, as `--approve`), so it is audited before → after, with by_label `grammar:sync r30`.
4. Topic order: each new topic goes into `cms_topic_order` of every class it is linked to, right after the topic above it in the sheet (same chapter). If that one isn't linked to the class, it goes after the last topic of the chapter in that class **[inferred]**. Order numbers are recomputed with no gaps, as today.
5. Under the work lease. **One transaction per topic** on a fresh connection (21 topics touched), resumable: a re-run plans again from the CMS and skips what is already equal.

**Dry-run report** (`.local-import/grammar-sync-<target>-…json` + console):
- added 9 (ID, chapter, home, classes, order position);
- renamed 3 (before → after);
- home class 6 (before → after);
- class links 9 (before → after per topic);
- unchanged 175; refused 0.
- Mapping file regenerated from the actual reservation.

**Order of work on real (each on Sambit's go):**
1. Backup `real-cms-<date>-pre-0053.dump`; 0053 guarded; `db:verify`.
2. Reserve GT0186–GT0194 (`keys reserve --kind topic`; dry run first). Confirm the mapping file.
3. `grammar:sync --dry-run` on real (now takes no numbers).
4. `--confirm-real`; `db:verify`.
5. `keys:audit`; `keys mirror`.

**Nothing deleted:** topics and chapters are never deleted. The one class-link removal (GT0032 Class 1) goes through the existing topic save, which replaces the link rows and audits before → after (open question Q3).

**Tests (E1):**
- db: reservation kinds topic and concept (next after stored/reserved, never reused);
- `cms_save_curriculum` create with a reserved ID (accepted, reservation closed) vs an unreserved ID (refused);
- body re-derivation of the re-created function;
- `grammar:sync` on a copy of the local catalogue: plan = expected; a re-run is all unchanged; the Reading-row and count guards; topic order has no gaps.
- unit: sheet parser (ticks, home, NEW rows, purple rows skipped).
- Regression: Science `gen:import` dry run (C5S + a fresh copy) identical before and after; Math curriculum save tests unchanged.

## 3. E2 · Concept catalogue + Q39 regional fields (BUILD-READY)

**Migration 0054 `0054_grammar_concepts.sql`** (adds only):
- `cms_concepts`:
  - widen the ID check to `^(G[1-6]-[A-Z]{2,4}-[CA][0-9]+|GT[0-9]{4}-C[0-9]{2})$`;
  - add `rule text`, `examples text`, `classes int[]` (column H), `frequency text check (Common | Less common)`, `is_exception boolean`, `secondary_topic_ids text[]`, `source_note text` (N, labels only: e.g. "IXL G5 FF.3", "NCERT 4–5"), `review_note text` (O), `check_notes text` (P), `notes text` (Q), `aliases text[]` (old IDs, searchable), `content_hash text`;
  - **Q39:** `regional_flag boolean not null default false`, `regional_note text` (K), `regional_item_rule text check (accept_both | never_test | teach_uk_never_us_wrong)`, `regional_other_forms text[]` (the US forms parsed from K, for the review warning **[inferred parse]**; unparsed ones are listed in the dry run).
  - Math rows are untouched: all new columns are null / false.
- `cms_misconceptions`: widen the ID check with `GT[0-9]{4}-C[0-9]{2}-M[0-9]+`; add `item_no int`.
- `cms_misconceptions_by_concept` index; search covers `aliases`.
- `cms_reviews.action` gains `grammar_concept`.
- Function `cms_import_grammar_concepts(p jsonb)` (admin or cms_owner; security definer):
  - takes up to 25 concepts with their misconception items;
  - per concept: insert (status **active** = Approved) / unchanged (same `content_hash`) / changed (update, audited before → after);
  - misconception items are imported **Approved (active)**, like the concepts, so questions that use them are never blocked (Sambit, 28 Nov); they are inserted, or updated in place by `(concept_id, item_no)`; an item that disappears is **retired**, never deleted;
  - every insert / update is audited (`grammar_concept`, by_label `grammar:concepts r30`);
  - validates: topic exists and is Grammar; first-taught class is in `classes`; secondary topics exist; rule non-empty.

**Script `npm run grammar:concepts -- --sheet <xlsx> --mapping docs/grammar/new-id-mapping-2026-11-28.csv [--dry-run] [--confirm-real]`:**
- Reads the Concepts tab (566 rows).
- Maps the 23 `NEW-xx-Cnn` → `GTnnnn-Cnn` and keeps `NEW-xx-Cnn` in `aliases`. Secondary topics `NEW-xx` are mapped too.
- Splits column L on ";" into items 1…n (34 concepts with 2; listed in the dry run for a check).
- Q39 per concept:
  - `regional_flag` = column K filled (**88**) **plus 3 decided by Sambit (28 Nov)**: GT0131-C02 and GT0153-C01 (teach_uk_never_us_wrong), GT0018-C02 (accept_both). **91 flagged in all.** `regional_note` = K; for the 3, the Q-note text.
  - `regional_item_rule` = the rule the Q/P notes state (Never test 9, Accept both 3, Teach UK/India 11). The other 65 flagged concepts take the default **Teach UK/India, never make the US form wrong** (Q4).
  - Concepts with K empty: flag N, no rule.
- Column Q regional mentions are **not** auto-flagged: they are listed for Sambit (§3.1).
- Batches of 25 concepts (23 batches), one transaction each, fresh connection, under the lease; idempotent by concept ID. Needs E1 first (topics GT0186–0194 must exist).

**Dry-run report:**
- added / unchanged / changed per concept;
- misconception items (600);
- flagged 88 with their rule and its basis (stated in notes / default);
- unparsed US forms;
- ID remaps (23);
- refused rows (none expected).

**Question locale:** `cms_questions.locale` stays `IN` for every Grammar question (already the default).

**Tests (E2):**
- db: insert / unchanged / changed with audit; misconception items retired, never deleted; ID check (`GTxxxx-Cnn` accepted, junk refused, Math IDs still valid); aliases searchable; refuses an unknown topic or a missing rule.
- unit: L split, K parse, mapping.
- Regression: Math concept saves (`cms_save_curriculum` concept create) unchanged; Science `gen:import` dry run identical.

### 3.1 Regional review list (Sambit decides; nothing is auto-flagged)
`docs/grammar/regional-review-2026-11-28.csv` lists, per concept, the proposed flag and item rule.
- **Total flagged: 91** (88 with K + the 3 decided above).
- **88 concepts with column K filled:** flag Y, with the item rule as above (76 Teach UK/India, of which 65 are by default; 3 Accept both; 9 Never test).
- **52 concepts with K empty whose Q/P notes mention US / UK / Indian / spelling / "never test"**, grouped:

| Group | n | Proposal |
|---|---|---|
| Possibly regional | 5 | **Decided (Sambit, 28 Nov):** GT0025-C03 **N** · GT0131-C02 **Y**, teach_uk_never_us_wrong · GT0153-C01 **Y**, teach_uk_never_us_wrong · GT0018-C02 **Y**, accept_both · NEW-06-C02 **N** (its never-test note stays in the concept notes; concept notes reach the writer and checker in E3/E6) |
| Notes say "not a UK/US difference" | 3 | N (GT0006-C03, GT0042-C01, GT0177-C03) |
| "Common Indian-learner error" | 15 | N for regional. These are **L1-interference** candidates: suggest the `l1_interference` wrong-answer tag in E3 (list in the CSV) |
| "US check suggests Class X" | 18 | N (class information only, as decided 28 Nov) |
| Indian school practice / spelling rule | 11 | N |

## 4. E3 · English question model (DESIGN)
Migration 0055 (with E4/E5), shape only:
- **Shared 1–5 level field: `question_level smallint (1–5)`**, a NEW column. English writes it; Science keeps writing `science_question_type` **unchanged**.
  - The shared engine and screens read `coalesce(question_level, science_question_type)` through a view (`cms_question_level`), so Science rows are never rewritten and stay byte-identical.
  - Labels per subject: English 1 Simple · 2 Medium · 3 Complex; Science 1 Fact · 2 Basic understanding · 3 Curiosity/application; both 4 Achiever · 5 Super Achiever.
  - Tier (derived, as Science): 1–3 School · 4 Achiever · 5 Super Achiever.
  - Built only when no Science import is running (lease). A Science regression test compares every Science version's derived values before and after.
- **Item type:** `cms_item_types` (IT1–IT12 seeded; subject `grammar`; admin adds, never deletes; status) and `cms_question_versions.item_type_id`. One per English question.
- **Concepts tested:** `cms_version_concepts` (exists) with involvement 1.0 / 0.5 / 0.2, and **at least one 1.0** (central) for English.
- **Misconception targeted:** must be a `cms_misconceptions` item of a tested concept (no free text).
- **Wrong-answer tags:** + `l1_interference`. A `misconception` tag on English must name an item of a tested concept.
- **Formats:** add `Typed-word`, `Typed-sentence`, `Reorder-words`, `Spot-the-error` (`Typed-text` stays). Accepted forms use the existing `accepted text[]` (several spellings, contractions).
- **Drivers** (all present, 0/No allowed): Reading, Steps, Inhibition, Visual, Irrelevant info, IsPureFact, Hidden idea, Setting (shared SET catalogue), Setting familiarity.
- **New fields:** `word_set_id text` (free ID until F1), `regional_item_rule` (copied from a flagged central concept, editable). Expected duration, hints (Hint 1 = the rule's name), Solution 1 **required for approval** (blocker, as Science Q18).
- **Hidden for English:** Math difficulty, Working memory, Strategy / type / insight, Solution 2, Trick, Typical set, Experiment, linked content rows.
- **Derived** (view `cms_english_derived`, same columns as `cms_science_derived`):
  - Load = max(Reading, Steps band);
  - Trap level as today;
  - Clone group = central concept + item type + setting.
- **Review warnings** (shown, never block):
  - (a) a wrong option equals one of a tested flagged concept's `regional_other_forms`;
  - (b) level 1–2 with Hidden idea = Y;
  - (c) level 5 with no Hidden idea and Inhibition < 2;
  - also: a "Never test" concept used as the central concept.
- **Concept notes reach the writer and the checker** (E3 form, E6 prompts and checks): rule, examples, exception, regional rule and note, and the concept's Notes (column Q), e.g. NEW-06-C02's "never test with a single right answer".

## 5. E4 · Screens (DESIGN; screenshots before committing)
- **Browse / filter English:** strand → topic (core / from a lower / higher class as today), filters by item type, level, concept, regional flag, Needs review.
- **Concept view** (`#/concepts/GT0049-C02`): rule, examples, first taught, classes, frequency, exception, regional note + rule, numbered misconceptions, secondary topics, source labels; questions using it. Search finds old `NEW-xx` aliases.
- **Add / Edit / Approve** an English question: only the English fields (§4); concept picker with involvement; misconception picker from the tested concepts' items; regional warning inline.
- **Coverage per concept × class:** questions per level and item type against the blueprint target (≈ 6 per rule pair, ≈ 25 per word-set pair), with gaps highlighted.

## 6. E5 · English in the `gen:import` pack format (DESIGN)
- `generation-pack/1` with `run.subject = grammar` (shown "English"). It goes through the same `gen:import` → `cms_gen_import_batch`, lands as Needs review (not Draft), and anything unplaceable goes to Held out with `pack_item`.
- English profile per question:
  - `concepts[{concept_id, involvement}]` (≥ 1 at 1.0), `item_type`, `question_level`;
  - drivers, `is_pure_fact`, `hidden_idea`, `setting`, `setting_familiarity`;
  - `word_set_id`, `regional_item_rule`;
  - `misconception {concept_id, item_no}`, `wrong_option_tags` incl. `l1_interference`;
  - `accepted[]`, hints, `solution_1`, duration, format.
- Held-out codes added: `concept_missing`, `item_type_missing`, `misconception_missing`.
- The writer gets an English branch (GQ via `cms_mint`, GC file keys 5001+). **The Science branch is byte-identical** (body re-derivation test + C5S regression).
- Settings: English uses only existing active settings, of any subject. A new setting proposed by an English run is created `both`, Proposed (no English-only settings) **[inferred from "shared catalogue"]**. Setting groups come with Q38 PR 10.

## 7. E6 · Generate for English (DESIGN, built with Q38 PR 9 behind a flag)
- English is a subject of the shared engine (PR 7) and of the Generate button (PR 9), with its own stage prompts and checks:
  - the regional / locale check (US form as a wrong option, "Never test" concepts);
  - accepted forms;
  - misconception items from concepts;
  - L1 interference tags;
  - the word-set ID.
- API access as set up (ant CLI login, hard cap; the CMS issues keys; named keys for Route A only).
- **English gold set** (~40 questions across classes 1–6 and IT1–IT12, tagged with the agreed attributes; IDs `GE<class>-NNN`, `bank = gold`, never publishable). Not built yet: designed here, written in the content thread, reviewed by Sambit, then used for the clone check and the tagger calibration (as Science).

## 8. Migrations and PRs
| Migration | PR | Contents |
|---|---|---|
| 0053 | **E1** | registry kinds `topic` / `concept`; `cms_save_curriculum` accepts reserved topic IDs; `cms_next_free` kinds |
| 0054 | **E2** | Grammar concept columns + Q39 regional fields; misconception items; `cms_import_grammar_concepts` |
| 0055 | E3 + E4 + E5 | `question_level` + view; `cms_item_types`; formats; `l1_interference`; `word_set_id`, `regional_item_rule` on versions; Solution 1 blocker; `cms_english_derived`; warnings; English branch of the pack writer |
| (none) | E6 | with Q38 PR 9, behind a flag |

**Order:** E1 → E2 right after this round (E1 in progress 28 Nov: migration file `0053_registry_topics.sql`, `npm run grammar:sync`); E3 + E4 + E5 after the Q38 checkpoint; E6 with PR 9. Each PR is its own branch, built in a separate worktree (the Science session runs from the main folder). Each goes: rehearsal → report → "OK to write to real?" → backup → small batches → `db:verify`.

## 9. Open questions: decided (Sambit, 28 Nov 2026): all as proposed
Q1 adds: Reading (F2) and vocabulary also live under subject `grammar`, shown as English. Q8: the CMS owns Grammar after E1/E2; sheet changes come in only through the reviewed sync.
Changes to the plan (28 Nov): misconception items import as Approved (active), like the concepts (§3); the 5 possibly-regional concepts decided (§3.1), 91 flagged in all.

The questions as asked (proposal in bold = the decision):
- **Q1** Stored subject value: **keep `grammar` (topics, concepts, questions, GQ/GC/GP); show "English" in the CMS.**
- **Q2** Name of the shared 1–5 field: **`question_level`, a new column, with `science_question_type` untouched and a view that reads either.**
- **Q3** GT0032 loses Class 1: **through the existing topic save (link rows replaced, before → after audited); the topic is never deleted.**
- **Q4** 65 flagged concepts have no rule in their notes: **default "Teach UK/India, never make the US form wrong"; editable per concept; listed in the CSV.**
- **Q5** The 34 concepts whose misconceptions split on ";" into 2 items: **split as listed; check the list in the dry run.**
- **Q6** Concept class: **`class` = First taught (G); Classes (H) stored as a list; concept classes don't create topic–class links.**
- **Q7** Misconception items: **reuse `cms_misconceptions` with IDs `<concept_id>-M<n>` (works with the existing question fields) rather than a new table.**
- **Q8** Who owns Grammar after the import (D5, "the CMS owns the curriculum") vs the handoff's "the sheet is the single source": **the CMS owns it once E1 and E2 are on real. Until the sheet is retired, later sheet revisions come in only through the same re-runnable dry-run sync, reviewed by Sambit. The sheet gets the mapping, then becomes an export.**
- **Q9** English gold IDs: **`GE<class>-NNN`.**
- **Q10** New settings from English runs: **created `both`, Proposed; no English-only settings.**
- **Q11** `word_set_id` before F1: **free text matching `WS-…`, no catalogue yet.**
- **Q12** The 52 column-Q candidates: **only the 5 "possibly regional" need a decision; the 15 Indian-learner errors become suggested L1-interference tags, not regional flags.**

## 10. Test checklist for Sambit
**E1, after real:**
- Topic list shows 193 active Grammar topics, GT0186–GT0194 among them, in the right chapters and order.
- GT0062 / GT0111 / GT0143 show the new names.
- GT0026, GT0069, GT0078, GT0092, GT0096 and GT0132 show their new home classes.
- The 9 class changes are in place; GT0032 no longer shows Class 1.
- GT0011 is still retired.
- `keys list --all` shows the GT0186–GT0194 reservation `used`.
- History shows each change before → after.

**E2, after real:**
- 566 concepts, Approved.
- Open GT0186-C01: it is found by searching `NEW-01-C01`.
- 600 misconception items, numbered.
- 88 concepts with the regional flag and a rule.
- A Math concept still opens and saves as before.

**Both:** Science imports still run (`gen:import --dry-run` on the next pack shows the same counts as before).

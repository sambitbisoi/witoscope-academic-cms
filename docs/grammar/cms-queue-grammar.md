# WitoScope Academic CMS — Grammar items (pending)

Companion to `claude/academic-cms/cms-queue.md`. Queued only — no plan, no prompt until Sambit asks (working rule). Source sheet: "WitoScope English Grammar — Topic map & Concepts" (https://claude.ai/artifact/VW6zDFBQEtX3gjBFPHokjy): tabs Topic map (194 topics + 29 proposed Reading topics), Concepts (566), Chapters, US standards, **Question attributes** (new 28 Nov). Handoff: `claude/grammar/grammar-handoff-2026-11-28.md`.

## Q39 · Regional (UK/India vs US) flag on grammar concepts — PENDING (Sambit, 28 Nov)

**Decision:** for now WitoScope uses the **Indian (British) English setting** only. Keep the regional differences so they are not lost and can drive a US version later.

**Store on each concept (from the Concepts sheet):**
- `regional_flag` — Y/N (Y = column K "UK/India vs US" is filled; ~140 of 566 concepts).
- `regional_note` — the column K text, e.g. "UK/India: colour, centre; US: color, center".
- `regional_item_rule` — how question writers handle it (mostly in column Q notes today): **Accept both** · **Never test** (e.g. quote style, dash style, Oxford comma, RP-only homophones) · **Teach UK/India, never make the US form a wrong option**.

**Store on each question:** `locale` (IN now; US later) — reuse the existing Locale field (IN / US version) if it fits.

**Where it bites:** not the grammar rules (they are written in Indian/British English) but **question generation and checking**:
1. Distractors — a valid US form must never be a wrong option (else two right answers).
2. Items to skip — forms marked "Never test".
3. Answer keys — some items accept both forms (mew / miaow / meow).
4. Later US launch — flagged concepts need a US question version; unflagged concepts reuse as is.

**Checks to add with it:** generation and import read the flag and rule; a review warning when a question on a flagged concept has an option matching the other locale's form.

**Do when:** Grammar concepts are first loaded into the CMS (with the Grammar concept import). Likely a migration (new concept columns).

## Q40 · English question attributes in the CMS — PENDING (Sambit, 28 Nov)

Spec: `claude/grammar/english-question-attributes.md` (37 parameters; snapshot agreed 28 Nov) and sheet tab "Question attributes". Align the CMS so English questions carry exactly these fields. Main changes vs today (Math + Science):

1. **Subject = English** on topics, concepts and questions (Grammar topics exist: 184 active today; the sheet now has 194 incl. NEW-01…NEW-09 and 3 renames — sync first, see Q41).
2. **Grammar concept catalogue** (566 concepts, ID `GTxxxx-Cnn`): fields rule, examples, first taught, classes, frequency (Common/Less common), exception Y/N, misconceptions (numbered items, like Science row items — questions must reference them, no free text), secondary topics, source, notes + Q39 regional fields. Questions link to concepts with involvement 1.0 / 0.5 / 0.2 (as Math).
3. **Item type** — new controlled list IT1–IT12 (Choose the correct form · Fill the blank · Identify/classify · Spot the error · Correct the sentence · Rewrite/transform · Combine sentences · Reorder words · Match · Odd one out · Word meaning/relation · Passage-based); one per English question; admin can add values, never delete.
4. **Question level 1–5** — reuse Science's `science_question_type` field generalised to a shared "question type / level" with subject-specific labels (English 1 Simple · 2 Medium · 3 Complex · 4 Achiever · 5 Super Achiever); tier rule as Science (1–3 School · 4 Achiever · 5 Super Achiever). Decide the final field name in the plan.
5. **Drivers for English:** Reading, Steps, Inhibition, Visual, Irrelevant info, IsPureFact, Hidden idea, Setting, Setting familiarity (all present on every question; 0/No allowed). Hide for English: Math difficulty, Working memory, Strategy / type / insight, Solution 2, Trick, Typical set, Experiment, linked content rows.
6. **Derived:** Load = max(Reading, Steps band) (as Science); Trap level as today; Clone group = concept + item type + setting.
7. **Wrong-answer tags:** Math's 9 types + new **L1 interference** (English).
8. **New English-only fields:** word-set / word list ID (vocabulary; lists to be built — F1); regional item rule (Q39).
9. **Formats:** add Typed word, Typed sentence, Reorder words, Spot the error (check which exist).
10. **Accepted forms** on answers must support several spellings (US forms, contractions).
11. Solution 1 required (the rule + why key wrong options are wrong); approval blocked when empty (as Science Q18).

Likely migration(s) → plan session first; do with or before the first Grammar question import.

## Q41 · Sync Grammar curriculum from the sheet — PENDING (Sambit, 28 Nov)

- Add NEW-01…NEW-09 with real GT IDs (retained by Sambit 28 Nov).
- Renames: GT0062 → "Adverbs of Frequency, Degree and Certainty"; GT0111 → "Capitals for Nationalities, Languages and Events"; GT0143 → "Animals: Young Ones and Homes".
- Class ticks / home class changes: GT0026 Class 3 added (home 3) · GT0032 Class 1 removed · GT0049 Class 5 added · GT0069 Class 3 (home 3) · GT0078 Class 3 (home 3) · GT0086 Class 5 · GT0092 Classes 2–3 (home 1) · GT0096 Classes 2–3 (home 1) · GT0132 Classes 3–4 (home 3).
- **Do NOT sync the purple Reading rows (RD-01…RD-29, GC42–GC48) until F2 is final** (see F2).
- Dry-run report first (topics added / renamed / class links changed), audit, as other curriculum imports.

## F1 · Vocabulary word-set selection and UX — FUTURE review item (Sambit, 28 Nov)

Word-set concepts (batch 4 — synonyms, antonyms, homophones, idioms, spelling, theme words…; ~45 rows marked "Word-set concept" in column Q) are retained as drafted. Sample words "more or less align" but are subjective. **Decide later, before building the full word lists:**

1. **How to select the words, accurately.** Example: synonyms/antonyms run from Class 2 to Class 6 — which words belong to which class? Options to weigh then: graded word-frequency lists, words used in Indian textbooks (NCERT/DAV labels only), Olympiad/IXL word levels, reading-level tools; how many words per class (draft guess 30–50).
2. **Regional fit.** Word choice and expected synonym/antonym pairs differ between India and the US (and other countries) — word lists may need a locale (ties to Q39).
3. **How to present it to the child.** A Class 2 child may want to go on to Class 3 words. Decide the UX: levels or word "packs" the child can unlock or move up through, rather than a hard class lock; how mastery of one class's words opens the next; how this shows in progress reports.

**Status:** future to-do for a better user experience; not blocking the gold set / blueprint.

## F2 · Reading (passage) strand — ACCEPTED IN PRINCIPLE (Sambit, 28 Nov), small research pass pending

Research basis: NWEA MAP Growth Reading (grades 2–5 and 6+: Literary Text, Informational Text, Vocabulary; sub-areas central idea/summarize, theme, point of view, purpose, features, structure, context clues and references), Common Core RL/RI 1–6, CBSE unseen passage (comprehension, interpretation, inference, vocabulary; case-based factual passages with charts), SOF IEO Reading section (prose and poetry).

**In the sheet (purple):**
- **Topic map rows 195–223:** new strand "Reading", 7 chapters GC42–GC48, **29 topics RD-01…RD-29** (temporary IDs) with class ticks, sources (column G) and question types (column Q). Covers gist/main idea (RD-04), summary (RD-05), title (RD-06), direct questions (RD-01), indirect/inference (RD-09), what happens next (RD-10), plus evidence, sequence, moral/theme, cause–effect, fact/opinion, characters, point of view, author's purpose, text structure/features, kinds of text, poems, case-based passages with charts, comparing passages, word meaning/reference, figurative language, cloze, sentence order, and **RD-29 Reading a technical or explanatory text** (Classes 4–6; added 28 Nov at Sambit's request). Editing a passage stays in GT0169.
- **Chapters tab rows 43–49:** the 7 new chapters.
- **Question attributes tab rows 56–66:** passage-level attributes P1–P10 — Passage ID · **Passage type** (Story/fable · Poem · Informational · **Technical/explanatory** (subject words and jargon explained in the text — added 28 Nov) · Letter/notice/diary/dialogue · Case-based with chart/table) · length by class (draft C1 40–60 … C6 250–350 words) · reading level · setting/topic · questions per passage + mix (4–6: ≥1 literal, ≥1 inference, 1 vocabulary, 1 main idea/title) · source (own writing only) · **Comprehension level** (Literal · Inferential · Evaluative) · Passage ID link · **P10 Passage familiarity** (Everyday · Less familiar · Rare — added 28 Nov; same scale as Setting familiarity).

**Sambit's feedback (28 Nov):** otherwise looks fine. **Before drafting Reading concepts:** a short research pass on Olympiad reading formats (SOF IEO sample papers and other Indian Olympiads), passage length / question count per class, and NWEA item formats — then confirm lengths and the question mix.

**CMS impact once final:** new **passage** entity (P1–P7, P10) with questions linked to it (P9); question field Comprehension level (P8); a passage question is never shown without its passage; Irrelevant info applies mainly here.

## Grammar decisions to carry into the CMS (27–28 Nov)

- British/Indian English is the standard; US forms accepted, not tested as wrong.
- Class placement: when IXL and Indian schools disagree, start from the **lower class**.
- **US-only earlier classes are NOT applied (Sambit, 28 Nov):** class rules follow the Indian curriculum wherever possible. "US check suggests also Class X" notes stay as information only.
- Claude-added concepts ("Claude (no source)") are all retained.
- New topics NEW-01 … NEW-09 retained — give real GT IDs on import (Q41).
- Word-set sample words retained as drafted — selection method and UX → F1.
- Catalogue accepted as is (column O review waived, 28 Nov).
- English question attributes agreed (snapshot) → Q40.
- Reading strand accepted in principle with technical passage type and passage familiarity (F2).
- Sizing (estimate, 28 Nov): 1,581 concept × class pairs; first release ~6,500 questions, target ~12,000 (≈ 6 per rule pair, ≈ 25 per word-set pair). Generation: Claude API (Sonnet 5.5 batch ≈ $150–200 for 12k) or Claude Code on the $200 plan (~1–2 weeks); pilot 500 first to measure. (Reading strand not included in these numbers.)

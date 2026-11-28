# English (Grammar & Vocabulary) — question-level attributes

**AGREED with Sambit, 28 Nov 2026 — a snapshot of the logic as of now, not the final driver.** Also in the Grammar sheet, tab "Question attributes" (https://claude.ai/artifact/VW6zDFBQEtX3gjBFPHokjy), with differences from Math and Science highlighted yellow. Math: `claude/question-attributes/question_attributes.csv`, `derived_attributes.csv`; Science: CMS queue Q26–Q34. Supersedes `english-question-attributes-draft.md`.

**Rule:** every parameter marked ✓ exists on every English question; many questions carry 0 / No / none. No "optional" parameters.

| # | Question-level parameter | Math | Science | English | Difference / note |
|---|---|---|---|---|---|
| 1 | ID, version, review status | ✓ | ✓ | ✓ | Same |
| 2 | Level (class depth) | ✓ | ✓ | ✓ | Same |
| 3 | Locale (IN / US) | ✓ | ✓ | ✓ | Same; matters most for English (Q39) |
| 4 | Clone batch | ✓ | ✓ | ✓ | Same |
| 5 | Item type | Typical set | — | ✓ | **Different:** short cross-topic list (IT1–IT12 below), not a topic-specific catalogue. Concept + item type = role of Math's typical set |
| 6 | Concepts tested + involvement (1.0 / 0.5 / 0.2) | ✓ | — | ✓ | Same as Math (grammar concepts GTxxxx-Cnn) |
| 7 | Linked content rows | — | ✓ | — | Science only |
| 8 | Misconception targeted | ✓ catalogue | ✓ row items | ✓ | Source = the concept's Misconceptions column; no free text |
| 9 | Word-set / word list ID | — | — | ✓ | **New**, vocabulary questions (lists to be built — F1) |
| 10 | Regional item rule | — | — | ✓ | **New**: Accept both · Never test · Teach UK/India, never make US form wrong (Q39) |
| 11 | Format | ✓ | ✓ | ✓ | English adds Typed word, Typed sentence, Reorder words, Spot the error |
| 12 | Options, correct answer, accepted forms | ✓ | ✓ | ✓ | Accepted forms vital (US spellings, contractions, mew/miaow/meow) |
| 13 | Multi-part | ✓ | ✓ | ✓ | Same; passage editing |
| 14 | Wrong-answer tags (only where confident) | ✓ | ✓ | ✓ | Math's 9 types **+ L1 interference** (error carried over from Hindi / a regional language) |
| 15 | Question level 1–5 (authored) | — | ✓ Science question type | ✓ | **Same field and tier rule as Science**; labels 1–3 differ: English 1 Simple · 2 Medium · 3 Complex; Science 1 Fact · 2 Basic understanding · 3 Curiosity/application; both 4 Achiever · 5 Super Achiever |
| 16 | Tier (derived) | from Strategy + Level | from type | from question level | Levels 1–3 School · 4 Achiever · 5 Super Achiever (as Science) |
| 17 | Math difficulty | ✓ | — | — | Math only |
| 18 | Reading (1–5) | ✓ | ✓ | ✓ | Same scale; sentence/passage length, word level, structure |
| 19 | Steps | ✓ | ✓ | ✓ | Mostly 1; rewriting/combining 2+ |
| 20 | Working memory | ✓ | — | — | Math only |
| 21 | Inhibition (0–3) | ✓ | ✓ | ✓ | Same; key driver for grammar ("he don't", "isn't it?") |
| 22 | Visual (0–3) | ✓ | ✓ | ✓ | Same; mostly 0; pictures in Classes 1–2 |
| 23 | Irrelevant info (Y/N) | ✓ | ✓ | ✓ | Same; mainly passage questions and long sentences |
| 24 | Pure fact / recall (IsPureFact) | ✓ | ✓ | ✓ | Same (happy – unhappy, go – went, cow – calf); drivers default low |
| 25 | Strategy, strategy type, insight | ✓ | — | — | Math only |
| 26 | Hidden idea (Y/N) | — | ✓ | ✓ | As Science; mostly N, mainly level 5 (e.g. "Neither of the boys ___ ready") |
| 27 | Experiment | — | ✓ | — | Science only |
| 28 | Setting | ✓ | ✓ | ✓ | Same SET catalogue (cricket match, school trip…) |
| 29 | Setting familiarity | — | ✓ | ✓ | As Science (Bare · Everyday · Less familiar · Rare) |
| 30 | Solution 1 (required) | school method | reasoning from linked rows | the rule + why key wrong options are wrong | Must stay inside the concept's rule |
| 31 | Solution 2 | ✓ | — | — | Math only |
| 32 | Hints (up to 3) | ✓ | ✓ | ✓ | Hint 1 = the rule's name |
| 33 | Expected duration | ✓ | ✓ | ✓ | Same |
| 34 | Trick reference | ✓ | — | — | Math only |
| 35 | Load (derived) | max(Reading, Steps band, WM) | max(Reading, Steps band) | max(Reading, Steps band) | Same name in all subjects; formula per subject (English = Science) |
| 36 | Trap level (derived) | ✓ | ✓ | ✓ | Same |
| 37 | Clone group (derived) | pattern + signature + concepts | primary row + type + setting | concept + item type + setting | Rule per subject |

## Item types (controlled list)

| ID | Item type | Example |
|---|---|---|
| IT1 | Choose the correct form | She ___ (go / goes) to school. |
| IT2 | Fill the blank (typed) | Yesterday I ___ (eat) rice. → ate |
| IT3 | Identify / classify | Which word is a noun? Is this a question? |
| IT4 | Spot the error | He don't like milk. → don't |
| IT5 | Correct the sentence | Choose the corrected sentence |
| IT6 | Rewrite / transform | Change to the past tense; active → passive |
| IT7 | Combine sentences | I was tired. I slept. → I was tired, so I slept. |
| IT8 | Reorder words | ball / kicked / Ravi / the |
| IT9 | Match | Animal – young one; word – meaning |
| IT10 | Odd one out | cat, dog, cow, chair |
| IT11 | Word meaning / relation | Synonym, antonym, homophone, idiom meaning |
| IT12 | Passage-based | Edit a passage; right word in a paragraph; comprehension |

## Passage-level attributes — Reading strand (accepted in principle 28 Nov; sheet rows 56–66)

| # | Attribute | Values | Note |
|---|---|---|---|
| P1 | Passage ID | PSG-xxxx | Questions link to it |
| P2 | Passage type | Story/fable · Poem · Informational · **Technical/explanatory** (subject words and jargon, explained in the text) · Letter/notice/diary/dialogue · Case-based (with chart or table) | Technical added 28 Nov (Sambit): reading an unfamiliar technical article is a skill of its own |
| P3 | Passage length (words) | draft C1 40–60 · C2 60–100 · C3 100–150 · C4 150–200 · C5 200–250 · C6 250–350 | To confirm in the research pass |
| P4 | Passage reading level | 1–5 | A question's Reading can't be lower than its passage's |
| P5 | Passage setting / topic | SET catalogue ID | Same catalogue as Setting |
| P6 | Questions per passage and mix | 4–6: ≥1 literal, ≥1 inference, 1 vocabulary, 1 main idea/title | To confirm in the research pass |
| P7 | Source | Own writing only (book rule) | |
| P8 | Comprehension level (question) | Literal · Inferential · Evaluative | Separate from question level 1–5 |
| P9 | Passage ID link (question) | PSG-xxxx | A passage question is never shown without its passage |
| P10 | **Passage familiarity** | Everyday · Less familiar · Rare | Added 28 Nov (Sambit): can the child relate to it? Same scale as Setting familiarity; technical passages usually Less familiar or Rare |

## Decisions (28 Nov)

1. Item type = short cross-topic list (above); no English typical-set catalogue.
2. One shared authored 1–5 field with Science ("question type / level"), subject-specific labels for 1–3; same tier rule.
3. No "optional" parameters; values can be 0 / No.
4. Irrelevant info included.
5. Hidden idea included (Y/N, mostly N).
6. Derived attribute is called **Load** in every subject; English formula = Science's.
7. IsPureFact applies to English.
8. "L1 interference" wrong-answer tag added for English.
9. Reading strand accepted in principle (29 topics RD-01…RD-29 incl. technical text; passage attributes P1–P10).

## Still to discuss

- Reading: short research pass (Olympiad reading formats, passage length and question count per class, NWEA item formats) before drafting Reading concepts.
- Final name of the shared 1–5 field.

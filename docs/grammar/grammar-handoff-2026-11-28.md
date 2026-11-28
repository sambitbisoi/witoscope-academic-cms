# WitoScope English Grammar — handoff (28 Nov 2026, updated 12:15 IST)

**For the CMS session:** read `claude/academic-cms/cms-queue-grammar.md` — **Q39** regional flag · **Q40** English question attributes · **Q41** curriculum sync (new topics, renames, class changes) · F1 word sets (future) · **F2 Reading (passage) strand — accepted in principle, small research pass pending; do not build or sync it yet**. Spec for Q40 (incl. passage attributes P1–P10): `claude/grammar/english-question-attributes.md`. **The main CMS queue (`claude/academic-cms/cms-queue.md`) does not link to the grammar doc yet — add a one-line pointer there in the next CMS session.** Working rule unchanged: plan first, no prompt until Sambit asks; dry run before real; backups.

## The sheet (single source for Grammar curriculum)

"WitoScope English Grammar — Topic map & Concepts" — https://claude.ai/artifact/VW6zDFBQEtX3gjBFPHokjy (Claude Sheets; revision 30 on 28 Nov). Tabs:

- **Topic map** — rows 2–194: the 194 agreed topics: A Chapter ID · B Chapter · C Topic ID · D Topic · E Home class · F US check · G US check comment · H–M C1–C6 ticks · N IXL · O NCERT · P DAV classes · Q Sub-skills · R Notes · S Strand. Green rows = NEW-01…NEW-09 (retained). Home class and ticks updated for the decided changes (see Q41). **Rows 195–223 (purple) = Reading strand** (GC42–GC48, RD-01…RD-29 incl. RD-29 technical/explanatory text; column F "Reading (new)", column G = sources).
- **Concepts** — 566 concepts (rows 2–567; ID `GTxxxx-Cnn`): A Concept ID · B Topic ID · C Topic · D Concept · E Rule · F Examples · G First taught · H Classes · I Frequency · J Exception · K UK/India vs US · L Misconceptions · M Secondary topics · N Source · O Review · P Check notes · Q Notes. All accepted as is. No concepts yet for the Reading topics.
- **Chapters** — counts per chapter (formulas on Topic map); rows 43–49 (purple) = Reading chapters.
- **US standards** — CCSS reference (124 items).
- **Question attributes** — 37 question-level parameters with explanation, values and Math / Science / English columns; differences highlighted yellow; item types IT1–IT12; **rows 56–66 (purple) = passage-level attributes P1–P10** (Passage ID, type incl. Technical/explanatory, length, reading level, setting, questions per passage, source, Comprehension level, Passage ID link, Passage familiarity). Snapshot of the logic agreed 28 Nov, not the final driver.

## Decisions (Sambit, 27–28 Nov)

- British/Indian English is the standard; US forms in column K, accepted, never tested as wrong (Q39).
- Class placement: IXL vs Indian schools disagree → **lower class**. US-only earlier classes **not** applied.
- All Claude-added ("no source") concepts retained; catalogue accepted.
- 9 new topics retained; renames GT0062, GT0111, GT0143; homographs stay in GT0128; onomatopoeia stays in GT0172; GT0132 un-/dis- from Class 3.
- English question attributes agreed (english-question-attributes.md): item type list; shared 1–5 question level with Science; Load = max(Reading, Steps band); IsPureFact, Hidden idea, Irrelevant info, Setting familiarity apply; L1 interference tag; no "optional" parameters.
- Word-set selection and UX → F1 (future).
- **Reading strand accepted in principle** with two additions from Sambit: Technical/explanatory passage type (+ topic RD-29) and Passage familiarity (P10).

## Open

- **Reading research pass** (before drafting Reading concepts): Olympiad reading formats (SOF IEO sample papers, other Indian Olympiads), passage length and question count per class, NWEA item formats — then confirm P3 lengths and the P6 question mix.
- Final name of the shared 1–5 level field.

## Sizing and generation (estimate, 28 Nov; grammar only, Reading not included)

- 1,581 concept × class pairs (Class 1 92 · 2 153 · 3 240 · 4 336 · 5 389 · 6 371); 45 word-set concepts (127 pairs).
- First release ~6,500 questions; target ~12,000 (≈ 6 per rule pair, ≈ 25 per word-set pair; tiers ≈ 2 Simple · 2 Medium · 1 Complex · 1 Achiever per pair, Super Achiever only for less-common concepts at their top class).
- Generation options: Claude API Sonnet 5.5 batch ≈ $150–200 for 12k (Opus 5.5 for Achiever/Super Achiever only); or Claude Code on the $200 plan, ~1–2 weeks of runs. Pilot ~500 first to measure tokens / weekly-usage share.

## Next steps

1. Reading research pass → confirm passage lengths / question mix → draft Reading concepts → real IDs → add to Q41 sync and model passages in the CMS (F2).
2. CMS: Q41 (curriculum sync, without Reading until final) → Q40 (attributes) + Q39 (regional) — plan session first.
3. Content: gold set (~40 English questions across classes and item types, tagged with the agreed attributes) → Sambit reviews → blueprint (per concept × class) → 500-question pilot.
4. Later: F1 word lists.

Book rule unchanged: third-party book text (NCERT/DAV) never leaves the Mac — only labels were used. Reading passages will be our own writing only.

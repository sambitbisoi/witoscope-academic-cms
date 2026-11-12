# Question-generation threads: guidance (10 Nov 2026, rule restated and v11; pattern rule 12 Nov 2026)

This guidance is for the Claude chat threads that write chapter files of WitoScope questions. Paste it, or point the thread to it, at the start of every thread.

**This repo copy is the source.** Sambit syncs it by hand to the Claude Project where generation threads run, so edit it here and then re-sync.

## The rule

The book material rule is defined in one place: **CLAUDE.md in the CMS repo, section "Book material rule"**. If this page and CLAUDE.md ever disagree, CLAUDE.md wins. In short: book material stays on Sambit's Mac. AI threads on the Mac may read the PDFs there, but nothing book-derived is stored in or uploaded to anything outside the Mac, and a Claude Project chat is outside the Mac.

So a generation thread in the Claude Project never receives book material:
- no NCERT, DAV, IXL or SOF pages, PDFs or scans;
- no page images, screenshots or book snapshots;
- no extracted or OCR item text, the book's numbers, review packs or chapter workbooks with source questions.

The thread works from citations and our own catalogue instead. If a thread is ever given book material by mistake, it stops and says so instead of using it.

## What the thread gets

| Input | Example |
|---|---|
| Citations only | "NCERT Ganita Prakash, Class 6 · Ch 1 · §1.2 Patterns in Numbers · p2 · Figure it Out Q2 (N6-01-004)": book, class, chapter, section, page, exercise/item number. Never the item's wording |
| Topic | ID, name and sub-skills from the topic master lists, e.g. `MT0470 Triangular, square and cube number sequences` |
| Typical set and pattern | ID, name, template and variables, e.g. `MP0007` with its template |
| Concepts and misconceptions | The topic's concept cards and the misconceptions to target |
| Current rules | Question Attributes **v11** (current since 10 Nov 2026): formats, signature, difficulty rubric ("size alone is never Complex"), Inhibition key test, strategy types, wrong-answer tags |
| Our own questions | Existing bank questions of the topic, to vary from and to avoid duplicating |

## How to write

1. **Write original questions** from the topic, pattern and concepts: our own wording, contexts and numbers.
2. **Never reconstruct a book question from memory.** Models may remember NCERT textbooks. A citation tells you *what skill* the book practises at that spot, not what to write. Don't reproduce its wording, its story or its number set, even approximately.
3. **Choose new numbers.** Don't reuse a sequence or set of numbers you know from the book, in any order.
4. **Record the citation, not the content.** Put the item you were asked to cover in `source_refs`, e.g. `{ "ref_id": "N6-01-004", "relation": "same_idea" }`. Use `modelled_on` only if the question follows that item's idea closely, still in new words and numbers. No field may hold book text, including `author_notes`, `tagging.why` and patterns' `notes`.
5. **Tag with the current rules (v11)** and set `attribute_version: "v11"`. Follow the shape of `content/examples/MC19-example.json`, which is tagged under v10. Under v11, Inhibition counts only if a child who does NOT hold the misconception would still feel the pull, and WorkingMemory 4–5 only when the question rules out paper.
6. **Output one chapter file** (`file_schema: cms-chapter/1.0`, see `schema/chapter.schema.json`), with `generated.by`, `thread` and `model` filled in.

## Patterns and settings (Sambit, 12 Nov 2026)

- **A pattern is the pure maths skeleton plus every constraint that changes the skill**: the operation and its order, signs, crossing zero, carrying or borrowing, like or unlike denominators, remainders, the unknown's position, the number range when it changes the method. Two questions with the same pattern practise exactly the same skill.
- **A pattern never includes the story.** The story or context is the question's **setting** (Lift, Thermometer, Bank balance, … or **Bare** for no story), chosen from the settings catalogue: one setting per question. Changing only the setting or the names keeps the pattern; changing a skill-changing constraint (e.g. now crossing zero) is a different pattern.
- Questions with the same pattern, the same signature and the same concepts are **clones** (interchangeable). The CMS groups them; vary the setting and the numbers across clones, not the skill.

## Before every import (Sambit, on the Mac)

```
npm run check:originality -- content/math/MC27.json      # reads the chapter's PDFs and book files locally
npm run chapter -- validate content/math/MC27.json      # dry run with the check's results
npm run chapter -- import   content/math/MC27.json
```

The originality check compares every question with the chapter's book pages and items, locally. Only the result and a citation go into the CMS.

| Result | Meaning | Effect on the import |
|---|---|---|
| **Near-copy** | Wording ≥ 0.85 similar to a piece of the book (`originality_near_copy`), or the question's distinctive numbers appear in one piece of the book in the same order | **Blocks that question.** Send it back to the thread to rewrite with new wording and numbers |
| **Close** | Wording ≥ 0.6 similar (`similarity_threshold`), or the same numbers in another order | A warning: read it, and reword it if it's too close |
| Clear | Neither | — |
| No book on this Mac | The chapter's PDF isn't on the Mac yet | A warning; the question is imported unchecked |

The import refuses a report made for an older version of the file, so re-run the check after any edit. Drafts made in the CMS by *Generate* are checked afterwards with `npm run check:originality -- --unchecked`. A near-copy draft can't be approved unless Sambit ticks "override: reviewed, not a copy" and gives a reason; the override is logged.

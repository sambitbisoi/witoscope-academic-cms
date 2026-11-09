# Academic CMS wireframe v1 (6 Nov 2026)

Low-fidelity wireframe agreed with Sambit as the starting point for the CMS screens. Live editable version: Design artifact "Academic CMS Wireframe" (https://claude.ai/artifact/4nLWFXmVdRH5cbxKZutFNB). These files are text copies of its four screens (Design Component HTML: markup plus a small renderVals() block holding sample data from the Class 6 Fractions pilot). They are reference only: not built, not served.

| File | Screen | What it shows |
|---|---|---|
| Main.dc.html | 1 · Home | Work strip (review queue, upload new source, jobs), grade picker (All, 1–6), subject blocks (Math, Science, English Grammar) |
| Workspace.dc.html | 2 · Topic workspace | Left: chapter → topic tree with question counts by difficulty and gap warnings. Middle: tabs By question type / By concept / Sources, filters, questions grouped by question type with "Generate more". Right: question detail (child preview, options with mistake tags, solution, hint, signature, Edit / Generate similar / Approve / Reject, version history) |
| Sources.dc.html | 2b · Chapter sources | Per chapter: NCERT and DAV PDFs (open full screen in a new tab at section pages), IXL (browser link + stored screenshots), SOF syllabus link, "+ Add PDF, link or screenshots" |
| Review.dc.html | 3 · Generate similar & review | Left: original question + settings. Right: generated drafts with automatic checks (answer, duplicate, copy-from-source), Edit / Reject, Approve selected |

## Differences from the approved design (the design wins)
- The Signature panel and difficulty labels show the old pilot rubric (Numbers, Conversion, Trap, "Simple (1)"). Use the v10 signature instead: Math difficulty, Reading, Steps (→ MultiStep band), WorkingMemory, Inhibition, Visual, Strategy (→ tier), Strategy type, Insight, IsPureFact, Has irrelevant info, plus derived Load, Style, Trap level.
- "Question type" groups = Typical Sets (parent-facing), with Patterns as the generation templates under them.
- Mistake tags = the 9 v10 wrong-answer tag types plus misconception IDs (G6-M-…), not MM###.
- Rejected drafts are kept permanently with the reason (not 30 days).

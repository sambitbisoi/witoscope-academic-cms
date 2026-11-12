# Curriculum cut-over: the CMS takes over from the topic workbooks (D5)

Agreed by Sambit on 12 Nov 2026 (`docs/queue-2026-11-12.md`, D5, option B). This is a one-time switch. **Nothing here has been run.** Claude stops before step 4 and waits for Sambit's OK.

## Before and after

| | Before the cut-over (now) | After the cut-over |
|---|---|---|
| Chapters, topics, Achievers rows | Come from the three workbooks through `npm run import:topics`. The CMS forms show them read-only | Added and edited in the CMS (Curriculum → + Add chapter / + Add topic; Edit topic on the topic screen). `import:topics` refuses to run |
| NCERT source registry | `npm run import:sources` reads the workbooks' "NCERT (CBSE)" sheets | Kept in the CMS: `import:book` and every chapter import register books and citations (D7); Sources → + Add a citation by hand. `import:sources` refuses to run |
| Topic classes (D2), prerequisites (D4), concepts, question types, patterns | Already CMS data: editable now | Same |
| The workbooks | The source | Read-only exports: `npm run export:topics` (or Export to Excel on the Curriculum page, local mode) writes them to `~/WitoScope/ContentResearch/CMS-exports/<date>/`; `--publish` also puts them at the usual `ContentResearch/{Math,Science,English}/WitoScope_*_Topics_Class1-6.xlsx` paths (read-only) so the pipelines keep working |
| Source-mapping tabs (NCERT (CBSE), DAV, IXL, ISO / IMO Olympiad) | In the workbooks | In the CMS (`cms_source_map`, loaded by `import:sources`; book · class · chapter · topic → master topic IDs) and written into every export. Evidence columns (book text), notes and scan paths are never stored or exported; the archived final workbooks keep them |

`cms_config.curriculum_owner` (`workbooks` or `cms`) holds the switch. `cms_save_curriculum` and the two importers check it.

## Steps

| # | Step | Who | Command / where | Must show |
|---|---|---|---|---|
| 1 | Confirm the workbooks are final: the Math data thread's workbook fixes (e.g. C2) are done, and nothing else is pending in Science or English | **Sambit** | — | "workbooks are final" |
| 2 | Final workbook import, local: dry run, then for real; then the source tabs | Claude | `npm run import:topics -- --dry-run --list`, then `npm run import:topics`; `npm run import:sources`; then re-import NCERT-C5-07 `MC32-C5.json` + its proposals (needs MT0516) | No errors. On 12 Nov the list was **MT0516 + ACH-MC32-5 new, and 30 Class 5 topics whose Seq moves down by one** (MT0516 is inserted at Seq 67); nothing else |
| 3 | Check readiness, local | Claude | `npm run curriculum:cutover` | "Workbooks on this Mac match the last import: yes" |
| 4 | **Switch, local** (after Sambit's OK) | Claude | `npm run curriculum:cutover -- --confirm` | "Done: the CMS owns chapters and topics". Logged in `cms_reviews` (`cms_config` · `curriculum_owner`) with the workbooks' sha256 |
| 5 | Archive the final workbooks and publish the first export | Claude | `npm run export:topics -- --publish`: exports to `CMS-exports/<date>/`, copies each original once to `<subject folder>/_archive/…final-before-cutover-<date>.xlsx` (frozen, read-only; keeps the evidence columns, which never enter the CMS), then puts the export at the usual paths (read-only) | Three dated exports; three archives; the pipelines read the exports from the usual paths |
| 6 | Real project (only with Sambit's separate OK; the real project is not touched in PRs A–C) | Claude | Migrations 0019–0023 on the real project; final `import:topics` there; then `npx tsx --env-file=.env.real scripts/curriculum-cutover.ts --confirm` | Same as 2–4 |

A mistake can be undone with `npm run curriculum:cutover -- --revert` (audited). CMS edits made in the meantime stay, but a workbook import may overwrite them.

## Decided (Sambit, 12 Nov 2026)

1. The final workbooks are kept as a frozen archive on the Mac; book text never enters the CMS or the export.
2. Exports stay in dated folders, and the latest is also published at the usual paths after the cut-over (`--publish`), with the source-mapping tabs (no evidence columns) because the Science pipeline reads the NCERT tab.
3. Master-workbook export from the CMS stays "Later".
4. Cut-over: not yet. Sambit gives the OK after seeing the dry-run list (step 2).

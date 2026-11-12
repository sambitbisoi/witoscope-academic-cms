# Curriculum cut-over: the CMS takes over from the topic workbooks (D5)

Agreed by Sambit on 12 Nov 2026 (`docs/queue-2026-11-12.md`, D5, option B). This is a one-time switch. **Nothing here has been run.** Claude stops before step 4 and waits for Sambit's OK.

## Before and after

| | Before the cut-over (now) | After the cut-over |
|---|---|---|
| Chapters, topics, Achievers rows | Come from the three workbooks through `npm run import:topics`. The CMS forms show them read-only | Added and edited in the CMS (Curriculum → + Add chapter / + Add topic; Edit topic on the topic screen). `import:topics` refuses to run |
| NCERT source registry | `npm run import:sources` reads the workbooks' "NCERT (CBSE)" sheets | Kept in the CMS: `import:book` and every chapter import register books and citations (D7); Sources → + Add a citation by hand. `import:sources` refuses to run |
| Topic classes (D2), prerequisites (D4), concepts, question types, patterns | Already CMS data: editable now | Same |
| The workbooks | The source | Read-only exports: `npm run export:topics` (or Export to Excel on the Curriculum page, local mode) writes them to `~/WitoScope/ContentResearch/CMS-exports/<date>/` |

`cms_config.curriculum_owner` (`workbooks` or `cms`) holds the switch. `cms_save_curriculum` and the two importers check it.

## Steps

| # | Step | Who | Command / where | Must show |
|---|---|---|---|---|
| 1 | Confirm the workbooks are final: the Math data thread's workbook fixes (e.g. C2) are done, and nothing else is pending in Science or English | **Sambit** | — | "workbooks are final" |
| 2 | Final workbook import, local: dry run, then for real | Claude | `npm run import:topics -- --dry-run`, then `npm run import:topics` | No errors. On 12 Nov the dry run showed **2 new and 30 updated topics** since the last import (#4, 8 Nov) |
| 3 | Check readiness, local | Claude | `npm run curriculum:cutover` | "Workbooks on this Mac match the last import: yes" |
| 4 | **Switch, local** (after Sambit's OK) | Claude | `npm run curriculum:cutover -- --confirm` | "Done: the CMS owns chapters and topics". Logged in `cms_reviews` (`cms_config` · `curriculum_owner`) with the workbooks' sha256 |
| 5 | First export; keep the last workbooks | Claude + Sambit | `npm run export:topics`. Sambit keeps the final workbooks as an archive (they hold the source-evidence sheets NCERT (CBSE), DAV, IXL and IMO; those sheets are not in the CMS and are not exported) and points the content pipelines at the exports | Three files in `CMS-exports/<date>/` |
| 6 | Real project (only with Sambit's separate OK; the real project is not touched in PRs A–C) | Claude | Migrations 0019–0023 on the real project; final `import:topics` there; then `npx tsx --env-file=.env.real scripts/curriculum-cutover.ts --confirm` | Same as 2–4 |

A mistake can be undone with `npm run curriculum:cutover -- --revert` (audited). CMS edits made in the meantime stay, but a workbook import may overwrite them.

## Questions for Sambit

1. **Source-evidence sheets.** The workbooks' NCERT (CBSE), DAV, IXL and IMO sheets hold evidence text (DAV OCR, NCERT chapter text). Under the book rule that can't go into the CMS, so after the cut-over nobody maintains them. Keep the last workbooks as a frozen archive on the Mac, or should the data thread keep them in a separate file?
2. **Export location.** The exports go to `CMS-exports/<date>/`, so the originals are never overwritten. Should they later replace the files in `Math/`, `Science/` and `English/`, where the pipelines read them today?
3. **Achievers rows.** The workbooks don't list them (`import:topics` derives one per chapter and class). The export adds an "Achievers" sheet. Is that OK?

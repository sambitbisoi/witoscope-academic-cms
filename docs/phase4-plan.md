# Phase 4 plan: Chapter Sources tab (draft, waiting on D1)

9 Nov 2026. Sources: design §2E (source tables, which already exist since migration 0006), `docs/wireframe/Sources.dc.html`, CLAUDE.md ("Storage: only the private bucket `cms-sources`"; "book questions are internal references only").

## 1. What Phase 4 delivers

| Item | Detail |
|---|---|
| Sources tab | In the Topic workspace, per **chapter**: each source with its kind (PDF / scanned PDF / web / screenshots), publisher, class, the pages that cover the chapter, how many items are mapped, and *Open full screen ↗* |
| Jump links | "Open full screen at" section buttons (`cms_source_jumps`); PDFs open in the browser's own viewer at `#page=N` in a new tab, so two can sit side by side. The printed page and the PDF page are reconciled with `page_offset` |
| Web sources | IXL and SOF links open in a new tab; dated screenshot sets (`cms_source_assets`) open as a full-screen gallery |
| Add a source | "+ Add PDF, link or screenshots": a form with an explicit **Save** (title, publisher, kind, class; upload or URL; the chapters and page ranges it covers; jump labels). Optional fields sit behind "More" |
| Book items (optional, see D3) | Import `cms-book-chapter` files such as `QuestionBank/NCERT-C6-01/NCERT-C6-01.book.json` (42 items, 6 sections) into `cms_sources`, `cms_source_chapters`, `cms_source_jumps` and `cms_source_items`, so "n items mapped" and the question detail's source refs resolve |
| Never published | Nothing from sources ever leaves the CMS; the Phase 8 Publish step can't read these tables (this goes into the Phase 8 design) |

## 2. Decisions needed before building

| # | Decision | Options | My recommendation |
|---|---|---|---|
| **D1** | **How the browser reads and writes files in the private bucket.** Storage permissions are RLS policies on `storage.objects`, which lives **outside `cms`**. `cms_owner` can't create them, and CLAUDE.md forbids policies outside `cms` | (a) A one-time **bootstrap 02** that you run in the SQL editor. It creates the private bucket `cms-sources` (≤ 50 MB per file; PDF/PNG/JPEG/WebP only) and four policies on `storage.objects`, each limited to `bucket_id = 'cms-sources'` and to `cms.cms_is_admin(cms.cms_current_uid())`, so app users get nothing. It's added to `db-verify` and `check-migrations` stays strict. (b) **No Storage:** files stay on your Mac or Drive and the CMS stores only links. (c) An Edge Function signing URLs with `service_role`: **ruled out** by CLAUDE.md | **(a)**: it's the bucket CLAUDE.md already names; the policies touch only that bucket; you run it, as with bootstrap 01 |
| D2 | The first browser **write** grants | `authenticated` gets INSERT/UPDATE (no DELETE) on `cms_sources`, `cms_source_chapters`, `cms_source_jumps`, `cms_source_assets`, plus their sequences; still admin-only through RLS; every save is logged in `cms_reviews` | Proceed: inside `cms` and follows the design; noted so it doesn't surprise you |
| D3 | Import book items now (Phase 4) or with source extraction (Phase 7)? `NCERT-C6-01.book.json` says `attribute_version: "v11"`, which isn't loaded in the CMS yet | Now: only the source and item rows (the item text stays internal), with no v11 tagging fields. Later: Phase 7 | Now, without the v11 fields, so the Sources tab shows real mapped counts |

## 3. Work items (after D1)

| # | Item | Size |
|---|---|---|
| 1 | `db/bootstrap/02-storage.sql` (for you to run) + `db-verify` storage checks | S |
| 2 | Migration 0011: write grants (D2) + a view of source counts per chapter (security_invoker) | S |
| 3 | Sources tab (list, open at page, gallery) | M |
| 4 | Add / edit source form with Save, upload to `cms-sources/<source_id>/…` | M |
| 5 | `import:book` for `cms-book-chapter/0.1` files (D3) + tests | M |
| 6 | Tests: storage RLS (an app user can't list or read objects), UI smoke tests, screenshots | S |

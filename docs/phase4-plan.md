# Phase 4 plan: Chapter Sources tab

Decisions (Sambit, 9 Nov): ~~D1 = a (Supabase Storage)~~ → **files in a private Cloudflare R2 bucket `cms-sources`**, served by a Pages Function that validates the Cloudflare Access JWT and issues short-lived signed URLs; Supabase keeps only text, metadata and each file's R2 key; a local stand-in in dev; first real upload Class 6 Math only. **D2 go ahead**. **D3 import the source and item rows now, without the v11 fields**. PDF sizes checked: no splitting needed (see §4).

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
| 1 | ~~`db/bootstrap/02-storage.sql`~~ → R2 file service (Pages Function) + local stand-in | S |
| 2 | Migration 0011: write grants (D2) + a view of source counts per chapter (security_invoker) | S |
| 3 | Sources tab (list, open at page, gallery) | M |
| 4 | Add / edit source form with Save, upload to `cms-sources/<source_id>/…` | M |
| 5 | `import:book` for `cms-book-chapter/0.1` files (D3) + tests | M |
| 6 | Tests: storage RLS (an app user can't list or read objects), UI smoke tests, screenshots | S |

## 4. As built (9 Nov)

| Item | Result |
|---|---|
| PDF sizes | 83 NCERT Math PDFs on this Mac, already one per chapter, largest 23.4 MB (limit 50 MB): no splitting. No DAV scans on this Mac yet (checklist D7) |
| Files (R2) | `functions/api/files/[[path]].ts` (Pages Function, R2 binding `CMS_SOURCES`): `sign` and `put` require a valid Access JWT (RS256 from the team's keys, AUD, issuer, expiry, allowed email); `get` serves a file only with a 5-minute HMAC-signed link; no list, no delete; PDF/PNG/JPEG/WebP ≤ 50 MB. 18 tests incl. refusal without Access; builds with wrangler 4.151.2. Local stand-in: `npm run dev:files` (same code, folder bucket `.r2-local/`, local Access key; Vite adds the token). Supabase Storage dropped (bootstrap 02 removed; never run on the real project) |
| Migration 0011 | Write grants (D2) in one checked list (`scripts/lib/grants.ts`); audit-log inserts; `cms_chapter_sources` view. Local and real; `db-verify` passes on both |
| `import:sources` | 180 NCERT chapter PDFs (Math 77, Science 44, English 59), 647 chapter links. Local and real |
| `import:book` | NCERT-C6-01: 42 items, 7 jumps (6 sections + Answers), PDF page range on MC27. Accepts book schema 0.1 and 0.2. Local and real |
| `upload:sources` | Local: 77 PDFs into the R2 stand-in. Real: `wrangler r2 object put --remote` under Sambit's Cloudflare login, first batch `--class 6 --subject math` (10 PDFs, 21.7 MB): checklist D6–D7 |
| UI | Sources tab (open at page via 5-minute signed URLs from `/api/files`, jumps, gallery, add/edit with Save + audit; uploads through `/api/files/put`); question detail resolves source refs to book items. End to end in Chrome against the stand-in |
| Tests | 160 unit (incl. 18 file-service/Access), 45 database (app-user writes refused by RLS); end-to-end Sources flow in Chrome |

Guesses, all listed in the PR:
- **P1:** a source's ID is `NCERT-<pdf file stem>`, e.g. `NCERT-fegp101`.
- **P2:** registered sources open their public NCERT link until the file is uploaded; after that the private file wins.
- **P3:** page ranges and jumps are stored as PDF pages (printed page + offset).
- **P4:** a book file sets page ranges only on the chapters its items are placed in; registry links stay.
- **P5:** item snapshot images (book schema 0.2) aren't imported yet.
- **P6:** an item's kind, label, section and assessable flag aren't stored, because the design has no column for them; they stay in the book file.
- **P7:** sources sort NCERT, DAV, IXL, SOF, other, with the topic's class first.
- **P8:** the form suggests an ID from publisher + title, editable under *More* and permanent after Save.
- **P9:** edits can add jumps and change pages, but not remove jumps.
- **P10:** replacing a file overwrites the same R2 key; there's no delete or list.
- **P11:** the tab shows the sources of the topic's chapter.
- **P12:** signed links last 5 minutes and are HMAC-signed by the function itself (via the R2 binding), not R2's own presigned URLs, so no R2 API keys exist anywhere.
- **P15:** the function checks the email in the Access JWT against `ACCESS_ALLOWED_EMAILS`, on top of the Access policy; service tokens (no email) are refused.
- **P16:** `storage_path` (sources, assets) and `image_path` (versions) hold the R2 key; the columns weren't renamed.
- **P17:** real uploads go through `wrangler r2 object put` under Sambit's own Cloudflare login, rather than through the function with a service token.
- **P13:** a browser save is upload → rows → audit, not one transaction; errors are shown, and a failed save can leave an unused file.
- **P14:** DAV isn't registered until the scans exist.

# WitoScope Academic CMS — rules for Claude

Internal, single-user tool for managing the question bank (Class 1–6 Math, Science, English Grammar) of the WitoScope kids app. Not public, not indexed.

Design source of truth: `docs/phase1-design.md` (approved 8 Nov 2026). Question attribute rules: WitoScope Question Attributes **v11** (current since 10 Nov 2026; v10 stays loaded alongside; the current version is `cms_config.current_rule_version`). Chapter file format: `schema/chapter.schema.json`.

## Database isolation (hard rules — never break)
- Everything lives in schema `cms`; every table is prefixed `cms_` (e.g. `cms.cms_questions`).
- Never CREATE, ALTER, DROP, GRANT or write anything outside `cms`. No foreign keys, views, triggers, functions or policies that reference `public`, `app`, or any other schema. The only outside reference allowed is Supabase's built-in `auth.uid()` in RLS policies.
- The `scripts/check-migrations` check must pass; it rejects any migration that names another schema.
- Migrations and server functions connect as role `cms_owner` (rights on `cms` only), never with `service_role`.
- RLS is enabled on every table and allows only the admin user ID stored in `cms_config`.
- Files: only our own figure images, in the private **Cloudflare R2** bucket `cms-sources` under `figures/`. Supabase keeps only text and metadata, with each file's R2 key. Files are reached only through the `/api/files` Pages Function, which validates the Cloudflare Access JWT, issues short-lived signed URLs and refuses PDFs and any key outside `figures/`. No Supabase Storage.
- Publishing to the app (Phase 8) is designed separately and needs Sambit's explicit approval.

## Book material rule (Sambit, 10 Nov 2026)
**This section is the single source for this rule.** The pipeline brief (`~/WitoScope/ContentResearch/QuestionBank/_pipeline/BRIEF.md`), `claude/question-bank/generation-prompt.md`, the design doc and the Phase 7 plan point here; if any of them disagrees, this section wins.
- **Book material** means third-party book content: NCERT/DAV/IXL/SOF PDFs, scans, page images and renders, screenshots, extracted or OCR item text, the book's numbers, book snapshots, `*.book.json` files, and review packs or workbooks that contain source questions.
- **It stays on Sambit's Mac.** It is never stored in or uploaded to anything outside the Mac: Supabase, R2, GitHub, a claude.ai chat or Project, memory, artifacts or any other cloud service. Never attach or paste it into a chat; give its path on the Mac instead.
- **AI threads may read the book PDFs on the Mac** (`pdftotext`, page renders, local OCR) to extract items, solve them and write twins, as the pipeline workers do. The text passes through the model only to be processed; nothing book-derived is written or uploaded outside the Mac.
- **Only our own content leaves the Mac:** questions in our own wording, names and numbers, and images we drew. Besides that, the cloud holds only bare citations (book, class, chapter, page, section, exercise/item number) and official public links (e.g. ncert.nic.in). `db:verify` checks the citation-only shape.
- Chat threads outside the Mac (the Claude Project's question-generation threads) therefore get no book material. They work from citations, topic names, patterns and the current rules (`claude/question-bank/generation-prompt.md`).
- The originality (copy-from-book) check runs only on the Mac (`npm run check:originality`) before every import; the CMS records only its result and citations. A near-copy blocks the import; moderate similarity is a warning. A near-copy draft is approved only with the logged "override: reviewed, not a copy".
- Book questions (NCERT, DAV, IXL, SOF) are internal references only; they never reach the app.

## Content rules
- Order (13 Nov 2026) is stored per class in `cms_strand_order` / `cms_chapter_order` / `cms_topic_order`, never on the item; numbers (1. / 1.2 / 1.2.3) are computed from it with no gaps. Show names first and IDs last (muted).
- Terminology (Sambit, 13 Nov 2026): **strand → chapter → topic**. The child sees strand then topic; our chapter is an internal grouping. A topic–class link is **core** (the topic's home class) or extra (**from a lower / higher class**); Browse shows core by default.
- Gold questions (`bank = 'gold'`) are never publishable.
- IDs are permanent and never reused. Class is a field, never derived from an ID.
- Versioning: typo fix = same version (logged); any change to numbers, options, answers, format, parts, concepts, tags, signature, topic/set/pattern or image = new version.
- Catalogue rows are never deleted: retire, deactivate or merge.
- Questions added by hand or uploaded in the CMS (13 Nov 2026) start as Needs review with attributes and originality pending; they can't be approved until `npm run check:originality -- --pending` has run on the Mac (it records only citations and scores). No production question can be approved while its picture or attributes are pending: "Approved" means ready for the app.
- **The CMS owns the curriculum** (D5, Sambit, 12 Nov 2026; replaces the old "workbooks are the source of truth" rule). Chapters, topics (Achievers rows included), concepts, typical sets and patterns are added and edited in the CMS with forms and an explicit Save, through `cms_save_curriculum`: IDs are given by the CMS and never change; nothing is deleted (Retire hides a row and keeps its ID and history); every change is audited before → after; new concepts, typical sets and patterns start Proposed. The topic screen also sets a topic's other classes and its prerequisites. The workbooks (`WitoScope_{Math,Science,English_Grammar}_Topics_Class1-6.xlsx`) become read-only exports for the content pipelines (`npm run export:topics`). **One-time cut-over:** until Sambit confirms the workbooks are final and the final workbook import is done, chapters and topics still come from `import:topics` (`cms_config.curriculum_owner = 'workbooks'`); the switch is `npm run curriculum:cutover -- --confirm` (`docs/curriculum-cutover.md`), after which `import:topics` and `import:sources` refuse to run.

## How Sambit works
- Size and plan each phase in tables and get his confirmation before writing code. Propose UI changes with screenshots before committing.
- Flag anything guessed or inferred.
- Explicit Save buttons, no auto-save. Secondary features are best-effort and must never break the main flow.
- Clean, simple screens; optional settings behind a "More" link.
- Git: feature branch per phase, small commits, PR into `main` for Sambit to approve.
- Secrets (Supabase keys, DB passwords, Claude API key) never go in the repo; AI calls run server-side only, in the `/api/ai` Pages Function behind Access, which holds only the Claude API key (no database credentials in the cloud).

## Stack
React + TypeScript + Vite · Supabase (Postgres, Auth) · AI via a Cloudflare Pages Function (Claude API, Batch API for bulk) · imports run locally · Cloudflare Pages (+ Pages Functions) behind Cloudflare Access · Cloudflare R2 for files.

## Phases
1. Data model + JSON schema — **done**
2. Repo setup, migrations, login, import of topic master lists and the v10 seed, JSON chapter importer with validation and error report
3. Browse: Home, Topic workspace, question detail
4. Chapter Sources tab (citations and official links only)
5. Edit + review + versions
6. Generate similar / fill a typical set (Claude API)
7. New source → extract → tag → match, **local-only** (`docs/phase7-plan.md`; no book text in the cloud)
8. Publish to the app as numbered releases, with rollback

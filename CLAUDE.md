# WitoScope Academic CMS — rules for Claude

Internal, single-user tool for managing the question bank (Class 1–6 Math, Science, English Grammar) of the WitoScope kids app. Not public, not indexed.

Design source of truth: `docs/phase1-design.md` (approved 8 Nov 2026). Question attribute rules: WitoScope Question Attributes **v10**. Chapter file format: `schema/chapter.schema.json`.

## Database isolation (hard rules — never break)
- Everything lives in schema `cms`; every table is prefixed `cms_` (e.g. `cms.cms_questions`).
- Never CREATE, ALTER, DROP, GRANT or write anything outside `cms`. No foreign keys, views, triggers, functions or policies that reference `public`, `app`, or any other schema. The only outside reference allowed is Supabase's built-in `auth.uid()` in RLS policies.
- The `scripts/check-migrations` check must pass; it rejects any migration that names another schema.
- Migrations and server functions connect as role `cms_owner` (rights on `cms` only), never with `service_role`.
- RLS is enabled on every table and allows only the admin user ID stored in `cms_config`.
- Storage: only the private bucket `cms-sources`.
- Publishing to the app (Phase 8) is designed separately and needs Sambit's explicit approval.

## Content rules
- Book questions (NCERT, DAV, IXL, SOF) are internal references only; they never reach the app.
- Gold questions (`bank = 'gold'`) are never publishable.
- IDs are permanent and never reused. Class is a field, never derived from an ID.
- Versioning: typo fix = same version (logged); any change to numbers, options, answers, format, parts, concepts, tags, signature, topic/set/pattern or image = new version.
- Catalogue rows are never deleted: retire, deactivate or merge.
- Topic master lists (the workbooks) are the source of truth for strands, chapters and topics; the CMS never edits them, only re-imports.

## How Sambit works
- Size and plan each phase in tables and get his confirmation before writing code. Propose UI changes with screenshots before committing.
- Flag anything guessed or inferred.
- Explicit Save buttons, no auto-save. Secondary features are best-effort and must never break the main flow.
- Clean, simple screens; optional settings behind a "More" link.
- Git: feature branch per phase, small commits, PR into `main` for Sambit to approve.
- Secrets (Supabase keys, DB passwords, Claude API key) never go in the repo; AI calls run server-side only.

## Stack
React + TypeScript + Vite · Supabase (Postgres, Auth, Storage; pgvector later) · Supabase Edge Functions for AI and import jobs · Cloudflare Pages behind Cloudflare Access.

## Phases
1. Data model + JSON schema — **done**
2. Repo setup, migrations, login, import of topic master lists and the v10 seed, JSON chapter importer with validation and error report
3. Browse: Home, Topic workspace, question detail
4. Chapter Sources tab
5. Edit + review + versions
6. Generate similar / fill a typical set (Claude API)
7. Upload a new source → extract → tag → match
8. Publish to the app as numbered releases, with rollback

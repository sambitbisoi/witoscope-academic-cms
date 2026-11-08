# Phase 2 plan — repo setup, migrations, login, imports

Approved by Sambit, 8 Nov 2026, with the changes recorded below. Branch: `phase-2-setup-import`.

Items marked **[guess]** are inferred and need Sambit's check.

## 1. Work items

| # | Item | Output |
|---|---|---|
| 1 | Repo setup | Vite + React + TS app in `web/`, scripts in `scripts/`, Vitest, `.env.example` (no secrets) |
| 2 | Bootstrap SQL (Sambit runs once, as `postgres`) | `db/bootstrap/01-cms-owner.sql` |
| 3 | Migration runner + `check-migrations` | `scripts/migrate.ts`, `scripts/check-migrations.ts`; history in `cms.cms_schema_migrations` |
| 4 | Table migrations | 37 of the 39 design tables (`cms_releases`, `cms_release_items` deferred to Phase 8) |
| 5 | RLS + `cms.cms_is_admin()` | One policy pattern on every table |
| 6 | Login | Email + password, "not authorised" screen, empty Home |
| 7 | Topic list import | Strands, chapters, topics, `ACH-<chapter>-<class>` rows |
| 8 | v10 seed import | From the v10 **.xlsx** directly (not CSV copies) |
| 9 | Chapter importer | `validate` (dry run) and `import`, with `--force-new-version` |
| 10 | Imports screen | Read-only import history and error report (screenshots before commit) |
| 11 | Tests | §8 checks, §4 derived fields, RLS (anon / app user / admin), check-migrations |

## 2. Decisions (approved 8 Nov 2026)

| # | Decision |
|---|---|
| 1 | `cms_owner` is created by a one-time bootstrap script, not a migration. ~~Grants on `auth`~~ removed (8 Nov, option 1/A): `postgres` cannot grant USAGE on `auth`, and `cms_owner` needs none. `grant cms_owner to postgres;` added (approved). Must verify `cms_owner` connects through the Supabase pooler. |
| 2 | Own migration runner; history in `cms.cms_schema_migrations`. The Supabase CLI is used only for the local dev database. |
| 3 | `authenticated` gets USAGE on `cms` and table grants; RLS denies everyone but the admin. **`anon` gets no USAGE on `cms`.** |
| 4 | **Option A (approved 8 Nov).** `cms.cms_current_uid()`: `security invoker`, `stable`, empty `search_path`; reads the JWT claim exactly like `auth.uid()`; missing or malformed claim → null → deny. `cms.cms_is_admin(uuid)`: `security definer`, `stable`, empty `search_path`, owned by `cms_owner`. Both: `revoke execute ... from public`, `grant execute ... to authenticated` only. Every policy: `using (cms.cms_is_admin((select cms.cms_current_uid())))`. Tests: anon nothing, app user zero rows, admin sees rows, and `cms_current_uid() = auth.uid()` for a real signed-in session (locally now; on the hosted project before exposing `cms`). |
| 5 | Re-import with an open version: replace the open draft **only if it was created by an import and not edited since**; otherwise block that question with an error. Every replacement is logged in `cms_reviews`. |
| 6 | Typo detection: typo only if all structured fields are identical and the numbers in text, solutions and hints are unchanged **[guess, approved as the rule]**. `--force-new-version` overrides it and always creates a new version. |
| 7 | One transaction per file; blocked questions skipped, result `partial`. `validate` is a dry run. |
| 8 | Derived-field config (multi-step bands, difficulty points, load thresholds) is loaded from the v10 workbook sheets **Derived Attributes** and **Engine Check**. |
| 9 | Importers run locally (CLI) and record the git commit; the web app shows results. |
| 10 | Login is email + password with Sambit's existing account (no auth-setting changes). |
| 11 | Storage bucket and its policies wait for Phase 4. Cloudflare Pages + Access is Phase 3. |

## 3. Turning on "exposed schemas" for `cms`

Do this on the real project **only after all of the following**:

1. Bootstrap has run and its verification query returns all `true`.
2. All migrations are applied to the real project by `npm run db:migrate` (as `cms_owner`).
3. `npm run db:verify` against the real project passes: RLS is enabled on every `cms` table, `anon` has no USAGE on `cms`, and `cms_config.admin_user_id` is set.
4. `npm run verify:uid -- hosted`: sign in as Sambit, paste the printed SQL into the SQL editor, and `matches` is `true` (cms_current_uid() = auth.uid() for a real session). Works without `cms` exposed.

Then: Dashboard → Project Settings → Data API → Exposed schemas → add `cms` → Save. Then sign in to the local web app against the real project. The exact moment will also be called out in the PR checklist. (Locally, `cms` is exposed via `supabase/config.toml`.)

## 4. Source files

| What | Path | Notes |
|---|---|---|
| Topic lists | `~/WitoScope/ContentResearch/Math/WitoScope_Math_Topics_Class1-6.xlsx`, `.../Science/WitoScope_Science_Topics_Class1-6.xlsx`, `.../English/WitoScope_English_Grammar_Topics_Class1-6.xlsx` | Sheet **Class View** (Class, Seq, Strand, Chapter ID, Chapter, Topic ID, Topic, Level, Sub-skills, …). Names differ from `Topics.xlsx`. |
| v10 workbook | `~/WitoScope/ContentResearch/QuestionBank/` | **Not found there yet** (8 Nov). |

### What the topic lists contain (checked 8 Nov)

| Fact | Detail |
|---|---|
| Rows in Class View | Math 515, Science 350, English 184; each topic appears in exactly one class |
| Strand codes | In **Master Chapters** → "Strand Code": Math NUM OPS NT FDP COM ALG GEO MEA DAT LR; Science LIV HUM FOD MAT RES ENV EAR PHY SKL LR; English SEN POS VRB MEC VOC |
| Code collision | `LR` is used by both Math and Science |
| Retired topics | ST0158 (Science) and GT0011 (English): in Master Topics with Status = Retired, absent from Class View |
| Source flags | Master Topics columns "Classes – NCERT / DAV / IXL / IMO (ISO)", "–" = none |

## 5. Open questions

| # | Question | Status |
|---|---|---|
| A | v10 workbook | Path given: `~/WitoScope/ContentResearch/QuestionBank/WitoScope_Question_Attributes_v10.xlsx`. **Not present there yet** (checked 8 Nov). Use only this file; never v2 or the witoscope-app repo. |
| B | Strand ID | **Approved:** `<subject>-<code>` (`math-LR`, `science-LR`, `grammar-SEN`) |
| C | Retired topics | **Approved:** imported as `retired`; class from Reference Grade (Math/Science) or Class (placement) (English) |
| D | `taught_in_school` | **Approved:** NCERT or DAV column not "–" |
| E | Docker | **Approved:** local Supabase for development |
| F | Sambit's auth user ID; password set? | Waiting (placeholders came through unfilled) |
| G | `auth` USAGE cannot be granted by `postgres` | Resolved: option A (§2, decision 4) |
| H | Which Achievers rows to create | **Approved 8 Nov:** one `ACH-<chapter>-<class>` per chapter-class pair with at least one active topic, named "Achievers: <chapter name>", **Math only for now** (183 rows). Science and English get them once they have an Achiever rule. |

## 6. Bootstrap findings (local Supabase, Postgres 17, 8 Nov)

| Finding | Effect |
|---|---|
| `postgres` must be a member of `cms_owner` to make it the schema owner (PG16+) | Added `grant cms_owner to postgres;` to the bootstrap. Gives `cms_owner` nothing. |
| Schema `auth` is owned by `supabase_admin`; `postgres` has USAGE **without grant option** | `grant usage on schema auth to cms_owner` is silently ignored (warning only). `cms_owner` cannot resolve `auth.uid()`, so `cms_is_admin()` as designed cannot be created. Decision needed. |
| `auth.uid()` EXECUTE is already granted to PUBLIC | The explicit EXECUTE grant is a no-op but harmless. |
| Option 1 chosen (policies pass `(select auth.uid())` into `cms_is_admin(uuid)`); both auth grants removed from the bootstrap | `cms_is_admin(uuid)` works. **But creating a policy that names `auth.uid()` also needs USAGE on `auth` for the creating role (`cms_owner`)**, so 0008 fails with "permission denied for schema auth". Tested in a rolled-back transaction: a policy reading the JWT claim (`current_setting('request.jwt.claims', true)` → `sub`) can be created by `cms_owner`. Decision needed. |
| Port clash with witoscope-app | witoscope-app's local Supabase owns ports 5432x. This repo now uses **5542x** (`supabase/config.toml`), and scripts refuse any local port not served by `supabase_db_witoscope-academic-cms`. |
| Incident, 8 Nov | Before the port change, the bootstrap and migrations 0001–0007 ran by mistake in **witoscope-app's local dev database** (this repo's `supabase start` had failed on the port clash, and the error was hidden). Footprint: role `cms_owner`, schema `cms` (38 tables + their TOAST tables), `grant cms_owner to postgres`. Nothing outside `cms` was changed. Removed in one transaction (`drop schema cms cascade; drop owned by cms_owner; revoke; drop role`); verified both gone. Production was never touched. |

## 7. Topic import (`npm run import:topics`, local, 8 Nov)

| Table | Rows |
|---|---|
| `cms_strands` | 25 (Math 10, Science 10, English 5); `LR` → `math-LR`, `science-LR` |
| `cms_chapters` | 157 (58 / 58 / 41) |
| `cms_topics` | 1,051 workbook topics (1,049 active, 2 retired: ST0158, GT0011, class 4) + 183 Math Achievers rows |
| `taught_in_school` | Math 456, Science 316, English 124 |

Behaviour: whole run in one transaction; `--dry-run` rolls back. Re-import inserts new rows, updates changed rows with a `cms_reviews` row (`edit_catalogue`, or `retire` / `restore` for status changes, with before/after), and never deletes; rows missing from the workbook are reported. Every run is recorded in `cms_imports` with file hashes and the git commit. Workbooks: zero warnings.

Achievers change, 8 Nov: the first local import created 444 Achievers rows. On Sambit's instruction the 261 Science and English rows were deleted (one transaction, as `cms_owner`, local only; checked first that no question, concept, prerequisite, typical set, pattern, source item or review referenced them). This is an approved one-off exception to "never delete"; the real project never had them. Rule added to CLAUDE.md: the topic workbooks are the source of truth for strands, chapters and topics; the CMS only re-imports.

# Phase 2 runbook: setting up the real project

Every step here touches the real Supabase project, so each one needs Sambit's go-ahead. Run the steps in order and stop at the first failure. Secrets (the `cms_owner` password, your login password) live only in your password manager and in the git-ignored `.env.real`. They never go in the repo or in chat. Real-project commands always name `--env-file=.env.real` explicitly; `npm run …` scripts and the database tests stay local.

| # | Step | Who | Command / where | Must show |
|---|---|---|---|---|
| 1 | Bootstrap: create `cms_owner`, schema `cms`, grants | Sambit | SQL editor: paste `db/bootstrap/01-cms-owner.sql`, replace `CHANGE_ME` with a new strong password, run. Don't save the edited file. | Final row: every column `true` |
| 2 | Point the scripts at the real project | Sambit | Create **`.env.real`** (git-ignored; keep `.env` for local): `CMS_DATABASE_URL=postgres://cms_owner.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres` (pooler, session mode) | — |
| 3 | `cms_owner` connects through the pooler | Claude | `npx tsx --env-file=.env.real scripts/db-ping.ts` | `current_user: cms_owner`, `cms_create: true`, `auth_usage: false`, `public_create: false`, "via … (pooler)" |
| 4 | Migrations | Claude | `npm run check-migrations && npx tsx --env-file=.env.real scripts/migrate.ts` | 9 applied |
| 5 | Admin user | Claude | `npx tsx --env-file=.env.real scripts/set-admin.ts <your auth user ID>` | `admin_user_id = …` |
| 6 | Topic lists | Claude | `npx tsx --env-file=.env.real scripts/import-topics.ts --dry-run`, then without `--dry-run` | 25 strands · 157 chapters · 1,234 topics (1,051 + 183 Math Achievers) |
| 7 | v10 seed | Claude | `npx tsx --env-file=.env.real scripts/import-seed.ts --dry-run`, then without `--dry-run` | 77 gold, 0 blocked, the 8 known warnings |
| 8 | Safety checks | Claude | `npx tsx --env-file=.env.real scripts/db-verify.ts` | "all checks passed" |
| 9 | `cms_current_uid()` = `auth.uid()` for a real session | Sambit + Claude | In your shell: `CMS_VERIFY_EMAIL=… CMS_VERIFY_PASSWORD=… VITE_SUPABASE_URL=… VITE_SUPABASE_ANON_KEY=… npx tsx scripts/verify-uid.ts hosted`, then paste the printed SQL into the SQL editor | `matches = true` |
| 10 | **Expose schema `cms`** (only after 1–9) | Sambit | Dashboard → Project Settings → Data API → Exposed schemas → add `cms` → Save | — |
| 11 | Sign in | Sambit | `web/.env.local` with the project URL and anon key; `npm run dev -w web`; sign in at http://127.0.0.1:5199 | Home, then Imports lists the runs from steps 6–7 |
| 12 | A non-admin account sees nothing | Sambit | Sign in with any other account | "… can't use the CMS." |

To roll back before step 10, run `drop schema cms cascade; drop owned by cms_owner; revoke cms_owner from postgres; drop role cms_owner;` in the SQL editor. That removes everything the CMS created. Nothing outside `cms` is ever touched.

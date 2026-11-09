# Things only Sambit can do

This is one running list of dashboard and login steps that Claude can't do. Do them in order, and tell Claude the result of each one. Secrets (passwords, keys) never go in chat or in the repo.

## A. Finish Phase 2 on the real project (runbook steps 9–12)

Steps 1–8 are done (9 Nov): bootstrap, pooler connection, 9 migrations, admin ID, topic lists, v10 seed, and `db-verify` with all 16 checks passing.

| # | Where | Exact steps | Expected result |
|---|---|---|---|
| A1 | *(optional)* Supabase → SQL editor | Run `select id, email, created_at from auth.users where id = '<CMS_ADMIN_USER_ID from .env.real>';` (read-only). Claude can't read `auth.users`, so this is the only direct check that the ID exists. | One row, with your email |
| A2 | Supabase → Project Settings → **API** | Copy the **Project URL** and the **anon public** key into `.env.real` as `VITE_SUPABASE_URL=…` and `VITE_SUPABASE_ANON_KEY=…`. Both are public by design. | — |
| A3 | Terminal, in the repo | `export CMS_VERIFY_EMAIL='<your login email>'`, then `read -s CMS_VERIFY_PASSWORD && export CMS_VERIFY_PASSWORD` (type your password; it isn't shown or saved in shell history), then `npx tsx --env-file=.env.real scripts/verify-uid.ts hosted` | "Session user ID = CMS_ADMIN_USER_ID", followed by a block of SQL |
| A4 | Supabase → SQL editor | Paste the SQL block from A3 and run it. It changes nothing (it ends in `rollback`). Don't save or share it; it contains your session claims. | One row: `matches = true` **and** `is_admin = true` |
| A5 | Supabase → Project Settings → **Data API** → *Exposed schemas* | **Only after A3 and A4 pass.** Add `cms` to the list and click Save. | `cms` appears in the list |
| A6 | Repo | Create `web/.env.real.local` with the same two `VITE_…` lines as A2 (git ignores it). Run `npm run dev -w web -- --mode real` and open http://127.0.0.1:5199 | The sign-in page |
| A7 | Browser | Sign in with your account | Home appears; **Imports** lists the topic import and seed import from 9 Nov |
| A8 | Browser | Sign out, then sign in with any other account, for example a test user of the app | "… can't use the CMS." |

If A4 shows `false`, or A8 shows anything other than "can't use the CMS", stop and tell Claude. To undo A5, remove `cms` from Exposed schemas.

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

## B. Cloudflare Pages: build and host the CMS (Phase 3)

Do A1–A5 first: the deployed site only works once `cms` is exposed. Do **C right after B1**, before sharing or using the URL.

| # | Where | Exact steps | Expected result |
|---|---|---|---|
| B1 | Cloudflare dashboard → **Workers & Pages** → Create → **Pages** → *Connect to Git* | Authorise GitHub for the repo `sambitbisoi/witoscope-academic-cms` only. Project name: e.g. `witoscope-cms` (this gives `witoscope-cms.pages.dev`). Production branch: `main` | Project created |
| B2 | Same screen, *Build settings* | Framework preset **None**. Build command `npm ci && npm run build -w web`. Build output directory `web/dist`. Root directory: leave empty | — |
| B3 | Same screen, *Environment variables* (Production **and** Preview) | `NODE_VERSION` = `22`; `VITE_SUPABASE_URL` = the Project URL; `VITE_SUPABASE_ANON_KEY` = the anon key (both public by design). **Never** the service_role key | Save and deploy; the build log ends with "Success" |
| B4 | Pages project → Settings → *Builds & deployments* → **Preview branch control** | Choose *None* (only `main` deploys), or *Custom* if you want branch previews; Access covers both | — |

## C. Cloudflare Access: only you can open the CMS (Phase 3)

| # | Where | Exact steps | Expected result |
|---|---|---|---|
| C1 | Cloudflare **Zero Trust** → Access → **Applications** → Add an application → **Self-hosted** | Name `WitoScope CMS`. Session duration 24 h. Application domains: add **both** `witoscope-cms.pages.dev` and `*.witoscope-cms.pages.dev` (use your project name from B1) | — |
| C2 | Same wizard → **Policies** | Add a policy: name `Sambit only`, Action **Allow**, Include → **Emails** → your email. No other rules | — |
| C3 | Same wizard → *Login methods* | Keep **One-time PIN** (needs no other setup) | Application saved |
| C4 | Private browser window | Open `https://witoscope-cms.pages.dev` | Cloudflare's Access page asks for your email; after the PIN you see the CMS sign-in |
| C5 | Private browser window | Try the same URL with any other email | Access refuses it; the CMS is never shown |
| C6 | Terminal | `curl -sI https://witoscope-cms.pages.dev` | A redirect to `…cloudflareaccess.com` (not the app) |

Optional, later: a custom domain (Pages → Custom domains), then add it to the Access application as well.

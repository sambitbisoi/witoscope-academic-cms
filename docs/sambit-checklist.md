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

## D. Cloudflare R2: only for our own figure images (changed 10 Nov 2026)

**New rule:** book PDFs, scans and screenshots never go to the cloud; they stay on your Mac. R2 now holds only **our own figure images** (under `figures/`), and the file function refuses PDFs and anything outside `figures/`. No figure images are uploaded yet, so **D1–D5 can wait** until figures arrive. They are harmless if already done. D6 and D7 (the PDF upload) are **removed**.

Already done by Claude on the real project (inside `cms` only): migration 0015 removed the 42 NCERT-C6-01 item texts and numbers (logged; the rows remain as citations), and the NCERT source registry is citations plus ncert.nic.in links.

| # | Where | Exact steps | Expected result |
|---|---|---|---|
| D0 | Cloudflare dashboard → **R2 Object Storage** | Only if you created `cms-sources` earlier: open it and check the object count | **0 objects** (you skipped D7, so no book PDF was uploaded). If anything is there, tell Claude before deleting |
| D1 | *(later, when figure images arrive)* Cloudflare dashboard → **R2 Object Storage** | **Create bucket** → name `cms-sources`, location *Automatic*, storage class *Standard*. Leave **public access off** (no r2.dev subdomain, no custom domain) | Bucket `cms-sources`, *Public access: Disabled* |
| D2 | *(later)* Pages project → **Settings → Bindings** → Add → **R2 bucket** | Variable name `CMS_SOURCES`, bucket `cms-sources`, for **Production** and **Preview** | Binding listed |
| D3 | Zero Trust → Access → **Applications** → `WitoScope CMS` (from C1) | Copy the **Application Audience (AUD) Tag**, and note your **team domain** (`<team>.cloudflareaccess.com`) under Zero Trust → Settings | Both copied |
| D4 | Pages project → **Settings → Variables and secrets** (Production **and** Preview) | Plain-text variables `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `ACCESS_ALLOWED_EMAILS` (your email). These are also used by `/api/ai`, so **do D3–D4 now** for Phase 6. The **Secret** `FILES_SIGNING_KEY` (`openssl rand -base64 48`) can wait with D1. Then **Deployments → latest → Retry deployment** | The new deployment succeeds |
| D5 | Terminal | `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' 'https://<project>.pages.dev/api/files/sign?key=x'` | `302` to `…cloudflareaccess.com…` |
| ~~D6~~ | — | ~~`wrangler login`~~: removed (only the PDF upload needed it) | — |
| ~~D7~~ | — | ~~Upload Class 6 Math PDFs to R2~~: **removed** (book files stay on the Mac) | — |
| D8 | CMS (deployed) → Browse → Class 6 Math → a topic in MC27 → **Sources** | Check "Ganita Prakash … Ch 1": its sections show as text with page numbers; click **Official PDF ↗** and a section's page link | ncert.nic.in opens in a new tab at that page; there is no upload field anywhere |
| D9 | Finder | DAV scans go under `~/WitoScope/ContentResearch/Math/DAV/` and **stay there** (no size limit now, nothing is uploaded). Tell Claude when they're there | Claude adds DAV citations (title, pages, sections) and the local originality check reads the scans |
| D10 | Terminal, in the repo | Once: `brew install poppler` if `pdftotext -v` fails (it's already installed on this Mac). Before importing a chapter file: `npm run check:originality -- <chapter.json>`. After Generate runs: `npx tsx --env-file=.env.real scripts/check-originality.ts --unchecked` | A `.originality.json` next to the chapter file; each question page shows "Book check: clear / close to …" |

## E. Claude API for generation (Phase 6)

The AI function (`/api/ai`) runs in the same Pages project, behind the same Access application, and holds **only** the Claude API key. Do B–D first.

| # | Where | Exact steps | Expected result |
|---|---|---|---|
| E1 | console.anthropic.com → **API keys** | Create a key named `witoscope-cms` (in its own workspace if you use workspaces). Copy it once; don't save it anywhere else | A key starting `sk-ant-` |
| E2 | console.anthropic.com → **Limits / Spend limits** | Set a monthly spend limit for that workspace or organisation, e.g. **$30**. The CMS's $5 daily cap is checked in the browser; this is the hard backstop the API itself enforces | Limit shown |
| E3 | Pages project → **Settings → Variables and secrets** (Production **and** Preview) | Add the **Secret** `ANTHROPIC_API_KEY` = the key from E1. Optional plain variable `AI_MAX_DRAFTS` = `20`. Then **Deployments → latest → Retry deployment** | The deployment succeeds |
| E4 | Terminal | `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -X POST 'https://<project>.pages.dev/api/ai/generate'` | `302` to `…cloudflareaccess.com…`: without Access nothing reaches the function or the API |
| E5 | CMS (deployed) → a Class 6 Math production question → **Generate similar** | Choose 3, *now*, and click Generate | A run page with 3 drafts, their checks, and tokens and cost logged; Home → Jobs shows today's AI spend |
| E5b | CMS (deployed) → Home → **Model check** | Keep `claude-haiku-5-5` selected and run it (42 test-only gold, a few cents) | A report of agreement per attribute. To compare, run it again with `claude-sonnet-5-5`, then decide whether `ai_model_tag` needs the bigger model |
| E6 | *(optional)* `cms_config` | To change the model, cap, per-run limit or similarity threshold, edit `ai_model_generate` / `ai_model_tag` / `ai_model_extract` (all `claude-haiku-5-5`), `ai_fallback_model`, `ai_daily_cap_usd`, `ai_max_drafts_per_run` or `similarity_threshold` (ask Claude to do it, logged) | — |

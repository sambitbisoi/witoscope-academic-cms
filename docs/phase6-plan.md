# Phase 6 plan: Generate similar / fill a typical set (draft, waiting on G1–G3)

9 Nov 2026. Sources: CLAUDE.md ("Supabase Edge Functions for AI and import jobs"; "AI calls run server-side only"; secrets never in the repo; pgvector in Phase 6, installed into `cms`), design §2D (`cms_tagging_packs`), §2F (`cms_generation_runs`, `cms_jobs`), wireframe `Review.dc.html` (original + settings on the left; generated drafts with automatic checks on the right; Edit / Reject; Approve selected; rejected drafts kept with their reason).

## 1. What Phase 6 delivers

| Item | Detail |
|---|---|
| Generate similar | From a question: *Generate similar*, with settings (how many, same or harder difficulty, vary numbers / story / format), producing drafts in the same typical set and pattern |
| Fill a typical set | From a typical set: generate up to *n* drafts covering the missing difficulty levels (the ⚠ gaps) |
| Automatic checks on each draft | The answer recomputed or verified; the §8 checks (shared code); duplicate check against the bank (pgvector similarity + same numbers); **copy-from-source** check against book items (`cms_source_items.numbers` / text similarity), so book questions never leak |
| Tagging | Each draft is tagged with the v10 rubric through a cached **tagging pack** (`cms_tagging_packs`: rubric + calibration cases + gold prompt examples; never the test-only gold) |
| Review screen | As in the wireframe: drafts side by side with their check results; Edit, Reject (with a reason, kept for good), *Approve selected*; everything goes through the Phase 5 functions |
| Cost and logs | Each run is logged in `cms_generation_runs` (model, pack version, tokens, cost) and appears in Jobs on Home; per-run and per-day cost caps |

## 2. Decisions needed (they touch things outside `cms`, or need your accounts)

| # | Decision | Why it needs you | My recommendation |
|---|---|---|---|
| **G1** | **Where the AI calls run.** CLAUDE.md says Supabase Edge Functions | Deploying an Edge Function needs your Supabase access token (`supabase login`), and two **secrets** set in the dashboard: the Claude API key and a `cms_owner` connection string. The function connects as `cms_owner`, per the design | Edge Function `cms-generate`, with the API key and DB URL as Supabase secrets (dashboard steps in your checklist). It checks the caller's Supabase session is the CMS admin before doing anything |
| **G2** | **pgvector.** `create extension vector with schema cms` must be run by `postgres`, not `cms_owner` | It's a one-time bootstrap like 01, run by you in the SQL editor (it creates objects in `cms`, but needs `postgres` rights) | `db/bootstrap/03-pgvector.sql` for you to run; `check-migrations` keeps refusing extensions outside `cms` |
| **G3** | **Model and budget** | A cost decision | Latest Claude model for generation and tagging; a per-run cap (e.g. 20 drafts) and a daily cost cap stored in `cms_config`, shown before each run |

## 3. Work items (after G1–G3)

| # | Item | Size |
|---|---|---|
| 1 | Bootstrap 03 (pgvector) + migration: `cms_embeddings`, create-question function for generated drafts (admin-checked, like 0012), job/run bookkeeping | M |
| 2 | Tagging pack builder (rubric + calibration + prompt-example gold; versioned, hashed) | M |
| 3 | Edge Function `cms-generate` (admin check, cost caps, Claude calls, checks, writes drafts as `created_from = 'generation'`) + local test harness | L |
| 4 | Duplicate and copy-from-source checks (pgvector + numbers) | M |
| 5 | Review screen (wireframe 3) and Jobs on Home | L |
| 6 | Tests (no live API calls in tests: recorded responses), screenshots, PR | M |

Before building: PRs #3–#6 are stacked and unmerged, and the deployed site (checklist A–D) isn't live yet. Merging and deploying first means Phase 6 can be tried for real.

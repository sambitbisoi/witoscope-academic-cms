# Phase 6 plan: Generate similar / fill a typical set

9 Nov 2026. Sources: CLAUDE.md ("Supabase Edge Functions for AI and import jobs"; "AI calls run server-side only"; secrets never in the repo; pgvector in Phase 6, installed into `cms`), design §2D (`cms_tagging_packs`), §2F (`cms_generation_runs`, `cms_jobs`), wireframe `Review.dc.html` (original + settings on the left; generated drafts with automatic checks on the right; Edit / Reject; Approve selected; rejected drafts kept with their reason).

## 1. What Phase 6 delivers

| Item | Detail |
|---|---|
| Generate similar | From a question: *Generate similar*, with settings (how many, same or harder difficulty, vary numbers / story / format), producing drafts in the same typical set and pattern |
| Fill a typical set | From a typical set: generate up to *n* drafts covering the missing difficulty levels (the ⚠ gaps) |
| Automatic checks on each draft | The answer recomputed or verified; the §8 checks (shared code); duplicate check against the same topic's and pattern's questions and **copy-from-source** check against the topic's book items (number sets + text similarity ≥ 0.6, shared TypeScript; no pgvector), so book questions never leak |
| Tagging | Each draft is tagged with the v10 rubric through a cached **tagging pack** (`cms_tagging_packs`: rubric + calibration cases + gold prompt examples; never the test-only gold) |
| Review screen | As in the wireframe: drafts side by side with their check results; Edit, Reject (with a reason, kept for good), *Approve selected*; everything goes through the Phase 5 functions |
| Cost and logs | Each run is logged in `cms_generation_runs` (model, pack version, tokens, cost) and appears in Jobs on Home; per-run and per-day cost caps |

## 2. Decisions (Sambit, 9 Nov 2026)

| # | Decision |
|---|---|
| **G1** | AI calls run in a **Cloudflare Pages Function** (`/api/ai/*`) behind Access, reusing the Access JWT check. It holds **only the Claude API key** (a Pages secret) and returns drafts; the **browser** saves them through `cms_apply_save` like any edit (new `create` mode). Bulk runs use the **Batch API**, tracked in `cms_jobs`. No Supabase Edge Function and no database credentials in the cloud. |
| **G2** | **No pgvector.** Duplicate and copy-from-source checks are shared TypeScript: a number-set match plus text similarity (threshold **0.6**, configurable in `cms_config`) against the same topic's or pattern's questions and the topic's source items. |
| **G3** | The model name is in `cms_config` (starting with **`claude-sonnet-5-5`**); **20 drafts per run**; a **daily spend cap of $5** (configurable); tokens and cost logged per run in `cms_generation_runs`. |

How it fits together:
- **Function:** `functions/api/ai/[[path]].ts`, using the official SDK `@anthropic-ai/sdk` 0.135.0. It has `generate`, `batch` (create), `batch?id=` (status) and `batch/results`. The draft JSON schema lives in the function, and it caps drafts, requests and `max_tokens`.
- **Prompt:** the tagging pack (rubric, calibration cases, prompt-example gold; **never** test-only gold) is the cached system prompt; the source question and settings are the user turn.
- **Output:** structured JSON (`output_config.format`).
- **Refusal fallback:** on direct calls, server-side refusal fallback (`fallbacks: "default"`) is on by default, as the API guidance says for this model. The Batch API doesn't accept it.
- **Spend:** cost = tokens × the price table in `cms_config` (input, output, cache write, cache read), × 0.5 for batches. The daily cap is checked in the browser before each run, against the day's logged runs (Asia/Kolkata day).
- **Jobs:** with no database credentials in the cloud, nothing polls on its own. The browser checks a batch's status from Jobs and collects the results when it has ended.

## 3. Work items (after G1–G3)

| # | Item | Size |
|---|---|---|
| 1 | Migration 0013: `cms_apply_save` gains a `create` mode (new question, v1 draft, `created_from = 'generation'`, linked to the run); `cms_record_run`, `cms_save_job`; config defaults | M |
| 2 | Tagging pack builder (rubric + calibration + prompt-example gold; versioned, hashed) | M |
| 3 | Pages Function `/api/ai/*` (Access check, caps, Claude calls, batches) + a local stand-in with a fake model for dev and tests | L |
| 4 | Duplicate and copy-from-source checks in `shared/` (numbers + text similarity) | M |
| 5 | Review screen (wireframe 3) and Jobs on Home | L |
| 6 | Tests (no live API calls in tests: recorded responses), screenshots, PR | M |

Before building: PRs #3–#6 are stacked and unmerged, and the deployed site (checklist A–D) isn't live yet. Merging and deploying first means Phase 6 can be tried for real.

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

## 4. As built (9 Nov)

| Item | Result |
|---|---|
| AI function | `functions/api/ai/[[path]].ts` with `@anthropic-ai/sdk` 0.135.0: Access check, then `generate` (cached system prompt, the fixed JSON schema through `output_config.format`, server-side refusal fallback `"default"`) and `batch` create / status / results. Caps: model id, effort, 20 drafts (`AI_MAX_DRAFTS`), 32k `max_tokens`, prompt sizes, batch totals. Builds with wrangler 4.151.2 (≈1 MB) |
| Shared logic | `shared/generation.ts`: draft schema, tagging pack (never test-only gold), prompt, draft → question, duplicate and copy checks (number sets + trigram Dice similarity ≥ threshold), cost (cache write and read; batches half price) |
| Migration 0013 | `cms_apply_save` "create" mode (production only, next MQ/SQ/GQ id, file keys `<chapter>-5001…9999`, `created_from = 'generation'`, linked to the run); `cms_record_run`; `cms_save_job`; G3 defaults in `cms_config`. Local and real; `db-verify` passes |
| UI | Generate (settings, estimate vs today's spend and cap, now or batch), run review (checks, similar items, approve selected, reject with a reason, edit), Jobs on Home (check and collect batches, today's AI spend); "Generate similar" on questions, "Fill gaps" on typical sets |
| Local dev | `npm run dev:files` also serves `/api/ai` with a fake model (no key, no cost), through the same Access check |
| Tests | 186 unit (incl. 11 for the AI function and generation: refused without Access, params, caps, batches, pack excludes test-only gold, checks, cost) and 64 database (create mode, runs, jobs, app user refused). End to end in Chrome: 403 without Access; 3 drafts now with cost logged; approve 2, reject 1; a batch fill of the missing levels at half price, collected from Home |

Guesses, all listed in the PR:
- **H1:** the daily cap is checked in the browser, because the function has no database. A spend limit in the Anthropic Console is the hard backstop (checklist E2).
- **H2:** the cap's "day" is Asia/Kolkata.
- **H3:** generated drafts get file keys `<chapter>-5001…9999`.
- **H4:** drafts with §8 errors aren't saved and appear only on the run page. Duplicate and copy-from-source hits are saved but flagged for review.
- **H5:** the pack holds the v10 attributes, rubric and calibration cases plus up to 8 prompt-example gold questions, the same class first.
- **H6:** batch requests carry up to 5 drafts each, grouped by difficulty.
- **H7:** effort defaults to `high`, the API default (`ai_effort`).
- **H8:** the refusal fallback is on for direct calls; cost uses the price of the model that actually answered.
- **H9:** the estimate is input ≈ characters / 3.5 at full price, plus 900 output tokens per draft.
- **H10:** a fill run with no source question uses one of the set's questions as the model.
- **H11:** drafts keep the source's clone batch, or `gen-<run>` if there's none.
- **H12:** "Generate similar" is only offered on production questions.
- **H13:** local dev uses a fake model; the real API is only used in the deployed function.

## 5. Phase 6 updates (Sambit, 9 Nov 2026; no new phase)

| Update | As built |
|---|---|
| **Model per task** | `cms_config` keys `ai_model_generate`, `ai_model_tag`, `ai_model_extract`, all **`claude-haiku-5-5`** (migration 0014). The single `ai_model` key is removed, but only while it still held the 0013 default. Haiku 5.5 prices are in `ai_prices`, including the 5× long-context rate above 100K prompt tokens. |
| **Model check** | Home → Jobs → *Model check* (`#/model-check`). Pick a model, and it tags every **test-only gold** question with its values hidden. The report gives agreement per attribute, an "off by one" count for levels, and the disagreements per question. It is logged as a `tag` run (`params.purpose = model_check`). Nothing is saved to the question bank. The first request runs alone so the rules get cached; the rest run 3 at a time, and the check stops at the daily cap. |
| **Under 100K tokens** | Every request = the **fixed rules** (attributes, rubric, strategy types, task rules) as the cached system block, plus a small per-topic context in the user message: the topic's **concept cards** and their misconceptions, the **relevant calibration cases**, and up to 4 prompt-example gold questions. The AI function counts each request with `count_tokens` (free) and refuses anything above **95,000** tokens with a 413, before calling the model. Locally, a Generate request counts about 6.8K tokens. |
| **Refusal fallback** | **Haiku 5.5 has no server-side fallback**; the API guidance says not to send `fallbacks` for it. So for Haiku, the function retries once on `ai_fallback_model` (`claude-sonnet-5-5`), and Sonnet keeps the server-side `"default"` fallback. Every attempt (model, how it ran, stop reason, tokens, cost) goes into the run log, and the cost is priced per model. When a fallback fires, the run page shows a yellow notice with each attempt, and Home lists every run where it fired in the last 30 days. Batches have no fallback (the API rejects it); a declined batch request shows as `refused` in the run's failed requests. |

Guesses for these updates:
- **H14:** Haiku 5.5's cache rates are $0.125 to write and $0.01 to read per million tokens (1.25× and 0.1× of input). Its input and output rates are published; check the cache-read rate on the pricing page.
- **H15:** the guard is 95K tokens: a 5% margin under 100K for the fallback model's tokenizer. If `count_tokens` fails, the function estimates 2.5 characters per token (on the high side) instead of blocking.
- **H16:** "relevant calibration cases" = for each attribute, the cases on questions within one class of the topic's class. An attribute with none in that range keeps its nearest cases. A case on test-only gold is never sent; today all 37 cases are on prompt-example gold.
- **H17:** the reference examples are cut from 8 to 4 per request: same topic first, then the nearest class. They now sit in the per-topic part, not the cached block.
- **H18:** values hidden in the model check: concepts, the whole signature, duration, wrong-answer tags and misconceptions, solutions and hints. The model sees the text, figure description, format, options, correct and accepted answers, and the wrong-answer values. It is offered only the topic's concept cards; a gold concept missing from them is noted in the report.
- **H19:** the model check compares 15 attributes: Math difficulty, IsPureFact, Reading, Has_Irrelevant_Info, Steps, WorkingMemory, Inhibition, Visual, Strategy, Strategy_type, Insight_ID, Expected duration, Concepts (exact set), Primary concept, and Wrong-answer tags (pooled over every wrong answer).
- **H20:** `ai_effort` stays `high` for every task. Haiku 5.5's own default is `medium`, so run the model check at both if cost matters.
- **H21:** a model with no row in `ai_prices` is priced as the most expensive known one, so costs show high, never low. A server-side fallback to `claude-opus-5` is priced this way until its price is added.
- **H22:** the model check runs direct calls only (no batch option), so results come back in about a minute.
- Fact to note: there are **42** test-only gold questions locally and on the real project, not 43.

H5 (pack), H7 (effort is the API default), H8 (fallback) and H9 (estimate: now ≈ 3 characters per token) are replaced by the above.

## 6. Book material stays on the Mac (Sambit, 10 Nov 2026)

The copy-from-source check no longer runs in the browser: book item text isn't in the CMS any more. Drafts are still checked there against our own questions (topic and pattern). The check against books runs on the Mac: `npm run check:originality -- --unchecked`. It reads the chapter's PDFs and local book files and records only a result and a citation per version (`cms_originality_checks`). The question page then shows "Book check: …", and the run page says how to run it. Generation prompts never contained book text. **Near-copy rule (10 Nov 2026):** a near-copy (similarity ≥ 0.85 or the same distinctive numbers in the same order) blocks a chapter import; moderate similarity is a warning. For Generate drafts (Sambit, 10 Nov 2026, replacing guess N2): a near-copy **can't be approved** unless Sambit ticks "override: reviewed, not a copy" and gives a reason. `cms_set_status` enforces it (migration 0017), and the override is logged in `cms_reviews` as `override_near_copy`, next to the approval. On the run page, near-copies are left out of "Approve selected" and are approved one at a time on their own page.


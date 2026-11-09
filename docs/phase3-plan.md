# Phase 3 plan: Browse, plus the Cloudflare Pages/Access deploy

9 Nov 2026. Built under Sambit's standing approval. Sources: `docs/phase1-design.md`, `CLAUDE.md` and `docs/wireframe/` (where they disagree, the v10 signature and the design win, as the wireframe README says). Every guess is marked **[guess]** and repeated in the PR. Branch: `phase-3-browse`.

## 1. Scope

| In Phase 3 | Not in Phase 3 (later phase) |
|---|---|
| Home: review-queue count, latest jobs and imports, grade picker, subject cards with coverage | "Upload new source" (7), the review flow itself (5) |
| Topic workspace: chapter → topic tree with difficulty counts and gap warnings; tabs *By question type* and *By concept*; filters | *Sources* tab (4) |
| Question detail: child preview, options with mistake tags, answers, solutions, hints, v10 signature + derived fields, concepts, placement, tagging notes, version history | Edit / Approve / Reject (5), Generate similar / Generate more (6) |
| Search: topics, typical sets, patterns, concepts, questions (ID or file key) | Full-text search of question wording |
| Cloudflare Pages build + Access in front, not indexed | Custom domain (optional, checklist) |

Every screen is read-only. Buttons for later phases are **left out**, not shown disabled, to keep screens clean **[guess]**.

## 2. Screens

| Screen | Route | Contents |
|---|---|---|
| Home | `#/` (`?grade=1…6`) | Work strip: **Review queue** (production drafts + in review, by subject), **Jobs** (running jobs; last import with result). Grade picker All · 1–6 (remembered in the browser). Subject cards: chapters, topics, questions (approved · draft · in review), gold count, coverage "n of m topics have all 3 difficulty levels" |
| Topic workspace | `#/browse/<subject>/<class or all>/<topic?>` + `?q=<question>` | **Left:** chapters → topics (Achievers row last). Each topic shows "n Qs · S a M b C c" and a warning when a level is missing; a *Gaps only* toggle. **Middle:** topic header (ID · name, chapter, taught in school, sources it appears in, counts). Tabs: **By question type** = typical sets, with patterns as sub-groups; questions with no set go last. **By concept** = the topic's concepts, each with its questions and involvement. Filters: Difficulty, Status, Bank (production / gold). **Right:** question detail |
| Question detail | right panel; also `#/q/<id>` (opens its topic) | Header: ID · bank · status · version · approved version. Child preview: text, figure description (with an "image needed" badge), options with ✓ and the wrong-answer tag + misconception (ID and description), typed answer + accepted forms, parts for Multi-part. Solution 1/2 (type, strategy), hints 1–3. **Signature (v10):** Math difficulty, Reading, Steps → MultiStep band, WorkingMemory, Inhibition, Visual, Strategy → Tier, Strategy type (+ 2nd, + note), Insight, IsPureFact, Has irrelevant info. **Derived:** Load (+ driver), Style, Trap level, Isolating, Difficulty points. Concepts with involvement. Placement: topic, typical set, pattern, clone batch, class override. *More* (collapsed): tagging why + summary, author notes, source refs (internal), gold meta, version history + audit log |
| Search | header box on every screen | Results grouped by kind; Enter or click opens it |
| Imports | `#/imports` (exists) | Unchanged |

Layout follows the wireframe: three columns on wide screens, stacked on narrow ones.

## 3. Data

| Need | How |
|---|---|
| Counts across 1,234+ topics (the REST API caps a response at 1,000 rows) | Migration **0010**: views in `cms`, all `with (security_invoker = true)` so RLS still applies: `cms_question_list` (question + current version + gold use), `cms_topic_stats` (per topic: counts by status, bank and difficulty), `cms_home_stats` (per subject and class) |
| View safety | `check-migrations`: every `create view` must say `security_invoker = true`. `db:verify`: every `cms` view is security_invoker. DB tests: an app user gets zero rows from every view; the admin gets rows |
| Detail | Plain SELECTs on the version tables, filtered by `version_id`, under RLS |
| Grants | `authenticated`: SELECT on the views (no writes) |

## 4. Difficulty, status and gaps

| Item | Rule |
|---|---|
| Difficulty shown | v10 Math difficulty: Simple / Medium / Complex (S/M/C) |
| What counts towards coverage | **[guess]** production questions that aren't retired, using their current version, except rejected versions. Gold is counted separately and never counts towards coverage (it is never publishable) |
| Gap warning | **[guess]** only for topics that have production questions but are missing a level ("no Complex"); topics with no questions show "no questions" and aren't flagged as gaps (otherwise almost every topic would be) |
| Status shown | The current version's status. When the approved version is older, both show ("Approved v1 · Draft v2") |

## 5. Deploy: Cloudflare Pages + Access

| Item | Decision |
|---|---|
| Build | Pages Git integration on `main`: build command `npm ci && npm run build -w web`, output `web/dist`. The env vars `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are set in Pages (public by design) **[guess: Git integration over manual uploads, so no Cloudflare token sits on the laptop]** |
| Access | Zero Trust self-hosted application covering `<project>.pages.dev` **and** `*.<project>.pages.dev` (preview builds); policy allows Sambit's email only |
| Not indexed | `web/public/robots.txt` disallows everything; `_headers` adds `X-Robots-Tag: noindex, nofollow` and basic security headers (no framing, no sniffing, strict referrer) |
| Supabase settings | None: password login needs no redirect URLs |
| Real project | Migration 0010 applied with `db-verify` before deploy |

## 6. Work items

| # | Item | Size | Commits |
|---|---|---|---|
| 1 | Migration 0010 (views) + guardrail rule + `db-verify` check + DB tests | M | 2 |
| 2 | Data layer in `web/` (typed queries, URL state) | M | 1 |
| 3 | Home | M | 1 |
| 4 | Topic workspace (tree, tabs, filters) | L | 2 |
| 5 | Question detail | L | 2 |
| 6 | Search | S | 1 |
| 7 | Unit tests for the pure helpers (gaps, grouping, signature labels) | S | 1 |
| 8 | Deploy files (`_headers`, `robots.txt`) + checklist section B | S | 1 |
| 9 | Screenshots, real-project migration + `db-verify`, PR | S | — |

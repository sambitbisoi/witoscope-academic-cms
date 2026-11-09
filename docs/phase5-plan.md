# Phase 5 plan: Edit, review and versions

9 Nov 2026. Sources: design §3 (statuses, same version vs new version, "the Save button decides which case applies and tells you before saving"), §4 (derived fields), CLAUDE.md (explicit Save; typo fix = same version, logged; everything else = new version; never delete; gold never publishable), wireframe (Edit / Approve / Reject in question detail; review queue).

## 1. What Phase 5 delivers

| Item | Detail |
|---|---|
| Edit a question | From the question detail: a form for the text, figure, answer/options, accepted forms, wrong-answer tags, parts, concepts and involvement, the v10 signature, solutions, hints, placement (topic / set / pattern) and notes. Optional fields sit behind *More* |
| Save tells you first | Before saving it shows **"Typo fix: same version vN, logged"** or **"New version vN+1 (draft)"**, with the reason, using the same rules as the chapter importer (structure + numbers in the wording). Derived fields are recomputed on save |
| Review | Draft → *Submit for review* → In review → **Approve** / **Reject (reason required)**. Approve moves `approved_version`. Rejected versions are kept with their reason. At most one open version, as the database already enforces |
| Review queue | Home's review-queue card opens a queue: drafts and in-review versions, by subject, class and topic, oldest first, opening the question detail with the actions |
| Versions | History with a **compare** view (field-by-field diff of any two versions) and the audit log |
| Retire / restore | Retire a question (hidden from coverage and Publish; never deleted) and restore it, with a reason |
| Gold | Gold questions can be edited and versioned like any other; they stay `bank = 'gold'` and are never publishable |

## 2. Decision (Sambit, 9 Nov 2026): E1 = (a), modified

The versioning logic lives **only in the shared TypeScript** (`shared/`), which computes the save in the browser: same version or new version, the diff, the checks and the derived fields. **One admin-checked SQL function, `cms.cms_apply_save(jsonb)`**, plus `cms.cms_set_status` and `cms.cms_retire`, applies it in one transaction and enforces only the hard rules:
1. no structured-field change on an approved version;
2. one open version per question;
3. gold never publishable.

There are **no write grants on the question tables**.

The analysis below is kept for the record.

### Options considered

| # | Decision | Options | My recommendation |
|---|---|---|---|
| **E1** | **Where the save logic runs.** A save touches up to 9 tables (version + parts, options, wrong answers, concepts, solutions, hints, refs + question pointers + audit row) and must be **one transaction**, validated with the same §8 checks and versioning rules as the importer | (a) **SQL functions in `cms`** (`cms.cms_save_version(jsonb)`, `cms_review(…)`, `cms_retire(…)`). Security definer, owned by `cms_owner`, each one checking `cms_is_admin` first; it's the only write path, so the logged-in role gets **no** write grants on question tables. The TypeScript checks run in the browser *before* Save to show the "typo / new version" preview; the SQL function re-checks the essentials (open-version rule, enums, references) and recomputes the structure hash. (b) **An Edge Function** running as `cms_owner` that reuses the importer's TypeScript as-is. It needs deploying (`supabase functions deploy`, with your access token) and a DB secret in the function settings, which is new infrastructure. (c) Browser writes with table grants: rejected, since it can't be one transaction | **(a)**: one transaction, no new infrastructure, no write grants on question tables, and every rule lives in the migration. The risk is two implementations of the versioning rule (TS and SQL), so the tests run both on the same cases and must agree |

## 3. Work items (after E1)

| # | Item | Size |
|---|---|---|
| 1 | Shared code: move the versioning rule, derived fields and §8 checks into `shared/`, used by the scripts and the web app | S |
| 2 | Migration 0012: `cms_save_version`, `cms_set_status` (submit / approve / reject), `cms_retire` / `cms_restore`, plus `cms_typo_fix`; all admin-checked and audited; tests that TS and SQL classify the same cases identically | L |
| 3 | Edit form (sections, *More*), with the save preview and plain-words errors | L |
| 4 | Review actions in question detail; review queue screen | M |
| 5 | Version compare view | M |
| 6 | Tests (DB: every path, RLS, one open version, gold never publishable; UI end to end), screenshots, PR | M |

Also before Phase 5 is built: PRs #3, #4 and #5 are stacked and unmerged. Merging them first keeps Phase 5's PR reviewable.

## 4. As built (9 Nov)

| Item | Result |
|---|---|
| Shared code | `shared/` holds the versioning rule, checks, derived fields, the save planner (`save.ts`), the rebuild from database rows (`fromDb.ts`) and a browser-safe SHA-256; used by the scripts, the web app and the tests |
| Canonical fingerprint | The structure hash is now identical whether built from a chapter file or from database rows: absent and empty lists are the same, numbers are numbers, and unordered lists are sorted (option order still counts). `rehash` recomputed the stored values once: locally 78, real 77. Proof: the importer and the seed then see every existing question as unchanged, locally and on the real project |
| Migration 0012 | `cms_apply_save(jsonb)` (typo fix / update draft / new version), `cms_set_status` (submit / withdraw / approve / reject with a reason) and `cms_retire` (with a reason): admin-checked, one transaction, audited; hard rules only. No write grants on question tables. Applied locally and on the real project; `db-verify` passes |
| UI | Edit form with a live "When you click Save" preview (mode, diff, checks; errors block Save); actions in the question detail; version compare; review queue `#/review` |
| Tests | 172 unit tests and 59 database tests, including 14 on the save path: typo fix on an approved version, a tampered typo refused, new version, a second open version refused, a draft edited in place, editing blocked in review, reject needs a reason, a stale save refused, app user and anon refused, no direct table writes even for the admin, gold stays gold, retire and restore. End to end in Chrome on a local question |

Guesses, all listed in the PR:
- **F1:** Approve works from draft as well as from in review, since there's one reviewer.
- **F2:** editing is blocked while a version is in review; use "Back to draft" first.
- **F3:** a typo fix applies only to an approved version; after a rejection, any change is a new version.
- **F4:** a draft is edited in place whoever created it, and is marked edited, so imports never overwrite it.
- **F5:** for Multi-part questions, each part's wording and answer can be edited; adding or removing parts, and per-part tags and concepts, come later.
- **F6:** wrong-answer tags can be edited for options; tags on typed answers are shown but not editable yet.
- **F7:** the duplicate-wording and source-ref warnings stay import-time checks.
- **F8:** a reason is optional when saving and required to reject, retire or restore.
- **F9:** option order counts as structure; the order of concepts, wrong answers and refs doesn't.
- **F10:** the compare view lists changed structure fields and changed texts.
- **F11:** the review queue includes gold drafts.
- **F12:** the save ignores fields it doesn't own, such as `bank`.
- **F13:** "gold never publishable" holds because these functions never write `bank` or `question_id`, plus the existing ID check. Phase 8's Publish must still exclude `bank = 'gold'`.

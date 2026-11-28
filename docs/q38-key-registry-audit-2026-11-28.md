# Q38 PR 3 · Key-registry audit, 28 Nov 2026 (read-only)

`npm run keys:audit` (`scripts/keys-audit.ts`) on the **real** project as `cms_reader` (`begin read only`), 28 Nov 2026 15:45 IST.
It compares three registers. The output holds keys and counts only, never question text.
- **CMS**: question keys, catalogue numbers and sequences.
- **QuestionBank registry**: keys in `QuestionBank/*/(MC|SC|GC)##-C#.json`. These are our own questions; `*.book.json` is never opened.
- **`QuestionBank/_pipeline/id_blocks.md`**.

A bank key is the same question when the bank text (spaces normalised) equals the CMS v1 or current text. This is the same method as 23 Nov (`docs/q38-key-registry-audit-2026-11-23.md`).

## Question keys
| Check | Result |
|---|---|
| Bank keys / CMS questions / CMS questions with a file key | 6,331 / 11,412 / 11,334 (the 78 without a key are the gold seed) |
| Same key, same question | 6,240 |
| **Bank holds different text** | **87**: MC15 22 · MC27 11 · MC39 8 · MC12 7 · MC10 6 · MC11 6 · MC08 4 · MC18 4 · MC26 3 · MC36 3 · MC41 2 · MC47 2 · MC04/06/23/29/34/38/40/50/58 1 each. These are the 86 near-copy rewrites of 13 Nov plus MC50-0001 (Achievers slot), unchanged since 23 Nov. The 18 Nov "88" included MC19-0039, now resolved. |
| **CMS key not in bank** | **5,007**: 4,872 Science from generation runs (69 runs, GR0002 … GR0139) · 134 Science from the Science master import (never from QuestionBank) · 1 Math: **MC19-0039 = MQ002060** (QB NCERT-C6-07 still calls it MC19-0001) |
| Gold | 78 gold questions (Math gold seed) have no file key and were never in QuestionBank |
| Bank key not in CMS | MC19-0001 (the same question as MC19-0039) · MC58-0051, -0052, -0053 (in Held out) |
| Duplicate keys inside the bank | 0 |
| Collision risk (the CMS holds a key above the bank's highest key of that chapter) | **none**. CMS-made keys are 5001–9999 (generation, Add questions); the book pipelines' keys are below 5000 |

**MC19-0039 collision (18 Nov):** re-keyed then, held-out #7 discarded; no further collision. The registry now also counts held-out keys as taken, so MC58-0051…0053 can never be handed out again.

## Field-level staleness (new: `npm run export:bank-sync`)
Field by field, the bank is stale on top of the 87 texts:
- **360 hint sets** and **266 solution sets** differ from the current CMS version.
- These are the 13 Nov rewrites the text-only check could not see. The 23 Nov plan estimated "about 537 **[inferred]**".
- The solution comparison is a set compare of the bank's solution texts with the CMS solution slots. **[to verify]**: sample-check a few sync files before the QuestionBank session applies them.
- 93 bank files need a write-back. There is one rename (MC19-0001 → MC19-0039) and 3 keys not in the CMS (held out).

The sync files go to `.local-import/bank-sync-real-…/` on the Mac. QuestionBank is not touched; applying them is the QuestionBank session's step (plan §12, item 4).

## Catalogue numbers vs `id_blocks.md`
| Check | Result |
|---|---|
| Blocks | 125 assigned (0–124), 122 "awaiting review", 3 done; 125–199 free |
| Patterns | 2,975 MP in the CMS (max **MP6172**; 2,974 still Proposed). 0 outside an assigned block; 0 outside a block's stated ranges. Blocks with no CMS pattern: 75 (none new) and 124 (key fix). Next free block 125 = MP6250 |
| Concepts (Math) | 712: 622 numbered, all inside assigned blocks (highest block used 122); 90 unnumbered (legacy names) |
| Misconceptions | 404: 358 numbered, all inside assigned blocks (highest 122); 46 unnumbered |
| Typical sets | named (`TS-…`), not numbered: no block rule applies |

**Risk the registry closes:** the CMS numbers its own new concepts and MP patterns as max + 1. Its next MP is MP6173, and a CMS run of ~80 patterns would walk into a block (125 = MP6250…) that `id_blocks.md` would hand to the next book. From PR 3:
- The CMS hands out blocks and file keys (`cms_reserve_keys`).
- The CMS's own numbering skips any block that is reserved.

## Sequences: numbers used up by dry runs
| | Last value | Stored IDs | Taken, never stored |
|---|---|---|---|
| MQ | 6,339 | 6,328 | 11 |
| SQ | 10,094 | 5,006 | **5,088** (almost all `gen:import --dry-run` on real) |
| GR | 139 | 69 runs | **70** codes with no run (every real dry run took one) |

From 0052 a dry run takes no number: `cms_mint` gives the number the real run will get without touching the sequence, and a dry-run transaction can't commit. Existing gaps stay: IDs are never reused.

**Never changed:** no existing key, question ID or catalogue ID is altered by PR 3.

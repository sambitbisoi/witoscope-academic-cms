# Q38 · Key-registry audit, 23 Nov 2026 (read-only)

Real CMS (`cms_owner`, `begin read only`) compared with the QuestionBank key registry, meaning the keys in
`QuestionBank/*/(MC|SC|GC)##-C#.json`. A key counts as registered when the bank file holds it for the same question:
the bank text (spaces normalised) equals the text of CMS version 1 or of the current version. Keys and counts only; no question text.
Method as `CMS-updates/2026-11-18-dav-math/scripts/registry2.mts`, plus bank-only keys, duplicates, `_work` keys and per-chapter maxima.

| Check | Result |
|---|---|
| Bank keys / CMS file keys | 6,331 / 6,462 |
| Same key, same question | 6,240 |
| Bank holds different text | **87**: 86 near-copy rewrites of 13 Nov (imported as new versions, never written back to QB; MC15 22, MC27 11, MC39 8, MC12 7, MC10 6, MC11 6, MC08 4, MC18 4, MC26 3, MC36 3, MC41 2, MC47 2, MC04/06/23/29/34/38/40/58 1 each) + MC50-0001 (Achievers slot; known false positive) |
| CMS key not in bank | 134 Science (SC48, never from QB) + 1 Math: MC19-0039 = MQ002060 (QB NCERT-C6-07 still calls it MC19-0001) |
| Bank key not in CMS | MC19-0001 (same case); MC58-0051, -0052, -0053 (in Held out) |
| Duplicate keys inside the bank (different text) | 0 |
| `_work/*/chapter_data.json` keys not yet built | 0 |
| Chapters where the bank max is below the CMS max | SC48 only (Science, not from QB). MC19: bank max 0071 = CMS max 0071 |

Compared with 18 Nov (88 "different question"): MC19-0039 is resolved. The DAV item was re-keyed to MC19-0071 = MQ006339.

**Not detected by this check:** field-level rewrites (hints, solutions, about 537 on 13 Nov) in keys whose text is unchanged.
QB is very likely stale there too **[inferred from the 18 Nov notes]**.

**Decision (Q9, Sambit 23 Nov):** the CMS text wins, and QB is re-synced from a CMS export (`export:bank-sync`, plan §1, PR 3; QB hand-off item 4).

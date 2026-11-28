// Q38 PR 3: id_blocks.md parsing (the one-off load into the CMS key registry).
import { describe, expect, it } from 'vitest';
import { blockRow, parseIdBlocks } from '../scripts/lib/id-blocks.ts';

const md = `# ID blocks
| Block | Book | Chapter | Folder | Status |
|---|---|---|---|---|
| 0 (legacy) | NCERT C6 | 1 Patterns | NCERT-C6-01 | done (MP0037–MP0045; concepts G1-PAT-C2) |
| 4 | NCERT C6 | 4 Data | NCERT-C6-04 | built 9 Nov, awaiting review (MP0200–MP0244, MP0212 unused; concepts C401–) |
| 125–199 | next books (assign in order) | | | |
`;
describe('id_blocks.md', () => {
  it('reads assigned blocks with their stated MP ranges, and the free range', () => {
    const b = parseIdBlocks(md);
    expect(b.map((x) => [x.block, x.last ?? null, x.folder])).toEqual([[0, null, 'NCERT-C6-01'], [4, null, 'NCERT-C6-04'], [125, 199, '']]);
    expect(b[1]!.mp).toEqual([[200, 244], [212, 212]]);
  });
  it('an assigned block becomes a "used" registry row; the purpose names folder, book and chapter', () => {
    expect(blockRow(parseIdBlocks(md)[1]!)).toEqual({ block_no: 4, purpose: 'NCERT-C6-04 — NCERT C6 · 4 Data', status: 'used', note: 'built 9 Nov, awaiting review (MP0200–MP0244, MP0212 unused; concepts C401–)' });
  });
});

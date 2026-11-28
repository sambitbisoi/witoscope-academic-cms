// QuestionBank/_pipeline/id_blocks.md: the hand-kept id blocks of the book pipelines (Q38 PR 3). Read-only parser; from PR 3
// the CMS registry (cms_key_reservations) is the source and id_blocks.md a mirror (npm run keys -- mirror).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const QB_DIR = join(homedir(), 'WitoScope', 'ContentResearch', 'QuestionBank');
export const ID_BLOCKS = join(QB_DIR, '_pipeline', 'id_blocks.md');
export interface IdBlock { block: number; last?: number; book: string; chapter: string; folder: string; status: string; mp: [number, number][] }

export function parseIdBlocks(text: string): IdBlock[] {
  const out: IdBlock[] = [];
  for (const line of text.split('\n')) {
    const m = /^\|\s*(\d+)(?:\s*[–-]\s*(\d+))?(?:\s*\(legacy\))?\s*\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)\|\s*$/.exec(line);
    if (!m) continue;
    const mp = [...m[6]!.matchAll(/MP(\d{4})(?:\s*[–-]\s*MP(\d{4}))?/g)].map((x) => [Number(x[1]), Number(x[2] ?? x[1])] as [number, number]);
    out.push({ block: Number(m[1]), last: m[2] ? Number(m[2]) : undefined, book: m[3]!.trim(), chapter: m[4]!.trim(), folder: m[5]!.trim(), status: m[6]!.trim(), mp });
  }
  return out;
}
export const readIdBlocks = (path = ID_BLOCKS): IdBlock[] => (existsSync(path) ? parseIdBlocks(readFileSync(path, 'utf8')) : []);

/** The registry row a block of id_blocks.md becomes: every assigned block is "used" (its numbers belong to built work);
 *  the free range (e.g. 125–199) is not loaded. */
export function blockRow(b: IdBlock): { block_no: number; purpose: string; status: 'used'; note: string } {
  const purpose = [b.folder, [b.book, b.chapter].filter(Boolean).join(' · ')].filter(Boolean).join(' — ').slice(0, 300);
  return { block_no: b.block, purpose: purpose || `block ${b.block}`, status: 'used', note: b.status.slice(0, 1000) };
}

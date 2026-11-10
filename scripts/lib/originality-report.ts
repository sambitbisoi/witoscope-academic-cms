// Reads the local originality check's report next to a chapter file (scripts/check-originality.ts).
// The report holds citations and scores only. Missing → a warning; written for another
// version of the file → an error (re-run the check); a near-copy → an error that blocks that
// question; a flagged (moderately similar) question → a warning (Sambit, 10 Nov 2026).
import { existsSync, readFileSync } from 'node:fs';
import { REPORT_SCHEMA, type OriginalityReport } from '../../shared/originality.ts';
import type { Problem } from '../../shared/types.ts';

export const reportPathFor = (absChapterFile: string) => absChapterFile.replace(/\.json$/i, '') + '.originality.json';

export function readOriginality(absChapterFile: string, fileHash: string): { report: OriginalityReport | null; problems: Problem[] } {
  const path = reportPathFor(absChapterFile);
  if (!existsSync(path)) {
    return { report: null, problems: [{ level: 'warning', key: 'file', message: 'not checked for copying from books: run npm run check:originality -- <this file> on this Mac first' }] };
  }
  let rep: OriginalityReport;
  try { rep = JSON.parse(readFileSync(path, 'utf8')) as OriginalityReport; } catch {
    return { report: null, problems: [{ level: 'error', key: 'file', message: `${path.split('/').pop()} is not valid JSON; re-run npm run check:originality` }] };
  }
  if (rep.file_schema !== REPORT_SCHEMA) return { report: null, problems: [{ level: 'error', key: 'file', message: `originality report: file_schema must be ${REPORT_SCHEMA}; re-run npm run check:originality` }] };
  if (rep.chapter_file_sha256 !== fileHash) {
    return { report: null, problems: [{ level: 'error', key: 'file', message: 'the originality report was made for a different version of this file; re-run npm run check:originality' }] };
  }
  const problems: Problem[] = [];
  if (rep.missing.length) problems.push({ level: 'warning', key: 'file', message: `originality: no file on this Mac for ${rep.missing.join(', ')}; those sources were not checked` });
  for (const q of rep.questions) {
    if (q.result === 'near_copy') problems.push({ level: 'error', key: q.key, message: `near-copy of a book: ${q.closest_ref} (similarity ${q.similarity}${q.same_numbers ? ', same numbers in the same order' : ''}); rewrite it with new wording and numbers` });
    if (q.result === 'flagged') problems.push({ level: 'warning', key: q.key, message: `close to a book: ${q.closest_ref} (similarity ${q.similarity}${q.same_numbers ? ', same numbers' : ''}); check it is original before approving` });
  }
  return { report: rep, problems };
}

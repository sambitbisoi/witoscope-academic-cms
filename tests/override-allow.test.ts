// Go-live decision (Sambit, 13 Nov 2026): a near-copy is let in only with an override request for that exact question + field.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { overrideCovers } from '../scripts/lib/originality-report.ts';
import { overrideAllowList } from '../scripts/lib/updates.ts';

const q = (fields: [string, string][], o: Record<string, unknown> = {}) => ({ key: 'MC36-0101', result: 'near_copy', field: fields[0]?.[0], fields: fields.map(([field, result]) => ({ field, result })), ...o });

describe('overrideCovers', () => {
  const allow = new Set(['MC36-0101|options']);
  it('covers a near-copy in exactly the requested field (part labels included)', () => {
    expect(overrideCovers(q([['options', 'near_copy']]), allow)).toBe(true);
    expect(overrideCovers(q([['options (a)', 'near_copy']]), allow)).toBe(true);
    expect(overrideCovers(q([['options', 'near_copy'], ['hint 1', 'flagged']]), allow)).toBe(true); // a warning elsewhere is fine
  });
  it('does not cover another field, another question, a second near-copy field, or no list', () => {
    expect(overrideCovers(q([['figure description', 'near_copy']]), allow)).toBe(false);
    expect(overrideCovers(q([['options', 'near_copy']], { key: 'MC36-0102' }), allow)).toBe(false);
    expect(overrideCovers(q([['options', 'near_copy'], ['text', 'near_copy']]), allow)).toBe(false);
    expect(overrideCovers(q([['options', 'near_copy']]), undefined)).toBe(false);
    expect(overrideCovers(q([['options', 'flagged']], { result: 'flagged' }), allow)).toBe(false);
  });
  it('falls back to the worst field when the report has no field list', () => {
    expect(overrideCovers({ key: 'MC36-0101', result: 'near_copy', field: 'options' }, allow)).toBe(true);
  });
  it('reads the allow list from override_requests.csv and refuses a broken file', () => {
    const d = mkdtempSync(join(tmpdir(), 'orq-'));
    writeFileSync(join(d, 'ok.csv'), 'file_key,field,reason\nMC36-0101,options,"½, ¼ and ¾ turns are the standard values"\n');
    expect([...overrideAllowList(join(d, 'ok.csv'))]).toEqual(['MC36-0101|options']);
    writeFileSync(join(d, 'bad.csv'), 'file_key,field,reason\nMC36-0101,options,short\n');
    expect(() => overrideAllowList(join(d, 'bad.csv'))).toThrow(/needs a reason/);
  });
});

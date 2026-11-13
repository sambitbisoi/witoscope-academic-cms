// U3: the local Import screen runs the same commands as the command line, in order.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFolders, plan } from '../scripts/lib/local-import.ts';

describe('local import (U3)', () => {
  it('check: stage, dry-run proposals and book, originality, validate', () => {
    const steps = plan('check', 'NCERT-C5-01', ['MC02-C4.json'], { proposals: true, book: true }, '/root');
    expect(steps.map((s) => s.args[0])).toEqual(['scripts/stage-pipeline.ts', 'scripts/import-proposals.ts', 'scripts/import-book.ts', 'scripts/check-originality.ts', 'scripts/import-chapter.ts']);
    expect(steps[1]!.args).toContain('--dry-run');
    expect(steps[2]!.args).toContain('--dry-run');
    expect(steps[4]!.args[1]).toBe('validate');
  });
  it('import: the same, for real, then the figures', () => {
    const steps = plan('import', 'NCERT-C5-01', ['MC02-C4.json', 'MC03-C4.json'], { proposals: false, book: true }, '/root');
    expect(steps.map((s) => s.args[0])).toEqual(['scripts/stage-pipeline.ts', 'scripts/import-book.ts', 'scripts/check-originality.ts', 'scripts/check-originality.ts',
      'scripts/import-chapter.ts', 'scripts/import-chapter.ts', 'scripts/import-figures.ts']);
    expect(steps.some((s) => s.args.includes('--dry-run'))).toBe(false);
  });
  it('refuses odd names (no paths from the browser)', () => {
    expect(() => plan('check', '../etc', [], { proposals: false, book: false })).toThrow(/bad folder/);
    expect(() => plan('check', 'NCERT-C5-01', ['../../x.json'], { proposals: false, book: false })).toThrow(/bad chapter file/);
  });
  it('lists pipeline folders with chapter files only, skipping _private folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'cms-local-'));
    mkdirSync(join(root, 'NCERT-C5-01')); mkdirSync(join(root, '_archive')); mkdirSync(join(root, 'empty'));
    writeFileSync(join(root, 'NCERT-C5-01', 'MC02-C4.json'), JSON.stringify({ questions: [{}, {}] }));
    writeFileSync(join(root, 'NCERT-C5-01', 'NCERT-C5-01.proposals.json'), '{}');
    writeFileSync(join(root, '_archive', 'MC02-C4.json'), '{}');
    const f = listFolders(root);
    expect(f.map((x) => x.folder)).toEqual(['NCERT-C5-01']);
    expect(f[0]).toMatchObject({ proposals: true, book: false, files: [{ name: 'MC02-C4.json', questions: 2 }] });
  });
});

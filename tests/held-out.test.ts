// Q21: placement codes in the chapter-file checks; which questions go to Held out (unit).
import { describe, expect, it } from 'vitest';
import { checkFile, type Catalog } from '../shared/checks.ts';
import type { ChapterFile, Question } from '../shared/types.ts';
import { placementReason } from '../scripts/lib/held-out.ts';

const cat: Catalog = {
  ruleVersions: new Set(['v11']), chapter: { chapter_id: 'MC97', subject: 'math' },
  topics: new Map([['MT9997', { chapter_id: 'MC97', class: 1, topic_kind: 'normal', taught_in_school: false, status: 'active' }]]),
  typicalSets: new Map([['TS-G1-ZZ', { class: 1, status: 'active' }]]), patterns: new Set(), concepts: new Map([['G1-ZZ-C1', { class: 1 }]]),
  misconceptions: new Set(), insights: new Map(), sourceItems: new Set(), stems: new Map(), keyToQuestionId: new Map(),
};
const q = (k: string, extra: Partial<Question> = {}): Question => ({
  key: k, topic_id: 'MT9997', typical_set_id: 'TS-G1-ZZ', clone_batch_id: '', locale: 'IN', text: `Q ${k}?`,
  answer: { format: 'Typed-number', correct: '9' }, concepts: [{ concept_id: 'G1-ZZ-C1', involvement: 1 }],
  signature: { math_difficulty: 'Simple', is_pure_fact: false, reading: 1, has_irrelevant_info: false, steps: 1, working_memory: 1, inhibition: 0, visual: 0, strategy: 0 },
  duration_s: 30, solutions: { school: 's' }, hints: [], ...extra,
});
const file = (qs: Question[], patterns: ChapterFile['patterns'] = []): ChapterFile => ({ file_schema: 'cms-chapter/1.0', attribute_version: 'v11', subject: 'math', class: 1, chapter_id: 'MC97',
  generated: { by: 't', date: '2026-11-17' }, questions: qs, patterns });

describe('placement codes (Q21)', () => {
  it('Achievers row missing, unknown set or concept → placement; a content error → not held', () => {
    const f = file([q('MC97-0001', { topic_id: 'ACHIEVERS' }), q('MC97-0002', { typical_set_id: 'TS-G1-NOPE' }), q('MC97-0003', { concepts: [{ concept_id: 'G1-NOPE', involvement: 1 }] }),
      q('MC97-0004', { topic_id: 'ACHIEVERS', concepts: [] })]);
    const p = checkFile(f, cat);
    expect(placementReason(p, 'MC97-0001')?.code).toBe('achievers_missing');
    expect(placementReason(p, 'MC97-0002')?.code).toBe('typical_set_missing');
    expect(placementReason(p, 'MC97-0003')?.code).toBe('concept_missing');
    expect(placementReason(p, 'MC97-0004')).toBeNull();     // also "needs a concept at 1.0": a content error, fix the file
  });
  it('decision 8: a pattern that can\'t be placed holds only the questions that use it, and is not a file error', () => {
    const f = file([q('MC97-0005', { pattern_id: 'MP9001' }), q('MC97-0006')],
      [{ pattern_id: 'MP9001', topic_id: 'ACHIEVERS', typical_set_id: 'TS-G1-ZZ', name: 'held pattern' }]);
    const p = checkFile(f, cat);
    expect(p.filter((x) => x.key === 'pattern MP9001').every((x) => !!x.code)).toBe(true);
    expect(placementReason(p, 'MC97-0005')?.code).toBe('achievers_missing');
    expect(p.filter((x) => x.key === 'MC97-0006' && x.level === 'error')).toEqual([]);
  });
});

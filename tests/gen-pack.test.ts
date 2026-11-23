// Q38 PR 1: generation pack checks, selection (pilot / steady), content hash, and the PILOT04 adapter's parsing.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { linkedRows, parseItemRef, parseWrongTags, pilotToPack, settingSlug } from '../scripts/lib/gen-adapters/science-pilot04.ts';
import { contentHash, dbItem, figureKey, packProblems, planItems, pngSize, sha256, type Pack, type PackQuestion, type ReviewDecisions } from '../scripts/lib/gen-pack.ts';

const q = (lid: string, extra: Partial<PackQuestion> = {}): PackQuestion => ({
  local_id: lid, subject: 'science', topic_id: 'ST0003', class: 2, level: 2, format: 'MCQ-4', text: `Q ${lid}?`, options: ['a', 'b', 'c', 'd'], answer: 'C',
  solution_1: 'Because c.', linked_rows: [{ row_id: 'C2-ZQ-001', role: 'primary' }, { row_id: 'C2-ZQ-002', role: 'supporting' }],
  wrong_option_tags: [{ option: 'A', tag: 'misconception', row_id: 'C2-ZQ-001', item_no: 1 }], passed: true, warnings: [], checks: {},
  originality: { result: 'clear', similarity: 0.2 }, ...extra,
});
const pack = (questions: PackQuestion[], route: 'A' | 'B' = 'B'): Pack => ({
  file_schema: 'generation-pack/1', run: { source_run: 'T1', subject: 'science', route },
  originality: { tool: 't', checked_at: '2026-11-23', threshold: 0.6, near_copy_threshold: 0.85 }, questions,
});
const review = (d: Record<string, 'approve' | 'fix' | 'drop' | 'rescue'>): ReviewDecisions =>
  ({ sha256: '0'.repeat(64), decisions: new Map(Object.entries(d).map(([k, v]) => [k, { decision: v, comment: null, sheet: 'Questions' }])) });

describe('pack checks', () => {
  it('accepts a good pack', () => expect(packProblems(pack([q('A-1')]))).toEqual([]));
  it('names the question and the problem', () => {
    const p = packProblems(pack([
      q('A-1', { wrong_option_tags: [{ option: 'C', tag: 'partial' }] }),
      q('A-2', { linked_rows: [{ row_id: 'C2-ZQ-001', role: 'primary' }, { row_id: 'C2-ZQ-002', role: 'primary' }] }),
      q('A-3', { options: ['a', 'b', 'c'] }),
      q('A-3'),
      q('A-4', { wrong_option_tags: [{ option: 'B', tag: 'concept_error', row_id: 'C9-XX-001' }] }),
      q('A-5', { setting: { new: 'nowhere' } }),
    ]));
    expect(p).toEqual([
      "A-1: the correct option C can't be tagged",
      'A-2: needs exactly one primary row',
      'A-3: MCQ-4 needs 4 options, it has 3',
      'A-3: local_id is used twice in the run',
      'A-4: option B concept_error needs a row of its own linked rows (C9-XX-001)',
      'A-5: new setting "nowhere" is not in catalogue_new.settings',
    ]);
  });
  it('schema problems are in plain words', () => {
    const bad = { ...pack([q('A-1')]), questions: [{ ...q('A-1'), extra: 1 }] };
    expect(packProblems(bad)).toEqual(['A-1: unknown field "extra"']);
  });
  it('route B must have checked originality on the Mac; route A may not', () => {
    expect(packProblems(pack([q('A-1', { originality: 'not_checked' })], 'B'))[0]).toMatch(/route B checks originality on the Mac before writing; not checked: A-1/);
    expect(packProblems(pack([q('A-1', { originality: 'not_checked' })], 'A'))).toEqual([]);
  });
  it('only Science packs for now', () => expect(packProblems({ ...pack([]), run: { source_run: 'T', subject: 'math', route: 'B' } })[0]).toMatch(/only Science packs/));
  it('checks figures: present, unchanged, PNG, at least 1800 px wide', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genfig-'));
    const png = (w: number) => { const b = Buffer.alloc(33); b.writeUInt32BE(0x89504e47, 0); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(100, 20); return b; };
    writeFileSync(join(dir, 'ok.png'), png(1800)); writeFileSync(join(dir, 'small.png'), png(900));
    expect(pngSize(png(1800))).toEqual({ width: 1800, height: 100 });
    const p = pack([q('F-1', { figure: { file: 'ok.png', sha256: sha256(png(1800)) } }), q('F-2', { figure: { file: 'small.png', sha256: sha256(png(900)) } }),
                    q('F-3', { figure: { file: 'ok.png', sha256: 'a'.repeat(64) } }), q('F-4', { figure: { file: 'gone.png', sha256: 'a'.repeat(64) } })]);
    expect(packProblems(p, dir)).toEqual(['F-2: figure small.png is 900 px wide; the figure rule needs ≥ 1800 px', 'F-3: figure ok.png changed since the pack was made (sha256)', 'F-4: figure gone.png is missing']);
  });
});

describe('what is imported', () => {
  const all = [q('B-1'), q('B-2'), q('B-3', { passed: false }), q('B-4', { originality: { result: 'near_copy', similarity: 0.9, closest_ref: 'X p1' } }), q('B-5'), q('B-6', { passed: false })];
  it('pilot: only Approve (and Rescue of a failed one); never a near-copy', () => {
    const r = planItems(pack(all), 'pilot', review({ 'B-1': 'approve', 'B-2': 'fix', 'B-3': 'approve', 'B-4': 'approve', 'B-6': 'rescue' }));
    expect(r.map((x) => [x.q.local_id, x.drop?.status ?? 'import'])).toEqual([
      ['B-1', 'import'], ['B-2', 'dropped_review'], ['B-3', 'dropped_checks'], ['B-4', 'dropped_near_copy'], ['B-5', 'dropped_review'], ['B-6', 'import']]);
    expect(r[1]!.drop!.reason).toBe('Mac review: Fix (not imported until approved)');
    expect(r[0]!.q.review).toEqual({ decision: 'approve', comment: null });
  });
  it('steady: everything that passed, unless dropped in review', () => {
    const r = planItems(pack(all), 'steady', review({ 'B-5': 'drop' }));
    expect(r.map((x) => x.drop?.status ?? 'import')).toEqual(['import', 'import', 'dropped_checks', 'dropped_near_copy', 'dropped_review', 'dropped_checks']);
  });
  it('the content hash ignores the review, warnings, checks and score, but not the question', () => {
    const h = contentHash(q('H-1'));
    expect(contentHash(q('H-1', { review: { decision: 'approve' }, warnings: [{ kind: 'x', reason: 'y' }], checks: { a: 1 }, originality: { result: 'flagged', similarity: 0.7 } }))).toBe(h);
    expect(contentHash(q('H-1', { options: ['a', 'b', 'c', 'e'] }))).not.toBe(h);
    expect(contentHash(q('H-1', { linked_rows: [{ row_id: 'C2-ZQ-001', role: 'primary' }, { row_id: 'C2-ZQ-002', role: 'secondary' }] }))).not.toBe(h);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it('the database item carries the R2 key and the run-level originality details', () => {
    const it = dbItem(pack([]), q('K-1', { figure: { file: 'f.png', sha256: 'b'.repeat(64) } }), 'GR0007');
    expect(it.figure).toEqual({ key: 'figures/GR0007-K-1.png', sha256: 'b'.repeat(64) });
    expect(it.originality).toMatchObject({ result: 'clear', tool: 't', threshold: 0.6, near_copy_threshold: 0.85, checked: [], missing: [] });
    expect(figureKey('GR0001', 'PILOT04-ST0003-07')).toMatch(/^figures\/[A-Za-z0-9._-]+\.png$/);
  });
});

describe('PILOT04 adapter', () => {
  it('parses wrong-option tags (untagged left out)', () => {
    expect(parseWrongTags('A: misconception:C2-DLV-003 #1; C: untagged; D: concept_error:C1-DPL-010; B: partial')).toEqual({ problems: [], tags: [
      { option: 'A', tag: 'misconception', row_id: 'C2-DLV-003', item_no: 1 }, { option: 'D', tag: 'concept_error', row_id: 'C1-DPL-010', item_no: null },
      { option: 'B', tag: 'partial', row_id: null, item_no: null }] });
    expect(parseWrongTags('A misconception').problems).toHaveLength(1);
    expect(parseWrongTags('A: misconception:C2-DLV-003').problems[0]).toMatch(/not "<row> #n"/);
  });
  it('parses item references and linked rows with roles', () => {
    expect(parseItemRef('C2-DLV-003 #1')).toEqual({ row_id: 'C2-DLV-003', item_no: 1 });
    expect(parseItemRef('')).toBeNull();
    expect(parseItemRef('free text')).toBeUndefined();
    expect(linkedRows({ 'Primary row': 'C4-03-057', 'Secondary rows': 'C4-03-058; C4-03-057', 'Supporting rows': 'C1-DPL-010, C4-03-058' })).toEqual([
      { row_id: 'C4-03-057', role: 'primary' }, { row_id: 'C4-03-058', role: 'secondary' }, { row_id: 'C1-DPL-010', role: 'supporting' }]);
    expect(settingSlug('Lac bangle shop at a village fair')).toBe('lac-bangle-shop-at-a-village-fair');
  });
  it('turns a run folder into a pack (settings as new catalogue items, Grade as class)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pilot-'));
    const rec = { Slot: 'PX-ST0003-01', Topic: 'ST0003', Grade: 6, Level: 6, Question: 'Which?', Format: 'Scenario MCQ', 'Option A': 'w', 'Option B': 'x', 'Option C': 'y', 'Option D': 'z',
      Answer: 'B', 'Solution 1': 'Because x.', 'Primary row': 'C2-DLV-003', 'Secondary rows': '', 'Supporting rows': 'C1-DPL-010', 'Science question type': 3,
      Setting: 'Potted plant near a window', 'Setting familiarity': 'Everyday', 'Hidden idea': 'N', Experiment: 'Y', 'Reading (1-5)': 2, Steps: 1, 'Inhibition (0-3)': 2,
      'Irrelevant info': 'N', 'Visual (0-3)': 0, 'Misconception targeted': 'C2-DLV-003 #1', 'Wrong-option tags': 'A: misconception:C2-DLV-003 #1; C: untagged; D: concept_error:C1-DPL-010',
      _passed: true, _figure_file: '', _figure_kind: 'none', 'Warning reason': 'type 3 -> 4 (tier change)', _warn_list: [['type', 'type 3 -> 4 (tier change)']], 'Blind solve': 'B = key' };
    writeFileSync(join(dir, 'questions_checked.json'), JSON.stringify([rec, { ...rec, Slot: 'PX-ST0003-02', Setting: '(blank)', 'Setting familiarity': 'Bare' }]));
    writeFileSync(join(dir, 'run_meta.json'), JSON.stringify({ run: 'PX', topics: ['ST0003'], cms_code: { cms_repo_head: 'abc' } }));
    writeFileSync(join(dir, 'originality.json'), JSON.stringify({ tool: 't', checked_at: 'now', threshold: 0.6, near_copy_threshold: 0.85, read: [], missing: [],
      questions: [{ key: 'PX-ST0003-01', result: 'clear', similarity: 0.3, closest_ref: 'B p2', field: 'text', same_numbers: false }] }));
    writeFileSync(join(dir, 'calls.jsonl'), [{ tag: 'gen:x', model: 'claude-sonnet-5-5', cost_usd: 0.5, input_tokens: 10, output_tokens: 5 }, { tag: 'solve:x', model: 'claude-haiku-5-5', cost_usd: 0.01 }].map((x) => JSON.stringify(x)).join('\n'));
    const { pack: p, problems } = pilotToPack(dir);
    expect(problems).toEqual([]);
    expect(p.run).toMatchObject({ source_run: 'PX', route: 'B', subject: 'science', cms_commit: 'abc', models: { writer: 'claude-sonnet-5-5', solver: 'claude-haiku-5-5' }, cost_usd: 0.51 });
    expect(p.catalogue_new!.settings).toEqual([{ local_id: 'potted-plant-near-a-window', name: 'Potted plant near a window', description: null }]);
    const [a, b] = p.questions;
    expect(a).toMatchObject({ class: 6, level: 6, format: 'MCQ-4', display_format: 'Scenario MCQ', answer: 'B', setting: { new: 'potted-plant-near-a-window' }, experiment: true,
      linked_rows: [{ row_id: 'C2-DLV-003', role: 'primary' }, { row_id: 'C1-DPL-010', role: 'supporting' }], misconception: { row_id: 'C2-DLV-003', item_no: 1 },
      drivers: { reading: 2, steps: 1, inhibition: 2, visual: 0, irrelevant_info: false }, warnings: [{ kind: 'type', reason: 'type 3 -> 4 (tier change)' }],
      originality: { result: 'clear', similarity: 0.3 } });
    expect(b!.setting).toBeNull();
    expect(b!.originality).toBe('not_checked');
    expect(packProblems(p, dir)).toEqual(['route B checks originality on the Mac before writing; not checked: PX-ST0003-02']);
  });
});

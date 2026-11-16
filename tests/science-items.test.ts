// Science misconception items, matching, primary rows, Solution 1 (Q16 Q17 Q18, 16 Nov 2026). Synthetic rows (our own words).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { matchItem, mentionsWrongOption, optionItem, parseItemRef, proposePrimary, similarity, splitMisconceptions, tidyItem, type SplitDecision } from '../shared/science-items.ts';

const decisions = (JSON.parse(readFileSync(new URL('../scripts/lib/science-splits.json', import.meta.url), 'utf8')) as { rows: Record<string, SplitDecision> }).rows;

describe('splitting a row\'s misconceptions', () => {
  it('one sentence is one item', () => {
    expect(splitMisconceptions('Like poles attract.')).toMatchObject({ items: ['Like poles attract.'], unclear: false, rule: 'single' });
  });
  it('two sentences are two items', () => {
    expect(splitMisconceptions('Deserts are full of water. Every desert is hot and sandy.').items).toEqual(['Deserts are full of water.', 'Every desert is hot and sandy.']);
  });
  it('"; or," gives two items, without the "or,"', () => {
    expect(splitMisconceptions('The Sun is not a star; or, stars are tiny points of light.').items).toEqual(['The Sun is not a star.', 'Stars are tiny points of light.']);
  });
  it('an abbreviation does not end a sentence', () => {
    expect(splitMisconceptions('Before J.C. Bose, nobody knew that plants were living things.').items).toHaveLength(1);
  });
  it('a plain ";" is kept whole and marked unclear', () => {
    expect(splitMisconceptions('Litter only looks ugly; it does no harm.')).toMatchObject({ items: ['Litter only looks ugly; it does no harm.'], unclear: true, rule: 'kept-semicolon' });
  });
  it('a correction is kept whole and marked unclear', () => {
    expect(splitMisconceptions('All bricks are cut from rocks. (Baked bricks are moulded from mud.)')).toMatchObject({ unclear: true, rule: 'kept-correction' });
  });
  it('a reviewed decision wins, but only for the same text', () => {
    const d: SplitDecision = { text: 'Bats are birds; whales are fish.', action: 'split', note: 'two' };
    expect(splitMisconceptions('Bats are birds; whales are fish.', d).items).toEqual(['Bats are birds.', 'Whales are fish.']);
    expect(splitMisconceptions('Bats are birds; whales are big fish.', d).rule).toBe('kept-semicolon');
  });
  it('the decisions file covers its rows with the expected outcome', () => {
    expect(splitMisconceptions(decisions['C6-02-035']!.text, decisions['C6-02-035']).items).toHaveLength(2);
    expect(splitMisconceptions(decisions['C6-04-028']!.text, decisions['C6-04-028']).items).toHaveLength(2);
    expect(splitMisconceptions(decisions['C6-10-012']!.text, decisions['C6-10-012'])).toMatchObject({ items: [decisions['C6-10-012']!.text], unclear: false });
    expect(splitMisconceptions(decisions['C6-01-019']!.text, decisions['C6-01-019']).items).toEqual(["Everyone's normal temperature is exactly 37 °C at all times."]);
    expect(Object.values(decisions).filter((d) => d.unclear)).toHaveLength(4);
  });
  it('tidy: capital, full stop, single spaces', () => {
    expect(tidyItem('  whales  are fish ')).toBe('Whales are fish.');
  });
});

describe('matching a misconception text to an item', () => {
  const items = [
    { row_id: 'C6-04-014', item_no: 1, text: 'A magnet attracts all shiny objects.' },
    { row_id: 'C6-04-001', item_no: 1, text: 'A magnet sticks to any surface, such as a wooden door or a wall.' },
    { row_id: 'C6-04-036', item_no: 1, text: 'Like poles attract.' },
  ];
  it('exact (case and punctuation ignored)', () => {
    expect(matchItem('like poles attract', items)).toMatchObject({ kind: 'exact', best: { row_id: 'C6-04-036' } });
  });
  it('a reference "C6-04-014 #1" is exact', () => {
    expect(matchItem('C6-04-014 #1', items).best?.row_id).toBe('C6-04-014');
    expect(parseItemRef('C6-04-014 #12')).toEqual({ row_id: 'C6-04-014', item_no: 12 });
  });
  it('fuzzy when one item is clearly closest', () => {
    expect(matchItem('A magnet attracts every shiny object.', items)).toMatchObject({ kind: 'fuzzy', best: { row_id: 'C6-04-014' } });
  });
  it('none when nothing is close', () => {
    expect(matchItem('Plants eat soil.', items).kind).toBe('none');
  });
  it('ambiguous when two items are equally close', () => {
    const two = [{ row_id: 'C6-01-001', item_no: 1, text: 'Magnets attract all metals.' }, { row_id: 'C6-01-002', item_no: 1, text: 'Magnets attract all metal things.' }];
    expect(matchItem('Magnets attract all metal.', two).kind).toBe('ambiguous');
  });
  it('a wrong option is tagged only when its text states an item', () => {
    expect(optionItem('Like poles attract', items)?.row_id).toBe('C6-04-036');
    expect(optionItem('Wood', items)).toBeNull();
  });
  it('similarity is symmetric and 1 for the same text', () => {
    expect(similarity('a b c', 'a b c')).toBe(1);
    expect(similarity('Magnets pull iron', 'iron is pulled by magnets')).toBe(similarity('iron is pulled by magnets', 'Magnets pull iron'));
  });
});

describe('primary row', () => {
  const rows = [{ row_id: 'C6-04-031', content: 'A compass needle is a small magnet that points north-south.', sort: 31 },
    { row_id: 'C6-04-039', content: 'Like poles repel and unlike poles attract.', sort: 39 }];
  it('one direct row is the primary', () => {
    expect(proposePrimary(rows.slice(0, 1), { text: 'x', correct: 'y' }, null).row_id).toBe('C6-04-031');
  });
  it('the row holding the misconception item wins', () => {
    expect(proposePrimary(rows, { text: 'x', correct: 'y' }, 'C6-04-039')).toMatchObject({ row_id: 'C6-04-039', reason: expect.stringContaining('misconception') });
  });
  it('else the closest wording', () => {
    expect(proposePrimary(rows, { text: 'What happens when two like poles are brought close?', correct: 'They repel' }, null).row_id).toBe('C6-04-039');
  });
});

describe('Solution 1', () => {
  const wrong = [{ text: 'Wood', position: 1 }, { text: 'Plastic spoon', position: 3 }];
  it('sees a wrong option by its text or letter', () => {
    expect(mentionsWrongOption('Iron is attracted; a plastic spoon is not.', wrong)).toBe(true);
    expect(mentionsWrongOption('Option A is wrong because wood is not magnetic.', wrong)).toBe(true);
    expect(mentionsWrongOption('Iron is a magnetic material, so the magnet attracts it.', wrong)).toBe(false);
  });
});

describe('brackets: gloss or correction', () => {
  it('a one-word gloss is not a correction', () => {
    expect(splitMisconceptions('The white cloud above a kettle is water vapour (steam).')).toMatchObject({ unclear: false, rule: 'single' });
  });
  it('a long bracket is a correction', () => {
    expect(splitMisconceptions('All metals are found ready-made. (Most are not, though a few are.)').rule).toBe('kept-correction');
  });
});

// Phase 6 (G1–G3, 9 Nov 2026): draft generation logic shared by the Pages Function, the
// browser and the tests. The function owns the schema; the browser builds the prompt,
// parses drafts, checks them and saves them through cms_apply_save.
import { stableJson } from './json.ts';
import { sha256Hex } from './sha256.ts';
import type { Question } from './types.ts';
import { numbersIn } from './version.ts';

// ---------------------------------------------------------------- output schema
const str = { type: 'string' } as const;
const int = { type: 'integer' } as const;
const conceptRef = { type: 'object', additionalProperties: false, required: ['concept_id', 'involvement'],
  properties: { concept_id: str, involvement: { type: 'number', enum: [1, 0.5, 0.2] } } };
const wrong = { type: 'object', additionalProperties: false, required: ['value', 'tag', 'misconception_id', 'target_concept_id', 'why'],
  properties: { value: str, tag: { type: 'string', enum: ['misconception', 'concept_error', 'shortcut', 'partial', 'lost_step', 'used_irrelevant', 'misread', 'unit_slip', 'implausible'] },
    misconception_id: str, target_concept_id: str, why: str } };
const why = { type: 'object', additionalProperties: false, required: ['attribute', 'why', 'confidence'],
  properties: { attribute: str, why: str, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } } };

/** One draft question, as the model must return it (structured output). An empty string (or "none") means "not present". */
export const DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['drafts'],
  properties: { drafts: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['text', 'figure_description', 'format', 'options', 'correct', 'accepted', 'wrong_answers', 'concepts', 'signature', 'duration_s',
      'solution_school', 'solution_second', 'solution_second_type', 'solution_second_strategy', 'hints', 'tagging_why', 'tagging_summary'],
    properties: {
      text: str, figure_description: str,
      format: { type: 'string', enum: ['MCQ-4', 'MCQ-3', 'True/False', 'Typed-number', 'Typed-decimal', 'Typed-fraction', 'Typed-text'] },
      options: { type: 'array', items: str }, correct: str, accepted: { type: 'array', items: str },
      wrong_answers: { type: 'array', items: wrong }, concepts: { type: 'array', items: conceptRef },
      signature: { type: 'object', additionalProperties: false,
        required: ['math_difficulty', 'is_pure_fact', 'reading', 'has_irrelevant_info', 'steps', 'working_memory', 'inhibition', 'visual', 'strategy', 'strategy_type', 'insight_id'],
        properties: { math_difficulty: { type: 'string', enum: ['Simple', 'Medium', 'Complex'] }, is_pure_fact: { type: 'boolean' }, reading: int,
          has_irrelevant_info: { type: 'boolean' }, steps: int, working_memory: int, inhibition: int, visual: int, strategy: int,
          strategy_type: str, insight_id: str } },
      duration_s: { type: 'integer', enum: [30, 60, 90, 120] },
      solution_school: str, solution_second: str,
      solution_second_type: { type: 'string', enum: ['Smarter way', 'Another way', 'none'] }, solution_second_strategy: str,
      hints: { type: 'array', items: str }, tagging_why: { type: 'array', items: why }, tagging_summary: str,
    } } } },
} as const;

export interface RawDraft {
  text: string; figure_description: string; format: Question['answer']['format']; options: string[]; correct: string; accepted: string[];
  wrong_answers: { value: string; tag: string; misconception_id: string; target_concept_id: string; why: string }[];
  concepts: { concept_id: string; involvement: number }[];
  signature: { math_difficulty: 'Simple' | 'Medium' | 'Complex'; is_pure_fact: boolean; reading: number; has_irrelevant_info: boolean; steps: number;
    working_memory: number; inhibition: number; visual: number; strategy: number; strategy_type: string; insight_id: string };
  duration_s: 30 | 60 | 90 | 120; solution_school: string; solution_second: string; solution_second_type: 'Smarter way' | 'Another way' | 'none';
  solution_second_strategy: string; hints: string[]; tagging_why: { attribute: string; why: string; confidence: 'high' | 'medium' | 'low' }[]; tagging_summary: string;
}

// ---------------------------------------------------------------- tagging pack (cached system prompt)
export interface PackInput {
  ruleVersion: string;
  attributes: { attribute: string; meaning: string | null; values: string | null }[];
  rubric: { attribute: string; definition: string | null; levels_anchors: string | null; rules: string | null; edge_cases: string | null }[];
  calibration: { case_id: string; attribute: string | null; first_value: string | null; final_value: string | null; why_wrong: string | null; rule: string | null }[];
  strategyTypes: string[];
  /** gold questions marked "prompt example" only; test-only gold must never reach a prompt */
  examples: { qid: string; use: string; question: Question }[];
}

export function buildPack(p: PackInput): { text: string; version: string; hash: string; excludedTestOnly: number } {
  const examples = p.examples.filter((e) => e.use === 'prompt_example');
  const lines = [
    'You write practice questions for an Indian school app (classes 1-6) and tag them with the WitoScope question attributes.',
    `Attribute rules: ${p.ruleVersion}. Follow them exactly; when unsure, choose the lower value and say why.`,
    '', '## Attributes', ...p.attributes.map((a) => `- ${a.attribute}: ${a.meaning ?? ''}${a.values ? ` (values: ${a.values})` : ''}`),
    '', '## Tagging rubric', ...p.rubric.map((r) => [`### ${r.attribute}`, r.definition, r.levels_anchors && `Levels: ${r.levels_anchors}`, r.rules && `Rules: ${r.rules}`, r.edge_cases && `Edge cases: ${r.edge_cases}`].filter(Boolean).join('\n')),
    '', '## Calibration cases (first value was wrong; the final value is right)',
    ...p.calibration.map((c) => `- ${c.case_id} ${c.attribute}: ${c.first_value} → ${c.final_value}. ${c.why_wrong ?? ''} Rule: ${c.rule ?? ''}`),
    '', `## Strategy types: ${p.strategyTypes.join(', ')}`,
    '', '## Reference questions (already tagged correctly)',
    ...examples.map((e) => `${e.qid}: ${stableJson({ text: e.question.text, answer: e.question.answer, concepts: e.question.concepts, signature: e.question.signature })}`),
    '', '## Rules for every draft',
    '- Write original questions. Never copy a textbook question or keep its numbers.',
    '- Every wrong MCQ option is a believable mistake and is tagged; a misconception tag names a misconception ID from the request.',
    '- The correct answer must be exactly one of the options for MCQ and True/False.',
    '- Use Indian context (₹, Indian names) and simple English for the class.',
  ];
  const text = lines.join('\n');
  const hash = sha256Hex(text);
  return { text, hash, version: `${p.ruleVersion}-${hash.slice(0, 10)}`, excludedTestOnly: p.examples.length - examples.length };
}

// ---------------------------------------------------------------- request prompt
export interface GenerateSettings {
  count: number; difficulties: ('Simple' | 'Medium' | 'Complex')[]; vary: { numbers: boolean; story: boolean; format: boolean };
  classLevel: number; topicName: string; setName: string; patternName: string | null;
  concepts: { concept_id: string; name: string }[]; misconceptions: { misconception_id: string; description: string }[];
}

export function buildPrompt(source: Question | null, s: GenerateSettings): string {
  const vary = [s.vary.numbers && 'the numbers', s.vary.story && 'the story or context', s.vary.format && 'the answer format'].filter(Boolean).join(', ') || 'the numbers';
  return [
    `Write ${s.count} new draft question${s.count === 1 ? '' : 's'} for Class ${s.classLevel}, topic "${s.topicName}", question type "${s.setName}"${s.patternName ? `, pattern "${s.patternName}"` : ''}.`,
    `Math difficulty for the drafts, in order: ${s.difficulties.join(', ')}.`,
    `Change ${vary} compared with the source; keep the same skill.`,
    `Use only these concept IDs: ${s.concepts.map((c) => `${c.concept_id} (${c.name})`).join('; ') || 'none listed'}.`,
    `Misconception IDs you may tag: ${s.misconceptions.map((m) => `${m.misconception_id} (${m.description})`).join('; ') || 'none'}.`,
    source ? `Source question: ${stableJson({ text: source.text, answer: source.answer, concepts: source.concepts, signature: source.signature, solutions: source.solutions, hints: source.hints })}` : 'There is no source question; follow the question type.',
    'Return JSON matching the schema. Tag every attribute with a short why.',
  ].join('\n');
}

/** Split a fill request across difficulties: missing levels first, then round-robin. */
export function difficultiesFor(count: number, missing: ('Simple' | 'Medium' | 'Complex')[], same: 'Simple' | 'Medium' | 'Complex' | null): ('Simple' | 'Medium' | 'Complex')[] {
  const cycle = missing.length ? missing : same ? [same] : ['Simple', 'Medium', 'Complex'] as const;
  return Array.from({ length: count }, (_, i) => cycle[i % cycle.length]!);
}

// ---------------------------------------------------------------- parse drafts → chapter-file questions
export function toQuestion(d: RawDraft, ctx: { key: string; topic_id: string; typical_set_id: string; pattern_id: string | null; clone_batch_id: string }): Question {
  const isOptions = d.format === 'MCQ-4' || d.format === 'MCQ-3' || d.format === 'True/False';
  return {
    key: ctx.key, topic_id: ctx.topic_id, typical_set_id: ctx.typical_set_id, ...(ctx.pattern_id ? { pattern_id: ctx.pattern_id } : {}),
    clone_batch_id: ctx.clone_batch_id, locale: 'IN', text: d.text,
    ...(d.figure_description ? { figure: { description: d.figure_description, image_status: 'needs_image' as const } } : {}),
    answer: { format: d.format, ...(isOptions ? { options: d.options } : {}), correct: d.correct, accepted: d.accepted,
      wrong_answers: d.wrong_answers.map((w) => ({ value: w.value, tag: w.tag as never, ...(w.misconception_id ? { misconception_id: w.misconception_id } : {}),
        ...(w.target_concept_id ? { target_concept_id: w.target_concept_id } : {}), ...(w.why ? { why: w.why } : {}) })) },
    concepts: d.concepts.map((c) => ({ concept_id: c.concept_id, involvement: c.involvement as 1 })),
    signature: { math_difficulty: d.signature.math_difficulty, is_pure_fact: d.signature.is_pure_fact, reading: d.signature.reading,
      has_irrelevant_info: d.signature.has_irrelevant_info, steps: d.signature.steps, working_memory: d.signature.working_memory,
      inhibition: d.signature.inhibition, visual: d.signature.visual, strategy: d.signature.strategy,
      ...(d.signature.strategy_type ? { strategy_type: d.signature.strategy_type } : {}), ...(d.signature.insight_id ? { insight_id: d.signature.insight_id } : {}) },
    duration_s: d.duration_s,
    solutions: { school: d.solution_school, ...(d.solution_second ? { second: { text: d.solution_second, type: d.solution_second_type === 'none' ? 'Another way' : d.solution_second_type,
      ...(d.solution_second_strategy ? { strategy: d.solution_second_strategy } : {}) } } : {}) },
    hints: d.hints.slice(0, 3),
    tagging: { tagged_by: 'ai', why: Object.fromEntries(d.tagging_why.map((w) => [w.attribute, { why: w.why, confidence: w.confidence }])), summary: d.tagging_summary },
  };
}

// ---------------------------------------------------------------- duplicate / copy checks (G2)
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}/.]+/gu, ' ').trim();
function trigrams(s: string): Map<string, number> {
  const t = ` ${norm(s)} `, m = new Map<string, number>();
  for (let i = 0; i + 3 <= t.length; i++) { const g = t.slice(i, i + 3); m.set(g, (m.get(g) ?? 0) + 1); }
  return m;
}
/** Dice coefficient on character trigrams, 0…1. */
export function similarity(a: string, b: string): number {
  const x = trigrams(a), y = trigrams(b);
  let inter = 0, nx = 0, ny = 0;
  for (const [, v] of x) nx += v;
  for (const [, v] of y) ny += v;
  for (const [g, v] of x) inter += Math.min(v, y.get(g) ?? 0);
  return nx + ny === 0 ? 0 : (2 * inter) / (nx + ny);
}
export const numberSet = (s: string) => numbersIn({ s });
const sameNumbers = (a: string[], b: string[]) => a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);

export interface Candidate { id: string; kind: 'question' | 'source_item'; text: string }
export interface Hit { id: string; kind: Candidate['kind']; similarity: number; sameNumbers: boolean }

/** Flag a draft whose numbers match a candidate's, or whose wording is ≥ threshold similar. */
export function checkAgainst(text: string, candidates: Candidate[], threshold: number): Hit[] {
  const nums = numberSet(text);
  return candidates.map((c) => ({ id: c.id, kind: c.kind, similarity: Math.round(similarity(text, c.text) * 100) / 100, sameNumbers: sameNumbers(nums, numberSet(c.text)) }))
    .filter((h) => h.sameNumbers || h.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity);
}

// ---------------------------------------------------------------- cost
export interface Price { input: number; output: number; cache_write: number; cache_read: number } // USD per million tokens
export interface Usage { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }
export function costUsd(u: Usage, p: Price, batch = false): number {
  const usd = (u.input_tokens * p.input + u.output_tokens * p.output + (u.cache_creation_input_tokens ?? 0) * p.cache_write + (u.cache_read_input_tokens ?? 0) * p.cache_read) / 1e6;
  return Math.round(usd * (batch ? 0.5 : 1) * 1e6) / 1e6;
}

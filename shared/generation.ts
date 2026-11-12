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

// ---------------------------------------------------------------- prompt parts
// Phase 6 update (9 Nov 2026): every request = a FIXED rules block (cached system prompt,
// identical for every request of a task) + a small per-topic context (the topic's concept
// cards and the relevant calibration cases) in the user message, so requests stay well
// under 100K tokens (the long-context price threshold) and the cache is reused across topics.
export type AiTask = 'generate' | 'tag' | 'extract';

export interface RulesInput {
  ruleVersion: string;
  attributes: { attribute: string; meaning: string | null; values: string | null }[];
  rubric: { attribute: string; definition: string | null; levels_anchors: string | null; rules: string | null; edge_cases: string | null }[];
  strategyTypes: string[];
}

const GENERATE_RULES = [
  '## Rules for every draft',
  '- Write original questions. Never copy a textbook question or keep its numbers.',
  '- Every wrong MCQ option is a believable mistake and is tagged; a misconception tag names a misconception ID from the request.',
  '- The correct answer must be exactly one of the options for MCQ and True/False.',
  '- Use Indian context (₹, Indian names) and simple English for the class.',
  // D8b (Sambit, 12 Nov 2026): the pattern rule, same text as claude/question-bank/generation-prompt.md
  '- A pattern is the pure maths skeleton plus every constraint that changes the skill (signs, crossing zero, carrying or borrowing, like or unlike denominators, remainders, the position of the unknown). Keep every one of those constraints of the requested pattern.',
  '- A pattern never includes the story. The story or context (the setting: a lift, a thermometer, a bank balance, or a bare calculation) may change between drafts; the skill may not.',
];
const TAG_RULES = [
  '## Rules for tagging',
  '- Tag the question exactly as it is written; do not rewrite it.',
  '- Use only concept IDs and misconception IDs listed in the request.',
  '- Tag every wrong answer listed in the request, in the same order, with its value unchanged.',
  '- Give a short why for each attribute.',
];

/** The fixed, cached system prompt for a task: attribute definitions, the tagging rubric, strategy types and the task's rules. No topic data. */
export function buildRules(task: AiTask, p: RulesInput): { text: string; version: string; hash: string } {
  const lines = [
    task === 'generate' ? 'You write practice questions for an Indian school app (classes 1-6) and tag them with the WitoScope question attributes.'
      : 'You tag practice questions for an Indian school app (classes 1-6) with the WitoScope question attributes.',
    `Attribute rules: ${p.ruleVersion}. Follow them exactly; when unsure, choose the lower value and say why.`,
    'The request gives the topic\'s concept cards, the calibration cases that matter for it, and reference questions.',
    '', '## Attributes', ...p.attributes.map((a) => `- ${a.attribute}: ${a.meaning ?? ''}${a.values ? ` (values: ${a.values})` : ''}`),
    '', '## Tagging rubric', ...p.rubric.map((r) => [`### ${r.attribute}`, r.definition, r.levels_anchors && `Levels: ${r.levels_anchors}`, r.rules && `Rules: ${r.rules}`, r.edge_cases && `Edge cases: ${r.edge_cases}`].filter(Boolean).join('\n')),
    '', `## Strategy types: ${p.strategyTypes.join(', ')}`,
    '', ...(task === 'generate' ? GENERATE_RULES : TAG_RULES),
  ];
  const text = lines.join('\n');
  const hash = sha256Hex(text);
  return { text, hash, version: `${p.ruleVersion}-${task}-${hash.slice(0, 10)}` };
}

export interface CalibrationCase { case_id: string; attribute: string | null; first_value: string | null; final_value: string | null; why_wrong: string | null; rule: string | null;
  /** class of the case's question, and whether that question is test-only gold (never sent) */
  class: number | null; test_only: boolean }

/** Calibration cases for a class: per attribute, the cases within one class of it; an attribute with none there keeps its nearest cases. Test-only never. */
export function pickCalibration(cases: CalibrationCase[], classLevel: number): CalibrationCase[] {
  const usable = cases.filter((c) => !c.test_only);
  const dist = (c: CalibrationCase) => c.class === null ? 9 : Math.abs(c.class - classLevel);
  const out: CalibrationCase[] = [];
  for (const attr of [...new Set(usable.map((c) => c.attribute ?? ''))]) {
    const mine = usable.filter((c) => (c.attribute ?? '') === attr);
    const near = mine.filter((c) => dist(c) <= 1);
    const min = Math.min(...mine.map(dist));
    out.push(...(near.length ? near : mine.filter((c) => dist(c) === min)));
  }
  return out.sort((a, b) => a.case_id.localeCompare(b.case_id));
}

export interface ConceptCard { concept_id: string; name: string; type?: string | null; description?: string | null; includes?: string | null; excludes?: string | null; example_question?: string | null }
export interface ContextInput {
  cards: ConceptCard[];
  misconceptions: { misconception_id: string; concept_id?: string | null; description: string }[];
  calibration: CalibrationCase[];
  /** gold questions marked "prompt example" only; test-only gold must never reach a prompt */
  examples: { qid: string; use: string; question: Question }[];
}

/** The per-topic part of the user message. */
export function buildContext(c: ContextInput): { text: string; excludedTestOnly: number } {
  const examples = c.examples.filter((e) => e.use === 'prompt_example');
  const text = [
    '## Concept cards for this topic',
    ...(c.cards.length ? c.cards.map((k) => [`- ${k.concept_id} ${k.name}${k.type ? ` [${k.type}]` : ''}`, k.description && `  ${k.description}`, k.includes && `  Includes: ${k.includes}`,
      k.excludes && `  Excludes: ${k.excludes}`, k.example_question && `  Example: ${k.example_question}`].filter(Boolean).join('\n')) : ['(none)']),
    '', '## Misconceptions', ...(c.misconceptions.length ? c.misconceptions.map((m) => `- ${m.misconception_id}${m.concept_id ? ` (${m.concept_id})` : ''}: ${m.description}`) : ['(none)']),
    '', '## Calibration cases (first value was wrong; the final value is right)',
    ...c.calibration.map((k) => `- ${k.case_id} ${k.attribute}: ${k.first_value} → ${k.final_value}. ${k.why_wrong ?? ''} Rule: ${k.rule ?? ''}`),
    '', '## Reference questions (already tagged correctly)',
    ...(examples.length ? examples.map((e) => `${e.qid}: ${stableJson({ text: e.question.text, answer: e.question.answer, concepts: e.question.concepts, signature: e.question.signature })}`) : ['(none)']),
  ].join('\n');
  return { text, excludedTestOnly: c.examples.length - examples.length };
}

// ---------------------------------------------------------------- request prompt
export interface GenerateSettings {
  count: number; difficulties: ('Simple' | 'Medium' | 'Complex')[]; vary: { numbers: boolean; story: boolean; format: boolean };
  classLevel: number; topicName: string; setName: string; patternName: string | null;
  concepts: { concept_id: string; name: string }[]; misconceptions: { misconception_id: string; description: string }[];
}

export function buildPrompt(source: Question | null, s: GenerateSettings, context = ''): string {
  const vary = [s.vary.numbers && 'the numbers', s.vary.story && 'the story or context', s.vary.format && 'the answer format'].filter(Boolean).join(', ') || 'the numbers';
  return [
    ...(context ? [context, '', '## Request'] : []),
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

// ---------------------------------------------------------------- duplicate checks (G2)
// Against our own questions only. Copying from books is checked on Sambit's Mac
// (shared/originality.ts via scripts/check-originality.ts): book text is never in the cloud.
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

export interface Candidate { id: string; kind: 'question'; text: string }
export interface Hit { id: string; kind: Candidate['kind']; similarity: number; sameNumbers: boolean }

/** Flag a draft whose numbers match a candidate's, or whose wording is ≥ threshold similar. */
export function checkAgainst(text: string, candidates: Candidate[], threshold: number): Hit[] {
  const nums = numberSet(text);
  return candidates.map((c) => ({ id: c.id, kind: c.kind, similarity: Math.round(similarity(text, c.text) * 100) / 100, sameNumbers: sameNumbers(nums, numberSet(c.text)) }))
    .filter((h) => h.sameNumbers || h.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity);
}

// ---------------------------------------------------------------- cost
/** USD per million tokens; batch runs cost half. `long` = the rates once a request's prompt passes `above` tokens (Haiku 5.5: 5× above 100K). */
export interface Rates { input: number; output: number; cache_write: number; cache_read: number }
export interface Price extends Rates { long?: Rates & { above: number } }
export interface Usage { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }
/** The long-context price threshold every request must stay under (prompt tokens, cache reads and writes included). */
export const PROMPT_TOKEN_LIMIT = 100_000;
export const promptTokens = (u: Usage) => u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
export function costUsd(u: Usage, p: Price, batch = false): number {
  const r: Rates = p.long && promptTokens(u) > p.long.above ? p.long : p;
  const usd = (u.input_tokens * r.input + u.output_tokens * r.output + (u.cache_creation_input_tokens ?? 0) * r.cache_write + (u.cache_read_input_tokens ?? 0) * r.cache_read) / 1e6;
  return Math.round(usd * (batch ? 0.5 : 1) * 1e6) / 1e6;
}

/** One model attempt within a request. A refusal fallback adds attempts: "server_fallback"
 *  (the API re-ran the request on another model) or "client_fallback" (the AI function retried
 *  on ai_fallback_model, for models with no server-side fallback such as Haiku 5.5). */
export interface Attempt { model: string; via: 'requested' | 'server_fallback' | 'client_fallback'; usage: Usage; stop_reason: string | null }
export const attemptCost = (a: Attempt, priceOf: (model: string) => Price, batch = false) => costUsd(a.usage, priceOf(a.model), batch);
export function attemptsCost(attempts: Attempt[], priceOf: (model: string) => Price, batch = false): number {
  return Math.round(attempts.reduce((n, a) => n + attemptCost(a, priceOf, batch), 0) * 1e6) / 1e6;
}
export const sumUsage = (attempts: Attempt[]): Usage => attempts.reduce<Usage>((t, a) => ({
  input_tokens: t.input_tokens + a.usage.input_tokens, output_tokens: t.output_tokens + a.usage.output_tokens,
  cache_creation_input_tokens: (t.cache_creation_input_tokens ?? 0) + (a.usage.cache_creation_input_tokens ?? 0),
  cache_read_input_tokens: (t.cache_read_input_tokens ?? 0) + (a.usage.cache_read_input_tokens ?? 0) }), { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
/** What a fallback did, for the run log: null when the requested model answered. */
export function fallbackOf(attempts: Attempt[]): { kind: 'server' | 'client'; from: string; to: string; answered: boolean } | null {
  const fb = attempts.find((a) => a.via !== 'requested');
  if (!fb) return null;
  const last = attempts[attempts.length - 1]!;
  return { kind: fb.via === 'server_fallback' ? 'server' : 'client', from: attempts[0]!.model, to: last.model, answered: last.stop_reason !== 'refusal' };
}

// ---------------------------------------------------------------- tagging (model check)
const sigSchema = (DRAFT_SCHEMA.properties.drafts.items.properties.signature);
/** Tags for one question (structured output). Wrong answers are returned in the order given, value unchanged. */
export const TAG_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['concepts', 'signature', 'duration_s', 'wrong_answers', 'tagging_why'],
  properties: {
    concepts: { type: 'array', items: conceptRef }, signature: sigSchema,
    duration_s: { type: 'integer', enum: [30, 60, 90, 120] },
    wrong_answers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['value', 'tag', 'misconception_id'],
      properties: { value: str, tag: wrong.properties.tag, misconception_id: str } } },
    tagging_why: { type: 'array', items: why },
  },
} as const;
export interface RawTags {
  concepts: { concept_id: string; involvement: number }[]; signature: RawDraft['signature']; duration_s: number;
  wrong_answers: { value: string; tag: string; misconception_id: string }[]; tagging_why: RawDraft['tagging_why'];
}

const wrongValues = (q: Question) => [...(q.answer.wrong_answers ?? []).map((w) => ({ part: '', w })),
  ...(q.parts ?? []).flatMap((p) => (p.answer.wrong_answers ?? []).map((w) => ({ part: p.part_label, w })))];

/** The question with every tagged value hidden: no concepts, signature, duration, wrong-answer tags, solutions, hints or tagging notes. */
export function hideValues(q: Question) {
  const ans = (a: Question['answer']) => ({ format: a.format, ...(a.options ? { options: a.options } : {}), correct: a.correct, accepted: a.accepted ?? [] });
  return { text: q.text, ...(q.figure ? { figure: q.figure.description } : {}), answer: ans(q.answer),
    ...(q.parts?.length ? { parts: q.parts.map((p) => ({ part_label: p.part_label, text: p.text, answer: ans(p.answer) })) } : {}),
    wrong_answers: wrongValues(q).map((x) => ({ ...(x.part ? { part: x.part } : {}), value: x.w.value })) };
}

export function buildTagPrompt(q: Question, classLevel: number, topicName: string, context: string): string {
  return [context, '', '## Request',
    `Tag this Class ${classLevel} question (topic "${topicName}") with every attribute. Use only the concept IDs on the concept cards above.`,
    `Question: ${stableJson(hideValues(q))}`,
    'Return JSON matching the schema.'].join('\n');
}

export interface AttrScore { attribute: string; gold: string; got: string; hits: number; n: number; near: boolean; note?: string }
const ORD = { Simple: 0, Medium: 1, Complex: 2 } as Record<string, number>;
const DUR = [30, 60, 90, 120];
/** Compare a model's tags with a gold question's values, attribute by attribute. `near` = off by one level. */
export function compareTags(gold: Question, got: RawTags, offered: string[]): AttrScore[] {
  const g = gold.signature, t = got.signature;
  const one = (attribute: string, a: unknown, b: unknown, near = false, note?: string): AttrScore =>
    ({ attribute, gold: String(a ?? ''), got: String(b ?? ''), hits: String(a ?? '') === String(b ?? '') ? 1 : 0, n: 1, near: String(a ?? '') !== String(b ?? '') && near, ...(note ? { note } : {}) });
  const num = (attribute: string, a: number, b: number) => one(attribute, a, b, Math.abs(a - b) === 1);
  const goldConcepts = [...new Set([...gold.concepts, ...(gold.parts ?? []).flatMap((p) => p.concepts)].map((c) => c.concept_id))].sort();
  const gotConcepts = [...new Set(got.concepts.map((c) => c.concept_id))].sort();
  const primary = (cs: { concept_id: string; involvement: number }[]) => [...new Set(cs.filter((c) => c.involvement === 1).map((c) => c.concept_id))].sort().join(', ');
  const missingFromCards = goldConcepts.filter((c) => !offered.includes(c));
  const wa = wrongValues(gold);
  const waHits = wa.filter((x, i) => got.wrong_answers[i]?.tag === x.w.tag).length;
  return [
    one('Math difficulty', g.math_difficulty, t.math_difficulty, Math.abs((ORD[g.math_difficulty] ?? 0) - (ORD[t.math_difficulty] ?? 9)) === 1),
    one('IsPureFact', g.is_pure_fact, t.is_pure_fact),
    num('Reading', g.reading, t.reading),
    one('Has_Irrelevant_Info', g.has_irrelevant_info, t.has_irrelevant_info),
    num('Steps', g.steps, t.steps),
    num('WorkingMemory', g.working_memory, t.working_memory),
    num('Inhibition', g.inhibition, t.inhibition),
    num('Visual', g.visual, t.visual),
    num('Strategy', g.strategy, t.strategy),
    one('Strategy_type', g.strategy_type ?? '', t.strategy_type ?? ''),
    one('Insight_ID', g.insight_id ?? '', t.insight_id ?? ''),
    one('Expected duration', gold.duration_s, got.duration_s, Math.abs(DUR.indexOf(gold.duration_s) - DUR.indexOf(got.duration_s)) === 1),
    one('Concepts', goldConcepts.join(', '), gotConcepts.join(', '), false, missingFromCards.length ? `not on the topic's cards: ${missingFromCards.join(', ')}` : undefined),
    one('Primary concept', primary([...gold.concepts, ...(gold.parts ?? []).flatMap((p) => p.concepts)]), primary(got.concepts)),
    { attribute: 'Wrong-answer tags', gold: wa.map((x) => x.w.tag).join(', '), got: got.wrong_answers.map((w) => w.tag).join(', '), hits: waHits, n: wa.length, near: false },
  ].filter((x) => x.n > 0);
}

export interface Agreement { attribute: string; hits: number; n: number; near: number; pct: number }
/** Agreement per attribute over all questions (wrong-answer tags pooled over every wrong answer). */
export function agreement(perQuestion: AttrScore[][]): Agreement[] {
  const m = new Map<string, Agreement>();
  for (const rows of perQuestion) for (const r of rows) {
    const a = m.get(r.attribute) ?? { attribute: r.attribute, hits: 0, n: 0, near: 0, pct: 0 };
    a.hits += r.hits; a.n += r.n; a.near += r.near ? 1 : 0; m.set(r.attribute, a);
  }
  return [...m.values()].map((a) => ({ ...a, pct: a.n ? Math.round((a.hits / a.n) * 1000) / 10 : 0 }));
}

/** A model check's agreement counted only over questions that are test-only gold now: a question that
 *  later became a prompt example (e.g. 13 in v11) is shown to the model as an example, so it no longer
 *  measures it and is left out of every run's score, earlier runs included (Sambit, 10 Nov 2026). */
export function scoreModelCheck<T extends { qid: string; scores: AttrScore[]; error?: string }>(results: T[], testOnly: Set<string>) {
  const kept = results.filter((r) => testOnly.has(r.qid));
  const excluded = results.filter((r) => !testOnly.has(r.qid)).map((r) => r.qid);
  return { agreement: agreement(kept.map((r) => r.scores)), kept, excluded };
}

// Phase 6: the AI Pages Function (behind Access) and the shared generation logic. No live API calls.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleAi, messageParams, type AiEnv } from '../functions/_lib/ai.ts';
import { fakeAiClient } from '../scripts/lib/fake-ai.ts';
import { checkFile, type Catalog } from '../shared/checks.ts';
import { buildPack, buildPrompt, checkAgainst, costUsd, difficultiesFor, DRAFT_SCHEMA, similarity, toQuestion } from '../shared/generation.ts';
import type { ChapterFile, Question } from '../shared/types.ts';

const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
const NOW = Date.UTC(2026, 10, 9, 12);
let pair: CryptoKeyPair; let env: AiEnv;
async function jwt() {
  const h = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid: 'k1' })));
  const p = b64url(new TextEncoder().encode(JSON.stringify({ aud: ['aud'], iss: 'https://t.cloudflareaccess.com', email: 's@x.com', exp: NOW / 1000 + 600 })));
  return `${h}.${p}.${b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${p}`)))}`;
}
const post = async (path: string, body: unknown, auth = true) => new Request(`https://cms.example/api/ai/${path}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(auth ? { 'cf-access-jwt-assertion': await jwt() } : {}) } });
const get = async (path: string, auth = true) => new Request(`https://cms.example/api/ai/${path}`, { headers: auth ? { 'cf-access-jwt-assertion': await jwt() } : {} });

const example: Question = (JSON.parse(readFileSync('content/examples/MC19-example.json', 'utf8')) as ChapterFile).questions[0]!;
const settings = { count: 3, difficulties: difficultiesFor(3, ['Simple', 'Complex'], null), vary: { numbers: true, story: false, format: false }, classLevel: 6,
  topicName: 'Add and subtract unlike fractions', setName: 'Add and subtract unlike fractions', patternName: null,
  concepts: [{ concept_id: 'G6-FRC-C1', name: 'Unlike fractions' }], misconceptions: [{ misconception_id: 'G6-M-FRC1', description: 'adds tops and bottoms' }] };

beforeAll(async () => {
  pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  env = { ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com', ACCESS_AUD: 'aud', ACCESS_ALLOWED_EMAILS: 's@x.com',
    ACCESS_JWKS_JSON: JSON.stringify({ keys: [{ ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' }] }) };
});

describe('AI function (behind Access)', () => {
  it('a request without Access is refused, and nothing reaches the model', async () => {
    const ai = fakeAiClient();
    expect((await handleAi(await post('generate', { model: 'claude-sonnet-5-5', system: 's', prompt: 'p', count: 1 }, false), env, ai, NOW)).status).toBe(403);
    expect((await handleAi(await get('batch?id=msgbatch_x', false), env, ai, NOW)).status).toBe(403);
    expect(ai.calls).toHaveLength(0);
  });

  it('generate: cached system prompt, structured output with the fixed schema, refusal fallback; returns drafts and usage', async () => {
    const ai = fakeAiClient();
    const r = await handleAi(await post('generate', { model: 'claude-sonnet-5-5', system: 'PACK', prompt: buildPrompt(example, settings), count: 3 }), env, ai, NOW);
    expect(r.status).toBe(200);
    const body = await r.json() as { drafts: unknown[]; usage: { input_tokens: number }; model: string };
    expect(body.drafts).toHaveLength(3);
    const call = ai.calls[0] as Record<string, any>;
    expect(call.system).toEqual([{ type: 'text', text: 'PACK', cache_control: { type: 'ephemeral' } }]);
    expect(call.output_config.format).toEqual({ type: 'json_schema', schema: DRAFT_SCHEMA });
    expect([call.fallbacks, call.betas]).toEqual(['default', ['server-side-fallback-2026-07-01']]);
  });

  it('caps: model id, effort, count ≤ AI_MAX_DRAFTS, prompt sizes, batch totals', async () => {
    const ai = fakeAiClient();
    const run = async (path: string, body: unknown) => (await handleAi(await post(path, body), { ...env, AI_MAX_DRAFTS: '20' }, ai, NOW)).status;
    expect(await run('generate', { model: 'gpt-4', system: 's', prompt: 'p', count: 1 })).toBe(400);
    expect(await run('generate', { model: 'claude-sonnet-5-5', effort: 'turbo', system: 's', prompt: 'p', count: 1 })).toBe(400);
    expect(await run('generate', { model: 'claude-sonnet-5-5', system: 's', prompt: 'p', count: 21 })).toBe(400);
    expect(await run('generate', { model: 'claude-sonnet-5-5', system: 's', prompt: 'x'.repeat(40_001), count: 1 })).toBe(400);
    expect(await run('batch', { model: 'claude-sonnet-5-5', system: 's', requests: [{ custom_id: 'a', prompt: 'p', count: 15 }, { custom_id: 'b', prompt: 'p', count: 6 }] })).toBe(400);
    expect(await run('batch', { model: 'claude-sonnet-5-5', system: 's', requests: [{ custom_id: 'bad id!', prompt: 'p', count: 1 }] })).toBe(400);
    expect(ai.calls).toHaveLength(0);
  });

  it('batch: create (no fallbacks param, which batches reject), status, results keyed by custom_id', async () => {
    const ai = fakeAiClient();
    const c = await (await handleAi(await post('batch', { model: 'claude-sonnet-5-5', system: 'PACK', requests: [
      { custom_id: 'Simple-1', prompt: buildPrompt(example, { ...settings, count: 2, difficulties: ['Simple', 'Simple'] }), count: 2 },
      { custom_id: 'Complex-1', prompt: buildPrompt(example, { ...settings, count: 1, difficulties: ['Complex'] }), count: 1 }] }), env, ai, NOW)).json() as { id: string };
    expect((ai.calls[0] as Record<string, unknown>).fallbacks).toBeUndefined();
    const st = await (await handleAi(await get(`batch?id=${c.id}`), env, ai, NOW)).json() as { processing_status: string };
    expect(st.processing_status).toBe('ended');
    const res = await (await handleAi(await get(`batch/results?id=${c.id}`), env, ai, NOW)).json() as { results: { custom_id: string; drafts: unknown[] }[] };
    expect(res.results.map((x) => [x.custom_id, x.drafts.length])).toEqual([['Simple-1', 2], ['Complex-1', 1]]);
  });

  it('no API key: refuses clearly', async () => {
    expect((await handleAi(await post('generate', { model: 'claude-sonnet-5-5', system: 's', prompt: 'p', count: 1 }), env, null, NOW)).status).toBe(500);
  });

  it('messageParams never leaks anything but the schema, system and prompt', () => {
    expect(Object.keys(messageParams('claude-sonnet-5-5', 's', 'p', 'high')).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system']);
  });
});

describe('shared generation logic', () => {
  it('the tagging pack never contains test-only gold, and its version is stable', () => {
    const base = { ruleVersion: 'v10', attributes: [{ attribute: 'Reading', meaning: 'load from reading', values: '1-5' }], rubric: [], calibration: [], strategyTypes: ['Pattern'] };
    const p = buildPack({ ...base, examples: [{ qid: 'G6-001', use: 'prompt_example', question: example }, { qid: 'G6-099', use: 'test_only', question: { ...example, text: 'SECRET TEST ITEM' } }] });
    expect(p.text).toContain('G6-001');
    expect(p.text).not.toContain('SECRET TEST ITEM');
    expect(p.excludedTestOnly).toBe(1);
    expect(buildPack({ ...base, examples: [{ qid: 'G6-001', use: 'prompt_example', question: example }] }).version).toBe(p.version);
  });

  it('fill requests put missing levels first', () => {
    expect(difficultiesFor(4, ['Simple', 'Complex'], 'Medium')).toEqual(['Simple', 'Complex', 'Simple', 'Complex']);
    expect(difficultiesFor(2, [], 'Medium')).toEqual(['Medium', 'Medium']);
  });

  it('fake drafts become valid chapter-file questions that pass the §8 checks', async () => {
    const r = await handleAi(await post('generate', { model: 'claude-sonnet-5-5', system: 'PACK', prompt: buildPrompt(example, settings), count: 3 }), env, fakeAiClient(), NOW);
    const { drafts } = await r.json() as { drafts: never[] };
    const qs = drafts.map((d, i) => toQuestion(d, { key: `MC19-500${i + 1}`, topic_id: 'MT0393', typical_set_id: 'TS-G6-FRAC-ADD-UNLIKE', pattern_id: null, clone_batch_id: 'gen-1' }));
    expect(qs.map((q) => q.signature.math_difficulty)).toEqual(['Simple', 'Complex', 'Simple']);
    const cat: Catalog = { ruleVersions: new Set(['v10']), chapter: { chapter_id: 'MC19', subject: 'math' },
      topics: new Map([['MT0393', { chapter_id: 'MC19', class: 6, topic_kind: 'normal', taught_in_school: true, status: 'active' }]]),
      typicalSets: new Map([['TS-G6-FRAC-ADD-UNLIKE', { class: 6, status: 'draft' }]]), patterns: new Set(), concepts: new Map([['G6-FRC-C1', { class: 6 }]]),
      misconceptions: new Set(['G6-M-FRC1']), insights: new Map(), stems: new Map(), keyToQuestionId: new Map(), sourceItems: new Set() };
    const file: ChapterFile = { file_schema: 'cms-chapter/1.0', attribute_version: 'v10', subject: 'math', class: 6, chapter_id: 'MC19', generated: { by: 't', date: '2026-11-09' }, questions: qs };
    expect(checkFile(file, cat).filter((p) => p.level === 'error')).toEqual([]);
    expect(qs[0]!.tagging!.tagged_by).toBe('ai');
  });

  it('duplicates and copies: same numbers, or wording ≥ threshold', () => {
    expect(similarity('5/6 − 1/4 = ?', '5/6 − 1/4 = ?')).toBe(1);
    expect(similarity('Riya ate 2/5 of a pizza', 'What is the capital of France')).toBeLessThan(0.3);
    const cands = [
      { id: 'MQ000010', kind: 'question' as const, text: '5/6 − 1/4 = ?' },
      { id: 'N6-01-004', kind: 'source_item' as const, text: 'Find 5/6 minus 1/4 using equivalent fractions.' },
      { id: 'MQ000011', kind: 'question' as const, text: 'Riya has 3 apples and eats 1.' },
    ];
    // a new variant (new numbers, short formula) is what generation is for: not flagged
    expect(checkAgainst('6/7 − 2/5 = ?', cands, 0.6)).toEqual([]);
    // a reworded near-duplicate story is flagged even with other numbers
    const story = [{ id: 'G6-004', kind: 'question' as const, text: 'Riya ate 2/5 of a pizza and her brother ate 1/3 of the same pizza. What fraction of the pizza is left?' }];
    const near = checkAgainst('Riya ate 3/7 of a pizza and her brother ate 1/4 of the same pizza. What fraction of the pizza is left?', story, 0.6);
    expect(near.map((h) => [h.id, h.sameNumbers])).toEqual([['G6-004', false]]);
    expect(near[0]!.similarity).toBeGreaterThanOrEqual(0.6);
    const copy = checkAgainst('Work out 5/6 − 1/4.', cands, 0.6);
    expect(copy.some((h) => h.id === 'N6-01-004' && h.sameNumbers)).toBe(true); // same numbers as a book item
    expect(checkAgainst('Riya has 3 apples and eats 1.', cands, 0.99).map((h) => h.id)).toEqual(['MQ000011']);
  });

  it('cost: per million tokens, cache write and read, half price for batches', () => {
    const price = { input: 2, output: 10, cache_write: 2.5, cache_read: 0.2 };
    const u = { input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: 10000, cache_read_input_tokens: 50000 };
    expect(costUsd(u, price)).toBe(0.057); // 0.002 + 0.02 + 0.025 + 0.01
    expect(costUsd(u, price, true)).toBe(0.0285);
  });
});

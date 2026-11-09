// The CMS AI service (Phase 6, G1; updated 9 Nov 2026): Claude calls behind Cloudflare Access.
//   POST /api/ai/generate   { model, effort?, fallback_model?, system, prompt, count }  → { drafts, usage, model, attempts, fallback, prompt_tokens }
//   POST /api/ai/tag        { model, effort?, fallback_model?, system, prompt }         → { tags, usage, model, attempts, fallback, prompt_tokens }
//   POST /api/ai/batch      { model, effort?, system, requests: [{ custom_id, prompt, count }] } → { id, processing_status }
//   GET  /api/ai/batch?id=…                                                            → { processing_status, request_counts }
//   GET  /api/ai/batch/results?id=…                                                    → { results: [{ custom_id, type, drafts?, attempts?, error? }] }
// Holds only the Claude API key. The output schemas are fixed here (DRAFT_SCHEMA, TAG_SCHEMA),
// so the function can't be used as a general-purpose proxy; drafts, requests and tokens are capped.
//
// Every request is counted first (count_tokens, free) and refused above PROMPT_GUARD tokens, so it
// stays under the 100K long-context price threshold. The `system` text is the fixed rules block and
// is cached; the per-topic context travels in the prompt.
//
// Refusal fallback: models with a server-side fallback get `fallbacks: "default"`; Haiku models have
// none (the API says not to send it), so on a refusal the function retries once on `fallback_model`.
// Every attempt is returned with its model and usage, so the browser logs who answered and the cost.
import { DRAFT_SCHEMA, PROMPT_TOKEN_LIMIT, TAG_SCHEMA, fallbackOf, sumUsage, type Attempt, type RawDraft, type RawTags, type Usage } from '../../shared/generation.ts';
import { AccessError, verifyAccess, type AccessEnv } from './access.ts';

export interface AiEnv extends AccessEnv { ANTHROPIC_API_KEY?: string; AI_MAX_DRAFTS?: string }

type Block = { type: string; text?: string; from?: { model: string }; to?: { model: string } };
type Iteration = Usage & { type: string; model?: string | null };
export interface AiMessage { content: Block[]; usage: Usage & { iterations?: Iteration[] | null }; model: string; stop_reason: string | null }

/** The few SDK calls this service makes; production wraps @anthropic-ai/sdk, dev and tests use a fake. */
export interface AiClient {
  create(params: Record<string, unknown>): Promise<AiMessage>;
  countTokens(params: Record<string, unknown>): Promise<{ input_tokens: number }>;
  batchCreate(requests: { custom_id: string; params: Record<string, unknown> }[]): Promise<{ id: string; processing_status: string }>;
  batchRetrieve(id: string): Promise<{ id: string; processing_status: string; request_counts: Record<string, number> }>;
  batchResults(id: string): AsyncIterable<{ custom_id: string; result: { type: string; message?: AiMessage; error?: unknown } }>;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
});
const MODEL_RE = /^claude-[a-z0-9-]+$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_TOKENS = 32000;
const MAX_SYSTEM = 200_000, MAX_PROMPT = 200_000; // characters; the token guard below is the real limit
/** Refuse a request whose prompt counts above this (5% margin under the 100K price threshold). */
export const PROMPT_GUARD = Math.floor(PROMPT_TOKEN_LIMIT * 0.95);
const SCHEMAS = { generate: DRAFT_SCHEMA, tag: TAG_SCHEMA } as const;
type Task = keyof typeof SCHEMAS;

/** Haiku 5.5 has no server-side refusal fallback; the others in use here (Sonnet / Opus 5.x) do. */
export const hasServerFallback = (model: string) => !/^claude-haiku/.test(model);

/** Messages API params for one request: cached fixed-rules system block + structured JSON output. */
export function messageParams(model: string, system: string, prompt: string, effort: string | undefined, task: Task = 'generate') {
  return {
    model, max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: { type: 'json_schema', schema: SCHEMAS[task] }, ...(effort ? { effort } : {}) },
  };
}
const withServerFallback = (params: Record<string, unknown>) =>
  hasServerFallback(String(params.model)) ? { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : params;

function parseJson<T>(content: Block[]): T {
  return JSON.parse(content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')) as T;
}
const plainUsage = (u: Usage): Usage => ({ input_tokens: u.input_tokens, output_tokens: u.output_tokens,
  cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0 });

/** One response → its attempts. `usage.iterations` is the per-attempt source of truth when present. */
export function attemptsOf(msg: AiMessage, requested: string, via: Attempt['via']): Attempt[] {
  const its = msg.usage.iterations ?? [];
  if (!its.length) return [{ model: msg.model || requested, via, usage: plainUsage(msg.usage), stop_reason: msg.stop_reason }];
  return its.map((it, i) => ({
    model: it.model ?? (i === 0 ? requested : msg.model), via: it.type === 'fallback_message' ? 'server_fallback' : via,
    usage: plainUsage(it), stop_reason: i === its.length - 1 ? msg.stop_reason : 'refusal',
  }));
}

/** Count the request's prompt tokens (free endpoint). If counting fails, estimate from characters (~2.5 per token, on the high side). */
async function countPrompt(client: AiClient, params: Record<string, unknown>, chars: number): Promise<{ tokens: number; estimated: boolean }> {
  const { max_tokens: _m, ...rest } = params;
  try { return { tokens: (await client.countTokens(rest)).input_tokens, estimated: false }; }
  catch { return { tokens: Math.ceil(chars / 2.5), estimated: true }; }
}

/** One request with the refusal fallback; returns the final message and every attempt. */
async function runWithFallback(client: AiClient, task: Task, b: { model: string; fallback_model?: string; effort?: string; system: string; prompt: string }) {
  const first = await client.create(withServerFallback(messageParams(b.model, b.system, b.prompt, b.effort, task)));
  const attempts = attemptsOf(first, b.model, 'requested');
  let final = first;
  if (first.stop_reason === 'refusal' && !hasServerFallback(b.model) && b.fallback_model && b.fallback_model !== b.model) {
    final = await client.create(withServerFallback(messageParams(b.fallback_model, b.system, b.prompt, b.effort, task)));
    attempts.push(...attemptsOf(final, b.fallback_model, 'client_fallback'));
  }
  return { final, attempts };
}

export async function handleAi(req: Request, env: AiEnv, client: AiClient | null, now = Date.now()): Promise<Response> {
  try { await verifyAccess(req, env, now); } catch (e) {
    return json(403, { error: `Access required: ${e instanceof AccessError ? e.message : 'invalid token'}` });
  }
  if (!client) return json(500, { error: 'AI is not configured (no API key)' });
  const url = new URL(req.url);
  const action = url.pathname.replace(/^\/api\/ai\/?/, '');
  const maxDrafts = Math.max(1, Math.min(50, Number(env.AI_MAX_DRAFTS ?? 20) || 20));

  if (req.method === 'POST' && (action === 'generate' || action === 'tag' || action === 'batch')) {
    let body: { model?: string; fallback_model?: string; effort?: string; system?: string; prompt?: string; count?: number; requests?: { custom_id: string; prompt: string; count: number }[] };
    try { body = await req.json(); } catch { return json(400, { error: 'body must be JSON' }); }
    const { model, effort, system, fallback_model } = body;
    if (!model || !MODEL_RE.test(model)) return json(400, { error: 'model must be a Claude model id' });
    if (fallback_model !== undefined && fallback_model !== '' && !MODEL_RE.test(fallback_model)) return json(400, { error: 'fallback_model must be a Claude model id' });
    if (effort !== undefined && !EFFORTS.includes(effort)) return json(400, { error: 'bad effort' });
    if (!system || system.length > MAX_SYSTEM) return json(400, { error: 'system prompt missing or too long' });

    if (action === 'generate' || action === 'tag') {
      const count = action === 'generate' ? Number(body.count) : 1;
      if (!Number.isInteger(count) || count < 1 || count > maxDrafts) return json(400, { error: `count must be 1–${maxDrafts}` });
      if (!body.prompt || body.prompt.length > MAX_PROMPT) return json(400, { error: 'prompt missing or too long' });
      const counted = await countPrompt(client, messageParams(model, system, body.prompt, effort, action), system.length + body.prompt.length);
      if (counted.tokens > PROMPT_GUARD) return json(413, { error: `the request is ${counted.tokens} tokens; the limit is ${PROMPT_GUARD} (under the 100K price threshold)`, prompt_tokens: counted.tokens });
      const { final, attempts } = await runWithFallback(client, action, { model, fallback_model: fallback_model || undefined, effort, system, prompt: body.prompt });
      const meta = { usage: sumUsage(attempts), model: final.model, attempts, fallback: fallbackOf(attempts), prompt_tokens: counted.tokens, prompt_tokens_estimated: counted.estimated };
      if (final.stop_reason === 'refusal') return json(422, { error: 'the model declined this request', ...meta });
      if (final.stop_reason === 'max_tokens') return json(422, { error: action === 'generate' ? 'the answer was cut off; ask for fewer drafts' : 'the answer was cut off', ...meta });
      try {
        if (action === 'tag') return json(200, { tags: parseJson<RawTags>(final.content), ...meta, stop_reason: final.stop_reason });
        const drafts = parseJson<{ drafts: RawDraft[] }>(final.content).drafts ?? [];
        return json(200, { drafts: drafts.slice(0, count), ...meta, stop_reason: final.stop_reason });
      } catch { return json(502, { error: 'the model returned invalid JSON', ...meta }); }
    }

    // batches: half price, no server-side fallback (the Batches API rejects it); refusals come back as "refused"
    const reqs = body.requests ?? [];
    if (!Array.isArray(reqs) || reqs.length < 1) return json(400, { error: 'requests missing' });
    const total = reqs.reduce((n, r) => n + Number(r.count), 0);
    if (reqs.some((r) => !/^[A-Za-z0-9_-]{1,64}$/.test(r.custom_id) || !r.prompt || r.prompt.length > MAX_PROMPT || !Number.isInteger(r.count) || r.count < 1) || total > maxDrafts) {
      return json(400, { error: `bad batch: valid custom_ids and prompts, at most ${maxDrafts} drafts in total` });
    }
    const params = reqs.map((r) => ({ custom_id: r.custom_id, params: messageParams(model, system, r.prompt, effort) }));
    for (const [i, p] of params.entries()) {
      const counted = await countPrompt(client, p.params, system.length + reqs[i]!.prompt.length);
      if (counted.tokens > PROMPT_GUARD) return json(413, { error: `batch request ${p.custom_id} is ${counted.tokens} tokens; the limit is ${PROMPT_GUARD}` });
    }
    const batch = await client.batchCreate(params);
    return json(200, { id: batch.id, processing_status: batch.processing_status });
  }

  if (req.method === 'GET' && (action === 'batch' || action === 'batch/results')) {
    const id = url.searchParams.get('id') ?? '';
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(id)) return json(400, { error: 'bad batch id' });
    if (action === 'batch') {
      const b = await client.batchRetrieve(id);
      return json(200, { id: b.id, processing_status: b.processing_status, request_counts: b.request_counts });
    }
    const results = [];
    for await (const r of client.batchResults(id)) {
      const m = r.result.message;
      if (r.result.type === 'succeeded' && m) {
        const attempts = attemptsOf(m, m.model, 'requested');
        const base = { custom_id: r.custom_id, usage: sumUsage(attempts), model: m.model, attempts };
        if (m.stop_reason === 'refusal') { results.push({ ...base, type: 'refused' }); continue; }
        try { results.push({ ...base, type: 'succeeded', drafts: parseJson<{ drafts: RawDraft[] }>(m.content).drafts ?? [] }); }
        catch { results.push({ ...base, type: 'invalid_json' }); }
      } else results.push({ custom_id: r.custom_id, type: r.result.type, error: r.result.error ?? null });
    }
    return json(200, { results });
  }
  return json(405, { error: 'method not allowed' });
}

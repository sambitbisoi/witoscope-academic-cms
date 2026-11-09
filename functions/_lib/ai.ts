// The CMS AI service (Phase 6, G1): Claude calls behind Cloudflare Access.
//   POST /api/ai/generate          { model, effort?, system, prompt, count }       → { drafts, usage, model, stop_reason }
//   POST /api/ai/batch             { model, effort?, system, requests: [{ custom_id, prompt, count }] } → { id, processing_status }
//   GET  /api/ai/batch?id=…                                                        → { processing_status, request_counts }
//   GET  /api/ai/batch/results?id=…                                                → { results: [{ custom_id, type, drafts?, usage?, model?, error? }] }
// Holds only the Claude API key. The output schema is fixed here (DRAFT_SCHEMA), so the
// function can't be used as a general-purpose proxy; drafts, requests and tokens are capped.
import { DRAFT_SCHEMA, type RawDraft, type Usage } from '../../shared/generation.ts';
import { AccessError, verifyAccess, type AccessEnv } from './access.ts';

export interface AiEnv extends AccessEnv { ANTHROPIC_API_KEY?: string; AI_MAX_DRAFTS?: string }

/** The few SDK calls this service makes; production wraps @anthropic-ai/sdk, dev and tests use a fake. */
export interface AiClient {
  create(params: Record<string, unknown>): Promise<{ content: { type: string; text?: string }[]; usage: Usage; model: string; stop_reason: string | null }>;
  batchCreate(requests: { custom_id: string; params: Record<string, unknown> }[]): Promise<{ id: string; processing_status: string }>;
  batchRetrieve(id: string): Promise<{ id: string; processing_status: string; request_counts: Record<string, number> }>;
  batchResults(id: string): AsyncIterable<{ custom_id: string; result: { type: string; message?: { content: { type: string; text?: string }[]; usage: Usage; model: string }; error?: unknown } }>;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
});
const MODEL_RE = /^claude-[a-z0-9-]+$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_TOKENS = 32000;
const MAX_SYSTEM = 400_000, MAX_PROMPT = 40_000;

/** Messages API params for one request: cached system prompt + structured JSON output. */
export function messageParams(model: string, system: string, prompt: string, effort: string | undefined) {
  return {
    model, max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: { type: 'json_schema', schema: DRAFT_SCHEMA }, ...(effort ? { effort } : {}) },
  };
}

function parseDrafts(content: { type: string; text?: string }[]): RawDraft[] {
  const text = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  return (JSON.parse(text) as { drafts: RawDraft[] }).drafts ?? [];
}

export async function handleAi(req: Request, env: AiEnv, client: AiClient | null, now = Date.now()): Promise<Response> {
  try { await verifyAccess(req, env, now); } catch (e) {
    return json(403, { error: `Access required: ${e instanceof AccessError ? e.message : 'invalid token'}` });
  }
  if (!client) return json(500, { error: 'AI is not configured (no API key)' });
  const url = new URL(req.url);
  const action = url.pathname.replace(/^\/api\/ai\/?/, '');
  const maxDrafts = Math.max(1, Math.min(50, Number(env.AI_MAX_DRAFTS ?? 20) || 20));

  if (req.method === 'POST' && (action === 'generate' || action === 'batch')) {
    let body: { model?: string; effort?: string; system?: string; prompt?: string; count?: number; requests?: { custom_id: string; prompt: string; count: number }[] };
    try { body = await req.json(); } catch { return json(400, { error: 'body must be JSON' }); }
    const { model, effort, system } = body;
    if (!model || !MODEL_RE.test(model)) return json(400, { error: 'model must be a Claude model id' });
    if (effort !== undefined && !EFFORTS.includes(effort)) return json(400, { error: 'bad effort' });
    if (!system || system.length > MAX_SYSTEM) return json(400, { error: 'system prompt missing or too long' });

    if (action === 'generate') {
      const count = Number(body.count);
      if (!Number.isInteger(count) || count < 1 || count > maxDrafts) return json(400, { error: `count must be 1–${maxDrafts}` });
      if (!body.prompt || body.prompt.length > MAX_PROMPT) return json(400, { error: 'prompt missing or too long' });
      // Server-side refusal fallback (Claude API guidance for this model family), direct calls only.
      const msg = await client.create({ ...messageParams(model, system, body.prompt, effort), betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
      if (msg.stop_reason === 'refusal') return json(422, { error: 'the model declined this request', usage: msg.usage, model: msg.model });
      if (msg.stop_reason === 'max_tokens') return json(422, { error: 'the answer was cut off; ask for fewer drafts', usage: msg.usage, model: msg.model });
      let drafts: RawDraft[];
      try { drafts = parseDrafts(msg.content); } catch { return json(502, { error: 'the model returned invalid JSON', usage: msg.usage, model: msg.model }); }
      return json(200, { drafts: drafts.slice(0, count), usage: msg.usage, model: msg.model, stop_reason: msg.stop_reason });
    }

    const reqs = body.requests ?? [];
    if (!Array.isArray(reqs) || reqs.length < 1) return json(400, { error: 'requests missing' });
    const total = reqs.reduce((n, r) => n + Number(r.count), 0);
    if (reqs.some((r) => !/^[A-Za-z0-9_-]{1,64}$/.test(r.custom_id) || !r.prompt || r.prompt.length > MAX_PROMPT || !Number.isInteger(r.count) || r.count < 1) || total > maxDrafts) {
      return json(400, { error: `bad batch: valid custom_ids and prompts, at most ${maxDrafts} drafts in total` });
    }
    const batch = await client.batchCreate(reqs.map((r) => ({ custom_id: r.custom_id, params: messageParams(model, system, r.prompt, effort) })));
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
      if (r.result.type === 'succeeded' && r.result.message) {
        try { results.push({ custom_id: r.custom_id, type: 'succeeded', drafts: parseDrafts(r.result.message.content), usage: r.result.message.usage, model: r.result.message.model }); }
        catch { results.push({ custom_id: r.custom_id, type: 'invalid_json', usage: r.result.message.usage, model: r.result.message.model }); }
      } else results.push({ custom_id: r.custom_id, type: r.result.type, error: r.result.error ?? null });
    }
    return json(200, { results });
  }
  return json(405, { error: 'method not allowed' });
}

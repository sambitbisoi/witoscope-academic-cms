// Cloudflare Pages Function: /api/ai/* → the CMS AI service (Phase 6, G1).
// Variables (Pages project settings; see docs/sambit-checklist.md):
//   ANTHROPIC_API_KEY      secret: the Claude API key (the ONLY credential here)
//   AI_MAX_DRAFTS          optional hard cap per run (default 20)
//   ACCESS_TEAM_DOMAIN / ACCESS_AUD / ACCESS_ALLOWED_EMAILS  (shared with /api/files)
import Anthropic from '@anthropic-ai/sdk';
import { handleAi, type AiClient, type AiEnv } from '../../_lib/ai.ts';

function sdkClient(apiKey: string): AiClient {
  const client = new Anthropic({ apiKey });
  return {
    create: async (params) => {
      const { betas, ...rest } = params as { betas?: string[] } & Record<string, unknown>;
      return (await client.beta.messages.create({ ...rest, ...(betas ? { betas } : {}) } as never)) as never;
    },
    countTokens: async (params) => (await client.messages.countTokens(params as never)) as never,
    batchCreate: async (requests) => (await client.messages.batches.create({ requests } as never)) as never,
    batchRetrieve: async (id) => (await client.messages.batches.retrieve(id)) as never,
    batchResults: async function* (id) { for await (const r of await client.messages.batches.results(id)) yield r as never; },
  };
}

export const onRequest = (ctx: { request: Request; env: AiEnv }) =>
  handleAi(ctx.request, ctx.env, ctx.env.ANTHROPIC_API_KEY ? sdkClient(ctx.env.ANTHROPIC_API_KEY) : null);

// Phase 6: generation in the browser. The /api/ai Pages Function (behind Access, API key
// only) returns drafts; everything else happens here: the tagging pack, the prompt, cost
// and the daily cap, the checks, and saving through cms_apply_save ("create").
import { checkFile, type Catalog } from '../../shared/checks.ts';
import { questionFromDb } from '../../shared/fromDb.ts';
import { buildPack, buildPrompt, checkAgainst, costUsd, toQuestion, type Candidate, type GenerateSettings, type Hit, type Price, type RawDraft, type Usage } from '../../shared/generation.ts';
import { rowsFor } from '../../shared/save.ts';
import type { DerivedConfig, Question } from '../../shared/types.ts';
import { structureHash } from '../../shared/version.ts';
import { questionDetail } from './api';
import { bundleOf, loadForEdit } from './editApi';
import { supabase } from './supabase';

const must = <T>(r: { data: T | null; error: { message: string } | null }): T => { if (r.error) throw new Error(r.error.message); return r.data as T; };
const rpc = async (fn: string, args: Record<string, unknown>) => { const { data, error } = await supabase.rpc(fn, args); if (error) throw new Error(error.message); return data; };

export interface AiConfig { model: string; effort: string; maxDrafts: number; dailyCapUsd: number; threshold: number; prices: Record<string, Price> }
export interface GenContext {
  mode: 'similar' | 'fill';
  subject: string; chapterId: string; classLevel: number; topicId: string; topicName: string;
  setId: string; setName: string; patternId: string | null; patternName: string | null;
  source: Question | null; sourceId: string | null;
  missing: ('Simple' | 'Medium' | 'Complex')[];
  concepts: { concept_id: string; name: string }[]; misconceptions: { misconception_id: string; description: string }[];
  config: AiConfig; derived: DerivedConfig; catalog: Catalog; conceptClass: (id: string) => number | undefined;
  candidates: Candidate[]; spentToday: number;
}
export interface DraftOutcome { index: number; question_id: string | null; text: string; difficulty: string; errors: string[]; warnings: string[]; hits: Hit[] }

/** Start of today, Asia/Kolkata, as an ISO timestamp (the daily cap's day) [guess: IST]. */
export function startOfTodayIst(now = new Date()): string {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60_000).toISOString();
}

export async function loadContext(args: { questionId?: string; setId?: string; topicId?: string }): Promise<GenContext> {
  let source: Question | null = null, sourceId: string | null = null;
  let topicId = args.topicId ?? '', setId = args.setId ?? '';
  if (args.questionId) {
    const d = await questionDetail(args.questionId, null);
    if (!d) throw new Error(`Question ${args.questionId} doesn't exist.`);
    source = questionFromDb(bundleOf(d)); sourceId = args.questionId; topicId = source.topic_id; setId = source.typical_set_id;
  }
  const [topic] = must<{ topic_id: string; name: string; class: number; chapter_id: string }[]>(await supabase.from('cms_topics').select('topic_id, name, class, chapter_id').eq('topic_id', topicId));
  if (!topic) throw new Error(`Topic ${topicId} doesn't exist.`);
  const [set] = must<{ typical_set_id: string; name: string }[]>(await supabase.from('cms_typical_sets').select('typical_set_id, name').eq('typical_set_id', setId));
  if (!set) throw new Error(`Typical set ${setId} doesn't exist.`);
  // a fill run with no source question uses one of the set's questions as the model, if any
  if (!source) {
    const [anyQ] = must<{ question_id: string }[]>(await supabase.from('cms_question_list').select('question_id').eq('typical_set_id', setId).is('retired_at', null).limit(1));
    if (anyQ) { const d = await questionDetail(anyQ.question_id, null); if (d) source = questionFromDb(bundleOf(d)); }
  }
  const edit = await loadForEdit(sourceId ?? (await anyQuestionInChapter(topic.chapter_id)));
  const cfgRows = must<{ key: string; value: unknown }[]>(await supabase.from('cms_config').select('key, value').like('key', 'ai_%'));
  const thr = must<{ value: number }[]>(await supabase.from('cms_config').select('value').eq('key', 'similarity_threshold'));
  const c = Object.fromEntries(cfgRows.map((r) => [r.key, r.value])) as Record<string, unknown>;
  const config: AiConfig = { model: String(c.ai_model ?? 'claude-sonnet-5-5'), effort: String(c.ai_effort ?? 'high'), maxDrafts: Number(c.ai_max_drafts_per_run ?? 20),
    dailyCapUsd: Number(c.ai_daily_cap_usd ?? 5), threshold: Number(thr[0]?.value ?? 0.6), prices: (c.ai_prices ?? {}) as Record<string, Price> };
  const setConcepts = must<{ concept_id: string }[]>(await supabase.from('cms_typical_set_concepts').select('concept_id').eq('typical_set_id', setId));
  const conceptIds = [...new Set([...setConcepts.map((x) => x.concept_id), ...(source?.concepts.map((x) => x.concept_id) ?? [])])];
  const concepts = edit.lists.concepts.filter((x) => conceptIds.includes(x.concept_id)).map((x) => ({ concept_id: x.concept_id, name: x.name }));
  const misconceptions = edit.lists.misconceptions.filter((m) => m.concept_id && conceptIds.includes(m.concept_id)).map((m) => ({ misconception_id: m.misconception_id, description: m.description }));
  const stats = must<{ math_difficulty: string | null }[]>(await supabase.from('cms_question_list').select('math_difficulty').eq('typical_set_id', setId).eq('counted', true));
  const missing = (['Simple', 'Medium', 'Complex'] as const).filter((lvl) => !stats.some((x) => x.math_difficulty === lvl));
  // duplicate / copy candidates (G2): the topic's and the pattern's questions, and the topic's book items
  const sourcePattern = source?.pattern_id ?? null;
  const [qs, pqs, items] = await Promise.all([
    supabase.from('cms_question_list').select('question_id, text').eq('topic_id', topicId).limit(1000),
    sourcePattern ? supabase.from('cms_question_list').select('question_id, text').eq('pattern_id', sourcePattern).limit(1000) : Promise.resolve({ data: [], error: null }),
    supabase.from('cms_source_items').select('ref_id, item_text').eq('topic_id', topicId).limit(1000),
  ]);
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const x of [...must<{ question_id: string; text: string }[]>(qs), ...must<{ question_id: string; text: string }[]>(pqs)]) if (!seen.has(x.question_id)) { seen.add(x.question_id); candidates.push({ id: x.question_id, kind: 'question', text: x.text }); }
  for (const x of must<{ ref_id: string; item_text: string }[]>(items)) candidates.push({ id: x.ref_id, kind: 'source_item', text: x.item_text });
  const runs = must<{ cost: number | null }[]>(await supabase.from('cms_generation_runs').select('cost').gte('created_at', startOfTodayIst()));
  return {
    mode: args.questionId ? 'similar' : 'fill', subject: edit.detail.question.subject, chapterId: topic.chapter_id, classLevel: topic.class, topicId, topicName: topic.name,
    setId, setName: set.name, patternId: sourcePattern, patternName: edit.lists.patterns.find((p) => p.pattern_id === sourcePattern)?.name ?? null,
    source, sourceId, missing, concepts, misconceptions, config, derived: edit.cfg, catalog: edit.catalog, conceptClass: edit.conceptClass,
    candidates, spentToday: runs.reduce((n, r) => n + Number(r.cost ?? 0), 0),
  };
}

async function anyQuestionInChapter(chapterId: string) {
  const [q] = must<{ question_id: string }[]>(await supabase.from('cms_question_list').select('question_id').eq('chapter_id', chapterId).limit(1));
  if (!q) throw new Error('This chapter has no question to load the catalogue from yet.');
  return q.question_id;
}

/** The cached system prompt: v10 rubric, calibration, strategy types and up to 8 prompt-example gold questions of the class (never test-only). */
export async function loadPack(classLevel: number) {
  const [rv] = must<{ rule_version: string }[]>(await supabase.from('cms_rule_versions').select('rule_version').order('created_at', { ascending: false }).limit(1));
  const ruleVersion = rv?.rule_version ?? 'v10';
  const [attrs, rubric, calib, strategies, gold] = await Promise.all([
    supabase.from('cms_attribute_defs').select('attribute, meaning, values, sort').eq('rule_version', ruleVersion).order('sort'),
    supabase.from('cms_tagging_rubric').select('attribute, definition, levels_anchors, rules, edge_cases').eq('rule_version', ruleVersion),
    supabase.from('cms_calibration_cases').select('case_id, attribute, first_value, final_value, why_wrong, rule').eq('rule_version', ruleVersion).order('case_id'),
    supabase.from('cms_strategy_types').select('value, active, sort').order('sort'),
    supabase.from('cms_question_list').select('question_id, class, gold_use').eq('bank', 'gold').eq('gold_use', 'prompt_example').order('question_id'),
  ]);
  const golds = must<{ question_id: string; class: number; gold_use: string }[]>(gold);
  const picked = [...golds.filter((g) => g.class === classLevel), ...golds.filter((g) => g.class !== classLevel)].slice(0, 8);
  const examples = await Promise.all(picked.map(async (g) => { const d = await questionDetail(g.question_id, null); return { qid: g.question_id, use: d?.gold?.use ?? 'test_only', question: questionFromDb(bundleOf(d!)) }; }));
  return { ...buildPack({ ruleVersion, attributes: must(attrs) as never, rubric: must(rubric) as never, calibration: must(calib) as never,
    strategyTypes: must<{ value: string; active: boolean }[]>(strategies).filter((s) => s.active).map((s) => s.value), examples }), ruleVersion };
}

export const priceFor = (cfg: AiConfig, model: string): Price =>
  cfg.prices[model] ?? cfg.prices[cfg.model] ?? { input: 0, output: 0, cache_write: 0, cache_read: 0 };

/** Rough upper estimate before a run: system + prompt at full input price, ~900 output tokens per draft. */
export function estimateUsd(cfg: AiConfig, systemChars: number, promptChars: number, count: number, batch: boolean) {
  return costUsd({ input_tokens: Math.ceil((systemChars + promptChars) / 3.5), output_tokens: count * 900 }, priceFor(cfg, cfg.model), batch);
}

const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(path, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok) throw Object.assign(new Error(String(body.error ?? `AI service answered ${r.status}`)), { body });
  return body;
};
export const recordRun = (p: Record<string, unknown>) => rpc('cms_record_run', { p }) as Promise<number>;
export const saveJob = (p: Record<string, unknown>) => rpc('cms_save_job', { p }) as Promise<number>;

/** Check each draft and save the good ones as new drafts through cms_apply_save. */
export async function processDrafts(ctx: GenContext, drafts: RawDraft[], runId: number): Promise<DraftOutcome[]> {
  const out: DraftOutcome[] = [];
  for (const [i, d] of drafts.entries()) {
    const q = toQuestion(d, { key: `${ctx.chapterId}-5000`, topic_id: ctx.topicId, typical_set_id: ctx.setId, pattern_id: ctx.patternId, clone_batch_id: ctx.source?.clone_batch_id || `gen-${runId}` });
    const file = { file_schema: 'cms-chapter/1.0' as const, attribute_version: 'v10', subject: ctx.subject as 'math', class: ctx.classLevel, chapter_id: ctx.chapterId,
      generated: { by: 'CMS generation', date: new Date().toISOString().slice(0, 10) }, questions: [q] };
    const problems = checkFile(file, ctx.catalog, { gold: true });
    const errors = problems.filter((p) => p.level === 'error').map((p) => p.message);
    const warnings = problems.filter((p) => p.level === 'warning').map((p) => p.message);
    const hits = checkAgainst(q.text, ctx.candidates, ctx.config.threshold);
    let question_id: string | null = null;
    if (!errors.length) {
      const rows = rowsFor(q, ctx.derived, ctx.classLevel, ctx.conceptClass);
      const res = await rpc('cms_apply_save', { payload: {
        mode: 'create', base_version_no: null, content_hash: structureHash(q, q.topic_id), run_id: runId,
        question: { subject: ctx.subject, chapter_id: ctx.chapterId, class: ctx.classLevel, topic_id: q.topic_id, typical_set_id: q.typical_set_id,
          pattern_id: q.pattern_id ?? null, clone_batch_id: q.clone_batch_id, class_override: null, placement_note: null },
        version: rows.version, parts: rows.parts, options: rows.options, wrong_answers: rows.wrong_answers, concepts: rows.concepts,
        solutions: rows.solutions, hints: rows.hints, source_refs: [], reason: `generated (run ${runId})`,
        diff: { generated_from: ctx.sourceId, similar_to: hits.slice(0, 3) },
      } }) as { question_id: string };
      question_id = res.question_id;
      ctx.candidates.push({ id: question_id, kind: 'question', text: q.text }); // later drafts in the run are checked against it too
    }
    out.push({ index: i + 1, question_id, text: q.text, difficulty: q.signature.math_difficulty, errors, warnings, hits });
  }
  return out;
}

/** "Generate now": one Messages call, then check and save. Returns the run id. */
export async function runNow(ctx: GenContext, settings: GenerateSettings, pack: Awaited<ReturnType<typeof loadPack>>) {
  const prompt = buildPrompt(ctx.source, settings);
  const runId = await recordRun({ kind: ctx.mode === 'similar' ? 'generate_similar' : 'fill_set', model: ctx.config.model,
    pack: { version: pack.version, rule_version: pack.ruleVersion, content: pack.text, hash: pack.hash },
    params: { source: ctx.sourceId, set: ctx.setId, topic: ctx.topicId, count: settings.count, difficulties: settings.difficulties, vary: settings.vary, batch: false } });
  try {
    const r = await api('/api/ai/generate', { method: 'POST', body: JSON.stringify({ model: ctx.config.model, effort: ctx.config.effort, system: pack.text, prompt, count: settings.count }) });
    const usage = r.usage as Usage, model = String(r.model);
    const cost = costUsd(usage, priceFor(ctx.config, model));
    const outcomes = await processDrafts(ctx, r.drafts as RawDraft[], runId);
    await recordRun({ run_id: runId, status: 'ok', tokens_in: usage.input_tokens, tokens_out: usage.output_tokens, cost, params: { usage, model_used: model, outcomes } });
    return runId;
  } catch (e) {
    const body = (e as { body?: { usage?: Usage; model?: string } }).body;
    const cost = body?.usage ? costUsd(body.usage, priceFor(ctx.config, body.model ?? ctx.config.model)) : 0;
    await recordRun({ run_id: runId, status: 'failed', ...(body?.usage ? { tokens_in: body.usage.input_tokens, tokens_out: body.usage.output_tokens } : {}), cost, params: { error: (e as Error).message } });
    throw e;
  }
}

/** "Batch": requests of up to 5 drafts per difficulty; tracked as a job until collected. */
export async function runBatch(ctx: GenContext, settings: GenerateSettings, pack: Awaited<ReturnType<typeof loadPack>>) {
  const groups: { custom_id: string; prompt: string; count: number }[] = [];
  const byLevel = new Map<string, number>();
  for (const d of settings.difficulties) byLevel.set(d, (byLevel.get(d) ?? 0) + 1);
  for (const [lvl, n] of byLevel) for (let i = 0; i < n; i += 5) {
    const count = Math.min(5, n - i);
    groups.push({ custom_id: `${lvl}-${i / 5 + 1}`, count, prompt: buildPrompt(ctx.source, { ...settings, count, difficulties: Array(count).fill(lvl) }) });
  }
  const runId = await recordRun({ kind: ctx.mode === 'similar' ? 'generate_similar' : 'fill_set', model: ctx.config.model,
    pack: { version: pack.version, rule_version: pack.ruleVersion, content: pack.text, hash: pack.hash },
    params: { source: ctx.sourceId, set: ctx.setId, topic: ctx.topicId, count: settings.count, difficulties: settings.difficulties, vary: settings.vary, batch: true } });
  const b = await api('/api/ai/batch', { method: 'POST', body: JSON.stringify({ model: ctx.config.model, effort: ctx.config.effort, system: pack.text, requests: groups }) });
  const jobId = await saveJob({ type: 'generation_batch', payload: { batch_id: b.id, run_id: runId, source: ctx.sourceId, set: ctx.setId, topic: ctx.topicId, requests: groups.length } });
  await recordRun({ run_id: runId, params: { batch_id: b.id, job_id: jobId } });
  return { runId, jobId, batchId: String(b.id) };
}

export const batchStatus = (id: string) => api(`/api/ai/batch?id=${encodeURIComponent(id)}`);

/** Collect an ended batch: check and save its drafts, log batch-price cost, finish the job. */
export async function collectBatch(job: { job_id: number; payload: Record<string, unknown> }) {
  const p = job.payload as { batch_id: string; run_id: number; source: string | null; set: string; topic: string };
  const ctx = await loadContext(p.source ? { questionId: p.source } : { setId: p.set, topicId: p.topic });
  const r = await api(`/api/ai/batch/results?id=${encodeURIComponent(p.batch_id)}`);
  const results = r.results as { custom_id: string; type: string; drafts?: RawDraft[]; usage?: Usage; model?: string }[];
  let tokensIn = 0, tokensOut = 0, cost = 0;
  const drafts: RawDraft[] = [];
  for (const x of results) {
    if (x.usage) { tokensIn += x.usage.input_tokens; tokensOut += x.usage.output_tokens; cost += costUsd(x.usage, priceFor(ctx.config, x.model ?? ctx.config.model), true); }
    if (x.type === 'succeeded' && x.drafts) drafts.push(...x.drafts);
  }
  const outcomes = await processDrafts(ctx, drafts, p.run_id);
  await recordRun({ run_id: p.run_id, status: 'ok', tokens_in: tokensIn, tokens_out: tokensOut, cost: Math.round(cost * 1e6) / 1e6,
    params: { outcomes, failed_requests: results.filter((x) => x.type !== 'succeeded').map((x) => x.custom_id) } });
  await saveJob({ job_id: job.job_id, status: 'ok', progress: 100, result: { saved: outcomes.filter((o) => o.question_id).length, drafts: outcomes.length } });
  return p.run_id;
}

export async function runRecord(runId: number) {
  return must<{ run_id: number; kind: string; model: string; status: string; tokens_in: number | null; tokens_out: number | null; cost: number | null; created_at: string;
    params: { outcomes?: DraftOutcome[]; error?: string; batch?: boolean; source?: string | null; set?: string; topic?: string; usage?: Usage } }>(
    await supabase.from('cms_generation_runs').select('*').eq('run_id', runId).single());
}

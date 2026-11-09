// Phase 6: generation in the browser. The /api/ai Pages Function (behind Access, API key
// only) returns drafts; everything else happens here: the tagging pack, the prompt, cost
// and the daily cap, the checks, and saving through cms_apply_save ("create").
import { checkFile, type Catalog } from '../../shared/checks.ts';
import { questionFromDb } from '../../shared/fromDb.ts';
import { agreement, attemptsCost, buildContext, buildPrompt, buildRules, buildTagPrompt, checkAgainst, compareTags, costUsd, fallbackOf, pickCalibration, sumUsage, toQuestion,
  type Agreement, type AiTask, type Attempt, type AttrScore, type CalibrationCase, type Candidate, type GenerateSettings, type Hit, type Price, type RawDraft, type RawTags, type Usage } from '../../shared/generation.ts';
import { rowsFor } from '../../shared/save.ts';
import type { DerivedConfig, Question } from '../../shared/types.ts';
import { structureHash } from '../../shared/version.ts';
import { questionDetail } from './api';
import { bundleOf, loadForEdit } from './editApi';
import { supabase } from './supabase';

const must = <T>(r: { data: T | null; error: { message: string } | null }): T => { if (r.error) throw new Error(r.error.message); return r.data as T; };
const rpc = async (fn: string, args: Record<string, unknown>) => { const { data, error } = await supabase.rpc(fn, args); if (error) throw new Error(error.message); return data; };

/** AI settings from cms_config. One model per task (ai_model_generate / _tag / _extract), all claude-haiku-5-5 by default (0014). */
export interface AiConfig { models: Record<AiTask, string>; fallbackModel: string; effort: string; maxDrafts: number; dailyCapUsd: number; threshold: number; prices: Record<string, Price> }
export interface GenContext {
  mode: 'similar' | 'fill';
  subject: string; chapterId: string; classLevel: number; topicId: string; topicName: string;
  setId: string; setName: string; patternId: string | null; patternName: string | null;
  source: Question | null; sourceId: string | null;
  missing: ('Simple' | 'Medium' | 'Complex')[];
  concepts: { concept_id: string; name: string }[]; misconceptions: { misconception_id: string; description: string }[];
  conceptIds: string[];
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
  const config = await loadAiConfig();
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
  const spentToday = await spentTodayUsd();
  return {
    mode: args.questionId ? 'similar' : 'fill', subject: edit.detail.question.subject, chapterId: topic.chapter_id, classLevel: topic.class, topicId, topicName: topic.name,
    setId, setName: set.name, patternId: sourcePattern, patternName: edit.lists.patterns.find((p) => p.pattern_id === sourcePattern)?.name ?? null,
    source, sourceId, missing, concepts, misconceptions, conceptIds, config, derived: edit.cfg, catalog: edit.catalog, conceptClass: edit.conceptClass,
    candidates, spentToday,
  };
}

async function anyQuestionInChapter(chapterId: string) {
  const [q] = must<{ question_id: string }[]>(await supabase.from('cms_question_list').select('question_id').eq('chapter_id', chapterId).limit(1));
  if (!q) throw new Error('This chapter has no question to load the catalogue from yet.');
  return q.question_id;
}

export async function loadAiConfig(): Promise<AiConfig> {
  const rows = must<{ key: string; value: unknown }[]>(await supabase.from('cms_config').select('key, value').or('key.like.ai_%,key.eq.similarity_threshold'));
  const c = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<string, unknown>;
  const m = (k: string) => String(c[k] ?? 'claude-haiku-5-5');
  return { models: { generate: m('ai_model_generate'), tag: m('ai_model_tag'), extract: m('ai_model_extract') }, fallbackModel: String(c.ai_fallback_model ?? 'claude-sonnet-5-5'),
    effort: String(c.ai_effort ?? 'high'), maxDrafts: Number(c.ai_max_drafts_per_run ?? 20), dailyCapUsd: Number(c.ai_daily_cap_usd ?? 5),
    threshold: Number(c.similarity_threshold ?? 0.6), prices: (c.ai_prices ?? {}) as Record<string, Price> };
}

export async function spentTodayUsd() {
  const runs = must<{ cost: number | null }[]>(await supabase.from('cms_generation_runs').select('cost').gte('created_at', startOfTodayIst()));
  return runs.reduce((n, r) => n + Number(r.cost ?? 0), 0);
}

async function latestRuleVersion() {
  const [rv] = must<{ rule_version: string }[]>(await supabase.from('cms_rule_versions').select('rule_version').order('created_at', { ascending: false }).limit(1));
  return rv?.rule_version ?? 'v10';
}

export type Rules = ReturnType<typeof buildRules> & { ruleVersion: string; task: AiTask };
/** The fixed, cached system prompt for a task: attributes, rubric, strategy types, task rules. */
export async function loadRules(task: AiTask): Promise<Rules> {
  const ruleVersion = await latestRuleVersion();
  const [attrs, rubric, strategies] = await Promise.all([
    supabase.from('cms_attribute_defs').select('attribute, meaning, values, sort').eq('rule_version', ruleVersion).order('sort'),
    supabase.from('cms_tagging_rubric').select('attribute, definition, levels_anchors, rules, edge_cases').eq('rule_version', ruleVersion),
    supabase.from('cms_strategy_types').select('value, active, sort').order('sort'),
  ]);
  return { ...buildRules(task, { ruleVersion, attributes: must(attrs) as never, rubric: must(rubric) as never,
    strategyTypes: must<{ value: string; active: boolean }[]>(strategies).filter((x) => x.active).map((x) => x.value) }), ruleVersion, task };
}

/** Every calibration case of the rule version, with its question's class and whether it is test-only gold. */
export async function loadCalibration(): Promise<CalibrationCase[]> {
  const ruleVersion = await latestRuleVersion();
  type Row = Omit<CalibrationCase, 'class' | 'test_only'> & { question_id: string | null };
  const cases = must<Row[]>(await supabase.from('cms_calibration_cases').select('case_id, question_id, attribute, first_value, final_value, why_wrong, rule').eq('rule_version', ruleVersion).order('case_id'));
  const ids = [...new Set(cases.map((c) => c.question_id).filter((x): x is string => !!x))];
  const qs = ids.length ? must<{ question_id: string; class: number; gold_use: string | null }[]>(await supabase.from('cms_question_list').select('question_id, class, gold_use').in('question_id', ids)) : [];
  const by = new Map(qs.map((q) => [q.question_id, q]));
  // a case whose question is unknown is treated as test-only (never sent) [guess: safest]
  return cases.map((c) => ({ ...c, class: by.get(c.question_id ?? '')?.class ?? null, test_only: !c.question_id ? false : (by.get(c.question_id)?.gold_use ?? 'test_only') === 'test_only' }));
}

/** The per-topic part of a request: the topic's concept cards (+ any extra concept IDs), their misconceptions,
 *  the calibration cases near the class, and up to 4 prompt-example gold questions (same topic, then nearest class). */
export async function loadTopicContext(classLevel: number, topicId: string, extraConceptIds: string[], calibration?: CalibrationCase[]) {
  const ors = [`topic_id.eq.${topicId}`, ...(extraConceptIds.length ? [`concept_id.in.(${extraConceptIds.join(',')})`] : [])].join(',');
  const cards = must<{ concept_id: string; name: string; type: string | null; description: string | null; includes: string | null; excludes: string | null; example_question: string | null }[]>(
    await supabase.from('cms_concepts').select('concept_id, name, type, description, includes, excludes, example_question').or(ors).order('concept_id'));
  const ids = cards.map((c) => c.concept_id);
  const misconceptions = ids.length ? must<{ misconception_id: string; concept_id: string | null; description: string }[]>(
    await supabase.from('cms_misconceptions').select('misconception_id, concept_id, description').in('concept_id', ids).order('misconception_id')) : [];
  const golds = must<{ question_id: string; class: number; topic_id: string; gold_use: string }[]>(
    await supabase.from('cms_question_list').select('question_id, class, topic_id, gold_use').eq('bank', 'gold').eq('gold_use', 'prompt_example').order('question_id'));
  const rank = (g: { class: number; topic_id: string }) => (g.topic_id === topicId ? 0 : 1) * 10 + Math.abs(g.class - classLevel);
  const picked = [...golds].sort((x, y) => rank(x) - rank(y)).slice(0, 4);
  const examples = await Promise.all(picked.map(async (g) => { const d = await questionDetail(g.question_id, null); return { qid: g.question_id, use: d?.gold?.use ?? 'test_only', question: questionFromDb(bundleOf(d!)) }; }));
  const cal = pickCalibration(calibration ?? await loadCalibration(), classLevel);
  return { ...buildContext({ cards, misconceptions, calibration: cal, examples }), conceptIds: ids, calibrationIds: cal.map((c) => c.case_id) };
}

/** Rules + context for a generation context. */
export async function loadPromptParts(ctx: GenContext) {
  const [rules, context] = await Promise.all([loadRules('generate'), loadTopicContext(ctx.classLevel, ctx.topicId, ctx.conceptIds)]);
  return { rules, context };
}
export type PromptParts = Awaited<ReturnType<typeof loadPromptParts>>;

/** The price row for a model; an unknown model is priced as the most expensive known one (cost shown high, never low) [guess]. */
export function priceFor(cfg: AiConfig, model: string): Price {
  const known = cfg.prices[model];
  if (known) return known;
  const all = Object.values(cfg.prices);
  return all.length ? all.reduce((a, b) => (b.output > a.output ? b : a)) : { input: 0, output: 0, cache_write: 0, cache_read: 0 };
}

/** Rough upper estimate before a run: everything at full input price (~3 characters a token), ~900 output tokens per draft. */
export function estimateUsd(cfg: AiConfig, model: string, chars: number, outputTokens: number, batch: boolean) {
  return costUsd({ input_tokens: Math.ceil(chars / 3), output_tokens: outputTokens }, priceFor(cfg, model), batch);
}

/** What the AI function returns about a request, beyond the payload. */
interface CallMeta { usage?: Usage; model?: string; attempts?: Attempt[]; fallback?: ReturnType<typeof fallbackOf>; prompt_tokens?: number }
/** Run-log fields for a request: requested vs answering model, every attempt with its cost, the fallback if it fired. */
function logOf(cfg: AiConfig, requested: string, m: CallMeta, batch = false) {
  const attempts = m.attempts ?? (m.usage ? [{ model: m.model ?? requested, via: 'requested' as const, usage: m.usage, stop_reason: null }] : []);
  const priced = attempts.map((a) => ({ ...a, cost: costUsd(a.usage, priceFor(cfg, a.model), batch) }));
  const usage = sumUsage(attempts);
  return { cost: attemptsCost(attempts, (x) => priceFor(cfg, x), batch), tokens_in: usage.input_tokens, tokens_out: usage.output_tokens,
    params: { usage, requested_model: requested, model_used: m.model ?? requested, attempts: priced, fallback: m.fallback ?? fallbackOf(attempts), prompt_tokens: m.prompt_tokens ?? null } };
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
export async function runNow(ctx: GenContext, settings: GenerateSettings, parts: PromptParts) {
  const model = ctx.config.models.generate;
  const prompt = buildPrompt(ctx.source, settings, parts.context.text);
  const runId = await recordRun({ kind: ctx.mode === 'similar' ? 'generate_similar' : 'fill_set', model,
    pack: { version: parts.rules.version, rule_version: parts.rules.ruleVersion, content: parts.rules.text, hash: parts.rules.hash },
    params: { source: ctx.sourceId, set: ctx.setId, topic: ctx.topicId, count: settings.count, difficulties: settings.difficulties, vary: settings.vary, batch: false,
      concept_cards: parts.context.conceptIds, calibration_cases: parts.context.calibrationIds } });
  try {
    const r = await api('/api/ai/generate', { method: 'POST', body: JSON.stringify({ model, fallback_model: ctx.config.fallbackModel, effort: ctx.config.effort, system: parts.rules.text, prompt, count: settings.count }) });
    const log = logOf(ctx.config, model, r as CallMeta);
    const outcomes = await processDrafts(ctx, r.drafts as RawDraft[], runId);
    await recordRun({ run_id: runId, status: 'ok', tokens_in: log.tokens_in, tokens_out: log.tokens_out, cost: log.cost, params: { ...log.params, outcomes } });
    return runId;
  } catch (e) {
    const body = (e as { body?: CallMeta }).body ?? {};
    const log = logOf(ctx.config, model, body);
    await recordRun({ run_id: runId, status: 'failed', tokens_in: log.tokens_in, tokens_out: log.tokens_out, cost: log.cost, params: { ...log.params, error: (e as Error).message } });
    throw e;
  }
}

/** "Batch": requests of up to 5 drafts per difficulty; tracked as a job until collected. No refusal fallback on batches (the API rejects it). */
export async function runBatch(ctx: GenContext, settings: GenerateSettings, parts: PromptParts) {
  const model = ctx.config.models.generate;
  const groups: { custom_id: string; prompt: string; count: number }[] = [];
  const byLevel = new Map<string, number>();
  for (const d of settings.difficulties) byLevel.set(d, (byLevel.get(d) ?? 0) + 1);
  for (const [lvl, n] of byLevel) for (let i = 0; i < n; i += 5) {
    const count = Math.min(5, n - i);
    groups.push({ custom_id: `${lvl}-${i / 5 + 1}`, count, prompt: buildPrompt(ctx.source, { ...settings, count, difficulties: Array(count).fill(lvl) }, parts.context.text) });
  }
  const runId = await recordRun({ kind: ctx.mode === 'similar' ? 'generate_similar' : 'fill_set', model,
    pack: { version: parts.rules.version, rule_version: parts.rules.ruleVersion, content: parts.rules.text, hash: parts.rules.hash },
    params: { source: ctx.sourceId, set: ctx.setId, topic: ctx.topicId, count: settings.count, difficulties: settings.difficulties, vary: settings.vary, batch: true,
      requested_model: model, concept_cards: parts.context.conceptIds, calibration_cases: parts.context.calibrationIds } });
  const b = await api('/api/ai/batch', { method: 'POST', body: JSON.stringify({ model, effort: ctx.config.effort, system: parts.rules.text, requests: groups }) });
  const jobId = await saveJob({ type: 'generation_batch', payload: { batch_id: b.id, run_id: runId, source: ctx.sourceId, set: ctx.setId, topic: ctx.topicId, requests: groups.length, model } });
  await recordRun({ run_id: runId, params: { batch_id: b.id, job_id: jobId } });
  return { runId, jobId, batchId: String(b.id) };
}

export const batchStatus = (id: string) => api(`/api/ai/batch?id=${encodeURIComponent(id)}`);

/** Collect an ended batch: check and save its drafts, log batch-price cost per answering model, finish the job. */
export async function collectBatch(job: { job_id: number; payload: Record<string, unknown> }) {
  const p = job.payload as { batch_id: string; run_id: number; source: string | null; set: string; topic: string; model?: string };
  const ctx = await loadContext(p.source ? { questionId: p.source } : { setId: p.set, topicId: p.topic });
  const r = await api(`/api/ai/batch/results?id=${encodeURIComponent(p.batch_id)}`);
  const results = r.results as { custom_id: string; type: string; drafts?: RawDraft[]; usage?: Usage; model?: string; attempts?: Attempt[] }[];
  const attempts = results.flatMap((x) => x.attempts ?? (x.usage ? [{ model: x.model ?? p.model ?? ctx.config.models.generate, via: 'requested' as const, usage: x.usage, stop_reason: null }] : []));
  const log = logOf(ctx.config, p.model ?? ctx.config.models.generate, { attempts, model: attempts[attempts.length - 1]?.model }, true);
  const drafts = results.flatMap((x) => (x.type === 'succeeded' && x.drafts ? x.drafts : []));
  const outcomes = await processDrafts(ctx, drafts, p.run_id);
  await recordRun({ run_id: p.run_id, status: 'ok', tokens_in: log.tokens_in, tokens_out: log.tokens_out, cost: log.cost,
    params: { ...log.params, outcomes, failed_requests: results.filter((x) => x.type !== 'succeeded').map((x) => `${x.custom_id} (${x.type})`) } });
  await saveJob({ job_id: job.job_id, status: 'ok', progress: 100, result: { saved: outcomes.filter((o) => o.question_id).length, drafts: outcomes.length } });
  return p.run_id;
}

export type LoggedAttempt = Attempt & { cost: number };
export interface RunParams {
  outcomes?: DraftOutcome[]; error?: string; batch?: boolean; source?: string | null; set?: string; topic?: string; usage?: Usage;
  requested_model?: string; model_used?: string; attempts?: LoggedAttempt[]; fallback?: ReturnType<typeof fallbackOf>; prompt_tokens?: number | null;
  failed_requests?: string[]; purpose?: string; check?: ModelCheckResult[]; agreement?: Agreement[]; questions?: number; stopped?: string | null;
}
export async function runRecord(runId: number) {
  return must<{ run_id: number; kind: string; model: string; status: string; tokens_in: number | null; tokens_out: number | null; cost: number | null; created_at: string;
    params: RunParams }>(
    await supabase.from('cms_generation_runs').select('*').eq('run_id', runId).single());
}

// ---------------------------------------------------------------- model check (tagging agreement on test-only gold)
export interface ModelCheckResult { qid: string; class: number; topic_id: string; scores: AttrScore[]; cost: number; models: string[]; fallback: boolean; error?: string }

/** Test-only gold: the questions a model is checked on (never used as prompt examples). */
export async function testOnlyGold() {
  return must<{ question_id: string; class: number; topic_id: string }[]>(
    await supabase.from('cms_question_list').select('question_id, class, topic_id').eq('bank', 'gold').eq('gold_use', 'test_only').order('question_id'));
}

/** Tag every test-only gold question with `model` (values hidden) and compare with the gold values.
 *  The first request runs alone so the fixed rules are cached; the rest run 3 at a time. Stops at the daily cap. */
export async function runModelCheck(model: string, onProgress: (done: number, total: number) => void): Promise<number> {
  const cfg = await loadAiConfig();
  const [rules, calibration, golds] = await Promise.all([loadRules('tag'), loadCalibration(), testOnlyGold()]);
  let spent = await spentTodayUsd();
  const runId = await recordRun({ kind: 'tag', model, pack: { version: rules.version, rule_version: rules.ruleVersion, content: rules.text, hash: rules.hash },
    params: { purpose: 'model_check', requested_model: model, questions: golds.length } });
  const topics = new Map(must<{ topic_id: string; name: string }[]>(await supabase.from('cms_topics').select('topic_id, name').in('topic_id', [...new Set(golds.map((g) => g.topic_id))])).map((t) => [t.topic_id, t.name]));
  const results: ModelCheckResult[] = [], attempts: Attempt[] = [];
  let stopped: string | null = null, done = 0;
  const one = async (g: { question_id: string; class: number; topic_id: string }) => {
    if (stopped) return;
    if (spent >= cfg.dailyCapUsd) { stopped = `stopped at today's cap ($${cfg.dailyCapUsd})`; return; }
    const d = await questionDetail(g.question_id, null);
    if (!d) { results.push({ qid: g.question_id, class: g.class, topic_id: g.topic_id, scores: [], cost: 0, models: [], fallback: false, error: 'not found' }); return; }
    const gold = questionFromDb(bundleOf(d));
    const context = await loadTopicContext(g.class, g.topic_id, [], calibration);
    const prompt = buildTagPrompt(gold, g.class, topics.get(g.topic_id) ?? g.topic_id, context.text);
    try {
      const r = await api('/api/ai/tag', { method: 'POST', body: JSON.stringify({ model, fallback_model: cfg.fallbackModel, effort: cfg.effort, system: rules.text, prompt }) });
      const at = (r.attempts ?? []) as Attempt[];
      attempts.push(...at);
      const cost = attemptsCost(at, (x) => priceFor(cfg, x));
      spent += cost;
      results.push({ qid: g.question_id, class: g.class, topic_id: g.topic_id, scores: compareTags(gold, r.tags as RawTags, context.conceptIds), cost,
        models: [...new Set(at.map((a) => a.model))], fallback: !!r.fallback });
    } catch (e) {
      const at = ((e as { body?: CallMeta }).body?.attempts ?? []) as Attempt[];
      attempts.push(...at);
      const cost = attemptsCost(at, (x) => priceFor(cfg, x));
      spent += cost;
      results.push({ qid: g.question_id, class: g.class, topic_id: g.topic_id, scores: [], cost, models: [...new Set(at.map((a) => a.model))], fallback: at.some((a) => a.via !== 'requested'), error: (e as Error).message });
    } finally { onProgress(++done, golds.length); }
  };
  try {
    if (golds[0]) await one(golds[0]);
    const queue = golds.slice(1);
    await Promise.all(Array.from({ length: 3 }, async () => { for (let g = queue.shift(); g; g = queue.shift()) await one(g); }));
  } finally {
    const log = logOf(cfg, model, { attempts, model: attempts[attempts.length - 1]?.model });
    results.sort((a, b) => a.qid.localeCompare(b.qid));
    await recordRun({ run_id: runId, status: results.some((r) => !r.error) ? 'ok' : 'failed', tokens_in: log.tokens_in, tokens_out: log.tokens_out, cost: log.cost,
      params: { ...log.params, fallback: attempts.some((a) => a.via !== 'requested') ? fallbackOf(attempts) : null, check: results, agreement: agreement(results.map((r) => r.scores)), stopped } });
  }
  return runId;
}

export async function modelCheckRuns() {
  return must<{ run_id: number; model: string; status: string; cost: number | null; created_at: string; params: RunParams }[]>(
    await supabase.from('cms_generation_runs').select('run_id, model, status, cost, created_at, params').eq('kind', 'tag').eq('params->>purpose', 'model_check').order('run_id', { ascending: false }).limit(20));
}

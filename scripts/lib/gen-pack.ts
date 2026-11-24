// Q38 PR 1: the generation pack import ("pack mode"), Science first. Plan: docs/plan-2026-11-23-q38-direct-generation.md §2.
//
// A pack (schema/generation-pack.schema.json) is one run of the engine, in our own wording, with run-local IDs only.
// This module validates it, picks what to import (pilot: only what Sambit approved in the Mac review pack; steady state:
// everything that passed the checks), uploads figures FIRST (R2, verified), then writes small batches through the
// admin-checked cms_gen_import_batch: each batch is its own transaction on a fresh connection, and the CMS keeps a
// per-item ledger (cms_generation_items), so a pooler drop or a pause loses only the open batch and a re-run continues.
// The CMS mints every key and catalogue ID. Nothing outside the run is added, edited or flagged.
import { createHash } from 'node:crypto';
import { briefProblem, type ImageBrief } from '../../shared/image-brief.ts';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Sql, UnitRunner } from './db.ts';
import { readRaw, type Cell } from './xlsx.ts';

// ---------------------------------------------------------------- types
export type Role = 'primary' | 'secondary' | 'supporting';
export type Decision = 'approve' | 'fix' | 'drop' | 'rescue' | null;
export interface PackOriginalityResult { result: 'clear' | 'flagged' | 'near_copy' | 'no_sources'; similarity: number; same_numbers?: boolean | null; closest_ref?: string | null; field?: string | null }
export interface PackQuestion {
  local_id: string; subject: 'science' | 'math'; topic_id: string; class: number; level?: number | null;
  format: 'MCQ-4' | 'MCQ-3' | 'True/False'; display_format?: string | null; text: string; options: string[]; answer: 'A' | 'B' | 'C' | 'D';
  solution_1: string; solution_2?: string | null; figure_needed?: boolean; figure_description?: string | null;
  figure?: { file: string; sha256: string; width?: number; height?: number; svg?: string | null; alt?: string | null } | null;
  /** Images PR (DL-040): the structured image brief (shared/image-brief.ts); written to image_brief, figure_description = its text */
  figure_brief?: ImageBrief | null;
  linked_rows: { row_id: string; role: Role }[]; misconception?: { row_id: string; item_no: number } | null;
  wrong_option_tags?: { option: 'A' | 'B' | 'C' | 'D'; tag: string; row_id?: string | null; item_no?: number | null; why?: string | null }[];
  science_question_type?: number | null; setting?: { setting_id: string } | { new: string } | null; setting_note?: string | null; setting_familiarity?: string | null;
  hidden_idea?: boolean | null; experiment?: boolean | null;
  drivers?: { reading?: number | null; steps?: number | null; inhibition?: number | null; visual?: number | null; irrelevant_info?: boolean | null };
  safety_note?: string | null; author_notes?: string | null;
  passed: boolean; warnings?: { kind: string; reason: string }[]; warning_reason?: string | null; checks?: Record<string, unknown>;
  originality: 'not_checked' | PackOriginalityResult; review?: { decision?: Decision; comment?: string | null } | null;
}
export interface Pack {
  file_schema: 'generation-pack/1';
  run: { source_run: string; subject: 'science' | 'math'; route: 'A' | 'B'; engine?: string; engine_version?: string; prompt_hashes?: Record<string, string>;
         models?: Record<string, string>; cms_commit?: string | null; snapshot_id?: string | null; rule_version?: string | null; topics?: string[];
         cost_usd?: number | null; cost_detail?: Record<string, unknown>; tokens_in?: number | null; tokens_out?: number | null; created_at?: string | null };
  originality?: { tool: string; checked_at: string; threshold: number; near_copy_threshold: number; read?: string[]; missing?: string[]; report_file?: string | null; report_sha256?: string | null } | null;
  catalogue_new?: { settings?: { local_id: string; name: string; description?: string | null }[] };
  questions: PackQuestion[];
}

// ---------------------------------------------------------------- validation
const schema = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'schema', 'generation-pack.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const validateSchema = ajv.compile(schema);
const plain = (e: ErrorObject, pack: unknown) => {
  const m = /^\/questions\/(\d+)(.*)$/.exec(e.instancePath);
  const lid = m ? (pack as Pack).questions?.[Number(m[1])]?.local_id ?? `question ${Number(m[1]) + 1}` : null;
  const at = (m ? m[2] ?? "" : e.instancePath).replace(/\//g, '.').replace(/^\./, '') || (lid ? '' : 'the pack');
  const what = e.keyword === 'additionalProperties' ? `unknown field "${(e.params as { additionalProperty: string }).additionalProperty}"`
    : e.keyword === 'required' ? `missing "${(e.params as { missingProperty: string }).missingProperty}"` : e.message ?? e.keyword;
  return `${lid ? `${lid}: ` : ''}${at ? `${at} ` : ''}${what}`;
};

/** Schema + cross-field problems. An empty list = the pack can be imported. */
export function packProblems(pack: unknown, packDir?: string): string[] {
  if (!validateSchema(pack)) return [...new Set((validateSchema.errors ?? []).filter((e) => e.keyword !== 'oneOf' && e.keyword !== 'if').map((e) => plain(e, pack)))].slice(0, 200);
  const p = pack as Pack, out: string[] = [];
  const seen = new Set<string>();
  const settings = new Set((p.catalogue_new?.settings ?? []).map((s) => s.local_id));
  if (settings.size !== (p.catalogue_new?.settings ?? []).length) out.push('catalogue_new.settings: a local_id is used twice');
  if (p.run.subject !== 'science') out.push(`run.subject is ${p.run.subject}: only Science packs can be imported yet (Math is PR 5 of Q38)`);
  for (const q of p.questions) {
    const at = q.local_id;
    if (seen.has(at)) out.push(`${at}: local_id is used twice in the run`); seen.add(at);
    if (q.subject !== p.run.subject) out.push(`${at}: subject ${q.subject}, but the run is ${p.run.subject}`);
    const need = q.format === 'MCQ-4' ? 4 : q.format === 'MCQ-3' ? 3 : 2;
    if (q.options.length !== need) out.push(`${at}: ${q.format} needs ${need} options, it has ${q.options.length}`);
    if ('ABCD'.indexOf(q.answer) >= q.options.length) out.push(`${at}: answer ${q.answer} is not one of its options`);
    if (q.linked_rows.filter((l) => l.role === 'primary').length !== 1) out.push(`${at}: needs exactly one primary row`);
    if (new Set(q.linked_rows.map((l) => l.row_id)).size !== q.linked_rows.length) out.push(`${at}: a content row is linked twice`);
    for (const t of q.wrong_option_tags ?? []) {
      if (t.option === q.answer) out.push(`${at}: the correct option ${t.option} can't be tagged`);
      if ((t.tag === 'misconception' || t.tag === 'concept_error') && !q.linked_rows.some((l) => l.row_id === t.row_id)) out.push(`${at}: option ${t.option} ${t.tag} needs a row of its own linked rows (${t.row_id ?? 'none'})`);
      if (t.tag === 'misconception' && !t.item_no) out.push(`${at}: option ${t.option} misconception needs an item number`);
    }
    if (q.misconception && !q.linked_rows.some((l) => l.row_id === q.misconception!.row_id)) out.push(`${at}: misconception ${q.misconception.row_id} #${q.misconception.item_no} is not on one of its linked rows`);
    if (q.setting && 'new' in q.setting && !settings.has(q.setting.new)) out.push(`${at}: new setting "${q.setting.new}" is not in catalogue_new.settings`);
    if (q.figure_brief !== undefined && q.figure_brief !== null) { const bp = briefProblem(q.figure_brief); if (bp) out.push(`${at}: figure_brief: ${bp}`); }
    if (q.figure && packDir) {
      const f = resolve(packDir, q.figure.file);
      if (!existsSync(f)) out.push(`${at}: figure ${q.figure.file} is missing`);
      else {
        const b = readFileSync(f);
        if (sha256(b) !== q.figure.sha256) out.push(`${at}: figure ${q.figure.file} changed since the pack was made (sha256)`);
        const sz = pngSize(b);
        if (!sz) out.push(`${at}: figure ${q.figure.file} is not a PNG`);
        else if (sz.width < MIN_FIGURE_WIDTH) out.push(`${at}: figure ${q.figure.file} is ${sz.width} px wide; the figure rule needs ≥ ${MIN_FIGURE_WIDTH} px`);
        if (b.length > 50 * 1024 * 1024) out.push(`${at}: figure ${q.figure.file} is over 50 MB`);
      }
    }
  }
  if (p.run.route === 'B') {
    const unchecked = p.questions.filter((q) => q.originality === 'not_checked').map((q) => q.local_id);
    if (unchecked.length) out.push(`route B checks originality on the Mac before writing; not checked: ${unchecked.slice(0, 10).join(', ')}${unchecked.length > 10 ? ', …' : ''}`);
    if (!p.originality) out.push('route B: the pack has no originality block (tool, checked_at, thresholds)');
  }
  if (p.originality?.report_file && packDir) {
    const f = resolve(packDir, p.originality.report_file);
    if (!existsSync(f)) out.push(`originality report ${p.originality.report_file} is missing`);
    else if (p.originality.report_sha256 && sha256(readFileSync(f)) !== p.originality.report_sha256) out.push(`originality report ${p.originality.report_file} changed since the pack was made (sha256)`);
  }
  return out;
}

// ---------------------------------------------------------------- helpers
export const MIN_FIGURE_WIDTH = 1800;   // Math figure rule (18 Nov): PNG ≥ 1800 px wide; same for Science (plan §2.5)
export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export function pngSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
/** The question's content fingerprint: everything that is the question itself (not the review decision, the checks,
 *  the warnings or the originality score). The same item re-sent with the same hash is "unchanged". */
export function contentHash(q: PackQuestion): string {
  // figure_brief is left out: a brief added to a pack later (images:briefs) never makes an imported question "changed"
  const { review: _r, warnings: _w, warning_reason: _wr, checks: _c, passed: _p, originality: _o, figure, figure_brief: _fb, ...rest } = q;
  return sha256(JSON.stringify(canon({ ...rest, figure: figure ? { sha256: figure.sha256 } : null })));
}
/** Published R2 key of a figure: flat, under figures/ (upload-figures and /api/files accept only figures/<name>.png). */
export const figureKey = (runCode: string, localId: string) => `figures/${runCode}-${localId}.png`;

// ---------------------------------------------------------------- the Mac review pack (pilot approvals)
export interface ReviewDecisions { sha256: string; decisions: Map<string, { decision: Decision; comment: string | null; sheet: string }> }
const DECISION: Record<string, Decision> = { approve: 'approve', approved: 'approve', fix: 'fix', drop: 'drop', rescue: 'rescue' };
/** Reads "Decision (…)" + "Comment" by "Slot" from the Questions and Failed checks tabs (header in row 1). */
export async function readReviewPack(path: string): Promise<ReviewDecisions> {
  const w = await readRaw(path);
  const decisions: ReviewDecisions['decisions'] = new Map();
  for (const sheet of ['Questions', 'Failed checks']) {
    const rows = w.sheets.get(sheet);
    if (!rows?.length) continue;
    const head = rows[0]!.map((c) => String(c ?? '').trim());
    const iSlot = head.findIndex((h) => /^slot$/i.test(h)), iDec = head.findIndex((h) => /^decision\b/i.test(h)), iCom = head.findIndex((h) => /^comment$/i.test(h));
    if (iSlot < 0 || iDec < 0) throw new Error(`${path}: tab "${sheet}" has no Slot / Decision column`);
    for (const r of rows.slice(1)) {
      const slot = str(r[iSlot]); if (!slot) continue;
      const raw = str(r[iDec]);
      const d = raw ? DECISION[raw.toLowerCase().split(/[\s(/:]/)[0]!] : null;
      if (raw && d === undefined) throw new Error(`${path}: ${sheet} ${slot}: decision "${raw}" is not Approve / Fix / Drop / Rescue`);
      decisions.set(slot, { decision: d ?? null, comment: iCom >= 0 ? str(r[iCom]) : null, sheet });
    }
  }
  return { sha256: w.sha256, decisions };
}
const str = (c: Cell | undefined) => (c === null || c === undefined || String(c).trim() === '' ? null : String(c).trim());

// ---------------------------------------------------------------- what to import
export type Mode = 'pilot' | 'steady';
export type DropStatus = 'dropped_near_copy' | 'dropped_review' | 'dropped_checks';
export interface Planned { q: PackQuestion; hash: string; drop: { status: DropStatus; reason: string } | null }
export function planItems(pack: Pack, mode: Mode, review: ReviewDecisions | null): Planned[] {
  return [...pack.questions].sort((a, b) => a.local_id.localeCompare(b.local_id)).map((q0) => {
    const r = review?.decisions.get(q0.local_id);
    const q: PackQuestion = r ? { ...q0, review: { decision: r.decision, comment: r.comment } } : q0;
    const d = q.review?.decision ?? null;
    const o = q.originality;
    const drop = (status: DropStatus, reason: string): Planned => ({ q, hash: contentHash(q), drop: { status, reason } });
    if (o !== 'not_checked' && o.result === 'near_copy') return drop('dropped_near_copy', `near-copy (${o.field ?? 'text'} ${o.similarity}, closest ${o.closest_ref ?? '?'}); never stored`);
    if (d === 'drop') return drop('dropped_review', 'Mac review: Drop');
    if (!q.passed && d !== 'rescue') return drop('dropped_checks', `failed the engine's checks${q.warning_reason ? ` (${q.warning_reason})` : ''}`);
    if (mode === 'pilot' && d !== 'approve' && d !== 'rescue') return drop('dropped_review', d === 'fix' ? 'Mac review: Fix (not imported until approved)' : 'not approved in the Mac review pack yet');
    return { q, hash: contentHash(q), drop: null };
  });
}

/** The item as the database function takes it: run-level originality details merged in, the figure as its R2 key. */
export function dbItem(pack: Pack, q: PackQuestion, runCode: string): Record<string, unknown> {
  const { figure, originality, ...rest } = q;
  const o = pack.originality;
  return {
    ...rest,
    figure: figure ? { key: figureKey(runCode, q.local_id), sha256: figure.sha256 } : null,
    originality: originality === 'not_checked' ? 'not_checked'
      : { ...originality, checked_at: o?.checked_at ?? null, tool: o?.tool ?? null, threshold: o?.threshold ?? null, near_copy_threshold: o?.near_copy_threshold ?? null,
          checked: o?.read ?? [], missing: o?.missing ?? [] },
  };
}

// ---------------------------------------------------------------- figures (uploaded before the batch that references them)
export interface FigureStore {
  /** Make sure `key` holds exactly these bytes (upload if absent or different), then verify. Throws if it can't. */
  ensure(key: string, bytes: Buffer): Promise<'present' | 'uploaded'>;
}

// ---------------------------------------------------------------- the import
export interface ImportOptions {
  packPath: string; pack: Pack; mode: Mode; review: ReviewDecisions | null; dryRun: boolean;
  batchSize: number; runUnit: UnitRunner; figures: FigureStore; gitCommit?: string | null;
  log?: (s: string) => void;
  /** dry run: one transaction for everything, always rolled back */
  dryRunSql?: Sql;
}
export interface ItemResult { local_id: string; status: string; question_id?: string; held_id?: string; file_key?: string; level?: number; link_proposed?: string | null; reason?: string; error?: string; was?: string }
export interface ImportResult {
  run_code: string; run_id: number; import_id: number; created: boolean; mode: Mode; settings: Record<string, string>; shared: Record<string, string>;
  links_proposed: string[]; setting_use: { existing: number; new: number; bare: number; new_settings: number; existing_settings: number };
  items: ItemResult[]; counts: Record<string, number>; figures: { uploaded: number; present: number }; /** Images PR */ briefs: { set: number; unchanged: number; skipped: number }; closed: { status: string; items: Record<string, number> } | null;
  changed: string[]; dry_run: boolean;
}
class DryRollback extends Error { constructor(public result: ImportResult) { super('dry run: rolled back'); } }

export async function runPackImport(o: ImportOptions): Promise<ImportResult> {
  const log = o.log ?? (() => {});
  const { pack } = o;
  const planned = planItems(pack, o.mode, o.review);
  const classes = [...new Set(pack.questions.map((q) => String(q.class)))].sort();
  const openPayload = {
    subject: pack.run.subject, route: pack.run.route, source_run: pack.run.source_run, mode: o.mode, classes,
    engine_version: [pack.run.engine, pack.run.engine_version].filter(Boolean).join(' ') || null, prompt_hashes: pack.run.prompt_hashes ?? {},
    models: pack.run.models ?? {}, model: pack.run.models?.writer ?? null, cms_commit: pack.run.cms_commit ?? null, snapshot_id: pack.run.snapshot_id ?? null,
    rule_version: pack.run.rule_version ?? null, topics: pack.run.topics ?? [...new Set(pack.questions.map((q) => q.topic_id))].sort(),
    pack_sha256: sha256(readFileSync(o.packPath)), review_sha256: o.review?.sha256 ?? null, cost: pack.run.cost_usd ?? null, cost_detail: pack.run.cost_detail ?? {},
    tokens_in: pack.run.tokens_in ?? null, tokens_out: pack.run.tokens_out ?? null,
    settings: pack.catalogue_new?.settings ?? [],
    share_settings: [...new Set(pack.questions.flatMap((q) => (q.setting && 'setting_id' in q.setting ? [q.setting.setting_id] : [])))].sort(),
    import: { file_path: o.packPath.replace(process.env.HOME ?? '~', '~'), git_commit: o.gitCommit ?? null, file_hash: sha256(readFileSync(o.packPath)),
              options: { mode: o.mode, dry_run: o.dryRun, review_sha256: o.review?.sha256 ?? null, batch_size: o.batchSize } },
  };
  const body = async (unit: UnitRunner) => {
    const [opened] = await unit('open run', (sql) => sql<{ r: { run_id: number; run_code: string; import_id: number; created: boolean; settings: Record<string, string>; shared: Record<string, string> } }[]>`
      select cms.cms_gen_open_run(${sql.json(openPayload as never)}) as r`);
    const run = opened!.r;
    log(`${run.created ? 'Opened' : 'Continuing'} run ${run.run_code} (${pack.run.source_run}, ${o.mode}) · import #${run.import_id}`);
    const imported = planned.filter((p) => !p.drop).map((p) => p.q);
    const setting_use = { existing: imported.filter((q) => q.setting && 'setting_id' in q.setting).length, new: imported.filter((q) => q.setting && 'new' in q.setting).length,
      bare: imported.filter((q) => !q.setting).length, new_settings: new Set(imported.flatMap((q) => (q.setting && 'new' in q.setting ? [q.setting.new] : []))).size,
      existing_settings: new Set(imported.flatMap((q) => (q.setting && 'setting_id' in q.setting ? [q.setting.setting_id] : []))).size };
    const res: ImportResult = { run_code: run.run_code, run_id: Number(run.run_id), import_id: Number(run.import_id), created: run.created, mode: o.mode, settings: run.settings,
      shared: run.shared ?? {}, links_proposed: [], setting_use,
      items: [], counts: {}, figures: { uploaded: 0, present: 0 }, briefs: { set: 0, unchanged: 0, skipped: 0 }, closed: null, changed: [], dry_run: o.dryRun };
    const dir = dirname(o.packPath);
    for (let i = 0; i < planned.length; i += o.batchSize) {
      const chunk = planned.slice(i, i + o.batchSize);
      const batchNo = i / o.batchSize + 1;
      // figures first: a batch never references a file that is not in R2
      if (!o.dryRun) for (const p of chunk) {
        if (p.drop || !p.q.figure) continue;
        const r = await o.figures.ensure(figureKey(run.run_code, p.q.local_id), readFileSync(resolve(dir, p.q.figure.file)));
        res.figures[r]++;
      }
      const items = chunk.map((p) => p.drop
        ? { local_id: p.q.local_id, content_hash: p.hash, drop: p.drop, item: { warnings: p.q.warnings ?? [], warning_reason: p.q.warning_reason ?? null, checks: p.q.checks ?? {}, review: p.q.review ?? null } }
        : { local_id: p.q.local_id, content_hash: p.hash, item: dbItem(pack, p.q, run.run_code) });
      const [b] = await unit(`batch ${batchNo}`, (sql) => sql<{ r: { items: ItemResult[] } }[]>`
        select cms.cms_gen_import_batch(${sql.json({ run_code: run.run_code, import_id: run.import_id, batch_no: batchNo, items } as never)}) as r`);
      for (const it of b!.r.items) {
        res.items.push(it); res.counts[it.status] = (res.counts[it.status] ?? 0) + 1;
        if (it.status === 'changed') res.changed.push(it.local_id);
        if (it.link_proposed && !res.links_proposed.includes(it.link_proposed)) res.links_proposed.push(it.link_proposed);
      }
      log(`  batch ${batchNo}: ${fmtCounts(b!.r.items.reduce((m: Record<string, number>, x) => (m[x.status] = (m[x.status] ?? 0) + 1, m), {}))}`);
      // Images PR: structured briefs of this batch's imported questions (idempotent; never on a question someone approved)
      const briefs = chunk.filter((p) => !p.drop && p.q.figure_brief && b!.r.items.some((x) => x.local_id === p.q.local_id && ['imported', 'unchanged'].includes(x.status)))
        .map((p) => ({ local_id: p.q.local_id, brief: p.q.figure_brief }));
      if (briefs.length) {
        const [s2] = await unit(`briefs ${batchNo}`, (sql) => sql<{ r: { set: number; unchanged: number; skipped: unknown[] } }[]>`
          select cms.cms_gen_set_briefs(${sql.json({ run_code: run.run_code, briefs } as never)}) as r`);
        res.briefs.set += s2!.r.set; res.briefs.unchanged += s2!.r.unchanged; res.briefs.skipped += s2!.r.skipped.length;
      }
    }
    const [c] = await unit('close run', (sql) => sql<{ r: { status: string; items: Record<string, number> } }[]>`
      select cms.cms_gen_close_run(${sql.json({ run_code: run.run_code, import_id: run.import_id, counts: { this_pass: res.counts, figures: res.figures },
        error_report: res.items.filter((x) => ['failed', 'changed'].includes(x.status)).map((x) => ({ local_id: x.local_id, status: x.status, why: x.error ?? 'imported earlier with different content' })) } as never)}) as r`);
    res.closed = c!.r;
    return res;
  };
  if (!o.dryRun) return body(o.runUnit);
  if (!o.dryRunSql) throw new Error('dry run needs dryRunSql');
  try {
    await o.dryRunSql.begin(async (tx) => { const r = await body(async (_l, fn) => fn(tx as unknown as Sql)); throw new DryRollback(r); });
  } catch (e) { if (e instanceof DryRollback) return e.result; throw e; }
  throw new Error('unreachable');
}
const fmtCounts = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${v} ${k}`).join(' · ');

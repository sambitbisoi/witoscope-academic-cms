// Q38 PR 1: a Science PILOT04-style run folder (ContentResearch/Science/generation/runs/<RUN>/) → generation-pack/1.
// Reads only our own generated content and the run's bookkeeping: questions_checked.json, originality.json (citations
// and scores), run_meta.json, calls.jsonl (tokens and cost), figures/. Never reads book material.
// Gap table: docs/plan-2026-11-23-q38-direct-generation.md §2.4.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { idList, storedFormat, yn } from '../../../shared/science.ts';
import { pngSize, sha256, type Pack, type PackQuestion, type Role } from '../gen-pack.ts';

type Rec = Record<string, unknown>;
const s = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const n = (v: unknown): number | null => { const x = s(v); return x === null || !/^-?\d+$/.test(x) ? null : Number(x); };

/** "A: misconception:C2-DLV-003 #1; C: untagged; D: concept_error:C1-DPL-010; B: partial" → tags (untagged left out). */
export function parseWrongTags(v: unknown): { tags: NonNullable<PackQuestion['wrong_option_tags']>; problems: string[] } {
  const tags: NonNullable<PackQuestion['wrong_option_tags']> = [], problems: string[] = [];
  for (const part of (s(v) ?? '').split(/;\s*/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^([A-D])\s*:\s*([a-z_]+)\s*(?::\s*(.+))?$/.exec(part);
    if (!m) { problems.push(`wrong-option tag "${part}" is not "<option>: <tag>[:<ref>]"`); continue; }
    const [, option, tag, ref] = m as unknown as [string, 'A' | 'B' | 'C' | 'D', string, string | undefined];
    if (tag === 'untagged') continue;
    if (tag === 'misconception') {
      const r = /^(\S+)\s*#(\d+)$/.exec(ref ?? '');
      if (!r) { problems.push(`option ${option}: misconception "${ref ?? ''}" is not "<row> #n"`); continue; }
      tags.push({ option, tag, row_id: r[1]!, item_no: Number(r[2]) });
    } else if (tag === 'concept_error') tags.push({ option, tag, row_id: s(ref), item_no: null });
    else tags.push({ option, tag, row_id: null, item_no: null });
  }
  return { tags, problems };
}

/** "C2-DLV-003 #1" → {row_id, item_no}; blank → null. */
export function parseItemRef(v: unknown): { row_id: string; item_no: number } | null | undefined {
  const x = s(v); if (!x) return null;
  const m = /^(\S+)\s*#(\d+)$/.exec(x);
  return m ? { row_id: m[1]!, item_no: Number(m[2]) } : undefined;
}

/** Primary / Secondary / Supporting strings → linked rows with roles; a row named twice keeps its strongest role. */
export function linkedRows(r: Rec): { row_id: string; role: Role }[] {
  const out: { row_id: string; role: Role }[] = [];
  for (const [col, role] of [['Primary row', 'primary'], ['Secondary rows', 'secondary'], ['Supporting rows', 'supporting']] as const) {
    for (const id of idList(r[col])) if (!out.some((x) => x.row_id === id)) out.push({ row_id: id, role });
  }
  return out;
}

export const settingSlug = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'setting';

export interface AdapterResult { pack: Pack; problems: string[] }
export function pilotToPack(runDir: string): AdapterResult {
  const read = (f: string) => JSON.parse(readFileSync(join(runDir, f), 'utf8'));
  const problems: string[] = [];
  const recs = read('questions_checked.json') as Rec[];
  const meta = existsSync(join(runDir, 'run_meta.json')) ? read('run_meta.json') as Rec : {};
  const origPath = join(runDir, 'originality.json');
  const orig = existsSync(origPath) ? JSON.parse(readFileSync(origPath, 'utf8')) as Rec : null;
  const origByKey = new Map(((orig?.questions ?? []) as Rec[]).map((q) => [String(q.key), q]));
  // tokens and cost from the call log; the model of each stage from the call tags (gen:, tag:, solve:, qc:, …)
  const calls = existsSync(join(runDir, 'calls.jsonl'))
    ? readFileSync(join(runDir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec) : [];
  const stageOf: Record<string, string> = { gen: 'writer', tag: 'tagger', solve: 'solver', qc: 'quality', qc2: 'quality', qcc: 'quality_crosscheck', qcc2: 'quality_crosscheck',
    repair: 'repair', fig: 'figures', figcheck: 'figure_check' };
  const models: Record<string, string> = {};
  const cost: Record<string, number> = {};
  let tin = 0, tout = 0, total = 0;
  for (const c of calls) {
    const stage = stageOf[String(c.tag ?? '').split(':')[0]!] ?? 'other';
    if (c.model && stage !== 'other') models[stage] = String(c.model);
    const usd = Number(c.cost_usd ?? 0); total += usd; cost[stage] = Math.round(((cost[stage] ?? 0) + usd) * 1e6) / 1e6;
    tin += Number(c.input_tokens ?? 0) + Number(c.cache_read_input_tokens ?? 0) + Number(c.cache_creation_input_tokens ?? 0); tout += Number(c.output_tokens ?? 0);
  }
  const fileSha = (p: string) => (existsSync(p) ? sha256(readFileSync(p)).slice(0, 16) : null);
  const engineScript = join(runDir, '..', '..', 'scripts', 'run_pilot04.py');
  const settings = new Map<string, { local_id: string; name: string }>();
  const settingFor = (name: string) => {
    const key = name.toLowerCase();
    if (!settings.has(key)) {
      let id = settingSlug(name), i = 2;
      while ([...settings.values()].some((x) => x.local_id === id)) id = `${settingSlug(name).slice(0, 56)}-${i++}`;
      settings.set(key, { local_id: id, name });
    }
    return settings.get(key)!.local_id;
  };

  const questions: PackQuestion[] = [];
  for (const r of recs) {
    const lid = String(r.Slot);
    const at = (m: string) => problems.push(`${lid}: ${m}`);
    const opts = ['Option A', 'Option B', 'Option C', 'Option D'].map((k) => s(r[k])).filter((x): x is string => x !== null);
    let format: PackQuestion['format'];
    try { const f = storedFormat(String(r.Format ?? ''), opts); format = f === 'Typed-time' ? 'MCQ-4' : f; if (f === 'Typed-time') at('Typed-time is not a pack format'); }
    catch (e) { at((e as Error).message); format = 'MCQ-4'; }
    if (format === 'MCQ-4' && opts.length === 3) format = 'MCQ-3';
    const wt = parseWrongTags(r['Wrong-option tags']); for (const p of wt.problems) at(p);
    const mis = parseItemRef(r['Misconception targeted']); if (mis === undefined) at(`misconception "${s(r['Misconception targeted'])}" is not "<row> #n"`);
    const settingText = s(r.Setting);
    const bare = !settingText || settingText === '(blank)' || s(r['Setting familiarity']) === 'Bare';
    const figFile = s(r._figure_file);
    let figure: PackQuestion['figure'] = null;
    if (figFile) {
      const p = join(runDir, figFile);
      if (!existsSync(p)) at(`figure ${figFile} is missing`);
      else {
        const b = readFileSync(p); const sz = pngSize(b);
        const svg = figFile.replace(/\.png$/, '.svg');
        const altP = join(runDir, figFile.replace(/\.png$/, '.alt.json'));
        const alt = existsSync(altP) ? s((JSON.parse(readFileSync(altP, 'utf8')) as Rec).alt) : null;
        figure = { file: figFile, sha256: sha256(b), width: sz?.width, height: sz?.height, svg: existsSync(join(runDir, svg)) ? svg : null, alt };
      }
    }
    const o = origByKey.get(lid);
    const warnList = Array.isArray(r._warn_list) ? (r._warn_list as unknown[][]).map((w) => ({ kind: String(w[0]), reason: String(w[1] ?? w[0]) })) : [];
    const keep = (k: string) => s(r[k]);
    questions.push({
      // class = the class the question is for (Grade); level = its primary row's class (DL-011; the CMS takes it from the row itself)
      local_id: lid, subject: 'science', topic_id: String(r.Topic), class: Number(r.Grade ?? r.Level), level: n(r['Primary row class']),
      format, display_format: s(r.Format), text: String(r.Question ?? '').trim(), options: opts, answer: String(r.Answer ?? '').trim() as PackQuestion['answer'],
      solution_1: String(r['Solution 1'] ?? '').trim(), solution_2: null,
      figure_needed: s(r._figure_kind) !== null && s(r._figure_kind) !== 'none', figure_description: s(r._figure_description), figure,
      linked_rows: linkedRows(r), misconception: mis ?? null, wrong_option_tags: wt.tags,
      science_question_type: n(r['Science question type']),
      setting: bare ? null : { new: settingFor(settingText!) },
      setting_note: bare ? null : settingText,   // the scene stays on the question (DL-007); --settings-map maps it to a SET
      setting_familiarity: s(r['Setting familiarity']), hidden_idea: yn(r['Hidden idea']), experiment: yn(r.Experiment),
      drivers: { reading: n(r['Reading (1-5)']), steps: n(r.Steps), inhibition: n(r['Inhibition (0-3)']), visual: n(r['Visual (0-3)']), irrelevant_info: yn(r['Irrelevant info']) },
      safety_note: null, author_notes: null,
      passed: r._passed === true, warnings: warnList, warning_reason: s(r['Warning reason']),
      checks: Object.fromEntries(Object.entries({
        blind_solve: keep('Blind solve'), rule_checks: keep('Rule checks'), quality: keep('_quality'), repair: keep('_repair_outcome'), claude_note: keep('Claude note'),
        safety_rows: keep('Safety rows linked'), same_row_type_elsewhere: keep('Same row + type elsewhere'), type_name: keep('Type name'),
        engine_rows: { primary: keep('Primary row'), secondary: keep('Secondary rows'), supporting: keep('Supporting rows') },
        derived: { tier: keep('Tier (derived)'), load: keep('Load (derived)'), markers: keep('Markers (derived)'), trap_level: keep('Trap level (derived)'), clone_group: keep('Clone group key (derived)') },
        errors: Array.isArray(r._errors) && r._errors.length ? r._errors : undefined,
      }).filter(([, v]) => v !== null && v !== undefined)),
      originality: o ? { result: o.result as 'clear', similarity: Number(o.similarity), same_numbers: (o.same_numbers as boolean | null) ?? null, closest_ref: s(o.closest_ref), field: s(o.field) } : 'not_checked',
      review: null,
    });
  }
  const pack: Pack = {
    file_schema: 'generation-pack/1',
    run: {
      source_run: String(meta.run ?? basename(runDir)), subject: 'science', route: 'B', engine: 'science-pilot04 (Python)',
      engine_version: fileSha(engineScript) ? `run_pilot04.py@${fileSha(engineScript)}` : undefined,
      prompt_hashes: Object.fromEntries([['writer', fileSha(join(runDir, 'writer_rules.txt'))], ['tagger', fileSha(join(runDir, 'step3', 'system_prompt.txt'))]].filter(([, v]) => v)) as Record<string, string>,
      models, cms_commit: s((meta.cms_code as Rec | undefined)?.cms_repo_head), snapshot_id: [s(meta.snapshot), s(meta.snapshot_read_at)].filter(Boolean).join(' @ ') || null,
      rule_version: 'v11', topics: Array.isArray(meta.topics) ? (meta.topics as string[]) : [...new Set(questions.map((q) => q.topic_id))],
      cost_usd: Math.round(total * 100) / 100, cost_detail: { by_stage: cost, calls: calls.length, cap_usd: meta.cap_usd ?? null }, tokens_in: tin, tokens_out: tout,
      created_at: s(meta.started),
    },
    originality: orig ? { tool: String(orig.tool), checked_at: String(orig.checked_at), threshold: Number(orig.threshold), near_copy_threshold: Number(orig.near_copy_threshold),
      read: (orig.read as string[]) ?? [], missing: (orig.missing as string[]) ?? [], report_file: 'originality.json', report_sha256: sha256(readFileSync(origPath)) } : null,
    catalogue_new: { settings: [...settings.values()].map((x) => ({ local_id: x.local_id, name: x.name, description: null })) },
    questions,
  };
  return { pack, problems };
}

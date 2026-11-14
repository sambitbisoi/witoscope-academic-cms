// import:science (Sambit, 13 Nov 2026; docs/science-plan.md). Upserts the Science master into the CMS in ONE
// transaction (a dry run rolls it back):
//   sources (one per book PDF) · content rows (audited, never deleted; rows gone from the master are flagged)
//   · their citations · PROPOSED topic–class links · the questions (Needs review · Import, attributes pending)
//   with their content-row links, citations and originality results.
// Originality (Sambit, 13 Nov 2026): a content row at near-copy (≥ 0.85) is held out of the REAL import unless
// override_requests.csv lists that row and field; on the LOCAL database it is imported with an "Originality
// flagged" badge. A near-copy question is blocked (as for Math) unless the CSV lists it, then it comes in as a
// draft with a pending override request.
import type postgres from 'postgres';
import { classMismatch, extraRole } from '../../shared/science.ts';
import type { Sql } from './db.ts';
import type { AlsoInProblem, Master, MasterQuestion, MasterRow } from './science-master.ts';
import { rowHash } from './science-master.ts';
import type { ScienceCheck, ScienceReport } from './science-originality.ts';
import { SCIENCE_REPORT_SCHEMA } from './science-originality.ts';
import { parseCsv } from './updates.ts';

export type Target = 'local' | 'real';
export interface ScienceOptions { dryRun: boolean; target: Target; overrides?: Map<string, string>; byLabel?: string; /** run inside the caller's transaction (tests) */ inTx?: postgres.TransactionSql }
export interface Proposal { topic_id: string; name: string; home_class: number; row_class: number; role: 'lower' | 'higher'; rows: number; isNew: boolean }
export interface ScienceResult {
  import_id: number | null; dry_run: boolean; target: Target;
  sources: { inserted: number; updated: number; unchanged: number };
  rows: { inserted: number; updated: number; unchanged: number; flagged_missing: number; back_in_master: number; held_out: string[]; near_copy_badged: string[]; overridden: string[] };
  citations: { rows: number; questions: number };
  proposals: Proposal[];
  questions: { created: string[]; replaced: string[]; unchanged: number; skipped: { qid: string; why: string }[]; blocked: { qid: string; why: string }[]; not_in_master: string[] };
  links: { direct: number; supporting: number };
  originality: { rows: Record<string, number>; questions: Record<string, number> };
  status_mismatch: { row_id: string; sheet: string; cms: string }[];
  /** class information (0033): Notes "Also in C<n>: …" parsed strictly; IDs not in the CMS are dropped and listed */
  also_in: { rows_with_ids: number; ids_parsed: number; ids_kept: number; unparsed: AlsoInProblem[]; unknown: { row_id: string; id: string }[] };
  /** rows whose "Topic class (mapped)" differs from the topic's approved classes (home + active links); shown, never changed */
  class_mismatch: { row_id: string; topic_id: string; mapped: string; approved: number[]; only_master: number[]; only_cms: number[] }[];
  problems: string[];
}

/** override_requests.csv rows for Science: file_key = content Row ID or Q ID, field, reason. */
export function scienceOverrides(text: string): { map: Map<string, string>; problems: string[] } {
  const csv = parseCsv(text); const map = new Map<string, string>(); const problems: string[] = [];
  for (const { line, values: v } of csv.rows) {
    if (!v.file_key || !v.field) { problems.push(`line ${line}: file_key and field are needed`); continue; }
    if (!v.reason || v.reason.length < 10) { problems.push(`line ${line}: ${v.file_key} needs a reason`); continue; }
    map.set(`${v.file_key}|${v.field}`, v.reason);
  }
  return { map, problems };
}

/** The near-copy fields of a check, and whether the override list covers every one of them. */
export function nearCopyCover(c: ScienceCheck | undefined, overrides: Map<string, string> | undefined) {
  if (!c || c.result !== 'near_copy') return { near: false, covered: false, reasons: [] as string[], fields: [] as string[] };
  const fields = (c.fields ?? []).filter((f) => f.result === 'near_copy').map((f) => f.field);
  const list = fields.length ? fields : c.field ? [c.field] : [];
  const reasons = list.map((f) => overrides?.get(`${c.key}|${f}`)).filter((x): x is string => !!x);
  return { near: true, covered: list.length > 0 && reasons.length === list.length, reasons, fields: list };
}

/** Equal as stored: numeric columns come back as text ("0.40"), so numbers compare as numbers. */
export const sameValue = (a: unknown, b: unknown) => {
  const blank = (x: unknown) => x === null || x === undefined || x === '';
  if (blank(a) || blank(b)) return blank(a) && blank(b);
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
};

class Rollback extends Error { constructor(readonly result: ScienceResult) { super('dry run'); } }

const ROW_COLS = ['topic_id', 'chapter_id', 'row_class', 'type', 'chapter_role', 'content', 'why_it_matters', 'misconceptions', 'diagram_description', 'picture_question',
  'question_use', 'safety', 'source', 'found_in', 'confidence', 'notes', 'time_sensitive', 'time_checked_year', 'accuracy_flag', 'master_file', 'book', 'book_chapter_no',
  'book_chapter_title', 'appears_in', 'sort', 'topic_classes_mapped', 'topic_taught_in', 'revisit', 'also_in_rows', 'originality_result', 'originality_field', 'originality_score', 'originality_ref', 'originality_override'] as const;

export async function runScience(sql: Sql, master: Master, report: ScienceReport | null, opts: ScienceOptions): Promise<ScienceResult> {
  const res: ScienceResult = {
    import_id: null, dry_run: opts.dryRun, target: opts.target, sources: { inserted: 0, updated: 0, unchanged: 0 },
    rows: { inserted: 0, updated: 0, unchanged: 0, flagged_missing: 0, back_in_master: 0, held_out: [], near_copy_badged: [], overridden: [] },
    citations: { rows: 0, questions: 0 }, proposals: [], questions: { created: [], replaced: [], unchanged: 0, skipped: [], blocked: [], not_in_master: [] },
    links: { direct: 0, supporting: 0 }, originality: { rows: {}, questions: {} }, status_mismatch: [],
    also_in: { rows_with_ids: 0, ids_parsed: 0, ids_kept: 0, unparsed: [...(master.also_in_unparsed ?? [])], unknown: [] }, class_mismatch: [], problems: [],
  };
  const errors = master.problems.filter((p) => p.level === 'error');
  if (errors.length) throw new Error(`the master has ${errors.length} error(s), e.g. ${errors[0]!.where}: ${errors[0]!.message}`);
  if (!report) throw new Error('no originality report: run npm run check:originality -- --science <master> on this Mac first');
  if (report.file_schema !== SCIENCE_REPORT_SCHEMA) throw new Error(`the originality report is not ${SCIENCE_REPORT_SCHEMA}; re-run the check`);
  if (report.master_sha256 !== master.sha256) throw new Error('the originality report was made for another version of the master; re-run npm run check:originality -- --science');
  const rowCheck = new Map(report.rows.map((r) => [r.key, r]));
  const qCheck = new Map(report.questions.map((r) => [r.key, r]));
  for (const r of master.rows) if (!rowCheck.has(r.row_id)) throw new Error(`the originality report has no result for ${r.row_id}; re-run the check`);
  for (const q of master.questions) if (!qCheck.has(q.qid)) throw new Error(`the originality report has no result for ${q.qid}; re-run the check`);
  const tally = (xs: ScienceCheck[]) => Object.fromEntries(['clear', 'flagged', 'near_copy', 'no_sources'].map((k) => [k, xs.filter((x) => x.result === k).length]));
  res.originality = { rows: tally(report.rows), questions: tally(report.questions) };
  const by = opts.byLabel ?? 'import:science';

  try {
    const body = async (tx: postgres.TransactionSql) => {
      // ------------------------------------------------ checks against the CMS
      const topics = new Map((await tx<{ topic_id: string; chapter_id: string; class: number; name: string; status: string }[]>`
        select topic_id, chapter_id, class, name, status from cms.cms_topics where topic_id like 'ST%'`).map((t) => [t.topic_id, t]));
      const bad: string[] = [];
      for (const r of master.rows) {
        const t = topics.get(r.topic_id);
        if (!t) bad.push(`${r.row_id}: topic ${r.topic_id} is not in the CMS`);
        else if (t.chapter_id !== r.chapter_id) bad.push(`${r.row_id}: topic ${r.topic_id} is in chapter ${t.chapter_id} in the CMS, ${r.chapter_id} in the master`);
      }
      for (const q of master.questions) if (!topics.has(q.topic_id)) bad.push(`${q.qid}: topic ${q.topic_id} is not in the CMS`);
      if (bad.length) throw new Error(`${bad.length} problem(s) against the CMS, e.g. ${bad.slice(0, 5).join('; ')}`);

      const [imp] = await tx`insert into cms.cms_imports (kind, file_path, file_hash, options, counts)
        values ('science', ${master.path.replace(process.env.HOME ?? '~', '~')}, ${master.sha256}, ${tx.json({ target: opts.target, dry_run: opts.dryRun, tool: report.tool } as never)}, '{}')
        returning import_id`;
      const importId = Number(imp!.import_id);
      res.import_id = importId;

      // ------------------------------------------------ sources (one per book PDF) and the chapters they cover
      const existingSources = new Map((await tx`select source_id, kind, title, publisher, class, page_offset from cms.cms_sources where source_id = any(${master.sources.map((s) => s.source_id)})`).map((s) => [s.source_id as string, s]));
      for (const s of master.sources) {
        const row = { source_id: s.source_id, kind: s.kind, title: s.title, publisher: s.publisher, class: s.class, page_offset: s.page_offset };
        const ex = existingSources.get(s.source_id);
        if (!ex) { await tx`insert into cms.cms_sources ${tx(row)}`; res.sources.inserted++; continue; }
        const diff = Object.fromEntries((['kind', 'title', 'publisher', 'class', 'page_offset'] as const).filter((k) => ex[k] !== row[k]).map((k) => [k, { before: ex[k], after: row[k] }]));
        if (!Object.keys(diff).length) { res.sources.unchanged++; continue; }
        await tx`update cms.cms_sources set ${tx(row, 'kind', 'title', 'publisher', 'class', 'page_offset')} where source_id = ${s.source_id}`;
        await tx`insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, import_id, reason)
          values ('catalogue', 'cms_sources', ${s.source_id}, 'edit_catalogue', ${tx.json(diff as never)}, ${by}, ${importId}, 'Science master (Legend)')`;
        res.sources.updated++;
      }
      const sc = new Set<string>();
      for (const r of master.rows) for (const c of r.citations) sc.add(`${c.source_id}|${r.chapter_id}`);
      for (const k of sc) { const [s, ch] = k.split('|'); await tx`insert into cms.cms_source_chapters (source_id, chapter_id) values (${s!}, ${ch!}) on conflict do nothing`; }

      // ------------------------------------------------ content rows
      const held = new Set<string>();
      const existing = new Map((await tx`select * from cms.cms_content_rows`).map((r) => [r.row_id as string, r]));
      // "Also in" IDs are kept only for rows that exist after this import (in the CMS already, or coming in now)
      const willHold = (r: MasterRow) => { const cov = nearCopyCover(rowCheck.get(r.row_id), opts.overrides); return opts.target === 'real' && cov.near && !cov.covered; };
      const knownIds = new Set([...existing.keys(), ...master.rows.filter((r) => !willHold(r)).map((r) => r.row_id)]);
      const alsoIn = new Map<string, string[]>();
      for (const r of master.rows) {
        if (r.also_in_rows.length) { res.also_in.rows_with_ids++; res.also_in.ids_parsed += r.also_in_rows.length; }
        for (const id of r.also_in_rows) if (!knownIds.has(id)) res.also_in.unknown.push({ row_id: r.row_id, id });
        const kept = r.also_in_rows.filter((id) => knownIds.has(id));
        res.also_in.ids_kept += kept.length;
        alsoIn.set(r.row_id, kept);
      }
      const dbRow = (r: MasterRow) => {
        const c = rowCheck.get(r.row_id)!;
        const cov = nearCopyCover(c, opts.overrides);
        const { citations: _c, sheet: _s, sheet_status: _ss, ...all } = r;
        const rest = { ...all, also_in_rows: alsoIn.get(r.row_id) ?? [] };
        return {
          row: {
            row_id: r.row_id, ...Object.fromEntries(ROW_COLS.filter((k) => k in rest).map((k) => [k, (rest as Record<string, unknown>)[k]])),
            originality_result: c.result, originality_field: c.field ?? null, originality_score: c.similarity, originality_ref: c.closest_ref,
            originality_override: cov.covered ? cov.reasons.join(' · ') : null, content_hash: rowHash({ ...rest, citations: r.citations }),
          } as Record<string, unknown>, cov,
        };
      };
      const fresh: Record<string, unknown>[] = [];
      const changed: { r: MasterRow; row: Record<string, unknown>; before: Record<string, unknown> }[] = [];
      for (const r of master.rows) {
        const { row, cov } = dbRow(r);
        if (cov.near && !cov.covered) {
          if (opts.target === 'real') { held.add(r.row_id); res.rows.held_out.push(r.row_id); continue; }
          res.rows.near_copy_badged.push(r.row_id);
        }
        if (cov.near && cov.covered) res.rows.overridden.push(r.row_id);
        const before = existing.get(r.row_id);
        if (!before) { fresh.push({ ...row, import_id: importId }); continue; }
        const same = before.content_hash === row.content_hash && before.in_master && ROW_COLS.every((k) => sameValue(before[k], row[k]));
        if (same) { res.rows.unchanged++; continue; }
        changed.push({ r, row, before });
      }
      for (let i = 0; i < fresh.length; i += 400) await tx`insert into cms.cms_content_rows ${tx(fresh.slice(i, i + 400) as never[])}`;
      res.rows.inserted = fresh.length;
      if (fresh.length) {
        for (let i = 0; i < fresh.length; i += 500) {
          await tx`insert into cms.cms_reviews ${tx(fresh.slice(i, i + 500).map((r) => ({ target: 'catalogue', target_table: 'cms_content_rows', target_id: r.row_id as string, action: 'create',
            reason: 'from the Science master', field_diff: tx.json({ topic_id: { before: null, after: r.topic_id }, originality: { before: null, after: r.originality_result } } as never), by_label: by, import_id: importId })) as never[])}`;
        }
      }
      // a changed row's citations are rewritten only when they really differ (never deleted just because another field changed)
      const citeKey = (c: { source_id: string; page_from: number; page_to: number; raw: string }) => `${c.source_id}|${c.page_from}|${c.page_to}|${c.raw}`;
      const oldCites = new Map<string, string[]>();
      if (changed.length) {
        for (const c of await tx<{ row_id: string; source_id: string; page_from: number; page_to: number; raw: string }[]>`
          select row_id, source_id, page_from, page_to, raw from cms.cms_citations where row_id = any(${changed.map((c) => c.r.row_id)})`) oldCites.set(c.row_id, [...(oldCites.get(c.row_id) ?? []), citeKey(c)]);
      }
      const citesChanged = new Set(changed.filter(({ r }) => (oldCites.get(r.row_id) ?? []).sort().join('\n') !== r.citations.map(citeKey).sort().join('\n')).map(({ r }) => r.row_id));
      for (const { r, row, before } of changed) {
        const diff: Record<string, { before: unknown; after: unknown }> = {};
        for (const k of ROW_COLS) if (!sameValue(before[k], row[k])) diff[k] = { before: before[k] ?? null, after: row[k] ?? null };
        if (citesChanged.has(r.row_id)) diff.citations = { before: (oldCites.get(r.row_id) ?? []).length, after: r.citations.length };
        if (before.content_hash !== row.content_hash && !Object.keys(diff).length) diff.content_hash = { before: before.content_hash, after: row.content_hash };
        if (!before.in_master) { diff.in_master = { before: false, after: true }; res.rows.back_in_master++; }
        await tx`update cms.cms_content_rows set ${tx({ ...row, in_master: true, missing_since: null, import_id: importId, updated_at: new Date() } as never)} where row_id = ${r.row_id}`;
        await tx`insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, import_id, reason)
          values ('catalogue', 'cms_content_rows', ${r.row_id}, 'science_row', ${tx.json(diff as never)}, ${by}, ${importId}, 'changed in the Science master')`;
        res.rows.updated++;
      }
      // rows gone from the master: flagged, never deleted
      const inMaster = new Set(master.rows.map((r) => r.row_id));
      for (const [id, before] of existing) {
        if (inMaster.has(id) || !before.in_master) continue;
        await tx`update cms.cms_content_rows set in_master = false, missing_since = now(), import_id = ${importId}, updated_at = now() where row_id = ${id}`;
        await tx`insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, import_id, reason)
          values ('catalogue', 'cms_content_rows', ${id}, 'science_row', ${tx.json({ in_master: { before: true, after: false } } as never)}, ${by}, ${importId}, 'not in the Science master any more (kept, flagged)')`;
        res.rows.flagged_missing++;
      }
      // citations of new and changed rows (bare: source + printed pages)
      const touched = [...fresh.map((r) => r.row_id as string), ...citesChanged];
      if (citesChanged.size) await tx`delete from cms.cms_citations where row_id = any(${[...citesChanged]})`;
      const byId = new Map(master.rows.map((r) => [r.row_id, r]));
      const cits = touched.flatMap((id) => byId.get(id)!.citations.map((c) => ({ row_id: id, source_id: c.source_id, page_from: c.page_from, page_to: c.page_to, raw: c.raw })));
      for (let i = 0; i < cits.length; i += 1000) await tx`insert into cms.cms_citations ${tx(cits.slice(i, i + 1000) as never[])}`;
      res.citations.rows = cits.length;

      // ------------------------------------------------ PROPOSED topic–class links (never active from here)
      const links = new Set((await tx`select topic_id, class from cms.cms_topic_classes`).map((l) => `${l.topic_id}|${l.class}`));
      const props = new Map((await tx`select topic_id, class from cms.cms_topic_class_proposals`).map((p) => [`${p.topic_id}|${p.class}`, p]));
      const need = new Map<string, MasterRow[]>();
      for (const r of master.rows) {
        if (held.has(r.row_id)) continue;
        const t = topics.get(r.topic_id)!;
        if (t.class === r.row_class || links.has(`${r.topic_id}|${r.row_class}`)) continue;
        const k = `${r.topic_id}|${r.row_class}`;
        need.set(k, [...(need.get(k) ?? []), r]);
      }
      for (const [k, rs] of [...need].sort()) {
        const [topic_id, cls] = [k.split('|')[0]!, Number(k.split('|')[1])];
        const t = topics.get(topic_id)!;
        const role = extraRole(t.class, cls);
        const isNew = !props.has(k);
        if (isNew) {
          const evidence = `${rs.length} content row${rs.length === 1 ? '' : 's'} of class ${cls} in the Science master (${rs.slice(0, 3).map((r) => r.row_id).join(', ')}${rs.length > 3 ? ', …' : ''})`;
          await tx`insert into cms.cms_topic_class_proposals (topic_id, class, source, evidence, suggested_role, import_id) values (${topic_id}, ${cls}, 'Science master', ${evidence}, ${role}, ${importId})`;
          await tx`insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, import_id, reason)
            values ('catalogue', 'cms_topic_class_proposals', ${`${topic_id} · class ${cls}`}, 'create', ${tx.json({ status: { before: null, after: 'proposed' }, role, home_class: t.class } as never)}, ${by}, ${importId}, 'proposed by the Science master: rows of this class, no link yet')`;
        }
        res.proposals.push({ topic_id, name: t.name, home_class: t.class, row_class: cls, role, rows: rs.length, isNew });
      }

      // ------------------------------------------------ questions
      const known = new Map((await tx<{ question_id: string; source_qid: string; current_version: number; approved_version: number | null; version_id: string; status: string; edited_at: string | null; created_from: string; content_hash: string }[]>`
        select q.question_id, q.source_qid, q.current_version, q.approved_version, v.version_id, v.status, v.edited_at, v.created_from, v.content_hash
          from cms.cms_questions q join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
         where q.source_qid is not null`).map((q) => [q.source_qid, q]));
      const rowIds = new Set((await tx`select row_id from cms.cms_content_rows`).map((r) => r.row_id as string));
      const [{ max }] = await tx`select max(substring(file_key from '-([0-9]+)$')::int) filter (where substring(file_key from '-([0-9]+)$')::int < 5000) as max from cms.cms_questions where subject = 'science'` as unknown as [{ max: number | null }];
      const keyNo = new Map<string, number>();
      const nextKey = async (chapter: string) => {
        if (!keyNo.has(chapter)) {
          const [x] = await tx`select coalesce(max(substring(file_key from '-([0-9]+)$')::int) filter (where substring(file_key from '-([0-9]+)$')::int < 5000), 0) as n from cms.cms_questions where chapter_id = ${chapter}`;
          keyNo.set(chapter, Number(x!.n));
        }
        const n = keyNo.get(chapter)! + 1; keyNo.set(chapter, n);
        if (n >= 5000) throw new Error(`chapter ${chapter} has used all import keys`);
        return `${chapter}-${String(n).padStart(4, '0')}`;
      };
      void max;
      const [cfg] = await tx`select (select value from cms.cms_config where key = 'similarity_threshold') as th, (select value from cms.cms_config where key = 'originality_near_copy') as near`;

      const writeVersion = async (q: MasterQuestion, questionId: string, versionId: number) => {
        const choices = q.format === 'True/False' ? ['True', 'False'] : q.options;
        await tx`insert into cms.cms_version_options ${tx(choices.map((o, i) => ({ version_id: versionId, part_label: '', position: i + 1, text: o, is_correct: o === q.correct })) as never[])}`;
        if (q.explanation) await tx`insert into cms.cms_version_solutions (version_id, slot, text) values (${versionId}, 1, ${q.explanation})`;
        const cs = q.citations.map((c) => ({ version_id: versionId, source_id: c.source_id, page_from: c.page_from, page_to: c.page_to, raw: c.raw, for_row_id: c.for_row_id ?? null }));
        if (cs.length) await tx`insert into cms.cms_citations ${tx(cs as never[])}`;
        res.citations.questions += cs.length;
        await tx`insert into cms.cms_question_content_rows ${tx(q.links.map((l) => ({ version_id: versionId, row_id: l.row_id, role: l.role })) as never[])}`;
        for (const l of q.links) res.links[l.role]++;
        const c = qCheck.get(q.qid)!;
        const [chk] = await tx`insert into cms.cms_originality_checks ${tx({ version_id: versionId, checked_at: report.checked_at, result: c.result, similarity: c.similarity, same_numbers: c.same_numbers,
          closest_ref: c.closest_ref, field: c.field ?? null, checked: tx.json(report.read as never), missing: tx.json(report.missing as never), threshold: Number(cfg!.th ?? report.threshold),
          near_copy_threshold: Number(cfg!.near ?? report.near_copy_threshold), tool: report.tool, import_id: importId } as never)} returning check_id`;
        const cov = nearCopyCover(c, opts.overrides);
        if (cov.covered) for (const [i, f] of cov.fields.entries()) {
          await tx`insert into cms.cms_override_requests (question_id, version_id, file_key, field, reason, requested_by, check_id, import_id)
            values (${questionId}, ${versionId}, ${q.qid}, ${f}, ${cov.reasons[i]!}, 'Science master', ${chk!.check_id}, ${importId}) on conflict do nothing`;
        }
      };
      const versionCols = (q: MasterQuestion) => ({
        text: q.text, figure_description: q.figure_description, image_status: q.picture_needed ? 'needs_image' : null, format: q.format, correct: q.correct,
        author_notes: q.notes, content_hash: q.hash, level_tier: q.tier, display_format: q.sheet_format, misconception_targeted: q.misconception_targeted,
        safety_note: q.safety_note, confidence: q.confidence,
      });

      for (const q of master.questions) {
        const c = qCheck.get(q.qid)!;
        const cov = nearCopyCover(c, opts.overrides);
        if (cov.near && !cov.covered) { res.questions.blocked.push({ qid: q.qid, why: `near-copy (${cov.fields.join(', ')}: ${c.closest_ref}, ${c.similarity}); rewrite it or list it in override_requests.csv` }); continue; }
        const heldLink = q.links.find((l) => held.has(l.row_id) || !rowIds.has(l.row_id));
        if (heldLink) { res.questions.blocked.push({ qid: q.qid, why: `its content row ${heldLink.row_id} is held out of this import` }); continue; }
        const t = topics.get(q.topic_id)!;
        const ex = known.get(q.qid);
        if (!ex) {
          const [{ id }] = await tx`select 'SQ' || lpad(nextval('cms.cms_sq_seq')::text, 6, '0') as id` as unknown as [{ id: string }];
          await tx`insert into cms.cms_questions ${tx({ question_id: id, bank: 'production', subject: 'science', file_key: await nextKey(t.chapter_id), chapter_id: t.chapter_id, topic_id: t.topic_id,
            class: t.class, level: q.row_class, locale: 'IN', current_version: 1, source_qid: q.qid } as never)}`;
          const [v] = await tx`insert into cms.cms_question_versions ${tx({ question_id: id, version_no: 1, status: 'in_review', topic_id: t.topic_id, accepted: [], created_from: 'import',
            import_id: importId, attributes_pending: true, originality_pending: false, ...versionCols(q) } as never)} returning version_id`;
          await writeVersion(q, id, Number(v!.version_id));
          await tx`insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label, import_id)
            values ('question_version', 'cms_question_versions', ${`${id} v1`}, 'create', ${`from the Science master (${q.qid})`},
                    ${tx.json({ status: { before: null, after: 'in_review' }, origin: 'import', flags: ['attributes_pending', ...(q.picture_needed ? ['image_pending'] : [])], originality: c.result } as never)}, ${by}, ${importId})`;
          res.questions.created.push(id);
          continue;
        }
        if (ex.content_hash === q.hash) { res.questions.unchanged++; continue; }
        const replaceable = ['draft', 'in_review'].includes(ex.status) && !ex.edited_at && ex.created_from === 'import' && ex.approved_version === null;
        if (!replaceable) { res.questions.skipped.push({ qid: q.qid, why: `${ex.question_id} changed in the master but was ${ex.approved_version !== null ? 'approved' : ex.edited_at ? 'edited' : ex.status} in the CMS; the CMS keeps its version` }); continue; }
        const vid = Number(ex.version_id);
        for (const tbl of ['cms_version_options', 'cms_version_solutions', 'cms_citations', 'cms_question_content_rows']) await tx`delete from ${tx(`cms.${tbl}`)} where version_id = ${vid}`;
        await tx`update cms.cms_question_versions set ${tx({ ...versionCols(q), topic_id: t.topic_id, import_id: importId } as never)} where version_id = ${vid}`;
        await tx`update cms.cms_questions set topic_id = ${t.topic_id}, chapter_id = ${t.chapter_id}, class = ${t.class}, level = ${q.row_class} where question_id = ${ex.question_id}`;
        await writeVersion(q, ex.question_id, vid);
        await tx`insert into cms.cms_reviews (target, target_table, target_id, action, reason, by_label, import_id)
          values ('question_version', 'cms_question_versions', ${`${ex.question_id} v${ex.current_version}`}, 'import_replace_draft', ${`changed in the Science master (${q.qid}); unedited draft replaced`}, ${by}, ${importId})`;
        res.questions.replaced.push(ex.question_id);
      }
      const inQ = new Set(master.questions.map((q) => q.qid));
      res.questions.not_in_master = [...known.keys()].filter((k) => !inQ.has(k)).sort();

      // ------------------------------------------------ cross-check the sheet's own row status with the CMS's
      const st = new Map((await tx`select row_id, status from cms.cms_content_row_status`).map((r) => [r.row_id as string, r.status as string]));
      for (const r of master.rows) {
        const mine = st.get(r.row_id);
        if (r.sheet_status && mine && r.sheet_status !== mine) res.status_mismatch.push({ row_id: r.row_id, sheet: r.sheet_status, cms: mine });
      }

      // ------------------------------------------------ "Topic class (mapped)" vs the topic's approved classes (report only)
      const approved = new Map<string, number[]>();
      for (const a of await tx<{ topic_id: string; class: number }[]>`select topic_id, class from cms.cms_topic_all_classes where topic_id like 'ST%'`) approved.set(a.topic_id, [...(approved.get(a.topic_id) ?? []), a.class]);
      for (const r of master.rows) {
        if (held.has(r.row_id)) continue;
        const cls = approved.get(r.topic_id) ?? [];
        const mm = classMismatch(r.topic_classes_mapped, cls);
        if (mm) res.class_mismatch.push({ row_id: r.row_id, topic_id: r.topic_id, mapped: r.topic_classes_mapped!, approved: [...cls].sort(), only_master: mm.onlyMaster, only_cms: mm.onlyCms });
      }

      await tx`update cms.cms_imports set finished_at = now(), result = ${res.questions.blocked.length || res.rows.held_out.length ? 'partial' : 'ok'},
        counts = ${tx.json({ sources: res.sources, rows: { ...res.rows, held_out: res.rows.held_out.length, near_copy_badged: res.rows.near_copy_badged.length, overridden: res.rows.overridden.length },
          citations: res.citations, proposals: res.proposals.length, questions: { created: res.questions.created.length, replaced: res.questions.replaced.length, unchanged: res.questions.unchanged,
          skipped: res.questions.skipped.length, blocked: res.questions.blocked.length }, links: res.links, originality: res.originality,
          also_in: { rows_with_ids: res.also_in.rows_with_ids, ids_parsed: res.also_in.ids_parsed, ids_kept: res.also_in.ids_kept, unparsed: res.also_in.unparsed.length, unknown: res.also_in.unknown.length },
          class_mismatch: res.class_mismatch.length } as never)},
        error_report = ${tx.json([...res.questions.blocked, ...res.questions.skipped, ...res.rows.held_out.map((id) => ({ row_id: id, why: 'near-copy, held out' }))] as never)}
        where import_id = ${importId}`;
      if (opts.dryRun && !opts.inTx) throw new Rollback(res);
    };
    if (opts.inTx) await body(opts.inTx); else await sql.begin(body);
  } catch (e) {
    if (e instanceof Rollback) return e.result;
    throw e;
  }
  return res;
}

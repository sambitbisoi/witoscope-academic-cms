// npm run import:proposals -- <NCERT-C6-01.proposals.json> [more files…] [--dry-run]
//
// Imports the book-to-question pipeline's proposed catalogue items (migration 0018):
// concepts, misconceptions, typical sets and patterns, all with status 'proposed'.
//   - new ID                        → inserted as proposed
//   - ID already proposed elsewhere → merged: one row, one more "proposed by" link
//                                     (the first proposal's wording is kept; differences are reported)
//   - ID already in the catalogue   → left as it is (status and wording never changed); link recorded
// Every proposing file gets a cms_catalogue_proposals row with the question keys that use the item.
// Files are processed together (concepts of all files first, then misconceptions, sets,
// patterns, links), so an item may point at an item another chapter proposed.
// topic_workbook_fixes are NOT imported (the CMS never edits the topic workbooks); they are
// listed in the report. Pattern source_refs (book item citations) come from the chapter files
// next to the proposals file. Nothing from *.book.json or source_images/ is read.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import type postgres from 'postgres';
import { assertCmsOwner, connect } from './lib/db.ts';

type Tx = postgres.TransactionSql;
type Kind = 'concept' | 'misconception' | 'typical_set' | 'pattern';
const TABLE: Record<Kind, string> = { concept: 'cms_concepts', misconception: 'cms_misconceptions', typical_set: 'cms_typical_sets', pattern: 'cms_patterns' };
const ID_COL: Record<Kind, string> = { concept: 'concept_id', misconception: 'misconception_id', typical_set: 'typical_set_id', pattern: 'pattern_id' };

interface PConcept { concept_id: string; chapter: string; topic: string; name: string; type: string; description?: string; includes?: string; excludes?: string; example?: string; class: number; curriculum_tags?: string; builds_on?: string; used_by?: string[] }
interface PMisc { misconception_id: string; concept_id: string; description: string; parent?: string; used_by?: string[] }
interface PSet { typical_set_id: string; name: string; instruction?: string; chapter: string; topic: string; concepts?: string; variant?: string; class: number; used_by?: string[] }
interface PPattern { pattern_id: string; topic_id: string; typical_set_id: string; name: string; template?: string; variables?: Record<string, unknown>; target_misconceptions?: string[]; notes?: string; used_by?: string[] }
interface ProposalsFile { from: string; status: string; concepts?: PConcept[]; misconceptions?: PMisc[]; typical_sets?: PSet[]; patterns?: PPattern[]; topic_workbook_fixes?: Record<string, unknown>[] }

export interface ProposalCounts { new: number; merged: number; existing: number; unchanged: number; failed: number }
export interface ProposalReport {
  file: string; proposedBy: string; importId: number | null;
  counts: Record<Kind, ProposalCounts>; problems: { level: 'error' | 'warning'; where: string; message: string }[];
  workbookFixes: number; links: number;
}

const firstToken = (s: string | undefined) => (s ?? '').trim().split(/\s+/)[0] ?? '';
const list = (s: string | undefined) => (s ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
const zero = (): ProposalCounts => ({ new: 0, merged: 0, existing: 0, unchanged: 0, failed: 0 });

export async function runProposals(sql: ReturnType<typeof connect>, paths: string[], dryRun: boolean): Promise<ProposalReport[]> {
  const files = paths.map((p) => {
    const abs = resolve(p);
    const raw = readFileSync(abs);
    const data = JSON.parse(raw.toString('utf8')) as ProposalsFile;
    const proposedBy = basename(abs).replace(/\.proposals\.json$/, '');
    const date = /\((\d{4}-\d{2}-\d{2})\)/.exec(data.from ?? '')?.[1] ?? null;
    // pattern citations from the chapter files in the same folder (our files, not book files)
    const patternRefs = new Map<string, string[]>();
    for (const f of readdirSync(dirname(abs)).filter((n) => /^(MC|SC|GC)\d{2}-C\d\.json$/.test(n))) {
      const ch = JSON.parse(readFileSync(resolve(dirname(abs), f), 'utf8')) as { patterns?: { pattern_id: string; source_refs?: string[] }[] };
      for (const p of ch.patterns ?? []) patternRefs.set(p.pattern_id, p.source_refs ?? []);
    }
    const report: ProposalReport = {
      file: abs.replace(homedir(), '~'), proposedBy, importId: null, problems: [], workbookFixes: (data.topic_workbook_fixes ?? []).length, links: 0,
      counts: { concept: zero(), misconception: zero(), typical_set: zero(), pattern: zero() },
    };
    if (data.status !== 'proposed') report.problems.push({ level: 'warning', where: 'file', message: `status is "${data.status}", imported as proposed anyway` });
    return { abs, raw, data, proposedBy, date, patternRefs, report };
  });

  class DryRun extends Error {}
  try {
    await sql.begin(async (tx) => {
      for (const f of files) {
        const [imp] = await tx`insert into cms.cms_imports (kind, file_path, file_hash, options)
          values ('proposals', ${f.report.file}, ${createHash('sha256').update(f.raw).digest('hex')}, ${tx.json({ dry_run: dryRun, proposed_by: f.proposedBy })})
          returning import_id`;
        f.report.importId = Number(imp!.import_id);
      }
      const topics = new Map((await tx`select topic_id, chapter_id, class from cms.cms_topics`).map((t) => [t.topic_id as string, t]));
      const chapters = new Set((await tx`select chapter_id from cms.cms_chapters`).map((c) => c.chapter_id as string));
      /** "MT0090 …" → MT0090; "ACHIEVERS …" → that chapter's Achievers row for the class (decision 4). */
      const topicOf = (raw: string, chapter: string | null, cls: number | null, where: string, r: ProposalReport): string | null => {
        const t = firstToken(raw);
        const id = t === 'ACHIEVERS' && chapter && cls ? `ACH-${chapter}-${cls}` : t;
        if (topics.has(id)) return id;
        r.problems.push({ level: 'warning', where, message: `topic "${raw}" (${id}) is not in the CMS; kept without a topic` });
        return null;
      };
      // rows written in this run, so a later file merges instead of re-inserting
      const firstProposal = new Map<string, { by: string; row: Record<string, unknown> }>();

      async function put(kind: Kind, id: string, row: Record<string, unknown>, f: (typeof files)[number], usedBy: string[], jsonCols: string[] = []) {
        const r = f.report;
        const k = `${kind}:${id}`;
        const [existing] = await tx.unsafe(`select status from cms.${TABLE[kind]} where ${ID_COL[kind]} = $1`, [id]);
        const [link] = await tx`select used_by from cms.cms_catalogue_proposals where item_kind = ${kind} and item_id = ${id} and proposed_by = ${f.proposedBy}`;
        if (!existing) {
          const enc = Object.fromEntries(Object.entries(row).map(([c, v]) => [c, jsonCols.includes(c) ? tx.json(v as never) : v]));
          await tx`insert into ${tx(`cms.${TABLE[kind]}`)} ${tx({ ...enc, status: 'proposed' } as never)}`;
          firstProposal.set(k, { by: f.proposedBy, row });
          r.counts[kind].new++;
        } else if (link) {
          r.counts[kind].unchanged++; // this file was imported before
        } else if (existing.status === 'proposed') {
          r.counts[kind].merged++;
          const first = firstProposal.get(k);
          if (first) {
            const differs = Object.keys(row).filter((c) => JSON.stringify(row[c] ?? null) !== JSON.stringify(first.row[c] ?? null));
            if (differs.length) r.problems.push({ level: 'warning', where: `${kind} ${id}`, message: `also proposed by ${first.by} with different ${differs.join(', ')}; ${first.by}'s wording kept` });
          }
        } else {
          r.counts[kind].existing++;
          r.problems.push({ level: 'warning', where: `${kind} ${id}`, message: `already in the catalogue as ${existing.status}; not changed, proposal link recorded` });
        }
        const keys = [...new Set([...((link?.used_by as string[]) ?? []), ...usedBy])].sort();
        await tx`insert into cms.cms_catalogue_proposals (item_kind, item_id, proposed_by, used_by, proposed_at, import_id)
                 values (${kind}, ${id}, ${f.proposedBy}, ${keys}, ${f.date}, ${r.importId})
                 on conflict (item_kind, item_id, proposed_by) do update set used_by = excluded.used_by, updated_at = now()`;
        r.links++;
      }

      for (const f of files) for (const c of f.data.concepts ?? []) {
        const chapter = firstToken(c.chapter);
        await put('concept', c.concept_id, {
          concept_id: c.concept_id, subject: 'math', class: c.class, topic_id: topicOf(c.topic, chapter, c.class, `concept ${c.concept_id}`, f.report),
          name: c.name, type: c.type?.toLowerCase() === 'applied' ? 'applied' : 'core', description: c.description ?? null, includes: c.includes ?? null,
          excludes: c.excludes ?? null, example_question: c.example ?? null, curriculum_tags: c.curriculum_tags ? [c.curriculum_tags] : [],
        }, f, c.used_by ?? []);
      }
      const conceptIds = new Set((await tx`select concept_id from cms.cms_concepts`).map((c) => c.concept_id as string));
      for (const f of files) for (const m of f.data.misconceptions ?? []) {
        if (!conceptIds.has(m.concept_id)) { f.report.counts.misconception.failed++; f.report.problems.push({ level: 'error', where: `misconception ${m.misconception_id}`, message: `concept ${m.concept_id} does not exist` }); continue; }
        await put('misconception', m.misconception_id, {
          misconception_id: m.misconception_id, concept_id: m.concept_id, description: m.description, parent_description: m.parent ?? null,
        }, f, m.used_by ?? []);
      }
      const setInfo = new Map<string, { chapter: string | null; cls: number }>();
      for (const s of await tx`select typical_set_id, chapter_id, class from cms.cms_typical_sets`) setInfo.set(s.typical_set_id, { chapter: s.chapter_id, cls: s.class });
      for (const f of files) for (const s of f.data.typical_sets ?? []) {
        const chapter = firstToken(s.chapter);
        const chapterId = chapters.has(chapter) ? chapter : null;
        if (!chapterId) f.report.problems.push({ level: 'warning', where: `typical set ${s.typical_set_id}`, message: `chapter "${s.chapter}" is not in the CMS; kept without a chapter` });
        const before = new Set((await tx`select typical_set_id from cms.cms_typical_sets where typical_set_id = ${s.typical_set_id}`).map((x) => x.typical_set_id));
        await put('typical_set', s.typical_set_id, {
          typical_set_id: s.typical_set_id, subject: 'math', class: s.class, chapter_id: chapterId,
          topic_id: topicOf(s.topic, chapterId, s.class, `typical set ${s.typical_set_id}`, f.report),
          name: s.name, instruction_pattern: s.instruction ?? null, variant_note: s.variant ?? null,
        }, f, s.used_by ?? []);
        setInfo.set(s.typical_set_id, setInfo.get(s.typical_set_id) ?? { chapter: chapterId, cls: s.class });
        if (!before.size) {
          // concepts the set exercises: the first listed is the main one [guess], the rest "other"
          for (const [i, cid] of list(s.concepts).entries()) {
            if (!conceptIds.has(cid)) { f.report.problems.push({ level: 'warning', where: `typical set ${s.typical_set_id}`, message: `concept ${cid} does not exist; link skipped` }); continue; }
            await tx`insert into cms.cms_typical_set_concepts (typical_set_id, concept_id, role) values (${s.typical_set_id}, ${cid}, ${i === 0 ? 'main' : 'other'}) on conflict do nothing`;
          }
        }
      }
      const miscIds = new Set((await tx`select misconception_id from cms.cms_misconceptions`).map((m) => m.misconception_id as string));
      for (const f of files) for (const p of f.data.patterns ?? []) {
        const where = `pattern ${p.pattern_id}`;
        const set = setInfo.get(p.typical_set_id);
        if (!set) { f.report.counts.pattern.failed++; f.report.problems.push({ level: 'error', where, message: `typical set ${p.typical_set_id} does not exist` }); continue; }
        const topic = topicOf(p.topic_id, set.chapter, set.cls, where, f.report);
        if (!topic) { f.report.counts.pattern.failed++; f.report.problems.push({ level: 'error', where, message: 'a pattern needs a topic' }); continue; }
        const targets = (p.target_misconceptions ?? []).filter((m) => miscIds.has(m) || (f.report.problems.push({ level: 'warning', where, message: `target misconception ${m} does not exist; dropped` }), false));
        await put('pattern', p.pattern_id, {
          pattern_id: p.pattern_id, topic_id: topic, typical_set_id: p.typical_set_id, name: p.name, template: p.template ?? null,
          variables: p.variables ?? {}, target_misconceptions: targets, source_refs: f.patternRefs.get(p.pattern_id) ?? [], notes: p.notes ?? null,
        }, f, p.used_by ?? [], ['variables']);
      }
      // builds_on links last, so they may point at concepts any file proposed
      const allConcepts = new Set((await tx`select concept_id from cms.cms_concepts`).map((c) => c.concept_id as string));
      for (const f of files) for (const c of f.data.concepts ?? []) for (const to of list(c.builds_on)) {
        if (!allConcepts.has(to)) { f.report.problems.push({ level: 'warning', where: `concept ${c.concept_id}`, message: `builds_on ${to} does not exist; link skipped` }); continue; }
        await tx`insert into cms.cms_concept_links (from_concept, to_concept, kind) values (${c.concept_id}, ${to}, 'builds_on') on conflict do nothing`;
      }
      for (const f of files) {
        const r = f.report;
        const failed = Object.values(r.counts).reduce((n, c) => n + c.failed, 0);
        await tx`update cms.cms_imports set finished_at = now(), result = ${failed ? 'partial' : 'ok'},
                 counts = ${tx.json({ ...r.counts, links: r.links, topic_workbook_fixes_not_imported: r.workbookFixes } as never)},
                 error_report = ${tx.json(r.problems as never)} where import_id = ${r.importId}`;
      }
      if (dryRun) throw new DryRun();
    });
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
    for (const f of files) f.report.importId = null;
  }
  return files.map((f) => f.report);
}

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const paths = args.filter((a) => !a.startsWith('--'));
  if (!paths.length) { console.error('usage: npm run import:proposals -- <file.proposals.json> [more…] [--dry-run]'); process.exit(1); }
  const dryRun = args.includes('--dry-run');
  const sql = connect();
  try {
    await assertCmsOwner(sql);
    const reports = await runProposals(sql, paths, dryRun);
    for (const r of reports) {
      console.log(`\nProposals${dryRun ? ' (DRY RUN — nothing saved)' : ` #${r.importId}`}: ${r.proposedBy}`);
      for (const [k, c] of Object.entries(r.counts)) console.log(`  ${k.padEnd(14)} +${c.new} new · ${c.merged} merged · ${c.existing} already in catalogue · ${c.unchanged} unchanged${c.failed ? ` · ${c.failed} FAILED` : ''}`);
      if (r.workbookFixes) console.log(`  ${r.workbookFixes} topic workbook fix${r.workbookFixes === 1 ? '' : 'es'} not imported (the workbooks are edited outside the CMS)`);
      for (const p of r.problems) console.log(`  ${p.level === 'error' ? '✗' : '!'} ${p.where}: ${p.message}`);
    }
    process.exitCode = reports.some((r) => r.problems.some((p) => p.level === 'error')) ? 1 : 0;
  } finally {
    await sql.end();
  }
}

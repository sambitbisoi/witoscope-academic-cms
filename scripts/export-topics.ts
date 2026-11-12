// npm run export:topics [-- --out <folder>] [--publish]
//
// D5 "Export to Excel": writes WitoScope_{Math,Science,English_Grammar}_Topics_Class1-6.xlsx from
// the CMS (default folder ~/WitoScope/ContentResearch/CMS-exports/<date>/, so the original
// workbooks are never overwritten). Read-only exports for the content pipelines. Reads the DB only.
// --publish (after the D5 cut-over only): also put the export where the pipelines read the
// workbooks (ContentResearch/{Math,Science,English}/…). The first time, each original workbook is
// first copied to <its folder>/_archive/<name>.final-before-cutover-<date>.xlsx (never deleted).
// The published copies are made read-only.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { curriculumOwner } from './lib/curriculum.ts';
import { assertCmsOwner, connect } from './lib/db.ts';
import { buildSheets, EXPORT_FILES, type Subject, type XTopic } from './lib/export-topics.ts';

const ExcelJS = createRequire(import.meta.url)('exceljs') as typeof import('exceljs');
export const EXPORT_DIR = join(homedir(), 'WitoScope', 'ContentResearch', 'CMS-exports');
const CR = join(homedir(), 'WitoScope', 'ContentResearch');
/** Where the content pipelines read the workbooks (same paths import:topics read before the cut-over). */
export const PIPELINE_PATHS: Record<Subject, string> = {
  math: join(CR, 'Math', EXPORT_FILES.math), science: join(CR, 'Science', EXPORT_FILES.science), grammar: join(CR, 'English', EXPORT_FILES.grammar),
};

/** Archive each original once, then copy the export over the pipeline path (read-only). */
export function publish(outDir: string, date = new Date().toISOString().slice(0, 10)): string[] {
  const log: string[] = [];
  for (const subject of Object.keys(PIPELINE_PATHS) as Subject[]) {
    const target = PIPELINE_PATHS[subject];
    const archive = join(dirname(target), '_archive');
    const stem = basename(target, '.xlsx');
    const archived = existsSync(archive) && readdirSync(archive).some((n) => n.startsWith(`${stem}.final-before-cutover-`));
    if (!archived && existsSync(target)) {
      mkdirSync(archive, { recursive: true });
      const a = join(archive, `${stem}.final-before-cutover-${date}.xlsx`);
      copyFileSync(target, a); chmodSync(a, 0o444);
      log.push(`archived ${target.replace(homedir(), '~')} → ${a.replace(homedir(), '~')}`);
    }
    if (existsSync(target)) chmodSync(target, 0o644);
    copyFileSync(join(outDir, EXPORT_FILES[subject]), target); chmodSync(target, 0o444);
    log.push(`published ${target.replace(homedir(), '~')} (read-only)`);
  }
  return log;
}

export async function exportTopics(sql: ReturnType<typeof connect>, outDir: string): Promise<{ file: string; topics: number; chapters: number }[]> {
  mkdirSync(outDir, { recursive: true });
  const exportedAt = new Date().toISOString();
  const [classes, prereqs, counts] = await Promise.all([
    sql`select topic_id, class from cms.cms_topic_classes`,
    sql`select topic_id, prereq_topic_id from cms.cms_topic_prereqs order by prereq_topic_id`,
    sql`select topic_id, count(*) filter (where counted)::int as n from cms.cms_question_list group by topic_id`,
  ]);
  const out = [];
  for (const subject of Object.keys(EXPORT_FILES) as Subject[]) {
    const [strands, chapters, topics, maps] = await Promise.all([
      sql`select strand_id, code, name, sort from cms.cms_strands where subject = ${subject}`,
      sql`select chapter_id, strand_id, name, display_code, scope, sort, status from cms.cms_chapters where subject = ${subject}`,
      sql`select t.* from cms.cms_topics t join cms.cms_chapters c using (chapter_id) where c.subject = ${subject}`,
      sql`select sheet, row_no, cells from cms.cms_source_map where subject = ${subject} and status = 'active' order by sheet, row_no`,
    ]);
    const xt: XTopic[] = topics.map((t) => ({
      topic_id: t.topic_id, chapter_id: t.chapter_id, class: t.class, seq: t.seq, name: t.name, level: t.level, sub_skills: t.sub_skills, topic_kind: t.topic_kind,
      source_flags: t.source_flags ?? {}, notes: t.notes, status: t.status,
      classes: [...new Set([t.class, ...classes.filter((c) => c.topic_id === t.topic_id).map((c) => c.class as number)])].sort((a, b) => a - b),
      prereqs: prereqs.filter((p) => p.topic_id === t.topic_id).map((p) => p.prereq_topic_id as string),
      questions: counts.find((c) => c.topic_id === t.topic_id)?.n ?? 0,
    }));
    const wb = new ExcelJS.Workbook();
    wb.creator = 'WitoScope Academic CMS'; wb.created = new Date(exportedAt);
    for (const sheet of buildSheets(subject, strands as never, chapters as never, xt, exportedAt, maps as never)) {
      const ws = wb.addWorksheet(sheet.name, { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.addRow(sheet.columns).font = { bold: true };
      for (const r of sheet.rows) ws.addRow(r);
      ws.columns.forEach((c, i) => { c.width = Math.min(60, Math.max(10, sheet.columns[i]!.length + 2, ...sheet.rows.slice(0, 200).map((r) => String(r[i] ?? '').length * 0.9))); });
      if (sheet.name !== 'Read me') ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
    }
    const file = join(outDir, EXPORT_FILES[subject]);
    await wb.xlsx.writeFile(file);
    out.push({ file, topics: xt.filter((t) => t.topic_kind === 'normal').length, chapters: chapters.length });
  }
  return out;
}

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const outDir = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1]! : join(EXPORT_DIR, new Date().toISOString().slice(0, 10)));
  const sql = connect();
  try {
    await assertCmsOwner(sql);
    const wantPublish = args.includes('--publish');
    if (wantPublish && (await curriculumOwner(sql)) !== 'cms') throw new Error('--publish is for after the cut-over (the workbooks still own the curriculum).');
    for (const r of await exportTopics(sql, outDir)) console.log(`${r.file.replace(homedir(), '~')}: ${r.chapters} chapters, ${r.topics} topics`);
    if (wantPublish) for (const l of publish(outDir)) console.log(l);
    console.log('Read-only exports: edit chapters and topics in the CMS, then export again.');
  } finally { await sql.end(); }
}

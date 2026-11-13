// The "CMS-updates" file contracts (docs/queue-2026-11-12.md, section "File contracts"): pure
// parsing and checks, no database. The importer (scripts/import-updates.ts) applies them.
//   question_levels.csv     file_key, level, source_file, source_field
//   topic_classes.csv       topic_id, class, source, evidence
//   settings_catalogue.csv  setting_id, name, description, theme, status
//   question_settings.csv   file_key, setting_id, confidence, note
//   key_fixes.csv           old_file_key, new_file_key, source_file, reason
//   near_copy_rewrites/<chapter file>.json   (pipeline chapter-file format)

export interface Problem { level: 'error' | 'warning'; where: string; message: string }

/** RFC 4180 CSV (quoted fields, "" escapes, CRLF or LF). Returns header-keyed rows with their line numbers. */
export function parseCsv(text: string): { header: string[]; rows: { line: number; values: Record<string, string> }[] } {
  const src = text.replace(/^﻿/, '');
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [], cell = '', quoted = false, line = 1, start = 1, i = 0, touched = false;
  const endCell = () => { cells.push(cell); cell = ''; };
  const endRow = () => { endCell(); if (touched || cells.some((c) => c !== '')) records.push({ line: start, cells }); cells = []; touched = false; };
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      if (ch === '\n') line++;
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '') { quoted = true; touched = true; i++; continue; }
    if (ch === ',') { endCell(); touched = true; i++; continue; }
    if (ch === '\r' && src[i + 1] === '\n') { i++; continue; }
    if (ch === '\n') { endRow(); line++; start = line; i++; continue; }
    cell += ch; i++;
  }
  if (cell !== '' || cells.length) endRow();
  const [head, ...body] = records;
  const header = (head?.cells ?? []).map((h) => h.trim());
  return { header, rows: body.map((r) => ({ line: r.line, values: Object.fromEntries(header.map((h, k) => [h, (r.cells[k] ?? '').trim()])) })) };
}

function needColumns(file: string, header: string[], cols: string[], problems: Problem[]): boolean {
  const missing = cols.filter((c) => !header.includes(c));
  if (missing.length) problems.push({ level: 'error', where: file, message: `missing column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}` });
  return missing.length === 0;
}

export const FILE_KEY = /^(MC|SC|GC)[0-9]{2}-[0-9]{3,4}$/;
export const TOPIC_ID = /^(MT|ST|GT)[0-9]{4}$|^ACH-(MC|SC|GC)[0-9]{2}-[1-6]$/;
export const SETTING_ID = /^SET[0-9]{3,4}$/;
// IMO = Math's Olympiad (SOF IMO), as ISO is Science's (data thread, 12 Nov 2026).
export const TOPIC_CLASS_SOURCES = ['workbook-default', 'NCERT', 'DAV', 'ISO', 'IMO', 'IXL'];
const classOf = (s: string) => (/^[1-6]$/.test(s) ? Number(s) : null);

export interface LevelRow { file_key: string; level: number; source: string }
export function parseLevels(text: string, file = 'question_levels.csv') {
  const problems: Problem[] = []; const rows: LevelRow[] = []; const seen = new Map<string, number>();
  const csv = parseCsv(text);
  if (!needColumns(file, csv.header, ['file_key', 'level'], problems)) return { rows, problems };
  for (const { line, values: v } of csv.rows) {
    const where = `${file} line ${line}`;
    const level = classOf(v.level ?? '');
    if (!FILE_KEY.test(v.file_key ?? '')) { problems.push({ level: 'error', where, message: `file_key "${v.file_key}" is not a question key like MC04-0007` }); continue; }
    if (level === null) { problems.push({ level: 'error', where, message: `${v.file_key}: level "${v.level}" must be 1–6` }); continue; }
    if (seen.has(v.file_key!)) {
      if (seen.get(v.file_key!) !== level) problems.push({ level: 'error', where, message: `${v.file_key} has two different levels (${seen.get(v.file_key!)} and ${level})` });
      continue;
    }
    seen.set(v.file_key!, level);
    rows.push({ file_key: v.file_key!, level, source: [v.source_file, v.source_field].filter(Boolean).join(' · ') });
  }
  return { rows, problems };
}

export interface TopicClassRow { topic_id: string; class: number; source: string; evidence: string | null }
export function parseTopicClasses(text: string, file = 'topic_classes.csv') {
  const problems: Problem[] = []; const rows: TopicClassRow[] = []; const seen = new Set<string>();
  const csv = parseCsv(text);
  if (!needColumns(file, csv.header, ['topic_id', 'class', 'source'], problems)) return { rows, problems };
  for (const { line, values: v } of csv.rows) {
    const where = `${file} line ${line}`;
    const cls = classOf(v.class ?? '');
    if (!TOPIC_ID.test(v.topic_id ?? '')) { problems.push({ level: 'error', where, message: `topic_id "${v.topic_id}" is not a topic ID` }); continue; }
    if (cls === null) { problems.push({ level: 'error', where, message: `${v.topic_id}: class "${v.class}" must be 1–6` }); continue; }
    // several sources for the same class come in one row, separated by "; "
    const sources = (v.source ?? '').split(';').map((x) => x.trim()).filter(Boolean);
    if (!sources.length) { problems.push({ level: 'error', where, message: `${v.topic_id} class ${cls}: source is empty` }); continue; }
    for (const s of sources) if (!TOPIC_CLASS_SOURCES.includes(s)) problems.push({ level: 'warning', where, message: `${v.topic_id}: source "${s}" is not one of ${TOPIC_CLASS_SOURCES.join(' / ')}` });
    const k = `${v.topic_id}|${cls}`;
    if (seen.has(k)) { problems.push({ level: 'warning', where, message: `${v.topic_id} class ${cls} is listed twice; the first row is used` }); continue; }
    seen.add(k);
    rows.push({ topic_id: v.topic_id!, class: cls, source: sources.join('; '), evidence: v.evidence || null });
  }
  return { rows, problems };
}

export interface SettingRow { setting_id: string; name: string; description: string | null; theme: string | null; status: 'proposed' | 'active' | 'retired' }
export function parseSettings(text: string, file = 'settings_catalogue.csv') {
  const problems: Problem[] = []; const rows: SettingRow[] = []; const ids = new Set<string>(); const names = new Map<string, string>();
  const csv = parseCsv(text);
  if (!needColumns(file, csv.header, ['setting_id', 'name'], problems)) return { rows, problems };
  for (const { line, values: v } of csv.rows) {
    const where = `${file} line ${line}`;
    if (!SETTING_ID.test(v.setting_id ?? '')) { problems.push({ level: 'error', where, message: `setting_id "${v.setting_id}" must look like SET001` }); continue; }
    if (!v.name) { problems.push({ level: 'error', where, message: `${v.setting_id}: name is empty` }); continue; }
    if (ids.has(v.setting_id!)) { problems.push({ level: 'error', where, message: `${v.setting_id} is listed twice` }); continue; }
    const lower = v.name.toLowerCase();
    if (names.has(lower)) { problems.push({ level: 'error', where, message: `"${v.name}" is used by ${names.get(lower)} and ${v.setting_id}` }); continue; }
    const status = (v.status || 'proposed') as SettingRow['status'];
    if (!['proposed', 'active', 'retired'].includes(status)) { problems.push({ level: 'error', where, message: `${v.setting_id}: status "${v.status}" must be proposed, active or retired` }); continue; }
    ids.add(v.setting_id!); names.set(lower, v.setting_id!);
    rows.push({ setting_id: v.setting_id!, name: v.name, description: v.description || null, theme: v.theme || null, status });
  }
  if (rows.length && !rows.some((r) => r.name.toLowerCase() === 'bare')) problems.push({ level: 'warning', where: file, message: 'no "Bare" setting (no story); the contract says it is included' });
  return { rows, problems };
}

export interface QuestionSettingRow { file_key: string; setting_id: string; confidence: 'high' | 'medium' | 'low' | null; note: string | null }
export function parseQuestionSettings(text: string, file = 'question_settings.csv') {
  const problems: Problem[] = []; const rows: QuestionSettingRow[] = []; const seen = new Set<string>();
  const csv = parseCsv(text);
  if (!needColumns(file, csv.header, ['file_key', 'setting_id'], problems)) return { rows, problems };
  for (const { line, values: v } of csv.rows) {
    const where = `${file} line ${line}`;
    if (!FILE_KEY.test(v.file_key ?? '')) { problems.push({ level: 'error', where, message: `file_key "${v.file_key}" is not a question key` }); continue; }
    if (!SETTING_ID.test(v.setting_id ?? '')) { problems.push({ level: 'error', where, message: `${v.file_key}: setting_id "${v.setting_id}" must look like SET001` }); continue; }
    const conf = (v.confidence || null) as QuestionSettingRow['confidence'];
    if (conf && !['high', 'medium', 'low'].includes(conf)) { problems.push({ level: 'error', where, message: `${v.file_key}: confidence "${v.confidence}" must be high, medium or low` }); continue; }
    if (seen.has(v.file_key!)) { problems.push({ level: 'error', where, message: `${v.file_key} has more than one setting (one per question)` }); continue; }
    seen.add(v.file_key!);
    rows.push({ file_key: v.file_key!, setting_id: v.setting_id!, confidence: conf, note: v.note || null });
  }
  return { rows, problems };
}

export interface KeyFixRow { old_file_key: string; new_file_key: string; source_file: string; reason: string }
export function parseKeyFixes(text: string, file = 'key_fixes.csv') {
  const problems: Problem[] = []; const rows: KeyFixRow[] = [];
  const csv = parseCsv(text);
  if (!needColumns(file, csv.header, ['old_file_key', 'new_file_key', 'source_file'], problems)) return { rows, problems };
  const news = new Set<string>();
  for (const { line, values: v } of csv.rows) {
    const where = `${file} line ${line}`;
    if (!FILE_KEY.test(v.old_file_key ?? '') || !FILE_KEY.test(v.new_file_key ?? '')) { problems.push({ level: 'error', where, message: `"${v.old_file_key}" → "${v.new_file_key}": both must be question keys` }); continue; }
    if (v.old_file_key === v.new_file_key) { problems.push({ level: 'error', where, message: `${v.old_file_key}: the new key is the same as the old one` }); continue; }
    if (v.old_file_key!.slice(0, 4) !== v.new_file_key!.slice(0, 4)) problems.push({ level: 'warning', where, message: `${v.old_file_key} → ${v.new_file_key} moves the question to another chapter` });
    if (news.has(v.new_file_key!)) { problems.push({ level: 'error', where, message: `${v.new_file_key} is the new key of two rows` }); continue; }
    if (!v.source_file) { problems.push({ level: 'error', where, message: `${v.old_file_key}: source_file is empty` }); continue; }
    news.add(v.new_file_key!);
    rows.push({ old_file_key: v.old_file_key!, new_file_key: v.new_file_key!, source_file: v.source_file, reason: v.reason ?? '' });
  }
  return { rows, problems };
}

/**
 * A pipeline chapter file → what the chapter importer expects (as stage:pipeline does):
 * patterns are dropped (they come in as proposals), and figure paths images/X.png become the
 * storage key figures/X.png when the image is available, else the figure is marked needs_image.
 */
export function convertPipelineFile(data: { patterns?: unknown; questions?: { key: string; figure?: { image_file?: string; image_status?: string } }[] } & Record<string, unknown>,
  hasImage: (name: string) => boolean): { file: Record<string, unknown>; notes: string[]; images: string[] } {
  const out = structuredClone(data);
  const notes: string[] = []; const images: string[] = [];
  if (out.patterns) { delete out.patterns; notes.push('patterns left to import:proposals'); }
  for (const q of out.questions ?? []) {
    const f = q.figure;
    if (!f?.image_file) continue;
    const name = f.image_file.split('/').pop()!;
    if (/^(images|figures)\/[A-Za-z0-9._-]+\.png$/i.test(f.image_file) && hasImage(name)) { f.image_file = `figures/${name}`; f.image_status = 'has_image'; images.push(name); }
    else { delete f.image_file; f.image_status = 'needs_image'; notes.push(`${q.key}: image ${name} not found; marked needs_image`); }
  }
  return { file: out, notes, images };
}

export interface OverrideRow { file_key: string; field: string; reason: string }
/** override_requests.csv: file_key, field, reason (a near-copy field whose values are standard and cannot change). */
export function parseOverrides(text: string, file = 'override_requests.csv') {
  const problems: Problem[] = []; const rows: OverrideRow[] = []; const seen = new Set<string>();
  const csv = parseCsv(text);
  if (!needColumns(file, csv.header, ['file_key', 'field', 'reason'], problems)) return { rows, problems };
  for (const { line, values: v } of csv.rows) {
    const where = `${file} line ${line}`;
    if (!FILE_KEY.test(v.file_key ?? '')) { problems.push({ level: 'error', where, message: `file_key "${v.file_key}" is not a question key` }); continue; }
    if (!v.field) { problems.push({ level: 'error', where, message: `${v.file_key}: field is empty` }); continue; }
    if (!v.reason || v.reason.length < 10) { problems.push({ level: 'error', where, message: `${v.file_key}: an override needs a reason` }); continue; }
    const k = `${v.file_key}|${v.field}`;
    if (seen.has(k)) { problems.push({ level: 'warning', where, message: `${v.file_key} ${v.field} is listed twice; the first row is used` }); continue; }
    seen.add(k);
    rows.push({ file_key: v.file_key!, field: v.field, reason: v.reason });
  }
  return { rows, problems };
}

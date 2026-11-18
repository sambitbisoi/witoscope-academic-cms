// Course builder, screen 5 (Q13, 18 Nov 2026): the Excel template and its parser. Pure: the web app and the local
// pilot script read / write the cells with exceljs and hand the rows here.
//
// Sheets: 1 Course · 2 Display chapters · 3 Display topics · 4 Display topic → CMS topics · 5 Achievers CMS chapters
//         · 6 CMS topics (read-only, ignored on upload). Sheets are found by their leading number; columns by header name;
//         extra columns (e.g. notes) are ignored.
// ✗ errors block saving; ! warnings don't. "Replace a draft" keeps the draft's IDs by position (chapter n ↔ chapter n,
// topic n.m ↔ topic n.m), so re-uploading the same layout renames instead of retiring and re-creating.
import { achId, countFor, MAX_ACHIEVERS_PER_CHAPTER, MAX_CMS_PER_TOPIC, type Outline, type TopicInfo } from './course.ts';

export type Cell = string | number | boolean | null;
export interface SheetRow { row: number; values: Record<string, Cell> }
export type Sheets = Map<string, SheetRow[]>;

export const SHEETS = [
  { n: 1, key: 'course', name: '1 Course', columns: ['course_name', 'board', 'class', 'subject'] },
  { n: 2, key: 'chapters', name: '2 Display chapters', columns: ['chapter_no', 'chapter_name'] },
  { n: 3, key: 'topics', name: '3 Display topics', columns: ['chapter_no', 'topic_no', 'display_topic_name'] },
  { n: 4, key: 'items', name: '4 Display topic → CMS topics', columns: ['chapter_no', 'topic_no', 'order', 'cms_topic_id', 'cms_topic_name'] },
  { n: 5, key: 'achievers', name: '5 Achievers CMS chapters', columns: ['chapter_no', 'order', 'cms_chapter_id'] },
  { n: 6, key: 'cms', name: '6 CMS topics (read-only)', columns: ['cms_topic_id', 'cms_topic_name', 'strand', 'cms_chapter_id', 'cms_chapter', 'home_class', 'linked_to_class', 'questions_level_le_class', 'placed_in'] },
] as const;
type SheetKey = (typeof SHEETS)[number]['key'];

export interface UploadProblem { level: 'error' | 'warn'; sheet: string; row?: number; message: string }
export interface UploadBoard { board_id: string; label: string; status: string }
export interface UploadContext {
  boards: UploadBoard[];
  /** every topic of the file's subject (normal and Achievers, any status) */
  topics: Map<string, TopicInfo>;
  /** the CMS chapters of the file's subject */
  chapters: { chapter_id: string; name: string }[];
  /** lower-case names of live (not retired) courses → course_id */
  courseNames: Map<string, string>;
  /** replace this draft (null = a new course) */
  replace: { course_id: string; name: string; board_id: string; class: number; subject: string; status: string; outline: Outline } | null;
}
export interface UploadHead { name: string; board_id: string; class: number; subject: 'math' | 'science' }
export interface UploadResult { head: UploadHead | null; outline: Outline; problems: UploadProblem[] }

const s = (c: Cell | undefined) => (c === null || c === undefined ? '' : String(c).trim());
const int = (c: Cell | undefined) => { const x = s(c); return /^\d{1,3}$/.test(x) ? Number(x) : null; };
const boardKey = (x: string) => x.toLowerCase().replace(/[·.\-_/\s]+/g, '');

/** Find a sheet by its leading number ("4 Display topic → CMS topics", "4", "4 anything"). */
export function sheetOf(sheets: Sheets, key: SheetKey): SheetRow[] | null {
  const spec = SHEETS.find((x) => x.key === key)!;
  for (const [name, rows] of sheets) if (new RegExp(`^\\s*${spec.n}(\\b|\\s|$)`).test(name)) return rows;
  return null;
}

/** Sheet 1 alone (the web app loads the subject's CMS topics before the full check). */
export function readCourseSheet(sheets: Sheets, boards: UploadBoard[]): { head: UploadHead | null; problems: UploadProblem[] } {
  const problems: UploadProblem[] = [];
  const sheet = '1 Course';
  const rows = sheetOf(sheets, 'course');
  if (!rows) return { head: null, problems: [{ level: 'error', sheet, message: 'Sheet "1 Course" is missing.' }] };
  const r = rows[0];
  if (!r) return { head: null, problems: [{ level: 'error', sheet, message: 'Sheet "1 Course" has no course row.' }] };
  const name = s(r.values.course_name), boardTxt = s(r.values.board), cls = int(r.values.class), subj = s(r.values.subject).toLowerCase();
  if (!name) problems.push({ level: 'error', sheet, row: r.row, message: 'course_name is empty.' });
  const board = boards.find((b) => boardKey(b.label) === boardKey(boardTxt) || b.board_id.toLowerCase() === boardTxt.toLowerCase());
  if (!board) problems.push({ level: 'error', sheet, row: r.row, message: `Board "${boardTxt}" is not in the board list (${boards.filter((b) => b.status === 'active').map((b) => b.label).join(', ')}).` });
  else if (board.status !== 'active') problems.push({ level: 'error', sheet, row: r.row, message: `Board "${board.label}" is retired.` });
  if (cls === null || cls < 1 || cls > 6) problems.push({ level: 'error', sheet, row: r.row, message: `class must be 1–6 (it is "${s(r.values.class)}").` });
  if (subj !== 'math' && subj !== 'science') problems.push({ level: 'error', sheet, row: r.row, message: `subject must be Math or Science (it is "${s(r.values.subject)}").` });
  if (problems.length) return { head: null, problems };
  return { head: { name, board_id: board!.board_id, class: cls!, subject: subj as UploadHead['subject'] }, problems };
}

/** Parse and check the whole file. The outline is what would be saved (with the draft's IDs when replacing). */
export function parseUpload(sheets: Sheets, ctx: UploadContext): UploadResult {
  const { head, problems } = readCourseSheet(sheets, ctx.boards);
  const P = (level: UploadProblem['level'], sheet: string, row: number | undefined, message: string) => problems.push({ level, sheet, row, message });
  const outline: Outline = { chapters: [] };
  if (!head) return { head, outline, problems };
  const cls = head.class, subject = head.subject;
  const rows = (k: SheetKey) => { const r = sheetOf(sheets, k); if (!r && k !== 'achievers') P('error', SHEETS.find((x) => x.key === k)!.name, undefined, `Sheet "${SHEETS.find((x) => x.key === k)!.name}" is missing.`); return r ?? []; };

  // course: new vs replace
  if (ctx.replace) {
    const t = ctx.replace;
    if (t.status !== 'draft') P('error', '1 Course', undefined, `${t.course_id} is ${t.status}; only a draft can be replaced.`);
    if (t.subject !== subject) P('error', '1 Course', undefined, `The file is for ${subject}, ${t.course_id} is ${t.subject}.`);
    if (t.class !== cls) P('error', '1 Course', undefined, `The file is for Class ${cls}, ${t.course_id} is Class ${t.class}.`);
    if (t.board_id !== head.board_id) P('error', '1 Course', undefined, `The file's board differs from ${t.course_id}'s board.`);
    if (t.name.toLowerCase() !== head.name.toLowerCase()) P('warn', '1 Course', undefined, `The file says "${head.name}"; the draft keeps its name "${t.name}".`);
  } else if (ctx.courseNames.has(head.name.toLowerCase())) {
    P('error', '1 Course', undefined, `A course called "${head.name}" already exists (${ctx.courseNames.get(head.name.toLowerCase())}). Rename it in the file, or choose "Replace a draft".`);
  }

  // 2 chapters
  const S2 = '2 Display chapters';
  const chs = new Map<number, { name: string; row: number }>();
  for (const r of rows('chapters')) {
    const no = int(r.values.chapter_no), name = s(r.values.chapter_name);
    if (no === null || no < 1) { P('error', S2, r.row, `chapter_no "${s(r.values.chapter_no)}" is not a number ≥ 1.`); continue; }
    if (chs.has(no)) { P('error', S2, r.row, `chapter_no ${no} is used twice (rows ${chs.get(no)!.row} and ${r.row}).`); continue; }
    if (!name) { P('error', S2, r.row, `Chapter ${no} has no name.`); continue; }
    if (name.length > 120) { P('error', S2, r.row, `Chapter ${no}: the name is over 120 characters.`); continue; }
    chs.set(no, { name, row: r.row });
  }
  const chNos = [...chs.keys()].sort((a, b) => a - b);
  if (chNos.some((n, i) => n !== i + 1)) P('warn', S2, undefined, `Chapter numbers have gaps (${chNos.join(', ')}); they are renumbered 1–${chNos.length}.`);

  // 3 topics
  const S3 = '3 Display topics';
  const tps = new Map<string, { ch: number; no: number; name: string; row: number }>();
  for (const r of rows('topics')) {
    const ch = int(r.values.chapter_no), no = int(r.values.topic_no), name = s(r.values.display_topic_name);
    if (ch === null || no === null || no < 1) { P('error', S3, r.row, 'chapter_no and topic_no must be numbers.'); continue; }
    if (!chs.has(ch)) { P('error', S3, r.row, `Topic ${ch}.${no}: there is no chapter ${ch} in sheet 2.`); continue; }
    const k = `${ch}.${no}`;
    if (tps.has(k)) { P('error', S3, r.row, `Topic ${k} is listed twice (rows ${tps.get(k)!.row} and ${r.row}).`); continue; }
    if (!name) { P('error', S3, r.row, `Topic ${k} has no name.`); continue; }
    if (name.length > 120) { P('error', S3, r.row, `Topic ${k}: the name is over 120 characters.`); continue; }
    tps.set(k, { ch, no, name, row: r.row });
  }

  // 4 items
  const S4 = '4 Display topic → CMS topics';
  const items = new Map<string, { order: number; id: string; row: number }[]>();
  const usedAt = new Map<string, { k: string; row: number }>();
  for (const r of rows('items')) {
    const ch = int(r.values.chapter_no), no = int(r.values.topic_no), order = int(r.values.order) ?? 999;
    const id = s(r.values.cms_topic_id).toUpperCase(), fileName = s(r.values.cms_topic_name);
    if (!id && !fileName) continue;
    const k = `${ch}.${no}`;
    if (!tps.has(k)) { P('error', S4, r.row, `${id || '(no ID)'}: there is no display topic ${k} in sheet 3.`); continue; }
    if (!id) { P('error', S4, r.row, `Topic ${k}: cms_topic_id is empty.`); continue; }
    const info = ctx.topics.get(id);
    if (!info) { P('error', S4, r.row, /^ACH-/.test(id) ? `${id} is an Achievers topic; put its CMS chapter in sheet 5.` : `Unknown CMS topic ID ${id}${/^(MT|ST|GT)\d{4}$/.test(id) ? ` (not a ${subject} topic)` : ''}.`); continue; }
    if (info.kind !== 'normal') { P('error', S4, r.row, `${id} is an Achievers topic; put its CMS chapter in sheet 5.`); continue; }
    if (info.status !== 'active') { P('error', S4, r.row, `${id} (${info.name}) is retired.`); continue; }
    if (usedAt.has(id)) { P('error', S4, r.row, `${id} (${info.name}) is used twice in the course: ${usedAt.get(id)!.k} (row ${usedAt.get(id)!.row}) and ${k} (row ${r.row}).`); continue; }
    usedAt.set(id, { k, row: r.row });
    if (fileName && fileName.toLowerCase() !== info.name.toLowerCase()) P('warn', S4, r.row, `${id}: the file says "${fileName}", the CMS says "${info.name}" (the ID wins).`);
    items.set(k, [...(items.get(k) ?? []), { order, id, row: r.row }]);
  }

  // 5 achievers
  const S5 = '5 Achievers CMS chapters';
  const ach = new Map<number, { order: number; id: string; row: number }[]>();
  const achAt = new Map<string, number>();
  for (const r of rows('achievers')) {
    const ch = int(r.values.chapter_no), order = int(r.values.order) ?? 999, id = s(r.values.cms_chapter_id).toUpperCase();
    if (!id) continue;
    if (ch === null || !chs.has(ch)) { P('error', S5, r.row, `${id}: there is no chapter ${s(r.values.chapter_no)} in sheet 2.`); continue; }
    if (subject !== 'math') { P('error', S5, r.row, 'Science has no Achievers topics yet; leave sheet 5 empty.'); continue; }
    const c = ctx.chapters.find((x) => x.chapter_id === id);
    if (!c) { P('error', S5, r.row, `Unknown CMS chapter ${id}${/^(MC|SC|GC)\d{2}$/.test(id) ? ` (not a ${subject} chapter)` : ''}.`); continue; }
    if (achAt.has(id)) { P('error', S5, r.row, `${id} (${c.name}) is used twice: chapters ${achAt.get(id)} and ${ch}.`); continue; }
    achAt.set(id, ch);
    const a = ctx.topics.get(achId(id, cls));
    if (!a || a.status !== 'active') P('warn', S5, r.row, `${id} (${c.name}) has no Achievers topic for Class ${cls} (${achId(id, cls)}); Publish will be blocked until it's removed.`);
    ach.set(ch, [...(ach.get(ch) ?? []), { order, id, row: r.row }]);
  }

  // build the outline (IDs by position when replacing)
  const old = ctx.replace?.outline.chapters ?? [];
  chNos.forEach((no, ci) => {
    const oc = old[ci];
    const tNos = [...tps.values()].filter((t) => t.ch === no).sort((a, b) => a.no - b.no);
    if (tNos.some((t, i) => t.no !== i + 1)) P('warn', S3, undefined, `Chapter ${no}: topic numbers have gaps (${tNos.map((t) => t.no).join(', ')}); renumbered.`);
    if (!tNos.length) P('warn', S3, undefined, `Chapter ${no} "${chs.get(no)!.name}" has no display topics.`);
    let a = (ach.get(no) ?? []).sort((x, y) => x.order - y.order || x.row - y.row).map((x) => x.id);
    if (a.length > MAX_ACHIEVERS_PER_CHAPTER) { P('warn', S5, undefined, `Chapter ${no}: ${a.length} Achievers chapters; only the first ${MAX_ACHIEVERS_PER_CHAPTER} by order are saved (not saved: ${a.slice(MAX_ACHIEVERS_PER_CHAPTER).join(', ')}).`); a = a.slice(0, MAX_ACHIEVERS_PER_CHAPTER); }
    outline.chapters.push({
      ...(oc?.id ? { id: oc.id } : {}), name: chs.get(no)!.name, achievers: a,
      topics: tNos.map((t, ti) => {
        let cms = (items.get(`${no}.${t.no}`) ?? []).sort((x, y) => x.order - y.order || x.row - y.row).map((x) => x.id);
        if (cms.length > MAX_CMS_PER_TOPIC) { P('warn', S4, undefined, `Topic ${no}.${t.no}: ${cms.length} CMS topics; only the first ${MAX_CMS_PER_TOPIC} by order are saved (not saved: ${cms.slice(MAX_CMS_PER_TOPIC).join(', ')}).`); cms = cms.slice(0, MAX_CMS_PER_TOPIC); }
        if (!cms.length) P('warn', S4, undefined, `Topic ${no}.${t.no} "${t.name}" has no CMS topics (Publish will be blocked until it has one).`);
        const ot = oc?.topics[ti];
        return { ...(ot?.id ? { id: ot.id } : {}), name: t.name, cms };
      }),
    });
  });
  return { head, outline, problems };
}

/** What a save of `next` changes compared with `prev` (preview before "Replace a draft"). */
export function outlineDiff(prev: Outline, next: Outline) {
  const d = { chaptersAdded: 0, chaptersRenamed: 0, chaptersRetired: 0, topicsAdded: 0, topicsRenamed: 0, topicsRetired: 0, linksAdded: 0, linksRemoved: 0, achieversChanged: 0 };
  const prevCh = new Map(prev.chapters.map((c) => [c.id, c]));
  const nextChIds = new Set(next.chapters.map((c) => c.id).filter(Boolean));
  const prevTp = new Map(prev.chapters.flatMap((c) => c.topics.map((t) => [t.id, t] as const)));
  const nextTpIds = new Set(next.chapters.flatMap((c) => c.topics.map((t) => t.id)).filter(Boolean));
  for (const c of next.chapters) {
    const p = c.id ? prevCh.get(c.id) : undefined;
    if (!p) d.chaptersAdded++; else if (p.name !== c.name) d.chaptersRenamed++;
    if (JSON.stringify(p?.achievers ?? []) !== JSON.stringify(c.achievers)) d.achieversChanged++;
    for (const t of c.topics) { const pt = t.id ? prevTp.get(t.id) : undefined; if (!pt) d.topicsAdded++; else if (pt.name !== t.name) d.topicsRenamed++; }
  }
  d.chaptersRetired = prev.chapters.filter((c) => !nextChIds.has(c.id)).length;
  d.topicsRetired = [...prevTp.keys()].filter((id) => !nextTpIds.has(id)).length;
  const before = new Set(prev.chapters.flatMap((c) => c.topics.flatMap((t) => t.cms)));
  const after = new Set(next.chapters.flatMap((c) => c.topics.flatMap((t) => t.cms)));
  d.linksAdded = [...after].filter((x) => !before.has(x)).length;
  d.linksRemoved = [...before].filter((x) => !after.has(x)).length;
  return d;
}

/** The template's sheets as rows of cells (row 1 = header), optionally filled from a course. Sheet 6 lists the subject's
 *  active normal CMS topics, those linked to the class first, with questions at Level ≤ class and where each is placed. */
export function templateSheets(o: {
  head?: { name: string; board_label: string; class: number; subject: 'math' | 'science' } | null; cls: number; outline?: Outline | null;
  topics: Map<string, TopicInfo>; chapters: { chapter_id: string; name: string; strand_id: string }[]; strands: { strand_id: string; name: string }[];
  notes?: { topics?: Record<string, string>; items?: Record<string, string>; chapters?: Record<number, string> };
}): { name: string; columns: string[]; rows: Cell[][] }[] {
  const out = o.outline ?? { chapters: [] };
  const where = new Map<string, string>();
  out.chapters.forEach((c, ci) => c.topics.forEach((t, ti) => t.cms.forEach((id) => where.set(id, `${ci + 1}.${ti + 1} ${t.name}`))));
  const note = (k: string, m?: Record<string, string>) => (m && m[k] ? [m[k]!] : []);
  const withNotes = (cols: readonly string[], has: boolean) => (has ? [...cols, 'notes'] : [...cols]);
  const sh = (k: SheetKey) => SHEETS.find((x) => x.key === k)!;
  const chName = (id: string) => o.chapters.find((c) => c.chapter_id === id);
  const cmsRows = [...o.topics.values()].filter((t) => t.kind === 'normal' && t.status === 'active')
    .sort((a, b) => Number(!a.classes.includes(o.cls)) - Number(!b.classes.includes(o.cls)) || a.chapter_id.localeCompare(b.chapter_id) || a.home_class - b.home_class || a.topic_id.localeCompare(b.topic_id))
    .map((t) => { const c = chName(t.chapter_id); return [t.topic_id, t.name, o.strands.find((s2) => s2.strand_id === c?.strand_id)?.name ?? '', t.chapter_id, c?.name ?? '', t.home_class,
      !t.classes.includes(o.cls) ? '–' : t.home_class === o.cls ? 'core' : t.home_class < o.cls ? 'lower' : 'higher', countFor(t.counts, o.cls).n, where.get(t.topic_id) ?? ''] as Cell[]; });
  return [
    { name: sh('course').name, columns: [...sh('course').columns], rows: o.head ? [[o.head.name, o.head.board_label, o.head.class, o.head.subject === 'math' ? 'Math' : 'Science']] : [] },
    { name: sh('chapters').name, columns: withNotes(sh('chapters').columns, !!o.notes?.chapters), rows: out.chapters.map((c, ci) => [ci + 1, c.name, ...(o.notes?.chapters ? [o.notes.chapters[ci + 1] ?? ''] : [])]) },
    { name: sh('topics').name, columns: withNotes(sh('topics').columns, !!o.notes?.topics), rows: out.chapters.flatMap((c, ci) => c.topics.map((t, ti) => [ci + 1, ti + 1, t.name, ...(o.notes?.topics ? [o.notes.topics[`${ci + 1}.${ti + 1}`] ?? ''] : [])])) },
    { name: sh('items').name, columns: withNotes(sh('items').columns, !!o.notes?.items), rows: out.chapters.flatMap((c, ci) => c.topics.flatMap((t, ti) => t.cms.map((id, k) => [ci + 1, ti + 1, k + 1, id, o.topics.get(id)?.name ?? '',
      ...(o.notes?.items ? [note(`${ci + 1}.${ti + 1}.${id}`, o.notes.items)[0] ?? ''] : [])]))) },
    { name: sh('achievers').name, columns: [...sh('achievers').columns], rows: out.chapters.flatMap((c, ci) => c.achievers.map((a, k) => [ci + 1, k + 1, a])) },
    { name: sh('cms').name, columns: [...sh('cms').columns], rows: cmsRows },
  ];
}

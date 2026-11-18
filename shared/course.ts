// Course builder (Q13, Sambit 16–18 Nov 2026; docs/plan-2026-11-18-q13-course-builder.md).
// Pure logic shared by the web app (screens 2–4; later the Excel upload, clone and compare) and the tests.
//
// Course → display chapters → display topics → 1–4 CMS topics. A CMS topic sits in at most one display topic per
// course. Questions shown for a course = questions of its CMS topics with Level ≤ course class (never higher).
// Achievers section (Math only): 1–4 CMS chapters per display chapter → ACH-<chapter>-<course class>.

export const MAX_CMS_PER_TOPIC = 4;
export const MAX_ACHIEVERS_PER_CHAPTER = 4;

export interface OTopic { id?: string; name: string; cms: string[] }
export interface OChapter { id?: string; name: string; achievers: string[]; topics: OTopic[] }
export interface Outline { chapters: OChapter[] }
export interface CourseHead { course_id?: string; name: string; board_id: string; class: number; subject: 'math' | 'science'; status: 'draft' | 'published' | 'retired'; rev?: number }

/** Questions of one CMS topic by Level: level → { n, approved } (counted questions only: production, not retired). */
export type LevelCounts = Record<number, { n: number; approved: number }>;
export interface TopicInfo {
  topic_id: string; name: string; chapter_id: string; home_class: number; status: string; kind: 'normal' | 'achievers';
  /** classes this topic is taught in (home + approved links) */
  classes: number[];
  counts: LevelCounts;
}

export const achId = (chapterId: string, cls: number) => `ACH-${chapterId}-${cls}`;

/** Questions at Level ≤ cls (and how many are approved / left out above the class). */
export function countFor(counts: LevelCounts | undefined, cls: number) {
  let n = 0, approved = 0, above = 0;
  for (const [lv, c] of Object.entries(counts ?? {})) {
    if (Number(lv) <= cls) { n += c.n; approved += c.approved; } else above += c.n;
  }
  return { n, approved, above };
}

/** Display numbers from positions: chapter "3", topic "3.2". */
export const chapterNo = (ci: number) => `${ci + 1}`;
export const topicNo = (ci: number, ti: number) => `${ci + 1}.${ti + 1}`;

/** Where each CMS topic and each Achievers chapter sits in the outline: id → "3.2 Name" / "3 Name". */
export function placements(o: Outline) {
  const topics = new Map<string, { ci: number; ti: number; label: string }>();
  const achievers = new Map<string, { ci: number; label: string }>();
  o.chapters.forEach((c, ci) => {
    c.achievers.forEach((a) => achievers.set(a, { ci, label: `${chapterNo(ci)} ${c.name}` }));
    c.topics.forEach((t, ti) => t.cms.forEach((id) => topics.set(id, { ci, ti, label: `${topicNo(ci, ti)} ${t.name}` })));
  });
  return { topics, achievers };
}

export type CheckLevel = 'error' | 'warn' | 'info';
export interface CourseCheck {
  level: CheckLevel;
  kind: 'no_chapters' | 'chapter_empty' | 'topic_empty' | 'topic_retired' | 'topic_unknown' | 'topic_twice' | 'too_many' | 'achievers_missing' | 'achievers_twice'
    | 'core_unplaced' | 'topic_few' | 'extra_unplaced' | 'achievers_zero' | 'above_class';
  message: string;
  /** where to fix it: chapter index, topic index */
  ci?: number; ti?: number;
  ids?: string[];
}

export interface CheckContext {
  cls: number;
  subject: 'math' | 'science';
  /** every CMS topic of the subject (active and retired, normal and Achievers) */
  topics: Map<string, TopicInfo>;
  minQuestions: number;
}

/** All checks of a course outline. Errors (✗) block Publish; warnings (!) and info (i) never block.
 *  The errors are the same as cms.cms_course_errors() in the DB (0045). */
export function courseChecks(o: Outline, ctx: CheckContext): CourseCheck[] {
  const out: CourseCheck[] = [];
  const { cls } = ctx;
  if (!o.chapters.length) out.push({ level: 'error', kind: 'no_chapters', message: 'The course has no display chapters.' });
  const seen = new Map<string, string>();
  const seenAch = new Map<string, string>();
  o.chapters.forEach((c, ci) => {
    const cLabel = `${chapterNo(ci)} ${c.name}`;
    if (!c.topics.length) out.push({ level: 'error', kind: 'chapter_empty', message: `Chapter ${cLabel} has no display topics.`, ci });
    c.topics.forEach((t, ti) => {
      const tLabel = `${topicNo(ci, ti)} ${t.name}`;
      if (!t.cms.length) out.push({ level: 'error', kind: 'topic_empty', message: `Display topic ${tLabel} has no CMS topics.`, ci, ti });
      if (t.cms.length > MAX_CMS_PER_TOPIC) out.push({ level: 'error', kind: 'too_many', message: `Display topic ${tLabel} has ${t.cms.length} CMS topics (at most ${MAX_CMS_PER_TOPIC}).`, ci, ti });
      let n = 0;
      for (const id of t.cms) {
        const info = ctx.topics.get(id);
        if (!info || info.kind !== 'normal') { out.push({ level: 'error', kind: 'topic_unknown', message: `${id} in ${tLabel} is not a ${ctx.subject} topic.`, ci, ti, ids: [id] }); continue; }
        if (info.status !== 'active') out.push({ level: 'error', kind: 'topic_retired', message: `${info.name} (${id}) in ${tLabel} has been retired.`, ci, ti, ids: [id] });
        if (seen.has(id)) out.push({ level: 'error', kind: 'topic_twice', message: `${info.name} (${id}) is in ${seen.get(id)} and ${tLabel}.`, ci, ti, ids: [id] });
        seen.set(id, tLabel);
        const k = countFor(info.counts, cls);
        n += k.n;
        if (k.above) out.push({ level: 'info', kind: 'above_class', message: `${info.name} (${id}): ${k.above} question${k.above === 1 ? '' : 's'} with Level > ${cls} are not shown.`, ci, ti, ids: [id] });
      }
      if (t.cms.length && n < ctx.minQuestions) out.push({ level: 'warn', kind: 'topic_few', message: `Display topic ${tLabel} has ${n} question${n === 1 ? '' : 's'} at Level ≤ ${cls} (fewer than ${ctx.minQuestions}).`, ci, ti });
    });
    c.achievers.forEach((ch) => {
      if (seenAch.has(ch)) out.push({ level: 'error', kind: 'achievers_twice', message: `The Achievers of ${ch} are in ${seenAch.get(ch)} and ${cLabel}.`, ci, ids: [ch] });
      seenAch.set(ch, cLabel);
      const a = ctx.topics.get(achId(ch, cls));
      if (!a || a.status !== 'active') { out.push({ level: 'error', kind: 'achievers_missing', message: `Chapter ${cLabel}: ${achId(ch, cls)} doesn't exist${a ? ' (retired)' : ''}.`, ci, ids: [achId(ch, cls)] }); return; }
      const k = countFor(a.counts, cls);
      if (!k.n) out.push({ level: 'info', kind: 'achievers_zero', message: `Chapter ${cLabel}: ${a.name} (${a.topic_id}) has no questions at Level ≤ ${cls} yet.`, ci, ids: [a.topic_id] });
    });
  });
  // class-N topics not placed anywhere: core (home class N) = warning; extra (lower / higher class) = info
  const core: string[] = [], extra: string[] = [];
  for (const t of ctx.topics.values()) {
    if (t.kind !== 'normal' || t.status !== 'active' || !t.classes.includes(cls) || seen.has(t.topic_id)) continue;
    (t.home_class === cls ? core : extra).push(t.topic_id);
  }
  if (core.length) out.push({ level: 'warn', kind: 'core_unplaced', message: `${core.length} Class ${cls} core topic${core.length === 1 ? ' is' : 's are'} not placed in the course.`, ids: core.sort() });
  if (extra.length) out.push({ level: 'info', kind: 'extra_unplaced', message: `${extra.length} topic${extra.length === 1 ? '' : 's'} from a lower or higher class linked to Class ${cls} ${extra.length === 1 ? 'is' : 'are'} not placed.`, ids: extra.sort() });
  return out;
}

export const blocksPublish = (checks: CourseCheck[]) => checks.some((c) => c.level === 'error');

/** Totals for the Review screen. */
export function courseTotals(o: Outline, ctx: CheckContext) {
  let topics = 0, cms = 0, n = 0, approved = 0, ach = 0, achApproved = 0;
  for (const c of o.chapters) {
    topics += c.topics.length;
    for (const t of c.topics) for (const id of t.cms) { cms++; const k = countFor(ctx.topics.get(id)?.counts, ctx.cls); n += k.n; approved += k.approved; }
    for (const ch of c.achievers) { const k = countFor(ctx.topics.get(achId(ch, ctx.cls))?.counts, ctx.cls); ach += k.n; achApproved += k.approved; }
  }
  return { chapters: o.chapters.length, topics, cms, questions: n, approved, achievers: ach, achieversApproved: achApproved };
}

/** Move an item within a list (drag and drop / ↑ ↓). */
export function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const out = list.slice();
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, x!);
  return out;
}

/** Same outline (for "unsaved changes"). */
export const sameOutline = (a: Outline, b: Outline) => JSON.stringify(a) === JSON.stringify(b);

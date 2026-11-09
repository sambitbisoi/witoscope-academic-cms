// Pure parsing and checks for the master topic lists (design §2A, plan §4–5).
// No database access here, so it is fully unit-testable.
import type { Cell, Row } from './xlsx.ts';
import { stableJson } from '../../shared/json.ts';
export { stableJson };

export type Subject = 'math' | 'science' | 'grammar';
export const CHAPTER_PREFIX: Record<Subject, string> = { math: 'MC', science: 'SC', grammar: 'GC' };
export const TOPIC_PREFIX: Record<Subject, string> = { math: 'MT', science: 'ST', grammar: 'GT' };
export const SUBJECT_LABEL: Record<Subject, string> = { math: 'Math', science: 'Science', grammar: 'English' };

export interface Strand { strand_id: string; subject: Subject; code: string; name: string; sort: number }
export interface Chapter { chapter_id: string; subject: Subject; strand_id: string; name: string; display_code: string | null; scope: string | null; sort: number; status: 'active' }
export interface Topic {
  topic_id: string; chapter_id: string; class: number; seq: number | null; name: string; level: number | null;
  sub_skills: string | null; topic_kind: 'normal' | 'achievers'; taught_in_school: boolean;
  source_flags: Record<string, string>; notes: string | null; status: 'active' | 'retired';
}
export interface Problem { level: 'error' | 'warning'; where: string; message: string }
export interface Parsed { strands: Strand[]; chapters: Chapter[]; topics: Topic[]; problems: Problem[] }

const NONE = new Set(['–', '-', '—', 'n/a', 'none']);
const str = (c: Cell | undefined) => (c === null || c === undefined ? null : String(c).trim() || null);
const int = (c: Cell | undefined) => {
  if (c === null || c === undefined || c === '') return null;
  const n = Number(c);
  return Number.isInteger(n) ? n : NaN;
};

/** "Classes – NCERT" → "ncert"; returns null for non-source columns. */
export function sourceKey(header: string): string | null {
  const m = /^Classes\s*[–-]\s*(.+)$/.exec(header);
  return m ? m[1]!.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') : null;
}

export function parseSubject(subject: Subject, sheets: Map<string, Row[]>): Parsed {
  const label = SUBJECT_LABEL[subject];
  const problems: Problem[] = [];
  const err = (where: string, message: string) => problems.push({ level: 'error', where: `${label} · ${where}`, message });
  const warn = (where: string, message: string) => problems.push({ level: 'warning', where: `${label} · ${where}`, message });

  const need = (name: string) => {
    const s = sheets.get(name);
    if (!s) err('workbook', `sheet "${name}" is missing`);
    return s ?? [];
  };
  const masterChapters = need('Master Chapters');
  const masterTopics = need('Master Topics');
  const classView = need('Class View');

  // --- strands and chapters (Master Chapters)
  const strands = new Map<string, Strand>();
  const chapters = new Map<string, Chapter>();
  masterChapters.forEach(({ row, values: v }, i) => {
    const where = `Master Chapters row ${row}`;
    const id = str(v['Chapter ID']);
    const code = str(v['Strand Code']);
    const strandName = str(v['Strand']);
    const name = str(v['Chapter']);
    if (!id || !code || !strandName || !name) return err(where, 'needs Chapter ID, Strand Code, Strand and Chapter');
    if (!new RegExp(`^${CHAPTER_PREFIX[subject]}[0-9]{2}$`).test(id)) return err(where, `chapter ID ${id} should look like ${CHAPTER_PREFIX[subject]}01`);
    if (chapters.has(id)) return err(where, `chapter ${id} appears twice`);
    const strand_id = `${subject}-${code}`;
    const existing = strands.get(strand_id);
    if (!existing) strands.set(strand_id, { strand_id, subject, code, name: strandName, sort: strands.size + 1 });
    else if (existing.name !== strandName) err(where, `strand code ${code} is "${existing.name}" elsewhere but "${strandName}" here`);
    chapters.set(id, { chapter_id: id, subject, strand_id, name, display_code: str(v['Display Code']), scope: str(v['Scope (what belongs here)']), sort: i + 1, status: 'active' });
  });

  // --- Class View: class and seq per topic
  const placement = new Map<string, { class: number; seq: number | null; name: string | null; strand: string | null; chapter: string | null; row: number }>();
  for (const { row, values: v } of classView) {
    const where = `Class View row ${row}`;
    const id = str(v['Topic ID']);
    const cls = int(v['Class']);
    if (!id) { err(where, 'Topic ID is empty'); continue; }
    if (cls === null || Number.isNaN(cls) || cls < 1 || cls > 6) { err(where, `${id}: class must be 1–6, got "${v['Class']}"`); continue; }
    if (placement.has(id)) { err(where, `${id} is listed twice (also row ${placement.get(id)!.row})`); continue; }
    const seq = int(v['Seq']);
    placement.set(id, { class: cls, seq: Number.isNaN(seq) ? null : seq, name: str(v['Topic']), strand: str(v['Strand']), chapter: str(v['Chapter ID']), row });
  }

  // --- topics (Master Topics, including retired)
  const topics = new Map<string, Topic>();
  const classCol = subject === 'grammar' ? 'Class (placement)' : 'Reference Grade';
  for (const { row, values: v } of masterTopics) {
    const where = `Master Topics row ${row}`;
    const id = str(v['Topic ID']);
    const chapterId = str(v['Chapter ID']);
    const name = str(v['Topic']);
    if (!id || !chapterId || !name) { err(where, 'needs Topic ID, Chapter ID and Topic'); continue; }
    if (!new RegExp(`^${TOPIC_PREFIX[subject]}[0-9]{4}$`).test(id)) { err(where, `topic ID ${id} should look like ${TOPIC_PREFIX[subject]}0001`); continue; }
    if (topics.has(id)) { err(where, `topic ${id} appears twice`); continue; }
    const chapter = chapters.get(chapterId);
    if (!chapter) { err(where, `${id}: chapter ${chapterId} is not in Master Chapters`); continue; }

    const rawStatus = (str(v['Status']) ?? 'Active').toLowerCase();
    if (rawStatus !== 'active' && rawStatus !== 'retired') { err(where, `${id}: status must be Active or Retired, got "${v['Status']}"`); continue; }
    const status = rawStatus as 'active' | 'retired';

    const cv = placement.get(id);
    const masterClass = int(v[classCol]);
    let cls: number | null = cv?.class ?? null;
    if (!cv) {
      if (status === 'active') { err(where, `${id} is Active but not in Class View`); continue; }
      // Approved rule C: retired topics take their class from Reference Grade / Class (placement).
      cls = masterClass !== null && !Number.isNaN(masterClass) ? masterClass : null;
      if (cls === null || cls < 1 || cls > 6) { err(where, `${id} is Retired, not in Class View, and has no valid ${classCol}`); continue; }
    } else {
      if (status === 'retired') warn(`Class View row ${cv.row}`, `${id} is Retired in Master Topics but still in Class View`);
      if (masterClass !== null && masterClass !== cv.class) warn(where, `${id}: Class View says class ${cv.class}, ${classCol} says ${masterClass}; using Class View`);
      if (cv.name && cv.name !== name) warn(where, `${id}: name differs from Class View ("${cv.name}"); using Master Topics`);
      if (cv.chapter && cv.chapter !== chapterId) err(where, `${id}: chapter ${chapterId} here but ${cv.chapter} in Class View`);
      const chapterStrand = strands.get(chapter.strand_id)!.name;
      if (cv.strand && cv.strand !== chapterStrand) warn(`Class View row ${cv.row}`, `${id}: strand "${cv.strand}" but its chapter's strand is "${chapterStrand}"`);
    }

    const source_flags: Record<string, string> = {};
    for (const [header, cell] of Object.entries(v)) {
      const key = sourceKey(header);
      const value = str(cell);
      if (key && value && !NONE.has(value.toLowerCase())) source_flags[key] = value;
    }
    const level = int(v['Level']);
    topics.set(id, {
      topic_id: id, chapter_id: chapterId, class: cls!, seq: cv?.seq ?? null, name,
      level: level === null || Number.isNaN(level) ? null : level,
      sub_skills: str(v['Sub-skills']), topic_kind: 'normal',
      // Approved rule D: taught in school = NCERT or DAV column not "–".
      taught_in_school: 'ncert' in source_flags || 'dav' in source_flags,
      source_flags, notes: str(v['Notes']), status,
    });
  }
  for (const [id, cv] of placement) {
    if (!topics.has(id)) err(`Class View row ${cv.row}`, `${id} is not in Master Topics`);
  }

  return { strands: [...strands.values()], chapters: [...chapters.values()], topics: [...topics.values()], problems };
}

/**
 * Decision 4: one Achievers topic per chapter and class, ID ACH-<chapter>-<class>.
 * Created for each chapter-class pair that has at least one active topic.
 * Math only for now (Sambit, 8 Nov 2026): Science and English get Achievers rows
 * once those subjects have an Achiever rule.
 */
export const ACHIEVERS_SUBJECTS: readonly Subject[] = ['math'];

export function achieversTopics(chapters: Chapter[], topics: Topic[]): Topic[] {
  const pairs = new Map<string, { chapter: Chapter; cls: number }>();
  const byId = new Map(chapters.map((c) => [c.chapter_id, c]));
  for (const t of topics) {
    if (t.status !== 'active' || t.topic_kind !== 'normal') continue;
    const chapter = byId.get(t.chapter_id)!;
    if (!ACHIEVERS_SUBJECTS.includes(chapter.subject)) continue;
    pairs.set(`${t.chapter_id}-${t.class}`, { chapter, cls: t.class });
  }
  return [...pairs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, { chapter, cls }]) => ({
    topic_id: `ACH-${chapter.chapter_id}-${cls}`, chapter_id: chapter.chapter_id, class: cls, seq: null,
    name: `Achievers: ${chapter.name}`, level: null, sub_skills: null, topic_kind: 'achievers',
    taught_in_school: false, source_flags: {}, notes: null, status: 'active',
  }));
}

/** Field-level diff for re-imports: returns only fields whose values differ. */
export function diffRow<T extends object>(before: Partial<T>, after: T): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of Object.keys(after) as (keyof T)[]) {
    if (stableJson(before[k]) !== stableJson(after[k])) out[k as string] = { before: before[k] ?? null, after: after[k] };
  }
  return out;
}

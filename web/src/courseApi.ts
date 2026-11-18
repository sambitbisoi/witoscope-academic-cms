// Course builder (Q13, 18 Nov 2026): reads (through RLS as the admin) and the four audited save functions of 0045.
import { all, topicsWithClasses } from './api';
import { supabase } from './supabase';
import type { CourseHead, LevelCounts, Outline, TopicInfo } from '../../shared/course.ts';

const must = <T>(r: { data: T | null; error: { message: string } | null }): T => { if (r.error) throw new Error(r.error.message); return r.data as T; };
const rpc = async <T>(fn: string, p: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.rpc(fn, { p });
  if (error) throw new Error(error.message);
  return data as T;
};

export interface Board { board_id: string; label: string; book: 'NCERT' | 'DAV' | null; sort: number; status: 'active' | 'retired' }
export interface CourseRow extends Omit<CourseHead, 'course_id' | 'rev'> {
  course_id: string; rev: number;
  board_label: string; book: 'NCERT' | 'DAV' | null; started_from: string | null; created_at: string; updated_at: string; published_at: string | null;
  n_chapters: number; n_topics: number; n_cms_topics: number;
}
export interface BookChapter { book: 'NCERT' | 'DAV'; book_title: string; class: number; subject: string; ch_no: number; ch_name: string }
export interface CmsChapter { chapter_id: string; name: string; strand_id: string; sort: number; status: string }
export interface Strand { strand_id: string; name: string; sort: number }

export const boards = async () => must<Board[]>(await supabase.from('cms_course_boards').select('board_id, label, book, sort, status').order('sort').order('board_id'));
export const courses = async () => must<CourseRow[]>(await supabase.from('cms_course_list').select('*').order('course_id'));
export const course = async (id: string) => must<CourseRow[]>(await supabase.from('cms_course_list').select('*').eq('course_id', id))[0] ?? null;
export const minQuestions = async () => {
  const r = must<{ value: unknown }[]>(await supabase.from('cms_config').select('value').eq('key', 'course_min_questions'));
  return Number(r[0]?.value ?? 5) || 5;
};

/** The course's active outline, with IDs, in order. */
export async function outline(courseId: string): Promise<Outline> {
  const [chs, tps, its, acs] = await Promise.all([
    supabase.from('cms_course_chapters').select('course_chapter_id, name, position').eq('course_id', courseId).eq('status', 'active').order('position'),
    supabase.from('cms_course_topics').select('course_topic_id, course_chapter_id, name, position').eq('course_id', courseId).eq('status', 'active').order('position'),
    supabase.from('cms_course_topic_items').select('course_topic_id, topic_id, position').eq('course_id', courseId).is('removed_at', null).order('position'),
    supabase.from('cms_course_achievers').select('course_chapter_id, chapter_id, position').eq('course_id', courseId).is('removed_at', null).order('position'),
  ]);
  const topics = must<{ course_topic_id: string; course_chapter_id: string; name: string }[]>(tps);
  const items = must<{ course_topic_id: string; topic_id: string }[]>(its);
  const ach = must<{ course_chapter_id: string; chapter_id: string }[]>(acs);
  return { chapters: must<{ course_chapter_id: string; name: string }[]>(chs).map((c) => ({
    id: c.course_chapter_id, name: c.name,
    achievers: ach.filter((a) => a.course_chapter_id === c.course_chapter_id).map((a) => a.chapter_id),
    topics: topics.filter((t) => t.course_chapter_id === c.course_chapter_id).map((t) => ({ id: t.course_topic_id, name: t.name, cms: items.filter((i) => i.course_topic_id === t.course_topic_id).map((i) => i.topic_id) })),
  })) };
}

/** Everything the editor needs about the CMS side of one subject: topics (with classes and question counts by Level), chapters, strands. */
export async function cmsSide(subject: 'math' | 'science') {
  const pre = subject === 'math' ? 'M' : 'S';
  const [topics, counts, chapters, strands] = await Promise.all([
    topicsWithClasses(subject),
    all<{ topic_id: string; level: number; n_questions: number; n_approved: number }>((a, b) => supabase.from('cms_topic_level_counts').select('topic_id, level, n_questions, n_approved')
      .or(`topic_id.like.${pre}T*,topic_id.like.ACH-${pre}C*`).order('topic_id').order('level').range(a, b)),
    supabase.from('cms_chapters').select('chapter_id, name, strand_id, sort, status').eq('subject', subject).order('sort'),
    supabase.from('cms_strands').select('strand_id, name, sort').eq('subject', subject).order('sort'),
  ]);
  const byTopic = new Map<string, LevelCounts>();
  for (const c of counts) byTopic.set(c.topic_id, { ...(byTopic.get(c.topic_id) ?? {}), [c.level]: { n: c.n_questions, approved: c.n_approved } });
  const info = new Map<string, TopicInfo>(topics.map((t) => [t.topic_id, {
    topic_id: t.topic_id, name: t.name, chapter_id: t.chapter_id, home_class: t.class, status: t.status, kind: t.topic_kind,
    classes: t.classes, counts: byTopic.get(t.topic_id) ?? {} } satisfies TopicInfo]));
  return { topics: info, chapters: must<CmsChapter[]>(chapters), strands: must<Strand[]>(strands) };
}
export type CmsSide = Awaited<ReturnType<typeof cmsSide>>;

export const bookChapters = async (cls: number, subject: string) =>
  must<BookChapter[]>(await supabase.from('cms_ref_book_chapters').select('book, book_title, class, subject, ch_no, ch_name').eq('class', cls).eq('subject', subject).order('book').order('ch_no'));

// ---------------------------------------------------------------- saves (each one transaction, audited in the DB)
export interface SaveResult { course_id: string; rev: number; new: boolean; chapters: { new: number; changed: number; retired: number }; topics: { new: number; changed: number; retired: number }; topic_links_changed: number; achievers_changed: number }
export const saveCourse = (p: { course_id?: string; rev?: number; source?: string; reason?: string; course?: Partial<CourseHead>; outline?: Outline }) => rpc<SaveResult>('cms_save_course', p);
export const setCourseStatus = (p: { course_id: string; rev: number; status: 'draft' | 'published' | 'retired'; reason?: string }) => rpc<{ rev: number; changed: boolean }>('cms_set_course_status', p);
export const saveBoard = (p: { action: 'create' | 'update' | 'retire' | 'restore'; id?: string; fields?: Partial<Pick<Board, 'label' | 'book' | 'sort'>> }) => rpc<{ board_id: string }>('cms_save_course_board', p);

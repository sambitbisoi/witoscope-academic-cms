// Phase 4: book citations for a chapter, and saving them (D2: insert/update only, audited).
// 10 Nov 2026: only citations live in the CMS (book, class, chapter, pages, sections, item
// numbers) plus the official public link. Book files, scans, screenshots and item text stay
// on Sambit's Mac.
import { supabase } from './supabase';

const must = <T>(r: { data: T | null; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
};

export interface ChapterSource {
  chapter_id: string; page_from: number | null; page_to: number | null; source_id: string; kind: 'pdf' | 'scanned_pdf' | 'web';
  title: string; publisher: string; class: number | null; url: string | null; page_offset: number;
  captured_at: string | null; n_items: number; n_items_in_chapter: number;
}
export interface Jump { jump_id: number; source_id: string; chapter_id: string; label: string; pdf_page: number }

export async function chapterSources(chapterId: string) {
  const [sources, jumps] = await Promise.all([
    supabase.from('cms_chapter_sources').select('*').eq('chapter_id', chapterId),
    supabase.from('cms_source_jumps').select('*').eq('chapter_id', chapterId).order('pdf_page'),
  ]);
  return { sources: must<ChapterSource[]>(sources), jumps: must<Jump[]>(jumps) };
}
export const chapterSourceCount = async (chapterId: string) => {
  const { count, error } = await supabase.from('cms_source_chapters').select('source_id', { count: 'exact', head: true }).eq('chapter_id', chapterId);
  if (error) throw new Error(error.message);
  return count ?? 0;
};

/** U17: citations per source for one topic. */
export async function topicSourceCounts(topicId: string) {
  const rows = must<{ source_id: string }[]>(await supabase.from('cms_source_items').select('source_id').eq('topic_id', topicId).limit(1000));
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.source_id, (m.get(r.source_id) ?? 0) + 1);
  return m;
}

const PUBLISHER_ORDER = ['NCERT', 'DAV', 'IXL', 'SOF', 'other'];
/** NCERT, DAV, IXL, SOF, other; within a publisher, the topic's class first, then by class and title. */
export function sortSources(list: ChapterSource[], cls: number): ChapterSource[] {
  return [...list].sort((a, b) =>
    PUBLISHER_ORDER.indexOf(a.publisher) - PUBLISHER_ORDER.indexOf(b.publisher)
    || Number(b.class === cls) - Number(a.class === cls)
    || (a.class ?? 99) - (b.class ?? 99) || a.title.localeCompare(b.title));
}

/**
 * The official public link for a source, at a PDF page if given (NCERT: ncert.nic.in).
 * Book files themselves stay on Sambit's Mac; the CMS never stores or serves them.
 */
export function officialLink(s: { url: string | null; kind: ChapterSource['kind'] }, pdfPage?: number | null): string | null {
  if (!s.url) return null;
  return pdfPage && s.kind !== 'web' ? `${s.url}#page=${pdfPage}` : s.url;
}
/** NCERT links must be official (https://ncert.nic.in/…); the database enforces it too. */
export const isOfficialNcert = (url: string) => /^https:\/\/ncert\.nic\.in\//.test(url.trim());

// ---------------------------------------------------------------- saving
export interface SourceForm {
  source_id: string; isNew: boolean; title: string; publisher: string; kind: ChapterSource['kind']; class: number | null;
  url: string; page_offset: number; captured_at: string; chapter_id: string; page_from: number | null; page_to: number | null;
  newJumps: { label: string; pdf_page: number }[];
}

export const slug = (s: string) => s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 40);
/** e.g. IXL + "IXL India, Class 6 Patterns" → IXL-INDIA-CLASS-6-PATTERNS (no doubled publisher). */
export const suggestId = (publisher: string, title: string) => {
  const p = publisher === 'other' ? 'SRC' : publisher;
  const rest = slug(title).replace(new RegExp(`^${p}-?`, 'i'), '');
  return `${p}-${rest || 'source'}`.toUpperCase();
};

export function validate(f: SourceForm): string[] {
  const e: string[] = [];
  if (!f.title.trim()) e.push('Title is required.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,60}$/.test(f.source_id)) e.push('Source ID: 3–60 letters, digits, - or _.');
  if (f.kind === 'web' && !/^https?:\/\//.test(f.url)) e.push('A web source needs a link starting with http(s)://.');
  if (f.url.trim() && !/^https?:\/\//.test(f.url.trim())) e.push('The link must start with http(s)://.');
  if (f.publisher === 'NCERT' && f.url.trim() && !isOfficialNcert(f.url)) e.push('An NCERT link must be the official one, starting https://ncert.nic.in/.');
  if (f.page_from !== null && f.page_to !== null && f.page_to < f.page_from) e.push('Pages: "to" is before "from".');
  if (!Number.isInteger(f.page_offset)) e.push('Page offset must be a whole number.');
  for (const j of f.newJumps) if (!j.label.trim() || !(j.pdf_page >= 1)) e.push('Each jump needs a label and a PDF page ≥ 1.');
  return e;
}

/** Save with an explicit button: the rows, then one audit entry. No files: books stay on the Mac. */
export async function saveSource(f: SourceForm, before: ChapterSource | null, userId: string) {
  const row = {
    source_id: f.source_id, title: f.title.trim(), publisher: f.publisher, kind: f.kind, class: f.class,
    url: f.url.trim() || null, page_offset: f.page_offset, captured_at: f.captured_at || null,
  };
  must(await (f.isNew ? supabase.from('cms_sources').insert(row) : supabase.from('cms_sources').update(row).eq('source_id', f.source_id)));
  must(await supabase.from('cms_source_chapters').upsert({ source_id: f.source_id, chapter_id: f.chapter_id, page_from: f.page_from, page_to: f.page_to }));
  if (f.newJumps.length) must(await supabase.from('cms_source_jumps').insert(f.newJumps.map((j) => ({ source_id: f.source_id, chapter_id: f.chapter_id, ...j }))));
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const [k, v] of Object.entries(row)) {
    const b = before ? (before as unknown as Record<string, unknown>)[k] ?? null : null;
    if (JSON.stringify(b) !== JSON.stringify(v)) diff[k] = { before: b, after: v };
  }
  if (f.newJumps.length) diff.jumps_added = { before: null, after: f.newJumps };
  must(await supabase.from('cms_reviews').insert({
    target: 'catalogue', target_table: 'cms_sources', target_id: f.source_id, action: 'edit_catalogue',
    reason: f.isNew ? `source added for ${f.chapter_id}` : `source edited (${f.chapter_id})`, field_diff: diff, by_user: userId, by_label: 'Sambit',
  }));
}

export const idTaken = async (id: string) =>
  (must<{ source_id: string }[]>(await supabase.from('cms_sources').select('source_id').eq('source_id', id))).length > 0;

/** Citations behind a question's source refs: book, page, section, item label (never the item's text). */
export interface Citation { ref_id: string; source_id: string; page: number | null; section: string | null; item_label: string | null; topic_id: string | null }
export async function sourceItems(refIds: string[]) {
  if (!refIds.length) return [];
  return must<Citation[]>(await supabase.from('cms_source_items').select('ref_id, source_id, page, section, item_label, topic_id').in('ref_id', refIds));
}

/** The latest local originality check of a version (citations and scores only). */
export interface OriginalityCheck { checked_at: string; result: 'clear' | 'flagged' | 'near_copy' | 'no_sources'; similarity: number | null; same_numbers: boolean; closest_ref: string | null; missing: string[] }
/** Latest check per version, for several versions (e.g. a Generate run's drafts). */
export async function latestOriginalityMany(versionIds: number[]): Promise<Map<number, OriginalityCheck>> {
  if (!versionIds.length) return new Map();
  const rows = must<(OriginalityCheck & { version_id: number })[]>(await supabase.from('cms_originality_checks')
    .select('version_id, checked_at, result, similarity, same_numbers, closest_ref, missing').in('version_id', versionIds).order('check_id', { ascending: false }));
  const m = new Map<number, OriginalityCheck>();
  for (const r of rows) if (!m.has(r.version_id)) m.set(r.version_id, r);
  return m;
}
export async function latestOriginality(versionId: number): Promise<OriginalityCheck | null> {
  const rows = must<OriginalityCheck[]>(await supabase.from('cms_originality_checks').select('checked_at, result, similarity, same_numbers, closest_ref, missing')
    .eq('version_id', versionId).order('check_id', { ascending: false }).limit(1));
  return rows[0] ?? null;
}

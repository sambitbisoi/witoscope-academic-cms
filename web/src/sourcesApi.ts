// Phase 4: sources for a chapter, opening files, and saving (D2: insert/update only, audited).
// Files live in the private R2 bucket cms-sources; Supabase keeps only metadata and each
// file's R2 key (storage_path). Files are reached only through /api/files (a Pages
// Function behind Cloudflare Access) which hands out short-lived signed URLs.
import { supabase } from './supabase';

const must = <T>(r: { data: T | null; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
};

export interface ChapterSource {
  chapter_id: string; page_from: number | null; page_to: number | null; source_id: string; kind: 'pdf' | 'scanned_pdf' | 'web' | 'screenshots';
  title: string; publisher: string; class: number | null; storage_path: string | null; url: string | null; page_offset: number;
  captured_at: string | null; n_items: number; n_items_in_chapter: number; n_assets: number;
}
export interface Jump { jump_id: number; source_id: string; chapter_id: string; label: string; pdf_page: number }
export interface Asset { asset_id: number; source_id: string; storage_path: string; caption: string | null; captured_at: string | null }

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
export const sourceAssets = async (sourceId: string) =>
  must<Asset[]>(await supabase.from('cms_source_assets').select('*').eq('source_id', sourceId).order('asset_id'));

const PUBLISHER_ORDER = ['NCERT', 'DAV', 'IXL', 'SOF', 'other'];
/** NCERT, DAV, IXL, SOF, other; within a publisher, the topic's class first, then by class and title. */
export function sortSources(list: ChapterSource[], cls: number): ChapterSource[] {
  return [...list].sort((a, b) =>
    PUBLISHER_ORDER.indexOf(a.publisher) - PUBLISHER_ORDER.indexOf(b.publisher)
    || Number(b.class === cls) - Number(a.class === cls)
    || (a.class ?? 99) - (b.class ?? 99) || a.title.localeCompare(b.title));
}

/** A 5-minute signed URL for an R2 key, from the file service (Access-checked). */
export async function signedUrl(key: string): Promise<string> {
  const r = await fetch(`/api/files/sign?key=${encodeURIComponent(key)}`, { credentials: 'include' });
  const body = await r.json().catch(() => ({})) as { url?: string; error?: string };
  if (!r.ok || !body.url) throw new Error(body.error ?? `file service answered ${r.status}`);
  return body.url;
}

/**
 * Open a source full screen in a new tab, at a PDF page if given. The tab is opened
 * synchronously (inside the click) so pop-up blockers allow it, then pointed at a
 * short-lived signed URL for stored files, or at the web link.
 */
export async function openSource(s: { storage_path: string | null; url: string | null }, pdfPage?: number | null) {
  const w = window.open('about:blank', '_blank');
  try {
    let href = s.url ?? '';
    if (s.storage_path) href = await signedUrl(s.storage_path);
    if (!href) throw new Error('This source has no file or link yet.');
    if (pdfPage) href += `#page=${pdfPage}`;
    if (w) w.location.href = href; else window.location.href = href;
  } catch (e) {
    w?.close();
    alert(`Couldn't open the source: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- saving
export interface SourceForm {
  source_id: string; isNew: boolean; title: string; publisher: string; kind: ChapterSource['kind']; class: number | null;
  url: string; page_offset: number; captured_at: string; chapter_id: string; page_from: number | null; page_to: number | null;
  file: File | null; screenshots: File[]; newJumps: { label: string; pdf_page: number }[];
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
  const isFile = f.kind === 'pdf' || f.kind === 'scanned_pdf';
  if (f.kind === 'web' && !/^https?:\/\//.test(f.url)) e.push('A web source needs a link starting with http(s)://.');
  if (isFile && f.isNew && !f.file && !/^https?:\/\//.test(f.url)) e.push('Choose a PDF, or give a link to one.');
  if (f.file && f.file.size > 50 * 1024 * 1024) e.push(`The PDF is ${(f.file.size / 1048576).toFixed(1)} MB; the limit is 50 MB. Split it per chapter.`);
  if (f.file && f.file.type && f.file.type !== 'application/pdf') e.push('Only PDF files can be uploaded as a PDF source.');
  if (f.kind === 'screenshots' && f.isNew && f.screenshots.length === 0) e.push('Add at least one screenshot.');
  for (const s of f.screenshots) if (!/^image\/(png|jpeg|webp)$/.test(s.type)) e.push(`${s.name}: screenshots must be PNG, JPEG or WebP.`);
  if (f.page_from !== null && f.page_to !== null && f.page_to < f.page_from) e.push('Pages: "to" is before "from".');
  if (!Number.isInteger(f.page_offset)) e.push('Page offset must be a whole number.');
  for (const j of f.newJumps) if (!j.label.trim() || !(j.pdf_page >= 1)) e.push('Each jump needs a label and a PDF page ≥ 1.');
  return e;
}

/** Upload one file to R2 through the file service (Access-checked; PDF/images, ≤ 50 MB). */
async function upload(key: string, file: File) {
  const r = await fetch(`/api/files/put?key=${encodeURIComponent(key)}`, {
    method: 'PUT', body: file, credentials: 'include', headers: { 'content-type': file.type || 'application/octet-stream' },
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string };
    throw new Error(`Upload of ${file.name} failed: ${body.error ?? r.status}`);
  }
}

/** Save with an explicit button: upload first, then the rows, then one audit entry. */
export async function saveSource(f: SourceForm, before: ChapterSource | null, userId: string) {
  let storage_path = before?.storage_path ?? null;
  if (f.file) { storage_path = `${f.source_id}/${f.file.name.replace(/[^\w.-]/g, '_')}`; await upload(storage_path, f.file); }
  const row = {
    source_id: f.source_id, title: f.title.trim(), publisher: f.publisher, kind: f.kind, class: f.class,
    url: f.url.trim() || null, storage_path, page_offset: f.page_offset, captured_at: f.captured_at || null,
  };
  must(await (f.isNew ? supabase.from('cms_sources').insert(row) : supabase.from('cms_sources').update(row).eq('source_id', f.source_id)));
  must(await supabase.from('cms_source_chapters').upsert({ source_id: f.source_id, chapter_id: f.chapter_id, page_from: f.page_from, page_to: f.page_to }));
  if (f.newJumps.length) must(await supabase.from('cms_source_jumps').insert(f.newJumps.map((j) => ({ source_id: f.source_id, chapter_id: f.chapter_id, ...j }))));
  for (const s of f.screenshots) {
    const path = `${f.source_id}/screenshots/${Date.now()}-${s.name.replace(/[^\w.-]/g, '_')}`;
    await upload(path, s);
    must(await supabase.from('cms_source_assets').insert({ source_id: f.source_id, storage_path: path, caption: s.name, captured_at: f.captured_at || null }));
  }
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const [k, v] of Object.entries(row)) {
    const b = before ? (before as unknown as Record<string, unknown>)[k] ?? null : null;
    if (JSON.stringify(b) !== JSON.stringify(v)) diff[k] = { before: b, after: v };
  }
  if (f.newJumps.length) diff.jumps_added = { before: null, after: f.newJumps };
  if (f.screenshots.length) diff.screenshots_added = { before: null, after: f.screenshots.map((s) => s.name) };
  must(await supabase.from('cms_reviews').insert({
    target: 'catalogue', target_table: 'cms_sources', target_id: f.source_id, action: 'edit_catalogue',
    reason: f.isNew ? `source added for ${f.chapter_id}` : `source edited (${f.chapter_id})`, field_diff: diff, by_user: userId, by_label: 'Sambit',
  }));
}

export const idTaken = async (id: string) =>
  (must<{ source_id: string }[]>(await supabase.from('cms_sources').select('source_id').eq('source_id', id))).length > 0;

/** Book items behind a question's source refs (internal only). */
export async function sourceItems(refIds: string[]) {
  if (!refIds.length) return [];
  return must<{ ref_id: string; source_id: string; page: number | null; item_text: string; topic_id: string | null }[]>(
    await supabase.from('cms_source_items').select('ref_id, source_id, page, item_text, topic_id').in('ref_id', refIds));
}

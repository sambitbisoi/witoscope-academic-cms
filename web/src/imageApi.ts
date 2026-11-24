// Images PR (DL-040; Sambit, 24 Nov 2026): the image service (/api/images, behind Access; its provider key never reaches
// the browser), the private file store (/api/files) and the audited admin functions of 0049.
import { all } from './api';
import { supabase } from './supabase';
import type { ImageBrief } from '../../shared/image-brief.ts';

const rpc = async <T>(fn: string, args: Record<string, unknown>) => { const { data, error } = await supabase.rpc(fn, args); if (error) throw new Error(error.message); return data as T; };
const asJson = async <T>(r: Response): Promise<T> => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`); return j as T; };

export interface ImageService { configured: boolean; provider?: string; model?: string; price_usd?: number }
/** Whether an image service is set up (no → buttons say "Image service not set up"). Best effort: unreachable = not set up. */
export async function imageService(): Promise<ImageService> {
  try { return await asJson<ImageService>(await fetch('/api/images/status', { credentials: 'same-origin' })); } catch { return { configured: false }; }
}
export const generateBase = async (questionId: string, brief: ImageBrief) =>
  asJson<{ base_path: string; provider: string; model: string; cost_usd: number; prompt_sha: string; layout: string }>(
    await fetch('/api/images/generate', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question_id: questionId, brief }) }));

/** A private file as a Blob (signed URL, 5 minutes). */
export async function fileBlob(key: string): Promise<Blob> {
  const { url } = await asJson<{ url: string }>(await fetch(`/api/files/sign?key=${encodeURIComponent(key)}`, { credentials: 'same-origin' }));
  const r = await fetch(url); if (!r.ok) throw new Error(`could not read ${key}`); return r.blob();
}
export async function signedUrl(key: string): Promise<string> {
  return (await asJson<{ url: string }>(await fetch(`/api/files/sign?key=${encodeURIComponent(key)}`, { credentials: 'same-origin' }))).url;
}
/** Store our own picture under figures/ (PNG / JPEG / WebP, ≤ 50 MB). */
export async function putFile(key: string, blob: Blob): Promise<void> {
  await asJson(await fetch(`/api/files/put?key=${encodeURIComponent(key)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': blob.type || 'image/png' }, body: blob }));
}

type Q = { question_id: string; version_no: number };
export const setBrief = (q: Q, brief: ImageBrief, reason?: string) => rpc('cms_set_image_brief', { p: { ...q, brief, reason } });
export const setImage = (q: Q & { image_path: string; base_path?: string | null; source: 'generated' | 'upload'; provider?: string; model?: string; prompt_sha?: string; cost_usd?: number; run_code?: string; note?: string }) =>
  rpc<{ image_status: string }>('cms_set_image', { p: q });
export const checkImage = (q: Q & { decision: 'ok' | 'redo'; reason?: string }) => rpc<{ image_status: string }>('cms_check_image', { p: q });
export const undoImage = (q: Q) => rpc<{ image_status: string }>('cms_undo_image', { p: q });

export interface HistoryImage { image_id: number; image_path: string | null; base_path: string | null; source: 'svg_render' | 'generated' | 'upload'; state: 'current' | 'previous';
  provider: string | null; cost_usd: number; note: string | null; by_label: string; created_at: string }
export async function imageHistory(versionId: number): Promise<HistoryImage[]> {
  const { data, error } = await supabase.from('cms_version_images').select('image_id, image_path, base_path, source, state, provider, cost_usd, note, by_label, created_at')
    .eq('version_id', versionId).order('image_id', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as HistoryImage[];
}

/** Image status counts of the open Science production questions of a topic or chapter. */
export async function imageCounts(scope: { topicId: string } | { chapterId: string }) {
  const col = 'topicId' in scope ? 'topic_id' : 'chapter_id', id = 'topicId' in scope ? scope.topicId : scope.chapterId;
  const qs = await all<{ question_id: string; current_version: number }>((a, b) => supabase.from('cms_questions').select('question_id, current_version')
    .eq(col, id).eq('subject', 'science').eq('bank', 'production').is('retired_at', null).range(a, b));
  const n = { needs_image: 0, to_check: 0 };
  for (let i = 0; i < qs.length; i += 300) {
    const vs = await all<{ question_id: string; version_no: number; image_status: string | null; status: string }>((a, b) => supabase.from('cms_question_versions')
      .select('question_id, version_no, image_status, status').in('question_id', qs.slice(i, i + 300).map((q) => q.question_id)).in('image_status', ['needs_image', 'to_check']).range(a, b));
    const cur = new Map(qs.map((q) => [q.question_id, q.current_version]));
    for (const v of vs) if (cur.get(v.question_id) === v.version_no && ['draft', 'in_review'].includes(v.status)) n[v.image_status as 'needs_image' | 'to_check']++;
  }
  return n;
}
/** The open version of a question with what a generation step needs. */
export async function openVersion(questionId: string) {
  const { data: q, error } = await supabase.from('cms_questions').select('current_version').eq('question_id', questionId).single();
  if (error) throw new Error(error.message);
  const { data: v, error: e2 } = await supabase.from('cms_question_versions').select('version_id, version_no, status, image_status, image_brief, figure_description')
    .eq('question_id', questionId).eq('version_no', q.current_version).single();
  if (e2) throw new Error(e2.message);
  return v as { version_id: number; version_no: number; status: string; image_status: string | null; image_brief: ImageBrief | null; figure_description: string | null };
}

export const runOpen = (p: { scope_kind: 'topic' | 'chapter'; scope_id: string; provider: string; price_usd: number; cap_usd: number }) =>
  rpc<{ run_code: string; continued: boolean; cap_usd: number; spent_usd: number; price_usd: number; pending: number }>('cms_image_run_open', { p });
export const runClaim = (runCode: string, n: number) => rpc<{ question_ids: string[]; cap_reached: boolean; spent_usd: number; cap_usd: number; pending: number }>('cms_image_run_claim', { p_run_code: runCode, p_n: n });
export const runItem = (p: { run_code: string; question_id: string; status: 'failed' | 'skipped' | 'pending'; error?: string; cost_usd?: number }) => rpc('cms_image_run_item', { p });
export const runClose = (p: { run_code: string; status: 'done' | 'stopped' | 'cancelled'; note?: string }) => rpc<{ spent_usd: number }>('cms_image_run_close', { p });
export async function imageRunCap(): Promise<number> {
  const { data } = await supabase.from('cms_config').select('value').eq('key', 'image_run_cap_usd').maybeSingle();
  return Number(data?.value ?? 5) || 5;
}

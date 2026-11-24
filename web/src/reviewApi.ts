// Q38 PR 4 (Sambit, 24 Nov 2026): review in the CMS. Bulk approve (OL-044), runs, a proposed primary decided in place,
// settings and topic–class links decided in place. Writes only through the audited admin functions of 0048 and earlier.
import { all } from './api';
import { setCatalogueStatus } from './editApi';
import { supabase } from './supabase';

const must = <T>(r: { data: unknown; error: { message: string } | null }): T => { if (r.error) throw new Error(r.error.message); return r.data as T; };
const rpc = async <T>(fn: string, args: Record<string, unknown>) => { const { data, error } = await supabase.rpc(fn, args); if (error) throw new Error(error.message); return data as T; };

export interface ApproveResult { approved: { question_id: string; version_no: number; primary_confirmed: string | null }[]; blocked: { question_id: string; reason: string }[]; already: { question_id: string }[] }
/** Approve questions 50 at a time (each one through cms_set_status; one audit row each). A generated question's single
 *  proposed primary is confirmed first. Blocked ones come back with the reason; the rest go on. */
export async function approveQuestions(ids: string[], reason: string | null, onProgress?: (done: number, total: number) => void): Promise<ApproveResult> {
  const out: ApproveResult = { approved: [], blocked: [], already: [] };
  for (let i = 0; i < ids.length; i += 50) {
    const r = await rpc<ApproveResult>('cms_approve_questions', { p_ids: ids.slice(i, i + 50), p_reason: reason });
    out.approved.push(...r.approved); out.blocked.push(...r.blocked); out.already.push(...r.already);
    onProgress?.(Math.min(ids.length, i + 50), ids.length);
  }
  return out;
}
/** "v1 of SQ000400 can't be approved yet: its picture is pending (…)." → "its picture is pending (…)" */
export const shortReason = (s: string) => s.replace(/^v\d+ of \S+ can't be approved yet: /, '').replace(/\.$/, '');

export interface Run { run_id: number; run_code: string; subject: string | null; source_run: string | null; mode: string | null; status: string; created_at: string }
export async function runs(): Promise<Run[]> {
  return must<Run[]>(await supabase.from('cms_generation_runs').select('run_id, run_code, subject, source_run, mode, status, created_at').not('run_code', 'is', null).order('run_code'));
}
/** question → run code, for the questions a run imported. */
export async function runOfQuestions(): Promise<Map<string, string>> {
  const rs = await runs();
  const code = new Map(rs.map((r) => [r.run_id, r.run_code]));
  const items = await all<{ run_id: number; question_id: string }>((a, b) => supabase.from('cms_generation_items').select('run_id, question_id').eq('status', 'imported').order('question_id').range(a, b));
  return new Map(items.map((i) => [i.question_id, code.get(i.run_id) ?? '']));
}

export type PrimaryDecision = 'confirm' | 'change' | 'reject' | 'undo';
export const decidePrimary = (p: { question_id: string; version_no: number; decision: PrimaryDecision; row_id: string; reason?: string }) =>
  rpc<{ changed: boolean }>('cms_decide_primary', { p });
/** The version a question is at now (Browse lists know the question, not always its version number). */
export async function currentVersion(questionId: string): Promise<number> {
  return must<{ current_version: number }>(await supabase.from('cms_questions').select('current_version').eq('question_id', questionId).single()).current_version;
}

export const decideSetting = (id: string, status: 'active' | 'retired' | 'proposed', where: string) =>
  setCatalogueStatus('setting', id, status, status === 'active' ? `approved ${where}` : status === 'retired' ? `rejected ${where}` : 'back to proposed');

export interface TopicClassProposal { topic_id: string; class: number; suggested_role: string; status: 'proposed' | 'active' | 'retired'; source: string | null }
export async function topicClassProposals(topicIds: string[]): Promise<TopicClassProposal[]> {
  if (!topicIds.length) return [];
  return must<TopicClassProposal[]>(await supabase.from('cms_topic_class_proposals').select('topic_id, class, suggested_role, status, source').in('topic_id', topicIds).order('class'));
}
export const decideTopicClass = (topicId: string, cls: number, status: 'active' | 'retired' | 'proposed') => rpc('cms_decide_topic_class', { p_topic_id: topicId, p_class: cls, p_status: status });

/** Row items waiting for review (needs_review), by row. */
export async function pendingItems(rowIds: string[]): Promise<Set<string>> {
  if (!rowIds.length) return new Set();
  const r = await all<{ row_id: string }>((a, b) => supabase.from('cms_row_misconceptions').select('row_id').eq('status', 'needs_review').in('row_id', rowIds).range(a, b));
  return new Set(r.map((x) => x.row_id));
}

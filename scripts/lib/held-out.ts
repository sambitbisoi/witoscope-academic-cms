// Q21 (Sambit, 17 Nov 2026): writing items an import could not place to the Held-out area (cms_held_out).
// Used by import:chapter (automatically) and held-out:add (backfill / by hand). Only our own content is stored:
// the chapter-file question, catalogue rows (our wording), citations and the local originality result. A near-copy is
// never stored (book rule): it stays in the Mac report.
import type postgres from 'postgres';
import type { ChapterFile, PlacementCode, Problem, Question } from '../../shared/types.ts';
import type { OriginalityReport } from '../../shared/originality.ts';

type Tx = postgres.TransactionSql;
const firstToken = (s: string | null | undefined) => (s ?? '').trim().split(/\s+/)[0] ?? '';
const list = (s: unknown): string[] => (Array.isArray(s) ? s.map(String) : typeof s === 'string' ? s.split(/[,;]\s*/).map((x) => x.trim()).filter(Boolean) : []);

/** The proposals file (pipeline *.proposals.json); only the parts we read. */
export interface ProposalsLike {
  concepts?: { concept_id: string; chapter?: string; topic: string; name: string; type?: string; description?: string; includes?: string; excludes?: string; example?: string; class: number; curriculum_tags?: string }[];
  misconceptions?: { misconception_id: string; concept_id: string; description: string; parent?: string }[];
  typical_sets?: { typical_set_id: string; chapter: string; topic: string; name: string; instruction?: string; variant?: string; concepts?: string | string[]; class: number }[];
  patterns?: { pattern_id: string; topic_id: string; typical_set_id: string; name: string; template?: string; variables?: Record<string, unknown>; target_misconceptions?: string[]; notes?: string }[];
}
export interface HeldCatalogue { concepts: Record<string, unknown>[]; misconceptions: Record<string, unknown>[]; typical_sets: Record<string, unknown>[]; patterns: Record<string, unknown>[] }

/**
 * The catalogue items a question needs that are NOT in the CMS, in table-row shape (as import:proposals writes them).
 * A topic that is ACHIEVERS or not in the CMS becomes '@topic' (= the topic the item is placed on).
 */
export function heldCatalogue(q: Question, file: ChapterFile, inCms: { concepts: Set<string>; misconceptions: Set<string>; sets: Set<string>; patterns: Set<string>; topics: Set<string>; chapters: Set<string> },
  proposals?: ProposalsLike): HeldCatalogue {
  const topicOf = (raw: string, cls: number) => { const t = firstToken(raw); const id = t === 'ACHIEVERS' ? `ACH-${file.chapter_id}-${cls}` : t; return inCms.topics.has(id) ? id : '@topic'; };
  const concepts = new Set([...q.concepts, ...(q.parts ?? []).flatMap((p) => p.concepts)].map((c) => c.concept_id).filter((id) => !inCms.concepts.has(id)));
  const wrong = [q.answer, ...(q.parts ?? []).map((p) => p.answer)].flatMap((a) => a.wrong_answers ?? []);
  for (const w of wrong) if (w.target_concept_id && !inCms.concepts.has(w.target_concept_id)) concepts.add(w.target_concept_id);
  const miscs = new Set(wrong.map((w) => w.misconception_id).filter((m): m is string => !!m && !inCms.misconceptions.has(m)));
  const filePattern = q.pattern_id ? (file.patterns ?? []).find((p) => p.pattern_id === q.pattern_id) : undefined;
  for (const m of filePattern?.target_misconceptions ?? []) if (!inCms.misconceptions.has(m)) miscs.add(m);
  const out: HeldCatalogue = { concepts: [], misconceptions: [], typical_sets: [], patterns: [] };
  const set = !inCms.sets.has(q.typical_set_id) ? proposals?.typical_sets?.find((s) => s.typical_set_id === q.typical_set_id) : undefined;
  for (const cid of list(set?.concepts)) if (!inCms.concepts.has(cid)) concepts.add(cid);
  for (const id of concepts) {
    const c = proposals?.concepts?.find((x) => x.concept_id === id);
    if (c) out.concepts.push({ concept_id: c.concept_id, subject: file.subject, class: c.class, topic_id: topicOf(c.topic, c.class), name: c.name,
      type: c.type?.toLowerCase() === 'applied' ? 'applied' : 'core', description: c.description ?? null, includes: c.includes ?? null, excludes: c.excludes ?? null,
      example_question: c.example ?? null, curriculum_tags: c.curriculum_tags ? [c.curriculum_tags] : [] });
  }
  for (const id of miscs) {
    const m = proposals?.misconceptions?.find((x) => x.misconception_id === id);
    if (m) out.misconceptions.push({ misconception_id: m.misconception_id, concept_id: m.concept_id, description: m.description, parent_description: m.parent ?? null });
  }
  if (set) {
    const ch = firstToken(set.chapter);
    out.typical_sets.push({ typical_set_id: set.typical_set_id, subject: file.subject, class: set.class, chapter_id: inCms.chapters.has(ch) ? ch : null,
      topic_id: topicOf(set.topic, set.class), name: set.name, instruction_pattern: set.instruction ?? null, variant_note: set.variant ?? null, concept_ids: list(set.concepts) });
  }
  if (q.pattern_id && !inCms.patterns.has(q.pattern_id)) {
    const p = filePattern ?? proposals?.patterns?.find((x) => x.pattern_id === q.pattern_id);
    if (p) out.patterns.push({ pattern_id: p.pattern_id, topic_id: '@topic', typical_set_id: p.typical_set_id, name: p.name, template: p.template ?? null,
      variables: p.variables ?? {}, target_misconceptions: p.target_misconceptions ?? [], source_refs: (p as { source_refs?: string[] }).source_refs ?? [], notes: p.notes ?? null });
  }
  return out;
}

/** The first placement problem of a question decides its reason code; null when a non-placement error blocks it. */
export function placementReason(problems: Problem[], key: string): { code: PlacementCode; reason: string } | null {
  const errs = problems.filter((p) => p.key === key && p.level === 'error');
  if (!errs.length || errs.some((p) => !p.code)) return null;
  return { code: errs[0]!.code!, reason: errs.map((p) => p.message).join('; ') };
}

/** Recommended topic: the missing Achievers row itself (it is created once the chapter is linked to that class), else the
 *  chapter's topic of that class that owns the question's typical set or pattern, else none. */
export async function recommendTopic(tx: Tx, q: Question, file: ChapterFile, code: PlacementCode): Promise<string | null> {
  if (q.topic_id === 'ACHIEVERS' || code === 'achievers_missing') {
    const [t] = await tx`select topic_id from cms.cms_topics where topic_id = ${`ACH-${file.chapter_id}-${file.class}`}`;
    return t ? (t.topic_id as string) : null;   // the row does not exist yet: shown as "ACH-… (after a Class N link)"
  }
  const [t] = await tx`select t.topic_id from cms.cms_topics t where t.chapter_id = ${file.chapter_id} and t.class = ${file.class} and t.status = 'active'
    and (t.topic_id = (select s.topic_id from cms.cms_typical_sets s where s.typical_set_id = ${q.typical_set_id})
      or t.topic_id = (select p.topic_id from cms.cms_patterns p where p.pattern_id = ${q.pattern_id ?? ''})) limit 1`;
  return t ? (t.topic_id as string) : null;
}

export interface HeldRecord {
  subject: string; batch: string; import_id: number | null; file: string; chapter_id: string; file_key: string; class: number; level: number | null;
  reason_code: PlacementCode; reason: string; recommended_topic_id: string | null; question: Question; catalogue: HeldCatalogue; proposed_by: string | null;
  originality: Record<string, unknown> | null;
}
/** The originality result for one key, citation-only; null when not checked. Throws on a near-copy (never stored). */
export function originalityFor(rep: OriginalityReport | null, key: string): Record<string, unknown> | null {
  const r = rep?.questions.find((x) => x.key === key);
  if (!rep || !r) return null;
  if (r.result === 'near_copy') throw new Error(`${key} is a near-copy of a book; it is never stored in the CMS (it stays on the Mac)`);
  return { checked_at: rep.checked_at, result: r.result, similarity: r.similarity, same_numbers: r.same_numbers, closest_ref: r.closest_ref, field: r.field ?? null,
    checked: rep.checked, missing: rep.missing, threshold: rep.threshold, near_copy_threshold: rep.near_copy_threshold, tool: rep.tool };
}

/** Insert (or leave alone, when the key is already held) one held-out item, with a 'held_out' review row. */
export async function insertHeld(tx: Tx, h: HeldRecord, by: string): Promise<{ held_id: number; new: boolean }> {
  const [ex] = await tx`select held_id from cms.cms_held_out where subject = ${h.subject} and file_key = ${h.file_key} and status = 'held'`;
  if (ex) return { held_id: Number(ex.held_id), new: false };
  const [row] = await tx`insert into cms.cms_held_out ${tx({ ...h, question: tx.json(h.question as never), catalogue: tx.json(h.catalogue as never),
    originality: h.originality ? tx.json(h.originality as never) : null } as never)} returning held_id`;
  const id = Number(row!.held_id);
  await tx`insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label, import_id)
    values ('question_version', 'cms_held_out', ${`held #${id} ${h.file_key}`}, 'held_out', ${h.reason},
            ${tx.json({ status: { before: null, after: 'held' }, batch: h.batch, file: h.file, reason_code: h.reason_code, recommended_topic: h.recommended_topic_id,
              catalogue: { concepts: h.catalogue.concepts.length, misconceptions: h.catalogue.misconceptions.length, typical_sets: h.catalogue.typical_sets.length, patterns: h.catalogue.patterns.length },
              originality: (h.originality?.result as string | undefined) ?? 'not checked' } as never)}, ${by}, ${h.import_id})`;
  return { held_id: id, new: true };
}

export async function inCmsSets(tx: Tx) {
  const ids = async (q: postgres.PendingQuery<postgres.Row[]>, col: string) => new Set((await q).map((r) => r[col] as string));
  return {
    concepts: await ids(tx`select concept_id from cms.cms_concepts`, 'concept_id'),
    misconceptions: await ids(tx`select misconception_id from cms.cms_misconceptions`, 'misconception_id'),
    sets: await ids(tx`select typical_set_id from cms.cms_typical_sets`, 'typical_set_id'),
    patterns: await ids(tx`select pattern_id from cms.cms_patterns`, 'pattern_id'),
    topics: await ids(tx`select topic_id from cms.cms_topics`, 'topic_id'),
    chapters: await ids(tx`select chapter_id from cms.cms_chapters`, 'chapter_id'),
  };
}

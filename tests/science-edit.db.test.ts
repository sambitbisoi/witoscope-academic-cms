// T1 (17 Nov 2026): editing a Science question (local DB, rolled back). Uses a real local Science question.
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { loadBundle } from '../scripts/lib/bundle.ts';
import { connect } from '../scripts/lib/db.ts';
import { assertLocal, LOCAL_CMS_OWNER_URL, LOCAL_SUPERUSER_URL } from '../scripts/local-bootstrap.ts';
import { checkEdit } from '../shared/edit-checks.ts';
import { questionFromDb } from '../shared/fromDb.ts';
import { planSave } from '../shared/save.ts';
import type { DerivedConfig, Question } from '../shared/types.ts';

assertLocal(LOCAL_SUPERUSER_URL);
const owner = connect(LOCAL_CMS_OWNER_URL);
const su = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
afterAll(async () => { await owner.end(); await su.end(); });
class Done extends Error {}

const MATH_COLS = ['math_difficulty', 'working_memory', 'strategy', 'strategy_type', 'insight_id', 'multistep_band', 'load', 'load_driver', 'style', 'tier', 'trap_level', 'is_isolating', 'difficulty_points'];

async function pickScience() {
  const [r] = await owner`select q.question_id, v.version_id from cms.cms_questions q join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
    where q.subject = 'science' and v.status in ('draft', 'in_review') and exists (select 1 from cms.cms_question_content_rows l where l.version_id = v.version_id)
    order by q.question_id limit 1`;
  return r as { question_id: string; version_id: number } | undefined;
}

describe('T1: Science edit (local, rolled back)', () => {
  it('no Math checks for Science; no change → nothing to save; an edit keeps Science data and never writes Math signature or derived fields', async () => {
    const pick = await pickScience();
    if (!pick) return; // no local Science data
    const [admin] = await owner`select value #>> '{}' as id from cms.cms_config where key = 'admin_user_id'`;
    const cfg = Object.fromEntries((await owner`select key, value from cms.cms_config where key in ('multistep_bands', 'difficulty_points', 'load_thresholds')`).map((r) => [r.key, r.value])) as unknown as DerivedConfig;
    const [q] = await owner`select * from cms.cms_questions where question_id = ${pick.question_id}`;
    const [v] = await owner`select * from cms.cms_question_versions where version_id = ${pick.version_id}`;
    const before = questionFromDb(await loadBundle(owner, pick.version_id));
    expect(before.science).toBeDefined();
    const links = (await owner`select row_id, role, rank, rank_proposed from cms.cms_question_content_rows where version_id = ${pick.version_id} order by row_id`).map((r) => ({ ...r }));
    const items = (await owner`select row_id, item_no, text, status from cms.cms_row_misconceptions where row_id in ${owner(links.map((l) => l.row_id as string))}`).map((r) => ({ ...r })) as never[];
    const topics = new Map((await owner`select topic_id, chapter_id, class, topic_kind, taught_in_school, status from cms.cms_topics where chapter_id = ${q!.chapter_id}`)
      .map((t) => [t.topic_id as string, t as never]));
    const ctx = { subject: 'science', ruleVersion: 'v11', cls: q!.class as number, chapterId: q!.chapter_id as string, linkedRows: links.map((l) => l.row_id as string), rowItems: items,
      catalog: { ruleVersions: new Set(['v11']), chapter: null, topics, typicalSets: new Map(), patterns: new Set<string>(), concepts: new Map(), misconceptions: new Set<string>(),
        insights: new Map(), sourceItems: new Set<string>(), stems: new Map(), keyToQuestionId: new Map() } };
    expect(checkEdit(before, ctx).filter((p) => p.level === 'error')).toEqual([]);

    const mk = (after: Question) => planSave({ questionId: pick.question_id, baseVersionNo: q!.current_version, currentStatus: v!.status, retired: false,
      before, after, cfg, questionClass: q!.class, conceptClass: () => undefined, storedHash: v!.content_hash });
    expect(mk(structuredClone(before)).mode).toBeNull();

    const after = structuredClone(before);
    after.text = `${before.text} (edited)`;
    after.science = { reading: 2, steps: 1, inhibition: 0, visual: 1, has_irrelevant_info: false, is_pure_fact: true };
    const p = mk(after);
    expect(p.mode).toBe('update_draft');
    for (const c of MATH_COLS) expect((p.payload!.version as Record<string, unknown>)[c]).toBeNull();

    await su.begin(async (tx) => {
      await tx.unsafe('set local role authenticated');
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: admin!.id, role: 'authenticated' })}, true)`;
      await tx`select cms.cms_apply_save(${tx.json(p.payload as never)})`;
      await tx.unsafe('reset role');
      const [w] = await tx`select * from cms.cms_question_versions where version_id = ${pick.version_id}`;
      expect(w!.text).toBe(after.text);
      expect([w!.reading, w!.steps, w!.inhibition, w!.visual, w!.has_irrelevant_info, w!.is_pure_fact]).toEqual([2, 1, 0, 1, false, true]);
      expect(w!.attributes_pending).toBe(false);
      for (const c of MATH_COLS) expect(w![c]).toBeNull();
      expect([w!.level_tier, w!.display_format, w!.safety_note, w!.misconception_row_id, w!.misconception_item_no]).toEqual([v!.level_tier, v!.display_format, v!.safety_note, v!.misconception_row_id, v!.misconception_item_no]);
      const l2 = (await tx`select row_id, role, rank, rank_proposed from cms.cms_question_content_rows where version_id = ${pick.version_id} order by row_id`).map((r) => ({ ...r }));
      expect(l2).toEqual(links);
      throw new Done();
    }).catch((e) => { if (!(e instanceof Done)) throw e; });
  });
});

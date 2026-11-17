// Q21 (17 Nov 2026): the Held-out area (local DB, rolled back). A held copy of a real local Math question, placed on its
// topic, gives the same version and child rows as the import that made the original.
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog, runChapter } from '../scripts/import-chapter.ts';
import { connect } from '../scripts/lib/db.ts';
import { loadBundle } from '../scripts/lib/bundle.ts';
import { assertLocal, LOCAL_SUPERUSER_URL } from '../scripts/local-bootstrap.ts';
import { checkFile } from '../shared/checks.ts';
import { tierBasis } from '../shared/derive.ts';
import { questionFromDb } from '../shared/fromDb.ts';
import { rowsFor } from '../shared/save.ts';
import type { ChapterFile, DerivedConfig } from '../shared/types.ts';
import { structureHash } from '../shared/version.ts';

assertLocal(LOCAL_SUPERUSER_URL);
const su = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
afterAll(() => su.end());
class Done extends Error {}
const OTHER = '00000000-0000-4000-8000-000000000002';

async function run(fn: (tx: postgres.TransactionSql, as: (uid: 'admin' | string) => Promise<void>) => Promise<void>) {
  await su.begin(async (tx) => {
    const [a] = await tx`select value #>> '{}' as id from cms.cms_config where key = 'admin_user_id'`;
    const as = async (uid: 'admin' | string) => {
      await tx.unsafe('set local role authenticated');
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid === 'admin' ? a!.id : uid, role: 'authenticated' })}, true)`;
    };
    await fn(tx, as);
    throw new Done();
  }).catch((e) => { if (!(e instanceof Done)) throw e; });
}
const call = (tx: postgres.TransactionSql, q: postgres.PendingQuery<postgres.Row[]>) => tx.savepoint(() => q);

describe('Q21 held out (local, rolled back)', () => {
  it('a near-copy is never stored (CHECK)', async () => {
    await run(async (tx) => {
      const [c] = await tx`select chapter_id from cms.cms_chapters limit 1`;
      await expect(call(tx, tx`insert into cms.cms_held_out (subject, batch, file, chapter_id, file_key, class, reason_code, reason, question, originality)
        values ('math', 't', 'f.json', ${c!.chapter_id}, 'ZZ-1', 3, 'topic_missing', 'x', '{}', '{"result": "near_copy"}')`)).rejects.toThrow(/check/);
    });
  });

  it('Place = the importer\'s rows for the same question; catalogue held with it becomes Proposed; audited; Discard; refusals', async () => {
    await run(async (tx, as) => {
      const [x] = await tx`select q.question_id, q.file_key, q.chapter_id, q.topic_id, q.class, q.level, v.version_id
        from cms.cms_questions q join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
        join cms.cms_topics t on t.topic_id = q.topic_id
        where q.subject = 'math' and q.bank = 'production' and v.created_from = 'import' and q.class_override is null and t.status = 'active' and t.class = q.class
          and exists (select 1 from cms.cms_version_options o where o.version_id = v.version_id)
          and exists (select 1 from cms.cms_typical_sets s where s.typical_set_id = q.typical_set_id and s.class = q.class)
        order by q.question_id limit 1`;
      if (!x) return;
      const q = questionFromDb(await loadBundle(tx as never, Number(x.version_id)));
      const [{ c: conceptId }] = await tx`select concept_id as c from cms.cms_version_concepts where version_id = ${x.version_id} limit 1` as unknown as [{ c: string }];
      // the held copy uses a new typical set that is held with it (shape as import:proposals writes it)
      const key = `${x.chapter_id}-9871`;   // a key no file uses (CMS keys are 5001–9999)
      const held = { ...q, key, typical_set_id: 'TS-G6-ZZHELD' };
      delete (held as { pattern_id?: string }).pattern_id;
      const catalogue = { concepts: [], misconceptions: [], patterns: [], typical_sets: [{ typical_set_id: 'TS-G6-ZZHELD', subject: 'math', class: x.class, chapter_id: x.chapter_id,
        topic_id: '@topic', name: 'Held test set', instruction_pattern: null, variant_note: null, concept_ids: [conceptId] }] };
      const [h] = await tx`insert into cms.cms_held_out (subject, batch, file, chapter_id, file_key, class, level, reason_code, reason, question, catalogue, proposed_by, originality)
        values ('math', 'test batch', 'ZZ.json', ${x.chapter_id}, ${key}, ${x.class}, ${x.level}, 'typical_set_missing', 'typical set TS-G6-ZZHELD does not exist',
                ${tx.json(held as never)}, ${tx.json(catalogue as never)}, 'ZZ-test', ${tx.json({ checked_at: '2026-11-17T00:00:00Z', result: 'clear', similarity: 0.2, same_numbers: false,
                  closest_ref: 'N1-01-001', field: 'text', checked: [], missing: [], threshold: 0.6, near_copy_threshold: 0.85, tool: 'test' } as never)})
        returning held_id`;
      // what the browser does: the importer's checks with the held items counted, then the shared rows
      const file: ChapterFile = { file_schema: 'cms-chapter/1.0', attribute_version: 'v11', subject: 'math', class: x.class, chapter_id: x.chapter_id,
        generated: { by: 'test', date: '2026-11-17' }, questions: [{ ...held, topic_id: x.topic_id }] };
      const cat = await loadCatalog(tx, file);
      cat.typicalSets.set('TS-G6-ZZHELD', { class: x.class, status: 'proposed' });
      expect(checkFile(file, cat, { gold: true }).filter((p) => p.level === 'error' && p.key !== 'file')).toEqual([]);
      const cfg = Object.fromEntries((await tx`select key, value from cms.cms_config where key in ('multistep_bands', 'difficulty_points', 'load_thresholds')`).map((r) => [r.key, r.value])) as unknown as DerivedConfig;
      const cc = new Map((await tx`select concept_id, class from cms.cms_concepts`).map((r) => [r.concept_id as string, Number(r.class)]));
      const hq = { ...held, topic_id: x.topic_id };
      const rows = rowsFor(hq, cfg, tierBasis({ level: x.level, class: x.class }), (id) => cc.get(id));
      const payload = { held_id: h!.held_id, topic_id: x.topic_id, content_hash: structureHash(hq, x.topic_id),
        question: { class_override: null, placement_note: hq.placement_note ?? null, typical_set_id: hq.typical_set_id, pattern_id: null, clone_batch_id: hq.clone_batch_id, locale: hq.locale },
        version: rows.version, parts: rows.parts, options: rows.options, wrong_answers: rows.wrong_answers, concepts: rows.concepts, solutions: rows.solutions, hints: rows.hints, source_refs: rows.source_refs };

      await as(OTHER);
      await expect(call(tx, tx`select cms.cms_place_held_out(${tx.json(payload as never)})`)).rejects.toThrow(/Only the CMS admin/);
      await as('admin');
      const [{ r }] = await call(tx, tx`select cms.cms_place_held_out(${tx.json(payload as never)}) as r`) as unknown as [{ r: { question_id: string; import_id: number } }];
      await tx.unsafe('reset role');
      const [nq] = await tx`select * from cms.cms_questions where question_id = ${r.question_id}`;
      expect([nq!.file_key, nq!.topic_id, nq!.class, nq!.level, nq!.typical_set_id]).toEqual([key, x.topic_id, x.class, x.level, 'TS-G6-ZZHELD']);
      const [a] = await tx`select * from cms.cms_question_versions where version_id = ${x.version_id}`;
      const [b] = await tx`select * from cms.cms_question_versions where question_id = ${r.question_id}`;
      const SKIP = ['version_id', 'question_id', 'import_id', 'created_at', 'edited_at', 'typical_set_id', 'pattern_id', 'content_hash', 'tier', 'status', 'version_no'];
      for (const k of Object.keys(a!)) if (!SKIP.includes(k)) expect(`${k}=${JSON.stringify(b![k])}`).toBe(`${k}=${JSON.stringify(a![k])}`);
      expect(b!.status).toBe('draft');
      for (const t of ['cms_version_options', 'cms_version_wrong_answers', 'cms_version_concepts', 'cms_version_solutions', 'cms_version_hints', 'cms_version_source_refs', 'cms_version_parts']) {
        const strip = (rs: postgres.Row[]) => rs.map(({ version_id: _v, wrong_answer_id: _w, ...rest }) => JSON.stringify(rest)).sort();
        const ra = await tx`select * from ${tx(`cms.${t}`)} where version_id = ${x.version_id}`;
        const rb = await tx`select * from ${tx(`cms.${t}`)} where version_id = ${b!.version_id}`;
        expect(strip(rb)).toEqual(strip(ra));
      }
      const [set] = await tx`select status, topic_id from cms.cms_typical_sets where typical_set_id = 'TS-G6-ZZHELD'`;
      expect([set!.status, set!.topic_id]).toEqual(['proposed', x.topic_id]);
      const [link] = await tx`select role from cms.cms_typical_set_concepts where typical_set_id = 'TS-G6-ZZHELD'`;
      expect(link!.role).toBe('main');
      const [orig] = await tx`select result, closest_ref from cms.cms_originality_checks where version_id = ${b!.version_id}`;
      expect([orig!.result, orig!.closest_ref, b!.originality_pending]).toEqual(['clear', 'N1-01-001', false]);
      const [ho] = await tx`select status, placed_question_id from cms.cms_held_out where held_id = ${h!.held_id}`;
      expect([ho!.status, ho!.placed_question_id]).toEqual(['placed', r.question_id]);
      const aud = await tx`select action from cms.cms_reviews where import_id = ${r.import_id} order by review_id`;
      expect(aud.map((y) => y.action)).toEqual(['create', 'held_out_place']);
      // again → refused; the key is used now
      await as('admin');
      await expect(call(tx, tx`select cms.cms_place_held_out(${tx.json(payload as never)})`)).rejects.toThrow(/already placed/);
      await expect(call(tx, tx`select cms.cms_discard_held_out(${h!.held_id}, 'x')`)).rejects.toThrow(/already placed/);
    });
  });

  it('Discard needs a reason, is audited and keeps the row', async () => {
    await run(async (tx, as) => {
      const [c] = await tx`select chapter_id from cms.cms_chapters where subject = 'math' limit 1`;
      const [h] = await tx`insert into cms.cms_held_out (subject, batch, file, chapter_id, file_key, class, reason_code, reason, question)
        values ('math', 't', 'f.json', ${c!.chapter_id}, 'ZZHELD-0002', 3, 'topic_missing', 'x', '{"text": "t"}') returning held_id`;
      await as('admin');
      await expect(call(tx, tx`select cms.cms_discard_held_out(${h!.held_id}, '')`)).rejects.toThrow(/needs a reason/);
      await call(tx, tx`select cms.cms_discard_held_out(${h!.held_id}, 'duplicate of MQ000001')`);
      await tx.unsafe('reset role');
      const [r] = await tx`select status, note from cms.cms_held_out where held_id = ${h!.held_id}`;
      expect([r!.status, r!.note]).toEqual(['discarded', 'duplicate of MQ000001']);
      const [a] = await tx`select action from cms.cms_reviews where target_table = 'cms_held_out' and target_id = ${`held #${h!.held_id} ZZHELD-0002`}`;
      expect(a!.action).toBe('held_out_discard');
    });
  });
});

describe('Q21: import:chapter writes held-out items', () => {
  it('a question whose topic is not in the CMS is held out (with its reason), the rest of the file imports', async () => {
    const owner = connect();
    const ex = JSON.parse(readFileSync('content/examples/MC19-example.json', 'utf8')) as ChapterFile;
    const [ch] = await owner`select t.topic_id, t.chapter_id, t.class from cms.cms_topics t where t.topic_id = ${ex.questions[0]!.topic_id}`;
    if (!ch) { await owner.end(); return; }
    const dir = mkdtempSync(join(tmpdir(), 'held-'));
    const q0 = ex.questions[0]!;
    const file = { ...ex, questions: [{ ...q0, key: `${ex.chapter_id}-4991`, topic_id: 'MT9989', text: `${q0.text} (held test)` }] };
    delete (file as { patterns?: unknown }).patterns;
    const path = join(dir, `${ex.chapter_id}-C${ex.class}.json`);
    writeFileSync(path, JSON.stringify(file));
    try {
      const r = await runChapter(owner, path, 'import', false, { heldOut: { batch: 'held test' } });
      expect(r.outcomes.map((o) => o.result)).toEqual(['held_out']);
      const [h] = await owner`select reason_code, batch, status, import_id from cms.cms_held_out where file_key = ${`${ex.chapter_id}-4991`} and status = 'held'`;
      expect([h!.reason_code, h!.batch, h!.status, Number(h!.import_id)]).toEqual(['topic_missing', 'held test', 'held', r.importId]);
    } finally {
      await owner`delete from cms.cms_reviews where target_table = 'cms_held_out' and target_id like ${`% ${ex.chapter_id}-4991`}`;
      await owner`delete from cms.cms_held_out where file_key = ${`${ex.chapter_id}-4991`}`;
      await owner`delete from cms.cms_reviews where import_id in (select import_id from cms.cms_imports where file_path like ${`%${dir.split('/').pop()}%`})`;
      await owner`delete from cms.cms_imports where file_path like ${`%${dir.split('/').pop()}%`}`;
      await owner.end();
    }
  });
});

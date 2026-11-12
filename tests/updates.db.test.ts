// import:updates end to end on the local DB with test-only IDs (MC95, MT9995/MT9994, SET99xx), removed after.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChapter } from '../scripts/import-chapter.ts';
import { runUpdates } from '../scripts/import-updates.ts';
import { connect } from '../scripts/lib/db.ts';
import { LOCAL_CMS_OWNER_URL } from '../scripts/local-bootstrap.ts';

const sql = connect(LOCAL_CMS_OWNER_URL);
let dir = '';
const example = () => JSON.parse(readFileSync('content/examples/MC19-example.json', 'utf8')
  .replaceAll('MC19', 'MC95').replaceAll('MT0393', 'MT9995').replaceAll('TS-G6-FRAC-ADD-UNLIKE', 'TS-G6-ZV-TEST')
  .replaceAll('G6-M-FRC1', 'G6-M-ZVZ1').replaceAll('G6-FRC-C1', 'G6-ZVZ-C1'));
const fileWith = (keys: string[]) => {
  const f = example(); const q0 = f.questions[0]; delete q0.source_refs;
  f.questions = keys.map((k, i) => ({ ...structuredClone(q0), key: k, text: `${q0.text} (updates test ${k} ${i})` }));
  return f;
};

async function cleanup() {
  const qids = (await sql`select question_id from cms.cms_questions where file_key like 'MC95-%'`).map((r) => r.question_id as string);
  if (qids.length) {
    const vids = (await sql`select version_id from cms.cms_question_versions where question_id in ${sql(qids)}`).map((r) => r.version_id);
    for (const t of ['cms_version_parts', 'cms_version_options', 'cms_version_wrong_answers', 'cms_version_concepts', 'cms_version_solutions', 'cms_version_hints', 'cms_version_source_refs', 'cms_originality_checks'])
      if (vids.length) await sql`delete from ${sql(`cms.${t}`)} where version_id in ${sql(vids)}`;
    await sql`delete from cms.cms_reviews where target_id like any (${qids.flatMap((q) => [q, `${q} v%`])})`;
    await sql`delete from cms.cms_question_versions where question_id in ${sql(qids)}`;
    await sql`delete from cms.cms_questions where question_id in ${sql(qids)}`;
  }
  await sql`delete from cms.cms_reviews where import_id in (select import_id from cms.cms_imports where chapter_id = 'MC95' or file_path like '%cms-updates-test-%')`;
  await sql`delete from cms.cms_reviews where target_table in ('cms_settings', 'cms_topic_classes') and (target_id like 'SET99%' or target_id like 'MT999%')`;
  await sql`delete from cms.cms_topic_classes where topic_id in ('MT9995', 'MT9994')`;
  await sql`delete from cms.cms_settings where setting_id like 'SET99%'`;
  await sql`delete from cms.cms_imports where chapter_id = 'MC95' or file_path like '%cms-updates-test-%'`;
  await sql`delete from cms.cms_typical_sets where typical_set_id = 'TS-G6-ZV-TEST'`;
  await sql`delete from cms.cms_misconceptions where misconception_id = 'G6-M-ZVZ1'`;
  await sql`delete from cms.cms_concepts where concept_id = 'G6-ZVZ-C1'`;
  await sql`delete from cms.cms_topics where chapter_id = 'MC95'`;
  await sql`delete from cms.cms_chapters where chapter_id = 'MC95'`;
  await sql`delete from cms.cms_strands where strand_id = 'math-ZV'`;
}

beforeAll(async () => {
  await cleanup();
  await sql`insert into cms.cms_strands (strand_id, subject, code, name, sort) values ('math-ZV', 'math', 'ZV', 'Updates test strand', 995)`;
  await sql`insert into cms.cms_chapters (chapter_id, subject, strand_id, name, sort) values ('MC95', 'math', 'math-ZV', 'Updates test chapter', 995)`;
  await sql`insert into cms.cms_topics (topic_id, chapter_id, class, name) values ('MT9995', 'MC95', 6, 'Updates test topic'), ('MT9994', 'MC95', 4, 'Updates test topic 4')`;
  await sql`insert into cms.cms_concepts (concept_id, subject, class, topic_id, name) values ('G6-ZVZ-C1', 'math', 6, 'MT9995', 'Test concept')`;
  await sql`insert into cms.cms_misconceptions (misconception_id, concept_id, description) values ('G6-M-ZVZ1', 'G6-ZVZ-C1', 'Test misconception')`;
  await sql`insert into cms.cms_typical_sets (typical_set_id, subject, class, chapter_id, topic_id, name) values ('TS-G6-ZV-TEST', 'math', 6, 'MC95', 'MT9995', 'Updates test set')`;
  const tmp = mkdtempSync(join(tmpdir(), 'cms-updates-test-'));
  writeFileSync(join(tmp, 'f.json'), JSON.stringify(fileWith(['MC95-0001', 'MC95-0002'])));
  await runChapter(sql, join(tmp, 'f.json'), 'import');
  dir = join(tmp, 'CMS-updates');
  mkdirSync(join(dir, 'near_copy_rewrites'), { recursive: true });
  writeFileSync(join(dir, 'settings_catalogue.csv'), 'setting_id,name,description,theme,status\nSET9901,Bare test,No story,—,proposed\nSET9902,Lift test,Floors,Motion,proposed\n');
  writeFileSync(join(dir, 'topic_classes.csv'), 'topic_id,class,source,evidence\nMT9995,6,workbook-default,\nMT9995,5,NCERT,test\nMT9995,4,DAV,test\n');
  writeFileSync(join(dir, 'question_levels.csv'), 'file_key,level,source_file,source_field\nMC95-0001,5,x,Book class\nMC95-0002,6,x,Book class\nMC95-0999,4,x,Book class\n');
  writeFileSync(join(dir, 'question_settings.csv'), 'file_key,setting_id,confidence,note\nMC95-0001,SET9902,high,lift story\nMC95-0002,SET9901,medium,\n');
  writeFileSync(join(dir, 'near_copy_rewrites', 'MC95-C6.json'), JSON.stringify(fileWith(['MC95-0003'])));
  const pipe = join(tmp, 'NCERT-TEST'); mkdirSync(pipe);
  writeFileSync(join(pipe, 'MC95-C6.json'), JSON.stringify(fileWith(['MC95-0004'])));
  writeFileSync(join(dir, 'key_fixes.csv'), `old_file_key,new_file_key,source_file,reason\nMC95-0004,MC95-0904,${join(pipe, 'MC95-C6.json')},test clash\n`);
});
afterAll(async () => { await cleanup(); await sql.end(); });

describe('import:updates (queue 12 Nov 2026, PR B)', () => {
  it('a dry run saves nothing', async () => {
    const r = await runUpdates(sql, dir, { dryRun: true });
    expect(r.length).toBe(7);
    const [n] = await sql`select count(*)::int as n from cms.cms_settings where setting_id like 'SET99%'`;
    expect(n!.n).toBe(0);
  });

  it('imports settings, topic classes, levels, question settings, the key fix and the rewrite', async () => {
    const r = await runUpdates(sql, dir);
    const by = (f: string) => r.find((x) => x.file.endsWith(f) || x.file.includes(f))!;
    expect(by('settings_catalogue.csv').counts.cms_settings).toMatchObject({ inserted: 2 });
    expect(by('question_levels.csv').counts.questions).toEqual({ updated: 2, unchanged: 0, not_in_cms: 1 });
    expect(by('question_settings.csv').counts.questions).toEqual({ updated: 2, unchanged: 0, not_in_cms: 0 });
    expect(by('MC95-0904').result).not.toBe('failed');
    expect(by('MC95-C6.json').result).not.toBe('failed');
    const qs = await sql`select file_key, level, setting_id, setting_confidence from cms.cms_questions where file_key like 'MC95-%' order by file_key`;
    expect(qs.map((q) => [q.file_key, q.level, q.setting_id])).toEqual([['MC95-0001', 5, 'SET9902'], ['MC95-0002', 6, 'SET9901'], ['MC95-0003', null, null], ['MC95-0904', null, null]]);
    const [audit] = await sql`select field_diff from cms.cms_reviews where action = 'import_update' and target_id = (select question_id from cms.cms_questions where file_key = 'MC95-0001') order by review_id limit 1`;
    expect(audit!.field_diff).toEqual({ level: { before: null, after: 5 } });
  });

  it('D3: a question shows in class N when its topic is in N and its level ≤ N', async () => {
    const rows = await sql`select q.file_key, c.class, c.is_home from cms.cms_question_classes c join cms.cms_questions q using (question_id)
      where q.file_key in ('MC95-0001', 'MC95-0002') order by 1, 2`;
    // MT9995 is in classes 4, 5 (mapped) and 6 (its own). Level 5 → 5 (home) and 6 (revision); level 6 → 6 only.
    expect(rows.map((x) => [x.file_key, x.class, x.is_home])).toEqual([['MC95-0001', 5, true], ['MC95-0001', 6, false], ['MC95-0002', 6, true]]);
    const stats = await sql`select class, n_questions, n_revision from cms.cms_topic_class_stats where topic_id = 'MT9995' order by class`;
    expect(stats.map((s) => [s.class, s.n_questions, s.n_revision])).toEqual([[4, 0, 0], [5, 1, 0], [6, 4, 1]]);
  });

  it('a second run changes nothing; an approved setting keeps its status', async () => {
    await sql`update cms.cms_settings set status = 'active' where setting_id = 'SET9902'`;
    const r = await runUpdates(sql, dir, { only: ['settings_catalogue.csv', 'question_levels.csv', 'topic_classes.csv'] });
    expect(r[0]!.counts.cms_settings).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
    expect(r[1]!.counts.cms_topic_classes).toMatchObject({ inserted: 0, updated: 0, unchanged: 3, multi_class_topics: 1 });
    expect(r[2]!.counts.questions).toMatchObject({ updated: 0, unchanged: 2 });
    const [s] = await sql`select status from cms.cms_settings where setting_id = 'SET9902'`;
    expect(s!.status).toBe('active');
  });

  it('clone groups: same pattern + signature + concepts share a key', async () => {
    await sql`insert into cms.cms_patterns (pattern_id, topic_id, typical_set_id, name) values ('MP9995', 'MT9995', 'TS-G6-ZV-TEST', 'test pattern') on conflict do nothing`;
    await sql`update cms.cms_questions set pattern_id = 'MP9995' where file_key in ('MC95-0001', 'MC95-0002')`;
    const k = await sql`select clone_key from cms.cms_question_list where file_key in ('MC95-0001', 'MC95-0002')`;
    expect(k[0]!.clone_key).toBeTruthy();
    expect(k[0]!.clone_key).toBe(k[1]!.clone_key);
    await sql`update cms.cms_questions set pattern_id = null where file_key like 'MC95-%'`;
    await sql`delete from cms.cms_patterns where pattern_id = 'MP9995'`;
  });
});

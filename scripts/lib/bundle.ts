// Load a version's database rows as a DbBundle (scripts and tests), for shared/fromDb.ts.
import type postgres from 'postgres';
import type { DbBundle } from '../../shared/fromDb.ts';

type Sql = postgres.Sql | postgres.TransactionSql;

export async function loadBundle(sql: Sql, versionId: number): Promise<DbBundle> {
  const [v] = await sql`select * from cms.cms_question_versions where version_id = ${versionId}`;
  const [q] = await sql`select * from cms.cms_questions where question_id = ${v!.question_id}`;
  const [parts, options, wrong, concepts, solutions, hints, refs] = await Promise.all([
    sql`select part_label, text, format, correct, accepted from cms.cms_version_parts where version_id = ${versionId}`,
    sql`select part_label, position, text, is_correct from cms.cms_version_options where version_id = ${versionId}`,
    sql`select part_label, value, tag, misconception_id, target_concept_id, why from cms.cms_version_wrong_answers where version_id = ${versionId} order by wrong_answer_id`,
    sql`select part_label, concept_id, involvement from cms.cms_version_concepts where version_id = ${versionId}`,
    sql`select slot, text, type, strategy from cms.cms_version_solutions where version_id = ${versionId}`,
    sql`select level, text from cms.cms_version_hints where version_id = ${versionId}`,
    sql`select ref_id, relation from cms.cms_version_source_refs where version_id = ${versionId}`,
  ]);
  return { question: q as never, version: v as never, parts: parts as never, options: options as never, wrong: wrong as never,
    concepts: concepts as never, solutions: solutions as never, hints: hints as never, refs: refs as never };
}

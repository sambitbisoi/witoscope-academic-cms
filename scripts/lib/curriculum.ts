// D5: who owns chapters and topics. Until the one-time cut-over it is the topic workbooks
// (import:topics, import:sources); afterwards the CMS, and those importers refuse to run.
import type { connect } from './db.ts';

export type CurriculumOwner = 'workbooks' | 'cms';
export async function curriculumOwner(sql: ReturnType<typeof connect>): Promise<CurriculumOwner> {
  const [r] = await sql`select value #>> '{}' as v from cms.cms_config where key = 'curriculum_owner'`;
  return r?.v === 'cms' ? 'cms' : 'workbooks';
}

export async function refuseAfterCutover(sql: ReturnType<typeof connect>, what: string) {
  if ((await curriculumOwner(sql)) === 'cms') {
    throw new Error(`${what} is switched off: the CMS owns the curriculum since the cut-over (D5). Edit chapters and topics in the CMS; the workbooks are exports now (npm run export:topics).`);
  }
}

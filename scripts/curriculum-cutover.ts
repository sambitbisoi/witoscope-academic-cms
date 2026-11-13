// npm run curriculum:cutover                 status and checklist only (changes nothing)
// npm run curriculum:cutover -- --confirm [--math <xlsx> --science <xlsx> --english <xlsx>]   the one-time switch: the CMS owns chapters and topics
// npm run curriculum:cutover -- --revert     back to the workbooks (audited; for mistakes only)
//
// D5 (docs/curriculum-cutover.md). --confirm refuses unless the LAST successful topic import was
// made from exactly the workbooks on this Mac now (same sha256), i.e. the final workbook import is
// done. Then cms_config.curriculum_owner = 'cms' (audited); import:topics and import:sources
// refuse from then on, and the CMS forms can add and edit chapters and topics.
// Local by default; the real project only with `npx tsx --env-file=.env.real …` and Sambit's OK.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertCmsOwner, connect, targetUrl } from './lib/db.ts';
import { curriculumOwner } from './lib/curriculum.ts';
import { readWorkbook } from './lib/xlsx.ts';

const CR = join(homedir(), 'WitoScope', 'ContentResearch');
const flag = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
// --math / --science / --english: the workbooks the final import read (e.g. the archived finals at go-live)
const WORKBOOKS = [
  flag('--math') ?? join(CR, 'Math', 'WitoScope_Math_Topics_Class1-6.xlsx'),
  flag('--science') ?? join(CR, 'Science', 'WitoScope_Science_Topics_Class1-6.xlsx'),
  flag('--english') ?? join(CR, 'English', 'WitoScope_English_Grammar_Topics_Class1-6.xlsx'),
];

const args = process.argv.slice(2);
const sql = connect();
try {
  await assertCmsOwner(sql);
  const where = new URL(targetUrl()).hostname;
  const owner = await curriculumOwner(sql);
  const hashes: string[] = [];
  for (const f of WORKBOOKS) hashes.push((await readWorkbook(f)).sha256);
  const current = createHash('sha256').update(hashes.join(':')).digest('hex');
  const [last] = await sql`select import_id, started_at, file_hash from cms.cms_imports
    where kind = 'topics' and result = 'ok' and coalesce(options ->> 'dry_run', 'false') = 'false' order by import_id desc limit 1`;
  const finalDone = !!last && last.file_hash === current;
  console.log(`Database: ${where}${where === '127.0.0.1' || where === 'localhost' ? ' (local)' : ' (REAL PROJECT)'}`);
  console.log(`Curriculum owner now: ${owner}`);
  console.log(`Last topic import: ${last ? `#${last.import_id}, ${new Date(last.started_at).toISOString().slice(0, 16)}` : 'none'}`);
  console.log(`Workbooks on this Mac match the last import: ${finalDone ? 'yes' : 'NO (run npm run import:topics first: the final workbook import)'}`);

  if (args.includes('--confirm')) {
    if (owner === 'cms') { console.log('Already cut over; nothing to do.'); process.exit(0); }
    if (!finalDone) { console.error('\nRefused: the final workbook import is not done (see above).'); process.exit(1); }
    await sql.begin(async (tx) => {
      await tx`update cms.cms_config set value = '"cms"', updated_at = now() where key = 'curriculum_owner'`;
      await tx`insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label)
        values ('catalogue', 'cms_config', 'curriculum_owner', 'edit_catalogue', ${`cut-over: the CMS owns the curriculum (D5); final workbook import #${last!.import_id}`},
                ${tx.json({ curriculum_owner: { before: 'workbooks', after: 'cms' }, workbooks_sha256: hashes } as never)}, 'cut-over script')`;
    });
    console.log('\nDone: the CMS owns chapters and topics. import:topics and import:sources are switched off; use npm run export:topics for the workbooks.');
  } else if (args.includes('--revert')) {
    if (owner === 'workbooks') { console.log('The workbooks already own the curriculum.'); process.exit(0); }
    await sql.begin(async (tx) => {
      await tx`update cms.cms_config set value = '"workbooks"', updated_at = now() where key = 'curriculum_owner'`;
      await tx`insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label)
        values ('catalogue', 'cms_config', 'curriculum_owner', 'edit_catalogue', 'cut-over reverted', ${tx.json({ curriculum_owner: { before: 'cms', after: 'workbooks' } } as never)}, 'cut-over script')`;
    });
    console.log('\nReverted: the workbooks own chapters and topics again. Edits made in the CMS meanwhile stay, but a workbook import may overwrite them.');
  } else {
    console.log('\nNothing changed. Checklist: docs/curriculum-cutover.md. The switch is --confirm (Sambit\'s OK first).');
  }
} finally {
  await sql.end();
}

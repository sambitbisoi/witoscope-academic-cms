// npm run rehash [-- --dry-run]  (local)  ·  npx tsx --env-file=.env.real scripts/rehash.ts  (real)
//
// Recomputes every version's content_hash with the canonical structure (shared/version.ts),
// rebuilt from the database rows (shared/fromDb.ts). Only the stored fingerprint changes;
// no content, status or version number does. Safe to re-run (a second run changes nothing).
import { questionFromDb } from '../shared/fromDb.ts';
import { structureHash } from '../shared/version.ts';
import { loadBundle } from './lib/bundle.ts';
import { assertCmsOwner, connect } from './lib/db.ts';

const dryRun = process.argv.includes('--dry-run');
const sql = connect();
try {
  await assertCmsOwner(sql);
  const versions = await sql<{ version_id: number; question_id: string; version_no: number; content_hash: string }[]>`
    select version_id, question_id, version_no, content_hash from cms.cms_question_versions order by version_id`;
  let changed = 0;
  await sql.begin(async (tx) => {
    for (const v of versions) {
      const q = questionFromDb(await loadBundle(tx, v.version_id));
      const h = structureHash(q, q.topic_id);
      if (h !== v.content_hash) {
        changed++;
        if (!dryRun) await tx`update cms.cms_question_versions set content_hash = ${h} where version_id = ${v.version_id}`;
      }
    }
  });
  console.log(`rehash${dryRun ? ' (DRY RUN)' : ''}: ${versions.length} versions · ${changed} fingerprint${changed === 1 ? '' : 's'} ${dryRun ? 'would change' : 'updated'}`);
} finally {
  await sql.end();
}

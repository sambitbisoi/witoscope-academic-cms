// Run pending migrations with a before/after fingerprint of every cms table (Round 1, 17 Nov 2026).
//   npx tsx [--env-file=.env.real] scripts/migrate-guarded.ts [--allow table,table] [--exclude table.col,table.col]
// The migration may change only: the tables in --allow (e.g. cms_config for a new key), columns named in --exclude
// (new columns), and cms_schema_migrations. Anything else changed → exit 3 (the stop condition), with the list.
import { execFileSync } from 'node:child_process';
import { connect, targetUrl } from './lib/db.ts';
import { diffFingerprints, fingerprint } from './lib/fingerprint.ts';

const args = process.argv.slice(2);
const list = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1]!.split(',').filter(Boolean) : []);
const allow = ['cms_schema_migrations', ...list('--allow')];
const exclude: Record<string, string[]> = {};
for (const x of list('--exclude')) { const [t, c] = x.split('.'); (exclude[t!] ??= []).push(c!); }
const sql = connect();
// a column that does not exist yet is simply absent from to_jsonb(); excluding it before and after compares like with like
const before = await fingerprint(sql, { exclude });
await sql.end();
execFileSync('npx', ['tsx', 'scripts/migrate.ts'], { stdio: 'inherit', env: { ...process.env, CMS_DATABASE_URL: targetUrl() } });
const sql2 = connect();
const after = await fingerprint(sql2, { exclude });
await sql2.end();
const diff = diffFingerprints(before, after, allow);
console.log(`fingerprint (all cms tables; allowed to change: ${allow.join(', ')}; new columns left out: ${Object.entries(exclude).map(([t, c]) => `${t}.${c.join('/')}`).join(', ') || 'none'}): ${diff.length ? `CHANGED: ${diff.join('; ')}` : 'unchanged'}`);
if (diff.length) process.exit(3);

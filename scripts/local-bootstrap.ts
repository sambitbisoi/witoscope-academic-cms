// npm run db:local:bootstrap — runs db/bootstrap/01-cms-owner.sql on the LOCAL
// dev database only (supabase start). The real project is bootstrapped by
// Sambit in the SQL editor.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';

export const LOCAL_SUPERUSER_URL = process.env.LOCAL_SUPERUSER_URL ?? 'postgres://postgres:postgres@127.0.0.1:55422/postgres';
export const LOCAL_CMS_OWNER_PASSWORD = process.env.LOCAL_CMS_OWNER_PASSWORD ?? 'cms_owner_local';
/** cms_owner on THIS repo's local container. Tests use this, never CMS_DATABASE_URL. */
export const LOCAL_CMS_OWNER_URL = `postgres://cms_owner:${LOCAL_CMS_OWNER_PASSWORD}@127.0.0.1:55422/postgres`;

// The witoscope-app project runs its own local Supabase on the default ports
// (5432x). This project uses 5542x. Refuse any URL that is not served by THIS
// project's DB container, so we can never write into another project's database.
export const LOCAL_DB_CONTAINER = 'supabase_db_witoscope-academic-cms';

export function assertLocal(url: string) {
  const { hostname, port } = new URL(url);
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') throw new Error(`Refusing: ${hostname} is not the local dev database.`);
  const ports = execFileSync('docker', ['ps', '--filter', `name=^${LOCAL_DB_CONTAINER}$`, '--format', '{{.Ports}}'], { encoding: 'utf8' });
  if (!ports.includes(`:${port}->5432/tcp`)) {
    throw new Error(`Refusing: port ${port} is not served by ${LOCAL_DB_CONTAINER}. Run \`supabase start\` in this repo.`);
  }
}

if (import.meta.filename === process.argv[1] && process.argv[2] === '--storage') {
  // npm run db:local:storage — bootstrap 02 (Storage) on the LOCAL dev database only.
  assertLocal(LOCAL_SUPERUSER_URL);
  const sql = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
  try {
    const [has] = await sql`select 1 from storage.buckets where id = 'cms-sources'`;
    if (has) console.log('local storage bootstrap: bucket cms-sources already exists, skipped.');
    else { await sql.unsafe(readFileSync(join(import.meta.dirname, '..', 'db', 'bootstrap', '02-storage.sql'), 'utf8')); console.log('local storage bootstrap: done.'); }
    const [check] = await sql.unsafe(readFileSync(join(import.meta.dirname, '..', 'db', 'bootstrap', '02-storage.sql'), 'utf8').split('-- Verification:')[1]!.replace(/^.*\n/, ''));
    console.log(check);
    if (Object.values(check!).some((v) => v !== true)) throw new Error('storage verification failed');
  } finally {
    await sql.end();
  }
} else if (import.meta.filename === process.argv[1]) {
  assertLocal(LOCAL_SUPERUSER_URL);
  // max: 1 — the bootstrap file carries its own BEGIN/COMMIT.
  const sql = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
  try {
    const [exists] = await sql`select 1 from pg_roles where rolname = 'cms_owner'`;
    if (exists) {
      console.log('local bootstrap: cms_owner already exists, skipped. (Run `supabase db reset` to start clean.)');
    } else {
      const body = readFileSync(join(import.meta.dirname, '..', 'db', 'bootstrap', '01-cms-owner.sql'), 'utf8')
        .replace("password 'CHANGE_ME'", `password '${LOCAL_CMS_OWNER_PASSWORD}'`);
      await sql.unsafe(body);
      console.log('local bootstrap: done.');
    }
    const [check] = await sql`
      select not has_schema_privilege('cms_owner', 'auth', 'usage')         as owner_no_auth_usage,
             not has_schema_privilege('cms_owner', 'public', 'create')      as owner_no_public_create,
             has_schema_privilege('authenticated', 'cms', 'usage')          as authenticated_cms_usage,
             not has_schema_privilege('anon', 'cms', 'usage')               as anon_no_cms_usage`;
    if (Object.values(check!).some((v) => v !== true)) throw new Error('bootstrap verification failed: ' + JSON.stringify(check));
    console.log(check);
    console.log(`CMS_DATABASE_URL=postgres://cms_owner:${LOCAL_CMS_OWNER_PASSWORD}@127.0.0.1:55422/postgres`);
  } finally {
    await sql.end();
  }
}

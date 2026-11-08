// npm run db:migrate — applies db/migrations/*.sql in order, as cms_owner only.
//
// History is kept in cms.cms_schema_migrations (decision 2). An applied file
// whose contents changed is an error: write a new migration instead.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkMigrations, MIGRATIONS_DIR } from './check-migrations.ts';
import { connect } from './lib/db.ts';

const problems = checkMigrations();
if (problems.length) {
  for (const p of problems) console.error(`${p.file}:${p.line}  [${p.rule}] ${p.message}`);
  console.error('migrate: refused, check-migrations failed.');
  process.exit(1);
}

const sql = connect();
try {
  await sql`
    create table if not exists cms.cms_schema_migrations (
      file_name  text primary key,
      sha256     text not null,
      applied_at timestamptz not null default now()
    )`;
  const applied = new Map(
    (await sql<{ file_name: string; sha256: string }[]>`select file_name, sha256 from cms.cms_schema_migrations`)
      .map((r) => [r.file_name, r.sha256]),
  );

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  let ran = 0;
  for (const file of files) {
    const body = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const hash = createHash('sha256').update(body).digest('hex');
    const previous = applied.get(file);
    if (previous) {
      if (previous !== hash) throw new Error(`${file} was changed after it was applied. Add a new migration instead.`);
      continue;
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into cms.cms_schema_migrations (file_name, sha256) values (${file}, ${hash})`;
    });
    console.log(`applied ${file}`);
    ran++;
  }
  console.log(ran ? `migrate: ${ran} applied.` : 'migrate: up to date.');
} finally {
  await sql.end();
}

// npm run check-migrations — fails if any migration touches anything outside schema cms.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSql, type Problem } from './lib/check-sql.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'db', 'migrations');
export const NAME_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

export function checkMigrations(dir = MIGRATIONS_DIR): Problem[] {
  const problems: Problem[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (!NAME_PATTERN.test(file)) {
      problems.push({ file, line: 1, rule: 'file-name', message: 'name must look like 0001_short_name.sql' });
    }
    problems.push(...checkSql(readFileSync(join(dir, file), 'utf8'), file));
  }
  return problems;
}

if (import.meta.filename === process.argv[1]) {
  const problems = checkMigrations();
  for (const p of problems) console.error(`${p.file}:${p.line}  [${p.rule}] ${p.message}`);
  if (problems.length) {
    console.error(`\ncheck-migrations: ${problems.length} problem(s). Migrations may only touch schema cms.`);
    process.exit(1);
  }
  console.log('check-migrations: ok');
}

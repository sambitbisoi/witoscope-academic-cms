// Guardrail for CLAUDE.md "Database isolation": a migration may only touch
// schema cms. The single allowed outside reference is auth.uid().
//
// This is a conservative text scan, not a SQL parser: when in doubt it rejects.

export interface Problem {
  file: string;
  line: number;
  rule: string;
  message: string;
}

// Schemas that exist in a Supabase project (plus the app's own). Any
// `<schema>.` qualifier from this list is rejected, except auth.uid().
const OTHER_SCHEMAS = [
  'public', 'auth', 'storage', 'extensions', 'graphql', 'graphql_public',
  'realtime', '_realtime', '_analytics', 'supabase_functions',
  'supabase_migrations', 'vault', 'pgsodium', 'pgsodium_masks', 'net', 'cron',
  'pgbouncer', 'pg_catalog', 'information_schema', 'app',
];

/** Blank out comments, keeping line numbers and string literals. */
export function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      while (i < sql.length && sql[i] !== '\n') { out += ' '; i++; }
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      for (; i < stop; i++) out += sql[i] === '\n' ? '\n' : ' ';
    } else if (sql[i] === "'") {
      // copy the string literal verbatim ('' is an escaped quote)
      out += sql[i++];
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { out += "''"; i += 2; continue; }
        out += sql[i];
        if (sql[i++] === "'") break;
      }
    } else {
      out += sql[i++];
    }
  }
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;
const unquote = (name: string) => name.replace(/"/g, '').toLowerCase();

export function checkSql(sql: string, file: string): Problem[] {
  const text = stripComments(sql);
  const problems: Problem[] = [];
  const add = (index: number, rule: string, message: string) =>
    problems.push({ file, line: lineOf(text, index), rule, message });

  let m: RegExpExecArray | null;

  // R1: qualified references to another schema (auth.uid() is the one exception).
  const qualified = new RegExp(`(?<![\\w.])"?(${OTHER_SCHEMAS.join('|')})"?\\s*\\.\\s*"?(\\w+)"?(\\s*\\()?`, 'gi');
  while ((m = qualified.exec(text))) {
    const schema = m[1]!.toLowerCase();
    const obj = m[2]!.toLowerCase();
    if (schema === 'auth' && obj === 'uid' && m[3]) continue;
    add(m.index, 'other-schema', `references ${schema}.${obj}; only cms.* and auth.uid() are allowed`);
  }

  // R2: "schema <name>" must be cms (grant on schema, in schema, alter default privileges in schema...).
  const schemaKw = /\bschema\s+(?:if\s+(?:not\s+)?exists\s+)?("?[\w]+"?)/gi;
  while ((m = schemaKw.exec(text))) {
    const name = unquote(m[1]!);
    if (name !== 'cms') add(m.index, 'other-schema', `names schema ${name}; only cms is allowed`);
  }

  // R3: never create/alter/drop roles or schemas in a migration (bootstrap only).
  const roleOrSchema = /\b(create|alter|drop)\s+(role|user|schema|database)\b/gi;
  while ((m = roleOrSchema.exec(text))) {
    add(m.index, 'bootstrap-only', `${m[1]!.toLowerCase()} ${m[2]!.toLowerCase()} belongs in db/bootstrap, not a migration`);
  }

  // R4: created/altered/dropped objects must live in cms; tables must be cms.cms_*.
  const ddl = /\b(create(?:\s+or\s+replace)?|alter|drop)\s+(table|view|materialized\s+view|function|procedure|sequence|type|domain)\s+(?:if\s+(?:not\s+)?exists\s+)?([\w."]+)/gi;
  while ((m = ddl.exec(text))) {
    const kind = m[2]!.toLowerCase().replace(/\s+/g, ' ');
    const name = unquote(m[3]!);
    if (!name.startsWith('cms.')) {
      add(m.index, 'unqualified-object', `${kind} ${name} must be schema-qualified as cms.<name>`);
    } else if (kind === 'table' && !name.startsWith('cms.cms_')) {
      add(m.index, 'table-prefix', `table ${name} must be named cms.cms_<name>`);
    }
  }

  // R5: triggers, policies, indexes, grants, comments and FKs must point at cms objects.
  const onTarget = /\b(?:on\s+table|on\s+function|on\s+sequence|on|references)\s+(?!all\b|schema\b|delete\b|update\b|conflict\b|commit\b|(?:tables|sequences|functions|routines|types)\s+(?:to|from)\b)([\w."]+)/gi;
  while ((m = onTarget.exec(text))) {
    const name = unquote(m[1]!);
    if (/^(true|false|null)$/.test(name)) continue;
    if (!name.startsWith('cms.')) add(m.index, 'unqualified-target', `target ${name} must be schema-qualified as cms.<name>`);
  }

  // R6: no extensions except into cms.
  const ext = /\bcreate\s+extension\b[^;]*/gi;
  while ((m = ext.exec(text))) {
    if (!/\bschema\s+"?cms"?\b/i.test(m[0])) add(m.index, 'extension', 'extensions must be created with "schema cms"');
  }

  // R7: search_path may only be empty or cms.
  const sp = /\bsearch_path\s*(?:=|to)\s*([^;\n]*)/gi;
  while ((m = sp.exec(text))) {
    const value = m[1]!.trim().replace(/['"]/g, '').toLowerCase();
    if (value !== '' && value !== 'cms') add(m.index, 'search-path', `search_path must be '' or cms, got ${m[1]!.trim()}`);
  }

  // R8: nothing is ever granted to anon, public or service_role.
  const grant = /\bgrant\b[^;]*?\bto\s+([^;]+)/gi;
  while ((m = grant.exec(text))) {
    const grantees = m[1]!.toLowerCase().split(/[\s,]+/);
    for (const role of ['anon', 'public', 'service_role']) {
      if (grantees.includes(role)) add(m.index, 'grantee', `grant to ${role} is not allowed`);
    }
  }

  // R9: no dynamic SQL; it cannot be checked.
  const dyn = /\bexecute\s+(?:format\s*\(|'|\$|\w+\s*;)/gi;
  while ((m = dyn.exec(text))) add(m.index, 'dynamic-sql', 'dynamic SQL (EXECUTE ...) is not allowed in migrations');

  return problems.sort((a, b) => a.line - b.line);
}

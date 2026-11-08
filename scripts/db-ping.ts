// npm run db:ping — proves cms_owner can connect (decision 1: verify through the pooler)
// and shows exactly what it can and cannot reach.
import { assertCmsOwner, connect } from './lib/db.ts';

const sql = connect();
try {
  await assertCmsOwner(sql);
  const [r] = await sql`
    select current_user,
           inet_server_port()                                      as server_port,
           has_schema_privilege('cms', 'create')                   as cms_create,
           has_schema_privilege('auth', 'usage')                   as auth_usage,
           has_function_privilege('auth.uid()', 'execute')         as uid_execute,
           has_schema_privilege('public', 'create')                as public_create`;
  console.log(r);
  if (!r!.cms_create || !r!.auth_usage || !r!.uid_execute) throw new Error('cms_owner is missing a bootstrap grant.');
  if (r!.public_create) console.warn('warning: cms_owner can create in public; it never should. Check the project defaults.');
  const host = new URL(process.env.CMS_DATABASE_URL!).hostname;
  console.log(`db:ping ok via ${host}${host.includes('pooler.supabase.com') ? ' (pooler)' : ''}`);
} finally {
  await sql.end();
}

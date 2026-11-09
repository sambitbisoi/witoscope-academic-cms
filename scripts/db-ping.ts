// npm run db:ping — proves cms_owner can connect (decision 1: verify through the pooler)
// and shows exactly what it can and cannot reach.
import { assertCmsOwner, connect } from './lib/db.ts';

const sql = connect();
try {
  await assertCmsOwner(sql);
  const [r] = await sql`
    select current_user,
           has_schema_privilege('cms', 'create')     as cms_create,
           has_schema_privilege('auth', 'usage')     as auth_usage,
           has_schema_privilege('public', 'create')  as public_create`;
  console.log(r);
  if (!r!.cms_create) throw new Error('cms_owner cannot create in cms; check the bootstrap.');
  if (r!.auth_usage) console.warn('warning: cms_owner has USAGE on auth; option 1 says it should not.');
  if (r!.public_create) console.warn('warning: cms_owner can create in public; it never should. Check the project defaults.');
  const host = new URL(process.env.CMS_DATABASE_URL!).hostname;
  console.log(`db:ping ok via ${host}${host.includes('pooler.supabase.com') ? ' (pooler)' : ''}`);
} finally {
  await sql.end();
}

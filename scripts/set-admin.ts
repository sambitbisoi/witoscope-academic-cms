// npm run db:set-admin -- <auth-user-uuid>
// Stores the admin user ID in cms_config (as cms_owner) and logs the change.
import { assertCmsOwner, connect } from './lib/db.ts';

const uid = process.argv[2];
if (!uid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uid)) {
  console.error('usage: npm run db:set-admin -- <auth-user-uuid>');
  process.exit(1);
}

const sql = connect();
try {
  await assertCmsOwner(sql);
  await sql.begin(async (tx) => {
    const [before] = await tx`select value from cms.cms_config where key = 'admin_user_id'`;
    await tx`
      insert into cms.cms_config (key, value, note)
      values ('admin_user_id', ${tx.json(uid)}, 'Only this auth user passes RLS')
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
    await tx`
      insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label)
      values ('catalogue', 'cms_config', 'admin_user_id', 'edit_catalogue',
              ${tx.json({ value: { before: before?.value ?? null, after: uid } })}, 'set-admin script')`;
  });
  console.log(`admin_user_id = ${uid}`);
} finally {
  await sql.end();
}

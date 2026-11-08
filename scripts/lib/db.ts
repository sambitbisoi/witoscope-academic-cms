// The one way scripts connect to the database: as cms_owner, never service_role.
import postgres from 'postgres';

export function connect(url = process.env.CMS_DATABASE_URL) {
  if (!url) throw new Error('CMS_DATABASE_URL is not set (see .env.example).');
  const user = decodeURIComponent(new URL(url).username).split('.')[0];
  if (user !== 'cms_owner') {
    throw new Error(`Refusing to connect as "${user}". Scripts must connect as cms_owner.`);
  }
  // prepare: false keeps this working through the Supabase pooler.
  return postgres(url, { prepare: false, onnotice: () => {}, connection: { application_name: 'witoscope-cms' } });
}

/** Belt and braces: confirm the server agrees we are cms_owner. */
export async function assertCmsOwner(sql: ReturnType<typeof connect>) {
  const [row] = await sql<{ current_user: string }[]>`select current_user`;
  if (row?.current_user !== 'cms_owner') throw new Error(`Connected as ${row?.current_user}, expected cms_owner.`);
}

// The one way scripts connect to the database: as cms_owner, never service_role.
import postgres from 'postgres';
import { assertLocal, LOCAL_CMS_OWNER_URL } from '../local-bootstrap.ts';

// Default: THIS repo's local container. The real project is reached only by naming
// it explicitly: `npx tsx --env-file=.env.real scripts/<script>.ts` (runbook).
// npm scripts never read .env, so a .env pointing at the real project is harmless.
export const targetUrl = () => process.env.CMS_DATABASE_URL ?? LOCAL_CMS_OWNER_URL;

export function connect(url = targetUrl()) {
  const user = decodeURIComponent(new URL(url).username).split('.')[0];
  if (user !== 'cms_owner') {
    throw new Error(`Refusing to connect as "${user}". Scripts must connect as cms_owner.`);
  }
  const host = new URL(url).hostname;
  if (host === '127.0.0.1' || host === 'localhost') assertLocal(url);
  // prepare: false keeps this working through the Supabase pooler.
  return postgres(url, { prepare: false, onnotice: () => {}, connection: { application_name: 'witoscope-cms' } });
}

/** Belt and braces: confirm the server agrees we are cms_owner. */
export async function assertCmsOwner(sql: ReturnType<typeof connect>) {
  const [row] = await sql<{ current_user: string }[]>`select current_user`;
  if (row?.current_user !== 'cms_owner') throw new Error(`Connected as ${row?.current_user}, expected cms_owner.`);
}

import { createClient } from '@supabase/supabase-js';

// Public values only: the project URL and the anon key. RLS protects the data.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configError = !url || !anonKey ? 'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are not set (see .env.example).' : null;

export const supabase = createClient(url ?? 'http://invalid.local', anonKey ?? 'missing', {
  db: { schema: 'cms' },
  auth: { persistSession: true, autoRefreshToken: true },
});

/** True only for the admin stored in cms_config (the same check RLS uses). */
export async function isAdmin(userId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('cms_is_admin', { uid: userId });
  if (error) throw error;
  return data === true;
}

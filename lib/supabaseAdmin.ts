// Server-side Supabase client using the service-role key — bypasses Row
// Level Security entirely. This must NEVER be imported from client code
// (components/, apps/, or lib/supabaseClient.ts's browser path); only
// api/*.ts serverless functions should import it. It exists solely for
// api/guest-usage.ts, which needs to read/write per-IP usage rows that
// aren't scoped to any auth.uid() — there's no logged-in user to run RLS
// policies against for an anonymous guest.

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const isSupabaseAdminConfigured = !!(url && serviceKey);

export const supabaseAdmin: SupabaseClient | null = isSupabaseAdminConfigured
  ? createClient(url!, serviceKey!, { auth: { persistSession: false } })
  : null;

if (!isSupabaseAdminConfigured) {
  console.warn(
    '[supabase-admin] VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — ' +
    'api/guest-usage.ts will fail open (no daily guest limit enforced).'
  );
}

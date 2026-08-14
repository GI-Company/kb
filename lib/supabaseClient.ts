// Supabase client — browser-side, using the anon public key (safe to
// expose to the client by design; every table in supabase/schema.sql has
// Row Level Security scoped to auth.uid(), which is what actually enforces
// access, not secrecy of this key). Vite only exposes env vars prefixed
// VITE_ to client code, unlike api/*.ts's plain process.env.X (those run
// server-side, where there's no such prefix requirement).
//
// Specifically NOT the NEXT_PUBLIC_ prefix — that's Next.js's convention,
// not Vite's, and Vite silently ignores anything not prefixed VITE_ (no
// error, no warning at the framework level — it just isn't in
// import.meta.env). Confirmed live in production once: Vercel had
// NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY set correctly and
// this app stayed in guest-only mode anyway, because those names never
// reach import.meta.env in a Vite build.
//
// `supabase` is null when the env vars aren't configured — every caller
// must handle that (falls back to the guest/localStorage path) rather than
// assuming Supabase is always available, since it wasn't for most of this
// project's life and doesn't have to be to keep working.

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = !!(url && anonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, anonKey!)
  : null;

if (!isSupabaseConfigured) {
  console.warn(
    '[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set — running in guest-only mode (localStorage). ' +
    'Set both to enable real accounts and Supabase-backed chat history.'
  );
}

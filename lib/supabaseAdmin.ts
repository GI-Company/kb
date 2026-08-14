// Server-side Supabase access for api/guest-usage.ts — deliberately plain
// fetch() against Supabase's PostgREST RPC endpoint rather than the
// @supabase/supabase-js SDK. Every other Supabase call in this project runs
// client-side, in the browser bundle; this file is the first time Supabase
// gets touched from inside a Vercel serverless function, and the SDK
// crashed there in production (FUNCTION_INVOCATION_FAILED on every guest
// heartbeat, confirmed live) — plausibly some browser-oriented assumption
// inside the SDK that doesn't hold in that runtime. A raw fetch call has no
// such surface: it's the same mechanism api/chat.ts already uses
// successfully against Groq, and PostgREST's RPC contract is simple enough
// not to need a client library at all.
//
// Uses the service-role key, which bypasses Row Level Security entirely —
// this file must NEVER be imported from client code (components/, apps/,
// or lib/supabaseClient.ts's browser path).

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const isSupabaseAdminConfigured = !!(url && serviceKey);

if (!isSupabaseAdminConfigured) {
  console.warn(
    '[supabase-admin] VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — ' +
    'api/guest-usage.ts will fail open (no daily guest limit enforced).'
  );
}

/** Calls a Postgres function via PostgREST's /rpc/ endpoint using the service-role key. Throws on any non-2xx response. */
export async function callSupabaseRpc<T = unknown>(fnName: string, args: Record<string, unknown>): Promise<T> {
  if (!isSupabaseAdminConfigured) {
    throw new Error('Supabase admin client not configured');
  }
  const res = await fetch(`${url}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: serviceKey!,
      authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase RPC "${fnName}" failed (${res.status}): ${text}`);
  }
  return res.json();
}

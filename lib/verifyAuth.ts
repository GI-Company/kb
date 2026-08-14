// Server-side verification of a Supabase access token — used to gate
// terminal capabilities that only make sense for real accounts (network
// commands, headless-browser rendering; see api/exec.ts and
// api/browser-render.ts). Guests keep the existing coreutils-only sandbox
// with no auth check at all.
//
// Plain fetch against Supabase Auth's REST endpoint, same reasoning as
// lib/supabaseAdmin.ts: this project's one prior attempt at using
// @supabase/supabase-js from inside a Vercel serverless function crashed
// in production (ERR_MODULE_NOT_FOUND, unrelated root cause, but the fetch-
// based approach sidesteps that whole class of problem and is proven
// working — api/chat.ts and api/guest-usage.ts both already do this). The
// anon key (safe to hold server-side too, same key the browser already
// uses) is enough here — /auth/v1/user validates whatever access token is
// passed in the Authorization header and returns the user it belongs to.

const url = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;

export interface VerifiedUser {
  id: string;
  email?: string;
}

export async function verifyAccessToken(token: string | null): Promise<VerifiedUser | null> {
  if (!token || !url || !anonKey) return null;
  try {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anonKey, authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.id ? { id: data.id as string, email: data.email as string | undefined } : null;
  } catch {
    return null;
  }
}

/** Pulls a bearer token out of either an Edge Request or a Node IncomingMessage-shaped req. */
export function extractBearerToken(req: any): string | null {
  const headerValue: string | undefined = typeof req?.headers?.get === 'function'
    ? req.headers.get('authorization') ?? undefined
    : Array.isArray(req?.headers?.authorization)
    ? req.headers.authorization[0]
    : req?.headers?.authorization;
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue);
  return match ? match[1] : null;
}

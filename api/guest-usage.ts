// Daily guest usage quota — 15 minutes/day, keyed by IP (hashed, never
// stored raw). Guests aren't authenticated, so there's no auth.uid() to
// scope a normal RLS-protected table to; this table is only ever touched
// server-side via the service-role client (lib/supabaseAdmin.ts), which
// bypasses RLS, and the browser never talks to it directly.
//
// Request:  POST { elapsedSeconds: number } — seconds since the client's
//           last heartbeat (0 for an initial "just tell me where I stand" check)
// Response: { usedSeconds, limitSeconds, remainingSeconds, allowed, configured }
//
// FAILURE POLICY — the two failure modes are treated differently on
// purpose, because they mean different things:
//
//   Missing service-role key in production -> FAIL CLOSED.
//     There is no quota at all in this state. Silently allowing unlimited
//     guest access on a deployment that believes it is metered is a
//     configuration error masquerading as working software, and it is
//     invisible precisely when it matters. Guests are refused with a clear
//     message and the server logs why. Set GUEST_QUOTA_REQUIRED=false to
//     deliberately run without a quota.
//
//   Missing key outside production -> fail open.
//     Local development shouldn't need Supabase configured to click around.
//
//   Transient DB error -> fail open.
//     A blip should not evict someone mid-session. This is a real (small)
//     hole: an attacker who can reliably break the DB call gets unmetered
//     access. Accepted because the alternative — locking every guest out
//     during a Supabase incident — is worse for a free tier whose whole
//     purpose is frictionless trial.

import { createHash } from 'node:crypto';
import { checkRateLimit, getClientIp, rateLimitResponseHeaders } from '../lib/rateLimit.js';
import { callSupabaseRpc, isSupabaseAdminConfigured } from '../lib/supabaseAdmin.js';

const LIMIT_SECONDS = 15 * 60;
// Heartbeats fire ~every 20s from lib/guestUsage.ts — a few/minute is
// normal traffic; this just catches a runaway client, not real users.
const RATE_LIMIT_PER_MIN = 10;
// Caps what a single heartbeat can add, so a manipulated/replayed request
// can't report a huge elapsed value and burn a whole day's quota in one call.
const MAX_ELAPSED_PER_HEARTBEAT = 120;

// VERCEL_ENV is 'production' only on production deployments; previews and
// local dev report otherwise, so this doesn't lock out preview branches.
const IS_PRODUCTION = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
// Explicit opt-out for anyone who genuinely wants unmetered guests in prod.
const QUOTA_OPTIONAL = process.env.GUEST_QUOTA_REQUIRED === 'false';

interface Body {
  elapsedSeconds?: number;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const ip = getClientIp(req);
  const rl = await checkRateLimit(`guest-usage:${ip}`, RATE_LIMIT_PER_MIN);
  for (const [k, v] of Object.entries(rateLimitResponseHeaders(rl))) res.setHeader?.(k, v);
  if (!rl.allowed) {
    res.status(429).json({ error: 'Rate limit exceeded' });
    return;
  }

  const body: Body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const elapsedSeconds = Math.max(0, Math.min(MAX_ELAPSED_PER_HEARTBEAT, Math.round(Number(body.elapsedSeconds) || 0)));

  if (!isSupabaseAdminConfigured) {
    if (IS_PRODUCTION && !QUOTA_OPTIONAL) {
      console.error(
        '[guest-usage] SUPABASE_SERVICE_ROLE_KEY is not set in production, so the guest quota ' +
        'cannot be enforced. Refusing guest access rather than silently granting unlimited use. ' +
        'Set the key, or set GUEST_QUOTA_REQUIRED=false to run without a quota on purpose.'
      );
      res.status(503).json({
        usedSeconds: 0,
        limitSeconds: LIMIT_SECONDS,
        remainingSeconds: 0,
        allowed: false,
        configured: false,
        error: 'Guest access is temporarily unavailable on this deployment. Please sign in.',
      });
      return;
    }
    res.status(200).json({ usedSeconds: 0, limitSeconds: LIMIT_SECONDS, remainingSeconds: null, allowed: true, configured: false });
    return;
  }

  const ipHash = createHash('sha256').update(ip).digest('hex');
  const usageDate = new Date().toISOString().slice(0, 10); // UTC calendar day

  let usedSeconds = 0;
  try {
    const result = await callSupabaseRpc<number>('increment_guest_usage', {
      p_ip_hash: ipHash,
      p_usage_date: usageDate,
      p_seconds: elapsedSeconds,
    });
    usedSeconds = typeof result === 'number' ? result : 0;
  } catch (err: any) {
    console.error('[guest-usage] increment_guest_usage failed:', err?.message || err);
    res.status(200).json({ usedSeconds: 0, limitSeconds: LIMIT_SECONDS, remainingSeconds: null, allowed: true, configured: true, error: true });
    return;
  }

  const remainingSeconds = Math.max(0, LIMIT_SECONDS - usedSeconds);
  res.status(200).json({
    usedSeconds,
    limitSeconds: LIMIT_SECONDS,
    remainingSeconds,
    allowed: usedSeconds < LIMIT_SECONDS,
    configured: true,
  });
}

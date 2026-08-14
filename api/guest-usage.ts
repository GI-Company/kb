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
// Fails open (allowed: true, remainingSeconds: null) if the service-role
// key isn't configured yet or the DB call errors — a guest daily cap isn't
// worth breaking guest access entirely over a missing env var or a
// transient DB hiccup.

import { createHash } from 'node:crypto';
import { checkRateLimit, getClientIp, rateLimitResponseHeaders } from '../lib/rateLimit';
import { callSupabaseRpc, isSupabaseAdminConfigured } from '../lib/supabaseAdmin';

const LIMIT_SECONDS = 15 * 60;
// Heartbeats fire ~every 20s from lib/guestUsage.ts — a few/minute is
// normal traffic; this just catches a runaway client, not real users.
const RATE_LIMIT_PER_MIN = 10;
// Caps what a single heartbeat can add, so a manipulated/replayed request
// can't report a huge elapsed value and burn a whole day's quota in one call.
const MAX_ELAPSED_PER_HEARTBEAT = 120;

interface Body {
  elapsedSeconds?: number;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const ip = getClientIp(req);
  const rl = checkRateLimit(`guest-usage:${ip}`, RATE_LIMIT_PER_MIN);
  for (const [k, v] of Object.entries(rateLimitResponseHeaders(rl))) res.setHeader?.(k, v);
  if (!rl.allowed) {
    res.status(429).json({ error: 'Rate limit exceeded' });
    return;
  }

  const body: Body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const elapsedSeconds = Math.max(0, Math.min(MAX_ELAPSED_PER_HEARTBEAT, Math.round(Number(body.elapsedSeconds) || 0)));

  if (!isSupabaseAdminConfigured) {
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

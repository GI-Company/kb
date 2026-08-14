// Per-IP fixed-window rate limiting for api/chat.ts and api/exec.ts.
//
// In-memory by design, not distributed — this only limits requests hitting
// the SAME warm function instance, not across every instance Vercel might
// spin up under real concurrent load. That's a real, known gap, not an
// oversight: proper distributed limiting needs a shared store (Upstash
// Redis is the standard pairing with Vercel and has a free tier + a
// one-click Vercel integration that auto-injects env vars). This module is
// deliberately the one place that decision lives — swap the body of
// `checkRateLimit` for an Upstash-backed check later and neither caller
// changes. Until then, in-memory is still real protection: it catches the
// common case (a script hammering the same endpoint in a burst) even
// though it resets on cold start and isn't shared across instances.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;

// Opportunistic cleanup so `buckets` doesn't grow unbounded on a
// long-warm instance — cheap since it only runs a fraction of the time.
function maybeCleanup() {
  if (Math.random() > 0.02) return;
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

export function checkRateLimit(key: string, limit: number): RateLimitResult {
  maybeCleanup();
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return {
    allowed: bucket.count <= limit,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt,
  };
}

/** Extracts a best-effort client identifier from either an Edge Request or a Node IncomingMessage-shaped req. */
export function getClientIp(req: any): string {
  const headerValue = (name: string): string | null => {
    if (typeof req?.headers?.get === 'function') return req.headers.get(name);
    const v = req?.headers?.[name];
    return Array.isArray(v) ? v[0] : v ?? null;
  };

  const forwardedFor = headerValue('x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',')[0].trim();

  const realIp = headerValue('x-real-ip');
  if (realIp) return realIp;

  return req?.socket?.remoteAddress || 'unknown';
}

export function rateLimitResponseHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'x-ratelimit-limit': String(result.limit),
    'x-ratelimit-remaining': String(result.remaining),
    'x-ratelimit-reset': String(Math.ceil(result.resetAt / 1000)),
  };
}

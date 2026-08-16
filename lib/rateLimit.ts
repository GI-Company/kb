// Per-IP fixed-window rate limiting for api/chat.ts and api/exec.ts.
//
// Distributed when Upstash Redis is configured, in-memory otherwise.
//
// The in-memory path only limits requests hitting the SAME warm function
// instance, so under real concurrency the effective limit was roughly
// (limit x instances) rather than the number configured. Setting
// UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN makes the counter
// shared, and the limit means what it says.
//
// Raw fetch against Upstash's REST API rather than the SDK, matching the
// pattern lib/supabaseAdmin.ts already uses — an SDK in a serverless
// function caused a production crash on this project once, and this needs
// exactly two Redis commands.
//
// If Redis is configured but unreachable, this falls back to the in-memory
// counter rather than failing the request. A cache outage shouldn't take
// the API down, and degraded limiting beats none.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;
const WINDOW_SECONDS = WINDOW_MS / 1000;

const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
export const isDistributedRateLimitConfigured = !!(upstashUrl && upstashToken);

if (!isDistributedRateLimitConfigured) {
  console.warn(
    '[rateLimit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — ' +
    'falling back to per-instance in-memory limiting. Limits will be roughly ' +
    '(limit x concurrent instances) rather than global.'
  );
}

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

/**
 * One round trip: INCR the counter, and set the TTL only if the key had
 * none (`NX`). Without NX every request would push the expiry out, turning
 * the fixed window into a sliding one that never resets under sustained
 * load — a caller at the limit would be locked out indefinitely.
 */
async function checkViaUpstash(key: string, limit: number): Promise<RateLimitResult | null> {
  try {
    const res = await fetch(`${upstashUrl}/pipeline`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${upstashToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify([
        ['INCR', key],
        ['EXPIRE', key, String(WINDOW_SECONDS), 'NX'],
      ]),
    });
    if (!res.ok) return null;

    const body = await res.json();
    const count = Number(body?.[0]?.result);
    if (!Number.isFinite(count)) return null;

    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      // Upstash doesn't return the TTL from this pipeline, and a second
      // round trip to fetch it isn't worth it — this value only feeds an
      // advisory x-ratelimit-reset header.
      resetAt: Date.now() + WINDOW_MS,
    };
  } catch {
    return null; // unreachable — caller falls back to in-memory
  }
}

function checkInMemory(key: string, limit: number): RateLimitResult {
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

export async function checkRateLimit(key: string, limit: number): Promise<RateLimitResult> {
  if (isDistributedRateLimitConfigured) {
    const result = await checkViaUpstash(key, limit);
    if (result) return result;
    console.warn('[rateLimit] Upstash unreachable — falling back to in-memory for this request.');
  }
  return checkInMemory(key, limit);
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

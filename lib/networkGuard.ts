// Blocks outbound requests (from api/exec.ts's curl/ping commands) to
// private, loopback, link-local, and other non-public IP ranges — without
// this, an authenticated terminal that can make real HTTP requests is a
// ready-made SSRF tool against Vercel's own internal network (the classic
// target is the 169.254.169.254 cloud metadata endpoint, covered by the
// link-local block below).
//
// Known gap: this validates the hostname's resolved IP once, up front.
// It does not pin the connection to that exact IP, so a DNS-rebinding
// attacker who controls the target domain could in principle serve a
// public IP to this check and a private one to the actual TCP connection
// a few milliseconds later. Closing that fully means bypassing fetch()'s
// own DNS resolution with a custom low-level connect — real added
// complexity for a narrow attack window against a small, authenticated
// (not anonymous) user base. Documented rather than silently assumed
// solved; revisit if this terminal ever opens up beyond signed-in users.

import { lookup } from 'node:dns/promises';

const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateIPv4(ip: string): boolean {
  const match = IPV4_LITERAL.exec(ip);
  if (!match) return true; // not a well-formed IPv4 — treat as unsafe rather than guess
  const [a, b, c] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast (224-239) + reserved (240-255)
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique local
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

export interface ValidatedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Resolves `hostname` (a literal IP or a domain name), validates every
 * returned address against the private/reserved ranges, and returns the
 * one address a caller should actually connect to — not just whether one
 * exists. This is what closes the DNS-rebinding gap `assertPublicHost`
 * documents: a caller that re-resolves the hostname itself a moment later
 * (fetch(), net.connect() given a hostname, ...) is trusting a second,
 * independent lookup an attacker's own authoritative DNS server could
 * answer differently — with a 0-TTL public address for this check and a
 * private one for the real connection. Pinning to the address returned
 * here, instead of the hostname, means that second lookup never happens.
 */
export async function resolvePinnedAddress(hostname: string): Promise<ValidatedAddress> {
  const isIPv4Literal = IPV4_LITERAL.test(hostname);
  const isIPv6Literal = hostname.includes(':') && !hostname.includes('/');
  if (isIPv4Literal) {
    if (isPrivateIPv4(hostname)) {
      throw new Error(`refusing to connect to "${hostname}" — private/internal address ranges are blocked`);
    }
    return { address: hostname, family: 4 };
  }
  if (isIPv6Literal) {
    if (isPrivateIPv6(hostname)) {
      throw new Error(`refusing to connect to "${hostname}" — private/internal address ranges are blocked`);
    }
    return { address: hostname, family: 6 };
  }

  let records: { address: string; family: number }[];
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (err: any) {
    throw new Error(`DNS lookup failed for "${hostname}": ${err?.message || err}`);
  }
  if (records.length === 0) {
    throw new Error(`DNS lookup for "${hostname}" returned no addresses`);
  }
  for (const { address, family } of records) {
    const isPrivate = family === 6 ? isPrivateIPv6(address) : isPrivateIPv4(address);
    if (isPrivate) {
      throw new Error(`refusing to connect to "${hostname}" — it resolves to a private/internal address (${address})`);
    }
  }
  // Every returned address was validated above — pin to the first, the
  // same one a normal client would connect to first given this order.
  const first = records[0];
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/**
 * Throws if `hostname` resolves to a private/internal address, resolves
 * (no return value) otherwise. Kept as its own function, distinct from
 * resolvePinnedAddress, because api/browser-render.ts's use case (checking
 * a URL before handing it to Puppeteer, which then does its own,
 * unpinnable connection inside the browser process) has nothing to pin to
 * — there's no way to force Chromium's network stack onto one address the
 * way a Node http.request's `lookup` option can.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  await resolvePinnedAddress(hostname);
}

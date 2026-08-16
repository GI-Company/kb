import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The client half of the fail-closed policy. api/guest-usage.ts returns 503
// with allowed:false when it cannot enforce the quota in production; if the
// client treated that like a network blip, the server's refusal would be
// cosmetic and unmetered access would be granted anyway.

const realFetch = globalThis.fetch;

async function loadModule() {
  vi.resetModules();
  return import('./guestUsage');
}

describe('guest usage heartbeat', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => { globalThis.fetch = realFetch; });

  it('honors a deliberate refusal (503 with allowed:false)', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ usedSeconds: 0, limitSeconds: 900, remainingSeconds: 0, allowed: false, configured: false }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    )) as any;

    const mod = await loadModule();
    const seen: { allowed: boolean }[] = [];
    const stop = mod.startGuestUsageTracking(s => seen.push({ allowed: s.allowed }));
    // The countdown ticks optimistically before the first round trip
    // resolves, so the refusal arrives on a later callback rather than the
    // first — what matters is that it arrives at all.
    await vi.waitFor(() => expect(seen.some(s => !s.allowed)).toBe(true), { timeout: 3000 });
    stop();

    expect(seen.some(s => !s.allowed)).toBe(true);
  });

  // A transient failure must NOT evict someone mid-session, so a 500 with no
  // usable body is ignored rather than treated as a refusal.
  it('ignores a transient error without a refusal body', async () => {
    globalThis.fetch = vi.fn(async () => new Response('gateway blew up', { status: 500 })) as any;

    const mod = await loadModule();
    const seen: { allowed: boolean }[] = [];
    const stop = mod.startGuestUsageTracking(s => seen.push({ allowed: s.allowed }));
    await new Promise(r => setTimeout(r, 300));
    stop();

    // Either nothing was reported, or it stayed allowed — never a refusal.
    expect(seen.every(s => s.allowed)).toBe(true);
  });

  it('passes a normal allowed response through', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ usedSeconds: 60, limitSeconds: 900, remainingSeconds: 840, allowed: true, configured: true }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )) as any;

    const mod = await loadModule();
    const seen: { allowed: boolean; remainingSeconds: number }[] = [];
    const stop = mod.startGuestUsageTracking(s => seen.push({ allowed: s.allowed, remainingSeconds: s.remainingSeconds }));
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 2000 });
    stop();

    expect(seen[0].allowed).toBe(true);
  });
});

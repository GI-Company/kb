import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Mocked so the pinning tests below can hand runCurl a validated address
// that doesn't match whatever the hostname would really resolve to —
// exactly the situation resolvePinnedAddress exists to make safe. Both
// exports are stubbed (not just resolvePinnedAddress) so that stashing this
// session's networkCommands.ts changes and re-running these tests as a
// negative control still resolves cleanly against the old assertPublicHost
// call site, instead of failing on a missing mock export.
const resolvePinnedAddressMock = vi.fn();
vi.mock('./networkGuard', () => ({
  resolvePinnedAddress: (...args: any[]) => resolvePinnedAddressMock(...args),
  assertPublicHost: async (hostname: string) => { await resolvePinnedAddressMock(hostname); },
}));

import { runCurl, runDig, runPing, NETWORK_USAGE } from './networkCommands';

// A failure that only says what went wrong leaves the user to guess what to
// type instead. Every argument-validation failure has to carry its usage.

describe('network command failures are actionable', () => {
  it('curl with no URL shows usage and an example', async () => {
    const r = await runCurl([]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('no URL provided');
    expect(r.stderr).toContain('Usage: curl <url>');
    expect(r.stderr).toContain('https://example.com');
  });

  it('curl with a bare hostname explains the missing scheme', async () => {
    const r = await runCurl(['example.com']);
    expect(r.stderr).toContain('include the scheme');
    expect(r.stderr).toContain('Usage: curl <url>');
  });

  it('curl on a non-http protocol says which are allowed, with usage', async () => {
    const r = await runCurl(['file:///etc/passwd']);
    expect(r.stderr).toContain('only http and https');
    expect(r.stderr).toContain('Usage: curl <url>');
  });

  it('dig with no hostname shows usage', async () => {
    const r = await runDig([]);
    expect(r.stderr).toContain('no hostname provided');
    expect(r.stderr).toContain('Usage: dig <hostname>');
  });

  it('ping with no hostname shows usage', async () => {
    const r = await runPing([]);
    expect(r.stderr).toContain('no hostname provided');
    expect(r.stderr).toContain('Usage: ping <hostname>');
  });

  // The usage strings are shared with api/exec.ts's `help` output, so a
  // command added here without a usage line would silently degrade both.
  it('every network command has a usage line', () => {
    for (const cmd of ['curl', 'dig', 'ping']) {
      expect(NETWORK_USAGE[cmd]).toMatch(/^Usage: /);
      expect(NETWORK_USAGE[cmd]).toContain('e.g.');
    }
  });

  it('ends with a newline so the terminal does not run lines together', async () => {
    const r = await runCurl([]);
    expect(r.stderr.endsWith('\n')).toBe(true);
  });
});

// The DNS-rebinding gap networkGuard.ts documents: validating a hostname's
// resolved IP once and then letting the real request re-resolve it
// independently gives an attacker's authoritative DNS server a second,
// separate chance to answer — with a public address for the check and a
// private one for the connection that actually happens a moment later.
// resolvePinnedAddress + pinnedRequest close it by resolving exactly once
// and pinning the real connection to that address via Node's `lookup`
// request option, never letting it ask again.
//
// These tests use hostnames under the .invalid TLD (RFC 2606 — reserved to
// NEVER resolve, by design, forever) as the proof: resolvePinnedAddress is
// mocked to hand back this test server's real loopback address, and the
// request is expected to actually reach that server. That can only happen
// if the connection used the pinned address directly — a hostname that
// cannot resolve for real would fail with ENOTFOUND under any code path
// that still asks the OS to resolve it a second time.
describe('pinned connections close the DNS-rebinding gap', () => {
  let server: Server;
  let port: number;
  let lastHeaders: Record<string, string | string[] | undefined> = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      lastHeaders = req.headers;
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/after-redirect' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('pinned-ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  beforeEach(() => {
    resolvePinnedAddressMock.mockReset();
    resolvePinnedAddressMock.mockResolvedValue({ address: '127.0.0.1', family: 4 });
  });

  it('reaches a hostname that cannot really resolve, by pinning to the validated address, resolving it exactly once', async () => {
    const r = await runCurl([`http://pin-test.invalid:${port}/`]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('pinned-ok');
    expect(resolvePinnedAddressMock).toHaveBeenCalledTimes(1);
    expect(resolvePinnedAddressMock).toHaveBeenCalledWith('pin-test.invalid');
  });

  it('preserves the original Host header rather than leaking the pinned address to the destination', async () => {
    await runCurl([`http://pin-test.invalid:${port}/`]);
    expect(lastHeaders.host).toBe(`pin-test.invalid:${port}`);
  });

  it('re-resolves and re-pins each redirect hop independently, rather than trusting the first hop for the rest of the chain', async () => {
    const r = await runCurl([`http://pin-test.invalid:${port}/redirect`]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('pinned-ok');
    // One resolution for the initial request, one for the redirect target —
    // each hop gets its own validate-then-pin, since a hop later in the
    // chain is just as capable of pointing somewhere private as the first.
    expect(resolvePinnedAddressMock).toHaveBeenCalledTimes(2);
  });

  it('reports a clear curl error when the hostname is refused, without ever reaching the network', async () => {
    resolvePinnedAddressMock.mockReset();
    resolvePinnedAddressMock.mockRejectedValue(new Error('refusing to connect to "internal.invalid" — it resolves to a private/internal address (10.0.0.5)'));

    const r = await runCurl(['http://internal.invalid/']);

    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('private/internal address');
  });
});

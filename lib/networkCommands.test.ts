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

import { runCurl, runDig, runPing, runWget, NETWORK_USAGE } from './networkCommands';

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

// curl -O/-o and wget only fetch and hand back bytes here — the actual VFS
// write happens client-side (see terminalFs.ts's saveDownload and
// CommandResult.download's doc comment for why). What these prove: the
// right bytes come back, byte-for-byte even when they're not valid UTF-8
// (the whole reason PinnedResponse has a buffer() method distinct from
// text()), under the right name, and a bad response (404, oversized) is
// refused rather than handed back as if it were the real file.
describe('curl -O/-o and wget download bytes for the client to write', () => {
  let server: Server;
  let port: number;

  // Deliberately NOT valid UTF-8 (0xFF/0xFE are never valid UTF-8 lead
  // bytes) — if the download path accidentally used text() instead of
  // buffer() anywhere, decoding through UTF-8 and back would replace these
  // with U+FFFD and this test would catch it as corruption.
  const BINARY_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01, 0x80, 0x81]);

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/logo.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(BINARY_BYTES);
        return;
      }
      if (req.url === '/missing') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      if (req.url === '/huge') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.alloc(2_100_000, 7)); // > MAX_DOWNLOAD_BYTES (2,000,000)
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  beforeEach(() => {
    resolvePinnedAddressMock.mockReset();
    resolvePinnedAddressMock.mockResolvedValue({ address: '127.0.0.1', family: 4 });
  });

  it('curl -O names the file from the URL and returns the exact bytes as base64', async () => {
    const r = await runCurl([`http://dl-test.invalid:${port}/logo.png`, '-O']);

    expect(r.code).toBe(0);
    expect(r.download).toBeDefined();
    expect(r.download!.name).toBe('logo.png');
    expect(r.download!.encoding).toBe('base64');
    expect(Buffer.from(r.download!.contentBase64, 'base64')).toEqual(BINARY_BYTES);
    // stdout reports progress, not success — the write hasn't happened yet
    // at this point, it's still on its way to the client.
    expect(r.stdout).not.toMatch(/^Saved/);
  });

  it('curl -o <path> saves under the explicit name instead of the URL basename', async () => {
    const r = await runCurl([`http://dl-test.invalid:${port}/logo.png`, '-o', 'assets/brand.png']);

    expect(r.code).toBe(0);
    expect(r.download!.name).toBe('assets/brand.png');
    expect(Buffer.from(r.download!.contentBase64, 'base64')).toEqual(BINARY_BYTES);
  });

  it('wget <url> behaves like curl -O — names the file from the URL', async () => {
    const r = await runWget([`http://dl-test.invalid:${port}/logo.png`]);

    expect(r.code).toBe(0);
    expect(r.download!.name).toBe('logo.png');
    expect(Buffer.from(r.download!.contentBase64, 'base64')).toEqual(BINARY_BYTES);
  });

  it('wget -O <path> behaves like curl -o — saves under the explicit name', async () => {
    const r = await runWget([`http://dl-test.invalid:${port}/logo.png`, '-O', 'renamed.png']);

    expect(r.code).toBe(0);
    expect(r.download!.name).toBe('renamed.png');
  });

  it('curl -O on a URL with no path segment to name it after is refused, not silently misnamed', async () => {
    const r = await runCurl([`http://dl-test.invalid:${port}/`, '-O']);

    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('remote file name has no length');
    expect(r.download).toBeUndefined();
  });

  it('a 404 is refused rather than saved under the requested name', async () => {
    const r = await runCurl([`http://dl-test.invalid:${port}/missing`, '-O']);

    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('404');
    expect(r.download).toBeUndefined();
  });

  it('a response over the download size cap is refused, not truncated and saved anyway', async () => {
    const r = await runCurl([`http://dl-test.invalid:${port}/huge`, '-O']);

    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/2\.0MB|limit/);
    expect(r.download).toBeUndefined();
  });

  // Regression coverage for a real bug this feature introduced and fixed in
  // the same pass: `curl -o <path> <url>` was resolving "<path>" itself as
  // the URL (since -o's own value sits at args[0], the same index a bare
  // `curl <url>` puts its only argument at), because the index-exclusion
  // guard didn't account for oIndex being -1 when -o is absent elsewhere.
  // Asserted here with -o first, before the URL, the exact shape that broke.
  it('does not mistake -o\'s value for the URL when -o comes before the URL', async () => {
    const r = await runCurl(['-o', 'out.png', `http://dl-test.invalid:${port}/logo.png`]);

    expect(r.code).toBe(0);
    expect(r.download!.name).toBe('out.png');
  });
});

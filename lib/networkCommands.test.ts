import { describe, it, expect } from 'vitest';
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

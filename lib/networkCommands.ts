// Real network commands for api/exec.ts — curl, dig/nslookup, ping.
// Implemented natively in JS rather than shelled out to a system binary:
// Vercel's Node runtime doesn't guarantee curl/dig/ping are actually
// installed (this project already hit that exact class of problem with
// other commands), and a native implementation is also what makes the
// SSRF guard (lib/networkGuard.ts) enforceable in the first place — a
// real curl binary wouldn't run through it at all.
//
// Gated to signed-in accounts only by the caller (api/exec.ts) — nothing
// in here checks auth itself.

import { lookup } from 'node:dns/promises';
import { createConnection } from 'node:net';
import { assertPublicHost } from './networkGuard.js';

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 100_000;
const MAX_REDIRECTS = 5;

/** Like fetch(), but validates every hop's host against the SSRF guard before connecting to it — redirect: 'follow' would connect first and only let us inspect the result after the fact, which is too late. */
async function guardedFetch(initialUrl: URL, method: string): Promise<Response> {
  let current = initialUrl;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertPublicHost(current.hostname);
    const res = await fetch(current.toString(), {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'Kernos-Terminal/1.0' },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res;
      const next = new URL(location, current);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new Error(`redirected to disallowed protocol "${next.protocol}"`);
      }
      current = next;
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
}

export async function runCurl(args: string[]): Promise<CommandResult> {
  const urlArg = args.find(a => !a.startsWith('-'));
  if (!urlArg) return { stdout: '', stderr: 'curl: no URL provided\n', code: 1 };

  let parsed: URL;
  try {
    parsed = new URL(urlArg);
  } catch {
    return { stdout: '', stderr: `curl: invalid URL "${urlArg}"\n`, code: 1 };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { stdout: '', stderr: `curl: protocol "${parsed.protocol}" is not allowed — only http/https\n`, code: 1 };
  }

  const headOnly = args.includes('-I') || args.includes('--head');
  const includeHeaders = headOnly || args.includes('-i') || args.includes('--include');

  try {
    const res = await guardedFetch(parsed, headOnly ? 'HEAD' : 'GET');
    let stdout = '';
    if (includeHeaders) {
      stdout += `HTTP ${res.status} ${res.statusText}\n`;
      res.headers.forEach((v, k) => { stdout += `${k}: ${v}\n`; });
      stdout += '\n';
    }
    if (!headOnly) {
      const text = await res.text();
      stdout += text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) + '\n...[truncated]\n' : text;
    }
    return { stdout, stderr: '', code: 0 };
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { stdout: '', stderr: `curl: request timed out after ${FETCH_TIMEOUT_MS / 1000}s\n`, code: 28 };
    }
    return { stdout: '', stderr: `curl: ${err?.message || err}\n`, code: 1 };
  }
}

export async function runDig(args: string[]): Promise<CommandResult> {
  const hostname = args.find(a => !a.startsWith('-'));
  if (!hostname) return { stdout: '', stderr: 'dig: no hostname provided\n', code: 1 };
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    const lines = records.map(r => `${hostname}.\t\tIN\t${r.family === 6 ? 'AAAA' : 'A'}\t${r.address}`);
    return { stdout: lines.join('\n') + '\n', stderr: '', code: 0 };
  } catch (err: any) {
    return { stdout: '', stderr: `dig: could not resolve "${hostname}": ${err?.message || err}\n`, code: 1 };
  }
}

const PING_TIMEOUT_MS = 5000;
const PING_PORT = 443; // TCP-connect check, not real ICMP — see the message in the result itself

export async function runPing(args: string[]): Promise<CommandResult> {
  const hostname = args.find(a => !a.startsWith('-'));
  if (!hostname) return { stdout: '', stderr: 'ping: no hostname provided\n', code: 1 };

  try {
    await assertPublicHost(hostname);
  } catch (err: any) {
    return { stdout: '', stderr: `ping: ${err.message}\n`, code: 1 };
  }

  return new Promise<CommandResult>((resolve) => {
    const start = Date.now();
    const socket = createConnection({ host: hostname, port: PING_PORT, timeout: PING_TIMEOUT_MS });
    socket.on('connect', () => {
      const ms = Date.now() - start;
      socket.destroy();
      resolve({
        stdout: `${hostname} is reachable on port ${PING_PORT} — connected in ${ms}ms\n` +
                `(TCP reachability check, not real ICMP — raw sockets aren't available in this sandbox)\n`,
        stderr: '',
        code: 0,
      });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ stdout: '', stderr: `ping: ${hostname} timed out after ${PING_TIMEOUT_MS}ms\n`, code: 1 });
    });
    socket.on('error', (err) => {
      resolve({ stdout: '', stderr: `ping: ${err.message}\n`, code: 1 });
    });
  });
}

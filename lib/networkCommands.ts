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
import { request as httpRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolvePinnedAddress, ValidatedAddress } from './networkGuard.js';

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 100_000;
const MAX_REDIRECTS = 5;

/** Just enough of the Fetch API's Response shape for runCurl below — real headers/status/body, backed by a pinned Node http(s) request instead of fetch(). */
interface PinnedResponse {
  status: number;
  statusText: string;
  headers: Headers;
  text(): Promise<string>;
}

function toWebHeaders(nodeHeaders: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
  }
  return headers;
}

/**
 * Issues one HTTP(S) request pinned to `pinned.address` — the request's
 * `lookup` option always hands that exact address back, regardless of
 * what hostname Node's connection logic asks it to resolve, so the
 * independent second DNS lookup a plain fetch()/http.request() would
 * otherwise perform (and a DNS-rebinding attacker could answer
 * differently from the validated address) never happens. The Host header
 * and TLS servername are still the real hostname — connecting to the
 * pinned IP doesn't mean lying to the destination server about who it is,
 * just refusing to let it (or anything on the path to it) pick where the
 * socket actually lands.
 */
function pinnedRequest(url: URL, method: string, pinned: ValidatedAddress): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requestFn({
      hostname: pinned.address,
      port: url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      lookup: (_hostname: string, _options: unknown, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
        callback(null, pinned.address, pinned.family);
      },
      // Real hostname for SNI and certificate-hostname verification — a
      // cert is issued for the domain, never for the IP we're actually
      // connecting to.
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      headers: {
        host: url.host,
        'user-agent': 'Kernos-Terminal/1.0',
      },
    } as any, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => settle(() => resolve({
        status: res.statusCode ?? 0,
        statusText: res.statusMessage ?? '',
        headers: toWebHeaders(res.headers),
        text: async () => Buffer.concat(chunks).toString('utf-8'),
      })));
      res.on('error', (err) => settle(() => reject(err)));
    });

    const timer = setTimeout(() => {
      const err = new Error(`request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
      err.name = 'TimeoutError'; // matches what runCurl's catch already checks for
      settle(() => reject(err));
      req.destroy();
    }, FETCH_TIMEOUT_MS);

    req.on('error', (err) => { clearTimeout(timer); settle(() => reject(err)); });
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

/** Like fetch(), but resolves and validates each hop's host itself, then pins the connection to that exact address — redirect: 'follow' would connect first and only let us inspect the result after the fact, which is too late, and a plain fetch() to a validated hostname re-resolves independently at connect time regardless. */
async function guardedFetch(initialUrl: URL, method: string): Promise<PinnedResponse> {
  let current = initialUrl;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const pinned = await resolvePinnedAddress(current.hostname);
    const res = await pinnedRequest(current, method, pinned);
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

/**
 * Usage lines, in one place so an error and `help` can't drift apart.
 * A bare "no URL provided" tells someone their command failed but not what
 * to type instead — which is the only thing they actually needed.
 */
export const NETWORK_USAGE: Record<string, string> = {
  curl: 'Usage: curl <url>          e.g. curl https://example.com',
  dig: 'Usage: dig <hostname>      e.g. dig example.com',
  ping: 'Usage: ping <hostname>     e.g. ping example.com',
};

/** Appends the usage line so every failure is actionable, not just descriptive. */
function fail(command: keyof typeof NETWORK_USAGE | string, message: string, code = 1): CommandResult {
  const usage = NETWORK_USAGE[command];
  return {
    stdout: '',
    stderr: `${command}: ${message}\n${usage ? usage + '\n' : ''}`,
    code,
  };
}

export async function runCurl(args: string[]): Promise<CommandResult> {
  const urlArg = args.find(a => !a.startsWith('-'));
  if (!urlArg) return fail('curl', 'no URL provided');

  let parsed: URL;
  try {
    parsed = new URL(urlArg);
  } catch {
    return fail('curl', `invalid URL "${urlArg}" — include the scheme, like https://`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail('curl', `protocol "${parsed.protocol}" is not allowed — only http and https`);
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
  if (!hostname) return fail('dig', 'no hostname provided');
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
  if (!hostname) return fail('ping', 'no hostname provided');

  let pinned: ValidatedAddress;
  try {
    pinned = await resolvePinnedAddress(hostname);
  } catch (err: any) {
    return { stdout: '', stderr: `ping: ${err.message}\n`, code: 1 };
  }

  return new Promise<CommandResult>((resolve) => {
    const start = Date.now();
    // Connects to the exact address just validated, not the hostname
    // again — passing a raw IP here means Node has nothing left to
    // resolve, so there's no second, independent lookup an attacker's
    // rebinding server could answer differently from the one
    // resolvePinnedAddress just checked.
    const socket = createConnection({ host: pinned.address, port: PING_PORT, timeout: PING_TIMEOUT_MS });
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

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
  /** Set by curl -O/-o and wget instead of putting the body in stdout — the terminal has no server-side VFS to write into, so this rides back to the client (see services/kernel.ts's handleExec), which does the actual vfs.create/vfs.write with the cwd/userId it already has. */
  download?: { name: string; contentBase64: string; encoding: 'base64' };
}

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 100_000;
// Separate, much larger cap for curl -O/-o/wget's saved-to-file path — the
// existing MAX_BODY_BYTES is sized for text printed at a prompt, not a real
// asset. 2MB stays safely inside a serverless function's memory/duration
// budget and a guest's realistic localStorage quota once base64-inflated
// (~33%) — a deliberate v1 boundary, not a technical ceiling.
const MAX_DOWNLOAD_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;

/** Just enough of the Fetch API's Response shape for runCurl below — real headers/status/body, backed by a pinned Node http(s) request instead of fetch(). */
interface PinnedResponse {
  status: number;
  statusText: string;
  headers: Headers;
  text(): Promise<string>;
  /** Raw bytes, undecoded — text() runs the body through UTF-8, which would corrupt binary content (an image, say). Downloads need this instead. */
  buffer(): Promise<Buffer>;
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
function pinnedRequest(url: URL, method: string, pinned: ValidatedAddress, maxBytes?: number): Promise<PinnedResponse> {
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
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        // Checked as bytes arrive, not after the fact — a caller with a
        // maxBytes cap (curl -O/-o, wget) would otherwise still pay to
        // buffer an unbounded response in full before a post-hoc slice
        // ever ran, defeating the point of the cap for a slow, huge, or
        // malicious response.
        if (maxBytes !== undefined && received > maxBytes) {
          settle(() => reject(new Error(`response exceeded the ${(maxBytes / 1_000_000).toFixed(1)}MB download limit`)));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => settle(() => resolve({
        status: res.statusCode ?? 0,
        statusText: res.statusMessage ?? '',
        headers: toWebHeaders(res.headers),
        text: async () => Buffer.concat(chunks).toString('utf-8'),
        buffer: async () => Buffer.concat(chunks),
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
async function guardedFetch(initialUrl: URL, method: string, maxBytes?: number): Promise<PinnedResponse> {
  let current = initialUrl;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const pinned = await resolvePinnedAddress(current.hostname);
    const res = await pinnedRequest(current, method, pinned, maxBytes);
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
  curl: 'Usage: curl <url> [-O | -o <path>]   e.g. curl -O https://example.com/logo.png',
  dig: 'Usage: dig <hostname>      e.g. dig example.com',
  ping: 'Usage: ping <hostname>     e.g. ping example.com',
  wget: 'Usage: wget <url> [-O <path>]        e.g. wget https://example.com/logo.png',
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

/**
 * Fetches `parsed` in full and hands back its bytes as a CommandResult.download
 * for the client to actually write into the VFS — see the CommandResult.download
 * doc comment for why this can't just write the file itself. Shared by curl
 * -O/-o and wget, which only differ in how `name` gets picked and which
 * command name appears in error text.
 *
 * A non-2xx response is refused rather than saved: real curl -O saves the
 * error page by default under the requested name, which is fine for a
 * throwaway shell but not for silently dropping an HTML 404 page into a
 * user's own persistent workspace under a name they expected to be real
 * content.
 */
async function fetchForDownload(command: 'curl' | 'wget', parsed: URL, name: string): Promise<CommandResult> {
  try {
    const res = await guardedFetch(parsed, 'GET', MAX_DOWNLOAD_BYTES);
    if (res.status < 200 || res.status >= 300) {
      return { stdout: '', stderr: `${command}: server responded ${res.status} ${res.statusText || ''} — nothing saved\n`, code: 22 };
    }
    const bytes = await res.buffer();
    const kb = (bytes.length / 1024).toFixed(1);
    return {
      // Not "Saved" — the bytes are on their way to the client for the
      // actual VFS write (see CommandResult.download's doc comment), which
      // can still fail (a name collision with a directory, say). The
      // client's own write confirms or reports that outcome separately.
      stdout: `Downloaded ${kb} KB — writing "${name}" to your files...\n`,
      stderr: '',
      code: 0,
      download: { name, contentBase64: bytes.toString('base64'), encoding: 'base64' },
    };
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { stdout: '', stderr: `${command}: request timed out after ${FETCH_TIMEOUT_MS / 1000}s\n`, code: 28 };
    }
    return { stdout: '', stderr: `${command}: ${err?.message || err}\n`, code: 1 };
  }
}

/** The basename curl -O / bare wget saves as when no explicit path is given — the URL's own last path segment, matching real curl's -O naming. */
function remoteBasename(parsed: URL): string | undefined {
  return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '') || undefined;
}

export async function runCurl(args: string[]): Promise<CommandResult> {
  const oIndex = args.findIndex(a => a === '-o' || a === '--output');
  const outputPath = oIndex !== -1 ? args[oIndex + 1] : undefined;
  if (oIndex !== -1 && !outputPath) return fail('curl', '-o requires a path argument');

  // args[oIndex + 1] is -o's own value, not a second positional — excluded
  // here so it can't be mistaken for the URL (`curl -o logo.png <url>`
  // would otherwise resolve "logo.png" as the URL instead). Gated on
  // oIndex !== -1: when there's no -o at all, oIndex is -1 and oIndex + 1
  // is 0 — without this gate that would wrongly exclude index 0, exactly
  // where a bare `curl <url>` puts its only argument.
  const urlArg = args.find((a, i) => !a.startsWith('-') && !(oIndex !== -1 && i === oIndex + 1));
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

  const saveAsRemoteName = args.includes('-O') || args.includes('--remote-name');
  if (outputPath || saveAsRemoteName) {
    const name = outputPath || remoteBasename(parsed);
    if (!name) {
      return fail('curl', `remote file name has no length — "${urlArg}" has no path segment to name it after; use -o <path> instead`);
    }
    return fetchForDownload('curl', parsed, name);
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

/**
 * wget <url> [-O <path>] — a thin alias over curl's download path. Bare
 * `wget <url>` behaves like `curl -O <url>` (name from the URL); `wget -O
 * <path> <url>` behaves like `curl -o <path> <url>` — matches real wget's
 * own `-O` meaning "save as this exact path", the opposite of curl's `-O`.
 */
export async function runWget(args: string[]): Promise<CommandResult> {
  const oIndex = args.findIndex(a => a === '-O' || a === '--output-document');
  const outputPath = oIndex !== -1 ? args[oIndex + 1] : undefined;
  if (oIndex !== -1 && !outputPath) return fail('wget', '-O requires a path argument');

  const urlArg = args.find((a, i) => !a.startsWith('-') && !(oIndex !== -1 && i === oIndex + 1));
  if (!urlArg) return fail('wget', 'no URL provided');

  let parsed: URL;
  try {
    parsed = new URL(urlArg);
  } catch {
    return fail('wget', `invalid URL "${urlArg}" — include the scheme, like https://`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail('wget', `protocol "${parsed.protocol}" is not allowed — only http and https`);
  }

  const name = outputPath || remoteBasename(parsed);
  if (!name) {
    return fail('wget', `remote file name has no length — "${urlArg}" has no path segment to name it after; use -O <path> instead`);
  }
  return fetchForDownload('wget', parsed, name);
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

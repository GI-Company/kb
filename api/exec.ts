// Ephemeral sandboxed command execution — ports the allowlist/sanitization/
// jail logic from server/main.go's ExecuteSafeCommand, adapted for a
// stateless Vercel Node function instead of a persistent host process.
//
// Differences from the original Go version, and why:
//  - No shared filesystem across calls. Every invocation gets its own fresh
//    temp jail dir under os.tmpdir() and nothing persists after it returns —
//    there's no "workspace" to build up between commands like there was on
//    the always-on Go backend.
//  - The coreutils allowlist is deliberately smaller than the Go version's.
//    Vercel's Node function runtime is a minimal Linux image — things like
//    git/python3/go/rust/ffmpeg/sqlite3 are NOT guaranteed to be installed,
//    unlike a real host. Rather than guess, a missing command is detected
//    directly from the real exec attempt's ENOENT spawn error (Node's
//    signal that the executable itself couldn't be found), not a separate
//    `which` pre-check — `which` itself isn't guaranteed to be on this
//    runtime's PATH either, and a pre-check that silently fails open/closed
//    on its own missing dependency is worse than just trying the real thing.
//  - 10s hard timeout (see vercel.json's functions.api/exec.ts.maxDuration),
//    down from the Go version's 30s.
//  - Real network commands (curl, dig/nslookup, ping — see
//    lib/networkCommands.ts) are implemented natively rather than shelled
//    out, gated to signed-in accounts only (lib/verifyAuth.ts), and SSRF-
//    guarded against private/internal address ranges (lib/networkGuard.ts).
//    An anonymous, IP-quota-only terminal that can make arbitrary outbound
//    requests is a ready-made abuse vector — guests keep the coreutils-only
//    sandbox below with no network access at all.
//
// Request:  POST { cmd: string, args: string[] }
// Response: { stdout: string, stderr: string, code: number }

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRateLimit, getClientIp, rateLimitResponseHeaders } from '../lib/rateLimit.js';
import { verifyAccessToken, extractBearerToken } from '../lib/verifyAuth.js';
import { runCurl, runDig, runPing, NETWORK_USAGE } from '../lib/networkCommands.js';

// Every entry here was probed against the deployed function and answered.
// The list used to carry 39 names, 12 of which could never run:
//
//   find diff hostname which ps file tar gzip jq
//     — simply not in the Lambda base image. `help` advertised them and
//       they returned 127, which reads to a user as their mistake.
//
//   node npm npx
//     — removed rather than fixed. They were failing only because the
//       stripped PATH below omits Vercel's Node directory, so a one-line
//       change would have made them work. That is the argument against
//       them: `node` is arbitrary server-side code execution, and it buys
//       nothing here, because the jail is destroyed after every command —
//       there is no script to run and nothing to install into on a 9s
//       budget. Running code belongs in the browser (Python on a worker,
//       kernos.exec), where it cannot reach the server at all.
//
// Do NOT add a command back without checking it actually exists in the
// runtime. An allowlist that lies is worse than a short one.
export const ALLOWED_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'echo', 'grep', 'sed', 'awk', 'cut', 'tr',
  'wc', 'sort', 'uniq', 'date', 'whoami', 'uname', 'pwd',
  'id', 'env', 'printenv', 'df', 'du',
  'mkdir', 'touch', 'cp', 'mv', 'stat',
]);

// Real network access — see the file-header comment above. Handled before
// the coreutils allowlist/sandbox path entirely, not shelled out.
const NETWORK_COMMANDS = new Set(['curl', 'dig', 'nslookup', 'ping']);

const DANGEROUS_CHARS = /[&|;`$()<>]/;
const EXEC_TIMEOUT_MS = 9000; // stay under the 10s function budget
const MAX_OUTPUT_BYTES = 1024 * 1024;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_EXEC_PER_MIN) || 30;

interface ExecRequestBody {
  cmd?: string;
  args?: string[];
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const rl = await checkRateLimit(`exec:${getClientIp(req)}`, RATE_LIMIT_PER_MIN);
  res.setHeader?.('x-ratelimit-limit', String(rl.limit));
  res.setHeader?.('x-ratelimit-remaining', String(rl.remaining));
  if (!rl.allowed) {
    res.status(429).json({ stdout: '', stderr: `Rate limit exceeded (${RATE_LIMIT_PER_MIN}/min). Try again shortly.\n`, code: 429 });
    return;
  }

  const body: ExecRequestBody = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const cmd = body.cmd;
  const args = Array.isArray(body.args) ? body.args : [];

  if (!cmd || typeof cmd !== 'string') {
    res.status(400).json({ error: 'Missing "cmd"' });
    return;
  }

  if (cmd === 'help') {
    res.status(200).json({
      stdout:
        `Filesystem (persistent, runs in your browser against your files):\n` +
        `  ls, cat, cd, pwd, mkdir, touch, write, rm, mv, cp\n\n` +
        `Python (real CPython in your browser, signed-in accounts only):\n` +
        `  python -c "<code>"  |  python <file.py>  |  pip list\n` +
        `  Full standard library; package installs are not enabled (see pip list).\n` +
        `  Files in the current directory are readable with open().\n` +
        `  First run downloads the ~13 MB runtime; Ctrl+C kills it outright.\n\n` +
        `Text processing (runs in your browser, on your real files):\n` +
        `  grep wc head tail sort uniq sed cut tr\n` +
        `  pick <path>            field out of a JSON record   (pick .label)\n` +
        `  where <path> <op> <v>  filter records by a field     (where .confidence > 0.9)\n` +
        `  pick/where read the field, not the line — grep matches either.\n` +
        `  Use them on a file directly (wc -l notes.md) or in a pipe.\n` +
        `  These are deliberate subsets — an unsupported flag is refused, not ignored.\n` +
        `  sed does s/pattern/replacement/[g] only. grep matches substrings, not regexes.\n` +
        `  awk is NOT in this set: it only runs server-side, where your files do not exist.\n\n` +
        `Local intelligence (your trained model and the message bus, no network):\n` +
        `  classify <text>        label it, with the runner-up and the margin\n` +
        `  explain                why the classifier said that, word by word\n` +
        `  trace [--last <n>]     what the machine just did\n` +
        `  All three take --json for NDJSON records, and compose in pipes.\n\n` +
        `  correct <label>        the last classify was wrong; teach it the right one\n` +
        `  train --from-corrections <name>   retrain a saved classifier on its corrections\n` +
        `  correct/train are not pipeline stages — they mutate a saved model, not a stream.\n\n` +
        `Composition (piped and redirected in your browser, never sent to the server):\n` +
        `  cmd | cmd   cmd > file   cmd >> file      (no &&, ||, ; or globbing)\n\n` +
        `Sandboxed commands (fresh temp dir per run, nothing persists):\n` +
        `  ${[...ALLOWED_COMMANDS].sort().join(', ')}\n\n` +
        `Network commands (signed-in accounts only):\n` +
        // Same strings the failure messages use, so help and errors can't
        // describe the command differently.
        [...NETWORK_COMMANDS].sort().map(c => `  ${NETWORK_USAGE[c] || c}`).join('\n') + '\n' +
        `  Usage: render <url> [--screenshot]   e.g. render https://example.com --screenshot\n`,
      stderr: '',
      code: 0,
    });
    return;
  }

  if (NETWORK_COMMANDS.has(cmd)) {
    const user = await verifyAccessToken(extractBearerToken(req));
    if (!user) {
      res.status(200).json({
        stdout: '',
        stderr: `PERMISSION DENIED: '${cmd}' requires a signed-in account — guests get the sandboxed coreutils only. Sign in from the login screen for network access.\n`,
        code: 126,
      });
      return;
    }
    const result = cmd === 'curl' ? await runCurl(args)
      : cmd === 'ping' ? await runPing(args)
      : await runDig(args); // dig, nslookup
    res.status(200).json(result);
    return;
  }

  if (!ALLOWED_COMMANDS.has(cmd)) {
    res.status(200).json({
      stdout: '',
      stderr: `PERMISSION DENIED: Command '${cmd}' is not in the kernel allowlist.\n`,
      code: 126,
    });
    return;
  }

  const safeArgs: string[] = [];
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    if (DANGEROUS_CHARS.test(arg)) {
      res.status(200).json({ stdout: '', stderr: `PERMISSION DENIED: Argument '${arg}' contains illegal characters.\n`, code: 126 });
      return;
    }
    if (arg.includes('..')) {
      res.status(200).json({ stdout: '', stderr: `PERMISSION DENIED: Path traversal (..) is not allowed.\n`, code: 126 });
      return;
    }
    if (arg.startsWith('/') || arg.startsWith('\\')) {
      res.status(200).json({ stdout: '', stderr: `PERMISSION DENIED: Absolute paths are not allowed.\n`, code: 126 });
      return;
    }
    safeArgs.push(arg);
  }

  let jailDir: string;
  try {
    jailDir = mkdtempSync(join(tmpdir(), 'kernos_jail_'));
  } catch (err: any) {
    res.status(200).json({ stdout: '', stderr: `JAIL ERROR: Could not create execution sandbox: ${err?.message}\n`, code: 1 });
    return;
  }

  try {
    const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      execFile(
        cmd,
        safeArgs,
        {
          cwd: jailDir,
          timeout: EXEC_TIMEOUT_MS,
          env: {
            PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
            HOME: jailDir,
            TMPDIR: jailDir,
            LANG: 'en_US.UTF-8',
          },
          maxBuffer: MAX_OUTPUT_BYTES,
        },
        (error, stdout, stderr) => {
          // ENOENT here means Node couldn't find/spawn the executable at
          // all (distinct from the command running and exiting non-zero,
          // where .code is a number) — that's our "not actually installed"
          // signal, checked at the only place that can know for sure.
          if (error && (error as any).code === 'ENOENT') {
            resolve({ stdout: '', stderr: `'${cmd}' is allowlisted but not installed in this serverless environment.\n`, code: 127 });
          } else if (error && (error as any).killed) {
            resolve({ stdout, stderr: stderr + '\nTIMEOUT: Process exceeded execution limit and was killed.\n', code: 1 });
          } else if (error) {
            resolve({ stdout, stderr: stderr || error.message, code: (error as any).code ?? 1 });
          } else {
            resolve({ stdout, stderr, code: 0 });
          }
        }
      );
    });
    res.status(200).json(result);
  } finally {
    try { rmSync(jailDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

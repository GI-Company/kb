// Ephemeral sandboxed command execution — ports the allowlist/sanitization/
// jail logic from server/main.go's ExecuteSafeCommand, adapted for a
// stateless Vercel Node function instead of a persistent host process.
//
// Differences from the original Go version, and why:
//  - No shared filesystem across calls. Every invocation gets its own fresh
//    temp jail dir under os.tmpdir() and nothing persists after it returns —
//    there's no "workspace" to build up between commands like there was on
//    the always-on Go backend.
//  - The allowlist is deliberately smaller than the Go version's. Vercel's
//    Node function runtime is a minimal Linux image — things like git,
//    python3, go, rust, ffmpeg, sqlite3, ping/dig/nslookup are NOT
//    guaranteed to be installed, unlike a real host. Rather than guess,
//    a missing command is detected directly from the real exec attempt's
//    ENOENT spawn error (Node's signal that the executable itself couldn't
//    be found), not a separate `which` pre-check — `which` itself isn't
//    guaranteed to be on this runtime's PATH either, and a pre-check that
//    silently fails open/closed on its own missing dependency is worse
//    than just trying the real thing and handling that specific failure.
//  - 10s hard timeout (see vercel.json's functions.api/exec.ts.maxDuration),
//    down from the Go version's 30s.
//
// Request:  POST { cmd: string, args: string[] }
// Response: { stdout: string, stderr: string, code: number }

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Conservative — commands near-certain to exist in a Linux-based Node
// serverless runtime. No git/python/go/rust/ffmpeg/sqlite3/network-probing
// tools; those aren't part of a stock Node function image.
const ALLOWED_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'echo', 'grep', 'sed', 'awk', 'cut', 'tr',
  'find', 'wc', 'sort', 'uniq', 'diff', 'date', 'whoami', 'uname', 'pwd',
  'hostname', 'id', 'env', 'printenv', 'which', 'df', 'du', 'ps',
  'mkdir', 'touch', 'cp', 'mv', 'stat', 'file', 'node', 'npm', 'npx',
  'curl', 'tar', 'gzip', 'jq',
]);

const DANGEROUS_CHARS = /[&|;`$()<>]/;
const EXEC_TIMEOUT_MS = 9000; // stay under the 10s function budget
const MAX_OUTPUT_BYTES = 1024 * 1024;

interface ExecRequestBody {
  cmd?: string;
  args?: string[];
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
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
      stdout: `Available commands: ${[...ALLOWED_COMMANDS].sort().join(', ')}\n`,
      stderr: '',
      code: 0,
    });
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

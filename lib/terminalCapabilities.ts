// What each command needs, in one place — BUILTINS.md's Decision 2.
//
// Before this, the answer to "what does `python` require?" was scattered
// across four client-side Sets (VFS_COMMANDS, PIPE_AWARE_COMMANDS,
// PYTHON_COMMANDS, TRAINING_COMMANDS) and two more inside api/exec.ts
// (ALLOWED_COMMANDS, NETWORK_COMMANDS) — answerable only by reading code.
// `can` and `policy` need it as one table, so here it is.
//
// Built from the real Sets wherever a command's file is safe to import
// client-side, rather than re-typed by hand — the whole point is that this
// table can't say something the actual gate doesn't. The two exceptions
// are api/exec.ts's ALLOWED_COMMANDS and NETWORK_COMMANDS: importing that
// file here would pull `node:child_process` into the browser bundle, since
// Vite/Rollup don't reliably tree-shake away an unused import's own
// dependency graph. Those two are copied as literals instead, and
// lib/terminalCapabilities.test.ts asserts the copies match the real sets
// — a test can safely import api/exec.ts because test files never enter
// the client bundle.

import { VFS_COMMANDS } from './terminalFs';
import { TEXT_FILTERS } from './terminalPipeline';
import { PYTHON_COMMANDS } from './pythonRuntime';
import { INTEL_COMMANDS, TRAINING_COMMANDS } from './terminalIntel';

export type Capability = 'vfs' | 'vfs:write' | 'model:local' | 'model:cloud' | 'python' | 'net' | 'exec';

export interface CapabilityInfo {
  /** One line: what the capability lets a command do. */
  description: string;
  gatedBy: 'none' | 'signed-in' | 'rate-limit';
}

export const CAPABILITY_INFO: Record<Capability, CapabilityInfo> = {
  vfs: { description: 'reads your persistent files', gatedBy: 'none' },
  'vfs:write': { description: 'writes or deletes your persistent files', gatedBy: 'none' },
  'model:local': { description: 'runs your trained classifier in this tab', gatedBy: 'none' },
  'model:cloud': { description: 'calls Groq via /api/chat', gatedBy: 'rate-limit' },
  python: { description: 'boots Pyodide (~13 MB on first use)', gatedBy: 'signed-in' },
  net: { description: 'leaves the origin (SSRF-guarded)', gatedBy: 'signed-in' },
  exec: { description: "runs in the server's disposable per-request jail — never touches your real files", gatedBy: 'rate-limit' },
};

/**
 * Copied from api/exec.ts's ALLOWED_COMMANDS — see the file header for why
 * this can't just be imported. Checked against the original by
 * lib/terminalCapabilities.test.ts.
 */
const SANDBOXED_EXEC_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'echo', 'grep', 'sed', 'awk', 'cut', 'tr',
  'wc', 'sort', 'uniq', 'date', 'whoami', 'uname', 'pwd',
  'id', 'env', 'printenv', 'df', 'du',
  'mkdir', 'touch', 'cp', 'mv', 'stat',
]);

/** Copied from api/exec.ts's NETWORK_COMMANDS — same caveat as above. */
const NETWORK_EXEC_COMMANDS = new Set(['curl', 'dig', 'nslookup', 'ping']);

const VFS_WRITE_COMMANDS = new Set(['mkdir', 'touch', 'rm', 'mv', 'cp', 'write']);

/**
 * Every command this shell knows, mapped to what it needs. A command can
 * appear here with capabilities from more than one source — `ls` is both a
 * VFS_COMMANDS entry (real, persistent, browser-side) AND listed in
 * api/exec.ts's allowlist (a same-named but different command that runs
 * sandboxed): VFS_COMMANDS always wins client-side, so that's the entry
 * that matters and is the one shown.
 */
export const COMMAND_CAPABILITIES: Record<string, Capability[]> = {};

for (const cmd of VFS_COMMANDS) {
  COMMAND_CAPABILITIES[cmd] = VFS_WRITE_COMMANDS.has(cmd) ? ['vfs', 'vfs:write'] : ['vfs'];
}
for (const cmd of Object.keys(TEXT_FILTERS)) {
  // echo is deliberately skipped here, not mapped to []. TEXT_FILTERS.echo
  // only runs as a PIPELINE STAGE (`cmd | echo`) — Terminal.tsx's
  // standalone-file dispatch explicitly excludes echo from the client-side
  // path, so a bare `echo hi` at the prompt goes to the server's `echo`
  // instead, in SANDBOXED_EXEC_COMMANDS below. Tagging it [] here described
  // the pipeline form and silently lied about the one most people type.
  if (cmd === 'echo') continue;
  COMMAND_CAPABILITIES[cmd] = ['vfs'];
}
for (const cmd of PYTHON_COMMANDS) {
  COMMAND_CAPABILITIES[cmd] = ['python', 'vfs'];
}
for (const cmd of INTEL_COMMANDS) {
  // classify's -f flag reads a file; trace and bare classify/explain don't
  // touch the VFS at all. Coarse (command-level, not per-flag) on purpose —
  // matching BUILTINS.md's table, which doesn't have per-argument capabilities.
  COMMAND_CAPABILITIES[cmd] = cmd === 'trace' ? ['model:local'] : ['model:local', 'vfs'];
}
for (const cmd of TRAINING_COMMANDS) {
  COMMAND_CAPABILITIES[cmd] = cmd === 'correct' ? ['model:local', 'vfs:write'] : ['model:local', 'vfs'];
}
for (const cmd of NETWORK_EXEC_COMMANDS) {
  COMMAND_CAPABILITIES[cmd] = ['net'];
}
COMMAND_CAPABILITIES['render'] = ['net'];
for (const cmd of SANDBOXED_EXEC_COMMANDS) {
  // Only if nothing more specific already claimed the name (see the
  // ls-is-two-things note above).
  if (!COMMAND_CAPABILITIES[cmd]) COMMAND_CAPABILITIES[cmd] = ['exec'];
}

// `clear` and `help` are real commands — both appear in the terminal's
// tab-completion list and neither hits the "not a command" branch of
// `can` — but neither is in any of the Sets above, since both are pure
// client-side UI/text with nothing to declare. Without these, `can clear`
// would have wrongly reported "not a command this shell knows about."
COMMAND_CAPABILITIES['clear'] = [];
COMMAND_CAPABILITIES['help'] = [];

/**
 * The `?` prefix isn't a command token, so it has no COMMAND_CAPABILITIES
 * entry `can` could look up — but `policy` still needs to say what it
 * costs. Kept here so that one fact lives in one place too.
 */
export const NL_TRANSLATOR_CAPABILITY: Capability = 'model:cloud';

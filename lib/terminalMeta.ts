// can / policy — the honest version of "root": this shell has no privilege
// levels, only a declared surface (see BUILTINS.md's Decision 2 and
// lib/terminalCapabilities.ts, which is the actual table these format).

import { getSession } from './auth';
import { CommandResult } from './terminalFs';
import { CAPABILITY_INFO, COMMAND_CAPABILITIES, NL_TRANSLATOR_CAPABILITY, Capability } from './terminalCapabilities';

export const META_COMMANDS = new Set(['can', 'policy']);

export const META_USAGE: Record<string, string> = {
  can: 'Usage: can <command>',
  policy: 'Usage: policy',
};

const ok = (stdout: string): CommandResult => ({ stdout, stderr: '', code: 0 });
const bad = (cmd: string, msg: string, code = 1): CommandResult => ({ stdout: '', stderr: `${cmd}: ${msg}\n`, code });

/** True once, not re-derived per capability — one session question, asked once. */
async function isSignedIn(): Promise<boolean> {
  return (await getSession()) !== null;
}

function availability(cap: Capability, signedIn: boolean): { available: boolean; note: string } {
  const info = CAPABILITY_INFO[cap];
  if (info.gatedBy === 'none') return { available: true, note: 'available now' };
  if (info.gatedBy === 'signed-in') {
    return signedIn
      ? { available: true, note: 'available now (signed in)' }
      : { available: false, note: 'sign in from Settings to unlock this' };
  }
  // rate-limit: never blocked outright, so "available" — the honest caveat
  // goes in the note rather than a false "not available".
  return { available: true, note: 'available now, subject to a shared rate limit' };
}

async function runCan(args: string[]): Promise<CommandResult> {
  const command = args.find(a => !a.startsWith('-'));
  if (!command) return bad('can', `missing command\n${META_USAGE.can}`, 2);

  const caps = COMMAND_CAPABILITIES[command];
  if (!caps) {
    return bad('can', `"${command}" is not a command this shell knows about.\nType "help" to see what it can do.`);
  }
  if (caps.length === 0) {
    return ok(`${command}: no declared capability — it doesn't touch your files, a model, or the network.\n`);
  }

  const signedIn = await isSignedIn();
  const lines = caps.map(cap => {
    const { note } = availability(cap, signedIn);
    return `  ${cap.padEnd(11)} — ${CAPABILITY_INFO[cap].description}. ${note}.`;
  });
  return ok(`${command}: ${caps.join(', ')}\n${lines.join('\n')}\n`);
}

async function runPolicy(): Promise<CommandResult> {
  const signedIn = await isSignedIn();
  const allCaps = Object.keys(CAPABILITY_INFO) as Capability[];
  const unlocked = allCaps.filter(c => availability(c, signedIn).available && CAPABILITY_INFO[c].gatedBy !== 'signed-in');
  const signedInOnly = allCaps.filter(c => CAPABILITY_INFO[c].gatedBy === 'signed-in');

  const lines = [`Signed in: ${signedIn ? 'yes' : 'no (guest session)'}`, ''];

  lines.push('Available now:');
  for (const cap of unlocked) lines.push(`  ${cap.padEnd(11)} — ${CAPABILITY_INFO[cap].description}`);
  if (signedIn) {
    for (const cap of signedInOnly) lines.push(`  ${cap.padEnd(11)} — ${CAPABILITY_INFO[cap].description}`);
  }
  lines.push('');

  if (!signedIn) {
    lines.push('Requires signing in:');
    for (const cap of signedInOnly) lines.push(`  ${cap.padEnd(11)} — ${CAPABILITY_INFO[cap].description}`);
    lines.push('');
    lines.push('Sign in from Settings to unlock these.');
    lines.push(`(The \`?\` translator only needs ${NL_TRANSLATOR_CAPABILITY}, already listed above — it works for guests.)`);
  } else {
    lines.push('/api/chat and /api/exec are still rate-limited per session — signing in removes the');
    lines.push('signed-in gate, not the shared limits everyone runs under.');
  }

  return ok(lines.join('\n') + '\n');
}

export async function runMetaCommand(command: string, args: string[]): Promise<CommandResult> {
  switch (command) {
    case 'can': return runCan(args);
    case 'policy': return runPolicy();
    default: return bad(command, 'not a meta command');
  }
}

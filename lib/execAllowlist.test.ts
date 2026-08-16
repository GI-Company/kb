import { describe, it, expect } from 'vitest';
import { ALLOWED_COMMANDS } from '../api/exec';
import { getDemoPipeline } from './taskEngine';

describe('api/exec allowlist', () => {
  // Probed against the deployed function: these 12 were advertised by
  // `help` and answered 127. node/npm/npx were reachable with a one-line
  // PATH change and were dropped on purpose — see the comment on the set.
  it('lists nothing the serverless runtime cannot run', () => {
    for (const dead of ['find', 'diff', 'hostname', 'which', 'ps', 'file', 'tar', 'gzip', 'jq']) {
      expect(ALLOWED_COMMANDS.has(dead), `${dead} is not in the Lambda image`).toBe(false);
    }
  });

  it('does not expose a server-side code execution path', () => {
    for (const rce of ['node', 'npm', 'npx']) {
      expect(ALLOWED_COMMANDS.has(rce), `${rce} is arbitrary server-side execution`).toBe(false);
    }
  });

  // lib/terminalFs.ts shadows ls/cat/mkdir/touch/cp/mv for the terminal
  // only. lib/taskEngine.ts calls /api/exec directly for DAG shell nodes and
  // bypasses that entirely, so trimming them from here would break the
  // built-in pipeline — whose build step really is `ls -la`.
  it('still covers every command the built-in task pipeline runs', () => {
    for (const node of getDemoPipeline()) {
      const head = node.command.split(' ')[0];
      expect(ALLOWED_COMMANDS.has(head), `demo pipeline node "${node.id}" runs ${head}`).toBe(true);
    }
  });
});

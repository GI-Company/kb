import { describe, it, expect } from 'vitest';
import { COMMAND_CAPABILITIES, CAPABILITY_INFO } from './terminalCapabilities';
// Safe here — this is a test file, never bundled into the client. See the
// header comment in terminalCapabilities.ts for why the module under test
// keeps its own literal copies instead of importing these directly.
import { ALLOWED_COMMANDS, NETWORK_COMMANDS } from '../api/exec';

describe('terminalCapabilities stays in sync with the real gates', () => {
  it('has every real server-sandboxed command, with no extras', () => {
    for (const cmd of ALLOWED_COMMANDS) {
      // ls/cat/etc. are claimed by the client-side VFS entry instead — see
      // COMMAND_CAPABILITIES' construction comment. Anything NOT already
      // claimed must be tagged 'exec', or the table is silently missing it.
      const caps = COMMAND_CAPABILITIES[cmd];
      expect(caps, `"${cmd}" from api/exec.ts's allowlist has no entry here`).toBeDefined();
      expect(caps.includes('exec') || caps.includes('vfs'),
        `"${cmd}" is in the server allowlist but tagged ${JSON.stringify(caps)}`).toBe(true);
    }
  });

  it('has every real network command tagged net (plus vfs:write for curl/wget, which download into the VFS)', () => {
    for (const cmd of NETWORK_COMMANDS) {
      const caps = COMMAND_CAPABILITIES[cmd];
      expect(caps, `"${cmd}" from NETWORK_COMMANDS has no entry`).toBeDefined();
      expect(caps, `"${cmd}" is a network command but not tagged net`).toContain('net');
      const expectsWrite = cmd === 'curl' || cmd === 'wget';
      expect(caps.includes('vfs:write'), `"${cmd}" vfs:write tag should be ${expectsWrite}, got ${JSON.stringify(caps)}`).toBe(expectsWrite);
    }
  });

  // The inverse check: nothing here claims 'exec' that the server would
  // actually reject. A stale table that ADDS phantom commands is just as
  // dishonest as one missing real ones.
  it('does not claim exec for a command the server does not allow', () => {
    for (const [cmd, caps] of Object.entries(COMMAND_CAPABILITIES)) {
      if (caps.includes('exec')) {
        expect(ALLOWED_COMMANDS.has(cmd), `"${cmd}" is tagged exec but not in ALLOWED_COMMANDS`).toBe(true);
      }
    }
  });

  it('every capability a command declares has a description', () => {
    for (const [cmd, caps] of Object.entries(COMMAND_CAPABILITIES)) {
      for (const cap of caps) {
        expect(CAPABILITY_INFO[cap], `"${cmd}" declares unknown capability "${cap}"`).toBeDefined();
      }
    }
  });
});

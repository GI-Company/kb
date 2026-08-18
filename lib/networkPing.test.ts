import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Kept in its own file, separate from networkCommands.test.ts: that file
// spins up a real node:http server for runCurl's pinning tests, and http's
// own internals lean on node:net under the hood — mocking node:net
// file-wide there would risk breaking that real server, not just runPing's
// direct use of createConnection.
const resolvePinnedAddressMock = vi.fn();
vi.mock('./networkGuard', () => ({
  resolvePinnedAddress: (...args: any[]) => resolvePinnedAddressMock(...args),
  assertPublicHost: async (hostname: string) => { await resolvePinnedAddressMock(hostname); },
}));

const createConnectionMock = vi.fn();
vi.mock('node:net', () => ({
  createConnection: (...args: any[]) => createConnectionMock(...args),
  default: { createConnection: (...args: any[]) => createConnectionMock(...args) },
}));

import { runPing } from './networkCommands';

// Same DNS-rebinding gap as runCurl's tests in networkCommands.test.ts:
// runPing used to validate a hostname once and then hand that same
// hostname to net.createConnection, which resolves it again, independently
// — a second chance for a rebinding attacker's DNS server to answer with a
// private address. Asserting on the exact value passed to createConnection
// is what proves the fix: it has to be the pinned address, not the
// hostname, or there's nothing stopping that second resolution.
describe('runPing pins its connection to the resolved address', () => {
  beforeEach(() => {
    resolvePinnedAddressMock.mockReset();
    createConnectionMock.mockReset();
  });

  it('connects to the pinned address rather than the hostname, resolving exactly once', async () => {
    resolvePinnedAddressMock.mockResolvedValue({ address: '93.184.216.34', family: 4 });
    const fakeSocket = new EventEmitter() as any;
    fakeSocket.destroy = vi.fn();
    createConnectionMock.mockImplementation(() => {
      queueMicrotask(() => fakeSocket.emit('connect'));
      return fakeSocket;
    });

    const r = await runPing(['pin-test.invalid']);

    expect(resolvePinnedAddressMock).toHaveBeenCalledTimes(1);
    expect(resolvePinnedAddressMock).toHaveBeenCalledWith('pin-test.invalid');
    expect(createConnectionMock).toHaveBeenCalledTimes(1);
    const opts = createConnectionMock.mock.calls[0][0];
    expect(opts.host).toBe('93.184.216.34'); // the pinned address, not "pin-test.invalid"
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('pin-test.invalid'); // still reports the hostname the user typed
  });

  it('reports a resolution refusal without ever touching net.createConnection', async () => {
    resolvePinnedAddressMock.mockRejectedValue(new Error('refusing to connect to "internal.invalid" — it resolves to a private/internal address (10.0.0.5)'));

    const r = await runPing(['internal.invalid']);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain('private/internal address');
    expect(createConnectionMock).not.toHaveBeenCalled();
  });
});

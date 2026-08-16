import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSession = vi.fn();
vi.mock('./auth', () => ({ getSession: (...a: any[]) => getSession(...a) }));

const { runMetaCommand } = await import('./terminalMeta');

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue(null); // guest by default
});

describe('can', () => {
  it('needs a command name', async () => {
    expect((await runMetaCommand('can', [])).code).toBe(2);
  });

  it('refuses an unknown command rather than guessing', async () => {
    const r = await runMetaCommand('can', ['frobnicate']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not a command this shell knows about/);
  });

  it('reports an ungated VFS command as available now for a guest', async () => {
    const r = await runMetaCommand('can', ['ls']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('vfs');
    expect(r.stdout).toMatch(/available now/);
  });

  it('marks a signed-in-gated command unavailable for a guest', async () => {
    const r = await runMetaCommand('can', ['python']);
    expect(r.stdout).toContain('python');
    expect(r.stdout).toMatch(/sign in from Settings/);
  });

  it('marks the same command available once signed in', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    const r = await runMetaCommand('can', ['curl']);
    expect(r.stdout).toContain('net');
    expect(r.stdout).toMatch(/available now \(signed in\)/);
  });

  // echo has nothing to declare only for its typical, standalone
  // invocation, which is what `can` should describe — not the pipeline-
  // stage form. See terminalCapabilities.ts's construction comment.
  it('reports the standalone form of echo as sandboxed exec, not a no-op', async () => {
    const r = await runMetaCommand('can', ['echo']);
    expect(r.stdout).toContain('exec');
  });

  // clear/help are real commands but pure client-side UI/text — nothing
  // to declare. Without an explicit [] entry these fell into "not a
  // command this shell knows about," which was worse than admitting they
  // need nothing.
  it('names a command that has no declared capability at all', async () => {
    const r = await runMetaCommand('can', ['clear']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no declared capability/);
    expect(r.stdout).not.toMatch(/reads its own arguments/); // that description was echo's, not clear's
  });

  it('shows every capability a multi-capability command needs', async () => {
    const r = await runMetaCommand('can', ['classify']);
    expect(r.stdout).toContain('model:local');
    expect(r.stdout).toContain('vfs');
  });
});

describe('policy', () => {
  it('lists what a guest already has and what signing in would add', async () => {
    const r = await runMetaCommand('policy', []);
    expect(r.stdout).toMatch(/Signed in: no/);
    expect(r.stdout).toMatch(/Available now:[\s\S]*vfs/);
    expect(r.stdout).toMatch(/Requires signing in:[\s\S]*python/);
    expect(r.stdout).toMatch(/Requires signing in:[\s\S]*net/);
  });

  it('does not list signed-in-gated capabilities as already required once signed in', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    const r = await runMetaCommand('policy', []);
    expect(r.stdout).toMatch(/Signed in: yes/);
    expect(r.stdout).not.toMatch(/Requires signing in/);
    expect(r.stdout).toContain('python');
    expect(r.stdout).toContain('net');
  });

  // model:cloud and exec are rate-limited, not signed-in-gated — a guest
  // should see them as available (with the caveat), not locked behind a
  // sign-in prompt that isn't the real gate.
  it('does not tell a guest to sign in for a rate-limited-only capability', async () => {
    const r = await runMetaCommand('policy', []);
    const requiresSection = r.stdout
      .split('Requires signing in:')[1]
      .split('Sign in from Settings')[0]; // the cross-reference note after this is not part of the list
    expect(requiresSection).not.toContain('exec');
    expect(requiresSection).not.toContain('model:cloud');
  });
});

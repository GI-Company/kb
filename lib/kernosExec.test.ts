import { describe, it, expect, vi, beforeEach } from 'vitest';

// downloadIntoOverlay stages through a REAL VfsOverlay, so only the
// underlying vfs.ts backend needs mocking — the staging/collision logic
// under test is the real thing, same pattern as vfsOverlay.test.ts.
const state = { nodes: new Map<string, { id: string; name: string; type: string; content?: string; parentId?: string; encoding?: string }>() };
let idCounter = 0;
const vfsCreate = vi.fn(async (parentId: string, name: string, type: 'file' | 'directory', _userId: string, content = '', _mountSource?: string, encoding?: string) => {
  const id = `real:${idCounter++}`;
  const node = { id, name, type, content, parentId, encoding };
  state.nodes.set(id, node);
  return node;
});
const vfsList = vi.fn(async (parentId: string) => [...state.nodes.values()].filter(n => n.parentId === parentId));

vi.mock('./vfs', () => ({
  vfs: {
    read: vi.fn(async () => ''),
    exists: vi.fn(async () => false),
    write: vi.fn(async () => true),
    list: vfsList,
    create: vfsCreate,
  },
}));

// Supabase "configured" (a truthy client) but the session itself is
// controlled per-test — mirrors the real distinction between "Supabase is
// set up for this deployment" and "this particular caller is signed in."
let mockSession: { access_token: string } | null = null;
vi.mock('./supabaseClient', () => ({
  supabase: {
    auth: { getSession: () => Promise.resolve({ data: { session: mockSession } }) },
  },
}));

const { VfsOverlay } = await import('./vfsOverlay');
const { downloadIntoOverlay } = await import('./kernosExec');

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

// The client-side half of kernos.exec's net.download tool — the RPC layer
// itself needs a real Worker to exercise (not unit-tested, verified live
// instead), but downloadIntoOverlay is the whole download-then-stage
// contract, callable directly with an injected fetchImpl.
describe('downloadIntoOverlay — kernos.exec net.download\'s client-side half', () => {
  beforeEach(() => {
    state.nodes.clear();
    idCounter = 0;
    mockSession = null;
    vfsCreate.mockClear();
    vfsList.mockClear();
  });

  it('stages a file with the server-returned bytes and encoding, not committed yet', async () => {
    const overlay = new VfsOverlay('u1');
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0, stdout: '', stderr: '',
      download: { name: 'logo.png', contentBase64: 'iVBORw0=', encoding: 'base64' },
    }));

    const node = await downloadIntoOverlay('https://example.com/logo.png', 'root', undefined, overlay, fetchImpl as any);

    expect(node.name).toBe('logo.png');
    expect(node.encoding).toBe('base64');
    expect(overlay.hasPendingWrites).toBe(true);
    expect(vfsCreate).not.toHaveBeenCalled(); // staged, not durable, until commit()

    await overlay.commit();
    expect(vfsCreate).toHaveBeenCalledWith('root', 'logo.png', 'file', 'u1', 'iVBORw0=', undefined, 'base64');
  });

  it('attaches the real Supabase access token as a Bearer header when signed in', async () => {
    mockSession = { access_token: 'real-token-abc' };
    const overlay = new VfsOverlay('u1');
    const fetchImpl = vi.fn(async (_url: string, _opts: any) => jsonResponse({
      code: 0, download: { name: 'f.bin', contentBase64: 'AA==', encoding: 'base64' },
    }));

    await downloadIntoOverlay('https://example.com/f.bin', 'root', undefined, overlay, fetchImpl as any);

    const opts = fetchImpl.mock.calls[0][1];
    expect(opts.headers.authorization).toBe('Bearer real-token-abc');
  });

  it('sends no Authorization header for a guest session, and the server denial surfaces as a thrown error', async () => {
    mockSession = null;
    const overlay = new VfsOverlay('u1');
    const fetchImpl = vi.fn(async (_url: string, _opts: any) => jsonResponse({
      code: 126, stdout: '', stderr: "PERMISSION DENIED: 'curl' requires a signed-in account — guests get the sandboxed coreutils only.\n",
    }));

    await expect(downloadIntoOverlay('https://example.com/f.bin', 'root', undefined, overlay, fetchImpl as any))
      .rejects.toThrow(/signed-in account/);

    const opts = fetchImpl.mock.calls[0][1];
    expect(opts.headers.authorization).toBeUndefined();
    expect(overlay.hasPendingWrites).toBe(false);
  });

  it('throws the server-reported error for a blocked/failed request, staging nothing', async () => {
    const overlay = new VfsOverlay('u1');
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 1, stdout: '', stderr: 'curl: refusing to connect to "10.0.0.5" — private/internal address ranges are blocked\n',
    }));

    await expect(downloadIntoOverlay('http://10.0.0.5/', 'root', undefined, overlay, fetchImpl as any))
      .rejects.toThrow(/private\/internal address/);
    expect(overlay.hasPendingWrites).toBe(false);
  });

  it('passes an explicit name as -o, not -O, so the server names it exactly as given', async () => {
    const overlay = new VfsOverlay('u1');
    const fetchImpl = vi.fn(async (_url: string, _opts: any) => jsonResponse({
      code: 0, download: { name: 'custom.bin', contentBase64: 'AQID', encoding: 'base64' },
    }));

    await downloadIntoOverlay('https://example.com/logo.png', 'root', 'custom.bin', overlay, fetchImpl as any);

    const opts = fetchImpl.mock.calls[0][1];
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ cmd: 'curl', args: ['https://example.com/logo.png', '-o', 'custom.bin'] });
  });

  it('with no explicit name, asks the server to name it from the URL (-O)', async () => {
    const overlay = new VfsOverlay('u1');
    const fetchImpl = vi.fn(async (_url: string, _opts: any) => jsonResponse({
      code: 0, download: { name: 'logo.png', contentBase64: 'AQID', encoding: 'base64' },
    }));

    await downloadIntoOverlay('https://example.com/logo.png', 'root', undefined, overlay, fetchImpl as any);

    const opts = fetchImpl.mock.calls[0][1];
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ cmd: 'curl', args: ['https://example.com/logo.png', '-O'] });
  });

  // The overlay's own name-collision guard applies here exactly as it does
  // to an agent's explicit vfs.create() call — net.download isn't a
  // separate write path with its own rules.
  it('a name collision with an existing sibling is rejected by the overlay, same as any create()', async () => {
    state.nodes.set('existing', { id: 'existing', name: 'logo.png', type: 'file', parentId: 'root', content: '' });
    const overlay = new VfsOverlay('u1');
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 0, download: { name: 'logo.png', contentBase64: 'AQID', encoding: 'base64' },
    }));

    await expect(downloadIntoOverlay('https://example.com/logo.png', 'root', undefined, overlay, fetchImpl as any))
      .rejects.toThrow(/already exists/);
  });

  it('a success response missing the download field is a clear internal error, not a silent no-op', async () => {
    const overlay = new VfsOverlay('u1');
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, stdout: 'ok\n', stderr: '' }));

    await expect(downloadIntoOverlay('https://example.com/logo.png', 'root', undefined, overlay, fetchImpl as any))
      .rejects.toThrow(/no content was returned|bug/);
  });
});

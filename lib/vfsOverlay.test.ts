import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = { nodes: new Map<string, { id: string; name: string; type: string; content?: string; parentId?: string; encoding?: string }>() };
let idCounter = 0;

const vfsRead = vi.fn(async (id: string) => state.nodes.get(id)?.content ?? '');
const vfsExists = vi.fn(async (id: string) => state.nodes.has(id));
const vfsWrite = vi.fn(async (id: string, content: string, _userId?: string, encoding?: string) => {
  const node = state.nodes.get(id);
  if (!node) return false;
  node.content = content;
  node.encoding = encoding;
  return true;
});
const vfsList = vi.fn(async (parentId: string) =>
  [...state.nodes.values()].filter(n => n.parentId === parentId)
);
const vfsCreate = vi.fn(async (parentId: string, name: string, type: 'file' | 'directory', _userId: string, content = '', _mountSource?: string, encoding?: string) => {
  const id = `real:${idCounter++}`;
  const node = { id, name, type, content, parentId, encoding };
  state.nodes.set(id, node);
  return node;
});

vi.mock('./vfs', () => ({
  vfs: { read: vfsRead, exists: vfsExists, write: vfsWrite, list: vfsList, create: vfsCreate },
}));

const { VfsOverlay } = await import('./vfsOverlay');

beforeEach(() => {
  vi.clearAllMocks();
  state.nodes.clear();
  idCounter = 0;
  state.nodes.set('root', { id: 'root', name: 'root', type: 'directory', parentId: undefined });
  state.nodes.set('existing', { id: 'existing', name: 'notes.md', type: 'file', content: 'original', parentId: 'root' });
});

describe('VfsOverlay', () => {
  // The entire point of the class: nothing staged reaches the real VFS
  // until commit() is called.
  it('never touches the real vfs on write/create alone', async () => {
    const overlay = new VfsOverlay('u1');
    await overlay.write('existing', 'changed');
    await overlay.create('root', 'new.txt', 'file', 'hi');
    expect(vfsWrite).not.toHaveBeenCalled();
    expect(vfsCreate).not.toHaveBeenCalled();
    expect(await vfsRead('existing')).toBe('original'); // the real store is untouched
  });

  it('read-your-writes: a staged write is visible to a read in the same overlay', async () => {
    const overlay = new VfsOverlay('u1');
    await overlay.write('existing', 'changed');
    expect(await overlay.read('existing')).toBe('changed');
  });

  it('a staged create is readable by its returned id before commit', async () => {
    const overlay = new VfsOverlay('u1');
    const node = await overlay.create('root', 'new.txt', 'file', 'hello');
    expect(await overlay.read(node.id)).toBe('hello');
  });

  it('list() merges staged creates into the real listing', async () => {
    const overlay = new VfsOverlay('u1');
    const before = await overlay.list('root');
    expect(before.map(n => n.name)).toEqual(['notes.md']);

    await overlay.create('root', 'new.txt', 'file', 'hi');
    const after = await overlay.list('root');
    expect(after.map(n => n.name).sort()).toEqual(['new.txt', 'notes.md']);
  });

  it('discard() leaves the real vfs completely unchanged', async () => {
    const overlay = new VfsOverlay('u1');
    await overlay.write('existing', 'changed');
    await overlay.create('root', 'new.txt', 'file', 'hi');
    overlay.discard();

    expect(vfsWrite).not.toHaveBeenCalled();
    expect(vfsCreate).not.toHaveBeenCalled();
    expect(state.nodes.get('existing')?.content).toBe('original');
    expect(state.nodes.size).toBe(2); // root + existing only
  });

  it('commit() replays a write against a pre-existing id', async () => {
    const overlay = new VfsOverlay('u1');
    await overlay.write('existing', 'changed');
    await overlay.commit();

    expect(vfsWrite).toHaveBeenCalledWith('existing', 'changed', 'u1', undefined);
    expect(state.nodes.get('existing')?.content).toBe('changed');
  });

  it('commit() creates a staged node for real and gives it a durable id', async () => {
    const overlay = new VfsOverlay('u1');
    await overlay.create('root', 'new.txt', 'file', 'hi');
    await overlay.commit();

    expect(vfsCreate).toHaveBeenCalledWith('root', 'new.txt', 'file', 'u1', 'hi', undefined, undefined);
    const created = [...state.nodes.values()].find(n => n.name === 'new.txt');
    expect(created?.content).toBe('hi');
  });

  // The case that makes call-order replay necessary rather than a plain
  // key-value flush: create a directory, then a file inside it — the
  // child's parentId is a tempId at staging time and must resolve to
  // whatever real id the parent gets at commit time.
  it('commits a nested create in dependency order, resolving the parent tempId', async () => {
    const overlay = new VfsOverlay('u1');
    const dir = await overlay.create('root', 'subdir', 'directory');
    await overlay.create(dir.id, 'child.txt', 'file', 'nested');
    await overlay.commit();

    const realDir = [...state.nodes.values()].find(n => n.name === 'subdir')!;
    const realChild = [...state.nodes.values()].find(n => n.name === 'child.txt')!;
    expect(realChild.parentId).toBe(realDir.id);
    expect(realChild.parentId).not.toMatch(/^staged:/);
  });

  // A write staged after a create for the SAME node should win at commit —
  // matches what the agent's script actually did, in the order it did it.
  it('a write staged after a create for the same node applies on top of it', async () => {
    const overlay = new VfsOverlay('u1');
    const node = await overlay.create('root', 'new.txt', 'file', 'first');
    await overlay.write(node.id, 'second');
    await overlay.commit();

    const created = [...state.nodes.values()].find(n => n.name === 'new.txt');
    expect(created?.content).toBe('second');
  });

  it('hasPendingWrites reflects whether anything was staged', async () => {
    const overlay = new VfsOverlay('u1');
    expect(overlay.hasPendingWrites).toBe(false);
    await overlay.write('existing', 'x');
    expect(overlay.hasPendingWrites).toBe(true);
  });

  // The bug this session's code review flagged: write() used to accept
  // any id optimistically and only discover a dead target at commit time
  // — by which point the sandboxed run had already reported ok:true, with
  // no way for the caller's own script to react to the failure at all.
  describe('write() fails fast on a dead id', () => {
    it('returns false and stages nothing for an id that is neither real nor staged', async () => {
      const overlay = new VfsOverlay('u1');
      const ok = await overlay.write('does-not-exist', 'x');

      expect(ok).toBe(false);
      expect(overlay.hasPendingWrites).toBe(false);
      expect(vfsExists).toHaveBeenCalledWith('does-not-exist', 'u1');
    });

    it('still succeeds against a real pre-existing id', async () => {
      const overlay = new VfsOverlay('u1');
      const ok = await overlay.write('existing', 'changed');
      expect(ok).toBe(true);
    });

    it('still succeeds against a tempId staged by an earlier create() in the same overlay, without a real-vfs check', async () => {
      const overlay = new VfsOverlay('u1');
      const node = await overlay.create('root', 'new.txt', 'file', 'first');
      vfsExists.mockClear();
      const ok = await overlay.write(node.id, 'second');

      expect(ok).toBe(true);
      expect(vfsExists).not.toHaveBeenCalled(); // already known-staged, no round trip needed
    });
  });

  // vfs.ts itself enforces no name uniqueness at all — two real nodes can
  // share a name under the same parent. Without this check, two staged
  // creates for the same name would both "succeed" and leave two
  // ambiguous nodes behind (the exact hazard a download tool racing itself
  // would hit), or the second would stage fine and only fail at commit.
  describe('create() rejects a name collision immediately', () => {
    it('rejects a second staged create with the same name under the same parent', async () => {
      const overlay = new VfsOverlay('u1');
      await overlay.create('root', 'download.bin', 'file', 'first');

      await expect(overlay.create('root', 'download.bin', 'file', 'second')).rejects.toThrow(/already staged/);
    });

    it('allows the same name under a DIFFERENT parent', async () => {
      const overlay = new VfsOverlay('u1');
      const dir = await overlay.create('root', 'subdir', 'directory');
      await expect(overlay.create(dir.id, 'download.bin', 'file', 'in subdir')).resolves.toBeTruthy();
      await expect(overlay.create('root', 'download.bin', 'file', 'in root')).resolves.toBeTruthy();
    });

    it('rejects a staged create colliding with a real, already-existing node', async () => {
      const overlay = new VfsOverlay('u1');
      // 'existing' (notes.md) is seeded under 'root' in beforeEach.
      await expect(overlay.create('root', 'notes.md', 'file', 'x')).rejects.toThrow(/already exists/);
      expect(overlay.hasPendingWrites).toBe(false); // nothing staged from the rejected attempt
    });

    it('does not reject a collision-free create', async () => {
      const overlay = new VfsOverlay('u1');
      await expect(overlay.create('root', 'new.txt', 'file', 'hi')).resolves.toBeTruthy();
    });
  });

  describe('commit() reports per-op results instead of aborting on the first failure', () => {
    it('reports a full success with no failures', async () => {
      const overlay = new VfsOverlay('u1');
      await overlay.write('existing', 'changed');
      await overlay.create('root', 'new.txt', 'file', 'hi');
      const report = await overlay.commit();

      expect(report).toEqual({ committed: 2, failed: [] });
    });

    it('one op failing does not block unrelated ops from committing', async () => {
      // 'existing' gets deleted out from under the overlay between staging
      // and commit — vfs.write() will legitimately return false for it.
      const overlay = new VfsOverlay('u1');
      await overlay.write('existing', 'changed');
      await overlay.create('root', 'new.txt', 'file', 'hi');
      state.nodes.delete('existing');

      const report = await overlay.commit();

      expect(report.committed).toBe(1);
      expect(report.failed).toHaveLength(1);
      expect(report.failed[0].op).toMatchObject({ kind: 'write', id: 'existing' });
      // The unrelated create still landed for real, despite the write failing.
      expect([...state.nodes.values()].some(n => n.name === 'new.txt')).toBe(true);
    });

    it('a create failing marks its staged children as failed too, without attempting them against a bogus parent id', async () => {
      const overlay = new VfsOverlay('u1');
      const dir = await overlay.create('root', 'subdir', 'directory');
      await overlay.create(dir.id, 'child.txt', 'file', 'nested');
      vfsCreate.mockImplementationOnce(async () => { throw new Error('create failed'); });

      const report = await overlay.commit();

      expect(report.committed).toBe(0);
      expect(report.failed).toHaveLength(2);
      expect(report.failed.map(f => f.op.kind === 'create' ? f.op.name : null)).toEqual(['subdir', 'child.txt']);
      // vfs.create was never called a second time for the child against
      // the parent's raw (unresolved) tempId string.
      expect(vfsCreate).toHaveBeenCalledTimes(1);
    });
  });

  // Added for kernos.exec's net.download tool — a downloaded file's bytes
  // have to survive staging exactly as base64, not be silently reinterpreted
  // as plain text along the way.
  describe('encoding (base64 content) is threaded through staging and commit', () => {
    it('create() with encoding stages a node carrying it, readable before commit', async () => {
      const overlay = new VfsOverlay('u1');
      const node = await overlay.create('root', 'logo.png', 'file', 'iVBORw0=', 'base64');
      expect(node.encoding).toBe('base64');
      expect(await overlay.read(node.id)).toBe('iVBORw0=');
    });

    it('commit() passes encoding through to the real vfs.create', async () => {
      const overlay = new VfsOverlay('u1');
      await overlay.create('root', 'logo.png', 'file', 'iVBORw0=', 'base64');
      await overlay.commit();

      expect(vfsCreate).toHaveBeenCalledWith('root', 'logo.png', 'file', 'u1', 'iVBORw0=', undefined, 'base64');
      const created = [...state.nodes.values()].find(n => n.name === 'logo.png');
      expect(created?.encoding).toBe('base64');
    });

    it('write() with encoding passes it through to the real vfs.write on commit', async () => {
      const overlay = new VfsOverlay('u1');
      await overlay.write('existing', 'AQIDBA==', 'base64');
      await overlay.commit();

      expect(vfsWrite).toHaveBeenCalledWith('existing', 'AQIDBA==', 'u1', 'base64');
      expect(state.nodes.get('existing')?.encoding).toBe('base64');
    });

    it('a plain write (no encoding) still commits as plain text, unaffected by the new param', async () => {
      const overlay = new VfsOverlay('u1');
      await overlay.write('existing', 'plain text');
      await overlay.commit();

      expect(state.nodes.get('existing')?.content).toBe('plain text');
      expect(state.nodes.get('existing')?.encoding).toBeUndefined();
    });
  });
});

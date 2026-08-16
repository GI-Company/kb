import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = { nodes: new Map<string, { id: string; name: string; type: string; content?: string; parentId?: string }>() };
let idCounter = 0;

const vfsRead = vi.fn(async (id: string) => state.nodes.get(id)?.content ?? '');
const vfsWrite = vi.fn(async (id: string, content: string) => {
  const node = state.nodes.get(id);
  if (!node) return false;
  node.content = content;
  return true;
});
const vfsList = vi.fn(async (parentId: string) =>
  [...state.nodes.values()].filter(n => n.parentId === parentId)
);
const vfsCreate = vi.fn(async (parentId: string, name: string, type: 'file' | 'directory', _userId: string, content = '') => {
  const id = `real:${idCounter++}`;
  const node = { id, name, type, content, parentId };
  state.nodes.set(id, node);
  return node;
});

vi.mock('./vfs', () => ({
  vfs: { read: vfsRead, write: vfsWrite, list: vfsList, create: vfsCreate },
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

    expect(vfsWrite).toHaveBeenCalledWith('existing', 'changed', 'u1');
    expect(state.nodes.get('existing')?.content).toBe('changed');
  });

  it('commit() creates a staged node for real and gives it a durable id', async () => {
    const overlay = new VfsOverlay('u1');
    await overlay.create('root', 'new.txt', 'file', 'hi');
    await overlay.commit();

    expect(vfsCreate).toHaveBeenCalledWith('root', 'new.txt', 'file', 'u1', 'hi');
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
});

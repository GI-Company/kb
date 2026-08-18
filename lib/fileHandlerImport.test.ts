import { describe, it, expect, vi, beforeEach } from 'vitest';

const vfsCreate = vi.fn(async (parentId: string, name: string, type: string, _userId: string, content = '') => ({
  id: `real:${name}`, name, type, content, parentId,
}));

vi.mock('./vfs', () => ({ vfs: { create: vfsCreate } }));

const { importLaunchedFile } = await import('./fileHandlerImport');

// No real FileSystemFileHandle exists outside an actual OS "Open with"
// launch, which nothing in this test (or the page's own JS) can trigger —
// launchQueue exposes no way to simulate one. Enough of the real shape to
// exercise this function: a getFile() that resolves to something with a
// name and an async text().
function fakeFileHandle(name: string, content: string): FileSystemFileHandle {
  return {
    getFile: async () => ({ name, text: async () => content } as unknown as File),
  } as unknown as FileSystemFileHandle;
}

describe('importLaunchedFile — the file_handlers launch consumer\'s import step', () => {
  beforeEach(() => vfsCreate.mockClear());

  it('reads the launched file\'s content and creates it in the VFS root under its own name', async () => {
    const handle = fakeFileHandle('notes.md', '# hello\n');
    const result = await importLaunchedFile(handle, 'u1');

    expect(result.name).toBe('notes.md');
    expect(vfsCreate).toHaveBeenCalledWith('home', 'notes.md', 'file', 'u1', '# hello\n');
  });

  it('returns the real durable id vfs.create hands back, not a placeholder', async () => {
    const handle = fakeFileHandle('a.txt', 'x');
    const result = await importLaunchedFile(handle, 'u1');
    expect(result.fileId).toBe('real:a.txt');
  });

  it('scopes the create to the given userId', async () => {
    const handle = fakeFileHandle('b.txt', 'y');
    await importLaunchedFile(handle, 'a-different-user');
    expect(vfsCreate).toHaveBeenCalledWith('home', 'b.txt', 'file', 'a-different-user', 'y');
  });
});

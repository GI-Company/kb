import { describe, it, expect, beforeEach, vi } from 'vitest';

// lib/vfs.ts's guest backend is localStorage-backed, and this environment
// has no localStorage — writes would silently no-op and every round-trip
// assertion below would be meaningless. So the VFS is replaced with an
// in-memory tree that behaves the same way: id-keyed nodes, children
// resolved by parent, 'home' as the root sentinel.

interface Node { id: string; name: string; type: 'file' | 'directory'; content: string; parentId: string }
let nodes: Record<string, Node> = {};
let seq = 0;

vi.mock('./vfs', () => ({
  vfs: {
    list: async (parentId: string) =>
      Object.values(nodes).filter(n => n.parentId === parentId).map(n => ({ id: n.id, name: n.name, type: n.type })),
    read: async (id: string) => nodes[id]?.content ?? '',
    write: async (id: string, content: string) => { if (nodes[id]) nodes[id].content = content; return true; },
    create: async (parentId: string, name: string, type: 'file' | 'directory', _u: string, content = '') => {
      const id = `n${++seq}`;
      nodes[id] = { id, name, type, content, parentId };
      return { id, name, type };
    },
    remove: async (id: string) => {
      // Cascade, so `rm -r` on a directory removes what's inside it too.
      const doomed = [id];
      while (doomed.length) {
        const cur = doomed.pop()!;
        for (const n of Object.values(nodes)) if (n.parentId === cur) doomed.push(n.id);
        delete nodes[cur];
      }
      return true;
    },
  },
}));

import { runFsCommand, cwdPath, ROOT_CWD, Cwd } from './terminalFs';

const USER = 'guest';

/** Runs a command line, threading cwd through like the terminal does. */
async function sh(line: string, cwd: Cwd = ROOT_CWD) {
  const [command, ...args] = line.split(' ').filter(Boolean);
  return runFsCommand(command, args, { cwd, userId: USER });
}

describe('VFS-backed terminal commands', () => {
  beforeEach(() => { nodes = {}; seq = 0; });

  it('starts at the root', async () => {
    const { result } = await sh('pwd');
    expect(result.stdout).toBe('/\n');
  });

  // The whole point: the server jail was destroyed between commands, so a
  // file created by one command was invisible to the next.
  it('a created file survives to the next command', async () => {
    await sh('write notes.md hello there');
    const { result } = await sh('cat notes.md');
    expect(result.stdout).toBe('hello there\n');
    expect(result.code).toBe(0);
  });

  it('mkdir then cd then pwd', async () => {
    await sh('mkdir projects');
    const { cwd } = await sh('cd projects');
    expect(cwdPath(cwd)).toBe('/projects');
    const { result } = await runFsCommand('pwd', [], { cwd, userId: USER });
    expect(result.stdout).toBe('/projects\n');
  });

  it('.. walks back up, and stops at the root instead of erroring', async () => {
    await sh('mkdir a');
    let { cwd } = await sh('cd a');
    ({ cwd } = await runFsCommand('cd', ['..'], { cwd, userId: USER }));
    expect(cwdPath(cwd)).toBe('/');
    ({ cwd } = await runFsCommand('cd', ['..'], { cwd, userId: USER }));
    expect(cwdPath(cwd)).toBe('/');
  });

  it('resolves absolute paths regardless of cwd', async () => {
    await sh('mkdir a');
    const { cwd } = await sh('cd a');
    await runFsCommand('write', ['deep.txt', 'x'], { cwd, userId: USER });
    // From inside /a, an absolute path still resolves from the root.
    const { result } = await runFsCommand('cat', ['/a/deep.txt'], { cwd, userId: USER });
    expect(result.stdout).toBe('x\n');
  });

  it('ls marks directories and sorts', async () => {
    await sh('mkdir zeta');
    await sh('write alpha.txt a');
    const { result } = await sh('ls');
    expect(result.stdout).toBe('alpha.txt\nzeta/\n');
  });

  it('cat on a missing file explains, and exits non-zero', async () => {
    const { result } = await sh('cat nope.txt');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('No such file or directory');
  });

  it('cat with no argument shows usage', async () => {
    const { result } = await sh('cat');
    expect(result.stderr).toContain('Usage: cat <file>');
  });

  // `>>` maps to write -a. Dropping the flag would silently overwrite,
  // which destroys data rather than merely failing.
  it('write -a appends instead of overwriting', async () => {
    await sh('write log.txt one\n');
    await sh('write -a log.txt two\n');
    expect((await sh('cat log.txt')).result.stdout).toBe('one\ntwo\n');
  });

  it('write without -a overwrites', async () => {
    await sh('write log.txt one');
    await sh('write log.txt two');
    expect((await sh('cat log.txt')).result.stdout).toBe('two\n');
  });

  it('mkdir refuses to clobber an existing name', async () => {
    await sh('mkdir a');
    const { result } = await sh('mkdir a');
    expect(result.stderr).toContain('File exists');
  });

  it('rm needs -r for a directory', async () => {
    await sh('mkdir a');
    const bare = await sh('rm a');
    expect(bare.result.stderr).toContain('use -r');
    const rec = await sh('rm -r a');
    expect(rec.result.code).toBe(0);
    expect((await sh('ls')).result.stdout).toBe('');
  });

  // Deleting the directory you're standing in would leave the session
  // pointed at a node that no longer exists.
  it('refuses to remove the current directory', async () => {
    await sh('mkdir a');
    const { cwd } = await sh('cd a');
    const { result } = await runFsCommand('rm', ['-r', '/a'], { cwd, userId: USER });
    expect(result.stderr).toContain('current directory');
  });

  it('mv renames and removes the original', async () => {
    await sh('write old.txt content');
    await sh('mv old.txt new.txt');
    expect((await sh('cat new.txt')).result.stdout).toBe('content\n');
    expect((await sh('cat old.txt')).result.code).not.toBe(0);
  });

  it('cp keeps the original', async () => {
    await sh('write a.txt data');
    await sh('cp a.txt b.txt');
    expect((await sh('cat a.txt')).result.stdout).toBe('data\n');
    expect((await sh('cat b.txt')).result.stdout).toBe('data\n');
  });

  it('mv into a directory keeps the filename', async () => {
    await sh('mkdir dest');
    await sh('write f.txt v');
    await sh('mv f.txt dest');
    expect((await sh('cat dest/f.txt')).result.stdout).toBe('v\n');
  });

  it('cd into a file is an error, not a silent no-op', async () => {
    await sh('write f.txt v');
    const { result, cwd } = await sh('cd f.txt');
    expect(result.stderr).toContain('Not a directory');
    expect(cwdPath(cwd)).toBe('/');
  });
});

// `write q.txt "one"` then `echo two >> q.txt` produced "onetwo": one line
// where the user wrote two. Every line-oriented command downstream then saw
// a single mangled record. Found by piping a written file into classify.
describe('write terminates its line', () => {
  it('appends after a write without gluing the lines together', async () => {
    const ctx = { cwd: [] as any, userId: 'guest' };
    await runFsCommand('write', ['glue.txt', 'one'], ctx);
    await runFsCommand('write', ['-a', 'glue.txt', 'two\n'], ctx);
    const { result } = await runFsCommand('cat', ['glue.txt'], ctx);
    expect(result.stdout).toBe('one\ntwo\n');
  });

  it('does not add a second newline to content that already ends with one', async () => {
    const ctx = { cwd: [] as any, userId: 'guest' };
    await runFsCommand('write', ['nl.txt', 'already\n'], ctx);
    const { result } = await runFsCommand('cat', ['nl.txt'], ctx);
    expect(result.stdout).toBe('already\n');
  });
});

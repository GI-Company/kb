// Filesystem commands backed by the real VFS (lib/vfs.ts) instead of the
// server's throwaway jail.
//
// WHY THIS EXISTS: /api/exec runs each command in a fresh mkdtemp directory
// that is destroyed the moment it returns. So `mkdir` and `touch` were in
// the allowlist but useless — you could create a file and it was gone
// before you could `cat` it, and there was no `cd` at all. Meanwhile this
// app already has a persistent, per-user, Supabase-backed filesystem that
// the terminal never touched.
//
// Running these client-side is both more capable and more secure:
//   - Persistent, and synced across devices for signed-in accounts.
//   - Instant; no network round trip for `ls`.
//   - Scoped to the calling user by lib/vfs.ts.
//   - These commands stop reaching execFile entirely, so the server's
//     attack surface shrinks rather than grows.
//
// CWD is a breadcrumb stack, not a node id. `..` needs a parent, and the
// Supabase backend's list() doesn't return parent_id (the tree is
// represented relationally there, unlike the localStorage backend). A stack
// makes `..` a pop and behaves identically on both backends.

import { vfs } from './vfs';
import { FileNode } from '../types';
import { VfsOverlay } from './vfsOverlay';

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Path from the root to the current directory. Empty = at the root. */
export type Cwd = { id: string; name: string }[];

const ROOT_ID = 'home';

export const ROOT_CWD: Cwd = [];

export function cwdPath(cwd: Cwd): string {
  return '/' + cwd.map(c => c.name).join('/');
}

function dirId(cwd: Cwd): string {
  return cwd.length ? cwd[cwd.length - 1].id : ROOT_ID;
}

/** Text with exactly one trailing newline; empty stays empty. */
function endWithNewline(text: string): string {
  return text === '' || text.endsWith('\n') ? text : text + '\n';
}

/** Decoded byte length of a base64 string, without pulling in Node's Buffer (this file runs client-side, in the browser, not just server-side). */
function base64ByteLength(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

function ok(stdout = ''): CommandResult {
  return { stdout, stderr: '', code: 0 };
}

function err(command: string, message: string, code = 1): CommandResult {
  return { stdout: '', stderr: `${command}: ${message}\n`, code };
}

/**
 * Walks a path to the directory it names. Returns the new breadcrumb stack,
 * or a string describing why it couldn't.
 *
 * Handles `/abs`, `rel`, `.`, `..`, and trailing slashes. `..` at the root
 * stays at the root, matching how a real shell behaves rather than erroring.
 */
export async function resolveDir(cwd: Cwd, path: string, userId: string): Promise<Cwd | string> {
  const absolute = path.startsWith('/');
  let stack: Cwd = absolute ? [] : [...cwd];
  const segments = path.split('/').filter(s => s.length > 0);

  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    const children = await vfs.list(dirId(stack), userId);
    const match = children.find(c => c.name === segment);
    if (!match) return `${path}: No such file or directory`;
    if (match.type !== 'directory') return `${path}: Not a directory`;
    stack = [...stack, { id: match.id, name: match.name }];
  }
  return stack;
}

/** Splits a path into its parent directory and final component. */
export async function resolveParent(
  cwd: Cwd,
  path: string,
  userId: string
): Promise<{ parent: Cwd; name: string } | string> {
  const clean = path.replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  if (idx === -1) return { parent: [...cwd], name: clean };

  const parentPath = idx === 0 ? '/' : clean.slice(0, idx);
  const name = clean.slice(idx + 1);
  const parent = await resolveDir(cwd, parentPath, userId);
  if (typeof parent === 'string') return parent;
  return { parent, name };
}

/** Finds the node a path names, plus the directory containing it. */
async function resolveNode(
  cwd: Cwd,
  path: string,
  userId: string
): Promise<{ node: FileNode; parent: Cwd } | string> {
  const resolved = await resolveParent(cwd, path, userId);
  if (typeof resolved === 'string') return resolved;
  const { parent, name } = resolved;
  if (!name) return `${path}: No such file or directory`;

  const children = await vfs.list(dirId(parent), userId);
  const node = children.find(c => c.name === name);
  if (!node) return `${path}: No such file or directory`;
  return { node, parent };
}

export interface FsContext {
  cwd: Cwd;
  userId: string;
}

/**
 * Commands the TERMINAL handles here rather than sending to /api/exec.
 *
 * These names are shadowed only for the terminal, not globally, so do NOT
 * "clean up" api/exec.ts's allowlist by removing them. lib/taskEngine.ts
 * calls /api/exec directly for DAG shell nodes, bypassing this file
 * entirely — and the built-in demo pipeline's build step is `ls -la`.
 * Dropping ls/cat/mkdir/touch/cp/mv from the server allowlist would break
 * task workflows while looking like dead-code removal.
 */
export const VFS_COMMANDS = new Set([
  'ls', 'cat', 'cd', 'pwd', 'mkdir', 'touch', 'rm', 'mv', 'cp', 'write',
]);

export const VFS_USAGE: Record<string, string> = {
  ls: 'Usage: ls [path]',
  cat: 'Usage: cat <file>',
  cd: 'Usage: cd <directory>',
  pwd: 'Usage: pwd',
  mkdir: 'Usage: mkdir <directory>',
  touch: 'Usage: touch <file>',
  rm: 'Usage: rm [-r] <path>',
  mv: 'Usage: mv <source> <destination>',
  cp: 'Usage: cp <source> <destination>',
  write: 'Usage: write [-a] <file> <text>   (-a appends; `>` and `>>` use this)',
};

function usageErr(command: string, message: string): CommandResult {
  const usage = VFS_USAGE[command];
  return { stdout: '', stderr: `${command}: ${message}\n${usage ? usage + '\n' : ''}`, code: 1 };
}

/**
 * Runs a VFS-backed command. Returns the result plus the (possibly changed)
 * cwd, so `cd` can move the session without the caller special-casing it.
 */
export async function runFsCommand(
  command: string,
  args: string[],
  ctx: FsContext
): Promise<{ result: CommandResult; cwd: Cwd }> {
  const { cwd, userId } = ctx;
  const positional = args.filter(a => !a.startsWith('-'));
  const flags = args.filter(a => a.startsWith('-'));
  const keep = (result: CommandResult) => ({ result, cwd });

  switch (command) {
    case 'pwd':
      return keep(ok(cwdPath(cwd) + '\n'));

    case 'cd': {
      const target = positional[0] ?? '/';
      const next = await resolveDir(cwd, target, userId);
      if (typeof next === 'string') return keep(err('cd', next));
      return { result: ok(), cwd: next };
    }

    case 'ls': {
      let target = cwd;
      if (positional[0]) {
        const resolved = await resolveDir(cwd, positional[0], userId);
        if (typeof resolved === 'string') return keep(err('ls', resolved));
        target = resolved;
      }
      const children = await vfs.list(dirId(target), userId);
      if (children.length === 0) return keep(ok(''));
      const sorted = [...children].sort((a, b) => a.name.localeCompare(b.name));
      // -l gets a type column; the default stays terse like a real ls.
      const long = flags.some(f => f.includes('l'));
      const body = long
        ? sorted.map(c => `${c.type === 'directory' ? 'd' : '-'}  ${c.name}`).join('\n')
        : sorted.map(c => (c.type === 'directory' ? c.name + '/' : c.name)).join('\n');
      return keep(ok(body + '\n'));
    }

    case 'cat': {
      if (!positional[0]) return keep(usageErr('cat', 'missing file operand'));
      const found = await resolveNode(cwd, positional[0], userId);
      if (typeof found === 'string') return keep(err('cat', found));
      if (found.node.type === 'directory') return keep(err('cat', `${positional[0]}: Is a directory`));
      const content = await vfs.read(found.node.id, userId);
      // Binary content (curl -O/wget downloads) is stored as base64 text —
      // dumping that raw would just be garbage on the terminal, so a size
      // summary stands in for it instead, same as a real shell refusing to
      // cat a binary to a tty.
      if (found.node.encoding === 'base64') {
        return keep(ok(`${positional[0]}: binary file, ${(base64ByteLength(content) / 1024).toFixed(1)} KB\n`));
      }
      return keep(ok(content.endsWith('\n') || content === '' ? content : content + '\n'));
    }

    case 'mkdir': {
      if (!positional[0]) return keep(usageErr('mkdir', 'missing operand'));
      const resolved = await resolveParent(cwd, positional[0], userId);
      if (typeof resolved === 'string') return keep(err('mkdir', resolved));
      const existing = await vfs.list(dirId(resolved.parent), userId);
      if (existing.some(c => c.name === resolved.name)) {
        return keep(err('mkdir', `cannot create directory '${positional[0]}': File exists`));
      }
      await vfs.create(dirId(resolved.parent), resolved.name, 'directory', userId);
      return keep(ok());
    }

    case 'touch': {
      if (!positional[0]) return keep(usageErr('touch', 'missing file operand'));
      const resolved = await resolveParent(cwd, positional[0], userId);
      if (typeof resolved === 'string') return keep(err('touch', resolved));
      const existing = await vfs.list(dirId(resolved.parent), userId);
      // Touching an existing file is a no-op rather than an error, matching
      // the real thing (which would just update mtime).
      if (existing.some(c => c.name === resolved.name)) return keep(ok());
      await vfs.create(dirId(resolved.parent), resolved.name, 'file', userId, '');
      return keep(ok());
    }

    case 'write': {
      if (positional.length < 2) return keep(usageErr('write', 'needs a file and text'));
      const [target, ...rest] = positional;
      // Text files end with a newline. Without this, `write q.txt "one"`
      // followed by `echo two >> q.txt` produced "onetwo" — one line where
      // the user wrote two, and every downstream line-oriented command
      // (classify, wc, grep) then saw a single mangled record. Pipeline
      // output already ends in \n, so this only fires for literal text.
      const text = endWithNewline(rest.join(' '));
      const resolved = await resolveParent(cwd, target, userId);
      if (typeof resolved === 'string') return keep(err('write', resolved));
      const existing = await vfs.list(dirId(resolved.parent), userId);
      const match = existing.find(c => c.name === resolved.name);
      if (match) {
        if (match.type === 'directory') return keep(err('write', `${target}: Is a directory`));
        // -a is what `>>` uses. Without it a redirect append would silently
        // overwrite, which is worse than failing — it destroys data.
        const append = flags.some(f => f.includes('a'));
        // A file written by something other than `write` (the editor, say)
        // may not be newline-terminated, so appending re-checks rather than
        // trusting the invariant above.
        const next = append ? endWithNewline(await vfs.read(match.id, userId)) + text : text;
        await vfs.write(match.id, next, userId);
      } else {
        await vfs.create(dirId(resolved.parent), resolved.name, 'file', userId, text);
      }
      return keep(ok());
    }

    case 'rm': {
      if (!positional[0]) return keep(usageErr('rm', 'missing operand'));
      const found = await resolveNode(cwd, positional[0], userId);
      if (typeof found === 'string') return keep(err('rm', found));
      const recursive = flags.some(f => f.includes('r'));
      if (found.node.type === 'directory' && !recursive) {
        return keep(err('rm', `cannot remove '${positional[0]}': Is a directory (use -r)`));
      }
      // Refusing to delete the directory you're standing in avoids leaving
      // the session pointed at something that no longer exists.
      if (cwd.some(c => c.id === found.node.id)) {
        return keep(err('rm', `cannot remove '${positional[0]}': it is the current directory or a parent of it`));
      }
      await vfs.remove(found.node.id, userId);
      return keep(ok());
    }

    case 'mv':
    case 'cp': {
      if (positional.length < 2) return keep(usageErr(command, 'needs a source and a destination'));
      const [from, to] = positional;
      const found = await resolveNode(cwd, from, userId);
      if (typeof found === 'string') return keep(err(command, found));
      if (found.node.type === 'directory') {
        return keep(err(command, `${from}: directories are not supported yet`));
      }

      const destination = await resolveParent(cwd, to, userId);
      if (typeof destination === 'string') return keep(err(command, destination));

      const siblings = await vfs.list(dirId(destination.parent), userId);
      // `mv a b/` where b is a directory means "into b", as in a real shell.
      const intoDir = siblings.find(c => c.name === destination.name && c.type === 'directory');
      const targetDir = intoDir ? [...destination.parent, { id: intoDir.id, name: intoDir.name }] : destination.parent;
      const targetName = intoDir ? found.node.name : destination.name;

      const content = await vfs.read(found.node.id, userId);
      const inTarget = await vfs.list(dirId(targetDir), userId);
      const clash = inTarget.find(c => c.name === targetName);
      if (clash) {
        if (clash.type === 'directory') return keep(err(command, `${to}: Is a directory`));
        await vfs.write(clash.id, content, userId);
      } else {
        await vfs.create(dirId(targetDir), targetName, 'file', userId, content);
      }
      if (command === 'mv') await vfs.remove(found.node.id, userId);
      return keep(ok());
    }

    default:
      return keep(err(command, 'not a filesystem command'));
  }
}

/**
 * Writes curl -O/-o's or wget's downloaded bytes into the VFS at `name`,
 * resolved against `cwd` exactly like `write` resolves its target — the
 * client-side half of the download-to-VFS bridge. The server that actually
 * fetched the bytes (lib/networkCommands.ts) has no VFS to write into at
 * all (see its CommandResult.download doc comment), so this is where a
 * curl -O/wget invocation actually lands in the user's files, called from
 * Terminal.tsx's vm.exec:download handler once the bytes arrive.
 *
 * Same collision behavior as `write`: overwrites an existing file, refuses
 * to clobber a directory.
 */
export async function saveDownload(
  cwd: Cwd,
  userId: string,
  name: string,
  contentBase64: string
): Promise<CommandResult> {
  const resolved = await resolveParent(cwd, name, userId);
  if (typeof resolved === 'string') return err('download', resolved);
  if (!resolved.name) return err('download', `${name}: No such file or directory`);

  const existing = await vfs.list(dirId(resolved.parent), userId);
  const match = existing.find(c => c.name === resolved.name);
  if (match) {
    if (match.type === 'directory') return err('download', `${name}: Is a directory`);
    const wrote = await vfs.write(match.id, contentBase64, userId, 'base64');
    if (!wrote) return err('download', `${name}: failed to write`);
  } else {
    await vfs.create(dirId(resolved.parent), resolved.name, 'file', userId, contentBase64, undefined, 'base64');
  }
  return ok(`wrote "${name}" (${(base64ByteLength(contentBase64) / 1024).toFixed(1)} KB)\n`);
}

/**
 * Candidate completions for a partial path, relative to cwd. Returns the
 * matching names (directories with a trailing slash) plus the prefix that
 * should be preserved, so the caller can rebuild the full token.
 *
 * Splitting on the last `/` means `cd pro<Tab>` and `cat a/b/no<Tab>` are
 * the same problem: list one directory, filter by the final segment.
 */
export async function completePath(
  cwd: Cwd,
  partial: string,
  userId: string
): Promise<{ prefix: string; matches: string[] }> {
  const idx = partial.lastIndexOf('/');
  const dirPart = idx === -1 ? '' : partial.slice(0, idx + 1);
  const namePart = idx === -1 ? partial : partial.slice(idx + 1);

  const dir = dirPart ? await resolveDir(cwd, dirPart, userId) : cwd;
  if (typeof dir === 'string') return { prefix: dirPart, matches: [] };

  const children = await vfs.list(dirId(dir), userId);
  const matches = children
    .filter(c => c.name.startsWith(namePart))
    .map(c => (c.type === 'directory' ? c.name + '/' : c.name))
    .sort();
  return { prefix: dirPart, matches };
}

/**
 * Every file in the current directory, as {name: content}. This is what a
 * Python script sees when it calls `open("notes.md")` — the bridge between
 * the VFS and the interpreter's in-memory filesystem.
 *
 * Deliberately one level deep and file-only: mirroring the whole tree into
 * WASM memory on every `python` invocation would mean paying for files the
 * script will never touch, and a script that wants a subdirectory can be
 * `cd`'d into it first. `maxBytes` caps the total so a large VFS can't wedge
 * the postMessage that carries it.
 */
export async function readDirFiles(
  cwd: Cwd,
  userId: string,
  maxBytes = 2_000_000
): Promise<Record<string, string>> {
  const children = await vfs.list(dirId(cwd), userId);
  const files: Record<string, string> = {};
  let total = 0;
  for (const child of children) {
    if (child.type !== 'file') continue;
    const content = await vfs.read(child.id, userId);
    total += content.length;
    if (total > maxBytes) break;
    files[child.name] = content;
  }
  return files;
}

/**
 * The write half of the Python bridge readDirFiles is the read half of.
 *
 * `original` is what readDirFiles handed to Python at the start of the
 * run; `finalState` is every file Pyodide's FS held when the run finished
 * (lib/python.worker.ts's collectWorkspaceFiles, scoped to the same one
 * flat directory readDirFiles reads from — a script that mkdir()'d a
 * subdirectory already had that silently excluded before this reaches
 * here). Only names whose content actually changed get written — a run
 * that read three files and touched none of them writes nothing back.
 *
 * Stages through lib/vfsOverlay.ts, the same primitive kernos.exec's VFS
 * writes use, and commits in one batch — so this should only be called
 * once the caller already knows the run succeeded. There is no discard()
 * call here for the failure case because there is nothing to discard: the
 * overlay is never populated unless this function runs, and this function
 * is the caller's choice, not something invoked speculatively.
 */
export async function writeBackFiles(
  cwd: Cwd,
  userId: string,
  original: Record<string, string>,
  finalState: Record<string, string>
): Promise<{ written: string[]; failed: string[] }> {
  const changed = Object.entries(finalState).filter(([name, content]) => original[name] !== content);
  if (changed.length === 0) return { written: [], failed: [] };

  const existing = await vfs.list(dirId(cwd), userId);
  const byName = new Map(existing.map(n => [n.name, n]));
  const overlay = new VfsOverlay(userId);
  // id (real, for a write) or tempId (for a create) -> file name, so the
  // commit report below — which only knows about staged ops, not names —
  // can be translated back into which names actually landed.
  const idToName = new Map<string, string>();

  for (const [name, content] of changed) {
    const node = byName.get(name);
    if (node && node.type === 'file') {
      const staged = await overlay.write(node.id, content);
      if (staged) idToName.set(node.id, name);
      // staged === false: the file's own id no longer exists in the real
      // VFS (deleted out from under this run) — nothing to commit, so
      // nothing to report as written either.
    } else if (!node) {
      const created = await overlay.create(dirId(cwd), name, 'file', content);
      idToName.set(created.id, name);
    }
    // A name colliding with an existing DIRECTORY node is silently
    // skipped — vfs.ts has no operation for "replace a directory with a
    // file," and a script naming its output identically to one of the
    // user's real subdirectories is an edge case not worth failing an
    // otherwise-successful run over.
  }

  const report = await overlay.commit();
  const failedIds = new Set(report.failed.map(f => (f.op.kind === 'create' ? f.op.tempId : f.op.id)));
  const written: string[] = [];
  const failed: string[] = [];
  for (const [id, name] of idToName) (failedIds.has(id) ? failed : written).push(name);
  return { written, failed };
}

/** Longest common prefix, so Tab can advance partway on an ambiguous match. */
export function commonPrefix(items: string[]): string {
  if (items.length === 0) return '';
  let prefix = items[0];
  for (const item of items.slice(1)) {
    while (!item.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix) break;
  }
  return prefix;
}

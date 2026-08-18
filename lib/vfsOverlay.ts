// A minimal copy-on-write staging layer over lib/vfs.ts.
//
// WHY THIS EXISTS: kernos.exec lets agent-written code call vfs.write and
// vfs.create, and until now those calls hit the user's real, durable files
// immediately — no relationship to whether the tool call as a whole
// succeeds. A `while (true) {}` that happens to call vfs.write once before
// the timeout kills it already left that write behind, durably, with no
// confirmation. This closes that for the one consumer that has it today.
//
// Not a general filesystem layer. Writes/creates land in an in-memory map,
// never in vfs.ts, until commit() is called — which only happens when the
// sandboxed run finishes with ok:true. Anything else (error, timeout,
// terminate()) calls discard() instead, and nothing durable ever changes.
// Reads and lists are answered by overlaying that map onto the real VFS, so
// code running inside one invocation sees its own writes immediately
// (read-your-writes) without those writes being durable yet.
//
// Two consumers today: kernos.exec directly, and the terminal's Python
// write-back path (lib/terminalFs.ts's writeBackFiles, called from
// apps/Terminal.tsx) — both stage through this one class rather than each
// inventing their own commit-or-discard logic.

import { vfs } from './vfs';
import { FileNode } from '../types';

type StagedWrite = { kind: 'write'; id: string; content: string };
type StagedCreate = {
  kind: 'create';
  tempId: string;
  /** May itself be a tempId, for a create nested under another staged create. */
  parentId: string;
  name: string;
  type: 'file' | 'directory';
  content: string;
};
type StagedOp = StagedWrite | StagedCreate;

export interface CommitReport {
  /** Number of staged ops that landed in the real VFS. */
  committed: number;
  /** Ops that didn't — either vfs itself rejected them, or their target was a tempId whose own create() already failed. */
  failed: { op: StagedOp; error: string }[];
}

let counter = 0;
const nextTempId = () => `staged:${Date.now()}:${counter++}`;

export class VfsOverlay {
  private ops: StagedOp[] = [];
  // Keyed by tempId for staged creates, or by the real id for a write
  // targeting a pre-existing node — either way, "what read()/list() should
  // see for this id right now, before commit."
  private staged = new Map<string, FileNode>();

  constructor(private userId: string) {}

  get hasPendingWrites(): boolean {
    return this.ops.length > 0;
  }

  async read(id: string): Promise<string> {
    const node = this.staged.get(id);
    if (node) return node.content ?? '';
    return vfs.read(id, this.userId);
  }

  async list(parentId: string): Promise<FileNode[]> {
    const real = await vfs.list(parentId, this.userId);
    // Only staged CREATES add a new listing entry. A staged write to a
    // pre-existing id doesn't change what's listed, only what read()
    // returns for it — real.list() already includes that node. (The
    // Supabase backend's list() never returns file content at all, only
    // metadata, so a listed-then-read-in-the-same-turn file already
    // depended on a follow-up read() before staging existed; this doesn't
    // make that any less fresh than it already was.)
    const stagedChildren = [...this.staged.values()].filter(n => n.parentId === parentId);
    return [...real, ...stagedChildren];
  }

  async write(id: string, content: string): Promise<boolean> {
    const existing = this.staged.get(id);
    if (!existing) {
      // Not something staged in this overlay yet, so it has to be a real,
      // already-existing node — otherwise there is nothing for this write
      // to land on. Checked now rather than deferred to commit(): a script
      // that thinks a write succeeded (because write() returned true) but
      // discovers otherwise only at commit time has no way to react — by
      // then the sandboxed run has already finished and reported ok:true.
      const isReal = await vfs.exists(id, this.userId);
      if (!isReal) return false;
    }
    this.staged.set(id, existing ? { ...existing, content } : { id, name: '', type: 'file', content });
    this.ops.push({ kind: 'write', id, content });
    return true;
  }

  async create(parentId: string, name: string, type: 'file' | 'directory', content = ''): Promise<FileNode> {
    const tempId = nextTempId();
    const node: FileNode = { id: tempId, name, type, content, parentId };
    this.staged.set(tempId, node);
    this.ops.push({ kind: 'create', tempId, parentId, name, type, content });
    return node;
  }

  /**
   * KNOWN LIMITATION, verified live rather than assumed away: a script's
   * own return value is captured by the worker BEFORE commit() runs (commit
   * happens in the host's finish() callback, after the worker has already
   * resolved). So `return node.id` from a create() hands the *caller* a
   * tempId, not the real durable id — correct within that one invocation
   * (every staged read/list/write against that tempId resolves correctly),
   * but a later, separate kernos.exec call cannot reuse that id string; it
   * has to look the file up again (by name, via list()) once it exists for
   * real. This doesn't create a safety gap — a stale tempId used elsewhere
   * just fails a lookup — but it is a real seam an agent's own code can hit.
   */

  /**
   * Replays every staged op through the real VFS, in call order — a create
   * always lands before anything staged as its child, and a write staged
   * after a create for the same tempId lands after it, so the final
   * content is whatever was written last, matching what the agent's script
   * actually did.
   *
   * Every op is attempted independently rather than aborting the whole
   * batch on the first failure — a script that wrote three unrelated files
   * shouldn't lose the two good writes because the third target was
   * deleted out from under it mid-run. Never throws: failures are
   * collected into the returned report instead, so a caller that doesn't
   * check it (writeBackFiles's bare `await overlay.commit()`) still gets a
   * fully-attempted commit rather than one silently truncated partway
   * through by an uncaught exception.
   */
  async commit(): Promise<CommitReport> {
    const idMap = new Map<string, string>(); // tempId -> real id, once created
    const deadTempIds = new Set<string>(); // tempIds whose own create() failed
    const failed: CommitReport['failed'] = [];
    let committed = 0;

    for (const op of this.ops) {
      if (op.kind === 'create') {
        if (deadTempIds.has(op.parentId)) {
          deadTempIds.add(op.tempId);
          failed.push({ op, error: `parent directory failed to commit` });
          continue;
        }
        const realParentId = idMap.get(op.parentId) ?? op.parentId;
        try {
          const node = await vfs.create(realParentId, op.name, op.type, this.userId, op.content);
          idMap.set(op.tempId, node.id);
          committed++;
        } catch (err: any) {
          deadTempIds.add(op.tempId);
          failed.push({ op, error: err?.message || String(err) });
        }
      } else {
        if (deadTempIds.has(op.id)) {
          failed.push({ op, error: `target failed to commit` });
          continue;
        }
        const realId = idMap.get(op.id) ?? op.id;
        try {
          const ok = await vfs.write(realId, op.content, this.userId);
          if (ok) committed++;
          else failed.push({ op, error: 'vfs.write rejected it' });
        } catch (err: any) {
          failed.push({ op, error: err?.message || String(err) });
        }
      }
    }

    return { committed, failed };
  }

  /** Nothing to undo — nothing staged here ever touched durable storage. */
  discard(): void {
    this.ops = [];
    this.staged.clear();
  }
}

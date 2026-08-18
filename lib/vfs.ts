// Virtual filesystem — used by FileSystem.tsx/Editor.tsx/CDE.tsx instead of
// round-tripping through the kernel bus, since there's no server to own a
// real filesystem. Dual-backend, same split as lib/chatStore.ts: guests get
// localStorage (this browser only), real accounts get Supabase's vfs_nodes
// table (see supabase/schema.sql) so files sync across devices.
//
// Every method takes a userId so the caller doesn't need to separately
// track which backend applies — the id's shape (see isGuestId) decides.
// The literal string 'home' is the shared root sentinel for both backends:
// the localStorage tree has always used it as a real node id, and for
// Supabase it maps to parent_id IS NULL (no actual 'home' row exists there).

import { FileNode } from '../types';
import { supabase, isSupabaseConfigured } from './supabaseClient';

const ROOT_SENTINEL = 'home';

function isGuestId(userId: string): boolean {
  return !isSupabaseConfigured || userId.startsWith('guest-') || userId === 'guest';
}

// ── localStorage backend (guests) ──────────────────────────────────────
// Logic unchanged from the original synchronous version — just wrapped to
// return Promises so callers have one uniform async interface regardless
// of backend. No per-user partitioning: there's only ever one active guest
// identity per browser, so a single shared tree is correct, same as before.

const STORAGE_KEY = 'kernos_vfs_v1';

interface VfsState {
  nodes: Record<string, FileNode>;
}

/** Aggregate counts for apps/SystemMetrics.tsx — cheaper and more accurate than having a caller recursively walk the tree via list(). */
export interface VfsStats {
  fileCount: number;
  dirCount: number;
  totalBytes: number;
}

function seedInitialState(): VfsState {
  const home: FileNode = { id: ROOT_SENTINEL, name: 'home', type: 'directory', children: [], parentId: null };
  return { nodes: { [ROOT_SENTINEL]: home } };
}

function readLocalState(): VfsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as VfsState;
      if (parsed.nodes?.[ROOT_SENTINEL]) return parsed;
    }
  } catch {
    // Corrupt or unavailable storage — fall through to a fresh state.
  }
  const initial = seedInitialState();
  writeLocalState(initial);
  return initial;
}

function writeLocalState(state: VfsState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full/unavailable — this write just won't persist.
  }
}

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const localBackend = {
  async list(parentId: string): Promise<FileNode[]> {
    const state = readLocalState();
    const parent = state.nodes[parentId];
    if (!parent?.children) return [];
    return parent.children.map(id => state.nodes[id]).filter((n): n is FileNode => !!n);
  },

  async read(id: string): Promise<string> {
    return readLocalState().nodes[id]?.content ?? '';
  },

  async exists(id: string): Promise<boolean> {
    return !!readLocalState().nodes[id];
  },

  async write(id: string, content: string, encoding?: 'base64'): Promise<boolean> {
    const state = readLocalState();
    if (!state.nodes[id]) return false;
    state.nodes[id] = { ...state.nodes[id], content, encoding };
    writeLocalState(state);
    return true;
  },

  async create(parentId: string, name: string, type: 'file' | 'directory', content = '', mountSource?: string, encoding?: 'base64'): Promise<FileNode> {
    const state = readLocalState();
    const parent = state.nodes[parentId] || state.nodes[ROOT_SENTINEL];
    const id = genId();
    const node: FileNode = {
      id,
      name,
      type,
      content: type === 'file' ? content : undefined,
      encoding: type === 'file' ? encoding : undefined,
      children: type === 'directory' ? [] : undefined,
      parentId: parent.id,
      mountSource,
    };
    state.nodes[id] = node;
    parent.children = [...(parent.children || []), id];
    state.nodes[parent.id] = parent;
    writeLocalState(state);
    return node;
  },

  async rename(id: string, newName: string): Promise<boolean> {
    const state = readLocalState();
    if (!state.nodes[id]) return false;
    state.nodes[id] = { ...state.nodes[id], name: newName };
    writeLocalState(state);
    return true;
  },

  async stat(): Promise<VfsStats> {
    const nodes = Object.values(readLocalState().nodes);
    let fileCount = 0;
    let dirCount = 0;
    let totalBytes = 0;
    for (const n of nodes) {
      if (n.id === ROOT_SENTINEL) continue; // the root itself isn't a user-created node
      if (n.type === 'directory') dirCount++;
      else {
        fileCount++;
        totalBytes += n.content?.length ?? 0;
      }
    }
    return { fileCount, dirCount, totalBytes };
  },

  async remove(id: string): Promise<boolean> {
    const state = readLocalState();
    const node = state.nodes[id];
    if (!node || id === ROOT_SENTINEL) return false;

    const toDelete = [id];
    while (toDelete.length) {
      const cur = toDelete.pop()!;
      const n = state.nodes[cur];
      if (n?.children) toDelete.push(...n.children);
      delete state.nodes[cur];
    }
    if (node.parentId && state.nodes[node.parentId]) {
      state.nodes[node.parentId] = {
        ...state.nodes[node.parentId],
        children: (state.nodes[node.parentId].children || []).filter(c => c !== id),
      };
    }
    writeLocalState(state);
    return true;
  },
};

// ── Supabase backend (real accounts) ────────────────────────────────────
// See supabase/schema.sql's vfs_nodes table. `children` isn't stored on
// the node itself here (unlike the localStorage version) — list() derives
// it by querying parent_id, the normalized way to represent a tree
// relationally; nothing in FileSystem.tsx/CDE.tsx reads FileNode.children
// directly, they only ever use vfs.list()'s return value, so this is a
// transparent swap.

function toParentId(id: string): string | null {
  return id === ROOT_SENTINEL ? null : id;
}

const supabaseBackend = {
  async list(parentId: string, userId: string): Promise<FileNode[]> {
    let query = supabase!.from('vfs_nodes').select('id,name,type,mount_source,encoding').eq('user_id', userId);
    const pid = toParentId(parentId);
    query = pid === null ? query.is('parent_id', null) : query.eq('parent_id', pid);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map(r => ({ id: r.id, name: r.name, type: r.type, mountSource: r.mount_source ?? undefined, encoding: r.encoding ?? undefined }));
  },

  async read(id: string, userId: string): Promise<string> {
    const { data, error } = await supabase!.from('vfs_nodes').select('content').eq('id', id).eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return data?.content ?? '';
  },

  async exists(id: string, userId: string): Promise<boolean> {
    const { data, error } = await supabase!.from('vfs_nodes').select('id').eq('id', id).eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return !!data;
  },

  async write(id: string, content: string, userId: string, encoding?: 'base64'): Promise<boolean> {
    const { error } = await supabase!
      .from('vfs_nodes')
      .update({ content, encoding: encoding ?? null, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);
    return !error;
  },

  async create(parentId: string, name: string, type: 'file' | 'directory', userId: string, content = '', mountSource?: string, encoding?: 'base64'): Promise<FileNode> {
    const { data, error } = await supabase!
      .from('vfs_nodes')
      .insert({ user_id: userId, parent_id: toParentId(parentId), name, type, content: type === 'file' ? content : null, mount_source: mountSource ?? null, encoding: type === 'file' ? (encoding ?? null) : null })
      .select('id,name,type,mount_source,encoding')
      .single();
    if (error) throw error;
    return { id: data.id, name: data.name, type: data.type, mountSource: data.mount_source ?? undefined, encoding: data.encoding ?? undefined };
  },

  async rename(id: string, newName: string, userId: string): Promise<boolean> {
    const { error } = await supabase!
      .from('vfs_nodes')
      .update({ name: newName, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);
    return !error;
  },

  async remove(id: string, userId: string): Promise<boolean> {
    if (id === ROOT_SENTINEL) return false;
    // Children cascade via vfs_nodes.parent_id's `on delete cascade`.
    const { error } = await supabase!.from('vfs_nodes').delete().eq('id', id).eq('user_id', userId);
    return !error;
  },

  // One query for the whole tree rather than a recursive per-directory
  // walk. It does pull `content` back to total the bytes, which supabase-js
  // can't sum server-side without a dedicated RPC — acceptable here because
  // this is one personal file tree, not a shared corpus, and the panel that
  // calls it refreshes on a slow interval.
  async stat(userId: string): Promise<VfsStats> {
    const { data, error } = await supabase!.from('vfs_nodes').select('type,content').eq('user_id', userId);
    if (error) throw error;
    let fileCount = 0;
    let dirCount = 0;
    let totalBytes = 0;
    for (const r of data ?? []) {
      if (r.type === 'directory') dirCount++;
      else {
        fileCount++;
        totalBytes += (r.content as string | null)?.length ?? 0;
      }
    }
    return { fileCount, dirCount, totalBytes };
  },
};

// ── File System Access mounts (desktop, optional, session-only) ──────────
// A "mount" (apps/FileSystem.tsx's "Mount folder" button, behind a
// showDirectoryPicker feature-detect) imports a real on-disk directory's
// files into the VFS once, tagged via mountSource, then registers the
// browser's live FileSystemFileHandle here so a later vfs.write() to one of
// those files also writes through to the real file on disk — from the
// Editor, from CDE, or from the terminal's `write`, since they all funnel
// through this one vfs.write(). Deliberately not persisted across reloads:
// FileSystemFileHandle isn't structured-cloneable into IndexedDB without
// the (still Chromium-only) storeable-handle permission dance, so a reload
// just leaves a plain imported copy behind — re-mounting is a re-pick, not
// a repair, and that's an intentional scope line, not an oversight.
const mountHandles = new Map<string, FileSystemFileHandle>();

export function registerMountHandle(fileId: string, handle: FileSystemFileHandle): void {
  mountHandles.set(fileId, handle);
}

async function writeThroughIfMounted(id: string, content: string): Promise<void> {
  const handle = mountHandles.get(id);
  if (!handle) return;
  try {
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  } catch {
    // Permission revoked, file moved/deleted on disk, etc. — the VFS copy
    // above already saved fine; the mount just stops tracking this file.
    mountHandles.delete(id);
  }
}

export const vfs = {
  list(parentId: string, userId: string): Promise<FileNode[]> {
    return (isGuestId(userId) ? localBackend.list(parentId) : supabaseBackend.list(parentId, userId));
  },
  read(id: string, userId: string): Promise<string> {
    return (isGuestId(userId) ? localBackend.read(id) : supabaseBackend.read(id, userId));
  },
  exists(id: string, userId: string): Promise<boolean> {
    return (isGuestId(userId) ? localBackend.exists(id) : supabaseBackend.exists(id, userId));
  },
  async write(id: string, content: string, userId: string, encoding?: 'base64'): Promise<boolean> {
    const wrote = await (isGuestId(userId) ? localBackend.write(id, content, encoding) : supabaseBackend.write(id, content, userId, encoding));
    // Binary content written through to a mounted on-disk file would need
    // decoding first (writeThroughIfMounted writes the string as-is) — no
    // caller mounts a directory and downloads into it today, so this is
    // simply skipped for encoded content rather than silently corrupting
    // the on-disk file with raw base64 text.
    if (wrote && !encoding) await writeThroughIfMounted(id, content);
    return wrote;
  },
  create(parentId: string, name: string, type: 'file' | 'directory', userId: string, content = '', mountSource?: string, encoding?: 'base64'): Promise<FileNode> {
    return (isGuestId(userId) ? localBackend.create(parentId, name, type, content, mountSource, encoding) : supabaseBackend.create(parentId, name, type, userId, content, mountSource, encoding));
  },
  rename(id: string, newName: string, userId: string): Promise<boolean> {
    return (isGuestId(userId) ? localBackend.rename(id, newName) : supabaseBackend.rename(id, newName, userId));
  },
  remove(id: string, userId: string): Promise<boolean> {
    return (isGuestId(userId) ? localBackend.remove(id) : supabaseBackend.remove(id, userId));
  },
  stat(userId: string): Promise<VfsStats> {
    return (isGuestId(userId) ? localBackend.stat() : supabaseBackend.stat(userId));
  },
};

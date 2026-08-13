// Client-side virtual filesystem — used directly by FileSystem.tsx/Editor.tsx
// instead of round-tripping through the kernel bus, since there's no server
// to own a real filesystem anymore. localStorage rather than IndexedDB:
// everything stored here is small text files, so the simpler synchronous
// API outweighs IndexedDB's extra capacity/async complexity for v1.

import { FileNode } from '../types';

const STORAGE_KEY = 'kernos_vfs_v1';

interface VfsState {
  nodes: Record<string, FileNode>;
}

function seedInitialState(): VfsState {
  const home: FileNode = { id: 'home', name: 'home', type: 'directory', children: [], parentId: null };
  return { nodes: { home } };
}

function readState(): VfsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as VfsState;
      if (parsed.nodes?.home) return parsed;
    }
  } catch {
    // Corrupt or unavailable storage — fall through to a fresh state.
  }
  const initial = seedInitialState();
  writeState(initial);
  return initial;
}

function writeState(state: VfsState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full/unavailable — this write just won't persist.
  }
}

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export const vfs = {
  list(parentId: string): FileNode[] {
    const state = readState();
    const parent = state.nodes[parentId];
    if (!parent?.children) return [];
    return parent.children.map(id => state.nodes[id]).filter((n): n is FileNode => !!n);
  },

  read(id: string): string {
    return readState().nodes[id]?.content ?? '';
  },

  write(id: string, content: string): boolean {
    const state = readState();
    if (!state.nodes[id]) return false;
    state.nodes[id] = { ...state.nodes[id], content };
    writeState(state);
    return true;
  },

  create(parentId: string, name: string, type: 'file' | 'directory', content = ''): FileNode {
    const state = readState();
    const parent = state.nodes[parentId] || state.nodes['home'];
    const id = genId();
    const node: FileNode = {
      id,
      name,
      type,
      content: type === 'file' ? content : undefined,
      children: type === 'directory' ? [] : undefined,
      parentId: parent.id,
    };
    state.nodes[id] = node;
    parent.children = [...(parent.children || []), id];
    state.nodes[parent.id] = parent;
    writeState(state);
    return node;
  },

  rename(id: string, newName: string): boolean {
    const state = readState();
    if (!state.nodes[id]) return false;
    state.nodes[id] = { ...state.nodes[id], name: newName };
    writeState(state);
    return true;
  },

  remove(id: string): boolean {
    const state = readState();
    const node = state.nodes[id];
    if (!node || id === 'home') return false;

    // Recursively drop any children before dropping the node itself.
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
    writeState(state);
    return true;
  },
};

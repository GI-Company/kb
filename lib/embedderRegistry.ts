// Named persistence for trained embedders, mirroring lib/classifierRegistry.ts
// (same IndexedDB-only, no-Supabase-sync precedent — see that file's header
// for why a model type with its own record shape gets its own store rather
// than being force-fit into lib/modelStore.ts's generative-model-shaped
// SavedModelRecord).

import { EmbedderConfig, ParaphrasePair } from './localEmbedder';

const DB_NAME = 'kernos-bnlm-embedders';
const DB_VERSION = 1;
const STORE = 'embedders';

export interface SavedEmbedderMeta {
  name: string;
  savedAt: string;
  paramCount: number;
  vocabSize: number;
  pairCount: number;
}

export interface SavedEmbedderRecord extends SavedEmbedderMeta {
  config: EmbedderConfig;
  /** itos.join('') — enough to rebuild an identical CharTokenizer. */
  vocabChars: string;
  /** Kept so a saved embedder can be inspected, extended, or retrained. */
  pairs: ParaphrasePair[];
  paramShapes: number[][];
  paramBuffers: ArrayBuffer[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export const embedderRegistry = {
  /** Metadata only — the parameter buffers stay on disk until a load. */
  async list(): Promise<SavedEmbedderMeta[]> {
    const records = await withStore<SavedEmbedderRecord[]>('readonly', store => store.getAll());
    return records
      .map(({ name, savedAt, paramCount, vocabSize, pairCount }) => ({ name, savedAt, paramCount, vocabSize, pairCount }))
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  },

  async save(record: SavedEmbedderRecord): Promise<void> {
    await withStore('readwrite', store => store.put(record));
  },

  async load(name: string): Promise<SavedEmbedderRecord | undefined> {
    return withStore<SavedEmbedderRecord | undefined>('readonly', store => store.get(name));
  },

  async remove(name: string): Promise<void> {
    await withStore('readwrite', store => store.delete(name));
  },
};

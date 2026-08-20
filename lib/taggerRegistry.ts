// Named persistence for trained taggers, mirroring lib/classifierRegistry.ts
// and lib/embedderRegistry.ts (same IndexedDB-only, no-Supabase-sync
// precedent — a tagged-example dataset doesn't fit lib/modelStore.ts's
// generative-model-shaped SavedModelRecord any better than a classifier's
// labeled examples or an embedder's paraphrase pairs do).

import { TaggerConfig, TaggedExample } from './localTagger';

const DB_NAME = 'kernos-bnlm-taggers';
const DB_VERSION = 1;
const STORE = 'taggers';

export interface SavedTaggerMeta {
  name: string;
  savedAt: string;
  tagLabels: string[];
  paramCount: number;
  vocabSize: number;
  exampleCount: number;
}

export interface SavedTaggerRecord extends SavedTaggerMeta {
  config: TaggerConfig;
  /** itos.join('') — enough to rebuild an identical CharTokenizer. */
  vocabChars: string;
  /** Kept so a saved tagger can be inspected, extended, or retrained. */
  examples: TaggedExample[];
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

export const taggerRegistry = {
  /** Metadata only — the parameter buffers stay on disk until a load. */
  async list(): Promise<SavedTaggerMeta[]> {
    const records = await withStore<SavedTaggerRecord[]>('readonly', store => store.getAll());
    return records
      .map(({ name, savedAt, tagLabels, paramCount, vocabSize, exampleCount }) => ({ name, savedAt, tagLabels, paramCount, vocabSize, exampleCount }))
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  },

  async save(record: SavedTaggerRecord): Promise<void> {
    await withStore('readwrite', store => store.put(record));
  },

  async load(name: string): Promise<SavedTaggerRecord | undefined> {
    return withStore<SavedTaggerRecord | undefined>('readonly', store => store.get(name));
  },

  async remove(name: string): Promise<void> {
    await withStore('readwrite', store => store.delete(name));
  },
};

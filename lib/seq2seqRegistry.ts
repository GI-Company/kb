// Named persistence for trained seq2seq models, mirroring
// lib/classifierRegistry.ts / lib/embedderRegistry.ts / lib/taggerRegistry.ts
// (same IndexedDB-only, no-Supabase-sync precedent — an (input, output)
// pair dataset doesn't fit lib/modelStore.ts's generative-model-shaped
// SavedModelRecord any better than the other three model types' own
// dataset shapes did).

import { Seq2SeqConfig, TransformPair } from './localSeq2Seq';

const DB_NAME = 'kernos-bnlm-seq2seq';
const DB_VERSION = 1;
const STORE = 'seq2seq';

export interface SavedSeq2SeqMeta {
  name: string;
  savedAt: string;
  paramCount: number;
  vocabSize: number;
  pairCount: number;
}

export interface SavedSeq2SeqRecord extends SavedSeq2SeqMeta {
  config: Seq2SeqConfig;
  /** itos.join('') — enough to rebuild an identical shared CharTokenizer. */
  vocabChars: string;
  /** Kept so a saved model can be inspected, extended, or retrained. */
  pairs: TransformPair[];
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

export const seq2seqRegistry = {
  /** Metadata only — the parameter buffers stay on disk until a load. */
  async list(): Promise<SavedSeq2SeqMeta[]> {
    const records = await withStore<SavedSeq2SeqRecord[]>('readonly', store => store.getAll());
    return records
      .map(({ name, savedAt, paramCount, vocabSize, pairCount }) => ({ name, savedAt, paramCount, vocabSize, pairCount }))
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  },

  async save(record: SavedSeq2SeqRecord): Promise<void> {
    await withStore('readwrite', store => store.put(record));
  },

  async load(name: string): Promise<SavedSeq2SeqRecord | undefined> {
    return withStore<SavedSeq2SeqRecord | undefined>('readonly', store => store.get(name));
  },

  async remove(name: string): Promise<void> {
    await withStore('readwrite', store => store.delete(name));
  },
};

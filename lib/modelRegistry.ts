// Named local-model persistence — makes trained BNLM models survive a
// reload instead of living only in the tab's memory ("first class citizens
// of the OS" means they need to outlive a single session). Uses IndexedDB
// rather than localStorage: model weights are binary and can run into the
// low-MB range even for these toy demo sizes, well past what's comfortable
// to base64-encode into a ~5MB localStorage quota — IndexedDB stores
// ArrayBuffers natively and has a much larger quota.

import { LocalModelConfig } from './localModel';

const DB_NAME = 'kernos-bnlm-models';
const DB_VERSION = 1;
const STORE = 'models';

export interface SavedModelMeta {
  name: string;
  savedAt: string;
  config: LocalModelConfig;
  vocabSize: number;
  paramCount: number;
}

export interface SavedModelRecord extends SavedModelMeta {
  vocabChars: string; // itos.join('') — enough to rebuild an identical CharTokenizer
  corpusText: string; // retained so training can resume after load
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

export const modelRegistry = {
  async list(): Promise<SavedModelMeta[]> {
    const records = await withStore<SavedModelRecord[]>('readonly', store => store.getAll());
    return records
      .map(({ name, savedAt, config, vocabSize, paramCount }) => ({ name, savedAt, config, vocabSize, paramCount }))
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  },

  async save(record: SavedModelRecord): Promise<void> {
    await withStore('readwrite', store => store.put(record));
  },

  async load(name: string): Promise<SavedModelRecord | undefined> {
    return withStore<SavedModelRecord | undefined>('readonly', store => store.get(name));
  },

  async remove(name: string): Promise<void> {
    await withStore('readwrite', store => store.delete(name));
  },
};

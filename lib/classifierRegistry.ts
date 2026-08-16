// Named persistence for trained classifiers, mirroring lib/modelRegistry.ts.
//
// A router you have to retrain on every reload isn't a tool — it's a demo.
// Training takes ~20 seconds and three Groq calls, so throwing that away
// when the tab closes discards the one thing that makes the local-specialist
// story work: that the cost is paid once and inference is then free.
//
// IndexedDB rather than localStorage for the same reason the generative
// registry uses it: parameters are binary Float32Arrays, and base64-ing
// them into a ~5MB quota is the wrong shape even at these small sizes.
//
// Deliberately separate from the generative model's store: the records have
// different shapes (labels and examples vs. a corpus), and a classifier
// named "router" should not collide with a generative model of the same
// name.

import { LabeledExample } from './localClassifier';

const DB_NAME = 'kernos-bnlm-classifiers';
const DB_VERSION = 1;
const STORE = 'classifiers';

export interface SavedClassifierMeta {
  name: string;
  savedAt: string;
  labels: string[];
  paramCount: number;
  vocabSize: number;
  exampleCount: number;
  /** Held-out accuracy at save time, when it was measured. */
  heldOutAccuracy?: number;
}

export interface SavedClassifierRecord extends SavedClassifierMeta {
  config: {
    dModel: number;
    numLayers: number;
    numHeads: number;
    contextLen: number;
    mixerType: 'attention' | 'linear' | 'rwkv';
    lr: number;
    batchSize: number;
  };
  /** itos.join('') — enough to rebuild an identical CharTokenizer. */
  vocabChars: string;
  /** Kept so a saved classifier can be inspected, extended, or retrained. */
  examples: LabeledExample[];
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

export const classifierRegistry = {
  /** Metadata only — the parameter buffers stay on disk until a load. */
  async list(): Promise<SavedClassifierMeta[]> {
    const records = await withStore<SavedClassifierRecord[]>('readonly', store => store.getAll());
    return records
      .map(({ name, savedAt, labels, paramCount, vocabSize, exampleCount, heldOutAccuracy }) =>
        ({ name, savedAt, labels, paramCount, vocabSize, exampleCount, heldOutAccuracy }))
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  },

  async save(record: SavedClassifierRecord): Promise<void> {
    await withStore('readwrite', store => store.put(record));
  },

  async load(name: string): Promise<SavedClassifierRecord | undefined> {
    return withStore<SavedClassifierRecord | undefined>('readonly', store => store.get(name));
  },

  async remove(name: string): Promise<void> {
    await withStore('readwrite', store => store.delete(name));
  },
};

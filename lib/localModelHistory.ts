// Run history + generation log — persisted across reloads, matching the
// original BNLM index.html's bnlm_runHistory/bnlm_genHistory localStorage
// schema (see BNLM-main/index.html's logRunResult/logGenResult). Auto-logged
// by lib/localModel.ts's train()/generate(), so both the standalone Local
// Model app and the AIChat tool-call path feed the same history.

export interface RunHistoryEntry {
  time: string;
  mixer: string;
  dModel: number;
  numLayers: number;
  numHeads: number;
  contextLen: number;
  params: number;
  totalSteps: number;
  finalLoss: number;
  durationSec: number;
}

export interface GenHistoryEntry {
  time: string;
  mixer: string;
  prompt: string;
  output: string;
}

const RUN_KEY = 'bnlm_runHistory';
const GEN_KEY = 'bnlm_genHistory';
const MAX_HISTORY = 100;

function loadJSON<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveJSON<T>(key: string, value: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full/unavailable — this entry just won't persist.
  }
}

function appendCapped<T>(key: string, entry: T): void {
  const all = loadJSON<T>(key);
  all.push(entry);
  saveJSON(key, all.length > MAX_HISTORY ? all.slice(-MAX_HISTORY) : all);
}

export const runHistoryStore = {
  list(): RunHistoryEntry[] {
    return loadJSON<RunHistoryEntry>(RUN_KEY).slice().reverse();
  },
  log(entry: RunHistoryEntry): void {
    appendCapped(RUN_KEY, entry);
  },
  clear(): void {
    saveJSON<RunHistoryEntry>(RUN_KEY, []);
  },
};

export const genHistoryStore = {
  list(): GenHistoryEntry[] {
    return loadJSON<GenHistoryEntry>(GEN_KEY).slice().reverse();
  },
  log(entry: GenHistoryEntry): void {
    appendCapped(GEN_KEY, entry);
  },
  clear(): void {
    saveJSON<GenHistoryEntry>(GEN_KEY, []);
  },
};

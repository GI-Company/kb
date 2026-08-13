// bpe_tokenizer.js
// Byte-Pair Encoding tokenizer for browser-lm.
//
// Drop-in replacement for CharTokenizer: same encode() / decode() / vocabSize
// API, so nothing in model.js, train.js, or the training loop needs to change
// except which class is instantiated.
//
// Two classes:
//   BPETrainer  - takes raw text, trains a BPE vocab via the merge loop
//   BPETokenizer - wraps a trained vocab, encodes/decodes text
//
// Training uses a fast-BPE data structure to avoid the naive O(n · merges)
// full rescan:
//   - Tokens are stored in a doubly-linked list so merge application is O(1)
//     per occurrence rather than O(n) array splice
//   - Pair frequencies are maintained in a Map<"a,b", count>
//   - A binary max-heap (BinaryHeap below) over the Map lets us find the
//     top pair in O(log k) instead of O(k) linear scan per merge step
//
// Byte-level fallback: the vocabulary starts with 256 byte tokens (U+0000..
// U+00FF), so encode() never throws -- any character not in the merge vocab
// is encoded as its UTF-8 byte sequence, each byte mapped to its byte token.
// This matches GPT-2's BPE approach and makes the tokenizer robust to any
// Unicode input, including emoji and non-BMP characters.

// ---------------------------------------------------------------------------
// Minimal binary max-heap keyed by an external score function.
// Used to efficiently find the highest-frequency merge pair each step.
// ---------------------------------------------------------------------------

class BinaryHeap {
  constructor() {
    this._data = []; // [{key, score}]
  }

  push(key, score) {
    this._data.push({ key, score });
    this._bubbleUp(this._data.length - 1);
  }

  pop() {
    const top = this._data[0];
    const last = this._data.pop();
    if (this._data.length > 0) {
      this._data[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  get size() { return this._data.length; }

  _bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._data[parent].score >= this._data[i].score) break;
      [this._data[parent], this._data[i]] = [this._data[i], this._data[parent]];
      i = parent;
    }
  }

  _sinkDown(i) {
    const n = this._data.length;
    while (true) {
      let best = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this._data[l].score > this._data[best].score) best = l;
      if (r < n && this._data[r].score > this._data[best].score) best = r;
      if (best === i) break;
      [this._data[best], this._data[i]] = [this._data[i], this._data[best]];
      i = best;
    }
  }
}

// ---------------------------------------------------------------------------
// BPETrainer
// ---------------------------------------------------------------------------

export class BPETrainer {
  /**
   * Train a BPE tokenizer on raw text.
   * @param {string} text - training corpus
   * @param {number} numMerges - number of merge operations (vocab size = 256 + numMerges)
   * @param {function} [onProgress] - optional callback(mergesCompleted, total)
   * @returns {{ vocab: string[], mergeTable: Array<[string,string]> }}
   */
  static train(text, numMerges, onProgress = null) {
    // --- Step 1: initialize vocab with 256 byte tokens ---
    const vocab = [];
    for (let i = 0; i < 256; i++) vocab.push(String.fromCharCode(i));

    // --- Step 2: encode training text as byte-level token ids ---
    const utf8Bytes = BPETrainer._textToUtf8Bytes(text);

    // Build a doubly-linked list for fast merge application.
    const nodes = new Array(utf8Bytes.length);
    for (let i = 0; i < utf8Bytes.length; i++) {
      nodes[i] = { id: utf8Bytes[i], prev: i - 1, next: i + 1 };
    }
    if (nodes.length > 0) nodes[nodes.length - 1].next = -1;

    // --- Step 3: count initial pair frequencies ---
    const pairFreq = new Map();
    for (let i = 0; i !== -1 && nodes[i].next !== -1; i = nodes[i].next) {
      const key = `${nodes[i].id},${nodes[nodes[i].next].id}`;
      pairFreq.set(key, (pairFreq.get(key) || 0) + 1);
    }

    let heap = new BinaryHeap();
    for (const [key, count] of pairFreq) heap.push(key, count);

    const mergeTable = [];

    // --- Step 4: merge loop ---
    for (let merge = 0; merge < numMerges; merge++) {
      // Find the best pair, skipping stale heap entries (lazy deletion).
      let best = null;
      while (heap.size > 0) {
        const top = heap.pop();
        const liveCount = pairFreq.get(top.key) || 0;
        if (top.score === liveCount && liveCount > 0) { best = top; break; }
      }
      if (!best) break;

      const parts = best.key.split(",");
      const aId = Number(parts[0]), bId = Number(parts[1]);
      const newId = vocab.length;
      vocab.push(vocab[aId] + vocab[bId]);
      mergeTable.push([vocab[aId], vocab[bId]]);

      // Apply merge: walk the list, replace all (aId, bId) pairs with newId,
      // updating pair frequencies incrementally.
      for (let i = 0; i !== -1; i = nodes[i].next) {
        if (nodes[i].id !== aId) continue;
        const j = nodes[i].next;
        if (j === -1 || nodes[j].id !== bId) continue;

        const p = nodes[i].prev;
        if (p !== -1) {
          const leftKey = `${nodes[p].id},${aId}`;
          const lf = (pairFreq.get(leftKey) || 0) - 1;
          if (lf <= 0) pairFreq.delete(leftKey); else { pairFreq.set(leftKey, lf); heap.push(leftKey, lf); }
          const newLeftKey = `${nodes[p].id},${newId}`;
          const nlf = (pairFreq.get(newLeftKey) || 0) + 1;
          pairFreq.set(newLeftKey, nlf);
          heap.push(newLeftKey, nlf);
        }

        const k = nodes[j].next;
        if (k !== -1) {
          const rightKey = `${bId},${nodes[k].id}`;
          const rf = (pairFreq.get(rightKey) || 0) - 1;
          if (rf <= 0) pairFreq.delete(rightKey); else { pairFreq.set(rightKey, rf); heap.push(rightKey, rf); }
          const newRightKey = `${newId},${nodes[k].id}`;
          const nrf = (pairFreq.get(newRightKey) || 0) + 1;
          pairFreq.set(newRightKey, nrf);
          heap.push(newRightKey, nrf);
        }

        const mergedKey = `${aId},${bId}`;
        const mf = (pairFreq.get(mergedKey) || 0) - 1;
        if (mf <= 0) pairFreq.delete(mergedKey); else pairFreq.set(mergedKey, mf);

        nodes[i].id = newId;
        nodes[i].next = k;
        if (k !== -1) nodes[k].prev = i;
      }

      if (onProgress) onProgress(merge + 1, numMerges);
    }

    return { vocab, mergeTable };
  }

  static _textToUtf8Bytes(text) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
    const buf = Buffer.from(text, "utf8");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
}

// ---------------------------------------------------------------------------
// BPETokenizer
// ---------------------------------------------------------------------------

export class BPETokenizer {
  /**
   * @param {string[]} vocab - token id -> string
   * @param {Array<[string,string]>} mergeTable - ordered merge rules
   */
  constructor(vocab, mergeTable) {
    this.vocab = vocab;
    this.mergeTable = mergeTable;
    this._tokenToId = new Map(vocab.map((s, i) => [s, i]));
    // Merge priority: "left\x00right" -> rank (lower = applied first)
    this._mergeRank = new Map(mergeTable.map(([l, r], rank) => [`${l}\x00${r}`, rank]));
  }

  get vocabSize() { return this.vocab.length; }

  /**
   * Encode text to token ids. Never throws -- any character maps through
   * its UTF-8 byte representation to byte tokens in the base vocab.
   */
  encode(text) {
    if (text.length === 0) return new Int32Array(0);
    const utf8Bytes = BPETrainer._textToUtf8Bytes(text);
    const tokens = Array.from(utf8Bytes);

    // Greedy merge: repeatedly find and apply the highest-priority (lowest rank)
    // adjacent pair until no more merges apply.
    let changed = true;
    while (changed) {
      changed = false;
      let bestRank = Infinity, bestIdx = -1;
      for (let i = 0; i < tokens.length - 1; i++) {
        const key = `${this.vocab[tokens[i]]}\x00${this.vocab[tokens[i + 1]]}`;
        const rank = this._mergeRank.get(key);
        if (rank !== undefined && rank < bestRank) { bestRank = rank; bestIdx = i; }
      }
      if (bestIdx !== -1) {
        const [l, r] = this.mergeTable[bestRank];
        tokens.splice(bestIdx, 2, this._tokenToId.get(l + r));
        changed = true;
      }
    }

    return Int32Array.from(tokens);
  }

  /**
   * Decode token ids back to a string. Concatenates token strings and
   * re-interprets byte tokens (ids 0-255) as UTF-8.
   */
  decode(ids) {
    const raw = Array.from(ids).map((id) => this.vocab[id] ?? "").join("");
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return Buffer.from(bytes).toString("utf-8");
  }

  /** Serialize to a plain object for localStorage persistence. */
  serialize() { return { vocab: this.vocab, mergeTable: this.mergeTable }; }

  /** Reconstruct from a serialized object. */
  static fromJSON(obj) { return new BPETokenizer(obj.vocab, obj.mergeTable); }
}

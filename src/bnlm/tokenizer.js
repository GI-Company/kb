// tokenizer.js
// Minimal character-level tokenizer. No external vocab file, no BPE training
// step -- the vocabulary is just the distinct characters seen in the corpus.
// Keeps the whole pipeline self-contained (browser-native, zero dependencies)
// at the cost of lower sample-efficiency per token than subword tokenization.
//
// BPETokenizer and BPETrainer are available from bpe_tokenizer.js (or via the
// re-exports below) for subword tokenization when sample efficiency matters.

export { BPETokenizer, BPETrainer } from "./bpe_tokenizer.js";

export class CharTokenizer {
  constructor(text) {
    const chars = Array.from(new Set(Array.from(text))).sort();
    this.itos = chars;
    this.stoi = new Map(chars.map((c, i) => [c, i]));
  }

  get vocabSize() {
    return this.itos.length;
  }

  encode(text) {
    // Use Array.from to iterate Unicode codepoints, matching the constructor
    // which also uses Array.from. Iterating by text[i] (UTF-16 code units)
    // would split surrogate pairs for emoji and non-BMP characters, producing
    // half-surrogates that don't exist in the vocabulary and throwing.
    const chars = Array.from(text);
    const out = new Int32Array(chars.length);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const id = this.stoi.get(ch);
      if (id === undefined) {
        throw new Error(`Character ${JSON.stringify(ch)} not in tokenizer vocabulary`);
      }
      out[i] = id;
    }
    return out;
  }

  decode(ids) {
    let out = "";
    for (const id of ids) out += this.itos[id];
    return out;
  }
}

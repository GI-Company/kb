// dataset.js
// Document-aware corpus handling -- the batching/chunking piece that matters
// once your corpus is a collection of many short, independent examples
// (like TinyStories: https://huggingface.co/datasets/roneneldan/TinyStories,
// often cited as a de facto minimal-model benchmark corpus precisely because
// it's simple enough for very small architectures to learn coherent output
// from) rather than one long continuous text.
//
// The original single-string sampleBatch (still in train.js, kept for
// backward compatibility / simple single-document corpora) picks a random
// window anywhere in the concatenated text -- which means a training example
// can span the boundary between the end of one story and the unrelated
// start of the next. That's a real correctness issue for a story-per-example
// dataset: the model is being asked to predict a token whose only sensible
// "context" is a different, unrelated story. splitDocuments + sampleDocBatch
// fix that by keeping every training window inside a single document.

/**
 * Split raw text into individual documents/stories.
 * Auto-detects the TinyStories-dump convention (`<|endoftext|>` between
 * stories); otherwise falls back to blank-line-separated paragraphs, which
 * is what the bundled example corpus (and most hand-pasted text) uses.
 */
export function splitDocuments(text, { delimiter } = {}) {
  let parts;
  if (delimiter) {
    parts = text.split(delimiter);
  } else if (text.includes("<|endoftext|>")) {
    parts = text.split("<|endoftext|>");
  } else {
    parts = text.split(/\n\s*\n+/);
  }
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Tokenize each document independently, dropping the (rare) empty result. */
export function tokenizeDocuments(documents, tokenizer) {
  return documents.map((doc) => tokenizer.encode(doc)).filter((ids) => ids.length > 0);
}

/**
 * Sample a batch of B random (input, target) windows of length T, each drawn
 * from a single randomly-chosen document -- never spanning a document
 * boundary. Only documents with length >= T+1 are eligible; throws a clear
 * error (rather than silently padding or crossing boundaries) if none
 * qualify, since that means contextLen needs to come down or the corpus
 * needs longer examples.
 */
export function sampleDocBatch(tokenizedDocs, B, T, rng = Math.random) {
  const eligible = tokenizedDocs.filter((d) => d.length >= T + 1);
  if (eligible.length === 0) {
    throw new Error(
      `No document is long enough for context length ${T} (need at least ${T + 1} characters). ` +
        `Lower the context length or use longer stories.`
    );
  }
  const input = new Int32Array(B * T);
  const target = new Int32Array(B * T);
  for (let b = 0; b < B; b++) {
    const doc = eligible[Math.floor(rng() * eligible.length)];
    const start = Math.floor(rng() * (doc.length - T - 1 + 1)); // inclusive range [0, doc.length-T-1]
    for (let t = 0; t < T; t++) {
      input[b * T + t] = doc[start + t];
      target[b * T + t] = doc[start + t + 1];
    }
  }
  return { input, target };
}

export function corpusStats(tokenizedDocs) {
  if (tokenizedDocs.length === 0) {
    return { numDocuments: 0, totalTokens: 0, minLength: 0, maxLength: 0, avgLength: 0 };
  }
  const lengths = tokenizedDocs.map((d) => d.length);
  const total = lengths.reduce((a, b) => a + b, 0);
  return {
    numDocuments: tokenizedDocs.length,
    totalTokens: total,
    minLength: Math.min(...lengths),
    maxLength: Math.max(...lengths),
    avgLength: total / tokenizedDocs.length,
  };
}

// Training-data generation via Groq. Used once, at training time; the
// models it produces then run with no cloud call at all.
//
// One mode per local model shape:
//   - prose      → corpus for the generative BNLM (next-token prediction)
//   - labeled    → {text, label} examples for the classifier
//   - pairs      → {a, b} paraphrase pairs for the embedder's contrastive loss
//   - tagged     → {text, tags[]} per-character labels for the tagger
//
// WHY THE LABELED PROMPT IS SO INSISTENT ABOUT VARIETY:
//
// The first classifier trained here reached 99.5% confidence routing
// "download that site" to `network` — and occlusion attribution showed the
// entire decision rested on the word "that", not on "download" or "site".
// The training set had been generated combinatorially (verb x object x
// suffix), so "that site" became a reliable shortcut. The model learned the
// scaffolding instead of the meaning, and no accuracy metric revealed it:
// the held-out split came from the same templates, so it scored well too.
//
// That failure is a property of the DATA, not the architecture. So the
// prompt below spends most of its length forbidding the thing that caused
// it — repeated sentence frames, a fixed slot order, uniform length. A
// generator that produces tidy uniform examples is worse than useless here,
// because it produces models that look good and break on contact.

import { fetchGroqText } from './groqFetch';
import { LabeledExample } from './localClassifier';
import { ParaphrasePair } from './localEmbedder';
import { TaggedExample } from './localTagger';

export type DatasetMode = 'prose' | 'labeled' | 'pairs' | 'tagged';

/** Prose corpus for the generative model — blank-line-separated documents. */
export async function generateProseCorpus(topic: string, count: number): Promise<string> {
  return fetchGroqText(
    'agent-chat',
    `Generate exactly ${count} short children's stories in the TinyStories style ` +
    `(simple sentences, small vocabulary, 4-8 sentences each) about: ${topic}. ` +
    `Separate each story with a single blank line. Output ONLY the stories themselves — ` +
    `no titles, no numbering, no markdown formatting, no commentary before or after.`
  );
}

/**
 * Paraphrase pairs for the embedder's contrastive loss — two sentences that
 * mean the same thing but don't share a sentence frame. Same insistence on
 * variety as generateLabeledExamples and for the same reason: a pair like
 * ("I like cats" / "I like cats a lot") teaches the model to key on
 * near-identical surface text rather than actual meaning, which defeats the
 * point of training an embedder at all — it would just relearn edit
 * distance.
 */
export async function generateParaphrasePairs(topic: string, count: number): Promise<ParaphrasePair[]> {
  const text = await fetchGroqText(
    'agent-chat',
    `Generate exactly ${count} pairs of sentences about: ${topic}. Each pair must be two ` +
    `DIFFERENT ways of saying the same thing — same meaning, different wording, different ` +
    `sentence structure, different vocabulary where possible. Do NOT just add or remove a ` +
    `word from one sentence to make the other; rewrite it as a different person would say it.\n\n` +
    `Format — one pair per line, nothing else:\n` +
    `first version | second version\n\n` +
    `Vary sentence length and structure across pairs so no two lines look alike. ` +
    `Write only the data lines. No headers, no numbering, no commentary.`
  );
  return parseParaphrasePairs(text);
}

/**
 * Tolerant parser for the `a | b` pair format — same reasoning as
 * parseLabeledExamples: LLM output reliably includes stray headers or
 * numbering, and losing a few lines matters far less than losing the batch.
 */
export function parseParaphrasePairs(raw: string): ParaphrasePair[] {
  const out: ParaphrasePair[] = [];
  const seen = new Set<string>();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const sep = trimmed.indexOf('|');
    if (sep === -1) continue;

    const a = trimmed.slice(0, sep).replace(/^[\s\-*>\d.)\]]+/, '').replace(/[*_`]/g, '').trim();
    const b = trimmed.slice(sep + 1).replace(/[*_`]/g, '').trim();
    if (!a || !b) continue;

    const key = `${a.toLowerCase()}|${b.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ a, b });
  }

  return out;
}

/**
 * Labeled examples for the classifier, one per line as `label | text`.
 *
 * A line format rather than JSON on purpose: a model that drops one brace
 * ruins an entire JSON array, whereas one malformed line here is skipped
 * and the rest of the set survives (see parseLabeledExamples).
 */
export async function generateLabeledExamples(
  labels: string[],
  perLabel: number,
  domain: string
): Promise<LabeledExample[]> {
  if (labels.length < 2) {
    throw new Error('A classifier needs at least 2 labels to have something to decide between.');
  }

  // One request PER LABEL rather than one for all of them. Asking for every
  // label at once produced badly skewed output in practice — a request for
  // 50 each came back 82/107/237, and the resulting classifier favored the
  // over-represented label and keyed on stopwords. Per-label calls make the
  // count controllable and let each call keep its attention on one intent.
  // Costs N requests instead of 1, which is the right trade for data that
  // decides how every later inference behaves.
  const batches = await Promise.all(
    labels.map(async label => {
      const others = labels.filter(l => l !== label);
      const text = await fetchGroqText(
        'agent-chat',
        `Generate training data for a text classifier in this domain: ${domain}

Produce exactly ${perLabel} examples for the label "${label}" and NOTHING else.
The other labels in this classifier are: ${others.join(', ')} — do not produce
examples for those, but make sure yours could not be confused with them.

Format — one example per line, nothing else:
${label} | example text

CRITICAL — the examples must be linguistically varied, or the classifier
will learn the template instead of the meaning:
- Do NOT reuse a sentence frame. Every line should be phrased differently.
- Vary length: some 2 words, some 15. Do not make them uniform.
- Vary grammatical form: commands, questions, statements, fragments.
- Vary vocabulary: use many different verbs and nouns for the same intent,
  including informal and abbreviated ways real people type.
- Do NOT append the same trailing words (like "please" or "now") to many lines.
- Do NOT start many lines with the same word.
- Put the meaningful word in different positions across examples, so that
  common words like "the", "my" or "for" cannot be used to tell labels apart.

Write only the data lines. No headers, no numbering, no commentary.`
      );
      // Parse against the single expected label so a stray line naming a
      // different one is dropped rather than skewing the balance.
      return parseLabeledExamples(text, [label]);
    })
  );

  // Trim every label to the smallest yield so the set stays balanced even
  // when one call over-produces. describeDataset warns about imbalance, but
  // not creating it is better than reporting it.
  const nonEmpty = batches.filter(b => b.length > 0);
  if (nonEmpty.length < labels.length) {
    const missing = labels.filter((l, i) => batches[i].length === 0);
    throw new Error(`No usable examples came back for: ${missing.join(', ')}. Try rewording the domain.`);
  }
  const perLabelCap = Math.min(...nonEmpty.map(b => b.length));
  return nonEmpty.flatMap(b => b.slice(0, perLabelCap));
}

/**
 * Tolerant parser for the `label | text` line format. Skips anything it
 * can't read rather than failing the batch: LLM output reliably includes
 * stray headers, numbering, or blank lines, and losing a few lines matters
 * far less than losing the whole set.
 *
 * Label matching is case-insensitive and tolerates surrounding markdown,
 * but an unrecognized label is dropped — silently relabeling to a "close"
 * match would inject wrong labels, which is worse than a smaller dataset.
 */
export function parseLabeledExamples(raw: string, labels: string[]): LabeledExample[] {
  const canonical = new Map(labels.map(l => [l.toLowerCase(), l]));
  const out: LabeledExample[] = [];
  const seen = new Set<string>();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const sep = trimmed.indexOf('|');
    if (sep === -1) continue;

    // Strip list markers/numbering and markdown emphasis from the label side.
    const rawLabel = trimmed
      .slice(0, sep)
      .replace(/^[\s\-*>\d.)\]]+/, '')
      .replace(/[*_`]/g, '')
      .trim()
      .toLowerCase();

    const label = canonical.get(rawLabel);
    if (!label) continue;

    const text = trimmed.slice(sep + 1).replace(/[*_`]/g, '').trim();
    if (!text) continue;

    // Duplicates inflate apparent dataset size while adding no signal, and
    // bias training toward whatever got repeated.
    const key = `${label} ${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ text, label });
  }

  return out;
}

/**
 * How balanced and varied a labeled set is. Worth showing before training,
 * because both failure modes here are invisible in the training accuracy
 * that comes out the other end.
 */
export function describeDataset(examples: LabeledExample[]): {
  total: number;
  perLabel: Record<string, number>;
  distinctOpeners: number;
  /** Share of examples beginning with the single most common word. */
  topOpenerShare: number;
  warnings: string[];
} {
  const perLabel: Record<string, number> = {};
  for (const e of examples) perLabel[e.label] = (perLabel[e.label] || 0) + 1;

  const counts = Object.values(perLabel);
  const warnings: string[] = [];

  // Opening-word distribution as a cheap proxy for "was one frame reused".
  // Deliberately NOT distinct/total: that ratio falls as a dataset grows
  // even when diversity is unchanged, so it would flag a large healthy set
  // (20 distinct openers over 240 examples scores 0.08) while passing a
  // tiny uniform one. Share-of-the-most-common is scale-invariant.
  const openerCounts = new Map<string, number>();
  for (const e of examples) {
    const w = e.text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    openerCounts.set(w, (openerCounts.get(w) || 0) + 1);
  }
  const distinctOpeners = openerCounts.size;
  const topOpenerShare = examples.length
    ? Math.max(...openerCounts.values()) / examples.length
    : 0;

  if (counts.length > 0 && Math.max(...counts) > Math.min(...counts) * 2) {
    warnings.push('Labels are imbalanced — the classifier will favor the larger ones.');
  }
  if (examples.length < 100) {
    warnings.push(`Only ${examples.length} examples. Expect memorization rather than generalization below a few hundred.`);
  }
  if (examples.length > 20 && (topOpenerShare > 0.4 || distinctOpeners < 5)) {
    warnings.push('Examples mostly start the same way — the model may key on the shared frame instead of the meaning.');
  }

  // Worth being straight about the limits of this check: it catches gross
  // template reuse, not subtle shortcuts. A set built from varied verbs but
  // a repeated object phrase looked healthy by every one of these numbers,
  // and the model still keyed on a stopword — only occlusion attribution
  // (localClassifier.explain) surfaced that. Treat a clean report as "no
  // obvious problem", not "the data is good".
  return { total: examples.length, perLabel, distinctOpeners, topOpenerShare, warnings };
}

/**
 * Tagged examples for the per-character tagger, generated as prose with
 * inline markup rather than raw index arrays or parallel tag strings — an
 * LLM reproduces `[tag]...[/tag]` far more reliably than it keeps a
 * character-index array in sync with text it's simultaneously writing.
 * Everything outside a markup span is `defaultTag`; a sentence can contain
 * zero, one, or several tagged spans, and tags must not nest.
 */
export async function generateTaggedExamples(
  tags: string[],
  defaultTag: string,
  domain: string,
  count = 20
): Promise<TaggedExample[]> {
  if (tags.length === 0) {
    throw new Error('generateTaggedExamples needs at least one tag to mark up.');
  }
  const text = await fetchGroqText(
    'agent-chat',
    `Generate exactly ${count} short example sentences about: ${domain}.

Wrap any text that should be tagged with one of these tags in markup, like
[tagname]the relevant words[/tagname]:
${tags.map(t => `- ${t}`).join('\n')}

Leave everything else unmarked — it is implicitly "${defaultTag}". Not every
sentence needs a tag; a sentence may contain zero, one, or several tagged
spans, of different tags. Do NOT nest tags inside each other. Do NOT reuse
the same sentence structure — vary length, phrasing, and where the tagged
span falls in the sentence.

Write only the sentences, one per line, with the [tagname]...[/tagname]
markup inline. No headers, no numbering, no commentary, no markdown.`
  );
  return parseTaggedText(text, tags, defaultTag);
}

/**
 * Tolerant parser for the inline `[tag]...[/tag]` markup format. A line with
 * no markup at all is still valid data — every character is defaultTag. A
 * span naming an unrecognized tag has its markup stripped and its text
 * folded into defaultTag rather than being dropped: the surrounding
 * sentence is still real training signal even if one span's tag name came
 * back malformed.
 */
export function parseTaggedText(raw: string, tags: string[], defaultTag: string): TaggedExample[] {
  const canonical = new Map(tags.map(t => [t.toLowerCase(), t]));
  const out: TaggedExample[] = [];
  const spanRe = /\[(\w+)\]([\s\S]*?)\[\/\1\]/g;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim().replace(/^[\s\-*>\d.)\]]+/, '');
    if (!line) continue;

    let text = '';
    const charTags: string[] = [];
    let lastIndex = 0;
    spanRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = spanRe.exec(line))) {
      for (const ch of line.slice(lastIndex, match.index)) { text += ch; charTags.push(defaultTag); }
      const resolved = canonical.get(match[1].toLowerCase()) ?? defaultTag;
      for (const ch of match[2]) { text += ch; charTags.push(resolved); }
      lastIndex = spanRe.lastIndex;
    }
    for (const ch of line.slice(lastIndex)) { text += ch; charTags.push(defaultTag); }

    if (text.trim()) out.push({ text, tags: charTags });
  }

  return out;
}

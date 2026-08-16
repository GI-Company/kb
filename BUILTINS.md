# Builtins v1 — the intelligence commands

A spec for five commands: `classify`, `explain`, `embed`, `similar`, `trace`.

The premise is that this environment's coreutils are not `/bin`. The machine
is a tab with a persistent filesystem, a local model, agents, and an
optional network — so the primitives should be classification, attribution,
retrieval and provenance, sitting in the same pipe as `grep`.

This document specifies argv, stdout, exit codes and capabilities for each,
and records what already exists versus what has to be built. Two
cross-cutting decisions come first, because four of the five depend on them.

---

## Decision 1 — records are NDJSON

Structured data between smart commands, without abandoning text.

One JSON object per line. Nothing else changes: the pipeline stays
`string → string`, every existing filter keeps working, and `classify … |
grep purchase` still does the obvious thing because NDJSON *is* text.

```
$ classify "refund my order" --json
{"text":"refund my order","label":"billing","confidence":0.94,"margin":0.71}
```

Two conventions make this composable rather than merely structured:

- **Human output by default, records on `--json`.** A terminal is read by a
  person first. `classify x` prints a sentence; `classify x --json` prints a
  record. Never both.
- **Record-aware commands accept records or text on stdin.** If a line
  parses as JSON with a `text` field, use it; otherwise treat the line as
  the text. That single rule is what lets `ls | classify` and
  `embed *.md | similar …` work without a type system.

Rejected: a real object pipe (structured values passed between stages
in-process). It is cleaner in principle and it breaks `grep`, redirection,
`>` into a file, and every filter already written. NDJSON keeps one wire
format for humans, filters, and files.

`pick` and `where` are the field-aware filters that make this convention pay
off, and they ship alongside these commands:

```
pick <path> [path...]     one path emits bare values; several emit a record
where <path> <op> <value> ops: = != > < >= <= ~     exits 1 on no match
```

Paths are dotted, with an optional leading dot and numeric array indices:
`.label`, `confidence`, `.ranked.0.label`.

They exist because `grep` matches the line, not the field. `classify --json |
grep network` returns a record labelled `model` whose `ranked` array merely
mentions network — correct grep behaviour, wrong answer to the question
being asked. `where .label = network` asks the real question.

## Decision 2 — capabilities are declared, not assumed

Every builtin declares what it needs. This already exists implicitly, spread
across four sets in two files (`VFS_COMMANDS`, `PIPE_AWARE_COMMANDS`,
`PYTHON_COMMANDS`, `MUTATING_COMMANDS`, plus `NETWORK_COMMANDS` server-side).
v1 makes it one table.

| Capability | Meaning | Gate today |
|---|---|---|
| `vfs` | Reads or writes the user's files | none |
| `vfs:write` | Mutates them | staged for NL translations |
| `model:local` | Runs BNLM in-tab | none |
| `model:cloud` | Calls Groq via `/api/chat` | rate limit |
| `python` | Boots Pyodide | signed-in |
| `net` | Leaves the origin | signed-in + SSRF guard |
| `exec` | Runs in the server's disposable per-request jail | rate limit |

`exec` was added while building `can`/`policy`, not designed up front: the
~27 coreutils in `api/exec.ts`'s allowlist (`ls`, `wc`, `date`, ...) didn't
fit any of the other six. They're the opposite of `vfs` in the property
that matters most — nothing they touch persists, and they never see the
user's real files — so folding them into `vfs` would have been the same
kind of lie a stale capability table is meant to prevent.

This is what makes `can classify` and `policy` answerable, and it is the
honest version of "root": not a privilege level, a declared surface.

---

## `classify` — label text with the local classifier

```
classify <text>                     classify a string
classify -f <file>                  classify a file's contents
<stdin>                             classify each line
  --json                            NDJSON records instead of prose
  --model <name>                    a saved classifier (default: the loaded one)
  --field <key>                     with record input, classify that key
```

**Capabilities:** `model:local`, plus `vfs` with `-f`.

Human output states the decision, the runner-up, and whether it is close —
because a confident wrong answer is the failure mode that matters for a
router:

```
$ classify "refund my order"
billing (94.2%), ahead of support (23.1%). Clear separation.
```

Record output:

```json
{"text":"refund my order","label":"billing","confidence":0.942,
 "margin":0.711,"ranked":[{"label":"billing","probability":0.942}, …]}
```

**Exit codes:** `0` classified. `1` no classifier loaded — the message must
name the fix (`train`, or `--model <name>`), since "no classifier" is the
expected state on a fresh tab, not an error. `2` bad usage.

**Status: mostly exists.** `localClassifier.predict()` already returns
`label`, `confidence`, `ranked`, `logits`, `pooledNorm`, `margin` and a
prose `explanation`. This command is largely argv parsing and output
shaping over an API that is already the right shape.

## `explain` — why the classifier said that

```
explain                             explain the last classify
explain <text>                      classify and explain in one step
  --for <label>                     attribute toward a label, not the winner
  --granularity word|char           default word
  --json
```

**Capabilities:** `model:local`.

```
$ explain
billing (94.2%) — removing each word and re-running:

  refund   ▇▇▇▇▇▇▇▇▇▇  +0.42
  my       ▇            +0.03
  order    ▇▇▇▇         +0.16

Baseline 0.942. Positive = removing it dropped the answer, so it was
holding the prediction up.
```

This is occlusion — a real counterfactual, not a similarity heuristic. Two
measured facts constrain it and belong in the help text:

- **Word granularity is the default and must stay so.** Character-level
  occlusion measured 0.000–0.002 across the board on a 99.6%-confidence
  call: deleting one letter leaves the word legible and the model shrugs.
  Word removal gave ~580× the signal. `--granularity char` stays available
  and stays documented as usually useless.
- **Cost is one forward pass per unit.** `classify` stays single-pass; only
  asking why pays for this. Do not fold it into `classify --verbose`.

**"Last classify" is session state**, held in memory for the tab. Not
persisted — a `explain` after a reload should say so plainly rather than
explaining a stale decision.

**Status: exists.** `localClassifier.explain()` returns
`{label, baseline, contributions:[{token,index,score}]}`. The work is the
bar chart and the argv.

## `embed` — vectors from local text

```
embed <file>...                     embed files
<stdin>                             embed each line/record
  --store <name>                    write into a named local index
  --json                            emit vectors as records
```

**Capabilities:** `model:local`, `vfs`.

**Status: the vector is nearly free; the meaning is not.**

Mechanically this is cheap. `BNLM.encode()` is public and returns hidden
states; `classifier.js` already computes the pooled vector on every
`predict()` and currently throws it away, keeping only its L2 norm. Exposing
it is a few lines.

**The problem is what that vector means, and it is a product risk, not a
technical one.** The trunk is a character-level model whose classifier
default is `dModel 24, 1 layer, linear mixer, contextLen 96` — deliberately
tiny, because 102k params overfit 24 examples to 33% held-out accuracy.
Pooling its last hidden state gives a representation of *surface form*.
Cosine over it will behave like a fuzzy string matcher, not a semantic
index.

Shipping that as an embedding invites exactly the failure this codebase has
spent its last three commits removing: a confident, plausible, wrong answer.

**Resolved: deferred, and not shipping under these names until measured.**
`similar` and `embed` claim semantics this trunk does not have. If a
precision@k check shows retrieval is lexical — which is the expectation —
the honest names are `match` and `index`. A pooled-vector dump may ship
earlier as `embed --raw`, explicitly a debug view of the representation and
not marketed as search. Groq embeddings are not an option for this path;
that would trade the flagship local-first primitive for a network call.

The reasoning behind that, kept because the decision should be re-derivable:

Measure before naming. Build a small labelled retrieval set from the VFS,
run the pooled vector against it, and report precision@k the way
`npm run eval:shell` reports translation accuracy. Name the command from the
result. Shipping the names first and discovering the behaviour later is how
"looks smart, is wrong" gets into a product — one layer above where the
`sort -n` and `head -2` bugs lived, and correspondingly harder to notice.

## `similar` — retrieve over an index

```
similar <query>                     rank against the default store
  --store <name>
  --top <n>                         default 5
  --json
```

**Capabilities:** `model:local`, `vfs`.

**Status: deferred with `embed`, and not shipping under this name.** The
design below is recorded so the work is ready when the measurement is.

The store itself is straightforward and does not exist yet: name → array of
`{path, chunk, vector}`, in IndexedDB for guests and a Supabase table for
accounts, following the split `lib/vfs.ts` already uses. Brute-force cosine
is correct at this scale; a VFS with 10k chunks is a rounding error against
one BNLM forward pass. No ANN index in v1.

Output carries the score, always, because a top-5 list with no scores hides
whether the best match was good or merely least bad:

```
$ similar "billing disputes" --top 3
0.81  notes/support.md:12   "refunds and chargebacks are handled by…"
0.44  notes/roadmap.md:3    "billing integration lands in Q3"
0.12  README.md:1           "Kernos is a browser-native…"
```

A large gap between #1 and #2 means something. A flat distribution near 0.4
means the index found nothing and is padding — say so in the output rather
than printing five rows and letting the user infer confidence from position.

## `trace` — what the machine just did

```
trace                               recent bus activity
  --topic <pattern>                 filter by envelope topic
  --last <n>                        default 20
  --json
```

**Capabilities:** none. This is the glass box; it must never be gated.

```
$ trace --last 5
12:04:31  vm.spawn        terminal → kernel     whoami
12:04:31  vm.stdout       kernel → terminal     14 bytes
12:04:33  sys.terminal.intent  terminal → kernel  "count the lines"
12:04:34  agent.chat      → agent-shell        llama-3.3-70b-versatile
12:04:35  sys.terminal.intent:ack  kernel → terminal  wc -l notes.md
```

**Status: exists.** `kernel.getTrafficLog()` returns the last 200 envelopes,
newest first, and `route()` was fixed earlier to notify subscribers of
outgoing envelopes too — so requests are visible, not just responses. This
is formatting.

One deliberate scope limit: `trace` shows the *bus*. Model-internal
reasoning (why the classifier picked a label, why an agent chose a tool)
belongs to `explain` and to the agents' own `<reasoning>` blocks. Merging
them produces a log nobody reads.

---

## Build order

Ordered by trust earned per unit of work, not by how new each one feels.

| | Command | Effort | Why here |
|---|---|---|---|
| 1 | `trace` | small | Pure formatting over an existing log. Ungated, and it makes everything after it debuggable. |
| 2 | `classify` | small | The service API already returns the right shape. |
| 3 | `explain` | small | Same, plus a bar chart. Ships with `classify` or immediately after. |
| 4 | NDJSON `--json` + `pick`/`where` | medium | Turns three commands into a composable set. Worth doing before adding more commands, not after. |
| 5 | `embed` / `similar` | medium + open question | Blocked on measurement, not on code. See above. |

`classify` and `explain` are the pair that demonstrate the thesis: a
labelling primitive that can be interrogated. Neither needs the network,
both run on the user's own trained model, and the second one exists purely
so the first can be doubted. That is the argument for this whole vocabulary
in two commands, and it is roughly a day of work because the hard parts —
occlusion attribution, last-token pooling, the trained classifier — are
already written and measured.

---

## v1.1 — teaching the specialist (shipped)

The point of a local classifier is not that it is good on day one. It is
that it is cheap, inspectable, and *correctable* — so the head of the
distribution moves in-tab over time while the cloud handles the tail.

The loop, once `classify` and `explain` exist:

```
classify "download the quarterly report"
  → network (61%), narrowly ahead of files (54%). Narrow margin.
explain
  → "download" carries it (+0.31); "report" pushes toward files (-0.12)
correct files                    # or: classify --teach files
  → recorded. 43 corrections held.
train --from-corrections
  → retrained on 24 seed + 43 corrected examples. Held-out 91.7% (was 87.5%).
```

Four constraints on doing this honestly, which is the whole difficulty:

- **Train on confirmed labels only.** Never on the model's own high-confidence
  guesses. Self-training at this scale amplifies whatever bias the seed set
  had, and the glass box will happily explain a decision that is confidently
  wrong for a reason the corrections taught it.
- **Corrections are data, and belong in the VFS.** A file the user can read,
  `cat`, edit and delete — not opaque IndexedDB state. Provenance for free,
  and a bad correction is fixable with the tools already in the shell.
- **Report held-out accuracy after every retrain, against a split the
  corrections did not touch.** Otherwise "it improved" means "it memorised".
  The service already returns this from `evaluate()`.
- **Route on margin, not on confidence.** High confidence with a narrow
  margin is the borderline case — that is exactly when to fall back to Groq
  or ask, and exactly the case worth capturing as a correction.

What this is not: online learning per keystroke (unstable at this size), and
not an argument that Groq stops being needed. Groq bootstraps the dataset,
handles the long tail, and is the fallback when the margin is thin. The
local model absorbs the routine head of the distribution, which is where the
per-call cost actually lives.


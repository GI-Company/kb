# Architecture

This document maps what's actually running today, and where each piece came from. The original Kernos OS was a Go microkernel behind a React shell; the original BNLM was a standalone static site. This app is the React shell, kept, retargeted at a stateless serverless backend, with BNLM's engine vendored in as a library the shell can drive.

```
┌────────────────────────────────────────────────────────────────────┐
│  BROWSER (the whole "OS")                                          │
│  App.tsx / store.ts — window manager, taskbar, desktop, mobile     │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐ ┌───────────────────┐    │
│  │ AI Chat  │ │ Terminal │ │ Local Model│ │ Editor / Files /  │    │
│  │ + Multi- │ │          │ │ (BNLM)     │ │ CDE / Monitors    │    │
│  │  Agent   │ │          │ │            │ │                   │    │
│  └────┬─────┘ └────┬─────┘ └─────┬──────┘ └─────────┬─────────┘    │
│       │            │             │                  │              │
│       └──────┬─────┴──────┬──────┘        lib/vfs.ts, chatStore.ts │
│              │            │               lib/settings.ts (prefs)  │
│     services/kernel.ts (client-side pub/sub bus + fetch adapter)   │
│              │            │                                        │
│    lib/localModel.ts ─────┼── src/bnlm/* (Tensor/BNLM/Adam/        │
│    lib/modelRegistry.ts   │   CharTokenizer/worker_pool, all       │
│    (IndexedDB)            │   running in this tab, no network)     │
│                           │                                        │
│    lib/appletCompiler.ts (Sucrase, in-browser TSX→JS)              │
│      ├── DynamicApplet.tsx  (human-authored applets, shadow DOM)   │
│      └── lib/kernosExec.ts  (agent-authored code, sandboxed)       │
│                                                                    │
│    lib/terminalFs.ts / terminalPipeline.ts — ls/cd/cat/pipes/      │
│      redirects, resolved client-side against the VFS               │
│    lib/pythonRuntime.ts → python.worker.ts (Pyodide, CPython in    │
│      WASM; signed-in only, lazy, self-hosted from public/pyodide)  │
└──────────┬──────────┬──────────┬───────────────┬───────────────────┘
           ▼          ▼          ▼               ▼
    /api/chat   /api/exec  /api/browser-  /api/guest-usage
    (Edge)      (Node)      render (Node)  (Node)
           │          │          │               │
           ▼          ▼          ▼               ▼
      Groq Chat  child_process  puppeteer-core  Supabase
      API, per-  in a fresh     + @sparticuz/   (guest quota,
      persona    /tmp jail,     chromium        service-role)
      routing    allowlisted    (signed-in
                 + native       accounts only)
                 curl/dig/ping

           Supabase (Auth · Postgres · Storage · RLS)
           ← lib/auth.ts, chatStore, vfs, modelStore
             (real accounts; guests stay local-only)
```

## The bus: `services/kernel.ts`

The original Kernos frontend talked to the Go backend over a WebSocket, using a typed `Envelope { topic, from, to?, payload, time }` pub/sub protocol. That protocol shape is unchanged — every app still calls `kernel.publish()` / `kernel.sendToAgent()` / `kernel.subscribe()` exactly as before. What changed is the transport: there's no socket anymore. `kernel.ts` is a local, synchronous listener set that, for specific topics, calls `fetch()` against `/api/*` and re-broadcasts the response locally:

| Topic | Old backend | Now |
|---|---|---|
| `agent.chat` | Go → LM Studio (streamed) | `/api/chat` → Groq (streamed), per-persona model routing |
| `ai.chat` | Go → LM Studio | `/api/chat`, persona from `env.to`, echoes `_request_id` so concurrent callers can demultiplex |
| `vm.spawn` | Go `exec.Cmd` in a temp jail | `/api/exec` → Node `child_process` in a fresh `/tmp` jail |
| `vm.render` | — (new) | `/api/browser-render` → headless Chromium, signed-in accounts only |
| `agent.roster` | Go query | answered locally from `lib/agents.ts` |
| `chat.list/save/load/delete` | SQLite | `lib/chatStore.ts` — Supabase for real accounts, localStorage for guests |
| `vfs:read/write/create` | Go host filesystem | not routed through the bus at all — apps call `lib/vfs.ts` directly (Supabase or localStorage by account type) |
| `terminal.check_shadow` | speculative-execution engine | always answers "miss" (no speculative engine — see Cuts) |
| `applet.compile` | Go `esbuild` compiler | compiled in-browser by `lib/appletCompiler.ts` (Sucrase) |
| `agent.tool:start/done/error` | — (new) | published by `apps/AIChat.tsx` so tool runs are observable on the bus |
| everything else (`bios.*`, `p2p.*`, `pkg.*`, ...) | Go handlers | delivered to local subscribers only, no-op |

Subscribers receive **outgoing** envelopes as well as responses. Anything with
a handler above used to return before the catch-all broadcast, so `agent.chat`,
`ai.chat`, `vm.spawn` and `task.run` appeared in `getTrafficLog()` but were
never delivered live — which made "who asked for this?" underivable from the
bus. `route()` now notifies subscribers first, then dispatches.

User preferences do **not** ride the bus. The old `sys.config:get/set` topics
had no backend and only echoed the request topic back, so the Settings panel
they fed could never populate. Preferences now live in `lib/settings.ts`
(localStorage, with a subscribe callback and cross-tab `storage` sync), and
each one maps to a real effect: theme CSS variables, `reduceMotion`, terminal
font size, default AI Chat persona, guest-quota warning threshold, boot
sequence, and a PostHog opt-out.

## The agent layer: Groq

`lib/agents.ts` holds the six personas (Dispatcher, Architect, Kernos Assistant, DevOps Engineer, Security Auditor, Code Review) as system prompts — previously six roles sharing two local LM Studio models, now six system prompts sharing one Groq-hosted model (`GROQ_MODEL` env var). `api/chat.ts` (Edge runtime) proxies to Groq's OpenAI-compatible `/chat/completions` endpoint with `stream: true`, re-emitting a simplified newline-delimited JSON stream so the client doesn't need to parse Groq's SSE format directly. `GROQ_API_KEY` never leaves this function.

Dispatcher and Kernos Assistant additionally carry a **tool-call contract**: they can emit a fenced ` ```tool ` block that `AIChat.tsx` parses out of the reply, executes, and reports back into the same chat thread. Two tool families exist:

- `bnlm.train` / `bnlm.generate` / `bnlm.score` — run against `lib/localModel.ts` directly. This is the literal "Groq spins up and trains a browser-native model" loop.
- `kernos.exec` — runs agent-written TypeScript through `lib/kernosExec.ts`, the same Sucrase compile plus `AsyncFunction` sandbox that human-authored applets use, with a curated capability set (`vfs`, `bnlm`, `agent.ask`, a restricted `kernel` proxy), an 8s wall-clock timeout, and per-execution call budgets. `lib/kernosTools.ts` dispatches both families, and `lib/taskEngine.ts` can use either as a DAG node's command.

The sandbox runs on a **Web Worker**, so the timeout is a real kill rather than a race: it ends with `terminate()`, which stops synchronous code. A `while (true) {}` used to pin the main thread and hang the whole tab regardless of any timeout; measured now, the main thread keeps ticking throughout and the worker dies on schedule.

Capabilities live on the host, not in the worker — the worker holds no reference to the VFS, the models, the bus, or the network, and can only request an action over `postMessage`, which the host checks against the same per-execution budgets. Killing the thread therefore can't strand a half-applied capability. The budgets remain the backstop against a loop around real, billable calls, since a timeout alone doesn't bound cost.

Two capabilities were dropped in the move, both deliberately: `React`/`Lucide` (unclonable across the worker boundary, and this tool renders nothing) and `kernel.subscribe` (a callback can't survive `terminate()` and would leak a listener bound to a dead thread).

## The local model: BNLM

`src/bnlm/` is BNLM's engine, vendored in unmodified — `tensor.js` (the autograd engine), `model.js` (the `BNLM` Transformer, three mixers: attention/linear/RWKV), `tokenizer.js`, `optim.js` (Adam), `dataset.js`, `quantize.js`, and the Web Worker files for data-parallel training (`worker_pool.js`, `worker_train.js`) and off-main-thread charting (`chart_worker.js`). `lib/localModel.ts` wraps it into a stateful service: `init`, `train` (single-threaded or fanned out across `numWorkers` Web Workers), `generate`, `exportInt8`, and named persistence (`saveAs`/`loadSaved` via `lib/modelRegistry.ts`, IndexedDB — model weights are binary and can run past what's comfortable in a ~5MB localStorage quota, so they get a real database instead). Every train/generate call is auto-logged to `lib/localModelHistory.ts` (localStorage), matching the original BNLM demo's run-history/generation-log UI, now shared between the standalone Local Model app and the AIChat tool-call path.

This is the one piece of the "cognitive microkernel" vision that's fully real: a model that trains from random initialization and runs inference with no server involved, at any point, offline-capable.

## Deployment model: stateless functions, not a persistent kernel

This is the load-bearing difference from the original design. The Go backend was one long-running process holding an in-memory client registry, a growing SQLite DB, and background goroutines. Vercel functions are the opposite: stateless, ephemeral, ~10s execution budget on Hobby, no shared memory between invocations, and a minimal Linux image (`api/exec.ts`'s allowlist had to shrink to commands that image actually ships — 27, each probed against the deployed function; no git/python/go/rust/ffmpeg, and no node/npm either, which were removed as pointless RCE surface in a jail that doesn't outlive the request).

`vercel.json` sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` — required for `SharedArrayBuffer`, which BNLM's data-parallel Worker training uses. That's also why Tailwind and fonts are bundled locally rather than loaded from a CDN: cross-origin scripts/stylesheets get blocked under `require-corp` unless the origin sends a matching `Cross-Origin-Resource-Policy` header.

## Cuts (not deleted from ambition — just don't run on stateless functions)

- Go microkernel binary + WebSocket bus
- SQLite vector-graph DB / GraphRAG semantic search
- Real package manager (downloading actual Python/Go/Rust/etc. binaries)
- WebRTC P2P collaboration
- Speculative/predictive command execution ("shadow jail" pre-computation)
- Nightly RLHF consolidation / "Neuroplasticity Engine" goroutine pipelines
- Self-healing parallel-DAG-mutation recovery

All of these assume a persistent host process, so none of them fits a stateless deployment.

**Two items previously on this list have since shipped**, and are no longer cuts:

- **Accounts.** Supabase Auth is wired up (`lib/auth.ts`), with the guest identity kept as a first-class fallback rather than removed — the app stays usable with no signup. `lib/chatStore.ts`, `lib/vfs.ts`, and `lib/modelStore.ts` each pick a backend from the user id's shape: guests get localStorage/IndexedDB, real accounts get Postgres + Storage. The schema in [`supabase/schema.sql`](./supabase/schema.sql) (`profiles`/`conversations`/`messages`/`vfs_nodes`/`local_models`, with RLS policies) is live, not aspirational. `embeddings` remains unused — it belongs to the still-cut GraphRAG work.
- **Dynamic TSX→JS applet compilation.** This turned out not to need a server at all: `lib/appletCompiler.ts` runs Sucrase in the browser. Editor and CDE both have a "Launch Applet" button, and `components/apps/DynamicApplet.tsx` mounts the result in a closed shadow root behind a restricted kernel proxy.

Guest usage is metered rather than unlimited: `api/guest-usage.ts` enforces a 15-min/day/IP quota, which fails open when `SUPABASE_SERVICE_ROLE_KEY` isn't configured.

## The local classifier: measured

`src/bnlm/classifier.js` puts a second head on the same trunk — last-token pooling plus a linear layer, trained on labels instead of next-token prediction. It exists because a decoder-only LM is the wrong shape for a discrete decision: asking one to emit a label means parsing free-form text, and a model this small has no capacity to spare on being well-formed *and* correct. Prompted with `git s` after training on git commands, the generative model returns `obb\nmmaikaei`. Classification removes that failure mode — the output is a distribution over known labels and can't be malformed.

Numbers for a 3-way intent router (`files` / `network` / `model`), trained in-browser on Groq-generated data, measured against a held-out 20% split:

| | Value |
|---|---|
| Training examples | 266 (of 333 generated, balanced 111/111/111) |
| Parameters | 8,331 |
| Training time | 20 s |
| Train accuracy | 92.9% |
| **Held-out accuracy** | **88.1%** |
| **Inference** | **0.76 ms** |

Train and held-out sit within 5 points, so it's generalizing rather than memorizing. Sub-millisecond inference is what makes chaining several specialists practical.

Two findings behind those defaults, both measured rather than assumed:

- **Capacity is not the constraint; data is.** 102,147 params over 24 examples scored 33% — chance — while reporting 100% training accuracy and 100% confidence on wrong answers. 7,995 params over 668 examples scored 91%. `DEFAULT_CLASSIFIER_CONFIG` is small for this reason.
- **Don't freeze the trunk.** `BNLM.freeze()` is for fine-tuning a pretrained LM; this trunk is randomly initialized, so freezing leaves the head as a linear probe over random projections. Identical config, 167 held-out examples: frozen 51.5%, fully trained 95.2%.

### Why the glass box is not decoration

`predict()` returns raw logits, the margin to the runner-up, and a plain-language explanation; `explain()` adds per-word causal attribution by occlusion — remove a word, measure how far the target probability falls. Not a similarity score against the pooled vector, which cannot work here: under last-token pooling the pooled vector *is* the last token's hidden state, so it would score 1.0 by construction and explain nothing.

This earned its keep immediately. An earlier router hit 99.5% confidence on `download that site` → `network`, and attribution showed the decision rested entirely on **"that"** (0.964) — a stopword artifact of combinatorially generated training data. Accuracy and held-out score both looked fine, because the held-out split came from the same templates. Only attribution exposed it. `lib/datasetGen.ts`'s prompt now spends most of its length forbidding repeated sentence frames as a direct result.

## The terminal: real network commands

`api/exec.ts` runs allowlisted coreutils in a per-invocation `/tmp` jail, but `curl`, `dig`, and `ping` aren't shelled out to — the Vercel image doesn't ship them. They're reimplemented natively in `lib/networkCommands.ts` and gated to signed-in accounts (`lib/verifyAuth.ts` validates the Supabase access token the client attaches; guests silently keep the coreutils-only sandbox).

Every outbound request goes through `lib/networkGuard.ts`, which blocks private, loopback, and link-local IPv4/IPv6 ranges and re-validates on each redirect hop. **Known gap:** there's no DNS-rebinding protection — a hostname that resolves to a public IP at check time and a private one at connect time would slip through. Closing that needs resolve-then-connect-by-IP, which `fetch` doesn't expose.

`render <url>` is separate (`api/browser-render.ts`): a real headless Chromium page load via `puppeteer-core` + `@sparticuz/chromium`, returning extracted text or a screenshot. It needs its own `vercel.json` memory/duration budget and a paid plan — Hobby's hard 10s cap can't fit a Chromium cold start plus a page load.

## Mobile

Below `MOBILE_BREAKPOINT` (768px, in `store.ts`) the shell switches from overlapping draggable windows to full-screen single-app mode with a bottom nav and an app-switcher sheet. `isMobile` is kept on the store and synced by a module-level resize listener rather than read per-component, so every consumer — including `openWindow`'s sizing math — agrees within a single render. Drag and resize use Pointer Events, not Mouse Events, so touch and pen work at all.

## Legal and funding

`components/TermsGate.tsx` blocks the desktop for guests and signed-in users alike until accepted (`lib/terms.ts` records it). Governing law is Georgia, USA; contact is `g.intel.co@outlook.com`. `lib/donate.ts` renders a Buy Me a Coffee link when `VITE_DONATE_URL` is set and hides the button entirely when it isn't — no payment processing lives in this codebase.

## Rate limiting

`api/chat.ts` and `api/exec.ts` both check `lib/rateLimit.ts` before doing any work — per-IP, fixed 60s window, defaults 20/min and 30/min respectively (`RATE_LIMIT_CHAT_PER_MIN` / `RATE_LIMIT_EXEC_PER_MIN` env vars to override). It's in-memory, which means it only limits requests landing on the same warm function instance — not distributed across every concurrent instance Vercel might spin up under real load. That's a known, explicit gap, not an oversight: proper distributed limiting needs a shared store (Upstash Redis is the standard pairing with Vercel, with a free tier and a one-click integration that auto-injects env vars). `lib/rateLimit.ts` is deliberately the one place this decision lives, so upgrading later means changing the body of `checkRateLimit`, not every call site.

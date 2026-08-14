# Architecture

This document maps what's actually running today, and where each piece came from. The original Kernos OS was a Go microkernel behind a React shell; the original BNLM was a standalone static site. This app is the React shell, kept, retargeted at a stateless serverless backend, with BNLM's engine vendored in as a library the shell can drive.

```
┌──────────────────────────────────────────────────────────────────┐
│  BROWSER (the whole "OS")                                        │
│  App.tsx / store.ts — window manager, taskbar, desktop           │
│  ┌───────────┐ ┌──────────┐ ┌──────────────┐ ┌─────────────────┐ │
│  │ AI Chat   │ │ Terminal │ │ Local Model  │ │ Editor / Files / │ │
│  │           │ │          │ │ (BNLM)       │ │ CDE              │ │
│  └─────┬─────┘ └────┬─────┘ └──────┬───────┘ └────────┬─────────┘ │
│        │            │              │                  │           │
│        └──────┬─────┴──────┬───────┘         lib/vfs.ts,          │
│               │             │                 lib/chatStore.ts     │
│      services/kernel.ts (client-side pub/sub bus + fetch adapter) │
│               │             │                                      │
│         lib/localModel.ts ──┼── src/bnlm/* (Tensor/BNLM/Adam/      │
│         lib/modelRegistry.ts│   CharTokenizer/worker_pool, all     │
│         (IndexedDB)         │   running in this tab, no network)   │
└───────────────┼─────────────┼──────────────────────────────────────┘
                 │             │
                 ▼             ▼
      POST /api/chat      POST /api/exec
      (Vercel Edge Fn)    (Vercel Node Fn)
                 │             │
                 ▼             ▼
         Groq Chat API    child_process, in a fresh
     (llama-3.3-70b, or   /tmp jail per invocation,
      whatever GROQ_MODEL  allowlisted + sanitized
      is set to)
```

## The bus: `services/kernel.ts`

The original Kernos frontend talked to the Go backend over a WebSocket, using a typed `Envelope { topic, from, to?, payload, time }` pub/sub protocol. That protocol shape is unchanged — every app still calls `kernel.publish()` / `kernel.sendToAgent()` / `kernel.subscribe()` exactly as before. What changed is the transport: there's no socket anymore. `kernel.ts` is a local, synchronous listener set that, for specific topics, calls `fetch()` against `/api/*` and re-broadcasts the response locally:

| Topic | Old backend | Now |
|---|---|---|
| `agent.chat` | Go → LM Studio (streamed) | `/api/chat` → Groq (streamed) |
| `vm.spawn` | Go `exec.Cmd` in a temp jail | `/api/exec` → Node `child_process` in a fresh `/tmp` jail |
| `agent.roster` | Go query | answered locally from `lib/agents.ts` |
| `chat.list/save/load/delete` | SQLite | `lib/chatStore.ts` (localStorage) |
| `vfs:read/write/create` | Go host filesystem | not routed through the bus at all — apps call `lib/vfs.ts` directly |
| `terminal.check_shadow` | speculative-execution engine | always answers "miss" (no speculative engine — see Cuts) |
| `applet.compile` | Go `esbuild` compiler | fails fast with a clear error (no compiler in this build) |
| everything else (`bios.*`, `p2p.*`, `pkg.*`, ...) | Go handlers | broadcast locally only, no-op |

## The agent layer: Groq

`lib/agents.ts` holds the six personas (Dispatcher, Architect, Kernos Assistant, DevOps Engineer, Security Auditor, Code Review) as system prompts — previously six roles sharing two local LM Studio models, now six system prompts sharing one Groq-hosted model (`GROQ_MODEL` env var). `api/chat.ts` (Edge runtime) proxies to Groq's OpenAI-compatible `/chat/completions` endpoint with `stream: true`, re-emitting a simplified newline-delimited JSON stream so the client doesn't need to parse Groq's SSE format directly. `GROQ_API_KEY` never leaves this function.

Dispatcher and Kernos Assistant additionally carry a **tool-call contract**: they can emit a fenced ` ```tool ` block (`{"tool":"bnlm.train",...}` / `{"tool":"bnlm.generate",...}`) that `AIChat.tsx` parses out of the reply and executes against `lib/localModel.ts` directly, reporting the result back into the same chat thread. This is the literal "Groq spins up and trains a browser-native model" loop.

## The local model: BNLM

`src/bnlm/` is BNLM's engine, vendored in unmodified — `tensor.js` (the autograd engine), `model.js` (the `BNLM` Transformer, three mixers: attention/linear/RWKV), `tokenizer.js`, `optim.js` (Adam), `dataset.js`, `quantize.js`, and the Web Worker files for data-parallel training (`worker_pool.js`, `worker_train.js`) and off-main-thread charting (`chart_worker.js`). `lib/localModel.ts` wraps it into a stateful service: `init`, `train` (single-threaded or fanned out across `numWorkers` Web Workers), `generate`, `exportInt8`, and named persistence (`saveAs`/`loadSaved` via `lib/modelRegistry.ts`, IndexedDB — model weights are binary and can run past what's comfortable in a ~5MB localStorage quota, so they get a real database instead). Every train/generate call is auto-logged to `lib/localModelHistory.ts` (localStorage), matching the original BNLM demo's run-history/generation-log UI, now shared between the standalone Local Model app and the AIChat tool-call path.

This is the one piece of the "cognitive microkernel" vision that's fully real: a model that trains from random initialization and runs inference with no server involved, at any point, offline-capable.

## Deployment model: stateless functions, not a persistent kernel

This is the load-bearing difference from the original design. The Go backend was one long-running process holding an in-memory client registry, a growing SQLite DB, and background goroutines. Vercel functions are the opposite: stateless, ephemeral, ~10s execution budget on Hobby, no shared memory between invocations, and a minimal Linux image (`api/exec.ts`'s allowlist had to shrink to commands that image actually ships — no git/python/go/rust/ffmpeg unless verified present).

`vercel.json` sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` — required for `SharedArrayBuffer`, which BNLM's data-parallel Worker training uses. That's also why Tailwind and fonts are bundled locally rather than loaded from a CDN: cross-origin scripts/stylesheets get blocked under `require-corp` unless the origin sends a matching `Cross-Origin-Resource-Policy` header.

## Cuts (not deleted from ambition — just don't run on stateless functions)

- Go microkernel binary + WebSocket bus
- SQLite vector-graph DB / GraphRAG semantic search
- Real package manager (downloading actual Python/Go/Rust/etc. binaries)
- WebRTC P2P collaboration
- Speculative/predictive command execution ("shadow jail" pre-computation)
- Nightly RLHF consolidation / "Neuroplasticity Engine" goroutine pipelines
- Self-healing parallel-DAG-mutation recovery
- OAuth / multi-user accounts (single-user "guest" identity for v1)
- Dynamic TSX→JS applet compilation (needed a server-side compiler)

All of these assumed a persistent host process. A revival path exists for some of them (Supabase's free tier bundles Postgres + pgvector + Auth + Storage, which would cover accounts and vector memory in one integration rather than stitching together separate services), but none is built yet — see `App.tsx`'s `enterDesktop()` (a single constant "guest" identity, replacing the old login/signup screen) and `lib/chatStore.ts`/`lib/vfs.ts`'s localStorage backing, which exist specifically so those are one-file swaps later, not a rewrite. The concrete target schema for that migration — `profiles`/`conversations`/`messages`/`vfs_nodes`/`local_models`/`embeddings`, with RLS policies — is written out in [`supabase/schema.sql`](./supabase/schema.sql), ready to run whenever that migration actually happens; nothing reads or writes it yet.

## Rate limiting

`api/chat.ts` and `api/exec.ts` both check `lib/rateLimit.ts` before doing any work — per-IP, fixed 60s window, defaults 20/min and 30/min respectively (`RATE_LIMIT_CHAT_PER_MIN` / `RATE_LIMIT_EXEC_PER_MIN` env vars to override). It's in-memory, which means it only limits requests landing on the same warm function instance — not distributed across every concurrent instance Vercel might spin up under real load. That's a known, explicit gap, not an oversight: proper distributed limiting needs a shared store (Upstash Redis is the standard pairing with Vercel, with a free tier and a one-click integration that auto-injects env vars). `lib/rateLimit.ts` is deliberately the one place this decision lives, so upgrading later means changing the body of `checkRateLimit`, not every call site.

# Kernos + BNLM: Cloud Reasoning, Local Execution

## Abstract & Framework
**Revision:** 3.0.0 — Groq/Vercel/BNLM merge
**Date:** March 2026
**Author:** Kernos Foundation

### 1. From "AI Kernel" to "AI Workspace"

The original Kernos OS explored a specific, ambitious idea: an operating system whose kernel itself reasoned about user intent, built as a persistent Go process with embedded local LLMs, a vector-graph memory, and speculative execution. That required a binary running on the user's own machine.

This version keeps the browser-native desktop shell — the window manager, the taskbar, the terminal, the boot sequence — but replaces the persistent Go "kernel" with a stateless Vercel deployment, and replaces "AI as the kernel" with something more specific and more honest: **a fast cloud reasoning layer (Groq) that can direct a genuinely local, genuinely trainable model (BNLM) running in the same browser tab.** It is an AI workspace, not an AI operating system — a narrower claim, backed by more of what's actually built working end-to-end.

---

## 2. The Two-Model Architecture

### I. Groq: Multi-Persona Cloud Reasoning
Six agent personas — Dispatcher, Architect, Kernos Assistant, DevOps Engineer, Security Auditor, Code Review — route through a single Groq-hosted model, distinguished by system prompt rather than separate model instances. This trades per-agent model diversity for near-instant inference and zero local infrastructure. Streaming responses arrive as a simplified newline-delimited JSON protocol from `api/chat.ts` (a Vercel Edge function), which the client reassembles into the same `agent.chat:stream` / `agent.chat:reply` envelope pattern the UI always expected.

### II. BNLM: A Model That Actually Runs Locally
`src/bnlm/` is a decoder-only Transformer with a hand-rolled reverse-mode autograd engine, three selectable causal token-mixers (softmax attention with KV-cache generation, causal linear attention with O(1)-memory recurrent generation, and an RWKV-v4-style recurrent mixer), a WGSL compute shader for GPU-accelerated matmuls with automatic CPU fallback, and a standard Adam optimizer — all initializing, training, and generating entirely inside the browser tab. Training can run on the main thread or fan out across `numWorkers` Web Workers, synchronously averaging gradients before each optimizer step. Trained models are named and persisted to IndexedDB, surviving reloads — not a session-scoped demo toy.

### III. The Tool-Call Bridge
Two personas (Dispatcher, Kernos Assistant) carry an additional contract: when a request calls for training or sampling a local model, they emit a fenced JSON tool block (`bnlm.train` / `bnlm.generate`) instead of, or alongside, a normal reply. The client parses this out of the streamed response and executes it directly against `lib/localModel.ts`, then reports the outcome back into the same conversation. This is the literal mechanism by which "the cloud model directs the local model" — no separate orchestration service, just a parsed block in an otherwise-normal chat reply.

---

## 3. Deployment Model: Stateless by Design

The entire app — the React shell, the Groq proxy, the exec sandbox — deploys as a single Vercel project with no server to provision. `api/chat.ts` runs on the Edge runtime for low-latency streaming; `api/exec.ts` runs on the Node runtime (it needs `child_process`) with a `mkdtemp`'d jail per invocation, a stripped environment, argument sanitization against shell metacharacters and path traversal, and a hard timeout matching the function's execution budget. Neither function retains state between invocations — every piece of state that needs to persist (chat history, the virtual filesystem, trained model weights) lives in the browser via localStorage or IndexedDB instead of a server-side database.

`vercel.json` sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, required for the `SharedArrayBuffer` BNLM's parallel training workers use — which is also why Tailwind and web fonts are bundled locally rather than pulled from a CDN, since cross-origin resources get blocked under `require-corp` without a matching `Cross-Origin-Resource-Policy` header.

---

## 4. What Didn't Survive the Move to Stateless, and Why

The original design's most ambitious subsystems — GraphRAG semantic memory over a SQLite vector-graph, a WebRTC P2P collaboration layer, a speculative "shadow jail" command-prediction cache, and a nightly RLHF consolidation pipeline running as background goroutines — all assumed a long-lived process holding growing in-memory and on-disk state. None of that exists on a stateless function platform by construction, not by oversight. They're documented as explicit cuts in [ARCHITECTURE.md](./ARCHITECTURE.md) rather than silently dropped, each with the specific persistent-state dependency that makes it incompatible with this deployment target.

---

## 5. Security Model

Security now centers on two boundaries instead of one. The exec sandbox (`api/exec.ts`) keeps the original design's allowlist-plus-sanitization approach — reject shell metacharacters, reject `..` and absolute paths, run in an isolated temp directory with a stripped environment — but the allowlist itself had to shrink to match what a Vercel Node function's minimal Linux image actually ships, with a live existence check per command rather than assuming host parity. The Groq API boundary is new: `GROQ_API_KEY` is read only inside `api/chat.ts`, an Edge function, and is never included in any response sent to the client — the key cannot leak through normal application use, only through misconfiguration of the Vercel project itself.

---

## 6. The Verdict

Kernos + BNLM is not an operating system with AI bolted on, and it no longer claims to be an AI kernel. It's a browser-native workspace where a fast, capable cloud reasoner and a small, genuinely local, genuinely trainable model compose through one tool-call contract — a narrower claim than the original vision, and a more fully working one.

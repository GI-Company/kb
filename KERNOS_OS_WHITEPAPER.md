# Kernos + BNLM: Cloud Reasoning, Local Execution

## Abstract & Framework
**Revision:** 3.1.0 — Groq/Vercel/BNLM merge, plus accounts and in-browser compilation
**Date:** Last revised August 2026
**Author:** Kernos Foundation

### 1. From "AI Kernel" to "AI Workspace"

The original Kernos OS explored a specific, ambitious idea: an operating system whose kernel itself reasoned about user intent, built as a persistent Go process with embedded local LLMs, a vector-graph memory, and speculative execution. That required a binary running on the user's own machine.

This version keeps the browser-native desktop shell — the window manager, the taskbar, the terminal, the boot sequence — but replaces the persistent Go "kernel" with a stateless Vercel deployment, and replaces "AI as the kernel" with something more specific and more honest: **a fast cloud reasoning layer (Groq) that can direct a genuinely local, genuinely trainable model (BNLM) running in the same browser tab.** It is an AI workspace, not an AI operating system — a narrower claim, backed by more of what's actually built working end-to-end.

---

## 2. The Two-Model Architecture

### I. Groq: Multi-Persona Cloud Reasoning
Six agent personas — Dispatcher, Architect, Kernos Assistant, DevOps Engineer, Security Auditor, Code Review — each pair a system prompt with a Groq model chosen for that persona's job and call frequency, plus a fallback model tried once on a rate-limit response. Dispatcher fires on nearly every user action and so is routed to the model with the largest daily budget rather than the strongest reasoning; the review personas, invoked less often, get the most capable one; the security persona gets the safety-tuned one. Streaming responses arrive as a simplified newline-delimited JSON protocol from `api/chat.ts` (a Vercel Edge function), which the client reassembles into the same `agent.chat:stream` / `agent.chat:reply` envelope pattern the UI always expected.

(An earlier revision of this document described all six as sharing one model. That was true then; per-persona routing replaced it, and a single `GROQ_MODEL` env var still forces the old behavior when set.)

### II. BNLM: A Model That Actually Runs Locally
`src/bnlm/` is a decoder-only Transformer with a hand-rolled reverse-mode autograd engine, three selectable causal token-mixers (softmax attention with KV-cache generation, causal linear attention with O(1)-memory recurrent generation, and an RWKV-v4-style recurrent mixer), a WGSL compute shader for GPU-accelerated matmuls with automatic CPU fallback, and a standard Adam optimizer — all initializing, training, and generating entirely inside the browser tab. Training can run on the main thread or fan out across `numWorkers` Web Workers, synchronously averaging gradients before each optimizer step. Trained models are named and persisted to IndexedDB, surviving reloads — not a session-scoped demo toy.

### III. The Tool-Call Bridge
Two personas (Dispatcher, Kernos Assistant) carry an additional contract: they can emit a fenced JSON tool block instead of, or alongside, a normal reply. The client parses it out of the streamed response, executes it, and reports the outcome back into the same conversation. No separate orchestration service — just a parsed block in an otherwise-normal chat reply.

Two tool families exist. `bnlm.train` / `bnlm.generate` / `bnlm.score` run against the in-browser model directly: this is the literal mechanism by which the cloud model directs the local one. `kernos.exec` is the general case — agent-written TypeScript, compiled in-browser and run in the same sandbox human-authored applets use, with a curated capability set (filesystem, local model, a one-off question to another persona, a restricted bus proxy), a wall-clock timeout, and per-execution call budgets.

That last constraint is the interesting one. A timeout alone is insufficient: it cannot preempt synchronous code on a single-threaded runtime, and it does not stop in-flight async work from continuing to consume billable API budget after the caller has already been handed an error. Capping how many real calls one execution may make is what actually bounds worst-case cost. A true hard-kill would require running the sandbox on a separate thread, which is not built.

---

## 3. Deployment Model: Stateless by Design

The entire app — the React shell, the Groq proxy, the exec sandbox — deploys as a single Vercel project with no server to provision. `api/chat.ts` runs on the Edge runtime for low-latency streaming; `api/exec.ts` runs on the Node runtime (it needs `child_process`) with a `mkdtemp`'d jail per invocation, a stripped environment, argument sanitization against shell metacharacters and path traversal, and a hard timeout matching the function's execution budget. No function retains state between invocations. Persistence is therefore split by identity rather than pushed entirely to the client: guests keep chat history, the virtual filesystem, and trained model weights in localStorage and IndexedDB, while signed-in accounts get the same data in Supabase Postgres and object storage under row-level security. Two further Node functions were added since: a headless-Chromium page renderer, and guest-quota accounting.

`vercel.json` sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, required for the `SharedArrayBuffer` BNLM's parallel training workers use — which is also why Tailwind and web fonts are bundled locally rather than pulled from a CDN, since cross-origin resources get blocked under `require-corp` without a matching `Cross-Origin-Resource-Policy` header.

---

## 4. What Didn't Survive the Move to Stateless, and Why

The original design's most ambitious subsystems — GraphRAG semantic memory over a SQLite vector-graph, a WebRTC P2P collaboration layer, a speculative "shadow jail" command-prediction cache, and a nightly RLHF consolidation pipeline running as background goroutines — all assumed a long-lived process holding growing in-memory and on-disk state. None of that exists on a stateless function platform by construction, not by oversight. They're documented as explicit cuts in [ARCHITECTURE.md](./ARCHITECTURE.md) rather than silently dropped, each with the specific persistent-state dependency that makes it incompatible with this deployment target.

Two items originally on that list have since been built, and the reasons are instructive because they differ. **Accounts** were genuinely blocked on having no database; a managed one (Supabase) removed the blocker without reintroducing a server to operate. **Dynamic TSX compilation** was never actually blocked at all — it had been assumed to need a server-side compiler, and the assumption was simply wrong: a syntax transformer runs perfectly well in the browser. One cut was a real constraint; the other was an unexamined premise. Both are worth distinguishing when reading any list of things a system "can't" do.

---

## 5. Security Model

Security now centers on several boundaries rather than one. The exec sandbox (`api/exec.ts`) keeps the original design's allowlist-plus-sanitization approach — reject shell metacharacters, reject `..` and absolute paths, run in an isolated temp directory with a stripped environment — but the allowlist itself had to shrink to match what a Vercel Node function's minimal Linux image actually ships, with a live existence check per command rather than assuming host parity. The Groq API boundary is new: `GROQ_API_KEY` is read only inside `api/chat.ts`, an Edge function, and is never included in any response sent to the client — the key cannot leak through normal application use, only through misconfiguration of the Vercel project itself.

Three boundaries were added as the system grew. **Outbound network access** (the terminal's native `curl`/`dig`/`ping` and the page renderer) is restricted to signed-in accounts and screened against private, loopback, and link-local address ranges on every redirect hop — with one honest gap: no DNS-rebinding protection, since resolving and then connecting by IP is not expressible through `fetch`. **Executed code**, whether written by a user or by an agent, runs with no real `eval`, no raw imports, no DOM access, a capability set that is enumerated rather than inherited, and a bus proxy that refuses destructive topics. **Data access** is enforced at the database by row-level security rather than in application code, so a client-side mistake cannot widen it.

---

## 6. The Verdict

Kernos + BNLM is not an operating system with AI bolted on, and it no longer claims to be an AI kernel. It's a browser-native workspace where a fast, capable cloud reasoner and a small, genuinely local, genuinely trainable model compose through one tool-call contract — a narrower claim than the original vision, and a more fully working one.

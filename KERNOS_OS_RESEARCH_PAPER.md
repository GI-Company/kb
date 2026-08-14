# Kernos + BNLM: Cloud Reasoning Paired with a Genuinely Local Model

**Date of Publication:** March 2026 (original), updated for the Groq/Vercel/BNLM merge
**Project Type:** Technical Architecture Proof-of-Concept

## Abstract

Most "AI-native" tools integrate a language model as a remote service the application calls into — the model is never actually present on the user's machine, and "local" usually just means "the UI runs locally while the model runs in someone's datacenter." This paper describes a system that combines both modes honestly: a fast, capable cloud model (Groq, hosting a family of agent personas distinguished by system prompt) handles reasoning and planning, while a second, genuinely local model — a small decoder-only Transformer implemented from scratch in JavaScript, with autograd, three attention variants, and a training loop — initializes, trains, and runs inference entirely inside the browser tab, with no network dependency once loaded. The cloud model can direct the local one: an agent persona can emit a structured tool call that trains or samples from the in-browser model and reports the result back into the conversation.

## 1. Introduction

The original version of this project (Kernos OS) explored a different question: what if an operating system's kernel itself reasoned about user intent, via a persistent Go process hosting local LLMs, a vector-graph memory, and speculative command execution? That system required a process running on the user's host machine — it could not be handed to someone as a URL.

This version answers a narrower, more concretely useful question: what does it look like to combine a **cloud model that's actually good at reasoning** with a **model that's actually running on the user's own hardware**, deployed as a single stateless web app anyone can open in a browser tab? The two failure modes it avoids are (a) pretending a cloud API call is "local AI," and (b) requiring users to install anything to get a real local model.

## 2. System Architecture

### 2.1 The Envelope Bus, Retargeted

The UI still communicates via a typed `Envelope { topic, from, to?, payload, time }` publish/subscribe protocol — unchanged from the original design. What changed is what's on the other end: instead of a WebSocket to a persistent Go process, `services/kernel.ts` is a local, synchronous bus that routes specific topics to stateless Vercel functions (`/api/chat`, `/api/exec`) and answers everything else either locally (static agent roster, chat history in localStorage) or as a graceful no-op (topics whose backend no longer exists). Every UI component that consumed the bus works unmodified; only the transport layer changed.

### 2.2 Multi-Persona Routing Over a Single Model

Rather than six agents each with independent reasoning capacity, this system routes six distinct system prompts (Dispatcher, Architect, Assistant, DevOps, Security, Code Review) through one Groq-hosted model. The differentiation is entirely in framing and instruction, not model capability — a deliberate simplification from a multi-model design, trading some behavioral diversity for zero local infrastructure and near-instant Groq inference latency.

### 2.3 A Model That Is Actually Local

The core empirical claim worth stating precisely: `src/bnlm/model.js` implements a decoder-only Transformer — token/positional embeddings, pre-norm blocks, a choice of three causal token-mixers (standard softmax attention with a KV-cache generation path, causal linear attention with an O(1)-memory recurrent generation form, and an RWKV-v4-style time-mixing recurrent mixer) — with a hand-rolled reverse-mode autograd engine (`tensor.js`) and a WGSL compute shader for the dominant matmuls when WebGPU is available, falling back to pure-JS CPU matmul otherwise. Training uses a standard Adam optimizer and cross-entropy loss, with an optional data-parallel mode that shards batches across Web Workers and averages gradients before a single optimizer step. Every operation is gradient-checked against finite differences.

This model is genuinely initialized from random weights and trained, in the same tab the UI renders in, on whatever text the user (or a Groq agent, generating a synthetic training set on request) provides. Its outputs are not cached, retrieved, or proxied from anywhere.

### 2.4 The Agentic Tool-Call Loop

Two of the six personas carry an additional instruction: when the user's request calls for training or sampling from a local model, emit a single fenced JSON block naming the tool (`bnlm.train` / `bnlm.generate`) and its arguments. The client extracts this block from the streamed reply, executes it against the local model service, and appends the result as a follow-up message in the same thread — the same pattern used by tool-calling APIs generally, applied here to a tool that happens to run entirely client-side rather than as a remote function.

### 2.5 Persistence Without a Server

Trained models, chat history, and the virtual filesystem all persist across reloads using browser storage — IndexedDB for model weights (binary, can exceed a comfortable localStorage budget even at these small demo sizes) and localStorage for everything else. No account system exists yet; a single "guest" identity is used, with the persistence layer already shaped (see Section 3) so a real backend can be swapped in without touching the UI.

## 3. Results and Limitations

The current implementation is a real, working system: Groq round-trips complete in the low seconds with token streaming, and a small BNLM model (tens of thousands of parameters) visibly reduces loss and produces recognizable fragments of its training text within a couple hundred training steps, entirely in-tab.

Limitations, stated plainly:
- **No persistent host process.** Several features from the original design genuinely require one — a real package manager that installs binaries, WebRTC P2P collaboration, a speculative command-execution cache, background RLHF consolidation — and are not present in this version. They are architecturally incompatible with a stateless deployment, not merely unimplemented.
- **BNLM's scale is intentionally small.** This is a demonstration of the training loop being real, not a claim of competitive model quality — these are toy-sized models (tens to low hundreds of thousands of parameters) suited to memorizing small, simple corpora, comparable to what the TinyStories line of research uses to study what very small models can learn.
- **Sandbox sophistication.** `api/exec.ts`'s command allowlist had to shrink further than the original Go version's, since Vercel's Node function runtime doesn't ship the broader toolset a real host would (no git/python/go/rust/ffmpeg by default).

## 4. Conclusion

The interesting result here isn't either half in isolation — cloud LLM wrappers and toy client-side Transformers both exist elsewhere — it's that they compose cleanly through a single tool-call contract: a fast, capable model deciding when a slower, private, zero-cost, offline-capable model should be trained or consulted, without the user ever leaving one chat window. Extending this pattern to larger local models (as WebGPU compute and browser memory budgets grow) or to a persistent-backend deployment (recovering the cut features via a real database) are both natural next steps.

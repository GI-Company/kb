<div align="center">

# 🧠 Kernos + BNLM

**A browser-native AI workspace: a Groq-powered agent shell wrapped around a language model that trains and runs entirely in your tab.**

[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vitejs.dev)
[![Vercel](https://img.shields.io/badge/Deploy-Vercel-000000?style=flat-square&logo=vercel&logoColor=white)](https://vercel.com)
[![License](https://img.shields.io/badge/License-Apache_2.0-orange?style=flat-square)](LICENSE)

</div>

<br />

## What this is

This project merges two things into one deployable app:

- **Kernos** — a polished React/Vite desktop-in-the-browser shell (window manager, taskbar, terminal, chat, IDE, boot sequence).
- **BNLM** — a real, working decoder-only Transformer, tokenizer, optimizer, and training loop, written in plain JS + one WGSL compute shader, that initializes, trains, and runs inference **entirely client-side**. No GPU cluster, no server round trip for inference.

Glued together, the idea is: **Groq is the fast cloud brain** (six agent personas — Dispatcher, Architect, Kernos Assistant, DevOps, Security, Code Review — all backed by a single Groq-hosted model), and **BNLM is a small local specialist model** those agents can direct — spin up, train on pasted or Groq-generated text, and generate from, live in the user's browser, with zero inference cost and no data leaving the tab.

This is a merge and a rewrite, not a new product from scratch — see [ARCHITECTURE.md](./ARCHITECTURE.md) for what came from where, and what got cut to make it deployable on Vercel.

## Quick start

```bash
git clone https://github.com/GI-Company/kb.git
cd kb
npm install
cp .env.example .env.local   # fill in GROQ_API_KEY
npm run dev
```

Open `http://localhost:3000`. No backend process to start — `npm run dev` runs the Vite dev server, and a small dev-only plugin (`dev-api-plugin.ts`) runs the `api/*.ts` Vercel functions in-process so the whole app works locally without the Vercel CLI.

Get a Groq API key at [console.groq.com/keys](https://console.groq.com/keys). It's read server-side only (`api/chat.ts`) — never shipped to the client.

## What's actually working

- **AI Chat** — six Groq-backed agent personas, streamed token-by-token, multi-turn history, image input, auto-saved conversation history (`lib/chatStore.ts`).
- **Local Model app** — the full BNLM loop in a window: paste or Groq-generate training text, pick a mixer (attention / linear / RWKV), initialize, train (single-threaded or data-parallel across Web Workers), generate, export as a quantized `.qlm1` file. Trained models can be **saved by name and reloaded after a reload** (`lib/modelRegistry.ts`, IndexedDB) — a trained model isn't a session-scoped toy, it persists.
- **Agentic tool-calling** — ask any AI Chat agent to "train a model on this text" or "generate from the local model," and it emits a structured tool call that the client parses and executes against the BNLM engine directly, then reports the result back into the chat.
- **Terminal** — a real ephemeral sandboxed command executor (`api/exec.ts`), allowlisted and argument-sanitized, running in a fresh Vercel function invocation per command.
- **File System / Editor** — a small in-browser virtual filesystem (`lib/vfs.ts`, localStorage-backed) — no server FS to round-trip through.

## What was cut, and why

The original Kernos OS design assumed a persistent Go binary: a WebSocket pub/sub bus, a SQLite vector-graph DB, OAuth, a real package manager, WebRTC P2P, a "speculative execution" predictive engine, and nightly RLHF consolidation goroutines. None of that runs on Vercel's stateless functions. Full accounting of what was kept, replaced, or dropped is in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Deploying

1. Push to GitHub (already done for `main` — see `git remote -v`).
2. Import the repo in [Vercel](https://vercel.com/new).
3. Set `GROQ_API_KEY` (and optionally `GROQ_MODEL`) as project environment variables.
4. Deploy. `vercel.json` already configures the COOP/COEP headers BNLM's parallel training needs and `api/exec.ts`'s function timeout.

## Project layout

```
App.tsx, store.ts, types.ts       Kernos shell — windows, desktop, taskbar
apps/                             Window contents: Terminal, AIChat, LocalModel, Editor, FileSystem, CDE, ...
components/                       Boot sequence, window chrome, context menus
services/kernel.ts                Client-side pub/sub bus + fetch adapter to /api/*
lib/agents.ts                     The six agent personas (system prompts)
lib/localModel.ts                 BNLM engine wrapper — init/train/generate/export/save/load
lib/modelRegistry.ts              IndexedDB-backed named model persistence
lib/localModelHistory.ts          Run history + generation log (localStorage)
lib/vfs.ts, lib/chatStore.ts      Client-side virtual filesystem + chat history
src/bnlm/                         The vendored BNLM engine (tensor/model/tokenizer/optimizer/workers)
api/chat.ts                       Groq streaming proxy (Edge function)
api/exec.ts                       Ephemeral sandboxed command exec (Node function)
```

## Further reading

- [ARCHITECTURE.md](./ARCHITECTURE.md) — the actual current stack, and the map from the original Go-backed design
- [KERNOS_101.md](./KERNOS_101.md) — a from-scratch walkthrough of using the app
- [KERNOS_OS_WHITEPAPER.md](./KERNOS_OS_WHITEPAPER.md), [KERNOS_OS_RESEARCH_PAPER.md](./KERNOS_OS_RESEARCH_PAPER.md), [KERNOS_OS_VALUATION.md](./KERNOS_OS_VALUATION.md) — narrative/portfolio documents, updated to match what's actually built

## License

Apache 2.0.

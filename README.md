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

Glued together, the idea is: **Groq is the fast cloud brain** (six agent personas — Dispatcher, Architect, Kernos Assistant, DevOps, Security, Code Review — each routed to its own Groq model, with a fallback if one gets rate-limited), and **BNLM is a small local specialist model** those agents can direct — spin up, train on pasted or Groq-generated text, and generate from, live in the user's browser, with zero inference cost and no data leaving the tab.

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

- **AI Chat** — six Groq-backed agent personas, each routed to its own model with a rate-limit fallback, streamed token-by-token, multi-turn history, image input, auto-saved conversations.
- **Local Model app** — the full BNLM loop in a window: paste or Groq-generate training text, pick a mixer (attention / linear / RWKV), initialize, train (single-threaded or data-parallel across Web Workers), generate, score, export as a quantized `.qlm1` file. Trained models can be **saved by name and reloaded after a refresh** — a trained model isn't a session-scoped toy, it persists.
- **Agentic tool-calling** — ask any AI Chat agent to "train a model on this text" or "generate from the local model," and it emits a structured tool call the client executes against the BNLM engine, reporting back into the chat. Agents can also emit `kernos.exec` to run real TypeScript in a sandbox for anything a single `bnlm.*` call doesn't cover.
- **Accounts** — real sign-up/sign-in via Supabase Auth, with chat history, the virtual filesystem, and saved models syncing across devices. Guest access stays available with no signup (data stays in that browser, metered to 15 min/day).
- **Terminal** — a real ephemeral sandboxed command executor, allowlisted and argument-sanitized, in a fresh function invocation per command. Signed-in accounts additionally get native `curl`/`dig`/`ping` with SSRF protection, plus `render <url>` for a headless-Chromium page load or screenshot.
- **Editor / CDE** — write a TSX applet and hit **Launch**: it compiles in-browser (Sucrase) and mounts live in its own window, inside a closed shadow root with a restricted kernel proxy.
- **Multi-Agent Workspace** — ask one question and get four specialist personas answering side by side, each on its own model.
- **Monitors** — a live bus traffic sniffer, an agent activity monitor (requests, streamed chars, round-trip latency, tool calls, errors), and system metrics read from real browser and app state.
- **Mobile** — full-screen single-app layout with bottom nav below 768px; drag/resize use Pointer Events so touch works.
- **Preferences** — theme, reduce-motion, terminal font size, default persona, boot sequence, and an analytics opt-out, all persisted locally and synced across tabs.

## What was cut, and why

The original Kernos OS design assumed a persistent Go binary: a WebSocket pub/sub bus, a SQLite vector-graph DB, a real package manager, WebRTC P2P, a "speculative execution" predictive engine, and nightly RLHF consolidation goroutines. None of that runs on stateless functions.

Two things originally cut have since shipped and are no longer missing: **accounts** (Supabase Auth, with guest access kept as a first-class fallback) and **dynamic TSX applet compilation** (which turned out to need no server at all — Sucrase runs in the browser). Full accounting is in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Deploying

1. Push to GitHub (already done for `main` — see `git remote -v`).
2. Import the repo in [Vercel](https://vercel.com/new).
3. Set `GROQ_API_KEY` as a project environment variable. Everything else is optional and degrades gracefully when unset — see `.env.example` for the full list (Supabase for accounts, `SUPABASE_SERVICE_ROLE_KEY` for the guest quota, `VITE_POSTHOG_KEY` for analytics, `VITE_DONATE_URL` for the support link).
4. Deploy. `vercel.json` already configures the COOP/COEP headers BNLM's parallel training needs, plus per-function timeout and memory budgets.

Note the `VITE_` prefix is **required and exact** for anything the browser reads — this is a Vite app, not Next.js, so `NEXT_PUBLIC_*` names are silently ignored with no build or runtime error.

The `render` terminal command needs a paid Vercel plan: Hobby's hard 10-second function limit can't fit a Chromium cold start plus a page load.

## Project layout

```
App.tsx, store.ts, types.ts       Kernos shell — windows, desktop, taskbar, mobile layout
apps/                             Window contents: Terminal, AIChat, LocalModel, Editor, FileSystem, CDE, monitors, ...
components/                       Boot sequence, window chrome, login, terms gate, tours
services/kernel.ts                Client-side pub/sub bus + fetch adapter to /api/*
lib/agents.ts                     The six agent personas (prompts + per-persona model routing)
lib/localModel.ts                 BNLM engine wrapper — init/train/generate/score/export/save/load
lib/appletCompiler.ts             In-browser TSX→JS (Sucrase), shared by applets and kernos.exec
lib/kernosExec.ts                 Sandboxed executor for agent-written TypeScript
lib/kernosTools.ts                Tool dispatch (bnlm.* and kernos.exec)
lib/auth.ts                       Supabase Auth + guest identity
lib/vfs.ts, chatStore.ts          Virtual filesystem + chat history (Supabase or local, by account)
lib/settings.ts                   User preferences (localStorage, cross-tab synced)
lib/networkCommands.ts            Native curl/dig/ping
lib/networkGuard.ts               SSRF protection for outbound requests
src/bnlm/                         The vendored BNLM engine (tensor/model/tokenizer/optimizer/workers)
supabase/schema.sql               Tables + RLS policies
api/chat.ts                       Groq streaming proxy (Edge function)
api/exec.ts                       Ephemeral sandboxed command exec (Node function)
api/browser-render.ts             Headless Chromium page render (Node function)
api/guest-usage.ts                Guest daily-quota accounting (Node function)
```

## Further reading

- [ARCHITECTURE.md](./ARCHITECTURE.md) — the actual current stack, and the map from the original Go-backed design
- [SECURITY.md](./SECURITY.md) — threat model, what's defended, and the known holes stated plainly
- [KERNOS_101.md](./KERNOS_101.md) — a from-scratch walkthrough of using the app
- [KERNOS_OS_WHITEPAPER.md](./KERNOS_OS_WHITEPAPER.md), [KERNOS_OS_RESEARCH_PAPER.md](./KERNOS_OS_RESEARCH_PAPER.md), [KERNOS_OS_VALUATION.md](./KERNOS_OS_VALUATION.md) — narrative/portfolio documents, updated to match what's actually built

## License

Apache 2.0.

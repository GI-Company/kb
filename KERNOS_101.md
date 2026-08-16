# Kernos + BNLM 101 — The Complete Beginner's Guide

> This is a browser-based AI workspace. Six Groq-backed agent personas live in the Chat app; a real, from-scratch trainable language model lives in the Local Model app and runs entirely in your tab — no GPU, no server round trip for inference.

---

## 🚀 Quick Start (2 minutes)

```bash
git clone https://github.com/GI-Company/kb.git
cd kb
npm install
cp .env.example .env.local
```

Edit `.env.local`:

```
GROQ_API_KEY=your-key-from-console.groq.com/keys
GROQ_MODEL=llama-3.3-70b-versatile
```

```bash
npm run dev
```

Open `http://localhost:3000`. That's it — no backend binary to build or run separately. Locally, a small dev-only Vite plugin runs the same `api/*.ts` functions Vercel would run in production, in-process.

---

## 🧠 What Makes This Different?

| Typical AI app | This |
|---|---|
| One model does everything | Six Groq personas (fast triage vs. deep review vs. chat vs. security vs. devops vs. code review) share one Groq-hosted model, distinguished only by system prompt |
| "Local AI" means a big model you have to install | A small model trains from random initialization **in the browser tab itself**, in seconds, on whatever text you paste in |
| Trained state is a session toy | Trained models can be **saved by name** and reloaded after a refresh (IndexedDB) |
| Cloud-only or offline-only | Both: Groq for fast/capable reasoning, BNLM for a zero-cost, offline-capable local specialist the agents can direct |

---

## 🏗️ Architecture at a Glance

```
┌───────────────────────────────────────────────────────────┐
│                   BROWSER (the "OS")                       │
│  Terminal │ AI Chat │ Local Model │ Editor │ Files │ CDE    │
├───────────────────────────────────────────────────────────┤
│         services/kernel.ts (client-side pub/sub bus)       │
├──────────────────────────┬──────────────────────────────────┤
│   lib/localModel.ts       │        fetch()                  │
│   → src/bnlm/* (runs      │                                  │
│     entirely in this tab) │                                  │
└──────────────────────────┴──────────────┬───────────────────┘
                                           ▼
                          POST /api/chat  │  POST /api/exec
                          (Vercel Edge)   │  (Vercel Node)
                                ▼          ▼
                          Groq Chat API   ephemeral sandboxed
                                          exec, fresh /tmp jail
```

Full detail: [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 🤖 The 6 AI Agents

Each agent has its own system prompt **and its own Groq model**, picked to match its job and how often it runs (see `lib/agents.ts` for the rate-limit table behind these choices). Each also has a fallback model tried once if the primary is rate-limited:

| Agent | Role | Model | What It Does |
|---|---|---|---|
| **Dispatcher** | Triage | `allam-2-7b` | Fires on nearly every action, so it gets the largest daily budget rather than the deepest reasoning. Plans DAGs, translates `? find large files` into a shell command, can call tools |
| **Architect** | Review | `openai/gpt-oss-120b` | Reviews plans and DAGs for safety and correctness |
| **Kernos Assistant** | Chat | `llama-3.3-70b-versatile` | Default conversational agent; can call tools |
| **DevOps Engineer** | Infra | `qwen/qwen3.6-27b` | Deployment/CI/CD advice, scoped to what this sandbox can actually run |
| **Security Auditor** | Defense | `openai/gpt-oss-safeguard-20b` | Security review — the safety-tuned model is a direct fit |
| **Code Review** | Quality | `openai/gpt-oss-120b` | Bug/perf/readability review |

Setting `GROQ_MODEL` overrides all of this and forces one model everywhere.

Open **Multi-Agent Workspace** to ask four of them the same question at once and compare answers side by side.

---

## 🧬 The Local Model App (BNLM)

Open **Local Model (BNLM)** from the taskbar. The loop:

1. **Get training text.** Paste your own, or click **Generate** next to "Generate dataset with Groq" — give it a topic and it'll ask Groq to write a short-story training set in the right format (blank-line-separated documents).
2. **Set hyperparameters.** `d_model`, `layers`, `heads`, `context`, mixer type (`attention` / `linear` / `rwkv`), and `workers` (>1 fans training out across data-parallel Web Workers instead of running on the main thread).
3. **Initialize**, then **Train**. Watch the loss sparkline drop in real time.
4. **Generate** from it, or **Export Int8** for a quantized inference-only `.qlm1` file you can download.
5. **Save** it by name — it'll show up in **Saved Models** and reload (weights, tokenizer vocab, and training text) even after you close the tab.

Every run and generation is logged to the **Run History** / **Generations** tabs at the bottom, persisted across reloads.

> **Why did I only get ~32 tokens?** The `attention` mixer uses learned *absolute* positional embeddings, so prompt + generated output can never exceed **Context Length**. With the default context of 48 and a 15-token prompt, the real ceiling is 33 no matter how many tokens you ask for — the app now tells you when this happens. Raise Context Length, shorten the prompt, or switch to the `linear` or `rwkv` mixer, which generate recurrently and have no such limit.

You can also drive all of this from **AI Chat** — ask the Dispatcher or Kernos Assistant to "train a model on this text about X" or "generate from the local model," and it'll do it and report back in the same conversation.

---

## 💻 Terminal

Filesystem commands (`ls`, `cd`, `cat`, `mkdir`, `touch`, `write`, `rm`, `mv`, `cp`) don't leave the browser at all — they run against your real, persistent VFS, so there's a working directory that means something and files that survive between commands. Pipes and redirection (`|`, `>`, `>>`) are composed client-side too, which is why those characters stay in the server's rejected-character list rather than being forwarded. Tab completion and history are wired to both.

Everything else is real command execution, allowlisted and sandboxed — each command runs in a fresh Vercel function invocation with its own temp jail, stripped environment, and a hard timeout. The allowlist is 27 coreutils, and every one of them was probed against the deployed function rather than assumed present. It used to carry 39: nine (`find`, `diff`, `hostname`, `which`, `ps`, `file`, `tar`, `gzip`, `jq`) simply aren't in the Lambda image, and `node`/`npm`/`npx` were dropped deliberately — arbitrary server-side code execution buys nothing when the jail is destroyed after every command, and running code belongs in the browser where it can't reach the server at all. `api/exec.ts` still detects a missing binary from the real spawn attempt, so the list can't silently rot.

Prefix input with `?` for natural-language translation — `? count the lines in notes.md` becomes `wc -l notes.md` and runs. The translator is its own persona (`agent-shell`) given the exact command list this shell has, so it won't reach for `find` or `jq`, which aren't installed; if a request can't be expressed here it says so instead of guessing. Translations that **modify files** (`rm`, `mv`, `cp`, `write`, `mkdir`, `touch`) are placed in the input for you to confirm rather than run automatically — the filesystem commands act on your real files now, so one model's reading of one ambiguous sentence shouldn't be able to delete them.

**Signed-in accounts** additionally get real network commands, which aren't shelled out to (that image has no `curl`) but reimplemented natively with SSRF protection:

```
curl https://example.com
dig example.com
ping example.com
render https://example.com              # headless Chromium, extracted text
render https://example.com --screenshot # ...or a PNG, inline in the terminal
```

`render` needs enough function budget for a Chromium cold start plus a page load: fine on Fluid compute / Active CPU billing, too tight on Hobby's hard 10-second limit.

Signed-in accounts also get **real CPython 3.14**, compiled to WebAssembly and running on a Web Worker in your own tab:

```
python -c "print(2 + 2)"
python analyze.py                       # the script comes from your VFS
cat log.txt | python -c "import sys; print(len(sys.stdin.read()))"
```

Files in the working directory are mapped in both ways: `open("notes.md")` reads your actual file, and `open("out.txt","w").write(...)` lands back in the real VFS too — but only if the script finishes without raising. Writes are staged in memory while the script runs and committed in one batch at the end; an exception partway through discards them entirely, so a script never leaves a half-written file behind. The round trip is scoped to that one flat directory the same way the read side always was — a script that creates a subdirectory has anything written into it silently excluded, with a note in stderr saying so, rather than a general filesystem mount. Because it's on a worker rather than the main thread, `Ctrl+C` genuinely kills it — a `while True: pass` is terminable and the UI keeps painting throughout.

Two things to know about the current shape. The ~13 MB runtime is served from our own origin (the CSP allows no CDN scripts, and COEP `require-corp` would refuse a cross-origin one anyway) and is fetched lazily on the first `python`, so guests and anyone who never uses it pay nothing. And it is **standard-library only for now**: package wheels aren't in the npm package and could only come from a CDN, which would mean widening `connect-src`, so `pip install` is off behind a single documented flag in `lib/pythonRuntime.ts`. The stdlib is complete — `json`, `re`, `math`, `csv`, `datetime`, `statistics`, `sqlite3` and the rest all work with no install step — and `pip list` shows what enabling installs would add.

---

## 🧩 Building Applets

Open **Code Editor** or **CDE**, write a React component, and hit **Launch**. It compiles in your browser (no server round trip) and opens as a live window.

```tsx
import React, { useState } from 'react';

export default function MyApplet() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(c => c + 1)}>Clicked {count} times</button>;
}
```

Applets run in a closed shadow root with a restricted kernel proxy — they can publish and subscribe on the bus, but not spawn processes or run tasks. It's a single-file compiler, not a bundler: `react` and `lucide-react` are provided, other imports are stripped.

---

## 🔐 Security Model

- **Command allowlist + argument sanitization** — rejects `& | ; \` $ ( ) < >`, path traversal (`..`), and absolute paths, same rules as the original design
- **Fresh sandbox per command** — a `mkdtemp`'d temp dir per invocation, stripped environment, hard timeout
- **`GROQ_API_KEY` stays server-side** — only `api/chat.ts` (an Edge function) ever sees it
- **Accounts** — Supabase Auth handles sign-up/sign-in and password storage; this codebase never stores a password. Row-level security scopes every table to `auth.uid()`. Guest access remains available and stays entirely in the browser.
- **Network commands are gated** — `curl`/`dig`/`ping`/`render` require a signed-in account, and every outbound request is checked against private/loopback/link-local ranges on each redirect hop. Known gap: no DNS-rebinding protection.
- **Applets and agent code run sandboxed** — a closed shadow root, no real `eval`, no raw imports, a restricted kernel proxy that blocks destructive topics, plus a wall-clock timeout and per-execution call budgets. The timeout can't preempt genuinely synchronous code (single-threaded JS); the budgets are what bound a runaway loop.

---

## 📁 Project Structure

```
kernos-bnlm/
├── App.tsx, store.ts, types.ts    # window manager, desktop, taskbar
├── apps/                          # Terminal, AIChat, LocalModel, Editor, FileSystem, CDE, ...
├── components/                    # boot sequence, window chrome, context menus
├── services/kernel.ts             # client-side bus + fetch adapter
├── lib/
│   ├── agents.ts                  # the 6 personas
│   ├── localModel.ts              # BNLM engine wrapper
│   ├── modelRegistry.ts           # IndexedDB named-model persistence
│   ├── localModelHistory.ts       # run/generation history
│   ├── vfs.ts, chatStore.ts       # client-side virtual FS + chat history
├── src/bnlm/                      # the vendored BNLM engine
└── api/
    ├── chat.ts                    # Groq streaming proxy (Edge)
    └── exec.ts                    # ephemeral sandboxed exec (Node)
```

---

## 🔧 Configuration

Everything is env vars, set in `.env.local` for dev or the Vercel project settings for production. Only the first is required; everything else degrades gracefully when unset (no accounts, no analytics, no donate button, unlimited guest time). See `.env.example` for the annotated full list.

```
GROQ_API_KEY=...              # required — server-side only, never exposed to the client
GROQ_MODEL=...                # optional — forces one model for every persona,
                              #   overriding lib/agents.ts's per-persona routing
VITE_SUPABASE_URL=...         # optional — enables real accounts + cross-device sync
VITE_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=... # optional, server-side only — guest daily quota
VITE_POSTHOG_KEY=...          # optional — product analytics
VITE_DONATE_URL=...           # optional — shows the support link in Settings
```

The `VITE_` prefix is **required and exact** for anything the browser reads. This is a Vite app, not Next.js: `NEXT_PUBLIC_*` names are silently ignored, with no error at build or runtime.

---

## 🧪 Running Tests

```bash
npm test
```

Runs the Vitest suite (component tests under `apps/*.test.tsx`, `components/**/*.test.tsx`).

---

## 📖 Further Reading

- [ARCHITECTURE.md](./ARCHITECTURE.md) — the current stack, and what changed from the original Go-backed design
- [KERNOS_OS_WHITEPAPER.md](./KERNOS_OS_WHITEPAPER.md), [KERNOS_OS_RESEARCH_PAPER.md](./KERNOS_OS_RESEARCH_PAPER.md), [KERNOS_OS_VALUATION.md](./KERNOS_OS_VALUATION.md) — narrative/portfolio documents

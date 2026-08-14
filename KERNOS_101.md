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

Every agent shares one Groq-hosted model (`GROQ_MODEL`) and is distinguished purely by its system prompt (`lib/agents.ts`):

| Agent | Role | What It Does |
|---|---|---|
| **Dispatcher** | Triage | Fast responses; can direct the Local Model (BNLM) tool; also translates natural-language terminal input (`? find large files`) into a shell command |
| **Architect** | Review | Reviews task/DAG plans for safety and correctness |
| **Kernos Assistant** | Chat | Default conversational agent; can also direct the Local Model tool |
| **DevOps Engineer** | Infra | Deployment/CI/CD advice, scoped to what this sandboxed terminal can actually run |
| **Security Auditor** | Defense | Code security review, vulnerability scanning |
| **Code Review** | Quality | Bug/perf/readability review, can read attached images |

---

## 🧬 The Local Model App (BNLM)

Open **Local Model (BNLM)** from the taskbar. The loop:

1. **Get training text.** Paste your own, or click **Generate** next to "Generate dataset with Groq" — give it a topic and it'll ask Groq to write a short-story training set in the right format (blank-line-separated documents).
2. **Set hyperparameters.** `d_model`, `layers`, `heads`, `context`, mixer type (`attention` / `linear` / `rwkv`), and `workers` (>1 fans training out across data-parallel Web Workers instead of running on the main thread).
3. **Initialize**, then **Train**. Watch the loss sparkline drop in real time.
4. **Generate** from it, or **Export Int8** for a quantized inference-only `.qlm1` file you can download.
5. **Save** it by name — it'll show up in **Saved Models** and reload (weights, tokenizer vocab, and training text) even after you close the tab.

Every run and generation is logged to the **Run History** / **Generations** tabs at the bottom, persisted across reloads.

You can also drive all of this from **AI Chat** — ask the Dispatcher or Kernos Assistant to "train a model on this text about X" or "generate from the local model," and it'll do it and report back in the same conversation.

---

## 💻 Terminal

Real command execution, allowlisted and sandboxed — each command runs in a fresh Vercel function invocation with its own temp jail, stripped environment, and a hard timeout. The allowlist is deliberately conservative (coreutils + `node`/`npm`/`npx`) since Vercel's Node runtime doesn't ship git/python/go/rust/ffmpeg the way a real host would; `api/exec.ts` also checks each command actually exists before running it, so an allowlisted-but-missing command fails cleanly instead of 500ing.

Prefix input with `?` for natural-language translation (`? show large files` → the Dispatcher translates it to a real command and runs it).

---

## 🔐 Security Model

- **Command allowlist + argument sanitization** — rejects `& | ; \` $ ( ) < >`, path traversal (`..`), and absolute paths, same rules as the original design
- **Fresh sandbox per command** — a `mkdtemp`'d temp dir per invocation, stripped environment, hard timeout
- **`GROQ_API_KEY` stays server-side** — only `api/chat.ts` (an Edge function) ever sees it
- **No accounts in v1** — single "guest" identity, no passwords stored anywhere; a real account system (Supabase Auth) is a planned follow-up, not built yet

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

Everything is env vars, set in `.env.local` for dev or the Vercel project settings for production:

```
GROQ_API_KEY=...      # required — never exposed to the client
GROQ_MODEL=...        # optional, defaults to llama-3.3-70b-versatile
```

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

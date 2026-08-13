# KernOS 101 — The Complete Beginner's Guide

> **KernOS** is an AI-native operating system that runs entirely in your browser. The AI isn't an app — it **is** the kernel.

---

## 🚀 Quick Start (60 Seconds)

```bash
# 1. Prerequisites: Install LM Studio and load these models:
#    - mistralai/codestral-22b-v0.1 (LLM)
#    - text-embedding-nomic-embed-text-v1.5 (Embeddings)

# 2. Build & Boot
cd server
go build -o kernos_server
./kernos_server

# 3. Open the browser URL shown in the boot banner
#    Default: http://127.0.0.1:8080

# 4. Authenticate with the Root Token printed in the terminal
```

That's it. You now have a fully operational AI operating system.

---

## 🧠 What Makes KernOS Different?

| Traditional OS | KernOS |
|---|---|
| AI is an app you open | AI **is** the kernel |
| File search by name | File search by **meaning** (vector similarity) |
| Tasks crash on failure | Tasks **self-heal** via DAG mutation |
| Static memory | Memory **decays and reinforces** like a brain |
| Cloud-dependent AI | **100% offline**, runs on local models |

---

## 🏗️ Architecture at a Glance

```
┌─────────────────────────────────────────────────┐
│                  BROWSER UI (React)              │
│  Terminal │ AI Chat │ VFS │ Task Runner │ Metrics │
├─────────────────────────────────────────────────┤
│              WebSocket IPC Envelope Bus           │
├─────────────────────────────────────────────────┤
│                 GO MICROKERNEL                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ 6 AI     │ │ Task     │ │ Vector Engine    │ │
│  │ Agents   │ │ Engine   │ │ (GraphRAG)       │ │
│  ├──────────┤ ├──────────┤ ├──────────────────┤ │
│  │Codestral │ │ DAG Exec │ │ Nomic Embeddings │ │
│  │  22B     │ │ + Mutex  │ │ + SQLite Graph   │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
├─────────────────────────────────────────────────┤
│  LM Studio (Local)  │  SQLite (sys.db, vectors) │
└─────────────────────────────────────────────────┘
```

---

## 🤖 The 6 AI Agents

Every agent runs on **Codestral 22B** via LM Studio and communicates through the IPC Envelope Bus.

| Agent | Role | What It Does |
|---|---|---|
| **Dispatcher** | Triage | Converts user requests into executable Task DAGs |
| **Architect** | Validation | Reviews DAGs for safety, cycles, and injection risks |
| **Kernos Assistant** | Chat | Conversational AI companion — never generates DAGs |
| **Code Review** | Quality | Reviews code for bugs, performance, and best practices |
| **Security Auditor** | Defense | Scans for vulnerabilities, injection, and hardcoded secrets |
| **DevOps Engineer** | Infra | Handles deployment, CI/CD, and system administration |

---

## 💻 Terminal Commands

Type `help` in the terminal to see all available commands. Here are the highlights:

```
📁 FILE OPS      ls, cat, head, tail, find, tree, cp, mv, diff
📝 TEXT           echo, grep, sed, awk, cut, jq
🖥️ SYSTEM         uname, uptime, df, du, ps, pwd, whoami
🌐 NETWORK        ping, curl, dig, nslookup
🛠️ DEV TOOLS      git, go, node, npm, python3, make, cargo
📦 ARCHIVE        tar, gzip, zip, unzip
```

All commands run inside a **sandboxed jail** — no command can access the host filesystem directly.

---

## 🕸️ Core Features

### 1. Semantic VFS (Virtual File System)
Search your codebase by **meaning**, not just filenames. The Vector Engine continuously indexes your workspace using Nomic embeddings, so searching "authentication logic" returns the actual auth files — even if they're named `sysdb.go`.

### 2. GraphRAG (Knowledge Graph)
While you work, the **GraphBuilder daemon** reads your source code in the background, extracts entities (functions, structs, modules) and their relationships, and stores them in a SQLite knowledge graph. When the Architect Agent makes decisions, it traverses this graph for deep context.

### 3. Self-Healing DAG Execution
When a task fails, the system doesn't just throw an error:
1. The **Architect** queries the Knowledge Graph for similar past failures
2. It synthesizes **two alternative recovery commands**
3. Both branches **race in parallel** inside secure sandboxes
4. The winning branch is **grafted back** into the live DAG

### 4. Synaptic Memory (Hebbian Learning)
Every piece of indexed code has a **synaptic weight** that:
- **Decays** over time (like human memory forgetting unused information)
- **Reinforces** when accessed (frequently-used context gets boosted)
- Is governed by the equation: `W_new = W_old × e^(-λ × Δt)`

### 5. Neuroplasticity Engine
Three concurrent learning pipelines run in the background:
- **Pipeline 1:** Reward Signals (4 workers)
- **Pipeline 2:** Error Pattern Recognition (2 workers)
- **Pipeline 3:** Embedding Ingestion (3 workers)

---

## 🔐 Security Model

KernOS uses a **Zero-Trust** architecture:

- **Root Token** — Generated on first boot, stored in `~/.kernos/sys.db`
- **JWT Sessions** — Ephemeral session cookies with 30-day expiry
- **3-Second Auth Timeout** — Unauthenticated WebSocket connections are killed
- **Command Allowlist** — Only explicitly whitelisted commands can execute
- **Sandboxed Jails** — Every command runs in an isolated temp directory
- **Input Sanitization** — Blocks `&`, `|`, `;`, `` ` ``, `$`, `()`, `<`, `>` characters
- **Path Traversal Protection** — `..` and absolute paths are rejected

---

## 📁 Project Structure

```
aether-os/
├── server/                  # Go backend (the kernel)
│   ├── main.go              # Core server, IPC bus, WebSocket handler
│   ├── task_engine.go       # DAG executor + self-healing mutation
│   ├── vector_engine.go     # Semantic vector DB + embeddings
│   ├── vector_graph_builder.go  # GraphRAG entity extractor
│   ├── embedded_agents.go   # AI agent orchestration
│   ├── neuroplasticity.go   # Concurrent learning pipelines
│   ├── sysdb.go             # Persistent auth + config DB
│   ├── consolidation.go     # RLHF consolidation engine
│   └── agents.yaml          # Agent configuration
├── apps/                    # React UI applications
│   ├── Terminal.tsx          # Terminal emulator
│   ├── AIChat.tsx            # AI chat interface
│   ├── SemanticVFS.tsx       # Semantic file browser
│   ├── TaskRunner.tsx        # DAG visualization
│   └── SystemMetrics.tsx     # System monitoring
├── components/ui/           # Shared UI components
├── store.ts                 # Zustand state management
├── types.ts                 # TypeScript type definitions
└── ARCHITECTURE.md          # Technical architecture doc
```

---

## 🔧 Configuration

### Changing the LLM Model
Edit `server/agents.yaml` and update the `model:` field for each agent:
```yaml
model: "mistralai/codestral-22b-v0.1"  # Current
model: "qwen/qwen3.5-9b"               # Alternative (lighter)
```

### Changing the LM Studio URL
```bash
./kernos_server -lm http://localhost:1234/v1/chat/completions
```

### Changing the Workspace Directory
```bash
./kernos_server -workspace /path/to/your/project
```

---

## 🧪 Running Tests

```bash
cd server
go test -v -race -timeout 30s ./...
```

Tests use `TestingMode` to bypass live LLM calls and run entirely offline.

---

## 📖 Further Reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — Technical deep-dive into the layered stack
- [KERNOS_OS_WHITEPAPER.md](KERNOS_OS_WHITEPAPER.md) — The Unconventional Trinity
- [KERNOS_OS_RESEARCH_PAPER.md](KERNOS_OS_RESEARCH_PAPER.md) — Academic treatment
- [KERNOS_OS_VALUATION.md](KERNOS_OS_VALUATION.md) — Market analysis and commercialization

---

*Built with Go, React, SQLite, Codestral 22B, and Nomic Embeddings. Zero cloud dependencies.*

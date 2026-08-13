<div align="center">

# 🧠 Kernos OS

**The Cognitive Microkernel & Autonomous Operating System**

[![Go](https://img.shields.io/badge/Go-1.23+-00ADD8?style=flat-square&logo=go&logoColor=white)](https://go.dev)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![License](https://img.shields.io/badge/License-Apache_2.0-orange?style=flat-square)](LICENSE)

*The world's first operating system where AI agents are kernel-level citizens — not applications.*

> **Why "Kernos"?**  
> In ancient Greek antiquity, a *kernos* was a unique pottery vessel featuring a central base with multiple distinct, isolated cups attached to it. It perfectly represents this OS's architecture: a central, high-speed Go **microkernel** acting as the foundation, holding multiple isolated, autonomous AI **agents** and sandboxes that operate together as a single cognitive entity.

</div>

<br />

<div align="center">
  <img src="kernos_demo.webp" width="100%" alt="Kernos OS Demo" />
</div>

<br />

---

## 🌌 The Grand Vision (The Full Concept)

For decades, Operating Systems have been static managers of hardware: allocating memory, scheduling threads, and providing a file system. Artificial Intelligence has merely been treated as another user-space application sitting on top of this legacy foundation. 

**Kernos OS flips this paradigm.**

What if the OS itself was fundamentally intelligent? What if the kernel didn't just schedule CPU ticks, but actively reasoned about the user's intent? 

Kernos is built on the philosophy of treating the computer not as a dumb calculator, but as a **Digital Organism**. It replaces rigid directory trees with high-dimensional **Vector Graph Memory** that decays and reinforces like human synapses. It replaces crash-prone scripts with **Self-Healing DAGs** (Directed Acyclic Graphs) that conceptually mutate and race parallel recovery branches when a command fails. 

In Kernos, there is no "AI Assistant App." Instead, a federation of specialized **kernel-level AI Agents** (Dispatcher, Architect, Security Auditor, etc.) continuously monitor a high-speed inter-process communication (IPC) bus, evaluating everything from terminal keystrokes to file system writes in real-time. 

### 📍 Current Status: Where is the Project At? (March 2026)

Kernos is currently in an **Advanced Prototype / Alpha Phase**. It is a fully functional, self-contained system demonstrating the viability of the "Cognitive Microkernel." 

**What is actually working today:**
- **The Core Microkernel (Go):** Fully handles WebSocket IPC, state management, and the `agent.internal` communication bus.
- **The PWA Desktop Environment (React):** A highly polished, enterprise-grade, glassmorphism UI featuring a cinematic UEFI boot simulation, advanced window manager with fluid animations, a working dock/taskbar, and customized context menus replacing browser defaults.
- **Embedded AI Agents:** 6 distinct AI personas running concurrently, parsing the pub/sub bus and making autonomous decisions. They successfully delegate tasks to each other based on heuristically calculated "confidence scores."
- **Terminal & Application Sandboxing:** Real commands are executed locally in secure, ephemeral directories. 
- **The Code Development Environment (CDE):** A fully custom, in-browser IDE with file tree parsing, animated syntax cursors, and active line tracking.
- **Package Manager:** A working implementation to download, install, and track real binaries (Python, Go, Node, ripgrep) directly to the OS.
- **GraphRAG & Vector Memory:** A functioning Nomic embedding engine indexing the workspace into a SQLite vector-graph database for semantic context retrieval.

**What is coming next (Roadmap):**
- **Deep System Speculation:** Fully implementing 0-latency predictive command execution.
- **P2P Collaboration:** WebRTC multi-agent/multi-user portals for distributed node computing.
- **True WebAssembly Isolation:** Migrating current JS sandboxing into pure WASM targets.

---

## 🧬 Core Architecture: The "Unconventional Trinity"

Kernos OS discards traditional Unix and Windows paradigms. Instead of treating AI as an external application, Kernos wires cognitive routing directly into the Kernel Space:

### 1. Vector Graph Memory
A traditional OS organizes memory via a hierarchical file system tree. Kernos replaces this with a mathematical **Vector Graph**. Keystrokes, file contents, and system outputs are mapped into a localized Nomic 768-dimensional latent space. The kernel retrieves contextual data by semantic resonance, rather than exact path matching.

### 2. Speculative RAG Execution
Kernos utilizes local LLMs for **Speculative Execution**. The OS evaluates partial terminal input, predicts the most likely complete command, and silently pre-executes it in an invisible sandbox jail. When the user submits the command, the OS yields the pre-computed `stdout` with perceived zero-latency.

### 3. Concurrent DAG Mutation & Shared Contexts
Traditional shell scripts run sequentially and fail abruptly. Kernos executes multi-step objectives using **Directed Acyclic Graphs (DAGs)** with **Shared Memory Contexts** (`$CTX_<nodeID>_OUT`), allowing nodes to securely pass sandboxed outputs to downstream dependencies. If a node fails during execution, the "Architect" agent synthesizes multiple divergent recovery paths. The engine executes these alternative branches in parallel; the first to exit successfully collapses the state and is grafted back into the DAG.

---

## ⚡ The Neuroplasticity Engine

**A novel, real-time concurrent learning system** — the first of its kind at the OS kernel level.

While the existing Synaptic Consolidation runs nightly (the "sleep state"), the Neuroplasticity Engine processes learning signals in **real-time** using Go's concurrency primitives (the "awake state"):

| Pipeline | Workers | What It Does |
|---|---|---|
| **Reward Signals** | 4 goroutines | Scores every agent response and task execution, generates micro-rules for strongly positive/negative interactions |
| **Error Pattern Recognition** | 2 goroutines | Classifies terminal errors into categories. When the same error class occurs 3+ times, synthesizes a preventive micro-rule |
| **Embedding Ingestion** | 3 goroutines | Continuously indexes conversations and terminal outputs into Vector Memory, keeping the semantic graph fresh |

Micro-rules are flushed to disk every 5 minutes and injected into all agent prompts. The nightly consolidation handles compression and deduplication.

---

## 🤖 Multi-Agent Architecture (6 Agents, 2 Models)

Kernos runs **6 specialized AI agents** as kernel-level goroutines — all using just **2 local LLM models** via LM Studio. Each agent has a unique role defined by its system prompt, not by its model:

| Agent | Model | Role |
|---|---|---|
| **Dispatcher** | Qwen3.5-9B | Fast triage — converts requests to DAGs, evaluates system events |
| **Architect** | Qwen3.5-9B | Deep review — validates DAGs, synthesizes recovery paths, navigates GraphRAG |
| **Kernos Assistant** | Qwen3.5-9B | Conversational AI — multi-turn chat with 10-turn sliding context window |
| **DevOps Engineer** | Qwen3.5-9B | Infrastructure specialist — deployment, CI/CD, system administration |
| **Security Auditor** | Qwen3.5-9B | Vulnerability detection — code security review, threat modeling |
| **Code Review** | Qwen3.5-9B | Code quality — identifies bugs, performance issues, and best practices |

### Agent-to-Agent Communication
Agents communicate autonomously via the `agent.internal` bus topic. When an agent produces a low-confidence response (< 0.5), it automatically delegates to the Architect for a second opinion — no human intervention required.

### Proactive Initiative
The Dispatcher monitors terminal output in real-time. When it detects errors (`panic:`, `build failed`, `module not found`, etc.), it proactively generates a fix suggestion and pushes it to the UI.

---

## ✨ Complete Subsystem Map

| Subsystem | Implementation |
|---|---|
| 🧠 **Neuroplasticity Engine** | Real-time concurrent learning via 3 Go channel pipelines (9 worker goroutines) |
| 🤖 **6 Embedded Agents** | Specialist AI agents as kernel goroutines with agent-to-agent delegation |
| 👻 **Speculative Execution** | Predict → Shadow Execute → 0ms cache hit on terminal commands |
| 🧬 **Self-Healing DAGs** | Quantum parallel race-condition mutation on task failure |
| 🎯 **Autonomous ReAct Loop** | Abstract goal → 10-step autonomous command execution |
| 💬 **Conversational AI** | Multi-turn chat with 10-turn sliding context window |
| 🔍 **Confidence Scoring** | Heuristic self-assessment with automatic second opinion |
| 📦 **Package Manager** | 9 real packages with install/uninstall, OS/arch detection, installed state persistence |
| 🧠 **Vector Memory** | Nomic 768-dim embeddings with semantic search and weight decay |
| 🌙 **RLHF Consolidation** | Nightly contrastive reinforcement with synaptic weight compression |
| 🔮 **Hallucinatory RAG** | Sensory Cortex pre-warms semantic cache from predicted future context |
| 🖼️ **VL Image Analysis** | Multimodal base64 image → Qwen-VL visual analysis |
| 🛡️ **WASM Applets** | React components compiled into sandboxed WebAssembly containers |
| 🌐 **P2P WebRTC** | Peer-to-peer data channels for distributed kernel communication |
| ⏪ **Temporal Branching** | Immutable timeline of all system state mutations |
| 🔐 **Auth** | Google/GitHub OAuth + guest fallback + JWT sessions |

---

## 📦 Package Manager

The Kernos Package Manager downloads real binaries from GitHub releases and official CDNs, with automatic OS/architecture detection:

| Package | Version | macOS ARM64 | macOS x86 | Linux x64 |
|---|---|---|---|---|
| Python | 3.12.2 | ✅ | ✅ | ✅ |
| Node.js | 20.11.1 | ✅ | ✅ | ✅ |
| Go | 1.22.0 | ✅ | ✅ | ✅ |
| Rust | 1.76.0 | ✅ | ✅ | ✅ |
| Deno | 1.40.5 | ✅ | ✅ | ✅ |
| FFmpeg | 6.0.0 | ✅ | ✅ | ✅ |
| SQLite | 0.21.6 | ✅ | ✅ | ✅ |
| ripgrep | 14.1.0 | ✅ | ✅ | ✅ |
| jq | 1.7.1 | ✅ | ✅ | ✅ |

---

## 🚀 Installation

The entire Operating System — the Go microkernel, the React graphical environment, the Nomic vector database, and the WebSocket Bus — compiles into a **single binary** with zero external dependencies.

### 1. LM Studio Setup (Required for AI)

1. Download and install **[LM Studio](https://lmstudio.ai/)**
2. Download these models:
   - `qwen/qwen3.5-9b` — Unified Deep Reasoning & GraphRAG Extraction Model
   - `text-embedding-nomic-embed-text-v1.5` (Load 6x parallel instances) — High-throughput parallel vector embeddings
3. Start the **Local Server** on `http://localhost:1234/v1`

> **Alternative Models:** Update the `model` strings in `server/agents.yaml` to match your preferred models.

### 2. Build & Run

```bash
git clone https://github.com/GI-Company/kernos-os.git
cd kernos-os

# Install frontend dependencies
npm install

# Build the Go microkernel
cd server
go build -o kernos_server

# Start the kernel
./kernos_server -lm-url http://localhost:1234/v1/chat/completions
```

Open **http://localhost:8080** in your browser.

---

## 🏗️ Envelope Protocol

Kernos communicates exclusively via typed **Envelope** messages across a high-performance pub-sub bus:

```typescript
interface Envelope {
  topic: string;     // e.g., "agent.chat", "task.run", "neuro.learn"
  from: string;      // The sender (agent ID, "kernel", "ui")
  to?: string;       // Direct routing target
  payload: any;      // The dynamic payload
  time: string;      // ISO 8601 timestamp
}
```

Every agent, every UI component, every terminal command, and every learning signal flows through this single nervous system. Nothing is hidden. Everything is observable.

---

## 📚 Documentation

- [Research Paper](./KERNOS_OS_RESEARCH_PAPER.md) — Formal academic exploration of the Cognitive Microkernel framework
- [Whitepaper](./KERNOS_OS_WHITEPAPER.md) — Deep dive into kernel architecture and intelligent subsystems
- [Commercial Analysis](./KERNOS_OS_VALUATION.md) — Market viability and technical review

---

## 📜 License

Apache 2.0 — Open Source Cognitive Computing.

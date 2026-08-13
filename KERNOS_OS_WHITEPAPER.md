# KERNOS OS: The Cognitive Microkernel

## Abstract & Theoretical Framework
**Revision:** 2.0.0-FINAL
**Date of Publication:** March 2026
**Author:** Kernos Foundation

### 1. The Death of the Dumb Terminal
For fifty years, operating systems have functioned as deterministic state machines. From UNIX to Windows, the OS waits for an explicit command, executes it, and returns the output. Historically, Artificial Intelligence has been integrated as an external application layer entirely disconnected from the kernel's process scheduler, memory manager, and filesystem.

**Kernos OS explores an alternative paradigm.** It is a browser-based operating system simulation built with a Go microkernel and a React frontend. The primary research goal is to demonstrate how cognitive routing, vector memory, and speculative execution can be integrated directly into the kernel's IPC layer, transforming the computing device into an anticipating intellectual partner.

---

## 2. The Unconventional Trinity Architecture

Kernos OS Abandons POSIX conventions in favor of the **Unconventional Trinity**:

### I. The Synaptic Vector Graph (Digital Memory)
Traditional operating systems use hierarchical folder structures (e.g., `/usr/bin/`, `C:\Windows`). This is an archaic data structure. Humans do not remember information by alphabetical paths. 
Kernos OS replaces the File Allocation Table with a **Synaptic Vector Graph**. Every file, command output, and system configuration is continuously ingested into a 768-dimensional latent space using embedded Nomic text embeddings. 
**The Result:** The OS experiences "Digital Memory." The user does not ask "where is file X?" The OS already knows, because the mathematical resonance between the user's current task and the historical file brings the memory to the forefront of the cognitive context window before the user explicitly requests it.

### II. GraphRAG & Speculative Execution (Zero-Latency Anticipation)
In addition to traditional vector search, Kernos OS utilizes **GraphRAG**. A background Qwen3.5-9B daemon continuously reads Nomic-vectorized text chunks and extracts structural entities and relationships into a SQLite Knowledge Graph. This provides the Architect Agent with omniscient network topology awareness of the entire codebase, eliminating "lost in the middle" context collapse.
Simultaneously, rather than waiting for user input, the Dispatcher Agent evaluates partial keystrokes and context to synthesize probable next commands, executing them in an isolated 10-second `tmp` jail. If the user hits 'Enter' on the predicted command, the kernel returns the pre-computed `stdout` instantly via "Speculative Execution".

### III. Shared Memory Contexts & Concurrent DAG Mutation
Sequential bash scripts are inherently brittle. Kernos approaches multi-step operations using Directed Acyclic Graphs (DAGs) orchestrated by an autonomous Task Engine. To ensure true pipeline cohesion, the OS implements **Shared Memory Contexts**, where node `stdout` is securely injected into downstream sandbox execution environments via `$CTX_<nodeID>_OUT` environment variables.
If an intermediate node fails, the Task Engine prompts the Architect to synthesize divergent recovery paths. The engine executes these branches concurrently in separate goroutines. The first branch to exit successfully collapses the state (a parallel race-condition), dynamically grafting the winning node into the DAG.

### IV. Contrastive RLHF (Scalar Reward Memory)
To ensure the system improves over time, Kernos utilizes a nightly consolidation routine. Every executed DAG is logged into a local SQLite database with a scalar reward (+1.0 for success, -1.0 for failure/timeout). 
During idle periods, the Architect Agent analyzes these trajectories, contrasting the high-reward "Golden Paths" against the negative-reward "Anti-Patterns." It synthesizes these gradients into actionable structural rules, appending them directly to the system prompt matrix of all embedded agents to permanently alter their behavior.

---

## 3. The 19MB Single-Binary Distribution

Kernos OS proves that cognitive computing does not require bloat. The entire environment compiles into a **19 MB statically-linked binary** via Go `//go:embed`.

Inside this single binary lives:
1. The WebSocket IPC Message Bus
2. The Go-SQLite RLHF Telemetry Database
3. The Nomic Vector Search Engine
4. The React-based Graphical Desktop Environment
5. The Speculative Execution "Shadow" Engine

The user hits a local URL (`http://localhost:3000`), and a full Window Manager, Code Editor, and Subsystem Telemetry dashboard launches inside the browser. By rendering the desktop in the DOM and isolating actual execution to the Go backend, Kernos OS attains zero-trust sandboxing.

---

## 4. WebRTC Peer-to-Peer Data Channels

Kernos OS implements decentralized collaboration via direct **P2P WebRTC DataChannels**. 
The Go backend (`p2p_gateway.go`) acts as a signaling relay, allowing two browser clients to exchange ICE candidates and SDP offers/answers using a 4-digit PIN. Once the connection is established, the WebRTC channel bridges the WebSocket buses of the two distinct OS instances. A command typed in a shared terminal on User A's machine executes simultaneously on User B's machine, governed by strict topic allowlists. 

---

## 5. Epistemological Security (The Shadow DOM)

Security in Kernos OS is handled via **Capability Hashes** attached to every JSON `Envelope` on the kernel bus. Furthermore, third-party user applets are compiled natively via embedded `esbuild` and executed inside a strict `ShadowRoot` DOM jail. This ensures zero data bleed. Applets cannot read the OS state unless explicitly granted semantic access.

---

## 6. The Verdict: Intelligent Subconscious Infrastructure

Kernos OS is not an operating system *with* AI. It is an operating system *made of* AI. By sinking cognitive routing, vector embedding, and DAG mutation into the very bottom layers of the Kernel, Kernos transforms the computing device from a passive tool into an active, anticipating intellectual partner. 

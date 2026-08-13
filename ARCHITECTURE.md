# The Kernos-OS Architecture Stack

When you map LLM agentic workflows directly onto POSIX operating system layers, you get a highly resilient, self-healing, multi-modal system. Here is what the full architectural stack of this paradigm looks like, visualized from the hardware level up to user space.

```text
[ USER SPACE ]       CLI | Chat UI | API Endpoints
-------------------------------------------------------------------------
[ PROCESS ]       System 1 (Triage)       |  System 2 (Heavy Logic)
[ SCHEDULER ]     Qwen3.5-9B              |  Qwen3.5-9B
                  (Dispatcher/Review)     |  (Architect/DevOps/Security)
                  DAG Generator           |  MCTS / Execution Verification
-------------------------------------------------------------------------
[ SYSCALLS & ]    JSON Schema Enforcement |  Tool Execution Framework
[ DRIVERS ]       Ephemeral Docker API    |  Local Bash / Host File I/O
-------------------------------------------------------------------------
[ MEMORY & ]      KV Cache (Active RAM)   |  GraphRAG (Structured FS)
[ FILESYSTEM ]    Context Manager         |  SQLite (Entities & Edges)
                  Nomic x6 (Fast Paging)  |  Qwen3.5-9B (Entity Extractor)
-------------------------------------------------------------------------
[ KERNEL & ]      Go Event Bus (Message Broker & State Management)
[ INTERRUPTS ]    Neuroplasticity Engine (errorChan, rewardChan, Rules)
-------------------------------------------------------------------------
[ FIRMWARE ]      llama.cpp / Inference Server (GPU VRAM Management)
```

## Layer Breakdown: How It Operates

### 1. Layer 0: Firmware & "Hardware" (The Inference Layer)
* This is the underlying inference engine (like `llama.cpp` or LM Studio) managing the GPU VRAM.
* It holds the model weights in memory so the Kernel doesn't have to reload them for every task.
* **Active Nodes:** Qwen3.5-9B (Unified Reasoning/Extraction) and 6x Nomic-Embed (Parallel Vectorization).

### 2. Layer 1: The Kernel & Interrupts (The Go Core)
* **The Bus:** The Go application acts as the kernel. It never generates text; it strictly routes `Envelope` messages between agents, memory, and tools.
* **Interrupt Controller (Neuroplasticity Engine):** When a process (agent) fails or hits a terminal error, an "interrupt" is sent to the `errorChan`. The Neuroplasticity Engine pauses the standard flow, synthesizes a micro-rule using Qwen3.5, and updates the weights.

### 3. Layer 2: Memory Management & Filesystem (The Subconscious)
* **Active RAM:** The LLM context window. The Kernel manages what gets injected into the prompt.
* **The Swap File / Indexing:** Nomic-Embed continuously runs in the background, converting files and logs into vectors.
* **The Filesystem (GraphRAG):** The Architect doesn't just read raw text; it navigates a structured SQLite Knowledge Graph (`entities` and `relationships`), giving it structural awareness of the entire codebase and OS state.

### 4. Layer 3: Process Scheduler & Syscalls (The Execution Layer)
* **The Scheduler:** When a user request comes in, the DAG (Directed Acyclic Graph) router determines the execution path.
* **Unified Intelligence Core:** Immediate triage, complex coding, GraphRAG querying, and security verification are all unified under the powerful Qwen3.5-9B model for maximum accuracy.
* **Syscalls:** To interact with the host machine, agents cannot just type commands. They must output strict JSON matching predefined schemas—these are the "system calls" the Go kernel translates into actual Bash or Docker commands (the "Device Drivers").

### 5. Layer 4: User Space (The Interface)
* This is where interaction occurs: dropping in images, typing commands, or reviewing the execution DAGs before they are committed.

---

*This architecture prevents the cascading failures common in basic agent loops (where an LLM hallucinates in a loop until it crashes). By isolating the memory, strict-typing the syscalls, and separating the "fast" and "slow" thinking processes, Kernos-OS becomes incredibly stable.*

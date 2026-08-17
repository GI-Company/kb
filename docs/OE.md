# Kernos OE

**Identity:** a browser-hosted operating environment. Host-mediated services,
worker sandboxes, small trained specialists, cloud for hard reasoning. The
browser is the HAL; Kernos is the layer on top of it — bus, VFS,
capabilities, agents.

**Non-goals:** a giant in-tab LLM, custom Android ROMs, Termux-as-kernel,
fake semantic search on the classifier trunk, CDN Pyodide, a parallel
IDBFS-backed filesystem competing with the real one.

This document is the horizon. It says what's actually built, what's next,
and what's deliberately not ours — and it's meant to stay true, not to be
aspirational. When code and this file disagree, the code is right and this
file is stale; fix the file. API-level truth (exact signatures, exact
allowlists) lives in the code and its own comments, not here — this is the
map, not the territory.

---

## 1. Shipped

| Area | State |
|---|---|
| Shell | VFS-backed cwd, pipes, redirection, history, tab completion, Ctrl+C |
| Filters | Honest flags (unsupported ones refused, not silently dropped); VFS-aware text tools; `pick`/`where` on NDJSON |
| Python | Same-origin Pyodide worker, signed-in only, full stdlib; **read AND write** — a script's file changes stage and commit only if the run succeeds, scoped to one flat directory matching the read bridge |
| Local AI | ~8k-param classifiers, train/persist, glass-box `explain` (occlusion, not similarity), `correct`/`train --from-corrections` — held-out is frozen on first retrain and reused verbatim after (with a contamination guard on corrections), so before/after is a real comparison, not two different samples; taught-item accuracy is reported automatically, not just checked by hand |
| Composition | `classify --json \| where \| pick` — a local model in a real pipe, still in-tab |
| Capabilities (terminal) | `can`/`policy`, generated from the real dispatch tables (`VFS_COMMANDS`, `TEXT_FILTERS`, `PYTHON_COMMANDS`, `ALLOWED_COMMANDS`, ...) rather than hand-maintained, with a sync test asserting the copies match |
| Capabilities (agent) | `can kernos.exec` describes what an agent's tool calls can reach, distinctly labeled from a terminal command; `kernos.exec`'s own `CALL_BUDGET` reuses the same `Capability` vocabulary the terminal shows, not a parallel naming scheme |
| Agent VFS writes | Staged through `lib/vfsOverlay.ts` and committed only on success — a script that writes then throws, times out, or gets its worker killed leaves nothing durable behind. One overlay class, two independent consumers (`kernos.exec`, Python), both verified live |
| Glass box / trace | `trace` reads the real bus log; every `kernos.exec` RPC call (`vfs.*`, `bnlm.*`, `agent.ask`) traces itself automatically at the one dispatch point, not per-handler — a budget denial or an unknown-capability call is now visible, not just an agent's own explicit `kernel.publish` |
| Security | Exec worker + `terminate()` for real preemption; guest quota; sandboxed-exec allowlist trimmed to the 27 commands actually probed present on the deployed runtime (was 39, 12 dead) |
| Mobile | Phone detection is orientation-aware (touch + short viewport edge, not raw width alone — a phone in landscape is often wider than the old breakpoint); all four full-viewport containers use `dvh`/`dvw`, not static `vh`/`vw`, so the taskbar can't render below the fold on a real device with expanded browser chrome |
| Boot / BIOS | Boot-time BIOS (right-click during boot) is now read-only diagnostics sourced from the same modules the terminal reads — capability table, saved local models, and the live `/api/exec` allowlist — not a config editor for `bios.*` kernel topics that have had no backend since the Go microkernel was retired |
| Explicitly rejected | Trunk-as-retriever (`embed`/`similar`/`match`/`index`) — measured, not guessed: held-out precision@1 landed at or below chance (`lib/embedPrecision.test.ts`). `pip install` — off behind one documented flag (`PACKAGE_INSTALL_ENABLED` in `lib/pythonRuntime.ts`) pending an explicit CSP/`connect-src` decision, not a technical blocker |

Durable storage today: `lib/vfs.ts` (IndexedDB for guests, Supabase for
signed-in accounts) — not OPFS-primary. No PWA manifest or service worker
exist yet; that's Phase 5, untouched, honestly.

## 2. Design principles

- **Local-first, cloud-optional.** Specialists run offline; Groq is for
  bootstrapping data and hard reasoning, not routine routing.
- **Host mediates.** Workers never hold ambient network/disk/model
  authority — they ask the host over `postMessage`, and the host decides.
  Killing a worker thread can never strand a half-applied capability.
- **Deny + trace, not silent.** A missing capability or an exceeded budget
  is visible in `trace`, not a quiet no-op.
- **Small specialists.** The measured ~8k-param regime, not a
  context-window arms race.
- **One source of truth for files.** `lib/vfs.ts`. Python and `kernos.exec`
  both stage through the same `VfsOverlay` rather than each inventing a
  private notion of "the filesystem."
- **Same-origin only.** No CDN Pyodide; CSP `script-src 'self'` and COEP
  `require-corp` stay intact. Enabling `pip install` is the one place this
  gets revisited, and only as an explicit, named decision.
- **Measure before naming.** Retrieval already failed this test once
  (`lib/embedPrecision.test.ts`). The rule stands for the next thing that
  needs it, not just that one case.
- **Shipped / Next / Not-ours.** Don't implement inspiration as though it
  were backlog. Sections 1, 3, and 5 below exist to keep those three
  separate.

## 3. What's next

**Phase 4 — retrain metric honesty.** Closed, verified live (not just
unit-tested): `classifierRegistry`'s saved record now carries
`heldOutExamples`, not just the accuracy number. `train --from-corrections`
freezes a held-out split on the first corrections-retrain (or on a
classifier that only ever went through the Classifier app, which measures
held-out accuracy but never persisted which items it used) and reuses it
verbatim on every retrain after — a correction whose text exactly matches a
frozen item is excluded from training rather than silently leaking a test
item into the train set. Taught-item accuracy (do the just-folded
corrections now classify correctly) is computed via the existing
`evaluate()` and reported on every run, not just checked by hand. Live
round-trip on a real saved classifier: round 1 froze a 13-item held-out set
and honestly declined to compare against the Classifier app's differently-
split 86.7%; round 2 and 3 reused that same 13-item set and reported a
genuine "was 84.6%" — the exact bug described above, confirmed fixed against
real IndexedDB persistence, not a mock.
- Still open, optional: margin/low-confidence routing suggests a cloud
  fallback or a `correct` prompt, rather than trusting a narrow-margin call
  silently. Not commissioned as part of Phase 4's metric-honesty scope.

**Phase 5 — PWA, egress, storage depth.** Entirely unstarted, confirmed by
absence rather than assumed: no manifest, no service worker, no OPFS
anywhere in the tree. Web app manifest + offline-safe service worker for
shell/assets; mobile file-picker import and Web Share export; an optional
File System Access mount on desktop where supported; only then consider
OPFS as the primary volume with `SyncAccessHandle` in the Python worker,
and only if profiling shows `postMessage` cost actually matters.

**Wedge (parallel, not sequential).** "Train a private intent router in
the browser; run it offline; inspect why; teach its mistakes." The 2-minute
demo path — generate → train → classify → explain → correct — already
works end to end and has been run live, more than once. What's missing is
recording and positioning it, not building it.

## 4. Resolved findings

Two things an earlier audit flagged as live risks. Both closed, not just
scheduled:

- **Agents could mutate the durable VFS unstaged.** `AIChat.tsx → runTool →
  kernos.exec's vfs.write`, reachable from `agent-chat` (the default
  persona) on an ordinary chat turn, and separately from any `task.run` DAG
  node whose command is `kernos.exec` — both budget-limited but entirely
  unstaged, so a script that wrote a file and then threw, timed out, or had
  its worker killed left that write behind durably regardless. Closed by
  `lib/vfsOverlay.ts`: writes stage in memory and commit in one batch only
  when the run's result is `ok:true`. Verified live through both entry
  points, in both directions (commit-on-success, discard-on-failure).
- **Two capability systems that didn't share a vocabulary.** The terminal's
  declarative `COMMAND_CAPABILITIES` table and `kernos.exec`'s imperative
  `CALL_BUDGET` used different names for the same three ideas (`bnlm` vs.
  `model:local`, `agentAsk` vs. `model:cloud`) and neither could describe
  the other's surface. `can kernos.exec` meant nothing. Closed:
  `CALL_BUDGET`'s keys are now the literal `Capability` strings `can`/
  `policy` already show a terminal user, checked at compile time against
  that same union (a typo like `'model:clod'` is a build error, not a
  silently-dead budget check), and `can kernos.exec` gives a real answer.

## 5. Explicit backlog freeze

| Item | Status |
|---|---|
| `embed`/`similar`/`match`/`index` as retrieval | Closed — measured, precision@1 at or below chance held-out |
| `pip install` | Off behind one flag, pending an explicit CSP decision |
| Monolithic local LLM / huge context | Rejected — the ~8k-param regime is the point |
| Termux-as-shell | Rejected; an export/import dock is a possible Android-only extra, not core |
| Custom Android ROM | Out of scope |
| GitKB / MCP-as-core | Inspiration only — nothing in this codebase builds toward hosting an MCP server |

## 6. Definition of "OE v1 complete"

- [x] Agent VFS writes staged, commit-or-discard, verified through both
      real entry points
- [x] Python write-back, same narrow scope as the read bridge
- [x] Capability vocabulary unified between terminal and agent surfaces;
      `kernos.exec`'s RPC calls trace automatically
- [x] Local classify/explain/correct loop stable, and *measured* — including
      the negative result on retrieval
- [x] Retrain metrics honest (frozen held-out split, taught-item accuracy)
- [ ] PWA installable; mobile import/export works
- [ ] Docs match code (this table is true — checked 2026‑08‑17)
- [ ] One clear wedge demo recorded, not just runnable

Not required for v1: retrieval, `pip`, Termux, knowledge graphs, NPU
acceleration, big local models.

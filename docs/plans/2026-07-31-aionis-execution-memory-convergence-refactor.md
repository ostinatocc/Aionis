# Aionis Execution Memory Convergence Refactor Plan

**Date:** 2026-07-31
**Status:** Active — Phases 1 and 2 complete; Phase 3 Tasks 3.1–3.3 complete,
Tasks 3.4–3.5 pending
**Workspace:** `/Volumes/ziel/Ai`
**Runtime:** `/Volumes/ziel/Ai/AionisRuntime`
**Preserved source snapshot:** `/Volumes/ziel/new.aionis`
**Runtime HEAD at copy:** `6f3557014117af85c19f1589a48173e87bd84b70`

## 1. Execution rule

This plan governs the new `/Volumes/ziel/Ai` product refactor only.

The preserved `/Volumes/ziel/new.aionis` workspace is read-only reference
material. It must not be reset, cleaned, rewritten, or used as the active
refactor target.

A task in this plan is complete only when it changes a user-visible Execution
Memory effect or removes code made redundant by a proven replacement.
Compilation, schemas, route registration, governance records, GitHub state, or
mock results are not product completion.

No Aionis source code may contain:

- a repair instruction for one repository or one benchmark task;
- a verifier answer or expected patch;
- a task-name, framework-name, path-name, or issue-specific decision rule;
- a disguised generalization of one failed task;
- a mock LLM, mock tool result, mock Runtime outcome, or mock success label.

Supporting deterministic checks are allowed only against the real Runtime,
real SQLite, real files or structured subjects, and real verifier processes.
Product-effect claims require real LLMs, real tools, real tasks, and real
verifiers.

## 2. Canonical product definition

> Aionis is model-independent Execution Memory for Agents. It preserves and
> reconstructs compact executable working state, protects better verified
> execution branches from later regression, learns transferable procedures
> from real outcomes, and supplies only the state and experience that improves
> future execution.

Aionis has two product planes.

### 2.1 Always-on continuity

For every active task Aionis must:

1. retain the exact task and subject identity;
2. retain the current authoritative subject state;
3. retain accepted decisions, completed work, failed work, unresolved work,
   evidence, pending checks, and the next justified action;
4. survive interruption, context compaction, process restart, Agent handoff,
   and model change;
5. preserve alternative state candidates;
6. prevent an Agent declaration from overriding verifier truth;
7. recover the best applicable verifier-accepted branch after regression;
8. compile the smallest sufficient continuation context.

This plane is never conditionally disabled by a skill selector.

### 2.2 Adaptive experience

Across tasks Aionis must:

1. retain real verifier-backed successes and failures;
2. contrast related outcomes instead of copying a successful transcript;
3. induce procedure hypotheses without task-specific literals;
4. validate hypotheses on unrelated held-out tasks;
5. admit only skills with positive verified utility after token and
   negative-transfer cost;
6. deliver admitted skills through `use_now`, uncertain candidates through
   `inspect_before_use`, and harmful or inapplicable skills through
   `do_not_use`;
7. weaken, split, supersede, or retire skills when later outcomes contradict
   them.

Continuity does not wait for this plane to mature.

## 3. Product outcomes and acceptance metrics

### 3.1 Continuity

For tasks that full history can already complete:

- Aionis must preserve completion;
- Aionis should reduce total input tokens and rediscovery tool calls;
- the primary comparison is Aionis versus Full History;
- Cold Restart is a secondary lower-bound comparison.

For tasks that full history does not complete:

- verified completion has priority over token reduction;
- Aionis may spend more tokens when the additional work produces a verified
  completion;
- a failed but cheaper run is not a product win.

Required measurements:

- verifier pass/fail;
- total input/output/cached tokens from provider receipts;
- elapsed time;
- tool calls;
- repeated observations;
- repeated file or artifact reads;
- accepted-branch recovery count;
- incorrect completion attempts blocked;
- continuation-context characters and tokens.

### 3.2 Learning

Required comparisons:

```text
state_only
versus
state_plus_candidate_skill
versus
state_plus_validated_skill
```

Required measurements:

- held-out verifier completion;
- change in tokens and tool calls;
- direct-use rate;
- negative direct-use rate;
- negative transfer;
- skill abstention quality;
- benefit by task cluster and model;
- skill growth relative to distinct task growth.

No claim of learning is allowed from training-task replay alone.

### 3.3 Complexity

Current measured baseline in the new Runtime:

| Measure | 2026-07-31 baseline |
|---|---:|
| Source files | 374 |
| Source lines | 214,899 |
| Runtime-entry files | 318 |
| Runtime-entry lines | 178,563 |
| Non-entry source lines | 36,336 |
| Route matrix entries | 21 |
| Environment fields | 177 |
| Import cycles | 0 |

The first target is not an arbitrary line-count rewrite. The target is one
default product loop with no duplicate authority:

```text
AgentSession
-> current state
-> action
-> candidate branch
-> verifier
-> complete or recover
-> outcome
-> future state/skill
```

After the replacement loop is proven, production Runtime-entry lines should
fall by at least 35%, route matrix entries should fall to the product surface,
and environment fields should fall to settings used by the default product.
These are convergence goals, not permission to delete unproven behavior.

## 4. Repository boundary

The active product consists of:

| Repository | Target role |
|---|---|
| `AionisRuntime` | One local authoritative Execution Memory service |
| `aionis-sdk` | Canonical TypeScript integration |
| `aionis-mcp` | Thin MCP mapping onto the SDK |
| `aionis-aifs` | File-oriented projection of Runtime state and memory |
| `aionis-cli` | Install, start, stop, inspect, and local configuration |
| `aionis-create` | Temporary migration input; merge useful creation flow into CLI |

No new repository is introduced during convergence.

Useful substrate primitives may remain as implementation details or be
absorbed into Runtime. Substrate, Manifest, eval laboratories, operator
authority packages, and deployment systems are not independent product planes.

## 5. Capabilities to preserve

### 5.1 Runtime truth

- `AgentSession` begin, resume, handoff, release;
- immutable execution episode identity;
- exact source task and model configuration bytes;
- exact subject adapters for workspace, structured artifact, and SQLite;
- current-state CAS head;
- content-addressed evidence;
- hash-chained episode events;
- real process verifier registry and program identity;
- verifier launch recovery;
- operation idempotency;
- SQLite authority;
- exact snapshot restore;
- verifier-bound outcome and cost receipts.

### 5.2 Continuity delivery

- current goal and task constraints;
- observations and decisive evidence;
- decisions and reasons;
- completed, failed, blocked, and unresolved state;
- active artifacts;
- pending checks;
- next justified action;
- candidate branch ledger;
- accepted branch;
- recovery recommendation;
- compact continuation rendering;
- rehydration of exact supporting evidence.

### 5.3 Memory and learning

- ordinary fact, preference, project, procedure, event, and evidence memory;
- lexical and structured retrieval;
- optional ANN candidate recall with SQLite as authority;
- `use_now`;
- `inspect_before_use`;
- `do_not_use`;
- feedback bound to delivered and actually used memory;
- episode-to-memory compilation as L1 input;
- L0–L5 semantics;
- lifecycle suppression, supersession, rehydration, and retirement.

### 5.4 Product integrations

- Runtime-owned SDK contract;
- SDK high-level AgentSession;
- MCP as a thin transport;
- AIFS as a thin projection;
- CLI as the single operational entry;
- minimal multi-Agent handoff.

## 6. Capabilities to remove, merge, or extract

Removal happens only after the default product loop no longer imports or
depends on the old path and real acceptance remains equal or better.

### 6.1 Remove from the default Runtime

- fixed admission profiles, sample counts, waves, and experiment protocols;
- admission dataset collection and counterfactual evaluation;
- learning-control form/provider/job/review bureaucracy;
- authority broker, reviewer pack, deployment authority, and claim routing;
- manual skill-candidate product routes;
- operator browser and operator snapshot product surfaces;
- public debug, audit, and flight-recorder routes;
- self-reported `/measure` product effect;
- replay-repair and sandbox-repair subsystems;
- task-family lexicons and task-specific scorers;
- fixed prompt recipes;
- compatibility paths for external Agent frameworks;
- feature flags that only select abandoned internal experiments;
- Runtime-owned GitHub, CI, release, deployment, and package governance.

### 6.2 Merge

- duplicate state compilers into the canonical current-state projection;
- duplicate prompt renderers into one Runtime renderer;
- duplicate selection/ranking paths into one recall-and-delivery decision;
- legacy handoff store/recover into AgentSession continuity;
- Create into CLI;
- evidence/audit artifacts needed for replay into the episode ledger;
- useful Substrate primitives into the owning Runtime modules.

### 6.3 Retain outside the daemon core

- neutral real-Agent benchmark runners;
- research notebooks and analysis;
- admission experiments;
- statistical comparison tools;
- release and deployment tools.

These may consume Runtime evidence. They must not define Runtime behavior.

## 7. Target Runtime architecture

The target production dependency direction is:

```text
transport
  -> AgentSession application service
    -> continuity
      -> current state
      -> branch ledger
      -> context compiler
    -> verification
      -> verifier registry/runner
      -> outcome
    -> memory
      -> recall
      -> skill lifecycle
      -> feedback
    -> storage
      -> SQLite
      -> content-addressed artifacts
```

Rules:

- transport cannot own ranking, learning, or state truth;
- SDK cannot implement a second selection algorithm;
- Host free-form state is never authoritative;
- ANN cannot become authority;
- an LLM judge cannot become the sole completion authority;
- verifier evidence cannot become the product itself;
- governance cannot sit on the hot path unless it prevents demonstrated
  negative transfer;
- only current-state and verifier-backed events may change completion truth.

## 8. Target product surface

The target public HTTP surface is:

| Surface | Role |
|---|---|
| `/v1/observe` | Begin/resume/record execution and remember ordinary memory |
| `/v1/guide` | Compile current state and applicable experience |
| `/v1/feedback` | Run verifier, close/continue, and record memory outcomes |
| `/v1/rehydrate` | Resolve exact deferred evidence or archived memory |
| `/v1/forget` | Suppress, supersede, archive, or restore memory |
| `/health`, `/readyz` | Process health |

`/v1/memory/resolve` may remain temporarily as the implementation behind
rehydration, but it is not a second product workflow.

Legacy handoff, measure, governance, operator, audit, debug, and manual
candidate routes are removed after SDK/MCP/AIFS callers move to the canonical
loop.

## 9. L0–L5 target data flow

### L0 — live state

One task-scoped current execution state, derived from exact subject snapshots
and semantic episode events.

### L1 — verified episode

One immutable episode with exact task, state transitions, verifier result,
cost, and actual memory exposure/use.

### L2 — procedure hypothesis

A contrastive hypothesis derived from multiple related success/failure
episodes. It is not delivered as a trusted skill.

### L3 — validated skill

A versioned procedure that improves held-out verifier outcomes across more
than one task source without unacceptable negative transfer.

### L4 — contextual utility

Calibrated benefit, token cost, uncertainty, and harm estimates conditioned on
task and state features.

### L5 — learning policy

A small versioned policy deciding whether to deliver, inspect, abstain,
revalidate, split, weaken, or retire a skill.

Each level has one authoritative representation. Existing code may be reused
only when it matches that ownership.

## 10. Implementation sequence

## Phase 0 — preserve and establish truth

### Task 0.1 — Copy complete working trees

- Output: six retained repositories under `/Volumes/ziel/Ai`.
- Test: source/target HEAD and working-tree checksums match at copy time.
- Status: complete.

### Task 0.2 — Record real complexity and product surface

- Output: baseline in this plan.
- Test: `npm run -s complexity:report`.
- Status: complete.

### Task 0.3 — Enforce verifier-bound completion

- Output:
  - failed, inconclusive, infrastructure, or missing verifier cannot complete
    an AgentSession;
  - direct HTTP callers cannot bypass the rule;
  - failed completion leaves episode and lease active.
- Test:
  - Runtime typecheck;
  - standalone SDK build;
  - real Runtime HTTP + SQLite + file state + child-process verifier.
- Status: complete.

## Phase 1 — make continuity a complete default product

### Task 1.1 — Automatic exact accepted-branch recovery

- Output:
  - `AgentSession.finish()` inspects the Runtime-owned recovery recommendation;
  - when the exact current snapshot failed and a distinct snapshot passed the
    same verifier, default behavior restores that exact accepted snapshot;
  - the failed candidate remains in the immutable ledger;
  - infrastructure and inconclusive outcomes do not trigger destructive
    recovery;
  - callers may request manual recovery without disabling verifier truth.
- Test:
  - a real file subject reaches a passed snapshot;
  - a later real mutation fails;
  - direct completion is rejected;
  - automatic recovery restores exact bytes and snapshot identity;
  - session remains active;
  - a following verifier passes and completion closes the session.

### Task 1.2 — Return one executable continuation result

- Output:
  - finish result distinguishes direct completion, recovered continuation,
    unresolved failure, infrastructure failure, and explicit termination;
  - the result includes the current snapshot, recovery target/receipt when
    applicable, and no task-specific prose;
  - SDK and standalone SDK expose the same discriminated contract.
- Test:
  - TypeScript exhaustive narrowing;
  - Runtime/SDK source ownership check;
  - real integration assertions against returned values.

### Task 1.3 — Remove Host completion authority

- Output:
  - Host can request verification or explicit cancellation/timeout;
  - Host cannot supply a success enum that overrides Runtime verifier truth;
  - successful close always binds a passed receipt for the exact current
    snapshot.
- Test:
  - real HTTP attempts with missing, stale, failed, and diagnostic receipts are
    rejected;
  - passed exact receipt completes.

### Task 1.4 — One current-state compiler

- Output:
  - exact subject state and episode semantic events feed one CAS head;
  - loose Host state is compatibility evidence, not an authority;
  - guide and finish use the same projection;
  - no parallel state table or compiler is added.
- Test:
  - restart and resume reconstruct identical state digest;
  - handoff and direct continuation render the same semantic state;
  - real subject mutation invalidates stale planned action.

### Task 1.5 — One continuation renderer

- Output:
  - one compact Runtime-owned rendering for goal, progress, decisions,
    decisive evidence, frontier, pending checks, and next action;
  - SDK only resolves referenced evidence and transports text;
  - old duplicate prompt assembly is bypassed.
- Test:
  - deterministic rendering from identical state;
  - exact evidence references resolve;
  - token/character size recorded against full history.

### Task 1.6 — Real three-arm continuity acceptance

- Output: predeclared unseen task set comparing Aionis, Full History, and Cold
  Restart with the same LLM, tools, budget, verifier, and starting state.
- Test: provider receipts and verifier-bound final states.
- Gate:
  - no success regression on full-history-solvable tasks;
  - lower median input tokens or rediscovery than Full History;
  - at least one verified recovery where a later branch regressed;
  - failed full-history tasks may count as Aionis wins only when Aionis passes.

## Phase 2 — collapse the production core

### Task 2.1 — Compute the canonical startup closure

- Output: module inventory classified as default product, optional adapter,
  research/eval, deployment, obsolete, or duplicate.
- Test: every retained default module has a path from the canonical product
  loop; every removal candidate has none.

### Task 2.2 — Remove operator and research routes

- Output: product route matrix contains only the target product surface.
- Test: Runtime starts and SDK/MCP/AIFS core operations work without operator
  services.

### Task 2.3 — Remove fixed experiment protocol from production imports

- Output: experiment constants, admission datasets, waves, and evaluation
  runners are outside Runtime-entry closure.
- Test: production build contains no import path to those modules.

### Task 2.4 — Collapse duplicate state, prompt, recall, and handoff paths

- Output: one authority for each concept.
- Test: import graph, real continuity acceptance, ordinary-memory retrieval,
  and rehydration remain valid.

### Task 2.5 — Ratchet complexity downward

- Output: measured budgets reflect a lower production closure rather than the
  current snapshot.
- Test: no import cycle; default route/env/module counts decrease.

## Phase 3 — transferable learning

### Task 3.1 — Canonical L1 episode dataset

- Output: verifier-backed episodes with exact task cluster, intervention,
  actual use, outcome, cost, and contamination status.
- Test: replay derives identical dataset rows from SQLite.

### Task 3.2 — Contrastive L2 compiler

- Output: hypotheses induced from shared differences between successes,
  failures, and state-only runs.
- Constraint: no task literals enter portable procedure steps.
- Test: source episodes and every abstraction are traceable; one episode alone
  cannot promote a portable skill.

### Task 3.3 — Held-out L3 validator

- Output: validated, rejected, or contested skill versions.
- Test: real unseen tasks, real LLM, real verifier, state-only control.

### Task 3.4 — L4 expected-utility selector

- Output: calibrated decision using expected verifier benefit, token cost,
  uncertainty, and negative-transfer risk.
- Test: logged intervention and actual use; abstention measured.

### Task 3.5 — L5 consolidation and forgetting

- Output: outcome-driven strengthen, weaken, split, supersede, quarantine, and
  retire transitions.
- Test: harmful evidence stops future direct use without deleting provenance.

## Phase 4 — integration convergence

### Task 4.1 — SDK is the canonical integration

- Output: one high-level loop and a small explicit low-level escape hatch.
- Test: a clean external package performs begin, resume, act, verify, recover,
  complete, remember, guide, feedback, and rehydrate.

### Task 4.2 — MCP and AIFS become thin

- Output: no duplicated ranking, state compilation, or learning in adapters.
- Test: adapter results match direct SDK results for the same Runtime state.

### Task 4.3 — Merge Create into CLI

- Output: one install/init/start interface.
- Test: clean local install starts Runtime and runs a real AgentSession.

## Phase 5 — product proof

### Task 5.1 — Multi-model real benchmark

- Models: at least two independent model families.
- Tasks: multiple unrelated task sources and subject adapters.
- Arms:
  - Cold Restart;
  - Full History;
  - Aionis State;
  - Aionis State + Validated Skill when a skill exists.
- Output: raw provider receipts, Runtime ledger, verifier outputs, and neutral
  aggregate report.

### Task 5.2 — Product decision

Aionis is ready for design partners only when:

- continuity produces repeated real wins;
- completion truth cannot be bypassed;
- token claims are supported by provider receipts;
- at least one skill transfers across unrelated held-out tasks;
- negative transfer is measured and controlled;
- default Runtime complexity is materially lower than this baseline.

## 11. Batch 1 — immediate execution

This batch starts immediately after this plan is written and reviewed.

1. Implement Task 1.1 automatic exact accepted-branch recovery.
2. Implement Task 1.2 executable finish/continuation result.
3. Complete Task 1.3 Runtime completion-authority cases needed by the same
   real integration.
4. Synchronize the Runtime-owned SDK regions.
5. Run Runtime typecheck, standalone SDK build/source check, and the real
   Runtime/SQLite/file/child-process verifier integration.

This batch does not:

- delete a product capability;
- change recall or learning ranking;
- add an endpoint;
- add a task rule;
- run a mock;
- touch GitHub, CI, release, or deployment;
- claim token or success-rate improvement.

## 12. Progress ledger

| Task | State |
|---|---|
| 0.1 Complete copy | Complete |
| 0.2 Baseline inventory | Complete |
| 0.3 Verifier-bound completion | Complete |
| 1.1 Automatic exact recovery | Complete |
| 1.2 Executable continuation result | Complete |
| 1.3 Remove Host completion authority | Complete |
| 1.4 One current-state compiler | Complete |
| 1.5 One renderer | Complete |
| 1.6 Real three-arm acceptance | Complete |
| 2.1 Canonical startup closure | Complete |
| 2.2 Product-only Runtime surface | Complete |
| 2.3 Experiment protocol outside production | Complete |
| 2.4 Duplicate authorities collapsed | Complete |
| 2.5 Complexity ratchet | Complete |
| Phase 2 production convergence | Complete |
| 3.1 Canonical L1 episode dataset | Complete |
| 3.2 Contrastive L2 compiler | Complete |
| 3.3 Held-out L3 validator | Complete — first candidate contested |
| 3.4 L4 expected-utility selector | Pending |
| 3.5 L5 consolidation and forgetting | Pending |
| Phase 3 transferable learning | In progress |
| Phase 4 integration convergence | Pending |
| Phase 5 product proof | Pending |

## 13. Batch 1 result — 2026-07-31

Implemented:

- `AgentSession.finish()` defaults to automatic exact recovery only when the
  Runtime supplies a same-verifier passed-to-failed recovery recommendation;
- manual recovery mode preserves the failed current branch for inspection;
- failed, missing, stale, inconclusive, infrastructure, and unknown verifier
  states cannot close an episode as completed;
- the high-level finish input no longer accepts a Host-selected verifier
  receipt;
- the continuation result identifies whether a verified branch was restored
  and binds the failed snapshot, failed receipt, restored snapshot, accepted
  receipt, deterministic recovery operation, and real restore response;
- standalone SDK Runtime-owned regions are synchronized.

Verified:

- Runtime TypeScript check passed;
- standalone SDK source ownership check passed;
- standalone SDK build passed;
- real Runtime HTTP, SQLite, file state, session lease, exact snapshot restore,
  and child-process verifier integration passed `7/7`;
- the integration proves missing, stale, and failed completion receipts are
  rejected, manual failure remains open, automatic recovery restores the exact
  accepted bytes and snapshot identity, and a later passed verifier completes.

No product-effect claim is made from this integration alone. The next product
proof remains Task 1.6 after Tasks 1.4 and 1.5.

## 14. Phase 1 convergence result — 2026-07-31

The default continuity path now has one Runtime-owned current-state compiler
and one Runtime-owned compact renderer. The SDK transports that result and
resolves referenced evidence; it no longer assembles a competing continuation
prompt or accepts Host-authored action continuity projections.

The predeclared `continuity-unseen-20260729-v1` task set ran with real
repositories, real tools, DeepSeek `deepseek-v4-flash` with thinking disabled,
the same 100,000-token arm budget, and Runtime-launched hidden verifiers.
Candidate finalization was disabled in all three arms so that the comparison
isolated continuity-state delivery.

| Task | Full History | Cold Restart | Aionis State |
|---|---:|---:|---:|
| `starlette-url-replace-no-authority` | pass; 29,373 input tokens; 4,355 context chars | fail; 106,732 input tokens | pass; 23,606 input tokens; 1,956 context chars |
| `httpx-empty-zstd-response` | pass; 100,071 input tokens; 12,922 context chars | fail; 107,126 input tokens | pass; 98,612 input tokens; 2,004 context chars |
| `pytest-code-getargs-flags` | fail; 27,205 input tokens; 6,898 context chars | fail; 103,247 input tokens | fail; 102,864 input tokens; 2,100 context chars |

Product result:

- Aionis preserved both successes achieved by Full History; Cold Restart
  completed none of the three tasks.
- On the two Full-History-solvable tasks, median input tokens fell from
  64,722 to 61,109, a 5.6% reduction.
- Starlette input tokens fell 19.6%; HTTPX input tokens fell 1.5%.
- Continuation context fell 55.1% on Starlette and 84.5% on HTTPX.
- Pytest is not an Aionis win: every arm failed, and Aionis spent substantially
  more tokens than the early incorrect Full History completion.
- Across all three tasks, including that failed task, Aionis does not have a
  lower input-token median. The token claim is therefore limited to tasks Full
  History could actually complete, as defined in Section 3.1.

The accepted-branch recovery gate was rerun after convergence through the
public SDK and a local Runtime HTTP service. A real file subject first reached
a verifier-passed snapshot, a later real mutation produced a distinct failed
snapshot, and default `AgentSession.finish()` restored the exact prior bytes
and snapshot identity while retaining the failed candidate in the ledger.

Raw run roots:

- `/Volumes/ziel/aionis-real-runs/convergence-refactor-20260731-v7/starlette-three-arm`
- `/Volumes/ziel/aionis-real-runs/convergence-refactor-20260731-v7/httpx-three-arm`
- `/Volumes/ziel/aionis-real-runs/convergence-refactor-20260731-v7/pytest-three-arm`

This closes Phase 1. It is not Phase 5 product proof: the evidence uses one
model family and three coding tasks, and pytest remains unsolved.

## 15. Phase 2 production-core convergence result — 2026-07-31

The production source now has two roots: `src/runtime-entry.ts` for the local
Runtime and `src/sdk.ts` for the canonical TypeScript integration. Every one of
the 160 retained `src` files is reachable from those roots. There is no second
non-product source closure left inside `src`.

Measured contraction from the Section 3.3 baseline:

| Measure | Baseline | Phase 2 result | Change |
|---|---:|---:|---:|
| Total source files | 374 | 160 | -57.2% |
| Total source lines | 214,899 | 89,107 | -58.5% |
| Product-closure files | 318 | 160 | -49.7% |
| Product-closure lines | 178,563 | 89,107 | -50.1% |
| Route matrix entries | 21 | 6 | -71.4% |
| Environment fields | 177 | 64 | -63.8% |
| Non-product source files | not isolated | 0 | one source closure |
| Import cycles | 0 | 0 | unchanged |

The public Runtime is now only:

- `POST /v1/observe`;
- `POST /v1/guide`;
- `POST /v1/feedback`;
- `POST /v1/rehydrate`;
- `POST /v1/forget`;
- `GET /health`;
- `GET /readyz`.

`POST /v1/memory/resolve` remains temporarily for SDK evidence-resolution
migration. Old handoff storage, operator, audit, debug, measure, governance,
manual candidate, replay-repair, and sandbox-repair routes are not registered.

Removed from the production repository:

- 160 unreachable source modules and their obsolete duplicate authorities;
- the stale `scripts/e2e` surface and CI programs bound to deleted production
  modules;
- the separate learning-authority package and old learning, deployment, and
  experiment tools;
- fixed experiment protocols, old release workflows, and old Docker/runtime
  entry assumptions;
- SDK-owned continuation rendering and Host-authored continuity projections.

The retained product smoke starts an isolated local Runtime, records ordinary
memory through `/v1/observe`, obtains the compact Runtime-owned Agent context
through `/v1/guide`, and confirms the retired replay route returns 404. The
result contracts were:

```text
observe: aionis_observe_result_v1
guide: aionis_guide_result_v1
agent_context: aionis_agent_context_v1
retired replay route: 404
```

The rebuilt Runtime and canonical SDK source agree after the deletion. A
separate route probe also confirmed the five product POST routes plus the
temporary resolver are registered, `/health` and `/readyz` return 200, and
`/healthz`, measure, debug, and operator routes return 404.

This closes the Runtime production core in Phase 2. It does not claim
transferable learning or broad product proof. The sibling MCP, AIFS, and CLI
sources still contain legacy integration options found by a read-only scan;
their removal and remapping are Phase 4, not part of the completed Runtime
closure.

## 16. Phase 3 Tasks 3.1–3.3 result — 2026-07-31

The Runtime now has one canonical L1 episode representation containing the
exact task cluster, subject, structural action trajectory, mutations, verifier
binding, interventions, actual memory use, outcome, cost, contamination,
eligibility, and source hashes.

Replaying the closed SQLite truth from the Phase 1 Starlette, HTTPX, and pytest
runs produced the same sorted L1 rows and digests on repeated export:

| Source episode | Verifier result | Actions | Mutations | L1 digest |
|---|---:|---:|---:|---|
| Starlette | pass | 9 | 1 | `cd77a25f0f5aa72d15a35d35e5abd09a291bd4e0191487b28bc502f0166c388f` |
| HTTPX | pass | 15 | 1 | `4317aa2ac6588d9f469ce799e49e4fee051ad49aa28ac6dbb772eca5c3036262` |
| pytest | fail | 20 | 2 | `3ef2dba5d2f9545b60363b8f4ca6849581262fc030442027302ca8cb23fd3c3a` |

The contrastive L2 compiler accepted those two successes and one failure only
because all three were clean, verifier-backed, state-only episodes from
distinct task clusters. It emitted one traceable structural hypothesis:

- mutation actions: successful range `[1, 1]`, failed range `[2, 2]`,
  candidate boundary `<= 1`;
- total actions: successful range `[9, 15]`, failed range `[20, 20]`,
  candidate boundary `<= 15`;
- hypothesis digest:
  `dade4a79a97c8c5352722bbf2dc9a019514b0e43b21aabbf5d2d2a5906925e82`;
- no task text, repository path, request content, result content, framework
  name, or issue-specific literal entered the portable hypothesis;
- a single source episode abstains and cannot promote a skill.

The L3 protocol was frozen before held-out execution. Two unrelated task
sources then ran paired `state_only` and `state_plus_candidate_skill` arms
with the same interrupted task seed, model authority, tool surface, budget,
and real Runtime-owned verifier in each pair.

The requested model-version label was `DeepSeek-V4-Flash-0731`. The official
DeepSeek API rejected that display label as an API model ID, so the frozen
adapter mapping used provider model ID `deepseek-v4-flash`; every model receipt
reported served model `deepseek-v4-flash` and the same system fingerprint.

| Held-out task | State only | Candidate skill | Token delta | Tool delta | Time delta |
|---|---:|---:|---:|---:|---:|
| Requests | pass | pass | +35,306 | -1 | -32,984 ms |
| Flask | pass | pass | +9,210 | 0 | -25,432 ms |
| Aggregate | 2/2 pass | 2/2 pass | +44,516 | -1 | -58,416 ms |

Product result:

- verified-success uplift was `0`;
- negative transfer was `0`;
- candidate delivery increased total tokens by `44,516`;
- elapsed time decreased by `58,416 ms`, but time alone cannot promote a
  candidate that produced no verifier-success uplift and increased token cost;
- the resulting L3 version is `contested`, not `validated`;
- `production_prompt_eligible=false` and
  `validation_prompt_eligible=true`.

The formal L3 receipt binds the frozen protocol, L2 hypothesis, candidate
context, task seeds, model receipt chains, episode IDs, verifier receipt IDs,
costs, source summary hashes, and the Runtime-reopen integrity supplement used
for the Requests control. Its digest is
`b872c719f83fc5544f9efb22541997cb78f1f25efbb588c65f311f6405f5b664`.

Harness attempts that stopped before a model call consumed zero model tokens
and are excluded. The successful Requests control had already completed the
real Agent, verifier, episode close, and Runtime restart before a preserved
harness import referenced a Phase-2-deleted integrity module; the current
Runtime integrity authorities were applied to that same closed SQLite
database and are hash-bound in the L3 receipt.

This batch proves that L1-to-L3 can reject an unhelpful learned procedure; it
does not prove transferable-learning benefit. Task 3.4 must treat this
candidate as `inspect_before_use`/validation-only and must never select it for
`use_now` unless later held-out evidence produces a validated L3 version.

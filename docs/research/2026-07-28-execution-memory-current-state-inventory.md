# Aionis Execution Memory Current-State Inventory

**Snapshot date:** 2026-07-28
**Repository:** `/Volumes/ziel/new.aionis/AionisRuntime`
**Branch:** `product-main`
**HEAD:** `6f3557014117af85c19f1589a48173e87bd84b70`
**Package version:** `0.3.12`
**Purpose:** Task 0.1 of the Aionis Execution Memory Product Master Plan

## 1. Inventory Boundary

The implementation baseline contained 90 owner working-tree entries:

- 47 tracked modified files;
- 43 owner-created untracked files;
- no staged files.

The approved master plan was added afterward as the 91st entry:

- `docs/plans/2026-07-28-aionis-execution-memory-product-plan.md`.

This inventory does not clean, restore, overwrite, stage, or reinterpret any
owner file. Every baseline entry is listed below. Batch A1 must work around
these files and preserve their product behavior.

## 2. Current Product Truth

The dirty tree already contains a substantial Execution Memory implementation.
It is not disposable scaffolding.

### 2.1 Episode truth and exact state capture

The current implementation can:

- open an immutable decision episode;
- retain exact source task, model configuration, budget, subject identity, and
  required verifier identity;
- capture exact workspace state including Git and non-Git subject roots;
- append hash-chained decision, action, verifier, and close events;
- retain request/result/snapshot/verifier/usage artifacts;
- replay the episode and verify event/store integrity;
- classify verifier-backed pass, failure, arm-caused incomplete,
  arm-independent infrastructure, and diagnostic outcomes;
- recover verifier launch attempts after process death.

Primary source paths:

- `src/memory/execution-episode.ts`
- `src/execution/workspace-state-capture.ts`
- `src/product/execution-episode-service.ts`
- `src/store/lite-execution-episode-store.ts`
- `src/store/lite-evidence-artifact-store.ts`
- `src/execution/episode-verifier-runner.ts`
- `src/execution/runtime-episode-verifier-registry.ts`

These are preserved.

### 2.2 Stateful SDK episode protocol

The current SDK can:

- begin and resume a serialized episode handle;
- serialize Host callbacks so state-capturing operations cannot reorder;
- guide, record actions/mutations, run the verifier, and close an episode;
- bind tenant, scope, task, run, workspace, state snapshot, and verifier
  identity across calls.

Primary source paths:

- `src/sdk.ts`
- `src/product/execution-episode-transport-service.ts`
- `src/routes/product-facade.ts`

This behavior is preserved and becomes the basis of `AionisAgentSession`; it is
not replaced by a second SDK protocol.

### 2.3 Agent context and product delivery

The current product has one rich Runtime context compiler/renderer and an SDK
evidence-resolution layer. It already separates `use_now`,
`inspect_before_use`, `do_not_use`, and optional current context, and returns
guide/memory packets through the product facade.

Primary source paths:

- `src/memory/agent-context-compiler.ts`
- `src/memory/agent-context-renderer.ts`
- `src/memory/product-output/guide-packet.ts`
- `src/memory/product-output/memory-packet.ts`
- `src/product/guide-service.ts`
- `src/sdk.ts`

The public product behavior survives Phase 1. Batch A1 changes current-state
authority and section ownership without deleting recall, UseNow, inspect,
feedback, rehydrate, or ordinary memory.

### 2.4 Existing continuity primitives

Three overlapping mechanisms currently represent “state”:

1. `src/execution/state-store.ts` stores revisioned `ExecutionStateV1` and
   hash-linked transitions with compare-and-swap behavior.
2. `src/execution/workspace-state-capture.ts` captures exact authoritative
   workspace snapshots used by episodes and verifiers.
3. `src/memory/host-current-execution-state.ts` converts loose Host-supplied
   objects into prompt context.

In addition, ordinary memory entries can be classified as current-state or
handoff evidence inside `src/memory/agent-context-compiler.ts`.

This is the main ownership collision for Batch A1. The target is not a fourth
state system. The existing state store remains the single mutable head; exact
workspace snapshots and semantic episode events feed it; Host-supplied state
becomes explicitly unverified compatibility input until migrated.

### 2.5 Existing episode-to-memory compiler

`src/memory/execution-episode-memory-compiler.ts` and
`src/jobs/execution-episode-memory-compiler-worker.ts` already compile closed
verified episodes into ordinary memory. The current output is a shallow
episode result/hint, not a held-out-validated transferable ExecutionSkill.

This compiler remains available as the frozen legacy comparison. Batch A1
labels its output as `legacy_shallow_episode_hint` on the canonical
experimental path and does not delete its current production behavior.

## 3. Ownership Collisions to Resolve

| Collision | Current owners | Batch A1 decision |
|---|---|---|
| Current execution state | `state-store.ts`, exact workspace snapshots, Host object compiler, memory entries | Reuse the existing CAS store as the only head; project exact snapshot plus semantic events; do not create a parallel table |
| Semantic task state | Host free-form task/packet fields versus hash-chained episode actions | Add immutable observation, decision, progress, and planned-action events to the episode ledger; derived state cites them |
| Next action | Host `next_action`, memory-derived route hints, static execution packet fields | Only a current applicable `PlannedActionEventV1` can authoritatively populate `next_action`; other hints remain unverified compatibility context |
| Context compilation | Runtime compiler/renderer plus SDK evidence/prompt merging | Runtime owns semantic sections and digests; SDK transports/resolves evidence without creating a second selection brain |
| Episode facts versus skills | Verified episode compiler writes shallow execution memory | Preserve as L1/legacy hint; no L2/L3 name or production-skill authority without held-out validation |
| Outcome truth | Verifier receipts, reward projection, legacy measure/governance signals | Exact verifier-bound episode reward stays authoritative; `/measure` and legacy governance values remain diagnostic |
| Verification implementation | Registry, program identity, execution packs, launch authority, SIGKILL recovery | Preserve and reuse; do not expand verifier infrastructure during Batch A1 |

## 4. Behaviors That Must Survive Phase 1

1. `/v1/observe`, `/v1/guide`, `/v1/outcome`, `/v1/feedback`, ordinary-memory,
   rehydrate, and lifecycle behavior with existing callers.
2. Exact workspace capture and final-state verifier binding.
3. Hash-chained episode replay, operation idempotency, SQLite durability, and
   launch-attempt recovery.
4. SDK episode handle serialization and cross-process resume.
5. Runtime-owned guide/memory packet generation and SDK evidence resolution.
6. Existing UseNow/inspect/do-not-use decisions as the frozen legacy comparison.
7. Existing lexical/structured recall and optional candidate infrastructure.
8. Existing shallow episode memory output as a labeled legacy comparison only.
9. Existing owner tests and real-run artifacts; none are deleted merely because
   they are not the final acceptance mechanism.

## 5. File-by-File Owner Inventory

### 5.1 Tracked modified production files (25)

| Path | Classification | Preserve/role |
|---|---|---|
| `src/app/request-guards.ts` | delivery/composition | Preserve product request validation |
| `src/app/runtime-services.ts` | composition | Preserve episode/verifier service wiring |
| `src/config/runtime-config.ts` | composition | Preserve episode/verifier configuration |
| `src/execution/evidence-context.ts` | episode truth | Preserve evidence-bound execution context |
| `src/execution/outcome-classifier.ts` | verifier/outcome | Preserve external verifier outcome classification |
| `src/memory/agent-context-compiler.ts` | continuity/delivery | Primary context compiler; migrate current-state authority in place |
| `src/memory/agent-context-renderer.ts` | continuity/delivery | Primary renderer; preserve existing surfaces |
| `src/memory/execution-outcome-role.ts` | episode/legacy learning | Preserve outcome-role projection as compatibility evidence |
| `src/memory/governance-decision.ts` | legacy learning | Freeze as comparison; do not expand in Batch A1 |
| `src/memory/learning-external-ingestion-attestation.ts` | legacy learning | Preserve current external-memory attestation behavior |
| `src/memory/node-execution-surface.ts` | ordinary memory/delivery | Preserve execution-surface mapping |
| `src/memory/product-output/guide-packet.ts` | delivery | Preserve guide packet contract |
| `src/memory/product-output/memory-packet.ts` | delivery | Preserve memory packet contract |
| `src/product/guide-service.ts` | delivery/episode | Primary guide service and episode binding |
| `src/product/measure-service.ts` | diagnostic measure | Preserve as diagnostic, not reward authority |
| `src/product/observe-service.ts` | episode/ordinary memory | Preserve observe and ordinary-memory ingestion |
| `src/product/product-services.ts` | composition/contracts | Preserve canonical product service contracts |
| `src/routes/product-facade.ts` | transport | Preserve product routes and episode dispatch |
| `src/runtime-entry.ts` | composition | Preserve Runtime startup and worker ownership |
| `src/sdk.ts` | SDK/delivery | Preserve stateful episode and public SDK behavior |
| `src/server/bootstrap.ts` | composition | Preserve Runtime bootstrap wiring |
| `src/server/http-server.ts` | transport/composition | Preserve HTTP service wiring and shutdown ownership |
| `src/store/lite-runtime-data-operations.ts` | episode/storage operations | Preserve backup/restore/integrity behavior |
| `src/store/lite-runtime-schema.ts` | episode/storage schema | Preserve additive schema integration |
| `src/store/lite-write-store.ts` | ordinary memory/store | Preserve ordinary memory and write authority |

### 5.2 Owner-created untracked production files (22)

| Path | Classification | Preserve/role |
|---|---|---|
| `src/execution/episode-verifier-runner.ts` | verifier | Preserve real process execution and captured evidence |
| `src/execution/runtime-episode-verifier-launch-authority.ts` | verifier | Preserve Runtime launch reservation/authorization |
| `src/execution/runtime-episode-verifier-registry.ts` | verifier | Preserve versioned verifier definitions and launch identity |
| `src/execution/runtime-owned-evidence.ts` | episode truth | Preserve Runtime-owned evidence bytes |
| `src/execution/task-cluster.ts` | compiler/cohort | Preserve exact generic task-cluster identity |
| `src/execution/verifier-execution-pack.ts` | verifier | Preserve immutable verifier execution materialization |
| `src/execution/verifier-launch-attempt.ts` | verifier/recovery | Preserve append-only launch-attempt evidence |
| `src/execution/verifier-program-identity.ts` | verifier | Preserve executable verifier program identity |
| `src/execution/verifier-subject-materialization.ts` | verifier/state | Preserve exact verified subject materialization |
| `src/execution/workspace-state-capture.ts` | continuity/episode truth | Primary exact workspace snapshot source |
| `src/jobs/execution-episode-memory-compiler-worker.ts` | legacy compiler | Preserve frozen asynchronous episode-hint compiler |
| `src/memory/execution-episode-memory-compiler.ts` | legacy compiler | Preserve as shallow L1 comparison, not L2/L3 |
| `src/memory/execution-episode.ts` | episode truth/contracts | Primary immutable episode/event/reward contracts |
| `src/memory/host-current-execution-state.ts` | continuity compatibility | Migrate from authoritative-looking Host context to explicitly unverified compatibility input |
| `src/product/execution-episode-service.ts` | episode truth/service | Primary episode orchestration |
| `src/product/execution-episode-transport-service.ts` | transport/SDK | Preserve facade-to-episode mapping |
| `src/store/lite-evidence-artifact-store.ts` | episode truth/storage | Preserve content-addressed evidence authority |
| `src/store/lite-execution-episode-schema.ts` | episode truth/storage | Preserve V7 schema integrity/migration |
| `src/store/lite-execution-episode-store.ts` | episode truth/storage | Primary hash-chain, replay, idempotency, reward store |
| `src/store/lite-execution-verifier-launch-schema.ts` | verifier/storage | Preserve V8 launch-attempt schema |
| `src/store/sql/lite-execution-episode-v7.sql` | episode truth/storage | Preserve additive episode schema |
| `src/store/sql/lite-execution-verifier-launch-v8.sql` | verifier/storage | Preserve additive verifier-launch schema |

### 5.3 Tracked modified verification/support files (22)

| Path | Classification | Preserve/role |
|---|---|---|
| `scripts/ci/docker-recovery-smoke.sh` | verifier/recovery verification | Preserve real process-recovery coverage |
| `scripts/ci/lite-admission-policy-active-projection.test.ts` | legacy learning verification | Frozen comparison |
| `scripts/ci/lite-governance-decision.test.ts` | legacy learning verification | Frozen comparison |
| `scripts/ci/lite-learning-episode-store.test.ts` | legacy learning verification | Preserve ledger regression coverage |
| `scripts/ci/lite-learning-external-ingestion-projector.test.ts` | legacy learning verification | Preserve ingestion regression coverage |
| `scripts/ci/lite-learning-r1-rehearsal.test.ts` | legacy learning verification | Preserve current evidence, not product-effect proof |
| `scripts/ci/lite-learning-runtime-authority-head.test.ts` | legacy learning verification | Preserve authority regression coverage |
| `scripts/ci/lite-memory-commit-authority.test.ts` | ordinary-memory truth verification | Preserve commit-chain coverage |
| `scripts/ci/lite-product-facade-route.test.ts` | transport verification | Preserve product-route compatibility |
| `scripts/ci/lite-product-feedback-closed-loop.test.ts` | feedback/learning verification | Preserve closed-loop regression coverage |
| `scripts/ci/lite-product-output-assembler.test.ts` | delivery verification | Preserve guide/memory packet coverage |
| `scripts/ci/lite-recall-lexical-source.test.ts` | recall verification | Preserve lexical recall behavior |
| `scripts/ci/lite-recall-store-access.test.ts` | recall verification | Preserve recall-store behavior |
| `scripts/ci/lite-recall-structured-source.test.ts` | recall verification | Preserve structured recall behavior |
| `scripts/ci/lite-runtime-authority-adoption.test.ts` | legacy learning verification | Frozen comparison |
| `scripts/ci/lite-runtime-config.test.ts` | composition verification | Preserve configuration coverage |
| `scripts/ci/lite-runtime-data-operations.test.ts` | storage/recovery verification | Preserve real backup/restore integrity coverage |
| `scripts/ci/lite-runtime-maintenance-run.test.ts` | storage maintenance verification | Preserve maintenance regression coverage |
| `scripts/ci/lite-sdk-guide-agent-context.test.ts` | SDK/context verification | Preserve public context behavior |
| `scripts/ci/lite-skill-candidate-review-store.test.ts` | legacy learning verification | Frozen comparison |
| `scripts/ci/sdk-contract-ownership.test.mjs` | SDK contract verification | Preserve Runtime/SDK ownership check |
| `scripts/ci/server-product-smoke.test.ts` | product transport verification | Preserve server product smoke behavior |

### 5.4 Owner-created untracked verification/support files (18)

| Path | Classification | Preserve/role |
|---|---|---|
| `scripts/ci/lite-episode-verifier-runner.test.ts` | verifier verification | Preserve real process runner cases |
| `scripts/ci/lite-evidence-artifact-store.test.ts` | episode truth verification | Preserve evidence durability/integrity cases |
| `scripts/ci/lite-execution-episode-contract.test.ts` | episode contract verification | Preserve canonical digest/schema cases |
| `scripts/ci/lite-execution-episode-service.test.ts` | episode service verification | Preserve end-to-end service behavior |
| `scripts/ci/lite-execution-episode-store.test.ts` | episode store verification | Preserve replay/idempotency/integrity cases |
| `scripts/ci/lite-execution-task-cluster.test.ts` | compiler/cohort verification | Preserve generic task identity cases |
| `scripts/ci/lite-execution-verifier-sigkill-recovery.test.ts` | verifier recovery verification | Preserve real SIGKILL recovery evidence |
| `scripts/ci/lite-product-guide-execution-episode.test.ts` | delivery/episode verification | Preserve guide-to-episode decision binding |
| `scripts/ci/lite-runtime-episode-verifier-registry.test.ts` | verifier verification | Preserve registry/launch cases |
| `scripts/ci/lite-runtime-owned-evidence.test.ts` | episode evidence verification | Preserve Runtime evidence ownership |
| `scripts/ci/lite-runtime-schema-v7-migration.test.ts` | episode migration verification | Preserve real SQLite migration case |
| `scripts/ci/lite-runtime-schema-v8-migration.test.ts` | verifier migration verification | Preserve real SQLite migration case |
| `scripts/ci/lite-sdk-execution-episode.test.ts` | SDK/episode verification | Preserve serialized handle and resume cases |
| `scripts/ci/lite-verifier-execution-pack.test.ts` | verifier verification | Preserve execution-pack immutability cases |
| `scripts/ci/lite-verifier-subject-materialization.test.ts` | verifier/state verification | Preserve exact-state materialization cases |
| `scripts/ci/lite-workspace-state-capture.test.ts` | continuity/state verification | Preserve exact workspace snapshot cases |
| `scripts/ci/schema-fixture-helpers.ts` | verification support | Preserve real SQLite schema fixture support |
| `scripts/ci/support/lite-execution-verifier-sigkill-child.ts` | verifier support | Preserve real child-process recovery fixture |

### 5.5 Owner-created untracked documents/evidence (3)

| Path | Classification | Preserve/role |
|---|---|---|
| `docs/plans/2026-07-27-adaptive-execution-memory-correctness-learning.md` | design input | Preserve as superseded technical input |
| `docs/research/2026-07-27-correctness-learning-baseline.json` | real-effect baseline | Preserve exact measured values/artifact references |
| `docs/research/2026-07-27-correctness-learning-baseline.md` | real-effect baseline | Preserve interpretation and limitations |

## 6. Batch A1 Change Boundary

Batch A1 may change owner files only where necessary to:

1. add semantic event contracts and append/replay support;
2. project those events plus exact workspace snapshots into the existing CAS
   state head;
3. make the resulting current state an independent always-on context section;
4. add session identity/lease behavior around the existing SDK episode
   protocol;
5. label shallow episode output on the canonical experimental path.

Batch A1 must not:

- replace exact workspace capture or verifier authority;
- create a second episode, state, SDK, selector, or renderer brain;
- add a task/repository/language-specific rule;
- enable ANN;
- change GitHub, CI, release, reviewer, or deployment policy;
- delete or clean any of the 90 owner entries;
- claim correctness learning before real comparative evidence.

## 7. Task 0.1 Acceptance

- All 90 owner baseline entries are listed exactly once in Sections 5.1–5.5.
- The 91st current entry is the approved master plan and is explicitly
  separated from the owner baseline.
- Every product behavior selected for preservation names a real source path.
- Current-state, semantic-state, compiler, context, outcome, and verifier
  ownership collisions are explicit.
- No owner file was modified, cleaned, staged, or deleted while creating this
  inventory.

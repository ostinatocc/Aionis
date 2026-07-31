# Aionis Execution Memory Product Master Plan

> **Execution rule:** This is the canonical product implementation plan for the
> current Aionis workspace. Implement it in dependency order. A task is not
> complete because code compiles, a contract exists, or an internal metric is
> green. Tasks are complete only with a real LLM, real tools, a real task
> environment, and a verifier bound to the resulting state. Do not add mock
> LLMs, mock tool results, mock verifiers, synthetic success labels,
> repository-specific repair rules, or benchmark-answer strings. Deterministic
> schema/storage checks may support development only when they use the real
> Runtime, real SQLite, and real execution artifacts; they never replace the
> required real-Agent acceptance.

**Date:** 2026-07-28

**Status:** execution in progress; the truth-calibrated current-state path
passed the Phase 1A immediate directional progression gate on one prelocked
fresh unseen real task. Product-wide H1 and H5 remain unconfirmed; the next
declared dependency is Task 1.6A, not selector expansion

**Primary workspace:** `/Volumes/ziel/new.aionis`

**Primary Runtime:** `/Volumes/ziel/new.aionis/AionisRuntime`

**Supersedes as execution order:**
`docs/plans/2026-07-27-adaptive-execution-memory-correctness-learning.md`

The superseded document remains a useful technical design input for episode
truth, intervention logging, statistical evaluation, and selector research.
This plan corrects its product boundary and implementation order. In
particular, Aionis is not an optional skill injector. Execution continuity is
always available; learned historical experience is selectively added only when
it is applicable and useful.

---

## 中文执行摘要

这份计划固定以下产品边界：

- Aionis 始终是完整的 Execution Memory，不是偶尔启用的技能注入器；
- 只要任务还在进行，Aionis 每次都必须保存并交付紧凑、准确的当前执行状态；
- 选择性只作用于“是否额外交付历史技能”，不作用于 Aionis 本身；
- 当前 continuity、episode、state、recall、UseNow、feedback、rehydrate、
  ordinary memory、SDK、AIFS、Substrate、MCP、CLI、Create、Manifest 的有效
  能力都保留；
- 当前最需要替换的是浅层 episode 摘要、固定任务规则、固定选择分数和重复
  prompt compiler；
- 新学习链必须是“真实成败轨迹对比 → L2 procedure hypothesis → 未见真实
  任务验证 → L3 ExecutionSkill → L4 contextual value model → L5 memory-use
  policy”；
- L0–L5 不控制 continuity。当前执行状态是与 L0–L5 正交的始终在线产品能力；
- 所有阶段只接受真实 LLM、真实工具、真实任务、真实 Runtime 和真实 verifier；
  不新增 mock 验收，不根据某一个任务给 Core 增加规则；
- 先证明 Runtime + SDK 的真实方向，再整合 MCP/AIFS/Substrate/Manifest/
  CLI/Create；不先包装一个尚未打出效果的学习内核；
- 新路径通过真实比较后才删除旧路径，最终目标是降低 25–30% 生产复杂度，
  而不是再次先删功能。

第一实施批不是 selector、ANN、GitHub、CI 或外围硬化，而是：

```text
盘点并保护当前 owner work
-> 建立有权威事件来源的 workspace current execution state
-> 把 current state 作为始终交付的独立上下文
-> 对浅 L1 episode 摘要做冷路径对照，不先删除旧行为
-> 用真实中断/恢复任务验证 continuity 和 token
-> 再迁移通用 subject contract 并验证两个真实非 workspace adapter
```

## 1. Goal

Build Aionis into a model-agnostic, always-available Execution Memory product
that:

1. continuously captures what an Agent is doing and why;
2. restores the smallest complete working state after interruption, handoff,
   compaction, process restart, Agent change, or model change;
3. converts real verified successes and failures into executable, transferable
   experience;
4. reuses that experience on related but unseen tasks;
5. withholds stale, harmful, irrelevant, or low-value experience;
6. measurably improves verified task completion, rediscovery cost, and token
   efficiency on real Agent tasks.

The target user-visible loop is:

```text
real task begins
-> Aionis restores current execution state
-> Agent acts with real tools
-> Aionis records actions, observations, mutations, decisions, and evidence
-> real verifier judges the resulting state
-> Aionis compares successes, failures, and no-experience executions
-> Aionis compiles transferable ExecutionSkills
-> a future Agent receives the smallest applicable state and experience
-> real outcomes update, split, strengthen, weaken, or retire that experience
```

## 2. Canonical Product Definition

> **Aionis is persistent Execution Memory for Agents. It continuously preserves
> and reconstructs executable working state, learns reusable procedures from
> verified execution outcomes, and supplies the minimum state and experience
> needed to complete future work more accurately and efficiently.**

This definition has two distinct product planes.

### 2.1 Always-on continuity plane

Whenever an Agent uses Aionis, Aionis must be able to provide:

- current goal and execution boundary;
- accepted decisions and their reasons;
- completed, failed, blocked, and unresolved work;
- changed artifacts and current workspace state;
- verified facts and evidence pointers;
- pending checks and the next justified action;
- relevant handoff state across sessions, Agents, devices, and models.

This plane is not conditional on learned-skill value. It is the persistent
Execution Memory service.

### 2.2 Adaptive experience plane

Aionis may additionally provide historical ExecutionSkills when evidence
supports their applicability and expected usefulness.

The decision to omit an old skill does not mean Aionis is unused. It means
Aionis is protecting the always-on current state from irrelevant history.

### 2.3 User-visible product outcomes

Aionis must eventually demonstrate all four outcomes:

| Outcome | User-visible meaning |
|---|---|
| Continuity | The next run continues from the real current state instead of rediscovering prior work. |
| Compression | The Agent receives a compact working set instead of replaying an entire transcript or tool history. |
| Learning | Verified experience improves how later related tasks are solved. |
| Controlled forgetting | Stale, contradicted, low-value, or harmful experience stops affecting execution without destroying provenance. |

### 2.4 What Aionis is not

Aionis is not:

- a generic vector database;
- a RAG wrapper;
- an Agent framework;
- a benchmark-specific rule engine;
- a governance or evidence product;
- a GitHub, CI, release, or reviewer workflow;
- a collection of coding-task recipes;
- a prompt that always appends old history;
- a system that declares learning because it stored a successful event.

Evidence, authority, verifier, lifecycle, and learning-control mechanisms remain
supporting mechanisms. They do not define the product or replace measurable
Agent effects.

### 2.5 Breakthrough hypothesis

The breakthrough is not any one database, graph, summary, skill prompt, or
bandit in isolation. It is the closed product algorithm:

```text
authoritative live execution state
+ verified semantic episode truth
+ success/failure contrastive procedure induction
+ held-out intervention validation
+ contextual value and cost selection
+ outcome-driven consolidation and forgetting
```

Falsifiable hypotheses:

- **H1 Continuity:** compact current state improves real resumption over a cold
  restart and approaches full-history correctness at substantially lower cost.
- **H2 Transfer:** contrastively induced L3 skills improve held-out task
  correctness over state-only Aionis.
- **H3 Selection:** compatibility plus contextual value produces fewer harmful
  transfers than similarity-only retrieval.
- **H4 Compounding:** later policy/skill versions improve over the initial
  frozen version without Runtime source changes between tasks.
- **H5 Efficiency:** combined Aionis lowers tokens per verified success after
  compiler cost is accounted for.

If these hypotheses fail on real multi-domain tasks, Aionis has not achieved
the intended breakthrough regardless of code volume or internal mechanism
quality.

## 3. Non-Negotiable Implementation Constraints

1. Preserve current working product capabilities while replacing weak learning
   paths. Do not perform another clean-break rewrite.
2. Do not encode any real benchmark item, repository path, issue answer,
   expected patch, command recipe, or task-family name into generic Runtime
   behavior.
3. Do not promote a rule from one task. Single executions may create evidence
   or an inert candidate only.
4. Do not add mock-based Aionis validation. Replace or retire existing mock-only
   acceptance paths as their real Runtime/LLM/task equivalents land.
5. Do not call internal context counts, memory counts, workflow counts, or
   self-reported guide fields product-effect evidence.
6. Do not expand verifier, authority, reviewer, deployment, GitHub, CI, ANN,
   UI, or operator infrastructure unless it directly blocks the Execution
   Memory loop in this plan.
7. Do not delete an existing capability until its general replacement passes
   the specified real-task comparison.
8. Aionis must remain model-agnostic by architecture. Provider-specific clients
   are adapters; provider names, dimensions, and task assumptions must not
   define core data contracts. Empirical claims are limited to the model
   families actually tested.
9. The production default is always-on continuity plus validated adaptive
   experience. `no_memory`, `state_only`, and fixed-policy modes are experiment
   arms, not competing product identities.
10. If a proposed change cannot name the expected effect on correctness,
    continuity, rediscovery, token cost, negative transfer, or generalization,
    it is out of scope.

## 4. Plan Baseline

This plan was written against the stable disk snapshot available on
2026-07-28.

### 4.1 Runtime baseline

- branch: `product-main`
- HEAD: `6f3557014117af85c19f1589a48173e87bd84b70`
- package: `aionis-runtime-focused@0.3.12`
- Runtime source files: 359
- Runtime source lines: 195,083
- complete Runtime product artifact: 200,175 lines
- Runtime-entry closure: 305 files / 162,971 lines
- product routes: 21
- environment fields: 177
- import cycles: 0
- working-tree entries at plan creation: 90

The working tree contains substantial owner work, including the execution
episode, state capture, verifier, reward, compiler, product-service, context,
SDK, and storage paths referenced by this plan. Implementation must preserve
and review those changes in place. Do not reset, clean, stash, or overwrite the
tree as a planning shortcut.

### 4.2 Package baseline

| Component | Package/version | Current role |
|---|---|---|
| Runtime | `aionis-runtime-focused@0.3.12` | authoritative execution memory, recall, continuity, episode truth, lifecycle |
| SDK | `@aionis/sdk@0.3.19` | TypeScript integration, AgentContext, episode and feedback calls |
| AIFS | `@aionis/aifs@0.3.4` | file projection of selected Runtime context |
| Substrate | `@aionis/substrate@0.1.11` | external event/evidence mirror and optional candidate index |
| MCP | `@aionis/mcp@0.3.7` | MCP bridge |
| CLI | `aionis@0.3.8` | product installer shell |
| Create | `@aionis/create@0.3.8` | Runtime checkout/configuration |
| Manifest | `@aionis/manifest@0.1.1` | deterministic procedure and module execution contracts |

`@aionis/create` currently selects Runtime `v0.3.6`, not the Runtime used by
this plan. Product integration cannot be considered complete until one
compatible version set installs and runs the canonical Agent loop.

### 4.3 Current real-effect baseline

The latest same-model, real-Runtime, real-repository Playwright cell recorded:

| Arm | Steps | Total tokens | Verifier |
|---|---:|---:|---|
| Aionis | 30 | 522,148 | failed |
| No memory | 30 | 439,625 | failed |
| Full history | 27 | 826,210 | failed |

The Aionis arm reported `actionable_history=false`, `use_now=0`, and seven
inspect items. This single task is diagnostic, not a product-level estimate.
It establishes that the current adaptive path has not demonstrated correctness
or token improvement and may add context cost when it has no executable
experience.

Historical Aionis evidence for continuity, route-state recovery, buried-history
recovery, and context compression remains valid within the protocols that
produced it. It must not be rewritten as broad cross-task correctness evidence.

## 5. Current System Disposition

### 5.1 Keep and build on

| Capability | Current implementation | Decision |
|---|---|---|
| Authoritative memory and graph | `src/store/lite-write-store.ts`, `src/store/lite-recall-store.ts` | Keep SQLite authority, provenance, visibility, and graph primitives. |
| Execution episode truth | `src/memory/execution-episode.ts`, `src/product/execution-episode-service.ts` | Keep identity, action/result, state, verifier, reward, and operation semantics. |
| Workspace/state capture | `src/execution/workspace-state-capture.ts`, `src/memory/host-current-execution-state.ts` | Keep and make the canonical continuity input. |
| Hybrid candidate recall | `src/store/lite-recall-store.ts`, `src/memory/recall-hybrid-merge.ts`, `src/memory/recall.ts` | Keep as candidate generation; do not treat similarity as final use authority. |
| Agent delivery semantics | `src/memory/agent-context-compiler.ts`, `src/memory/agent-context-renderer.ts` | Keep `current`, `use_now`, `inspect`, `do_not_use`; redefine their contents and budgets. |
| Feedback attribution | `src/product/lifecycle-service.ts`, `src/memory/node-feedback-state.ts` | Keep actual exposure/use linkage and negative feedback; connect it to skill value. |
| Lifecycle and rehydration | `src/kernel/forgetting-kernel.ts`, `src/memory/lifecycle-lite.ts` | Keep archive, tombstone, demotion, and rehydration primitives; replace fixed value rules. |
| Public product operations | `observe`, `guide`, `feedback`, `rehydrate`, `forget`, episode operations | Preserve capability coverage while unifying the Agent session flow. |

### 5.2 Replace

| Current path | Problem | Replacement |
|---|---|---|
| `src/memory/execution-episode-memory-compiler.ts` | Converts a verified execution into a shallow L1 event without causal or procedural semantics. | Contrastive semantic compiler that emits an inert `ProcedureHypothesisV2` or abstains. |
| `src/execution/task-cluster.ts` | Exact task/repository signatures identify instances but do not learn transfer. | Learned semantic/structural experience cohorts; exact signatures remain identity and deduplication only. |
| `src/memory/adaptive-guidance.ts` and fixed final scorers | Fixed lexical overlap, source weights, bonuses, thresholds, and templates. | Compatibility filtering plus a learned, uncertainty-aware utility selector. |
| `src/memory/trajectory-compile.ts` | Contains repository/task-derived command, family, invariant, and next-action recipes. | Generic event/state parser plus learned experience induction. Domain adapters may expose tool schemas, never solution recipes. |
| `src/memory/product-output/learning-effect.ts` | Emits fixed “trace-derived skill” instructions and null product deltas. | Real skill artifacts and real outcome/token effect reports. |
| `src/product/measure-service.ts` | Treats returned memories and self-reported guide fields as effect proxies. | Internal mechanism telemetry only; product effect comes from verifier-bound experiment outcomes. |
| Runtime and SDK prompt compilers | Duplicate prompt construction, divergent behavior, and very large default budgets. | One canonical structured AgentContext and one renderer owned by Runtime contracts and consumed by SDK/MCP/AIFS. |
| Fixed forgetting thresholds | Cannot learn value, drift, or transfer. | Utility, uncertainty, contradiction, version drift, and negative-transfer-based lifecycle. |

### 5.3 Remove from the generic product path after replacement passes

- synthetic execution tool registries;
- hard-coded code/CI, artifact visibility, database recovery, and service
  publication task families;
- pytest/npm/pnpm/curl/pip/service solution recipes;
- fixed benchmark-derived next-action templates;
- ordinary personal-profile extraction from the generic Execution Memory Core;
  if it has a real caller, migrate it to an optional ordinary-memory
  adapter/profile before removing the Core regex;
- fixed trace-derived skills;
- exact task/path identity as a reuse gate;
- duplicate SDK prompt assembly;
- shallow verified-event auto-publication into shared Agent context;
- dormant learning workers with no effect consumer;
- production startup dependencies that exist only for fixed experiments,
  admission studies, or evaluation orchestration;
- public product-effect claims based only on internal mechanism counts.

Removal occurs only after the replacement task named in this plan has passed
its real-task gate.

## 6. Target Architecture

```text
                       ALWAYS-ON EXECUTION MEMORY

Real Agent/Host
    |
    v
Canonical AgentSession (SDK or MCP adapter)
    |
    +--> begin/resume episode
    +--> record goal, decision, action, observation, result, mutation
    +--> capture current execution state
    +--> bind verifier to final state
    +--> close with real outcome and cost
    |
    v
SQLite authority
    |
    +--> Episode Ledger          raw execution truth
    +--> Current State Store     resumable working state
    +--> Memory Graph            facts, decisions, evidence, lifecycle
    +--> Skill Store             candidate/validated/deprecated skills
    +--> Intervention Ledger     what was eligible, delivered, used, and earned
    |
    +---------------------------+
    |                           |
    v                           v
Continuity Compiler       Experience Learning Pipeline
    |                     cohort -> contrast -> skill -> validation
    |                           |
    +-------------+-------------+
                  |
                  v
         Compatibility Filter
                  |
                  v
          Utility/Cost Selector
             /            \
      no learned skill   validated skill(s)
             \            /
                  v
        Budgeted Context Compiler
                  |
                  v
 current_state + use_now + inspect + do_not_use
                  |
                  v
              Real Agent
```

### 6.1 Runtime ownership

Runtime owns:

- authoritative episode, state, memory, skill, intervention, outcome, and
  lifecycle data;
- current-state reconstruction;
- generic candidate retrieval;
- skill compatibility and value selection;
- canonical AgentContext;
- skill induction orchestration and provenance;
- value update, consolidation, splitting, deprecation, and rehydration.

Runtime does not own:

- an Agent framework;
- task-specific solution knowledge;
- host-specific command recipes;
- benchmark orchestration;
- provider-specific product semantics;
- a second evaluator that substitutes internal counts for real task outcomes.

### 6.2 Component ownership

| Component | Target ownership |
|---|---|
| Runtime | product semantics, truth, learning, selection, context, lifecycle |
| Contracts artifact | generated-only `@aionis/contracts`; portable JSON Schemas/types/digests, no product logic |
| SDK | canonical `AgentSession`, transport, typed host integration |
| MCP | thin mapping from MCP calls to `AgentSession`; no duplicate decision logic |
| AIFS | deduplicated live file projection/interaction surface for canonical current state and selected skill, not an independent memory brain |
| Substrate | optional storage/candidate adapter behind Runtime interfaces, or a separately useful library; never a second authority |
| Manifest | executable procedure representation and deterministic invocation contract for validated skills |
| CLI/Create | install one compatible product set and produce one working local Agent loop |

### 6.3 Versioned subject-state adapters

Current episode/state capture is centered on a local coding workspace. A
general Execution Memory product must represent browser, database, service,
artifact, and other real execution subjects without teaching Core how to solve
those tasks.

Add a generic adapter boundary:

```ts
interface SubjectStateAdapter {
  readonly adapterId: string;
  readonly adapterVersion: string;

  supports(subjectKind: string): boolean;
  identify(input: unknown): Promise<SubjectIdentity>;
  capture(input: unknown): Promise<StateSnapshotV2>;
  diff(before: StateSnapshotV2, after: StateSnapshotV2): Promise<StateDeltaV1>;
}
```

Implementation boundary and migration order:

- new `src/execution/subject-state-adapter.ts`;
- first preserve and wrap the current local-workspace capture, episode, and
  verifier path as `workspace_subject_v2`;
- then migrate the episode contract, verifier subject materialization, artifact
  media types, store replay, transport, and SDK to the generic subject types;
- only after the workspace path is behaviorally equivalent, add at least two
  real non-workspace adapters such as database/service state and a structured
  artifact state;
- adapters describe identity, state, delta, and capabilities;
- adapters do not contain task solutions or promotion rules;
- Runtime episode, continuity, cohort, skill, selector, and verifier contracts
  operate on the generic subject representation;
- domain-specific adapters live outside the learning algorithm and can be
  supplied by hosts.

This abstraction is required before Aionis can claim cross-domain
generalization. An interface alone is not cross-domain support. It must be
introduced through the existing episode/state contracts rather than by
building a second state store, and no non-workspace claim is permitted until
the corresponding real adapter and verifier have run.

## 7. Canonical Continuity and L0-L5 Model

### 7.1 Continuity is orthogonal to L0-L5

Current execution state is an always-on product projection. It must not depend
on whether any historical artifact reaches L2, L3, L4, or L5.

`CurrentExecutionStateV2` answers “what is happening now?” on every resume or
guide:

- goal and scope;
- current phase and intent;
- completed, failed, unresolved, and blocked work;
- active artifacts and relevant state digests;
- accepted decisions, rejected alternatives, and reasons;
- pending verifier/check;
- next justified action;
- provenance pointers.

L0-L5 describe the learning path from raw truth to memory-use policy. They do
not gate continuity.

### L0 — Raw execution truth

Purpose: preserve action requests/results, observations, state snapshots and
deltas, verifier receipts, environment/model/tool descriptors, and token/tool/
time cost.

L0 is immutable raw evidence and does not directly enter the Agent prompt.

### L1 — Verified episode capsule

Purpose: assemble one evidence-bound account of what actually happened:

- initial state and task identity;
- ordered actions, decisions, and observations;
- request/result artifacts;
- state transitions;
- final verifier evidence;
- outcome and cost;
- failure or infrastructure classification.

L1 is learning and continuity evidence. A successful L1 episode is not a
reusable instruction and must not automatically enter `use_now`.

### L2 — Procedure hypothesis

Purpose: represent a parameterized method hypothesized from contrasting real
episodes.

L2 contains applicability, preconditions, decisive observations, procedure,
expected transitions, termination, verification, recovery, non-applicability,
and provenance. It is inert and must not enter production `use_now`.

### L3 — Validated ExecutionSkill or Workflow

Purpose: represent an L2 procedure that produced positive incremental value on
held-out real tasks, or a composition of such procedures whose dependencies and
boundaries have also been validated.

L3 may be delivered by the selector. It is not a long free-form checklist and
cannot form from counts alone.

### L4 — Contextual value model

Purpose: estimate applicability, verified-success uplift, token cost,
negative-transfer risk, and drift for skill × task/state/environment/model
contexts.

L4 is a versioned learned model, not prose placed in the Agent prompt.

### L5 — Execution Memory policy

Purpose: govern retrieval breadth, budget allocation, abstention, consolidation,
splitting, forgetting, and revalidation using the L4 value model and real
outcomes.

L5 is a versioned, inspectable meta-policy. It cannot be a manually authored
natural-language rule set.

## 8. Canonical Data Contracts

The exact TypeScript shapes may be refined during implementation, but semantic
fields and invariants in this section are mandatory.

### 8.1 Execution subject, snapshots, and semantic events

Current state is a projection of immutable execution events and captured
subject state. It is not a free-form object supplied by a host.

```ts
type ExecutionSubjectV1 = {
  subject_id: string;
  kind: string;
  adapter_id: string;
  adapter_version: string;
  identity_sha256: string;
  capability_descriptor_ref: string;
};

type StateSnapshotV2 = {
  snapshot_id: string;
  subject: ExecutionSubjectV1;
  captured_at: string;
  content_ref: string;
  content_sha256: string;
  capture_authority:
    | "runtime_adapter"
    | "signed_host_adapter";
  attestation_ref: string | null;
};

type StateDeltaV1 = {
  delta_id: string;
  subject_id: string;
  before_snapshot_id: string;
  after_snapshot_id: string;
  changed_fields: string[];
  content_ref: string;
  content_sha256: string;
};

type SemanticEventAuthorityV1 = {
  kind: "host_declared" | "runtime_derived" | "model_derived";
  actor_id: string;
  model_id: string | null;
  derivation_sha256: string | null;
  uncertainty: number | null;
  evidence_refs: string[];
};

type SemanticObservationEventV1 = {
  event_id: string;
  episode_id: string;
  observation: string;
  state_snapshot_id: string | null;
  authority: SemanticEventAuthorityV1;
  recorded_at: string;
};

type AgentDecisionEventV1 = {
  event_id: string;
  episode_id: string;
  decision: string;
  reasons: string[];
  alternatives_rejected: string[];
  authority: SemanticEventAuthorityV1;
  recorded_at: string;
};

type ProgressStateEventV1 = {
  event_id: string;
  episode_id: string;
  item_id: string;
  state: "completed" | "failed" | "unresolved" | "blocked";
  statement: string;
  authority: SemanticEventAuthorityV1;
  recorded_at: string;
};

type PlannedActionEventV1 = {
  event_id: string;
  episode_id: string;
  action_id: string;
  intent: string;
  justification: string;
  preconditions: string[];
  authority: SemanticEventAuthorityV1;
  recorded_at: string;
};

type ExecutionSessionLeaseV1 = {
  session_key: string;
  continuation_id: string;
  episode_id: string;
  holder_id: string;
  lease_revision: number;
  expires_at: string;
};

type ExecutionSessionHandoffReceiptV1 = {
  receipt_id: string;
  session_key: string;
  continuation_id: string;
  episode_id: string;
  from_holder_id: string;
  to_holder_id: string;
  from_lease_revision: number;
  state_sha256: string;
  evidence_refs: string[];
  receipt_sha256: string;
  created_at: string;
};
```

Authority rules:

- the local workspace adapter is Runtime-owned and captures before/after/final
  state itself;
- a remote or non-local host may submit only immutable snapshot references
  produced by a registered, signed host adapter;
- arbitrary host text cannot become authoritative subject state;
- model-derived observation/decision/progress semantics remain explicitly
  uncertain and must cite the raw events from which they were derived;
- `next_action` is projected only from the latest applicable
  `PlannedActionEventV1`; without one, it is `null` rather than inferred from a
  task recipe;
- a `session_key` identifies one active task execution, while
  `continuation_id` links its resumable lineage;
- lease acquisition and state updates use compare-and-swap. Two Agents sharing
  a scope cannot silently attach to the same open episode;
- an active conflicting lease returns an explicit conflict; takeover is allowed
  only after expiry or an explicit handoff receipt and creates a new lease
  revision/event;
- begin/resume matches session key, subject identity, continuation lineage, and
  goal digest; scope alone is never enough to select an episode;
- all snapshots, deltas, semantic events, and lease transitions are append-only
  or versioned.

Migration is deliberately two-step. Phase 1 preserves the existing workspace
episode/verifier path and adds these contracts around it. A separate subject-V2
migration then updates episode, verifier materialization, storage replay,
transport, and SDK contracts before any cross-domain claim. The abstraction is
not considered complete until two real non-workspace adapters also pass their
own capture, delta, resume, and verifier tests.

### 8.2 `CurrentExecutionStateV2`

```ts
type CurrentExecutionStateV2 = {
  version: "current_execution_state_v2";
  scope_id: string;
  continuation_id: string;
  task_run_id: string;
  episode_id: string;
  parent_episode_id: string | null;
  revision: number;
  parent_state_sha256: string | null;
  subject: {
    kind: string;
    adapter_id: string;
    adapter_version: string;
    identity_sha256: string;
    current_snapshot_ref: string;
  };
  goal: string;
  phase: string | null;
  completed: ExecutionItem[];
  failed: ExecutionItem[];
  unresolved: ExecutionItem[];
  blocked: ExecutionItem[];
  decisions: DecisionRecord[];
  active_artifacts: ArtifactState[];
  verified_facts: EvidenceBoundFact[];
  pending_checks: PendingCheck[];
  next_action: JustifiedAction | null;
  state_sha256: string;
  evidence_refs: string[];
  updated_at: string;
};
```

Invariants:

- every claim names evidence or is marked unverified;
- old and current state cannot silently merge;
- each update uses compare-and-swap against `revision` and
  `parent_state_sha256`;
- `continuation_id` remains stable across episode/session/model boundaries,
  while `task_run_id` and episode lineage preserve individual attempts;
- subject identity and adapter version are part of state authority;
- `next_action` must follow from current state, not a static task recipe;
- completed/failed/unresolved/blocked/decision fields are derived only from
  the semantic events above, with their authority and evidence preserved;
- `state_sha256` is computed from canonical semantic content, identity,
  lineage, revision, subject snapshot, and evidence refs; it excludes
  `state_sha256` itself and non-semantic wall-clock metadata such as
  `updated_at`;
- renderer output is bounded independently from raw state storage.

Atomicity is a product invariant, not a best-effort worker behavior:

- lease acquire plus episode begin/resume plus session/continuation binding
  commits in one Runtime database transaction, or none of it commits;
- every accepted high-level turn checks the active lease revision and commits
  its immutable semantic events, snapshot/delta references, operation receipt,
  current-state compare-and-swap head, and state-projector cursor in one
  transaction;
- verifier result, final snapshot binding, episode close, and lease
  release/handoff likewise commit as one close transaction;
- low-level event APIs used during an active session route through the same
  transactional turn coordinator and cannot append an event while leaving the
  authoritative state head behind;
- import/recovery uses a durable per-continuation projector cursor and an
  idempotent replay path. On restart it projects only committed, unapplied
  events; a cursor/head digest mismatch is surfaced and quarantined rather than
  silently inventing or skipping state;
- transaction rollback leaves no orphan lease, open episode, accepted event,
  or advanced state head. Idempotent retry with the same operation ID returns
  the committed result.

### 8.3 `ExecutionEpisodeV1`

The current episode contract remains the raw truth source. The implementation
must preserve:

- identity and scope;
- task and environment descriptors;
- model and tool descriptors;
- action request/result references;
- before/after state;
- verifier program and final-state binding;
- pass, failure, infrastructure, and contamination classification;
- input/output/cached tokens, tool count, elapsed time, and termination reason.

Exact task/repository signatures remain valid for identity, pairing protection,
and deduplication. They do not define the transfer scope.

### 8.4 `VerifiedEpisodeCapsuleV2`

```ts
type VerifiedEpisodeCapsuleV2 = {
  capsule_id: string;
  layer: "L1";
  episode_id: string;
  outcome_projection_id: string;
  goal: string;
  semantic_task_fingerprint_ref: string;
  initial_state_ref: string;
  trajectory: Array<{
    action_event_id: string;
    intent: string;
    request_ref: string;
    result_ref: string;
    state_delta_ref: string;
    observed_effect: string;
  }>;
  final_state_ref: string;
  verifier_ref: string;
  failure_analysis: {
    failure_mode: string | null;
    last_progressing_action_id: string | null;
    repeated_nonprogress_action_ids: string[];
  };
  evidence_refs: string[];
  prompt_eligible: false;
};
```

Semantic fields must cite real event/artifact references. Missing semantics stay
unknown rather than being guessed.

### 8.5 `ExperienceCohortV1`

```ts
type EmbeddingProjectionRefV1 = {
  projection_id: string;
  provider: string;
  model: string;
  model_config_sha256: string;
  dimension: number;
  input_sha256: string;
  normalization: "none" | "l2";
  projection_version: string;
  vector_ref: string;
};

type BoundedFeatureSnapshotV1 = {
  feature_schema_id: string;
  feature_schema_version: string;
  values: Array<{
    feature_id: string;
    value: number | boolean | string;
    evidence_ref: string;
  }>;
  snapshot_sha256: string;
};

type ExperienceCohortV1 = {
  cohort_id: string;
  target_problem_embedding: EmbeddingProjectionRefV1;
  environment_features: BoundedFeatureSnapshotV1;
  initial_state_features: BoundedFeatureSnapshotV1;
  capability_descriptor_refs: string[];
  source_successful_episode_ids: string[];
  source_failed_episode_ids: string[];
  source_counterexample_episode_ids: string[];
  excluded_episode_ids: Array<{
    episode_id: string;
    reason: string;
  }>;
  construction_policy_sha256: string;
};

type RealEpisodeCohortPackV1 = {
  pack_id: string;
  version: string;
  episode_manifest: Array<{
    episode_id: string;
    task_cluster_id: string;
    split: "training" | "development" | "heldout" | "negative_neighbor";
    episode_artifact_ref: string;
    episode_sha256: string;
    verifier_receipt_ref: string;
    verifier_receipt_sha256: string;
    cost_receipt_ref: string;
    cost_receipt_sha256: string;
  }>;
  subject_adapter_versions: string[];
  model_tool_environment_manifest_ref: string;
  model_tool_environment_manifest_sha256: string;
  split_manifest_ref: string;
  split_manifest_sha256: string;
  provenance_manifest_ref: string;
  provenance_sha256: string;
  dependency_manifest_ref: string;
  dependency_manifest_sha256: string;
  pack_sha256: string;
};
```

Every manifest reference is content-addressed and resolvable during isolated
import. The dependency manifest is the closed transitive list of episode
artifacts, raw model request/response artifacts, tool action results, subject
snapshots/deltas, verifier programs and receipts, cost receipts, schema
versions, adapter/capability descriptors, compiler prompts, policies, and model
configuration artifacts required to reproduce the pack. A digest without its
resolvable artifact reference is not a valid pack dependency.

The cohort builder must use semantic problem/state similarity plus structural
action and environment features. It must not use repository-specific task
labels, benchmark labels, test names, expected answers, or fixed solution
families. Compilation uses only `source_*` episodes. State-only and exposed
validation episodes belong to `SkillValidationReceiptV1`; the source cohort is
never mutated after validation.

Embedding dimensions are provider/model properties, not a Core constant. The
current forced 1536-dimensional path is migrated to the projection contract:
incompatible projections are never directly compared, and changing model,
configuration, input, normalization, or dimension invalidates the affected
cohort cache and requires explicit reprojection.

Feature schemas are versioned allow-lists with bounded cardinality and numeric,
boolean, or bounded-enum values. Open arbitrary string maps are forbidden in
cohort construction and selector training.

### 8.6 Bounded predicates, capabilities, and parameter binding

```ts
type ExecutionOperandV1 =
  | {
      kind: "field_ref";
      feature_schema_id: string;
      field_id: string;
    }
  | {
      kind: "parameter_ref";
      parameter_id: string;
    }
  | {
      kind: "schema_literal";
      value_schema_ref: string;
      value: number | boolean | string;
    };

type ExecutionPredicateV1 =
  | {
      op: "exists";
      operand: ExecutionOperandV1;
    }
  | {
      op: "equals";
      left: ExecutionOperandV1;
      right: ExecutionOperandV1;
    }
  | {
      op: "version_satisfies";
      version: ExecutionOperandV1;
      range_schema_ref: string;
      range: string;
    }
  | {
      op: "capability_available";
      capability_id: string;
    }
  | {
      op: "all" | "any";
      children: ExecutionPredicateV1[];
    }
  | {
      op: "not";
      child: ExecutionPredicateV1;
    };

type CapabilityDescriptorV1 = {
  capability_id: string;
  version: string;
  input_schema_ref: string;
  output_schema_ref: string;
  side_effect_class: "none" | "reversible" | "irreversible";
  evidence_ref: string;
};

type HostCapabilityRegistryEntryV1 = {
  capability: CapabilityDescriptorV1;
  resolver:
    | {
        kind: "host_callback";
        callback_id: string;
        callback_version: string;
      }
    | {
        kind: "manifest_module";
        module_ref: string;
        module_sha256: string;
      };
  registered_by: string;
  registration_sha256: string;
};

type BindingExpressionV1 =
  | { kind: "parameter_ref"; parameter_id: string }
  | {
      kind: "field_ref";
      feature_schema_id: string;
      field_id: string;
    }
  | {
      kind: "schema_literal";
      value_schema_ref: string;
      value: number | boolean | string;
    };

type SkillParameterV1 = {
  parameter_id: string;
  value_type: "string" | "number" | "boolean" | "artifact_ref";
  source: "task" | "subject_state" | "environment" | "agent";
  source_field: {
    feature_schema_id: string;
    field_id: string;
  };
  required: boolean;
};

type ParameterBindingReceiptV1 = {
  receipt_id: string;
  artifact_kind: "L2_hypothesis" | "L3_skill";
  artifact_id: string;
  artifact_version: number;
  current_state_sha256: string;
  bindings: Array<{
    parameter_id: string;
    value_ref: string;
    authority: "runtime_adapter" | "signed_host_adapter" | "explicit_agent";
    evidence_ref: string;
  }>;
  unresolved_parameter_ids: string[];
  binding_sha256: string;
};

type ProcedureStepV1 = {
  step_id: string;
  capability_id: string;
  input_bindings: Record<string, BindingExpressionV1>;
  preconditions: ExecutionPredicateV1[];
  expected_transition_ids: string[];
};

type ExpectedTransitionV1 = {
  transition_id: string;
  predicate: ExecutionPredicateV1;
};

type VerificationStepV1 = {
  verification_id: string;
  capability_id: string;
  input_bindings: Record<string, BindingExpressionV1>;
  pass_predicate: ExecutionPredicateV1;
};

type CapabilityInvocationReceiptV1 = {
  receipt_id: string;
  capability_id: string;
  capability_version: string;
  registry_entry_sha256: string;
  binding_receipt_id: string;
  request_artifact_ref: string;
  result_artifact_ref: string;
  action_event_id: string;
  receipt_sha256: string;
};

type TerminationConditionV1 = {
  condition_id: string;
  kind: "success" | "stop" | "handoff";
  predicate: ExecutionPredicateV1;
};

type RecoveryBranchV1 = {
  branch_id: string;
  trigger: ExecutionPredicateV1;
  step_ids: string[];
  termination_condition_ids: string[];
};

type EvidencePatternV1 = {
  description: string;
  predicate: ExecutionPredicateV1;
  source_evidence_refs: string[];
  uncertainty: number | null;
};

type FailureModeV1 = {
  failure_mode_id: string;
  description: string;
  detection: ExecutionPredicateV1[];
  evidence_refs: string[];
};

type CounterexampleRefV1 = {
  episode_id: string;
  intervention_id: string | null;
  evidence_refs: string[];
};

type VersionConstraintV1 = {
  capability_id: string;
  range: string;
};
```

Predicate fields may address only fields exported by the active subject adapter
and versioned feature schema. Core does not evaluate arbitrary code, regular
expressions, repository names, test names, or task-family switches. Predicate
depth, child count, feature cardinality, and value sizes have contract limits.
Every literal is validated against a declared bounded schema; arbitrary string
values cannot be embedded in reusable predicates or capability inputs.

Reusable procedure content contains parameters, never instance literals.
Instance-specific paths, identifiers, and values remain in evidence or a
`ParameterBindingReceiptV1`. Required unresolved parameters make the procedure
inapplicable or inspect-only; Runtime never guesses a binding.

The host capability registry is the only resolver from a procedure capability
ID to a real host callback or Manifest module. Registration is versioned;
inputs are validated against the capability schema; every call produces a
`CapabilityInvocationReceiptV1`. Subject adapters expose state and
capabilities, but do not silently execute procedures.

### 8.7 `ProcedureContentV1` and `ProcedureHypothesisV2`

```ts
type ProcedureContentV1 = {
  goal_pattern: string;
  applicability: {
    semantic_description: string;
    required_state: ExecutionPredicateV1[];
    required_capabilities: string[];
    compatible_environments: ExecutionPredicateV1[];
    incompatible_conditions: ExecutionPredicateV1[];
  };

  diagnosis: {
    decisive_observations: EvidencePatternV1[];
    failure_modes: FailureModeV1[];
    discriminating_checks: VerificationStepV1[];
  };

  procedure: {
    parameters: SkillParameterV1[];
    steps: ProcedureStepV1[];
    expected_transitions: ExpectedTransitionV1[];
    termination: TerminationConditionV1[];
    verification: VerificationStepV1[];
    recovery: RecoveryBranchV1[];
  };

  boundaries: {
    does_not_apply: ExecutionPredicateV1[];
    known_counterexamples: CounterexampleRefV1[];
    version_constraints: VersionConstraintV1[];
  };
  unresolved_assumptions: string[];
};

type ProcedureHypothesisV2 = {
  hypothesis_id: string;
  layer: "L2";
  version: number;
  status: "candidate" | "in_validation" | "rejected" | "contested";
  content: ProcedureContentV1;
  evidence: {
    source_episode_ids: string[];
    contrast_episode_ids: string[];
    negative_neighbor_episode_ids: string[];
    verifier_refs: string[];
    compiler_model: string;
    compiler_prompt_sha256: string;
    content_sha256: string;
  };
  production_prompt_eligible: false;
  validation_prompt_eligible: true;
};
```

Mandatory properties:

- executable steps are parameterized, not copied repository paths;
- applicability and non-applicability are both represented;
- verification and termination are first-class;
- source and contrast episodes are addressable;
- compiler output can abstain;
- L2 cannot directly authorize `use_now`;
- L2 may be rendered only inside a frozen paired-validation block whose policy
  names the exact hypothesis version/content digest; that validation authority
  never makes it production-eligible;
- every revision creates a new version and preserves provenance.

### 8.8 `SkillValidationReceiptV1` and `ValidatedExecutionSkillV1`

```ts
type LimitedDeliveryScopeV1 = {
  scope_id: string;
  subject_kinds: string[];
  semantic_task_signature_refs: string[];
  environment_predicates: ExecutionPredicateV1[];
  expires_at: string;
  scope_sha256: string;
};

type SkillValidationProtocolV1 = {
  protocol_id: "validation_protocol_v1";
  protocol_version: string;
  design: "cloned_paired_block";
  estimator: "signature_stratified_paired_risk_difference";
  interval: "deterministic_stratified_paired_percentile_bootstrap";
  bootstrap_replicates: 50000;
  familywise_alpha: 0.05;
  minimum_relevant_uplift: 0.08;
  minimum_power: 0.8;
  minimum_validated_pairs: 24;
  minimum_semantic_signatures: 3;
  minimum_pairs_per_signature: 8;
  severe_regression_codes: string[];
  missing_block_policy: "arm_failure_or_locked_reserve_replacement";
  contamination_policy: "invalidate_whole_pair_and_contest_if_post_exposure";
  protocol_sha256: string;
};

type SkillValidationReceiptV1 = {
  receipt_id: string;
  hypothesis_id: string;
  hypothesis_version: number;
  hypothesis_content_sha256: string;
  protocol_sha256: string;
  split_manifest_sha256: string;
  validation_policy_id: string;
  validation_policy_version: string;
  assignment_receipts_sha256: string;
  validation_design: "cloned_paired_block";
  randomization_unit: "paired_base_task";
  paired_base_task_ids_sha256: string;
  estimator_id: string;
  estimator_version: string;
  analysis_code_sha256: string;
  validation_family_id: string;
  validation_family_size: number;
  adjusted_alpha: number;
  power_simulation_ref: string | null;
  power_simulation_sha256: string | null;
  valid_pair_count: number;
  treatment_episode_ids: string[];
  control_episode_ids: string[];
  excluded_episode_ids: Array<{
    episode_id: string;
    reason: string;
  }>;
  outcome_summary_sha256: string;
  verified_success_uplift: number;
  uplift_lower_bound: number;
  negative_transfer_rate: number;
  negative_transfer_upper_bound: number;
  mean_prompt_tokens: number;
  gate_result: "passed" | "limited" | "failed" | "contested";
  limited_delivery_scope: LimitedDeliveryScopeV1 | null;
  receipt_sha256: string;
  created_at: string;
};

type ValidatedExecutionSkillV1 = {
  skill_id: string;
  layer: "L3";
  version: number;
  status: "validated" | "limited" | "contested" | "deprecated";
  source_hypothesis_id: string;
  source_hypothesis_version: number;
  source_hypothesis_content_sha256: string;
  content: ProcedureContentV1;
  content_sha256: string;
  execution_form:
    | { kind: "agent_guidance" }
    | { kind: "manifest"; manifest_ref: string; manifest_sha256: string };
  validation: {
    receipt_id: string;
    receipt_sha256: string;
  };
  limited_delivery_scope: LimitedDeliveryScopeV1 | null;
  lifecycle_receipt_id: string | null;
  delivery: {
    compact_summary: string;
    estimated_tokens: number;
    disclosure_levels: Array<"summary" | "procedure" | "evidence">;
  };
};

type SkillLifecycleReceiptV1 = {
  receipt_id: string;
  skill_id: string;
  from_version: number;
  to_version: number;
  from_status: ValidatedExecutionSkillV1["status"];
  to_status: ValidatedExecutionSkillV1["status"];
  policy_id: string;
  policy_version: string;
  evidence_refs: string[];
  reason_code: string;
  receipt_sha256: string;
  created_at: string;
};
```

Only `validated` L3 is eligible for normal adaptive production delivery.
Scope-compatible `limited` L3 is eligible only inside the controlled
development scope named by its validation receipt and policy. `contested` and
`deprecated` are never directly delivered. L2 validation uses its own
assignment policy and does not create an “experimental L3”.

Canonical state machine:

```text
L2 candidate
-> L2 in_validation
   -> L2 rejected
   -> L2 contested
   -> limited SkillValidationReceipt -> L3 limited
   -> passed SkillValidationReceipt  -> L3 validated
L3 limited -> new validation -> L3 validated
L3 limited|validated -> append-only lifecycle receipt
                     -> new L3 contested|deprecated version
```

Only `ExecutionSkillPromotionService` may consume a `limited` or `passed`
`SkillValidationReceiptV1` and create the corresponding L3 status. A limited
receipt must include an executable `limited_delivery_scope`; a passed receipt
must set it to `null`. Consolidation, feedback, and forgetting may propose a
new L2 revision or append a `SkillLifecycleReceiptV1`, but they cannot mutate an
existing L3 version or bypass the promotion service.

Promotion recomputes the receipt digest, loads the exact
`hypothesis_id`/version/content digest named by the receipt, and requires the
new L3 `content_sha256` to equal that validated canonical L2 content digest.
Any semantic edit creates a new L2 version and requires new validation; a
promotion worker cannot validate one payload and publish another.

### 8.9 Immutable intervention and use receipts

An intervention is not one mutable row that is filled in after execution. It is
an immutable receipt sequence. This preserves the existing append-only episode
and reward evidence model and prevents later use/outcome fields from changing
what the Agent was originally offered.

```ts
type CandidateFeatureSnapshotV1 = {
  artifact_kind: "L2_hypothesis" | "L3_skill";
  artifact_id: string;
  artifact_version: number;
  features: BoundedFeatureSnapshotV1;
  compatibility: "eligible" | "ineligible";
  rejection_reason_codes: string[];
};

type RenderedSectionReceiptV1 = {
  section_id: string;
  kind: "current_state" | "use_now" | "inspect" | "do_not_use";
  source_artifact_refs: string[];
  content_sha256: string;
  token_count: number | null;
  token_usage_authority:
    | "exact_tokenizer"
    | "host_receipt"
    | "estimated"
    | "unavailable";
};

type MemoryInterventionOfferedV1 = {
  intervention_id: string;
  episode_id: string;
  decision_index: number;
  current_state_sha256: string;
  candidate_set: CandidateFeatureSnapshotV1[];
  selected: Array<{
    artifact_kind: "L2_hypothesis" | "L3_skill";
    artifact_id: string;
    artifact_version: number;
  }>;
  rendered_sections: RenderedSectionReceiptV1[];
  rendered_token_count: number | null;
  token_usage_authority:
    | "exact_tokenizer"
    | "host_receipt"
    | "estimated"
    | "unavailable";
  policy_kind: "paired_validation" | "development_assignment" | "learned";
  policy_id: string;
  policy_version: string;
  assignment_receipt_id: string | null;
  assignment_receipt_sha256: string | null;
  assignment_probability: number | null;
  candidate_selection_probability: number | null;
  assignment_reason_code: string;
  offered_at: string;
};

type MemoryActualUseReceiptV1 = {
  receipt_id: string;
  operation_id: string;
  intervention_id: string;
  episode_id: string;
  artifact_kind: "L2_hypothesis" | "L3_skill";
  artifact_id: string;
  artifact_version: number;
  section_ids: string[];
  step_ids: string[];
  action_event_refs: string[];
  use_status: "used" | "partially_used" | "contradicted" | "not_used";
  authority: "explicit_host" | "signed_tool_adapter";
  authority_actor_id: string;
  evidence_refs: string[];
  receipt_sha256: string;
  recorded_at: string;
};

type MemoryOutcomeLinkReceiptV1 = {
  receipt_id: string;
  operation_id: string;
  intervention_id: string;
  episode_id: string;
  outcome_projection_id: string;
  receipt_sha256: string;
  recorded_at: string;
};

type MemoryInterventionViewV1 = {
  offered: MemoryInterventionOfferedV1;
  actual_use: MemoryActualUseReceiptV1[];
  outcome_link: MemoryOutcomeLinkReceiptV1 | null;
};

type PairedHypothesisValidationPolicyV1 = {
  policy_id: string;
  version: string;
  hypothesis_id: string;
  hypothesis_version: number;
  hypothesis_content_sha256: string;
  arms: ["state_only", "state_plus_hypothesis"];
  design: "cloned_paired_block";
  order_randomization_seed_sha256: string;
  task_split_sha256: string;
  validation_scope_sha256: string;
  created_at: string;
};

type DevelopmentAssignmentPolicyV1 = {
  policy_id: string;
  version: string;
  eligible_l3: Array<{
    skill_id: string;
    skill_version: number;
    content_sha256: string;
  }>;
  arms: ["state_only", "state_plus_skill"];
  arm_probabilities: {
    state_only: number;
    state_plus_skill: number;
  };
  candidate_rule: "uniform_over_eligible_l3";
  randomization_unit: "task_cluster";
  seed_sha256: string;
  task_split_sha256: string;
  created_at: string;
};

type DevelopmentAssignmentReceiptV1 = {
  receipt_id: string;
  policy_id: string;
  policy_version: string;
  episode_id: string;
  intervention_id: string;
  decision_index: number;
  task_cluster_id: string;
  focal_skill_id: string;
  focal_skill_version: number;
  focal_skill_content_sha256: string;
  candidate_selection_probability: number;
  arm: "state_only" | "state_plus_skill";
  arm_probability: number;
  eligible_candidate_set_sha256: string;
  joint_probability: number;
  deterministic_draw_index: number;
  assigned_at: string;
  receipt_sha256: string;
};
```

`MemoryInterventionViewV1` is derived/materialized only; it is never a second
authority. Implementation extends or maps the existing
`DecisionCommittedReceiptV1`, learning exposure event, guide feedback
attribution, and `EpisodeRewardV1`. It must not create a parallel intervention
truth system.

“Nothing rendered” is a real `state_only` intervention, not missing data. Phase
2 L3 validation uses cloned paired blocks: both arms run from identical
snapshots, only arm order is randomized, and no propensity/IPW claim is made.
Phase 3 L4 training uses the separate cluster-randomized
`DevelopmentAssignmentPolicyV1` with durable arm, candidate-selection, and
joint probabilities. Neither depends on L4/L5. Task 3.3 creates the first
learned L4/L5 artifacts from the randomized development ledger.

For V1, development arm probabilities are frozen at 0.5/0.5 and must sum to
one. Assignment is explicitly two-stage: before the arm draw, Runtime samples
one focal L3 uniformly from the frozen eligible set and persists its
id/version/content digest and candidate probability on both arms; only then
does it draw whether that focal skill is rendered. The state-only intervention
has an empty `selected` array but its candidate set and assignment receipt still
carry the same focal skill and skill features. `joint_probability` is focal
candidate probability multiplied by arm probability. If no eligible focal
skill exists, ordinary state-only service may continue but no development
assignment/training row is created. A cluster is assigned exactly once.
Missing, zero, inconsistent, or post-outcome focal/arm probabilities make the
row ineligible for L4 training.

For `policy_kind="development_assignment"`, both assignment-receipt fields on
`MemoryInterventionOfferedV1` are mandatory and must match the same
episode/intervention/decision index. Runtime creates the assignment before any
rendering or Agent action and atomically commits the immutable assignment plus
offered receipt; outcome and actual-use receipts can only append afterward.
For other policy kinds these fields are `null` unless that policy defines its
own compatible immutable assignment receipt. This binding is what lets a
state-only outcome remain the control for its counterfactual focal skill.

If use cannot be proved by an explicit host or signed tool-adapter receipt, its
status is unknown: Runtime must not infer use from lexical overlap, action
success, or final task success.

### 8.10 `ExecutionCostReceiptV1` and `TaskOutcomeProjectionV1`

```ts
type ExecutionCostReceiptV1 = {
  cost_receipt_id: string;
  episode_id: string;
  provider: string;
  model: string;
  model_config_sha256: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  token_usage_authority:
    | "provider_total"
    | "exact_tokenizer"
    | "signed_host_receipt"
    | "estimated"
    | "unavailable";
  tool_calls: number;
  elapsed_ms: number;
  monetary_cost: number | null;
  currency: string | null;
  raw_usage_artifact_ref: string | null;
  producer_id: string;
  receipt_sha256: string;
  recorded_at: string;
};

type TaskOutcomeProjectionV1 = {
  projection_id: string;
  episode_id: string;
  verifier_receipt_id: string;
  episode_reward_id: string;
  cost_receipt_id: string;
  final_state_sha256: string;
  verifier_id: string;
  verifier_program_sha256: string;
  status: "passed" | "failed" | "infrastructure_error" | "contaminated";
  failure_class: string | null;
  evidence_refs: string[];
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  token_usage_authority:
    | "exact_tokenizer"
    | "provider_total"
    | "signed_host_receipt"
    | "estimated"
    | "unavailable";
  tool_calls: number;
  elapsed_ms: number;
  termination_reason: string;
  source_digest: string;
};
```

This is an immutable projection derived from the existing verifier receipt,
`EpisodeRewardV1`, and cost receipt. It is not a new outcome authority and is
not independently editable. A source change produces a new projection/version,
never an in-place overwrite.

Provider totals authorize only whole-request input/output/cache fields in
`ExecutionCostReceiptV1`; they never authorize per-section memory counts.
Unavailable usage still produces a receipt with null token fields and
`unavailable` authority.

Only `passed` and task-caused `failed` outcomes update skill effectiveness.
Infrastructure and contaminated runs remain evidence but do not train value.

Verifier execution may be owned by the real host/task adapter. Runtime must bind
the verifier identity, program/config digest, evidence, and authoritative final
state snapshot. Existing Runtime-owned verifier execution remains the local
workspace implementation; a trusted external adapter may submit a signed,
content-addressed verifier receipt, but not an arbitrary success enum.

### 8.11 `ContextualValueModelV1`

```ts
type CalibrationSummaryV1 = {
  brier_score: number;
  calibration_slope: number;
  calibration_intercept: number;
  effective_sample_size: number;
  cluster_count: number;
  bucket_report_ref: string;
};

type ContextualValueModelV1 = {
  model_id: string;
  layer: "L4";
  version: string;
  feature_schema_sha256: string;
  algorithm: "cluster_bootstrap_logistic_uplift_v1";
  assignment_policy_refs: string[];
  training_manifest_sha256: string;
  parameters_ref: string;
  training_episode_ids_sha256: string;
  calibration_summary: CalibrationSummaryV1;
  created_at: string;
};
```

### 8.12 `ExecutionMemoryPolicyV1`

```ts
type CurrentStateRenderPolicyV1 = {
  policy_id: string;
  version: string;
  minimum_required_fields: Array<
    "goal" | "completed" | "failed" | "unresolved" | "blocked" | "decisions"
  >;
  maximum_tokens: number;
  truncation_order: Array<
    "old_evidence" | "completed_detail" | "decision_detail" | "active_state"
  >;
  policy_sha256: string;
};

type ExplorationPolicyV1 = {
  policy_id: string;
  version: string;
  maximum_assignment_probability: number;
  maximum_harm_upper_bound: number;
  minimum_effective_sample_size: number;
  allowed_skill_statuses: Array<"limited" | "validated">;
  training_evidence_sha256: string;
};

type SkillLifecyclePolicyV1 = {
  policy_id: string;
  version: string;
  minimum_independent_exposures: number;
  interval_level: number;
  split_effect_difference: number;
  deprecate_value_upper_bound: number;
  quarantine_harm_upper_bound: number;
  drift_revalidation_window: number;
  allowed_actions: Array<
    "retain" | "narrow" | "split" | "quarantine" | "deprecate" | "revalidate"
  >;
  training_evidence_sha256: string;
};

type ExecutionMemoryPolicyV1 = {
  policy_id: string;
  layer: "L5";
  version: string;
  value_model_id: string;
  candidate_limit: number;
  compatibility_required: true;
  learned_experience_maximum_tokens: number;
  allow_no_skill: true;
  token_cost_weight: number;
  latency_cost_weight: number;
  negative_transfer_weight: number;
  abstention_threshold: number;
  exploration_policy: ExplorationPolicyV1;
  lifecycle_policy: SkillLifecyclePolicyV1;
  training_evidence_sha256: string;
  holdout_report_ref: string;
  created_at: string;
};
```

L4/L5 artifacts must be reproducible from real episodes and inspectable. They
must not contain task-answer strings or hidden repository recipes.
Selection, exploration, consolidation, splitting, revalidation, quarantine, and
forgetting thresholds live in these versioned artifacts. Core consumes them; it
does not introduce fallback magic counts.

`CurrentStateRenderPolicyV1` is a separate stable continuity contract, not L5.
The canonical session renders current state first. L5 may spend only the
remaining caller budget up to `learned_experience_maximum_tokens`; it cannot
reduce, suppress, or rewrite current state. If the caller budget cannot satisfy
the continuity minimum, the session returns an explicit budget error instead of
silently omitting continuity.

## 9. Core Algorithms

### 9.1 Current-state compiler

Inputs:

- latest authoritative episode and state;
- accepted decisions;
- changed artifact state;
- verifier/check status;
- unresolved and blocked work;
- evidence-backed facts.

Output:

- one canonical `CurrentExecutionStateV2`;
- one bounded Agent-facing current-state section;
- no historical skill text.

The compiler must prioritize semantic execution state, not raw recency or text
volume. It must preserve contradictions and unresolved items rather than
summarizing them away.

### 9.2 Contrastive experience induction

The compiler operates on cohorts, not isolated success events.

Required stages:

1. construct semantically and structurally related episode cohorts;
2. deterministically extract only observable facts: ordered actions/results,
   state deltas, reversions, verifier relations, progress boundaries, and
   repeated non-progress;
3. ask the real compiler LLM to hypothesize decisive observations, redundant
   actions, causal relevance, and minimal successful differences, retaining
   uncertainty and evidence references;
4. separate instance-specific values from parameterizable operations;
5. generate applicability, non-applicability, procedure, verification, and
   recovery candidates with a real LLM;
6. reject candidates unsupported by episode evidence;
7. minimize redundant steps and text;
8. persist an inert L2 candidate or abstain;
9. validate on held-out real tasks before active delivery.

The compiler must read real action request/result artifacts and state deltas.
Tool names plus changed paths are insufficient.

### 9.3 Candidate retrieval and compatibility

Candidate generation may use:

- semantic embeddings;
- lexical and structured recall;
- graph relations;
- environment/tool capability matching;
- optional ANN;
- prior successful transfer;
- recent and repository-local evidence.

Before value selection, hard compatibility removes skills with:

- unmet preconditions;
- unavailable tools or capabilities;
- incompatible environment or version;
- known counterexample match;
- deprecated status;
- unresolved evidence contamination.

Exact task identity may boost same-task continuity but cannot be required for
cross-task transfer.

### 9.4 Utility selector

The selector compares at least:

- state only;
- state plus one validated skill.

It may consider multiple skills only after single-skill credit is reliable.

The selection objective is:

```text
LCB(expected verified-pass uplift)
- token_cost_weight * rendered_tokens
- latency_cost_weight * expected_latency
- negative_transfer_weight * negative_transfer_risk
- staleness/version risk
```

Rules:

- current state is compiled independently from the learned-skill decision;
- if the lower-confidence utility is not positive, select no learned skill;
- uncertainty produces abstention or controlled exploration, never confident
  global promotion;
- selection features describe task, state, environment, tool capability,
  skill evidence, transfer history, and cost;
- similarity alone cannot authorize use;
- every active selection records assignment probability and rendered content.

The first implementation is fixed as
`cluster_bootstrap_logistic_uplift_v1`; implementation choice is not left open:

- estimand: conditional intent-to-treat difference in verified-pass
  probability between state-plus-one-skill and state-only;
- training source: only complete `DevelopmentAssignmentReceiptV1` rows from the
  frozen cluster-randomized development panel; cloned paired-validation and
  benchmark rows are excluded from L4 fitting. Both arms use the persisted
  focal-skill features chosen before treatment assignment, so state-only rows
  remain identifiable controls for that skill;
- fit: one L2-regularized logistic outcome model containing bounded context
  features, treatment, skill features, and treatment × feature interactions;
- propensity: use the durable known arm probability for treatment weighting
  and the focal-candidate probability for the declared eligible-skill
  population; persist their product as joint probability and reject rows with
  missing/invalid focal or arm propensity;
- encoding: numeric features are standardized from the development split;
  missing numeric values use zero plus a missingness indicator; bounded enums
  use schema-declared one-hot values; arbitrary text is not a selector feature;
- regularization: choose lambda from a predeclared finite grid by
  task-cluster cross-validation inside the development split, then freeze it;
- uncertainty: refit on 1,000 deterministic task-cluster bootstrap samples and
  use the fifth percentile of predicted uplift as the LCB;
- calibration report: Brier score, calibration slope/intercept, observed versus
  predicted uplift by predeclared bucket, and effective sample size;
- support: require at least 12 independent clusters per arm and effective
  sample size of at least ten times the fitted free-parameter count; otherwise
  no L4 is promoted and selection remains fixed-policy/state-only;
- harm: estimate conditional incremental failure risk
  `max(0, P(fail|treatment,x) - P(fail|control,x))` with the same randomized
  design and cluster bootstrap; paired `C fails/B passes` labels are reserved
  for validation/evaluation reports and are not treated as ordinary episode
  labels;
- cold start: treatment coefficients are centered at zero by regularization;
  if the fitted support or bootstrap interval is insufficient, utility is
  nonpositive and the selector abstains;
- update cadence: train only at locked development-batch boundaries and emit a
  new immutable L4 artifact; never mutate policy after each task;
- token, latency, and harm weights are predeclared L5 policy values tuned only
  on the development split, never hand-adjusted after viewing holdout results.

Deep reinforcement learning, neural policy learning, and model-weight training
are explicitly deferred until this inspectable baseline produces positive real
effects.

### 9.5 Budgeted context compiler

The canonical AgentContext has four semantic sections:

1. `current_state` — always available;
2. `use_now` — zero or a very small number of validated ExecutionSkills;
3. `inspect` — relevant but uncertain evidence or procedures;
4. `do_not_use` — explicit stale, contradicted, or incompatible experience.

Budget rules:

- reserve the majority of context for the current task, current observations,
  and tool results;
- do not use a fixed 50,000-character default;
- render a skill header, applicability, decisive checks, and immediate steps
  first;
- load extended evidence, branches, and provenance progressively;
- default to one primary skill;
- do not duplicate the same content in text and structured payloads;
- record rendered section counts with
  `exact_tokenizer|host_receipt|estimated|unavailable` authority; never label an
  estimate exact;
- use provider totals for end-to-end prompt-cost gates and section tokenizer
  measurements only as diagnostics when an exact compatible tokenizer exists.

### 9.6 Consolidation and forgetting

Lifecycle updates are based on real value and scope:

- merge semantically equivalent skills with compatible boundaries;
- revise by creating a version, never silently overwrite;
- split when evidence shows distinct applicability regions;
- narrow applicability after counterexamples;
- deprecate repeated low-value, stale, superseded, or harmful skills;
- preserve tombstone and provenance;
- invalidate summaries, embeddings, caches, and derived workflows when their
  source evidence is withdrawn;
- rehydrate when a new task provides strong compatibility evidence.

L2-to-L3 promotion requires independent held-out transfer evidence. L4 and L5
learn only from complete real intervention outcomes. Counts alone are
insufficient.

## 10. Canonical Product Interfaces

### 10.1 SDK `AionisAgentSession`

The SDK must expose one primary high-level loop while preserving lower-level
operations for advanced integrations.

```ts
const session = await aionis.agentSession.begin({
  sessionKey,
  scope,
  goal,
  continuationId,
  subject: {
    kind: "workspace",
    handle: workspaceRoot,
  },
  environment,
  model,
  tools,
});

const turn = await session.turn({
  observation,
  evidence,
  tokenBudget,
});
const context = turn.context;

const action = await turn.aroundAction({
  request,
  execute: () => realToolCall(),
});

await turn.recordDecision({
  decision,
  reasons,
  evidence,
});

await turn.recordProgress({
  itemId,
  state: "completed",
  statement,
  evidence,
});

await turn.recordPlannedAction({
  actionId,
  intent,
  justification,
  preconditions,
  evidence,
});

await turn.recordMemoryUse({
  interventionId: context.interventionId,
  artifactKind,
  artifactId,
  artifactVersion,
  sectionIds,
  stepIds,
  actionEventRefs: [action.eventId],
  evidence,
});

const outcome = await session.finish({
  verifier,
  cost,
});
```

Required behavior:

- `begin` resumes an authoritative open episode when identity matches, otherwise
  begins a new episode;
- `begin` resolves a versioned `SubjectStateAdapter` and stable
  `continuation_id`, and acquires a versioned session lease using the explicit
  `session_key`;
- `turn` is the mandatory high-level Agent-turn wrapper: it records the
  observation and returns canonical current state before any learned skill or
  tool action. This is the executable meaning of “current state on every turn”;
  low-level integrations receive no such guarantee unless they call `guide`
  explicitly for every turn;
- integrated hosts use a session helper that captures before/after state around
  the real tool action; lower-level hosts may submit adapter-produced immutable
  state references with adapter identity/attestation, not arbitrary unbound
  state text;
- `guide` always returns current state and may return validated skills;
- delivered content is automatically recorded as an intervention;
- observation, `recordDecision`, `recordProgress`, and
  `recordPlannedAction` create semantic events with authority/evidence;
- `recordMemoryUse` creates the only supported actual-use receipt; unverifiable
  use remains unknown and is never guessed from text or outcome;
- `aroundAction` stores request/result artifacts and Runtime-captured state
  transition; low-level `recordAction` accepts registered adapter references;
- `finish` captures/materializes the final state, reuses the current trusted
  verifier/close path, binds the result, and closes the feedback loop;
- all calls support durable operation identities;
- the SDK does not reimplement Runtime ranking, prompt policy, or task recipes.

### 10.2 MCP mapping

MCP exposes the same session semantics as thin tools:

- `aionis_session_begin_or_resume`;
- `aionis_context`;
- `aionis_record_observation`;
- `aionis_record_action`;
- `aionis_record_decision`;
- `aionis_record_progress`;
- `aionis_record_planned_action`;
- `aionis_record_memory_use`;
- `aionis_session_finish`.

Existing observe/guide/feedback tools may remain as lower-level compatibility
surfaces during implementation, but there is one feedback contract.

MCP requirements:

- trace-only feedback cannot be accepted if Runtime requires a source guide or
  intervention identity;
- Agent-facing `content` contains only the compact rendered context;
- audit, receipt, and provenance data remain in `structuredContent`;
- the same payload is not duplicated into both channels.

### 10.3 AIFS projection

AIFS is an optional file representation of the canonical state, not a separate
memory implementation.

Target projection:

```text
.aionis/
  current.md
  use-now.md
  inspect.md
  do-not-use.md
  session.json
```

Requirements:

- read generated Runtime configuration;
- refresh after guide, observe/action, feedback, and finish;
- deduplicate repeated content;
- preserve stable file names while content revisions carry digests;
- never independently select or promote memories.

### 10.4 Substrate boundary

Substrate must make one explicit choice:

1. implement a Runtime storage/candidate adapter contract; or
2. remain a separately versioned event/evidence library.

It must not remain an ambiguous second memory authority.

If used as a candidate backend:

- Runtime supplies the query and compatibility constraints;
- Substrate returns candidates and evidence pointers;
- Runtime rechecks scope, lifecycle, version, and applicability;
- Runtime owns final selection and outcome update.

### 10.5 Manifest boundary

Manifest owns deterministic representation and invocation of validated
procedures.

Manifest must support:

- parameters and typed inputs;
- preconditions;
- ordered steps and dependencies;
- expected state transitions;
- termination and verifier references;
- failure/recovery branches;
- evidence/provenance references;
- schema version and content digest.

Runtime owns whether a Manifest-backed skill is applicable and valuable.
Manifest owns whether the selected procedure is structurally executable.

### 10.6 CLI and Create

The product installer must:

- install one declared compatible version set;
- configure Runtime, SDK coordinates, and optional MCP/AIFS/Substrate adapters;
- start or print one canonical local Runtime command;
- run one real local session against the installed Runtime when the user
  explicitly requests verification;
- stop printing a collection of unrelated manual integration instructions as
  the primary onboarding result.

Installer work is not on the learning critical path and begins only after the
canonical session contract stabilizes.

## 11. Implementation Phases

Each phase has a product output and an effect gate. Tasks within a phase may be
implemented in small commits or local batches, but their dependencies must not
be reordered without updating this plan.

### Phase 0 — Preserve the real product baseline

**Objective:** establish the exact current behavior and protect valuable owner
work before changing delivery or learning.

**Time box:** at most one focused working day. Phase 0 creates no new Runtime
mechanism, GitHub/CI process, release artifact, or governance layer.

#### Task 0.1 — Inventory current owner work

- **Files:** all 90 current working-tree entries, with special attention to:
  - `src/memory/agent-context-compiler.ts`
  - `src/memory/agent-context-renderer.ts`
  - `src/memory/execution-episode.ts`
  - `src/memory/execution-episode-memory-compiler.ts`
  - `src/product/execution-episode-service.ts`
  - `src/product/guide-service.ts`
  - `src/store/lite-execution-episode-store.ts`
  - `src/sdk.ts`
- **Work:**
  1. classify every changed/untracked file as continuity, episode truth,
     verifier, compiler, delivery, legacy learning, or unrelated;
  2. identify contract collisions and duplicate ownership;
  3. record which current behaviors must survive Phase 1;
  4. do not modify or clean files as part of the inventory.
- **Output:** `docs/research/2026-07-28-execution-memory-current-state-inventory.md`.
- **Acceptance:** every owner file is accounted for and the inventory can trace
  each preserved behavior to a real source path.

#### Task 0.2 — Freeze the current real-effect comparison

- **Inputs:**
  - existing Vite continuation evidence;
  - existing Playwright three-arm evidence;
  - historical continuity/context-compression evidence.
- **Work:**
  1. record exact model, task state, Runtime version, prompt/token accounting,
     verifier, and artifact paths;
  2. separate proven continuity effects from unproven correctness-learning
     effects;
  3. do not rerun a task merely to obtain a green number.
- **Output:** one baseline index referencing immutable raw run artifacts.
- **Acceptance:** the next phases can compare behavior without reinterpreting
  old claims.

#### Task 0.3 — Establish semantic contract fixtures from real data

- **Work:**
  1. select real successful, failed, interrupted, resumed, and contaminated
     episodes already on disk;
  2. record their expected semantic facts, not expected solution strings;
  3. use them as real-data contract cases for episode/state/skill migration;
  4. do not fabricate missing episodes.
- **Output:** a versioned manifest of real artifact paths and digests.
- **Acceptance:** Phase 1 and Phase 2 can be checked against real execution
  records without mock outcomes.

**Phase 0 exit gate**

- current product behavior and evidence are traceable;
- no owner work was lost or overwritten;
- no single-task solution was converted into a product rule;
- the plan baseline distinguishes continuity, compression, learning, and final
  task correctness.

### Phase 1 — Restore the always-on Execution Memory contract

**Objective:** guarantee that every Agent turn receives one compact,
authoritative current state, while preventing weak historical artifacts from
polluting execution.

#### Task 1.0 — Add authoritative semantic execution events

- **Runtime files:**
  - `src/memory/execution-episode.ts`
  - `src/product/execution-episode-service.ts`
  - `src/store/lite-execution-episode-store.ts`
  - `src/store/lite-execution-episode-schema.ts`
  - `src/execution/state-store.ts`
  - new `src/product/execution-turn-transaction-service.ts`
  - new `src/memory/execution-cost-receipt.ts`
  - additive SQL migration under `src/store/sql/`
  - episode transport/routes used by the SDK
- **SDK files:**
  - `src/sdk.ts`
  - `/Volumes/ziel/new.aionis/aionis-sdk/src/index.ts`
- **Work:**
  1. add immutable `SemanticObservationEventV1`,
     `AgentDecisionEventV1`, `ProgressStateEventV1`, and
     `PlannedActionEventV1`;
  2. expose `recordObservation`, `recordDecision`, `recordProgress`, and
     `recordPlannedAction`;
  3. bind authority, uncertainty, and evidence to every semantic statement;
  4. make model-derived semantics explicitly distinguishable from host-declared
     and Runtime-derived facts;
  5. create immutable `ExecutionCostReceiptV1` from provider usage or signed
     host usage, preserving null/unavailable values rather than estimating
     silently;
  6. route active-session event writes through one transactional turn
     coordinator that also advances the current-state CAS head and durable
     projector cursor;
  7. make replay produce the same ordered semantic event/cost stream and
     idempotently repair only committed, unapplied imported events.
- **Output:** the facts needed by current-state reconstruction exist in the
  authoritative episode ledger instead of a host-supplied summary object.
- **Real verification:** record and replay one real successful, one real failed,
  and one real interrupted episode through the actual Runtime and SDK.
- **Done when:** completed, failed, unresolved, blocked, decisions, reasons, and
  observations can all be traced to immutable events and raw evidence, and each
  closed episode has one authoritative cost receipt.

#### Task 1.1 — Version `CurrentExecutionStateV2`

- **Runtime files:**
  - `src/execution/workspace-state-capture.ts`
  - `src/execution/types.ts`
  - `src/execution/state-store.ts`
  - additive state-store migration under `src/store/sql/` if the existing V1
    row cannot carry V2 identity/revision fields
  - `src/memory/host-current-execution-state.ts`
  - `src/memory/agent-context-compiler.ts`
  - `src/memory/agent-context-renderer.ts`
  - `src/product/guide-service.ts`
  - `src/memory/product-output/guide-packet.ts`
  - `src/memory/product-output/memory-packet.ts`
- **SDK files:**
  - `src/sdk.ts`
  - `/Volumes/ziel/new.aionis/aionis-sdk/src/index.ts`
- **Work:**
  1. preserve the existing Runtime-owned workspace capture and verifier path;
  2. define one versioned workspace-backed current-state schema;
  3. project continuity, handoff, snapshot/delta, semantic event, evidence,
     unresolved, blocked, and next-action data into it;
  4. establish precedence for current versus stale state;
  5. require provenance or explicit uncertainty for every claim;
  6. use `continuation_id`, `task_run_id`, episode lineage, monotonic revision,
     parent-state digest, and compare-and-swap;
  7. reuse/migrate the existing CAS state store as the sole current-state head;
     do not create a parallel state table;
  8. compute `state_sha256` from the canonical material defined in Section 8.2,
     excluding `updated_at` and the digest field itself;
  9. define the independent `CurrentStateRenderPolicyV1`;
  10. record token count with explicit measurement authority;
  11. commit the event batch, snapshot/delta references, operation receipt,
      state-head CAS, and projector cursor atomically; reject rather than
      partially commit on lease or parent-head conflict.
- **Output:** canonical structured state plus bounded renderer.
- **Real verification:** resume real interrupted episodes across a fresh Runtime
  process and a second Agent/model session.
- **Done when:** the resumed Agent can name current state, completed work,
  unresolved work, evidence, and next justified action without receiving the
  full transcript, and replay/CAS yields the same V2 state digest after restart.

#### Task 1.2 — Classify shallow episode memories without deleting behavior

- **Files:**
  - `src/memory/execution-episode-memory-compiler.ts`
  - `src/jobs/execution-episode-memory-compiler-worker.ts`
  - `src/product/execution-episode-service.ts`
  - `src/store/lite-execution-episode-store.ts`
  - `src/memory/agent-context-compiler.ts`
- **Work:**
  1. preserve verified episode facts in the episode/evidence ledger;
  2. label shallow “verified solution with N actions” artifacts as
     `legacy_shallow_episode_hint`, never as L2/L3;
  3. make the new canonical experimental path treat them as cold `inspect`
     evidence, while retaining the old path as a frozen comparison arm until a
     validated L3 replacement passes;
  4. record their exact prompt contribution and provenance;
  5. ensure continuity facts remain available through current state.
- **Output:** L1 remains durable evidence and cannot masquerade as an
  ExecutionSkill, without silently removing an existing product behavior.
- **Real verification:** compare the frozen legacy path and canonical cold-L1
  path on real tasks with prior episodes.
- **Done when:** no L1 is called a validated skill; switching the production
  default is deferred until at least Gate 1 evidence supports it.

#### Task 1.3 — Unify AgentContext compilation

- **Files:**
  - `src/memory/agent-context-compiler.ts`
  - `src/memory/agent-context-renderer.ts`
  - `src/product/guide-service.ts`
  - `src/sdk.ts`
  - `/Volumes/ziel/new.aionis/aionis-sdk/src/index.ts`
- **Work:**
  1. make Runtime contracts the only semantic compiler;
  2. make SDK render or transport the canonical contract rather than rebuilding
     selection and policy;
  3. separate `current_state` from learned `use_now`;
  4. remove duplicate empty headings and duplicate evidence;
  5. replace fixed huge default budgets with a caller budget and safe bounded
     default;
  6. render current state first under `CurrentStateRenderPolicyV1`; learned
     policy can spend only the remaining budget;
  7. record rendered sections and token authority.
- **Output:** one structured context and one rendering path.
- **Real verification:** the same real guide request through the Runtime
  transport and direct SDK produces semantically identical context and section
  digests. MCP parity is Phase 5 work and does not block continuity proof.
- **Done when:** there is no second SDK decision brain and no duplicated prompt
  payload.

#### Task 1.4 — Inventory and freeze task-derived rules

- **Files:**
  - `src/memory/trajectory-compile.ts`
  - `src/memory/tool-registry.ts`
  - `src/memory/adaptive-guidance.ts`
  - `src/app/planning-summary-planner.ts`
  - `src/routes/memory-context-runtime.ts`
  - `src/memory/product-output/learning-effect.ts`
- **Work:**
  1. identify every repository-, language-, command-, benchmark-, or
     task-family-specific rule;
  2. forbid adding any new task-derived rule;
  3. record which current product decision each legacy rule affects and its
     real caller/effect evidence;
  4. instrument the generic replacement and frozen legacy decision in shadow
     comparison without changing the production default;
  5. schedule actual switch/removal only under Phase 7 replacement gates.
- **Output:** a complete legacy-rule inventory and frozen comparison path.
- **Real verification:** replay at least three unrelated real task families and
  show which decisions came from generic evidence versus a legacy rule.
- **Done when:** no new recipe can enter Core and no old capability has been
  disabled before its replacement is proved.

#### Task 1.5 — Implement the canonical SDK session shell

- **Files:**
  - `src/sdk.ts`
  - `/Volumes/ziel/new.aionis/aionis-sdk/src/index.ts`
  - `src/product/execution-episode-service.ts`
  - `src/product/guide-service.ts`
  - `src/product/lifecycle-service.ts`
  - new `src/product/execution-turn-transaction-service.ts`
  - `src/execution/state-store.ts`
  - new `src/store/lite-execution-session-lease-store.ts`
  - `src/store/lite-execution-episode-schema.ts`
  - additive lease/handoff SQL migration under `src/store/sql/`
  - Runtime service composition and existing episode transport/routes
- **Work:**
  1. add `AionisAgentSession`;
  2. add explicit `session_key`, continuation identity, lease, renewal,
     compare-and-swap, and conflict behavior;
  3. persist lease acquire/lookup/renew/expire/takeover and explicit handoff
     receipts keyed by `session_key`;
  4. expose lease operations through the existing Runtime transport and SDK,
     with durable operation IDs;
  5. compose begin/resume, mandatory high-level `turn`, guide, observation,
     action, mutation, decision, progress, planned action, verifier, finish,
     memory-use, and feedback operations;
  6. use Runtime capture around local workspace actions; accept only registered
     adapter snapshot references for trusted external subjects;
  7. make `finish` reuse the existing `runVerifier`/close path and bind the
     authoritative final snapshot rather than accepting arbitrary final state;
  8. automatically preserve episode and intervention identity;
  9. commit lease acquire with begin/resume, and commit final snapshot,
     verifier result, episode close, and lease release/handoff as atomic
     Runtime transactions;
  10. keep low-level operations and avoid host-specific solution logic.
- **Output:** one real host integration path.
- **Real verification:** complete and resume a real task exclusively through
  this API; exercise active-lease conflict, renewal, explicit handoff, expired
  takeover, and idempotent retry with real Runtime processes.
- **Done when:** a host does not manually stitch together unrelated IDs and
  receipts to close the loop, and two Agents cannot silently resume the same
  task execution. Injected process termination at every transaction boundary
  leaves neither an orphan lease nor an accepted event/state-head divergence.

**Phase 1A immediate continuity gate — run after Task 1.5**

- real interruption/resume succeeds across process and model boundaries;
- current-state completeness is at least equal to the existing continuity
  baseline;
- prompt tokens are below full history on the same tasks;
- canonical cold-L1 mode does not lose correctness against the frozen legacy
  comparison on the directional panel;
- no correctness claim is made yet.

If this gate is negative, fix current-state semantics before building a skill
selector. Do not hide the result behind Phase 2 infrastructure.

#### Task 1.6A — Freeze subject-V2 contracts and migrate workspace first

- **Runtime files:**
  - new `src/execution/subject-state-adapter.ts`
  - new `src/execution/subject-state-adapter-registry.ts`
  - `src/memory/execution-episode.ts`
  - `src/product/execution-episode-service.ts`
  - `src/execution/verifier-subject-materialization.ts`
  - verifier runner/registry
  - artifact media-type contracts
  - execution episode store/replay
  - Runtime transport and SDK contracts
- **Work:**
  1. implement `ExecutionSubjectV1`, `StateSnapshotV2`, and `StateDeltaV1`;
  2. migrate workspace capture without changing its verifier outcome;
  3. add registered adapter lifecycle, identity, capabilities, capture, delta,
     final-state materialization, and signed-host receipt rules;
  4. migrate replay and artifact references without creating a second state
     authority.
- **Output:** frozen generic subject/event/state/transport contracts with the
  existing workspace path as the first implementation.
- **Real verification:** run capture → action → delta → interrupt → resume →
  verifier on real workspace tasks and reproduce the pre-migration outcome.
- **Done when:** workspace continuity, episode replay, transport, SDK, and
  verifier use V2 contracts. This task is a hard dependency of Phase 2 cohort,
  storage projection, and validation-ledger work.

#### Task 1.6B — In parallel with Phase 2, implement two real adapters

- **Runtime files:**
  - new generic structured-artifact adapter module
  - new generic SQLite-database adapter module
  - adapter registry and verifier materialization hooks
- **Eval files:**
  - real structured-artifact task assets, host adapter, and executable verifier
    under `/Volumes/ziel/new.aionis/AionisRuntime-evals`
  - real SQLite task assets, host adapter, and executable verifier under
    `/Volumes/ziel/new.aionis/AionisRuntime-evals`
- **Work:**
  1. implement capture, delta, capability export, final-state materialization,
     interruption, resume, and verifier binding for both adapters;
  2. keep adapter knowledge limited to state representation and capabilities,
     never task solutions;
  3. isolate task assets/answers/verifiers in Evals and record contamination
     checks.
- **Output:** workspace, structured-artifact, and SQLite implementations of the
  same frozen subject contract.
- **Real verification:** run capture → action → delta → interrupt → resume →
  verifier on real tasks for all three adapters.
- **Done when:** adapter choice changes state materialization only; continuity,
  episode truth, and verifier binding retain the same semantic contract.

**Phase 1B cross-domain readiness gate — required before Gate 1**

- Phase 1A continuity remains passed after subject migration;
- all three adapters pass real resume and verifier binding;
- cross-domain claims remain limited to these implemented adapters;
- no adapter contains task-name, repository, answer, or solution rules.

### Phase 2 — Build the real ExecutionSkill compiler

**Objective:** convert verified episode cohorts into evidence-backed,
parameterized L2 candidates or abstain.

#### Task 2.0 — Acquire and seal real episode cohort packs

- **Files:**
  - new cohort-pack schema/manifest support in
    `/Volumes/ziel/new.aionis/AionisRuntime-evals`
  - existing real Agent runners and task assets
  - Runtime episode export/import adapter using `RealEpisodeCohortPackV1`
- **Work:**
  1. run real LLMs and tools to acquire verifier-backed successes, related
     failures, counterexamples, held-out targets, and negative neighbors;
  2. seal training/development/heldout/negative-neighbor splits before
     compilation;
  3. record resolvable content-addressed references and digests for episode,
     verifier, cost, model/tool/environment, adapter, schema, prompt/policy,
     and provenance dependencies;
  4. export content-addressed packs without embedding task answers in Runtime;
  5. reject packs with missing artifacts, changed digests, split overlap, or
     unbound verifier outcomes.
- **Output:** at least three real mechanism packs usable by Task 2.4 and Gate 0.
- **Real verification:** import each pack into an isolated real Runtime,
  reconstruct the episode/outcome/cost projections, and reproduce its manifest
  digest.
- **Done when:** Phase 2 has actual success/failure/heldout data before compiler
  implementation is called complete. Acquisition may start during Phase 1, but
  Task 2.4 cannot finish without sealed packs.

#### Task 2.1 — Establish Runtime-owned canonical learning contracts

- **Runtime files:**
  - new `src/memory/execution-skill.ts`
  - `src/memory/schemas.ts`
  - `src/memory/layer-policy.ts`
  - new versioned JSON Schema output under `contracts/`
  - new deterministic schema generation/check script under `scripts/`
- **Work:**
  1. implement Sections 8.4 through 8.8 as the canonical Runtime source;
  2. generate content-addressed JSON Schema artifacts from that source;
  3. enforce evidence, boundaries, verification, lifecycle, and versioning;
  4. structurally require reusable procedure values to be parameters and keep
     instance literals only in evidence or binding receipts;
  5. add content-addressed identity;
  6. keep benchmark-answer/leak detection in Evals, not a Core regex.
- **Output:** one Runtime-owned semantic contract and generated portable schema.
- **Verification:** validate real compiled candidates and deliberately invalid
  candidates produced from real episode artifacts; no mock outcome is used.
- **Done when:** one canonical source produces deterministic schemas and there
  is no hand-copied Manifest/SDK learning schema on the critical path.

#### Task 2.2 — Implement bounded predicates, capabilities, and bindings

- **Files:**
  - new `src/memory/execution-predicate.ts`
  - new `src/memory/execution-capability.ts`
  - new `src/memory/execution-skill-binding.ts`
  - new `src/execution/host-capability-registry.ts`
  - Runtime service composition and capability invocation path
  - subject-adapter feature/capability exports
  - `src/memory/execution-skill.ts`
- **Work:**
  1. implement the bounded algebra in Section 8.6;
  2. validate fields against the active adapter/feature schema;
  3. add depth, node-count, value-size, and enum-cardinality limits;
  4. resolve task/state/environment/agent parameters into immutable binding
     receipts;
  5. register versioned host callbacks or Manifest modules and emit capability
     invocation receipts for real actions;
  6. validate binding expressions against capability input schemas;
  7. make unresolved required bindings inapplicable or inspect-only;
  8. forbid arbitrary code, regex, repository/test names, and task switches.
- **Output:** generic executable preconditions and reproducible bindings.
- **Real verification:** before Gate 0, bind and invoke a parameterized
  procedure on real workspace tasks, including a real non-applicable case.
  Phase 1B repeats the same contract on structured-artifact and database
  subjects before Gate 1.
- **Done when:** a new subject instance can bind or reject a procedure without a
  Core source edit or guessed value.

#### Task 2.3 — Add authoritative skill persistence

- **Files:**
  - new `src/store/lite-execution-skill-store.ts`
  - new additive SQL migration under `src/store/sql/`
  - `src/store/lite-runtime-schema.ts`
  - `src/store/lite-runtime-database.ts`
  - `src/store/memory-store.ts`
  - existing outbox contract plus new skill-index projection handler/worker
  - `src/store/lite-recall-store.ts`
- **Work:**
  1. persist immutable versions, status, provenance, boundaries, and utility;
  2. emit an outbox event for each immutable skill version/lifecycle receipt;
  3. project only skill references, searchable fields, projection identity, and
     lifecycle/version into recall/ANN candidate indexes;
  4. preserve source/contrast episode relationships;
  5. invalidate/re-embed index projections on version, tombstone, lifecycle, or
     embedding-projection changes;
  6. make projection replay idempotent and rebuildable from the skill store;
  7. do not copy skill truth into ANN or Substrate authority.
- **Output:** crash-recoverable skill store.
- **Verification:** generate candidates from real episodes, restart Runtime
  abruptly, and verify exact content/provenance recovery.
- **Done when:** a skill version and its evidence graph survive restart without
  becoming active by accident, and a destroyed candidate index can be rebuilt
  without changing skill authority.

#### Task 2.4 — Build reproducible experience cohorts

- **Files:**
  - new `src/memory/experience-cohort.ts`
  - new `src/store/lite-experience-cohort-store.ts`
  - `src/execution/task-cluster.ts`
  - `src/store/lite-execution-episode-store.ts`
  - `src/config.ts`
  - `src/embeddings/index.ts`
  - `src/app/recall-text-embed.ts`
  - embedding write/recall validation and vector persistence paths
  - additive projection/backfill migration and reprojection worker
- **Work:**
  1. retain exact signatures for identity;
  2. implement `EmbeddingProjectionRefV1` and remove the forced Core dimension;
  3. allow multiple provider/model/dimension projections to coexist without
     cross-comparison;
  4. backfill existing vectors under their explicit legacy projection and
     invalidate affected candidate/cohort caches on reprojection;
  5. derive semantic task/problem features under an explicit projection;
  6. derive only versioned, bounded structural state, action, environment, and
     capability features;
  7. construct source success/failure/counterexample cohorts before any
     intervention data exists;
  8. reject contaminated and infrastructure-failed episodes;
  9. persist an immutable cohort-construction receipt, complete membership and
     exclusion rows, projection identities, dependency references, and cache
     invalidation reasons in the mandatory durable cohort authority;
  10. keep large content-addressed artifacts in the evidence store while
      `lite-experience-cohort-store.ts` remains the authoritative replay index;
      an in-memory-only cohort is invalid.
- **Output:** reproducible `ExperienceCohortV1`.
- **Real verification:** construct cohorts spanning multiple repositories or
  environments without fixed task-family labels.
- **Done when:** related episodes can group across surface wording and paths,
  semantically different episodes remain separated, and changing embedding
  projection cannot silently reuse a stale cohort.

#### Task 2.5 — Extract factual transition evidence

- **Files:**
  - new `src/memory/execution-transition-evidence.ts`
  - `src/memory/execution-episode-memory-compiler.ts`
  - `src/store/lite-evidence-artifact-store.ts`
- **Work:**
  1. load real action request/result artifacts;
  2. compute state deltas and observation-to-decision links;
  3. deterministically mark only observed success/failure, progress,
     non-progress, reversion, and verifier relations;
  4. identify common and contrasting factual transitions across the cohort;
  5. expose evidence spans and artifact digests to the LLM compiler;
  6. represent “decisive”, “redundant”, and causal relevance only as
     model-generated hypotheses with evidence and uncertainty.
- **Output:** evidence packet with no generated solution claims.
- **Real verification:** inspect packets for real successful and failed
  executions and trace every extracted transition back to artifacts.
- **Done when:** compiler input proves what changed and cleanly separates
  observed facts from hypotheses about why it mattered.

#### Task 2.6 — Implement provider-agnostic semantic compilation

- **Files:**
  - new `src/memory/execution-skill-compiler.ts`
  - new `src/memory/execution-skill-model-provider.ts`
  - the existing generic model-provider/client boundary, refactored in place
    where necessary; do not add a third independent client stack
  - `src/jobs/execution-episode-memory-compiler-worker.ts`
- **Work:**
  1. send bounded cohort evidence to a real LLM;
  2. request structured applicability, diagnosis, parameterized procedure,
     termination, verification, recovery, and boundaries;
  3. require evidence references for claims;
  4. support explicit abstention;
  5. validate and minimize returned structure;
  6. persist candidate only, never active authority;
  7. persist provider adapter/version, model configuration digest, sampling
     parameters, request digest, and raw response artifact;
  8. keep provider configuration outside the semantic contract.
- **Output:** candidate or abstention receipt.
- **Real verification:** use the configured real LLM on real cohorts from at
  least three unrelated task families.
- **Done when:** candidates contain procedural hypotheses supported by episode
  evidence and no repository-specific rule was added to Runtime.

#### Task 2.7 — Add the minimal immutable validation ledger

- **Files:**
  - `src/memory/execution-episode.ts`
  - `src/store/lite-execution-episode-store.ts`
  - `src/store/lite-execution-episode-schema.ts`
  - additive SQL migration under `src/store/sql/`
  - `src/product/guide-service.ts`
  - `src/product/execution-episode-service.ts`
  - new `src/memory/paired-hypothesis-validation-policy.ts`
- **Work:**
  1. implement immutable intervention-offered, actual-use, outcome-link, and
     derived-view contracts from Sections 8.9 and 8.10;
  2. extend/map existing decision, exposure, feedback, verifier, reward, and
     cost receipts rather than creating a second authority;
  3. implement `PairedHypothesisValidationPolicyV1`: clone each held-out base
     task into both arms, randomize only execution order, and bind the exact L2
     version/content digest;
  4. make state-only an explicit offered intervention;
  5. authorize L2 rendering only within the named paired-validation block;
  6. record rendered content, candidate features, order receipt, token
     authority, the Task 1.0 `ExecutionCostReceiptV1`, verifier result, and cost;
  7. do not attach propensity/IPW semantics to cloned paired blocks;
  8. replay historical real infrastructure outcomes if available; otherwise
     verify the schema path without fabricating or waiting for an outage.
- **Output:** enough immutable evidence to run controlled L2 validation before
  a learned selector exists.
- **Real verification:** replay real state-only and hypothesis-exposed episodes
  and reproduce the same offered/use/outcome view after Runtime restart.
- **Done when:** the system can answer what was offered, what was explicitly
  used, what happened, and what it cost without mutating an earlier receipt.

#### Task 2.8 — Validate hypotheses and create L3 only through promotion

- **Files:**
  - new `src/memory/execution-skill-validation.ts`
  - new `src/memory/execution-skill-promotion-service.ts`
  - Runtime service composition, skill-store dependency, existing outbox, and
    promotion worker/handler
  - Runtime eval host adapters in `/Volumes/ziel/new.aionis/AionisRuntime-evals`
- **Work:**
  1. reserve held-out episodes/tasks not shown to the compiler;
  2. execute state-only and state-plus-L2 under the frozen
     `PairedHypothesisValidationPolicyV1` from identical cloned snapshots;
  3. bind both outcomes to real final-state verifiers;
  4. create a replayable `SkillValidationReceiptV1`;
  5. freeze the validation family, paired base-task/reserve manifest, semantic
     signatures, analysis code, severe-regression codes, and protocol digest
     before any family outcome is opened;
  6. implement `validation_protocol_v1` mechanically: equal weight across
     semantic signatures then paired base tasks; verified-pass paired risk
     difference; 50,000 deterministic signature-stratified paired bootstrap
     resamples seeded from the protocol digest; one-sided lower/upper bounds at
     `adjusted_alpha = 0.05 / frozen_family_size`;
  7. treat an arm-caused crash, timeout, invalid action, or budget exhaustion as
     that arm's failure; invalidate the whole pair only for independently
     verified infrastructure failure and replace it from the prelocked reserve;
     invalidate pre-exposure contamination, and mark the hypothesis contested
     on post-exposure answer/verifier contamination;
  8. keep one positive target as L2 `in_validation` only;
  9. under initial `validation_protocol_v1`, allow `L3 limited` only after at
     least three independent held-out targets across at least two semantic task
     signatures, both arms are observed, helpful exceeds harmful, and no
     predeclared severe regression occurs. This is scoped directional evidence,
     not a confirmatory effect claim;
  10. create `L3 validated` only after a predeclared power simulation selects
      the maximum of 24 valid pairs and the sample size needed for 80% power at
      the complete conjunction of a +8 percentage-point minimum relevant
      uplift and a harmful-transfer upper bound of 5%, under the
      multiplicity-adjusted alpha, predeclared paired discordance,
      harmful-transfer alternative, and infrastructure attrition; require at
      least three semantic signatures and eight valid pairs per signature, the
      multiplicity-adjusted uplift lower bound above zero, the adjusted
      harmful-transfer upper bound at most 5%, and zero predeclared severe
      regressions;
  11. do not perform interim efficacy looks or relabel a directional result as
      powered; failed support or incomplete pairs cannot be filled with
      synthetic/mock outcomes;
  12. map `limited` receipt to scoped L3 limited and `passed` receipt to L3
     validated;
  13. register `ExecutionSkillPromotionService` in Runtime composition and invoke
     it only after receipt commit through the existing durable outbox/worker;
     hosts receive no direct promotion endpoint;
  14. have the promotion worker recompute receipt/content digests and publish
      exactly the canonical L2 content named by the receipt;
  15. mark failed/ambiguous hypotheses rejected or contested and never convert a
     failed validation into a hardcoded fix.
- **Output:** replayable validation receipt plus limited/validated L3 or an
  inert rejected/contested L2.
- **Done when:** transfer is demonstrated beyond source instances, harmful
  hypotheses stay inactive, and no single successful task can create L3.

**Phase 2 effect gate**

- compiler reads full semantic execution evidence;
- every candidate has applicability, procedure, termination, verification,
  boundaries, and provenance;
- abstention is observed on unsupported cohorts;
- candidates remain inert until held-out real validation;
- at least three unrelated task families are represented;
- no task-specific Core rule is added;
- run Phase 6 Gate 0 immediately on the minimal
  L1→L2→paired-validation-rendering path before implementing a learned
  selector;
- independently require at least one scoped L3 limited receipt satisfying Task
  2.8 before Phase 3 begins. Gate 0 itself does not relax promotion thresholds
  or claim L3 production value.

If Gate 0 cannot render and execute a real L2 validation treatment, or Task 2.8
cannot produce at least one properly scoped limited L3, stop and repair
cohort/compilation/validation quality. Do not proceed to Phase 3 by adding more
infrastructure.

### Phase 3 — Complete intervention data and learn when to use memory

**Objective:** connect eligibility, selection, rendering, actual use, outcome,
and cost so Aionis can learn the incremental value of historical experience
over always-on current state.

#### Task 3.1 — Extend the validation ledger into the production ledger

- **Files:**
  - `src/memory/execution-episode.ts`
  - `src/store/lite-execution-episode-store.ts`
  - `src/store/lite-execution-episode-schema.ts`
  - additive SQL migration under `src/store/sql/`
  - `src/product/guide-service.ts`
  - `src/product/execution-episode-service.ts`
  - new `src/memory/development-assignment-policy.ts`
- **Work:**
  1. reuse the immutable receipt sequence introduced in Task 2.7;
  2. persist the complete bounded candidate feature snapshot, not only a digest;
  3. add the separate cluster-randomized
     `DevelopmentAssignmentPolicyV1`/receipt: first sample and persist one focal
     eligible L3 plus its features/probability, then draw the frozen 0.5/0.5
     render arm; state-only rows retain the focal skill counterfactual and joint
     probability even though their rendered `selected` list is empty;
  4. support paired-validation, development-assignment, and learned-policy
     interventions without mixing their estimands;
  5. bind assignment to episode/intervention/decision and atomically commit it
     with the offered receipt before rendering/Agent action; reject outcome
     links that predate or cannot resolve that assignment;
  6. link reward/cost projections and outcome-link receipts transactionally
     without mutating the offered receipt;
  7. keep infrastructure and contaminated results out of learning updates;
  8. expose one derived intervention view for replay and analysis;
  9. run the frozen randomized assignment on a predeclared development
     panel until the algorithm contract has adequate task-cluster support for
     fitting/cross-validation; never consume Gate 1 held-out tasks.
- **Output:** every learning decision is reconstructable.
- **Real verification:** record and replay at least nine real episodes across
  three tasks, including state-only, skill-exposed, unused-skill, pass, failure,
  and any historical real infrastructure case available. Do not manufacture an
  outage to satisfy this list.
- **Done when:** the store can answer exactly what the Agent saw, what it used,
  what happened, and what it cost, and the L4 training manifest contains no
  Alpha/Beta/Confirmatory task.

#### Task 3.2 — Add generic skill compatibility

- **Files:**
  - new `src/memory/execution-skill-retrieval.ts`
  - new `src/memory/execution-skill-compatibility.ts`
  - `src/store/lite-recall-store.ts`
  - `src/memory/recall-hybrid-merge.ts`
  - `src/product/guide-service.ts`
- **Work:**
  1. retrieve L2 only inside a controlled validation request; retrieve
     `validated` L3 for normal production and scope-compatible `limited` L3 only
     inside its declared controlled development policy;
  2. evaluate required state, parameter bindings, tools, capabilities,
     versions, and explicit
     non-applicability;
  3. expose feature values and rejection reasons;
  4. allow same-task and repository-local evidence without requiring it;
  5. keep ANN candidate-only and optional.
- **Output:** compatible candidate set with explainable exclusions.
- **Real verification:** use real positive-transfer and negative-neighbor tasks
  to demonstrate inclusion and rejection without adding task names to Core.
- **Done when:** surface similarity cannot bypass failed preconditions.

#### Task 3.3 — Implement the first utility selector

- **Files:**
  - new `src/kernel/execution-skill-selector.ts`
  - new `src/memory/execution-skill-features.ts`
  - new `src/store/lite-selector-policy-store.ts`
  - `src/product/guide-service.ts`
  - `src/memory/agent-context-compiler.ts`
- **Work:**
  1. define a versioned general feature schema;
  2. train exactly `cluster_bootstrap_logistic_uplift_v1` as specified in
     Section 9.4 from the fixed Task 3.1 cluster-randomized development ledger;
  3. use known propensity, task-cluster resampling, the frozen regularization
     grid, and development-only calibration;
  4. estimate verified-pass uplift, negative-transfer probability, and
     token/latency cost;
  5. compute conservative lower-bound utility;
  6. choose state-only or at most one scope-compatible limited/validated L3;
  7. persist the first immutable `ContextualValueModelV1` and bootstrap
     `ExecutionMemoryPolicyV1`;
  8. abstain when evidence/support is insufficient or lower-bound utility is
     nonpositive.
- **Output:** first reproducible L4/L5 selector, not another rules engine.
- **Real verification:** train/calibrate from real development episodes, then
  replay decisions against held-out real outcomes.
- **Done when:** the same state, candidates, and policy artifact reproduce the
  same choice, the full training manifest reproduces the model, and no fixed
  repository/task feature participates.

#### Task 3.4 — Add bounded exploration

- **Files:**
  - `src/kernel/execution-skill-selector.ts`
  - `src/store/lite-selector-policy-store.ts`
  - experiment profiles in `/Volumes/ziel/new.aionis/AionisRuntime-evals`
- **Work:**
  1. make assignment probability explicit;
  2. explore only among compatible, validated or deliberately limited
     candidates;
  3. retain state-only as an arm;
  4. cap exploration by uncertainty and known harm;
  5. pause/quarantine an individual skill according to a versioned harm policy,
     not a Core magic count;
  6. keep experiment schedules out of production Runtime constants.
- **Output:** learnable intervention data without uncontrolled memory use.
- **Real verification:** randomized real development cells with identical
  environment snapshots and external verifiers.
- **Done when:** propensity, outcome, harm, and cost are complete for every cell.

#### Task 3.5 — Connect authoritative rendered token cost

- **Files:**
  - `src/memory/agent-context-renderer.ts`
  - `src/product/guide-service.ts`
  - `src/store/lite-execution-episode-store.ts`
  - SDK token/accounting surfaces
- **Work:**
  1. use `exact_tokenizer|host_receipt|estimated|unavailable` for rendered
     sections; whole-request cost receipts use `provider_total`,
     `exact_tokenizer`, `signed_host_receipt`, `estimated`, or `unavailable`;
  2. separate current-state, learned-skill, evidence, and total prompt cost;
  3. include skill compiler cost separately and amortize it in reports;
  4. use provider totals for end-to-end cost gates;
  5. use section tokenizer counts only when an exact compatible tokenizer
     exists, otherwise label them estimates;
  6. update selector cost features only from authoritative observed costs.
- **Output:** model-agnostic cost attribution with explicit authority.
- **Done when:** reports never infer token efficiency from character length or
  call an estimated section count exact.

**Phase 3 effect gate**

- state-only and skill interventions are complete records;
- the selector can abstain;
- selector features are generic and reproducible;
- real positive and negative outcomes update the policy;
- current-state delivery remains independent and always available;
- no unvalidated adaptive skill is served outside controlled real development;
  always-on current-state continuity remains available;
- run Phase 6 Gate 1 immediately after this gate.

Phase 4 and full ecosystem integration are blocked until Gate 1 shows positive
net learning direction with complete harm and token evidence.

### Phase 4 — Make skills executable, compact, and self-correcting

**Entry gate:** Phase 6 Gate 1 is positive. If the selector cannot beat
state-only directionally, do not add Manifest, consolidation, or self-updating
policy complexity.

**Objective:** turn limited/validated L3 skills into compact Agent instructions
or executable procedures and
make real outcomes update their scope and lifecycle.

#### Task 4.1 — Map executable skills to Manifest where appropriate

- **Files:**
  - `/Volumes/ziel/new.aionis/AionisManifest/src/contracts.ts`
  - `/Volumes/ziel/new.aionis/AionisManifest/src/ir/types.ts`
  - `/Volumes/ziel/new.aionis/AionisManifest/src/plan/buildExecutionPlan.ts`
  - `/Volumes/ziel/new.aionis/AionisManifest/src/execute/moduleRuntime.ts`
  - Runtime skill/Manifest mapper
  - Runtime-generated contract JSON Schemas
- **Work:**
  1. consume the canonical Runtime-generated schema rather than hand-copying
     the learning contract;
  2. map parameters, preconditions, steps, dependencies, termination,
     verification, and recovery;
  3. preserve evidence and skill-version identity;
  4. reject unsafe or unrepresentable mappings;
  5. allow structured Agent-executable skills that do not require deterministic
     Manifest execution;
  6. do not force all reasoning into a static workflow.
- **Output:** optional executable procedure artifact for compatible skills.
- **Real verification:** execute real validated procedures through Manifest and
  ordinary Agent execution; require the specified expected transitions,
  termination, and same real verifier pass. Each path binds its own state/result
  digest rather than requiring byte-identical results.
- **Done when:** Manifest improves executability without becoming the selector
  or replacing open-ended Agent reasoning.

#### Task 4.2 — Implement progressive skill delivery

- **Files:**
  - `src/memory/agent-context-compiler.ts`
  - `src/memory/agent-context-renderer.ts`
  - `src/memory/product-output/guide-packet.ts`
  - `src/product/guide-service.ts`
- **Work:**
  1. render applicability, decisive checks, immediate steps, termination, and
     failure boundary first;
  2. expose recovery and detailed evidence only when needed;
  3. preserve structured provenance outside the Agent text;
  4. record each loaded section as part of the intervention;
  5. prevent duplicate content across state, skill, and evidence.
- **Output:** compact actionable guide.
- **Real verification:** compare current full-power delivery to the new renderer
  on real tasks using the same selected skill.
- **Done when:** Agent-visible skill tokens fall without verified-pass
  regression and the Agent can identify the skill's applicability and stop
  condition.

#### Task 4.3 — Connect actual-use and step-level evidence

- **Files:**
  - `src/product/lifecycle-service.ts`
  - `src/memory/feedback.ts`
  - new `src/memory/execution-skill-credit.ts`
  - `src/store/lite-execution-episode-store.ts`
  - skill store
  - SDK `recordMemoryUse`
- **Work:**
  1. retain intervention-level intent-to-treat as the primary product effect;
  2. record immutable `MemoryActualUseReceiptV1` at skill and step/section level
     only when the explicit host or signed tool adapter can prove it;
  3. distinguish ignored, partially used, fully used, and contradicted skills;
  4. bind skill/version, section/step IDs, action-event refs, authority, and
     evidence;
  5. treat unverifiable use as unknown and never infer it from lexical overlap
     or final success;
  6. update diagnostic credit without attributing all task success to every
     exposed memory;
  7. preserve uncertainty when use cannot be established.
- **Output:** defensible skill-use evidence.
- **Real verification:** real Agent traces demonstrate use, non-use, partial use,
  and harmful use without synthetic annotations.
- **Done when:** success no longer grants blanket credit to every exposed item.
  MCP mapping is explicitly deferred to Task 5.2 and does not block
  Runtime+SDK credit completion here.

#### Task 4.4 — Implement consolidation, splitting, and deprecation

- **Files:**
  - new `src/kernel/execution-skill-consolidation.ts`
  - `src/kernel/forgetting-kernel.ts`
  - `src/memory/layer-policy.ts`
  - `src/memory/memory-lifecycle-adjudicator.ts`
  - `src/memory/lifecycle-candidate-inference.ts`
  - skill store
- **Work:**
  1. merge duplicates only when procedures and boundaries agree;
  2. split only when the active versioned L5 lifecycle policy reports a
     predeclared contextual effect difference with adequate independent
     exposure;
  3. narrow applicability after counterexamples;
  4. deprecate only from versioned policy outputs for non-value, harm,
     supersession, or version drift;
  5. treat lexical supersedes/invalidates as a candidate relation only;
  6. propose a new L2 revision when content/scope changes, then call the unique
     `ExecutionSkillPromotionService` after new validation; never promote
     independently;
  7. consume effect intervals, minimum independent exposure, and action
     thresholds from immutable policy artifacts; write no lifecycle magic
     counts in Core;
  8. submit complete real outcomes to the same versioned L4 training service
     introduced in Task 3.3; lifecycle code cannot fit or mutate a second value
     model;
  9. reserve cross-domain capability claims for benchmark evidence rather than
     overloading the layer number.
- **Output:** value-driven skill lifecycle.
- **Real verification:** accumulate at least 30 real episodes containing
  helpful, harmful, stale/version-shifted, and conflicting experience.
- **Done when:** state changes follow observed effects, not fixed cue words or
  counts.

#### Task 4.5 — Learn and version L5

- **Files:**
  - selector policy store
  - selector training worker
  - `src/memory/layer-policy.ts`
- **Work:**
  1. start from the bootstrap L5 produced by Task 3.3;
  2. train only from real intervention outcomes;
  3. preserve last known-good policy;
  4. compare policy versions on held-out real tasks;
  5. roll back policy independently from memories and continuity;
  6. emit subsequent immutable L5 versions; do not redefine L5 ownership.
- **Output:** evidence-backed successor meta-policy artifacts.
- **Done when:** L5 changes future choices and its effect can be compared to the
  preceding version.

**Phase 4 effect gate**

- validated skills are actionable and bounded;
- actual-use and outcome can revise skill value and applicability;
- negative-neighbor direct injection remains within the numeric Gate 1 limit;
- stale/version-incompatible skills stop appearing;
- L3/L4/L5 reflect real behavior rather than labels or hand-written rules.

### Phase 5 — Connect the complete Aionis product

**Objective:** make Runtime, SDK, MCP, AIFS, Substrate, Manifest, CLI, and Create
one installable product loop without duplicating decision logic.

**Entry gate:** Phase 6 Gate 0 and Gate 1 must first run through Runtime plus the
canonical SDK session and show positive net learning direction. Do not spend a
full product-integration cycle wrapping a compiler/selector that has not
delivered a real skill or has negative net effect.

#### Task 5.1 — Finalize SDK session ownership

- **Files:**
  - `/Volumes/ziel/new.aionis/aionis-sdk/src/index.ts`
  - `/Volumes/ziel/new.aionis/aionis-sdk/package.json`
  - `/Volumes/ziel/new.aionis/aionis-sdk/tsconfig.json`
  - `/Volumes/ziel/new.aionis/aionis-sdk/scripts/runtime-source.mjs`
  - new generated-only `/Volumes/ziel/new.aionis/aionis-contracts` package
  - `src/sdk.ts`
  - `scripts/sdk-source.mjs`
  - Runtime-generated contract JSON Schemas
- **Work:**
  1. split transport, contracts, session, and rendering into maintainable
     modules in the dedicated SDK repository;
  2. make `AionisAgentSession` the primary documented API;
  3. keep lower-level methods;
  4. remove fixed coding/document/QA task profiles from generic behavior;
  5. make Runtime-generated JSON Schema the canonical contract source and
     package the generated schemas/types/digests as logic-free
     `@aionis/contracts`;
  6. make SDK and Manifest depend on a declared compatible contracts version
     and verify the canonical digest during build/install;
  7. generate SDK public contract types from the contracts package;
  8. keep session/transport implementation canonical in the SDK repository;
  9. update both source-sync scripts, package exports, and TypeScript project
     layout; retire text-region duplication only after generated-type parity.
- **Output:** one public integration API.
- **Real verification:** a real host uses only the published-source SDK API to
  complete the full loop, and the installed compatibility matrix binds Runtime,
  SDK, Manifest, and contracts digests.

#### Task 5.2 — Fix and simplify MCP

- **Files:** `/Volumes/ziel/new.aionis/aionis-mcp/src/tools.ts`
- **Work:**
  1. map tools to the canonical session;
  2. map planned-action and generic artifact `recordMemoryUse` receipts without
     redefining them;
  3. require a valid intervention/source identity for feedback;
  4. stop accepting trace-only feedback that cannot close Runtime attribution;
  5. send only compact context as Agent text;
  6. keep receipts and audit data structured.
- **Output:** one complete MCP loop.
- **Real verification:** a real MCP Agent completes, closes, resumes, and reuses
  an episode without SDK-specific manual repair.

#### Task 5.3 — Make AIFS a live projection

- **Files:** `/Volumes/ziel/new.aionis/aionis-aifs/src/index.ts`
- **Work:**
  1. read generated Runtime configuration;
  2. project canonical state and skill sections;
  3. wrap/decorate the canonical SDK session and refresh after each successful
     session operation; do not add a new Runtime event stream or polling brain
     in this phase;
  4. deduplicate content;
  5. remove independent memory selection behavior.
- **Output:** a useful filesystem interface to the same product state.
- **Real verification:** a real file-capable Agent resumes from AIFS and obtains
  the same semantic state as SDK/MCP.

#### Task 5.4 — Resolve the Substrate role

- **Files:**
  - `/Volumes/ziel/new.aionis/AionisSubstrate/src/types.ts`
  - `src/file-substrate.ts`
  - `src/candidate-index.ts`
  - `src/runtime-live-sidecar.ts`
  - Runtime candidate adapter
- **Work:**
  1. define one candidate-accelerator adapter contract; if Substrate cannot
     satisfy it, explicitly separate the library;
  2. if retained, require a canonical candidate superset or pass predeclared
     recall parity@k against Runtime semantic scan;
  3. make query relevance and skill metadata first-class;
  4. remove table-name/string heuristic coupling where a versioned export
     contract can be used;
  5. keep Runtime authority, compatibility recheck, and final selection.
- **Output:** one unambiguous storage/candidate boundary.
- **Real verification:** adapter-on meets the frozen recall-parity@k contract
  and preserves scope, lifecycle, version, authority, and compatibility
  invariants. Approximate ordering need not be byte-identical.

#### Task 5.5 — Align CLI/Create versions and onboarding

- **Files:**
  - `/Volumes/ziel/new.aionis/aionis-cli/src/index.ts`
  - `/Volumes/ziel/new.aionis/aionis-create/src/index.ts`
  - Runtime cohort-pack import/export operation and SDK/CLI command
  - package manifests
- **Work:**
  1. declare one compatibility set;
  2. stop installing Runtime `v0.3.6` for the new product;
  3. configure canonical Runtime and optional adapters;
  4. produce one start and one AgentSession quickstart;
  5. add explicit `RealEpisodeCohortPackV1` export/import with schema, digest,
     split, episode, verifier, cost, and provenance validation;
  6. import through Runtime authority operations rather than copying SQLite
     rows or trusting an outcome enum;
  7. keep real verification opt-in because it incurs LLM/tool cost.
- **Output:** installable product, not disconnected package hints.
- **Real verification:** fresh empty-directory installation followed by real
  session, resume, and feedback. Learning reuse uses a separately supplied,
  precollected real multi-episode cohort plus an independent held-out target;
  onboarding never weakens promotion rules.

**Phase 5 product gate**

A fresh install can execute:

```text
install
-> begin real task
-> receive current state
-> act and record real transitions
-> verify and close
-> resume another session
-> load a declared real training cohort
-> compile and validate without changing thresholds
-> run an independent held-out target
-> reuse or abstain
```

No user manually coordinates unrelated IDs, copies payloads between packages,
or configures incompatible versions.

### Phase 6 — Prove product effect with real Agents

**Objective:** independently prove always-on continuity and adaptive learning.
These are related but distinct effects.

#### 6.1 Benchmark A — Continuity and compression

For each real task, Episode 1 executes to a predetermined interruption boundary.
A new Agent instance starts from the same resulting workspace snapshot.

The interruption rule is locked before any arm runs and expressed in observable
steps, tool calls, or elapsed time. It cannot be selected after inspecting the
trajectory. If Episode 1 reaches a verifier-backed completed state before the
boundary, the task is classified `early_complete` and replaced only by the next
task in a prelocked reserve list; the replacement rule and attrition are
reported.

| Arm | Input |
|---|---|
| N — cold restart | workspace and original task only |
| H — full history | workspace plus the complete Episode 1 trajectory; primary S/H claims include only tasks whose complete history fits the locked cap |
| S — Aionis state-only | workspace plus canonical Aionis current state; no cross-task skill |

If complete Episode 1 history does not fit the locked cap, the task enters a
separately reported `H-bounded-recent` stratum using the predeclared truncation
rule. It remains useful operational evidence but cannot support a claim against
“full history”.

Primary questions:

- does S improve verified continuation versus N;
- is S non-inferior to H in correctness;
- does S reduce memory/context tokens, repeated reads, repeated commands, and
  steps to the first correct action versus H.

Reuse the existing real runner rather than create another Agent framework:

- `/Volumes/ziel/new.aionis/AionisRuntime-evals/benchmarks/truth-benchmark-v1/run-episode1.mjs`
- `/Volumes/ziel/new.aionis/AionisRuntime-evals/benchmarks/truth-benchmark-v1/run-episode2.mjs`
- `/Volumes/ziel/new.aionis/AionisRuntime-evals/benchmarks/truth-benchmark-v1/run-one-cell.mjs`
- `/Volumes/ziel/new.aionis/AionisRuntime-evals/benchmarks/truth-benchmark-v1/deepseek-agent.mjs`

#### 6.2 Benchmark B — Cross-task learning

Freeze a real training episode set, compiler version, candidate registry, and
selector policy. Run only held-out tasks that were not visible to the compiler.

| Arm | Input |
|---|---|
| A — no Aionis | current task/environment only |
| B — state-only Aionis | canonical current state; no cross-task skill |
| C — adaptive Aionis | current state plus the frozen compiler/registry/selector behavior |

The learning effect is `C - B`. `C - A` measures total Aionis effect but cannot
isolate learned experience from continuity.

A C-arm task remains in C even if the selector abstains. Abstention is part of
the product policy, not missing data.

Gate 0 is the only exception to the learned-selector wording: its C arm is a
validation-only treatment using the exact L2 version/content named by
`PairedHypothesisValidationPolicyV1`. It proves
compilation/validation-rendering/delivery/attribution only and creates no
production-use authority. Gate 1 and later C arms use L3 plus the frozen L4/L5
selector produced by Task 3.3.

#### 6.3 Real-task requirements

Product-effect panels must:

- use real repositories, services, databases, files, tools, and artifacts;
- use real LLM calls for both Agent execution and semantic skill compilation;
- use external executable or independently executed verifiers;
- include success, failure, interruption, resume, negative neighbors, version
  drift, and cross-repository transfer;
- physically separate training, development, confirmatory, negative-neighbor,
  and cross-model sets;
- prevent Runtime from receiving evaluation family labels or expected answers;
- never turn a benchmark failure into a Core rule.

Initial domains:

1. real code repair or feature implementation;
2. real database, service, or shell workflow;
3. real data processing, analysis, or artifact generation;
4. long-running continuation/handoff tasks.

These domains define evaluation coverage, not Runtime behavior.

Each learned mechanism should encounter:

- a verifier-backed success;
- a related failure;
- an unseen positive-transfer target;
- a surface-similar negative neighbor;
- a different repository/environment target.

#### 6.4 Cell execution protocol

All arms for one task must:

- use the same LLM and declared model version;
- use the same system prompt except for the assigned memory input;
- use the same tools and permissions;
- begin from cloned initial environment/workspace state;
- use the same hard caps for total input/output tokens, tool calls, and elapsed
  time; monetary cost is measured, not forced equal across cache/provider
  behavior;
- count all injected current state, full history, skills, and evidence against
  the cell input-token cap;
- classify H overflow before running Episode 2. Complete-fit tasks enter the
  primary H-full stratum; overflow tasks use the deterministic
  H-bounded-recent rule (preserve system/task input, then retain the most recent
  ordered history that fits and report omitted tokens) and are analyzed
  separately;
- use isolated Runtime databases, namespaces, and workspaces;
- randomize execution order;
- use an arm-blind final verifier that receives task assets and final state but
  never the arm, prompt, memory, context, or history;
- bind verifier receipt to the exact final state;
- preserve failures and timeouts.

Agent self-reported success is not success. If the verifier fails, the cell
fails. Only a provider outage or environment failure demonstrably independent
of the arm may be classified as infrastructure failure.

Task-specific verifier implementations live only in `AionisRuntime-evals`.
Runtime owns generic verifier/outcome receipts, not task answers.

After a confirmatory panel opens, do not modify prompts, task inputs, compiler,
selector, budgets, or verifier rules.

#### 6.5 Required records

Every cell records:

```text
task_id and split
domain and repository/environment
model and model version
arm
initial and final state digests
Runtime, SDK, compiler, skill-registry, and policy versions
eligible candidates and features
selected skill or abstention reason
rendered current-state and skill tokens
token usage authority for each reported token field
actual-use receipts
tool calls and elapsed time
input/output/cached tokens
skill compiler and embedding cost
verifier status and evidence
failure category
final reward
```

Compiler cost is reported separately and amortized at defined reuse counts
(first, fifth, and twentieth use). The primary fully loaded product-cost claim
uses five reuses; first-use and twenty-use views remain mandatory sensitivity
reports. It cannot be hidden from the token/value claim.

Report two token ratios:

- **online serving ratio:** Agent plus delivered memory/context tokens;
- **fully loaded ratio:** serving plus embedding and compiler tokens amortized
  at the declared reuse count.

The fully loaded calculation is locked before a panel:

```text
fully_loaded_tokens(cell, reuse_count)
= online_serving_tokens(cell)
 + observed query/embedding tokens(cell)
 + sum(build_tokens(skill_version) / reuse_count
       for each skill_version eligible in that cell)
```

`build_tokens` includes evidence preparation, embedding, and semantic compiler
tokens attributable to that immutable skill version. Eligibility, not eventual
selection, controls allocation so abstention cannot hide build cost. The
primary product gate uses `reuse_count = 5`; first-use and twentieth-use
calculations are mandatory sensitivity reports. Both the online ratio and the
five-use fully loaded ratio must pass a token-efficiency gate; the better ratio
cannot be selected after results are seen.

#### 6.6 Metrics

Primary:

```text
verified_pass@fixed_budget
```

Continuity:

```text
pass(S) - pass(N)
pass(S) - pass(H)
S/H memory-context token ratio
S/H total tokens per verified success
repeated file reads
repeated commands
steps to first correct action
resume-state completeness
```

For the primary rediscovery metric, normalize repeated operations as the count
of canonicalized `(operation kind, target identity)` pairs repeated after
resume despite already having a verified Episode 1 result. File reads and
commands are reported separately as diagnostics; the primary definition cannot
switch after results are seen.

Learning:

```text
helpful_transfer = P(C passes and B fails)
harmful_transfer = P(C fails and B passes)
net_learning_lift = helpful_transfer - harmful_transfer
tokens_per_verified_success(C) / tokens_per_verified_success(B)
negative-neighbor direct-skill injection rate
abstention rate and abstention precision
cross-repository lift
cross-model lift
```

Definitions:

- harmful-transfer denominator is every valid paired C/B base task, not only
  tasks where a skill was selected;
- negative-neighbor direct-injection denominator is every sealed
  negative-neighbor task;
- direct injection means an L3 procedure body or executable Manifest content
  appears in `use_now`; an inspect pointer alone is not direct injection;
- abstention is C serving continuity with no L3 procedure body;
- token-per-success is total counted tokens divided by verifier-backed passes
  in the arm.

Internal `/measure` values remain diagnostics and cannot satisfy these metrics.

#### 6.7 Analysis contract

The independent resampling unit is the base task, not an Agent seed or
individual arm cell.

If repeated seeds are used:

- seed count is fixed before the panel;
- outcomes and costs are aggregated within `(base task, arm)` first;
- bootstrap resampling occurs over base tasks;
- no seed is removed because it failed.

Primary estimator:

- domain-stratified paired risk difference;
- equal weight across declared domains, then equal task weight within domain;
- 50,000 paired bootstrap resamples stratified by domain;
- two-sided 95% interval for efficacy differences;
- one-sided 95% upper bounds for harmful transfer and token ratios.

Gatekeeping order:

```text
C - B
-> C - A
-> Pfinal - P0
```

The next efficacy claim is tested only after the preceding gate passes. There
is no interim efficacy look in a sealed confirmatory panel.

Missing-block rule:

- an arm-caused crash, timeout, bad tool action, or budget exhaustion is a task
  failure;
- an independently verified provider/environment outage invalidates the whole
  paired task block, not one unfavorable arm;
- invalid blocks are replaced only from a prelocked reserve list;
- all attrition and reasons are reported.

Token-ratio rule:

- compute aggregate online-serving and five-use fully loaded tokens per
  verified success for each arm using the locked allocation formula;
- bootstrap paired base-task blocks;
- if the comparator has zero verified successes in the observed panel or a
  bootstrap replicate, the ratio is undefined/infinite for that replicate and
  the cost gate cannot pass by omission;
- report both online-serving and fully-loaded ratios.

Continuity uses the same paired, domain-stratified task bootstrap for S-N and
S-H. Non-inferiority tests `S-H > -3 percentage points`. Formal token and
rediscovery claims require the corresponding one-sided 95% upper bound, not
only a favorable point estimate.

Primary S-H correctness/compression estimators use only the predeclared H-full
stratum. H-bounded-recent overflow tasks are reported as a separate secondary
stratum and cannot be pooled into a full-history claim.

#### 6.8 Run gates

##### Gate 0 — Real pipeline smoke

- three real mechanism cohorts;
- each cohort contains at least:
  - one verifier-backed success training episode;
  - one related verifier-backed failure training episode;
  - one held-out target not visible to the compiler;
- run N/H/S on three interruption targets;
- run state-only and validation-only L2 paired blocks on the three held-out
  learning targets; the A/B/C labels are retained only for runner transport
  compatibility and C is not a learned-selector/L3 arm here;
- real LLM, tools, Runtime, compiler, and verifier;
- confirms only transport, attribution, and reproducibility;
- makes no product-effect claim.

The existing Vite, Requests, Flask, and Playwright tasks may calibrate the
runner. They count as a learning smoke cohort only if a predeclared,
mechanistically related source success/failure and a distinct held-out target
exist; unrelated task names cannot be grouped merely to make the pipeline run.
These three smoke targets do not by themselves satisfy the per-hypothesis L3
limited threshold unless the predeclared Task 2.8 design independently provides
the required targets/signatures for the same hypothesis.

##### Gate 1 — 24-task directional Alpha

Run two separately reported panels:

**Continuity Alpha**

- 24 independent interrupted H-full base tasks; H-bounded-recent overflow tasks
  are additional secondary cells and replaced from the prelocked reserve for
  the primary panel;
- at least three domains, eight tasks per domain;
- 72 N/H/S cells;
- fixed interruption and reserve rules;
- estimates S-N direction, S-H non-inferiority variance, token ratio, and
  rediscovery variance.

**Learning Alpha**

- 24 independent held-out target tasks;
- at least three domains, eight tasks per domain;
- 72 A/B/C cells;
- at least 20% negative neighbors;
- one fixed primary model;
- frozen compiler, registry, and policy within the panel;
- scoped L3 `limited` is allowed only when the task is inside its receipt scope;
  all other deliveries require L3 `validated`.

Continue only if:

- continuity `S-N` verified-pass point estimate is positive and S has no more
  than two fewer passes than H across the 24 paired tasks
  (`S-H >= -8.34 percentage points`);
- C actually delivers skills on positive-transfer tasks;
- net learning lift is positive;
- helpful transfers outnumber harmful transfers;
- among the sealed negative neighbors, at most one task receives direct skill
  injection and harmful transfer does not exceed one task;
- verifier, actual-use, and token records are complete;
- in each eight-task domain, C has no more than one net pass loss versus B and
  harmful transfers do not exceed helpful transfers by more than one.

Zero skill delivery is mechanism failure, not successful harm prevention.

After Alpha, run separate power simulations:

- continuity formal sample size uses S-N paired discordance, S-H variance around
  the -3 percentage-point non-inferiority margin, infrastructure attrition, and
  domain/task correlation;
- learning formal sample size uses A/B/C paired discordance and the minimum
  relevant +8 percentage-point C-B effect.

##### Gate 2 — 80–120-task Beta

- at least three declared domains;
- within each domain, at least four independent mechanism/task clusters;
- within each domain, at least two repositories/environments;
- at least half of target repositories/environments absent from training;
- 80–120 independent base tasks for the primary model;
- a prespecified 30–40-task second-model directional subset;
- frozen panel and policies;
- C may deliver only L3 `validated`; scope-limited development skills are not
  Beta production evidence.

Beta targets:

- C-B verified-pass uplift of at least 8 percentage points;
- harmful-transfer point estimate no greater than 5%;
- negative-neighbor direct-skill injection no greater than 5%;
- both online-serving and five-use fully loaded C/B tokens per verified success
  no greater than 1.10;
- in every predeclared domain, the paired C-B verified-pass point estimate is
  at least -5 percentage points and
  `harmful_transfer - helpful_transfer` is at most +5 percentage points.

These are thresholds for continuing to convergence work, not permission to
claim confirmation.

Define a sealed cross-repository subset containing only targets whose
repository/environment was absent from training. Report its C-B paired
interval. A positive point estimate is sufficient to continue from Beta;
cross-repository product claims require its confirmatory lower bound above
zero.

The 30–40-task second-model subset estimates direction and variance only. It
uses the exact skill registry compiled/trained from the primary model traces,
without recompilation or selector retraining. If skills are rebuilt from
second-model traces, the result demonstrates pipeline portability, not
cross-model memory transfer.

##### Gate 3 — Confirmatory product result

Determine sample size once by a predeclared joint simulation using Alpha/Beta
paired discordance, baseline pass rate, infrastructure loss, domain/task
correlation, and a minimum relevant effect of 8 percentage points. The
simulation must target the required power for the full fixed-order conjunction:
`C-B`, `C-A`, `Pfinal-P0`, harmful-transfer upper bound, online token upper
bound, and five-use fully loaded token upper bound. Lock separate sample/support
requirements for the `Pfinal/P0` subset and harm/token endpoints. A
cross-repository efficacy claim receives its own powered subset; otherwise that
subset remains descriptive.

Gate 3 runs only on the final Phase 7-converged Runtime/SDK code after the
locked post-deletion Beta non-regression panel passes.

Before outcomes are observed, lock a `Pfinal/P0` subset and run additional
cells:

- `P0` uses the initial training-cutoff skill registry and selector parameters;
- `Pfinal` uses the final training-cutoff registry and selector parameters;
- Runtime, SDK, compiler implementation, renderer, feature schema, model,
  tools, budget, and task input are identical;
- only learned artifacts and their training cutoff differ;
- subset size is powered for the `Pfinal-P0` comparison.

Required result:

- C-B point estimate at least +8 percentage points;
- two-sided 95% interval for C-B has lower bound above zero;
- C-A interval also has lower bound above zero;
- final learned policy versus initial frozen policy has lower bound above zero,
  showing improvement came from experience rather than manual Runtime changes;
- harmful-transfer one-sided 95% upper bound is at most 5%;
- both the online-serving and five-use fully loaded C/B
  tokens-per-success one-sided 95% upper bounds are at most 1.00 for a combined
  correctness-and-token-efficiency claim. If correctness passes but either cost
  gate fails, Aionis may claim correctness uplift only, not token efficiency.

The confirmatory cross-repository subset must also have a C-B lower bound above
zero before a cross-repository transfer claim.

##### Gate 4A — Cross-model transfer

Use the Gate 2 second-model directional subset to estimate variance, then power
and lock an independent second-model panel. Before opening it, run a joint
simulation for the complete required conjunction: positive C-B interval,
harmful-transfer upper bound, online-serving token upper bound, and five-use
fully loaded token upper bound. Lock the panel size/support that gives at least
80% joint power under the predeclared minimum relevant alternatives and
infrastructure attrition. The second model receives the same frozen
primary-model-derived skill registry and policy artifact.

The second model must independently pass:

- positive C-B interval;
- harmful-transfer one-sided 95% upper bound at most 5%;
- both online-serving and five-use fully loaded token-ratio one-sided 95% upper
  bounds at most 1.00.

A cross-repository second-model claim requires its own powered subset and a C-B
lower bound above zero. If that subset is not separately powered, report it
descriptively and do not make it a mandatory Gate 4A condition or a
cross-repository cross-model claim.

Recompiling or retraining from second-model traces is reported separately as
pipeline portability and does not satisfy cross-model memory transfer.

##### Gate 4B — Drift control

Drift is a separate final-code product gate, not an anecdotal observation.

First run a 24-target directional pilot: 12 real tasks with a declared
tool/environment version incompatibility and 12 real latent behavior-change
sequences. Use it to power and lock a confirmatory panel with at least:

- 60 independent declared-incompatibility targets;
- 20 independent latent-drift sequences across at least three domains;
- four or more verifier-backed post-change episodes per latent sequence;
- paired B state-only and C adaptive-Aionis cells from identical starting state;
- the same real LLM, tools, budgets, and arm-blind verifier.

The final drift gate requires:

- declared-incompatibility direct-skill-injection one-sided 95% upper bound at
  most 5%;
- C-B harmful-transfer one-sided 95% upper bound at most 5%;
- C versus B verified-pass non-inferiority no worse than -3 percentage points;
- at least 90% of latent sequences reach `narrow|quarantine|revalidate` no later
  than the second verifier-backed harmful exposure, with one-sided 95% lower
  bound at least 80%;
- zero unvalidated reactivations in the observed panel;
- every transition is produced by the versioned L5 lifecycle policy and
  append-only lifecycle receipts, not a task-specific Runtime change.

If this gate does not pass, drift remains diagnostic and Aionis cannot claim
controlled self-learning under environment/tool change.

#### 6.9 Continuity Beta, convergence, and Confirmatory

Continuity follows the same final-code discipline as learning.

**Continuity Beta — pre-deletion authorization**

Use the Gate 1 variance/power simulation to lock an independent N/H/S Beta
panel. It authorizes Phase 7 continuity-path convergence only if:

- S-N verified-pass uplift point estimate is at least +8 percentage points and
  its 95% interval lower bound is above zero;
- S versus H correctness satisfies the -3 percentage-point non-inferiority
  margin;
- one-sided 95% upper bound for S/H memory-context token ratio is at most 0.40;
- one-sided 95% upper bound for S/H total tokens per verified success is at
  most 0.85;
- one-sided 95% upper bound for the canonical repeated-operation S/H ratio is
  at most 0.70.

The separately unseen Continuity Confirmatory sample size is not inherited
from a single endpoint. Before opening that panel, run and freeze a joint power
simulation over the complete conjunction of S-N superiority, S-H
non-inferiority, memory-context token ratio, total tokens per verified success,
and canonical repeated-operation ratio. Use Alpha/Beta paired covariance,
domain/task correlation, H-full eligibility, infrastructure attrition, and
predeclared minimum relevant alternatives; require at least 80% joint power for
all five gates together.

File-read and command counts are reported separately as diagnostics; they
cannot be selected after results in place of the canonical repeated-operation
metric. The H comparison and compression claim use the H-full stratum only.

**After Phase 7**

1. rerun the locked Continuity Beta N/H/S tasks on final code and require both
   the original Beta thresholds and final-versus-pre-deletion non-regression;
2. freeze final Runtime/SDK/renderer code;
3. open a separately powered, previously unseen Continuity Confirmatory panel
   with the same thresholds and analysis contract.

Only the final-code Continuity Confirmatory pass permits Aionis to claim that it
restores execution state with less context and rediscovery without sacrificing
correctness. A pre-deletion Beta pass alone is design/convergence evidence.

**Phase 6 claim matrix**

Product claims are limited to the gates actually passed:

- final-code Continuity Confirmatory: continuity and context-compression claims;
- directional Alpha/Beta: design-partner evaluation only;
- Confirmatory: automatic real-task correctness uplift in the measured scope;
- cross-repository: cross-repository transfer;
- second-model Gate 4A: transfer demonstrated across the two tested model
  families;
- Gate 3 harm plus Gate 4B drift: controlled self-learning and
  negative-transfer/drift control.

### Phase 7 — Delete replaced complexity

**Objective:** reduce the production system after the new product path proves
equal or better real behavior.

**Entry gate:** Gate 2 Beta is positive for the paths being replaced. Learned
paths cannot be deleted from/replaced before learning Beta; continuity paths
cannot be deleted from/replaced before Continuity Beta. Gate 3 and Continuity
Confirmatory are deliberately run after this convergence phase on final code.

#### Task 7.1 — Remove task-derived and fixed decision paths

- remove synthetic tool registry entries;
- remove fixed task-family classification;
- remove language/command/repository solution recipes;
- remove fixed path/tool/family final-use bonuses;
- remove fixed trace-derived skills;
- remove task-specific next-action templates;
- ensure evaluation labels remain in `AionisRuntime-evals`.

**Deletion gate:** on independent development tasks, the new path is no worse
than the old path by more than three percentage points, uses at least 20% fewer
memory/prompt tokens, and does not increase harmful transfer. The corresponding
Gate 2 effect must also have passed before learned decision paths are removed.

#### Task 7.2 — Remove duplicate learning and delivery brains

- remove the old shallow episode-to-shared-memory compiler;
- remove the second SDK prompt/decision compiler;
- remove unused/dormant learning loops and shadow association paths;
- remove competing selector/scorer paths;
- remove inactive L4/L5 prose shells only after the new canonical L4 model and
  L5 policy artifacts are authoritative and replayable;
- retain one current-state compiler, one skill compiler, one selector, one
  renderer, and one feedback/value loop.

#### Task 7.3 — Move evaluation orchestration out of the daemon

- move fixed experiment waves, sample sizes, admission datasets, benchmark
  registries, and task-specific verifier orchestration into
  `AionisRuntime-evals`;
- keep generic episode, intervention, reward, policy, and verifier receipt
  contracts in Runtime;
- remove product-startup dependencies used only for research/evaluation.

#### Task 7.4 — Remove unused product surfaces

After fresh-install and representative real-task verification:

- remove unused routes;
- remove unused environment fields;
- remove compatibility surfaces only after a caller inventory covering public
  docs, SDK low-level APIs, CLI, MCP, AIFS, Manifest, Substrate, and install
  examples shows no real caller and names a replacement path;
- downgrade `/measure` proxy scores to clearly named internal telemetry;
- keep ordinary memory and full product operations that have real callers and
  value;
- move personal-profile extraction to an optional ordinary-memory
  adapter/profile when it has a real caller; do not delete that capability
  merely because it does not belong in Execution Memory Core.

#### Task 7.5 — Complexity targets

At Phase 7 entry, freeze a new implementation-peak manifest containing total
source, Runtime-entry closure, module count, route/env count, and component
ownership. Every report shows three comparisons:

1. versus the 2026-07-28 audit baseline;
2. versus the Phase 7-entry implementation peak;
3. versus the absolute targets below.

After Beta effect passes, target:

```text
Runtime total source           <= 150,000 lines
Runtime-entry closure          <= 120,000 lines
production task-specific rules = 0
canonical current compiler     = 1
canonical skill compiler       = 1
canonical final selector       = 1
canonical context renderer     = 1
canonical feedback/value loop  = 1
```

The absolute targets would reduce the 2026-07-28 audit peak by approximately
25–30%; the actual percentage from the Phase 7-entry implementation peak is
reported separately. They are consequences of replacing weak paths, not
permission to delete working continuity or product functions.

An effect-backed exception is per module, not a blanket budget increase. It
must name the module, active public/product caller, measured effect dependency,
why no smaller owner exists, and an expiry/review condition.

Every deletion wave is compared both with its prior wave and with the same
frozen pre-deletion Gate 2 baseline using identical task snapshots, model,
budget, and verifier. Freeze one `ConvergenceNonRegressionV1` analysis before
the first deletion. For every wave and the final build, aggregate within base
task and use the Section 6.7 domain-stratified 50,000-replicate paired bootstrap
over matched pre-deletion/current-code blocks. The following one-sided 95%
bounds are mandatory relative to the frozen pre-deletion result:

```text
Learning
LB[pass(C_wave) - pass(C_pre)]                         >= -0.02
LB[(C-B)_wave - (C-B)_pre]                            >= -0.02
UB[harmful_transfer_wave - harmful_transfer_pre]      <= +0.01
UB[online_C/B_ratio_wave - online_C/B_ratio_pre]      <= +0.02
UB[loaded5_C/B_ratio_wave - loaded5_C/B_ratio_pre]    <= +0.02

Continuity
LB[(S-N)_wave - (S-N)_pre]                            >= -0.02
LB[(S-H)_wave - (S-H)_pre]                            >= -0.02
UB[memory_context_S/H_wave - memory_context_S/H_pre]  <= +0.02
UB[total_token_S/H_wave - total_token_S/H_pre]        <= +0.02
UB[rediscovery_S/H_wave - rediscovery_S/H_pre]        <= +0.02
```

Ratio tolerances are absolute ratio units, not relative percentages. A wave
that fails any applicable bound is reverted or reworked before another
deletion; later improvements cannot average away an earlier failed wave. The
final build must additionally pass every original Gate 2 and Continuity Beta
threshold, so these non-regression margins cannot weaken the product gates.

**Phase 7 exit gate**

Every module in the production entry closure can be assigned to at least one:

```text
capture execution truth
restore current state
compile executable experience
retrieve compatible candidates
select expected-value-positive experience
deliver compact context
learn from verified outcomes
forget or rehydrate based on value
serve the canonical product interface
```

Modules that satisfy none and have no demonstrated product caller are removed
or moved out of the daemon.

After the last deletion wave:

1. rerun locked learning Gate 2 and require both every original Gate 2 target
   (`+8pp`, harm, direct-injection, both token ratios, domain result) and the
   final-versus-pre-deletion non-regression limits;
2. rerun locked Continuity Beta N/H/S and require both original Continuity Beta
   targets and final-versus-pre-deletion non-regression;
3. only then freeze final Runtime/SDK/renderer code for learning Gate 3,
   Continuity Confirmatory, Gate 4A cross-model transfer, and Gate 4B drift.

## 12. Dependency Order and Critical Path

```text
Phase 0  preserve and classify the current real baseline
   |
   v
Phase 1 core  semantic state + AgentSession + workspace continuity
   |
   v
Phase 1A continuity directional gate
   |
   v
Task 1.6A  freeze subject V2 + migrate workspace contracts
   |
   +--> Phase 2  real packs -> L1 -> L2 -> paired validation -> limited L3
   |       |
   |       v
   |    Phase 6 Gate 0  minimal real learning smoke
   |       |
   |       v
   |    Phase 3  complete ledger + compatibility + value selector
   |
   +--> Phase 1B  two non-workspace adapters on frozen subject V2
           |
           v
      both branches complete
           |
           v
Phase 6 Gate 1  real directional selector effect
   |
   v
Phase 4  compact execution + credit + consolidation/forgetting + L5 updates
   |
   v
Phase 5  SDK/MCP/AIFS/Substrate/Manifest/CLI/Create product loop
   |
   v
Phase 6  learning Gate 2 Beta + Continuity Beta
   |
   v
Phase 7  delete replaced complexity
   |
   v
locked post-deletion learning Gate 2 + Continuity Beta
   |
   v
final-code learning Gate 3 + Continuity Confirmatory + Gate 4A/4B
```

Hard dependencies:

- selector work cannot begin from incomplete intervention records;
- Phase 2 cohort/ledger work cannot begin before Task 1.6A freezes the
  workspace subject/event/state/transport contracts;
- active skill delivery cannot begin before L3 held-out validation;
- lifecycle learning cannot become authoritative before actual-use/outcome
  linkage;
- multi-domain Gate 1 cannot begin before Phase 1B adapters pass;
- Phase 4 cannot begin before Gate 1 is positive;
- broad product integration cannot stabilize before the session/context
  contracts stabilize;
- old task rules and compilers cannot be deleted before their replacements pass
  the relevant Gate 2 and frozen-baseline deletion comparisons;
- Gate 3 and Continuity Confirmatory cannot run until Phase 7 convergence and
  both locked post-deletion Beta/non-regression reruns pass;
- market claims cannot precede the relevant Phase 6 gate.

Parallel work that does not change product semantics:

- Manifest mapping may be prepared only after Gate 1 and must consume the
  Runtime-generated schema;
- Task 2.0 real episode acquisition and external verifier preparation can start
  during Phase 1 and proceed while the compiler is built;
- generated SDK/MCP type preparation can proceed while Runtime contracts
  stabilize, but final behavior remains Runtime-owned;
- Task 1.6B non-workspace adapters can be built against the frozen V2 contract
  while Phase 2 continues, but must pass before Gate 1.

## 13. Estimated Delivery Windows

These are implementation estimates for one primary product stream, not release
promises. Real-LLM run time, task acquisition, and effect size determine the
actual schedule.

| Work | Expected focused implementation window |
|---|---:|
| Phase 0 | 1 working day |
| Phase 1 | 8–12 working days |
| Phase 2 | 12–18 working days |
| Phase 3 | 8–12 working days |
| Phase 4 | 6–10 working days |
| Phase 6 Gate 0/1 | 5–10 working days plus provider execution time |
| Phase 5 | 5–8 working days after Gate 1 |
| Phase 6 Beta/Confirmatory | determined by sample size; commonly several weeks |
| Phase 7 | 5–10 working days |

Expected milestones:

- first improved always-on continuity/context result: after Phase 1;
- first real held-out skill-transfer evidence: after Phase 2;
- first learned use/no-use result: after Phase 3;
- first complete product Alpha: after Phase 5 and Gate 1;
- credible market-effect evidence: only after Gate 2/3.

A continuity direction should be visible in roughly 1.5–2.5 focused weeks.
The minimal real learning Gate 0 is roughly a 4–6 week milestone, and a
selector-based Gate 1 is more realistically 6–9 focused weeks. A credible
multi-domain Beta is likely 10–16+ weeks because its calendar is driven by
real-LLM task throughput and the powered sample size. These are not promises:
negative gates deliberately stop the schedule and force repair of the compiler
or selector rather than hiding the result behind more infrastructure.

## 14. Rollback and Protection Strategy

Rollback protects the Execution Memory product, not old implementation
complexity.

### 14.1 Continuity rollback

- preserve the last known-good current-state contract and renderer;
- if a new projection fails, return the preceding bounded current state;
- never fall back to no Aionis or erase episode truth;
- never silently replace current state with full history.

### 14.2 Compiler rollback

- stop the background compiler;
- keep raw L0/L1 episode evidence;
- mark incomplete candidate work as abstained/failed;
- do not delete or corrupt episodes;
- do not expose partially compiled L2.

### 14.3 Skill rollback

- deprecate or quarantine the affected skill version;
- restore the preceding version only if its environment and evidence remain
  compatible;
- preserve counterexample and harm evidence;
- state-only continuity remains available.

### 14.4 Selector rollback

- restore the last held-out-validated L4/L5 artifacts;
- if no safe policy exists, select state-only;
- do not reactivate the old fixed task-rule selector;
- preserve all intervention records for analysis.

### 14.5 Storage rollback

- migrations are additive until Phase 7;
- episode and source evidence remain readable;
- artifact versions are immutable;
- dropping an experimental table is never required to resume continuity;
- existing development data receives explicit migration or remains read-only
  legacy evidence.

## 15. Stop and Rework Criteria

Stop the current algorithm route and revisit the named layer when:

- the semantic compiler repeatedly produces unsupported claims despite bounded
  evidence and abstention instructions;
- candidate skills cannot transfer beyond their source instance;
- helpful transfer does not exceed harmful transfer in Gate 1;
- the selector almost never selects a skill because the compiler creates no
  applicable value;
- the selector frequently selects negative neighbors;
- token cost erases correctness value;
- one domain accounts for all observed uplift;
- a second model cannot reproduce the direction;
- learning requires Runtime source edits after each failed task;
- production entry complexity grows without replacing an old path.

Response:

| Failure | Rework |
|---|---|
| No useful L2 candidates | cohort quality, semantic evidence extraction, compiler prompt/schema |
| L2 looks good but does not transfer | parameterization, boundaries, negative neighbors, held-out validation |
| L3 transfers but selector misses it | compatibility features, value estimation, exploration/calibration |
| Selector helps but costs too much | progressive disclosure, budget model, skill minimization |
| Harm under drift | version features, revalidation, applicability narrowing, forgetting |
| Continuity regresses | current-state projection and precedence only; do not alter the learning system |

Do not respond by adding a task-specific recipe.

## 16. First Executable Implementation Batch

After this plan is accepted, the first implementation batch is:

### Batch A1 — Current-state and cold-evidence correction

1. complete Task 0.1 inventory;
2. implement Task 1.0 semantic observation/decision/progress events;
3. preserve Runtime-owned workspace capture and implement workspace-backed
   `CurrentExecutionStateV2`;
4. add session identity, lease, lineage, revision, and compare-and-swap;
5. make current state a separate always-on AgentContext section;
6. classify shallow L1 artifacts and run a canonical cold-L1 path beside the
   frozen legacy comparison without changing the production default;
7. run the Phase 1A real interruption/resume comparison;
8. report state completeness, authoritative prompt-token accounting, repeated
   exploration, and verifier results.

This batch does not:

- implement the selector;
- add more verifier infrastructure;
- enable ANN;
- change GitHub/CI/release workflows;
- add task recipes;
- delete episode, continuity, recall, feedback, AIFS, Substrate, Manifest, MCP,
  CLI, Create, or ordinary-memory capabilities.

### Batch A1 completion record

The implementation report must contain:

- files changed;
- old and new AgentContext examples from real episodes;
- rendered token values and their measurement authority;
- real task/Agent/model/verifier identities;
- interruption and resume outcomes;
- legacy versus canonical cold-L1 prompt contribution and outcomes;
- semantic-event provenance and session/CAS conflicts observed;
- regressions and unresolved problems.

### Batch A1 execution checkpoint — 2026-07-29

This checkpoint records observed evidence, not a declaration that Batch A1 or
H1 is complete.

#### Real directional panel

- `psf__requests-1963` Episode 1 completed before the interruption boundary and
  is preserved as an `early_complete` attrition result, not used as a
  continuation seed.
- `pallets__flask-4045` produced `cold_restart=failed`,
  `full_history=passed`, and `aionis_state=passed`. Aionis state reached the
  final correct mutation at step 2 and 8,818 Agent tokens, versus full history
  at step 5 and 16,247 Agent tokens. Including the 3,198-token state compiler,
  the Aionis path reached that mutation at 12,016 tokens. It then spent enough
  validation and termination work to finish at 80,383 Agent tokens versus
  34,840 for full history. This is evidence of useful continuity plus an
  unresolved termination-cost defect, not an end-to-end efficiency win.
- `playwright-sync-module-hooks` produced three real verifier failures:
  `cold_restart=false`, `full_history=false`, and `aionis_state=false`. The
  respective Agent-token totals were 620,160, 1,160,447, and 270,967; the
  original state compiler cost 14,397 tokens. Aionis state plus compiler used
  285,364 tokens, 53.99% below cold restart and 75.41% below full history, and
  its 5,076-character state was 86.65% smaller than the 38,028-character full
  history. Because every arm failed, these are compression and cost-direction
  observations only. They are not correctness or product-effect evidence.
- The immutable directional index is
  `/Volumes/ziel/aionis-real-runs/phase1a-directional-panel-20260729.json`.

#### Failure diagnosis and generic correction

The Playwright Aionis arm exposed a product-level truth defect: the old
interruption compiler combined verifier labels and partial source inspection
into a high-confidence architecture guess. The resumed Agent received that
guess as if it were established execution state and mutated early in the wrong
direction. No Playwright, Flask, Requests, repository, command, or expected
patch rule was added to Runtime.

The generic correction is:

1. render model-derived actions as `proposed_next_action`, with an explicit
   epistemic boundary and assumptions that must be checked before mutation;
2. restrict compiler-selected next actions to `inspect` or `verify`;
3. bind every fact, progress item, and proposed action to a deterministic,
   bounded evidence catalog generated from the real task, real tool trace, and
   real workspace authority;
4. have the model cite catalog IDs while deterministic code expands them back
   to exact source references and rejects unsupported anchors, unsupported
   completion/failure claims, and performed-mutation claims without real
   mutation evidence;
5. aggregate state to at most eight facts and eight progress items and sample
   large trace events instead of replaying their full text.

The final same-version calibration results are:

| Real trace | Attempts | Catalog entries | Compiler tokens | Result |
|---|---:|---:|---:|---|
| Requests | 1 | 10 | 3,704 | accepted; inspect-only next action |
| Flask | 1 | 11 | 3,924 | accepted; inspect-only next action |
| Playwright | 1 | 36 | 7,617 | accepted; inspect-only next action |

The final real Runtime + SQLite + SDK integration replay on Flask also passed
on the first model response with 3,229 compiler tokens and delivered a
2,344-character `CurrentExecutionStateV2` prompt. Its receipts are under
`/Volumes/ziel/aionis-real-runs/current-state-runtime-integration-20260729-v5/flask`.

These replays calibrate the mechanism on already observed traces. They do not
prove generalization or improved final correctness.

#### Current gate decision

- At this checkpoint, H1 and H5 were **not passed**. Compact continuity was
  directionally useful, but correctness was mixed and post-mutation
  termination was inefficient.
- The next action was therefore to freeze the corrected compiler and runner,
  prelock one fresh unseen task, and run the same real `cold_restart`,
  `full_history`, and `aionis_state` arms with one model, budgets, tools, and
  verifier. That action has now been completed below.

#### Fresh unseen gate result — Zod JSON Schema pointer escaping

The task `colinhacks-zod-6027` was prelocked before its task body was opened at
`/Volumes/ziel/aionis-real-agent-benchmark/zod-jsonschema-pointer-real-20260729-v1/prelock.json`
against repository head `bbc68f990c7e6a5e3f506c56fb04bd0279b9c9b5`.
Local Kimi performed the required real red/green verifier calibration. Codex
then ran the canonical real DeepSeek `deepseek-v4-flash` interruption/resume
comparison with the same task, tools, step budget, and calibrated external
verifier in all three arms.

Episode 1 stopped after four real Agent steps with a clean workspace and a
failing verifier, so it was a valid interrupted state rather than an
early-complete result. The truth-calibrated compiler was accepted on its second
response, used 10,547 tokens, and rendered a 3,694-character current state. It
reported the clean workspace and verifier failures as facts and proposed a
bounded inspection action; it did not provide the task solution.

| Arm | External verifier | Agent status | Steps | Agent tokens | Delivered continuity context |
|---|---:|---:|---:|---:|---:|
| cold restart | pass | interrupted | 30 | 282,572 | 0 chars |
| full history | pass | interrupted | 30 | 624,997 | 37,347 chars |
| Aionis current state | pass | finished | 26 | 189,677 | 3,694 chars |

Including the 10,547-token compiler cost, the Aionis arm used 200,224 tokens
per verified success. This was 29.14% below cold restart and 67.96% below full
history. Its delivered continuity context was 90.11% smaller than full
history.

The final correct source mutation occurred at:

- cold restart: step 30, after 282,572 Agent tokens;
- full history: step 4, after 64,166 Agent tokens;
- Aionis current state: step 6, after 18,595 Agent tokens, or 29,142 including
  the compiler.

Full history therefore reached a correct mutation first, while Aionis reached
it at lower token cost and completed the run with the lowest end-to-end token
cost. Aionis still spent 20 steps after its final correct mutation, so
termination efficiency remains a generic product defect.

The external verifier passed all three arms. The Aionis arm's original
Runtime-owned finalization receipt failed because the packaged `tsx` process
attempted to create a Unix socket under an overlong scratch path. The verifier
wrapper was corrected to resolve its bound dependency asset root and use
`/tmp` for that socket. A targeted re-verification of the exact saved Aionis
snapshot—without rerunning or changing the Agent result—then passed with:

- content SHA-256
  `b56152b11d583a64488c4d68b2c2dc74b20e2acd7eeff72884f9d947f97e7d6c`;
- verifier receipt
  `evc_f5e99a4b09fd018e43dba554343c68bec0455b44b29b33aa7d47cc15f69c7212`;
- exit code `0`.

All three arms also acquired an unrelated `pnpm-workspace.yaml` `allowBuilds`
mutation while attempting package-manager commands. It was an equal-arm tool
side effect and did not affect verifier correctness, but the generic real-Agent
tool loop must contain command-induced edits outside the task's editable
surface before the next panel.

#### Updated Phase 1A decision

- The **Phase 1A immediate directional progression gate passes**: on a
  prelocked fresh unseen task, current-state Aionis preserved full-history
  correctness, finished within budget, and lowered tokens per verified success
  after compiler cost.
- Product-wide **H1 remains unconfirmed**. One fresh unseen task plus the
  earlier mixed directional panel is not enough to establish broad continuity
  correctness.
- Product-wide **H5 remains unconfirmed**. This run is the first clean positive
  end-to-end efficiency result, not a multi-task or cross-domain estimate.
- Do not add a Zod, repository, pointer-escaping, package-manager, or benchmark
  rule to Runtime Core.
- Do not start selector implementation from this single result. Proceed only
  to the already-declared generic dependency, Task 1.6A, while preserving this
  exact canonical run as the migration non-regression reference.

#### Task 1.6A execution record — workspace subject V2

The workspace path now implements the generic `SubjectStateAdapter` contract
without changing the existing workspace capture or verifier authority.
`ExecutionSubjectV1`, `StateSnapshotV2`, and `StateDeltaV1` are Runtime-owned
contracts; the adapter registry resolves a versioned subject implementation,
and episode capture, replay, current state, verifier materialization,
transport, and the standalone SDK all carry the same subject and state
identity. The V2 snapshot remains a projection over the one authoritative
persisted workspace snapshot and artifact; no second state store was added.

Migration non-regression was run against the exact saved successful Aionis
workspace from the fresh Zod panel. The Runtime-owned verifier passed at:

`/Volumes/ziel/aionis-real-runs/zod-subject-v2-migration-reverification-20260729-v4`

with:

- SDK handle `aionis_execution_episode_handle_v2`;
- adapter `workspace_subject_v2` version `1`;
- full SDK-visible `state_snapshot_v2`;
- unchanged verified content SHA-256
  `b56152b11d583a64488c4d68b2c2dc74b20e2acd7eeff72884f9d947f97e7d6c`;
- verifier receipt
  `evc_4630508b68ca329871714581ab9e5a157666f29929eb3ca0f24d7aa60f3c9f0b`.

The required live path was then exercised with real DeepSeek
`deepseek-v4-flash`, real repository tools, the calibrated external verifier,
the public AgentSession SDK, durable SQLite, a fresh Runtime process after
interruption, and the Runtime-owned executable verifier. The accepted evidence
is under:

`/Volumes/ziel/aionis-real-runs/zod-subject-v2-real-agent-migration-20260729-v3`

The resumed real Agent used 12 actions and 81,996 model tokens. Runtime
recorded two genuine `state_delta_v1` receipts rather than inferring mutation
from host claims. The production-source delta identified
`packages/zod/src/v4/core/to-json-schema.ts`; a later package-manager command
also changed `pnpm-workspace.yaml`, and the generic adapter recorded that
unrelated side effect instead of hiding it. Before restart and after resume:

- execution-subject identity was identical;
- current V2 snapshot ID and content SHA-256 were identical;
- the external task verifier passed;
- the resumed Runtime-owned verifier passed with receipt
  `evc_6c10c62e5d9b14038e0defb12b14ff47980a811d00f2a8c50dbe9251db41b9b8`;
- verified content SHA-256 was
  `a5ba28732b968961839578964b97be4a15e1f1d9153108babd57707ac230878c`;
- the episode closed successfully.

Two earlier bounded attempts remain negative evidence rather than product
claims. Splitting the Agent into disconnected eight-step conversations
produced no mutation. A continuous fourteen-step attempt produced two real
deltas but stopped with an incomplete task mutation and failed the external
verifier. The accepted continuation began from that exact real partial
workspace; it did not receive the task answer or create any Runtime rule.

A contamination scan over `src/` found none of the task, repository, expected
answer, or pointer-escaping literals. This evidence therefore closes the
workspace portion of Task 1.6A; it does not claim cross-domain adapter
generality, which remains Task 1.6B.

#### Task 1.6B execution record — structured-artifact and SQLite subjects

The frozen subject-V2 contract now has two additional real implementations:

- `structured_artifact_subject_v1` captures a whole JSON artifact, preserves
  the exact authoritative bytes, reports JSON-pointer state deltas, and
  materializes `artifact.json` for an independent verifier;
- `sqlite_database_subject_v1` uses SQLite online backup for a consistent
  whole-database snapshot, preserves the authoritative database bytes,
  reports deterministic schema/table deltas, and materializes
  `database.sqlite` for an independent verifier.

Both implementations use the same Runtime-owned subject identity, snapshot,
delta, episode, replay, verifier-binding, and artifact authority as the
workspace adapter. Adapter selection changes state capture, comparison, and
materialization only. It does not change episode truth or verifier semantics,
and neither adapter contains a task answer, task name, repository rule, or
solution policy. The Runtime registry now resolves all three implementations.
The public SDK carries the generic subject-state spec; its existing
`workspace_root` field temporarily serves as the local subject locator for
both directory and file subjects and should be renamed in a later
contract-cleanup task without creating a second authority.

The accepted real-Agent evidence is under:

`/Volumes/ziel/aionis-real-runs/subject-adapters-v1-real-20260729-v4`

The runner used the standalone public SDK, real DeepSeek
`deepseek-v4-flash`, real JSON/SQLite tools, durable Runtime SQLite, a complete
Runtime process restart, a serialized/resumed session handle, fresh model
conversations after restart, executable external verifiers, and the
Runtime-owned executable verifier.

For the structured artifact:

- the same episode, subject, continuation, session, current snapshot, and
  content SHA-256 survived the process boundary;
- Runtime persisted a genuine mutation delta from
  `ess2_f6cdc5b8e4743e4d30f04011f2511cf5920658bae5d3a188e5476740e89c79c9`
  to
  `ess2_01adaadddd4e35180926f77fbc906431a5b18517b54d58a89664d07949cfe58e`
  with changed field `json:/release_plan`;
- the resumed Agent completed, the external verifier passed, and the
  Runtime-owned verifier passed with receipt
  `evc_8697413f66e34e2bf4e44835c19e746c308001ee2f08c1cc9cdf96226992c05f`;
- the episode closed successfully.

For the SQLite database:

- the same episode, subject, continuation, session, current snapshot, and
  content SHA-256 survived the process boundary;
- Runtime persisted three genuine mutation deltas. The first identified the
  new `allocations`, `fulfillment_plan`, and `inventory_balance` schema and
  table state; the two resumed mutations identified subsequent content
  changes to those same tables;
- the final snapshot was
  `ess2_72874a64e7e1d0dc1d789f632a4f5b00aa44b175c02521e4897a5d1555638a29`;
- the external verifier passed, and the Runtime-owned verifier passed with
  receipt
  `evc_01721746a41c6d935af79410d5d270ad27ed135eb989ffaef18b8f7cd47c7ec8`;
- the episode closed successfully.

The database Agent reached the verifier-correct final state but exhausted its
bounded action budget without emitting its explicit `finish` signal. This is
retained as negative evidence about Agent termination efficiency; it does not
change the independently verified task outcome.

Three earlier attempts remain negative evidence. The first exposed an
under-specified Eval output contract. The second exposed a literal-placeholder
defect in the Eval host tool example. The third passed the external verifier
but exposed a real generic Runtime integration defect: verifier launch still
required the live subject locator to be a directory. The Runtime authority was
fixed to require a directory for workspace subjects and a regular file for
artifact/database subjects; no task-specific rule was added.

The final structural checks passed:

- Runtime typecheck and build;
- Runtime-to-standalone-SDK contract synchronization check;
- standalone SDK build;
- syntax checks for the real runner and both executable verifiers;
- a fixed-string contamination scan over Runtime `src/`, with no Eval task,
  repository, answer, or solution literals found.

Together with the accepted workspace migration evidence from Task 1.6A, this
passes the Phase 1B cross-domain readiness gate for the three implemented
subject types. It establishes portable continuity, state truth, and verifier
binding across workspace, structured-artifact, and SQLite subjects. It does
not by itself establish broad task-correctness, skill-learning, or token
efficiency claims.

#### Task 2.0 execution record — real episode cohort packs

Task 2.0 now has three sealed, content-addressed mechanism packs backed only
by real Agent episodes and independent verifier outcomes. The Runtime-owned
portable contract and SQLite export/import adapter are implemented in:

- `src/memory/real-episode-cohort-pack.ts`;
- `src/store/lite-real-episode-cohort-pack.ts`.

The exporter replays the authoritative episode chain and accepts only a
closed `verified_pass` or `verified_failure` with one bound verifier receipt
and one exact cost receipt. It resolves every transitive Runtime evidence
artifact from the SQLite CAS. The sealer binds immutable split membership,
model/tool/environment identity, adapter versions, acquisition dependencies,
provenance, and a coherent backup of the source Runtime SQLite database. The
importer resolves and hashes every dependency before reconstructing the
episode, verifier outcome, and cost projection; it does not trust a supplied
outcome enum or split label.

Additional real acquisition used DeepSeek `deepseek-v4-flash`, public
AgentSession transport, real JSON/SQLite tools, complete Runtime restarts, an
external executable verifier, and the Runtime-owned executable verifier. The
accepted runs are:

- `/Volumes/ziel/aionis-real-runs/real-cohort-acquisition-20260729-v2`
  for incident-response and manufacturing structured artifacts;
- `/Volumes/ziel/aionis-real-runs/real-cohort-acquisition-20260729-v5`
  for maintenance and reservation SQLite databases.

All four new episodes closed as `verified_pass`. During acquisition, a real
artifact transition returned from state A to an already-recorded state A
after visiting state B. This exposed a generic state-reversion defect: the
service attempted to attach a second evidence identity to the same
content-addressed snapshot. The Runtime now reuses the exact prior snapshot
and evidence identity when a captured state already exists. A separate real
SQLite run exposed that opening a WAL-mode materialized database read-only can
still create `-shm` and `-wal` files. The reusable SQLite verifiers now use
SQLite immutable read mode, preserving the verifier subject without changing
Runtime outcome semantics. Neither fix added a task, repository, table,
answer, or solution rule.

The source catalog and generic acquisition/seal/import tools are under:

`/Volumes/ziel/new.aionis/AionisRuntime-evals/benchmarks/real-episode-cohort-packs-v1`

The sealed output is:

`/Volumes/ziel/aionis-real-packs/task2.0-20260729-v1`

It contains one shared CAS with 1,142 objects and 171,119,032 bytes. Ten unique
real episodes are represented across thirteen pack memberships: eight
verified passes and two verified failures. The three pack roots are:

- `workspace-repository-continuity-v1`
  — `a4e14cbe4a4f56c423a2558498925ed80bcca9318d66d41a0a1d1542eef04e79`;
- `structured-schedule-artifact-v1`
  — `a55c1a8aaf88eeca02851ec585c08aee694f489966969dd2c4bc79126bab5418`;
- `sqlite-allocation-v1`
  — `e5bba0e2c19089d189e48e61b29471a4fcc35b9423864cdd078c79b87d068b7b`.

Every pack has sealed training, development, held-out, and
negative-neighbor membership. The workspace pack additionally contains a
same-cluster real success/failure pair. The artifact and SQLite packs each
carry a real verified failure as negative-neighbor evidence. Task answers and
verifier oracles remain Eval artifacts; none were moved into Runtime Core.

Each pack was imported by a separate Runtime-source process into its own empty
reconstruction directory. All thirteen episode/outcome/cost projections were
recreated, and every canonical root digest reproduced exactly. Against each
real pack, the importer also rejected:

- a missing source-authority artifact;
- changed artifact bytes under an existing digest;
- one task cluster crossing sealed splits;
- a verifier receipt rebound to the wrong real episode.

Runtime typecheck and strict TypeScript checks for both pack tools pass. These
packs close Task 2.0 and provide the actual success, failure, held-out, and
negative-neighbor inputs required by the compiler phase. They do not yet
prove learned-skill lift, token efficiency, or broad task generalization;
those remain properties of Tasks 2.1 through 2.4 and the later real-Agent
gates.

#### Task 2.1 execution record — canonical learning contracts

Task 2.1 now has one Runtime-owned, bounded semantic contract for the
Execution Memory learning path. The canonical source is:

- `src/memory/execution-skill.ts`.

It defines the portable forms required by Sections 8.4 through 8.8:

- verified episode capsules and bounded feature projections;
- reproducible experience cohorts;
- a bounded predicate and operand algebra;
- versioned capability descriptors;
- parameter declarations, binding expressions, and immutable binding
  receipts;
- procedure steps, transitions, invocation receipts, recovery branches,
  termination conditions, and first-class verification;
- L2 procedure hypotheses, fixed validation protocols, validation receipts,
  L3 validated skills, and lifecycle receipts.

The contract enforces the following critical boundaries structurally rather
than relying on a compiler prompt:

- reusable procedure operands and capability inputs may contain parameter or
  feature references, but not instance literals;
- evidence and immutable binding receipts may retain instance values;
- predicate depth, node count, child count, string size, collection size,
  procedure size, and evidence size are bounded;
- every referenced parameter, capability, transition, recovery target, and
  termination condition must exist;
- recovery branches must reach a bounded `stop` or `handoff` termination path,
  not only a success condition;
- applicability, non-applicability, decisive observations, discriminating
  checks, failure modes, verification, and termination are first-class;
- L2 candidates are literally non-production artifacts;
- L3 identity binds the exact admitted L2 procedure content;
- lifecycle transitions and immutable successor versions are explicit and
  content-addressed.

`src/memory/layer-policy.ts` now applies those lifecycle rules to delivery.
L1 evidence is never directly delivered. An L2 hypothesis may appear only
inside its frozen paired-validation block after entering `in_validation`.
Rejected or contested hypotheses receive no placement. A validated L3 skill
may receive normal `use_now` placement, while a limited skill additionally
requires a compatible controlled-development scope. This is a delivery
boundary, not an effect claim.

`src/memory/schemas.ts` re-exports the canonical contract instead of copying
it. `scripts/generate-execution-skill-schema.ts` deterministically derives 28
portable JSON Schema contracts under:

`contracts/execution-skill/v1`

Each schema is stored by its SHA-256 content identity. The exact file set,
bytes, per-contract hashes, and root digest are checked by the generator. The
current schema-set digest is:

`3c88abb93e00d3eec385b44e74d8517107baade2f8224f9f1da253ec5826559f`

The real verification runner is deliberately outside Runtime Core:

`/Volumes/ziel/new.aionis/AionisRuntime-evals/benchmarks/execution-skill-contract-v1/compile-and-validate-real-candidate.mts`

It resolved the three sealed Task 2.0 packs from their shared CAS and supplied
DeepSeek `deepseek-v4-flash` with three genuine verified successes across
workspace, structured-artifact, and SQLite subjects, one related verified
failure, and one disjoint negative neighbor. It read the real action
requests/results, state deltas, verifier receipts, and content-addressed
evidence rather than substituting synthetic outcomes. Task and answer leakage
checks remain in Evals; no repository, task, table, test, answer, or solution
switch was added to Runtime.

The accepted verification output is:

`/Volumes/ziel/aionis-real-packs/task2.1-20260729-v8`

Its bound identities are:

- pack-set SHA-256
  `bce7cd6d9ac9b26b578a2e39acef0fecabc7e1f7751061432a921dade1cd3d0d`;
- hypothesis
  `eph_3b10a52103f9952aa1c572f3d871a2d434e1ca252e3821bb65a1aae65a065658`;
- hypothesis content SHA-256
  `010d67e971fe2cd9331034bb98e487aa4572e003c8aec94525a60c7b15cdfd20`;
- compiler prompt SHA-256
  `9670a68d28c12a7324d4ccba2b94694eb50c0cf35b55ce119362bda0b2a60e08`.

The final procedure is a parameterized, verifier-driven correction loop. It
does not contain a source repository, file, test, table, answer, or task
identity. It binds the goal, subject, verifier, proposed change, and latest
observation as parameters; requires inspect/read/apply/verify/analyze
capabilities; and retains explicit non-applicability, stop, and recovery
conditions. It passed:

- the Runtime contract;
- the Eval-owned instance-leak scan;
- the generic semantic-transfer audit;
- all seven deliberate invalid-candidate rejections.

The rejected mutations covered an instance literal in a reusable step,
missing first-class verification, missing non-applicability, an L2 candidate
marked production-eligible, a content-digest mismatch, an undeclared
capability, and an unknown parameter binding. Delivery-policy verification
also returned no normal-production placement for the candidate and
`validation_only` placement for its paired block.

The real compiler iterations before the accepted output were retained because
they exposed contract defects rather than benchmark-specific exceptions:

- early real responses abstained or produced task-bound procedures, showing
  that prompt success cannot substitute for a structural transfer contract;
- a real candidate required boolean state predicates, leading to generic
  `is_true` and `is_false` operations rather than schema literals;
- invalid-candidate testing exposed digest refinements that could throw
  instead of returning a normal validation failure; nested material is now
  safely parsed before digest comparison;
- a task-bound candidate passed the first identity scan, leading to an
  Eval-only semantic shingle scan over source task and change evidence;
- an unbounded cross-subject prompt exceeded the real provider transport
  envelope, leading to deterministic evidence bounding without changing
  content identities;
- a structurally valid candidate attempted to require `state_changed` before
  its first mutation and had success-only recovery, leading to a generic
  semantic audit and bounded stop/handoff recovery invariant.

The accepted v8 run used the recorded real v7 compiler response as a seed and
made one real DeepSeek correction attempt. The runner canonicalized only
semantic set ordering and recomputed identities; it did not invent procedure
steps, boundaries, or verification logic.

The completed checks are:

- Runtime `npm run typecheck`;
- deterministic `npm run execution-skill:schema:write`;
- exact `npm run execution-skill:schema:check`;
- strict standalone TypeScript compilation of the real verification runner;
- a fixed-string contamination scan over the new Runtime source and generated
  contracts, with no Eval task, repository, answer, or solution identities
  found.

Task 2.1 therefore proves that real heterogeneous episodes can produce a
portable L2 hypothesis which the Runtime can identify, bind, isolate, and
reject when malformed. It does **not** prove that the hypothesis improves
Agent correctness, saves tokens, or generalizes to held-out tasks. Those
claims require Task 2.2 execution, Task 2.4 reproducible cohorts, and the
later real-Agent effect gates. No GitHub, CI, release, UI, ANN, or production
hardening work was performed in this task.

## 17. Definition of Done

Aionis vNext is complete only when all of the following are true.

### 17.1 Product behavior

- a fresh install exposes one coherent product loop;
- current execution state is always available during an active task;
- interruption, handoff, restart, Agent change, and model change preserve
  execution continuity;
- ordinary memory, rehydrate, feedback, and lifecycle capabilities remain
  usable;
- real verified episodes can produce L2 hypotheses;
- held-out real tasks can promote useful L3 skills;
- adaptive delivery can select or abstain;
- real outcomes change future memory behavior;
- stale/harmful skills narrow, split, deprecate, or revalidate;
- SDK, MCP, and AIFS expose the same semantic state;
- Substrate and Manifest have one unambiguous role each.

### 17.2 Algorithm behavior

- compiler reads action request/result and state deltas;
- failure and negative-neighbor evidence are first-class;
- L2 cannot directly enter production prompts;
- L3 requires held-out incremental value;
- L4 estimates contextual value and uncertainty;
- L5 controls use, budget, consolidation, and forgetting;
- state-only is a first-class choice;
- exact task/repository identity is not the transfer gate;
- task-specific product rules equal zero.

### 17.3 Effect evidence

- final-code Continuity Confirmatory passes;
- learning Gate 3 passes for the declared scope;
- harmful-transfer and token gates pass;
- cross-repository result passes before cross-repository claim;
- second-model Gate 4A passes before any claim of transfer across the tested model
  families; a broader model-independence claim requires a separately
  predeclared multi-family panel;
- Gate 4B passes before any controlled-drift/self-learning claim;
- all evidence comes from real LLMs, tools, tasks, state, and verifiers;
- raw artifacts and costs are retained.

### 17.4 Complexity

- one current-state compiler;
- one skill compiler;
- one final selector;
- one context renderer;
- one feedback/value loop;
- production Runtime source and entry closure reach the Phase 7 targets or have
  a documented, effect-backed exception;
- fixed evaluation orchestration is outside the daemon;
- no duplicate product brain remains in SDK, MCP, AIFS, Substrate, or Manifest.

### 17.5 Product truth

Documentation states only effects whose gates passed. Historical continuity or
context-compression evidence is not misrepresented as learned correctness.
Directional Alpha evidence is not marketed as confirmed breakthrough.

## 18. Decision Register

### D1 — Aionis remains complete Execution Memory

Continuity, compression, learning, forgetting, and controlled memory use remain
one product. Adaptive skill selection does not replace the product identity.

### D2 — Continuity is always on and orthogonal to L0-L5

Current execution state is produced for every active task. L0-L5 describe the
learning path from raw evidence to meta-policy.

### D3 — Raw success is not a skill

L0/L1 preserve truth. Only held-out-validated L3 can enter normal `use_now`.

### D4 — Real external outcome owns product reward

Internal memory counts and guide fields remain diagnostics.

### D5 — Retrieval generates candidates; value selects

Semantic, lexical, graph, and ANN retrieval do not authorize direct use.

### D6 — State-only is a first-class intervention

It is the learning control and the safe selector abstention result, not a
different product.

### D7 — Manifest is an optional execution form

Manifest represents deterministic executable procedures where suitable. It
does not constrain all learned skills to static workflows.

### D8 — Runtime remains the authority

Substrate, AIFS, MCP, SDK, and Manifest do not create additional selection or
truth authorities.

### D9 — Inspectable artifact learning comes first

Use inspectable skill artifacts and a reproducible local contextual value model
before considering foundation-model weight training.

### D10 — Replace before deleting

Every major deletion names its replacement and real-effect comparison.

### D11 — No task becomes product code

Tasks produce episodes, candidates, counterexamples, value updates, and
evaluation evidence only.

## 19. Research Basis and Direct Application

This plan uses research as algorithm input, not as a substitute for Aionis
evidence.

### Agent Workflow Memory

[Agent Workflow Memory](https://arxiv.org/abs/2409.07429) demonstrates
trajectory-derived reusable workflows, selective injection, and cross-task/
site/domain gains.

Applied here:

- cohort-based workflow induction;
- separation of instance details from reusable routines;
- selective, compact delivery.

Not copied:

- web-only assumptions;
- unconditional use of natural-language workflow text.

### ProcMEM

[ProcMEM](https://arxiv.org/abs/2602.01869) formalizes procedural memory with
activation, execution, and termination and uses non-parametric policy
improvement.

Applied here:

- L2/L3 applicability, procedure, termination, and validation;
- versioned non-parametric skills;
- compact memory and score-based maintenance.

Not copied:

- any benchmark-specific action ontology;
- a new policy system disconnected from Aionis episodes.

### SkillGen

[SkillGen: Verified Inference-Time Agent Skill Synthesis](https://arxiv.org/abs/2605.10999)
uses successful and failed trajectories for contrastive induction and compares
the same instances with and without a skill to count repairs and regressions.

Applied here:

- success/failure/negative-neighbor cohorts;
- intervention-based L3 validation;
- helpful and harmful transfer accounting.

### Experience-following and memory harm

[How Memory Management Impacts LLM Agents](https://aclanthology.org/2026.acl-long.27/)
shows that similarity-driven experience following can propagate errors and
replay apparently correct but misaligned experience.

Applied here:

- similarity cannot authorize use;
- non-applicability and counterexamples are first-class;
- selector estimates negative transfer;
- future task outcomes update memory quality.

### Adaptive memory distillation

[What Deserves Memory](https://aclanthology.org/2026.acl-long.1607/) treats
retention value as a data-driven future-utility problem rather than fixed
importance templates.

Applied here:

- value-driven L4/L5 and forgetting;
- prediction of future usefulness;
- removal of fixed retention thresholds.

### Dynamic procedural refinement

[Remember Me, Refine Me](https://aclanthology.org/2026.findings-acl.829/)
combines contrastive distillation, context-adaptive reuse, and utility-based
refinement.

Applied here:

- versioned revision, split, merge, and deprecation;
- scenario-aware compatibility;
- compact high-value skill pool.

### Adaptive memory budget

[ElasticMem](https://arxiv.org/abs/2605.30690) directly optimizes adaptive
retrieval and memory budget against downstream reward and token cost.

Applied here:

- utility-minus-cost selection;
- variable delivery budget;
- progressive disclosure.

Not copied:

- dependence on latent memory or trainable model weights.

### Procedural transfer evaluation

[AFTER](https://arxiv.org/abs/2606.23127) evaluates local, cross-task,
cross-role, and cross-model procedural-memory transfer on realistic enterprise
tasks.

Applied here:

- transfer ladder and model-agnostic architecture/empirical claim boundary;
- held-out cross-context validation;
- multi-model episode diversity.

### Skill token efficiency

[SkillReducer](https://arxiv.org/abs/2603.29919) reports that removing
non-actionable skill content can improve both token efficiency and functional
quality.

Applied here:

- one primary skill;
- actionable core before references;
- progressive disclosure;
- authoritative skill token accounting with explicit measurement source.

## 20. Final Plan Decision

Aionis should continue, but implementation must change direction now.

The existing continuity, episode, state, evidence, recall, feedback, lifecycle,
UseNow, SDK, AIFS, Substrate, MCP, CLI, Create, and Manifest capabilities are
the substrate of the product and are not discarded.

The next product work is not another governance layer, experiment authority,
task recipe, ANN optimization, release workflow, or infrastructure expansion.
It is:

```text
always-on current execution state
+ real semantic episode understanding
+ contrastive transferable procedure learning
+ held-out real-task validation
+ learned use/no-use and token budgeting
+ real-outcome consolidation and forgetting
+ one integrated Agent product loop
```

The first implementation action after this plan is Task 0.1 followed by Batch
A1. No later phase should begin early merely because it is easier to implement.

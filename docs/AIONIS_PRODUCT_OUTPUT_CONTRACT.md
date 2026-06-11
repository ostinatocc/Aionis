# Aionis Product Output Contract

Status: implemented product output contract

This document defines the stable product outputs Aionis should converge toward. It does not add routes, mechanisms, or tests by itself.

Aionis is not recall memory; it is a state-adjudicated memory runtime. It does
not push history straight into the LLM: it governs memory state first, then
compiles bounded context. Its core moat is execution memory: auditable,
forgettable, and reusable operational experience for Agents.

The executable schema contract lives in `src/memory/product-output-contract.ts`.
The pure assembler from current Runtime summaries lives in `src/memory/product-output-assembler.ts`.
The current Runtime route integration exposes `aionis_guide_packet` from:

1. `POST /v1/memory/planning/context`
2. `POST /v1/memory/context/assemble`

The current Runtime route integration exposes `aionis_learning_packet` from:

1. `POST /v1/memory/planning/context`
2. `POST /v1/memory/context/assemble`

The current Runtime recall integration exposes `aionis_memory_packet` from:

1. `POST /v1/memory/recall`
2. `POST /v1/memory/recall_text`
3. `POST /v1/memory/planning/context` under `recall.aionis_memory_packet`
4. `POST /v1/memory/context/assemble` under `recall.aionis_memory_packet`

The current measurement implementation lives in `src/kernel/effect-evaluator.ts` and
`src/memory/product-output-assembler.ts`. External benchmark adapters must live outside
this focused Runtime product tree.

The goal is to stop exposing dozens of internal Runtime routes as product concepts. Aionis should produce clear outputs that users and Agents can understand:

1. `AionisAgentContext`: the compact default context an Agent should consume
2. `AionisGuidePacket`: the auditable structured guide behind the compact context
3. `AionisMemoryPacket`: which general or execution memories are relevant, trusted, stale, contested, or behavior-shaping
4. `AionisLearningPacket`: which learning candidates are visible, constrained, promotion-ready, or blocked
5. `AionisEffectReport`: whether history helped, hurt, or did nothing
6. `AionisMemoryDecisionTrace` and `AionisMemoryDecisionAuditReport`: operator/debug outputs explaining memory decisions without entering the Agent prompt
7. `AionisMemoryUseReceipt`: a compact read-only receipt of which memory was used, inspected, blocked, rehydrated, attributed, or left unattributed
8. `AionisJudgmentCalibrationSummary`: a compact read-only calibration summary of which memory judgments were supported, contradicted, unused, weak, or inconclusive
9. `AionisOperatorSnapshot`: a read-only operator projection of execution state, memory use, judgment calibration, learning control, effect, and Trace-to-Procedure readiness

## Output Boundary

| Output | Product Action | Purpose |
|---|---|---|
| `AionisAgentContext` | `guide` | Give the Agent a short, directly consumable context with authority, risk, memory IDs, and rehydration hints. |
| `AionisGuidePacket` | `guide` | Preserve the structured, auditable guide behind the compact Agent context. |
| `AionisMemoryPacket` | `recall` | Convert ordinary and execution recall into an evidence-scoped cognitive memory packet. |
| `AionisLearningPacket` | `learn` | Convert learning, promotion, demotion, forgetting, and learning-control signals into a scoped learning state packet. |
| `AionisEffectReport` | `measure` | Prove whether historical memory changed the run and whether that change was positive. |
| `AionisMemoryDecisionTrace` | `debug` / `measure` | Explain per-memory use, downgrade, block, and rehydrate decisions. |
| `AionisMemoryDecisionAuditReport` | `audit` / `measure` | Provide a compact operator review of memory decisions, risks, and claims. |
| `AionisMemoryUseReceipt` | `debug` / `measure` / `snapshot` | Show exactly what memory was exposed or blocked without adding prompt content or mutating runtime state. |
| `AionisJudgmentCalibrationSummary` | `debug` / `measure` / `audit` / `snapshot` | Summarize whether exposed memory judgments were supported, contradicted, unused, weak, or inconclusive without changing authority. |
| `AionisOperatorSnapshot` | `snapshot` | Show read-only execution state, trace-to-procedure readiness, judgment calibration, learning control, effect, and claims for hosts/operators. |

`POST /v1/guide` defaults to `AionisAgentContext` only. Callers that need audit or measurement data must set `include_packets: true` to include `memory_packet` and `guide_packet`. Full packets are not the default Agent prompt surface.

The prompt/debug boundary is defined in [AIONIS_AGENT_CONTEXT_AND_AUDIT_SURFACES.md](AIONIS_AGENT_CONTEXT_AND_AUDIT_SURFACES.md). `memory_decision_trace`, `memory_decision_audit`, `memory_use_receipt`, and `judgment_calibration_summary` are never Agent prompt surfaces.

Concrete product API usage for `observe`, `guide`, `feedback`, `measure`,
`rehydrate`, and `snapshot` is defined in
[AIONIS_PRODUCT_API_USAGE.md](AIONIS_PRODUCT_API_USAGE.md).
Sparse feedback candidate learning-control boundaries are defined in
[SPARSE_FEEDBACK_LEARNING_CONTROL_GATE.md](SPARSE_FEEDBACK_LEARNING_CONTROL_GATE.md).
Sparse feedback confidence decay boundaries are defined in
[SPARSE_FEEDBACK_CONFIDENCE_DECAY_GATE.md](SPARSE_FEEDBACK_CONFIDENCE_DECAY_GATE.md).
That surface can expose read-only temporal staleness candidates, but it never
changes guide authority or memory lifecycle by itself.

`observe` and `forget` remain product actions, but their first product-visible value should flow into these outputs:

1. `observe` produces general and execution evidence that later appears in memory/guide/learning/effect fields.
2. `forget` changes lifecycle and suppression state that later appears in memory/guide/learning/effect fields.

## AionisMemoryUseReceipt

The memory use receipt is the stable audit projection for "what Aionis actually
did with memory in this run." It is derived from `memory_decision_trace` when a
trace exists, and from `agent_context`/`guide_packet` when an operator snapshot
is built without a trace. It is not an Agent prompt surface and cannot mutate
runtime state.

The receipt maps directly onto existing Runtime concepts:

| Concept | Current Product Surface |
|---|---|
| Memory Use Receipt | `memory_decision_trace.memory_use_receipt`, `operator_snapshot.memory_use_receipt` |
| Premise Firewall | `risk_flags`, `inspect_before_use_memory_ids`, `do_not_use_memory_ids`, `read_only_signal_memory_ids` |
| Trace-to-Procedure Compiler | `operator_snapshot.trace_to_procedure`, derived from `execution_tree_v1`, workflow projection, replay playbook, execution contract, `memory_decision_trace`, and promotion evidence |
| Memory Contract | `relevant_memories[].memory_contract`, `agent_context.risk.reasons`, `memory_decision_trace.reason_codes`, `memory_use_receipt.decision_summaries`, `memory_use_receipt.risk_flags` |

### Shape

```ts
type AionisMemoryUseReceipt = {
  contract_version: "aionis_memory_use_receipt_v1";
  intended_use: "memory_use_audit";
  agent_prompt_included: false;
  runtime_mutation: false;
  guide_trace_id: string | null;
  history_used: boolean;
  actionable_history_used: boolean;
  prompt_char_count: number;
  exposed_memory_ids: string[];
  use_now_memory_ids: string[];
  inspect_before_use_memory_ids: string[];
  do_not_use_memory_ids: string[];
  rehydrate_memory_ids: string[];
  attributed_memory_ids: string[];
  unattributed_recalled_memory_ids: string[];
  read_only_signal_memory_ids: string[];
  decision_summaries: Array<{
    memory_id: string;
    agent_surface: "use_now" | "inspect_before_use" | "do_not_use" | "rehydrate" | "not_agent_facing";
    decision_kind: "used" | "downgraded" | "blocked" | "rehydrate" | "not_agent_facing";
    actionable: boolean;
    reason_codes: string[];
  }>;
  risk_flags: string[];
  summary: string;
};
```

### Receipt Rules

| Include | Exclude |
|---|---|
| memory IDs exposed through `use_now`, `inspect_before_use`, `do_not_use`, or `rehydrate` | raw memory rows or raw slots |
| feedback attribution and unattributed recalled IDs | full prompt text or hidden trace internals |
| compact decision summaries with surface and reason codes | raw memory text, raw slots, or full trace internals |
| read-only risk/sparse feedback signals | runtime mutation, suppression, archive, or promotion actions |
| prompt character count and `actionable_history_used` | claims that a memory was useful unless feedback attribution says so |

## AionisJudgmentCalibrationSummary

The judgment calibration summary is the first implemented Judgment Ledger
projection. It is derived from `memory_decision_trace`, not from a new store. It
does not persist new authority, does not change ranking, and does not enter the
Agent prompt.

Current surfaces:

| Surface | Field |
|---|---|
| Trace | `memory_decision_trace.judgment_calibration_summary` |
| Audit | `memory_decision_audit.judgment_calibration_review` |
| Snapshot | `operator_snapshot.judgment_calibration` |

### Shape

```ts
type AionisJudgmentCalibrationSummary = {
  contract_version: "aionis_judgment_calibration_summary_v1";
  intended_use: "judgment_calibration_audit";
  source: "memory_decision_trace";
  agent_prompt_included: false;
  runtime_mutation: false;
  authority: "read_only";
  window: {
    record_count: number;
    anchored_count: number;
    weak_count: number;
    unused_count: number;
    inconclusive_count: number;
  };
  supported_memory_ids: string[];
  contradicted_memory_ids: string[];
  weak_memory_ids: string[];
  unused_memory_ids: string[];
  inconclusive_memory_ids: string[];
  buckets: Array<{
    bucket: string;
    record_count: number;
    supported_count: number;
    contradicted_count: number;
    weak_count: number;
    unused_count: number;
    inconclusive_count: number;
    memory_ids: string[];
    recommended_adjustment:
      | "keep"
      | "rank_up"
      | "rank_down"
      | "inspect_first"
      | "needs_more_evidence";
    authority: "read_only";
    reason: string;
  }>;
  reason: string;
};
```

### Calibration Rules

| Input Evidence | Calibration Output |
|---|---|
| host-marked used memory with positive feedback | `supported_memory_ids` |
| host-marked used memory with threshold-met or strong negative evidence | `contradicted_memory_ids` |
| single weak negative feedback below threshold | `weak_memory_ids` and `inconclusive_memory_ids` |
| recalled memory not marked as used in feedback | `unused_memory_ids` |
| no feedback attribution | `inconclusive_memory_ids` |

`unused` is not negative feedback. Weak negative feedback is not authority
mutation. The summary may recommend `inspect_first` or `needs_more_evidence`,
but those are read-only audit recommendations until existing lifecycle,
authority, and learning-control gates accept separate evidence.

## Premise Firewall

The first implemented Premise Firewall is a guide-stage projection, not a new
Runtime subsystem and not a hard Agent interceptor. It checks the current guide
query against recalled memory and accepted lifecycle relation evidence. When
the query appears to carry an old, blocked, contested, or superseded premise,
Aionis keeps the warning on existing product surfaces:

1. `agent_context.risk.reasons`
2. `agent_context.inspect_before_use`
3. `agent_context.do_not_use`
4. `memory_decision_trace.memory_decisions[].reason_codes`
5. `memory_decision_trace.memory_use_receipt.risk_flags`
6. `source_map.internal_surfaces_used`

Current implemented reason codes:

| Reason | Meaning | Agent Surface |
|---|---|---|
| `premise_firewall_query_conflicts_with_current_memory` | The query mentions a memory that accepted lifecycle evidence says is contradicted or superseded by newer/current memory. | `inspect_before_use` |
| `premise_firewall_query_mentions_blocked_memory` | The query mentions suppressed, archived, or blocked memory. | `do_not_use` |
| `premise_firewall_query_mentions_uncertain_memory` | The query mentions candidate, contested, demoted, or rehydration-candidate memory. | `inspect_before_use` |

The product behavior is advisory. The Agent is told to inspect or avoid the
premise, but Aionis does not rewrite the task, execute a repair, or mutate
memory lifecycle from this signal alone.

## Memory Contract

The implemented Memory Contract is a read-only projection on each
`AionisMemoryPacket.relevant_memories[]` entry. It does not replace existing
authority, lifecycle, scope, or evidence gates. It makes those gates explicit
before `agent_context` is compiled.

Current contract fields:

```ts
type AionisMemoryContract = {
  source_trust:
    | "authoritative_runtime"
    | "scoped_advisory"
    | "external_or_unverified"
    | "blocked_or_suppressed";
  allowed_scope:
    | "current_scope"
    | "task_or_workflow_scope"
    | "supporting_evidence_only"
    | "none";
  evidence_requirement:
    | "satisfied"
    | "node_evidence_only"
    | "requires_more_evidence";
  use_policy:
    | "direct_use"
    | "inspect_before_use"
    | "do_not_use"
    | "evidence_only";
  confirmation_required: boolean;
  reasons: string[];
};
```

The first version only changes direct-use behavior for low-level general
`event`/`evidence` memories whose contract is `evidence_only`; those memories
move to `inspect_before_use` instead of `use_now`. Candidate, contested,
suppressed, archived, and blocked memory continue to follow the existing
authority/lifecycle behavior, with Memory Contract reason codes added for
audit and receipt visibility.

## Trace-to-Procedure Projection

`operator_snapshot.trace_to_procedure` is the product-facing summary of how
Aionis turns traces into reusable procedure candidates. It is assembled from
existing Runtime state and does not add a writer, promotion path, or Agent
prompt content.

```ts
type AionisTraceToProcedureProjection = {
  present: boolean;
  runtime_mutation: false;
  source_surfaces: Array<
    | "execution_tree"
    | "workflow_projection"
    | "replay_playbook"
    | "execution_contract"
    | "memory_decision_trace"
    | "promotion_evidence"
  >;
  procedure_memory_ids: string[];
  workflow_ids: string[];
  evidence_refs: string[];
  candidate_visible: boolean;
  stable_reuse_visible: boolean;
  promotion_status:
    | "stable_ready"
    | "candidate_only"
    | "blocked"
    | "insufficient_evidence"
    | "not_applicable";
  promotion_blocked_count: number;
  reason: string;
};
```

### Projection Rules

| Include | Exclude |
|---|---|
| active path, passed solutions, and failed branches already visible in execution context | raw tree payloads, raw slots, or full chat transcript |
| workflow IDs from guide/effect/agent evidence refs | new workflow compilation or playbook mutation |
| replay contribution and replay run evidence IDs | replay repair as a product promise |
| promotion evidence and blocked-promotion counts | automatic stable promotion |
| procedure/execution memory IDs from decision trace | broad claim that a single trace is reusable everywhere |

`promotion_status` reports readiness only. `blocked` means Aionis has procedure
evidence but the existing learning-control or consolidation gates did not allow
stable reuse. `candidate_only` means the trace can inform inspection or
advisory workflow reuse. `stable_ready` requires trusted/promoted workflow or
procedure evidence already visible through current Runtime surfaces.

## Non-Goals

These outputs must not become:

1. a facade over every internal route
2. a semantic patch generator
3. a generic rule engine
4. a benchmark or host-specific adapter contract
5. a replay repair product
6. a raw memory browser
7. a LoRA training runner

## AionisAgentContext

The agent context is the default product-facing output for `POST /v1/guide`. It should answer:

1. What should the Agent use now?
2. What should be inspected before use?
3. What should not be used?
4. Which target files and memory IDs were recovered?
5. What is the authority and negative-transfer risk?
6. Which memory can be rehydrated if more detail is needed?

### Shape

The route field name is `agent_context`.

`history_used` means the Aionis history/context channel participated in the
guide assembly. `actionable_history_used` is stricter: it is true only when the
Agent received memory-backed guidance, rehydration hints, or execution-state
branches that can affect the next action. Fresh scopes can therefore have
`history_used: true` while keeping `actionable_history_used: false`.

```ts
type AionisAgentContext = {
  contract_version: "aionis_agent_context_v1";
  tenant_id: string;
  scope: string;
  agent_role: "agent" | "planner" | "worker" | "verifier" | "reviewer";
  prompt_text: string;
  summary: string;
  history_used: boolean;
  // true only when recovered memory or execution state can affect the Agent's next action
  actionable_history_used: boolean;
  recommended_posture:
    | "reuse_supported_history"
    | "use_as_context"
    | "inspect_before_use"
    | "rehydrate_before_use"
    | "ignore_history";
  authority: "trusted" | "advisory" | "candidate" | "blocked" | "none";
  target_files: string[];
  use_now: string[];
  inspect_before_use: string[];
  do_not_use: string[];
  use_now_memory_ids: string[];
  inspect_before_use_memory_ids: string[];
  do_not_use_memory_ids: string[];
  prompt_aliases: Array<{
    alias: string;
    memory_id: string;
    surface: "current" | "procedure" | "inspect" | "avoid" | "rehydrate" | "other";
  }>;
  memory_ids: string[];
  rehydrate_hints: Array<{
    memory_id: string;
    reason: string;
    required: boolean;
  }>;
  risk: {
    negative_transfer_risk: "low" | "medium" | "high";
    blocked_authority_count: number;
    stale_memory_count: number;
    reasons: string[];
  };
  evidence_refs: {
    memory_ids: string[];
    workflow_ids: string[];
    evidence_count: number;
  };
};
```

`prompt_text` is the direct Agent prompt surface. In `balanced` mode it uses a
compact readable line format. In `aggressive` mode it uses the `AIONIS_CTX v2`
contract format with short field labels such as `tr` for transition, `act` for
next action, `role` for source role, and `to` for handoff target. Aggressive
mode uses short aliases (`m1`, `m2`, ...) in prompt text and keeps full memory
IDs in the structured fields (`use_now_memory_ids`,
`inspect_before_use_memory_ids`, `do_not_use_memory_ids`, `rehydrate_hints`,
`prompt_aliases`, and `memory_ids`) so hosts can audit and attribute memory use
without making the Agent carry UUIDs in prompt context.

## AionisMemoryPacket

The memory packet is the product-facing output for ordinary recall and mixed recall. It should answer:

1. Which memories are relevant?
2. Are they ordinary cognitive memories, execution memories, or mixed?
3. What evidence supports each memory?
4. What is active, candidate, contested, stale, suppressed, archived, or rehydratable?
5. How may these memories shape the next answer or action?
6. What should not be trusted because of contradiction or negative-transfer risk?

### Shape

The route field name is `aionis_memory_packet`.

```ts
type AionisMemoryPacket = {
  contract_version: "aionis_memory_packet_v1";
  tenant_id: string;
  scope: string;
  actor?: {
    consumer_agent_id?: string | null;
    consumer_team_id?: string | null;
    producer_agent_ids?: string[];
  };
  query: {
    source: "embedding" | "text" | "unknown";
    intent?: string | null;
    embedding_dims?: number | null;
  };
  memory_family: "general_cognitive" | "execution" | "mixed" | "empty";
  relevant_memories: Array<{
    memory_id: string;
    title: string | null;
    summary: string;
    memory_type:
      | "fact"
      | "preference"
      | "project_context"
      | "procedure"
      | "event"
      | "evidence"
      | "rule"
      | "execution_memory"
      | "unknown";
    domain: "general" | "execution";
    source_layer: "L0" | "L1" | "L2" | "L3" | "L4" | "L5" | null;
    authority: "trusted" | "advisory" | "candidate" | "blocked" | "none";
    confidence: number;
    salience: number;
    lifecycle_state:
      | "active"
      | "candidate"
      | "contested"
      | "suppressed"
      | "demoted"
      | "archived"
      | "rehydration_candidate"
      | "unknown";
    evidence_ids: string[];
    scope_hint?: string | null;
    execution_state?: {
      summary_kind: string | null;
      execution_kind: string | null;
      task_signature: string | null;
      workflow_signature: string | null;
      next_action_hint: string | null;
      transition_kind:
        | "resume_current_state"
        | "handoff_to_actor"
        | "accept_handoff"
        | "inspect_before_use"
        | "avoid_failed_branch"
        | "request_rehydrate"
        | null;
      actor_role: string | null;
      handoff_target: string | null;
      source_agent_id: string | null;
      source_team_id: string | null;
    };
    memory_contract: AionisMemoryContract;
  }>;
  evidence_trail: Array<{
    evidence_id: string;
    memory_id: string;
    source: "node" | "edge" | "citation" | "context_item" | "action_packet";
    relation: "direct_match" | "derived_from" | "supports" | "contradicts" | "rehydrates";
    reason: string;
  }>;
  lifecycle: {
    used_memory_ids: string[];
    candidate_memory_ids: string[];
    suppressed_memory_ids: string[];
    archived_memory_ids: string[];
    rehydration_hints: Array<{
      memory_id: string;
      mode: "summary_only" | "partial" | "full" | "differential";
      reason: string;
      required: boolean;
    }>;
  };
  contradiction_warnings: Array<{
    memory_id: string;
    severity: "low" | "medium" | "high";
    reason: string;
    suggested_action: "keep_candidate" | "inspect_before_use" | "suppress" | "rehydrate" | "none";
  }>;
  forgetting_state: {
    stale_memory_count: number;
    suppressed_count: number;
    archived_count: number;
    rehydration_candidate_count: number;
  };
  behavior_impact: {
    will_shape_behavior: boolean;
    changed_fields: string[];
    expected_effects: Array<
      | "answer_style"
      | "fact_recall"
      | "project_context"
      | "tool_or_workflow_guidance"
      | "avoid_stale_memory"
      | "requires_rehydration"
    >;
    explanation: string;
  };
  risk: {
    negative_transfer_risk: "low" | "medium" | "high";
    contradiction_count: number;
    low_confidence_count: number;
    stale_memory_count: number;
    reasons: string[];
  };
  source_map: {
    routes_used: string[];
    internal_surfaces_used: string[];
    omitted_internal_surfaces: string[];
  };
};
```

### Execution Transition Semantics

`relevant_memories[].execution_state.transition_kind` is the product-facing
execution intent compiled from the state-governed memory entry. It is not a host
scheduler and it does not mutate Runtime state by itself.

| Value | Meaning |
|---|---|
| `resume_current_state` | The entry is a usable continuation of the active execution state. |
| `handoff_to_actor` | The entry carries work from one actor to a named `handoff_target`; hosts may route it and target agents may accept it. |
| `accept_handoff` | Agent-context prompt interpretation when the current `agent_role` matches the `handoff_target`. Memory packet entries usually retain the factual `handoff_to_actor` state. |
| `inspect_before_use` | The entry may be useful, but candidate/contested/demoted state blocks direct reuse. |
| `avoid_failed_branch` | The entry represents failed, stale, suppressed, archived, or rejected execution state and should only guide avoidance. |
| `request_rehydrate` | The entry is a compact pointer or rehydration candidate; expand only the relevant payload before exact action. |

`lifecycle_state` answers whether the memory can be trusted. `transition_kind`
answers how the execution context should treat it.

### Field Mapping

| Memory Field | Current Capabilities | Current Code Surfaces |
|---|---|---|
| `relevant_memories` | ranked recall, context items, L0-L5 compression layers | `src/memory/recall.ts`, `src/memory/context.ts`, `src/memory/node-execution-surface.ts` |
| `memory_family` | distinguishes ordinary cognitive memory from execution memory | `src/memory/product-output-assembler.ts` |
| `relevant_memories[].execution_state.transition_kind` | resume/handoff/inspect/avoid/rehydrate execution intent | `src/memory/product-output-assembler.ts`, `src/memory/schemas.ts` |
| `evidence_trail` | node references, raw/evidence refs, commit refs | `src/memory/recall-serialization.ts`, Lite stores |
| `lifecycle` | candidate, suppressed, archived, rehydration state | `src/memory/semantic-forgetting.ts`, `src/memory/archive-relocation.ts`, `src/memory/rehydrate-anchor.ts` |
| `contradiction_warnings` | candidate/contested memory visibility | `src/memory/product-output-assembler.ts`, lifecycle and authority surfaces |
| `behavior_impact` | answer style, fact recall, project context, workflow guidance | `src/memory/product-output-assembler.ts` |
| `risk` | low confidence, stale memory, contradiction risk | `src/memory/product-output-assembler.ts` |

### Memory Packet Boundary

| Include | Exclude |
|---|---|
| evidence-scoped preference/fact/project context/procedure entries | raw chat transcript |
| confidence, salience, layer, lifecycle, authority | raw embedding vectors |
| contradiction and forgetting warnings | raw slots |
| expected behavior impact | full payload dumps |
| execution-memory entries when mixed recall returns them | source-code or task-specific repair rules |

## AionisGuidePacket

The guide packet is the auditable structured output behind `AionisAgentContext`. It should answer:

1. What state can be resumed?
2. Which facts are proven?
3. What memory changed the next action?
4. What is trusted, advisory, candidate, blocked, suppressed, or archived?
5. Which history can be used now, inspected first, rehydrated, or ignored?
6. What product effect should this packet create: less repeated discovery, less context replay, or lower negative-transfer risk?

### Shape

The route field name is `aionis_guide_packet`.

```ts
type AionisGuidePacket = {
  contract_version: "aionis_guide_packet_v1";
  tenant_id: string;
  scope: string;
  actor?: {
    consumer_agent_id?: string | null;
    consumer_team_id?: string | null;
    producer_agent_ids?: string[];
  };
  task: {
    task_id?: string | null;
    run_id?: string | null;
    task_signature?: string | null;
    task_family?: string | null;
  };
  guide_brief: {
    summary: string;
    history_used: boolean;
    actionable_history_used: boolean;
    recommended_posture:
      | "reuse_supported_history"
      | "use_as_context"
      | "inspect_before_use"
      | "rehydrate_before_use"
      | "ignore_history";
    authority: "trusted" | "advisory" | "candidate" | "blocked" | "none";
    use_now: string[];
    inspect_before_use: string[];
    do_not_use: string[];
    rehydrate: Array<{
      memory_id: string;
      reason: string;
      required: boolean;
    }>;
    expected_product_effects: {
      reduces_repeated_discovery: boolean;
      reduces_context_replay: boolean;
      controls_negative_transfer: boolean;
      reason: string;
    };
  };
  recovered_state: {
    state_summary: string | null;
    resumable: boolean;
    handoff_ids: string[];
    execution_state_revision?: number | null;
    target_files: string[];
    acceptance_checks: string[];
  };
  proven_facts: Array<{
    fact: string;
    source: "execution_packet" | "handoff" | "replay" | "verifier" | "memory" | "delegation";
    evidence_id?: string | null;
    confidence: number;
  }>;
  guidance: {
    workflow_candidates: Array<{
      workflow_id: string;
      title: string;
      authority: "trusted" | "advisory" | "candidate" | "blocked";
      evidence_count: number;
      last_outcome?: "success" | "failure" | "mixed" | "unknown";
      reuse_reason: string;
    }>;
    tool_preferences: Array<{
      tool: string;
      preference: "prefer" | "avoid" | "inspect_first";
      authority: "trusted" | "advisory" | "candidate" | "blocked";
      reason: string;
    }>;
  };
  memory_lifecycle: {
    used_memory_ids: string[];
    suppressed_memory_ids: string[];
    archived_memory_ids: string[];
    rehydration_hints: Array<{
      memory_id: string;
      reason: string;
      required: boolean;
    }>;
  };
  history_contributions: {
    handoff: {
      used: boolean;
      source_count: number;
      source_ids: string[];
      changed_fields: string[];
      reason: string | null;
    };
    replay: {
      used: boolean;
      source_count: number;
      source_ids: string[];
      changed_fields: string[];
      reason: string | null;
    };
  };
  risk: {
    negative_transfer_risk: "low" | "medium" | "high";
    blocked_authority_count: number;
    stale_memory_count: number;
    provider_or_protocol_quarantine?: boolean;
    reasons: string[];
  };
  source_map: {
    routes_used: string[];
    internal_surfaces_used: string[];
    omitted_internal_surfaces: string[];
  };
};
```

### Field Mapping

| Guide Field | Current Capabilities | Current Code Surfaces |
|---|---|---|
| `actor` | tenant/scope isolation, agent identity/lane | `src/app/request-guards.ts`, `src/memory/tenant.ts`, Lite stores |
| `task` | execution packet, handoff, trajectory compile | `src/execution/*`, `src/memory/handoff.ts`, `src/memory/trajectory-compile*.ts` |
| `recovered_state` | handoff recover, execution state transitions, resume pack | `src/routes/handoff.ts`, `src/execution/state-store.ts`, `src/memory/agent-memory-inspect-core.ts` |
| `proven_facts` | execution evidence, provenance, verifier surface | `src/memory/execution-evidence.ts`, `src/memory/execution-provenance.ts`, `src/execution/verification.ts` |
| `workflow_candidates` | workflow write projection, replay learning, promotion evidence | `src/memory/workflow-write-projection.ts`, `src/memory/replay*.ts`, `src/memory/promotion-evidence-ledger.ts` |
| `tool_preferences` | tool selection memory, pattern trust, policy memory | `src/memory/tools-*.ts`, `src/memory/pattern-trust-shaping.ts`, `src/memory/policy-memory.ts` |
| `memory_lifecycle` | semantic forgetting, suppression, archive relocation, rehydration | `src/kernel/forgetting-kernel.ts`, `src/memory/lifecycle-lite.ts`, `src/memory/rehydrate-anchor.ts` |
| `history_contributions` | handoff continuity and replay-derived workflow provenance | `src/memory/handoff.ts`, `src/memory/replay*.ts`, `src/app/planning-summary-surfaces.ts` |
| `risk` | authority visibility, runtime entropy, signal trends | `src/memory/authority-*.ts`, `src/memory/runtime-entropy-*.ts`, `src/memory/runtime-signal-*.ts` |
| `source_map` | route capability matrix and product exposure | `src/server/lite-runtime-boundary.ts` |

### Guide Inclusion Rules

| Include | Exclude |
|---|---|
| proven facts and their sources | raw chat transcript |
| resumable state and target files | full memory graph dump |
| trusted/advisory/candidate/blocked status | hard task-specific rules |
| suppressed/archive/rehydration state | replay repair as product promise |
| negative-transfer risk | benchmark-specific action semantics |

## AionisLearningPacket

The learning packet is the product-facing output for self-learning control. It should answer:

1. What can be reused as scoped learning?
2. What is only a candidate?
3. What is promotion-ready but still evidence-scoped?
4. What is blocked, contested, demoted, archived, or under review?
5. Why is stable promotion allowed or denied?
6. Is anything ready for training export?

The route field name is `aionis_learning_packet`.

Route-level LearningPacket output is not a training runner. It must not claim LoRA/export readiness from a single context route. Training export readiness belongs to measured EffectReport evidence.

### Shape

```ts
type AionisLearningPacket = {
  contract_version: "aionis_learning_packet_v1";
  tenant_id: string;
  scope: string;
  actor?: {
    consumer_agent_id?: string | null;
    consumer_team_id?: string | null;
    producer_agent_ids?: string[];
  };
  task: {
    task_id?: string | null;
    run_id?: string | null;
    task_signature?: string | null;
    task_family?: string | null;
  };
  posture: {
    recommended_learning_posture:
      | "promotion_ready"
      | "candidate_only"
      | "constrain"
      | "invalidate"
      | "insufficient_evidence";
    authority: "advisory" | "candidate" | "blocked" | "none";
    source_code_change_allowed: false;
    stable_promotion_allowed: boolean;
    reason: string;
  };
  candidates: Array<{
    candidate_id: string;
    kind: "workflow" | "pattern" | "policy" | "memory";
    authority: "advisory" | "candidate" | "blocked";
    evidence_count: number;
    promotion_state: "candidate" | "promotion_ready" | "stable" | "contested" | "retired" | "unknown";
    source_ids: string[];
    reason: string;
  }>;
  learning_control: {
    contract_trust: "authoritative" | "advisory" | "observational" | null;
    action_start_blocked: boolean;
    authoritative_allowed_count: number;
    authoritative_blocked_count: number;
    stable_promotion_allowed_count: number;
    stable_promotion_blocked_count: number;
    blocked_reasons: string[];
  };
  lifecycle_effect: {
    promoted_workflow_count: number;
    candidate_workflow_count: number;
    trusted_pattern_count: number;
    contested_pattern_count: number;
    active_policy_count: number;
    contested_policy_count: number;
    suppressed_memory_ids: string[];
    demote_count: number;
    archive_count: number;
    review_count: number;
  };
  evidence: {
    workflow_anchor_ids: string[];
    candidate_workflow_anchor_ids: string[];
    trusted_pattern_anchor_ids: string[];
    candidate_pattern_anchor_ids: string[];
    contested_pattern_anchor_ids: string[];
    promotion_denied_reasons: string[];
  };
  export_readiness: {
    training_export_ready: boolean;
    positive_transfer_required: boolean;
    reason: string;
  };
  source_map: {
    routes_used: string[];
    internal_surfaces_used: string[];
    omitted_internal_surfaces: string[];
  };
};
```

### Learning Field Mapping

| Learning Field | Current Capabilities | Current Code Surfaces |
|---|---|---|
| `posture` | promotion readiness, invalidation pressure, learning-control limits | `src/app/planning-summary*.ts`, `src/memory/authority-*.ts` |
| `candidates` | stable workflows, candidate workflows, trusted/contested patterns | `src/memory/action-retrieval.ts`, `src/memory/replay*.ts`, `src/memory/pattern-trust-shaping.ts` |
| `learning_control` | contract trust, blocked authority, stable promotion gate | `src/memory/contract-trust.ts`, `src/memory/authority-*.ts`, `src/memory/learning-control-*.ts` |
| `lifecycle_effect` | workflow/pattern/policy lifecycle and semantic forgetting | `src/app/planning-summary-surfaces.ts`, `src/memory/semantic-forgetting.ts`, `src/kernel/forgetting-kernel.ts` |
| `evidence` | action packet anchor ids and promotion denied reasons | `src/memory/recall-action-packet.ts`, `src/memory/promotion-evidence-ledger.ts` |
| `export_readiness` | training/export safety boundary | `src/memory/product-output-assembler.ts`, `src/kernel/effect-evaluator.ts` |

### Learning Inclusion Rules

| Include | Exclude |
|---|---|
| scoped candidate ids and authority | task-specific repair instructions |
| promotion-ready vs blocked state | source-code mutation permission |
| denied promotion reasons | hidden benchmark assumptions |
| suppressed/demoted/archive/review counts | direct LoRA training execution |
| explicit `training_export_ready=false` without EffectReport proof | single-run positive-transfer claims |

## AionisEffectReport

The effect report is the main product proof output. It should answer:

1. Did history change the run?
2. Was the change positive, negative, or neutral?
3. What was saved?
4. What was reused?
5. What was suppressed or forgotten?
6. Which feedback signals were observed?
7. What should be learned, demoted, archived, or exported as training data?

`/v1/measure` accepts two input styles:

| Input Style | Meaning |
|---|---|
| `baseline` + `aionis` | Advanced measurement where the caller supplies direct continuity, learning, forgetting, and learning-control observations. |
| `product_trace` | Product measurement where the caller supplies `before_guide`, `after_guide`, and optional `forget_result` outputs from the facade. |

`product_trace` is projected into the same effect evaluator. The projection uses only product packets and product forget effects: relevant memories, workflow candidates, proven facts, rehydration hints, stale/suppressed counts, and authority visibility. It is a packet-level product measurement, not a claim that an external Agent solved a task.

### Shape

```ts
type AionisEffectReport = {
  contract_version: "aionis_effect_report_v1";
  tenant_id: string;
  scope: string;
  task: {
    task_id?: string | null;
    run_id?: string | null;
    task_signature?: string | null;
    task_family?: string | null;
  };
  comparison: {
    mode: "baseline_vs_aionis" | "observe_only_vs_active" | "single_run_history_impact";
    baseline_run_id?: string | null;
    aionis_run_id?: string | null;
    sufficient_evidence: boolean;
  };
  history_impact: {
    changed_future_behavior: boolean;
    impact_direction: "positive" | "negative" | "neutral" | "insufficient_evidence";
    changed_fields: string[];
    explanation: string;
  };
  efficiency: {
    repeated_discovery_delta?: number | null;
    useful_continuity_delta?: number | null;
    token_delta?: number | null;
    context_size_delta?: number | null;
    recovery_step_delta?: number | null;
  };
  quality: {
    verifier_outcome?: "pass" | "fail" | "not_run" | "unknown";
    recovered_fact_accuracy?: "positive" | "negative" | "mixed" | "unknown";
    workflow_reuse_outcome?: "success" | "failure" | "mixed" | "not_used";
    negative_transfer_detected: boolean;
  };
  history_contributions: {
    handoff: {
      used: boolean;
      source_count: number;
      source_ids: string[];
      changed_fields: string[];
      reason: string | null;
    };
    replay: {
      used: boolean;
      source_count: number;
      source_ids: string[];
      changed_fields: string[];
      reason: string | null;
    };
  };
  learning_effect: {
    promoted_workflow_ids: string[];
    candidate_workflow_ids: string[];
    demoted_memory_ids: string[];
    blocked_authority_ids: string[];
    promotion_denied_reasons: string[];
  };
  forgetting_effect: {
    suppressed_memory_ids: string[];
    archived_memory_ids: string[];
    rehydrated_memory_ids: string[];
    stale_memory_filtered_count: number;
  };
  feedback_signal_summary: {
    present: boolean;
    source: "memory_decision_audit" | "not_supplied";
    authority_mutation: false;
    positive_attributed_memory_ids: string[];
    weak_counter_signal_memory_ids: string[];
    strong_counter_signal_memory_ids: string[];
    repeated_unattributed_memory_ids: string[];
    repeated_unattributed_without_positive_memory_ids: string[];
    read_only_signal_memory_ids: string[];
    explanation: string;
  };
  training_candidates: Array<{
    candidate_type:
      | "handoff_distillation"
      | "transfer_judge"
      | "workflow_selector"
      | "forgetting_suppression"
      | "authority_judgment";
    source_ids: string[];
    label: "positive" | "negative" | "neutral" | "blocked" | "insufficient_evidence";
    export_ready: boolean;
    reason: string;
  }>;
  evidence: {
    evidence_ids: string[];
    replay_run_ids: string[];
    signal_summary_ids: string[];
    promotion_quality_summary_ids: string[];
  };
};
```

### Field Mapping

| Effect Field | Current Capabilities | Current Code Surfaces |
|---|---|---|
| `comparison` | effect evaluator, baseline/Aionis comparisons, observe-only controls | `src/kernel/effect-evaluator.ts`, `src/memory/product-output-assembler.ts` |
| `history_impact` | planning summary, action retrieval, runtime effect summary | `src/app/planning-summary*.ts`, `src/memory/action-retrieval.ts`, `src/memory/runtime-effect-summary.ts` |
| `efficiency` | repeated discovery, token/context, recovery signals | `src/memory/runtime-effect-summary.ts`, `src/memory/cost-signals.ts`, `src/memory/runtime-signal-ledger.ts` |
| `quality` | verifier surface, workflow reuse, negative transfer | `src/execution/verification.ts`, `src/memory/replay*.ts`, `src/memory/runtime-signal-trends.ts` |
| `history_contributions` | visible handoff/replay contribution attribution | `src/memory/product-output-assembler.ts` |
| `learning_effect` | learning loop, promotion evidence, authority gates | `src/memory/learning-loop.ts`, `src/memory/promotion-evidence-ledger.ts`, `src/memory/authority-*.ts` |
| `forgetting_effect` | semantic forgetting, archive, rehydrate, activation | `src/kernel/forgetting-kernel.ts`, `src/memory/lifecycle-lite.ts`, `src/memory/archive-relocation.ts` |
| `feedback_signal_summary` | product-level read-only feedback signal summary | `src/memory/product-output-assembler.ts`, `memory_decision_audit.feedback_signal_review` |
| `feedback_learning_control` | `/v1/feedback` or advanced `/v1/forget activate` persistence result for repeated-unused-without-positive inspect-before-use posture | `src/routes/product-facade.ts`, `src/memory/lifecycle-lite.ts`, `src/memory/node-feedback-state.ts` |
| `inspect_before_use_shadow_delta` | disabled preview of confidence-decay candidates that would move to inspect-before-use | `src/memory/product-output-assembler.ts`, `memory_decision_trace.inspect_before_use_shadow_delta` |
| `training_candidates` | execution evidence, handoff, replay, promotion/demotion, forgetting | `src/memory/execution-evidence.ts`, `src/memory/handoff.ts`, `src/memory/replay*.ts`, `src/memory/promotion-quality-summary.ts` |
| `evidence` | replay, runtime signals, promotion quality | `src/memory/replay*.ts`, `src/memory/runtime-signal-*.ts`, `src/memory/promotion-quality-summary.ts` |

### Effect Inclusion Rules

| Include | Exclude |
|---|---|
| measured deltas and evidence ids | unverified success claims |
| positive/negative/neutral transfer | single-run broad generalization |
| blocked authority and demotion reasons | model/provider marketing claims |
| forgetting and rehydration effects | raw tool logs unless referenced by evidence id |
| feedback signal ids with `authority_mutation: false` | treating a report summary as a downgrade or promotion trigger |
| `feedback_learning_control_posture=inspect_before_use` only after repeated-unused-without-positive gate passes | converting unused exposure into suppression, archive, deletion, or task-specific behavior |
| disabled inspect-before-use deltas with `enabled: false` | claiming automatic downgrade or prompt behavior |
| training candidate labels | actual LoRA training execution |

## Internal Surfaces Not Product Outputs

These may feed the four product outputs, but should not become product-facing outputs themselves.

| Internal Surface | Product Treatment |
|---|---|
| raw `find` / `resolve` | Operator/debug only; may feed source maps. |
| `rules/state` / `rules/evaluate` | Internal advisory state; not product rule engine. |
| replay repair/run/dispatch | Internal evidence/control; product says workflow evidence, not repair engine. |
| sandbox executor | Internal replay backend; not sandbox product. |
| associative linking | Internal write/recall substrate; not product feature. |
| runtime maintenance knobs | Internal maintenance; product sees effect summary. |

## Acceptance Gate Before Implementation

Before any route, SDK, CLI, or demo is implemented against these outputs:

1. This document must be accepted as the product output contract.
2. The guide/effect fields must be mapped only to `product-core`, `product-support`, `internal-evidence`, or `internal-guidance` capabilities from the decision matrix.
3. Routes marked `operator_support`, `internal_control`, or `eval-only` must not be surfaced as first-class product actions.
4. A demo must show the outputs, not raw internal route dumps.
5. An effect report must be allowed to say `insufficient_evidence` instead of forcing a positive claim.

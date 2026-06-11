# Aionis Judgment Ledger Enhancement

Status: Phase 1 implemented as a read-only Judgment Calibration projection;
append-only persistent ledger and EpistemicBrief remain future work

This document defines the narrow Aionis-compatible Judgment Ledger direction.
It does not replace the current Aionis memory substrate, does not introduce a
new Agent framework, and does not turn Aionis into a problem-solving planner.

The goal is to make Aionis better at calibrating its own memory judgments:

```text
guide exposed memory or uncertainty
-> host / Agent actually used or ignored it
-> outcome arrived
-> Aionis records whether the original judgment was supported
-> future guide ranking, inspect priority, and audit become better calibrated
```

## Current Implementation

The focused Runtime currently implements Phase 1 as
`AionisJudgmentCalibrationSummary`, a read-only projection derived from the
existing `memory_decision_trace`.

Implemented surfaces:

| Surface | Field |
|---|---|
| Decision trace | `memory_decision_trace.judgment_calibration_summary` |
| Audit report | `memory_decision_audit.judgment_calibration_review` |
| Operator snapshot | `operator_snapshot.judgment_calibration` |

Implemented behavior:

1. host-marked used memory with positive feedback is summarized as supported
2. host-marked used memory with threshold-met or strong negative evidence is summarized as contradicted
3. single weak negative feedback stays weak/inconclusive
4. recalled memory not host-marked as used is summarized as unused
5. missing feedback remains inconclusive
6. all fields keep `agent_prompt_included: false`
7. all fields keep `runtime_mutation: false` and `authority: "read_only"`

Not implemented yet:

1. no append-only persisted `JudgmentRecord` store
2. no guide-time ledger write
3. no ranking or authority mutation from calibration
4. no `EpistemicBrief`
5. no `unknowns_to_verify` Agent-facing field

## Product Motivation

Aionis currently focuses on four product capabilities:

1. execution and memory continuity
2. self-learning from real outcomes
3. controlled forgetting and rehydration
4. dynamic memory governance

The current Runtime can already decide whether memory should enter
`use_now`, `inspect_before_use`, `do_not_use`, or `rehydrate`. The missing
product-level improvement is calibration of the decisions behind those
surfaces.

The enhancement should answer:

1. Which exposed memories were actually useful?
2. Which inspect-first warnings were justified?
3. Which rehydration hints mattered?
4. Which stale, negative, or contested memories prevented repeated dead ends?
5. Which classes of Runtime judgment are historically overconfident or
   underconfident?

This is the Aionis-compatible part of the broader research direction: not a
full question-centered memory system, but a judgment calibration layer that can
eventually improve future memory use.

## Non-Goals

This enhancement must not:

1. replace Aionis memory with a question graph
2. store every possible uncertainty as a first-class `Question`
3. let the Runtime choose or force the Agent's next action
4. add task-specific rules for a benchmark, repo, or issue
5. use LLM-generated VoI floats as authority
6. promote a memory to trusted or suppress it from one weak outcome
7. pass audit or trace internals into the Agent prompt
8. add ARC, PawBench, GitHub issue runners, or external Agent harness code to
   the focused Runtime

The first version is calibration infrastructure, not a new cognitive planner.

## Relationship To Aporia 2.1

Aporia 2.1 proposes three stores:

| Aporia Layer | Meaning | Aionis Mapping |
|---|---|---|
| Question map | What the system does not know but should verify | Optional `unknowns_to_verify` generated from existing Aionis uncertainty signals |
| Belief residue | Resolved answers and dead ends | Existing memory, lifecycle, relation, and execution surfaces |
| Judgment ledger | Predicted usefulness vs externally anchored result | Phase 1 read-only calibration over `memory_decision_trace`; later persistent layer over `guide -> feedback -> measure` |

Aionis has adopted the third layer first in read-only form.

The question map should be limited to a small `EpistemicBrief` produced from
existing Aionis signals. It should not become the primary memory store.

## Existing Runtime Surfaces To Reuse

The design should reuse current Aionis product surfaces:

| Existing Surface | Role In This Enhancement |
|---|---|
| `/v1/guide` | Creates a guide trace and exposes memory surfaces to the host |
| `agent_context` | Optional Agent-facing compact context |
| `memory_decision_trace` | Read-only diagnostic surface for decisions |
| `memory_use_receipt` | Operator-readable summary of memory use |
| `/v1/feedback` | Host submits outcome and used memory IDs |
| `/v1/measure` | Computes product effect and calibration summaries |
| `/v1/operator/snapshot` | Shows read-only audit state |
| lifecycle candidate inference | Produces inspect, stale, negative, and rehydrate candidates |
| sparse feedback summaries | Existing weak positive / negative attribution signals |
| neighborhood drift observations | Existing weak context-change observation |

This avoids a new subsystem and keeps the product loop stable.

## Core Data Model

### JudgmentRecord

`JudgmentRecord` is the future append-only record of one Runtime memory
judgment. It is not implemented in Phase 1.

```ts
type AionisJudgmentRecord = {
  contract_version: "aionis_judgment_record_v1";
  judgment_id: string;
  guide_trace_id: string;
  tenant_id: string;
  scope: string;
  created_at: string;

  subject: {
    subject_type:
      | "memory"
      | "lifecycle_candidate"
      | "relation"
      | "rehydrate_hint"
      | "unknown_to_verify"
      | "dead_end";
    subject_id: string;
    memory_id?: string | null;
    signal_id?: string | null;
  };

  exposure: {
    agent_surface:
      | "use_now"
      | "inspect_before_use"
      | "do_not_use"
      | "rehydrate"
      | "audit_only";
    exposed_to_agent: boolean;
    exposed_to_operator: boolean;
    prompt_char_cost: number;
  };

  predicted: {
    usefulness_rank: "high" | "medium" | "low";
    reason_codes: string[];
    reason_summary: string;
    producer:
      | "runtime_rule"
      | "runtime_relation"
      | "runtime_feedback"
      | "runtime_drift"
      | "host_supplied"
      | "llm_candidate";
    authority: "read_only" | "advisory" | "candidate";
  };

  actual?: {
    used: boolean;
    used_surface?: "use_now" | "inspect_before_use" | "explicit_host_assertion";
    outcome: "positive" | "negative" | "neutral" | "unknown";
    anchored_signal:
      | "verifier"
      | "tool_result"
      | "user_feedback"
      | "host_outcome"
      | "operator_review"
      | "none";
    attribution_strength: "strong" | "weak" | "none";
    realized_effect: "supported" | "contradicted" | "unused" | "inconclusive";
    recorded_at: string;
  };

  calibration: {
    bucket: string;
    eligible_for_calibration: boolean;
    exclusion_reason?: string | null;
  };
};
```

The record must be append-only. Later feedback should update it by appending an
outcome record or by writing an associated ledger event, not by losing the
original prediction.

### CalibrationSummary

`CalibrationSummary` is implemented by `measure`, audit, and operator snapshot.
It is not an Agent prompt surface.

```ts
type AionisJudgmentCalibrationSummary = {
  contract_version: "aionis_judgment_calibration_summary_v1";
  scope: string;
  window: {
    record_count: number;
    anchored_count: number;
    weak_count: number;
    inconclusive_count: number;
  };
  buckets: Array<{
    bucket: string;
    supported_count: number;
    contradicted_count: number;
    unused_count: number;
    support_rate: number;
    recommended_adjustment:
      | "keep"
      | "rank_up"
      | "rank_down"
      | "inspect_first"
      | "needs_more_evidence";
    authority: "read_only" | "candidate";
  }>;
};
```

The first version should only expose a read-only summary. It should not mutate
memory authority by itself.

### EpistemicBrief

`EpistemicBrief` is the small Aionis-safe version of Aporia's question map.

It should be optional and bounded:

```ts
type AionisEpistemicBrief = {
  contract_version: "aionis_epistemic_brief_v1";
  unknowns_to_verify: Array<{
    question: string;
    why_it_matters: string;
    cheapest_probe: string;
    source_signal_ids: string[];
    authority: "advisory";
  }>;
  known_dead_ends: Array<{
    summary: string;
    evidence_ids: string[];
    authority: "advisory";
  }>;
};
```

Hard limits:

1. `unknowns_to_verify.length <= 2`
2. `known_dead_ends.length <= 2`
3. no `next_action`
4. no imperative commands
5. no raw trace, raw rows, or audit internals
6. authority is always advisory in the first version

## Signal Sources

The first version must generate judgment records and optional unknowns only
from existing Aionis signals.

Allowed sources:

1. memory selected into `use_now`
2. memory selected into `inspect_before_use`
3. memory selected into `do_not_use`
4. rehydrate hints
5. lifecycle candidate signals
6. memory lifecycle relations
7. sparse feedback weak / strong signals
8. repeated exposed-but-unused observations
9. neighborhood drift candidates
10. failed execution branches and negative memories

Disallowed sources:

1. free-form LLM question generation
2. benchmark-specific task wording
3. single-run unanchored conclusions
4. broad source-code policy mutation
5. user-visible claims that Aionis has proven task success improvement

## Authority Rules

Judgment Ledger must preserve Aionis's current authority boundary.

1. A judgment record is evidence, not authority.
2. One negative outcome creates at most a weak counter-signal.
3. Repeated weak signals may create a candidate learning signal.
4. Candidate learning signals may affect ranking or inspect priority only after
   existing Aionis gates accept them.
5. Authority changes remain owned by current learning / forgetting / lifecycle
   gates.
6. LLM candidates, if added later, can only produce candidate records and must
   pass Runtime gates before use.

The first implementation should be read-only with respect to memory authority.

## Product Flow

### Guide Time

At `/v1/guide`:

1. Build `memory_packet`, `guide_packet`, and `agent_context` as today.
2. For each exposed memory or signal, append a `JudgmentRecord` prediction.
3. Store:
   - exposed subject ID
   - surface
   - predicted usefulness rank
   - reason codes
   - guide trace ID
   - calibration bucket
4. Return normal guide output.
5. Optionally include `agent_context.unknowns_to_verify` only when enabled and
   bounded.

The Agent should still receive only compact `agent_context`.

### Feedback Time

At `/v1/feedback`:

1. Host submits `guide_trace_id`, `used_memory_ids`, `used_surface`, and
   `outcome`.
2. Runtime matches feedback to judgment records from that guide trace.
3. Used records receive outcome attribution.
4. Exposed-but-unused records remain `unused`, not negative.
5. Negative outcome on a used memory becomes weak unless verifier/tool/user
   evidence makes it strong.

This prevents blaming memory for failures caused by Agent execution, provider
errors, or verifier noise.

### Measure Time

At `/v1/measure`:

1. Aggregate recent judgment records.
2. Separate anchored, weak, unused, and inconclusive evidence.
3. Produce `judgment_calibration_summary`.
4. Include summaries in `memory_decision_trace` and operator audit.
5. Do not mutate memory authority.

### Operator Snapshot

At `/v1/operator/snapshot`:

1. Show which memories were exposed.
2. Show whether the host reported using them.
3. Show whether outcomes supported or contradicted the original judgment.
4. Show bucket-level calibration trend.
5. Keep the snapshot read-only.

## Calibration Buckets

Buckets should be coarse, stable, and inspectable.

Candidate first-version buckets:

1. `surface:use_now`
2. `surface:inspect_before_use`
3. `surface:rehydrate`
4. `signal:lifecycle_negative`
5. `signal:lifecycle_stale`
6. `signal:relation_supersede`
7. `signal:repeated_unused`
8. `domain:execution_memory`
9. `domain:general_memory`
10. `producer:llm_candidate` only if LLM candidate producer exists later

Avoid fine-grained float scoring. The output should be:

```text
this bucket is usually supported
this bucket is often unused
this bucket is often contradicted
there is insufficient evidence
```

## Optional Unknowns To Verify

`unknowns_to_verify` should be generated only when a decision has unresolved
memory risk.

Examples:

1. A memory is useful but contested by newer evidence.
2. A rehydrate hint points to payload needed for exact continuation.
3. A repeated dead end is relevant to the current query.
4. Multiple trusted workflows conflict and require inspection before reuse.
5. A high-value memory is old, exposed repeatedly, but never positively
   attributed.

The field should be framed as a verification hint:

```text
Verify whether the current checkout workflow still uses src/payments/checkout.ts;
older memory points to legacy/payments/old-checkout.ts but newer evidence
contests it.
```

It should not say:

```text
Edit src/payments/checkout.ts next.
```

## Testing Strategy

### Unit Tests

Add focused tests for:

1. guide creates judgment records for exposed memory
2. feedback attributes outcome only to used IDs from the matching guide trace
3. exposed-but-unused does not become negative feedback
4. unanchored negative outcome stays weak
5. verifier/user/tool anchored outcome can become strong
6. measure produces calibration summary without mutating memory
7. operator snapshot exposes read-only calibration
8. Agent prompt does not leak judgment records or audit internals

### Product E2E

Add one e2e loop:

```text
observe -> guide -> feedback -> measure -> snapshot
```

Required checks:

1. fresh guide has no calibration evidence
2. memory enters `use_now`
3. feedback marks one memory as used and positive
4. measure reports supported judgment
5. a later guide can expose the same memory with a stronger reason summary
6. operator snapshot shows the ledger without changing Runtime authority

### MGBench Suite

Add a benchmark suite only in the eval workspace, not in focused Runtime.

Suggested suite name:

```text
judgment-ledger-calibration
```

Measure:

1. attribution precision
2. exposed-unused safety
3. weak negative safety
4. repeated dead-end avoidance
5. inspect-first calibration
6. prompt leakage rate
7. context character overhead

First success criteria:

1. 100% no prompt leakage
2. 100% exposed-unused does not auto-demote
3. 100% outcome attribution stays within matching guide trace
4. judgment summary exists for supported, contradicted, unused, and
   inconclusive cases

Later success criteria:

1. repeated dead-end direct-use rate decreases
2. inspect-first precision improves
3. calibration bucket support rates become predictive on holdout scenarios

## Acceptance Criteria

The first implementation is complete only when:

1. it adds no external Agent harness code to focused Runtime
2. it does not change the primary memory store
3. it does not make Aionis choose Agent actions
4. it records guide-time predictions
5. it attributes feedback by `guide_trace_id` and used IDs
6. it produces a read-only calibration summary in measure/audit
7. it keeps judgment internals out of Agent prompt text
8. tests prove no automatic authority mutation from a single outcome
9. MGBench or product e2e proves attribution and audit behavior

## Implementation Map

Candidate Runtime files to inspect before implementation:

| Area | Likely Files |
|---|---|
| Product contracts | `src/memory/product-output-contract.ts` |
| Trace assembly | `src/memory/product-output-assembler.ts` |
| SDK flow | `src/sdk.ts` |
| Feedback attribution | memory feedback / forget route implementation |
| Measure output | product effect and decision trace builders |
| Operator snapshot | operator snapshot route / assembler |
| Tests | `scripts/ci/*product*`, `scripts/ci/*memory*`, `scripts/e2e/*product*` |

Do not implement from memory. Read the actual files first.

## Rollout Plan

### Phase 1: Read-Only Ledger

Implement append-only records and expose them in measure/audit. No guide ranking
changes. No authority changes.

### Phase 2: Agent-Facing EpistemicBrief

Add bounded `unknowns_to_verify` and `known_dead_ends` to `agent_context`.
Default to disabled or conservative. Maximum two entries each.

### Phase 3: Ranking Candidate

Use calibration summary as a candidate ranking signal for `inspect_before_use`
priority and rehydrate hint priority. Still no authority mutation.

### Phase 4: Gated Learning Integration

Only after holdout evidence shows positive transfer, allow calibration buckets
to feed existing learning / forgetting gates as candidate evidence.

## Failure Modes

| Failure Mode | Guard |
|---|---|
| Runtime starts steering Agent actions | No `next_action`; only advisory verification hints |
| LLM estimates become pseudo-authority | LLM outputs candidate only; Runtime gates decide |
| Single failure demotes good memory | Weak counter-signal first; require repeated or anchored evidence |
| Prompt bloat | Hard cap on EpistemicBrief entries and characters |
| Audit leaks to Agent | Contract tests against prompt text |
| Question graph explosion | No full graph in first version; optional unknowns are bounded |
| Benchmark overfitting | Eval suites outside focused Runtime; no task wording in core |
| Misattribution | Require `guide_trace_id` and used IDs; unused is not negative |

## Product Claim Boundary

Safe claim after Phase 1:

```text
Aionis can audit whether memory exposed to an Agent was later supported,
unused, contradicted, or inconclusive.
```

Safe claim after Phase 2:

```text
Aionis can surface bounded verification hints for memory uncertainty without
turning them into commands.
```

Safe claim after Phase 3 and holdout validation:

```text
Aionis can use historical outcome attribution to improve future memory
ranking and inspect priority.
```

Unsafe claim until proven:

```text
Aionis improves arbitrary task success rate.
Aionis knows the objectively best next question.
Aionis has solved self-improving reasoning.
```

## Final Design Rule

Do not implement Aporia as a new core memory system.

Implement the smallest Aionis-native loop:

```text
memory judgment -> attributed outcome -> calibration summary -> safer future guide
```

That is the positive transfer from Aporia 2.1 into Aionis.

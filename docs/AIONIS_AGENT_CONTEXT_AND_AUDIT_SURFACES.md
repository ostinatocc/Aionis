# Aionis Agent Context and Audit Surfaces

Status: product usage boundary for the current focused Runtime

This document defines who should consume each product output. It does not add a
new Runtime mechanism.

For a runnable local product flow, see
[AIONIS_OBSERVE_GUIDE_AUDIT_QUICKSTART.md](AIONIS_OBSERVE_GUIDE_AUDIT_QUICKSTART.md).
For the full product API usage boundary, see
[AIONIS_PRODUCT_API_USAGE.md](AIONIS_PRODUCT_API_USAGE.md).
For external host wiring, see
[AIONIS_HOST_INTEGRATION.md](AIONIS_HOST_INTEGRATION.md).

## Rule

Agents consume `agent_context`.

Developers and operators inspect `memory_decision_trace`,
`memory_decision_audit`, `memory_use_receipt`, and
`judgment_calibration_summary`.

The audit surfaces explain why Aionis selected, downgraded, blocked, or
rehydrated memory. They must not become Agent prompt content.

## Surfaces

| Surface | Route | Consumer | Purpose | Prompt Surface |
|---|---|---|---|---|
| `agent_context` | `POST /v1/guide` | Agent / host prompt builder | Compact context for the next run. | Yes |
| `memory_packet` | `POST /v1/guide` with `include_packets: true` | Host / measurement / advanced UI | Structured evidence behind recall. | No by default |
| `guide_packet` | `POST /v1/guide` with `include_packets: true` | Host / measurement / advanced UI | Structured guide behind `agent_context`. | No by default |
| `memory_decision_trace` | `POST /v1/debug/memory-decision-trace` or `/v1/measure` | Developer debugging | Per-memory decision trace. | Never |
| `memory_decision_audit` | `POST /v1/audit/memory-decision-report` or `/v1/measure` | Operator audit / product diagnostics | Compact review of memory decisions. | Never |
| `memory_use_receipt` | Inside `memory_decision_trace` and `operator_snapshot` | Host / operator audit | Compact receipt of exposed, blocked, rehydrated, attributed, and unattributed memory IDs. | Never |
| `judgment_calibration_summary` | Inside `memory_decision_trace`, `memory_decision_audit`, and `operator_snapshot` | Host / operator audit | Read-only summary of supported, contradicted, unused, weak, and inconclusive memory judgments. | Never |
| `operator_snapshot` | `POST /v1/operator/snapshot` | Operator / host observability | Read-only run, branch, feedback, and effect summary. | Never |
| `operator_snapshot.trace_to_procedure` | Inside `operator_snapshot` | Operator / host observability | Read-only procedure-readiness projection from execution tree, workflow, replay, contract, trace, and promotion evidence. | Never |

## Agent-Facing Contract

The Agent should receive only `agent_context.prompt_text`, or a host-rendered
equivalent using these fields:

1. `agent_role`
2. `summary`
3. `recommended_posture`
4. `authority`
5. `target_files`
6. `use_now`
7. `inspect_before_use`
8. `do_not_use`
9. `rehydrate_hints`
10. `memory_ids`
11. `risk`

This keeps Aionis useful without turning memory internals into a rule wall.

Premise Firewall warnings are Agent-facing only through the existing
`risk.reasons`, `inspect_before_use`, and `do_not_use` fields. The detailed
per-memory explanation remains in `memory_decision_trace` and the compact
risk flag remains in `memory_use_receipt`; neither should be appended to the
Agent prompt.

Memory Contract follows the same boundary. The Agent sees only the compiled
`use_now`, `inspect_before_use`, `do_not_use`, and `risk` result. The per-memory
contract object and reason codes are packet/debug/receipt surfaces for hosts
and operators.

Trace-to-Procedure follows the operator boundary. It can explain why a workflow
or procedure is stable, candidate-only, blocked, or not applicable, but it must
not be appended to the Agent prompt or treated as a new action policy.

## Debug and Audit Contract

Use `memory_decision_trace` when the developer needs exact causality:

1. Which memory entered `use_now`?
2. Which memory was downgraded to `inspect_before_use`?
3. Which memory was blocked from Agent use?
4. Which memory needs rehydration before use?
5. Which lifecycle relation, evidence id, producer, gate, and signal caused the decision?

Use `memory_decision_audit` when the product needs a compact review:

1. `used_memories`
2. `downgraded_memories`
3. `blocked_memories`
4. `rehydrate_memories`
5. `feedback_signal_review`
6. `judgment_calibration_review`
7. counters, claims, risks, and source map

Use `memory_use_receipt` when the host or operator needs the smallest stable
answer to "what memory did Aionis expose or block this turn?":

1. `use_now_memory_ids`
2. `inspect_before_use_memory_ids`
3. `do_not_use_memory_ids`
4. `rehydrate_memory_ids`
5. `attributed_memory_ids`
6. `unattributed_recalled_memory_ids`
7. `risk_flags`

Use `judgment_calibration_summary` when the host or operator needs to know
whether Aionis's memory judgments were later supported, contradicted, unused,
weak, or inconclusive. This summary is derived from the decision trace and
feedback attribution only; it cannot mutate authority, suppress memory, or
enter the Agent prompt.

Use `operator_snapshot.trace_to_procedure` when the host or operator needs to
understand whether existing execution evidence is ready for reusable procedure
memory:

1. visible source surfaces
2. procedure memory IDs and workflow IDs
3. candidate vs stable reuse state
4. promotion blocked count and reason
5. evidence references

The audit report is intentionally operator-facing. It is not a better prompt.

## Correct Use

Typical integration flow:

1. Call `POST /v1/observe` after real work or memory input.
2. Call `POST /v1/guide`.
3. Pass only `guide.agent_context.prompt_text` or selected `agent_context`
   fields to the Agent.
4. Call `POST /v1/feedback` after the Agent acts so outcome attribution is
   tied to exposed memory IDs.
5. Call `POST /v1/rehydrate` only when compact context says colder evidence or
   payload is needed.
6. If the Agent output looks wrong, call
   `POST /v1/debug/memory-decision-trace` with the same guide output as
   `product_trace.after_guide`.
7. If a product or customer audit is needed, call
   `POST /v1/audit/memory-decision-report`.
8. Use `POST /v1/measure` when comparing before/after guide packets or
   measuring whether history helped.

## Incorrect Use

Do not:

1. append `memory_decision_trace` to the Agent prompt
2. append `memory_decision_audit` to the Agent prompt
3. append `memory_use_receipt` to the Agent prompt
4. append `judgment_calibration_summary` to the Agent prompt
5. ask the Agent to reason over raw memory rows or raw slots
6. treat debug/audit output as a task solver
7. treat a single debug trace as authority to change Runtime behavior
8. expose internal route dumps as the product experience

## Why This Boundary Exists

`agent_context` is optimized for the Agent: compact, actionable, and bounded.

`memory_decision_trace`, `memory_decision_audit`, `memory_use_receipt`, and
`judgment_calibration_summary` are optimized for humans and host systems:
inspectable, causal, and testable.

Keeping these surfaces separate is what lets Aionis provide memory continuity,
controlled forgetting, and learning control without adding unnecessary prompt
weight or suppressing the Agent's own reasoning.

## Current Verification

The focused Runtime verifies this boundary with:

1. contract tests for product output schemas
2. assembler correctness tests for decision trace projection
3. route-level tests proving debug/audit outputs match the actual guide output
4. prompt-exclusion tests proving audit/debug fields do not enter
   `agent_context.prompt_text`

# Aionis Agent Context and Audit Surfaces

Status: product usage boundary for the current focused Runtime

This document defines who should consume each product output. It does not add a
new Runtime mechanism.

## Rule

Agents consume `agent_context`.

Developers and operators inspect `memory_decision_trace` and
`memory_decision_audit`.

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

## Agent-Facing Contract

The Agent should receive only `agent_context.prompt_text`, or a host-rendered
equivalent using these fields:

1. `summary`
2. `recommended_posture`
3. `authority`
4. `target_files`
5. `use_now`
6. `inspect_before_use`
7. `do_not_use`
8. `rehydrate_hints`
9. `memory_ids`
10. `risk`

This keeps Aionis useful without turning memory internals into a rule wall.

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
5. counters, claims, risks, and source map

The audit report is intentionally operator-facing. It is not a better prompt.

## Correct Use

Typical integration flow:

1. Call `POST /v1/observe` after real work or memory input.
2. Call `POST /v1/guide`.
3. Pass only `guide.agent_context.prompt_text` or selected `agent_context`
   fields to the Agent.
4. If the Agent output looks wrong, call
   `POST /v1/debug/memory-decision-trace` with the same guide output as
   `product_trace.after_guide`.
5. If a product or customer audit is needed, call
   `POST /v1/audit/memory-decision-report`.
6. Use `POST /v1/measure` when comparing before/after guide packets or
   measuring whether history helped.

## Incorrect Use

Do not:

1. append `memory_decision_trace` to the Agent prompt
2. append `memory_decision_audit` to the Agent prompt
3. ask the Agent to reason over raw memory rows or raw slots
4. treat debug/audit output as a task solver
5. treat a single debug trace as authority to change Runtime behavior
6. expose internal route dumps as the product experience

## Why This Boundary Exists

`agent_context` is optimized for the Agent: compact, actionable, and bounded.

`memory_decision_trace` and `memory_decision_audit` are optimized for humans and
host systems: inspectable, causal, and testable.

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


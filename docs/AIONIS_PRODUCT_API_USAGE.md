# Aionis Product API Usage

Status: product API usage guide for the focused Runtime

This document explains how a host should use the four product actions:
`observe`, `guide`, `forget`, and `measure`.

It is not a new mechanism proposal. It does not define an Agent framework,
benchmark runner, repair system, or host-specific adapter. It describes the
stable product path over the current Runtime implementation.

## Route Summary

| Route | Product Action | Caller | Primary Consumer | Main Output |
|---|---|---|---|---|
| `POST /v1/observe` | `observe` | Host after real work or memory input | Runtime write path | `observed`, `structured_memory` |
| `POST /v1/guide` | `guide` | Host before the next Agent run | Agent prompt builder | `agent_context` |
| `POST /v1/forget` | `forget` | Host, operator, or product policy | Host lifecycle controller | `forget_effect` |
| `POST /v1/measure` | `measure` | Host, operator, or product evaluator | Product diagnostics | `effect_report`, optional decision trace and audit |

The Agent should consume only `agent_context.prompt_text` or selected
`agent_context` fields. Full packets, decision traces, audit reports, raw rows,
and raw slots are operator surfaces, not Agent prompt surfaces.

## Integration Flow

1. Call `POST /v1/observe` after real work, a user preference, a project fact,
   an execution trace, or a handoff should become memory.
2. Call `POST /v1/guide` before the next Agent run.
3. Pass only `agent_context.prompt_text` or selected `agent_context` fields to
   the Agent.
4. Call `POST /v1/forget` when a memory, workflow, pattern, archive, or payload
   lifecycle should change.
5. Call `POST /v1/measure` with before/after guide packets or direct
   observations when the product needs to prove whether history helped or hurt.

## `POST /v1/observe`

### Purpose

Write real memory into Aionis. This can be ordinary memory, execution memory, or
handoff state.

### Minimal Request Fields

| Field | Required | Meaning |
|---|---:|---|
| `tenant_id` | No | Tenant identity. Defaults to the Runtime environment. |
| `scope` | No | Memory scope. Defaults to the Runtime environment. |
| `input_text` | Conditional | Plain memory input. |
| `memory` | Conditional | Explicit memory object. |
| `execution` | Conditional | One execution observation. |
| `handoff` | Conditional | Resumable handoff state. |
| `auto_embed` | No | Whether the Runtime should embed written memory when a provider is configured. |

At least one of `input_text`, `memory`, `execution`, or `handoff` is required.

### Main Response Fields

| Field | Consumer | Meaning |
|---|---|---|
| `observed` | Host | Counts what was written or stored. |
| `structured_memory` | Host / audit | Shows how product input was projected into memory. |
| `memory_write` | Advanced host / audit | Internal write result. |
| `handoff` | Advanced host / audit | Internal handoff result. |
| `source_map` | Developer | Routes and surfaces used. |

The Agent should not consume the raw observe response. The observe response is
write confirmation, not guidance.

### Example

```json
{
  "tenant_id": "default",
  "scope": "payments-service",
  "auto_embed": true,
  "input_text": "Checkout migration now uses src/payments/checkout.ts. The legacy checkout route should be inspected before reuse."
}
```

## `POST /v1/guide`

### Purpose

Return compact historical context for the next Agent run.

### Minimal Request Fields

| Field | Required | Meaning |
|---|---:|---|
| `tenant_id` | No | Tenant identity. Defaults to the Runtime environment. |
| `scope` | No | Memory scope. Defaults to the Runtime environment. |
| `query_text` | Yes | What the next run needs memory for. |
| `consumer_agent_id` | No | Agent receiving the guide. |
| `limit` | No | Maximum recall breadth. |
| `include_packets` | No | Adds `memory_packet` and `guide_packet` for audit or measure. |

`POST /v1/guide` uses semantic recall, so a configured embedding provider is
required for normal product use.

### Main Response Fields

| Field | Consumer | Meaning |
|---|---|---|
| `agent_context` | Agent / host prompt builder | Default product output. |
| `memory_packet` | Host / measure / audit | Returned only with `include_packets: true`. |
| `guide_packet` | Host / measure / audit | Returned only with `include_packets: true`. |
| `source_map` | Developer | Routes and omitted internal surfaces. |

### Agent-Facing Fields

Hosts may render `agent_context.prompt_text` directly, or use these structured
fields:

1. `summary`
2. `recommended_posture`
3. `authority`
4. `target_files`
5. `use_now`
6. `inspect_before_use`
7. `do_not_use`
8. `rehydrate_hints`
9. `memory_ids`
10. `use_now_memory_ids`
11. `inspect_before_use_memory_ids`
12. `do_not_use_memory_ids`
13. `risk`

Do not pass `memory_packet`, `guide_packet`, `memory_decision_trace`,
`memory_decision_audit`, raw rows, or raw slots to the Agent by default.

### Example

```json
{
  "tenant_id": "default",
  "scope": "payments-service",
  "query_text": "Continue checkout migration and avoid stale legacy route guidance.",
  "consumer_agent_id": "agent-1",
  "limit": 8,
  "include_packets": false
}
```

## `POST /v1/forget`

### Purpose

Change memory lifecycle or payload availability without deleting source
evidence silently.

### Minimal Request Fields

| Field | Required | Meaning |
|---|---:|---|
| `operation` | Yes | `suppress`, `unsuppress`, `rehydrate`, or `activate`. |
| `reason` | Yes | Why this lifecycle action is being taken. |
| `target` | No | `memory`, `archive`, `payload`, or `pattern`. |
| `memory_ids` / `node_ids` / `client_ids` | Conditional | Required for memory activation and many rehydrate operations. |
| `anchor_id` / `anchor_uri` | Conditional | Required for pattern suppression or payload rehydration. |
| `run_id` | Conditional | Required for `activate` so feedback can be attributed to a real run. |
| `outcome` | Conditional | Required for `activate`; `positive`, `negative`, or `neutral`. |
| `used_surface` | Conditional | Required for `activate`; `use_now` or `explicit_host_assertion` is required for non-neutral feedback. |
| `verifier_status` | No | Optional run evidence: `passed`, `failed`, `not_run`, or `unknown`. |
| `tool_status` | No | Optional run evidence: `succeeded`, `failed`, `not_run`, or `unknown`. |
| `runtime_signal_refs` | No | Optional ids for concrete runtime/verifier/tool failure signals supporting the attribution. |
| `mode` | No | Suppression or rehydration mode. |

### Main Response Fields

| Field | Consumer | Meaning |
|---|---|---|
| `forget_effect` | Host / measure | Product-level effect of the lifecycle action. |
| `result` | Advanced host / audit | Internal route result. |
| `source_map` | Developer | Routes and omitted internal surfaces. |

The host should consume `forget_effect`. It should not ask the Agent to reason
over internal lifecycle rows or raw slots.

For sparse-feedback attribution, use `operation: "activate"` after a run when
the host knows which `agent_context.use_now_memory_ids` were actually used.
`run_id`, `outcome`, and `used_surface` are required. Non-neutral feedback must
use `used_surface: "use_now"` or `used_surface: "explicit_host_assertion"`; this
is the attribution gate that prevents Aionis from blaming every recalled memory
for a run outcome.

A single negative outcome without aligned verifier/tool/runtime evidence is
stored as a weak counter-signal. It does not immediately lower authority. Aionis
lowers authority or moves a memory to `inspect_before_use` only after repeated
weak counter-signals, or after one negative outcome backed by aligned evidence
such as `verifier_status: "failed"`, `tool_status: "failed"`, or concrete
`runtime_signal_refs`.

Aionis does not infer that every recalled memory caused a run outcome unless the
host reports it as used.

### Example

```json
{
  "tenant_id": "default",
  "scope": "payments-service",
  "operation": "activate",
  "target": "memory",
  "reason": "Agent used this memory successfully during the checkout continuation.",
  "memory_ids": ["mem_checkout_current"],
  "outcome": "positive",
  "run_id": "run-2026-06-06-001",
  "used_surface": "use_now",
  "verifier_status": "passed",
  "tool_status": "succeeded"
}
```

## `POST /v1/measure`

### Purpose

Measure whether history changed future behavior positively or negatively.

This route measures Aionis-owned product effects: continuity, repeated
discovery reduction, useful context ratio, stale-memory suppression,
rehydration, workflow candidate reuse, and authority blocking. It is not proof
that an external Agent solved a task unless a separate validation layer supplies
that outcome.

### Minimal Request Fields

Use one of these forms:

| Input | Required Shape | Meaning |
|---|---|---|
| Manual pair | `baseline` and `aionis` | Direct effect observations supplied by the host. |
| Product trace | `product_trace.before_guide` and `product_trace.after_guide` | Compare two guide outputs. |
| Product trace with baseline | `product_trace.baseline` and `product_trace.after_guide` | Compare manual baseline to active Aionis guide output. |

### Main Response Fields

| Field | Consumer | Meaning |
|---|---|---|
| `effect_report` | Product / operator | User-readable history impact report. |
| `measurement_input` | Developer | Inputs projected into the evaluator. |
| `memory_decision_trace` | Developer | Present when `product_trace` is supplied. |
| `memory_decision_audit` | Operator | Present when `product_trace` is supplied. |
| `kernel_report` | Advanced developer | Internal effect evaluator output. |

### Example

```json
{
  "tenant_id": "default",
  "scope": "payments-service",
  "baseline": {
    "label": "no-memory",
    "continuity": {
      "repeatedDiscoverySteps": 6,
      "recoveredStateFacts": 0,
      "expectedStateFacts": 3
    },
    "forgetting": {
      "contextItems": 0,
      "usefulContextItems": 0,
      "staleMemorySurfaced": 0
    }
  },
  "aionis": {
    "label": "aionis-guide",
    "continuity": {
      "repeatedDiscoverySteps": 1,
      "recoveredStateFacts": 3,
      "expectedStateFacts": 3
    },
    "forgetting": {
      "contextItems": 4,
      "usefulContextItems": 3,
      "staleMemorySurfaced": 0,
      "staleMemorySuppressed": 1
    },
    "learning_control": {
      "blockedAuthorityVisible": true,
      "unverifiedAuthorityApplied": 0
    }
  }
}
```

## Product Boundaries

1. Aionis remembers, guides, gates, forgets, and measures.
2. The Agent or host still owns task reasoning, tool execution, and semantic
   repair.
3. `agent_context` is the only default Agent-facing output.
4. Debug and audit outputs explain Aionis decisions; they are not prompts.
5. Full packets are available for advanced integration, measurement, and audit,
   but they are not the default prompt payload.
6. Product API usage must not depend on a specific external Agent framework.
7. Runtime behavior must not be changed because of one task result.

## Related Documents

1. [AIONIS_PRODUCT_CONTRACT.md](AIONIS_PRODUCT_CONTRACT.md)
2. [AIONIS_PRODUCT_OUTPUT_CONTRACT.md](AIONIS_PRODUCT_OUTPUT_CONTRACT.md)
3. [AIONIS_AGENT_CONTEXT_AND_AUDIT_SURFACES.md](AIONIS_AGENT_CONTEXT_AND_AUDIT_SURFACES.md)
4. [AIONIS_OBSERVE_GUIDE_AUDIT_QUICKSTART.md](AIONIS_OBSERVE_GUIDE_AUDIT_QUICKSTART.md)

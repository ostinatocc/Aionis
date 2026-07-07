# Aionis AgentContext Contract

Status: stable product contract for Agent-facing context

Updated: 2026-07-07

This document defines the single supported product meaning of "context given to
an Agent". It describes current Runtime and SDK behavior; it does not introduce
a new prompt path.

## Canonical Output

The canonical Agent-facing output is:

```text
AgentContext.agent_prompt
```

Use one of these SDK helpers:

```text
guideAgentContext().agent_prompt
execution.guideAgentContextForRole().agent_prompt
```

For direct HTTP integrations, `POST /v1/guide -> agent_context.prompt_text` is
the lower-level guide contract. Direct HTTP hosts may pass that field, or a
host-rendered prompt built only from selected `agent_context` fields.

Do not pass these surfaces directly to an Agent:

```text
memory_packet
guide_packet
memory_decision_trace
memory_decision_audit
memory_use_receipt
operator_snapshot
raw slots
raw rows
raw embeddings
```

Those are evidence, audit, debugging, and measurement surfaces.

## Runtime To SDK Boundary

The Runtime owns memory recall, lifecycle, authority, scope, rehydration, and
execution-state governance.

The SDK owns the recommended host-facing helper shape and returns:

```ts
type AgentContextResult = {
  contract_version: "aionis_sdk_agent_context_with_evidence_v1";
  agent_prompt: string;
  guide: unknown;
  agent_context: unknown;
  compiled_context: unknown;
  resolved_evidence: unknown[];
};
```

`agent_prompt` is the only field that ordinary hosts should give to the Agent by
default. The other fields exist for host logic, feedback attribution,
rehydration, audit, and debugging.

## Prompt And Evidence Separation

Aionis intentionally separates two levels:

| Surface | Purpose | Agent-facing by default |
|---|---|---|
| `agent_prompt` / `agent_context.prompt_text` | Compact governed instructions for the next Agent action. | Yes |
| `agent_context.use_now` | Structured direct-use memory lines already admitted for this turn. | Yes, through the prompt or selected fields |
| `agent_context.inspect_before_use` | Candidate or contested evidence that needs host or Agent inspection before use. | Yes, as inspection posture |
| `agent_context.do_not_use` | Blocked, stale, failed, or contradicted direction. | Yes, as negative guidance |
| `agent_context.rehydrate_hints` | Pointers to colder evidence that may need expansion. | Yes, as pointers only |
| `memory_packet` | Broader structured evidence behind recall and measurement. | No |
| `guide_packet` | Structured guide internals and workflow/evidence candidates. | No |
| decision trace / audit / snapshot | Causal explanation and operator inspection. | No |

`memory_packet` can be broader than `agent_prompt`. That is expected. The packet
may include evidence used for scoring, conflict checks, audit, or later
measurement that should not become current action text.

## Execution Memory Scope

Execution memory has stricter Agent prompt scope than ordinary memory.

For role-aware execution context, if the current guide request carries a
`task_signature`, execution-scoped memory can enter the Agent-facing prompt only
when it matches the same exact `task_signature`.

Same `workflow_signature` evidence may still appear in `memory_packet` or other
host/audit surfaces. It must not become `use_now`, `inspect_before_use`,
`do_not_use`, command posture, target files, lifecycle prompt text, or rehydrate
hints in the current Agent prompt unless it also matches the exact current
`task_signature`.

This rule prevents one task's successful or failed execution branch from
becoming another task's direct instruction just because both tasks share a broad
workflow family.

Ordinary non-execution memory, such as user preferences and stable project
facts, remains governed by the normal lifecycle, authority, scope, and premise
gates. It is not forced through exact task matching unless it carries execution
scope signals.

## Workflow Signature Role

`workflow_signature` is still useful. It helps Runtime retrieve and audit
related continuity evidence across a broader work family.

It is not sufficient by itself for current Agent action text.

Use it for:

1. candidate generation
2. audit and measurement
3. finding related workflow evidence
4. future feedback and learning analysis

Do not use it as direct prompt admission for execution memory unless the current
prompt scope also matches exact `task_signature`.

## AIONIS_CTX v2

`AIONIS_CTX v2` is the Runtime compact prompt format used by
`agent_context.prompt_text` and, by default, SDK `agent_prompt`.

It is not a second AgentContext system. It is the compact rendering of the same
governed AgentContext contract.

The supported relationship is:

```text
Runtime /v1/guide -> agent_context.prompt_text -> SDK agent_prompt -> Agent
```

MCP, AIFS, Claude Code hooks, and other integrations should call the SDK helper
or preserve this same contract instead of building a parallel final prompt.

## Feedback Attribution

Only memory IDs exposed through the guide should be eligible for normal
feedback attribution. Hosts should report:

```text
guide_trace_id
used_memory_ids
used_surface
run_id
outcome
```

Do not attribute success or failure to memory that was merely present in
`memory_packet` but not exposed to the Agent as usable guidance.

## Implementation Invariants

The current focused Runtime enforces this contract with tests that verify:

1. same-workflow but different-task execution memory can remain in
   `memory_packet`
2. same-workflow but different-task execution memory does not enter
   `AgentContext.agent_prompt`
3. SDK `execution.guideAgentContextForRole().agent_prompt` over real Runtime
   HTTP follows the same exact-task prompt boundary
4. audit/debug packets stay out of the default Agent prompt

Relevant test coverage:

```text
scripts/ci/lite-agent-context-task-scope.test.ts
scripts/ci/lite-sdk-runtime-agent-context-scope.test.ts
scripts/ci/lite-product-facade-route.test.ts
scripts/ci/lite-sdk-guide-agent-context.test.ts
```

## Change Control

Do not add another final Agent-context output unless
`AIONIS_PRODUCT_SURFACE_MATRIX.md` is updated first.

Do not make benchmark adapters, dashboard views, operator snapshots, or
debug/audit reports into Agent prompt sources.

Do not relax the exact-task execution prompt boundary based on a single task,
single benchmark, or single Agent host run.

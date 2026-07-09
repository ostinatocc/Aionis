# Aionis AgentContext Contract

Status: stable product contract for Agent-facing context

Updated: 2026-07-09

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
the lower-level Runtime guide contract. Direct HTTP hosts may pass that field,
or a host-rendered prompt built only from selected `agent_context` fields, but
the recommended default for product integrations is the SDK `agent_prompt`.

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

## Prompt Surface Registry

Aionis currently has three named prompt renderings. They are not three
different memory systems.

| Header | Owner | How it is selected | Intended use |
|---|---|---|---|
| `AIONIS_EXECUTION_AGENT_CONTEXT v1` | SDK | Default output from `guideAgentContext()` and `execution.guideAgentContextForRole()` | Recommended final prompt for Agent hosts. |
| `AIONIS_AGENT_CONTEXT v1` | Runtime | Default `POST /v1/guide -> agent_context.prompt_text` when Runtime `agent_context_mode` is standard | Lower-level HTTP guide text for hosts that do not use SDK compilation. |
| `AIONIS_CTX v2` | Runtime | Runtime compact rendering when `agent_context_mode: "compact_agent"` is requested; SDK final prompt only when `prompt_format: "runtime_compact"` is explicitly set | Explicit low-token Runtime prompt mode. |

Do not concatenate these prompt renderings. A host should pick exactly one final
Agent prompt:

1. SDK default: pass `AgentContext.agent_prompt`.
2. Raw HTTP: pass `agent_context.prompt_text` or selected structured fields.
3. Explicit low-token SDK mode: set `prompt_format: "runtime_compact"` and pass
   the returned `agent_prompt`.

`context_mode: "compact_agent"` only asks Runtime for compact base guide text.
It does not by itself switch the SDK final prompt away from
`AIONIS_EXECUTION_AGENT_CONTEXT v1`.

## Prompt And Evidence Separation

Aionis intentionally separates two levels:

| Surface | Purpose | Agent-facing by default |
|---|---|---|
| `agent_prompt` | SDK-rendered execution contract built from Runtime `agent_context`, command posture, route contract, and optional resolved evidence. It does not concatenate Runtime `prompt_text` by default. | Yes |
| `agent_context.prompt_text` | Runtime guide text. Default standard mode renders `AIONIS_AGENT_CONTEXT v1`; compact mode renders `AIONIS_CTX v2`. | Yes, only for direct HTTP or explicit compact mode |
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

For role-aware execution context, direct current-action guidance (`use_now` /
`should_continue`) is reserved for execution evidence that Runtime can treat as
current for this task:

1. exact `task_signature` matches
2. accepted / passed same-`workflow_signature` continuation evidence that the
   route contract promotes as an active continuation

Broad `task_family` evidence, different-workflow evidence, rejected branches,
failed branches, stale branches, and contested evidence may still appear as
candidate, inspection, negative, or rehydrate guidance when governance admits it.
They must not become direct current-action guidance just because they are
nearby.

This rule prevents unrelated execution branches from becoming current
instructions while preserving the core execution-memory behavior: accepted
continuations can remain executable state.

Ordinary non-execution memory, such as user preferences and stable project
facts, remains governed by the normal lifecycle, authority, scope, and premise
gates. It is not forced through exact task matching unless it carries execution
scope signals.

## Workflow Signature Role

`workflow_signature` is still useful. It helps Runtime retrieve, rank, and audit
related continuity evidence across a broader work family.

It is not sufficient by itself for current Agent action text. Direct prompt
admission still requires accepted / passed continuation semantics and route
contract admission.

Use it for:

1. candidate generation
2. audit and measurement
3. finding related workflow evidence
4. future feedback and learning analysis

Do not use it as direct prompt admission for execution memory merely because it
matches. Same-workflow evidence becomes direct guidance only when the Runtime
route contract admits it as an accepted / passed continuation.

## AIONIS_CTX v2

`AIONIS_CTX v2` is the Runtime compact prompt format used by
`agent_context.prompt_text` only when compact Runtime rendering is selected.

It is not a second AgentContext system. It is the compact Runtime rendering of
the same governed AgentContext contract. SDK `agent_prompt` defaults to a
single SDK execution contract. It must not append `AIONIS_AGENT_CONTEXT v1` or
`AIONIS_CTX v2`. Runtime prompt text becomes the SDK final prompt only when a
host explicitly sets `prompt_format: "runtime_compact"`.

The supported relationship is:

```text
Runtime /v1/guide -> SDK AgentContext renderer -> agent_prompt -> Agent
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

1. accepted exact-task execution memory remains direct `use_now` /
   `should_continue` guidance even when lifecycle text contains stale or
   rehydrate wording
2. accepted same-workflow continuation evidence can remain direct
   `should_continue` guidance when the route contract admits it
3. broad family-only, rejected, stale, failed, or contested evidence stays out
   of direct current-action guidance
4. SDK `guideAgentContext().agent_prompt` defaults to
   `AIONIS_EXECUTION_AGENT_CONTEXT v1` and does not append Runtime
   `AIONIS_AGENT_CONTEXT v1` or `AIONIS_CTX v2`
5. SDK `execution.guideAgentContextForRole().agent_prompt` over real Runtime
   HTTP follows the same AgentContext prompt-surface boundary
6. audit/debug packets stay out of the default Agent prompt

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

Do not relax execution-memory prompt admission based on a single task, single
benchmark, or single Agent host run.

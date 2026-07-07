# Aionis Host Integration

Status: product integration guide for external Agent hosts

This document explains how an external Agent host should wire Aionis into a
real execution loop. It documents the supported product path over the current
Runtime implementation and adapters.

For route-level request and response details, see
[AIONIS_PRODUCT_API_USAGE.md](AIONIS_PRODUCT_API_USAGE.md). For stable output
schemas, see [AIONIS_PRODUCT_OUTPUT_CONTRACT.md](AIONIS_PRODUCT_OUTPUT_CONTRACT.md).
For recall source diagnostics, mode selection, and guide troubleshooting, see
[AIONIS_RECALL_ENGINE_RUNBOOK.md](AIONIS_RECALL_ENGINE_RUNBOOK.md).

## Runtime Editions

Use the right deployment posture before wiring an Agent host:

| Edition | Host shape | Boundary |
|---|---|---|
| `lite` | Local SDK/MCP clients on the same developer machine | Defaults to `AIONIS_MODE=local`, loopback, `MEMORY_AUTH_MODE=off`, and no tenant quota for same-machine developer flows. |
| `server` | Remote SDK/MCP clients connecting to a managed endpoint | Requires `AIONIS_MODE=service` and authenticated access with `api_key`, `jwt`, or `api_key_or_jwt` unless an explicit development override is set. |
| `cloud` | Future hosted packaging label | Reserved for future hosted packaging; this guide focuses on Lite and Server integration. |

For `APP_ENV=prod`, Server also requires authority receipt HMAC key material.
Use `AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID` for the signing key and
`AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON` as a keyring. During rotation, add the
new key, switch the active key id, and keep the old key until existing
authority receipts no longer need verification.

The keyring is a Runtime/operator secret, not an Agent API key. It signs
`authority_receipt_v1` after the Runtime has evaluated the authority gate, and
write guards verify that receipt before accepting authority-bearing memory such
as `contract_trust: "authoritative"` or stable promotions. Generate secrets
outside the repository, keep them in the host secret manager, and use at least
32 bytes of entropy. The Runtime allows an ephemeral key only outside
production, so a Server process can run locally without provisioning key
material while production remains fail-closed.

Recommended rotation:

1. Add the new key to `AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON`.
2. Point `AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID` at the new key.
3. Deploy all Runtime instances with both old and new keys.
4. Remove the old key only after old authority receipts no longer need to be
   verified.

### Managed Server Hybrid Recall Check

Server Edition keeps the same governance contract as Lite and exposes it to
remote SDK or MCP clients behind an authenticated endpoint. The Server path
keeps recall and admission separated: semantic, lexical, structured,
execution-native, ANN, Substrate sidecar, graph, and recent sources propose
candidates, while the product layer decides `use_now`, `inspect_before_use`,
`do_not_use`, and `rehydrate`.

`RECALL_ENGINE_MODE=hybrid` is the Server default. Lite keeps
`RECALL_ENGINE_MODE=semantic_scan` by default and can opt into hybrid for local
testing. The mode controls candidate retrieval only; hosts should still rely on
the compiled guide surfaces rather than raw recall hits.

Run the managed-server hybrid recall e2e when changing Server registration,
SDK auth, recall sources, source tracing, or product admission output:

```bash
npm run -s runtime:e2e:managed-server-hybrid-recall
```

The e2e starts a temporary Server Edition instance with API key auth, writes an
execution history with accepted, failed, stale, lexical, and structured
signals, calls `guide` and Agent Flight Recorder through `createAionisClient`,
then verifies:

1. accepted execution memory reaches `use_now`
2. failed and stale branches stay out of direct use
3. at least two recall source families are visible in trace
4. `memory_use_receipt` and admission reasons are available for audit
5. `operator_snapshot` includes the guide trace and receipt
6. Agent Flight Recorder replays accepted, failed, and stale recall source
   traces without including Agent prompt payload

The committed example result lives at
[`docs/examples/managed-server-hybrid-recall-result.json`](examples/managed-server-hybrid-recall-result.json).

## Integration Contract

Aionis is a memory and execution-learning Runtime. The host runs task
orchestration, tool execution, model calls, retries, and final task completion.
Aionis provides memory visibility, compact guidance, controlled lifecycle
changes, feedback attribution, and measurement.

The standard host loop is:

```text
observe -> guide -> agent action -> outcome feedback -> measure -> snapshot
```

Use the product routes directly when integrating over HTTP:

| Step | Route | Host Responsibility | Aionis Responsibility |
|---|---|---|---|
| `observe` | `POST /v1/observe` | Report real memory, execution, outcome, or handoff evidence. | Persist scoped evidence and execution memory. |
| `guide` | `POST /v1/guide`, SDK `guideAgentContext()` | Ask for context before the next Agent acts. | Return compact `agent_context`; SDK full path can also resolve `inspect_before_use` and `rehydrate` evidence into the compiled prompt. |
| `agent action` | Host-owned | Give the Agent SDK `agent_prompt`; direct HTTP hosts may use only `agent_context.prompt_text` or selected `agent_context` fields. | Preserve memory/action separation while the host executes tools. |
| `outcome feedback` | SDK `feedback()`, adapter `afterRun`, or raw `POST /v1/feedback` | Report which exposed memory IDs were actually used and what happened. | Attribute feedback only to exposed and reported memory. |
| `measure` | `POST /v1/measure` | Provide before/after guide packets or product trace. | Report whether history helped or hurt. |
| `snapshot` | `POST /v1/operator/snapshot` | Ask for read-only operator state. | Summarize active context, attribution, and measured effect. |

Low-level `POST /v1/memory/write` remains available for internal adapters and
advanced hosts. For recallable writes, check `recallable_node_count`; `0` means
the request was accepted as a low-level event or warning surface rather than a
new recallable memory.

## Agent Surface

The Agent should receive one of these, in this order:

1. SDK `guideAgentContext().agent_prompt` when using the TypeScript SDK.
2. SDK `execution.guideAgentContextForRole().agent_prompt` for role-aware execution memory.
3. Lower-level `guide.agent_context.prompt_text` only when integrating directly over HTTP.
4. a host-rendered prompt built only from selected `agent_context` fields.

Keep these surfaces for host logs, measurement, and operator inspection:

1. `memory_packet`
2. `guide_packet`
3. `memory_decision_trace`
4. `memory_decision_audit`
5. `memory_use_receipt`
6. raw rows or raw slots
7. operator snapshot markdown

They are designed for host measurement, developer debugging, and operator
inspection rather than direct Agent instruction.

`memory_use_receipt` is the host-facing audit receipt for memory use. It is
returned inside `memory_decision_trace` and `operator_snapshot`, and records
the memory IDs exposed as `use_now`, `inspect_before_use`, `do_not_use`, or
`rehydrate`, plus feedback attribution and read-only risk flags. It is useful
for logs, dashboards, and support diagnostics as the audit companion to the
Agent prompt.

Premise Firewall warnings are delivered through the same guide boundary. If a
user query carries a stale or blocked premise and Aionis has newer/current
counter-evidence, `POST /v1/guide` adds `premise_firewall_*` entries to
`agent_context.risk.reasons` and moves the relevant memory IDs to
`inspect_before_use` or `do_not_use`. Hosts should pass only the resulting
`agent_context` surface to the Agent and keep trace/receipt details for audit.

Memory Contract is also delivered through `POST /v1/guide` and
`memory_packet.relevant_memories[].memory_contract` when packets are included.
Use the compiled `agent_context` fields for prompts and use contract reason
codes or receipt risk flags for audit logs.

Execution transition intent is delivered through
`memory_packet.relevant_memories[].execution_state.transition_kind` when packets
are included and through the compact `AIONIS_CTX v2` prompt line. Hosts should
treat `handoff_to_actor` as a routing/acceptance signal, `resume_current_state`
as continuation, `avoid_failed_branch` as counter-evidence only, and
`request_rehydrate` as a pointer-expansion signal. In aggressive prompt mode the
same line may use short labels such as `tr=accept_handoff`, `act=...`,
`role=...`, and `to=...`. The current `agent_role` matches the handoff target
when `tr=accept_handoff`, but the lifecycle gate still applies. Full memory IDs
remain in `agent_context` structured fields, so hosts can attribute memory use
without making the Agent prompt carry UUIDs.

Hosts that need a shorter Agent prompt can request
`context_mode: "compact_agent"` on `/v1/guide`, SDK `guideAgentContext()`, SDK
`execution.guideAgentContextForRole()`, `createExecutionMemoryAdapter().guideAgentContext()`,
host templates that pass through guide input, or MCP `aionis_context`. This
keeps the same governed `use_now`, `inspect_before_use`, `do_not_use`,
`rehydrate_hints`, `command_posture`, and memory ID fields, but renders a
tighter contract-style prompt for the Agent. The SDK full path resolves
recoverable evidence pointers before compiling the final prompt. Receipts,
traces, packets, and operator snapshots remain available for host logs.

`command_posture` is the host-readable instruction posture for the same
governed surfaces. Use `must_not` to block failed/stale branches,
`should_continue` to bias the Agent toward a current active state or accepted
procedure, `inspect_first` for contested/candidate history, `rehydrate_first`
for raw evidence pointers, and `optional_context` for ordinary context. It is a
policy-safe control hint while hosts own tool execution and escalation.

Trace-to-Procedure readiness is delivered through
`operator_snapshot.trace_to_procedure`, not through the Agent prompt. Hosts can
use it for run logs, dashboards, support diagnostics, or workflow review: it
shows which existing execution-memory surfaces are visible and whether reuse is
stable, candidate-only, blocked, or still insufficient.

## `history_used` vs `actionable_history_used`

`history_used` means the Aionis history/context channel participated in guide
assembly.

`actionable_history_used` is stricter. It should be true only when the Agent
actually received memory-backed guidance, rehydration hints, or execution-state
branches that can affect the next action.

Common cases:

| Case | `history_used` | `actionable_history_used` | Host Behavior |
|---|---:|---:|---|
| Fresh scope, no usable memory | `true` can appear at `agent_context` level because the channel is enabled | `false` | Treat as no actionable memory. |
| Ordinary active preference/fact is in `use_now` | `true` | `true` | Agent may use it according to `authority`. |
| Candidate or contested memory is in `inspect_before_use` | `true` | `true` | Agent must inspect before relying on it. |
| Failed execution branch is in `do_not_use` | `true` | `true` | Agent must avoid copying it as next action. |
| Premise Firewall flags stale or blocked premise | `true` | `true` | Agent should inspect or avoid that premise; host should log the risk flag. |
| Operator snapshot is read after useful guide | `true` | `true` | Operator can see that history affected the run. |

Hosts should use `actionable_history_used` for product decisions such as
"Aionis gave the Agent useful next-action memory." Use `history_used` for
observability of whether the context channel was invoked.

## Identity and Visibility Rules

Aionis visibility depends on producer, owner, consumer, team, and lane.

| Integration | Lane | Required Identity | Meaning |
|---|---|---|---|
| Single Agent memory | `memory_lane: "private"` | `owner_agent_id` on writes; `consumer_agent_id` on guide | Only the same Agent should retrieve it. |
| Team-private memory | `memory_lane: "private"` | `owner_team_id` on writes; `consumer_team_id` on guide | Visible only inside that team, but not scope-wide shared memory. |
| Scope-wide shared memory | `memory_lane: "shared"` without `owner_team_id` | `producer_agent_id` recommended | Visible within the scope. |
| Multi-Agent team memory | `memory_lane: "shared"` with `owner_team_id` | `owner_team_id` on writes; `consumer_team_id` on guide | Planner, worker, verifier, and reviewer share memory inside one team. |
| Feedback attribution | Any | `guide_trace_id`, `used_memory_ids`, `run_id`, `outcome`, `used_surface` | Aionis attributes feedback only to memory exposed by that guide and reported as used. |

Recommended identity setup:

1. Use team boundaries for team-private multi-agent state.
2. Use team-private or team-owned shared memory when multiple Agents in one team
   must read the same handoff.
3. Report feedback for memory IDs the host knows were used.
4. Keep `guide_trace_id` and `last_use_now_memory_ids` in host state for
   attribution and audit.

## Adapter Path

Prefer the TypeScript adapter when the host is written in Node or TypeScript.
It keeps product defaults consistent:

1. `guideNext` uses full-power guide mode by default.
2. role, agent, team, tenant, and scope are carried on calls.
3. the latest execution tree is reused when the host observes a handoff tree.
4. `observeOutcome` can submit feedback through the latest `guide_trace_id`.
5. `measureRun` and `operatorSnapshotRun` reuse stored guide and feedback state.

```ts
import { createAionisClient } from "@aionis/sdk";
import { createExecutionMemoryAdapter } from "./src/adapters/index.ts";

const client = createAionisClient({
  baseUrl: process.env.AIONIS_URL ?? "http://127.0.0.1:3001",
  apiKey: process.env.AIONIS_API_KEY,
  tenant_id: "default",
  scope: "checkout-migration",
});

const memory = createExecutionMemoryAdapter({
  client,
  tenant_id: "default",
  scope: "checkout-migration",
  default_agent_id: "agent-1",
  default_agent_role: "agent",
  default_memory_lane: "private",
});
```

Use the adapter directly when the host already has its own lifecycle state
machine. Use host templates when the host wants Aionis to preserve the common
guide/feedback state between hooks.

## Host Templates

Host templates sit on top of `createExecutionMemoryAdapter`. They provide hook
names and preserve `HostRunState` so the next hook can attribute feedback to
the exact guide trace and `use_now` memory IDs the Agent saw.

Template contract version: `aionis_host_integration_template_v1`.

| Template | Use When | Hooks |
|---|---|---|
| `createGenericAgentHostTemplate` | One Agent loop needs private memory and feedback attribution. | `startRun`, `observeStep`, `beforeRun`, `afterRun`, `measure`, `snapshot` |
| `createMultiAgentHostTemplate` | Planner, worker, verifier, and reviewer share execution memory under one team. | `plannerStart`, `workerStep`, `verifierStep`, `reviewerGuide`, `reviewerOutcome`, `measure`, `snapshot` |
| `createCodingAgentHostTemplate` | A coding Agent needs repository and target-file context around patch execution. | `beforePatch`, `afterPatch`, `measure`, `snapshot` |

`HostRunState` belongs in the host runtime, database, queue job, or
orchestration state for attribution and replay.

## Single-Agent Template

Use private memory for one Agent's preferences, facts, and ordinary execution
continuity.

```ts
import {
  createExecutionMemoryAdapter,
  createGenericAgentHostTemplate,
} from "./src/adapters/index.ts";
import { createAionisClient } from "@aionis/sdk";

const client = createAionisClient({
  baseUrl: process.env.AIONIS_URL ?? "http://127.0.0.1:3001",
  tenant_id: "default",
  scope: "single-agent-project",
});

const memory = createExecutionMemoryAdapter({
  client,
  tenant_id: "default",
  scope: "single-agent-project",
  default_agent_id: "agent-1",
  default_agent_role: "agent",
  default_memory_lane: "private",
});

const hostMemory = createGenericAgentHostTemplate(memory, {
  agent_id: "agent-1",
  role: "agent",
  mode: "full_power",
  include_packets: true,
  limit: 10,
});

const before = await hostMemory.beforeRun({
  run_id: "run-001",
  task_signature: "status-update",
  query_text: "What memory should shape this status update?",
});

// Give only this to the Agent, or render selected agent_context fields.
const promptContext = before.agent_context;

const finished = await hostMemory.afterRun({
  state: before.state,
  run_id: "run-001-result",
  task_signature: "status-update",
  title: "Status update completed",
  summary: "Agent followed the active response preference.",
  outcome: "succeeded",
});

await hostMemory.measure({
  state: finished.state,
  run_id: "run-001",
  task_signature: "status-update",
});

await hostMemory.snapshot({
  state: finished.state,
  run_id: "run-001",
  task_signature: "status-update",
  include_markdown: true,
});
```

When writing private memory directly through `/v1/observe`, include both the
producer and owner identity:

```json
{
  "tenant_id": "default",
  "scope": "single-agent-project",
  "auto_embed": true,
  "memory_lane": "private",
  "producer_agent_id": "agent-1",
  "owner_agent_id": "agent-1",
  "memory": {
    "client_id": "status-update-pref",
    "type": "rule",
    "memory_kind": "general_memory",
    "title": "Status update preference",
    "text_summary": "Use concise bullets and cite concrete evidence.",
    "confidence": 0.9
  }
}
```

Release validation:

```bash
npm run -s runtime:e2e:single-agent-host-template
```

This e2e verifies fresh-scope `actionable_history_used: false`, private ordinary
memory recall, feedback attribution, positive measurement, and operator
snapshot visibility over a real Runtime.

## Multi-Agent Template

Use shared team memory when multiple roles need one execution memory.

```ts
import {
  createExecutionMemoryAdapter,
  createMultiAgentHostTemplate,
} from "./src/adapters/index.ts";
import { createAionisClient } from "@aionis/sdk";

const client = createAionisClient({
  baseUrl: process.env.AIONIS_URL ?? "http://127.0.0.1:3001",
  tenant_id: "default",
  scope: "checkout-migration",
});

const memory = createExecutionMemoryAdapter({
  client,
  tenant_id: "default",
  scope: "checkout-migration",
  team_id: "checkout-agent-team",
  default_memory_lane: "shared",
});

const hostMemory = createMultiAgentHostTemplate(memory, {
  team_id: "checkout-agent-team",
  mode: "full_power",
  include_packets: true,
  limit: 10,
});

const planned = await hostMemory.plannerStart({
  run_id: "checkout-run-001",
  task_signature: "checkout-migration",
  agent_id: "planner-1",
  title: "Plan checkout migration",
  summary: "Worker should edit src/payments/checkout.ts and verifier should reject broad legacy patches.",
});

const worker = await hostMemory.workerStep({
  state: planned.state,
  run_id: "checkout-run-001",
  task_signature: "checkout-migration",
  agent_id: "worker-1",
  title: "Worker scoped checkout patch",
  summary: "Worker changed the scoped checkout target.",
  outcome: "succeeded",
  target_files: ["src/payments/checkout.ts"],
});

const reviewer = await hostMemory.reviewerGuide({
  state: worker.state,
  run_id: "checkout-run-001",
  task_signature: "checkout-migration",
  agent_id: "reviewer-1",
  query_text: "Continue the active checkout branch and avoid failed branches.",
});

await hostMemory.reviewerOutcome({
  state: reviewer.state,
  run_id: "checkout-reviewer-001",
  task_signature: "checkout-migration",
  agent_id: "reviewer-1",
  title: "Reviewer continued active checkout branch",
  summary: "Reviewer used Aionis context and avoided the failed branch.",
  outcome: "succeeded",
});
```

Release validation:

```bash
npm run -s runtime:quickstart:multi-agent
npm run -s runtime:e2e:multi-agent-host-template
npm run -s runtime:e2e:multi-agent-host-template-fresh
```

The quickstart prints the compact developer-facing result for SDK client,
execution-memory adapter, and multi-agent host-template wiring. The release
e2es verify shared team memory, planner/worker/verifier/reviewer role state,
passed-branch reuse, failed-branch isolation, feedback attribution, fresh-scope
negative control, and operator snapshot visibility over a real Runtime.

## Coding-Agent Template

Use the coding template when the host needs to carry repository and target-file
context around a patch attempt.

```ts
import {
  createCodingAgentHostTemplate,
  createExecutionMemoryAdapter,
} from "./src/adapters/index.ts";
import { createAionisClient } from "@aionis/sdk";

const client = createAionisClient({
  baseUrl: process.env.AIONIS_URL ?? "http://127.0.0.1:3001",
  tenant_id: "default",
  scope: "checkout-repo",
});

const memory = createExecutionMemoryAdapter({
  client,
  tenant_id: "default",
  scope: "checkout-repo",
  team_id: "checkout-agent-team",
  default_memory_lane: "shared",
});

const hostMemory = createCodingAgentHostTemplate(memory, {
  team_id: "checkout-agent-team",
  mode: "full_power",
  include_packets: true,
});

const beforePatch = await hostMemory.beforePatch({
  run_id: "patch-run-001",
  task_signature: "checkout-patch",
  agent_id: "coding-agent-1",
  repo_root: "/work/checkout",
  target_files: ["src/payments/checkout.ts"],
  patch_goal: "Keep checkout migration scoped to the current target.",
  query_text: "Patch checkout without repeating failed broad-search branches.",
});

// Pass only beforePatch.agent_context to the coding Agent.

await hostMemory.afterPatch({
  state: beforePatch.state,
  run_id: "patch-run-001",
  task_signature: "checkout-patch",
  agent_id: "coding-agent-1",
  title: "Checkout patch completed",
  summary: "Patch changed only the checkout target and tests passed.",
  outcome: "passed",
  changed_files: ["src/payments/checkout.ts"],
});
```

The coding template is a host integration convenience. Repository-specific fixes
and verifier expectations belong in observed evidence, while Aionis keeps the
template generic and reusable across coding hosts.

## Direct HTTP Feedback Attribution

Hosts integrating directly over HTTP should preserve the same attribution
contract.

After `/v1/guide`, store:

1. `guide_trace_id`
2. `agent_context.use_now_memory_ids`
3. `agent_context.inspect_before_use_memory_ids`
4. `agent_context.do_not_use_memory_ids`

After the Agent acts, report only IDs actually used:

```json
{
  "tenant_id": "default",
  "scope": "checkout-migration",
  "operation": "activate",
  "target": "memory",
  "actor": "reviewer-1",
  "guide_trace_id": "guide_trace:...",
  "used_memory_ids": ["mem_checkout_current"],
  "run_id": "reviewer-run-001",
  "outcome": "positive",
  "used_surface": "use_now",
  "verifier_status": "passed",
  "tool_status": "succeeded",
  "reason": "Reviewer used the active checkout memory successfully."
}
```

Aionis rejects memory IDs that were not exposed by that guide trace. Exposed
but unreported memory remains unattributed rather than blamed or rewarded for
the run outcome.

## Operator Snapshot

Use operator snapshot after guide/feedback/measure when a human or host system
needs to inspect what happened.

The snapshot is read-only. It should show:

1. whether actionable history was used
2. current active path, passed solutions, and failed branches when execution
   context is present
3. feedback attribution status
4. learning-control posture
5. measured effect direction
6. trace-to-procedure readiness for reusable workflow/procedure memory

It belongs to host/operator inspection, incident review, and product metrics.

## Release Checklist

Before treating a host integration change as stable, run:

```bash
npm run -s typecheck
npm run -s lite:test
npm run -s runtime:quickstart:sdk
npm run -s runtime:e2e:ordinary-memory
npm run -s runtime:e2e:golden-product-loop
npm run -s runtime:e2e:managed-server-hybrid-recall
npm run -s runtime:quickstart:multi-agent
npm run -s runtime:e2e:single-agent-host-template
npm run -s runtime:e2e:multi-agent-host-template
npm run -s runtime:e2e:multi-agent-host-template-fresh
npm run -s runtime:e2e:agent-suite
```

The Runtime e2es require a real embedding provider. For local runs, configure
`EMBEDDING_PROVIDER` and the matching provider key. The e2es start isolated
local Runtime instances unless `AIONIS_PRODUCT_E2E_BASE_URL`,
`AIONIS_MULTI_AGENT_E2E_BASE_URL`, `AIONIS_BASE_URL`, or `AIONIS_URL` points to
an already running Runtime.

`runtime:e2e:agent-suite` also requires a real chat-completions LLM through
`AIONIS_AGENT_E2E_API_KEY`, `DEEPSEEK_API_KEY`, or `OPENROUTER_API_KEY`. It is
the product-level downstream Agent demo: it verifies that Aionis gives a real
LLM shorter execution context, restores the verified active path, blocks failed
branch leakage, and records evidence-backed feedback while the host remains the
execution environment.

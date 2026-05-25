# @ostinato/aionis

`@ostinato/aionis` is the public SDK for integrating Aionis Runtime into a coding agent or local agent runtime.

Current release line: `0.4.0` for the Aionis Lite Developer Preview.

Use it when you want an agent to:

- start repeated tasks with a better first action
- rehydrate archived execution memory back into the active working set
- record node reuse outcomes on Lite memory nodes
- store and recover structured handoffs
- turn successful runs into replayable playbooks
- inspect continuity state through typed runtime contracts

## Install

```bash
npm install @ostinato/aionis
```

<!-- BEGIN:CORE_PATH -->

## Default Product Path

| Path | What To Prove | Primary Surfaces |
| --- | --- | --- |
| Core | Continuity works at all | `memory.write(...)`, `memory.taskStart(...)` or `memory.planningContext(...)`, `handoff.store(...)`, `memory.replay.run.*` |
| Enhanced | Continuity improves over time | `memory.archive.rehydrate(...)`, `memory.nodes.activate(...)`, `memory.reviewPacks.*`, `memory.sessions.*` |
| Advanced | The runtime exposes deeper learning and control | `memory.experienceIntelligence(...)`, `memory.executionIntrospect(...)`, `memory.delegationRecords.*`, `memory.tools.*`, `memory.rules.*`, `memory.patterns.*` |

Recommended order:

1. prove the Core path first
2. add the Enhanced path when reuse quality matters
3. move into the Advanced path only when your host needs deeper substrate controls

Fastest repository proof:

```bash
npm run example:sdk:core-path
```

<!-- END:CORE_PATH -->

## What The SDK Covers

- memory write / recall / planning / context assembly
- explicit action retrieval, uncertainty, and operator-facing gate surfaces
- kickoff recommendation, task-start, task-start-plan, execution outcome, and workflow-contract facades
- archive rehydrate and node activation lifecycle surfaces
- replay run lifecycle and playbook operations
- handoff storage and recovery
- sandbox session, execution, and run inspection
- sessions, packs, review packs, rule/tool operator surfaces
- agent-memory inspect, review, resume, and handoff packs
- host bridge integration

## Usage

```ts
import { createAionisClient } from "@ostinato/aionis";

const aionis = createAionisClient({
  baseUrl: "http://127.0.0.1:3001",
});

const taskStart = await aionis.memory.taskStart({
  tenant_id: "default",
  scope: "default",
  query_text: "debug the failed replay run",
  context: {
    goal: "debug the failed replay run",
  },
  candidates: ["read", "bash", "edit", "test"],
});

console.log(taskStart.first_action);

const taskStartPlan = await aionis.memory.taskStartPlan({
  tenant_id: "default",
  scope: "default",
  query_text: "debug the failed replay run",
  context: {
    goal: "debug the failed replay run",
  },
  candidates: ["read", "bash", "edit", "test"],
});

console.log(taskStartPlan.first_action);
console.log(taskStartPlan.gate_action);
```

After execution, a host can store the validated outcome and optionally compile/simulate a replay playbook without manually stitching replay routes:

```ts
const outcome = await aionis.memory.storeExecutionOutcome({
  tenant_id: "default",
  scope: "default",
  actor: "sdk-host",
  goal: "debug the failed replay run",
  status: "success",
  steps: [{
    tool_name: "bash",
    tool_input: { argv: ["npm", "run", "-s", "test:lite"] },
    status: "success",
    output_signature: { summary: "lite validation passed" },
  }],
  compile_playbook: true,
  simulate_playbook: true,
});

const workflow = await aionis.memory.retrieveWorkflowContract({
  tenant_id: "default",
  scope: "default",
  file_path: "src/routes/replay.ts",
});

console.log(outcome.run_id);
console.log(workflow.authority_summary);
```

`retrieveWorkflowContract` returns the stable workflow contract and authority summary by default. The full execution
introspection payload is debug-only; request it explicitly with `include_introspection: true` when building operator
diagnostics.

Explicit action-retrieval example:

```ts
const retrieval = await aionis.memory.actionRetrieval({
  tenant_id: "default",
  scope: "default",
  query_text: "debug the failed replay run",
  context: {
    goal: "debug the failed replay run",
  },
  candidates: ["read", "bash", "edit", "test"],
});

console.log(retrieval.selected_tool);
console.log(retrieval.recommended_next_action);
console.log(retrieval.uncertainty);
```

Lite runtime lifecycle example:

```ts
await aionis.memory.archive.rehydrate({
  tenant_id: "default",
  scope: "demo-sdk",
  client_ids: ["billing-timeout-repair"],
  target_tier: "warm",
  reason: "bring the archived repair memory back into the active set",
});

await aionis.memory.nodes.activate({
  tenant_id: "default",
  scope: "demo-sdk",
  client_ids: ["billing-timeout-repair"],
  outcome: "positive",
  activate: true,
  reason: "the rehydrated node helped complete the repair",
});
```

## Local Workflow

Recommended standalone runtime path:

```bash
npx @ostinato/aionis-runtime@latest start
```

If you are working from this repository and want the bundled examples:

```bash
cd /path/to/AionisRuntime
npm install
npm run sdk:build
npm run lite:start
```

Then try one of the bundled examples:

```bash
npm run example:sdk:core-path
npm run example:sdk:recall
npm run example:sdk:replay
npm run example:sdk:sessions
npm run example:sdk:host-bridge
npm run example:sdk:agent-memory
npm run example:sdk:action-retrieval
npm run example:sdk:continuity-provenance
```

Proof demos for the self-evolving claim:

```bash
npm run example:sdk:task-start-proof
npm run example:sdk:policy-memory
npm run example:sdk:policy-learning-control
WORKFLOW_LEARNING_CONTROL_STATIC_PROMOTE_MEMORY_PROVIDER_ENABLED=true npm run lite:start
npm run example:sdk:continuity-provenance
npm run example:sdk:session-continuity
npm run example:sdk:semantic-forgetting
```

Agent-memory façade example:

```ts
const inspect = await aionis.memory.agent.inspect({
  tenant_id: "default",
  scope: "demo-sdk",
  query_text: "repair export mismatch in src/routes/export.ts",
  context: {
    goal: "repair export mismatch in src/routes/export.ts",
  },
  candidates: ["bash", "edit", "test"],
  file_path: "src/routes/export.ts",
});

console.log(inspect.agent_memory_summary);
```

## Next Reads

1. [SDK Quickstart](../../docs/SDK_QUICKSTART.md)
2. [Bundled SDK Examples](../../examples/full-sdk/README.md)
3. [Docs Overview](../../docs/README.md)

## Release Checks

```bash
npm run sdk:test
npm run sdk:pack:dry-run
npm run sdk:publish:dry-run
npm run sdk:release:check
```

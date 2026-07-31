# Aionis

**Execution Memory for any Agent.**

Aionis lets an Agent stop, restart, hand work to another Agent, switch models,
or lose its chat history without starting the task again.

It does not replay an entire transcript. The Runtime preserves the exact task
and subject identity, verified and failed branches, decisive evidence,
unfinished work, pending checks, and the next justified action. It then
reconstructs a compact current execution state for the next Agent.

## What the product does

The default product loop is:

```text
AgentSession
-> current execution state
-> Agent action
-> immutable candidate branch
-> Runtime-launched verifier
-> complete or restore the best accepted branch
-> outcome
-> future state and experience
```

For an active task, Aionis:

- preserves execution state across interruption, restart, handoff, and model
  change;
- keeps verifier truth above Agent or Host declarations;
- retains both successful and failed candidate branches;
- automatically restores an exact previously accepted snapshot after a later
  branch regresses;
- renders one compact Runtime-owned continuation context;
- stores ordinary facts, preferences, project context, procedures, events,
  and evidence;
- attributes feedback only to memory that was actually delivered and used;
- suppresses, restores, rehydrates, or retires memory without deleting its
  provenance.

Aionis is model-independent. A normal application developer can put it around
an existing tool-using Agent; the Agent does not need to be built on a specific
framework.

## Current product effect

On the predeclared three-task continuity set run on 2026-07-31, every arm used
the same real DeepSeek model configuration, repository tools, 100,000-token
budget, starting state, and Runtime-launched hidden verifier.

| Task | Full History | Cold Restart | Aionis State |
|---|---:|---:|---:|
| Starlette URL replacement | pass; 29,373 input tokens | fail; 106,732 input tokens | pass; 23,606 input tokens |
| HTTPX empty Zstandard response | pass; 100,071 input tokens | fail; 107,126 input tokens | pass; 98,612 input tokens |
| pytest code flags | fail; 27,205 input tokens | fail; 103,247 input tokens | fail; 102,864 input tokens |

For the two tasks Full History could complete:

- Aionis preserved both verifier-confirmed completions;
- median input tokens fell from 64,722 to 61,109, a 5.6% reduction;
- continuation context was 55.1% smaller on Starlette and 84.5% smaller on
  HTTPX;
- Cold Restart completed neither task.

The pytest task is not a win: all three arms failed, and Aionis spent more
tokens than the early incorrect Full History run. Across all three tasks,
Aionis does not have a lower token median. These results establish a real
continuity effect, not broad product proof.

Raw provider receipts, workspaces, Runtime ledgers, and verifier outputs are
under:

```text
/Volumes/ziel/aionis-real-runs/convergence-refactor-20260731-v7/
```

The execution and convergence record is
[`docs/plans/2026-07-31-aionis-execution-memory-convergence-refactor.md`](docs/plans/2026-07-31-aionis-execution-memory-convergence-refactor.md).

## Start the Runtime

Requirements:

- Node.js 22.15+ or 23.10+;
- a local writable directory for Runtime SQLite;
- provider credentials only for the capabilities you enable.

```bash
npm install
npm run -s lite:start
```

The local Runtime listens on `http://127.0.0.1:3001` by default.

```bash
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:3001/readyz
```

SQLite is the authority. Optional embedding or ANN services may supply recall
candidates, but they cannot override tenant scope, lifecycle state, verifier
outcomes, or the authoritative execution head.

## Integrate from TypeScript

The Runtime owns the SDK contract. The standalone `@aionis/sdk` package is
synchronized from [`src/sdk.ts`](src/sdk.ts).

Register the project's real acceptance command during setup, start Runtime,
then make `AgentSession` the owner of one stateful task:

```bash
npx aionis setup --provider none --verify-command "npm test" --project-dir . --yes
```

Setup prints the generated starter and its `required_verifier_id` (currently
`project-check`), so developers do not construct
`AIONIS_EPISODE_VERIFIERS_JSON` manually:

```ts
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAionisClient } from "@aionis/sdk";

const aionis = createAionisClient({
  baseUrl: "http://127.0.0.1:3001",
  tenant_id: "local",
  scope: "project:my-agent",
});

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const runId = randomUUID();
const sourceTask =
  "Write AIONIS_QUICKSTART.txt and finish only when project-check passes.";
const workspaceRoot = process.cwd();

const session = await aionis.agentSession.begin({
  operation_id: `begin:${runId}`,
  session_key: `quickstart:${runId}`,
  continuation_id: randomUUID(),
  holder_id: "agent-1",
  task_envelope_v1: {
    contract_version: "host_task_envelope_v1",
    host_task_id: runId,
    collector_id: "quickstart-host",
    collector_version: "1",
    task_family: "workspace-edit",
    task_signature: "write-quickstart-file",
    repository_signature: `workspace:${sha256(workspaceRoot)}`,
    source_task_sha256: sha256(sourceTask),
    source_event_sha256: sha256(`task:${sourceTask}`),
    created_at: new Date().toISOString(),
  },
  source_task: sourceTask,
  run_id: runId,
  model_id: "your-agent-model",
  model_config: {},
  budget: { max_steps: 20, max_tokens: 20_000 },
  workspace_root: workspaceRoot,
  subject_state_spec_v2: {
    contract_version: "workspace_subject_state_spec_v2",
    additional_state_roots: [],
  },
  required_verifier_id: "project-check",
});

const turn = await session.turn({
  operation_id: `turn:${runId}`,
  observation: "The requested file does not exist yet.",
  authority: { kind: "host_declared", actor_id: "agent-1" },
  evidence_kind: "prompt",
  evidence: sourceTask,
  guide: {
    query_text: "Continue from the exact current state.",
    consumer_agent_id: "agent-1",
    context_char_budget: 4_000,
  },
});

console.log(turn.context.agent_prompt);

await session.aroundAction({
  operation_id: `action:${runId}`,
  action_kind: "file_write",
  tool_name: "node:fs/promises.writeFile",
  request: {
    path: "AIONIS_QUICKSTART.txt",
    content: "verified continuity\n",
  },
  execute: async () => {
    await writeFile(
      join(workspaceRoot, "AIONIS_QUICKSTART.txt"),
      "verified continuity\n",
      "utf8",
    );
    return { ok: true };
  },
});

const verification = await session.runVerifier({
  operation_id: `verify-candidate:${runId}`,
});
console.log(verification);

const finish = await session.finish({
  verifier_operation_id: `verify-final:${runId}`,
  close_operation_id: `close:${runId}`,
  termination: "completed",
});

if (finish.status === "continue") {
  console.log("Continue from snapshot:", finish.continuation.current_state_snapshot_id);
}
```

`finish()` reruns the Runtime-owned verifier. It closes only a passing current
state; otherwise it returns `continue` and, when a prior accepted branch exists,
can restore that exact snapshot automatically.

`AgentSession` serializes one execution identity and exposes:

- `turn()` for guide plus structured progress;
- `aroundAction()` to bind a real tool action to the resulting subject state;
- `recordObservation()`, `recordDecision()`, `recordProgress()`, and
  `recordPlannedAction()` for semantic execution state;
- `runVerifier()` for Runtime-owned verification;
- `finish()` for verifier-bound completion or automatic exact recovery;
- `handoff()` and `resume()` for another Agent or process.

The Host can request verification, cancellation, or timeout. It cannot supply a
success enum that overrides the Runtime verifier.

## Product API

The public Runtime surface is intentionally small:

| Route | Purpose |
|---|---|
| `POST /v1/observe` | Record ordinary memory or execution events |
| `POST /v1/guide` | Compile the current executable continuation |
| `POST /v1/feedback` | Bind an outcome to delivered and used memory |
| `POST /v1/rehydrate` | Resolve archived or referenced evidence |
| `POST /v1/forget` | Suppress, restore, activate, or re-tier memory |
| `GET /health` | Runtime health |
| `GET /readyz` | Runtime readiness |

`POST /v1/memory/resolve` remains a temporary evidence-resolution migration
surface for SDK compatibility. It is not a second product loop.

There are no public operator, debug, audit, measure, replay-repair,
sandbox-repair, governance-control, or manual skill-candidate routes.

## Repository boundary

| Repository | Role |
|---|---|
| `AionisRuntime` | Local authoritative Execution Memory service |
| `aionis-sdk` | Canonical TypeScript integration |
| `aionis-mcp` | Thin MCP mapping onto the SDK |
| `aionis-aifs` | Thin file projection of Runtime state and memory |
| `aionis-cli` | Install, start, stop, inspect, and local configuration |

The Runtime is the only owner of execution truth. Adapters must not duplicate
ranking, current-state compilation, branch recovery, or learning policy.

## Current status

Phase 1 continuity convergence is complete:

- one current-state compiler;
- one continuation renderer;
- verifier-bound completion;
- exact accepted-branch recovery;
- real three-arm continuity acceptance.

Phase 2 production-core convergence is complete:

- all 160 retained source files belong to the Runtime or canonical SDK product
  closure;
- product-closure lines fell from 178,563 to 89,107;
- the route matrix fell from 21 entries to 6;
- environment fields fell from 177 to 64;
- old operator, audit, debug, measure, replay-repair, sandbox-repair,
  governance-control, and manual candidate surfaces are gone.

Phase 3 transferable adaptive learning is next. MCP, AIFS, and CLI adapter
convergence remains Phase 4. Multi-model proof remains Phase 5; neither is
claimed by the current three-task result.

## Development commands

```bash
npm run -s typecheck
npm run -s sdk:sync
npm run -s sdk:check
npm run -s complexity:report
```

The product build compiles the Runtime startup closure and canonical SDK. Old
experiment, deployment-authority, operator, and demonstration programs are not
part of the product build.

## License

Apache-2.0

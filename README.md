# Aionis Runtime Focused

Aionis Runtime Focused is a local evidence-gated cognitive memory and execution learning Runtime for agents.

It exists to make an agent feel less stateless and less wasteful across real work: prior execution traces, verifier outcomes, failed paths, recovered facts, reusable workflows, and forgetting decisions should shape what the agent sees and does next.

The product scope is intentionally narrow:

1. execution continuity
2. evidence-gated self-learning
3. controlled forgetting
4. dynamic learning control
5. history-shaped future behavior
6. evidence-scoped ordinary memory recall

Cross-thread, cross-Agent, and cross-LLM continuity are important proof surfaces, but they are not the whole product. The broader product contract is [docs/AIONIS_PRODUCT_CONTRACT.md](docs/AIONIS_PRODUCT_CONTRACT.md): observe real execution, guide future work, forget stale or harmful memory, and measure whether history helped. Capability routing and delete-review decisions live in [docs/AIONIS_CAPABILITY_DECISION_MATRIX.md](docs/AIONIS_CAPABILITY_DECISION_MATRIX.md), and product outputs are defined in [docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md](docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md).

It is not an external agent framework product, a docs product, a playground, a cloud control plane, or a benchmark runner. External project evaluation must live outside this focused product tree and must not define Runtime behavior.

## Product Contract

Aionis should answer these questions during real agent execution:

1. What has already happened in this run or prior related runs?
2. Which facts, files, verifier results, and workflow steps are proven?
3. What should the agent inspect or edit first?
4. Which learned workflow is reusable, contested, retired, or archived?
5. Which stale or harmful memory should be forgotten, demoted, or rehydrated only on demand?
6. Which guidance is blocked because it lacks authority?
7. How did prior execution history change the current context packet, next-action bias, or verification posture?

The executable kernel boundary lives in `src/kernel/boundary.ts`. The lightweight source boundary is [docs/ARCHITECTURE_BOUNDARY.md](docs/ARCHITECTURE_BOUNDARY.md), and the convergence scope is [docs/FOCUS.md](docs/FOCUS.md).

Runtime does not own semantic repair. Guided replay emits structured `agent_repair_request` evidence; the Agent or external LLM candidate producer proposes repairs, and Aionis adjudicates authority only after real execution evidence.

## Kept Surfaces

The focused workspace keeps:

1. `src/` Runtime kernel and routes
2. `scripts/start-lite.sh` direct local Runtime launcher
3. focused tests for continuity, learning, learning control, replay, and forgetting

## Removed Surfaces

The focused workspace excludes external agent framework products, ARC/benchmark tracks, SDK/package release wrappers, examples, docs products, inspector/playground UIs, marketing surfaces, broad automation products, cloud control planes, old measurement runners, and obsolete extension surfaces that do not directly strengthen the Runtime kernel.

## Validation

Local contract verification:

```bash
npm install
npm run -s typecheck
npm run -s lite:test
```

Real validation must run a frozen Runtime version against isolated workspaces. Aionis must not be modified during a task run to satisfy that task. Failed runs create evidence and candidates; they do not promote project-specific rules into Core.

Product-output contracts are verified by focused tests against the Runtime kernel and product output assembler. Real external-agent validation belongs in a separate evaluation workspace, not in this focused Runtime package.

## Engineering Priorities

1. Keep the local Lite store behind explicit Runtime store-port contracts.
2. Strengthen execution continuity packets for task start, handoff, resume, verified facts, and next action.
3. Strengthen self-learning from real traces without turning one task into source-code policy.
4. Strengthen controlled forgetting so stale guidance is demoted or rehydrated instead of accumulating forever.
5. Keep Core free of project-specific repair rules, provider-specific benchmark assumptions, and eval-runner policy.

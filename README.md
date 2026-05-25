# Aionis Runtime Focused

Aionis Runtime Focused is a local execution-memory runtime for agents.

The product scope is intentionally narrow:

1. execution continuity
2. evidence-gated self-learning
3. controlled forgetting
4. learning control

It is not a host-adapter project, a docs product, a playground, a cloud control plane, or a benchmark harness. External project evaluation exists only to measure whether the Runtime helps real agents; it does not define product behavior.

## Product Contract

Aionis should answer these questions during real agent execution:

1. What has already happened in this run or prior related runs?
2. Which facts, files, verifier results, and workflow steps are proven?
3. What should the agent inspect or edit first?
4. Which learned workflow is reusable, contested, retired, or archived?
5. Which stale or harmful memory should be forgotten, demoted, or rehydrated only on demand?
6. Which guidance is blocked because it lacks authority?

The executable kernel boundary lives in `src/kernel/boundary.ts`.

The formal architecture contract is [docs/FOCUSED_RUNTIME_ARCHITECTURE_CONTRACT.md](docs/FOCUSED_RUNTIME_ARCHITECTURE_CONTRACT.md). It defines the focused Runtime as an Action Intelligence / Persistent Cognitive Runtime and maps the contract to the current code surfaces.

## Runtime Layers

The focused copy keeps three layers separate:

1. `core_runtime`: continuity, evidence grading, context packet assembly, learning lifecycle, workflow promotion, forgetting, and learning control.
2. `real_eval_harness`: isolated real-agent runs, provider calls, verifier execution, baseline comparison, and effect reporting.
3. `experimental_policy`: verifier phase classifiers, edit-boundary experiments, tool recovery hints, semantic repair candidates, and task-family hypotheses.

Only Core Runtime is the product. Eval and experimental policy can produce evidence or candidates, but they cannot become global Runtime authority without scoped real success plus holdout or regression evidence.

## Kept Surfaces

The focused workspace keeps:

1. `src/` Runtime kernel and routes
2. `apps/lite/` local Lite host
3. `packages/aionis-runtime/` standalone local runtime package
4. `packages/runtime-core/` shared runtime boundary package
5. `packages/full-sdk/` focused SDK surface
6. focused tests for continuity, learning, learning control, replay, and forgetting
7. real-eval harness for frozen-version validation

## Removed Surfaces

The focused workspace excludes host-specific agent adapters, docs products, inspector/playground UIs, marketing surfaces, broad automation products, cloud control planes, and historical extension shims that do not directly strengthen the Runtime kernel.

## Validation

Local contract verification:

```bash
npm install
npm run -s core:build
npm run -s lite:test
```

Real effectiveness validation:

```bash
npm run -s eval:real-llm -- --suite <suite.json> --out <report-dir>
```

External Agent A/B validation with SWE-agent:

```bash
npm run -s eval:swe-agent -- --suite <suite.json> --out <report-dir> --runtime-url <lite-runtime-url>
```

Real validation must run a frozen Runtime version against isolated workspaces. Aionis must not be modified during a task run to satisfy that task. Failed runs create evidence and candidates; they do not promote project-specific rules into Core.

SWE-agent validation also reports scoped prior-success semantic invariant uptake. Those invariants are evidence carried from verifier-passing prior runs into the Agent context; they are not Core rules and do not let Aionis generate semantic patches.

The SWE-agent adapter uses an assistance gate so Aionis does not always intervene at the same strength. Simple or low-evidence tasks can receive no extra context or a minimal boundary contract; prior-success or prior-failure tasks receive bounded semantic evidence or stricter governance.

SWE-agent validation also derives baseline comparison quality. A passing Aionis-assisted run is not treated as a clean win when it adds repeated discovery, wrong-file touches, higher token use, slower completion, or context-budget overflow.

The SWE-agent adapter can also run a verifier feedback repair loop. Failed verifier output is compressed into a structured evidence packet and handed back to the Agent for another pass in the same workspace. Aionis does not generate the semantic patch; it supplies continuity, evidence, and boundaries.

## Engineering Priorities

1. Keep Lite and Postgres behind the same store-port contracts.
2. Strengthen execution continuity packets for task start, handoff, resume, verified facts, and next action.
3. Strengthen learning lifecycle gates for candidates, promotion, suppression, counter-evidence, retirement, and archive.
4. Strengthen controlled forgetting so stale guidance is demoted or rehydrated instead of accumulating forever.
5. Keep Core free of project-specific repair rules, provider-specific benchmark assumptions, and eval-runner policy.

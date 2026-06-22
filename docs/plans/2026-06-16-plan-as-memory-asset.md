# Plan As Memory Asset Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Productize Aionis as the execution memory layer that turns high-quality plans, decisions, failed branches, acceptance checks, and execution boundaries into reusable, auditable state across agents, sessions, and models.

**Architecture:** Reuse the existing product loop instead of building a model router: `/v1/observe` records plan and execution evidence, `/v1/guide` compiles governed execution context, `/v1/feedback` attributes outcome to exposed memory, `/v1/measure` scores effect, and `/v1/operator/snapshot` plus Flight Recorder expose audit state. The first implementation should be a product profile and SDK/MCP/demo layer on top of the current Runtime, with only small schema/doc strengthening if current fields cannot express plan assets cleanly.

**Tech Stack:** TypeScript, Fastify product routes, Zod product contracts, Lite SQLite Runtime, `@aionis/sdk`, `@aionis/mcp`, `@aionis/claude-code`, Node test runner, `tsx`, Claude Code lifecycle integration, Markdown docs.

---

## Product Thesis

The Kilo planning/execution split is important for Aionis because it shows that
the valuable artifact is not just a long transcript. The valuable artifact is a
high-quality execution plan that resolves design forks, names risks, defines
acceptance checks, and constrains implementation.

Aionis should absorb this as product language:

```text
Aionis turns plans, decisions, failures, and acceptance checks into reusable execution memory.

Strong models make better plans; Aionis keeps those plans executable across cheaper agents and future sessions.

Aionis is the execution memory layer that makes high-quality planning reusable, auditable, and executable across agents, sessions, and models.
```

This is not a model-router feature. The host can choose any planner, worker,
verifier, or reviewer model. Aionis owns state governance, context compilation,
feedback attribution, measurement, and replay.

## Current Surfaces To Reuse

- Product positioning: `README.md`, `docs/AIONIS_PRODUCT_POSITIONING.md`
- Product contracts: `docs/AIONIS_PRODUCT_CONTRACT.md`, `docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md`
- Loop profile: `docs/AIONIS_LOOP_ENGINEERING.md`
- Claude Code plugin integration: `docs/AIONIS_CLAUDE_CODE_INTEGRATION.md`
- MCP guide: `docs/AIONIS_MCP.md`
- SDK guide: `docs/AIONIS_SDK_QUICKSTART.md`
- Runtime architecture: `docs/AIONIS_RUNTIME_ARCHITECTURE.md`
- SDK source mirror: `src/sdk.ts`, `packages/aionis-sdk/src/index.ts`
- SDK tests: `scripts/ci/lite-sdk-client.test.ts`, `packages/aionis-sdk/test/sdk.test.ts`
- MCP source: `packages/aionis-mcp/src/server.ts`, `packages/aionis-mcp/src/tools.ts`
- MCP tests: `packages/aionis-mcp/test/mcp.test.ts`
- Existing e2e demos:
  - `scripts/e2e/loop-engineering-profile.ts`
  - `scripts/e2e/multi-agent-execution-memory-loop.ts`
  - `scripts/e2e/flight-recorder-incident-demo.ts`

Run after each code chunk:

```bash
npm run -s typecheck
npm run -s lite:test
```

Run before publishing or committing a public-facing package change:

```bash
npm run -s test:focused
```

---

## Non-Goals And Invariants

Non-goals:

- Do not build a model router.
- Do not make Aionis an autonomous coding runner.
- Do not put provider-specific model policy into Runtime core.
- Do not let a planner model, worker model, or Fusion-style reviewer bypass lifecycle, source, scope, authority, suppression, or rehydrate gates.
- Do not create a parallel `PlanMemoryRuntime`; reuse execution memory and product contracts.

Hard invariants:

```text
planner output
  -> observe as evidence
  -> guide compiles governed execution context
  -> worker acts outside Aionis
  -> verifier/reviewer feedback is attributed
  -> measure scores whether the plan memory helped
  -> Flight Recorder replays what the worker could see
```

```text
expensive planner model != Runtime authority
cheap worker model != Runtime authority
multi-model judge != Runtime authority

Aionis gates decide what can enter actionable context.
```

---

## Phase 0: Baseline And Product Boundary

### Task 0.1: Capture Current Baseline

**Files:**
- Read: `README.md`
- Read: `docs/AIONIS_LOOP_ENGINEERING.md`
- Read: `docs/AIONIS_CLAUDE_CODE_INTEGRATION.md`
- Read: `packages/aionis-sdk/src/index.ts`
- Read: `packages/aionis-mcp/src/server.ts`

**Step 1: Check repo status**

Run:

```bash
git status --short --branch
```

Expected: no unrelated dirty files. If local demo/video files are under `.tmp/`,
ignore them.

**Step 2: Run current focused tests**

Run:

```bash
npm run -s typecheck
npm run -s lite:test
```

Expected: both pass.

**Step 3: Run existing product demos**

Run:

```bash
npm run -s runtime:e2e:loop-engineering-profile
npm run -s runtime:e2e:flight-recorder-incident
```

Expected: all pass and produce/refresh example result artifacts.

**Step 4: Commit only if the demos update tracked artifacts**

Run:

```bash
git status --short
```

If tracked example files changed:

```bash
git add docs/examples
git commit -m "test: refresh plan memory baseline artifacts"
```

---

## Phase 1: Product Language And Documentation

### Task 1.1: Make "Plan As Memory Asset" A First-Class Product Concept

**Files:**
- Modify: `README.md`
- Modify: `docs/AIONIS_PRODUCT_POSITIONING.md`
- Modify: `docs/AIONIS_LOOP_ENGINEERING.md`
- Modify: `docs/AIONIS_RUNTIME_ARCHITECTURE.md`

**Step 1: Add README positioning**

Add one concise section near the Execution Memory / Loop Engineering section:

```markdown
## Plan As Memory Asset

Aionis is not a model router. It is the execution memory layer that preserves
the decisions made by strong planners and makes them usable by future workers,
reviewers, and cheaper models.

Plans become governed execution memory when they carry:

- resolved decisions
- acceptance checks
- failed branches
- active targets
- execution boundaries
- evidence and feedback attribution
```

**Step 2: Update product positioning**

In `docs/AIONIS_PRODUCT_POSITIONING.md`, add the exact product sentence:

```text
Aionis turns plans, decisions, failures, and acceptance checks into reusable execution memory.
```

Then distinguish this from Memory Firewall:

```text
Memory Firewall protects the context boundary.
Plan-as-memory is the execution memory asset that crosses sessions, agents, and models.
```

**Step 3: Update loop engineering doc**

In `docs/AIONIS_LOOP_ENGINEERING.md`, add a subsection:

```markdown
### Planner / Worker Split

The host may use a stronger model to create the plan and a cheaper model to
execute it. Aionis does not route those models. Aionis records the plan's
decisions, checks, failed branches, and boundaries, then compiles them into
governed context for the next loop iteration.
```

**Step 4: Docs sanity**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

**Step 5: Commit**

```bash
git add README.md docs/AIONIS_PRODUCT_POSITIONING.md docs/AIONIS_LOOP_ENGINEERING.md docs/AIONIS_RUNTIME_ARCHITECTURE.md
git commit -m "docs: position plans as execution memory assets"
```

---

## Phase 2: SDK Plan Asset Profile

### Task 2.1: Add SDK Types For Plan Asset Inputs

**Files:**
- Modify: `packages/aionis-sdk/src/index.ts`
- Modify: `src/sdk.ts`
- Test: `packages/aionis-sdk/test/sdk.test.ts`
- Test: `scripts/ci/lite-sdk-client.test.ts`

**Step 1: Add failing SDK tests**

Add tests that verify a plan asset helper maps into existing observe/record-step
payloads without requiring new Runtime endpoints:

```ts
test("SDK builds plan asset observe events", () => {
  const events = planAssetObserveEvents({
    run_id: "run-plan-1",
    task_signature: "feature-flag-service",
    task_family: "coding",
    workflow_signature: "planner-worker-demo",
    planner: {
      agent_id: "planner-claude",
      model: "strong-planner-model"
    },
    plan: {
      title: "Feature flag service plan",
      summary: "Build sticky rollout evaluation with audit logging.",
      artifact_ref: "plan.md",
      decisions: [
        {
          decision_id: "decision:bucket-math",
          statement: "Use deterministic 10,000 bucket hashing by flag key and user id.",
          rationale: "Growing rollout percentages preserves already-enabled users."
        }
      ],
      acceptance_checks: [
        "same user gets same result across repeated calls",
        "20% to 40% rollout preserves original 20%"
      ],
      execution_boundaries: [
        "do not store per-user rollout state",
        "do not store plaintext API keys"
      ],
      failed_branches: [
        {
          branch_id: "failed:random-rollout",
          statement: "Random per-request rollout assignment is invalid.",
          reason: "It violates sticky rollout."
        }
      ]
    }
  });

  assert.equal(events.length >= 1, true);
  assert.equal(events[0].outcome, "succeeded");
  assert.deepEqual(events[0].acceptance_checks?.slice(0, 1), [
    "same user gets same result across repeated calls"
  ]);
});
```

Expected before implementation: `planAssetObserveEvents is not defined`.

**Step 2: Add minimal exported types**

Add SDK-only types:

```ts
export type AionisPlanAssetDecision = {
  decision_id: string;
  statement: string;
  rationale?: string;
  alternatives_rejected?: string[];
  target_files?: string[];
};

export type AionisPlanAssetFailedBranch = {
  branch_id: string;
  statement: string;
  reason: string;
  target_files?: string[];
};

export type AionisPlanAsset = {
  title: string;
  summary: string;
  artifact_ref?: string;
  decisions: AionisPlanAssetDecision[];
  acceptance_checks: string[];
  execution_boundaries: string[];
  failed_branches?: AionisPlanAssetFailedBranch[];
};
```

**Step 3: Add helper that maps to existing execution memory input**

Add:

```ts
export function planAssetObserveEvents(input: AionisPlanAssetObserveInput): AionisExecutionRecordStepInput[] {
  const targetFiles = Array.from(new Set([
    ...input.plan.decisions.flatMap((decision) => decision.target_files ?? []),
    ...(input.plan.failed_branches ?? []).flatMap((branch) => branch.target_files ?? [])
  ]));

  return [
    {
      run_id: input.run_id,
      task_signature: input.task_signature,
      task_family: input.task_family,
      workflow_signature: input.workflow_signature,
      agent_id: input.planner.agent_id,
      role: "planner",
      title: input.plan.title,
      summary: [
        "PLAN_AS_MEMORY_ASSET",
        input.plan.summary,
        `Decisions: ${input.plan.decisions.map((decision) => decision.statement).join(" | ")}`,
        `Acceptance checks: ${input.plan.acceptance_checks.join(" | ")}`,
        `Execution boundaries: ${input.plan.execution_boundaries.join(" | ")}`
      ].filter(Boolean).join("\n"),
      outcome: "succeeded",
      target_files: targetFiles,
      acceptance_checks: input.plan.acceptance_checks,
      continuation_hint: "Use this plan as governed execution memory; preserve boundaries and rejected branches."
    }
  ];
}
```

Keep this SDK helper deterministic and host-owned. Do not call an LLM inside it.

**Step 4: Mirror root SDK**

Run the existing sync workflow or manually mirror the change from
`packages/aionis-sdk/src/index.ts` to `src/sdk.ts`, then run:

```bash
node scripts/ci/check-sdk-source-sync.mjs
```

Expected: pass.

**Step 5: Run tests**

```bash
npm run -s typecheck
node --import tsx --test packages/aionis-sdk/test/sdk.test.ts
node --import tsx --test scripts/ci/lite-sdk-client.test.ts
```

Expected: pass.

**Step 6: Commit**

```bash
git add packages/aionis-sdk/src/index.ts src/sdk.ts packages/aionis-sdk/test/sdk.test.ts scripts/ci/lite-sdk-client.test.ts
git commit -m "feat: add plan asset SDK profile"
```

---

## Phase 3: Product Contract And Output Trace

### Task 3.1: Surface Plan Asset Evidence In Existing Records

**Files:**
- Modify: `docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md`
- Modify: `docs/AIONIS_PRODUCT_CONTRACT.md`
- Optional Modify: `src/memory/product-output-contract.ts`
- Test: `scripts/ci/lite-product-output-contract.test.ts`

**Step 1: Decide if schema changes are needed**

First inspect whether current output already has enough fields:

- `memory_use_receipt`
- `memory_admission_record`
- `execution_context`
- `route_contract`
- `acceptance_checks`
- `command_posture`

If existing records already preserve plan evidence as memory text, do not add
schema. Document the convention only.

**Step 2: Add documentation convention**

Document these reason/code conventions:

```text
PLAN_AS_MEMORY_ASSET
PLAN_DECISION
PLAN_ACCEPTANCE_CHECK
PLAN_EXECUTION_BOUNDARY
PLAN_REJECTED_BRANCH
```

Clarify that these are evidence labels, not separate Runtime authority levels.

**Step 3: Optional schema strengthening**

Only if tests reveal ambiguity, add an optional read-only field:

```ts
plan_asset_refs?: Array<{
  plan_id: string;
  artifact_ref?: string;
  decision_ids: string[];
  acceptance_check_count: number;
  rejected_branch_count: number;
}>;
```

Do not require this field on all memory records.

**Step 4: Run tests**

```bash
npm run -s typecheck
node --import tsx --test scripts/ci/lite-product-output-contract.test.ts
```

Expected: pass.

**Step 5: Commit**

```bash
git add docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md docs/AIONIS_PRODUCT_CONTRACT.md src/memory/product-output-contract.ts scripts/ci/lite-product-output-contract.test.ts
git commit -m "docs: define plan asset output contract"
```

If no schema/test files changed, commit only docs:

```bash
git add docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md docs/AIONIS_PRODUCT_CONTRACT.md
git commit -m "docs: define plan asset output contract"
```

---

## Phase 5: Plan Adherence And Wrong-Branch Measurement

### Task 5.1: Add A Plan Asset E2E

**Files:**
- Create: `scripts/e2e/plan-as-memory-asset-demo.ts`
- Modify: `package.json`
- Create: `docs/examples/plan-as-memory-asset-result.json`
- Test: `scripts/ci/lite-product-feedback-closed-loop.test.ts` or a new focused test if needed

**Step 1: Add npm script**

In `package.json`:

```json
"runtime:e2e:plan-as-memory-asset": "npx tsx scripts/e2e/plan-as-memory-asset-demo.ts"
```

**Step 2: Build deterministic e2e flow**

The script should:

1. start local Runtime with `openRuntime()`
2. record a planner plan asset with:
   - decisions
   - acceptance checks
   - execution boundaries
   - rejected branch
3. record a failed branch that violates the plan
4. record a successful branch that follows the plan
5. call SDK `compileExecutionAgentContext`
6. simulate a worker decision from the returned context
7. call feedback
8. call measure
9. call snapshot or Flight Recorder
10. write `docs/examples/plan-as-memory-asset-result.json`

**Step 3: Required result shape**

Write:

```ts
const result = {
  contract_version: "aionis_plan_as_memory_asset_demo_result_v1",
  plan_asset: {
    recorded: true,
    decision_count: 1,
    acceptance_check_count: 2,
    rejected_branch_count: 1
  },
  governed_context: {
    use_now_contains_plan_target: true,
    failed_branch_direct_use: false,
    memory_use_receipt_present: true,
    memory_admission_record_present: true
  },
  simulated_worker: {
    plan_adherence: true,
    wrong_branch_reuse: false
  },
  measurement: {
    measure_history_impact: "positive"
  },
  flight_recorder: {
    prompt_payload_excluded: true,
    runtime_mutation: false
  }
};
```

**Step 4: Run e2e**

```bash
npm run -s runtime:e2e:plan-as-memory-asset
```

Expected:

- `plan_adherence: true`
- `wrong_branch_reuse: false`
- `memory_use_receipt_present: true`
- `memory_admission_record_present: true`

**Step 5: Run focused checks**

```bash
npm run -s typecheck
npm run -s lite:test
```

Expected: pass.

**Step 6: Commit**

```bash
git add package.json scripts/e2e/plan-as-memory-asset-demo.ts docs/examples/plan-as-memory-asset-result.json
git commit -m "test: add plan as memory asset demo"
```

---

## Phase 6: Docs Site And Public Onboarding

### Task 6.1: Add Private Docs Site Pages

**Files:**
- Modify private ignored docs site files under `docs-site/`
- Do not add `docs-site/` to git unless project policy changes

**Step 1: Add page**

Create a docs page titled:

```text
Plan as Memory Asset
```

It should explain:

- why Aionis is not a model router
- how a planner model creates valuable execution memory
- how worker/verifier/reviewer agents consume governed context
- how Flight Recorder proves what was visible
- how Measure reports whether the plan helped

**Step 2: Navigation placement**

Place it under Execution Memory, not under Memory Firewall.

**Step 3: Deploy**

From the docs-site Vercel project directory:

```bash
vercel deploy --prod
```

Expected: live at `https://docs.aionis.work`.

No git commit is needed for ignored private docs-site changes.

---

## Phase 7: Optional OpenRouter Fusion Integration

### Task 7.1: Document Fusion As Optional Reviewer, Not Core

**Files:**
- Modify: `docs/AIONIS_LOOP_ENGINEERING.md`
- Optional Create: `docs/AIONIS_OPENROUTER_FUSION.md`

**Step 1: Add boundary**

Document:

```text
Fusion can review a plan or contested admission decision, but it cannot override Aionis lifecycle, scope, source, suppression, or rehydrate gates.
```

**Step 2: Add example flow**

```text
1. Planner creates plan.
2. Fusion reviews plan for blind spots.
3. Aionis observes accepted decisions and rejected branches.
4. Worker consumes Aionis guide.
5. Aionis measures outcome.
```

**Step 3: Do not add Runtime integration yet**

This phase is docs-only unless there is explicit user demand for OpenRouter API
support. Keep provider API keys out of Runtime core.

**Step 4: Commit**

```bash
git add docs/AIONIS_LOOP_ENGINEERING.md docs/AIONIS_OPENROUTER_FUSION.md
git commit -m "docs: position Fusion as optional plan reviewer"
```

---

## Phase 8: Release And Marketing Package

### Task 8.1: Update Public Package Docs

**Files:**
- Modify: `packages/aionis-sdk/README.md`
- Modify: `packages/aionis-mcp/README.md`
- Modify: `README.md`

**Step 1: Add SDK quick example**

Show:

```ts
const planEvents = planAssetObserveEvents({
  run_id,
  task_signature: "feature-flag-service",
  task_family: "coding",
  workflow_signature: "planner-worker",
  planner: { agent_id: "planner", model: "strong-planner" },
  plan
});

for (const event of planEvents) {
  await aionis.execution.recordStep(event);
}

const guide = await aionis.execution.compileContext({
  run_id,
  task_signature: "feature-flag-service",
  query_text: "Continue implementation from the accepted plan."
});
```

**Step 2: Add MCP wording**

In `packages/aionis-mcp/README.md`, say:

```text
Claude Code can record planner decisions and later ask Aionis for governed execution context before the worker continues.
```

**Step 3: Run package tests**

```bash
npm run -s packages:build
npm run -s packages:test
```

Expected: pass.

**Step 4: Commit**

```bash
git add README.md packages/aionis-sdk/README.md packages/aionis-mcp/README.md
git commit -m "docs: add plan asset SDK and MCP examples"
```

### Task 8.2: Version Packages If Public API Changed

Only do this if Phase 2 added exported SDK functions/types.

**Files:**
- Modify: `packages/aionis-sdk/package.json`
- Modify: `packages/aionis-mcp/package.json` if MCP docs/tooling changed
- Modify: `packages/create-aionis/package.json` only if installer output changes

**Step 1: Bump SDK patch**

Run:

```bash
npm version patch --workspace @aionis/sdk --no-git-tag-version
```

If MCP package changed:

```bash
npm version patch --workspace @aionis/mcp --no-git-tag-version
```

**Step 2: Build**

```bash
npm run -s packages:build
```

Expected: pass.

**Step 3: Commit**

```bash
git add packages/aionis-sdk/package.json packages/aionis-mcp/package.json package-lock.json
git commit -m "chore: bump plan asset package versions"
```

Publishing should be manual unless explicitly requested.

---

## Success Criteria

The plan is successful when all of these are true:

- README and product docs clearly say Aionis turns plans into execution memory.
- Memory Firewall remains a product surface, but no longer overshadows Execution Memory.
- SDK exposes a simple, deterministic way to record a plan asset without requiring users to understand internal memory rows.
- Claude Code lifecycle integration is documented as a plugin/hook product path.
- New e2e proves:
  - plan decisions enter governed context
  - acceptance checks are preserved
  - failed plan branches are downgraded or blocked
  - worker context is shorter than raw history
  - Flight Recorder can replay what the worker saw
  - Measure can report positive or negative effect
- Runtime core remains provider-agnostic and does not become a model router.

## Recommended Execution Order

1. Phase 1: product language
2. Phase 2: SDK profile
3. Phase 5: deterministic e2e
4. Phase 4: Claude Code lifecycle integration docs
5. Phase 6: docs site page
6. Phase 8: package docs/version bump
7. Phase 7: optional Fusion docs later

This order keeps the feature anchored in Aionis' existing Runtime and gives a
credible public product loop before adding optional third-party model-review language.

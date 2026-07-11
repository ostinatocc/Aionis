# Runtime Temporary Transport Removal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the eight remaining temporary Runtime HTTP transports while preserving product guidance, native recall diagnostics, Manifest tool selection, attributed feedback, learning, and run lifecycle visibility.

**Architecture:** Keep the canonical typed planning and learning kernels inside the modular monolith. Project a narrow tool-selection receipt from `/v1/guide`, accept an exposure-verified tool-selection variant on `/v1/feedback`, migrate Manifest and eval consumers, then delete the obsolete HTTP adapters and route-only code.

**Tech Stack:** TypeScript, Node.js 24, Fastify, Zod, `node:sqlite`, native `@zvec/zvec`, Node test runner, `tsx`.

---

Design reference:
`docs/plans/2026-07-10-runtime-transport-removal-design.md`

Working branch: `aionis/runtime-complexity-reduction`

Working tree:
`/Volumes/ziel/new.aionis/.worktrees/AionisRuntime-focused-complexity`

External source tree:
`/Volumes/ziel/new.aionis/AionisManifest`

## Invariants

- SQLite remains the truth source.
- `/v1/guide` remains the sole AgentContext product read.
- `/v1/feedback` verifies that a tool decision was exposed by the referenced
  guide before learning may occur.
- Tool candidate ordering, selected tool, decision id, run id, feedback
  outcome, rule updates, and lifecycle visibility remain available.
- Memory feedback attribution remains unchanged and fail-closed.
- zvec remains a candidate source and is verified against Runtime truth.
- No replacement compatibility route or framework-specific contract is added.
- No real validation is replaced with mocks.

### Task 1: Project a Tool-Selection Receipt from Product Guide

**Files:**

- Modify: `src/product/product-services.ts`
- Modify: `src/product/guide-service.ts`
- Test: `scripts/ci/lite-product-facade-route.test.ts`
- Test: `scripts/ci/lite-product-services.test.ts`

**Step 1: Write failing guide receipt tests**

Add a real SQLite Product Facade test that guides with:

```ts
{
  tenant_id: "default",
  scope: "tool-receipt",
  run_id: "run:tool-receipt",
  query_text: "Choose the safe tool for the recovered execution state.",
  tool_candidates: ["read", "bash"],
  context: { task_signature: "tool-receipt" },
  include_packets: true,
}
```

Assert that `tool_selection` contains the persisted `decision_id`, matching
`run_id`, selected tool, normalized candidates, policy hash, and source rule
ids. Read the stored decision through the Lite write store and assert the
receipt matches it. Add a negative control showing a guide without candidates
omits the receipt.

**Step 2: Run the focused tests and observe failure**

```bash
node --import tsx --test scripts/ci/lite-product-facade-route.test.ts scripts/ci/lite-product-services.test.ts
```

Expected: fail because the product guide result and exposure ledger do not yet
contain `tool_selection`.

**Step 3: Define the narrow product receipt**

In `src/product/product-services.ts`, add a strict receipt type/schema with this
shape:

```ts
export type ProductToolSelectionReceipt = {
  contract_version: "aionis_tool_selection_receipt_v1";
  decision_id: string;
  decision_uri: string;
  run_id: string;
  selected_tool: string | null;
  candidates: string[];
  policy_sha256: string;
  source_rule_ids: string[];
  created_at: string;
};
```

Extend `ProductGuideExposureLedger` with
`tool_selection: ProductToolSelectionReceipt | null`. Parse it strictly and
retain backwards parsing for older ledgers that have no receipt.

**Step 4: Build the receipt from the planning result**

In `src/product/guide-service.ts`:

- read the existing `guideBody.tools.decision` and `guideBody.tools.candidates`;
- emit a receipt only when the stored decision fields are complete and the
  decision has the same non-empty run id as the guide request;
- persist the receipt in the guide exposure ledger;
- expose it at `guideResult.tool_selection`;
- record `tool_selection_receipt` in `source_map.internal_surfaces_used`;
- keep raw rules, pattern matches, and planning internals omitted.

**Step 5: Run focused tests**

Run the Step 2 command.

Expected: all pass.

**Step 6: Commit**

```bash
git add src/product/product-services.ts src/product/guide-service.ts scripts/ci/lite-product-facade-route.test.ts scripts/ci/lite-product-services.test.ts
git commit -m "feat: expose attributed tool selection receipt"
```

### Task 2: Add Exposure-Verified Tool Feedback to `/v1/feedback`

**Files:**

- Create: `src/product/tool-feedback-service.ts`
- Modify: `src/product/product-services.ts`
- Modify: `src/routes/product-facade.ts`
- Modify: `src/server/http-server.ts`
- Modify: `src/runtime-entry.ts`
- Test: `scripts/ci/lite-product-feedback-closed-loop.test.ts`
- Test: `scripts/ci/lite-product-facade-route.test.ts`

**Step 1: Write the failing real closed-loop tests**

Run guide with candidates, then post:

```ts
{
  feedback_kind: "tool_selection",
  tenant_id: guide.tenant_id,
  scope: guide.scope,
  guide_trace_id: guide.guide_trace_id,
  decision_id: guide.tool_selection.decision_id,
  run_id: guide.tool_selection.run_id,
  selected_tool: guide.tool_selection.selected_tool,
  candidates: guide.tool_selection.candidates,
  outcome: "positive",
  context: { task_signature: "tool-feedback" },
  input_text: "The selected tool completed the verified action.",
}
```

Assert the response contract is `aionis_feedback_result_v1`, feedback kind is
`tool_selection`, rule/pattern learning output is preserved, and returned run
lifecycle is `feedback_linked`.

Add negative tests for forged guide trace, tenant/scope, run id, decision id,
selected tool, and candidates. Each must return 400 or 404 without writing
feedback.

**Step 2: Run tests and observe failure**

```bash
node --import tsx --test scripts/ci/lite-product-feedback-closed-loop.test.ts scripts/ci/lite-product-facade-route.test.ts
```

Expected: fail because memory feedback is the only current product variant.

**Step 3: Add a strict request contract**

Define `ProductToolFeedbackRequest` in `src/product/product-services.ts` with:

- literal `feedback_kind: "tool_selection"`;
- tenant, scope, guide trace, decision id, run id;
- selected tool and non-empty candidates;
- positive/negative/neutral outcome;
- context, input text, optional actor/note/target/shadow/rule limit;
- no passthrough fields.

Do not weaken `ProductForgetRequest` or existing memory feedback validation.

**Step 4: Implement the product service**

Create `src/product/tool-feedback-service.ts` that:

1. loads the guide exposure ledger by `guide_trace_id` from SQLite;
2. verifies tenant, scope, run, decision, selected tool, and candidates against
   the persisted receipt;
3. calls the existing `toolSelectionFeedback` typed operation;
4. calls `getToolsRunLifecycle` with `include_feedback: true`;
5. returns a narrow product result with route `/v1/feedback` and typed internal
   surfaces only.

Use the existing learning-control provider construction. Do not duplicate
rule, pattern, policy-memory, or lifecycle logic.

**Step 5: Dispatch the public feedback variants**

Add `toolFeedback` to `ProductServices`. In `product-facade.ts`, dispatch only
when `feedback_kind === "tool_selection"`; otherwise use the unchanged memory
feedback path. Apply existing identity, write quotas, and inflight guards.

Wire the service in `createRuntimeProductServices`; pass the Runtime embedder
from `runtime-entry.ts` so existing materialization behavior remains intact.

**Step 6: Run focused tests and typecheck**

```bash
node --import tsx --test scripts/ci/lite-product-feedback-closed-loop.test.ts scripts/ci/lite-product-facade-route.test.ts
npm run -s typecheck
```

Expected: all pass.

**Step 7: Commit**

```bash
git add src/product/tool-feedback-service.ts src/product/product-services.ts src/routes/product-facade.ts src/server/http-server.ts src/runtime-entry.ts scripts/ci/lite-product-feedback-closed-loop.test.ts scripts/ci/lite-product-facade-route.test.ts
git commit -m "feat: route tool learning through product feedback"
```

### Task 3: Migrate AionisManifest Resume to Product Contracts

**Files:**

- Modify: `/Volumes/ziel/new.aionis/AionisManifest/src/resume.ts`
- Modify: `/Volumes/ziel/new.aionis/AionisManifest/src/resume-cli.ts`
- Modify: `/Volumes/ziel/new.aionis/AionisManifest/src/index.ts`
- Modify: `/Volumes/ziel/new.aionis/AionisManifest/README.md`
- Modify: `/Volumes/ziel/new.aionis/AionisManifest/CHANGELOG.md`
- Create: `/Volumes/ziel/new.aionis/AionisManifest/test/resume.test.ts`
- Create: `scripts/ci/manifest-product-resume.test.ts`

**Step 1: Write failing Manifest contract tests**

Test the pure Manifest request builders and v2 result schemas without mocking
Runtime responses. Assert that builders produce only public guide/feedback
request contracts and that the v2 result preserves selected tool, decision id,
run id, feedback update count, and lifecycle transition.

Assert:

- the guide builder carries recovered continuity and candidates;
- feedback cannot be built without a guide tool-selection receipt;
- feedback is bound to guide trace, decision, run, selected tool, and candidates;
- no exported request builder contains an internal `/v1/memory/*` path.

**Step 2: Run Manifest tests and observe failure**

```bash
cd /Volumes/ziel/new.aionis/AionisManifest
npm test
```

Expected: fail because resume still calls five internal routes.

**Step 3: Replace resume request/response contracts**

Version the result to `aionis_manifest_resume_result_v2`. Replace the old
context/select/decision/run fields with:

```ts
guide_request
guide_response
tool_feedback_request
tool_feedback_response
```

Build the guide request from recovered continuity using `query_text`,
`context`, `run_id`, `execution_state_v1`, `tool_candidates`, and
`include_packets: true`.

Build optional feedback only from the guide's tool-selection receipt. Do not
invent a decision when the receipt is absent.

**Step 4: Update CLI and docs**

Describe the public guide/feedback loop. Keep candidate and feedback CLI flags.
Remove all internal route names from active Manifest documentation.

**Step 5: Verify Manifest**

```bash
cd /Volumes/ziel/new.aionis/AionisManifest
npm run -s verify
```

Expected: all tests and build pass.

**Step 6: Run a real Runtime/Manifest resume loop**

Add `scripts/ci/manifest-product-resume.test.ts`. Start the real focused
Runtime application on an ephemeral HTTP listener with SQLite, import the
built Manifest client, publish/recover a Manifest handoff, and run resume with
at least two tool candidates and positive feedback. Do not use a fake HTTP
server or mocked Runtime response.

Expected: only `/v1/guide` and `/v1/feedback` are used; stored decision and
feedback-linked lifecycle are visible.

**Step 7: Record checkpoint**

`AionisManifest` is not currently a Git worktree, so record its exact modified
file list and verification output in the Runtime verification report. Do not
pretend these external files were included in a Runtime commit.

### Task 4: Migrate Diagnostic Consumers off Raw Recall HTTP

**Files:**

- Modify: `scripts/e2e/zvec-ann-write-through-smoke.ts`
- Modify: `/Volumes/ziel/new.aionis/AionisRuntime-evals/memorydata-slices/scripts/aionis-adapter-smoke.mjs`
- Modify: `/Volumes/ziel/new.aionis/AionisRuntime-evals/product-guide-precision/scripts/run-guide-precision.mjs`
- Modify: `/Volumes/ziel/new.aionis/AionisRuntime-evals/product-guide-visibility/scripts/run-guide-visibility.mjs`
- Modify: `/Volumes/ziel/new.aionis/AionisRuntime-evals/product-self-learning-loop/scripts/run-self-learning-loop.mjs`
- Modify: `/Volumes/ziel/new.aionis/AionisRuntime-evals/product-sparse-feedback/scripts/run-sparse-feedback-holdout.mjs`
- Test: `scripts/ci/ann-index-contract.test.ts`

**Step 1: Make the zvec smoke call typed recall**

Replace Fastify injection of `/v1/memory/recall` with direct
`memoryRecallParsed` or a narrow typed recall service using the same real zvec
recall access and query embedding. Keep all ANN mode, exact-recovery, write
visibility, and failed-mutation assertions.

**Step 2: Remove the eval debug route call**

Use `/v1/guide` packets, receipt, and source map for the memorydata diagnostic
summary. Delete `buildRecallTextDebugRequest` and
`summarizeRecallTextDebug` when no longer referenced.

Remove allowances for `/v1/memory/planning/context` from the four guide eval
source-map checks; only `/v1/guide` is valid.

**Step 3: Run focused diagnostics**

```bash
npx tsx --test scripts/ci/ann-index-contract.test.ts
npm run -s runtime:e2e:zvec-ann-write-through
node --check /Volumes/ziel/new.aionis/AionisRuntime-evals/memorydata-slices/scripts/aionis-adapter-smoke.mjs
node --check /Volumes/ziel/new.aionis/AionisRuntime-evals/product-guide-precision/scripts/run-guide-precision.mjs
node --check /Volumes/ziel/new.aionis/AionisRuntime-evals/product-guide-visibility/scripts/run-guide-visibility.mjs
node --check /Volumes/ziel/new.aionis/AionisRuntime-evals/product-self-learning-loop/scripts/run-self-learning-loop.mjs
node --check /Volumes/ziel/new.aionis/AionisRuntime-evals/product-sparse-feedback/scripts/run-sparse-feedback-holdout.mjs
```

Expected: native zvec tests run without skip; all scripts parse.

**Step 4: Commit Runtime change**

```bash
git add scripts/e2e/zvec-ann-write-through-smoke.ts docs/examples/zvec-ann-write-through-smoke
git commit -m "test: use typed recall for zvec diagnostics"
```

Record external eval file changes separately because they are outside the
Runtime Git worktree.

### Task 5: Delete Recall and Context HTTP Adapters

**Files:**

- Delete: `src/routes/memory-recall.ts`
- Modify: `src/routes/memory-context-runtime.ts`
- Modify: `src/server/http-server.ts`
- Modify: `src/server/lite-runtime-boundary.ts`
- Modify: `src/kernel/boundary.ts`
- Modify: `docs/architecture/AIONIS_RUNTIME_SURFACE_INVENTORY.md`
- Modify: `scripts/ci/lite-runtime-boundary-inventory.test.ts`
- Modify/delete: route-only recall/context tests and test helpers under `scripts/ci/`

**Step 1: Add failing application-boundary tests**

Assert all four paths return 404 from real application registration and are
absent from `LITE_ROUTE_CAPABILITY_MATRIX`.

Assert `/v1/guide` still invokes `MemoryPlanningContextRouteService.assemble`.

**Step 2: Remove route registration**

- Delete `registerMemoryRecallRoutes` and its route-only module.
- Refactor `registerMemoryContextRuntimeRoutes` into a typed planning service
  constructor.
- Remove the `recall_text`, `planning/context`, and `context/assemble` Fastify
  handlers.
- Delete context-assemble-only branches that no product service calls.
- Keep shared planning, recall, governance, execution evidence, and packet
  construction used by `/v1/guide`.

**Step 3: Migrate tests to typed services**

Tests of retained behavior call the typed planning service or public guide.
Delete tests that only prove retired HTTP transport formatting. Do not mount
the four retired paths through test-only helpers.

**Step 4: Update inventories**

Mark the four rows `removed`, remove them from the active matrix and kernel
HTTP surface, and change temporary counts from eight to four.

**Step 5: Verify tranche 1**

```bash
npm run -s typecheck
node --import tsx --test scripts/ci/lite-runtime-boundary-inventory.test.ts scripts/ci/server-product-smoke.test.ts scripts/ci/lite-product-facade-route.test.ts
npm run -s runtime:e2e:golden-product-loop
npm run -s runtime:e2e:ordinary-memory
```

Expected: all pass; four retired paths return 404; guide behavior remains real.

**Step 6: Commit**

```bash
git add src scripts/ci docs/architecture/AIONIS_RUNTIME_SURFACE_INVENTORY.md
git commit -m "refactor: remove raw recall context transports"
```

### Task 6: Delete Tool HTTP Adapters

**Files:**

- Delete: `src/routes/memory-feedback-tools.ts`
- Modify: `src/server/http-server.ts`
- Modify: `src/server/lite-runtime-boundary.ts`
- Modify: `src/kernel/boundary.ts`
- Modify: `docs/architecture/AIONIS_RUNTIME_SURFACE_INVENTORY.md`
- Modify: `scripts/ci/lite-runtime-boundary-inventory.test.ts`
- Modify: `scripts/ci/lite-tools-select-route-contract.test.ts`
- Modify: `scripts/ci/lite-learning-kernel.test.ts`
- Modify: `scripts/ci/server-product-smoke.test.ts`

**Step 1: Add failing deletion tests**

Assert the four tool paths return 404 from real application registration,
temporary inventory count is zero, and no active matrix entry has
`internal_guidance`, `internal_evidence`, or `internal_control` exposure.

**Step 2: Move retained tests to canonical owners**

- Tool selection and decision persistence tests call `LearningKernel`.
- Product receipt and attributed feedback tests call `/v1/guide` and
  `/v1/feedback`.
- Remove test-only registration of the retired paths.

**Step 3: Delete adapters and registration**

Delete `memory-feedback-tools.ts` and all registration/type plumbing. Keep the
learning kernel and its direct tests.

**Step 4: Update inventories and guards**

Mark all eight former temporary rows `removed`. Expected inventory:

```text
required = 19
temporary = 0
removed = 53
active route matrix = 19
```

Add a source guard that rejects the eight retired route strings in production
`src`, supported integration source, and Runtime E2E scripts. Historical
reports/docs may retain them only as explicitly historical evidence.

**Step 5: Verify tranche 2**

```bash
npm run -s typecheck
node --import tsx --test scripts/ci/lite-learning-kernel.test.ts scripts/ci/lite-product-feedback-closed-loop.test.ts scripts/ci/lite-runtime-boundary-inventory.test.ts scripts/ci/server-product-smoke.test.ts
cd /Volumes/ziel/new.aionis/AionisManifest && npm run -s verify
```

Expected: all pass and no temporary route remains.

**Step 6: Commit**

```bash
git add src scripts/ci docs/architecture/AIONIS_RUNTIME_SURFACE_INVENTORY.md
git commit -m "refactor: remove tool learning transports"
```

### Task 7: Align SDK Contracts and Complexity Budgets

**Files:**

- Modify: `src/sdk.ts`
- Modify: `/Volumes/ziel/new.aionis/aionis-sdk/src/index.ts` through the existing ownership sync
- Modify: `docs/architecture/runtime-complexity-budget.json`
- Modify: `scripts/ci/sdk-contract-ownership.test.mjs`
- Modify: `scripts/ci/runtime-complexity-budget.test.mjs` only if assertions require the achieved route count

**Step 1: Add SDK request/result types**

Add `tool_candidates` to `AionisGuideRequest`, a typed
`AionisToolSelectionReceipt`, and a discriminated union for memory versus tool
selection feedback. Keep generic response support.

**Step 2: Sync and verify ownership**

```bash
npm run -s sdk:sync
npm run -s sdk:check
node --test scripts/ci/sdk-contract-ownership.test.mjs
cd /Volumes/ziel/new.aionis/aionis-sdk && npm test
```

Expected: sync produces only the owned SDK region and all tests pass.

**Step 3: Lower the route budget**

Run the deterministic collector and set the achieved thresholds. Route matrix
must be 19 and import cycles must be zero. Lower source line/file budgets only
to actual measured values.

**Step 4: Commit**

```bash
git add src/sdk.ts docs/architecture/runtime-complexity-budget.json scripts/ci/sdk-contract-ownership.test.mjs
git commit -m "chore: lock transport-free runtime budget"
```

### Task 8: Full Real Verification and Exit Report

**Files:**

- Create: `docs/research/2026-07-10-runtime-temporary-transport-removal-verification.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/performance/AIONIS_RUNTIME_PERFORMANCE_BASELINE.md` only when new measurements are recorded

**Step 1: Run Runtime verification**

```bash
npm run -s typecheck
npm run -s sdk:check
npm run -s complexity:check
npm run -s lite:test
npm run -s lite:smoke
npm run -s runtime:e2e:golden-product-loop
npm run -s runtime:e2e:ordinary-memory
npm run -s runtime:e2e:multi-agent
npm run -s runtime:e2e:multi-agent-negative
npm run -s runtime:e2e:judgment-calibration
```

Expected: zero failures and zero unexplained skips.

**Step 2: Run native zvec verification**

```bash
npx tsx --test scripts/ci/ann-index-contract.test.ts
npm run -s runtime:e2e:zvec-ann-write-through
```

Expected: native tests run, not skip.

**Step 3: Run external verification**

```bash
(cd /Volumes/ziel/new.aionis/AionisManifest && npm run -s verify)
(cd /Volumes/ziel/new.aionis/AionisSubstrate && npm run -s typecheck && npm test)
(cd /Volumes/ziel/new.aionis/aionis-sdk && npm test)
(cd /Volumes/ziel/new.aionis/aionis-cli && npm test)
(cd /Volumes/ziel/new.aionis/aionis-create && npm test)
(cd /Volumes/ziel/new.aionis/aionis-mcp && npm test)
(cd /Volumes/ziel/new.aionis/aionis-aifs && npm test)
(cd /Volumes/ziel/new.aionis/aionis-claude-code && npm run -s typecheck && npm test)
```

Expected: all pass.

**Step 4: Run performance comparison**

Run the Runtime-only baseline in the current worktree and the
`421ca12` pre-phase checkpoint under the same machine conditions. P50/P95
regression above 10% requires investigation.

**Step 5: Confirm deletion completeness**

Search production Runtime source, Runtime E2E scripts, Manifest source, and
active eval scripts for the eight retired paths. Expected: zero references.

Record final modules, lines, route exposures, environment fields, import
cycles, largest files, and deleted files/paths. State any target not met.

**Step 6: Publish and commit report**

```bash
git add docs/research/2026-07-10-runtime-temporary-transport-removal-verification.md CHANGELOG.md docs/architecture/runtime-complexity-budget.json
git commit -m "docs: verify temporary transport removal"
```

The report must distinguish Runtime capability evidence from external package
compatibility and must not claim external task pass rate as an Aionis product
effect.

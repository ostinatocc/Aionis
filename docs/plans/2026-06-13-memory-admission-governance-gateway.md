# Memory Admission Governance Gateway Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn Aionis' existing guide, receipt, feedback, measure, and snapshot loop into a productized memory admission data plane, then expose it as Memory Firewall, backend-agnostic Memory Governance Gateway, and Agent Flight Recorder.

**Architecture:** Reuse the current product path instead of adding a parallel memory system: `/v1/guide` produces governed context and admission records, `/v1/feedback` joins outcome attribution by `guide_trace_id`, `/v1/measure` summarizes calibration, `/v1/operator/snapshot` and audit routes expose read-only records. External memory backends enter through a new governance adapter that maps candidate memories into the existing four-action surface: `use_now`, `inspect_before_use`, `do_not_use`, and `rehydrate`.

**Tech Stack:** TypeScript, Fastify routes, Zod product schemas in `src/memory/product-output-contract.ts`, product assembly in `src/memory/product-output-assembler.ts`, Lite SQLite stores, `@aionis/sdk`, `@aionis/mcp`, Node test runner, `tsx`.

---

## Current Implementation Status

The first product slice is implemented as a read-only compact
`AionisMemoryAdmissionRecord` derived from the existing
`memory_decision_trace`. The stable contract is documented in
`docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md` and exposed through:

- `memory_decision_trace.admission_record`
- `operator_snapshot.memory_admission_record`
- SDK `compileExecutionAgentContext().memory_admission_record`
- MCP `aionis_context.memory_admission_record`

Admission Dataset Export v1 is also implemented as SDK-side JSONL helpers:

- `memoryAdmissionDatasetRowsFromGuide()`
- `memoryAdmissionDatasetJsonlFromGuide()`
- `memoryAdmissionDatasetRowsFromRecord()`
- `memoryAdmissionDatasetJsonlFromRecords()`

This implemented slice is intentionally narrower than the future gateway plan
below. It exports JSONL from guide/record objects supplied by the host, but it
does not persist per-row admission records in Runtime, add external backend
governance, train an admission model, or change Runtime gates.

## Product Boundary

This plan adds one shared data spine and three product surfaces:

1. **Memory Admission Record**: formal record of one memory candidate's admission decision in one guide/context run.
2. **Admission Dataset Export**: JSONL export of admission decisions and later feedback/outcome attribution.
3. **Backend-Agnostic Memory Governance Gateway**: govern candidates from Mem0, Zep, vector DBs, markdown, or internal stores without requiring Aionis to store them first.
4. **Memory Firewall**: product packaging of the gateway for stale, failed, poisoned, contested, or unsafe memory prevention.
5. **Agent Flight Recorder**: product packaging of admission records, decision traces, receipts, and snapshots for incident replay.

Non-goals:

- Do not train a learned admission model in this phase.
- Do not let LLM or learned policy bypass hard lifecycle, scope, source, suppression, or authority gates.
- Do not put admission records into the Agent prompt.
- Do not add a second Runtime core for Firewall or Flight Recorder.
- Do not mutate Runtime policy from one benchmark or one external repo case.

Hard invariant:

```text
candidate memory
  -> deterministic safety / lifecycle / scope gate
  -> optional learned or heuristic ranking signal
  -> context compiler
  -> admission record + receipt
  -> host feedback attribution
  -> measure / snapshot / export
```

---

## Existing Surfaces To Reuse

Use these existing files as anchors:

- Product route: `src/routes/product-facade.ts`
- Operator snapshot route: `src/routes/operator-snapshot.ts`
- Product schemas: `src/memory/product-output-contract.ts`
- Product assembly: `src/memory/product-output-assembler.ts`
- Operator snapshot assembly: `src/memory/operator-snapshot.ts`
- Feedback logic: `src/memory/feedback.ts`
- Lifecycle logic: `src/memory/lifecycle-lite.ts`, `src/memory/semantic-forgetting.ts`, `src/memory/memory-lifecycle-adjudicator.ts`
- Candidate inference: `src/memory/lifecycle-candidate-inference.ts`
- SDK: `src/sdk.ts`, `packages/aionis-sdk/src/index.ts`, `packages/aionis-sdk/test/sdk.test.ts`
- MCP: `packages/aionis-mcp/src/server.ts`, `packages/aionis-mcp/src/tools.ts`, `packages/aionis-mcp/test/mcp.test.ts`
- Product tests: `scripts/ci/lite-product-output-contract.test.ts`, `scripts/ci/lite-product-output-assembler.test.ts`, `scripts/ci/lite-product-facade-route.test.ts`, `scripts/ci/lite-product-feedback-closed-loop.test.ts`, `scripts/ci/lite-operator-snapshot-route.test.ts`, `scripts/ci/lite-sdk-client.test.ts`
- Current product docs: `README.md`, `docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md`, `docs/AIONIS_PRODUCT_API_USAGE.md`, `docs/AIONIS_PRODUCT_CONTRACT.md`, `docs/AIONIS_HOST_INTEGRATION.md`, `docs/AIONIS_JUDGMENT_LEDGER_ENHANCEMENT.md`, `docs/AIONIS_MCP.md`

Run after each implementation chunk:

```bash
npm run -s typecheck
npm run -s lite:test
```

Run before committing larger product chunks:

```bash
npm run -s test:focused
```

---

## Phase 0: Contract Alignment And Baseline

### Task 0.1: Add Product Plan And Inventory Links

**Files:**
- Modify: `docs/PRODUCT_CAPABILITY_INVENTORY.md`
- Modify: `docs/AIONIS_PRODUCT_POSITIONING.md`
- Create or keep: `docs/plans/2026-06-13-memory-admission-governance-gateway.md`

**Step 1: Document the six product surfaces**

Add a short section that classifies:

- Agent Context Runtime
- Execution Memory / Multi-Agent Handoff
- Controlled Forgetting / Lifecycle Governance
- Operator Audit / Memory Use Trace
- Memory Firewall / Memory Governance Gateway
- Agent Flight Recorder
- SDK / MCP / installer as distribution, not a core product surface

**Step 2: Add boundary note**

State that Firewall and Flight Recorder reuse existing `guide`, `memory_decision_trace`, `memory_use_receipt`, `feedback`, `measure`, and `operator_snapshot`.

**Step 3: Run docs-only sanity**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

**Step 4: Commit**

```bash
git add docs/PRODUCT_CAPABILITY_INVENTORY.md docs/AIONIS_PRODUCT_POSITIONING.md docs/plans/2026-06-13-memory-admission-governance-gateway.md
git commit -m "docs: plan admission governance product surfaces"
```

---

## Phase 1: Memory Admission Record Schema

### Task 1.1: Add `AionisMemoryAdmissionRecord` Contract

**Files:**
- Modify: `src/memory/product-output-contract.ts`
- Modify: `docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md`
- Test: `scripts/ci/lite-product-output-contract.test.ts`

**Step 1: Write failing schema tests**

Add tests that parse a minimal record:

```ts
const parsed = AionisMemoryAdmissionRecordSchema.parse({
  contract_version: "aionis_memory_admission_record_v1",
  intended_use: "admission_audit",
  admission_record_id: "admission:guide-1:mem-1",
  guide_trace_id: "guide_trace:1",
  run_id: "run-1",
  tenant_id: "tenant-1",
  scope: "project-1",
  memory_id: "mem-1",
  source_backend: "aionis",
  memory_origin: "internal",
  candidate_text_hash: "sha256:abc",
  candidate_visible_to_agent: true,
  prompt_payload_included: true,
  surface: "use_now",
  admission_action: "use_now",
  admission_authority: "trusted",
  reason_codes: ["current_active_state"],
  risk_flags: [],
  evidence_refs: [],
  feedback: {
    attribution_state: "pending",
    used_by_agent: null,
    outcome: null,
    feedback_trace_id: null,
    attributed_at: null
  },
  timestamps: {
    decided_at: "2026-06-13T00:00:00.000Z",
    updated_at: "2026-06-13T00:00:00.000Z"
  },
  agent_prompt_included: false,
  runtime_mutation: false
});

assert.equal(parsed.agent_prompt_included, false);
assert.equal(parsed.runtime_mutation, false);
```

Add rejection tests:

- invalid `admission_action`
- missing `guide_trace_id`
- `agent_prompt_included: true`
- feedback `used_by_agent: true` without an attribution state

**Step 2: Implement minimal Zod schema**

Add:

```ts
export const AionisMemoryAdmissionActionSchema = z.enum([
  "use_now",
  "inspect_before_use",
  "do_not_use",
  "rehydrate",
  "not_selected",
  "blocked"
]);

export const AionisMemoryAdmissionRecordSchema = z.object({
  contract_version: z.literal("aionis_memory_admission_record_v1"),
  intended_use: z.literal("admission_audit"),
  admission_record_id: z.string().min(1),
  guide_trace_id: z.string().min(1),
  run_id: z.string().nullable(),
  tenant_id: z.string().nullable(),
  scope: z.string().nullable(),
  memory_id: z.string().min(1),
  external_memory_id: z.string().nullable().default(null),
  source_backend: z.string().min(1),
  memory_origin: z.enum(["internal", "external", "synthetic", "unknown"]),
  candidate_text_hash: z.string().nullable(),
  candidate_visible_to_agent: z.boolean(),
  prompt_payload_included: z.boolean(),
  surface: z.enum(["use_now", "inspect_before_use", "do_not_use", "rehydrate", "not_selected", "blocked"]),
  admission_action: AionisMemoryAdmissionActionSchema,
  admission_authority: z.enum(["trusted", "advisory", "candidate", "blocked", "none"]),
  reason_codes: z.array(z.string()),
  risk_flags: z.array(z.string()),
  evidence_refs: z.array(z.string()),
  feedback: z.object({
    attribution_state: z.enum(["pending", "supported", "contradicted", "unused", "weak", "inconclusive"]),
    used_by_agent: z.boolean().nullable(),
    outcome: z.enum(["positive", "negative", "neutral"]).nullable(),
    feedback_trace_id: z.string().nullable(),
    attributed_at: z.string().datetime().nullable()
  }),
  timestamps: z.object({
    decided_at: z.string().datetime(),
    updated_at: z.string().datetime()
  }),
  agent_prompt_included: z.literal(false),
  runtime_mutation: z.literal(false)
});

export type AionisMemoryAdmissionRecord = z.infer<typeof AionisMemoryAdmissionRecordSchema>;
```

Add an array schema:

```ts
export const AionisMemoryAdmissionRecordSetSchema = z.object({
  contract_version: z.literal("aionis_memory_admission_record_set_v1"),
  intended_use: z.literal("admission_audit"),
  guide_trace_id: z.string().min(1),
  records: z.array(AionisMemoryAdmissionRecordSchema),
  agent_prompt_included: z.literal(false),
  runtime_mutation: z.literal(false)
});
```

**Step 3: Document the contract**

In `docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md`, add a section near `Memory Use Receipt`:

- why it exists
- fields
- prompt/debug boundary
- relationship to receipt and judgment calibration
- not a learned policy yet

**Step 4: Run targeted tests**

```bash
npx tsx --test scripts/ci/lite-product-output-contract.test.ts
```

Expected: new contract tests pass.

**Step 5: Commit**

```bash
git add src/memory/product-output-contract.ts docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md scripts/ci/lite-product-output-contract.test.ts
git commit -m "feat: add memory admission record contract"
```

---

### Task 1.2: Assemble Admission Records From Existing Trace

**Files:**
- Modify: `src/memory/product-output-assembler.ts`
- Test: `scripts/ci/lite-product-output-assembler.test.ts`

**Step 1: Write failing assembler tests**

Test cases:

1. `use_now_memory_ids` produces `admission_action: "use_now"` and `prompt_payload_included: true`.
2. `inspect_before_use_memory_ids` produces `admission_action: "inspect_before_use"`.
3. `do_not_use_memory_ids` produces `admission_action: "do_not_use"` and `prompt_payload_included: false`.
4. `rehydrate_hints[].memory_id` produces `admission_action: "rehydrate"`.
5. Records are absent from `agent_context.prompt_text`.
6. Reason codes and risk flags come from `memory_decision_trace` and receipt when present.

**Step 2: Add pure assembler**

Add a pure function:

```ts
export function buildAionisMemoryAdmissionRecordSet(args: {
  guide_trace_id: string;
  run_id?: string | null;
  tenant_id?: string | null;
  scope?: string | null;
  agent_context?: unknown;
  memory_decision_trace?: unknown;
  memory_use_receipt?: unknown;
  now?: string;
}): AionisMemoryAdmissionRecordSet;
```

Implementation rules:

- Prefer `agent_context` surfaces for prompt exposure.
- Use `memory_decision_trace.memory_decisions` for reason codes when available.
- Use `memory_use_receipt.decision_summaries` as secondary evidence.
- Create one record per unique memory ID across `use_now`, `inspect_before_use`, `do_not_use`, `rehydrate`.
- Do not include raw memory payloads.
- Default `feedback.attribution_state` to `pending`.
- Set `agent_prompt_included: false` on the record set.

**Step 3: Run targeted tests**

```bash
npx tsx --test scripts/ci/lite-product-output-assembler.test.ts
```

Expected: new admission assembler tests pass.

**Step 4: Run product route tests**

```bash
npx tsx --test scripts/ci/lite-product-facade-route.test.ts
```

Expected: no guide output regressions.

**Step 5: Commit**

```bash
git add src/memory/product-output-assembler.ts scripts/ci/lite-product-output-assembler.test.ts
git commit -m "feat: assemble memory admission records from guide trace"
```

---

### Task 1.3: Attach Admission Records To Debug/Audit Outputs

**Files:**
- Modify: `src/routes/product-facade.ts`
- Modify: `src/memory/product-output-contract.ts`
- Modify: `src/memory/operator-snapshot.ts`
- Test: `scripts/ci/lite-product-facade-route.test.ts`
- Test: `scripts/ci/lite-operator-snapshot-route.test.ts`

**Step 1: Write failing route tests**

Add assertions:

- `/v1/guide` returns admission records only in debug/audit surface when `include_packets: true` or equivalent existing debug mode is enabled.
- `agent_context.prompt_text` does not include `memory_admission_records`.
- `/v1/audit/memory-decision-report` includes admission record summary.
- `/v1/operator/snapshot` includes compact admission summary.

**Step 2: Add route integration**

In `src/routes/product-facade.ts`, after guide trace and agent context are assembled:

- build `memory_admission_records`
- attach to `memory_decision_trace` or a sibling debug field
- do not alter `agent_context`
- include source map entry: `"memory_admission_records"`

**Step 3: Add operator snapshot projection**

In `src/memory/operator-snapshot.ts`, add a compact section:

```ts
admission_summary: {
  contract_version: "aionis_admission_summary_v1";
  use_now_count: number;
  inspect_before_use_count: number;
  do_not_use_count: number;
  rehydrate_count: number;
  pending_feedback_count: number;
  supported_count: number;
  contradicted_count: number;
  agent_prompt_included: false;
  runtime_mutation: false;
}
```

**Step 4: Run tests**

```bash
npx tsx --test scripts/ci/lite-product-facade-route.test.ts
npx tsx --test scripts/ci/lite-operator-snapshot-route.test.ts
npm run -s typecheck
```

Expected: all pass.

**Step 5: Commit**

```bash
git add src/routes/product-facade.ts src/memory/product-output-contract.ts src/memory/operator-snapshot.ts scripts/ci/lite-product-facade-route.test.ts scripts/ci/lite-operator-snapshot-route.test.ts
git commit -m "feat: expose admission records on audit surfaces"
```

---

## Phase 2: Feedback Attribution Join

### Task 2.1: Join Feedback To Admission Records By Guide Trace

**Files:**
- Modify: `src/routes/product-facade.ts`
- Modify: `src/memory/product-output-assembler.ts`
- Test: `scripts/ci/lite-product-feedback-closed-loop.test.ts`

**Step 1: Write failing tests**

Test:

- guide exposes `mem-a` in `use_now` and `mem-b` in `inspect_before_use`
- feedback submits `guide_trace_id`, `used_memory_ids: ["mem-a"]`, `outcome: "positive"`
- resulting feedback surface marks `mem-a` as supported
- `mem-b` remains unused, not negative
- feedback with non-exposed memory ID is rejected with existing `guide_trace_used_memory_not_exposed`

**Step 2: Implement attribution summary**

Reuse existing guide trace validation. Add or extend a pure projection:

```ts
export function applyFeedbackToAdmissionRecords(args: {
  records: AionisMemoryAdmissionRecord[];
  guide_trace_id: string;
  used_memory_ids: string[];
  outcome: "positive" | "negative" | "neutral";
  feedback_trace_id?: string | null;
  attributed_at: string;
}): AionisMemoryAdmissionRecord[];
```

Rules:

- Only used IDs from matching guide trace can be supported or contradicted.
- Exposed but unused records become `unused`, not `negative`.
- Negative feedback on `inspect_before_use` stays weak/inconclusive unless existing hard threshold gates say otherwise.
- This projection is read-only unless existing lifecycle/feedback routes already mutate state under their own gates.

**Step 3: Surface in feedback response**

Add compact result under existing feedback/forget effect structure:

```ts
admission_feedback: {
  contract_version: "aionis_admission_feedback_v1";
  guide_trace_id: string;
  supported_memory_ids: string[];
  contradicted_memory_ids: string[];
  unused_memory_ids: string[];
  weak_memory_ids: string[];
  authority_mutation: false;
}
```

**Step 4: Run tests**

```bash
npx tsx --test scripts/ci/lite-product-feedback-closed-loop.test.ts
npx tsx --test scripts/ci/lite-product-facade-route.test.ts
npm run -s typecheck
```

Expected: feedback attribution tests pass.

**Step 5: Commit**

```bash
git add src/routes/product-facade.ts src/memory/product-output-assembler.ts scripts/ci/lite-product-feedback-closed-loop.test.ts
git commit -m "feat: join feedback outcomes to admission records"
```

---

## Phase 3: Admission Dataset Export

### Task 3.1: Define JSONL Export Record

**Files:**
- Modify: `src/memory/product-output-contract.ts`
- Modify: `docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md`
- Test: `scripts/ci/lite-product-output-contract.test.ts`

**Step 1: Add schema tests**

Define export record as a stable JSONL row:

```ts
{
  contract_version: "aionis_admission_dataset_row_v1",
  row_id: "dataset:guide-1:mem-1",
  guide_trace_id: "guide_trace:1",
  memory_id: "mem-1",
  source_backend: "aionis",
  task: {
    run_id: "run-1",
    task_signature: "checkout-migration",
    task_family: "coding"
  },
  features: {
    admission_action: "use_now",
    admission_authority: "trusted",
    surface: "use_now",
    reason_codes: ["current_active_state"],
    risk_flags: [],
    context_mode: "compact_agent",
    agent_role: "worker"
  },
  label: {
    state: "supported",
    used_by_agent: true,
    outcome: "positive",
    attribution_source: "host_feedback"
  },
  privacy: {
    includes_raw_payload: false,
    includes_prompt_text: false,
    text_hash_only: true
  }
}
```

**Step 2: Implement schema**

Add `AionisAdmissionDatasetRowSchema` and type export.

**Step 3: Run schema tests**

```bash
npx tsx --test scripts/ci/lite-product-output-contract.test.ts
```

**Step 4: Commit**

```bash
git add src/memory/product-output-contract.ts docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md scripts/ci/lite-product-output-contract.test.ts
git commit -m "feat: add admission dataset export contract"
```

---

### Task 3.2: Add Read-Only Export Route

**Files:**
- Modify: `src/routes/product-facade.ts`
- Modify: `src/sdk.ts`
- Test: `scripts/ci/lite-product-facade-route.test.ts`
- Test: `scripts/ci/lite-sdk-client.test.ts`

**Step 1: Choose route**

Use audit namespace:

```text
POST /v1/audit/admission-dataset/export
```

Request:

```ts
{
  tenant_id?: string;
  scope?: string;
  guide_trace_ids?: string[];
  run_ids?: string[];
  since?: string;
  until?: string;
  format?: "jsonl" | "json";
  include_text?: false;
  limit?: number;
}
```

First implementation can export from supplied `guide`, `feedback`, or `measure` packets if persistent lookup is not ready:

```ts
{
  guide?: unknown;
  feedback_result?: unknown;
  measure_result?: unknown;
}
```

Do not block Phase 3 on full historical persistence.

**Step 2: Write failing route tests**

Test:

- route returns `application/x-ndjson` when `format: "jsonl"`
- rows contain no raw prompt text
- rows include label state when feedback is provided
- route is read-only and source map says audit export

**Step 3: Implement route**

Implement using existing assembled admission records and feedback projection.

**Step 4: Add SDK method**

In `src/sdk.ts`:

```ts
async exportAdmissionDataset<T = unknown>(
  body: AionisAdmissionDatasetExportRequest,
  options?: AionisRequestOptions
): Promise<T>
```

**Step 5: Run tests**

```bash
npx tsx --test scripts/ci/lite-product-facade-route.test.ts
npx tsx --test scripts/ci/lite-sdk-client.test.ts
npm run -s typecheck
```

**Step 6: Commit**

```bash
git add src/routes/product-facade.ts src/sdk.ts scripts/ci/lite-product-facade-route.test.ts scripts/ci/lite-sdk-client.test.ts
git commit -m "feat: export admission dataset rows"
```

---

### Task 3.3: Add Persistent Admission Ledger Only If Needed

**Files:**
- Modify: `src/store/lite-write-store.ts`
- Modify: `src/store/memory-store.ts`
- Test: new or existing store-focused Lite test

**Decision gate before implementation:**

Only add a table if packet-only export is insufficient for SDK and operator use. If current guide/feedback traces already persist enough data, skip this task.

If needed, add a small append-only table:

```sql
CREATE TABLE IF NOT EXISTS lite_memory_admission_records (
  admission_record_id TEXT PRIMARY KEY,
  guide_trace_id TEXT NOT NULL,
  tenant_id TEXT,
  scope TEXT,
  memory_id TEXT NOT NULL,
  source_backend TEXT NOT NULL,
  admission_action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lite_memory_admission_records_guide
  ON lite_memory_admission_records(guide_trace_id);

CREATE INDEX IF NOT EXISTS idx_lite_memory_admission_records_scope_created
  ON lite_memory_admission_records(scope, created_at);
```

Rules:

- Append-only for decision creation.
- Feedback updates should append or update only attribution fields, never rewrite original decision fields.
- No raw prompt text.

Commit:

```bash
git add src/store/lite-write-store.ts src/store/memory-store.ts scripts/ci/<new-store-test>.ts
git commit -m "feat: persist admission records for dataset export"
```

---

## Phase 4: Backend-Agnostic Memory Governance Gateway

### Task 4.1: Add External Candidate Contract

**Files:**
- Modify: `src/memory/product-output-contract.ts`
- Modify: `docs/AIONIS_PRODUCT_API_USAGE.md`
- Test: `scripts/ci/lite-product-output-contract.test.ts`

**Step 1: Add schema tests**

Candidate:

```ts
{
  external_memory_id: "mem0:abc",
  source_backend: "mem0",
  text: "Legacy route using fullBundleEnvironment.ts failed verification.",
  metadata: {
    created_at: "2026-06-13T00:00:00.000Z",
    updated_at: "2026-06-13T00:00:00.000Z",
    scope: "checkout-migration",
    source_url: null
  },
  authority: {
    source_trust: "untrusted",
    scope: "project",
    evidence_requirement: "inspect_before_use"
  },
  lifecycle_hint: "failed",
  evidence_refs: ["ci-log:123"]
}
```

**Step 2: Implement schemas**

Add:

```ts
export const AionisExternalMemoryCandidateSchema = z.object({
  external_memory_id: z.string().min(1),
  source_backend: z.string().min(1),
  text: z.string().min(1).max(200000),
  metadata: z.record(z.unknown()).default({}),
  authority: z.object({
    source_trust: z.enum(["trusted", "known", "untrusted", "unknown"]).default("unknown"),
    scope: z.enum(["user", "project", "team", "org", "global", "unknown"]).default("unknown"),
    evidence_requirement: z.enum(["none", "inspect_before_use", "rehydrate_before_use", "blocked"]).default("inspect_before_use")
  }).default({}),
  lifecycle_hint: z.enum(["current", "procedure", "failed", "stale", "contested", "suppressed", "archived", "unknown"]).default("unknown"),
  evidence_refs: z.array(z.string()).default([])
});
```

**Step 3: Run schema tests**

```bash
npx tsx --test scripts/ci/lite-product-output-contract.test.ts
```

**Step 4: Commit**

```bash
git add src/memory/product-output-contract.ts docs/AIONIS_PRODUCT_API_USAGE.md scripts/ci/lite-product-output-contract.test.ts
git commit -m "feat: add external memory candidate contract"
```

---

### Task 4.2: Implement Pure Governance Adapter

**Files:**
- Create: `src/memory/external-candidate-governance.ts`
- Test: `scripts/ci/lite-external-candidate-governance.test.ts`

**Step 1: Write tests**

Test:

- failed candidate becomes `inspect_before_use` or `do_not_use`, never `use_now`
- trusted current candidate may become `use_now`
- unknown source defaults to `inspect_before_use`
- suppressed candidate becomes `do_not_use`
- rehydration hint becomes `rehydrate`
- output has admission records with `memory_origin: "external"`

**Step 2: Implement pure adapter**

```ts
export function governExternalMemoryCandidates(args: {
  tenant_id?: string | null;
  scope?: string | null;
  run_id?: string | null;
  query_text: string;
  candidates: AionisExternalMemoryCandidate[];
  mode?: "standard" | "strict" | "firewall";
  now?: string;
}): {
  agent_context: AionisAgentContext;
  memory_admission_records: AionisMemoryAdmissionRecordSet;
  memory_use_receipt: AionisMemoryUseReceipt;
};
```

Rules:

- No writes to Aionis memory store.
- External candidate IDs must be stable and visible in receipts.
- Hard unsafe lifecycle hints cannot become `use_now`.
- Unknown candidates default to inspect.
- The adapter may call existing lifecycle/contract helpers where possible; avoid duplicating gate logic.

**Step 3: Run tests**

```bash
npx tsx --test scripts/ci/lite-external-candidate-governance.test.ts
npm run -s typecheck
```

**Step 4: Commit**

```bash
git add src/memory/external-candidate-governance.ts scripts/ci/lite-external-candidate-governance.test.ts
git commit -m "feat: govern external memory candidates"
```

---

### Task 4.3: Add Governance Gateway Route

**Files:**
- Modify: `src/routes/product-facade.ts`
- Modify: `src/sdk.ts`
- Test: `scripts/ci/lite-product-facade-route.test.ts`
- Test: `scripts/ci/lite-sdk-client.test.ts`

**Step 1: Add route**

Use:

```text
POST /v1/memory/govern
```

Request:

```ts
{
  tenant_id?: string;
  scope?: string;
  run_id?: string;
  query_text: string;
  mode?: "standard" | "strict" | "firewall";
  context_mode?: "standard" | "compact_agent";
  candidates: AionisExternalMemoryCandidate[];
  include_records?: boolean;
}
```

Response:

```ts
{
  contract_version: "aionis_memory_governance_result_v1";
  agent_context: AionisAgentContext;
  memory_use_receipt: AionisMemoryUseReceipt;
  memory_admission_records?: AionisMemoryAdmissionRecordSet;
  source_map: {
    routes_used: ["/v1/memory/govern"];
    internal_surfaces_used: ["external_candidate_governance", "memory_admission_records"];
  }
}
```

**Step 2: Write route tests**

Test:

- route accepts candidates from `mem0`, `zep`, `vector_db`, `markdown`, `custom`
- unsafe external candidates do not enter `use_now`
- response prompt does not include audit internals
- `include_records: true` returns records
- no Runtime memory nodes are written

**Step 3: Add SDK method**

```ts
async governMemory<T = unknown>(
  body: AionisMemoryGovernanceRequest,
  options?: AionisRequestOptions
): Promise<T>
```

**Step 4: Run tests**

```bash
npx tsx --test scripts/ci/lite-product-facade-route.test.ts
npx tsx --test scripts/ci/lite-sdk-client.test.ts
npm run -s typecheck
```

**Step 5: Commit**

```bash
git add src/routes/product-facade.ts src/sdk.ts scripts/ci/lite-product-facade-route.test.ts scripts/ci/lite-sdk-client.test.ts
git commit -m "feat: add memory governance gateway route"
```

---

## Phase 5: Memory Firewall Product Surface

### Task 5.1: Package Firewall Mode

**Files:**
- Modify: `src/memory/external-candidate-governance.ts`
- Modify: `src/memory/product-output-contract.ts`
- Modify: `docs/AIONIS_PRODUCT_API_USAGE.md`
- Create: `docs/AIONIS_MEMORY_FIREWALL.md`
- Test: `scripts/ci/lite-external-candidate-governance.test.ts`

**Step 1: Add firewall-specific tests**

Cases:

- stale premise in query + current contrary candidate -> stale candidate blocked/inspect
- failed branch candidate -> no direct use
- contested external source -> inspect only
- suppressed candidate -> do_not_use
- unknown authority + high-risk task -> inspect only

**Step 2: Add result summary**

Add to route output:

```ts
firewall: {
  contract_version: "aionis_memory_firewall_summary_v1";
  mode: "firewall";
  blocked_count: number;
  inspect_count: number;
  rehydrate_count: number;
  direct_use_count: number;
  risk_flags: string[];
  claims: Array<{
    claim: string;
    status: "pass" | "warn" | "fail";
    evidence: string;
  }>;
}
```

**Step 3: Write docs**

`docs/AIONIS_MEMORY_FIREWALL.md` should explain:

- "Govern any memory backend before it reaches the prompt"
- hard gates vs advisory ranking
- what it catches
- what it does not guarantee
- how to use with Mem0/Zep/vector DB

**Step 4: Run tests**

```bash
npx tsx --test scripts/ci/lite-external-candidate-governance.test.ts
npx tsx --test scripts/ci/lite-product-output-contract.test.ts
npm run -s typecheck
```

**Step 5: Commit**

```bash
git add src/memory/external-candidate-governance.ts src/memory/product-output-contract.ts docs/AIONIS_PRODUCT_API_USAGE.md docs/AIONIS_MEMORY_FIREWALL.md scripts/ci/lite-external-candidate-governance.test.ts
git commit -m "feat: package memory firewall mode"
```

---

### Task 5.2: Add SDK And MCP Firewall Entry

**Files:**
- Modify: `src/sdk.ts`
- Modify: `packages/aionis-sdk/README.md`
- Modify: `packages/aionis-mcp/src/server.ts`
- Modify: `packages/aionis-mcp/src/tools.ts`
- Modify: `packages/aionis-mcp/README.md`
- Test: `scripts/ci/lite-sdk-client.test.ts`
- Test: `packages/aionis-mcp/test/mcp.test.ts`

**Step 1: SDK test**

Assert `client.memory.govern` or `client.governMemory` posts to `/v1/memory/govern`.

**Step 2: MCP tool**

Add tool:

```text
aionis_govern_memory
```

Description:

```text
Govern candidate memories from any backend before using them in an Agent prompt.
```

**Step 3: Run tests**

```bash
npx tsx --test scripts/ci/lite-sdk-client.test.ts
npm run -w @aionis/mcp -s test
npm run -s typecheck
```

**Step 4: Commit**

```bash
git add src/sdk.ts packages/aionis-sdk/README.md packages/aionis-mcp/src/server.ts packages/aionis-mcp/src/tools.ts packages/aionis-mcp/README.md scripts/ci/lite-sdk-client.test.ts packages/aionis-mcp/test/mcp.test.ts
git commit -m "feat: expose memory governance through sdk and mcp"
```

---

## Phase 6: Agent Flight Recorder

### Task 6.1: Define Flight Recorder Report Contract

**Files:**
- Modify: `src/memory/product-output-contract.ts`
- Modify: `docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md`
- Test: `scripts/ci/lite-product-output-contract.test.ts`

**Step 1: Add schema tests**

Report shape:

```ts
{
  contract_version: "aionis_agent_flight_recorder_report_v1",
  intended_use: "incident_replay_audit",
  guide_trace_id: "guide_trace:1",
  run_id: "run-1",
  decision_time: "2026-06-13T00:00:00.000Z",
  agent_view: {
    use_now_memory_ids: ["mem-current"],
    inspect_before_use_memory_ids: ["mem-risk"],
    do_not_use_memory_ids: ["mem-failed"],
    rehydrate_memory_ids: ["mem-archive"]
  },
  blocked_or_suppressed: [],
  attribution: {
    used_memory_ids: ["mem-current"],
    outcome: "positive",
    supported_memory_ids: ["mem-current"],
    contradicted_memory_ids: []
  },
  replay_sources: {
    has_agent_context: true,
    has_memory_decision_trace: true,
    has_memory_use_receipt: true,
    has_operator_snapshot: true
  },
  agent_prompt_included: false,
  runtime_mutation: false
}
```

**Step 2: Implement schema**

Add `AionisAgentFlightRecorderReportSchema`.

**Step 3: Run tests**

```bash
npx tsx --test scripts/ci/lite-product-output-contract.test.ts
```

**Step 4: Commit**

```bash
git add src/memory/product-output-contract.ts docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md scripts/ci/lite-product-output-contract.test.ts
git commit -m "feat: add agent flight recorder contract"
```

---

### Task 6.2: Build Flight Recorder As Read-Only Projection

**Files:**
- Create: `src/memory/agent-flight-recorder.ts`
- Test: `scripts/ci/lite-agent-flight-recorder.test.ts`

**Step 1: Write tests**

Test:

- builds report from `agent_context`, `memory_decision_trace`, `memory_use_receipt`, and optional `feedback_result`
- shows what the agent could see
- shows what was blocked
- includes feedback outcome if present
- no prompt text included
- no runtime mutation

**Step 2: Implement pure function**

```ts
export function buildAionisAgentFlightRecorderReport(args: {
  guide_trace_id: string;
  run_id?: string | null;
  agent_context?: unknown;
  memory_decision_trace?: unknown;
  memory_use_receipt?: unknown;
  memory_admission_records?: unknown;
  operator_snapshot?: unknown;
  feedback_result?: unknown;
  now?: string;
}): AionisAgentFlightRecorderReport;
```

**Step 3: Run tests**

```bash
npx tsx --test scripts/ci/lite-agent-flight-recorder.test.ts
npm run -s typecheck
```

**Step 4: Commit**

```bash
git add src/memory/agent-flight-recorder.ts scripts/ci/lite-agent-flight-recorder.test.ts
git commit -m "feat: build agent flight recorder report"
```

---

### Task 6.3: Add Flight Recorder Route And SDK

**Files:**
- Modify: `src/routes/product-facade.ts`
- Modify: `src/sdk.ts`
- Create: `docs/AIONIS_AGENT_FLIGHT_RECORDER.md`
- Test: `scripts/ci/lite-product-facade-route.test.ts`
- Test: `scripts/ci/lite-sdk-client.test.ts`

**Step 1: Add route**

Use:

```text
POST /v1/audit/flight-recorder
```

Request:

```ts
{
  guide_trace_id?: string;
  run_id?: string;
  guide?: unknown;
  memory_decision_trace?: unknown;
  memory_use_receipt?: unknown;
  operator_snapshot?: unknown;
  feedback_result?: unknown;
}
```

First version may require caller-supplied packets if historical lookup is not available.

**Step 2: Add route tests**

Test:

- route returns report
- route is read-only
- no prompt text included
- source map includes `/v1/audit/flight-recorder`

**Step 3: Add SDK method**

```ts
async flightRecorder<T = unknown>(
  body: AionisFlightRecorderRequest,
  options?: AionisRequestOptions
): Promise<T>
```

**Step 4: Write docs**

`docs/AIONIS_AGENT_FLIGHT_RECORDER.md`:

- incident question: "What did the agent know at decision time?"
- inputs
- output
- example
- limitations

**Step 5: Run tests**

```bash
npx tsx --test scripts/ci/lite-product-facade-route.test.ts
npx tsx --test scripts/ci/lite-sdk-client.test.ts
npm run -s typecheck
```

**Step 6: Commit**

```bash
git add src/routes/product-facade.ts src/sdk.ts docs/AIONIS_AGENT_FLIGHT_RECORDER.md scripts/ci/lite-product-facade-route.test.ts scripts/ci/lite-sdk-client.test.ts
git commit -m "feat: expose agent flight recorder audit route"
```

---

## Phase 7: Product Documentation And README

### Task 7.1: Update Public Product Story

**Files:**
- Modify: `README.md`
- Modify: `docs/AIONIS_PRODUCT_POSITIONING.md`
- Modify: `docs/AIONIS_HOST_INTEGRATION.md`
- Modify: `docs/AIONIS_PRODUCT_API_USAGE.md`

**Step 1: README product section**

Add a concise product map:

```text
Aionis has six product surfaces:
1. Agent Context Runtime
2. Execution Memory
3. Controlled Forgetting
4. Operator Audit
5. Memory Firewall
6. Agent Flight Recorder
```

But emphasize one core:

```text
These surfaces share the same Runtime loop: observe -> guide -> feedback -> measure -> snapshot.
```

**Step 2: Add Memory Firewall example**

Show:

```ts
const governed = await aionis.governMemory({
  query_text: "Continue checkout migration",
  mode: "firewall",
  candidates: memoriesFromMem0
});
```

**Step 3: Add Flight Recorder example**

Show:

```ts
const report = await aionis.flightRecorder({
  guide_trace_id: guide.guide_trace_id,
  guide,
  feedback_result: feedback
});
```

**Step 4: Run docs sanity**

```bash
git diff --check
```

**Step 5: Commit**

```bash
git add README.md docs/AIONIS_PRODUCT_POSITIONING.md docs/AIONIS_HOST_INTEGRATION.md docs/AIONIS_PRODUCT_API_USAGE.md
git commit -m "docs: position firewall and flight recorder product surfaces"
```

---

## Phase 8: Verification And Baselines

### Task 8.1: Focused Runtime Verification

**Files:**
- No source change unless failures reveal general contract bugs.

Run:

```bash
npm run -s typecheck
npm run -s lite:test
npm run -s packages:test
npm run -s test:focused
```

Expected:

- typecheck passes
- lite tests pass
- SDK/MCP/create package tests pass
- focused test suite passes

Commit only if test snapshots or docs were intentionally updated.

---

### Task 8.2: Product Quickstarts

Run:

```bash
npm run -s runtime:quickstart:sdk
npm run -s runtime:quickstart:http
npm run -s runtime:quickstart:multi-agent
```

Expected:

- guide still produces `agent_context`
- feedback attribution still works
- measure still reports history impact
- snapshot remains read-only
- admission records are visible only on audit/debug surfaces

---

### Task 8.3: External Agent E2E Regression

Use the existing eval workspace, not focused Runtime core:

```text
/Volumes/ziel/AionisRuntime-evals/external-agent-e2e
```

Minimum rerun:

- current 40-case Aionis-only holdout
- compare:
  - wrong write
  - wrong attention
  - accepted direction
  - action completion
  - prompt tokens

Expected:

- wrong write remains 0%
- wrong attention remains 0%
- accepted direction remains 100%
- token use should not regress materially

Do not change Runtime core from a single failed external repo case. Bucket failures first.

---

## Phase 9: Learned Admission Policy Readiness

### Task 9.1: Add Design Doc Only

**Files:**
- Create: `docs/AIONIS_LEARNED_ADMISSION_POLICY.md`

**Step 1: Document future architecture**

Write:

```text
Hard gates:
  source/scope/suppression/stale/failed/do_not_use/rehydrate

Learned layer:
  predicts marginal utility after hard gate
  may rank inspect/use_now candidates
  may request rehydrate
  cannot override block/suppress/do_not_use
```

**Step 2: Define training row source**

Use `aionis_admission_dataset_row_v1`.

**Step 3: Define rollout stages**

1. offline scoring only
2. shadow ranking
3. inspect priority
4. limited use_now ranking within hard-gated allowed set

**Step 4: Commit**

```bash
git add docs/AIONIS_LEARNED_ADMISSION_POLICY.md
git commit -m "docs: outline learned admission policy path"
```

---

## Final Acceptance Criteria

The feature is complete when:

- `AionisMemoryAdmissionRecord` is a formal product schema.
- Every guide/context run can produce admission records on audit/debug surfaces.
- Feedback joins to admission records by `guide_trace_id` and exposed memory IDs.
- Export can produce JSONL rows for future learned admission policy.
- `/v1/memory/govern` can govern external memory candidates without storing them in Aionis first.
- Memory Firewall mode blocks unsafe external candidates from direct prompt use.
- Agent Flight Recorder can answer: "What did the agent know, use, avoid, or rehydrate at decision time?"
- Admission records never appear in Agent prompt text.
- Learned/advisory signals cannot bypass hard lifecycle, scope, source, suppression, or authority gates.
- Existing `observe -> guide -> feedback -> measure -> snapshot` quickstarts still work.
- Focused Runtime tests pass.
- Existing external-agent E2E baseline does not regress on wrong write, wrong attention, accepted direction, or action completion.

---

## Recommended Commit Order

1. `docs: plan admission governance product surfaces`
2. `feat: add memory admission record contract`
3. `feat: assemble memory admission records from guide trace`
4. `feat: expose admission records on audit surfaces`
5. `feat: join feedback outcomes to admission records`
6. `feat: add admission dataset export contract`
7. `feat: export admission dataset rows`
8. `feat: add external memory candidate contract`
9. `feat: govern external memory candidates`
10. `feat: add memory governance gateway route`
11. `feat: package memory firewall mode`
12. `feat: expose memory governance through sdk and mcp`
13. `feat: add agent flight recorder contract`
14. `feat: build agent flight recorder report`
15. `feat: expose agent flight recorder audit route`
16. `docs: position firewall and flight recorder product surfaces`
17. `docs: outline learned admission policy path`

---

## Execution Recommendation

Implement in this order:

1. Phase 1 and Phase 2 first, because Admission Record plus Feedback Attribution is the data flywheel.
2. Phase 3 next, because export proves the data is a real product asset.
3. Phase 4 and Phase 5 next, because backend-agnostic governance and Memory Firewall are the market-facing wedge.
4. Phase 6 after the data spine is stable, because Flight Recorder depends on admission records and trace consistency.
5. Phase 9 last, and documentation-only for now.

Do not start with learned policy. The product should first prove the deterministic admission/outcome data loop.

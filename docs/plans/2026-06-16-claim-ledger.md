# Aionis Claim Ledger Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a narrow Aionis Claim Ledger that governs ordinary factual memory with evidence, slot validity, supersession, and auditability without replacing the current Runtime, recall, lifecycle, execution memory, or Judgment Calibration systems.

**Architecture:** Implement Claim Ledger as an internal Lite Runtime substrate beside the existing memory stores. `/v1/observe` writes explicit typed claims and their evidence links, `/v1/guide` compiles live and superseded claims into existing `use_now`, `inspect_before_use`, and `do_not_use` surfaces, while `/v1/measure` and operator snapshots expose read-only claim ledger summaries. The vector/embedding path can find candidates, but claim authority is decided by deterministic slot policy and existing Aionis lifecycle gates.

**Tech Stack:** TypeScript, Zod, Fastify product routes, Lite SQLite via `node:sqlite`, existing memory write/recall stores, `@aionis/sdk`, `@aionis/mcp`, Node test runner, `tsx`, Markdown docs.

---

## Product Boundary

This is a product-core memory governance enhancement, not a new agent framework.

Aionis already owns:

- execution continuity
- evidence grading
- guide/context assembly
- feedback attribution
- controlled forgetting
- learning-control decisions
- operator audit projections

Claim Ledger adds a missing ordinary-memory truth layer:

```text
Evidence says something happened.
Claim says Aionis may treat a fact as currently valid.
Cue helps recall but has no fact authority.
```

The first implementation must stay narrow:

- explicit or structurally declared claims only
- no broad LLM fact extraction in the first pass
- no external benchmark-specific rules
- no replacement of existing lifecycle, judgment calibration, or promotion evidence ledgers
- no autonomous agent action or orchestration
- no irreversible "ledger never deletes" claim

Hard invariants:

```text
embedding similarity != truth
old claim present != current claim valid
LLM slot proposal != authority
feedback != automatic permanent truth
unused exposure != negative evidence
claim ledger internals != Agent prompt
```

## Current Surfaces To Reuse

- Product contract: `docs/AIONIS_PRODUCT_CONTRACT.md`
- State model: `docs/AIONIS_STATE_MODEL.md`
- Judgment calibration doc: `docs/AIONIS_JUDGMENT_LEDGER_ENHANCEMENT.md`
- Output contract: `docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md`
- Product facade: `src/routes/product-facade.ts`
- Runtime service wiring: `src/app/runtime-services.ts`
- Write store pattern: `src/store/lite-write-store.ts`
- SQLite helper: `src/store/sqlite.ts`
- Product output schemas: `src/memory/product-output-contract.ts`
- Product output assembly: `src/memory/product-output-assembler.ts`
- Operator snapshot: `src/memory/operator-snapshot.ts`
- SDK mirror: `src/sdk.ts`, `packages/aionis-sdk/src/index.ts`
- SDK tests: `packages/aionis-sdk/test/sdk.test.ts`
- Product route tests: `scripts/ci/lite-product-facade-route.test.ts`
- Output tests: `scripts/ci/lite-product-output-contract.test.ts`, `scripts/ci/lite-product-output-assembler.test.ts`
- Source scope tests: `scripts/ci/lite-source-scope.test.mjs`

Run after each implementation chunk:

```bash
npm run -s typecheck
```

Run focused tests for the files touched:

```bash
npx tsx --test scripts/ci/lite-claim-ledger-store.test.ts
npx tsx --test scripts/ci/lite-claim-ledger-product-route.test.ts
npx tsx --test scripts/ci/lite-product-output-contract.test.ts
```

Run before final handoff:

```bash
npm run -s test:focused
```

---

## Phase 0: Baseline And Scope Lock

### Task 0.1: Capture Baseline

**Files:**
- Read: `docs/AIONIS_PRODUCT_CONTRACT.md`
- Read: `docs/AIONIS_STATE_MODEL.md`
- Read: `docs/AIONIS_JUDGMENT_LEDGER_ENHANCEMENT.md`
- Read: `src/routes/product-facade.ts`
- Read: `src/app/runtime-services.ts`
- Read: `src/store/lite-write-store.ts`

**Step 1: Check repo status**

Run:

```bash
git status --short --branch
```

Expected: no unrelated dirty files in files touched by this plan. If unrelated files are dirty, leave them alone.

**Step 2: Run current baseline**

Run:

```bash
npm run -s typecheck
npm run -s lite:test
```

Expected: both pass before implementation.

**Step 3: Record implementation note**

If baseline fails, stop and write the failure details into the implementation log. Do not start Claim Ledger work on a broken baseline unless the failure is clearly unrelated and accepted.

**Step 4: Commit baseline artifacts only if generated docs changed**

Run:

```bash
git status --short
```

If only generated example artifacts changed:

```bash
git add docs/examples
git commit -m "test: refresh claim ledger baseline artifacts"
```

---

## Phase 1: Data Contract And Store

### Task 1.1: Add Claim Ledger Contract Tests

**Files:**
- Create: `scripts/ci/lite-claim-ledger-contract.test.ts`
- Create: `src/memory/claim-ledger-contract.ts`

**Step 1: Write failing schema tests**

Create tests for these behaviors:

```ts
test("claim ledger accepts a singleton latest fact claim", () => {
  const parsed = AionisClaimWriteSchema.parse({
    contract_version: "aionis_claim_write_v1",
    client_id: "claim:user-location:1",
    subject_key: "user:self",
    predicate: "current_location",
    value: { city: "Shanghai" },
    slot_key: "user:self.current_location",
    claim_kind: "ordinary_fact",
    conflict_policy: "singleton_latest",
    authority: "advisory",
    confidence: 0.91,
    evidence_refs: ["conversation://2026-06-16/location"],
  });

  assert.equal(parsed.slot_key, "user:self.current_location");
});
```

Add negative tests:

- empty `subject_key` fails
- empty `predicate` fails
- `confidence > 1` fails
- `singleton_latest` requires `slot_key`
- `evidence_refs` must not exceed bounded max
- `authority: "trusted"` requires at least one evidence ref

**Step 2: Run tests and verify failure**

Run:

```bash
npx tsx --test scripts/ci/lite-claim-ledger-contract.test.ts
```

Expected: FAIL because `src/memory/claim-ledger-contract.ts` does not exist.

**Step 3: Implement minimal contract**

Create `src/memory/claim-ledger-contract.ts` with:

```ts
import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const AionisClaimConflictPolicySchema = z.enum([
  "singleton_latest",
  "multi_value",
  "accumulative_evidence",
  "manual_or_inspect",
]);

export const AionisClaimAuthoritySchema = z.enum([
  "evidence_only",
  "advisory",
  "trusted",
  "blocked",
]);

export const AionisClaimKindSchema = z.enum([
  "ordinary_fact",
  "preference",
  "project_fact",
  "execution_fact",
  "external_fact",
]);

export const AionisClaimWriteSchema = z.object({
  contract_version: z.literal("aionis_claim_write_v1"),
  client_id: nonEmptyString.optional(),
  subject_key: nonEmptyString,
  predicate: nonEmptyString,
  value: z.unknown(),
  value_text: z.string().trim().max(2_000).optional(),
  slot_key: nonEmptyString.optional(),
  claim_kind: AionisClaimKindSchema.default("ordinary_fact"),
  conflict_policy: AionisClaimConflictPolicySchema.default("manual_or_inspect"),
  authority: AionisClaimAuthoritySchema.default("advisory"),
  confidence: z.number().min(0).max(1).default(0.5),
  valid_from: z.string().datetime().optional(),
  evidence_refs: z.array(nonEmptyString).max(32).default([]),
  source_memory_id: nonEmptyString.optional(),
  metadata: z.record(z.unknown()).default({}),
}).superRefine((claim, ctx) => {
  if (claim.conflict_policy === "singleton_latest" && !claim.slot_key) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["slot_key"], message: "singleton_latest claims require slot_key" });
  }
  if (claim.authority === "trusted" && claim.evidence_refs.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence_refs"], message: "trusted claims require evidence_refs" });
  }
});

export type AionisClaimWrite = z.infer<typeof AionisClaimWriteSchema>;
```

**Step 4: Run tests**

Run:

```bash
npx tsx --test scripts/ci/lite-claim-ledger-contract.test.ts
npm run -s typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/memory/claim-ledger-contract.ts scripts/ci/lite-claim-ledger-contract.test.ts
git commit -m "feat: add claim ledger contracts"
```

### Task 1.2: Add Lite Claim Ledger Store

**Files:**
- Create: `src/store/claim-ledger-access.ts`
- Create: `src/store/lite-claim-ledger-store.ts`
- Create: `scripts/ci/lite-claim-ledger-store.test.ts`

**Step 1: Write failing store tests**

Add tests for:

- inserting first singleton claim creates one active live claim
- inserting second singleton claim on same slot sets old claim `valid_until` and `status=superseded`
- multi-value claims on same slot both remain active
- manual-or-inspect claims remain `contested`
- duplicate `client_id` is idempotent
- query by scope never leaks across scopes

Example:

```ts
test("singleton_latest supersedes the prior live claim in the same slot", async () => {
  const store = createLiteClaimLedgerStore(dbPath);
  const access = store.createClaimLedgerAccess();

  const oldClaim = await access.writeClaim({
    scope: "claim-ledger:test",
    tenantId: "public",
    claim: oldLocationClaim,
    now: "2026-06-16T01:00:00.000Z",
  });

  const currentClaim = await access.writeClaim({
    scope: "claim-ledger:test",
    tenantId: "public",
    claim: currentLocationClaim,
    now: "2026-06-16T02:00:00.000Z",
  });

  const live = await access.findLiveClaims({
    scope: "claim-ledger:test",
    subjectKey: "user:self",
    slotKey: "user:self.current_location",
    limit: 10,
  });

  assert.deepEqual(live.rows.map((row) => row.claim_id), [currentClaim.claim_id]);

  const old = await access.getClaim({ scope: "claim-ledger:test", claimId: oldClaim.claim_id });
  assert.equal(old?.status, "superseded");
  assert.equal(old?.valid_until, "2026-06-16T02:00:00.000Z");
});
```

**Step 2: Run tests and verify failure**

Run:

```bash
npx tsx --test scripts/ci/lite-claim-ledger-store.test.ts
```

Expected: FAIL because store files do not exist.

**Step 3: Implement access interface**

Create `src/store/claim-ledger-access.ts`:

```ts
import type { AionisClaimWrite } from "../memory/claim-ledger-contract.js";

export type ClaimLedgerStatus = "active" | "contested" | "superseded" | "retired" | "redacted";

export type ClaimLedgerRow = {
  claim_id: string;
  scope: string;
  tenant_id: string;
  client_id: string | null;
  subject_key: string;
  predicate: string;
  slot_key: string | null;
  value_json: string;
  value_text: string | null;
  claim_kind: string;
  conflict_policy: string;
  authority: string;
  confidence: number;
  status: ClaimLedgerStatus;
  valid_from: string;
  valid_until: string | null;
  source_memory_id: string | null;
  evidence_refs_json: string;
  supersedes_claim_ids_json: string;
  superseded_by_claim_id: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export type ClaimLedgerAccess = {
  writeClaim(args: { scope: string; tenantId: string; claim: AionisClaimWrite; now?: string }): Promise<ClaimLedgerRow>;
  findLiveClaims(args: { scope: string; subjectKey?: string; slotKey?: string; limit: number }): Promise<{ rows: ClaimLedgerRow[] }>;
  findSupersededClaims(args: { scope: string; slotKey: string; limit: number }): Promise<{ rows: ClaimLedgerRow[] }>;
  getClaim(args: { scope: string; claimId: string }): Promise<ClaimLedgerRow | null>;
  close(): Promise<void>;
};
```

**Step 4: Implement SQLite store**

Create `src/store/lite-claim-ledger-store.ts`.

Use `createSqliteDatabase(path)` and create tables:

```sql
CREATE TABLE IF NOT EXISTS lite_claim_ledger_claims (
  claim_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  client_id TEXT,
  subject_key TEXT NOT NULL,
  predicate TEXT NOT NULL,
  slot_key TEXT,
  value_json TEXT NOT NULL,
  value_text TEXT,
  claim_kind TEXT NOT NULL,
  conflict_policy TEXT NOT NULL,
  authority TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  source_memory_id TEXT,
  evidence_refs_json TEXT NOT NULL,
  supersedes_claim_ids_json TEXT NOT NULL,
  superseded_by_claim_id TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lite_claim_ledger_scope_client
  ON lite_claim_ledger_claims(scope, client_id)
  WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lite_claim_ledger_live_slot
  ON lite_claim_ledger_claims(scope, slot_key, status, valid_until, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lite_claim_ledger_subject
  ON lite_claim_ledger_claims(scope, subject_key, status, created_at DESC);

CREATE TABLE IF NOT EXISTS lite_claim_ledger_events (
  event_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Rules:

- `singleton_latest`: active new claim supersedes prior `active` or `contested` claims in same scope and slot.
- `multi_value`: new claim stays active; no supersession.
- `accumulative_evidence`: new claim stays active; no supersession.
- `manual_or_inspect`: new claim status is `contested` unless authority is `blocked`.
- `blocked`: status is `retired` or `contested`, never `active`.
- duplicate `(scope, client_id)` returns existing row and writes no new event.

**Step 5: Run store tests**

Run:

```bash
npx tsx --test scripts/ci/lite-claim-ledger-store.test.ts
npm run -s typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/store/claim-ledger-access.ts src/store/lite-claim-ledger-store.ts scripts/ci/lite-claim-ledger-store.test.ts
git commit -m "feat: add lite claim ledger store"
```

---

## Phase 2: Runtime Wiring And Observe Path

### Task 2.1: Wire Claim Ledger Into Runtime Services

**Files:**
- Modify: `src/app/runtime-services.ts`
- Modify: `src/server/http-server.ts` if route registration types require the store
- Modify: `src/routes/product-facade.ts`
- Test: `scripts/ci/lite-claim-ledger-product-route.test.ts`

**Step 1: Write failing wiring test**

In `scripts/ci/lite-claim-ledger-product-route.test.ts`, start the real Lite app using the same helpers as `lite-product-facade-route.test.ts`.

Assert:

- health still works when claim ledger store exists
- observe accepts `claims`
- guide does not crash after claim write

**Step 2: Run test and verify failure**

Run:

```bash
npx tsx --test scripts/ci/lite-claim-ledger-product-route.test.ts
```

Expected: FAIL because `claims` is not accepted or not persisted.

**Step 3: Add service field**

In `src/app/runtime-services.ts`, create a `liteClaimLedgerStore` using the same Lite database path as the write/recall store.

Expose:

```ts
claimLedgerStore,
claimLedgerAccess: claimLedgerStore.createClaimLedgerAccess(),
```

Close it in the same lifecycle as other stores.

**Step 4: Thread store into product facade args**

Add an optional `claimLedgerAccess` field to the product facade route args.

Keep it optional so tests and narrower route setups can omit it.

**Step 5: Run tests**

Run:

```bash
npx tsx --test scripts/ci/lite-claim-ledger-product-route.test.ts
npm run -s typecheck
```

Expected: health still passes; observe test still fails until Task 2.2.

**Step 6: Commit only if wiring compiles and existing route tests still pass**

```bash
git add src/app/runtime-services.ts src/routes/product-facade.ts scripts/ci/lite-claim-ledger-product-route.test.ts
git commit -m "feat: wire claim ledger runtime service"
```

### Task 2.2: Extend `/v1/observe` With Explicit Claims

**Files:**
- Modify: `src/routes/product-facade.ts`
- Modify: `src/memory/product-output-contract.ts` only if output contract needs a new receipt field
- Test: `scripts/ci/lite-claim-ledger-product-route.test.ts`

**Step 1: Add failing route tests**

Add tests:

```ts
test("product observe persists explicit claim ledger claims", async () => {
  const observe = await app.inject({
    method: "POST",
    url: "/v1/observe",
    payload: {
      scope,
      input_text: "User corrected current location to Shanghai.",
      claims: [{
        contract_version: "aionis_claim_write_v1",
        client_id: "claim-location-current",
        subject_key: "user:self",
        predicate: "current_location",
        value: { city: "Shanghai" },
        value_text: "User current location is Shanghai.",
        slot_key: "user:self.current_location",
        conflict_policy: "singleton_latest",
        claim_kind: "ordinary_fact",
        authority: "advisory",
        confidence: 0.9,
        evidence_refs: ["observe://claim-location-current"],
      }],
    },
  });

  assert.equal(observe.statusCode, 200);
  assert.equal(observe.json().claim_ledger?.written_count, 1);
});
```

Add rejection test:

- invalid claim returns 400 through standard error shape
- `trusted` claim without evidence refs fails

**Step 2: Run and verify failure**

Run:

```bash
npx tsx --test scripts/ci/lite-claim-ledger-product-route.test.ts
```

Expected: FAIL because observe ignores or rejects `claims`.

**Step 3: Add observe input parsing**

In `src/routes/product-facade.ts`, parse optional `claims` array with `AionisClaimWriteSchema.array().max(32)`.

When `/v1/observe` also writes a memory node, pass the resulting memory id as `source_memory_id` only when the caller did not provide one.

Response addition:

```ts
claim_ledger: {
  contract_version: "aionis_claim_observe_receipt_v1",
  written_count: number,
  claim_ids: string[],
  superseded_claim_ids: string[],
  contested_claim_ids: string[],
  agent_prompt_included: false,
  runtime_mutation: true
}
```

This is a write receipt, not an Agent prompt surface.

**Step 4: Preserve product boundary**

Do not auto-extract claims from arbitrary `input_text` yet.

Only write claims when:

- `claims` is provided explicitly
- or advanced memory nodes carry `slots.aionis_claim_write_v1` in a later task

**Step 5: Run tests**

Run:

```bash
npx tsx --test scripts/ci/lite-claim-ledger-product-route.test.ts
npm run -s typecheck
```

Expected: PASS for observe claim write tests.

**Step 6: Commit**

```bash
git add src/routes/product-facade.ts scripts/ci/lite-claim-ledger-product-route.test.ts
git commit -m "feat: write explicit claims from observe"
```

---

## Phase 3: Guide Projection

### Task 3.1: Build Claim Ledger Guide Projection

**Files:**
- Create: `src/memory/claim-ledger-projection.ts`
- Modify: `src/memory/product-output-contract.ts`
- Test: `scripts/ci/lite-claim-ledger-projection.test.ts`

**Step 1: Write failing projection tests**

Cover:

- active trusted/advisory live singleton claim becomes `use_now`
- contested claim becomes `inspect_before_use`
- superseded claim becomes `do_not_use`
- `evidence_only` claim remains audit-only
- projection includes evidence refs and claim ids
- projection has `agent_prompt_included` false for internal audit object

Example expected item:

```ts
{
  claim_id: "claim_current",
  slot_key: "user:self.current_location",
  surface: "use_now",
  reason_code: "claim_ledger_live_singleton",
  value_text: "User current location is Shanghai.",
  authority: "advisory",
}
```

**Step 2: Run and verify failure**

Run:

```bash
npx tsx --test scripts/ci/lite-claim-ledger-projection.test.ts
```

Expected: FAIL because projection module does not exist.

**Step 3: Implement projection builder**

Create a pure function:

```ts
export function buildClaimLedgerProjection(args: {
  liveClaims: ClaimLedgerRow[];
  supersededClaims: ClaimLedgerRow[];
  queryText?: string | null;
  limit: number;
}): AionisClaimLedgerProjection
```

Projection contract:

```ts
type AionisClaimLedgerProjection = {
  contract_version: "aionis_claim_ledger_projection_v1";
  use_now: AionisClaimLedgerProjectionItem[];
  inspect_before_use: AionisClaimLedgerProjectionItem[];
  do_not_use: AionisClaimLedgerProjectionItem[];
  audit_only: AionisClaimLedgerProjectionItem[];
  blocked_superseded_count: number;
  live_claim_count: number;
  contested_claim_count: number;
  agent_prompt_included: false;
  runtime_mutation: false;
};
```

Rules:

- `status=active` and `authority in advisory|trusted` -> `use_now`
- `status=contested` -> `inspect_before_use`
- `status=superseded` -> `do_not_use`
- `authority=evidence_only` -> `audit_only`
- `authority=blocked` -> `do_not_use`
- never include raw `value_json` in prompt text; use bounded `value_text`

**Step 4: Run projection tests**

Run:

```bash
npx tsx --test scripts/ci/lite-claim-ledger-projection.test.ts
npm run -s typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/memory/claim-ledger-projection.ts src/memory/product-output-contract.ts scripts/ci/lite-claim-ledger-projection.test.ts
git commit -m "feat: project claim ledger decisions"
```

### Task 3.2: Merge Claim Projection Into `/v1/guide`

**Files:**
- Modify: `src/routes/product-facade.ts`
- Modify: `src/memory/product-output-assembler.ts`
- Modify: `src/memory/product-output-contract.ts`
- Test: `scripts/ci/lite-claim-ledger-product-route.test.ts`
- Test: `scripts/ci/lite-product-output-assembler.test.ts`

**Step 1: Add failing product route test**

Scenario:

1. observe old location claim `Beijing`
2. observe current location claim `Shanghai` in same slot
3. call `/v1/guide` with `query_text: "Where is the user currently based?"`
4. assert `Shanghai` appears in `agent_context.use_now`
5. assert old `Beijing` claim does not appear as direct use
6. assert old claim is visible in `claim_ledger_projection.do_not_use` or audit surface

**Step 2: Run and verify failure**

Run:

```bash
npx tsx --test scripts/ci/lite-claim-ledger-product-route.test.ts
```

Expected: FAIL because guide does not read claim ledger.

**Step 3: Load claim ledger rows during guide**

In product facade guide handler:

- find live claims for the request scope
- if request query contains terms matching a slot or subject, include only those first
- for MVP, also include most recent live claims up to a small limit
- fetch superseded claims for included singleton slots

Bound limits:

```ts
const CLAIM_LEDGER_GUIDE_LIVE_LIMIT = 12;
const CLAIM_LEDGER_GUIDE_SUPERSEDED_LIMIT = 12;
```

**Step 4: Merge into agent context**

Append compact claim lines to existing buckets without replacing existing memory decisions.

Prompt text examples:

```text
CLAIM use_now claim_id=... slot=user:self.current_location value="User current location is Shanghai." evidence=...
CLAIM do_not_use claim_id=... slot=user:self.current_location reason=superseded_by_current_claim
```

Do not expose internal event history or raw JSON.

**Step 5: Attach audit projection**

Add to guide output:

```ts
claim_ledger_projection?: AionisClaimLedgerProjection
```

This field is host/operator-readable. It is not the canonical Agent prompt.

**Step 6: Run tests**

Run:

```bash
npx tsx --test scripts/ci/lite-claim-ledger-product-route.test.ts
npx tsx --test scripts/ci/lite-product-output-assembler.test.ts
npm run -s typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/routes/product-facade.ts src/memory/product-output-assembler.ts src/memory/product-output-contract.ts scripts/ci/lite-claim-ledger-product-route.test.ts scripts/ci/lite-product-output-assembler.test.ts
git commit -m "feat: include claim ledger in guide context"
```

---

## Phase 4: Measure, Snapshot, And Audit

### Task 4.1: Add Read-Only Claim Ledger Summary

**Files:**
- Modify: `src/memory/product-output-contract.ts`
- Modify: `src/memory/operator-snapshot.ts`
- Modify: `src/routes/product-facade.ts`
- Test: `scripts/ci/lite-operator-snapshot-route.test.ts`
- Test: `scripts/ci/lite-claim-ledger-product-route.test.ts`

**Step 1: Write failing snapshot test**

After writing claims, call `/v1/operator/snapshot`.

Assert:

```ts
assert.equal(snapshot.claim_ledger_summary.contract_version, "aionis_claim_ledger_summary_v1");
assert.equal(snapshot.claim_ledger_summary.runtime_mutation, false);
assert.equal(snapshot.claim_ledger_summary.agent_prompt_included, false);
assert.equal(snapshot.claim_ledger_summary.live_claim_count, 1);
assert.equal(snapshot.claim_ledger_summary.superseded_claim_count, 1);
```

**Step 2: Run and verify failure**

Run:

```bash
npx tsx --test scripts/ci/lite-operator-snapshot-route.test.ts
```

Expected: FAIL because snapshot has no claim ledger summary.

**Step 3: Implement summary**

Add:

```ts
type AionisClaimLedgerSummary = {
  contract_version: "aionis_claim_ledger_summary_v1";
  scope: string;
  live_claim_count: number;
  contested_claim_count: number;
  superseded_claim_count: number;
  evidence_only_claim_count: number;
  singleton_slots_count: number;
  agent_prompt_included: false;
  runtime_mutation: false;
  authority: "read_only";
};
```

Use bounded count queries in `ClaimLedgerAccess`.

**Step 4: Add summary to measure**

When `/v1/measure` receives product trace that includes before/after guide outputs, count:

- live claim present in after guide
- superseded claim blocked from direct use
- contested claim routed to inspect

Do not use measure to mutate claim authority.

**Step 5: Run tests**

Run:

```bash
npx tsx --test scripts/ci/lite-operator-snapshot-route.test.ts
npx tsx --test scripts/ci/lite-claim-ledger-product-route.test.ts
npm run -s typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/memory/product-output-contract.ts src/memory/operator-snapshot.ts src/routes/product-facade.ts scripts/ci/lite-operator-snapshot-route.test.ts scripts/ci/lite-claim-ledger-product-route.test.ts
git commit -m "feat: expose claim ledger audit summaries"
```

---

## Phase 5: SDK And MCP Integration

### Task 5.1: Add SDK Claim Types And Observe Helper

**Files:**
- Modify: `src/sdk.ts`
- Modify: `packages/aionis-sdk/src/index.ts`
- Modify: `packages/aionis-sdk/test/sdk.test.ts`
- Modify: `scripts/ci/lite-sdk-client.test.ts`

**Step 1: Add failing SDK tests**

Test:

```ts
const result = await client.observe({
  scope,
  input_text: "User corrected current location to Shanghai.",
  claims: [{
    contract_version: "aionis_claim_write_v1",
    subject_key: "user:self",
    predicate: "current_location",
    value: { city: "Shanghai" },
    slot_key: "user:self.current_location",
    conflict_policy: "singleton_latest",
    evidence_refs: ["sdk://test/location"],
  }],
});

assert.equal(result.claim_ledger?.written_count, 1);
```

**Step 2: Run and verify failure**

Run:

```bash
npm run -w @aionis/sdk -s test
npx tsx --test scripts/ci/lite-sdk-client.test.ts
```

Expected: FAIL because SDK types do not expose `claims`.

**Step 3: Update SDK types**

Add exported types:

- `AionisClaimWrite`
- `AionisClaimObserveReceipt`
- `AionisClaimLedgerProjection`
- `AionisClaimLedgerSummary`

Add `claims?: AionisClaimWrite[]` to observe request type.

Keep SDK mirror in sync manually or use the repo sync script after editing `src/sdk.ts`.

**Step 4: Run SDK sync and tests**

Run:

```bash
npm run -s sdk:source-sync
npm run -w @aionis/sdk -s test
npx tsx --test scripts/ci/lite-sdk-client.test.ts
npm run -s typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/sdk.ts packages/aionis-sdk/src/index.ts packages/aionis-sdk/test/sdk.test.ts scripts/ci/lite-sdk-client.test.ts
git commit -m "feat: expose claim ledger in sdk observe"
```

### Task 5.2: Add MCP Claim Support Without New Product Surface

**Files:**
- Modify: `packages/aionis-mcp/src/server.ts`
- Modify: `packages/aionis-mcp/src/tools.ts`
- Modify: `packages/aionis-mcp/test/mcp.test.ts`

**Step 1: Add failing MCP test**

Extend `aionis_remember` or `aionis_record_step` with optional `claims`.

Assert that the MCP tool forwards `claims` to SDK `observe`.

**Step 2: Run and verify failure**

Run:

```bash
npm run -w @aionis/mcp -s test
```

Expected: FAIL because MCP schemas do not allow claims.

**Step 3: Add optional claim input**

Add an optional `claims` schema to the relevant MCP tool.

Do not create a separate `aionis_claim_truth` tool in MVP. Claims are part of observing memory, not a standalone agent command.

**Step 4: Run MCP tests**

Run:

```bash
npm run -w @aionis/mcp -s test
npm run -s typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/aionis-mcp/src/server.ts packages/aionis-mcp/src/tools.ts packages/aionis-mcp/test/mcp.test.ts
git commit -m "feat: allow claim writes through mcp observe tools"
```

---

## Phase 6: End-To-End Product Proof

### Task 6.1: Add Claim Ledger Product Loop

**Files:**
- Create: `scripts/e2e/claim-ledger-product-loop.ts`
- Modify: `package.json`
- Create: `docs/examples/claim-ledger-product-loop-result.json`
- Test: `scripts/ci/lite-source-scope.test.mjs`

**Step 1: Write e2e script**

The script should:

1. start or connect to the real local Runtime pattern used by existing e2e scripts
2. observe old claim: user current location is Beijing
3. guide and confirm old claim can appear as current when no correction exists
4. observe current claim: user current location is Shanghai, same singleton slot
5. guide and confirm Shanghai enters actionable context
6. confirm Beijing is no longer direct use
7. measure before/after guide and confirm claim ledger effect summary exists
8. snapshot and confirm read-only summary exists
9. write `docs/examples/claim-ledger-product-loop-result.json`

Expected result shape:

```json
{
  "contract_version": "aionis_claim_ledger_product_loop_result_v1",
  "claim_ledger": {
    "current_claim_visible": true,
    "old_claim_blocked": true,
    "supersession_recorded": true,
    "claim_summary_read_only": true
  }
}
```

**Step 2: Add package script**

In `package.json`:

```json
"runtime:e2e:claim-ledger": "npx tsx scripts/e2e/claim-ledger-product-loop.ts"
```

**Step 3: Add source scope assertions**

In `scripts/ci/lite-source-scope.test.mjs`, assert:

- package script exists
- docs example exists
- README or quickstart matrix references the e2e after docs are added

**Step 4: Run e2e**

Run:

```bash
npm run -s runtime:e2e:claim-ledger
```

Expected: PASS and example JSON generated.

**Step 5: Run source scope test**

Run:

```bash
node --test scripts/ci/lite-source-scope.test.mjs
npm run -s typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add package.json scripts/e2e/claim-ledger-product-loop.ts docs/examples/claim-ledger-product-loop-result.json scripts/ci/lite-source-scope.test.mjs
git commit -m "test: add claim ledger product loop"
```

---

## Phase 7: Documentation

### Task 7.1: Add Claim Ledger Architecture Doc

**Files:**
- Create: `docs/AIONIS_CLAIM_LEDGER.md`
- Modify: `docs/AIONIS_PRODUCT_CONTRACT.md`
- Modify: `docs/AIONIS_STATE_MODEL.md`
- Modify: `docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md`
- Modify: `README.md`

**Step 1: Write the new doc**

Create `docs/AIONIS_CLAIM_LEDGER.md` with these sections:

- Product purpose
- Evidence / Claim / Cue distinction
- Conflict policies
- Write path
- Guide projection
- Relationship to Judgment Ledger
- Relationship to controlled forgetting
- Non-goals
- Privacy and deletion posture
- Product proof command

Use this exact positioning:

```text
Claim Ledger governs ordinary factual memory.
Judgment Ledger calibrates Aionis's past memory decisions.
Promotion Evidence Ledger governs workflow and pattern promotion.
```

**Step 2: Update product contract**

Add Claim Ledger under product capabilities:

```markdown
| Claim Ledger | Governs ordinary factual memory with evidence, validity, and supersession. | observe, guide, measure, snapshot |
```

Add boundary:

```text
Claim Ledger is not a replacement for execution memory. It should not turn every trace into a fact claim.
```

**Step 3: Update state model**

Add a state plane:

```markdown
| Claim validity | `active`, `contested`, `superseded`, `retired`, `redacted` | explicit claims, slot conflict policy, evidence refs, lifecycle action | claim ledger reducer | claim ledger store, guide projection, snapshot |
```

**Step 4: Update output contract**

Document:

- `AionisClaimObserveReceipt`
- `AionisClaimLedgerProjection`
- `AionisClaimLedgerSummary`

**Step 5: Update README**

Add a short product paragraph near Memory Firewall or Loop Engineering:

```markdown
### Claim Ledger

Aionis separates evidence from current factual claims. Similarity can find
candidate memory, but Claim Ledger decides which slot value is live,
superseded, contested, or evidence-only before the Agent sees compact context.
```

**Step 6: Run docs/source checks**

Run:

```bash
node --test scripts/ci/lite-source-scope.test.mjs
npm run -s typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add docs/AIONIS_CLAIM_LEDGER.md docs/AIONIS_PRODUCT_CONTRACT.md docs/AIONIS_STATE_MODEL.md docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md README.md
git commit -m "docs: document claim ledger architecture"
```

---

## Phase 8: Hardening And Edge Cases

### Task 8.1: Add Redaction And Controlled Delete Behavior

**Files:**
- Modify: `src/store/claim-ledger-access.ts`
- Modify: `src/store/lite-claim-ledger-store.ts`
- Modify: `src/routes/product-facade.ts` if `/v1/forget` should call redaction
- Test: `scripts/ci/lite-claim-ledger-store.test.ts`
- Test: `scripts/ci/lite-claim-ledger-product-route.test.ts`

**Step 1: Write failing redaction tests**

Test:

- redacted claim never appears in live claims
- redacted claim never enters guide buckets
- summary counts redacted separately
- redaction event is recorded

**Step 2: Implement `redactClaim`**

Add:

```ts
redactClaim(args: {
  scope: string;
  claimId: string;
  reasonCode: string;
  now?: string;
}): Promise<void>
```

Behavior:

- set `status="redacted"`
- set `value_json` to a redaction marker, not the original value
- clear `value_text`
- preserve minimal audit metadata
- append event

**Step 3: Wire controlled forgetting**

Only wire `/v1/forget` if there is already a matching memory id or claim id route path. Do not invent a broad delete API unless product contract is updated.

**Step 4: Run tests**

Run:

```bash
npx tsx --test scripts/ci/lite-claim-ledger-store.test.ts
npx tsx --test scripts/ci/lite-claim-ledger-product-route.test.ts
npm run -s typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/claim-ledger-access.ts src/store/lite-claim-ledger-store.ts src/routes/product-facade.ts scripts/ci/lite-claim-ledger-store.test.ts scripts/ci/lite-claim-ledger-product-route.test.ts
git commit -m "feat: support claim ledger redaction"
```

### Task 8.2: Bound Query Cost And Prompt Size

**Files:**
- Modify: `src/memory/claim-ledger-projection.ts`
- Modify: `src/store/lite-claim-ledger-store.ts`
- Test: `scripts/ci/lite-claim-ledger-projection.test.ts`
- Test: `scripts/ci/lite-claim-ledger-store.test.ts`

**Step 1: Add boundedness tests**

Test:

- guide projection caps live claims at configured limit
- `value_text` is truncated safely
- projection omits large `value_json`
- store requires positive bounded limit

**Step 2: Implement constants**

Add:

```ts
export const CLAIM_LEDGER_VALUE_TEXT_MAX_CHARS = 500;
export const CLAIM_LEDGER_GUIDE_MAX_ITEMS = 12;
export const CLAIM_LEDGER_AUDIT_MAX_ITEMS = 32;
```

**Step 3: Run tests**

Run:

```bash
npx tsx --test scripts/ci/lite-claim-ledger-projection.test.ts
npx tsx --test scripts/ci/lite-claim-ledger-store.test.ts
npm run -s typecheck
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/memory/claim-ledger-projection.ts src/store/lite-claim-ledger-store.ts scripts/ci/lite-claim-ledger-projection.test.ts scripts/ci/lite-claim-ledger-store.test.ts
git commit -m "fix: bound claim ledger projection cost"
```

---

## Phase 9: Full Verification

### Task 9.1: Run Focused Verification

**Files:**
- No source edits expected

**Step 1: Run package/source sync**

Run:

```bash
npm run -s sdk:source-sync
```

Expected: PASS.

**Step 2: Run full focused suite**

Run:

```bash
npm run -s test:focused
```

Expected: PASS.

**Step 3: Run product e2e commands**

Run:

```bash
npm run -s runtime:e2e:claim-ledger
npm run -s runtime:e2e:judgment-calibration
npm run -s runtime:e2e:golden-product-loop
```

Expected: PASS.

**Step 4: Inspect git diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: only Claim Ledger implementation, tests, docs, package script, and generated example artifact changed.

**Step 5: Commit verification artifact updates**

If example JSON files changed:

```bash
git add docs/examples
git commit -m "test: refresh claim ledger proof artifacts"
```

---

## Acceptance Criteria

Implementation is complete only when all are true:

- explicit `claims` can be written through `/v1/observe`
- singleton slot update deterministically supersedes the old live claim
- multi-value claims do not incorrectly supersede each other
- contested/manual claims route to `inspect_before_use`
- superseded claims are blocked from direct `use_now`
- guide exposes compact claim context without raw JSON bloat
- operator snapshot exposes read-only claim ledger summary
- measure can report claim-ledger-owned before/after effects without mutating claim authority
- SDK supports explicit claim writes
- MCP can forward claim writes through existing observe/remember tools
- claim ledger docs distinguish Claim Ledger, Judgment Ledger, and Promotion Evidence Ledger
- `npm run -s test:focused` passes

## Deferred Work

Do not implement these in the first pass:

- broad LLM extraction from arbitrary natural language
- learned slot discovery
- automatic claim promotion from weak feedback
- cloud/multi-tenant production auth changes
- vector ANN replacement
- external benchmark harnesses
- using claim ledger as a general knowledge graph

Future phases can add:

- optional LLM-assisted claim candidate extraction behind `inspect_before_use`
- slot registry and learned slot suggestions
- stronger redaction workflows
- claim-ledger ranking calibration using persistent Judgment Records
- import adapters for Mem0 or external memory systems


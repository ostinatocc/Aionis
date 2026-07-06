# Runtime Governance Remediation Plan

Status: remediation plan

Date: 2026-07-06

## Goal

Close the concrete governance and runtime reliability gaps found in the
focused Aionis Runtime without turning one external validation run into a new
core rule.

The plan addresses five implementation risks:

1. Admission gates currently trust missing upstream count fields as zero.
2. Execution outcome classification is duplicated and can disagree across
   execution tree and evidence context surfaces.
3. Product facade routes compose internal routes with `app.inject`, causing
   repeated route guards and direct internal error body passthrough.
4. Lite write commits synchronously wait for inline embedding, which can block
   write responses.
5. Authority boundary enforcement is CI-level and string-based rather than
   runtime-enforced or AST-verified.

## Scope

This plan covers Runtime source and CI tests in:

- `src/memory/admission-production-gate.ts`
- `src/memory/admission-tool-e2e-gate.ts`
- `src/execution/tree-auto.ts`
- `src/execution/evidence-context.ts`
- `src/routes/product-facade.ts`
- `src/routes/memory-write.ts`
- `src/memory/lite-projected-write-commit.ts`
- `src/embeddings/*`
- `scripts/ci/lite-admission-production-gate.test.ts`
- `scripts/ci/lite-admission-tool-e2e-gate.test.ts`
- `scripts/ci/lite-execution-tree.test.ts`
- `scripts/ci/lite-execution-evidence-context-route.test.ts`
- `scripts/ci/lite-product-facade-route.test.ts`
- `scripts/ci/lite-memory-write-workflow-projection-route.test.ts`
- `scripts/ci/lite-runtime-authority-gates.test.ts`

## Non-Goals

- Do not add a runtime source-code sandbox for authority capabilities.
- Do not introduce a persistent embedding outbox unless a later design review
  explicitly reopens that architecture.
- Do not change admission thresholds to match one dataset.
- Do not add external Agent framework concepts to Runtime architecture.
- Do not promote any single validation case into hard Runtime behavior.

## Current Findings

### Admission Gate Integrity

The production and tool E2E gates use permissive numeric parsing:

- `admission-production-gate.ts` maps non-number values to `0` through
  `numberValue`.
- `admission-tool-e2e-gate.ts` uses the same pattern.

This means missing safety counters such as `runtime_mutation_count` or
`wrong_branch_write_hits` can be interpreted as proven zero violations.

### Outcome Classification Drift

Outcome classification exists in at least two independent places:

- `tree-auto.ts`
- `evidence-context.ts`

They differ in vocabulary and precedence. One reads status text before boolean
fields; the other reads boolean fields before status text. The same node can be
classified differently when fields conflict.

### Facade Internal Dispatch

`product-facade.ts` forwards product requests to internal routes with
`app.inject`, copies auth headers, and returns failed internal bodies directly.

This preserves existing behavior but mixes product-level API contracts with
internal route contracts.

### Inline Embedding Latency

Lite write commit applies the write, then awaits inline embedding in the same
request path. The built-in HTTP provider has timeout and retry settings, but
the write path does not have its own commit-level deadline or async mode.

### Authority Boundary Verification

The Runtime already has CI tests that scan source strings against authority
boundary declarations. This is useful, but it is string-level verification and
not a runtime authority mechanism.

## Remediation Order

1. Admission gate input integrity.
2. Product facade error sanitization.
3. Shared execution outcome classifier.
4. Product facade service extraction.
5. Write embedding deadline and opt-in async mode.
6. Authority boundary CI precision upgrade.

Phases 1 through 3 should be treated as correctness and governance work.
Phases 4 through 6 are structural hardening.

## Phase 1: Admission Gate Input Integrity

### Objective

Fail closed when safety-critical upstream fields are missing, invalid, or
negative. Preserve optional metrics as optional, but make "not assessed" visible
and prevent default-active review from passing without required proof.

### Design

Add explicit field readers:

```ts
type RequiredNumberField = {
  ok: boolean;
  value: number;
  field: string;
  reason: string | null;
};

function requiredNonNegativeNumber(record: unknown, field: string): RequiredNumberField;
function optionalNonNegativeNumber(record: unknown, field: string): number | null;
```

Add an integrity section to both reports:

```ts
input_integrity: {
  missing_required_fields: string[];
  invalid_required_fields: string[];
  missing_optional_fields: string[];
  trusted_zero_count_fields: string[];
}
```

The gate decision must include integrity blockers before ordinary threshold
blockers.

### Production Gate Required Fields

Required safety fields in `admission-production-gate.ts`:

- `mode`
- `guide_count`
- `projection_present_count`
- `agent_prompt_included_count`
- `runtime_mutation_count`
- `hard_boundary_upgrade_count`

Optional report fields:

- `shadow_projection_source_count`
- `active_projection_source_count`

Decision behavior:

- Missing or invalid required fields add `missing_or_invalid_shadow_projection_field`.
- `no_prompt_inclusion`, `no_runtime_mutation`, and
  `no_hard_boundary_upgrade` pass only when the corresponding field exists and
  equals zero.
- Explicit zero safety counters are listed in `trusted_zero_count_fields`.

### Tool E2E Gate Required Fields

Required safety and quality fields in `admission-tool-e2e-gate.ts`:

- `runs`
- `wrong_branch_write_hits`
- `wrong_branch_action_hits`
- `wrong_branch_direction_attention_hits`
- `terminal_inspect_hits`
- `report_conflict_hits`
- `accepted_direction_hits`
- `accepted_direction_rate`
- `action_completion_hits`
- `action_completion_rate`

Optional counters:

- `wrong_branch_reference_attention_hits`
- `completion_tokens`

Context budget proof fields:

- `initial_context_chars`
- `prompt_tokens`
- matching full-history baseline fields

For default-active review, at least one context-budget ratio must be assessed:

- prefer `initial_context_ratio_vs_full_history`
- fall back to `prompt_ratio_vs_full_history`
- if neither is available, block with `context_budget_not_assessed`

### Consistency Checks

When `runs > 0`, require rate consistency:

- `accepted_direction_hits / runs` must match `accepted_direction_rate` within
  a small tolerance.
- `action_completion_hits / runs` must match `action_completion_rate` within a
  small tolerance.

If rates and hit counts disagree, block with:

- `accepted_route_rate_inconsistent`
- `action_completion_rate_inconsistent`

### Tests

Add tests that must fail before implementation:

- production gate blocks when `runtime_mutation_count` is missing.
- production gate blocks when `agent_prompt_included_count` is missing.
- production gate blocks when `hard_boundary_upgrade_count` is negative.
- production gate reports explicit zero fields in `trusted_zero_count_fields`.
- tool E2E gate blocks when `wrong_branch_write_hits` is missing.
- tool E2E gate blocks when `terminal_inspect_hits` is missing.
- tool E2E gate blocks when `runs` is missing.
- tool E2E gate blocks when context budget is not assessed.
- tool E2E gate blocks inconsistent hit/rate pairs.

### Exit Criteria

- A missing safety counter can no longer produce a pass.
- Reports distinguish explicit zero from missing fields.
- Default-active review cannot pass without route quality, action completion,
  and context-budget evidence.

## Phase 2: Product Facade Error Sanitization

### Objective

Stop leaking raw internal route error bodies through product facade endpoints
while preserving stable public error codes.

### Design

Replace direct passthrough in `sendInternalFailure` with a sanitizer:

```ts
function sanitizeInternalFailure(args: {
  route: string;
  result: InternalDispatchResult;
}): Record<string, unknown>;
```

Use a conservative allowlist:

```ts
const SAFE_INTERNAL_ERROR_CODES = new Set([
  "unauthorized",
  "tenant_forbidden",
  "scope_not_allowed",
  "rate_limited",
  "write_backpressure",
  "recall_backpressure",
  "invalid_request",
  "tenant_quota_exceeded",
  "not_found",
  "no_embedding_provider",
  "recall_text_embed_rate_limited",
  "embedding_provider_unavailable",
  "embedding_rate_limited",
]);
```

Allowed output shape:

```json
{
  "error": "safe_error_code",
  "message": "safe message",
  "details": {
    "contract": "error_v1",
    "surface": "/v1/memory/write",
    "retryable": false
  }
}
```

For unrecognized internal errors, return:

```json
{
  "error": "internal_error",
  "message": "internal route failed",
  "details": {
    "contract": "error_v1",
    "surface": "/v1/memory/write",
    "retryable": false
  }
}
```

Do not forward arbitrary `details`, stack traces, debug payloads, raw provider
bodies, or internal schema objects.

### Tests

Add product facade tests:

- known safe internal error keeps its public code.
- unknown internal error becomes `internal_error`.
- internal `details.debug_blob` does not appear in product response.
- response includes product-level surface and retryability only.

### Exit Criteria

- Product facade errors expose only allowlisted fields.
- Existing safe public errors remain compatible.
- Internal route debug bodies are not visible from `/v1/observe` or `/v1/guide`.

## Phase 3: Shared Execution Outcome Classifier

### Objective

Make execution outcome classification single-source, auditable, and conflict
aware.

### New Module

Create `src/execution/outcome-classifier.ts`.

Export:

```ts
export type ExecutionOutcomeClass = "passed" | "failed" | "unknown";

export type ExecutionOutcomeSource =
  | "boolean"
  | "status_text"
  | "summary_text"
  | "state_fallback"
  | "conflict";

export type ExecutionOutcomeClassification = {
  outcome: ExecutionOutcomeClass;
  source: ExecutionOutcomeSource;
  conflict: boolean;
  reasons: string[];
};
```

### Rules

1. Read boolean outcome signals.
2. Read status text signals.
3. Read summary text signals.
4. If signals agree, return the agreed outcome.
5. If signals conflict, return:

```ts
{
  outcome: "failed",
  source: "conflict",
  conflict: true,
  reasons: [...]
}
```

6. If no signal exists, return `unknown`.

Conflict must fail closed, but conflict metadata must remain visible so it is
not mistaken for ordinary high-quality counter-evidence.

### Tree Auto Integration

Update `tree-auto.ts`:

- direct conflicting classification returns failed and triggers revise.
- `unknown` preserves old "continue scanning evidence sources" behavior.
- maintain operations should include a diagnostic note for conflict cases.

### Evidence Context Integration

Update `evidence-context.ts`:

- use the shared classifier for memory evidence and raw evidence summaries.
- conflict blocks promotion.
- conflict entries are marked with `outcome_conflict: true`.
- conflict entries can be supporting/inspect evidence, not validated evidence.

### Tests

Add shared classifier tests:

- `status: "failed"` plus `passed: true` returns failed conflict.
- `failed: true` plus success text returns failed conflict.
- `passed: true` alone returns passed.
- failed status text alone returns failed.
- no outcome fields returns unknown.
- negated failure text does not become failed.

Update route tests:

- execution tree revises on conflict.
- evidence context blocks promotion on conflict.
- evidence context does not list conflict as validated evidence.

### Exit Criteria

- There is one classifier for execution outcome semantics.
- Conflict is visible in diagnostics.
- Conflict cannot produce stable promotion or direct reuse.

## Phase 4: Product Facade Service Extraction

### Objective

Remove product facade dependency on HTTP-level internal route dispatch for core
composition paths.

### Design

Extract service functions behind current route handlers:

- memory write service
- planning context service
- execution context assemble service
- handoff store service if still needed for observe composition

Route handlers should become:

```text
HTTP request
-> auth/rate/quota/inflight guard
-> parse request
-> service function
-> HTTP response envelope
```

Product facade should become:

```text
product request
-> product-level guard
-> call service functions directly
-> product response envelope
```

Service functions must accept already resolved request context:

```ts
type RuntimeServiceContext = {
  principal: AuthPrincipal | null;
  tenantId: string;
  scope: string;
  actor: string;
  requestId?: string | null;
};
```

Service functions must not call `requireMemoryPrincipal`, `enforceRateLimit`,
or `enforceTenantQuota` internally.

### Migration Steps

1. Extract memory write route body into `runMemoryWriteService`.
2. Keep `/v1/memory/write` behavior unchanged by calling the service.
3. Update `/v1/observe` to call the write service directly.
4. Extract planning context route body into `runPlanningContextService`.
5. Update `/v1/guide` to call planning context directly.
6. Extract execution context route body if full-power guide still needs it.
7. Remove internal dispatch for converted paths.
8. Keep `dispatchProductInternalRoute` only for any unconverted legacy path,
   then delete it when unused.

### Tests

Add or update tests:

- `/v1/observe` still writes memory and claims.
- `/v1/guide` still returns the same product contract.
- product request consumes expected product-level rate/quota only once per
  product surface.
- internal service errors are sanitized at product boundary.

### Exit Criteria

- `/v1/observe` and `/v1/guide` no longer depend on `app.inject` for their main
  paths.
- Route handlers and product facade share service code.
- Guard placement is explicit and not duplicated by internal HTTP dispatch.

## Phase 5: Write Embedding Deadline And Opt-In Async Mode

### Objective

Keep current inline embedding semantics by default while preventing write
requests from being blocked indefinitely by custom or slow embedding providers.

### Deadline Design

Add configuration:

```text
EMBED_WRITE_INLINE_TIMEOUT_MS=12000
```

Add optional embedding call options:

```ts
export type EmbeddingRequestOptions = {
  signal?: AbortSignal;
};

export type EmbeddingProvider = {
  name: string;
  dim: number;
  embed(texts: string[], options?: EmbeddingRequestOptions): Promise<number[][]>;
};
```

Thread `AbortSignal` through:

- `openai.ts`
- `minimax.ts`
- `http.ts`
- recall embedding helpers where compatible

For providers that ignore the signal, enforce a wrapper-level deadline with
`Promise.race`.

On deadline:

- mark pending node embeddings as failed with `inline_embedding_deadline_exceeded`
- return write response with embedding status failed
- do not roll back the already committed memory write

### Async Mode Design

Add request option:

```ts
embedding_mode?: "inline" | "async";
```

Default remains `inline`.

Async mode:

- marks planned embeddings as pending.
- enqueues work in an in-process queue.
- returns immediately with `embedding.mode: "async"` and queued count.
- does not introduce a persistent outbox.
- can be retried with `force_reembed`.

In-process queue constraints:

- bounded queue size
- bounded concurrency
- best-effort processing
- no prompt-facing effect until embedding is ready
- pending state is visible through inspect/debug surfaces

### Tests

Add tests:

- inline embedding deadline marks failures and still returns write success.
- custom never-resolving embedder does not hang write beyond deadline.
- async mode returns queued status without waiting for embedder.
- async queue eventually marks embeddings ready with deterministic embedder.
- default mode remains inline.

### Exit Criteria

- Slow embedding cannot indefinitely block write response.
- Existing inline semantics remain default.
- Async mode is explicit and observable.

## Phase 6: Authority Boundary CI Precision Upgrade

### Objective

Improve authority boundary verification precision without adding runtime source
enforcement.

### Design

Enhance `scripts/ci/lite-runtime-authority-gates.test.ts` rather than creating
a second checker initially.

Keep existing string checks, then add AST helpers using the TypeScript compiler
API already available in dev dependencies.

AST checks should detect:

- import aliases for authority gate helpers.
- direct calls to sensitive authority functions.
- indirect alias calls in the same file.
- object property reads for raw authority fields.
- stable workflow and stable pattern literal assignments.

Sensitive symbol examples:

- `buildRuntimeAuthorityGate`
- `authorityVisibilityFromValue`
- `authority_gate_v1`
- `execution_evidence_assessment`
- `promotion_state: "stable"`
- `pattern_state: "stable"`

Allowlist remains derived from `RUNTIME_AUTHORITY_BOUNDARY_REGISTRY`.

### Tests

Add fixture-like inline source snippets for AST helper behavior:

- import alias call is detected.
- direct call is detected.
- non-allowlisted file would fail.
- allowlisted file passes.

### Exit Criteria

- Existing CI contract remains in `lite:test`.
- Registry capabilities drive allowlists.
- AST checks reduce false negatives from aliases and indirect calls.

## Compatibility Notes

### Public API

- Admission reports gain new fields but keep existing fields.
- Existing booleans remain present, but become stricter.
- Product facade errors keep allowlisted public codes.
- Unrecognized internal errors become generic product errors.

### Operational Behavior

- Some previously passing admission reports will be blocked if they omit
  required fields.
- Tool E2E reports must include route and action quality evidence.
- Write calls with slow embedding providers will return faster, with embedding
  failures recorded instead of hanging indefinitely.

### Migration Path

For existing admission artifacts:

1. Re-run batch collection with the new required fields.
2. Re-run candidate policy evaluation.
3. Re-run production gate.
4. Re-run tool E2E gate.

Do not grandfather old reports into default-active review.

## Verification Plan

Run focused tests after each phase:

```bash
npm run -s typecheck
npx tsx --test scripts/ci/lite-admission-production-gate.test.ts
npx tsx --test scripts/ci/lite-admission-tool-e2e-gate.test.ts
npx tsx --test scripts/ci/lite-execution-tree.test.ts
npx tsx --test scripts/ci/lite-execution-evidence-context-route.test.ts
npx tsx --test scripts/ci/lite-product-facade-route.test.ts
npx tsx --test scripts/ci/lite-memory-write-workflow-projection-route.test.ts
npx tsx --test scripts/ci/lite-runtime-authority-gates.test.ts
```

Run before considering the remediation complete:

```bash
npm run -s test:focused
```

Docs-only check:

```bash
git diff --check
```

## Acceptance Checklist

- [ ] Admission gates fail closed on missing safety counters.
- [ ] Admission reports include input integrity diagnostics.
- [ ] Tool E2E gate requires assessable context-budget evidence.
- [ ] Outcome classification is implemented in one shared module.
- [ ] Outcome conflicts are fail-closed and visible.
- [ ] Product facade sanitizes internal errors.
- [ ] Main product facade paths no longer require `app.inject`.
- [ ] Inline embedding has a commit-level deadline.
- [ ] Async embedding mode is opt-in and in-process.
- [ ] Authority CI remains registry-driven and gains AST-level checks.
- [ ] `npm run -s test:focused` passes.

## Deferred Work

These items are intentionally outside the first remediation pass:

- Runtime-enforced authority capability sandbox.
- Persistent embedding outbox.
- New admission policies or threshold changes.
- New product claims based on the remediation.
- External validation host integration changes.


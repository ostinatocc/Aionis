# Managed Server Edition and Recall Engine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a hosted-ready Managed Server Edition while upgrading Aionis recall from bounded local scanning into a measured, hybrid Candidate Retrieval Engine without weakening the existing memory governance semantics.

**Architecture:** Split the work into two coordinated tracks. Managed Server Edition makes Aionis safely reachable by remote SDK and MCP clients with explicit auth, tenant/scope guards, request limits, and hosted-safe operational surfaces. Recall Engine improves candidate generation below the existing governance layer through evals, lexical/structured/execution-native sources, hybrid merge, source tracing, and later an optional ANN sidecar; recall proposes candidates, governance still decides `use_now`, `inspect_before_use`, `do_not_use`, and `rehydrate`.

**Tech Stack:** Node.js 22.5+, TypeScript, Fastify, SQLite `node:sqlite`, Zod, existing `@aionis/sdk`, `@aionis/mcp`, optional future ANN sidecar adapter, internal `node --test` / `tsx --test` tests, existing product e2e scripts.

---

## Non-Goals and Invariants

- Do not turn Aionis into a vector database wrapper.
- Do not let recall decide authority, lifecycle state, or prompt admission.
- Do not weaken existing Lite Runtime behavior, no-key first-value demo, MCP onboarding, or local developer flow.
- Do not add billing, dashboard, organization management, SSO, cloud orchestration, or hosted SaaS control plane in this plan.
- Do not make Server Edition pretend to be Cloud Edition. Server means a self-hostable or managed single service endpoint; Cloud means multi-tenant SaaS operations, billing, region isolation, admin UI, and fleet management.
- Preserve the core product contract:
  - `observe` records events and evidence.
  - `guide` compiles governed context.
  - `feedback` attributes outcomes.
  - `measure` quantifies impact.
  - `snapshot` and Flight Recorder explain what happened.
- Preserve the existing four action surface:
  - `use_now`
  - `inspect_before_use`
  - `do_not_use`
  - `rehydrate`
- Every new hosted or recall feature must have tests before implementation.
- Every milestone ends with a focused commit.

## Current Code Facts to Respect

- `src/config.ts` currently only allows `AIONIS_EDITION=lite`.
- `src/app/request-guards.ts` currently rejects any non-lite edition and any auth/quota mode outside the Lite boundary.
- `src/server/lite-runtime-boundary.ts` explicitly documents local Lite restrictions.
- `src/util/auth.ts` already supports API key and JWT resolution, but API-key parsing is `x-api-key` oriented while the SDK sends `Authorization: Bearer`.
- `src/store/recall-access.ts` exposes `RecallStoreAccess` with capability version 2.
- `src/store/lite-recall-store.ts` has `stage1CandidatesAnn`, but it is bounded SQLite fetch plus JavaScript JSON vector parsing and cosine ranking, not true ANN.
- `src/store/lite-write-store.ts` stores vectors in `embedding_vector_json TEXT`.
- `src/store/lite-write-store.ts` already has `lite_memory_execution_native_index`.
- `src/app/recall-observability.ts` exists but does not yet expose full recall-source tracing and retrieval quality metrics.
- `package.json` already has broad product e2e scripts and `test:focused`.

## Milestone Map

1. **Server Boundary Baseline**
   - Add explicit Server Edition configuration and docs.
   - Keep Lite behavior unchanged.

2. **Server Auth and Request Governance**
   - Add API key / bearer compatibility.
   - Bind principal to tenant/scope.
   - Add hosted-safe rate and inflight defaults.

3. **Remote SDK/MCP Server Profile**
   - Make SDK/MCP support remote Server Edition cleanly.
   - Add one real server e2e.

4. **Recall Engine Roadmap and Eval Harness**
   - Define Candidate Retrieval Engine contract and metrics.
   - Add a deterministic recall eval before changing retrieval.

5. **FTS, Structured, Execution-Native Hybrid Recall**
   - Add lexical and structured candidate sources first.
   - Add source tracing and hybrid merge under the existing governance layer.

6. **ANN Sidecar Behind a Flag**
   - Add adapter seam and optional local sidecar.
   - Do not make ANN required for Lite or Server MVP.

7. **Operational Readiness**
   - Add recall latency/source metrics.
   - Add server smoke, source-scope, docs, and packaging validation.

---

## Task 1: Add Server Edition Product Boundary Tests

**Files:**
- Modify: `scripts/ci/lite-config-posture.test.ts`
- Create: `scripts/ci/server-config-posture.test.ts`
- Read: `src/config.ts`
- Read: `src/app/request-guards.ts`
- Read: `src/server/lite-runtime-boundary.ts`

**Step 1: Write failing tests for Server Edition config**

Add `scripts/ci/server-config-posture.test.ts` with tests that assert:

- `AIONIS_EDITION=server` is valid.
- `AIONIS_MODE=service` is the expected server mode.
- `AIONIS_EDITION=server` cannot run with `MEMORY_AUTH_MODE=off` unless an explicit development override is present.
- Server Edition does not force `TENANT_QUOTA_ENABLED=false`.
- Lite defaults remain unchanged.

Skeleton:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseEnv } from "../../src/config.js";

test("server edition accepts service mode with api key auth", () => {
  const env = parseEnv({
    AIONIS_EDITION: "server",
    AIONIS_MODE: "service",
    MEMORY_AUTH_MODE: "api_key",
    MEMORY_API_KEYS_JSON: JSON.stringify([{ key: "dev-key", tenant_id: "tenant-a" }]),
  });
  assert.equal(env.AIONIS_EDITION, "server");
  assert.equal(env.AIONIS_MODE, "service");
  assert.equal(env.MEMORY_AUTH_MODE, "api_key");
});

test("server edition rejects auth off by default", () => {
  assert.throws(
    () => parseEnv({ AIONIS_EDITION: "server", AIONIS_MODE: "service", MEMORY_AUTH_MODE: "off" }),
    /server.*auth/i,
  );
});

test("lite edition keeps auth off default", () => {
  const env = parseEnv({});
  assert.equal(env.AIONIS_EDITION, "lite");
  assert.equal(env.MEMORY_AUTH_MODE, "off");
});
```

Adjust names to the actual config parser exports if needed.

**Step 2: Run the new test and verify it fails**

Run:

```bash
npx tsx --test scripts/ci/server-config-posture.test.ts
```

Expected:

- Fails because `EditionSchema` only accepts `lite`.

**Step 3: Do not implement yet**

Stop after the failing test. This creates the safety rail for Task 2.

**Step 4: Commit**

```bash
git add scripts/ci/server-config-posture.test.ts scripts/ci/lite-config-posture.test.ts
git commit -m "test: define server edition config posture"
```

---

## Task 2: Extend Config With `lite` and `server` Editions

**Files:**
- Modify: `src/config.ts`
- Modify: `scripts/ci/server-config-posture.test.ts`
- Modify: `scripts/ci/lite-config-posture.test.ts`
- Modify: `docs/AIONIS_INSTALL.md`
- Modify: `docs/AIONIS_HOST_INTEGRATION.md`
- Modify: `README.md`

**Step 1: Update `EditionSchema`**

Change:

```ts
const EditionSchema = z.literal("lite");
```

To:

```ts
const EditionSchema = z.enum(["lite", "server"]);
```

Do not add `cloud` yet. Keep `AIONIS_MODE` as `local | service | cloud` for compatibility, but document that `cloud` is reserved and unsupported by this Runtime package.

**Step 2: Add edition posture validation**

In the config parsing path, add a small helper:

```ts
function validateEditionPosture(env: Env): void {
  if (env.AIONIS_EDITION === "lite") {
    if (env.AIONIS_MODE !== "local") {
      throw new Error("Aionis Lite must run with AIONIS_MODE=local");
    }
    if (env.MEMORY_AUTH_MODE !== "off") {
      throw new Error("Aionis Lite requires MEMORY_AUTH_MODE=off");
    }
    if (env.TENANT_QUOTA_ENABLED) {
      throw new Error("Aionis Lite requires TENANT_QUOTA_ENABLED=false");
    }
    return;
  }

  if (env.AIONIS_EDITION === "server") {
    if (env.AIONIS_MODE !== "service") {
      throw new Error("Aionis Server requires AIONIS_MODE=service");
    }
    if (env.MEMORY_AUTH_MODE === "off" && !env.AIONIS_SERVER_ALLOW_AUTH_OFF_FOR_DEV) {
      throw new Error("Aionis Server requires MEMORY_AUTH_MODE=api_key, jwt, or api_key_or_jwt");
    }
  }
}
```

If `AIONIS_SERVER_ALLOW_AUTH_OFF_FOR_DEV` does not exist yet, add it as a boolean config defaulting to `false`.

**Step 3: Keep Lite default local**

Ensure default config remains:

```text
AIONIS_EDITION=lite
AIONIS_MODE=local
MEMORY_AUTH_MODE=off
TENANT_QUOTA_ENABLED=false
```

**Step 4: Add docs boundary**

Document:

- Lite: local developer runtime, no production auth, no tenant quota.
- Server: hosted endpoint for remote SDK/MCP clients, API key/JWT, request controls, tenant/scope guard.
- Cloud: future SaaS control plane, not implemented in this repo.

**Step 5: Run tests**

Run:

```bash
npx tsx --test scripts/ci/server-config-posture.test.ts
npx tsx --test scripts/ci/lite-config-posture.test.ts
npm run -s typecheck
```

Expected:

- New server config tests pass.
- Lite posture tests pass.
- Typecheck passes.

**Step 6: Commit**

```bash
git add src/config.ts scripts/ci/server-config-posture.test.ts scripts/ci/lite-config-posture.test.ts docs/AIONIS_INSTALL.md docs/AIONIS_HOST_INTEGRATION.md README.md
git commit -m "feat: add managed server edition config boundary"
```

---

## Task 3: Split Lite and Server Request Guards

**Files:**
- Modify: `src/app/request-guards.ts`
- Create: `scripts/ci/server-request-guards.test.ts`
- Modify: `scripts/ci/lite-source-scope.test.mjs` if it enforces Lite-only source assumptions too broadly

**Step 1: Write failing request guard tests**

Add tests for:

- Lite still rejects auth modes other than `off`.
- Server accepts `MEMORY_AUTH_MODE=api_key`.
- Server rejects unauthenticated protected requests.
- Server allows loopback development only when `AIONIS_SERVER_ALLOW_AUTH_OFF_FOR_DEV=true`.
- Server does not allow body tenant/scope to override authenticated principal.

Test shape:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createRequestGuards } from "../../src/app/request-guards.js";

test("server request guards accept api key mode", () => {
  const guards = createRequestGuards({
    env: makeServerEnv({ MEMORY_AUTH_MODE: "api_key" }),
    embedder: null,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: makeGate(),
    writeInflightGate: makeGate(),
  });
  assert.ok(guards);
});
```

Use local test helpers if they already exist; otherwise keep helper functions inside the test file.

**Step 2: Run the test and verify it fails**

Run:

```bash
npx tsx --test scripts/ci/server-request-guards.test.ts
```

Expected:

- Fails because `createRequestGuards` currently hard rejects non-lite.

**Step 3: Refactor request guard construction**

Change the early guard:

```ts
if (env.AIONIS_EDITION !== "lite") {
  throw new Error("aionis-lite request guards only support AIONIS_EDITION=lite");
}
```

Into edition-specific validation:

```ts
function assertLiteRequestGuardPosture(env: Env): void {
  if (env.MEMORY_AUTH_MODE !== "off") {
    throw new Error("aionis-lite request guards only support MEMORY_AUTH_MODE=off");
  }
  if (env.TENANT_QUOTA_ENABLED) {
    throw new Error("aionis-lite request guards only support TENANT_QUOTA_ENABLED=false");
  }
}

function assertServerRequestGuardPosture(env: Env): void {
  if (env.MEMORY_AUTH_MODE === "off" && !env.AIONIS_SERVER_ALLOW_AUTH_OFF_FOR_DEV) {
    throw new Error("aionis-server request guards require authentication");
  }
}
```

Then:

```ts
if (env.AIONIS_EDITION === "lite") {
  assertLiteRequestGuardPosture(env);
} else {
  assertServerRequestGuardPosture(env);
}
```

**Step 4: Keep all existing guard behavior for Lite**

Do not change:

- admin debug embeddings behavior
- rate limit behavior
- inflight behavior
- existing identity request kind names

**Step 5: Run tests**

Run:

```bash
npx tsx --test scripts/ci/server-request-guards.test.ts
npx tsx --test scripts/ci/lite-config-posture.test.ts
npm run -s lite:test
```

Expected:

- Server request guard tests pass.
- Existing Lite tests pass.

**Step 6: Commit**

```bash
git add src/app/request-guards.ts scripts/ci/server-request-guards.test.ts scripts/ci/lite-source-scope.test.mjs
git commit -m "feat: split lite and server request guards"
```

---

## Task 4: Make Auth Header Compatibility Explicit

**Files:**
- Modify: `src/util/auth.ts`
- Modify: `packages/aionis-sdk/src/index.ts`
- Modify: `src/sdk.ts`
- Modify: `scripts/ci/check-sdk-source-sync.mjs` only if needed
- Create: `scripts/ci/server-auth-header-compat.test.ts`
- Modify: `packages/aionis-sdk/test` files if SDK tests are organized under package-local test paths

**Step 1: Write failing auth tests**

Add tests that assert API key auth accepts both:

- `x-api-key: <key>`
- `Authorization: Bearer <key>`

This resolves the current mismatch where SDK sends bearer-style `apiKey`, while low-level auth expects `x-api-key`.

Test cases:

```ts
test("api key auth accepts x-api-key", async () => {
  const resolver = createAuthResolver(makeEnvWithApiKeys());
  const principal = await resolver.resolve({ headers: { "x-api-key": "dev-key" } } as any);
  assert.equal(principal.tenant_id, "tenant-a");
});

test("api key auth accepts bearer api key for SDK compatibility", async () => {
  const resolver = createAuthResolver(makeEnvWithApiKeys());
  const principal = await resolver.resolve({ headers: { authorization: "Bearer dev-key" } } as any);
  assert.equal(principal.tenant_id, "tenant-a");
});
```

**Step 2: Run and verify failure**

Run:

```bash
npx tsx --test scripts/ci/server-auth-header-compat.test.ts
```

Expected:

- Bearer API-key test fails.

**Step 3: Implement compatibility in `src/util/auth.ts`**

When `MEMORY_AUTH_MODE` includes `api_key`, resolve API key from:

1. `x-api-key`
2. `authorization: Bearer <token>`

Keep JWT validation distinct:

- If token parses as JWT and JWT mode is enabled, validate JWT.
- If API key mode is enabled, treat bearer token as API key candidate as a fallback.

**Step 4: Keep SDK unchanged unless tests prove otherwise**

Since the SDK already sends `Authorization: Bearer`, prefer server compatibility over changing SDK wire behavior. This avoids breaking existing users.

**Step 5: Ensure SDK source sync remains valid**

Run:

```bash
npm run -s sdk:source-sync
npm run -w @aionis/sdk -s test
```

**Step 6: Run tests**

Run:

```bash
npx tsx --test scripts/ci/server-auth-header-compat.test.ts
npm run -s test:focused
```

Expected:

- Auth header tests pass.
- SDK source sync passes.
- Focused suite passes.

**Step 7: Commit**

```bash
git add src/util/auth.ts packages/aionis-sdk/src/index.ts src/sdk.ts scripts/ci/server-auth-header-compat.test.ts
git commit -m "fix: accept bearer api keys for server auth"
```

---

## Task 5: Bind Principal, Tenant, and Scope for Server Requests

**Files:**
- Modify: `src/app/request-guards.ts`
- Modify: product route files that read `scope` directly if needed:
  - `src/routes/product-facade.ts`
  - `src/routes/memory-write.ts`
  - `src/routes/recall.ts` or equivalent recall route file
- Create: `scripts/ci/server-principal-scope-guard.test.ts`

**Step 1: Write tests for principal-bound scope**

Add cases:

- Principal with tenant `tenant-a` can write/read scope `tenant-a/project-1` or an explicitly allowed scope.
- Principal cannot pass body scope `tenant-b/project-1`.
- Principal cannot override `tenant_id` through request body slots.
- Error is structured as `error_v1`.

**Step 2: Define binding rule**

For Server MVP, use one simple rule:

```text
Server request principal controls tenant. Request scope must either:
1. equal principal.default_scope, or
2. start with `${principal.tenant_id}/`, or
3. be listed in principal.allowed_scopes.
```

If current `AuthPrincipal` lacks these fields, add:

```ts
type AuthPrincipal = {
  subject: string;
  tenant_id: string;
  allowed_scopes?: string[];
  default_scope?: string;
  auth_mode: "api_key" | "jwt" | "admin" | "dev";
};
```

Preserve existing names if they already differ.

**Step 3: Add request helper**

Add a helper in `src/app/request-guards.ts`:

```ts
function assertScopeAllowedForPrincipal(args: {
  principal: AuthPrincipal;
  scope: string;
}): void {
  const scope = args.scope.trim();
  if (!scope) throw new HttpError(400, "invalid_scope", "scope is required");
  if (args.principal.allowed_scopes?.includes(scope)) return;
  if (args.principal.default_scope === scope) return;
  if (scope === args.principal.tenant_id || scope.startsWith(`${args.principal.tenant_id}/`)) return;
  throw new HttpError(403, "scope_forbidden", "scope is not allowed for this principal");
}
```

**Step 4: Route integration**

Route handlers should use one guard-provided helper rather than manually trusting `body.scope`.

Desired route shape:

```ts
const principal = await guards.requirePrincipal(req, reply, "guide");
const scope = guards.resolveAuthorizedScope(req, principal, body.scope);
```

Do not implement broad route rewrites in one patch. Start with product facade endpoints:

- `/v1/observe`
- `/v1/guide`
- `/v1/feedback`
- `/v1/measure`
- `/v1/operator/snapshot`

**Step 5: Run tests**

Run:

```bash
npx tsx --test scripts/ci/server-principal-scope-guard.test.ts
npm run -s typecheck
npm run -s lite:test
```

Expected:

- Server principal/scope tests pass.
- Lite behavior unchanged.

**Step 6: Commit**

```bash
git add src/app/request-guards.ts src/routes/product-facade.ts scripts/ci/server-principal-scope-guard.test.ts
git commit -m "feat: bind server requests to authenticated scope"
```

---

## Task 6: Add Hosted-Safe Server Health and Readiness

**Files:**
- Modify: `src/server/http-server.ts`
- Modify: `src/server/bootstrap.ts`
- Create: `scripts/ci/server-health-readiness.test.ts`
- Modify: `docs/AIONIS_INSTALL.md`

**Step 1: Write tests for hosted health**

Required behavior:

- `GET /healthz` returns service alive, edition, mode, and version, but no local database path or secrets.
- `GET /readyz` verifies store initialization and returns `ready: true` only after storage is reachable.
- In Lite, existing health behavior remains compatible.

Expected response:

```json
{
  "ok": true,
  "edition": "server",
  "mode": "service",
  "storage_backend": "lite_sqlite",
  "auth_mode": "api_key"
}
```

Do not include:

- absolute database path
- API keys
- provider API keys
- raw environment

**Step 2: Run failing test**

Run:

```bash
npx tsx --test scripts/ci/server-health-readiness.test.ts
```

Expected:

- Fails until endpoints include server-safe shape.

**Step 3: Implement endpoints**

In `src/server/http-server.ts`, add or adjust endpoints:

```ts
app.get("/healthz", async () => ({
  ok: true,
  edition: env.AIONIS_EDITION,
  mode: env.AIONIS_MODE,
  storage_backend: "lite_sqlite",
  auth_mode: env.MEMORY_AUTH_MODE,
}));

app.get("/readyz", async () => {
  await services.store.ping?.();
  return { ok: true, ready: true };
});
```

If the store has no `ping`, add a narrow `ping()` to the store contract or use an existing read-only operation.

**Step 4: Document server health**

Add:

```bash
curl http://127.0.0.1:3001/healthz
curl http://127.0.0.1:3001/readyz
```

**Step 5: Run tests**

Run:

```bash
npx tsx --test scripts/ci/server-health-readiness.test.ts
npm run -s typecheck
```

**Step 6: Commit**

```bash
git add src/server/http-server.ts src/server/bootstrap.ts scripts/ci/server-health-readiness.test.ts docs/AIONIS_INSTALL.md
git commit -m "feat: add hosted-safe server health checks"
```

---

## Task 7: Add Server Rate, Inflight, and Quota Posture

**Files:**
- Modify: `src/config.ts`
- Modify: `src/app/request-guards.ts`
- Create: `scripts/ci/server-rate-limit-posture.test.ts`
- Modify: `docs/AIONIS_HOST_INTEGRATION.md`

**Step 1: Write tests**

Test that Server Edition defaults to:

```text
RATE_LIMIT_ENABLED=true
RATE_LIMIT_BYPASS_LOOPBACK=false
RECALL_INFLIGHT_MAX > 0
WRITE_INFLIGHT_MAX > 0
```

If `TENANT_QUOTA_ENABLED` remains off for first Server MVP, document it explicitly as a non-goal. If enabling it is already practical, add only a soft quota counter first.

**Step 2: Implement defaults**

Add edition-aware defaults:

```ts
if (edition === "server") {
  RATE_LIMIT_ENABLED default true
  RATE_LIMIT_BYPASS_LOOPBACK default false
  WRITE_RATE_LIMIT_MAX_WAIT_MS default 0
}
```

Do not change Lite defaults.

**Step 3: Run tests**

Run:

```bash
npx tsx --test scripts/ci/server-rate-limit-posture.test.ts
npm run -s lite:test
```

**Step 4: Commit**

```bash
git add src/config.ts src/app/request-guards.ts scripts/ci/server-rate-limit-posture.test.ts docs/AIONIS_HOST_INTEGRATION.md
git commit -m "feat: add server request control posture"
```

---

## Task 8: Add Remote Server SDK and MCP Smoke Tests

**Files:**
- Modify: `packages/aionis-sdk/src/index.ts`
- Modify: `src/sdk.ts`
- Modify: `packages/aionis-mcp/src/server.ts`
- Create: `scripts/e2e/managed-server-sdk-smoke.ts`
- Create: `scripts/e2e/managed-server-mcp-smoke.ts`
- Modify: `package.json`
- Modify: `docs/AIONIS_HOST_INTEGRATION.md`
- Modify: `docs/AIONIS_CLAUDE_CODE_MCP_DEMO_PACK.md`

**Step 1: Add package scripts**

Add:

```json
{
  "runtime:e2e:managed-server-sdk": "npx tsx scripts/e2e/managed-server-sdk-smoke.ts",
  "runtime:e2e:managed-server-mcp": "npm run -s packages:build && npx tsx scripts/e2e/managed-server-mcp-smoke.ts"
}
```

**Step 2: Write SDK smoke**

The smoke should:

1. Start runtime with:

```text
AIONIS_EDITION=server
AIONIS_MODE=service
MEMORY_AUTH_MODE=api_key
MEMORY_API_KEYS_JSON=[{"key":"dev-key","tenant_id":"dev","allowed_scopes":["dev/demo"]}]
```

2. Use `@aionis/sdk` with:

```ts
const client = new AionisClient({
  baseUrl: "http://127.0.0.1:<port>",
  apiKey: "dev-key",
  scope: "dev/demo",
});
```

3. Run:

- observe
- guide
- feedback
- measure
- operator snapshot

4. Assert:

- guide has governed context
- response includes trace/receipt ids
- no auth leaks in output

**Step 3: Write MCP smoke**

Start the MCP package against the local server with env:

```text
AIONIS_BASE_URL=http://127.0.0.1:<port>
AIONIS_API_KEY=dev-key
AIONIS_SCOPE=dev/demo
```

Assert that exposed MCP tools can:

- observe a note
- guide a continuation
- fetch a snapshot or receipt

**Step 4: Run tests**

Run:

```bash
npm run -s packages:build
npm run -s runtime:e2e:managed-server-sdk
npm run -s runtime:e2e:managed-server-mcp
npm run -s runtime:smoke:external-packages
```

**Step 5: Commit**

```bash
git add package.json packages/aionis-sdk/src/index.ts src/sdk.ts packages/aionis-mcp/src/server.ts scripts/e2e/managed-server-sdk-smoke.ts scripts/e2e/managed-server-mcp-smoke.ts docs/AIONIS_HOST_INTEGRATION.md docs/AIONIS_CLAUDE_CODE_MCP_DEMO_PACK.md
git commit -m "feat: add managed server sdk and mcp smoke"
```

---

## Task 9: Add Managed Server Installation Path

**Files:**
- Modify: `packages/create-aionis/src/index.ts`
- Modify: `packages/create-aionis/README.md`
- Modify: `packages/create-aionis/package.json`
- Modify: `docs/AIONIS_INSTALL.md`
- Modify: `README.md`
- Create: `scripts/ci/create-managed-server-install.test.ts`

**Step 1: Add installer test**

Test that `@aionis/create` can render:

```bash
npx @aionis/create --edition server --provider openai --scope dev/demo
```

Expected generated `.env` contains:

```text
AIONIS_EDITION=server
AIONIS_MODE=service
MEMORY_AUTH_MODE=api_key
MEMORY_API_KEYS_JSON=...
```

Also test default path remains first-value Lite:

```bash
npx @aionis/create
```

Expected:

```text
AIONIS_EDITION=lite
AIONIS_MODE=local
```

**Step 2: Implement installer flag**

Add:

```text
--edition lite|server
--auth api-key|jwt
--scope <scope>
```

Do not make Server default.

**Step 3: Update package version**

Bump `packages/create-aionis/package.json` patch version only after tests pass.

**Step 4: Run tests**

Run:

```bash
npx tsx --test scripts/ci/create-managed-server-install.test.ts
npm run -w @aionis/create -s test
npm run -s packages:build
```

**Step 5: Commit**

```bash
git add packages/create-aionis/src/index.ts packages/create-aionis/README.md packages/create-aionis/package.json docs/AIONIS_INSTALL.md README.md scripts/ci/create-managed-server-install.test.ts
git commit -m "feat: add managed server installer path"
```

---

## Task 10: Write Recall Engine Roadmap

**Files:**
- Create: `docs/AIONIS_RECALL_ENGINE_ROADMAP.md`
- Modify: `docs/AIONIS_RUNTIME_ARCHITECTURE.md`
- Modify: `docs/AIONIS_PRODUCT_CONTRACT.md`
- Modify: `README.md`

**Step 1: Create the roadmap**

The roadmap must state:

```text
Aionis Recall Engine is candidate generation, not memory authority.
Recall may increase or decrease a candidate score.
Recall may explain why a candidate was found.
Recall may not mark a memory use_now, inspect_before_use, do_not_use, or rehydrate.
Governance remains the admission layer above recall.
```

**Step 2: Define candidate sources**

Document source families:

- semantic
- lexical
- structured
- execution-native
- graph
- recent
- exact recovery
- future ANN sidecar

**Step 3: Define success metrics**

Document required metrics:

- `recall_at_50`
- `candidate_source_coverage`
- `use_now_precision_after_governance`
- `inspect_before_use_correctness`
- `do_not_use_stale_suppression`
- `failed_branch_blocking`
- `rehydrate_hit_rate`
- `p50_recall_latency_ms`
- `p95_recall_latency_ms`
- `index_rebuild_time_ms`
- `embedding_backfill_delay_ms`

**Step 4: Run docs/source tests**

Run:

```bash
npm run -s typecheck
npm run -s lite:test
```

**Step 5: Commit**

```bash
git add docs/AIONIS_RECALL_ENGINE_ROADMAP.md docs/AIONIS_RUNTIME_ARCHITECTURE.md docs/AIONIS_PRODUCT_CONTRACT.md README.md
git commit -m "docs: define recall engine roadmap"
```

---

## Task 11: Add Recall Eval Fixture and Metrics Before Retrieval Changes

**Files:**
- Create: `scripts/e2e/recall-engine-eval.ts`
- Create: `scripts/e2e/fixtures/recall-engine-cases.json`
- Create: `scripts/ci/recall-engine-eval.test.ts`
- Modify: `package.json`
- Create: `docs/examples/recall-engine-baseline-summary.json`

**Step 1: Define fixture format**

Create fixture cases:

```json
{
  "case_id": "failed_branch_same_file_001",
  "scope": "recall-eval/demo",
  "events": [
    {
      "id": "m_failed",
      "kind": "execution_memory",
      "text": "The legacy adapter route through fullBundleEnvironment.ts failed verification.",
      "expected_lifecycle": "failed_branch",
      "target_files": ["src/fullBundleEnvironment.ts"]
    },
    {
      "id": "m_current",
      "kind": "execution_memory",
      "text": "Continue the migration by creating bundledDev.ts with the accepted dev bundling route.",
      "expected_lifecycle": "current",
      "target_files": ["src/bundledDev.ts"]
    }
  ],
  "query": "Continue the dev bundling migration.",
  "expected": {
    "must_recall_ids": ["m_current", "m_failed"],
    "must_not_direct_use_ids": ["m_failed"],
    "preferred_direct_use_ids": ["m_current"],
    "required_sources": ["semantic", "structured"]
  }
}
```

Start with 20 cases:

- stale memory
- failed branch
- contested memory
- active target absent
- plan-as-memory asset
- ordinary preference memory
- multi-agent handoff
- procedure reuse
- rehydrate-needed payload
- low-salience old but exact file match

**Step 2: Write eval runner**

The runner should:

1. Start a temp runtime DB.
2. Observe fixture events.
3. Call `guide` or recall path.
4. Extract recalled candidate ids and final governed actions.
5. Emit:

```json
{
  "summary": {
    "case_count": 20,
    "recall_at_50": 0.0,
    "failed_branch_blocking": 0.0,
    "stale_suppression": 0.0,
    "p50_recall_latency_ms": 0,
    "p95_recall_latency_ms": 0
  },
  "cases": []
}
```

**Step 3: Add package script**

```json
"recall:eval": "npx tsx scripts/e2e/recall-engine-eval.ts"
```

**Step 4: Write CI test**

The CI test should verify:

- eval runner exits 0
- summary contains all required metrics
- baseline report is written

Do not require perfect metrics yet.

**Step 5: Run baseline**

Run:

```bash
npm run -s recall:eval
npx tsx --test scripts/ci/recall-engine-eval.test.ts
npm run -s typecheck
```

**Step 6: Commit**

```bash
git add package.json scripts/e2e/recall-engine-eval.ts scripts/e2e/fixtures/recall-engine-cases.json scripts/ci/recall-engine-eval.test.ts docs/examples/recall-engine-baseline-summary.json
git commit -m "test: add recall engine eval baseline"
```

---

## Task 12: Define `RecallStoreAccess` v3 Source Model

**Files:**
- Modify: `src/store/recall-access.ts`
- Modify: `src/store/lite-recall-store.ts`
- Modify: `scripts/ci/lite-recall-store-access.test.ts`
- Create: `scripts/ci/recall-source-trace-contract.test.ts`

**Step 1: Write source trace tests**

Test that every candidate can carry source evidence:

```ts
assert.deepEqual(candidate.sources[0], {
  kind: "semantic",
  score: assert.any(Number),
  reason: assert.any(String),
});
```

Minimum candidate source kinds:

```ts
export type RecallCandidateSourceKind =
  | "semantic"
  | "lexical"
  | "structured"
  | "execution_native"
  | "graph"
  | "recent"
  | "exact_recovery"
  | "ann";
```

**Step 2: Update types**

Add:

```ts
export const RECALL_STORE_ACCESS_CAPABILITY_VERSION = 3 as const;

export type RecallCandidateSource = {
  kind: RecallCandidateSourceKind;
  score: number;
  reason: string;
  matched_fields?: string[];
  index_name?: string;
};

export type RecallCandidate = {
  ...
  sources?: RecallCandidateSource[];
};
```

**Step 3: Keep v2 behavior compatible**

For existing `stage1CandidatesAnn`, populate:

```ts
sources: [{
  kind: "semantic",
  score: similarity,
  reason: "bounded_embedding_scan",
  index_name: "lite_embedding_json_scan"
}]
```

**Step 4: Add future v3 methods but keep default implementation simple**

Add interface methods:

```ts
stage1SemanticCandidates(params: RecallStage1Params): Promise<RecallCandidate[]>;
stage1LexicalCandidates(params: RecallLexicalParams): Promise<RecallCandidate[]>;
stage1StructuredCandidates(params: RecallStructuredParams): Promise<RecallCandidate[]>;
stage1ExecutionNativeCandidates(params: RecallExecutionNativeParams): Promise<RecallCandidate[]>;
stage1HybridCandidates(params: RecallHybridParams): Promise<RecallCandidate[]>;
```

For the first patch:

- `stage1SemanticCandidates` delegates to old `stage1CandidatesAnn`.
- `stage1HybridCandidates` delegates to semantic only.
- Other methods return `[]`.

This keeps behavior stable while establishing the contract.

**Step 5: Run tests**

Run:

```bash
npx tsx --test scripts/ci/recall-source-trace-contract.test.ts
npx tsx --test scripts/ci/lite-recall-store-access.test.ts
npm run -s typecheck
```

**Step 6: Commit**

```bash
git add src/store/recall-access.ts src/store/lite-recall-store.ts scripts/ci/lite-recall-store-access.test.ts scripts/ci/recall-source-trace-contract.test.ts
git commit -m "feat: add recall candidate source contract"
```

---

## Task 13: Add Lite FTS / Keyword Recall Source

**Files:**
- Modify: `src/store/lite-write-store.ts`
- Modify: `src/store/lite-recall-store.ts`
- Modify: `src/store/recall-access.ts`
- Create: `scripts/ci/lite-recall-lexical-source.test.ts`
- Modify: `docs/AIONIS_RECALL_ENGINE_ROADMAP.md`

**Step 1: Write failing lexical recall tests**

Test:

- A memory with no top semantic score but exact rare keyword match is recalled by lexical source.
- Candidate includes `sources.kind = "lexical"`.
- Governance still controls final action.

**Step 2: Add SQLite FTS table**

In store schema setup, add:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS lite_memory_fts USING fts5(
  node_id UNINDEXED,
  scope UNINDEXED,
  title,
  text_summary,
  embedding_text,
  slots_text
);
```

If `fts5` is not available in the bundled SQLite, fall back to a plain indexed table and `LIKE` matching. The tests should detect and skip FTS-specific ranking if unavailable, but still require lexical recall.

**Step 3: Maintain index on write**

On memory node insert/update, upsert:

```sql
INSERT INTO lite_memory_fts(node_id, scope, title, text_summary, embedding_text, slots_text)
VALUES (?, ?, ?, ?, ?, ?)
```

Flatten only safe searchable slot strings:

- task signature
- workflow signature
- error signature
- target files
- tool names
- procedure titles

Do not index raw secrets or full payloads.

**Step 4: Implement `stage1LexicalCandidates`**

Return candidates with:

```ts
sources: [{
  kind: "lexical",
  score,
  reason: "fts_keyword_match",
  matched_fields
}]
```

**Step 5: Run tests**

Run:

```bash
npx tsx --test scripts/ci/lite-recall-lexical-source.test.ts
npx tsx --test scripts/ci/lite-recall-store-access.test.ts
npm run -s recall:eval
npm run -s typecheck
```

Expected:

- Lexical source works.
- Baseline recall eval improves on low-salience exact keyword cases.

**Step 6: Commit**

```bash
git add src/store/lite-write-store.ts src/store/lite-recall-store.ts src/store/recall-access.ts scripts/ci/lite-recall-lexical-source.test.ts docs/AIONIS_RECALL_ENGINE_ROADMAP.md docs/examples/recall-engine-baseline-summary.json
git commit -m "feat: add lexical recall source"
```

---

## Task 14: Add Structured Signature Recall Source

**Files:**
- Modify: `src/store/lite-write-store.ts`
- Modify: `src/store/lite-recall-store.ts`
- Modify: `src/store/recall-access.ts`
- Create: `scripts/ci/lite-recall-structured-source.test.ts`
- Modify: `docs/AIONIS_RECALL_ENGINE_ROADMAP.md`

**Step 1: Write tests**

Structured recall should find candidates by:

- `task_signature`
- `workflow_signature`
- `error_signature`
- `pattern_signature`
- `task_family`
- `repo_signature`
- `file_cluster`
- `tool_chain_signature`
- `failure_mode`
- `verification_signature`
- `acceptance_check_signature`

Start by adding tests for the fields that already exist, then add new fields behind optional parsing.

**Step 2: Extend execution-native index carefully**

Add nullable columns if the current schema can support additive schema creation:

```sql
task_family TEXT
repo_signature TEXT
file_cluster TEXT
tool_chain_signature TEXT
failure_mode TEXT
verification_signature TEXT
acceptance_check_signature TEXT
```

If there is no migration system, add `ALTER TABLE ... ADD COLUMN` guarded by safe try/catch in schema initialization. Test idempotency.

**Step 3: Populate fields from slots**

Use slot keys only if present:

```ts
const taskFamily = stringSlot(slots, "task_family");
const repoSignature = stringSlot(slots, "repo_signature");
```

Do not invent signatures with LLM calls in this task.

**Step 4: Implement `stage1StructuredCandidates`**

Use exact and prefix matches:

- exact task/workflow/error signatures
- same repo + overlapping file cluster
- same failure mode + same verification signature

Return source trace:

```ts
{
  kind: "structured",
  score: 0.92,
  reason: "same_workflow_signature",
  matched_fields: ["workflow_signature"]
}
```

**Step 5: Run tests**

Run:

```bash
npx tsx --test scripts/ci/lite-recall-structured-source.test.ts
npx tsx --test scripts/ci/lite-execution-native-write-contract.test.ts
npm run -s recall:eval
npm run -s typecheck
```

**Step 6: Commit**

```bash
git add src/store/lite-write-store.ts src/store/lite-recall-store.ts src/store/recall-access.ts scripts/ci/lite-recall-structured-source.test.ts docs/AIONIS_RECALL_ENGINE_ROADMAP.md
git commit -m "feat: add structured recall source"
```

---

## Task 15: Add Hybrid Merge With RRF and Source Tracing

**Files:**
- Modify: `src/store/recall-access.ts`
- Modify: `src/store/lite-recall-store.ts`
- Modify: recall route / guide assembly code that calls `stage1CandidatesAnn`
- Create: `src/memory/recall-hybrid-merge.ts`
- Create: `scripts/ci/recall-hybrid-merge.test.ts`
- Modify: `scripts/ci/lite-recall-store-access.test.ts`

**Step 1: Write pure merge tests**

Add `src/memory/recall-hybrid-merge.ts` with no store dependency.

Test:

- Duplicate candidate ids merge sources.
- Candidate with semantic rank 4 and lexical rank 1 beats semantic-only rank 5.
- `do_not_use` is not decided here.
- RRF score is deterministic.

Suggested RRF:

```ts
export function reciprocalRankFusion(rank: number, k = 60): number {
  return 1 / (k + rank);
}
```

**Step 2: Implement merge**

Function:

```ts
export function mergeRecallCandidatesByRrf(args: {
  semantic: RecallCandidate[];
  lexical: RecallCandidate[];
  structured: RecallCandidate[];
  executionNative: RecallCandidate[];
  recent: RecallCandidate[];
  limit: number;
}): RecallCandidate[] {}
```

Output candidate should include:

```ts
similarity: normalizedHybridScore
sources: mergedSources
```

**Step 3: Wire `stage1HybridCandidates`**

Call:

- semantic
- lexical
- structured
- execution-native
- recent

Then merge.

Keep old `stage1CandidatesAnn` available as compatibility wrapper.

**Step 4: Update caller**

Where the recall path currently calls `stage1CandidatesAnn`, switch to `stage1HybridCandidates` only behind config:

```text
RECALL_ENGINE_MODE=semantic_scan|hybrid
```

Default:

- Lite: `semantic_scan` until eval proves stable.
- Server: `hybrid` after Task 16 if tests pass.

**Step 5: Run tests and eval**

Run:

```bash
npx tsx --test scripts/ci/recall-hybrid-merge.test.ts
npx tsx --test scripts/ci/lite-recall-store-access.test.ts
npm run -s recall:eval
npm run -s runtime:demo:first-value
npm run -s test:focused
```

**Step 6: Commit**

```bash
git add src/memory/recall-hybrid-merge.ts src/store/recall-access.ts src/store/lite-recall-store.ts scripts/ci/recall-hybrid-merge.test.ts scripts/ci/lite-recall-store-access.test.ts package.json
git commit -m "feat: add hybrid recall merge"
```

---

## Task 16: Surface Recall Sources in Receipt and Flight Recorder

**Status:** implemented.

Implementation note: this landed without changing admission logic or Agent
prompt rendering. `RecallCandidate.sources` now flows into
`AionisMemoryPacket.relevant_memories[].recall_sources`, decision trace,
Memory Use Receipt, Memory Admission Record, operator snapshots through their
embedded receipt/admission record, and Agent Flight Recorder replay fields.
`src/routes/product-facade.ts` did not need a direct change because the product
facade already carries the assembled packet/trace artifacts.

**Files:**
- Modify: `src/memory/product-output-contract.ts`
- Modify: `src/memory/product-output-assembler.ts`
- Modify: `src/memory/recall.ts`
- Modify: `src/memory/agent-flight-recorder.ts`
- Modify: `scripts/ci/recall-source-trace-contract.test.ts`
- Modify: docs:
  - `docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md`
  - `docs/AIONIS_AGENT_FLIGHT_RECORDER.md`
  - `docs/AIONIS_RECALL_ENGINE_ROADMAP.md`

**Step 1: Write tests**

For a guide response, assert:

```json
{
  "memory_use_receipt": {
    "used": [
      {
        "memory_id": "m_current",
        "admission_action": "use_now",
        "recall_sources": [
          { "kind": "structured", "reason": "same_workflow_signature" }
        ]
      }
    ]
  }
}
```

Also assert suppressed memories can include recall sources:

```json
{
  "admission_action": "do_not_use",
  "recall_sources": [
    { "kind": "lexical", "reason": "fts_keyword_match" }
  ],
  "suppression_reason": "failed_branch"
}
```

**Step 2: Extend output schema**

Add optional:

```ts
recall_sources?: Array<{
  kind: RecallCandidateSourceKind;
  score?: number;
  reason: string;
  matched_fields?: string[];
  index_name?: string;
}>;
```

**Step 3: Assemble source traces**

Product output assembler must pass candidate source traces through to receipt and operator snapshot.

Do not put source tracing into agent prompt by default. Keep it in receipt/snapshot unless explicitly requested.

**Step 4: Run tests**

Run:

```bash
npx tsx --test scripts/ci/recall-source-trace-contract.test.ts scripts/ci/lite-agent-flight-recorder.test.ts
npm run -s recall:eval
npm run -s typecheck
npm run -s lite:test
```

**Step 5: Commit**

```bash
git add src/memory/product-output-contract.ts src/memory/product-output-assembler.ts src/routes/product-facade.ts scripts/e2e/flight-recorder-incident-demo.ts scripts/ci/product-recall-source-trace.test.ts docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md docs/AIONIS_RECALL_ENGINE_ROADMAP.md
git commit -m "feat: surface recall sources in receipts"
```

---

## Task 17: Add Recall Latency and Source Metrics

**Files:**
- Modify: `src/app/recall-observability.ts`
- Modify: `src/routes/product-facade.ts`
- Modify: `scripts/e2e/recall-engine-eval.ts`
- Create: `scripts/ci/recall-observability-source-metrics.test.ts`
- Modify: `docs/AIONIS_RECALL_ENGINE_ROADMAP.md`

**Step 1: Write observability tests**

Assert metrics include:

```json
{
  "stage1_sources": {
    "semantic": { "count": 10, "elapsed_ms": 4 },
    "lexical": { "count": 3, "elapsed_ms": 2 },
    "structured": { "count": 5, "elapsed_ms": 1 }
  },
  "hybrid_merge": {
    "input_count": 18,
    "output_count": 10,
    "elapsed_ms": 1
  }
}
```

**Step 2: Add timing around each source**

Use `performance.now()` or existing timing helper.

**Step 3: Add eval report metrics**

Update recall eval summary with:

- per-source candidate coverage
- p50/p95 latency
- candidate overlap between sources

**Step 4: Run tests**

Run:

```bash
npx tsx --test scripts/ci/recall-observability-source-metrics.test.ts
npm run -s recall:eval
npm run -s typecheck
```

**Step 5: Commit**

```bash
git add src/app/recall-observability.ts src/routes/product-facade.ts scripts/e2e/recall-engine-eval.ts scripts/ci/recall-observability-source-metrics.test.ts docs/AIONIS_RECALL_ENGINE_ROADMAP.md docs/examples/recall-engine-baseline-summary.json
git commit -m "feat: add recall source observability"
```

---

## Task 18: Add Optional ANN Sidecar Interface

**Files:**
- Create: `src/store/ann/ann-index.ts`
- Create: `src/store/ann/noop-ann-index.ts`
- Create: `src/store/ann/local-ann-index.ts`
- Modify: `src/config.ts`
- Modify: `src/store/lite-recall-store.ts`
- Create: `scripts/ci/ann-index-contract.test.ts`
- Modify: `docs/AIONIS_RECALL_ENGINE_ROADMAP.md`

**Step 1: Write interface tests**

The ANN index contract:

```ts
export type AnnVectorRecord = {
  node_id: string;
  scope: string;
  tenant_id?: string | null;
  embedding_model: string;
  embedding_dim: number;
  vector_hash: string;
  tier: string;
  memory_lane: string;
  owner_agent_id?: string | null;
  owner_team_id?: string | null;
  lifecycle_state?: string | null;
  authority_state?: string | null;
  updated_at: string;
};

export interface AionisLocalAnnIndex {
  upsert(record: AnnVectorRecord, vector: number[]): Promise<void>;
  delete(nodeId: string): Promise<void>;
  search(params: {
    scope: string;
    embeddingModel: string;
    vector: number[];
    limit: number;
    filters?: Record<string, unknown>;
  }): Promise<Array<{ node_id: string; score: number }>>;
  rebuild(records: AsyncIterable<{ record: AnnVectorRecord; vector: number[] }>): Promise<void>;
}
```

Tests should verify:

- noop index returns no candidates.
- local in-memory implementation returns nearest vector.
- wrong embedding dimension is rejected.

**Step 2: Add config**

Add:

```text
RECALL_ANN_PROVIDER=off|local
RECALL_ANN_REBUILD_ON_START=false
RECALL_ANN_MAX_CANDIDATES=200
```

Default must be `off`.

**Step 3: Add local in-memory placeholder**

First implementation can be an in-memory exact vector index, not USearch yet. This tests the contract without adding dependency risk.

**Step 4: Wire source trace**

When `RECALL_ANN_PROVIDER=local`, semantic source can use ANN results before falling back to bounded scan.

Source trace:

```json
{
  "kind": "ann",
  "reason": "local_ann_index",
  "index_name": "aionis_local_ann"
}
```

**Step 5: Run tests**

Run:

```bash
npx tsx --test scripts/ci/ann-index-contract.test.ts
npm run -s recall:eval
npm run -s test:focused
```

**Step 6: Commit**

```bash
git add src/store/ann/ann-index.ts src/store/ann/noop-ann-index.ts src/store/ann/local-ann-index.ts src/config.ts src/store/lite-recall-store.ts scripts/ci/ann-index-contract.test.ts docs/AIONIS_RECALL_ENGINE_ROADMAP.md
git commit -m "feat: add optional ann index contract"
```

---

## Task 19: Evaluate USearch, sqlite-vec, and LanceDB Without Committing a Dependency

**Files:**
- Create: `docs/research/2026-06-16-ann-backend-evaluation.md`
- Create: `scripts/research/ann-backend-probe.mjs`
- Modify: `docs/AIONIS_RECALL_ENGINE_ROADMAP.md`

**Step 1: Create evaluation doc**

Evaluate:

- USearch for local sidecar ANN
- sqlite-vec for SQLite-native vector tables
- LanceDB for heavier vector/full-text/hybrid store

Required criteria:

- Node.js compatibility
- native build reliability
- local install size
- filter support
- persistence model
- rebuild speed
- deletion/update support
- production maturity
- license
- operational complexity

**Step 2: Add probe script**

The script should not be part of normal CI. It can be manually run after installing candidate packages.

Pseudo-shape:

```bash
node scripts/research/ann-backend-probe.mjs --provider usearch --vectors 10000 --dim 1536
```

**Step 3: Document decision gate**

Do not add a real dependency unless:

- recall eval shows bounded scan is a bottleneck, and
- source tracing proves candidate loss from scan cap, and
- install/build risk is acceptable.

**Step 4: Run docs checks**

Run:

```bash
npm run -s typecheck
```

**Step 5: Commit**

```bash
git add docs/research/2026-06-16-ann-backend-evaluation.md scripts/research/ann-backend-probe.mjs docs/AIONIS_RECALL_ENGINE_ROADMAP.md
git commit -m "docs: evaluate ann backend options"
```

---

## Task 20: Add Managed Server + Hybrid Recall End-to-End Test

**Files:**
- Create: `scripts/e2e/managed-server-hybrid-recall-loop.ts`
- Modify: `package.json`
- Modify: `docs/examples/managed-server-hybrid-recall-result.json`
- Modify: `docs/AIONIS_HOST_INTEGRATION.md`

**Step 1: Add package script**

```json
"runtime:e2e:managed-server-hybrid-recall": "npx tsx scripts/e2e/managed-server-hybrid-recall-loop.ts"
```

**Step 2: Build e2e scenario**

Scenario:

- Start Server Edition with API key auth.
- Observe a long execution history:
  - failed branch with same file names
  - accepted current route
  - buried lexical-only clue
  - structured workflow signature
  - stale memory
- Call `guide` from remote SDK client.
- Assert:
  - accepted route appears in `use_now`
  - failed/stale branch does not appear in direct use
  - recall sources include at least two source families
  - memory use receipt includes admission reasons
  - operator snapshot includes trace

**Step 3: Run e2e**

Run:

```bash
npm run -s runtime:e2e:managed-server-hybrid-recall
```

Expected:

- Exit 0.
- Writes `docs/examples/managed-server-hybrid-recall-result.json`.

**Step 4: Run full focused test**

Run:

```bash
npm run -s test:focused
npm run -s runtime:demo:first-value
npm run -s runtime:smoke:external-packages
```

**Step 5: Commit**

```bash
git add package.json scripts/e2e/managed-server-hybrid-recall-loop.ts docs/examples/managed-server-hybrid-recall-result.json docs/AIONIS_HOST_INTEGRATION.md
git commit -m "test: add managed server hybrid recall e2e"
```

---

## Task 21: Update Public Product Positioning

**Files:**
- Modify: `README.md`
- Modify: `docs-site` content if present in this repo
- Modify: `docs/AIONIS_PRODUCT_CONTRACT.md`
- Modify: `docs/AIONIS_QUICKSTART_MATRIX.md`
- Modify: `docs/AIONIS_HOST_INTEGRATION.md`

**Step 1: Update product language**

Use this hierarchy:

1. **MCP for Claude Code and Cursor**
   - Try Aionis without rewriting the host loop.
2. **Execution Memory**
   - Plans, decisions, failures, acceptance checks, workflow state.
3. **Memory Firewall**
   - Govern Mem0, Zep, Supermemory, Pinecone, pgvector, Chroma, Weaviate, LangGraph Store, markdown stores, and custom recall.
4. **Agent Flight Recorder**
   - Replay what the agent saw, used, and ignored.
5. **Managed Server Edition**
   - Run Aionis as a shared endpoint for remote SDK/MCP clients.
6. **Recall Engine**
   - Strong retrieval below strict governance.

**Step 2: Avoid weakening Aionis storage story**

Phrase Memory Firewall as:

```text
Already have memory? Keep it. Aionis can govern candidates from external stores.
Starting fresh? Use Aionis Runtime as both the execution memory store and the governance runtime.
```

**Step 3: Add Server and Recall badges or short sections**

Avoid claiming Cloud/SaaS readiness until implemented.

**Step 4: Run docs and tests**

Run:

```bash
npm run -s typecheck
npm run -s runtime:demo:first-value
```

**Step 5: Commit**

```bash
git add README.md docs/AIONIS_PRODUCT_CONTRACT.md docs/AIONIS_QUICKSTART_MATRIX.md docs/AIONIS_HOST_INTEGRATION.md
git commit -m "docs: position server and recall engine"
```

---

## Task 22: Final Release Validation

**Files:**
- Modify only if validation exposes drift.

**Step 1: Run full test suite**

Run:

```bash
npm run -s test:focused
npm run -s runtime:demo:first-value
npm run -s runtime:quickstart:claude-code-mcp
npm run -s runtime:e2e:managed-server-sdk
npm run -s runtime:e2e:managed-server-mcp
npm run -s runtime:e2e:managed-server-hybrid-recall
npm run -s recall:eval
npm run -s runtime:smoke:external-packages
```

Expected:

- All pass.
- Generated docs examples are deterministic or explicitly timestamp-normalized.

**Step 2: Verify git diff**

Run:

```bash
git status --short
git diff --check
```

Expected:

- Only intended files changed.
- No whitespace errors.

**Step 3: Verify public package build**

Run:

```bash
npm run -s packages:build
npm run -w @aionis/sdk -s test
npm run -w @aionis/mcp -s test
npm run -w @aionis/create -s test
```

Expected:

- Packages build and test.

**Step 4: Version packages only after product API changes settle**

If SDK/MCP/Create package contents changed, bump patch versions:

- `packages/aionis-sdk/package.json`
- `packages/aionis-mcp/package.json`
- `packages/create-aionis/package.json`

Do not publish until the user confirms.

**Step 5: Final commit**

```bash
git add .
git commit -m "chore: validate managed server and recall engine baseline"
```

---

## Recommended Execution Order

Execute in this order:

1. Task 1
2. Task 2
3. Task 3
4. Task 4
5. Task 5
6. Task 6
7. Task 7
8. Task 8
9. Task 10
10. Task 11
11. Task 12
12. Task 13
13. Task 14
14. Task 15
15. Task 16
16. Task 17
17. Task 20
18. Task 21
19. Task 22

Defer Task 9 until Server behavior is stable enough to expose through `@aionis/create`.

Defer Task 18 and Task 19 until recall eval proves lexical + structured + hybrid is insufficient or too slow.

## First Implementation Slice

The first slice should be:

```text
Task 1: Server config tests
Task 2: Server config boundary
Task 3: Server request guard split
Task 4: Auth header compatibility
```

Why:

- It creates a real Server Edition boundary.
- It avoids touching recall complexity too early.
- It fixes a known future SDK/server auth mismatch.
- It keeps Lite behavior protected by tests.

## Definition of Done

Managed Server Edition is considered minimally done when:

- `AIONIS_EDITION=server` is valid.
- Server requires auth by default.
- SDK bearer API keys work.
- Principal/scope binding prevents tenant override.
- Remote SDK smoke passes.
- Remote MCP smoke passes.
- Hosted health/readiness surfaces do not leak local secrets.
- Lite quickstart and no-key first-value demo still pass.

Recall Engine Phase 1 is considered done when:

- Recall eval exists and records baseline.
- Candidate source traces exist.
- Lexical recall works.
- Structured recall works.
- Hybrid merge works.
- Flight Recorder / receipt can show why a candidate was found.
- Governance still owns admission decisions.
- First-value demo and product e2e do not regress.

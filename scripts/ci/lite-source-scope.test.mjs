import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const EMBEDDED_RUNTIME_SYMBOL = "embedded" + "Runtime";
const CREATE_EMBEDDED_RUNTIME_SYMBOL = "create" + "Embedded" + "MemoryRuntime";

const FORBIDDEN_PATHS = [
  "src/.DS_Store",
  "src/bench/many-tools.ts",
  "src/dev/contract-smoke.ts",
  "src/eval/score.ts",
  "src/sdk/index.ts",
  "src/control-plane.ts",
  "src/db.ts",
  "src/app/runtime-telemetry.ts",
  "src/jobs/topicClusterLib.ts",
  "src/util/pgvector.ts",
  "src/memory/automation.ts",
  "src/memory/automation-lite.ts",
  "src/routes/automations.ts",
  "src/store/lite-automation-store.ts",
  "src/store/lite-automation-run-store.ts",
  "src/routes/admin-control-alerts.ts",
  "src/routes/admin-control-config.ts",
  "src/routes/admin-control-dashboard.ts",
  "src/routes/admin-control-entities.ts",
  "src/routes/memory-lifecycle.ts",
  "src/memory/nodes-activate.ts",
  "src/memory/rehydrate.ts",
  "src/util/error-format.ts",
];

const ALLOWED_JOB_FILES = [
  "associative-linking-lib.ts",
];

function listSourceFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

test("lite repo excludes bench/dev/eval/sdk source entrypoints", () => {
  for (const rel of FORBIDDEN_PATHS) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false, `${rel} should be absent in lite repo`);
  }
});

test("focused lite source never constructs placeholder postgres clients", () => {
  for (const file of listSourceFiles(path.join(ROOT, "src"))) {
    const source = fs.readFileSync(file, "utf8");
    assert.equal(source.includes("{} as pg.PoolClient"), false, `${path.relative(ROOT, file)} should not use a placeholder pg client`);
    assert.equal(source.includes("client ?? ({} as pg.PoolClient)"), false, `${path.relative(ROOT, file)} should not derive a placeholder pg client`);
  }
});

test("lite repo keeps only kernel-linked job helpers", () => {
  const jobsDir = path.join(ROOT, "src/jobs");
  const jobFiles = fs.readdirSync(jobsDir)
    .filter((name) => fs.statSync(path.join(jobsDir, name)).isFile())
    .sort();
  assert.deepEqual(jobFiles, ALLOWED_JOB_FILES);
  assert.equal(fs.existsSync(path.join(jobsDir, "fixtures")), false, "src/jobs/fixtures should be absent in lite repo");
});

test("focused repo does not keep app, package, or example wrapper surfaces", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "apps")), false, "apps wrapper surface should be absent");
  assert.equal(fs.existsSync(path.join(ROOT, "packages")), false, "package wrapper surface should be absent");
  assert.equal(fs.existsSync(path.join(ROOT, "examples")), false, "example wrapper surface should be absent");
});

test("focused package does not expose external eval or demo runner entrypoints", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const scriptNames = Object.keys(packageJson.scripts ?? {}).sort();
  for (const scriptName of scriptNames) {
    assert.equal(scriptName.startsWith("demo" + ":"), false, `${scriptName} should not be a focused package script`);
    assert.equal(scriptName.startsWith("eval" + ":"), false, `${scriptName} should not be a focused package script`);
  }

  const forbiddenScriptDirs = [
    ["scripts", "github" + "-repo-eval"],
    ["scripts", "product" + "-demo"],
    ["scripts", "effect" + "-measurement"],
    ["scripts", "agent" + "-host-eval"],
    ["scripts", "ai" + "der" + "-eval"],
    ["scripts", "swe" + "-agent-eval"],
    ["scripts", "real" + "-llm-eval"],
  ];
  for (const relParts of forbiddenScriptDirs) {
    const rel = relParts.join("/");
    assert.equal(fs.existsSync(path.join(ROOT, ...relParts)), false, `${rel} should not exist in focused Runtime`);
  }
});

test("lite repo does not keep fixture-only real validation artifacts", () => {
  assert.equal(
    fs.existsSync(path.join(ROOT, "scripts", "fixtures", "real-ab-validation")),
    false,
    "real validation must run live LLM agents, not fixture-only trace or metric files",
  );
});

test("lite server does not statically import server-only routes", () => {
  const serverFile = fs.readFileSync(path.join(ROOT, "src/server/http-server.ts"), "utf8");
  const forbiddenImports = [
    "../routes/admin-control-alerts.js",
    "../routes/admin-control-config.js",
    "../routes/admin-control-dashboard.js",
    "../routes/admin-control-entities.js",
  ];
  for (const specifier of forbiddenImports) {
    assert.equal(serverFile.includes(specifier), false, `${specifier} should not be imported by lite http-server`);
  }
  assert.equal(serverFile.includes("../routes/automations.js"), false, "focused lite http-server should not import automation routes");
  assert.match(serverFile, /assertLiteOnlySourceTree/);
});

test("focused runtime entry layers do not expose postgres client types", () => {
  const files = [
    path.join(ROOT, "src", "app", "runtime-services.ts"),
    path.join(ROOT, "src", "app", "replay-runtime-options.ts"),
    path.join(ROOT, "src", "app", "sandbox-budget.ts"),
    path.join(ROOT, "src", "server", "bootstrap.ts"),
    path.join(ROOT, "src", "server", "http-server.ts"),
    path.join(ROOT, "src", "routes", "handoff.ts"),
    path.join(ROOT, "src", "routes", "memory-context-runtime.ts"),
    path.join(ROOT, "src", "routes", "memory-replay-core.ts"),
    path.join(ROOT, "src", "store", "memory-store.ts"),
    path.join(ROOT, "src", "memory", "replay.ts"),
    path.join(ROOT, "src", "memory", "replay-write.ts"),
    path.join(ROOT, "src", "memory", "replay-learning.ts"),
    path.join(ROOT, "src", "memory", "sandbox.ts"),
    path.join(ROOT, "src", "memory", "sandbox-executor.ts"),
    path.join(ROOT, "src", "memory", "sandbox-shared.ts"),
    path.join(ROOT, "src", "memory", "rules.ts"),
    path.join(ROOT, "src", "memory", "write.ts"),
    path.join(ROOT, "src", "memory", "recall.ts"),
    path.join(ROOT, "src", "memory", "rules-evaluate.ts"),
    path.join(ROOT, "src", "memory", "feedback.ts"),
    path.join(ROOT, "src", "memory", "tools-select.ts"),
    path.join(ROOT, "src", "memory", "tools-run.ts"),
    path.join(ROOT, "src", "memory", "tools-decision.ts"),
    path.join(ROOT, "src", "memory", "tools-feedback.ts"),
    path.join(ROOT, "src", "memory", "tools-pattern-anchor.ts"),
    path.join(ROOT, "src", "memory", "find.ts"),
    path.join(ROOT, "src", "memory", "resolve.ts"),
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.equal(source.includes("import type pg"), false, `${path.relative(ROOT, file)} should not import pg types`);
    assert.equal(source.includes("pg.PoolClient"), false, `${path.relative(ROOT, file)} should not expose pg client signatures`);
    assert.equal(source.includes("PoolClient"), false, `${path.relative(ROOT, file)} should not expose pool client signatures`);
    assert.equal(source.includes("createPostgres"), false, `${path.relative(ROOT, file)} should not auto-create postgres adapters`);
  }
});

test("focused store access contracts do not keep postgres adapter implementations", () => {
  const files = [
    path.join(ROOT, "src", "store", "write-access.ts"),
    path.join(ROOT, "src", "store", "recall-access.ts"),
    path.join(ROOT, "src", "store", "replay-access.ts"),
    path.join(ROOT, "src", "store", "sandbox-access.ts"),
    path.join(ROOT, "src", "store", "lite-runtime-store.ts"),
    path.join(ROOT, "src", "store", "memory-store.ts"),
  ];
  const forbiddenSymbols = [
    "import type pg",
    "pg.PoolClient",
    "PoolClient",
    "createPostgres",
    "Postgres",
    "postgres",
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const symbol of forbiddenSymbols) {
      assert.equal(source.includes(symbol), false, `${path.relative(ROOT, file)} should not keep ${symbol}`);
    }
  }
});

test("focused lite store and sandbox boundaries use session/access contracts only", () => {
  const files = [
    path.join(ROOT, "src", "store", "memory-store.ts"),
    path.join(ROOT, "src", "store", "lite-runtime-store.ts"),
    path.join(ROOT, "src", "store", "sandbox-access.ts"),
    path.join(ROOT, "src", "memory", "sandbox.ts"),
    path.join(ROOT, "src", "memory", "sandbox-executor.ts"),
    path.join(ROOT, "src", "app", "sandbox-budget.ts"),
    path.join(ROOT, "src", "app", "replay-runtime-options.ts"),
  ];
  const forbiddenSymbols = [
    "LiteRuntimeStoreClient",
    "RuntimeStoreClient",
    "RuntimeStoreQueryResult",
    "sandboxStoreAccessForClient",
    "type StoreLike",
    "client.query",
    "query<T",
    "unsupported lite runtime store SQL",
    "createQueryClient",
    "QueryClient",
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const symbol of forbiddenSymbols) {
      assert.equal(source.includes(symbol), false, `${path.relative(ROOT, file)} should not keep ${symbol}`);
    }
  }
  const memoryStoreFile = fs.readFileSync(path.join(ROOT, "src", "store", "memory-store.ts"), "utf8");
  const sandboxAccessFile = fs.readFileSync(path.join(ROOT, "src", "store", "sandbox-access.ts"), "utf8");
  assert.match(memoryStoreFile, /LiteRuntimeStoreSession/);
  assert.match(sandboxAccessFile, /createSandboxStore/);
});

test("focused config and package do not advertise alternate database backends", () => {
  const configFile = fs.readFileSync(path.join(ROOT, "src", "config.ts"), "utf8");
  const packageFile = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
  const lockFile = fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8");
  const forbiddenConfigSymbols = [
    "DATABASE_URL",
    "MEMORY_STORE_BACKEND",
    "MEMORY_STORE_EMBEDDED",
    "postgres",
    "embedded",
  ];
  for (const symbol of forbiddenConfigSymbols) {
    assert.equal(configFile.includes(symbol), false, `config should not keep ${symbol}`);
  }
  assert.equal(packageFile.includes("\"pg\""), false, "package should not depend on pg");
  assert.equal(packageFile.includes("@types/pg"), false, "package should not depend on @types/pg");
  assert.equal(lockFile.includes("node_modules/pg"), false, "lockfile should not install pg");
  assert.equal(lockFile.includes("@types/pg"), false, "lockfile should not install @types/pg");
});

test("lite route registration args drop server-only plumbing", () => {
  const serverFile = fs.readFileSync(path.join(ROOT, "src/server/http-server.ts"), "utf8");
  const runtimeEntry = fs.readFileSync(path.join(ROOT, "src/runtime-entry.ts"), "utf8");
  const forbiddenSymbols = [
    "emitControlAudit",
    "listSandboxBudgetProfiles",
    "getSandboxBudgetProfile",
    "upsertSandboxBudgetProfile",
    "deleteSandboxBudgetProfile",
    "listSandboxProjectBudgetProfiles",
    "getSandboxProjectBudgetProfile",
    "upsertSandboxProjectBudgetProfile",
    "deleteSandboxProjectBudgetProfile",
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(serverFile.includes(symbol), false, `${symbol} should be absent from lite http-server route args`);
    assert.equal(runtimeEntry.includes(symbol), false, `${symbol} should not be passed through lite runtime-entry route wiring`);
  }
  const sandboxBudgetFile = fs.readFileSync(path.join(ROOT, "src", "app", "sandbox-budget.ts"), "utf8");
  for (const symbol of forbiddenSymbols.slice(2)) {
    assert.equal(sandboxBudgetFile.includes(symbol), false, `${symbol} should be absent from lite sandbox-budget module`);
  }
  assert.match(sandboxBudgetFile, /enforceSandboxTenantBudget/);
});

test("focused lite repo removes automation product sources", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "src/routes/automations.ts")), false, "automation route should be absent");
  assert.equal(fs.existsSync(path.join(ROOT, "src/memory/automation-lite.ts")), false, "automation kernel should be absent");
  assert.equal(fs.existsSync(path.join(ROOT, "src/store/lite-automation-store.ts")), false, "automation definition store should be absent");
  assert.equal(fs.existsSync(path.join(ROOT, "src/store/lite-automation-run-store.ts")), false, "automation run store should be absent");
  const liteEdition = fs.readFileSync(path.join(ROOT, "src/server/lite-runtime-boundary.ts"), "utf8");
  assert.equal(liteEdition.includes("automation orchestration remains server-only"), false);
  assert.equal(liteEdition.includes("automations-lite-kernel"), false);
});

test("lite replay repair review policy is endpoint-only", () => {
  const policyFile = fs.readFileSync(path.join(ROOT, "src", "app", "replay-repair-review-policy.ts"), "utf8");
  const configFile = fs.readFileSync(path.join(ROOT, "src", "config.ts"), "utf8");
  assert.equal(policyFile.includes("tenant_scope_endpoint"), false, "tenant_scope_endpoint should be absent from lite repair review policy");
  assert.equal(policyFile.includes("tenant_scope_default"), false, "tenant_scope_default should be absent from lite repair review policy");
  assert.equal(policyFile.includes("tenant_endpoint"), false, "tenant_endpoint should be absent from lite repair review policy");
  assert.equal(policyFile.includes("tenant_default"), false, "tenant_default should be absent from lite repair review policy");
  assert.match(configFile, /is not supported in Lite \(use endpoint only\)/);
});

test("lite runtime services do not wire postgres or embedded store constructors", () => {
  const runtimeServicesFile = fs.readFileSync(path.join(ROOT, "src", "app", "runtime-services.ts"), "utf8");
  const forbiddenSymbols = [
    "createPostgresRecallStoreAccess",
    "createPostgresReplayStoreAccess",
    "createPostgresWriteStoreAccess",
    CREATE_EMBEDDED_RUNTIME_SYMBOL,
    "createMemoryStore",
    "asPostgresMemoryStore",
    "databaseTargetHash",
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(runtimeServicesFile.includes(symbol), false, `${symbol} should be absent from lite runtime-services`);
  }
  assert.match(runtimeServicesFile, /aionis-lite runtime services only support AIONIS_EDITION=lite/);
});

test("lite request guards do not keep full auth or tenant quota plumbing", () => {
  const requestGuardsFile = fs.readFileSync(path.join(ROOT, "src", "app", "request-guards.ts"), "utf8");
  const runtimeEntryFile = fs.readFileSync(path.join(ROOT, "src", "runtime-entry.ts"), "utf8");
  const runtimeServicesFile = fs.readFileSync(path.join(ROOT, "src", "app", "runtime-services.ts"), "utf8");
  const forbiddenSymbols = [
    "recordControlAuditEvent",
    "emitControlAudit",
    "resolveControlPlaneApiKeyPrincipal",
    "tenantQuotaResolver",
    "authResolver",
    "assertIdentityMatch",
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(requestGuardsFile.includes(symbol), false, `${symbol} should be absent from lite request-guards`);
    assert.equal(runtimeEntryFile.includes(symbol), false, `${symbol} should not be passed through lite runtime-entry`);
    assert.equal(runtimeServicesFile.includes(symbol), false, `${symbol} should be absent from lite runtime-services`);
  }
  assert.match(requestGuardsFile, /aionis-lite request guards only support MEMORY_AUTH_MODE=off/);
  assert.match(requestGuardsFile, /aionis-lite request guards only support TENANT_QUOTA_ENABLED=false/);
});

test("lite server does not keep db-backed request telemetry plumbing", () => {
  const runtimeEntryFile = fs.readFileSync(path.join(ROOT, "src", "runtime-entry.ts"), "utf8");
  const serverFile = fs.readFileSync(path.join(ROOT, "src", "server", "http-server.ts"), "utf8");
  const httpObservabilityFile = fs.readFileSync(path.join(ROOT, "src", "app", "http-observability.ts"), "utf8");

  assert.equal(runtimeEntryFile.includes("./control-plane.js"), false, "runtime-entry should not import control-plane");
  assert.equal(serverFile.includes("../control-plane.js"), false, "runtime server should not import control-plane");
  assert.equal(runtimeEntryFile.includes("./app/runtime-telemetry.js"), false);
  assert.equal(serverFile.includes("../app/runtime-telemetry.js"), false);
  assert.equal(serverFile.includes("../db.js"), false);
  assert.equal(serverFile.includes("recordMemoryRequestTelemetry"), false);
  assert.equal(httpObservabilityFile.includes("recordMemoryContextAssemblyTelemetry"), false);
  assert.match(httpObservabilityFile, /context assembly telemetry/);
  assert.equal(httpObservabilityFile.includes("createApiKeyPrincipalResolver"), false);
  assert.equal(httpObservabilityFile.includes("createTenantQuotaResolver"), false);
  assert.equal(httpObservabilityFile.includes("recordControlAuditEvent"), false);
});

test("lite health surface avoids backend implementation detail fields", () => {
  const serverFile = fs.readFileSync(path.join(ROOT, "src", "server", "http-server.ts"), "utf8");
  const forbiddenSymbols = [
    "configured_backend",
    "database_target_hash",
    "memory_store_capability_contract",
    "recall_store_access_capability_version",
    "replay_store_access_capability_version",
    "write_store_access_capability_version",
    "memory_store_embedded_runtime",
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(serverFile.includes(symbol), false, `${symbol} should be absent from lite runtime server health/config surfaces`);
  }
  assert.match(serverFile, /local_actor_id: env\.LITE_LOCAL_ACTOR_ID/);
});

test("lite pack routes do not keep admin-token-only gating", () => {
  const memoryAccessFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-access.ts"), "utf8");
  assert.equal(memoryAccessFile.includes("requireAdmin: true"), false, "pack routes should not require admin token in lite");
  assert.equal(memoryAccessFile.includes("requireAdminToken"), false, "memory-access should not depend on admin token helper in lite");
});

test("lite memory-access routes do not keep alternate store branches", () => {
  const memoryAccessFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-access.ts"), "utf8");
  const serverFile = fs.readFileSync(path.join(ROOT, "src", "server", "http-server.ts"), "utf8");
  const forbiddenSymbols = [
    "store.withTx",
    "store.withClient",
    "memoryFind(",
    "memoryResolve(",
    EMBEDDED_RUNTIME_SYMBOL,
    "pg.PoolClient",
    "{} as pg.PoolClient",
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(memoryAccessFile.includes(symbol), false, `${symbol} should be absent from lite memory-access routes`);
  }
  assert.equal(serverFile.includes("registerMemoryAccessRoutes({\n    app,\n    env,\n    store,"), false, "lite runtime server should not pass store into memory-access routes");
  assert.match(memoryAccessFile, /aionis-lite memory-access routes only support AIONIS_EDITION=lite/);
});

test("lite memory-access helper modules do not keep postgres alternate signatures", () => {
  const files = [
    path.join(ROOT, "src", "memory", "delegation-records.ts"),
  ];
  const forbiddenSymbols = [
    "import type pg",
    "pg.PoolClient",
    "applyMemoryWrite",
    "createPostgresWriteStoreAccess",
    EMBEDDED_RUNTIME_SYMBOL,
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const symbol of forbiddenSymbols) {
      assert.equal(source.includes(symbol), false, `${symbol} should be absent from ${path.relative(ROOT, file)}`);
    }
  }
  assert.equal(fs.existsSync(path.join(ROOT, "src", "memory", "sessions.ts")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "src", "memory", "packs.ts")), false);
});

test("focused runtime does not expose generic memory-sandbox public routes", () => {
  const serverFile = fs.readFileSync(path.join(ROOT, "src", "server", "http-server.ts"), "utf8");
  assert.equal(fs.existsSync(path.join(ROOT, "src", "routes", "memory-sandbox.ts")), false);
  assert.equal(serverFile.includes("registerMemorySandboxRoutes"), false);
  assert.equal(serverFile.includes("../routes/memory-sandbox.js"), false);
});

test("lite memory-feedback-tools routes do not keep alternate store branches", () => {
  const memoryFeedbackToolsFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-feedback-tools.ts"), "utf8");
  const feedbackFile = fs.readFileSync(path.join(ROOT, "src", "memory", "feedback.ts"), "utf8");
  const serverFile = fs.readFileSync(path.join(ROOT, "src", "server", "http-server.ts"), "utf8");
  const forbiddenSymbols = [
    "type StoreLike",
    "store.withTx",
    "store.withClient",
    "executeStore:",
    "MemoryFeedbackRunner",
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(memoryFeedbackToolsFile.includes(symbol), false, `${symbol} should be absent from lite memory-feedback-tools routes`);
  }
  assert.equal(serverFile.includes("registerMemoryFeedbackToolRoutes({\n    app,\n    env,\n    store,"), false, "lite runtime server should not pass store into memory-feedback-tools routes");
  assert.match(memoryFeedbackToolsFile, /aionis-lite memory-feedback-tools routes only support AIONIS_EDITION=lite/);
  assert.match(feedbackFile, /lite_write_store_required/);
});

test("lite learning helpers do not keep legacy memory SQL branches", () => {
  const files = [
    path.join(ROOT, "src", "memory", "feedback.ts"),
    path.join(ROOT, "src", "memory", "find.ts"),
    path.join(ROOT, "src", "memory", "handoff.ts"),
    path.join(ROOT, "src", "memory", "replay-learning.ts"),
    path.join(ROOT, "src", "memory", "resolve.ts"),
    path.join(ROOT, "src", "memory", "rules.ts"),
    path.join(ROOT, "src", "memory", "rules-evaluate.ts"),
    path.join(ROOT, "src", "memory", "tools-decision.ts"),
    path.join(ROOT, "src", "memory", "tools-pattern-anchor.ts"),
    path.join(ROOT, "src", "memory", "tools-run.ts"),
    path.join(ROOT, "src", "memory", "tools-select.ts"),
  ];
  const forbiddenSymbols = [
    "LiteRuntimeStoreClient",
    "client.query",
    ".query<",
    "requireStoreClient",
    "memory_nodes",
    "memory_edges",
    "memory_commits",
    "memory_rule_defs",
    "memory_rule_feedback",
    "memory_execution_decisions",
    "memory_outbox",
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const symbol of forbiddenSymbols) {
      assert.equal(source.includes(symbol), false, `${path.relative(ROOT, file)} should not keep legacy SQL branch symbol ${symbol}`);
    }
  }
});

test("lite memory-recall routes do not keep store-client recall plumbing", () => {
  const memoryRecallFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-recall.ts"), "utf8");
  const serverFile = fs.readFileSync(path.join(ROOT, "src", "server", "http-server.ts"), "utf8");
  const forbiddenSymbols = [
    "type StoreLike",
    "store.withClient",
    "recallAccessForClient",
    "pg.PoolClient",
    "{} as pg.PoolClient",
    EMBEDDED_RUNTIME_SYMBOL,
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(memoryRecallFile.includes(symbol), false, `${symbol} should be absent from lite memory-recall routes`);
  }
  assert.equal(serverFile.includes("registerMemoryRecallRoutes({\n    app,\n    env,\n    store,"), false, "lite runtime server should not pass store into memory-recall routes");
  assert.equal(
    serverFile.includes(`registerMemoryRecallRoutes({\n    app,\n    env,\n    ${EMBEDDED_RUNTIME_SYMBOL},`),
    false,
    "lite runtime server should not pass embedded runtime into memory-recall routes",
  );
  assert.match(memoryRecallFile, /aionis-lite memory-recall routes only support AIONIS_EDITION=lite/);
});

test("lite memory-context-runtime routes do not keep store-client recall plumbing", () => {
  const memoryContextRuntimeFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-context-runtime.ts"), "utf8");
  const serverFile = fs.readFileSync(path.join(ROOT, "src", "server", "http-server.ts"), "utf8");
  const forbiddenSymbols = [
    "type StoreLike",
    "store.withClient",
    "recallAccessForClient",
    "liteModeActive",
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(memoryContextRuntimeFile.includes(symbol), false, `${symbol} should be absent from lite memory-context-runtime routes`);
  }
  assert.equal(serverFile.includes("registerMemoryContextRuntimeRoutes({\n    app,\n    env,\n    store,"), false, "lite runtime server should not pass store into memory-context-runtime routes");
  assert.match(memoryContextRuntimeFile, /aionis-lite memory-context-runtime routes only support AIONIS_EDITION=lite/);
});

test("lite handoff routes do not keep alternate store branches", () => {
  const handoffFile = fs.readFileSync(path.join(ROOT, "src", "routes", "handoff.ts"), "utf8");
  const serverFile = fs.readFileSync(path.join(ROOT, "src", "server", "http-server.ts"), "utf8");
  const forbiddenSymbols = [
    "type StoreLike",
    "store.withTx",
    "store.withClient",
    "writeAccessForClient",
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(handoffFile.includes(symbol), false, `${symbol} should be absent from lite handoff routes`);
  }
  assert.equal(serverFile.includes("registerHandoffRoutes({\n    app,\n    env,\n    store,"), false, "lite runtime server should not pass store into handoff routes");
  assert.match(handoffFile, /aionis-lite handoff routes only support AIONIS_EDITION=lite/);
});

test("lite memory-write route does not keep server write alternate branches", () => {
  const memoryWriteFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-write.ts"), "utf8");
  const serverFile = fs.readFileSync(path.join(ROOT, "src", "server", "http-server.ts"), "utf8");
  const runtimeEntryFile = fs.readFileSync(path.join(ROOT, "src", "runtime-entry.ts"), "utf8");
  const forbiddenSymbols = [
    "type StoreLike",
    "store.withTx",
    "writeAccessForClient",
    "runTopicClusterForEventIds",
    "applyMemoryWrite",
    "liteModeActive",
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(memoryWriteFile.includes(symbol), false, `${symbol} should be absent from lite memory-write route`);
  }
  assert.equal(serverFile.includes("registerMemoryWriteRoutes({\n    app,\n    env,\n    store,"), false, "lite runtime server should not pass store into memory-write route");
  assert.equal(runtimeEntryFile.includes("runTopicClusterForEventIds"), false, "lite runtime-entry should not inject server topic clustering into write routes");
  assert.match(memoryWriteFile, /aionis-lite memory-write route only supports AIONIS_EDITION=lite/);
});

test("lite prepared write commit uses store access directly instead of a placeholder pg client", () => {
  const commitFile = fs.readFileSync(path.join(ROOT, "src", "memory", "lite-projected-write-commit.ts"), "utf8");
  const writeFile = fs.readFileSync(path.join(ROOT, "src", "memory", "write.ts"), "utf8");
  assert.equal(commitFile.includes("import type pg from \"pg\""), false, "lite projected write commit should not import pg");
  assert.equal(commitFile.includes("{} as pg.PoolClient"), false, "lite projected write commit should not use a placeholder pg client");
  assert.match(commitFile, /applyPreparedMemoryWrite\(args\.liteWriteStore, args\.prepared/);
  assert.match(writeFile, /export async function applyPreparedMemoryWrite/);
});

test("lite server does not register PG-only memory lifecycle routes and keeps a Lite-native lifecycle surface", () => {
  const serverFile = fs.readFileSync(path.join(ROOT, "src", "server", "http-server.ts"), "utf8");
  const liteEditionFile = fs.readFileSync(path.join(ROOT, "src", "server", "lite-runtime-boundary.ts"), "utf8");
  const lifecycleRouteFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-lifecycle-lite.ts"), "utf8");
  assert.equal(serverFile.includes("registerMemoryLifecycleRoutes"), false, "lite runtime server should not register PG-only memory lifecycle routes");
  assert.match(serverFile, /registerLiteMemoryLifecycleRoutes/);
  assert.match(lifecycleRouteFile, /\/v1\/memory\/archive\/rehydrate/);
  assert.match(lifecycleRouteFile, /\/v1\/memory\/nodes\/activate/);
  assert.match(liteEditionFile, /\/v1\/memory\/archive\/rehydrate/);
  assert.match(liteEditionFile, /\/v1\/memory\/nodes\/activate/);
});

test("lite memory-replay-learning-control routes do not keep alternate store branches", () => {
  const replayLearningControlFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-replay-learning-control.ts"), "utf8");
  const serverFile = fs.readFileSync(path.join(ROOT, "src", "server", "http-server.ts"), "utf8");
  const forbiddenSymbols = [
    "type StoreLike",
    "store.withTx",
    "store.withClient",
    "liteModeActive",
    "pg.PoolClient",
    "{} as pg.PoolClient",
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(replayLearningControlFile.includes(symbol), false, `${symbol} should be absent from lite memory-replay-learning-control routes`);
  }
  assert.equal(serverFile.includes("registerMemoryReplayLearningControlRoutes({\n    app,\n    env,\n    store,"), false, "lite runtime server should not pass store into memory-replay-learning-control routes");
  assert.match(replayLearningControlFile, /aionis-lite memory-replay-learning-control routes only support AIONIS_EDITION=lite/);
});

test("lite memory-replay-core routes do not keep alternate store branches", () => {
  const replayCoreFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-replay-core.ts"), "utf8");
  const serverFile = fs.readFileSync(path.join(ROOT, "src", "server", "http-server.ts"), "utf8");
  const forbiddenSymbols = [
    "type StoreLike",
    "store.withTx",
    "store.withClient",
    "LiteRuntimeStoreClient",
    "liteModeActive",
    "liteReplayReadActive",
    "operation: (client",
    "operation(null",
    "replayAccessForClient",
    "pg.PoolClient",
    "{} as pg.PoolClient",
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(replayCoreFile.includes(symbol), false, `${symbol} should be absent from lite memory-replay-core routes`);
  }
  assert.equal(serverFile.includes("registerMemoryReplayCoreRoutes({\n    app,\n    env,\n    store,"), false, "lite runtime server should not pass store into memory-replay-core routes");
  assert.match(replayCoreFile, /aionis-lite replay core routes only support AIONIS_EDITION=lite/);
  assert.match(replayCoreFile, /require liteReplayAccess/);
  assert.match(replayCoreFile, /require liteWriteStore/);
});

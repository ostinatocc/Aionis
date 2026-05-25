import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

const FORBIDDEN_PATHS = [
  "src/.DS_Store",
  "src/bench/many-tools.ts",
  "src/dev/contract-smoke.ts",
  "src/eval/score.ts",
  "src/sdk/index.ts",
  "src/control-plane.ts",
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
  "topicClusterLib.ts",
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

test("focused lite source never fakes postgres clients", () => {
  for (const file of listSourceFiles(path.join(ROOT, "src"))) {
    const source = fs.readFileSync(file, "utf8");
    assert.equal(source.includes("{} as pg.PoolClient"), false, `${path.relative(ROOT, file)} should not fake a pg client`);
    assert.equal(source.includes("client ?? ({} as pg.PoolClient)"), false, `${path.relative(ROOT, file)} should not fallback to a fake pg client`);
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

test("lite repo does not keep a copied apps/lite dist launcher", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "apps", "lite", "dist")), false, "apps/lite/dist should be absent");
});

test("lite repo does not keep fixture-only real validation artifacts", () => {
  assert.equal(
    fs.existsSync(path.join(ROOT, "scripts", "fixtures", "real-ab-validation")),
    false,
    "real validation must run live LLM agents, not fixture-only trace or metric files",
  );
});

test("lite host does not statically import server-only routes", () => {
  const hostFile = fs.readFileSync(path.join(ROOT, "src/host/http-host.ts"), "utf8");
  const forbiddenImports = [
    "../routes/admin-control-alerts.js",
    "../routes/admin-control-config.js",
    "../routes/admin-control-dashboard.js",
    "../routes/admin-control-entities.js",
  ];
  for (const specifier of forbiddenImports) {
    assert.equal(hostFile.includes(specifier), false, `${specifier} should not be imported by lite http-host`);
  }
  assert.equal(hostFile.includes("../routes/automations.js"), false, "focused lite http-host should not import automation routes");
  assert.match(hostFile, /assertLiteOnlySourceTree/);
});

test("lite route registration args drop server-only plumbing", () => {
  const hostFile = fs.readFileSync(path.join(ROOT, "src/host/http-host.ts"), "utf8");
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
    assert.equal(hostFile.includes(symbol), false, `${symbol} should be absent from lite http-host route args`);
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
  const liteEdition = fs.readFileSync(path.join(ROOT, "src/host/lite-edition.ts"), "utf8");
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
    "createEmbeddedMemoryRuntime",
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

test("lite host uses local runtime telemetry instead of control-plane plumbing", () => {
  const runtimeEntryFile = fs.readFileSync(path.join(ROOT, "src", "runtime-entry.ts"), "utf8");
  const hostFile = fs.readFileSync(path.join(ROOT, "src", "host", "http-host.ts"), "utf8");
  const runtimeTelemetryFile = fs.readFileSync(path.join(ROOT, "src", "app", "runtime-telemetry.ts"), "utf8");

  assert.equal(runtimeEntryFile.includes("./control-plane.js"), false, "runtime-entry should not import control-plane");
  assert.equal(hostFile.includes("../control-plane.js"), false, "http-host should not import control-plane");
  assert.match(runtimeEntryFile, /\.\/app\/runtime-telemetry\.js/);
  assert.match(hostFile, /\.\.\/app\/runtime-telemetry\.js/);
  assert.match(runtimeTelemetryFile, /recordMemoryRequestTelemetry/);
  assert.match(runtimeTelemetryFile, /recordMemoryContextAssemblyTelemetry/);
  assert.equal(runtimeTelemetryFile.includes("createApiKeyPrincipalResolver"), false);
  assert.equal(runtimeTelemetryFile.includes("createTenantQuotaResolver"), false);
  assert.equal(runtimeTelemetryFile.includes("recordControlAuditEvent"), false);
});

test("lite health surface avoids backend implementation detail fields", () => {
  const hostFile = fs.readFileSync(path.join(ROOT, "src", "host", "http-host.ts"), "utf8");
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
    assert.equal(hostFile.includes(symbol), false, `${symbol} should be absent from lite host health/config surfaces`);
  }
  assert.match(hostFile, /local_actor_id: env\.LITE_LOCAL_ACTOR_ID/);
});

test("lite pack routes do not keep admin-token-only gating", () => {
  const memoryAccessFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-access.ts"), "utf8");
  assert.equal(memoryAccessFile.includes("requireAdmin: true"), false, "pack routes should not require admin token in lite");
  assert.equal(memoryAccessFile.includes("requireAdminToken"), false, "memory-access should not depend on admin token helper in lite");
});

test("lite memory-access routes do not keep store fallback branches", () => {
  const memoryAccessFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-access.ts"), "utf8");
  const hostFile = fs.readFileSync(path.join(ROOT, "src", "host", "http-host.ts"), "utf8");
  const forbiddenSymbols = [
    "store.withTx",
    "store.withClient",
    "memoryFind(",
    "memoryResolve(",
    "embeddedRuntime",
    "pg.PoolClient",
    "{} as pg.PoolClient",
    "writeAccessShadowMirrorV2",
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(memoryAccessFile.includes(symbol), false, `${symbol} should be absent from lite memory-access routes`);
  }
  assert.equal(hostFile.includes("registerMemoryAccessRoutes({\n    app,\n    env,\n    store,"), false, "lite host should not pass store into memory-access routes");
  assert.match(memoryAccessFile, /aionis-lite memory-access routes only support AIONIS_EDITION=lite/);
});

test("lite memory-access helper modules do not keep postgres fallback signatures", () => {
  const files = [
    path.join(ROOT, "src", "memory", "sessions.ts"),
    path.join(ROOT, "src", "memory", "packs.ts"),
    path.join(ROOT, "src", "memory", "delegation-records.ts"),
  ];
  const forbiddenSymbols = [
    "import type pg",
    "pg.PoolClient",
    "applyMemoryWrite",
    "createPostgresWriteStoreAccess",
    "writeAccessShadowMirrorV2",
    "embeddedRuntime",
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const symbol of forbiddenSymbols) {
      assert.equal(source.includes(symbol), false, `${symbol} should be absent from ${path.relative(ROOT, file)}`);
    }
  }
});

test("lite memory-sandbox routes keep optional admin-only guard but default to local direct use", () => {
  const memorySandboxFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-sandbox.ts"), "utf8");
  const hostFile = fs.readFileSync(path.join(ROOT, "src", "host", "http-host.ts"), "utf8");
  const configFile = fs.readFileSync(path.join(ROOT, "src", "config.ts"), "utf8");
  assert.match(memorySandboxFile, /aionis-lite memory-sandbox routes only support AIONIS_EDITION=lite/);
  assert.match(memorySandboxFile, /if \(env\.SANDBOX_ADMIN_ONLY\)/);
  assert.match(memorySandboxFile, /requireAdminToken\(req\)/);
  assert.equal(memorySandboxFile.includes("requireMemoryPrincipal"), false, "memory-sandbox should not depend on principal plumbing in lite");
  assert.equal(hostFile.includes("registerMemorySandboxRoutes({\n    app,\n    env,\n    store,\n    sandboxExecutor,\n    requireAdminToken,\n    requireMemoryPrincipal,"), false, "lite host should not pass requireMemoryPrincipal into memory-sandbox routes");
  assert.match(configFile, /SANDBOX_ENABLED:[\s\S]*v \?\? "true"/);
  assert.match(configFile, /SANDBOX_ADMIN_ONLY:[\s\S]*v \?\? "false"/);
});

test("lite memory-feedback-tools routes do not keep store fallback branches", () => {
  const memoryFeedbackToolsFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-feedback-tools.ts"), "utf8");
  const feedbackFile = fs.readFileSync(path.join(ROOT, "src", "memory", "feedback.ts"), "utf8");
  const hostFile = fs.readFileSync(path.join(ROOT, "src", "host", "http-host.ts"), "utf8");
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
  assert.equal(hostFile.includes("registerMemoryFeedbackToolRoutes({\n    app,\n    env,\n    store,"), false, "lite host should not pass store into memory-feedback-tools routes");
  assert.match(memoryFeedbackToolsFile, /aionis-lite memory-feedback-tools routes only support AIONIS_EDITION=lite/);
  assert.match(feedbackFile, /lite_write_store_required/);
});

test("lite memory-recall routes do not keep store-client recall plumbing", () => {
  const memoryRecallFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-recall.ts"), "utf8");
  const hostFile = fs.readFileSync(path.join(ROOT, "src", "host", "http-host.ts"), "utf8");
  const forbiddenSymbols = [
    "type StoreLike",
    "store.withClient",
    "recallAccessForClient",
    "pg.PoolClient",
    "{} as pg.PoolClient",
    "embeddedRuntime",
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(memoryRecallFile.includes(symbol), false, `${symbol} should be absent from lite memory-recall routes`);
  }
  assert.equal(hostFile.includes("registerMemoryRecallRoutes({\n    app,\n    env,\n    store,"), false, "lite host should not pass store into memory-recall routes");
  assert.equal(hostFile.includes("registerMemoryRecallRoutes({\n    app,\n    env,\n    embeddedRuntime,"), false, "lite host should not pass embeddedRuntime into memory-recall routes");
  assert.match(memoryRecallFile, /aionis-lite memory-recall routes only support AIONIS_EDITION=lite/);
});

test("lite memory-context-runtime routes do not keep store-client recall plumbing", () => {
  const memoryContextRuntimeFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-context-runtime.ts"), "utf8");
  const hostFile = fs.readFileSync(path.join(ROOT, "src", "host", "http-host.ts"), "utf8");
  const forbiddenSymbols = [
    "type StoreLike",
    "store.withClient",
    "recallAccessForClient",
    "liteModeActive",
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(memoryContextRuntimeFile.includes(symbol), false, `${symbol} should be absent from lite memory-context-runtime routes`);
  }
  assert.equal(hostFile.includes("registerMemoryContextRuntimeRoutes({\n    app,\n    env,\n    store,"), false, "lite host should not pass store into memory-context-runtime routes");
  assert.match(memoryContextRuntimeFile, /aionis-lite memory-context-runtime routes only support AIONIS_EDITION=lite/);
});

test("lite handoff routes do not keep store fallback branches", () => {
  const handoffFile = fs.readFileSync(path.join(ROOT, "src", "routes", "handoff.ts"), "utf8");
  const hostFile = fs.readFileSync(path.join(ROOT, "src", "host", "http-host.ts"), "utf8");
  const forbiddenSymbols = [
    "type StoreLike",
    "store.withTx",
    "store.withClient",
    "writeAccessForClient",
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(handoffFile.includes(symbol), false, `${symbol} should be absent from lite handoff routes`);
  }
  assert.equal(hostFile.includes("registerHandoffRoutes({\n    app,\n    env,\n    store,"), false, "lite host should not pass store into handoff routes");
  assert.match(handoffFile, /aionis-lite handoff routes only support AIONIS_EDITION=lite/);
});

test("lite memory-write route does not keep server write fallback branches", () => {
  const memoryWriteFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-write.ts"), "utf8");
  const hostFile = fs.readFileSync(path.join(ROOT, "src", "host", "http-host.ts"), "utf8");
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
  assert.equal(hostFile.includes("registerMemoryWriteRoutes({\n    app,\n    env,\n    store,"), false, "lite host should not pass store into memory-write route");
  assert.equal(runtimeEntryFile.includes("runTopicClusterForEventIds"), false, "lite runtime-entry should not inject server topic clustering into write routes");
  assert.match(memoryWriteFile, /aionis-lite memory-write route only supports AIONIS_EDITION=lite/);
});

test("lite prepared write commit uses store access directly instead of a fake pg client", () => {
  const commitFile = fs.readFileSync(path.join(ROOT, "src", "memory", "lite-projected-write-commit.ts"), "utf8");
  const writeFile = fs.readFileSync(path.join(ROOT, "src", "memory", "write.ts"), "utf8");
  assert.equal(commitFile.includes("import type pg from \"pg\""), false, "lite projected write commit should not import pg");
  assert.equal(commitFile.includes("{} as pg.PoolClient"), false, "lite projected write commit should not fake a pg client");
  assert.match(commitFile, /applyPreparedMemoryWrite\(args\.liteWriteStore, args\.prepared/);
  assert.match(writeFile, /export async function applyPreparedMemoryWrite/);
});

test("lite host does not register PG-only memory lifecycle routes and keeps a Lite-native lifecycle surface", () => {
  const hostFile = fs.readFileSync(path.join(ROOT, "src", "host", "http-host.ts"), "utf8");
  const liteEditionFile = fs.readFileSync(path.join(ROOT, "src", "host", "lite-edition.ts"), "utf8");
  assert.equal(hostFile.includes("registerMemoryLifecycleRoutes"), false, "lite host should not register PG-only memory lifecycle routes");
  assert.match(hostFile, /registerLiteMemoryLifecycleRoutes/);
  assert.equal(liteEditionFile.includes("/v1/memory/archive/rehydrate"), false, "lite edition should not stub archive rehydrate once implemented");
  assert.equal(liteEditionFile.includes("/v1/memory/nodes/activate"), false, "lite edition should not stub nodes activate once implemented");
});

test("lite memory-replay-learning-control routes do not keep store fallback branches", () => {
  const replayLearningControlFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-replay-learning-control.ts"), "utf8");
  const hostFile = fs.readFileSync(path.join(ROOT, "src", "host", "http-host.ts"), "utf8");
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
  assert.equal(hostFile.includes("registerMemoryReplayLearningControlRoutes({\n    app,\n    env,\n    store,"), false, "lite host should not pass store into memory-replay-learning-control routes");
  assert.match(replayLearningControlFile, /aionis-lite memory-replay-learning-control routes only support AIONIS_EDITION=lite/);
});

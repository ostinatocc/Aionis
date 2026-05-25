import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerHostErrorHandler } from "../../src/host/http-host.ts";
import { TrajectoryCompileResponseSchema } from "../../src/memory/schemas.ts";
import { registerMemoryAccessRoutes } from "../../src/routes/memory-access.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-trajectory-compile-"));
  return path.join(dir, `${name}.sqlite`);
}

const TEST_ENV = {
  AIONIS_EDITION: "lite",
  MEMORY_AUTH_MODE: "off",
  TENANT_QUOTA_ENABLED: false,
  LITE_LOCAL_ACTOR_ID: "local-user",
  MEMORY_TENANT_ID: "default",
  MEMORY_SCOPE: "default",
  APP_ENV: "test",
  ADMIN_TOKEN: "",
  TRUST_PROXY: false,
  TRUSTED_PROXY_CIDRS: [],
  RATE_LIMIT_ENABLED: false,
  RATE_LIMIT_BYPASS_LOOPBACK: false,
  WRITE_RATE_LIMIT_MAX_WAIT_MS: 0,
  RECALL_TEXT_EMBED_RATE_LIMIT_MAX_WAIT_MS: 0,
  MAX_TEXT_LEN: 10000,
  PII_REDACTION: false,
  ALLOW_CROSS_SCOPE_EDGES: false,
  MEMORY_SHADOW_DUAL_WRITE_ENABLED: false,
  MEMORY_SHADOW_DUAL_WRITE_STRICT: false,
} as any;

async function buildApp() {
  const dbPath = tmpDbPath("route");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallAccess = createLiteRecallStore(dbPath);
  const app = Fastify();
  registerHostErrorHandler(app);
  registerMemoryAccessRoutes({
    app,
    env: TEST_ENV,
    embedder: null,
    liteWriteStore,
    liteRecallAccess,
    writeAccessShadowMirrorV2: false,
    requireStoreFeatureCapability: () => {},
    requireMemoryPrincipal: async () => null,
    withIdentityFromRequest: (_req, body) => body,
    enforceRateLimit: async () => {},
    enforceTenantQuota: async () => {},
    tenantFromBody: () => "default",
    acquireInflightSlot: async () => ({ release() {} }),
  });
  await app.ready();
  return app;
}

test("trajectory compile route keeps package validation transport out of service lifecycle", async () => {
  const app = await buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/memory/trajectory/compile",
    payload: {
      query_text: "Repair the local package index server so clients can install from a fresh shell after the worker exits",
      trajectory: {
        steps: [
          { role: "assistant", text: "Investigating why package install fails after the local index server setup." },
          { role: "tool", tool_name: "bash", command: "python scripts/build_index.py && nohup python -m http.server 8080 --directory dist/simple >/tmp/index.log 2>&1 &" },
          { role: "tool", tool_name: "bash", command: "curl -fsS http://localhost:8080/simple/vectorops/" },
          { role: "tool", tool_name: "bash", command: "pip install --index-url http://localhost:8080/simple vectorops==0.1.0" },
          { role: "assistant", text: "Update scripts/build_index.py and src/vectorops/__init__.py, then relaunch the server in detached mode and rerun curl and pip install from a fresh shell." },
        ],
      },
    },
  });

  assert.equal(response.statusCode, 200);
  const parsed = TrajectoryCompileResponseSchema.parse(JSON.parse(response.body));
  assert.equal(parsed.task_family, "package_publish_validate");
  assert.ok(parsed.contract.target_files.includes("scripts/build_index.py"));
  assert.ok(parsed.contract.target_files.includes("src/vectorops/__init__.py"));
  assert.ok(parsed.contract.acceptance_checks.some((entry) => entry.includes("curl -fsS http://localhost:8080/simple/vectorops/")));
  assert.ok(parsed.contract.acceptance_checks.some((entry) => entry.includes("pip install --index-url http://localhost:8080/simple vectorops==0.1.0")));
  assert.ok(parsed.contract.success_invariants.includes("clean_client_install_succeeds"));
  assert.ok(parsed.contract.dependency_requirements.some((entry) => entry.includes("package artifacts and index metadata")));
  assert.ok(parsed.contract.environment_assumptions.includes("validation_can_run_from_fresh_shell"));
  assert.ok(!parsed.contract.must_hold_after_exit.includes("task_result_remains_valid_after_agent_exit"));
  assert.ok(parsed.contract.external_visibility_requirements.includes("package_install_visible_to_clean_client"));
  assert.equal(parsed.contract.service_lifecycle_constraints.length, 0);
  assert.ok(!parsed.contract.pattern_hints.includes("detach_long_running_service_before_validation"));
  assert.ok(!parsed.contract.pattern_hints.includes("revalidate_service_from_fresh_shell"));
  assert.ok(parsed.contract.pattern_hints.includes("publish_then_install_from_clean_client_path"));
  assert.ok(parsed.contract.workflow_steps.length > 0);
  await app.close();
});

test("trajectory compile route filters sandbox excuses out of next action", async () => {
  const app = await buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/memory/trajectory/compile",
    payload: {
      query_text: "Repair deploy validation for the git webserver handoff",
      trajectory: {
        steps: [
          { role: "tool", tool_name: "bash", command: "git config --global receive.denyCurrentBranch updateInstead" },
          { role: "tool", tool_name: "bash", command: "curl -k https://localhost:8443/index.html" },
          {
            role: "assistant",
            text: "I can't fully execute the smoke test in this sandbox, so I'm doing a source-level check and would hand this over.",
          },
        ],
      },
      hints: {
        target_files: ["/var/www/main/index.html"],
      },
    },
  });

  assert.equal(response.statusCode, 200);
  const parsed = TrajectoryCompileResponseSchema.parse(JSON.parse(response.body));
  assert.ok(parsed.contract.next_action);
  assert.ok(!parsed.contract.next_action!.toLowerCase().includes("sandbox"));
  assert.ok(!parsed.contract.next_action!.toLowerCase().includes("hand this over"));
  assert.ok(parsed.contract.noise_markers.includes("can't fully execute"));
  await app.close();
});

test("trajectory compile route does not infer service lifecycle from passive localhost probes alone", async () => {
  const app = await buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/memory/trajectory/compile",
    payload: {
      query_text: "Repair package validation after a localhost probe failed",
      trajectory: {
        steps: [
          { role: "assistant", text: "Investigating why the package is unavailable from the local index." },
          { role: "tool", tool_name: "bash", command: "curl -fsS http://localhost:8080/simple/vectorops/" },
          { role: "tool", tool_name: "bash", command: "pip install --index-url http://localhost:8080/simple vectorops==0.1.0" },
          { role: "assistant", text: "Update scripts/build_index.py and rerun the narrow validation path." },
        ],
      },
    },
  });

  assert.equal(response.statusCode, 200);
  const parsed = TrajectoryCompileResponseSchema.parse(JSON.parse(response.body));
  assert.equal(parsed.contract.service_lifecycle_constraints.length, 0);
  assert.ok(!parsed.contract.pattern_hints.includes("detach_long_running_service_before_validation"));
  assert.ok(!parsed.contract.pattern_hints.includes("revalidate_service_from_fresh_shell"));
  await app.close();
});

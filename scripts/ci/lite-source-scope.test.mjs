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
  "associative-linking-worker.ts",
  "lite-projection-worker.ts",
];

const BOUNDED_STABLE_JSON_SOURCE_DIRS = [
  "src/execution",
  "src/memory",
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

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
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

test("execution and memory source use the bounded stableJson helper", () => {
  for (const relDir of BOUNDED_STABLE_JSON_SOURCE_DIRS) {
    for (const file of listSourceFiles(path.join(ROOT, relDir))) {
      const source = fs.readFileSync(file, "utf8");
      assert.equal(
        /function\s+stableJson\s*\(/.test(source),
        false,
        `${path.relative(ROOT, file)} should import util/stable-json instead of defining a local recursive stableJson`,
      );
    }
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

test("generic lite outbox stays reserved for associative linking while durable projections use their own queue", () => {
  const writeAccessFile = fs.readFileSync(path.join(ROOT, "src", "store", "write-access.ts"), "utf8");
  const writePostCommitFile = fs.readFileSync(path.join(ROOT, "src", "memory", "write-post-commit.ts"), "utf8");
  const runtimeEntryFile = fs.readFileSync(path.join(ROOT, "src", "runtime-entry.ts"), "utf8");
  const workerFile = fs.readFileSync(path.join(ROOT, "src", "jobs", "associative-linking-worker.ts"), "utf8");
  const projectionStoreFile = fs.readFileSync(path.join(ROOT, "src", "store", "lite-projection-outbox.ts"), "utf8");
  const removedOutboxEvents = [
    "embed" + "_nodes",
    "topic" + "_cluster",
    "replay_learning" + "_projection",
  ];
  for (const eventType of removedOutboxEvents) {
    assert.equal(writeAccessFile.includes(eventType), false, `write access should not expose removed outbox event ${eventType}`);
    assert.equal(writePostCommitFile.includes(eventType), false, `post-commit writes should not enqueue removed outbox event ${eventType}`);
  }
  assert.equal(writePostCommitFile.includes("after_" + "associative_link"), false, "post-commit writes should not keep embed follow-up payloads");
  assert.match(writeAccessFile, /export type WriteOutboxEventType =\s*\|\s*"associative_link"/);
  assert.match(workerFile, /drainLiteAssociativeLinkOutbox/);
  assert.match(workerFile, /eventType: "associative_link"/);
  assert.match(runtimeEntryFile, /startLiteAssociativeLinkWorker/);
  assert.match(runtimeEntryFile, /startLiteProjectionWorker/);
  assert.match(projectionStoreFile, /lite_memory_projection_jobs/);
  assert.equal(projectionStoreFile.includes("lite_memory_outbox"), false);
});

test("focused repo keeps Runtime source only and does not vendor adapter package sources", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "apps")), false, "apps wrapper surface should be absent");
  assert.equal(fs.existsSync(path.join(ROOT, "examples")), false, "example wrapper surface should be absent");
  assert.equal(fs.existsSync(path.join(ROOT, "packages")), false, "package sources belong in split package repos");
  assert.equal(fs.existsSync(path.join(ROOT, "claude-plugins")), false, "Claude Code plugin source belongs in the split plugin repo");
  assert.equal(fs.existsSync(path.join(ROOT, ".claude-plugin")), false, "Claude plugin marketplace metadata belongs in the split plugin repo");
});

test("root package stays Runtime-only and delegates adapters to external packages", () => {
  const packageJson = readJson("package.json");
  assert.equal(packageJson.workspaces, undefined);
  assert.equal(packageJson.scripts?.["sdk:source-sync"], undefined);
  assert.equal(packageJson.scripts?.["packages:build"], undefined);
  assert.equal(packageJson.scripts?.["packages:test"], undefined);
  assert.equal(packageJson.scripts?.["test:focused"], "npm run -s typecheck && npm run -s lite:test");
  assert.equal(packageJson.scripts?.["build"], "npm run -s typecheck");
  assert.equal(
    packageJson.scripts?.["runtime:smoke:external-packages"],
    "npx tsx scripts/e2e/external-package-entrypoint-smoke.ts",
  );
  assert.equal(
    packageJson.scripts?.["runtime:e2e:command-posture"],
    "npx tsx scripts/e2e/command-posture-product-loop.ts",
  );
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

test("focused package exposes developer quickstarts through the Runtime e2e surface", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts?.["runtime:quickstart:sdk"],
    "npx tsx scripts/e2e/developer-sdk-quickstart.ts",
  );
  assert.equal(
    packageJson.scripts?.["runtime:quickstart:multi-agent"],
    "npx tsx scripts/e2e/developer-multi-agent-quickstart.ts",
  );
  assert.equal(
    packageJson.scripts?.["runtime:quickstart:memory-firewall"],
    "npx tsx scripts/e2e/developer-memory-firewall-quickstart.ts",
  );
  assert.equal(
    packageJson.scripts?.["runtime:quickstart:flight-recorder"],
    "npx tsx scripts/e2e/developer-flight-recorder-quickstart.ts",
  );
  assert.equal(
    packageJson.scripts?.["runtime:smoke:external-packages"],
    "npx tsx scripts/e2e/external-package-entrypoint-smoke.ts",
  );
  assert.equal(
    packageJson.scripts?.["runtime:e2e:memory-firewall-ab"],
    "npx tsx scripts/e2e/memory-firewall-ab-demo.ts",
  );
  assert.equal(
    packageJson.scripts?.["runtime:e2e:flight-recorder-incident"],
    "npx tsx scripts/e2e/flight-recorder-incident-demo.ts",
  );
  assert.equal(
    packageJson.scripts?.["runtime:e2e:loop-engineering-profile"],
    "npx tsx scripts/e2e/loop-engineering-profile.ts",
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, "scripts", "e2e", "developer-sdk-quickstart.ts")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, "scripts", "e2e", "developer-multi-agent-quickstart.ts")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, "scripts", "e2e", "developer-memory-firewall-quickstart.ts")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, "scripts", "e2e", "developer-flight-recorder-quickstart.ts")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, "scripts", "e2e", "external-package-entrypoint-smoke.ts")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, "scripts", "e2e", "memory-firewall-ab-demo.ts")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, "scripts", "e2e", "flight-recorder-incident-demo.ts")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, "scripts", "e2e", "loop-engineering-profile.ts")),
    true,
  );
});

test("README quickstart examples stay aligned with product result contracts", () => {
  const packageJson = readJson("package.json");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const matrix = fs.readFileSync(path.join(ROOT, "docs", "AIONIS_QUICKSTART_MATRIX.md"), "utf8");
  assert.match(readme, /npm run -s runtime:quickstart:sdk/);
  assert.match(readme, /npm run -s runtime:quickstart:http/);
  assert.match(readme, /npm run -s runtime:quickstart:multi-agent/);
  assert.match(readme, /npm run -s runtime:quickstart:memory-firewall/);
  assert.match(readme, /npm run -s runtime:quickstart:flight-recorder/);
  assert.match(readme, /npm run -s runtime:smoke:external-packages/);
  assert.match(readme, /npm run -s runtime:e2e:memory-firewall-ab/);
  assert.match(readme, /npm run -s runtime:e2e:flight-recorder-incident/);
  assert.match(readme, /npm run -s runtime:e2e:loop-engineering-profile/);
  assert.match(readme, /docs\/AIONIS_QUICKSTART_MATRIX\.md/);
  assert.match(readme, /npm run -s runtime:e2e:judgment-calibration/);
  assert.match(readme, /docs\/examples\/sdk-quickstart-result\.json/);
  assert.match(readme, /docs\/examples\/http-quickstart-result\.json/);
  assert.match(readme, /docs\/examples\/multi-agent-quickstart-result\.json/);
  assert.match(readme, /docs\/examples\/memory-firewall-quickstart-result\.json/);
  assert.match(readme, /docs\/examples\/memory-firewall-ab-demo-result\.json/);
  assert.match(readme, /docs\/examples\/flight-recorder-quickstart-result\.json/);
  assert.match(readme, /docs\/examples\/flight-recorder-incident-demo-result\.json/);
  assert.match(readme, /docs\/examples\/loop-engineering-profile-result\.json/);
  assert.match(readme, /docs\/examples\/judgment-calibration-product-loop-result\.json/);
  assert.match(readme, /docs\/AIONIS_ADMISSION_DATASET_EXPORT_QUICKSTART\.md/);
  assert.match(readme, /@aionis\/mcp@latest/);
  assert.match(readme, /docs\/AIONIS_MCP\.md/);
  assert.match(readme, /docs\/AIONIS_CLAUDE_CODE_INTEGRATION\.md/);
  assert.match(readme, /claude mcp add --transport stdio/);
  assert.match(readme, /aionis_context/);
  assert.equal(packageJson.scripts?.["runtime:quickstart:sdk"], "npx tsx scripts/e2e/developer-sdk-quickstart.ts");
  assert.equal(
    packageJson.scripts?.["runtime:quickstart:http"],
    "npx tsx scripts/e2e/developer-http-quickstart.ts",
  );
  assert.equal(
    packageJson.scripts?.["runtime:quickstart:multi-agent"],
    "npx tsx scripts/e2e/developer-multi-agent-quickstart.ts",
  );
  assert.equal(
    packageJson.scripts?.["runtime:quickstart:memory-firewall"],
    "npx tsx scripts/e2e/developer-memory-firewall-quickstart.ts",
  );
  assert.equal(
    packageJson.scripts?.["runtime:quickstart:flight-recorder"],
    "npx tsx scripts/e2e/developer-flight-recorder-quickstart.ts",
  );
  assert.equal(
    packageJson.scripts?.["runtime:e2e:judgment-calibration"],
    "npx tsx scripts/e2e/judgment-calibration-product-loop.ts",
  );
  assert.equal(
    packageJson.scripts?.["runtime:e2e:memory-firewall-ab"],
    "npx tsx scripts/e2e/memory-firewall-ab-demo.ts",
  );
  assert.equal(
    packageJson.scripts?.["runtime:e2e:flight-recorder-incident"],
    "npx tsx scripts/e2e/flight-recorder-incident-demo.ts",
  );
  assert.equal(
    packageJson.scripts?.["runtime:e2e:loop-engineering-profile"],
    "npx tsx scripts/e2e/loop-engineering-profile.ts",
  );

  const sdk = readJson("docs/examples/sdk-quickstart-result.json");
  assert.equal(sdk.contract_version, "aionis_sdk_quickstart_result_v1");
  assert.equal(sdk.agent_context?.before_actionable_history_used, false);
  assert.equal(sdk.agent_context?.after_actionable_history_used, true);
  assert.equal(sdk.memory_governance?.measure_history_impact, "positive");
  assert.equal(sdk.admission_dataset_export?.contract_version, "aionis_memory_admission_dataset_row_v1");
  assert.equal(sdk.admission_dataset_export?.positive_use_count, 1);
  assert.equal(sdk.admission_dataset_export?.prompt_payload_excluded, true);
  assert.equal(sdk.operator_audit?.memory_use_receipt_visible, true);
  assert.equal(sdk.operator_audit?.memory_admission_record_visible, true);
  assert.equal(sdk.operator_audit?.snapshot_runtime_mutation, false);
  assert.equal(sdk.checks?.feedback_attributed, true);
  assert.equal(sdk.checks?.admission_dataset_feedback_joined, true);

  const http = readJson("docs/examples/http-quickstart-result.json");
  assert.equal(http.contract_version, "aionis_http_quickstart_result_v1");
  assert.equal(http.integration_path?.transport, "raw_http_fetch");
  assert.equal(http.agent_context?.before_actionable_history_used, false);
  assert.equal(http.agent_context?.after_actionable_history_used, true);
  assert.equal(http.memory_governance?.measure_history_impact, "positive");
  assert.equal(http.operator_audit?.snapshot_runtime_mutation, false);
  assert.equal(http.rehydration?.product_action, "rehydrate");
  assert.equal(http.rehydration?.changed_count, 1);
  assert.equal(http.checks?.rehydrate_product_route_used, true);
  assert.equal(http.checks?.rehydrate_moved_archive, true);

  const multiAgent = readJson("docs/examples/multi-agent-quickstart-result.json");
  assert.equal(multiAgent.contract_version, "aionis_multi_agent_quickstart_result_v1");
  assert.equal(multiAgent.agent_context?.before_actionable_history_used, false);
  assert.equal(multiAgent.agent_context?.after_actionable_history_used, true);
  assert.equal(multiAgent.memory_governance?.branch_isolation, "pass");
  assert.equal(multiAgent.memory_governance?.measure_history_impact, "positive");
  assert.equal(multiAgent.operator_audit?.memory_use_receipt_visible, true);
  assert.equal(multiAgent.checks?.reviewer_avoids_failed_branch, true);

  const firewall = readJson("docs/examples/memory-firewall-quickstart-result.json");
  assert.equal(firewall.contract_version, "aionis_memory_firewall_quickstart_result_v1");
  assert.equal(firewall.memory_firewall?.contract_version, "aionis_memory_firewall_summary_v1");
  assert.equal(firewall.memory_firewall?.unsafe_direct_use_count, 0);
  assert.equal(firewall.memory_firewall?.runtime_mutation, false);
  assert.equal(firewall.operator_audit?.memory_write_omitted, true);
  assert.equal(firewall.checks?.failed_memory_blocked, true);
  assert.equal(firewall.checks?.stale_memory_blocked, true);
  assert.equal(firewall.checks?.rehydrate_memory_pointer_only, true);

  const firewallAb = readJson("docs/examples/memory-firewall-ab-demo-result.json");
  assert.equal(firewallAb.contract_version, "aionis_memory_firewall_ab_demo_result_v1");
  assert.equal(firewallAb.arm_comparison?.raw_retrieval?.wrong_direct_use_rate, 66.7);
  assert.equal(firewallAb.arm_comparison?.raw_retrieval?.audit_coverage_rate, 0);
  assert.equal(firewallAb.arm_comparison?.aionis_memory_firewall?.wrong_direct_use_rate, 0);
  assert.equal(firewallAb.arm_comparison?.aionis_memory_firewall?.primary_route_chosen_rate, 100);
  assert.equal(firewallAb.arm_comparison?.aionis_memory_firewall?.audit_coverage_rate, 100);
  assert.equal(firewallAb.checks?.aionis_blocks_unsafe_direct_use, true);
  assert.equal(firewallAb.checks?.aionis_preserves_current_and_procedure_recall, true);
  assert.equal(firewallAb.checks?.aionis_adds_audit_coverage, true);

  const flightRecorder = readJson("docs/examples/flight-recorder-quickstart-result.json");
  assert.equal(flightRecorder.contract_version, "aionis_flight_recorder_quickstart_result_v1");
  assert.equal(flightRecorder.agent_view?.prompt_text_included, false);
  assert.equal(flightRecorder.incident_replay?.runtime_mutation, false);
  assert.equal(flightRecorder.replay_sources?.has_memory_admission_record, true);
  assert.equal(flightRecorder.checks?.blocked_memory_replayed, true);
  assert.equal(flightRecorder.checks?.feedback_attribution_replayed, true);

  const flightRecorderIncident = readJson("docs/examples/flight-recorder-incident-demo-result.json");
  assert.equal(flightRecorderIncident.contract_version, "aionis_flight_recorder_incident_demo_result_v1");
  assert.equal(flightRecorderIncident.summary?.scenario_count, 3);
  assert.equal(flightRecorderIncident.summary?.prompt_payload_excluded_count, 3);
  assert.equal(flightRecorderIncident.summary?.runtime_mutation_count, 0);
  assert.equal(flightRecorderIncident.summary?.blocked_memory_misuse_detected_count, 1);
  assert.equal(flightRecorderIncident.summary?.missing_feedback_detected_count, 1);
  assert.equal(flightRecorderIncident.checks?.blocked_memory_misuse_detected, true);
  assert.equal(flightRecorderIncident.checks?.missing_feedback_detected, true);
  assert.equal(flightRecorderIncident.checks?.prompt_payload_excluded, true);
  assert.equal(flightRecorderIncident.checks?.no_runtime_mutation, true);

  const loopProfile = readJson("docs/examples/loop-engineering-profile-result.json");
  assert.equal(loopProfile.contract_version, "aionis_loop_engineering_profile_result_v1");
  assert.equal(loopProfile.loop_profile?.host_executes_loop, true);
  assert.equal(loopProfile.loop_profile?.aionis_executes_tools, false);
  assert.equal(loopProfile.loop_profile?.iterations_observed, 2);
  assert.equal(loopProfile.loop_state?.before_actionable_history_used, false);
  assert.equal(loopProfile.loop_state?.after_actionable_history_used, true);
  assert.equal(loopProfile.loop_state?.measure_changed_future_behavior, true);
  assert.equal(loopProfile.loop_state?.measure_workflow_reuse_outcome, "success");
  assert.equal(loopProfile.checks?.passed_iteration_reused, true);
  assert.equal(loopProfile.checks?.failed_iteration_avoided, true);
  assert.equal(loopProfile.checks?.prompt_payload_excluded_from_audit, true);

  const calibration = readJson("docs/examples/judgment-calibration-product-loop-result.json");
  assert.equal(calibration.contract_version, "aionis_judgment_calibration_product_loop_result_v1");
  assert.deepEqual(calibration.judgment_calibration?.supported_memory_ids, ["mem_supported_example"]);
  assert.deepEqual(calibration.judgment_calibration?.unused_memory_ids, ["mem_unused_example"]);
  assert.equal(calibration.operator_audit?.trace_calibration_read_only, true);
  assert.equal(calibration.operator_audit?.snapshot_calibration_visible, true);
  assert.equal(calibration.checks?.feedback_attributes_only_used_memory, true);
  assert.equal(calibration.checks?.unreported_memory_is_unused_not_negative, true);

  for (const command of [
    "npm run -s runtime:quickstart:sdk",
    "npm run -s runtime:quickstart:http",
    "npm run -s runtime:quickstart:multi-agent",
    "npm run -s runtime:quickstart:memory-firewall",
    "npm run -s runtime:quickstart:flight-recorder",
    "npm run -s runtime:smoke:external-packages",
    "npm run -s runtime:e2e:memory-firewall-ab",
    "npm run -s runtime:e2e:flight-recorder-incident",
    "npm run -s runtime:e2e:loop-engineering-profile",
    "npm run -s runtime:e2e:golden-product-loop",
    "npm run -s runtime:e2e:judgment-calibration",
    "npm run -s runtime:e2e:ordinary-memory",
  ]) {
    assert.match(matrix, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(matrix, /aionis_sdk_quickstart_result_v1/);
  assert.match(matrix, /aionis_http_quickstart_result_v1/);
  assert.match(matrix, /aionis_multi_agent_quickstart_result_v1/);
  assert.match(matrix, /aionis_memory_firewall_quickstart_result_v1/);
  assert.match(matrix, /aionis_memory_firewall_ab_demo_result_v1/);
  assert.match(matrix, /aionis_flight_recorder_quickstart_result_v1/);
  assert.match(matrix, /aionis_flight_recorder_incident_demo_result_v1/);
  assert.match(matrix, /aionis_loop_engineering_profile_result_v1/);
  assert.match(matrix, /SDK facade/);
  assert.match(matrix, /AIONIS_ADMISSION_DATASET_EXPORT_QUICKSTART\.md/);
  assert.match(matrix, /Raw HTTP/);
  assert.match(matrix, /execution memory adapter/i);
  assert.match(matrix, /agent_context\.prompt_text/);
  assert.match(matrix, /guide_trace_id/);
});

test("README and positioning docs keep the external product language stable", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const positioning = fs.readFileSync(path.join(ROOT, "docs", "AIONIS_PRODUCT_POSITIONING.md"), "utf8");
  const architecture = fs.readFileSync(path.join(ROOT, "docs", "AIONIS_RUNTIME_ARCHITECTURE.md"), "utf8");

  assert.match(readme, /Compact, governed execution memory/);
  assert.match(readme, /Memory is not recall\. Memory is executable state\./);
  assert.match(readme, /Why Teams Use Aionis/);
  assert.match(readme, /Architecture Overview/);
  assert.match(readme, /docs\/AIONIS_RUNTIME_ARCHITECTURE\.md/);
  assert.match(readme, /Aionis vs Recall Memory/);
  assert.match(readme, /docs\/AIONIS_PRODUCT_POSITIONING\.md/);

  assert.match(architecture, /Product Path/);
  assert.match(architecture, /Execution memory is Aionis's main moat/);
  assert.match(architecture, /Context Compiler/);
  assert.match(architecture, /Controlled Forgetting and Rehydration/);
  assert.match(architecture, /Source Map/);

  assert.match(positioning, /state-adjudicated memory runtime/);
  assert.match(positioning, /not recall-only memory/i);
  assert.match(positioning, /execution memory/i);
  assert.match(positioning, /state-preserving, execution-ready context/i);
  assert.match(positioning, /auditable memory use receipts/i);
  assert.match(positioning, /guaranteed external task success/);
});

test("README and product API docs keep developer entrypoints product-shaped", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const apiUsage = fs.readFileSync(path.join(ROOT, "docs", "AIONIS_PRODUCT_API_USAGE.md"), "utf8");
  const productContract = fs.readFileSync(path.join(ROOT, "docs", "AIONIS_PRODUCT_CONTRACT.md"), "utf8");
  const installDoc = fs.readFileSync(path.join(ROOT, "docs", "AIONIS_INSTALL.md"), "utf8");
  const mcpDoc = fs.readFileSync(path.join(ROOT, "docs", "AIONIS_MCP.md"), "utf8");
  const claudeCodeIntegration = fs.readFileSync(
    path.join(ROOT, "docs", "AIONIS_CLAUDE_CODE_INTEGRATION.md"),
    "utf8",
  );
  const quickstartMatrix = fs.readFileSync(path.join(ROOT, "docs", "AIONIS_QUICKSTART_MATRIX.md"), "utf8");
  const sdkQuickstart = fs.readFileSync(path.join(ROOT, "docs", "AIONIS_SDK_QUICKSTART.md"), "utf8");
  const httpQuickstart = fs.readFileSync(path.join(ROOT, "docs", "AIONIS_HTTP_QUICKSTART.md"), "utf8");
  const forgetQuickstart = fs.readFileSync(path.join(ROOT, "docs", "AIONIS_CONTROLLED_FORGETTING_QUICKSTART.md"), "utf8");
  const minimalAgentExample = fs.readFileSync(path.join(ROOT, "docs", "examples", "minimal-agent.ts"), "utf8");

  for (const text of [readme, apiUsage, productContract]) {
    assert.match(text, /\/v1\/feedback/);
    assert.match(text, /\/v1\/forget/);
    assert.match(text, /\/v1\/rehydrate/);
  }

  assert.match(readme, /docs\/AIONIS_HTTP_QUICKSTART\.md/);
  assert.match(readme, /docs\/AIONIS_QUICKSTART_MATRIX\.md/);
  assert.match(readme, /docs\/AIONIS_INSTALL\.md/);
  assert.match(readme, /docs\/AIONIS_MCP\.md/);
  assert.match(readme, /npx aionis setup/);
  assert.match(readme, /npx @aionis\/mcp@latest/);
  assert.match(readme, /claude mcp add --transport stdio/);
  assert.match(readme, /docs\/AIONIS_MCP\.md/);
  assert.match(readme, /docs\/AIONIS_CLAUDE_CODE_INTEGRATION\.md/);
  assert.match(readme, /aionis_context/);
  assert.match(readme, /from "@aionis\/sdk"/);
  assert.match(readme, /aionis\.execution\.observeStep/);
  assert.match(readme, /docs\/examples\/minimal-agent\.ts/);
  assert.match(readme, /docs\/AIONIS_CONTROLLED_FORGETTING_QUICKSTART\.md/);
  assert.match(readme, /Controlled forgetting is a core Aionis capability/);
  assert.match(readme, /\/v1\/operator\/snapshot/);
  assert.match(apiUsage, /AIONIS_HTTP_QUICKSTART\.md/);
  assert.match(apiUsage, /AIONIS_QUICKSTART_MATRIX\.md/);
  assert.match(apiUsage, /AIONIS_INSTALL\.md/);
  assert.match(apiUsage, /from "@aionis\/sdk"/);
  assert.match(apiUsage, /AIONIS_CONTROLLED_FORGETTING_QUICKSTART\.md/);
  assert.match(apiUsage, /Controlled forgetting is a core Aionis capability/);
  assert.match(apiUsage, /explicit lifecycle-control API/);
  assert.match(apiUsage, /`feedback\(\)` posts\s+to `\/v1\/feedback`/);
  assert.match(apiUsage, /`rehydrate\(\)` posts to `\/v1\/rehydrate`/);
  assert.match(apiUsage, /`snapshot\(\)` is a\s+short alias for `\/v1\/operator\/snapshot`/);
  assert.match(apiUsage, /feedbackFromGuide\(\)/);
  assert.match(apiUsage, /measureInputFromGuideLoop\(\)/);
  assert.match(apiUsage, /snapshotInputFromGuideLoop\(\)/);
  assert.match(productContract, /`POST \/v1\/feedback` is the normal HTTP product entry/);
  assert.match(productContract, /Forget is a core Aionis capability/);
  assert.match(productContract, /`POST \/v1\/forget` is the explicit lifecycle-control API/);
  assert.match(quickstartMatrix, /Stable Product Boundary/);
  assert.match(quickstartMatrix, /npx aionis setup/);
  assert.match(quickstartMatrix, /@aionis\/create/);
  assert.match(quickstartMatrix, /npx @aionis\/mcp@latest/);
  assert.match(quickstartMatrix, /MCP stdio/);
  assert.match(quickstartMatrix, /Measure and operator snapshot are read-only product surfaces/);
  assert.match(sdkQuickstart, /`snapshot\(\)` exposes read-only memory use receipt/);
  assert.match(sdkQuickstart, /from "@aionis\/sdk"/);
  assert.match(sdkQuickstart, /feedbackFromGuide\(\)/);
  assert.match(sdkQuickstart, /measureInputFromGuideLoop\(\)/);
  assert.match(sdkQuickstart, /snapshotInputFromGuideLoop\(\)/);
  assert.match(sdkQuickstart, /aionis\.execution\.observeStep/);
  assert.match(sdkQuickstart, /aionis\.execution\.guideAgentContextForRole/);
  assert.match(sdkQuickstart, /examples\/minimal-agent\.ts/);
  assert.match(installDoc, /@aionis\/mcp/);
  assert.match(installDoc, /AIONIS_MCP\.md/);
  assert.match(installDoc, /claude mcp add --transport stdio/);
  assert.match(installDoc, /AIONIS_CLAUDE_CODE_INTEGRATION\.md/);
  assert.match(mcpDoc, /aionis_context/);
  assert.match(mcpDoc, /aionis_record_step/);
  assert.match(mcpDoc, /aionis_flight_recorder/);
  assert.match(mcpDoc, /Drop-In Mode/);
  assert.match(mcpDoc, /@aionis\/sdk/);
  assert.match(mcpDoc, /Claude Code/);
  assert.match(mcpDoc, /claude mcp add --transport stdio/);
  assert.match(mcpDoc, /AIONIS_CLAUDE_CODE_INTEGRATION\.md/);
  assert.match(claudeCodeIntegration, /npx aionis setup \.aionis-runtime[\s\S]*--with-claude-code/);
  assert.match(claudeCodeIntegration, /\/plugin marketplace add https:\/\/github\.com\/ostinatocc\/aionis-claude-code/);
  assert.match(claudeCodeIntegration, /\/plugin install aionis@aionis-claude-code/);
  assert.match(claudeCodeIntegration, /\/aionis:onboard/);
  assert.match(claudeCodeIntegration, /SessionStart/);
  assert.match(claudeCodeIntegration, /UserPromptSubmit/);
  assert.match(claudeCodeIntegration, /PostToolUse/);
  assert.match(claudeCodeIntegration, /PostCompact/);
  assert.match(claudeCodeIntegration, /aionis_context/);
  assert.match(claudeCodeIntegration, /aionis_record_step/);
  assert.match(claudeCodeIntegration, /aionis_flight_recorder/);
  assert.doesNotMatch(sdkQuickstart, /`operatorSnapshot\(\)` exposes/);
  assert.match(minimalAgentExample, /from "@aionis\/sdk"/);
  assert.match(minimalAgentExample, /aionis\.execution\.observeStep/);
  assert.match(minimalAgentExample, /aionis\.execution\.feedbackFromOutcome/);
  assert.match(minimalAgentExample, /aionis\.execution\.snapshotRun/);

  assert.match(httpQuickstart, /observe -> guide -> agent action -> feedback -> measure -> snapshot/);
  assert.match(httpQuickstart, /npm run -s runtime:quickstart:http/);
  assert.match(httpQuickstart, /curl -sS -X POST "\$AIONIS_URL\/v1\/feedback"/);
  assert.match(httpQuickstart, /curl -sS -X POST "\$AIONIS_URL\/v1\/rehydrate"/);
  assert.match(httpQuickstart, /curl -sS -X POST "\$AIONIS_URL\/v1\/operator\/snapshot"/);
  assert.match(httpQuickstart, /product_trace/);
  assert.match(httpQuickstart, /memory_decision_trace/);
  assert.doesNotMatch(httpQuickstart, /operation=activate/);

  assert.match(forgetQuickstart, /Forget is a core Aionis capability/);
  assert.match(forgetQuickstart, /\/v1\/forget/);
  assert.match(forgetQuickstart, /operation\\\": \\\"suppress\\\"/);
  assert.match(forgetQuickstart, /operation\\\": \\\"unsuppress\\\"/);
  assert.match(forgetQuickstart, /product_trace/);
  assert.match(forgetQuickstart, /forget_result/);
  assert.match(forgetQuickstart, /explicit\s+lifecycle-control API/);
  assert.doesNotMatch(`${readme}\n${apiUsage}\n${productContract}\n${forgetQuickstart}`, /compatibility-only/i);
  assert.doesNotMatch(`${readme}\n${apiUsage}\n${productContract}\n${forgetQuickstart}`, /deprecated/i);
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
  assert.match(serverFile, /assertLocalStoreRuntimeEdition/);
  assert.match(serverFile, /args\.env\.AIONIS_EDITION === "lite"/);
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
  assert.match(runtimeServicesFile, /import type \{ RuntimeConfig \} from "\.\.\/config\/runtime-config\.js"/);
  assert.match(runtimeServicesFile, /export type RuntimeServiceConfig = Pick</);
  assert.match(runtimeServicesFile, /const \{ runtime, storage, recall, limits, sandbox, providers \} = config/);
  assert.match(runtimeServicesFile, /assertLocalStoreRuntimeEdition\(runtime, "local-store runtime services"\)/);
  assert.match(runtimeServicesFile, /createEmbeddingProviders\(providers\.embedding\)/);
  assert.equal(runtimeServicesFile.includes("process.env"), false, "runtime services should consume resolved config only");
});

test("request guards keep lite posture while excluding control-plane auth and tenant quota plumbing", () => {
  const requestGuardsFile = fs.readFileSync(path.join(ROOT, "src", "app", "request-guards.ts"), "utf8");
  const runtimeEntryFile = fs.readFileSync(path.join(ROOT, "src", "runtime-entry.ts"), "utf8");
  const runtimeServicesFile = fs.readFileSync(path.join(ROOT, "src", "app", "runtime-services.ts"), "utf8");
  const forbiddenSymbols = [
    "recordControlAuditEvent",
    "emitControlAudit",
    "resolveControlPlaneApiKeyPrincipal",
    "tenantQuotaResolver",
    "assertIdentityMatch",
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(requestGuardsFile.includes(symbol), false, `${symbol} should be absent from lite request-guards`);
    assert.equal(runtimeEntryFile.includes(symbol), false, `${symbol} should not be passed through lite runtime-entry`);
    assert.equal(runtimeServicesFile.includes(symbol), false, `${symbol} should be absent from lite runtime-services`);
  }
  assert.match(requestGuardsFile, /aionis-lite request guards only support MEMORY_AUTH_MODE=off/);
  assert.match(requestGuardsFile, /aionis-lite request guards only support TENANT_QUOTA_ENABLED=false/);
  assert.match(requestGuardsFile, /aionis-server request guards require MEMORY_AUTH_MODE=api_key, jwt, or api_key_or_jwt/);
  assert.match(requestGuardsFile, /const \{ runtime, governance, limits \} = config/);
  assert.equal(requestGuardsFile.includes("process.env"), false, "request guards should consume resolved config only");
  assert.match(runtimeEntryFile, /const \{ env, config: runtimeConfig \} = loadRuntimeConfig\(\{ \.\.\.process\.env \}\)/);
  assert.match(runtimeEntryFile, /createRuntimeServices\(runtimeConfig\)/);
  assert.match(runtimeEntryFile, /createRequestGuards\(\{\s*config: runtimeConfig,/);
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
  assert.equal(httpObservabilityFile.includes("process.env"), false, "HTTP helpers should consume captured Runtime config");
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
  assert.match(memoryAccessFile, /assertLocalStoreRuntimeEdition\(args\.env, "local-store memory-access routes"\)/);
  assert.match(memoryAccessFile, /\/v1\/memory\/resolve/);
  for (const retiredPath of [
    "/v1/memory/find",
    "/v1/memory/agent/inspect",
    "/v1/memory/action/retrieval",
    "/v1/execution/context/assemble",
  ]) {
    assert.equal(memoryAccessFile.includes(retiredPath), false, `${retiredPath} must not remain in the production adapter`);
  }
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

test("retired memory-feedback-tools adapter is absent while LearningKernel remains typed", () => {
  const adapterPath = path.join(ROOT, "src", "routes", "memory-feedback-tools.ts");
  const feedbackFile = fs.readFileSync(path.join(ROOT, "src", "memory", "feedback.ts"), "utf8");
  const learningKernelFile = fs.readFileSync(path.join(ROOT, "src", "kernel", "learning-kernel.ts"), "utf8");
  const serverFile = fs.readFileSync(path.join(ROOT, "src", "server", "http-server.ts"), "utf8");
  assert.equal(fs.existsSync(adapterPath), false);
  assert.equal(serverFile.includes("registerMemoryFeedbackToolRoutes"), false);
  assert.equal(serverFile.includes("../routes/memory-feedback-tools.js"), false);
  assert.match(learningKernelFile, /export function createLearningKernel/);
  assert.match(learningKernelFile, /selectToolWithLearnedMemory/);
  assert.match(learningKernelFile, /recordToolSelectionFeedback/);
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

test("retired memory-recall adapter is absent while typed recall remains", () => {
  const adapterPath = path.join(ROOT, "src", "routes", "memory-recall.ts");
  const memoryRecallFile = fs.readFileSync(path.join(ROOT, "src", "memory", "recall.ts"), "utf8");
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
    assert.equal(memoryRecallFile.includes(symbol), false, `${symbol} should be absent from typed memory recall`);
  }
  assert.equal(fs.existsSync(adapterPath), false);
  assert.equal(serverFile.includes("registerMemoryRecallRoutes"), false);
  assert.equal(serverFile.includes("../routes/memory-recall.js"), false);
  assert.match(memoryRecallFile, /export async function memoryRecallParsed/);
  assert.match(memoryRecallFile, /memoryRecallParsed requires explicit recall_access/);
});

test("memory planning context service does not keep store-client recall plumbing", () => {
  const memoryContextRuntimeFile = fs.readFileSync(path.join(ROOT, "src", "routes", "memory-context-runtime.ts"), "utf8");
  const serverFile = fs.readFileSync(path.join(ROOT, "src", "server", "http-server.ts"), "utf8");
  const forbiddenSymbols = [
    "type StoreLike",
    "store.withClient",
    "recallAccessForClient",
    "liteModeActive",
  ];
  for (const symbol of forbiddenSymbols) {
    assert.equal(memoryContextRuntimeFile.includes(symbol), false, `${symbol} should be absent from memory planning context service`);
  }
  assert.equal(serverFile.includes("registerMemoryContextRuntimeRoutes"), false);
  assert.match(memoryContextRuntimeFile, /export function createMemoryPlanningContextService/);
  assert.match(memoryContextRuntimeFile, /assertLocalStoreRuntimeEdition\(env, "local-store memory planning context service"\)/);
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
  assert.match(handoffFile, /assertLocalStoreRuntimeEdition\(env, "local-store handoff routes"\)/);
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
  assert.equal(serverFile.includes("registerMemoryWriteRoutes"), false, "Runtime must use MemoryWriteRouteService without registering its internal HTTP route");
  assert.equal(memoryWriteFile.includes("registerMemoryWriteRoutes"), false, "production write module must not retain the retired HTTP adapter");
  assert.equal(memoryWriteFile.includes("/v1/memory/write"), false, "production write module must expose only the typed service");
  assert.equal(memoryWriteFile.includes("from \"fastify\""), false, "typed write service must not depend on Fastify");
  assert.equal(runtimeEntryFile.includes("runTopicClusterForEventIds"), false, "lite runtime-entry should not inject server topic clustering into write routes");
  assert.match(memoryWriteFile, /assertLocalStoreRuntimeEdition\(env, "local-store memory-write route"\)/);
});

test("lite prepared write commit uses store access directly instead of a placeholder pg client", () => {
  const commitFile = fs.readFileSync(path.join(ROOT, "src", "memory", "lite-projected-write-commit.ts"), "utf8");
  const writeFile = fs.readFileSync(path.join(ROOT, "src", "memory", "write.ts"), "utf8");
  assert.equal(commitFile.includes("import type pg from \"pg\""), false, "lite projected write commit should not import pg");
  assert.equal(commitFile.includes("{} as pg.PoolClient"), false, "lite projected write commit should not use a placeholder pg client");
  assert.match(commitFile, /applyPreparedMemoryWrite\(args\.liteWriteStore, args\.prepared/);
  assert.match(writeFile, /export async function applyPreparedMemoryWrite/);
});

test("product lifecycle service replaces internal memory lifecycle HTTP routes", () => {
  const serverFile = fs.readFileSync(path.join(ROOT, "src", "server", "http-server.ts"), "utf8");
  const liteEditionFile = fs.readFileSync(path.join(ROOT, "src", "server", "lite-runtime-boundary.ts"), "utf8");
  const lifecycleServiceFile = fs.readFileSync(path.join(ROOT, "src", "product", "lifecycle-service.ts"), "utf8");
  assert.equal(fs.existsSync(path.join(ROOT, "src", "routes", "memory-lifecycle-lite.ts")), false);
  assert.equal(serverFile.includes("registerMemoryLifecycleRoutes"), false, "lite runtime server should not register PG-only memory lifecycle routes");
  assert.equal(serverFile.includes("registerLiteMemoryLifecycleRoutes"), false);
  assert.equal(liteEditionFile.includes("/v1/memory/archive/rehydrate"), false);
  assert.equal(liteEditionFile.includes("/v1/memory/nodes/activate"), false);
  assert.match(lifecycleServiceFile, /rehydrateArchiveNodesLite/);
  assert.match(lifecycleServiceFile, /activateMemoryNodesLite/);
});

test("retired memory-replay-learning-control HTTP adapter is absent while typed replay capabilities remain", () => {
  const serverFile = fs.readFileSync(path.join(ROOT, "src", "server", "http-server.ts"), "utf8");
  const replayFile = fs.readFileSync(path.join(ROOT, "src", "memory", "replay.ts"), "utf8");
  assert.equal(fs.existsSync(path.join(ROOT, "src", "routes", "memory-replay-learning-control.ts")), false);
  assert.equal(serverFile.includes("registerMemoryReplayLearningControlRoutes"), false, "Runtime must not register retired replay learning-control HTTP routes");
  assert.match(replayFile, /export async function replayPlaybookRepairReview/);
  assert.match(replayFile, /export async function replayPlaybookRun/);
  assert.match(replayFile, /export async function replayPlaybookDispatch/);
});

test("retired memory-replay-core HTTP adapter is absent while typed replay capabilities remain", () => {
  const serverFile = fs.readFileSync(path.join(ROOT, "src", "server", "http-server.ts"), "utf8");
  const replayFile = fs.readFileSync(path.join(ROOT, "src", "memory", "replay.ts"), "utf8");
  assert.equal(fs.existsSync(path.join(ROOT, "src", "routes", "memory-replay-core.ts")), false);
  assert.equal(serverFile.includes("registerMemoryReplayCoreRoutes"), false, "Runtime must not register retired replay core HTTP routes");
  assert.match(replayFile, /export async function replayRunStart/);
  assert.match(replayFile, /export async function replayStepBefore/);
  assert.match(replayFile, /export async function replayStepAfter/);
  assert.match(replayFile, /export async function replayRunEnd/);
});

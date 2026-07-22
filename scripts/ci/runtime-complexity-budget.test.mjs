import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  COMPLEXITY_HARD_THRESHOLD_METRICS,
  COMPLEXITY_OBSERVATION_METRICS,
  canonicalJson,
  classifyResourcePath,
  classifyScriptPath,
  classifyToolPath,
  classifyV1SourcePath,
  collectRuntimeComplexity,
  complexityMetricValues,
  isDaemonForbiddenCapabilityPath,
  relativeModuleSpecifiersFromText,
  runtimeModuleSpecifiersFromText,
} from "./runtime-complexity-budget.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COLLECTOR = path.join(ROOT, "scripts", "ci", "runtime-complexity-budget.mjs");
const BUDGET = path.join(ROOT, "docs", "architecture", "runtime-complexity-budget.json");
const CODE_EXTENSIONS = Object.freeze(["ts", "tsx", "mts", "cts", "js", "mjs", "cjs"]);
const ENTRY_PATHS = Object.freeze({
  daemon: "src/runtime-v1/daemon-entry.ts",
  provisioning: "src/runtime-v1/provisioning-entry.ts",
  sdk: "src/runtime-v1/sdk.ts",
  worker: "src/runtime-v1/worker-entry.ts",
});
const EXACT_THRESHOLD_METRICS = new Set([
  "daemon_environment_field_count",
  "worker_environment_field_count",
  "provisioning_environment_field_count",
  "environment_inventory_source_files",
  "environment_field_union_count",
  "v1_resource_files",
  "public_route_count",
  "probe_route_count",
  "route_inventory_source_files",
  "schema_table_count",
]);

function runCollector(args = []) {
  return spawnSync(process.execPath, [COLLECTOR, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function gitInventory(...patterns) {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", ...patterns],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, GIT_GLOB_PATHSPECS: "1" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return [...new Set(result.stdout.split(/\r?\n/u)
    .filter((relativePath) => relativePath.length > 0
      && fs.existsSync(path.join(ROOT, relativePath))))].sort();
}

function countLines(source) {
  if (source.length === 0) return 0;
  return (source.match(/\n/gu)?.length ?? 0) + (source.endsWith("\n") ? 0 : 1);
}

function inventoryLines(paths) {
  return paths.reduce((total, relativePath) => total
    + countLines(fs.readFileSync(path.join(ROOT, relativePath), "utf8")), 0);
}

function largestInventoryFile(paths) {
  return paths.reduce((maximum, relativePath) => Math.max(
    maximum,
    countLines(fs.readFileSync(path.join(ROOT, relativePath), "utf8")),
  ), 0);
}

function budgetMetricsDigest(budget) {
  return createHash("sha256").update(canonicalJson({
    observations: budget.observations,
    thresholds: budget.thresholds,
  })).digest("hex");
}

function assertSha256(value, label) {
  assert.match(value, /^[0-9a-f]{64}$/u, `${label} must be a sha256 digest`);
}

function assertCycleInventory(cycles) {
  assert.equal(Array.isArray(cycles), true);
  for (const component of cycles) {
    assert.equal(Array.isArray(component), true);
    assert.equal(component.length > 0, true);
    assert.deepEqual(component, [...component].sort());
    for (const relativePath of component) {
      assert.equal(classifyV1SourcePath(relativePath), "v1_source");
    }
  }
  assert.deepEqual(cycles, [...cycles].sort((left, right) =>
    left.join("\0").localeCompare(right.join("\0"))));
}

function assertLargestInventory(entries, maximum) {
  assert.equal(Array.isArray(entries), true);
  assert.equal(entries.length > 0, true);
  const expectedOrder = [...entries].sort((left, right) =>
    right.lines - left.lines || left.path.localeCompare(right.path));
  assert.deepEqual(entries, expectedOrder);
  assert.equal(entries[0].lines, maximum);
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["lines", "path"]);
    assert.equal(Number.isSafeInteger(entry.lines), true);
    assert.equal(entry.lines > 0, true);
    assert.equal(classifyV1SourcePath(entry.path), "v1_source");
  }
}

function assertReportShape(report) {
  assert.deepEqual(Object.keys(report).sort(), [
    "daemon_environment_field_count",
    "daemon_forbidden_capability_paths",
    "entry_closures",
    "environment_field_union",
    "environment_field_union_count",
    "environment_inventory_source_files",
    "environment_inventory_source_paths",
    "largest_production_files",
    "largest_v1_source_files",
    "largest_v1_test_files",
    "legacy_presence",
    "mode",
    "probe_route_count",
    "provisioning_environment_field_count",
    "public_route_count",
    "route_inventory_source_files",
    "route_inventory_source_paths",
    "schema_table_count",
    "schema_version",
    "v1_full_type_dependency_sccs",
    "v1_gate_files",
    "v1_gate_lines",
    "v1_largest_production_file_lines",
    "v1_largest_source_file_lines",
    "v1_largest_test_file_lines",
    "v1_largest_tool_file_lines",
    "v1_nonproduction_source_files",
    "v1_nonproduction_source_lines",
    "v1_production_runtime_import_cycles",
    "v1_production_union_source_files",
    "v1_production_union_source_lines",
    "v1_production_union_source_sha256",
    "v1_resource_files",
    "v1_resource_lines",
    "v1_resource_sha256",
    "v1_test_artifact_files",
    "v1_test_artifact_lines",
    "v1_test_files",
    "v1_test_lines",
    "v1_test_sha256",
    "v1_tool_files",
    "v1_tool_lines",
    "v1_tool_sha256",
    "v1_total_runtime_import_cycles",
    "v1_total_source_files",
    "v1_total_source_lines",
    "v1_total_source_sha256",
    "worker_environment_field_count",
  ]);
  assert.equal(report.schema_version, "aionis_runtime_v1_complexity_report_v2");
  assert.equal(report.mode, "v1_inventory");

  assert.deepEqual(Object.keys(report.entry_closures).sort(), Object.keys(ENTRY_PATHS).sort());
  for (const [name, expectedPath] of Object.entries(ENTRY_PATHS)) {
    const closure = report.entry_closures[name];
    assert.deepEqual(Object.keys(closure).sort(), [
      "entry_path",
      "source_files",
      "source_lines",
      "source_sha256",
    ]);
    assert.equal(closure.entry_path, expectedPath);
    assert.equal(Number.isSafeInteger(closure.source_files), true);
    assert.equal(Number.isSafeInteger(closure.source_lines), true);
    assert.equal(closure.source_files > 0, true);
    assert.equal(closure.source_lines > 0, true);
    assert.equal(closure.source_files <= report.v1_production_union_source_files, true);
    assert.equal(closure.source_lines <= report.v1_production_union_source_lines, true);
    assertSha256(closure.source_sha256, `${name} closure`);
  }

  assert.equal(report.daemon_environment_field_count, 13);
  assert.equal(report.worker_environment_field_count, 16);
  assert.equal(report.provisioning_environment_field_count, 4);
  assert.equal(report.environment_inventory_source_files, 3);
  assert.equal(report.environment_field_union_count, 24);
  assert.equal(
    new Set(report.environment_field_union).size,
    report.environment_field_union_count,
  );
  assert.deepEqual(report.environment_field_union, [...report.environment_field_union].sort());
  assert.equal(
    report.environment_field_union.every((field) => /^AIONIS_[A-Z0-9_]+$/u.test(field)),
    true,
  );
  assert.deepEqual(report.environment_inventory_source_paths, [
    "src/runtime-v1/config.ts",
    "src/runtime-v1/provisioning-config.ts",
    "src/runtime-v1/worker-config.ts",
  ]);
  assert.deepEqual(report.daemon_forbidden_capability_paths, []);

  const metrics = complexityMetricValues(report);
  for (const [name, value] of Object.entries(metrics)) {
    assert.equal(Number.isSafeInteger(value), true, `${name} must be a safe integer`);
    assert.equal(value >= 0, true, `${name} must be non-negative`);
  }
  assert.equal(
    report.v1_production_union_source_files + report.v1_nonproduction_source_files,
    report.v1_total_source_files,
  );
  assert.equal(
    report.v1_production_union_source_lines + report.v1_nonproduction_source_lines,
    report.v1_total_source_lines,
  );
  assert.equal(report.v1_test_files + report.v1_gate_files, report.v1_test_artifact_files);
  assert.equal(report.v1_test_lines + report.v1_gate_lines, report.v1_test_artifact_lines);
  for (const [value, label] of [
    [report.v1_production_union_source_sha256, "production union"],
    [report.v1_total_source_sha256, "total source"],
    [report.v1_test_sha256, "tests"],
    [report.v1_tool_sha256, "tools"],
    [report.v1_resource_sha256, "resources"],
  ]) assertSha256(value, label);

  assert.deepEqual(report.v1_production_runtime_import_cycles, []);
  assert.deepEqual(report.v1_total_runtime_import_cycles, []);
  assertCycleInventory(report.v1_full_type_dependency_sccs);
  assertLargestInventory(
    report.largest_production_files,
    report.v1_largest_production_file_lines,
  );
  assertLargestInventory(report.largest_v1_source_files, report.v1_largest_source_file_lines);
  assert.equal(Array.isArray(report.largest_v1_test_files), true);
  assert.equal(report.largest_v1_test_files[0].lines, report.v1_largest_test_file_lines);

  assert.equal(report.public_route_count, 5);
  assert.equal(report.probe_route_count, 2);
  assert.equal(report.route_inventory_source_files, 1);
  assert.deepEqual(report.route_inventory_source_paths, ["src/runtime-v1/http-surface.ts"]);
  assert.equal(report.schema_table_count, 17);
  assert.equal(report.v1_resource_files, 4);
  assert.equal(report.v1_gate_files > 0, true);
  assert.equal(report.v1_tool_files > 0, true);

  assert.deepEqual(Object.keys(report.legacy_presence).sort(), [
    "inventory_sha256",
    "resource_files",
    "resource_lines",
    "script_files",
    "script_lines",
    "source_files",
    "source_lines",
    "tool_files",
    "tool_lines",
    "total_files",
  ]);
  assert.equal(report.legacy_presence.total_files,
    report.legacy_presence.source_files
      + report.legacy_presence.script_files
      + report.legacy_presence.tool_files
      + report.legacy_presence.resource_files);
  assertSha256(report.legacy_presence.inventory_sha256, "legacy inventory");
}

test("V1 collector emits deterministic runtime-closure metrics from one public surface", () => {
  const first = runCollector();
  assert.equal(first.status, 0, first.stderr);
  const second = runCollector();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);

  const report = JSON.parse(first.stdout);
  assertReportShape(report);

  const sourcePaths = gitInventory(...CODE_EXTENSIONS.map((extension) => `src/**/*.${extension}`))
    .filter((relativePath) => classifyV1SourcePath(relativePath) === "v1_source");
  assert.equal(report.v1_total_source_files, sourcePaths.length);
  assert.equal(report.v1_total_source_lines, inventoryLines(sourcePaths));
  assert.equal(report.v1_largest_source_file_lines, largestInventoryFile(sourcePaths));

  const collectorSource = fs.readFileSync(COLLECTOR, "utf8");
  assert.doesNotMatch(
    collectorSource,
    /\{\s*method\s*:\s*["'`][A-Z]+["'`]\s*,\s*path\s*:/u,
    "the gate must derive the surface instead of embedding a second route matrix",
  );
  assert.deepEqual(collectRuntimeComplexity(), report);
});

test("runtime imports exclude syntactically type-only edges while full dependencies retain them", () => {
  const source = `
    import type { A } from "./type-only.js";
    import { type B } from "./named-type-only.js";
    import { type C, D } from "./mixed.js";
    import Default, { type E } from "./default.js";
    import * as Namespace from "./namespace.js";
    import "./side-effect.js";
    import type TypeAlias = require("./import-equals-type.js");
    import ValueAlias = require("./import-equals-value.js");
    export type { F } from "./export-type.js";
    export { type G } from "./export-named-type.js";
    export { type H, I } from "./export-mixed.js";
    export * from "./export-star.js";
    type J = import("./import-type.js").J;
    const dynamicValue = import("./dynamic.js");
    const requiredValue = require("./require.js");
  `;
  assert.deepEqual(relativeModuleSpecifiersFromText("fixture.ts", source), [
    "./default.js",
    "./dynamic.js",
    "./export-mixed.js",
    "./export-named-type.js",
    "./export-star.js",
    "./export-type.js",
    "./import-equals-type.js",
    "./import-equals-value.js",
    "./import-type.js",
    "./mixed.js",
    "./named-type-only.js",
    "./namespace.js",
    "./require.js",
    "./side-effect.js",
    "./type-only.js",
  ]);
  assert.deepEqual(runtimeModuleSpecifiersFromText("fixture.ts", source), [
    "./default.js",
    "./dynamic.js",
    "./export-mixed.js",
    "./export-star.js",
    "./import-equals-value.js",
    "./mixed.js",
    "./namespace.js",
    "./require.js",
    "./side-effect.js",
  ]);
});

test("V1 artifact classifiers fail closed outside the focused inventory", () => {
  for (const relativePath of [
    "src/continuation/compiler.ts",
    "src/runtime-v1/daemon-entry.ts",
    "src/store/continuation-runtime-v1-schema.ts",
    "src/store/sqlite.ts",
    "src/util/crypto.ts",
    "src/util/stable-json.ts",
  ]) assert.equal(classifyV1SourcePath(relativePath), "v1_source", relativePath);
  for (const relativePath of [
    "src/routes/product-facade.ts",
    "src/store/lite-write-store.ts",
    "packages/example/src/index.ts",
    "src/util/unapproved-helper.ts",
  ]) assert.equal(classifyV1SourcePath(relativePath), "legacy_source", relativePath);

  assert.equal(
    classifyScriptPath("scripts/ci/lite-continuation-runtime-v1.test.ts"),
    "v1_test",
  );
  assert.equal(
    classifyScriptPath("scripts/ci/support/continuation-runtime-v1-fixture.ts"),
    "v1_test_support",
  );
  assert.equal(classifyScriptPath("scripts/ci/runtime-complexity-budget.mjs"), "v1_gate");
  assert.equal(
    classifyScriptPath("scripts/ci/continuation-runtime-v1-container-smoke.mjs"),
    "v1_gate",
  );
  assert.equal(classifyScriptPath("scripts/ci/unapproved.ts"), "legacy_script");
  assert.equal(classifyScriptPath("scripts/ci/unapproved.py"), "unclassified_script");

  for (const relativePath of [
    "src/store/sql/continuation-runtime-v1.sql",
    "src/store/sql/continuation-runtime-v1.manifest.json",
    "packages/sdk/package.json",
    "packages/sdk/README.md",
  ]) assert.equal(classifyResourcePath(relativePath), "v1_resource", relativePath);
  for (const relativePath of [
    "packages/sdk/unapproved.json",
    "packages/example/package.json",
    "src/store/sql/unapproved.sql",
  ]) assert.equal(classifyResourcePath(relativePath), "legacy_resource", relativePath);

  for (const relativePath of [
    "packages/sdk/build.mjs",
    "tools/author-continuation-runtime-v1-authority.ts",
    "tools/build-continuation-runtime-v1-authority.mjs",
    "tools/clean-continuation-runtime-v1-build.mjs",
    "tools/continuation-runtime-v1-authority-authoring.ts",
    "tools/continuation-runtime-v1-authority-key.ts",
    "tools/copy-continuation-runtime-v1-assets.mjs",
    "tools/generate-continuation-runtime-v1-authority-keys.mjs",
    "tools/generate-continuation-runtime-v1-cohort-seed.mjs",
    "tools/generate-continuation-runtime-v1-manifest.ts",
    "tools/stage-continuation-runtime-v1-oci.mjs",
  ]) assert.equal(classifyToolPath(relativePath), "v1_tool", relativePath);
  assert.equal(classifyToolPath("packages/sdk/unapproved.mjs"), "legacy_tool");
  assert.equal(classifyToolPath("tools/unapproved.ts"), "legacy_tool");
  assert.equal(classifyToolPath("tools/unapproved.py"), "unclassified_tool");

  for (const relativePath of [
    "src/runtime-v1/effect-signer.ts",
    "src/runtime-v1/embedding-worker-processor.ts",
    "src/runtime-v1/provisioning-composition.ts",
    "src/runtime-v1/worker-config.ts",
    "src/store/continuation-runtime-v1-authority-artifact-provisioner.ts",
    "src/store/continuation-runtime-v1-durable-job-store.ts",
    "src/store/continuation-runtime-v1-effect-certificate-writer.ts",
  ]) assert.equal(isDaemonForbiddenCapabilityPath(relativePath), true, relativePath);
  for (const relativePath of [
    "src/runtime-v1/daemon-composition.ts",
    "src/runtime-v1/decision-reader.ts",
    "src/store/continuation-runtime-v1-authority-artifact-reader.ts",
    "src/store/continuation-runtime-v1-durable-job-enqueuer.ts",
    "src/store/continuation-runtime-v1-effect-certificate-reader.ts",
  ]) assert.equal(isDaemonForbiddenCapabilityPath(relativePath), false, relativePath);
});

test("committed budget is an authenticated downward ratchet and passes the V1 inventory", () => {
  const budget = JSON.parse(fs.readFileSync(BUDGET, "utf8"));
  assert.deepEqual(Object.keys(budget).sort(), [
    "baseline",
    "baseline_metrics_sha256",
    "intent",
    "observations",
    "ratchet_policy",
    "schema_version",
    "strict_activation",
    "thresholds",
  ]);
  assert.equal(budget.schema_version, "aionis_runtime_v1_complexity_budget_v2");
  assert.deepEqual(Object.keys(budget.baseline).sort(), [
    "captured_on",
    "inventory_mode",
    "source_revision",
  ]);
  assert.match(budget.baseline.captured_on, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(budget.baseline.inventory_mode, "v1_inventory");
  assert.equal(typeof budget.baseline.source_revision, "string");
  assert.equal(budget.baseline.source_revision.length > 0, true);
  assert.equal(budget.baseline_metrics_sha256, budgetMetricsDigest(budget));
  for (const token of ["only decrease", "explicit architecture review", "reset"]) {
    assert.match(budget.ratchet_policy.toLowerCase(), new RegExp(token));
  }
  assert.match(budget.strict_activation, /--strict-no-legacy/u);

  const report = collectRuntimeComplexity();
  const metrics = complexityMetricValues(report);
  assert.deepEqual(
    Object.keys(budget.observations).sort(),
    [...COMPLEXITY_OBSERVATION_METRICS].sort(),
  );
  assert.deepEqual(
    Object.keys(budget.thresholds).sort(),
    [...COMPLEXITY_HARD_THRESHOLD_METRICS].sort(),
  );
  assert.deepEqual(
    [...Object.keys(budget.observations), ...Object.keys(budget.thresholds)].sort(),
    Object.keys(metrics).sort(),
  );
  for (const [name, threshold] of Object.entries(budget.thresholds)) {
    const actual = metrics[name];
    if (EXACT_THRESHOLD_METRICS.has(name)) assert.equal(actual, threshold, name);
    else assert.equal(actual <= threshold, true, name);
  }
  for (const observation of Object.values(budget.observations)) {
    assert.equal(Number.isSafeInteger(observation) && observation >= 0, true);
  }
  assert.equal(budget.thresholds.v1_production_runtime_import_cycles, 0);
  assert.equal(budget.thresholds.v1_total_runtime_import_cycles, 0);
  assert.equal(budget.thresholds.v1_full_type_dependency_scc_count, 0);
  assert.equal(budget.thresholds.v1_largest_production_file_lines <= 1_200, true);
  assert.equal(budget.thresholds.v1_largest_source_file_lines <= 1_200, true);

  const checked = runCollector(["--check", BUDGET]);
  assert.equal(checked.status, 0, checked.stderr);
  assertReportShape(JSON.parse(checked.stdout));
});

test("budget rejects both a lowered ceiling breach and an altered exact invariant", () => {
  const report = collectRuntimeComplexity();
  const original = JSON.parse(fs.readFileSync(BUDGET, "utf8"));
  const cases = [
    ["v1_total_source_lines", report.v1_total_source_lines - 1],
    ["public_route_count", report.public_route_count + 1],
  ];
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-v1-budget-"));
  try {
    for (const [metric, threshold] of cases) {
      const budget = structuredClone(original);
      budget.thresholds[metric] = threshold;
      budget.baseline_metrics_sha256 = budgetMetricsDigest(budget);
      const budgetPath = path.join(temporaryDirectory, `${metric}.json`);
      fs.writeFileSync(budgetPath, `${JSON.stringify(budget, null, 2)}\n`);
      const checked = runCollector(["--check", budgetPath]);
      assert.notEqual(checked.status, 0);
      assert.match(checked.stderr, new RegExp(`budget_exceeded:.*${metric}`));
      assert.equal(checked.stdout, "");
    }
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("observational metric drift is authenticated but does not fail the hard gate", () => {
  const original = JSON.parse(fs.readFileSync(BUDGET, "utf8"));
  const budget = structuredClone(original);
  budget.observations.daemon_entry_source_files = 0;
  budget.baseline_metrics_sha256 = budgetMetricsDigest(budget);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-v1-observation-"));
  try {
    const budgetPath = path.join(temporaryDirectory, "observational-drift.json");
    fs.writeFileSync(budgetPath, `${JSON.stringify(budget, null, 2)}\n`);
    const checked = runCollector(["--check", budgetPath]);
    assert.equal(checked.status, 0, checked.stderr);
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("strict no-legacy hook is adaptive across the atomic deletion boundary", () => {
  const inventory = collectRuntimeComplexity();
  const strict = runCollector(["--strict-no-legacy"]);
  if (inventory.legacy_presence.total_files > 0) {
    assert.notEqual(strict.status, 0);
    assert.match(strict.stderr, /strict_no_legacy_failed/u);
    assert.equal(strict.stdout, "");
  } else {
    assert.equal(strict.status, 0, strict.stderr);
    const report = JSON.parse(strict.stdout);
    assert.equal(report.mode, "strict_no_legacy");
    assert.equal(report.legacy_presence.total_files, 0);
  }
});

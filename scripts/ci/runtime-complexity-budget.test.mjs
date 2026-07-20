import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  findUnclassifiedArtifactPaths,
  relativeModuleSpecifiersFromText,
} from "./runtime-complexity-budget.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COLLECTOR = path.join(ROOT, "scripts", "ci", "runtime-complexity-budget.mjs");
const BUDGET = path.join(ROOT, "docs", "architecture", "runtime-complexity-budget.json");
const EXPECTED_BUDGET_SHA256 = "757b750b8c0d14e574b3d3bfb9126d405eee0ee3b31ef70d1b99c8c788309082";
const CODE_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "mjs", "cjs"];
const RESOURCE_EXTENSIONS = ["sql", "json"];
const SCRIPT_ARTIFACT_EXTENSIONS = [...CODE_EXTENSIONS, "sh", "json"];
const WORKFLOW_ARTIFACT_EXTENSIONS = ["yml", "yaml"];
const ACTION_ARTIFACT_EXTENSIONS = [...SCRIPT_ARTIFACT_EXTENSIONS, ...WORKFLOW_ARTIFACT_EXTENSIONS];
function runCollector(args = []) {
  return spawnSync(process.execPath, [COLLECTOR, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function pathspecs(root, extensions) {
  return extensions.map((extension) => `${root}/**/*.${extension}`);
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
  return result.stdout.split(/\r?\n/).filter((relativePath) => (
    relativePath.length > 0 && fs.existsSync(path.join(ROOT, relativePath))
  ));
}

function inventoryLines(paths) {
  return paths.reduce((total, relativePath) => {
    const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
    return total + (source.match(/\n/g)?.length ?? 0) + (source.endsWith("\n") ? 0 : 1);
  }, 0);
}

function largestInventoryFile(paths) {
  return paths.reduce((largest, relativePath) => {
    const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
    const lines = (source.match(/\n/g)?.length ?? 0) + (source.endsWith("\n") ? 0 : 1);
    return Math.max(largest, lines);
  }, 0);
}

function assertReportShape(report) {
  assert.deepEqual(Object.keys(report).sort(), [
    "authority_package_artifact_lines",
    "authority_package_import_cycles",
    "authority_package_largest_file_lines",
    "authority_package_resource_files",
    "authority_package_resource_lines",
    "authority_package_source_files",
    "authority_package_source_lines",
    "ci_artifact_files",
    "ci_artifact_lines",
    "ci_largest_file_lines",
    "e2e_largest_file_lines",
    "e2e_source_files",
    "e2e_source_lines",
    "env_schema_fields",
    "focused_runtime_artifact_lines",
    "import_cycles",
    "largest_files",
    "non_entry_source_files",
    "non_entry_source_lines",
    "operational_script_files",
    "operational_script_largest_file_lines",
    "operational_script_lines",
    "route_matrix_entries",
    "runtime_entry_source_files",
    "runtime_entry_source_lines",
    "runtime_resource_files",
    "runtime_resource_lines",
    "source_files",
    "source_lines",
    "tool_source_files",
    "tool_source_lines",
    "workflow_artifact_files",
    "workflow_artifact_lines",
    "workflow_largest_file_lines",
  ]);
  const zeroAllowed = new Set([
    "authority_package_resource_files",
    "authority_package_resource_lines",
  ]);
  for (const key of [
    "source_files",
    "source_lines",
    "runtime_entry_source_files",
    "runtime_entry_source_lines",
    "non_entry_source_files",
    "non_entry_source_lines",
    "tool_source_files",
    "tool_source_lines",
    "runtime_resource_files",
    "runtime_resource_lines",
    "focused_runtime_artifact_lines",
    "authority_package_source_files",
    "authority_package_source_lines",
    "authority_package_resource_files",
    "authority_package_resource_lines",
    "authority_package_artifact_lines",
    "authority_package_largest_file_lines",
    "ci_artifact_files",
    "ci_artifact_lines",
    "ci_largest_file_lines",
    "workflow_artifact_files",
    "workflow_artifact_lines",
    "workflow_largest_file_lines",
    "e2e_source_files",
    "e2e_source_lines",
    "e2e_largest_file_lines",
    "operational_script_files",
    "operational_script_lines",
    "operational_script_largest_file_lines",
    "route_matrix_entries",
    "env_schema_fields",
  ]) {
    assert.equal(Number.isInteger(report[key]), true, `${key} must be an integer`);
    assert.equal(report[key] >= 0, true, `${key} must be non-negative`);
    if (!zeroAllowed.has(key)) assert.equal(report[key] > 0, true, `${key} must be positive`);
  }
  assert.equal(report.runtime_entry_source_files + report.non_entry_source_files, report.source_files);
  assert.equal(report.runtime_entry_source_lines + report.non_entry_source_lines, report.source_lines);
  assert.equal(Array.isArray(report.import_cycles), true);
  assert.equal(Array.isArray(report.authority_package_import_cycles), true);
  for (const [cycles, prefix] of [
    [report.import_cycles, "src/"],
    [report.authority_package_import_cycles, "packages/aionis-learning-authority/src/"],
  ]) {
    for (const cycle of cycles) {
      assert.equal(Array.isArray(cycle), true);
      assert.equal(cycle.length > 0, true);
      assert.deepEqual(cycle, [...cycle].sort());
      for (const sourcePath of cycle) {
        assert.equal(sourcePath.startsWith(prefix), true);
        assert.match(sourcePath, /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/);
      }
    }
  }
  assert.equal(Array.isArray(report.largest_files), true);
  assert.equal(report.largest_files.length > 0, true);
  for (const entry of report.largest_files) {
    assert.deepEqual(Object.keys(entry).sort(), ["lines", "path"]);
    assert.match(entry.path, /^src\/.*\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/);
    assert.equal(Number.isInteger(entry.lines), true);
    assert.equal(entry.lines > 0, true);
  }
  const expectedOrder = [...report.largest_files].sort((left, right) =>
    right.lines - left.lines || left.path.localeCompare(right.path));
  assert.deepEqual(report.largest_files, expectedOrder);
}

function assertBudgetMetadata(budget) {
  assert.equal(createHash("sha256").update(fs.readFileSync(BUDGET)).digest("hex"), EXPECTED_BUDGET_SHA256);
  assert.deepEqual(Object.keys(budget).sort(), ["baseline_commit", "intent", "schema_version", "thresholds"]);
  assert.equal(budget.schema_version, "aionis_runtime_complexity_budget_v4");
  assert.match(budget.baseline_commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof budget.intent, "string");
  assert.equal(budget.intent, budget.intent.trim());
  for (const token of ["downward ratchet", "Runtime entry transitive closure", "non-entry src", "tools", "Runtime resources", "learning-authority package", "CI", "workflow orchestration", "e2e laboratory", "operational-script", "no new route"]) assert.match(budget.intent, new RegExp(token));
}

function moduleSources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return moduleSources(absolutePath);
    return entry.isFile() && /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)
      ? [absolutePath]
      : [];
  });
}

test("runtime complexity collector emits deterministic workspace-source metrics", () => {
  const first = runCollector();
  assert.equal(first.status, 0, first.stderr);
  const second = runCollector();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);

  const report = JSON.parse(first.stdout);
  assertReportShape(report);
  assert.equal(report.route_matrix_entries, 21, "focused Runtime must keep the audited 21-route matrix");
  assert.deepEqual(report.import_cycles, [], "transport-free Runtime must remain acyclic");
  const tracked = gitInventory(...pathspecs("src", CODE_EXTENSIONS));
  assert.equal(report.source_files, tracked.length);
  const trackedTools = gitInventory(...pathspecs("tools", CODE_EXTENSIONS));
  assert.equal(report.tool_source_files, trackedTools.length);
  assert.equal(report.tool_source_lines, inventoryLines(trackedTools));
  for (const [patterns, fileMetric, lineMetric] of [
    [pathspecs("src", RESOURCE_EXTENSIONS), "runtime_resource_files", "runtime_resource_lines"],
    [pathspecs("packages/aionis-learning-authority/src", CODE_EXTENSIONS), "authority_package_source_files", "authority_package_source_lines"],
    [pathspecs("packages/aionis-learning-authority/src", RESOURCE_EXTENSIONS), "authority_package_resource_files", "authority_package_resource_lines"],
  ]) {
    const paths = gitInventory(...patterns);
    assert.equal(report[fileMetric], paths.length);
    assert.equal(report[lineMetric], inventoryLines(paths));
  }
  const scripts = gitInventory(...pathspecs("scripts", SCRIPT_ARTIFACT_EXTENSIONS));
  for (const [paths, fileMetric, lineMetric, largestMetric] of [
    [scripts.filter((relativePath) => relativePath.startsWith("scripts/ci/")), "ci_artifact_files", "ci_artifact_lines", "ci_largest_file_lines"],
    [scripts.filter((relativePath) => relativePath.startsWith("scripts/e2e/")), "e2e_source_files", "e2e_source_lines", "e2e_largest_file_lines"],
    [scripts.filter((relativePath) => !relativePath.startsWith("scripts/ci/") && !relativePath.startsWith("scripts/e2e/")), "operational_script_files", "operational_script_lines", "operational_script_largest_file_lines"],
  ]) {
    assert.equal(report[fileMetric], paths.length);
    assert.equal(report[lineMetric], inventoryLines(paths));
    assert.equal(report[largestMetric], largestInventoryFile(paths));
  }
  const workflowArtifacts = [
    ...gitInventory(...pathspecs(".github/workflows", WORKFLOW_ARTIFACT_EXTENSIONS)),
    ...gitInventory(...pathspecs(".github/actions", ACTION_ARTIFACT_EXTENSIONS)),
  ].sort();
  assert.equal(report.workflow_artifact_files, workflowArtifacts.length);
  assert.equal(report.workflow_artifact_lines, inventoryLines(workflowArtifacts));
  assert.equal(report.workflow_largest_file_lines, largestInventoryFile(workflowArtifacts));
  assert.equal(
    report.focused_runtime_artifact_lines,
    report.source_lines + report.runtime_resource_lines,
  );
  assert.equal(
    report.authority_package_artifact_lines,
    report.authority_package_source_lines + report.authority_package_resource_lines,
  );
  assert.equal(report.authority_package_largest_file_lines, largestInventoryFile(
    gitInventory(...pathspecs("packages/aionis-learning-authority/src", CODE_EXTENSIONS)),
  ));
});

test("runtime complexity collector enforces the committed budget", () => {
  const budget = JSON.parse(fs.readFileSync(BUDGET, "utf8"));
  assertBudgetMetadata(budget);
  const checked = runCollector(["--check", BUDGET]);
  assert.equal(checked.status, 0, checked.stderr);
  assertReportShape(JSON.parse(checked.stdout));
});

test("runtime source imports remain acyclic", () => {
  const collected = runCollector();
  assert.equal(collected.status, 0, collected.stderr);
  const report = JSON.parse(collected.stdout);
  assert.deepEqual(report.import_cycles, []);
  assert.deepEqual(report.authority_package_import_cycles, []);

  const budget = JSON.parse(fs.readFileSync(BUDGET, "utf8"));
  assert.equal(budget.thresholds.import_cycles, 0);
  assert.equal(budget.thresholds.authority_package_import_cycles, 0);
});

test("external evidence mutation authority composes only in the protected service", () => {
  const sourceRoot = path.join(ROOT, "src");
  const authorityRoot = path.join(ROOT, "packages", "aionis-learning-authority", "src");
  const service = path.join(authorityRoot, "store", "lite-learning-external-evidence-service.ts");
  const definitions = new Set([
    path.join(authorityRoot, "store", "lite-learning-external-evidence-ingestion.ts"),
    path.join(authorityRoot, "store", "lite-runtime-protected-authority-database.ts"),
  ]);
  const authorityNames = [
    "createLiteLearningExternalEvidenceIngestionAccess",
    "runLiteRuntimeProtectedAuthorityTransaction",
  ];
  for (const absolutePath of moduleSources(sourceRoot)) {
    const source = fs.readFileSync(absolutePath, "utf8");
    assert.equal(
      source.includes("aionis-learning-authority"),
      false,
      `${path.relative(ROOT, absolutePath)} must not import the extracted authority package`,
    );
    for (const authorityName of authorityNames) {
      assert.equal(
        source.includes(authorityName),
        false,
        `${path.relative(ROOT, absolutePath)} must not compose ${authorityName}`,
      );
    }
  }
  for (const absolutePath of moduleSources(authorityRoot)) {
    if (absolutePath === service || definitions.has(absolutePath)) continue;
    const source = fs.readFileSync(absolutePath, "utf8");
    for (const authorityName of authorityNames) {
      assert.equal(
        source.includes(authorityName),
        false,
        `${path.relative(ROOT, absolutePath)} must not compose ${authorityName}`,
      );
    }
  }
  const serviceSource = fs.readFileSync(service, "utf8");
  for (const authorityName of authorityNames) assert.match(serviceSource, new RegExp(authorityName));
  const generalLedger = fs.readFileSync(
    path.join(sourceRoot, "store", "lite-learning-episode-ledger.ts"),
    "utf8",
  );
  assert.equal(generalLedger.includes("ingestExternalEvidence"), false);
  assert.equal(generalLedger.includes("assertLiteLearningExternalEvidenceIngestionIntegrity"), false);
});

test("runtime complexity collector rejects unclassified source artifacts", () => {
  assert.deepEqual(
    findUnclassifiedArtifactPaths(
      ["src/index.ts", "src/hidden.py", "src/store/schema.sql"],
      ["src/index.ts", "src/store/schema.sql"],
    ),
    ["src/hidden.py"],
  );
  const collectorSource = fs.readFileSync(COLLECTOR, "utf8");
  for (const root of [
    "src",
    "tools",
    "packages",
    "scripts",
  ]) {
    const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      collectorSource,
      new RegExp(`assertClosedArtifactInventory\\(\\s*\"${escapedRoot}\"`),
      `${root} must remain a closed complexity inventory`,
    );
  }
});

test("runtime import graph includes static, dynamic, and CommonJS local dependencies", () => {
  assert.deepEqual(
    relativeModuleSpecifiersFromText(
      "src/example.ts",
      [
        'import type { A } from "./types.js";',
        'export { B } from "./exports.js";',
        'await import("./dynamic.js");',
        'require("../common.cjs");',
        'await import("external-package");',
      ].join("\n"),
    ),
    ["../common.cjs", "./dynamic.js", "./exports.js", "./types.js"],
  );
});

test("runtime complexity collector writes the same deterministic report", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-runtime-complexity-"));
  const reportPath = path.join(tempDir, "report.json");
  const written = runCollector(["--write-report", reportPath]);
  assert.equal(written.status, 0, written.stderr);
  assert.equal(fs.existsSync(reportPath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, "utf8")), JSON.parse(written.stdout));
});

test("runtime complexity collector fails when a structural threshold grows", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-runtime-complexity-budget-"));
  const budgetPath = path.join(tempDir, "budget.json");
  const budget = JSON.parse(fs.readFileSync(BUDGET, "utf8"));
  budget.thresholds.source_files = 0;
  fs.writeFileSync(budgetPath, `${JSON.stringify(budget, null, 2)}\n`);

  const checked = runCollector(["--check", budgetPath]);
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /source_files: \d+ > 0/);
  assertReportShape(JSON.parse(checked.stdout));
});

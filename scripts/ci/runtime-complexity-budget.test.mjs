import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COLLECTOR = path.join(ROOT, "scripts", "ci", "runtime-complexity-budget.mjs");
const BUDGET = path.join(ROOT, "docs", "architecture", "runtime-complexity-budget.json");
const EXPECTED_BASELINE_COMMIT = "790b66253d1b2e33f42844e9eafe04c0c22576bd";
const EXPECTED_THRESHOLDS = {
  source_files: 327,
  source_lines: 168454,
  route_matrix_entries: 21,
  env_schema_fields: 177,
  import_cycles: 0,
  largest_file_lines: 7513,
};

function runCollector(args = []) {
  return spawnSync(process.execPath, [COLLECTOR, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function assertReportShape(report) {
  assert.deepEqual(Object.keys(report).sort(), [
    "env_schema_fields",
    "import_cycles",
    "largest_files",
    "route_matrix_entries",
    "source_files",
    "source_lines",
  ]);
  for (const key of ["source_files", "source_lines", "route_matrix_entries", "env_schema_fields"]) {
    assert.equal(Number.isInteger(report[key]), true, `${key} must be an integer`);
    assert.equal(report[key] > 0, true, `${key} must be positive`);
  }
  assert.equal(Array.isArray(report.import_cycles), true);
  for (const cycle of report.import_cycles) {
    assert.equal(Array.isArray(cycle), true);
    assert.equal(cycle.length > 0, true);
    assert.deepEqual(cycle, [...cycle].sort());
    for (const sourcePath of cycle) assert.match(sourcePath, /^src\/.*\.ts$/);
  }
  assert.equal(Array.isArray(report.largest_files), true);
  assert.equal(report.largest_files.length > 0, true);
  for (const entry of report.largest_files) {
    assert.deepEqual(Object.keys(entry).sort(), ["lines", "path"]);
    assert.match(entry.path, /^src\/.*\.ts$/);
    assert.equal(Number.isInteger(entry.lines), true);
    assert.equal(entry.lines > 0, true);
  }
  const expectedOrder = [...report.largest_files].sort((left, right) =>
    right.lines - left.lines || left.path.localeCompare(right.path));
  assert.deepEqual(report.largest_files, expectedOrder);
}

function assertBudgetMetadata(budget) {
  assert.deepEqual(Object.keys(budget).sort(), ["baseline_commit", "intent", "schema_version", "thresholds"]);
  assert.equal(budget.schema_version, "aionis_runtime_complexity_budget_v1");
  assert.match(budget.baseline_commit, /^[0-9a-f]{40}$/);
  assert.equal(budget.baseline_commit, EXPECTED_BASELINE_COMMIT);
  assert.equal(typeof budget.intent, "string");
  assert.equal(budget.intent, budget.intent.trim());
  assert.match(budget.intent, /Task 8\.2C-2 rebaseline/);
  assert.match(budget.intent, /signed public-run authority and protected external-evidence store kernel/);
  assert.match(budget.intent, /Generic evidence insertion and the public CLI remain closed/);
  assert.match(budget.intent, /raw outer run-bundle member-byte verification.*remain for later batches/);
  assert.match(budget.intent, /adds two source modules and no route, environment field, or import cycle/);
  assert.deepEqual(budget.thresholds, EXPECTED_THRESHOLDS);
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
  const tracked = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "src/**/*.ts"],
    {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GIT_GLOB_PATHSPECS: "1" },
    },
  );
  assert.equal(tracked.status, 0, tracked.stderr);
  const trackedCount = tracked.stdout
    .split(/\r?\n/)
    .filter((relativePath) => relativePath.length > 0 && fs.existsSync(path.join(ROOT, relativePath)))
    .length;
  assert.equal(report.source_files, trackedCount);
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

  const budget = JSON.parse(fs.readFileSync(BUDGET, "utf8"));
  assert.equal(budget.thresholds.import_cycles, 0);
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

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  assertExactRecoveryTapSummary,
  buildExactTestNamePattern,
  buildLiteTestInventory,
  buildRecoveryNamePattern,
  createTopLevelTapSummaryParser,
} from "./support/run-lite-tests.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");
const EXPECTED_SHARDS = ["bootstrap", "receipt", "durable", "terminal"];
const EXPECTED_CORE_SHARDS = [
  "bucket-0",
  "bucket-1",
  "bucket-2",
  "external-evidence",
  "deployment-authority",
];
const EXPECTED_TEST_COUNTS = { bootstrap: 26, receipt: 15, durable: 13, terminal: 18 };
const CORE_EXTERNAL_EVIDENCE_FILE =
  "scripts/ci/lite-learning-external-evidence-concurrency.test.ts";
const CORE_DEPLOYMENT_AUTHORITY_FILE =
  "scripts/ci/lite-runtime-deployment-slot-authority.test.ts";
const CORE_MANIFEST_FILE = "scripts/ci/manifest-product-resume.test.ts";
const TYPESCRIPT_HELPERS = [
  "scripts/ci/admission-dataset-fixture.ts",
  "scripts/ci/authority-fixture-helpers.ts",
];
const MANIFEST_PATH = "scripts/ci/lite-runtime-deployment-slot-provisioning-recovery-shards.json";
const RUNNER_COMMAND = "node scripts/ci/support/run-lite-tests.mjs";

function readManifest() {
  return JSON.parse(read(MANIFEST_PATH));
}

function topLevelTestNames(relativePath) {
  const sourceFile = ts.createSourceFile(
    relativePath,
    read(relativePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "test") {
        assert.ok(
          ts.isExpressionStatement(node.parent) && node.parent.parent === sourceFile,
          `every test(...) declaration in ${relativePath} must be a direct top-level statement`,
        );
        assert.ok(
          node.arguments[0] && ts.isStringLiteral(node.arguments[0]),
          `top-level test names in ${relativePath} must be string literals`,
        );
        names.push(node.arguments[0].text);
      } else if (ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "test") {
        assert.fail(
          `${relativePath} must not use test.${node.expression.name.text}; recovery shards require plain test(...) declarations`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function workflowJob(workflow, jobName) {
  const headers = [...workflow.matchAll(/^  ([a-z0-9-]+):\s*$/gm)];
  const index = headers.findIndex((match) => match[1] === jobName);
  assert.notEqual(index, -1, `missing workflow job: ${jobName}`);
  const start = headers[index].index;
  const end = headers[index + 1]?.index ?? workflow.length;
  return workflow.slice(start, end);
}

test("recovery shard manifest covers all 23 top-level tests exactly once", () => {
  const manifest = readManifest();
  assert.equal(manifest.schema_version, "aionis_lite_recovery_shards_v1");
  assert.deepEqual(Object.keys(manifest.shards), EXPECTED_SHARDS);

  const sourceNames = topLevelTestNames(manifest.test_file);
  assert.equal(sourceNames.length, 23, "the recovery suite must expose 23 top-level tests");
  assert.equal(new Set(sourceNames).size, sourceNames.length, "top-level recovery names must be unique");

  const expectedMembership = {
    bootstrap: sourceNames.slice(0, 9),
    receipt: sourceNames.slice(9, 13),
    durable: sourceNames.slice(13, 15),
    terminal: sourceNames.slice(15),
  };
  for (const shard of EXPECTED_SHARDS) {
    const definition = manifest.shards[shard];
    assert.equal(definition.expected_test_count, EXPECTED_TEST_COUNTS[shard]);
    assert.deepEqual(definition.test_names, expectedMembership[shard], `${shard} membership drifted`);

    const pattern = new RegExp(buildRecoveryNamePattern(shard));
    assert.deepEqual(sourceNames.filter((name) => pattern.test(name)), definition.test_names);
    assert.equal(pattern.test(`${definition.test_names[0]} suffix`), false, `${shard} pattern must be exact`);
  }
  assert.equal(
    EXPECTED_SHARDS.reduce(
      (total, shard) => total + manifest.shards[shard].expected_test_count,
      0,
    ),
    72,
  );

  const assignments = EXPECTED_SHARDS.flatMap((shard) => manifest.shards[shard].test_names);
  assert.equal(assignments.length, sourceNames.length);
  assert.equal(new Set(assignments).size, assignments.length, "a recovery test is assigned more than once");
  assert.deepEqual(assignments.toSorted(), sourceNames.toSorted(), "a recovery test is missing from the shards");
});

test("an exact parent pattern executes the Runtime-pin parent and both child tests", () => {
  const manifest = readManifest();
  const testName = "D3a.3a.1 Runtime pin cannot alias bootstrap scratch or mutex namespaces";
  const namePattern = buildExactTestNamePattern([testName]);
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "--test-concurrency=1",
      `--test-name-pattern=${namePattern}`,
      manifest.test_file,
    ],
    { cwd: ROOT, encoding: "utf8", env: childEnvironment },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^.*tests 3\r?$/m);
  assert.match(result.stdout, /^.*pass 3\r?$/m);
  assert.match(result.stdout, /^.*fail 0\r?$/m);
  assert.match(result.stdout, /^.*skipped 0\r?$/m);
});

test("streaming recovery TAP summaries fail closed on incomplete or reduced coverage", () => {
  const parser = createTopLevelTapSummaryParser();
  parser.push(Buffer.from("TAP version 13\n1..1\n# tests 3\n# pa"));
  parser.push(Buffer.from("ss 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n"));
  const summary = parser.finish();

  assert.doesNotThrow(() => assertExactRecoveryTapSummary(summary, 3));
  assert.throws(
    () => assertExactRecoveryTapSummary(summary, 4),
    /tests=3 does not equal expected 4/,
  );

  const incomplete = createTopLevelTapSummaryParser();
  incomplete.push(Buffer.from("# tests 3\n# pass 3\n# fail 0\n"));
  assert.throws(
    () => assertExactRecoveryTapSummary(incomplete.finish(), 3),
    /exactly one top-level cancelled count/,
  );
});

test("package scripts preserve the full local suite and expose core and recovery shards", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  assert.equal(scripts["lite:test"], `${RUNNER_COMMAND} full`);
  assert.equal(scripts["lite:test:static"], `${RUNNER_COMMAND} static`);
  assert.equal(scripts["lite:test:core"], `${RUNNER_COMMAND} core`);
  for (const shard of EXPECTED_CORE_SHARDS) {
    assert.equal(
      scripts[`lite:test:core:${shard}`],
      `${RUNNER_COMMAND} core ${shard}`,
    );
  }
  assert.equal(scripts["lite:test:core:manifest"], `${RUNNER_COMMAND} core manifest`);
  for (const shard of EXPECTED_SHARDS) {
    assert.equal(
      scripts[`lite:test:recovery:${shard}`],
      `${RUNNER_COMMAND} recovery ${shard}`,
    );
  }
});

test("core TypeScript shards cover every test file exactly once without executing helpers", () => {
  const manifest = readManifest();
  const inventory = buildLiteTestInventory();
  const allTypeScriptFiles = fs
    .readdirSync(path.join(ROOT, "scripts", "ci"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.posix.join("scripts", "ci", entry.name))
    .sort();
  const allTypeScriptTests = allTypeScriptFiles.filter((file) => file.endsWith(".test.ts"));
  const helpers = allTypeScriptFiles.filter((file) => !file.endsWith(".test.ts"));
  const expectedCore = allTypeScriptTests.filter((file) => file !== manifest.test_file);
  const shardAssignments = EXPECTED_CORE_SHARDS.flatMap((shard) => inventory.coreShards[shard]);
  const ciAssignments = [...shardAssignments, ...inventory.manifest];

  assert.deepEqual(helpers, TYPESCRIPT_HELPERS);
  assert.deepEqual(inventory.core, expectedCore);
  assert.deepEqual(inventory.recovery, [manifest.test_file]);
  assert.deepEqual(inventory.manifest, [CORE_MANIFEST_FILE]);
  assert.deepEqual(inventory.coreShards["external-evidence"], [CORE_EXTERNAL_EVIDENCE_FILE]);
  assert.deepEqual(
    inventory.coreShards["deployment-authority"],
    [CORE_DEPLOYMENT_AUTHORITY_FILE],
  );
  for (const shard of EXPECTED_CORE_SHARDS) {
    assert.ok(inventory.coreShards[shard].length > 0, `${shard} must not be empty`);
  }
  assert.equal(ciAssignments.length, inventory.core.length);
  assert.equal(new Set(ciAssignments).size, ciAssignments.length, "a core test is assigned twice");
  assert.deepEqual(ciAssignments.toSorted(), inventory.core.toSorted(), "a core test is missing");
});

test("default CI separates static, core, Manifest, and recovery gates", () => {
  const workflow = read(".github/workflows/ci.yml");
  const runtime = workflowJob(workflow, "runtime");
  const core = workflowJob(workflow, "runtime-core");
  const recovery = workflowJob(workflow, "runtime-recovery");
  const sandboxShutdownMacos = workflowJob(workflow, "sandbox-shutdown-macos");
  const required = workflowJob(workflow, "required");

  assert.match(runtime, /^\s+run: npm run -s lite:test:static$/m);
  assert.match(runtime, /^\s+run: npm run -s lite:test:core:manifest$/m);
  assert.doesNotMatch(runtime, /^\s+run: npm run -s lite:test\s*$/m);
  assert.doesNotMatch(runtime, /^\s+run: npm run -s lite:test:core\s*$/m);
  assert.doesNotMatch(runtime, /lite:test:recovery:/);

  assert.match(core, /^    timeout-minutes: \$\{\{ matrix\.timeout_minutes \}\}$/m);
  assert.match(core, /^      fail-fast: false$/m);
  assert.match(core, /^      max-parallel: 5$/m);
  for (const [shard, timeout] of [
    ["bucket-0", 40],
    ["bucket-1", 30],
    ["bucket-2", 40],
    ["external-evidence", 25],
    ["deployment-authority", 90],
  ]) {
    assert.match(core, new RegExp(`- shard: ${shard}\\n\\s+timeout_minutes: ${String(timeout)}`));
  }
  assert.match(
    core,
    /^        run: npm run -s lite:test:core:\$\{\{ matrix\.shard \}\}$/m,
  );
  assert.doesNotMatch(core, /^\s+run: npm run -s lite:test:core\s*$/m);

  assert.match(recovery, /^    timeout-minutes: \$\{\{ matrix\.timeout_minutes \}\}$/m);
  assert.match(recovery, /^      fail-fast: false$/m);
  assert.match(recovery, /^      max-parallel: 4$/m);
  for (const [shard, timeout] of [
    ["bootstrap", 35],
    ["receipt", 25],
    ["durable", 30],
    ["terminal", 25],
  ]) {
    assert.match(
      recovery,
      new RegExp(`- shard: ${shard}\\n\\s+timeout_minutes: ${String(timeout)}`),
    );
  }
  assert.match(
    recovery,
    /name: Install protected-close ACL verifier[\s\S]*?sudo apt-get install --yes --no-install-recommends acl/,
  );
  assert.match(recovery, /^        run: npm ci$/m);
  assert.match(
    recovery,
    /^        run: npm run -s lite:test:recovery:\$\{\{ matrix\.shard \}\}$/m,
  );
  assert.doesNotMatch(recovery, /^\s+run: npm run -s lite:test(?:\s|$)/m);

  assert.match(sandboxShutdownMacos, /^    name: Sandbox shutdown \(macOS\)$/m);
  assert.match(sandboxShutdownMacos, /^    runs-on: macos-latest$/m);
  assert.match(sandboxShutdownMacos, /^    timeout-minutes: 15$/m);
  assert.match(sandboxShutdownMacos, /^          node-version: "24"$/m);
  assert.match(sandboxShutdownMacos, /^        run: npm ci$/m);
  assert.match(
    sandboxShutdownMacos,
    /^        run: node --import tsx --test scripts\/ci\/lite-runtime-security-shutdown\.test\.ts$/m,
  );

  assert.match(required, /^    name: Required CI gates$/m);
  assert.match(required, /^    if: always\(\)$/m);
  assert.match(
    required,
    /^    needs: \[runtime, runtime-core, runtime-recovery, minimum-node, sandbox-shutdown-macos\]$/m,
  );
  assert.match(required, /RUNTIME_RESULT: \$\{\{ needs\.runtime\.result \}\}/);
  assert.match(required, /CORE_RESULT: \$\{\{ needs\['runtime-core'\]\.result \}\}/);
  assert.match(required, /RECOVERY_RESULT: \$\{\{ needs\['runtime-recovery'\]\.result \}\}/);
  assert.match(required, /MINIMUM_NODE_RESULT: \$\{\{ needs\.minimum-node\.result \}\}/);
  assert.match(
    required,
    /SANDBOX_SHUTDOWN_MACOS_RESULT: \$\{\{ needs\.sandbox-shutdown-macos\.result \}\}/,
  );
  assert.match(required, /test "\$RUNTIME_RESULT" = success/);
  assert.match(required, /test "\$CORE_RESULT" = success/);
  assert.match(required, /test "\$RECOVERY_RESULT" = success/);
  assert.match(required, /test "\$MINIMUM_NODE_RESULT" = success/);
  assert.match(required, /test "\$SANDBOX_SHUTDOWN_MACOS_RESULT" = success/);
});

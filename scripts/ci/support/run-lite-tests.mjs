import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CI_DIRECTORY = path.join(ROOT, "scripts", "ci");
const RECOVERY_MANIFEST_PATH = path.join(
  CI_DIRECTORY,
  "lite-runtime-deployment-slot-provisioning-recovery-shards.json",
);
const EXPECTED_SHARDS = ["bootstrap", "receipt", "durable", "terminal"];
const CORE_BUCKET_SHARDS = ["bucket-0", "bucket-1", "bucket-2"];
const CORE_EXTERNAL_EVIDENCE_SHARD = "external-evidence";
const CORE_DEPLOYMENT_AUTHORITY_SHARD = "deployment-authority";
const CORE_CI_SHARDS = [
  ...CORE_BUCKET_SHARDS,
  CORE_EXTERNAL_EVIDENCE_SHARD,
  CORE_DEPLOYMENT_AUTHORITY_SHARD,
];
const CORE_EXTERNAL_EVIDENCE_FILE =
  "scripts/ci/lite-learning-external-evidence-concurrency.test.ts";
const CORE_DEPLOYMENT_AUTHORITY_FILE =
  "scripts/ci/lite-runtime-deployment-slot-authority.test.ts";
const CORE_MANIFEST_FILE = "scripts/ci/manifest-product-resume.test.ts";
const TAP_SUMMARY_FIELDS = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];

function directCiFiles(extension) {
  return fs
    .readdirSync(CI_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.posix.join("scripts", "ci", entry.name))
    .sort();
}

function loadRecoveryManifest() {
  const manifest = JSON.parse(fs.readFileSync(RECOVERY_MANIFEST_PATH, "utf8"));
  if (manifest.schema_version !== "aionis_lite_recovery_shards_v1") {
    throw new Error("unsupported recovery shard manifest schema_version");
  }
  if (!manifest.shards || typeof manifest.shards !== "object") {
    throw new Error("recovery shard manifest must define shards");
  }
  return manifest;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildExactTestNamePattern(names) {
  if (!Array.isArray(names) || names.length === 0 || names.some((name) => typeof name !== "string")) {
    throw new Error("an exact test name pattern requires one or more test names");
  }
  return `^(?:${names.map(escapeRegExp).join("|")})$`;
}

export function buildRecoveryNamePattern(shard) {
  const manifest = loadRecoveryManifest();
  if (!EXPECTED_SHARDS.includes(shard)) {
    throw new Error(`unknown recovery shard ${JSON.stringify(shard)}; expected ${EXPECTED_SHARDS.join(", ")}`);
  }
  const names = manifest.shards[shard]?.test_names;
  return buildExactTestNamePattern(names);
}

function runNodeTests(files, { typescript = false, namePattern = null } = {}) {
  if (files.length === 0) {
    throw new Error("refusing to run an empty lite test selection");
  }
  const args = [];
  if (typescript) {
    args.push("--import", "tsx");
  }
  args.push("--test");
  if (typescript) {
    args.push("--test-concurrency=1");
  }
  if (namePattern) {
    args.push(`--test-name-pattern=${namePattern}`);
  }
  args.push(...files);

  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

export function createTopLevelTapSummaryParser() {
  const decoder = new StringDecoder("utf8");
  const values = Object.fromEntries(TAP_SUMMARY_FIELDS.map((field) => [field, null]));
  const occurrences = Object.fromEntries(TAP_SUMMARY_FIELDS.map((field) => [field, 0]));
  let pending = "";

  const consumeLine = (line) => {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) ([0-9]+)\r?$/.exec(line);
    if (!match) return;
    const [, field, rawValue] = match;
    values[field] = Number.parseInt(rawValue, 10);
    occurrences[field] += 1;
  };

  const consumeCompleteLines = () => {
    let newlineIndex = pending.indexOf("\n");
    while (newlineIndex !== -1) {
      consumeLine(pending.slice(0, newlineIndex));
      pending = pending.slice(newlineIndex + 1);
      newlineIndex = pending.indexOf("\n");
    }
  };

  return {
    push(chunk) {
      pending += decoder.write(chunk);
      consumeCompleteLines();
    },
    finish() {
      pending += decoder.end();
      if (pending.length > 0) consumeLine(pending);
      return Object.freeze({
        ...values,
        occurrences: Object.freeze({ ...occurrences }),
      });
    },
  };
}

export function assertExactRecoveryTapSummary(summary, expectedTestCount) {
  if (!Number.isInteger(expectedTestCount) || expectedTestCount <= 0) {
    throw new Error("recovery expected_test_count must be a positive integer");
  }
  for (const field of TAP_SUMMARY_FIELDS) {
    if (summary.occurrences?.[field] !== 1 || !Number.isInteger(summary[field])) {
      throw new Error(`recovery TAP summary must contain exactly one top-level ${field} count`);
    }
  }
  const expected = {
    tests: expectedTestCount,
    pass: expectedTestCount,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  };
  for (const field of TAP_SUMMARY_FIELDS) {
    if (summary[field] !== expected[field]) {
      throw new Error(
        `recovery TAP summary ${field}=${summary[field]} does not equal expected ${expected[field]}`,
      );
    }
  }
}

function runNodeTestsWithStreamingTap(files, { typescript = false, namePattern = null } = {}) {
  if (files.length === 0) {
    throw new Error("refusing to run an empty lite test selection");
  }
  const args = [];
  if (typescript) {
    args.push("--import", "tsx");
  }
  args.push("--test", "--test-reporter=tap");
  if (typescript) {
    args.push("--test-concurrency=1");
  }
  if (namePattern) {
    args.push(`--test-name-pattern=${namePattern}`);
  }
  args.push(...files);

  return new Promise((resolve, reject) => {
    const parser = createTopLevelTapSummaryParser();
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ["inherit", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      parser.push(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("close", (status) => {
      resolve({
        status: status ?? 1,
        summary: parser.finish(),
      });
    });
  });
}

function runStaticTests() {
  return runNodeTests(buildLiteTestInventory().static);
}

export function buildLiteTestInventory() {
  const manifest = loadRecoveryManifest();
  const typescript = directCiFiles(".test.ts");
  if (!typescript.includes(manifest.test_file)) {
    throw new Error(`recovery test file is not a direct scripts/ci TypeScript file: ${manifest.test_file}`);
  }
  for (const requiredFile of [
    CORE_EXTERNAL_EVIDENCE_FILE,
    CORE_DEPLOYMENT_AUTHORITY_FILE,
    CORE_MANIFEST_FILE,
  ]) {
    if (!typescript.includes(requiredFile)) {
      throw new Error(`required core test file is missing: ${requiredFile}`);
    }
  }
  const core = typescript.filter((file) => file !== manifest.test_file);
  const bucketFiles = core.filter(
    (file) => file !== CORE_EXTERNAL_EVIDENCE_FILE
      && file !== CORE_DEPLOYMENT_AUTHORITY_FILE
      && file !== CORE_MANIFEST_FILE,
  );
  const coreShards = Object.fromEntries(CORE_CI_SHARDS.map((shard) => [shard, []]));
  for (const file of bucketFiles) {
    const bucket = createHash("sha256").update(file).digest()[0] % CORE_BUCKET_SHARDS.length;
    coreShards[CORE_BUCKET_SHARDS[bucket]].push(file);
  }
  coreShards[CORE_EXTERNAL_EVIDENCE_SHARD].push(CORE_EXTERNAL_EVIDENCE_FILE);
  coreShards[CORE_DEPLOYMENT_AUTHORITY_SHARD].push(CORE_DEPLOYMENT_AUTHORITY_FILE);
  return {
    static: directCiFiles(".mjs"),
    core,
    coreShards,
    manifest: [CORE_MANIFEST_FILE],
    recovery: [manifest.test_file],
  };
}

function runCoreTypeScriptTests(shard) {
  const inventory = buildLiteTestInventory();
  if (shard === undefined) {
    return runNodeTests(inventory.core, { typescript: true });
  }
  if (shard === "manifest") {
    return runNodeTests(inventory.manifest, { typescript: true });
  }
  if (!CORE_CI_SHARDS.includes(shard)) {
    throw new Error(
      `unknown core shard ${JSON.stringify(shard)}; expected ${[...CORE_CI_SHARDS, "manifest"].join(", ")}`,
    );
  }
  return runNodeTests(inventory.coreShards[shard], { typescript: true });
}

async function runRecoveryShard(shard) {
  const manifest = loadRecoveryManifest();
  const definition = manifest.shards[shard];
  const namePattern = buildRecoveryNamePattern(shard);
  const result = await runNodeTestsWithStreamingTap(buildLiteTestInventory().recovery, {
    typescript: true,
    namePattern,
  });
  if (result.status !== 0) return result.status;
  assertExactRecoveryTapSummary(result.summary, definition?.expected_test_count);
  return 0;
}

async function runFullSuite() {
  const phases = [
    runStaticTests,
    runCoreTypeScriptTests,
    ...EXPECTED_SHARDS.map((shard) => () => runRecoveryShard(shard)),
  ];
  for (const phase of phases) {
    const status = await phase();
    if (status !== 0) {
      return status;
    }
  }
  return 0;
}

async function main(arguments_) {
  const [mode, shard, ...extraArguments] = arguments_;
  if (extraArguments.length > 0) {
    throw new Error(`unexpected arguments: ${extraArguments.join(" ")}`);
  }

  switch (mode) {
    case "static":
      if (shard !== undefined) throw new Error("static mode does not accept a shard");
      return runStaticTests();
    case "core":
      return runCoreTypeScriptTests(shard);
    case "recovery":
      return runRecoveryShard(shard);
    case "full":
      if (shard !== undefined) throw new Error("full mode does not accept a shard");
      return runFullSuite();
    default:
      throw new Error("usage: run-lite-tests.mjs <static|core [SHARD]|full|recovery SHARD>");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}

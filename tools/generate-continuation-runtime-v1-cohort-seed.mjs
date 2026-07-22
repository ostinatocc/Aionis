#!/usr/bin/env node

import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEED_BYTES = 32;

class CohortSeedGenerationError extends Error {
  constructor(code) {
    super(`continuation_runtime_v1_cohort_seed_generation_${code}`);
    this.name = "CohortSeedGenerationError";
    this.code = code;
  }
}

function fail(code) {
  throw new CohortSeedGenerationError(code);
}

function assertSupportedHost() {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(
    process.versions.node,
  );
  const major = match === null ? -1 : Number(match[1]);
  const minor = match === null ? -1 : Number(match[2]);
  if (process.platform !== "darwin" && process.platform !== "linux") {
    fail("platform_unsupported");
  }
  if (!((major === 22 && minor >= 15) || major === 24)) {
    fail("node_version_unsupported");
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail("output_invalid");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") fail("output_invalid");
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function currentUid() {
  if (typeof process.getuid !== "function") fail("uid_check_unavailable");
  return process.getuid();
}

function privateOutputPath(rawPath) {
  if (typeof rawPath !== "string" || !isAbsolute(rawPath)
    || resolve(rawPath) !== rawPath || basename(rawPath) === ".") {
    fail("destination_invalid");
  }
  let parent;
  let status;
  try {
    parent = realpathSync(dirname(rawPath));
    status = lstatSync(parent);
  } catch {
    fail("parent_invalid");
  }
  const uid = currentUid();
  if (!status.isDirectory() || status.isSymbolicLink()
    || (status.uid !== uid && status.uid !== 0)
    || (status.mode & 0o022) !== 0) fail("parent_invalid");
  return {
    path: join(parent, basename(rawPath)),
    parent,
    parentIdentity: status,
  };
}

function writePrivateSeed(path, seed) {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
  } catch {
    fail("destination_create_failed");
  }
  try {
    fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < seed.byteLength) {
      offset += writeSync(descriptor, seed, offset, seed.byteLength - offset, null);
    }
    fsyncSync(descriptor);
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.nlink !== 1 || status.uid !== currentUid()
      || (status.mode & 0o777) !== 0o600 || status.size !== SEED_BYTES) {
      fail("destination_posture_invalid");
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function syncPrivateParent(parent, identity) {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const directoryOnly = typeof constants.O_DIRECTORY === "number"
    ? constants.O_DIRECTORY
    : 0;
  let descriptor;
  try {
    descriptor = openSync(parent, constants.O_RDONLY | directoryOnly | noFollow);
    const status = fstatSync(descriptor);
    if (!status.isDirectory() || status.dev !== identity.dev || status.ino !== identity.ino
      || status.uid !== identity.uid || (status.mode & 0o022) !== 0) {
      fail("parent_changed");
    }
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof CohortSeedGenerationError) throw error;
    fail("parent_sync_failed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function safeFailureCode(error) {
  return error instanceof CohortSeedGenerationError
    ? error.code
    : "seed_generation_failed";
}

export function generateContinuationRuntimeV1CohortSeed(args = process.argv.slice(2)) {
  assertSupportedHost();
  if (args.length !== 1) fail("arguments_invalid");
  const destination = privateOutputPath(args[0]);
  const seed = randomBytes(SEED_BYTES);
  let created = false;
  try {
    writePrivateSeed(destination.path, seed);
    created = true;
    syncPrivateParent(destination.parent, destination.parentIdentity);
    return Object.freeze({
      schema_version: "continuation_runtime_v1_cohort_seed_generation_event_v1",
      event: "cohort_seed_generated",
      assignment_seed_bytes: SEED_BYTES,
      assignment_seed_file_mode: "0600",
      assignment_seed_commitment_sha256:
        createHash("sha256").update(seed).digest("hex"),
    });
  } catch (error) {
    if (created) {
      try { unlinkSync(destination.path); } catch { /* retain fail-closed partial output */ }
    }
    throw error;
  } finally {
    seed.fill(0);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${canonicalJson(generateContinuationRuntimeV1CohortSeed())}\n`);
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(
      `continuation_runtime_v1_cohort_seed_generation_failed:${safeFailureCode(error)}\n`,
    );
  }
}

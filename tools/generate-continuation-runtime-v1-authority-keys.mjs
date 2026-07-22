#!/usr/bin/env node

import {
  createHash,
  generateKeyPairSync,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUTS = Object.freeze([
  "root-private.pem",
  "root-public.pem",
  "effect-private.pem",
  "effect-public.pem",
]);

class AuthorityKeyGenerationError extends Error {
  constructor(code) {
    super(`continuation_runtime_v1_authority_key_generation_${code}`);
    this.name = "AuthorityKeyGenerationError";
    this.code = code;
  }
}

function fail(code) {
  throw new AuthorityKeyGenerationError(code);
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

function assertPrivateParent(parent) {
  let status;
  try {
    status = lstatSync(parent);
  } catch {
    fail("parent_invalid");
  }
  const uid = currentUid();
  if (!status.isDirectory() || status.isSymbolicLink()
    || (status.uid !== uid && status.uid !== 0)
    || (status.mode & 0o022) !== 0) fail("parent_invalid");
}

function createPrivateDirectory(rawPath) {
  if (typeof rawPath !== "string" || !isAbsolute(rawPath)
    || resolve(rawPath) !== rawPath || basename(rawPath) === ".") {
    fail("destination_invalid");
  }
  const parent = realpathSync(dirname(rawPath));
  assertPrivateParent(parent);
  const directory = join(parent, basename(rawPath));
  try {
    mkdirSync(directory, { mode: 0o700, recursive: false });
    chmodSync(directory, 0o700);
  } catch {
    fail("destination_create_failed");
  }
  const status = lstatSync(directory);
  if (!status.isDirectory() || status.isSymbolicLink()
    || status.uid !== currentUid() || (status.mode & 0o777) !== 0o700) {
    fail("destination_posture_invalid");
  }
  return { directory, identity: status };
}

function writeExclusivePrivateFile(path, bytes) {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
  } catch {
    fail("output_create_failed");
  }
  try {
    fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
    }
    fsyncSync(descriptor);
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.nlink !== 1 || status.uid !== currentUid()
      || (status.mode & 0o777) !== 0o600 || status.size !== bytes.byteLength) {
      fail("output_posture_invalid");
    }
  } finally {
    closeSync(descriptor);
  }
}

function syncPrivateDirectory(directory, identity) {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const directoryOnly = typeof constants.O_DIRECTORY === "number"
    ? constants.O_DIRECTORY
    : 0;
  let descriptor;
  try {
    descriptor = openSync(directory, constants.O_RDONLY | directoryOnly | noFollow);
    const status = fstatSync(descriptor);
    if (!status.isDirectory() || status.dev !== identity.dev || status.ino !== identity.ino
      || status.uid !== identity.uid || (status.mode & 0o777) !== 0o700) {
      fail("destination_changed");
    }
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof AuthorityKeyGenerationError) throw error;
    fail("destination_sync_failed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function keyMaterial() {
  const pair = generateKeyPairSync("ed25519");
  const privatePem = Buffer.from(pair.privateKey.export({
    format: "pem",
    type: "pkcs8",
  }), "utf8");
  const publicPem = Buffer.from(pair.publicKey.export({
    format: "pem",
    type: "spki",
  }), "utf8");
  const publicDer = pair.publicKey.export({ format: "der", type: "spki" });
  return {
    privatePem,
    publicPem,
    principalSha256: createHash("sha256").update(publicDer).digest("hex"),
  };
}

function safeFailureCode(error) {
  return error instanceof AuthorityKeyGenerationError
    ? error.code
    : "key_generation_failed";
}

export function generateContinuationRuntimeV1AuthorityKeys(args = process.argv.slice(2)) {
  assertSupportedHost();
  if (args.length !== 1) fail("arguments_invalid");
  const created = [];
  let directory = null;
  let root = null;
  let effect = null;
  try {
    const destination = createPrivateDirectory(args[0]);
    directory = destination.directory;
    root = keyMaterial();
    effect = keyMaterial();
    if (root.principalSha256 === effect.principalSha256) fail("role_separation_failed");
    for (const [name, bytes] of [
      [OUTPUTS[0], root.privatePem],
      [OUTPUTS[1], root.publicPem],
      [OUTPUTS[2], effect.privatePem],
      [OUTPUTS[3], effect.publicPem],
    ]) {
      const path = join(directory, name);
      writeExclusivePrivateFile(path, bytes);
      created.push(path);
    }
    syncPrivateDirectory(directory, destination.identity);
    const after = lstatSync(directory);
    if (after.dev !== destination.identity.dev
      || after.ino !== destination.identity.ino
      || after.uid !== destination.identity.uid
      || (after.mode & 0o777) !== 0o700) fail("destination_changed");
    return Object.freeze({
      schema_version: "continuation_runtime_v1_authority_key_generation_event_v1",
      event: "authority_keys_generated",
      directory_mode: "0700",
      private_file_mode: "0600",
      public_file_mode: "0600",
      trust_root_sha256: root.principalSha256,
      effect_signer_sha256: effect.principalSha256,
    });
  } catch (error) {
    for (const path of created.reverse()) {
      try { unlinkSync(path); } catch { /* best-effort rollback of only our O_EXCL files */ }
    }
    if (directory !== null) {
      try { rmdirSync(directory); } catch { /* retain a fail-closed partial directory */ }
    }
    throw error;
  } finally {
    root?.privatePem.fill(0);
    effect?.privatePem.fill(0);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${canonicalJson(generateContinuationRuntimeV1AuthorityKeys())}\n`);
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(
      `continuation_runtime_v1_authority_key_generation_failed:${safeFailureCode(error)}\n`,
    );
  }
}

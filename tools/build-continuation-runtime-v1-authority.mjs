#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(ROOT, "dist-authority");
const ENTRYPOINT = "tools/author-continuation-runtime-v1-authority.js";
const MANIFEST = "authority-build-manifest.canonical.json";
const TSC = resolve(ROOT, "node_modules/typescript/bin/tsc");
const TSCONFIG = resolve(ROOT, "tsconfig.authority-tools.json");
const ALLOWED_BUILTINS = new Set([
  "node:crypto",
  "node:fs",
  "node:path",
  "node:url",
]);

class AuthorityBuildError extends Error {
  constructor(code) {
    super(`continuation_runtime_v1_authority_build_${code}`);
    this.name = "AuthorityBuildError";
    this.code = code;
  }
}

function fail(code) {
  throw new AuthorityBuildError(code);
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
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail("manifest_invalid");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") fail("manifest_invalid");
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function portablePath(path) {
  return path.split(sep).join("/");
}

function collectJavaScript(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail("symlink_forbidden");
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectJavaScript(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
    else if (entry.name !== MANIFEST) fail("unexpected_output");
  }
  return files;
}

function assertClosedImports(path, source) {
  const imports = [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu),
    ...source.matchAll(/\bimport\s*["']([^"']+)["']/gu),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu),
  ].map((match) => match[1]);
  for (const specifier of imports) {
    if (specifier.startsWith("node:")) {
      if (!ALLOWED_BUILTINS.has(specifier)) fail("builtin_import_forbidden");
      continue;
    }
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      fail("third_party_import_forbidden");
    }
    const target = resolve(dirname(path), specifier);
    if (relative(OUTPUT, target).startsWith(`..${sep}`)
      || relative(OUTPUT, target) === "..") fail("import_escape_forbidden");
    let status;
    try {
      status = lstatSync(target);
    } catch {
      fail("relative_import_missing");
    }
    if (!status.isFile() || status.isSymbolicLink()) fail("relative_import_invalid");
  }
  const dynamicImportCount = source.match(/\bimport\s*\(/gu)?.length ?? 0;
  const literalDynamicImportCount = source.match(
    /\bimport\s*\(\s*["'][^"']+["']\s*\)/gu,
  )?.length ?? 0;
  if (dynamicImportCount !== literalDynamicImportCount
    || /\b(?:eval|Function|require)\s*\(/u.test(source)
    || source.includes("process.binding")) fail("dynamic_code_forbidden");
}

function hardenOutput(files) {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    fail("platform_unsupported");
  }
  if (typeof process.getuid !== "function") fail("uid_check_unavailable");
  const uid = process.getuid();
  const directories = new Set([OUTPUT]);
  for (const path of files) {
    let parent = dirname(path);
    while (parent !== OUTPUT) {
      directories.add(parent);
      parent = dirname(parent);
    }
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()
      || before.uid !== uid || before.nlink !== 1) fail("output_posture_invalid");
    chmodSync(path, 0o400);
    const after = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink()
      || after.uid !== uid || after.nlink !== 1
      || (after.mode & 0o777) !== 0o400) fail("output_posture_invalid");
  }
  const orderedDirectories = [...directories].sort((left, right) =>
    right.length - left.length);
  for (const directory of orderedDirectories) {
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== uid) {
      fail("output_directory_posture_invalid");
    }
    chmodSync(directory, 0o700);
    const after = lstatSync(directory);
    if (!after.isDirectory() || after.isSymbolicLink() || after.uid !== uid
      || (after.mode & 0o777) !== 0o700) fail("output_directory_posture_invalid");
  }
}

function build() {
  assertSupportedHost();
  process.umask(0o077);
  rmSync(OUTPUT, { recursive: true, force: true });
  const compiled = spawnSync(process.execPath, [TSC, "-p", TSCONFIG], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (compiled.status !== 0) {
    if (compiled.stdout) process.stderr.write(compiled.stdout);
    if (compiled.stderr) process.stderr.write(compiled.stderr);
    fail("typescript_failed");
  }
  const entryPath = resolve(OUTPUT, ENTRYPOINT);
  let entryStatus;
  try {
    entryStatus = lstatSync(entryPath);
  } catch {
    fail("entrypoint_missing");
  }
  if (!entryStatus.isFile() || entryStatus.isSymbolicLink()) fail("entrypoint_invalid");
  const files = collectJavaScript(OUTPUT).sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)));
  if (files.length === 0) fail("closure_empty");
  hardenOutput(files);
  const entries = files.map((path) => {
    const bytes = readFileSync(path);
    const source = bytes.toString("utf8");
    if (Buffer.from(source, "utf8").compare(bytes) !== 0) fail("output_encoding_invalid");
    assertClosedImports(path, source);
    return Object.freeze({
      path: portablePath(relative(OUTPUT, path)),
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  });
  const closureSha256 = sha256(Buffer.from(canonicalJson({ files: entries }), "utf8"));
  const manifest = Object.freeze({
    schema_version: "continuation_runtime_v1_authority_build_manifest_v1",
    entrypoint: ENTRYPOINT,
    closure_sha256: closureSha256,
    files: entries,
  });
  mkdirSync(OUTPUT, { recursive: true });
  writeFileSync(resolve(OUTPUT, MANIFEST), `${canonicalJson(manifest)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const manifestStatus = lstatSync(resolve(OUTPUT, MANIFEST));
  if (!manifestStatus.isFile() || manifestStatus.isSymbolicLink()
    || manifestStatus.nlink !== 1 || manifestStatus.uid !== process.getuid()
    || (manifestStatus.mode & 0o777) !== 0o600) fail("manifest_posture_invalid");
  return Object.freeze({
    schema_version: "continuation_runtime_v1_authority_build_event_v1",
    event: "authority_build_complete",
    entrypoint: ENTRYPOINT,
    closure_sha256: closureSha256,
    file_count: entries.length,
  });
}

function safeFailureCode(error) {
  return error instanceof AuthorityBuildError ? error.code : "build_failed";
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail("arguments_invalid");
    process.stdout.write(`${canonicalJson(build())}\n`);
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(
      `continuation_runtime_v1_authority_build_failed:${safeFailureCode(error)}\n`,
    );
  }
}

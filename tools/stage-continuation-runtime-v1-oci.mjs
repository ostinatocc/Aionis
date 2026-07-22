#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const buildRoot = resolve(root, "dist");
const stagingRoot = resolve(root, "dist-oci-runtime");
const manifestPath = "runtime-closure.manifest.json";
const entryPaths = Object.freeze([
  "dist/runtime-v1/daemon-entry.js",
  "dist/runtime-v1/provisioning-entry.js",
  "dist/runtime-v1/worker-entry.js",
]);
const resourcePaths = Object.freeze([
  "dist/store/sql/continuation-runtime-v1.manifest.json",
  "dist/store/sql/continuation-runtime-v1.sql",
]);
const rootPayloadPaths = Object.freeze(["LICENSE", "NOTICE"]);
const forbiddenRuntimePaths = Object.freeze([
  /^dist\/runtime-v1\/sdk\.js$/u,
  /\.d\.ts(?:\.map)?$/u,
  /\.js\.map$/u,
  /(?:^|\/)tools(?:\/|$)/u,
  /(?:^|\/)src(?:\/|$)/u,
]);
const importFromPattern = /\b(?:import|export)\s+[^;]*?\bfrom\s*["']([^"']+)["']/gu;
const sideEffectImportPattern = /\bimport\s*["']([^"']+)["']/gu;
const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
const anyDynamicImportPattern = /\bimport\s*\(/gu;
const staticRequirePattern = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu;
const anyRequirePattern = /\brequire\s*\(/gu;

function fail(reason) {
  throw new Error(`continuation_runtime_v1_oci_staging_invalid:${reason}`);
}

function posixPath(path) {
  return path.split(sep).join("/");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertRegularFile(path, label) {
  let status;
  try {
    status = lstatSync(path);
  } catch {
    fail(`${label}_missing`);
  }
  if (!status.isFile() || status.isSymbolicLink()) fail(`${label}_not_regular_file`);
}

function packageName(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/", 1)[0];
}

function importSpecifiers(source, path) {
  const dynamicImports = [...source.matchAll(dynamicImportPattern)].map((match) => match[1]);
  const dynamicImportCount = [...source.matchAll(anyDynamicImportPattern)].length;
  if (dynamicImports.length !== dynamicImportCount) fail(`non_literal_dynamic_import:${path}`);
  const staticRequires = [...source.matchAll(staticRequirePattern)].map((match) => match[1]);
  const requireCount = [...source.matchAll(anyRequirePattern)].length;
  if (staticRequires.length !== requireCount) fail(`non_literal_require:${path}`);
  return new Set([
    ...[...source.matchAll(importFromPattern)].map((match) => match[1]),
    ...[...source.matchAll(sideEffectImportPattern)].map((match) => match[1]),
    ...dynamicImports,
    ...staticRequires,
  ]);
}

function localBuildPath(importerPath, specifier) {
  if (!specifier.startsWith(".")) return null;
  if (!specifier.endsWith(".js") || specifier.includes("?") || specifier.includes("#")) {
    fail(`unsupported_local_import:${importerPath}:${specifier}`);
  }
  const absolute = resolve(root, dirname(importerPath), specifier);
  const relativeToBuild = relative(buildRoot, absolute);
  if (relativeToBuild === "" || relativeToBuild.startsWith(`..${sep}`) || relativeToBuild === "..") {
    fail(`local_import_escapes_build:${importerPath}:${specifier}`);
  }
  assertRegularFile(absolute, `local_import:${importerPath}:${specifier}`);
  return `dist/${posixPath(relativeToBuild)}`;
}

function collectRuntimeClosure(rootPackage) {
  const pending = [...entryPaths];
  const files = new Set();
  const externalDependencies = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (files.has(path)) continue;
    if (!path.startsWith("dist/") || !path.endsWith(".js")) fail(`invalid_module_path:${path}`);
    const absolute = resolve(root, path);
    assertRegularFile(absolute, `module:${path}`);
    files.add(path);
    const source = readFileSync(absolute, "utf8");
    for (const specifier of importSpecifiers(source, path)) {
      const local = localBuildPath(path, specifier);
      if (local !== null) {
        pending.push(local);
        continue;
      }
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith("/") || specifier.startsWith("file:") || specifier.startsWith("#")) {
        fail(`unsupported_import:${path}:${specifier}`);
      }
      const dependency = packageName(specifier);
      if (!Object.hasOwn(rootPackage.dependencies ?? {}, dependency)) {
        fail(`undeclared_external_dependency:${path}:${specifier}`);
      }
      externalDependencies.add(dependency);
    }
  }
  const declaredDependencies = Object.keys(rootPackage.dependencies ?? {}).sort();
  const usedDependencies = [...externalDependencies].sort();
  if (JSON.stringify(declaredDependencies) !== JSON.stringify(usedDependencies)) {
    fail(`production_dependency_drift:declared=${declaredDependencies.join(",")}:used=${usedDependencies.join(",")}`);
  }
  return [...files].sort();
}

function minimalRuntimePackage(rootPackage) {
  const runtimePackage = {
    name: "aionis-continuation-runtime",
    private: true,
    version: rootPackage.version,
    type: "module",
    license: rootPackage.license,
    engines: rootPackage.engines,
    os: rootPackage.os,
    dependencies: rootPackage.dependencies,
  };
  for (const [key, value] of Object.entries(runtimePackage)) {
    if (value === undefined) fail(`root_package_field_missing:${key}`);
  }
  return runtimePackage;
}

function copyPayload(path) {
  if (forbiddenRuntimePaths.some((pattern) => pattern.test(path))) fail(`forbidden_path:${path}`);
  const source = resolve(root, path);
  const destination = resolve(stagingRoot, path);
  assertRegularFile(source, `payload:${path}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  copyFileSync(source, destination);
  chmodSync(destination, 0o444);
}

function allFiles(directory, prefix = "") {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolute = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`staging_symlink:${path}`);
    if (entry.isDirectory()) paths.push(...allFiles(absolute, path));
    else if (entry.isFile()) paths.push(path);
    else fail(`staging_special_file:${path}`);
  }
  return paths;
}

function closureDigest(files) {
  return sha256(files.map(({ path, sha256: digest }) => `${path}\0${digest}\n`).join(""));
}

function verifyStaging(manifest) {
  const expectedPaths = [...manifest.files.map(({ path }) => path), manifestPath].sort();
  const actualPaths = allFiles(stagingRoot).sort();
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) fail("staging_path_set_mismatch");
  for (const file of manifest.files) {
    const actual = sha256(readFileSync(resolve(stagingRoot, file.path)));
    if (actual !== file.sha256) fail(`staging_hash_mismatch:${file.path}`);
  }
  if (closureDigest(manifest.files) !== manifest.closure_sha256) fail("staging_closure_hash_mismatch");
  const runtimePackage = JSON.parse(readFileSync(resolve(stagingRoot, "package.json"), "utf8"));
  const exactPackageKeys = ["dependencies", "engines", "license", "name", "os", "private", "type", "version"];
  if (JSON.stringify(Object.keys(runtimePackage).sort()) !== JSON.stringify(exactPackageKeys)) {
    fail("runtime_package_keys_not_exact");
  }
  if (runtimePackage.private !== true || Object.hasOwn(runtimePackage, "scripts")
    || Object.hasOwn(runtimePackage, "repository")) fail("runtime_package_not_minimal");
}

const rootPackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const modulePaths = collectRuntimeClosure(rootPackage);
const payloadPaths = [...new Set([...rootPayloadPaths, ...modulePaths, ...resourcePaths])].sort();
rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true, mode: 0o755 });
for (const path of payloadPaths) copyPayload(path);
const runtimePackage = `${JSON.stringify(minimalRuntimePackage(rootPackage), null, 2)}\n`;
writeFileSync(resolve(stagingRoot, "package.json"), runtimePackage, { mode: 0o444, flag: "wx" });
const hashedPaths = [...payloadPaths, "package.json"].sort();
const files = hashedPaths.map((path) => ({
  path,
  sha256: sha256(readFileSync(resolve(stagingRoot, path))),
}));
const manifest = {
  schema: "aionis.continuation-runtime.oci-closure.v1",
  hash_algorithm: "sha256",
  closure_encoding: "sorted_path_nul_sha256_lf_v1",
  entries: entryPaths,
  external_dependencies: rootPackage.dependencies,
  file_count: files.length,
  files,
  closure_sha256: closureDigest(files),
};
writeFileSync(resolve(stagingRoot, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o444,
  flag: "wx",
});
verifyStaging(manifest);
process.stdout.write(`${JSON.stringify({
  staging_root: posixPath(relative(root, stagingRoot)),
  module_count: modulePaths.length,
  file_count: manifest.file_count,
  closure_sha256: manifest.closure_sha256,
})}\n`);

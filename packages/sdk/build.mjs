#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const sourceRoot = resolve(repositoryRoot, "dist");
const outputRoot = resolve(import.meta.dirname, "dist");
const temporaryRoot = resolve(import.meta.dirname, `.dist-${process.pid}.tmp`);

const expectedPackageFiles = Object.freeze(["dist", "LICENSE", "NOTICE", "README.md"]);
const expectedJavaScript = Object.freeze([
  "continuation/contract.js", "runtime-v1/sdk.js", "util/crypto.js",
]);

const expectedDeclarations = Object.freeze([
  "continuation/authority-branch.d.ts", "continuation/contract.d.ts",
  "continuation/effect-certificate.d.ts", "continuation/effect-evaluation.d.ts",
  "continuation/episode.d.ts", "continuation/experiment-cohort.d.ts",
  "continuation/outcome.d.ts", "continuation/rehydration-ref.d.ts",
  "continuation/task-envelope.d.ts", "runtime-v1/command-contract.d.ts",
  "runtime-v1/command.d.ts", "runtime-v1/sdk.d.ts",
]);

const importPattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/gu;

function fail(code) { throw new Error(`continuation_sdk_build_${code}`); }

function assertPublishManifest() {
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8"));
  if (Object.hasOwn(manifest, "scripts")) fail("publish_manifest_scripts_forbidden");
  if (JSON.stringify(manifest.files) !== JSON.stringify(expectedPackageFiles)) {
    fail("publish_manifest_files_drift");
  }
}

function relativeModulePath(importer, specifier, kind) {
  if (specifier.startsWith("node:")) return null;
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    fail("external_runtime_dependency");
  }
  const imported = resolve(dirname(importer), specifier);
  const path = kind === "declaration" && imported.endsWith(".js")
    ? `${imported.slice(0, -3)}.d.ts`
    : imported;
  if (!path.startsWith(`${sourceRoot}/`) || !existsSync(path)) {
    fail("dependency_missing");
  }
  return path;
}

function closure(seed, kind) {
  const pending = [resolve(sourceRoot, seed)];
  const visited = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || visited.has(path)) continue;
    if (!existsSync(path)) fail("entry_missing");
    visited.add(path);
    const source = readFileSync(path, "utf8");
    importPattern.lastIndex = 0;
    for (const match of source.matchAll(importPattern)) {
      const dependency = relativeModulePath(path, match[1], kind);
      if (dependency !== null) pending.push(dependency);
    }
  }
  return [...visited]
    .map((path) => relative(sourceRoot, path))
    .sort();
}

function assertExact(actual, expected, kind) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${kind}_closure_drift`);
  }
}

function copyCompiled(path) {
  const sourcePath = resolve(sourceRoot, path);
  const destination = resolve(temporaryRoot, path);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  const source = readFileSync(sourcePath, "utf8");
  const withoutMapReference = source.replace(
    /\n?\/\/# sourceMappingURL=[^\n]+\n?$/u,
    "\n",
  );
  writeFileSync(destination, withoutMapReference, { encoding: "utf8", mode: 0o644 });
}

assertPublishManifest();
const javascript = closure("runtime-v1/sdk.js", "javascript");
const declarations = closure("runtime-v1/sdk.d.ts", "declaration");
assertExact(javascript, expectedJavaScript, "javascript");
assertExact(declarations, expectedDeclarations, "declaration");

rmSync(temporaryRoot, { recursive: true, force: true });
mkdirSync(temporaryRoot, { recursive: true, mode: 0o755 });
try {
  for (const path of [...javascript, ...declarations]) copyCompiled(path);
  rmSync(outputRoot, { recursive: true, force: true });
  renameSync(temporaryRoot, outputRoot);
  copyFileSync(resolve(repositoryRoot, "LICENSE"), resolve(import.meta.dirname, "LICENSE"));
  copyFileSync(resolve(repositoryRoot, "NOTICE"), resolve(import.meta.dirname, "NOTICE"));
} catch (error) {
  rmSync(temporaryRoot, { recursive: true, force: true });
  throw error;
}

process.stdout.write(`${JSON.stringify({
  schema_version: "continuation_sdk_build_v1",
  declaration_files: declarations.length,
  javascript_files: javascript.length,
})}\n`);

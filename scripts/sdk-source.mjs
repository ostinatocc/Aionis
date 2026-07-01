#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const command = process.argv[2] ?? "check";

function usage() {
  console.error("Usage: node scripts/sdk-source.mjs <check|sync> [--sdk-repo <path>]");
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function realpathOrSelf(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(scriptDir, "..");
const runtimeRoots = unique([runtimeRoot, realpathOrSelf(runtimeRoot)]);
const explicitSdkRepo = argValue("--sdk-repo") ?? process.env.AIONIS_SDK_REPO;
const sdkRepoCandidates = explicitSdkRepo
  ? [path.resolve(explicitSdkRepo)]
  : runtimeRoots.flatMap((root) => [
      path.resolve(root, "../aionis-sdk"),
      path.resolve(root, "../../aionis-sdk"),
      path.resolve(root, "../new.aionis/aionis-sdk"),
    ]);
const sdkRepo = sdkRepoCandidates.find((candidate) => fs.existsSync(path.join(candidate, "package.json")));

if (command !== "check" && command !== "sync") {
  usage();
  process.exit(2);
}

if (!sdkRepo) {
  console.error("Could not find standalone @aionis/sdk repository.");
  console.error("Set AIONIS_SDK_REPO=/absolute/path/to/aionis-sdk or pass --sdk-repo <path>.");
  process.exit(1);
}

const sourceFile = path.join(runtimeRoot, "src", "sdk.ts");
const targetFile = path.join(sdkRepo, "src", "index.ts");
const source = fs.readFileSync(sourceFile, "utf8");
const target = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, "utf8") : "";

if (command === "sync") {
  if (source !== target) {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, source);
    console.log(`Synced ${sourceFile} -> ${targetFile}`);
  } else {
    console.log(`SDK source already in sync: ${targetFile}`);
  }
  process.exit(0);
}

if (source !== target) {
  console.error("Standalone @aionis/sdk source is out of sync with Runtime src/sdk.ts.");
  console.error(`Runtime source: ${sourceFile}`);
  console.error(`SDK target:     ${targetFile}`);
  console.error("Run: npm run sdk:sync");
  process.exit(1);
}

console.log(`SDK source check passed: ${targetFile}`);

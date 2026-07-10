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

const REGION_START = /^\/\/ <aionis-runtime-owned:([a-z0-9-]+)>\r?$/gm;

function runtimeOwnedRegions(source, label) {
  const regions = new Map();
  const matcher = new RegExp(REGION_START.source, REGION_START.flags);
  let match;
  while ((match = matcher.exec(source)) !== null) {
    const name = match[1];
    if (regions.has(name)) throw new Error(`${label} contains duplicate Runtime-owned region: ${name}`);
    const contentStart = source.indexOf("\n", match.index) + 1;
    if (contentStart <= 0) throw new Error(`${label} Runtime-owned region has no body: ${name}`);
    const endMarker = `// </aionis-runtime-owned:${name}>`;
    const endStart = source.indexOf(endMarker, contentStart);
    if (endStart < 0) throw new Error(`${label} Runtime-owned region is not closed: ${name}`);
    const endLine = source.indexOf("\n", endStart);
    const end = endLine < 0 ? source.length : endLine + 1;
    regions.set(name, {
      name,
      start: match.index,
      end,
      body: source.slice(contentStart, endStart),
      block: source.slice(match.index, end),
    });
    matcher.lastIndex = end;
  }
  if (regions.size === 0) throw new Error(`${label} does not declare a Runtime-owned SDK region`);
  const closeCount = source.match(/^\/\/ <\/aionis-runtime-owned:[a-z0-9-]+>\r?$/gm)?.length ?? 0;
  if (closeCount !== regions.size) throw new Error(`${label} contains unmatched Runtime-owned region markers`);
  return regions;
}

function assertSameRegionNames(sourceRegions, targetRegions) {
  const sourceNames = [...sourceRegions.keys()].sort();
  const targetNames = [...targetRegions.keys()].sort();
  if (JSON.stringify(sourceNames) !== JSON.stringify(targetNames)) {
    throw new Error(`SDK Runtime-owned region mismatch: Runtime=${sourceNames.join(",")} SDK=${targetNames.join(",")}`);
  }
}

function syncRuntimeOwnedRegions(source, target) {
  const sourceRegions = runtimeOwnedRegions(source, "Runtime src/sdk.ts");
  const targetRegions = runtimeOwnedRegions(target, "SDK src/index.ts");
  assertSameRegionNames(sourceRegions, targetRegions);
  let next = target;
  const replacements = [...sourceRegions.values()]
    .map((region) => ({ source: region, target: targetRegions.get(region.name) }))
    .sort((left, right) => right.target.start - left.target.start);
  for (const replacement of replacements) {
    next = `${next.slice(0, replacement.target.start)}${replacement.source.block}${next.slice(replacement.target.end)}`;
  }
  return { sourceRegions, targetRegions, next };
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
const synced = syncRuntimeOwnedRegions(source, target);

if (command === "sync") {
  if (synced.next !== target) {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, synced.next);
    console.log(`Synced ${synced.sourceRegions.size} Runtime-owned SDK region(s) into ${targetFile}`);
  } else {
    console.log(`SDK Runtime-owned regions already in sync: ${targetFile}`);
  }
  process.exit(0);
}

const mismatchedRegions = [...synced.sourceRegions.values()]
  .filter((region) => region.body !== synced.targetRegions.get(region.name).body)
  .map((region) => region.name);
if (mismatchedRegions.length > 0) {
  console.error(`Standalone @aionis/sdk Runtime-owned regions are out of sync: ${mismatchedRegions.join(", ")}`);
  console.error(`Runtime source: ${sourceFile}`);
  console.error(`SDK target:     ${targetFile}`);
  console.error("Run: npm run sdk:sync");
  process.exit(1);
}

console.log(`SDK contract check passed (${synced.sourceRegions.size} Runtime-owned region(s)): ${targetFile}`);

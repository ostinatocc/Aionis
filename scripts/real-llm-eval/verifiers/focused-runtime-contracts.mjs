import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const contract = process.argv[2];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
}

function captureArray(source, name) {
  const match = new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\]`, "m").exec(source);
  assert.ok(match, `could not find ${name} array`);
  return match[1];
}

function verifyLiteRouteMatrixSandboxRequired() {
  const file = read("src/host/lite-edition.ts");
  const requiredRoutes = captureArray(file, "kernel_required_routes");
  const optionalRoutes = captureArray(file, "optional_routes");
  assert.match(requiredRoutes, /"memory-sandbox"/, "memory-sandbox must be a required Lite kernel route");
  assert.doesNotMatch(optionalRoutes, /"memory-sandbox"/, "memory-sandbox must not be optional once it is required");
  run("node", ["--test", "scripts/ci/lite-source-scope.test.mjs"]);
}

function verifySdkSharedSandboxSessionRoute() {
  const file = read("packages/full-sdk/src/routes.ts");
  assert.match(
    file,
    /sandboxSessionCreate:\s*"\/v1\/memory\/sandbox\/sessions"/,
    "SDK shared route map must expose sandboxSessionCreate",
  );
  run("npm", ["--prefix", "packages/full-sdk", "run", "-s", "build"]);
}

if (contract === "lite-route-matrix-sandbox-required") {
  verifyLiteRouteMatrixSandboxRequired();
} else if (contract === "sdk-shared-sandbox-session-route") {
  verifySdkSharedSandboxSessionRoute();
} else {
  throw new Error(`unknown focused runtime verifier contract: ${contract}`);
}

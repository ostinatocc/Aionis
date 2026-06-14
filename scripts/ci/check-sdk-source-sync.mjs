import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rootSdk = path.join(repoRoot, "src/sdk.ts");
const packageSdk = path.join(repoRoot, "packages/aionis-sdk/src/index.ts");

const rootText = fs.readFileSync(rootSdk, "utf8");
const packageText = fs.readFileSync(packageSdk, "utf8");

try {
  assert.equal(rootText, packageText);
  console.log("sdk-source-sync-ok");
} catch {
  console.error("SDK source drift detected: src/sdk.ts must match packages/aionis-sdk/src/index.ts");
  console.error("Sync with: cp packages/aionis-sdk/src/index.ts src/sdk.ts");
  process.exitCode = 1;
}

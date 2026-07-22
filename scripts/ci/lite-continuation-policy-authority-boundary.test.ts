import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const PRODUCTION_SURFACE_ROOTS = [
  "src/runtime-v1",
  "src/routes",
  "src/server",
] as const;
const RAW_COMPILER_ALLOWLIST = new Set([
  "src/runtime-v1/decision-assembly.ts",
]);

function sourceFiles(root: string): string[] {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(absolute));
    else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(entry.name)) out.push(absolute);
  }
  return out;
}

test("raw continuation compiler is explicitly non-authoritative", () => {
  const compiler = readFileSync(join(ROOT, "src/continuation/compiler.ts"), "utf8");
  assert.match(compiler, /PURE_NON_AUTHORITY_COMPILER_V1/u);
  assert.match(
    compiler,
    /VerifiedCompilerPolicyCapability\s+\*?\s*issued by PolicyAuthority/u,
  );
});

test("production surfaces cannot bypass DecisionAssembly to call raw compiler", () => {
  for (const root of PRODUCTION_SURFACE_ROOTS) {
    for (const file of sourceFiles(join(ROOT, root))) {
      const sourceId = relative(ROOT, file).split("\\").join("/");
      if (RAW_COMPILER_ALLOWLIST.has(sourceId)) continue;
      const source = readFileSync(file, "utf8");
      assert.equal(
        source.includes("compileContinuationV1"),
        false,
        `${sourceId} must resolve typed policy through DecisionAssembly before compilation`,
      );
    }
  }
});

test("authority artifact capabilities are physically split by runtime role", () => {
  const reader = readFileSync(
    join(ROOT, "src/store/continuation-runtime-v1-authority-artifact-reader.ts"),
    "utf8",
  );
  const provisioner = readFileSync(
    join(ROOT, "src/store/continuation-runtime-v1-authority-artifact-provisioner.ts"),
    "utf8",
  );
  const daemon = readFileSync(join(ROOT, "src/runtime-v1/daemon-composition.ts"), "utf8");
  const provisioning = readFileSync(
    join(ROOT, "src/runtime-v1/provisioning-composition.ts"),
    "utf8",
  );

  assert.equal(reader.includes("resolve" + "ValidPolicy"), false);
  assert.equal(reader.includes(" put("), false);
  assert.equal(reader.includes("putBundle("), false);
  assert.equal(reader.includes("putExperimentCohort("), false);
  assert.equal(reader.includes("durable-job"), false);
  assert.equal(reader.includes("AuthorityWriteContext"), false);
  assert.match(provisioner, /createContinuationRuntimeV1AuthorityArtifactProvisioner/u);
  assert.match(daemon, /continuation-runtime-v1-authority-artifact-reader/u);
  assert.equal(daemon.includes("authority-artifact-provisioner"), false);
  assert.match(provisioning, /continuation-runtime-v1-authority-artifact-provisioner/u);
  assert.equal(provisioning.includes("authority-artifact-reader"), false);
  assert.equal(statSync(
    join(ROOT, "src/store/continuation-runtime-v1-authority-artifact-" + "store.ts"),
    { throwIfNoEntry: false },
  ), undefined);
});

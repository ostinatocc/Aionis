import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  evaluateReleaseArtifactGate,
  isImmutableSourceRef,
} from "./release-artifact-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVALUATION_REPOSITORY = "https://github.com/ostinatocc/AionisRuntime-evals.git";
const GIT_IDENTITY = [
  "-c", "user.name=Aionis Release Test", "-c", "user.email=release-test@example.invalid",
];
const RELEASE_METADATA_FILES = ["package.json", "package-lock.json", "release-train.json", "runtime-manifest.json"];

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function writeJson(root, file, value) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function commit(root, message) {
  git(root, ["add", "--all"]);
  git(root, [...GIT_IDENTITY, "commit", "--quiet", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function copyReleaseMetadata() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-release-gate-"));
  for (const file of RELEASE_METADATA_FILES) {
    fs.copyFileSync(path.join(ROOT, file), path.join(target, file));
  }
  return target;
}

function packageCheckout({ name, version, repository, tag, source = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-release-package-"));
  writeJson(root, "package.json", { name, version });
  if (source !== null) {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/index.ts"), `${source}\n`);
  }
  git(root, ["init", "--quiet"]);
  git(root, ["remote", "add", "origin", repository]);
  const sourceCommit = commit(root, "package fixture");
  git(root, ["tag", tag]);
  return { root, sourceCommit, sourceRef: tag };
}

function createCheckout(defaultRuntimeRef, version = "0.3.9") {
  return packageCheckout({
    name: "@aionis/create",
    version,
    repository: "https://github.com/ostinatocc/aionis-create.git",
    tag: `v${version}`,
    source: `const DEFAULT_REPO = "https://github.com/ostinatocc/Aionis.git";\nexport const DEFAULT_RUNTIME_REF = "${defaultRuntimeRef}";`,
  });
}

function setStableCoordinates(root, create) {
  const pkg = readJson(root, "package.json");
  pkg.version = "0.3.13";
  writeJson(root, "package.json", pkg);

  const lock = readJson(root, "package-lock.json");
  lock.version = "0.3.13";
  if (lock.packages?.[""]) lock.packages[""].version = "0.3.13";
  writeJson(root, "package-lock.json", lock);

  const train = readJson(root, "release-train.json");
  train.schema_version = "aionis_release_train_v2";
  train.status = "stable";
  Object.assign(train.runtime, {
    version: "0.3.13",
    source_tag: "v0.3.13",
    docker_tag: "v0.3.13",
    default_installer_ref: "v0.3.13",
  });
  Object.assign(train.packages.create, {
    version: "0.3.9",
    source_ref: create.sourceRef,
    source_commit: create.sourceCommit,
  });
  writeJson(root, "release-train.json", train);

  const manifest = readJson(root, "runtime-manifest.json");
  Object.assign(manifest.release, {
    version: "0.3.13",
    status: "stable",
    source_tag: "v0.3.13",
    docker_tag: "v0.3.13",
    default_installer_ref: "v0.3.13",
  });
  writeJson(root, "runtime-manifest.json", manifest);
}

function addAuthority(root, mutation = () => {}, sourceCommit = "7".repeat(40)) {
  const train = readJson(root, "release-train.json");
  train.stable_promotion = {
    schema_version: "aionis_stable_promotion_authority_v1",
    verifier: {
      repository: EVALUATION_REPOSITORY,
      source_ref: sourceCommit,
      source_commit: sourceCommit,
      verifier_path: "scripts/verify-stable-promotion.mjs",
    },
    candidate_publication: {
      path: "docs/releases/v0.3.12-publication-evidence.json",
      sha256: "a".repeat(64),
    },
    bounded_soak: {
      path: "docs/releases/v0.3.12-bounded-soak-evidence.json",
      sha256: "b".repeat(64),
    },
  };
  mutation(train.stable_promotion);
  writeJson(root, "release-train.json", train);
}

function evaluationCheckout({ extraResult = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-release-authority-"));
  const workflowEvidence = path.join(root, "workflow-evidence.json");
  writeJson(root, "package.json", { name: "@aionis/runtime-evals", version: "0.0.0-private", private: true, type: "module" });
  writeJson(root, "workflow-evidence.json", { schema_version: "test-only" });
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts/verify-stable-promotion.mjs"), `
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const values = process.argv.slice(2);
const runtimeCommit = values[values.indexOf("--expected-runtime-commit") + 1];
if (!fs.statSync(values[values.indexOf("--workflow-evidence") + 1]).isFile()) process.exit(2);
if (process.env.HOME === ${JSON.stringify(process.env.HOME)} || process.env.TMPDIR !== process.env.HOME) process.exit(3);
const authority = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
process.stdout.write(JSON.stringify({
  schema_version: "aionis_stable_promotion_verification_v1",
  ok: true,
  status: "stable",
  stable_commit: runtimeCommit,
  authority_commit: authority,
  candidate_tag: "v0.3.12",
  candidate_commit: "6".repeat(40),
  candidate_digest: "sha256:${"a".repeat(64)}",
  expected_previous_latest: {
    version: "v0.3.6",
    commit: "5".repeat(40),
    digest: "sha256:${"b".repeat(64)}",
  },
  ${extraResult ? "unexpected: true," : ""}
}) + "\\n");
`);
  git(root, ["init", "--quiet"]);
  git(root, ["remote", "add", "origin", EVALUATION_REPOSITORY]);
  return { root, sourceCommit: commit(root, "authority fixture"), workflowEvidence };
}

test("release artifact gate accepts only immutable package source refs", () => {
  for (const value of [
    "0123456789abcdef0123456789abcdef01234567",
    "v0.3.15",
    "v0.3.15-beta.1",
  ]) {
    assert.equal(isImmutableSourceRef(value), true);
  }
  for (const value of ["main", "master", "release/sdk-0.3.15"]) {
    assert.equal(isImmutableSourceRef(value), false);
  }
});

test("checked candidate preserves exact public release coordinates", () => {
  const result = evaluateReleaseArtifactGate({ root: ROOT });
  assert.deepEqual(
    [result.ok, result.status, result.runtime_tag, result.publish_latest],
    [true, "candidate", "v0.3.12", false],
  );
  assert.equal(result.promotion_authority, null);
  assert.equal(Object.keys(result.package_source_refs).length, 8);
  assert.throws(
    () => evaluateReleaseArtifactGate({ root: ROOT, expectedRuntimeTag: "v999.0.0" }),
    /does not match declared Runtime tag/,
  );
});

test("release metadata rejects missing, renamed, floating, or noncanonical coordinates", () => {
  const cases = [
    [(train) => { delete train.packages.create; }, /release package keys/],
    [(train) => { train.packages.sdk.name = "sdk"; }, /release package sdk contract/],
    [(train) => { train.packages.sdk.version = "banana"; }, /version must be semantic/],
    [(train) => { train.packages.sdk.repository = "file:\/\/\/tmp\/sdk"; }, /release package sdk contract/],
    [(train) => { train.runtime.docker_image = "example.invalid/aionis"; }, /Runtime package and Docker/],
    [(train) => { train.runtime.docker_platforms = ["linux/arm64"]; }, /Runtime package and Docker/],
    [(train) => { train.runtime.default_installer_ref = "latest"; }, /installer ref must be immutable/],
    [(train) => { train.runtime.default_installer_ref = "release/candidate"; }, /installer ref must be immutable/],
    [(train) => { train.runtime.version = "banana"; train.runtime.source_tag = "vbanana"; }, /semantic coordinates/],
  ];
  for (const [mutate, pattern] of cases) {
    const root = copyReleaseMetadata();
    const train = readJson(root, "release-train.json");
    mutate(train);
    writeJson(root, "release-train.json", train);
    assert.throws(() => evaluateReleaseArtifactGate({ root }), pattern);
  }
});

test("package checkout binds exact tag, commit, identity, cleanliness, and Create default", () => {
  const root = copyReleaseMetadata();
  const train = readJson(root, "release-train.json");
  const create = createCheckout("v0.3.6", "0.3.8");
  Object.assign(train.packages.create, {
    source_ref: create.sourceRef,
    source_commit: create.sourceCommit,
  });
  writeJson(root, "release-train.json", train);

  const result = evaluateReleaseArtifactGate({
    root,
    packageRoots: { create: create.root },
  });
  assert.equal(result.package_source_commits.create, create.sourceCommit);

  fs.writeFileSync(path.join(create.root, "untracked.txt"), "dirty\n");
  assert.throws(
    () => evaluateReleaseArtifactGate({ root, packageRoots: { create: create.root } }),
    /worktree must be/,
  );

  const wrongDefault = createCheckout("v0.3.13", "0.3.8");
  Object.assign(train.packages.create, {
    source_ref: wrongDefault.sourceRef,
    source_commit: wrongDefault.sourceCommit,
  });
  writeJson(root, "release-train.json", train);
  assert.throws(
    () => evaluateReleaseArtifactGate({ root, packageRoots: { create: wrongDefault.root } }),
    /installer defaults/,
  );
});

test("stable release fails closed until exact external authority is checked out", () => {
  const root = copyReleaseMetadata();
  const create = createCheckout("v0.3.13");
  setStableCoordinates(root, create);
  const options = {
    root,
    expectedRuntimeCommit: "2".repeat(40),
    packageRoots: { create: create.root },
  };

  assert.throws(() => evaluateReleaseArtifactGate(options), /stable promotion schema/);
  addAuthority(root);
  assert.throws(
    () => evaluateReleaseArtifactGate(options),
    /requires the evaluation authority checkout/,
  );
});

test("pre-tag stable check validates authority source without granting publication", () => {
  const root = copyReleaseMetadata();
  const create = createCheckout("v0.3.13");
  const authority = evaluationCheckout();
  setStableCoordinates(root, create);
  addAuthority(root, () => {}, authority.sourceCommit);
  const result = evaluateReleaseArtifactGate({
    root,
    packageRoots: { create: create.root },
    evaluationRoot: authority.root,
    verifyStableAuthority: false,
  });
  assert.deepEqual(
    [result.status, result.publish_latest, result.promotion_authority],
    ["stable", false, null],
  );
});

test("stable authority coordinates and evidence bindings reject mutable or escaping inputs", () => {
  const cases = [
    [(authority) => { authority.verifier.source_ref = "main"; }, /verifier coordinates/],
    [(authority) => { authority.verifier.repository = "https://example.invalid/evals.git"; }, /verifier coordinates/],
    [(authority) => { authority.verifier.source_commit = "bad"; authority.verifier.source_ref = "bad"; }, /40-character commit/],
    [(authority) => { authority.bounded_soak.path = "..\/soak.json"; }, /directly under docs\/releases/],
    [(authority) => { authority.bounded_soak.sha256 = "bad"; }, /64 lowercase hex/],
  ];
  for (const [mutate, pattern] of cases) {
    const root = copyReleaseMetadata();
    const create = createCheckout("v0.3.13");
    setStableCoordinates(root, create);
    addAuthority(root, mutate);
    assert.throws(
      () => evaluateReleaseArtifactGate({
        root,
        expectedRuntimeCommit: "2".repeat(40),
        packageRoots: { create: create.root },
      }),
      pattern,
    );
  }
});

test("stable adapter accepts only one exact authority result contract", () => {
  for (const extraResult of [false, true]) {
    const root = copyReleaseMetadata();
    const create = createCheckout("v0.3.13");
    const authority = evaluationCheckout({ extraResult });
    setStableCoordinates(root, create);
    addAuthority(root, () => {}, authority.sourceCommit);
    const evaluate = () => evaluateReleaseArtifactGate({
      root,
      expectedRuntimeCommit: "2".repeat(40),
      packageRoots: { create: create.root },
      evaluationRoot: authority.root,
      workflowEvidence: authority.workflowEvidence,
    });
    if (extraResult) {
      assert.throws(evaluate, /evaluation authority result keys/);
    } else {
      const result = evaluate();
      assert.deepEqual(
        [result.publish_latest, result.promotion_authority.stable_commit],
        [true, "2".repeat(40)],
      );
    }
  }
});

test("package roots remain mandatory for a complete release verification", () => {
  assert.throws(
    () => evaluateReleaseArtifactGate({ root: ROOT, requirePackageRoots: true }),
    /checkout is required for cli/,
  );
});

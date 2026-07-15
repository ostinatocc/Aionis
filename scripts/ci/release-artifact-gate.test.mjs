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

function copyReleaseMetadata() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-release-artifact-gate-"));
  for (const file of ["package.json", "release-train.json", "runtime-manifest.json"]) {
    fs.copyFileSync(path.join(ROOT, file), path.join(target, file));
  }
  return target;
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("release artifact gate accepts only commit hashes or version tags as package source refs", () => {
  assert.equal(isImmutableSourceRef("0123456789abcdef0123456789abcdef01234567"), true);
  assert.equal(isImmutableSourceRef("v0.3.15"), true);
  assert.equal(isImmutableSourceRef("v0.3.15-beta.1"), true);
  assert.equal(isImmutableSourceRef("main"), false);
  assert.equal(isImmutableSourceRef("release/sdk-0.3.15"), false);
});

test("release artifact gate validates the checked-in release candidate and tag binding", () => {
  const result = evaluateReleaseArtifactGate({ root: ROOT });
  assert.equal(result.ok, true);
  assert.equal(result.runtime_tag, `v${result.runtime_version}`);
  assert.equal(result.publish_latest, result.status === "stable");
  assert.equal(
    Object.keys(result.package_source_commits).length,
    Object.keys(result.package_source_refs).length,
  );
  assert.throws(
    () => evaluateReleaseArtifactGate({ root: ROOT, expectedRuntimeTag: "v999.0.0" }),
    /does not match declared Runtime tag/,
  );
});

test("release artifact gate requires an exact source commit for every package", () => {
  const target = copyReleaseMetadata();
  const trainPath = path.join(target, "release-train.json");
  const train = JSON.parse(fs.readFileSync(trainPath, "utf8"));
  train.packages.sdk.source_commit = "not-a-commit";
  fs.writeFileSync(trainPath, `${JSON.stringify(train, null, 2)}\n`);
  assert.throws(
    () => evaluateReleaseArtifactGate({ root: target }),
    /source_commit must be a 40-character commit/,
  );
});

test("release artifact gate can require every declared package checkout", () => {
  assert.throws(
    () => evaluateReleaseArtifactGate({ root: ROOT, requirePackageRoots: true }),
    /release package checkout is required for cli/,
  );
});

test("release artifact gate rejects a mutable package source ref", () => {
  const target = copyReleaseMetadata();
  const trainPath = path.join(target, "release-train.json");
  const train = JSON.parse(fs.readFileSync(trainPath, "utf8"));
  train.packages.sdk.source_ref = "main";
  fs.writeFileSync(trainPath, `${JSON.stringify(train, null, 2)}\n`);
  assert.throws(
    () => evaluateReleaseArtifactGate({ root: target }),
    /must be a 40-character commit or immutable version tag/,
  );
});

test("release artifact gate checks an external package checkout when supplied", () => {
  const target = copyReleaseMetadata();
  const sdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-release-sdk-checkout-"));
  fs.writeFileSync(path.join(sdkRoot, "package.json"), JSON.stringify({
    name: "@aionis/sdk",
    version: "0.0.0",
  }));
  assert.throws(
    () => evaluateReleaseArtifactGate({ root: target, packageRoots: { sdk: sdkRoot } }),
    /expected @aionis\/sdk@/,
  );
});

test("release artifact gate binds an exact package tag, commit, and checkout", () => {
  const target = copyReleaseMetadata();
  const trainPath = path.join(target, "release-train.json");
  const train = JSON.parse(fs.readFileSync(trainPath, "utf8"));
  train.packages = { sdk: train.packages.sdk };

  const sdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-release-sdk-git-"));
  fs.writeFileSync(path.join(sdkRoot, "package.json"), JSON.stringify({
    name: train.packages.sdk.name,
    version: train.packages.sdk.version,
  }));
  git(sdkRoot, ["init", "--quiet"]);
  git(sdkRoot, ["add", "package.json"]);
  git(sdkRoot, [
    "-c", "user.name=Aionis Release Test",
    "-c", "user.email=release-test@example.invalid",
    "commit", "--quiet", "-m", "frozen package",
  ]);
  train.packages.sdk.source_ref = `v${train.packages.sdk.version}`;
  git(sdkRoot, ["tag", train.packages.sdk.source_ref]);
  train.packages.sdk.source_commit = git(sdkRoot, ["rev-parse", "HEAD"]);
  fs.writeFileSync(trainPath, `${JSON.stringify(train, null, 2)}\n`);

  const result = evaluateReleaseArtifactGate({
    root: target,
    packageRoots: { sdk: sdkRoot },
    requirePackageRoots: true,
  });
  assert.equal(result.package_source_commits.sdk, train.packages.sdk.source_commit);
});

test("release artifact gate binds an exact package commit ref and checkout", () => {
  const target = copyReleaseMetadata();
  const trainPath = path.join(target, "release-train.json");
  const train = JSON.parse(fs.readFileSync(trainPath, "utf8"));
  train.packages = { sdk: train.packages.sdk };

  const sdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-release-sdk-commit-git-"));
  fs.writeFileSync(path.join(sdkRoot, "package.json"), JSON.stringify({
    name: train.packages.sdk.name,
    version: train.packages.sdk.version,
  }));
  git(sdkRoot, ["init", "--quiet"]);
  git(sdkRoot, ["add", "package.json"]);
  git(sdkRoot, [
    "-c", "user.name=Aionis Release Test",
    "-c", "user.email=release-test@example.invalid",
    "commit", "--quiet", "-m", "frozen package commit",
  ]);
  train.packages.sdk.source_commit = git(sdkRoot, ["rev-parse", "HEAD"]);
  train.packages.sdk.source_ref = train.packages.sdk.source_commit;
  fs.writeFileSync(trainPath, `${JSON.stringify(train, null, 2)}\n`);

  const result = evaluateReleaseArtifactGate({
    root: target,
    packageRoots: { sdk: sdkRoot },
    requirePackageRoots: true,
  });
  assert.equal(result.package_source_refs.sdk, train.packages.sdk.source_commit);
});

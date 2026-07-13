import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RELEASE_STATUSES = new Set(["stable", "candidate", "development"]);
const IMMUTABLE_COMMIT_REF = /^[a-f0-9]{40}$/i;
const IMMUTABLE_VERSION_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function requiredString(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${field} must be a non-empty string`);
  return normalized;
}

function gitOutput(root, args, label) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${label} failed for ${root}: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

function packageDirectory(repositoryRoot, packagePath, key) {
  const absoluteRoot = path.resolve(repositoryRoot);
  const absolutePackage = path.resolve(absoluteRoot, packagePath);
  if (absolutePackage !== absoluteRoot && !absolutePackage.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`release-train.packages.${key}.package_path escapes its repository`);
  }
  return absolutePackage;
}

export function isImmutableSourceRef(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return IMMUTABLE_COMMIT_REF.test(normalized) || IMMUTABLE_VERSION_TAG.test(normalized);
}

export function evaluateReleaseArtifactGate({
  root = ROOT,
  expectedRuntimeTag = null,
  packageRoots = {},
  requirePackageRoots = false,
} = {}) {
  const packageJson = readJson(root, "package.json");
  const releaseTrain = readJson(root, "release-train.json");
  const runtimeManifest = readJson(root, "runtime-manifest.json");
  const status = requiredString(releaseTrain.status, "release-train.status");
  if (!RELEASE_STATUSES.has(status)) {
    throw new Error(`release-train.status must be stable, candidate, or development; got ${status}`);
  }

  const runtimeVersion = requiredString(releaseTrain.runtime?.version, "release-train.runtime.version");
  const runtimeTag = requiredString(releaseTrain.runtime?.source_tag, "release-train.runtime.source_tag");
  if (runtimeTag !== `v${runtimeVersion}`) {
    throw new Error(`runtime source tag must be v${runtimeVersion}; got ${runtimeTag}`);
  }
  if (packageJson.version !== runtimeVersion) {
    throw new Error(`package.json version ${packageJson.version ?? "missing"} does not match Runtime ${runtimeVersion}`);
  }
  if (runtimeManifest.release?.version !== runtimeVersion || runtimeManifest.release?.status !== status) {
    throw new Error("runtime-manifest release version/status does not match release-train.json");
  }
  if (runtimeManifest.release?.source_tag !== runtimeTag) {
    throw new Error("runtime-manifest source tag does not match release-train.json");
  }
  const dockerPlatforms = releaseTrain.runtime?.docker_platforms;
  if (
    !Array.isArray(dockerPlatforms)
    || dockerPlatforms.length === 0
    || dockerPlatforms.some((value) => !/^linux\/(amd64|arm64)$/.test(value))
    || new Set(dockerPlatforms).size !== dockerPlatforms.length
  ) {
    throw new Error("release-train.runtime.docker_platforms must contain unique supported Linux platforms");
  }
  if (JSON.stringify(runtimeManifest.release?.docker_platforms) !== JSON.stringify(dockerPlatforms)) {
    throw new Error("runtime-manifest Docker platforms do not match release-train.json");
  }

  const expectedTag = typeof expectedRuntimeTag === "string" ? expectedRuntimeTag.trim() : "";
  if (expectedTag && expectedTag !== runtimeTag) {
    throw new Error(`release ref ${expectedTag} does not match declared Runtime tag ${runtimeTag}`);
  }

  const packages = releaseTrain.packages && typeof releaseTrain.packages === "object"
    ? releaseTrain.packages
    : null;
  if (!packages || Array.isArray(packages) || Object.keys(packages).length === 0) {
    throw new Error("release-train.packages must contain release package coordinates");
  }

  const packageRefs = {};
  const packageCommits = {};
  for (const [key, entry] of Object.entries(packages)) {
    const name = requiredString(entry?.name, `release-train.packages.${key}.name`);
    const version = requiredString(entry?.version, `release-train.packages.${key}.version`);
    const sourceRef = requiredString(entry?.source_ref, `release-train.packages.${key}.source_ref`);
    const sourceCommit = requiredString(entry?.source_commit, `release-train.packages.${key}.source_commit`);
    requiredString(entry?.repository, `release-train.packages.${key}.repository`);
    const packagePath = requiredString(entry?.package_path, `release-train.packages.${key}.package_path`);
    if (!isImmutableSourceRef(sourceRef)) {
      throw new Error(
        `release-train.packages.${key}.source_ref must be a 40-character commit or immutable version tag; got ${sourceRef}`,
      );
    }
    if (IMMUTABLE_VERSION_TAG.test(sourceRef) && sourceRef !== `v${version}`) {
      throw new Error(`release-train.packages.${key}.source_ref ${sourceRef} does not match package version ${version}`);
    }
    if (!IMMUTABLE_COMMIT_REF.test(sourceCommit)) {
      throw new Error(`release-train.packages.${key}.source_commit must be a 40-character commit`);
    }
    const packageRoot = packageRoots[key];
    if (requirePackageRoots && !packageRoot) {
      throw new Error(`release package checkout is required for ${key}`);
    }
    if (packageRoot) {
      const repositoryRoot = path.resolve(packageRoot);
      const externalPackage = readJson(
        packageDirectory(repositoryRoot, packagePath, key),
        "package.json",
      );
      if (externalPackage.name !== name || externalPackage.version !== version) {
        throw new Error(
          `${key} checkout is ${externalPackage.name ?? "unknown"}@${externalPackage.version ?? "unknown"}; expected ${name}@${version}`,
        );
      }
      const headCommit = gitOutput(repositoryRoot, ["rev-parse", "HEAD^{commit}"], `${key} HEAD resolution`);
      const refCommit = gitOutput(
        repositoryRoot,
        ["rev-parse", `${sourceRef}^{commit}`],
        `${key} source ref resolution`,
      );
      if (headCommit !== sourceCommit || refCommit !== sourceCommit) {
        throw new Error(
          `${key} checkout/ref does not match frozen commit ${sourceCommit}; HEAD=${headCommit}, ${sourceRef}=${refCommit}`,
        );
      }
      const dirty = gitOutput(repositoryRoot, ["status", "--porcelain"], `${key} worktree check`);
      if (dirty) throw new Error(`${key} checkout contains uncommitted files`);
    }
    packageRefs[key] = sourceRef;
    packageCommits[key] = sourceCommit;
  }

  return {
    ok: true,
    status,
    runtime_version: runtimeVersion,
    runtime_tag: runtimeTag,
    docker_platforms: dockerPlatforms,
    publish_latest: status === "stable",
    package_source_refs: packageRefs,
    package_source_commits: packageCommits,
  };
}

function parseArgs(argv) {
  const args = {
    check: false,
    requirePackageRoots: false,
    expectedRuntimeTag: process.env.AIONIS_RELEASE_EXPECTED_TAG ?? null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") args.check = true;
    if (value === "--require-package-roots") args.requirePackageRoots = true;
    if (value === "--expect-tag") {
      args.expectedRuntimeTag = argv[index + 1] ?? null;
      index += 1;
    }
  }
  return args;
}

const cli = parseArgs(process.argv.slice(2));
if (cli.check) {
  const packageRoots = {};
  for (const key of ["cli", "create", "sdk", "mcp", "aifs", "claude_code", "substrate", "manifest"]) {
    const envKey = `AIONIS_RELEASE_${key.toUpperCase()}_REPO`;
    if (process.env[envKey]?.trim()) packageRoots[key] = path.resolve(process.env[envKey]);
  }
  const result = evaluateReleaseArtifactGate({
    root: ROOT,
    expectedRuntimeTag: cli.expectedRuntimeTag,
    packageRoots,
    requirePackageRoots: cli.requirePackageRoots,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

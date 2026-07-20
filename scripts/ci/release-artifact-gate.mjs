import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RELEASE_STATUSES = new Set(["stable", "candidate", "development"]);
const IMMUTABLE_COMMIT_REF = /^[a-f0-9]{40}$/i;
const IMMUTABLE_VERSION_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SEMANTIC_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DOCKER_DIGEST = /^sha256:[a-f0-9]{64}$/;
const EVALUATION_REPOSITORY = "https://github.com/ostinatocc/AionisRuntime-evals.git";
const EVALUATION_PACKAGE = "@aionis/runtime-evals";
const EVALUATION_VERIFIER = "scripts/verify-stable-promotion.mjs";
const AUTHORITY_RESULT_KEYS = [
  "authority_commit", "candidate_commit", "candidate_digest", "candidate_tag",
  "expected_previous_latest", "ok", "schema_version", "stable_commit", "status",
];
const RUNTIME_CONTRACT = {
  dockerImage: "ghcr.io/ostinatocc/aionis",
  githubRepository: "ostinatocc/Aionis",
  platforms: ["linux/amd64"],
};
const PACKAGE_CONTRACTS = {
  cli: ["aionis", "https://github.com/ostinatocc/aionis-cli.git", "."],
  create: ["@aionis/create", "https://github.com/ostinatocc/aionis-create.git", "."],
  sdk: ["@aionis/sdk", "https://github.com/ostinatocc/aionis-sdk.git", "."],
  manifest: ["@aionis/manifest", "https://github.com/ostinatocc/AionisManifest.git", "."],
  mcp: ["@aionis/mcp", "https://github.com/ostinatocc/aionis-mcp.git", "."],
  aifs: ["@aionis/aifs", "https://github.com/ostinatocc/aionis-aifs.git", "."],
  claude_code: [
    "@aionis/claude-code",
    "https://github.com/ostinatocc/aionis-claude-code.git",
    "packages/aionis-claude-code",
  ],
  substrate: ["@aionis/substrate", "https://github.com/ostinatocc/AionisSubstrate.git", "."],
};

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function requiredString(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${field} must be a non-empty string`);
  return normalized;
}

function expect(actual, expected, field) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      `${field} must be ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`,
    );
  }
}

function expectFields(actual, expected, field) {
  for (const [key, value] of Object.entries(expected)) {
    expect(actual?.[key], value, `${field}.${key}`);
  }
}

function gitOutput(root, args, label) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed for ${root}: ${result.stderr.trim() || `exit ${result.status}`}`,
    );
  }
  return result.stdout.trim();
}

function packageDirectory(repositoryRoot, packagePath, key) {
  const absoluteRoot = path.resolve(repositoryRoot);
  const absolutePackage = path.resolve(absoluteRoot, packagePath);
  if (
    absolutePackage !== absoluteRoot
    && !absolutePackage.startsWith(`${absoluteRoot}${path.sep}`)
  ) {
    throw new Error(`release-train.packages.${key}.package_path escapes its repository`);
  }
  return absolutePackage;
}

function assertInstallerDefaults(repositoryRoot, packagePath, expectedRef) {
  const sourcePath = path.join(
    packageDirectory(repositoryRoot, packagePath, "create"),
    "src/index.ts",
  );
  const source = fs.readFileSync(sourcePath, "utf8");
  const repo = source.match(/const DEFAULT_REPO\s*=\s*["']([^"']+)["']/u);
  const ref = source.match(/export const DEFAULT_RUNTIME_REF\s*=\s*["']([^"']+)["']/u);
  if (!repo || !ref) throw new Error("frozen Create checkout does not define installer defaults");
  expect(
    [repo[1], ref[1]],
    ["https://github.com/ostinatocc/Aionis.git", expectedRef],
    "frozen Create installer defaults",
  );
}

function validateEvidenceBinding(binding, field) {
  const relativePath = requiredString(binding?.path, `${field}.path`);
  const sha256 = requiredString(binding?.sha256, `${field}.sha256`);
  if (!/^docs\/releases\/[0-9A-Za-z._-]+\.json$/u.test(relativePath)) {
    throw new Error(`${field}.path must be a JSON file directly under docs/releases`);
  }
  if (!SHA256.test(sha256)) {
    throw new Error(`${field}.sha256 must be 64 lowercase hex characters`);
  }
  return { path: relativePath, sha256 };
}

function validateAuthoritySource(stablePromotion) {
  expect(
    stablePromotion?.schema_version,
    "aionis_stable_promotion_authority_v1",
    "stable promotion schema",
  );
  const verifier = stablePromotion?.verifier;
  const sourceCommit = requiredString(verifier?.source_commit, "stable promotion verifier commit");
  expect(
    [verifier?.repository, verifier?.source_ref, verifier?.verifier_path],
    [EVALUATION_REPOSITORY, sourceCommit, EVALUATION_VERIFIER],
    "stable promotion verifier coordinates",
  );
  if (!IMMUTABLE_COMMIT_REF.test(sourceCommit)) {
    throw new Error("stable promotion verifier commit must be a 40-character commit");
  }
  return {
    repository: EVALUATION_REPOSITORY,
    source_commit: sourceCommit,
    verifier_path: EVALUATION_VERIFIER,
    candidate_publication: validateEvidenceBinding(stablePromotion.candidate_publication, "candidate publication receipt"),
    bounded_soak: validateEvidenceBinding(stablePromotion.bounded_soak, "bounded soak receipt"),
  };
}

function canonicalGitUrl(value) {
  return value
    .replace(/^git@github\.com:/u, "https://github.com/")
    .replace(/\.git$/u, "");
}

function requireRegularFile(file, field) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${field} is not a regular file`);
  return file;
}

function validateGitCheckout(root, { commit, sourceRef = null, repository = null }, label) {
  const checks = [
    [["rev-parse", "HEAD^{commit}"], commit, "HEAD", String],
    [["status", "--porcelain"], "", "worktree", String],
  ];
  if (sourceRef) checks.push([["rev-parse", `${sourceRef}^{commit}`], commit, "source ref", String]);
  if (repository) {
    checks.push([["remote", "get-url", "origin"], canonicalGitUrl(repository), "origin", canonicalGitUrl]);
  }
  for (const [args, expected, field, normalize] of checks) {
    expect(normalize(gitOutput(root, args, `${label} ${field}`)), expected, `${label} ${field}`);
  }
}

function validateAuthorityCheckout(stablePromotion, evaluationRoot) {
  const source = validateAuthoritySource(stablePromotion);
  if (!evaluationRoot) throw new Error("stable release requires the evaluation authority checkout");
  const authorityRoot = path.resolve(evaluationRoot);
  const authorityPackage = readJson(authorityRoot, "package.json");
  expect(authorityPackage.name, EVALUATION_PACKAGE, "evaluation authority package name");
  validateGitCheckout(
    authorityRoot,
    { commit: source.source_commit, repository: source.repository },
    "evaluation authority",
  );

  const verifierPath = requireRegularFile(
    path.join(authorityRoot, source.verifier_path),
    "evaluation authority verifier",
  );
  return { source, authorityRoot, verifierPath };
}

function runStableAuthority({
  root,
  evaluationRoot,
  createRoot,
  runtimeCommit,
  stablePromotion,
  workflowEvidence,
}) {
  if (!createRoot) throw new Error("stable release requires the frozen Create checkout");
  const { source, authorityRoot, verifierPath } = validateAuthorityCheckout(stablePromotion, evaluationRoot);
  if (!workflowEvidence) throw new Error("stable release requires sanitized workflow evidence");
  const workflowEvidencePath = requireRegularFile(path.resolve(workflowEvidence), "workflow evidence");
  const verifierHome = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-release-verifier-"));
  let result;
  try {
    result = spawnSync(
      process.execPath,
      [
        verifierPath,
        "--runtime-root", path.resolve(root),
        "--create-root", path.resolve(createRoot),
        "--expected-runtime-commit", runtimeCommit,
        "--workflow-evidence", workflowEvidencePath,
      ],
      {
        cwd: authorityRoot,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: verifierHome, TMPDIR: verifierHome },
        maxBuffer: 2 * 1024 * 1024,
      },
    );
  } finally {
    fs.rmSync(verifierHome, { recursive: true, force: true });
  }
  if (result.status !== 0) {
    throw new Error(
      `evaluation authority rejected stable promotion: ${result.stderr.trim() || `exit ${result.status}`}`,
    );
  }

  let verification;
  try {
    verification = JSON.parse(result.stdout);
  } catch {
    throw new Error("evaluation authority did not return one JSON verification result");
  }
  expect(Object.keys(verification).sort(), AUTHORITY_RESULT_KEYS, "evaluation authority result keys");
  expectFields(verification, {
    schema_version: "aionis_stable_promotion_verification_v1",
    ok: true,
    status: "stable",
    stable_commit: runtimeCommit,
    authority_commit: source.source_commit,
  }, "evaluation authority result");
  if (
    !IMMUTABLE_VERSION_TAG.test(verification.candidate_tag ?? "")
    || !IMMUTABLE_COMMIT_REF.test(verification.candidate_commit ?? "")
    || !DOCKER_DIGEST.test(verification.candidate_digest ?? "")
    || !DOCKER_DIGEST.test(verification.expected_previous_latest?.digest ?? "")
    || !IMMUTABLE_VERSION_TAG.test(verification.expected_previous_latest?.version ?? "")
    || !IMMUTABLE_COMMIT_REF.test(verification.expected_previous_latest?.commit ?? "")
  ) {
    throw new Error("evaluation authority returned invalid promotion coordinates");
  }
  return verification;
}

export function isImmutableSourceRef(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return IMMUTABLE_COMMIT_REF.test(normalized) || IMMUTABLE_VERSION_TAG.test(normalized);
}

export function evaluateReleaseArtifactGate({
  root = ROOT,
  expectedRuntimeTag = null,
  expectedRuntimeCommit = null,
  packageRoots = {},
  requirePackageRoots = false,
  evaluationRoot = null,
  workflowEvidence = null,
  verifyStableAuthority = true,
} = {}) {
  const packageJson = readJson(root, "package.json");
  const releaseTrain = readJson(root, "release-train.json");
  const runtimeManifest = readJson(root, "runtime-manifest.json");
  const status = requiredString(releaseTrain.status, "release-train.status");
  if (!RELEASE_STATUSES.has(status)) {
    throw new Error(`release-train.status must be stable, candidate, or development; got ${status}`);
  }
  expect(
    releaseTrain.schema_version,
    status === "stable" ? "aionis_release_train_v2" : "aionis_release_train_v1",
    "release-train schema",
  );

  const runtimeVersion = requiredString(releaseTrain.runtime?.version, "Runtime version");
  const runtimeTag = requiredString(releaseTrain.runtime?.source_tag, "Runtime source tag");
  const dockerImage = requiredString(releaseTrain.runtime?.docker_image, "Runtime Docker image");
  const dockerTag = requiredString(releaseTrain.runtime?.docker_tag, "Runtime Docker tag");
  const installerRef = requiredString(
    releaseTrain.runtime?.default_installer_ref,
    "Runtime default installer ref",
  );
  if (!SEMANTIC_VERSION.test(runtimeVersion) || runtimeTag !== `v${runtimeVersion}`) {
    throw new Error("Runtime version and source tag must be matching semantic coordinates");
  }
  if (!isImmutableSourceRef(installerRef)) {
    throw new Error("default installer ref must be immutable");
  }
  if (status === "stable" && installerRef !== runtimeTag) {
    throw new Error("stable installer default must equal the stable Runtime tag");
  }
  expect(
    [
      packageJson.version,
      dockerImage,
      dockerTag,
      releaseTrain.runtime?.docker_platforms,
    ],
    [runtimeVersion, RUNTIME_CONTRACT.dockerImage, runtimeTag, RUNTIME_CONTRACT.platforms],
    "Runtime package and Docker coordinates",
  );
  expectFields(runtimeManifest.release, {
    version: runtimeVersion,
    status,
    source_tag: runtimeTag,
    github_repo: RUNTIME_CONTRACT.githubRepository,
    docker_image: dockerImage,
    docker_tag: dockerTag,
    docker_platforms: RUNTIME_CONTRACT.platforms,
    default_installer_ref: installerRef,
  }, "runtime-manifest release coordinates");
  const expectedTag = typeof expectedRuntimeTag === "string" ? expectedRuntimeTag.trim() : "";
  if (expectedTag && expectedTag !== runtimeTag) {
    throw new Error(`release ref ${expectedTag} does not match declared Runtime tag ${runtimeTag}`);
  }

  const packages = releaseTrain.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error("release-train.packages must contain release package coordinates");
  }
  expect(
    Object.keys(packages).sort(),
    Object.keys(PACKAGE_CONTRACTS).sort(),
    "release package keys",
  );

  const packageRefs = {};
  const packageCommits = {};
  for (const [key, contract] of Object.entries(PACKAGE_CONTRACTS)) {
    const entry = packages[key];
    const name = requiredString(entry?.name, `release package ${key} name`);
    const version = requiredString(entry?.version, `release package ${key} version`);
    const sourceRef = requiredString(entry?.source_ref, `release package ${key} source ref`);
    const sourceCommit = requiredString(entry?.source_commit, `release package ${key} commit`);
    const repository = requiredString(entry?.repository, `release package ${key} repository`);
    const packagePath = requiredString(entry?.package_path, `release package ${key} path`);
    expect([name, repository, packagePath], contract, `release package ${key} contract`);
    if (!SEMANTIC_VERSION.test(version)) {
      throw new Error(`release package ${key} version must be semantic`);
    }
    if (!isImmutableSourceRef(sourceRef)) {
      throw new Error(`release package ${key} source ref must be immutable`);
    }
    if (IMMUTABLE_VERSION_TAG.test(sourceRef) && sourceRef !== `v${version}`) {
      throw new Error(`release package ${key} source ref does not match its version`);
    }
    if (!IMMUTABLE_COMMIT_REF.test(sourceCommit)) {
      throw new Error(`release package ${key} commit must be a 40-character commit`);
    }

    const packageRoot = packageRoots[key];
    if ((requirePackageRoots || (status === "stable" && key === "create")) && !packageRoot) {
      throw new Error(`release package checkout is required for ${key}`);
    }
    if (packageRoot) {
      const repositoryRoot = path.resolve(packageRoot);
      const externalPackage = readJson(
        packageDirectory(repositoryRoot, packagePath, key),
        "package.json",
      );
      expect(
        [externalPackage.name, externalPackage.version],
        [name, version],
        `${key} checkout package identity`,
      );
      validateGitCheckout(
        repositoryRoot,
        { commit: sourceCommit, sourceRef },
        `${key} checkout`,
      );
      if (key === "create") assertInstallerDefaults(repositoryRoot, packagePath, installerRef);
    }
    packageRefs[key] = sourceRef;
    packageCommits[key] = sourceCommit;
  }

  if (status !== "stable" && releaseTrain.stable_promotion !== undefined) {
    throw new Error("stable promotion authority is valid only for stable releases");
  }
  let promotionAuthority = null;
  if (status === "stable") {
    if (verifyStableAuthority) {
      const runtimeCommit = expectedRuntimeCommit
        || gitOutput(root, ["rev-parse", "HEAD^{commit}"], "stable Runtime commit");
      if (!IMMUTABLE_COMMIT_REF.test(runtimeCommit)) {
        throw new Error("stable Runtime commit must be a 40-character commit");
      }
      promotionAuthority = runStableAuthority({
        root,
        evaluationRoot,
        createRoot: packageRoots.create,
        runtimeCommit,
        stablePromotion: releaseTrain.stable_promotion,
        workflowEvidence,
      });
    } else {
      validateAuthorityCheckout(releaseTrain.stable_promotion, evaluationRoot);
    }
  }

  return {
    ok: true,
    status,
    runtime_version: runtimeVersion,
    runtime_tag: runtimeTag,
    docker_platforms: RUNTIME_CONTRACT.platforms,
    publish_latest: status === "stable" && verifyStableAuthority,
    promotion_authority: promotionAuthority,
    package_source_refs: packageRefs,
    package_source_commits: packageCommits,
  };
}

function parseArgs(argv) {
  const args = {
    check: false,
    pretag: false,
    requirePackageRoots: false,
    expectedRuntimeTag: process.env.AIONIS_RELEASE_EXPECTED_TAG ?? null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") args.check = true;
    if (value === "--pretag") args.pretag = true;
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
  for (const key of Object.keys(PACKAGE_CONTRACTS)) {
    const envKey = `AIONIS_RELEASE_${key.toUpperCase()}_REPO`;
    if (process.env[envKey]?.trim()) packageRoots[key] = path.resolve(process.env[envKey]);
  }
  const result = evaluateReleaseArtifactGate({
    root: ROOT,
    expectedRuntimeTag: cli.expectedRuntimeTag,
    packageRoots,
    requirePackageRoots: cli.requirePackageRoots,
    evaluationRoot: process.env.AIONIS_RELEASE_EVALUATION_REPO?.trim() || null,
    workflowEvidence: process.env.AIONIS_RELEASE_WORKFLOW_EVIDENCE?.trim() || null,
    verifyStableAuthority: !cli.pretag,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

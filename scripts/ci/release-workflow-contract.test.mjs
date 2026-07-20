import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");
const assertMatches = (source, patterns) => patterns.forEach((pattern) => assert.match(source, pattern));
const assertOmits = (source, patterns) => patterns.forEach((pattern) => assert.doesNotMatch(source, pattern));
const TRUSTED_ACTIONS = new Set(["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020", "docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c", "docker/login-action@af1e73f918a031802d376d3c8bbc3fe56130a9b0", "docker/metadata-action@dc802804100637a589fabce1cb79ff13a1411302", "docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a"]);
const actionRefs = (source) => [...source.matchAll(/\buses:\s*([^\s,}]+)/g)].map((match) => match[1]);
function workflowStep(workflow, name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const next = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, next === -1 ? workflow.length : next);
}
function workflowJob(workflow, name) {
  const headers = [...workflow.matchAll(/^  ([a-z0-9-]+):\s*$/gm)];
  const index = headers.findIndex((match) => match[1] === name);
  assert.notEqual(index, -1, `missing workflow job: ${name}`);
  const start = headers[index].index;
  const end = headers[index + 1]?.index ?? workflow.length;
  return workflow.slice(start, end);
}
test("Docker release binds frozen packages and stable evaluation authority", () => {
  const workflow = read(".github/workflows/docker.yml");
  const verifyJob = workflowJob(workflow, "verify");
  const workflowEvidence = workflowStep(workflow, "Fetch sanitized stable workflow evidence");
  const packageSupport = read("scripts/ci/release-package-artifacts.sh");
  const frozenPackages = [
    ["https://github.com/ostinatocc/aionis-cli.git", "external/aionis-cli", "CLI"],
    ["https://github.com/ostinatocc/aionis-create.git", "external/aionis-create", "CREATE"],
    ["https://github.com/ostinatocc/aionis-sdk.git", "external/aionis-sdk", "SDK"],
    ["https://github.com/ostinatocc/AionisManifest.git", "external/AionisManifest", "MANIFEST"],
    ["https://github.com/ostinatocc/aionis-mcp.git", "external/aionis-mcp", "MCP"],
    ["https://github.com/ostinatocc/aionis-aifs.git", "external/aionis-aifs", "AIFS"],
    ["https://github.com/ostinatocc/aionis-claude-code.git", "external/aionis-claude-code", "CLAUDE_CODE"],
    ["https://github.com/ostinatocc/AionisSubstrate.git", "external/AionisSubstrate", "SUBSTRATE"],
  ];
  assert.match(verifyJob, /--check\s*\\?\s*\n\s*--require-package-roots/);
  assert.match(verifyJob, /release-package-artifacts\.sh checkout release-train\.json external/);
  assertMatches(workflowEvidence, [
    /if: steps\.release-metadata\.outputs\.release_status == 'stable'/,
    /EVALS_ACTIONS_READ_TOKEN: \$\{\{ secrets\.AIONIS_EVALS_ACTIONS_READ_TOKEN \}\}/,
    /Authorization: `Bearer \$\{token\}`/,
    /schema_version: "aionis_workflow_run_evidence_v1"/,
    /actions\/runs\/\$\{encodeURIComponent\(String\(producer\.run_id\)\)\}\/artifacts/,
    /artifacts,[\s\S]*assets,[\s\S]*release: releaseEvidence/,
    /mode: 0o600, flag: "wx"/,
  ]);
  assert.ok(workflowEvidence.indexOf("path is invalid") < workflowEvidence.indexOf("await fetch"));
  assert.ok(workflowEvidence.indexOf("run identity is invalid") < workflowEvidence.indexOf("await fetch"));
  assert.equal((workflow.match(/secrets\.AIONIS_EVALS_ACTIONS_READ_TOKEN/g) ?? []).length, 1);
  assert.match(verifyJob, /AIONIS_RELEASE_WORKFLOW_EVIDENCE: .*aionis-workflow-evidence\.json/);
  for (const [repository, checkoutPath, envKey] of frozenPackages) {
    assert.ok(packageSupport.includes(repository), `missing checkout contract for ${repository}`);
    assert.ok(
      verifyJob.includes(`AIONIS_RELEASE_${envKey}_REPO: \${{ github.workspace }}/${checkoutPath}`),
      `missing ${repository} release-gate root`,
    );
  }
  assert.match(packageSupport, /entry\?\.repository !== repository/);
  assert.match(packageSupport, /entry\?\.source_ref/);
  assert.match(packageSupport, /entry\?\.source_commit/);
  assert.match(packageSupport, /git -C "\$\{target\}" status --porcelain=v1 --untracked-files=all/);
  assert.match(
    packageSupport,
    /verifier\?\.repository !== "https:\/\/github\.com\/ostinatocc\/AionisRuntime-evals\.git"/,
  );
  assert.match(packageSupport, /verifier\?\.source_ref !== verifier\?\.source_commit/);
  assert.match(packageSupport, /"AionisRuntime-evals"/);
  assert.match(
    verifyJob,
    /AIONIS_RELEASE_EVALUATION_REPO: \$\{\{ steps\.release-metadata\.outputs\.release_status == 'stable' && format\('\{0\}\/external\/AionisRuntime-evals', github\.workspace\) \|\| '' \}\}/,
  );
  assert.equal(
    (verifyJob.match(/persist-credentials: false/g) ?? []).length,
    1,
    "the only checkout action must not persist Runtime credentials",
  );
});
test("fresh install uses stable authority without an override and candidate exact-source overrides", () => {
  const workflow = read(".github/workflows/docker.yml");
  const publishedCreateVerifier = read("scripts/ci/release-package-artifacts.sh");
  const install = workflowStep(workflow, "Fresh install through the declared installer authority");
  const stableStart = install.indexOf('if [[ "${RELEASE_STATUS}" == "stable" ]]');
  const elseStart = install.indexOf("\n          else", stableStart);
  const end = install.indexOf("\n          fi", elseStart);
  assert.notEqual(stableStart, -1, "missing stable installer branch");
  assert.notEqual(elseStart, -1, "missing candidate installer branch");
  assert.notEqual(end, -1, "missing installer branch terminator");
  const stableBranch = install.slice(stableStart, elseStart);
  const candidateBranch = install.slice(elseStart, end);
  assertMatches(stableBranch, [
    /public_create_spec="@aionis\/create@\$\{CREATE_VERSION\}"/,
    /release-package-artifacts\.sh verify-published-create/,
    /"\$\{public_create_spec\}" "\$\{CREATE_VERSION\}" "\$\{CREATE_COMMIT\}" "\$\{LOCAL_CREATE_SPEC\}"/,
    /AIONIS_FRESH_INSTALL_CREATE_SPEC=\$\{public_create_spec\}/,
  ]);
  assertOmits(stableBranch, [/AIONIS_FRESH_INSTALL_CREATE_SPEC=\$\{LOCAL_CREATE_SPEC\}/, /AIONIS_FRESH_INSTALL_(?:RUNTIME_REF|VERIFIED_RUNTIME_SOURCE)/]);
  assertMatches(candidateBranch, [/AIONIS_FRESH_INSTALL_CREATE_SPEC=\$\{LOCAL_CREATE_SPEC\}/, /AIONIS_FRESH_INSTALL_RUNTIME_REF=\$\{RUNTIME_TAG\}/, /AIONIS_FRESH_INSTALL_VERIFIED_RUNTIME_SOURCE=\$\{GITHUB_WORKSPACE\}/]);
  assertOmits(install, [/AIONIS_FRESH_INSTALL_REPO/]);
  assertMatches(publishedCreateVerifier, [
    /npm view "\$\{create_spec\}" name version gitHead --json/,
    /value\?\.gitHead !== process\.env\.EXPECTED_COMMIT/,
    /npm pack --silent --pack-destination/,
    /diff --recursive --brief --no-dereference/,
    /-L "\$\{frozen_tarball\}"/,
  ]);
});
test("release verification uses the exact tag and local verification harnesses", () => {
  const workflow = read(".github/workflows/docker.yml");
  const verifyJob = workflowJob(workflow, "verify");
  assertMatches(verifyJob, [
    /name: Checkout Runtime[\s\S]*?ref: \$\{\{ inputs\.release_ref \}\}[\s\S]*?fetch-depth: 0/,
    /GITHUB_REF\}" != "refs\/heads\/main"[\s\S]*?GITHUB_SHA\}" != "\$\{main_commit\}"/,
    /name: Verify release and workflow commits are current protected main[\s\S]*?"\$\{release_commit\}" != "\$\{main_commit\}"/,
    /actual_tag="\$\(git describe --tags --exact-match HEAD\)"[\s\S]*?test "\$\{actual_tag\}" = "\$\{AIONIS_RELEASE_EXPECTED_TAG\}"/,
    /npm pack --silent --pack-destination "\$\{PACK_DIR\}"/,
    /AIONIS_RUNTIME_REPO="\$\{GITHUB_WORKSPACE\}"/,
    /node --import tsx "\$\{GITHUB_WORKSPACE\}\/scripts\/e2e\/external-package-entrypoint-smoke\.ts"/,
    /harness="\$\{GITHUB_WORKSPACE\}\/scripts\/e2e\/fresh-install-smoke\.ts"/,
    /^        run: npm run -s lite:test:static$/m,
    /^        run: npm run -s lite:test:core:manifest$/m,
  ]);
  assertOmits(verifyJob, [/git merge-base --is-ancestor|git rev-list/, /release-harness|Checkout dispatch verification harness/, /^        run: npm run -s lite:test$/m]);
});

test("Docker build produces one verified digest before immutable publication", () => {
  const workflow = read(".github/workflows/docker.yml");
  const verifyJob = workflowJob(workflow, "verify");
  const releaseTests = workflowJob(workflow, "release-tests");
  const publishJob = workflowJob(workflow, "publish");
  const buildStep = workflowStep(workflow, "Build immutable amd64 release artifact");
  const buildActions = workflow.match(/uses: docker\/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a/g) ?? [];
  assert.equal(buildActions.length, 1, "release workflow must perform one image build");
  assertMatches(releaseTests, [/max-parallel: 9/, /suite: core/, /suite: recovery/, /lite:test:\$\{\{ matrix\.suite \}\}:\$\{\{ matrix\.shard \}\}/, /persist-credentials: false/]);
  assertMatches(publishJob, [
    /^    needs: \[verify, release-tests\]$/m, /needs\.verify\.result == 'success'/,
    /needs\['release-tests'\]\.result == 'success'/,
    /^    outputs:\n      verified_digest: \$\{\{ steps\.promote\.outputs\.verified_digest \}\}$/m,
    /name: \$\{\{ needs\.verify\.outputs\.release_status == 'stable' && 'stable-release' \|\| 'candidate-release' \}\}/,
    /concurrency:\n      group: ghcr-aionis-publisher\n      queue: max\n      cancel-in-progress: false/,
    /uses: docker\/metadata-action@dc802804100637a589fabce1cb79ff13a1411302/, /labels: \$\{\{ steps\.metadata\.outputs\.labels \}\}/,
  ]);
  assertMatches(buildStep, [
    /tags: \$\{\{ steps\.build-subject\.outputs\.ref \}\}/,
    /provenance: mode=max/, /sbom: true/, /platforms: linux\/amd64/,
  ]);
  assertMatches(publishJob, [/org\.opencontainers\.image\.version=\$\{\{ needs\.verify\.outputs\.runtime_tag \}\}/, /org\.opencontainers\.image\.revision=\$\{\{ needs\.verify\.outputs\.runtime_commit \}\}/]);
  assertOmits(verifyJob, [/packages: write|docker\/login-action|push: true/]);
  assertOmits(buildStep, [/tags: \$\{\{ steps\.metadata\.outputs\.tags \}\}/, /linux\/arm64/, /version_ref|latest_ref|REGISTRY_IMAGE\}:latest/]);
});

test("immutable version promotion is idempotent, fail-closed, and digest-preserving", () => {
  const workflow = read(".github/workflows/docker.yml");
  const versionStep = workflowStep(workflow, "Promote and verify the immutable version tag");
  assertMatches(versionStep, [
    /VERIFIED_DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/,
    /grep -Fqx "ERROR: \$\{version_ref\}: not found" "\$\{inspect_error\}"/,
    /grep -Fqx "ERROR: \$\{version_ref\}: manifest unknown" "\$\{inspect_error\}"/,
    /failed to inspect immutable \$\{version_ref\}/, /refusing to replace existing/,
    /\[\[ "\$\{existing_digest\}" == "\$\{VERIFIED_DIGEST\}" \]\] \|\| docker buildx imagetools create --tag "\$\{version_ref\}" "\$\{verified_image\}"/,
    /promoted_digest[\s\S]*VERIFIED_DIGEST/,
    /echo "verified_digest=\$\{VERIFIED_DIGEST\}" >> "\$\{GITHUB_OUTPUT\}"/,
  ]);
  assertOmits(versionStep, [/grep -E|grep -q|manifest unknown\|not found/, /latest_ref|REGISTRY_IMAGE\}:latest/]);
});

test("stable latest promotion follows verified immutable version promotion", () => {
  const workflow = read(".github/workflows/docker.yml");
  const publishJob = workflowJob(workflow, "publish");
  const latestStep = workflowStep(workflow, "Promote latest only from the expected stable predecessor");
  assertMatches(latestStep, [
    /if: needs\.verify\.outputs\.release_status == 'stable'/,
    /AUTHORIZED: \$\{\{ needs\.verify\.outputs\.stable_promotion_authorized \}\}/,
    /TARGET_DIGEST: \$\{\{ steps\.promote\.outputs\.verified_digest \}\}/,
    /\[\[ "\$\{AUTHORIZED\}" == "true" \]\] \|\| \{ echo "stable latest promotion authority is missing" >&2; exit 1; \}/,
  ]);
  assertMatches(publishJob, [/packages: write/, /name: \$\{\{ needs\.verify\.outputs\.release_status == 'stable' && 'stable-release' \|\| 'candidate-release' \}\}/]);
  assertOmits(latestStep, [/docker\/build-push-action|push: true/]);
  for (const label of [
    "version",
    "revision",
    "source",
    "url",
    "title",
    "licenses",
    "created",
    "description",
  ]) {
    assert.ok(
      latestStep.includes(`org.opencontainers.image.${label}`),
      `latest promotion must verify OCI ${label}`,
    );
  }
  assertMatches(latestStep, [/previous latest version tag/, /stable latest version must advance monotonically/, /current_digest[\s\S]*PREVIOUS_DIGEST[\s\S]*prewrite_digest/, /docker buildx imagetools create --tag "\$\{latest_ref\}"/, /promoted_digest[\s\S]*TARGET_DIGEST[\s\S]*PREVIOUS_DIGEST/]);
});
test("exact-main embedding evidence is manual, protected, and commit-bound", () => {
  const workflow = read(".github/workflows/exact-main-embedding-smoke.yml");
  assert.match(workflow, /^on:\n  workflow_dispatch:\n    inputs:\n      expected_sha:/m);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|schedule):/m);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /^    environment: exact-main-embedding$/m);
  assert.match(
    workflow,
    /name: Checkout expected Runtime commit[\s\S]*?ref: \$\{\{ inputs\.expected_sha \}\}/,
  );
  assert.match(workflow, /test "\$\{actual_commit\}" = "\$\{EXPECTED_SHA\}"/);
  assert.match(workflow, /test "\$\{main_commit\}" = "\$\{EXPECTED_SHA\}"/);
  assert.match(workflow, /exact-main embedding release evidence requires candidate or stable status/);
  assert.match(workflow, /^          DASHSCOPE_API_KEY: \$\{\{ secrets\.DASHSCOPE_API_KEY \}\}$/m);
  assert.equal(
    (workflow.match(/secrets\.DASHSCOPE_API_KEY/g) ?? []).length,
    1,
    "provider credential must enter only the real smoke step",
  );
  assert.match(workflow, /^          EMBEDDING_PROVIDER: dashscope$/m);
  assert.match(workflow, /^          DASHSCOPE_EMBEDDING_MODEL: qwen3\.7-text-embedding$/m);
  assert.match(workflow, /^          EMBEDDING_DIM: "1536"$/m);
  assert.doesNotMatch(workflow, /set -x|upload-artifact/);
});

test("release workflows preserve focused Runtime boundaries", () => {
  const dockerWorkflow = read(".github/workflows/docker.yml");
  const ciWorkflow = read(".github/workflows/ci.yml");
  const dockerIgnore = read(".dockerignore");
  const gitIgnore = read(".gitignore");
  const workflows = new Map(fs.readdirSync(path.join(ROOT, ".github/workflows")).filter((file) => file.endsWith(".yml")).map((file) => [file, read(`.github/workflows/${file}`)]));
  const refs = [...workflows.values()].flatMap(actionRefs);
  for (const ref of refs) assert.equal(TRUSTED_ACTIONS.has(ref), true, `untrusted or mutable workflow action: ${ref}`);
  assert.deepEqual([...new Set(refs)].sort(), [...TRUSTED_ACTIONS].sort());
  assert.deepEqual([...workflows].filter(([, source]) => /packages:\s*write/.test(source)).map(([file]) => file), ["docker.yml"]);
  assert.equal((dockerWorkflow.match(/packages:\s*write/g) ?? []).length, 1);
  assert.equal((dockerWorkflow.match(/docker\/login-action@af1e73f918a031802d376d3c8bbc3fe56130a9b0/g) ?? []).length, 1);
  assert.match(workflowJob(dockerWorkflow, "publish"), /packages:\s*write[\s\S]*docker\/login-action@af1e73f918a031802d376d3c8bbc3fe56130a9b0/);
  assert.doesNotMatch(dockerWorkflow, /^  promote-(?:version|latest):/m);
  assert.match(dockerWorkflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(dockerWorkflow, /^  (?:push|pull_request|schedule):/m);
  assert.match(dockerIgnore, /^\/external$/m);
  assert.match(gitIgnore, /^\/external\/$/m);
  assert.match(dockerWorkflow, /release-artifact-gate\.mjs[\s\\]*--check/);
  assert.match(ciWorkflow, /release-package-artifacts\.sh checkout release-train\.json external\/release-artifacts/);
  assert.match(ciWorkflow, /release-artifact-gate\.mjs --check --pretag --require-package-roots/);
  assert.match(ciWorkflow, /AIONIS_RELEASE_CREATE_REPO: .*release-artifacts\/aionis-create/);
  assert.match(ciWorkflow, /AIONIS_RELEASE_EVALUATION_REPO: .*release-artifacts\/AionisRuntime-evals/);
  assert.match(ciWorkflow, /npm run -s complexity:check/);
  assert.match(ciWorkflow, /npm run -s lite:smoke/);
});

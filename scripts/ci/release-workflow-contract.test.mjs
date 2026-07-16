import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

function workflowStep(workflow, name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const next = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, next === -1 ? workflow.length : next);
}

test("Docker release verifies all frozen package repositories before publication", () => {
  const workflow = read(".github/workflows/docker.yml");
  const frozenPackages = [
    ["cli", "ostinatocc/aionis-cli", "external/aionis-cli", "CLI"],
    ["create", "ostinatocc/aionis-create", "external/aionis-create", "CREATE"],
    ["sdk", "ostinatocc/aionis-sdk", "external/aionis-sdk", "SDK"],
    ["manifest", "ostinatocc/AionisManifest", "external/AionisManifest", "MANIFEST"],
    ["mcp", "ostinatocc/aionis-mcp", "external/aionis-mcp", "MCP"],
    ["aifs", "ostinatocc/aionis-aifs", "external/aionis-aifs", "AIFS"],
    ["claude_code", "ostinatocc/aionis-claude-code", "external/aionis-claude-code", "CLAUDE_CODE"],
    ["substrate", "ostinatocc/AionisSubstrate", "external/AionisSubstrate", "SUBSTRATE"],
  ];

  assert.match(workflow, /--check\s*\\?\s*\n\s*--require-package-roots/);
  assert.match(
    workflow,
    /^      AIONIS_SDK_REPO: \$\{\{ github\.workspace \}\}\/external\/aionis-sdk$/m,
  );
  assert.match(
    workflow,
    /^      AIONIS_MANIFEST_REPO: \$\{\{ github\.workspace \}\}\/external\/AionisManifest$/m,
  );
  assert.equal(
    (workflow.match(/^\s+AIONIS_SDK_REPO:/gm) ?? []).length,
    1,
    "the complete verify job must receive the exact SDK repository variable",
  );
  assert.equal(
    (workflow.match(/^\s+AIONIS_MANIFEST_REPO:/gm) ?? []).length,
    1,
    "the complete verify job must receive the exact Manifest repository variable",
  );
  assert.match(
    workflow,
    /for \(const key of \["cli", "create", "sdk", "manifest", "mcp", "aifs", "claude_code", "substrate"\]\)/,
  );
  assert.match(
    workflow,
    /name: Verify standalone Manifest\s*\n\s*working-directory: external\/AionisManifest[\s\S]*?npm run -s verify/,
  );
  for (const [key, repository, checkoutPath, envKey] of frozenPackages) {
    assert.ok(workflow.includes(`repository: ${repository}`), `missing ${key} repository checkout`);
    assert.ok(
      workflow.includes(`ref: \${{ steps.release-metadata.outputs.${key}_ref }}`),
      `missing exact ${key} source_ref checkout`,
    );
    assert.ok(workflow.includes(`path: ${checkoutPath}`), `missing ${key} checkout path`);
    assert.ok(
      workflow.includes(`AIONIS_RELEASE_${envKey}_REPO: \${{ github.workspace }}/${checkoutPath}`),
      `missing ${key} release-gate root`,
    );
  }
});

test("Docker image is built once, smoked by digest, and only then promoted", () => {
  const workflow = read(".github/workflows/docker.yml");
  const buildActions = workflow.match(/uses: docker\/build-push-action@v6/g) ?? [];

  assert.match(workflow, /^  verify:\s*$/m);
  assert.match(workflow, /^    needs: verify\s*$/m);
  assert.match(workflow, /release_ref:[\s\S]*required: true[\s\S]*publish:[\s\S]*default: false/);
  assert.match(workflow, /group: docker-release-/);
  assert.match(workflow, /ref: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.release_ref \|\| github\.ref_name \}\}/);
  assert.match(workflow, /name: Verify release commit is on main first-parent history/);
  assert.match(workflow, /\+refs\/heads\/main:refs\/remotes\/origin\/main/);
  assert.match(workflow, /git rev-list --first-parent "\$\{main_commit\}"/);
  assert.match(workflow, /grep -F -x "\$\{release_commit\}"/);
  assert.doesNotMatch(workflow, /git merge-base --is-ancestor/);
  assert.match(workflow, /--expect-tag "\$\{AIONIS_RELEASE_EXPECTED_TAG\}"/);
  assert.match(workflow, /runtime_commit: \$\{\{ steps\.release-metadata\.outputs\.runtime_commit \}\}/);
  assert.match(workflow, /AIONIS_FRESH_INSTALL_RUNTIME_REF="\$\{\{ steps\.release-metadata\.outputs\.runtime_tag \}\}"/);
  assert.match(workflow, /^    permissions:\s*\n      contents: read\s*\n      packages: write$/m);
  assert.doesNotMatch(workflow, /^  packages: write$/m);
  assert.match(workflow, /release-artifact-gate\.mjs[\s\\]*--check/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.publish == true/);
  assert.match(workflow, /npm run -s lite:test/);
  assert.match(workflow, /external-package-entrypoint-smoke\.ts/);
  assert.match(workflow, /fresh-install-smoke\.ts/);
  assert.match(workflow, /docker-release-smoke\.sh/);
  assert.equal(buildActions.length, 1, "release workflow must perform one container build");
  assert.match(workflow, /platforms: linux\/amd64(?:\s|$)/);
  assert.doesNotMatch(workflow, /linux\/arm64/);
  assert.match(workflow, /ref: \$\{\{ needs\.verify\.outputs\.runtime_tag \}\}/);
  assert.match(workflow, /test "\$\{actual_commit\}" = "\$\{EXPECTED_RUNTIME_COMMIT\}"/);
  assert.match(workflow, /name: Define immutable provenance subject/);
  assert.match(
    workflow,
    /subject_tag="build-\$\{RUNTIME_TAG\}-\$\{RUNTIME_COMMIT\}-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/,
  );
  assert.match(workflow, /tags: \$\{\{ steps\.build-subject\.outputs\.ref \}\}/);
  assert.match(workflow, /push: true/);
  assert.doesNotMatch(workflow, /push-by-digest=true/);
  assert.doesNotMatch(
    workflow,
    /tags: \$\{\{ steps\.meta\.outputs\.tags \}\}/,
    "formal release tags must not exist before digest smoke passes",
  );
  assert.match(
    workflow,
    /VERIFIED_IMAGE_REF: \$\{\{ env\.REGISTRY_IMAGE \}\}@\$\{\{ steps\.build\.outputs\.digest \}\}/,
  );
  assert.match(workflow, /docker buildx imagetools create/);
  assert.match(workflow, /type=raw,value=\$\{\{ needs\.verify\.outputs\.runtime_tag \}\}/);
  assert.doesNotMatch(workflow, /type=ref,event=tag/);
  assert.match(workflow, /org\.opencontainers\.image\.revision=\$\{\{ needs\.verify\.outputs\.runtime_commit \}\}/);
  assert.match(workflow, /refusing to replace existing/);
  assert.match(workflow, /promoted_digest[\s\S]*VERIFIED_DIGEST/);
  assert.ok(
    workflow.indexOf("Verify release commit is on main first-parent history") <
      workflow.indexOf("Read immutable package refs"),
    "the release tag must be proven merged before release metadata is trusted",
  );
  assert.ok(
    workflow.indexOf("Smoke the exact published digest") <
      workflow.indexOf("Promote the verified digest to release tags"),
    "promotion must happen after exact-digest smoke",
  );
  assert.match(workflow, /publish_latest == 'true'/);
  assert.match(workflow, /provenance: mode=max/);
  assert.match(workflow, /sbom: true/);
  assert.doesNotMatch(workflow, /type=raw,value=latest,enable=\$\{\{ startsWith/);
  assert.ok(
    workflow.indexOf("Verify immutable build subject digest") <
      workflow.indexOf("Smoke the exact published digest"),
    "the immutable provenance subject must resolve to the built digest before smoke",
  );
});

test("cross-package release gates install tarballs packed from exact checkouts", () => {
  const workflow = read(".github/workflows/docker.yml");
  const smoke = read("scripts/e2e/external-package-entrypoint-smoke.ts");

  assert.match(workflow, /name: Checkout dispatch verification harness[\s\S]*ref: \$\{\{ github\.sha \}\}[\s\S]*path: external\/release-harness/);
  assert.match(workflow, /git -C external\/release-harness rev-parse HEAD/);
  assert.match(workflow, /git -C external\/release-harness diff --name-only "\$\{EXPECTED_RUNTIME_COMMIT\}" "\$\{actual_harness_commit\}"/);
  assert.match(workflow, /dispatch harness contains non-verification change/);
  assert.match(workflow, /^        id: package-artifacts$/m);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /npm pack --silent --pack-destination "\$\{PACK_DIR\}"/);
  assert.match(workflow, /AIONIS_RUNTIME_REPO="\$\{GITHUB_WORKSPACE\}"/);
  for (const [name, checkout] of [
    ["sdk", "aionis-sdk"],
    ["mcp", "aionis-mcp"],
    ["create", "aionis-create"],
  ]) {
    assert.match(
      workflow,
      new RegExp(`pack_exact ${name} "\\$\\{GITHUB_WORKSPACE\\}/external/${checkout}"`),
    );
    assert.match(
      workflow,
      new RegExp(`AIONIS_EXTERNAL_SMOKE_${name === "create" ? "CREATE" : name.toUpperCase()}_SPEC="\\$\\{\\{ steps\\.package-artifacts\\.outputs\\.${name}_spec \\}\\}"`),
    );
    assert.match(
      workflow,
      new RegExp(`AIONIS_FRESH_INSTALL_${name === "create" ? "CREATE" : name.toUpperCase()}_SPEC="\\$\\{\\{ steps\\.package-artifacts\\.outputs\\.${name}_spec \\}\\}"`),
    );
  }
  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' && 'external\/release-harness\/scripts\/e2e\/external-package-entrypoint-smoke\.ts'/,
  );
  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' && 'external\/release-harness\/scripts\/e2e\/fresh-install-smoke\.ts'/,
  );
  assert.match(workflow, /node --import tsx src\/index\.ts >"\$\{runtime_log\}" 2>&1 &/);
  assert.match(workflow, /AIONIS_EXTERNAL_SMOKE_EMBEDDING_EXPECTATION=unavailable/);
  assert.match(workflow, /setsid npm run -s lite:smoke &/);
  assert.match(workflow, /kill -TERM -- "-\$\{smoke_pid\}"/);
  assert.match(workflow, /kill -KILL -- "-\$\{smoke_pid\}"/);
  assert.doesNotMatch(workflow, /AIONIS_(?:EXTERNAL_SMOKE|FRESH_INSTALL)_(?:SDK|MCP|CREATE)_SPEC="\$\{GITHUB_WORKSPACE\}\/external\//);
  assert.match(smoke, /client\.resolveMemory\(/);
  assert.match(smoke, /client\.execution\.handoff\(/);
  assert.match(smoke, /client\.execution\.guideForRole\(/);
  assert.match(smoke, /planning_context_embedding_unavailable/);
  assert.match(smoke, /full_power_agent_context_merge/);
  assert.match(smoke, /const measureOperationId = "external-package-sdk-measure:" \+ runId/);
  assert.match(smoke, /measure\.operation_id === measureOperationId/);
  assert.match(smoke, /measure\.measurement_persisted === true/);
  assert.match(smoke, /JSON\.stringify\(measureReplay\) === JSON\.stringify\(measure\)/);
  const freshInstallSmoke = read("scripts/e2e/fresh-install-smoke.ts");
  assert.match(freshInstallSmoke, /spawn\(process\.execPath, \["--import", "tsx", "src\/index\.ts"\]/);
  assert.match(freshInstallSmoke, /await closeRuntime\(runtime\)/);
  assert.match(freshInstallSmoke, /child\.once\("close"/);
  assert.match(freshInstallSmoke, /child\.kill\("SIGKILL"\)/);
});

test("Docker context excludes external release checkouts", () => {
  const dockerIgnore = read(".dockerignore");
  assert.match(dockerIgnore, /^\/external$/m);
});

test("release smoke rejects mutable image tags before invoking Docker", () => {
  const smokeScript = read("scripts/ci/docker-release-smoke.sh");
  assert.doesNotMatch(smokeScript, /docker build/);
  assert.match(smokeScript, /docker pull --platform linux\/amd64/);
  assert.match(smokeScript, /AIONIS_DOCKER_SMOKE_ATTEMPTS:-90/);
  assert.match(smokeScript, /AIONIS_DOCKER_SMOKE_HEALTH_TIMEOUT:-5s/);
  assert.match(smokeScript, /--health-timeout "\$\{HEALTH_TIMEOUT\}"/);
  assert.match(smokeScript, /base \+ "\/health"/);
  assert.match(smokeScript, /hasOwn\(readyBody\.checks, "learning_control_worker"\)/);
  assert.match(smokeScript, /runtimeHealthBody\?\.lite\?\.stores\?\.learning_control_worker/);
  assert.match(smokeScript, /learningControl\.last_succeeded_at/);
  assert.match(smokeScript, /\["pending", "leased", "expired_leases", "completed", "dead_letter", "exhausted"\]/);
  assert.match(smokeScript, /learningControlBacklog\.exhausted !== 0/);

  const result = spawnSync("bash", ["scripts/ci/docker-release-smoke.sh", "aionis:mutable"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires an immutable image digest/);
});

test("default CI verifies release metadata, SDK and Manifest ownership, complexity, smoke, and minimum Node", () => {
  const workflow = read(".github/workflows/ci.yml");
  const contractCheckout = workflowStep(workflow, "Checkout standalone SDK contracts");
  const releaseCheckout = workflowStep(workflow, "Checkout frozen SDK release artifact");
  const releaseGate = workflowStep(workflow, "Release artifact gate");
  assert.match(workflow, /release-artifact-gate\.mjs --check/);
  assert.match(contractCheckout, /ref: \$\{\{ steps\.sdk-ref\.outputs\.contract_ref \}\}/);
  assert.match(contractCheckout, /path: external\/aionis-sdk/);
  assert.match(releaseCheckout, /ref: \$\{\{ steps\.sdk-ref\.outputs\.release_ref \}\}/);
  assert.match(releaseCheckout, /path: external\/release\/aionis-sdk/);
  assert.match(releaseGate, /AIONIS_RELEASE_SDK_REPO: \$\{\{ github\.workspace \}\}\/external\/release\/aionis-sdk/);
  assert.match(workflow, /AIONIS_SDK_REPO:.*external\/aionis-sdk/);
  assert.doesNotMatch(releaseGate, /AIONIS_RELEASE_SDK_REPO:.*external\/aionis-sdk$/m);
  assert.match(workflow, /id: manifest-ref/);
  assert.match(workflow, /releaseTrain\.packages\.manifest\.source_ref/);
  assert.match(workflow, /repository: ostinatocc\/AionisManifest/);
  assert.match(workflow, /ref: \$\{\{ steps\.manifest-ref\.outputs\.ref \}\}/);
  assert.match(workflow, /path: external\/AionisManifest/);
  assert.match(workflow, /AIONIS_MANIFEST_REPO:.*external\/AionisManifest/);
  assert.match(workflow, /AIONIS_RELEASE_MANIFEST_REPO:.*external\/AionisManifest/);
  assert.match(workflow, /name: Verify standalone Manifest[\s\S]*npm run -s verify/);
  assert.match(workflow, /npm run -s sdk:check/);
  assert.match(workflow, /npm run -s complexity:check/);
  assert.match(workflow, /npm run -s lite:smoke/);
  assert.match(workflow, /node-version: "22\.13\.0"/);
});

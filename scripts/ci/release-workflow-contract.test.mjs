import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

test("Docker release verifies all frozen package repositories before publication", () => {
  const workflow = read(".github/workflows/docker.yml");
  const frozenPackages = [
    ["cli", "ostinatocc/aionis-cli", "external/aionis-cli", "CLI"],
    ["create", "ostinatocc/aionis-create", "external/aionis-create", "CREATE"],
    ["sdk", "ostinatocc/aionis-sdk", "external/aionis-sdk", "SDK"],
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
  assert.equal(
    (workflow.match(/^\s+AIONIS_SDK_REPO:/gm) ?? []).length,
    1,
    "the complete verify job must receive the exact SDK repository variable",
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
  assert.match(workflow, /--expect-tag "\$\{AIONIS_RELEASE_EXPECTED_TAG\}"/);
  assert.match(workflow, /runtime_commit: \$\{\{ steps\.release-metadata\.outputs\.runtime_commit \}\}/);
  assert.match(workflow, /AIONIS_FRESH_INSTALL_RUNTIME_REF="\$\{\{ steps\.release-metadata\.outputs\.runtime_tag \}\}"/);
  assert.match(workflow, /^    permissions:\s*\n      contents: read\s*\n      packages: write$/m);
  assert.doesNotMatch(workflow, /^  packages: write$/m);
  assert.match(workflow, /release-artifact-gate\.mjs[\s\\]*--check/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.publish == true/);
  assert.match(workflow, /npm run -s lite:test/);
  assert.match(workflow, /runtime:smoke:external-packages/);
  assert.match(workflow, /runtime:smoke:fresh-install/);
  assert.match(workflow, /docker-release-smoke\.sh/);
  assert.equal(buildActions.length, 1, "release workflow must perform one container build");
  assert.match(workflow, /platforms: linux\/amd64(?:\s|$)/);
  assert.doesNotMatch(workflow, /linux\/arm64/);
  assert.match(workflow, /ref: \$\{\{ needs\.verify\.outputs\.runtime_tag \}\}/);
  assert.match(workflow, /test "\$\{actual_commit\}" = "\$\{EXPECTED_RUNTIME_COMMIT\}"/);
  assert.match(
    workflow,
    /outputs: type=image,name=\$\{\{ env\.REGISTRY_IMAGE \}\},push-by-digest=true,name-canonical=true,push=true/,
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
    workflow.indexOf("Smoke the exact published digest") <
      workflow.indexOf("Promote the verified digest to release tags"),
    "promotion must happen after exact-digest smoke",
  );
  assert.match(workflow, /publish_latest == 'true'/);
  assert.match(workflow, /provenance: mode=max/);
  assert.match(workflow, /sbom: true/);
  assert.doesNotMatch(workflow, /type=raw,value=latest,enable=\$\{\{ startsWith/);
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

  const result = spawnSync("bash", ["scripts/ci/docker-release-smoke.sh", "aionis:mutable"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires an immutable image digest/);
});

test("default CI verifies release metadata, SDK ownership, complexity, smoke, and minimum Node", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /release-artifact-gate\.mjs --check/);
  assert.match(workflow, /npm run -s sdk:check/);
  assert.match(workflow, /npm run -s complexity:check/);
  assert.match(workflow, /npm run -s lite:smoke/);
  assert.match(workflow, /node-version: "22\.5\.0"/);
});

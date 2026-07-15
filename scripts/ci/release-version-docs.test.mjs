import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const PACKAGE_NAMES = {
  cli: "aionis",
  create: "@aionis/create",
  sdk: "@aionis/sdk",
  mcp: "@aionis/mcp",
  aifs: "@aionis/aifs",
  claude_code: "@aionis/claude-code",
  substrate: "@aionis/substrate",
};
const RELEASE_STATUSES = new Set(["stable", "candidate", "development"]);

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function releaseTrain() {
  return readJson("release-train.json");
}

function workspaceRepository(name) {
  for (const candidate of [path.resolve(ROOT, "..", name), path.resolve(ROOT, "..", "..", name)]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertReleaseTableCell(source, artifact, expectedToken) {
  const pattern = new RegExp(`^\\|\\s*${escapeRegExp(artifact)}\\s*\\|\\s*([^|]+)\\|`, "m");
  const match = source.match(pattern);
  assert.ok(match, `missing release table row for ${artifact}`);
  assert.match(match[1], new RegExp(escapeRegExp(expectedToken)), `${artifact} release table version should include ${expectedToken}`);
}

test("release-train.json is the checked-in source for immutable release coordinates", () => {
  const train = releaseTrain();

  assert.equal(train.schema_version, "aionis_release_train_v1");
  assert.ok(RELEASE_STATUSES.has(train.status), "release status must be stable, candidate, or development");
  assert.match(train.runtime.version, /^\d+\.\d+\.\d+$/);
  assert.equal(train.runtime.source_tag, `v${train.runtime.version}`);
  assert.equal(train.runtime.docker_tag, train.runtime.source_tag);
  assert.deepEqual(train.runtime.docker_platforms, ["linux/amd64"]);
  assert.match(train.runtime.docker_image, /^ghcr\.io\//);
  assert.doesNotMatch(train.runtime.default_installer_ref, /^(main|master|latest|HEAD)$/i);
  if (train.status === "stable") {
    assert.equal(train.runtime.default_installer_ref, train.runtime.source_tag);
  }

  assert.deepEqual(Object.keys(train.packages).sort(), Object.keys(PACKAGE_NAMES).sort());
  for (const [key, expectedName] of Object.entries(PACKAGE_NAMES)) {
    assert.equal(train.packages[key].name, expectedName);
    assert.match(train.packages[key].version, /^\d+\.\d+\.\d+$/);
    assert.match(train.packages[key].source_commit, /^[a-f0-9]{40}$/i);
    assert.match(train.packages[key].repository, /^https:\/\/github\.com\//);
    assert.equal(typeof train.packages[key].package_path, "string");
    assert.notEqual(train.packages[key].package_path.trim(), "");
  }
  assert.equal(typeof train.packages.sdk.source_ref, "string");
  assert.notEqual(train.packages.sdk.source_ref.trim(), "", "SDK source ref must be explicit and non-empty");
});

test("runtime manifest and package metadata stay aligned with release-train.json", () => {
  const train = releaseTrain();
  const runtimeManifest = readJson("runtime-manifest.json");

  assert.equal(packageJson.version, train.runtime.version);
  assert.equal(runtimeManifest.release?.version, train.runtime.version);
  assert.equal(runtimeManifest.release?.status, train.status);
  assert.equal(runtimeManifest.release?.source_tag, train.runtime.source_tag);
  assert.equal(runtimeManifest.release?.docker_image, train.runtime.docker_image);
  assert.equal(runtimeManifest.release?.docker_tag, train.runtime.docker_tag);
  assert.deepEqual(runtimeManifest.release?.docker_platforms, train.runtime.docker_platforms);
  assert.equal(runtimeManifest.release?.default_installer_ref, train.runtime.default_installer_ref);
});

test("release docs derive all package and Runtime coordinates from release-train.json", () => {
  const train = releaseTrain();
  const releaseNotes = read("RELEASE_NOTES.md");
  const releaseDocs = read("docs/AIONIS_RELEASES.md");
  const patchNotesPath = `docs/releases/v${train.runtime.version}.md`;

  assert.ok(releaseNotes.includes(`# Aionis v${train.runtime.version}`));
  assert.ok(releaseDocs.includes(`Status: v${train.runtime.version}`));
  assert.ok(releaseDocs.includes(`./releases/v${train.runtime.version}.md`));
  assert.ok(fs.existsSync(path.join(ROOT, patchNotesPath)), `${patchNotesPath} must exist`);

  for (const entry of Object.values(train.packages)) {
    const token = `${entry.name}@${entry.version}`;
    assert.ok(releaseNotes.includes(token), `RELEASE_NOTES.md should mention ${token}`);
    assertReleaseTableCell(releaseDocs, `\`${entry.name}\``, `\`${entry.version}\``);
  }

  const dockerArtifact = `${train.runtime.docker_image}:${train.runtime.docker_tag}`;
  assert.ok(releaseNotes.includes(`Release status \`${train.status}\``));
  assert.ok(releaseNotes.includes(`Runtime source tag \`${train.runtime.source_tag}\``));
  assert.ok(releaseNotes.includes(`Docker image \`${dockerArtifact}\``));
  assert.ok(releaseNotes.includes(`Default installer Runtime ref \`${train.runtime.default_installer_ref}\``));
  assertReleaseTableCell(releaseDocs, "GitHub Runtime source", `\`${train.runtime.source_tag}\``);
  assertReleaseTableCell(releaseDocs, "Docker image", `\`${dockerArtifact}\``);
  assertReleaseTableCell(releaseDocs, "Default installer Runtime ref", `\`${train.runtime.default_installer_ref}\``);
});

const createRepository = workspaceRepository("aionis-create");
test("workspace @aionis/create default ref matches release-train.json", { skip: !createRepository }, () => {
  const train = releaseTrain();
  const createSource = fs.readFileSync(path.join(createRepository, "src/index.ts"), "utf8");
  assert.ok(
    createSource.includes(`export const DEFAULT_RUNTIME_REF = "${train.runtime.default_installer_ref}"`),
    "@aionis/create default Runtime ref must match release-train.json",
  );
});

test("release docs tag Runtime and explicitly hold the already-frozen installer", () => {
  const train = releaseTrain();
  const runtimeTagCommand = `git tag -a ${train.runtime.source_tag}`;
  const frozenInstallerMarker = `Do not republish \`${train.packages.create.name}@${train.packages.create.version}\``;

  for (const file of ["RELEASE_NOTES.md", "docs/AIONIS_RELEASES.md"]) {
    const source = read(file);
    assert.ok(source.includes(runtimeTagCommand), `${file} must include the Runtime tag command`);
    assert.ok(source.includes(frozenInstallerMarker), `${file} must explicitly hold the frozen Create package`);
    assert.doesNotMatch(
      source,
      /cd \/Volumes\/ziel\/new\.aionis\/aionis-create[\s\S]{0,160}npm publish/,
      `${file} must not instruct operators to republish the frozen Create package`,
    );
  }
});

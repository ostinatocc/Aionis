import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }
function readJson(rel) { return JSON.parse(read(rel)); }
function releaseTrain() { return readJson("release-train.json"); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function assertReleaseTableCell(source, artifact, expectedToken) {
  const pattern = new RegExp(`^\\|\\s*${escapeRegExp(artifact)}\\s*\\|\\s*([^|]+)\\|`, "m");
  const match = source.match(pattern);
  assert.ok(match, `missing release table row for ${artifact}`);
  assert.match(match[1], new RegExp(escapeRegExp(expectedToken)), `${artifact} release table version should include ${expectedToken}`);
}
test("release docs derive all package and Runtime coordinates from release-train.json", () => {
  const train = releaseTrain();
  const releaseNotes = read("RELEASE_NOTES.md");
  const releaseDocs = read("docs/AIONIS_RELEASES.md");
  const patchNotesPath = `docs/releases/v${train.runtime.version}.md`;
  assert.ok(releaseNotes.includes(`# Aionis v${train.runtime.version}`));
  assert.ok(releaseDocs.includes(`Status: v${train.runtime.version}`));
  assert.ok(releaseDocs.includes(`./releases/v${train.runtime.version}.md`));
  assert.ok(fs.existsSync(path.join(ROOT, patchNotesPath)), `${patchNotesPath} must exist`);
  const patchNotes = read(patchNotesPath);
  for (const entry of Object.values(train.packages)) {
    const token = `${entry.name}@${entry.version}`;
    assert.ok(releaseNotes.includes(token), `RELEASE_NOTES.md should mention ${token}`);
    assertReleaseTableCell(releaseDocs, `\`${entry.name}\``, `\`${entry.version}\``);
    assertReleaseTableCell(patchNotes, `\`${entry.name}\``, `\`${entry.version}\``);
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
test("published evidence receipts remain byte-for-byte immutable", () => {
  const receipts = [
    [
      "docs/releases/v0.3.11-publication-evidence.json",
      "05d4bd13155413ae840310a99065b4cda0a6b54a711ddb144e074916aef96540",
    ],
    [
      "docs/releases/v0.3.12-publication-evidence.json",
      "c72cf4e380b7ac66c6ac7f0a11982c9c5246672b0f345da398ef9a2aeec2b411",
    ],
  ];
  for (const [receiptPath, expectedHash] of receipts) {
    const actualHash = createHash("sha256").update(read(receiptPath)).digest("hex");
    assert.equal(actualHash, expectedHash, `${receiptPath} must not drift`);
  }
});

test("current release docs cite the immutable publication receipt and digest", () => {
  const train = releaseTrain();
  const receiptPath = `docs/releases/v${train.runtime.version}-publication-evidence.json`;
  if (!fs.existsSync(path.join(ROOT, receiptPath))) return;
  const receipt = readJson(receiptPath);
  const docs = [
    "README.md",
    "RELEASE_NOTES.md",
    "docs/AIONIS_INSTALL.md",
    "docs/AIONIS_RELEASES.md",
    `docs/releases/v${train.runtime.version}.md`,
  ];
  for (const file of docs) {
    assert.ok(read(file).includes(receiptPath), `${file} must cite ${receiptPath}`);
  }
  for (const file of docs.filter((file) => file !== "RELEASE_NOTES.md")) {
    assert.ok(
      read(file).includes(`${receipt.docker.image}@${receipt.docker.digest}`),
      `${file} must pin the published digest`,
    );
  }
});
test("public SDK version surfaces follow the frozen release-train coordinate", () => {
  const sdkVersion = releaseTrain().packages.sdk.version;
  const escapedVersion = escapeRegExp(sdkVersion);
  const expectations = [
    ["README.md", new RegExp(`SDK v${escapedVersion}`)],
    ["docs/AIONIS_SDK_QUICKSTART.md", new RegExp(`SDK v${escapedVersion}`)],
    ["docs/AIONIS_ADMISSION_DATASET_EXPORT_QUICKSTART.md", new RegExp(`SDK v${escapedVersion}`)],
    ["docs/examples/minimal-agent.ts", new RegExp(`SDK v${escapedVersion}`)],
    ["docs/AIONIS_PRODUCT_API_USAGE.md", new RegExp(`SDK\\s+\`${escapedVersion}\``)],
  ];
  for (const [file, pattern] of expectations) assert.match(read(file), pattern, `${file} must declare SDK ${sdkVersion}`);
});
test("release docs preserve the Runtime tag, frozen installer, and declared status", () => {
  const train = releaseTrain();
  const runtimeTagCommand = `git tag -a ${train.runtime.source_tag}`;
  const statusGuard = `test "$(node -p 'require("./release-train.json").status')" = "${train.status}"`;
  const localTagAbsenceGuard = `test -z "$(git tag --list ${train.runtime.source_tag})"`;
  const remoteTagAbsenceGuard = `test -z "$(git ls-remote --tags origin refs/tags/${train.runtime.source_tag} 'refs/tags/${train.runtime.source_tag}^{}')"`;
  if (train.status === "candidate") {
    assert.match(read("RELEASE_NOTES.md"), /gh release create[\s\S]*?--verify-tag[\s\S]*?--target "\$MAIN_COMMIT"[\s\S]*?--prerelease[\s\S]*?--latest=false[\s\S]*?--notes-file/, "candidate GitHub Release must target the verified commit as a non-latest prerelease");
    assert.doesNotMatch(read(`docs/releases/v${train.runtime.version}.md`), /not tagged or published yet|Future immutable tag|Future `linux\/amd64` artifact/, "candidate release notes must not retain development-only publication claims");
  } else if (train.status === "stable") {
    for (const file of ["RELEASE_NOTES.md", "docs/AIONIS_RELEASES.md"]) {
      const source = read(file);
      assert.match(source, /gh release create[\s\S]*?--latest(?:=true)?[\s\S]*?--notes-file/, `${file} must publish stable as latest`);
      assert.doesNotMatch(source, /gh release create[\s\S]*?--prerelease/, `${file} must not publish stable as a prerelease`);
    }
  }

  for (const file of ["RELEASE_NOTES.md", "docs/AIONIS_RELEASES.md"]) {
    const source = read(file);
    const tagIndex = source.indexOf(runtimeTagCommand);
    assert.ok(source.includes(runtimeTagCommand), `${file} must include the Runtime tag command`);
    assert.ok(source.includes("git fetch origin main --tags"), `${file} must refresh origin/main before tagging`);
    assert.ok(source.includes("git switch main"), `${file} must leave the release branch before tagging`);
    assert.ok(source.includes(`${runtimeTagCommand} "$MAIN_COMMIT"`), `${file} must tag the verified origin/main commit explicitly`);
    assert.match(source, /gh release create[\s\S]*?--target "\$MAIN_COMMIT"/, `${file} must target the verified commit when creating the GitHub Release`);
    for (const guard of ["set -euo pipefail", statusGuard, localTagAbsenceGuard, remoteTagAbsenceGuard]) {
      assert.ok(source.includes(guard), `${file} must include the pre-tag guard: ${guard}`);
      assert.ok(source.indexOf(guard) < tagIndex, `${file} must run the pre-tag guard before creating the tag: ${guard}`);
    }
    assert.ok(source.indexOf("docker-recovery-smoke.sh") > tagIndex, `${file} must run the combined recovery digest smoke after the tag workflow`);
    const crossVersionIndex = source.indexOf("docker-recovery-smoke.sh --cross-version");
    const releaseIndex = source.indexOf("gh release create");
    assert.ok(crossVersionIndex > source.indexOf("docker-recovery-smoke.sh"), `${file} must run the cross-version gate after ordinary recovery`);
    assert.ok(releaseIndex > crossVersionIndex, `${file} must create the GitHub release only after the cross-version gate`);
    assert.ok(source.includes('"$MAIN_COMMIT" "' + train.runtime.source_tag + '"'), `${file} must bind the cross-version gate to the exact commit and Runtime tag`);
    if (train.status === "candidate") {
      assert.ok(source.includes(`Do not republish \`${train.packages.create.name}@${train.packages.create.version}\``), `${file} must explicitly hold the frozen Create package`);
    }
    assert.doesNotMatch(source, /cd \/Volumes\/ziel\/new\.aionis\/aionis-create[\s\S]{0,160}npm publish/, `${file} must not instruct operators to republish the frozen Create package`);
  }
});

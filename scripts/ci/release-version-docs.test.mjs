import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const runtimeVersion = packageJson.version;
const runtimeTag = `v${runtimeVersion}`;
const dockerImage = `ghcr.io/ostinatocc/aionis:${runtimeTag}`;

const CURRENT_RELEASE_TRAIN = [
  { name: "aionis", version: "0.3.5", releaseNotesToken: "aionis@0.3.5" },
  { name: "@aionis/create", version: "0.3.4", releaseNotesToken: "@aionis/create@0.3.4" },
  { name: "@aionis/sdk", version: "0.3.8", releaseNotesToken: "@aionis/sdk@0.3.8" },
  { name: "@aionis/mcp", version: "0.3.2", releaseNotesToken: "@aionis/mcp@0.3.2" },
  { name: "@aionis/aifs", version: "0.3.0", releaseNotesToken: "@aionis/aifs@0.3.0" },
  {
    name: "@aionis/claude-code",
    releaseDocsArtifact: "`@aionis/claude-code` and Claude Code plugin",
    version: "0.3.1",
    releaseNotesToken: "@aionis/claude-code@0.3.1",
  },
  {
    name: "@aionis/substrate",
    version: "0.1.11",
    releaseNotesToken: "@aionis/substrate` remains an experimental sidecar/research package at\n`0.1.11`",
  },
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
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

test("current release docs stay aligned with the package train", () => {
  const releaseNotes = read("RELEASE_NOTES.md");
  const releaseDocs = read("docs/AIONIS_RELEASES.md");

  for (const entry of CURRENT_RELEASE_TRAIN) {
    assert.ok(releaseNotes.includes(entry.releaseNotesToken), `RELEASE_NOTES.md should mention ${entry.releaseNotesToken}`);
    assertReleaseTableCell(releaseDocs, entry.releaseDocsArtifact ?? `\`${entry.name}\``, `\`${entry.version}\``);
  }

  assert.ok(releaseNotes.includes(`Runtime source tag \`${runtimeTag}\``), "RELEASE_NOTES.md runtime tag should match package.json version");
  assert.ok(releaseNotes.includes(`Docker image \`${dockerImage}\``), "RELEASE_NOTES.md Docker image should match package.json version");
  assertReleaseTableCell(releaseDocs, "GitHub Runtime source", `\`${runtimeTag}\``);
  assertReleaseTableCell(releaseDocs, "Docker image", `\`${dockerImage}\``);
});

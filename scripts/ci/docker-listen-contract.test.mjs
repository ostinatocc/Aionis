import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("Docker build and runtime stages use the Node 24 baseline", () => {
  const dockerfile = read("Dockerfile");
  assert.match(
    dockerfile,
    /^# syntax=docker\/dockerfile:1\.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e$/m,
  );
  const pinnedNodeImage =
    "node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5";

  assert.match(dockerfile, new RegExp(`^FROM --platform=\\$BUILDPLATFORM ${pinnedNodeImage.replaceAll(".", "\\.")} AS verify$`, "m"));
  assert.match(dockerfile, new RegExp(`^FROM ${pinnedNodeImage.replaceAll(".", "\\.")} AS runtime-deps$`, "m"));
  assert.match(dockerfile, new RegExp(`^FROM ${pinnedNodeImage.replaceAll(".", "\\.")} AS runtime$`, "m"));
  assert.match(dockerfile, /COPY --from=verify \/tmp\/aionis-build-verified/);
  assert.match(dockerfile, /COPY --from=runtime-deps --chown=node:node \/app\/node_modules/);
});

test("Docker process listens on the container interface while host publishing stays loopback-only", () => {
  const dockerfile = read("Dockerfile");
  const compose = read("docker-compose.yml");

  assert.match(dockerfile, /AIONIS_LISTEN_HOST=0\.0\.0\.0/);
  assert.match(dockerfile, /AIONIS_ALLOW_UNAUTHENTICATED_REMOTE=true/);
  assert.match(compose, /["']127\.0\.0\.1:3001:3001["']/);
  assert.match(compose, /AIONIS_LISTEN_HOST:\s*0\.0\.0\.0/);
  assert.match(compose, /AIONIS_ALLOW_UNAUTHENTICATED_REMOTE:\s*["']true["']/);
});

test("Docker docs publish loopback securely and explain the namespace boundary", () => {
  const train = JSON.parse(read("release-train.json"));
  const dockerArtifact = `${train.runtime.docker_image}:${train.runtime.docker_tag}`;

  for (const file of ["README.md", "docs/AIONIS_INSTALL.md"]) {
    const source = read(file);
    assert.match(source, /-p 127\.0\.0\.1:3001:3001/);
    assert.ok(source.includes(dockerArtifact), `${file} must use the release-train Docker artifact`);
    assert.match(source, /container process[\s\S]{0,100}0\.0\.0\.0/i);
    assert.match(source, /host[\s\S]{0,100}127\.0\.0\.1/i);
  }
});

test("direct host installation keeps the loopback default", () => {
  const envExample = read(".env.example");
  const startScript = read("scripts/start-lite.sh");

  assert.match(envExample, /^AIONIS_LISTEN_HOST=127\.0\.0\.1$/m);
  assert.match(startScript, /AIONIS_LISTEN_HOST="\$\{AIONIS_LISTEN_HOST:-127\.0\.0\.1\}"/);
});

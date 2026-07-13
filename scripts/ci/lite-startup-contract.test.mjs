import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("root scripts start the focused Runtime directly", () => {
  const rootPkg = readJson(path.join(ROOT, "package.json"));
  assert.equal(rootPkg.scripts["lite:build"], "npm run -s typecheck");
  assert.equal(rootPkg.scripts["lite:start"], "bash scripts/start-lite.sh");
  assert.equal(rootPkg.scripts["lite:start:local-process"], "LITE_SANDBOX_PROFILE=local_process_echo bash scripts/start-lite.sh");
  assert.equal(rootPkg.scripts["lite:smoke:local-process"], "LITE_SANDBOX_PROFILE=local_process_echo bash scripts/lite-smoke.sh");
  assert.equal(rootPkg.scripts[`eval:${"real"}-llm`], undefined);
  assert.equal(rootPkg.scripts["sdk:build"], undefined);
  assert.equal(rootPkg.scripts["runtime:pack:dry-run"], undefined);
});

test("focused Runtime does not vendor adapter package entrypoints outside core startup", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "apps")), false, "apps wrapper should be deleted");
  assert.equal(fs.existsSync(path.join(ROOT, "examples")), false, "example wrappers should be deleted");

  const packagesDir = path.join(ROOT, "packages");
  assert.equal(fs.existsSync(packagesDir), false, "publishable SDK, MCP, installer, and plugin packages live in standalone repos");
});

test("root startup script owns local Runtime env", () => {
  const startScript = fs.readFileSync(path.join(ROOT, "scripts", "start-lite.sh"), "utf8");
  assert.match(startScript, /APP_ENV/);
  assert.match(startScript, /AIONIS_LISTEN_HOST/);
  assert.match(startScript, /AIONIS_ALLOW_UNAUTHENTICATED_REMOTE/);
  assert.match(startScript, /LITE_LOCAL_ACTOR_ID/);
  assert.match(startScript, /LITE_SANDBOX_PROFILE/);
  assert.match(startScript, /local_process_echo/);
  assert.match(startScript, /SANDBOX_ENABLED/);
  assert.match(startScript, /SANDBOX_ADMIN_ONLY/);
  assert.match(startScript, /node --experimental-sqlite -e/);
  assert.match(startScript, /NODE_SQLITE_FLAG="--experimental-sqlite"/);
  assert.match(startScript, /exec node "\$\{NODE_SQLITE_FLAG\}" --import tsx src\/index\.ts/);
  assert.match(startScript, /exec node --import tsx src\/index\.ts/);
  assert.doesNotMatch(startScript, /exec npx tsx/);
  assert.equal(startScript.includes(`apps${"/"}lite`), false);
  assert.equal(startScript.includes(`${"packages"}/`), false);
});

test("Lite smoke terminates the direct Runtime process with a bounded fallback", () => {
  const smokeScript = fs.readFileSync(path.join(ROOT, "scripts", "lite-smoke.sh"), "utf8");
  assert.match(smokeScript, /node --input-type=module - <<'JS' "\$\{BASE_URL\}"/);
  assert.match(smokeScript, /kill -TERM "\$\{PID\}"/);
  assert.match(smokeScript, /kill -KILL "\$\{PID\}"/);
  assert.match(smokeScript, /for _ in \$\(seq 1 50\)/);
  assert.match(smokeScript, /wait "\$\{PID\}"/);
});

test(".env.example exposes local Runtime knobs", () => {
  const envExample = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  assert.match(envExample, /^APP_ENV=dev$/m);
  assert.match(envExample, /^AIONIS_LISTEN_HOST=127\.0\.0\.1$/m);
  assert.match(envExample, /^# AIONIS_ALLOW_UNAUTHENTICATED_REMOTE=true$/m);
  assert.match(envExample, /^LITE_LOCAL_ACTOR_ID=local-user$/m);
  assert.match(envExample, /^SANDBOX_ENABLED=false$/m);
  assert.match(envExample, /^SANDBOX_ADMIN_ONLY=true$/m);
  assert.match(envExample, /^# LITE_SANDBOX_PROFILE=local_process_echo$/m);
});

test("Docker image binds inside its namespace for loopback-only host publishing", () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /AIONIS_LISTEN_HOST=0\.0\.0\.0/);
  assert.match(dockerfile, /AIONIS_ALLOW_UNAUTHENTICATED_REMOTE=true/);
});

test("runtime manifest points at the focused Runtime startup command", () => {
  const manifest = readJson(path.join(ROOT, "runtime-manifest.json"));
  assert.equal(manifest.runtime_id, "aionis-runtime-focused");
  assert.equal(manifest.start_command.command, "bash");
  assert.deepEqual(manifest.start_command.args, ["scripts/start-lite.sh"]);
  assert.equal(manifest.dist_entry, "src/index.ts");
});

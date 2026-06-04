#!/usr/bin/env bash
set -euo pipefail

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 1; }
}

need node
need curl

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

pick_free_port() {
  node - <<'JS'
const net = require("net");
async function canListen(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => server.close(() => resolve(true)));
  });
}
(async () => {
  for (let port = 3321; port < 3400; port += 1) {
    if (await canListen(port)) {
      process.stdout.write(String(port));
      return;
    }
  }
  process.exit(1);
})();
JS
}

CALLER_WORKDIR="${LITE_SMOKE_WORKDIR:-}"
if [[ -n "${CALLER_WORKDIR}" ]]; then
  mkdir -p "${CALLER_WORKDIR}"
  TMP_DIR="${CALLER_WORKDIR}"
  CLEANUP_TMP_DIR=0
else
  TMP_DIR="$(mktemp -d /tmp/aionis_lite_repo_smoke_XXXXXX)"
  CLEANUP_TMP_DIR=1
fi
PORT="${PORT:-$(pick_free_port)}"
BASE_URL="http://127.0.0.1:${PORT}"
LOG_FILE="${TMP_DIR}/lite-smoke.log"

cleanup() {
  if [[ -n "${PID:-}" ]]; then
    kill "${PID}" >/dev/null 2>&1 || true
    wait "${PID}" >/dev/null 2>&1 || true
  fi
  if [[ "${CLEANUP_TMP_DIR}" == "1" ]]; then
    rm -rf "${TMP_DIR}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

LITE_WRITE_SQLITE_PATH="${TMP_DIR}/write.sqlite" \
LITE_REPLAY_SQLITE_PATH="${TMP_DIR}/replay.sqlite" \
PORT="${PORT}" \
bash scripts/start-lite.sh >"${LOG_FILE}" 2>&1 &
PID=$!

ok=0
for _ in $(seq 1 60); do
  if curl -fsS "${BASE_URL}/health" > "${TMP_DIR}/health.json" 2>/dev/null; then
    ok=1
    break
  fi
  sleep 1
done

if [[ "${ok}" != "1" ]]; then
  echo "lite smoke health check failed" >&2
  cat "${LOG_FILE}" >&2 || true
  exit 1
fi

node - <<'JS' "${TMP_DIR}/health.json"
const fs = require("fs");
const health = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (health?.runtime?.edition !== "lite") {
  console.error(`expected lite edition, got ${health?.runtime?.edition}`);
  process.exit(1);
}
if (health?.storage?.backend !== "lite_sqlite") {
  console.error(`expected lite_sqlite backend, got ${health?.storage?.backend}`);
  process.exit(1);
}
const expectedMode = process.argv[3];
if (!health?.lite?.stores?.write || !health?.lite?.stores?.recall) {
  console.error("expected lite health stores for write and recall");
  process.exit(1);
}
console.log(JSON.stringify({
  ok: true,
  runtime: health.runtime,
  storage: { backend: health.storage.backend },
}, null, 2));
JS

node - <<'JS' "${BASE_URL}"
const base = process.argv[2];
const playbookId = "00000000-0000-0000-0000-000000000781";

async function post(path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    console.error(`${path} ${res.status}`);
    console.error(text);
    process.exit(1);
  }
  return json;
}

const runStart = await post("/v1/memory/replay/run/start", {
  goal: "lite replay smoke",
});
const stepBefore = await post("/v1/memory/replay/step/before", {
  run_id: runStart.run_id,
  step_index: 1,
  tool_name: "echo",
  tool_input: { text: "hello" },
  preconditions: [],
  safety_level: "auto_ok",
});
await post("/v1/memory/replay/step/after", {
  run_id: runStart.run_id,
  step_id: stepBefore.step_id,
  step_index: 1,
  status: "success",
  postconditions: [],
  artifact_refs: [],
  repair_applied: false,
});
await post("/v1/memory/replay/run/end", {
  run_id: runStart.run_id,
  status: "success",
  summary: "done",
  success_criteria: {},
  metrics: {},
});
const compile = await post("/v1/memory/replay/playbooks/compile_from_run", {
  run_id: runStart.run_id,
  playbook_id: playbookId,
  matchers: {},
  risk_profile: "medium",
  metadata: {},
});
const playbookGet = await post("/v1/memory/replay/playbooks/get", {
  playbook_id: playbookId,
});
const promote = await post("/v1/memory/replay/playbooks/promote", {
  playbook_id: playbookId,
  target_status: "shadow",
  note: "lite promote smoke",
});
const playbookRun = await post("/v1/memory/replay/playbooks/run", {
  playbook_id: playbookId,
  version: promote.to_version,
  actor: "lite-smoke",
  mode: "simulate",
  params: { record_run: true },
});
if (compile.version !== 1 || playbookGet.playbook?.version !== 1 || promote.to_version !== 2) {
  console.error(JSON.stringify({ compile, playbookGet, promote }, null, 2));
  process.exit(1);
}
if (
  playbookRun.mode !== "simulate"
  || playbookRun.run?.status !== "success"
  || playbookRun.summary?.replay_readiness !== "ready"
  || playbookRun.playbook?.version !== promote.to_version
) {
  console.error(JSON.stringify(playbookRun, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  replay_playbook_kernel_ok: true,
  playbook_id: playbookId,
  playbook_version: promote.to_version,
  replay_run_id: playbookRun.run.run_id,
  readiness: playbookRun.summary.replay_readiness,
}, null, 2));
JS

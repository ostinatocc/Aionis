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
const marker = `LITE_SMOKE_PUBLIC_MEMORY_${Date.now()}`;

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

const observe = await post("/v1/observe", {
  tenant_id: "default",
  scope: "lite-smoke/default",
  input_text: `${marker}: keep the local Runtime smoke path auditable.`,
  auto_embed: false,
});
const guide = await post("/v1/guide", {
  tenant_id: "default",
  scope: "lite-smoke/default",
  query_text: "Continue the local Runtime smoke check.",
  include_packets: true,
  limit: 4,
});
if (
  observe?.contract_version !== "aionis_observe_result_v1"
  || observe?.observed?.memory_written !== true
  || guide?.contract_version !== "aionis_guide_result_v1"
  || guide?.agent_context?.contract_version !== "aionis_agent_context_v1"
) {
  console.error(JSON.stringify({ observe, guide }, null, 2));
  process.exit(1);
}

const retiredReplayRoute = await fetch(base + "/v1/memory/replay/run/start", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ goal: "retired public replay route must stay absent" }),
});
if (retiredReplayRoute.status !== 404) {
  console.error(`expected retired replay route to return 404, got ${retiredReplayRoute.status}`);
  process.exit(1);
}

console.log(JSON.stringify({
  public_product_smoke_ok: true,
  observe_contract: observe.contract_version,
  guide_contract: guide.contract_version,
  agent_context_contract: guide.agent_context.contract_version,
  retired_replay_http_status: retiredReplayRoute.status,
}, null, 2));
JS

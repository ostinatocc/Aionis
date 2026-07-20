#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_REF="${1:-}"
CONTAINER_NAME="aionis-release-smoke-${RANDOM}-$$"
SMOKE_ATTEMPTS="${AIONIS_DOCKER_SMOKE_ATTEMPTS:-90}"
HEALTH_TIMEOUT="${AIONIS_DOCKER_SMOKE_HEALTH_TIMEOUT:-5s}"

if [[ -z "${IMAGE_REF}" ]]; then
  echo "usage: $0 <registry/image@sha256:digest|sha256:local-image-id>" >&2
  exit 2
fi

if [[ ! "${IMAGE_REF}" =~ ^([^[:space:]@]+@)?sha256:[0-9a-f]{64}$ ]]; then
  echo "release smoke requires an immutable image digest, got: ${IMAGE_REF}" >&2
  exit 2
fi

if [[ ! "${SMOKE_ATTEMPTS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "AIONIS_DOCKER_SMOKE_ATTEMPTS must be a positive integer" >&2
  exit 2
fi

if [[ ! "${HEALTH_TIMEOUT}" =~ ^[1-9][0-9]*(ms|s|m)$ ]]; then
  echo "AIONIS_DOCKER_SMOKE_HEALTH_TIMEOUT must be a Docker duration such as 5s or 1m" >&2
  exit 2
fi

cleanup() {
  local original_status=$?
  local cleanup_status=0
  local removal_output=""
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  if ! removal_output="$(docker rm -f -v "${CONTAINER_NAME}" 2>&1)"; then
    if ! grep -F "No such container" <<<"${removal_output}" >/dev/null; then
      printf '%s\n' "${removal_output}" >&2
      echo "failed to remove release smoke container: ${CONTAINER_NAME}" >&2
      cleanup_status=1
    fi
  fi
  if [[ ${original_status} -ne 0 ]]; then
    exit "${original_status}"
  fi
  exit "${cleanup_status}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

cd "${ROOT_DIR}"
if [[ "${IMAGE_REF}" == *@sha256:* ]]; then
  docker pull --platform linux/amd64 "${IMAGE_REF}" >/dev/null
fi

image_architecture="$(docker image inspect --format '{{.Architecture}}' "${IMAGE_REF}")"
if [[ "${image_architecture}" != "amd64" ]]; then
  echo "release smoke only verifies the published linux/amd64 artifact; got ${image_architecture}" >&2
  exit 1
fi

docker run --detach --platform linux/amd64 \
  --health-timeout "${HEALTH_TIMEOUT}" \
  --name "${CONTAINER_NAME}" \
  "${IMAGE_REF}" >/dev/null

health=""
for _ in $(seq 1 "${SMOKE_ATTEMPTS}"); do
  state="$(docker inspect --format '{{.State.Status}}' "${CONTAINER_NAME}" 2>/dev/null || true)"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "${CONTAINER_NAME}" 2>/dev/null || true)"
  if [[ "${health}" == "healthy" ]]; then
    break
  fi
  if [[ "${state}" == "exited" || "${state}" == "dead" ]]; then
    docker logs "${CONTAINER_NAME}" >&2 || true
    echo "release container exited before becoming healthy" >&2
    exit 1
  fi
  sleep 1
done

if [[ "${health}" != "healthy" ]]; then
  docker logs "${CONTAINER_NAME}" >&2 || true
  echo "release container did not become healthy" >&2
  exit 1
fi

docker exec "${CONTAINER_NAME}" node --input-type=module -e '
const base = "http://127.0.0.1:" + (process.env.PORT || "3001");
const fetchWithTimeout = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isCanonicalTimestamp = (value) => {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};
const fail = (message, value) => {
  throw new Error(message + ": " + JSON.stringify(value));
};
const health = await fetchWithTimeout(base + "/healthz");
if (!health.ok || (await health.json()).ok !== true) throw new Error("healthz failed");
const ready = await fetchWithTimeout(base + "/readyz");
const readyBody = await ready.json();
if (!ready.ok || readyBody.ready !== true) throw new Error("readyz failed");
if (!isRecord(readyBody.checks)
  || !hasOwn(readyBody.checks, "learning_control_worker")
  || readyBody.checks.learning_control_worker !== true) {
  fail("readyz learning-control worker check failed", readyBody);
}
const runtimeHealth = await fetchWithTimeout(base + "/health");
const runtimeHealthBody = await runtimeHealth.json();
const learningControl = runtimeHealthBody?.lite?.stores?.learning_control_worker;
if (!runtimeHealth.ok
  || runtimeHealthBody.ok !== true
  || !isRecord(learningControl)) {
  fail("health missing learning-control worker", runtimeHealthBody);
}
if (typeof learningControl.running !== "boolean"
  || learningControl.closed !== false
  || learningControl.last_error_code !== null) {
  fail("learning-control worker is unhealthy", learningControl);
}
if (!isCanonicalTimestamp(learningControl.last_started_at)
  || !isCanonicalTimestamp(learningControl.last_succeeded_at)
  || !isRecord(learningControl.last_drain)) {
  fail("learning-control startup drain did not succeed", learningControl);
}
const learningControlBacklog = learningControl.backlog;
if (!isRecord(learningControlBacklog)) {
  fail("learning-control backlog missing", learningControl);
}
for (const field of ["pending", "leased", "expired_leases", "completed", "dead_letter", "exhausted"]) {
  if (!Number.isSafeInteger(learningControlBacklog[field]) || learningControlBacklog[field] < 0) {
    fail("invalid learning-control backlog field " + field, learningControlBacklog);
  }
}
for (const field of ["oldest_available_at", "oldest_lease_expiry"]) {
  if (learningControlBacklog[field] !== null
    && !isCanonicalTimestamp(learningControlBacklog[field])) {
    fail("invalid learning-control backlog timestamp " + field, learningControlBacklog);
  }
}
if (learningControlBacklog.exhausted !== 0) {
  fail("learning-control terminalization is exhausted", learningControlBacklog);
}
const observe = await fetchWithTimeout(base + "/v1/observe", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    operation_id: "docker-release-smoke-observe",
    input_text: "Docker release smoke records a durable local continuity event.",
    auto_embed: false
  })
});
const observeBody = await observe.json();
if (!observe.ok || observeBody.contract_version !== "aionis_observe_result_v1") {
  throw new Error("observe failed: " + JSON.stringify(observeBody));
}
const replay = await fetchWithTimeout(base + "/v1/observe", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    operation_id: "docker-release-smoke-observe",
    input_text: "Docker release smoke records a durable local continuity event.",
    auto_embed: false
  })
});
const replayBody = await replay.json();
if (!replay.ok || JSON.stringify(replayBody) !== JSON.stringify(observeBody)) {
  throw new Error("observe durable replay failed");
}
process.stdout.write(JSON.stringify({
  ok: true,
  health: true,
  ready: true,
  learning_control_worker: {
    ready: true,
    last_succeeded_at: learningControl.last_succeeded_at,
    backlog: learningControlBacklog
  },
  observe_contract: observeBody.contract_version,
  durable_replay: true
}) + "\n");
'

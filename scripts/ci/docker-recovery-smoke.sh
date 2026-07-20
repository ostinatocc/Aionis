#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_REF="${1:-}"
RUN_SUFFIX="${RANDOM}-$$"
DATA_VOLUME="aionis-recovery-smoke-${RUN_SUFFIX}"
GRACEFUL_CONTAINER="aionis-recovery-graceful-${RUN_SUFFIX}"
CRASH_CONTAINER="aionis-recovery-crash-${RUN_SUFFIX}"
RECOVERED_CONTAINER="aionis-recovery-recovered-${RUN_SUFFIX}"
VERIFY_CONTAINER="aionis-recovery-verify-${RUN_SUFFIX}"
READY_TIMEOUT_SECONDS="${AIONIS_DOCKER_RECOVERY_READY_TIMEOUT_SECONDS:-120}"
HEALTH_TIMEOUT="${AIONIS_DOCKER_RECOVERY_HEALTH_TIMEOUT:-5s}"
SHUTDOWN_TIMEOUT_SECONDS="${AIONIS_DOCKER_RECOVERY_SHUTDOWN_TIMEOUT_SECONDS:-35}"

if [[ -z "${IMAGE_REF}" ]]; then
  echo "usage: $0 <registry/image@sha256:digest|sha256:local-image-id>" >&2
  exit 2
fi

if [[ ! "${IMAGE_REF}" =~ ^([^[:space:]@]+@)?sha256:[0-9a-f]{64}$ ]]; then
  echo "recovery smoke requires an immutable image digest, got: ${IMAGE_REF}" >&2
  exit 2
fi

if [[ ! "${READY_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "AIONIS_DOCKER_RECOVERY_READY_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 2
fi

if [[ ! "${HEALTH_TIMEOUT}" =~ ^[1-9][0-9]*(ms|s|m)$ ]]; then
  echo "AIONIS_DOCKER_RECOVERY_HEALTH_TIMEOUT must be a Docker duration such as 5s or 1m" >&2
  exit 2
fi

if [[ ! "${SHUTDOWN_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "AIONIS_DOCKER_RECOVERY_SHUTDOWN_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 2
fi

cleanup() {
  local original_status=$?
  local cleanup_status=0
  local removal_output=""
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  for container_name in \
    "${GRACEFUL_CONTAINER}" \
    "${CRASH_CONTAINER}" \
    "${RECOVERED_CONTAINER}" \
    "${VERIFY_CONTAINER}"; do
    if ! removal_output="$(docker rm -f -v "${container_name}" 2>&1)"; then
      if ! grep -F "No such container" <<<"${removal_output}" >/dev/null; then
        printf '%s\n' "${removal_output}" >&2
        echo "failed to remove recovery smoke container: ${container_name}" >&2
        cleanup_status=1
      fi
    fi
  done
  if ! removal_output="$(docker volume rm "${DATA_VOLUME}" 2>&1)"; then
    if ! grep -Fi "no such volume" <<<"${removal_output}" >/dev/null; then
      printf '%s\n' "${removal_output}" >&2
      echo "failed to remove recovery smoke volume: ${DATA_VOLUME}" >&2
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

log_container() {
  local container_name="$1"
  docker logs "${container_name}" >&2 2>/dev/null || true
}

wait_until_ready() {
  local container_name="$1"
  local deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
  local state=""
  local health=""
  while ((SECONDS < deadline)); do
    if ! state="$(docker inspect --format '{{.State.Status}}' "${container_name}")"; then
      echo "failed to inspect recovery smoke container state" >&2
      return 1
    fi
    if ! health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "${container_name}")"; then
      echo "failed to inspect recovery smoke container health" >&2
      return 1
    fi
    if [[ "${health}" == "healthy" ]]; then
      if docker exec "${container_name}" node --input-type=module -e '
        const base = `http://127.0.0.1:${process.env.PORT || "3001"}`;
        const response = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(10_000) });
        const body = await response.json();
        if (!response.ok || body?.ready !== true || body?.checks?.learning_control_worker !== true) {
          throw new Error(`Runtime not ready: ${response.status} ${JSON.stringify(body)}`);
        }
      '; then
        return 0
      fi
    fi
    if [[ "${state}" == "exited" || "${state}" == "dead" ]]; then
      log_container "${container_name}"
      echo "recovery smoke container exited before becoming ready" >&2
      return 1
    fi
    sleep 1
  done
  log_container "${container_name}"
  echo "recovery smoke container did not become ready" >&2
  return 1
}

start_runtime() {
  local container_name="$1"
  docker run --detach --platform linux/amd64 \
    --health-timeout "${HEALTH_TIMEOUT}" \
    --name "${container_name}" \
    --mount "type=volume,source=${DATA_VOLUME},target=/data" \
    "${IMAGE_REF}" >/dev/null
  wait_until_ready "${container_name}"
}

assert_node_is_pid_one() {
  local container_name="$1"
  docker exec "${container_name}" node --input-type=module -e '
    import { readFileSync, readlinkSync } from "node:fs";
    const executable = readlinkSync("/proc/1/exe");
    const command = readFileSync("/proc/1/cmdline")
      .toString("utf8")
      .split("\u0000")
      .filter(Boolean);
    const nativeNode = executable.endsWith("/node");
    const emulatedNode = executable.includes("qemu-")
      && command.some((part) => part.endsWith("/node"));
    if (!nativeNode && !emulatedNode) {
      throw new Error(`container PID 1 is not Node or an emulated Node process: ${executable} ${JSON.stringify(command)}`);
    }
    if (!command.includes("--import") || !command.includes("tsx") || !command.includes("src/index.ts")) {
      throw new Error(`container PID 1 command is not the Runtime entry: ${JSON.stringify(command)}`);
    }
  '
}

observe_operation() {
  local container_name="$1"
  local operation_id="$2"
  local scope="$3"
  local input_text="$4"
  docker exec \
    --env "AIONIS_SMOKE_OPERATION_ID=${operation_id}" \
    --env "AIONIS_SMOKE_SCOPE=${scope}" \
    --env "AIONIS_SMOKE_INPUT_TEXT=${input_text}" \
    "${container_name}" node --input-type=module -e '
      import { createHash } from "node:crypto";
      const canonical = (value) => {
        if (Array.isArray(value)) return value.map(canonical);
        if (value && typeof value === "object") {
          return Object.fromEntries(
            Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
          );
        }
        return value;
      };
      const base = `http://127.0.0.1:${process.env.PORT || "3001"}`;
      const response = await fetch(`${base}/v1/observe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          operation_id: process.env.AIONIS_SMOKE_OPERATION_ID,
          scope: process.env.AIONIS_SMOKE_SCOPE,
          input_text: process.env.AIONIS_SMOKE_INPUT_TEXT,
          auto_embed: false,
        }),
      });
      const body = await response.json();
      if (!response.ok || body.contract_version !== "aionis_observe_result_v1") {
        throw new Error(`observe failed: ${response.status} ${JSON.stringify(body)}`);
      }
      const memoryNode = body?.memory_write?.nodes?.[0];
      const memoryId = memoryNode?.id;
      const memoryType = memoryNode?.type;
      if (
        typeof memoryId !== "string" ||
        memoryId.length === 0 ||
        typeof memoryType !== "string" ||
        memoryType.length === 0
      ) {
        throw new Error(`observe returned no typed memory id: ${JSON.stringify(body)}`);
      }
      const digest = createHash("sha256")
        .update(JSON.stringify(canonical(body)))
        .digest("hex");
      process.stdout.write(`${digest}\t${memoryId}\t${memoryType}\n`);
    '
}

assert_operation_conflict() {
  local container_name="$1"
  local operation_id="$2"
  local scope="$3"
  local conflicting_text="$4"
  docker exec \
    --env "AIONIS_SMOKE_OPERATION_ID=${operation_id}" \
    --env "AIONIS_SMOKE_SCOPE=${scope}" \
    --env "AIONIS_SMOKE_INPUT_TEXT=${conflicting_text}" \
    "${container_name}" node --input-type=module -e '
      const base = `http://127.0.0.1:${process.env.PORT || "3001"}`;
      const response = await fetch(`${base}/v1/observe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          operation_id: process.env.AIONIS_SMOKE_OPERATION_ID,
          scope: process.env.AIONIS_SMOKE_SCOPE,
          input_text: process.env.AIONIS_SMOKE_INPUT_TEXT,
          auto_embed: false,
        }),
      });
      const body = await response.json();
      if (response.status !== 409 || body?.error !== "observe_operation_id_conflict") {
        throw new Error(`operation conflict was not rejected: ${response.status} ${JSON.stringify(body)}`);
      }
    '
}

assert_memory_resolves() {
  local container_name="$1"
  local scope="$2"
  local memory_id="$3"
  local memory_type="$4"
  docker exec \
    --env "AIONIS_SMOKE_SCOPE=${scope}" \
    --env "AIONIS_SMOKE_MEMORY_ID=${memory_id}" \
    --env "AIONIS_SMOKE_MEMORY_TYPE=${memory_type}" \
    "${container_name}" node --input-type=module -e '
      const base = `http://127.0.0.1:${process.env.PORT || "3001"}`;
      const uri = `aionis://default/${encodeURIComponent(process.env.AIONIS_SMOKE_SCOPE)}/${encodeURIComponent(process.env.AIONIS_SMOKE_MEMORY_TYPE)}/${encodeURIComponent(process.env.AIONIS_SMOKE_MEMORY_ID)}`;
      const response = await fetch(`${base}/v1/memory/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          uri,
          consumer_agent_id: "local-docker",
          include_meta: true,
          include_slots: true,
        }),
      });
      const body = await response.json();
      if (
        !response.ok ||
        body?.node?.id !== process.env.AIONIS_SMOKE_MEMORY_ID ||
        body?.node?.type !== process.env.AIONIS_SMOKE_MEMORY_TYPE
      ) {
        throw new Error(`memory resolve failed: ${response.status} ${JSON.stringify(body)}`);
      }
    '
}

assert_runtime_health() {
  local container_name="$1"
  docker exec "${container_name}" node --input-type=module -e '
    const base = `http://127.0.0.1:${process.env.PORT || "3001"}`;
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json();
    const stores = body?.lite?.stores;
    const projection = stores?.projection_worker;
    const learning = stores?.learning_control_worker;
    const backlog = stores?.write?.projections;
    const isCanonicalTimestamp = (value) => {
      if (typeof value !== "string") return false;
      try {
        return new Date(value).toISOString() === value;
      } catch {
        return false;
      }
    };
    if (!response.ok || body?.ok !== true) throw new Error("Runtime health failed");
    if (
      projection?.closed !== false ||
      projection?.last_error_code !== null ||
      !isCanonicalTimestamp(projection?.last_succeeded_at)
    ) {
      throw new Error(`projection worker unhealthy: ${JSON.stringify(projection)}`);
    }
    if (
      learning?.closed !== false ||
      learning?.last_error_code !== null ||
      !isCanonicalTimestamp(learning?.last_succeeded_at) ||
      !learning?.last_drain ||
      typeof learning.last_drain !== "object" ||
      Array.isArray(learning.last_drain)
    ) {
      throw new Error(`learning worker unhealthy: ${JSON.stringify(learning)}`);
    }
    for (const field of ["dead_letter", "provider_mismatch", "legacy_pending_unrecoverable"]) {
      if (!Number.isSafeInteger(backlog?.[field]) || backlog[field] !== 0) {
        throw new Error(`projection backlog ${field} is unsafe: ${JSON.stringify(backlog)}`);
      }
    }
    for (const field of ["dead_letter", "exhausted"]) {
      if (!Number.isSafeInteger(learning?.backlog?.[field]) || learning.backlog[field] !== 0) {
        throw new Error(`learning backlog ${field} is unsafe: ${JSON.stringify(learning?.backlog)}`);
      }
    }
  '
}

stop_gracefully() {
  local container_name="$1"
  local exit_code=""
  local oom_killed=""
  local logs=""
  docker stop --time "${SHUTDOWN_TIMEOUT_SECONDS}" "${container_name}" >/dev/null
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "${container_name}")"
  oom_killed="$(docker inspect --format '{{.State.OOMKilled}}' "${container_name}")"
  logs="$(docker logs "${container_name}" 2>&1)"
  if [[ "${exit_code}" != "0" || "${oom_killed}" != "false" ]]; then
    printf '%s\n' "${logs}" >&2
    echo "graceful Runtime stop failed: exit=${exit_code} oom=${oom_killed}" >&2
    return 1
  fi
  if ! grep -F "draining Runtime before shutdown" <<<"${logs}" >/dev/null; then
    printf '%s\n' "${logs}" >&2
    echo "graceful Runtime stop did not execute the shutdown drain" >&2
    return 1
  fi
  if grep -E "forcing Runtime shutdown|Runtime graceful shutdown failed" <<<"${logs}" >/dev/null; then
    printf '%s\n' "${logs}" >&2
    echo "graceful Runtime stop reported a forced or failed shutdown" >&2
    return 1
  fi
}

cd "${ROOT_DIR}"
if [[ "${IMAGE_REF}" == *@sha256:* ]]; then
  docker pull --platform linux/amd64 "${IMAGE_REF}" >/dev/null
fi

image_architecture="$(docker image inspect --format '{{.Architecture}}' "${IMAGE_REF}")"
if [[ "${image_architecture}" != "amd64" ]]; then
  echo "recovery smoke only verifies the published linux/amd64 artifact; got ${image_architecture}" >&2
  exit 1
fi

docker volume create "${DATA_VOLUME}" >/dev/null

scope="docker-recovery-smoke:${RUN_SUFFIX}"
graceful_operation="docker-recovery-graceful:${RUN_SUFFIX}"
graceful_text="Docker recovery smoke records a graceful-restart durable event."

start_runtime "${GRACEFUL_CONTAINER}"
assert_node_is_pid_one "${GRACEFUL_CONTAINER}"
IFS=$'\t' read -r graceful_digest graceful_memory_id graceful_memory_type < <(
  observe_operation \
    "${GRACEFUL_CONTAINER}" \
    "${graceful_operation}" \
    "${scope}" \
    "${graceful_text}"
)
test "$(docker exec "${GRACEFUL_CONTAINER}" stat -c '%a' /data/aionis-lite-write.sqlite)" = "600"
test "$(docker exec "${GRACEFUL_CONTAINER}" stat -c '%a' /data/aionis-lite-replay.sqlite)" = "600"
stop_gracefully "${GRACEFUL_CONTAINER}"
docker rm "${GRACEFUL_CONTAINER}" >/dev/null

start_runtime "${CRASH_CONTAINER}"
assert_node_is_pid_one "${CRASH_CONTAINER}"
assert_memory_resolves "${CRASH_CONTAINER}" "${scope}" "${graceful_memory_id}" "${graceful_memory_type}"
IFS=$'\t' read -r graceful_replay_digest graceful_replay_memory_id graceful_replay_memory_type < <(
  observe_operation \
    "${CRASH_CONTAINER}" \
    "${graceful_operation}" \
    "${scope}" \
    "${graceful_text}"
)
if [[ "${graceful_replay_digest}" != "${graceful_digest}" || "${graceful_replay_memory_id}" != "${graceful_memory_id}" || "${graceful_replay_memory_type}" != "${graceful_memory_type}" ]]; then
  echo "graceful restart did not return the exact operation replay" >&2
  exit 1
fi
assert_operation_conflict \
  "${CRASH_CONTAINER}" \
  "${graceful_operation}" \
  "${scope}" \
  "${graceful_text} conflicting payload"
IFS=$'\t' read -r post_conflict_digest post_conflict_memory_id post_conflict_memory_type < <(
  observe_operation \
    "${CRASH_CONTAINER}" \
    "${graceful_operation}" \
    "${scope}" \
    "${graceful_text}"
)
if [[ "${post_conflict_digest}" != "${graceful_digest}" || "${post_conflict_memory_id}" != "${graceful_memory_id}" || "${post_conflict_memory_type}" != "${graceful_memory_type}" ]]; then
  echo "operation conflict changed the exact operation replay" >&2
  exit 1
fi

crash_operation="docker-recovery-sigkill:${RUN_SUFFIX}"
crash_text="Docker recovery smoke records a SIGKILL-restart durable event."
IFS=$'\t' read -r crash_digest crash_memory_id crash_memory_type < <(
  observe_operation \
    "${CRASH_CONTAINER}" \
    "${crash_operation}" \
    "${scope}" \
    "${crash_text}"
)
docker kill --signal=SIGKILL "${CRASH_CONTAINER}" >/dev/null
crash_exit_code="$(docker inspect --format '{{.State.ExitCode}}' "${CRASH_CONTAINER}")"
crash_oom_killed="$(docker inspect --format '{{.State.OOMKilled}}' "${CRASH_CONTAINER}")"
if [[ "${crash_exit_code}" != "137" || "${crash_oom_killed}" != "false" ]]; then
  log_container "${CRASH_CONTAINER}"
  echo "SIGKILL did not produce the expected non-OOM process death" >&2
  exit 1
fi
docker rm "${CRASH_CONTAINER}" >/dev/null

start_runtime "${RECOVERED_CONTAINER}"
assert_node_is_pid_one "${RECOVERED_CONTAINER}"
assert_memory_resolves "${RECOVERED_CONTAINER}" "${scope}" "${graceful_memory_id}" "${graceful_memory_type}"
assert_memory_resolves "${RECOVERED_CONTAINER}" "${scope}" "${crash_memory_id}" "${crash_memory_type}"
IFS=$'\t' read -r crash_replay_digest crash_replay_memory_id crash_replay_memory_type < <(
  observe_operation \
    "${RECOVERED_CONTAINER}" \
    "${crash_operation}" \
    "${scope}" \
    "${crash_text}"
)
if [[ "${crash_replay_digest}" != "${crash_digest}" || "${crash_replay_memory_id}" != "${crash_memory_id}" || "${crash_replay_memory_type}" != "${crash_memory_type}" ]]; then
  echo "SIGKILL restart did not return the exact operation replay" >&2
  exit 1
fi
assert_runtime_health "${RECOVERED_CONTAINER}"
stop_gracefully "${RECOVERED_CONTAINER}"
docker rm "${RECOVERED_CONTAINER}" >/dev/null

verification="$({
  docker run --platform linux/amd64 \
    --network none \
    --name "${VERIFY_CONTAINER}" \
    --mount "type=volume,source=${DATA_VOLUME},target=/data" \
    "${IMAGE_REF}" \
    node --import tsx scripts/runtime-data-ops.ts \
      verify --db /data/aionis-lite-write.sqlite
})"
AIONIS_SMOKE_VERIFY_JSON="${verification}" node --input-type=module -e '
  const report = JSON.parse(process.env.AIONIS_SMOKE_VERIFY_JSON);
  if (
    report?.ok !== true ||
    JSON.stringify(report?.quick_check) !== JSON.stringify(["ok"]) ||
    report?.foreign_key_violation_count !== 0 ||
    report?.schema?.classification !== "current"
  ) {
    throw new Error(`offline Runtime data verification failed: ${JSON.stringify(report)}`);
  }
'

AIONIS_SMOKE_IMAGE="${IMAGE_REF}" node \
  --input-type=module \
  -e '
    const result = {
      contract_version: "aionis_docker_recovery_smoke_v1",
      image: process.env.AIONIS_SMOKE_IMAGE,
      platform: "linux/amd64",
      pid_one: "node",
      sqlite_mode_0600: true,
      graceful_restart: {
        exit_zero: true,
        shutdown_drain_observed: true,
        memory_resolved: true,
        exact_operation_replay: true,
        operation_conflict_rejected: true,
      },
      sigkill_restart: {
        exit_137: true,
        oom_killed: false,
        memory_resolved: true,
        exact_operation_replay: true,
      },
      workers_healthy_after_recovery: true,
      offline_database_verify: true,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  ' \
  </dev/null

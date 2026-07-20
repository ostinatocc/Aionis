#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="recovery"
if [[ "${1:-}" == "--cross-version" ]]; then MODE="cross-version"; shift; fi
IMAGE_REF="${1:-}"
EXPECTED_COMMIT="${2:-}"
EXPECTED_TAG="${3:-}"
OLD_IMAGE="ghcr.io/ostinatocc/aionis@sha256:714bbf451969c233c648a266c7c1d918bc91e35dcb957e57b0e7549b7c2ab0a9"
OLD_COMMIT="fadce2269189dae00e8b0014fc673975598bdc17"
RUN_SUFFIX="${RANDOM}-$$"
READY_TIMEOUT_SECONDS="${AIONIS_DOCKER_RECOVERY_READY_TIMEOUT_SECONDS:-${AIONIS_CROSS_VERSION_READY_TIMEOUT_SECONDS:-120}}"
HEALTH_TIMEOUT="${AIONIS_DOCKER_RECOVERY_HEALTH_TIMEOUT:-5s}"; REQUEST_TIMEOUT_MS="${AIONIS_DOCKER_RECOVERY_REQUEST_TIMEOUT_MS:-10000}"; REQUIRE_DOCKER_HEALTH="${AIONIS_DOCKER_RECOVERY_REQUIRE_DOCKER_HEALTH:-true}"
SHUTDOWN_TIMEOUT_SECONDS="${AIONIS_DOCKER_RECOVERY_SHUTDOWN_TIMEOUT_SECONDS:-35}"

if [[ -z "${IMAGE_REF}" ]]; then
  echo "usage: $0 [--cross-version] <image@sha256:digest|sha256:local-image-id> [candidate-commit candidate-tag]" >&2
  exit 2
fi
if [[ ! "${IMAGE_REF}" =~ ^([^[:space:]@]+@)?sha256:[0-9a-f]{64}$ ]]; then
  if [[ "${MODE}" == "cross-version" ]]; then
    echo "cross-version smoke requires an immutable candidate image digest, got: ${IMAGE_REF}" >&2
  else
    echo "recovery smoke requires an immutable image digest, got: ${IMAGE_REF}" >&2
  fi
  exit 2
fi
if [[ ! "${READY_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ || ! "${SHUTDOWN_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ || ! "${REQUEST_TIMEOUT_MS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Docker smoke timeouts must be positive integers" >&2
  exit 2
fi
if [[ ! "${HEALTH_TIMEOUT}" =~ ^[1-9][0-9]*(ms|s|m)$ || ! "${REQUIRE_DOCKER_HEALTH}" =~ ^(true|false)$ ]]; then
  echo "Docker health timeout must be a duration and health requirement must be true or false" >&2
  exit 2
fi
if [[ "${MODE}" == "cross-version" ]]; then
  if [[ ! "${EXPECTED_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "cross-version smoke requires an exact 40-character candidate commit" >&2; exit 2
  fi
  if [[ ! "${EXPECTED_TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ || "${EXPECTED_TAG}" == "v0.3.6" ]]; then
    echo "cross-version smoke requires a later semantic Runtime tag" >&2; exit 2
  fi
  command -v jq >/dev/null 2>&1 || { echo "cross-version smoke requires jq" >&2; exit 2; }
fi

if [[ "${MODE}" == "recovery" ]]; then
  DATA_VOLUME="aionis-recovery-smoke-${RUN_SUFFIX}"
  GRACEFUL_CONTAINER="aionis-recovery-graceful-${RUN_SUFFIX}"
  CRASH_CONTAINER="aionis-recovery-crash-${RUN_SUFFIX}"
  RECOVERED_CONTAINER="aionis-recovery-recovered-${RUN_SUFFIX}"
  VERIFY_CONTAINER="aionis-recovery-verify-${RUN_SUFFIX}"
  CLEANUP_CONTAINERS=("${GRACEFUL_CONTAINER}" "${CRASH_CONTAINER}" "${RECOVERED_CONTAINER}" "${VERIFY_CONTAINER}")
  CLEANUP_VOLUMES=("${DATA_VOLUME}")
else
  ORIGINAL_VOLUME="aionis-cross-original-${RUN_SUFFIX}"
  CANDIDATE_VOLUME="aionis-cross-candidate-${RUN_SUFFIX}"
  RECOVERY_VOLUME="aionis-cross-recovery-${RUN_SUFFIX}"
  OLD_CONTAINER="aionis-cross-old-${RUN_SUFFIX}"
  CANDIDATE_CONTAINER="aionis-cross-candidate-${RUN_SUFFIX}"
  RESTART_CONTAINER="aionis-cross-restart-${RUN_SUFFIX}"
  RECOVERED_CONTAINER="aionis-cross-recovered-${RUN_SUFFIX}"
  ROLLBACK_CONTAINER="aionis-cross-rollback-${RUN_SUFFIX}"
  CLEANUP_CONTAINERS=("${OLD_CONTAINER}" "${CANDIDATE_CONTAINER}" "${RESTART_CONTAINER}" "${RECOVERED_CONTAINER}" "${ROLLBACK_CONTAINER}")
  CLEANUP_VOLUMES=("${ORIGINAL_VOLUME}" "${CANDIDATE_VOLUME}" "${RECOVERY_VOLUME}")
fi

cleanup() {
  local original_status=$? cleanup_status=0 output=""
  trap - EXIT; trap '' HUP INT TERM; set +e
  for name in "${CLEANUP_CONTAINERS[@]}"; do
    if ! output="$(docker rm -f -v "${name}" 2>&1)" && ! grep -F "No such container" <<<"${output}" >/dev/null; then
      printf '%s\n' "${output}" >&2; cleanup_status=1
    fi
  done
  for volume in "${CLEANUP_VOLUMES[@]}"; do
    if ! output="$(docker volume rm "${volume}" 2>&1)" && ! grep -Fi "no such volume" <<<"${output}" >/dev/null; then
      printf '%s\n' "${output}" >&2; cleanup_status=1
    fi
  done
  if [[ ${original_status} -ne 0 ]]; then exit "${original_status}"; fi
  exit "${cleanup_status}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

ensure_image() {
  local image="$1"
  if docker image inspect "${image}" >/dev/null 2>&1; then return; fi
  [[ "${image}" == *@sha256:* ]] || { echo "local image is unavailable: ${image}" >&2; return 1; }
  docker pull --platform linux/amd64 "${image}" >/dev/null
}

log_container() { docker logs "$1" >&2 2>/dev/null || true; }
wait_until_ready() {
  local name="$1" deadline=$((SECONDS + READY_TIMEOUT_SECONDS)) state="" health=""
  while ((SECONDS < deadline)); do
    state="$(docker inspect --format '{{.State.Status}}' "${name}" 2>/dev/null || true)"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "${name}" 2>/dev/null || true)"
    if [[ "${health}" == "healthy" || "${REQUIRE_DOCKER_HEALTH}" == "false" ]] && docker exec "${name}" node --input-type=module -e '
      const r = await fetch("http://127.0.0.1:3001/readyz", { signal: AbortSignal.timeout(Number(process.env.AIONIS_SMOKE_REQUEST_TIMEOUT_MS)) });
      const b = await r.json(); if (!r.ok || b?.ready !== true) process.exit(1);
    ' >/dev/null 2>&1; then return; fi
    if [[ "${state}" == "exited" || "${state}" == "dead" ]]; then
      log_container "${name}"; echo "recovery smoke container exited before becoming ready" >&2; return 1
    fi
    sleep 1
  done
  log_container "${name}"; echo "recovery smoke container did not become ready" >&2; return 1
}

start_runtime() {
  local name="$1" volume="$2" image="$3" health_args=(--health-timeout "${HEALTH_TIMEOUT}"); [[ "${REQUIRE_DOCKER_HEALTH}" == "false" ]] && health_args=(--no-healthcheck)
  docker run --detach --platform linux/amd64 "${health_args[@]}" --env "AIONIS_SMOKE_REQUEST_TIMEOUT_MS=${REQUEST_TIMEOUT_MS}" --name "${name}" \
    --mount "type=volume,source=${volume},target=/data" "${image}" >/dev/null
  wait_until_ready "${name}"
}

assert_node_is_pid_one() {
  docker exec "$1" node --input-type=module -e '
    import { readFileSync, readlinkSync } from "node:fs";
    const executable = readlinkSync("/proc/1/exe"); const command = readFileSync("/proc/1/cmdline").toString("utf8").split("\0").filter(Boolean);
    const node = executable.endsWith("/node") || (executable.includes("qemu-") && command.some((part) => part.endsWith("/node")));
    if (!node || !command.includes("--import") || !command.includes("tsx") || !command.includes("src/index.ts")) throw new Error(`container PID 1 is not the Runtime Node entry: ${executable} ${JSON.stringify(command)}`);
  '
}

observe_operation() {
  local name="$1" operation_id="$2" scope="$3" input_text="$4"
  docker exec --env "AIONIS_SMOKE_OPERATION_ID=${operation_id}" --env "AIONIS_SMOKE_SCOPE=${scope}" \
    --env "AIONIS_SMOKE_INPUT_TEXT=${input_text}" "${name}" node --input-type=module -e '
      import { createHash } from "node:crypto";
      const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
      const response = await fetch("http://127.0.0.1:3001/v1/observe", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(Number(process.env.AIONIS_SMOKE_REQUEST_TIMEOUT_MS)), body: JSON.stringify({ operation_id: process.env.AIONIS_SMOKE_OPERATION_ID, scope: process.env.AIONIS_SMOKE_SCOPE, input_text: process.env.AIONIS_SMOKE_INPUT_TEXT, auto_embed: false }) });
      const body = await response.json(); const node = body?.memory_write?.nodes?.[0];
      if (!response.ok || body?.contract_version !== "aionis_observe_result_v1" || typeof node?.id !== "string" || typeof node?.type !== "string") throw new Error(`observe failed: ${response.status} ${JSON.stringify(body)}`);
      process.stdout.write(`${createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex")}\t${node.id}\t${node.type}\n`);
    '
}

assert_operation_conflict() {
  local name="$1" operation_id="$2" scope="$3" text="$4"
  docker exec --env "AIONIS_SMOKE_OPERATION_ID=${operation_id}" --env "AIONIS_SMOKE_SCOPE=${scope}" \
    --env "AIONIS_SMOKE_INPUT_TEXT=${text}" "${name}" node --input-type=module -e '
      const response = await fetch("http://127.0.0.1:3001/v1/observe", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(Number(process.env.AIONIS_SMOKE_REQUEST_TIMEOUT_MS)), body: JSON.stringify({ operation_id: process.env.AIONIS_SMOKE_OPERATION_ID, scope: process.env.AIONIS_SMOKE_SCOPE, input_text: process.env.AIONIS_SMOKE_INPUT_TEXT, auto_embed: false }) });
      const body = await response.json(); if (response.status !== 409 || body?.error !== "observe_operation_id_conflict") throw new Error(`operation conflict was not rejected: ${response.status} ${JSON.stringify(body)}`);
    '
}

assert_memory_resolves() {
  local name="$1" scope="$2" memory_id="$3" memory_type="$4"
  docker exec --env "AIONIS_SMOKE_SCOPE=${scope}" --env "AIONIS_SMOKE_MEMORY_ID=${memory_id}" \
    --env "AIONIS_SMOKE_MEMORY_TYPE=${memory_type}" "${name}" node --input-type=module -e '
      const uri = `aionis://default/${encodeURIComponent(process.env.AIONIS_SMOKE_SCOPE)}/${encodeURIComponent(process.env.AIONIS_SMOKE_MEMORY_TYPE)}/${encodeURIComponent(process.env.AIONIS_SMOKE_MEMORY_ID)}`;
      const response = await fetch("http://127.0.0.1:3001/v1/memory/resolve", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(Number(process.env.AIONIS_SMOKE_REQUEST_TIMEOUT_MS)), body: JSON.stringify({ uri, consumer_agent_id: "local-docker", include_meta: true, include_slots: true }) });
      const body = await response.json(); if (!response.ok || body?.node?.id !== process.env.AIONIS_SMOKE_MEMORY_ID || body?.node?.type !== process.env.AIONIS_SMOKE_MEMORY_TYPE) throw new Error(`memory resolve failed: ${response.status} ${JSON.stringify(body)}`);
    '
}

assert_runtime_health() {
  docker exec "$1" node --input-type=module -e '
    const response = await fetch("http://127.0.0.1:3001/health", { signal: AbortSignal.timeout(Number(process.env.AIONIS_SMOKE_REQUEST_TIMEOUT_MS)) }); const body = await response.json();
    const stores = body?.lite?.stores; const projection = stores?.write?.projections; const learning = stores?.learning_control_worker?.backlog;
    if (!response.ok || body?.ok !== true) throw new Error(`Runtime health failed: ${JSON.stringify(body)}`);
    for (const field of ["dead_letter", "provider_mismatch", "legacy_pending_unrecoverable"]) if (projection?.[field] !== 0) throw new Error(`unsafe projection backlog: ${JSON.stringify(projection)}`);
    for (const field of ["dead_letter", "exhausted"]) if (learning?.[field] !== 0) throw new Error(`unsafe learning backlog: ${JSON.stringify(learning)}`);
  '
}

stop_gracefully() {
  local name="$1" exit_code oom logs
  docker stop --time "${SHUTDOWN_TIMEOUT_SECONDS}" "${name}" >/dev/null
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "${name}")"; oom="$(docker inspect --format '{{.State.OOMKilled}}' "${name}")"; logs="$(docker logs "${name}" 2>&1)"
  if [[ "${exit_code}" != "0" || "${oom}" != "false" ]] || ! grep -F "draining Runtime before shutdown" <<<"${logs}" >/dev/null || grep -E "forcing Runtime shutdown|Runtime graceful shutdown failed" <<<"${logs}" >/dev/null; then
    printf '%s\n' "${logs}" >&2; echo "graceful Runtime stop failed: exit=${exit_code} oom=${oom}" >&2; return 1
  fi
  docker rm "${name}" >/dev/null
}

stop_legacy() {
  docker stop --time "${SHUTDOWN_TIMEOUT_SECONDS}" "$1" >/dev/null
  [[ "$(docker inspect --format '{{.State.OOMKilled}}' "$1")" == "false" ]]
  docker rm "$1" >/dev/null
}

run_data_ops() {
  local volume="$1"; shift
  docker run --rm --platform linux/amd64 --network none --mount "type=volume,source=${volume},target=/data" \
    "${IMAGE_REF}" node --import tsx scripts/runtime-data-ops.ts "$@"
}
assert_verify_current() { jq -e '.ok == true and .schema.classification == "current" and .quick_check == ["ok"] and .foreign_key_violation_count == 0' >/dev/null; }

clone_volume() {
  docker run --rm --platform linux/amd64 --network none --user 0:0 \
    --mount "type=volume,source=$1,target=/source,readonly" --mount "type=volume,source=$2,target=/target" \
    "${IMAGE_REF}" bash -lc 'cp -a /source/. /target/ && chown --reference=/source /target'
}

volume_fingerprint() {
  docker run --rm --platform linux/amd64 --network none --mount "type=volume,source=$1,target=/data,readonly" \
    "${IMAGE_REF}" node --input-type=module -e '
      import { createHash } from "node:crypto"; import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs"; import { join, relative } from "node:path";
      const paths = []; const walk = (dir) => { for (const name of readdirSync(dir).sort()) { const path = join(dir, name); paths.push(path); if (lstatSync(path).isDirectory()) walk(path); } }; walk("/data");
      const hash = createHash("sha256"); for (const path of paths) { const stat = lstatSync(path); hash.update(relative("/data", path)); hash.update(`\0${stat.mode & 0o7777}\0${stat.size}\0`); if (stat.isFile()) hash.update(readFileSync(path)); if (stat.isSymbolicLink()) hash.update(readlinkSync(path)); }
      process.stdout.write(`${hash.digest("hex")}\n`);
    '
}

snapshot_replay() {
  docker run --rm --platform linux/amd64 --network none --mount "type=volume,source=$1,target=/data" \
    "${IMAGE_REF}" node --input-type=module -e '
      import { createHash } from "node:crypto"; import { readFileSync } from "node:fs"; import { DatabaseSync } from "node:sqlite";
      const source = new DatabaseSync("/data/aionis-lite-replay.sqlite"); source.exec("VACUUM INTO '\''/data/post-upgrade-replay.sqlite'\''"); source.close();
      const snapshot = new DatabaseSync("/data/post-upgrade-replay.sqlite", { readOnly: true }); const quick = snapshot.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]); snapshot.close();
      process.stdout.write(JSON.stringify({ sha256: createHash("sha256").update(readFileSync("/data/post-upgrade-replay.sqlite")).digest("hex"), quick_check: quick }) + "\n");
    '
}

assert_memory_absent() {
  docker exec --env "AIONIS_SMOKE_MEMORY_ID=$2" "$1" node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync("/data/aionis-lite-write.sqlite", { readOnly: true }); const row = db.prepare("SELECT COUNT(*) AS count FROM lite_memory_nodes WHERE id = ?").get(process.env.AIONIS_SMOKE_MEMORY_ID); db.close();
    if (Number(row?.count ?? -1) !== 0) throw new Error(`post-upgrade memory exists in rollback volume: ${JSON.stringify(row)}`);
  '
}

run_recovery() {
  docker volume create "${DATA_VOLUME}" >/dev/null
  local scope="docker-recovery-smoke:${RUN_SUFFIX}" graceful_operation="docker-recovery-graceful:${RUN_SUFFIX}" graceful_text="Docker recovery smoke records a graceful-restart durable event."
  start_runtime "${GRACEFUL_CONTAINER}" "${DATA_VOLUME}" "${IMAGE_REF}"; assert_node_is_pid_one "${GRACEFUL_CONTAINER}"
  IFS=$'\t' read -r graceful_digest graceful_id graceful_type < <(observe_operation "${GRACEFUL_CONTAINER}" "${graceful_operation}" "${scope}" "${graceful_text}")
  test "$(docker exec "${GRACEFUL_CONTAINER}" stat -c '%a' /data/aionis-lite-write.sqlite)" = "600"
  test "$(docker exec "${GRACEFUL_CONTAINER}" stat -c '%a' /data/aionis-lite-replay.sqlite)" = "600"
  stop_gracefully "${GRACEFUL_CONTAINER}"
  start_runtime "${CRASH_CONTAINER}" "${DATA_VOLUME}" "${IMAGE_REF}"; assert_node_is_pid_one "${CRASH_CONTAINER}"; assert_memory_resolves "${CRASH_CONTAINER}" "${scope}" "${graceful_id}" "${graceful_type}"
  IFS=$'\t' read -r replay_digest replay_id replay_type < <(observe_operation "${CRASH_CONTAINER}" "${graceful_operation}" "${scope}" "${graceful_text}")
  [[ "${replay_digest}" == "${graceful_digest}" && "${replay_id}" == "${graceful_id}" && "${replay_type}" == "${graceful_type}" ]] || { echo "graceful restart did not return the exact operation replay" >&2; return 1; }
  assert_operation_conflict "${CRASH_CONTAINER}" "${graceful_operation}" "${scope}" "${graceful_text} conflicting payload"
  IFS=$'\t' read -r post_conflict_digest post_conflict_id post_conflict_type < <(observe_operation "${CRASH_CONTAINER}" "${graceful_operation}" "${scope}" "${graceful_text}")
  [[ "${post_conflict_digest}" == "${graceful_digest}" && "${post_conflict_id}" == "${graceful_id}" && "${post_conflict_type}" == "${graceful_type}" ]]
  local crash_operation="docker-recovery-sigkill:${RUN_SUFFIX}" crash_text="Docker recovery smoke records a SIGKILL-restart durable event."
  IFS=$'\t' read -r crash_digest crash_id crash_type < <(observe_operation "${CRASH_CONTAINER}" "${crash_operation}" "${scope}" "${crash_text}")
  docker kill --signal=SIGKILL "${CRASH_CONTAINER}" >/dev/null
  [[ "$(docker inspect --format '{{.State.ExitCode}}' "${CRASH_CONTAINER}")" == "137" && "$(docker inspect --format '{{.State.OOMKilled}}' "${CRASH_CONTAINER}")" == "false" ]]
  docker rm "${CRASH_CONTAINER}" >/dev/null
  start_runtime "${RECOVERED_CONTAINER}" "${DATA_VOLUME}" "${IMAGE_REF}"; assert_node_is_pid_one "${RECOVERED_CONTAINER}"
  assert_memory_resolves "${RECOVERED_CONTAINER}" "${scope}" "${graceful_id}" "${graceful_type}"; assert_memory_resolves "${RECOVERED_CONTAINER}" "${scope}" "${crash_id}" "${crash_type}"
  IFS=$'\t' read -r crash_replay_digest crash_replay_id crash_replay_type < <(observe_operation "${RECOVERED_CONTAINER}" "${crash_operation}" "${scope}" "${crash_text}")
  [[ "${crash_replay_digest}" == "${crash_digest}" && "${crash_replay_id}" == "${crash_id}" && "${crash_replay_type}" == "${crash_type}" ]] || { echo "SIGKILL restart did not return the exact operation replay" >&2; return 1; }
  assert_runtime_health "${RECOVERED_CONTAINER}"; stop_gracefully "${RECOVERED_CONTAINER}"
  local verification
  verification="$(docker run --platform linux/amd64 --network none --name "${VERIFY_CONTAINER}" --mount "type=volume,source=${DATA_VOLUME},target=/data" "${IMAGE_REF}" node --import tsx scripts/runtime-data-ops.ts verify --db /data/aionis-lite-write.sqlite)"
  AIONIS_SMOKE_VERIFY_JSON="${verification}" node --input-type=module -e 'const r=JSON.parse(process.env.AIONIS_SMOKE_VERIFY_JSON); if(r?.ok!==true||JSON.stringify(r?.quick_check)!==JSON.stringify(["ok"])||r?.foreign_key_violation_count!==0||r?.schema?.classification!=="current") throw new Error(`offline Runtime data verification failed: ${JSON.stringify(r)}`);'
  AIONIS_SMOKE_IMAGE="${IMAGE_REF}" AIONIS_SMOKE_DOCKER_HEALTH_REQUIRED="${REQUIRE_DOCKER_HEALTH}" AIONIS_SMOKE_REQUEST_TIMEOUT_MS="${REQUEST_TIMEOUT_MS}" AIONIS_SMOKE_READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS}" AIONIS_SMOKE_HEALTH_TIMEOUT="${HEALTH_TIMEOUT}" node --input-type=module -e 'process.stdout.write(JSON.stringify({contract_version:"aionis_docker_recovery_smoke_v1",image:process.env.AIONIS_SMOKE_IMAGE,platform:"linux/amd64",docker_health_required:process.env.AIONIS_SMOKE_DOCKER_HEALTH_REQUIRED==="true",request_timeout_ms:Number(process.env.AIONIS_SMOKE_REQUEST_TIMEOUT_MS),ready_timeout_seconds:Number(process.env.AIONIS_SMOKE_READY_TIMEOUT_SECONDS),docker_health_timeout:process.env.AIONIS_SMOKE_HEALTH_TIMEOUT,pid_one:"node",sqlite_mode_0600:true,graceful_restart:{exit_zero:true,shutdown_drain_observed:true,memory_resolved:true,exact_operation_replay:true,operation_conflict_rejected:true},sigkill_restart:{exit_137:true,oom_killed:false,memory_resolved:true,exact_operation_replay:true},workers_healthy_after_recovery:true,offline_database_verify:true})+"\n");'
}

run_cross_version() {
  ensure_image "${OLD_IMAGE}"
  [[ "$(docker image inspect --format '{{.Architecture}}' "${OLD_IMAGE}")" == "amd64" && "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${OLD_IMAGE}")" == "${OLD_COMMIT}" ]]
  [[ "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "${OLD_IMAGE}")" == "v0.3.6" ]]
  [[ "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${IMAGE_REF}")" == "${EXPECTED_COMMIT}" && "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "${IMAGE_REF}")" == "${EXPECTED_TAG}" ]]
  for volume in "${CLEANUP_VOLUMES[@]}"; do docker volume create "${volume}" >/dev/null; done
  local started_at scope old_operation old_text new_operation new_text
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; scope="cross-version-${RUN_SUFFIX}"; old_operation="cross-version-pre-upgrade-${RUN_SUFFIX}"; old_text="Cross-version gate preserves the pre-upgrade continuity record."; new_operation="cross-version-post-upgrade-${RUN_SUFFIX}"; new_text="Cross-version gate preserves the post-upgrade continuity record."
  start_runtime "${OLD_CONTAINER}" "${ORIGINAL_VOLUME}" "${OLD_IMAGE}"
  IFS=$'\t' read -r old_digest old_id old_type < <(observe_operation "${OLD_CONTAINER}" "${old_operation}" "${scope}" "${old_text}")
  IFS=$'\t' read -r old_replay_digest old_replay_id old_replay_type < <(observe_operation "${OLD_CONTAINER}" "${old_operation}" "${scope}" "${old_text}")
  [[ "${old_replay_digest}" == "${old_digest}" && "${old_replay_id}" == "${old_id}" && "${old_replay_type}" == "${old_type}" ]]
  assert_memory_resolves "${OLD_CONTAINER}" "${scope}" "${old_id}" "${old_type}"; stop_legacy "${OLD_CONTAINER}"
  local original_fingerprint preflight upgrade upgrade_verify
  original_fingerprint="$(volume_fingerprint "${ORIGINAL_VOLUME}")"; clone_volume "${ORIGINAL_VOLUME}" "${CANDIDATE_VOLUME}"; [[ "$(volume_fingerprint "${CANDIDATE_VOLUME}")" == "${original_fingerprint}" ]]
  preflight="$(run_data_ops "${CANDIDATE_VOLUME}" preflight --db /data/aionis-lite-write.sqlite)"; jq -e '.schema.classification == "supported_previous_v2" and .schema.detected_version == 2 and .schema.upgrade_required == true' <<<"${preflight}" >/dev/null
  run_data_ops "${CANDIDATE_VOLUME}" backup --db /data/aionis-lite-write.sqlite --out /data/pre-upgrade-write.sqlite | jq -e '.verification.ok == true and .manifest.schema_version == 2' >/dev/null
  upgrade="$(run_data_ops "${CANDIDATE_VOLUME}" upgrade --db /data/aionis-lite-write.sqlite --replay-db /data/aionis-lite-replay.sqlite)"
  jq -e '.before.classification == "supported_previous_v2" and .after.classification == "current" and .after.detected_version == 6 and .replay_database.contract_version == "aionis_lite_runtime_companion_sqlite_hardening_v1" and .replay_database.quick_check == ["ok"] and .replay_database.foreign_key_violation_count == 0 and .replay_database.required_table_definition_present == true and .replay_database.required_indexes_present == true and .replay_database.mode_before == "0644" and .replay_database.mode_after == "0600" and ((.preserved_counts.before | del(.commits)) == (.preserved_counts.after | del(.commits))) and (.preserved_counts.after.commits >= .preserved_counts.before.commits)' <<<"${upgrade}" >/dev/null
  upgrade_verify="$(run_data_ops "${CANDIDATE_VOLUME}" verify --db /data/aionis-lite-write.sqlite)"; assert_verify_current <<<"${upgrade_verify}"
  start_runtime "${CANDIDATE_CONTAINER}" "${CANDIDATE_VOLUME}" "${IMAGE_REF}"; assert_memory_resolves "${CANDIDATE_CONTAINER}" "${scope}" "${old_id}" "${old_type}"
  IFS=$'\t' read -r upgraded_digest upgraded_id upgraded_type < <(observe_operation "${CANDIDATE_CONTAINER}" "${old_operation}" "${scope}" "${old_text}"); [[ "${upgraded_digest}" == "${old_digest}" && "${upgraded_id}" == "${old_id}" && "${upgraded_type}" == "${old_type}" ]]
  IFS=$'\t' read -r new_digest new_id new_type < <(observe_operation "${CANDIDATE_CONTAINER}" "${new_operation}" "${scope}" "${new_text}"); assert_runtime_health "${CANDIDATE_CONTAINER}"; stop_gracefully "${CANDIDATE_CONTAINER}"
  start_runtime "${RESTART_CONTAINER}" "${CANDIDATE_VOLUME}" "${IMAGE_REF}"; assert_memory_resolves "${RESTART_CONTAINER}" "${scope}" "${old_id}" "${old_type}"; assert_memory_resolves "${RESTART_CONTAINER}" "${scope}" "${new_id}" "${new_type}"
  IFS=$'\t' read -r new_replay_digest new_replay_id new_replay_type < <(observe_operation "${RESTART_CONTAINER}" "${new_operation}" "${scope}" "${new_text}"); [[ "${new_replay_digest}" == "${new_digest}" && "${new_replay_id}" == "${new_id}" && "${new_replay_type}" == "${new_type}" ]]; assert_runtime_health "${RESTART_CONTAINER}"; stop_gracefully "${RESTART_CONTAINER}"
  local post_backup replay_snapshot before_recovery restore recovery_hardening after_recovery
  post_backup="$(run_data_ops "${CANDIDATE_VOLUME}" backup --db /data/aionis-lite-write.sqlite --out /data/post-upgrade-write.sqlite)"; jq -e '.verification.ok == true and .manifest.schema_version == 6 and .manifest.contract_version == "aionis_lite_runtime_backup_manifest_v2"' <<<"${post_backup}" >/dev/null
  replay_snapshot="$(snapshot_replay "${CANDIDATE_VOLUME}")"; jq -e '.quick_check == ["ok"] and (.sha256 | test("^[0-9a-f]{64}$"))' <<<"${replay_snapshot}" >/dev/null
  before_recovery="$(run_data_ops "${CANDIDATE_VOLUME}" verify --db /data/aionis-lite-write.sqlite)"; assert_verify_current <<<"${before_recovery}"
  restore="$(docker run --rm --platform linux/amd64 --network none --mount "type=volume,source=${CANDIDATE_VOLUME},target=/source,readonly" --mount "type=volume,source=${RECOVERY_VOLUME},target=/data" "${IMAGE_REF}" node --import tsx scripts/runtime-data-ops.ts restore --backup /source/post-upgrade-write.sqlite --to /data/aionis-lite-write.sqlite)"; jq -e '.verification.ok == true and .verification.schema.classification == "current" and .source_manifest.contract_version == "aionis_lite_runtime_backup_manifest_v2"' <<<"${restore}" >/dev/null
  docker run --rm --platform linux/amd64 --network none --mount "type=volume,source=${CANDIDATE_VOLUME},target=/source,readonly" --mount "type=volume,source=${RECOVERY_VOLUME},target=/data" "${IMAGE_REF}" node --input-type=module -e 'import { copyFileSync } from "node:fs"; copyFileSync("/source/post-upgrade-replay.sqlite", "/data/aionis-lite-replay.sqlite");'
  recovery_hardening="$(run_data_ops "${RECOVERY_VOLUME}" upgrade --db /data/aionis-lite-write.sqlite --replay-db /data/aionis-lite-replay.sqlite)"; jq -e '.before.classification == "current" and .after.classification == "current" and .replay_database.quick_check == ["ok"] and .replay_database.mode_after == "0600"' <<<"${recovery_hardening}" >/dev/null
  start_runtime "${RECOVERED_CONTAINER}" "${RECOVERY_VOLUME}" "${IMAGE_REF}"; assert_memory_resolves "${RECOVERED_CONTAINER}" "${scope}" "${old_id}" "${old_type}"; assert_memory_resolves "${RECOVERED_CONTAINER}" "${scope}" "${new_id}" "${new_type}"
  IFS=$'\t' read -r restored_old_digest restored_old_id restored_old_type < <(observe_operation "${RECOVERED_CONTAINER}" "${old_operation}" "${scope}" "${old_text}"); IFS=$'\t' read -r restored_new_digest restored_new_id restored_new_type < <(observe_operation "${RECOVERED_CONTAINER}" "${new_operation}" "${scope}" "${new_text}")
  [[ "${restored_old_digest}" == "${old_digest}" && "${restored_old_id}" == "${old_id}" && "${restored_old_type}" == "${old_type}" && "${restored_new_digest}" == "${new_digest}" && "${restored_new_id}" == "${new_id}" && "${restored_new_type}" == "${new_type}" ]]; assert_runtime_health "${RECOVERED_CONTAINER}"; stop_gracefully "${RECOVERED_CONTAINER}"
  after_recovery="$(run_data_ops "${CANDIDATE_VOLUME}" verify --db /data/aionis-lite-write.sqlite)"; assert_verify_current <<<"${after_recovery}"; [[ "$(jq -r '.snapshot_fingerprint.sha256' <<<"${before_recovery}")" == "$(jq -r '.snapshot_fingerprint.sha256' <<<"${after_recovery}")" ]]
  [[ "$(volume_fingerprint "${ORIGINAL_VOLUME}")" == "${original_fingerprint}" ]]; start_runtime "${ROLLBACK_CONTAINER}" "${ORIGINAL_VOLUME}" "${OLD_IMAGE}"; assert_memory_resolves "${ROLLBACK_CONTAINER}" "${scope}" "${old_id}" "${old_type}"
  IFS=$'\t' read -r rollback_digest rollback_id rollback_type < <(observe_operation "${ROLLBACK_CONTAINER}" "${old_operation}" "${scope}" "${old_text}"); [[ "${rollback_digest}" == "${old_digest}" && "${rollback_id}" == "${old_id}" && "${rollback_type}" == "${old_type}" ]]; assert_memory_absent "${ROLLBACK_CONTAINER}" "${new_id}"; stop_legacy "${ROLLBACK_CONTAINER}"
  jq -n --arg started_at "${started_at}" --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg source_image "${OLD_IMAGE}" --arg source_commit "${OLD_COMMIT}" --arg candidate_image "${IMAGE_REF}" --arg candidate_commit "${EXPECTED_COMMIT}" --arg candidate_tag "${EXPECTED_TAG}" --arg original_fingerprint "${original_fingerprint}" --arg replay_sha256 "$(jq -r '.sha256' <<<"${replay_snapshot}")" --arg docker_health_timeout "${HEALTH_TIMEOUT}" --argjson docker_health_required "${REQUIRE_DOCKER_HEALTH}" --argjson request_timeout_ms "${REQUEST_TIMEOUT_MS}" --argjson ready_timeout_seconds "${READY_TIMEOUT_SECONDS}" --argjson upgrade "${upgrade}" --argjson restore "${restore}" '{contract_version:"aionis_docker_cross_version_upgrade_smoke_v1",gate_passed:true,platform:"linux/amd64",docker_health_required:$docker_health_required,request_timeout_ms:$request_timeout_ms,ready_timeout_seconds:$ready_timeout_seconds,docker_health_timeout:$docker_health_timeout,coordinates:{source:{image:$source_image,commit:$source_commit,tag:"v0.3.6",schema:2},candidate:{image:$candidate_image,commit:$candidate_commit,tag:$candidate_tag,schema:6}},upgrade:{from:$upgrade.before.classification,to:$upgrade.after.classification,replay_mode_before:$upgrade.replay_database.mode_before,replay_mode_after:$upgrade.replay_database.mode_after,counts_preserved:true,old_memory_and_operation_replay_preserved:true},candidate_restart:{both_memories_resolved:true,exact_operation_replay:true,workers_healthy:true},replacement_container_recovery:{manifest_contract:$restore.source_manifest.contract_version,replay_snapshot_sha256:$replay_sha256,both_memories_resolved:true,both_operation_replays_exact:true,workers_healthy:true,source_database_unchanged:true},rollback:{strategy:"reattach_unmodified_full_v2_volume",original_volume_fingerprint:$original_fingerprint,v036_restarted:true,pre_upgrade_memory_resolved:true,pre_upgrade_operation_replay_exact:true,post_upgrade_memory_absent:true,upgraded_v6_never_opened_by_v036:true},started_at:$started_at,completed_at:$completed_at}'
}

cd "${ROOT_DIR}"
ensure_image "${IMAGE_REF}"
[[ "$(docker image inspect --format '{{.Architecture}}' "${IMAGE_REF}")" == "amd64" ]] || { echo "Docker smoke only verifies linux/amd64" >&2; exit 1; }
if [[ "${MODE}" == "cross-version" ]]; then run_cross_version; else run_recovery; fi

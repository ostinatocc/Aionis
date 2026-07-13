#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: scripts/start-lite.sh [--print-env] [node args...]

Starts the focused Aionis Runtime directly from src/index.ts.

Flags:
  --print-env   Print the effective Runtime env as JSON and exit.
  --help        Show this help.
EOF
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! node -e 'try { require("node:sqlite"); } catch { process.exit(1); }' >/dev/null 2>&1; then
  cat >&2 <<'EOF'
start:lite requires Node.js with node:sqlite support.
Use Node 22+ for the focused local Runtime.
EOF
  exit 1
fi

export AIONIS_EDITION="${AIONIS_EDITION:-lite}"
export AIONIS_MODE="${AIONIS_MODE:-local}"
export APP_ENV="${APP_ENV:-dev}"
export AIONIS_LISTEN_HOST="${AIONIS_LISTEN_HOST:-127.0.0.1}"
export AIONIS_ALLOW_UNAUTHENTICATED_REMOTE="${AIONIS_ALLOW_UNAUTHENTICATED_REMOTE:-false}"
export MEMORY_AUTH_MODE="${MEMORY_AUTH_MODE:-off}"
export TENANT_QUOTA_ENABLED="${TENANT_QUOTA_ENABLED:-false}"
export RATE_LIMIT_BYPASS_LOOPBACK="${RATE_LIMIT_BYPASS_LOOPBACK:-true}"
export LITE_REPLAY_SQLITE_PATH="${LITE_REPLAY_SQLITE_PATH:-${ROOT_DIR}/.tmp/aionis-lite-replay.sqlite}"
export LITE_WRITE_SQLITE_PATH="${LITE_WRITE_SQLITE_PATH:-${ROOT_DIR}/.tmp/aionis-lite-write.sqlite}"
export LITE_LOCAL_ACTOR_ID="${LITE_LOCAL_ACTOR_ID:-local-user}"
export LITE_INSPECTOR_ENABLED="${LITE_INSPECTOR_ENABLED:-false}"
export LITE_INSPECTOR_DIST_PATH="${LITE_INSPECTOR_DIST_PATH:-}"
export SANDBOX_ENABLED="${SANDBOX_ENABLED:-false}"
export SANDBOX_ADMIN_ONLY="${SANDBOX_ADMIN_ONLY:-true}"
export LITE_SANDBOX_PROFILE="${LITE_SANDBOX_PROFILE:-}"

case "${LITE_SANDBOX_PROFILE}" in
  "")
    ;;
  local_process_echo)
    export SANDBOX_ENABLED="true"
    export SANDBOX_ADMIN_ONLY="false"
    export SANDBOX_EXECUTOR_MODE="${SANDBOX_EXECUTOR_MODE:-local_process}"
    export SANDBOX_ALLOWED_COMMANDS_JSON="${SANDBOX_ALLOWED_COMMANDS_JSON:-[\"echo\"]}"
    ;;
  *)
    cat >&2 <<EOF
Unknown LITE_SANDBOX_PROFILE=${LITE_SANDBOX_PROFILE}
Supported profiles:
  local_process_echo
EOF
    exit 1
    ;;
esac

if [[ "${1:-}" == "--print-env" ]]; then
  node - <<'JS'
const keys = [
  "AIONIS_EDITION",
  "AIONIS_MODE",
  "APP_ENV",
  "AIONIS_LISTEN_HOST",
  "AIONIS_ALLOW_UNAUTHENTICATED_REMOTE",
  "MEMORY_AUTH_MODE",
  "TENANT_QUOTA_ENABLED",
  "RATE_LIMIT_BYPASS_LOOPBACK",
  "LITE_REPLAY_SQLITE_PATH",
  "LITE_WRITE_SQLITE_PATH",
  "LITE_LOCAL_ACTOR_ID",
  "LITE_INSPECTOR_ENABLED",
  "LITE_INSPECTOR_DIST_PATH",
  "LITE_SANDBOX_PROFILE",
  "SANDBOX_ENABLED",
  "SANDBOX_ADMIN_ONLY",
  "SANDBOX_EXECUTOR_MODE",
  "SANDBOX_ALLOWED_COMMANDS_JSON",
];
process.stdout.write(`${JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null])), null, 2)}\n`);
JS
  exit 0
fi

cd "${ROOT_DIR}"
exec node --import tsx src/index.ts "$@"

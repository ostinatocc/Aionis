#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: scripts/start-lite.sh [--print-env] [node args...]

Starts the focused Aionis Runtime directly from src/runtime-entry.ts.

Flags:
  --print-env   Print the effective Runtime env as JSON and exit.
  --help        Show this help.
EOF
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported = major === 22 ? minor >= 15 : major === 23 ? minor >= 10 : major > 23;
  process.exit(supported ? 0 : 1);
' >/dev/null 2>&1; then
  cat >&2 <<'EOF'
start:lite requires Node.js >=22.15.0 <23 or >=23.10.0.
Earlier node:sqlite releases cannot open the URL paths used for immutable and existing-file-only access.
EOF
  exit 1
fi

if ! node -e 'try { require("node:sqlite"); } catch { process.exit(1); }' >/dev/null 2>&1; then
  cat >&2 <<'EOF'
start:lite requires Node.js with node:sqlite support.
Use Node.js >=22.15.0 <23 or >=23.10.0 for the focused local Runtime.
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
export LITE_WRITE_SQLITE_PATH="${LITE_WRITE_SQLITE_PATH:-${ROOT_DIR}/.tmp/aionis-lite-write.sqlite}"
export LITE_LOCAL_ACTOR_ID="${LITE_LOCAL_ACTOR_ID:-local-user}"
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
  "LITE_WRITE_SQLITE_PATH",
  "LITE_LOCAL_ACTOR_ID",
];
process.stdout.write(`${JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null])), null, 2)}\n`);
JS
  exit 0
fi

cd "${ROOT_DIR}"
exec node --import tsx src/runtime-entry.ts "$@"

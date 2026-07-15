# Aionis Releases

Status: v0.3.9 Local Runtime Public Beta candidate.

This train targets one self-hosted Runtime process. It is not GA, a managed
multi-tenant service, or a multi-instance HA release. Release tags are
immutable; if a frozen surface changes, create another patch instead of moving
a tag.

## Current Release Coordinates

| Artifact | Current channel | Immutable source ref | Purpose |
|---|---:|---:|---|
| GitHub Runtime source | `v0.3.9` candidate tag | `v0.3.9` | Runtime source, product APIs, docs, Docker build, and validation loops. |
| Docker image | `ghcr.io/ostinatocc/aionis:v0.3.9` candidate | Runtime `v0.3.9` | Verified `linux/amd64` Local Runtime image with persistent SQLite state under `/data`. |
| Default installer Runtime ref | `v0.3.6` | `v0.3.6` | Last immutable Runtime selected by the frozen installer. |
| `aionis` | `0.3.8` npm candidate | `v0.3.8` | Top-level setup and operator CLI. |
| `@aionis/create` | `0.3.8` frozen | `v0.3.8` | One-command installer; its default remains Runtime v0.3.6. |
| `@aionis/sdk` | `0.3.17` candidate | frozen commit | Exact persisted guide-feedback attribution plus canonical host-task and host-use receipt contracts. |
| `@aionis/mcp` | `0.3.7` candidate | `v0.3.7` | MCP stdio bridge for compatible clients. |
| `@aionis/aifs` | `0.3.4` candidate | `v0.3.4` | Governed file surface for file-aware Agents. |
| `@aionis/claude-code` | `0.3.5` candidate | `v0.3.5` | Claude Code lifecycle hooks and plugin metadata. |
| `@aionis/substrate` | `0.1.11` tracked sidecar | `v0.1.11` | External durable evidence mirror, audit, and backup sidecar. |

Every package compatibility ref above is paired with an exact 40-character
source commit in `release-train.json`. The Runtime root package is private
metadata and is not published to npm. This Runtime-only patch keeps every
external package coordinate frozen and does not re-attest the historical npm
registry provenance of those unchanged packages.

The candidate publishes only `linux/amd64`. `linux/arm64` remains outside the
matrix until that platform has its own Runtime smoke gate. Candidate status
does not move Docker `latest`.

Runtime patch notes: [v0.3.9 release notes](./releases/v0.3.9.md).

## v0.3.9 Candidate Scope

v0.3.9 packages the post-v0.3.8 durable learning-control worker and its
confirmatory SQLite contention hardening:

- formal guide-attributed feedback and one deterministic unused-exposure job
  commit in the same SQLite transaction;
- feedback reports `learning_control_status: queued|already_completed` without
  claiming synchronous posture mutation;
- the worker uses lease-token fencing, restart reclaim, bounded retry, retained
  dead letters, protected receipts, and atomic completion;
- worker-side recomputation blocks stale negative transfer when later positive
  attribution exists;
- enrolled terminal failures create an independent safety pause before the job
  can enter dead letter;
- health/readiness expose worker and backlog state, and shutdown waits for an
  in-flight drain;
- confirmatory provisioning retries only `SQLITE_BUSY` from `BEGIN IMMEDIATE`
  within a six-attempt budget; transaction bodies and commits are not replayed;
- an exact concurrent replay still returns the stored receipt before consuming
  authority entropy.

Historical feedback without queue provenance remains readable and is not
backfilled. v0.3.8 data upgrades forward while the SQLite authority stays at
v4, but a database containing new queue-provenance events must not be
downgraded to v0.3.8. The route and environment contracts do not change,
global candidate serving stays off, and later promotion phases remain outside
this release.

## Supported Deployment Shape

The candidate supports one Runtime process with SQLite authority. Lite local
ANN is process memory and is rebuilt from committed SQLite vectors after
restart. For several Runtime processes, use a shared persistent ANN or an
explicit cross-instance reconciliation mechanism. Do not expose auth-off Lite
to an untrusted network.

## Docker Quickstart

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -v aionis-data:/data \
  ghcr.io/ostinatocc/aionis:v0.3.9
```

```bash
curl http://127.0.0.1:3001/healthz
curl http://127.0.0.1:3001/readyz
curl http://127.0.0.1:3001/health
```

The container persists SQLite state under `/data` and binds the published host
port to loopback. Remote evaluation requires Server mode authentication and a
service boundary; it is not a managed-service claim.

## Release Gate

```bash
npm run -s typecheck
npm run -s lite:test
npm run -s lite:smoke
npm run -s sdk:check -- --sdk-repo /Volumes/ziel/new.aionis/aionis-sdk
npm run -s complexity:check
node --test \
  scripts/ci/release-version-docs.test.mjs \
  scripts/ci/release-artifact-gate.test.mjs \
  scripts/ci/release-workflow-contract.test.mjs
node scripts/ci/release-artifact-gate.mjs --check --expect-tag v0.3.9
# Against an already-running EMBEDDING_PROVIDER=none Runtime:
AIONIS_BASE_URL="http://127.0.0.1:3210" \
AIONIS_EXTERNAL_SMOKE_SDK_SPEC="@aionis/sdk@0.3.17" \
AIONIS_EXTERNAL_SMOKE_MCP_SPEC="@aionis/mcp@0.3.7" \
AIONIS_EXTERNAL_SMOKE_CREATE_SPEC="@aionis/create@0.3.8" \
AIONIS_EXTERNAL_SMOKE_EMBEDDING_EXPECTATION=unavailable \
  npm run -s runtime:smoke:external-packages
AIONIS_PUBLISHED_CLI_SMOKE_SPEC="aionis@0.3.8" \
  npm run -s runtime:smoke:published-cli
docker build --platform linux/amd64 \
  --iidfile /tmp/aionis-v0.3.9.iid \
  -t aionis:v0.3.9-smoke .
bash scripts/ci/docker-release-smoke.sh \
  "$(cat /tmp/aionis-v0.3.9.iid)"
```

The gate includes real SQLite and child-process crash/restart coverage, exact
package checkout, release metadata binding, cross-package tarball and tagged
fresh-install smoke in the release workflow, and digest-pinned Docker smoke.
Mocks are not release evidence.

## Publish Order

This Runtime-only patch does not publish or republish npm packages:

```bash
# 1. Merge the verified release commit, then synchronize and verify main.
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
git fetch origin main --tags
git switch main
git pull --ff-only origin main
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test "$(node -p 'require("./package.json").version')" = "0.3.9"

# Tag the verified remote-main commit explicitly, never the release branch HEAD.
MAIN_COMMIT="$(git rev-parse origin/main)"
# Wait until required CI for this exact main commit is green before tagging.
git tag -a v0.3.9 "$MAIN_COMMIT" -m "Aionis v0.3.9"
test "$(git rev-parse 'v0.3.9^{}')" = "$MAIN_COMMIT"
git push origin v0.3.9

# 2. Wait for the tagged Docker workflow and verify the immutable artifact.
git ls-remote --exit-code --tags origin refs/tags/v0.3.9
docker pull --platform linux/amd64 ghcr.io/ostinatocc/aionis:v0.3.9

# 3. Create the GitHub release after the image verifies.
gh release create v0.3.9 \
  --repo ostinatocc/Aionis \
  --title "Aionis v0.3.9 Durable Learning Control Candidate" \
  --notes-file docs/releases/v0.3.9.md
```

Do not republish `@aionis/create@0.3.8`; it is already frozen. Do not republish
the CLI, SDK, MCP, AIFS, Claude Code, or Substrate coordinates for this
Runtime-only patch. The default installer remains on Runtime v0.3.6.

## Exact-Version Post-Publish Smoke

```bash
AIONIS_FRESH_INSTALL_CREATE_SPEC="@aionis/create@0.3.8" \
AIONIS_FRESH_INSTALL_SDK_SPEC="@aionis/sdk@0.3.17" \
AIONIS_FRESH_INSTALL_MCP_SPEC="@aionis/mcp@0.3.7" \
AIONIS_FRESH_INSTALL_REPO="https://github.com/ostinatocc/Aionis.git" \
AIONIS_FRESH_INSTALL_RUNTIME_REF="v0.3.9" \
npm run -s runtime:smoke:fresh-install

AIONIS_PUBLISHED_CLI_SMOKE_SPEC="aionis@0.3.8" \
npm run -s runtime:smoke:published-cli
```

No image or Public Beta announcement is complete until immutable refs resolve,
the tagged Docker workflow passes, and the exact-version smoke succeeds.

The embedding-available external-package run is separate evidence because
release CI intentionally uses `EMBEDDING_PROVIDER=none`. Credentials must be
injected only into the Runtime process; exact SDK/MCP/Create child processes
remain credential-free.

## Release History

- [v0.3.9 durable learning-control candidate](./releases/v0.3.9.md)
- [v0.3.8 exact guide-feedback attribution candidate](./releases/v0.3.8.md)
- [v0.3.7 evidence-gated learning candidate](./releases/v0.3.7.md)
- [v0.3.6 release-integrity candidate](./releases/v0.3.6.md)
- [v0.3.5 continuity and evidence candidate](./releases/v0.3.5.md)

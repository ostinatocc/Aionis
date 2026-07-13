# Aionis Releases

Status: v0.3.6 Local Runtime Public Beta candidate.

This train targets one self-hosted Runtime process. It is not GA, a managed
multi-tenant service, or a multi-instance HA release. Release tags are
immutable; if a frozen surface changes, create another patch instead of moving
a tag.

## Current Release Coordinates

| Artifact | Current channel | Immutable source ref | Purpose |
|---|---:|---:|---|
| GitHub Runtime source | `v0.3.6` candidate tag | `v0.3.6` | Runtime source, product APIs, docs, Docker build, and validation loops. |
| Docker image | `ghcr.io/ostinatocc/aionis:v0.3.6` candidate | Runtime `v0.3.6` | Verified `linux/amd64` Local Runtime image with persistent SQLite state under `/data`. |
| Default installer Runtime ref | `v0.3.6` | `v0.3.6` | Immutable source selected by the installer. |
| `aionis` | `0.3.8` npm candidate | `v0.3.8` | Top-level setup and operator CLI. |
| `@aionis/create` | `0.3.8` candidate | `v0.3.8` | One-command Runtime installer pinned to Runtime v0.3.6. |
| `@aionis/sdk` | `0.3.15` candidate | `v0.3.15` | Typed AgentContext, durable write receipts, projection scheduling, and evidence assessment. |
| `@aionis/mcp` | `0.3.7` candidate | `v0.3.7` | MCP stdio bridge for compatible clients. |
| `@aionis/aifs` | `0.3.4` candidate | `v0.3.4` | Governed file surface for file-aware Agents. |
| `@aionis/claude-code` | `0.3.5` candidate | `v0.3.5` | Claude Code lifecycle hooks and plugin metadata. |
| `@aionis/substrate` | `0.1.11` tracked sidecar | `v0.1.11` | External durable evidence mirror, audit, and backup sidecar. |

Every package ref above is paired with an exact 40-character source commit in
`release-train.json`. Before publication, each tag must resolve to that commit
and pass cross-package checkout. Manifest remains outside the train until it
has a verifiable source repository and immutable ref.

The candidate publishes only `linux/amd64`. `linux/arm64` remains outside the
matrix until that exact platform has its own runtime smoke gate. Candidate
status also means Docker `latest` is not moved.

Runtime patch notes: [v0.3.6 release notes](./releases/v0.3.6.md).

## v0.3.6 Maintenance Scope

v0.3.6 keeps the v0.3.5 HTTP, SDK/MCP, SQLite schema, and durable event
contracts. It changes release integrity and the supported source-install floor:

- Lite and fresh-install smoke use bounded direct-process cleanup;
- Linux Docker release smoke owns and cleans its process group;
- provenance uses a unique build/commit/run staging subject rather than
  `latest`;
- one verified digest is smoked before promotion to the version tag;
- exact package checkouts are packed and exercised as real artifacts;
- source/local Runtime and Create installs require Node.js `>=22.13.0` because
  earlier experimental Node 22 SQLite releases have incompatible empty-row
  semantics.

Docker continues to use Node.js 24. No data migration is required from v0.3.5.

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
  ghcr.io/ostinatocc/aionis:v0.3.6
```

```bash
curl http://127.0.0.1:3001/healthz
curl http://127.0.0.1:3001/readyz
curl http://127.0.0.1:3001/health
```

The default container persists SQLite state under `/data` and binds the
published host port to loopback. Remote evaluation requires Server mode
authentication and a service boundary; it is not a managed-service claim.

## Release Gate

```bash
npm run -s typecheck
npm run -s lite:test
npm run -s lite:smoke
npm run -s sdk:check
npm run -s complexity:check
node scripts/ci/release-artifact-gate.mjs --check --expect-tag v0.3.6
npm run -s runtime:smoke:external-packages
npm run -s runtime:smoke:fresh-install
npm run -s runtime:smoke:published-cli
docker build --platform linux/amd64 \
  --iidfile /tmp/aionis-v0.3.6.iid \
  -t aionis:v0.3.6-smoke .
bash scripts/ci/docker-release-smoke.sh \
  "$(cat /tmp/aionis-v0.3.6.iid)"
```

The gate includes real SQLite/HTTP transaction tests, immediate-post-commit
crash recovery, exact package checkout, and digest-pinned Docker smoke. Mocks
are not release evidence.

## Publish Order

Create remains unpublished until Runtime `v0.3.6` and its verified Docker
digest resolve:

```bash
# 1. Merge the verified Runtime release commit and create the immutable tag.
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
git push origin main
git tag -a v0.3.6 -m "Aionis v0.3.6"
git push origin v0.3.6

# 2. Wait for Docker publication and verify the immutable Runtime artifact.
git ls-remote --exit-code --tags origin refs/tags/v0.3.6
docker pull ghcr.io/ostinatocc/aionis:v0.3.6

# 3. Publish the already frozen version-pinned installer.
cd /Volumes/ziel/new.aionis/aionis-create
npm publish --access public
```

This document records the procedure; it does not authorize package
publication by itself.

## Exact-Version Post-Publish Smoke

```bash
AIONIS_FRESH_INSTALL_CREATE_SPEC="@aionis/create@0.3.8" \
AIONIS_FRESH_INSTALL_SDK_SPEC="@aionis/sdk@0.3.15" \
AIONIS_FRESH_INSTALL_MCP_SPEC="@aionis/mcp@0.3.7" \
AIONIS_FRESH_INSTALL_REPO="https://github.com/ostinatocc/Aionis.git" \
AIONIS_FRESH_INSTALL_RUNTIME_REF="v0.3.6" \
npm run -s runtime:smoke:fresh-install

AIONIS_PUBLISHED_CLI_SMOKE_SPEC="aionis@0.3.8" \
npm run -s runtime:smoke:published-cli
```

No package, image, or Public Beta announcement is complete until immutable
refs resolve and the exact-version smoke passes.

## Release History

- [v0.3.6 maintenance candidate](./releases/v0.3.6.md)
- [v0.3.5 continuity and evidence candidate](./releases/v0.3.5.md)

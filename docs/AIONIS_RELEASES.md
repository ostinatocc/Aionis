# Aionis Releases

Status: v0.3.5 Local Runtime Public Beta candidate.

This train targets one self-hosted Runtime process. It is not GA, a managed
multi-tenant service, or a multi-instance HA release. Release tags are
immutable; if a frozen surface changes, create another patch instead of moving
a tag.

## Current Release Coordinates

| Artifact | Current channel | Immutable source ref | Purpose |
|---|---:|---:|---|
| GitHub Runtime source | `v0.3.5` candidate tag | `v0.3.5` | Runtime source, product APIs, docs, Docker build, and validation loops. |
| Docker image | `ghcr.io/ostinatocc/aionis:v0.3.5` candidate | Runtime `v0.3.5` | Verified `linux/amd64` single-process Local Runtime container with persistent SQLite state under `/data`. |
| Default installer Runtime ref | `v0.3.5` | `v0.3.5` | Immutable source selected by `aionis setup` and Create. |
| `aionis` | `0.3.8` npm candidate | `v0.3.8` | Top-level setup and operator CLI. |
| `@aionis/create` | `0.3.7` candidate | `v0.3.7` | One-command Runtime installer. |
| `@aionis/sdk` | `0.3.15` candidate | `v0.3.15` | Typed AgentContext, durable write receipts, projection scheduling, and Runtime-owned evidence assessment. |
| `@aionis/mcp` | `0.3.7` candidate | `v0.3.7` | MCP stdio bridge for compatible clients. |
| `@aionis/aifs` | `0.3.4` candidate | `v0.3.4` | Governed file surface for file-aware Agents. |
| `@aionis/claude-code` | `0.3.5` candidate | `v0.3.5` | Claude Code lifecycle hooks and plugin metadata. |
| `@aionis/substrate` | `0.1.11` tracked sidecar | `v0.1.11` | External durable evidence mirror/audit/backup sidecar. |

Every source ref above is paired with an exact 40-character source commit in
`release-train.json`. Before publication, each tag must resolve to that frozen
commit and pass cross-package checkout. Manifest is deliberately excluded until
it has a verifiable source repository and immutable ref.

This candidate publishes only `linux/amd64`. `linux/arm64` remains outside the
release matrix until that exact platform has its own runtime smoke gate.

Runtime patch notes: [v0.3.5 release notes](./releases/v0.3.5.md).

## v0.3.5 Contract Train

SDK `0.3.15` matches Runtime `v0.3.5` and carries these changed contracts:

- `/v1/observe` durable `operation_id`, exact stored-receipt replay, and
  `post_commit_projections` scheduling;
- direct `/v1/handoff/store` durable `operation_id` replay;
- `/v1/measure -> evidence_assessment`, measurement digest/persistence, and
  ignored client evidence claims;
- execution helper propagation of `operation_id`;
- projection health states `pending`, `running`, `retry`, `dead_letter`, and
  `succeeded`.

`scheduled` projection status is durable intent, not synchronous completion.
Client `sufficient_evidence` and `evidence_ids` do not open the evidence gate.

## Repository Boundary

| Repository | Release responsibility |
|---|---|
| [ostinatocc/Aionis](https://github.com/ostinatocc/Aionis) | Runtime source tag, Docker image, public contracts, docs, and Runtime validation. |
| [ostinatocc/aionis-cli](https://github.com/ostinatocc/aionis-cli) | `aionis` npm package. |
| [ostinatocc/aionis-create](https://github.com/ostinatocc/aionis-create) | `@aionis/create` installer. |
| [ostinatocc/aionis-sdk](https://github.com/ostinatocc/aionis-sdk) | `@aionis/sdk` package and typed contracts. |
| [ostinatocc/aionis-mcp](https://github.com/ostinatocc/aionis-mcp) | `@aionis/mcp` bridge. |
| [ostinatocc/aionis-aifs](https://github.com/ostinatocc/aionis-aifs) | `@aionis/aifs` file surface. |
| [ostinatocc/aionis-claude-code](https://github.com/ostinatocc/aionis-claude-code) | Claude Code plugin and helper package. |
| [ostinatocc/AionisSubstrate](https://github.com/ostinatocc/AionisSubstrate) | External sidecar package. |

## Supported Deployment Shape

The Public Beta candidate supports one Runtime process with SQLite authority.
Lite local ANN is process memory and is rebuilt from committed SQLite vectors
after restart. For several Runtime processes, use a shared persistent ANN or an
explicit cross-instance reconciliation mechanism. Do not expose auth-off Lite
to an untrusted network.

## Docker Quickstart

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -v aionis-data:/data \
  ghcr.io/ostinatocc/aionis:v0.3.5
```

Check the Runtime and projection state:

```bash
curl http://127.0.0.1:3001/healthz
curl http://127.0.0.1:3001/readyz
curl http://127.0.0.1:3001/health
```

The default local container keeps persistent SQLite state under `/data` and
binds the published host port to loopback. Remote evaluation requires Server
mode authentication and a service boundary; it is not a managed-service claim.

## Release Gate

Run the full gate against the frozen Runtime and exact package refs:

```bash
npm run -s typecheck
npm run -s lite:test
npm run -s lite:smoke
npm run -s sdk:check
npm run -s complexity:check
npm run -s runtime:smoke:external-packages
npm run -s runtime:smoke:fresh-install
npm run -s runtime:smoke:published-cli
docker build --platform linux/amd64 \
  --iidfile /tmp/aionis-release-smoke.iid \
  -t aionis:release-smoke .
bash scripts/ci/docker-release-smoke.sh \
  "$(cat /tmp/aionis-release-smoke.iid)"
```

When an Apple Silicon workstation emulates the amd64 candidate, keep the same
checks but allow QEMU more startup time with
`AIONIS_DOCKER_SMOKE_ATTEMPTS=360` and
`AIONIS_DOCKER_SMOKE_HEALTH_TIMEOUT=60s`. Native amd64 CI uses the stricter
defaults.

The gate includes real SQLite/HTTP transaction tests and real child-process
immediate-post-commit crash recovery. Mocks are not release evidence.

## Publish Order

Create must remain unpublished until Runtime `v0.3.5` and its Docker image
resolve. SDK `0.3.15` must resolve before exact-version Runtime checkout:

```bash
# 1. Freeze and publish SDK.
cd /Volumes/ziel/new.aionis/aionis-sdk
git tag -a v0.3.15 -m "@aionis/sdk v0.3.15"
git push origin v0.3.15
npm publish --access public

# 2. Push verified Runtime source, tag it, and publish the GitHub release.
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
git push origin main
git tag -a v0.3.5 -m "Aionis v0.3.5"
git push origin v0.3.5
gh release create v0.3.5 \
  --repo ostinatocc/Aionis \
  --title "Aionis v0.3.5 Local Runtime Public Beta" \
  --notes-file docs/releases/v0.3.5.md

# 3. Verify tag and the linux/amd64 image, then publish Create.
docker pull ghcr.io/ostinatocc/aionis:v0.3.5
git ls-remote --exit-code --tags origin refs/tags/v0.3.5
cd /Volumes/ziel/new.aionis/aionis-create
npm publish --access public
```

This document records the procedure; it does not create or publish anything.

## Exact-Version Post-Publish Smoke

```bash
AIONIS_FRESH_INSTALL_CREATE_SPEC="@aionis/create@0.3.7" \
AIONIS_FRESH_INSTALL_SDK_SPEC="@aionis/sdk@0.3.15" \
AIONIS_FRESH_INSTALL_MCP_SPEC="@aionis/mcp@0.3.7" \
AIONIS_FRESH_INSTALL_REPO="https://github.com/ostinatocc/Aionis.git" \
AIONIS_FRESH_INSTALL_RUNTIME_REF="v0.3.5" \
npm run -s runtime:smoke:fresh-install

AIONIS_PUBLISHED_CLI_SMOKE_SPEC="aionis@0.3.8" \
npm run -s runtime:smoke:published-cli
```

No package, image, or Public Beta announcement is complete until immutable refs
resolve and exact-version smoke passes.

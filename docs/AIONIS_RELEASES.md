# Aionis Releases

Status: v0.3.7 Local Runtime Public Beta candidate.

This train targets one self-hosted Runtime process. It is not GA, a managed
multi-tenant service, or a multi-instance HA release. Release tags are
immutable; if a frozen surface changes, create another patch instead of moving
a tag.

## Current Release Coordinates

| Artifact | Current channel | Immutable source ref | Purpose |
|---|---:|---:|---|
| GitHub Runtime source | `v0.3.7` candidate tag | `v0.3.7` | Runtime source, product APIs, docs, Docker build, and validation loops. |
| Docker image | `ghcr.io/ostinatocc/aionis:v0.3.7` candidate | Runtime `v0.3.7` | Verified `linux/amd64` Local Runtime image with persistent SQLite state under `/data`. |
| Default installer Runtime ref | `v0.3.6` | `v0.3.6` | Last immutable Runtime selected by the currently frozen installer. |
| `aionis` | `0.3.8` npm candidate | `v0.3.8` | Top-level setup and operator CLI. |
| `@aionis/create` | `0.3.8` candidate | `v0.3.8` | One-command Runtime installer; its default remains Runtime v0.3.6 during this candidate. |
| `@aionis/sdk` | `0.3.16` candidate | `v0.3.16` | Protected guide identity plus canonical host-task and host-use receipt contracts. |
| `@aionis/mcp` | `0.3.7` candidate | `v0.3.7` | MCP stdio bridge for compatible clients. |
| `@aionis/aifs` | `0.3.4` candidate | `v0.3.4` | Governed file surface for file-aware Agents. |
| `@aionis/claude-code` | `0.3.5` candidate | `v0.3.5` | Claude Code lifecycle hooks and plugin metadata. |
| `@aionis/substrate` | `0.1.11` tracked sidecar | `v0.1.11` | External durable evidence mirror, audit, and backup sidecar. |

Every package ref above is paired with an exact 40-character source commit in
`release-train.json`. Before publication, each tag must resolve to that commit
and pass cross-package checkout. The SDK `v0.3.16` tag must be reachable before
Runtime CI can verify this train.

The candidate publishes only `linux/amd64`. `linux/arm64` remains outside the
matrix until that exact platform has its own runtime smoke gate. Candidate
status also means Docker `latest` is not moved.

Runtime patch notes: [v0.3.7 release notes](./releases/v0.3.7.md).

## v0.3.7 Candidate Scope

v0.3.7 establishes a fail-closed evidence substrate for learning without
turning learning on globally:

- append-only learning episode authority and atomic v3-to-v4 migration;
- protected experiment provisioning, exact replay, safety stop, and close;
- protected guide operation identity with atomic exposure/item persistence;
- strict host-task and host-use receipt roots;
- atomic direct-memory feedback attribution bound to the exact served surface;
- independently derived attribution strength and restart tamper detection;
- SDK builders/parsers and a bounded host-adapter conformance command.

Legacy unprotected calls remain compatible but cannot become formal learning
evidence. Global candidate serving remains off. The production external policy
registry is not registered and the gate remains `calibration_pending`.

Task 4.1 Step 4 is not part of this checkpoint: the queue authority/schema is
reserved and integrity-checked, but no production direct-feedback enqueue or
lease/retry/dead-letter worker consumes it yet. Repeated-unused remains
observation-only and does not mutate memory posture.

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
  ghcr.io/ostinatocc/aionis:v0.3.7
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
npm run -s sdk:check -- --sdk-repo /Volumes/ziel/new.aionis/aionis-sdk
npm run -s complexity:check
AIONIS_RELEASE_SDK_REPO=/Volumes/ziel/new.aionis/aionis-sdk \
  node scripts/ci/release-artifact-gate.mjs --check --expect-tag v0.3.7
npm run -s runtime:smoke:external-packages
npm run -s runtime:smoke:fresh-install
npm run -s runtime:smoke:published-cli
docker build --platform linux/amd64 \
  --iidfile /tmp/aionis-v0.3.7.iid \
  -t aionis:v0.3.7-smoke .
bash scripts/ci/docker-release-smoke.sh \
  "$(cat /tmp/aionis-v0.3.7.iid)"
```

The gate includes real SQLite/HTTP transaction tests, exact package checkout,
restart integrity, and digest-pinned Docker smoke. Mocks are not release
evidence.

## Publish Order

SDK must resolve before Runtime CI consumes its frozen coordinate. The default
installer remains on v0.3.6 until a separately reviewed installer update:

```bash
# 1. Publish the verified SDK commit and immutable tag.
cd /Volumes/ziel/new.aionis/aionis-sdk
git push origin main
git push origin v0.3.16

# 2. Merge the verified Runtime release commit and create its immutable tag.
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
git push origin release/v0.3.7
git tag -a v0.3.7 -m "Aionis v0.3.7"
git push origin v0.3.7

# 3. Verify the Runtime artifact before changing installer defaults.
git ls-remote --exit-code --tags origin refs/tags/v0.3.7
docker pull ghcr.io/ostinatocc/aionis:v0.3.7

# 4. Publish a separately frozen installer only after Runtime verification.
cd /Volumes/ziel/new.aionis/aionis-create
npm publish --access public
```

This document records the procedure; it does not authorize package
publication by itself.

## Exact-Version Post-Publish Smoke

```bash
AIONIS_FRESH_INSTALL_CREATE_SPEC="@aionis/create@0.3.8" \
AIONIS_FRESH_INSTALL_SDK_SPEC="@aionis/sdk@0.3.16" \
AIONIS_FRESH_INSTALL_MCP_SPEC="@aionis/mcp@0.3.7" \
AIONIS_FRESH_INSTALL_REPO="https://github.com/ostinatocc/Aionis.git" \
AIONIS_FRESH_INSTALL_RUNTIME_REF="v0.3.7" \
npm run -s runtime:smoke:fresh-install

AIONIS_PUBLISHED_CLI_SMOKE_SPEC="aionis@0.3.8" \
npm run -s runtime:smoke:published-cli
```

No package, image, or Public Beta announcement is complete until immutable
refs resolve and the exact-version smoke passes.

## Release History

- [v0.3.7 evidence-gated learning candidate](./releases/v0.3.7.md)
- [v0.3.6 release-integrity candidate](./releases/v0.3.6.md)
- [v0.3.5 continuity and evidence candidate](./releases/v0.3.5.md)

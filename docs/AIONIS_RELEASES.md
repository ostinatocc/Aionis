# Aionis Releases

Status: v0.3.8 Local Runtime Public Beta candidate.

This train targets one self-hosted Runtime process. It is not GA, a managed
multi-tenant service, or a multi-instance HA release. Release tags are
immutable; if a frozen surface changes, create another patch instead of moving
a tag.

## Current Release Coordinates

| Artifact | Current channel | Immutable source ref | Purpose |
|---|---:|---:|---|
| GitHub Runtime source | `v0.3.8` candidate tag | `v0.3.8` | Runtime source, product APIs, docs, Docker build, and validation loops. |
| Docker image | `ghcr.io/ostinatocc/aionis:v0.3.8` candidate | Runtime `v0.3.8` | Verified `linux/amd64` Local Runtime image with persistent SQLite state under `/data`. |
| Default installer Runtime ref | `v0.3.6` | `v0.3.6` | Last immutable Runtime selected by the frozen installer. |
| `aionis` | `0.3.8` npm candidate | `v0.3.8` | Top-level setup and operator CLI. |
| `@aionis/create` | `0.3.8` frozen | `v0.3.8` | One-command installer; its default remains Runtime v0.3.6. |
| `@aionis/sdk` | `0.3.17` candidate | `v0.3.17` | Exact persisted guide-feedback attribution plus canonical host-task and host-use receipt contracts. |
| `@aionis/mcp` | `0.3.7` candidate | `v0.3.7` | MCP stdio bridge for compatible clients. |
| `@aionis/aifs` | `0.3.4` candidate | `v0.3.4` | Governed file surface for file-aware Agents. |
| `@aionis/claude-code` | `0.3.5` candidate | `v0.3.5` | Claude Code lifecycle hooks and plugin metadata. |
| `@aionis/substrate` | `0.1.11` tracked sidecar | `v0.1.11` | External durable evidence mirror, audit, and backup sidecar. |

Every package ref above is paired with an exact 40-character source commit in
`release-train.json`. Before publication, each planned tag must resolve to that
commit and pass cross-package checkout. SDK `v0.3.17` must be reachable before
Runtime CI can verify the final tagged train.

The candidate publishes only `linux/amd64`. `linux/arm64` remains outside the
matrix until that platform has its own Runtime smoke gate. Candidate status
does not move Docker `latest`.

Runtime patch notes: [v0.3.8 release notes](./releases/v0.3.8.md).

## v0.3.8 Corrective Scope

v0.3.8 preserves the v0.3.7 evidence substrate and closes a feedback boundary:

- guide returns post-append `feedback_attribution_v1` from persisted SQLite
  authority, with explicit available/unavailable status;
- SDK feedback requires the complete guide, exact persisted attribution items,
  and their served surface;
- AgentContext IDs remain visibility/correlation data and cannot authorize
  feedback or prove actual use;
- context-only, unknown, mixed-surface, rehydrate-only, and unsupported
  explicit-assertion feedback fail locally;
- non-neutral inspect/do-not-use feedback requires a verified formal host-use
  receipt;
- host templates require explicit trace-derived `used_memory_ids` instead of
  defaulting to all visible use-now IDs;
- external package smoke verifies the same contract against a real Runtime.

Global candidate serving remains off. The production external policy registry
is not registered and the gate remains `calibration_pending`. The immutable
v0.3.8 candidate predates Task 4.1 Step 4. Current post-v0.3.8 mainline now
atomically enqueues formal unused-exposure feedback, reports
`learning_control_status: queued|already_completed`, and processes it through a
leased retry/dead-letter Runtime worker. Historical feedback without the Step 4
queue-provenance marker is not retroactively enqueued. Later promotion phases remain outside
the released candidate.

The immutable `v0.3.7` tag failed cross-package smoke before Docker image build
because the old smoke submitted a continuity-only handoff as learning feedback.
Runtime correctly returned a rejection. No Runtime GitHub Release or
`ghcr.io/ostinatocc/aionis:v0.3.7` image was published, and the tag is not moved.

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
  ghcr.io/ostinatocc/aionis:v0.3.8
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
node --test scripts/ci/release-version-docs.test.mjs
AIONIS_RELEASE_SDK_REPO=/Volumes/ziel/new.aionis/aionis-sdk \
  node scripts/ci/release-artifact-gate.mjs --check --expect-tag v0.3.8
npm run -s runtime:smoke:external-packages
npm run -s runtime:smoke:fresh-install
npm run -s runtime:smoke:published-cli
docker build --platform linux/amd64 \
  --iidfile /tmp/aionis-v0.3.8.iid \
  -t aionis:v0.3.8-smoke .
bash scripts/ci/docker-release-smoke.sh \
  "$(cat /tmp/aionis-v0.3.8.iid)"
```

The gate includes real SQLite/HTTP transaction tests, exact package checkout,
restart integrity, context-only negative feedback, and digest-pinned Docker
smoke. Mocks are not release evidence.

## Publish Order

SDK must resolve before Runtime CI consumes its frozen coordinate. The default
installer remains on v0.3.6:

```bash
# 1. Merge and push the verified SDK commit, then publish its immutable tag.
cd /Volumes/ziel/new.aionis/aionis-sdk
git push origin main
git tag -a v0.3.17 -m "@aionis/sdk v0.3.17"
git push origin v0.3.17

# 2. Publish the exact SDK package after source/tag verification.
npm publish --access public

# 3. Merge the verified Runtime release commit, then tag the merged main commit.
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
git push origin release/v0.3.8
git tag -a v0.3.8 -m "Aionis v0.3.8"
git push origin v0.3.8

# 4. Verify the tag-triggered Runtime artifact.
git ls-remote --exit-code --tags origin refs/tags/v0.3.8
docker pull ghcr.io/ostinatocc/aionis:v0.3.8
```

Do not republish `@aionis/create@0.3.8`; it is already frozen. A future change
of its default Runtime requires a new installer version. This document records
the procedure; it does not authorize package publication by itself.

## Exact-Version Post-Publish Smoke

```bash
AIONIS_FRESH_INSTALL_CREATE_SPEC="@aionis/create@0.3.8" \
AIONIS_FRESH_INSTALL_SDK_SPEC="@aionis/sdk@0.3.17" \
AIONIS_FRESH_INSTALL_MCP_SPEC="@aionis/mcp@0.3.7" \
AIONIS_FRESH_INSTALL_REPO="https://github.com/ostinatocc/Aionis.git" \
AIONIS_FRESH_INSTALL_RUNTIME_REF="v0.3.8" \
npm run -s runtime:smoke:fresh-install

AIONIS_PUBLISHED_CLI_SMOKE_SPEC="aionis@0.3.8" \
npm run -s runtime:smoke:published-cli
```

No package, image, or Public Beta announcement is complete until immutable
refs resolve and the exact-version smoke passes.

## Release History

- [v0.3.8 exact guide-feedback attribution candidate](./releases/v0.3.8.md)
- [v0.3.7 evidence-gated learning candidate](./releases/v0.3.7.md)
- [v0.3.6 release-integrity candidate](./releases/v0.3.6.md)
- [v0.3.5 continuity and evidence candidate](./releases/v0.3.5.md)

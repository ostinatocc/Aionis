# Aionis v0.3.5 Local Runtime Public Beta Candidate Notes

Release status `candidate`.

Runtime `v0.3.5` is the candidate for a single-process, self-hosted Aionis Local
Runtime. It is not GA, a managed multi-tenant service, or a multi-instance HA
release. SQLite is the Lite authority; local ANN state is derived and rebuilt
from committed SQLite vectors after restart.

## Candidate Coordinates

- `aionis@0.3.8` — planned source ref `v0.3.8`
- `@aionis/create@0.3.7` — planned source ref `v0.3.7`
- `@aionis/sdk@0.3.15` — planned source ref `v0.3.15`
- `@aionis/mcp@0.3.7` — planned source ref `v0.3.7`
- `@aionis/aifs@0.3.4` — planned source ref `v0.3.4`
- `@aionis/claude-code@0.3.5` — planned source ref `v0.3.5`
- `@aionis/substrate@0.1.11` — planned source ref `v0.1.11`
- Runtime source tag `v0.3.5`
- Docker image `ghcr.io/ostinatocc/aionis:v0.3.5` (`linux/amd64` only)
- Default installer Runtime ref `v0.3.5`

Each package ref is paired with its exact 40-character source commit in
`release-train.json`; release verification must prove that the tag resolves to
that commit before publication. Substrate remains an external evidence
sidecar. Manifest is intentionally outside this train until it has a verifiable
source repository and immutable ref.

`linux/arm64` is intentionally not published by this candidate. It returns to
the matrix only after the exact arm64 image has its own runtime smoke gate.

## What Changed

### Durable Continuity Writes

`POST /v1/observe` now accepts an optional `operation_id` and returns
`aionis_observe_result_v1`. Memory, execution state/tree, handoff, claims,
durable receipt, and projection intent share the SQLite transaction. An exact
retry returns the stored receipt; reusing the ID for different content returns
HTTP `409`.

Direct `POST /v1/handoff/store` provides the same durable replay contract in
`aionis_handoff_store_result_v1`. Old execution snapshots can no longer replace
newer continuity state while leaving a contradictory operation history.

### Crash-Recoverable Embedding And ANN

Embedding and ANN work is represented by durable leased jobs. Observe reports
`post_commit_projections.semantic_commit: "committed"` plus `scheduled` or
`not_requested` embedding/ANN intent. `scheduled` does not mean the provider or
ANN side effect has already completed.

The worker uses generation and lease-token CAS, retries recoverable failures,
dead-letters poison payloads, and exposes backlog plus worker state under
`/health`. A process killed immediately after commit leaves recoverable work.
At startup, the local in-memory ANN is rebuilt from SQLite ready vectors.

### Runtime-Owned Evidence Gate

`POST /v1/measure` returns `aionis_measure_result_v1` with
`evidence_assessment`, measurement identity, digest, and persistence state.
Manual observations remain `manual_unverified`; caller-supplied
`sufficient_evidence` and `evidence_ids` are exposed only under
`client_claims_ignored` and cannot make learning or skills export-ready.

Export eligibility requires paired durable guide receipts, correct run/task and
consumer binding, ordered Runtime effect observations, a trusted Runtime
verifier receipt, linked positive tool feedback, and complete passing kernel
metrics. SDK `0.3.15` carries these result contracts.

### SQLite Upgrade And Recovery Operations

`npm run -s runtime:data -- ...` exposes schema preflight, v0.3.4 upgrade,
verified `VACUUM INTO` backup, restore-to-new-path, projection inspection, and
repair. Verification reuses the canonical state/tree full-history audit and
rejects continuity corruption or invalid projection payloads. Current schema
metadata is accepted only when all Runtime columns, authority constraints, and
critical indexes match the recorded contract.

### Reproducible Release Artifact

Every package tag is paired with an exact commit and verified from an exact
checkout. Docker publication builds one digest-pinned `linux/amd64` artifact,
smokes that same digest, then promotes it to the version tag. External package
checkouts are excluded from the image context, and `latest` remains disabled
while the train status is `candidate`.

### Bounded Agent Context

The aggressive AgentContext compaction repair routes standard/full-power guide
requests through the canonical bounded renderer while preserving active target,
blocked routes, accepted evidence, rehydrate pointers, and audit boundaries.

## Supported Public Beta Shape

Supported candidate shape:

- one self-hosted Runtime process;
- local/same-host clients, or bounded authenticated Server-mode evaluation;
- SQLite authority with optional local or Zvec candidate indexing;
- SDK, HTTP, MCP, AIFS, Claude Code adapter, CLI, and Create integration.

Not claimed in this candidate:

- managed multi-tenant Server GA;
- multi-instance HA or cross-process in-memory ANN consistency;
- automatic cold-storage retention closure;
- production self-learning without the Runtime-owned verifier/evidence gate.

## Installation

After publication, the recommended installer selects immutable Runtime
`v0.3.5`:

```bash
npx aionis setup
```

Mutable development installation must be explicit:

```bash
npx aionis setup --branch main
```

Docker:

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -v aionis-data:/data \
  ghcr.io/ostinatocc/aionis:v0.3.5
```

Keep unauthenticated Lite bound to loopback. Server-mode evaluation requires
API-key/JWT authentication and a service boundary.

## Verification Gate

The most recent pre-freeze full Runtime run recorded 919 tests: 915 passed,
zero failed, and four optional native Zvec tests skipped. The release still
requires every check below against frozen refs:

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

For local amd64 emulation on Apple Silicon, the same immutable-image smoke may
set `AIONIS_DOCKER_SMOKE_ATTEMPTS=360` and
`AIONIS_DOCKER_SMOKE_HEALTH_TIMEOUT=60s`; native amd64 release CI keeps the
stricter defaults.

The candidate test set includes real SQLite/HTTP operation replay and rollback,
real child-process immediate-post-commit crash recovery, projection lease/CAS
failure cases, evidence bypass rejection, and continuity snapshot conflicts.

## Publish Order

Do not create an installer window that points to missing artifacts:

```bash
# 1. Freeze, tag, publish, and smoke SDK 0.3.15.
cd /Volumes/ziel/new.aionis/aionis-sdk
git tag -a v0.3.15 -m "@aionis/sdk v0.3.15"
git push origin v0.3.15
npm publish --access public

# 2. Push the verified Runtime source, then create its immutable tag.
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
git push origin main
git tag -a v0.3.5 -m "Aionis v0.3.5"
git push origin v0.3.5
gh release create v0.3.5 \
  --repo ostinatocc/Aionis \
  --title "Aionis v0.3.5 Local Runtime Public Beta" \
  --notes-file docs/releases/v0.3.5.md

# 3. Verify the Runtime tag and linux/amd64 image, then publish Create 0.3.7.
docker pull ghcr.io/ostinatocc/aionis:v0.3.5
git ls-remote --exit-code --tags origin refs/tags/v0.3.5
cd /Volumes/ziel/new.aionis/aionis-create
npm publish --access public
```

The commands are a release runbook, not authorization to create tags in this
candidate-preparation change.

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

No package or image is announced until its immutable ref resolves and the
exact-version smoke passes.

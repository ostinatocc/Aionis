# Aionis v0.3.9 Durable Learning Control Candidate Notes

Release status `candidate`.

Runtime `v0.3.9` turns the formal unused-exposure learning-control path into
durable, restart-safe Runtime work and hardens confirmatory provisioning under
real SQLite writer contention. It preserves the evidence-gated learning
boundary: feedback does not synchronously mutate memory posture, and global
admission-candidate serving remains off.

## Candidate Coordinates

- `aionis@0.3.8` — immutable source ref `v0.3.8`
- `@aionis/create@0.3.8` — immutable source ref `v0.3.8`
- `@aionis/sdk@0.3.17` — frozen immutable source commit recorded in `release-train.json`
- `@aionis/mcp@0.3.7` — immutable source ref `v0.3.7`
- `@aionis/aifs@0.3.4` — immutable source ref `v0.3.4`
- `@aionis/claude-code@0.3.5` — immutable source ref `v0.3.5`
- `@aionis/substrate@0.1.11` — immutable source ref `v0.1.11`
- Runtime source tag `v0.3.9`
- Docker image `ghcr.io/ostinatocc/aionis:v0.3.9` (`linux/amd64` only)
- Default installer Runtime ref `v0.3.6`

The Runtime root package is private release metadata, not an npm publication.
All external package versions remain frozen. Release CI verifies the exact
compatibility source refs recorded in `release-train.json`; this Runtime-only
patch does not republish or re-attest the historical npm registry provenance of
those unchanged packages. Candidate status does not move Docker `latest`.

## Durable Learning-Control Work

Formal guide-attributed feedback now writes its feedback facts and one
deterministic unused-exposure job in the same SQLite transaction. The product
response reports only `learning_control_status: queued|already_completed`; it
does not claim that the memory posture changed during the HTTP request.

The Runtime worker:

- claims jobs with lease-owner and lease-token fencing;
- reclaims expired work after restart and prevents stale workers from
  completing a newer lease;
- recomputes repeated-unused evidence and positive attribution from SQLite
  truth before applying any posture change;
- commits the inspect-before-use change, canonical audit commit, protected
  operation receipt, and job completion atomically;
- retries recoverable failures with a bounded deterministic schedule and at
  most eight execution attempts;
- retains exhausted jobs as dead letters and atomically safety-pauses enrolled
  candidates before terminalization;
- exposes worker and backlog state through health/readiness surfaces and waits
  for an in-flight drain during Runtime shutdown.

Historical feedback without the v0.3.9 queue-provenance marker remains valid
and readable but is not retroactively enqueued.

## Confirmatory SQLite Contention Hardening

Confirmatory experiment provisioning now has a bounded retry policy scoped
only to `BEGIN IMMEDIATE` acquisition. A `SQLITE_BUSY` begin failure may retry
within a fixed six-attempt budget; transaction-body, commit, and rollback
failures remain single-attempt and fail closed.

The contender stays inside the same per-connection critical section. After the
winning writer commits, the locked operation-receipt check returns the stored
byte-identical result before either the 32-byte seed or 48-byte assignment
entropy source is invoked.

## Safety And Compatibility

- v0.3.8 SQLite data upgrades forward on the existing v4 authority schema; no
  DDL migration is introduced. After v0.3.9 writes a formal feedback event with
  queue provenance, downgrading that database to v0.3.8 is unsupported.
- The governed HTTP surface remains 21 routes and the environment schema
  remains 177 fields.
- No external package coordinate changes in this Runtime-only patch.
- Global admission-candidate serving remains disabled by default.
- Production external policy registration and later promotion phases remain
  outside this candidate.
- The supported deployment remains one self-hosted Runtime process. Managed
  multi-tenant GA and multi-instance HA are not claimed.

## Verification Gate

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

The tag-triggered release workflow additionally checks out every external package at the
exact ref in `release-train.json`, verifies its recorded commit, packs the SDK,
MCP, and Create repositories into real tarballs, and runs the cross-package
and fresh-install smokes against those artifacts and Runtime `v0.3.9`.
An embedding-available release run is additional evidence: inject the provider
credential only into the Runtime process, keep the same exact package specs,
and require `dashscope:text-embedding-v4` with 1536-dimensional query evidence.
Never place the credential in this repository, release notes, or child package
processes.

## Publish Order

This is a Runtime source and Docker release. It does not publish an npm Runtime
package or republish any frozen external package.

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

# 2. Wait for the tag-triggered Docker workflow and verify the artifact.
git ls-remote --exit-code --tags origin refs/tags/v0.3.9
docker pull --platform linux/amd64 ghcr.io/ostinatocc/aionis:v0.3.9

# 3. Create the GitHub release only after the immutable image verifies.
gh release create v0.3.9 \
  --repo ostinatocc/Aionis \
  --title "Aionis v0.3.9 Durable Learning Control Candidate" \
  --notes-file docs/releases/v0.3.9.md
```

Do not republish `@aionis/create@0.3.8`; it is already frozen and its default
Runtime remains `v0.3.6`. Do not republish the CLI, SDK, MCP, AIFS, Claude Code,
or Substrate coordinates for this Runtime-only patch.

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

No image or Public Beta announcement is complete until the immutable Runtime
tag resolves, the tagged Docker workflow passes, and the exact-version smoke
succeeds.

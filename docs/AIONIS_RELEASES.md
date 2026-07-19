# Aionis Releases

Status: v0.3.10 Local Runtime Public Beta candidate.

This train targets one self-hosted Runtime process with SQLite authority. It is
not GA, a managed multi-tenant service, or a multi-instance HA release. The
v0.3.10 tag is pushed only after the pre-tag gates pass. That push triggers the
exact-tag workflow. A successful workflow publishes the candidate image; an
independent digest-pinned smoke then approves that image before the GitHub
Release is created.

## Current Candidate Coordinates

| Artifact | Current channel | Immutable source ref | Purpose |
|---|---:|---:|---|
| GitHub Runtime source | `v0.3.10` candidate tag | `v0.3.10` | Runtime source, product APIs, docs, Docker build, and validation loops. |
| Docker image | `ghcr.io/ostinatocc/aionis:v0.3.10` candidate | Runtime `v0.3.10` | Verified `linux/amd64` image after the immutable tag workflow succeeds. |
| Default installer Runtime ref | `v0.3.6` | `v0.3.6` | Last immutable Runtime selected by the frozen installer. |
| `aionis` | `0.3.8` npm candidate | `v0.3.8` | Top-level setup and operator CLI. |
| `@aionis/create` | `0.3.8` frozen | `v0.3.8` | One-command installer; its default remains Runtime v0.3.6. |
| `@aionis/sdk` | `0.3.19` frozen | `v0.3.19` | Protected tool-feedback and measure operation identity, provenance, and exact-retry contracts. |
| `@aionis/manifest` | `0.1.1` frozen | `v0.1.1` | Manifest compiler/runtime and real product resume integration. |
| `@aionis/mcp` | `0.3.7` frozen | `v0.3.7` | MCP stdio bridge for compatible clients. |
| `@aionis/aifs` | `0.3.4` frozen | `v0.3.4` | Governed file surface for file-aware Agents. |
| `@aionis/claude-code` | `0.3.5` frozen | `v0.3.5` | Claude Code lifecycle hooks and plugin metadata. |
| `@aionis/substrate` | `0.1.11` frozen sidecar | `v0.1.11` | External durable evidence mirror, audit, and backup sidecar. |

Every package ref is paired with an exact 40-character commit in
`release-train.json`. Runtime CI resolves SDK and Manifest from that file;
Docker release verification resolves all eight package repositories and fails
closed if any checkout, tag, commit, package name, or version differs.

Candidate notes: [v0.3.10 candidate notes](./releases/v0.3.10.md).

## v0.3.10 Candidate Scope

- Keep v0.3.9 release evidence immutable and assign all later work to v0.3.10.
- Include Task 5.1 atomic tool-feedback prepare/persist/finalize and exact
  operation replay.
- Include Task 6.1 protected measure identity, immutable measurement
  persistence, and Runtime-verified effect-to-episode binding.
- Bind the matching SDK `0.3.19` source and published package.
- Bind Manifest `0.1.1` as a real train member and make its Runtime integration
  non-skippable in configured CI.
- Preserve the v0.3.9 durable queue/worker, restart safety, lease fencing,
  bounded retry, dead-letter, and safety-pause behavior.
- Add protected external-evidence ingestion, attestation, lifecycle recovery,
  and crash-replayable deployment-authority tooling without starting mutation
  authority inside the Runtime daemon. Real SIGKILL replay is covered, while
  the production isolated one-shot worker remains deferred and the current
  authority is not signing-eligible.
- Adopt v4/v5 databases into schema v6 with commit digest v2, monotonic
  revisions, scope-head CAS, and sealed adoption manifests/bindings.
- Ratchet Runtime source to 171,316 lines and its daemon entry closure to
  140,346 lines while preserving the governed `/v1` 21-route matrix, 177
  environment fields, and zero import cycles.

Task 6.1 measurement episode binding is included. The formal gate remains
`calibration_pending`, production external execution remains unregistered, and
the shipped global admission-candidate policy defaults to off. Explicit
selected-profile operation remains an operator-controlled evidence posture.
This is evidence-gated learning infrastructure, not a mature
autonomous-learning claim.

Existing complete v4/v5 authority databases upgrade transactionally to v6.
Back up before upgrading. A database adopted by v6 must not be downgraded to an
older Runtime; rollback requires restoring the pre-upgrade backup to a separate
path.

## Published Docker Quickstart

After the tag-triggered workflow has verified and promoted the immutable
digest, run the candidate with:

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -v aionis-data:/data \
  ghcr.io/ostinatocc/aionis:v0.3.10
```

Do not treat that coordinate as published before the tag workflow is green.
Candidate status leaves Docker `latest` unchanged.

## Candidate Gate

```bash
npm run -s typecheck
npm run -s lite:test
npm run -s lite:smoke
npm run -s sdk:check -- --sdk-repo "${AIONIS_SDK_REPO:?set exact SDK checkout}"
npm run -s complexity:check
AIONIS_MANIFEST_REPO="${AIONIS_MANIFEST_REPO:?set exact Manifest checkout}" \
  npx tsx --test scripts/ci/manifest-product-resume.test.ts
node --test \
  scripts/ci/release-version-docs.test.mjs \
  scripts/ci/release-artifact-gate.test.mjs \
  scripts/ci/release-workflow-contract.test.mjs
node scripts/ci/release-artifact-gate.mjs --check --expect-tag v0.3.10
```

## Candidate Promotion Checklist

Run this only after the reviewed candidate is on remote main and both required
CI and the credential-injected DashScope `text-embedding-v4` available-mode
external-package smoke pass on that exact commit:

```bash
cd "${AIONIS_RUNTIME_REPO:?set Runtime checkout}"
git fetch origin main --tags
git switch main
git pull --ff-only origin main
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test "$(node -p 'require("./package.json").version')" = "0.3.10"

MAIN_COMMIT="$(git rev-parse origin/main)"
git tag -a v0.3.10 "$MAIN_COMMIT" -m "Aionis v0.3.10"
test "$(git rev-parse 'v0.3.10^{}')" = "$MAIN_COMMIT"
git push origin v0.3.10
```

Do not republish `@aionis/create@0.3.8`; it is already frozen. The default
installer remains on Runtime v0.3.6. Do not republish any frozen npm coordinate
for this Runtime-only candidate. No v0.3.10 image or announcement is complete
until exact refs resolve, the tagged Docker workflow passes, and the
digest-pinned smoke succeeds.

## Release History

- [v0.3.9 durable learning-control candidate](./releases/v0.3.9.md)
- [v0.3.8 exact guide-feedback attribution candidate](./releases/v0.3.8.md)
- [v0.3.7 evidence-gated learning candidate](./releases/v0.3.7.md)
- [v0.3.6 release-integrity candidate](./releases/v0.3.6.md)
- [v0.3.5 continuity and evidence candidate](./releases/v0.3.5.md)

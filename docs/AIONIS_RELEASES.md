# Aionis Releases

Status: v0.3.10 development.

The checked-in train is the next Runtime development baseline for one
self-hosted Runtime process. It is not GA, a managed multi-tenant service, or a
multi-instance HA release. The last published Runtime candidate remains
v0.3.9; v0.3.10 has no Runtime tag or Docker artifact while this status remains
`development`.

## Current Development Coordinates

| Artifact | Current channel | Declared source ref | Purpose |
|---|---:|---:|---|
| GitHub Runtime source | `v0.3.10` development target | `v0.3.10` | Planned Runtime source, product APIs, docs, Docker build, and validation loops. |
| Docker image | `ghcr.io/ostinatocc/aionis:v0.3.10` development target | Runtime `v0.3.10` | Planned `linux/amd64` image; not published while the train is development. |
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

Development notes: [v0.3.10 development notes](./releases/v0.3.10.md).

## v0.3.10 Development Scope

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

Task 6.1 measurement episode binding is included. Gate calibration, promotion
authority, and global admission-candidate serving remain later phases; global
serving stays off.

## Published Docker Quickstart

Until v0.3.10 is promoted, tagged, and verified, use the last published
candidate:

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -v aionis-data:/data \
  ghcr.io/ostinatocc/aionis:v0.3.9
```

The v0.3.10 Docker coordinate in the table is a development target, not a
pullable-artifact claim.

## Development Gate

```bash
npm run -s typecheck
npm run -s lite:test
npm run -s lite:smoke
npm run -s sdk:check -- --sdk-repo /Volumes/ziel/new.aionis/aionis-sdk
npm run -s complexity:check
AIONIS_MANIFEST_REPO=/Volumes/ziel/new.aionis/AionisManifest \
  npx tsx --test scripts/ci/manifest-product-resume.test.ts
node --test \
  scripts/ci/release-version-docs.test.mjs \
  scripts/ci/release-artifact-gate.test.mjs \
  scripts/ci/release-workflow-contract.test.mjs
node scripts/ci/release-artifact-gate.mjs --check --expect-tag v0.3.10
```

## Future Candidate Promotion Checklist

This is intentionally inert while the train is `development`. Promote the
metadata to `candidate` only after the complete train passes, then run against
the reviewed remote-main commit:

```bash
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
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
installer remains on Runtime v0.3.6. No v0.3.10 image or announcement is
complete until exact refs resolve, the tagged Docker workflow passes, and the
digest-pinned smoke succeeds.

## Release History

- [v0.3.9 durable learning-control candidate](./releases/v0.3.9.md)
- [v0.3.8 exact guide-feedback attribution candidate](./releases/v0.3.8.md)
- [v0.3.7 evidence-gated learning candidate](./releases/v0.3.7.md)
- [v0.3.6 release-integrity candidate](./releases/v0.3.6.md)
- [v0.3.5 continuity and evidence candidate](./releases/v0.3.5.md)

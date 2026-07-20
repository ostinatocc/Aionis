# Aionis Releases

Status: v0.3.11 Local Runtime Public Beta development.

v0.3.11 is the patch train for the Docker PID 1 and cross-process recovery
boundary. It has no tag, image, or GitHub Release yet. v0.3.10 remains the
latest immutable release, but its default container command does not deliver
Docker SIGTERM directly to Runtime, so it is not the durable-container target.
The v0.3.10 tag and digest remain immutable.

The supported release posture is one self-hosted Runtime process with SQLite
authority on `linux/amd64`. It is not GA, a managed multi-tenant service, or a
multi-instance HA release.

## Current Development Coordinates

| Artifact | Current channel | Immutable source ref | Purpose |
|---|---:|---:|---|
| GitHub Runtime source | `v0.3.11` development target | `v0.3.11` | Future immutable Runtime source after all pre-tag gates pass. |
| Docker image | `ghcr.io/ostinatocc/aionis:v0.3.11` reserved | Runtime `v0.3.11` | Future verified `linux/amd64` image; not published in development status. |
| Default installer Runtime ref | `v0.3.6` frozen | `v0.3.6` | Immutable Runtime selected by the frozen installer. |
| `aionis` | `0.3.8` frozen | `v0.3.8` | Top-level setup and operator CLI. |
| `@aionis/create` | `0.3.8` frozen | `v0.3.8` | One-command installer; its default remains Runtime v0.3.6. |
| `@aionis/sdk` | `0.3.19` frozen | `v0.3.19` | Protected feedback, measure identity, provenance, and exact-retry contracts. |
| `@aionis/manifest` | `0.1.1` frozen | `v0.1.1` | Manifest compiler/runtime and product resume integration. |
| `@aionis/mcp` | `0.3.7` frozen | `v0.3.7` | MCP stdio bridge for compatible clients. |
| `@aionis/aifs` | `0.3.4` frozen | `v0.3.4` | Governed file surface for file-aware Agents. |
| `@aionis/claude-code` | `0.3.5` frozen | `v0.3.5` | Claude Code lifecycle hooks and plugin metadata. |
| `@aionis/substrate` | `0.1.11` frozen sidecar | `v0.1.11` | External durable evidence mirror, audit, and backup sidecar. |

Every package ref is paired with an exact commit in `release-train.json`.
Runtime CI resolves SDK and Manifest from that authority; Docker release
verification resolves all eight external repositories and fails closed on any
checkout, tag, commit, package name, or version mismatch.

Development notes: [v0.3.11 development notes](./releases/v0.3.11.md).

## v0.3.11 Development Scope

- Enter `scripts/start-lite.sh` directly from Docker. Its final `exec` makes
  Runtime Node PID 1 without creating a second startup contract.
- Prove real SIGTERM drain and exit 0 against the exact built digest.
- Prove a committed memory and exact operation receipt survive replacement by
  a fresh container using only the named `/data` volume.
- Reject conflicting reuse of an operation id and preserve the original
  receipt after the conflict.
- Prove the same recovery after SIGKILL, then check worker health, SQLite mode
  0600, and offline database integrity.
- Run basic smoke and recovery smoke before promoting the verified digest to
  any release tag.

The route matrix, schema v6, learning posture, complexity ratchet, external npm
packages, and installer ref do not change in this patch. Global
admission-candidate serving remains off.

## Development Image

The future coordinate is:

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -v aionis-data:/data \
  ghcr.io/ostinatocc/aionis:v0.3.11
```

Do not pull or advertise that coordinate while the train is `development`.
The tag-triggered workflow must first build one immutable digest, pass both
exact-digest smokes, and promote that digest.

## Required Gate

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
  scripts/ci/release-workflow-contract.test.mjs \
  scripts/ci/docker-listen-contract.test.mjs \
  scripts/ci/lite-startup-contract.test.mjs
node scripts/ci/release-artifact-gate.mjs --check --expect-tag v0.3.11
```

The exact remote-main commit must also pass the protected DashScope
`qwen3.7-text-embedding` external-package smoke. Credentials are injected by
the environment and never stored in source or release artifacts.

## Promotion Checklist

Run this only after review changes the train from `development` to `candidate`
and all required evidence passes on the exact remote-main commit:

```bash
set -euo pipefail
cd "${AIONIS_RUNTIME_REPO:?set Runtime checkout}"
git fetch origin main --tags
git switch main
git pull --ff-only origin main
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test "$(node -p 'require("./release-train.json").status')" = "candidate"
test "$(node -p 'require("./package.json").version')" = "0.3.11"
test -z "$(git tag --list v0.3.11)"
test -z "$(git ls-remote --tags origin refs/tags/v0.3.11 'refs/tags/v0.3.11^{}')"

MAIN_COMMIT="$(git rev-parse origin/main)"
git tag -a v0.3.11 "$MAIN_COMMIT" -m "Aionis v0.3.11"
test "$(git rev-parse 'v0.3.11^{}')" = "$MAIN_COMMIT"
git push origin v0.3.11

git ls-remote --exit-code --tags origin refs/tags/v0.3.11
RUN_ID="$(gh run list \
  --repo ostinatocc/Aionis \
  --workflow docker.yml \
  --branch v0.3.11 \
  --commit "$MAIN_COMMIT" \
  --event push \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"
test -n "$RUN_ID"
gh run watch "$RUN_ID" --repo ostinatocc/Aionis --exit-status

IMAGE="ghcr.io/ostinatocc/aionis:v0.3.11"
DIGEST="$(docker buildx imagetools inspect "$IMAGE" | awk '$1 == "Digest:" { print $2; exit }')"
test -n "$DIGEST"
docker pull --platform linux/amd64 "$IMAGE"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$IMAGE")" = "$MAIN_COMMIT"
bash scripts/ci/docker-release-smoke.sh "ghcr.io/ostinatocc/aionis@${DIGEST}"
bash scripts/ci/docker-recovery-smoke.sh "ghcr.io/ostinatocc/aionis@${DIGEST}"

gh release create v0.3.11 \
  --repo ostinatocc/Aionis \
  --verify-tag \
  --prerelease \
  --latest=false \
  --title "Aionis v0.3.11 Docker Lifecycle Recovery Candidate" \
  --notes-file docs/releases/v0.3.11.md
```

The tag alone is not a release. The workflow, digest checks, both smoke gates,
and verified GitHub prerelease above are all required.

Do not republish `@aionis/create@0.3.8`; it is already frozen and continues to
select Runtime v0.3.6. Do not republish any other frozen npm coordinate for
this Runtime-only patch.

## Release History

- [v0.3.10 evidence authority and Runtime convergence candidate](./releases/v0.3.10.md)
- [v0.3.9 durable learning-control candidate](./releases/v0.3.9.md)
- [v0.3.8 exact guide-feedback attribution candidate](./releases/v0.3.8.md)
- [v0.3.7 evidence-gated learning candidate](./releases/v0.3.7.md)
- [v0.3.6 release-integrity candidate](./releases/v0.3.6.md)
- [v0.3.5 continuity and evidence candidate](./releases/v0.3.5.md)

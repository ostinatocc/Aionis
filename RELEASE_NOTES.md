# Aionis v0.3.11 Docker Lifecycle Recovery Candidate Notes

Release status `candidate`.

Runtime `v0.3.11` is a published Runtime-only Local Runtime Public Beta
prerelease candidate.
It fixes the Docker process boundary discovered after v0.3.10: the v0.3.10
image starts through npm, so Docker SIGTERM can terminate the parent process
without executing Runtime's awaited shutdown path. v0.3.11 launches the
existing signal-aware startup script directly, whose final `exec` makes Node
PID 1.

The annotated tag, exact `linux/amd64` image digest, protected-provider run,
read-only Docker recovery run, and non-latest GitHub prerelease are bound in
`docs/releases/v0.3.11-publication-evidence.json`. The source Docker run is
truthfully recorded as failed at its final promotion/readback step after all
exact-digest gates had passed; the later successful recovery run performed no
registry writes and revalidated that same digest. Runtime v0.3.10 and its
published digest stay immutable. The supported target remains one self-hosted
Runtime process with SQLite authority; this is not a managed service or
multi-instance HA release.

## Candidate Coordinates

- `aionis@0.3.8` — immutable source ref `v0.3.8`
- `@aionis/create@0.3.8` — immutable source ref `v0.3.8`
- `@aionis/sdk@0.3.19` — immutable source ref `v0.3.19`
- `@aionis/manifest@0.1.1` — immutable source ref `v0.1.1`
- `@aionis/mcp@0.3.7` — immutable source ref `v0.3.7`
- `@aionis/aifs@0.3.4` — immutable source ref `v0.3.4`
- `@aionis/claude-code@0.3.5` — immutable source ref `v0.3.5`
- `@aionis/substrate@0.1.11` — immutable source ref `v0.1.11`
- Runtime source tag `v0.3.11`
- Docker image `ghcr.io/ostinatocc/aionis:v0.3.11` (`linux/amd64` only)
- Default installer Runtime ref `v0.3.6`

All eight external package coordinates remain frozen. This patch does not
publish npm packages or change the installer default.

## Patch Scope

- Replace the image's npm PID 1 command with the existing startup script. The
  script retains its environment and Node compatibility checks, then uses
  `exec node --import tsx src/index.ts`.
- Require the exact image digest to survive a real Docker SIGTERM with Runtime
  drain logs and exit code 0.
- Require a fresh container on the same named volume to resolve the committed
  memory and return the exact durable operation receipt.
- Reject reuse of an operation id with a changed payload without corrupting
  the original replay.
- Require a second fresh-container recovery after SIGKILL, including both
  memories, exact replay, healthy workers, protected SQLite permissions, and
  offline database verification.
- Run this recovery gate after the basic exact-digest smoke and before any
  Docker tag promotion.

Runtime routes, schema v6, learning posture, package contracts, and external
package commits are unchanged. Global admission-candidate serving remains off.

## Published Evidence

The implementation has passed a local `linux/amd64` image exercise covering
Node PID 1, graceful drain/exit 0, SIGKILL exit 137 with `OOMKilled=false`, two
fresh-container recoveries, exact replay, conflict rejection, memory resolve,
worker health, mode-0600 SQLite files, and offline integrity verification.
The published candidate additionally passed the same-SHA protected DashScope
gate and the exact-digest release and process-death recovery gates. The
machine-checkable receipt is
[`docs/releases/v0.3.11-publication-evidence.json`](docs/releases/v0.3.11-publication-evidence.json).

The commands below are retained as the historical release procedure and as the
contract for a future release train; they are not instructions to recreate or
move the existing v0.3.11 tag.

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

Before promotion, store a rotated DashScope credential only as the
`DASHSCOPE_API_KEY` secret in the main-only `exact-main-embedding` GitHub
environment. The manual, read-only
`.github/workflows/exact-main-embedding-smoke.yml` gate refuses any requested
SHA that is not simultaneously the workflow dispatch commit and current
`origin/main`; it also requires candidate or stable status and a unique
evidence ID with a random nonce. A stable commit must produce its own same-SHA
evidence rather than reusing a candidate run. The gate packs the frozen SDK,
MCP, and installer
commits, then runs the available-mode external-package smoke with
`qwen3.7-text-embedding`, expected model
`dashscope:qwen3.7-text-embedding`, and 1,536 dimensions. Never store the
credential in this repository, logs, release notes, artifacts, or a child
package checkout. A successful run also proves the immutable Runtime tag is
still absent after the provider smoke completes.

## Historical Promotion Checklist

For a new, not-yet-tagged release, do not create the tag until the exact
candidate commit has passed all convergence checks, exact-main CI, and
protected external embedding evidence.

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
EMBED_EVIDENCE_NONCE="$(node -p 'require("node:crypto").randomBytes(8).toString("hex")')"
EMBED_EVIDENCE_ID="candidate-${MAIN_COMMIT}-$(date -u +%Y%m%dT%H%M%SZ)-${EMBED_EVIDENCE_NONCE}"
EMBED_RUN_TITLE="Exact Main Embedding Smoke ${MAIN_COMMIT} ${EMBED_EVIDENCE_ID}"
gh workflow run exact-main-embedding-smoke.yml \
  --repo ostinatocc/Aionis \
  --ref main \
  -f expected_sha="${MAIN_COMMIT}" \
  -f evidence_id="${EMBED_EVIDENCE_ID}"
EMBED_RUN_ID=""
for _ in $(seq 1 30); do
  EMBED_RUN_MATCHES="$(gh run list \
    --repo ostinatocc/Aionis \
    --workflow exact-main-embedding-smoke.yml \
    --commit "${MAIN_COMMIT}" \
    --event workflow_dispatch \
    --limit 20 \
    --json databaseId,displayTitle \
    --jq ".[] | select(.displayTitle == \"${EMBED_RUN_TITLE}\") | .databaseId")"
  EMBED_RUN_COUNT="$(printf '%s\n' "${EMBED_RUN_MATCHES}" | \
    awk 'NF { count += 1 } END { print count + 0 }')"
  if [[ "${EMBED_RUN_COUNT}" -gt 1 ]]; then
    echo "refusing ambiguous embedding evidence title: ${EMBED_RUN_TITLE}" >&2
    exit 1
  fi
  if [[ "${EMBED_RUN_COUNT}" -eq 1 ]]; then
    EMBED_RUN_ID="${EMBED_RUN_MATCHES}"
    break
  fi
  sleep 2
done
test -n "${EMBED_RUN_ID}"
gh run watch "${EMBED_RUN_ID}" --repo ostinatocc/Aionis --exit-status
test "$(gh run view "${EMBED_RUN_ID}" --repo ostinatocc/Aionis --json workflowName --jq .workflowName)" = "Exact Main Embedding Smoke"
test "$(gh run view "${EMBED_RUN_ID}" --repo ostinatocc/Aionis --json displayTitle --jq .displayTitle)" = "${EMBED_RUN_TITLE}"
test "$(gh run view "${EMBED_RUN_ID}" --repo ostinatocc/Aionis --json event --jq .event)" = "workflow_dispatch"
test "$(gh run view "${EMBED_RUN_ID}" --repo ostinatocc/Aionis --json headBranch --jq .headBranch)" = "main"
test "$(gh run view "${EMBED_RUN_ID}" --repo ostinatocc/Aionis --json headSha --jq .headSha)" = "${MAIN_COMMIT}"
test "$(gh run view "${EMBED_RUN_ID}" --repo ostinatocc/Aionis --json conclusion --jq .conclusion)" = "success"

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

Do not republish `@aionis/create@0.3.8`; its default Runtime remains `v0.3.6`.
Do not republish any other frozen package coordinate. Do not move, delete, or
recreate the immutable v0.3.10 tag or image digest.

The normal release path requires a green tag workflow. If a post-promotion
registry readback alone marks that run failed, publication is complete only
when a checked evidence receipt binds the exact source run and attempt, commit,
digest, already-completed exact-digest gates, a successful read-only recovery
run with `registry_writes` equal to `none`, and the subsequent verified GitHub
prerelease. That bounded recovery rule is the one documented for v0.3.11 in
`docs/releases/v0.3.11-publication-evidence.json`; it does not authorize a
rerun that rebuilds or overwrites the image.

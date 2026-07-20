# Aionis v0.3.12 Replay Upgrade Hardening Candidate Notes

Release status `candidate`.

Runtime `v0.3.12` is a published Runtime-only Local Runtime Public Beta
prerelease candidate. A real v0.3.6-to-v0.3.11 exercise found that the old
image leaves `aionis-lite-replay.sqlite` at mode `0644`, while v0.3.11 correctly
fails closed on that legacy artifact. The v0.3.11 tag and image remain
immutable; this train adds an explicit offline replay verification and
hardening step instead of weakening startup security or silently chmodding a
live database.

The annotated tag, exact `linux/amd64` image digest, exact-main CI, protected
provider run, recovery and cross-version gates, and non-latest GitHub
prerelease are bound in
`docs/releases/v0.3.12-publication-evidence.json`. Runtime v0.3.11 and its
publication receipt remain immutable historical evidence. The supported target
remains one self-hosted Runtime process with SQLite authority; this is not a
managed service or multi-instance HA release.

## Candidate Coordinates

- `aionis@0.3.8` — immutable source ref `v0.3.8`
- `@aionis/create@0.3.8` — immutable source ref `v0.3.8`
- `@aionis/sdk@0.3.19` — immutable source ref `v0.3.19`
- `@aionis/manifest@0.1.1` — immutable source ref `v0.1.1`
- `@aionis/mcp@0.3.7` — immutable source ref `v0.3.7`
- `@aionis/aifs@0.3.4` — immutable source ref `v0.3.4`
- `@aionis/claude-code@0.3.5` — immutable source ref `v0.3.5`
- `@aionis/substrate@0.1.11` — immutable source ref `v0.1.11`
- Runtime source tag `v0.3.12` — annotated at the receipt-bound commit
- Docker image `ghcr.io/ostinatocc/aionis:v0.3.12` — published `linux/amd64`
  digest recorded in the receipt
- Default installer Runtime ref `v0.3.6`

All eight external package coordinates remain frozen. This patch does not
publish npm packages or change the installer default.

## Patch Scope

- Add `upgrade --replay-db PATH` while retaining the write-only form for
  deployments where replay persistence is absent.
- Before write-schema mutation, restrict dedicated directories to owner-only
  access, bind the write/replay main and sidecar files by device and inode, and
  require the two complete artifact namespaces to be mutually exclusive.
- Before either database opens at Runtime startup, reject overlap between the
  complete reserved write/replay path sets after nearest-existing-ancestor
  realpath canonicalization plus NFC/case-insensitive comparison, and reject
  any existing main or sidecar artifact whose hard-link count is not exactly one.
- Validate replay SQLite read-only with strict `quick_check`, foreign-key,
  exact table-definition, and exact-index gates. The only permitted schema is
  the canonical table, its two explicit indexes, and its sole primary-key
  autoindex; every other object fails closed.
- Reject pathname, symlink, hard-link, identity, or sidecar drift; the offline
  hardener receives the verified identities and checks them before `fchmod`.
- Reject an uninitialized write database instead of silently initializing an
  upgrade command pointed at the wrong file.
- Preserve business-row counts while allowing only the exact schema-v6
  authority-adoption commit delta.
- Require real v0.3.6 upgrade, restart, recovery, and untouched-volume rollback
  evidence before candidate image promotion.

Runtime routes, schema v6, learning posture, package contracts, and external
package commits are unchanged. Global admission-candidate serving remains off.

## Published Evidence

The candidate implementation has passed typecheck, 104/104 static checks, the
complete 46/46 data-operations suite, the focused 3/3 startup security suite,
the legacy-0644 and inode-binding security regressions, and a downward
complexity ratchet. The published candidate additionally passed 13/13
exact-main CI jobs, the protected DashScope embedding gate, the tag-triggered
native `linux/amd64` build, exact-digest smoke and process-death recovery, and
the real v0.3.6 upgrade/restart/replacement-recovery/untouched-volume rollback
gate. The machine-checkable receipt is
[`docs/releases/v0.3.12-publication-evidence.json`](docs/releases/v0.3.12-publication-evidence.json),
and the published digest is
`ghcr.io/ostinatocc/aionis@sha256:f40c5a1f14af23674fab5e59414bbe4187a0d56dcf8a2798afd02c1563c4a5d6`.

The commands below are retained as the historical v0.3.12 release procedure
and as the contract for a future release train. They are not instructions to
recreate or move the existing v0.3.12 tag.

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
node scripts/ci/release-artifact-gate.mjs --check --expect-tag v0.3.12
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

## Historical Publication Checklist

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
test "$(node -p 'require("./package.json").version')" = "0.3.12"
test -z "$(git tag --list v0.3.12)"
test -z "$(git ls-remote --tags origin refs/tags/v0.3.12 'refs/tags/v0.3.12^{}')"

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

git tag -a v0.3.12 "$MAIN_COMMIT" -m "Aionis v0.3.12"
test "$(git rev-parse 'v0.3.12^{}')" = "$MAIN_COMMIT"
git push origin v0.3.12

git ls-remote --exit-code --tags origin refs/tags/v0.3.12
RUN_ID="$(gh run list \
  --repo ostinatocc/Aionis \
  --workflow docker.yml \
  --branch v0.3.12 \
  --commit "$MAIN_COMMIT" \
  --event push \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"
test -n "$RUN_ID"
gh run watch "$RUN_ID" --repo ostinatocc/Aionis --exit-status

IMAGE="ghcr.io/ostinatocc/aionis:v0.3.12"
DIGEST="$(docker buildx imagetools inspect "$IMAGE" | awk '$1 == "Digest:" { print $2; exit }')"
test -n "$DIGEST"
docker pull --platform linux/amd64 "$IMAGE"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$IMAGE")" = "$MAIN_COMMIT"
bash scripts/ci/docker-recovery-smoke.sh "ghcr.io/ostinatocc/aionis@${DIGEST}"
bash scripts/ci/docker-recovery-smoke.sh --cross-version \
  "ghcr.io/ostinatocc/aionis@${DIGEST}" "$MAIN_COMMIT" "v0.3.12"

gh release create v0.3.12 \
  --repo ostinatocc/Aionis \
  --verify-tag \
  --target "$MAIN_COMMIT" \
  --prerelease \
  --latest=false \
  --title "Aionis v0.3.12 Replay Upgrade Hardening Candidate" \
  --notes-file docs/releases/v0.3.12.md
```

Do not republish `@aionis/create@0.3.8`; its default Runtime remains `v0.3.6`.
Do not republish any other frozen package coordinate. Do not move, delete, or
recreate the immutable v0.3.10, v0.3.11, or v0.3.12 tags or image digests.

The normal release path requires a green tag workflow. If a post-promotion
registry readback alone marks that run failed, publication is complete only
when a checked evidence receipt binds the exact source run and attempt, commit,
digest, already-completed exact-digest and cross-version gates, a successful
read-only recovery run with `registry_writes` equal to `none`, and the
subsequent verified GitHub prerelease. The prior bounded recovery case is
preserved exactly in `docs/releases/v0.3.11-publication-evidence.json`; it does
not authorize a future rerun that rebuilds or overwrites an image.

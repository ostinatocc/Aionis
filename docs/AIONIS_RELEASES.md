# Aionis Releases

Status: v0.3.12 Local Runtime Public Beta candidate.

v0.3.12 is the Runtime-only candidate for legacy replay database upgrade
hardening. A real v0.3.6-to-v0.3.11 exercise found that the
old image leaves `aionis-lite-replay.sqlite` at mode `0644`, while v0.3.11
correctly refuses to start with that artifact. This train adds an explicit
offline verification and hardening path; it does not weaken Runtime startup or
silently mutate a live database.

Candidate status alone does not create or validate the v0.3.12 tag, official
image, protected-provider evidence, or publication receipt. Each becomes
release authority only after all exact-commit gates pass. The last published
candidate remains v0.3.11. Its immutable tag, commit, image digest, provider
evidence, and bounded recovery record are fixed in
[`v0.3.11-publication-evidence.json`](./releases/v0.3.11-publication-evidence.json)
at `docs/releases/v0.3.11-publication-evidence.json`.

The supported release posture is one self-hosted Runtime process with SQLite
authority on `linux/amd64`. It is not GA, a managed multi-tenant service, or a
multi-instance HA release.

## Current Candidate Coordinates

| Artifact | Current channel | Immutable source ref | Purpose |
|---|---:|---:|---|
| GitHub Runtime source | `v0.3.12` candidate | `v0.3.12` | Becomes immutable only after all pre-tag gates pass and the tag is created. |
| Docker image | `ghcr.io/ostinatocc/aionis:v0.3.12` candidate coordinate | Runtime `v0.3.12` | Published only after the tag workflow verifies and promotes one `linux/amd64` digest. |
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

Candidate notes: [v0.3.12 replay upgrade hardening](./releases/v0.3.12.md).
The v0.3.11 publication receipt remains historical evidence only; it cannot be
reused as v0.3.12 evidence.

## v0.3.12 Candidate Scope

- Add `upgrade --replay-db PATH` while retaining the write-only form for
  deployments without replay persistence.
- Restrict dedicated directories to owner-only access, then bind write/replay
  main/WAL/SHM/journal files by device and inode before SQLite opens them; the
  complete write and replay artifact namespaces must be mutually exclusive.
- Before either database opens at Runtime startup, reject overlap between the
  complete reserved write/replay path sets after nearest-existing-ancestor
  realpath canonicalization plus NFC/case-insensitive comparison, and reject
  any existing main or sidecar artifact whose hard-link count is not exactly one.
- Validate replay SQLite read-only before write-schema mutation: strict
  `quick_check`, zero foreign-key violations, and exactly four schema objects:
  the canonical table, its two canonical explicit indexes, and its sole
  `sqlite_autoindex_lite_replay_nodes_1` primary-key autoindex with null SQL.
  Every other table, view, trigger, index, or SQLite-created object is rejected.
- Reject pathname, symlink, hard-link, identity, or sidecar drift, and recheck
  the verified identities inside descriptor-safe offline hardening.
- Reject an uninitialized write database rather than blessing a wrong path.
- Preserve business-row counts while allowing only the exact schema-v6
  authority-adoption commit delta.
- Require real v0.3.6 upgrade, restart, recovery, and untouched-volume rollback
  evidence before candidate promotion.

The route matrix, schema v6, learning posture, complexity ratchet, external npm
packages, and installer ref do not change in this patch. Global
admission-candidate serving remains off.

## Last Published Candidate Image (v0.3.11)

For an exact deployment, use the verified digest rather than resolving the tag
again:

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -v aionis-data:/data \
  ghcr.io/ostinatocc/aionis@sha256:140603566945fccebbdb019c713e51578d5e14ca369ce88989b34768acbfba94
```

The v0.3.11 source tag run passed build, immutable-subject verification, basic
smoke, and cross-process recovery, then was marked failed by the final
promotion readback. A subsequent successful read-only recovery run performed
no registry writes and re-ran both exact-digest smokes against the promoted
digest. Both runs and their relationship are preserved in
`docs/releases/v0.3.11-publication-evidence.json`; the source run is not
misreported as green. That receipt does not claim that legacy v0.3.6 replay
artifacts can be upgraded by v0.3.11.

## Candidate Release Gate

The commands below define the gate contract for this candidate. They do not
claim that v0.3.12 is already tagged or published.

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

The exact remote-main candidate commit must also pass
`.github/workflows/exact-main-embedding-smoke.yml` through the main-only
`exact-main-embedding` environment. That protected gate uses DashScope
`qwen3.7-text-embedding`; credentials are injected by the environment and never
stored in source or release artifacts. Its successful workflow name, unique
evidence ID, `workflow_dispatch` event, head SHA, and conclusion must all be
verified against the same `MAIN_COMMIT` before creating the tag. Candidate and
stable commits require separate same-SHA evidence; a stable release cannot
reuse evidence from its candidate predecessor. Each evidence ID carries a
random nonce and the runbook rejects ambiguous title matches. The provider
workflow checks that the immutable Runtime tag is still absent after the smoke
completes.

## Candidate Publication Checklist

For a new, not-yet-tagged candidate, run this after the reviewed commit is the
exact `origin/main` SHA and its full Runtime CI is green. This procedure obtains
the protected external evidence; create the tag only after that evidence
succeeds:

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
bash scripts/ci/docker-release-smoke.sh "ghcr.io/ostinatocc/aionis@${DIGEST}"
bash scripts/ci/docker-recovery-smoke.sh "ghcr.io/ostinatocc/aionis@${DIGEST}"
bash scripts/ci/docker-recovery-smoke.sh --cross-version \
  "ghcr.io/ostinatocc/aionis@${DIGEST}" "$MAIN_COMMIT" "v0.3.12"

gh release create v0.3.12 \
  --repo ostinatocc/Aionis \
  --verify-tag \
  --prerelease \
  --latest=false \
  --title "Aionis v0.3.12 Replay Upgrade Hardening Candidate" \
  --notes-file docs/releases/v0.3.12.md
```

The tag alone is not a release. The tag workflow, digest checks, fresh-volume
smokes, cross-version upgrade/recovery/rollback gate, and verified GitHub
prerelease must all succeed. A bounded recovery exception may be documented
only after digest promotion and only with a new checked receipt binding the
exact source run/attempt, commit, promoted digest, completed gates, read-only
recovery run, and registry-write posture. The historical v0.3.11 receipt does
not authorize or pre-populate that future evidence.

Do not republish `@aionis/create@0.3.8`; it is already frozen and continues to
select Runtime v0.3.6. Do not republish any other frozen npm coordinate for
this Runtime-only patch.

## Release History

- [v0.3.11 Docker lifecycle recovery candidate](./releases/v0.3.11.md)
- [v0.3.10 evidence authority and Runtime convergence candidate](./releases/v0.3.10.md)
- [v0.3.9 durable learning-control candidate](./releases/v0.3.9.md)
- [v0.3.8 exact guide-feedback attribution candidate](./releases/v0.3.8.md)
- [v0.3.7 evidence-gated learning candidate](./releases/v0.3.7.md)
- [v0.3.6 release-integrity candidate](./releases/v0.3.6.md)
- [v0.3.5 continuity and evidence candidate](./releases/v0.3.5.md)

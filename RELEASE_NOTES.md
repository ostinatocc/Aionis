# Aionis v0.3.10 Evidence Authority and Runtime Convergence Candidate Notes

Release status `candidate`.

Runtime `v0.3.10` is a Runtime-only Local Runtime Public Beta candidate. It
combines atomic tool-feedback and measurement authority with protected external
evidence, crash-replayable deployment tooling, database authority adoption, and
a smaller daemon boundary. It remains a single-process SQLite Runtime, not a GA
managed service or a multi-instance HA release.

## Candidate Coordinates

- `aionis@0.3.8` — immutable source ref `v0.3.8`
- `@aionis/create@0.3.8` — immutable source ref `v0.3.8`
- `@aionis/sdk@0.3.19` — immutable source ref `v0.3.19`
- `@aionis/manifest@0.1.1` — immutable source ref `v0.1.1`
- `@aionis/mcp@0.3.7` — immutable source ref `v0.3.7`
- `@aionis/aifs@0.3.4` — immutable source ref `v0.3.4`
- `@aionis/claude-code@0.3.5` — immutable source ref `v0.3.5`
- `@aionis/substrate@0.1.11` — immutable source ref `v0.1.11`
- Runtime source tag `v0.3.10`
- Docker image `ghcr.io/ostinatocc/aionis:v0.3.10` (`linux/amd64` only)
- Default installer Runtime ref `v0.3.6`

The Runtime root package and private learning-authority extension are not npm
artifacts. Every external package coordinate is already frozen and is not
republished by this Runtime release. Candidate status leaves Docker `latest`
unchanged. During candidate preparation the source tag does not exist. It is
pushed only after the pre-tag gates pass, and that push triggers the exact-tag
workflow. A successful workflow publishes the candidate image; an independent
digest-pinned smoke then approves that image before the GitHub Release is
created.

## Candidate Scope

- Tool-selection feedback now performs external preparation outside the SQLite
  transaction, revalidates and persists the complete attribution unit inside
  one transaction, stores an exact operation receipt, and schedules external
  effects only after commit.
- Task 6.1 adds protected measure `operation_id` handling, exact receipt replay,
  immutable measurement persistence, and Runtime-verified effect-to-episode
  binding for sufficient product traces.
- SDK `0.3.19` carries the matching protected tool-feedback and measure
  operation-identity contracts.
- Manifest `0.1.1` is a formal release-train member. Ordinary CI and Docker
  release verification resolve its exact tag and commit, build and verify it,
  and run the real Manifest-to-Runtime resume integration without silently
  skipping the test.
- The durable unused-exposure queue and worker introduced in v0.3.9 remain the
  asynchronous learning-control boundary. Feedback still does not synchronously
  claim a posture change.
- Fixed two-arm evidence, prospective experiment configuration, external run
  claims, evidence ingestion, lifecycle reconstruction, and attestation are
  protected by exact digests and SQLite authority. Mutation writers and
  deployment tools remain outside the daemon startup boundary.
- Deployment-slot authority binds configured roots, leases, filesystem state,
  recovery receipts, and terminal outcomes so interrupted provisioning can
  resume or fail closed without publishing partial authority. This tooling has
  real SIGKILL replay evidence; the production isolated one-shot worker remains
  deferred and the current authority is not signing-eligible.
- Commit digest v2, monotonic revisions, scope heads, CAS adoption, protected
  database/file permissions, and bounded shutdown close the ambiguous-head,
  local disclosure, and process-termination gaps from earlier development
  snapshots.
- Runtime complexity is ratcheted at 339 source files and 171,316 source lines;
  the daemon entry closure is 285 files and 140,346 lines with zero import
  cycles. The governed public surface remains 21 routes and 177 environment
  fields.

Measurement evidence can be bound to the persisted before/after episode pair
without granting promotion authority. The formal gate remains
`calibration_pending`, production external execution is unregistered, global
admission-candidate serving defaults to off, and this candidate does not claim
a mature autonomous-learning loop. Explicit selected-profile operation remains
an operator-controlled evidence posture.

## Data Compatibility

The current authority schema is v6. Existing complete v4 or v5 databases are
upgraded transactionally: v5 binds canonical mutation digests, monotonic
revision/head authority, and legacy anchors; v6 seals the authority-adoption
manifest and bindings. Back up the SQLite database before upgrade. A database
that has been adopted by v6 must not be opened by v0.3.9 or another older
Runtime; rollback means restoring the pre-upgrade backup to a separate path.

## Pre-Tag Evidence And Required Gates

The pre-promotion convergence snapshot `2467af8` passed exact-commit CI run
`29684934464`: all Runtime, core, recovery, authority, Node 22.15, and macOS
shutdown jobs passed. Its exact-SHA fresh install, public Lite smoke, and
published SDK/MCP/Create no-embedding loop also passed. This evidence does not
replace the final candidate/main SHA gates.

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

Before tagging, inject a DashScope credential through a protected environment
and run the external-package smoke with `qwen3.7-text-embedding`, expected model
`dashscope:qwen3.7-text-embedding`, and 1,536 dimensions. It must prove ready write
embeddings, semantic/ANN query provenance, feedback attribution, persisted
measure, and exact replay through SDK and MCP. Never store the credential in
this repository, release notes, or child package environments.

The release workflow must then verify all eight exact package checkouts,
Manifest product resume, packed SDK/MCP/Create artifacts, fresh install, every
core/recovery shard, and the digest-pinned Docker smoke. Mocks are not release
evidence.

## Candidate Promotion Checklist

Merge the reviewed candidate commit, wait for required CI and the available
embedding gate on the exact remote-main commit, and only then create the
immutable tag.

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

# Wait for the tag-triggered Docker workflow.
git ls-remote --exit-code --tags origin refs/tags/v0.3.10
RUN_ID="$(gh run list \
  --repo ostinatocc/Aionis \
  --workflow docker.yml \
  --branch v0.3.10 \
  --commit "$MAIN_COMMIT" \
  --event push \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"
test -n "$RUN_ID"
gh run watch "$RUN_ID" --repo ostinatocc/Aionis --exit-status

# Resolve the promoted tag to a digest, bind it back to main, and smoke the
# digest rather than the mutable-looking tag coordinate.
IMAGE="ghcr.io/ostinatocc/aionis:v0.3.10"
DIGEST="$(docker buildx imagetools inspect "$IMAGE" | awk '$1 == "Digest:" { print $2; exit }')"
test -n "$DIGEST"
docker pull --platform linux/amd64 "$IMAGE"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$IMAGE")" = "$MAIN_COMMIT"
bash scripts/ci/docker-release-smoke.sh "ghcr.io/ostinatocc/aionis@${DIGEST}"

# Create the GitHub release only after the digest-pinned image smoke passes.
gh release create v0.3.10 \
  --repo ostinatocc/Aionis \
  --title "Aionis v0.3.10 Evidence Authority and Runtime Convergence Candidate" \
  --notes-file docs/releases/v0.3.10.md
```

Do not republish `@aionis/create@0.3.8`; its default Runtime remains `v0.3.6`.
Do not republish any other frozen package coordinate as part of Runtime
promotion. Manifest `0.1.1` and SDK `0.3.19` must remain bound to the exact
commits recorded in `release-train.json`.

No v0.3.10 announcement is complete until the immutable tag resolves to the
verified main commit, the tag workflow is green, and the promoted image digest
passes its release smoke.

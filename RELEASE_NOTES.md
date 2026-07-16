# Aionis v0.3.10 Atomic Tool Feedback Development Notes

Release status `development`.

Runtime `v0.3.10` is the next development train. It assigns the post-v0.3.9
atomic tool-feedback work, standalone SDK `0.3.18`, and Manifest `0.1.1` to a
new version boundary instead of rewriting the immutable v0.3.9 release. This
file describes a target train, not an already-published Runtime tag or image.

## Development Coordinates

- `aionis@0.3.8` — immutable source ref `v0.3.8`
- `@aionis/create@0.3.8` — immutable source ref `v0.3.8`
- `@aionis/sdk@0.3.18` — immutable source ref `v0.3.18`
- `@aionis/manifest@0.1.1` — immutable source ref `v0.1.1`
- `@aionis/mcp@0.3.7` — immutable source ref `v0.3.7`
- `@aionis/aifs@0.3.4` — immutable source ref `v0.3.4`
- `@aionis/claude-code@0.3.5` — immutable source ref `v0.3.5`
- `@aionis/substrate@0.1.11` — immutable source ref `v0.1.11`
- Runtime source tag `v0.3.10`
- Docker image `ghcr.io/ostinatocc/aionis:v0.3.10` (`linux/amd64` target)
- Default installer Runtime ref `v0.3.6`

The Runtime root package is private metadata and is not published to npm.
Development status does not authorize creation of `v0.3.10`, publication of
the Docker target, or movement of Docker `latest`.

## Development Scope

- Tool-selection feedback now performs external preparation outside the SQLite
  transaction, revalidates and persists the complete attribution unit inside
  one transaction, stores an exact operation receipt, and schedules external
  effects only after commit.
- SDK `0.3.18` carries the matching protected tool-feedback identity and
  provenance contract.
- Manifest `0.1.1` is a formal release-train member. Ordinary CI and Docker
  release verification resolve its exact tag and commit, build and verify it,
  and run the real Manifest-to-Runtime resume integration without silently
  skipping the test.
- The durable unused-exposure queue and worker introduced in v0.3.9 remain the
  asynchronous learning-control boundary. Feedback still does not synchronously
  claim a posture change.

Task 6.1 measurement-to-episode binding is not part of this baseline. Global
candidate serving remains disabled, and the evidence gate remains
calibration-pending.

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

The release workflow must verify all eight exact package checkouts. Manifest is
verified as a buildable package and through the real product resume loop; SDK,
MCP, and Create continue through packed-tarball cross-package and fresh-install
smokes. Mocks are not release evidence.

## Future Candidate Promotion Checklist

Do not run this section while the train is `development`. After the train is
explicitly promoted to `candidate`, merge the reviewed release commit, wait for
required CI on that exact main commit, and only then create the immutable tag.

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

Do not republish `@aionis/create@0.3.8`; its default Runtime remains `v0.3.6`.
Do not republish any other frozen package coordinate as part of Runtime
promotion. Manifest `0.1.1` and SDK `0.3.18` must remain bound to the exact
commits recorded in `release-train.json`.

# Aionis v0.3.6 Local Runtime Public Beta Candidate Notes

Release status `candidate`.

Runtime `v0.3.6` is a release-integrity maintenance candidate for the
single-process, self-hosted Aionis Local Runtime. It hardens startup and the
release pipeline without changing Aionis memory, continuity, AgentContext,
HTTP, SDK/MCP, or persistence contracts.

## Candidate Coordinates

- `aionis@0.3.8` — immutable source ref `v0.3.8`
- `@aionis/create@0.3.8` — immutable source ref `v0.3.8`
- `@aionis/sdk@0.3.15` — immutable source ref `v0.3.15`
- `@aionis/mcp@0.3.7` — immutable source ref `v0.3.7`
- `@aionis/aifs@0.3.4` — immutable source ref `v0.3.4`
- `@aionis/claude-code@0.3.5` — immutable source ref `v0.3.5`
- `@aionis/substrate@0.1.11` — immutable source ref `v0.1.11`
- Runtime source tag `v0.3.6`
- Docker image `ghcr.io/ostinatocc/aionis:v0.3.6` (`linux/amd64` only)
- Default installer Runtime ref `v0.3.6`

Every package ref is paired with its exact 40-character source commit in
`release-train.json`. The train remains `candidate`, so Docker `latest` is not
moved. Manifest remains outside this train until it has a verifiable source
repository and immutable ref.

## Highlights

### Clean Runtime Shutdown In Release Jobs

Lite starts the Runtime as the direct Node process. Smoke and fresh-install
checks use bounded `SIGTERM` then `SIGKILL` cleanup, while Docker release jobs
also own and clean the Linux process group. GitHub Actions no longer has to
terminate a leaked Runtime or loader child process after a successful check.

### Accurate, Immutable Docker Provenance

The image is built under a unique
`build-v0.3.6-<commit>-<run>-<attempt>` staging subject. Its digest is verified
and smoked before that same digest is promoted to `v0.3.6`. Publication refuses
to overwrite an existing version tag with a different digest, and provenance
no longer presents `latest` as the build subject.

### Stronger Exact-Release Gates

Docker publication verifies the exact Runtime tag and every pinned package
source ref. SDK, MCP, and installer checkouts are packed as real tarballs, then
cross-package and fresh-install checks run against those artifacts. Manual
workflow recovery remains limited to verification-only harness changes.

### End-To-End Fresh Install

The release gate installs from the exact Runtime tag, starts without an
embedding key, exercises packaged SDK/MCP entrypoints plus continuity handoff
and context paths, and waits for the temporary Runtime to close cleanly.

### Node.js 22.13+ Baseline

Source and local installs require Node.js `>=22.13.0`. Earlier Node 22
experimental SQLite builds are rejected because their empty-row behavior does
not provide the semantics required by Runtime existence checks. CI runs the
public smoke on the minimum supported version. The Docker image continues to
use Node.js 24.

### Documentation Cleanup

Install guidance now states the real Node floor. Product-surface documentation
no longer describes a Dashboard or control-panel product that is outside the
current Aionis repository and release boundary.

## Compatibility

- No HTTP API or SDK/MCP contract changes.
- No SQLite schema, migration, or durable event-format changes.
- Existing v0.3.5 SQLite data remains compatible.
- Source/local installs must use Node.js `>=22.13.0`.
- The supported deployment shape remains one self-hosted Runtime process;
  multi-instance HA and managed multi-tenant Server GA are not claimed.

## Verification Gate

```bash
npm run -s typecheck
npm run -s lite:test
npm run -s lite:smoke
npm run -s sdk:check
npm run -s complexity:check
node scripts/ci/release-artifact-gate.mjs --check --expect-tag v0.3.6
npm run -s runtime:smoke:external-packages
npm run -s runtime:smoke:fresh-install
npm run -s runtime:smoke:published-cli
docker build --platform linux/amd64 \
  --iidfile /tmp/aionis-v0.3.6.iid \
  -t aionis:v0.3.6-smoke .
bash scripts/ci/docker-release-smoke.sh \
  "$(cat /tmp/aionis-v0.3.6.iid)"
```

## Publish Order

Create remains unpublished until the Runtime tag and verified Docker digest
resolve:

```bash
# 1. Merge the verified Runtime release commit, then create the immutable tag.
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
git push origin main
git tag -a v0.3.6 -m "Aionis v0.3.6"
git push origin v0.3.6

# 2. Wait for the Docker workflow and verify the immutable artifact.
git ls-remote --exit-code --tags origin refs/tags/v0.3.6
docker pull ghcr.io/ostinatocc/aionis:v0.3.6

# 3. Publish the already frozen installer only after Runtime verification.
cd /Volumes/ziel/new.aionis/aionis-create
npm publish --access public
```

## Exact-Version Post-Publish Smoke

```bash
AIONIS_FRESH_INSTALL_CREATE_SPEC="@aionis/create@0.3.8" \
AIONIS_FRESH_INSTALL_SDK_SPEC="@aionis/sdk@0.3.15" \
AIONIS_FRESH_INSTALL_MCP_SPEC="@aionis/mcp@0.3.7" \
AIONIS_FRESH_INSTALL_REPO="https://github.com/ostinatocc/Aionis.git" \
AIONIS_FRESH_INSTALL_RUNTIME_REF="v0.3.6" \
npm run -s runtime:smoke:fresh-install

AIONIS_PUBLISHED_CLI_SMOKE_SPEC="aionis@0.3.8" \
npm run -s runtime:smoke:published-cli
```

No package, image, or Public Beta announcement is complete until its immutable
ref resolves and the exact-version smoke passes.

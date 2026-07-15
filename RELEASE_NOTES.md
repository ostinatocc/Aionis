# Aionis v0.3.8 Exact Guide-Feedback Attribution Candidate Notes

Release status `candidate`.

Runtime `v0.3.8` is the corrective Local Runtime Public Beta candidate after
the immutable `v0.3.7` tag. It keeps the evidence-gated learning substrate and
closes the boundary between memory visible for continuity and memory proven to
have been used. It does not enable autonomous learning globally.

`v0.3.7` failed its cross-package external smoke before Docker image build: the
old smoke attempted to submit a context-only handoff as learning feedback and
Runtime correctly rejected it. No Runtime GitHub Release or
`ghcr.io/ostinatocc/aionis:v0.3.7` image was published. The tag stays immutable;
`v0.3.8` replaces it.

## Candidate Coordinates

- `aionis@0.3.8` — immutable source ref `v0.3.8`
- `@aionis/create@0.3.8` — immutable source ref `v0.3.8`
- `@aionis/sdk@0.3.17` — planned immutable source ref `v0.3.17`
- `@aionis/mcp@0.3.7` — immutable source ref `v0.3.7`
- `@aionis/aifs@0.3.4` — immutable source ref `v0.3.4`
- `@aionis/claude-code@0.3.5` — immutable source ref `v0.3.5`
- `@aionis/substrate@0.1.11` — immutable source ref `v0.1.11`
- Runtime source tag `v0.3.8`
- Docker image `ghcr.io/ostinatocc/aionis:v0.3.8` (`linux/amd64` only)
- Default installer Runtime ref `v0.3.6`

Every package ref is paired with its exact 40-character source commit in
`release-train.json`. The default installer remains on immutable `v0.3.6`.
Candidate status does not move Docker `latest`.

## Corrective Contract

### Persisted Attribution Projection

`POST /v1/guide` now returns host-only `feedback_attribution_v1` from a
post-append database readback inside the guide transaction. `status: available`
contains exact persisted item IDs, served surfaces, canonical episode/event
identity, and projection digests. `status: unavailable` fails closed when no
learning exposure was persisted.

AgentContext remains the Agent visibility and continuity surface. Its memory
IDs are useful for trace correlation, but are neither proof of use nor feedback
authority. Context-only handoffs cannot be promoted into learning evidence.

### Strict SDK Feedback

`@aionis/sdk@0.3.17` requires the complete source guide. It parses and validates
`feedback_attribution_v1`, accepts only host-observed IDs that match exact
persisted items, derives the served surface, and rejects context-only, unknown,
mixed-surface, rehydrate-only, and explicit-assertion fallback paths. A missing
or unavailable projection requires a fresh compatible guide.

Non-neutral feedback on `inspect_before_use` or `do_not_use` requires a
canonical verified `host_use_receipt_v1`. Formal receipts must agree with both
the guide attribution envelope and the protected operation/episode/run/item
identity.

### Host Integration And Release Smoke

Host templates retain visible IDs for correlation but no longer copy
`last_use_now_memory_ids` into outcome feedback. The host must provide exact IDs
from an instrumented Agent/host trace. The external package smoke exercises the
same rule against a real Runtime and verifies the context-only rejection.

### Existing Evidence-Gated Learning Authority

The append-only episode ledger, atomic exposure/feedback persistence,
protected experiment lifecycle, v3-to-v4 migration, operation receipts,
restart integrity, route governance, and 21-route matrix remain intact from
the evidence-gated learning candidate.

## Safety And Compatibility

- Global admission-candidate serving remains off by default.
- Legacy unprotected feedback remains compatibility-only and cannot enter
  formal gate coverage.
- Cached guide responses without `feedback_attribution_v1` must be refreshed;
  SDK feedback does not fall back to AgentContext.
- No route is removed. Raw HTTP feedback continues to reload persisted exposure
  by `guide_trace_id` and validates the exact item/surface pair.
- The supported deployment remains one self-hosted Runtime process; managed
  multi-tenant GA and multi-instance HA are not claimed.
- The durable learning-control queue/worker and later promotion phases remain
  outside this checkpoint.

## Verification Gate

```bash
npm run -s typecheck
npm run -s lite:test
npm run -s lite:smoke
npm run -s sdk:check -- --sdk-repo /Volumes/ziel/new.aionis/aionis-sdk
npm run -s complexity:check
node --test scripts/ci/release-version-docs.test.mjs
AIONIS_RELEASE_SDK_REPO=/Volumes/ziel/new.aionis/aionis-sdk \
  node scripts/ci/release-artifact-gate.mjs --check --expect-tag v0.3.8
npm run -s runtime:smoke:external-packages
npm run -s runtime:smoke:fresh-install
npm run -s runtime:smoke:published-cli
docker build --platform linux/amd64 \
  --iidfile /tmp/aionis-v0.3.8.iid \
  -t aionis:v0.3.8-smoke .
bash scripts/ci/docker-release-smoke.sh \
  "$(cat /tmp/aionis-v0.3.8.iid)"
```

## Publish Order

The SDK commit and tag must be remotely resolvable before Runtime CI checks the
frozen package coordinate:

```bash
# 1. Merge and push the verified SDK commit, then publish its immutable tag.
cd /Volumes/ziel/new.aionis/aionis-sdk
git push origin main
git tag -a v0.3.17 -m "@aionis/sdk v0.3.17"
git push origin v0.3.17

# 2. Publish the exact SDK package only after source/tag verification.
npm publish --access public

# 3. Merge the verified Runtime release commit, then tag the merged main commit.
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
git push origin release/v0.3.8
git tag -a v0.3.8 -m "Aionis v0.3.8"
git push origin v0.3.8

# 4. Verify the tag-triggered Runtime image.
git ls-remote --exit-code --tags origin refs/tags/v0.3.8
docker pull ghcr.io/ostinatocc/aionis:v0.3.8
```

Do not republish `@aionis/create@0.3.8`; it is already frozen and its default
Runtime remains `v0.3.6`. A future installer default change requires a new
installer version.

## Exact-Version Post-Publish Smoke

```bash
AIONIS_FRESH_INSTALL_CREATE_SPEC="@aionis/create@0.3.8" \
AIONIS_FRESH_INSTALL_SDK_SPEC="@aionis/sdk@0.3.17" \
AIONIS_FRESH_INSTALL_MCP_SPEC="@aionis/mcp@0.3.7" \
AIONIS_FRESH_INSTALL_REPO="https://github.com/ostinatocc/Aionis.git" \
AIONIS_FRESH_INSTALL_RUNTIME_REF="v0.3.8" \
npm run -s runtime:smoke:fresh-install

AIONIS_PUBLISHED_CLI_SMOKE_SPEC="aionis@0.3.8" \
npm run -s runtime:smoke:published-cli
```

No package, image, or Public Beta announcement is complete until its immutable
ref resolves and the exact-version smoke passes.

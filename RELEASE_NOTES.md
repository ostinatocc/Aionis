# Aionis v0.3.7 Evidence-Gated Learning Candidate Notes

Release status `candidate`.

Runtime `v0.3.7` is the next single-process, self-hosted Aionis Local Runtime
candidate after the immutable `v0.3.6` release. It adds the protected evidence
substrate for learning episodes, experiment lifecycle, guide exposure, and
memory feedback attribution. It does not enable autonomous learning globally.

## Candidate Coordinates

- `aionis@0.3.8` — immutable source ref `v0.3.8`
- `@aionis/create@0.3.8` — immutable source ref `v0.3.8`
- `@aionis/sdk@0.3.16` — immutable source ref `v0.3.16`
- `@aionis/mcp@0.3.7` — immutable source ref `v0.3.7`
- `@aionis/aifs@0.3.4` — immutable source ref `v0.3.4`
- `@aionis/claude-code@0.3.5` — immutable source ref `v0.3.5`
- `@aionis/substrate@0.1.11` — immutable source ref `v0.1.11`
- Runtime source tag `v0.3.7`
- Docker image `ghcr.io/ostinatocc/aionis:v0.3.7` (`linux/amd64` only)
- Default installer Runtime ref `v0.3.6`

Every package ref is paired with its exact 40-character source commit in
`release-train.json`. The default installer remains on immutable `v0.3.6`
until the new candidate and its package train have passed publication gates.
Candidate status does not move Docker `latest`.

## Highlights

### Append-Only Learning Authority

The Runtime now owns append-only learning episode events, per-memory exposure
and attribution rows, experiment revisions, namespace leases, safety-stop
authority, and operation receipts in the main SQLite transaction domain.
Current v3 databases migrate atomically to schema v4 only after the complete
source authority shape passes preflight. Restart verification, backup, and
restore reject mixed, damaged, or drifted authority state.

### Protected Experiment Lifecycle

Non-HTTP provisioning and close commands accept strict reviewed inputs and
tenant/scope anchors. Provisioning uses OS CSPRNG assignment and atomically
freezes 384 matched pairs with 768 namespace leases. Exact retries replay the
same result. Close requires a bounded HMAC approval and Runtime receipt
attestation, seals the attempt, and releases the complete lease set in one
transaction. Database, sidecar, ancestor ownership, mode, and ACL checks fail
closed.

### Atomic Guide Exposure

`POST /v1/guide` accepts an optional caller-supplied `operation_id`. Protected
requests provide exact replay after concurrency or a lost response, reject
content drift, and enforce the 2 MiB receipt bound. Memory/tool decisions, the
guide receipt, exposure event/items, and operation receipt share the same
transaction and source commit.

### Evidence-Bound Memory Feedback

Direct memory feedback accepts a protected feedback operation plus
`host_use_receipt_v1`. The Runtime inherits provenance from the source exposure,
checks each subject against its exact served and used surface, derives
attribution strength from immutable receipt roots, and atomically commits the
activation, feedback event, item attribution, receipt roots, counters, safety
pause, and gate-authority receipt. Restart validation independently derives the
same facts and rejects tampering.

Legacy feedback remains compatible, but is classified as
`legacy_unverified`/`not_attributed` and cannot enter formal gate coverage.

### SDK And Host Conformance

`@aionis/sdk@0.3.16` adds strict builders, parsers, and digests for
`host_task_envelope_v1` and `host_use_receipt_v1`, and preserves protected
guide/feedback operation identity through direct and role-aware helpers. A
read-only host-adapter conformance command emits a bounded canonical `0600`
result and rejects secrets or raw content.

### Release And Route Integrity

The real 21-route HTTP surface remains covered by route governance. Linux
container and CI images include `acl` so protected experiment close can verify
fixed-path access controls. The complexity budget is measured after all new
source files are tracked rather than against a partial worktree.

## Safety Posture And Deferred Work

- Global admission-candidate serving remains off by default.
- The production external-execution-policy registry remains unregistered and
  the checked-in gate remains `calibration_pending`; this candidate does not
  automatically start confirmatory or active-control traffic.
- The durable learning-control queue schema and integrity checks are reserved,
  but Task 4.1 Step 4 production enqueue, lease/retry/dead-letter worker, and
  Runtime lifecycle wiring are not included yet. Repeated-unused observations
  remain read-only and do not become negative feedback or change posture.
- Tool-feedback atomic refactoring, measurement episode binding, and later
  gate/promotion phases are outside this checkpoint.

## Compatibility

- Existing unprotected guide and feedback calls remain accepted.
- HTTP and SDK contracts add optional protected identity/evidence fields; no
  existing route is removed.
- Complete v3 authority databases migrate atomically to v4. Damaged, mixed, or
  future schemas fail closed instead of being repaired opportunistically.
- The supported deployment shape remains one self-hosted Runtime process;
  multi-instance HA and managed multi-tenant Server GA are not claimed.

## Verification Gate

```bash
npm run -s typecheck
npm run -s lite:test
npm run -s lite:smoke
npm run -s sdk:check -- --sdk-repo /Volumes/ziel/new.aionis/aionis-sdk
npm run -s complexity:check
AIONIS_RELEASE_SDK_REPO=/Volumes/ziel/new.aionis/aionis-sdk \
  node scripts/ci/release-artifact-gate.mjs --check --expect-tag v0.3.7
npm run -s runtime:smoke:external-packages
npm run -s runtime:smoke:fresh-install
npm run -s runtime:smoke:published-cli
docker build --platform linux/amd64 \
  --iidfile /tmp/aionis-v0.3.7.iid \
  -t aionis:v0.3.7-smoke .
bash scripts/ci/docker-release-smoke.sh \
  "$(cat /tmp/aionis-v0.3.7.iid)"
```

## Publish Order

The SDK commit and tag must be remotely resolvable before Runtime CI can check
the frozen package coordinate:

```bash
# 1. Publish the already verified SDK commit and immutable tag.
cd /Volumes/ziel/new.aionis/aionis-sdk
git push origin main
git push origin v0.3.16

# 2. Merge the verified Runtime release commit, then create its immutable tag.
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
git push origin release/v0.3.7
git tag -a v0.3.7 -m "Aionis v0.3.7"
git push origin v0.3.7

# 3. Verify the Runtime image before changing installer defaults.
git ls-remote --exit-code --tags origin refs/tags/v0.3.7
docker pull ghcr.io/ostinatocc/aionis:v0.3.7

# 4. Publish a separately frozen installer only after Runtime verification.
cd /Volumes/ziel/new.aionis/aionis-create
npm publish --access public
```

## Exact-Version Post-Publish Smoke

```bash
AIONIS_FRESH_INSTALL_CREATE_SPEC="@aionis/create@0.3.8" \
AIONIS_FRESH_INSTALL_SDK_SPEC="@aionis/sdk@0.3.16" \
AIONIS_FRESH_INSTALL_MCP_SPEC="@aionis/mcp@0.3.7" \
AIONIS_FRESH_INSTALL_REPO="https://github.com/ostinatocc/Aionis.git" \
AIONIS_FRESH_INSTALL_RUNTIME_REF="v0.3.7" \
npm run -s runtime:smoke:fresh-install

AIONIS_PUBLISHED_CLI_SMOKE_SPEC="aionis@0.3.8" \
npm run -s runtime:smoke:published-cli
```

No package, image, or Public Beta announcement is complete until its immutable
ref resolves and the exact-version smoke passes.

# Aionis Learning Episode Ledger Implementation Plan

Execution note: implement the tasks in order. Each task starts with its named
failing test or baseline check and ends with the listed focused verification;
do not skip a phase boundary to enable active serving early.

**Goal:** Build an append-only episode ledger, per-memory exploration/exploitation evidence, deterministic active/control gray assignment, and task-family evidence gate without replacing current Runtime artifacts or enabling global learning by default.

**Architecture:** Keep AionisRuntime-focused as a local TypeScript modular monolith with one file-backed SQLite write database. Existing guide receipts, memory/tool commits, and product measurements remain their domain authorities; new immutable experiment, episode, item-attribution, external-run reservation/ticket-consumption/preclaim-hold/claim/supervisor-binding/session-termination/evidence, and two-stage gate-decision rows connect them transactionally. Confirmatory traffic uses a finite reviewed set of leased store-memory namespaces, randomized as matched disjoint clusters; same-call shadow and online arms provide projection/finite-population operational evidence, while a one-shot immutable paired real-Agent run provides a deterministic regression on its exact reviewed holdout—not an iid or superpopulation causal estimate.

**Tech Stack:** TypeScript, Zod, Fastify product services, `node:sqlite`, existing `LiteRuntimeDatabase` and `SqliteTransactionRunner`, Node test runner, `tsx`, existing admission/effect/promotion kernels, Markdown architecture docs.

---

## Implementation contract

Read before changing code:

- `docs/architecture/AIONIS_LEARNING_EPISODE_LEDGER_DESIGN.md`
- `docs/adr/0001-use-append-only-learning-episode-ledger.md`
- `docs/AIONIS_PRODUCT_CONTRACT.md`
- `docs/AIONIS_STATE_MODEL.md`
- `docs/architecture/runtime-complexity-budget.json`

Do not start active serving until schema, dual-write, verification, A/A, and
shadow phases have passed independently.

The implementation must preserve:

```text
AIONIS_ADMISSION_CANDIDATE_POLICY_MODE default = off
no new /v1 route
no missing-feedback-as-negative inference
no task-family authority from observed_count alone
no external provider call inside BEGIN IMMEDIATE
no measurement event through a second SQLite writer
```

Any task that changes a Runtime-owned region in `src/sdk.ts` must complete the
paired standalone SDK step before its Runtime commit:

```bash
set -euo pipefail
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
npm run -s sdk:sync -- --sdk-repo /Volumes/ziel/new.aionis/aionis-sdk
cd /Volumes/ziel/new.aionis/aionis-sdk
npm test
git add src/index.ts
git commit -m "feat(sdk): sync learning episode contracts"
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
npm run -s sdk:check -- --sdk-repo /Volumes/ziel/new.aionis/aionis-sdk
```

If a later task changes the owned region again, repeat with a task-specific SDK
commit message. Never leave a Runtime commit that claims verification while the
standalone checkout is stale.

## Phase 0: Baseline and structural budget

### Task 0.1: Capture the clean baseline

**Files:**

- Read: `docs/architecture/runtime-complexity-budget.json`
- Read: `scripts/ci/runtime-complexity-budget.mjs`
- Read: `src/app/runtime-services.ts`

**Step 1: Check repository state**

Run:

```bash
git status --short --branch
git log -1 --oneline
```

Expected: only the approved design/plan documents are dirty; preserve unrelated
user changes if any appear.

**Step 2: Run the current baseline**

```bash
npm run -s typecheck
npm run -s lite:test
npm run -s complexity:check
```

Expected: PASS before source implementation.

**Step 3: Record exact structural headroom**

```bash
npm run -s complexity:report
```

Expected: the report confirms the current budget is at or near its exact source
file, source line, route, env-field, and largest-file ceilings.

**Step 4: Register the source-layout decision**

Use cohesive ledger and gate modules rather than expanding already-large
service/store files solely to preserve the current file count. The current
budget is exactly full, so intermediate `complexity:check` may fail after the
first new source module. Task 11.2 performs one audited, exact measured
rebaseline in `docs/architecture/runtime-complexity-budget.json`; any dead or
duplicated implementation discovered during the work is removed first. Do not
pre-inflate thresholds and do not hide source under generated or excluded
paths.

**Step 5: Commit baseline documents only after review**

```bash
git add docs/architecture/AIONIS_LEARNING_EPISODE_LEDGER_DESIGN.md \
  docs/adr/0001-use-append-only-learning-episode-ledger.md \
  docs/plans/2026-07-13-learning-episode-ledger.md
git commit -m "docs(runtime): design evidence-gated learning episodes"
```

## Phase 1: Versioned schema and shared measurement transaction

### Task 1.1: Write failing v2-to-v3 preflight tests

**Files:**

- Modify: `scripts/ci/lite-runtime-data-operations.test.ts`
- Modify: `src/store/lite-runtime-schema.ts`

**Step 1: Add schema classification fixtures**

Cover:

```ts
test("complete v2 remains current before v3 activation", ...);
test("damaged v2 authority table is incompatible before migration", ...);
test("future schema remains incompatible", ...);
test("complete v2 is supported_previous_v2 against an injected v3 target", ...);
```

The damaged-v2 fixture must remove a v2-required guide-receipt column or index,
not only one of the three v0.3.4 baseline tables.

**Step 2: Run the focused test**

```bash
npx tsx --test scripts/ci/lite-runtime-data-operations.test.ts
```

Expected: FAIL on the injected-target fixture because the current inspector has
no pure target-contract seam or supported-previous class. The production target
remains v2 in this task; the test injects the complete future-v3 requirement
object only into classification and never stamps or migrates the fixture.

**Step 3: Add versioned requirements without activating v3**

Refactor `lite-runtime-schema.ts` around explicit contracts:

```ts
const WRITE_SCHEMA_V2 = { columns, constraints, indexes, triggers: {} };
// Added in Task 2.2 before the target-version flip:
const WRITE_SCHEMA_V3 = { columns, constraints, indexes, triggers };

type LiteRuntimeSchemaClassification =
  | "uninitialized"
  | "legacy_v0_3_4"
  | "supported_previous_v2"
  | "current"
  | "incompatible";
```

Expose a pure requirement-selection/classification seam whose target contract
can be injected by tests. Select requirements by detected version. Never validate detected v2 against
only the legacy baseline. This task keeps the target schema/version at v2 and
must not call `recordCurrentLiteRuntimeWriteSchema` with version 3. Task 2.2
adds the complete v3 contract and atomically flips the target only in the same
change that adds the v3 DDL/migration; no intermediate commit can stamp a v3
metadata row without v3 tables.

**Step 4: Run tests and typecheck**

```bash
npx tsx --test scripts/ci/lite-runtime-data-operations.test.ts
npm run -s typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/lite-runtime-schema.ts scripts/ci/lite-runtime-data-operations.test.ts
git commit -m "fix(store): validate versioned runtime schemas"
```

### Task 1.2: Prepare the shared measurement factory without rewiring Runtime

**Files:**

- Modify: `src/store/lite-skill-candidate-review-store.ts`
- Modify: `src/store/memory-store.ts`
- Test: `scripts/ci/lite-skill-candidate-review-store.test.ts`

**Step 1: Write a failing runner-identity and rollback test**

Construct one real `LiteRuntimeDatabase`, explicitly run the extracted
measurement migrator in the fixture, then assert that shared-factory access uses
its transaction runner and a `before_commit` fault leaves neither a measurement
nor a sibling write visible after reopen.

**Step 2: Run the test**

```bash
npx tsx --test scripts/ci/lite-skill-candidate-review-store.test.ts
```

Expected: FAIL because only the path-based factory and independent runner exist.

**Step 3: Extract schema setup and add the shared factory**

Implement:

```ts
export function migrateLiteSkillCandidateReviewSchema(db: SqliteDatabase): void;

export function createLiteSkillCandidateReviewStoreFromDatabase(
  database: LiteRuntimeDatabase,
  options: { closeDatabaseOnClose?: boolean } = {},
): LiteSkillCandidateReviewStore;
```

`reviewAccessForDb` accepts `database.transaction`; every read and mutation uses
that runner. Shared `close()` does not close the database. The standalone path
factory creates a `LiteRuntimeDatabase` and delegates to the shared factory.
For the shared Runtime path, schema DDL is invoked only by the central atomic
v3 migration; the factory asserts the migrated shape and does not perform
opportunistic repair DDL after preflight.

**Step 4: Deliberately keep the old Runtime assembly for now**

Do not modify `src/app/runtime-services.ts` in this task. Fresh Runtime databases
do not yet have the central v3 measurement shape; rewiring before Task 2.2 would
make startup order invalid. Task 2.3 performs the switch after the atomic
migration exists.

**Step 5: Run tests**

```bash
npx tsx --test scripts/ci/lite-skill-candidate-review-store.test.ts
npm run -s typecheck
```

Expected: PASS for the explicit shared-factory fixture; production assembly is
still unchanged.

**Step 6: Commit**

```bash
git add src/store/lite-skill-candidate-review-store.ts src/store/memory-store.ts \
  scripts/ci/lite-skill-candidate-review-store.test.ts
git commit -m "refactor(store): prepare shared measurement access"
```

## Phase 2: Ledger contracts and SQLite v3 tables

### Task 2.1: Add strict learning-ledger contracts

**Files:**

- Create or merge: `src/memory/learning-episode-ledger.ts`
- Create or merge: `src/memory/admission-candidate-policy.ts`
- Create or merge: `src/memory/learning-gate-policy.ts`
- Create: `src/memory/learning-authority-approval.ts`
- Modify: `src/memory/admission-candidate-policy-evaluator.ts`
- Modify: `src/memory/product-output/operator-projections.ts`
- Modify: `src/memory/product-output/decision-trace.ts`
- Modify: `src/memory/admission-real-agent-rerun.ts`
- Modify: `src/memory/admission-feature-sufficiency-audit.ts`
- Create: `scripts/ci/lite-learning-episode-contract.test.ts`
- Test: `scripts/ci/lite-memory-decision-trace-correctness.test.ts`
- Test: `scripts/ci/lite-admission-real-agent-rerun.test.ts`
- Test: `scripts/ci/lite-admission-feature-sufficiency-audit.test.ts`
- Test: `scripts/ci/lite-admission-candidate-policy-evaluator.test.ts`

**Step 1: Write failing contract tests**

Cover:

- deterministic `lep_` episode ID;
- strict exposure, feedback, and effect payloads;
- strict `host_task_envelope_v1` and `host_use_receipt_v1`, including canonical
  guide/episode/operation/collector/subject/surface/verifier kind, version and
  config/evidence binding;
- bounded arrays and valid 64-character digests;
- explore/exploit classification from decision-time prior;
- exact track-reason precedence from persisted prior counts/effect/posture;
- mixed episode summary;
- hard-boundary candidate upgrade rejection;
- `aa|shadow|active_control` phase/authority-ceiling compatibility;
- deterministic integrity-phase assignment plus confirmatory exact matched-pair
  assignment from the persisted server-confidential random bit vector, exposing
  only its digest to clients and artifacts; every confirmatory pair has one
  candidate and one control, with no randomness rejection/redraw, and a fixture arm never
  predicts the eligible-host arm;
- exact candidate/gate ID-version lookup through a code registry, unknown
  version rejection, and online/offline candidate golden-vector parity;
- exact gate registry tuple `gate_policy_id=gate-policy`,
  `gate_policy_version=v1` (canonical key `gate-policy-v1`), with no accepted
  alias, including evidence-intent rules,
  one task-family/candidate-implementation confirmatory attempt,
  store-memory-namespace matched-pair assignment, frozen 96/96/192 activation
  waves and cumulative 96/192/384-pair checkpoint schedule,
  exact `1/20` any-direction budget, `1/40` directional online alpha,
  checkpoint 1 safety/integrity-only, checkpoints 2/3 at `1/80` per online
  direction/formal look, configuration digest, implementation-contract
  digest, prospective-calibration contract/digest, and unknown-version
  rejection; the initial production status is `calibration_pending`, and no
  confirmatory revision can be provisioned until Task 8.2 registers a passing
  outcome-free artifact;
- fail-closed canonical task identity reconciliation across `context`,
  `execution_packet_v1`, `execution_state_v1`, and host envelope;
- branded public/store scope usage, including a non-default-tenant join fixture;
- evidence-evaluation versus authority-adjudication contracts;
- strict bounded `LearningAuthorityApprovalV1` and
  `LearningExperimentCloseApprovalV1` canonical bodies/digests, distinct action
  domains, expiry/key/nonce/operation bindings, and secret-free parsing;
- strict outcome-redacted `LearningLookProposalV1` and
  `RuntimeIntegrityGateReportV1` contracts, including confirmatory-attempt,
  cutoff, policy/config, cutoff-bounded outcome-redacted authority-projection,
  and proposal-digest bindings;
- strict global `runtime_authority_attestor` contract inside
  `external_execution_policy`: service identity, attestor binary/policy/raw-
  public-key/digest/key-ID/`ed25519-v1` signature algorithm, launcher policy/
  binary/raw-public-key/digest/key-ID, and
  expected database-lineage identity are all required canonical digest input
  and cannot be overridden by a role or caller;
- legacy/unprotected payloads forced promotion-ineligible.

**Step 2: Run the test**

```bash
npx tsx --test scripts/ci/lite-learning-episode-contract.test.ts
```

Expected: FAIL because contracts do not exist.

**Step 3: Implement pure contracts and canonical hashing**

Export at minimum:

```ts
export function learningEpisodeId(args: {
  tenantId: string; scope: string; guideTraceId: string;
}): string;

export function classifyLearningTrack(prior: FrozenPriorState): {
  track: "explore" | "exploit" | "unclassified";
  reason: LearningTrackReason;
};

export function learningEpisodeEventDigest(event: EventWithoutDigest): string;
export function learningItemSetDigest(items: readonly LearningLedgerItem[]): string;
export function hostTaskEnvelopeDigest(value: HostTaskEnvelopeV1): string;
export function hostUseReceiptDigest(value: HostUseReceiptV1Body): string;
```

The supplied `receipt_sha256` is compared with the digest of the canonical body
and is never included in its own preimage.

Move the private prior predicate/reason resolver out of
`memory/product-output/operator-projections.ts` into the shared module. Rewire
operator projection, decision trace, real-Agent rerun, and feature-sufficiency
audit to it. Dataset counter construction may remain in the SDK, but every
Runtime classification of those persisted fields uses this one resolver.

Extract the hard-coded admission candidate into one canonical declarative
registry entry consumed by both online projection and
`admission-candidate-policy-evaluator.ts`. Its behavior-vector digest is the
persisted implementation contract. Profile metadata cannot invent a policy;
unknown ID/version/config or parity drift fails enrollment.

Create the corresponding pure gate-policy registry now, before experiment
provisioning needs to resolve it. It owns the exact versioned constants, look
schedule, evidence-intent compatibility, confidence levels, safety thresholds,
its prospective calibration contract, and its golden-vector
implementation-contract digest. Its production registration is initially
`calibration_pending`; confirmatory experiment provisioning fails closed in
that state, and no production gate-policy row may omit a passing embedded
calibration artifact.
Task 8.2 implements the statistics engine, generates/reviews the outcome-free
calibration artifact, and changes the same registry entry to `registered` with
that artifact digest. The preregistration inference-engine implementation
contract is an input to the artifact and excludes the artifact SHA; the final
policy-config digest includes the artifact SHA, avoiding a circular hash. It
must not define a second set of gate constants.

Create the shared pure approval contracts and digest builders here as well.
They authorize nothing by themselves: Task 3 wires experiment-close HMAC
verification and Task 9 wires gate-adjudication verification through the
existing authority keyring. Keeping both schemas in one module prevents nonce,
scope, and action-domain drift.

**Step 4: Run tests**

```bash
npx tsx --test scripts/ci/lite-learning-episode-contract.test.ts
npx tsx --test scripts/ci/lite-memory-decision-trace-correctness.test.ts
npx tsx --test scripts/ci/lite-admission-real-agent-rerun.test.ts
npx tsx --test scripts/ci/lite-admission-feature-sufficiency-audit.test.ts
npx tsx --test scripts/ci/lite-admission-candidate-policy-evaluator.test.ts
npm run -s typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/memory/learning-episode-ledger.ts \
  src/memory/admission-candidate-policy.ts \
  src/memory/learning-gate-policy.ts \
  src/memory/learning-authority-approval.ts \
  src/memory/admission-candidate-policy-evaluator.ts \
  src/memory/product-output/operator-projections.ts \
  src/memory/product-output/decision-trace.ts \
  src/memory/admission-real-agent-rerun.ts \
  src/memory/admission-feature-sufficiency-audit.ts \
  scripts/ci/lite-learning-episode-contract.test.ts \
  scripts/ci/lite-memory-decision-trace-correctness.test.ts \
  scripts/ci/lite-admission-real-agent-rerun.test.ts \
  scripts/ci/lite-admission-feature-sufficiency-audit.test.ts \
  scripts/ci/lite-admission-candidate-policy-evaluator.test.ts
git commit -m "feat(learning): add episode ledger contracts"
```

### Task 2.2: Add append-only store, schema, indexes, and triggers

**Files:**

- Create or merge: `src/store/lite-learning-episode-ledger.ts`
- Modify: `src/store/lite-write-store.ts`
- Modify: `src/store/lite-runtime-schema.ts`
- Modify: `src/store/lite-skill-candidate-review-store.ts`
- Create: `scripts/ci/lite-learning-episode-store.test.ts`
- Test: `scripts/ci/lite-skill-candidate-review-store.test.ts`

**Step 1: Write failing file-backed SQLite tests**

Test:

- experiment revision insert, evidence intent, collection-source-policy digest,
  and conflict;
- a gate-policy row requires a bounded canonical `status=passed` prospective
  calibration artifact and matching SHA, while candidate-policy rows reject
  calibration fields; every experiment revision freezes the registered
  calibration SHA inside its configuration and conflicts on drift;
- append-only confirmatory-attempt uniqueness per task-family candidate
  implementation contract,
  and per registry-resolved candidate implementation digest (version aliases
  cannot reset alpha), one task family per revision, exact gate/config binding,
  atomic revision+attempt provisioning, and rejection after the first exposure;
- finite namespace/pair/wave manifest digest/count binding, exactly one arm
  member per pair, canonical bounded pre-treatment matching-covariate JSON/digest,
  exactly 384 complete pairs, 96/96/192 waves, atomic full-set lease
  acquisition, one active lease per tenant/namespace, generation monotonicity,
  concurrent-overlap rejection, and exact complete-set release through the
  protected store API;
- the store API rejects partial release, mixed/unresolved authority refs and
  generation skips; a direct-SQL bypass can only create structural corruption,
  which reopen verification detects and causes active serving, backup, close,
  and adjudication to fail closed;
- append-only signed experiment-close authority, one-time nonce/operation
  binding across close and gate-adjudication kinds, exact retry,
  changed-approval conflict, and closure-to-lease refs;
- tenant-wide immutable principal class/collector/verifier binding and
  cross-revision remap pause/conflict;
- exposure event plus items and server-derived collection provenance;
- promotion-eligible exposure requires an exact active namespace lease row at
  insert time with matching pair/member/arm/wave and in-window server time;
  wrong-arm, early/late, or fixture exposure on any actively leased namespace
  aborts before persistence;
- feedback/effect sequence and previous hash;
- canonical host-use receipt persistence, item membership, restart
  reverification, and receipt/event/operation reuse conflicts;
- bounded canonical task-envelope replay, tenant/revision-wide source-event
  uniqueness, host-task/source-task alias rejection across scopes, and repeated
  call deduplication;
- same source/same digest replay;
- same source/different digest conflict;
- exactly one exposure per episode;
- cross-tenant and cross-scope isolation;
- update/delete trigger rejection;
- supersession chain;
- gate-decision self-supersession rejection and one immediate successor per
  evaluated look;
- exact gate-to-artifact membership set and report-digest validation;
- immutable candidate/gate policy versions across revisions;
- one immutable 32-byte lowercase-hex CSPRNG database-lineage identity created by v3 migration and
  preserved by backup/restore; active revisions freeze the Runtime authority-
  attestor service/launcher/binary/policy/signature/public-key/key-ID and
  expected database identity, and caller-selected trust roots are rejected;
  direct UPDATE/DELETE and a second singleton insert fail, and schema preflight
  requires both identity triggers;
- one outcome-blind reservation per fixed-look index and changed-cutoff
  conflict;
- one pre-run external reservation, at most one atomic ticket consumption,
  pre-claim hold, runner claim, launcher-authenticated supervisor binding, and
  signed credential-session termination; every consumed shadow/tool/offline
  series has exactly one result, claimed-termination-hold, or pre-claim-hold
  coverage branch;
  `reserve-external` rejects path ticket output and non-broker execution; the
  broker's pre-fsynced stdin-only transfer proves the acceptance shell cannot read or
  replace ticket bytes; ticket/consumption replay, crash after consumption,
  unclaimed or unterminated result, external successor, and
  exact/partial/renamed same-task-
  family offline case reuse by task/content/workflow/scope/source-event are
  rejected; offline reservation requires explicit sealed-reference,
  ciphertext/source, membership-projection, model/profile/tool/order digests;
  claim verifies the registry-frozen broker public key, policy/binary digest,
  signed receipt body, expected runner, credential scope, hard expiry,
  supervisor-bind TTL, heartbeat, maximum calls, per-call capability TTL, and
  post-quiesce finalize TTL after restart; a normal session termination is
  unique per claim, requires
  the signed clean-quiesce receipt and runner-output manifest, matches terminal
  report status/manifest and the public attempt chain, and precedes ingest;
  duplicate/missing termination, invalid broker signature, wrong session,
  abnormal reason with a terminal manifest, normal reason without quiesce/
  output/terminal manifests, invalid `finalize_timeout` shape, and report/
  termination status or digest mismatch are rejected;
  `launch_failure|binding_integrity_failure` require a null supervisor binding,
  while post-bind crash/lease/revoke may bind the committed supervisor;
  a consumed validation failure/crash appends one signed zero-effects pre-claim
  hold and permanently blocks claim; a successful launch commits one binding
  whose launcher-created inherited channel, executable/argv, and exact
  PID/start/cgroup/job tuple match signed launcher and broker receipts before
  any mount/provider access; fixed-domain binding replay after commit-before-
  journal-ack cannot create another process or channel;
  reservation/binding digests also freeze the service-launcher policy/binary/
  key, supervisor executable/argv policy, and sandbox/child-relay policy; caller
  launch flags cannot replace these registry values;
- candidate-implementation safety fold across experiment revisions and aliases;
- every safety-stop resolves its full tenant/scope/
  `learning_gate_authority_v1`/operation key, and route/job-triggered stops
  coexist with a distinct triggering-domain operation receipt;
- replay after closing and reopening the DB.
- complete v2 becomes `supported_previous_v2` only after the v3 target is
  activated, and complete v3 is `current`; no constructor can stamp v3 before
  every v3 table/index/trigger exists.

**Step 2: Run the test**

```bash
npx tsx --test scripts/ci/lite-learning-episode-store.test.ts
```

Expected: FAIL because the store is absent.

**Step 3: Implement the v3 DDL from the architecture design**

Create:

```text
lite_runtime_authority_identity
lite_learning_policy_versions
lite_learning_collection_principal_bindings
lite_learning_experiment_revisions
lite_learning_confirmatory_attempts
lite_learning_randomization_pairs
lite_learning_namespace_leases
lite_learning_experiment_closures
lite_learning_authorization_nonces
lite_learning_episode_events
lite_learning_exposure_items
lite_learning_feedback_attributions
lite_learning_host_use_receipts
lite_learning_control_jobs
lite_learning_external_run_reservations
lite_learning_external_holdout_members
lite_learning_external_ticket_consumptions
lite_learning_external_preclaim_holds
lite_learning_external_run_claims
lite_learning_external_supervisor_bindings
lite_learning_external_session_terminations
lite_learning_evidence_artifacts
lite_learning_gate_look_reservations
lite_learning_gate_decisions
lite_learning_gate_artifact_memberships
```

Add the SQL action enums, non-negative counter checks, `INTEGER IN (0,1)`
checks, 64-character digest checks, complete-versus-legacy item constraint,
required partial indexes, immutable policy-version/revision/confirmatory-attempt/series/look
uniqueness, immutable update/delete triggers (including Runtime authority
identity, ticket consumption,
pre-claim hold, claim, supervisor binding, and session termination), one-way namespace-lease lifecycle
triggers, and a global signed-approval nonce registry. Tool decisions
must store `used_surface=NULL`; memory attributions require it. Store insert
methods require `transaction.inTransaction()` just like guide receipts. Test
whole-event feedback supersession by requiring a complete replacement item set.
Persist each verified receipt's bounded canonical body separately from its
digest, require exact attribution-item membership, and make receipt ID, receipt
digest, feedback event, and operation one-use within tenant/scope. Legacy and
tool feedback create no host-receipt header.
The experiment source policy and every event collection class/principal are
part of canonical digests; `promotion_eligible=true` is rejected unless the
exposure is an authenticated `eligible_host` under a `confirmatory` revision
whose exact append-only attempt row predates the exposure.
The mutable `lite_learning_control_jobs` queue instead gets status/lease/retry
constraints and pending/lease indexes, not append-only triggers. Namespace
leases are also operational state, but may move only `active -> released` with
all other acquisition fields frozen and a resolvable closure/adjudication ref.

Add nullable `baseline_episode_id`, `after_episode_id`, and `record_sha256` to
`lite_product_measurements` in this v3 DDL and in the v3 requirement set. The
upgrade/preservation fixture proves all existing measurement and skill-review
rows survive before Task 6 begins populating those columns.

**Step 4: Make migration atomic**

The write-store initialization sequence is:

```text
preflight detected schema
set/verify journal_mode and connection pragmas
BEGIN IMMEDIATE
create/upgrade v2 structures
migrate shared measurement structures
migrate/create immutable singleton Runtime database-lineage identity
migrate learning-ledger v3 structures
verify v3 target shape
record metadata version 3
COMMIT
```

Do not record v3 metadata before every required table/index/trigger exists.
Add a schema-specific migration fault hook plus a real child-process kill test
between DDL groups and metadata update; reopen must see complete v2 or v3 only.
Assert row-count preservation for commits/nodes/edges, guide receipts, write
operations, rule feedback, measurements, and skill reviews. A v2 upgrade draws
the lineage identity exactly once inside the migration; retry after a killed
transaction neither leaks nor changes a committed identity. Backup/restore
preserves it, while explicit new-authority provisioning creates a fresh one.

**Step 5: Run focused and schema tests**

```bash
npx tsx --test scripts/ci/lite-learning-episode-store.test.ts
npx tsx --test scripts/ci/lite-runtime-data-operations.test.ts
npx tsx --test scripts/ci/lite-skill-candidate-review-store.test.ts
npm run -s typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/store/lite-learning-episode-ledger.ts src/store/lite-write-store.ts \
  src/store/lite-runtime-schema.ts src/store/lite-skill-candidate-review-store.ts \
  scripts/ci/lite-learning-episode-store.test.ts \
  scripts/ci/lite-skill-candidate-review-store.test.ts \
  scripts/ci/lite-runtime-data-operations.test.ts
git commit -m "feat(store): add append-only learning episode ledger"
```

### Task 2.3: Rewire measurement storage after central v3 migration

**Files:**

- Modify: `src/app/runtime-services.ts`
- Modify: `src/store/lite-skill-candidate-review-store.ts`
- Modify: `src/store/memory-store.ts`
- Test: `scripts/ci/lite-skill-candidate-review-store.test.ts`
- Test: `scripts/ci/lite-atomic-write-uow.test.ts`

**Step 1: Add real Runtime assembly tests**

Create a fresh DB and an upgraded v2 DB through normal Runtime service
assembly. Assert the review/measurement store shares the exact
`LiteRuntimeDatabase.transaction` runner, opens no independent measurement
writer, and does no post-preflight DDL. Do not claim the whole Runtime has only
one connection: telemetry/runtime and recall/audit still have their existing
connections. Assert central main-schema preflight/migration completes before the
shared review factory is constructed, even though the existing runtime store is
assembled earlier.

**Step 2: Rewire only now**

Replace the path-based second writer in `src/app/runtime-services.ts` with
`createLiteSkillCandidateReviewStoreFromDatabase(runtimeDatabase)`. A
`before_commit` fault must roll back a measurement and sibling Runtime write
together after reopen.

**Step 3: Run and commit**

```bash
npx tsx --test scripts/ci/lite-skill-candidate-review-store.test.ts
npx tsx --test scripts/ci/lite-atomic-write-uow.test.ts
npm run -s typecheck
git add src/app/runtime-services.ts \
  src/store/lite-skill-candidate-review-store.ts src/store/memory-store.ts \
  scripts/ci/lite-skill-candidate-review-store.test.ts \
  scripts/ci/lite-atomic-write-uow.test.ts
git commit -m "refactor(store): share runtime transaction with measurements"
```

### Task 2.4: Complete R1 verification, backup, and replay before dual-write

**Files:**

- Modify: `src/store/lite-runtime-data-operations.ts`
- Modify: `scripts/runtime-data-ops.ts`
- Modify: `scripts/ci/lite-runtime-data-operations.test.ts`
- Create: `scripts/runtime-authority-attestor.mjs`
- Create: `scripts/ci/runtime-authority-attestor.test.mjs`
- Test: `scripts/ci/lite-learning-episode-store.test.ts`
- Create: `scripts/ci/lite-learning-r1-rehearsal.test.ts`

> Implementation sequencing correction (2026-07-14): the R1 ledger replay,
> verification posture, backup/restore, proposal-bound Runtime-integrity
> artifact, and dormant real-process rehearsal are Task 2.4A. The positive
> external-head projection and operational `runtime-authority-attestor` are
> Task 8 work because their trust decision requires the Task 8 canonical
> coverage contract, signed broker receipt verifier, external evidence
> ingestion receipt, and committed authority-head contract. Until those
> authorities exist, Runtime keeps signed external facts and both paired
> external-head flags fail-closed with
> `learning_external_heads_requires_task8_signed_ingestion`; no structural-only
> or self-signed substitute is accepted.

Task 2.4A implementation result (2026-07-14): Runtime now replays the complete
v3 learning ledger into a versioned semantic report, includes learning counts
in the v2 backup manifest while retaining v1 restore compatibility, and verifies
the exact copied snapshot rather than a source path that can drift between
checks. Restore pins one manifest-bound snapshot, publishes it no-clobber with
file/directory `fsync`, and rechecks bytes, schema, lineage, semantic counts,
and per-learning-table counts after publication. Runtime-integrity proposals
must target the smallest unreserved canonical look and, after look 1, require
the immediate prior persisted evidence evaluation. Persisted reports must use
the fixed ordered twelve-finding verifier contract; omitted findings, severity-
to-count disagreement, stale event cutoffs, and dead-letter control state fail the
artifact. A legal dead letter remains a backup-preserved operational state with
generic database `ok=true`, but blocks serving, promotion, and a passing
Runtime-integrity artifact. The CLI writes the digest-identical canonical report
bytes through an exclusive `0600` temporary file, publishes without overwrite,
and syncs the containing directory. Outcome-label permutation is proven not to
change proposal or report bytes. The dormant R1 process rehearsal keeps the
candidate policy globally off while it migrates populated v2 authority rows,
starts Runtime, verifies, backs up, restores, restarts, and compares lineage and
authority-bundle digests.

**Step 1: Add failing corruption and preservation tests**

Cover payload/item/event/receipt/decision digests, complete feedback
supersession, canonical host-envelope replay and cross-scope source dedupe,
host-receipt item/verifier-policy membership and one-use constraints,
tenant-wide principal binding, experiment assignment namespace and
collection-source-policy consistency, evidence artifact links, append-only
triggers, source links, exact gate-artifact membership sets, candidate-
implementation safety folds, finite namespace-set/lease/closure invariants,
matched pair/member/arm/wave completeness, full-set release/ref/generation
replay, and gate cutoffs. Direct-SQL partial release, arbitrary ref, generation
gap, wrong pair arm, and out-of-window exposure fixtures must be detected before
serving or backup. Upgrade a populated v2 fixture and
assert unchanged counts for commits, nodes, edges, guide receipts, write
operations, rule feedback, measurements, and skill reviews.

**Step 2: Extend verify and backup**

Make `verifyLiteRuntimeDatabase` replay the ledger and return protected,
legacy, and promotion-eligible counts. Refuse `VACUUM INTO` backup on any
schema, digest, or reference-integrity failure. A structurally valid dead-letter
job blocks active serving/promotion but is preserved in backups; losing failure
state would be worse than backing it up. An expired valid learning-control job lease is reported and
safely reclaimable, not corruption; backup/restore preserves it for normal
lease recovery. Verification requires exactly one immutable database-lineage
identity; restore the backup into a fresh path, require the same identity, and
rerun verification. A separately provisioned new authority must differ.
For external facts, generic reopen/backup verifies a legal append-only prefix,
not premature terminal completeness: pre-claim hold excludes claim; binding and
termination imply claim; evidence implies binding plus normal termination; no
edge may point backward or coexist with an exclusive branch. Consumed, claimed,
and bound pre-terminal prefixes remain legal until broker recovery reaches
their frozen deadline. A normal-terminated/not-yet-ingested prefix is also
legal but already final: later archive/ingest must preserve its exact status
and cannot turn it into an abnormal hold. Exact result vs claimed-
hold vs pre-claim-hold completeness and DB/public agreement are checked only by
pre-stop, coverage-final, and acceptance verifiers. Tests prove both the valid
in-flight prefixes and direct-SQL simultaneous/inverted-edge corruption cases.
Extend `scripts/runtime-data-ops.ts verify` with
`--learning-artifact-out PATH`; it emits a bounded canonical
`runtime_integrity_gate` report bound to the cutoff-bounded outcome-redacted
authority-projection digest, schema/policy/series
digests, verifier version, and zero/nonzero findings for later archival.
Also add optional `--learning-proposal PATH`. When present, verification parses
the strict outcome-redacted proposal and binds the report to its tenant,
task-family, experiment/revision, confirmatory-attempt, next-look index, target,
cutoff, policy/config digests, and proposal digest. It must neither select nor
hash feedback labels, action outcomes, measurements, or effect estimates.
Tests reject a wrong authority projection, tenant/revision/look/cutoff/config/proposal
digest and prove label permutation leaves proposal/report bytes unchanged.
Also add paired
`--learning-external-heads-from-coverage PATH
--learning-external-heads-out PATH` options. They verify the canonical terminal
coverage index against the live database and export bounded canonical evidence
rows, `learning_evidence_ingest_v1` operation receipts, current registered
series heads, and genuinely unstarted/hold absence proofs. Each result branch
must map exactly once and each hold branch zero times; a normal termination
without ingestion, an artifact without a result branch, or a stale/non-head
artifact fails. Golden tests cover all-result, mixed-result/hold, and zero-result
hold projections plus tampered row/receipt/coverage and exact replay.
These paired options are internal to `runtime-authority-attestor.mjs`: the
deployment launcher passes the configured live DB as an inherited read-only FD
and a private signer channel, never an argv path/key. First it holds the
deployment slot's exclusive attestation lease, proves all writers quiescent,
checkpoints/truncates WAL, and binds device/inode/checkpoint generation/main-
file digest; the lease remains held through signing. The attestor reruns full
verification and signs database-lineage identity, schema/verifier versions,
committed authority-head digest, row/operation projection, coverage digest, and
its registered service/launcher/binary/policy/key identities. It rejects a
caller path, copied DB, unresolved WAL, unregistered key, failed verifier, or
unsigned output. Coverage/status inputs are treated as claims and must equal
the mapping rederived from the registered revision and authority rows. Tests
use an ephemeral key/launcher fixture to prove positive
verification plus wrong FD/identity/key/policy/head, self-sign, replay-to-new-
head, writer/checkpoint race, same-UID peer, and key-read failures.
In the runbook, `--deployment-slot` is the authority mapping;
`--expect-database` only asserts that the operator's anticipated display path
matches the launcher-resolved object and can never select or replace it.
The authority head is the streaming fixed-table/fixed-primary-key SHA-256 of
every append-only learning authority row plus referenced Runtime operation
rows—not a max ID/count—and tests detect deletion/insertion/substitution both
inside and outside the projected three evidence rows.

**Step 3: Prove the dormant R1 binary**

The new child-process rehearsal creates a populated v2 fixture, copies it to a
temporary absolute path, starts a real Runtime on an ephemeral port with
candidate serving off, performs explicit migrate/verify/backup, stops it,
restores the backup to a second path, reopens/replays it, and compares the
pre/post protected row-count manifest and DB/bundle digests. It owns and cleans
up both child processes and temp paths. No guide/feedback dual-write is enabled
yet; a skipped manual deployment step is not accepted as this proof.

**Step 4: Run and commit**

For Task 2.4A, run the three TypeScript suites and typecheck below; the
attestor suite and files in the original combined command are intentionally
activated only with Task 8 signed ingestion.

```bash
npx tsx --test scripts/ci/lite-runtime-data-operations.test.ts
npx tsx --test scripts/ci/lite-learning-episode-store.test.ts
npx tsx --test scripts/ci/lite-learning-r1-rehearsal.test.ts
npm run -s typecheck
git add src/memory/learning-authority-approval.ts \
  src/store/lite-learning-episode-ledger.ts \
  src/store/lite-runtime-data-operations.ts scripts/runtime-data-ops.ts \
  scripts/ci/lite-learning-episode-contract.test.ts \
  scripts/ci/lite-runtime-data-operations.test.ts \
  scripts/ci/lite-learning-episode-store.test.ts \
  scripts/ci/lite-learning-r1-rehearsal.test.ts \
  docs/plans/2026-07-13-learning-episode-ledger.md
git commit -m "feat(store): verify and back up learning ledger v3"
```

## Phase 3: Protected guide episode dual-write

### Task 3.0: Add the immutable experiment resolver before enrolled writes

**Implementation split (2026-07-14):** Task 3.0 is intentionally delivered as
three fail-closed slices instead of one authority-changing commit:

- **Task 3.0A — declaration and read resolver:** strict immutable profile
  declarations, stable principal identity, a same-database redacted authority
  resolver, exact `AuthPrincipal`/host-envelope guide wiring, nested authority
  claim rejection, and control-only behavior until protected enrolled writes
  exist. This slice must not expose assignment entropy or claim that an
  experiment has been provisioned.
- **Task 3.0B — protected provision command:** the non-HTTP provision workflow,
  sole-source CSPRNG generation, operation receipts, manifest lineage checks,
  concurrent exact replay, and applicability-artifact regeneration described
  below.
- **Task 3.0C — signed atomic close command:** keyring-backed approval
  verification plus nonce, closure, full lease release, and operation receipt
  in one shared write transaction.

**Task 3.0B implementation split (2026-07-14):** the protected provision
workflow is itself delivered in two fail-closed slices:

- **Task 3.0B-1 — provision authority foundation:** strict integrity-only
  profile/task parsing, a full immutable external-execution-policy registry
  contract, a tenant-wide protected operation receipt, double-checked exact
  replay, an independent 32-byte diagnostic OS-CSPRNG draw inside the shared
  `BEGIN IMMEDIATE`, atomic candidate/gate/principal/revision registration, and
  DB-regenerated secret-scanned applicability output. Production remains
  blocked by the checked-in pending gate and unregistered external policy;
  only an explicitly injected checked-in test registry exercises success.
- **Task 3.0B-2 — confirmatory atomic provision:** reviewed external inputs and
  memory-namespace manifest, pre-treatment lineage scan, exactly 384 persisted
  pairs/768 leases, an independent 48-byte MSB-first assignment vector, wave
  and attempt bindings, concurrent process replay, and full confirmatory
  applicability membership.

**Task 3.0B completion (2026-07-14):** both slices are implemented. The B2
boundary freezes strict reviewed inputs, requires 768 existing clean store
scopes, derives pair/attempt/lease identities server-side, draws independent
32-byte diagnostic and 48-byte confirmatory randomness only after the locked
lineage checks, and atomically persists the full 384-pair/768-lease authority
set plus its DB-regenerated applicability receipt. Real two-process tests prove
one fresh writer, one exact replay, and exactly one `[32,48]` entropy trace.
The canonical store-scope contract is one shared 256 UTF-8-byte limit, including
the non-default-tenant prefix, and the CLI rejects an overflowing reviewed
manifest before opening the database. A DB-lineage-bound, append-only
tenant-scope encoding anchor prevents `MEMORY_TENANT_ID` drift from reassigning
legacy unprefixed scopes. New empty databases establish the anchor before memory
writes; a legacy database that already contains unprefixed memory without an
anchor remains available but confirmatory provisioning fails closed until an
explicit offline ownership migration/attestation is completed.
Completing Task 3.0B does not authorize confirmatory or production traffic.

**Task 3.0C completion (2026-07-14):** the protected non-HTTP close workflow is
implemented against the actual B2 authority model. A strict, maximum-one-hour
approval binds Runtime lineage, task family, confirmatory attempt and digest,
revision/config, exact namespace set, both implementation contracts, operation,
reason, nonce, issuer, and key. Fresh close verifies that HMAC under a configured
non-ephemeral keyring, then the Runtime active key adds a second domain-separated
HMAC attestation over the complete close receipt. This permits removal of a
retired approval key while keeping restart verification and exact replay
cryptographically closed, provided the receipt-attestation key remains in the
keyring; a missing attestation key is an integrity failure, never a structural
fallback. The attestation authenticates its own key ID as well as the receipt.
The production wrapper accepts only an existing current-v3 database, opens it
with SQLite `mode=rw` (never create), holds an `O_NOFOLLOW` descriptor, and
pins canonical realpath/device/inode. Its immutable read-only preflight creates
no WAL/SHM sidecars on a quiescent database; an already-live, trusted WAL/SHM
pair is read through SQLite's normal read-only WAL view. The protected writer
performs no migration or journal-mode change before revalidation. The database
and direct parent must be owned by the service UID. Every canonical ancestor to
the filesystem root must be owned by that UID or root, and the database, direct
parent, every ancestor, and every existing `-wal`/`-shm`/`-journal` sidecar must
grant no group/other write authority. Access ACL delegation is rejected at
every level. The direct parent's default ACL is also rejected because it can be
inherited by a newly created WAL/SHM/journal; a complete, syntactically valid
default ACL on an already-existing non-direct ancestor is accepted because the
close path creates no child there. Restrictive macOS deny-only ACLs remain
valid; additive POSIX access ACLs and macOS allow entries are rejected. Sidecars
must be current-UID regular non-symlink files; WAL/SHM must
exist as a pair and any rollback journal requires recovery before close. ACL
verification itself is fail-closed. Linux requires the `acl` package's fixed-path
`getfacl` verifier; missing tooling, stderr, unknown output, named/mask access
ACLs, direct-parent default ACLs, malformed ancestor default ACLs, or a base
access ACL that disagrees with `stat.mode` are all rejected. The
container and Ubuntu CI install that dependency explicitly. The service UID and root are the explicit local-filesystem trust
boundary; a same-UID actor already has Runtime database authority. As required
by Runtime's SQLite WAL posture, this boundary covers locally enforced POSIX
filesystems only; operator-controlled FUSE and remote NFS/CIFS mounts are not a
supported close target. All authority
and filesystem checks run again under the shared `BEGIN IMMEDIATE`, including
any WAL/SHM pair created while acquiring the write lock. Nonce, append-only closure, protected operation
receipt, and one uniform release of all 768 leases commit or roll back together.
Restart, tamper, fault-injection, real CLI, and same/different-operation
two-process tests cover this boundary. Fresh proposal, reservation, evaluation,
and promotion-eligible exposure fail after close; exact historical replay and
late attributed feedback remain available.

All three Task 3.0 slices are now implemented. Production nevertheless remains
fail-control: the checked-in gate registry is still `calibration_pending`, and
there is not yet a production external execution-policy code registry.
Synthetic passed registries are test-only. Neither A/A/shadow nor confirmatory
production traffic is authorized or claimed by this implementation.

**Files:**

- Modify: `src/config.ts`
- Modify: `src/config/runtime-config.ts`
- Modify: `src/app/runtime-services.ts`
- Modify: `src/runtime-entry.ts`
- Modify: `src/server/http-server.ts`
- Modify: `src/routes/product-facade.ts`
- Modify: `src/product/product-services.ts`
- Modify: `src/product/guide-service.ts`
- Modify: `src/memory/learning-episode-ledger.ts`
- Modify: `src/store/lite-learning-episode-ledger.ts`
- Create: `src/memory/learning-experiment-resolver.ts`
- Modify: `src/memory/learning-authority-approval.ts`
- Create: `scripts/learning-experiment.ts`
- Create: `scripts/ci/lite-learning-experiment-cli.test.ts`
- Test: `scripts/ci/lite-config-posture.test.ts`
- Test: `scripts/ci/lite-admission-policy-active-projection.test.ts`
- Test: `scripts/ci/lite-product-facade-route.test.ts`
- Test: `scripts/ci/lite-learning-experiment-resolver.test.ts`

**Step 1: Write failing configuration tests**

Add the nested immutable experiment object with phase
`aa|shadow|active_control`, evidence intent
`integrity_only|confirmatory`, revision, allocation/design, exact registered candidate
and gate policy versions, four required evidence-series IDs, and a
registry-derived external execution policy. For each external role it freezes
the exact runner principal, session class, credential-broker binary/policy and
public-key digests, receipt signature algorithm/key ID, and credential scope.
The confirmatory profile also freezes exactly three role-specific immutable
input-manifest, retry-policy, and planned-run-ID digests before any external
outcome; integrity-only profiles use the canonical empty mapping.
Caller-selected broker/trust-root or post-outcome input fields are rejected. The profile
schema must reject raw assignment randomness and claimed randomness-digest fields; those are
authority-DB-only. Reject `active_control` under a shadow profile ceiling,
invalid revision/digests, unknown policy versions,
any safety-pause mode other than mandatory `automatic`, and config drift inside
one revision. Require A/A and shadow to be `integrity_only` and active/control
to be `confirmatory`. Production confirmatory provisioning rejects the draft
`calibration_pending` gate. Task 3 tests exercise the future success path only
through an injected, checked-in synthetic `status=passed` calibration fixture
and test-registry instance; no env, profile, or CLI flag can override the
production registry status or digest.
Include a canonical mapping from authenticated principal
fingerprints to `eligible_host|fixture_pilot`; reject raw API keys, duplicate
fingerprints, unknown classes, missing/invalid collector ID/version, and mapping
or verifier kind/version/config allowlist digest drift. Old profile JSON
remains valid and has no eligible evidence source. Freeze golden vectors for
the versioned tenant/agent/team fingerprint and prove that changing only
credential type preserves it while changing tenant or subject changes it.

**Step 2: Preserve current precedence explicitly**

The current global env override still wins. Global `active` remains
`fixed_active`, but is non-randomized and promotion-ineligible and prevents
profile experiment enrollment. A profile `mode` is an authority ceiling; the
experiment phase controls A/A, shadow, or active/control behavior.

**Step 3: Provision, then implement the pure resolver and assignment**

Add a protected, non-HTTP provisioning command:

```bash
npx tsx scripts/learning-experiment.ts provision \
  --db /absolute/path/to/runtime.sqlite --tenant <tenant-id> \
  --actor experiment-provisioner --operation-id <operation-id> \
  --profile-rule-file /absolute/path/to/canonical-profile-rule.json \
  --memory-namespace-manifest /absolute/path/to/namespaces.json \
  --external-input-set /secure/path/to/preregistered-external-input-set.json \
  --task-family <exact-task-family> \
  --experiment-id <experiment-id> --revision <revision> \
  --out /absolute/path/to/applicability-manifest.json
```

It resolves the code policy registry and tenant-wide collection-principal
bindings. `--memory-namespace-manifest` is required only for `confirmatory` and
is omitted for A/A and shadow. `--external-input-set` is likewise required only
for `confirmatory`; it must contain the exact three role inputs/retry policies
and planned run IDs and is frozen into the revision before any prerequisite
call. For `confirmatory`, it canonicalizes a reviewed,
finite manifest of 384 pairs/768 existing
`resolveTenantScope(...).scope_key` values. Every pair freezes pre-treatment
host-adapter, provider/model route, region, workload stratum, matching digest,
and activation wave/times; wildcard, dynamic, duplicate, unknown, cross-tenant,
unmatched, or post-outcome entries are rejected. It persists all 384 canonical
pair rows including bounded matching-covariate JSON/digests. The current
default-tenant scope encoding must match the database's
append-only Runtime-lineage anchor; an unanchored legacy database with existing
unprefixed memory is never auto-claimed. Public scopes and their fully encoded
store keys share the exact 256 UTF-8-byte bound.
Every revision draws and persists an independent 32-byte diagnostic assignment
seed. Inside a
confirmatory `BEGIN IMMEDIATE`, it separately draws exactly 48 bytes from the operating-system CSPRNG,
maps the 384 bits MSB-first to pairs sorted by pair hash, and assigns exactly one
candidate and one control per bit. It stores the BLOB plus digest and never
hash-ranks, reduces, rejects, or redraws randomness based on arm counts. Exact
retry replays; changed config or manifest conflicts. Concurrent provision
attempts prove one diagnostic seed, one confirmatory bit vector, and one full pair/lease set win. Tests
reject caller randomness, UUID/timestamp/`Math.random` seams, wrong bit order or
entropy length, derivation of one randomness source from the other, and prove
provisioning is the sole generator. Active fixture virtual arms replay from the
diagnostic seed across restart and golden vectors prove they reveal no
confirmatory assignment bit. An unprovisioned
guide never creates assignment randomness and serves control.

The applicability output contains the bounded secret-scanned canonical profile
projection and sorted hashed namespace/pair/wave/lease membership needed to
recompute applicability and pilot disjointness; it omits raw store scopes,
assignment randomness/bits, and arms. Tests independently regenerate the exact
bytes from the DB, including matching-covariate digests sourced from persisted
pair rows.
For `confirmatory`, the command atomically inserts the immutable revision, its
single task-family/candidate-implementation confirmatory-attempt row, and the
complete active lease set before any exposure. It rejects an existing active
namespace lease, partial membership, a version alias of a spent implementation,
a second attempt, task-family/revision reuse, or a revision that already has an
exposure. The namespace-set, pair-manifest, activation-schedule digests/counts
and planned arm counts must match revision, attempt, leases, and applicability
manifest exactly. Gate-policy v1 accepts only 50/50 confirmatory allocation,
three frozen waves of 96/96/192 pairs, and cumulative checkpoints of
96/192/384 pairs, of which only 192/384 are formal looks.
It also requires the registered gate's embedded prospective-calibration
artifact and freezes its SHA into the revision; pending/missing/non-passing or
digest-drifted calibration aborts with zero revision/attempt/pair/lease rows.
At a wave deadline, a namespace with no qualifying exposure/outcome remains
missing; it is never replaced. An `eligible_host` confirmatory guide without the
exact attempt, namespace membership, pair/wave assignment, and lease serves
control. A `fixture_pilot` may exercise both arms only through its distinct
assignment namespace on a store scope outside every active production lease;
it is always promotion-ineligible. V1 rejects unequal active allocation and
allocation-ramp revisions; assignment and wave schedule are frozen for the sole
confirmatory attempt.

Before inserting any active pair, provisioning scans the authority DB for
historical A/A, fixture, unverified, or other-experiment lineage touching either
namespace, including linked memory nodes/commits, source-task/source-event, and
assignment aliases. Any such hit rejects the complete set; no “lease begins
now” exception can launder diagnostic state into the online population.
Legitimate pre-treatment production nodes/commits are allowed and their bounded
prior snapshot/covariates are frozen in the pair record; drift fails integrity.
Tests race A/A/provision, inject every forbidden lineage kind, preserve a valid
production prior, and require zero revision/attempt/pair/lease rows on conflict.

Require task family, task signature, protected operation, and complete
projection for enrollment; `eligible_host` additionally requires exact active
lease membership. Derive `memory_namespace_sha256` from
the existing canonical store scope (`resolveTenantScope(...).scope_key`) and
derive the assignment unit only from tenant plus that namespace digest. A
repository, task signature, task family, call, or run can never split one
namespace across arms; those fields remain provenance/breadth only. Persist and
replay both independent server-confidential randomness sources in the authority DB, add a distinct
principal-specific fixture assignment namespace, expose only digests, and
prove guide/flight/eval outputs cannot leak it or use fixture arms to predict
eligible arms. For confirmatory traffic, fixture calls on an actively leased
namespace are rejected and two concurrent experiments cannot acquire the same
namespace. The route already resolves
`AuthPrincipal`; pass it to the guide service and derive
the collection fingerprint/class/collector contract from the immutable mapping.
Require `host_task_envelope_v1` for eligible-host enrollment, bind it into the
protected request before resolving the frozen lease assignment, and reject
arm/bit/pair/randomness/class claims in the body. Reconcile
context/packet/state/envelope into one canonical
task identity and fail-control on disagreement; keep branded public scope for
receipts/operations/episodes and store scope only for nodes/commits. Auth-off or unmapped principals are `unverified`;
`fixture_pilot`, `unverified`, and legacy calls may exercise serving but are
promotion-ineligible.

Add a protected close command with no HTTP route:

```bash
npx tsx scripts/learning-experiment.ts close \
  --db /absolute/path/to/runtime.sqlite --tenant <tenant-id> \
  --actor experiment-closer --operation-id <operation-id> \
  --approval /secure/path/to/learning-experiment-close-approval.json \
  --experiment-id <experiment-id> --revision <revision>
```

It verifies the bounded HMAC-approved `LearningExperimentCloseApprovalV1`,
recomputes attempt/revision/namespace membership and the current event head,
then claims the global `lite_learning_authorization_nonces` row, inserts the
append-only closure and protected `learning_experiment_close_v1` operation
receipt, attests that receipt with the configured active Runtime authority key,
and releases the entire lease set in one `BEGIN IMMEDIATE`. Nonce,
closure, receipt, and every lease transition commit or roll back together. The closure seals eligible evidence for that
attempt; late feedback remains attributable/safety-relevant but diagnostic.
Exact retry replays; invalid/replayed nonce, changed approval, partial release,
arbitrary release ref, or membership drift rolls back everything. A terminal
signed promote/demote/retire adjudication may release the same full set in its
authority transaction. A later acquisition requires a new lease generation and
a materially different implementation-contract digest. Tests prove close makes
`status` report `closed` and makes propose/reserve/evaluate plus new eligible
exposure fail closed while late feedback remains attributable and diagnostic.
The approval key may rotate out after a successful close only when the
receipt-attestation key remains retained; losing that verification key makes
historical close integrity and replay fail closed.

**Step 4: Run and commit Task 3.0A**

```bash
npx tsx --test scripts/ci/lite-config-posture.test.ts \
  scripts/ci/lite-runtime-config.test.ts
npx tsx --test scripts/ci/lite-learning-episode-contract.test.ts \
  scripts/ci/lite-learning-experiment-resolver.test.ts \
  scripts/ci/lite-learning-episode-store.test.ts
npx tsx --test scripts/ci/lite-product-facade-route.test.ts \
  scripts/ci/lite-product-services.test.ts
npm run -s typecheck
git add src/config.ts src/config/runtime-config.ts \
  src/app/runtime-services.ts src/runtime-entry.ts src/server/http-server.ts \
  src/routes/product-facade.ts src/product/product-services.ts \
  src/product/guide-service.ts src/memory/learning-episode-ledger.ts \
  src/memory/learning-experiment-resolver.ts \
  src/store/lite-learning-episode-ledger.ts \
  scripts/ci/lite-config-posture.test.ts \
  scripts/ci/lite-runtime-config.test.ts \
  scripts/ci/lite-learning-episode-contract.test.ts \
  scripts/ci/lite-learning-experiment-resolver.test.ts \
  scripts/ci/lite-learning-episode-store.test.ts \
  scripts/ci/lite-product-facade-route.test.ts \
  scripts/ci/lite-product-services.test.ts \
  docs/architecture/runtime-complexity-budget.json \
  docs/plans/2026-07-13-learning-episode-ledger.md
git commit -m "feat(learning): fail-control immutable experiment resolution"
```

Tasks 3.0B and 3.0C add their CLI tests and commit only after their respective
atomic mutation boundaries are implemented; they are not folded into the 3.0A
commit merely to satisfy the original monolithic file list.

For completed Task 3.0B/3.0C, run the protected provisioning, confirmatory and
close multi-process suites, resolver/store close semantics, configuration
posture, and typecheck:

```bash
npx tsx --test scripts/ci/lite-learning-experiment-cli.test.ts \
  scripts/ci/lite-learning-experiment-confirmatory.test.ts \
  scripts/ci/lite-learning-experiment-close.test.ts \
  scripts/ci/lite-learning-experiment-resolver.test.ts \
  scripts/ci/lite-learning-episode-store.test.ts
npx tsx --test scripts/ci/lite-config-posture.test.ts \
  scripts/ci/lite-runtime-config.test.ts
npm run -s typecheck
```

### Task 3.1: Add guide operation identity and exact response replay

**Files:**

- Modify: `src/product/product-services.ts`
- Modify: `src/product/guide-service.ts`
- Modify: `src/routes/memory-context-runtime.ts`
- Modify: `src/memory/tools-select.ts`
- Modify: `src/store/lite-write-store.ts`
- Modify: `src/sdk.ts`
- Sync/modify: `../aionis-sdk/src/index.ts`
- Test: `scripts/ci/lite-product-facade-route.test.ts`
- Test: `scripts/ci/lite-learning-experiment-resolver.test.ts`
- Test: `scripts/ci/lite-sdk-client.test.ts`
- Test: `scripts/ci/lite-sdk-guide-agent-context.test.ts`
- Test: `../aionis-sdk/test/sdk.test.ts`

**Step 1: Write failing route tests**

Use real product service assembly and file-backed SQLite:

- same `operation_id` and request returns the same `guide_trace_id` and exact
  agent context;
- same operation ID with a changed request returns 409;
- commit-before-response retry does not add another guide receipt or exposure;
- the early replay check occurs before planning/verifier/embedding work, while
  an inside-transaction recheck makes concurrent same-operation calls execute
  one mutation and one canonical receipt;
- missing operation ID remains compatible but is promotion-ineligible;
- experimental active request without operation ID serves control;
- a canonical guide response above 2 MiB returns 413 with zero mutation.

**Step 2: Run the focused tests**

```bash
npx tsx --test --test-name-pattern="guide operation|learning episode" \
  scripts/ci/lite-product-facade-route.test.ts
```

Expected: FAIL.

**Step 3: Add `operation_id` to `ProductGuideRequest`**

Use the same 1-to-256-character normalization rules as product observe. Add it
to the typed `AionisGuideRequest` and SDK guide helpers, and compute the request
digest from the normalized request before guide persistence. Add the optional
strict `host_task_envelope_v1`; it is mandatory only for promotion-eligible
host enrollment and is included in that digest. Unknown collection/assignment
fields remain rejected by the existing strict request schema.

**Step 4: Refactor guide response construction**

Mirror observe's double-check: read the protected operation receipt before
calling guide planning, verifier commands, embedding, or any provider; then
recheck request digest under `BEGIN IMMEDIATE` before mutation. Exact early
replay returns without repeating external work, and changed request conflicts
before planning. Keep the transaction recheck for concurrent races.

Prepare the exact product response before commit so the shared transaction can
store it in `lite_runtime_write_operations` with operation kind
`product_guide_v1`. On replay, return that receipt; do not rebuild context from
current memory state. Enforce the 2 MiB UTF-8 canonical receipt bound before
opening the write transaction; store only the already-redacted response.

**Step 5: Run tests**

```bash
npx tsx --test --test-name-pattern="guide operation|learning episode" \
  scripts/ci/lite-product-facade-route.test.ts
npx tsx --test scripts/ci/lite-sdk-client.test.ts
npx tsx --test scripts/ci/lite-sdk-guide-agent-context.test.ts
npm run -s typecheck
```

Expected: PASS.

**Task 3.1 completion (2026-07-14):** caller-supplied guide operation IDs now
bind the normalized, identity-resolved request to one canonical
`product_guide_v1` response. The service performs an indexed replay/conflict
read before planning and a second read under the shared `BEGIN IMMEDIATE`
transaction before persisting the exposure node, tool decision, guide receipt,
and operation receipt. Fresh and replayed HTTP responses are both parsed from
the same canonical JSON, survive a lost first response plus database reopen,
and retain the same guide trace and agent context. Protected responses above
2 MiB fail before any Runtime persistence; real planning tool decisions are
prepared outside the transaction and persist only for the winning under-limit
operation. Missing operation IDs remain compatible, write no protected receipt,
and cannot satisfy experiment enrollment; projection remains deliberately
incomplete until Task 3.2. Runtime and standalone SDK guide/role helpers expose
and preserve the operation ID and strict versioned host-task envelope, while
legacy calls never receive an SDK-generated operation identity.

### Task 3.2: Persist experiment, exposure event, and items with the guide receipt

**Files:**

- Modify: `src/product/guide-service.ts`
- Modify: `src/memory/learning-episode-ledger.ts`
- Modify: `src/memory/learning-experiment-resolver.ts`
- Modify: `src/memory/product-output/operator-projections.ts`
- Modify: `src/store/lite-learning-confirmatory-authority.ts`
- Modify: `src/store/lite-learning-episode-ledger.ts`
- Create: `src/store/lite-learning-guide-exposure.ts`
- Modify: `src/store/lite-write-store.ts`
- Test: `scripts/ci/lite-atomic-write-uow.test.ts`
- Test: `scripts/ci/lite-admission-policy-active-projection.test.ts`
- Test: `scripts/ci/lite-learning-episode-contract.test.ts`
- Test: `scripts/ci/lite-learning-episode-store.test.ts`
- Test: `scripts/ci/lite-product-facade-route.test.ts`

**Step 1: Add a failing atomic-unit test**

Inject a `before_commit` fault and assert zero rows in memory commits/nodes,
guide receipts, episode events/items, and operation receipts. Then run without
the fault and assert all appear.

**Step 2: Preserve pre-candidate decisions**

Define `recordedAction` as the current generic/safety projection immediately
before admission-candidate projection. Before applying any candidate surface,
capture:

```ts
recordedAction
candidateAction
servedAction
frozenPriorState
learningTrack
policyChanged
hardBoundaryPreserved
```

Check decision completeness against the full relevant-memory ID set. If the
current 96-item projection bound truncates decisions, mark incomplete and serve
control. Batch-load prior state for every relevant memory across all recorded
actions. Missing/invisible nodes, lookup errors, and omitted items are distinct
incomplete reasons; never convert a swallowed lookup failure or `{}` into
`no_prior`. The 96-item cap may remain on an operator display only, not on the
enrolled item ledger.

**Step 3: Extend `persistGuideExposure` transaction**

Resolve/reverify the already-provisioned candidate/gate policy versions and
experiment revision without creating or changing its assignment randomness, then insert the
exposure event, exposure items, and operation receipt
after the memory-write persist and guide receipt, before
commit. For `active_control`, rederive the canonical store-memory namespace and
recompute the direct pair-bit mapping, then require it to equal the immutable
lease's pair/member/arm/wave assignment. For `eligible_host`, recheck exact
namespace-set membership plus the same attempt's active lease and confirm
server `recorded_at` is inside the frozen activation/index window **inside this
write transaction**. A concurrent close, missing/released lease, wrong
generation, wrong pair/arm/wave, early/late request, or assignment mismatch
serves control and persists no promotion-
eligible exposure. The `fixture_pilot` path instead requires the namespace to
be outside the production set and every active lease, uses its principal-
specific assignment namespace, and remains promotion-ineligible; it is the
only path used by the disjoint clone pilot. Persist the server-derived collection class, principal fingerprint,
and frozen source-policy digest; reject a body spoof and make only
`eligible_host` promotion-eligible. Persist the bounded canonical host task
envelope and normalized source-task/event fields; enforce tenant/revision-wide
dedupe even when the task family spans public scopes.

For `active_control`, an eligible-host candidate response also requires the
single reserved/consumed/claimed/bound/terminated result root in each preregistered production-shadow,
tool-E2E, and offline paired series to be passing. Missing reservation/ticket-
consumption/claim/supervisor-binding/session-termination/result, either hold
branch, failed, inconclusive, mismatched,
successor/branch, or stale bindings
serve control; fixture pilots remain available. Add before/inside-
transaction tests so artifact changes cannot race candidate serving. Runtime
integrity is generated and frozen at each checkpoint, not used to unlock
initial traffic.

Read and verify the latest authority-bearing gate fold before response
construction, then re-read it inside the transaction. Fold
pause/demote/retire across every revision of the same task-family candidate
implementation contract with safety precedence; a version alias, new
allocation, or revision cannot bypass quarantine. Any safety row, digest error, or read failure serves control so
feedback safety-stop cannot race a new candidate exposure.

**Step 4: Run tests and commit the phase**

```bash
npx tsx --test scripts/ci/lite-atomic-write-uow.test.ts
npx tsx --test scripts/ci/lite-product-facade-route.test.ts
npm run -s typecheck
git add src/product/product-services.ts src/product/guide-service.ts \
  src/sdk.ts \
  src/memory/product-output/operator-projections.ts src/store/lite-write-store.ts \
  src/store/lite-learning-episode-ledger.ts scripts/ci/lite-atomic-write-uow.test.ts \
  scripts/ci/lite-product-facade-route.test.ts scripts/ci/lite-sdk-client.test.ts \
  scripts/ci/lite-sdk-guide-agent-context.test.ts
git commit -m "feat(guide): persist protected learning exposures"
```

**Task 3.2 completion (2026-07-14):** guide now freezes the complete recorded,
candidate, and served decision set before candidate projection, batch-loads prior
state for the full relevant-memory set, and keeps missing, invisible, failed, and
omitted prior decisions as distinct fail-control reasons. The 96-item bound is
display-only; enrolled ledger membership and its recorded/candidate/served
surface digests are unbounded up to the contract limit. Exposure payloads carry
an explicit served arm, canonical relevant-memory membership, projection
completeness reasons, and the exact frozen prior/track fields for every item.

Protected guide persistence now prepares canonical candidate, control, and
authority-changed control receipts before opening the shared write transaction.
Inside that transaction it repeats operation replay detection, re-reads
experiment/safety/lease authority with the same server `recorded_at` later used
by the event, and permits only monotonic serving: an unchanged resolution keeps
its prepared arm; every drift selects control. Memory commit/node, deferred tool
decision, guide receipt, exposure event/items, and operation receipt commit or
roll back together. An unsafe authority recheck failure or active-lease identity
conflict still returns the prepared baseline control response but deliberately
adds no learning exposure rather than reusing a stale lease. A closed experiment
or unresolved frozen assignment follows the same terminal no-append rule: the
baseline guide response, memory commit, guide receipt, and protected operation
receipt remain auditable, but no unbound event is appended to the former
matched-pair namespace. Exact replay and a lost first response return the
original canonical receipt without duplicating any row.

That terminal rule is structural rather than dependent on reason ordering: a
confirmatory matched-pair profile without its exact active assignment and lease
cannot append an exposure after close, lease release, demotion, or retirement,
including when authority changes between the pre-read and `BEGIN`. A safety
pause with the exact active lease still records a bound served-control exposure;
pause followed by close/release does not. Integrity-only diagnostics remain
appendable and promotion-ineligible, so the terminal guard does not erase the
evidence needed to explain a fail-control decision.

Promotion-eligible guide events now require database-verifiable source roots,
not merely payload hashes. The append path and restart semantic replay both bind
the exact guide receipt and canonical ledger, memory commit input digest, the
commit scope's memory-namespace digest, one Runtime evidence node carrying that
ledger, and the protected `product_guide_v1` operation receipt with matching
request, commit, policy, arm, and agent surface. Guide persistence writes the
protected operation receipt before the learning event in the same transaction,
so missing, forged, mismatched, or later-corrupted roots fail closed while a
downstream event failure still rolls every root back.

The root proof also binds the served surface itself. The four served action
arrays must be mutually exclusive; their union must exactly equal both the
payload relevant-memory set and the persisted episode-item set; and every item
must carry the action of the array that served it. The canonical guide ledger
and operation agent context share one exact `memory_ids` projection, which may
be a legitimate compact subset of that served union but can never contain an ID
outside it. Append-time validation and restart replay enforce the same relation,
closing both cross-surface substitution and post-commit root-tampering paths.

Promotion eligibility is now positive-authorized rather than inferred from the
absence of known blockers: only the exact `confirmatory_active_lease` plus
matching served-arm success tuple can enter formal evidence. SQLite triggers,
append-time isolation, and restart replay enforce two mutually exclusive lanes:
an in-window promotion-eligible formal arm, or an explicit served-control,
promotion-ineligible fallback. Early and late exact-bound requests therefore
persist auditable control exposures, while a candidate-shaped fallback is
rejected even inside the activation window.

Because this task strengthens the existing active-lease trigger, the Runtime
write schema is versioned as v4. An existing v3 database upgrades only when its
complete v3 contract, including the exact legacy trigger, is intact. The trigger
replacement, v4 shape and semantic checks, preservation counts, and metadata
update share one `BEGIN IMMEDIATE` transaction. Missing, substituted, hybrid, or
partially migrated triggers remain incompatible; process death exposes either
the complete old v3 authority or the complete new v4 authority, never a mixed
state.

Schema identity checks use a shared SQLite-aware SQL normalizer across runtime
preflight, migration, and ledger restart verification. It ignores only legal
exterior formatting and SQLite whitespace outside tokens, folds ASCII keywords
only, and preserves quoted literals, identifiers, comments, and token
boundaries. Table, index, partial-index, and trigger definitions are compared as
complete statements, so literal edits, Unicode lookalikes, non-SQLite
whitespace, or a fake `WHERE` hidden in a comment cannot be normalized into a
valid v3 or v4 contract.

The three preregistered external passing roots are intentionally not fabricated
in this task. Current generic authority insertion cannot legally establish the
signed claim, supervisor-binding, termination, and result lineage required for
restart verification, and the production external-policy registry remains
unregistered. Consequently an `eligible_host` `active_control` assignment stays
fail-control with `external_prerequisite_roots_unavailable` until the protected
Task 8 ingestion and restart-verifier workflow exists. Fixture-pilot diagnostic
traffic remains available and promotion-ineligible; direct SQL is not an
accepted substitute for the missing authority chain.

## Phase 4: Atomic memory feedback attribution

### Task 4.1: Preserve guide identity and validate served surface

**Files:**

- Modify: `src/product/product-services.ts`
- Modify: `src/product/lifecycle-service.ts`
- Modify: `src/memory/lifecycle-lite.ts`
- Modify: `src/memory/node-feedback-state.ts`
- Modify: `src/store/lite-learning-episode-ledger.ts`
- Modify: `src/store/lite-write-store.ts`
- Modify: `src/store/write-access.ts`
- Create: `src/jobs/unused-exposure-learning-control-worker.ts`
- Create: `scripts/learning-host-receipt.ts`
- Modify: `src/runtime-entry.ts`
- Modify: `src/server/bootstrap.ts`
- Modify: `src/sdk.ts`
- Test: `scripts/ci/lite-product-feedback-closed-loop.test.ts`
- Test: `scripts/ci/lite-sdk-client.test.ts`
- Create: `scripts/ci/lite-unused-exposure-learning-control-worker.test.ts`
- Create: `scripts/ci/lite-learning-host-receipt.test.ts`
- Modify: `scripts/ci/lite-source-scope.test.mjs`

**Step 1: Write failing tests**

Cover:

- activation payload receives `guide_trace_id`/episode ID;
- feedback without `guide_trace_id` remains a legacy domain mutation, appends no
  episode attribution, normalizes verifier `unknown` to `NULL`, and reports
  `learning_attribution_status=not_attributed`;
- used memory must have an exposure item;
- reported `use_now` against served inspect becomes `boundary_ignored`;
- unused exposure is not negative;
- exploration negative leaves the original item explore and makes the next
  exposure exploit;
- same protected feedback retry does not increment counters twice;
- boundary ignored rolls back feedback, inspect posture, and safety stop
  together under fault injection;
- every automatic stop also rolls back/replays its deterministic internal
  `learning_gate_authority_v1` receipt independently of the feedback operation
  receipt; wrong scope/kind/trigger digest fails verification;
- after successful boundary feedback, the next guide observes `pause` and
  serves control even if the profile remains active;
- changing allocation, experiment revision, or candidate version alias with the
  same implementation contract cannot escape pause; active serving requires a
  materially different registry behavior-contract digest;
- feedback revalidates the source exposure's historical namespace lease,
  assignment, and generation; a released lease does not reject late feedback,
  but feedback after a closure remains attributable/safety-relevant and cannot
  reopen the sealed confirmatory attempt;
- eligible-host feedback without a strict receipt is stored only as unverified
  and cannot satisfy gate coverage;
- wrong principal/collector/task/episode/memory/surface/evidence digest,
  unregistered verifier kind/version/config, duplicate subject, generic
  assertion, receipt reuse, and changed retry all fail before mutation.

**Step 2: Add optional operation identity**

Add `operation_id` to activation feedback. Protected feedback is required for
promotion evidence; missing identity stays compatible and unprotected. Update
the typed SDK feedback request/helper in the same change. Add strict SDK
builders/parsers for `host_task_envelope_v1` and `host_use_receipt_v1`; they
canonicalize supplied instrumented evidence but never infer that exposure means
use. `scripts/learning-host-receipt.ts verify` is a read-only conformance check
for a named host adapter manifest. It requires explicit collector ID/version and
`--verifier-policy-sha256`, rejects any unregistered verifier config, and
requires `--out` to write a bounded canonical conformance result whose digest
can be bound into the shadow gate/run bundle. Tests cover missing/mismatched
flags, deterministic output, tampering, and secret/raw-content rejection.

**Step 3: Move the complete direct-feedback unit into one transaction**

The outer unit performs operation replay check, activation mutation, event and
attribution inserts, immediate strong-counter/boundary control, and operation
receipt. Pass `guide_trace_id` through the internal payload and memory commit
diff. The feedback event inherits collection class/principal from the verified
exposure; no feedback field can upgrade evidence eligibility. Revalidate the
receipt against exposure and source-policy digests inside the transaction and
persist its canonical header plus exact per-subject receipt-item digests in the
same transaction. Reopen tests must reconstruct and reverify the receipt from
persisted bytes alone. Legacy feedback with a valid guide remains functional but is
`legacy_unverified` and missing for formal coverage. A strong counter writes
explicit inspect-first memory posture. A boundary
fault also appends `safety_stop/pause_required/pause`; all writes share the
feedback transaction and the guide fold reads the row fail-closed. Derive a
second internal operation ID from trigger kind/ID, canonical task-family
authority scope, candidate implementation-contract digest, and stop-policy digest; insert its
`learning_gate_authority_v1` receipt in the same transaction while preserving
the route's own feedback receipt.

**Step 4: Separate repeated-unused maintenance**

Remove it from the direct outcome path. Enqueue a deterministic
`unused_exposure_learning_control_v1` row in the dedicated
`lite_learning_control_jobs` table inside the feedback transaction. Do not add
a second event type to the associative-link-only `lite_memory_outbox`. Return
only `queued|already_completed`.

Implement a leased, bounded-retry worker under `src/jobs/`, start it from
`src/runtime-entry.ts` with the existing storage poll interval/batch size, and
register shutdown in `src/server/bootstrap.ts` without a new env field. The
worker writes inspect-first posture, protected operation receipt, and job
`completed` status in one shared transaction. Expired leases are reclaimable;
invalid/exhausted jobs become retained dead letters and are never silently
deleted. For an enrolled source episode, terminal dead-letter status and a
candidate-implementation `safety_stop/pause` gate row commit together from reloaded
exposure facts; if the pause cannot commit, the job remains retryable. Guide
also requires the stop's deterministic internal `learning_gate_authority_v1`
receipt in that transaction; the worker operation receipt remains distinct.
Guide continues to read its existing authority fold and never polls the queue. Extend
the source-scope contract so associative and learning-control queues remain
distinct. Test crash/reopen before mutation, after mutation before response,
lease expiry, duplicate drain, dead-letter rollback, and next-guide pause.

**Step 5: Run tests and commit**

```bash
npx tsx --test scripts/ci/lite-product-feedback-closed-loop.test.ts
npx tsx --test scripts/ci/lite-atomic-write-uow.test.ts
npx tsx --test scripts/ci/lite-sdk-client.test.ts
npx tsx --test scripts/ci/lite-learning-host-receipt.test.ts
npx tsx --test scripts/ci/lite-unused-exposure-learning-control-worker.test.ts
node --test scripts/ci/lite-source-scope.test.mjs
npm run -s typecheck
git add src/product/product-services.ts src/product/lifecycle-service.ts \
  src/memory/lifecycle-lite.ts src/memory/node-feedback-state.ts \
  src/store/lite-learning-episode-ledger.ts src/store/lite-write-store.ts \
  src/store/write-access.ts src/jobs/unused-exposure-learning-control-worker.ts \
  src/runtime-entry.ts src/server/bootstrap.ts src/sdk.ts \
  scripts/learning-host-receipt.ts \
  scripts/ci/lite-product-feedback-closed-loop.test.ts \
  scripts/ci/lite-atomic-write-uow.test.ts scripts/ci/lite-sdk-client.test.ts \
  scripts/ci/lite-learning-host-receipt.test.ts \
  scripts/ci/lite-unused-exposure-learning-control-worker.test.ts \
  scripts/ci/lite-source-scope.test.mjs
git commit -m "feat(feedback): atomically persist memory attribution facts"
```

## Phase 5: Atomic tool feedback attribution

### Task 5.1: Refactor tool feedback into prepare/persist/finalize

**Files:**

- Modify: `src/product/product-services.ts`
- Modify: `src/product/tool-feedback-service.ts`
- Modify: `src/kernel/learning-kernel.ts`
- Modify: `src/memory/tools-feedback.ts`
- Modify: `src/memory/tools-pattern-anchor.ts`
- Modify: `src/memory/policy-memory.ts`
- Modify: `src/memory/schemas.ts`
- Modify: `src/store/lite-learning-episode-ledger.ts`
- Modify: `src/sdk.ts`
- Test: `scripts/ci/lite-product-feedback-closed-loop.test.ts`
- Test: `scripts/ci/lite-atomic-write-uow.test.ts`

**Step 1: Write failing partial-write tests**

Force failure after commit-row preparation but before completion. Assert no rule
feedback, aggregate, decision link, pattern/policy mutation, episode event, or
operation receipt survives. Assert a tool attribution uses
`subject_kind=tool_decision`, `used_surface=NULL`, and
`boundary_outcome=not_applicable`.
Assert external reviewer/provider/embedder invocation count is zero while
`transaction.inTransaction()` and exact replay returns the stored final response,
including post-mutation `run_lifecycle`, without repeating preparation.

**Step 2: Add guide and operation identity**

Pass validated `guide_trace_id` from product service into the kernel request.
Add optional `operation_id`; protected identity is required for promotion.
Update the typed SDK request/helper.

**Step 3: Split the function**

Implement conceptual ports:

```ts
prepareToolSelectionFeedback(...): Promise<PreparedToolFeedback>;
persistToolSelectionFeedback(store, prepared): Promise<PersistedToolFeedback>;
finalizeToolSelectionFeedback(prepared, persisted): Promise<void>;
```

External review/provider work runs in prepare. Persist re-reads and validates
decision/rule snapshot digests inside the transaction. Refactor anchor and
policy helpers into pure preparation plus transaction-bound persistence;
embedding in `tools-pattern-anchor.ts` and `policy-memory.ts` runs only through
after-commit/outbox callbacks. Build the final response, including
`run_lifecycle`, before writing the operation receipt. Finalize uses
after-commit callbacks for external effects.

**Step 4: Wrap product feedback in the shared unit of work**

Perform an early operation-receipt replay check before preparation, then recheck
inside one `liteWriteStore.withTx`. Write current tool-learning artifacts,
episode event/attribution, and operation receipt. The event inherits its
collection provenance from the validated guide exposure; a tool-feedback body
cannot supply or upgrade it.

**Step 5: Run tests and commit**

```bash
npx tsx --test scripts/ci/lite-product-feedback-closed-loop.test.ts
npx tsx --test scripts/ci/lite-atomic-write-uow.test.ts
npm run -s typecheck
git add src/product/product-services.ts src/product/tool-feedback-service.ts \
  src/kernel/learning-kernel.ts src/memory/tools-feedback.ts \
  src/memory/tools-pattern-anchor.ts src/memory/policy-memory.ts \
  src/memory/schemas.ts src/sdk.ts \
  src/store/lite-learning-episode-ledger.ts \
  scripts/ci/lite-product-feedback-closed-loop.test.ts \
  scripts/ci/lite-atomic-write-uow.test.ts
git commit -m "refactor(feedback): make tool learning one atomic unit"
```

**Completion note (2026-07-16):** Implemented on Runtime main. Tool feedback
uses early replay, external prepare, transaction-bound persist with an inside-
transaction replay recheck, exact final-response receipt storage, episode
attribution, and after-commit finalize. Task 6.1 had not started at that earlier
checkpoint; its current completion record is below.

## Phase 6: Measurement episode binding

### Task 6.1: Bind verified measurements to episode pairs

**Files:**

- Modify: `src/product/product-services.ts`
- Modify: `src/product/measure-service.ts`
- Modify: `src/store/memory-store.ts`
- Modify: `src/store/lite-skill-candidate-review-store.ts`
- Modify: `src/sdk.ts`
- Test: `scripts/ci/lite-product-facade-route.test.ts`
- Test: `scripts/ci/lite-atomic-write-uow.test.ts`

**Step 1: Write failing tests**

Test:

- verified before/after guide receipts resolve to deterministic episode IDs;
- measurement full-envelope digest binds ID, tenant, scope, source, both
  episodes, existing measurement digest, creator, and canonical creation time;
- manual measurement creates no effect event;
- every protected response has a one-to-one
  `product_measure_receipt_authority_v1` sibling root, including manual and
  insufficient/no-pair measurements;
- `before_commit` or receipt-root insertion fault rolls back measurement,
  primary receipt, authority root, and effect event together;
- protected retry returns the exact stored product response without repeating
  preflight work; changed request under the same operation returns 409;
- early replay plus inside-transaction race recheck produces one measurement,
  effect event, and operation receipt under concurrent retry;
- effect provenance is eligible only when both bound episodes share the same
  eligible-host principal/revision; mixed or body-claimed provenance is
  unverified and promotion-ineligible.

**Step 2: Populate the v3 measurement columns**

Use the nullable `baseline_episode_id`, `after_episode_id`, and `record_sha256`
columns already created and preservation-tested in Task 2.2. Task 6 performs no
schema DDL or version change.

**Step 3: Add measure operation identity**

Add optional `operation_id` to the product and typed SDK contracts; use
operation kind `product_measure_v1`.

**Step 4: Persist measurement and event in one shared transaction**

Check the operation receipt before measurement preparation and recheck it under
the shared transaction. Construct the exact final response before commit and
write its `product_measure_v1` operation receipt and canonical
`product_measure_receipt_authority_v1` sibling root together with the
measurement and effect event; fault injection after any insert rolls the whole
unit back.

Only `runtime_verified` sufficient product traces create `effect_measured`.
The event references the measurement record digest; it does not duplicate the
effect report JSON. Derive collection provenance from the verified episode pair,
never from the measurement body; disagreement conservatively becomes
`unverified`.

**Step 5: Run tests and commit**

```bash
npx tsx --test --test-name-pattern="measure|measurement episode" \
  scripts/ci/lite-product-facade-route.test.ts
npx tsx --test scripts/ci/lite-atomic-write-uow.test.ts
npm run -s typecheck
git add src/product/product-services.ts src/product/measure-service.ts \
  src/store/memory-store.ts src/store/lite-skill-candidate-review-store.ts src/sdk.ts \
  scripts/ci/lite-product-facade-route.test.ts scripts/ci/lite-atomic-write-uow.test.ts
git commit -m "feat(measure): bind verified effects to learning episodes"
```

**Completion note (2026-07-16):** Implemented without schema DDL. Protected
measure requests now replay one canonical `product_measure_v1` response and
persist the measurement, full-record digest, effect event, and operation receipt
inside the shared Runtime transaction. The episode pair and stable host-task
identity come from ledger authority; caller-supplied task or episode attribution
cannot upgrade them. Restart verification replays both measurement digests and
the effect's episode, operation-receipt, and protected positive tool-feedback
bindings. Each protected effect payload binds the SHA-256 of the complete
canonical measure receipt; retry re-loads the immutable measurement, recomputes
the kernel result, and revalidates that receipt through the same effect authority.
Export authority also resolves the exact feedback event/event digest and feedback
operation/receipt digest named by the measurement, with causal order fixed as
feedback at or before measurement at or before effect.

The full-record digest also fixes `created_by` and canonical-millisecond
`created_at`. Every protected operation has exactly one independently checked
receipt-authority sibling, so manual and insufficient/no-pair retries cannot
self-authenticate from their current response bytes. Startup/backup replay
rejects missing, orphaned, duplicated, or mismatched roots. Historical v1
effect payloads that predate `operation_receipt_sha256` remain readable across
restart, but resolve only to `effect_receipt_authority_missing`; the production
builder rejects creating another such row and they can never authorize export.

Every fresh sufficient episode-linked product measurement also carries an exact
`effect_expected_v1` digest marker before its measurement and record digests are
computed. Startup/backup integrity therefore requires one and only one effect
for both protected and unprotected fresh measurements, while unmarked historical
v1 measurements remain compatible. The low-level fresh-effect append path also
requires this marker. Protected no-effect measurements require zero effects. The
operation evidence marker separately makes a protected
measurement the durable third member of the measurement/primary-receipt/sibling-
root one-to-one set, so paired receipt deletion cannot silently create a second
measurement on retry.

Task identity is authority-derived even when the caller omits `task.run_id`:
the guide ledger JSON must match its receipt-table run and consumer columns, and
that verified run must equal both episode runs. Any cross-run disagreement makes
the measurement insufficient and produces no effect.

Legacy or unprotected feedback and measure calls remain observable: they may
produce a sufficient effect when the Runtime evidence itself is sufficient, but
they are promotion-ineligible. Candidate enqueue, promote, and materialize each
re-resolve the exact measurement effect authority in the same Runtime
transaction. The current confirmatory resolver still intentionally fail-controls
eligible-host traffic while external prerequisite roots are unavailable, so this
checkpoint does not claim that a live autonomous promotion loop is enabled.

## Phase 7: Experiment assignment and A/A safety

### Task 7.1: Prove the explicit A/A and shadow serving phases

**Files:**

- Modify: `src/product/guide-service.ts`
- Test: `scripts/ci/lite-admission-policy-active-projection.test.ts`
- Test: `scripts/ci/lite-product-facade-route.test.ts`

**Step 1: Write A/A response-equivalence tests**

Use a reviewed manifest of distinct canonical store scopes—never task or
repository variants inside one scope—with enough stable clusters to produce
both assignments. A single-scope run fails the A/A test instead of passing
vacuously. In phase `aa`, both
arms must return byte-identical normalized served memory surface and
`agent_context` for matched policy inputs while the ledger retains different
assignment facts. Do not compare request-derived `guide_trace_id`, operation
receipt identity, or assignment provenance across distinct clusters; verify
those separately. Restarting the Runtime preserves every cluster's arm.

**Step 2: Write phase-transition tests**

A shadow-ceiling profile permits new immutable `aa` and `shadow` revisions but
rejects `active_control`. Changing phase or allocation under one revision is a
digest conflict; creating a new revision succeeds and does not pool evidence.

**Step 3: Verify current global override compatibility**

Global env `active` continues to serve the current fixed-active behavior, is
labelled `fixed_active/non_randomized`, blocks profile experiment enrollment,
and is promotion-ineligible. It must not be silently changed to control.

**Step 4: Run and commit**

```bash
npx tsx --test scripts/ci/lite-admission-policy-active-projection.test.ts
npx tsx --test --test-name-pattern="A/A|shadow phase" \
  scripts/ci/lite-product-facade-route.test.ts
npm run -s typecheck
git add src/product/guide-service.ts \
  scripts/ci/lite-admission-policy-active-projection.test.ts \
  scripts/ci/lite-product-facade-route.test.ts
git commit -m "test(learning): prove A/A and shadow serving phases"
```

### Task 7.2: Enable bounded shadow then active/control serving

**Files:**

- Modify: `src/product/guide-service.ts`
- Modify: `src/memory/product-output/operator-projections.ts`
- Modify: `src/store/lite-learning-episode-ledger.ts`
- Test: `scripts/ci/lite-admission-policy-active-projection.test.ts`
- Test: `scripts/ci/lite-product-facade-route.test.ts`

**Step 1: Add fail-closed tests**

Incomplete projection, missing operation ID, missing signatures, config drift,
gate-read failure, pause/demote/retire, or hard-boundary upgrade must serve
control and become promotion-ineligible. Global fixed-active compatibility is
tested separately and never enters randomized evidence.

Also provision an active revision with each prerequisite state: missing
reservation, unclaimed reservation, missing terminal root, failed/inconclusive
root, wrong series/config/revision/claim, attempted successor, and three exact
verified passing roots. Eligible-host candidate serving is
allowed only in the last case; fixture pilot remains available throughout.

**Step 2: Apply candidate only to the candidate arm**

Always compute the candidate delta for eligible A/A/shadow evidence. In
`active_control`, mutate only the returned Agent context for the candidate arm;
never mutate stored authority.

**Step 3: Verify response and ledger consistency**

For every item, `served_action` must equal the guide receipt surface. Verify
recorded/candidate/served surface digests.

**Step 4: Run and commit**

```bash
npx tsx --test scripts/ci/lite-admission-policy-active-projection.test.ts
npx tsx --test --test-name-pattern="active control|experiment" \
  scripts/ci/lite-product-facade-route.test.ts
npm run -s typecheck
git add src/product/guide-service.ts \
  src/memory/product-output/operator-projections.ts \
  src/store/lite-learning-episode-ledger.ts \
  scripts/ci/lite-admission-policy-active-projection.test.ts \
  scripts/ci/lite-product-facade-route.test.ts
git commit -m "feat(guide): serve isolated candidate gray arms"
```

## Phase 8: Correct evidence slices and build the gate

### Task 8.1: Correct real-Agent predecision slicing

**Files:**

- Modify: `src/memory/admission-real-agent-rerun.ts`
- Modify: `scripts/e2e/admission-real-agent-rerun.ts`
- Modify: `scripts/ci/lite-admission-real-agent-rerun.test.ts`

**Step 1: Write regression tests for denominator bias**

Prove that selected-memory prior bucket and all-trial denominators can dilute
negative direct-use. Add a predecision policy-affected track fixture whose Agent
selects different memories in the two arms.

**Step 2: Add predecision fields and ITT summaries**

Keep selected-memory slices as diagnostics only. Formal paired checks use
frozen predecision tracks; formal online checks use one outcome per disjoint
store-memory-namespace assignment cluster.

**Step 3: Make the paired rerun genuinely isolated and preregistered**

For **each of the 96 frozen base-task units**, restore two fresh byte-identical
copies of the same Runtime snapshot, run exactly that unit's recorded/candidate
pair, then destroy the mutable copies. Never reuse two long-lived arm databases
across the case set. Tests seed a mutation/safety row in unit 1 and prove unit 2
starts at the original snapshot digest with no carried node, queue, or authority
state. Formal grade requires a genuinely immutable model/runtime snapshot,
deterministic decoding seed/kernel, fixed tool versions, response fingerprints,
and counterbalanced order from the persisted order manifest. A profile marked
`immutable_snapshot=false` or `provider_may_update_weights=true` is diagnostic
only and must force `hold`.

Treat this as a deterministic finite-holdout regression, not an iid or
superpopulation causal estimate. Over the exact 96-case denominator, compare
integer candidate-minus-recorded loss totals: harm and utility-failure must
each be at most +5 percentage points, and the sole preregistered exploit-harm
difference must be at most -2 points. Use integer cross multiplication; do not
emit a sampling confidence interval or offline alpha. Require at least 90%
assessability, but make the formal result use the full-risk-set worst case for
both endpoints: every missing candidate endpoint is loss and every missing
recorded endpoint is no loss. Tests cover candidate-only, recorded-only,
both-missing, endpoint-specific missingness, exact threshold equality, and
prove neither endpoint can pass through selective exclusion. Include external
reservation/ticket-consumption/claim/supervisor-binding/session-termination, immutable
snapshot/case/profile/model/tool/order/retry,
response-fingerprint, exclusion, and raw-bundle digests.

**Step 4: Run tests and commit**

```bash
npx tsx --test scripts/ci/lite-admission-real-agent-rerun.test.ts
npm run -s typecheck
git add src/memory/admission-real-agent-rerun.ts \
  scripts/e2e/admission-real-agent-rerun.ts \
  scripts/ci/lite-admission-real-agent-rerun.test.ts
git commit -m "fix(eval): gate admission on predecision evidence slices"
```

### Task 8.2: Add versioned task-family evidence gate

**Files:**

- Create or merge: `src/memory/learning-evidence-gate.ts`
- Modify: `src/memory/learning-gate-policy.ts`
- Create: `scripts/ci/lite-learning-evidence-gate.test.ts`
- Modify: `src/memory/admission-production-gate.ts`
- Modify: `src/memory/admission-tool-e2e-gate.ts`
- Modify: `scripts/e2e/admission-production-gate.ts`
- Modify: `scripts/e2e/admission-tool-e2e-gate.ts`
- Modify: `scripts/ci/lite-admission-production-gate.test.ts`
- Modify: `scripts/ci/lite-admission-tool-e2e-gate.test.ts`
- Modify: `src/store/lite-learning-episode-ledger.ts`
- Create: `scripts/learning-evidence.ts`
- Create: `scripts/ci/lite-learning-evidence-cli.test.ts`
- Create: `scripts/formal-learning-run-broker.mjs`
- Create: `scripts/ci/formal-learning-run-broker.test.mjs`
- Create: `scripts/learning-gate-calibration.ts`
- Create: `scripts/ci/lite-learning-gate-calibration.test.ts`
- Create: `docs/research/2026-07-13-learning-gate-policy-v1-calibration-scenarios.json`
- Create: `docs/research/2026-07-13-learning-gate-policy-v1-calibration.json`

**Step 1: Write failing gate tests**

Cover:

- gate-policy-v1 exact 50/50 matched-pair assignment, frozen 96/96/192-pair
  activation waves, and cumulative 96/192/384-pair checkpoints: checkpoint 1
  is safety/integrity-only with zero confirmatory spend; formal checkpoints 2/3
  split exact global `1/20` across promotion/demotion directions and two looks
  (`1/80` per direction/look), while the persisted reservation validates the
  versioned schedule instead of hard-coding it in generic DDL;
- only the sole append-only confirmatory-attempt revision for a task-family
  candidate implementation contract can propose/reserve/evaluate; A/A and shadow revisions
  cannot consume or reset alpha, active allocation changes are rejected, and a
  second revision/attempt fails;
- outcome-blind `status/propose-look` uses the frozen wave `analysis_at` and
  exact scheduled pair prefix/event cutoff, a protected reservation freezes it,
  labels can be swapped without changing it, future/operator time is rejected,
  and the same look can never reserve/evaluate a second cutoff;
- exact pair completeness, one-candidate/one-control balance, no randomness redraw,
  and the preregistered paired pre-response availability-imbalance test; a
  binomial SRM test is explicitly rejected for exact-count assignment;
- per-arm scheduled exploit namespace clusters, conclusive outcome counts, and
  90% coverage, with no-index namespaces retained as missing at wave close;
- checkpoint 1 can only hold/pause and can never emit promotion, demotion, or
  retirement readiness; the 96-conclusive-cluster minimum and two-wave minimum
  first become claim-relevant at checkpoint 2;
- +5-point control-relative harm and -5-point accepted-action
  noninferiority;
- unequal 10/90 or 25/75 confirmatory allocation, missing pair members,
  replacements, and post-provision wave edits fail closed;
- earliest eligible index episode plus fixed 24-hour follow-up gives one
  `(store_memory_namespace_cluster, track)` observation per revision; later episodes, late
  feedback, and calendar windows cannot inflate or change the primary unit;
- repositories, task signatures, host task IDs, and repeated guide calls inside
  one canonical store namespace collapse to that one cluster; any scope,
  memory-ID, source-task, or assignment alias across nominal clusters/arms is
  an interference hold and automatic-safety trigger, never extra sample size;
- cohort construction replays the finite namespace/pair/wave digests and exact
  lease generation; every scheduled member enters once, while foreign or
  fixture-overlapped namespaces cannot enter a confirmatory look;
- exact matched-pair finite-population randomization inversion conditions on
  the frozen design without iid Bernoulli assumptions; common provider/calendar
  shocks are allowed, while treatment-dependent shared quota/queue/cache state
  is interference and pauses;
- coverage, paired bounds, and outcomes use the same scheduled pre-outcome risk
  set, and no confirmatory evidence pools across revisions;
- worst-case missing-outcome sensitivity causes `hold`, never automatic pause;
  automatic pause from outcome data requires the exact `1/1000` verified-harm
  lower bound above `1/20` with candidate missing coded no-harm;
- separately preregistered exploration gate;
- formal pause/demotion/retirement thresholds and distinct frozen windows;
  `retirement_ready` is evaluated only after the same checkpoint's cumulative
  `demotion_ready` bit is true and both frozen wave subchecks pass, making it a
  strict hierarchical escalation rather than an independent alpha-spending
  claim;
- a look that is both `demotion_ready` and pause-worthy retains the demotion
  verdict in the pure result plus a separate canonical automatic-safety trigger
  fact; persistence is deferred to Task 9.1;
- offline paired finite-holdout harm difference at most -2 points as the single
  preregistered efficacy regression, with no sampling alpha, confidence bound,
  post-hoc metric selection, or mutable provider; harm and utility each pass
  exact full-risk-set worst-case integer thresholds;
- total 33.3% negative does not contaminate zero prior-aware harm;
- online evidence cannot pass without frozen paired rerun;
- mixed episodes contribute item evidence to both frozen tracks, while legacy,
  fixture-pilot, offline-paired, unverified/auth-off, shadow-only,
  non-randomized, unclassified, and incomplete items are excluded.
- formal online outcomes require a fully reverified `host_use_receipt_v1`;
  spoofed/generic/legacy receipts remain missing for coverage and sensitivity.
- evidence artifact membership order, IDs, and report digests reproduce the
  stored set hash exactly.
- membership resolves the sole external roots and Runtime-integrity head as of
  the preview's artifact cutoff; a later Runtime-integrity reservation preserves
  historical preview replay;
- each external series has exactly one pre-outcome reservation and at most one
  ticket consumption, pre-claim hold, runner claim, launcher-authenticated
  supervisor binding, and signed append-only session termination; every
  consumed reservation has exactly one result, claimed-termination-hold, or
  pre-claim-hold coverage branch; claim freezes supervisor-bind
  TTL, hard expiry, heartbeat, maximum calls, at-most-60-second single-call
  capabilities, and a post-quiesce finalize deadline; normal termination additionally requires the
  signed clean-quiesce receipt, runner-output manifest, and sealed public call
  chain;
  ticket/consumption/preclaim-hold/claim/binding/termination replay,
  crash-after-consumption,
  crash-after-capability-issue, clean-exit/quiesce race, in-flight-call/finalize
  race, heartbeat loss, hard expiry, finalization timeout, unclaimed or
  unterminated result, missing/invalid daemon health/quiesce/call-chain/terminal
  receipt, report-status/output/manifest/attempt-chain mismatch, pass-only
  archiving, successor insertion, post-quiesce credential/provider/mount use,
  same-implementation retry, and offline case-set reuse all fail closed;
  a same-UID thief process cannot obtain the inherited launcher channel or race
  the exact supervisor binding, and every consumed reservation has exactly one
  result, claimed-termination-hold, or pre-claim-hold coverage branch;
- the Runtime-integrity projection and run bundle are outcome-redacted and
  label-permutation invariant; `reserve-look` atomically inserts its passing
  artifact head with the reservation; malformed/wrong caller bindings conflict
  with zero mutation, while a correctly bound actual integrity finding inserts
  neither artifact nor reservation and persists an automatic safety stop;
- content-addressed artifact replay returns the existing row; pure evaluation
  replay returns byte-identical output/ID, while the same artifact ID or report
  digest with changed bound metadata conflicts.
- hard-coded independent-reference golden vectors cover the exact
  finite-population matched-pair dynamic program (zero/all/interior schedules,
  sharp/composite nulls, every margin/look, label/arm symmetry and state-space
  exhaustion); a deliberately separate brute-force oracle exhausts every
  assignment and compatible binary potential-outcome schedule for `n <= 8`.
  A separately written compressed reference enumerator covers `n=9..12`, and
  both must equal the production DP and immutable real-look golden vectors;
- exact `n=96` operational safety vectors cover both sides of `R1=1/20`,
  inclusive equality, missing-as-no-harm, and
  `1000*max_upper_tail_count<=2^n`; `n=192/384` repeat the safety boundary, and
  pinned `n=384` worst-state benchmarks enforce 60 seconds/512 MiB with no
  truncation or approximation;
- prospective calibration cannot read a Runtime DB, ledger snapshot, candidate
  outcome, or checkpoint artifact; it freezes its scenario grid/seed/count,
  reports joint promotion, unconditional/conditional demotion,
  verified-absolute-harm-pause-or-exploit-harm-demotion detection, unrelated
  pause-cause exclusion, diagnostic-only non-exploit harmful endpoints,
  terminal-hold rates, stopping checkpoint and 80%-power MDE; exact one-sided
  Clopper-Pearson rational threshold and rational precision/tie vectors,
  deterministic Philox shards,
  sufficient-statistic lookup equivalence, shard-order/restart invariance, and
  full-grid resource receipts leave the policy `calibration_pending` unless
  every registered threshold passes;
- paired pre-response exact two-sided McNemar/sign golden vectors, inclusive
  ties and `p <= 1/1000`; offline 96-case integer/lattice threshold vectors;
- every CLI subcommand rejects each missing/mismatched required flag from the
  explicit parameter matrix below; no process default selects authority.

**Step 2: Run the test**

```bash
npx tsx --test scripts/ci/lite-learning-evidence-gate.test.ts
```

Expected: FAIL.

**Step 3: Implement a versioned pure gate**

Input is one immutable look reservation, its cutoff-bounded ledger cohort, and
the deterministic heads of preregistered immutable evidence series. The
reservation supplies `analysis_at`; raw time/head input is not accepted.
Output includes descriptive rates, ITT units, coverage, exact finite-population
bounds, sensitivity, evidence grade, all prerequisite checks, and evidence verdict
`hold|promotion_ready|pause_required|demotion_ready|retirement_ready`. The pure
gate never returns an authority action. It may return a separately digested
automatic-safety trigger fact; Task 9.1 is the first task allowed to persist
that trigger with a safety-stop authority row.

Resolve every constant and configuration digest from
`learning-gate-policy.ts`, created in Task 2.1. The statistics implementation
must pass that registry's golden vectors and may not carry a duplicate local
schedule or threshold table.

Implement the architecture's formal finite-population contract verbatim as
deterministic integer dynamic programming over the frozen matched pairs. Define
binary loss, `R1`, `Delta`, `T_R`, and `T_D`; enumerate compatible pair-level
potential-outcome tables; use inclusive lower tails for unsafe upper-threshold
nulls and inclusive upper tails for deterioration; reject exactly when
`80 * max_tail_count <= 2^n` at formal checkpoints 2/3. Compare every `1/20`
margin on the `2n` lattice by integer cross multiplication and record both
confidence-inversion boundary points. Encode promotion/demotion missingness
before inference using their opposite conservative assignments. Reject
floating-point-only tail accumulation, state truncation, iid
Clopper-Pearson/Newcombe substitution, bootstrap/asymptotic substitution, wrong
tail/tie/rejection equality, or disagreement with the independent brute-force
oracle through 8 pairs, the separate compressed reference at 9–12 pairs, and
immutable externally generated vectors at 192/384 pairs.

Implement the two production kernels explicitly, with no pointwise probability
maxima during convolution:

- For absolute risk, with observed candidate loss count `h`, enumerate
  `0<=x<=h` and `0<=y<=n-h`, set `A=x`, `B=h-x+y`, and candidate-risk numerator
  `2A+B=h+x+y`. Under rerandomization
  `T_R=A+Binomial(B,1/2)`. Use exact binomial prefixes/suffixes times
  `2^(n-B)`. Promotion maximizes the inclusive lower tail over
  `20*(2A+B)>2n`. Operational safety maximizes the inclusive upper tail over
  `20*(2A+B)<=2n` and pauses exactly when
  `1000*max_upper_tail_count<=2^n`, with candidate missing coded no-harm, at
  all three `n=96,192,384` checkpoints.
- For the risk difference, let each observed contrast be
  `t in {-1,0,1}` and alternate contrast `u in {-1,0,1}`. Maintain rolling
  boolean feasibility bitsets indexed by `(q,c,E)`, where
  `E=sum(t+u)`, `q=count(|t-u|=1)`, and `c=count(|t-u|=2)`. For each pair and
  each `u=-1,0,1`, OR only the shifted feasibility bit; never merge or maximize
  schedule probabilities. At completion, monotonicity permits the smallest
  feasible `E` above a lower-tail margin or largest feasible `E` at/below an
  upper-tail margin. Compute tails from exact `Binomial(q,1/2)` and
  `2*Binomial(c,1/2)` prefix/suffix sums with factor `2^(n-q-c)`.

All Pascal rows, tail numerators, powers of two, and comparisons are `BigInt`.
The two-buffer feasibility implementation has the architecture's
`O(n^4/word_size)` worst-case work and `O(n^3/word_size)` memory bound. Pin a CI
reference machine and benchmark all-minus, all-zero, all-plus, balanced,
boundary, and worst-missing `n=384` cohorts: each endpoint must finish exactly
within 60 seconds and 512 MiB RSS and produce restart-identical bytes. A
resource failure blocks policy registration; it cannot silently approximate or
convert the result to `hold`.

Implement the pre-response integrity check independently: availability is one
iff an authenticated eligible request arrived within the frozen wave before the
member's first guide response. With discordant counts `b,c`, compute the
two-sided exact McNemar/sign value
`min(1, 2*sum[k=0..min(b,c)] choose(b+c,k)/2^(b+c))`; include ties and fail the
integrity check at `p <= 1/1000`. This causes `hold`, not automatic pause absent
a verified identity/assignment/interference fault.

Implement the prospective calibrator only after the exact engine and independent
oracles pass. It accepts a content-addressed potential-outcome scenario manifest
and a preregistered counter-based seed/count, but no Runtime DB or evidence
artifact. The grid covers boundary nulls, zero effect, reviewed target-safe and
twice-margin harmful alternatives, 90–100% coverage/no-index, matching
correlation, common assignment-independent shocks, hard-boundary rates, and
adversarial missingness. Freeze every scenario as `target_safe`,
`exploit_harm_detection`, or `diagnostic_only`; non-exploit utility/
accepted-action/exploration harmful scenarios cannot become v1 demotion
endpoints. Report joint IUT promotion power at checkpoints 2/3,
unconditional and reached-look-conditional demotion power, automatic-pause,
the specific `verified_candidate_absolute_harm_pause OR
exploit_harm_demotion_ready` harm-detection union, terminal-hold rates,
expected stopping checkpoint, and 80%-power MDE.

The reviewed artifact passes only when every target-safe scenario has final
joint-promotion lower bound at least 0.80 and terminal-hold probability at most
0.20 by its one-sided 99% upper bound. Every `exploit_harm_detection` scenario
requires the lower bound of
`P(verified_candidate_absolute_harm_pause OR
exploit_harm_demotion_ready by checkpoint 3)` to be at least 0.80. Thus a
correct checkpoint-1 effect-triggered safety pause is success for harm
detection, while an integrity/assignment/hard-boundary pause is not. Other
endpoint-harmful scenarios remain diagnostic; adding them to `demotion_ready`
requires a new demotion family and alpha allocation. The analytical
FWER/operational-pause bounds must also equal the registry contract.

Freeze `clopper_pearson_exact_one_sided_v1`. For `k/N` simulated successes, a
required lower bound at 0.80 passes inclusive equality only when
`100*sum[i=k..N] choose(N,i)*4^i <= 5^N`; a terminal-hold upper bound at 0.20
passes only when
`100*sum[i=0..k] choose(N,i)*4^(N-i) <= 5^N`. Use `BigInt` for these authority
comparisons; display quantiles cannot decide registration. Require
precision by rational tails too. For a lower bound set `a=100k-N,b=100N`:
`a<=0` passes; otherwise require
`100*sum[i=k..N] choose(N,i)*a^i*(b-a)^(N-i)<=b^N`. For an upper bound set
`a=100k+N,b=100N`: `a>=b` passes; otherwise require
`100*sum[i=0..k] choose(N,i)*a^i*(b-a)^(N-i)<=b^N`. These are respectively
equivalent to `k/N-L_99<=0.01` and `U_99-k/N<=0.01`; equality passes. The
method/version, tie rule, seed and replication count are preregistered.

Do not call the full gate separately for every replicate. After missingness
coding, canonicalize/deduplicate absolute-risk `h` and contrast
`(n_-1,n_0,n_1)` keys across the grid, compute every unique exact decision once,
and bind the content-addressed lookup table. Use `philox4x32_10_v1` with fixed
counter-range shards; each shard emits integer counts and key/source digests,
and canonical shard-order `BigInt` merge is invariant to worker count/restart.
Compare the batch lookup to the direct production kernel exhaustively at small
n and on sampled 192/384 states. On the manifest-pinned 32-vCPU runner the full
grid must recompute within 12 hours and 32 GiB RSS. Precision, resource, shard,
or replay failure blocks registration; reducing the grid/count or approximating
the gate is forbidden.

Commit the raw shard counts and all code/scenario/seed/config/lookup digests,
then change `gate-policy-v1` from `calibration_pending` to `registered` with that
artifact SHA. If 384 pairs fail, stop: revise the pre-outcome design under a new
policy version instead of tuning from live outcomes. A sample-size change also
requires revising the v3 schema count/bit-length contract before implementation.
The scenario manifest carries the signed pre-exposure review of its scenarios,
thresholds, seed, and replication count. `run` never edits source: after its
deterministic bytes pass review, patch only the resulting artifact SHA and
`registered` status into `learning-gate-policy.ts`, then rerun `verify`. That
verification compares the embedded preregistration engine contract and final
policy-config digest, so the artifact/registry binding has no hash cycle.

**Step 4: Persist external prerequisite reports**

Do not merge the 1000-row broad shadow gate or 40-run tool E2E counts into the
online statistical sample. Before any formal shadow/tool/offline
outcome-bearing or paid call, `reserve-external` freezes the exact series,
revision, implementation/gate, applicability, harness, source snapshot,
case/profile/model/tool/order and bounded retry-policy digests. For offline,
the same transaction stores exactly 96 case identity, task ID,
content/workflow, canonical store-scope, source-event, and source-evidence hashes
and rejects any overlap with every
prior reservation in the tenant/task family, including renamed subsets.
Immediately before pre-claim work, `consume-external-ticket` atomically burns
the raw ticket for the frozen runner and broker-process nonce. Offline sealed
validation runs only after that committed consumption. On success,
`claim-external` binds the consumption, fresh execution nonce, and signed
credential-broker receipt plus the registry-frozen hard expiry, heartbeat,
supervisor-bind TTL, maximum call count, per-call capability TTL, and
post-quiesce finalization TTL.
A crash or mismatch after
consumption cannot consume or claim again: the broker and Runtime append the
signed zero-effects pre-claim hold and forever reject a later claim. After a
claim, `launch-learning-supervisor` uses the deployment launcher to create an
inherited private socket pair for one exact executable/argv and signed
PID/start/cgroup/job identity. Protected `bind-external-supervisor` uses a
fixed-domain, receipt-derived operation ID and commits the sole binding before
formal single-call capabilities or the read-only holdout mount are enabled. A
same-UID process has neither the inherited descriptor nor the signed process
tuple and cannot race first attachment. Before it exits, a normal runner must
broker-quiesce: reject new calls, reconcile every in-flight call, seal its
signed public attempt chain and immutable runner-output manifest, revoke
provider/mount access, and receive a signed quiesce receipt. Offline gate work
then runs without provider authority. The daemon survives the invoking shell;
it distinguishes acknowledged clean quiesce from crash, signs the sole terminal
receipt on normal finalize or abnormal timeout/crash/revoke, and Runtime appends
the matching session-termination fact before a result can be ingested.

Add ingestion that validates, canonicalizes, caps at 512 KiB, and stores the
first complete paired-rerun, broad-shadow, and tool-E2E result with its exact
reservation, ticket consumption, claim, supervisor binding, signed session termination,
broker health/quiesce/public-attempt-chain/terminal receipts,
raw-bundle digest, and
immutable source ref. `passed`, `failed`, and `inconclusive` are all sealed,
archived, verified, and ingested before continuation is decided. External
successors are forbidden. A missing result blocks activation; a non-passing
result burns the implementation attempt. Recovery requires a materially
different implementation digest, fresh attempt/series/reservations, and for
offline, a fresh disjoint case set; revision/run/seed aliases cannot repair it.
Runtime-integrity is deliberately different: its same-revision passing heads
advance only as the atomic checkpoint-1/2/3 reservation chain, with exact
`look_index + 1` and proposal binding; generic ingestion cannot add or repair
one. Gate replay never depends on a mutable path alone.

**Implementation checkpoint (2026-07-17, Task 8.2C-1):** The first external-
result batch intentionally stops before CLI or database mutation. It adds the
strict pure contracts in `src/memory/learning-external-evidence.ts` for the
three formal report kinds, exact offline missingness contingencies with
deterministic fixed-risk and pair-coverage derivation, production-shadow and
exact-40 tool facts, attempt chain, runner-output manifest, terminal manifest,
live-DB lifecycle-authority comparison projection, run-bundle manifest,
content identity, canonical JSON parsing, and cross-contract digest/time
validation. Report status and reason codes are derived from bounded facts,
with observed failures taking precedence over incomplete-only authority;
`passed`, `failed`, and `inconclusive` are all representable terminal results.
The content graph is deliberately acyclic: report/source/attempt facts form a
pre-terminal payload-set digest, the runner-output manifest commits that set,
the terminal manifest commits the runner output, and the signed termination
commits the terminal manifest. Git/archive commit IDs are added only by the
later ingest request and operation receipt, never inside bytes they identify.

**Implementation checkpoint (2026-07-17, Task 8.2C-2):** The protected store
kernel now closes the fail-closed gap left by C-1. The new public-run-authority
contract carries the complete reservation/holdout, consumption, claim,
supervisor-binding, and normal-termination rows; their five protected operation
receipts; and the report, attempt chain, runner-output manifest, terminal
manifest, and lifecycle projection. A registered service launcher signs the
broker launch, the revision-frozen broker signs health and terminal-fact drain,
and the acyclic outer authority binds the pre-drain payload without a digest
fixed point. The validator verifies those signatures against the frozen
launcher/broker policy, binary, key, and database lineage and compares every
declared row, ID, operation, holdout member, and projection exactly with the
live protected lifecycle.

The dedicated store access accepts only the ingest request, complete public
authority, run-bundle manifest, and fresh audit time; it does not accept
caller-supplied lifecycle fragments. In one shared-transaction savepoint it
appends the external evidence row, reads the actual artifact and unique
series-head `row_id`, builds a bounded non-self-referential post-transaction
projection, and appends `learning_evidence_ingest_v1` under the already
append-only protected operation scope. The receipt persists the complete
public authority and run-bundle manifest, binds the request/archive/commit,
and stores `request.bundle_commit_id` in the operation `commit_id`. Exact retry
returns the first row and receipt byte-for-byte and deliberately ignores a new
retry wall clock; changing actor or any content/request binding conflicts.

The same read-only validator runs at reopen/integrity/backup time and enforces
a bidirectional operation-to-artifact mapping, exact content identity, live
lifecycle signatures, and actual artifact/series-head row IDs. Artifact-only,
operation-only, duplicate, stale-series, and mutated-prefix states fail closed.
The former blanket external-row rejection was removed only after this verifier
was wired. Generic `insertAuthorityFact` remains closed for all evidence rows,
and this checkpoint does not add the public `ingest` CLI.

**Implementation checkpoint (2026-07-17, Task 8.2C-3):** The caller-path gap is
now closed. A deterministic length-prefixed binary envelope carries the exact
canonical run-bundle manifest followed by raw members in manifest order. The
verifier never extracts a path, streams the outer archive and every member in
fixed-size chunks, independently recomputes `run_bundle_archive_sha256`, and
fully parses only the six bounded structured roles. It rejects noncanonical
JSON/UTF-8, path aliases, missing/extra/duplicate/reordered members, truncation,
trailing bytes, length or digest drift, and any structured member that differs
from the signed public-authority copy. A module-owned WeakMap proof binds the
raw archive digest/length, canonical manifest digest, public-authority digest,
and evidence-binding digest; a same-shaped caller object has no authority.

The secure reader pins the archive and independent public-authority equality
witness with `O_NOFOLLOW | O_NONBLOCK`, verifies owner/mode/link count and
nanosecond file identity before and after streaming, and keeps both descriptors
open through the database transaction. It fixes one Git `HEAD`, verifies the
repository object format, regular `100644` tree entries, and the actual Git blob
OID computed from the pinned bytes. `bundle_commit_id` is the latest ancestor
commit that changed either tracked file; both blob OIDs must be identical at
that commit and at the fixed head, so an unrelated later commit does not break
exact replay. Worktree/git-dir/common-dir, `HEAD`, refs, and objects must also be
owner-controlled and ACL-safe before and after resolution; alternates, grafts,
local config includes, redirected control paths, or delegated writers fail
closed. Linked worktrees and native SHA-1/SHA-256 repositories are covered. The
formal input is a dedicated quiescent evidence repository with an 8,192-path,
16-level metadata traversal ceiling. A second opaque prepared capability binds
this Git proof to the specific archive proof by object identity.

The store's fresh and replay paths now require that prepared capability and
recheck every proof/request/public/manifest/archive/commit binding internally;
CLI-only validation cannot be bypassed by another in-process caller. The
production service completes archive/Git work before opening SQLite, pins an
already-existing current Runtime database and trusted WAL/SHM boundary, then
acquires `BEGIN IMMEDIATE` with bounded busy retry. A private issuer yields an
opaque capability bound to the exact protected database and current transaction
identity; the general ledger exposes no ingest method, and an architecture gate
keeps the wrapper/factory composition service-only. Only under that writer lock
does it create the ledger access, run the full integrity/live-lifecycle replay,
derive first-ingest audit time, and append the artifact plus protected operation.
It never migrates, initializes, or uses a concurrent read connection. Any
failure after the transaction runner returns is reported as committed and
retry-safe instead of being mistaken for a rollback.

`scripts/learning-evidence.ts ingest` is the internal formal operator entry.
It accepts only the documented identity plus absolute database, archive,
public-authority, and output paths; the database/sidecar/input/output collision
matrix is checked before service entry and again after commit, using the
database realpath for all three SQLite sidecars. Receipt output uses a
service-owned `0600` temp, complete owner/root ancestor and ACL checks, file and
directory fsync, and a hard-link no-replace publish. A pre-existing output is
accepted only when it is a safe single-link `0600` regular file with
byte-identical canonical receipt content. An interrupted two-link publish is
recovered only from the unique marker temp with the same inode, owner, mode,
ACL, length, and bytes, followed by unlink and directory fsync. If SQLite
committed but output publication or service cleanup failed, the command reports
`committed=true` and requires the same operation ID; retry replays the first
receipt and audit time byte-for-byte. Real filesystem/Git and file-backed WAL
tests cover proof forgery, dirty/untracked inputs, symlink/hardlink/FIFO and ACL
boundaries, writer contention, process death before/after commit and during
receipt publication, output conflict recovery, and reopen after the evidence
repository is removed. Aggregate attestation and release-verdict authority
remain owned by the later Task 8.2D/E batches.

**Implementation checkpoint (2026-07-17, Task 8.2D-1):** The first aggregate-
attestation batch freezes the pure evidence contracts without yet granting a
process authority to emit them. `learning-external-ingestion-attestation.ts`
defines strict canonical required-series status and terminal-coverage indexes
for the fixed offline-paired, production-shadow, and tool-E2E roles. Every role
is exactly one of `result`, `termination_hold`, `preclaim_hold`, or `unstarted`;
hold and unstarted branches carry explicit zero artifact, ingest-operation, and
current-head counts. The zero-result case is therefore a canonical three-role
projection with the digest of an empty result tuple, not omitted evidence.

The deterministic aggregate projection binds the registered four-series map,
revision and policy digests, database lineage and launcher DB-binding receipt,
the canonical status and coverage digests, every result's C-3 artifact,
operation, current-series-head, public-authority, archive, and Git identities,
and a whole-authority head. Authority-head v1 freezes the complete v4 column
order and primary key of 22 append-only learning tables plus all operation rows
in `learning_external_authority_v1`; its typed NULL/text/integer/blob frames use
an unambiguous u64be length prefix. The signed Ed25519 envelope is separate from
the replay-stable projection and trusts only the attestor key frozen in the
registered revision, after recomputing the complete external-execution-policy
digest. It binds the projection, DB-binding receipt, and authority-head digests
plus frozen attestor/launcher identities and attestation time.

This checkpoint is D1, not the complete D authority. D2 must still reconstruct
the projection and streaming head from the real v4 database, and D3 must run
that projector inside the launcher-held deployment lease against an inherited
descriptor after WAL checkpoint/truncation, using a private signer channel.
The existing external-head CLI fence therefore remains fail-closed. Task 8.2D
ends at a signed factual aggregate; Task 8.2E alone may interpret that aggregate
with the archived acceptance root and produce a release verdict. No D1 contract
contains `release_verdict`.

**Implementation checkpoint (2026-07-17, Task 8.2D-2):** D2 now has the real
same-snapshot database reconstruction layer, but still no signer or enabled
external-head command. The fixed-manifest reader requires current v4 and one
unchanged active Runtime transaction, reads TEXT/INTEGER from raw SQLite bytes,
rejects invalid UTF-8, REAL/unsafe integers, and same-byte non-TEXT external
scope aliases, and streams the 22 authority tables plus the entire external
operation closure into the D1 authority head.

The projector is anchored only by tenant and confirmatory-attempt ID. It
rederives revision/policy/series bindings, classifies only the four exact
external branch vectors, parses canonical C-3 ingest receipts, binds full typed
revision/artifact/operation rows and the live series head, and runs the complete
ledger replay with a database-derived deterministic cutoff. Its output is an
explicit unsigned DB-only draft. Hold-bundle digests, physical lineage,
DB-binding receipt, final authority head, signature, and release verdict are not
accepted as D2 inputs and are not emitted as D2 authority. An `unstarted` role
is not terminal until D3 holds the writer fence. D3 must therefore supply opaque
launcher DB-binding, coverage-final, tracked-hold-bundle, same-transaction head,
and private-signer capabilities; its signer must not accept a plain D2 draft.

The D2 replay receipt now freezes all 25 actual v4 verifier tables and rejects
missing, extra, pseudo-table, unsafe, or internally inconsistent counts. The
database-lineage instance ID must equal the live Runtime identity row. The only
streaming operation visitor is fixed inside the reader; no exported caller
callback can rotate a SQL transaction during the scan.

The 22-table head commits the frozen append-only authority set plus every
operation in the external scope; it is not a hash of every SQLite table. The
three replay tables outside that manifest are namespace leases, control jobs,
and Runtime authority identity. Replay validates the first two, the live
lineage check binds the identity row, and D3's checkpointed whole-main-file
digest must close the remaining physical-database boundary.

Before D3 may enable signing, it must add three capabilities that do not exist
in the current Runtime: (1) a launcher-issued inherited-FD database capability
whose descriptor identity/lifetime is verified directly rather than reopened
from `--db`; (2) a private launcher-to-attestor signer channel; and (3) formal
tracked termination/pre-claim hold-bundle schemas, Git/archive readers, and
opaque verified-digest capabilities. Existing path pinning, an ordinary signing
function, or a caller-provided hold digest cannot substitute for any of them.
D3 must invoke D2 reconstruction inside its live protected transaction and must
never deserialize a D2 draft supplied by another process.

**Implementation checkpoint (2026-07-17, Task 8.2D-3a.1):** The first D3
physical-database foundation is implemented without enabling attestation
signing. A new launcher-side writer-fence capability keeps the existing generic
path pin unchanged, requires WAL mode, consumes the structured
`wal_checkpoint(TRUNCATE)` result, rejects any nonzero busy/log/checkpointed
value or nonempty WAL, immediately acquires `BEGIN IMMEDIATE`, and holds that
real SQLite writer lock through descriptor handoff. It freezes and repeatedly
rechecks the main-file device, inode, owner, group, mode, link count, byte
length, and positional whole-file SHA-256. Its inspection is explicitly
`signing_eligible=false` and names the still-required deployment-slot lease,
durable checkpoint generation, launcher receipt, and private signer channel;
the checkpoint-to-BEGIN interval is not represented as safe without that outer
lease.

The attestor-side database boundary accepts no path or descriptor argument. It
adopts exactly fixed inherited fd 3 once, proves that descriptor is O_RDONLY,
revalidates O_RDONLY at every snapshot assertion, proves it is owner-controlled,
non-writable, single-link, and stable, and opens SQLite only
through Linux `/proc/self/fd/3` or macOS `/dev/fd/3` as `mode=ro&immutable=1`.
Node versions before 22.15 fail closed. The read-only Runtime adapter permits
one outermost deferred snapshot transaction, rejects reuse of a caller-owned
transaction, binds its opaque transaction capability to the exact AsyncLocal
owner plus a secret SQLite savepoint guard, and rejects raw transaction restart.
It revokes the capability and closes SQLite but never closes borrowed
process-lifetime fd 3. It rehashes before, during, and after the transaction and
deliberately reports launcher provenance, writer fence, and WAL checkpoint as
not yet established. Replacing the former filesystem path does not redirect the
inherited object; the path replacement itself is not claimed as detected.

A strict canonical launcher-signed database-binding receipt contract now binds
the deployment slot, revision policy digest, database identity and physical
lineage, positive checkpoint generation, zero-checkpoint facts,
writer-fence inspection digest, distinct frozen launcher/attestor identities,
and a first-anchor or successor chain. The pure verifier accepts no independent
public key and verifies only with the launcher key frozen in the supplied
external policy. It requires an exact expected generation supplied by its
caller. Successors reverify the predecessor under an explicitly supplied
historical policy, allowing one deployment-slot chain to cross policy and
launcher-key rotation; they must match the supplied expected previous envelope
digest, keep the same slot/database/device/inode, advance generation, and not
move time backward. The frozen result is explicitly
`cryptographic_relation_only` and `signing_eligible=false`. This pure verifier
does not establish that policy, slot, generation, first anchor, chain head, or
physical facts came from live authorities; the later D3 service must source
them from same-snapshot and deployment-slot opaque capabilities.

Real tests cover child-process fd handoff, writable/directory/hardlink/wrong
SQLite descriptors, fd reuse, former-path replacement not redirecting the
inherited object, in-transaction raw-file mutation, raw `ROLLBACK`/`COMMIT`
transaction restart,
caller-transaction reuse, WAL frames, active writer and old-reader checkpoint
contention, retained writer exclusion, post-BEGIN failure cleanup, release and
handoff-FD reuse, fixed canonical/signature/digest golden vectors, wrong
signer/policy/slot/identity,
cross-policy key rotation, chain forks, generation rollback, and
burned-generation gaps. The external-head CLI remains fail-closed. Durable
deployment-slot state and managed-writer quiesce, tracked hold bundles, live D2
composition, private signing, and atomic publication remain subsequent D3
batches.

Extend the production gate to consume the ledger-derived current-shadow export
and the tool gate to consume a strict external `run-manifest.json`; both reports
must bind task family, source/applicable revision, candidate/gate configuration
digests, harness digest, host-adapter conformance result where applicable, and
their raw source set. Add `--applicability-manifest`,
`--harness-bundle-sha256`, `--harness-exec-preparation`, production-only
`--host-conformance --host-identity-boundary`, and
acceptance-only `--runtime-clone-manifest`; the canonical report binds the clone
digest whenever that flag is present. Outcome-producing formal commands always
return a terminal report/bundle independent of verdict; a separate post-ingest
`assert-pass` command may stop the runbook. Historical reports lacking
these bindings remain diagnostic and cannot be ingested into v1 series.

Derive artifact and evidence-decision IDs from their canonical bound inputs.
Exact retry reuses the existing row; actor/time audit metadata cannot change
content identity, and metadata mismatch is an integrity error.

The CLI contract is explicit:

| Subcommand | Required inputs |
|---|---|
| `status` | `--db --tenant --actor --task-family --experiment-id --revision`; read-only and outcome-redacted |
| `propose-look` | the status identity plus required `--out`; writes a canonical outcome-redacted next-look proposal |
| `export-shadow` | `--db --tenant --actor --task-family --experiment-id --revision --out-dir`; only an immutable `shadow` revision is accepted |
| `reserve-external` | Internal broker-daemon use only. Common: `--db --tenant --kind --series-id --task-family --applicable-experiment-id --applicable-revision --immutable-input-manifest --retry-policy --run-id --broker-authorization-receipt --out --ticket-stdin`. `tool_e2e_gate` additionally requires `--tool-manifest`. `offline_paired_rerun` additionally requires `--holdout-membership-projection --sealed-holdout-manifest --model-snapshot --execution-profile --tool-manifest --execution-order`. The signed authorization binds the operation ID, full canonical request, raw-ticket hash, frozen broker identity, and DB lineage; Runtime derives the actor, re-derives candidate/gate/protected-provisioning applicability and frozen role policy, and rejects caller trust-root flags. |
| `consume-external-ticket` | `--db --tenant --reservation --ticket-stdin --runner-principal-sha256 --broker-process-nonce-sha256 --broker-authorization-receipt --out`; the signed authorization binds the operation and full consumption request. This is the only normal command accepting raw ticket bytes and atomically inserts the sole append-only consumption before offline decrypt/validation. A post-commit raw-ticket replay is rejected; recovery reads the committed receipt. Raw ticket is never argv/log data. |
| `claim-external` | `--db --tenant --reservation --ticket-consumption --runner-principal-sha256 --execution-nonce-sha256 --credential-broker-receipt --out`; revalidates the committed consumption, rejects a pre-claim hold, derives the fixed-domain operation ID from the signed claim-receipt digest, and atomically inserts the only claim before supervisor binding or capability issue. Caller actor/operation ID and raw ticket input are forbidden. |
| `record-external-preclaim-hold` | Internal broker-daemon use only: `--db --tenant --reservation --ticket-consumption --broker-preclaim-hold-receipt --out`; verifies the receipt-derived service actor, fixed-domain operation ID, reason, and zero claim/capability/mount/provider-call proof, atomically inserts or exactly replays the sole hold, and permanently fences `claim-external`. Caller actor/operation ID is forbidden. |
| `close-reserved-run` | Broker-daemon recovery only: `--broker-socket --db --tenant --reservation --triggering-terminal-fact --out`; for a still-unconsumed reservation it first fsyncs the close intent, atomically consumes the existing private ticket, destroys it only after commit, then records a signed `operator_abort` pre-claim hold with zero-effects proof bound to the triggering fact. Crash after consumption replays that intent and cannot enter validation or change reason. It never mints a ticket or performs a provider/mount call. A reserved-but-unconsumed run cannot enter coverage-final or an acceptance root. |
| `bind-external-supervisor` | Internal broker-daemon use only: `--db --tenant --reservation --ticket-consumption --claim --broker-binding-receipt --service-launcher-receipt --out`; verifies both registered signatures and exact runner/executable/argv/PID-start-cgroup-job/inherited-channel bindings, derives the fixed-domain operation ID, and atomically inserts or exactly replays the sole binding before Runtime allows mount/provider access. Caller actor/operation ID is forbidden. |
| `terminate-external-session` | `--db --tenant --reservation --ticket-consumption --claim --broker-terminal-receipt --out`; verifies the registry-frozen broker signature/policy/binary/key, receipt-derived service actor, session/binding ID, reason, signed quiesce and runner-output bindings when required, optional terminal run-manifest, and attempt-chain digest, then atomically inserts or exactly replays the sole append-only termination under its fixed-domain operation ID. Caller actor/operation ID is forbidden. |
| `reserve-look` | the status identity plus `--operation-id --proposal --integrity-run-bundle --integrity-run-bundle-sha256 --out --result-out`; Runtime first requires the bundle tracked at `HEAD`, re-derives the next checkpoint/time/cutoff/policy/heads, and writes a terminal result. Passing integrity atomically inserts its head+reservation; a correctly bound real fault returns success with `reservation_created=false` plus the automatic safety stop and its authority-operation receipt so the incident can still be archived; malformed caller bytes fail nonzero with zero mutation |
| `ingest` | `--db --tenant --actor --operation-id --kind --public-run-authority --run-bundle --series-id --task-family --applicable-experiment-id --applicable-revision --out`; `--public-run-authority` is the self-contained drain-materialized reservation/consumption/claim/binding/normal-termination chain, and kind is only `offline_paired_rerun|production_shadow_gate|tool_e2e_gate`. The verified first-terminal content-address manifest supplies service-launch/binding/health/quiesce/runner-output/source/harness/attempt-chain/terminal digests and immutable source ref, and its status/manifest/attempt chain must match the signed termination. The shared transaction appends the evidence row and `learning_evidence_ingest_v1` protected operation receipt; `--out` is the canonical replay-stable receipt binding both, the resulting registered series head, public-authority digest, tracked run-bundle digest/commit, status, and the bounded post-transaction DB-authority projection digest for this artifact/series head. The later signed aggregate projection binds all terminal branches. Hold-shaped authority, external supersession, generic Runtime-integrity ingestion, caller-supplied chain fragments, or operation-ID reuse with another request are rejected. |
| `freeze-online` | `--db --tenant --actor --reservation --out`; the reservation file must replay the DB row exactly |
| `evaluate-preview` | the freeze identity plus `--ledger-snapshot --out`; deterministic read-only pure result, no gate/authority row |
| `report-preview` | `--db --tenant --actor --evaluation-preview --online-run-bundle-sha256 --out`; deterministic read-only Markdown/JSON from verified preview/frozen facts |

`scripts/formal-learning-run-broker.mjs` contains both the reviewed daemon
entry point and its Unix-socket clients. Its registered content digest covers
the executable plus provider/secret-manager adapters. A deployment-owned
service launcher starts `serve` under the fixed `aionis-formal-run-broker`
UID/GID with owner-only state/spool roots; an ordinary acceptance shell is never
allowed to detach or impersonate that daemon. Eval and host-adapter identities
cannot read broker state, spool, or provider secrets.
The launcher is deployment authority outside this repository; its own reviewed
executable digest and service-account mapping are signed into the launch
receipt. If that launcher/account/socket isolation is unavailable, formal
external evidence is `hold`; there is no same-user local fallback.

Before any claim, `$FORMAL_RUN_BROKER status` requires
`--db --tenant --broker-socket --expect-service-identity --state-root
--terminal-fact-spool --out`. It challenges the daemon, verifies the
registry-frozen signature, and emits a public health/identity receipt binding
daemon UID/GID, executable/policy/key digests, socket inode/mode/owner, peer-
credential enforcement, pre-fsynced-ticket/stdin-only/path-output prohibition,
the authenticated deployment-launcher channel, private-root/spool ACLs, and zero unacknowledged startup
recovery entries. A mismatch stops acceptance before ticket consumption.

The reviewed `$FORMAL_RUN_BROKER reserve-learning-run` client accepts the
public reservation arguments shown above plus `--broker-socket
--reservation-out`; it accepts no ticket path. The daemon invokes
`reserve-external` itself only after generating and fsyncing one CSPRNG ticket
plus the canonical request/operation ID in its private journal, then pipes those
same bytes on stdin. Crash before Runtime commit retries the same protected
operation and ticket; crash after commit re-reads the row and proves the same
hash before returning the public reservation. It never mints a replacement.

The reviewed `$FORMAL_RUN_BROKER claim-learning-run` client requires
`--broker-socket --db --tenant --consume-operation-id
--reservation --runner-identity
--credential-secret-ref --ticket-consumption-out --claim-out
--broker-conformance-receipt-out`; offline additionally requires
`--sealed-holdout-ref`. Caller-selected
ticket/state/spool/key/policy paths are forbidden. The daemon owns the ticket/key,
creates a broker nonce, and invokes protected Runtime
`consume-external-ticket` with ticket bytes on stdin. After re-reading the
committed consumption it atomically writes the public consumption receipt and
unlinks the ticket. Only then may it validate an
offline holdout, create the execution nonce/signed pre-issue receipt, and invoke
`claim-external`. Any terminal failure after consumption but before claim makes
the broker sign a zero-effects receipt and invoke
`record-external-preclaim-hold`; Runtime rechecks that no claim exists, derives
the service actor and fixed-domain operation ID from the receipt, appends the
sole hold, and fences every later claim. On success the broker re-reads the DB
claim and emits only public consumption, claim, and secret-free conformance
receipts. It creates neither a session path nor a caller-readable handle.

The daemon journal implements normal
`claimed_unbound -> active -> quiescing -> quiesced -> terminating ->
terminated` and abnormal `claimed_unbound|active|quiescing -> revoking ->
terminated` transitions. `$FORMAL_RUN_BROKER launch-learning-supervisor` is a
synchronous client requiring `--broker-socket --db --tenant --reservation
--ticket-consumption --claim --runner-identity --supervisor-executable
--supervisor-argv-manifest --service-launcher --supervisor-spawn-receipt-out
--supervisor-binding-out --supervisor-execution-receipt-out
--runner-output-manifest --broker-quiesce-receipt-out
--public-attempt-chain-out -- <exact command>`. The broker verifies the command
against the frozen role/harness policy and asks the deployment launcher to
spawn it. Before `exec`, the launcher creates a private socket pair, inherits
one end only into that exact process, transfers the other to the broker over
their authenticated channel, and signs claim/session, UID/GID, executable/argv,
PID/start/cgroup/job, broker challenge, and channel fingerprints. The broker
verifies the live peer and both signed receipts, then invokes
`bind-external-supervisor`; Runtime derives the fixed-domain operation ID and
appends the sole binding before the broker enters `active` or permits any
mount/provider call. A crash after the Runtime commit replays the same binding
and cannot replace the process/channel. No UID-only or first-writer attach API
exists, so a same-UID thief cannot race the launcher-created descriptor.

The supervisor owns only that inherited descriptor. For every approved child it
spawns, it creates a separate pathless socket pair, gives one end only to the
exact executable/argv and PID/start/cgroup/job tuple, and validates kernel
credentials on every relay message. There is no relay listener/path; the broker
descriptor is stripped before child `exec`, unapproved descendants inherit no
endpoint, and the launcher sandbox blocks ptrace, `/proc` FD duplication, and
`SCM_RIGHTS` transfer. A same-UID sibling or forwarded endpoint is rejected.
Heartbeats are authenticated, and the call counter is durably reserved before every broker-
proxied provider call. New calls are rejected after `quiescing` starts. Before
the supervisor exits it invokes the descriptor-scoped internal
`quiesce-learning-run` operation. The broker atomically blocks
new calls, drains/cancels every in-flight call, writes a terminal
success/failure/unknown receipt for every reserved call, and refuses normal
quiesce if any call remains unresolved. It then seals the signed public attempt
chain, revokes provider and offline-mount access, destroys decrypted staging,
executes negative access checks, and signs the runner-output/chain/cleanup plus
frozen finalization-deadline binding. Only after this acknowledgment may the
supervisor exit normally. Exit before acknowledgment races through the same
serialized journal and exactly one quiesce or `runner_crash` transition wins;
exit after `quiesced` is expected. Post-processing has no session authority.
The public chain is bounded metadata—ordinals, scope/fingerprint/status/retry
digests and signed hash links—never ticket/session bytes, tokens, prompts, tool
payloads, or model outputs.
`run-learning-harness.mjs run` and `HOST_ADAPTER_CTL collect-learning-shadow`
are launched only through this command, accept the inherited descriptor as
their first privileged supervisor resource, and quiesce as their last action
before returning; the acceptance shell never receives or attaches it.

`$FORMAL_RUN_BROKER finalize-learning-run` requires
`--broker-socket --db --tenant --actor --reservation
--ticket-consumption --claim --supervisor-binding
--broker-quiesce-receipt --public-attempt-chain --terminal-run-manifest
--broker-terminal-receipt-out --session-termination-out`. It accepts only the
matching `quiesced` state, re-verifies continued access denial plus all
quiesce/output/chain/terminal bindings, signs the derived
`passed|failed|inconclusive` receipt, fsyncs it to the spool, invokes protected
Runtime `terminate-external-session` with the same fixed-domain/tenant/receipt-
digest-derived operation ID and receipt-derived service actor used by drain
(caller operation IDs and termination actors are forbidden),
re-reads the exact row, fsyncs the spool
ack, and only then closes the live channel. Exit-before-quiesce,
heartbeat loss, hard expiry, unresolved call, and operator revoke spool
`runner_crash|lease_expired|operator_revoke`; explicit revoke after quiesce
spools `post_quiesce_revoke`, while a quiesced session missing its frozen
deadline spools `finalize_timeout`. A claimed launch/process-start failure
spools `launch_failure`; wrong executable/argv/peer/channel or signed binding
receipt mismatch spools `binding_integrity_failure`. Both have no binding,
quiesce, output, or terminal run manifest and are never disguised as
`runner_crash`.

`$FORMAL_RUN_BROKER drain-terminal-facts` requires
`--broker-socket --db --tenant --actor --public-terminal-fact-dir
--drain-receipt-out`. The typed terminal-fact spool path comes only from daemon
configuration. It sorts acknowledged and unacknowledged signed entries by
`(fact_kind, receipt_digest)`. For `preclaim_hold` it derives the fixed
`learning_external_preclaim_hold_v1` operation, invokes/replays
`record-external-preclaim-hold`, and exports canonical reservation/consumption
rows and receipts plus the signed hold receipt, zero-effects proof, and
committed hold row/operation receipt. For `session_termination` it
derives the fixed `learning_external_session_termination_v1` operation,
invokes/replays `terminate-external-session`, and exports canonical reservation/
consumption/claim/optional-binding rows and receipts plus the signed terminal
receipt, complete/partial attempt chain, optional quiesce/output bindings, and
committed termination row/operation receipt. Caller prefixes/mutation actors
are forbidden; each ack and canonical public export is fsynced, and exact replay
reproduces identical bytes in the stable reservation-digest subdirectory named
by the drain manifest. A crash after any Runtime commit but before a client
output write is therefore recoverable without caller files. Neither hold kind
can be finalized or ingested as a result.
`$FORMAL_RUN_BROKER materialize-public-run` is read-only and requires
`--drain-receipt --public-terminal-fact-dir --reservation --out-dir`. It
verifies the drain signature/manifest, selects exactly one reservation-digest
entry, and atomically materializes its canonical self-contained authority chain;
it never consults or repairs earlier client-output paths.

`scripts/archive-learning-eval.mjs --kind termination-hold` consumes a public
termination export plus reservation/consumption/claim, optional binding, and
service launch/health/drain/pre-stop-status receipts. `--kind preclaim-hold`
consumes reservation/consumption, the signed pre-claim receipt, committed hold
row/operation receipt, and zero-effects proof. Both write secret-scanned,
content-addressed bundles under `evals/learning-episode-gate-v1/holds/`; neither
kind is accepted by `learning-evidence ingest`. The acceptance index treats
each consumed reservation as an exact tagged union of `result_bundle`,
`termination_hold_bundle`, or `preclaim_hold_bundle`. Missing, duplicate, or
simultaneous branches fail; either hold branch forces the release verdict to
`hold` but remains committable audit evidence.

The shell cleanup trap may request revoke and drain. A pre-stop status first
proves zero active sessions and all spool/pre-claim facts committed,
acknowledged, and publicly exported, without inspecting bundle coverage. Then
all result/claimed-hold/pre-claim-hold bundles are archived. A distinct
coverage-final status references their content digests and proves exactly one
branch per consumed reservation; only then may the launcher stop the broker.
Coverage-final and stop receipts belong only to the outer acceptance lifecycle
root and are forbidden inside external bundles, so no bundle/status hash cycle
exists. If Runtime, drain, export, or archive is unavailable, the deployment
launcher keeps or restarts the managed daemon and emits a signed
`recovery_required` incident receipt containing the canonical recovery command.
Cleanup returns nonzero and must not hide the failure with `|| true` before
stopping the only monitor.

For offline claims, after ticket consumption but before `claim-external`, it
validates the sealed
reference/ciphertext/source digests and canonical 96-row ordinal/member/order/
case-set projection against the persisted reservation in broker-only storage.
Any mismatch destroys staging bytes and records a signed `preclaim_hold` with
no Runtime claim, credential, runner-readable mount, or provider call. The
public hold export binds the zero-effects proof and committed Runtime hold row.
CLI and
broker-conformance tests cover a wrong reference, ciphertext,
member field, count, ordinal/order, projection, ticket, principal, nonce,
signature, binary/key, and policy. They assert zero credential-broker issue
receipts and zero wrapper/provider call receipts on every pre-claim failure.
Crash injection after consumption commit, after unlink, and at every decrypt/
compare/sign/claim boundary proves that neither a second consumption, hold, nor
claim can succeed and exactly one terminal branch remains; a crash before consumption commit leaves the original ticket as
the only permitted retry point.

Broker lifecycle tests prove daemon UID/GID/socket/ACL challenge and reject a
same-user fake daemon. They crash before and after Runtime reservation commit
and prove restart reuses the pre-fsynced request/ticket hash without exposing or
reminting bytes. They race a same-UID thief against launcher startup and prove
only the exact inherited descriptor plus signed PID/start/cgroup/job can bind;
they race a same-UID sibling against every child relay and reject forwarded FDs,
unapproved descendants, ptrace, and `/proc` descriptor duplication;
they crash after Runtime binding commit but before journal activation and prove
fixed-domain exact replay cannot substitute a process/channel. They crash immediately after capability issue, kill the
runner/client shell, suppress heartbeats, exceed hard expiry/call count, race
clean exit against quiesce, race quiesce/finalize against an in-flight call,
allow long bounded post-processing after clean quiesce, and finalize
pass/fail/inconclusive. They require independent revoke, mount cleanup, a signed
public complete/partial call chain, exactly one termination, and denial of all
post-quiesce/terminal access. Broker restart plus `drain-terminal-facts` must
persist crash/expiry/pre- or post-quiesce-revoke/finalize-timeout receipts
idempotently. A crash after Runtime termination commit but before spool ack must
replay from a fresh process with the identical fixed-domain operation ID,
receipt-derived service actor, and operation body whether the first writer was
finalize or drain. Every abnormal path exports deterministic public bytes and
exactly one claimed or pre-claim hold bundle; recovery failure keeps/restarts
the daemon and emits `recovery_required`. Missing,
duplicate, invalid-signature, wrong-reason/status, wrong-quiesce/output/
manifest/attempt-chain termination blocks archive ingestion and acceptance.
Crash injection after consumption, claim, binding, or termination DB commit but
before its client-output atomic rename proves typed drain can reconstruct the
same self-contained reservation-to-terminal public chain using only DB plus
signed spool. Acknowledged-entry re-export and `materialize-public-run` are
byte-identical; no archive or ingest path depends on the first client response.

The checked-in `scripts/seal-learning-external-prerequisites.mjs` makes the
abnormal path executable rather than a prose recipe. `prepare-recovery` accepts
the frozen required-series manifest, broker/DB identity, public terminal-fact
directory, and allowlisted result-source manifests. It first closes every
reserved/unconsumed sibling through `close-reserved-run`, drains and
materializes all terminal facts, obtains pre-stop status, classifies each
required role as `unstarted|result|termination_hold|preclaim_hold`, invokes only
the matching archive schema, and emits a canonical sealing plan plus series
status. It rejects an unexplained in-flight prefix, duplicate/mixed branch,
unknown source, or reserved-unconsumed remainder. It does not request coverage-
final or stop. After the listed bundles are committed, `seal-recovery` verifies
their exact digests at `HEAD`, ingests every complete normal result branch
regardless of pass/fail/inconclusive while rejecting both hold shapes, writes
the final required-series status and coverage index, then asks the registered
launcher-bound Runtime authority attestor to verify the live DB and sign the
exact ingestion projection. It obtains coverage-final, stops the daemon, and creates both
the lifecycle and `external-ingestion` bundles. The latter is required even
when there are zero result branches and proves that no hold/unstarted branch
was ingested. The shell then commits both bundles and writes
`external_prerequisite_hold`. Golden tests cover every branch,
commit-before-client-output recovery, plan tamper, untracked bundle, crash
before/after `close-reserved-run` consumption, crash between the two sealing
phases, exact replay, wrong attestor service/launcher/policy/key/database-
lineage/head, unsigned/self-signed projection, copied DB, unresolved WAL, and
the acyclic ordering constraint.

Candidate/gate IDs and configuration digests are resolved from the applicable
immutable revision and must match the report; callers cannot override them.
`source_ref` is derived from the verified content-addressed run-bundle manifest,
never from its mutable staging source. Paths are inputs only: persisted bytes,
digests, series heads, reservation, and cutoffs are replay authority. There is no implicit
production database, tenant, clock, latest head, or operator-selected look.

The proposal contract contains version, tenant/task family, experiment/revision,
confirmatory-attempt ID/digest, candidate/gate config digests, the smallest registered unreserved look index and
target, earliest derived analysis time/event cutoff, prior reservation/head,
source-policy digest, and `proposal_sha256`. It contains no outcome labels.
Its authority-projection digest covers normalized schema/policy/attempt rows,
assignment/source integrity facts, and relevant rows only through the proposed
event/artifact cutoffs; it is not a raw SQLite-file hash. Legitimate
post-cutoff feedback therefore cannot perturb the proposal, while any changed
cutoff-bounded fact conflicts.
Parser/replay tests reject wrong DB, revision, attempt, look order, target,
cutoff, proposal digest, integrity bundle/head, or post-proposal config drift.
Label permutation preserves both proposal and Runtime-integrity report/bundle
bytes. Only the post-reservation online export contains labeled outcomes.

**Step 5: Freeze the pending engine and reviewed scenario before simulation**

```bash
npx tsx scripts/learning-gate-calibration.ts registry-status \
  --gate-policy gate-policy-v1 --require calibration_pending
npx tsx --test scripts/ci/lite-learning-evidence-gate.test.ts
npx tsx --test scripts/ci/lite-learning-gate-calibration.test.ts
node --test scripts/ci/formal-learning-run-broker.test.mjs
npm run -s typecheck
git add src/memory/learning-evidence-gate.ts \
  src/memory/learning-gate-policy.ts \
  src/memory/admission-production-gate.ts src/memory/admission-tool-e2e-gate.ts \
  scripts/e2e/admission-production-gate.ts \
  scripts/e2e/admission-tool-e2e-gate.ts \
  scripts/ci/lite-admission-production-gate.test.ts \
  scripts/ci/lite-admission-tool-e2e-gate.test.ts \
  src/store/lite-learning-episode-ledger.ts scripts/learning-evidence.ts \
  scripts/ci/lite-learning-evidence-gate.test.ts \
  scripts/ci/lite-learning-evidence-cli.test.ts \
  scripts/formal-learning-run-broker.mjs \
  scripts/ci/formal-learning-run-broker.test.mjs \
  scripts/learning-gate-calibration.ts \
  scripts/ci/lite-learning-gate-calibration.test.ts \
  docs/research/2026-07-13-learning-gate-policy-v1-calibration-scenarios.json
git commit -m "feat(learning): freeze pending evidence gate calibration design"
```

That commit is the pre-outcome freeze point. The scenario manifest already
contains the signed review, seed, shard plan, replication counts, exact bound
contract, thresholds, and reference-runner budget. Do not generate the result
artifact from an uncommitted engine or grid.

**Step 6: Compute, independently review, register, and commit**

```bash
PENDING_ENGINE_COMMIT="$(git rev-parse HEAD)"
git diff --exit-code -- src/memory/learning-evidence-gate.ts \
  src/memory/learning-gate-policy.ts \
  scripts/formal-learning-run-broker.mjs \
  scripts/ci/formal-learning-run-broker.test.mjs \
  docs/research/2026-07-13-learning-gate-policy-v1-calibration-scenarios.json
npx tsx scripts/learning-gate-calibration.ts run \
  --gate-policy-engine gate-policy-v1 \
  --require-registration-status calibration_pending \
  --source-commit "$PENDING_ENGINE_COMMIT" \
  --scenario-manifest \
    docs/research/2026-07-13-learning-gate-policy-v1-calibration-scenarios.json \
  --out docs/research/2026-07-13-learning-gate-policy-v1-calibration.json
npx tsx scripts/learning-gate-calibration.ts verify \
  --artifact docs/research/2026-07-13-learning-gate-policy-v1-calibration.json \
  --scenario-manifest \
    docs/research/2026-07-13-learning-gate-policy-v1-calibration-scenarios.json \
  --source-commit "$PENDING_ENGINE_COMMIT" \
  --require-computed-pass --require-registry-status calibration_pending \
  --recompute-shards --reject-runtime-db --reject-evidence-inputs
npx tsx scripts/learning-gate-calibration.ts print-sha \
  --artifact docs/research/2026-07-13-learning-gate-policy-v1-calibration.json
```

Stop for independent review of the raw shard counts, resource receipt, and
computed artifact. Then edit only the registration envelope in
`src/memory/learning-gate-policy.ts`: set `registration_status="registered"`,
copy the printed `prospective_calibration_sha256`, and refresh only the derived
policy-config/golden digest fields. The preregistration inference-engine digest,
schedule, margins, alpha, scenarios, seed, counts, and raw artifact are
immutable. Any other diff requires discarding the artifact, returning to
`calibration_pending`, and repeating Step 5 under a new pre-outcome commit.

```bash
npx tsx scripts/learning-gate-calibration.ts registry-status \
  --gate-policy gate-policy-v1 --require registered
npx tsx scripts/learning-gate-calibration.ts verify \
  --gate-policy gate-policy-v1 --require-registered \
  --artifact docs/research/2026-07-13-learning-gate-policy-v1-calibration.json \
  --scenario-manifest \
    docs/research/2026-07-13-learning-gate-policy-v1-calibration-scenarios.json \
  --source-commit "$PENDING_ENGINE_COMMIT" --recompute-shards \
  --reject-runtime-db --reject-evidence-inputs
npx tsx --test scripts/ci/lite-learning-evidence-gate.test.ts
npx tsx --test scripts/ci/lite-admission-production-gate.test.ts
npx tsx --test scripts/ci/lite-admission-tool-e2e-gate.test.ts
npx tsx --test scripts/ci/lite-learning-evidence-cli.test.ts
npx tsx --test scripts/ci/lite-learning-gate-calibration.test.ts
node --test scripts/ci/formal-learning-run-broker.test.mjs
npm run -s typecheck
git add src/memory/learning-gate-policy.ts \
  docs/research/2026-07-13-learning-gate-policy-v1-calibration.json
git commit -m "feat(learning): register calibrated task-family evidence gate"
```

## Phase 9: Gate decisions and promotion authority

### Task 9.1: Separate evidence readiness from atomic authority adjudication

**Files:**

- Modify: `src/store/lite-learning-episode-ledger.ts`
- Modify: `src/kernel/learning-promotion-kernel.ts`
- Modify: `src/kernel/policy-mutation-loop.ts`
- Modify: `src/memory/learning-loop.ts`
- Modify: `src/memory/workflow-write-projection.ts`
- Modify: `src/memory/learning-authority-approval.ts`
- Modify: `src/memory/promotion-evidence-ledger.ts`
- Modify: `src/store/lite-write-store.ts`
- Modify: `scripts/learning-evidence.ts`
- Test: `scripts/ci/lite-learning-evidence-gate.test.ts`
- Test: `scripts/ci/lite-atomic-write-uow.test.ts`
- Modify: `scripts/ci/lite-learning-evidence-cli.test.ts`

**Step 1: Test cutoff reproducibility**

Reserve and run one gate look, append late feedback, then replay that
reservation. The cohort digest and evidence evaluation must remain identical;
a second reservation/cutoff for the same look conflicts. Test that the unique
key includes experiment ID, revision, checkpoint index/reservation, artifact
cutoff, and `analysis_at`. Evaluate safety-only checkpoint 1 as `hold`, then
evaluate formal checkpoint 2 as `promotion_ready`. Reserve checkpoint 3 before
adjudication and prove checkpoint-2 readiness is immediately blocked; evaluate
checkpoint 3 as `hold`, require the strict `supersedes_decision_id` chain, and
prove only the highest evaluated checkpoint can be adjudicated. Then append
late harm/safety pause, corrupt or revoke a current prerequisite binding, and
separately record a later Runtime-integrity safety failure; prove the old
readiness cannot be adjudicated in any case. External result successors are
forbidden, so this test never fabricates a newer external head.
Also prove the next look cannot be proposed until the prior reservation has a
persisted evaluation, and that every later evaluated look—including `hold`—
names and supersedes the immediately preceding verdict. These are stateful
store/adjudication tests; Task 8 covers only deterministic preview replay.

Also reject missing, expired, wrong-key, wrong-action, wrong-digest, or replayed
`LearningAuthorityApprovalV1`. Prove self-reported `--actor` without a valid
approval cannot mutate authority. Close/reopen the DB and reverify the persisted
canonical approval body, MAC, nonce, expiry, key/approver, unique authority
operation ID, and matching write-operation receipt; no mutable request file is
needed for replay. A second gate or experiment-close operation using the same
tenant/key/nonce is rejected by the global authorization-nonce registry even
when its MAC is otherwise valid.

Cover the outcome-triggered automatic path here: a pure result that is both
`demotion_ready` and pause-worthy must append the evidence row, separate
`safety_stop/pause_required/pause` row, and deterministic internal
`learning_gate_authority_v1` receipt atomically. Fault injection rolls back all
three; malformed preview/input cannot manufacture a pause.

**Step 2: Append the evidence evaluation**

Bind task family, candidate ID/version plus implementation-contract digest,
gate version, experiment revision, scope-set
digest, look reservation/index, cohort digest, deterministic evidence-series
heads, cutoff row ID, report digest, and actor. A `promotion_ready` evidence row has `authority_action=NULL`, cannot
change guide serving, and is never attached as a child of one episode. Persist
the exact artifact ID/role/order/report-digest memberships in the same
transaction.
Look 1 has no superseded decision; every later look must name the immediately
preceding evaluation and a unique index permits only one successor. Any newer
verdict, including `hold`, makes all older readiness stale.

Extend the Task 8 CLI with stateful `evaluate`, requiring
`--db --tenant --actor --operation-id --reservation --ledger-snapshot --out`.
It replays the preview, persists exactly once, and returns the canonical stored
evaluation. Keep `evaluate-preview` read-only. Missing/changed operation inputs
fail before mutation.
Extend reporting at the same time with `report --decision-id` or verified
`--evaluation`, plus `--online-run-bundle-sha256 --out`; it resolves persisted
facts only. `report-preview` remains explicitly non-authoritative.

**Step 3: Add protected authority adjudication**

Explicit signed adjudication opens
`BEGIN IMMEDIATE`, replays the approved reserved look at its original
statistical cutoff, and then scans current post-cutoff safety/integrity facts,
policy configs, and required-series heads as vetoes. Promotion requires no
candidate-implementation safety row across any alias; signed demotion/retirement may follow a compatible
automatic pause and must reference its exact evidence. The adjudicator reuses the exact approved evidence evaluation,
and binds its ID as `basis_evidence_decision_id`; it never creates a hidden
fourth look. In that outer transaction append the `authority_adjudication` row,
claim the global `lite_learning_authorization_nonces` row, append the real
policy/authority mutation for promote/demote/retire, and store the operation
receipt. Approval nonce, decision, mutation, receipt, and any release commit or
roll back together. A terminal promote/demote/retire also releases the exact
complete active namespace-lease set in that transaction with
`release_ref_kind=terminal_authority_adjudication` and the new decision ID.
Fault injection proves no partial release; arbitrary release refs, wrong set
digests, alias-based bypass, or a missing lease conflicts and rolls back the
authority mutation. Authority-adjudication rows require
`authorization_kind=signed_operator`; automatic pause never uses this row
shape. Fault injection after either insert must roll both back.
`hold` preserves state. Safety-stop `pause`
continues to be written by the triggering feedback/job/integrity transaction.
Every enrolled revision also mandates automatic safety pause: a gate-run
`pause_required` appends a separate `safety_stop` row and deterministic internal
`learning_gate_authority_v1` receipt in the same gate transaction. Promotion,
demotion, and retirement remain separately signed and adjudicated.

Expose this only through `scripts/learning-evidence.ts adjudicate`; add no HTTP
route. Require explicit `--db`, `--tenant`, `--actor`, `--operation-id`,
experiment/revision, approved evidence-decision/cohort/artifact-set digests,
expected candidate/gate versions, and `--approval` pointing to a bounded
manifest signed by the existing authority-receipt HMAC keyring. Never accept a
secret/token on the command line. The authority row is
the actual task-family serving mutation consumed by guide; the same row embeds
the validated `PolicyMutationV1`/promotion-evidence digest. V1 does not pretend
to rewrite environment profile JSON. Same operation/request replays, changed
request conflicts, and stale evidence returns hold/conflict.

**Step 4: Populate the existing promotion protocol**

Supply actual distinct runs/tasks, holdout evidence, negative transfer,
leakage/holdout/interference/growth gates, and explicit authority scope. A
positive regression pass is an evidence ref, not `regression_evidence_count`.
Populate the protocol at the real construction callers in `learning-loop.ts`
and `workflow-write-projection.ts`; `learning-promotion-kernel.ts` alone is only
the semantic preview and cannot repair missing persisted protocol fields.

**Step 5: Run and commit**

```bash
npx tsx --test scripts/ci/lite-learning-evidence-gate.test.ts
npx tsx --test scripts/ci/lite-atomic-write-uow.test.ts
npx tsx --test scripts/ci/lite-learning-evidence-cli.test.ts
npm run -s typecheck
git add src/store/lite-learning-episode-ledger.ts \
  src/store/lite-write-store.ts src/kernel/learning-promotion-kernel.ts \
  src/kernel/policy-mutation-loop.ts \
  src/memory/learning-loop.ts src/memory/workflow-write-projection.ts \
  src/memory/learning-authority-approval.ts scripts/learning-evidence.ts \
  src/memory/promotion-evidence-ledger.ts \
  scripts/ci/lite-learning-evidence-gate.test.ts \
  scripts/ci/lite-atomic-write-uow.test.ts \
  scripts/ci/lite-learning-evidence-cli.test.ts
git commit -m "feat(learning): adjudicate task-family authority atomically"
```

### Task 9.2: Stop implicit task-family workflow promotion

**Files:**

- Modify: `src/kernel/policy-mutation-loop.ts`
- Modify: `src/memory/learning-loop.ts`
- Modify: `src/memory/workflow-write-projection.ts`
- Modify: relevant learning-loop/workflow tests under `scripts/ci/`

**Step 1: Add failing tests**

Two observations plus a workflow signature may allow local reuse but must not
create task-family authority without a passing wider-generalization protocol.

**Step 2: Require explicit authority scope**

Change `buildPolicyMutationFromWorkflowPromotion` to accept the adjudicated
scope and evidence source. Remove the workflow-signature heuristic.

**Step 3: Run and commit**

```bash
npx tsx --test scripts/ci/lite-learning-loop-worker.test.ts
npx tsx --test scripts/ci/lite-workflow-write-projection-contract.test.ts
npm run -s typecheck
git add src/kernel/policy-mutation-loop.ts src/memory/learning-loop.ts \
  src/memory/workflow-write-projection.ts \
  scripts/ci/lite-learning-loop-worker.test.ts \
  scripts/ci/lite-workflow-write-projection-contract.test.ts
git commit -m "fix(learning): require evidence for task-family authority"
```

## Phase 10: Bounded legacy backfill and operator read model

### Task 10.1: Add explicit, non-authoritative legacy backfill

**Files:**

- Modify: `src/store/lite-runtime-data-operations.ts`
- Modify: `scripts/ci/lite-runtime-data-operations.test.ts`
- Modify: `scripts/runtime-data-ops.ts`

**Step 1: Add bounded backfill tests**

Backfill only digest-valid guide receipts in bounded batches. Never run a full
scan during normal startup. Re-running a completed batch inserts zero rows.
Legacy items preserve only the final served action proved by the guide receipt;
`recorded_action`, `candidate_action`, memory type/backend, and prior fields are
NULL, with `decision_completeness=legacy_served_only`, unclassified track, and
`promotion_eligible=false`. Never infer old feedback from node counters.

**Step 2: Add the explicit command and final verification**

Extend `scripts/runtime-data-ops.ts` with a cursor/batch-size command. Run the
existing v3 verifier after each batch and on completion; backup remains blocked
on any integrity finding.

**Step 3: Run and commit**

```bash
npx tsx --test scripts/ci/lite-runtime-data-operations.test.ts
npm run -s typecheck
git add src/store/lite-runtime-data-operations.ts scripts/runtime-data-ops.ts \
  scripts/ci/lite-runtime-data-operations.test.ts
git commit -m "feat(store): verify and backfill learning episodes"
```

### Task 10.2: Extend flight recorder without a new route

**Files:**

- Modify: `src/product/product-services.ts`
- Modify: `src/product/lifecycle-service.ts`
- Modify: `src/memory/product-output/operator-projections.ts`
- Modify: `src/memory/product-output-contract.ts`
- Modify: `src/store/lite-learning-episode-ledger.ts`
- Modify: `scripts/ci/lite-product-facade-route.test.ts`
- Modify: `scripts/ci/lite-product-output-contract.test.ts`

**Step 1: Write a failing guide-trace-only test**

`/v1/audit/flight-recorder` with only tenant/scope/guide trace loads the episode
and exposes read-only event/item/receipt-status/evidence/gate summary. It must
not include raw prompt, notes, canonical receipt payload, assignment randomness,
evidence report JSON, or internal config JSON.

**Step 2: Implement bounded replay projection**

Use source digests and ledger facts. Keep `runtime_mutation=false` and
`agent_prompt_included=false`. Extend the strict flight-recorder Zod/result
contract before returning the new summary; do not rely on loose extra fields.
Under the route's existing single tenant/scope recall authorization, expose only
episode-local facts plus gate decision/verdict/authority and scope-set digest.
Never expand cross-scope cohort membership or per-scope statistics without
authorization for every member scope.

**Step 3: Run route governance and commit**

```bash
npx tsx --test --test-name-pattern="flight recorder.*episode" \
  scripts/ci/lite-product-facade-route.test.ts
npx tsx --test scripts/ci/lite-product-output-contract.test.ts
npm run -s typecheck
git add src/product/product-services.ts src/product/lifecycle-service.ts \
  src/memory/product-output/operator-projections.ts \
  src/memory/product-output-contract.ts \
  src/store/lite-learning-episode-ledger.ts \
  scripts/ci/lite-product-facade-route.test.ts \
  scripts/ci/lite-product-output-contract.test.ts
git commit -m "feat(audit): expose learning episodes in flight recorder"
```

## Phase 11: Crash, restart, full CI, and real-Agent evidence

### Task 11.1: Add real-process crash/replay coverage

**Files:**

- Create: `scripts/ci/support/learning-episode-commit-crash-child.ts`
- Modify: `scripts/ci/lite-atomic-write-uow.test.ts`

**Step 1: Spawn a real child Runtime writer**

Exit immediately in the database `after_commit` phase before a response is
written. Reopen in the parent and verify the complete transaction.

**Step 2: Replay the same operation**

Assert no duplicate commit, receipt, event, item, attribution, measurement, or
counter appears.

**Step 3: Run and commit**

```bash
npx tsx --test scripts/ci/lite-atomic-write-uow.test.ts
git add scripts/ci/support/learning-episode-commit-crash-child.ts \
  scripts/ci/lite-atomic-write-uow.test.ts
git commit -m "test(runtime): prove episode crash recovery"
```

### Task 11.2: Run the complete structural and product suite

**Files:**

- Modify if measured growth remains: `docs/architecture/runtime-complexity-budget.json`
- Modify: `docs/architecture/AIONIS_LEARNING_EPISODE_LEDGER_DESIGN.md`
- Modify: `docs/AIONIS_PRODUCT_CONTRACT.md`
- Modify: `docs/AIONIS_STATE_MODEL.md`
- Modify: `RELEASE_NOTES.md`
- Modify: `docs/AIONIS_RELEASES.md`
- Modify: `scripts/ci/lite-source-scope.test.mjs`
- Modify: `release-train.json`
- Modify: `/Volumes/ziel/new.aionis/aionis-sdk/package.json`
- Modify if present: `/Volumes/ziel/new.aionis/aionis-sdk/package-lock.json`

**Step 1: Focused tests**

```bash
npm run -s typecheck
npx tsx --test scripts/ci/lite-learning-episode-contract.test.ts
npx tsx --test scripts/ci/lite-learning-episode-store.test.ts
npx tsx --test scripts/ci/lite-atomic-write-uow.test.ts
npx tsx --test scripts/ci/lite-runtime-data-operations.test.ts
npx tsx --test scripts/ci/lite-product-feedback-closed-loop.test.ts
npx tsx --test scripts/ci/lite-learning-evidence-gate.test.ts
npx tsx --test scripts/ci/server-product-smoke.test.ts
node --test scripts/ci/lite-source-scope.test.mjs
```

Expected: PASS.

**Step 2: Reconcile authoritative product and state contracts**

Document guide/feedback/tool/measure operation IDs, exact replay, 409 conflict,
2 MiB/413 guide receipt bound, host task/use receipts, episode/track/source
state, policy/experiment/look/artifact/gate authority transitions, and the
extended strict flight-recorder projection. Add source-scope assertions for the
new contract/version terms so implementation cannot silently drift from these
two authority documents.

**Step 3: Audit the final structural shape**

Remove dead or duplicate paths first, then run `complexity:report`. Because the
starting budget is exactly full and the design deliberately introduces cohesive
ledger/gate modules, any remaining increase must be written as the exact
measured file/line/largest-file values with a short architecture justification.
Do not raise route or env-field ceilings when those measurements did not grow.

```bash
npm run -s complexity:report
```

**Step 4: Freeze the standalone SDK release coordinate**

After the final Runtime-owned SDK sync, bump the standalone SDK package to the
reviewed next version, run its full tests, and commit it. Push/publish that
immutable commit only as an explicitly coordinated release action. Then update
Runtime `release-train.json` `packages.sdk.version`, `source_ref`, and
`source_commit` to the exact clean SDK HEAD; use the 40-character commit as
`source_ref` until/if a matching immutable version tag is published. CI does not
read sibling SDK `main`—it checks out this frozen ref—so a local sync alone is
not acceptance.

Record the exact SDK version and Runtime release coordinate in both
`RELEASE_NOTES.md` and `docs/AIONIS_RELEASES.md` in the same reviewed change;
`release-version-docs.test.mjs` treats both as required authority documents.

```bash
cd /Volumes/ziel/new.aionis/aionis-sdk
npm test
SDK_VERSION="$(node -p 'require("./package.json").version')"
SDK_COMMIT="$(git rev-parse HEAD^{commit})"
test -z "$(git status --porcelain)"

cd /Volumes/ziel/new.aionis/AionisRuntime-focused
# Update release-train.json sdk version/source_ref/source_commit to the two
# values above with the reviewed release edit, then verify against the checkout.
AIONIS_RELEASE_SDK_REPO=/Volumes/ziel/new.aionis/aionis-sdk \
  node scripts/ci/release-artifact-gate.mjs --check
npm run -s sdk:check -- --sdk-repo /Volumes/ziel/new.aionis/aionis-sdk
```

Do not claim CI-ready until the frozen SDK commit is reachable by the remote CI
checkout. If publishing authority is not granted, stop at a documented release
blocker rather than pointing `release-train.json` at an unreachable commit.

**Step 5: Complete CI, structure, and commit the audited baseline**

```bash
npm run -s sdk:check -- --sdk-repo /Volumes/ziel/new.aionis/aionis-sdk
npm run -s lite:test
npm run -s lite:smoke
npm run -s complexity:check
node scripts/ci/release-artifact-gate.mjs --check
node --test scripts/ci/release-version-docs.test.mjs
git diff --check
```

Expected: PASS.

```bash
git add docs/architecture/runtime-complexity-budget.json \
  docs/architecture/AIONIS_LEARNING_EPISODE_LEDGER_DESIGN.md \
  docs/AIONIS_PRODUCT_CONTRACT.md docs/AIONIS_STATE_MODEL.md \
  RELEASE_NOTES.md docs/AIONIS_RELEASES.md \
  scripts/ci/lite-source-scope.test.mjs release-train.json
git commit -m "chore(runtime): audit learning architecture complexity"
```

Skip this commit only if deletions kept every measurement within the existing
baseline and neither file changed.

### Task 11.3: Run real Runtime and real Agent acceptance

**Files:**

- Modify: `/Volumes/ziel/new.aionis/AionisRuntime-evals/package.json`
- Modify: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/scripts/build-arm-contexts.mjs`
- Modify: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/scripts/run-smoke-arms.mjs`
- Modify: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/scripts/summarize-smoke-run.mjs`
- Modify: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/scripts/run-phase2-gradient-pilot.mjs`
- Modify: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/scripts/lib/run-provenance.mjs`
- Modify: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/scripts/run-agent-command.mjs`
- Modify: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/scripts/deepseek-multistep-agent.mjs`
- Modify: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/scripts/run-action-completion-gate.mjs`
- Create: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/scripts/run-learning-evidence.mjs`
- Create: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/scripts/write-learning-outcomes.mjs`
- Create: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/scripts/validate-learning-gate-manifest.mjs`
- Create: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/scripts/lib/learning-writeback.test.mjs`
- Create: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/scripts/lib/learning-resume.test.mjs`
- Create: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/scripts/lib/learning-paired-isolation.test.mjs`
- Create: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/configs/learning-episode-gate-v1-runtime-arms.json`
- Create: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/configs/learning-episode-gate-v1-recorded-profile.json`
- Create: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/configs/learning-episode-gate-v1-candidate-profile.json`
- Create: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/fixtures/learning-episode-gate-v1.jsonl`
- Create: `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/docs/learning-episode-gate-v1.md`
- Create: `scripts/archive-learning-eval.mjs`
- Create: `scripts/ci/archive-learning-eval.test.mjs`
- Create: `scripts/run-learning-harness.mjs`
- Create: `scripts/ci/run-learning-harness.test.mjs`
- Create: `scripts/learning-acceptance-runtime.mjs`
- Create: `scripts/ci/learning-acceptance-runtime.test.mjs`
- Create: `scripts/seal-learning-external-prerequisites.mjs`
- Create: `scripts/ci/seal-learning-external-prerequisites.test.mjs`
- Create: `evals/learning-episode-gate-v1/README.md`
- Create: `evals/learning-episode-gate-v1/acceptance-index.json`
- Create: `docs/research/2026-07-13-learning-episode-evidence-report.md`

**Step 1: Repair and extend immutable provenance**

Generate deterministic observe operation IDs from run ID, base-task ID, level,
episode, harness arm, event ordinal/type, and canonical event digest; guide IDs
also include a call ordinal and canonical request digest. Use `base_trap_id`, not the
`__tidy/__buried` variant ID, as task signature; add a stable repository
signature and keep difficulty as a stratum only. Persist the Runtime-returned
guide trace, episode, experiment/revision/config digest, assignment unit,
memory-namespace/set/lease digests and lease generation, assigned/served arm,
matched-pair/member and activation-wave/times for confirmatory traffic,
server-derived collection class/principal fingerprint and
source-policy digest, per-memory track, item-set digest, Runtime commit and DB
snapshot, provider, and model through `guide.json`, flat results, and summary.
The harness must never invent arm, track, or collection class. Replace the
current one-scope-per-run default for A/A and paired learning modes: a reviewed
mode-specific namespace/case manifest supplies a stable canonical store scope
per independent base task, and the runner refuses duplicate scope keys or
task/repository variants masquerading as clusters. Fix resume by requiring and
fingerprinting one explicit `--run-id`.

After Agent execution, require a strict `host_use_receipt_v1`: memory IDs count
as used only when the instrumented Agent/tool trace or deterministic scorer
provides a content-specific evidence ref. Never mark every `use_now` exposure as
used. Post protected `/v1/feedback` with an operation ID bound to the guide,
actual used IDs/surface, verifier outcome, and evidence refs; unproven use stays
missing. When a verified before/after guide pair exists, issue the post-run
guide and protected `/v1/measure`; otherwise record measurement insufficient
rather than fabricate effect. Add retry/conflict tests for observe, guide,
feedback, and measure writes. Without this write-back, the online cohort is
exposure-only and can never satisfy assessability or 90% coverage.

**Step 2: Source, review, validate, and archive the independent case set**

The largest currently audited fixture has only 13 independent base tasks; four
hygiene variants are not independent. For the isolated paired regression suite,
source at least 96 genuinely different base tasks with stable repository
signature, task family, source evidence, deterministic verifier, leakage
review, and human-review record. The formal 96-case plaintext is never placed in
the mutable Evals tree or committed harness. A reviewed holdout allocator keeps
it encrypted/sealed and publishes only a bounded membership projection of case
identity, task ID, content/workflow, canonical store scope, source event,
source-evidence and ciphertext digests. Candidate
implementation/source and harness commits plus the external reservation are
frozen before the broker releases a read-only decrypted mount to the sole
committed launcher-bound supervisor. The checked-in `learning-episode-gate-v1.jsonl` is diagnostic
validator input only and is ineligible for the formal offline result. Run the
existing trap triage/preflight plus the new validator to reject duplicate base
IDs/content/workflows and variant inflation. If 96 reviewed paired units are not
available, stop at `hold`; never copy or rename variants to meet a threshold.

`AionisRuntime-evals` is not a Git repository, so it is a staging workspace, not
version authority. After tests pass, `scripts/archive-learning-eval.mjs` copies
the complete whitelisted harness source, package/lock metadata, fixture,
runtime-arm config, validators, and human-review manifest into a
content-addressed directory under the Git-tracked
`evals/learning-episode-gate-v1/harness/<bundle_sha256>/`. Harness mode rejects
formal holdout plaintext; it archives validators, schemas, public diagnostic
fixtures, and the sealed allocation projection only. Every report
references that harness bundle; a hash without the archived bytes is
insufficient. The same script has a separate `--kind result` contract that
archives bounded, sanitized outcome/provenance bundles under
`evals/learning-episode-gate-v1/runs/<run_bundle_sha256>/` after execution.
Harness and run digests are never interchangeable. Runtime-arm configs may name
credential environment variables, but both archive modes reject API keys,
tokens, authorization headers, raw prompts, and raw model completions. Result
mode accepts repeatable `--source` directories, writes a canonical manifest of
every included relative path/digest, caps total size, and fails on unknown or
sensitive files rather than silently skipping them. Both modes accept
repeatable `--source-file` with deterministic namespacing and collision rules;
harness mode uses it for the eval root's
`package.json` and lockfile; archiving only the `external-agent-e2e` subdirectory
is insufficient provenance.

No acceptance command executes from that mutable staging directory after the
harness archive is created. `scripts/run-learning-harness.mjs prepare` first
verifies that the content-addressed bundle is tracked at `HEAD`, materializes
its exact runnable bytes into a new isolated execution directory, runs
`npm ci --ignore-scripts` against the archived lockfile, and writes a canonical
preparation receipt binding bundle/source/package/lock/dependency-tree digests.
`run` accepts only preregistered npm script names, executes from that materialized
root, verifies all archived source bytes immediately before and after the child,
and writes a per-command receipt binding argv digest, allowlisted environment
variable names (never secret values), source/dependency digests, exit status,
bounded audit time, the resolved OS uid/gid, the runner-script digest, and the
clean Runtime Git commit containing that runner. Every paid or Runtime-facing
child is launched as the dedicated eval service account named by mandatory
`--execution-identity`, with a scrubbed environment and no supplementary groups;
identity switching or verification failure returns `hold` before execution.
For a formal broker session, the wrapper itself is spawned only by
`launch-learning-supervisor` under that execution identity with a private
inherited broker descriptor. It never accepts a descriptor path or caller attach
request, strips the descriptor before child `exec`, relays single calls locally,
seals the child output manifest, and obtains broker quiesce before it can
return. Tests prove a same-UID peer, the child, and the parent acceptance shell
cannot acquire the descriptor and that clean-exit/quiesce and in-flight-call
races follow the broker state machine.
Receipts are written atomically after the child into a wrapper-owned directory
that the eval identity cannot modify; child-writable report directories are
rejected as receipt targets. Reports are written outside the execution tree. Any
source mutation, lock/dependency mismatch, path escape, staging change, unknown
script, or execution crash/non-terminal child failure fails. A formal evidence
runner returns zero only after sealing a terminal `passed|failed|inconclusive`
bundle; verdict is asserted only after archive and ingest. The staging workspace
cannot claim an old bundle SHA by passing a string.

`archive-learning-eval.test.mjs` freezes deterministic manifest bytes/digest and
exact `--print-sha` stdout; verify success and byte-tamper failure; traversal and
symlink escape rejection; duplicate/colliding source roots/files; unknown-file
and secret-pattern rejection; per-file/total-size caps; and harness-versus-result
content-identity domain separation.
It separately freezes `result`, `termination-hold`, `preclaim-hold`,
`broker-lifecycle`, and `external-ingestion` schemas. Hold kinds reject result-
shaped ingestion content, result rejects hold-shaped authority, and lifecycle
rejects a bundle-reference cycle or coverage-final/stop bytes embedded back
into an external bundle. `external-ingestion` accepts only bounded canonical
ingest receipts, the signed evidence/operation/series-head projection, Runtime
authority-attestor launcher/database-binding/signature receipts, required-
series status, and terminal coverage. It verifies the frozen attestor public
key/key ID, service/launcher/binary/policy identities, database lineage,
authority head, schema/verifier versions, and projection signature. It requires
one receipt/artifact/head for each result branch and none for every hold/
unstarted branch, rejects raw SQLite, mutable paths, unsigned/self-signed/
copied-DB/stale-head projections, and is content-addressed under
`evals/learning-episode-gate-v1/ingestions/`.
It also freezes `append-host-run-index`, `append-checkpoint-index`, and
`write/verify-acceptance-index` golden bytes; rejects path reuse, changed prior
entries, noncontiguous/noncumulative prefixes, empty/non-64hex digests,
untracked/tampered bundles, missing/mismatched external ticket consumption,
claim, supervisor spawn/binding/execution, daemon launch/health, clean quiesce,
runner-output/public-attempt-chain, signed session termination, terminal-
manifest binding, drain/pre-stop/coverage-final/stop lifecycle,
or broker/wrapper receipts, and verifies the
checkpoint tagged union. An `evaluated` entry requires
host/integrity/reservation/online/evaluation fields; an `integrity_stop` entry
requires host/integrity/terminal-integrity/safety-authority-receipt fields and
rejects reservation/online/evaluation fields. The entire index is verified
from a fresh process with no inherited environment. Missing, untracked,
non-passing, or digest-mismatched prospective calibration artifacts also fail
index creation and verification. It rejects a terminal index ending at an
ordinary checkpoint-1/2 `evaluated:hold`; checkpoint 1/2 is terminal only with
an embedded automatic-safety receipt or non-`hold` terminal readiness, while
checkpoint 3 and `integrity_stop` are terminal.
The top-level golden union is also explicit. `checkpoint_series` requires
exactly three verified, passing external result branches, an external-ingestion
bundle proving their three protected Runtime ingests/current series heads, plus
pilot and a terminal checkpoint index; any failed/inconclusive result or hold
branch is rejected. `external_prerequisite_hold` requires at least one non-
passing result or hold branch, binds required-series status, lifecycle, and an
external-ingestion bundle proving all and only result branches were ingested,
forces verdict `hold`, and rejects pilot/active/checkpoint/evaluation/readiness
fields. It permits a truly unstarted series, but rejects any reserved-
unconsumed series; `close-reserved-run` must consume the original ticket and
record its zero-effects `operator_abort` branch first. Both modes require the same calibration scenario/recomputation and
harness-preparation bindings. Missing, duplicate, simultaneous result/claimed-
hold/pre-claim-hold coverage, a missing/extra/stale ingestion receipt or series
head, mixed early/normal fields, an uncommitted root, or a lifecycle hash cycle
fails fresh-shell verification.
The index embeds the canonical calibration-verification receipt bytes and SHA,
plus tracked artifact/scenario paths and digests. Fresh-shell `verify-index`
invokes the committed calibrator with `--require-registered
--recompute-shards`, rechecks the pending-engine commit and allowed
registration-only diff, seed/count/shard/lookup/raw-count/resource receipts,
exact bound decisions, and requires a byte-identical canonical receipt identity
projection. That projection contains source/
scenario/seed/shard/lookup/raw-count/decision/budget digests and pass bits.
Invocation time, measured duration, and peak RSS are signed audit metadata
outside that identity projection; every fresh recomputation must independently
remain within the frozen budget. Scenario, RNG, raw count, engine, registry, or
resource drift fails.
`assert-diagnostic-pass` reads only a verified, tracked content-addressed run
bundle. For `--kind aa` it requires both named before/after-restart phases,
matching run/applicability/harness identities, terminal `passed` status, 100%
ledger coverage, stable normalized served output/assignment, and zero integrity
findings. Failed/inconclusive, missing phase, mutable path, or untracked bundle
returns nonzero after preserving the terminal bundle. For
`--kind fixture_pilot`, it additionally requires a terminal pass, exact
fixture-principal classification, complete operation/episode/receipt
reconciliation, and the archived namespace-disjointness digest.
`run-learning-harness.test.mjs` covers committed-bundle enforcement,
materialization determinism, pre/post-run tamper, a changed staging workspace,
command/path allowlists, archived lock/dependency mismatch, secret-value
redaction, required uid/gid switching with no supplementary groups, identity
failure before child execution, dirty/untracked runner rejection, runner-digest
or Git-commit drift, child-writable receipt-target rejection, atomic receipt
write, crash/non-terminal child exit, terminal non-pass preservation, receipt
replay/verification, acceptance-index rematerialization, and immutable-model
snapshot/deterministic-kernel validation. Golden failures cover
`immutable_snapshot=false`, `provider_may_update_weights=true`, mutable model or
tool digests, and response-fingerprint drift.

```bash
cd /Volumes/ziel/new.aionis/AionisRuntime-evals
npm run -s external-agent-e2e:harness-test
npm run -s external-agent-e2e:validate-traps -- \
  --manifest external-agent-e2e/fixtures/learning-episode-gate-v1.jsonl
npm run -s external-agent-e2e:triage-traps -- \
  --manifest external-agent-e2e/fixtures/learning-episode-gate-v1.jsonl
npm run -s external-agent-e2e:preflight-traps -- \
  --manifest external-agent-e2e/fixtures/learning-episode-gate-v1.jsonl
npm run -s external-agent-e2e:learning-evidence -- --check-only \
  --manifest external-agent-e2e/fixtures/learning-episode-gate-v1.jsonl \
  --runtime-arm-config external-agent-e2e/configs/learning-episode-gate-v1-runtime-arms.json

cd /Volumes/ziel/new.aionis/AionisRuntime-focused
node --test scripts/ci/archive-learning-eval.test.mjs
node --test scripts/ci/run-learning-harness.test.mjs
node --test scripts/ci/learning-acceptance-runtime.test.mjs
node --test scripts/ci/formal-learning-run-broker.test.mjs
node --test scripts/ci/seal-learning-external-prerequisites.test.mjs
node --test scripts/ci/runtime-authority-attestor.test.mjs
HARNESS_BUNDLE_SHA="$(node scripts/archive-learning-eval.mjs \
  --kind harness --print-sha \
  --source /Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e \
  --source-file /Volumes/ziel/new.aionis/AionisRuntime-evals/package.json \
  --source-file /Volumes/ziel/new.aionis/AionisRuntime-evals/package-lock.json \
  --out evals/learning-episode-gate-v1/harness)"
node scripts/archive-learning-eval.mjs \
  --verify "evals/learning-episode-gate-v1/harness/$HARNESS_BUNDLE_SHA"
git add scripts/archive-learning-eval.mjs \
  scripts/ci/archive-learning-eval.test.mjs \
  scripts/run-learning-harness.mjs \
  scripts/ci/run-learning-harness.test.mjs \
  scripts/learning-acceptance-runtime.mjs \
  scripts/ci/learning-acceptance-runtime.test.mjs \
  scripts/seal-learning-external-prerequisites.mjs \
  scripts/ci/seal-learning-external-prerequisites.test.mjs \
  evals/learning-episode-gate-v1/README.md \
  "evals/learning-episode-gate-v1/harness/$HARNESS_BUNDLE_SHA"
git commit -m "test(eval): freeze learning evidence harness"
HARNESS_BUNDLE_DIR="evals/learning-episode-gate-v1/harness/$HARNESS_BUNDLE_SHA"
HARNESS_WORK_DIR=/absolute/path/to/isolated-learning-harness-execution
HARNESS_EXEC_DIR="$HARNESS_WORK_DIR/materialized"
HARNESS_EXEC_PREP_RECEIPT="$HARNESS_WORK_DIR/preparation.json"
EVAL_IDENTITY=aionis-learning-eval
node scripts/run-learning-harness.mjs prepare \
  --bundle "$HARNESS_BUNDLE_DIR" --exec-dir "$HARNESS_EXEC_DIR" \
  --execution-identity "$EVAL_IDENTITY" \
  --receipt-out "$HARNESS_EXEC_PREP_RECEIPT"
node scripts/run-learning-harness.mjs verify \
  --bundle "$HARNESS_BUNDLE_DIR" --exec-dir "$HARNESS_EXEC_DIR" \
  --execution-identity "$EVAL_IDENTITY" \
  --receipt "$HARNESS_EXEC_PREP_RECEIPT"
```

Run no paid model call until every listed harness/source/manifest/archiver check
and archive verification passes.

`scripts/learning-acceptance-runtime.mjs` is the checked-in process supervisor
for the remaining commands. `prepare` verifies and copies a reviewed source DB
into an isolated work directory, records source/copy digests and Runtime commit,
and refuses a production path. `start/restart/status/stop` own PID/log/health
files for a named endpoint and explicit profile-rule file; `clone-pair` uses
SQLite backup/restore to create two byte-identical DB copies and proves their
pre-start digests. `clone-one` creates one digest-bound pilot copy and can
validate a pilot namespace manifest is disjoint from the active applicability
set. `status --expect-stopped` proves a named authority process is absent
without guessing its PID-file layout. The paired runner uses a `fresh-pair`
lifecycle that restores two copies per base task, and
`status --expect-no-children` proves cleanup. Its tests kill/restart child processes,
reject production/output aliases,
prove clone/disjointness checks, inject cross-unit contamination, and prove the
next pair still begins at the frozen source digest. `audit-holdout` tests task,
content/workflow, scope, source-event, and existing-ledger/memory collisions
between A/A and paired inputs. No
step relies on an unexplained Runtime already listening on port 3001.

**Step 3: Prove real A/A, provision active applicability, then new shadow**

Run one explicitly provisioned immutable `aa` revision against a supervised real
Runtime with the dedicated fixture principal, restart the same named process and
DB, then resume the same run/config. Require identical normalized served
surfaces/agent context (not trace IDs), stable assignment, exact operation
replay, 100% ledger coverage, zero assignment-integrity findings, and zero
assignment-randomness leakage. The reviewed A/A
fixture manifest contains at least 64 distinct canonical store namespaces and
maps one independent base task to each with task/content/workflow/source-event
digests; a 50/50 A/A run must observe at least 16
distinct namespaces in both arms. Task/signature rows inside a namespace never
count again. A/A is rollout integrity only.

```bash
set -euo pipefail
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
ACCEPTANCE_DIR=/absolute/path/to/isolated-learning-acceptance
HARNESS_EXECUTION_RECEIPT_DIR="$ACCEPTANCE_DIR/harness-execution-receipts"
SOURCE_DB=/absolute/path/to/reviewed-nonproduction-v3.sqlite
RUNTIME_DB="$ACCEPTANCE_DIR/runtime.sqlite"
TENANT=<tenant-id>
FORMAL_RUN_BROKER=/Volumes/ziel/new.aionis/AionisRuntime-focused/scripts/formal-learning-run-broker.mjs
FORMAL_NODE=/absolute/path/to/reviewed-node
BROKER_SERVICE_LAUNCHER=/absolute/path/to/reviewed-dedicated-service-launcher
BROKER_SERVICE_IDENTITY=aionis-formal-run-broker
RUNTIME_AUTHORITY_ATTESTOR=/Volumes/ziel/new.aionis/AionisRuntime-focused/scripts/runtime-authority-attestor.mjs
RUNTIME_AUTHORITY_ATTESTOR_LAUNCHER=/absolute/path/to/reviewed-runtime-authority-attestor-launcher
RUNTIME_AUTHORITY_ATTESTOR_SERVICE_IDENTITY=aionis-runtime-authority-attestor
RUNTIME_AUTHORITY_ATTESTOR_POLICY=/secure/path/to/runtime-authority-attestor-policy.json
RUNTIME_AUTHORITY_DB_SLOT=<registered-acceptance-authority-db-slot>
RUNTIME_AUTHORITY_DB_BINDING_RECEIPT="$ACCEPTANCE_DIR/runtime-authority/db-binding.json"
RUNTIME_AUTHORITY_ATTESTOR_RECEIPT="$ACCEPTANCE_DIR/runtime-authority/external-ingestion-attestation.json"
BROKER_SOCKET="$ACCEPTANCE_DIR/formal-run-broker/broker.sock"
BROKER_STATE_ROOT="$ACCEPTANCE_DIR/external-reservations/private/broker-state"
BROKER_TERMINAL_FACT_SPOOL="$ACCEPTANCE_DIR/external-reservations/private/terminal-fact-spool"
BROKER_PUBLIC_TERMINAL_FACT_DIR="$ACCEPTANCE_DIR/formal-run-broker/public-terminal-facts"
BROKER_SERVICE_LAUNCH_RECEIPT="$ACCEPTANCE_DIR/formal-run-broker/service-launch.json"
BROKER_IDENTITY_RECEIPT="$ACCEPTANCE_DIR/formal-run-broker/identity-health.json"
BROKER_DRAIN_RECEIPT="$ACCEPTANCE_DIR/formal-run-broker/terminal-fact-drain.json"
BROKER_PRESTOP_STATUS_RECEIPT="$ACCEPTANCE_DIR/formal-run-broker/pre-stop-status.json"
BROKER_COVERAGE_INDEX="$ACCEPTANCE_DIR/formal-run-broker/terminal-coverage-index.json"
BROKER_COVERAGE_FINAL_RECEIPT="$ACCEPTANCE_DIR/formal-run-broker/coverage-final-status.json"
BROKER_SERVICE_STOP_RECEIPT="$ACCEPTANCE_DIR/formal-run-broker/service-stop.json"
BROKER_RECOVERY_REQUIRED_RECEIPT="$ACCEPTANCE_DIR/formal-run-broker/recovery-required.json"
EXTERNAL_RECOVERY_PLAN=/secure/path/to/frozen-external-prerequisite-recovery-plan.json
RECOVERY_DIR="$ACCEPTANCE_DIR/external-prerequisite-recovery"
RECOVERY_PREPARED_PLAN="$RECOVERY_DIR/prepared-sealing-plan.json"
RECOVERY_GIT_PATHSPEC="$RECOVERY_DIR/prepared-bundle-pathspec.nul"
RECOVERY_COMMAND=(
  node /Volumes/ziel/new.aionis/AionisRuntime-focused/scripts/seal-learning-external-prerequisites.mjs
  prepare-recovery --plan "$EXTERNAL_RECOVERY_PLAN"
  --broker "$FORMAL_RUN_BROKER" --broker-socket "$BROKER_SOCKET"
  --service-launcher "$BROKER_SERVICE_LAUNCHER"
  --db "$RUNTIME_DB" --tenant "$TENANT"
  --public-terminal-fact-dir "$BROKER_PUBLIC_TERMINAL_FACT_DIR"
  --drain-receipt-out "$BROKER_DRAIN_RECEIPT"
  --pre-stop-status-out "$BROKER_PRESTOP_STATUS_RECEIPT"
  --archive-root /Volumes/ziel/new.aionis/AionisRuntime-focused/evals/learning-episode-gate-v1
  --prepared-plan-out "$RECOVERY_PREPARED_PLAN"
  --git-pathspec-out "$RECOVERY_GIT_PATHSPEC"
)
printf -v RECOVERY_COMMAND_SHELL '%q ' "${RECOVERY_COMMAND[@]}"
BROKER_STOPPED=0
cleanup_learning_acceptance() {
  set +e
  node /Volumes/ziel/new.aionis/AionisRuntime-focused/scripts/learning-acceptance-runtime.mjs \
    stop --all --work-dir "$ACCEPTANCE_DIR"
  if test "$BROKER_STOPPED" = 1
  then
    return
  fi
  "$FORMAL_RUN_BROKER" revoke-all \
    --broker-socket "$BROKER_SOCKET" --reason operator_revoke
  if ! "$FORMAL_RUN_BROKER" drain-terminal-facts \
    --broker-socket "$BROKER_SOCKET" --db "$RUNTIME_DB" \
    --tenant "$TENANT" --actor formal-run-broker \
    --public-terminal-fact-dir "$BROKER_PUBLIC_TERMINAL_FACT_DIR" \
    --drain-receipt-out "$BROKER_DRAIN_RECEIPT"
  then
    "$BROKER_SERVICE_LAUNCHER" ensure-running \
      --launch-receipt "$BROKER_SERVICE_LAUNCH_RECEIPT" \
      --recovery-command "$RECOVERY_COMMAND_SHELL" \
      --incident-out "$BROKER_RECOVERY_REQUIRED_RECEIPT"
    return 1
  fi
  "$BROKER_SERVICE_LAUNCHER" ensure-running \
    --launch-receipt "$BROKER_SERVICE_LAUNCH_RECEIPT" \
    --recovery-command "$RECOVERY_COMMAND_SHELL" \
    --incident-out "$BROKER_RECOVERY_REQUIRED_RECEIPT"
  return 1
}
trap cleanup_learning_acceptance EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
TASK_FAMILY=<task-family>
AA_PROFILE_RULE=/absolute/path/to/aa-profile-rule.json
AA_EXPERIMENT_ID=<aa-experiment-id>
AA_REVISION=1
AA_APPLICABILITY_MANIFEST="$ACCEPTANCE_DIR/aa-applicability.json"
AA_NAMESPACE_MANIFEST=/absolute/path/to/reviewed-aa-fixture-namespaces.json
ACTIVE_NAMESPACE_MANIFEST=/secure/path/to/reviewed-active-memory-namespaces.json
FORMAL_HOLDOUT_SEALED_REF=sealed-holdout://learning-gate-v1/<allocation-id>
FORMAL_HOLDOUT_MEMBERSHIP_PROJECTION=/secure/path/to/holdout-membership-projection.json
node scripts/learning-acceptance-runtime.mjs prepare \
  --source-db "$SOURCE_DB" --work-dir "$ACCEPTANCE_DIR" \
  --runtime-db "$RUNTIME_DB" --out "$ACCEPTANCE_DIR/prepare-manifest.json"
mkdir -p "$ACCEPTANCE_DIR/runtime-authority"
"$RUNTIME_AUTHORITY_ATTESTOR_LAUNCHER" inspect-database-binding \
  --deployment-slot "$RUNTIME_AUTHORITY_DB_SLOT" \
  --expect-database "$RUNTIME_DB" \
  --service-identity "$RUNTIME_AUTHORITY_ATTESTOR_SERVICE_IDENTITY" \
  --policy "$RUNTIME_AUTHORITY_ATTESTOR_POLICY" \
  --out "$RUNTIME_AUTHORITY_DB_BINDING_RECEIPT"
"$BROKER_SERVICE_LAUNCHER" start-ephemeral \
  --service-identity "$BROKER_SERVICE_IDENTITY" \
  --exec "$FORMAL_RUN_BROKER" --subcommand serve \
  --broker-socket "$BROKER_SOCKET" --state-root "$BROKER_STATE_ROOT" \
  --terminal-fact-spool "$BROKER_TERMINAL_FACT_SPOOL" \
  --out "$BROKER_SERVICE_LAUNCH_RECEIPT"
"$FORMAL_RUN_BROKER" status \
  --broker-socket "$BROKER_SOCKET" --db "$RUNTIME_DB" --tenant "$TENANT" \
  --expect-service-identity "$BROKER_SERVICE_IDENTITY" \
  --state-root "$BROKER_STATE_ROOT" \
  --terminal-fact-spool "$BROKER_TERMINAL_FACT_SPOOL" \
  --out "$BROKER_IDENTITY_RECEIPT"
GATE_CALIBRATION_ARTIFACT=docs/research/2026-07-13-learning-gate-policy-v1-calibration.json
GATE_CALIBRATION_SCENARIO_MANIFEST=docs/research/2026-07-13-learning-gate-policy-v1-calibration-scenarios.json
GATE_CALIBRATION_VERIFICATION_RECEIPT="$ACCEPTANCE_DIR/gate-calibration-verification.json"
npx tsx scripts/learning-gate-calibration.ts verify \
  --artifact "$GATE_CALIBRATION_ARTIFACT" \
  --scenario-manifest "$GATE_CALIBRATION_SCENARIO_MANIFEST" \
  --gate-policy gate-policy-v1 --require-registered \
  --recompute-shards --reject-runtime-db --reject-evidence-inputs \
  --receipt-out "$GATE_CALIBRATION_VERIFICATION_RECEIPT"
PAIRED_BASE_DIR="$ACCEPTANCE_DIR/pristine-paired-base"
PAIRED_BASE_DB="$PAIRED_BASE_DIR/base.sqlite"
PAIRED_BASE_AUDIT_PROJECTION="$PAIRED_BASE_DIR/isolation-audit-projection.json"
node scripts/learning-acceptance-runtime.mjs clone-one \
  --source-db "$RUNTIME_DB" --out-db "$PAIRED_BASE_DB" \
  --manifest-out "$PAIRED_BASE_DIR/clone-manifest.json"
node scripts/learning-acceptance-runtime.mjs audit-holdout \
  --db "$PAIRED_BASE_DB" \
  --case-membership-projection "$FORMAL_HOLDOUT_MEMBERSHIP_PROJECTION" \
  --exclude-manifest "$AA_NAMESPACE_MANIFEST" \
  --future-active-namespace-manifest "$ACTIVE_NAMESPACE_MANIFEST" \
  --projection-out "$PAIRED_BASE_AUDIT_PROJECTION" \
  --out "$PAIRED_BASE_DIR/holdout-cleanliness.json" \
  --require-zero-task-content-workflow-scope-source-overlap \
  --require-aa-active-namespace-source-memory-disjoint \
  --require-zero-existing-ledger-or-memory-overlap
npx tsx scripts/learning-experiment.ts provision \
  --db "$RUNTIME_DB" --tenant "$TENANT" --actor acceptance-provisioner \
  --operation-id "provision:$AA_EXPERIMENT_ID:$AA_REVISION" \
  --profile-rule-file "$AA_PROFILE_RULE" \
  --task-family "$TASK_FAMILY" \
  --experiment-id "$AA_EXPERIMENT_ID" --revision "$AA_REVISION" \
  --out "$AA_APPLICABILITY_MANIFEST"
node scripts/learning-acceptance-runtime.mjs start \
  --name aa --work-dir "$ACCEPTANCE_DIR" --db "$RUNTIME_DB" --port 3001 \
  --profile-rule-file "$AA_PROFILE_RULE" \
  --env-file /absolute/path/to/acceptance-secrets.env

AA_RUN_ID="learning-aa-<utc>"
AA_REPORT_DIR=/absolute/path/to/learning-aa-report
AIONIS_API_KEY=<fixture-pilot-key> AIONIS_BASE_URL=http://127.0.0.1:3001 \
  node scripts/run-learning-harness.mjs run \
    --bundle "$HARNESS_BUNDLE_DIR" --exec-dir "$HARNESS_EXEC_DIR" \
    --execution-identity "$EVAL_IDENTITY" \
    --receipt-out "$HARNESS_EXECUTION_RECEIPT_DIR/aa-before-restart.json" -- \
    npm run -s external-agent-e2e:learning-evidence -- \
    --mode aa --pass before-restart --run-id "$AA_RUN_ID" \
    --report-dir "$AA_REPORT_DIR" \
    --memory-namespace-manifest "$AA_NAMESPACE_MANIFEST" \
    --applicability-manifest "$AA_APPLICABILITY_MANIFEST" \
    --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA"
node scripts/learning-acceptance-runtime.mjs restart \
  --name aa --work-dir "$ACCEPTANCE_DIR"
AIONIS_API_KEY=<fixture-pilot-key> AIONIS_BASE_URL=http://127.0.0.1:3001 \
  node scripts/run-learning-harness.mjs run \
    --bundle "$HARNESS_BUNDLE_DIR" --exec-dir "$HARNESS_EXEC_DIR" \
    --execution-identity "$EVAL_IDENTITY" \
    --receipt-out "$HARNESS_EXECUTION_RECEIPT_DIR/aa-after-restart.json" -- \
    npm run -s external-agent-e2e:learning-evidence -- \
    --mode aa --pass after-restart --resume --run-id "$AA_RUN_ID" \
    --report-dir "$AA_REPORT_DIR" \
    --memory-namespace-manifest "$AA_NAMESPACE_MANIFEST" \
    --applicability-manifest "$AA_APPLICABILITY_MANIFEST" \
    --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA"
AA_RUN_BUNDLE_SHA="$(node scripts/archive-learning-eval.mjs \
  --kind result --print-sha --source "$AA_REPORT_DIR" \
  --source-file "$AA_PROFILE_RULE" \
  --source-file "$AA_NAMESPACE_MANIFEST" \
  --source-file "$AA_APPLICABILITY_MANIFEST" \
  --source-file "$PAIRED_BASE_AUDIT_PROJECTION" \
  --source-file "$PAIRED_BASE_DIR/holdout-cleanliness.json" \
  --source-file "$ACCEPTANCE_DIR/prepare-manifest.json" \
  --source-file "$HARNESS_EXEC_PREP_RECEIPT" \
  --source-file "$HARNESS_EXECUTION_RECEIPT_DIR/aa-before-restart.json" \
  --source-file "$HARNESS_EXECUTION_RECEIPT_DIR/aa-after-restart.json" \
  --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA" \
  --out evals/learning-episode-gate-v1/runs)"
node scripts/archive-learning-eval.mjs \
  --verify "evals/learning-episode-gate-v1/runs/$AA_RUN_BUNDLE_SHA"
git add "evals/learning-episode-gate-v1/runs/$AA_RUN_BUNDLE_SHA"
git commit -m "test(learning): seal terminal aa evidence"
if ! node scripts/archive-learning-eval.mjs assert-diagnostic-pass \
  --kind aa \
  --run-bundle "evals/learning-episode-gate-v1/runs/$AA_RUN_BUNDLE_SHA" \
  --run-id "$AA_RUN_ID" \
  --applicability-manifest "$AA_APPLICABILITY_MANIFEST" \
  --required-phase before-restart --required-phase after-restart
then
  node scripts/learning-acceptance-runtime.mjs stop \
    --name aa --work-dir "$ACCEPTANCE_DIR"
  exit 1
fi
```

Only after A/A passes, provision the future fixed-design
`active_control/confirmatory` revision while it is still fixture-only. This
atomically claims the candidate implementation's sole task-family confirmatory
attempt, draws the hidden assignment bits, acquires the full finite namespace lease set,
and emits the exact applicability manifest before any prerequisite report while
freezing all four evidence-series IDs. The reviewed production namespace
manifest must contain 384 reviewed pre-outcome matched pairs/768 genuinely
disjoint existing store scopes with frozen 96/96/192-pair activation waves;
one direct bit assigns exactly one member of each pair to each arm. Task
variants, repositories, and signatures inside one store scope do not add units.
If this capacity is unavailable, stop at `hold`. Then provision/deploy a new immutable `shadow` revision with the same
registered candidate/gate definitions. A named production host adapter must
pass task-envelope/use-receipt conformance under a separate eligible-host
principal and frozen verifier policy. Collect genuine current shadow traffic;
fixture data or the historical June gate cannot stand in. If no reviewed host
adapter is available, stop at `hold`.

All prerequisite execution is isolated from the authority DB. After A/A,
stop that writer and freeze a prerequisite base clone **before** acquiring the
authority DB's active namespace leases. Shadow, tool, and paired suites each
receive isolated clones; shadow and tool descend from this post-A/A prerequisite
base, while paired units descend only from the pristine pre-A/A holdout base
frozen above. None can touch or pause the authority attempt. Their clone
manifests, holdout-cleanliness result, and applicable/source configuration
digests are part of the corresponding run bundles.

Before active provisioning, assemble the external-input set for all three
roles. It binds the sealed 96-case membership projection and sealed-object
reference/ciphertext/source digests, pristine/prerequisite source snapshots,
genuinely immutable model/runtime snapshot, deterministic execution profile,
tool/order manifests, retry policies, and planned run IDs.
It also binds `EXTERNAL_RECOVERY_PLAN`, whose three role records freeze those
same run/reservation identities, allowlisted result-source manifests, public-
authority/output destinations, and archive kinds; recovery may not add a source
after an outcome.
Provisioning validates it against the registry execution policy. With the
current mutable DeepSeek profiles this step must return `hold`; the remaining
commands are the runbook for the future immutable snapshot, not permission to
bypass that prerequisite.

```bash
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
node scripts/learning-acceptance-runtime.mjs stop \
  --name aa --work-dir "$ACCEPTANCE_DIR"
PREREQ_DIR="$ACCEPTANCE_DIR/prerequisites"
PREREQ_BASE_DB="$PREREQ_DIR/base.sqlite"
node scripts/learning-acceptance-runtime.mjs clone-one \
  --source-db "$RUNTIME_DB" --out-db "$PREREQ_BASE_DB" \
  --manifest-out "$PREREQ_DIR/base-clone-manifest.json"
ACTIVE_PROFILE_RULE=/absolute/path/to/active-control-profile-rule.json
ACTIVE_EXPERIMENT_ID=<active-experiment-id>
ACTIVE_REVISION=1
ACTIVE_APPLICABILITY_MANIFEST="$ACCEPTANCE_DIR/active-applicability.json"
PREREGISTERED_EXTERNAL_INPUT_SET=/secure/path/to/preregistered-external-input-set.json
npx tsx scripts/learning-experiment.ts provision \
  --db "$RUNTIME_DB" --tenant "$TENANT" --actor acceptance-provisioner \
  --operation-id "provision:$ACTIVE_EXPERIMENT_ID:$ACTIVE_REVISION" \
  --profile-rule-file "$ACTIVE_PROFILE_RULE" \
  --memory-namespace-manifest "$ACTIVE_NAMESPACE_MANIFEST" \
  --external-input-set "$PREREGISTERED_EXTERNAL_INPUT_SET" \
  --external-recovery-plan "$EXTERNAL_RECOVERY_PLAN" \
  --task-family "$TASK_FAMILY" \
  --experiment-id "$ACTIVE_EXPERIMENT_ID" --revision "$ACTIVE_REVISION" \
  --out "$ACTIVE_APPLICABILITY_MANIFEST"
SHADOW_PROFILE_RULE=/absolute/path/to/shadow-profile-rule.json
SHADOW_EXPERIMENT_ID=<shadow-experiment-id>
SHADOW_REVISION=1
SHADOW_APPLICABILITY_MANIFEST="$ACCEPTANCE_DIR/shadow-applicability.json"
SHADOW_DB="$PREREQ_DIR/shadow.sqlite"
node scripts/learning-acceptance-runtime.mjs clone-one \
  --source-db "$PREREQ_BASE_DB" --out-db "$SHADOW_DB" \
  --manifest-out "$PREREQ_DIR/shadow-clone-manifest.json"
npx tsx scripts/learning-experiment.ts provision \
  --db "$SHADOW_DB" --tenant "$TENANT" --actor acceptance-provisioner \
  --operation-id "provision:$SHADOW_EXPERIMENT_ID:$SHADOW_REVISION" \
  --profile-rule-file "$SHADOW_PROFILE_RULE" \
  --task-family "$TASK_FAMILY" \
  --experiment-id "$SHADOW_EXPERIMENT_ID" --revision "$SHADOW_REVISION" \
  --out "$SHADOW_APPLICABILITY_MANIFEST"
node scripts/learning-acceptance-runtime.mjs start \
  --name shadow --work-dir "$ACCEPTANCE_DIR" --db "$SHADOW_DB" --port 3001 \
  --profile-rule-file "$SHADOW_PROFILE_RULE" \
  --env-file /absolute/path/to/acceptance-secrets.env
HOST_RECEIPT_MANIFEST=/absolute/path/to/sanitized-host-adapter-conformance.jsonl
HOST_CONFORMANCE_RESULT="$ACCEPTANCE_DIR/host-adapter-conformance.json"
HOST_ADAPTER_CTL=/absolute/path/to/reviewed-production-host-adapter-control
HOST_ADAPTER_IDENTITY=aionis-host-adapter
EVAL_IDENTITY=aionis-learning-eval
HOST_SECRET_REF=secret-manager://aionis/eligible-host/runtime-principal
HOST_IDENTITY_BOUNDARY_RESULT="$ACCEPTANCE_DIR/host-identity-boundary.json"
HOST_SHADOW_RUN_DIR="$ACCEPTANCE_DIR/current-shadow-host-run"
EXTERNAL_RESERVATION_DIR="$ACCEPTANCE_DIR/external-reservations"
SHADOW_RUN_ID="$(node -p 'require(process.argv[1]).roles.production_shadow.planned_run_id' "$EXTERNAL_RECOVERY_PLAN")"
SHADOW_EXTERNAL_INPUT_MANIFEST=/secure/path/to/shadow-external-input-manifest.json
SHADOW_RETRY_POLICY=/secure/path/to/formal-shadow-retry-policy.json
SHADOW_RESERVATION="$EXTERNAL_RESERVATION_DIR/shadow-reservation.json"
SHADOW_TICKET_CONSUMPTION="$EXTERNAL_RESERVATION_DIR/shadow-ticket-consumption.json"
SHADOW_CLAIM="$EXTERNAL_RESERVATION_DIR/shadow-claim.json"
SHADOW_BROKER_RECEIPT="$EXTERNAL_RESERVATION_DIR/shadow-broker-conformance.json"
SHADOW_SUPERVISOR_ARGV_MANIFEST=/secure/path/to/shadow-supervisor-argv-manifest.json
SHADOW_SUPERVISOR_SPAWN_RECEIPT="$EXTERNAL_RESERVATION_DIR/shadow-supervisor-spawn.json"
SHADOW_SUPERVISOR_BINDING="$EXTERNAL_RESERVATION_DIR/shadow-supervisor-binding.json"
SHADOW_SUPERVISOR_EXECUTION_RECEIPT="$EXTERNAL_RESERVATION_DIR/shadow-supervisor-execution.json"
SHADOW_BROKER_QUIESCE_RECEIPT="$EXTERNAL_RESERVATION_DIR/shadow-broker-quiesce.json"
SHADOW_PUBLIC_ATTEMPT_CHAIN="$EXTERNAL_RESERVATION_DIR/shadow-attempt-chain.jsonl"
SHADOW_BROKER_TERMINAL_RECEIPT="$EXTERNAL_RESERVATION_DIR/shadow-broker-terminal.json"
SHADOW_SESSION_TERMINATION="$EXTERNAL_RESERVATION_DIR/shadow-session-termination.json"
SHADOW_VALIDATION_DIR=/absolute/path/to/current-shadow-host-validation
SHADOW_DATASET_DIR=/absolute/path/to/current-shadow-dataset
SHADOW_REPORT_DIR=/absolute/path/to/current-shadow-gate
npx tsx scripts/learning-host-receipt.ts verify \
  --manifest "$HOST_RECEIPT_MANIFEST" --collector-id <collector-id> \
  --collector-version <collector-version> \
  --verifier-policy-sha256 <verifier-policy-sha256> \
  --out "$HOST_CONFORMANCE_RESULT"

"$FORMAL_RUN_BROKER" reserve-learning-run \
  --broker-socket "$BROKER_SOCKET" \
  --db "$RUNTIME_DB" --tenant "$TENANT" --actor evidence-reserver \
  --operation-id "reserve-external:shadow:$SHADOW_RUN_ID" \
  --kind production_shadow_gate --series-id <shadow-series-id> \
  --task-family "$TASK_FAMILY" \
  --applicable-experiment-id "$ACTIVE_EXPERIMENT_ID" \
  --applicable-revision "$ACTIVE_REVISION" \
  --immutable-input-manifest "$SHADOW_EXTERNAL_INPUT_MANIFEST" \
  --retry-policy "$SHADOW_RETRY_POLICY" --run-id "$SHADOW_RUN_ID" \
  --reservation-out "$SHADOW_RESERVATION"
"$FORMAL_RUN_BROKER" claim-learning-run \
  --broker-socket "$BROKER_SOCKET" \
  --db "$RUNTIME_DB" --tenant "$TENANT" --actor formal-run-broker \
  --consume-operation-id "consume-external:shadow:$SHADOW_RUN_ID" \
  --reservation "$SHADOW_RESERVATION" \
  --runner-identity "$HOST_ADAPTER_IDENTITY" \
  --credential-secret-ref "$HOST_SECRET_REF" \
  --ticket-consumption-out "$SHADOW_TICKET_CONSUMPTION" \
  --claim-out "$SHADOW_CLAIM" \
  --broker-conformance-receipt-out "$SHADOW_BROKER_RECEIPT"

"$FORMAL_RUN_BROKER" launch-learning-supervisor \
  --broker-socket "$BROKER_SOCKET" --db "$RUNTIME_DB" --tenant "$TENANT" \
  --reservation "$SHADOW_RESERVATION" \
  --ticket-consumption "$SHADOW_TICKET_CONSUMPTION" --claim "$SHADOW_CLAIM" \
  --runner-identity "$HOST_ADAPTER_IDENTITY" \
  --supervisor-executable "$HOST_ADAPTER_CTL" \
  --supervisor-argv-manifest "$SHADOW_SUPERVISOR_ARGV_MANIFEST" \
  --service-launcher "$BROKER_SERVICE_LAUNCHER" \
  --supervisor-spawn-receipt-out "$SHADOW_SUPERVISOR_SPAWN_RECEIPT" \
  --supervisor-binding-out "$SHADOW_SUPERVISOR_BINDING" \
  --supervisor-execution-receipt-out "$SHADOW_SUPERVISOR_EXECUTION_RECEIPT" \
  --runner-output-manifest "$HOST_SHADOW_RUN_DIR/run-manifest.json" \
  --broker-quiesce-receipt-out "$SHADOW_BROKER_QUIESCE_RECEIPT" \
  --public-attempt-chain-out "$SHADOW_PUBLIC_ATTEMPT_CHAIN" -- \
"$HOST_ADAPTER_CTL" collect-learning-shadow \
  --adapter-identity "$HOST_ADAPTER_IDENTITY" \
  --eval-identity "$EVAL_IDENTITY" \
  --require-eval-secret-read-denied \
  --require-eval-eligible-principal-call-denied \
  --require-adapter-positive-call \
  --identity-boundary-out "$HOST_IDENTITY_BOUNDARY_RESULT" \
  --base-url http://127.0.0.1:3001 \
  --source-applicability-manifest "$SHADOW_APPLICABILITY_MANIFEST" \
  --runtime-clone-manifest "$PREREQ_DIR/shadow-clone-manifest.json" \
  --run-id "$SHADOW_RUN_ID" \
  --external-reservation "$SHADOW_RESERVATION" \
  --external-ticket-consumption "$SHADOW_TICKET_CONSUMPTION" \
  --external-claim "$SHADOW_CLAIM" \
  --runner-output-manifest "$HOST_SHADOW_RUN_DIR/run-manifest.json" \
  --sealed-sanitized-out "$HOST_SHADOW_RUN_DIR" \
  --readable-by "$EVAL_IDENTITY"

node scripts/run-learning-harness.mjs run \
  --bundle "$HARNESS_BUNDLE_DIR" --exec-dir "$HARNESS_EXEC_DIR" \
  --execution-identity "$EVAL_IDENTITY" \
  --receipt-out "$HARNESS_EXECUTION_RECEIPT_DIR/shadow-validation.json" -- \
  npm run -s external-agent-e2e:learning-evidence -- \
  --mode validate-shadow-adapter --input "$HOST_SHADOW_RUN_DIR" \
  --report-dir "$SHADOW_VALIDATION_DIR" \
  --source-applicability-manifest "$SHADOW_APPLICABILITY_MANIFEST" \
  --applicability-manifest "$ACTIVE_APPLICABILITY_MANIFEST" \
  --runtime-clone-manifest "$PREREQ_DIR/shadow-clone-manifest.json" \
  --external-reservation "$SHADOW_RESERVATION" \
  --external-ticket-consumption "$SHADOW_TICKET_CONSUMPTION" \
  --external-claim "$SHADOW_CLAIM" \
  --external-supervisor-binding "$SHADOW_SUPERVISOR_BINDING" \
  --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA"

npx tsx scripts/learning-evidence.ts export-shadow \
  --db "$SHADOW_DB" --tenant "$TENANT" --actor shadow-exporter \
  --task-family "$TASK_FAMILY" --experiment-id "$SHADOW_EXPERIMENT_ID" \
  --revision "$SHADOW_REVISION" --out-dir "$SHADOW_DATASET_DIR"
npm run -s admission:production-gate -- \
  --dataset-dir "$SHADOW_DATASET_DIR" --out-dir "$SHADOW_REPORT_DIR" \
  --applicability-manifest "$ACTIVE_APPLICABILITY_MANIFEST" \
  --host-conformance "$HOST_CONFORMANCE_RESULT" \
  --host-identity-boundary "$HOST_IDENTITY_BOUNDARY_RESULT" \
  --runtime-clone-manifest "$PREREQ_DIR/shadow-clone-manifest.json" \
  --external-reservation "$SHADOW_RESERVATION" \
  --external-ticket-consumption "$SHADOW_TICKET_CONSUMPTION" \
  --external-claim "$SHADOW_CLAIM" \
  --external-supervisor-binding "$SHADOW_SUPERVISOR_BINDING" \
  --broker-quiesce-receipt "$SHADOW_BROKER_QUIESCE_RECEIPT" \
  --public-attempt-chain "$SHADOW_PUBLIC_ATTEMPT_CHAIN" \
  --harness-exec-preparation "$HARNESS_EXEC_PREP_RECEIPT" \
  --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA"
"$FORMAL_RUN_BROKER" finalize-learning-run \
  --broker-socket "$BROKER_SOCKET" \
  --db "$RUNTIME_DB" --tenant "$TENANT" --actor formal-run-broker \
  --reservation "$SHADOW_RESERVATION" \
  --ticket-consumption "$SHADOW_TICKET_CONSUMPTION" \
  --claim "$SHADOW_CLAIM" \
  --supervisor-binding "$SHADOW_SUPERVISOR_BINDING" \
  --broker-quiesce-receipt "$SHADOW_BROKER_QUIESCE_RECEIPT" \
  --public-attempt-chain "$SHADOW_PUBLIC_ATTEMPT_CHAIN" \
  --terminal-run-manifest "$SHADOW_REPORT_DIR/run-manifest.json" \
  --broker-terminal-receipt-out "$SHADOW_BROKER_TERMINAL_RECEIPT" \
  --session-termination-out "$SHADOW_SESSION_TERMINATION"
```

Only the named deployment-owned adapter service identity receives the
`eligible_host` secret-manager grant. The eval identity cannot read that secret,
invoke the eligible principal, inspect the adapter process, or write the sealed
adapter output; the archived negative/positive boundary preflight proves these
claims. The adapter emits bounded canonical task-envelope/use-receipt and source
manifests, then hands a read-only sanitized directory to eval. Both the
sanitized conformance input/result and identity-boundary result bind source and
identity-policy digests, the deployed adapter image/binary digest, service-account
ID, and secret-manager policy version; raw secrets, prompts, or model output fail the archive
scan and trigger incident handling. A same-user env-file workflow is invalid.
The broker owns its state and termination roots mode `0700`; reservation ticket
bytes are generated and fsynced there before Runtime receives the same bytes on
stdin, never in a caller-named file, commit, or archive. They are
erased after committed consumption. Session authority lives only in the
daemon's live state; no bearer value or path is exposed. The launcher
creates and binds the exact supervisor descriptor, and that supervisor uses and
quiesces it in one lifetime. The session monitor is broker-owned and
independent of this shell; a trap may request recovery but cannot stop the
monitor. Public service launch/health, reservation, ticket consumption, claim,
supervisor spawn/binding/execution, broker conformance/quiesce/terminal,
attempt-chain, drain/pre-stop, and Runtime termination receipts are archived in
the external bundle; coverage-final/stop live only in the outer lifecycle root. Ticket
creation/readability outside the broker, session use outside the exact bound
supervisor/child process, a second binding/claim/termination, an
outcome-bearing call before binding, or any provider/mount use after quiesce is
an acceptance failure.

**Step 4: Run and materialize the existing tool/action prerequisite**

```bash
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
node scripts/learning-acceptance-runtime.mjs stop \
  --name shadow --work-dir "$ACCEPTANCE_DIR"
TOOL_DB="$PREREQ_DIR/tool.sqlite"
TOOL_PROFILE_RULE=/absolute/path/to/tool-prerequisite-fixture-profile-rule.json
ACTION_RUN_ID="$(node -p 'require(process.argv[1]).roles.tool_e2e.planned_run_id' "$EXTERNAL_RECOVERY_PLAN")"
TOOL_EXTERNAL_INPUT_MANIFEST=/secure/path/to/tool-external-input-manifest.json
TOOL_RETRY_POLICY=/secure/path/to/formal-tool-retry-policy.json
FORMAL_TOOL_MANIFEST=/secure/path/to/fixed-tool-manifest.json
TOOL_RESERVATION="$EXTERNAL_RESERVATION_DIR/tool-reservation.json"
TOOL_TICKET_CONSUMPTION="$EXTERNAL_RESERVATION_DIR/tool-ticket-consumption.json"
TOOL_CLAIM="$EXTERNAL_RESERVATION_DIR/tool-claim.json"
TOOL_BROKER_RECEIPT="$EXTERNAL_RESERVATION_DIR/tool-broker-conformance.json"
TOOL_SUPERVISOR_ARGV_MANIFEST=/secure/path/to/tool-supervisor-argv-manifest.json
TOOL_SUPERVISOR_SPAWN_RECEIPT="$EXTERNAL_RESERVATION_DIR/tool-supervisor-spawn.json"
TOOL_SUPERVISOR_BINDING="$EXTERNAL_RESERVATION_DIR/tool-supervisor-binding.json"
TOOL_SUPERVISOR_EXECUTION_RECEIPT="$EXTERNAL_RESERVATION_DIR/tool-supervisor-execution.json"
TOOL_BROKER_QUIESCE_RECEIPT="$EXTERNAL_RESERVATION_DIR/tool-broker-quiesce.json"
TOOL_PUBLIC_ATTEMPT_CHAIN="$EXTERNAL_RESERVATION_DIR/tool-attempt-chain.jsonl"
TOOL_BROKER_TERMINAL_RECEIPT="$EXTERNAL_RESERVATION_DIR/tool-broker-terminal.json"
TOOL_SESSION_TERMINATION="$EXTERNAL_RESERVATION_DIR/tool-session-termination.json"
node scripts/learning-acceptance-runtime.mjs clone-one \
  --source-db "$PREREQ_BASE_DB" --out-db "$TOOL_DB" \
  --manifest-out "$PREREQ_DIR/tool-clone-manifest.json"
"$FORMAL_RUN_BROKER" reserve-learning-run \
  --broker-socket "$BROKER_SOCKET" \
  --db "$RUNTIME_DB" --tenant "$TENANT" --actor evidence-reserver \
  --operation-id "reserve-external:tool:$ACTION_RUN_ID" \
  --kind tool_e2e_gate --series-id <tool-series-id> \
  --task-family "$TASK_FAMILY" \
  --applicable-experiment-id "$ACTIVE_EXPERIMENT_ID" \
  --applicable-revision "$ACTIVE_REVISION" \
  --immutable-input-manifest "$TOOL_EXTERNAL_INPUT_MANIFEST" \
  --tool-manifest "$FORMAL_TOOL_MANIFEST" \
  --retry-policy "$TOOL_RETRY_POLICY" --run-id "$ACTION_RUN_ID" \
  --reservation-out "$TOOL_RESERVATION"
"$FORMAL_RUN_BROKER" claim-learning-run \
  --broker-socket "$BROKER_SOCKET" \
  --db "$RUNTIME_DB" --tenant "$TENANT" --actor formal-run-broker \
  --consume-operation-id "consume-external:tool:$ACTION_RUN_ID" \
  --reservation "$TOOL_RESERVATION" \
  --runner-identity "$EVAL_IDENTITY" \
  --credential-secret-ref secret-manager://aionis/formal-tool-providers \
  --ticket-consumption-out "$TOOL_TICKET_CONSUMPTION" \
  --claim-out "$TOOL_CLAIM" \
  --broker-conformance-receipt-out "$TOOL_BROKER_RECEIPT"
node scripts/learning-acceptance-runtime.mjs start \
  --name tool-prereq --work-dir "$ACCEPTANCE_DIR" --db "$TOOL_DB" --port 3001 \
  --profile-rule-file "$TOOL_PROFILE_RULE" \
  --env-file /absolute/path/to/acceptance-secrets.env

ACTION_REPORT_DIR=/absolute/path/to/action-prerequisite-report
"$FORMAL_RUN_BROKER" launch-learning-supervisor \
  --broker-socket "$BROKER_SOCKET" --db "$RUNTIME_DB" --tenant "$TENANT" \
  --reservation "$TOOL_RESERVATION" \
  --ticket-consumption "$TOOL_TICKET_CONSUMPTION" --claim "$TOOL_CLAIM" \
  --runner-identity "$EVAL_IDENTITY" \
  --supervisor-executable "$FORMAL_NODE" \
  --supervisor-argv-manifest "$TOOL_SUPERVISOR_ARGV_MANIFEST" \
  --service-launcher "$BROKER_SERVICE_LAUNCHER" \
  --supervisor-spawn-receipt-out "$TOOL_SUPERVISOR_SPAWN_RECEIPT" \
  --supervisor-binding-out "$TOOL_SUPERVISOR_BINDING" \
  --supervisor-execution-receipt-out "$TOOL_SUPERVISOR_EXECUTION_RECEIPT" \
  --runner-output-manifest "$ACTION_REPORT_DIR/run-manifest.json" \
  --broker-quiesce-receipt-out "$TOOL_BROKER_QUIESCE_RECEIPT" \
  --public-attempt-chain-out "$TOOL_PUBLIC_ATTEMPT_CHAIN" -- \
"$FORMAL_NODE" scripts/run-learning-harness.mjs run \
    --bundle "$HARNESS_BUNDLE_DIR" --exec-dir "$HARNESS_EXEC_DIR" \
    --execution-identity "$EVAL_IDENTITY" \
    --runner-output-manifest "$ACTION_REPORT_DIR/run-manifest.json" \
    --receipt-out "$HARNESS_EXECUTION_RECEIPT_DIR/tool-action.json" -- \
    npm run -s external-agent-e2e:action-completion -- \
    --mode full --run-id "$ACTION_RUN_ID" --report-dir "$ACTION_REPORT_DIR" \
    --runtime-clone-manifest "$PREREQ_DIR/tool-clone-manifest.json" \
    --applicability-manifest "$ACTIVE_APPLICABILITY_MANIFEST" \
    --external-reservation "$TOOL_RESERVATION" \
    --external-ticket-consumption "$TOOL_TICKET_CONSUMPTION" \
    --external-claim "$TOOL_CLAIM" \
    --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA"

TOOL_REPORT_DIR=/absolute/path/to/tool-e2e-gate
npm run -s admission:tool-e2e-gate -- \
  --run-manifest "$ACTION_REPORT_DIR/run-manifest.json" \
  --out-dir "$TOOL_REPORT_DIR" \
  --runtime-clone-manifest "$PREREQ_DIR/tool-clone-manifest.json" \
  --applicability-manifest "$ACTIVE_APPLICABILITY_MANIFEST" \
  --external-reservation "$TOOL_RESERVATION" \
  --external-ticket-consumption "$TOOL_TICKET_CONSUMPTION" \
  --external-claim "$TOOL_CLAIM" \
  --external-supervisor-binding "$TOOL_SUPERVISOR_BINDING" \
  --broker-quiesce-receipt "$TOOL_BROKER_QUIESCE_RECEIPT" \
  --public-attempt-chain "$TOOL_PUBLIC_ATTEMPT_CHAIN" \
  --harness-exec-preparation "$HARNESS_EXEC_PREP_RECEIPT" \
  --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA"
"$FORMAL_RUN_BROKER" finalize-learning-run \
  --broker-socket "$BROKER_SOCKET" \
  --db "$RUNTIME_DB" --tenant "$TENANT" --actor formal-run-broker \
  --reservation "$TOOL_RESERVATION" \
  --ticket-consumption "$TOOL_TICKET_CONSUMPTION" \
  --claim "$TOOL_CLAIM" \
  --supervisor-binding "$TOOL_SUPERVISOR_BINDING" \
  --broker-quiesce-receipt "$TOOL_BROKER_QUIESCE_RECEIPT" \
  --public-attempt-chain "$TOOL_PUBLIC_ATTEMPT_CHAIN" \
  --terminal-run-manifest "$TOOL_REPORT_DIR/run-manifest.json" \
  --broker-terminal-receipt-out "$TOOL_BROKER_TERMINAL_RECEIPT" \
  --session-termination-out "$TOOL_SESSION_TERMINATION"
node scripts/learning-acceptance-runtime.mjs stop \
  --name tool-prereq --work-dir "$ACCEPTANCE_DIR"
```

The run remains 40 gradient rows/200 Agent-arm executions but only ten
independent base tasks and 40 Aionis exposures. It is a prerequisite artifact,
not the online sample. The currently unused `promotion_gate` config field must
not be reported as executed. The wrapper must pass the exact `--run-id` through
to every lower runner; the new resume/provenance test fails if it merely accepts
and ignores the flag.

**Step 5: Run the isolated offline paired finite-holdout regression**

With the isolated shadow and tool writers stopped, run every reviewed base task
against a **fresh** pair of byte-identical pristine pre-A/A `PAIRED_BASE_DB`
restores. Before the first A/A write, the archived holdout-cleanliness audit
must prove both (a) zero task ID, content/workflow digest, store scope, and
host/source-event overlap between the A/A manifest and paired case manifest and
(b) zero A/A namespace/source/memory overlap with the future active manifest,
and (c) zero paired case/ledger/memory overlap in the pristine DB. A/A may not expose
or influence continuation decisions on a paired holdout case. The case
manifest contains exactly 96 independent base tasks, counterbalanced order,
and immutable deterministic model/runtime/tool versions. The existing
`AionisRuntime-evals/external-agent-e2e/configs/model-profiles.json` DeepSeek
profiles declare `immutable_snapshot=false` and
`provider_may_update_weights=true`; they are therefore diagnostic-only and the
expected formal gate result today is `hold`. Do not relabel them immutable. A
formal run may proceed only after a genuinely immutable snapshot manifest and
deterministic execution profile are reviewed. `paired-fresh-snapshot` calls the
checked-in supervisor for each unit: create two copies, verify their initial
digest equals the frozen base, start both Runtime processes, run only that
unit, stop them, record bounded initial/final digests, then delete the mutable
DBs. A failure at any lifecycle step aborts the suite. Two long-lived arm DBs
for the whole case set are forbidden. `PAIRED_SEALED_HOLDOUT_MANIFEST` is
secret-free and contains only the canonical hash of the protected object
reference, ciphertext/source digests, encryption format/key ID, and
membership-projection digest; it contains neither holdout plaintext nor a
usable retrieval credential. The broker receives the actual protected
reference separately and must match it to these frozen hashes.

```bash
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
PAIR_DIR="$ACCEPTANCE_DIR/paired"
PAIR_UNIT_MANIFEST="$PAIR_DIR/per-unit-clone-manifest.json"

PAIRED_RUN_ID="$(node -p 'require(process.argv[1]).roles.offline_paired.planned_run_id' "$EXTERNAL_RECOVERY_PLAN")"
PAIRED_RUNNER_OUTPUT_DIR=/absolute/path/to/learning-paired-runner-output
PAIRED_REPORT_DIR=/absolute/path/to/learning-paired-report
PAIRED_EXTERNAL_INPUT_MANIFEST=/secure/path/to/offline-external-input-manifest.json
PAIRED_RETRY_POLICY=/secure/path/to/formal-paired-retry-policy.json
PAIRED_SEALED_HOLDOUT_MANIFEST=/secure/path/to/sealed-holdout-manifest.json
IMMUTABLE_MODEL_SNAPSHOT_MANIFEST=/secure/path/to/immutable-model-snapshot.json
DETERMINISTIC_EXECUTION_PROFILE=/secure/path/to/deterministic-execution-profile.json
PAIRED_TOOL_MANIFEST=/secure/path/to/fixed-paired-tool-manifest.json
PAIRED_ORDER_MANIFEST=/secure/path/to/counterbalanced-order-manifest.json
PAIRED_RESERVATION="$EXTERNAL_RESERVATION_DIR/paired-reservation.json"
PAIRED_TICKET_CONSUMPTION="$EXTERNAL_RESERVATION_DIR/paired-ticket-consumption.json"
PAIRED_CLAIM="$EXTERNAL_RESERVATION_DIR/paired-claim.json"
PAIRED_BROKER_RECEIPT="$EXTERNAL_RESERVATION_DIR/paired-broker-conformance.json"
PAIRED_SUPERVISOR_ARGV_MANIFEST=/secure/path/to/paired-supervisor-argv-manifest.json
PAIRED_SUPERVISOR_SPAWN_RECEIPT="$EXTERNAL_RESERVATION_DIR/paired-supervisor-spawn.json"
PAIRED_SUPERVISOR_BINDING="$EXTERNAL_RESERVATION_DIR/paired-supervisor-binding.json"
PAIRED_SUPERVISOR_EXECUTION_RECEIPT="$EXTERNAL_RESERVATION_DIR/paired-supervisor-execution.json"
PAIRED_BROKER_QUIESCE_RECEIPT="$EXTERNAL_RESERVATION_DIR/paired-broker-quiesce.json"
PAIRED_PUBLIC_ATTEMPT_CHAIN="$EXTERNAL_RESERVATION_DIR/paired-attempt-chain.jsonl"
PAIRED_BROKER_TERMINAL_RECEIPT="$EXTERNAL_RESERVATION_DIR/paired-broker-terminal.json"
PAIRED_SESSION_TERMINATION="$EXTERNAL_RESERVATION_DIR/paired-session-termination.json"
FORMAL_HOLDOUT_MOUNT="$PAIR_DIR/claimed-holdout"
node scripts/run-learning-harness.mjs verify-model-snapshot \
  --model-snapshot "$IMMUTABLE_MODEL_SNAPSHOT_MANIFEST" \
  --execution-profile "$DETERMINISTIC_EXECUTION_PROFILE" \
  --reject-profile /Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/configs/model-profiles.json
"$FORMAL_RUN_BROKER" reserve-learning-run \
  --broker-socket "$BROKER_SOCKET" \
  --db "$RUNTIME_DB" --tenant "$TENANT" --actor evidence-reserver \
  --operation-id "reserve-external:paired:$PAIRED_RUN_ID" \
  --kind offline_paired_rerun --series-id <paired-series-id> \
  --task-family "$TASK_FAMILY" \
  --applicable-experiment-id "$ACTIVE_EXPERIMENT_ID" \
  --applicable-revision "$ACTIVE_REVISION" \
  --immutable-input-manifest "$PAIRED_EXTERNAL_INPUT_MANIFEST" \
  --holdout-membership-projection "$FORMAL_HOLDOUT_MEMBERSHIP_PROJECTION" \
  --sealed-holdout-manifest "$PAIRED_SEALED_HOLDOUT_MANIFEST" \
  --model-snapshot "$IMMUTABLE_MODEL_SNAPSHOT_MANIFEST" \
  --execution-profile "$DETERMINISTIC_EXECUTION_PROFILE" \
  --tool-manifest "$PAIRED_TOOL_MANIFEST" \
  --execution-order "$PAIRED_ORDER_MANIFEST" \
  --retry-policy "$PAIRED_RETRY_POLICY" --run-id "$PAIRED_RUN_ID" \
  --reservation-out "$PAIRED_RESERVATION"
"$FORMAL_RUN_BROKER" claim-learning-run \
  --broker-socket "$BROKER_SOCKET" \
  --db "$RUNTIME_DB" --tenant "$TENANT" --actor formal-run-broker \
  --consume-operation-id "consume-external:paired:$PAIRED_RUN_ID" \
  --reservation "$PAIRED_RESERVATION" \
  --runner-identity "$EVAL_IDENTITY" \
  --credential-secret-ref secret-manager://aionis/immutable-paired-runtime \
  --sealed-holdout-ref "$FORMAL_HOLDOUT_SEALED_REF" \
  --ticket-consumption-out "$PAIRED_TICKET_CONSUMPTION" \
  --claim-out "$PAIRED_CLAIM" \
  --broker-conformance-receipt-out "$PAIRED_BROKER_RECEIPT"
"$FORMAL_RUN_BROKER" launch-learning-supervisor \
    --broker-socket "$BROKER_SOCKET" --db "$RUNTIME_DB" --tenant "$TENANT" \
    --reservation "$PAIRED_RESERVATION" \
    --ticket-consumption "$PAIRED_TICKET_CONSUMPTION" --claim "$PAIRED_CLAIM" \
    --runner-identity "$EVAL_IDENTITY" \
    --supervisor-executable "$FORMAL_NODE" \
    --supervisor-argv-manifest "$PAIRED_SUPERVISOR_ARGV_MANIFEST" \
    --service-launcher "$BROKER_SERVICE_LAUNCHER" \
    --holdout-mount-target "$FORMAL_HOLDOUT_MOUNT" \
    --supervisor-spawn-receipt-out "$PAIRED_SUPERVISOR_SPAWN_RECEIPT" \
    --supervisor-binding-out "$PAIRED_SUPERVISOR_BINDING" \
    --supervisor-execution-receipt-out "$PAIRED_SUPERVISOR_EXECUTION_RECEIPT" \
    --runner-output-manifest "$PAIRED_RUNNER_OUTPUT_DIR/run-manifest.json" \
    --broker-quiesce-receipt-out "$PAIRED_BROKER_QUIESCE_RECEIPT" \
    --public-attempt-chain-out "$PAIRED_PUBLIC_ATTEMPT_CHAIN" -- \
"$FORMAL_NODE" scripts/run-learning-harness.mjs run \
    --bundle "$HARNESS_BUNDLE_DIR" --exec-dir "$HARNESS_EXEC_DIR" \
    --execution-identity "$EVAL_IDENTITY" \
    --runner-output-manifest "$PAIRED_RUNNER_OUTPUT_DIR/run-manifest.json" \
    --receipt-out "$HARNESS_EXECUTION_RECEIPT_DIR/offline-paired.json" -- \
    npm run -s external-agent-e2e:learning-evidence -- \
    --mode paired-fresh-snapshot --run-id "$PAIRED_RUN_ID" \
    --report-dir "$PAIRED_RUNNER_OUTPUT_DIR" \
    --manifest "$FORMAL_HOLDOUT_MOUNT/cases.jsonl" \
    --runtime-arm-config external-agent-e2e/configs/learning-episode-gate-v1-runtime-arms.json \
    --runtime-supervisor /Volumes/ziel/new.aionis/AionisRuntime-focused/scripts/learning-acceptance-runtime.mjs \
    --runtime-work-dir "$PAIR_DIR/runtime" \
    --frozen-source-db "$PAIRED_BASE_DB" \
    --source-clone-manifest "$PAIRED_BASE_DIR/clone-manifest.json" \
    --holdout-cleanliness "$PAIRED_BASE_DIR/holdout-cleanliness.json" \
    --recorded-profile-rule external-agent-e2e/configs/learning-episode-gate-v1-recorded-profile.json \
    --candidate-profile-rule external-agent-e2e/configs/learning-episode-gate-v1-candidate-profile.json \
    --pair-unit-manifest-out "$PAIR_UNIT_MANIFEST" \
    --applicability-manifest "$ACTIVE_APPLICABILITY_MANIFEST" \
    --external-reservation "$PAIRED_RESERVATION" \
    --external-ticket-consumption "$PAIRED_TICKET_CONSUMPTION" \
    --external-claim "$PAIRED_CLAIM" \
    --model-snapshot "$IMMUTABLE_MODEL_SNAPSHOT_MANIFEST" \
    --execution-profile "$DETERMINISTIC_EXECUTION_PROFILE" \
    --tool-manifest "$PAIRED_TOOL_MANIFEST" \
    --execution-order "$PAIRED_ORDER_MANIFEST" \
    --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA"
npm run -s admission:real-agent-rerun -- \
  --run-manifest "$PAIRED_RUNNER_OUTPUT_DIR/run-manifest.json" \
  --out-dir "$PAIRED_REPORT_DIR" \
  --applicability-manifest "$ACTIVE_APPLICABILITY_MANIFEST" \
  --external-reservation "$PAIRED_RESERVATION" \
  --external-ticket-consumption "$PAIRED_TICKET_CONSUMPTION" \
  --external-claim "$PAIRED_CLAIM" \
  --external-supervisor-binding "$PAIRED_SUPERVISOR_BINDING" \
  --broker-quiesce-receipt "$PAIRED_BROKER_QUIESCE_RECEIPT" \
  --public-attempt-chain "$PAIRED_PUBLIC_ATTEMPT_CHAIN" \
  --harness-exec-preparation "$HARNESS_EXEC_PREP_RECEIPT" \
  --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA"
"$FORMAL_RUN_BROKER" finalize-learning-run \
  --broker-socket "$BROKER_SOCKET" \
  --db "$RUNTIME_DB" --tenant "$TENANT" --actor formal-run-broker \
  --reservation "$PAIRED_RESERVATION" \
  --ticket-consumption "$PAIRED_TICKET_CONSUMPTION" \
  --claim "$PAIRED_CLAIM" \
  --supervisor-binding "$PAIRED_SUPERVISOR_BINDING" \
  --broker-quiesce-receipt "$PAIRED_BROKER_QUIESCE_RECEIPT" \
  --public-attempt-chain "$PAIRED_PUBLIC_ATTEMPT_CHAIN" \
  --terminal-run-manifest "$PAIRED_REPORT_DIR/run-manifest.json" \
  --broker-terminal-receipt-out "$PAIRED_BROKER_TERMINAL_RECEIPT" \
  --session-termination-out "$PAIRED_SESSION_TERMINATION"
```

Expected: the report contains exact 96-case integer candidate-minus-recorded
harm/utility loss differences, the -2-point exploit-harm regression threshold,
full-risk-set missing-pair sensitivity, exact cross-multiplication decisions,
order, exclusions, response fingerprints, and frozen
snapshot/case/harness provenance. The runner parses the clone manifest before
each unit runs and the report binds all per-unit initial/final clone digests,
their common source snapshot, base-clone manifest, case ID/order, and aggregate
pair-unit-manifest digest, plus the pre-A/A holdout-cleanliness digest. Tests
deliberately mutate unit 1 and prove unit 2
still starts from the original source digest with no carried node, job, lease,
or safety/authority state. Missing, reused, or changed clones fail before
evidence generation.

**Step 6: Define the fixture-pilot step, but do not run it before external pass**

This block only defines `run_fixture_pilot`; it makes no call yet. Step 7 first
archives and ingests every external result and requires all three heads to
pass. Only then does it invoke this function. This preserves archive-and-ingest-
before-assert while ensuring a failed/inconclusive result or either hold branch
cannot be followed by pilot traffic. When invoked, verify the
per-unit paired supervisor left no child endpoint or mutable unit DB. Never point fixture-pilot traffic at the original
authority DB or any actively leased production namespace. Create a one-off
SQLite backup clone, require a reviewed pilot manifest whose canonical store
scopes are disjoint from the hashed membership in
`ACTIVE_APPLICABILITY_MANIFEST`, and run the already-
provisioned active profile only against that clone. The supervisor's
`clone-one` command records source/copy digests and refuses a production path;
the fixture runner and Runtime both recheck disjointness.

```bash
run_fixture_pilot() {
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
node scripts/learning-acceptance-runtime.mjs status \
  --work-dir "$PAIR_DIR/runtime" --expect-no-children
PILOT_DIR="$ACCEPTANCE_DIR/pilot"
PILOT_DB="$PILOT_DIR/pilot.sqlite"
PILOT_NAMESPACE_MANIFEST=/absolute/path/to/reviewed-disjoint-pilot-namespaces.json
PILOT_NAMESPACE_AUDIT_MANIFEST="$PILOT_DIR/namespace-membership-audit.json"
PILOT_DISJOINTNESS_RESULT="$PILOT_DIR/namespace-disjointness.json"
node scripts/learning-acceptance-runtime.mjs clone-one \
  --source-db "$RUNTIME_DB" --out-db "$PILOT_DB" \
  --manifest-out "$PILOT_DIR/clone-manifest.json" \
  --pilot-namespace-manifest "$PILOT_NAMESPACE_MANIFEST" \
  --active-applicability-manifest "$ACTIVE_APPLICABILITY_MANIFEST" \
  --namespace-audit-out "$PILOT_NAMESPACE_AUDIT_MANIFEST" \
  --disjointness-out "$PILOT_DISJOINTNESS_RESULT"
node scripts/learning-acceptance-runtime.mjs start \
  --name active-pilot --work-dir "$ACCEPTANCE_DIR" --db "$PILOT_DB" --port 3001 \
  --profile-rule-file "$ACTIVE_PROFILE_RULE" \
  --env-file /absolute/path/to/acceptance-secrets.env
node scripts/learning-acceptance-runtime.mjs status \
  --name active-pilot --work-dir "$ACCEPTANCE_DIR" --expect-db "$PILOT_DB"

PILOT_RUN_ID="learning-online-pilot-<utc>"
PILOT_REPORT_DIR=/absolute/path/to/learning-online-pilot
DEEPSEEK_API_KEY=... AIONIS_API_KEY=<fixture-pilot-key> \
  AIONIS_BASE_URL=http://127.0.0.1:3001 \
  node scripts/run-learning-harness.mjs run \
    --bundle "$HARNESS_BUNDLE_DIR" --exec-dir "$HARNESS_EXEC_DIR" \
    --execution-identity "$EVAL_IDENTITY" \
    --receipt-out "$HARNESS_EXECUTION_RECEIPT_DIR/fixture-pilot.json" -- \
    npm run -s external-agent-e2e:learning-evidence -- \
    --mode online-pilot --run-id "$PILOT_RUN_ID" \
    --report-dir "$PILOT_REPORT_DIR" \
    --manifest external-agent-e2e/fixtures/learning-episode-gate-v1.jsonl \
    --memory-namespace-manifest "$PILOT_NAMESPACE_MANIFEST" \
    --namespace-audit-manifest "$PILOT_NAMESPACE_AUDIT_MANIFEST" \
    --must-be-disjoint-from "$ACTIVE_APPLICABILITY_MANIFEST" \
    --runtime-arm-config external-agent-e2e/configs/learning-episode-gate-v1-runtime-arms.json \
    --applicability-manifest "$ACTIVE_APPLICABILITY_MANIFEST" \
    --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA"
node scripts/learning-acceptance-runtime.mjs stop \
  --name active-pilot --work-dir "$ACCEPTANCE_DIR"
}
```

The audit manifest contains sorted hashes for every pilot namespace and the
active applicability membership/set digest, but no raw store scope or
assignment randomness;
the disjointness result is independently recomputed from those archived bytes.
Pilot rows must reconcile operations, episodes, receipts, measurements, and
assignment facts, but remain `fixture_pilot` and absent from every formal risk
set. The clone manifest and disjointness result are retained in the pilot
diagnostic bundle; no pilot row is copied back into the authority database.

**Step 7: Seal external prerequisites, assert pass, then run/archive the pilot**

`--kind result` archives sanitized raw outcome/provenance bytes plus one
canonical gate report and the harness digest. It prints only the run-bundle
digest under `--print-sha`; verify and ingest every bundle regardless of
`passed|failed|inconclusive` before asserting pass. Every external
profile rule is canonicalized and secret-scanned as a source file. The active
applicability manifest supplies sorted hashed pair/wave membership; the pilot
audit supplies sorted hashed pilot membership. Together with the prepare/clone
and harness-execution receipts, the bounded pristine-DB ledger/memory audit
projection, and the A/A manifest, committed bytes can independently recompute
profile applicability, A/A/paired/active isolation, holdout cleanliness, and namespace disjointness without
archiving raw store scopes or credentials.

```bash
set -euo pipefail
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
AA_RUN_BUNDLE_SHA=<committed-aa-run-bundle-sha256>
SHADOW_PUBLIC_AUTHORITY_DIR="$EXTERNAL_RESERVATION_DIR/shadow-public-authority"
TOOL_PUBLIC_AUTHORITY_DIR="$EXTERNAL_RESERVATION_DIR/tool-public-authority"
PAIRED_PUBLIC_AUTHORITY_DIR="$EXTERNAL_RESERVATION_DIR/paired-public-authority"
"$FORMAL_RUN_BROKER" drain-terminal-facts \
  --broker-socket "$BROKER_SOCKET" --db "$RUNTIME_DB" \
  --tenant "$TENANT" --actor formal-run-broker \
  --public-terminal-fact-dir "$BROKER_PUBLIC_TERMINAL_FACT_DIR" \
  --drain-receipt-out "$BROKER_DRAIN_RECEIPT"
"$FORMAL_RUN_BROKER" materialize-public-run \
  --drain-receipt "$BROKER_DRAIN_RECEIPT" \
  --public-terminal-fact-dir "$BROKER_PUBLIC_TERMINAL_FACT_DIR" \
  --reservation "$SHADOW_RESERVATION" --out-dir "$SHADOW_PUBLIC_AUTHORITY_DIR"
"$FORMAL_RUN_BROKER" materialize-public-run \
  --drain-receipt "$BROKER_DRAIN_RECEIPT" \
  --public-terminal-fact-dir "$BROKER_PUBLIC_TERMINAL_FACT_DIR" \
  --reservation "$TOOL_RESERVATION" --out-dir "$TOOL_PUBLIC_AUTHORITY_DIR"
"$FORMAL_RUN_BROKER" materialize-public-run \
  --drain-receipt "$BROKER_DRAIN_RECEIPT" \
  --public-terminal-fact-dir "$BROKER_PUBLIC_TERMINAL_FACT_DIR" \
  --reservation "$PAIRED_RESERVATION" --out-dir "$PAIRED_PUBLIC_AUTHORITY_DIR"
"$FORMAL_RUN_BROKER" status \
  --broker-socket "$BROKER_SOCKET" --db "$RUNTIME_DB" --tenant "$TENANT" \
  --expect-service-identity "$BROKER_SERVICE_IDENTITY" \
  --state-root "$BROKER_STATE_ROOT" \
  --terminal-fact-spool "$BROKER_TERMINAL_FACT_SPOOL" \
  --require-no-active-sessions --require-no-reserved-unconsumed \
  --require-all-terminal-facts-acked \
  --require-all-terminal-facts-exported \
  --out "$BROKER_PRESTOP_STATUS_RECEIPT"
SHADOW_RUN_BUNDLE_SHA="$(node scripts/archive-learning-eval.mjs --kind result --print-sha \
  --source /absolute/path/to/current-shadow-gate \
  --source /absolute/path/to/current-shadow-dataset \
  --source /absolute/path/to/current-shadow-host-validation \
  --source "$HOST_SHADOW_RUN_DIR" \
  --source "$SHADOW_PUBLIC_AUTHORITY_DIR" \
  --source-file "$ACTIVE_PROFILE_RULE" \
  --source-file "$SHADOW_PROFILE_RULE" \
  --source-file "$HOST_RECEIPT_MANIFEST" \
  --source-file "$HOST_CONFORMANCE_RESULT" \
  --source-file "$HOST_IDENTITY_BOUNDARY_RESULT" \
  --source-file "$SHADOW_APPLICABILITY_MANIFEST" \
  --source-file "$ACTIVE_APPLICABILITY_MANIFEST" \
  --source-file "$PREREGISTERED_EXTERNAL_INPUT_SET" \
  --source-file "$BROKER_SERVICE_LAUNCH_RECEIPT" \
  --source-file "$BROKER_IDENTITY_RECEIPT" \
  --source-file "$BROKER_DRAIN_RECEIPT" \
  --source-file "$BROKER_PRESTOP_STATUS_RECEIPT" \
  --source-file "$SHADOW_EXTERNAL_INPUT_MANIFEST" \
  --source-file "$SHADOW_RETRY_POLICY" \
  --source-file "$ACCEPTANCE_DIR/prepare-manifest.json" \
  --source-file "$HARNESS_EXEC_PREP_RECEIPT" \
  --source-file "$PREREQ_DIR/base-clone-manifest.json" \
  --source-file "$PREREQ_DIR/shadow-clone-manifest.json" \
  --source-file "$HARNESS_EXECUTION_RECEIPT_DIR/shadow-validation.json" \
  --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA" \
  --out evals/learning-episode-gate-v1/runs)"
TOOL_RUN_BUNDLE_SHA="$(node scripts/archive-learning-eval.mjs --kind result --print-sha \
  --source /absolute/path/to/tool-e2e-gate \
  --source /absolute/path/to/action-prerequisite-report \
  --source "$TOOL_PUBLIC_AUTHORITY_DIR" \
  --source-file "$ACTIVE_PROFILE_RULE" \
  --source-file "$TOOL_PROFILE_RULE" \
  --source-file "$ACTIVE_APPLICABILITY_MANIFEST" \
  --source-file "$PREREGISTERED_EXTERNAL_INPUT_SET" \
  --source-file "$BROKER_SERVICE_LAUNCH_RECEIPT" \
  --source-file "$BROKER_IDENTITY_RECEIPT" \
  --source-file "$BROKER_DRAIN_RECEIPT" \
  --source-file "$BROKER_PRESTOP_STATUS_RECEIPT" \
  --source-file "$TOOL_EXTERNAL_INPUT_MANIFEST" \
  --source-file "$FORMAL_TOOL_MANIFEST" \
  --source-file "$TOOL_RETRY_POLICY" \
  --source-file "$ACCEPTANCE_DIR/prepare-manifest.json" \
  --source-file "$HARNESS_EXEC_PREP_RECEIPT" \
  --source-file "$PREREQ_DIR/base-clone-manifest.json" \
  --source-file "$PREREQ_DIR/tool-clone-manifest.json" \
  --source-file "$HARNESS_EXECUTION_RECEIPT_DIR/tool-action.json" \
  --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA" \
  --out evals/learning-episode-gate-v1/runs)"
PAIRED_RUN_BUNDLE_SHA="$(node scripts/archive-learning-eval.mjs --kind result --print-sha \
  --source "$PAIRED_RUNNER_OUTPUT_DIR" \
  --source "$PAIRED_REPORT_DIR" \
  --source "$PAIRED_PUBLIC_AUTHORITY_DIR" \
  --source-file "$PAIR_UNIT_MANIFEST" \
  --source-file "$BROKER_SERVICE_LAUNCH_RECEIPT" \
  --source-file "$BROKER_IDENTITY_RECEIPT" \
  --source-file "$BROKER_DRAIN_RECEIPT" \
  --source-file "$BROKER_PRESTOP_STATUS_RECEIPT" \
  --source-file "$PAIRED_EXTERNAL_INPUT_MANIFEST" \
  --source-file "$PAIRED_RETRY_POLICY" \
  --source-file "$FORMAL_HOLDOUT_MEMBERSHIP_PROJECTION" \
  --source-file "$PAIRED_SEALED_HOLDOUT_MANIFEST" \
  --source-file "$IMMUTABLE_MODEL_SNAPSHOT_MANIFEST" \
  --source-file "$DETERMINISTIC_EXECUTION_PROFILE" \
  --source-file "$PAIRED_TOOL_MANIFEST" \
  --source-file "$PAIRED_ORDER_MANIFEST" \
  --source-file "$AA_NAMESPACE_MANIFEST" \
  --source-file "$PAIRED_BASE_DIR/clone-manifest.json" \
  --source-file "$PAIRED_BASE_AUDIT_PROJECTION" \
  --source-file "$PAIRED_BASE_DIR/holdout-cleanliness.json" \
  --source-file "$ACCEPTANCE_DIR/prepare-manifest.json" \
  --source-file "$HARNESS_EXEC_PREP_RECEIPT" \
  --source-file "$HARNESS_EXECUTION_RECEIPT_DIR/offline-paired.json" \
  --source-file "$ACTIVE_APPLICABILITY_MANIFEST" \
  --source-file "$PREREGISTERED_EXTERNAL_INPUT_SET" \
  --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA" \
  --out evals/learning-episode-gate-v1/runs)"
for sha in "$AA_RUN_BUNDLE_SHA" "$SHADOW_RUN_BUNDLE_SHA" \
  "$TOOL_RUN_BUNDLE_SHA" "$PAIRED_RUN_BUNDLE_SHA"
do
  node scripts/archive-learning-eval.mjs \
    --verify "evals/learning-episode-gate-v1/runs/$sha"
done
```

```bash
set -euo pipefail
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
test "$RUNTIME_DB" = "$ACCEPTANCE_DIR/runtime.sqlite"
node scripts/learning-acceptance-runtime.mjs status \
  --name active --work-dir "$ACCEPTANCE_DIR" --expect-stopped
AA_RUN_BUNDLE_SHA=<aa-run-bundle-sha256>
SHADOW_RUN_BUNDLE_SHA=<shadow-run-bundle-sha256>
TOOL_RUN_BUNDLE_SHA=<tool-run-bundle-sha256>
PAIRED_RUN_BUNDLE_SHA=<paired-run-bundle-sha256>
git add \
  "evals/learning-episode-gate-v1/runs/$AA_RUN_BUNDLE_SHA" \
  "evals/learning-episode-gate-v1/runs/$SHADOW_RUN_BUNDLE_SHA" \
  "evals/learning-episode-gate-v1/runs/$TOOL_RUN_BUNDLE_SHA" \
  "evals/learning-episode-gate-v1/runs/$PAIRED_RUN_BUNDLE_SHA"
git commit -m "test(eval): freeze learning prerequisite evidence"
node scripts/archive-learning-eval.mjs write-external-coverage-index \
  --entry "$SHADOW_PUBLIC_AUTHORITY_DIR=result:$SHADOW_RUN_BUNDLE_SHA" \
  --entry "$TOOL_PUBLIC_AUTHORITY_DIR=result:$TOOL_RUN_BUNDLE_SHA" \
  --entry "$PAIRED_PUBLIC_AUTHORITY_DIR=result:$PAIRED_RUN_BUNDLE_SHA" \
  --out "$BROKER_COVERAGE_INDEX"
"$FORMAL_RUN_BROKER" status \
  --broker-socket "$BROKER_SOCKET" --db "$RUNTIME_DB" --tenant "$TENANT" \
  --expect-service-identity "$BROKER_SERVICE_IDENTITY" \
  --state-root "$BROKER_STATE_ROOT" \
  --terminal-fact-spool "$BROKER_TERMINAL_FACT_SPOOL" \
  --require-pre-stop-status "$BROKER_PRESTOP_STATUS_RECEIPT" \
  --require-terminal-coverage-index "$BROKER_COVERAGE_INDEX" \
  --out "$BROKER_COVERAGE_FINAL_RECEIPT"
"$BROKER_SERVICE_LAUNCHER" stop-ephemeral \
  --launch-receipt "$BROKER_SERVICE_LAUNCH_RECEIPT" \
  --coverage-final-receipt "$BROKER_COVERAGE_FINAL_RECEIPT" \
  --out "$BROKER_SERVICE_STOP_RECEIPT"
BROKER_STOPPED=1
BROKER_LIFECYCLE_BUNDLE_SHA="$(node scripts/archive-learning-eval.mjs \
  --kind broker-lifecycle --print-sha \
  --source-file "$BROKER_SERVICE_LAUNCH_RECEIPT" \
  --source-file "$BROKER_IDENTITY_RECEIPT" \
  --source-file "$BROKER_DRAIN_RECEIPT" \
  --source-file "$BROKER_PRESTOP_STATUS_RECEIPT" \
  --source-file "$BROKER_COVERAGE_INDEX" \
  --source-file "$BROKER_COVERAGE_FINAL_RECEIPT" \
  --source-file "$BROKER_SERVICE_STOP_RECEIPT" \
  --out evals/learning-episode-gate-v1/lifecycle)"
node scripts/archive-learning-eval.mjs \
  --verify "evals/learning-episode-gate-v1/lifecycle/$BROKER_LIFECYCLE_BUNDLE_SHA"
git add "evals/learning-episode-gate-v1/lifecycle/$BROKER_LIFECYCLE_BUNDLE_SHA"
git commit -m "test(eval): freeze formal broker lifecycle"
EXTERNAL_INGESTION_DIR="$ACCEPTANCE_DIR/external-ingestion"
SHADOW_INGEST_RECEIPT="$EXTERNAL_INGESTION_DIR/shadow-ingest.json"
TOOL_INGEST_RECEIPT="$EXTERNAL_INGESTION_DIR/tool-ingest.json"
PAIRED_INGEST_RECEIPT="$EXTERNAL_INGESTION_DIR/paired-ingest.json"
EXTERNAL_INGESTION_PROJECTION="$EXTERNAL_INGESTION_DIR/authority-projection.json"
EXTERNAL_SERIES_STATUS="$EXTERNAL_INGESTION_DIR/required-series-status.json"
mkdir -p "$EXTERNAL_INGESTION_DIR"
npx tsx scripts/learning-evidence.ts ingest \
  --db "$RUNTIME_DB" --tenant "$TENANT" --actor evidence-ingester \
  --operation-id "$ACTIVE_EXPERIMENT_ID:$ACTIVE_REVISION:ingest:shadow" \
  --kind production_shadow_gate \
  --public-run-authority "$SHADOW_PUBLIC_AUTHORITY_DIR" \
  --run-bundle "evals/learning-episode-gate-v1/runs/$SHADOW_RUN_BUNDLE_SHA" \
  --series-id <shadow-series-id> --task-family "$TASK_FAMILY" \
  --applicable-experiment-id "$ACTIVE_EXPERIMENT_ID" \
  --applicable-revision "$ACTIVE_REVISION" --out "$SHADOW_INGEST_RECEIPT"
npx tsx scripts/learning-evidence.ts ingest \
  --db "$RUNTIME_DB" --tenant "$TENANT" --actor evidence-ingester \
  --operation-id "$ACTIVE_EXPERIMENT_ID:$ACTIVE_REVISION:ingest:tool" \
  --kind tool_e2e_gate \
  --public-run-authority "$TOOL_PUBLIC_AUTHORITY_DIR" \
  --run-bundle "evals/learning-episode-gate-v1/runs/$TOOL_RUN_BUNDLE_SHA" \
  --series-id <tool-series-id> --task-family "$TASK_FAMILY" \
  --applicable-experiment-id "$ACTIVE_EXPERIMENT_ID" \
  --applicable-revision "$ACTIVE_REVISION" --out "$TOOL_INGEST_RECEIPT"
npx tsx scripts/learning-evidence.ts ingest \
  --db "$RUNTIME_DB" --tenant "$TENANT" --actor evidence-ingester \
  --operation-id "$ACTIVE_EXPERIMENT_ID:$ACTIVE_REVISION:ingest:paired" \
  --kind offline_paired_rerun \
  --public-run-authority "$PAIRED_PUBLIC_AUTHORITY_DIR" \
  --run-bundle "evals/learning-episode-gate-v1/runs/$PAIRED_RUN_BUNDLE_SHA" \
  --series-id <paired-series-id> --task-family "$TASK_FAMILY" \
  --applicable-experiment-id "$ACTIVE_EXPERIMENT_ID" \
  --applicable-revision "$ACTIVE_REVISION" --out "$PAIRED_INGEST_RECEIPT"
npx tsx scripts/learning-evidence.ts status \
  --db "$RUNTIME_DB" --tenant "$TENANT" --actor evidence-reporter \
  --task-family "$TASK_FAMILY" --experiment-id "$ACTIVE_EXPERIMENT_ID" \
  --revision "$ACTIVE_REVISION" --out "$EXTERNAL_SERIES_STATUS"
"$RUNTIME_AUTHORITY_ATTESTOR_LAUNCHER" attest-learning-external-heads \
  --deployment-slot "$RUNTIME_AUTHORITY_DB_SLOT" \
  --database-binding-receipt "$RUNTIME_AUTHORITY_DB_BINDING_RECEIPT" \
  --service-identity "$RUNTIME_AUTHORITY_ATTESTOR_SERVICE_IDENTITY" \
  --exec "$RUNTIME_AUTHORITY_ATTESTOR" \
  --policy "$RUNTIME_AUTHORITY_ATTESTOR_POLICY" \
  --coverage-index "$BROKER_COVERAGE_INDEX" \
  --required-series-status "$EXTERNAL_SERIES_STATUS" \
  --projection-out "$EXTERNAL_INGESTION_PROJECTION" \
  --attestation-receipt-out "$RUNTIME_AUTHORITY_ATTESTOR_RECEIPT"
EXTERNAL_INGESTION_BUNDLE_SHA="$(node scripts/archive-learning-eval.mjs \
  --kind external-ingestion --print-sha \
  --source-file "$SHADOW_INGEST_RECEIPT" \
  --source-file "$TOOL_INGEST_RECEIPT" \
  --source-file "$PAIRED_INGEST_RECEIPT" \
  --source-file "$EXTERNAL_INGESTION_PROJECTION" \
  --source-file "$RUNTIME_AUTHORITY_DB_BINDING_RECEIPT" \
  --source-file "$RUNTIME_AUTHORITY_ATTESTOR_RECEIPT" \
  --source-file "$EXTERNAL_SERIES_STATUS" \
  --source-file "$BROKER_COVERAGE_INDEX" \
  --out evals/learning-episode-gate-v1/ingestions)"
node scripts/archive-learning-eval.mjs \
  --verify "evals/learning-episode-gate-v1/ingestions/$EXTERNAL_INGESTION_BUNDLE_SHA"
git add "evals/learning-episode-gate-v1/ingestions/$EXTERNAL_INGESTION_BUNDLE_SHA"
git commit -m "test(eval): freeze Runtime external evidence ingests"
if ! npx tsx scripts/learning-evidence.ts assert-pass \
  --db "$RUNTIME_DB" --tenant "$TENANT" --task-family "$TASK_FAMILY" \
  --experiment-id "$ACTIVE_EXPERIMENT_ID" --revision "$ACTIVE_REVISION" \
  --required-external-series production_shadow_gate,tool_e2e_gate,offline_paired_rerun
then
  node scripts/learning-acceptance-runtime.mjs status \
    --name active --work-dir "$ACCEPTANCE_DIR" --expect-stopped
  EXTERNAL_HOLD_REPORT=docs/research/2026-07-13-learning-external-hold-report.md
  npx tsx scripts/learning-evidence.ts report-external-prerequisites \
    --status "$EXTERNAL_SERIES_STATUS" --out "$EXTERNAL_HOLD_REPORT"
  node scripts/archive-learning-eval.mjs write-acceptance-index \
    --mode external_prerequisite_hold \
    --out evals/learning-episode-gate-v1/acceptance-index.json \
    --gate-calibration-artifact docs/research/2026-07-13-learning-gate-policy-v1-calibration.json \
    --gate-calibration-scenario-manifest docs/research/2026-07-13-learning-gate-policy-v1-calibration-scenarios.json \
    --gate-calibration-verification-receipt "$GATE_CALIBRATION_VERIFICATION_RECEIPT" \
    --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA" \
    --harness-preparation-receipt "$HARNESS_EXEC_PREP_RECEIPT" \
    --broker-lifecycle-bundle-sha256 "$BROKER_LIFECYCLE_BUNDLE_SHA" \
    --external-ingestion-bundle-sha256 "$EXTERNAL_INGESTION_BUNDLE_SHA" \
    --required-external-series-status "$EXTERNAL_SERIES_STATUS" \
    --external-terminal-coverage-index "$BROKER_COVERAGE_INDEX" \
    --external-terminal-bundle-sha256 "$SHADOW_RUN_BUNDLE_SHA" \
    --external-terminal-bundle-sha256 "$TOOL_RUN_BUNDLE_SHA" \
    --external-terminal-bundle-sha256 "$PAIRED_RUN_BUNDLE_SHA" \
    --terminal-hold-report "$EXTERNAL_HOLD_REPORT"
  git add evals/learning-episode-gate-v1/acceptance-index.json \
    "$EXTERNAL_HOLD_REPORT"
  git commit -m "test(learning): seal external prerequisite hold"
  node scripts/archive-learning-eval.mjs verify-index \
    --index evals/learning-episode-gate-v1/acceptance-index.json \
    --require-verdict hold
  exit 1
fi
run_fixture_pilot
PILOT_RUN_BUNDLE_SHA="$(node scripts/archive-learning-eval.mjs --kind result --print-sha \
  --source "$PILOT_REPORT_DIR" \
  --source-file "$ACTIVE_PROFILE_RULE" \
  --source-file "$PILOT_DIR/clone-manifest.json" \
  --source-file "$PILOT_NAMESPACE_AUDIT_MANIFEST" \
  --source-file "$PILOT_DISJOINTNESS_RESULT" \
  --source-file "$ACTIVE_APPLICABILITY_MANIFEST" \
  --source-file "$ACCEPTANCE_DIR/prepare-manifest.json" \
  --source-file "$HARNESS_EXEC_PREP_RECEIPT" \
  --source-file "$HARNESS_EXECUTION_RECEIPT_DIR/fixture-pilot.json" \
  --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA" \
  --out evals/learning-episode-gate-v1/runs)"
node scripts/archive-learning-eval.mjs \
  --verify "evals/learning-episode-gate-v1/runs/$PILOT_RUN_BUNDLE_SHA"
git add "evals/learning-episode-gate-v1/runs/$PILOT_RUN_BUNDLE_SHA"
git commit -m "test(eval): freeze fixture-only learning pilot"
if ! node scripts/archive-learning-eval.mjs assert-diagnostic-pass \
  --kind fixture_pilot \
  --run-bundle "evals/learning-episode-gate-v1/runs/$PILOT_RUN_BUNDLE_SHA" \
  --run-id "$PILOT_RUN_ID" \
  --applicability-manifest "$ACTIVE_APPLICABILITY_MANIFEST" \
  --disjointness-result "$PILOT_DISJOINTNESS_RESULT"
then
  node scripts/learning-acceptance-runtime.mjs status \
    --name active --work-dir "$ACCEPTANCE_DIR" --expect-stopped
  exit 1
fi
node scripts/learning-acceptance-runtime.mjs start \
  --name active --work-dir "$ACCEPTANCE_DIR" --db "$RUNTIME_DB" --port 3001 \
  --profile-rule-file "$ACTIVE_PROFILE_RULE" \
  --env-file /absolute/path/to/acceptance-secrets.env
node scripts/learning-acceptance-runtime.mjs status \
  --name active --work-dir "$ACCEPTANCE_DIR" --expect-db "$RUNTIME_DB" \
  --prepare-manifest "$ACCEPTANCE_DIR/prepare-manifest.json"
```

Commit the exact A/A, three prerequisite, and diagnostic pilot run-bundle
directories. The staging workspace is not authority. The pilot bundle is never
ingested as prerequisite evidence. Only after all three registered prerequisite heads
resolve to their verified passing roots may the original authority Runtime
start this exact revision for eligible-host active/control collection. The
pilot clone is never an ingestion source.

**Step 8: Collect genuine eligible-host traffic or stop at hold**

This repo now supplies strict contracts, SDK helpers, Runtime validation, and a
conformance CLI; it does not fabricate a product-specific host adapter. A named
reviewed adapter and separately provisioned eligible-host principal are an
external deployment prerequisite. Every guide request carries a protected task
envelope and every assessable memory outcome a strict use receipt. All guide
exposures count in assignment/missingness even if the host abandons them.

Collect real tasks across all three preregistered activation waves. Each host
run is written once to a unique sealed directory. A canonical cumulative run
index binds wave/run order, adapter image and identity, applicability/window,
every sanitized root digest, and its archive receipt. Reusing or overwriting a
path fails. The adapter activates both members of a pair together and never
sees the hidden arm.

**Step 9: Evaluate the three checkpoints without stopping on an ordinary hold**

Checkpoint 1 is safety/integrity-only; it must not emit promotion, demotion, or
retirement readiness. Checkpoints 2 and 3 are the two formal looks. Each has a
separate sealed proposal/integrity/reservation/snapshot/evaluation directory and
its own integrity and cumulative online bundle. A `hold` at checkpoint 1 or 2,
with no automatic pause or integrity stop, preserves the Runtime and leases and
continues to the next wave. Stop only on a safety/integrity pause, a terminal
readiness verdict, or completion of checkpoint 3. A separately signed
operational close aborts this release-acceptance run and is archived under the
closure protocol; it does not create a successful checkpoint index.

```bash
set -euo pipefail
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
ACTIVE_HOST_RUN_ROOT="$ACCEPTANCE_DIR/active-host-runs/$ACTIVE_EXPERIMENT_ID-r$ACTIVE_REVISION"
ACTIVE_HOST_RUN_INDEX="$ACTIVE_HOST_RUN_ROOT/active-host-run-index.json"
CHECKPOINT_ROOT="$ACCEPTANCE_DIR/checkpoints/$ACTIVE_EXPERIMENT_ID-r$ACTIVE_REVISION"
CHECKPOINT_BUNDLE_INDEX="$CHECKPOINT_ROOT/checkpoint-bundle-index.json"

"$HOST_ADAPTER_CTL" verify-identity-boundary \
  --adapter-identity "$HOST_ADAPTER_IDENTITY" \
  --eval-identity "$EVAL_IDENTITY" --secret-ref "$HOST_SECRET_REF" \
  --verify-prior-result "$HOST_IDENTITY_BOUNDARY_RESULT"

for CHECKPOINT in 1 2 3
do
  WAVE="$CHECKPOINT"
  ACTIVE_RUN_ID="learning-active-wave-$WAVE-<utc>"
  SEALED_HOST_RUN="$ACTIVE_HOST_RUN_ROOT/wave-$WAVE/$ACTIVE_RUN_ID"
  LOOK_DIR="$CHECKPOINT_ROOT/checkpoint-$CHECKPOINT"
  PROPOSAL="$LOOK_DIR/proposal.json"
  INTEGRITY_DIR="$LOOK_DIR/integrity"
  ONLINE_DIR="$LOOK_DIR/online"

  "$HOST_ADAPTER_CTL" collect-learning-active \
    --adapter-identity "$HOST_ADAPTER_IDENTITY" --secret-ref "$HOST_SECRET_REF" \
    --base-url http://127.0.0.1:3001 \
    --applicability-manifest "$ACTIVE_APPLICABILITY_MANIFEST" \
    --activation-wave "$WAVE" --run-id "$ACTIVE_RUN_ID" \
    --sealed-sanitized-out "$SEALED_HOST_RUN" --readable-by "$EVAL_IDENTITY"
  node scripts/archive-learning-eval.mjs append-host-run-index \
    --index "$ACTIVE_HOST_RUN_INDEX" --wave "$WAVE" \
    --sealed-source "$SEALED_HOST_RUN" \
    --applicability-manifest "$ACTIVE_APPLICABILITY_MANIFEST" \
    --adapter-identity-result "$HOST_IDENTITY_BOUNDARY_RESULT"

  node scripts/learning-acceptance-runtime.mjs status \
    --name active --work-dir "$ACCEPTANCE_DIR" --expect-db "$RUNTIME_DB" \
    --prepare-manifest "$ACCEPTANCE_DIR/prepare-manifest.json"
  npx tsx scripts/learning-evidence.ts propose-look \
    --db "$RUNTIME_DB" --tenant "$TENANT" --actor evidence-monitor \
    --task-family "$TASK_FAMILY" --experiment-id "$ACTIVE_EXPERIMENT_ID" \
    --revision "$ACTIVE_REVISION" --expected-checkpoint "$CHECKPOINT" \
    --out "$PROPOSAL"

  npx tsx scripts/runtime-data-ops.ts verify --db "$RUNTIME_DB" \
    --learning-proposal "$PROPOSAL" \
    --learning-artifact-out "$INTEGRITY_DIR/runtime_integrity_gate.json"
  INTEGRITY_RUN_BUNDLE_SHA="$(node scripts/archive-learning-eval.mjs \
    --kind result --print-sha --source "$INTEGRITY_DIR" \
    --source-file "$PROPOSAL" --source-file "$ACTIVE_PROFILE_RULE" \
    --source-file "$ACTIVE_APPLICABILITY_MANIFEST" \
    --source-file "$ACCEPTANCE_DIR/prepare-manifest.json" \
    --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA" \
    --out evals/learning-episode-gate-v1/runs)"
  node scripts/archive-learning-eval.mjs \
    --verify "evals/learning-episode-gate-v1/runs/$INTEGRITY_RUN_BUNDLE_SHA"
  git add "evals/learning-episode-gate-v1/runs/$INTEGRITY_RUN_BUNDLE_SHA"
  git commit -m "test(learning): freeze checkpoint $CHECKPOINT integrity evidence"

  npx tsx scripts/learning-evidence.ts reserve-look \
    --db "$RUNTIME_DB" --tenant "$TENANT" --actor evidence-freezer \
    --operation-id "reserve-checkpoint:$ACTIVE_EXPERIMENT_ID:$ACTIVE_REVISION:$CHECKPOINT" \
    --task-family "$TASK_FAMILY" --experiment-id "$ACTIVE_EXPERIMENT_ID" \
    --revision "$ACTIVE_REVISION" --proposal "$PROPOSAL" \
    --integrity-run-bundle "evals/learning-episode-gate-v1/runs/$INTEGRITY_RUN_BUNDLE_SHA" \
    --integrity-run-bundle-sha256 "$INTEGRITY_RUN_BUNDLE_SHA" \
    --out "$ONLINE_DIR/look-reservation.json" \
    --result-out "$LOOK_DIR/reserve-result.json"
  RESERVATION_CREATED="$(node -p 'Boolean(require(process.argv[1]).reservation_created)' "$LOOK_DIR/reserve-result.json")"
  if test "$RESERVATION_CREATED" != true
  then
    SAFETY_AUTHORITY_RECEIPT_SHA="$(node -p \
      'require(process.argv[1]).automatic_safety_authority_receipt_sha256' \
      "$LOOK_DIR/reserve-result.json")"
    INTEGRITY_STOP_RUN_BUNDLE_SHA="$(node scripts/archive-learning-eval.mjs \
      --kind result --print-sha --source-file "$LOOK_DIR/reserve-result.json" \
      --source-index "$ACTIVE_HOST_RUN_INDEX" \
      --source-index-prefix-through-wave "$WAVE" \
      --source-file "$ACTIVE_APPLICABILITY_MANIFEST" \
      --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA" \
      --out evals/learning-episode-gate-v1/runs)"
    node scripts/archive-learning-eval.mjs \
      --verify "evals/learning-episode-gate-v1/runs/$INTEGRITY_STOP_RUN_BUNDLE_SHA"
    node scripts/archive-learning-eval.mjs append-checkpoint-index \
      --index "$CHECKPOINT_BUNDLE_INDEX" --checkpoint "$CHECKPOINT" \
      --host-run-index "$ACTIVE_HOST_RUN_INDEX" \
      --integrity-run-bundle-sha256 "$INTEGRITY_RUN_BUNDLE_SHA" \
      --terminal-integrity-run-bundle-sha256 "$INTEGRITY_STOP_RUN_BUNDLE_SHA" \
      --safety-authority-receipt-sha256 "$SAFETY_AUTHORITY_RECEIPT_SHA"
    git add "evals/learning-episode-gate-v1/runs/$INTEGRITY_STOP_RUN_BUNDLE_SHA"
    git commit -m "test(learning): record checkpoint $CHECKPOINT integrity stop"
    break
  fi
  npx tsx scripts/learning-evidence.ts freeze-online \
    --db "$RUNTIME_DB" --tenant "$TENANT" --actor evidence-freezer \
    --reservation "$ONLINE_DIR/look-reservation.json" \
    --out "$ONLINE_DIR/online-ledger-snapshot.json"
  npx tsx scripts/learning-evidence.ts evaluate \
    --db "$RUNTIME_DB" --tenant "$TENANT" --actor evidence-evaluator \
    --operation-id "evaluate-checkpoint:$ACTIVE_EXPERIMENT_ID:$ACTIVE_REVISION:$CHECKPOINT" \
    --reservation "$ONLINE_DIR/look-reservation.json" \
    --ledger-snapshot "$ONLINE_DIR/online-ledger-snapshot.json" \
    --out "$ONLINE_DIR/evaluation.json"

  ONLINE_RUN_BUNDLE_SHA="$(node scripts/archive-learning-eval.mjs \
    --kind result --print-sha --source "$ONLINE_DIR" \
    --source-index "$ACTIVE_HOST_RUN_INDEX" \
    --source-index-prefix-through-wave "$WAVE" \
    --source-file "$ACTIVE_PROFILE_RULE" \
    --source-file "$ACTIVE_APPLICABILITY_MANIFEST" \
    --source-file "$HOST_IDENTITY_BOUNDARY_RESULT" \
    --source-file "$ACCEPTANCE_DIR/prepare-manifest.json" \
    --source-file "$HARNESS_EXEC_PREP_RECEIPT" \
    --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA" \
    --out evals/learning-episode-gate-v1/runs)"
  node scripts/archive-learning-eval.mjs \
    --verify "evals/learning-episode-gate-v1/runs/$ONLINE_RUN_BUNDLE_SHA"
  node scripts/archive-learning-eval.mjs append-checkpoint-index \
    --index "$CHECKPOINT_BUNDLE_INDEX" --checkpoint "$CHECKPOINT" \
    --host-run-index "$ACTIVE_HOST_RUN_INDEX" \
    --integrity-run-bundle-sha256 "$INTEGRITY_RUN_BUNDLE_SHA" \
    --online-run-bundle-sha256 "$ONLINE_RUN_BUNDLE_SHA" \
    --evaluation "$ONLINE_DIR/evaluation.json"
  git add "evals/learning-episode-gate-v1/runs/$ONLINE_RUN_BUNDLE_SHA"
  git commit -m "test(learning): freeze checkpoint $CHECKPOINT evidence"

  VERDICT="$(node -p 'require(process.argv[1]).evidence_verdict' "$ONLINE_DIR/evaluation.json")"
  AUTHORITY_PAUSED="$(node -p 'Boolean(require(process.argv[1]).automatic_safety_authority_appended)' "$ONLINE_DIR/evaluation.json")"
  if test "$AUTHORITY_PAUSED" = true || test "$VERDICT" != hold
  then
    break
  fi
done

npx tsx scripts/learning-evidence.ts report-series \
  --db "$RUNTIME_DB" --tenant "$TENANT" --actor evidence-reporter \
  --checkpoint-index "$CHECKPOINT_BUNDLE_INDEX" \
  --out docs/research/2026-07-13-learning-episode-evidence-report.md
node scripts/learning-acceptance-runtime.mjs stop \
  --all --work-dir "$ACCEPTANCE_DIR"
trap - EXIT INT TERM
```

`append-host-run-index` and `append-checkpoint-index` are deterministic,
append-only index builders: they reject path reuse, changed earlier entries,
noncontiguous waves/checkpoints, a non-cumulative source prefix, or a bundle
whose manifest does not contain every indexed root through its cutoff. If a
wave needs multiple host runs, each gets its own sealed directory and is added
before that checkpoint. `propose-look` remains unavailable until the registered
`wave_analysis_at`; waiting or insufficient coverage is ordinary `hold`, not a
reason to replace a namespace. `report-series` accepts the same tagged union:
it renders an evaluated checkpoint normally, or terminates the series from a
verified `integrity_stop` entry without inventing a reservation, online cohort,
evaluation ID, or verdict.

Expected reporting keeps the finite-holdout regression, online safety,
tool/action, shadow, integrity, descriptive negative direct-use, and missingness
separate. Checkpoint 1 can only hold/pause. A stateful registered safety trigger
appends the automatic safety-stop authority and receipt atomically; readiness
never automatically promotes, demotes, or retires. A checkpoint-2 `hold`
continues wave 3; only the conditions listed above stop collection.

Finally write one committed acceptance root with a tagged top-level mode.
`checkpoint_series` contains schema/version,
Runtime and runner commits, the registered prospective calibration artifact,
harness/preparation, broker lifecycle bundle (launch/identity/drain/pre-stop/
coverage-final/stop), and host
identity receipts, A/A and
pilot bundles, and all three external verified `passed` result bundles, each
with reservation/consumption/claim/binding/normal termination, plus the
committed `external-ingestion` bundle proving their exact protected operation
receipts, evidence rows, and current registered series heads under the frozen
Runtime authority-attestor signature/database lineage/head. It also binds the
ordered checkpoint tagged-union index and final report digest. A failed/
inconclusive result or either hold branch makes this mode invalid. Every `evaluated`
checkpoint binds host/integrity/reservation/online/evaluation ID+verdict; a
terminal `integrity_stop` instead binds
host/integrity/terminal-integrity/safety-authority receipt and forbids those
evaluation fields. Empty/non-64hex values, untracked bundles, noncontiguous
checkpoints, non-cumulative host prefixes, invalid union shapes, or missing
wrapper/broker receipts are rejected. So is a root whose last entry is an
ordinary checkpoint-1/2 `evaluated:hold`; an evaluated automatic pause binds
and verifies its safety-authority receipt.
`external_prerequisite_hold` is the early terminal mode when any prerequisite
is `failed|inconclusive` or takes a pre-claim/claimed-termination hold. It binds
the preregistered required-series status (allowing truly unstarted series but
never a reserved-unconsumed series), every consumed reservation's exact
terminal coverage branch, all result/hold bundle digests, the broker lifecycle
bundle, the committed external-ingestion bundle proving all and only result
branches became Runtime series heads under that same registered attestation,
and a terminal hold report; it forbids pilot,
active-host, checkpoint, evaluation, and readiness fields and can only verify a
release verdict of `hold`. Thus a prerequisite hold has a complete committable
root without fabricating checkpoints that never ran. The index writer stores
only committed content identities/bundle refs; fresh-shell verification never
reads the original acceptance directory. External bundles may contain launch/
health/drain/pre-stop bytes, while coverage-final/stop appear only through the
separate lifecycle bundle; any reverse reference or digest cycle is rejected.

```bash
ACCEPTANCE_INDEX=evals/learning-episode-gate-v1/acceptance-index.json
GATE_CALIBRATION_ARTIFACT=docs/research/2026-07-13-learning-gate-policy-v1-calibration.json
GATE_CALIBRATION_SCENARIO_MANIFEST=docs/research/2026-07-13-learning-gate-policy-v1-calibration-scenarios.json
GATE_CALIBRATION_VERIFICATION_RECEIPT="$ACCEPTANCE_DIR/gate-calibration-verification.json"
node scripts/archive-learning-eval.mjs write-acceptance-index \
  --out "$ACCEPTANCE_INDEX" \
  --gate-calibration-artifact "$GATE_CALIBRATION_ARTIFACT" \
  --gate-calibration-scenario-manifest "$GATE_CALIBRATION_SCENARIO_MANIFEST" \
  --gate-calibration-verification-receipt \
    "$GATE_CALIBRATION_VERIFICATION_RECEIPT" \
  --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA" \
  --harness-preparation-receipt "$HARNESS_EXEC_PREP_RECEIPT" \
  --identity-boundary-result "$HOST_IDENTITY_BOUNDARY_RESULT" \
  --mode checkpoint_series \
  --broker-lifecycle-bundle-sha256 "$BROKER_LIFECYCLE_BUNDLE_SHA" \
  --external-ingestion-bundle-sha256 "$EXTERNAL_INGESTION_BUNDLE_SHA" \
  --external-terminal-coverage-index "$BROKER_COVERAGE_INDEX" \
  --aa-run-bundle-sha256 "$AA_RUN_BUNDLE_SHA" \
  --pilot-run-bundle-sha256 "$PILOT_RUN_BUNDLE_SHA" \
  --external-run-bundle-sha256 "$SHADOW_RUN_BUNDLE_SHA" \
  --external-run-bundle-sha256 "$TOOL_RUN_BUNDLE_SHA" \
  --external-run-bundle-sha256 "$PAIRED_RUN_BUNDLE_SHA" \
  --checkpoint-index "$CHECKPOINT_BUNDLE_INDEX" \
  --final-report docs/research/2026-07-13-learning-episode-evidence-report.md
git add "$ACCEPTANCE_INDEX" \
  docs/research/2026-07-13-learning-episode-evidence-report.md
git commit -m "test(learning): seal learning acceptance index"
node scripts/archive-learning-eval.mjs verify-index --index "$ACCEPTANCE_INDEX"
```

If a prerequisite is `failed|inconclusive` or terminates in either hold branch,
do not continue to pilot or active collection. The recovery procedure first
closes any already-reserved/unconsumed sibling through `close-reserved-run`,
then drains terminal facts, writes the pre-stop status, and archives every already completed result plus the new
`termination-hold` or `preclaim-hold` bundle, commits them, writes the coverage
index, ingests every result branch regardless of verdict, exports and archives
the external-ingestion authority bundle (including a zero-result projection),
obtains coverage-final, stops the daemon, and archives the lifecycle bundle in
the same acyclic order above. It then seals the early root:

```bash
RECOVERY_DIR="$ACCEPTANCE_DIR/external-prerequisite-recovery"
RECOVERY_PREPARED_PLAN="$RECOVERY_DIR/prepared-sealing-plan.json"
EXTERNAL_SERIES_STATUS="$RECOVERY_DIR/required-series-status.json"
RECOVERY_GIT_PATHSPEC="$RECOVERY_DIR/prepared-bundle-pathspec.nul"
RECOVERY_LIFECYCLE_SHA_OUT="$RECOVERY_DIR/broker-lifecycle-sha.txt"
RECOVERY_INGESTION_SHA_OUT="$RECOVERY_DIR/external-ingestion-sha.txt"
node scripts/seal-learning-external-prerequisites.mjs prepare-recovery \
  --plan "$EXTERNAL_RECOVERY_PLAN" \
  --broker "$FORMAL_RUN_BROKER" --broker-socket "$BROKER_SOCKET" \
  --service-launcher "$BROKER_SERVICE_LAUNCHER" \
  --db "$RUNTIME_DB" --tenant "$TENANT" \
  --public-terminal-fact-dir "$BROKER_PUBLIC_TERMINAL_FACT_DIR" \
  --drain-receipt-out "$BROKER_DRAIN_RECEIPT" \
  --pre-stop-status-out "$BROKER_PRESTOP_STATUS_RECEIPT" \
  --archive-root evals/learning-episode-gate-v1 \
  --prepared-plan-out "$RECOVERY_PREPARED_PLAN" \
  --git-pathspec-out "$RECOVERY_GIT_PATHSPEC"
git add --pathspec-from-file="$RECOVERY_GIT_PATHSPEC" --pathspec-file-nul
git commit -m "test(learning): freeze external prerequisite terminal branches"
node scripts/seal-learning-external-prerequisites.mjs seal-recovery \
  --prepared-plan "$RECOVERY_PREPARED_PLAN" --expect-head HEAD \
  --broker "$FORMAL_RUN_BROKER" --broker-socket "$BROKER_SOCKET" \
  --service-launcher "$BROKER_SERVICE_LAUNCHER" \
  --service-launch-receipt "$BROKER_SERVICE_LAUNCH_RECEIPT" \
  --db "$RUNTIME_DB" --tenant "$TENANT" \
  --runtime-authority-attestor "$RUNTIME_AUTHORITY_ATTESTOR" \
  --runtime-authority-attestor-launcher "$RUNTIME_AUTHORITY_ATTESTOR_LAUNCHER" \
  --runtime-authority-attestor-service-identity \
    "$RUNTIME_AUTHORITY_ATTESTOR_SERVICE_IDENTITY" \
  --runtime-authority-attestor-policy "$RUNTIME_AUTHORITY_ATTESTOR_POLICY" \
  --runtime-authority-db-slot "$RUNTIME_AUTHORITY_DB_SLOT" \
  --runtime-authority-db-binding-receipt \
    "$RUNTIME_AUTHORITY_DB_BINDING_RECEIPT" \
  --runtime-authority-attestation-receipt-out \
    "$RUNTIME_AUTHORITY_ATTESTOR_RECEIPT" \
  --series-status-out "$EXTERNAL_SERIES_STATUS" \
  --coverage-index-out "$BROKER_COVERAGE_INDEX" \
  --coverage-final-out "$BROKER_COVERAGE_FINAL_RECEIPT" \
  --service-stop-out "$BROKER_SERVICE_STOP_RECEIPT" \
  --lifecycle-root evals/learning-episode-gate-v1/lifecycle \
  --lifecycle-sha-out "$RECOVERY_LIFECYCLE_SHA_OUT" \
  --ingestion-root evals/learning-episode-gate-v1/ingestions \
  --ingestion-sha-out "$RECOVERY_INGESTION_SHA_OUT"
BROKER_STOPPED=1
BROKER_LIFECYCLE_BUNDLE_SHA="$(tr -d '\n' < "$RECOVERY_LIFECYCLE_SHA_OUT")"
EXTERNAL_INGESTION_BUNDLE_SHA="$(tr -d '\n' < "$RECOVERY_INGESTION_SHA_OUT")"
git add "evals/learning-episode-gate-v1/lifecycle/$BROKER_LIFECYCLE_BUNDLE_SHA" \
  "evals/learning-episode-gate-v1/ingestions/$EXTERNAL_INGESTION_BUNDLE_SHA"
git commit -m "test(learning): freeze recovered lifecycle and Runtime ingests"
npx tsx scripts/learning-evidence.ts report-external-prerequisites \
  --status "$EXTERNAL_SERIES_STATUS" \
  --out docs/research/2026-07-13-learning-external-hold-report.md
node scripts/archive-learning-eval.mjs write-acceptance-index \
  --mode external_prerequisite_hold \
  --out evals/learning-episode-gate-v1/acceptance-index.json \
  --gate-calibration-artifact "$GATE_CALIBRATION_ARTIFACT" \
  --gate-calibration-scenario-manifest "$GATE_CALIBRATION_SCENARIO_MANIFEST" \
  --gate-calibration-verification-receipt "$GATE_CALIBRATION_VERIFICATION_RECEIPT" \
  --harness-bundle-sha256 "$HARNESS_BUNDLE_SHA" \
  --harness-preparation-receipt "$HARNESS_EXEC_PREP_RECEIPT" \
  --broker-lifecycle-bundle-sha256 "$BROKER_LIFECYCLE_BUNDLE_SHA" \
  --external-ingestion-bundle-sha256 "$EXTERNAL_INGESTION_BUNDLE_SHA" \
  --required-external-series-status "$EXTERNAL_SERIES_STATUS" \
  --external-terminal-coverage-index "$BROKER_COVERAGE_INDEX" \
  --external-terminal-bundles-from-plan "$RECOVERY_PREPARED_PLAN" \
  --terminal-hold-report docs/research/2026-07-13-learning-external-hold-report.md
git add evals/learning-episode-gate-v1/acceptance-index.json \
  docs/research/2026-07-13-learning-external-hold-report.md
git commit -m "test(learning): seal external prerequisite hold root"
node scripts/archive-learning-eval.mjs verify-index \
  --index evals/learning-episode-gate-v1/acceptance-index.json \
  --require-verdict hold
```

This mode rejects checkpoint/pilot/active/evaluation fields, an uncommitted or
ambiguous coverage branch, a hold passed to evidence ingestion, or any reported
verdict other than `hold`.

The following is an operator runbook example only. It targets the live Runtime
authority DB, never an export/copy, and requires a separately issued signed
approval manifest:

```bash
npx tsx scripts/learning-evidence.ts adjudicate \
  --db /absolute/path/to/runtime-authority.sqlite \
  --tenant <tenant-id> --actor <approved-actor> \
  --operation-id <approved-operation-id> \
  --approval /secure/path/to/learning-authority-approval.json \
  --experiment-id <id> --revision <revision> \
  --approved-evidence-decision-id <decision-id> \
  --approved-cohort-sha256 <cohort-sha256> \
  --approved-artifact-set-sha256 <artifact-set-sha256> \
  --expected-candidate-policy-version <version> \
  --expected-candidate-implementation-sha256 <sha256> \
  --expected-gate-config-version <version>
```

A signed terminal adjudication releases the full namespace lease set in the
same transaction. If acceptance ends at `hold` and the operator chooses to stop
rather than await the next registered look, use the separate signed close
authority; it seals the attempt but makes no evidence claim:

```bash
npx tsx scripts/learning-experiment.ts close \
  --db /absolute/path/to/runtime-authority.sqlite \
  --tenant <tenant-id> --actor <approved-actor> \
  --operation-id <approved-close-operation-id> \
  --approval /secure/path/to/learning-experiment-close-approval.json \
  --experiment-id <id> --revision <revision>
```

**Step 10: Run final-tree CI and release gates**

Run this only after the acceptance supervisor, archive scripts/tests, harness
bundle, run bundles, and evidence report are all in their final committed form.
This is the authoritative full check; the earlier Task 11.2 pass does not cover
files introduced by Task 11.3.

```bash
set -euo pipefail
cd /Volumes/ziel/new.aionis/AionisRuntime-focused
INDEX=evals/learning-episode-gate-v1/acceptance-index.json
node --test scripts/ci/archive-learning-eval.test.mjs
node --test scripts/ci/run-learning-harness.test.mjs
node --test scripts/ci/learning-acceptance-runtime.test.mjs
node --test scripts/ci/formal-learning-run-broker.test.mjs
node --test scripts/ci/seal-learning-external-prerequisites.test.mjs
node scripts/archive-learning-eval.mjs verify-index --index "$INDEX"
node scripts/run-learning-harness.mjs verify-index --index "$INDEX"
npm run -s typecheck
npm run -s sdk:check -- --sdk-repo /Volumes/ziel/new.aionis/aionis-sdk
npm run -s lite:test
npm run -s lite:smoke
npm run -s complexity:check
node scripts/ci/release-artifact-gate.mjs --check
node --test scripts/ci/release-version-docs.test.mjs
git diff --check
test -z "$(git status --porcelain)"
```

Run this block from a fresh shell: only `INDEX` is supplied. `verify-index`
loads every digest and receipt from committed bytes, verifies all referenced
objects are tracked at `HEAD`, checks all external terminal results and every
checkpoint array/prefix, verifies the external-ingestion authority signature,
database lineage/head and frozen attestor service/launcher/binary/policy/key
identity, fully recomputes the registered calibration from its
tracked scenario manifest and deterministic shards, and rematerializes or
cryptographically verifies the committed harness without relying on an old
execution directory. Expected:
PASS on a clean final tree. Any generated acceptance file not explicitly
archived/committed is staging only and cannot satisfy this gate.

## Release checklist

- [ ] R1 v3-compatible binary deployed with serving off.
- [ ] Upgrade/verify/backup runbooks tested on a copy.
- [ ] All guide/feedback/measure dual-writes atomic.
- [ ] Protected retry returns exact prior result.
- [ ] A/A assignment stable across restart with no assignment-integrity finding.
- [ ] Both A/A passes consume and archive the exact A/A applicability manifest.
- [ ] Fixture-pilot and eligible-host principals are distinct, frozen, and
      server-classified; pilot/auth-off rows are absent from the gate cohort.
- [ ] Named real host adapter passes task-envelope/use-receipt conformance; no
      adapter means `hold`; adapter/eval run as distinct OS identities, eval
      secret-read/eligible-call negative tests pass, and sanitized conformance
      plus identity-boundary results are archived.
- [ ] Every eval ran from the committed materialized harness under the eval
      identity; pre/post source verification and execution receipts are archived.
- [ ] New current-revision shadow projection passes broad gate with zero
      hard-boundary upgrade; historical gate evidence is excluded.
- [ ] One named profile/task family and one fixed 50/50 matched-pair
      confirmatory design preregistered before outcome-bearing candidate traffic;
      all 384 pairs/768 namespaces and 96/96/192 activation waves are leased and
      frozen with no assignment-randomness redraw.
- [ ] Outcome-free prospective calibration artifact is committed, reproduces
      exact raw counts, meets joint promotion/demotion power and terminal-hold
      thresholds, and its registered digest matches the running gate policy.
- [ ] 96/192/384 cumulative-pair checkpoints registered before collection;
      checkpoint 1 is safety/integrity-only and formal checkpoints 2/3 use
      exact finite-population `1/80` inference per direction/look.
- [ ] Outcome-blind reservation proves one machine-derived cutoff per look;
      future time and mid-look re-evaluation are rejected.
- [ ] Immediate feedback/pause/inspect/control transaction and next-guide fallback tested.
- [ ] `promotion_ready` alone proven unable to mutate authority.
- [ ] Explicit authority rejects missing/invalid signed approval.
- [ ] Broker launch/health receipts prove the registered dedicated UID/GID,
      socket peer checks, binary/policy/key digests, private-root/spool ACLs and
      the authenticated deployment-launcher channel,
      and stdin-only pre-fsynced tickets; the acceptance/eval identities cannot
      read ticket, session, provider-secret, or broker-journal bytes.
- [ ] Every consumed shadow/tool/offline reservation has exactly one result,
      claimed-termination-hold, or pre-claim-hold bundle. Result paths were
      claimed before capabilities/outcomes; the launcher bound the exact
      executable/argv/PID-start-cgroup-job and pathless channel in Runtime,
      rejected same-UID supervisor/child-relay races, and result paths cleanly
      quiesced with every in-flight call reconciled and a signed public chain.
      Every claimed path was revoked/drained/signed and append-only terminated;
      pre-claim holds prove zero claim/capability/mount/provider call. Only
      result branches were ingested, both hold kinds force release hold,
      and the committed external-ingestion bundle carries a valid registered
      Runtime-authority signature over the live DB lineage/head, exact evidence
      rows, operation receipts, series heads, and terminal coverage;
      unsigned/self-signed/copied-DB/stale-head projections are rejected,
      post-quiesce provider/mount calls were denied, no successor exists, and a
      non-pass or hold burns the implementation attempt. Pre-stop status,
      terminal bundles, coverage-final status, and service stop are acyclic and
      committed in that order.
- [ ] Offline uses a sealed, previously unseen, non-overlapping 96-case holdout
      whose reference/ciphertext and ordered members match the reservation
      before claim/credential/mount/call, plus immutable model/runtime/tool and
      deterministic execution digests;
      the current mutable DeepSeek profiles are diagnostic-only and force hold.
- [ ] Every active wave uses unique sealed host-run directories; each checkpoint
      bundle proves the cumulative run-index prefix, and ordinary hold at
      checkpoint 1/2 continues rather than stopping the Runtime.
- [ ] Every checkpoint-index entry validates exactly one tagged shape:
      evaluated integrity/reservation/online/evaluation, or terminal integrity
      plus automatic-safety receipt with no fabricated online/evaluation fields.
- [ ] Acceptance root ends only at checkpoint 3, a non-hold/automatic-pause
      evaluated checkpoint, or integrity stop; checkpoint-1/2 ordinary hold
      cannot truncate the remaining frozen waves.
- [ ] Real online look uses the exact scheduled matched-pair prefix and has at
      least 96 conclusive exploit namespaces in each arm; no-index units remain
      missing and task/repository variants do not increase n.
- [ ] Fixture pilots ran only on a disjoint clone/scope set; no fixture or second
      experiment overlaps an active confirmatory namespace lease.
- [ ] Signed close and terminal adjudication both release exactly the full lease
      set with replayable authority refs; partial/arbitrary release is rejected.
- [ ] Evaluation uses explicit live authority DB/tenant/actor and immutable look
      reservation; exported JSON is reconciliation-only.
- [ ] Current v2 binary excluded as a post-upgrade rollback target.
- [ ] Committed acceptance index verifies every nonempty digest, reservation,
      ticket consumption, claim, session termination, calibration artifact,
      broker/wrapper receipt, Runtime-authority attestation and database head,
      prerequisite and
      checkpoint bundle from a fresh shell; final tree is clean.
- [ ] Final-tree full CI, complexity, release gates, backup/restore, and
      real-Agent acceptance pass after all Task 11.3 files/artifacts exist.

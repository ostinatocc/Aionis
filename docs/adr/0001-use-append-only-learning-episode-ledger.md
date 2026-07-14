# ADR-0001: Use an Append-Only Relational Learning Episode Ledger

## Status

Proposed; episode granularity accepted on 2026-07-13.

## Context

Aionis already has strong but separate artifacts for guide exposure, memory and
tool feedback, product measurement, admission evaluation, promotion evidence,
and controlled forgetting. It does not have one durable evidence chain that can
answer:

- which policy and experiment revision produced a served guide decision;
- whether a memory decision was exploration or exploitation before outcome;
- which exact episode and memory/tool subject received feedback;
- whether an effect measurement belongs to the same evidence chain;
- which bounded cohort authorized task-family promotion or demotion.

The current guide ledger stores only final surfaces. Memory feedback is mostly
represented by mutable node counters and loses `guide_trace_id` before the
mutation. Tool feedback validates a guide receipt but does not carry that ID
into the learning kernel and does not have a shared outer transaction.
Measurement uses a second writer connection. Existing promotion protocol fields
support wider-generalization evidence, but workflow promotion callers do not
populate them.

The Runtime is a local modular monolith using one file-backed SQLite database.
The design must preserve this operational model, keep the global candidate
default off, and avoid inventing another truth for artifacts that already have
an authority store.

## Decision

Use an append-only, relational learning ledger in the existing Lite Runtime
SQLite database.

One committed `/v1/guide` exposure is one episode. The ledger contains:

1. immutable experiment revisions and one append-only confirmatory-attempt
   registration per task-family candidate implementation contract;
2. finite store-memory-namespace lease authority and append-only signed
   experiment closures;
3. ordered episode event envelopes;
4. immutable per-memory exposure decisions with frozen prior state and
   exploration/exploitation track;
5. immutable per-subject feedback attributions;
6. immutable, bounded canonical host-use receipt headers for restart-safe
   verification and cross-episode reuse prevention;
7. immutable pre-run external reservations, one-time ticket consumptions,
   zero-effects pre-claim holds, runner claims, launcher-authenticated
   supervisor bindings, bounded monitored credential sessions, signed
   append-only session terminations, bounded holdout memberships, and exact
   result-or-hold terminal coverage;
8. append-only task-family evidence evaluations and authority adjudications
   over reproducible evidence cohorts;
9. exact gate-to-artifact membership rows.

One mutable, durable `lite_learning_control_jobs` queue supports asynchronous
repeated-unused posture work. It is operational state, not evidence authority,
and is separate from the existing associative-link-only outbox.
Namespace leases are also operational state. Their row triggers preserve every
acquisition field, permit only `active -> released`, and forbid delete. SQLite
row triggers do not claim to enforce a multi-row complete-set release. The only
supported protected store methods enforce full-set membership, authority-ref
resolution, and monotone generation inside `BEGIN IMMEDIATE`; reopen
verification treats any direct-SQL partial/mixed/gapped state as corruption and
fails serving/backup/adjudication closed. Acquisition facts and
closure/adjudication refs remain replayable.

Existing artifacts remain authoritative for their own content:

- guide receipts define actually served surfaces;
- memory/tool commits define domain mutations;
- product measurements define effect reports;
- episode rows define cross-stage identity, decision-time facts, and sequence;
- evidence artifacts preserve validated offline/prerequisite gate inputs;
- gate decisions separately define evidence readiness and aggregate authority
  adjudication.

No persistent mutable `LearningEpisodeProjection` is introduced in v1. Read
models replay the ledger. Existing node counters remain operational projections,
not the sole authority for post-v3 feedback facts.

Randomized enrollment uses an immutable experiment revision with an explicit
`aa`, `shadow`, or `active_control` phase. Confirmatory active/control uses a
matched-pair store-memory-namespace random bit vector kept
confidential in the authority database while exposing its digest for audit. An
independent 32-byte diagnostic seed exists for every revision, including active
fixture traffic; it is never derived from the confirmatory bits. The namespace is the existing canonical
`resolveTenantScope(...).scope_key` used by Lite node/commit state; repositories,
task signatures, and calls inside it cannot split arms or add statistical units.
Runtime alone draws exactly 384 independent unbiased bits (48 bytes) from the
operating-system CSPRNG and maps them directly to canonical pair order.
Confirmatory provisioning requires a finite reviewed manifest of 384
pre-outcome matched pairs, exact one-candidate/one-control bit assignment
inside every pair, a fixed 96/96/192-pair activation schedule, and atomic
acquisition of the full 768-namespace lease set. Randomness is never redrawn based
on arm counts. A/A and shadow are integrity only; `active_control` is the
single preregistered confirmatory revision for its task-family candidate
implementation digest. Its allocation stays fixed, so changing revision or
ID/version alias cannot reset the two-formal-look alpha budget. The first
96-pair checkpoint is safety/integrity-only; cumulative 192/384-pair formal
looks each use exact `1/80` per direction. Exploration/exploitation is
frozen per memory decision before assignment is served. Same-call shadow proves
projection correctness, online arms prove operational safety and real-use
behavior. Online bounds use finite-population matched-pair randomization
inversion rather than iid Bernoulli assumptions. The one-shot paired real-Agent
run is a deterministic integer regression on its exact 96-case reviewed
holdout, not an iid/superpopulation causal estimate; mutable provider profiles
are diagnostic-only and force `hold`.
The schedule remains `calibration_pending` until an outcome-free prospective
artifact demonstrates, with frozen exact one-sided 99% Clopper-Pearson rules,
at least 80% joint promotion power and at most 20% terminal hold in target-safe
scenarios. Exploit-harm scenarios require at least 80% probability of the
specific `verified_candidate_absolute_harm_pause OR
exploit_harm_demotion_ready` union; unrelated pause causes do not count. Other
harmful endpoints remain diagnostic because v1 has no demotion alpha for them.
The artifact separately reports pause and unconditional/conditional demotion,
and binds the scenario grid, exact engine, deterministic shards, seed/counts,
and review.
Failure requires a new pre-outcome policy design; live outcomes may never tune
the schedule.
Task-family promotion requires all three evidence roles and an explicit wider-
generalization protocol.

The immutable revision also maps authenticated principal fingerprints to
class plus collector ID/version. Runtime derives that classification from the
existing resolved principal; clients cannot assert it in a request body.
Eligible hosts also require a protected pre-assignment task envelope and strict
post-use receipt. Pilot, auth-off, unverified, offline, and legacy traffic
remains replayable but cannot enter the confirmatory online cohort.

Every promotion-eligible learning-bearing product write uses the existing
write-operation receipt
for request idempotency and a ledger source-uniqueness constraint for internal
idempotency. Business mutation and ledger facts share one SQLite transaction.
Evidence readiness alone never changes serving; an authority-adjudication row
is the actual task-family serving mutation consumed by guide and carries the
validated policy-mutation digest. Candidate/gate versions resolve through an
immutable configuration registry, and each online checkpoint has one
machine-derived, outcome-blind reservation. The confirmatory revision freezes
all three external input/retry/run identities at provisioning, before any
external outcome. Before each formal offline, shadow, or tool call, Runtime
creates the exact matching external reservation. A credential broker
first atomically persists the one-time ticket consumption for the preregistered
runner. Any crash after that commit is non-retryable. For offline evidence it
then, inside broker-only storage, matches the sealed reference/ciphertext and
all 96 ordered canonical members against the reservation; only success permits
the separately signed atomic claim. A mismatch leaves the consumption but no
claim, capability, readable mount, or provider call and appends a signed zero-
effects pre-claim hold that permanently fences claim. Pass, fail, and
inconclusive first results are all archived and ingested. A successful claim
creates one unbound session in a dedicated-identity broker daemon, but exposes
no bearer handle or path. The broker asks a deployment-owned launcher to create
a private socket pair and spawn the exact registered supervisor; signed
launcher and broker receipts bind executable/argv, UID/GID, PID/start/cgroup/
job, claim/session, and channel fingerprints. Runtime appends the sole
supervisor binding under a fixed-domain operation ID before any provider or
holdout-mount access. No UID-only first-attach API exists. The supervisor keeps
the broker descriptor and creates only pathless, per-process child relay pairs
with per-message credential checks; same-UID siblings, unapproved descendants,
forwarded FDs, ptrace, and `/proc` FD duplication are denied. Hard/bind/finalize
deadlines, heartbeats, maximum calls, and short single-call broker capabilities
are frozen. Before a clean supervisor exit,
broker quiesce rejects new calls, reconciles every in-flight call, seals the
signed public attempt chain and runner-output manifest, revokes provider/mount
access, and signs the clean quiesce receipt. Offline gate work then has no provider
authority. Finalize signs and appends the sole Runtime termination; exit before
quiesce, expiry/revoke, unresolved calls, or finalization timeout instead spools
an abnormal hold termination for idempotent recovery. One typed terminal-fact
drain handles pre-claim holds and claimed session terminations, exactly replays
receipt-derived actors/fixed-domain operation IDs, and self-sufficiently
exports the sanitized public reservation-to-terminal authority chain even when
a client crashed before writing its output. Result ingest requires
the daemon health, quiesce, runner-output/call-chain and
`passed|failed|inconclusive` terminal bindings to match the bundle exactly. It
atomically appends both the evidence row and a protected operation receipt,
then emits a canonical receipt. A separate committed `external-ingestion`
bundle projects those receipts, evidence rows, current series heads, required-
series status, and terminal coverage: every result branch must be present
exactly once, while hold and truly unstarted branches must be absent. Thus a
deployment-owned Runtime authority attestor—not the acceptance/eval identity—
reads the launcher-bound live DB descriptor, runs full integrity verification,
and signs the database-lineage identity, authority head, projection, coverage,
binary/policy/key identities, and schema/verifier versions. Fresh-shell CI
verifies that signature and rejects unsigned/self-signed projections. A
terminal run archive therefore cannot be mistaken for proof that Runtime
accepted it. A
consumed reservation has exactly one terminal coverage branch: result, claimed
termination hold, or pre-claim hold. Hold branches cannot be ingested and force
release `hold`. Pre-stop zero-active/all-acked/exported status comes before
terminal bundle construction; coverage-final references committed bundle
digests and comes before broker stop. Coverage-final/stop live only in the outer
lifecycle root, preventing a hash cycle. A reserved-but-unconsumed sibling is
not terminal; broker recovery must consume its original ticket and append a
zero-effects `operator_abort` pre-claim hold, while a never-reserved series may
remain unstarted. A non-pass or result-missing reservation burns that implementation attempt, and
an exposed offline holdout can never be reused or partially repackaged.
Explicit authority requires a
signed approval bound to the exact evidence and one globally unique
tenant/key/nonce claim shared by gate and close authority; self-reported actor text is not
authorization. A boundary safety stop
is written atomically with the triggering feedback, carries its own
deterministic internal authority-operation receipt in addition to the route/job
receipt, and is read fail-closed by
the next guide. Safety quarantine folds across every experiment revision and
ID/version alias of the same candidate implementation contract. Promotion replays the approved reserved statistical
look inside the authority transaction, rejects an older basis as soon as a
higher look is reserved, then applies current post-cutoff safety,
integrity, policy-config, and required-series-head vetoes instead of trusting
stale readiness or silently taking another statistical look.

Release evidence is rooted in one committed, top-level tagged acceptance index.
The normal `checkpoint_series` mode binds the verified harness, registered
prospective calibration, three passing external result chains, their committed
Runtime `external-ingestion` authority bundle, broker lifecycle root, sealed
cumulative host runs, and final report. Each checkpoint entry is
either `evaluated` with its cumulative host index plus
integrity/reservation/online/evaluation bindings, or `integrity_stop` with its
cumulative host index plus integrity/terminal-integrity/safety-authority
bindings and no reservation, online bundle, or evaluation. A checkpoint-1/2
ordinary `hold` is not a terminal acceptance root. An
`external_prerequisite_hold` mode covers any failed/inconclusive external result
or either hold branch. It binds required-series status, every consumed
reservation's exact result/claimed-hold/pre-claim-hold branch, the broker
lifecycle root, and the external-ingestion bundle proving every result branch
was ingested and no hold branch was; it forbids pilot/active/checkpoint/
evaluation fields and can
only report `hold`. Final CI verifies both tagged unions, terminality, and every reference from a fresh shell, fully
recomputes the tracked calibration scenario/shards/raw counts against the
registered policy, and requires a clean tree.

A signed `learning_experiment_close_v1` authority may stop an attempt without
inventing an evidence verdict. It atomically inserts an append-only closure and
operation receipt, seals eligible evidence at the current event head, and
releases the exact full namespace lease set. Terminal signed
promotion/demotion/retirement performs the same complete release in its
authority transaction. Arbitrary or partial release has no valid authority ref.

## Consequences

### Positive

- Guide, feedback, measurement, and adjudication become replayably connected.
- First-use harm can no longer be mixed into prior-aware exploitation maturity.
- Active/control evidence has stable assignment and explicit statistical units.
- Missing feedback, unused exposure, legacy rows, and incomplete projections
  cannot manufacture a promotion pass.
- Under the reviewed collector/credential trust boundary, fixture pilots and
  unverified receipts cannot be mislabeled as genuine online host evidence.
- Existing artifacts and product routes remain in place; no event platform or
  new v1 route is required.
- Strong negative feedback and boundary violations can atomically trigger
  future inspect/control behavior.
- Task-family authority becomes evidence-driven instead of inferred from a
  workflow signature and two observations.

### Negative

- Schema v3 is not readable by the current v2 binary, requiring a compatibility
  release before active rollout.
- Tool feedback needs a non-trivial prepare/persist/finalize refactor.
- Guide/feedback/measure clients need operation IDs for promotion-eligible
  evidence.
- Append-only facts increase SQLite volume and verification work.
- Confirmatory rollout requires enough genuinely disjoint live memory
  namespaces; task variants cannot be relabeled to meet the cluster threshold.
- Online namespace clusters isolate learned prior state, but incomplete host
  outcome observability and calendar/provider drift mean online evidence still
  cannot replace the separately registered finite-holdout regression.
- Formal external failures cannot be hidden or rerun for the same implementation;
  immutable model snapshots, sealed fresh holdouts, and one-time broker claims
  add deployment and evidence-operations cost.

### Neutral

- Existing global or fixed-active modes remain supported but are labeled
  non-randomized and excluded from formal promotion evidence.
- Legacy guide receipts may be backfilled for audit but remain unclassified and
  promotion-ineligible.
- Task-family gate thresholds are versioned evidence-policy configuration, not
  permanent Core constants.

## Alternatives Considered

### Extend `ProductGuideExposureLedger`

Rejected as the primary design. It would make one guide JSON responsible for
future feedback, measurement, experiment, and adjudication state. Multiple
feedback events and corrections would require mutation or another side table,
and request idempotency would remain unsolved.

### Use memory commits as the episode ledger

Rejected. Commits are authoritative for memory mutation, but guide exposure
receipts, measurements, and aggregate experiment decisions are not all memory
commits. Commit diffs also omit important feedback attribution fields today.
Overloading them would weaken rather than clarify authority boundaries.

### Store one generic JSON event table only

Rejected. Per-memory learning track and direct-use denominators are first-class
query dimensions. Hiding them in JSON would make integrity constraints,
efficient gate queries, and per-item source validation fragile.

### Add an external event system

Rejected. The current focused Runtime is single-process and local SQLite. A
broker would add failure modes, deployment cost, and distributed consistency
without solving a demonstrated scale problem.

### Maintain arm-isolated copies of all memory prior state

Deferred. Copying the same live namespace into parallel arm-specific memory
truths would add substantial serving and reconciliation complexity. V1 instead
randomizes already-disjoint canonical store namespaces, enforces full-set
leases and interference audits, uses paired frozen rerun for the controlled
comparison on its exact finite holdout, and uses online clusters for
finite-population actual-use safety. Neither is generalized as a
superpopulation causal estimate. The decision can be revisited if
within-namespace online comparison becomes a proven
requirement.

## References

- `docs/architecture/AIONIS_LEARNING_EPISODE_LEDGER_DESIGN.md`
- `src/product/guide-service.ts`
- `src/product/lifecycle-service.ts`
- `src/product/tool-feedback-service.ts`
- `src/product/measure-service.ts`
- `src/store/lite-runtime-schema.ts`
- `src/store/lite-skill-candidate-review-store.ts`
- `src/memory/promotion-evidence-ledger.ts`
- `src/memory/admission-real-agent-rerun.ts`

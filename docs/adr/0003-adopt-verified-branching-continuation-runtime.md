# ADR-0003: Adopt a Verified Branching Continuation Runtime

## Status

Accepted on 2026-07-21; implementation and release evidence remain in progress.
The canonical data model and implementation contract are defined in
`docs/architecture/AIONIS_CONTINUATION_RUNTIME_V1.md`.

This is a clean-break architecture decision. Aionis has no production users,
so the implementation will not retain legacy HTTP, SDK, database, or output
contract compatibility merely to preserve the current v0.3.x shape.

This decision keeps an append-only learning episode ledger in the Runtime
SQLite database. Fixed pair counts, namespace counts, wave schedules, and
deployment-authority protocols are not Runtime-core requirements. Those
concerns live behind generic signed evidence-policy and experiment-assignment
ports.

## Context

Aionis already contains the important mechanisms of an execution-memory
Runtime:

- versioned memory commits with an authoritative scope head;
- execution contracts with targets, next actions, acceptance checks, success
  invariants, environment assumptions, and provenance;
- memory admission surfaces for direct use, inspection, blocking, and
  rehydration;
- an append-only episode chain connecting guide exposure, host use, feedback,
  and product effect measurement;
- controlled lifecycle mutation, forgetting, and rehydration;
- operator projections that reconstruct the context an Agent received.

These mechanisms are not yet one coherent product primitive. The same decision
is represented repeatedly across memory contracts, execution contracts, guide
packets, Agent contexts, command posture, route contracts, decision traces,
use receipts, and operator projections. The final prompt budget is enforced by
truncating rendered text rather than selecting the smallest set of evidence
that covers current execution obligations. The Flight Recorder reconstructs
caller-supplied artifacts rather than reading a durable influence chain.
Learning gates bind a single fixed research protocol directly into the daemon.

The clean 2026-07-21 baseline contains 339 source modules and 171,284 source
lines. The `runtime-entry.ts` transitive closure contains 285 modules and
140,330 lines, with 21 registered routes and 177 environment fields. These
numbers record the pre-cutover problem size; they are not the active V1
complexity budget.

Adding another output schema or another scorer would make this worse. The
Runtime needs one canonical continuation decision, one durable influence
ledger, and one reversible authority model.

## Requirements

### Functional

1. Compile prior execution history into the smallest verified state sufficient
   for the next action, not a top-k memory list and not a truncated prompt.
2. Require every memory that may directly influence an action to declare its
   intended influence, task/scope binding, current-world preconditions,
   evidence, verifier obligations, expiry or refresh policy, and safe fallback.
3. Keep candidate learning isolated from authoritative serving until real host
   outcomes support promotion.
4. Attribute exposure, actual use, verified outcome, and later authority
   changes to exact capsule and branch revisions.
5. Merge, reject, quarantine, expire, and rehydrate learned state reversibly.
6. Reconstruct an exact decision by `decision_id` or `run_id` without asking
   a caller to resubmit the original artifacts.
7. Explain the counterfactual decision difference produced by excluding a
   capsule or selecting another branch.

### Non-functional

- SQLite remains the sole local authority database. ANN remains candidate-only.
- The Runtime remains a local modular monolith; no service mesh, cloud control
  plane, or event platform is introduced.
- Core serving is deterministic and makes no mandatory LLM call. An LLM may
  propose semantic candidates, never grant authority.
- The Runtime does not execute arbitrary host probes. It verifies bounded,
  typed host observations through a port and binds them by digest.
- Direct use fails closed when task binding, preconditions, evidence, or
  current-world observations are missing, stale, contradictory, or invalid.
- All authority-changing writes are atomic with their operation receipt and
  append-only evidence event.
- Selection is bounded and must not perform all-pairs comparison over the
  memory population.
- Prompt payloads, secrets, raw embeddings, and raw probe output are excluded
  from audit receipts. Receipts contain bounded projections and digests.
- The HTTP daemon and workers have disjoint strict configuration allowlists.
  The daemon never parses provider or queue controls; workers never parse
  caller credentials or HTTP controls; only the embedding worker may retain an
  embedding-provider key.
- Every implementation batch must preserve the exact route, environment,
  schema, and capability boundaries, introduce no runtime import cycle or full
  type-dependency strongly connected component, and keep every production
  source file at or below 1,200 lines.
- The earlier 40-module and 20,000-line cutover numbers were planning estimates.
  They are explicitly superseded and were not achieved. Physical capability
  splits can increase module count while reducing coupling, closure lines, and
  maximum file size, so source-file counts are authenticated observations, not
  pass/fail thresholds. Nonproduction, test, gate, tool, and resource line
  counts are observations as well. The daemon, worker, provisioning, SDK,
  production-union, and total-V1 source-line ceilings are the hard downward
  ratchets; moving code between entry closures cannot evade the gate.

## Decision

Aionis becomes a **Verified Branching Continuation Runtime**.

Its canonical product primitive is one `ContinuationContractV1`. Its learning
primitive is a decision branch over immutable capsule revisions. Its evidence
primitive is a per-capsule `EffectCertificateV1` rooted in the episode ledger.

The product promise is:

> Aionis compiles the smallest verified execution state an Agent needs for its
> next action, records exactly how that state influenced the action, and changes
> future authority only when real outcomes justify it.

### 1. One canonical continuation contract

`ContinuationContractV1` replaces the overlapping execution contract, memory
contract, guide packet, Agent context, command-posture contract, and route
contract as independent sources of truth.

The canonical contract contains:

- identity: tenant, scope, task binding, contract revision, input digest, and
  contract digest;
- authority: one exact historical-memory continuity head plus the
  authoritative or cohort-selected learning branch and its base revision;
- execution obligations: active goal, next action boundary, required state,
  must-hold constraints, prohibited directions, and verifier obligations;
- selected capsules: bounded execution-state units with their exact influence
  surface, authority, precondition evaluation, evidence refs, conflicts,
  freshness, and rehydration pointer;
- selection certificate: covered obligations, unresolved obligations,
  excluded capsules with stable reason codes, selection cost, algorithm
  version, and canonical digest;
- safe fallback: inspect, rehydrate, block, or report unresolved state.

The Agent prompt, SDK response, audit record, and operator view are projections
of this contract. They are never parallel authority schemas.

### 2. Execution capsules

An execution capsule is a versioned, immutable projection of memory that is
eligible to participate in a continuation decision. A capsule is not a second
copy of the raw memory payload.

Each capsule declares:

- capsule and source-memory revision identity;
- kind: current state, verified fact, procedure, constraint, counter-evidence,
  or rehydration pointer;
- intended influence: use, inspect, block, or rehydrate;
- task, workflow, actor, and scope applicability;
- typed preconditions and their required freshness;
- obligations it claims to cover;
- evidence and verifier refs;
- conflict and supersession refs;
- source-memory lifecycle authority ref and expiry/refresh policy;
- a bounded content projection whose UTF-8 render cost is measured by the
  versioned Runtime renderer rather than trusted from capsule input.

Capsule content is immutable. A capsule does not introduce another mutable
`capsule_status`: learning authority exists only in an authority-branch
manifest, verified continuity exists only under an exact memory head,
lifecycle exists only in the existing forgetting/lifecycle authority, and the
served surface exists only in a particular continuation contract. Capsule
construction may use semantic candidate producers. Admission and selection use
deterministic Runtime logic.

### 3. Typed current-world verification

Free-form prose is not sufficient to authorize direct use. Preconditions are
typed predicates over bounded host observations, initially covering:

- artifact existence and content digest;
- repository or workspace revision;
- command/verifier result identity;
- service endpoint health attestation;
- dependency or environment capability;
- host assertion signed or digested by an admitted observer.

Each evaluation is `satisfied`, `unsatisfied`, or `unknown`. Only satisfied
required preconditions may support direct use. Unknown becomes inspect or
rehydrate. Unsatisfied becomes block, quarantine, or expiry according to the
capsule lifecycle policy. The Runtime validates observation shape, freshness,
observer authority, task binding, and digest; it does not run the probe itself.

### 4. Constraint-aware minimum-state compiler

The compiler operates before rendering:

1. normalize current task and execution obligations;
2. reject capsules outside scope, lifecycle, task, or hard safety boundaries;
3. verify required current-world preconditions;
4. include mandatory prohibitions and verifier obligations;
5. select positive capsules by deterministic bounded coverage benefit, effect
   authority, conflict risk, freshness, and render cost;
6. verify complete coverage and produce unresolved obligations;
7. choose a safe fallback when complete executable coverage is unavailable;
8. hash the canonical contract and only then render the Agent projection.

The initial implementation may use a deterministic greedy weighted set-cover
algorithm. The algorithm and tie-breaking are versioned, byte-order stable, and
replayable. Character truncation is not an admissible correctness mechanism.

### 5. Authority branches are decision overlays

An authority branch does **not** fork the entire memory graph or create a
second database truth. Memory commits keep one linear authoritative scope head.
Branches contain only governed learning (`procedure` and `counter_evidence`).
Verified continuity (`current_state`, `verified_fact`, and `constraint`) never
becomes a branch member.

`authority_branch` is deliberately distinct from an execution path. The old
execution-tree passed/failed branches become `current_state` and
`counter_evidence` capsules. They do not have merge authority. Only an
authority branch represents a candidate change to future admission or serving.

A branch is an immutable manifest over learning capsule revisions, admission
decisions, and a compiler/evidence-policy digest. Authoritative learning
genesis is empty. A continuity observation advances memory only; a learning
observation creates an isolated candidate draft based on the current learning
head:

- the authoritative branch defines currently servable authority;
- a candidate branch is derived from one authoritative base revision;
- shadow evaluation compiles both learning branches with the same exact task,
  snapshot, memory head, and verified-continuity overlay;
- controlled serving may serve a candidate only under a signed experiment
  cohort and a Runtime-derived HMAC assignment receipt;
- merge atomically advances the authoritative branch pointer after an admitted
  effect certificate;
- reject, quarantine, expire, and rollback preserve the branch and evidence but
  remove its serving authority.

The authority-branch state machine is:

```text
draft -> shadow -> eligible -> active_candidate -> merged
   |        |          |             |
   +------> rejected <-+-------------+
   +------> quarantined <-------------+
   +------> expired
```

There is exactly one authoritative branch revision for an authority subject.
Promotion uses compare-and-swap against its base revision. A stale candidate
cannot merge.

Every authoritative revision after genesis has exactly one cause: an admitted
effect certificate, a forward revert, or a signed policy rotation. Rotation is
policy-only: it advances the exact same branch by one revision, changes at
least one compiler/evidence-policy artifact or payload digest, and preserves
the exact semantic capsule-binding set. Merge and revert cannot smuggle a
policy change. Candidate branches cannot rotate policy and remain pinned to
their authoritative base policy; candidates made stale by rotation are rebuilt.
SQLite enforces the structural, validity-window, binding-set, receipt-last, and
CAS invariants. The authority store verifies signature/trust, canonical payload,
and exact declared old/new policy refs on insertion and read, failing closed
when any proof is absent or inconsistent.

### 6. One influence evidence chain

The episode ledger remains the evidence spine and records four distinct facts:

1. `exposure`: the exact contract and capsule surfaces shown to the Agent;
2. `use`: host-verified evidence of which exposed capsules influenced action;
3. `outcome`: verifier-bound action result;
4. `effect`: branch and per-capsule marginal-effect claims admitted by an
   evidence authority.

An Agent-facing exposure receipt is not named a use receipt. A use receipt
requires host evidence and records `used`, `not_used`, or `unknown` for each
capsule. `not_used` is positive evidence, while `unknown` is an explicit
indeterminate result and cannot be treated as non-use. An effect certificate is
neither of those; it binds one signed cohort, control/candidate learning
revisions, every assigned exposure, outcome missingness, harm claims,
uncertainty bounds, policy digest, and authority decision.

No missing host receipt means no inferred use. No ambiguous attribution means
positive credit. No aggregate product score grants per-capsule authority.

### 7. Generic evidence policy, not a fixed experiment in core

The Runtime consumes signed, immutable evidence-policy and experiment-cohort
artifacts through generic ports:

- deterministic HMAC assignment and receipt verification;
- evidence-window closure;
- effect-certificate verification;
- authority-decision verification.

Each cohort commits to one protected, random 32-byte seed. Assignment and
exposure are atomic for both arms, ordinary authoritative traffic is excluded
from intent-to-treat evidence, and the terminal effect certificate reveals
only that cohort's seed for external replay. Assignment closes at
`window_closed_at`; outcomes must be observed by `outcome_deadline` and
ingested by the settlement cutoff. One effect job is created with cohort
installation and becomes available only at that cutoff.

Pair counts, namespace counts, activation waves, holdout sizes, statistical
tests, and external execution protocols belong to the authority package or
evaluation laboratory. Runtime SQL and core TypeScript contain only generic
bounds, identity, integrity, atomicity, and state-machine invariants.

### 8. Durable counterfactual Flight Recorder

The Flight Recorder reads the Runtime database by `decision_id` or `run_id`
and reconstructs:

- task and world-snapshot identity;
- authoritative and candidate branch revisions;
- admitted and excluded capsule decisions;
- the exact Agent projection;
- host use and outcome receipts;
- resulting effect certificates and lifecycle mutations.

Counterfactual replay first means deterministic recompilation with a capsule or
branch excluded. Optional real-Agent reruns remain external evaluation and are
never required on the production serving path.

## Authority and transaction invariants

1. A contract digest binds its task, world snapshot, branch revision, selected
   capsules, exclusions, coverage, and compiler version.
2. A host use receipt must reference one exposed capsule revision from the
   exact contract digest.
3. An outcome receipt must bind the host use receipt, task/run, verifier, and
   observation time.
4. An effect certificate must bind immutable branch revisions and an exact
   closed evidence window.
5. A merge must validate certificate authority and compare-and-swap the current
   authoritative branch revision in the same SQLite transaction as its ledger
   event and operation receipt.
6. Replaying the same operation is exact; changing any bound input conflicts.
7. A capsule with unknown or failed required preconditions cannot appear on a
   direct-use surface.
8. A blocked, quarantined, expired, or rehydrate-required capsule cannot become
   direct-use through ranking, token pressure, or branch selection.

## Failure modes

| Failure | Required behavior |
|---|---|
| Host observation absent, stale, or malformed | Direct use fails closed; inspect or rehydrate. |
| Task or world snapshot differs during use | Reject the receipt and require a new contract. |
| Candidate base revision is stale | Reject merge; rebuild candidate from current authority. |
| Outcome cannot be attributed | Record neutral/unknown; grant no positive credit. |
| Candidate shows verified harm | Quarantine immediately and preserve counter-evidence. |
| Evidence-policy authority is unavailable | Continue authoritative branch; hold promotion. |
| Token budget cannot cover hard obligations | Emit unresolved contract; never truncate away safety state. |
| Conflicting authoritative capsules | Surface conflict and inspect; do not pick by similarity alone. |
| Crash during authority mutation | Atomic rollback or exact operation replay. |
| Branch population grows without evidence | Expire or archive bounded candidates; never scan all history. |

## Security boundary

- Host observations are untrusted input until schema, freshness, task binding,
  observer authority, and digest verification pass.
- Tenant, scope, and authority subject are authenticated host bindings, not
  request-body fields. They are part of the task-envelope digest covered by
  external observation signatures, so cross-domain replay fails closed.
- The Runtime never accepts client-declared `authoritative`, `verified`,
  `effect_supported`, or `merged` status without the required authority chain.
- Probe payloads are allowlisted projections. Secret values and raw command
  output do not enter contracts or ledgers.
- Candidate content is treated as potentially adversarial memory. It cannot
  modify compiler rules, evidence policy, or verifier configuration.
- Signed policy and effect artifacts are verified against configured trust
  roots; signatures do not replace semantic and state-machine checks.

## Clean-break implementation sequence

1. Freeze this ADR and the canonical data model.
2. Introduce one internal continuation domain model and move current builders
   behind it.
3. Replace the current prompt-first pipeline with admission, precondition
   verification, coverage selection, contract hashing, then rendering.
4. Delete the legacy contract schemas and projections rather than maintaining
   adapters.
5. Replace the v0.3.x database schema with the clean continuation/branch/ledger
   schema. No legacy migration runs on the new binary.
6. Move fixed experiment protocol and statistical authority out of Runtime
   core, then delete its Runtime SQL constraints and environment surface.
7. Add per-capsule use, outcome, and effect facts to the episode ledger.
8. Add atomic branch promotion, rejection, quarantine, expiry, and rollback.
9. Rebuild the Flight Recorder from durable authority rows.
10. Ratchet complexity budgets downward and run real Runtime, recovery,
    external Agent, pilot, and soak validation.

Each step must leave one runnable vertical slice. No step may add a temporary
compatibility contract that survives the step.

## Alternatives considered

### Improve retrieval and ranking only

Rejected. Better embeddings, temporal graphs, and reranking improve recall but
do not prove that retrieved memory is currently applicable or beneficial to an
action.

### Add causal scoring to the current admission policy

Rejected as the primary architecture. A score without task/world preconditions,
branch isolation, exact host use, and reversible authority can still promote a
stale or misattributed memory.

### Fork the complete memory database per candidate

Rejected. Physical graph branches duplicate state, complicate commit authority,
and create merge semantics unrelated to the product need. Decision manifests
over immutable capsules provide isolation without another truth.

### Keep current contracts and add a continuation facade

Rejected. A facade would preserve the duplication and make another schema the
largest file. With no production users, compatibility has no value that
justifies permanent architecture debt.

### Move learning entirely outside the Runtime

Rejected. External evaluation may calculate evidence, but the Runtime must own
serving authority, atomic receipts, lifecycle state, and fail-closed admission.

## Consequences

### Positive

- Aionis has a differentiated product primitive rather than a larger memory
  database.
- Learning can be aggressive in candidate branches without contaminating
  authoritative execution state.
- Context size becomes the result of a replayable coverage decision.
- Every action-shaping memory has current-world applicability and outcome
  provenance.
- Contract consolidation and protocol extraction reduce daemon complexity.
- Cross-Agent and cross-model continuation uses a model-neutral contract.

### Negative

- v0.3.x clients and databases will not open under the clean-break binary.
- Existing tests tied to old output shapes must be deleted or rewritten.
- Host integrations must produce typed observations and genuine use/outcome
  receipts for direct-use learning.
- Counterfactual effect remains expensive and will primarily run in shadow or
  external evaluation, not on every request.

### Neutral

- SQLite, local-first operation, one Runtime process, and ANN candidate-only
  retrieval remain unchanged.
- The four product capabilities remain continuity, learning, forgetting, and
  learning control. The continuation contract and episode ledger are their
  shared execution and evidence substrate.

## Acceptance criteria

The architecture is implemented only when all of the following are true:

1. One canonical continuation contract drives Agent rendering, receipts,
   operator inspection, and feedback identity.
2. No legacy guide/Agent/route/execution contract remains an independent
   authority schema.
3. Prompt budgeting selects before rendering and never removes a hard
   obligation through truncation.
4. Required current-world preconditions gate every direct-use capsule.
5. Candidate decisions are isolated by branch revision and can merge only from
   an admitted effect certificate.
6. Flight Recorder reconstructs durable exposure-to-authority history from an
   ID alone and can emit a deterministic counterfactual diff.
7. Fixed experiment counts and wave schedules are absent from Runtime core and
   Runtime SQL.
8. The product surface is exactly five `/v1` routes and the new authority
   database has exactly the 17 tables defined by the implementation contract.
9. The authenticated complexity budget records file counts as observations and
   hard-gates the daemon, worker, provisioning, SDK, production-union, and total
   V1 source-line ceilings downward. No production or V1 source file exceeds
   1,200 lines; production and total runtime import cycles are zero; full
   type-dependency strongly connected components are zero. This criterion does
   not claim that the superseded 40-module or 20,000-line estimates were met.
10. The daemon accepts exactly its 13-field environment allowlist; workers
   accept exactly their 16-field allowlist. Provider fields are mandatory only
   for `embedding`; retention cleanup is a separate non-authority role; the
   independently pinned Ed25519 verifier-key fields are
   mandatory only for `effect`; every role rejects the other role's secrets.
   The provisioner accepts exactly its four-field allowlist, the AST-derived
   union and inventory source paths are exact, and the daemon closure contains
   no artifact provisioner, effect writer or signer, worker, or provisioning
   capability.
11. Real SQLite crash/reopen tests, real Runtime smoke, real host-receipt tests,
   a real external-Agent comparison, the protected pilot, and the 24-36 hour
   soak all pass on the same exact commit.

## References

- `docs/FOCUS.md`
- `docs/architecture/AIONIS_CONTINUATION_RUNTIME_V1.md`
- `src/continuation/contract.ts`
- `src/continuation/compiler.ts`
- `src/continuation/effect-certificate.ts`
- `src/runtime-v1/application-service.ts`
- `src/runtime-v1/http-surface.ts`
- `src/runtime-v1/worker-composition.ts`
- `src/store/continuation-runtime-v1-episode-store.ts`

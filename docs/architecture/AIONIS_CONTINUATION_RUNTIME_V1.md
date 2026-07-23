# Aionis Continuation Runtime V1

## Purpose

This document is the implementation contract for ADR-0003. It defines the
clean-break Runtime that replaces the v0.3.x collection of execution contracts,
memory contracts, guide packets, Agent contexts, route contracts, execution
trees, and handoff slots.

There is no compatibility objective. The new binary rejects v0.3.x databases,
the new SDK exposes only the new contract, and old response shapes are deleted
instead of adapted.

The product invariant is:

> One immutable continuation contract decides what prior state may influence
> the next action; one append-only evidence chain records what actually
> influenced the action and its outcome; only verified evidence may change
> future authority.

## Boundary

Runtime V1 remains a local modular monolith with SQLite as the authority store.
It owns:

- immutable execution capsules derived from admitted memory;
- typed current-world observation verification;
- deterministic minimum-state compilation;
- authoritative and candidate decision branches;
- exposure, use, outcome, and effect evidence;
- forgetting, quarantine, expiry, and rehydration enforcement;
- durable decision reconstruction and counterfactual compilation.

It does not own:

- an experiment laboratory or a fixed sample/wave protocol;
- a cloud control plane;
- arbitrary command execution or network probing;
- an LLM-based authority decision;
- host-Agent orchestration;
- compatibility with v0.3.x HTTP, SDK, or database shapes.

## One authority per concern

The model has four orthogonal authorities. None may be copied into a mutable
cache that can later be treated as an input authority.

| Concern | Sole authority |
|---|---|
| Memory content and history | memory commit and authoritative scope head |
| Memory availability | forgetting/lifecycle authority |
| Candidate versus authoritative serving | authority branch manifest and CAS head |
| One Agent decision | immutable `ContinuationContractV1` |

An execution capsule is immutable content, not an authority row. A rendered
prompt is a projection, not a contract. A similarity score is a candidate
signal, not admission. An exposure is not proof of use. A reported outcome is
not an effect certificate.

## Canonical serialization

All authority-bearing digests use the same canonical encoding:

1. UTF-8 JSON;
2. object keys sorted by UTF-8 byte order;
3. arrays sorted only where the schema explicitly declares set semantics;
4. duplicate set members rejected before hashing;
5. integers only for bounded numeric protocol fields;
6. timestamps normalized to UTC RFC 3339 with millisecond precision;
7. digest fields omitted from the value used to calculate their own digest;
8. SHA-256 encoded as 64 lowercase hexadecimal characters.

Floating-point ranking values never enter an authority digest. The compiler
uses bounded integer weights and costs.

## Canonical continuation contract

```ts
type Sha256 = string;

type ContinuationContractV1 = {
  schema_version: "continuation_contract_v1";

  identity: {
    decision_id: string;
    tenant_id: string;
    scope: string;
    episode_id: string;
    run_id: string;
    host_task_id: string;
    host_task_envelope_sha256: Sha256;
    collection_principal_sha256: Sha256;
    consumer_agent_id: string | null;
    consumer_team_id: string | null;
    task_family: string;
    task_signature: string;
    workflow_signature: string | null;
    workspace_signature: string;
    source_task_sha256: Sha256;
    source_event_sha256: Sha256;
    world_snapshot_id: string;
    world_snapshot_sha256: Sha256;
  };

  authority: {
    authority_subject_sha256: Sha256;
    authoritative_head: AuthorityBranchRefV1;
    served_branch: AuthorityBranchRefV1;
    serving_mode: "authoritative" | "assigned_candidate";
    assignment_receipt_sha256: Sha256 | null;
    compiler_policy_sha256: Sha256;
    evidence_policy_sha256: Sha256;
    memory_scope_head_revision: number;
    memory_scope_head_sha256: Sha256;
  };

  obligations: ContinuationObligationV1[];
  selected_capsules: SelectedCapsuleV1[];
  excluded_capsules: ExcludedCapsuleV1[];
  coverage_certificate: ContinuationCoverageCertificateV1;

  safe_fallback: {
    mode: "execute" | "inspect" | "rehydrate" | "block" | "report_unresolved";
    reason_codes: string[];
    unresolved_obligation_ids: string[];
  };

  compiler: {
    algorithm: "bounded_greedy_coverage_v1";
    algorithm_contract_sha256: Sha256;
    candidate_limit: number;
    obligation_limit: number;
    render_budget: number;
  };

  contract_sha256: Sha256;
};
```

Contracts are immutable and therefore have no revision field. A changed task,
world snapshot, policy, branch, candidate universe, or observation set produces
a new contract ID and digest.

### Obligations

```ts
type ContinuationObligationV1 = {
  obligation_id: string;
  kind:
    | "active_goal"
    | "required_state"
    | "next_action"
    | "must_hold"
    | "prohibition"
    | "verification";
  requirement: "hard" | "advisory";
  statement: string;
  target_refs: TargetRefV1[];
  required_probe_ids: string[];
  evidence_requirement:
    | "runtime_state"
    | "trusted_host"
    | "external_verifier";
  source_refs: string[];
};

type TargetRefV1 = {
  kind:
    | "artifact"
    | "service"
    | "capability"
    | "memory"
    | "workflow"
    | "external_resource";
  ref: string;
};
```

The contract does not store five parallel forms of targets, summaries, command
posture, and route policy. A renderer may group these clauses for an Agent, but
the grouped text has no independent authority.

## Execution capsules

```ts
type CapsuleRefV1 = {
  capsule_id: string;
  capsule_revision: number;
  capsule_sha256: Sha256;
};

type ExecutionCapsuleV1 = CapsuleRefV1 & {
  schema_version: "execution_capsule_v1";
  created_at: string;
  parent_capsule_sha256: Sha256 | null;

  source: {
    memory_id: string;
    source_commit_id: string;
    source_projection_sha256: Sha256;
  };

  kind:
    | "current_state"
    | "verified_fact"
    | "procedure"
    | "constraint"
    | "counter_evidence"
    | "rehydration_pointer";

  proposed_influence: "use" | "inspect" | "block" | "rehydrate";

  applicability: {
    tenant_id: string;
    scope: string;
    task_family: string;
    task_signature: string | null;
    workflow_signature: string | null;
    workspace_signature: string | null;
    producer_agent_id: string | null;
    owner_agent_id: string | null;
    owner_team_id: string | null;
  };

  projection: {
    summary: string;
    next_action: string | null;
    target_refs: TargetRefV1[];
    workflow_steps: string[];
    acceptance_statements: string[];
    projection_sha256: Sha256;
  };

  coverage_claims: Array<{
    obligation_kind: ContinuationObligationV1["kind"];
    target_refs: TargetRefV1[];
    evidence_requirement: ContinuationObligationV1["evidence_requirement"];
    required_probe_ids: string[];
    coverage_claim_sha256: Sha256;
  }>;
  precondition_specs: TypedPreconditionSpecV1[];
  evidence_refs: string[];
  verifier_refs: string[];
  conflicts_with: CapsuleRefV1[];
  supersedes: CapsuleRefV1[];
  expires_at: string | null;
};
```

Capsule invariants:

- content is immutable; any change creates the next positive revision;
- rehydration that changes the projection creates a new revision;
- `counter_evidence` cannot become positive direct-use state;
- no capsule contains mutable authority or lifecycle status;
- source memory identity and commit are mandatory;
- raw memory payload, secrets, embeddings, and raw verifier output are absent;
- lifecycle is rechecked when compiling and immediately before branch merge;
- `current_state`, `verified_fact`, `constraint`, and `counter_evidence` must
  have an explicit expiry no later than both the task envelope and the earliest
  observation they cite; an expired observation can never seed unbounded
  continuity authority;
- reusable capsules never persist decision-local obligation IDs; a claim
  matches a future obligation only when obligation kind, stable canonical
  target set, evidence class, and required probe set are byte-exact;
- every obligation and coverage claim has at least one stable typed target, so
  prose similarity cannot silently grant execution influence.

`SelectedCapsuleV1` binds a capsule ref to exactly one final surface:

```ts
type SelectedCapsuleV1 = {
  capsule: CapsuleRefV1;
  surface: "use_now" | "inspect_before_use" | "do_not_use" | "rehydrate";
  coverage_bindings: Array<{
    obligation_id: string;
    coverage_claim_sha256: Sha256;
  }>;
  satisfied_probe_ids: string[];
  selection_reason_codes: string[];
};

type ExcludedCapsuleV1 = {
  capsule: CapsuleRefV1;
  reason_codes: string[];
};
```

## Typed current-world observations

Capsules declare typed probe specifications. An authenticated host submits only
collector observation bodies; the Runtime derives their observer role,
principal, task/snapshot binding, attestation marker, and canonical digest from
the active `record_observations` operation. An external verifier may be relayed
by the host only as an Ed25519-signed observation whose SPKI digest is admitted
by the signed compiler policy. Capsule or Agent text can never supply a shell
command or arbitrary URL for the Runtime to execute.

The host-task request body likewise contains task fields only. Tenant and scope
come exclusively from the authenticated operation context, and Runtime derives
the authority-subject digest from that binding plus the validated task family.
All three authenticated-domain fields are embedded in the immutable task
envelope and its digest. Consequently, an external observation signature over
that envelope digest cannot be replayed into another tenant, scope, or authority
subject. Supplying any authenticated-domain field in the request body fails the
exact-shape check rather than overriding the host binding.

All probe specs contain:

```ts
type ProbeCommonV1 = {
  probe_id: string;
  required_for: "admission" | "before_action" | "before_merge" | "before_complete";
  observer: "trusted_host_collector" | "external_verifier";
  max_age_ms: number;
  on_unknown: "inspect" | "rehydrate" | "block";
  on_unsatisfied: "block" | "quarantine" | "expire";
};
```

The initial closed union is:

- `artifact`: repository-relative path, existence, file/directory kind, and an
  optional content digest;
- `workspace`: registered workspace identity, revision/tree digest, and dirty
  state policy;
- `verifier`: registered verifier ID, configuration digest, pass expectation,
  fresh-process requirement, and post-Agent-exit requirement;
- `service`: registered endpoint ID, protocol, health expectation, external
  visibility, and post-Agent-exit requirement;
- `capability`: registered tool/dependency ID, exact expected version, and
  presence.

Memory lifecycle, hydration, source-commit, branch, and operation facts are
read directly from SQLite authority rows. They are not wrapped in a caller-
submitted `runtime` observation and Runtime does not carry an observation-
signing private key.

A `HostObservationV1` binds the probe-spec digest, observer principal, host task,
world-snapshot ID, observation time, expiry time, bounded value, evidence
digest, provenance attestation, and its own canonical observation digest.
External signatures cover every one of those fields and prove possession of
the policy-admitted public key. Collector observations must use the exact
authenticated batch principal. Every observation must begin no earlier than
the task envelope and expire no later than it. The snapshot contains and
revalidates the complete immutable host-task envelope, then hashes tenant,
scope, authenticated collector, creation/window/expiry times, that envelope's
digest, and the ordered observation IDs and digests. An observation never
embeds the snapshot digest that includes itself. A task that needs no current-
world fact may use an empty snapshot instead of inventing a probe; that empty
snapshot expires with its host-task envelope. Runtime evaluation yields only
`satisfied`, `unsatisfied`, or `unknown`.

The verifier rejects absolute or parent-traversing artifact paths, unregistered
service endpoints, arbitrary commands, unbounded output, secrets, client
claims of authority, and observations not bound to the current task envelope.

## Deterministic minimum-state compiler

The compiler input is an immutable task envelope, obligation set, exact memory
head, authoritative learning ref, optional cohort-selected learning ref, world
observation snapshot, bounded candidate universe, compiler policy, evidence
policy digest, and render budget. Serving has two explicit lanes:

- `verified_continuity` is reconstructed from the exact memory head and may
  contain only active, hydrated `current_state`, `verified_fact`, and
  `constraint` capsules. It is never made a member of an authority branch.
- `governed_learning` is resolved from an exact learning-branch binding and may
  contain only `procedure` and `counter_evidence` capsules.

The compiler assembles one shared continuity overlay with exactly one learning
lane. During an experiment both arms use the same observation snapshot, memory
head, continuity set, compiler policy, and evidence policy; only the learning
branch differs. This prevents ordinary state drift from being misattributed to
learning.

The in-process compile boundary is itself a strict, unknown-field-rejecting
contract:

```ts
type CompileContinuationV1Args = {
  schema_version: "continuation_compile_input_v1";
  identity: ContinuationContractV1["identity"];
  authority: ContinuationContractV1["authority"];
  obligations: ContinuationObligationV1[];
  candidates: Array<{
    capsule: ExecutionCapsuleV1;
    provenance:
      | {
          lane: "verified_continuity";
          capsule: CapsuleRefV1;
          memory_item_sha256: Sha256;
          memory_scope_head_revision: number;
          memory_scope_head_sha256: Sha256;
          admission_authority: "verified" | "authoritative";
          provenance_sha256: Sha256;
        }
      | {
          lane: "governed_learning";
          branch_ref: AuthorityBranchRefV1;
          capsule: CapsuleRefV1;
          disposition: "include" | "exclude" | "prohibit";
          admission_authority: "candidate" | "authoritative";
          provenance_sha256: Sha256;
        };
    lifecycle_fact: DigestVerifiedLifecycleFactV1;
  }>;
  observation_snapshot: WorldObservationSnapshotV1;
  compiled_at: string;
  render_budget: number;
  policy: ContinuationCompilerPolicyV1 & {
    trusted_observer_principals: {
      trusted_host_collector: Sha256[];
      external_verifier: Sha256[];
    };
  };
};
```

The HTTP client never supplies this structure. The authority store constructs
it from exact historical-memory, branch-binding, capsule, lifecycle, verified
signed-policy, cohort, and effect-certificate rows. Observer trust is inside that signed
policy payload, not a parallel compile argument. The production command
boundary must accept only a verified-policy capability issued from the pinned-
root artifact store; a self-consistent payload digest or direct call to the pure
compiler is not proof of authority and cannot create a durable exposure.

The pipeline is:

1. Validate identities, bounds, canonical ordering, and policy digests.
2. Resolve the exact learning manifest and exact historical memory projection.
3. Intersect ANN/retrieval candidates with the lane-specific provenance and
   lifecycle authority; ANN never bypasses this intersection.
4. Partition scope, task, lifecycle, expiry, source-revision, and authority
   failures into stable exclusions.
5. Evaluate typed preconditions against the bound world snapshot.
6. Select all applicable hard prohibitions and counter-evidence needed by a
   hard obligation. These cannot be dropped for budget.
7. Apply valid supersession before optimization. In a direct-use conflict,
   higher authority excludes lower authority; equal authority fails closed.
   Counter-evidence and prohibitions are never discarded merely because their
   authority score is lower.
8. Greedily select positive capsules by integer marginal coverage benefit per
   Runtime-measured UTF-8 render cost, adjusted only by immutable admission
   provenance and the deterministic freshness bucket.
9. Break equal scores by `capsule_sha256` UTF-8 byte order.
10. Stop at the candidate, obligation, and render bounds.
11. Prove that selected plus excluded equals the bounded candidate universe and
    issue the coverage certificate.
12. Choose the safe fallback. `execute` is legal only when every hard
    obligation and every direct-use precondition is complete and conflict-free.
13. Hash the contract, persist its exposure atomically, and then render it.

Candidate inputs are exact SQLite facts: either a digest-verified continuity
item under the contract's memory-head fence or a digest-verified learning
branch binding, plus the matching lifecycle row. A client cannot supply
free `authority`, `effect`, `source_is_current`, or `freshness_bucket` scalars.
Freshness is derived from the immutable capsule timestamp and signed compiler
policy. Effect claims authorize merge, rejection, or quarantine; they never
change serving scores after an experiment, so promotion preserves the exact
treatment that produced its evidence.

The policy contains integer weights and hard bounds, not research sample sizes.
The initial algorithm is intentionally simple and replayable. A later optimizer
may replace it only under a new algorithm version and real counterfactual
evidence.

Runtime safety bounds are separate from experiment policy: at most 256
candidates, 64 obligations, 64 selected capsules, 16 preconditions and 32
obligation claims per capsule, 16 conflicts and 16 supersedes refs, 2,048 typed
observations, 4 KiB per observation value, 256 KiB per snapshot, 8 KiB per
capsule projection, and a 1-64 KiB render budget. IDs are bounded to 256 UTF-8
bytes, obligation statements to 1,024 bytes, summaries to 2,048 bytes, and
workflow steps to 512 bytes. Exceeding a bound is an input error; the Runtime
never slices the set silently.

Render cost is recomputed from the versioned Agent projection in UTF-8 bytes;
the capsule does not declare its own cost. The mandatory frame includes task,
authority, obligations, fallback, and fixed-size contract/certificate digests.
If the mandatory frame does not fit, the result is explicitly non-renderable
and cannot authorize execution.

There is no post-selection character or token truncation. The canonical
renderer either emits the entire certified projection or returns
`not_renderable` with exact required and available UTF-8 byte counts. It never
removes a selected capsule, hard obligation, prohibition, verifier, identity,
fallback, or digest. Both the rendered and `not_renderable` result envelopes
carry `render_result_sha256`; only a successfully rendered envelope carries a
non-null `projection_sha256`. The episode ledger persists the result-envelope
digest, so a non-renderable decision remains reconstructable without inventing
a projection digest.

### Coverage certificate

```ts
type ContinuationCoverageCertificateV1 = {
  certificate_version: "continuation_coverage_certificate_v1";
  compilation_input_sha256: Sha256;
  obligation_universe_sha256: Sha256;
  candidate_universe_sha256: Sha256;
  world_snapshot_sha256: Sha256;
  selected_surface_sha256: Sha256;

  coverage: Array<{
    obligation_id: string;
    status: "covered" | "uncovered" | "conflicted";
    capsule_refs: CapsuleRefV1[];
    satisfied_probe_ids: string[];
    reason_codes: string[];
  }>;

  candidate_partition: {
    selected_capsule_set_sha256: Sha256;
    excluded_capsule_set_sha256: Sha256;
    selected_count: number;
    excluded_count: number;
    candidate_count: number;
  };

  hard_obligation_coverage_complete: boolean;
  direct_use_preconditions_complete: boolean;
  conflict_free: boolean;
  budget_satisfied: boolean;
  required_render_bytes: number;
  status: "complete" | "incomplete";
  reason_codes: string[];
  certificate_sha256: Sha256;
};
```

The certificate proves coverage by the current evidence, not task success.

## Authority branches

An authority branch is an immutable **learning-only** decision-manifest revision
over `procedure` and `counter_evidence` capsule revisions. It is not a fork of
the memory commit graph and it never carries continuity state. Old execution-
tree passed/failed paths become verified continuity or governed
counter-evidence capsules according to their evidence and intended influence.

Authoritative learning genesis is always empty. A trusted observation may
advance the memory head with continuity without changing the learning head. If
the same observation admits learning proposals, Runtime creates a new isolated
candidate draft based on the current learning head; it does not smuggle those
bindings into authoritative serving.

```ts
type AuthorityBranchRefV1 = {
  branch_id: string;
  branch_revision: number;
  manifest_sha256: Sha256;
};

type AuthorityBranchRevisionV1 = AuthorityBranchRefV1 & {
  branch_kind: "authoritative" | "candidate";
  state:
    | "authoritative"
    | "draft"
    | "shadow"
    | "eligible"
    | "active_candidate"
    | "merged"
    | "rejected"
    | "quarantined"
    | "expired";
  authority_subject_sha256: Sha256;
  base_authoritative_ref: AuthorityBranchRefV1 | null;
  previous_revision_sha256: Sha256 | null;
  capsule_bindings: Array<{
    capsule: CapsuleRefV1;
    disposition: "include" | "exclude" | "prohibit";
  }>;
  compiler_policy_sha256: Sha256;
  evidence_policy_sha256: Sha256;
  policy_rotation: {
    artifact_sha256: Sha256;
    payload_sha256: Sha256;
    artifact_kind: "policy_rotation";
  } | null;
  effect_certificate_sha256: Sha256 | null;
  reverts_authority_revision_sha256: Sha256 | null;
};
```

Candidate transitions are:

```text
draft -> shadow -> eligible -> active_candidate -> merged
   |        |          |             |
   +------> rejected <-+-------------+
   +------> quarantined <-------------+
   +------> expired
```

`merged`, `rejected`, `quarantined`, and `expired` are terminal. A stale-base
candidate is rejected and rebuilt; Runtime V1 does not implement automatic
three-way authority merge.

Merge is one `BEGIN IMMEDIATE` transaction:

1. validate candidate state and exact base authoritative head;
2. verify the effect certificate binds candidate, control, ledger window, and
   evidence-policy digest;
3. recheck source capsule revisions, lifecycle, quarantine, expiry, and hard
   prohibitions;
4. create the next immutable authoritative revision;
5. create the terminal merged candidate revision;
6. CAS the authority head;
7. append the exact operation receipt;
8. commit, or roll back every mutation.

Revert never moves a head backward and never deletes evidence. It creates a new
authoritative revision based on a prior manifest and records
`reverts_authority_revision_sha256`. It must retain all newer privacy,
quarantine, scope, and hard-safety blocks. All old world observations and
coverage certificates become invalid after revert.

An authoritative revision after genesis has exactly one cause: an admitted
effect certificate, a forward revert, or a signed `policy_rotation` artifact.
A policy rotation is the exact next revision of the same authoritative branch,
changes at least one compiler/evidence-policy artifact or payload digest, and
preserves the complete semantic capsule-binding set. Binding row digests and
timestamps may change because they bind a new branch revision; capsule
identity, disposition, and admission authority may not. Merge and revert retain
the exact previous policy refs and carry no rotation artifact. Candidate
branches carry no rotation artifact and remain pinned to their exact base
policies. A rotation therefore makes candidates based on the previous head
stale; they must be rejected and rebuilt rather than silently rebased.

SQLite verifies the rotation artifact's full digest/payload/kind foreign key,
authority subject, validity window, exact previous revision, actual policy-ref
change, semantic binding equality, receipt-last closure, and unchanged head
CAS. SQL cannot verify Ed25519, canonical policy-rotation payload semantics, or
that its declared old/new refs equal the two branch revisions. The authority
store must revalidate those properties on insert and every read; an unavailable,
unparseable, incorrectly signed, or semantically mismatched rotation fails
closed and cannot become serving authority.

## Influence evidence chain

The append-only episode ledger records exactly four event kinds:

```text
contract_exposed
capsule_use_observed
outcome_observed
effect_certified
```

It does not duplicate authority or lifecycle state. Branch/head tables are the
authority for serving changes, memory tables are the authority for lifecycle
changes, and their exact operation receipts prove transaction completion.

The decision/effect join is:

```text
host task envelope
  -> continuation contract and coverage certificate
  -> exposure event and capsule surfaces
  -> host use receipt
  -> outcome receipt
  -> effect certificate
  -> branch authority mutation
```

A contract exposure binds the complete decision context, including
`render_result_sha256`, so both `rendered` and `not_renderable` envelopes have
durable identity without inventing a projection digest. Exposure, use, outcome,
and effect rows copy the same decision ID, run ID, host-task envelope, contract,
coverage certificate, render result, authority subject, and served branch
manifest. A use or outcome row is accepted only when all copied values equal
its exact cause.

Every causal link is the same four-part tuple:

```text
(cause_event_sequence, cause_event_id, cause_event_kind, cause_event_sha256)
```

The tuple is resolved through a composite foreign key in the same tenant,
scope, and episode. `contract_exposed` has no cause;
`capsule_use_observed` points to that decision's exposure;
`outcome_observed` points to its use event; and `effect_certified` points either
to the outcome that closed inside the evidence window or, for explicitly
missing outcome evidence, directly to the exposure. Marking a decision missing
is rejected if an outcome for that decision existed before window close. An
outcome arriving later remains a new append-only event and cannot rewrite an
already closed certificate.

`episode_capsule_facts` contains exposure and use members only. Every row binds
the exact event sequence, ID, kind, and hash. Event headers close a canonical
fact set with `capsule_fact_count` in `0..256` and
`capsule_fact_set_sha256`; fact sequences are contiguous `1..count`. A use fact
must name the same capsule revision, digest, and exposed surface as an exposure
fact. Its state is exactly `used | not_used | unknown`: `not_used` requires
positive host evidence, while `unknown` is an explicit inability to determine
influence and is never converted to `not_used`. Effect rows are forbidden from
this table.

Each cohort-assigned decision is instead normalized as one `effect_certified` event.
It binds the certificate and has a unique `effect_member_sequence`; a second
unique key on `(certificate, scope, decision_id)` prevents decision duplication
even when multiple decisions share an episode. The certificate header closes
the normalized rows with `assigned_decision_count` in `0..4096` and
`assigned_decision_set_sha256`. An admitted certificate has a safe harm
conclusion, beneficial utility, at least one exact control decision, and at
least one exact candidate decision; a rejected empty certificate
is valid only with the canonical SHA-256 of `[]`. The worker operation receipt
cannot close until the member count and sequence range are exact and contiguous.
The effect store must also parse each event payload and require its canonical
`EffectEvidenceMemberRefV1` to equal the row's scope, episode ID, decision ID,
member sequence, and complete cause tuple; opaque payload text can never
override or weaken those indexed projections.

Membership is a Runtime-derived intent-to-treat census, not a worker-selected
sample. It contains every exposure carrying an exact `ExperimentCohortV1`
reference and an atomic `assigned_control` or `assigned_candidate` serving
receipt. Ordinary authoritative traffic is excluded even when it served the
same branch as control. Assignment and exposure are one transaction, so
`assigned_count === exposed_count`; there is no pre-exposure missing category.

The signed cohort fixes the subject, scope, control and candidate learning
refs, compiler/evidence policies, assignment-window bounds, outcome deadline,
settlement grace, allocation, HMAC algorithm contract, and SHA-256 commitment
to one 32-byte per-cohort seed. It must be provisioned before its half-open
assignment window `[window_opened_at, window_closed_at)` and no subject may
have overlapping active cohorts. Runtime stores the verified seed as a
protected BLOB in the existing artifact row; no daemon read or HTTP API can
return it. Assignment is derived inside `create_continuation` from HMAC-SHA-256
over a stable task cluster containing the cohort ref, task family, and
`source_task_sha256` from the authenticated host task envelope. Operation,
decision, episode, run, host, snapshot, and memory-head identity remain in the
complete serving-assignment basis and receipt, but do not rerandomize the same
source task. Both arms receive that complete receipt, and it is persisted
atomically with the exposure. A benchmark or other evidence authority must
pre-register a deterministic `source_task_sha256`; allowing a host to change it
after observing an arm would permit assignment rerolls.

An outcome belongs to the census only when `observed_at <= outcome_deadline`;
its operation may be ingested only through
`outcome_deadline + settlement_grace`. The one cohort effect job is created
with cohort installation and becomes available at that settlement cutoff;
individual outcomes never enqueue effect jobs. Runtime rebuilds the complete
canonical set from assigned exposures and exact operation completion times and
rejects a worker package that adds, omits, or substitutes one decision.
`outcome_missing_bps` is recomputed as
`count == 0 ? 10000 : ceil(outcome_missing_count * 10000 / count)`; a missing
outcome is never evidence of success.

The effect worker treats the durable payload as a locator, not evidence. It
accepts only the exact cohort artifact ref, reloads the root-signed cohort and
its exact compiler/evidence policies through pinned authorities, then derives
the whole branch treatment delta and the all-and-only assigned-exposure ITT
census from SQLite. Redundant job fields must equal that signed cohort and a
payload cannot provide decision members or arm counts. The protected 32-byte
seed is copied from the cohort artifact row only inside a synchronous
worker-only callback, checked against the signed commitment, converted to the
post-closure audit reveal, and zeroed in `finally`. The signed evidence policy
drives the pure evaluator. A dedicated Ed25519 key signs the resulting exact
certificate outside the SQLite write transaction.

`commitAuthority` does not trust that prepared package. Inside the worker
completion transaction the effect store independently reloads the signed
authority, replays every assignment from the revealed committed seed,
rebuilds the full exposure/outcome census and whole treatment delta, reruns the
pure evaluator, verifies the signer, and only then inserts the certificate and
effect events. The same transaction completes the one effect job and may not
write memory or enqueue a child job. If an outcome transaction committed at
the inclusive cutoff becomes visible between preparation and commit, the
stale certificate is rolled back and the job is retried from the now-closed
ledger; integrity, seed, policy, signature, and payload failures are terminal
and persist only stable redacted codes.

`EffectCertificateV1` is a header, not a hidden member container. It binds the
exact control and candidate branch revisions, exact compiler-policy artifact
ref, exact evidence-policy artifact ref, evidence-window digest and timestamps,
effect-verifier contract digest, statistical-contract digest, decision-set
header, outcome missingness, conclusions, uncertainty, whole-treatment-delta
header, verifier identity, per-cohort seed reveal, and signature. The reveal
must hash to the signed cohort commitment and is published only after closure
so an external auditor can replay every assignment. It is never a cross-cohort
master secret. The certificate's canonical JSON may not embed assigned
decisions, episodes, or treatment members. The exact semantic binding delta is
normalized into `effect_certificate_treatment_members` with contiguous
`1..treatment_delta_count` sequences. Each member carries the exact before and
after binding for one `(capsule_scope, capsule_id)`; unchanged bindings are
absent, and additions, removals, revision changes, disposition changes, and
authority changes are all digest-significant.

Evidence evaluates that entire treatment as one intervention. Runtime never
manufactures `beneficial`, `neutral`, or `harmful` conclusions for individual
capsules from an aggregate cohort result. An admitted certificate therefore
authorizes only the exact candidate branch revision and its complete treatment
delta; it cannot be decomposed into reusable positive credit for a subset.

Receipt insertion is the final write barrier. A `create_continuation` receipt
requires exactly one exposure and its complete fact set; a `record_outcome`
receipt requires exactly one use, one outcome, and the complete use fact set;
and a `worker_completion` receipt requires complete decision-member and
treatment-delta sets. After a receipt exists, certificate, member, event, and fact
append paths reject further writes owned by that operation.

SQLite enforces exact references, closed enums, temporal windows, unique
decision membership, and contiguous counts. The effect store additionally
rebuilds both canonical sets and their digests, verifies that every projected
column equals the canonical signed certificate header, and checks the compiler
policy ref, evidence policy ref, verifier/statistical contract digests, and
evidence-policy payload as one binding. It decodes the SPKI DER, requires
canonical base64url, recomputes `verifier_principal_sha256`, verifies the
Ed25519 proof of possession, and does all checks again on every read. The
certificate's `trust_root_sha256` identifies the installed evidence-policy
authority root; it is not a substitute for the effect signer's public key.
`outcome_missing_bps` is not verifier prose: Runtime recomputes it from the
closed member set as
`count === 0 ? 10000 : ceil(outcome_missing_count * 10000 / count)` and
requires exact equality before persisting or re-authorizing a certificate.

Runtime V1 does not hardcode pair counts, activation waves, holdout sizes, or
release-study protocols. Those remain outside the daemon. Runtime does contain
one versioned, digest-bound generic evaluator (including the Newcombe
hybrid-score risk-difference interval); signed evidence policy supplies its
confidence level, sample floors, missingness ceiling, harm margin, and utility
threshold. Changing the evaluator requires a new statistical-contract digest,
not an untracked external interpretation.

No GuidePacket field, Agent statement, aggregate four-kernel score, or expected
effect declared by the Runtime may grant per-capsule credit.

## Durable decision reconstruction

The decision store must reconstruct by public `decision_id` or host `run_id`
without caller-supplied packet artifacts. `decision_id` is also the immutable
continuation-contract ID; there is no second public guide-trace identity.

- task and world-snapshot identity;
- authoritative and served branch revisions;
- bounded candidate universe, selected surfaces, and exclusions;
- coverage certificate and rendered projection digest;
- use and outcome receipts;
- effect certificates, plus subsequent lifecycle and authority revisions read
  from their respective authoritative tables and operation receipts.

Counterfactual mode recompiles the same immutable inputs while excluding one
capsule or substituting one eligible branch. It returns a structural diff of
surfaces, obligation coverage, fallback, and digest. It does not claim a causal
effect unless an admitted effect certificate supports that claim.

## Clean database generation

Runtime V1 uses a new schema generation and refuses to open a v0.3.x database.
There is no legacy migration, dual write, shadow table, or read adapter. A user
who needs old research data exports it with the old binary and imports it as
new observation evidence through an offline tool.

The authority database has exactly 17 tables:

| Table | Authority |
|---|---|
| `runtime_meta` | singleton database identity, schema ID, schema-manifest digest, and committed factual authority-time floor |
| `operations` | exact replay receipt keyed by tenant, scope, kind, and operation ID |
| `durable_jobs` | one leased queue for embedding, ANN, effect, and retention work |
| `memory_commits` | monotone per-scope revision, parent, and complete mutation digest |
| `memory_scope_heads` | one mutable CAS memory head per scope |
| `memory_items` | current memory projection, lifecycle, hydration, row digest, and commit ref |
| `memory_relations` | current relation projection, row digest, and commit ref |
| `capsule_revisions` | immutable capsule content bound to source memory and commit |
| `observation_snapshots` | immutable bounded typed host observations and their digest |
| `authority_artifacts` | signed compiler/evidence policy, experiment-cohort, protected cohort seed, and policy-rotation artifacts |
| `branch_revisions` | immutable branch manifest and state revisions |
| `branch_capsule_bindings` | exact include, exclude, and prohibit bindings per branch revision |
| `authority_heads` | one mutable CAS authoritative branch head per subject |
| `episode_events` | append-only exposure/use/outcome/effect chain with exact cause tuples and normalized decision membership |
| `episode_capsule_facts` | exact exposure/use capsule surfaces and three-state use evidence; maximum 256 per event |
| `effect_certificate_treatment_members` | normalized exact before/after members of one whole branch treatment delta |
| `effect_certificates` | signed header for exact branches, compiler/evidence policy, verifier/statistical contracts, evidence window, decision set, and treatment-delta set |

There is no capsule-status, execution-state, execution-tree, handoff, guide,
measure, skill-review, Flight Recorder, or experiment-orchestration table. ANN,
keyword, and embedding data are rebuildable candidate sidecars, not authority.

Continuation contracts are stored as the canonical payload of
`contract_exposed`; a second mutable contract table is forbidden. Indexed
identity columns may accompany the canonical payload but must be protected by
digest verification on read and reopen.

The sole DDL source is `src/store/sql/continuation-runtime-v1.sql`. A build tool
executes it against real SQLite and generates a checked-in Merkle-style
manifest from `sqlite_schema`, `table_xinfo`, `index_xinfo`, and
`foreign_key_list`. The manifest stores object identities and complete
row-group digests instead of duplicating the DDL and every PRAGMA row. Its
`ddl_sha256` binds the exact SQL resource while `schema_sha256` binds the
logical schema, so a source-only formatting change does not create a false
database generation. CI checks all three. Runtime source outside the canonical
bootstrap may not contain `CREATE`, `ALTER`, or `DROP TABLE`.

Opening an existing file is side-effect-free until exact compatibility is
proved:

1. only a missing path may bootstrap; an existing empty file is rejected;
2. bootstrap uses one `BEGIN EXCLUSIVE`, strict tables, real foreign keys,
   `application_id`, `user_version`, and exact manifest validation;
3. an existing file without recovery sidecars is first opened immutable and
   read-only; after a crash, main/WAL/journal are copied into a private
   throwaway namespace and recovery is performed only on that copy. Either path
   checks owner-only mode, application ID, version, meta digest, integrity, and
   exact schema with no extra object while leaving the authority namespace
   untouched;
4. only after that check may Runtime reopen `mode=rw`, verify the same inode,
   enter `BEGIN IMMEDIATE`, recheck identity, and enable WAL;
5. v0.3.x, older/newer generations, partial schemas, extra tables, and changed
   indexes or triggers are rejected without modifying the database, WAL, or SHM.

All stores share one write connection, transaction runner, and database-bound
monotonic authority time. Its source must return a validated canonical UTC
millisecond timestamp. Runtime clamps that source against the opener's observed
and committed floors; an active write transaction also observes the factual
floor in `runtime_meta`, so a stale opener cannot mint below another opener's
committed mutation. A store, application service, worker service, or provider
cannot replace this database capability.

Only an active `BEGIN IMMEDIATE` transaction may mint an authority timestamp.
A mint uses the effective authority time and, when a causal lower bound is
explicitly supplied, advances strictly beyond that bound. The factual floor is
updated in the same transaction: commit makes it visible to later openers and
restart, while rollback advances neither the durable floor nor the committed
process floor. Receipt minting therefore cannot precede an earlier
Runtime-minted mutation in the same operation. This floor is not a logical
sequence generator: future `available_at`, `retry_at`, lease expiry, signed
validity windows, outcome deadlines, and settlement cutoffs do not advance it
merely because they lie in the future. Externally signed timestamps remain
issuer-authored values that Runtime validates and binds; Runtime does not claim
to have minted them.

Operational timers only wake polling or request cancellation. They never mint
or advance authority time, expire a lease, or override the transaction's
database-time check. Store constructors cannot perform DDL. Compile/exposure is
committed before a contract is returned; use/outcome is atomic; cohort
installation and its one settlement-time effect job are atomic; branch merge
performs certificate verification, new revisions, CAS head, and operation
receipt in one transaction. Workers lease in a short transaction, compute
outside SQLite, then commit by lease-token CAS. ANN and notifications run only
after commit.

Authority mutation is capability-owned, not convention-owned. On the first
execution of an operation, the operation store issues an opaque write context
bound to that exact database object, transaction identity, tenant, scope,
operation kind, operation ID, and request digest. Mutating stores authenticate
that context before every write. A forged, copied, wrong-database,
wrong-transaction, replayed, or post-commit context is rejected. A mutating
store cannot open an independent transaction, and the operation request digest
is taken from the authenticated context rather than caller input.

An observation-batch ID is the exact `record_observations` operation ID. Its
batch authority is the authenticated operation receipt and receipt digest; an
additional mutable batch table is forbidden. Operation receipt lookup reads
and revalidates the persisted canonical envelope and never accepts a caller
request digest.

### Signed genesis provisioning

A fresh database contains only `runtime_meta` and is not ready to compile. It
must be provisioned explicitly with Ed25519-signed compiler and evidence policy
artifacts before the daemon serves product traffic. Runtime never ships a
private authority key and never signs its own learning policy.

V1 pins one trust-root public key by its SHA-256 SPKI identity. Each genesis
artifact is signed directly by that root; delegation is intentionally absent
from V1. The signature covers the canonical artifact payload plus every
authority column other than the signature itself. Artifact payload digest,
signer identity, root identity, validity window, schema, kind, ID, revision,
and optional authority subject are all revalidated before insertion and on
read.

The trust-root path must resolve to a stable regular file with one hard link,
owned by the Runtime uid or root, and not writable by group or others. Runtime
checks the path and descriptor identity before and after a bounded read.

Provisioning is an offline `authority_decision` operation, so policy insertion
and its receipt are atomic. The first trusted observation for an authority
subject may then create an empty authoritative **learning** genesis branch and
CAS head referencing those signed policies; continuity remains solely under
the memory head. Missing, expired,
wrong-root, or invalid policy artifacts make readiness false; there is no
unsigned built-in default, compatibility bootstrap, or daemon migration.

## Daemon and worker configuration boundary

The HTTP daemon and durable workers are separate security principals with
separate strict environment parsers. Neither parser accepts the union of both
surfaces: every unknown `AIONIS_*` field aborts startup, so accidentally
injecting a secret into the wrong process is a deployment error rather than a
silently retained capability.

The daemon allowlist has exactly 13 fields:

`AIONIS_DATA_PATH`, `AIONIS_TENANT_ID`, `AIONIS_HOST_PRINCIPAL_ID`,
`AIONIS_HOST_API_KEY_FILE`, `AIONIS_OPERATOR_PRINCIPAL_ID`,
`AIONIS_OPERATOR_API_KEY_FILE`, `AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH`,
`AIONIS_TRUST_ROOT_SHA256`, `AIONIS_HTTP_HOST`, `AIONIS_HTTP_PORT`,
`AIONIS_HTTP_BODY_LIMIT_BYTES`, `AIONIS_LOG_LEVEL`, and
`AIONIS_SHUTDOWN_TIMEOUT_MS`.

Each daemon role requires one absolute private-token file. It must be regular,
owned by the current Runtime uid, single-linked, exact mode `0400` or `0600`,
and contain 32–512 visible-ASCII bytes (`0x21`–`0x7e`). Type, ownership, mode, link count,
size, and mutation stability are checked before Runtime hashes both API keys;
the files are read once and no raw caller credential is retained. Direct
`AIONIS_HOST_API_KEY` and `AIONIS_OPERATOR_API_KEY` fields no longer belong to
the daemon contract, so either field is rejected by the unknown-field gate.
The daemon has no worker role, queue lease/poll/batch control, embedding
provider endpoint, model, dimensions, or provider API key.

The worker allowlist has exactly 16 fields. Ten are process-common worker
fields: `AIONIS_DATA_PATH`, `AIONIS_TENANT_ID`,
`AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH`, `AIONIS_TRUST_ROOT_SHA256`,
`AIONIS_WORKER_ROLE`, `AIONIS_JOB_LEASE_MS`, `AIONIS_JOB_POLL_MS`,
`AIONIS_JOB_BATCH_SIZE`, `AIONIS_LOG_LEVEL`, and
`AIONIS_SHUTDOWN_TIMEOUT_MS`. The remaining four are
`AIONIS_EMBEDDING_BASE_URL`, `AIONIS_EMBEDDING_MODEL`,
`AIONIS_EMBEDDING_DIMENSIONS`, and `AIONIS_EMBEDDING_API_KEY_FILE`. The final two
are `AIONIS_EFFECT_SIGNER_PRIVATE_KEY_PATH` and
`AIONIS_EFFECT_SIGNER_SHA256`.

All four embedding fields are mandatory only for an `embedding` worker and
forbidden for `ann`, `effect`, and `retention` workers. ANN consumes the vector
artifact produced by the embedding job and writes a verified, content-addressed
immutable index segment; it does not call the embedding provider and receives
no provider key. The embedding key is loaded from a private single-link stable
file into a process-private mutable buffer, never from environment, and is
destroyed only after in-flight work drains. V1 currently exposes no vector-search
serving port, so segment generation is not evidence that ANN retrieval is active
in decision assembly.
The `retention` role may delete only rebuildable sidecar artifacts selected by
an already-committed lifecycle authority decision; it cannot mutate memory,
branch, cohort, or effect authority and cannot enqueue another worker job.
The two effect-signer fields are mandatory only for an `effect` worker and
forbidden for every other role. The loader accepts one owner-private, regular,
non-linked PKCS#8 Ed25519 file, pins its public-key digest, and never sends the
private key to the daemon or exposes its path in public configuration. This
dedicated verifier key is not the offline authority-root key; startup rejects
equal public-key digests.
Workers reject all host/operator credentials and HTTP listen/body-limit
fields.

Public configuration projections contain only bounded operational metadata,
digests, and `*Configured` booleans. They never contain a raw API key, data
path, trust-root path, tenant ID, or principal ID.

## Public HTTP and SDK surface

The vNext daemon exposes exactly five `/v1` product routes:

### `POST /v1/observations`

The only fact/state write entry. A strict request carries `operation_id`,
an authenticated scope, one task-only host-envelope body, typed memory inputs,
raw collector-observation
bodies, and optional fully signed external-verifier observations. Caller input
cannot set tenant, scope, authority subject, collector role, principal,
task/snapshot binding, attestation, or observation digest. Typed memory inputs
are evidence-bound proposals; they cannot set memory IDs, lifecycle/authority,
relations, capsule IDs/revisions, or branch membership. It does not accept
loose nodes, edges, slots, handoff
packets, or unknown execution blobs. The response returns the observation-
batch ID, exact operation receipt, memory commit ref, capsule refs, and world-
snapshot ref. Whenever it creates a candidate, that same receipt also contains
the immutable base authoritative ref and head CAS that governed the draft,
including when genesis was created by an earlier operation.

### `POST /v1/continuations`

The only compile-and-serve entry. A request carries `operation_id`, scope,
host-task envelope, obligations, observation-batch refs, and render format and
budget. The client cannot choose authority, experiment arm, or candidate
serving. The response returns `decision_id`, the canonical contract, one
rendered projection plus digest, and the durable exposure receipt. Incomplete
coverage is a valid contract with a non-execute fallback, not an HTTP error.

### `POST /v1/outcomes`

The only exposure-to-use-to-outcome entry. A request carries `operation_id`,
`decision_id`, exact host-use receipt, and outcome receipt. New world state is
recorded through a subsequent `/v1/observations` operation instead of an
outcome side channel that cannot receive an observation receipt. It cannot
submit expected effects, promotion thresholds,
or caller-computed baseline/Aionis scores. The response returns episode/event
refs, ledger head, effect state, and any new candidate-branch refs.

### `POST /v1/authority-decisions`

The only lifecycle and branch-authority mutation entry. Its strict tagged union
supports lifecycle suppress/restore/archive and branch merge/reject/quarantine/
expire/revert. Every request carries an expected authority revision. Merge
requires an admitted effect certificate and CAS; an operator click alone cannot
promote authority. Conflicts return `409` with no partial mutation.

### `GET /v1/decisions/:decision_id`

The only operator/debug/audit/Flight Recorder entry. `summary`, `full`, and
authorized counterfactual views are reconstructed only from durable rows.
Counterfactual query parameters may exclude an exact capsule revision or
substitute an eligible branch. The endpoint never accepts caller-supplied Agent
contexts, traces, snapshots, or feedback blobs.

The daemon separately keeps only minimal `/healthz` and `/readyz` operational
probes. Static boundary inventory is derived from source and enforced by the
version-controlled complexity budget in CI; it is not exposed as an HTTP
route. The admin catch-all and rich `/health` endpoint are deleted.

These five routes replace all 21 v0.3 routes. Handoff becomes current-state and
counter-evidence observations; recover/govern/rehydrate/resolve become compiler
behavior; feedback/measure become outcomes; skill materialization becomes a
candidate branch; all operator projections become durable decision views.

The SDK is a thin transport with exactly five corresponding methods:

```ts
recordObservations(request)
createContinuation(request)
recordOutcome(request)
decideAuthority(request)
readDecision(request)
```

It performs no admission, resolve loop, prompt compilation, budget truncation,
policy defaulting, or authority inference. No compatibility alias, redirect,
feature flag, dual registration, or SDK-side policy compiler is permitted.
The SDK is packaged separately as `@aionis/continuation-sdk` with no Runtime,
SQL, daemon, worker, or tooling files and no runtime dependency. The repository
root is a private OCI build manifest with no npm entry point; the non-root OCI
image is the only runnable Runtime artifact. That image is assembled from an
exact content-addressed closure rooted at the daemon, provisioner, and worker
entries. It carries a minimal script-free runtime manifest and rejects Aionis
SDK, declaration, source-map, repository-source, and repository-tooling files.

## Module deletion contract

The following v0.3.x shapes are deleted as authorities:

| Legacy shape | V1 replacement |
|---|---|
| `execution_contract_v1` adapters and reverse projections | capsule + obligations + one continuation contract |
| `memory_contract` | lifecycle/branch checks plus selected surface |
| `GuidePacket` and guide brief | continuation contract |
| `AionisAgentContext` | deterministic renderer projection |
| `route_contract` | typed obligations and target refs |
| execution state/tree packet slots | current-state/counter-evidence capsules |
| handoff store/recover contracts | persisted capsule state plus continuation compilation |
| replay playbook compile/promote/repair/run/dispatch | procedure capsules, candidate branches, outcomes, and counterfactual decision reads |
| SDK `compileExecutionAgentContext` | thin transport of Runtime contract/projection |
| measure-from-expected-effects logic | host outcome and effect certificate |
| caller-supplied Flight Recorder artifacts | durable decision reconstruction |

`src/memory/execution-agent-contract-packet.ts` had no production consumer and
was deleted in the first implementation batch together with its dedicated test.
The production-dead lifecycle shadow-model prompt/regex producer and the two
test-only replay option/review-policy wrappers were also deleted; semantic
candidate generation now enters only through a generic evidence port outside
the daemon authority path.

## Implementation batches

Batches 1-7 are implemented in the current clean-break tree. Batch 8 remains in
progress and is not release evidence.

1. **Implemented — foundation and dead-code deletion**: added canonical types,
   hashing, validation, and property tests; deleted the unused execution-agent
   packet.
2. **Implemented — compiler vertical slice**: added typed observation
   evaluation, bounded candidate partition, coverage selection, certificate,
   and renderer; cut the guide path directly to the new contract.
3. **Implemented — projection deletion**: deleted GuidePacket, AgentContext,
   route-contract, memory-contract, and SDK policy duplication.
4. **Implemented — clean database cutover**: replaced the schema generation,
   added capsule/branch/head authority, rejected old databases, and deleted the
   execution-tree and handoff tables.
5. **Implemented — evidence cutover**: added the exact exposure/use/outcome
   cause chain, normalized effect decision membership, and closed exposure/use
   fact sets; removed circular measurement and bound exact capsule revisions.
6. **Implemented — branch learning**: added shadow and assigned-candidate
   serving, effect-gated merge, quarantine, expiry, and forward revert.
7. **Implemented — protocol extraction and recorder**: removed fixed experiment
   SQL/policy from Runtime core, consumed signed generic evidence artifacts, and
   rebuilt durable counterfactual inspection.
8. **In progress — convergence proof**: internal complexity, recovery, Runtime,
   and exact-commit checks are still being closed. The real external-Agent dual
   arm, protected 9-call pilot, and 24-36 hour soak have not run and remain
   release blockers.

Every batch leaves a runnable vertical slice and introduces no compatibility
contract. The earlier 40-daemon-module and 20,000-daemon-line figures were
planning estimates; they are superseded, were not achieved, and are not release
claims. File counts are authenticated observations because physical capability
splits may add modules while reducing coupling; nonproduction, test, gate, tool,
and resource line counts are observations too. Hard convergence gates retain
downward ceilings for daemon, worker, provisioning, SDK, production-union, and
total-V1 source lines; a 1,200-line ceiling for every production and V1 source
file; zero production and total runtime import cycles; zero full type-dependency
strongly connected components; and exact route, environment, schema, resource,
and forbidden-capability inventories.

## Required tests

At minimum, the new architecture must prove:

- canonical hashes are independent of input object/map ordering;
- duplicate set members and non-canonical values are rejected;
- selected plus excluded exactly partitions the bounded candidate universe;
- hard prohibitions and counter-evidence cannot be removed by budget pressure;
- unknown/stale/unauthorized probes never permit direct use;
- task, scope, principal, workspace, and source-revision mismatch fail closed;
- conflicts cannot be resolved by similarity alone;
- deterministic recompilation produces the exact contract digest;
- missing host use never receives positive attribution;
- stale-base branch merge, stale lifecycle, and wrong certificate all roll back;
- exact operation replay succeeds and changed-input replay conflicts;
- SIGKILL between every authority write step leaves either the old or complete
  new head after reopen, never a partial state;
- forward revert preserves newer privacy/quarantine/safety blocks;
- the Flight Recorder reconstructs from an ID without caller artifacts;
- a counterfactual exclusion produces an exact structural diff;
- negative-transfer and no-evidence cases do not promote candidate authority;
- real Agent behavior is verifier-safe and measurably better than baseline and
  observe-only controls before any release claim.

## Pre-cutover removal evidence

The clean break was justified by concrete duplication in the pre-cutover v0.3
tree. The following paths are historical evidence; they are deleted from the
current V1 tree:

- `src/memory/execution-contract.ts` derived and merged contracts from multiple
  legacy slots and projects them back again;
- `src/memory/product-output/guide-packet.ts` created an intermediate guide
  authority before the Agent contract is compiled;
- `src/memory/agent-context-compiler.ts`,
  `src/execution/evidence-context.ts`, and `src/product/guide-service.ts` contained
  three separate Agent-context construction paths;
- `src/memory/agent-context-renderer.ts` enforced budget by rendered-character
  truncation;
- `src/sdk.ts` duplicated route policy and recompiled another Agent context;
- `src/product/measure-service.ts` consumed Runtime-declared expected effects,
  which is circular evidence;
- `src/memory/execution-agent-contract-packet.ts` was production-dead and tested
  only by its dedicated CI file.

The former 4,000-5,800-line net-removal range and 10% daemon-closure target were
pre-implementation estimates. They are retired, are not current measurements,
and are not acceptance criteria. The current implementation is measured only
from the exact V1 inventory and entry closures emitted by the authenticated
complexity report.

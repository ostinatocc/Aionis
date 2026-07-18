# Aionis Learning Episode Ledger and Evidence-Gated Learning Design

Status: implemented through Task 5.1; Task 6 and later evidence and promotion phases remain proposed

Date: 2026-07-13

## 1. Goal

Make Aionis learning as operationally mature as continuity by adding a durable,
replayable link from a served guide decision to attributed feedback, verified
effects, and task-family-scoped promotion or demotion.

The target loop is:

```text
guide exposure
  -> immutable episode and per-memory decision facts
  -> directly attributed feedback
  -> verified effect reference
  -> exploration/exploitation evidence slices
  -> shadow plus active/control evidence gates
  -> task-family adjudication
  -> continued monitoring and rollback
```

One successfully persisted `/v1/guide` exposure is one learning episode. The
episode identifier is deterministic from tenant, scope, and `guide_trace_id`.
A guide can contain multiple memory decisions, so exploration/exploitation is
frozen per memory item; an episode may therefore be `mixed` when summarized.

## 2. Non-goals

- Do not replace `lite_product_guide_receipts`, memory commits, rule feedback,
  product measurements, admission records, decision traces, or flight recorder.
- Do not infer a Core or global policy from one task, repository, model, or eval.
- Do not count missing feedback or unused exposure as negative evidence.
- Do not make current global candidate mode active by default.
- Do not introduce Kafka, an external event store, or a second database.
- Do not add a new v1 HTTP route. Operator inspection extends the existing
  `/v1/audit/flight-recorder` surface.
- Do not create arm-specific copies of all Runtime memory state in v1.

## 3. Baseline code findings that constrained the design

| Current implementation | Consequence |
|---|---|
| Guide applies candidate projection before persisting the final `agentContext` in `src/product/guide-service.ts`. | The current guide ledger cannot reconstruct recorded, candidate, and served actions. |
| `ProductGuideExposureLedger` stores final memory surfaces and a task-binding hash, but not policy/profile/experiment/arm metadata. | Exposure policy facts must be captured before the response-only projection is discarded. |
| Memory activation validates `guide_trace_id`, then omits it from the payload passed to `activateMemoryNodesLite`. | Node counters cannot prove which guide caused feedback. |
| Before Task 4.1 Step 4, repeated-unused control was persisted after the activation transaction. | Resolved: formal feedback now atomically enqueues durable work, and the worker owns the later atomic posture/audit completion. |
| Product tool feedback validates the guide receipt, but `recordToolSelectionFeedback` does not receive `guide_trace_id`. | Tool feedback cannot be joined back to an episode. |
| `learning-kernel.ts` calls `toolSelectionFeedback` without a shared outer transaction. | Tool feedback commit, aggregates, pattern/policy writes, and episode facts can partially persist. |
| Measurement/skill review opens a second SQLite write connection to the same path. | Measurement and `effect_measured` cannot be atomic until the store shares `LiteRuntimeDatabase`. |
| Workflow promotion accepts `observed_count >= 2` and infers `task_family` authority from a workflow signature. | Existing `promotion_protocol` breadth/holdout/negative-transfer fields are not enforcing task-family authority. |
| Current candidate projection bounds shadow decisions to 96 items. | Formal experiment enrollment must prove projection completeness or fall back to control. |
| Online candidate projection and the offline evaluator currently duplicate one hard-coded policy implementation. | Candidate ID/version cannot be free-form metadata; both paths must resolve one shared behavior registry and reject unknown versions. |
| Current `task_binding_sha256` contains run ID and query hash. | It is a receipt binding, not a stable longitudinal A/B assignment unit. |
| `/v1/guide` already authenticates through `requireMemoryPrincipal` and server identity binding, but the resolved principal is not passed into `guide.execute`. | Evidence-source class must be derived by extending this existing identity path, not trusted from a new body field. |
| Node prior counters live in the existing store namespace and are not copied per experiment arm. | Task- or repository-level assignment would leak learned state across arms. Confirmatory assignment must lease and randomize the whole canonical store-memory namespace as one cluster. |
| The eval action-completion wrapper collects reports but never reads its configured `promotion_gate`; 40 gradient rows collapse to only 10 independent base tasks. | The existing real-Agent suite remains a prerequisite regression, not the new statistical gate. |
| Eval guide construction uses the hygiene-specific trap ID as `task_signature`, omits `operation_id`, and has one Aionis endpoint/arm. | The harness must use base-task clusters, preserve Runtime-returned episode provenance, and add isolated offline paired plus real online collection modes. |

The implementation must preserve the existing source artifacts as authority and
add only the missing cross-stage facts.

## 4. Requirements and invariants

### 4.1 Functional requirements

1. Persist the served guide receipt, learning exposure event, and per-memory
   exposure items in one SQLite transaction.
2. Persist a memory or tool mutation, its complete feedback attribution, and
   any immediate safety demotion in one SQLite transaction.
3. Persist a product measurement and its episode effect reference in one
   SQLite transaction.
4. Freeze decision-time prior state and learning track before feedback exists.
5. Assign active/control deterministically within one immutable experiment
   revision.
6. Keep exploration and exploitation evidence separate in every report and
   gate.
7. Record task-family gate decisions append-only with a reproducible cohort
   digest and evidence cutoff.
8. Persist the validated external evidence manifests consumed by a gate.
9. Apply any serving or authority transition in the same transaction as its
   adjudication row.
10. Derive online evidence-source eligibility from a frozen authenticated
    principal mapping; never accept a client-claimed source class.
11. Replay the ledger after restart and verify every digest and source link.

### 4.2 Hard invariants

```text
one committed guide_trace_id = one exposure event = one episode
episode feedback can only reference an existing exposure
same operation_id + same request digest = replay, not another mutation
same operation_id + different request digest = conflict and zero mutation
served non-use boundary may never be upgraded by a candidate policy
decision-time learning_track never changes after exposure
missing feedback != negative feedback
unused exposure != direct-use feedback
legacy backfill != promotion evidence
fixture pilot or unverified principal != genuine online evidence
shadow evidence != active-arm outcome evidence
online active/control evidence != sufficient standalone efficacy proof
mixed episode summary != mixed item evidence exclusion
promotion_ready at an old head != current promotion authority
new experiment revision or version alias != candidate-implementation safety clearance
new experiment revision != a new confirmatory alpha budget
higher look reservation != permission to adjudicate an older ready look
task-family promotion != global or source-code authority
```

### 4.3 Non-functional requirements

- **Durability:** RPO 0 between a business mutation and its learning fact.
- **Performance:** guide hot path adds bounded validation plus indexed SQLite
  inserts only; no LLM call, cohort scan, or statistical gate runs in the write
  transaction.
- **Privacy:** ledger payloads contain IDs, hashes, bounded enums, counters, and
  evidence references; no raw query, prompt, memory text, or unredacted note.
- **Integrity:** append-only rows have content digests; update/delete triggers,
  source uniqueness, episode sequence, and source-link verification fail closed.
- **Scope:** no cross-tenant aggregation. Task-family aggregation may span
  eligible Runtime scopes inside one tenant and records the scope-set digest.
- **Compatibility:** existing requests without `operation_id` remain accepted in
  shadow/legacy mode, but cannot become randomized promotion evidence.

Existing memory feedback without `guide_trace_id` remains a compatible domain
mutation, but appends no episode event because no exposure can be proven. Its
response reports `learning_attribution_status=not_attributed`; it is never
backfilled into an attributed outcome. Legacy feedback with a valid guide but
without a strict host receipt may append `legacy_unverified` attribution.
Existing verifier status `unknown` normalizes to SQL `NULL`; only strict receipt
verification can persist `passed`.

The public guide compatibility boundary is explicit:

- `feedback_attribution_v1.status = available` is constructed only from
  post-append database readback and contains the exact persisted item/surface
  projection for that guide.
- `status = unavailable` means no learning exposure authority was persisted;
  feedback helpers must fail closed.
- `agent_context` is a continuity and visibility projection. Its IDs are not
  feedback authority and cannot be used as an eligibility fallback.
- SDK feedback requires the complete source guide. A cached guide without this
  envelope must be refreshed, not reconstructed from AgentContext.
- Actual use remains a host observation. A persisted exposure item that was not
  used is observationally unused, never implicit negative feedback.
- Non-neutral inspect/do-not-use attribution requires a verified canonical host
  receipt; rehydrate-only items and mixed surfaces are not direct feedback.

The existing scope-authorized flight recorder returns episode-local facts plus
only a gate decision ID, verdict, scope-set digest, and authority status. It
never expands cross-scope cohort members or per-scope statistics through a
single-scope authorization. A future cross-scope detail view would require
separate authorization for every scope member.

## 5. Architecture

```text
Existing profile rule JSON
        |
        v
Experiment resolver ---- immutable experiment revision
        |
        v
Pre-decision prior snapshot + deterministic cluster assignment
        |
        v
Recorded policy ---- candidate projection ---- served arm
        |                    |                    |
        +--------------------+--------------------+
                             |
                 one shared SQLite transaction
                             |
              +--------------+----------------+
              |              |                |
        guide receipt   exposure event   exposure items
              |
              v
 memory/tool feedback attribution
              |
       one shared transaction
              |
 mutation + feedback event/items + immediate safety control
              |
              v
 product measurement -> effect event reference
              |
              v
 frozen offline paired replay + online operational evidence
              |
              v
 append-only task-family gate decision
```

The episode ledger is a relational append-only journal, not a generic event
bus. Read-only projections are built by replay; v1 does not persist a second
`LearningEpisodeProjection` truth table.

## 6. Terminology

### 6.1 Episode

```ts
episode_id = `lep_${sha256(tenant_id, scope, guide_trace_id)}`;
```

The first event is always `exposure_committed`. Later events are
`feedback_attributed` or `effect_measured`. Corrections append another event and
refer to the superseded event; rows are never updated.

### 6.2 Learning track

Track is frozen for each memory decision before the arm is applied. The
resolver deliberately consumes only fields captured in the exposure item:

```ts
priorAvailable =
  prior_supported_use_count > 0
  || prior_contradicted_use_count > 0
  || prior_rehydrate_requested_count > 0
  || prior_effect_state !== "no_prior"
  || repeated_negative_posture;

learningTrack = priorAvailable ? "exploit" : "explore";
```

Track-reason precedence is fixed: `prior_nonuse_control`, `prior_mixed`,
`prior_contradicted`, `prior_rehydrate_requested`, `prior_supported`, then
`no_prior`. This matches the current `runtimePriorStateFromSlots` output rather
than trying to reconstruct mutable node slots after the decision.

Episode summary is derived only from policy-affected items:

```text
no affected items                    -> unaffected
all affected items explore           -> explore
all affected items exploit           -> exploit
both                                 -> mixed
legacy/incomplete                    -> unclassified
```

`mixed` is an episode display label only. Its explore items contribute to the
explore unit and its exploit items contribute to the exploit unit through their
own frozen item tracks. Only `unclassified` items are excluded from primary
track denominators; otherwise mixed episodes would create a selective evidence
blind spot.

### 6.3 Experiment arm

For this design, `recorded_action` means the result after all existing generic
guide projections and safety rules, but immediately before the admission
candidate projection. `candidate_action` is the hidden result of applying the
versioned candidate to that recorded action. `served_action` is the actual
receipt surface after arm selection and all non-upgrade safety ceilings.

The existing profile selectors remain the authority ceiling. An optional
`experiment` object is added inside the existing profile-rule JSON; no new env
variable is introduced.

```ts
experiment: {
  experiment_id: string;
  revision: number;
  serving_phase: "aa" | "shadow" | "active_control";
  evidence_intent: "integrity_only" | "confirmatory";
  candidate_policy_id: string;
  candidate_policy_version: string;
  candidate_allocation_bps: number;
  gate_policy_id: string;
  gate_policy_version: string;
  required_evidence_series: {
    offline_paired: string;
    production_shadow: string;
    tool_e2e: string;
    runtime_integrity: string;
  };
  external_execution_policy: {
    policy_version: "external-execution-v1";
    runtime_authority_attestor: {
      service_identity: string;
      attestor_binary_sha256: string;
      attestor_policy_sha256: string;
      attestor_public_key_base64: string;
      attestor_public_key_sha256: string;
      attestor_key_id: string;
      service_launcher_policy_sha256: string;
      service_launcher_binary_sha256: string;
      service_launcher_public_key_base64: string;
      service_launcher_public_key_sha256: string;
      service_launcher_key_id: string;
      receipt_signature_algorithm: "ed25519-v1";
      expected_database_instance_id: string;
    };
    roles: Record<
      "offline_paired" | "production_shadow" | "tool_e2e",
      {
        runner_principal_sha256: string;
        credential_session_class:
          | "eligible_host_adapter"
          | "formal_tool_eval"
          | "immutable_paired_eval";
        broker_policy_sha256: string;
        broker_binary_sha256: string;
        broker_public_key_base64: string;
        broker_public_key_sha256: string;
        broker_key_id: string;
        service_launcher_policy_sha256: string;
        service_launcher_binary_sha256: string;
        service_launcher_public_key_sha256: string;
        service_launcher_key_id: string;
        supervisor_executable_sha256: string;
        supervisor_argv_policy_sha256: string;
        supervisor_sandbox_policy_sha256: string;
        receipt_signature_algorithm: string;
        credential_scope_sha256: string;
        supervisor_bind_ttl_seconds: number;
        credential_session_hard_ttl_seconds: number;
        credential_session_heartbeat_seconds: number;
        credential_session_max_calls: number;
        per_call_capability_ttl_seconds: number;
        post_quiesce_finalize_ttl_seconds: number;
      }
    >;
  };
  required_external_inputs: Record<
    "offline_paired" | "production_shadow" | "tool_e2e",
    {
      immutable_input_manifest_sha256: string;
      retry_policy_sha256: string;
      planned_run_id: string;
    }
  >;
  collection_sources: Array<{
    principal_sha256: string;
    class: "eligible_host" | "fixture_pilot";
    collector_id: string;
    collector_version: string;
    verifier_policy_sha256: string;
    allowed_verifiers: Array<{
      kind: "instrumented_agent_trace" | "deterministic_scorer";
      version: string;
      config_sha256: string;
    }>;
  }>;
  safety_pause_mode: "automatic";
}
```

Compatibility rules:

The bounded canonical `external_execution_policy`, `required_external_inputs`,
and their digests are part of the experiment `config_sha256`; provisioning
resolves every broker key/policy
through the code registry and rejects unknown algorithms, roles, or caller
overrides.

- profile `mode: "shadow"`: permits `aa` or `shadow`, never `active_control`;
- profile `mode: "active"`: is only an authority ceiling; the immutable
  experiment `serving_phase` decides A/A, shadow, or randomized active/control;
- old `mode: "active"` without `experiment`: preserve fixed-active behavior,
  mark `non_randomized`, exclude it from causal promotion evidence;
- `aa`: assign both arms but serve recorded policy in both;
- `shadow`: compute both policy surfaces but serve recorded policy in both;
- `active_control`: serve candidate only in the assigned candidate arm;
- `aa` and `shadow` require `evidence_intent=integrity_only`;
- `active_control` requires `evidence_intent=confirmatory`;
- A/A and shadow exposures remain available for integrity/projection reports but
  set `promotion_eligible=false` for active outcome cohorts;
- an absent or unmatched collection source remains observable but is
  `promotion_eligible=false`; fixture pilots can exercise both serving arms but
  never enter confirmatory online evidence;
- every experiment revision preregisters automatic safety pause; promotion is
  separately adjudicated, but a gate-level pause never waits for approval;
- global-env active override: preserve explicit behavior but mark
  `fixed_active` and `promotion_eligible=false`; because current code gives this
  override precedence, it also prevents profile experiment enrollment;
- missing task family, task signature, operation ID, complete projection, or
  immutable config digest: serve control and record why enrollment failed.

The assignment cluster deliberately excludes `run_id`, query hash, and task
signature and repository signature. The exclusions are essential: every task
that can touch the same store memory namespace must stay in one arm, otherwise shared prior state
would create cross-arm interference inside the nominal statistical unit.

```ts
// canonicalStoreScope is the existing resolveTenantScope(...).scope_key used
// by Lite node/commit reads and writes, not the public request scope.
memoryNamespaceSha256 = sha256(canonicalStoreScope);
assignmentUnit = sha256(stableStringify({
  tenant_id,
  memory_namespace_sha256: memoryNamespaceSha256,
}));

if (evidenceIntent === "confirmatory" && collectionClass === "eligible_host") {
  // Provisioning has already frozen exactly two matched namespaces per block.
  // Pairs are sorted by pair hash. One independent unbiased CSPRNG bit per pair
  // selects which frozen member ordinal is candidate; the other is control.
  bit = assignmentRandomBits[canonicalPairOrdinal];
  arm = exactMatchedPairAssignment(bit, pairMemberOrdinal);
} else {
  // Integrity-only A/A/shadow and principal-isolated fixture diagnostics may
  // retain a deterministic 50/50 virtual arm; they never enter confirmatory
  // inference.
  arm = deterministicDiagnosticArm(
    diagnosticAssignmentSeed,
    assignmentNamespace,
    assignmentUnit,
  );
}
```

`repo_signature` and task signature remain mandatory provenance/breadth fields,
but neither can split one shared-state namespace into opposite arms.

Runtime obtains both randomness sources only from independent operating-system
CSPRNG draws;
UUIDs, timestamps, `Math.random`, caller input, modulo reduction, hash-rank
ties, seed redraw, and truncated digests are forbidden. Integrity-only and
fixture-diagnostic assignment uses the revision's separate 32 random bytes as a
concealed hash seed, including on an `active_control` revision.
Gate-policy v1 confirmatory assignment instead draws exactly 48 random bytes:
the 384 bits map without transformation to the 384 pairs sorted by canonical
pair hash, bit zero first and most-significant-bit first inside each byte. Thus
all `2^384` pair assignments have equal probability and no unused bit exists.
Both BLOBs and their SHA-256 digests are stored in the authority DB; raw randomness
is never returned to clients, guide receipts, logs, flight recorder, or eval
artifacts. Only their digests are externally visible. They are independent
allocation-concealment values, not authentication credentials. Authorized
database verification can replay assignments. All Agents, repositories, task
families, and task signatures sharing the same store memory namespace therefore
stay in one arm for an immutable revision,
while a host cannot predict an arm before committing a protected guide request.
Fixture traffic uses a principal-specific pilot namespace; exposing its arm
cannot reveal the confirmatory matched-pair assignment for the same memory-namespace cluster. Fixture
input is also forbidden from claiming a production host task ID/source-event
identity.
Phase, allocation, policy, assignment randomness, evidence intent, or gate-policy changes require
a new revision; confirmatory evidence is never pooled across revisions. Exactly
one revision may be registered as the confirmatory attempt for a given
`(tenant, task_family, candidate_policy_implementation_sha256)`. The human-
readable candidate ID/version remains bound metadata, but an alias with the
same implementation-contract digest cannot create another attempt. Once that
append-only registration exists, no allocation, alias, or revision change can
reset its alpha budget; another confirmatory attempt requires a materially
different implementation-contract digest. Earlier A/A or shadow revisions are integrity evidence only,
even if their descriptive outcomes look favorable. V1 deliberately does not
support 10% -> 25% -> 50% active ramp revisions. Gate-policy v1 confirmatory
collection is exactly 50/50 by matched pair: choose one bounded profile and the
complete pair/wave schedule before outcomes, then keep it fixed for the whole
confirmatory attempt. Lower candidate exposure belongs in shadow and fixture
pilots; it does not weaken or silently change the confirmatory design.

The profile rule supplies revision identity, allocation, policy versions, and
the four preregistered series IDs, but it cannot supply either raw assignment
randomness or a claimed randomness digest. Runtime draws it while atomically creating the
authority row through an explicit protected provisioning command before any
guide traffic, freezes one candidate and one control member in every reviewed
pair, and compares every later ensure against the stored revision. There is no
randomness rejection/redraw based on realized arm counts: exact-count assignment is
guaranteed structurally by one bit per pair. A
guide never races to invent randomness: an unprovisioned or mismatched revision
serves control. Provisioning emits an applicability manifest containing IDs and
digests, a bounded canonical profile-rule projection, and the sorted hashed
pair/wave membership needed to reproduce applicability and disjointness, but
not raw store scopes, assigned arms, or raw randomness. Until all prerequisite roots pass, eligible-host
serving remains fail-control even though fixture plumbing can be tested.

The canonical applicability manifest is itself bounded evidence input. It
contains the experiment/task/policy/source IDs and digests; a secret-scanned
canonical projection of the matched profile rule; and, for confirmatory
revisions, a sorted `memory_namespace_sha256` membership plus pair hash,
pair-member ordinal, matching-covariate digest, activation wave/times, lease
generation, and the set/pair/schedule digests. It omits raw API keys, raw store
scope strings, assignment randomness/bits, and assigned arms. Recomputing the
manifest from the authority DB must produce identical bytes. A run bundle that
contains only the final set digest/count without this hashed membership cannot
prove applicability or pilot disjointness and is rejected.

### 6.4 Canonical task and scope identity

Current guide input can describe task identity in `context`,
`execution_packet_v1`, and `execution_state_v1`; eligible collection adds the
host task envelope. Runtime first normalizes every supplied source into one
`CanonicalLearningTaskIdentityV1`. Any disagreement in task family, task
signature, repository signature, or host task identity fails enrollment and
serves control; no precedence rule silently chooses one source. Profile
selection, assignment, episode facts, receipt validation, cohort construction,
and eval export consume only this resolved object.

The resolver also keeps the two existing scope domains explicit:

```ts
type PublicScope = string & { readonly __kind: "public_scope" };
type StoreScope = string & { readonly __kind: "store_scope" };

type CanonicalLearningTaskIdentityV1 = {
  tenant_id: string;
  public_scope: PublicScope;
  store_scope: StoreScope;
  task_family: string;
  task_signature: string;
  repository_signature: string;
  host_task_id: string | null;
  source_task_sha256: string | null;
  source_event_sha256: string | null;
};
```

Guide receipts, write-operation receipts, episodes, feedback joins, and gate
scope membership always use `public_scope`. Only node/commit storage and lookup
use `store_scope`, whose exact value is the existing
`resolveTenantScope(...).scope_key`. Branded internal types and cross-tenant fixtures prevent an
accidental join between the two representations.

### 6.5 Trusted host collection boundary

`eligible_host` is a provisioned trust boundary, not an inference from payload
shape. Its API-key/JWT principal is issued only to a named, reviewed production
host adapter whose `collector_id` and `collector_version` are frozen in the
experiment source policy. Evaluation runners use a different `fixture_pilot`
principal. Reusing the same subject for both classes, or using the eligible
credential from an unreviewed adapter, is a source-integrity incident that
atomically pauses the task-family candidate implementation resolved from the
registered ID/version.

Before assignment, an eligible adapter supplies a strict
`host_task_envelope_v1` inside the protected guide request. It binds the host's
stable task ID, repository signature, task family/signature, collector
identity/version, and a source-event digest. Runtime validates it against the
authenticated source policy and includes it in the request/operation digest.
The hidden allocation seed prevents the adapter from predicting the arm before
this task identity is durably committed. Every eligible guide exposure enters
assignment/coverage accounting whether or not the host later submits feedback,
so abandoning an unwanted arm appears as missingness and cannot be silently
dropped.

Runtime cannot prove from syntax alone that a task came from production; the
reviewed adapter and credential provisioning are the explicit trust boundary.
If no real host adapter implements the task-envelope and use-receipt contracts,
the online evidence verdict is `hold`. This limitation is reported, not hidden
behind a synthetic fixture.

That boundary is an operating-system/service identity boundary, not an argv
convention. The eligible-host adapter runs as a dedicated service account (or
equivalent workload identity) and receives its Runtime credential directly from
the deployment secret manager. The eval/harness identity cannot read the secret
object, credential file, process environment, adapter control socket, or invoke
the eligible principal; it receives only a sanitized, content-addressed output
directory after the adapter closes it. Acceptance must prove the positive path
under the adapter identity and negative read/invoke paths under the eval
identity, then archive an attestation binding the deployed adapter image/binary
digest, service-account ID, secret-manager policy version, and frozen
collector/verifier configuration. Running both under one Unix user with a caller-readable env file is
promotion-ineligible even if the secret is omitted from the eval command line.
Every archived bundle is secret-scanned; detection is an incident and automatic
pause, not a redaction-and-continue path.

## 7. SQLite v3 data model

### 7.0 Runtime authority identity

The v3 migration creates one immutable database-lineage identity before any
learning write. Backups/restores preserve it; a newly provisioned authority DB
receives a new independent 32-byte lowercase-hex CSPRNG identity.

```sql
CREATE TABLE lite_runtime_authority_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  database_instance_id TEXT NOT NULL UNIQUE CHECK (
    length(database_instance_id) = 64
    AND database_instance_id NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL
);

CREATE TRIGGER lite_runtime_authority_identity_no_update
BEFORE UPDATE ON lite_runtime_authority_identity
BEGIN
  SELECT RAISE(ABORT, 'lite_runtime_authority_identity is append-only');
END;

CREATE TRIGGER lite_runtime_authority_identity_no_delete
BEFORE DELETE ON lite_runtime_authority_identity
BEGIN
  SELECT RAISE(ABORT, 'lite_runtime_authority_identity is append-only');
END;
```

The deployment-owned Runtime authority attestor has a distinct service
identity and signing key unavailable to acceptance, eval, broker, and host
identities. Its launcher supplies the configured live DB as an inherited
read-only descriptor. Before that handoff the launcher acquires the deployment
slot's exclusive attestation lease, proves all writers quiescent, checkpoints
and truncates WAL, binds device/inode/checkpoint generation and main-file
digest, opens the descriptor, and holds the lease through signature. It rejects
a caller-selected path, copied DB, unresolved WAL, failed full verifier, or
database identity that does not match the signed launcher policy. The active
experiment revision freezes the attestor service,
launcher, binary, policy, exact canonical 32-byte Ed25519 public keys plus their
digests/key IDs, signature algorithm, and expected
database-lineage identity inside `external_execution_policy_json`. This signer
attests only bounded authority projections; it never signs a caller-provided
digest without independently reading and verifying the rows.

### 7.1 `lite_learning_policy_versions`

Candidate and gate policy identity must mean the same configuration across
every experiment revision. A version string alone is not authority.

```sql
CREATE TABLE lite_learning_policy_versions (
  tenant_id TEXT NOT NULL,
  policy_kind TEXT NOT NULL CHECK (policy_kind IN ('candidate', 'gate')),
  policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  policy_config_sha256 TEXT NOT NULL CHECK (
    length(policy_config_sha256) = 64
    AND policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  policy_config_json TEXT NOT NULL CHECK (json_valid(policy_config_json)),
  implementation_contract_sha256 TEXT NOT NULL CHECK (
    length(implementation_contract_sha256) = 64
    AND implementation_contract_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  prospective_calibration_sha256 TEXT CHECK (
    prospective_calibration_sha256 IS NULL OR (
      length(prospective_calibration_sha256) = 64
      AND prospective_calibration_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  prospective_calibration_json TEXT CHECK (
    prospective_calibration_json IS NULL OR (
      json_valid(prospective_calibration_json)
      AND length(CAST(prospective_calibration_json AS BLOB)) <= 524288
    )
  ),
  created_at TEXT NOT NULL,
  CHECK (
    (policy_kind = 'candidate'
      AND prospective_calibration_sha256 IS NULL
      AND prospective_calibration_json IS NULL)
    OR (policy_kind = 'gate'
      AND prospective_calibration_sha256 IS NOT NULL
      AND prospective_calibration_json IS NOT NULL
      AND COALESCE(
        json_extract(prospective_calibration_json, '$.status'), ''
      ) = 'passed')
  ),
  PRIMARY KEY (tenant_id, policy_kind, policy_id, policy_version)
);
```

Re-inserting the same ID/version compares the canonical configuration and
prospective-calibration digests; any configuration, calibration, or
implementation-contract mismatch is an integrity error. A
`calibration_pending` gate exists only as a non-enrollable code-registry draft;
no gate row is persisted until its bounded artifact passes and is embedded in
the insert. The calibration JSON is the canonical secret-free report with raw
scenario counts and all source digests, not a mutable path. Its SHA is included
in the gate configuration. To avoid a circular hash, the
`implementation_contract_sha256` is the preregistration inference-engine/
golden-vector contract and is an input to the calibration artifact; it excludes
the artifact SHA itself.
The Runtime code registry contains the exact supported candidate and gate
definitions. Candidate rules are one canonical declarative definition consumed
by both online projection and the offline evaluator; the behavior-vector digest
is `implementation_contract_sha256`. Profile rules may name only a registered
ID/version and cannot supply replacement behavior. Unknown IDs, version/config
drift, or an online/offline golden-vector mismatch fail enrollment. Experiment
revisions and external evidence resolve both policies through this registry, so
a new allocation, alias, or phase cannot silently redefine or bypass a
candidate implementation that is under safety quarantine.

The first gate registry tuple is exactly
`gate_policy_id="gate-policy"`, `gate_policy_version="v1"`; its human-readable
registry key is `gate-policy-v1`. No `learning-gate-v1` alias is accepted in
profiles, artifacts, approvals, or CLI input.

### 7.2 `lite_learning_collection_principal_bindings`

Collection class is normalized authority, not only opaque JSON inside each
revision.

```sql
CREATE TABLE lite_learning_collection_principal_bindings (
  tenant_id TEXT NOT NULL,
  collection_principal_sha256 TEXT NOT NULL CHECK (
    length(collection_principal_sha256) = 64
    AND collection_principal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  collection_class TEXT NOT NULL CHECK (collection_class IN (
    'eligible_host', 'fixture_pilot'
  )),
  collector_id TEXT NOT NULL,
  collector_version TEXT NOT NULL,
  verifier_policy_sha256 TEXT NOT NULL CHECK (
    length(verifier_policy_sha256) = 64
    AND verifier_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  verifier_policy_json TEXT NOT NULL CHECK (json_valid(verifier_policy_json)),
  binding_sha256 TEXT NOT NULL CHECK (
    length(binding_sha256) = 64
    AND binding_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, collection_principal_sha256)
);
```

The first protected provisioning fixes one principal subject to one class,
collector build, and verifier allowlist for that tenant. Credential rotation
that preserves the subject preserves this binding; changing class, collector
build, or verifier policy requires a new principal identity. Every experiment
source-policy member resolves this table and repeats its digest in the revision
configuration. A remap attempt is a source-integrity incident; if any matching
candidate implementation has been enrolled, the protected provisioning operation
commits a candidate-implementation safety pause and returns conflict instead of
silently creating a new mapping. Strict host receipts must use an allowed
verifier kind/version/config digest from this frozen policy.

### 7.3 `lite_learning_experiment_revisions`

Immutable snapshot of the matched profile and experiment configuration.

```sql
CREATE TABLE lite_learning_experiment_revisions (
  tenant_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  experiment_revision INTEGER NOT NULL CHECK (experiment_revision >= 1),
  profile_id TEXT NOT NULL,
  profile_rule_sha256 TEXT NOT NULL CHECK (
    length(profile_rule_sha256) = 64
    AND profile_rule_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  serving_phase TEXT NOT NULL CHECK (serving_phase IN (
    'aa', 'shadow', 'active_control'
  )),
  evidence_intent TEXT NOT NULL CHECK (evidence_intent IN (
    'integrity_only', 'confirmatory'
  )),
  eligible_memory_namespace_set_sha256 TEXT CHECK (
    eligible_memory_namespace_set_sha256 IS NULL OR (
      length(eligible_memory_namespace_set_sha256) = 64
      AND eligible_memory_namespace_set_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  eligible_memory_namespace_count INTEGER CHECK (
    eligible_memory_namespace_count IS NULL
    OR eligible_memory_namespace_count = 768
  ),
  assignment_design TEXT NOT NULL CHECK (assignment_design IN (
    'diagnostic_hash_v1', 'matched_pair_complete_randomization_v1'
  )),
  randomization_pair_manifest_sha256 TEXT CHECK (
    randomization_pair_manifest_sha256 IS NULL OR (
      length(randomization_pair_manifest_sha256) = 64
      AND randomization_pair_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  randomization_pair_count INTEGER CHECK (
    randomization_pair_count IS NULL OR randomization_pair_count = 384
  ),
  activation_schedule_sha256 TEXT CHECK (
    activation_schedule_sha256 IS NULL OR (
      length(activation_schedule_sha256) = 64
      AND activation_schedule_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  candidate_policy_id TEXT NOT NULL,
  candidate_policy_version TEXT NOT NULL,
  candidate_policy_implementation_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_implementation_sha256) = 64
    AND candidate_policy_implementation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_policy_config_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_config_sha256) = 64
    AND candidate_policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  assignment_unit_kind TEXT NOT NULL CHECK (
    assignment_unit_kind = 'store_memory_namespace_cluster'
  ),
  candidate_allocation_bps INTEGER NOT NULL
    CHECK (candidate_allocation_bps BETWEEN 1000 AND 9000),
  diagnostic_assignment_seed BLOB NOT NULL CHECK (
    length(diagnostic_assignment_seed) = 32
  ),
  diagnostic_assignment_seed_sha256 TEXT NOT NULL CHECK (
    length(diagnostic_assignment_seed_sha256) = 64
    AND diagnostic_assignment_seed_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  confirmatory_assignment_bits BLOB,
  confirmatory_assignment_bit_count INTEGER CHECK (
    confirmatory_assignment_bit_count IS NULL
    OR confirmatory_assignment_bit_count >= 1
  ),
  confirmatory_assignment_bits_sha256 TEXT CHECK (
    confirmatory_assignment_bits_sha256 IS NULL OR (
      length(confirmatory_assignment_bits_sha256) = 64
      AND confirmatory_assignment_bits_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  collection_source_policy_sha256 TEXT NOT NULL CHECK (
    length(collection_source_policy_sha256) = 64
    AND collection_source_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  collection_source_policy_json TEXT NOT NULL CHECK (
    json_valid(collection_source_policy_json)
  ),
  gate_policy_id TEXT NOT NULL,
  gate_policy_version TEXT NOT NULL,
  gate_policy_config_sha256 TEXT NOT NULL CHECK (
    length(gate_policy_config_sha256) = 64
    AND gate_policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  gate_prospective_calibration_sha256 TEXT NOT NULL CHECK (
    length(gate_prospective_calibration_sha256) = 64
    AND gate_prospective_calibration_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  required_evidence_series_sha256 TEXT NOT NULL CHECK (
    length(required_evidence_series_sha256) = 64
    AND required_evidence_series_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  required_evidence_series_json TEXT NOT NULL CHECK (
    json_valid(required_evidence_series_json)
  ),
  required_external_inputs_sha256 TEXT NOT NULL CHECK (
    length(required_external_inputs_sha256) = 64
    AND required_external_inputs_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  required_external_inputs_json TEXT NOT NULL CHECK (
    json_valid(required_external_inputs_json)
    AND length(CAST(required_external_inputs_json AS BLOB)) <= 16384
  ),
  external_execution_policy_sha256 TEXT NOT NULL CHECK (
    length(external_execution_policy_sha256) = 64
    AND external_execution_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  external_execution_policy_json TEXT NOT NULL CHECK (
    json_valid(external_execution_policy_json)
    AND length(CAST(external_execution_policy_json AS BLOB)) <= 16384
  ),
  safety_pause_mode TEXT NOT NULL CHECK (safety_pause_mode = 'automatic'),
  config_sha256 TEXT NOT NULL CHECK (
    length(config_sha256) = 64 AND config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  created_at TEXT NOT NULL,
  CHECK (
    (serving_phase IN ('aa', 'shadow')
      AND evidence_intent = 'integrity_only'
      AND eligible_memory_namespace_set_sha256 IS NULL
      AND eligible_memory_namespace_count IS NULL
      AND assignment_design = 'diagnostic_hash_v1'
      AND randomization_pair_manifest_sha256 IS NULL
      AND randomization_pair_count IS NULL
      AND activation_schedule_sha256 IS NULL
      AND confirmatory_assignment_bits IS NULL
      AND confirmatory_assignment_bit_count IS NULL
      AND confirmatory_assignment_bits_sha256 IS NULL)
    OR (serving_phase = 'active_control'
      AND evidence_intent = 'confirmatory'
      AND eligible_memory_namespace_set_sha256 IS NOT NULL
      AND eligible_memory_namespace_count IS NOT NULL
      AND assignment_design = 'matched_pair_complete_randomization_v1'
      AND randomization_pair_manifest_sha256 IS NOT NULL
      AND randomization_pair_count IS NOT NULL
      AND activation_schedule_sha256 IS NOT NULL
      AND candidate_allocation_bps = 5000
      AND confirmatory_assignment_bits IS NOT NULL
      AND confirmatory_assignment_bit_count = randomization_pair_count
      AND confirmatory_assignment_bits_sha256 IS NOT NULL
      AND length(confirmatory_assignment_bits) =
        CAST((randomization_pair_count + 7) / 8 AS INTEGER))
  ),
  PRIMARY KEY (tenant_id, experiment_id, experiment_revision)
);
```

The insert path compares `config_sha256` when the primary key already exists.
The same experiment revision with a different digest is an integrity error, not
an update. `diagnostic_assignment_seed` is an independent 32-byte CSPRNG draw
for every revision, including `active_control`; it is the sole authority source
for A/A, shadow, and principal-isolated fixture virtual arms. The separate
48-byte `confirmatory_assignment_bits` exists only for the 384-pair
confirmatory design. Neither value is derived from the other. Golden vectors
and leakage tests prove that fixture/diagnostic arms reveal no confirmatory bit.
`external_execution_policy_json` is a registry-derived, outcome-blind mapping
from each required external role/session class to the exact runner principal,
credential-broker and service-launcher policy/public-key/binary digests and key
IDs, supervisor executable/argv/sandbox policy digests, receipt signature
algorithm, allowed credential scope, bounded supervisor-bind TTL,
non-extendable session hard TTL, heartbeat interval, maximum provider-call
count, and per-call capability TTL
(at most 60 seconds), plus a bounded post-quiesce finalization TTL. It also
freezes the Runtime authority-attestor service/launcher/binary/policy/public-
key/key-ID/signature digests and the expected live database-lineage identity.
`reserve-external` accepts no
caller-selected trust root: it re-derives these fields from this frozen mapping,
and claim/ingest cryptographically verify the signed broker conformance receipt.
For a confirmatory revision, `required_external_inputs_json` contains exactly
the three immutable input/retry/run identities and is frozen at provisioning
before any external outcome. Each later reservation must byte-match its role;
an operator cannot choose a new model, holdout, order, tool set, or retry policy
after seeing another prerequisite. Integrity-only revisions use the canonical
empty external-input mapping. `gate_prospective_calibration_sha256` must equal
the embedded registered gate-policy artifact; it is part of `config_sha256`, so
no revision can substitute or drop calibration after provisioning.

#### 7.3.1 `lite_learning_confirmatory_attempts`

The alpha budget belongs to a candidate implementation contract and task
family, not to every version alias or rollout revision. A protected
provisioning operation inserts exactly one
confirmatory-attempt row before that revision receives eligible-host traffic.

```sql
CREATE TABLE lite_learning_confirmatory_attempts (
  tenant_id TEXT NOT NULL,
  confirmatory_attempt_id TEXT NOT NULL,
  task_family TEXT NOT NULL,
  candidate_policy_id TEXT NOT NULL,
  candidate_policy_version TEXT NOT NULL,
  candidate_policy_implementation_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_implementation_sha256) = 64
    AND candidate_policy_implementation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  experiment_id TEXT NOT NULL,
  experiment_revision INTEGER NOT NULL CHECK (experiment_revision >= 1),
  gate_policy_id TEXT NOT NULL,
  gate_policy_version TEXT NOT NULL,
  gate_policy_config_sha256 TEXT NOT NULL CHECK (
    length(gate_policy_config_sha256) = 64
    AND gate_policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  eligible_memory_namespace_set_sha256 TEXT NOT NULL CHECK (
    length(eligible_memory_namespace_set_sha256) = 64
    AND eligible_memory_namespace_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  eligible_memory_namespace_count INTEGER NOT NULL CHECK (
    eligible_memory_namespace_count = 768
  ),
  planned_candidate_namespace_count INTEGER NOT NULL CHECK (
    planned_candidate_namespace_count = 384
  ),
  planned_control_namespace_count INTEGER NOT NULL CHECK (
    planned_control_namespace_count = 384
  ),
  randomization_pair_manifest_sha256 TEXT NOT NULL CHECK (
    length(randomization_pair_manifest_sha256) = 64
    AND randomization_pair_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  randomization_pair_count INTEGER NOT NULL CHECK (
    randomization_pair_count = 384
  ),
  activation_schedule_sha256 TEXT NOT NULL CHECK (
    length(activation_schedule_sha256) = 64
    AND activation_schedule_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  attempt_sha256 TEXT NOT NULL CHECK (
    length(attempt_sha256) = 64
    AND attempt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, confirmatory_attempt_id),
  UNIQUE (
    tenant_id, task_family, candidate_policy_id, candidate_policy_version
  ),
  UNIQUE (
    tenant_id, task_family, candidate_policy_implementation_sha256
  ),
  UNIQUE (
    tenant_id, experiment_id, experiment_revision
  )
);
```

Insertion verifies that the referenced immutable revision has
`evidence_intent=confirmatory`, is bound to exactly the supplied task family by
the provisioned profile applicability, and has the exact candidate/gate
configuration and registry-resolved implementation-contract digest. An alias
ID/version with the same implementation digest cannot buy another attempt. The
revision and attempt row are inserted atomically; if the
revision was provisioned earlier, registration is allowed only after proving it
has zero episode exposures. Guide enrollment for a confirmatory revision
without its exact attempt row serves control and stores
`promotion_eligible=false`.
Confirmatory provisioning accepts no dynamic or wildcard selector. It resolves
the reviewed finite namespace manifest and atomically acquires the exact lease
set defined below; an existing active lease makes the whole operation fail.
Runtime rechecks the resolved canonical store namespace and exact active lease
inside guide persistence, so two simultaneous experiments cannot assign one
shared memory namespace independently.
`status`, `propose-look`, `reserve-look`, and `evaluate` reject any revision
without this row.

#### 7.3.2 `lite_learning_randomization_pairs`

The pair manifest is authority data, not only a digest in an external file.
Persisting its bounded pre-treatment projection lets Runtime regenerate the
applicability manifest and prove that matching/wave fields were not changed
after outcomes.

```sql
CREATE TABLE lite_learning_randomization_pairs (
  tenant_id TEXT NOT NULL,
  confirmatory_attempt_id TEXT NOT NULL,
  randomization_pair_sha256 TEXT NOT NULL CHECK (
    length(randomization_pair_sha256) = 64
    AND randomization_pair_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  pair_ordinal INTEGER NOT NULL CHECK (pair_ordinal BETWEEN 0 AND 383),
  member_0_memory_namespace_sha256 TEXT NOT NULL CHECK (
    length(member_0_memory_namespace_sha256) = 64
    AND member_0_memory_namespace_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  member_1_memory_namespace_sha256 TEXT NOT NULL CHECK (
    length(member_1_memory_namespace_sha256) = 64
    AND member_1_memory_namespace_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  matching_covariate_sha256 TEXT NOT NULL CHECK (
    length(matching_covariate_sha256) = 64
    AND matching_covariate_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  matching_covariate_json TEXT NOT NULL CHECK (
    json_valid(matching_covariate_json)
    AND length(CAST(matching_covariate_json AS BLOB)) <= 4096
  ),
  activation_wave_index INTEGER NOT NULL CHECK (
    activation_wave_index IN (1, 2, 3)
  ),
  activation_starts_at TEXT NOT NULL,
  index_window_ends_at TEXT NOT NULL,
  wave_analysis_at TEXT NOT NULL,
  pair_record_sha256 TEXT NOT NULL CHECK (
    length(pair_record_sha256) = 64
    AND pair_record_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  CHECK (
    member_0_memory_namespace_sha256 <> member_1_memory_namespace_sha256
  ),
  PRIMARY KEY (
    tenant_id, confirmatory_attempt_id, randomization_pair_sha256
  ),
  UNIQUE (tenant_id, confirmatory_attempt_id, pair_ordinal),
  UNIQUE (
    tenant_id, confirmatory_attempt_id, member_0_memory_namespace_sha256
  ),
  UNIQUE (
    tenant_id, confirmatory_attempt_id, member_1_memory_namespace_sha256
  )
);

CREATE TRIGGER trg_lite_learning_randomization_pair_update
BEFORE UPDATE ON lite_learning_randomization_pairs
BEGIN
  SELECT RAISE(ABORT, 'learning_randomization_pair_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_randomization_pair_delete
BEFORE DELETE ON lite_learning_randomization_pairs
BEGIN
  SELECT RAISE(ABORT, 'learning_randomization_pair_delete_forbidden');
END;
```

`pair_ordinal` is the position after sorting `randomization_pair_sha256`; the
same ordinal selects the persisted assignment bit. The canonical matching JSON
contains only reviewed pre-treatment categories and their versioned source
digests, never outcomes or secrets. Provisioning verifies exactly 384 rows,
wave counts 96/96/192, distinct membership across both member columns, canonical
UTC timing, and exact pair-manifest/schedule digests in the same transaction as
the attempt and leases. Direct-SQL cross-column duplication or digest/timing
drift is corruption even where a single SQLite `UNIQUE` cannot express it.

#### 7.3.3 `lite_learning_namespace_leases`

Confirmatory randomization requires a finite, server-resolved set of canonical
store memory namespaces. Namespace leases are operational exclusion authority,
not statistical evidence, so they use a one-way mutable lifecycle like the
learning-control queue while all attempt/evidence rows remain append-only.

```sql
CREATE TABLE lite_learning_namespace_leases (
  tenant_id TEXT NOT NULL,
  namespace_lease_id TEXT NOT NULL,
  memory_namespace_sha256 TEXT NOT NULL CHECK (
    length(memory_namespace_sha256) = 64
    AND memory_namespace_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  randomization_pair_sha256 TEXT NOT NULL CHECK (
    length(randomization_pair_sha256) = 64
    AND randomization_pair_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  pair_member_ordinal INTEGER NOT NULL CHECK (pair_member_ordinal IN (0, 1)),
  assigned_arm TEXT NOT NULL CHECK (assigned_arm IN ('candidate', 'control')),
  activation_wave_index INTEGER NOT NULL CHECK (
    activation_wave_index IN (1, 2, 3)
  ),
  activation_starts_at TEXT NOT NULL,
  index_window_ends_at TEXT NOT NULL,
  wave_analysis_at TEXT NOT NULL,
  lease_generation INTEGER NOT NULL CHECK (lease_generation >= 1),
  confirmatory_attempt_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  experiment_revision INTEGER NOT NULL CHECK (experiment_revision >= 1),
  namespace_set_sha256 TEXT NOT NULL CHECK (
    length(namespace_set_sha256) = 64
    AND namespace_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  acquire_operation_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released')),
  release_operation_id TEXT,
  release_ref_kind TEXT CHECK (
    release_ref_kind IS NULL OR release_ref_kind IN (
      'experiment_close', 'terminal_authority_adjudication'
    )
  ),
  release_ref_id TEXT,
  released_at TEXT,
  CHECK (
    (status = 'active'
      AND release_operation_id IS NULL
      AND release_ref_kind IS NULL
      AND release_ref_id IS NULL
      AND released_at IS NULL)
    OR (status = 'released'
      AND release_operation_id IS NOT NULL
      AND release_ref_kind IS NOT NULL
      AND release_ref_id IS NOT NULL
      AND released_at IS NOT NULL)
  ),
  PRIMARY KEY (tenant_id, namespace_lease_id),
  UNIQUE (tenant_id, memory_namespace_sha256, lease_generation),
  UNIQUE (tenant_id, confirmatory_attempt_id, memory_namespace_sha256),
  UNIQUE (
    tenant_id, confirmatory_attempt_id,
    randomization_pair_sha256, pair_member_ordinal
  ),
  UNIQUE (
    tenant_id, confirmatory_attempt_id,
    randomization_pair_sha256, assigned_arm
  ),
  UNIQUE (tenant_id, acquire_operation_id, memory_namespace_sha256),
  UNIQUE (tenant_id, release_operation_id, memory_namespace_sha256)
);

CREATE UNIQUE INDEX idx_lite_learning_namespace_one_active_lease
  ON lite_learning_namespace_leases(tenant_id, memory_namespace_sha256)
  WHERE status = 'active';

CREATE TRIGGER trg_lite_learning_namespace_lease_pair_binding
BEFORE INSERT ON lite_learning_namespace_leases
WHEN NOT EXISTS (
  SELECT 1 FROM lite_learning_randomization_pairs AS pair_row
  WHERE pair_row.tenant_id = NEW.tenant_id
    AND pair_row.confirmatory_attempt_id = NEW.confirmatory_attempt_id
    AND pair_row.randomization_pair_sha256 = NEW.randomization_pair_sha256
    AND pair_row.activation_wave_index = NEW.activation_wave_index
    AND pair_row.activation_starts_at = NEW.activation_starts_at
    AND pair_row.index_window_ends_at = NEW.index_window_ends_at
    AND pair_row.wave_analysis_at = NEW.wave_analysis_at
    AND (
      (NEW.pair_member_ordinal = 0
        AND pair_row.member_0_memory_namespace_sha256 =
          NEW.memory_namespace_sha256)
      OR (NEW.pair_member_ordinal = 1
        AND pair_row.member_1_memory_namespace_sha256 =
          NEW.memory_namespace_sha256)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'learning_namespace_lease_pair_binding_required');
END;

CREATE TRIGGER trg_lite_learning_namespace_lease_update
BEFORE UPDATE ON lite_learning_namespace_leases
WHEN NOT (
  OLD.status = 'active' AND NEW.status = 'released'
  AND OLD.tenant_id IS NEW.tenant_id
  AND OLD.namespace_lease_id IS NEW.namespace_lease_id
  AND OLD.memory_namespace_sha256 IS NEW.memory_namespace_sha256
  AND OLD.randomization_pair_sha256 IS NEW.randomization_pair_sha256
  AND OLD.pair_member_ordinal IS NEW.pair_member_ordinal
  AND OLD.assigned_arm IS NEW.assigned_arm
  AND OLD.activation_wave_index IS NEW.activation_wave_index
  AND OLD.activation_starts_at IS NEW.activation_starts_at
  AND OLD.index_window_ends_at IS NEW.index_window_ends_at
  AND OLD.wave_analysis_at IS NEW.wave_analysis_at
  AND OLD.lease_generation IS NEW.lease_generation
  AND OLD.confirmatory_attempt_id IS NEW.confirmatory_attempt_id
  AND OLD.experiment_id IS NEW.experiment_id
  AND OLD.experiment_revision IS NEW.experiment_revision
  AND OLD.namespace_set_sha256 IS NEW.namespace_set_sha256
  AND OLD.acquire_operation_id IS NEW.acquire_operation_id
  AND OLD.acquired_at IS NEW.acquired_at
  AND NEW.release_operation_id IS NOT NULL
  AND NEW.release_ref_kind IS NOT NULL
  AND NEW.release_ref_id IS NOT NULL
  AND NEW.released_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'learning_namespace_lease_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_namespace_lease_delete
BEFORE DELETE ON lite_learning_namespace_leases
BEGIN
  SELECT RAISE(ABORT, 'learning_namespace_lease_delete_forbidden');
END;
```

The confirmatory provisioning command requires a reviewed finite matched-pair
manifest; wildcard/dynamic scope selection is promotion-ineligible. Each pair
contains exactly two distinct canonical store scopes matched on pre-treatment
host adapter, provider/model route, region, workload stratum, and activation
wave. Gate-policy v1 preregisters 384 pairs in waves of 96, 96, and 192. Inside
one `BEGIN IMMEDIATE`, Runtime resolves all 768 scopes, rejects duplicates or an
existing active lease, draws exactly 384 unbiased hidden bits, maps one bit to
each canonical pair, and assigns exactly one candidate and one control. It never
rejects or redraws randomness based on arm counts. The transaction atomically inserts the
revision, attempt, and complete lease set. The attempt/revision namespace-set,
pair-manifest, activation-schedule digests and counts must equal the sorted
lease projection exactly.

The same transaction scans historical episode/source aliases and current
memory lineage for each proposed namespace. Any state attributable to A/A,
fixture, unverified, or another experiment—including a source-task,
source-event, assignment, node, or commit linked to those classes—rejects the
complete confirmatory set. Legitimate pre-treatment production nodes/commits
are allowed: their bounded snapshot and prior-count covariates are frozen in
the matching record before randomization, and later drift is an integrity
failure. A namespace cannot be “clean” merely because no lease existed when
fixture learning occurred. The acceptance isolation audit is defense in depth;
provisioning performs this authority-DB lineage check again while holding the
write lock.

Every wave has a frozen activation start, index-window end, and analysis time.
Both pair members activate together. At `wave_analysis_at`, a member with no
eligible index exposure or no verified 24-hour outcome is present as missing,
not silently replaced by a later namespace. Cumulative looks therefore contain
the first 96, 192, and 384 complete preregistered pairs even under zero traffic;
missingness can force `hold` but cannot make a look mathematically unreachable
or select a favorable post-assignment subset. Extra namespaces may be operated
as promotion-ineligible diagnostics, but cannot replace or enlarge the sole
confirmatory set after outcomes.
All three times are strict fixed-width canonical UTC timestamps emitted by the
server; offsets, fractional-width variants, caller time, and non-monotone
`start < window_end < analysis_at` schedules are rejected before insert. This
makes the event trigger's textual time comparison equivalent to instant order.

Guide rechecks the exact active lease inside its write transaction before an
eligible-host exposure. An eligible-host namespace absent from the set serves
control. A fixture pilot may exercise both arms only in its principal-specific
assignment namespace on a store scope outside the production set and every
active lease, and always remains promotion-ineligible. Fixture
candidate/feedback traffic on an actively leased namespace is forbidden; any
such persisted event or cross-namespace memory/source alias is an interference
finding and automatic pause. Evaluation pilots therefore run on a cloned DB or
disjoint store scopes, never the live confirmatory namespace set.

Leases are released together only by a signed protected
`learning_experiment_close_v1` operation or atomically with a terminal signed
promotion/demotion/retirement adjudication. The release transaction updates
every set member with one resolvable ref kind/ID; arbitrary text, partial
release, and mixed refs fail verification. Release seals the experiment's
eligible evidence at the transaction's event head. Feedback that arrives later
remains attributable and safety-relevant but is diagnostic for that closed
attempt and cannot reopen a look. `status` reports `closed`; `propose-look`,
`reserve-look`, `evaluate`, and any new eligible-host exposure fail closed after
the closure/terminal release. A later materially different implementation
may acquire the namespace at `max(lease_generation)+1`; an alias of the spent
implementation cannot.

SQLite's per-row trigger above deliberately enforces only immutable acquisition
fields, the `active -> released` direction, and no delete. It cannot by itself
prove a multi-row complete-set transition, resolve an authority ref, or enforce
`max(lease_generation)+1`. The only supported mutation interface is the
protected lease store method inside `BEGIN IMMEDIATE`; it resolves the signed
closure/adjudication, updates the full set with one ref, and checks the next
generation before insert. Reopen/preflight verification recomputes those
cross-row invariants. Direct SQL that creates a partial release, unresolved ref,
mixed ref, pair imbalance, or generation gap is structural corruption; active
serving, backup, close, and adjudication fail closed until restored from a
verified authority copy.

#### 7.3.4 `lite_learning_experiment_closures`

An operator may stop a confirmatory experiment without fabricating a gate
verdict. Close authority is therefore a separate append-only object rather
than an unsupported gate-decision action.

```sql
CREATE TABLE lite_learning_experiment_closures (
  tenant_id TEXT NOT NULL,
  experiment_close_id TEXT NOT NULL,
  confirmatory_attempt_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  experiment_revision INTEGER NOT NULL CHECK (experiment_revision >= 1),
  namespace_set_sha256 TEXT NOT NULL CHECK (
    length(namespace_set_sha256) = 64
    AND namespace_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  sealed_event_head_row_id INTEGER NOT NULL CHECK (
    sealed_event_head_row_id >= 0
  ),
  close_reason TEXT NOT NULL CHECK (close_reason IN (
    'operator_stop', 'safety_abort', 'rollout_expired', 'evidence_complete'
  )),
  authorization_sha256 TEXT NOT NULL CHECK (
    length(authorization_sha256) = 64
    AND authorization_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  authorization_payload_json TEXT NOT NULL CHECK (
    json_valid(authorization_payload_json)
    AND length(CAST(authorization_payload_json AS BLOB)) <= 65536
  ),
  authorization_mac TEXT NOT NULL,
  authorization_nonce TEXT NOT NULL,
  authorization_expires_at TEXT NOT NULL,
  authorization_key_id TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  authority_operation_id TEXT NOT NULL,
  authority_operation_scope TEXT NOT NULL,
  authority_operation_kind TEXT NOT NULL CHECK (
    authority_operation_kind = 'learning_experiment_close_v1'
  ),
  close_sha256 TEXT NOT NULL CHECK (
    length(close_sha256) = 64
    AND close_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, experiment_close_id),
  UNIQUE (tenant_id, confirmatory_attempt_id),
  UNIQUE (
    tenant_id, authority_operation_scope,
    authority_operation_kind, authority_operation_id
  ),
  UNIQUE (tenant_id, authorization_key_id, authorization_nonce)
);
```

`LearningExperimentCloseApprovalV1` binds the exact tenant, attempt,
experiment/revision, namespace-set digest, close reason, action, scope,
operation ID, expiry, nonce, and current candidate/gate implementation
digests. `learning-experiment.ts close` verifies the HMAC using the existing
authority keyring, opens `BEGIN IMMEDIATE`, recomputes the current event head
and complete active lease membership, inserts this closure and its protected
operation receipt, claims its global signed-authorization nonce, then releases the full lease set with
`release_ref_kind=experiment_close` and the closure ID. Exact retry replays;
changed approval or membership conflicts with zero mutation. A terminal gate
adjudication instead uses its decision ID with
`release_ref_kind=terminal_authority_adjudication` in the same authority
transaction. Verification resolves every released row to exactly one of these
two append-only authority objects and their matching operation receipt.

#### 7.3.4 `lite_learning_authorization_nonces`

Signed approval nonces are one-use across **all** learning authority kinds, not
once per target table. Both experiment close and gate adjudication atomically
claim this append-only registry row before their authority mutation.

```sql
CREATE TABLE lite_learning_authorization_nonces (
  tenant_id TEXT NOT NULL,
  authorization_key_id TEXT NOT NULL,
  authorization_nonce TEXT NOT NULL,
  authorization_kind TEXT NOT NULL CHECK (authorization_kind IN (
    'gate_adjudication', 'experiment_close'
  )),
  authority_ref_id TEXT NOT NULL,
  authorization_sha256 TEXT NOT NULL CHECK (
    length(authorization_sha256) = 64
    AND authorization_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, authorization_key_id, authorization_nonce),
  UNIQUE (tenant_id, authorization_kind, authority_ref_id)
);
```

The table-level nonce indexes on closures/gate decisions are defense in depth;
this registry is the cross-kind race authority. Duplicate nonce, changed digest,
or authority-ref reuse aborts the enclosing transaction and exact replay
resolves the original protected operation receipt rather than inserting again.

### 7.4 `lite_learning_episode_events`

Append-only event envelope and chronological evidence cutoff.

```sql
CREATE TABLE lite_learning_episode_events (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  event_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  episode_sequence INTEGER NOT NULL CHECK (episode_sequence >= 1),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'exposure_committed', 'feedback_attributed', 'effect_measured'
  )),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'guide_receipt', 'memory_feedback_operation',
    'tool_feedback_operation', 'product_measurement', 'legacy_backfill'
  )),
  source_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (
    length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  previous_event_sha256 TEXT CHECK (
    previous_event_sha256 IS NULL OR (
      length(previous_event_sha256) = 64
      AND previous_event_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  event_sha256 TEXT NOT NULL CHECK (
    length(event_sha256) = 64 AND event_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  item_set_sha256 TEXT NOT NULL CHECK (
    length(item_set_sha256) = 64 AND item_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_commit_id TEXT,
  supersedes_event_id TEXT CHECK (
    supersedes_event_id IS NULL OR supersedes_event_id <> event_id
  ),
  operation_id TEXT,
  run_id TEXT,
  collection_class TEXT NOT NULL CHECK (collection_class IN (
    'eligible_host', 'fixture_pilot', 'unverified', 'legacy_unclassified'
  )),
  collection_principal_sha256 TEXT CHECK (
    collection_principal_sha256 IS NULL OR (
      length(collection_principal_sha256) = 64
      AND collection_principal_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  collector_id TEXT,
  collector_version TEXT,
  host_task_id TEXT,
  host_source_task_sha256 TEXT CHECK (
    host_source_task_sha256 IS NULL OR (
      length(host_source_task_sha256) = 64
      AND host_source_task_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  host_source_event_sha256 TEXT CHECK (
    host_source_event_sha256 IS NULL OR (
      length(host_source_event_sha256) = 64
      AND host_source_event_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  host_task_envelope_created_at TEXT,
  host_task_envelope_sha256 TEXT CHECK (
    host_task_envelope_sha256 IS NULL OR (
      length(host_task_envelope_sha256) = 64
      AND host_task_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  task_family TEXT,
  task_signature_sha256 TEXT CHECK (
    task_signature_sha256 IS NULL OR (
      length(task_signature_sha256) = 64
      AND task_signature_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  repo_signature_sha256 TEXT CHECK (
    repo_signature_sha256 IS NULL OR (
      length(repo_signature_sha256) = 64
      AND repo_signature_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  memory_namespace_sha256 TEXT CHECK (
    memory_namespace_sha256 IS NULL OR (
      length(memory_namespace_sha256) = 64
      AND memory_namespace_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  namespace_set_sha256 TEXT CHECK (
    namespace_set_sha256 IS NULL OR (
      length(namespace_set_sha256) = 64
      AND namespace_set_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  namespace_lease_id TEXT,
  namespace_lease_generation INTEGER CHECK (
    namespace_lease_generation IS NULL OR namespace_lease_generation >= 1
  ),
  profile_id TEXT,
  experiment_id TEXT,
  experiment_revision INTEGER,
  enrollment_state TEXT CHECK (enrollment_state IN (
    'enrolled', 'not_enrolled', 'legacy_unclassified'
  )),
  serving_phase TEXT CHECK (serving_phase IN (
    'aa', 'shadow', 'active_control', 'fixed_active', 'off'
  )),
  evidence_intent TEXT CHECK (evidence_intent IS NULL OR evidence_intent IN (
    'integrity_only', 'confirmatory'
  )),
  assignment_mode TEXT CHECK (assignment_mode IN (
    'matched_pair_randomized', 'diagnostic_randomized',
    'non_randomized', 'unassigned'
  )),
  assignment_unit_sha256 TEXT CHECK (
    assignment_unit_sha256 IS NULL OR (
      length(assignment_unit_sha256) = 64
      AND assignment_unit_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  assignment_namespace_sha256 TEXT CHECK (
    assignment_namespace_sha256 IS NULL OR (
      length(assignment_namespace_sha256) = 64
      AND assignment_namespace_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  assignment_bucket INTEGER CHECK (
    assignment_bucket IS NULL OR assignment_bucket BETWEEN 0 AND 9999
  ),
  randomization_pair_sha256 TEXT CHECK (
    randomization_pair_sha256 IS NULL OR (
      length(randomization_pair_sha256) = 64
      AND randomization_pair_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  matching_covariate_sha256 TEXT CHECK (
    matching_covariate_sha256 IS NULL OR (
      length(matching_covariate_sha256) = 64
      AND matching_covariate_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  pair_member_ordinal INTEGER CHECK (
    pair_member_ordinal IS NULL OR pair_member_ordinal IN (0, 1)
  ),
  activation_wave_index INTEGER CHECK (
    activation_wave_index IS NULL OR activation_wave_index IN (1, 2, 3)
  ),
  activation_starts_at TEXT,
  index_window_ends_at TEXT,
  wave_analysis_at TEXT,
  assignment_arm TEXT CHECK (assignment_arm IN (
    'control', 'candidate', 'not_enrolled'
  )),
  served_arm TEXT CHECK (served_arm IN ('control', 'candidate')),
  candidate_policy_id TEXT,
  candidate_policy_version TEXT,
  policy_affected INTEGER CHECK (
    policy_affected IS NULL OR policy_affected IN (0, 1)
  ),
  predecision_track TEXT CHECK (predecision_track IN (
    'explore', 'exploit', 'mixed', 'unaffected', 'unclassified'
  )),
  projection_complete INTEGER CHECK (
    projection_complete IS NULL OR projection_complete IN (0, 1)
  ),
  promotion_eligible INTEGER NOT NULL DEFAULT 0
    CHECK (promotion_eligible IN (0, 1)),
  recorded_at TEXT NOT NULL,
  CHECK (
    promotion_eligible = 0 OR (
      collection_class = 'eligible_host'
      AND collection_principal_sha256 IS NOT NULL
      AND collector_id IS NOT NULL
      AND collector_version IS NOT NULL
      AND host_task_id IS NOT NULL
      AND host_source_task_sha256 IS NOT NULL
      AND host_source_event_sha256 IS NOT NULL
      AND host_task_envelope_created_at IS NOT NULL
      AND host_task_envelope_sha256 IS NOT NULL
      AND enrollment_state = 'enrolled'
      AND serving_phase = 'active_control'
      AND evidence_intent = 'confirmatory'
      AND assignment_mode = 'matched_pair_randomized'
      AND operation_id IS NOT NULL
      AND task_family IS NOT NULL
      AND task_signature_sha256 IS NOT NULL
      AND repo_signature_sha256 IS NOT NULL
      AND memory_namespace_sha256 IS NOT NULL
      AND namespace_set_sha256 IS NOT NULL
      AND namespace_lease_id IS NOT NULL
      AND namespace_lease_generation IS NOT NULL
      AND profile_id IS NOT NULL
      AND experiment_id IS NOT NULL
      AND experiment_revision IS NOT NULL
      AND assignment_unit_sha256 IS NOT NULL
      AND assignment_namespace_sha256 IS NOT NULL
      AND assignment_bucket IS NULL
      AND randomization_pair_sha256 IS NOT NULL
      AND matching_covariate_sha256 IS NOT NULL
      AND pair_member_ordinal IS NOT NULL
      AND activation_wave_index IS NOT NULL
      AND activation_starts_at IS NOT NULL
      AND index_window_ends_at IS NOT NULL
      AND wave_analysis_at IS NOT NULL
      AND recorded_at >= activation_starts_at
      AND recorded_at <= index_window_ends_at
      AND assignment_arm IS NOT NULL
      AND assignment_arm IN ('control', 'candidate')
      AND served_arm IS NOT NULL
      AND served_arm IN ('control', 'candidate')
      AND served_arm = assignment_arm
      AND candidate_policy_id IS NOT NULL
      AND candidate_policy_version IS NOT NULL
      AND policy_affected IS NOT NULL
      AND projection_complete = 1
    )
  ),
  CHECK (
    assignment_mode IS NOT 'matched_pair_randomized' OR (
      assignment_bucket IS NULL
      AND randomization_pair_sha256 IS NOT NULL
      AND matching_covariate_sha256 IS NOT NULL
      AND pair_member_ordinal IS NOT NULL
      AND activation_wave_index IS NOT NULL
      AND activation_starts_at IS NOT NULL
      AND index_window_ends_at IS NOT NULL
      AND wave_analysis_at IS NOT NULL
      AND assignment_arm IN ('control', 'candidate')
    )
  ),
  CHECK (
    assignment_mode IS NOT 'diagnostic_randomized' OR (
      assignment_bucket IS NOT NULL
      AND randomization_pair_sha256 IS NULL
      AND matching_covariate_sha256 IS NULL
      AND pair_member_ordinal IS NULL
      AND activation_wave_index IS NULL
    )
  ),
  UNIQUE (tenant_id, scope, event_id),
  UNIQUE (tenant_id, scope, episode_id, episode_sequence),
  UNIQUE (tenant_id, scope, source_kind, source_id)
);
```

`collection_source_policy_json` is an immutable, canonical mapping from
authenticated principal fingerprints to class plus collector ID/version.
Classes are `eligible_host` or `fixture_pilot`.
Every newly committed revision freezes
`collection_source_policy_validation_contract` =
`"aionis_collection_source_policy_strict_v1"` in `config_json`; Runtime then
requires the v1 source entries to be unique by principal fingerprint and sorted
in canonical UTF-8 order. Historical immutable revisions without that marker
remain replayable only when they match the original
`aionis_collection_source_policy_v1` wire shape. This compatibility path is
used for integrity/reopen and exact replay only; it cannot admit a fresh
revision or an unknown policy contract.
It contains hashes, not API keys or JWTs. `/v1/guide` already resolves an
`AuthPrincipal` and, in server mode, overwrites consumer identity from that
principal. The route must additionally pass the resolved principal to the guide
service, which derives `collection_principal_sha256` and the class from this
mapping. The request body and harness cannot select their own class. Auth-off,
an absent principal, a missing mapping, or a mapping/config digest error yields
`unverified` and `promotion_eligible=false`. Evaluation pilots use a distinct
authenticated principal mapped to `fixture_pilot`; genuine host collectors use
separately provisioned principals mapped to `eligible_host`.

The fingerprint is versioned and contains identity, never credential material:

```ts
collectionPrincipalSha256 = sha256(stableStringify({
  contract_version: "aionis_collection_principal_v1",
  tenant_id: principal.tenant_id,
  agent_id: principal.agent_id,
  team_id: principal.team_id,
}));
```

At least one agent/team subject is required by the existing server product
identity guard. Golden-vector tests freeze this encoding. Changing credentials
for the same principal preserves the fingerprint; changing the principal or
tenant does not. Pilot and genuine-host collection therefore require distinct
agent/team identities, not merely two keys for the same subject.

Feedback events inherit the verified exposure's collection class rather than
accepting a new claim. An effect event is `eligible_host` only when both bound
episodes share the same eligible principal and experiment revision; otherwise
it is conservatively `unverified`. Legacy backfill uses
`legacy_unclassified`; offline paired Runtime calls are fixture/unverified
traffic and become evidence only through a validated external paired artifact.
Neither enters the confirmatory online cohort. An online index unit is eligible
only when its exposure is `eligible_host`, its immutable revision has
`evidence_intent=confirmatory`, the exact task-family candidate-implementation
confirmatory-attempt row existed before the exposure, its principal fingerprint
is still present in the frozen experiment revision, and all other promotion
predicates pass.

The SQL check prevents obviously impossible `promotion_eligible=1` rows, but
the cohort builder never trusts that cached bit. It re-resolves the immutable
experiment/policy/source records and recomputes every phase, evidence intent,
confirmatory-attempt, identity, assignment, task-envelope, projection,
operation, and receipt predicate. A
stored bit that disagrees with recomputation is an integrity finding and forces
`hold`/pause.

Required indexes:

```sql
CREATE UNIQUE INDEX idx_lite_learning_episode_one_exposure
  ON lite_learning_episode_events(tenant_id, scope, episode_id)
  WHERE event_kind = 'exposure_committed';

CREATE UNIQUE INDEX idx_lite_learning_episode_one_superseder
  ON lite_learning_episode_events(tenant_id, scope, supersedes_event_id)
  WHERE supersedes_event_id IS NOT NULL;

CREATE INDEX idx_lite_learning_episode_replay
  ON lite_learning_episode_events(
    tenant_id, scope, episode_id, episode_sequence, row_id
  );

CREATE INDEX idx_lite_learning_episode_gate_slice
  ON lite_learning_episode_events(
    tenant_id, task_family, candidate_policy_id,
    candidate_policy_version, experiment_id, experiment_revision,
    assignment_arm, recorded_at, row_id
  ) WHERE event_kind = 'exposure_committed';

CREATE INDEX idx_lite_learning_episode_namespace_assignment
  ON lite_learning_episode_events(
    tenant_id, experiment_id, experiment_revision,
    memory_namespace_sha256, assignment_unit_sha256, assignment_arm
  )
  WHERE event_kind = 'exposure_committed'
    AND collection_class = 'eligible_host';

CREATE INDEX idx_lite_learning_episode_lease_binding
  ON lite_learning_episode_events(
    tenant_id, namespace_lease_id, namespace_lease_generation, row_id
  )
  WHERE event_kind = 'exposure_committed'
    AND promotion_eligible = 1;

CREATE TRIGGER trg_lite_learning_namespace_assignment_binding
BEFORE INSERT ON lite_learning_episode_events
WHEN NEW.event_kind = 'exposure_committed'
  AND NEW.collection_class = 'eligible_host'
  AND EXISTS (
    SELECT 1 FROM lite_learning_episode_events AS prior
    WHERE prior.tenant_id = NEW.tenant_id
      AND prior.experiment_id = NEW.experiment_id
      AND prior.experiment_revision = NEW.experiment_revision
      AND prior.event_kind = 'exposure_committed'
      AND prior.collection_class = 'eligible_host'
      AND (
        prior.memory_namespace_sha256 = NEW.memory_namespace_sha256
        OR prior.assignment_unit_sha256 = NEW.assignment_unit_sha256
      )
      AND (
        prior.memory_namespace_sha256 IS NOT NEW.memory_namespace_sha256
        OR prior.assignment_unit_sha256 IS NOT NEW.assignment_unit_sha256
        OR prior.assignment_bucket IS NOT NEW.assignment_bucket
        OR prior.randomization_pair_sha256 IS NOT NEW.randomization_pair_sha256
        OR prior.matching_covariate_sha256 IS NOT NEW.matching_covariate_sha256
        OR prior.pair_member_ordinal IS NOT NEW.pair_member_ordinal
        OR prior.activation_wave_index IS NOT NEW.activation_wave_index
        OR prior.activation_starts_at IS NOT NEW.activation_starts_at
        OR prior.index_window_ends_at IS NOT NEW.index_window_ends_at
        OR prior.wave_analysis_at IS NOT NEW.wave_analysis_at
        OR prior.assignment_arm IS NOT NEW.assignment_arm
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'learning_namespace_assignment_conflict');
END;

CREATE TRIGGER trg_lite_learning_eligible_active_lease
BEFORE INSERT ON lite_learning_episode_events
WHEN NEW.event_kind = 'exposure_committed'
  AND NEW.collection_class = 'eligible_host'
  AND NEW.evidence_intent = 'confirmatory'
  AND NEW.assignment_mode = 'matched_pair_randomized'
  AND NOT EXISTS (
    SELECT 1
    FROM lite_learning_namespace_leases AS lease
    JOIN lite_learning_randomization_pairs AS pair_row
      ON pair_row.tenant_id = lease.tenant_id
      AND pair_row.confirmatory_attempt_id = lease.confirmatory_attempt_id
      AND pair_row.randomization_pair_sha256 = lease.randomization_pair_sha256
    WHERE lease.tenant_id = NEW.tenant_id
      AND lease.namespace_lease_id = NEW.namespace_lease_id
      AND lease.memory_namespace_sha256 = NEW.memory_namespace_sha256
      AND lease.lease_generation = NEW.namespace_lease_generation
      AND lease.experiment_id = NEW.experiment_id
      AND lease.experiment_revision = NEW.experiment_revision
      AND lease.namespace_set_sha256 = NEW.namespace_set_sha256
      AND lease.randomization_pair_sha256 = NEW.randomization_pair_sha256
      AND pair_row.matching_covariate_sha256 = NEW.matching_covariate_sha256
      AND lease.pair_member_ordinal = NEW.pair_member_ordinal
      AND lease.assigned_arm = NEW.assignment_arm
      AND lease.activation_wave_index = NEW.activation_wave_index
      AND lease.activation_starts_at = NEW.activation_starts_at
      AND lease.index_window_ends_at = NEW.index_window_ends_at
      AND lease.wave_analysis_at = NEW.wave_analysis_at
      AND NEW.recorded_at >= lease.activation_starts_at
      AND NEW.recorded_at <= lease.index_window_ends_at
      AND lease.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'learning_namespace_active_lease_required');
END;

CREATE TRIGGER trg_lite_learning_fixture_lease_overlap
BEFORE INSERT ON lite_learning_episode_events
WHEN NEW.event_kind = 'exposure_committed'
  AND NEW.collection_class = 'fixture_pilot'
  AND EXISTS (
    SELECT 1 FROM lite_learning_namespace_leases AS lease
    WHERE lease.tenant_id = NEW.tenant_id
      AND lease.memory_namespace_sha256 = NEW.memory_namespace_sha256
      AND lease.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'learning_fixture_namespace_lease_overlap');
END;

CREATE UNIQUE INDEX idx_lite_learning_episode_host_source_event
  ON lite_learning_episode_events(
    tenant_id, experiment_id, experiment_revision,
    host_source_event_sha256
  )
  WHERE event_kind = 'exposure_committed'
    AND collection_class = 'eligible_host';

CREATE INDEX idx_lite_learning_episode_host_task_binding
  ON lite_learning_episode_events(
    tenant_id, experiment_id, experiment_revision,
    host_task_id
  )
  WHERE event_kind = 'exposure_committed'
    AND collection_class = 'eligible_host';

CREATE INDEX idx_lite_learning_episode_source_task_binding
  ON lite_learning_episode_events(
    tenant_id, experiment_id, experiment_revision,
    host_source_task_sha256
  )
  WHERE event_kind = 'exposure_committed'
    AND collection_class = 'eligible_host';

CREATE TRIGGER trg_lite_learning_host_task_binding
BEFORE INSERT ON lite_learning_episode_events
WHEN NEW.event_kind = 'exposure_committed'
  AND NEW.collection_class = 'eligible_host'
  AND EXISTS (
    SELECT 1 FROM lite_learning_episode_events AS prior
    WHERE prior.tenant_id = NEW.tenant_id
      AND prior.experiment_id = NEW.experiment_id
      AND prior.experiment_revision = NEW.experiment_revision
      AND prior.event_kind = 'exposure_committed'
      AND prior.collection_class = 'eligible_host'
      AND prior.host_task_id = NEW.host_task_id
      AND (
        prior.host_source_task_sha256 IS NOT NEW.host_source_task_sha256
        OR prior.task_family IS NOT NEW.task_family
        OR prior.task_signature_sha256 IS NOT NEW.task_signature_sha256
        OR prior.repo_signature_sha256 IS NOT NEW.repo_signature_sha256
        OR prior.memory_namespace_sha256 IS NOT NEW.memory_namespace_sha256
        OR prior.collector_id IS NOT NEW.collector_id
        OR prior.collector_version IS NOT NEW.collector_version
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'learning_host_task_binding_conflict');
END;

CREATE TRIGGER trg_lite_learning_host_source_task_alias
BEFORE INSERT ON lite_learning_episode_events
WHEN NEW.event_kind = 'exposure_committed'
  AND NEW.collection_class = 'eligible_host'
  AND EXISTS (
    SELECT 1 FROM lite_learning_episode_events AS prior
    WHERE prior.tenant_id = NEW.tenant_id
      AND prior.experiment_id = NEW.experiment_id
      AND prior.experiment_revision = NEW.experiment_revision
      AND prior.event_kind = 'exposure_committed'
      AND prior.collection_class = 'eligible_host'
      AND prior.host_source_task_sha256 = NEW.host_source_task_sha256
      AND prior.host_task_id <> NEW.host_task_id
  )
BEGIN
  SELECT RAISE(ABORT, 'learning_host_source_task_alias_conflict');
END;
```

The event digest covers the canonical envelope, payload digest, item-set digest,
and previous event digest. `row_id` is the global cutoff for reproducible gate
cohorts; client timestamps never define evidence order.

The protected event payload stores the full bounded canonical task envelope,
not only its digest. The unique source-event index rejects the same host event
under a new operation. The two binding triggers allow repeated guide calls for
one stable host task while preventing task-ID drift or renaming the same
canonical source task to manufacture another unit. Cohort replay additionally
deduplicates on the independent store-memory-namespace assignment cluster, so
different repositories/task signatures, repeated calls, and repeated
host task IDs inside that cluster contribute only the earliest eligible index
exposure for that track. Host task/source identities are tenant/revision-wide
across all eligible principals, not principal- or scope-local, because one
task-family cohort may aggregate multiple collectors and scopes.

### 7.5 `lite_learning_exposure_items`

Immutable decision-time facts at memory-item granularity.

```sql
CREATE TABLE lite_learning_exposure_items (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  event_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  decision_completeness TEXT NOT NULL CHECK (decision_completeness IN (
    'complete', 'legacy_served_only'
  )),
  memory_type TEXT,
  source_backend TEXT,
  recorded_action TEXT CHECK (recorded_action IS NULL OR recorded_action IN (
    'use_now', 'inspect_before_use', 'do_not_use', 'rehydrate'
  )),
  candidate_action TEXT CHECK (candidate_action IS NULL OR candidate_action IN (
    'use_now', 'inspect_before_use', 'do_not_use', 'rehydrate'
  )),
  served_action TEXT NOT NULL CHECK (served_action IN (
    'use_now', 'inspect_before_use', 'do_not_use', 'rehydrate'
  )),
  policy_changed INTEGER CHECK (policy_changed IS NULL OR policy_changed IN (0, 1)),
  hard_boundary_preserved INTEGER CHECK (
    hard_boundary_preserved IS NULL OR hard_boundary_preserved IN (0, 1)
  ),
  prior_supported_use_count INTEGER CHECK (
    prior_supported_use_count IS NULL OR prior_supported_use_count >= 0
  ),
  prior_contradicted_use_count INTEGER CHECK (
    prior_contradicted_use_count IS NULL OR prior_contradicted_use_count >= 0
  ),
  prior_rehydrate_requested_count INTEGER CHECK (
    prior_rehydrate_requested_count IS NULL OR prior_rehydrate_requested_count >= 0
  ),
  prior_effect_state TEXT CHECK (prior_effect_state IS NULL OR prior_effect_state IN (
    'no_prior', 'supported', 'contradicted', 'mixed', 'rehydrate_requested'
  )),
  repeated_negative_posture INTEGER CHECK (
    repeated_negative_posture IS NULL OR repeated_negative_posture IN (0, 1)
  ),
  learning_track TEXT NOT NULL CHECK (learning_track IN (
    'explore', 'exploit', 'unclassified'
  )),
  track_reason TEXT NOT NULL CHECK (track_reason IN (
    'no_prior', 'prior_supported', 'prior_contradicted', 'prior_mixed',
    'prior_rehydrate_requested', 'prior_nonuse_control', 'legacy_unclassified'
  )),
  item_sha256 TEXT NOT NULL CHECK (
    length(item_sha256) = 64 AND item_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (
      decision_completeness = 'complete'
      AND memory_type IS NOT NULL AND length(memory_type) BETWEEN 1 AND 120
      AND source_backend IS NOT NULL AND length(source_backend) BETWEEN 1 AND 120
      AND recorded_action IS NOT NULL AND candidate_action IS NOT NULL
      AND policy_changed IS NOT NULL AND hard_boundary_preserved IS NOT NULL
      AND prior_supported_use_count IS NOT NULL
      AND prior_contradicted_use_count IS NOT NULL
      AND prior_rehydrate_requested_count IS NOT NULL
      AND prior_effect_state IS NOT NULL
      AND repeated_negative_posture IS NOT NULL
      AND learning_track IN ('explore', 'exploit')
      AND track_reason <> 'legacy_unclassified'
    ) OR (
      decision_completeness = 'legacy_served_only'
      AND memory_type IS NULL AND source_backend IS NULL
      AND recorded_action IS NULL AND candidate_action IS NULL
      AND policy_changed IS NULL AND hard_boundary_preserved IS NULL
      AND prior_supported_use_count IS NULL
      AND prior_contradicted_use_count IS NULL
      AND prior_rehydrate_requested_count IS NULL
      AND prior_effect_state IS NULL AND repeated_negative_posture IS NULL
      AND learning_track = 'unclassified'
      AND track_reason = 'legacy_unclassified'
    )
  ),
  PRIMARY KEY (tenant_id, scope, event_id, memory_id),
  UNIQUE (tenant_id, scope, episode_id, memory_id)
);
```

The event's `item_set_sha256` is recomputed from the canonical, memory-ID-sorted
item rows during verification.

### 7.6 `lite_learning_feedback_attributions`

Immutable, complete attribution facts. Memory and tool feedback share one
shape, without pretending a tool decision is a memory item.

```sql
CREATE TABLE lite_learning_feedback_attributions (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  event_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN (
    'memory', 'tool_decision'
  )),
  subject_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'positive', 'negative', 'neutral'
  )),
  action_outcome TEXT CHECK (action_outcome IS NULL OR action_outcome IN (
    'accepted_completed', 'accepted_incomplete', 'rejected', 'not_applicable'
  )),
  used_surface TEXT CHECK (used_surface IS NULL OR used_surface IN (
    'use_now', 'inspect_before_use', 'do_not_use', 'explicit_host_assertion'
  )),
  exposure_action TEXT CHECK (exposure_action IS NULL OR exposure_action IN (
    'use_now', 'inspect_before_use', 'do_not_use', 'rehydrate'
  )),
  boundary_outcome TEXT NOT NULL CHECK (boundary_outcome IN (
    'aligned', 'boundary_ignored', 'not_applicable'
  )),
  attribution_strength TEXT NOT NULL CHECK (attribution_strength IN (
    'observed_feedback', 'positive_attribution',
    'weak_counter_signal', 'strong_counter_signal'
  )),
  evidence_class TEXT NOT NULL CHECK (evidence_class IN (
    'verified_host_receipt', 'legacy_unverified', 'tool_decision'
  )),
  host_use_receipt_id TEXT,
  host_use_receipt_sha256 TEXT CHECK (
    host_use_receipt_sha256 IS NULL OR (
      length(host_use_receipt_sha256) = 64
      AND host_use_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  receipt_item_sha256 TEXT CHECK (
    receipt_item_sha256 IS NULL OR (
      length(receipt_item_sha256) = 64
      AND receipt_item_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  host_task_envelope_sha256 TEXT CHECK (
    host_task_envelope_sha256 IS NULL OR (
      length(host_task_envelope_sha256) = 64
      AND host_task_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  collection_principal_sha256 TEXT CHECK (
    collection_principal_sha256 IS NULL OR (
      length(collection_principal_sha256) = 64
      AND collection_principal_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  collector_id TEXT,
  collector_version TEXT,
  content_evidence_sha256 TEXT CHECK (
    content_evidence_sha256 IS NULL OR (
      length(content_evidence_sha256) = 64
      AND content_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  verifier_kind TEXT CHECK (verifier_kind IS NULL OR verifier_kind IN (
    'instrumented_agent_trace', 'deterministic_scorer'
  )),
  verifier_version TEXT,
  verifier_config_sha256 TEXT CHECK (
    verifier_config_sha256 IS NULL OR (
      length(verifier_config_sha256) = 64
      AND verifier_config_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  verifier_status TEXT CHECK (
    verifier_status IS NULL OR verifier_status IN ('passed', 'failed', 'not_run')
  ),
  tool_status TEXT,
  runtime_signal_refs_sha256 TEXT CHECK (
    runtime_signal_refs_sha256 IS NULL OR (
      length(runtime_signal_refs_sha256) = 64
      AND runtime_signal_refs_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  item_sha256 TEXT NOT NULL CHECK (
    length(item_sha256) = 64 AND item_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (subject_kind = 'memory' AND used_surface IS NOT NULL AND exposure_action IS NOT NULL)
    OR (
      subject_kind = 'tool_decision' AND used_surface IS NULL
      AND exposure_action IS NULL AND boundary_outcome = 'not_applicable'
    )
  ),
  CHECK (
    (
      subject_kind = 'memory'
      AND evidence_class = 'verified_host_receipt'
      AND action_outcome IS NOT NULL
      AND host_use_receipt_id IS NOT NULL
      AND host_use_receipt_sha256 IS NOT NULL
      AND receipt_item_sha256 IS NOT NULL
      AND host_task_envelope_sha256 IS NOT NULL
      AND collection_principal_sha256 IS NOT NULL
      AND collector_id IS NOT NULL
      AND collector_version IS NOT NULL
      AND content_evidence_sha256 IS NOT NULL
      AND verifier_kind IS NOT NULL
      AND verifier_version IS NOT NULL
      AND verifier_config_sha256 IS NOT NULL
      AND verifier_status = 'passed'
      AND runtime_signal_refs_sha256 IS NOT NULL
      AND used_surface <> 'explicit_host_assertion'
    ) OR (
      subject_kind = 'memory'
      AND evidence_class = 'legacy_unverified'
      AND action_outcome IS NULL
      AND host_use_receipt_id IS NULL
      AND host_use_receipt_sha256 IS NULL
      AND receipt_item_sha256 IS NULL
      AND host_task_envelope_sha256 IS NULL
      AND collection_principal_sha256 IS NULL
      AND collector_id IS NULL
      AND collector_version IS NULL
      AND content_evidence_sha256 IS NULL
      AND verifier_kind IS NULL
      AND verifier_version IS NULL
      AND verifier_config_sha256 IS NULL
      AND verifier_status IS NULL
    ) OR (
      subject_kind = 'tool_decision'
      AND evidence_class = 'tool_decision'
      AND action_outcome IS NULL
      AND host_use_receipt_id IS NULL
      AND host_use_receipt_sha256 IS NULL
      AND receipt_item_sha256 IS NULL
      AND host_task_envelope_sha256 IS NULL
      AND content_evidence_sha256 IS NULL
      AND verifier_kind IS NULL
      AND verifier_version IS NULL
      AND verifier_config_sha256 IS NULL
      AND verifier_status IS NULL
    )
  ),
  PRIMARY KEY (
    tenant_id, scope, event_id, subject_kind, subject_id
  )
);
```

If a candidate served `inspect_before_use` but the host reports direct
`use_now`, feedback is retained and classified `boundary_ignored`; it is not
silently treated as ordinary negative feedback. This immediately pauses the
candidate implementation contract across experiment revisions and aliases and applies the
memory-level safety control.

Supersession is whole-event, not per-row. A correction must append a complete
replacement event containing every active subject from the prior feedback
event, set `supersedes_event_id`, and recompute the full item-set digest. Replay
then excludes the superseded event and all of its rows; a partial replacement
is rejected.

### 7.7 `lite_learning_host_use_receipts`

A digest alone cannot be reverified after restart. Every verified host receipt
therefore has one immutable header containing the bounded, sanitized canonical
receipt body. The per-memory attribution rows bind its exact item digests.

```sql
CREATE TABLE lite_learning_host_use_receipts (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  feedback_event_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  host_task_id TEXT NOT NULL,
  host_task_envelope_sha256 TEXT NOT NULL CHECK (
    length(host_task_envelope_sha256) = 64
    AND host_task_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  collection_principal_sha256 TEXT NOT NULL CHECK (
    length(collection_principal_sha256) = 64
    AND collection_principal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  collector_id TEXT NOT NULL,
  collector_version TEXT NOT NULL,
  host_trace_sha256 TEXT NOT NULL CHECK (
    length(host_trace_sha256) = 64
    AND host_trace_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND 512),
  item_set_sha256 TEXT NOT NULL CHECK (
    length(item_set_sha256) = 64
    AND item_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  receipt_sha256 TEXT NOT NULL CHECK (
    length(receipt_sha256) = 64
    AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  receipt_payload_json TEXT NOT NULL CHECK (
    json_valid(receipt_payload_json)
    AND length(CAST(receipt_payload_json AS BLOB)) <= 262144
  ),
  verifier_status TEXT NOT NULL CHECK (verifier_status = 'passed'),
  PRIMARY KEY (tenant_id, scope, receipt_id),
  UNIQUE (tenant_id, scope, receipt_sha256),
  UNIQUE (tenant_id, scope, feedback_event_id),
  UNIQUE (tenant_id, scope, operation_id)
);
```

`receipt_payload_json` is the canonical `HostUseReceiptV1Body`, containing only
IDs, enums, timestamps, and digests. It excludes `receipt_sha256`; Runtime
recomputes that digest from the body. Insert resolves the exposure and source
policy, proves every canonical receipt item appears exactly once in the same
feedback event with the same `receipt_item_sha256`, and rejects a receipt ID,
digest, event, or operation previously bound elsewhere. The header, feedback
event, attribution rows, business mutation, and operation receipt commit in one
transaction. Legacy and tool feedback create no host-receipt header.

### 7.8 `lite_learning_control_jobs`

Repeated-unused control is asynchronous but must not be best effort. It uses a
dedicated durable queue rather than overloading the current
associative-link-only `lite_memory_outbox`.

```sql
CREATE TABLE lite_learning_control_jobs (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_kind TEXT NOT NULL CHECK (
    job_kind = 'unused_exposure_learning_control_v1'
  ),
  operation_id TEXT NOT NULL,
  source_episode_id TEXT NOT NULL,
  source_feedback_event_id TEXT NOT NULL,
  source_commit_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'leased', 'completed', 'dead_letter'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  result_commit_id TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 256),
  CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 120),
  CHECK (
    (status = 'pending'
      AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND result_commit_id IS NULL AND completed_at IS NULL)
    OR (status = 'leased'
      AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
      AND result_commit_id IS NULL AND completed_at IS NULL)
    OR (status = 'completed'
      AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND result_commit_id IS NOT NULL AND last_error_code IS NULL
      AND completed_at IS NOT NULL)
    OR (status = 'dead_letter'
      AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND result_commit_id IS NULL AND last_error_code IS NOT NULL
      AND completed_at IS NOT NULL)
  ),
  UNIQUE (tenant_id, scope, job_id),
  UNIQUE (tenant_id, scope, operation_id)
);

CREATE INDEX idx_lite_learning_control_jobs_available
  ON lite_learning_control_jobs(status, available_at, row_id);

CREATE INDEX idx_lite_learning_control_jobs_lease
  ON lite_learning_control_jobs(lease_expires_at)
  WHERE status = 'leased';
```

The feedback transaction inserts `pending`. A worker leases with bounded retry,
applies inspect-first posture under the deterministic operation ID, and marks
`completed` in the same shared transaction as the memory commit and operation
receipt. Crash/reopen safely reclaims an expired lease. Invalid payload or
exhausted retry is retained. Successful safety terminalization moves it to
`dead_letter`, a finding that blocks active candidate serving and promotion;
if pause/authority persistence fails, it remains leased/deferred and Runtime
readiness fails closed. Jobs are never silently deleted. For an enrolled source episode, the terminal transition and a
candidate-implementation `safety_stop/pause` row commits together using facts reloaded
from that exposure, so guide observes the existing authority fold rather than
polling queue state. The row is keyed by the resolved candidate implementation,
not only its ID/version alias. If the safety row cannot commit, the job does not become a
dead letter and remains retained for terminalization retry. A structurally valid dead letter remains
backup-eligible so failure state is not lost. Only schema, digest, or reference
corruption blocks backup.

### 7.8.1 External reservation, consumption, pre-claim hold, claim, binding, and termination facts

Every formal external prerequisite is reserved before the runner can make an
outcome-bearing or paid call. This closes the file-drawer gap left by merely
making the eventual report content-addressed.

```sql
CREATE TABLE lite_learning_external_run_reservations (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN (
    'offline_paired_rerun', 'production_shadow_gate', 'tool_e2e_gate'
  )),
  evidence_series_id TEXT NOT NULL,
  task_family TEXT NOT NULL,
  candidate_policy_id TEXT NOT NULL,
  candidate_policy_version TEXT NOT NULL,
  candidate_policy_implementation_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_implementation_sha256) = 64
    AND candidate_policy_implementation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_policy_config_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_config_sha256) = 64
    AND candidate_policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  applicable_experiment_id TEXT NOT NULL,
  applicable_experiment_revision INTEGER NOT NULL CHECK (
    applicable_experiment_revision >= 1
  ),
  gate_policy_id TEXT NOT NULL,
  gate_policy_version TEXT NOT NULL,
  gate_policy_config_sha256 TEXT NOT NULL CHECK (
    length(gate_policy_config_sha256) = 64
    AND gate_policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  applicability_manifest_sha256 TEXT NOT NULL CHECK (
    length(applicability_manifest_sha256) = 64
    AND applicability_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  harness_bundle_sha256 TEXT NOT NULL CHECK (
    length(harness_bundle_sha256) = 64
    AND harness_bundle_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_snapshot_sha256 TEXT NOT NULL CHECK (
    length(source_snapshot_sha256) = 64
    AND source_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  case_set_sha256 TEXT CHECK (
    case_set_sha256 IS NULL OR (
      length(case_set_sha256) = 64
      AND case_set_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  holdout_membership_projection_sha256 TEXT CHECK (
    holdout_membership_projection_sha256 IS NULL OR (
      length(holdout_membership_projection_sha256) = 64
      AND holdout_membership_projection_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  sealed_holdout_ref_sha256 TEXT CHECK (
    sealed_holdout_ref_sha256 IS NULL OR (
      length(sealed_holdout_ref_sha256) = 64
      AND sealed_holdout_ref_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  sealed_holdout_ciphertext_sha256 TEXT CHECK (
    sealed_holdout_ciphertext_sha256 IS NULL OR (
      length(sealed_holdout_ciphertext_sha256) = 64
      AND sealed_holdout_ciphertext_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  execution_profile_sha256 TEXT NOT NULL CHECK (
    length(execution_profile_sha256) = 64
    AND execution_profile_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  model_identity_sha256 TEXT NOT NULL CHECK (
    length(model_identity_sha256) = 64
    AND model_identity_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  immutable_model_snapshot_sha256 TEXT CHECK (
    immutable_model_snapshot_sha256 IS NULL OR (
      length(immutable_model_snapshot_sha256) = 64
      AND immutable_model_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  tool_manifest_sha256 TEXT CHECK (
    tool_manifest_sha256 IS NULL OR (
      length(tool_manifest_sha256) = 64
      AND tool_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  execution_order_sha256 TEXT CHECK (
    execution_order_sha256 IS NULL OR (
      length(execution_order_sha256) = 64
      AND execution_order_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  retry_policy_sha256 TEXT NOT NULL CHECK (
    length(retry_policy_sha256) = 64
    AND retry_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  retry_policy_json TEXT NOT NULL CHECK (
    json_valid(retry_policy_json)
    AND length(CAST(retry_policy_json AS BLOB)) <= 4096
  ),
  immutable_input_manifest_sha256 TEXT NOT NULL CHECK (
    length(immutable_input_manifest_sha256) = 64
    AND immutable_input_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  immutable_input_manifest_json TEXT NOT NULL CHECK (
    json_valid(immutable_input_manifest_json)
    AND length(CAST(immutable_input_manifest_json AS BLOB)) <= 32768
  ),
  expected_runner_principal_sha256 TEXT NOT NULL CHECK (
    length(expected_runner_principal_sha256) = 64
    AND expected_runner_principal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_broker_policy_sha256 TEXT NOT NULL CHECK (
    length(credential_broker_policy_sha256) = 64
    AND credential_broker_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  service_launcher_policy_sha256 TEXT NOT NULL CHECK (
    length(service_launcher_policy_sha256) = 64
    AND service_launcher_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  service_launcher_binary_sha256 TEXT NOT NULL CHECK (
    length(service_launcher_binary_sha256) = 64
    AND service_launcher_binary_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  service_launcher_key_id TEXT NOT NULL,
  supervisor_executable_sha256 TEXT NOT NULL CHECK (
    length(supervisor_executable_sha256) = 64
    AND supervisor_executable_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  supervisor_argv_policy_sha256 TEXT NOT NULL CHECK (
    length(supervisor_argv_policy_sha256) = 64
    AND supervisor_argv_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  supervisor_sandbox_policy_sha256 TEXT NOT NULL CHECK (
    length(supervisor_sandbox_policy_sha256) = 64
    AND supervisor_sandbox_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_session_class TEXT NOT NULL CHECK (
    credential_session_class IN (
      'eligible_host_adapter', 'formal_tool_eval', 'immutable_paired_eval'
    )
  ),
  run_id TEXT NOT NULL,
  reserve_operation_id TEXT NOT NULL,
  runner_ticket_sha256 TEXT NOT NULL CHECK (
    length(runner_ticket_sha256) = 64
    AND runner_ticket_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  reservation_sha256 TEXT NOT NULL CHECK (
    length(reservation_sha256) = 64
    AND reservation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  reserved_at TEXT NOT NULL,
  CHECK (
    (artifact_kind = 'offline_paired_rerun'
      AND case_set_sha256 IS NOT NULL
      AND holdout_membership_projection_sha256 IS NOT NULL
      AND sealed_holdout_ref_sha256 IS NOT NULL
      AND sealed_holdout_ciphertext_sha256 IS NOT NULL
      AND immutable_model_snapshot_sha256 IS NOT NULL
      AND tool_manifest_sha256 IS NOT NULL
      AND execution_order_sha256 IS NOT NULL
      AND credential_session_class = 'immutable_paired_eval')
    OR (artifact_kind = 'production_shadow_gate'
      AND case_set_sha256 IS NULL
      AND holdout_membership_projection_sha256 IS NULL
      AND sealed_holdout_ref_sha256 IS NULL
      AND sealed_holdout_ciphertext_sha256 IS NULL
      AND immutable_model_snapshot_sha256 IS NULL
      AND tool_manifest_sha256 IS NULL
      AND execution_order_sha256 IS NULL
      AND credential_session_class = 'eligible_host_adapter')
    OR (artifact_kind = 'tool_e2e_gate'
      AND case_set_sha256 IS NULL
      AND holdout_membership_projection_sha256 IS NULL
      AND sealed_holdout_ref_sha256 IS NULL
      AND sealed_holdout_ciphertext_sha256 IS NULL
      AND immutable_model_snapshot_sha256 IS NULL
      AND tool_manifest_sha256 IS NOT NULL
      AND execution_order_sha256 IS NULL
      AND credential_session_class = 'formal_tool_eval')
  ),
  UNIQUE (tenant_id, reservation_id),
  UNIQUE (tenant_id, evidence_series_id),
  UNIQUE (tenant_id, artifact_kind, run_id),
  UNIQUE (tenant_id, runner_ticket_sha256),
  UNIQUE (tenant_id, reservation_sha256)
);

CREATE TRIGGER trg_lite_learning_external_run_reservation_update
BEFORE UPDATE ON lite_learning_external_run_reservations
BEGIN
  SELECT RAISE(ABORT, 'learning_external_run_reservation_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_external_run_reservation_delete
BEFORE DELETE ON lite_learning_external_run_reservations
BEGIN
  SELECT RAISE(ABORT, 'learning_external_run_reservation_delete_forbidden');
END;

CREATE UNIQUE INDEX idx_lite_learning_offline_holdout_once
  ON lite_learning_external_run_reservations(
    tenant_id, task_family, case_set_sha256
  )
  WHERE artifact_kind = 'offline_paired_rerun';

CREATE TABLE lite_learning_external_holdout_members (
  tenant_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  task_family TEXT NOT NULL,
  case_ordinal INTEGER NOT NULL CHECK (case_ordinal BETWEEN 0 AND 95),
  case_identity_sha256 TEXT NOT NULL CHECK (
    length(case_identity_sha256) = 64
    AND case_identity_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  task_id_sha256 TEXT NOT NULL CHECK (
    length(task_id_sha256) = 64
    AND task_id_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  content_workflow_sha256 TEXT NOT NULL CHECK (
    length(content_workflow_sha256) = 64
    AND content_workflow_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  store_scope_sha256 TEXT NOT NULL CHECK (
    length(store_scope_sha256) = 64
    AND store_scope_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_event_sha256 TEXT NOT NULL CHECK (
    length(source_event_sha256) = 64
    AND source_event_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_evidence_sha256 TEXT NOT NULL CHECK (
    length(source_evidence_sha256) = 64
    AND source_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  member_record_sha256 TEXT NOT NULL CHECK (
    length(member_record_sha256) = 64
    AND member_record_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, reservation_id, case_ordinal),
  UNIQUE (tenant_id, task_family, case_identity_sha256),
  UNIQUE (tenant_id, task_family, task_id_sha256),
  UNIQUE (tenant_id, task_family, content_workflow_sha256),
  UNIQUE (tenant_id, task_family, store_scope_sha256),
  UNIQUE (tenant_id, task_family, source_event_sha256),
  UNIQUE (tenant_id, member_record_sha256)
);

CREATE TRIGGER trg_lite_learning_external_holdout_member_update
BEFORE UPDATE ON lite_learning_external_holdout_members
BEGIN
  SELECT RAISE(ABORT, 'learning_external_holdout_member_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_external_holdout_member_delete
BEFORE DELETE ON lite_learning_external_holdout_members
BEGIN
  SELECT RAISE(ABORT, 'learning_external_holdout_member_delete_forbidden');
END;

CREATE TABLE lite_learning_external_ticket_consumptions (
  tenant_id TEXT NOT NULL,
  consumption_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  runner_ticket_sha256 TEXT NOT NULL CHECK (
    length(runner_ticket_sha256) = 64
    AND runner_ticket_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  runner_principal_sha256 TEXT NOT NULL CHECK (
    length(runner_principal_sha256) = 64
    AND runner_principal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  broker_process_nonce_sha256 TEXT NOT NULL CHECK (
    length(broker_process_nonce_sha256) = 64
    AND broker_process_nonce_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  consume_operation_id TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  consumption_sha256 TEXT NOT NULL CHECK (
    length(consumption_sha256) = 64
    AND consumption_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (tenant_id, consumption_id),
  UNIQUE (tenant_id, reservation_id),
  UNIQUE (tenant_id, runner_ticket_sha256),
  UNIQUE (tenant_id, broker_process_nonce_sha256),
  UNIQUE (tenant_id, consumption_sha256)
);

CREATE TRIGGER trg_lite_learning_external_ticket_consumption_update
BEFORE UPDATE ON lite_learning_external_ticket_consumptions
BEGIN
  SELECT RAISE(ABORT, 'learning_external_ticket_consumption_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_external_ticket_consumption_delete
BEFORE DELETE ON lite_learning_external_ticket_consumptions
BEGIN
  SELECT RAISE(ABORT, 'learning_external_ticket_consumption_delete_forbidden');
END;

CREATE TABLE lite_learning_external_preclaim_holds (
  tenant_id TEXT NOT NULL,
  hold_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  ticket_consumption_id TEXT NOT NULL,
  hold_reason TEXT NOT NULL CHECK (hold_reason IN (
    'sealed_input_mismatch', 'validation_failure', 'preclaim_crash',
    'preclaim_timeout', 'operator_abort', 'broker_integrity_failure'
  )),
  triggering_terminal_fact_sha256 TEXT CHECK (
    triggering_terminal_fact_sha256 IS NULL OR (
      length(triggering_terminal_fact_sha256) = 64
      AND triggering_terminal_fact_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  zero_effects_proof_sha256 TEXT NOT NULL CHECK (
    length(zero_effects_proof_sha256) = 64
    AND zero_effects_proof_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  broker_preclaim_hold_receipt_sha256 TEXT NOT NULL CHECK (
    length(broker_preclaim_hold_receipt_sha256) = 64
    AND broker_preclaim_hold_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  broker_preclaim_hold_receipt_json TEXT NOT NULL CHECK (
    json_valid(broker_preclaim_hold_receipt_json)
    AND length(CAST(broker_preclaim_hold_receipt_json AS BLOB)) <= 16384
  ),
  broker_preclaim_hold_receipt_signature TEXT NOT NULL CHECK (
    length(CAST(broker_preclaim_hold_receipt_signature AS BLOB)) BETWEEN 32 AND 1024
  ),
  hold_actor_id TEXT NOT NULL,
  hold_operation_id TEXT NOT NULL,
  held_at TEXT NOT NULL,
  hold_sha256 TEXT NOT NULL CHECK (
    length(hold_sha256) = 64
    AND hold_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (hold_reason = 'operator_abort'
      AND triggering_terminal_fact_sha256 IS NOT NULL)
    OR (hold_reason <> 'operator_abort'
      AND triggering_terminal_fact_sha256 IS NULL)
  ),
  PRIMARY KEY (tenant_id, hold_id),
  UNIQUE (tenant_id, reservation_id),
  UNIQUE (tenant_id, ticket_consumption_id),
  UNIQUE (tenant_id, broker_preclaim_hold_receipt_sha256),
  UNIQUE (tenant_id, hold_sha256)
);

CREATE TRIGGER trg_lite_learning_external_preclaim_hold_update
BEFORE UPDATE ON lite_learning_external_preclaim_holds
BEGIN
  SELECT RAISE(ABORT, 'learning_external_preclaim_hold_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_external_preclaim_hold_delete
BEFORE DELETE ON lite_learning_external_preclaim_holds
BEGIN
  SELECT RAISE(ABORT, 'learning_external_preclaim_hold_delete_forbidden');
END;

CREATE TABLE lite_learning_external_run_claims (
  tenant_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  ticket_consumption_id TEXT NOT NULL,
  ticket_consumption_sha256 TEXT NOT NULL CHECK (
    length(ticket_consumption_sha256) = 64
    AND ticket_consumption_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  runner_principal_sha256 TEXT NOT NULL CHECK (
    length(runner_principal_sha256) = 64
    AND runner_principal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  runner_execution_nonce_sha256 TEXT NOT NULL CHECK (
    length(runner_execution_nonce_sha256) = 64
    AND runner_execution_nonce_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_broker_receipt_sha256 TEXT NOT NULL CHECK (
    length(credential_broker_receipt_sha256) = 64
    AND credential_broker_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_broker_policy_sha256 TEXT NOT NULL CHECK (
    length(credential_broker_policy_sha256) = 64
    AND credential_broker_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_broker_binary_sha256 TEXT NOT NULL CHECK (
    length(credential_broker_binary_sha256) = 64
    AND credential_broker_binary_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_broker_key_id TEXT NOT NULL,
  credential_broker_receipt_json TEXT NOT NULL CHECK (
    json_valid(credential_broker_receipt_json)
    AND length(CAST(credential_broker_receipt_json AS BLOB)) <= 16384
  ),
  credential_broker_receipt_signature TEXT NOT NULL CHECK (
    length(CAST(credential_broker_receipt_signature AS BLOB)) BETWEEN 32 AND 1024
  ),
  credential_session_id_sha256 TEXT NOT NULL CHECK (
    length(credential_session_id_sha256) = 64
    AND credential_session_id_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  supervisor_bind_expires_at TEXT NOT NULL,
  credential_session_expires_at TEXT NOT NULL,
  credential_session_heartbeat_seconds INTEGER NOT NULL CHECK (
    credential_session_heartbeat_seconds BETWEEN 1 AND 60
  ),
  credential_session_max_calls INTEGER NOT NULL CHECK (
    credential_session_max_calls BETWEEN 1 AND 10000
  ),
  claim_operation_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  claim_sha256 TEXT NOT NULL CHECK (
    length(claim_sha256) = 64
    AND claim_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (tenant_id, claim_id),
  UNIQUE (tenant_id, reservation_id),
  UNIQUE (tenant_id, ticket_consumption_id),
  UNIQUE (tenant_id, runner_execution_nonce_sha256),
  UNIQUE (tenant_id, credential_session_id_sha256),
  UNIQUE (tenant_id, credential_broker_receipt_sha256),
  UNIQUE (tenant_id, claim_sha256)
);

CREATE TRIGGER trg_lite_learning_external_run_claim_update
BEFORE UPDATE ON lite_learning_external_run_claims
BEGIN
  SELECT RAISE(ABORT, 'learning_external_run_claim_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_external_run_claim_delete
BEFORE DELETE ON lite_learning_external_run_claims
BEGIN
  SELECT RAISE(ABORT, 'learning_external_run_claim_delete_forbidden');
END;

CREATE TABLE lite_learning_external_supervisor_bindings (
  tenant_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  ticket_consumption_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  credential_session_id_sha256 TEXT NOT NULL CHECK (
    length(credential_session_id_sha256) = 64
    AND credential_session_id_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  runner_principal_sha256 TEXT NOT NULL CHECK (
    length(runner_principal_sha256) = 64
    AND runner_principal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  supervisor_process_identity_sha256 TEXT NOT NULL CHECK (
    length(supervisor_process_identity_sha256) = 64
    AND supervisor_process_identity_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  supervisor_executable_sha256 TEXT NOT NULL CHECK (
    length(supervisor_executable_sha256) = 64
    AND supervisor_executable_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  supervisor_argv_sha256 TEXT NOT NULL CHECK (
    length(supervisor_argv_sha256) = 64
    AND supervisor_argv_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  inherited_channel_sha256 TEXT NOT NULL CHECK (
    length(inherited_channel_sha256) = 64
    AND inherited_channel_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  service_launcher_receipt_sha256 TEXT NOT NULL CHECK (
    length(service_launcher_receipt_sha256) = 64
    AND service_launcher_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  service_launcher_policy_sha256 TEXT NOT NULL CHECK (
    length(service_launcher_policy_sha256) = 64
    AND service_launcher_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  service_launcher_binary_sha256 TEXT NOT NULL CHECK (
    length(service_launcher_binary_sha256) = 64
    AND service_launcher_binary_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  service_launcher_key_id TEXT NOT NULL,
  supervisor_sandbox_policy_sha256 TEXT NOT NULL CHECK (
    length(supervisor_sandbox_policy_sha256) = 64
    AND supervisor_sandbox_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  broker_binding_receipt_sha256 TEXT NOT NULL CHECK (
    length(broker_binding_receipt_sha256) = 64
    AND broker_binding_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  broker_binding_receipt_json TEXT NOT NULL CHECK (
    json_valid(broker_binding_receipt_json)
    AND length(CAST(broker_binding_receipt_json AS BLOB)) <= 16384
  ),
  broker_binding_receipt_signature TEXT NOT NULL CHECK (
    length(CAST(broker_binding_receipt_signature AS BLOB)) BETWEEN 32 AND 1024
  ),
  bind_operation_id TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  binding_sha256 TEXT NOT NULL CHECK (
    length(binding_sha256) = 64
    AND binding_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (tenant_id, binding_id),
  UNIQUE (tenant_id, reservation_id),
  UNIQUE (tenant_id, ticket_consumption_id),
  UNIQUE (tenant_id, claim_id),
  UNIQUE (tenant_id, credential_session_id_sha256),
  UNIQUE (tenant_id, supervisor_process_identity_sha256),
  UNIQUE (tenant_id, inherited_channel_sha256),
  UNIQUE (tenant_id, service_launcher_receipt_sha256),
  UNIQUE (tenant_id, broker_binding_receipt_sha256),
  UNIQUE (tenant_id, binding_sha256)
);

CREATE TRIGGER trg_lite_learning_external_supervisor_binding_update
BEFORE UPDATE ON lite_learning_external_supervisor_bindings
BEGIN
  SELECT RAISE(ABORT, 'learning_external_supervisor_binding_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_external_supervisor_binding_delete
BEFORE DELETE ON lite_learning_external_supervisor_bindings
BEGIN
  SELECT RAISE(ABORT, 'learning_external_supervisor_binding_delete_forbidden');
END;

CREATE TABLE lite_learning_external_session_terminations (
  tenant_id TEXT NOT NULL,
  termination_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  ticket_consumption_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  supervisor_binding_id TEXT,
  credential_session_id_sha256 TEXT NOT NULL CHECK (
    length(credential_session_id_sha256) = 64
    AND credential_session_id_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  termination_reason TEXT NOT NULL CHECK (termination_reason IN (
    'passed', 'failed', 'inconclusive',
    'launch_failure', 'binding_integrity_failure',
    'runner_crash', 'lease_expired', 'operator_revoke',
    'post_quiesce_revoke', 'finalize_timeout'
  )),
  broker_quiesce_receipt_sha256 TEXT CHECK (
    broker_quiesce_receipt_sha256 IS NULL OR (
      length(broker_quiesce_receipt_sha256) = 64
      AND broker_quiesce_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  runner_output_manifest_sha256 TEXT CHECK (
    runner_output_manifest_sha256 IS NULL OR (
      length(runner_output_manifest_sha256) = 64
      AND runner_output_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  terminal_run_manifest_sha256 TEXT CHECK (
    terminal_run_manifest_sha256 IS NULL OR (
      length(terminal_run_manifest_sha256) = 64
      AND terminal_run_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  attempt_chain_sha256 TEXT NOT NULL CHECK (
    length(attempt_chain_sha256) = 64
    AND attempt_chain_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_broker_policy_sha256 TEXT NOT NULL CHECK (
    length(credential_broker_policy_sha256) = 64
    AND credential_broker_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_broker_binary_sha256 TEXT NOT NULL CHECK (
    length(credential_broker_binary_sha256) = 64
    AND credential_broker_binary_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_broker_key_id TEXT NOT NULL,
  broker_terminal_receipt_sha256 TEXT NOT NULL CHECK (
    length(broker_terminal_receipt_sha256) = 64
    AND broker_terminal_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  broker_terminal_receipt_json TEXT NOT NULL CHECK (
    json_valid(broker_terminal_receipt_json)
    AND length(CAST(broker_terminal_receipt_json AS BLOB)) <= 16384
  ),
  broker_terminal_receipt_signature TEXT NOT NULL CHECK (
    length(CAST(broker_terminal_receipt_signature AS BLOB)) BETWEEN 32 AND 1024
  ),
  termination_actor_id TEXT NOT NULL,
  terminate_operation_id TEXT NOT NULL,
  terminated_at TEXT NOT NULL,
  termination_sha256 TEXT NOT NULL CHECK (
    length(termination_sha256) = 64
    AND termination_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (termination_reason IN ('passed', 'failed', 'inconclusive')
      AND supervisor_binding_id IS NOT NULL
      AND broker_quiesce_receipt_sha256 IS NOT NULL
      AND runner_output_manifest_sha256 IS NOT NULL
      AND terminal_run_manifest_sha256 IS NOT NULL)
    OR (termination_reason IN ('post_quiesce_revoke', 'finalize_timeout')
      AND supervisor_binding_id IS NOT NULL
      AND broker_quiesce_receipt_sha256 IS NOT NULL
      AND runner_output_manifest_sha256 IS NOT NULL
      AND terminal_run_manifest_sha256 IS NULL)
    OR (termination_reason IN ('launch_failure', 'binding_integrity_failure')
      AND supervisor_binding_id IS NULL
      AND broker_quiesce_receipt_sha256 IS NULL
      AND runner_output_manifest_sha256 IS NULL
      AND terminal_run_manifest_sha256 IS NULL)
    OR (termination_reason IN (
      'runner_crash', 'lease_expired', 'operator_revoke'
    )
      AND broker_quiesce_receipt_sha256 IS NULL
      AND runner_output_manifest_sha256 IS NULL
      AND terminal_run_manifest_sha256 IS NULL)
  ),
  PRIMARY KEY (tenant_id, termination_id),
  UNIQUE (tenant_id, reservation_id),
  UNIQUE (tenant_id, ticket_consumption_id),
  UNIQUE (tenant_id, claim_id),
  UNIQUE (tenant_id, supervisor_binding_id),
  UNIQUE (tenant_id, credential_session_id_sha256),
  UNIQUE (tenant_id, broker_terminal_receipt_sha256),
  UNIQUE (tenant_id, termination_sha256)
);

CREATE TRIGGER trg_lite_learning_external_session_termination_update
BEFORE UPDATE ON lite_learning_external_session_terminations
BEGIN
  SELECT RAISE(ABORT, 'learning_external_session_termination_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_external_session_termination_delete
BEFORE DELETE ON lite_learning_external_session_terminations
BEGIN
  SELECT RAISE(ABORT, 'learning_external_session_termination_delete_forbidden');
END;
```

The reviewed broker daemon's `reserve-learning-run` is the only formal entry to
`reserve-external`. The daemon first generates the one-time CSPRNG ticket and
fsyncs it together with the canonical reservation request/operation ID in its
owner-only journal. It then supplies those exact bytes to Runtime only on stdin.
Runtime re-derives every candidate, gate, revision, applicability, series,
expected runner, broker policy/session-class, and exact role input/retry/run
binding, hashes the supplied ticket, and inserts the row through a protected
operation. Runtime never generates or returns ticket bytes; path ticket I/O is
forbidden. A crash before commit retries the same protected operation with the
same journaled ticket; a crash after commit re-reads the reservation and proves
the stored hash before returning it. Therefore there is no commit-to-ticket-
fsync loss window, and the acceptance shell can name the reservation but can
never read, create, replace, or replay the ticket.

The v1 Runtime writer does not trust a caller-supplied broker actor for either
reservation or consumption. Before each write, the broker signs a strict
Ed25519 authorization receipt with the public key frozen in the applicable
experiment role. The receipt binds the Runtime database instance, tenant,
artifact kind, evidence series, external role, experiment/revision, run,
operation ID, complete authority-row digest, raw-ticket digest, expected
runner (and consumption nonce where applicable), broker policy/binary/key
identity, and a digest of the complete canonical request. Runtime re-derives
the applicability manifest from the authority DB and compares its digest with
the reservation. That digest is deliberately not embedded in the preregistered
immutable-input manifest because the immutable-input digest is already in the
experiment config covered by the applicability manifest; embedding it would
create a hash cycle. Runtime derives the operation actor from the verified
receipt and persists the exact authorization envelope and digest in the
protected operation receipt.
Runtime attestor, deployment launcher, and broker keys must be pairwise
distinct; the three broker roles may share one reviewed broker key, but no
broker key may mint launcher or Runtime-attestor receipts.

Authorization v1 has a non-extendable window of at most 60 seconds. The
broker-signed `authorized_at` is also the row and operation `recorded_at`;
Runtime's wall clock is freshness authority and accepts a new write only when
the signed time is no more than five seconds ahead and the authorization has
not expired. Integrity replay and database reopen reverify the frozen key,
signature, identity, complete request, signed/recorded time equality, and
original window, but do not apply the current wall clock to an already
committed historical receipt. Exact reservation replay is allowed with
identical canonical bytes. Supplying raw ticket bytes after a committed
consumption is always rejected; recovery reads the committed row and operation
receipt instead.

The broker is likewise the only formal caller of `consume-external-ticket` and
`claim-external`. It owns the raw ticket and broker private key. Before
decrypting, validating, mounting, or requesting capabilities,
it generates a broker-process nonce and sends the ticket only on stdin to
`consume-external-ticket`. Runtime verifies the reservation, ticket hash,
expected runner and nonce and atomically inserts the sole append-only
`lite_learning_external_ticket_consumptions` row. Only after re-reading that
committed digest does the broker atomically materialize the sanitized public
consumption receipt, erase the private ticket journal entry, and begin pre-claim
work. If the client disappears before receiving it, terminal-fact drain later
reconstructs the same bytes from the DB and signed spool. A crash before commit leaves that same daemon-owned entry
as the only retry because no attempt started; a crash at or after commit leaves
inert private bytes at worst, because the unique consumption row permanently
rejects every replay. Startup cleanup erases such inert bytes. Thus every crash
point after formal attempt start is a
result-missing hold, not a hidden retry.

Offline holdout release has an additional fail-closed pre-claim phase. In a
broker-only directory unreadable by the runner, the broker verifies that the
sealed-object reference and ciphertext/source digests equal the immutable input
manifest, decrypts the object, canonicalizes exactly 96 members, and compares
every ordinal and identity/task/content-workflow/store-scope/source-event/
source-evidence/member digest with the reservation and
`lite_learning_external_holdout_members`. It also re-derives the case-set and
execution-order digests. Only an exact match permits the broker to sign the
claim. It then generates a fresh execution nonce and signs a pre-issue
authorization bound to the consumption, ticket hash, nonce, policy, broker
binary/key, credential scope, expected runner, and reservation.
`claim-external` accepts the committed consumption rather than raw ticket bytes,
revalidates every binding, and atomically inserts the sole claim. A wrong
reference, ciphertext, member, count, order, or projection destroys broker
staging bytes, creates no Runtime claim,
issues no capability, exposes no runner-readable mount, and makes no provider
call. The broker signs and fsyncs to its typed terminal-fact spool a zero-effects pre-claim receipt bound to the reservation,
consumption, failure reason, journal phase, and proof that no claim/capability/
mount/provider-call fact exists. Protected `record-external-preclaim-hold`
derives its actor from that receipt and its sole operation ID from the fixed
domain `learning_external_preclaim_hold_v1`, tenant, and receipt digest; it
atomically appends `lite_learning_external_preclaim_holds` while rechecking
that no claim exists. Once this row exists, `claim-external` is permanently
forbidden. A daemon restart after a consumed-but-unclaimed validation crash or
deadline emits and records the same kind of hold rather than retrying pre-claim
work. The immutable reservation is burned and cannot be repaired, but now has a
committable public audit root. Shadow/tool paths perform the same consume step and proceed directly
to signed claim because they have no sealed holdout. After re-reading a
committed matching claim digest, the broker may prepare the already verified
read-only mount, but it remains inaccessible until the exact supervisor binding
below is committed; it is then exposed only through that bound process identity.
The signed claim receipt freezes a fresh opaque credential-session ID,
the non-extendable hard expiry, heartbeat interval, maximum call count, and
per-call capability TTL re-derived from the provision-time external-execution
policy. The session ID is not a bearer secret and no session handle is ever
written to a path. A broker-owned monitor and provider-call proxy, independent
of the invoking shell, mints only single-call broker capabilities lasting at
most 60 seconds for the exact bound supervisor while heartbeat, call-count,
attempt-policy, and hard-expiry checks all pass. The provider secret never
leaves the broker, and the capability cannot call the provider except through
that live session. The hard expiry cannot be renewed or replaced.

The claim operation ID is fixed-domain and derived from tenant plus the signed
claim-receipt digest; claim callers cannot choose it. Launcher and binding
receipts bind both the actual argv digest and the revision-frozen argv-policy
digest. Normal consumption and claim are blocked once the experiment revision
is closed. A binding submitted after closure is accepted only when its signed
claim and binding times prove that it was authorized before closure.
Termination and exact replay remain available so closure cannot strand a live
capability.

`close-reserved-run` is the only path that may consume after revision closure,
and it is also the explicit prerequisite-failure early-stop path before a
global revision closure exists. In one Runtime savepoint it consumes the
private ticket under a fresh signed consumption
authorization and records a signed `operator_abort` pre-claim hold. V1 requires
the supplied triggering digest to resolve to exactly one already committed,
non-passing sibling external termination or pre-claim hold in the same
experiment revision; the target reservation must be distinct, and the signed
hold must bind that digest, its consumption, `closing_reserved_run`, and a
zero-effects proof. A failure inserting either protected row or operation
receipt rolls back both. Ordinary `record-external-preclaim-hold` cannot create
an `operator_abort` branch outside this atomic path.

`claim-learning-run` returns only public claim/conformance receipts and leaves
the journal in `claimed_unbound`. The next operation is the broker's synchronous
`launch-learning-supervisor`, not a caller-selected `attach`. The daemon sends a
claim-bound launch request to the deployment-owned launcher. Before `exec`, the
launcher creates a private socket pair, passes one end only as an inherited file
descriptor to the exact new supervisor, and transfers the other end to the
broker over their authenticated service channel. It signs a spawn receipt that
binds the broker challenge, claim/session, runner UID/GID, executable digest,
the frozen argv-policy digest, canonical argv digest, PID plus kernel
process-start identity, cgroup/service-
manager job identity, and both ends' channel fingerprint. The broker verifies
that receipt and the connected peer credentials, signs a binding receipt, and
invokes protected `bind-external-supervisor`. Runtime re-derives the registered
runner and launch policy, derives the sole operation ID from fixed domain
`learning_external_supervisor_binding_v1`, tenant, claim, and signed binding-
receipt digest (never a caller value), and appends the sole
`lite_learning_external_supervisor_bindings` row. Only after the broker re-reads
that exact row does it atomically change `claimed_unbound -> active` and enable
mount/provider access on the already connected descriptor.

There is no predictable handoff path, first-writer attach API, or bearer token
available to another process. A process with the same runner UID still lacks
the launcher-created descriptor and the receipt-bound PID/start/cgroup/job
tuple, so it cannot win a same-UID race. The supervisor retains the descriptor
and creates a separate pathless socket pair for each registry-approved child it
spawns. Only that exact child's end is inherited; every relay message carries
kernel credentials and is checked against the frozen child executable/argv,
PID/start/cgroup/job tuple. There is no relay listener or filesystem path, the
broker descriptor is stripped before child `exec`, unapproved descendants
inherit neither descriptor, and the launch sandbox blocks ptrace, `/proc` FD
duplication, and `SCM_RIGHTS` transfer. A same-UID sibling or forwarded relay FD
therefore fails the per-message process check. Bind-TTL expiry, launch failure, wrong
executable/argv/peer, or any receipt mismatch is an abnormal non-retryable
termination and never falls back to UID-only authentication. All technical
attempts and wrapper/provider call receipts, including transient failures, form
one append-only attempt chain in the final bundle. Diagnostic calls made
outside this identity boundary are forever ineligible.

The broker is a long-lived daemon under a dedicated OS service identity, not a
detached child of the acceptance shell. Clients use one owner-controlled Unix
socket; the daemon verifies peer UID/GID and process identity on every command,
and a signed challenge/health receipt binds daemon UID/GID, executable/policy/
key digests, socket inode/mode/owner, pre-fsynced-ticket/stdin-only/path-output
enforcement, service-launcher channel identity, and state/spool ACLs. The runner
supervisor owns only the inherited live channel; an approved child owns only
its process-bound relay endpoint. Neither receives a provider credential or
reusable session bearer value.

The broker keeps an owner-only operational session journal with a monotone
normal path `claimed_unbound -> active -> quiescing -> quiesced -> terminating
-> terminated` and abnormal path `claimed_unbound|active|quiescing -> revoking
-> terminated`. It binds
claim/session/binding digests, exact runner-supervisor identity (PID plus
start-time/cgroup/job identity), authenticated heartbeat deadline, hard expiry,
maximum/counted calls, in-flight call set, last issued capability, and
terminal-fact-spool ref. It fsyncs the call-count reservation before proxying each
provider call, so a crash can consume capacity but can never create an
unaccounted call. On broker restart it scans every non-terminal entry and
revokes any expired or unverifiable owner before serving new calls. This private
journal is operational recovery state, not release evidence; only signed public
receipts plus the Runtime termination row are acceptance authority.

Normal runner exit uses an explicit two-phase quiesce. While the runner
supervisor is still alive, after it seals its immutable output manifest, it
calls `quiesce-learning-run`. The broker atomically enters `quiescing`, rejects
new calls, cancels or drains every in-flight provider call, and writes one
terminal success/failure/unknown receipt for every durably reserved call. It
may enter `quiesced` only when the in-flight set is empty and no outcome can
arrive after the chain is sealed; an unresolved call instead takes the abnormal
hold path. The broker then seals the signed public attempt chain, revokes the
provider proxy and any offline holdout mount, destroys decrypted staging bytes,
proves post-revoke capability/provider/mount access is denied, and signs a
quiesce receipt binding claim/session, runner-output manifest, attempt-chain
digest, cleanup proof, and the frozen post-quiesce finalization deadline. Only
after that receipt is fsynced may the supervisor exit cleanly. Exit in
`quiesced` is expected and never becomes `runner_crash`; exit before quiesce
acknowledgment races through one serialized state transition, so exactly the
quiesce or crash path wins.

The public attempt chain is bounded canonical metadata only: ordinal,
reservation/claim/session/call IDs, requested credential-scope digest,
capability and request/response fingerprints, provider status class, retry
linkage, and signed previous/current hashes. It contains no ticket/session
bytes, provider token, prompt, tool payload, or model output.

Every claimed session still ends through one separately signed, append-only
termination. `finalize-learning-run` accepts only a valid `quiesced` session,
re-verifies the quiesce/output/attempt chain and continued access denial, then
signs a terminal receipt binding reservation, consumption, claim, session,
quiesce receipt, runner-output manifest, exact terminal run-manifest,
attempt-chain digest, and `passed|failed|inconclusive` status. It fsyncs that
receipt to the typed terminal-fact spool before Runtime's protected
`terminate-external-session` verifies the registry-frozen broker
key/policy/binary, derives the sole operation ID from the fixed termination
domain, tenant, and receipt digest (never a caller value), persists the sole
`lite_learning_external_session_terminations` row, and exactly replays an
idempotent retry. Only after re-reading that committed termination may the
broker close the live supervisor channel and may ingestion begin. The terminal
receipt also freezes a canonical `termination_actor_id` derived from the
registered broker service identity and key. `terminate-external-session`
derives this actor from the signed receipt and accepts no caller override, so
finalize and recovery replay the same operation body as well as the same
fixed-domain operation ID.

Launcher/process startup failure after claim spools `launch_failure`; wrong
executable/argv/peer/channel or a launcher/broker receipt mismatch spools
`binding_integrity_failure`. Neither reason may be relabeled as a runner crash.
Exit before quiesce, heartbeat loss, hard expiry, pre-quiesce operator
revocation, or an
unresolved in-flight call is handled by the daemon even if the calling shell has
died: it revokes first, denies later calls/mount access, seals the partial
attempt chain, and spools a signed
`launch_failure|binding_integrity_failure|runner_crash|lease_expired|operator_revoke`
receipt with no quiesce or terminal
run-manifest. A quiesced session that is explicitly stopped spools
`post_quiesce_revoke`; one that misses its frozen finalization deadline spools
`finalize_timeout`. Both preserve quiesce/output/attempt-chain bindings but no
terminal run-manifest. `drain-terminal-facts` processes both acknowledged and
unacknowledged pre-claim-hold/session-termination spool entries in canonical
`(fact_kind, receipt_digest)` order. For a pre-claim entry it derives the fixed
`learning_external_preclaim_hold_v1` operation and invokes/replays
`record-external-preclaim-hold`; for a claimed-session entry it derives the
fixed `learning_external_session_termination_v1` operation and invokes/replays
`terminate-external-session`. It accepts no caller prefix or mutation actor,
re-reads the exact committed row, and fsyncs a durable acknowledgment without
deleting the signed receipt. In the same order it atomically exports one
sanitized, self-contained public authority record. A pre-claim record contains
canonical reservation and consumption rows/receipts plus the signed hold
receipt, zero-effects proof, derived operation, and committed hold row/operation
receipt. A claimed record contains canonical reservation, consumption, claim,
optional supervisor binding, their signed public receipts, supervisor spawn/
execution receipts when present, the signed terminal receipt/signature,
complete or partial public attempt chain, optional quiesce/
output bindings, derived operation, and committed Runtime termination row/
operation receipt. Each has a canonical export-manifest digest and stable
reservation-digest subdirectory recorded in the drain manifest. Thus a crash
after any Runtime commit but before a client output write cannot lose public
archive inputs. Private spool bytes, journal state, provider
material, and decrypted inputs are never exported. Exact drain replay must
reproduce the same public bytes.
The read-only `materialize-public-run` client verifies the signed drain manifest
and selects one reservation-digest subdirectory; it never relies on a client
output written during reserve/consume/claim/bind/finalize.

These abnormal terminations cannot manufacture a result; acceptance remains a
non-retryable hold. Every consumed external reservation is covered by exactly
one branch of a tagged union: a content-addressed result bundle; a claimed
`termination_hold` bundle assembled from reservation/consumption/claim,
optional supervisor binding, public termination export, and broker service
launch/health/drain/pre-stop-status receipts; or a `preclaim_hold` bundle assembled from reservation/consumption,
signed pre-claim receipt, committed pre-claim-hold row/operation receipt, and
the zero-effects proof plus the same non-circular service receipts. An unconsumed reservation remains open/missing and may
not manufacture a terminal bundle or appear in a terminal acceptance root. To
end an attempt after another prerequisite fails, the broker may execute the
explicit `close-reserved-run`: it atomically consumes the still-private ticket,
but first fsyncs a close intent bound to the triggering terminal branch. It
destroys the ticket only after committed consumption and appends a signed
`operator_abort` pre-claim hold bound to the
triggering terminal branch, with zero claim/capability/mount/provider calls.
If it crashes between consumption and hold, restart replays that same intent
and fixed-domain hold; it cannot start validation or create a different reason.
This is closure, not a result or retry. A required series with no reservation at
all may remain `unstarted`; a reserved-but-unconsumed series is never terminal.
Neither hold kind is accepted by evidence
ingestion, and either forces the release verdict to `hold` while remaining a
committable audit root. Missing coverage, duplicate coverage, or simultaneous
branches are integrity failures. Public service/binding/quiesce/
attempt-chain/terminal/drain receipts and the Runtime termination fact are
archived; raw credentials, holdout plaintext, private keys, private journal,
and live channel are never archived.

An acceptance-shell cleanup trap is not termination authority. It may request
revoke and drain. First, a signed pre-stop status proves zero active sessions
and zero reserved-unconsumed/private-ticket state, with every spool/pre-claim
terminal fact committed, acknowledged, and publicly
exported; it does not inspect bundle coverage. The result/claimed-hold/pre-claim-
hold bundles are then content-addressed and committed. A separate coverage-
final status references those bundle digests and proves exactly one branch for
every consumed reservation. Only then may the deployment launcher stop the
broker. Coverage-final and service-stop receipts belong to the outer acceptance
lifecycle/root and are forbidden inside any external bundle, preventing a hash
cycle. If Runtime, export, or bundle recovery is temporarily unavailable, the launcher
keeps or restarts the managed daemon, emits a signed `recovery_required`
incident receipt with the canonical recovery command, and leaves acceptance
nonzero. It must never hide drain failure with best-effort cleanup and then stop
the only monitor.

There is one reservation, at most one consumption, at most one pre-claim hold,
at most one claim, at most one supervisor binding, at most one clean quiesce,
at most one session termination, and exactly one terminal coverage branch per
consumed external series. `passed`,
`failed`, and `inconclusive`
results are all sealed, archived, verified, and ingested. The result status
must equal the signed termination reason, and its terminal run-manifest and
attempt-chain digests must match the termination receipt exactly. A reservation
without a result, or a claim without a valid termination, blocks eligible-host
activation. A failed/inconclusive result burns the sole external prerequisite
for that candidate implementation attempt; changing only revision, series,
run ID, seed, or alias cannot retry it. Recovery requires a materially different
registry implementation-contract digest, its sole new confirmatory attempt,
and a fresh disjoint holdout case set. For offline reservation, the same
transaction inserts exactly 96 bounded member rows and verifies their sorted
projection against `case_set_sha256`; tenant/task-family identity and
task/content-workflow/store-scope/source-event uniqueness prevents renamed or
partially recycled cases and permits direct hashed joins against A/A/active
manifests. The implementation digest and source
commit are frozen before the holdout is decrypted or released to the claimed
runner; the tenant/task-family case-set uniqueness index prevents reuse after
outcomes have been seen.

### 7.9 `lite_learning_evidence_artifacts`

Offline paired reruns, production-shadow prerequisites, and tool-E2E reports
currently live outside the Runtime database. A gate cannot be replayable if it
only remembers their paths. The ingestion command therefore validates and
stores a bounded canonical report plus the digest of its raw source bundle.

```sql
CREATE TABLE lite_learning_evidence_artifacts (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN (
    'offline_paired_rerun', 'production_shadow_gate',
    'tool_e2e_gate', 'runtime_integrity_gate'
  )),
  evidence_series_id TEXT NOT NULL,
  external_run_reservation_id TEXT,
  external_ticket_consumption_id TEXT,
  external_run_claim_id TEXT,
  external_supervisor_binding_id TEXT,
  external_session_termination_id TEXT,
  supersedes_artifact_id TEXT CHECK (
    supersedes_artifact_id IS NULL OR supersedes_artifact_id <> artifact_id
  ),
  artifact_status TEXT NOT NULL CHECK (artifact_status IN (
    'passed', 'failed', 'inconclusive'
  )),
  task_family TEXT NOT NULL,
  candidate_policy_id TEXT NOT NULL,
  candidate_policy_version TEXT NOT NULL,
  candidate_policy_implementation_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_implementation_sha256) = 64
    AND candidate_policy_implementation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_policy_config_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_config_sha256) = 64
    AND candidate_policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  applicable_experiment_id TEXT NOT NULL,
  applicable_experiment_revision INTEGER NOT NULL CHECK (
    applicable_experiment_revision >= 1
  ),
  source_experiment_id TEXT,
  source_experiment_revision INTEGER CHECK (
    source_experiment_revision IS NULL OR source_experiment_revision >= 1
  ),
  source_serving_phase TEXT NOT NULL CHECK (source_serving_phase IN (
    'isolated_paired', 'aa', 'shadow', 'active_control', 'external_tool'
  )),
  look_index INTEGER CHECK (look_index IS NULL OR look_index >= 1),
  look_proposal_sha256 TEXT CHECK (
    look_proposal_sha256 IS NULL OR (
      length(look_proposal_sha256) = 64
      AND look_proposal_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  gate_policy_id TEXT NOT NULL,
  gate_policy_version TEXT NOT NULL,
  gate_policy_config_sha256 TEXT NOT NULL CHECK (
    length(gate_policy_config_sha256) = 64
    AND gate_policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_scope_set_sha256 TEXT NOT NULL CHECK (
    length(evidence_scope_set_sha256) = 64
    AND evidence_scope_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_bundle_sha256 TEXT NOT NULL CHECK (
    length(source_bundle_sha256) = 64
    AND source_bundle_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  harness_bundle_sha256 TEXT NOT NULL CHECK (
    length(harness_bundle_sha256) = 64
    AND harness_bundle_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  report_sha256 TEXT NOT NULL CHECK (
    length(report_sha256) = 64 AND report_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  report_json TEXT NOT NULL CHECK (
    json_valid(report_json)
    AND length(CAST(report_json AS BLOB)) <= 524288
  ),
  source_ref TEXT NOT NULL,
  source_commit_id TEXT,
  collected_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  CHECK (
    (artifact_kind = 'runtime_integrity_gate'
      AND external_run_reservation_id IS NULL
      AND external_ticket_consumption_id IS NULL
      AND external_run_claim_id IS NULL
      AND external_supervisor_binding_id IS NULL
      AND external_session_termination_id IS NULL
      AND look_index IS NOT NULL AND look_proposal_sha256 IS NOT NULL)
    OR (artifact_kind <> 'runtime_integrity_gate'
      AND external_run_reservation_id IS NOT NULL
      AND external_ticket_consumption_id IS NOT NULL
      AND external_run_claim_id IS NOT NULL
      AND external_supervisor_binding_id IS NOT NULL
      AND external_session_termination_id IS NOT NULL
      AND supersedes_artifact_id IS NULL
      AND look_index IS NULL AND look_proposal_sha256 IS NULL)
  ),
  UNIQUE (tenant_id, artifact_id),
  UNIQUE (tenant_id, report_sha256),
  UNIQUE (tenant_id, supersedes_artifact_id)
);

CREATE UNIQUE INDEX idx_lite_learning_evidence_series_root
  ON lite_learning_evidence_artifacts(tenant_id, evidence_series_id)
  WHERE supersedes_artifact_id IS NULL;

CREATE UNIQUE INDEX idx_lite_learning_external_result_once
  ON lite_learning_evidence_artifacts(tenant_id, external_run_reservation_id)
  WHERE external_run_reservation_id IS NOT NULL;

CREATE UNIQUE INDEX idx_lite_learning_external_claim_result_once
  ON lite_learning_evidence_artifacts(tenant_id, external_run_claim_id)
  WHERE external_run_claim_id IS NOT NULL;

CREATE UNIQUE INDEX idx_lite_learning_external_consumption_result_once
  ON lite_learning_evidence_artifacts(tenant_id, external_ticket_consumption_id)
  WHERE external_ticket_consumption_id IS NOT NULL;

CREATE UNIQUE INDEX idx_lite_learning_external_termination_result_once
  ON lite_learning_evidence_artifacts(
    tenant_id, external_session_termination_id
  )
  WHERE external_session_termination_id IS NOT NULL;

CREATE UNIQUE INDEX idx_lite_learning_external_binding_result_once
  ON lite_learning_evidence_artifacts(
    tenant_id, external_supervisor_binding_id
  )
  WHERE external_supervisor_binding_id IS NOT NULL;
```

`report_json` is canonical gate input, limited to 512 KiB, and excludes raw
prompts and provider traces. The raw bundle may remain in the eval archive, but
its digest and immutable source reference are mandatory. Replaying a gate uses
these persisted reports plus the cutoff-bounded online cohort.

The first implemented pre-ingestion contract checkpoint is
`aionis_learning_external_*_v1` in
`src/memory/learning-external-evidence.ts`. It freezes an acyclic content graph:
strict kind-specific report plus source/attempt facts, pre-terminal payload-set,
runner-output manifest, terminal run-manifest, signed normal termination,
live-DB lifecycle comparison projection, and finally the run-bundle manifest.
Archive bytes, archive digest, and Git commit are outside that graph and are
bound only by the later ingest request/operation receipt. Artifact identity
therefore excludes materialization time, archive location/digest, Git commit,
actor, and operation metadata. Offline reports retain per-arm missingness plus
the both-arm and cross-endpoint overlap contingencies for the fixed 96-case
set; pair coverage is therefore exact, while risk derives candidate-missing-
as-loss versus recorded-missing-as-no-loss internally. Missing cases cannot be
selectively removed. Production/tool runs whose only defect is incomplete
authority remain canonical `inconclusive` results rather than becoming
unparseable; any observed safety or outcome failure takes precedence as
`failed`. Every report's status/reason codes are derived rather than
caller-selected.

**Implementation checkpoint (2026-07-17, Task 8.2C-2):** Runtime now has the
self-contained public-authority and protected store boundary that C-1
deliberately left absent. `learning-external-public-authority.ts` defines a
strict signed service-launch receipt, broker-health receipt, and terminal-fact
drain receipt. The acyclic public payload contains the complete reservation
and holdout rows, ticket consumption, claim, supervisor binding, normal
termination, their five protected operation receipts, and the five C-1 report/
attempt/runner/terminal/lifecycle bodies. The drain signs a payload digest and
the outer public-run authority then contains payload plus drain, so neither
signature nor archive identity depends on a hash fixed point. Verification is
anchored to the revision-frozen broker and service-launcher keys, policies,
binaries, key IDs, and database lineage; digest-only launch, health, or drain
claims are not authority.

The store exports one normal-lifecycle snapshot resolver that reuses the
existing reservation/consumption/claim/binding/termination signature and
operation validators rather than duplicating trust logic. The dedicated
external-evidence validator compares every public row, declared lifecycle ID,
operation receipt, holdout member, and lifecycle projection exactly against
that live snapshot, then runs the C-1 cross-contract validator. Inside the
shared Runtime transaction, the protected writer appends the content-addressed
evidence row, reads its real `row_id` and unique series-head row, builds the
bounded post-transaction projection, and appends the
`learning_evidence_ingest_v1` protected operation receipt in one savepoint.
The operation stores the request's bundle commit in `commit_id` and persists
the bounded complete public authority plus run-bundle manifest. An exact
operation replay returns the first persisted row/receipt byte-for-byte and
retains its original ingestion time; changed request, actor, public authority,
run bundle, artifact identity, report digest, series, or lifecycle prefix is a
conflict.

The identical read-only validator is also wired into Runtime open, explicit
integrity verification, backup, and restore through a bidirectional
operation-to-artifact verifier. It reconstructs signatures, content identity,
real artifact/series-head row IDs, and the protected receipt for every external
artifact, rejects an artifact without an ingest operation, an operation without
an artifact, duplicate mappings, and any mutated live lifecycle. Only after
that verifier was installed was the blanket reopen rejection removed. The
generic authority-fact path remains unable to insert any evidence artifact.

**Implementation checkpoint (2026-07-17, Task 8.2C-3):** Runtime now promotes
raw archive bytes and Git tracking into authority without trusting a caller
digest or commit claim. The outer format is a deterministic binary envelope:
fixed magic, bounded canonical manifest length and bytes, bounded member count,
then path/length/raw bytes in manifest order. Verification streams archive and
member hashes, buffers only the six bounded canonical structured roles, never
extracts paths, and rejects path aliases, reordered/duplicate/missing/extra
members, truncation/trailing bytes, and any byte/digest/public-copy mismatch.
The result carries a module-private WeakMap proof over exact archive SHA/length,
manifest SHA, public-authority SHA, and evidence-binding SHA.

The filesystem/Git reader holds `O_NOFOLLOW | O_NONBLOCK` descriptors for both
the archive and the independent canonical public-authority equality witness.
It rechecks device/inode/size/owner/mode/link-count/mtime/ctime, computes the Git
blob OID from those pinned bytes, and requires regular `100644` entries at one
fixed `HEAD`. The stable bundle commit is the most recent ancestor that changed
either evidence file; both blob OIDs must be unchanged from that commit through
the fixed head. This preserves exact replay after unrelated repository commits.
Its opaque capability is bound to the exact archive proof by object identity.
The same boundary now verifies the worktree, Git directory/common directory,
`HEAD`, refs, and object store as owner-controlled, non-delegated filesystem
authority, including linked worktrees, macOS/Linux ACLs, and stable metadata
before and after Git resolution. Alternate object stores, legacy grafts, local
`include`/`includeIf` configuration, symlinks, and group/other-writable control
paths fail closed. Native SHA-1 and SHA-256 repositories are tested. Formal
evidence therefore uses a dedicated, quiescent repository; metadata traversal
is bounded to 8,192 paths and depth 16 rather than allowing an unbounded scan.

The store accepts neither caller-supplied public/run-bundle objects nor a
same-shaped proof: fresh and replay require the prepared capability and compare
all raw/public/manifest/evidence/request/commit bindings internally. The formal
service validates archive/Git before SQLite, pins an existing owner-controlled
current database plus trusted sidecars, and uses a protected existing-only
connection. After `BEGIN IMMEDIATE`, and only then, a module-private issuer
creates an opaque capability bound to that exact protected database, transaction
runner, and AsyncLocal transaction identity. The general ledger exposes no
external-ingest method; a source architecture gate permits the protected
transaction wrapper and ingestion factory to compose only in this service.
Under the lock it runs full integrity and live lifecycle validation, derives
fresh audit time, and performs the artifact+operation savepoint. Bounded BEGIN
retry converts real writer contention into fresh-versus-exact-replay semantics
rather than a second decision path. Once the transaction runner returns, later
serialization or resource-cleanup failure is explicitly classified as
`committed=true` and requires retry with the same operation ID.

The internal `learning-evidence.ts ingest` operator performs strict arguments
and a database/sidecar/archive/public/output collision matrix twice around the
transaction. Database sidecars are derived from the canonical database realpath,
so a symlink spelling cannot hide a real `-wal`, `-shm`, or `-journal` collision.
It publishes the persisted canonical receipt with a `0600` temp, file and
directory fsync, and hard-link no-replace; parent ancestors and parent/temp/
destination ACLs are fail-closed, and an existing output is valid only when
safe and byte-identical. If SIGKILL lands after the destination link but before
temp unlink, the next retry accepts only one marker temp with the same inode,
UID, `0600` mode, two-link count, ACL, length, and exact bytes, then unlinks it
and fsyncs the directory before returning exact replay. A post-commit output or
service-finalization failure is explicitly recoverable with the same operation
ID. Real Git/filesystem, WAL contention, hard process-death at database and
receipt-publication phases, exact replay, output conflict, and archive-independent
reopen tests guard these boundaries. This remains an internal operator command,
not an SDK or package entrypoint; aggregate attestation and release-verdict
authority are later layers.

**Implementation checkpoint (2026-07-17, Task 8.2D-1):** Runtime now has the
strict pure contract for the later signed aggregate, but no new signing or CLI
authority. Required-series status and terminal coverage are fixed ordered
three-role tagged unions. Results support `passed`, `failed`, and
`inconclusive`; termination holds, pre-claim holds, and genuinely unstarted
roles carry their exact terminal identity plus explicit zero result/operation/
head counts. A zero-result aggregate still names all three registered external
series and hashes the canonical empty result tuple.

The replay-stable projection contains no construction timestamp and no release
decision. It binds the registered revision and four-series map, schema and
ledger-verifier identity, launcher DB-binding receipt and database lineage,
canonical status and coverage, the complete C-3 result/ingest/head identity,
and the whole-authority head. The v1 head manifest freezes the full v4 column
order and primary key for 22 append-only learning authority tables, plus the
complete closure of Runtime write operations whose scope is
`learning_external_authority_v1`. Its versioned encoding rejects REAL and unsafe
integers and domain-separates NULL, UTF-8 text, canonical integers, and blobs in
u64be length-prefixed frames.

The Ed25519 envelope is deliberately separate: it signs the projection digest,
DB-binding-receipt digest, committed authority-head digest, revision-frozen
attestor/launcher identities, and attestation time. Verification accepts the
attestor raw public key only after the complete external execution policy is
canonicalized and its digest matches the registered revision; an envelope
cannot substitute its own key. D2 still owns live-v4 reconstruction
and streaming head computation, while D3 owns the launcher-held writer lease,
checkpoint/truncate, inherited-FD identity, private signer channel, and atomic
publication. Until those layers exist, the existing external-head CLI path
remains fail-closed. Task 8.2D certifies factual ingestion coverage only;
Task 8.2E combines that fact with the acceptance archive and exclusively owns
`release_verdict`.

**Implementation checkpoint (2026-07-17, Task 8.2D-2):** Runtime now performs
the live-v4 reconstruction without granting signing authority. The formal
reader requires an active Runtime transaction, pins its AsyncLocal transaction
identity at entry and exit, and accepts only the exact current
`write_projection` v4 schema. It streams the frozen 22-table authority manifest
and the complete external-operation scope in primary-key order. SQLite values
are classified with `typeof`; TEXT and INTEGER are read through raw BLOB bytes;
TEXT must survive fatal UTF-8 round-trip, INTEGER must be canonical decimal and
safe, and REAL is rejected. A non-TEXT scope value with the same bytes as
`learning_external_authority_v1` is an integrity failure rather than an omitted
operation.

The database projector accepts only tenant plus confirmatory-attempt identity
and rederives the revision, candidate/gate policies, four registered series,
status, coverage facts, and result tuples. It uses exact typed full-row digests
for revision, evidence artifact, and Runtime operation rows; parses the exact
canonical C-3 receipt bytes; reuses the normal-lifecycle resolver for results;
and runs the complete ledger-integrity replay in the same transaction. Its
ledger verification `checked_at` is the deterministic maximum of the revision,
attempt, and relevant database terminal-fact times, never caller time. The only
accepted branch vectors are complete result, abnormal claimed termination,
pre-claim hold, and a truly absent current-snapshot series. A normal termination
without its artifact/ingest/current-head triple is rejected as incomplete.

The replay witness freezes the exact 25-table v4 verifier key set rather than
an open count map. Protected plus legacy event counts must equal the episode
event table count; control-job totals must equal the control-job table count;
and the terminal job subclasses cannot exceed that total. The restricted exact
reader exposes only materialized rows. Its operation scan uses a fixed internal
visitor and returns at most the three registered-series operations, so no caller
callback can commit, reopen, or mutate the transaction between streamed rows.
The declared database-lineage instance ID is also checked against the live
Runtime identity row from that same transaction.

The 22-table head is the frozen append-only learning-authority commitment, not
a claim to hash every physical table in the SQLite file. The replay-only
`lite_learning_namespace_leases`, `lite_learning_control_jobs`, and
`lite_runtime_authority_identity` tables are outside that 22-table manifest;
the identity row is separately bound by the live lineage check, while the
mutable lease/job tables remain covered by replay and, at D3, the verified
checkpointed whole-main-file digest. No standalone D2 head may be described as
a whole-physical-database commitment.

The returned contract is explicitly
`unsigned_d2_database_projection_draft_v1` with `signing_eligible=false`.
It contains neither physical database lineage, DB-binding receipt, final
authority head, hold-bundle digest, signature, nor release verdict. In
particular, `unstarted` is only a same-snapshot fact; it becomes terminal only
under D3's launcher-held writer fence. The draft names the D3 capabilities still
required for coverage finality, tracked hold bundles, physical lineage, DB
binding, and a same-transaction full authority head. D3 must rerun/consume these
facts inside its opaque launcher capability and must never accept a caller-made
plain draft as signer input. The external-head CLI therefore remains
fail-closed.

Three D3 prerequisites are intentionally still absent and must not be
simulated with existing APIs. First, the current protected-database pin opens
the canonical path itself; D3 requires a launcher-to-attestor inherited-FD
capability that verifies descriptor identity and lifetime without rebuilding
authority from an argv path. Second, no private signer channel exists yet.
Third, result archives do not provide verified tracked termination/pre-claim
hold bundles; D3 must define and verify those Git/archive closures and carry
their digests only through opaque capabilities. D3 invokes the D2 projector
under those live capabilities and the launcher-held writer fence; it never
accepts a serialized D2 draft as input.

**Implementation checkpoint (2026-07-17, Task 8.2D-3a.1):** Runtime now has
the first independent D3 physical-database boundaries, but no new signing
authority. The launcher-side boundary strictly checks the structured truncate
checkpoint result and zero WAL, acquires and retains a real `BEGIN IMMEDIATE`
writer fence, opens an O_RDONLY main-file descriptor, and freezes/revalidates
its complete filesystem identity, length, and positional SHA-256. It remains
explicitly ineligible for signing until a deployment-slot lease, durable
generation, launcher binding, and private signer capability surround it.

The attestor-side boundary is pathless: a one-shot process adopts only fixed
inherited fd 3 and opens `ro+immutable` SQLite through the platform descriptor
namespace. It accepts no caller fd/path, verifies O_RDONLY plus full identity
and hash, revalidates read-only access at every snapshot assertion, permits one
outermost read snapshot with an opaque transaction owner
and a secret SQLite savepoint guard, and detects descriptor reuse, permission,
transaction restart, or byte changes. Replacing the former filesystem path does
not redirect this inherited object; no claim is made that the path replacement
itself is detected. The module closes SQLite and revokes its capabilities but
never closes borrowed process-lifetime fd 3. It requires Node 22.15 or newer and
records that launcher provenance, checkpoint, and writer-fence authority are
not established by the descriptor alone.

The canonical v1 database-binding receipt is signed by the distinct launcher
key frozen in the external policy. It binds slot, policy, logical and physical
database lineage, positive checkpoint generation, exact zero-checkpoint facts,
writer-fence digest, launcher/attestor identities, issued time, and a
first/successor chain intended for future durable deployment-slot state. The
pure verifier requires an exact caller-supplied expected generation and chain
head; it revalidates a predecessor with its explicitly supplied historical
policy so one slot chain can cross policy and launcher-key rotation. It rejects
branch substitution, device/inode drift, generation reuse/rollback, or time
rollback. Its frozen result is explicitly `cryptographic_relation_only` and
`signing_eligible=false`: it cannot prove that policy, slot, generation, anchor,
chain head, or physical facts came from live authorities. D3 composition must
carry those only through opaque same-snapshot and durable-slot capabilities.

The child-FD, WAL, reader/writer race, descriptor mutation/reuse, transaction
lifetime, signature/key/policy, and chain rollback tests are real filesystem,
SQLite, Ed25519, and child-process tests. The production external-head command
is still disabled. Deployment-slot durability/quiesce, tracked hold archives,
same-snapshot D2/head composition, private signing, and durable publication are
not claimed by this checkpoint.

**Implementation checkpoint (2026-07-17, Task 8.2D-3a.2):** Durable deployment
state is now a distinct launcher-owned authority rather than another table in
the Runtime database being attested. Each caller-configured authority instance
has an immutable registration derived from the opaque protected Runtime-
database pin: canonical path, database-lineage identity, device/inode, one-time
random first-binding anchor, and cross-bound random/physical identities for a
carrier and state database. Their complete SQLite main/sidecar namespaces are
disjoint. The module records a deployment-slot label, but the launcher has not
yet supplied the one-to-one slot-to-path mapping needed to make that label
globally unique.

Carrier and state both use WAL, `synchronous=EXTRA`, `fullfsync=ON`,
`checkpoint_fullfsync=ON`, exact PRAGMA/schema validation, and explicit durable-
file and parent-directory `fsync`. A retained carrier `BEGIN IMMEDIATE` provides
a conditional process-live lock; the secret savepoint proves only that the SQL
transaction was not committed, rolled back, or restarted. On Unix, closing
another descriptor for the same carrier inode in the same process can release
POSIX locks without invalidating that savepoint. Filesystem ownership, mode,
ACL, and link-count checks also do not prove local mount or lock semantics.
Formal use requires a verified local-locking filesystem and an isolated carrier
lock-holder process. No PID, TTL, or wall-clock stale-lock rule performs
takeover. SQLite can recover a trusted crash-retained WAL/SHM pair, while the
protected pin deliberately rejects a lone WAL or SHM sidecar pending a separate
explicit recovery boundary.

The carrier cross-binds the physical state database and stores an initial
semantic witness plus one append-only witness at every clean release. Acquire
replays the complete state and validates every witnessed prefix before creating
the next lease epoch. This rejects a rolled-back or divergent clean-release
state snapshot only while the carrier witness remains outside that rollback.
It does not detect a joint carrier+state snapshot rollback or rollback within
the last crash/unwitnessed lease. Consequently `fsync` is crash durability, not
anti-rollback, and irreversible burn requires a non-rollback state authority or
an external monotonic witness in another rollback domain.

Within one current non-rolled-back authority-instance lineage, checkpoint
generations are canonical unsigned-64 text. Recovery append-only abandons an
orphan, so receipt generations may skip while reservation history remains a
complete monotonic sequence. The first anchor is used whenever that lineage has
no completion head, even after burns. Every completion stores the full canonical
launcher-signed envelope and execution policy, preserving the historical key
needed to reverify predecessors across rotation. Reopen checks the full
reservation sequence, operation/lease/terminal binding, physical database,
receipt digest/signature, predecessor, generation, time, and historical policy.

Finalization consumes only WeakMap-branded lease, reservation, and prepared-
completion capabilities. It derives anchor, head, and generation from durable
state and re-runs the policy-fixed verifier; commit makes the receipt the head
of the current lineage and a commit/response retry returns exact stored bytes.
This remains a signing-ineligible substrate, not a production signer or complete
slot authority. Missing boundaries are verified filesystem locking, isolated
carrier ownership, launcher slot-path mapping, non-rollback state authority,
managed-writer quiesce, live writer-fence and revision-policy capabilities,
private launcher/attestor channels, D2 aggregate, tracked holds, public
publication, release verdict, and multi-host consensus. The external-head
command remains disabled.

For an external kind, ingestion re-resolves the reservation, its sole ticket
consumption, sole claim, sole supervisor binding, and sole session termination
in the same tenant. The
claim body/digest names both consumption ID and SHA; the termination body names
the reservation/consumption/claim/binding/session and binds the signed quiesce receipt,
runner-output manifest, terminal run-manifest, attempt chain, broker
policy/binary/key, and terminal status. Ingestion joins all five facts, requires
exact series/revision/candidate/gate/input bindings, verifies the service-launch,
supervisor-binding, broker health/quiesce/call-chain/terminal signatures, requires the
report status to equal its
`passed|failed|inconclusive` termination reason, and requires exact manifest
and attempt-chain digests before accepting the first terminal bundle. A crash,
expiry, or operator-revoke termination cannot be ingested as a result. An
unconsumed, unclaimed, unterminated, multiply consumed/claimed/terminated,
incomplete, status-mismatched, or selectively truncated run is an integrity
failure, not an opportunity to reserve again.

`artifact_id` is content-addressed from the tenant, artifact kind/series,
task family, applicable revision, candidate/gate IDs plus configuration
digests, evidence scope, optional external reservation or look/proposal binding,
external ticket-consumption/claim/supervisor-binding/session-termination binding,
harness/source-bundle digest, and report digest.
Ingestion inserts the evidence row and a `learning_evidence_ingest_v1`
`lite_runtime_write_operations` receipt in the same transaction. Its canonical
CLI receipt binds the request digest, operation identity, evidence row/content
digest, resulting series head, public-run-authority digest, tracked run-bundle
digest/commit, artifact status, and a bounded database-authority projection
digest for that post-transaction row/series head. Re-ingesting the exact
canonical input returns the existing row and
byte-identical identity projection; reusing an operation ID, artifact ID, or
report digest with different bound metadata is an integrity conflict.
`created_by`, wall-clock ingestion time, and invocation resource measurements
are audit metadata and are not allowed to alter the content identity.

After all terminal branches are known, the dedicated Runtime authority attestor
runs `runtime-data-ops verify` over its launcher-bound live DB descriptor and
exports a signed canonical external-ingestion projection against the committed
terminal coverage index. The signed envelope binds the registered attestor
service/launcher/binary/policy/key identities, database-lineage identity,
schema/verifier versions, committed authority-head digest, exact row/operation
projection digest, and coverage digest. Every `result` branch must resolve to
exactly one matching
ingestion operation receipt, evidence row, and current preregistered series
head; every claimed-termination/pre-claim hold branch must resolve to none.
Coverage and required-series-status files are untrusted claims: the attestor
rederives both mappings from the registered revision and live authority rows
and signs only an exact match.
The authority head is a streaming SHA-256 over schema version, database lineage,
and canonical `(table, primary-key, row-content-digest)` entries for every
append-only learning authority table plus the referenced Runtime write-
operation rows, in fixed table/key order. It is not a max-row ID or mutable
counter and therefore detects deletion, insertion, or substitution outside the
three projected evidence rows as well.
The projection also binds genuinely unstarted required series, so an empty
result set is explicit rather than omitted. The receipts, projection, required-
series status, and coverage index are archived under the separate content-
addressed `external-ingestion` schema. It contains no mutable SQLite path or raw
database. Release-time construction reads and verifies the live authority DB;
fresh-shell verification verifies the attestor signature against the frozen
public key and replays the exported rows, operation receipts, DDL constraints,
content identities, committed authority head, and exact coverage-to-series
mapping from the committed bundle. Unsigned or caller-self-signed projections
are rejected. A terminal run bundle by itself is therefore never treated as
proof that Runtime accepted its result.

Each required role names one preregistered `evidence_series_id` in the active
experiment revision. The three external series accept exactly one root, bound
to their pre-run reservation; external successors and unreserved reports are
forbidden. Runtime-integrity alone is a strict linear look chain. Branches and
reuse across task family, policy configuration, scope set, or applicable
revision conflict. At a cutoff the gate deterministically selects the only
external root and the current integrity head. The four series IDs are frozen
when the active revision is created. Offline/shadow/tool results—pass, fail, or
inconclusive—are generated against the reserved exact applicability/input
manifests, archived, and ingested before any `eligible_host` active traffic is
served. A non-passing root permanently holds that implementation attempt; a
same-implementation revision or series cannot repair it. Runtime-integrity
heads are generated and reserved atomically at each checkpoint. A later
Runtime-integrity failure is a candidate-implementation safety veto and makes
prior readiness stale during adjudication even though it does not rewrite the
already-reserved artifact chain.

For Runtime-integrity, generic `ingest` is forbidden. The root is look 1 and
every successor inserted by `reserve-look` must name the immediately preceding
reserved look's head and `look_index + 1`; the transaction rejects gaps,
reordering, or a proposal digest that is not the next registered unreserved
look. `propose-look` always selects the smallest registered index without a
reservation after proving every prior index is both reserved and evaluated.
Thus an operator
cannot insert a same-look replacement or append an older-cutoff report after a
newer reserved head.

The look order is non-circular: outcome-blind `propose-look` derives the
historical candidate cutoff and a proposal digest; the Runtime verifier produces
one integrity report bound to that proposal/cutoff from a canonical
outcome-redacted projection. Feedback labels, action outcomes, measurements,
effect estimates, and any full ledger export are forbidden from that report and
its archived run bundle. The report is archived,
committed, and supplied as a verified content-addressed run bundle to
`reserve-look`. In one protected transaction, `reserve-look` re-derives the
same cutoff, reruns the bounded integrity checks, inserts the next passing
Runtime-integrity artifact head, and freezes that exact head in the reservation.
Malformed input, a wrong proposal/bundle digest, or a proposal/report binding
mismatch is an authorization-safe conflict with zero mutation; caller-supplied
bad bytes can never pause serving. If the correctly bound report or the
in-transaction replay proves an actual schema, ledger, assignment,
configuration, or prerequisite-head integrity fault, neither an artifact nor a
reservation is inserted; the command returns `hold` and records a deterministic
automatic safety stop through its own internal authority operation. Repairing
the verifier input cannot erase that persisted pause for the candidate
implementation. An
operator therefore cannot reserve first and choose a report later, manufacture
a same-look corrective head, or spend a look on a report that failed integrity.
The proposal's authority-projection digest is canonical logical state, not a
raw SQLite-file hash: it covers schema/policy/attempt rows and
assignment/source/integrity facts only through its event/artifact cutoffs.
Legitimate post-cutoff feedback cannot perturb it, while any mutation of a
cutoff-bounded fact, required prerequisite head, or configuration fails replay.

### 7.10 `lite_learning_gate_look_reservations`

Fixed looks are machine-reserved once; an operator cannot choose a favorable
cutoff or future `analysis_at`.

```sql
CREATE TABLE lite_learning_gate_look_reservations (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  task_family TEXT NOT NULL,
  candidate_policy_id TEXT NOT NULL,
  candidate_policy_version TEXT NOT NULL,
  candidate_policy_implementation_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_implementation_sha256) = 64
    AND candidate_policy_implementation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  experiment_id TEXT NOT NULL,
  experiment_revision INTEGER NOT NULL CHECK (experiment_revision >= 1),
  gate_policy_id TEXT NOT NULL,
  gate_policy_version TEXT NOT NULL,
  gate_policy_config_sha256 TEXT NOT NULL CHECK (
    length(gate_policy_config_sha256) = 64
    AND gate_policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  look_schedule_sha256 TEXT NOT NULL CHECK (
    length(look_schedule_sha256) = 64
    AND look_schedule_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  randomization_pair_manifest_sha256 TEXT NOT NULL CHECK (
    length(randomization_pair_manifest_sha256) = 64
    AND randomization_pair_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  activation_schedule_sha256 TEXT NOT NULL CHECK (
    length(activation_schedule_sha256) = 64
    AND activation_schedule_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  look_index INTEGER NOT NULL CHECK (look_index >= 1),
  target_cumulative_pair_count INTEGER NOT NULL CHECK (
    target_cumulative_pair_count >= 1
  ),
  analysis_at TEXT NOT NULL,
  evidence_cutoff_event_row_id INTEGER NOT NULL CHECK (
    evidence_cutoff_event_row_id >= 0
  ),
  evidence_artifact_cutoff_row_id INTEGER NOT NULL CHECK (
    evidence_artifact_cutoff_row_id >= 1
  ),
  candidate_scheduled_namespace_count INTEGER NOT NULL CHECK (
    candidate_scheduled_namespace_count = target_cumulative_pair_count
  ),
  control_scheduled_namespace_count INTEGER NOT NULL CHECK (
    control_scheduled_namespace_count = target_cumulative_pair_count
  ),
  candidate_index_exposure_count INTEGER NOT NULL CHECK (
    candidate_index_exposure_count BETWEEN 0 AND candidate_scheduled_namespace_count
  ),
  control_index_exposure_count INTEGER NOT NULL CHECK (
    control_index_exposure_count BETWEEN 0 AND control_scheduled_namespace_count
  ),
  candidate_no_index_count INTEGER NOT NULL CHECK (
    candidate_no_index_count >= 0
    AND candidate_no_index_count + candidate_index_exposure_count
      = candidate_scheduled_namespace_count
  ),
  control_no_index_count INTEGER NOT NULL CHECK (
    control_no_index_count >= 0
    AND control_no_index_count + control_index_exposure_count
      = control_scheduled_namespace_count
  ),
  candidate_verified_receipt_count INTEGER NOT NULL CHECK (
    candidate_verified_receipt_count BETWEEN 0 AND candidate_scheduled_namespace_count
  ),
  control_verified_receipt_count INTEGER NOT NULL CHECK (
    control_verified_receipt_count BETWEEN 0 AND control_scheduled_namespace_count
  ),
  runtime_integrity_artifact_id TEXT NOT NULL,
  runtime_integrity_report_sha256 TEXT NOT NULL CHECK (
    length(runtime_integrity_report_sha256) = 64
    AND runtime_integrity_report_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  runtime_integrity_run_bundle_sha256 TEXT NOT NULL CHECK (
    length(runtime_integrity_run_bundle_sha256) = 64
    AND runtime_integrity_run_bundle_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  required_artifact_heads_sha256 TEXT NOT NULL CHECK (
    length(required_artifact_heads_sha256) = 64
    AND required_artifact_heads_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  trigger_basis_sha256 TEXT NOT NULL CHECK (
    length(trigger_basis_sha256) = 64
    AND trigger_basis_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  trigger_basis_json TEXT NOT NULL CHECK (json_valid(trigger_basis_json)),
  reservation_sha256 TEXT NOT NULL CHECK (
    length(reservation_sha256) = 64
    AND reservation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, reservation_id),
  UNIQUE (tenant_id, operation_id),
  UNIQUE (
    tenant_id, task_family, candidate_policy_id, candidate_policy_version,
    candidate_policy_implementation_sha256, experiment_id,
    experiment_revision, gate_policy_id, gate_policy_version,
    look_index
  )
);
```

`status`/`propose-look` and the proposal-bound Runtime-integrity verifier scan
only pair/wave assignment, index/verified-receipt presence, and source/integrity
fields; receipt outcome labels, action outcomes, measurements, and effect
estimates are not selected, returned, or hashed into their report/run bundle.
The labeled cutoff-bounded ledger export is created only after reservation for
`freeze-online`/evaluation. `reserve-look` uses the immutable wave's
`wave_analysis_at`, after the index window plus maximum 24-hour follow-up, and
requires the exact cumulative pair prefix. A quiet namespace contributes to
`*_no_index_count`; it cannot delay the cutoff or be replaced. Missing and
neutral outcomes therefore cannot move the cutoff. Runtime resolves the index,
pair target, and alpha allocation from the immutable gate policy and verifies
the look/pair/activation schedule digests; callers cannot supply a target.
It derives the event cutoff and current prerequisite-series heads itself,
verifies and inserts the proposal-bound Runtime-integrity head in the same
transaction as the reservation, and rejects
`analysis_at > created_at`. Swapping all positive, negative, and neutral labels
must produce the same reservation. Gate policy v1 registers exactly looks 1, 2,
and 3 at cumulative 96/192/384 matched pairs, but the table is versioned
rather than hard-coded to that schedule. Exact retry replays, and a second
cutoff for the same registered look conflicts. Evaluation can only consume a
reservation, never raw operator-supplied time/head flags.

### 7.11 `lite_learning_gate_decisions`

Task-family evidence evaluation and authority adjudication aggregate many
episodes and therefore have their own append-only ledger. Evidence readiness
and authority mutation are intentionally separate stages.

```sql
CREATE TABLE lite_learning_gate_decisions (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  task_family TEXT NOT NULL,
  candidate_policy_id TEXT NOT NULL,
  candidate_policy_version TEXT NOT NULL,
  candidate_policy_implementation_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_implementation_sha256) = 64
    AND candidate_policy_implementation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  experiment_id TEXT NOT NULL,
  experiment_revision INTEGER NOT NULL CHECK (experiment_revision >= 1),
  gate_policy_id TEXT NOT NULL,
  gate_policy_version TEXT NOT NULL,
  look_index INTEGER CHECK (look_index IS NULL OR look_index >= 1),
  look_reservation_id TEXT,
  look_reservation_sha256 TEXT CHECK (
    look_reservation_sha256 IS NULL OR (
      length(look_reservation_sha256) = 64
      AND look_reservation_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  decision_kind TEXT NOT NULL CHECK (decision_kind IN (
    'evidence_evaluation', 'authority_adjudication', 'safety_stop'
  )),
  evidence_verdict TEXT NOT NULL CHECK (evidence_verdict IN (
    'hold', 'promotion_ready', 'pause_required',
    'demotion_ready', 'retirement_ready'
  )),
  authority_action TEXT CHECK (authority_action IS NULL OR authority_action IN (
    'hold', 'promote', 'pause', 'demote', 'retire'
  )),
  authority_scope TEXT NOT NULL CHECK (authority_scope IN (
    'experiment_revision', 'task_family_candidate_implementation'
  )),
  analysis_at TEXT NOT NULL,
  evidence_cutoff_event_row_id INTEGER NOT NULL CHECK (
    evidence_cutoff_event_row_id >= 0
  ),
  evidence_artifact_cutoff_row_id INTEGER NOT NULL CHECK (
    evidence_artifact_cutoff_row_id >= 0
  ),
  evidence_artifact_count INTEGER NOT NULL CHECK (
    evidence_artifact_count >= 0
  ),
  experiment_config_sha256 TEXT NOT NULL CHECK (
    length(experiment_config_sha256) = 64
    AND experiment_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_scope_set_sha256 TEXT NOT NULL CHECK (
    length(evidence_scope_set_sha256) = 64
    AND evidence_scope_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_cohort_sha256 TEXT NOT NULL CHECK (
    length(evidence_cohort_sha256) = 64
    AND evidence_cohort_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_artifact_set_sha256 TEXT NOT NULL CHECK (
    length(evidence_artifact_set_sha256) = 64
    AND evidence_artifact_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_summary_sha256 TEXT NOT NULL CHECK (
    length(evidence_summary_sha256) = 64
    AND evidence_summary_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_summary_json TEXT NOT NULL CHECK (json_valid(evidence_summary_json)),
  decision_sha256 TEXT NOT NULL CHECK (
    length(decision_sha256) = 64 AND decision_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  trigger_ref_kind TEXT CHECK (trigger_ref_kind IS NULL OR trigger_ref_kind IN (
    'episode_feedback', 'control_job', 'gate_evaluation', 'assignment_integrity',
    'artifact_integrity', 'ledger_integrity', 'config_integrity'
  )),
  trigger_ref_id TEXT,
  trigger_episode_id TEXT,
  supersedes_decision_id TEXT CHECK (
    supersedes_decision_id IS NULL OR supersedes_decision_id <> decision_id
  ),
  basis_evidence_decision_id TEXT,
  authority_mutation_id TEXT,
  source_commit_id TEXT,
  adjudication_observed_event_head_row_id INTEGER CHECK (
    adjudication_observed_event_head_row_id IS NULL
    OR adjudication_observed_event_head_row_id >= 1
  ),
  adjudication_observed_artifact_head_row_id INTEGER CHECK (
    adjudication_observed_artifact_head_row_id IS NULL
    OR adjudication_observed_artifact_head_row_id >= 0
  ),
  post_cutoff_safety_sha256 TEXT CHECK (
    post_cutoff_safety_sha256 IS NULL OR (
      length(post_cutoff_safety_sha256) = 64
      AND post_cutoff_safety_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  authorization_kind TEXT NOT NULL CHECK (authorization_kind IN (
    'none', 'signed_operator', 'safety_automatic'
  )),
  authorization_sha256 TEXT CHECK (
    authorization_sha256 IS NULL OR (
      length(authorization_sha256) = 64
      AND authorization_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  authorization_payload_json TEXT CHECK (
    authorization_payload_json IS NULL OR (
      json_valid(authorization_payload_json)
      AND length(CAST(authorization_payload_json AS BLOB)) <= 65536
    )
  ),
  authorization_mac TEXT,
  authorization_nonce TEXT,
  authorization_expires_at TEXT,
  authorization_key_id TEXT,
  approved_by TEXT,
  authority_operation_id TEXT,
  authority_operation_scope TEXT,
  authority_operation_kind TEXT CHECK (
    authority_operation_kind IS NULL
    OR authority_operation_kind = 'learning_gate_authority_v1'
  ),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (
      decision_kind = 'evidence_evaluation'
      AND authority_action IS NULL
      AND authority_scope = 'experiment_revision'
      AND basis_evidence_decision_id IS NULL
      AND trigger_ref_kind IS NULL
      AND trigger_ref_id IS NULL
      AND trigger_episode_id IS NULL
      AND look_index IS NOT NULL
      AND (
        (look_index = 1 AND supersedes_decision_id IS NULL)
        OR (look_index > 1 AND supersedes_decision_id IS NOT NULL)
      )
      AND evidence_cutoff_event_row_id >= 1
      AND evidence_artifact_cutoff_row_id >= 1
      AND look_reservation_id IS NOT NULL
      AND look_reservation_sha256 IS NOT NULL
      AND adjudication_observed_event_head_row_id IS NULL
      AND adjudication_observed_artifact_head_row_id IS NULL
      AND post_cutoff_safety_sha256 IS NULL
      AND authorization_kind = 'none'
      AND authorization_sha256 IS NULL
      AND authorization_payload_json IS NULL
      AND authority_operation_id IS NULL
      AND authority_operation_scope IS NULL
      AND authority_operation_kind IS NULL
    )
    OR (
      decision_kind = 'authority_adjudication'
      AND authority_action IS NOT NULL
      AND basis_evidence_decision_id IS NOT NULL
      AND trigger_ref_kind IS NULL
      AND trigger_ref_id IS NULL
      AND trigger_episode_id IS NULL
      AND supersedes_decision_id IS NULL
      AND look_index IS NOT NULL
      AND evidence_cutoff_event_row_id >= 1
      AND evidence_artifact_cutoff_row_id >= 1
      AND look_reservation_id IS NOT NULL
      AND look_reservation_sha256 IS NOT NULL
      AND adjudication_observed_event_head_row_id IS NOT NULL
      AND adjudication_observed_artifact_head_row_id IS NOT NULL
      AND post_cutoff_safety_sha256 IS NOT NULL
      AND authorization_kind = 'signed_operator'
      AND authorization_sha256 IS NOT NULL
      AND authorization_payload_json IS NOT NULL
      AND authority_operation_id IS NOT NULL
      AND authority_operation_scope IS NOT NULL
      AND authority_operation_kind = 'learning_gate_authority_v1'
    ) OR (
      decision_kind = 'safety_stop'
      AND evidence_verdict = 'pause_required'
      AND authority_action = 'pause'
      AND authority_scope = 'task_family_candidate_implementation'
      AND trigger_ref_kind IS NOT NULL
      AND trigger_ref_id IS NOT NULL
      AND (
        trigger_ref_kind <> 'episode_feedback'
        OR trigger_episode_id IS NOT NULL
      )
      AND basis_evidence_decision_id IS NULL
      AND supersedes_decision_id IS NULL
      AND look_index IS NULL
      AND look_reservation_id IS NULL
      AND look_reservation_sha256 IS NULL
      AND authorization_kind = 'safety_automatic'
      AND authorization_sha256 IS NOT NULL
      AND authorization_payload_json IS NOT NULL
      AND authority_operation_id IS NOT NULL
      AND authority_operation_scope IS NOT NULL
      AND authority_operation_kind = 'learning_gate_authority_v1'
    )
  ),
  CHECK (
    authority_action IS NULL OR authority_action = 'hold'
    OR (authority_action = 'promote' AND evidence_verdict = 'promotion_ready')
    OR (authority_action = 'pause' AND evidence_verdict = 'pause_required')
    OR (authority_action = 'demote' AND evidence_verdict = 'demotion_ready')
    OR (authority_action = 'retire' AND evidence_verdict = 'retirement_ready')
  ),
  CHECK (
    authority_action NOT IN ('promote', 'demote', 'retire')
    OR authority_mutation_id IS NOT NULL
  ),
  CHECK (
    authority_action NOT IN ('promote', 'pause', 'demote', 'retire')
    OR authority_scope = 'task_family_candidate_implementation'
  ),
  CHECK (
    authorization_kind <> 'signed_operator'
    OR (
      authorization_key_id IS NOT NULL
      AND approved_by IS NOT NULL
      AND authorization_mac IS NOT NULL
      AND authorization_nonce IS NOT NULL
      AND authorization_expires_at IS NOT NULL
    )
  ),
  CHECK (
    authorization_kind = 'signed_operator'
    OR (
      authorization_key_id IS NULL
      AND approved_by IS NULL
      AND authorization_mac IS NULL
      AND authorization_nonce IS NULL
      AND authorization_expires_at IS NULL
    )
  ),
  CHECK (
    authorization_kind <> 'safety_automatic'
    OR (authority_action = 'pause' AND evidence_verdict = 'pause_required')
  ),
  CHECK (
    authority_action NOT IN ('demote', 'retire')
    OR authorization_kind = 'signed_operator'
  ),
  UNIQUE (tenant_id, decision_id),
  UNIQUE (
    tenant_id, authority_operation_scope,
    authority_operation_kind, authority_operation_id
  ),
  UNIQUE (
    tenant_id, task_family, candidate_policy_id,
    candidate_policy_version, candidate_policy_implementation_sha256,
    experiment_id, experiment_revision,
    gate_policy_id, gate_policy_version, decision_kind,
    look_index, evidence_cutoff_event_row_id,
    evidence_artifact_cutoff_row_id, analysis_at
  )
);

CREATE UNIQUE INDEX idx_lite_learning_gate_decision_one_superseder
  ON lite_learning_gate_decisions(tenant_id, supersedes_decision_id)
  WHERE decision_kind = 'evidence_evaluation'
    AND supersedes_decision_id IS NOT NULL;

CREATE UNIQUE INDEX idx_lite_learning_gate_authorization_nonce
  ON lite_learning_gate_decisions(
    tenant_id, authorization_key_id, authorization_nonce
  )
  WHERE authorization_kind = 'signed_operator';
```

### 7.12 `lite_learning_gate_artifact_memberships`

An artifact-set hash is not reversible. Every evidence evaluation therefore
persists the exact ordered members it consumed.

```sql
CREATE TABLE lite_learning_gate_artifact_memberships (
  tenant_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_role TEXT NOT NULL CHECK (artifact_role IN (
    'offline_primary', 'production_shadow', 'tool_e2e', 'runtime_integrity'
  )),
  role_ordinal INTEGER NOT NULL CHECK (role_ordinal >= 0),
  report_sha256 TEXT NOT NULL CHECK (
    length(report_sha256) = 64 AND report_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  membership_sha256 TEXT NOT NULL CHECK (
    length(membership_sha256) = 64
    AND membership_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (tenant_id, decision_id, artifact_id),
  UNIQUE (tenant_id, decision_id, artifact_role, role_ordinal)
);
```

Membership rows exist only for `evidence_evaluation`. The evaluation and all
members commit together. Verification resolves each artifact in the same
tenant, checks role-to-preregistered-series mapping, task family, applicable
revision, candidate/gate configuration digests, scope, chain-head status, and
report digest, requires its `row_id` not exceed
`evidence_artifact_cutoff_row_id`, and recomputes the canonical
role/ordinal/series/artifact/report set digest and count. An authority adjudication
references the exact evaluation through `basis_evidence_decision_id`; it never
selects a new artifact set implicitly.

Here, `chain-head status` is evaluated **as of**
`evidence_artifact_cutoff_row_id`: the selected member has no superseder whose
row ID is at or below that cutoff. A later Runtime-integrity look head therefore
does not corrupt historical replay of an earlier evaluation. Authority
adjudication separately resolves the current prerequisite heads and the highest
reservation/evaluation as vetoes; newer external prerequisite failure or a
higher reserved look can make old readiness unusable without rewriting it.

Evidence `decision_id` is likewise derived from the canonical gate inputs and
verdict, including both cutoffs and `analysis_at`. A repeated evaluation of the
same frozen inputs replays the same decision; any changed cohort, artifact set,
configuration, or verdict produces a different ID and cannot overwrite the old
row.

Evidence evaluations form one strict look-ordered chain for the confirmatory
attempt: look 1 has no superseder reference; every later evaluated look names
the immediately preceding evaluation, and only one row may supersede it. A
newer evaluation supersedes every earlier readiness regardless of whether its
verdict is `hold`, promotion, demotion, or retirement readiness. Authority
adjudication may reference only the highest evaluated registered look, and no
higher reservation may exist. Once a later look is reserved, every older
readiness is blocked until that look is evaluated; its new verdict then
supersedes the old one. An operator therefore cannot inspect a later frozen
outcome export, leave it unevaluated, and sign an older passing look.

`promotion_ready` alone never changes serving. A signed explicit adjudication
must append a second row. The
authority-bearing row is the actual task-family serving mutation consumed by
guide and embeds the validated `PolicyMutationV1`/promotion-evidence digest; it
does not pretend to rewrite environment profile JSON. A safety-stop row is
appended inside the triggering feedback transaction and is itself the durable
serving override.

Guide resolution first folds candidate-implementation safety authority across
every experiment revision and ID/version alias that resolves to the same
implementation-contract digest, then applies the exact-revision state and
profile ceiling. Safety is monotone within one candidate implementation: `retire` outranks
`pause`/`demote`, which outrank `promote`/`hold`, regardless of row creation
order. A new allocation/revision therefore cannot bypass quarantine. `pause` or
`demote` permits control/shadow diagnosis but never active candidate serving;
v1 requires a materially different registry implementation-contract digest to
resume active serving. Read or
digest failure also serves control/shadow. Evidence-only rows have no serving
effect. A separate mutable task-family state table is not introduced in v1.

### 7.13 Append-only enforcement

`BEFORE UPDATE` and `BEFORE DELETE` triggers abort changes to the Runtime
authority identity, policy versions,
collection-principal bindings, experiment revisions, confirmatory attempts,
randomization pairs, experiment closures, authorization nonces, episode events, exposure items,
feedback attributions, host-use receipts,
external-run reservations, external-holdout members, external-ticket
consumptions, external pre-claim holds, external-run claims, external supervisor
bindings, external session terminations, evidence artifacts, look reservations, gate decisions, and gate-artifact
memberships. Namespace leases are the only additional lifecycle table: their
dedicated row trigger permits only `active -> released` while preserving every
acquisition field, and forbids delete. Full-set/ref/generation invariants belong
to the protected store transaction plus reopen verifier, not to a claimed
multi-row trigger capability. Trigger presence is part of schema preflight.

## 8. Event payload contracts

All payloads are strict Zod discriminated unions and bounded before insert.

### 8.1 Exposure

```ts
type ExposureCommittedV1 = {
  contract_version: "aionis_learning_exposure_v1";
  guide_trace_id: string;
  guide_receipt_sha256: string;
  guide_commit_id: string;
  request_sha256: string;
  operation_protection: "protected" | "legacy_unprotected";
  collection_class:
    | "eligible_host"
    | "fixture_pilot"
    | "unverified"
    | "legacy_unclassified";
  collection_principal_sha256: string | null;
  collection_source_policy_sha256: string | null;
  collector_id: string | null;
  collector_version: string | null;
  host_task_id: string | null;
  host_task_envelope: HostTaskEnvelopeV1 | null;
  host_task_envelope_sha256: string | null;
  profile_rule_sha256: string | null;
  experiment_config_sha256: string | null;
  evidence_intent: "integrity_only" | "confirmatory" | null;
  memory_namespace_sha256: string | null;
  namespace_set_sha256: string | null;
  namespace_lease_id: string | null;
  namespace_lease_generation: number | null;
  assignment_reason_codes: string[];
  assignment_algorithm:
    | "matched_pair_csprng_bit_v1"
    | "diagnostic_sha256_48_mod_10000_v1"
    | "fixed_non_randomized_v1"
    | "none";
  assignment_namespace_sha256: string | null;
  candidate_allocation_bps: number | null;
  assignment_bucket: number | null;
  randomization_pair_sha256: string | null;
  matching_covariate_sha256: string | null;
  pair_member_ordinal: 0 | 1 | null;
  activation_wave_index: 1 | 2 | 3 | null;
  activation_starts_at: string | null;
  index_window_ends_at: string | null;
  wave_analysis_at: string | null;
  assignment_arm: "control" | "candidate" | "not_enrolled";
  recorded_surface_sha256: string;
  candidate_surface_sha256: string;
  served_surface_sha256: string;
  projection_complete: boolean;
  hard_boundary_upgrade_count: number;
};
```

The served surface remains authoritative in `lite_product_guide_receipts`; the
episode payload preserves the otherwise-ephemeral policy comparison.
`fixed_non_randomized_v1` is the explicit algorithm for new global or legacy
fixed overrides. Historical `none` payloads and their `unassigned` derived
cache remain immutable and valid; they are never reclassified in place.

Promotion-eligible guide input also carries this strict pre-assignment envelope:

```ts
type HostTaskEnvelopeV1 = {
  contract_version: "host_task_envelope_v1";
  host_task_id: string;
  collector_id: string;
  collector_version: string;
  task_family: string;
  task_signature: string;
  repository_signature: string;
  source_task_sha256: string;
  source_event_sha256: string;
  created_at: string;
};
```

Runtime canonicalizes and hashes it before assignment, binds it into the guide
request digest, persists the bounded canonical body in the exposure payload,
and verifies collector/principal/source-policy equality. `source_task_sha256`
is the stable canonical task identity; `source_event_sha256` is unique per host
guide event. The body cannot contain assignment arm, bucket, pair, bit,
assignment randomness, or collection
class.

### 8.2 Feedback

```ts
type FeedbackAttributedV1 = {
  contract_version: "aionis_learning_feedback_v1";
  feedback_kind: "memory" | "tool_selection";
  guide_trace_id: string;
  request_sha256: string;
  operation_protection: "protected" | "legacy_unprotected";
  run_id: string;
  source_commit_id: string;
  host_use_receipt_sha256: string | null;
  runtime_signal_refs: string[];
  unused_exposure_ids: string[];
};
```

Promotion-eligible memory feedback requires, rather than merely mentions, this
strict receipt:

```ts
type HostUseReceiptV1Body = {
  contract_version: "host_use_receipt_v1";
  receipt_id: string;
  guide_trace_id: string;
  episode_id: string;
  operation_id: string;
  run_id: string;
  host_task_id: string;
  host_task_envelope_sha256: string;
  collector_id: string;
  collector_version: string;
  host_trace_sha256: string;
  observed_at: string;
  items: Array<{
    memory_id: string;
    used_surface: "use_now" | "inspect_before_use" | "do_not_use";
    outcome: "positive" | "negative" | "neutral";
    action_outcome:
      | "accepted_completed"
      | "accepted_incomplete"
      | "rejected"
      | "not_applicable";
    verifier_kind: "instrumented_agent_trace" | "deterministic_scorer";
    verifier_version: string;
    verifier_config_sha256: string;
    verifier_status: "passed";
    content_evidence_sha256: string;
    evidence_ref_sha256: string;
  }>;
};

type HostUseReceiptV1 = HostUseReceiptV1Body & {
  receipt_sha256: string;
};
```

`receipt_sha256 = sha256(stableStringify(HostUseReceiptV1Body))`; the digest
field is never included in its own preimage. Runtime persists that bounded body
in `lite_learning_host_use_receipts` so restart verification does not depend on
the caller replaying a mutable request.

The feedback principal must equal the exposure principal, collector/task hashes
must equal the exposure, every memory must be on the served surface, and the
receipt/operation/request digests are checked before mutation and again inside
the shared transaction. Server receipt time, not client `observed_at`, controls
the 24-hour window. Duplicate memory IDs, generic assertions, unproved
`use_now`, receipt reuse across episodes, and changed retry bodies conflict.
Legacy feedback remains accepted as `legacy_unverified` but cannot satisfy
assessability, coverage, or a gate outcome. Tool feedback keeps its separate
decision evidence and is never forged into a memory-use receipt.

`action_outcome` is independently verifier-backed. Only
`accepted_completed` enters the online utility numerator;
`accepted_incomplete` and `rejected` are observed utility failures, while
`not_applicable` and missing/unverified receipts are missing utility outcomes
and enter the registered worst-case sensitivity. A positive memory outcome does
not by itself imply action completion.

`unused_exposure_ids` is observational context only. It cannot create a negative
label. Direct outcome rows live in `lite_learning_feedback_attributions`.

### 8.3 Effect

```ts
type EffectMeasuredV1 = {
  contract_version: "aionis_learning_effect_v1";
  measurement_id: string;
  measurement_record_sha256: string;
  // Optional only so a persisted historical v1 row can be replayed.
  operation_receipt_sha256?: string | null;
  baseline_episode_id: string;
  after_episode_id: string;
  evidence_status: "sufficient" | "insufficient";
  eligible_for_skill_export: boolean;
};
```

Every fresh effect builder requires `operation_receipt_sha256` to be present.
It is the SHA-256 of the canonical `product_measure_v1` response receipt for a
protected measure and `null` for a fresh unprotected effect. Omission is a
read-compatibility exception for an already persisted historical v1 event only:
the row remains observable and exact-replayable, but authority resolution
returns `effect_receipt_authority_missing`, so it cannot authorize candidate
export or promotion. New missing-field effects are rejected.

Manual measurements remain persistable but do not create an authoritative
effect event or promotion evidence.

## 9. Idempotency contract

Add optional, trimmed, 1-to-256-character `operation_id` to guide, memory
feedback, tool feedback, and measure, including the typed SDK and real host/eval
builders. Reuse `lite_runtime_write_operations` for request-level replay and
use the episode source unique constraint as a second internal defense.

```text
transaction start
  -> read operation receipt
  -> same request digest: return stored product response
  -> different request digest: 409 learning_episode_operation_conflict
  -> execute mutation
  -> append event and item rows
  -> insert operation receipt with exact response
commit
```

Guide performs an indexed operation-receipt replay check before planning,
verifier execution, embedding, or any provider work, then repeats the same
digest check inside `BEGIN IMMEDIATE` before persisting. This mirrors the
existing observe double-check pattern: the early read avoids duplicate external
work on ordinary retry, while the transaction check closes the concurrent
request race. Memory feedback, tool feedback, and measure use the same early
replay plus transaction-recheck pattern wherever they have pre-transaction
work.

Randomized enrollment requires protected operations. A missing operation ID
does not break existing clients; it causes served control/shadow,
`promotion_eligible=false`, and `legacy_unprotected` provenance.

For a guide retry after commit-before-response, the stored operation receipt
must replay the same `guide_trace_id` and agent context. It must not create a
second exposure.

That guarantee intentionally stores the canonical product response in
`lite_runtime_write_operations.receipt_json`. This is an allowed Runtime
artifact under the same tenant, file protection, backup, and retention boundary
as guide receipts and memory nodes. It contains only the already-redacted
response returned to the caller, never the raw request query or provider trace.
The UTF-8 receipt is capped at 2 MiB. A protected guide whose response exceeds
the cap fails with `413 protected_guide_response_too_large` before any receipt,
episode, or operation row commits. This explicit bound is preferable to a retry
that silently reconstructs a different prompt from newer memory state.

## 10. Transaction integration

### 10.1 Guide

Extend the existing transaction in `persistGuideExposure`:

```text
memory evidence node
guide receipt
experiment revision ensure
exposure event
exposure item rows
operation receipt
```

Candidate comparison and assignment occur before the transaction. For an
eligible-host exposure, the insert revalidates experiment/profile digests,
operation identity, finite namespace-set membership, and the exact active
namespace lease under the same `BEGIN IMMEDIATE`. A missing, released,
differently owned, or generation-mismatched lease serves control and cannot
persist a promotion-eligible exposure. A fixture pilot instead revalidates that
its store scope is outside the production set and every active lease and uses
the principal-specific pilot assignment namespace. This transaction-time
check, rather than the earlier resolver read, closes the concurrent close/
provision race.

Enrollment first batch-loads prior state for the complete relevant-memory set,
across every recorded action. A missing node, visibility mismatch, lookup
failure, or any item omitted by the current 96-decision display cap marks the
projection incomplete and serves control; `{}` may not stand in for `no_prior`.
The operator projection may remain bounded for display, but the enrolled ledger
and completeness proof cover every served relevant memory ID.

Before candidate serving, guide resolution verifies the exact-revision state
and the safety-dominant fold across all revisions and ID/version aliases of the
same tenant/task-family/candidate implementation-contract digest. A missing row is normal, but a read
error, invalid digest, `pause`, `demote`, or `retire` fails to control/shadow.
The same fold is recomputed inside the guide transaction so a concurrent safety
stop cannot race a candidate exposure.

### 10.2 Memory feedback

Move the complete activation unit under one outer `withTx`:

```text
operation replay check
guide exposure and surface validation
memory commit and node state projection
feedback event and attribution rows
verified host-receipt header and canonical item bindings, when present
immediate strong-counter/boundary safety posture
boundary-triggered safety-stop gate row and control override
deterministic internal `learning_gate_authority_v1` operation receipt for that stop
operation receipt
```

For `boundary_ignored` or a hard-boundary violation, the feedback event, the
memory's inspect-first posture, and a `safety_stop/pause_required/pause` gate row
commit together. The API may acknowledge success only after all three are
durable; the next guide must observe the pause or fail to control.

The feedback request keeps its existing public operation receipt. Every
automatic safety stop additionally creates a deterministic internal authority
operation ID from the canonical trigger kind/ID, task-family authority scope,
candidate implementation-contract digest, and stop-policy digest, then inserts a second
`lite_runtime_write_operations` receipt of kind
`learning_gate_authority_v1` in that same transaction. Control-job,
assignment/config, artifact, and ledger-integrity stops use the same internal
receipt rule. This is not a second user request and does not replace the
triggering route/job receipt; it is the independently replayable authority
identity required by the safety-stop row.

Repeated-unused learning is not part of direct attribution. The feedback
transaction enqueues a deterministic
`unused_exposure_learning_control_v1` job in
`lite_learning_control_jobs`; enqueue failure rolls back feedback. The response reports
`learning_control_status: queued|already_completed`, not a synchronous posture
claim. A retrying worker applies inspect-first posture under its own protected
operation and marks the durable job completed in that same commit. It can never
produce a negative outcome label or silently delete a dead letter.

### 10.3 Tool feedback

Refactor the current monolith into `prepare / persist / finalize`:

- prepare outside the write transaction: parse, redact, validate guide receipt,
  run optional external review, construct anchor/policy candidates without
  writing, and capture rule/decision digests;
- persist inside the shared transaction: revalidate digests, write commit/rule
  feedback/aggregates/pattern or policy state, append episode facts, and insert
  the exact final product response (including `run_lifecycle`) into the
  operation receipt;
- finalize after commit: embedding or other external side effects, using the
  existing applicable after-commit/outbox boundary for retry.

An external provider call must not be held inside `BEGIN IMMEDIATE`.

### 10.4 Measure and skill review

Add `createLiteSkillCandidateReviewStoreFromDatabase(runtimeDatabase)` and use
the main database and transaction runner. The shared transaction writes:

```text
product measurement with full record digest
primary product_measure_v1 operation receipt, for a protected request
sibling product_measure_receipt_authority_v1 root, for a protected request
effect_measured episode event, exactly when the derived predicate expects one
```

`lite_product_measurements` adds nullable `baseline_episode_id`,
`after_episode_id`, and `record_sha256`. `measurement_digest` binds the effect
report, export decision, evidence status, Runtime evidence IDs, and eligibility
reasons. The full `record_sha256` additionally binds measurement ID, tenant,
scope, source, both episode IDs, `measurement_digest`, `created_by`, and the
canonical UTC-millisecond `created_at`.

A protected measurement carries exactly one immutable evidence marker in its
`runtime_evidence_ids`:

```text
product_measure_operation:<operation_id>:<product_measure_request_sha256>
```

The marker is inside `measurement_digest`, so the measurement independently
retains the operation/request identity. Global integrity requires a one-to-one
set across marker-bearing measurement, primary `product_measure_v1` row, and
sibling authority row for the same tenant, scope, and operation ID. An exact
request replay also revalidates this set before returning the stored response.

The primary receipt stores the canonical product response. The sibling root is
separate canonical JSON that binds tenant, scope, operation ID, primary request
digest, full primary-receipt digest, measurement ID, `measurement_digest`, and
`record_sha256`. Its own request digest is the SHA-256 of that root JSON. Both
rows commit with the measurement and any effect event in one transaction.
Consequently, one protected `/v1/measure` is one logical write but contributes
two physical rows to `lite_runtime_write_operations`; raw operation-row counts
must not be reported as logical measure counts.

Every fresh measurement for which the Runtime will write an effect also carries
exactly one digest marker:

```text
effect_expected_v1:<sha256(canonical tenant/scope/measurement/episode-pair body)>
```

The Runtime adds it only after resolving a complete episode pair and deriving
`source=product_trace` plus `evidence_status=sufficient`; callers cannot opt in.
It is included before `measurement_digest` and `record_sha256` are computed.
Global integrity recomputes the exact marker and requires exactly one matching
`effect_measured` event for protected and unprotected fresh measurements alike.
The low-level fresh-effect append path requires the same marker, so an internal
caller cannot bypass this rule by writing directly to the episode ledger.
Unmarked historical v1 measurements remain readable, while duplicate effect
authority is always an integrity error. Protected measurements that do not meet
the derived effect predicate require zero events. A modern protected effect also
binds the full primary receipt through non-null `operation_receipt_sha256` and
re-resolves the sibling root before candidate enqueue, promotion, or
materialization.

Guide receipt verification binds the canonical ledger JSON to every duplicated
receipt-table identity column, including `run_id`, consumer agent, and consumer
team. The resulting verified receipt run is then required to equal both the
baseline and after episode runs. If a caller omits `task.run_id`, Runtime may
derive it from that closed authority chain; a receipt/episode run disagreement
instead clears the episode pair, marks the measurement insufficient, and writes
no effect marker or event.

This is a corruption-detection boundary, not a signature from an external
trust root. It detects missing rows, one-row changes, unsynchronized primary/
root/measurement edits, paired receipt deletion while the measurement marker
remains, and missing or duplicate expected effects. It does not claim to defeat
an actor with unrestricted database-write access who can coherently rewrite the
measurement, marker, both receipts, all digests, and the linked effect event.
That actor is outside this integrity model and must be controlled by file/DB
authorization, process isolation, and protected backup or external attestation.

### 10.5 Evidence and authority decisions

The evidence-ingestion command validates external prerequisite report contracts
and appends their `lite_learning_evidence_artifacts` before a pure gate runs;
Runtime-integrity artifact insertion is reserved for the atomic
`reserve-look` flow. Evidence evaluation never promotes, demotes, or retires.
Absent a preregistered automatic safety trigger it appends only an evidence row;
when such a trigger fires, the same gate transaction also appends the separate
safety-stop row and its deterministic internal `learning_gate_authority_v1`
operation receipt. Explicit signed adjudication then runs one outer transaction
containing:

```text
BEGIN IMMEDIATE
read current event/artifact heads, experiment/policy configs, and safety fold
replay the approved reserved look at its original statistical cutoff
scan post-cutoff events for harm/integrity and resolve current required-series heads
require the basis evaluation/digests still approved, highest in its look chain,
with no higher reservation, newer evaluation, or failing prerequisite evidence
verify signed operator authorization and authority ceiling
build and digest the bounded PolicyMutationV1/promotion evidence
append the authority-adjudication row that changes guide serving
insert protected operation receipt
```

All stateful evidence CLI commands require explicit database path, tenant, and
actor. Before a formal external call, `reserve-external` also requires the
applicable revision/series plus immutable harness, source, case/profile,
model/tool, execution-order, and retry-policy manifests. Only the broker daemon
may call it with a pre-fsynced stdin ticket; the public
`reserve-learning-run` client receives only the reservation, never ticket
bytes. Artifact ingestion requires that reservation's
consumption, claim, signed quiesce/public attempt chain, terminal Runtime fact,
archived source-bundle/report digests, immutable source reference, and evidence-
series identity. The
proposal and Runtime-integrity bundle are canonical outcome-redacted
projections; label permutation must leave both byte-identical. Online
freeze/evaluation creates and accepts the separate full cutoff-bounded
exported-ledger digest only after a machine-derived look reservation; it never
accepts operator-selected time or heads. There
is no implicit tenant or production path. The export is a read model for
reconciliation, while the reserved cutoff-bounded SQLite rows remain authority.

An old `promotion_ready` is never adjudicated by trust. Promotion requires the
in-transaction replay of the exact reserved look to remain
`promotion_ready`, its cohort and registered-series membership digests to
match, its experiment/policy configs to be unchanged, all current required
series heads to remain passing, the basis row to be the highest evaluated look
in the confirmatory chain with no higher reservation, the post-cutoff safety
scan to be clean, and no task-family candidate-implementation `pause`,
`demote`, or `retire` to exist. Post-cutoff rows are
not silently promoted into a fourth statistical look; they are safety/integrity
vetoes. Because the write transaction is held through authority commit, late
feedback cannot land between the scan and promotion. A stale-ready request
returns conflict/hold with zero authority mutation and records no new look.

An explicit adjudication request is an approval of exact evidence, not only an
experiment name. Its protected request digest binds the approved evidence
decision ID, cohort digest, artifact-set digest, candidate-policy version, and
gate-policy version. In-transaction recomputation must reuse that exact
evidence row; if replay differs or current post-cutoff/series-head checks veto
it, the operation conflicts and the operator must review a later registered
look if one remains unused, or register a materially different implementation
contract and its sole confirmatory revision. A new revision or ID/version alias
of the same implementation digest cannot reset the attempt.

`--actor` is audit text, not authorization. Explicit adjudication requires a
bounded `LearningAuthorityApprovalV1` manifest signed with the Runtime's
existing authority-receipt HMAC keyring. It binds approver, expiry, nonce,
action/scope, evidence decision, reservation/cohort/artifact digests, and
candidate/gate configuration versions. Runtime verifies key ID, MAC, expiry,
and one-time operation binding, then claims the cross-kind
`lite_learning_authorization_nonces` row in the same transaction; the raw secret never appears on the command
line. The authority row persists the bounded canonical approval body, MAC,
nonce, expiry, key ID, approver, and unique `authority_operation_id`; verifier
recomputes its digest after restart and resolves the matching immutable
`lite_runtime_write_operations` receipt by the full tenant/scope/kind/ID key.
The scope is the canonical public authority scope derived from task family and
scope-set digest, and the kind is fixed to `learning_gate_authority_v1`.
Safety-automatic rows persist a
canonical trigger/policy body but no operator MAC. Their deterministic internal
authority receipt uses that same scope/kind and commits with the triggering
domain operation and safety row; verification requires both receipts when a
route/job trigger also has its own operation identity. V1 deliberately has no
automatic promotion/demotion/retirement profile;
safety pause remains automatic. Missing, expired,
wrong-action, wrong-digest, or replayed approval fails closed.

If any step fails, no adjudication row survives. For task-family candidate
serving, the verified authority row is the mutation. Memory-node policy changes
remain on their existing domain path and are not fabricated by this gate.

## 11. Evidence semantics

### 11.1 Descriptive direct-use risk

Keep the familiar percentage, but state its denominator precisely:

```text
negative_direct_use_rate(track, arm)
= negative directly attributed memory-use facts
  / conclusive directly attributed memory-use facts
```

Eligible facts require:

- frozen item track matches the requested slice;
- `served_action = use_now`;
- host `used_surface = use_now`;
- outcome is positive or negative;
- one `(episode_id, memory_id)` active attribution after supersession.

Neutral outcomes, `explicit_host_assertion`, missing feedback, and unused
exposure are reported separately and are not in this denominator. Neutral
outcomes also do not satisfy conclusive-outcome coverage, so they cannot dilute
the harm rate or manufacture an evidence-gate pass.

Every descriptive rate is stratified by `collection_class`; a cross-class
overall percentage may be shown only as a diagnostic with its composition.
Fixture/offline/unverified percentages are never presented as the genuine-host
online gate rate. Reports also separate `verified_host_receipt` from
`legacy_unverified`; only the former can be called verified direct use.

### 11.2 A/B gate metric

Because the candidate is downgrade-only and changes whether direct use occurs,
direct-use rows are a post-treatment denominator. Formal active/control gates
therefore freeze a finite intent-to-treat risk set of matched
store-memory-namespace pairs before any outcome-bearing traffic:

```text
scheduled_risk_set(track, look)
= both members of every pair in the cumulative preregistered activation waves

observed_harm_rate(track, arm)
= conclusive verified units with policy-affected harm
  / conclusive verified harm-outcome units

observed_completion_rate(track, arm)
= conclusive verified units whose affected action outcome is accepted_completed
  / conclusive verified utility-outcome units
```

Neither observed complete-case rate is called ITT by itself. The gate reports
them together with coverage on the frozen risk set and the preregistered
worst-case ITT sensitivity: missing/neutral candidate harm is harmful while
missing/neutral control harm is no-harm; missing candidate utility is rejected
while missing control utility is accepted-completed. Both observed bounds and
the worst-case risk-set bounds must pass for promotion. A statistical demotion
claim uses the reverse conservative sensitivity—missing candidate harm is
no-harm and missing control harm is harmful—so missingness cannot manufacture
`demotion_ready`. Operational pause may still act earlier on integrity or point
estimate safety rules without claiming demotion.

One outcome unit is one server-derived store-memory-namespace cluster, never one
repository, task signature, or guide call. The randomization block is one
pre-outcome matched pair containing two such units. All repositories and task
signatures that resolve to one store scope receive the same arm. Provisioning
rejects concurrently active confirmatory experiments whose profile scope sets
can overlap one memory namespace. Before each look, an interference audit proves
that no canonical store scope, memory ID, host source task, assignment namespace,
mutable cache, provider quota, or treatment-dependent queue can carry state or
capacity between pair members or arms. A provider outage or calendar shock may
affect many pairs; it is allowed as an assignment-independent realized condition,
not assumed away as iid noise. Shared quota/backpressure whose load can be
changed by one arm is interference and causes an integrity hold plus automatic
pause. Repository/task-level counts remain descriptive and cannot increase the
effective pair count.

Gate-policy v1 uses design-based finite-population inference, conditional on the
frozen pair/wave schedule and the realized potential outcomes. Exactly one
member of every pair is assigned candidate by its frozen hidden random bit and the other
control. The gate never models namespace outcomes as iid Bernoulli and never
uses lease disjointness as proof of statistical independence. Its one-sided
bounds are obtained by exact matched-pair randomization inversion: the bounded
absolute-risk and `(E,q,c)` feasibility kernels in §12.1 represent every
compatible pair-level binary potential-outcome schedule and maximize the tail
only after a complete sufficient state is formed. The same engine inverts the
randomized candidate member in each pair to bound absolute candidate harm over
the frozen finite namespace population. This is a finite-population claim, not
a superpopulation claim about unseen tenants or future provider regimes.

The preregistered online estimand has a fixed risk set, activation window, and
follow-up. For each `(experiment revision, assignment_unit_sha256,
learning_track)`, the index is the earliest promotion-eligible exposure inside
its frozen wave window containing a policy-affected item in that track. The
exposure must have `collection_class=eligible_host`, and its authenticated
principal fingerprint must match the frozen experiment source policy. Fixture
pilots, offline paired calls, unverified/auth-off traffic, and legacy backfill
cannot become an index. One episode may index both tracks. The primary outcome
uses only feedback recorded from that index exposure during the 24 hours after
its server-side `recorded_at`; later episodes and late feedback remain
diagnostics. If no qualifying index exists when the wave closes, the already
scheduled unit remains in the risk set with a missing outcome.

An assessable online outcome must come from a `verified_host_receipt` whose
principal, collector, task envelope, episode, memory, surface, operation, and
content-evidence digests all reverify. A legacy/unverified feedback event is
retained for diagnosis but counts as missing outcome in coverage and worst-case
sensitivity; it never supplies harm or utility evidence.

A whole preregistered wave enters a look only at its stored `wave_analysis_at`,
after every possible index exposure's 24-hour follow-up has closed. Missing or neutral memory outcome is unassessable for the
ordinary harm endpoint, never no-harm, unless the same verified unit contains a
`boundary_ignored` or hard-boundary violation, which remains harm regardless of
the task label. A neutral harm label does not discard an independently verified
applicable `action_outcome` from the utility endpoint. Endpoint-specific
coverage, missing-outcome sensitivity, and the paired randomization inversion
use the identical scheduled pair set. Each unit/track can therefore contribute
exactly once for the whole revision. The frozen activation waves are also the
calendar/provider blocking strata; post-outcome rebucketing is forbidden. Within the index episode and follow-up, the unit takes
the worst item outcome using this precedence:

```text
hard_boundary_violation
  > boundary_ignored
  > strong_negative
  > negative
  > no_harm
```

For utility, a unit is `accepted_completed` only when every policy-affected item
that requires a host action has a verified applicable receipt item and all such
items are `accepted_completed`. `rejected` outranks `accepted_incomplete`, which
outranks `accepted_completed`; any `not_applicable` or absent required item
makes the unit missing. Outcome coverage and worst-case missing-outcome
sensitivity are mandatory gate inputs; missing outcomes can never manufacture a
pass.

The 24-hour follow-up, pair membership, matching-covariate digest, activation
times, and wave boundaries are versioned gate-policy inputs, not hidden
implementation constants. The cohort digest covers every scheduled namespace,
assigned pair/arm, index-or-missing status, `analysis_at`, and outcome cutoff, so
replay cannot silently replace a quiet namespace or extend follow-up.

### 11.3 Evidence grade

Online arms run in the same Runtime/database deployment, but they do **not**
share leased store-memory namespaces: the finite namespace manifest, exact
matched-pair assignment, concurrent pair activation, active-lease exclusion,
transaction-time lease check, frozen pre-treatment prior snapshot, and
interference audit are prerequisites for the design-based online bounds. Pair
randomization conditions on common realized provider/calendar shocks; it does
not claim those shocks are independent. Evidence roles are explicit:

- frozen, paired real-Agent replay on the reviewed finite holdout: deterministic
  efficacy regression for those exact cases, only under an immutable execution
  snapshot;
- exact matched-pair namespace-cluster online active/control gray: finite-set
  actual-use safety, assignment integrity, coverage, action completion, and
  drift evidence;
- same-call shadow: projection correctness only.

Task-family promotion requires both the offline finite-holdout regression and
online safety evidence. Neither is called a superpopulation causal estimate:
the holdout is a reviewed finite case set rather than an iid sample, and the
online namespace population does not generalize by itself to future tenants,
models, or provider regimes.

The offline contract is preregistered and paired by 96 frozen assignment units.
Each unit runs recorded and candidate policy from fresh byte-identical copies
of one Runtime database snapshot. Formal-grade execution additionally requires
a genuinely immutable model/runtime snapshot digest, deterministic decoding
seed and kernel, fixed tool versions, counterbalanced order, and reproducible
response fingerprints. A profile with `immutable_snapshot=false` or
`provider_may_update_weights=true` is diagnostic only and forces the active gate
to `hold`; changing only the model label does not satisfy this prerequisite.
The current DeepSeek entries in
`AionisRuntime-evals/external-agent-e2e/configs/model-profiles.json` have exactly
those mutable flags, so they cannot produce formal v1 offline evidence today.

For the exact 96-case finite holdout, define binary loss as harm for the harm
endpoint and non-`accepted_completed` for utility. Report integer
candidate-minus-recorded loss totals over the fixed 96-case denominator. Formal
pass requires candidate harm loss difference at most +5 percentage points,
utility loss difference at most +5 points, and the single preregistered efficacy
contrast—candidate-minus-recorded exploit harm—at most -2 points. All
comparisons use exact integer cross multiplication; no confidence interval,
sampling alpha, or task-family population claim is attached to this finite
regression. Complete-pair values are diagnostic. At least 90% of pairs must be
assessable, and the formal full-risk-set sensitivity codes every missing
candidate endpoint as loss and every missing recorded endpoint as no loss for
both harm and utility. Thus a missing/partial pair can never improve a formal
result. Exploration is a separately reported secondary regression stratum.

The external reservation/ticket-consumption/claim/supervisor-binding/session-termination, immutable
snapshot/case/profile/model/tool/order and retry-policy digests, every bounded
technical attempt, raw bundle, response fingerprints, estimates, and exclusions
are persisted as one
`offline_paired_rerun` artifact. A same-database sequential rerun, a mutable
provider profile, or an unreserved rerun is not formal evidence.

## 12. Versioned task-family gate

The first evidence-policy defaults are conservative configuration, not eternal
Core constants:

```text
familywise_any_direction_alpha             = 1/20
directional_family_alpha                   = 1/40
sequential_method                          = checkpoint_1_safety_then_2_formal_looks
alpha_per_direction_per_formal_look        = 1/80
online_assignment_design                    = matched_pair_complete_randomization_v1
checkpoint_cumulative_matched_pairs         = 96, 192, 384
checkpoint_kinds                            = safety_integrity_only, confirmatory, confirmatory
min_conclusive_exploit_clusters_per_arm         = 96
primary_followup_duration_hours            = 24
activation_wave_pair_counts                = 96, 96, 192
min_distinct_task_signatures               = 6
min_activation_waves                      = 2
min_feedback_coverage                      = 0.90
max_candidate_exploit_harm_upper           = 0.05
exploit_harm_noninferiority_margin         = 0.05
accepted_action_noninferiority_margin      = 0.05
min_offline_paired_harm_reduction           = 0.02
max_hard_boundary_violations               = 0
paired_pre_response_imbalance_threshold    = 0.001
operational_pause_verified_harm_lower_above = 1/20
operational_pause_alpha_per_checkpoint     = 1/1000
missingness_alone_authority_action          = hold
retire_min_independent_demotion_windows     = 2
retirement_required_complete_waves         = 2
```

The calibration-pending code-registry draft currently has four online roles
whose statistic, direction, threshold, alpha, checkpoint set, and missingness
coding are fully determined by this document:

| role | statistic / claim | policy threshold and alpha | missingness coding |
|---|---|---|---|
| exploit candidate absolute-harm readiness | `R1 <= 1/20` | `1/80`, checkpoints 2/3 | candidate missing is loss |
| exploit harm noninferiority | `Delta <= +1/20` | `1/80`, checkpoints 2/3 | candidate missing is loss; control missing is no-loss |
| exploit harm deterioration | `Delta > +1/20` | `1/80`, checkpoints 2/3 | candidate missing is no-loss; control missing is loss |
| verified candidate absolute-harm safety | `R1 > 1/20` | `1/1000`, checkpoints 1/2/3 | candidate missing is no-loss |

The accepted-action noninferiority risk set/track, the policy-affected
exploration endpoint set and margin, and the complete-risk-set encoding for the
separate observed bound are not yet uniquely specified. The scalar-verdict
precedence between checkpoint-1 `hold` and a separate `pause_required` safety
fact also needs one canonical wording. They remain explicit
`unresolved_fail_closed` registry requirements. Until a reviewed policy
amendment closes them, an implementation may evaluate and report the four
fixed roles above but must not claim a complete promotion intersection-union
test or emit `promotion_ready`. This is one reason `gate-policy-v1` remains
`calibration_pending`; implementations must not fill these gaps with local
defaults.

For gate-policy v1, the family is the single registered confirmatory attempt for
one `(tenant, task_family, candidate policy implementation contract)`; aliases
of the same implementation digest cannot open another attempt. The probability
budget for any false online directional claim in that family is exactly `1/20`.
It is split between promotion and demotion directions (`1/40` each), then over
the two formal cumulative looks at 192 and 384 pairs (`1/80` per direction and
formal look). The 96-pair checkpoint is safety/integrity-only: it spends no
confirmatory alpha and can emit only `hold` plus a separate operational safety
fact. Promotion is an intersection-union decision, so requiring every
registered endpoint to pass does not split the directional alpha again. The
offline finite-holdout regression has no sampling alpha and is not included in
the online familywise statement.

#### 12.1 Exact finite-population contract

For readiness, the scheduled finite population contains `n` matched pairs and
`2n` namespaces, where `n` is exactly 192 or 384. The operational absolute-harm
safety test uses the same contract also at `n=96`. In pair `p`, member
`Z_p` receives candidate and member `1-Z_p` receives control; the persisted
assignment bits make the vector `Z` uniform over all `2^n` assignments. For a
binary loss endpoint let `L_pj(1)` and `L_pj(0)` be member `j`'s candidate and
control potential loss. Harm uses harm=`1`; utility uses failure to reach
`accepted_completed`=`1`. Endpoint/direction-specific missing coding is applied
before inference and is part of the frozen cohort digest.

The finite estimands are:

```text
candidate absolute risk R1 = sum[p,j] L_pj(1) / (2n)
candidate-control risk difference Delta
  = sum[p,j] (L_pj(1) - L_pj(0)) / (2n)
```

For a compatible potential-outcome schedule `S` and assignment `z`, the exact
statistics are candidate loss
`T_R(z,S)=sum[p] L_p,z_p(1)` and paired loss contrast
`T_D(z,S)=sum[p](L_p,z_p(1)-L_p,1-z_p(0))`. Compatibility means the schedule
reproduces every observed outcome under the persisted actual assignment; no
unobserved cell is imputed outside the preregistered binary/missingness rules.

To prove an upper threshold `theta <= q` for promotion, the engine takes the
supremum, over every compatible schedule in the unsafe composite null
`theta > q`, of the inclusive lower-tail count
`#{z: T(z,S) <= T_observed}`. To prove deterioration `Delta > q`, it takes the
supremum over the null `Delta <= q` of the inclusive upper-tail count
`#{z: T_D(z,S) >= T_observed}`. The exact p-value denominator is `2^n`; ties are
always included and rejection is exactly `p <= 1/80`. The dynamic program
stores integer assignment counts only. It compares the rejection boundary as
`80 * max_tail_count <= 2^n`, never through rounded floating point.

The production implementation does **not** retain a pointwise maximum while
convolving partial schedules; that would mix incompatible global schedules.
It uses the following two complete-schedule sufficient-statistic kernels.

For absolute candidate risk, let `h=T_R(observed)` and choose `x` of the `h`
observed candidate-loss pairs whose unobserved candidate potential loss is 1,
and `y` of the `n-h` observed no-loss pairs whose unobserved candidate potential
loss is 1. Every compatible schedule is represented by one
`0<=x<=h, 0<=y<=n-h` state:

```text
A = x                         # pairs with candidate potential losses (1,1)
B = h - x + y                 # candidate-potential discordant pairs
R1 numerator = 2A + B = h + x + y
T_R under rerandomization = A + Binomial(B, 1/2)
```

Enumerating these `O(n^2)` states and precomputed exact binomial prefix/suffix
counts, multiplied by `2^(n-B)` for assignment-identical pairs, gives the
composite-null numerator over denominator `2^n` without schedule mixing. Promotion
uses the unsafe null `20*(2A+B) > 2n` and the inclusive lower tail. Operational
safety uses `H0: R1 <= 1/20`, equivalently `20*(2A+B) <= 2n`, and the inclusive
upper tail. It pauses exactly when
`1000 * max_upper_tail_count <= 2^n`; candidate missing is coded no-harm before
`h` is formed. This safety rule applies at `n=96,192,384`, includes boundary
ties, and is distinct from readiness alpha.

For a candidate-control loss difference, each observed pair contrast is
`t_p in {-1,0,1}`. A compatible schedule chooses the contrast `u_p` that would
have been observed under the other assignment, also in `{-1,0,1}`. Define:

```text
E = sum_p (t_p + u_p) = 2n*Delta
q = count_p(|t_p-u_p| = 1)
c = count_p(|t_p-u_p| = 2)
2*T_D = E + sum_(i=1..q) epsilon_i + 2*sum_(j=1..c) epsilon'_j
```

where every epsilon is an independent fair `{-1,+1}` sign. Feasibility is a
boolean bitset recurrence, not a probability recurrence:

```text
F_0[0,0] = bit(E=0)
for each observed t_p, for u in {-1,0,1}:
  dq = 1{|t_p-u|=1}; dc = 1{|t_p-u|=2}; dE = t_p+u
  F_(p+1)[q+dq,c+dc] |= shift_E(F_p[q,c], dE)
```

Iteration order is pair ordinal then `u=-1,0,1`; buffers are cleared between
pairs. OR merges only existence of a complete compatible schedule. After the
last pair, for each `(q,c)` the lower-tail unsafe null inspects only the smallest
set `E` above the rational margin, and the upper-tail deterioration null only
the largest set `E` at or below it; tail probability is monotone in `E` for
fixed `(q,c)`. No other feasible bit is discarded before this boundary query.

With `I~Binomial(q,1/2)` and `J~Binomial(c,1/2)`, the inclusive lower-tail
numerator for a retained state is calculated exactly as:

```text
sum_(i=0..q) choose(q,i)
  * prefixChoose(c, floor((2*T_observed-E-(2*i-q)+2*c)/4))
  * 2^(n-q-c)
```

with prefix indexes clamped to `[-1,c]`; the upper tail uses the corresponding
suffix. Precomputed Pascal rows/prefixes and every numerator are `BigInt`.
Comparisons always use the common denominator `2^n`. The feasibility bitset has
`q+c<=n` and `E in [-2n,2n]`: two rolling buffers require
`O(n^3/word_size)` memory and `O(n^4/word_size)` worst-case word operations;
the boundary-tail scan is `O(n^3)` exact integer operations. At `n=384`, CI
benchmarks all-minus, all-zero, all-plus, balanced, boundary, and worst-case
missingness cohorts. Each endpoint must complete without truncation within 60
seconds and 512 MiB peak RSS on the pinned CI reference machine, with identical
bytes across restart. Failure blocks gate-policy registration; it does not
permit approximation or a silent resource-limit `hold`.

All estimands live on the exact lattice with denominator `2n`. Thresholds such
as `1/20` are evaluated by integer cross multiplication. Diagnostic one-sided
bounds are obtained by repeating the corresponding composite-null test over
every attainable lattice value and taking the inversion boundary; the report
records the last non-rejected and first rejected lattice points, tail direction,
inclusive-tie rule, and integer numerator/denominator. The readiness decision
uses the direct unsafe-null test, so display rounding can never change it.

An independently implemented brute-force oracle enumerates all `2^n`
assignments and compatible binary schedules for `n <= 8`, which keeps the CI
workload bounded. For `n=9..12`, a separately written compressed reference
enumerator plus immutable externally generated golden vectors checks the same
results without claiming full schedule-by-assignment enumeration. Production DP
must match them for zero/all/interior schedules, sharp/composite nulls, every
endpoint, margin and formal look, arm/label symmetry, boundary equality,
inclusive ties, and state-space exhaustion. Clopper-Pearson, Newcombe, bootstrap, asymptotic,
iid-Bernoulli, truncated-state, or floating-only substitutes are rejected.

#### 12.2 Checkpoint, availability, and missingness rules

A checkpoint becomes reservable only at the registered cumulative wave's
immutable `wave_analysis_at`. The outcome-blind scan verifies the exact
96/192/384-pair prefix, simultaneous member activation, and closed follow-up;
it never waits for favorable observed outcomes. Positive, negative, neutral,
no-index, and missing units are all frozen. Checkpoint 1 cannot emit
`promotion_ready`, `demotion_ready`, or `retirement_ready`; formal checkpoints
2 and 3 use the exact contract above.

Assignment balance is structural, so a binomial SRM test is not run. Define a
member's pre-response availability as one iff at least one authenticated
eligible request arrived in its frozen wave before that member's first guide
response. For each matched pair let `b` count candidate-available/control-not
and `c` the reverse. Conditional on `d=b+c`, the preregistered two-sided exact
McNemar/sign p-value is
`min(1, 2 * sum[k=0..min(b,c)] choose(d,k) / 2^d)`, with all ties included.
`p <= 1/1000` causes an integrity `hold`; it is not by itself an automatic
candidate safety pause or a directional efficacy claim.

Coverage, conclusive-count, and promotion worst-case sensitivity are evaluated
after reservation. Their failure consumes that checkpoint and returns `hold`.
Missingness alone never appends authority. Automatic pause is limited to a
verified hard-boundary/assignment/identity/interference/ledger fault, or an
operational candidate absolute-harm lower bound above `1/20` at a registered
checkpoint. That safety lower bound uses only verified harms, codes candidate
missing as no-harm, and uses the exact inclusive test at `1/1000` for that
checkpoint. It is deliberately an availability-protecting action, not a
demotion/FWER claim. Thus five quiet namespaces cannot irreversibly stop later
waves. Unequal confirmatory allocation is rejected.

Each immutable checkpoint reservation freezes required evidence-series heads
and can be evaluated once. Gate-policy v1 uses checkpoint indexes 1/2/3; only
2/3 are formal looks. The gate accepts no caller time/cutoff/target and no second
sample for one index. A phase/allocation revision cannot create new alpha. Only
the sole confirmatory-attempt revision for the task-family implementation may
reserve the three checkpoints; all other revisions are integrity/safety-only.

The outcome-free scheduled-risk-set read model is deliberately narrower than
checkpoint evaluation. Before reconstructing the registered 96/192/384-pair
prefix, it runs a scoped structural verifier bound to the exact tenant,
reservation, and confirmatory attempt. That verifier reuses the protected
Runtime-artifact/reservation rules for event/artifact cutoffs and required heads,
then verifies the policy/revision/attempt binding, manifest, assignment bits,
all 768 namespace leases, uniform release operation, generation continuity,
and release authority references.
Its result is a `reconstructed_non_authority_preview`, reports the code-registry
status and whether the stored calibration digest exactly matches a registered
artifact, and always sets `production_authority_eligible=false`. The current
`calibration_pending` draft therefore remains visibly unregistered even when a
test database contains a self-consistent synthetic calibration row.

That structural read model includes no outcome fields and emits no evidence
verdict. It neither scans nor adjudicates unrelated tenants or non-Runtime
external evidence rows. External evidence-head validation, authenticated
pre-response arrival, interference attestation, and verified feedback
aggregation are reported only as unevaluated requirements outside the
structural layer. A later protected evaluator must complete those layers before
it may consume a checkpoint or produce `hold`, `pause_required`, promotion,
demotion, or retirement readiness.

#### 12.3 Prospective operating-characteristic calibration

The `96/192/384` schedule and equal `1/80` split are a **candidate design**, not
a registrable production policy merely because their type-I bounds are valid.
Before the code-registry draft `gate-policy-v1` can change from
`calibration_pending` to `registered`, a reviewed, content-addressed calibration
artifact must be produced without any candidate-arm or live confirmatory
outcomes. Only the registered form may be inserted into
`lite_learning_policy_versions`; confirmatory provisioning rejects an absent,
changed, or non-passing artifact digest.

The artifact freezes a finite potential-outcome scenario grid before exposure.
It covers control baseline risks, candidate absolute harm, every registered
risk-difference endpoint, within-pair concordance/matching quality, common
assignment-independent provider/calendar shocks, no-index rates, feedback
coverage from 90% through 100%, and hard-boundary rates. It includes boundary
nulls, zero effect, the reviewed target-safe alternative, harmful alternatives
at and beyond twice each five-point margin, and adversarial missingness. Each
scenario is frozen as `target_safe`, `exploit_harm_detection`, or
`diagnostic_only`. Only exploit-harm harmful scenarios are demotion-registration
critical in v1; utility, accepted-action, and exploration harmful scenarios
report operating characteristics but cannot manufacture a demotion endpoint or
new alpha family. A
shared quota, cache, or queue whose state depends on treatment is interference,
not a calibration scenario that can excuse the design.

For each frozen scenario, the calibration reports:

- probability of `promotion_ready` by checkpoints 2 and 3, including the full
  intersection-union gate rather than endpoint-by-endpoint power;
- unconditional and reached-formal-checkpoint-conditional probability of
  `demotion_ready`, probability of automatic operational pause, their
  exploit-harm union
  `verified_candidate_absolute_harm_pause OR exploit_harm_demotion_ready`,
  terminal `hold`, and expected stopping checkpoint; integrity, assignment, or
  hard-boundary pauses are reported separately and never count as
  effect-detection success;
- 80%-power minimum detectable effect for every endpoint and the joint gate;
- analytical directional FWER and the three-checkpoint operational-pause union
  bound, which is at most `3/1000` under the registered safe null;
- sensitivity to missingness, no-index units, pair correlation, and common
  assignment-independent shocks.

Gate-policy v1 requires the one-sided 99% Monte Carlo lower bound for final
joint promotion power to be at least `0.80` in every registered target-safe
scenario. Every `exploit_harm_detection` scenario requires the lower-bound
criterion
`P(verified_candidate_absolute_harm_pause OR
exploit_harm_demotion_ready by checkpoint 3) >= 0.80`. This prevents a correct
early effect-triggered safety pause from being counted as loss of harm-detection
power without crediting unrelated integrity/hard-boundary pauses. The artifact
still reports pause and unconditional/conditional demotion probabilities
separately. Other endpoint-harmful scenarios are diagnostic only because v1's
sole demotion endpoint is exploit harm; making them authority-bearing requires a
new demotion family and multiplicity allocation. In target-safe scenarios the
one-sided 99% upper bound for terminal `hold` must be at most `0.20`.

Exact enumeration is used where tractable. Simulated scenarios use the frozen
`clopper_pearson_exact_one_sided_v1` contract over deterministic counter-based
replicates. With `k` successes among `N`, lower-power and lower-harm-detection
threshold equality passes iff the exact inclusive binomial upper tail at
`p=4/5` satisfies
`100*sum[i=k..N] choose(N,i)*4^i <= 5^N`. Terminal-hold equality passes iff the
exact inclusive lower tail at `p=1/5` satisfies
`100*sum[i=0..k] choose(N,i)*4^(N-i) <= 5^N`. These decision comparisons use
`BigInt`; reported Clopper-Pearson decimals use the registered implementation
and cannot decide pass/fail. Precision is also a rational `BigInt` decision.
For a lower bound, set `a=100k-N`, `b=100N`; `a<=0` passes, otherwise
`k/N-L_99<=0.01` passes inclusive equality iff
`100*sum[i=k..N] choose(N,i)*a^i*(b-a)^(N-i) <= b^N`. For an upper bound set
`a=100k+N`, `b=100N`; `a>=b` passes, otherwise `U_99-k/N<=0.01` passes iff
`100*sum[i=0..k] choose(N,i)*a^i*(b-a)^(N-i) <= b^N`. The preregistered
replication count must satisfy every applicable precision comparison. Those
simulation bounds characterize prospective calibration only; they never
replace the exact finite-population test on production data.

Calibration is a batch computation, not one uncached production-gate call per
replicate. After frozen missingness coding, each endpoint is reduced to the
same sufficient statistic used by production: `h` for absolute risk and
`(n_-1,n_0,n_1)` for observed contrasts. The calibrator deduplicates these keys
across scenarios/replicates, computes each exact rejection lookup once with the
verified production kernel (or a grouped kernel proven byte-equivalent), and
stores a content-addressed lookup digest. `philox4x32_10_v1` assigns disjoint
counter ranges to fixed shards; shards never share mutable RNG state and emit
integer counts plus key/digest manifests. Canonical shard-order `BigInt` merge
must be invariant to worker count and restart. Small-state exhaustive tests and
sampled 192/384 states compare the batch lookup with direct production-gate
evaluation.

The v1 scenario manifest pins the reference runner and requires the entire
grid, including lookup construction and deterministic recomputation, to finish
within 12 hours and 32 GiB peak RSS on a pinned 32-vCPU calibration runner.
Every shard digest/raw count is retained. Resource or precision failure leaves
the policy pending; it cannot reduce scenarios/replicates, reuse a different
bound, approximate the exact gate, or silently convert a scenario to `hold`.

The artifact binds the scenario manifest, calibration code digest, candidate
implementation contract, preregistration gate inference-engine contract, seed,
replication count, raw count table, thresholds, and reviewer decision. The
final gate configuration then binds that artifact SHA without changing the
engine contract that the artifact evaluated. If 384 pairs miss any criterion,
the policy stays `calibration_pending`: the team must revise wave allocation,
margins, or alpha allocation under a new outcome-free policy version. Changing
the 384-pair sample size also requires a reviewed schema/design migration that
replaces the v3 count/bit-length checks before any exposure; the current DDL
cannot represent that change. It may not tune the design after seeing candidate
or checkpoint outcomes, and it may not call an underpowered always-`hold` gate
a mature learning loop.

Promotion requires all of:

1. The candidate-policy holdout check embedded in the current unsuperseded
   production-shadow report passes.
2. The broad-shadow checks in that same production-shadow series head pass.
3. The one reserved paired real-Agent finite-holdout regression uses predecision
   tracks, a genuinely immutable deterministic execution snapshot, and passes
   exact harm/utility thresholds plus worst-case sensitivity.
4. Current unsuperseded tool-E2E and Runtime-integrity series heads pass.
5. Every registered pair/wave has exactly one candidate and one control, with
   no pair/activation/pre-response availability integrity failure.
6. Exploitation arms meet breadth, time-window, assessable-unit, and coverage
   requirements.
7. Candidate exploitation absolute harm and control-relative +5-point
   noninferiority pass the registered one-sided bounds.
8. Accepted action is not worse than the registered margin.
9. The preregistered offline paired exploit-harm finite-case difference passes
   the exact -2-point threshold; no alternative effect or rerun can be selected
   after data.
10. Worst-case missing-outcome sensitivity still passes.
11. Exploration, when policy-affected, independently passes noninferiority.
12. Event, source, operation, route, and hard-boundary integrity findings are
    all zero.

Only formal checkpoint 2 or 3 may emit `promotion_ready`; checkpoint 1 and
other runs emit `hold`. Evidence evaluation never emits an authority `promote`
by itself.

## 13. Promotion, demotion, and authority

### 13.1 Promotion

The gate produces a task-family `promotion_ready` evidence row and a
`PromotionEvidenceLedgerV1` whose protocol explicitly supplies:

```text
source_scope: exact_task
authority_scope: task_family
local_reuse_allowed: true
wider_generalization_allowed: true
distinct_run_count
distinct_task_count
holdout_evidence_count
negative_transfer_count
leakage_gate: passed
holdout_gate: passed
interference_gate: passed
growth_gate: not_applicable
```

`regression_evidence_count` remains a count of adverse regression evidence;
successful regression checks are evidence refs, not increments to that field.

Initial promotion requires signed explicit adjudication. The second
authority-adjudication row and embedded policy-mutation evidence are one atomic
authority record. Automatic promotion, demotion, retirement, global authority,
and source-code authority are forbidden in v1; only safety pause is automatic.

### 13.2 Demotion

- memory-level strong counter: immediate contested/inspect state in the same
  feedback transaction; the posture prevents the recorded/control path from
  serving that memory as direct use again;
- any boundary ignored, hard-boundary violation, assignment/config digest
  drift, or ledger integrity fault: atomically append a safety-stop `pause` and
  make future guide resolution serve control/shadow;
- at a registered checkpoint, the exact `1/1000` operational lower bound for
  verified candidate absolute harm (candidate missing coded no-harm) above
  `1/20`: append `pause_required` and atomically append the authority `pause`;
  a point estimate, low coverage, or missing-as-harm sensitivity alone only
  returns `hold`;
- the sole preregistered demotion endpoint is candidate-minus-control exploit
  harm. Append `demotion_ready` only at formal checkpoint 2 or 3 when its
  `1/80` one-sided lower
  finite-population matched-pair bound is above +5 points on the registered
  cumulative pair prefix, with at least 96 conclusive namespaces in each arm,
  six task signatures, and two activation windows;
- append `retirement_ready` only as a strict hierarchical escalation after the
  **same checkpoint** has first satisfied cumulative `demotion_ready`. Then the
  first two preregistered, non-overlapping complete 96-pair activation waves
  inside that frozen cohort must each satisfy the same exact demotion null at
  that checkpoint's already-spent `1/80`. The implementation cannot evaluate a
  retirement subtest unless the cumulative demotion rejection bit is already
  true, so every retirement rejection event is a subset of the corresponding
  demotion rejection event and spends no additional directional alpha.
  No namespace cluster is reused across waves and at least 192 distinct
  conclusive namespace clusters per arm are present in total. Post-assignment
  index-time strata remain descriptive and never split a pair. The cumulative prefix and a later prefix are not
  misreported as two replications. Explicit signed adjudication then retires
  that candidate implementation contract for the task family.

The demotion monitor spends only the same two registered formal online looks;
checkpoint 1 and ad hoc
peeking can pause for safety but cannot claim statistical demotion. Insufficient
sample size or coverage causes `hold`, not demotion and not promotion.
Historical assignments and evidence are never rewritten.

Safety and statistical evidence are orthogonal. If one fixed look satisfies
`demotion_ready` and also triggers automatic pause, the evidence evaluation
keeps `demotion_ready` while the same transaction appends a separate
`safety_stop/pause_required/pause` row with
`trigger_ref_kind=gate_evaluation` and the evidence decision ID as its trigger.
The scalar verdict is never overwritten to hide the demotion evidence. A later
signed demotion adjudication may reference that evidence despite the existing
pause; only promotion requires an empty task-family candidate-implementation
safety fold.

### 13.3 Existing workflow promotion correction

`buildPolicyMutationFromWorkflowPromotion` must stop inferring task-family
authority solely from `workflow_signature`. Workflow promotion may remain local
when observation evidence is local; task-family scope requires a populated,
passing wider-generalization protocol.

## 14. Schema migration, backup, and rollback

### 14.1 Versioned preflight

Schema v3 cannot reuse the current equality-only inspector. Add complete v2 and
v3 requirement sets and classifications:

```text
uninitialized
legacy_v0_3_4
supported_previous_v2
current
incompatible
```

A v2 database is first checked against the full v2 table, column, constraint,
and index contract. Only then does one explicit SQLite transaction create v3
tables/triggers, consolidate measurement DDL, re-check the v3 target shape, and
create the singleton CSPRNG database-lineage identity, then update schema
metadata. The identity draw occurs inside the same transaction and is never
replaced on retry or ordinary reopen. A damaged v2 database fails before any
repair-like DDL.
Connection pragmas such as `journal_mode` are set and verified before
`BEGIN IMMEDIATE`; they are never attempted inside the atomic DDL transaction.

The upgrade captures and compares pre/post row counts for commits, nodes,
edges, guide receipts, write operations, rule feedback, product measurements,
and skill reviews. Backup/restore preserves the database-lineage identity;
explicit new-authority provisioning is the only path that creates another.
Migration tests use a schema-specific fault hook and a real
child-process kill between DDL groups and metadata update; reopen must observe a
complete v2 or complete v3 database, never a hybrid.

### 14.2 Legacy data

Schema upgrade creates structure only. A separate idempotent
`runtime:data episode-backfill` command may import digest-valid guide receipts:

```text
assignment = not_enrolled
track = unclassified
policy = unknown
decision_completeness = legacy_served_only
recorded action = null
candidate action = null
memory type/source backend/prior snapshot = null
served action = final surface proven by the guide receipt
promotion_eligible = false
source_kind = legacy_backfill
```

It never guesses historical policy from current env or feedback from mutable
node counters. Old feedback and measurements remain unlinked unless an original
authoritative source link exists.

Historical `effect_measured` v1 payloads that predate
`operation_receipt_sha256` remain readable and exact-replayable so a Runtime can
reopen an existing ledger. They are observational only: authority resolution
reports `effect_receipt_authority_missing`, they cannot become export or
promotion evidence, and fresh writes may not omit the field.

### 14.3 Verification and backup

`verifyLiteRuntimeDatabase` adds:

- immutable singleton Runtime database-lineage identity;
- experiment/attempt/namespace-lease/closure/event/item/learning-control-job/
  external-reservation/consumption/preclaim-hold/claim/supervisor-binding/session-termination/evidence-artifact/
  gate counts;
- payload, item-set, event-chain, and decision digests;
- exactly one exposure per episode and contiguous sequence;
- exposure-to-guide-receipt source link;
- feedback/effect source links;
- assignment consistency within revision and store-memory-namespace cluster;
- immutable confirmatory-attempt uniqueness, revision/config binding, and
  zero-exposure-before-registration proof;
- exact finite namespace/pair/wave membership/count/digests, 384 complete
  gate-policy-v1 pairs with one arm member each, one active lease per
  tenant/namespace, monotonically increasing generations, and no
  fixture/other-experiment overlap;
- every released lease set resolves in full to one signed experiment closure or
  terminal authority adjudication and its protected operation receipt;
- every signed approval resolves one globally unique tenant/key/nonce registry
  row with the same authorization digest and authority ref;
- supersession-chain validity;
- exact evidence artifact membership, cutoff, role/order, and report digests;
- each external artifact resolves exactly one matching reservation,
  consumption, claim, supervisor binding, signed session termination, terminal
  run-manifest, and attempt chain; terminal status and broker policy/binary/key
  bindings agree;
- external facts form a valid append-only prefix: pre-claim hold excludes claim;
  binding implies claim; termination implies claim; evidence artifact implies
  binding plus a normal termination; inverted edges and simultaneous branches
  fail reopen/backup. A consumed, claimed, or bound pre-terminal prefix is
  structurally legal while its frozen deadline permits broker recovery to a
  hold. A normal termination without ingestion is also structurally legal but
  is already final: later archive/ingest must preserve its exact
  `passed|failed|inconclusive` status and can never convert it to an abnormal
  hold. Exact terminal-branch completeness and DB/public coverage agreement
  are enforced only by broker pre-stop/coverage-final and acceptance
  verification; only an expired pre-terminal prefix is recovered to a hold
  rather than mislabeled as database corruption;
- gate `analysis_at`, fixed index/follow-up cohort, and stale-evidence binding;
- candidate-implementation safety precedence across experiment revisions and
  ID/version aliases;
- append-only triggers, one-way lease lifecycle triggers, and signed-approval
  nonce uniqueness;
- protected/legacy/promotion-eligible counts.
- learning-control lease, retry, completion, dead-letter, and payload integrity.
- v2 authority-fact preservation counts for guide receipts, operations, rule
  feedback, measurements, and skill reviews.

`VACUUM INTO` naturally carries the new tables, but backup is refused when any
ledger integrity check fails.

The separate acceptance verifier additionally requires each committed
external-ingestion projection to carry a valid signature from the revision-
frozen Runtime authority-attestor key and match its launcher, service, binary,
policy, database-lineage, schema/verifier, authority-head, coverage, evidence-
row, protected-operation, and current-series-head digests.

### 14.4 Rollback compatibility

After metadata becomes v3, the current v2 binary correctly sees a future schema
and fails closed. Release therefore has two binaries:

- R1 understands v3 but keeps learning serving dormant/off;
- R2 enables dual-write, shadow, and later active gray.

R2 may roll back to R1 or turn configuration off. It cannot roll back to the
current v2 binary. Database downgrade is not a normal rollback; restoring a
pre-upgrade backup to a new path is disaster recovery only.

## 15. Failure semantics

| Failure | Required behavior |
|---|---|
| Invalid v2/v3 schema | Startup fails before mutation. |
| Episode insert fails | Corresponding guide/feedback/measure transaction rolls back. |
| Same source and digest | Return existing event/receipt. |
| Same source and different digest | 409 conflict; no domain mutation. |
| Feedback before exposure | 409 sequence/source-link conflict. |
| Candidate projection incomplete | Serve control; exclude evidence. |
| Assignment/config digest changes within revision | Pause and serve control. |
| New revision or alias reuses a quarantined candidate implementation | Control/shadow only; active serving remains blocked. |
| Confirmatory namespace lacks the exact active lease | Serve control; persist no promotion-eligible exposure. |
| Fixture or another experiment touches an actively leased namespace | Integrity finding, automatic pause, and no formal cohort admission. |
| Close approval, closure ref, or full-set release cannot be replayed | Conflict; no lease changes. |
| Promotion basis is stale at current event/artifact/config head | Conflict/hold; zero authority mutation. |
| Gate artifact membership cannot be reproduced | Gate and adjudication fail closed. |
| Broker crashes or holdout validation fails after external ticket consumption | Consumption remains append-only; append the signed zero-effects pre-claim hold, forbid later claim/retry/capability/call, and archive its hold branch. |
| Runner exits after a broker-acknowledged clean quiesce | Exit is expected; provider/mount access remains revoked while bounded offline post-processing proceeds to normal finalize. |
| Runner exits before quiesce or quiesce cannot reconcile an in-flight call | Broker daemon wins the serialized abnormal transition, seals the partial chain, signs/spools a crash termination, and the claim remains a result-missing hold. |
| Quiesced result is not finalized by its frozen deadline | Broker spools `finalize_timeout`; drain persists it and no later result can reuse the claim. |
| Broker client or acceptance shell crashes after claim or binding | Dedicated broker daemon continues monitoring/revocation; shell lifetime is not security authority. |
| Same-UID process races supervisor startup | It lacks the launcher-inherited channel and signed PID/start/cgroup/job binding; Runtime records no substituted binding and no capability is issued. |
| Abnormal drain or public hold export is unavailable | Keep or restart the managed broker, emit `recovery_required`, and block release; do not stop the sole monitor. |
| Finalize/termination receipt is missing, invalid, status-mismatched, or not committed | No result ingestion or acceptance; revoke the session and fail closed without retrying the attempt. |
| Commit succeeds and process exits before response | Protected retry replays the exact stored response. |
| Missing feedback or measurement | Episode remains incomplete/censored. |
| Boundary ignored or hard-boundary violation | Persist feedback plus safety action atomically; pause candidate. |
| Repeated-unused job enqueue fails | Roll back feedback; never claim synchronous posture persistence. |
| Learning-control job dead-letters | Retain finding; disable active candidate and promotion, but preserve it in backup. |
| Authority mutation fails | Roll back its authority-adjudication row. |
| Protected guide response exceeds 2 MiB | Return 413 with zero guide/episode/operation mutation. |
| Ledger integrity verification fails | Disable active candidate; backup and promotion fail closed. |
| Measurement store still uses second writer | Effect event remains promotion-ineligible. |

## 16. Rollout

1. **R1 schema compatibility:** v3 migration, stores, verification, backup, and
   replay; all candidate serving off.
2. **R2 atomic dual-write:** guide, both feedback paths, and measure write
   episode facts; no prompt change.
3. **R3 A/A then shadow:** deploy an immutable `aa` revision, where both arms
   serve recorded policy, and verify restart stability, sample ratio, 100%
   ledger coverage, and zero integrity findings. Create a new `shadow` revision
   for candidate deltas; never mutate the A/A revision in place. The shadow
   prerequisite is recollected for this candidate/gate configuration through a
   reviewed real-host adapter; an old or fixture-only shadow report cannot open
   active serving.
4. **R4 isolated active/control:** atomically provision one bounded profile,
   task family, finite reviewed 384-pair/768-namespace manifest, and exact 50/50
   matched-pair `confirmatory` revision as the candidate implementation's
   sole confirmatory attempt before its first eligible exposure. This is
   permitted only after the outcome-free operating-characteristic artifact in
   Section 12.3 passes and its digest is registered. Provisioning
   freezes 96/96/192-pair waves and acquires the complete namespace lease set.
   Candidate exposure is limited by exact lease pair/arm/window membership, not
   by changing allocation or replacing quiet units after outcomes. Never reset the
   two-formal-look alpha budget with another revision or version alias. Reserve,
   claim, archive, and ingest the first complete shadow/tool/offline result
   before eligible-host activation; a failed result or exposed holdout cannot be
   retried for the same implementation. Any safety
   quarantine ends active rollout for that candidate implementation; changing
   only the revision is not recovery. A
   separately authenticated `fixture_pilot` principal proves plumbing first,
   but only frozen `eligible_host` principals can enter online evidence.
5. **R5 task-family adjudication:** emit promotion protocol and explicit
   adjudication; preserve a control sentinel or return to shadow on drift.

## 17. Test strategy

Tests use real file-backed SQLite and real Runtime service assembly. Mocks do not
count as final validation.

### 17.1 Structural and transaction tests

- v2-to-v3 migration, damaged-v2 fail-closed, interrupted migration, trigger
  presence, backup/restore, and legacy backfill;
- immutable candidate/gate policy versions, source mappings, evidence-series
  chains, one append-only confirmatory attempt per task-family candidate
  implementation contract, one external reservation/ticket-consumption/claim/
  supervisor-binding/session-termination/result-or-hold coverage per formal
  prerequisite, fresh offline case-set uniqueness, and one checkpoint
  reservation per registered index;
- finite namespace-manifest canonicalization, atomic revision/attempt/full-
  lease provisioning, concurrent overlap rejection, transaction-time guide
  lease recheck, complete signed close/release, generation reuse by a materially
  different implementation only, and restart verification;
- protected lease-store rejection of partial/mixed/unresolved release and
  generation skips; direct-SQL corruption fixtures prove reopen verification
  disables active serving, backup, close, and adjudication;
- digest, sequence, source uniqueness, scope/tenant isolation, supersession;
- fault injection at `after_begin`, `before_commit`, `after_commit`, and
  `before_rollback` for guide, memory feedback, tool feedback, and measure;
- real child-process exit after commit followed by reopen and idempotent replay;
- shared transaction-runner identity for measurement store.

### 17.2 Evidence tests

- one episode containing both explore and exploit items;
- first-use negative never appears in exploitation gate;
- unused exposure and missing feedback never become negative;
- descriptive negative/direct-use denominator is direct-use only;
- A/B gate uses one disjoint store-memory-namespace cluster outcome, not
  selected memory, repository, task-signature, or direct-use rows;
- mixed episodes contribute per-item evidence to both applicable tracks;
- eligible-host assessability requires a reverified task envelope/use receipt;
  spoofed principal/collector/task/episode/memory/surface/evidence bindings fail;
- later episodes and feedback outside the fixed index follow-up do not inflate
  or change the primary unit;
- projection truncation, pair/arm/wave imbalance, pre-response availability
  imbalance, boundary ignored, and config drift fail closed;
- a fixture pilot, auth-off call, or body-spoofed collection class cannot enter
  the eligible-host online cohort; a fixture cannot touch an actively leased
  namespace, and a cloned pilot uses an explicitly disjoint namespace manifest;
- A/A arms return byte-identical canonical guide responses while retaining
  distinct assignment facts;
- each checkpoint consumes the exact 96/192/384 matched-pair prefix; checkpoint
  1 cannot emit a directional readiness claim, checkpoints 2/3 each use exact
  `1/80` spending, and unequal/missing pair arms are rejected;
- the production finite-population DP equals an exhaustive independent oracle
  through 8 pairs, a separate compressed reference for 9–12 pairs, and frozen
  externally generated golden vectors at all real looks/margins;
- the prospective calibration artifact reproduces from its frozen scenario
  grid/seed/counts, meets every power/hold threshold before registration, and
  cannot read a candidate outcome, ledger snapshot, or checkpoint result;
- outcome-label swaps preserve the derived reservation, future time is rejected,
  and repeated mid-look cutoffs cannot create another evaluation;
- evidence-only `promotion_ready` cannot change serving; adjudication and
  policy mutation roll back together;
- late harm/pause invalidates an older `promotion_ready`, and a new experiment
  revision or version alias cannot bypass candidate-implementation quarantine;
- artifact membership and the preregistered -2-point finite-holdout difference
  reproduce from frozen integer inputs; mutable-provider profiles force hold;
- unclaimed or multiply presented runner tickets fail; every external terminal
  status has a matching signed and committed session termination and is
  archived/ingested, a non-passing first result burns the
  implementation attempt, and an exposed offline case set cannot be reused;
- wrong sealed holdout reference/ciphertext/member/count/order/projection fails
  after atomic ticket consumption but before claim, capability issue,
  runner-readable mount, or provider call, appends exactly one signed zero-effects
  pre-claim hold, and leaves the immutable reservation non-repairable; crash
  injection after consumption and at every decrypt/compare/claim boundary proves
  no second consumption, claim, or terminal branch;
- broker reservation crash tests cover pre-fsync, pre-commit, and post-commit
  boundaries: only one pre-fsynced ticket/request may survive, Runtime stores
  the same hash, restart never remints it, and the acceptance identity cannot
  read or replace the bytes;
- a signed daemon health challenge proves dedicated UID/GID, Unix-socket peer
  checks, executable/policy/key digests, and private-root ACLs before claim;
- the deployment launcher passes a private inherited channel only to the exact
  signed PID/start/cgroup/job and Runtime commits its sole binding before any
  mount/provider access; a concurrently racing process with the same UID, a
  copied argv, wrong executable, substituted descriptor, or replayed spawn
  receipt cannot bind or observe a call;
- a same-UID sibling racing the child relay, a forwarded relay descriptor,
  unapproved descendant, ptrace attempt, and `/proc` FD-open attempt are all
  denied; only the frozen child PID/start/cgroup/job may send each message;
- a broker crash after Runtime supervisor-binding commit but before the active
  journal acknowledgment replays the identical fixed-domain binding operation
  from a fresh daemon and cannot create a second process/channel binding;
- clean runner output seals and broker-acknowledged quiesce occur while the
  supervisor is alive; clean exit followed by long bounded offline gate work
  then normal finalize succeeds, whereas exit-before-quiesce races to exactly
  one `runner_crash` termination;
- quiesce versus concurrent provider calls rejects new calls and drains/cancels
  every in-flight call before sealing the public signed chain; timeout/unknown
  takes the abnormal hold path, and no late result can appear outside the chain;
- crash injection immediately after capability issue, runner/client shell kill,
  heartbeat loss, hard expiry, finalization timeout, normal finalize, operator
  revoke, and broker restart prove independent revoke and canonical spool drain;
  a crash after Runtime termination commit but before spool acknowledgment
  replays the identical fixed-domain operation ID and receipt-derived actor
  from a fresh process, even when the recovery client has a different audit
  identity;
  post-quiesce/termination credential, provider, and holdout-mount access are
  denied, only one signed Runtime termination can exist, and missing/signature/
  status/quiesce/output/manifest/attempt-chain mismatches block ingest and
  acceptance;
- each abnormal reason exports a deterministic sanitized terminal/partial-chain/
  Runtime-row record and a secret-scanned `termination_hold` bundle; every
  post-consumption/pre-claim terminal path exports a signed zero-effects
  `preclaim_hold` bundle; missing, duplicate, simultaneous result/claimed-hold/
  preclaim-hold, or uncommitted coverage fails the acceptance index, hold
  ingestion is rejected, and no hold-covered root can report pass;
- cleanup follows the acyclic order pre-stop zero-active/all-acked/exported
  status -> terminal bundles -> coverage-final status -> service stop; bundle
  references to coverage-final/stop or reverse status-to-unbuilt-bundle cycles
  are rejected, and injected Runtime/export/archive failure keeps or restarts
  the managed daemon with `recovery_required`;
- explicit adjudication requires a valid signed approval bound to exact evidence;
- immediate pause is visible to the next guide after feedback commit;
- 33.3% total negative can coexist with zero prior-aware exploitation harm
  without producing the wrong maturity conclusion;
- workflow task-family authority remains blocked without wider evidence.

### 17.3 Acceptance

Run focused CI, complete Lite tests, complexity check, then separate external
real-Agent suites against a real Runtime and real provider: the existing
40-case tool/action-completion gate, the isolated offline paired rerun, and a
long-running online collector across the frozen matched-pair activation waves.
Every guide call supplies `operation_id`; experiment ID/revision/config digest,
pair/member/wave, assignment unit/arm, frozen track, and episode ID are part of
eval provenance and are reconciled against the Runtime ledger before a gate
runs. No-index scheduled namespaces remain missing rather than being replaced.
The frozen fixture uses its own authenticated `fixture_pilot` principal and is
never the statistical online sample; genuine host traffic uses separately
registered `eligible_host` principals. The eligible adapter and eval harness run
as distinct OS/service identities with executable negative credential tests.
Every formal external run is uniquely reserved and ticket-consumed before
outcome-bearing work. It then takes exactly one terminal branch: a zero-effects
pre-claim hold; a claimed abnormal termination hold; or a launcher-authenticated
supervisor binding, clean quiesce, normal termination, and result. Capabilities
are issued only on the third path after Runtime commits the exact process/
channel binding. Public service, binding, quiesce, call-chain, terminal-fact
drain/pre-stop, and Runtime receipts are archived; coverage-final and service
stop are bound only through the outer broker lifecycle root. Hold branches are
never ingested and force release `hold`. All
evals execute only from a committed, verified materialization of the
content-addressed harness with pre/post source receipts. Profile projections,
hashed namespace membership, pair/wave schedule, prepare/clone receipts, and
pilot disjointness inputs are archived. The paired holdout base is frozen and
audited before any A/A write, and the A/A and paired manifests must be disjoint
by task ID, content/workflow, store scope, and source event. The 40-case gate is a prerequisite, not the
statistical arm sample.

Active host collection uses immutable per-wave/per-run directories and a
canonical cumulative host-run index. The checkpoint index is a tagged union:
an `evaluated` entry binds its host-run index, committed integrity bundle,
reservation, cumulative online bundle, and evaluation ID/verdict; an
`integrity_stop` entry binds its host-run index, committed integrity bundle,
terminal-integrity result bundle, and automatic-safety authority receipt, and
must contain no reservation, online bundle, or evaluation. An ordinary
checkpoint-1/2 `hold` leaves Runtime and leases active for the next frozen wave.
An evaluated entry with an automatic pause must also bind the embedded
safety-authority receipt. The checkpoint index is terminal only at checkpoint 3,
at checkpoint 1/2 with an automatic pause or non-`hold` terminal readiness
verdict, or at a correctly bound `integrity_stop`; ending on an ordinary
checkpoint-1/2 `hold` is rejected. A signed operational close aborts this release
acceptance run and is archived under its separate closure protocol; it cannot
manufacture a successful checkpoint root. The committed
`evals/learning-episode-gate-v1/acceptance-index.json` is a top-level tagged
union. `checkpoint_series` is allowed only after a terminal checkpoint index
and binds the harness, registered prospective calibration artifact, A/A/pilot,
all three verified `passed` external reservation/consumption/claim/binding/
normal-termination/result roots, plus the committed `external-ingestion`
bundle proving that those exact three results are the three Runtime evidence
rows and current preregistered series heads (either hold branch or a failed/
inconclusive/un-ingested result invalidates this mode), the
acyclic broker lifecycle bundle, ordered checkpoint entries, Runtime/runner
commits, and final report. `external_prerequisite_hold` is allowed at the
prerequisite stage when any result is `failed|inconclusive` or any hold branch
occurs. It binds required-series status (including unstarted series), every
consumed reservation's exact result/claimed-hold/pre-claim-hold
coverage branch, all terminal bundle digests, the broker lifecycle root, the
committed `external-ingestion` bundle proving every result branch was ingested
and every hold/unstarted branch was not, and a hold report. It forbids pilot,
active-host, checkpoint, evaluation, and
readiness fields and can only report `hold`; it never fabricates a checkpoint
for a prerequisite that stopped the run. Release CI verifies the union shape
and every referenced object from a fresh shell with fail-fast settings and a
clean Git tree. The root also binds the tracked calibration-scenario manifest
and embeds the canonical full-recomputation receipt. Fresh-shell verification
reruns the committed deterministic shards, recomputes raw counts/exact
Clopper-Pearson decisions, and matches the pending-engine commit, allowed
registration-only diff, registered policy digest, artifact, and receipt; a
stored pass bit is never sufficient. Receipt content identity covers deterministic
digests/counts/decisions/budget pass bits only; invocation time and measured
duration/RSS are signed audit metadata, and every recomputation must separately
meet the frozen resource limits.

The current complexity budget is already at its exact file/line/route/env
ceiling. Implementation must either delete/merge enough existing source or
review and rebaseline the measured structural budget in the same change. It may
not silently raise thresholds before measuring the final architecture.

## 18. Implementation order

1. Fix versioned schema preflight and prepare the shared measurement factory
   without changing production assembly.
2. Add strict contracts and the atomic v3 episode/evidence/gate schema, then
   rewire measurement onto the shared database/transaction runner; keep all
   candidate serving off.
3. Extend verification, backup, replay, migration-fault, and preservation tests
   so the R1 binary is operationally complete before any dual-write.
4. Add predecision track resolver, immutable experiment revision, diagnostic
   assignment, exact matched-pair confirmatory provisioning, and dormant
   A/A/shadow resolution.
5. Add SDK/host operation IDs and atomic protected guide dual-write.
6. Add atomic memory feedback facts, memory posture, safety-stop pause, and the
   dedicated repeated-unused learning-control job queue.
7. Refactor tool feedback into prepare/persist/finalize and add atomic facts.
8. Add measurement episode binding and effect events.
9. Correct real-Agent predecision slicing and implement versioned task-family
   evidence gate.
10. Ingest immutable external evidence; separate evidence readiness from
    atomic explicit promotion/demotion authority adjudication; correct workflow
    wider-generalization enforcement.
11. Extend the existing flight-recorder projection, bounded backfill, docs,
    complexity audit, and real dual-arm E2E evidence.

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  compileContinuationV1,
  continuationCompilerPolicySha256,
  evaluatePreconditionV1,
  type CompileContinuationV1Args,
  type ContinuationCompilerCandidateV1,
  type ContinuationCompilerPolicyV1,
} from "../../src/continuation/compiler.ts";
import { retrieveContinuationCandidatesV1 } from
  "../../src/continuation/candidate-retrieval.ts";
import {
  canonicalContinuationSha256,
  canonicalSha256Without,
  canonicalUniqueSet,
  type AuthorityBranchRefV1,
  type CapsuleCoverageClaimV1,
  type ContinuationObligationV1,
  type ExecutionCapsuleV1,
  type HostObservationV1,
  type TypedPreconditionSpecV1,
} from "../../src/continuation/contract.ts";
import { validatePreconditionSpecV1 } from "../../src/continuation/observation.ts";
import { buildSignedObserverObservationV1 } from
  "../../src/continuation/observation-attestation.ts";
import {
  renderContinuationProjectionV1,
  verifyRenderedContinuationProjectionV1,
} from "../../src/continuation/renderer.ts";
import { verifyClosedContinuationContractProjectionV1 } from
  "../../src/continuation/contract-verifier.ts";
import {
  buildHostTaskEnvelopeV1,
  continuationAuthoritySubjectSha256V1,
} from "../../src/continuation/task-envelope.ts";
import { buildWorldObservationSnapshotV1 } from "../../src/continuation/world-snapshot.ts";
import {
  EXPERIMENT_ASSIGNMENT_ALGORITHM_CONTRACT_SHA256_V1,
  experimentCohortPayloadSha256V1,
  type ExperimentCohortV1,
} from "../../src/continuation/experiment-cohort.ts";
import {
  assignmentSeedCommitmentSha256V1,
  deriveServingAssignmentReceiptV1,
} from "../../src/continuation/serving-assignment.ts";

const NOW = "2026-07-21T12:00:00.000Z";
const OBSERVER = "9".repeat(64);
const MEMORY_HEAD = "8".repeat(64);
const AUTHORITY_SUBJECT = continuationAuthoritySubjectSha256V1({
  tenant_id: "tenant-1",
  scope: "scope-1",
  task_family: "repair",
});
const HOST_TASK_ENVELOPE = buildHostTaskEnvelopeV1({
  host_task_id: "host-task-1",
  episode_id: "episode-1",
  run_id: "run-1",
  consumer_agent_id: "consumer-1",
  consumer_team_id: null,
  task_family: "repair",
  task_signature: "task-signature",
  workflow_signature: null,
  workspace_signature: "workspace-1",
  source_task_sha256: "2".repeat(64),
  source_event_sha256: "1".repeat(64),
  issued_at: "2026-07-21T11:50:00.000Z",
  expires_at: "2026-07-21T13:00:00.000Z",
}, {
  tenant_id: "tenant-1",
  scope: "scope-1",
  authority_subject_sha256: AUTHORITY_SUBJECT,
});
const BRANCH: AuthorityBranchRefV1 = {
  branch_id: "branch-authoritative",
  branch_revision: 1,
  manifest_sha256: "7".repeat(64),
};
const CANDIDATE_BRANCH: AuthorityBranchRefV1 = {
  branch_id: "branch-candidate",
  branch_revision: 1,
  manifest_sha256: "6".repeat(64),
};
const CONTROL_LEARNING_REF = {
  ...BRANCH,
  branch_kind: "authoritative" as const,
  state: "authoritative" as const,
};
const CANDIDATE_LEARNING_REF = {
  ...CANDIDATE_BRANCH,
  branch_kind: "candidate" as const,
  state: "active_candidate" as const,
};

const POLICY: ContinuationCompilerPolicyV1 = {
  schema_version: "continuation_compiler_policy_v1",
  tenant_id: "tenant-1",
  authority_subject_sha256: AUTHORITY_SUBJECT,
  candidate_limit: 128,
  continuity_candidate_limit: 64,
  learning_candidate_limit: 64,
  selected_capsule_limit: 64,
  obligation_limit: 64,
  max_render_budget: 65_536,
  hard_coverage_weight: 1_000_000,
  advisory_coverage_weight: 10_000,
  authority_bonus: { candidate: 0, verified: 64, authoritative: 128 },
  freshness_bonus: [0, 2, 4, 8],
  freshness_max_age_ms: [3_600_000, 86_400_000, 604_800_000],
  trusted_observer_principals: {
    trusted_host_collector: [OBSERVER],
    external_verifier: [OBSERVER],
  },
};

function obligation(args: Partial<ContinuationObligationV1> & Pick<ContinuationObligationV1, "obligation_id">): ContinuationObligationV1 {
  return {
    obligation_id: args.obligation_id,
    kind: args.kind ?? "required_state",
    requirement: args.requirement ?? "hard",
    statement: args.statement ?? `Satisfy ${args.obligation_id}`,
    target_refs: args.target_refs ?? [{ kind: "memory", ref: `coverage:${args.obligation_id}` }],
    required_probe_ids: args.required_probe_ids ?? [],
    evidence_requirement: args.evidence_requirement ?? "runtime_state",
    source_refs: args.source_refs ?? [],
  };
}

function capsule(args: {
  id: string;
  claims: Array<string | ContinuationObligationV1>;
  kind?: ExecutionCapsuleV1["kind"];
  influence?: ExecutionCapsuleV1["proposed_influence"];
  specs?: TypedPreconditionSpecV1[];
  conflicts?: ExecutionCapsuleV1["conflicts_with"];
  supersedes?: ExecutionCapsuleV1["supersedes"];
  summarySize?: number;
  summary?: string;
}): ExecutionCapsuleV1 {
  const claimedObligations = args.claims.map((claim) =>
    typeof claim === "string" ? obligation({ obligation_id: claim }) : claim);
  const coverageClaims = canonicalUniqueSet(claimedObligations.map((claim) => {
    const body = {
      obligation_kind: claim.kind,
      target_refs: claim.target_refs,
      evidence_requirement: claim.evidence_requirement,
      required_probe_ids: claim.required_probe_ids,
    };
    return {
      ...body,
      coverage_claim_sha256: canonicalContinuationSha256(body),
    } satisfies CapsuleCoverageClaimV1;
  }), (claim) => claim.coverage_claim_sha256);
  const projectionTargets = canonicalUniqueSet(
    claimedObligations.flatMap((claim) => claim.target_refs),
    (target) => `${target.kind}\0${target.ref}`,
  );
  const projectionBody = {
    summary: args.summary ?? (args.summarySize
      ? "x".repeat(args.summarySize)
      : `State supplied by ${args.id}`),
    next_action: `Continue with ${args.id}`,
    target_refs: projectionTargets,
    workflow_steps: [],
    acceptance_statements: [],
  } as const;
  const projection = {
    ...projectionBody,
    projection_sha256: canonicalContinuationSha256(projectionBody),
  };
  const body = {
    schema_version: "execution_capsule_v1" as const,
    capsule_id: args.id,
    capsule_revision: 1,
    created_at: "2026-07-21T11:00:00.000Z",
    parent_capsule_sha256: null,
    source: {
      memory_id: `memory-${args.id}`,
      source_commit_id: `commit-${args.id}`,
      source_projection_sha256: "1".repeat(64),
    },
    kind: args.kind ?? "verified_fact",
    proposed_influence: args.influence ?? "use",
    applicability: {
      tenant_id: "tenant-1",
      scope: "scope-1",
      task_family: "repair",
      task_signature: "task-signature",
      workflow_signature: null,
      workspace_signature: "workspace-1",
      producer_agent_id: "producer-1",
      owner_agent_id: null,
      owner_team_id: null,
    },
    projection,
    coverage_claims: coverageClaims,
    precondition_specs: args.specs ?? [],
    evidence_refs: [],
    verifier_refs: [],
    conflicts_with: args.conflicts ?? [],
    supersedes: args.supersedes ?? [],
    expires_at: null,
  };
  return { ...body, capsule_sha256: canonicalContinuationSha256(body) };
}

function candidate(
  value: ExecutionCapsuleV1,
  overrides: Partial<{
    disposition: "include" | "exclude" | "prohibit";
    admission: "candidate" | "verified" | "authoritative";
    lifecycle: "active" | "suppressed" | "archived" | "quarantined";
    memoryProjectionSha256: string;
  }> = {},
): ContinuationCompilerCandidateV1 {
  const branchBody = {
    branch_ref: BRANCH,
    capsule: {
      capsule_id: value.capsule_id,
      capsule_revision: value.capsule_revision,
      capsule_sha256: value.capsule_sha256,
    },
    disposition: overrides.disposition ?? "include",
    admission_authority: overrides.admission ?? "authoritative",
  } as const;
  const lifecycleBody = {
    memory_id: value.source.memory_id,
    lifecycle_source_commit_id: value.source.source_commit_id,
    memory_projection_sha256: overrides.memoryProjectionSha256
      ?? value.source.source_projection_sha256,
    lifecycle: overrides.lifecycle ?? "active",
    memory_scope_head_revision: 1,
    memory_scope_head_sha256: MEMORY_HEAD,
  } as const;
  const learning = value.kind === "procedure" || value.kind === "counter_evidence";
  const continuityBody = {
    capsule: branchBody.capsule,
    disposition: branchBody.disposition === "exclude"
      ? "include" as const
      : branchBody.disposition,
    admission_authority: branchBody.admission_authority === "candidate"
      ? "verified" as const
      : branchBody.admission_authority,
    memory_id: value.source.memory_id,
    capsule_source_commit_id: value.source.source_commit_id,
    memory_scope_head_revision: 1,
    memory_scope_head_sha256: MEMORY_HEAD,
  } as const;
  return {
    capsule: value,
    provenance: learning ? {
      lane: "governed_learning",
      branch_binding: {
        ...branchBody,
        admission_authority: branchBody.admission_authority === "verified"
          ? "authoritative" as const
          : branchBody.admission_authority,
        binding_sha256: canonicalContinuationSha256({
          ...branchBody,
          admission_authority: branchBody.admission_authority === "verified"
            ? "authoritative" as const
            : branchBody.admission_authority,
        }),
      },
    } : {
      lane: "verified_continuity",
      continuity_binding: {
        ...continuityBody,
        binding_sha256: canonicalContinuationSha256(continuityBody),
      },
    },
    lifecycle_fact: {
      ...lifecycleBody,
      row_sha256: canonicalContinuationSha256(lifecycleBody),
    },
  };
}

function observation(
  spec: TypedPreconditionSpecV1,
  value: HostObservationV1["value"],
  overrides: Partial<Omit<HostObservationV1, "value" | "observation_sha256">> = {},
): HostObservationV1 {
  const body = {
    schema_version: "host_observation_v1" as const,
    observation_id: overrides.observation_id ?? `observation-${spec.probe_id}`,
    probe_id: overrides.probe_id ?? spec.probe_id,
    probe_spec_sha256: overrides.probe_spec_sha256 ?? canonicalContinuationSha256(spec),
    observer: overrides.observer ?? spec.observer,
    observer_principal_sha256: overrides.observer_principal_sha256 ?? OBSERVER,
    host_task_envelope_sha256: overrides.host_task_envelope_sha256
      ?? HOST_TASK_ENVELOPE.host_task_envelope_sha256,
    world_snapshot_id: overrides.world_snapshot_id ?? "snapshot-1",
    observed_at: overrides.observed_at ?? "2026-07-21T11:59:00.000Z",
    expires_at: overrides.expires_at ?? "2026-07-21T12:09:00.000Z",
    value,
    evidence_sha256: overrides.evidence_sha256 ?? "4".repeat(64),
    attestation: overrides.attestation ?? { kind: "authenticated_collector" as const },
  };
  return { ...body, observation_sha256: canonicalContinuationSha256(body) };
}

function compileArgs(args: {
  obligations: ContinuationObligationV1[];
  candidates: ContinuationCompilerCandidateV1[];
  observations?: HostObservationV1[];
  renderBudget?: number;
  policy?: ContinuationCompilerPolicyV1;
}): CompileContinuationV1Args {
  const policy = args.policy ?? POLICY;
  const observations = args.observations ?? [];
  const observationSnapshot = buildWorldObservationSnapshotV1({
    tenant_id: "tenant-1",
    scope: "scope-1",
    authority_subject_sha256: AUTHORITY_SUBJECT,
    world_snapshot_id: "snapshot-1",
    host_task_envelope: HOST_TASK_ENVELOPE,
    collection_principal_sha256: OBSERVER,
    observations,
    created_at: NOW,
  });
  const identity = {
    decision_id: "decision-1",
    tenant_id: "tenant-1",
    scope: "scope-1",
    episode_id: "episode-1",
    run_id: "run-1",
    host_task_id: "host-task-1",
    host_task_envelope_sha256: HOST_TASK_ENVELOPE.host_task_envelope_sha256,
    collection_principal_sha256: OBSERVER,
    consumer_agent_id: "consumer-1",
    consumer_team_id: null,
    task_family: "repair",
    task_signature: "task-signature",
    workflow_signature: null,
    workspace_signature: "workspace-1",
    source_task_sha256: "2".repeat(64),
    source_event_sha256: "1".repeat(64),
    world_snapshot_id: "snapshot-1",
    world_snapshot_sha256: observationSnapshot.world_snapshot_sha256,
  } as const;
  const retrieval = retrieveContinuationCandidatesV1({
    schema_version: "continuation_candidate_retrieval_input_v1",
    identity,
    obligations: args.obligations,
    candidates: args.candidates,
    evaluated_at: NOW,
    policy,
  });
  if (retrieval.status !== "selected") throw new Error("test candidate retrieval overflow");
  return {
    schema_version: "continuation_compile_input_v1",
    identity,
    authority: {
      authority_subject_sha256: AUTHORITY_SUBJECT,
      authoritative_learning_head: BRANCH,
      served_learning_branch: BRANCH,
      serving_mode: "authoritative_unassigned",
      experiment_cohort_ref: null,
      serving_assignment_receipt: null,
      compiler_policy_ref: {
        artifact_sha256: "f".repeat(64),
        payload_sha256: continuationCompilerPolicySha256(policy),
      },
      evidence_policy_ref: {
        artifact_sha256: "e".repeat(64),
        payload_sha256: "b".repeat(64),
      },
      memory_scope_head_revision: 1,
      memory_scope_head_sha256: MEMORY_HEAD,
    },
    obligations: args.obligations,
    candidates: retrieval.candidates,
    candidate_retrieval_receipt: retrieval.receipt,
    observation_snapshot: observationSnapshot,
    compiled_at: NOW,
    render_budget: args.renderBudget ?? 65_536,
    policy,
  };
}

function assignedCandidateAuthority(
  input: CompileContinuationV1Args,
  artifactSha256 = "4".repeat(64),
): CompileContinuationV1Args["authority"] {
  for (let byte = 0; byte < 256; byte += 1) {
    const seed = Buffer.alloc(32, byte);
    const cohort: ExperimentCohortV1 = {
      schema_version: "experiment_cohort_v1",
      tenant_id: input.identity.tenant_id,
      scope: input.identity.scope,
      task_family: input.identity.task_family,
      cohort_id: `cohort-${byte}`,
      authority_subject_sha256: AUTHORITY_SUBJECT,
      control_learning_ref: CONTROL_LEARNING_REF,
      candidate_learning_ref: CANDIDATE_LEARNING_REF,
      compiler_policy_ref: input.authority.compiler_policy_ref,
      evidence_policy_ref: input.authority.evidence_policy_ref,
      eligibility: { host_principal_sha256s: null },
      assignment_protocol: {
        algorithm: "hmac_sha256_threshold_v1",
        algorithm_contract_sha256:
          EXPERIMENT_ASSIGNMENT_ALGORITHM_CONTRACT_SHA256_V1,
        assignment_seed_commitment_sha256: assignmentSeedCommitmentSha256V1(seed),
        basis_schema: "serving_assignment_basis_v1",
        candidate_allocation_bps: 9_999,
      },
      assignment_window_opened_at: "2026-07-21T11:00:00.000Z",
      assignment_window_closed_at: "2026-07-21T13:00:00.000Z",
      outcome_deadline: "2026-07-21T14:00:00.000Z",
      settlement_grace_ms: 3_600_000,
      settlement_cutoff_at: "2026-07-21T15:00:00.000Z",
    };
    const cohortRef = {
      artifact_sha256: artifactSha256,
      payload_sha256: experimentCohortPayloadSha256V1(cohort),
    };
    const receipt = deriveServingAssignmentReceiptV1({
      cohort,
      experiment_cohort_ref: cohortRef,
      assignment_seed: seed,
      assignment_basis: {
        schema_version: "serving_assignment_basis_v1",
        experiment_cohort_ref: cohortRef,
        create_continuation_operation_id: input.identity.decision_id,
        operation_request_sha256: "5".repeat(64),
        decision_id: input.identity.decision_id,
        episode_id: input.identity.episode_id,
        run_id: input.identity.run_id,
        host_task_id: input.identity.host_task_id,
        host_task_envelope_sha256: input.identity.host_task_envelope_sha256,
        host_principal_sha256: input.identity.collection_principal_sha256,
        task_family: input.identity.task_family,
        source_task_sha256: input.identity.source_task_sha256,
        world_snapshot_ref: {
          world_snapshot_id: input.identity.world_snapshot_id,
          world_snapshot_sha256: input.identity.world_snapshot_sha256,
        },
        memory_scope_head_ref: {
          revision: input.authority.memory_scope_head_revision,
          head_sha256: input.authority.memory_scope_head_sha256,
        },
      },
      assigned_at: NOW,
    });
    if (receipt.arm === "candidate") {
      return {
        ...input.authority,
        served_learning_branch: CANDIDATE_BRANCH,
        serving_mode: "assigned_candidate",
        experiment_cohort_ref: cohortRef,
        serving_assignment_receipt: receipt,
      };
    }
  }
  throw new Error("test could not derive candidate arm");
}

test("timeless runtime facts need no artificial probe and selected contracts contain refs only", () => {
  const fact = capsule({ id: "fact", claims: ["state"] });
  const input = compileArgs({
    obligations: [obligation({ obligation_id: "state" })],
    candidates: [candidate(fact)],
  });
  const contract = compileContinuationV1(input);

  assert.equal(contract.safe_fallback.mode, "execute");
  assert.equal(contract.coverage_certificate.status, "complete");
  assert.equal(contract.selected_capsules[0]?.surface, "use_now");
  assert.deepEqual(Object.keys(contract.selected_capsules[0]!.capsule).sort(), [
    "capsule_id", "capsule_revision", "capsule_sha256",
  ]);
  assert.equal(contract.coverage_certificate.candidate_partition.selected_count, 1);
  assert.equal(contract.coverage_certificate.candidate_partition.excluded_count, 0);
  (input.identity as { decision_id: string }).decision_id = "caller-mutated";
  assert.equal(contract.identity.decision_id, "decision-1");
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.coverage_certificate.coverage), true);
});

test("compiler and closed contract reject candidate retrieval receipt tampering", () => {
  const fact = capsule({ id: "receipt-bound", claims: ["state"] });
  const input = compileArgs({
    obligations: [obligation({ obligation_id: "state" })],
    candidates: [candidate(fact)],
  });
  const receipt = input.candidate_retrieval_receipt;
  const { receipt_sha256: _receiptSha, ...receiptBody } = receipt;
  const forgedReceiptBody = {
    ...receiptBody,
    compiler_candidate_universe_sha256: "0".repeat(64),
  };
  const forgedReceipt = {
    ...forgedReceiptBody,
    receipt_sha256: canonicalContinuationSha256(forgedReceiptBody),
  };
  assert.throws(() => compileContinuationV1({
    ...input,
    candidate_retrieval_receipt: forgedReceipt,
  }), /candidate retrieval receipt does not bind/u);

  const contract = compileContinuationV1(input);
  const tampered = JSON.parse(JSON.stringify(contract)) as typeof contract;
  const compiler = tampered.compiler as unknown as Record<string, any>;
  const storedReceipt = compiler.candidate_retrieval_receipt as Record<string, any>;
  storedReceipt.compiler_candidate_universe_sha256 = "0".repeat(64);
  storedReceipt.receipt_sha256 = canonicalSha256Without(storedReceipt, "receipt_sha256");
  (tampered as unknown as Record<string, unknown>).contract_sha256 =
    canonicalSha256Without(tampered, "contract_sha256");
  assert.throws(
    () => verifyClosedContinuationContractProjectionV1(tampered),
    /candidate_partition|candidate_retrieval_receipt/u,
  );
});

test("a source universe above 128 is bounded before executable contract compilation", () => {
  const advisory = obligation({ obligation_id: "bounded", requirement: "advisory" });
  const candidates = Array.from({ length: 200 }, (_, index) => candidate(capsule({
    id: `bounded-${index.toString().padStart(3, "0")}`,
    claims: [advisory],
    kind: index < 100 ? "verified_fact" : "procedure",
  })));
  const contract = compileContinuationV1(compileArgs({
    obligations: [advisory],
    candidates,
  }));
  assert.equal(contract.compiler.candidate_retrieval_receipt.source_universe.candidate_count, 200);
  assert.equal(contract.compiler.candidate_retrieval_receipt.selected.verified_continuity.count, 64);
  assert.equal(contract.compiler.candidate_retrieval_receipt.selected.governed_learning.count, 64);
  assert.equal(contract.coverage_certificate.candidate_partition.candidate_count, 128);
  assert.equal(
    contract.coverage_certificate.candidate_universe_sha256,
    contract.compiler.candidate_retrieval_receipt.compiler_candidate_universe_sha256,
  );
  assert.equal(
    verifyClosedContinuationContractProjectionV1(contract).contract_sha256,
    contract.contract_sha256,
  );
});

test("contracts bind the canonical historical compilation time for exact replay", () => {
  const input = compileArgs({ obligations: [], candidates: [] });
  const first = compileContinuationV1(input);
  const secondCompiledAt = "2026-07-21T12:00:01.000Z";
  const secondRetrieval = retrieveContinuationCandidatesV1({
    schema_version: "continuation_candidate_retrieval_input_v1",
    identity: input.identity,
    obligations: input.obligations,
    candidates: input.candidates,
    evaluated_at: secondCompiledAt,
    policy: input.policy,
  });
  if (secondRetrieval.status !== "selected") throw new Error("test retrieval overflow");
  const second = compileContinuationV1({
    ...input,
    candidates: secondRetrieval.candidates,
    candidate_retrieval_receipt: secondRetrieval.receipt,
    compiled_at: secondCompiledAt,
  });
  assert.equal(first.compiler.compiled_at, NOW);
  assert.notEqual(first.contract_sha256, second.contract_sha256);
  assert.notEqual(
    first.coverage_certificate.compilation_input_sha256,
    second.coverage_certificate.compilation_input_sha256,
  );
  assert.equal(
    verifyClosedContinuationContractProjectionV1(first).compiler.compiled_at,
    NOW,
  );

  const tampered = JSON.parse(JSON.stringify(first)) as Record<string, unknown> & {
    compiler: Record<string, unknown>;
    contract_sha256: string;
  };
  tampered.compiler.compiled_at = "2026-07-21T12:00:00Z";
  tampered.contract_sha256 = canonicalSha256Without(tampered, "contract_sha256");
  assert.throws(
    () => verifyClosedContinuationContractProjectionV1(tampered),
    /compiler_compiled_at/u,
  );
});

test("persisted coverage survives new decision IDs but never crosses a stable target boundary", () => {
  const historical = obligation({
    obligation_id: "past-decision-local-id",
    kind: "next_action",
    target_refs: [{ kind: "workflow", ref: "release/runtime-v1" }],
  });
  const reusable = capsule({ id: "reusable-procedure", claims: [historical] });
  const future = obligation({
    ...historical,
    obligation_id: "new-decision-local-id",
    statement: "Continue the same stable workflow in a later Agent run",
  });
  const matched = compileContinuationV1(compileArgs({
    obligations: [future],
    candidates: [candidate(reusable)],
  }));

  assert.equal(matched.safe_fallback.mode, "execute");
  assert.deepEqual(matched.selected_capsules[0]?.coverage_bindings, [{
    obligation_id: future.obligation_id,
    coverage_claim_sha256: reusable.coverage_claims[0]!.coverage_claim_sha256,
  }]);

  const sameProseWrongTarget = obligation({
    ...future,
    target_refs: [{ kind: "workflow", ref: "release/another-product" }],
  });
  const rejected = compileContinuationV1(compileArgs({
    obligations: [sameProseWrongTarget],
    candidates: [candidate(reusable)],
  }));
  assert.equal(rejected.selected_capsules.length, 0);
  assert.deepEqual(rejected.excluded_capsules, []);
  assert.equal(
    rejected.compiler.candidate_retrieval_receipt.omitted.verified_continuity.count,
    1,
  );
  assert.equal(rejected.safe_fallback.mode, "report_unresolved");
});

test("contracts bind signed policy artifact identity separately from the compiler payload", () => {
  const fact = capsule({ id: "policy-identity", claims: ["state"] });
  const input = compileArgs({
    obligations: [obligation({ obligation_id: "state" })],
    candidates: [candidate(fact)],
  });
  const first = compileContinuationV1(input);
  const second = compileContinuationV1({
    ...input,
    authority: {
      ...input.authority,
      compiler_policy_ref: {
        ...input.authority.compiler_policy_ref,
        artifact_sha256: "0".repeat(64),
      },
    },
  });

  assert.equal(
    first.authority.compiler_policy_ref.payload_sha256,
    second.authority.compiler_policy_ref.payload_sha256,
  );
  assert.notEqual(
    first.authority.compiler_policy_ref.artifact_sha256,
    second.authority.compiler_policy_ref.artifact_sha256,
  );
  assert.notEqual(first.contract_sha256, second.contract_sha256);
  assert.notEqual(
    first.coverage_certificate.compilation_input_sha256,
    second.coverage_certificate.compilation_input_sha256,
  );
  assert.equal(Object.isFrozen(first.authority.compiler_policy_ref), true);
  assert.equal(Object.isFrozen(first.authority.evidence_policy_ref), true);
});

test("assigned-candidate contracts bind receipt and signed cohort artifact identity", () => {
  const input = compileArgs({ obligations: [], candidates: [] });
  const assigned = {
    ...input,
    authority: assignedCandidateAuthority(input),
  };
  const first = compileContinuationV1(assigned);
  const secondInput = compileArgs({ obligations: [], candidates: [] });
  const second = compileContinuationV1({
    ...secondInput,
    authority: assignedCandidateAuthority(secondInput, "1".repeat(64)),
  });

  assert.equal(first.authority.serving_mode, "assigned_candidate");
  assert.equal(first.authority.serving_assignment_receipt?.arm, "candidate");
  assert.equal(Object.isFrozen(first.authority.experiment_cohort_ref), true);
  assert.notEqual(first.contract_sha256, second.contract_sha256);
  assert.notEqual(
    first.coverage_certificate.compilation_input_sha256,
    second.coverage_certificate.compilation_input_sha256,
  );
});

test("required probes gate positive coverage and wrong observations fail closed", () => {
  const spec: TypedPreconditionSpecV1 = {
    kind: "artifact",
    probe_id: "artifact-current",
    required_for: "before_action",
    observer: "trusted_host_collector",
    max_age_ms: 600_000,
    on_unknown: "inspect",
    on_unsatisfied: "block",
    workspace_id: "workspace-1",
    relative_path: "src/continuation/compiler.ts",
    expected_presence: "present",
    expected_kind: "file",
    expected_content_sha256: "c".repeat(64),
  };
  const required = obligation({
    obligation_id: "state",
    required_probe_ids: [spec.probe_id],
    evidence_requirement: "trusted_host",
  });
  const fact = capsule({ id: "fact", claims: [required], specs: [spec] });
  const missing = compileContinuationV1(compileArgs({ obligations: [required], candidates: [candidate(fact)] }));
  assert.equal(missing.coverage_certificate.coverage[0]?.status, "conflicted");
  assert.equal(missing.selected_capsules[0]?.surface, "inspect_before_use");
  assert.equal(missing.safe_fallback.mode, "inspect");

  const validObservation = observation(spec, {
    kind: "artifact",
    presence: "present",
    artifact_kind: "file",
    content_sha256: "c".repeat(64),
  });
  const valid = compileContinuationV1(compileArgs({
    obligations: [required],
    candidates: [candidate(fact)],
    observations: [validObservation],
  }));
  assert.equal(valid.safe_fallback.mode, "execute");
  assert.deepEqual(valid.selected_capsules[0]?.satisfied_probe_ids, [spec.probe_id]);

  const staleObservation = observation(spec, validObservation.value, {
    observed_at: "2026-07-21T11:00:00.000Z",
    expires_at: "2026-07-21T11:10:00.000Z",
  });
  const evaluation = evaluatePreconditionV1({
    spec,
    observation: staleObservation,
    host_task_envelope_sha256: HOST_TASK_ENVELOPE.host_task_envelope_sha256,
    world_snapshot_id: "snapshot-1",
    trusted_observer_principal_sha256s: new Set([OBSERVER]),
    compiled_at: NOW,
  });
  assert.equal(evaluation.status, "unknown");
  assert.deepEqual(evaluation.reason_codes, ["probe_observation_stale"]);
});

test("a signed external verifier covers an obligation only when the signed policy trusts its key", () => {
  const spec: TypedPreconditionSpecV1 = {
    kind: "verifier",
    probe_id: "external-verifier-result",
    required_for: "before_action",
    observer: "external_verifier",
    max_age_ms: 600_000,
    on_unknown: "block",
    on_unsatisfied: "block",
    verifier_id: "workspace-verifier-v1",
    config_sha256: "c".repeat(64),
    expected_result: "passed",
    require_fresh_process: true,
    require_after_agent_exit: true,
  };
  const signer = generateKeyPairSync("ed25519");
  const signedObservation = buildSignedObserverObservationV1({
    schema_version: "host_observation_v1",
    observation_id: "external-verifier-observation",
    probe_id: spec.probe_id,
    probe_spec_sha256: canonicalContinuationSha256(spec),
    observer: "external_verifier",
    host_task_envelope_sha256: HOST_TASK_ENVELOPE.host_task_envelope_sha256,
    world_snapshot_id: "snapshot-1",
    observed_at: "2026-07-21T11:59:00.000Z",
    expires_at: "2026-07-21T12:09:00.000Z",
    value: {
      kind: "verifier",
      verifier_id: spec.verifier_id,
      config_sha256: spec.config_sha256,
      result: "passed",
      fresh_process: true,
      after_agent_exit: true,
    },
    evidence_sha256: "d".repeat(64),
  }, signer.privateKey);
  const required = obligation({
    obligation_id: "externally-verified",
    required_probe_ids: [spec.probe_id],
    evidence_requirement: "external_verifier",
  });
  const fact = capsule({
    id: "external-verifier-fact",
    claims: [required],
    specs: [spec],
  });

  const untrusted = compileContinuationV1(compileArgs({
    obligations: [required],
    candidates: [candidate(fact)],
    observations: [signedObservation],
  }));
  assert.equal(untrusted.selected_capsules[0]?.surface, "do_not_use");
  assert.equal(untrusted.safe_fallback.mode, "block");

  const trustedPolicy: ContinuationCompilerPolicyV1 = {
    ...POLICY,
    trusted_observer_principals: {
      ...POLICY.trusted_observer_principals,
      external_verifier: [signedObservation.observer_principal_sha256],
    },
  };
  const trusted = compileContinuationV1(compileArgs({
    obligations: [required],
    candidates: [candidate(fact)],
    observations: [signedObservation],
    policy: trustedPolicy,
  }));
  assert.equal(trusted.selected_capsules[0]?.surface, "use_now");
  assert.equal(trusted.safe_fallback.mode, "execute");
});

test("compiler accepts only the exact verified world snapshot and its current trust window", () => {
  const fact = capsule({ id: "snapshot-bound", claims: ["state"] });
  const input = compileArgs({
    obligations: [obligation({ obligation_id: "state" })],
    candidates: [candidate(fact)],
  });
  const { observation_snapshot: _snapshot, ...withoutSnapshot } = input;
  assert.throws(() => compileContinuationV1({
    ...withoutSnapshot,
    observations: [],
  } as never), /observation_snapshot|unrecognized|invalid_type/u);
  assert.throws(() => compileContinuationV1({
    ...input,
    observation_snapshot: {
      ...input.observation_snapshot,
      tenant_id: "another-tenant",
    },
  }), /exact continuation identity|digest_or_window_mismatch/u);
  assert.throws(() => compileContinuationV1({
    ...input,
    compiled_at: input.observation_snapshot.expires_at,
  }), /snapshot window/u);
  const untrustedPolicy = {
    ...input.policy,
    trusted_observer_principals: {
      ...input.policy.trusted_observer_principals,
      trusted_host_collector: [],
    },
  };
  assert.throws(() => compileContinuationV1({
    ...input,
    authority: {
      ...input.authority,
      compiler_policy_ref: {
        ...input.authority.compiler_policy_ref,
        payload_sha256: continuationCompilerPolicySha256(untrustedPolicy),
      },
    },
    policy: untrustedPolicy,
  }), /snapshot collector is not a trusted host collector/u);
});

test("typed probes reject path traversal and arbitrary network endpoints", () => {
  const common = {
    probe_id: "unsafe",
    required_for: "before_action" as const,
    observer: "trusted_host_collector" as const,
    max_age_ms: 60_000,
    on_unknown: "block" as const,
    on_unsatisfied: "block" as const,
  };
  assert.throws(() => validatePreconditionSpecV1({
    ...common,
    kind: "artifact",
    workspace_id: "workspace-1",
    relative_path: "../secret",
    expected_presence: "present",
    expected_kind: "file",
    expected_content_sha256: null,
  }), /repository-relative POSIX path/);
  assert.throws(() => validatePreconditionSpecV1({
    ...common,
    kind: "service",
    endpoint_id: "http://169.254.169.254/latest/meta-data",
    protocol: "http",
    expected_health: "healthy",
    require_external_visibility: false,
    require_after_agent_exit: false,
  }), /registered endpoint id/);
});

test("a satisfied prohibition and positive path can still authorize execute", () => {
  const prohibitionObligation = obligation({
    obligation_id: "avoid-old-path",
    kind: "prohibition",
  });
  const nextObligation = obligation({ obligation_id: "next", kind: "next_action" });
  const prohibition = capsule({
    id: "prohibition",
    claims: [prohibitionObligation],
    kind: "constraint",
    influence: "block",
  });
  const current = capsule({ id: "current", claims: [nextObligation] });
  const contract = compileContinuationV1(compileArgs({
    obligations: [prohibitionObligation, nextObligation],
    candidates: [candidate(current), candidate(prohibition, { disposition: "prohibit" })],
  }));

  assert.equal(contract.safe_fallback.mode, "execute");
  assert.equal(contract.coverage_certificate.status, "complete");
  assert.deepEqual(contract.selected_capsules.map((item) => item.surface).sort(), ["do_not_use", "use_now"]);
});

test("explicit authoritative conflicts fail closed instead of being resolved by score", () => {
  const lower = capsule({ id: "lower", claims: ["state"] });
  const higher = capsule({
    id: "higher",
    claims: ["state"],
    conflicts: [{
      capsule_id: lower.capsule_id,
      capsule_revision: lower.capsule_revision,
      capsule_sha256: lower.capsule_sha256,
    }],
  });
  const contract = compileContinuationV1(compileArgs({
    obligations: [obligation({ obligation_id: "state" })],
    candidates: [candidate(lower), candidate(higher)],
  }));

  assert.equal(contract.coverage_certificate.conflict_free, false);
  assert.equal(contract.coverage_certificate.coverage[0]?.status, "conflicted");
  assert.equal(contract.safe_fallback.mode, "inspect");
  assert.deepEqual(contract.selected_capsules.map((item) => item.surface), [
    "inspect_before_use", "inspect_before_use",
  ]);
});

test("input order is irrelevant while every candidate decision fact is digest-bound", () => {
  const first = capsule({ id: "first", claims: ["state"] });
  const second = capsule({ id: "second", claims: ["advice"] });
  const obligations = [
    obligation({ obligation_id: "state" }),
    obligation({ obligation_id: "advice", requirement: "advisory" }),
  ];
  const candidates = [candidate(first), candidate(second)];
  const left = compileContinuationV1(compileArgs({ obligations, candidates }));
  const right = compileContinuationV1(compileArgs({
    obligations: [...obligations].reverse(),
    candidates: [...candidates].reverse(),
  }));
  assert.equal(left.contract_sha256, right.contract_sha256);
  assert.equal(
    left.coverage_certificate.compilation_input_sha256,
    right.coverage_certificate.compilation_input_sha256,
  );

  const changedCandidate = candidate(first, { lifecycle: "archived" });
  const changed = compileContinuationV1(compileArgs({
    obligations,
    candidates: [changedCandidate, candidates[1]!],
  }));
  assert.notEqual(
    left.coverage_certificate.compilation_input_sha256,
    changed.coverage_certificate.compilation_input_sha256,
  );
});

test("a mandatory frame that cannot fit is explicitly non-executable", () => {
  const fact = capsule({ id: "large", claims: ["state"], summarySize: 1500 });
  const contract = compileContinuationV1(compileArgs({
    obligations: [obligation({ obligation_id: "state" })],
    candidates: [candidate(fact)],
    renderBudget: 1024,
  }));

  assert.equal(contract.coverage_certificate.budget_satisfied, false);
  assert.ok(contract.coverage_certificate.required_render_bytes > 1024);
  assert.equal(contract.safe_fallback.mode, "block");
  assert.equal(
    canonicalSha256Without(contract, "contract_sha256"),
    contract.contract_sha256,
  );

  const rendered = renderContinuationProjectionV1({ contract, capsules: [] });
  assert.equal(rendered.status, "not_renderable");
  assert.equal(rendered.format, "aionis-agent-context-v1");
  assert.equal(rendered.content, null);
  assert.equal(rendered.projection_sha256, null);
  assert.equal(rendered.required_bytes, contract.coverage_certificate.required_render_bytes);
  assert.equal(rendered.budget_bytes, 1024);
  assert.equal(
    canonicalSha256Without(rendered, "render_result_sha256"),
    rendered.render_result_sha256,
  );
  assert.equal(Object.isFrozen(rendered), true);
  assert.deepEqual(verifyRenderedContinuationProjectionV1(rendered), rendered);
  assert.throws(() => verifyRenderedContinuationProjectionV1({
    ...rendered,
    required_bytes: 1024,
  }), /digest mismatch|inconsistent/u);
});

test("the canonical renderer emits the exact certified byte count without truncation", () => {
  const fact = capsule({ id: "rendered-fact", claims: ["state"] });
  const contract = compileContinuationV1(compileArgs({
    obligations: [obligation({ obligation_id: "state" })],
    candidates: [candidate(fact)],
  }));

  const rendered = renderContinuationProjectionV1({ contract, capsules: [fact] });
  assert.equal(rendered.status, "rendered");
  if (rendered.status !== "rendered") throw new Error("expected a rendered continuation projection");
  assert.equal(Buffer.byteLength(rendered.content, "utf8"), rendered.required_bytes);
  assert.equal(rendered.required_bytes, contract.coverage_certificate.required_render_bytes);
  assert.equal(rendered.projection_sha256, canonicalContinuationSha256(JSON.parse(rendered.content)));
  assert.equal(
    canonicalSha256Without(rendered, "render_result_sha256"),
    rendered.render_result_sha256,
  );
  assert.equal(Object.isFrozen(rendered), true);
  assert.deepEqual(verifyRenderedContinuationProjectionV1(rendered), rendered);
  assert.throws(() => verifyRenderedContinuationProjectionV1({
    ...rendered,
    projection_sha256: "f".repeat(64),
  }), /digest mismatch/u);
  let accessorCalls = 0;
  const accessor = Object.defineProperty({ ...rendered }, "content", {
    enumerable: true,
    get: () => {
      accessorCalls += 1;
      return rendered.content;
    },
  });
  assert.throws(() => verifyRenderedContinuationProjectionV1(accessor), /shape is invalid/u);
  assert.equal(accessorCalls, 0);
  const parsed = JSON.parse(rendered.content) as {
    safe_fallback_code: string;
    selected_capsules: Array<{ projection: { summary: string } }>;
  };
  assert.equal(parsed.safe_fallback_code, "E");
  assert.equal(parsed.selected_capsules[0]?.projection.summary, fact.projection.summary);
  assert.throws(
    () => renderContinuationProjectionV1({ contract, capsules: [] }),
    /exact selected capsule set/,
  );
});

test("forgetting states never leak capsule bodies while archived refs remain rehydratable", () => {
  for (const lifecycle of ["suppressed", "quarantined"] as const) {
    const secret = `FORBIDDEN-${lifecycle}-BODY`;
    const hidden = capsule({
      id: `hidden-${lifecycle}`,
      claims: ["state"],
      summary: secret,
    });
    const contract = compileContinuationV1(compileArgs({
      obligations: [obligation({ obligation_id: "state" })],
      candidates: [candidate(hidden, { lifecycle })],
    }));
    assert.deepEqual(contract.selected_capsules, []);
    assert.deepEqual(contract.excluded_capsules, [{
      capsule: {
        capsule_id: hidden.capsule_id,
        capsule_revision: hidden.capsule_revision,
        capsule_sha256: hidden.capsule_sha256,
      },
      reason_codes: [`lifecycle_${lifecycle}`],
    }]);
    const rendered = renderContinuationProjectionV1({ contract, capsules: [] });
    assert.equal(rendered.status, "rendered");
    if (rendered.status !== "rendered") throw new Error("expected rendered fallback");
    assert.equal(rendered.content.includes(secret), false);
    const projection = JSON.parse(rendered.content) as {
      selected_capsules: unknown[];
      rehydration_capsule_refs: unknown[];
    };
    assert.deepEqual(projection.selected_capsules, []);
    assert.deepEqual(projection.rehydration_capsule_refs, []);
  }

  const secret = "FORBIDDEN-ARCHIVED-BODY";
  const archived = capsule({
    id: "hidden-archived",
    claims: ["state"],
    summary: secret,
  });
  const contract = compileContinuationV1(compileArgs({
    obligations: [obligation({ obligation_id: "state" })],
    candidates: [candidate(archived, { lifecycle: "archived" })],
  }));
  const archivedRef = {
    capsule_id: archived.capsule_id,
    capsule_revision: archived.capsule_revision,
    capsule_sha256: archived.capsule_sha256,
  };
  assert.deepEqual(contract.selected_capsules, []);
  assert.deepEqual(contract.excluded_capsules, [{
    capsule: archivedRef,
    reason_codes: ["lifecycle_archived_rehydration_required"],
  }]);
  assert.equal(contract.safe_fallback.mode, "rehydrate");
  const rendered = renderContinuationProjectionV1({ contract, capsules: [] });
  assert.equal(rendered.status, "rendered");
  if (rendered.status !== "rendered") throw new Error("expected rendered fallback");
  assert.equal(rendered.content.includes(secret), false);
  const projection = JSON.parse(rendered.content) as {
    selected_capsules: unknown[];
    rehydration_capsule_refs: unknown[];
  };
  assert.deepEqual(projection.selected_capsules, []);
  assert.deepEqual(projection.rehydration_capsule_refs, [archivedRef]);
});

test("strict runtime schemas reject unknown fields and invalid authority enums", () => {
  const fact = capsule({ id: "strict", claims: ["state"] });
  const valid = compileArgs({
    obligations: [obligation({ obligation_id: "state" })],
    candidates: [candidate(fact)],
  });
  const assignedAuthority = assignedCandidateAuthority(valid);
  const cohortRef = assignedAuthority.experiment_cohort_ref!;
  assert.throws(() => compileContinuationV1({ ...valid, unknown_authority: true } as never));
  assert.throws(() => compileContinuationV1({
    ...valid,
    authority: { ...valid.authority, serving_mode: "forged" },
  } as never));
  assert.throws(() => compileContinuationV1({
    ...valid,
    authority: {
      ...valid.authority,
      experiment_cohort_ref: cohortRef,
    },
  }));
  assert.throws(() => compileContinuationV1({
    ...valid,
    authority: {
      ...assignedAuthority,
      experiment_cohort_ref: null,
    },
  }));
  assert.throws(() => compileContinuationV1({
    ...valid,
    authority: {
      ...assignedAuthority,
      serving_assignment_receipt: null,
    },
  }));
  assert.throws(() => compileContinuationV1({
    ...valid,
    authority: {
      ...assignedAuthority,
      served_learning_branch: BRANCH,
    },
  }));
  assert.throws(() => compileContinuationV1({
    ...valid,
    authority: {
      ...assignedAuthority,
      experiment_cohort_ref: {
        ...cohortRef,
        artifact_sha256: "A".repeat(64),
      },
    },
  }));
  assert.throws(() => compileContinuationV1({
    ...valid,
    authority: {
      ...assignedAuthority,
      experiment_cohort_ref: {
        ...cohortRef,
        payload_sha256: "3".repeat(63),
      },
    },
  }));
  assert.throws(() => compileContinuationV1({
    ...valid,
    authority: {
      ...assignedAuthority,
      experiment_cohort_ref: {
        ...cohortRef,
        unknown: "5".repeat(64),
      },
    },
  } as never));
  assert.throws(() => compileContinuationV1({
    ...valid,
    authority: {
      ...valid.authority,
      compiler_policy_ref: {
        ...valid.authority.compiler_policy_ref,
        artifact_sha256: "F".repeat(64),
      },
    },
  }));
  assert.throws(() => compileContinuationV1({
    ...valid,
    authority: {
      ...valid.authority,
      evidence_policy_ref: {
        ...valid.authority.evidence_policy_ref,
        artifact_sha256: "e".repeat(63),
      },
    },
  }));
  assert.throws(() => compileContinuationV1({
    ...valid,
    authority: {
      ...valid.authority,
      compiler_policy_ref: {
        ...valid.authority.compiler_policy_ref,
        unknown: "d".repeat(64),
      },
    },
  } as never));
  assert.throws(() => compileContinuationV1({
    ...valid,
    authority: {
      ...valid.authority,
      compiler_policy_ref: {
        ...valid.authority.compiler_policy_ref,
        payload_sha256: "0".repeat(64),
      },
    },
  }), /compiler policy digest does not match authority binding/u);
  assert.throws(() => compileContinuationV1({
    ...valid,
    obligations: [{ ...valid.obligations[0]!, requirement: "not-hard" }],
  } as never));
  assert.throws(() => compileContinuationV1(compileArgs({
    obligations: valid.obligations,
    candidates: valid.candidates,
    policy: { ...POLICY, tenant_id: "tenant-other" },
  })), /policy (?:tenant|authority subject) does not match identity/u);
  assert.throws(() => compileContinuationV1(compileArgs({
    obligations: valid.obligations,
    candidates: valid.candidates,
    policy: { ...POLICY, authority_subject_sha256: "f".repeat(64) },
  })), /policy (?:tenant|authority subject) does not match identity/u);
});

test("counter-evidence can never become positive direct-use authority", () => {
  const invalid = capsule({
    id: "invalid-counter",
    claims: ["state"],
    kind: "counter_evidence",
    influence: "use",
  });
  assert.throws(() => compileContinuationV1(compileArgs({
    obligations: [obligation({ obligation_id: "state" })],
    candidates: [candidate(invalid)],
  })), /candidate_invalid|counter-evidence cannot be proposed/u);

  const counter = capsule({
    id: "counter",
    claims: ["state"],
    kind: "counter_evidence",
    influence: "block",
  });
  const contract = compileContinuationV1(compileArgs({
    obligations: [obligation({ obligation_id: "state" })],
    candidates: [candidate(counter)],
  }));
  assert.equal(contract.selected_capsules[0]?.surface, "do_not_use");
  assert.notEqual(contract.safe_fallback.mode, "execute");
});

test("evidence requirements cannot be satisfied by a lower observer role", () => {
  const spec: TypedPreconditionSpecV1 = {
    kind: "artifact",
    probe_id: "external-proof",
    required_for: "before_action",
    observer: "trusted_host_collector",
    max_age_ms: 60_000,
    on_unknown: "block",
    on_unsatisfied: "block",
    workspace_id: "workspace-1",
    relative_path: "result.json",
    expected_presence: "present",
    expected_kind: "file",
    expected_content_sha256: null,
  };
  const required = obligation({
    obligation_id: "verified",
    evidence_requirement: "external_verifier",
    required_probe_ids: [spec.probe_id],
  });
  const fact = capsule({ id: "wrong-role", claims: [required], specs: [spec] });
  assert.throws(() => compileContinuationV1(compileArgs({
    obligations: [required],
    candidates: [candidate(fact)],
  })), /candidate_invalid|matching serve-phase precondition/u);
});

test("serve-phase unknown policy is evaluated against the filtered probe, not another phase", () => {
  const mergeSpec: TypedPreconditionSpecV1 = {
    kind: "capability",
    probe_id: "a-before-merge",
    required_for: "before_merge",
    observer: "trusted_host_collector",
    max_age_ms: 60_000,
    on_unknown: "inspect",
    on_unsatisfied: "block",
    capability_id: "merge-capability",
    expected_version: null,
    expected_presence: "present",
  };
  const actionSpec: TypedPreconditionSpecV1 = {
    kind: "capability",
    probe_id: "b-before-action",
    required_for: "before_action",
    observer: "trusted_host_collector",
    max_age_ms: 60_000,
    on_unknown: "block",
    on_unsatisfied: "block",
    capability_id: "action-capability",
    expected_version: null,
    expected_presence: "present",
  };
  const required = obligation({
    obligation_id: "state",
    required_probe_ids: [actionSpec.probe_id],
    evidence_requirement: "trusted_host",
  });
  const fact = capsule({
    id: "phase-policy",
    claims: [required],
    specs: [mergeSpec, actionSpec],
  });
  const contract = compileContinuationV1(compileArgs({
    obligations: [required],
    candidates: [candidate(fact)],
  }));
  assert.equal(contract.selected_capsules[0]?.surface, "do_not_use");
  assert.equal(contract.safe_fallback.mode, "block");
});

test("higher authority wins a direct-use conflict before budget optimization", () => {
  const authoritative = capsule({
    id: "authoritative", claims: ["state"], kind: "procedure", summarySize: 1500,
  });
  const cheap = capsule({
    id: "cheap-candidate",
    claims: ["state"],
    kind: "procedure",
    conflicts: [{
      capsule_id: authoritative.capsule_id,
      capsule_revision: authoritative.capsule_revision,
      capsule_sha256: authoritative.capsule_sha256,
    }],
  });
  const contract = compileContinuationV1(compileArgs({
    obligations: [obligation({ obligation_id: "state" })],
    candidates: [
      candidate(cheap, { admission: "candidate" }),
      candidate(authoritative, { admission: "authoritative" }),
    ],
  }));
  assert.equal(contract.safe_fallback.mode, "execute");
  assert.deepEqual(contract.selected_capsules.map((item) => item.capsule.capsule_id), ["authoritative"]);
  assert.deepEqual(contract.excluded_capsules[0]?.reason_codes, ["lower_authority_conflict"]);
});

test("supersession removes the old capsule before coverage selection", () => {
  const old = capsule({ id: "old", claims: ["state"], kind: "procedure" });
  const current = capsule({
    id: "current",
    claims: ["state"],
    kind: "procedure",
    supersedes: [{
      capsule_id: old.capsule_id,
      capsule_revision: old.capsule_revision,
      capsule_sha256: old.capsule_sha256,
    }],
  });
  const contract = compileContinuationV1(compileArgs({
    obligations: [obligation({ obligation_id: "state" })],
    candidates: [candidate(old), candidate(current)],
  }));
  assert.equal(contract.safe_fallback.mode, "execute");
  assert.deepEqual(contract.selected_capsules.map((item) => item.capsule.capsule_id), ["current"]);
  assert.deepEqual(contract.excluded_capsules[0]?.reason_codes, ["superseded_by_authority"]);

  assert.throws(() => compileContinuationV1(compileArgs({
    obligations: [obligation({ obligation_id: "state" })],
    candidates: [
      candidate(old, { admission: "authoritative" }),
      candidate(current, { admission: "candidate" }),
    ],
  })), /lower-authority capsule cannot supersede/);
});

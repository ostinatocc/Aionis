import {
  canonicalContinuationClone,
  assertSha256,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  canonicalSha256Without,
  canonicalUniqueSet,
  type AuthorityBranchRefV1,
  type CapsuleRefV1,
  type ContinuationContractV1,
  type ContinuationObligationV1,
  type ExecutionCapsuleV1,
  type Sha256,
} from "./contract.js";
import {
  continuationProjectionFrameBytesV1,
  measureContinuationProjectionBytesV1,
} from "./renderer.js";
import { assertCompileContinuationV1Args } from "./validation.js";
import {
  verifyWorldObservationSnapshotV1,
  type WorldObservationSnapshotV1,
} from "./world-snapshot.js";
import {
  verifyContinuationCompilerPolicyV1,
  type ContinuationCompilerPolicyV1,
} from "./compiler-policy.js";
import {
  CONTINUATION_CANDIDATE_RETRIEVAL_ALGORITHM_SHA256_V1,
  verifyContinuationCandidateRetrievalReceiptV1,
  type ContinuationCandidateRetrievalReceiptV1,
  type ContinuationCompilerCandidateV1,
} from "./candidate-retrieval.js";
import {
  ContinuationCompilerSelectedCapsuleCapacityErrorV1,
  evaluateContinuationSelectionV1,
} from "./selection-evaluation.js";

/**
 * PURE_NON_AUTHORITY_COMPILER_V1.
 *
 * Production callers must first obtain a VerifiedCompilerPolicyCapability
 * issued by PolicyAuthority and pass through DecisionAssembly. This compiler
 * orchestrates verified inputs and cannot resolve policy, create an exposure,
 * or grant executable authority by itself.
 */

export { evaluatePreconditionV1 } from "./observation.js";
export {
  ContinuationCompilerSelectedCapsuleCapacityErrorV1,
  evaluateContinuationSelectionV1,
};
export type {
  ContinuationSelectionEvaluationV1,
  ContinuationSelectionFenceV1,
  EvaluateContinuationSelectionV1Args,
} from "./selection-evaluation.js";
export type { ContinuationCompilerPolicyV1 } from "./compiler-policy.js";
export type { ContinuationCompilerCandidateV1 } from
  "./candidate-retrieval.js";


export type CompileContinuationV1Args = Readonly<{
  schema_version: "continuation_compile_input_v1";
  identity: ContinuationContractV1["identity"];
  authority: ContinuationContractV1["authority"];
  obligations: readonly ContinuationObligationV1[];
  candidates: readonly ContinuationCompilerCandidateV1[];
  candidate_retrieval_receipt: ContinuationCandidateRetrievalReceiptV1;
  observation_snapshot: WorldObservationSnapshotV1;
  compiled_at: string;
  render_budget: number;
  policy: ContinuationCompilerPolicyV1;
}>;

const ALGORITHM_CONTRACT_SHA256 = canonicalContinuationSha256({
  algorithm: "bounded_greedy_coverage_v1",
  invariants: [
    "bounded_candidate_partition",
    "hard_safety_before_positive_coverage",
    "historical_compilation_time_bound",
    "integer_ratio_and_utf8_digest_tiebreak",
    "select_hash_then_render",
  ],
});

function capsuleRef(capsule: ExecutionCapsuleV1): CapsuleRefV1 {
  return {
    capsule_id: capsule.capsule_id,
    capsule_revision: capsule.capsule_revision,
    capsule_sha256: capsule.capsule_sha256,
  };
}

function capsuleRefKey(ref: CapsuleRefV1): string {
  return `${ref.capsule_id}\0${ref.capsule_revision}\0${ref.capsule_sha256}`;
}

function capsuleKey(candidate: ContinuationCompilerCandidateV1): string {
  return capsuleRefKey(candidate.capsule);
}

/**
 * Production wrapper: verifies serving authority, delegates every selection
 * decision to the pure evaluator, then seals the result as an executable
 * continuation contract.
 */
export function compileContinuationV1(
  input: CompileContinuationV1Args,
): ContinuationContractV1 {
  const policy = verifyContinuationCompilerPolicyV1(input.policy);
  const candidateRetrievalReceipt = verifyContinuationCandidateRetrievalReceiptV1(
    input.candidate_retrieval_receipt,
  );
  const args = {
    ...input,
    policy,
    candidate_retrieval_receipt: candidateRetrievalReceipt,
  };
  canonicalContinuationJson(args);
  assertCompileContinuationV1Args(args);

  const authority = args.authority;
  if (authority.compiler_policy_ref.payload_sha256
    !== canonicalContinuationSha256(policy)) {
    throw new Error("compiler policy digest does not match authority binding");
  }
  const canonicalObligations = canonicalUniqueSet(
    args.obligations,
    (obligation) => obligation.obligation_id,
  );
  const candidateRefsByLane = (lane: "verified_continuity" | "governed_learning") =>
    args.candidates.filter((candidate) => candidate.provenance.lane === lane)
      .map((candidate) => capsuleRef(candidate.capsule));
  const receiptSelected = candidateRetrievalReceipt.selected;
  const receiptRefDigest = (refs: readonly CapsuleRefV1[]) =>
    canonicalContinuationSha256({
      capsule_refs: canonicalUniqueSet(refs, capsuleRefKey),
    });
  if (candidateRetrievalReceipt.algorithm_contract_sha256
      !== CONTINUATION_CANDIDATE_RETRIEVAL_ALGORITHM_SHA256_V1
    || candidateRetrievalReceipt.overflow_status !== "none"
    || candidateRetrievalReceipt.identity_sha256
      !== canonicalContinuationSha256(args.identity)
    || candidateRetrievalReceipt.obligation_universe_sha256
      !== canonicalContinuationSha256({ obligations: canonicalObligations })
    || candidateRetrievalReceipt.compiler_policy_payload_sha256
      !== canonicalContinuationSha256(policy)
    || candidateRetrievalReceipt.evaluated_at !== args.compiled_at
    || candidateRetrievalReceipt.lane_limits.verified_continuity
      !== policy.continuity_candidate_limit
    || candidateRetrievalReceipt.lane_limits.governed_learning
      !== policy.learning_candidate_limit
    || candidateRetrievalReceipt.selected_capsule_limit
      !== policy.selected_capsule_limit
    || candidateRetrievalReceipt.compiler_candidate_universe_sha256
      !== canonicalContinuationSha256(args.candidates)
    || receiptSelected.verified_continuity.count
      + receiptSelected.governed_learning.count !== args.candidates.length) {
    throw new Error("candidate retrieval receipt does not bind compiler input");
  }
  for (const lane of ["verified_continuity", "governed_learning"] as const) {
    const refs = candidateRefsByLane(lane);
    if (receiptSelected[lane].count !== refs.length
      || receiptSelected[lane].ref_set_sha256 !== receiptRefDigest(refs)) {
      throw new Error("candidate retrieval receipt lane does not bind compiler input");
    }
  }
  const servedIsAuthoritative = continuationAuthorityRefKey(
    authority.served_learning_branch,
  ) === continuationAuthorityRefKey(authority.authoritative_learning_head);
  const receipt = authority.serving_assignment_receipt;
  if (!Number.isSafeInteger(authority.memory_scope_head_revision)
    || authority.memory_scope_head_revision <= 0
    || (authority.serving_mode === "authoritative_unassigned"
      && (!servedIsAuthoritative
        || receipt !== null
        || authority.experiment_cohort_ref !== null))
    || (authority.serving_mode === "assigned_control"
      && (!servedIsAuthoritative || receipt?.arm !== "control"
        || authority.experiment_cohort_ref === null))
    || (authority.serving_mode === "assigned_candidate"
      && (servedIsAuthoritative || receipt?.arm !== "candidate"
        || authority.experiment_cohort_ref === null))) {
    throw new Error("continuation authority binding is invalid");
  }
  if (receipt !== null) {
    assertSha256(
      receipt.serving_assignment_receipt_sha256,
      "serving_assignment_receipt_sha256",
    );
    if (canonicalSha256Without(receipt, "serving_assignment_receipt_sha256")
      !== receipt.serving_assignment_receipt_sha256) {
      throw new Error("serving assignment receipt digest mismatch");
    }
  }

  const evaluation = evaluateContinuationSelectionV1({
    schema_version: "continuation_selection_input_v1",
    identity: args.identity,
    fence: {
      authority_subject_sha256: authority.authority_subject_sha256,
      evaluated_learning_branch: authority.served_learning_branch,
      memory_scope_head_revision: authority.memory_scope_head_revision,
      memory_scope_head_sha256: authority.memory_scope_head_sha256,
      compiler_policy_payload_sha256: authority.compiler_policy_ref.payload_sha256,
    },
    obligations: args.obligations,
    candidates: args.candidates,
    observation_snapshot: args.observation_snapshot,
    evaluated_at: args.compiled_at,
    render_budget: args.render_budget,
    projection_frame_bytes: continuationProjectionFrameBytesV1({
      identity: args.identity,
      authority,
      obligations: args.obligations,
      rehydration_capsule_refs: [],
    }),
    forced_excluded_capsule_refs: [],
    policy,
  });
  if (evaluation.candidate_universe_sha256
      !== candidateRetrievalReceipt.compiler_candidate_universe_sha256
    || evaluation.candidate_partition.candidate_count !== args.candidates.length) {
    throw new Error("candidate retrieval receipt drifted from coverage candidate universe");
  }
  const exactRenderCost = measureContinuationProjectionBytesV1({
    identity: args.identity,
    authority,
    obligations: evaluation.obligations,
    selected_capsules: evaluation.render_plan.selected_capsules,
    rehydration_capsule_refs: evaluation.safe_fallback.rehydration_capsule_refs,
    safe_fallback_mode: evaluation.safe_fallback.mode,
  });
  if (exactRenderCost !== evaluation.required_render_bytes) {
    throw new Error(
      "continuation compiler render-cost accounting drifted from the canonical renderer",
    );
  }

  const certificateBody = {
    certificate_version: "continuation_coverage_certificate_v1" as const,
    compilation_input_sha256: canonicalContinuationSha256({
      schema_version: args.schema_version,
      identity: args.identity,
      authority,
      obligations: evaluation.obligations,
      candidates: canonicalUniqueSet(args.candidates, capsuleKey),
      candidate_retrieval_receipt: candidateRetrievalReceipt,
      observations: verifyWorldObservationSnapshotV1(
        args.observation_snapshot,
      ).observations,
      compiled_at: args.compiled_at,
      render_budget: args.render_budget,
      policy,
    }),
    obligation_universe_sha256: evaluation.obligation_universe_sha256,
    candidate_universe_sha256: evaluation.candidate_universe_sha256,
    world_snapshot_sha256: args.identity.world_snapshot_sha256,
    selected_surface_sha256: evaluation.selected_surface_sha256,
    coverage: evaluation.coverage,
    candidate_partition: evaluation.candidate_partition,
    hard_obligation_coverage_complete:
      evaluation.hard_obligation_coverage_complete,
    direct_use_preconditions_complete:
      evaluation.direct_use_preconditions_complete,
    conflict_free: evaluation.conflict_free,
    budget_satisfied: evaluation.budget_satisfied,
    required_render_bytes: exactRenderCost,
    status: evaluation.status,
    reason_codes: evaluation.reason_codes,
  };
  const coverageCertificate = canonicalContinuationClone({
    ...certificateBody,
    certificate_sha256: canonicalContinuationSha256(certificateBody),
  });
  const contractBody = {
    schema_version: "continuation_contract_v1" as const,
    identity: args.identity,
    authority,
    obligations: evaluation.obligations,
    selected_capsules: evaluation.selected_capsules,
    excluded_capsules: evaluation.excluded_capsules,
    coverage_certificate: coverageCertificate,
    safe_fallback: {
      mode: evaluation.safe_fallback.mode,
      reason_codes: evaluation.safe_fallback.reason_codes,
      unresolved_obligation_ids:
        evaluation.safe_fallback.unresolved_obligation_ids,
    },
    compiler: {
      algorithm: "bounded_greedy_coverage_v1" as const,
      algorithm_contract_sha256: ALGORITHM_CONTRACT_SHA256,
      compiled_at: args.compiled_at,
      candidate_limit: policy.candidate_limit,
      continuity_candidate_limit: policy.continuity_candidate_limit,
      learning_candidate_limit: policy.learning_candidate_limit,
      selected_capsule_limit: policy.selected_capsule_limit,
      obligation_limit: policy.obligation_limit,
      render_budget: args.render_budget,
      candidate_retrieval_receipt: candidateRetrievalReceipt,
    },
  };
  return canonicalContinuationClone({
    ...contractBody,
    contract_sha256: canonicalContinuationSha256(contractBody),
  });
}

export function continuationCompilerAlgorithmContractSha256(): Sha256 {
  return ALGORITHM_CONTRACT_SHA256;
}

export function continuationCompilerPolicySha256(policy: ContinuationCompilerPolicyV1): Sha256 {
  return canonicalContinuationSha256(verifyContinuationCompilerPolicyV1(policy));
}

export function continuationAuthorityRefKey(ref: AuthorityBranchRefV1): string {
  return `${ref.branch_id}\0${ref.branch_revision}\0${ref.manifest_sha256}`;
}

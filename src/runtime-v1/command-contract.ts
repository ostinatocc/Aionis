import type {
  AuthorityArtifactRefV1,
  CanonicalJson,
  CapsuleCoverageClaimV1,
  CapsuleRefV1,
  ContinuationObligationV1,
  HostObservationV1,
  HostObservationValueV1,
  Sha256,
  TargetRefV1,
  TypedPreconditionSpecV1,
} from "../continuation/contract.js";
import type { ContinuationRehydrationRefV1 } from
  "../continuation/rehydration-ref.js";
import type { EffectTreatmentDeltaSetV1 } from
  "../continuation/effect-certificate.js";
import type { EffectEvidenceMemberSetV1 } from "../continuation/episode.js";
import type { HostUseReceiptV1, OutcomeReceiptV1 } from
  "../continuation/outcome.js";
import type { HostTaskEnvelopeInputV1 } from "../continuation/task-envelope.js";

export type RuntimeV1MutationCommandKind = "record_observations" | "create_continuation"
  | "record_outcome" | "authority_decision" | "worker_completion";
export type RuntimeV1CommandActorKind = "trusted_host" | "operator" | "worker";
export type RuntimeV1CanonicalObject = Readonly<{ readonly [key: string]: CanonicalJson }>;
export type RuntimeCommandScopeSelectorV1 = Readonly<{ scope: string }>;
export type AuthenticatedRuntimeCommandBindingV1 = Readonly<{
  tenant_id: string;
  scope: string;
  actor_kind: RuntimeV1CommandActorKind;
  actor_principal_sha256: Sha256;
}>;
export type VerifiedSnapshotCommandBindingV1 = AuthenticatedRuntimeCommandBindingV1 & Readonly<{
  actor_kind: "trusted_host";
  task_family: string;
  authority_subject_sha256: Sha256;
  world_snapshot_id: string;
  world_snapshot_sha256: Sha256;
}>;
export type VerifiedDecisionCommandBindingV1 = AuthenticatedRuntimeCommandBindingV1 & Readonly<{
  actor_kind: "trusted_host" | "operator";
  task_family: string;
  authority_subject_sha256: Sha256;
  decision_id: string;
  contract_sha256: Sha256;
  render_result_sha256: Sha256;
  exposure_receipt_sha256: Sha256;
  host_task_envelope_sha256: Sha256;
}>;
export type VerifiedAuthorityCommandBindingV1 = AuthenticatedRuntimeCommandBindingV1 & Readonly<{
  actor_kind: "operator";
  task_family: string;
  authority_subject_sha256: Sha256;
}>;
export type RuntimeV1DurableJobKind = "embedding" | "ann" | "effect" | "retention";
export type VerifiedLeasedJobCommandBindingV1 = AuthenticatedRuntimeCommandBindingV1 & Readonly<{
  actor_kind: "worker";
  task_family: string;
  authority_subject_sha256: Sha256;
  job_id: string;
  job_kind: RuntimeV1DurableJobKind;
  job_payload_sha256: Sha256;
  attempt_count: number;
  lease_token_sha256: Sha256;
}>;
export type CollectorObservationCommandInputV1 = Readonly<{
  schema_version: "collector_observation_v1";
  observation_id: string;
  probe_id: string;
  probe_spec_sha256: Sha256;
  observed_at: string;
  expires_at: string;
  value: HostObservationValueV1;
  evidence_sha256: Sha256;
}>;
/**
 * A host may propose typed content, but it cannot write Runtime authority.
 * Memory IDs, lifecycle, authority, relations, capsule IDs/revisions, and
 * branch membership are derived inside the authenticated command handler.
 */
export type HostMemoryInputV1 = Readonly<{
  memory_input_id: string;
  kind: "current_state" | "verified_fact" | "procedure" | "constraint"
    | "counter_evidence";
  applicability: Readonly<{
    task_signature: string | null;
    workflow_signature: string | null;
    workspace_signature: string | null;
  }>;
  projection: Readonly<{
    summary: string;
    next_action: string | null;
    target_refs: readonly TargetRefV1[];
    workflow_steps: readonly string[];
    acceptance_statements: readonly string[];
  }>;
  coverage_claims: readonly Readonly<
    Omit<CapsuleCoverageClaimV1, "coverage_claim_sha256">
  >[];
  precondition_specs: readonly TypedPreconditionSpecV1[];
  evidence_observation_ids: readonly string[];
  expires_at: string | null;
}>;
export type RecordObservationsBodyV1 = Readonly<{
  schema_version: "record_observations_body_v1";
  host_task: HostTaskEnvelopeInputV1;
  memory_inputs: readonly HostMemoryInputV1[];
  collector_observations: readonly CollectorObservationCommandInputV1[];
  signed_observations: readonly HostObservationV1[];
}>;
export type CreateContinuationBodyV1 = Readonly<{
  schema_version: "create_continuation_body_v1";
  world_snapshot_ref: Readonly<{ world_snapshot_id: string; world_snapshot_sha256: Sha256 }>;
  obligations: readonly ContinuationObligationV1[];
  render_budget_bytes: number;
}>;
export type RecordOutcomeBodyV1 = Readonly<{
  schema_version: "record_outcome_body_v1";
  decision_ref: Readonly<{
    decision_id: string;
    contract_sha256: Sha256;
    exposure_receipt_sha256: Sha256;
  }>;
  use_receipt: HostUseReceiptV1;
  outcome_receipt: OutcomeReceiptV1;
}>;
export type CapsuleBranchRefV1 = Readonly<{
  branch_id: string;
  branch_revision: number;
  manifest_sha256: Sha256;
}>;
export type AuthorityDecisionBodyV1 = Readonly<{
  schema_version: "authority_decision_body_v1";
  expected_head: Readonly<{ revision: number; head_sha256: Sha256 }>;
  decision:
    | Readonly<{ kind: "lifecycle_suppress" | "lifecycle_restore" | "lifecycle_quarantine";
      memory_id: string;
      expected_memory_head: Readonly<{ revision: number; head_sha256: Sha256 }>;
      reason_codes: readonly string[] }>
    | Readonly<{ kind: "lifecycle_archive";
      memory_id: string;
      expected_memory_head: Readonly<{ revision: number; head_sha256: Sha256 }>;
      rehydration_ref: ContinuationRehydrationRefV1;
      reason_codes: readonly string[] }>
    | Readonly<{ kind: "candidate_advance"; candidate: CapsuleBranchRefV1;
      target_state: "shadow" | "eligible" | "active_candidate";
      reason_codes: readonly string[]; evidence_sha256s: readonly Sha256[] }>
    | Readonly<{ kind: "branch_merge"; candidate: CapsuleBranchRefV1;
      effect_certificate_sha256: Sha256 }>
    | Readonly<{ kind: "branch_reject" | "branch_quarantine" | "branch_expire";
      candidate: CapsuleBranchRefV1; reason_codes: readonly string[];
      evidence_sha256s: readonly Sha256[] }>
    | Readonly<{ kind: "authority_revert"; target: CapsuleBranchRefV1;
      reason_codes: readonly string[]; evidence_sha256s: readonly Sha256[] }>
    | Readonly<{ kind: "policy_rotate"; artifact_ref: AuthorityArtifactRefV1 }>;
}>;
export type WorkerCompletionBodyV1 = Readonly<{
  schema_version: "worker_completion_body_v1";
  completion:
    | Readonly<{ status: "succeeded"; output:
      | Readonly<{ kind: "embedding"; artifact_ref: RuntimeV1CanonicalObject }>
      | Readonly<{ kind: "ann"; index_receipt: RuntimeV1CanonicalObject }>
      | Readonly<{
        kind: "effect";
        signed_certificate: RuntimeV1CanonicalObject;
        eligible_decision_set: EffectEvidenceMemberSetV1;
        treatment_delta_set: EffectTreatmentDeltaSetV1;
      }>
      | Readonly<{ kind: "retention"; result: RuntimeV1CanonicalObject }> }>
    | Readonly<{ status: "retry" | "dead"; retry_at: string | null;
      error: RuntimeV1CanonicalObject }>;
}>;
export type AuthenticatedMutationCommandV1<
  K extends RuntimeV1MutationCommandKind,
  B,
> = Readonly<{
  schema_version: "authenticated_runtime_command_v1";
  operation_kind: K;
  operation_id: string;
  tenant_id: string;
  scope: string;
  actor_kind: RuntimeV1CommandActorKind;
  actor_principal_sha256: Sha256;
  authority_subject_sha256: Sha256 | null;
  body: B;
  body_sha256: Sha256;
  command_sha256: Sha256;
}>;
export type RecordObservationsCommandV1 = AuthenticatedMutationCommandV1<
  "record_observations", RecordObservationsBodyV1
>;
export type CreateContinuationCommandV1 = AuthenticatedMutationCommandV1<
  "create_continuation", CreateContinuationBodyV1
>;
export type RecordOutcomeCommandV1 = AuthenticatedMutationCommandV1<
  "record_outcome", RecordOutcomeBodyV1
>;
export type AuthorityDecisionCommandV1 = Readonly<
  Omit<AuthenticatedMutationCommandV1<"authority_decision", AuthorityDecisionBodyV1>,
  "command_sha256"> & Readonly<{
    /** Verified forward authority binding; never reconstructed from capsules. */
    task_family: string;
    command_sha256: Sha256;
  }>
>;
export type WorkerCompletionCommandV1 = Readonly<
  Omit<AuthenticatedMutationCommandV1<"worker_completion", WorkerCompletionBodyV1>,
  "command_sha256"> & Readonly<{
    leased_job_binding: Readonly<{
      job_id: string;
      job_kind: RuntimeV1DurableJobKind;
      job_payload_sha256: Sha256;
      attempt_count: number;
      lease_token_sha256: Sha256;
    }>;
    command_sha256: Sha256;
  }>
>;
export type RuntimeV1MutationCommand = RecordObservationsCommandV1
  | CreateContinuationCommandV1 | RecordOutcomeCommandV1
  | AuthorityDecisionCommandV1 | WorkerCompletionCommandV1;
export type DecisionQueryBodyV1 = Readonly<{
  view: "summary" | "full" | "counterfactual";
  exclude_capsule: CapsuleRefV1 | null;
  substitute_branch: CapsuleBranchRefV1 | null;
}>;
export type AuthenticatedDecisionQueryV1 = Readonly<{
  schema_version: "authenticated_decision_query_v1";
  tenant_id: string;
  scope: string;
  actor_kind: "trusted_host" | "operator";
  actor_principal_sha256: Sha256;
  authority_subject_sha256: Sha256;
  decision_id: string;
  body: DecisionQueryBodyV1;
  body_sha256: Sha256;
  query_sha256: Sha256;
}>;

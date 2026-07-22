import type {
  CanonicalJson,
  Sha256,
} from "../continuation/contract.js";
import type { EpisodeEventRefV1 } from "../continuation/episode.js";

export type ContinuationRuntimeV1OperationResultDerivationBinding = Readonly<{
  tenantId: string;
  scope: string;
  operationKind:
    | "record_observations"
    | "create_continuation"
    | "record_outcome"
    | "authority_decision"
    | "worker_completion";
  operationId: string;
  requestSha256: string;
  actorKind: "trusted_host" | "operator" | "worker";
  actorPrincipalSha256: string;
}>;

export type ContinuationRuntimeV1OperationResultDerivationMode =
  | "before_receipt_insert"
  | "replay";

export type ContinuationRuntimeV1OperationResultSetV1<
  TRef extends CanonicalJson,
> = Readonly<{
  count: number;
  set_sha256: Sha256;
  refs: readonly TRef[];
}>;

export type ObservationSnapshotOperationRefV1 = Readonly<{
  world_snapshot_id: string;
  world_snapshot_sha256: Sha256;
  host_task_envelope_sha256: Sha256;
}>;

export type MemoryRevisionOperationRefV1 = Readonly<{
  revision: number;
  commit_id: string;
  commit_sha256: Sha256;
  mutation_sha256: Sha256;
  head_sha256: Sha256;
  item_count: number;
  item_set_sha256: Sha256;
  relation_count: number;
  relation_set_sha256: Sha256;
  capsule_count: number;
  capsule_set_sha256: Sha256;
}>;

export type AuthorityArtifactOperationRefV1 = Readonly<{
  artifact_id: string;
  artifact_revision: number;
  artifact_kind:
    | "compiler_policy"
    | "evidence_policy"
    | "experiment_cohort"
    | "policy_rotation";
  authority_subject_sha256: Sha256 | null;
  artifact_sha256: Sha256;
  payload_sha256: Sha256;
}>;

export type AuthorityHeadOperationRefV1 = Readonly<{
  head_revision: number;
  head_sha256: Sha256;
}>;

export type AuthorityBranchOperationRefV1 = Readonly<{
  authority_subject_sha256: Sha256;
  branch_id: string;
  branch_revision: number;
  branch_kind: "authoritative" | "candidate";
  branch_state:
    | "authoritative"
    | "draft"
    | "shadow"
    | "eligible"
    | "active_candidate"
    | "merged"
    | "rejected"
    | "quarantined"
    | "expired";
  manifest_sha256: Sha256;
  binding_count: number;
  binding_set_sha256: Sha256;
  authority_head_ref: AuthorityHeadOperationRefV1 | null;
}>;

export type DurableJobCreationOperationRefV1 = Readonly<{
  task_family: string;
  authority_subject_sha256: Sha256;
  job_id: string;
  job_kind: "embedding" | "ann" | "effect" | "retention";
  payload_sha256: Sha256;
  definition_sha256: Sha256;
}>;

export type DurableJobCompletionOperationRefV1 = Readonly<{
  operation_id: string;
  request_sha256: Sha256;
}>;

export type DurableJobTransitionOperationRefV1 = Readonly<{
  job_id: string;
  job_kind: "embedding" | "ann" | "effect" | "retention";
  payload_sha256: Sha256;
  attempt_count: number;
  state: "queued" | "succeeded" | "dead";
  previous_completion_ref: DurableJobCompletionOperationRefV1 | null;
  available_at: string;
  completed_at: string | null;
  terminal_reason:
    | "worker_succeeded"
    | "worker_dead"
    | null;
  last_error_sha256: Sha256 | null;
  updated_at: string;
  transition_sha256: Sha256;
}>;

export type EffectCertificateOperationRefV1 = Readonly<{
  certificate_id: string;
  certificate_sha256: Sha256;
  certificate_projection_sha256: Sha256;
  admission_state: "admitted" | "rejected";
  eligible_decision_count: number;
  eligible_decision_set_sha256: Sha256;
  treatment_delta_count: number;
  treatment_delta_set_sha256: Sha256;
  effect_event_count: number;
  effect_event_set_sha256: Sha256;
}>;

export type RecordObservationsOperationResultV1 = Readonly<{
  schema_version: "record_observations_result_v1";
  observation_snapshot_ref: ObservationSnapshotOperationRefV1;
  memory_revision_ref: MemoryRevisionOperationRefV1 | null;
  authority_branch_set: ContinuationRuntimeV1OperationResultSetV1<
    AuthorityBranchOperationRefV1
  >;
  durable_job_set: ContinuationRuntimeV1OperationResultSetV1<
    DurableJobCreationOperationRefV1
  >;
}>;

export type CreateContinuationOperationResultV1 = Readonly<{
  schema_version: "create_continuation_result_v1";
  episode_id: string;
  decision_id: string;
  event_refs: readonly EpisodeEventRefV1[];
}>;

export type RecordOutcomeOperationResultV1 = Readonly<{
  schema_version: "record_outcome_result_v1";
  episode_id: string;
  decision_id: string;
  event_refs: readonly EpisodeEventRefV1[];
}>;

export type ExperimentCohortInstallAuthorityDecisionResultV1 = Readonly<{
  schema_version: "authority_decision_result_v1";
  decision_kind: "experiment_cohort_install";
  experiment_cohort_ref: Readonly<{
    artifact_sha256: Sha256;
    payload_sha256: Sha256;
  }>;
  effect_job_ref: DurableJobCreationOperationRefV1 & Readonly<{
    job_kind: "effect";
  }>;
}>;

export type PolicyBundleInstallAuthorityDecisionResultV1 = Readonly<{
  schema_version: "authority_decision_result_v1";
  decision_kind: "policy_bundle_install";
  compiler_policy_ref: Readonly<{
    artifact_sha256: Sha256;
    payload_sha256: Sha256;
  }>;
  evidence_policy_ref: Readonly<{
    artifact_sha256: Sha256;
    payload_sha256: Sha256;
  }>;
}>;

export type PolicyRotationInstallAuthorityDecisionResultV1 = Readonly<{
  schema_version: "authority_decision_result_v1";
  decision_kind: "policy_rotation_install";
  policy_rotation_artifact_ref: Readonly<{
    artifact_sha256: Sha256;
    payload_sha256: Sha256;
  }>;
}>;

export type BranchUpdateAuthorityDecisionResultV1 = Readonly<{
  schema_version: "authority_decision_result_v1";
  decision_kind: "branch_update";
  branch_revision_set: ContinuationRuntimeV1OperationResultSetV1<
    AuthorityBranchOperationRefV1
  >;
}>;

export type MemoryUpdateAuthorityDecisionResultV1 = Readonly<{
  schema_version: "authority_decision_result_v1";
  decision_kind: "memory_update";
  memory_revision_ref: MemoryRevisionOperationRefV1;
}>;

export type LifecycleArchiveAuthorityDecisionResultV1 = Readonly<{
  schema_version: "authority_decision_result_v1";
  decision_kind: "lifecycle_archive";
  memory_revision_ref: MemoryRevisionOperationRefV1;
  retention_job_ref: DurableJobCreationOperationRefV1 & Readonly<{
    job_kind: "retention";
  }>;
}>;

export type LifecycleScheduleAuthorityDecisionResultV1 = Readonly<{
  schema_version: "authority_decision_result_v1";
  decision_kind: "lifecycle_schedule";
  durable_job_set: ContinuationRuntimeV1OperationResultSetV1<
    DurableJobCreationOperationRefV1
  >;
}>;

export type AuthorityDecisionOperationResultV1 =
  | ExperimentCohortInstallAuthorityDecisionResultV1
  | PolicyBundleInstallAuthorityDecisionResultV1
  | PolicyRotationInstallAuthorityDecisionResultV1
  | BranchUpdateAuthorityDecisionResultV1
  | MemoryUpdateAuthorityDecisionResultV1
  | LifecycleArchiveAuthorityDecisionResultV1
  | LifecycleScheduleAuthorityDecisionResultV1;

export type WorkerCompletionOperationResultV1 = Readonly<{
  schema_version: "worker_completion_result_v1";
  transition_ref: DurableJobTransitionOperationRefV1;
  memory_revision_ref: MemoryRevisionOperationRefV1 | null;
  effect_certificate_ref: EffectCertificateOperationRefV1 | null;
  durable_job_set: ContinuationRuntimeV1OperationResultSetV1<
    DurableJobCreationOperationRefV1
  >;
}>;

export type ContinuationRuntimeV1OperationResultV1 =
  | RecordObservationsOperationResultV1
  | CreateContinuationOperationResultV1
  | RecordOutcomeOperationResultV1
  | AuthorityDecisionOperationResultV1
  | WorkerCompletionOperationResultV1;

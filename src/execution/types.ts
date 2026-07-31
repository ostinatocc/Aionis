import { z } from "zod";
import stableStringify from "fast-json-stable-stringify";
import { ExecutionStringListSchema } from "./schema-limits.js";
import { sha256Hex } from "../util/crypto.js";

export const ExecutionStage = z.enum(["triage", "patch", "review", "resume"]);
export type ExecutionStage = z.infer<typeof ExecutionStage>;

export const ExecutionRole = z.enum(["orchestrator", "triage", "patch", "review", "resume"]);
export type ExecutionRole = z.infer<typeof ExecutionRole>;

const StringList = ExecutionStringListSchema;

export const ServiceLifecycleKind = z.enum(["generic", "http", "tcp", "process"]);
export type ServiceLifecycleKind = z.infer<typeof ServiceLifecycleKind>;

export const ServiceLifecycleConstraintV1Schema = z.object({
  version: z.literal(1),
  service_kind: ServiceLifecycleKind.default("generic"),
  label: z.string().trim().min(1),
  launch_reference: z.string().trim().min(1).nullable().default(null),
  endpoint: z.string().trim().min(1).nullable().default(null),
  must_survive_agent_exit: z.boolean().default(false),
  revalidate_from_fresh_shell: z.boolean().default(false),
  detach_then_probe: z.boolean().default(false),
  health_checks: StringList,
  teardown_notes: StringList,
});
export type ServiceLifecycleConstraintV1 = z.infer<typeof ServiceLifecycleConstraintV1Schema>;

export const ReviewerContractSchema = z.object({
  standard: z.string().trim().min(1),
  required_outputs: StringList,
  acceptance_checks: StringList,
  rollback_required: z.boolean().default(false),
});
export type ReviewerContract = z.infer<typeof ReviewerContractSchema>;

export const ResumeAnchorSchema = z.object({
  anchor: z.string().trim().min(1),
  file_path: z.string().trim().min(1).nullable().default(null),
  symbol: z.string().trim().min(1).nullable().default(null),
  repo_root: z.string().trim().min(1).nullable().default(null),
});
export type ResumeAnchor = z.infer<typeof ResumeAnchorSchema>;

export const ExecutionStateV1Schema = z.object({
  state_id: z.string().trim().min(1),
  scope: z.string().trim().min(1),
  task_brief: z.string().trim().min(1),
  current_stage: ExecutionStage,
  active_role: ExecutionRole,
  owned_files: StringList,
  modified_files: StringList,
  pending_validations: StringList,
  completed_validations: StringList,
  last_accepted_hypothesis: z.string().trim().min(1).nullable().default(null),
  rejected_paths: StringList,
  unresolved_blockers: StringList,
  rollback_notes: StringList,
  service_lifecycle_constraints: z.array(ServiceLifecycleConstraintV1Schema).max(16).default([]),
  reviewer_contract: ReviewerContractSchema.nullable().default(null),
  resume_anchor: ResumeAnchorSchema.nullable().default(null),
  updated_at: z.string().datetime(),
  version: z.literal(1),
});
export type ExecutionStateV1 = z.infer<typeof ExecutionStateV1Schema>;

const ExecutionSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const CurrentExecutionStateIdSchema = z.string().trim().min(1).max(256);
const CurrentExecutionStateStatementSchema = z.string().superRefine(
  (value, context) => {
    if (
      value.length === 0
      || value !== value.trim()
      || Buffer.byteLength(value, "utf8") > 64 * 1024
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Current execution state statements must be exact, non-empty, and at most 64 KiB",
      });
    }
  },
);

export const CurrentExecutionEvidenceRefV2Schema = z.object({
  artifact_id: CurrentExecutionStateIdSchema,
  kind: z.string().trim().min(1).max(120),
  sha256: ExecutionSha256Schema,
  storage_ref: z.string().trim().min(1).max(2048),
}).strict();
export type CurrentExecutionEvidenceRefV2 = z.infer<
  typeof CurrentExecutionEvidenceRefV2Schema
>;

export const CurrentExecutionEventRefV2Schema = z.object({
  event_id: CurrentExecutionStateIdSchema,
  event_sha256: ExecutionSha256Schema,
  sequence: z.number().int().nonnegative(),
}).strict();
export type CurrentExecutionEventRefV2 = z.infer<
  typeof CurrentExecutionEventRefV2Schema
>;

export const CurrentExecutionStateProjectionTransitionV1Schema = z.object({
  contract_version:
    z.literal("current_execution_state_projection_transition_v1"),
  continuation_id: CurrentExecutionStateIdSchema,
  source_event: CurrentExecutionEventRefV2Schema,
  expected_revision: z.number().int().positive(),
  expected_state_sha256: ExecutionSha256Schema,
  projected_revision: z.number().int().positive(),
  projected_state_sha256: ExecutionSha256Schema,
  projected_at: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (
    value.projected_revision !== value.expected_revision + 1
    || value.source_event.sequence + 1 !== value.projected_revision
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projected_revision"],
      message:
        "Current-state projection revision must extend its source event and expected head",
    });
  }
});
export type CurrentExecutionStateProjectionTransitionV1 = z.infer<
  typeof CurrentExecutionStateProjectionTransitionV1Schema
>;

export const CurrentExecutionClaimAuthorityV2Schema = z.object({
  kind: z.enum(["host_declared", "runtime_derived", "model_derived"]),
  actor_id: CurrentExecutionStateIdSchema,
  model_id: CurrentExecutionStateIdSchema.nullable(),
  derivation_sha256: ExecutionSha256Schema.nullable(),
  uncertainty: z.number().finite().min(0).max(1).nullable(),
}).strict();
export type CurrentExecutionClaimAuthorityV2 = z.infer<
  typeof CurrentExecutionClaimAuthorityV2Schema
>;

const CurrentExecutionProvenanceV2Schema = z.object({
  authority: CurrentExecutionClaimAuthorityV2Schema,
  evidence_refs: z.array(CurrentExecutionEvidenceRefV2Schema).min(1).max(64),
  source_event: CurrentExecutionEventRefV2Schema,
  target_state_snapshot_id: CurrentExecutionStateIdSchema,
  recorded_at: z.string().datetime(),
}).strict();

export const CurrentExecutionItemV2Schema =
  CurrentExecutionProvenanceV2Schema.extend({
    item_id: CurrentExecutionStateIdSchema,
    statement: CurrentExecutionStateStatementSchema,
  }).strict();
export type CurrentExecutionItemV2 = z.infer<
  typeof CurrentExecutionItemV2Schema
>;

export const CurrentExecutionObservationV2Schema =
  CurrentExecutionProvenanceV2Schema.extend({
    observation_id: CurrentExecutionStateIdSchema,
    statement: CurrentExecutionStateStatementSchema,
  }).strict();
export type CurrentExecutionObservationV2 = z.infer<
  typeof CurrentExecutionObservationV2Schema
>;

export const CurrentExecutionDecisionV2Schema =
  CurrentExecutionProvenanceV2Schema.extend({
    decision_id: CurrentExecutionStateIdSchema,
    statement: CurrentExecutionStateStatementSchema,
    reasons: z.array(CurrentExecutionStateStatementSchema).min(1).max(64),
    alternatives_rejected:
      z.array(CurrentExecutionStateStatementSchema).max(64),
  }).strict();
export type CurrentExecutionDecisionV2 = z.infer<
  typeof CurrentExecutionDecisionV2Schema
>;

export const CurrentExecutionActionSufficiencyV1Schema =
  z.object({
    contract_version:
      z.literal("action_sufficiency_decision_v1"),
    status: z.enum([
      "local_evidence_ready",
      "needs_discrimination",
    ]),
    recommended_mode: z.enum([
      "act_or_name_blocker",
      "inspect_once_then_decide",
    ]),
    maximum_additional_observations:
      z.union([z.literal(0), z.literal(1)]),
    information_value_rule:
      z.literal("observe_only_if_named_unknown_can_change_action"),
    reason_codes: z.array(z.enum([
      "task_relevant_exact_evidence",
      "local_executable_structure",
      "task_overlap_absent",
      "local_executable_structure_absent",
      "search_frontier_requires_local_context",
      "multiple_candidate_resources",
      "definition_call_relation_available",
      "source_compacted",
      "source_truncated",
    ])).min(1).max(9),
  }).strict();
export type CurrentExecutionActionSufficiencyV1 = z.infer<
  typeof CurrentExecutionActionSufficiencyV1Schema
>;

export const CurrentExecutionJustifiedActionV2Schema =
  CurrentExecutionProvenanceV2Schema.extend({
    action_id: CurrentExecutionStateIdSchema,
    intent: CurrentExecutionStateStatementSchema,
    justification: CurrentExecutionStateStatementSchema,
    preconditions: z.array(CurrentExecutionStateStatementSchema).max(64),
    continuity_kind:
      z.enum(["read_cursor", "search_frontier"]).optional(),
    action_sufficiency:
      CurrentExecutionActionSufficiencyV1Schema.optional(),
  }).strict();
export type CurrentExecutionJustifiedActionV2 = z.infer<
  typeof CurrentExecutionJustifiedActionV2Schema
>;

export const CurrentExecutionVerifiedFactV2Schema = z.object({
  fact_id: CurrentExecutionStateIdSchema,
  statement: CurrentExecutionStateStatementSchema,
  status: z.enum([
    "passed",
    "failed",
    "infrastructure_error",
    "inconclusive",
  ]),
  verifier_id: CurrentExecutionStateIdSchema,
  target_state_snapshot_id: CurrentExecutionStateIdSchema,
  evidence_refs: z.array(CurrentExecutionEvidenceRefV2Schema).min(1).max(64),
  source_event: CurrentExecutionEventRefV2Schema,
  verified_at: z.string().datetime(),
}).strict();
export type CurrentExecutionVerifiedFactV2 = z.infer<
  typeof CurrentExecutionVerifiedFactV2Schema
>;

export const CurrentExecutionPendingCheckV2Schema = z.object({
  check_id: CurrentExecutionStateIdSchema,
  verifier_id: CurrentExecutionStateIdSchema,
  verifier_definition_sha256: ExecutionSha256Schema,
  status: z.literal("pending"),
  target_state_snapshot_id: CurrentExecutionStateIdSchema,
}).strict();
export type CurrentExecutionPendingCheckV2 = z.infer<
  typeof CurrentExecutionPendingCheckV2Schema
>;

export const CurrentExecutionDecisiveEvidenceV1Schema = z.object({
  evidence_id: CurrentExecutionStateIdSchema,
  claim_kind: z.enum([
    "observation",
    "decision",
    "progress",
    "planned_action",
  ]),
  claim_id: CurrentExecutionStateIdSchema,
  source_ref: z.string().superRefine((value, context) => {
    if (
      value.length === 0
      || value !== value.trim()
      || Buffer.byteLength(value, "utf8") > 512
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Decisive evidence source references must be exact and at most 512 UTF-8 bytes",
      });
    }
  }),
  excerpt: z.string().superRefine((value, context) => {
    if (
      value.length === 0
      || value !== value.trim()
      || Buffer.byteLength(value, "utf8") > 2_048
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Decisive evidence excerpts must be exact and at most 2048 UTF-8 bytes",
      });
    }
  }),
  excerpt_sha256: ExecutionSha256Schema,
  evidence_artifact: CurrentExecutionEvidenceRefV2Schema,
  source_event: CurrentExecutionEventRefV2Schema,
}).strict().superRefine((value, context) => {
  if (value.excerpt_sha256 !== sha256Hex(value.excerpt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["excerpt_sha256"],
      message: "Decisive evidence digest must bind the exact excerpt",
    });
  }
});
export type CurrentExecutionDecisiveEvidenceV1 = z.infer<
  typeof CurrentExecutionDecisiveEvidenceV1Schema
>;

export const CurrentExecutionSubjectV2Schema = z.object({
  kind: z.string().trim().min(1).max(120),
  adapter_id: z.string().trim().min(1).max(120),
  adapter_version: z.string().trim().min(1).max(120),
  identity_sha256: ExecutionSha256Schema,
  current_snapshot_id: CurrentExecutionStateIdSchema,
  current_snapshot_ref: z.string().trim().min(1).max(2048),
  current_content_sha256: ExecutionSha256Schema,
}).strict();
export type CurrentExecutionSubjectV2 = z.infer<
  typeof CurrentExecutionSubjectV2Schema
>;

export const CurrentExecutionTaskConstraintV1Schema = z.object({
  constraint_id: CurrentExecutionStateIdSchema,
  statement: CurrentExecutionStateStatementSchema,
  statement_sha256: ExecutionSha256Schema,
  source_start_utf8_byte: z.number().int().nonnegative(),
  source_end_utf8_byte: z.number().int().positive(),
  obligation: z.literal("required"),
  status: z.enum(["unresolved", "satisfied", "violated"]),
}).strict().superRefine((value, context) => {
  if (value.source_end_utf8_byte <= value.source_start_utf8_byte) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_end_utf8_byte"],
      message: "Task-constraint source spans must be non-empty",
    });
  }
  if (value.statement_sha256 !== sha256Hex(value.statement)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["statement_sha256"],
      message: "Task constraints must bind their exact retained statement",
    });
  }
});
export type CurrentExecutionTaskConstraintV1 = z.infer<
  typeof CurrentExecutionTaskConstraintV1Schema
>;

export const CurrentExecutionTaskContractV1Schema = z.object({
  contract_version: z.literal("current_execution_task_contract_v1"),
  source_text_sha256: ExecutionSha256Schema,
  source_complete_in_state: z.boolean(),
  source_evidence_ref: CurrentExecutionEvidenceRefV2Schema,
  verification_status: z.enum([
    "unverified",
    "passed",
    "failed",
    "infrastructure_error",
    "inconclusive",
  ]),
  constraints:
    z.array(CurrentExecutionTaskConstraintV1Schema).min(1).max(128),
  coverage: z.object({
    required_count: z.number().int().positive().max(128),
    satisfied_count: z.number().int().nonnegative().max(128),
    violated_count: z.number().int().nonnegative().max(128),
    unresolved_count: z.number().int().nonnegative().max(128),
  }).strict(),
}).strict().superRefine((value, context) => {
  const identities = value.constraints.map(
    (constraint) => constraint.constraint_id,
  );
  if (new Set(identities).size !== identities.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["constraints"],
      message: "Task constraints must have unique identities",
    });
  }
  const satisfiedCount = value.constraints.filter(
    (constraint) => constraint.status === "satisfied",
  ).length;
  const violatedCount = value.constraints.filter(
    (constraint) => constraint.status === "violated",
  ).length;
  const unresolvedCount = value.constraints.length
    - satisfiedCount
    - violatedCount;
  if (
    value.coverage.required_count !== value.constraints.length
    || value.coverage.satisfied_count !== satisfiedCount
    || value.coverage.violated_count !== violatedCount
    || value.coverage.unresolved_count !== unresolvedCount
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["coverage"],
      message: "Task-contract coverage must match its exact constraints",
    });
  }
});
export type CurrentExecutionTaskContractV1 = z.infer<
  typeof CurrentExecutionTaskContractV1Schema
>;

export const CurrentExecutionBeliefV1Schema =
  CurrentExecutionProvenanceV2Schema.extend({
    belief_id: CurrentExecutionStateIdSchema,
    statement: CurrentExecutionStateStatementSchema,
    epistemic_status: z.enum([
      "supported",
      "reported",
      "hypothesis",
      "unknown",
      "contradicted",
    ]),
    counter_evidence_refs:
      z.array(CurrentExecutionEvidenceRefV2Schema).max(64),
  }).strict();
export type CurrentExecutionBeliefV1 = z.infer<
  typeof CurrentExecutionBeliefV1Schema
>;

export const CurrentExecutionEpistemicStateV1Schema = z.object({
  contract_version: z.literal("current_execution_epistemic_state_v1"),
  beliefs: z.array(CurrentExecutionBeliefV1Schema).max(256),
  supported_count: z.number().int().nonnegative().max(256),
  reported_count: z.number().int().nonnegative().max(256),
  hypothesis_count: z.number().int().nonnegative().max(256),
  unknown_count: z.number().int().nonnegative().max(256),
  contradicted_count: z.number().int().nonnegative().max(256),
}).strict().superRefine((value, context) => {
  for (const status of [
    "supported",
    "reported",
    "hypothesis",
    "unknown",
    "contradicted",
  ] as const) {
    const supplied = value[`${status}_count`];
    const actual = value.beliefs.filter(
      (belief) => belief.epistemic_status === status,
    ).length;
    if (supplied !== actual) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [`${status}_count`],
        message: "Epistemic-state counts must match the belief ledger",
      });
    }
  }
});
export type CurrentExecutionEpistemicStateV1 = z.infer<
  typeof CurrentExecutionEpistemicStateV1Schema
>;

export const CurrentExecutionBranchCandidateV1Schema = z.object({
  snapshot_id: CurrentExecutionStateIdSchema,
  content_sha256: ExecutionSha256Schema,
  snapshot_ref: z.string().trim().min(1).max(2048).nullable(),
  verification_status: z.enum([
    "unverified",
    "passed",
    "failed",
    "infrastructure_error",
    "inconclusive",
  ]),
  verifier_id: CurrentExecutionStateIdSchema.nullable(),
  verifier_receipt_id: CurrentExecutionStateIdSchema.nullable(),
  verified_at: z.string().datetime().nullable(),
}).strict().superRefine((value, context) => {
  const hasVerification = value.verification_status !== "unverified";
  if (
    hasVerification !== (
      value.verifier_id !== null
      && value.verifier_receipt_id !== null
      && value.verified_at !== null
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verification_status"],
      message:
        "Verified branch candidates must bind their verifier receipt and time",
    });
  }
});
export type CurrentExecutionBranchCandidateV1 = z.infer<
  typeof CurrentExecutionBranchCandidateV1Schema
>;

export const CurrentExecutionCandidateDeltaV1Schema = z.object({
  source_snapshot_id: CurrentExecutionStateIdSchema,
  action_id: CurrentExecutionStateIdSchema,
  action_kind: CurrentExecutionStateIdSchema,
  tool_name: CurrentExecutionStateIdSchema.nullable(),
  delta_id: CurrentExecutionStateIdSchema,
  delta_content_sha256: ExecutionSha256Schema,
  delta_ref: CurrentExecutionEvidenceRefV2Schema,
  changed_field_count: z.number().int().nonnegative().max(200_000),
  changed_fields_preview:
    z.array(z.string().trim().min(1).max(2048)).max(64),
  changed_fields_complete: z.boolean(),
}).strict().superRefine((value, context) => {
  if (
    value.delta_content_sha256 !== value.delta_ref.sha256
    || value.changed_fields_preview.length > value.changed_field_count
    || value.changed_fields_complete !== (
      value.changed_fields_preview.length === value.changed_field_count
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Candidate delta summary must bind its exact evidence and declared field count",
    });
  }
  for (
    let index = 1;
    index < value.changed_fields_preview.length;
    index += 1
  ) {
    if (
      Buffer.compare(
        Buffer.from(value.changed_fields_preview[index - 1]!, "utf8"),
        Buffer.from(value.changed_fields_preview[index]!, "utf8"),
      ) >= 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changed_fields_preview", index],
        message:
          "Candidate delta fields must be unique and sorted by unsigned UTF-8 bytes",
      });
    }
  }
});
export type CurrentExecutionCandidateDeltaV1 = z.infer<
  typeof CurrentExecutionCandidateDeltaV1Schema
>;

export const CurrentExecutionCandidateLedgerEntryV1Schema = z.object({
  ledger_entry_id: CurrentExecutionStateIdSchema,
  candidate: CurrentExecutionBranchCandidateV1Schema,
  origin: z.enum(["episode_started", "action_mutation"]),
  source_event: CurrentExecutionEventRefV2Schema,
  observed_at: z.string().datetime(),
  transition: CurrentExecutionCandidateDeltaV1Schema.nullable(),
  verification_evidence_refs:
    z.array(CurrentExecutionEvidenceRefV2Schema).max(64),
}).strict().superRefine((value, context) => {
  if (
    (value.origin === "episode_started") !== (value.transition === null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["transition"],
      message:
        "Only the episode root may omit a candidate state transition",
    });
  }
  const hasVerification =
    value.candidate.verification_status !== "unverified";
  if (
    hasVerification !== (value.verification_evidence_refs.length > 0)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verification_evidence_refs"],
      message:
        "Candidate verification evidence must match its verification status",
    });
  }
});
export type CurrentExecutionCandidateLedgerEntryV1 = z.infer<
  typeof CurrentExecutionCandidateLedgerEntryV1Schema
>;

export const CurrentExecutionCandidateLedgerV1Schema = z.object({
  contract_version:
    z.literal("current_execution_candidate_ledger_v1"),
  total_candidate_count: z.number().int().positive(),
  retained_candidate_count: z.number().int().positive().max(256),
  history_complete_in_projection: z.boolean(),
  entries:
    z.array(CurrentExecutionCandidateLedgerEntryV1Schema).min(1).max(256),
}).strict().superRefine((value, context) => {
  if (
    value.retained_candidate_count !== value.entries.length
    || value.total_candidate_count < value.retained_candidate_count
    || value.history_complete_in_projection !== (
      value.total_candidate_count === value.retained_candidate_count
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Candidate-ledger counts must match its bounded retained history",
    });
  }
  const ledgerEntryIds = value.entries.map(
    (entry) => entry.ledger_entry_id,
  );
  if (new Set(ledgerEntryIds).size !== ledgerEntryIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entries"],
      message: "Candidate-ledger entry identities must be unique",
    });
  }
});
export type CurrentExecutionCandidateLedgerV1 = z.infer<
  typeof CurrentExecutionCandidateLedgerV1Schema
>;

export const CurrentExecutionAcceptedBranchV1Schema = z.object({
  snapshot_id: CurrentExecutionStateIdSchema,
  content_sha256: ExecutionSha256Schema,
  snapshot_ref: z.string().trim().min(1).max(2048).nullable(),
  verifier_id: CurrentExecutionStateIdSchema,
  verifier_receipt_id: CurrentExecutionStateIdSchema,
  verified_at: z.string().datetime(),
  evidence_refs: z.array(CurrentExecutionEvidenceRefV2Schema).min(1).max(64),
}).strict();
export type CurrentExecutionAcceptedBranchV1 = z.infer<
  typeof CurrentExecutionAcceptedBranchV1Schema
>;

export const CurrentExecutionRecoveryRecommendationV1Schema =
  z.object({
    contract_version:
      z.literal("current_execution_recovery_recommendation_v1"),
    recommended_action: z.literal("restore_snapshot"),
    reason_code:
      z.literal("current_verifier_failed_prior_snapshot_passed"),
    current_failed_candidate:
      CurrentExecutionBranchCandidateV1Schema,
    current_failure_evidence_refs:
      z.array(CurrentExecutionEvidenceRefV2Schema).min(1).max(64),
    target_accepted_candidate:
      CurrentExecutionAcceptedBranchV1Schema,
  }).strict().superRefine((value, context) => {
    if (
      value.current_failed_candidate.verification_status !== "failed"
      || value.current_failed_candidate.snapshot_id
        === value.target_accepted_candidate.snapshot_id
      || value.current_failed_candidate.content_sha256
        === value.target_accepted_candidate.content_sha256
      || value.current_failed_candidate.verifier_id
        !== value.target_accepted_candidate.verifier_id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "A recovery recommendation requires a distinct prior snapshot that passed the same verifier as the failed current snapshot",
      });
    }
  });
export type CurrentExecutionRecoveryRecommendationV1 = z.infer<
  typeof CurrentExecutionRecoveryRecommendationV1Schema
>;

export const CurrentExecutionBranchStateV1Schema = z.object({
  contract_version: z.literal("current_execution_branch_state_v1"),
  current_candidate: CurrentExecutionBranchCandidateV1Schema,
  last_verifier_accepted: CurrentExecutionAcceptedBranchV1Schema.nullable(),
  accepted_candidate_is_current: z.boolean(),
  recovery_candidate_available: z.boolean(),
  recovery_recommendation:
    CurrentExecutionRecoveryRecommendationV1Schema.nullable(),
  candidate_ledger: CurrentExecutionCandidateLedgerV1Schema.optional(),
}).strict().superRefine((value, context) => {
  const acceptedIsCurrent = value.last_verifier_accepted !== null
    && value.last_verifier_accepted.snapshot_id
      === value.current_candidate.snapshot_id
    && value.last_verifier_accepted.content_sha256
      === value.current_candidate.content_sha256;
  if (
    value.accepted_candidate_is_current !== acceptedIsCurrent
    || value.recovery_candidate_available !== (
      value.last_verifier_accepted !== null && !acceptedIsCurrent
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["accepted_candidate_is_current"],
      message:
        "Branch-state recovery flags must match the exact accepted snapshot",
    });
  }
  const latestCandidate = value.candidate_ledger?.entries.at(-1)?.candidate;
  if (
    latestCandidate
    && (
      latestCandidate.snapshot_id !== value.current_candidate.snapshot_id
      || latestCandidate.content_sha256
        !== value.current_candidate.content_sha256
      || latestCandidate.verification_status
        !== value.current_candidate.verification_status
      || latestCandidate.verifier_receipt_id
        !== value.current_candidate.verifier_receipt_id
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidate_ledger"],
      message:
        "The candidate-ledger head must be the exact current branch candidate",
    });
  }
  const latestEntry = value.candidate_ledger?.entries.at(-1);
  const shouldRecommendRecovery =
    value.last_verifier_accepted !== null
    && !acceptedIsCurrent
    && value.current_candidate.verification_status === "failed"
    && value.current_candidate.verifier_id
      === value.last_verifier_accepted.verifier_id
    && latestEntry !== undefined
    && latestEntry.verification_evidence_refs.length > 0;
  if (
    shouldRecommendRecovery
      !== (value.recovery_recommendation !== null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recovery_recommendation"],
      message:
        "Recovery recommendation presence must follow exact same-verifier passed-to-failed evidence",
    });
  }
  if (
    value.recovery_recommendation !== null
    && (
      stableStringify(
        value.recovery_recommendation.current_failed_candidate,
      ) !== stableStringify(value.current_candidate)
      || stableStringify(
        value.recovery_recommendation
          .target_accepted_candidate,
      ) !== stableStringify(value.last_verifier_accepted)
      || stableStringify(
        value.recovery_recommendation
          .current_failure_evidence_refs,
      ) !== stableStringify(
        latestEntry?.verification_evidence_refs ?? [],
      )
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recovery_recommendation"],
      message:
        "Recovery recommendation must bind the exact failed head and accepted target evidence",
    });
  }
});
export type CurrentExecutionBranchStateV1 = z.infer<
  typeof CurrentExecutionBranchStateV1Schema
>;

export const CurrentExecutionFrontierItemV1Schema = z.object({
  frontier_id: CurrentExecutionStateIdSchema,
  kind: z.enum([
    "constraint",
    "unresolved",
    "blocked",
    "pending_check",
    "missing_plan",
    "contradiction",
    "recovery",
  ]),
  statement: CurrentExecutionStateStatementSchema,
  target_state_snapshot_id: CurrentExecutionStateIdSchema,
  source_event: CurrentExecutionEventRefV2Schema.nullable(),
}).strict();
export type CurrentExecutionFrontierItemV1 = z.infer<
  typeof CurrentExecutionFrontierItemV1Schema
>;

export const CurrentExecutionDecisionFrontierV1Schema = z.object({
  contract_version: z.literal("current_execution_decision_frontier_v1"),
  items: z.array(CurrentExecutionFrontierItemV1Schema).max(256),
}).strict().superRefine((value, context) => {
  const identities = value.items.map((item) => item.frontier_id);
  if (new Set(identities).size !== identities.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["items"],
      message: "Decision-frontier items must have unique identities",
    });
  }
});
export type CurrentExecutionDecisionFrontierV1 = z.infer<
  typeof CurrentExecutionDecisionFrontierV1Schema
>;

export const CurrentExecutionReadinessV1Schema = z.object({
  contract_version: z.literal("current_execution_readiness_v1"),
  status: z.enum([
    "ready_to_act",
    "needs_evidence",
    "blocked",
    "recovery_recommended",
    "verified_complete",
    "closed_unverified",
  ]),
  safe_to_execute_planned_action: z.boolean(),
  required_constraint_count: z.number().int().nonnegative().max(128),
  satisfied_constraint_count: z.number().int().nonnegative().max(128),
  unresolved_constraint_count: z.number().int().nonnegative().max(128),
  violated_constraint_count: z.number().int().nonnegative().max(128),
  unresolved_conflict_count: z.number().int().nonnegative().max(256),
  pending_check_count: z.number().int().nonnegative().max(64),
  accepted_recovery_candidate_available: z.boolean(),
}).strict();
export type CurrentExecutionReadinessV1 = z.infer<
  typeof CurrentExecutionReadinessV1Schema
>;

const CurrentExecutionContinuityProjectionV1MaterialSchema = z.object({
  contract_version:
    z.literal("current_execution_continuity_projection_v1"),
  base_state_sha256: ExecutionSha256Schema,
  task_contract: CurrentExecutionTaskContractV1Schema,
  epistemic_state: CurrentExecutionEpistemicStateV1Schema,
  branch_state: CurrentExecutionBranchStateV1Schema,
  decision_frontier: CurrentExecutionDecisionFrontierV1Schema,
  readiness: CurrentExecutionReadinessV1Schema,
}).strict();

export function currentExecutionContinuityProjectionV1Digest(
  value: z.infer<
    typeof CurrentExecutionContinuityProjectionV1MaterialSchema
  >,
): string {
  return sha256Hex(stableStringify(
    CurrentExecutionContinuityProjectionV1MaterialSchema.parse(value),
  ));
}

export const CurrentExecutionContinuityProjectionV1Schema =
  CurrentExecutionContinuityProjectionV1MaterialSchema.extend({
    projection_sha256: ExecutionSha256Schema,
  }).strict().superRefine((value, context) => {
    const {
      projection_sha256: suppliedDigest,
      ...material
    } = value;
    if (
      suppliedDigest
      !== currentExecutionContinuityProjectionV1Digest(material)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projection_sha256"],
        message:
          "Continuity projection digest must bind its complete semantic view",
      });
    }
  });
export type CurrentExecutionContinuityProjectionV1 = z.infer<
  typeof CurrentExecutionContinuityProjectionV1Schema
>;

export const CurrentExecutionStateV2MaterialSchema = z.object({
  contract_version: z.literal("current_execution_state_v2"),
  scope_id: z.string().trim().min(1).max(256),
  continuation_id: CurrentExecutionStateIdSchema,
  task_run_id: CurrentExecutionStateIdSchema,
  episode_id: CurrentExecutionStateIdSchema,
  parent_episode_id: CurrentExecutionStateIdSchema.nullable(),
  revision: z.number().int().positive(),
  parent_state_sha256: ExecutionSha256Schema.nullable(),
  subject: CurrentExecutionSubjectV2Schema,
  goal: CurrentExecutionStateStatementSchema,
  goal_evidence_ref: CurrentExecutionEvidenceRefV2Schema,
  phase: CurrentExecutionStateStatementSchema.nullable(),
  observations: z.array(CurrentExecutionObservationV2Schema).max(256),
  completed: z.array(CurrentExecutionItemV2Schema).max(512),
  failed: z.array(CurrentExecutionItemV2Schema).max(512),
  unresolved: z.array(CurrentExecutionItemV2Schema).max(512),
  blocked: z.array(CurrentExecutionItemV2Schema).max(512),
  decisions: z.array(CurrentExecutionDecisionV2Schema).max(256),
  active_artifacts: z.array(CurrentExecutionEvidenceRefV2Schema).max(1024),
  verified_facts: z.array(CurrentExecutionVerifiedFactV2Schema).max(256),
  pending_checks: z.array(CurrentExecutionPendingCheckV2Schema).max(64),
  next_action: CurrentExecutionJustifiedActionV2Schema.nullable(),
  episode_status: z.enum(["open", "closed"]),
  evidence_refs: z.array(z.string().trim().min(1).max(2304)).max(4096),
  decisive_evidence:
    z.array(CurrentExecutionDecisiveEvidenceV1Schema).max(256).optional(),
}).strict();
export type CurrentExecutionStateV2Material = z.infer<
  typeof CurrentExecutionStateV2MaterialSchema
>;

export function currentExecutionStateV2Digest(
  value: CurrentExecutionStateV2Material,
): string {
  return sha256Hex(
    stableStringify(CurrentExecutionStateV2MaterialSchema.parse(value)),
  );
}

export const CurrentExecutionStateV2Schema =
  CurrentExecutionStateV2MaterialSchema.extend({
    state_sha256: ExecutionSha256Schema,
    updated_at: z.string().datetime(),
    continuity_projection:
      CurrentExecutionContinuityProjectionV1Schema.optional(),
  }).strict().superRefine((value, context) => {
    const {
      state_sha256: suppliedDigest,
      updated_at: _updatedAt,
      continuity_projection: continuityProjection,
      ...material
    } = value;
    if (suppliedDigest !== currentExecutionStateV2Digest(material)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state_sha256"],
        message:
          "Current execution state digest must bind canonical semantic state",
      });
    }
    if (
      (value.revision === 1) !== (value.parent_state_sha256 === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parent_state_sha256"],
        message:
          "Only the first current-state revision may omit its parent digest",
      });
    }
    if (
      continuityProjection
      && continuityProjection.base_state_sha256 !== suppliedDigest
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["continuity_projection", "base_state_sha256"],
        message:
          "Continuity projection must bind the exact current-state digest",
      });
    }
    if (continuityProjection) {
      if (
        continuityProjection.task_contract.source_text_sha256
          !== sha256Hex(value.goal)
        || stableStringify(
          continuityProjection.task_contract.source_evidence_ref,
        ) !== stableStringify(value.goal_evidence_ref)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["continuity_projection", "task_contract"],
          message:
            "Task contract must bind the retained goal and its source evidence",
        });
      }
      const goalBytes = Buffer.from(value.goal, "utf8");
      let previousConstraintEnd = 0;
      for (
        const [index, constraint] of
          continuityProjection.task_contract.constraints.entries()
      ) {
        const gap = goalBytes.subarray(
          previousConstraintEnd,
          constraint.source_start_utf8_byte,
        ).toString("utf8");
        const exact = goalBytes.subarray(
          constraint.source_start_utf8_byte,
          constraint.source_end_utf8_byte,
        ).toString("utf8");
        if (
          constraint.source_start_utf8_byte < previousConstraintEnd
          || gap.trim().length > 0
          || exact !== constraint.statement
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [
              "continuity_projection",
              "task_contract",
              "constraints",
              index,
            ],
            message:
              "Task constraints must cover every non-whitespace goal byte in source order",
          });
        }
        previousConstraintEnd = constraint.source_end_utf8_byte;
      }
      if (
        goalBytes.subarray(previousConstraintEnd)
          .toString("utf8").trim().length > 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [
            "continuity_projection",
            "task_contract",
            "constraints",
          ],
          message:
            "Task constraints cannot omit a trailing non-whitespace goal span",
        });
      }
      if (
        continuityProjection.branch_state.current_candidate.snapshot_id
          !== value.subject.current_snapshot_id
        || continuityProjection.branch_state.current_candidate.content_sha256
          !== value.subject.current_content_sha256
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["continuity_projection", "branch_state"],
          message:
            "Branch state must identify the exact current subject snapshot",
        });
      }
    }
  });
export type CurrentExecutionStateV2 = z.infer<
  typeof CurrentExecutionStateV2Schema
>;

export const CurrentStateRenderPolicyV1Schema = z.object({
  contract_version: z.literal("current_state_render_policy_v1"),
  audience: z.enum(["agent", "audit"]).default("agent"),
  max_chars: z.number().int().min(512).max(32_768),
  max_observations: z.number().int().nonnegative().max(64),
  max_items_per_status: z.number().int().nonnegative().max(64),
  max_decisions: z.number().int().nonnegative().max(64),
  max_verified_facts: z.number().int().nonnegative().max(64),
  max_evidence_refs: z.number().int().nonnegative().max(64),
  max_decisive_evidence:
    z.number().int().nonnegative().max(32).optional(),
  max_decisive_evidence_chars:
    z.number().int().nonnegative().max(16_384).optional(),
}).strict();
export type CurrentStateRenderPolicyV1 = z.infer<
  typeof CurrentStateRenderPolicyV1Schema
>;

export const CurrentExecutionStateRenderV1Schema = z.object({
  contract_version: z.literal("current_execution_state_render_v1"),
  state_sha256: ExecutionSha256Schema,
  policy: CurrentStateRenderPolicyV1Schema,
  text: z.string().min(1),
  character_count: z.number().int().positive(),
  utf8_byte_count: z.number().int().positive(),
  token_count: z.number().int().nonnegative().nullable(),
  token_measurement: z.object({
    authority: z.enum([
      "unavailable",
      "host_tokenizer",
      "provider_tokenizer",
    ]),
    tokenizer_id: z.string().trim().min(1).max(256).nullable(),
  }).strict(),
  render_sha256: ExecutionSha256Schema,
}).strict().superRefine((value, context) => {
  if (
    value.character_count !== value.text.length
    || value.utf8_byte_count !== Buffer.byteLength(value.text, "utf8")
    || value.character_count > value.policy.max_chars
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["text"],
      message: "Current-state render measurements or budget are invalid",
    });
  }
  if (
    (value.token_count === null)
      !== (value.token_measurement.authority === "unavailable")
    || (
      value.token_measurement.authority === "unavailable"
      && value.token_measurement.tokenizer_id !== null
    )
    || (
      value.token_measurement.authority !== "unavailable"
      && value.token_measurement.tokenizer_id === null
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["token_measurement"],
      message:
        "Token count and tokenizer measurement authority must agree",
    });
  }
  if (
    value.render_sha256
    !== sha256Hex(stableStringify({
      contract_version: value.contract_version,
      state_sha256: value.state_sha256,
      policy: value.policy,
      text: value.text,
      character_count: value.character_count,
      utf8_byte_count: value.utf8_byte_count,
      token_count: value.token_count,
      token_measurement: value.token_measurement,
    }))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["render_sha256"],
      message: "Current-state render digest is invalid",
    });
  }
});
export type CurrentExecutionStateRenderV1 = z.infer<
  typeof CurrentExecutionStateRenderV1Schema
>;

export const ExecutionPacketV1Schema = z.object({
  version: z.literal(1),
  state_id: z.string().trim().min(1),
  current_stage: ExecutionStage,
  active_role: ExecutionRole,
  task_brief: z.string().trim().min(1),
  target_files: StringList,
  next_action: z.string().trim().min(1).nullable().default(null),
  hard_constraints: StringList,
  accepted_facts: StringList,
  rejected_paths: StringList,
  pending_validations: StringList,
  unresolved_blockers: StringList,
  rollback_notes: StringList,
  service_lifecycle_constraints: z.array(ServiceLifecycleConstraintV1Schema).max(16).default([]),
  review_contract: ReviewerContractSchema.nullable().default(null),
  resume_anchor: ResumeAnchorSchema.nullable().default(null),
  artifact_refs: StringList,
  evidence_refs: StringList,
});
export type ExecutionPacketV1 = z.infer<typeof ExecutionPacketV1Schema>;

const DerivedSourceMode = z.enum(["memory_only", "packet_backed"]);
const RecordSource = z.enum(["strategy_summary", "execution_packet", "collaboration_summary"]);
const RefKind = z.enum(["artifact", "evidence"]);

export const ExecutionDelegationPacketRecordV1Schema = z.object({
  version: z.literal(1),
  role: z.string().trim().min(1),
  mission: z.string().trim().min(1),
  working_set: StringList,
  acceptance_checks: StringList,
  output_contract: z.string().trim().min(1),
  preferred_artifact_refs: StringList,
  inherited_evidence: StringList,
  routing_reason: z.string().trim().min(1),
  task_family: z.string().trim().min(1).nullable().default(null),
  family_scope: z.string().trim().min(1),
  source_mode: DerivedSourceMode,
}).strict();
export type ExecutionDelegationPacketRecordV1 = z.infer<typeof ExecutionDelegationPacketRecordV1Schema>;

export const ExecutionDelegationReturnRecordV1Schema = z.object({
  version: z.literal(1),
  role: z.string().trim().min(1),
  status: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  evidence: StringList,
  working_set: StringList,
  acceptance_checks: StringList,
  source_mode: DerivedSourceMode,
}).strict();
export type ExecutionDelegationReturnRecordV1 = z.infer<typeof ExecutionDelegationReturnRecordV1Schema>;

export const ExecutionArtifactRoutingRecordV1Schema = z.object({
  version: z.literal(1),
  ref: z.string().trim().min(1),
  ref_kind: RefKind,
  route_role: z.string().trim().min(1),
  route_intent: z.string().trim().min(1),
  route_mode: DerivedSourceMode,
  task_family: z.string().trim().min(1).nullable().default(null),
  family_scope: z.string().trim().min(1),
  routing_reason: z.string().trim().min(1),
  source: RecordSource,
}).strict();
export type ExecutionArtifactRoutingRecordV1 = z.infer<typeof ExecutionArtifactRoutingRecordV1Schema>;

export const ControlProfileName = z.enum(["triage", "patch", "review", "resume"]);
export type ControlProfileName = z.infer<typeof ControlProfileName>;

export const ControlProfileV1Schema = z.object({
  version: z.literal(1),
  profile: ControlProfileName,
  max_same_tool_streak: z.number().int().positive(),
  max_no_progress_streak: z.number().int().positive(),
  max_duplicate_observation_streak: z.number().int().positive(),
  max_steps: z.number().int().positive(),
  allow_broad_scan: z.boolean(),
  allow_broad_test: z.boolean(),
  escalate_on_blocker: z.boolean(),
  reviewer_ready_required: z.boolean(),
});
export type ControlProfileV1 = z.infer<typeof ControlProfileV1Schema>;

import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";
import { sha256Hex } from "../util/crypto.js";
import {
  AIONIS_ADMISSION_CANDIDATE_POLICY_ID,
  AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION,
} from "./admission-candidate-policy.js";
import {
  LEARNING_GATE_POLICY_ID,
  LEARNING_GATE_POLICY_VERSION,
  resolveLearningGatePolicy,
} from "./learning-gate-policy.js";
import { CanonicalLearningUtcTimestampSchema } from "./learning-episode-ledger.js";

const LEARNING_GATE_POLICY = resolveLearningGatePolicy(
  LEARNING_GATE_POLICY_ID,
  LEARNING_GATE_POLICY_VERSION,
);
const LEARNING_GATE_CONFIG = LEARNING_GATE_POLICY.config;

const BoundedIdSchema = z.string().trim().min(1).max(256);
const BoundedKindSchema = z.string().trim().min(1).max(120);
const AuthorityScopeSchema = z.string().trim().min(1).max(512);
const DigestSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

function exactUtf8TextSchema(maxBytes: number, label: string) {
  return z.string().superRefine((value, context) => {
    if (value.length === 0
      || value !== value.trim()
      || Buffer.byteLength(value, "utf8") > maxBytes
      || Buffer.from(value, "utf8").toString("utf8") !== value
      || /[\u0000-\u001f\u007f]/u.test(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must be exact control-free UTF-8 text bounded to ${String(maxBytes)} bytes`,
      });
    }
  });
}

const ExactCloseIdSchema = exactUtf8TextSchema(256, "Close approval identifier");
const ExactCloseKindSchema = exactUtf8TextSchema(120, "Close approval kind");
const ExactCloseTenantIdSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u,
  "Close approval tenant ID is invalid",
);
const CloseAuthorizationKeyIdSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u,
  "Close approval key ID must match the Runtime authority keyring syntax",
);
const CloseAuthorizationNonceSchema = z.string().regex(
  /^[A-Za-z0-9_-]{22,128}$/u,
  "Close approval nonce must be bounded canonical base64url text",
).superRefine((value, context) => {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length < 16
    || decoded.length > 96
    || decoded.toString("base64url") !== value) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Close approval nonce must canonically encode 16 to 96 bytes",
    });
  }
});

export const LEARNING_EXPERIMENT_AUTHORITY_SCOPE = "learning-experiment-authority-v1" as const;
export const LEARNING_EXPERIMENT_CLOSE_OPERATION_KIND = "learning_experiment_close_v1" as const;
export const LEARNING_EXPERIMENT_CLOSE_MAX_TTL_MS = 3_600_000;

export const LearningEvidenceEvaluationV1Schema = z.object({
  contract_version: z.literal("learning_evidence_evaluation_v1"),
  decision_kind: z.literal("evidence_evaluation"),
  evidence_verdict: z.enum([
    "hold",
    "promotion_ready",
    "pause_required",
    "demotion_ready",
    "retirement_ready",
  ]),
  authority_action: z.null(),
  authority_mutation: z.literal(false),
  decision_id: BoundedIdSchema,
  look_reservation_id: BoundedIdSchema,
  evidence_cohort_sha256: DigestSha256Schema,
  evidence_artifact_set_sha256: DigestSha256Schema,
}).strict();

export type LearningEvidenceEvaluationV1 = z.infer<typeof LearningEvidenceEvaluationV1Schema>;

export const LearningAuthorityAdjudicationV1Schema = z.object({
  contract_version: z.literal("learning_authority_adjudication_v1"),
  decision_kind: z.literal("authority_adjudication"),
  evidence_verdict: z.enum(["promotion_ready", "demotion_ready", "retirement_ready"]),
  authority_action: z.enum(["promote", "demote", "retire"]),
  authority_mutation: z.literal(true),
  decision_id: BoundedIdSchema,
  basis_evidence_decision_id: BoundedIdSchema,
  look_reservation_id: BoundedIdSchema,
  evidence_cohort_sha256: DigestSha256Schema,
  evidence_artifact_set_sha256: DigestSha256Schema,
  authorization_sha256: DigestSha256Schema,
  authority_mutation_id: BoundedIdSchema,
}).strict().superRefine((value, context) => {
  const actionForVerdict = {
    promotion_ready: "promote",
    demotion_ready: "demote",
    retirement_ready: "retire",
  } as const;
  if (actionForVerdict[value.evidence_verdict] !== value.authority_action) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authority_action"],
      message: "Authority action does not match the approved evidence verdict",
    });
  }
});

export type LearningAuthorityAdjudicationV1 = z.infer<typeof LearningAuthorityAdjudicationV1Schema>;

export const LearningAuthorityApprovalV1Schema = z.object({
  contract_version: z.literal("learning_authority_approval_v1"),
  authorization_kind: z.literal("gate_adjudication"),
  action: z.enum(["promote", "demote", "retire"]),
  tenant_id: BoundedIdSchema,
  task_family: BoundedKindSchema,
  authority_scope: AuthorityScopeSchema,
  authority_operation_kind: z.literal("learning_gate_authority_v1"),
  authority_operation_id: BoundedIdSchema,
  experiment_id: BoundedIdSchema,
  experiment_revision: z.number().int().positive(),
  experiment_config_sha256: DigestSha256Schema,
  evidence_decision_id: BoundedIdSchema,
  look_reservation_id: BoundedIdSchema,
  look_reservation_sha256: DigestSha256Schema,
  evidence_scope_set_sha256: DigestSha256Schema,
  evidence_cohort_sha256: DigestSha256Schema,
  evidence_artifact_set_sha256: DigestSha256Schema,
  candidate_policy_id: z.literal(AIONIS_ADMISSION_CANDIDATE_POLICY_ID),
  candidate_policy_version: z.literal(AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION),
  candidate_policy_implementation_sha256: DigestSha256Schema,
  candidate_policy_config_sha256: DigestSha256Schema,
  gate_policy_id: z.literal(LEARNING_GATE_POLICY_ID),
  gate_policy_version: z.literal(LEARNING_GATE_POLICY_VERSION),
  gate_policy_implementation_sha256: DigestSha256Schema,
  gate_policy_config_sha256: DigestSha256Schema,
  approved_by: BoundedIdSchema,
  authorization_key_id: BoundedIdSchema,
  authorization_nonce: BoundedIdSchema,
  authorization_expires_at: CanonicalLearningUtcTimestampSchema,
}).strict();

export type LearningAuthorityApprovalV1 = z.infer<typeof LearningAuthorityApprovalV1Schema>;

export function learningAuthorityApprovalDigest(value: LearningAuthorityApprovalV1): string {
  return sha256Hex(stableStringify(LearningAuthorityApprovalV1Schema.parse(value)));
}

export const LearningExperimentCloseApprovalV1Schema = z.object({
  contract_version: z.literal("learning_experiment_close_approval_v1"),
  authorization_kind: z.literal("experiment_close"),
  action: z.literal("close_experiment"),
  runtime_authority_lineage_sha256: DigestSha256Schema,
  tenant_id: ExactCloseTenantIdSchema,
  task_family: ExactCloseKindSchema,
  confirmatory_attempt_id: ExactCloseIdSchema,
  confirmatory_attempt_sha256: DigestSha256Schema,
  experiment_id: ExactCloseIdSchema,
  experiment_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  experiment_config_sha256: DigestSha256Schema,
  namespace_set_sha256: DigestSha256Schema,
  close_reason: z.enum(["operator_stop", "safety_abort", "rollout_expired", "evidence_complete"]),
  candidate_policy_implementation_sha256: DigestSha256Schema,
  gate_policy_implementation_sha256: DigestSha256Schema,
  authority_scope: z.literal(LEARNING_EXPERIMENT_AUTHORITY_SCOPE),
  authority_operation_kind: z.literal(LEARNING_EXPERIMENT_CLOSE_OPERATION_KIND),
  authority_operation_id: ExactCloseIdSchema,
  approved_by: ExactCloseIdSchema,
  authorization_key_id: CloseAuthorizationKeyIdSchema,
  authorization_nonce: CloseAuthorizationNonceSchema,
  authorization_issued_at: CanonicalLearningUtcTimestampSchema,
  authorization_expires_at: CanonicalLearningUtcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (!(value.authorization_issued_at < value.authorization_expires_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authorization_expires_at"],
      message: "Close approval expiry must be strictly after issuance",
    });
  }
  if (Date.parse(value.authorization_expires_at) - Date.parse(value.authorization_issued_at)
      > LEARNING_EXPERIMENT_CLOSE_MAX_TTL_MS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authorization_expires_at"],
      message: "Close approval lifetime must not exceed 3600 seconds",
    });
  }
});

export type LearningExperimentCloseApprovalV1 = z.infer<typeof LearningExperimentCloseApprovalV1Schema>;

export function learningExperimentCloseApprovalDigest(value: LearningExperimentCloseApprovalV1): string {
  return sha256Hex(stableStringify(LearningExperimentCloseApprovalV1Schema.parse(value)));
}

const LearningCutoffV1Schema = z.object({
  event_row_id: z.number().int().nonnegative(),
  artifact_row_id: z.number().int().nonnegative(),
  recorded_at: CanonicalLearningUtcTimestampSchema,
  event_head_sha256: DigestSha256Schema,
  artifact_head_sha256: DigestSha256Schema,
}).strict();

export const LearningOutcomeRedactedAuthorityProjectionV1Schema = z.object({
  contract_version: z.literal("learning_outcome_redacted_authority_projection_v1"),
  schema_version: z.literal(3),
  database_instance_id: DigestSha256Schema,
  confirmatory_attempt_sha256: DigestSha256Schema,
  experiment_config_sha256: DigestSha256Schema,
  candidate_policy_config_sha256: DigestSha256Schema,
  candidate_policy_implementation_sha256: DigestSha256Schema,
  gate_policy_config_sha256: DigestSha256Schema,
  gate_policy_implementation_sha256: DigestSha256Schema,
  look_schedule_sha256: DigestSha256Schema,
  randomization_pair_manifest_sha256: DigestSha256Schema,
  activation_schedule_sha256: DigestSha256Schema,
  collection_source_policy_sha256: DigestSha256Schema,
  required_evidence_series_sha256: DigestSha256Schema,
  required_artifact_heads_sha256: DigestSha256Schema,
  event_cutoff_row_id: z.number().int().nonnegative(),
  artifact_cutoff_row_id: z.number().int().nonnegative(),
  event_head_sha256: DigestSha256Schema,
  artifact_head_sha256: DigestSha256Schema,
}).strict();

export type LearningOutcomeRedactedAuthorityProjectionV1 = z.infer<
  typeof LearningOutcomeRedactedAuthorityProjectionV1Schema
>;

export function learningOutcomeRedactedAuthorityProjectionDigest(
  value: LearningOutcomeRedactedAuthorityProjectionV1,
): string {
  return sha256Hex(stableStringify(LearningOutcomeRedactedAuthorityProjectionV1Schema.parse(value)));
}

const LearningLookProposalV1ObjectSchema = z.object({
  contract_version: z.literal("learning_look_proposal_v1"),
  tenant_id: BoundedIdSchema,
  confirmatory_attempt_id: BoundedIdSchema,
  experiment_id: BoundedIdSchema,
  experiment_revision: z.number().int().positive(),
  experiment_config_sha256: DigestSha256Schema,
  task_family: BoundedKindSchema,
  candidate_policy_id: z.literal(AIONIS_ADMISSION_CANDIDATE_POLICY_ID),
  candidate_policy_version: z.literal(AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION),
  candidate_policy_config_sha256: DigestSha256Schema,
  candidate_policy_implementation_sha256: DigestSha256Schema,
  gate_policy_id: z.literal(LEARNING_GATE_POLICY_ID),
  gate_policy_version: z.literal(LEARNING_GATE_POLICY_VERSION),
  gate_policy_config_sha256: DigestSha256Schema,
  gate_policy_implementation_sha256: DigestSha256Schema,
  look_index: z.number().int().refine(
    (value) => (LEARNING_GATE_CONFIG.checkpoint_indexes as readonly number[]).includes(value),
    "Look index is not registered by the canonical gate policy",
  ),
  target_cumulative_pair_count: z.number().int().positive(),
  checkpoint_kind: z.enum(["safety_integrity_only", "confirmatory"]),
  cutoff: LearningCutoffV1Schema,
  outcome_redacted_authority_projection: LearningOutcomeRedactedAuthorityProjectionV1Schema,
  outcome_redacted_authority_projection_sha256: DigestSha256Schema,
}).strict();

function validateCheckpointKind(
  value: {
    look_index: number;
    target_cumulative_pair_count: number;
    checkpoint_kind: "safety_integrity_only" | "confirmatory";
  },
  context: z.RefinementCtx,
): void {
  const position = (LEARNING_GATE_CONFIG.checkpoint_indexes as readonly number[]).indexOf(value.look_index);
  const expected = LEARNING_GATE_CONFIG.checkpoint_kinds[position];
  if (expected == null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["look_index"],
      message: "Look index is not registered by the canonical gate policy",
    });
    return;
  }
  if (value.checkpoint_kind !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["checkpoint_kind"],
      message: `Look ${value.look_index} requires checkpoint_kind=${expected}`,
    });
  }
  const expectedTarget = LEARNING_GATE_CONFIG.checkpoint_cumulative_matched_pairs[position];
  if (value.target_cumulative_pair_count !== expectedTarget) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target_cumulative_pair_count"],
      message: `Look ${value.look_index} requires target_cumulative_pair_count=${String(expectedTarget)}`,
    });
  }
}

export const LearningLookProposalV1Schema = LearningLookProposalV1ObjectSchema.superRefine(
  (value, context) => {
    validateCheckpointKind(value, context);
    const projection = value.outcome_redacted_authority_projection;
    if (
      projection.event_cutoff_row_id !== value.cutoff.event_row_id
      || projection.artifact_cutoff_row_id !== value.cutoff.artifact_row_id
      || projection.event_head_sha256 !== value.cutoff.event_head_sha256
      || projection.artifact_head_sha256 !== value.cutoff.artifact_head_sha256
      || projection.experiment_config_sha256 !== value.experiment_config_sha256
      || projection.candidate_policy_config_sha256 !== value.candidate_policy_config_sha256
      || projection.candidate_policy_implementation_sha256 !== value.candidate_policy_implementation_sha256
      || projection.gate_policy_config_sha256 !== value.gate_policy_config_sha256
      || projection.gate_policy_implementation_sha256 !== value.gate_policy_implementation_sha256
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome_redacted_authority_projection"],
        message: "Outcome-redacted authority projection does not match the proposal cutoff and policy bindings",
      });
    }
    if (
      value.outcome_redacted_authority_projection_sha256
      !== learningOutcomeRedactedAuthorityProjectionDigest(projection)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome_redacted_authority_projection_sha256"],
        message: "Outcome-redacted authority projection digest mismatch",
      });
    }
  },
);

export type LearningLookProposalV1 = z.infer<typeof LearningLookProposalV1Schema>;

export function learningLookProposalDigest(value: LearningLookProposalV1): string {
  return sha256Hex(stableStringify(LearningLookProposalV1Schema.parse(value)));
}

export const RUNTIME_INTEGRITY_FINDING_CODES = [
  "schema_integrity",
  "runtime_state_integrity",
  "ledger_chain_integrity",
  "assignment_integrity",
  "policy_config_integrity",
  "source_binding_integrity",
  "attempt_binding_integrity",
  "artifact_head_integrity",
  "cutoff_projection_integrity",
  "namespace_lease_integrity",
  "control_plane_integrity",
  "external_prerequisite_integrity",
] as const;

const RuntimeIntegrityFindingV1Schema = z.object({
  code: z.enum(RUNTIME_INTEGRITY_FINDING_CODES),
  severity: z.enum(["info", "error"]),
  count: z.number().int().nonnegative(),
  evidence_sha256: DigestSha256Schema,
}).strict();

export const RuntimeIntegrityGateReportV1Schema = LearningLookProposalV1ObjectSchema.omit({
  contract_version: true,
}).extend({
  contract_version: z.literal("runtime_integrity_gate_report_v1"),
  proposal_sha256: DigestSha256Schema,
  verifier_id: z.literal("aionis_lite_learning_ledger_replay"),
  verifier_version: z.literal(1),
  integrity_status: z.enum(["passed", "failed", "inconclusive"]),
  findings: z.array(RuntimeIntegrityFindingV1Schema).max(64),
}).strict().superRefine((value, context) => {
  validateCheckpointKind(value, context);
  const proposal: LearningLookProposalV1 = {
    contract_version: "learning_look_proposal_v1",
    tenant_id: value.tenant_id,
    confirmatory_attempt_id: value.confirmatory_attempt_id,
    experiment_id: value.experiment_id,
    experiment_revision: value.experiment_revision,
    experiment_config_sha256: value.experiment_config_sha256,
    task_family: value.task_family,
    candidate_policy_id: value.candidate_policy_id,
    candidate_policy_version: value.candidate_policy_version,
    candidate_policy_config_sha256: value.candidate_policy_config_sha256,
    candidate_policy_implementation_sha256: value.candidate_policy_implementation_sha256,
    gate_policy_id: value.gate_policy_id,
    gate_policy_version: value.gate_policy_version,
    gate_policy_config_sha256: value.gate_policy_config_sha256,
    gate_policy_implementation_sha256: value.gate_policy_implementation_sha256,
    look_index: value.look_index,
    target_cumulative_pair_count: value.target_cumulative_pair_count,
    checkpoint_kind: value.checkpoint_kind,
    cutoff: value.cutoff,
    outcome_redacted_authority_projection: value.outcome_redacted_authority_projection,
    outcome_redacted_authority_projection_sha256: value.outcome_redacted_authority_projection_sha256,
  };
  if (value.proposal_sha256 !== learningLookProposalDigest(proposal)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["proposal_sha256"],
      message: "Runtime integrity report is not bound to its canonical outcome-redacted look proposal",
    });
  }
  const exactFindingSet = value.findings.length === RUNTIME_INTEGRITY_FINDING_CODES.length
    && value.findings.every((finding, index) => finding.code === RUNTIME_INTEGRITY_FINDING_CODES[index]);
  if (!exactFindingSet) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["findings"],
      message: "Runtime integrity report must contain the exact canonical finding set in verifier order",
    });
  }
  for (const [index, finding] of value.findings.entries()) {
    const expectedSeverity = finding.count === 0 ? "info" : "error";
    if (finding.severity !== expectedSeverity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["findings", index, "severity"],
        message: `Runtime integrity finding severity must be ${expectedSeverity} for count=${String(finding.count)}`,
      });
    }
  }
  const hasFailure = value.findings.some((finding) => finding.count > 0);
  if ((value.integrity_status === "passed" && hasFailure)
    || (value.integrity_status === "failed" && !hasFailure)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["integrity_status"],
      message: "Runtime integrity status must match the canonical finding counts",
    });
  }
});

export type RuntimeIntegrityGateReportV1 = z.infer<typeof RuntimeIntegrityGateReportV1Schema>;

export function runtimeIntegrityGateReportDigest(value: RuntimeIntegrityGateReportV1): string {
  return sha256Hex(stableStringify(RuntimeIntegrityGateReportV1Schema.parse(value)));
}

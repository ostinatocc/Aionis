import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import { sha256Hex } from "../util/crypto.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Id = z.string().trim().min(1).max(256);
const Kind = z.string().trim().min(1).max(120);
const UtcMillis = z.string().datetime({ offset: true }).refine((value) => new Date(value).toISOString() === value);
const LearningSafetyStopTriggerKindSchema = z.enum([
  "episode_feedback",
  "control_job",
  "assignment_integrity",
  "artifact_integrity",
  "ledger_integrity",
  "config_integrity",
]);

export const LEARNING_SAFETY_STOP_POLICY_V1 = Object.freeze({
  contract_version: "aionis_learning_safety_stop_policy_v1" as const,
  action: "pause" as const,
  authority_scope: "task_family_candidate_implementation" as const,
  triggers: ["boundary_ignored", "hard_boundary_violation"] as const,
  alias_resolution: "candidate_implementation_contract_sha256" as const,
});

export const LEARNING_SAFETY_STOP_POLICY_SHA256 = sha256Hex(
  stableStringify(LEARNING_SAFETY_STOP_POLICY_V1),
);

export const LEARNING_SAFETY_STOP_POLICY_V2 = Object.freeze({
  contract_version: "aionis_learning_safety_stop_policy_v2" as const,
  action: "pause" as const,
  authority_scope: "task_family_candidate_implementation" as const,
  triggers: [
    "boundary_ignored",
    "hard_boundary_violation",
    "enrolled_control_job_dead_letter",
  ] as const,
  alias_resolution: "candidate_implementation_contract_sha256" as const,
});

export const LEARNING_SAFETY_STOP_POLICY_V2_SHA256 = sha256Hex(
  stableStringify(LEARNING_SAFETY_STOP_POLICY_V2),
);

export const LearningSafetyStopAuthorizationV1Schema = z.object({
  contract_version: z.literal("learning_safety_stop_authorization_v1"),
  authorization_kind: z.literal("safety_automatic"),
  action: z.literal("pause"),
  tenant_id: Id,
  task_family: Kind,
  authority_scope: Id,
  authority_operation_kind: z.literal("learning_gate_authority_v1"),
  authority_operation_id: Id,
  trigger_ref_kind: LearningSafetyStopTriggerKindSchema,
  trigger_ref_id: Id,
  trigger_episode_id: Id.nullable(),
  trigger_sha256: Digest,
  evidence_scope_set_sha256: Digest,
  candidate_policy_id: Kind,
  candidate_policy_version: Kind,
  candidate_policy_implementation_sha256: Digest,
  candidate_policy_config_sha256: Digest,
  experiment_id: Id,
  experiment_revision: z.number().int().positive(),
  experiment_config_sha256: Digest,
  gate_policy_id: Kind,
  gate_policy_version: Kind,
  gate_policy_config_sha256: Digest,
  stop_policy_sha256: Digest,
  source_commit_id: Id,
  authorized_at: UtcMillis,
}).strict();

export type LearningSafetyStopAuthorizationV1 = z.infer<typeof LearningSafetyStopAuthorizationV1Schema>;

export function learningSafetyStopAuthorizationDigest(value: LearningSafetyStopAuthorizationV1): string {
  return sha256Hex(stableStringify(LearningSafetyStopAuthorizationV1Schema.parse(value)));
}

export function learningSafetyEvidenceScopeSetDigest(scopes: readonly string[]): string {
  const canonical = [...new Set(scopes.map((scope) => Id.parse(scope)))].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
  if (canonical.length === 0) throw new Error("learning safety scope set cannot be empty");
  return sha256Hex(stableStringify(canonical));
}

export function learningSafetyAuthorityScope(args: {
  taskFamily: string;
  evidenceScopeSetSha256: string;
}): string {
  const taskFamily = Kind.parse(args.taskFamily);
  const scopeSet = Digest.parse(args.evidenceScopeSetSha256);
  return Id.parse(`learning:${taskFamily}:${scopeSet}`);
}

export function learningSafetyAuthorityOperationId(args: {
  triggerRefKind: LearningSafetyStopAuthorizationV1["trigger_ref_kind"];
  triggerRefId: string;
  authorityScope: string;
  candidatePolicyImplementationSha256: string;
  stopPolicySha256?: string;
}): string {
  return `lsafety_${sha256Hex(stableStringify({
    trigger_ref_kind: args.triggerRefKind,
    trigger_ref_id: Id.parse(args.triggerRefId),
    authority_scope: Id.parse(args.authorityScope),
    candidate_policy_implementation_sha256: Digest.parse(args.candidatePolicyImplementationSha256),
    stop_policy_sha256: Digest.parse(args.stopPolicySha256 ?? LEARNING_SAFETY_STOP_POLICY_SHA256),
  }))}`;
}

export function learningControlDeadLetterTriggerSha256(args: Readonly<{
  tenantId: string;
  scope: string;
  jobId: string;
  sourceEpisodeId: string;
  sourceFeedbackEventId: string;
  sourceCommitId: string;
  payloadSha256: string;
  attemptCount: number;
  lastErrorCode: string;
}>): string {
  return sha256Hex(stableStringify({
    contract_version: "learning_control_dead_letter_trigger_v1",
    tenant_id: args.tenantId,
    scope: args.scope,
    job_id: args.jobId,
    source_episode_id: args.sourceEpisodeId,
    source_feedback_event_id: args.sourceFeedbackEventId,
    source_commit_id: args.sourceCommitId,
    payload_sha256: args.payloadSha256,
    attempt_count: args.attemptCount,
    last_error_code: args.lastErrorCode,
  }));
}

export const LearningSafetyStopOperationReceiptV1Schema = z.object({
  contract_version: z.literal("learning_safety_stop_operation_receipt_v1"),
  status: z.literal("pause_applied"),
  tenant_id: Id,
  authority_scope: Id,
  operation_kind: z.literal("learning_gate_authority_v1"),
  operation_id: Id,
  request_sha256: Digest,
  decision_id: Id,
  decision_sha256: Digest,
  trigger_ref_kind: LearningSafetyStopTriggerKindSchema,
  trigger_ref_id: Id,
  trigger_episode_id: Id.nullable(),
  trigger_sha256: Digest,
  candidate_policy_implementation_sha256: Digest,
  stop_policy_sha256: Digest,
  source_commit_id: Id,
}).strict();

export type LearningSafetyStopOperationReceiptV1 = z.infer<typeof LearningSafetyStopOperationReceiptV1Schema>;

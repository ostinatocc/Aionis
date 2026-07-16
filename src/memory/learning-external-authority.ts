import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

const DigestSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const ExactIdSchema = z.string().superRefine((value, context) => {
  if (value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > 256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected an exact identifier bounded to 256 UTF-8 bytes",
    });
  }
});
const NonNegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const UnixIdentitySchema = z.number().int().nonnegative().max(0xffff_ffff);
const OperatingSystemProcessIdSchema = z.number().int().positive().max(4_194_304);

export const LearningExternalCanonicalUtcMillisSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .datetime({ offset: false, precision: 3 });

function canonicalBase64(value: string, byteLength: number): boolean {
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.byteLength === byteLength && decoded.toString("base64") === value;
  } catch {
    return false;
  }
}

export const LearningExternalEd25519PublicKeyBase64Schema = z.string().refine(
  (value) => canonicalBase64(value, 32),
  "Expected a canonical base64-encoded 32-byte Ed25519 public key",
);

export const LearningExternalEd25519SignatureBase64Schema = z.string().refine(
  (value) => canonicalBase64(value, 64),
  "Expected a canonical base64-encoded 64-byte Ed25519 signature",
);

export const LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY =
  "aionis-formal-run-broker" as const;

const BrokerAuthorityShape = {
  broker_service_identity: z.literal(LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY),
  broker_policy_sha256: DigestSha256Schema,
  broker_binary_sha256: DigestSha256Schema,
  broker_public_key_sha256: DigestSha256Schema,
  broker_key_id: ExactIdSchema,
} as const;

const ExternalAuthorityChainShape = {
  tenant_id: ExactIdSchema,
  reservation_id: ExactIdSchema,
  ticket_consumption_id: ExactIdSchema,
} as const;

export const LearningExternalPreclaimHoldReasonSchema = z.enum([
  "sealed_input_mismatch",
  "validation_failure",
  "preclaim_crash",
  "preclaim_timeout",
  "operator_abort",
  "broker_integrity_failure",
]);

export const LearningExternalPreclaimJournalPhaseSchema = z.enum([
  "consumed_unclaimed",
  "validating_sealed_input",
  "closing_reserved_run",
]);

export const LearningExternalPreclaimHoldReceiptBodyV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_preclaim_hold_receipt_v1"),
  ...ExternalAuthorityChainShape,
  hold_id: ExactIdSchema,
  ticket_consumption_sha256: DigestSha256Schema,
  hold_reason: LearningExternalPreclaimHoldReasonSchema,
  triggering_terminal_fact_sha256: DigestSha256Schema.nullable(),
  zero_effects_proof_sha256: DigestSha256Schema,
  journal_phase: LearningExternalPreclaimJournalPhaseSchema,
  ...BrokerAuthorityShape,
  held_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((value, context) => {
  const requiresTrigger = value.hold_reason === "operator_abort";
  if (requiresTrigger !== (value.triggering_terminal_fact_sha256 !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["triggering_terminal_fact_sha256"],
      message: "operator_abort alone requires a triggering terminal fact",
    });
  }
  if ((value.journal_phase === "closing_reserved_run") !== requiresTrigger) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["journal_phase"],
      message: "closing_reserved_run is reserved for operator_abort closure",
    });
  }
  const expectedJournalPhase = requiresTrigger
    ? "closing_reserved_run"
    : ["sealed_input_mismatch", "validation_failure"].includes(value.hold_reason)
      ? "validating_sealed_input"
      : "consumed_unclaimed";
  if (value.journal_phase !== expectedJournalPhase) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["journal_phase"],
      message: `Pre-claim hold reason requires ${expectedJournalPhase}`,
    });
  }
});

export type LearningExternalPreclaimHoldReceiptBodyV1 = z.infer<
  typeof LearningExternalPreclaimHoldReceiptBodyV1Schema
>;

export const LearningExternalClaimReceiptBodyV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_claim_receipt_v1"),
  ...ExternalAuthorityChainShape,
  claim_id: ExactIdSchema,
  ticket_consumption_sha256: DigestSha256Schema,
  runner_ticket_sha256: DigestSha256Schema,
  runner_principal_sha256: DigestSha256Schema,
  runner_execution_nonce_sha256: DigestSha256Schema,
  credential_scope_sha256: DigestSha256Schema,
  credential_session_class: z.enum([
    "eligible_host_adapter",
    "formal_tool_eval",
    "immutable_paired_eval",
  ]),
  credential_session_id_sha256: DigestSha256Schema,
  supervisor_bind_expires_at: LearningExternalCanonicalUtcMillisSchema,
  credential_session_expires_at: LearningExternalCanonicalUtcMillisSchema,
  credential_session_heartbeat_seconds: PositiveIntegerSchema.max(60),
  credential_session_max_calls: PositiveIntegerSchema.max(10_000),
  per_call_capability_ttl_seconds: PositiveIntegerSchema.max(60),
  post_quiesce_finalize_ttl_seconds: PositiveIntegerSchema.max(86_400),
  ...BrokerAuthorityShape,
  claimed_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((value, context) => {
  const claimedAt = Date.parse(value.claimed_at);
  const bindExpiry = Date.parse(value.supervisor_bind_expires_at);
  const sessionExpiry = Date.parse(value.credential_session_expires_at);
  if (bindExpiry <= claimedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["supervisor_bind_expires_at"],
      message: "Supervisor binding expiry must follow claim time",
    });
  }
  if (sessionExpiry <= claimedAt || sessionExpiry < bindExpiry) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["credential_session_expires_at"],
      message: "Credential session expiry must cover the supervisor binding window",
    });
  }
});

export type LearningExternalClaimReceiptBodyV1 = z.infer<
  typeof LearningExternalClaimReceiptBodyV1Schema
>;

export const LearningExternalLauncherSpawnReceiptBodyV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_launcher_spawn_receipt_v1"),
  ...ExternalAuthorityChainShape,
  claim_id: ExactIdSchema,
  credential_session_id_sha256: DigestSha256Schema,
  broker_challenge_sha256: DigestSha256Schema,
  runner_principal_sha256: DigestSha256Schema,
  runner_uid: UnixIdentitySchema,
  runner_gid: UnixIdentitySchema,
  supervisor_pid: OperatingSystemProcessIdSchema,
  supervisor_process_start_identity_sha256: DigestSha256Schema,
  supervisor_cgroup_identity_sha256: DigestSha256Schema,
  supervisor_service_job_identity_sha256: DigestSha256Schema,
  supervisor_process_identity_sha256: DigestSha256Schema,
  supervisor_executable_sha256: DigestSha256Schema,
  supervisor_argv_policy_sha256: DigestSha256Schema,
  supervisor_argv_sha256: DigestSha256Schema,
  inherited_channel_sha256: DigestSha256Schema,
  broker_channel_fingerprint_sha256: DigestSha256Schema,
  supervisor_channel_fingerprint_sha256: DigestSha256Schema,
  service_launcher_policy_sha256: DigestSha256Schema,
  service_launcher_binary_sha256: DigestSha256Schema,
  service_launcher_public_key_sha256: DigestSha256Schema,
  service_launcher_key_id: ExactIdSchema,
  supervisor_sandbox_policy_sha256: DigestSha256Schema,
  spawned_at: LearningExternalCanonicalUtcMillisSchema,
}).strict();

export type LearningExternalLauncherSpawnReceiptBodyV1 = z.infer<
  typeof LearningExternalLauncherSpawnReceiptBodyV1Schema
>;

const ExternalImmutableInputCommonShape = {
  contract_version: z.literal("aionis_learning_external_immutable_input_manifest_v1"),
  tenant_id: ExactIdSchema,
  evidence_series_id: ExactIdSchema,
  task_family: ExactIdSchema,
  applicable_experiment_id: ExactIdSchema,
  applicable_experiment_revision: PositiveIntegerSchema,
  candidate_policy_id: ExactIdSchema,
  candidate_policy_version: ExactIdSchema,
  candidate_policy_implementation_sha256: DigestSha256Schema,
  candidate_policy_config_sha256: DigestSha256Schema,
  gate_policy_id: ExactIdSchema,
  gate_policy_version: ExactIdSchema,
  gate_policy_config_sha256: DigestSha256Schema,
  harness_bundle_sha256: DigestSha256Schema,
  source_snapshot_sha256: DigestSha256Schema,
  execution_profile_sha256: DigestSha256Schema,
  model_identity_sha256: DigestSha256Schema,
  expected_runner_principal_sha256: DigestSha256Schema,
  run_id: ExactIdSchema,
} as const;

export const LearningExternalImmutableInputManifestV1Schema = z.discriminatedUnion(
  "artifact_kind",
  [
    z.object({
      ...ExternalImmutableInputCommonShape,
      artifact_kind: z.literal("offline_paired_rerun"),
      case_set_sha256: DigestSha256Schema,
      holdout_membership_projection_sha256: DigestSha256Schema,
      sealed_holdout_ref_sha256: DigestSha256Schema,
      sealed_holdout_ciphertext_sha256: DigestSha256Schema,
      immutable_model_snapshot_sha256: DigestSha256Schema,
      tool_manifest_sha256: DigestSha256Schema,
      execution_order_sha256: DigestSha256Schema,
    }).strict(),
    z.object({
      ...ExternalImmutableInputCommonShape,
      artifact_kind: z.literal("production_shadow_gate"),
    }).strict(),
    z.object({
      ...ExternalImmutableInputCommonShape,
      artifact_kind: z.literal("tool_e2e_gate"),
      tool_manifest_sha256: DigestSha256Schema,
    }).strict(),
  ],
);

export type LearningExternalImmutableInputManifestV1 = z.infer<
  typeof LearningExternalImmutableInputManifestV1Schema
>;

export const LearningExternalRetryPolicyV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_retry_policy_v1"),
  max_formal_attempts: z.literal(1),
  retry_after_ticket_consumption: z.literal(false),
  retry_after_claim: z.literal(false),
}).strict();

export type LearningExternalRetryPolicyV1 = z.infer<
  typeof LearningExternalRetryPolicyV1Schema
>;

export const LearningExternalRunReservationAuthorizationReceiptBodyV1Schema = z.object({
  contract_version: z.literal(
    "aionis_learning_external_run_reservation_authorization_receipt_v1",
  ),
  tenant_id: ExactIdSchema,
  database_instance_id: DigestSha256Schema,
  reservation_id: ExactIdSchema,
  artifact_kind: z.enum([
    "offline_paired_rerun",
    "production_shadow_gate",
    "tool_e2e_gate",
  ]),
  evidence_series_id: ExactIdSchema,
  external_role: z.enum(["offline_paired", "production_shadow", "tool_e2e"]),
  applicable_experiment_id: ExactIdSchema,
  applicable_experiment_revision: PositiveIntegerSchema,
  run_id: ExactIdSchema,
  expected_runner_principal_sha256: DigestSha256Schema,
  reserve_operation_id: ExactIdSchema,
  reservation_sha256: DigestSha256Schema,
  runner_ticket_sha256: DigestSha256Schema,
  authority_request_sha256: DigestSha256Schema,
  ...BrokerAuthorityShape,
  authorized_at: LearningExternalCanonicalUtcMillisSchema,
  authorization_expires_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((value, context) => {
  const authorizedAt = Date.parse(value.authorized_at);
  const expiresAt = Date.parse(value.authorization_expires_at);
  if (expiresAt <= authorizedAt || expiresAt > authorizedAt + 60_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authorization_expires_at"],
      message: "External reservation authorization must expire within 60 seconds",
    });
  }
});

export type LearningExternalRunReservationAuthorizationReceiptBodyV1 = z.infer<
  typeof LearningExternalRunReservationAuthorizationReceiptBodyV1Schema
>;

export const LearningExternalTicketConsumptionAuthorizationReceiptBodyV1Schema = z.object({
  contract_version: z.literal(
    "aionis_learning_external_ticket_consumption_authorization_receipt_v1",
  ),
  tenant_id: ExactIdSchema,
  database_instance_id: DigestSha256Schema,
  reservation_id: ExactIdSchema,
  consumption_id: ExactIdSchema,
  artifact_kind: z.enum([
    "offline_paired_rerun",
    "production_shadow_gate",
    "tool_e2e_gate",
  ]),
  evidence_series_id: ExactIdSchema,
  external_role: z.enum(["offline_paired", "production_shadow", "tool_e2e"]),
  applicable_experiment_id: ExactIdSchema,
  applicable_experiment_revision: PositiveIntegerSchema,
  run_id: ExactIdSchema,
  consume_operation_id: ExactIdSchema,
  reservation_sha256: DigestSha256Schema,
  consumption_sha256: DigestSha256Schema,
  runner_ticket_sha256: DigestSha256Schema,
  runner_principal_sha256: DigestSha256Schema,
  broker_process_nonce_sha256: DigestSha256Schema,
  authority_request_sha256: DigestSha256Schema,
  ...BrokerAuthorityShape,
  authorized_at: LearningExternalCanonicalUtcMillisSchema,
  authorization_expires_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((value, context) => {
  const authorizedAt = Date.parse(value.authorized_at);
  const expiresAt = Date.parse(value.authorization_expires_at);
  if (expiresAt <= authorizedAt || expiresAt > authorizedAt + 60_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authorization_expires_at"],
      message: "External ticket-consumption authorization must expire within 60 seconds",
    });
  }
});

export type LearningExternalTicketConsumptionAuthorizationReceiptBodyV1 = z.infer<
  typeof LearningExternalTicketConsumptionAuthorizationReceiptBodyV1Schema
>;

const SignedReceiptEnvelopeShape = {
  signature_algorithm: z.literal("ed25519-v1"),
  signature_base64: LearningExternalEd25519SignatureBase64Schema,
} as const;

export const LearningExternalSignedReceiptEnvelopeV1Schema = z.object({
  body: z.record(z.unknown()),
  ...SignedReceiptEnvelopeShape,
}).strict();

export type LearningExternalSignedReceiptEnvelopeV1<TBody extends Record<string, unknown> = Record<string, unknown>> =
  Readonly<{
    body: TBody;
    signature_algorithm: "ed25519-v1";
    signature_base64: string;
  }>;

function signedEnvelopeSchema<T extends z.ZodTypeAny>(body: T) {
  return z.object({
    body,
    ...SignedReceiptEnvelopeShape,
  }).strict();
}

export const LearningExternalRunReservationAuthorizationReceiptEnvelopeV1Schema =
  signedEnvelopeSchema(LearningExternalRunReservationAuthorizationReceiptBodyV1Schema);
export type LearningExternalRunReservationAuthorizationReceiptEnvelopeV1 = z.infer<
  typeof LearningExternalRunReservationAuthorizationReceiptEnvelopeV1Schema
>;

export const LearningExternalTicketConsumptionAuthorizationReceiptEnvelopeV1Schema =
  signedEnvelopeSchema(LearningExternalTicketConsumptionAuthorizationReceiptBodyV1Schema);
export type LearningExternalTicketConsumptionAuthorizationReceiptEnvelopeV1 = z.infer<
  typeof LearningExternalTicketConsumptionAuthorizationReceiptEnvelopeV1Schema
>;

export const LearningExternalPreclaimHoldReceiptEnvelopeV1Schema = signedEnvelopeSchema(
  LearningExternalPreclaimHoldReceiptBodyV1Schema,
);
export type LearningExternalPreclaimHoldReceiptEnvelopeV1 = z.infer<
  typeof LearningExternalPreclaimHoldReceiptEnvelopeV1Schema
>;

export const LearningExternalClaimReceiptEnvelopeV1Schema = signedEnvelopeSchema(
  LearningExternalClaimReceiptBodyV1Schema,
);
export type LearningExternalClaimReceiptEnvelopeV1 = z.infer<
  typeof LearningExternalClaimReceiptEnvelopeV1Schema
>;

export const LearningExternalLauncherSpawnReceiptEnvelopeV1Schema = signedEnvelopeSchema(
  LearningExternalLauncherSpawnReceiptBodyV1Schema,
);
export type LearningExternalLauncherSpawnReceiptEnvelopeV1 = z.infer<
  typeof LearningExternalLauncherSpawnReceiptEnvelopeV1Schema
>;

export const LearningExternalBrokerSupervisorBindingReceiptBodyV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_broker_supervisor_binding_receipt_v1"),
  ...ExternalAuthorityChainShape,
  binding_id: ExactIdSchema,
  claim_id: ExactIdSchema,
  credential_session_id_sha256: DigestSha256Schema,
  runner_principal_sha256: DigestSha256Schema,
  supervisor_process_identity_sha256: DigestSha256Schema,
  supervisor_executable_sha256: DigestSha256Schema,
  supervisor_argv_policy_sha256: DigestSha256Schema,
  supervisor_argv_sha256: DigestSha256Schema,
  inherited_channel_sha256: DigestSha256Schema,
  service_launcher_receipt_sha256: DigestSha256Schema,
  service_launcher_receipt: LearningExternalLauncherSpawnReceiptEnvelopeV1Schema,
  service_launcher_policy_sha256: DigestSha256Schema,
  service_launcher_binary_sha256: DigestSha256Schema,
  service_launcher_public_key_sha256: DigestSha256Schema,
  service_launcher_key_id: ExactIdSchema,
  supervisor_sandbox_policy_sha256: DigestSha256Schema,
  ...BrokerAuthorityShape,
  bound_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((value, context) => {
  const launcher = value.service_launcher_receipt.body;
  const equalFields = [
    "tenant_id",
    "reservation_id",
    "ticket_consumption_id",
    "claim_id",
    "credential_session_id_sha256",
    "runner_principal_sha256",
    "supervisor_process_identity_sha256",
    "supervisor_executable_sha256",
    "supervisor_argv_policy_sha256",
    "supervisor_argv_sha256",
    "inherited_channel_sha256",
    "service_launcher_policy_sha256",
    "service_launcher_binary_sha256",
    "service_launcher_public_key_sha256",
    "service_launcher_key_id",
    "supervisor_sandbox_policy_sha256",
  ] as const;
  for (const field of equalFields) {
    if (value[field] !== launcher[field]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} does not match the nested launcher receipt`,
      });
    }
  }
  if (value.service_launcher_receipt_sha256
    !== learningExternalReceiptDigest(value.service_launcher_receipt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["service_launcher_receipt_sha256"],
      message: "Launcher receipt digest does not bind the nested signed envelope",
    });
  }
  if (Date.parse(value.bound_at) < Date.parse(launcher.spawned_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["bound_at"],
      message: "Supervisor binding cannot precede launcher spawn",
    });
  }
});

export type LearningExternalBrokerSupervisorBindingReceiptBodyV1 = z.infer<
  typeof LearningExternalBrokerSupervisorBindingReceiptBodyV1Schema
>;

export const LearningExternalBrokerSupervisorBindingReceiptEnvelopeV1Schema = signedEnvelopeSchema(
  LearningExternalBrokerSupervisorBindingReceiptBodyV1Schema,
);
export type LearningExternalBrokerSupervisorBindingReceiptEnvelopeV1 = z.infer<
  typeof LearningExternalBrokerSupervisorBindingReceiptEnvelopeV1Schema
>;

export const LearningExternalCleanQuiesceReceiptBodyV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_clean_quiesce_receipt_v1"),
  ...ExternalAuthorityChainShape,
  claim_id: ExactIdSchema,
  supervisor_binding_id: ExactIdSchema,
  credential_session_id_sha256: DigestSha256Schema,
  runner_output_manifest_sha256: DigestSha256Schema,
  attempt_chain_sha256: DigestSha256Schema,
  cleanup_proof_sha256: DigestSha256Schema,
  post_revoke_access_denial_proof_sha256: DigestSha256Schema,
  finalize_deadline_at: LearningExternalCanonicalUtcMillisSchema,
  ...BrokerAuthorityShape,
  quiesced_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.finalize_deadline_at) <= Date.parse(value.quiesced_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["finalize_deadline_at"],
      message: "Post-quiesce finalization deadline must follow quiesce time",
    });
  }
});

export type LearningExternalCleanQuiesceReceiptBodyV1 = z.infer<
  typeof LearningExternalCleanQuiesceReceiptBodyV1Schema
>;

export const LearningExternalCleanQuiesceReceiptEnvelopeV1Schema = signedEnvelopeSchema(
  LearningExternalCleanQuiesceReceiptBodyV1Schema,
);
export type LearningExternalCleanQuiesceReceiptEnvelopeV1 = z.infer<
  typeof LearningExternalCleanQuiesceReceiptEnvelopeV1Schema
>;

export const LearningExternalSessionTerminationReasonSchema = z.enum([
  "passed",
  "failed",
  "inconclusive",
  "launch_failure",
  "binding_integrity_failure",
  "runner_crash",
  "lease_expired",
  "operator_revoke",
  "post_quiesce_revoke",
  "finalize_timeout",
]);

export const LearningExternalSessionTerminationReceiptBodyV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_session_termination_receipt_v1"),
  ...ExternalAuthorityChainShape,
  termination_id: ExactIdSchema,
  claim_id: ExactIdSchema,
  supervisor_binding_id: ExactIdSchema.nullable(),
  credential_session_id_sha256: DigestSha256Schema,
  termination_reason: LearningExternalSessionTerminationReasonSchema,
  broker_quiesce_receipt_sha256: DigestSha256Schema.nullable(),
  broker_quiesce_receipt: LearningExternalCleanQuiesceReceiptEnvelopeV1Schema.nullable(),
  runner_output_manifest_sha256: DigestSha256Schema.nullable(),
  terminal_run_manifest_sha256: DigestSha256Schema.nullable(),
  attempt_chain_sha256: DigestSha256Schema,
  ...BrokerAuthorityShape,
  terminated_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((value, context) => {
  const normal = ["passed", "failed", "inconclusive"].includes(value.termination_reason);
  const postQuiesceHold = ["post_quiesce_revoke", "finalize_timeout"].includes(
    value.termination_reason,
  );
  const preBinding = ["launch_failure", "binding_integrity_failure"].includes(
    value.termination_reason,
  );
  const abnormal = ["runner_crash", "lease_expired", "operator_revoke"].includes(
    value.termination_reason,
  );
  const hasBinding = value.supervisor_binding_id !== null;
  const hasQuiesce = value.broker_quiesce_receipt_sha256 !== null
    && value.broker_quiesce_receipt !== null;
  const hasOutput = value.runner_output_manifest_sha256 !== null;
  const hasManifest = value.terminal_run_manifest_sha256 !== null;

  if ((normal && !(hasBinding && hasQuiesce && hasOutput && hasManifest))
    || (postQuiesceHold && !(hasBinding && hasQuiesce && hasOutput && !hasManifest))
    || (preBinding && (hasBinding || hasQuiesce || hasOutput || hasManifest))
    || (abnormal && (hasQuiesce || hasOutput || hasManifest))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["termination_reason"],
      message: "Termination reason does not match its required binding/quiesce/output/manifest shape",
    });
  }
  if (value.termination_reason === "runner_crash" && !hasBinding) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["supervisor_binding_id"],
      message: "runner_crash requires the committed supervisor binding",
    });
  }
  if ((value.broker_quiesce_receipt_sha256 === null)
    !== (value.broker_quiesce_receipt === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["broker_quiesce_receipt"],
      message: "Quiesce receipt and digest must be present or absent together",
    });
  }
  const quiesce = value.broker_quiesce_receipt;
  if (quiesce !== null) {
    if (value.broker_quiesce_receipt_sha256 !== learningExternalReceiptDigest(quiesce)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["broker_quiesce_receipt_sha256"],
        message: "Quiesce receipt digest does not bind the nested signed envelope",
      });
    }
    const body = quiesce.body;
    const equalFields = [
      "tenant_id",
      "reservation_id",
      "ticket_consumption_id",
      "claim_id",
      "supervisor_binding_id",
      "credential_session_id_sha256",
      "runner_output_manifest_sha256",
      "attempt_chain_sha256",
      "broker_service_identity",
      "broker_policy_sha256",
      "broker_binary_sha256",
      "broker_public_key_sha256",
      "broker_key_id",
    ] as const;
    for (const field of equalFields) {
      if (value[field] !== body[field]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} does not match the nested clean-quiesce receipt`,
        });
      }
    }
    if (Date.parse(value.terminated_at) < Date.parse(body.quiesced_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["terminated_at"],
        message: "Session termination cannot precede clean quiesce",
      });
    }
    if (value.termination_reason === "finalize_timeout"
      && Date.parse(value.terminated_at) < Date.parse(body.finalize_deadline_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["terminated_at"],
        message: "finalize_timeout cannot precede the frozen finalization deadline",
      });
    }
    if (value.termination_reason === "post_quiesce_revoke"
      && Date.parse(value.terminated_at) > Date.parse(body.finalize_deadline_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["terminated_at"],
        message: "post_quiesce_revoke cannot follow the frozen finalization deadline",
      });
    }
  }
});

export type LearningExternalSessionTerminationReceiptBodyV1 = z.infer<
  typeof LearningExternalSessionTerminationReceiptBodyV1Schema
>;

export const LearningExternalSessionTerminationReceiptEnvelopeV1Schema = signedEnvelopeSchema(
  LearningExternalSessionTerminationReceiptBodyV1Schema,
);
export type LearningExternalSessionTerminationReceiptEnvelopeV1 = z.infer<
  typeof LearningExternalSessionTerminationReceiptEnvelopeV1Schema
>;

function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function learningExternalReceiptDigest(
  value: LearningExternalSignedReceiptEnvelopeV1,
): string {
  const envelope = LearningExternalSignedReceiptEnvelopeV1Schema.parse(value);
  return sha256Bytes(stableStringify(envelope));
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function ed25519PublicKey(rawPublicKeyBase64: string): KeyObject {
  const raw = Buffer.from(
    LearningExternalEd25519PublicKeyBase64Schema.parse(rawPublicKeyBase64),
    "base64",
  );
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function verifyLearningExternalReceipt<TBody extends Record<string, unknown>>(args: {
  bodySchema: z.ZodType<TBody>;
  envelope: unknown;
  expectedPublicKeyBase64: string;
}): LearningExternalSignedReceiptEnvelopeV1<TBody> {
  const rawEnvelope = LearningExternalSignedReceiptEnvelopeV1Schema.parse(args.envelope);
  const body = args.bodySchema.parse(rawEnvelope.body);
  const publicKeyBase64 = LearningExternalEd25519PublicKeyBase64Schema.parse(
    args.expectedPublicKeyBase64,
  );
  const publicKeySha256 = sha256Bytes(Buffer.from(publicKeyBase64, "base64"));
  const declaredPublicKeySha256 = "broker_public_key_sha256" in body
    ? body.broker_public_key_sha256
    : body.service_launcher_public_key_sha256;
  if (declaredPublicKeySha256 !== publicKeySha256) {
    throw new Error("learning_external_receipt_public_key_mismatch");
  }
  const valid = verifySignature(
    null,
    Buffer.from(stableStringify(body), "utf8"),
    ed25519PublicKey(publicKeyBase64),
    Buffer.from(rawEnvelope.signature_base64, "base64"),
  );
  if (!valid) throw new Error("learning_external_receipt_signature_invalid");
  return {
    body,
    signature_algorithm: rawEnvelope.signature_algorithm,
    signature_base64: rawEnvelope.signature_base64,
  };
}

function boundedCanonicalJsonSchema(maxUtf8Bytes: number) {
  return z.string().superRefine((value, context) => {
    if (Buffer.byteLength(value, "utf8") > maxUtf8Bytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Canonical JSON exceeds ${maxUtf8Bytes} UTF-8 bytes`,
      });
    }
  });
}

const ReceiptJsonSchema = boundedCanonicalJsonSchema(16_384);

function parseCanonicalReceiptBody<TBody extends Record<string, unknown>>(
  raw: string,
  bodySchema: z.ZodType<TBody>,
): TBody {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error("learning_external_receipt_json_invalid");
  }
  const body = bodySchema.parse(decoded);
  if (stableStringify(body) !== raw) {
    throw new Error("learning_external_receipt_json_noncanonical");
  }
  return body;
}

function rowReceiptEnvelope<TBody extends Record<string, unknown>>(
  raw: string,
  signatureBase64: string,
  bodySchema: z.ZodType<TBody>,
): LearningExternalSignedReceiptEnvelopeV1<TBody> {
  return {
    body: parseCanonicalReceiptBody(raw, bodySchema),
    signature_algorithm: "ed25519-v1",
    signature_base64: LearningExternalEd25519SignatureBase64Schema.parse(signatureBase64),
  };
}

function addSchemaIssue(context: z.RefinementCtx, path: string, error: unknown): void {
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message: error instanceof Error ? error.message : String(error),
  });
}

function assertMatchingFields(
  context: z.RefinementCtx,
  row: Record<string, unknown>,
  body: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    if (row[field] !== body[field]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} does not match the canonical signed receipt body`,
      });
    }
  }
}

export const LearningExternalPreclaimHoldRowV1Schema = z.object({
  tenant_id: ExactIdSchema,
  hold_id: ExactIdSchema,
  reservation_id: ExactIdSchema,
  ticket_consumption_id: ExactIdSchema,
  hold_reason: LearningExternalPreclaimHoldReasonSchema,
  triggering_terminal_fact_sha256: DigestSha256Schema.nullable(),
  zero_effects_proof_sha256: DigestSha256Schema,
  broker_preclaim_hold_receipt_sha256: DigestSha256Schema,
  broker_preclaim_hold_receipt_json: ReceiptJsonSchema,
  broker_preclaim_hold_receipt_signature: LearningExternalEd25519SignatureBase64Schema,
  hold_actor_id: ExactIdSchema,
  hold_operation_id: ExactIdSchema,
  held_at: LearningExternalCanonicalUtcMillisSchema,
  hold_sha256: DigestSha256Schema,
}).strict().superRefine((row, context) => {
  try {
    const envelope = rowReceiptEnvelope(
      row.broker_preclaim_hold_receipt_json,
      row.broker_preclaim_hold_receipt_signature,
      LearningExternalPreclaimHoldReceiptBodyV1Schema,
    );
    if (row.broker_preclaim_hold_receipt_sha256 !== learningExternalReceiptDigest(envelope)) {
      throw new Error("broker_preclaim_hold_receipt_sha256_mismatch");
    }
    assertMatchingFields(context, row, envelope.body, [
      "tenant_id", "hold_id", "reservation_id", "ticket_consumption_id", "hold_reason",
      "triggering_terminal_fact_sha256", "zero_effects_proof_sha256", "held_at",
    ]);
    const actorId = learningExternalBrokerServiceActorId(envelope.body);
    if (row.hold_actor_id !== actorId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["hold_actor_id"], message: "hold_actor_id mismatch" });
    }
    const operationId = learningExternalPreclaimHoldOperationId({
      tenantId: row.tenant_id,
      receiptSha256: row.broker_preclaim_hold_receipt_sha256,
    });
    if (row.hold_operation_id !== operationId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["hold_operation_id"], message: "hold_operation_id mismatch" });
    }
  } catch (error) {
    addSchemaIssue(context, "broker_preclaim_hold_receipt_json", error);
  }
});

export type LearningExternalPreclaimHoldRowV1 = z.infer<
  typeof LearningExternalPreclaimHoldRowV1Schema
>;

export const LearningExternalRunClaimRowV1Schema = z.object({
  tenant_id: ExactIdSchema,
  claim_id: ExactIdSchema,
  reservation_id: ExactIdSchema,
  ticket_consumption_id: ExactIdSchema,
  ticket_consumption_sha256: DigestSha256Schema,
  runner_principal_sha256: DigestSha256Schema,
  runner_execution_nonce_sha256: DigestSha256Schema,
  credential_broker_receipt_sha256: DigestSha256Schema,
  credential_broker_policy_sha256: DigestSha256Schema,
  credential_broker_binary_sha256: DigestSha256Schema,
  credential_broker_key_id: ExactIdSchema,
  credential_broker_receipt_json: ReceiptJsonSchema,
  credential_broker_receipt_signature: LearningExternalEd25519SignatureBase64Schema,
  credential_session_id_sha256: DigestSha256Schema,
  supervisor_bind_expires_at: LearningExternalCanonicalUtcMillisSchema,
  credential_session_expires_at: LearningExternalCanonicalUtcMillisSchema,
  credential_session_heartbeat_seconds: PositiveIntegerSchema.max(60),
  credential_session_max_calls: PositiveIntegerSchema.max(10_000),
  claim_operation_id: ExactIdSchema,
  claimed_at: LearningExternalCanonicalUtcMillisSchema,
  claim_sha256: DigestSha256Schema,
}).strict().superRefine((row, context) => {
  try {
    const envelope = rowReceiptEnvelope(
      row.credential_broker_receipt_json,
      row.credential_broker_receipt_signature,
      LearningExternalClaimReceiptBodyV1Schema,
    );
    if (row.credential_broker_receipt_sha256 !== learningExternalReceiptDigest(envelope)) {
      throw new Error("credential_broker_receipt_sha256_mismatch");
    }
    assertMatchingFields(context, row, envelope.body, [
      "tenant_id", "claim_id", "reservation_id", "ticket_consumption_id",
      "ticket_consumption_sha256", "runner_principal_sha256", "runner_execution_nonce_sha256",
      "credential_session_id_sha256", "supervisor_bind_expires_at",
      "credential_session_expires_at", "credential_session_heartbeat_seconds",
      "credential_session_max_calls", "claimed_at",
    ]);
    const authorityFields = [
      ["credential_broker_policy_sha256", "broker_policy_sha256"],
      ["credential_broker_binary_sha256", "broker_binary_sha256"],
      ["credential_broker_key_id", "broker_key_id"],
    ] as const;
    for (const [rowField, bodyField] of authorityFields) {
      if (row[rowField] !== envelope.body[bodyField]) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [rowField], message: `${rowField} mismatch` });
      }
    }
    const operationId = learningExternalRunClaimOperationId({
      tenantId: row.tenant_id,
      receiptSha256: row.credential_broker_receipt_sha256,
    });
    if (row.claim_operation_id !== operationId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claim_operation_id"],
        message: "claim_operation_id mismatch",
      });
    }
  } catch (error) {
    addSchemaIssue(context, "credential_broker_receipt_json", error);
  }
});

export type LearningExternalRunClaimRowV1 = z.infer<
  typeof LearningExternalRunClaimRowV1Schema
>;

export const LearningExternalSupervisorBindingRowV1Schema = z.object({
  tenant_id: ExactIdSchema,
  binding_id: ExactIdSchema,
  reservation_id: ExactIdSchema,
  ticket_consumption_id: ExactIdSchema,
  claim_id: ExactIdSchema,
  credential_session_id_sha256: DigestSha256Schema,
  runner_principal_sha256: DigestSha256Schema,
  supervisor_process_identity_sha256: DigestSha256Schema,
  supervisor_executable_sha256: DigestSha256Schema,
  supervisor_argv_sha256: DigestSha256Schema,
  inherited_channel_sha256: DigestSha256Schema,
  service_launcher_receipt_sha256: DigestSha256Schema,
  service_launcher_policy_sha256: DigestSha256Schema,
  service_launcher_binary_sha256: DigestSha256Schema,
  service_launcher_key_id: ExactIdSchema,
  supervisor_sandbox_policy_sha256: DigestSha256Schema,
  broker_binding_receipt_sha256: DigestSha256Schema,
  broker_binding_receipt_json: ReceiptJsonSchema,
  broker_binding_receipt_signature: LearningExternalEd25519SignatureBase64Schema,
  bind_operation_id: ExactIdSchema,
  bound_at: LearningExternalCanonicalUtcMillisSchema,
  binding_sha256: DigestSha256Schema,
}).strict().superRefine((row, context) => {
  try {
    const envelope = rowReceiptEnvelope(
      row.broker_binding_receipt_json,
      row.broker_binding_receipt_signature,
      LearningExternalBrokerSupervisorBindingReceiptBodyV1Schema,
    );
    if (row.broker_binding_receipt_sha256 !== learningExternalReceiptDigest(envelope)) {
      throw new Error("broker_binding_receipt_sha256_mismatch");
    }
    assertMatchingFields(context, row, envelope.body, [
      "tenant_id", "binding_id", "reservation_id", "ticket_consumption_id", "claim_id",
      "credential_session_id_sha256", "runner_principal_sha256",
      "supervisor_process_identity_sha256", "supervisor_executable_sha256",
      "supervisor_argv_sha256", "inherited_channel_sha256",
      "service_launcher_receipt_sha256", "service_launcher_policy_sha256",
      "service_launcher_binary_sha256", "service_launcher_key_id",
      "supervisor_sandbox_policy_sha256", "bound_at",
    ]);
    const operationId = learningExternalSupervisorBindingOperationId({
      tenantId: row.tenant_id,
      claimId: row.claim_id,
      receiptSha256: row.broker_binding_receipt_sha256,
    });
    if (row.bind_operation_id !== operationId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["bind_operation_id"], message: "bind_operation_id mismatch" });
    }
  } catch (error) {
    addSchemaIssue(context, "broker_binding_receipt_json", error);
  }
});

export type LearningExternalSupervisorBindingRowV1 = z.infer<
  typeof LearningExternalSupervisorBindingRowV1Schema
>;

export const LearningExternalSessionTerminationRowV1Schema = z.object({
  tenant_id: ExactIdSchema,
  termination_id: ExactIdSchema,
  reservation_id: ExactIdSchema,
  ticket_consumption_id: ExactIdSchema,
  claim_id: ExactIdSchema,
  supervisor_binding_id: ExactIdSchema.nullable(),
  credential_session_id_sha256: DigestSha256Schema,
  termination_reason: LearningExternalSessionTerminationReasonSchema,
  broker_quiesce_receipt_sha256: DigestSha256Schema.nullable(),
  runner_output_manifest_sha256: DigestSha256Schema.nullable(),
  terminal_run_manifest_sha256: DigestSha256Schema.nullable(),
  attempt_chain_sha256: DigestSha256Schema,
  credential_broker_policy_sha256: DigestSha256Schema,
  credential_broker_binary_sha256: DigestSha256Schema,
  credential_broker_key_id: ExactIdSchema,
  broker_terminal_receipt_sha256: DigestSha256Schema,
  broker_terminal_receipt_json: ReceiptJsonSchema,
  broker_terminal_receipt_signature: LearningExternalEd25519SignatureBase64Schema,
  termination_actor_id: ExactIdSchema,
  terminate_operation_id: ExactIdSchema,
  terminated_at: LearningExternalCanonicalUtcMillisSchema,
  termination_sha256: DigestSha256Schema,
}).strict().superRefine((row, context) => {
  try {
    const envelope = rowReceiptEnvelope(
      row.broker_terminal_receipt_json,
      row.broker_terminal_receipt_signature,
      LearningExternalSessionTerminationReceiptBodyV1Schema,
    );
    if (row.broker_terminal_receipt_sha256 !== learningExternalReceiptDigest(envelope)) {
      throw new Error("broker_terminal_receipt_sha256_mismatch");
    }
    assertMatchingFields(context, row, envelope.body, [
      "tenant_id", "termination_id", "reservation_id", "ticket_consumption_id", "claim_id",
      "supervisor_binding_id", "credential_session_id_sha256", "termination_reason",
      "broker_quiesce_receipt_sha256", "runner_output_manifest_sha256",
      "terminal_run_manifest_sha256", "attempt_chain_sha256", "terminated_at",
    ]);
    const authorityFields = [
      ["credential_broker_policy_sha256", "broker_policy_sha256"],
      ["credential_broker_binary_sha256", "broker_binary_sha256"],
      ["credential_broker_key_id", "broker_key_id"],
    ] as const;
    for (const [rowField, bodyField] of authorityFields) {
      if (row[rowField] !== envelope.body[bodyField]) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [rowField], message: `${rowField} mismatch` });
      }
    }
    const actorId = learningExternalBrokerServiceActorId(envelope.body);
    if (row.termination_actor_id !== actorId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["termination_actor_id"], message: "termination_actor_id mismatch" });
    }
    const operationId = learningExternalSessionTerminationOperationId({
      tenantId: row.tenant_id,
      receiptSha256: row.broker_terminal_receipt_sha256,
    });
    if (row.terminate_operation_id !== operationId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["terminate_operation_id"], message: "terminate_operation_id mismatch" });
    }
  } catch (error) {
    addSchemaIssue(context, "broker_terminal_receipt_json", error);
  }
});

export type LearningExternalSessionTerminationRowV1 = z.infer<
  typeof LearningExternalSessionTerminationRowV1Schema
>;

function canonicalRowWithoutDigest(
  row: Record<string, unknown>,
  digestField: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([field]) => field !== digestField)
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  );
}

export function learningExternalPreclaimHoldRowDigest(row: unknown): string {
  const parsed = LearningExternalPreclaimHoldRowV1Schema.parse(row);
  return sha256Bytes(stableStringify(canonicalRowWithoutDigest(parsed, "hold_sha256")));
}

export function learningExternalRunClaimRowDigest(row: unknown): string {
  const parsed = LearningExternalRunClaimRowV1Schema.parse(row);
  return sha256Bytes(stableStringify(canonicalRowWithoutDigest(parsed, "claim_sha256")));
}

export function learningExternalSupervisorBindingRowDigest(row: unknown): string {
  const parsed = LearningExternalSupervisorBindingRowV1Schema.parse(row);
  return sha256Bytes(stableStringify(canonicalRowWithoutDigest(parsed, "binding_sha256")));
}

export function learningExternalSessionTerminationRowDigest(row: unknown): string {
  const parsed = LearningExternalSessionTerminationRowV1Schema.parse(row);
  return sha256Bytes(stableStringify(canonicalRowWithoutDigest(parsed, "termination_sha256")));
}

export const LearningExternalAuthorityOperationDomainSchema = z.enum([
  "learning_external_preclaim_hold_v1",
  "learning_external_run_claim_v1",
  "learning_external_supervisor_binding_v1",
  "learning_external_session_termination_v1",
]);

export type LearningExternalAuthorityOperationDomain = z.infer<
  typeof LearningExternalAuthorityOperationDomainSchema
>;

export function learningExternalAuthorityOperationId(args: {
  operationDomain: LearningExternalAuthorityOperationDomain;
  tenantId: string;
  authorityRefId?: string;
  receiptSha256: string;
}): string {
  const operationDomain = LearningExternalAuthorityOperationDomainSchema.parse(
    args.operationDomain,
  );
  const authorityRef = operationDomain === "learning_external_supervisor_binding_v1"
    ? { claim_id: ExactIdSchema.parse(args.authorityRefId) }
    : {};
  if (operationDomain !== "learning_external_supervisor_binding_v1"
    && args.authorityRefId !== undefined) {
    throw new Error(`${operationDomain} does not accept a caller-selected authority reference`);
  }
  return `lexternal_op_${sha256Bytes(stableStringify({
    operation_domain: operationDomain,
    tenant_id: ExactIdSchema.parse(args.tenantId),
    ...authorityRef,
    receipt_sha256: DigestSha256Schema.parse(args.receiptSha256),
  }))}`;
}

export function learningExternalPreclaimHoldOperationId(args: {
  tenantId: string;
  receiptSha256: string;
}): string {
  return learningExternalAuthorityOperationId({
    operationDomain: "learning_external_preclaim_hold_v1",
    tenantId: args.tenantId,
    receiptSha256: args.receiptSha256,
  });
}

export function learningExternalSupervisorBindingOperationId(args: {
  tenantId: string;
  claimId: string;
  receiptSha256: string;
}): string {
  return learningExternalAuthorityOperationId({
    operationDomain: "learning_external_supervisor_binding_v1",
    tenantId: args.tenantId,
    authorityRefId: args.claimId,
    receiptSha256: args.receiptSha256,
  });
}

export function learningExternalRunClaimOperationId(args: {
  tenantId: string;
  receiptSha256: string;
}): string {
  return learningExternalAuthorityOperationId({
    operationDomain: "learning_external_run_claim_v1",
    tenantId: args.tenantId,
    receiptSha256: args.receiptSha256,
  });
}

export function learningExternalSessionTerminationOperationId(args: {
  tenantId: string;
  receiptSha256: string;
}): string {
  return learningExternalAuthorityOperationId({
    operationDomain: "learning_external_session_termination_v1",
    tenantId: args.tenantId,
    receiptSha256: args.receiptSha256,
  });
}

export function learningExternalBrokerServiceActorId(args: {
  broker_service_identity: typeof LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY;
  broker_policy_sha256: string;
  broker_binary_sha256: string;
  broker_public_key_sha256: string;
  broker_key_id: string;
}): string {
  return `lexternal_broker_${sha256Bytes(stableStringify({
    contract_version: "aionis_learning_external_broker_service_actor_v1",
    broker_service_identity: z.literal(LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY).parse(
      args.broker_service_identity,
    ),
    broker_policy_sha256: DigestSha256Schema.parse(args.broker_policy_sha256),
    broker_binary_sha256: DigestSha256Schema.parse(args.broker_binary_sha256),
    broker_public_key_sha256: DigestSha256Schema.parse(args.broker_public_key_sha256),
    broker_key_id: ExactIdSchema.parse(args.broker_key_id),
  }))}`;
}

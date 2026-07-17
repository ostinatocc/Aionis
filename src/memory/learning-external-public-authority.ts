import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import {
  LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY,
  LearningExternalBrokerSupervisorBindingReceiptBodyV1Schema,
  LearningExternalCanonicalUtcMillisSchema,
  LearningExternalClaimReceiptBodyV1Schema,
  LearningExternalCleanQuiesceReceiptBodyV1Schema,
  LearningExternalEd25519SignatureBase64Schema,
  LearningExternalImmutableInputManifestV1Schema,
  LearningExternalLauncherSpawnReceiptBodyV1Schema,
  LearningExternalRetryPolicyV1Schema,
  LearningExternalRunClaimRowV1Schema,
  LearningExternalRunReservationAuthorizationReceiptBodyV1Schema,
  LearningExternalRunReservationAuthorizationReceiptEnvelopeV1Schema,
  LearningExternalSessionTerminationReceiptBodyV1Schema,
  LearningExternalSessionTerminationRowV1Schema,
  LearningExternalSignedReceiptEnvelopeV1Schema,
  LearningExternalSupervisorBindingRowV1Schema,
  LearningExternalTicketConsumptionAuthorizationReceiptBodyV1Schema,
  LearningExternalTicketConsumptionAuthorizationReceiptEnvelopeV1Schema,
  learningExternalBrokerServiceActorId,
  learningExternalEd25519PublicKeyDigest,
  learningExternalReceiptDigest,
  learningExternalRunClaimRowDigest,
  learningExternalSessionTerminationRowDigest,
  learningExternalSupervisorBindingRowDigest,
  verifyLearningExternalReceiptWithExplicitSigner,
  type LearningExternalSignedReceiptEnvelopeV1,
} from "./learning-external-authority.js";
import {
  LearningExternalAttemptChainV1Schema,
  LearningExternalEvidenceArtifactKindSchema,
  LearningExternalEvidenceReportV1Schema,
  LearningExternalLifecycleAuthorityProjectionV1Schema,
  LearningExternalRunnerOutputManifestV1Schema,
  LearningExternalTerminalRunManifestV1Schema,
  learningExternalAttemptChainDigest,
  learningExternalEvidenceLifecycleAuthorityProjectionDigest,
  learningExternalEvidenceReportDigest,
  learningExternalPreterminalPayloadSetDigest,
  learningExternalRunnerOutputManifestDigest,
  learningExternalTerminalRunManifestDigest,
} from "./learning-external-evidence.js";

const MAX_PUBLIC_RUN_AUTHORITY_BYTES = 32 * 1024 * 1024;
const MAX_DRAIN_ENTRIES = 4_096;

const DigestSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
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
const PositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const UnixIdentitySchema = z.number().int().nonnegative().max(0xffff_ffff);
const ProcessIdSchema = z.number().int().positive().max(4_194_304);
const CanonicalJson4KiBSchema = canonicalJsonStringSchema(4 * 1024);
const CanonicalJson32KiBSchema = canonicalJsonStringSchema(32 * 1024);

function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Canonical(value: unknown): string {
  return sha256Bytes(stableStringify(value));
}

function canonicalJsonStringSchema(maxBytes: number): z.ZodType<string> {
  return z.string().superRefine((value, context) => {
    if (Buffer.byteLength(value, "utf8") > maxBytes) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Canonical JSON exceeds byte limit" });
      return;
    }
    try {
      const decoded = JSON.parse(value) as unknown;
      if (stableStringify(decoded) !== value) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "JSON must be canonical" });
      }
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected valid canonical JSON" });
    }
  });
}

function rowDigest(row: Readonly<Record<string, unknown>>, digestField: string): string {
  return sha256Canonical(Object.fromEntries(
    Object.entries(row)
      .filter(([field]) => field !== digestField)
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  ));
}

const ReservationRowBaseSchema = z.object({
  tenant_id: ExactIdSchema,
  reservation_id: ExactIdSchema,
  artifact_kind: LearningExternalEvidenceArtifactKindSchema,
  evidence_series_id: ExactIdSchema,
  task_family: ExactIdSchema,
  candidate_policy_id: ExactIdSchema,
  candidate_policy_version: ExactIdSchema,
  candidate_policy_implementation_sha256: DigestSha256Schema,
  candidate_policy_config_sha256: DigestSha256Schema,
  applicable_experiment_id: ExactIdSchema,
  applicable_experiment_revision: PositiveIntegerSchema,
  gate_policy_id: ExactIdSchema,
  gate_policy_version: ExactIdSchema,
  gate_policy_config_sha256: DigestSha256Schema,
  applicability_manifest_sha256: DigestSha256Schema,
  harness_bundle_sha256: DigestSha256Schema,
  source_snapshot_sha256: DigestSha256Schema,
  case_set_sha256: DigestSha256Schema.nullable(),
  holdout_membership_projection_sha256: DigestSha256Schema.nullable(),
  sealed_holdout_ref_sha256: DigestSha256Schema.nullable(),
  sealed_holdout_ciphertext_sha256: DigestSha256Schema.nullable(),
  execution_profile_sha256: DigestSha256Schema,
  model_identity_sha256: DigestSha256Schema,
  immutable_model_snapshot_sha256: DigestSha256Schema.nullable(),
  tool_manifest_sha256: DigestSha256Schema.nullable(),
  execution_order_sha256: DigestSha256Schema.nullable(),
  retry_policy_sha256: DigestSha256Schema,
  retry_policy_json: CanonicalJson4KiBSchema,
  immutable_input_manifest_sha256: DigestSha256Schema,
  immutable_input_manifest_json: CanonicalJson32KiBSchema,
  expected_runner_principal_sha256: DigestSha256Schema,
  credential_broker_policy_sha256: DigestSha256Schema,
  service_launcher_policy_sha256: DigestSha256Schema,
  service_launcher_binary_sha256: DigestSha256Schema,
  service_launcher_key_id: ExactIdSchema,
  supervisor_executable_sha256: DigestSha256Schema,
  supervisor_argv_policy_sha256: DigestSha256Schema,
  supervisor_sandbox_policy_sha256: DigestSha256Schema,
  credential_session_class: z.enum([
    "eligible_host_adapter",
    "formal_tool_eval",
    "immutable_paired_eval",
  ]),
  run_id: ExactIdSchema,
  reserve_operation_id: ExactIdSchema,
  runner_ticket_sha256: DigestSha256Schema,
  reservation_sha256: DigestSha256Schema,
  reserved_at: LearningExternalCanonicalUtcMillisSchema,
}).strict();

export const LearningExternalRunReservationRowV1Schema = ReservationRowBaseSchema.superRefine(
  (row, context) => {
    const offline = row.artifact_kind === "offline_paired_rerun";
    const shadow = row.artifact_kind === "production_shadow_gate";
    const requiredOffline = [
      row.case_set_sha256,
      row.holdout_membership_projection_sha256,
      row.sealed_holdout_ref_sha256,
      row.sealed_holdout_ciphertext_sha256,
      row.immutable_model_snapshot_sha256,
      row.tool_manifest_sha256,
      row.execution_order_sha256,
    ];
    if ((offline && (requiredOffline.some((value) => value === null)
      || row.credential_session_class !== "immutable_paired_eval"))
      || (shadow && (requiredOffline.some((value) => value !== null)
        || row.credential_session_class !== "eligible_host_adapter"))
      || (row.artifact_kind === "tool_e2e_gate"
        && (row.case_set_sha256 !== null
          || row.holdout_membership_projection_sha256 !== null
          || row.sealed_holdout_ref_sha256 !== null
          || row.sealed_holdout_ciphertext_sha256 !== null
          || row.immutable_model_snapshot_sha256 !== null
          || row.tool_manifest_sha256 === null
          || row.execution_order_sha256 !== null
          || row.credential_session_class !== "formal_tool_eval"))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifact_kind"],
        message: "Reservation artifact kind and immutable-input shape disagree",
      });
    }
    try {
      const retryPolicy = LearningExternalRetryPolicyV1Schema.parse(JSON.parse(row.retry_policy_json));
      const manifest = LearningExternalImmutableInputManifestV1Schema.parse(
        JSON.parse(row.immutable_input_manifest_json),
      );
      if (sha256Canonical(retryPolicy) !== row.retry_policy_sha256
        || sha256Canonical(manifest) !== row.immutable_input_manifest_sha256) {
        throw new Error("reservation_manifest_digest_mismatch");
      }
      for (const [field, expected] of Object.entries(manifest)) {
        if (field !== "contract_version"
          && row[field as keyof typeof row] !== expected) {
          throw new Error(`reservation_manifest_binding_mismatch:${field}`);
        }
      }
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["immutable_input_manifest_json"],
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (rowDigest(row, "reservation_sha256") !== row.reservation_sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reservation_sha256"],
        message: "Reservation row digest mismatch",
      });
    }
  },
);

export type LearningExternalRunReservationRowV1 = z.infer<
  typeof LearningExternalRunReservationRowV1Schema
>;

export function learningExternalRunReservationRowDigest(row: unknown): string {
  const parsed = LearningExternalRunReservationRowV1Schema.parse(row);
  return rowDigest(parsed, "reservation_sha256");
}

const TicketConsumptionRowBaseSchema = z.object({
  tenant_id: ExactIdSchema,
  consumption_id: ExactIdSchema,
  reservation_id: ExactIdSchema,
  runner_ticket_sha256: DigestSha256Schema,
  runner_principal_sha256: DigestSha256Schema,
  broker_process_nonce_sha256: DigestSha256Schema,
  consume_operation_id: ExactIdSchema,
  consumed_at: LearningExternalCanonicalUtcMillisSchema,
  consumption_sha256: DigestSha256Schema,
}).strict();

export const LearningExternalTicketConsumptionRowV1Schema =
  TicketConsumptionRowBaseSchema.superRefine((row, context) => {
    if (rowDigest(row, "consumption_sha256") !== row.consumption_sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["consumption_sha256"],
        message: "Ticket-consumption row digest mismatch",
      });
    }
  });

export type LearningExternalTicketConsumptionRowV1 = z.infer<
  typeof LearningExternalTicketConsumptionRowV1Schema
>;

export function learningExternalTicketConsumptionRowDigest(row: unknown): string {
  const parsed = LearningExternalTicketConsumptionRowV1Schema.parse(row);
  return rowDigest(parsed, "consumption_sha256");
}

export const LearningExternalLifecycleOperationReceiptV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_authority_operation_receipt_v1"),
  tenant_id: ExactIdSchema,
  scope: z.literal("learning_external_authority_v1"),
  operation_kind: z.enum([
    "learning_external_run_reservation_v1",
    "learning_external_ticket_consumption_v1",
    "learning_external_preclaim_hold_v1",
    "learning_external_run_claim_v1",
    "learning_external_supervisor_binding_v1",
    "learning_external_session_termination_v1",
  ]),
  operation_id: ExactIdSchema,
  actor_id: ExactIdSchema,
  request_sha256: DigestSha256Schema,
  authority_table: z.enum([
    "lite_learning_external_run_reservations",
    "lite_learning_external_ticket_consumptions",
    "lite_learning_external_preclaim_holds",
    "lite_learning_external_run_claims",
    "lite_learning_external_supervisor_bindings",
    "lite_learning_external_session_terminations",
  ]),
  authority_ref_id: ExactIdSchema,
  authority_record_sha256: DigestSha256Schema,
  broker_authorization_receipt_sha256: DigestSha256Schema.nullable(),
  broker_authorization_receipt: LearningExternalSignedReceiptEnvelopeV1Schema.nullable(),
  recorded_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((value, context) => {
  const expectedTable = {
    learning_external_run_reservation_v1: "lite_learning_external_run_reservations",
    learning_external_ticket_consumption_v1: "lite_learning_external_ticket_consumptions",
    learning_external_preclaim_hold_v1: "lite_learning_external_preclaim_holds",
    learning_external_run_claim_v1: "lite_learning_external_run_claims",
    learning_external_supervisor_binding_v1: "lite_learning_external_supervisor_bindings",
    learning_external_session_termination_v1: "lite_learning_external_session_terminations",
  } as const;
  if (value.authority_table !== expectedTable[value.operation_kind]) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authority_table"],
      message: "External lifecycle operation kind and table disagree",
    });
  }
  const needsAuthorization = value.operation_kind === "learning_external_run_reservation_v1"
    || value.operation_kind === "learning_external_ticket_consumption_v1";
  if (needsAuthorization !== (value.broker_authorization_receipt !== null)
    || needsAuthorization !== (value.broker_authorization_receipt_sha256 !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["broker_authorization_receipt"],
      message: "Reserve and consume operations alone require broker authorization",
    });
  }
  if (value.broker_authorization_receipt !== null
    && value.broker_authorization_receipt_sha256
      !== learningExternalReceiptDigest(value.broker_authorization_receipt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["broker_authorization_receipt_sha256"],
      message: "Broker authorization envelope digest mismatch",
    });
  }
});

export type LearningExternalLifecycleOperationReceiptV1 = z.infer<
  typeof LearningExternalLifecycleOperationReceiptV1Schema
>;
export const LearningExternalAuthorityOperationReceiptV1Schema =
  LearningExternalLifecycleOperationReceiptV1Schema;
export type LearningExternalAuthorityOperationReceiptV1 =
  LearningExternalLifecycleOperationReceiptV1;

const BrokerAuthorityShape = {
  broker_service_identity: z.literal(LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY),
  broker_policy_sha256: DigestSha256Schema,
  broker_binary_sha256: DigestSha256Schema,
  broker_public_key_sha256: DigestSha256Schema,
  broker_key_id: ExactIdSchema,
} as const;

const SignedEnvelopeShape = {
  signature_algorithm: z.literal("ed25519-v1"),
  signature_base64: LearningExternalEd25519SignatureBase64Schema,
} as const;

function signedEnvelopeSchema<Schema extends z.ZodTypeAny>(bodySchema: Schema) {
  return z.object({ body: bodySchema, ...SignedEnvelopeShape }).strict();
}

export const LearningExternalBrokerServiceInstanceIdentityV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_broker_service_instance_identity_v1"),
  tenant_id: ExactIdSchema,
  database_instance_id: DigestSha256Schema,
  broker_service_identity: z.literal(LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY),
  broker_uid: UnixIdentitySchema,
  broker_gid: UnixIdentitySchema,
  broker_pid: ProcessIdSchema,
  broker_process_start_identity_sha256: DigestSha256Schema,
  broker_cgroup_identity_sha256: DigestSha256Schema,
  broker_service_job_identity_sha256: DigestSha256Schema,
  broker_socket_device_identity: ExactIdSchema,
  broker_socket_inode: PositiveIntegerSchema,
}).strict();

export type LearningExternalBrokerServiceInstanceIdentityV1 = z.infer<
  typeof LearningExternalBrokerServiceInstanceIdentityV1Schema
>;

export function learningExternalBrokerServiceInstanceDigest(value: unknown): string {
  return sha256Canonical(LearningExternalBrokerServiceInstanceIdentityV1Schema.parse(value));
}

export const LearningExternalBrokerServiceLaunchReceiptBodyV1Schema = z.object({
  contract_version: z.literal(
    "aionis_learning_external_broker_service_launch_receipt_v1",
  ),
  tenant_id: ExactIdSchema,
  database_instance_id: DigestSha256Schema,
  broker_service_identity: z.literal(LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY),
  broker_service_instance_sha256: DigestSha256Schema,
  launched_broker_policy_sha256: DigestSha256Schema,
  launched_broker_binary_sha256: DigestSha256Schema,
  launched_broker_public_key_sha256: DigestSha256Schema,
  launched_broker_key_id: ExactIdSchema,
  broker_uid: UnixIdentitySchema,
  broker_gid: UnixIdentitySchema,
  broker_pid: ProcessIdSchema,
  broker_process_start_identity_sha256: DigestSha256Schema,
  broker_cgroup_identity_sha256: DigestSha256Schema,
  broker_service_job_identity_sha256: DigestSha256Schema,
  broker_socket_device_identity: ExactIdSchema,
  broker_socket_inode: PositiveIntegerSchema,
  broker_socket_identity_sha256: DigestSha256Schema,
  broker_socket_mode: z.literal(0o600),
  broker_socket_owner_uid: UnixIdentitySchema,
  broker_socket_owner_gid: UnixIdentitySchema,
  private_state_root_acl_sha256: DigestSha256Schema,
  terminal_fact_spool_acl_sha256: DigestSha256Schema,
  launcher_channel_fingerprint_sha256: DigestSha256Schema,
  service_launcher_policy_sha256: DigestSha256Schema,
  service_launcher_binary_sha256: DigestSha256Schema,
  service_launcher_public_key_sha256: DigestSha256Schema,
  service_launcher_key_id: ExactIdSchema,
  launched_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((launch, context) => {
  const expected = learningExternalBrokerServiceInstanceDigest({
    contract_version: "aionis_learning_external_broker_service_instance_identity_v1",
    tenant_id: launch.tenant_id,
    database_instance_id: launch.database_instance_id,
    broker_service_identity: launch.broker_service_identity,
    broker_uid: launch.broker_uid,
    broker_gid: launch.broker_gid,
    broker_pid: launch.broker_pid,
    broker_process_start_identity_sha256: launch.broker_process_start_identity_sha256,
    broker_cgroup_identity_sha256: launch.broker_cgroup_identity_sha256,
    broker_service_job_identity_sha256: launch.broker_service_job_identity_sha256,
    broker_socket_device_identity: launch.broker_socket_device_identity,
    broker_socket_inode: launch.broker_socket_inode,
  });
  if (launch.broker_service_instance_sha256 !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["broker_service_instance_sha256"],
      message: "Broker service-instance digest does not bind the launched process/socket identity",
    });
  }
  if (launch.broker_socket_owner_uid !== launch.broker_uid
    || launch.broker_socket_owner_gid !== launch.broker_gid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["broker_socket_owner_uid"],
      message: "Broker socket owner must be the launched broker identity",
    });
  }
});

export type LearningExternalBrokerServiceLaunchReceiptBodyV1 = z.infer<
  typeof LearningExternalBrokerServiceLaunchReceiptBodyV1Schema
>;

export const LearningExternalBrokerServiceLaunchReceiptEnvelopeV1Schema =
  signedEnvelopeSchema(LearningExternalBrokerServiceLaunchReceiptBodyV1Schema);
export type LearningExternalBrokerServiceLaunchReceiptEnvelopeV1 = z.infer<
  typeof LearningExternalBrokerServiceLaunchReceiptEnvelopeV1Schema
>;

export const LearningExternalBrokerHealthReceiptBodyV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_broker_health_receipt_v1"),
  tenant_id: ExactIdSchema,
  database_instance_id: DigestSha256Schema,
  health_id: ExactIdSchema,
  broker_service_instance_sha256: DigestSha256Schema,
  challenge_sha256: DigestSha256Schema,
  service_launch_receipt_sha256: DigestSha256Schema,
  service_launch_receipt: LearningExternalBrokerServiceLaunchReceiptEnvelopeV1Schema,
  peer_credentials_enforced: z.literal(true),
  stdin_only_runner_ticket: z.literal(true),
  runner_ticket_prefetched_before_spawn: z.literal(true),
  runner_ticket_path_input_allowed: z.literal(false),
  caller_selected_output_path_authority: z.literal(false),
  private_state_root_owner_only: z.literal(true),
  terminal_fact_spool_owner_only: z.literal(true),
  unacknowledged_startup_recovery_count: z.literal(0),
  ...BrokerAuthorityShape,
  checked_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((health, context) => {
  const launch = health.service_launch_receipt.body;
  const bindings: ReadonlyArray<readonly [unknown, unknown, string]> = [
    [health.service_launch_receipt_sha256,
      learningExternalReceiptDigest(health.service_launch_receipt),
      "service_launch_receipt_sha256"],
    [health.tenant_id, launch.tenant_id, "tenant_id"],
    [health.database_instance_id, launch.database_instance_id, "database_instance_id"],
    [health.broker_service_instance_sha256,
      launch.broker_service_instance_sha256,
      "broker_service_instance_sha256"],
    [health.broker_policy_sha256, launch.launched_broker_policy_sha256, "broker_policy_sha256"],
    [health.broker_binary_sha256, launch.launched_broker_binary_sha256, "broker_binary_sha256"],
    [health.broker_public_key_sha256,
      launch.launched_broker_public_key_sha256,
      "broker_public_key_sha256"],
    [health.broker_key_id, launch.launched_broker_key_id, "broker_key_id"],
  ];
  for (const [actual, expected, field] of bindings) {
    if (actual !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} does not match the signed service launch`,
      });
    }
  }
  if (Date.parse(health.checked_at) < Date.parse(launch.launched_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["checked_at"],
      message: "Broker health cannot precede service launch",
    });
  }
});

export type LearningExternalBrokerHealthReceiptBodyV1 = z.infer<
  typeof LearningExternalBrokerHealthReceiptBodyV1Schema
>;

export const LearningExternalBrokerHealthReceiptEnvelopeV1Schema =
  signedEnvelopeSchema(LearningExternalBrokerHealthReceiptBodyV1Schema);
export type LearningExternalBrokerHealthReceiptEnvelopeV1 = z.infer<
  typeof LearningExternalBrokerHealthReceiptEnvelopeV1Schema
>;

export const LearningExternalTerminalFactDrainEntryV1Schema = z.object({
  fact_kind: z.enum(["preclaim_hold", "session_termination"]),
  tenant_id: ExactIdSchema,
  reservation_id: ExactIdSchema,
  reservation_sha256: DigestSha256Schema,
  export_subdirectory: DigestSha256Schema,
  ticket_consumption_id: ExactIdSchema,
  broker_process_nonce_sha256: DigestSha256Schema,
  fact_id: ExactIdSchema,
  fact_sha256: DigestSha256Schema,
  signed_receipt_sha256: DigestSha256Schema,
  operation_id: ExactIdSchema,
  operation_request_sha256: DigestSha256Schema,
  authority_record_sha256: DigestSha256Schema,
  public_run_authority_payload_sha256: DigestSha256Schema,
  acknowledged_at: LearningExternalCanonicalUtcMillisSchema,
  exported_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((entry, context) => {
  if (entry.fact_sha256 !== entry.authority_record_sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authority_record_sha256"],
      message: "Drain entry authority-record digest must equal the terminal fact digest",
    });
  }
  if (entry.export_subdirectory !== entry.reservation_sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["export_subdirectory"],
      message: "Drain export directory must be the immutable reservation digest",
    });
  }
  if (Date.parse(entry.exported_at) < Date.parse(entry.acknowledged_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["exported_at"],
      message: "Drain export cannot precede acknowledgement",
    });
  }
});

export type LearningExternalTerminalFactDrainEntryV1 = z.infer<
  typeof LearningExternalTerminalFactDrainEntryV1Schema
>;

function drainEntrySortKey(entry: LearningExternalTerminalFactDrainEntryV1): string {
  return stableStringify([entry.fact_kind, entry.signed_receipt_sha256]);
}

export const LearningExternalTerminalFactDrainReceiptBodyV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_terminal_fact_drain_receipt_v1"),
  tenant_id: ExactIdSchema,
  database_instance_id: DigestSha256Schema,
  drain_id: ExactIdSchema,
  broker_service_instance_sha256: DigestSha256Schema,
  broker_health_receipt_sha256: DigestSha256Schema,
  entries: z.array(LearningExternalTerminalFactDrainEntryV1Schema)
    .min(1)
    .max(MAX_DRAIN_ENTRIES),
  ...BrokerAuthorityShape,
  drained_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((drain, context) => {
  const keys = drain.entries.map(drainEntrySortKey);
  if (new Set(keys).size !== keys.length
    || keys.some((key, index) => index > 0
      && Buffer.compare(Buffer.from(keys[index - 1]!), Buffer.from(key)) >= 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entries"],
      message: "Drain entries must be unique and canonically sorted",
    });
  }
  if (drain.entries.some((entry) => entry.tenant_id !== drain.tenant_id
    || Date.parse(entry.exported_at) > Date.parse(drain.drained_at))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entries"],
      message: "Drain entries must belong to the tenant and precede the drain time",
    });
  }
});

export type LearningExternalTerminalFactDrainReceiptBodyV1 = z.infer<
  typeof LearningExternalTerminalFactDrainReceiptBodyV1Schema
>;

export const LearningExternalTerminalFactDrainReceiptEnvelopeV1Schema =
  signedEnvelopeSchema(LearningExternalTerminalFactDrainReceiptBodyV1Schema);
export type LearningExternalTerminalFactDrainReceiptEnvelopeV1 = z.infer<
  typeof LearningExternalTerminalFactDrainReceiptEnvelopeV1Schema
>;

const HoldoutMemberRowBaseSchema = z.object({
  tenant_id: ExactIdSchema,
  reservation_id: ExactIdSchema,
  task_family: ExactIdSchema,
  case_ordinal: z.number().int().min(0).max(95),
  case_identity_sha256: DigestSha256Schema,
  task_id_sha256: DigestSha256Schema,
  content_workflow_sha256: DigestSha256Schema,
  store_scope_sha256: DigestSha256Schema,
  source_event_sha256: DigestSha256Schema,
  source_evidence_sha256: DigestSha256Schema,
  member_record_sha256: DigestSha256Schema,
  created_at: LearningExternalCanonicalUtcMillisSchema,
}).strict();

export const LearningExternalHoldoutMemberRowV1Schema =
  HoldoutMemberRowBaseSchema.superRefine((row, context) => {
    if (rowDigest(row, "member_record_sha256") !== row.member_record_sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["member_record_sha256"],
        message: "Holdout-member row digest mismatch",
      });
    }
  });

export type LearningExternalHoldoutMemberRowV1 = z.infer<
  typeof LearningExternalHoldoutMemberRowV1Schema
>;

export function learningExternalHoldoutMemberRowDigest(row: unknown): string {
  const parsed = LearningExternalHoldoutMemberRowV1Schema.parse(row);
  return rowDigest(parsed, "member_record_sha256");
}

const ReservationAuthorityComponentV1Schema = z.object({
  row: LearningExternalRunReservationRowV1Schema,
  holdout_members: z.array(LearningExternalHoldoutMemberRowV1Schema).max(96),
  operation: LearningExternalLifecycleOperationReceiptV1Schema,
}).strict().superRefine((component, context) => {
  const members = component.holdout_members;
  const reservation = component.row;
  if (reservation.artifact_kind === "offline_paired_rerun") {
    if (members.length !== 96
      || members.some((member, index) => member.case_ordinal !== index
        || member.tenant_id !== reservation.tenant_id
        || member.reservation_id !== reservation.reservation_id
        || member.task_family !== reservation.task_family
        || member.created_at !== reservation.reserved_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["holdout_members"],
        message: "Offline reservation requires the exact canonical 96-member holdout projection",
      });
      return;
    }
    const caseSet = sha256Canonical(members.map((member) => member.case_identity_sha256));
    const projection = sha256Canonical(members.map((member) => ({
      case_ordinal: member.case_ordinal,
      case_identity_sha256: member.case_identity_sha256,
      task_id_sha256: member.task_id_sha256,
      content_workflow_sha256: member.content_workflow_sha256,
      store_scope_sha256: member.store_scope_sha256,
      source_event_sha256: member.source_event_sha256,
      source_evidence_sha256: member.source_evidence_sha256,
      member_record_sha256: member.member_record_sha256,
    })));
    const executionOrder = sha256Canonical(members.map((member) => ({
      case_ordinal: member.case_ordinal,
      case_identity_sha256: member.case_identity_sha256,
    })));
    if (reservation.case_set_sha256 !== caseSet
      || reservation.holdout_membership_projection_sha256 !== projection
      || reservation.execution_order_sha256 !== executionOrder) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["holdout_members"],
        message: "Holdout members do not reconstruct the frozen reservation digests",
      });
    }
  } else if (members.length !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["holdout_members"],
      message: "Only offline paired reservations carry holdout members",
    });
  }
});

const TicketConsumptionAuthorityComponentV1Schema = z.object({
  row: LearningExternalTicketConsumptionRowV1Schema,
  operation: LearningExternalLifecycleOperationReceiptV1Schema,
}).strict();

const ClaimAuthorityComponentV1Schema = z.object({
  row: LearningExternalRunClaimRowV1Schema,
  operation: LearningExternalLifecycleOperationReceiptV1Schema,
}).strict();

const SupervisorBindingAuthorityComponentV1Schema = z.object({
  row: LearningExternalSupervisorBindingRowV1Schema,
  operation: LearningExternalLifecycleOperationReceiptV1Schema,
}).strict();

const SessionTerminationAuthorityComponentV1Schema = z.object({
  row: LearningExternalSessionTerminationRowV1Schema,
  operation: LearningExternalLifecycleOperationReceiptV1Schema,
}).strict();

export const LearningExternalPublicRunAuthorityPayloadV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_public_run_authority_payload_v1"),
  tenant_id: ExactIdSchema,
  database_instance_id: DigestSha256Schema,
  evidence_binding_sha256: DigestSha256Schema,
  artifact_kind: LearningExternalEvidenceArtifactKindSchema,
  broker_health_receipt: LearningExternalBrokerHealthReceiptEnvelopeV1Schema,
  reservation: ReservationAuthorityComponentV1Schema,
  ticket_consumption: TicketConsumptionAuthorityComponentV1Schema,
  claim: ClaimAuthorityComponentV1Schema,
  supervisor_binding: SupervisorBindingAuthorityComponentV1Schema,
  session_termination: SessionTerminationAuthorityComponentV1Schema,
  report: LearningExternalEvidenceReportV1Schema,
  attempt_chain: LearningExternalAttemptChainV1Schema,
  runner_output_manifest: LearningExternalRunnerOutputManifestV1Schema,
  terminal_run_manifest: LearningExternalTerminalRunManifestV1Schema,
  lifecycle_authority_projection: LearningExternalLifecycleAuthorityProjectionV1Schema,
  assembled_at: LearningExternalCanonicalUtcMillisSchema,
}).strict();

export type LearningExternalPublicRunAuthorityPayloadV1 = z.infer<
  typeof LearningExternalPublicRunAuthorityPayloadV1Schema
>;

export function learningExternalPublicRunAuthorityPayloadDigest(value: unknown): string {
  return sha256Canonical(LearningExternalPublicRunAuthorityPayloadV1Schema.parse(value));
}

export const LearningExternalPublicRunAuthorityV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_public_run_authority_v1"),
  payload: LearningExternalPublicRunAuthorityPayloadV1Schema,
  terminal_fact_drain_receipt: LearningExternalTerminalFactDrainReceiptEnvelopeV1Schema,
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(stableStringify(value), "utf8") > MAX_PUBLIC_RUN_AUTHORITY_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `External public-run authority exceeds ${MAX_PUBLIC_RUN_AUTHORITY_BYTES} bytes`,
    });
  }
});

export type LearningExternalPublicRunAuthorityV1 = z.infer<
  typeof LearningExternalPublicRunAuthorityV1Schema
>;

export function learningExternalPublicRunAuthorityDigest(value: unknown): string {
  return sha256Canonical(LearningExternalPublicRunAuthorityV1Schema.parse(value));
}

export function parseCanonicalLearningExternalPublicRunAuthorityJson(
  bytes: Uint8Array,
): LearningExternalPublicRunAuthorityV1 {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_PUBLIC_RUN_AUTHORITY_BYTES) {
    throw new Error("external public-run authority exceeds its canonical byte limit");
  }
  if (bytes.byteLength >= 3
    && bytes[0] === 0xef
    && bytes[1] === 0xbb
    && bytes[2] === 0xbf) {
    throw new Error("external public-run authority must not contain a UTF-8 byte-order mark");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new Error("external public-run authority must contain valid UTF-8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("external public-run authority must contain valid JSON");
  }
  if (stableStringify(raw) !== text) {
    throw new Error("external public-run authority must contain canonical JSON without duplicate keys");
  }
  const parsed = LearningExternalPublicRunAuthorityV1Schema.parse(raw);
  if (stableStringify(parsed) !== text) {
    throw new Error("external public-run authority must be schema-canonical JSON");
  }
  return parsed;
}

export type LearningExternalPublicRunAuthorityExpectedAuthorityV1 = Readonly<{
  tenant_id: string;
  database_instance_id: string;
  broker_public_key_base64: string;
  broker_policy_sha256: string;
  broker_binary_sha256: string;
  broker_key_id: string;
  service_launcher_public_key_base64: string;
  service_launcher_policy_sha256: string;
  service_launcher_binary_sha256: string;
  service_launcher_key_id: string;
}>;

export type LearningExternalValidatedPublicRunAuthorityV1 = Readonly<{
  publicRunAuthority: LearningExternalPublicRunAuthorityV1;
  payloadSha256: string;
  publicRunAuthoritySha256: string;
  canonicalByteLength: number;
}>;

function assertSame(label: string, values: readonly unknown[]): void {
  if (new Set(values).size !== 1) {
    throw new Error(`learning_external_public_authority_binding_mismatch:${label}`);
  }
}

function canonicalStoredReceiptEnvelope<TBody extends Record<string, unknown>>(args: {
  receiptJson: string;
  signatureBase64: string;
  bodySchema: z.ZodType<TBody>;
}): LearningExternalSignedReceiptEnvelopeV1<TBody> {
  let raw: unknown;
  try {
    raw = JSON.parse(args.receiptJson);
  } catch {
    throw new Error("learning_external_public_authority_receipt_json_invalid");
  }
  const body = args.bodySchema.parse(raw);
  if (stableStringify(body) !== args.receiptJson) {
    throw new Error("learning_external_public_authority_receipt_json_noncanonical");
  }
  return {
    body,
    signature_algorithm: "ed25519-v1",
    signature_base64: LearningExternalEd25519SignatureBase64Schema.parse(args.signatureBase64),
  };
}

function assertBrokerAuthority(
  body: Readonly<{
    broker_service_identity: string;
    broker_policy_sha256: string;
    broker_binary_sha256: string;
    broker_public_key_sha256: string;
    broker_key_id: string;
  }>,
  expected: LearningExternalPublicRunAuthorityExpectedAuthorityV1,
): void {
  assertSame("broker_service_identity", [
    body.broker_service_identity,
    LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY,
  ]);
  assertSame("broker_policy_sha256", [body.broker_policy_sha256, expected.broker_policy_sha256]);
  assertSame("broker_binary_sha256", [body.broker_binary_sha256, expected.broker_binary_sha256]);
  assertSame("broker_public_key_sha256", [
    body.broker_public_key_sha256,
    learningExternalEd25519PublicKeyDigest(expected.broker_public_key_base64),
  ]);
  assertSame("broker_key_id", [body.broker_key_id, expected.broker_key_id]);
}

function assertOperation(args: {
  operation: LearningExternalLifecycleOperationReceiptV1;
  tenantId: string;
  operationKind: LearningExternalLifecycleOperationReceiptV1["operation_kind"];
  operationId: string;
  authorityTable: LearningExternalLifecycleOperationReceiptV1["authority_table"];
  authorityRefId: string;
  authorityRecordSha256: string;
  recordedAt: string;
}): void {
  assertSame(`${args.operationKind}:tenant_id`, [args.operation.tenant_id, args.tenantId]);
  assertSame(`${args.operationKind}:operation_kind`, [args.operation.operation_kind, args.operationKind]);
  assertSame(`${args.operationKind}:operation_id`, [args.operation.operation_id, args.operationId]);
  assertSame(`${args.operationKind}:authority_table`, [args.operation.authority_table, args.authorityTable]);
  assertSame(`${args.operationKind}:authority_ref_id`, [args.operation.authority_ref_id, args.authorityRefId]);
  assertSame(`${args.operationKind}:authority_record_sha256`, [
    args.operation.authority_record_sha256,
    args.authorityRecordSha256,
  ]);
  assertSame(`${args.operationKind}:recorded_at`, [args.operation.recorded_at, args.recordedAt]);
}

function assertProjectionFact(args: {
  projection: Readonly<{
    authority_table: string;
    fact_id: string;
    fact_sha256: string;
    protected_operation: Readonly<{
      scope: string;
      operation_kind: string;
      operation_id: string;
      operation_request_sha256: string;
      authority_record_sha256: string;
    }>;
  }>;
  operation: LearningExternalLifecycleOperationReceiptV1;
  authorityTable: string;
  factId: string;
  factSha256: string;
}): void {
  assertSame(`${args.authorityTable}:projection_table`, [
    args.projection.authority_table,
    args.authorityTable,
  ]);
  assertSame(`${args.authorityTable}:projection_fact_id`, [args.projection.fact_id, args.factId]);
  assertSame(`${args.authorityTable}:projection_fact_sha256`, [
    args.projection.fact_sha256,
    args.factSha256,
  ]);
  assertSame(`${args.authorityTable}:projection_operation_scope`, [
    args.projection.protected_operation.scope,
    args.operation.scope,
  ]);
  assertSame(`${args.authorityTable}:projection_operation_kind`, [
    args.projection.protected_operation.operation_kind,
    args.operation.operation_kind,
  ]);
  assertSame(`${args.authorityTable}:projection_operation_id`, [
    args.projection.protected_operation.operation_id,
    args.operation.operation_id,
  ]);
  assertSame(`${args.authorityTable}:projection_operation_request_sha256`, [
    args.projection.protected_operation.operation_request_sha256,
    args.operation.request_sha256,
  ]);
  assertSame(`${args.authorityTable}:projection_authority_record_sha256`, [
    args.projection.protected_operation.authority_record_sha256,
    args.operation.authority_record_sha256,
  ]);
}

export function validateLearningExternalPublicRunAuthorityV1(args: Readonly<{
  publicRunAuthority: unknown;
  expected: LearningExternalPublicRunAuthorityExpectedAuthorityV1;
}>): LearningExternalValidatedPublicRunAuthorityV1 {
  const expected = args.expected;
  const publicRunAuthority = LearningExternalPublicRunAuthorityV1Schema.parse(
    args.publicRunAuthority,
  );
  const payload = publicRunAuthority.payload;
  const healthEnvelope = payload.broker_health_receipt;
  const health = verifyLearningExternalReceiptWithExplicitSigner({
    bodySchema: LearningExternalBrokerHealthReceiptBodyV1Schema,
    envelope: healthEnvelope,
    expectedPublicKeyBase64: expected.broker_public_key_base64,
    expectedPublicKeySha256: healthEnvelope.body.broker_public_key_sha256,
  }).body;
  const serviceLaunchEnvelope = health.service_launch_receipt;
  const serviceLaunch = verifyLearningExternalReceiptWithExplicitSigner({
    bodySchema: LearningExternalBrokerServiceLaunchReceiptBodyV1Schema,
    envelope: serviceLaunchEnvelope,
    expectedPublicKeyBase64: expected.service_launcher_public_key_base64,
    expectedPublicKeySha256: serviceLaunchEnvelope.body.service_launcher_public_key_sha256,
  }).body;
  const drainEnvelope = publicRunAuthority.terminal_fact_drain_receipt;
  const drain = verifyLearningExternalReceiptWithExplicitSigner({
    bodySchema: LearningExternalTerminalFactDrainReceiptBodyV1Schema,
    envelope: drainEnvelope,
    expectedPublicKeyBase64: expected.broker_public_key_base64,
    expectedPublicKeySha256: drainEnvelope.body.broker_public_key_sha256,
  }).body;

  assertBrokerAuthority(health, expected);
  assertBrokerAuthority(drain, expected);
  assertSame("tenant_id", [
    payload.tenant_id,
    expected.tenant_id,
    health.tenant_id,
    serviceLaunch.tenant_id,
    drain.tenant_id,
  ]);
  assertSame("database_instance_id", [
    payload.database_instance_id,
    expected.database_instance_id,
    health.database_instance_id,
    serviceLaunch.database_instance_id,
    drain.database_instance_id,
  ]);
  assertSame("service_launcher_policy_sha256", [
    serviceLaunch.service_launcher_policy_sha256,
    expected.service_launcher_policy_sha256,
  ]);
  assertSame("service_launcher_binary_sha256", [
    serviceLaunch.service_launcher_binary_sha256,
    expected.service_launcher_binary_sha256,
  ]);
  assertSame("service_launcher_public_key_sha256", [
    serviceLaunch.service_launcher_public_key_sha256,
    learningExternalEd25519PublicKeyDigest(expected.service_launcher_public_key_base64),
  ]);
  assertSame("service_launcher_key_id", [
    serviceLaunch.service_launcher_key_id,
    expected.service_launcher_key_id,
  ]);
  assertSame("launched_broker_policy_sha256", [
    serviceLaunch.launched_broker_policy_sha256,
    expected.broker_policy_sha256,
  ]);
  assertSame("launched_broker_binary_sha256", [
    serviceLaunch.launched_broker_binary_sha256,
    expected.broker_binary_sha256,
  ]);
  assertSame("launched_broker_public_key_sha256", [
    serviceLaunch.launched_broker_public_key_sha256,
    learningExternalEd25519PublicKeyDigest(expected.broker_public_key_base64),
  ]);
  assertSame("launched_broker_key_id", [serviceLaunch.launched_broker_key_id, expected.broker_key_id]);
  assertSame("broker_service_instance_sha256", [
    serviceLaunch.broker_service_instance_sha256,
    health.broker_service_instance_sha256,
    drain.broker_service_instance_sha256,
  ]);
  assertSame("broker_health_receipt_sha256", [
    drain.broker_health_receipt_sha256,
    learningExternalReceiptDigest(healthEnvelope),
  ]);

  const reservation = payload.reservation.row;
  const reservationOperation = payload.reservation.operation;
  const consumption = payload.ticket_consumption.row;
  const consumptionOperation = payload.ticket_consumption.operation;
  const claim = payload.claim.row;
  const claimOperation = payload.claim.operation;
  const binding = payload.supervisor_binding.row;
  const bindingOperation = payload.supervisor_binding.operation;
  const termination = payload.session_termination.row;
  const terminationOperation = payload.session_termination.operation;

  assertOperation({
    operation: reservationOperation,
    tenantId: reservation.tenant_id,
    operationKind: "learning_external_run_reservation_v1",
    operationId: reservation.reserve_operation_id,
    authorityTable: "lite_learning_external_run_reservations",
    authorityRefId: reservation.reservation_id,
    authorityRecordSha256: reservation.reservation_sha256,
    recordedAt: reservation.reserved_at,
  });
  assertOperation({
    operation: consumptionOperation,
    tenantId: consumption.tenant_id,
    operationKind: "learning_external_ticket_consumption_v1",
    operationId: consumption.consume_operation_id,
    authorityTable: "lite_learning_external_ticket_consumptions",
    authorityRefId: consumption.consumption_id,
    authorityRecordSha256: consumption.consumption_sha256,
    recordedAt: consumption.consumed_at,
  });
  assertOperation({
    operation: claimOperation,
    tenantId: claim.tenant_id,
    operationKind: "learning_external_run_claim_v1",
    operationId: claim.claim_operation_id,
    authorityTable: "lite_learning_external_run_claims",
    authorityRefId: claim.claim_id,
    authorityRecordSha256: claim.claim_sha256,
    recordedAt: claim.claimed_at,
  });
  assertOperation({
    operation: bindingOperation,
    tenantId: binding.tenant_id,
    operationKind: "learning_external_supervisor_binding_v1",
    operationId: binding.bind_operation_id,
    authorityTable: "lite_learning_external_supervisor_bindings",
    authorityRefId: binding.binding_id,
    authorityRecordSha256: binding.binding_sha256,
    recordedAt: binding.bound_at,
  });
  assertOperation({
    operation: terminationOperation,
    tenantId: termination.tenant_id,
    operationKind: "learning_external_session_termination_v1",
    operationId: termination.terminate_operation_id,
    authorityTable: "lite_learning_external_session_terminations",
    authorityRefId: termination.termination_id,
    authorityRecordSha256: termination.termination_sha256,
    recordedAt: termination.terminated_at,
  });

  const reservationAuthorization = LearningExternalRunReservationAuthorizationReceiptEnvelopeV1Schema.parse(
    reservationOperation.broker_authorization_receipt,
  );
  const verifiedReservationAuthorization = verifyLearningExternalReceiptWithExplicitSigner({
    bodySchema: LearningExternalRunReservationAuthorizationReceiptBodyV1Schema,
    envelope: reservationAuthorization,
    expectedPublicKeyBase64: expected.broker_public_key_base64,
    expectedPublicKeySha256: reservationAuthorization.body.broker_public_key_sha256,
  });
  const consumptionAuthorization = LearningExternalTicketConsumptionAuthorizationReceiptEnvelopeV1Schema.parse(
    consumptionOperation.broker_authorization_receipt,
  );
  const verifiedConsumptionAuthorization = verifyLearningExternalReceiptWithExplicitSigner({
    bodySchema: LearningExternalTicketConsumptionAuthorizationReceiptBodyV1Schema,
    envelope: consumptionAuthorization,
    expectedPublicKeyBase64: expected.broker_public_key_base64,
    expectedPublicKeySha256: consumptionAuthorization.body.broker_public_key_sha256,
  });
  assertBrokerAuthority(verifiedReservationAuthorization.body, expected);
  assertBrokerAuthority(verifiedConsumptionAuthorization.body, expected);
  assertSame("reservation_authorization", [
    verifiedReservationAuthorization.body.tenant_id,
    reservation.tenant_id,
  ]);
  assertSame("reservation_authorization_database", [
    verifiedReservationAuthorization.body.database_instance_id,
    payload.database_instance_id,
  ]);
  assertSame("reservation_authorization_id", [
    verifiedReservationAuthorization.body.reservation_id,
    reservation.reservation_id,
  ]);
  assertSame("reservation_authorization_record", [
    verifiedReservationAuthorization.body.reservation_sha256,
    reservation.reservation_sha256,
  ]);
  assertSame("reservation_authorization_operation", [
    verifiedReservationAuthorization.body.reserve_operation_id,
    reservation.reserve_operation_id,
  ]);
  assertSame("reservation_authorization_ticket", [
    verifiedReservationAuthorization.body.runner_ticket_sha256,
    reservation.runner_ticket_sha256,
  ]);
  const expectedExternalRole = reservation.artifact_kind === "offline_paired_rerun"
    ? "offline_paired"
    : reservation.artifact_kind === "production_shadow_gate"
      ? "production_shadow"
      : "tool_e2e";
  for (const [label, values] of [
    ["reservation_authorization_artifact_kind", [
      verifiedReservationAuthorization.body.artifact_kind,
      reservation.artifact_kind,
    ]],
    ["reservation_authorization_evidence_series_id", [
      verifiedReservationAuthorization.body.evidence_series_id,
      reservation.evidence_series_id,
    ]],
    ["reservation_authorization_external_role", [
      verifiedReservationAuthorization.body.external_role,
      expectedExternalRole,
    ]],
    ["reservation_authorization_experiment_id", [
      verifiedReservationAuthorization.body.applicable_experiment_id,
      reservation.applicable_experiment_id,
    ]],
    ["reservation_authorization_experiment_revision", [
      verifiedReservationAuthorization.body.applicable_experiment_revision,
      reservation.applicable_experiment_revision,
    ]],
    ["reservation_authorization_run_id", [
      verifiedReservationAuthorization.body.run_id,
      reservation.run_id,
    ]],
    ["reservation_authorization_principal", [
      verifiedReservationAuthorization.body.expected_runner_principal_sha256,
      reservation.expected_runner_principal_sha256,
    ]],
  ] as const) {
    assertSame(label, values);
  }
  const reservationAuthorityRequestSha256 = sha256Canonical({
    contract_version: "aionis_learning_external_reservation_authority_request_v1",
    reservation,
    holdout_member_sha256s: payload.reservation.holdout_members
      .map((member) => member.member_record_sha256),
    runner_ticket_sha256: reservation.runner_ticket_sha256,
  });
  assertSame("reservation_authority_request_sha256", [
    verifiedReservationAuthorization.body.authority_request_sha256,
    reservationAuthorityRequestSha256,
  ]);
  assertSame("reservation_operation_request_sha256", [
    reservationOperation.request_sha256,
    sha256Canonical({
      contract_version: "aionis_learning_external_reservation_request_v1",
      authority_request_sha256: reservationAuthorityRequestSha256,
      broker_authorization_receipt: reservationAuthorization,
    }),
  ]);
  assertSame("reservation_authorization_time", [
    verifiedReservationAuthorization.body.authorized_at,
    reservation.reserved_at,
    reservationOperation.recorded_at,
  ]);
  assertSame("reservation_operation_actor", [
    reservationOperation.actor_id,
    learningExternalBrokerServiceActorId(verifiedReservationAuthorization.body),
  ]);
  assertSame("consumption_authorization_id", [
    verifiedConsumptionAuthorization.body.consumption_id,
    consumption.consumption_id,
  ]);
  assertSame("consumption_authorization_reservation", [
    verifiedConsumptionAuthorization.body.reservation_id,
    reservation.reservation_id,
    consumption.reservation_id,
  ]);
  assertSame("consumption_authorization_database", [
    verifiedConsumptionAuthorization.body.database_instance_id,
    payload.database_instance_id,
  ]);
  assertSame("consumption_authorization_record", [
    verifiedConsumptionAuthorization.body.consumption_sha256,
    consumption.consumption_sha256,
  ]);
  assertSame("consumption_authorization_operation", [
    verifiedConsumptionAuthorization.body.consume_operation_id,
    consumption.consume_operation_id,
  ]);
  assertSame("consumption_authorization_ticket", [
    verifiedConsumptionAuthorization.body.runner_ticket_sha256,
    reservation.runner_ticket_sha256,
    consumption.runner_ticket_sha256,
  ]);
  assertSame("consumption_authorization_principal", [
    verifiedConsumptionAuthorization.body.runner_principal_sha256,
    reservation.expected_runner_principal_sha256,
    consumption.runner_principal_sha256,
  ]);
  assertSame("consumption_authorization_nonce", [
    verifiedConsumptionAuthorization.body.broker_process_nonce_sha256,
    consumption.broker_process_nonce_sha256,
  ]);
  for (const [label, values] of [
    ["consumption_authorization_artifact_kind", [
      verifiedConsumptionAuthorization.body.artifact_kind,
      reservation.artifact_kind,
    ]],
    ["consumption_authorization_evidence_series_id", [
      verifiedConsumptionAuthorization.body.evidence_series_id,
      reservation.evidence_series_id,
    ]],
    ["consumption_authorization_external_role", [
      verifiedConsumptionAuthorization.body.external_role,
      expectedExternalRole,
    ]],
    ["consumption_authorization_experiment_id", [
      verifiedConsumptionAuthorization.body.applicable_experiment_id,
      reservation.applicable_experiment_id,
    ]],
    ["consumption_authorization_experiment_revision", [
      verifiedConsumptionAuthorization.body.applicable_experiment_revision,
      reservation.applicable_experiment_revision,
    ]],
    ["consumption_authorization_run_id", [
      verifiedConsumptionAuthorization.body.run_id,
      reservation.run_id,
    ]],
  ] as const) {
    assertSame(label, values);
  }
  const consumptionAuthorityRequestSha256 = sha256Canonical({
    contract_version: "aionis_learning_external_ticket_consumption_authority_request_v1",
    consumption,
    reservation_sha256: reservation.reservation_sha256,
    runner_ticket_sha256: reservation.runner_ticket_sha256,
  });
  assertSame("consumption_authority_request_sha256", [
    verifiedConsumptionAuthorization.body.authority_request_sha256,
    consumptionAuthorityRequestSha256,
  ]);
  assertSame("consumption_operation_request_sha256", [
    consumptionOperation.request_sha256,
    sha256Canonical({
      contract_version: "aionis_learning_external_ticket_consumption_request_v1",
      authority_request_sha256: consumptionAuthorityRequestSha256,
      broker_authorization_receipt: consumptionAuthorization,
    }),
  ]);
  assertSame("consumption_authorization_time", [
    verifiedConsumptionAuthorization.body.authorized_at,
    consumption.consumed_at,
    consumptionOperation.recorded_at,
  ]);
  assertSame("consumption_operation_actor", [
    consumptionOperation.actor_id,
    learningExternalBrokerServiceActorId(verifiedConsumptionAuthorization.body),
  ]);

  const claimEnvelope = canonicalStoredReceiptEnvelope({
    receiptJson: claim.credential_broker_receipt_json,
    signatureBase64: claim.credential_broker_receipt_signature,
    bodySchema: LearningExternalClaimReceiptBodyV1Schema,
  });
  const verifiedClaim = verifyLearningExternalReceiptWithExplicitSigner({
    bodySchema: LearningExternalClaimReceiptBodyV1Schema,
    envelope: claimEnvelope,
    expectedPublicKeyBase64: expected.broker_public_key_base64,
    expectedPublicKeySha256: claimEnvelope.body.broker_public_key_sha256,
  });
  const bindingEnvelope = canonicalStoredReceiptEnvelope({
    receiptJson: binding.broker_binding_receipt_json,
    signatureBase64: binding.broker_binding_receipt_signature,
    bodySchema: LearningExternalBrokerSupervisorBindingReceiptBodyV1Schema,
  });
  const verifiedBinding = verifyLearningExternalReceiptWithExplicitSigner({
    bodySchema: LearningExternalBrokerSupervisorBindingReceiptBodyV1Schema,
    envelope: bindingEnvelope,
    expectedPublicKeyBase64: expected.broker_public_key_base64,
    expectedPublicKeySha256: bindingEnvelope.body.broker_public_key_sha256,
  });
  verifyLearningExternalReceiptWithExplicitSigner({
    bodySchema: LearningExternalLauncherSpawnReceiptBodyV1Schema,
    envelope: verifiedBinding.body.service_launcher_receipt,
    expectedPublicKeyBase64: expected.service_launcher_public_key_base64,
    expectedPublicKeySha256: verifiedBinding.body.service_launcher_public_key_sha256,
  });
  const terminationEnvelope = canonicalStoredReceiptEnvelope({
    receiptJson: termination.broker_terminal_receipt_json,
    signatureBase64: termination.broker_terminal_receipt_signature,
    bodySchema: LearningExternalSessionTerminationReceiptBodyV1Schema,
  });
  const verifiedTermination = verifyLearningExternalReceiptWithExplicitSigner({
    bodySchema: LearningExternalSessionTerminationReceiptBodyV1Schema,
    envelope: terminationEnvelope,
    expectedPublicKeyBase64: expected.broker_public_key_base64,
    expectedPublicKeySha256: terminationEnvelope.body.broker_public_key_sha256,
  });
  if (verifiedTermination.body.broker_quiesce_receipt === null) {
    throw new Error("learning_external_public_authority_normal_result_requires_quiesce");
  }
  verifyLearningExternalReceiptWithExplicitSigner({
    bodySchema: LearningExternalCleanQuiesceReceiptBodyV1Schema,
    envelope: verifiedTermination.body.broker_quiesce_receipt,
    expectedPublicKeyBase64: expected.broker_public_key_base64,
    expectedPublicKeySha256: verifiedTermination.body.broker_public_key_sha256,
  });
  assertBrokerAuthority(verifiedClaim.body, expected);
  assertBrokerAuthority(verifiedBinding.body, expected);
  assertBrokerAuthority(verifiedTermination.body, expected);
  assertSame("reservation_broker_policy", [
    reservation.credential_broker_policy_sha256,
    expected.broker_policy_sha256,
  ]);
  assertSame("reservation_launcher_policy", [
    reservation.service_launcher_policy_sha256,
    verifiedBinding.body.service_launcher_policy_sha256,
    expected.service_launcher_policy_sha256,
  ]);
  assertSame("reservation_launcher_binary", [
    reservation.service_launcher_binary_sha256,
    verifiedBinding.body.service_launcher_binary_sha256,
    expected.service_launcher_binary_sha256,
  ]);
  assertSame("reservation_launcher_key_id", [
    reservation.service_launcher_key_id,
    verifiedBinding.body.service_launcher_key_id,
    expected.service_launcher_key_id,
  ]);
  assertSame("binding_launcher_public_key", [
    verifiedBinding.body.service_launcher_public_key_sha256,
    learningExternalEd25519PublicKeyDigest(expected.service_launcher_public_key_base64),
  ]);
  assertSame("claim_runner_ticket", [
    verifiedClaim.body.runner_ticket_sha256,
    reservation.runner_ticket_sha256,
  ]);
  assertSame("claim_ticket_consumption_record", [
    verifiedClaim.body.ticket_consumption_sha256,
    consumption.consumption_sha256,
  ]);
  assertSame("claim_runner_principal", [
    verifiedClaim.body.runner_principal_sha256,
    reservation.expected_runner_principal_sha256,
    consumption.runner_principal_sha256,
  ]);
  assertSame("claim_credential_session_class", [
    verifiedClaim.body.credential_session_class,
    reservation.credential_session_class,
  ]);
  assertSame("binding_supervisor_executable", [
    verifiedBinding.body.supervisor_executable_sha256,
    reservation.supervisor_executable_sha256,
  ]);
  assertSame("binding_supervisor_argv_policy", [
    verifiedBinding.body.supervisor_argv_policy_sha256,
    reservation.supervisor_argv_policy_sha256,
  ]);
  assertSame("binding_supervisor_sandbox", [
    verifiedBinding.body.supervisor_sandbox_policy_sha256,
    reservation.supervisor_sandbox_policy_sha256,
  ]);
  assertSame("claim_operation_request_sha256", [
    claimOperation.request_sha256,
    sha256Canonical({
      contract_version: "aionis_learning_external_claim_request_v1",
      receipt: claimEnvelope,
    }),
  ]);
  assertSame("binding_operation_request_sha256", [
    bindingOperation.request_sha256,
    sha256Canonical({
      contract_version: "aionis_learning_external_supervisor_binding_request_v1",
      receipt: bindingEnvelope,
    }),
  ]);
  assertSame("termination_operation_request_sha256", [
    terminationOperation.request_sha256,
    sha256Canonical({
      contract_version: "aionis_learning_external_session_termination_request_v1",
      receipt: terminationEnvelope,
    }),
  ]);
  assertSame("claim_operation_actor", [
    claimOperation.actor_id,
    learningExternalBrokerServiceActorId(verifiedClaim.body),
  ]);
  assertSame("binding_operation_actor", [
    bindingOperation.actor_id,
    learningExternalBrokerServiceActorId(verifiedBinding.body),
  ]);
  assertSame("termination_operation_actor", [
    terminationOperation.actor_id,
    learningExternalBrokerServiceActorId(verifiedTermination.body),
  ]);
  if (!["passed", "failed", "inconclusive"].includes(termination.termination_reason)) {
    throw new Error("learning_external_public_authority_requires_normal_result");
  }
  assertSame("lifecycle_reservation_chain", [
    claim.reservation_id,
    reservation.reservation_id,
    binding.reservation_id,
    termination.reservation_id,
  ]);
  assertSame("lifecycle_consumption_chain", [
    claim.ticket_consumption_id,
    consumption.consumption_id,
    binding.ticket_consumption_id,
    termination.ticket_consumption_id,
  ]);
  assertSame("binding_chain_claim", [binding.claim_id, claim.claim_id]);
  assertSame("termination_chain_claim", [termination.claim_id, claim.claim_id]);
  assertSame("termination_chain_binding", [termination.supervisor_binding_id, binding.binding_id]);
  assertSame("claim_row_digest", [learningExternalRunClaimRowDigest(claim), claim.claim_sha256]);
  assertSame("binding_row_digest", [
    learningExternalSupervisorBindingRowDigest(binding),
    binding.binding_sha256,
  ]);
  assertSame("termination_row_digest", [
    learningExternalSessionTerminationRowDigest(termination),
    termination.termination_sha256,
  ]);

  const report = payload.report;
  const attemptChain = payload.attempt_chain;
  const runner = payload.runner_output_manifest;
  const terminal = payload.terminal_run_manifest;
  const projection = payload.lifecycle_authority_projection;
  const reportSha256 = learningExternalEvidenceReportDigest(report);
  const attemptChainSha256 = learningExternalAttemptChainDigest(attemptChain);
  const runnerSha256 = learningExternalRunnerOutputManifestDigest(runner);
  const terminalSha256 = learningExternalTerminalRunManifestDigest(terminal);
  const preterminalPayloadSetSha256 = learningExternalPreterminalPayloadSetDigest({
    contract_version: "aionis_learning_external_preterminal_payload_set_v1",
    evidence_binding_sha256: report.evidence_binding_sha256,
    report_sha256: reportSha256,
    attempt_chain_sha256: attemptChainSha256,
    source_bundle_sha256: report.source_bundle_sha256,
    harness_bundle_sha256: report.harness_bundle_sha256,
  });
  learningExternalEvidenceLifecycleAuthorityProjectionDigest(projection);
  assertSame("lifecycle_row_tenant_id", [
    payload.tenant_id,
    reservation.tenant_id,
    consumption.tenant_id,
    claim.tenant_id,
    binding.tenant_id,
    termination.tenant_id,
  ]);
  for (const [label, values] of [
    ["report_tenant_id", [report.tenant_id, payload.tenant_id]],
    ["report_database_instance_id", [report.database_instance_id, payload.database_instance_id]],
    ["report_evidence_series_id", [report.evidence_series_id, reservation.evidence_series_id]],
    ["report_task_family", [report.task_family, reservation.task_family]],
    ["report_applicable_experiment_id", [
      report.applicable_experiment_id,
      reservation.applicable_experiment_id,
    ]],
    ["report_applicable_experiment_revision", [
      report.applicable_experiment_revision,
      reservation.applicable_experiment_revision,
    ]],
    ["report_candidate_policy_id", [report.candidate_policy_id, reservation.candidate_policy_id]],
    ["report_candidate_policy_version", [
      report.candidate_policy_version,
      reservation.candidate_policy_version,
    ]],
    ["report_candidate_policy_implementation_sha256", [
      report.candidate_policy_implementation_sha256,
      reservation.candidate_policy_implementation_sha256,
    ]],
    ["report_candidate_policy_config_sha256", [
      report.candidate_policy_config_sha256,
      reservation.candidate_policy_config_sha256,
    ]],
    ["report_gate_policy_id", [report.gate_policy_id, reservation.gate_policy_id]],
    ["report_gate_policy_version", [report.gate_policy_version, reservation.gate_policy_version]],
    ["report_gate_policy_config_sha256", [
      report.gate_policy_config_sha256,
      reservation.gate_policy_config_sha256,
    ]],
    ["report_applicability_manifest_sha256", [
      report.applicability_manifest_sha256,
      reservation.applicability_manifest_sha256,
    ]],
    ["report_immutable_input_manifest_sha256", [
      report.immutable_input_manifest_sha256,
      reservation.immutable_input_manifest_sha256,
    ]],
    ["report_retry_policy_sha256", [report.retry_policy_sha256, reservation.retry_policy_sha256]],
    ["report_source_snapshot_sha256", [
      report.source_snapshot_sha256,
      reservation.source_snapshot_sha256,
    ]],
    ["report_run_id", [report.run_id, reservation.run_id]],
  ] as const) {
    assertSame(label, values);
  }
  assertSame("evidence_binding_sha256", [
    payload.evidence_binding_sha256,
    report.evidence_binding_sha256,
    attemptChain.evidence_binding_sha256,
    runner.evidence_binding_sha256,
    terminal.evidence_binding_sha256,
    projection.evidence_binding_sha256,
  ]);
  assertSame("artifact_kind", [
    payload.artifact_kind,
    reservation.artifact_kind,
    report.artifact_kind,
    runner.artifact_kind,
    terminal.artifact_kind,
    projection.artifact_kind,
  ]);
  assertSame("artifact_status", [
    report.artifact_status,
    runner.artifact_status,
    terminal.artifact_status,
    termination.termination_reason,
    projection.session_termination.termination_reason,
  ]);
  assertSame("report_sha256", [reportSha256, runner.report_sha256, terminal.report_sha256]);
  assertSame("attempt_chain_sha256", [
    attemptChainSha256,
    runner.attempt_chain_sha256,
    terminal.attempt_chain_sha256,
    termination.attempt_chain_sha256,
    projection.session_termination.attempt_chain_sha256,
  ]);
  assertSame("runner_output_manifest_sha256", [
    runnerSha256,
    terminal.runner_output_manifest_sha256,
    termination.runner_output_manifest_sha256,
    projection.session_termination.runner_output_manifest_sha256,
  ]);
  assertSame("terminal_run_manifest_sha256", [
    terminalSha256,
    termination.terminal_run_manifest_sha256,
    projection.session_termination.terminal_run_manifest_sha256,
  ]);
  for (const [idLabel, values] of [
    ["reservation_id", [reservation.reservation_id, attemptChain.reservation_id,
      runner.reservation_id, terminal.reservation_id]],
    ["ticket_consumption_id", [consumption.consumption_id, attemptChain.ticket_consumption_id,
      runner.ticket_consumption_id, terminal.ticket_consumption_id]],
    ["claim_id", [claim.claim_id, attemptChain.claim_id, runner.claim_id, terminal.claim_id]],
    ["supervisor_binding_id", [binding.binding_id, attemptChain.supervisor_binding_id,
      runner.supervisor_binding_id, terminal.supervisor_binding_id]],
  ] as const) {
    assertSame(idLabel, values);
  }
  assertSame("source_bundle_sha256", [
    report.source_bundle_sha256,
    runner.source_bundle_sha256,
    terminal.source_bundle_sha256,
  ]);
  assertSame("preterminal_payload_set_sha256", [
    preterminalPayloadSetSha256,
    runner.preterminal_payload_set_sha256,
    terminal.preterminal_payload_set_sha256,
  ]);
  assertSame("harness_bundle_sha256", [
    report.harness_bundle_sha256,
    runner.harness_bundle_sha256,
    terminal.harness_bundle_sha256,
    reservation.harness_bundle_sha256,
  ]);
  assertSame("source_ref", [runner.source_ref, terminal.source_ref]);
  assertSame("source_commit_id", [runner.source_commit_id, terminal.source_commit_id]);
  assertSame("projection_tenant", [projection.tenant_id, payload.tenant_id]);
  assertSame("projection_database", [projection.database_instance_id, payload.database_instance_id]);
  assertSame("projection_launcher_receipt", [
    projection.service_launcher_receipt_sha256,
    binding.service_launcher_receipt_sha256,
  ]);
  assertProjectionFact({
    projection: projection.reservation,
    operation: reservationOperation,
    authorityTable: "lite_learning_external_run_reservations",
    factId: reservation.reservation_id,
    factSha256: reservation.reservation_sha256,
  });
  assertProjectionFact({
    projection: projection.ticket_consumption,
    operation: consumptionOperation,
    authorityTable: "lite_learning_external_ticket_consumptions",
    factId: consumption.consumption_id,
    factSha256: consumption.consumption_sha256,
  });
  assertProjectionFact({
    projection: projection.claim,
    operation: claimOperation,
    authorityTable: "lite_learning_external_run_claims",
    factId: claim.claim_id,
    factSha256: claim.claim_sha256,
  });
  assertProjectionFact({
    projection: projection.supervisor_binding,
    operation: bindingOperation,
    authorityTable: "lite_learning_external_supervisor_bindings",
    factId: binding.binding_id,
    factSha256: binding.binding_sha256,
  });
  assertProjectionFact({
    projection: projection.session_termination,
    operation: terminationOperation,
    authorityTable: "lite_learning_external_session_terminations",
    factId: termination.termination_id,
    factSha256: termination.termination_sha256,
  });
  assertSame("projection_terminal_receipt", [
    projection.session_termination.broker_terminal_receipt_sha256,
    termination.broker_terminal_receipt_sha256,
  ]);
  assertSame("projection_quiesce_receipt", [
    projection.session_termination.broker_quiesce_receipt_sha256,
    termination.broker_quiesce_receipt_sha256,
  ]);
  const lastAttempt = attemptChain.attempts.at(-1);
  if ((lastAttempt !== undefined && lastAttempt.finished_at > attemptChain.sealed_at)
    || attemptChain.sealed_at > report.collected_at
    || report.collected_at !== runner.collected_at
    || runner.collected_at > terminal.finalized_at
    || terminal.finalized_at > termination.terminated_at
    || reservation.reserved_at > consumption.consumed_at
    || consumption.consumed_at > claim.claimed_at
    || claim.claimed_at > binding.bound_at
    || binding.bound_at > termination.terminated_at) {
    throw new Error("learning_external_public_authority_binding_mismatch:evidence_time_order");
  }

  const payloadSha256 = learningExternalPublicRunAuthorityPayloadDigest(payload);
  const matchingDrainEntries = drain.entries.filter((entry) =>
    entry.fact_kind === "session_termination"
      && entry.fact_id === termination.termination_id
      && entry.signed_receipt_sha256 === termination.broker_terminal_receipt_sha256);
  if (matchingDrainEntries.length !== 1) {
    throw new Error("learning_external_public_authority_terminal_drain_entry_missing");
  }
  const terminalDrainEntry = matchingDrainEntries[0]!;
  assertSame("drain_reservation_id", [terminalDrainEntry.reservation_id, reservation.reservation_id]);
  assertSame("drain_reservation_sha256", [
    terminalDrainEntry.reservation_sha256,
    reservation.reservation_sha256,
  ]);
  assertSame("drain_ticket_consumption_id", [
    terminalDrainEntry.ticket_consumption_id,
    consumption.consumption_id,
  ]);
  assertSame("drain_broker_process_nonce", [
    terminalDrainEntry.broker_process_nonce_sha256,
    consumption.broker_process_nonce_sha256,
  ]);
  assertSame("drain_fact_sha256", [terminalDrainEntry.fact_sha256, termination.termination_sha256]);
  assertSame("drain_operation_id", [terminalDrainEntry.operation_id, terminationOperation.operation_id]);
  assertSame("drain_operation_request_sha256", [
    terminalDrainEntry.operation_request_sha256,
    terminationOperation.request_sha256,
  ]);
  assertSame("drain_public_payload_sha256", [
    terminalDrainEntry.public_run_authority_payload_sha256,
    payloadSha256,
  ]);
  if (Date.parse(health.checked_at) > Date.parse(consumption.consumed_at)
    || Date.parse(payload.assembled_at) < Date.parse(termination.terminated_at)
    || Date.parse(terminalDrainEntry.acknowledged_at) < Date.parse(payload.assembled_at)
    || Date.parse(terminalDrainEntry.exported_at) < Date.parse(terminalDrainEntry.acknowledged_at)
    || Date.parse(drain.drained_at) < Date.parse(terminalDrainEntry.exported_at)) {
    throw new Error("learning_external_public_authority_binding_mismatch:lifecycle_time_order");
  }

  const publicRunAuthoritySha256 = learningExternalPublicRunAuthorityDigest(publicRunAuthority);
  return {
    publicRunAuthority,
    payloadSha256,
    publicRunAuthoritySha256,
    canonicalByteLength: Buffer.byteLength(stableStringify(publicRunAuthority), "utf8"),
  };
}

import {
  LearningExternalEvidenceRunBundleV1Schema,
  learningExternalEvidenceLifecycleAuthorityProjectionDigest,
  learningExternalEvidenceRunBundleDigest,
  type LearningExternalEvidenceRunBundleV1,
} from "../../src/memory/learning-external-evidence.js";
import {
  LEARNING_EXTERNAL_EVIDENCE_ARCHIVE_V1_MAGIC,
  readLearningExternalEvidenceArchiveProofV1,
  verifyLearningExternalEvidenceArchiveBytesV1,
  verifyLearningExternalEvidenceArchiveV1,
} from "../../src/memory/learning-external-evidence-archive.js";

import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from "node:crypto";
import test from "node:test";

import stableStringify from "fast-json-stable-stringify";

import { learningGatePolicyConfigDigest } from "../../src/memory/learning-gate-policy.js";
import {
  LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY,
  learningExternalBrokerServiceActorId,
  learningExternalEd25519PublicKeyDigest,
  learningExternalReceiptDigest,
  learningExternalRunClaimOperationId,
  learningExternalSessionTerminationOperationId,
  learningExternalSupervisorBindingOperationId,
} from "../../src/memory/learning-external-authority.js";
import {
  learningExternalAttemptChainDigest,
  learningExternalEvidenceBindingDigest,
  learningExternalEvidenceReportDigest,
  learningExternalEvidenceThresholdContractDigest,
  learningExternalPreterminalPayloadSetDigest,
  learningExternalRunnerOutputManifestDigest,
  learningExternalTerminalRunManifestDigest,
  type LearningExternalEvidenceStatus,
} from "../../src/memory/learning-external-evidence.js";
import {
  LearningExternalPublicRunAuthorityV1Schema,
  learningExternalBrokerServiceInstanceDigest,
  learningExternalPublicRunAuthorityDigest,
  learningExternalPublicRunAuthorityPayloadDigest,
  parseCanonicalLearningExternalPublicRunAuthorityJson,
  validateLearningExternalPublicRunAuthorityV1,
  type LearningExternalPublicRunAuthorityExpectedAuthorityV1,
  type LearningExternalPublicRunAuthorityV1,
} from "../../src/memory/learning-external-public-authority.js";

type JsonObject = Record<string, unknown>;
type SigningKeys = Readonly<{ publicKey: KeyObject; privateKey: KeyObject }>;

type Fixture = Readonly<{
  publicRunAuthority: LearningExternalPublicRunAuthorityV1;
  expected: LearningExternalPublicRunAuthorityExpectedAuthorityV1;
  brokerKeys: SigningKeys;
  launcherKeys: SigningKeys;
}>;

const STATUSES: readonly LearningExternalEvidenceStatus[] = [
  "passed",
  "failed",
  "inconclusive",
];

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function rowDigest(row: Readonly<JsonObject>, digestField: string): string {
  return sha256(stableStringify(Object.fromEntries(
    Object.entries(row)
      .filter(([field]) => field !== digestField)
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  )));
}

function rawEd25519PublicKeyBase64(publicKey: KeyObject): string {
  const spki = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  assert.ok(spki.byteLength > 32);
  return spki.subarray(spki.byteLength - 32).toString("base64");
}

function signReceipt<TBody extends JsonObject>(body: TBody, privateKey: KeyObject) {
  return {
    body,
    signature_algorithm: "ed25519-v1" as const,
    signature_base64: signMessage(
      null,
      Buffer.from(stableStringify(body), "utf8"),
      privateKey,
    ).toString("base64"),
  };
}

function productionReportPayload(status: LearningExternalEvidenceStatus): Readonly<{
  payload: JsonObject;
  reasonCodes: string[];
}> {
  const failed = status === "failed";
  const inconclusive = status === "inconclusive";
  const rowCount = inconclusive ? 999 : 1_000;
  return {
    payload: {
      contract_version: "aionis_learning_external_production_shadow_report_payload_v1",
      evidence_status: status,
      row_count: rowCount,
      run_count: 10,
      task_signature_count: 30,
      scope_count: 5,
      projection_present_count: rowCount,
      source_row_set_sha256: sha256("shadow-source-row-set"),
      source_run_set_sha256: sha256("shadow-source-run-set"),
      shadow_projection_set_sha256: sha256("shadow-projection-set"),
      host_adapter_conformance_sha256: sha256("shadow-host-conformance"),
      fixed_threshold_contract_sha256: learningExternalEvidenceThresholdContractDigest(),
      online_mode: "shadow",
      shadow_projection_source_count: rowCount,
      agent_prompt_included_count: 0,
      runtime_mutation_count: 0,
      hard_boundary_upgrade_count: failed ? 1 : 0,
      selected_candidate_policy_id: "candidate-policy",
      recorded_hard_boundary_direct_use_count: 10,
      candidate_hard_boundary_direct_use_count: 9,
      recorded_negative_use_count: 10,
      candidate_negative_use_count: 9,
      recorded_positive_capture_count: 10,
      candidate_positive_capture_count: 11,
      recorded_calibration_score_micros: 500_000,
      candidate_calibration_score_micros: 600_000,
      changed_action_count: 1,
    },
    reasonCodes: failed
      ? ["no_hard_boundary_upgrade"]
      : inconclusive ? ["exact_source_coverage"] : [],
  };
}

function lifecycleOperation(args: Readonly<{
  tenantId: string;
  operationKind: string;
  operationId: string;
  actorId: string;
  requestSha256: string;
  authorityTable: string;
  authorityRefId: string;
  authorityRecordSha256: string;
  authorization: ReturnType<typeof signReceipt> | null;
  recordedAt: string;
}>): JsonObject {
  return {
    contract_version: "aionis_learning_external_authority_operation_receipt_v1",
    tenant_id: args.tenantId,
    scope: "learning_external_authority_v1",
    operation_kind: args.operationKind,
    operation_id: args.operationId,
    actor_id: args.actorId,
    request_sha256: args.requestSha256,
    authority_table: args.authorityTable,
    authority_ref_id: args.authorityRefId,
    authority_record_sha256: args.authorityRecordSha256,
    broker_authorization_receipt_sha256: args.authorization === null
      ? null
      : learningExternalReceiptDigest(args.authorization),
    broker_authorization_receipt: args.authorization,
    recorded_at: args.recordedAt,
  };
}

function lifecycleProjectionFact(
  row: Readonly<{ id: string; sha256: string }>,
  operation: JsonObject,
  authorityTable: string,
): JsonObject {
  return {
    authority_table: authorityTable,
    fact_id: row.id,
    fact_sha256: row.sha256,
    protected_operation: {
      scope: operation.scope,
      operation_kind: operation.operation_kind,
      operation_id: operation.operation_id,
      operation_request_sha256: operation.request_sha256,
      authority_record_sha256: operation.authority_record_sha256,
    },
  };
}

function buildFixture(
  status: LearningExternalEvidenceStatus,
  suppliedKeys?: Readonly<{ broker: SigningKeys; launcher: SigningKeys }>,
): Fixture {
  const brokerKeys = suppliedKeys?.broker ?? generateKeyPairSync("ed25519");
  const launcherKeys = suppliedKeys?.launcher ?? generateKeyPairSync("ed25519");
  const brokerPublicKeyBase64 = rawEd25519PublicKeyBase64(brokerKeys.publicKey);
  const launcherPublicKeyBase64 = rawEd25519PublicKeyBase64(launcherKeys.publicKey);
  const brokerPublicKeySha256 = learningExternalEd25519PublicKeyDigest(
    brokerPublicKeyBase64,
  );
  const launcherPublicKeySha256 = learningExternalEd25519PublicKeyDigest(
    launcherPublicKeyBase64,
  );

  const tenantId = "tenant-public-authority";
  const databaseInstanceId = sha256("database-instance-public-authority");
  const brokerPolicySha256 = sha256("broker-policy");
  const brokerBinarySha256 = sha256("broker-binary");
  const brokerKeyId = "broker-key-v1";
  const launcherPolicySha256 = sha256("launcher-policy");
  const launcherBinarySha256 = sha256("launcher-binary");
  const launcherKeyId = "launcher-key-v1";
  const brokerAuthority = {
    broker_service_identity: LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY,
    broker_policy_sha256: brokerPolicySha256,
    broker_binary_sha256: brokerBinarySha256,
    broker_public_key_sha256: brokerPublicKeySha256,
    broker_key_id: brokerKeyId,
  } as const;
  const brokerActorId = learningExternalBrokerServiceActorId(brokerAuthority);

  const serviceInstance = {
    contract_version: "aionis_learning_external_broker_service_instance_identity_v1",
    tenant_id: tenantId,
    database_instance_id: databaseInstanceId,
    broker_service_identity: LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY,
    broker_uid: 501,
    broker_gid: 20,
    broker_pid: 42_424,
    broker_process_start_identity_sha256: sha256("broker-process-start"),
    broker_cgroup_identity_sha256: sha256("broker-cgroup"),
    broker_service_job_identity_sha256: sha256("broker-service-job"),
    broker_socket_device_identity: "device-16777234",
    broker_socket_inode: 99_001,
  } as const;
  const serviceInstanceSha256 = learningExternalBrokerServiceInstanceDigest(serviceInstance);
  const serviceLaunchBody = {
    contract_version: "aionis_learning_external_broker_service_launch_receipt_v1",
    tenant_id: tenantId,
    database_instance_id: databaseInstanceId,
    broker_service_identity: LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY,
    broker_service_instance_sha256: serviceInstanceSha256,
    launched_broker_policy_sha256: brokerPolicySha256,
    launched_broker_binary_sha256: brokerBinarySha256,
    launched_broker_public_key_sha256: brokerPublicKeySha256,
    launched_broker_key_id: brokerKeyId,
    broker_uid: serviceInstance.broker_uid,
    broker_gid: serviceInstance.broker_gid,
    broker_pid: serviceInstance.broker_pid,
    broker_process_start_identity_sha256: serviceInstance.broker_process_start_identity_sha256,
    broker_cgroup_identity_sha256: serviceInstance.broker_cgroup_identity_sha256,
    broker_service_job_identity_sha256: serviceInstance.broker_service_job_identity_sha256,
    broker_socket_device_identity: serviceInstance.broker_socket_device_identity,
    broker_socket_inode: serviceInstance.broker_socket_inode,
    broker_socket_identity_sha256: sha256("broker-socket-identity"),
    broker_socket_mode: 0o600,
    broker_socket_owner_uid: serviceInstance.broker_uid,
    broker_socket_owner_gid: serviceInstance.broker_gid,
    private_state_root_acl_sha256: sha256("private-state-root-acl"),
    terminal_fact_spool_acl_sha256: sha256("terminal-fact-spool-acl"),
    launcher_channel_fingerprint_sha256: sha256("launcher-channel"),
    service_launcher_policy_sha256: launcherPolicySha256,
    service_launcher_binary_sha256: launcherBinarySha256,
    service_launcher_public_key_sha256: launcherPublicKeySha256,
    service_launcher_key_id: launcherKeyId,
    launched_at: "2026-07-17T00:00:00.000Z",
  } as const;
  const serviceLaunchReceipt = signReceipt(serviceLaunchBody, launcherKeys.privateKey);
  const brokerHealthBody = {
    contract_version: "aionis_learning_external_broker_health_receipt_v1",
    tenant_id: tenantId,
    database_instance_id: databaseInstanceId,
    health_id: "broker-health-public-authority",
    broker_service_instance_sha256: serviceInstanceSha256,
    challenge_sha256: sha256("health-challenge"),
    service_launch_receipt_sha256: learningExternalReceiptDigest(serviceLaunchReceipt),
    service_launch_receipt: serviceLaunchReceipt,
    peer_credentials_enforced: true,
    stdin_only_runner_ticket: true,
    runner_ticket_prefetched_before_spawn: true,
    runner_ticket_path_input_allowed: false,
    caller_selected_output_path_authority: false,
    private_state_root_owner_only: true,
    terminal_fact_spool_owner_only: true,
    unacknowledged_startup_recovery_count: 0,
    ...brokerAuthority,
    checked_at: "2026-07-17T00:00:01.000Z",
  } as const;
  const brokerHealthReceipt = signReceipt(brokerHealthBody, brokerKeys.privateKey);

  const immutableInputManifest = {
    contract_version: "aionis_learning_external_immutable_input_manifest_v1",
    tenant_id: tenantId,
    evidence_series_id: "series-production-shadow",
    task_family: "runtime-learning",
    applicable_experiment_id: "experiment-public-authority",
    applicable_experiment_revision: 7,
    candidate_policy_id: "candidate-policy",
    candidate_policy_version: "candidate-policy-v1",
    candidate_policy_implementation_sha256: sha256("candidate-implementation"),
    candidate_policy_config_sha256: sha256("candidate-config"),
    gate_policy_id: "gate-policy",
    gate_policy_version: "v1",
    gate_policy_config_sha256: learningGatePolicyConfigDigest(),
    harness_bundle_sha256: sha256("harness-production-shadow"),
    source_snapshot_sha256: sha256("source-snapshot-production-shadow"),
    execution_profile_sha256: sha256("execution-profile-production-shadow"),
    model_identity_sha256: sha256("model-identity-production-shadow"),
    expected_runner_principal_sha256: sha256("runner-principal"),
    run_id: "run-production-shadow",
    artifact_kind: "production_shadow_gate",
  } as const;
  const immutableInputManifestJson = stableStringify(immutableInputManifest);
  const immutableInputManifestSha256 = sha256(immutableInputManifestJson);
  const retryPolicy = {
    contract_version: "aionis_learning_external_retry_policy_v1",
    max_formal_attempts: 1,
    retry_after_ticket_consumption: false,
    retry_after_claim: false,
  } as const;
  const retryPolicyJson = stableStringify(retryPolicy);
  const retryPolicySha256 = sha256(retryPolicyJson);
  const reservationBase = {
    tenant_id: tenantId,
    reservation_id: "reservation-public-authority",
    artifact_kind: "production_shadow_gate",
    evidence_series_id: immutableInputManifest.evidence_series_id,
    task_family: immutableInputManifest.task_family,
    candidate_policy_id: immutableInputManifest.candidate_policy_id,
    candidate_policy_version: immutableInputManifest.candidate_policy_version,
    candidate_policy_implementation_sha256:
      immutableInputManifest.candidate_policy_implementation_sha256,
    candidate_policy_config_sha256: immutableInputManifest.candidate_policy_config_sha256,
    applicable_experiment_id: immutableInputManifest.applicable_experiment_id,
    applicable_experiment_revision: immutableInputManifest.applicable_experiment_revision,
    gate_policy_id: immutableInputManifest.gate_policy_id,
    gate_policy_version: immutableInputManifest.gate_policy_version,
    gate_policy_config_sha256: immutableInputManifest.gate_policy_config_sha256,
    applicability_manifest_sha256: sha256("applicability-manifest"),
    harness_bundle_sha256: immutableInputManifest.harness_bundle_sha256,
    source_snapshot_sha256: immutableInputManifest.source_snapshot_sha256,
    case_set_sha256: null,
    holdout_membership_projection_sha256: null,
    sealed_holdout_ref_sha256: null,
    sealed_holdout_ciphertext_sha256: null,
    execution_profile_sha256: immutableInputManifest.execution_profile_sha256,
    model_identity_sha256: immutableInputManifest.model_identity_sha256,
    immutable_model_snapshot_sha256: null,
    tool_manifest_sha256: null,
    execution_order_sha256: null,
    retry_policy_sha256: retryPolicySha256,
    retry_policy_json: retryPolicyJson,
    immutable_input_manifest_sha256: immutableInputManifestSha256,
    immutable_input_manifest_json: immutableInputManifestJson,
    expected_runner_principal_sha256: immutableInputManifest.expected_runner_principal_sha256,
    credential_broker_policy_sha256: brokerPolicySha256,
    service_launcher_policy_sha256: launcherPolicySha256,
    service_launcher_binary_sha256: launcherBinarySha256,
    service_launcher_key_id: launcherKeyId,
    supervisor_executable_sha256: sha256("supervisor-executable"),
    supervisor_argv_policy_sha256: sha256("supervisor-argv-policy"),
    supervisor_sandbox_policy_sha256: sha256("supervisor-sandbox-policy"),
    credential_session_class: "eligible_host_adapter",
    run_id: immutableInputManifest.run_id,
    reserve_operation_id: "reserve-operation-public-authority",
    runner_ticket_sha256: sha256("opaque-runner-ticket"),
    reserved_at: "2026-07-17T00:00:02.000Z",
  } as const;
  const reservation = {
    ...reservationBase,
    reservation_sha256: rowDigest(reservationBase, "reservation_sha256"),
  };
  const reservationAuthorizationBody = {
    contract_version: "aionis_learning_external_run_reservation_authorization_receipt_v1",
    tenant_id: tenantId,
    database_instance_id: databaseInstanceId,
    reservation_id: reservation.reservation_id,
    artifact_kind: reservation.artifact_kind,
    evidence_series_id: reservation.evidence_series_id,
    external_role: "production_shadow",
    applicable_experiment_id: reservation.applicable_experiment_id,
    applicable_experiment_revision: reservation.applicable_experiment_revision,
    run_id: reservation.run_id,
    expected_runner_principal_sha256: reservation.expected_runner_principal_sha256,
    reserve_operation_id: reservation.reserve_operation_id,
    reservation_sha256: reservation.reservation_sha256,
    runner_ticket_sha256: reservation.runner_ticket_sha256,
    authority_request_sha256: sha256(stableStringify({
      contract_version: "aionis_learning_external_reservation_authority_request_v1",
      reservation,
      holdout_member_sha256s: [],
      runner_ticket_sha256: reservation.runner_ticket_sha256,
    })),
    ...brokerAuthority,
    authorized_at: reservation.reserved_at,
    authorization_expires_at: "2026-07-17T00:00:32.000Z",
  } as const;
  const reservationAuthorization = signReceipt(
    reservationAuthorizationBody,
    brokerKeys.privateKey,
  );
  const reservationOperation = lifecycleOperation({
    tenantId,
    operationKind: "learning_external_run_reservation_v1",
    operationId: reservation.reserve_operation_id,
    actorId: learningExternalBrokerServiceActorId(reservationAuthorizationBody),
    requestSha256: sha256(stableStringify({
      contract_version: "aionis_learning_external_reservation_request_v1",
      authority_request_sha256: reservationAuthorizationBody.authority_request_sha256,
      broker_authorization_receipt: reservationAuthorization,
    })),
    authorityTable: "lite_learning_external_run_reservations",
    authorityRefId: reservation.reservation_id,
    authorityRecordSha256: reservation.reservation_sha256,
    authorization: reservationAuthorization,
    recordedAt: reservation.reserved_at,
  });

  const consumptionBase = {
    tenant_id: tenantId,
    consumption_id: "consumption-public-authority",
    reservation_id: reservation.reservation_id,
    runner_ticket_sha256: reservation.runner_ticket_sha256,
    runner_principal_sha256: reservation.expected_runner_principal_sha256,
    broker_process_nonce_sha256: sha256("broker-process-nonce"),
    consume_operation_id: "consume-operation-public-authority",
    consumed_at: "2026-07-17T00:00:03.000Z",
  } as const;
  const consumption = {
    ...consumptionBase,
    consumption_sha256: rowDigest(consumptionBase, "consumption_sha256"),
  };
  const consumptionAuthorizationBody = {
    contract_version: "aionis_learning_external_ticket_consumption_authorization_receipt_v1",
    tenant_id: tenantId,
    database_instance_id: databaseInstanceId,
    reservation_id: reservation.reservation_id,
    consumption_id: consumption.consumption_id,
    artifact_kind: reservation.artifact_kind,
    evidence_series_id: reservation.evidence_series_id,
    external_role: "production_shadow",
    applicable_experiment_id: reservation.applicable_experiment_id,
    applicable_experiment_revision: reservation.applicable_experiment_revision,
    run_id: reservation.run_id,
    consume_operation_id: consumption.consume_operation_id,
    reservation_sha256: reservation.reservation_sha256,
    consumption_sha256: consumption.consumption_sha256,
    runner_ticket_sha256: consumption.runner_ticket_sha256,
    runner_principal_sha256: consumption.runner_principal_sha256,
    broker_process_nonce_sha256: consumption.broker_process_nonce_sha256,
    authority_request_sha256: sha256(stableStringify({
      contract_version: "aionis_learning_external_ticket_consumption_authority_request_v1",
      consumption,
      reservation_sha256: reservation.reservation_sha256,
      runner_ticket_sha256: reservation.runner_ticket_sha256,
    })),
    ...brokerAuthority,
    authorized_at: consumption.consumed_at,
    authorization_expires_at: "2026-07-17T00:00:33.000Z",
  } as const;
  const consumptionAuthorization = signReceipt(
    consumptionAuthorizationBody,
    brokerKeys.privateKey,
  );
  const consumptionOperation = lifecycleOperation({
    tenantId,
    operationKind: "learning_external_ticket_consumption_v1",
    operationId: consumption.consume_operation_id,
    actorId: learningExternalBrokerServiceActorId(consumptionAuthorizationBody),
    requestSha256: sha256(stableStringify({
      contract_version: "aionis_learning_external_ticket_consumption_request_v1",
      authority_request_sha256: consumptionAuthorizationBody.authority_request_sha256,
      broker_authorization_receipt: consumptionAuthorization,
    })),
    authorityTable: "lite_learning_external_ticket_consumptions",
    authorityRefId: consumption.consumption_id,
    authorityRecordSha256: consumption.consumption_sha256,
    authorization: consumptionAuthorization,
    recordedAt: consumption.consumed_at,
  });

  const claimBody = {
    contract_version: "aionis_learning_external_claim_receipt_v1",
    tenant_id: tenantId,
    reservation_id: reservation.reservation_id,
    ticket_consumption_id: consumption.consumption_id,
    claim_id: "claim-public-authority",
    ticket_consumption_sha256: consumption.consumption_sha256,
    runner_ticket_sha256: reservation.runner_ticket_sha256,
    runner_principal_sha256: consumption.runner_principal_sha256,
    runner_execution_nonce_sha256: sha256("runner-execution-nonce"),
    credential_scope_sha256: sha256("credential-scope"),
    credential_session_class: reservation.credential_session_class,
    credential_session_id_sha256: sha256("credential-session-id"),
    supervisor_bind_expires_at: "2026-07-17T00:01:04.000Z",
    credential_session_expires_at: "2026-07-17T00:10:04.000Z",
    credential_session_heartbeat_seconds: 10,
    credential_session_max_calls: 2,
    per_call_capability_ttl_seconds: 30,
    post_quiesce_finalize_ttl_seconds: 60,
    ...brokerAuthority,
    claimed_at: "2026-07-17T00:00:04.000Z",
  } as const;
  const claimReceipt = signReceipt(claimBody, brokerKeys.privateKey);
  const claimReceiptSha256 = learningExternalReceiptDigest(claimReceipt);
  const claimOperationId = learningExternalRunClaimOperationId({
    tenantId,
    receiptSha256: claimReceiptSha256,
  });
  const claimBase = {
    tenant_id: tenantId,
    claim_id: claimBody.claim_id,
    reservation_id: reservation.reservation_id,
    ticket_consumption_id: consumption.consumption_id,
    ticket_consumption_sha256: consumption.consumption_sha256,
    runner_principal_sha256: claimBody.runner_principal_sha256,
    runner_execution_nonce_sha256: claimBody.runner_execution_nonce_sha256,
    credential_broker_receipt_sha256: claimReceiptSha256,
    credential_broker_policy_sha256: brokerPolicySha256,
    credential_broker_binary_sha256: brokerBinarySha256,
    credential_broker_key_id: brokerKeyId,
    credential_broker_receipt_json: stableStringify(claimBody),
    credential_broker_receipt_signature: claimReceipt.signature_base64,
    credential_session_id_sha256: claimBody.credential_session_id_sha256,
    supervisor_bind_expires_at: claimBody.supervisor_bind_expires_at,
    credential_session_expires_at: claimBody.credential_session_expires_at,
    credential_session_heartbeat_seconds: claimBody.credential_session_heartbeat_seconds,
    credential_session_max_calls: claimBody.credential_session_max_calls,
    claim_operation_id: claimOperationId,
    claimed_at: claimBody.claimed_at,
  } as const;
  const claim = {
    ...claimBase,
    claim_sha256: rowDigest(claimBase, "claim_sha256"),
  };
  const claimOperation = lifecycleOperation({
    tenantId,
    operationKind: "learning_external_run_claim_v1",
    operationId: claim.claim_operation_id,
    actorId: brokerActorId,
    requestSha256: sha256(stableStringify({
      contract_version: "aionis_learning_external_claim_request_v1",
      receipt: claimReceipt,
    })),
    authorityTable: "lite_learning_external_run_claims",
    authorityRefId: claim.claim_id,
    authorityRecordSha256: claim.claim_sha256,
    authorization: null,
    recordedAt: claim.claimed_at,
  });

  const launcherSpawnBody = {
    contract_version: "aionis_learning_external_launcher_spawn_receipt_v1",
    tenant_id: tenantId,
    reservation_id: reservation.reservation_id,
    ticket_consumption_id: consumption.consumption_id,
    claim_id: claim.claim_id,
    credential_session_id_sha256: claim.credential_session_id_sha256,
    broker_challenge_sha256: sha256("broker-launch-challenge"),
    runner_principal_sha256: claim.runner_principal_sha256,
    runner_uid: 502,
    runner_gid: 20,
    supervisor_pid: 42_425,
    supervisor_process_start_identity_sha256: sha256("supervisor-process-start"),
    supervisor_cgroup_identity_sha256: sha256("supervisor-cgroup"),
    supervisor_service_job_identity_sha256: sha256("supervisor-service-job"),
    supervisor_process_identity_sha256: sha256("supervisor-process-identity"),
    supervisor_executable_sha256: reservation.supervisor_executable_sha256,
    supervisor_argv_policy_sha256: reservation.supervisor_argv_policy_sha256,
    supervisor_argv_sha256: sha256("supervisor-argv"),
    inherited_channel_sha256: sha256("inherited-channel"),
    broker_channel_fingerprint_sha256: sha256("broker-channel-fingerprint"),
    supervisor_channel_fingerprint_sha256: sha256("supervisor-channel-fingerprint"),
    service_launcher_policy_sha256: launcherPolicySha256,
    service_launcher_binary_sha256: launcherBinarySha256,
    service_launcher_public_key_sha256: launcherPublicKeySha256,
    service_launcher_key_id: launcherKeyId,
    supervisor_sandbox_policy_sha256: reservation.supervisor_sandbox_policy_sha256,
    spawned_at: "2026-07-17T00:00:05.000Z",
  } as const;
  const launcherSpawnReceipt = signReceipt(launcherSpawnBody, launcherKeys.privateKey);
  const bindingBody = {
    contract_version: "aionis_learning_external_broker_supervisor_binding_receipt_v1",
    tenant_id: tenantId,
    reservation_id: reservation.reservation_id,
    ticket_consumption_id: consumption.consumption_id,
    binding_id: "binding-public-authority",
    claim_id: claim.claim_id,
    credential_session_id_sha256: claim.credential_session_id_sha256,
    runner_principal_sha256: claim.runner_principal_sha256,
    supervisor_process_identity_sha256: launcherSpawnBody.supervisor_process_identity_sha256,
    supervisor_executable_sha256: launcherSpawnBody.supervisor_executable_sha256,
    supervisor_argv_policy_sha256: launcherSpawnBody.supervisor_argv_policy_sha256,
    supervisor_argv_sha256: launcherSpawnBody.supervisor_argv_sha256,
    inherited_channel_sha256: launcherSpawnBody.inherited_channel_sha256,
    service_launcher_receipt_sha256: learningExternalReceiptDigest(launcherSpawnReceipt),
    service_launcher_receipt: launcherSpawnReceipt,
    service_launcher_policy_sha256: launcherPolicySha256,
    service_launcher_binary_sha256: launcherBinarySha256,
    service_launcher_public_key_sha256: launcherPublicKeySha256,
    service_launcher_key_id: launcherKeyId,
    supervisor_sandbox_policy_sha256: reservation.supervisor_sandbox_policy_sha256,
    ...brokerAuthority,
    bound_at: "2026-07-17T00:00:05.000Z",
  } as const;
  const bindingReceipt = signReceipt(bindingBody, brokerKeys.privateKey);
  const bindingReceiptSha256 = learningExternalReceiptDigest(bindingReceipt);
  const bindingOperationId = learningExternalSupervisorBindingOperationId({
    tenantId,
    claimId: claim.claim_id,
    receiptSha256: bindingReceiptSha256,
  });
  const bindingBase = {
    tenant_id: tenantId,
    binding_id: bindingBody.binding_id,
    reservation_id: reservation.reservation_id,
    ticket_consumption_id: consumption.consumption_id,
    claim_id: claim.claim_id,
    credential_session_id_sha256: claim.credential_session_id_sha256,
    runner_principal_sha256: claim.runner_principal_sha256,
    supervisor_process_identity_sha256: bindingBody.supervisor_process_identity_sha256,
    supervisor_executable_sha256: bindingBody.supervisor_executable_sha256,
    supervisor_argv_sha256: bindingBody.supervisor_argv_sha256,
    inherited_channel_sha256: bindingBody.inherited_channel_sha256,
    service_launcher_receipt_sha256: bindingBody.service_launcher_receipt_sha256,
    service_launcher_policy_sha256: launcherPolicySha256,
    service_launcher_binary_sha256: launcherBinarySha256,
    service_launcher_key_id: launcherKeyId,
    supervisor_sandbox_policy_sha256: bindingBody.supervisor_sandbox_policy_sha256,
    broker_binding_receipt_sha256: bindingReceiptSha256,
    broker_binding_receipt_json: stableStringify(bindingBody),
    broker_binding_receipt_signature: bindingReceipt.signature_base64,
    bind_operation_id: bindingOperationId,
    bound_at: bindingBody.bound_at,
  } as const;
  const binding = {
    ...bindingBase,
    binding_sha256: rowDigest(bindingBase, "binding_sha256"),
  };
  const bindingOperation = lifecycleOperation({
    tenantId,
    operationKind: "learning_external_supervisor_binding_v1",
    operationId: binding.bind_operation_id,
    actorId: brokerActorId,
    requestSha256: sha256(stableStringify({
      contract_version: "aionis_learning_external_supervisor_binding_request_v1",
      receipt: bindingReceipt,
    })),
    authorityTable: "lite_learning_external_supervisor_bindings",
    authorityRefId: binding.binding_id,
    authorityRecordSha256: binding.binding_sha256,
    authorization: null,
    recordedAt: binding.bound_at,
  });

  const evidenceBinding = {
    contract_version: "aionis_learning_external_evidence_binding_v1",
    artifact_kind: reservation.artifact_kind,
    tenant_id: tenantId,
    database_instance_id: databaseInstanceId,
    evidence_series_id: reservation.evidence_series_id,
    task_family: reservation.task_family,
    applicable_experiment_id: reservation.applicable_experiment_id,
    applicable_experiment_revision: reservation.applicable_experiment_revision,
    candidate_policy_id: reservation.candidate_policy_id,
    candidate_policy_version: reservation.candidate_policy_version,
    candidate_policy_implementation_sha256: reservation.candidate_policy_implementation_sha256,
    candidate_policy_config_sha256: reservation.candidate_policy_config_sha256,
    gate_policy_id: reservation.gate_policy_id,
    gate_policy_version: reservation.gate_policy_version,
    gate_policy_config_sha256: reservation.gate_policy_config_sha256,
    applicability_manifest_sha256: reservation.applicability_manifest_sha256,
    evidence_scope_set_sha256: sha256("evidence-scope-set"),
    immutable_input_manifest_sha256: reservation.immutable_input_manifest_sha256,
    retry_policy_sha256: reservation.retry_policy_sha256,
    harness_bundle_sha256: reservation.harness_bundle_sha256,
    source_snapshot_sha256: reservation.source_snapshot_sha256,
    run_id: reservation.run_id,
  } as const;
  const evidenceBindingSha256 = learningExternalEvidenceBindingDigest(evidenceBinding);
  const sourceBundleSha256 = sha256("source-bundle-production-shadow");
  const sourceCommitId = sha256("source-commit-production-shadow").slice(0, 40);
  const { payload: reportPayload, reasonCodes } = productionReportPayload(status);
  const report = {
    contract_version: "aionis_learning_external_evidence_report_v1",
    evidence_binding_sha256: evidenceBindingSha256,
    tenant_id: tenantId,
    database_instance_id: databaseInstanceId,
    evidence_series_id: reservation.evidence_series_id,
    task_family: reservation.task_family,
    applicable_experiment_id: reservation.applicable_experiment_id,
    applicable_experiment_revision: reservation.applicable_experiment_revision,
    candidate_policy_id: reservation.candidate_policy_id,
    candidate_policy_version: reservation.candidate_policy_version,
    candidate_policy_implementation_sha256: reservation.candidate_policy_implementation_sha256,
    candidate_policy_config_sha256: reservation.candidate_policy_config_sha256,
    gate_policy_id: reservation.gate_policy_id,
    gate_policy_version: reservation.gate_policy_version,
    gate_policy_config_sha256: reservation.gate_policy_config_sha256,
    applicability_manifest_sha256: reservation.applicability_manifest_sha256,
    evidence_scope_set_sha256: evidenceBinding.evidence_scope_set_sha256,
    immutable_input_manifest_sha256: reservation.immutable_input_manifest_sha256,
    retry_policy_sha256: reservation.retry_policy_sha256,
    harness_bundle_sha256: reservation.harness_bundle_sha256,
    source_snapshot_sha256: reservation.source_snapshot_sha256,
    run_id: reservation.run_id,
    artifact_kind: reservation.artifact_kind,
    artifact_status: status,
    source_experiment_id: "source-experiment",
    source_experiment_revision: 3,
    source_serving_phase: "shadow",
    source_bundle_sha256: sourceBundleSha256,
    collected_at: "2026-07-17T00:00:06.000Z",
    reason_codes: reasonCodes,
    payload: reportPayload,
  } as const;
  const reportSha256 = learningExternalEvidenceReportDigest(report);
  const attemptChain = {
    contract_version: "aionis_learning_external_attempt_chain_v1",
    evidence_binding_sha256: evidenceBindingSha256,
    reservation_id: reservation.reservation_id,
    ticket_consumption_id: consumption.consumption_id,
    claim_id: claim.claim_id,
    supervisor_binding_id: binding.binding_id,
    credential_session_max_calls: claim.credential_session_max_calls,
    attempts: [],
    sealed_at: "2026-07-17T00:00:05.000Z",
  } as const;
  const attemptChainSha256 = learningExternalAttemptChainDigest(attemptChain);
  const preterminalPayloadSetSha256 = learningExternalPreterminalPayloadSetDigest({
    contract_version: "aionis_learning_external_preterminal_payload_set_v1",
    evidence_binding_sha256: evidenceBindingSha256,
    report_sha256: reportSha256,
    attempt_chain_sha256: attemptChainSha256,
    source_bundle_sha256: sourceBundleSha256,
    harness_bundle_sha256: reservation.harness_bundle_sha256,
  });
  const runnerOutputManifest = {
    contract_version: "aionis_learning_external_runner_output_manifest_v1",
    evidence_binding_sha256: evidenceBindingSha256,
    artifact_kind: reservation.artifact_kind,
    artifact_status: status,
    reservation_id: reservation.reservation_id,
    ticket_consumption_id: consumption.consumption_id,
    claim_id: claim.claim_id,
    supervisor_binding_id: binding.binding_id,
    report_sha256: reportSha256,
    attempt_chain_sha256: attemptChainSha256,
    source_bundle_sha256: sourceBundleSha256,
    harness_bundle_sha256: reservation.harness_bundle_sha256,
    preterminal_payload_set_sha256: preterminalPayloadSetSha256,
    source_ref: "evals/learning-episode-gate-v1/runs/production-shadow",
    source_commit_id: sourceCommitId,
    collected_at: "2026-07-17T00:00:06.000Z",
  } as const;
  const runnerOutputManifestSha256 = learningExternalRunnerOutputManifestDigest(
    runnerOutputManifest,
  );
  const terminalRunManifest = {
    contract_version: "aionis_learning_external_terminal_run_manifest_v1",
    evidence_binding_sha256: evidenceBindingSha256,
    artifact_kind: reservation.artifact_kind,
    artifact_status: status,
    reservation_id: reservation.reservation_id,
    ticket_consumption_id: consumption.consumption_id,
    claim_id: claim.claim_id,
    supervisor_binding_id: binding.binding_id,
    report_sha256: reportSha256,
    attempt_chain_sha256: attemptChainSha256,
    runner_output_manifest_sha256: runnerOutputManifestSha256,
    source_bundle_sha256: sourceBundleSha256,
    harness_bundle_sha256: reservation.harness_bundle_sha256,
    preterminal_payload_set_sha256: preterminalPayloadSetSha256,
    source_ref: runnerOutputManifest.source_ref,
    source_commit_id: sourceCommitId,
    finalized_at: "2026-07-17T00:00:07.000Z",
  } as const;
  const terminalRunManifestSha256 = learningExternalTerminalRunManifestDigest(
    terminalRunManifest,
  );

  const quiesceBody = {
    contract_version: "aionis_learning_external_clean_quiesce_receipt_v1",
    tenant_id: tenantId,
    reservation_id: reservation.reservation_id,
    ticket_consumption_id: consumption.consumption_id,
    claim_id: claim.claim_id,
    supervisor_binding_id: binding.binding_id,
    credential_session_id_sha256: claim.credential_session_id_sha256,
    runner_output_manifest_sha256: runnerOutputManifestSha256,
    attempt_chain_sha256: attemptChainSha256,
    cleanup_proof_sha256: sha256("cleanup-proof"),
    post_revoke_access_denial_proof_sha256: sha256("post-revoke-access-denial-proof"),
    finalize_deadline_at: "2026-07-17T00:01:06.000Z",
    ...brokerAuthority,
    quiesced_at: "2026-07-17T00:00:06.000Z",
  } as const;
  const quiesceReceipt = signReceipt(quiesceBody, brokerKeys.privateKey);
  const terminationBody = {
    contract_version: "aionis_learning_external_session_termination_receipt_v1",
    tenant_id: tenantId,
    reservation_id: reservation.reservation_id,
    ticket_consumption_id: consumption.consumption_id,
    termination_id: "termination-public-authority",
    claim_id: claim.claim_id,
    supervisor_binding_id: binding.binding_id,
    credential_session_id_sha256: claim.credential_session_id_sha256,
    termination_reason: status,
    broker_quiesce_receipt_sha256: learningExternalReceiptDigest(quiesceReceipt),
    broker_quiesce_receipt: quiesceReceipt,
    runner_output_manifest_sha256: runnerOutputManifestSha256,
    terminal_run_manifest_sha256: terminalRunManifestSha256,
    attempt_chain_sha256: attemptChainSha256,
    ...brokerAuthority,
    terminated_at: "2026-07-17T00:00:08.000Z",
  } as const;
  const terminationReceipt = signReceipt(terminationBody, brokerKeys.privateKey);
  const terminationReceiptSha256 = learningExternalReceiptDigest(terminationReceipt);
  const terminationOperationId = learningExternalSessionTerminationOperationId({
    tenantId,
    receiptSha256: terminationReceiptSha256,
  });
  const terminationBase = {
    tenant_id: tenantId,
    termination_id: terminationBody.termination_id,
    reservation_id: reservation.reservation_id,
    ticket_consumption_id: consumption.consumption_id,
    claim_id: claim.claim_id,
    supervisor_binding_id: binding.binding_id,
    credential_session_id_sha256: claim.credential_session_id_sha256,
    termination_reason: status,
    broker_quiesce_receipt_sha256: terminationBody.broker_quiesce_receipt_sha256,
    runner_output_manifest_sha256: runnerOutputManifestSha256,
    terminal_run_manifest_sha256: terminalRunManifestSha256,
    attempt_chain_sha256: attemptChainSha256,
    credential_broker_policy_sha256: brokerPolicySha256,
    credential_broker_binary_sha256: brokerBinarySha256,
    credential_broker_key_id: brokerKeyId,
    broker_terminal_receipt_sha256: terminationReceiptSha256,
    broker_terminal_receipt_json: stableStringify(terminationBody),
    broker_terminal_receipt_signature: terminationReceipt.signature_base64,
    termination_actor_id: brokerActorId,
    terminate_operation_id: terminationOperationId,
    terminated_at: terminationBody.terminated_at,
  } as const;
  const termination = {
    ...terminationBase,
    termination_sha256: rowDigest(terminationBase, "termination_sha256"),
  };
  const terminationOperation = lifecycleOperation({
    tenantId,
    operationKind: "learning_external_session_termination_v1",
    operationId: termination.terminate_operation_id,
    actorId: brokerActorId,
    requestSha256: sha256(stableStringify({
      contract_version: "aionis_learning_external_session_termination_request_v1",
      receipt: terminationReceipt,
    })),
    authorityTable: "lite_learning_external_session_terminations",
    authorityRefId: termination.termination_id,
    authorityRecordSha256: termination.termination_sha256,
    authorization: null,
    recordedAt: termination.terminated_at,
  });

  const lifecycleAuthorityProjection = {
    contract_version: "aionis_learning_external_lifecycle_authority_projection_v1",
    evidence_binding_sha256: evidenceBindingSha256,
    artifact_kind: reservation.artifact_kind,
    tenant_id: tenantId,
    database_instance_id: databaseInstanceId,
    reservation: lifecycleProjectionFact(
      { id: reservation.reservation_id, sha256: reservation.reservation_sha256 },
      reservationOperation,
      "lite_learning_external_run_reservations",
    ),
    ticket_consumption: lifecycleProjectionFact(
      { id: consumption.consumption_id, sha256: consumption.consumption_sha256 },
      consumptionOperation,
      "lite_learning_external_ticket_consumptions",
    ),
    claim: lifecycleProjectionFact(
      { id: claim.claim_id, sha256: claim.claim_sha256 },
      claimOperation,
      "lite_learning_external_run_claims",
    ),
    supervisor_binding: lifecycleProjectionFact(
      { id: binding.binding_id, sha256: binding.binding_sha256 },
      bindingOperation,
      "lite_learning_external_supervisor_bindings",
    ),
    session_termination: {
      ...lifecycleProjectionFact(
        { id: termination.termination_id, sha256: termination.termination_sha256 },
        terminationOperation,
        "lite_learning_external_session_terminations",
      ),
      termination_reason: status,
      broker_terminal_receipt_sha256: termination.broker_terminal_receipt_sha256,
      broker_quiesce_receipt_sha256: termination.broker_quiesce_receipt_sha256,
      runner_output_manifest_sha256: runnerOutputManifestSha256,
      terminal_run_manifest_sha256: terminalRunManifestSha256,
      attempt_chain_sha256: attemptChainSha256,
      terminated_at: termination.terminated_at,
    },
    service_launcher_receipt_sha256: binding.service_launcher_receipt_sha256,
  } as const;
  const publicRunAuthorityPayload = {
    contract_version: "aionis_learning_external_public_run_authority_payload_v1",
    tenant_id: tenantId,
    database_instance_id: databaseInstanceId,
    evidence_binding_sha256: evidenceBindingSha256,
    artifact_kind: reservation.artifact_kind,
    broker_health_receipt: brokerHealthReceipt,
    reservation: {
      row: reservation,
      holdout_members: [],
      operation: reservationOperation,
    },
    ticket_consumption: { row: consumption, operation: consumptionOperation },
    claim: { row: claim, operation: claimOperation },
    supervisor_binding: { row: binding, operation: bindingOperation },
    session_termination: { row: termination, operation: terminationOperation },
    report,
    attempt_chain: attemptChain,
    runner_output_manifest: runnerOutputManifest,
    terminal_run_manifest: terminalRunManifest,
    lifecycle_authority_projection: lifecycleAuthorityProjection,
    assembled_at: "2026-07-17T00:00:09.000Z",
  } as const;
  const publicRunAuthorityPayloadSha256 = learningExternalPublicRunAuthorityPayloadDigest(
    publicRunAuthorityPayload,
  );
  const terminalDrainEntry = {
    fact_kind: "session_termination",
    tenant_id: tenantId,
    reservation_id: reservation.reservation_id,
    reservation_sha256: reservation.reservation_sha256,
    export_subdirectory: reservation.reservation_sha256,
    ticket_consumption_id: consumption.consumption_id,
    broker_process_nonce_sha256: consumption.broker_process_nonce_sha256,
    fact_id: termination.termination_id,
    fact_sha256: termination.termination_sha256,
    signed_receipt_sha256: termination.broker_terminal_receipt_sha256,
    operation_id: terminationOperation.operation_id,
    operation_request_sha256: terminationOperation.request_sha256,
    authority_record_sha256: termination.termination_sha256,
    public_run_authority_payload_sha256: publicRunAuthorityPayloadSha256,
    acknowledged_at: "2026-07-17T00:00:09.000Z",
    exported_at: "2026-07-17T00:00:09.000Z",
  } as const;
  const drainBody = {
    contract_version: "aionis_learning_external_terminal_fact_drain_receipt_v1",
    tenant_id: tenantId,
    database_instance_id: databaseInstanceId,
    drain_id: "drain-public-authority",
    broker_service_instance_sha256: serviceInstanceSha256,
    broker_health_receipt_sha256: learningExternalReceiptDigest(brokerHealthReceipt),
    entries: [terminalDrainEntry],
    ...brokerAuthority,
    drained_at: "2026-07-17T00:00:10.000Z",
  } as const;
  const publicRunAuthority = LearningExternalPublicRunAuthorityV1Schema.parse({
    contract_version: "aionis_learning_external_public_run_authority_v1",
    payload: publicRunAuthorityPayload,
    terminal_fact_drain_receipt: signReceipt(drainBody, brokerKeys.privateKey),
  });
  const expected: LearningExternalPublicRunAuthorityExpectedAuthorityV1 = {
    tenant_id: tenantId,
    database_instance_id: databaseInstanceId,
    broker_public_key_base64: brokerPublicKeyBase64,
    broker_policy_sha256: brokerPolicySha256,
    broker_binary_sha256: brokerBinarySha256,
    broker_key_id: brokerKeyId,
    service_launcher_public_key_base64: launcherPublicKeyBase64,
    service_launcher_policy_sha256: launcherPolicySha256,
    service_launcher_binary_sha256: launcherBinarySha256,
    service_launcher_key_id: launcherKeyId,
  };
  return { publicRunAuthority, expected, brokerKeys, launcherKeys };
}


type ArchiveEntry = Readonly<{ path: string; bytes: Uint8Array }>;

type ArchiveFixture = Readonly<{
  archiveBytes: Buffer;
  manifestBytes: Buffer;
  runBundle: LearningExternalEvidenceRunBundleV1;
  entries: readonly ArchiveEntry[];
}>;

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(stableStringify(value), "utf8");
}

function uint16Buffer(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

function uint32Buffer(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function uint64Buffer(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function encodeArchive(manifestBytes: Uint8Array, entries: readonly ArchiveEntry[]): Buffer {
  const parts: Buffer[] = [
    Buffer.from(LEARNING_EXTERNAL_EVIDENCE_ARCHIVE_V1_MAGIC, "ascii"),
    uint32Buffer(manifestBytes.byteLength),
    Buffer.from(manifestBytes),
    uint32Buffer(entries.length),
  ];
  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.path, "utf8");
    parts.push(
      uint16Buffer(pathBytes.byteLength),
      pathBytes,
      uint64Buffer(entry.bytes.byteLength),
      Buffer.from(entry.bytes),
    );
  }
  return Buffer.concat(parts);
}

function withManifestMember(
  fixture: ArchiveFixture,
  path: string,
  bytes: Uint8Array,
): ArchiveFixture {
  const runBundle = LearningExternalEvidenceRunBundleV1Schema.parse({
    ...fixture.runBundle,
    members: fixture.runBundle.members.map((member) => member.path === path
      ? { ...member, byte_length: bytes.byteLength, sha256: sha256(bytes) }
      : member),
  });
  const entries = fixture.entries.map((entry) => entry.path === path
    ? { ...entry, bytes }
    : entry);
  const manifestBytes = canonicalBytes(runBundle);
  return {
    runBundle,
    entries,
    manifestBytes,
    archiveBytes: encodeArchive(manifestBytes, entries),
  };
}

function buildArchiveFixture(): ArchiveFixture {
  const publicRunAuthority = buildFixture("passed").publicRunAuthority;
  const payload = publicRunAuthority.payload;
  const lifecycleAuthorityProjectionSha256 =
    learningExternalEvidenceLifecycleAuthorityProjectionDigest(
      payload.lifecycle_authority_projection,
    );
  const publicRunAuthoritySha256 = learningExternalPublicRunAuthorityDigest(
    publicRunAuthority,
  );
  const sourceBundle = Buffer.from("source-bundle-production-shadow", "utf8");
  assert.equal(sha256(sourceBundle), payload.report.source_bundle_sha256);
  const supportingEvidence = Buffer.alloc((2 * 1024 * 1024) + 17, 0xa5);
  const rawByPath = new Map<string, Buffer>([
    ["attempt-chain.json", canonicalBytes(payload.attempt_chain)],
    [
      "lifecycle-authority-projection.json",
      canonicalBytes(payload.lifecycle_authority_projection),
    ],
    ["public-run-authority.json", canonicalBytes(publicRunAuthority)],
    ["report.json", canonicalBytes(payload.report)],
    ["runner-output-manifest.json", canonicalBytes(payload.runner_output_manifest)],
    ["source-bundle.bin", sourceBundle],
    ["support/blob.bin", supportingEvidence],
    ["terminal-run-manifest.json", canonicalBytes(payload.terminal_run_manifest)],
  ]);
  const roleByPath = new Map<string, LearningExternalEvidenceRunBundleV1["members"][number]["role"]>([
    ["attempt-chain.json", "attempt_chain"],
    ["lifecycle-authority-projection.json", "lifecycle_authority_projection"],
    ["public-run-authority.json", "public_run_authority"],
    ["report.json", "report"],
    ["runner-output-manifest.json", "runner_output_manifest"],
    ["source-bundle.bin", "source_bundle"],
    ["support/blob.bin", "supporting_evidence"],
    ["terminal-run-manifest.json", "terminal_run_manifest"],
  ]);
  const entries = [...rawByPath.entries()].map(([path, bytes]) => ({ path, bytes }));
  entries.sort((left, right) => Buffer.compare(
    Buffer.from(left.path),
    Buffer.from(right.path),
  ));
  const runBundle = LearningExternalEvidenceRunBundleV1Schema.parse({
    contract_version: "aionis_learning_external_evidence_run_bundle_v1",
    evidence_binding_sha256: payload.evidence_binding_sha256,
    artifact_kind: payload.artifact_kind,
    artifact_status: payload.report.artifact_status,
    lifecycle_authority_projection_sha256: lifecycleAuthorityProjectionSha256,
    public_run_authority_sha256: publicRunAuthoritySha256,
    reservation_id: payload.reservation.row.reservation_id,
    ticket_consumption_id: payload.ticket_consumption.row.consumption_id,
    claim_id: payload.claim.row.claim_id,
    supervisor_binding_id: payload.supervisor_binding.row.binding_id,
    session_termination_id: payload.session_termination.row.termination_id,
    session_termination_sha256: payload.session_termination.row.termination_sha256,
    report_sha256: learningExternalEvidenceReportDigest(payload.report),
    attempt_chain_sha256: learningExternalAttemptChainDigest(payload.attempt_chain),
    runner_output_manifest_sha256:
      learningExternalRunnerOutputManifestDigest(payload.runner_output_manifest),
    terminal_run_manifest_sha256:
      learningExternalTerminalRunManifestDigest(payload.terminal_run_manifest),
    source_bundle_sha256: payload.report.source_bundle_sha256,
    harness_bundle_sha256: payload.report.harness_bundle_sha256,
    preterminal_payload_set_sha256:
      payload.runner_output_manifest.preterminal_payload_set_sha256,
    source_ref: payload.runner_output_manifest.source_ref,
    source_commit_id: payload.runner_output_manifest.source_commit_id,
    members: entries.map((entry) => ({
      path: entry.path,
      role: roleByPath.get(entry.path),
      byte_length: entry.bytes.byteLength,
      sha256: sha256(entry.bytes),
    })),
    committed_at: "2026-07-17T00:00:11.000Z",
  });
  const manifestBytes = canonicalBytes(runBundle);
  return {
    runBundle,
    entries,
    manifestBytes,
    archiveBytes: encodeArchive(manifestBytes, entries),
  };
}

test("raw archive streams outer/member hashes and issues only module-owned proof", () => {
  const fixture = buildArchiveFixture();
  let maximumReadLength = 0;
  let readCount = 0;
  const validation = verifyLearningExternalEvidenceArchiveV1({
    byteLength: fixture.archiveBytes.byteLength,
    readExactly(offset, length) {
      maximumReadLength = Math.max(maximumReadLength, length);
      readCount += 1;
      return fixture.archiveBytes.subarray(offset, offset + length);
    },
  });

  assert.equal(validation.rawArchiveSha256, sha256(fixture.archiveBytes));
  assert.equal(validation.rawArchiveByteLength, fixture.archiveBytes.byteLength);
  assert.equal(
    validation.runBundleManifestSha256,
    learningExternalEvidenceRunBundleDigest(fixture.runBundle),
  );
  assert.equal(validation.contracts.runBundle.evidence_binding_sha256,
    fixture.runBundle.evidence_binding_sha256);
  assert.ok(readCount > fixture.entries.length);
  assert.ok(maximumReadLength <= 1024 * 1024);

  const projection = readLearningExternalEvidenceArchiveProofV1(validation.proof);
  assert.equal(projection.raw_archive_sha256, validation.rawArchiveSha256);
  assert.equal(projection.raw_archive_byte_length, validation.rawArchiveByteLength);
  assert.equal(projection.run_bundle_manifest_sha256,
    validation.runBundleManifestSha256);
  assert.throws(
    () => readLearningExternalEvidenceArchiveProofV1(Object.freeze(Object.create(null))),
    /unrecognized_proof/u,
  );

  const fromBytes = verifyLearningExternalEvidenceArchiveBytesV1(fixture.archiveBytes);
  assert.equal(fromBytes.rawArchiveSha256, validation.rawArchiveSha256);
});

test("raw archive rejects noncanonical, BOM, duplicate-key, and invalid UTF-8 manifest bytes", () => {
  const fixture = buildArchiveFixture();
  const prettyManifest = Buffer.from(JSON.stringify(fixture.runBundle, null, 2), "utf8");
  assert.throws(
    () => verifyLearningExternalEvidenceArchiveBytesV1(
      encodeArchive(prettyManifest, fixture.entries),
    ),
    /canonical JSON/u,
  );

  const bomManifest = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    fixture.manifestBytes,
  ]);
  assert.throws(
    () => verifyLearningExternalEvidenceArchiveBytesV1(
      encodeArchive(bomManifest, fixture.entries),
    ),
    /byte-order mark/u,
  );

  const contractNeedle =
    '"contract_version":"aionis_learning_external_evidence_run_bundle_v1"';
  const duplicateContract = Buffer.from(
    fixture.manifestBytes.toString("utf8").replace(
      contractNeedle,
      contractNeedle + "," + contractNeedle,
    ),
    "utf8",
  );
  assert.throws(
    () => verifyLearningExternalEvidenceArchiveBytesV1(
      encodeArchive(duplicateContract, fixture.entries),
    ),
    /canonical JSON without duplicate keys/u,
  );

  assert.throws(
    () => verifyLearningExternalEvidenceArchiveBytesV1(
      encodeArchive(Uint8Array.from([0xff]), fixture.entries),
    ),
    /valid UTF-8/u,
  );
});

test("raw archive rejects missing, extra, duplicate, reordered, aliased, and trailing entries", () => {
  const fixture = buildArchiveFixture();
  assert.throws(
    () => verifyLearningExternalEvidenceArchiveBytesV1(
      encodeArchive(fixture.manifestBytes, fixture.entries.slice(0, -1)),
    ),
    /missing_member/u,
  );
  assert.throws(
    () => verifyLearningExternalEvidenceArchiveBytesV1(
      encodeArchive(fixture.manifestBytes, [
        ...fixture.entries,
        { path: "unexpected.bin", bytes: Buffer.alloc(0) },
      ]),
    ),
    /extra_member/u,
  );

  const duplicate = [...fixture.entries];
  duplicate[1] = { ...duplicate[1]!, path: duplicate[0]!.path };
  assert.throws(
    () => verifyLearningExternalEvidenceArchiveBytesV1(
      encodeArchive(fixture.manifestBytes, duplicate),
    ),
    /duplicate_member_path/u,
  );

  const reordered = [...fixture.entries];
  [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
  assert.throws(
    () => verifyLearningExternalEvidenceArchiveBytesV1(
      encodeArchive(fixture.manifestBytes, reordered),
    ),
    /member_order/u,
  );

  const aliased = [...fixture.entries];
  aliased[0] = { ...aliased[0]!, path: "nested/../attempt-chain.json" };
  assert.throws(
    () => verifyLearningExternalEvidenceArchiveBytesV1(
      encodeArchive(fixture.manifestBytes, aliased),
    ),
    /member_path_alias/u,
  );

  assert.throws(
    () => verifyLearningExternalEvidenceArchiveBytesV1(
      Buffer.concat([fixture.archiveBytes, Buffer.from([0])]),
    ),
    /trailing_bytes/u,
  );
});

test("raw archive verifies original byte lengths/SHA and canonical JSON per structured role", () => {
  const fixture = buildArchiveFixture();
  const tampered = Buffer.from(fixture.archiveBytes);
  tampered[tampered.byteLength - 1] ^= 1;
  assert.throws(
    () => verifyLearningExternalEvidenceArchiveBytesV1(tampered),
    /member_sha256_mismatch/u,
  );

  const reportEntry = fixture.entries.find((entry) => entry.path === "report.json");
  assert.ok(reportEntry);
  const prettyReport = Buffer.from(
    JSON.stringify(JSON.parse(Buffer.from(reportEntry.bytes).toString("utf8")), null, 2),
    "utf8",
  );
  const prettyFixture = withManifestMember(fixture, "report.json", prettyReport);
  assert.throws(
    () => verifyLearningExternalEvidenceArchiveBytesV1(prettyFixture.archiveBytes),
    /canonical JSON/u,
  );

  const bomReport = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(reportEntry.bytes),
  ]);
  const bomFixture = withManifestMember(fixture, "report.json", bomReport);
  assert.throws(
    () => verifyLearningExternalEvidenceArchiveBytesV1(bomFixture.archiveBytes),
    /byte-order mark/u,
  );

  const binarySupport = fixture.entries.find((entry) => entry.path === "support/blob.bin");
  assert.ok(binarySupport);
  assert.equal(Buffer.from(binarySupport.bytes).includes(0xa5), true);
  assert.doesNotThrow(
    () => verifyLearningExternalEvidenceArchiveBytesV1(fixture.archiveBytes),
  );
});

test("raw archive rejects a structured member that differs from its public authority copy", () => {
  const fixture = buildArchiveFixture();
  const lifecycleEntry = fixture.entries.find(
    (entry) => entry.path === "lifecycle-authority-projection.json",
  );
  assert.ok(lifecycleEntry);
  const changedLifecycle = JSON.parse(
    Buffer.from(lifecycleEntry.bytes).toString("utf8"),
  ) as JsonObject;
  changedLifecycle.service_launcher_receipt_sha256 = sha256("different-launcher-receipt");
  const changedBytes = canonicalBytes(changedLifecycle);
  const withChangedMember = withManifestMember(
    fixture,
    "lifecycle-authority-projection.json",
    changedBytes,
  );
  const changedDigest = learningExternalEvidenceLifecycleAuthorityProjectionDigest(
    changedLifecycle,
  );
  const changedRunBundle = LearningExternalEvidenceRunBundleV1Schema.parse({
    ...withChangedMember.runBundle,
    lifecycle_authority_projection_sha256: changedDigest,
  });
  const changedManifest = canonicalBytes(changedRunBundle);
  assert.throws(
    () => verifyLearningExternalEvidenceArchiveBytesV1(
      encodeArchive(changedManifest, withChangedMember.entries),
    ),
    /public_authority_lifecycle_authority_projection_mismatch/u,
  );
});

test("raw archive requires exact reads and rejects mutable-source truncation", () => {
  const fixture = buildArchiveFixture();
  assert.throws(
    () => verifyLearningExternalEvidenceArchiveV1({
      byteLength: fixture.archiveBytes.byteLength,
      readExactly(offset, length) {
        const actual = Math.max(0, length - 1);
        return fixture.archiveBytes.subarray(offset, offset + actual);
      },
    }),
    /source_read_not_exact/u,
  );
});

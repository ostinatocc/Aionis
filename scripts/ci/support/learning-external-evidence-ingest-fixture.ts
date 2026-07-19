import {
  createHash,
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import stableStringify from "fast-json-stable-stringify";

import {
  ExternalExecutionPolicyV1Schema,
} from "../../../src/memory/learning-episode-ledger.js";
import {
  LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY,
  learningExternalReceiptDigest,
} from "../../../src/memory/learning-external-authority.js";
import {
  LearningExternalPublicRunAuthorityV1Schema,
  learningExternalBrokerServiceInstanceDigest,
  learningExternalPublicRunAuthorityDigest,
  learningExternalPublicRunAuthorityPayloadDigest,
} from "../../../packages/aionis-learning-authority/src/memory/learning-external-public-authority.js";
import {
  LEARNING_EXTERNAL_EVIDENCE_ARCHIVE_V1_MAGIC,
} from "../../../packages/aionis-learning-authority/src/memory/learning-external-evidence-archive.js";
import {
  LearningExternalAttemptChainV1Schema,
  LearningExternalEvidenceBindingV1Schema,
  LearningExternalEvidenceReportV1Schema,
  LearningExternalEvidenceRunBundleV1Schema,
  LearningExternalRunnerOutputManifestV1Schema,
  LearningExternalTerminalRunManifestV1Schema,
  learningExternalAttemptChainDigest,
  learningExternalEvidenceBindingDigest,
  learningExternalEvidenceLifecycleAuthorityProjectionDigest,
  learningExternalEvidenceReportDigest,
  learningExternalEvidenceRunBundleDigest,
  learningExternalEvidenceThresholdContractDigest,
  learningExternalPreterminalPayloadSetDigest,
  learningExternalRunnerOutputManifestDigest,
  learningExternalTerminalRunManifestDigest,
} from "../../../src/memory/learning-external-evidence.js";
import {
  LearningExperimentExternalInputSetV1Schema,
  learningExperimentApplicabilityManifestDigest,
} from "../../../src/memory/learning-experiment-provisioning.js";
import {
  createLearningExternalExecutionPolicyRegistryEntry,
} from "../../../src/memory/learning-external-execution-policy.js";
import {
  createLiteLearningEpisodeLedgerAccess,
  learningExternalRunReservationDigest,
  learningExternalTicketConsumptionDigest,
  LITE_LEARNING_LEDGER_REQUIRED_COLUMNS,
  type LiteLearningAuthorityRow,
} from "../../../src/store/lite-learning-episode-ledger.js";
import {
  resolveLiteLearningExternalNormalLifecycleSnapshot,
} from "../../../src/store/lite-learning-external-authority.js";
import {
  createLiteLearningExperimentProvisioner,
} from "../../../tools/learning-experiments/lite-learning-experiment-provisioning.js";
import type { LiteRuntimeDatabase } from "../../../src/store/lite-runtime-database.js";
import type {
  LiteLearningExternalEvidenceServiceInput,
} from "../../../packages/aionis-learning-authority/src/store/lite-learning-external-evidence-service.js";
import {
  inspectLiteRuntimeSchema,
  LITE_RUNTIME_WRITE_SCHEMA_VERSION,
} from "../../../src/store/lite-runtime-schema.js";
import {
  CONFIRMATORY_ACTOR,
  CONFIRMATORY_DEFAULT_TENANT_ID,
  CONFIRMATORY_EXPERIMENT_ID,
  CONFIRMATORY_EXPERIMENT_REVISION,
  CONFIRMATORY_NOW,
  CONFIRMATORY_TASK_FAMILY,
  CONFIRMATORY_TENANT_ID,
  createConfirmatoryExternalInputs,
  createConfirmatoryPassedRegistry,
  createConfirmatoryProfile,
  createConfirmatoryProvisionInput,
  ensureConfirmatoryTenantScopeAnchor,
  openConfirmatoryFixtureRuntime,
  seedConfirmatoryPriorScopes,
} from "./learning-experiment-confirmatory-fixture.js";

const EVIDENCE_SERIES_ID = "confirmatory-shadow-series-v1";
const RUN_ID = "confirmatory-shadow-run-v1";
const FIXTURE_ACTOR_ID = "external-evidence-ingester";
const FIXTURE_OPERATION_ID = "operation-ingest-external-evidence";

type CanonicalValue = Readonly<{ json: string; sha256: string }>;

type RevisionRow = Readonly<{
  experiment_id: string;
  experiment_revision: number;
  candidate_policy_id: string;
  candidate_policy_version: string;
  candidate_policy_implementation_sha256: string;
  candidate_policy_config_sha256: string;
  gate_policy_id: string;
  gate_policy_version: string;
  gate_policy_config_sha256: string;
}>;

export type LearningExternalEvidenceIngestFixture = Readonly<{
  rootDirectory: string;
  databasePath: string;
  evidenceRepositoryPath: string;
  archivePath: string;
  publicRunAuthorityPath: string;
  recordedAt: string;
  serviceInput: LiteLearningExternalEvidenceServiceInput;
  appendRealProjectorToolBranch(args: Readonly<{
    database: LiteRuntimeDatabase;
    branchKind:
      | "preclaim_hold"
      | "termination_hold_no_binding"
      | "termination_hold_with_binding";
  }>): Promise<LearningExternalProjectorToolBranchResult>;
}>;

export type LearningExternalProjectorToolBranchResult = Readonly<{
  branchKind:
    | "preclaim_hold"
    | "termination_hold_no_binding"
    | "termination_hold_with_binding";
  recordedAt: string;
  reservationId: string;
  ticketConsumptionId: string;
  preclaimHoldId: string | null;
  claimId: string | null;
  supervisorBindingId: string | null;
  sessionTerminationId: string | null;
  terminalFactSha256: string;
}>;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): CanonicalValue {
  const json = stableStringify(value);
  return Object.freeze({ json, sha256: sha256(json) });
}

function addSeconds(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + (seconds * 1_000)).toISOString();
}

function rawPublicKeyBase64(publicKey: KeyObject): string {
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(spki).subarray(-32).toString("base64");
}

function signReceipt<TBody extends Record<string, unknown>>(
  body: TBody,
  privateKey: KeyObject,
) {
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

function authorityRow(
  table: keyof typeof LITE_LEARNING_LEDGER_REQUIRED_COLUMNS,
  values: Record<string, string | number | Uint8Array | null>,
): LiteLearningAuthorityRow {
  const row = Object.fromEntries(
    LITE_LEARNING_LEDGER_REQUIRED_COLUMNS[table]
      .filter((column) => column !== "row_id")
      .map((column) => [column, null]),
  );
  return Object.assign(row, values) as LiteLearningAuthorityRow;
}

function encodeArchive(
  runBundle: ReturnType<typeof LearningExternalEvidenceRunBundleV1Schema.parse>,
  members: ReadonlyMap<string, Uint8Array>,
): Buffer {
  const uint16 = (value: number): Buffer => {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16BE(value);
    return bytes;
  };
  const uint32 = (value: number): Buffer => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
  };
  const uint64 = (value: number): Buffer => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(BigInt(value));
    return bytes;
  };
  const manifest = Buffer.from(stableStringify(runBundle), "utf8");
  const parts: Buffer[] = [
    Buffer.from(LEARNING_EXTERNAL_EVIDENCE_ARCHIVE_V1_MAGIC, "ascii"),
    uint32(manifest.byteLength),
    manifest,
    uint32(runBundle.members.length),
  ];
  for (const member of runBundle.members) {
    const bytes = members.get(member.path);
    if (!bytes) throw new Error(`external evidence fixture member missing: ${member.path}`);
    const pathBytes = Buffer.from(member.path, "utf8");
    parts.push(
      uint16(pathBytes.byteLength),
      pathBytes,
      uint64(bytes.byteLength),
      Buffer.from(bytes),
    );
  }
  return Buffer.concat(parts);
}

function runGit(repository: string, ...args: string[]): void {
  const result = spawnSync("/usr/bin/git", args, {
    cwd: repository,
    encoding: "utf8",
    env: {
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    shell: false,
  });
  if (result.status !== 0 || result.signal !== null || result.error) {
    throw new Error(
      `external evidence fixture git ${args.join(" ")} failed: ${result.stderr}`,
    );
  }
}

function assertCurrentDatabase(database: LiteRuntimeDatabase): void {
  const inspected = inspectLiteRuntimeSchema(database.db);
  if (inspected.classification !== "current"
    || inspected.detected_version !== LITE_RUNTIME_WRITE_SCHEMA_VERSION) {
    throw new Error("external evidence fixture did not produce a current Runtime database");
  }
}

export async function createLearningExternalEvidenceIngestFixture(): Promise<
  LearningExternalEvidenceIngestFixture
> {
  const tempRoot = realpathSync.native(homedir());
  const rootDirectory = realpathSync.native(
    mkdtempSync(join(tempRoot, "aionis-external-evidence-ingest-")),
  );
  chmodSync(rootDirectory, 0o700);
  const databasePath = join(rootDirectory, "runtime.sqlite");
  const runtime = openConfirmatoryFixtureRuntime(databasePath);
  let runtimeClosed = false;
  let succeeded = false;
  let evidenceRepositoryRoot: string | null = null;
  try {
    evidenceRepositoryRoot = mkdtempSync(
      join(realpathSync.native(tmpdir()), "aionis-external-evidence-repository-"));
    chmodSync(evidenceRepositoryRoot, 0o700);
    const evidenceRepositoryPath = realpathSync.native(evidenceRepositoryRoot);
    const ledger = createLiteLearningEpisodeLedgerAccess(runtime.database);
    const databaseInstanceId = await ledger.databaseInstanceId();
    const brokerKeys = generateKeyPairSync("ed25519");
    const launcherKeys = generateKeyPairSync("ed25519");
    const attestorKeys = generateKeyPairSync("ed25519");
    const brokerPublicKeyBase64 = rawPublicKeyBase64(brokerKeys.publicKey);
    const launcherPublicKeyBase64 = rawPublicKeyBase64(launcherKeys.publicKey);
    const attestorPublicKeyBase64 = rawPublicKeyBase64(attestorKeys.publicKey);
    const brokerPublicKeySha256 = sha256(Buffer.from(brokerPublicKeyBase64, "base64"));
    const launcherPublicKeySha256 = sha256(Buffer.from(launcherPublicKeyBase64, "base64"));
    const attestorPublicKeySha256 = sha256(Buffer.from(attestorPublicKeyBase64, "base64"));

    const baseRegistry = createConfirmatoryPassedRegistry();
    const baseExternalEntry = baseRegistry.resolveExternalExecutionPolicy(
      "external-execution-v1",
      databaseInstanceId,
    );
    if (!baseExternalEntry) {
      throw new Error("external evidence fixture policy registry is missing");
    }
    const withRealKeys = <TRole extends typeof baseExternalEntry.policy.roles.production_shadow>(
      role: TRole,
    ): TRole => ({
      ...role,
      broker_public_key_base64: brokerPublicKeyBase64,
      broker_public_key_sha256: brokerPublicKeySha256,
      service_launcher_public_key_sha256: launcherPublicKeySha256,
    });
    const externalPolicy = ExternalExecutionPolicyV1Schema.parse({
      ...baseExternalEntry.policy,
      runtime_authority_attestor: {
        ...baseExternalEntry.policy.runtime_authority_attestor,
        attestor_public_key_base64: attestorPublicKeyBase64,
        attestor_public_key_sha256: attestorPublicKeySha256,
        service_launcher_public_key_base64: launcherPublicKeyBase64,
        service_launcher_public_key_sha256: launcherPublicKeySha256,
      },
      roles: {
        offline_paired: withRealKeys(baseExternalEntry.policy.roles.offline_paired),
        production_shadow: withRealKeys(baseExternalEntry.policy.roles.production_shadow),
        tool_e2e: withRealKeys(baseExternalEntry.policy.roles.tool_e2e),
      },
    });
    const externalEntry = createLearningExternalExecutionPolicyRegistryEntry({
      registryKey: "external-execution-v1",
      databaseInstanceId,
      policy: externalPolicy,
    });
    const registry = {
      resolveCandidatePolicy: baseRegistry.resolveCandidatePolicy,
      resolveGatePolicy: baseRegistry.resolveGatePolicy,
      resolveExternalExecutionPolicy(registryKey: string, requestedDatabaseId: string) {
        return registryKey === externalEntry.registry_key
          && requestedDatabaseId === externalEntry.database_instance_id
          ? externalEntry
          : null;
      },
    };
    const productionRole = externalPolicy.roles.production_shadow;
    const toolRole = externalPolicy.roles.tool_e2e;
    const baseProfile = createConfirmatoryProfile();
    const baseExternalInputs = createConfirmatoryExternalInputs();
    const toolEvidenceSeriesId = baseProfile.experiment.required_evidence_series.tool_e2e;
    const toolRunId = baseExternalInputs.tool_e2e.planned_run_id;
    const candidate = registry.resolveCandidatePolicy(
      baseProfile.experiment.candidate_policy_id,
      baseProfile.experiment.candidate_policy_version,
    );
    const gate = registry.resolveGatePolicy(
      baseProfile.experiment.gate_policy_id,
      baseProfile.experiment.gate_policy_version,
    );
    const retryPolicy = canonical({
      contract_version: "aionis_learning_external_retry_policy_v1",
      max_formal_attempts: 1,
      retry_after_ticket_consumption: false,
      retry_after_claim: false,
    });
    const harnessBundleSha256 = sha256("harness:external-evidence-concurrency");
    const sourceSnapshotSha256 = sha256("source:external-evidence-concurrency");
    const executionProfileSha256 = sha256("profile:external-evidence-concurrency");
    const modelIdentitySha256 = sha256("model:external-evidence-concurrency");
    const immutableInputManifest = canonical({
      contract_version: "aionis_learning_external_immutable_input_manifest_v1",
      tenant_id: CONFIRMATORY_TENANT_ID,
      artifact_kind: "production_shadow_gate",
      evidence_series_id: EVIDENCE_SERIES_ID,
      task_family: CONFIRMATORY_TASK_FAMILY,
      applicable_experiment_id: CONFIRMATORY_EXPERIMENT_ID,
      applicable_experiment_revision: CONFIRMATORY_EXPERIMENT_REVISION,
      candidate_policy_id: candidate.policy_id,
      candidate_policy_version: candidate.policy_version,
      candidate_policy_implementation_sha256: candidate.implementation_contract_sha256,
      candidate_policy_config_sha256: candidate.policy_config_sha256,
      gate_policy_id: gate.policy_id,
      gate_policy_version: gate.policy_version,
      gate_policy_config_sha256: gate.policy_config_sha256,
      harness_bundle_sha256: harnessBundleSha256,
      source_snapshot_sha256: sourceSnapshotSha256,
      execution_profile_sha256: executionProfileSha256,
      model_identity_sha256: modelIdentitySha256,
      expected_runner_principal_sha256: productionRole.runner_principal_sha256,
      run_id: RUN_ID,
    });
    const toolHarnessBundleSha256 = sha256("harness:external-projector-tool");
    const toolSourceSnapshotSha256 = sha256("source:external-projector-tool");
    const toolExecutionProfileSha256 = sha256("profile:external-projector-tool");
    const toolModelIdentitySha256 = sha256("model:external-projector-tool");
    const toolManifestSha256 = sha256("tool-manifest:external-projector-tool");
    const toolImmutableInputManifest = canonical({
      contract_version: "aionis_learning_external_immutable_input_manifest_v1",
      tenant_id: CONFIRMATORY_TENANT_ID,
      artifact_kind: "tool_e2e_gate",
      evidence_series_id: toolEvidenceSeriesId,
      task_family: CONFIRMATORY_TASK_FAMILY,
      applicable_experiment_id: CONFIRMATORY_EXPERIMENT_ID,
      applicable_experiment_revision: CONFIRMATORY_EXPERIMENT_REVISION,
      candidate_policy_id: candidate.policy_id,
      candidate_policy_version: candidate.policy_version,
      candidate_policy_implementation_sha256: candidate.implementation_contract_sha256,
      candidate_policy_config_sha256: candidate.policy_config_sha256,
      gate_policy_id: gate.policy_id,
      gate_policy_version: gate.policy_version,
      gate_policy_config_sha256: gate.policy_config_sha256,
      harness_bundle_sha256: toolHarnessBundleSha256,
      source_snapshot_sha256: toolSourceSnapshotSha256,
      execution_profile_sha256: toolExecutionProfileSha256,
      model_identity_sha256: toolModelIdentitySha256,
      expected_runner_principal_sha256: toolRole.runner_principal_sha256,
      run_id: toolRunId,
      tool_manifest_sha256: toolManifestSha256,
    });
    const externalInputs = {
      ...baseExternalInputs,
      production_shadow: {
        immutable_input_manifest_sha256: immutableInputManifest.sha256,
        retry_policy_sha256: retryPolicy.sha256,
        planned_run_id: RUN_ID,
      },
      tool_e2e: {
        immutable_input_manifest_sha256: toolImmutableInputManifest.sha256,
        retry_policy_sha256: retryPolicy.sha256,
        planned_run_id: toolRunId,
      },
    };
    const profile = {
      ...baseProfile,
      experiment: {
        ...baseProfile.experiment,
        required_external_inputs: externalInputs,
        required_evidence_series: {
          ...baseProfile.experiment.required_evidence_series,
          production_shadow: EVIDENCE_SERIES_ID,
        },
      },
    };
    const externalInputSet = LearningExperimentExternalInputSetV1Schema.parse({
      contract_version: "aionis_learning_experiment_external_input_set_v1",
      tenant_id: CONFIRMATORY_TENANT_ID,
      task_family: CONFIRMATORY_TASK_FAMILY,
      experiment_id: CONFIRMATORY_EXPERIMENT_ID,
      experiment_revision: CONFIRMATORY_EXPERIMENT_REVISION,
      roles: externalInputs,
    });
    const provisionInput = createConfirmatoryProvisionInput({
      actor: CONFIRMATORY_ACTOR,
      profileRule: profile,
      externalInputSet,
    });
    await ensureConfirmatoryTenantScopeAnchor(runtime, CONFIRMATORY_DEFAULT_TENANT_ID);
    await seedConfirmatoryPriorScopes(
      runtime,
      provisionInput.memoryNamespaceManifest,
      CONFIRMATORY_DEFAULT_TENANT_ID,
    );
    const provisioned = await createLiteLearningExperimentProvisioner({
      database: runtime.database,
      writeStore: runtime.writeStore,
      dependencies: {
        registry,
        defaultTenantId: CONFIRMATORY_DEFAULT_TENANT_ID,
        now: () => CONFIRMATORY_NOW,
        randomBytes(size) {
          if (size === 32) return Uint8Array.from({ length: 32 }, (_, index) => index + 17);
          if (size === 48) return Uint8Array.from({ length: 48 }, (_, index) => index + 73);
          throw new Error(`unexpected external evidence fixture entropy size: ${String(size)}`);
        },
      },
    }).provision(provisionInput);
    const applicabilityManifest = provisioned.applicabilityManifest;
    if (applicabilityManifest.evidence_intent !== "confirmatory") {
      throw new Error("external evidence fixture requires confirmatory applicability");
    }
    const applicabilityManifestSha256 = learningExperimentApplicabilityManifestDigest(
      applicabilityManifest,
    );
    const revision = runtime.database.db.prepare(
      `SELECT experiment_id, experiment_revision,
              candidate_policy_id, candidate_policy_version,
              candidate_policy_implementation_sha256, candidate_policy_config_sha256,
              gate_policy_id, gate_policy_version, gate_policy_config_sha256
       FROM lite_learning_experiment_revisions
       WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
    ).get(
      CONFIRMATORY_TENANT_ID,
      CONFIRMATORY_EXPERIMENT_ID,
      CONFIRMATORY_EXPERIMENT_REVISION,
    ) as RevisionRow | undefined;
    if (!revision) throw new Error("external evidence fixture revision is missing");

    // Keep the signed 60-second broker window live while ensuring the bundle's
    // +5-second commit time is already in the past when a no-hook CLI starts.
    const operationAt = new Date(Date.now() - 15_000).toISOString();
    const runnerTicket = Buffer.alloc(32, 0x41);
    const reservationBase = authorityRow("lite_learning_external_run_reservations", {
      tenant_id: CONFIRMATORY_TENANT_ID,
      reservation_id: "reservation-external-evidence-concurrency",
      artifact_kind: "production_shadow_gate",
      evidence_series_id: EVIDENCE_SERIES_ID,
      task_family: CONFIRMATORY_TASK_FAMILY,
      candidate_policy_id: revision.candidate_policy_id,
      candidate_policy_version: revision.candidate_policy_version,
      candidate_policy_implementation_sha256:
        revision.candidate_policy_implementation_sha256,
      candidate_policy_config_sha256: revision.candidate_policy_config_sha256,
      applicable_experiment_id: revision.experiment_id,
      applicable_experiment_revision: revision.experiment_revision,
      gate_policy_id: revision.gate_policy_id,
      gate_policy_version: revision.gate_policy_version,
      gate_policy_config_sha256: revision.gate_policy_config_sha256,
      applicability_manifest_sha256: applicabilityManifestSha256,
      harness_bundle_sha256: harnessBundleSha256,
      source_snapshot_sha256: sourceSnapshotSha256,
      case_set_sha256: null,
      holdout_membership_projection_sha256: null,
      sealed_holdout_ref_sha256: null,
      sealed_holdout_ciphertext_sha256: null,
      execution_profile_sha256: executionProfileSha256,
      model_identity_sha256: modelIdentitySha256,
      immutable_model_snapshot_sha256: null,
      tool_manifest_sha256: null,
      execution_order_sha256: null,
      retry_policy_sha256: retryPolicy.sha256,
      retry_policy_json: retryPolicy.json,
      immutable_input_manifest_sha256: immutableInputManifest.sha256,
      immutable_input_manifest_json: immutableInputManifest.json,
      expected_runner_principal_sha256: productionRole.runner_principal_sha256,
      credential_broker_policy_sha256: productionRole.broker_policy_sha256,
      service_launcher_policy_sha256: productionRole.service_launcher_policy_sha256,
      service_launcher_binary_sha256: productionRole.service_launcher_binary_sha256,
      service_launcher_key_id: productionRole.service_launcher_key_id,
      supervisor_executable_sha256: productionRole.supervisor_executable_sha256,
      supervisor_argv_policy_sha256: productionRole.supervisor_argv_policy_sha256,
      supervisor_sandbox_policy_sha256: productionRole.supervisor_sandbox_policy_sha256,
      credential_session_class: productionRole.credential_session_class,
      run_id: RUN_ID,
      reserve_operation_id: "operation-reserve-external-evidence-concurrency",
      runner_ticket_sha256: sha256(runnerTicket),
      reservation_sha256: "0".repeat(64),
      reserved_at: operationAt,
    });
    const reservation = {
      ...reservationBase,
      reservation_sha256: learningExternalRunReservationDigest(reservationBase),
    } satisfies LiteLearningAuthorityRow;
    const brokerAuthority = {
      broker_service_identity: LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY,
      broker_policy_sha256: productionRole.broker_policy_sha256,
      broker_binary_sha256: productionRole.broker_binary_sha256,
      broker_public_key_sha256: productionRole.broker_public_key_sha256,
      broker_key_id: productionRole.broker_key_id,
    };
    const reservationAuthorityRequestSha256 = sha256(stableStringify({
      contract_version: "aionis_learning_external_reservation_authority_request_v1",
      reservation,
      holdout_member_sha256s: [],
      runner_ticket_sha256: reservation.runner_ticket_sha256,
    }));
    const reservationAuthorization = signReceipt({
      contract_version:
        "aionis_learning_external_run_reservation_authorization_receipt_v1" as const,
      tenant_id: CONFIRMATORY_TENANT_ID,
      database_instance_id: databaseInstanceId,
      reservation_id: String(reservation.reservation_id),
      artifact_kind: "production_shadow_gate" as const,
      evidence_series_id: EVIDENCE_SERIES_ID,
      external_role: "production_shadow" as const,
      applicable_experiment_id: revision.experiment_id,
      applicable_experiment_revision: revision.experiment_revision,
      run_id: RUN_ID,
      expected_runner_principal_sha256: productionRole.runner_principal_sha256,
      reserve_operation_id: String(reservation.reserve_operation_id),
      reservation_sha256: String(reservation.reservation_sha256),
      runner_ticket_sha256: String(reservation.runner_ticket_sha256),
      authority_request_sha256: reservationAuthorityRequestSha256,
      ...brokerAuthority,
      authorized_at: operationAt,
      authorization_expires_at: addSeconds(operationAt, 60),
    }, brokerKeys.privateKey);
    await runtime.database.transaction.run(async () => {
      await ledger.reserveExternalRun({
        reservation,
        runnerTicket,
        authorization: reservationAuthorization,
      });
    });

    const consumptionBase = authorityRow("lite_learning_external_ticket_consumptions", {
      tenant_id: CONFIRMATORY_TENANT_ID,
      consumption_id: "consumption-external-evidence-concurrency",
      reservation_id: reservation.reservation_id,
      runner_ticket_sha256: reservation.runner_ticket_sha256,
      runner_principal_sha256: productionRole.runner_principal_sha256,
      broker_process_nonce_sha256: sha256("broker-process:external-evidence-concurrency"),
      consume_operation_id: "operation-consume-external-evidence-concurrency",
      consumed_at: operationAt,
      consumption_sha256: "0".repeat(64),
    });
    const consumption = {
      ...consumptionBase,
      consumption_sha256: learningExternalTicketConsumptionDigest(consumptionBase),
    } satisfies LiteLearningAuthorityRow;
    const consumptionAuthorityRequestSha256 = sha256(stableStringify({
      contract_version: "aionis_learning_external_ticket_consumption_authority_request_v1",
      consumption,
      reservation_sha256: reservation.reservation_sha256,
      runner_ticket_sha256: consumption.runner_ticket_sha256,
    }));
    const consumptionAuthorization = signReceipt({
      contract_version:
        "aionis_learning_external_ticket_consumption_authorization_receipt_v1" as const,
      tenant_id: CONFIRMATORY_TENANT_ID,
      database_instance_id: databaseInstanceId,
      reservation_id: String(reservation.reservation_id),
      consumption_id: String(consumption.consumption_id),
      artifact_kind: "production_shadow_gate" as const,
      evidence_series_id: EVIDENCE_SERIES_ID,
      external_role: "production_shadow" as const,
      applicable_experiment_id: revision.experiment_id,
      applicable_experiment_revision: revision.experiment_revision,
      run_id: RUN_ID,
      consume_operation_id: String(consumption.consume_operation_id),
      reservation_sha256: String(reservation.reservation_sha256),
      consumption_sha256: String(consumption.consumption_sha256),
      runner_ticket_sha256: String(consumption.runner_ticket_sha256),
      runner_principal_sha256: String(consumption.runner_principal_sha256),
      broker_process_nonce_sha256: String(consumption.broker_process_nonce_sha256),
      authority_request_sha256: consumptionAuthorityRequestSha256,
      ...brokerAuthority,
      authorized_at: operationAt,
      authorization_expires_at: addSeconds(operationAt, 60),
    }, brokerKeys.privateKey);
    await runtime.database.transaction.run(async () => {
      await ledger.consumeExternalTicket({
        consumption,
        runnerTicket,
        authorization: consumptionAuthorization,
      });
    });

    const claimBody = {
      contract_version: "aionis_learning_external_claim_receipt_v1" as const,
      tenant_id: CONFIRMATORY_TENANT_ID,
      reservation_id: String(reservation.reservation_id),
      ticket_consumption_id: String(consumption.consumption_id),
      claim_id: "claim-external-evidence-concurrency",
      ticket_consumption_sha256: String(consumption.consumption_sha256),
      runner_ticket_sha256: String(reservation.runner_ticket_sha256),
      runner_principal_sha256: productionRole.runner_principal_sha256,
      runner_execution_nonce_sha256: sha256("runner-execution:external-evidence-concurrency"),
      credential_scope_sha256: productionRole.credential_scope_sha256,
      credential_session_class: productionRole.credential_session_class,
      credential_session_id_sha256: sha256("credential-session:external-evidence-concurrency"),
      supervisor_bind_expires_at: addSeconds(
        operationAt,
        productionRole.supervisor_bind_ttl_seconds,
      ),
      credential_session_expires_at: addSeconds(
        operationAt,
        productionRole.credential_session_hard_ttl_seconds,
      ),
      credential_session_heartbeat_seconds: productionRole.credential_session_heartbeat_seconds,
      credential_session_max_calls: productionRole.credential_session_max_calls,
      per_call_capability_ttl_seconds: productionRole.per_call_capability_ttl_seconds,
      post_quiesce_finalize_ttl_seconds: productionRole.post_quiesce_finalize_ttl_seconds,
      ...brokerAuthority,
      claimed_at: operationAt,
    };
    const claimReceipt = signReceipt(claimBody, brokerKeys.privateKey);
    await runtime.database.transaction.run(async () => {
      await ledger.claimExternalRun({ receipt: claimReceipt });
    });

    const launcherBody = {
      contract_version: "aionis_learning_external_launcher_spawn_receipt_v1" as const,
      tenant_id: CONFIRMATORY_TENANT_ID,
      reservation_id: String(reservation.reservation_id),
      ticket_consumption_id: String(consumption.consumption_id),
      claim_id: claimBody.claim_id,
      credential_session_id_sha256: claimBody.credential_session_id_sha256,
      broker_challenge_sha256: sha256("broker-challenge:external-evidence-concurrency"),
      runner_principal_sha256: productionRole.runner_principal_sha256,
      runner_uid: 501,
      runner_gid: 20,
      supervisor_pid: 4242,
      supervisor_process_start_identity_sha256: sha256("process-start:external-evidence"),
      supervisor_cgroup_identity_sha256: sha256("cgroup:external-evidence"),
      supervisor_service_job_identity_sha256: sha256("service-job:external-evidence"),
      supervisor_process_identity_sha256: sha256("process:external-evidence"),
      supervisor_executable_sha256: productionRole.supervisor_executable_sha256,
      supervisor_argv_policy_sha256: productionRole.supervisor_argv_policy_sha256,
      supervisor_argv_sha256: sha256("argv:external-evidence"),
      inherited_channel_sha256: sha256("inherited-channel:external-evidence"),
      broker_channel_fingerprint_sha256: sha256("broker-channel:external-evidence"),
      supervisor_channel_fingerprint_sha256: sha256("supervisor-channel:external-evidence"),
      service_launcher_policy_sha256: productionRole.service_launcher_policy_sha256,
      service_launcher_binary_sha256: productionRole.service_launcher_binary_sha256,
      service_launcher_public_key_sha256: launcherPublicKeySha256,
      service_launcher_key_id: productionRole.service_launcher_key_id,
      supervisor_sandbox_policy_sha256: productionRole.supervisor_sandbox_policy_sha256,
      spawned_at: operationAt,
    };
    const launcherReceipt = signReceipt(launcherBody, launcherKeys.privateKey);
    const bindingBody = {
      contract_version:
        "aionis_learning_external_broker_supervisor_binding_receipt_v1" as const,
      tenant_id: CONFIRMATORY_TENANT_ID,
      reservation_id: String(reservation.reservation_id),
      ticket_consumption_id: String(consumption.consumption_id),
      binding_id: "binding-external-evidence-concurrency",
      claim_id: claimBody.claim_id,
      credential_session_id_sha256: claimBody.credential_session_id_sha256,
      runner_principal_sha256: productionRole.runner_principal_sha256,
      supervisor_process_identity_sha256: launcherBody.supervisor_process_identity_sha256,
      supervisor_executable_sha256: launcherBody.supervisor_executable_sha256,
      supervisor_argv_policy_sha256: launcherBody.supervisor_argv_policy_sha256,
      supervisor_argv_sha256: launcherBody.supervisor_argv_sha256,
      inherited_channel_sha256: launcherBody.inherited_channel_sha256,
      service_launcher_receipt_sha256: learningExternalReceiptDigest(launcherReceipt),
      service_launcher_receipt: launcherReceipt,
      service_launcher_policy_sha256: launcherBody.service_launcher_policy_sha256,
      service_launcher_binary_sha256: launcherBody.service_launcher_binary_sha256,
      service_launcher_public_key_sha256: launcherBody.service_launcher_public_key_sha256,
      service_launcher_key_id: launcherBody.service_launcher_key_id,
      supervisor_sandbox_policy_sha256: launcherBody.supervisor_sandbox_policy_sha256,
      ...brokerAuthority,
      bound_at: operationAt,
    };
    const bindingReceipt = signReceipt(bindingBody, brokerKeys.privateKey);
    await runtime.database.transaction.run(async () => {
      await ledger.bindExternalSupervisor({ receipt: bindingReceipt });
    });

    const sourceBundleBytes = Buffer.from("source-bundle:external-evidence-concurrency", "utf8");
    const sourceBundleSha256 = sha256(sourceBundleBytes);
    const sourceCommitId = sha256("source-commit:external-evidence-concurrency");
    const evidenceBinding = LearningExternalEvidenceBindingV1Schema.parse({
      contract_version: "aionis_learning_external_evidence_binding_v1",
      artifact_kind: "production_shadow_gate",
      tenant_id: CONFIRMATORY_TENANT_ID,
      database_instance_id: databaseInstanceId,
      evidence_series_id: EVIDENCE_SERIES_ID,
      task_family: CONFIRMATORY_TASK_FAMILY,
      applicable_experiment_id: revision.experiment_id,
      applicable_experiment_revision: revision.experiment_revision,
      candidate_policy_id: revision.candidate_policy_id,
      candidate_policy_version: revision.candidate_policy_version,
      candidate_policy_implementation_sha256:
        revision.candidate_policy_implementation_sha256,
      candidate_policy_config_sha256: revision.candidate_policy_config_sha256,
      gate_policy_id: revision.gate_policy_id,
      gate_policy_version: revision.gate_policy_version,
      gate_policy_config_sha256: revision.gate_policy_config_sha256,
      applicability_manifest_sha256: applicabilityManifestSha256,
      evidence_scope_set_sha256: sha256("evidence-scope-set:external-evidence-concurrency"),
      immutable_input_manifest_sha256: immutableInputManifest.sha256,
      retry_policy_sha256: retryPolicy.sha256,
      harness_bundle_sha256: harnessBundleSha256,
      source_snapshot_sha256: sourceSnapshotSha256,
      run_id: RUN_ID,
    });
    const evidenceBindingSha256 = learningExternalEvidenceBindingDigest(evidenceBinding);
    const evidenceReport = LearningExternalEvidenceReportV1Schema.parse({
      ...evidenceBinding,
      contract_version: "aionis_learning_external_evidence_report_v1",
      evidence_binding_sha256: evidenceBindingSha256,
      artifact_status: "failed",
      source_experiment_id: "source-experiment-external-evidence",
      source_experiment_revision: 1,
      source_serving_phase: "shadow",
      source_bundle_sha256: sourceBundleSha256,
      collected_at: operationAt,
      reason_codes: ["no_hard_boundary_upgrade"],
      payload: {
        contract_version: "aionis_learning_external_production_shadow_report_payload_v1",
        evidence_status: "failed",
        row_count: 1_000,
        run_count: 10,
        task_signature_count: 30,
        scope_count: 5,
        projection_present_count: 1_000,
        source_row_set_sha256: sha256("source-row-set:external-evidence"),
        source_run_set_sha256: sha256("source-run-set:external-evidence"),
        shadow_projection_set_sha256: sha256("shadow-projection-set:external-evidence"),
        host_adapter_conformance_sha256: sha256("host-adapter:external-evidence"),
        fixed_threshold_contract_sha256: learningExternalEvidenceThresholdContractDigest(),
        online_mode: "shadow",
        shadow_projection_source_count: 1_000,
        agent_prompt_included_count: 0,
        runtime_mutation_count: 0,
        hard_boundary_upgrade_count: 1,
        selected_candidate_policy_id: revision.candidate_policy_id,
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
    });
    const evidenceReportSha256 = learningExternalEvidenceReportDigest(evidenceReport);
    const attemptChain = LearningExternalAttemptChainV1Schema.parse({
      contract_version: "aionis_learning_external_attempt_chain_v1",
      evidence_binding_sha256: evidenceBindingSha256,
      reservation_id: reservation.reservation_id,
      ticket_consumption_id: consumption.consumption_id,
      claim_id: claimBody.claim_id,
      supervisor_binding_id: bindingBody.binding_id,
      credential_session_max_calls: productionRole.credential_session_max_calls,
      attempts: [],
      sealed_at: operationAt,
    });
    const attemptChainSha256 = learningExternalAttemptChainDigest(attemptChain);
    const preterminalPayloadSetSha256 = learningExternalPreterminalPayloadSetDigest({
      contract_version: "aionis_learning_external_preterminal_payload_set_v1",
      evidence_binding_sha256: evidenceBindingSha256,
      report_sha256: evidenceReportSha256,
      attempt_chain_sha256: attemptChainSha256,
      source_bundle_sha256: sourceBundleSha256,
      harness_bundle_sha256: harnessBundleSha256,
    });
    const runnerOutputManifest = LearningExternalRunnerOutputManifestV1Schema.parse({
      contract_version: "aionis_learning_external_runner_output_manifest_v1",
      evidence_binding_sha256: evidenceBindingSha256,
      artifact_kind: "production_shadow_gate",
      artifact_status: "failed",
      reservation_id: reservation.reservation_id,
      ticket_consumption_id: consumption.consumption_id,
      claim_id: claimBody.claim_id,
      supervisor_binding_id: bindingBody.binding_id,
      report_sha256: evidenceReportSha256,
      attempt_chain_sha256: attemptChainSha256,
      source_bundle_sha256: sourceBundleSha256,
      harness_bundle_sha256: harnessBundleSha256,
      preterminal_payload_set_sha256: preterminalPayloadSetSha256,
      source_ref: "evals/learning-episode-gate-v1/runs/concurrency",
      source_commit_id: sourceCommitId,
      collected_at: operationAt,
    });
    const runnerOutputManifestSha256 = learningExternalRunnerOutputManifestDigest(
      runnerOutputManifest,
    );
    const terminalRunManifest = LearningExternalTerminalRunManifestV1Schema.parse({
      contract_version: "aionis_learning_external_terminal_run_manifest_v1",
      evidence_binding_sha256: evidenceBindingSha256,
      artifact_kind: "production_shadow_gate",
      artifact_status: "failed",
      reservation_id: reservation.reservation_id,
      ticket_consumption_id: consumption.consumption_id,
      claim_id: claimBody.claim_id,
      supervisor_binding_id: bindingBody.binding_id,
      report_sha256: evidenceReportSha256,
      attempt_chain_sha256: attemptChainSha256,
      runner_output_manifest_sha256: runnerOutputManifestSha256,
      source_bundle_sha256: sourceBundleSha256,
      harness_bundle_sha256: harnessBundleSha256,
      preterminal_payload_set_sha256: preterminalPayloadSetSha256,
      source_ref: runnerOutputManifest.source_ref,
      source_commit_id: sourceCommitId,
      finalized_at: operationAt,
    });
    const terminalRunManifestSha256 = learningExternalTerminalRunManifestDigest(
      terminalRunManifest,
    );
    const quiesceBody = {
      contract_version: "aionis_learning_external_clean_quiesce_receipt_v1" as const,
      tenant_id: CONFIRMATORY_TENANT_ID,
      reservation_id: String(reservation.reservation_id),
      ticket_consumption_id: String(consumption.consumption_id),
      claim_id: claimBody.claim_id,
      supervisor_binding_id: bindingBody.binding_id,
      credential_session_id_sha256: claimBody.credential_session_id_sha256,
      runner_output_manifest_sha256: runnerOutputManifestSha256,
      attempt_chain_sha256: attemptChainSha256,
      cleanup_proof_sha256: sha256("cleanup-proof:external-evidence"),
      post_revoke_access_denial_proof_sha256: sha256("post-revoke:external-evidence"),
      finalize_deadline_at: addSeconds(
        operationAt,
        productionRole.post_quiesce_finalize_ttl_seconds,
      ),
      ...brokerAuthority,
      quiesced_at: operationAt,
    };
    const quiesceReceipt = signReceipt(quiesceBody, brokerKeys.privateKey);
    const terminationReceipt = signReceipt({
      contract_version:
        "aionis_learning_external_session_termination_receipt_v1" as const,
      tenant_id: CONFIRMATORY_TENANT_ID,
      reservation_id: String(reservation.reservation_id),
      ticket_consumption_id: String(consumption.consumption_id),
      termination_id: "termination-external-evidence-concurrency",
      claim_id: claimBody.claim_id,
      supervisor_binding_id: bindingBody.binding_id,
      credential_session_id_sha256: claimBody.credential_session_id_sha256,
      termination_reason: "failed" as const,
      broker_quiesce_receipt_sha256: learningExternalReceiptDigest(quiesceReceipt),
      broker_quiesce_receipt: quiesceReceipt,
      runner_output_manifest_sha256: runnerOutputManifestSha256,
      terminal_run_manifest_sha256: terminalRunManifestSha256,
      attempt_chain_sha256: attemptChainSha256,
      ...brokerAuthority,
      terminated_at: operationAt,
    }, brokerKeys.privateKey);
    await runtime.database.transaction.run(async () => {
      await ledger.terminateExternalSession({ receipt: terminationReceipt });
    });

    const lifecycle = resolveLiteLearningExternalNormalLifecycleSnapshot(
      runtime.database.db,
      {
        tenantId: CONFIRMATORY_TENANT_ID,
        reservationId: String(reservation.reservation_id),
        evidenceBindingSha256,
      },
    );
    const brokerUid = typeof process.getuid === "function" ? process.getuid() : 502;
    const brokerGid = typeof process.getgid === "function" ? process.getgid() : 20;
    const brokerServiceInstanceIdentity = {
      contract_version:
        "aionis_learning_external_broker_service_instance_identity_v1" as const,
      tenant_id: CONFIRMATORY_TENANT_ID,
      database_instance_id: databaseInstanceId,
      broker_service_identity: LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY,
      broker_uid: brokerUid,
      broker_gid: brokerGid,
      broker_pid: process.pid,
      broker_process_start_identity_sha256: sha256("broker-process-start:external-evidence"),
      broker_cgroup_identity_sha256: sha256("broker-cgroup:external-evidence"),
      broker_service_job_identity_sha256: sha256("broker-service-job:external-evidence"),
      broker_socket_device_identity: "device-external-evidence",
      broker_socket_inode: 104_729,
    };
    const brokerServiceInstanceSha256 = learningExternalBrokerServiceInstanceDigest(
      brokerServiceInstanceIdentity,
    );
    const brokerServiceLaunchReceipt = signReceipt({
      contract_version: "aionis_learning_external_broker_service_launch_receipt_v1" as const,
      tenant_id: CONFIRMATORY_TENANT_ID,
      database_instance_id: databaseInstanceId,
      broker_service_identity: LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY,
      broker_service_instance_sha256: brokerServiceInstanceSha256,
      launched_broker_policy_sha256: productionRole.broker_policy_sha256,
      launched_broker_binary_sha256: productionRole.broker_binary_sha256,
      launched_broker_public_key_sha256: productionRole.broker_public_key_sha256,
      launched_broker_key_id: productionRole.broker_key_id,
      broker_uid: brokerUid,
      broker_gid: brokerGid,
      broker_pid: process.pid,
      broker_process_start_identity_sha256:
        brokerServiceInstanceIdentity.broker_process_start_identity_sha256,
      broker_cgroup_identity_sha256: brokerServiceInstanceIdentity.broker_cgroup_identity_sha256,
      broker_service_job_identity_sha256:
        brokerServiceInstanceIdentity.broker_service_job_identity_sha256,
      broker_socket_device_identity: brokerServiceInstanceIdentity.broker_socket_device_identity,
      broker_socket_inode: brokerServiceInstanceIdentity.broker_socket_inode,
      broker_socket_identity_sha256: sha256("broker-socket:external-evidence"),
      broker_socket_mode: 0o600 as const,
      broker_socket_owner_uid: brokerUid,
      broker_socket_owner_gid: brokerGid,
      private_state_root_acl_sha256: sha256("broker-private-state:external-evidence"),
      terminal_fact_spool_acl_sha256: sha256("broker-spool:external-evidence"),
      launcher_channel_fingerprint_sha256: sha256("broker-launcher:external-evidence"),
      service_launcher_policy_sha256: productionRole.service_launcher_policy_sha256,
      service_launcher_binary_sha256: productionRole.service_launcher_binary_sha256,
      service_launcher_public_key_sha256: launcherPublicKeySha256,
      service_launcher_key_id: productionRole.service_launcher_key_id,
      launched_at: operationAt,
    }, launcherKeys.privateKey);
    const brokerHealthReceipt = signReceipt({
      contract_version: "aionis_learning_external_broker_health_receipt_v1" as const,
      tenant_id: CONFIRMATORY_TENANT_ID,
      database_instance_id: databaseInstanceId,
      health_id: "broker-health-external-evidence-concurrency",
      broker_service_instance_sha256: brokerServiceInstanceSha256,
      challenge_sha256: sha256("broker-health-challenge:external-evidence"),
      service_launch_receipt_sha256: learningExternalReceiptDigest(
        brokerServiceLaunchReceipt,
      ),
      service_launch_receipt: brokerServiceLaunchReceipt,
      peer_credentials_enforced: true as const,
      stdin_only_runner_ticket: true as const,
      runner_ticket_prefetched_before_spawn: true as const,
      runner_ticket_path_input_allowed: false as const,
      caller_selected_output_path_authority: false as const,
      private_state_root_owner_only: true as const,
      terminal_fact_spool_owner_only: true as const,
      unacknowledged_startup_recovery_count: 0 as const,
      ...brokerAuthority,
      checked_at: operationAt,
    }, brokerKeys.privateKey);
    const publicAuthorityPayload = {
      contract_version: "aionis_learning_external_public_run_authority_payload_v1" as const,
      tenant_id: CONFIRMATORY_TENANT_ID,
      database_instance_id: databaseInstanceId,
      evidence_binding_sha256: evidenceBindingSha256,
      artifact_kind: "production_shadow_gate" as const,
      broker_health_receipt: brokerHealthReceipt,
      reservation: {
        row: lifecycle.reservation,
        holdout_members: lifecycle.holdoutMembers,
        operation: lifecycle.operations.reservation,
      },
      ticket_consumption: {
        row: lifecycle.consumption,
        operation: lifecycle.operations.consumption,
      },
      claim: { row: lifecycle.claim, operation: lifecycle.operations.claim },
      supervisor_binding: {
        row: lifecycle.binding,
        operation: lifecycle.operations.binding,
      },
      session_termination: {
        row: lifecycle.termination,
        operation: lifecycle.operations.termination,
      },
      report: evidenceReport,
      attempt_chain: attemptChain,
      runner_output_manifest: runnerOutputManifest,
      terminal_run_manifest: terminalRunManifest,
      lifecycle_authority_projection: lifecycle.lifecycleAuthorityProjection,
      assembled_at: addSeconds(operationAt, 1),
    };
    const publicAuthorityPayloadSha256 = learningExternalPublicRunAuthorityPayloadDigest(
      publicAuthorityPayload,
    );
    const terminalFactDrainReceipt = signReceipt({
      contract_version: "aionis_learning_external_terminal_fact_drain_receipt_v1" as const,
      tenant_id: CONFIRMATORY_TENANT_ID,
      database_instance_id: databaseInstanceId,
      drain_id: "terminal-fact-drain-external-evidence-concurrency",
      broker_service_instance_sha256: brokerServiceInstanceSha256,
      broker_health_receipt_sha256: learningExternalReceiptDigest(brokerHealthReceipt),
      entries: [{
        fact_kind: "session_termination" as const,
        tenant_id: CONFIRMATORY_TENANT_ID,
        reservation_id: String(lifecycle.reservation.reservation_id),
        reservation_sha256: String(lifecycle.reservation.reservation_sha256),
        export_subdirectory: String(lifecycle.reservation.reservation_sha256),
        ticket_consumption_id: String(lifecycle.consumption.consumption_id),
        broker_process_nonce_sha256: String(
          lifecycle.consumption.broker_process_nonce_sha256,
        ),
        fact_id: String(lifecycle.termination.termination_id),
        fact_sha256: String(lifecycle.termination.termination_sha256),
        signed_receipt_sha256: String(
          lifecycle.termination.broker_terminal_receipt_sha256,
        ),
        operation_id: lifecycle.operations.termination.operation_id,
        operation_request_sha256: lifecycle.operations.termination.request_sha256,
        authority_record_sha256: lifecycle.operations.termination.authority_record_sha256,
        public_run_authority_payload_sha256: publicAuthorityPayloadSha256,
        acknowledged_at: addSeconds(operationAt, 2),
        exported_at: addSeconds(operationAt, 3),
      }],
      ...brokerAuthority,
      drained_at: addSeconds(operationAt, 4),
    }, brokerKeys.privateKey);
    const publicRunAuthority = LearningExternalPublicRunAuthorityV1Schema.parse({
      contract_version: "aionis_learning_external_public_run_authority_v1",
      payload: publicAuthorityPayload,
      terminal_fact_drain_receipt: terminalFactDrainReceipt,
    });
    const publicRunAuthoritySha256 = learningExternalPublicRunAuthorityDigest(
      publicRunAuthority,
    );
    const lifecycleProjectionSha256 =
      learningExternalEvidenceLifecycleAuthorityProjectionDigest(
        lifecycle.lifecycleAuthorityProjection,
      );
    const canonicalBytes = (value: unknown): Buffer =>
      Buffer.from(stableStringify(value), "utf8");
    const byteLength = (value: unknown): number => canonicalBytes(value).byteLength;
    const runBundle = LearningExternalEvidenceRunBundleV1Schema.parse({
      contract_version: "aionis_learning_external_evidence_run_bundle_v1",
      evidence_binding_sha256: evidenceBindingSha256,
      artifact_kind: "production_shadow_gate",
      artifact_status: "failed",
      lifecycle_authority_projection_sha256: lifecycleProjectionSha256,
      public_run_authority_sha256: publicRunAuthoritySha256,
      reservation_id: lifecycle.reservation.reservation_id,
      ticket_consumption_id: lifecycle.consumption.consumption_id,
      claim_id: lifecycle.claim.claim_id,
      supervisor_binding_id: lifecycle.binding.binding_id,
      session_termination_id: lifecycle.termination.termination_id,
      session_termination_sha256: lifecycle.termination.termination_sha256,
      report_sha256: evidenceReportSha256,
      attempt_chain_sha256: attemptChainSha256,
      runner_output_manifest_sha256: runnerOutputManifestSha256,
      terminal_run_manifest_sha256: terminalRunManifestSha256,
      source_bundle_sha256: sourceBundleSha256,
      harness_bundle_sha256: harnessBundleSha256,
      preterminal_payload_set_sha256: preterminalPayloadSetSha256,
      source_ref: runnerOutputManifest.source_ref,
      source_commit_id: sourceCommitId,
      members: [
        {
          path: "attempt-chain.json",
          role: "attempt_chain",
          byte_length: byteLength(attemptChain),
          sha256: attemptChainSha256,
        },
        {
          path: "lifecycle-authority-projection.json",
          role: "lifecycle_authority_projection",
          byte_length: byteLength(lifecycle.lifecycleAuthorityProjection),
          sha256: lifecycleProjectionSha256,
        },
        {
          path: "public-run-authority.json",
          role: "public_run_authority",
          byte_length: byteLength(publicRunAuthority),
          sha256: publicRunAuthoritySha256,
        },
        {
          path: "report.json",
          role: "report",
          byte_length: byteLength(evidenceReport),
          sha256: evidenceReportSha256,
        },
        {
          path: "runner-output-manifest.json",
          role: "runner_output_manifest",
          byte_length: byteLength(runnerOutputManifest),
          sha256: runnerOutputManifestSha256,
        },
        {
          path: "source-bundle.bin",
          role: "source_bundle",
          byte_length: sourceBundleBytes.byteLength,
          sha256: sourceBundleSha256,
        },
        {
          path: "terminal-run-manifest.json",
          role: "terminal_run_manifest",
          byte_length: byteLength(terminalRunManifest),
          sha256: terminalRunManifestSha256,
        },
      ],
      committed_at: addSeconds(operationAt, 5),
    });
    // Force the formal digest derivation in the fixture itself before any file is tracked.
    learningExternalEvidenceRunBundleDigest(runBundle);
    const archiveBytes = encodeArchive(runBundle, new Map([
      ["attempt-chain.json", canonicalBytes(attemptChain)],
      ["lifecycle-authority-projection.json",
        canonicalBytes(lifecycle.lifecycleAuthorityProjection)],
      ["public-run-authority.json", canonicalBytes(publicRunAuthority)],
      ["report.json", canonicalBytes(evidenceReport)],
      ["runner-output-manifest.json", canonicalBytes(runnerOutputManifest)],
      ["source-bundle.bin", sourceBundleBytes],
      ["terminal-run-manifest.json", canonicalBytes(terminalRunManifest)],
    ]));

    const archivePath = join(evidenceRepositoryPath, "run-bundle.aionis");
    const publicRunAuthorityPath = join(
      evidenceRepositoryPath,
      "public-run-authority.json",
    );
    writeFileSync(archivePath, archiveBytes, { flag: "wx", mode: 0o600 });
    writeFileSync(publicRunAuthorityPath, canonicalBytes(publicRunAuthority), {
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(archivePath, 0o600);
    chmodSync(publicRunAuthorityPath, 0o600);
    runGit(evidenceRepositoryPath, "init", "-q", "--template=");
    runGit(evidenceRepositoryPath, "config", "user.name", "Aionis CI");
    runGit(
      evidenceRepositoryPath,
      "config",
      "user.email",
      "aionis-ci@example.invalid",
    );
    runGit(
      evidenceRepositoryPath,
      "add",
      "--",
      "run-bundle.aionis",
      "public-run-authority.json",
    );
    runGit(evidenceRepositoryPath, "commit", "-q", "-m", "track external evidence");

    const evidenceCount = runtime.database.db.prepare(
      "SELECT COUNT(*) AS count FROM lite_learning_evidence_artifacts",
    ).get() as { count: number };
    const ingestOperationCount = runtime.database.db.prepare(
      `SELECT COUNT(*) AS count FROM lite_runtime_write_operations
       WHERE scope = 'learning_external_authority_v1'
         AND operation_kind = 'learning_evidence_ingest_v1'`,
    ).get() as { count: number };
    if (Number(evidenceCount.count) !== 0 || Number(ingestOperationCount.count) !== 0) {
      throw new Error("external evidence fixture was unexpectedly ingested during setup");
    }
    await ledger.verifyIntegrity();
    assertCurrentDatabase(runtime.database);
    runtime.database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    await runtime.close();
    runtimeClosed = true;
    chmodSync(databasePath, 0o600);
    if (existsSync(`${databasePath}-wal`) || existsSync(`${databasePath}-shm`)) {
      throw new Error("external evidence fixture close left live SQLite sidecars");
    }
    const serviceInput: LiteLearningExternalEvidenceServiceInput = {
      databasePath,
      archivePath,
      publicRunAuthorityPath,
      tenantId: CONFIRMATORY_TENANT_ID,
      actorId: FIXTURE_ACTOR_ID,
      operationId: FIXTURE_OPERATION_ID,
      artifactKind: "production_shadow_gate",
      evidenceSeriesId: EVIDENCE_SERIES_ID,
      taskFamily: CONFIRMATORY_TASK_FAMILY,
      applicableExperimentId: CONFIRMATORY_EXPERIMENT_ID,
      applicableExperimentRevision: CONFIRMATORY_EXPERIMENT_REVISION,
    };
    const appendRealProjectorToolBranch = async (args: Readonly<{
      database: LiteRuntimeDatabase;
      branchKind:
        | "preclaim_hold"
        | "termination_hold_no_binding"
        | "termination_hold_with_binding";
    }>): Promise<LearningExternalProjectorToolBranchResult> => {
      const branchLedger = createLiteLearningEpisodeLedgerAccess(args.database);
      if (await branchLedger.databaseInstanceId() !== databaseInstanceId) {
        throw new Error("projector tool branch fixture database identity mismatch");
      }
      const suffix = args.branchKind.replaceAll("_", "-");
      const operationAt = new Date().toISOString();
      const runnerTicket = Buffer.alloc(
        32,
        args.branchKind === "preclaim_hold"
          ? 0x51
          : args.branchKind === "termination_hold_no_binding" ? 0x52 : 0x53,
      );
      const reservationBase = authorityRow("lite_learning_external_run_reservations", {
        tenant_id: CONFIRMATORY_TENANT_ID,
        reservation_id: `reservation-projector-${suffix}`,
        artifact_kind: "tool_e2e_gate",
        evidence_series_id: toolEvidenceSeriesId,
        task_family: CONFIRMATORY_TASK_FAMILY,
        candidate_policy_id: revision.candidate_policy_id,
        candidate_policy_version: revision.candidate_policy_version,
        candidate_policy_implementation_sha256:
          revision.candidate_policy_implementation_sha256,
        candidate_policy_config_sha256: revision.candidate_policy_config_sha256,
        applicable_experiment_id: revision.experiment_id,
        applicable_experiment_revision: revision.experiment_revision,
        gate_policy_id: revision.gate_policy_id,
        gate_policy_version: revision.gate_policy_version,
        gate_policy_config_sha256: revision.gate_policy_config_sha256,
        applicability_manifest_sha256: applicabilityManifestSha256,
        harness_bundle_sha256: toolHarnessBundleSha256,
        source_snapshot_sha256: toolSourceSnapshotSha256,
        case_set_sha256: null,
        holdout_membership_projection_sha256: null,
        sealed_holdout_ref_sha256: null,
        sealed_holdout_ciphertext_sha256: null,
        execution_profile_sha256: toolExecutionProfileSha256,
        model_identity_sha256: toolModelIdentitySha256,
        immutable_model_snapshot_sha256: null,
        tool_manifest_sha256: toolManifestSha256,
        execution_order_sha256: null,
        retry_policy_sha256: retryPolicy.sha256,
        retry_policy_json: retryPolicy.json,
        immutable_input_manifest_sha256: toolImmutableInputManifest.sha256,
        immutable_input_manifest_json: toolImmutableInputManifest.json,
        expected_runner_principal_sha256: toolRole.runner_principal_sha256,
        credential_broker_policy_sha256: toolRole.broker_policy_sha256,
        service_launcher_policy_sha256: toolRole.service_launcher_policy_sha256,
        service_launcher_binary_sha256: toolRole.service_launcher_binary_sha256,
        service_launcher_key_id: toolRole.service_launcher_key_id,
        supervisor_executable_sha256: toolRole.supervisor_executable_sha256,
        supervisor_argv_policy_sha256: toolRole.supervisor_argv_policy_sha256,
        supervisor_sandbox_policy_sha256: toolRole.supervisor_sandbox_policy_sha256,
        credential_session_class: toolRole.credential_session_class,
        run_id: toolRunId,
        reserve_operation_id: `operation-reserve-projector-${suffix}`,
        runner_ticket_sha256: sha256(runnerTicket),
        reservation_sha256: "0".repeat(64),
        reserved_at: operationAt,
      });
      const reservation = {
        ...reservationBase,
        reservation_sha256: learningExternalRunReservationDigest(reservationBase),
      } satisfies LiteLearningAuthorityRow;
      const toolBrokerAuthority = {
        broker_service_identity: LEARNING_EXTERNAL_BROKER_SERVICE_IDENTITY,
        broker_policy_sha256: toolRole.broker_policy_sha256,
        broker_binary_sha256: toolRole.broker_binary_sha256,
        broker_public_key_sha256: toolRole.broker_public_key_sha256,
        broker_key_id: toolRole.broker_key_id,
      };
      const reservationAuthorityRequestSha256 = sha256(stableStringify({
        contract_version: "aionis_learning_external_reservation_authority_request_v1",
        reservation,
        holdout_member_sha256s: [],
        runner_ticket_sha256: reservation.runner_ticket_sha256,
      }));
      const reservationAuthorization = signReceipt({
        contract_version:
          "aionis_learning_external_run_reservation_authorization_receipt_v1" as const,
        tenant_id: CONFIRMATORY_TENANT_ID,
        database_instance_id: databaseInstanceId,
        reservation_id: String(reservation.reservation_id),
        artifact_kind: "tool_e2e_gate" as const,
        evidence_series_id: toolEvidenceSeriesId,
        external_role: "tool_e2e" as const,
        applicable_experiment_id: revision.experiment_id,
        applicable_experiment_revision: revision.experiment_revision,
        run_id: toolRunId,
        expected_runner_principal_sha256: toolRole.runner_principal_sha256,
        reserve_operation_id: String(reservation.reserve_operation_id),
        reservation_sha256: String(reservation.reservation_sha256),
        runner_ticket_sha256: String(reservation.runner_ticket_sha256),
        authority_request_sha256: reservationAuthorityRequestSha256,
        ...toolBrokerAuthority,
        authorized_at: operationAt,
        authorization_expires_at: addSeconds(operationAt, 60),
      }, brokerKeys.privateKey);
      await args.database.transaction.run(async () => {
        await branchLedger.reserveExternalRun({
          reservation,
          runnerTicket,
          authorization: reservationAuthorization,
        });
      });

      const consumptionBase = authorityRow("lite_learning_external_ticket_consumptions", {
        tenant_id: CONFIRMATORY_TENANT_ID,
        consumption_id: `consumption-projector-${suffix}`,
        reservation_id: reservation.reservation_id,
        runner_ticket_sha256: reservation.runner_ticket_sha256,
        runner_principal_sha256: toolRole.runner_principal_sha256,
        broker_process_nonce_sha256: sha256(`broker-process:projector:${suffix}`),
        consume_operation_id: `operation-consume-projector-${suffix}`,
        consumed_at: operationAt,
        consumption_sha256: "0".repeat(64),
      });
      const consumption = {
        ...consumptionBase,
        consumption_sha256: learningExternalTicketConsumptionDigest(consumptionBase),
      } satisfies LiteLearningAuthorityRow;
      const consumptionAuthorityRequestSha256 = sha256(stableStringify({
        contract_version: "aionis_learning_external_ticket_consumption_authority_request_v1",
        consumption,
        reservation_sha256: reservation.reservation_sha256,
        runner_ticket_sha256: consumption.runner_ticket_sha256,
      }));
      const consumptionAuthorization = signReceipt({
        contract_version:
          "aionis_learning_external_ticket_consumption_authorization_receipt_v1" as const,
        tenant_id: CONFIRMATORY_TENANT_ID,
        database_instance_id: databaseInstanceId,
        reservation_id: String(reservation.reservation_id),
        consumption_id: String(consumption.consumption_id),
        artifact_kind: "tool_e2e_gate" as const,
        evidence_series_id: toolEvidenceSeriesId,
        external_role: "tool_e2e" as const,
        applicable_experiment_id: revision.experiment_id,
        applicable_experiment_revision: revision.experiment_revision,
        run_id: toolRunId,
        consume_operation_id: String(consumption.consume_operation_id),
        reservation_sha256: String(reservation.reservation_sha256),
        consumption_sha256: String(consumption.consumption_sha256),
        runner_ticket_sha256: String(consumption.runner_ticket_sha256),
        runner_principal_sha256: String(consumption.runner_principal_sha256),
        broker_process_nonce_sha256: String(consumption.broker_process_nonce_sha256),
        authority_request_sha256: consumptionAuthorityRequestSha256,
        ...toolBrokerAuthority,
        authorized_at: operationAt,
        authorization_expires_at: addSeconds(operationAt, 60),
      }, brokerKeys.privateKey);
      await args.database.transaction.run(async () => {
        await branchLedger.consumeExternalTicket({
          consumption,
          runnerTicket,
          authorization: consumptionAuthorization,
        });
      });

      if (args.branchKind === "preclaim_hold") {
        const holdReceipt = signReceipt({
          contract_version: "aionis_learning_external_preclaim_hold_receipt_v1" as const,
          tenant_id: CONFIRMATORY_TENANT_ID,
          reservation_id: String(reservation.reservation_id),
          ticket_consumption_id: String(consumption.consumption_id),
          hold_id: `hold-projector-${suffix}`,
          ticket_consumption_sha256: String(consumption.consumption_sha256),
          hold_reason: "preclaim_timeout" as const,
          triggering_terminal_fact_sha256: null,
          zero_effects_proof_sha256: sha256(`zero-effects:projector:${suffix}`),
          journal_phase: "consumed_unclaimed" as const,
          ...toolBrokerAuthority,
          held_at: operationAt,
        }, brokerKeys.privateKey);
        const holdResult = await args.database.transaction.run(async () =>
          await branchLedger.recordExternalPreclaimHold({ receipt: holdReceipt }));
        return Object.freeze({
          branchKind: args.branchKind,
          recordedAt: operationAt,
          reservationId: String(reservation.reservation_id),
          ticketConsumptionId: String(consumption.consumption_id),
          preclaimHoldId: String(holdResult.hold.hold_id),
          claimId: null,
          supervisorBindingId: null,
          sessionTerminationId: null,
          terminalFactSha256: String(holdResult.hold.hold_sha256),
        });
      }

      const claimBody = {
        contract_version: "aionis_learning_external_claim_receipt_v1" as const,
        tenant_id: CONFIRMATORY_TENANT_ID,
        reservation_id: String(reservation.reservation_id),
        ticket_consumption_id: String(consumption.consumption_id),
        claim_id: `claim-projector-${suffix}`,
        ticket_consumption_sha256: String(consumption.consumption_sha256),
        runner_ticket_sha256: String(reservation.runner_ticket_sha256),
        runner_principal_sha256: toolRole.runner_principal_sha256,
        runner_execution_nonce_sha256: sha256(`runner-execution:projector:${suffix}`),
        credential_scope_sha256: toolRole.credential_scope_sha256,
        credential_session_class: toolRole.credential_session_class,
        credential_session_id_sha256: sha256(`credential-session:projector:${suffix}`),
        supervisor_bind_expires_at: addSeconds(operationAt, toolRole.supervisor_bind_ttl_seconds),
        credential_session_expires_at: addSeconds(
          operationAt,
          toolRole.credential_session_hard_ttl_seconds,
        ),
        credential_session_heartbeat_seconds: toolRole.credential_session_heartbeat_seconds,
        credential_session_max_calls: toolRole.credential_session_max_calls,
        per_call_capability_ttl_seconds: toolRole.per_call_capability_ttl_seconds,
        post_quiesce_finalize_ttl_seconds: toolRole.post_quiesce_finalize_ttl_seconds,
        ...toolBrokerAuthority,
        claimed_at: operationAt,
      };
      const claimReceipt = signReceipt(claimBody, brokerKeys.privateKey);
      await args.database.transaction.run(async () => {
        await branchLedger.claimExternalRun({ receipt: claimReceipt });
      });

      let supervisorBindingId: string | null = null;
      if (args.branchKind === "termination_hold_with_binding") {
        supervisorBindingId = `binding-projector-${suffix}`;
        const launcherBody = {
          contract_version: "aionis_learning_external_launcher_spawn_receipt_v1" as const,
          tenant_id: CONFIRMATORY_TENANT_ID,
          reservation_id: String(reservation.reservation_id),
          ticket_consumption_id: String(consumption.consumption_id),
          claim_id: claimBody.claim_id,
          credential_session_id_sha256: claimBody.credential_session_id_sha256,
          broker_challenge_sha256: sha256(`broker-challenge:projector:${suffix}`),
          runner_principal_sha256: toolRole.runner_principal_sha256,
          runner_uid: 501,
          runner_gid: 20,
          supervisor_pid: 4343,
          supervisor_process_start_identity_sha256:
            sha256(`process-start:projector:${suffix}`),
          supervisor_cgroup_identity_sha256: sha256(`cgroup:projector:${suffix}`),
          supervisor_service_job_identity_sha256: sha256(`service-job:projector:${suffix}`),
          supervisor_process_identity_sha256: sha256(`process:projector:${suffix}`),
          supervisor_executable_sha256: toolRole.supervisor_executable_sha256,
          supervisor_argv_policy_sha256: toolRole.supervisor_argv_policy_sha256,
          supervisor_argv_sha256: sha256(`argv:projector:${suffix}`),
          inherited_channel_sha256: sha256(`inherited-channel:projector:${suffix}`),
          broker_channel_fingerprint_sha256: sha256(`broker-channel:projector:${suffix}`),
          supervisor_channel_fingerprint_sha256:
            sha256(`supervisor-channel:projector:${suffix}`),
          service_launcher_policy_sha256: toolRole.service_launcher_policy_sha256,
          service_launcher_binary_sha256: toolRole.service_launcher_binary_sha256,
          service_launcher_public_key_sha256: launcherPublicKeySha256,
          service_launcher_key_id: toolRole.service_launcher_key_id,
          supervisor_sandbox_policy_sha256: toolRole.supervisor_sandbox_policy_sha256,
          spawned_at: operationAt,
        };
        const launcherReceipt = signReceipt(launcherBody, launcherKeys.privateKey);
        const bindingReceipt = signReceipt({
          contract_version:
            "aionis_learning_external_broker_supervisor_binding_receipt_v1" as const,
          tenant_id: CONFIRMATORY_TENANT_ID,
          reservation_id: String(reservation.reservation_id),
          ticket_consumption_id: String(consumption.consumption_id),
          binding_id: supervisorBindingId,
          claim_id: claimBody.claim_id,
          credential_session_id_sha256: claimBody.credential_session_id_sha256,
          runner_principal_sha256: toolRole.runner_principal_sha256,
          supervisor_process_identity_sha256: launcherBody.supervisor_process_identity_sha256,
          supervisor_executable_sha256: launcherBody.supervisor_executable_sha256,
          supervisor_argv_policy_sha256: launcherBody.supervisor_argv_policy_sha256,
          supervisor_argv_sha256: launcherBody.supervisor_argv_sha256,
          inherited_channel_sha256: launcherBody.inherited_channel_sha256,
          service_launcher_receipt_sha256: learningExternalReceiptDigest(launcherReceipt),
          service_launcher_receipt: launcherReceipt,
          service_launcher_policy_sha256: launcherBody.service_launcher_policy_sha256,
          service_launcher_binary_sha256: launcherBody.service_launcher_binary_sha256,
          service_launcher_public_key_sha256: launcherBody.service_launcher_public_key_sha256,
          service_launcher_key_id: launcherBody.service_launcher_key_id,
          supervisor_sandbox_policy_sha256: launcherBody.supervisor_sandbox_policy_sha256,
          ...toolBrokerAuthority,
          bound_at: operationAt,
        }, brokerKeys.privateKey);
        await args.database.transaction.run(async () => {
          await branchLedger.bindExternalSupervisor({ receipt: bindingReceipt });
        });
      }

      const terminationReason = args.branchKind === "termination_hold_with_binding"
        ? "runner_crash" as const
        : "launch_failure" as const;
      const terminationReceipt = signReceipt({
        contract_version:
          "aionis_learning_external_session_termination_receipt_v1" as const,
        tenant_id: CONFIRMATORY_TENANT_ID,
        reservation_id: String(reservation.reservation_id),
        ticket_consumption_id: String(consumption.consumption_id),
        termination_id: `termination-projector-${suffix}`,
        claim_id: claimBody.claim_id,
        supervisor_binding_id: supervisorBindingId,
        credential_session_id_sha256: claimBody.credential_session_id_sha256,
        termination_reason: terminationReason,
        broker_quiesce_receipt_sha256: null,
        broker_quiesce_receipt: null,
        runner_output_manifest_sha256: null,
        terminal_run_manifest_sha256: null,
        attempt_chain_sha256: sha256(`attempt-chain:projector:${suffix}`),
        ...toolBrokerAuthority,
        terminated_at: operationAt,
      }, brokerKeys.privateKey);
      const terminationResult = await args.database.transaction.run(async () =>
        await branchLedger.terminateExternalSession({ receipt: terminationReceipt }));
      return Object.freeze({
        branchKind: args.branchKind,
        recordedAt: operationAt,
        reservationId: String(reservation.reservation_id),
        ticketConsumptionId: String(consumption.consumption_id),
        preclaimHoldId: null,
        claimId: claimBody.claim_id,
        supervisorBindingId,
        sessionTerminationId: String(terminationResult.termination.termination_id),
        terminalFactSha256: String(terminationResult.termination.termination_sha256),
      });
    };
    succeeded = true;
    return Object.freeze({
      rootDirectory,
      databasePath,
      evidenceRepositoryPath,
      archivePath,
      publicRunAuthorityPath,
      recordedAt: addSeconds(operationAt, 6),
      serviceInput: Object.freeze(serviceInput),
      appendRealProjectorToolBranch,
    });
  } finally {
    if (!runtimeClosed) {
      try {
        await runtime.close();
      } catch {
        // Preserve the fixture construction error.
      }
    }
    if (!succeeded && evidenceRepositoryRoot)
      rmSync(evidenceRepositoryRoot, { recursive: true, force: true });
    if (!succeeded) rmSync(rootDirectory, { recursive: true, force: true });
  }
}

/** Copies only the clean, closed authority database; tracked evidence stays shared/read-only. */
export function cloneLearningExternalEvidenceIngestFixture(
  fixture: LearningExternalEvidenceIngestFixture,
  name: string,
): LearningExternalEvidenceIngestFixture {
  if (!/^[a-z0-9-]+$/u.test(name)) throw new Error("fixture clone name is not canonical");
  const rootDirectory = join(fixture.rootDirectory, `scenario-${name}`);
  mkdirSync(rootDirectory, { mode: 0o700 });
  chmodSync(rootDirectory, 0o700);
  const databasePath = join(rootDirectory, "runtime.sqlite");
  copyFileSync(fixture.databasePath, databasePath);
  chmodSync(databasePath, statSync(fixture.databasePath).mode & 0o777);
  return Object.freeze({
    ...fixture,
    rootDirectory,
    databasePath,
    serviceInput: Object.freeze({ ...fixture.serviceInput, databasePath }),
  });
}

import { createHash } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";

import {
  parseAdmissionCandidatePolicyProfileRules,
  type AionisAdmissionCandidatePolicyProfileRule,
} from "../../../src/config.js";
import {
  AIONIS_ADMISSION_CANDIDATE_POLICY_ID,
  AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION,
  resolveAdmissionCandidatePolicy,
} from "../../../src/memory/admission-candidate-policy.js";
import { createLearningExternalExecutionPolicyRegistryEntry } from
  "../../../src/memory/learning-external-execution-policy.js";
import {
  LearningExperimentExternalInputSetV1Schema,
  LearningMemoryNamespaceManifestV1Schema,
  learningConfirmatoryNamespaceLeaseMembershipDigest,
  type LearningExperimentConfirmatoryCohortPairV1,
  type LearningExperimentExternalInputSetV1,
  type LearningMemoryNamespaceManifestV1,
} from "../../../src/memory/learning-experiment-provisioning.js";
import {
  LEARNING_GATE_POLICY_ID,
  LEARNING_GATE_POLICY_VERSION,
  resolveLearningGatePolicy,
} from "../../../src/memory/learning-gate-policy.js";
import { resolveTenantScope } from "../../../src/memory/tenant.js";
import {
  createLiteLearningExperimentProvisioner,
  type LearningExperimentProvisionInput,
  type LearningExperimentProvisionResult,
  type LearningExperimentProvisioningRegistry,
} from "../../../tools/learning-experiments/lite-learning-experiment-provisioning.js";
import {
  createLiteRuntimeDatabase,
  type LiteRuntimeDatabase,
  type LiteRuntimeDatabaseFaultInjector,
} from "../../../src/store/lite-runtime-database.js";
import { ensureLiteTenantScopeEncodingAnchor } from
  "../../../src/store/lite-tenant-scope-authority.js";
import {
  createLiteWriteStoreFromDatabase,
  type LiteWriteStore,
} from "../../../src/store/lite-write-store.js";

export const CONFIRMATORY_DEFAULT_TENANT_ID = "default";
export const CONFIRMATORY_TENANT_ID = "tenant-confirmatory";
export const CONFIRMATORY_TASK_FAMILY = "repository_change";
export const CONFIRMATORY_EXPERIMENT_ID = "confirmatory-provision-experiment";
export const CONFIRMATORY_EXPERIMENT_REVISION = 1;
export const CONFIRMATORY_OPERATION_ID = "confirmatory-provision-operation-1";
export const CONFIRMATORY_ACTOR = "confirmatory-experiment-provisioner";
export const CONFIRMATORY_NOW = "2026-07-14T09:00:00.000Z";
export const CONFIRMATORY_RAW_SCOPE_MARKER = "reviewed-secret-scope";
export const CONFIRMATORY_RAW_COVARIATE_MARKER = "reviewed-secret-region";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown) {
  const json = stableStringify(value);
  return { json, sha256: sha256(json) };
}

function externalExecutionPolicy(databaseInstanceId: string) {
  const attestorPublicKey = Buffer.alloc(32, 29);
  const launcherPublicKey = Buffer.alloc(32, 31);
  const attestorPublicKeyBase64 = attestorPublicKey.toString("base64");
  const attestorPublicKeySha256 = sha256(attestorPublicKey);
  const launcherPublicKeyBase64 = launcherPublicKey.toString("base64");
  const launcherPublicKeySha256 = sha256(launcherPublicKey);
  const launcher = {
    service_launcher_policy_sha256: sha256("confirmatory-launcher-policy"),
    service_launcher_binary_sha256: sha256("confirmatory-launcher-binary"),
    service_launcher_public_key_sha256: launcherPublicKeySha256,
    service_launcher_key_id: "confirmatory-launcher-key-v1",
  };
  const role = (
    credentialSessionClass: "eligible_host_adapter" | "formal_tool_eval" | "immutable_paired_eval",
    suffix: string,
  ) => {
    const brokerPublicKey = createHash("sha256").update(`confirmatory-broker-key:${suffix}`).digest();
    return {
      runner_principal_sha256: sha256(`confirmatory-runner:${suffix}`),
      credential_session_class: credentialSessionClass,
      broker_policy_sha256: sha256(`confirmatory-broker-policy:${suffix}`),
      broker_binary_sha256: sha256(`confirmatory-broker-binary:${suffix}`),
      broker_public_key_base64: brokerPublicKey.toString("base64"),
      broker_public_key_sha256: sha256(brokerPublicKey),
      broker_key_id: `confirmatory-broker-key-${suffix}`,
      ...launcher,
      supervisor_executable_sha256: sha256(`confirmatory-supervisor-executable:${suffix}`),
      supervisor_argv_policy_sha256: sha256(`confirmatory-supervisor-argv:${suffix}`),
      supervisor_sandbox_policy_sha256: sha256(`confirmatory-supervisor-sandbox:${suffix}`),
      receipt_signature_algorithm: "ed25519-v1" as const,
      credential_scope_sha256: sha256(`confirmatory-credential-scope:${suffix}`),
      supervisor_bind_ttl_seconds: 30,
      credential_session_hard_ttl_seconds: 3_600,
      credential_session_heartbeat_seconds: 10,
      credential_session_max_calls: 100,
      per_call_capability_ttl_seconds: 60,
      post_quiesce_finalize_ttl_seconds: 600,
    };
  };
  return {
    policy_version: "external-execution-v1" as const,
    runtime_authority_attestor: {
      service_identity: "confirmatory-runtime-authority-attestor-v1",
      attestor_binary_sha256: sha256("confirmatory-attestor-binary"),
      attestor_policy_sha256: sha256("confirmatory-attestor-policy"),
      attestor_public_key_base64: attestorPublicKeyBase64,
      attestor_public_key_sha256: attestorPublicKeySha256,
      attestor_key_id: "confirmatory-attestor-key-v1",
      ...launcher,
      service_launcher_public_key_base64: launcherPublicKeyBase64,
      receipt_signature_algorithm: "ed25519-v1" as const,
      expected_database_instance_id: databaseInstanceId,
    },
    roles: {
      offline_paired: role("immutable_paired_eval", "offline"),
      production_shadow: role("eligible_host_adapter", "shadow"),
      tool_e2e: role("formal_tool_eval", "tool"),
    },
  };
}

export function createConfirmatoryPassedRegistry(): LearningExperimentProvisioningRegistry {
  const gate = resolveLearningGatePolicy(LEARNING_GATE_POLICY_ID, LEARNING_GATE_POLICY_VERSION);
  const calibration = canonical({
    contract_version: "aionis_test_confirmatory_gate_calibration_v1",
    status: "passed",
    scenario_count: 96,
  });
  const gateConfig = canonical({
    ...gate.config,
    prospective_calibration_artifact_sha256: calibration.sha256,
  });
  return {
    resolveCandidatePolicy: (policyId, policyVersion) =>
      resolveAdmissionCandidatePolicy(policyId, policyVersion),
    resolveGatePolicy: (policyId, policyVersion) => {
      if (policyId !== gate.policy_id || policyVersion !== gate.policy_version) {
        throw new Error("confirmatory test gate registry tuple mismatch");
      }
      return {
        policy_id: gate.policy_id,
        policy_version: gate.policy_version,
        registry_status: "registered",
        config: JSON.parse(gateConfig.json),
        policy_config_sha256: gateConfig.sha256,
        implementation_contract_sha256: gate.implementation_contract_sha256,
        prospective_calibration_artifact_sha256: calibration.sha256,
        prospective_calibration_artifact: JSON.parse(calibration.json),
      };
    },
    resolveExternalExecutionPolicy: (registryKey, databaseInstanceId) =>
      createLearningExternalExecutionPolicyRegistryEntry({
        registryKey,
        databaseInstanceId,
        policy: externalExecutionPolicy(databaseInstanceId),
      }),
  };
}

export function createConfirmatoryExternalInputs() {
  return {
    offline_paired: {
      immutable_input_manifest_sha256: sha256("confirmatory-offline-input-v1"),
      retry_policy_sha256: sha256("confirmatory-offline-retry-v1"),
      planned_run_id: "confirmatory-offline-run-v1",
    },
    production_shadow: {
      immutable_input_manifest_sha256: sha256("confirmatory-shadow-input-v1"),
      retry_policy_sha256: sha256("confirmatory-shadow-retry-v1"),
      planned_run_id: "confirmatory-shadow-run-v1",
    },
    tool_e2e: {
      immutable_input_manifest_sha256: sha256("confirmatory-tool-input-v1"),
      retry_policy_sha256: sha256("confirmatory-tool-retry-v1"),
      planned_run_id: "confirmatory-tool-run-v1",
    },
  };
}

export function createConfirmatoryProfile(): AionisAdmissionCandidatePolicyProfileRule {
  const allowedVerifiers = [{
    kind: "deterministic_scorer" as const,
    version: "confirmatory-scorer-v1",
    config_sha256: sha256("confirmatory-scorer-config-v1"),
  }];
  const verifierPolicySha256 = canonical({ allowed_verifiers: allowedVerifiers }).sha256;
  const [rule] = parseAdmissionCandidatePolicyProfileRules(stableStringify([{
    profile_id: "confirmatory-provision-profile",
    mode: "active",
    task_families: [CONFIRMATORY_TASK_FAMILY],
    experiment: {
      experiment_id: CONFIRMATORY_EXPERIMENT_ID,
      revision: CONFIRMATORY_EXPERIMENT_REVISION,
      serving_phase: "active_control",
      evidence_intent: "confirmatory",
      assignment_design: "matched_pair_complete_randomization_v1",
      candidate_policy_id: AIONIS_ADMISSION_CANDIDATE_POLICY_ID,
      candidate_policy_version: AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION,
      candidate_allocation_bps: 5_000,
      gate_policy_id: LEARNING_GATE_POLICY_ID,
      gate_policy_version: LEARNING_GATE_POLICY_VERSION,
      required_evidence_series: {
        offline_paired: "confirmatory-offline-series-v1",
        production_shadow: "confirmatory-shadow-series-v1",
        tool_e2e: "confirmatory-tool-series-v1",
        runtime_integrity: "confirmatory-integrity-series-v1",
      },
      required_external_inputs: createConfirmatoryExternalInputs(),
      external_execution_policy_ref: { registry_key: "external-execution-v1" },
      collection_sources: [{
        principal_sha256: sha256("confirmatory-principal-v1"),
        class: "eligible_host",
        collector_id: "confirmatory-host-collector",
        collector_version: "confirmatory-collector-v1",
        verifier_policy_sha256: verifierPolicySha256,
        allowed_verifiers: allowedVerifiers,
      }],
      safety_pause_mode: "automatic",
    },
  }]));
  if (!rule) throw new Error("confirmatory profile fixture did not parse");
  return rule;
}

export function createConfirmatoryNamespaceManifest(): LearningMemoryNamespaceManifestV1 {
  const waveWindows = {
    1: ["2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z", "2026-08-03T00:00:00.000Z"],
    2: ["2026-08-04T00:00:00.000Z", "2026-08-05T00:00:00.000Z", "2026-08-06T00:00:00.000Z"],
    3: ["2026-08-07T00:00:00.000Z", "2026-08-08T00:00:00.000Z", "2026-08-09T00:00:00.000Z"],
  } as const;
  return LearningMemoryNamespaceManifestV1Schema.parse({
    contract_version: "aionis_learning_memory_namespace_manifest_v1",
    tenant_id: CONFIRMATORY_TENANT_ID,
    task_family: CONFIRMATORY_TASK_FAMILY,
    experiment_id: CONFIRMATORY_EXPERIMENT_ID,
    experiment_revision: CONFIRMATORY_EXPERIMENT_REVISION,
    pairs: Array.from({ length: 384 }, (_, index) => {
      const wave = index < 96 ? 1 : index < 192 ? 2 : 3;
      const times = waveWindows[wave];
      const ordinal = String(index).padStart(3, "0");
      return {
        members: [
          {
            tenant_id: CONFIRMATORY_TENANT_ID,
            public_scope: `${CONFIRMATORY_RAW_SCOPE_MARKER}-${ordinal}-member-0`,
          },
          {
            tenant_id: CONFIRMATORY_TENANT_ID,
            public_scope: `${CONFIRMATORY_RAW_SCOPE_MARKER}-${ordinal}-member-1`,
          },
        ],
        matching_covariates: {
          contract_version: "aionis_learning_matching_covariates_v1",
          host_adapter_sha256: sha256("confirmatory-host-adapter-v1"),
          provider_model_route_sha256: sha256("confirmatory-provider-route-v1"),
          region: CONFIRMATORY_RAW_COVARIATE_MARKER,
          workload_stratum: `confirmatory-stratum-${String(index % 8)}`,
        },
        activation: {
          activation_wave_index: wave,
          activation_starts_at: times[0],
          index_window_ends_at: times[1],
          wave_analysis_at: times[2],
        },
      };
    }),
  });
}

export function createConfirmatoryExternalInputSet(): LearningExperimentExternalInputSetV1 {
  return LearningExperimentExternalInputSetV1Schema.parse({
    contract_version: "aionis_learning_experiment_external_input_set_v1",
    tenant_id: CONFIRMATORY_TENANT_ID,
    task_family: CONFIRMATORY_TASK_FAMILY,
    experiment_id: CONFIRMATORY_EXPERIMENT_ID,
    experiment_revision: CONFIRMATORY_EXPERIMENT_REVISION,
    roles: createConfirmatoryExternalInputs(),
  });
}

export function createConfirmatoryProvisionInput(
  overrides: Partial<LearningExperimentProvisionInput> = {},
): LearningExperimentProvisionInput {
  return {
    tenantId: CONFIRMATORY_TENANT_ID,
    actor: CONFIRMATORY_ACTOR,
    operationId: CONFIRMATORY_OPERATION_ID,
    profileRule: createConfirmatoryProfile(),
    taskFamily: CONFIRMATORY_TASK_FAMILY,
    experimentId: CONFIRMATORY_EXPERIMENT_ID,
    experimentRevision: CONFIRMATORY_EXPERIMENT_REVISION,
    memoryNamespaceManifest: createConfirmatoryNamespaceManifest(),
    externalInputSet: createConfirmatoryExternalInputSet(),
    ...overrides,
  };
}

export type ConfirmatoryFixtureRuntime = Readonly<{
  database: LiteRuntimeDatabase;
  writeStore: LiteWriteStore;
  close(): Promise<void>;
}>;

export function openConfirmatoryFixtureRuntime(
  databasePath: string,
  options: { faultInjector?: LiteRuntimeDatabaseFaultInjector } = {},
): ConfirmatoryFixtureRuntime {
  const database = createLiteRuntimeDatabase(databasePath, options);
  const writeStore = createLiteWriteStoreFromDatabase(database, {
    annProjectionEnabled: false,
    allowLegacyV1Fixtures: true,
  });
  return {
    database,
    writeStore,
    async close() {
      try {
        await writeStore.close();
      } finally {
        await database.close();
      }
    },
  };
}

export async function seedConfirmatoryPriorScopes(
  runtime: ConfirmatoryFixtureRuntime,
  manifest: LearningMemoryNamespaceManifestV1 = createConfirmatoryNamespaceManifest(),
  defaultTenantId = CONFIRMATORY_DEFAULT_TENANT_ID,
): Promise<void> {
  const members = manifest.pairs.flatMap((pair) => pair.members);
  await runtime.writeStore.withTx(async () => {
    for (const member of members) {
      const tenancy = resolveTenantScope(
        { tenant_id: member.tenant_id, scope: member.public_scope },
        { defaultTenantId, defaultScope: member.public_scope },
      );
      const inputSha256 = sha256(`confirmatory-prior-input:${tenancy.scope_key}`);
      const diffJson = stableStringify({
        contract_version: "aionis_test_confirmatory_prior_scope_v1",
        scope_sha256: sha256(tenancy.scope_key),
      });
      await runtime.writeStore.insertLegacyV1CommitForMigrationOrTestFixture({
        scope: tenancy.scope_key,
        parentCommitId: null,
        inputSha256,
        diffJson,
        actor: "confirmatory-prior-memory-writer",
        modelVersion: null,
        promptVersion: null,
        commitHash: sha256(stableStringify({
          contract_version: "aionis_test_confirmatory_prior_commit_v1",
          scope: tenancy.scope_key,
          input_sha256: inputSha256,
          diff_sha256: sha256(diffJson),
        })),
      });
    }
  });
  const row = runtime.database.db.prepare(
    "SELECT COUNT(*) AS count FROM lite_memory_commits",
  ).get() as { count: number };
  if (Number(row.count) !== 768) {
    throw new Error(`confirmatory prior-scope fixture expected 768 commits, got ${String(row.count)}`);
  }
}

export async function ensureConfirmatoryTenantScopeAnchor(
  runtime: ConfirmatoryFixtureRuntime,
  defaultTenantId = CONFIRMATORY_DEFAULT_TENANT_ID,
) {
  return await runtime.writeStore.withTx(async () => ensureLiteTenantScopeEncodingAnchor(
    runtime.database.db,
    runtime.database.transaction,
    defaultTenantId,
  ));
}

export type ConfirmatoryProvisionFixtureOverrides = Readonly<{
  input?: LearningExperimentProvisionInput;
  defaultTenantId?: string;
  randomBytes?: (size: number) => Uint8Array;
}>;

export type ConfirmatoryProvisionedFixture = Readonly<{
  input: LearningExperimentProvisionInput;
  provisionResult: LearningExperimentProvisionResult;
  revision: Readonly<{
    tenantId: string;
    experimentId: string;
    experimentRevision: number;
    experimentConfigSha256: string;
    candidatePolicyId: string;
    candidatePolicyVersion: string;
    candidatePolicyImplementationSha256: string;
    gatePolicyId: string;
    gatePolicyVersion: string;
    gatePolicyImplementationSha256: string;
    gatePolicyConfigSha256: string;
    namespaceSetSha256: string;
  }>;
  attempt: Readonly<{
    tenantId: string;
    taskFamily: string;
    confirmatoryAttemptId: string;
    confirmatoryAttemptSha256: string;
    experimentId: string;
    experimentRevision: number;
    candidatePolicyImplementationSha256: string;
    gatePolicyId: string;
    gatePolicyVersion: string;
    gatePolicyConfigSha256: string;
    namespaceSetSha256: string;
  }>;
  lineage: Readonly<{
    databaseInstanceId: string;
    runtimeAuthorityLineageSha256: string;
    tenantScopeEncodingSha256: string;
    preTreatmentLineageSnapshotSha256: string;
  }>;
  leaseMembership: Readonly<{
    leaseIds: readonly string[];
    leaseCount: number;
    activeLeaseCount: number;
    releasedLeaseCount: number;
    namespaceSetSha256: string;
    namespaceLeaseMembershipSha256: string;
  }>;
}>;

type ConfirmatoryRevisionRow = Readonly<{
  tenant_id: string;
  experiment_id: string;
  experiment_revision: number;
  config_sha256: string;
  config_json: string;
  candidate_policy_id: string;
  candidate_policy_version: string;
  candidate_policy_implementation_sha256: string;
  gate_policy_id: string;
  gate_policy_version: string;
  gate_policy_config_sha256: string;
  eligible_memory_namespace_set_sha256: string;
}>;

type ConfirmatoryAttemptRow = Readonly<{
  tenant_id: string;
  task_family: string;
  confirmatory_attempt_id: string;
  attempt_sha256: string;
  experiment_id: string;
  experiment_revision: number;
  candidate_policy_implementation_sha256: string;
  gate_policy_id: string;
  gate_policy_version: string;
  gate_policy_config_sha256: string;
  eligible_memory_namespace_set_sha256: string;
}>;

type ConfirmatoryLeaseProjectionRow = Readonly<{
  pair_ordinal: number;
  randomization_pair_sha256: string;
  pair_record_sha256: string;
  matching_covariate_sha256: string;
  activation_wave_index: number;
  activation_starts_at: string;
  index_window_ends_at: string;
  wave_analysis_at: string;
  pair_member_ordinal: number;
  memory_namespace_sha256: string;
  namespace_lease_id: string;
  lease_generation: number;
  namespace_set_sha256: string;
  status: string;
}>;

function defaultConfirmatoryFixtureRandomBytes(size: number): Uint8Array {
  if (size === 32) {
    return Uint8Array.from({ length: size }, (_, index) => 0x40 + index);
  }
  if (size === 48) {
    return Uint8Array.from({ length: size }, (_, index) => (0xa5 + index) & 0xff);
  }
  throw new Error(`unexpected confirmatory fixture entropy request: ${String(size)}`);
}

function confirmatoryFixtureConfig(configJson: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(configJson);
  } catch {
    throw new Error("confirmatory fixture revision config is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || stableStringify(value) !== configJson) {
    throw new Error("confirmatory fixture revision config is not a canonical object");
  }
  return value as Record<string, unknown>;
}

function requiredConfirmatoryFixtureString(
  value: Record<string, unknown>,
  field: string,
): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    throw new Error(`confirmatory fixture is missing ${field}`);
  }
  return fieldValue;
}

function confirmatoryCohortPairsFromDatabase(
  rows: readonly ConfirmatoryLeaseProjectionRow[],
): LearningExperimentConfirmatoryCohortPairV1[] {
  const byOrdinal = new Map<number, ConfirmatoryLeaseProjectionRow[]>();
  for (const row of rows) {
    const members = byOrdinal.get(row.pair_ordinal) ?? [];
    members.push(row);
    byOrdinal.set(row.pair_ordinal, members);
  }
  if (byOrdinal.size !== 384) {
    throw new Error(`confirmatory fixture expected 384 pairs, got ${String(byOrdinal.size)}`);
  }
  return [...byOrdinal.entries()]
    .sort(([left], [right]) => left - right)
    .map(([pairOrdinal, unsortedMembers]) => {
      const members = [...unsortedMembers].sort(
        (left, right) => left.pair_member_ordinal - right.pair_member_ordinal,
      );
      const first = members[0];
      const second = members[1];
      if (!first || !second || members.length !== 2
        || first.pair_member_ordinal !== 0 || second.pair_member_ordinal !== 1
        || first.randomization_pair_sha256 !== second.randomization_pair_sha256) {
        throw new Error(`confirmatory fixture pair ${String(pairOrdinal)} membership is incomplete`);
      }
      const wave = first.activation_wave_index;
      if (wave !== 1 && wave !== 2 && wave !== 3) {
        throw new Error(`confirmatory fixture pair ${String(pairOrdinal)} wave is invalid`);
      }
      return {
        pair_ordinal: pairOrdinal,
        randomization_pair_sha256: first.randomization_pair_sha256,
        pair_record_sha256: first.pair_record_sha256,
        matching_covariate_sha256: first.matching_covariate_sha256,
        activation_wave_index: wave,
        activation_starts_at: first.activation_starts_at,
        index_window_ends_at: first.index_window_ends_at,
        wave_analysis_at: first.wave_analysis_at,
        members: [first, second].map((member) => ({
          pair_member_ordinal: member.pair_member_ordinal as 0 | 1,
          memory_namespace_sha256: member.memory_namespace_sha256,
          namespace_lease_id_sha256: sha256(member.namespace_lease_id),
          namespace_lease_generation: member.lease_generation,
        })) as LearningExperimentConfirmatoryCohortPairV1["members"],
      };
    });
}

/**
 * Provisions a real 384-pair/768-namespace confirmatory authority fixture and
 * returns the persisted bindings needed to build a later signed close request.
 */
export async function provisionConfirmatoryFixture(
  runtime: ConfirmatoryFixtureRuntime,
  overrides: ConfirmatoryProvisionFixtureOverrides = {},
): Promise<ConfirmatoryProvisionedFixture> {
  const input = overrides.input ?? createConfirmatoryProvisionInput();
  const defaultTenantId = overrides.defaultTenantId ?? CONFIRMATORY_DEFAULT_TENANT_ID;
  const manifest = input.memoryNamespaceManifest;
  if (!manifest || !input.externalInputSet) {
    throw new Error("confirmatory fixture requires reviewed namespace and external-input manifests");
  }

  await ensureConfirmatoryTenantScopeAnchor(runtime, defaultTenantId);
  await seedConfirmatoryPriorScopes(runtime, manifest, defaultTenantId);
  const provisionResult = await createLiteLearningExperimentProvisioner({
    database: runtime.database,
    writeStore: runtime.writeStore,
    dependencies: {
      registry: createConfirmatoryPassedRegistry(),
      defaultTenantId,
      now: () => CONFIRMATORY_NOW,
      randomBytes: overrides.randomBytes ?? defaultConfirmatoryFixtureRandomBytes,
    },
  }).provision(input);
  if (provisionResult.applicabilityManifest.evidence_intent !== "confirmatory") {
    throw new Error("confirmatory fixture provision returned a non-confirmatory manifest");
  }

  return await runtime.database.transaction.read(() => {
    const revision = runtime.database.db.prepare(
      `SELECT tenant_id, experiment_id, experiment_revision, config_sha256, config_json,
              candidate_policy_id, candidate_policy_version,
              candidate_policy_implementation_sha256,
              gate_policy_id, gate_policy_version, gate_policy_config_sha256,
              eligible_memory_namespace_set_sha256
       FROM lite_learning_experiment_revisions
       WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
    ).get(input.tenantId, input.experimentId, input.experimentRevision) as
      ConfirmatoryRevisionRow | undefined;
    if (!revision) throw new Error("confirmatory fixture revision was not persisted");
    const attempt = runtime.database.db.prepare(
      `SELECT tenant_id, task_family, confirmatory_attempt_id, attempt_sha256,
              experiment_id, experiment_revision,
              candidate_policy_implementation_sha256,
              gate_policy_id, gate_policy_version, gate_policy_config_sha256,
              eligible_memory_namespace_set_sha256
       FROM lite_learning_confirmatory_attempts
       WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
    ).get(input.tenantId, input.experimentId, input.experimentRevision) as
      ConfirmatoryAttemptRow | undefined;
    if (!attempt) throw new Error("confirmatory fixture attempt was not persisted");
    const gatePolicy = runtime.database.db.prepare(
      `SELECT implementation_contract_sha256
       FROM lite_learning_policy_versions
       WHERE tenant_id = ? AND policy_kind = 'gate'
         AND policy_id = ? AND policy_version = ?`,
    ).get(input.tenantId, attempt.gate_policy_id, attempt.gate_policy_version) as
      { implementation_contract_sha256: string } | undefined;
    if (!gatePolicy) throw new Error("confirmatory fixture gate policy was not persisted");
    const identity = runtime.database.db.prepare(
      "SELECT database_instance_id FROM lite_runtime_authority_identity WHERE singleton = 1",
    ).get() as { database_instance_id: string } | undefined;
    if (!identity) throw new Error("confirmatory fixture Runtime authority identity is missing");
    const leaseRows = runtime.database.db.prepare(
      `SELECT pair.pair_ordinal, pair.randomization_pair_sha256,
              pair.pair_record_sha256, pair.matching_covariate_sha256,
              pair.activation_wave_index, pair.activation_starts_at,
              pair.index_window_ends_at, pair.wave_analysis_at,
              lease.pair_member_ordinal, lease.memory_namespace_sha256,
              lease.namespace_lease_id, lease.lease_generation,
              lease.namespace_set_sha256, lease.status
       FROM lite_learning_randomization_pairs AS pair
       JOIN lite_learning_namespace_leases AS lease
         ON lease.tenant_id = pair.tenant_id
        AND lease.confirmatory_attempt_id = pair.confirmatory_attempt_id
        AND lease.randomization_pair_sha256 = pair.randomization_pair_sha256
       WHERE pair.tenant_id = ? AND pair.confirmatory_attempt_id = ?
       ORDER BY pair.pair_ordinal, lease.pair_member_ordinal`,
    ).all(input.tenantId, attempt.confirmatory_attempt_id) as ConfirmatoryLeaseProjectionRow[];
    if (leaseRows.length !== 768) {
      throw new Error(`confirmatory fixture expected 768 leases, got ${String(leaseRows.length)}`);
    }
    const cohortPairs = confirmatoryCohortPairsFromDatabase(leaseRows);
    const namespaceLeaseMembershipSha256 =
      learningConfirmatoryNamespaceLeaseMembershipDigest(cohortPairs);
    const namespaceSets = new Set(leaseRows.map((row) => row.namespace_set_sha256));
    if (namespaceSets.size !== 1) {
      throw new Error("confirmatory fixture leases do not share one namespace set");
    }
    const namespaceSetSha256 = leaseRows[0]!.namespace_set_sha256;
    const config = confirmatoryFixtureConfig(revision.config_json);
    const runtimeAuthorityLineageSha256 = sha256(identity.database_instance_id);
    const cohort = provisionResult.applicabilityManifest.cohort;
    if (revision.eligible_memory_namespace_set_sha256 !== namespaceSetSha256
      || attempt.eligible_memory_namespace_set_sha256 !== namespaceSetSha256
      || cohort.eligible_memory_namespace_set_sha256 !== namespaceSetSha256
      || cohort.confirmatory_attempt_id !== attempt.confirmatory_attempt_id
      || cohort.confirmatory_attempt_sha256 !== attempt.attempt_sha256
      || cohort.namespace_lease_membership_sha256 !== namespaceLeaseMembershipSha256
      || provisionResult.applicabilityManifest.runtime_authority_lineage_sha256
        !== runtimeAuthorityLineageSha256) {
      throw new Error("confirmatory fixture persisted authority bindings do not match its manifest");
    }
    const activeLeaseCount = leaseRows.filter((row) => row.status === "active").length;
    const releasedLeaseCount = leaseRows.filter((row) => row.status === "released").length;
    if (activeLeaseCount !== 768 || releasedLeaseCount !== 0) {
      throw new Error("confirmatory fixture provision did not leave one complete active lease set");
    }

    return {
      input,
      provisionResult,
      revision: {
        tenantId: revision.tenant_id,
        experimentId: revision.experiment_id,
        experimentRevision: revision.experiment_revision,
        experimentConfigSha256: revision.config_sha256,
        candidatePolicyId: revision.candidate_policy_id,
        candidatePolicyVersion: revision.candidate_policy_version,
        candidatePolicyImplementationSha256:
          revision.candidate_policy_implementation_sha256,
        gatePolicyId: revision.gate_policy_id,
        gatePolicyVersion: revision.gate_policy_version,
        gatePolicyImplementationSha256: gatePolicy.implementation_contract_sha256,
        gatePolicyConfigSha256: revision.gate_policy_config_sha256,
        namespaceSetSha256,
      },
      attempt: {
        tenantId: attempt.tenant_id,
        taskFamily: attempt.task_family,
        confirmatoryAttemptId: attempt.confirmatory_attempt_id,
        confirmatoryAttemptSha256: attempt.attempt_sha256,
        experimentId: attempt.experiment_id,
        experimentRevision: attempt.experiment_revision,
        candidatePolicyImplementationSha256:
          attempt.candidate_policy_implementation_sha256,
        gatePolicyId: attempt.gate_policy_id,
        gatePolicyVersion: attempt.gate_policy_version,
        gatePolicyConfigSha256: attempt.gate_policy_config_sha256,
        namespaceSetSha256,
      },
      lineage: {
        databaseInstanceId: identity.database_instance_id,
        runtimeAuthorityLineageSha256,
        tenantScopeEncodingSha256: requiredConfirmatoryFixtureString(
          config,
          "tenant_scope_encoding_sha256",
        ),
        preTreatmentLineageSnapshotSha256: requiredConfirmatoryFixtureString(
          config,
          "pre_treatment_lineage_snapshot_sha256",
        ),
      },
      leaseMembership: {
        leaseIds: leaseRows.map((row) => row.namespace_lease_id).sort(),
        leaseCount: leaseRows.length,
        activeLeaseCount,
        releasedLeaseCount,
        namespaceSetSha256,
        namespaceLeaseMembershipSha256,
      },
    };
  });
}

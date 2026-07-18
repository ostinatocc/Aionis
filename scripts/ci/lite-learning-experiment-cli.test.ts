import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import stableStringify from "fast-json-stable-stringify";

import {
  admissionCandidatePolicyProfileRuleDigest,
  parseAdmissionCandidatePolicyProfileRules,
  type AionisAdmissionCandidatePolicyProfileRule,
} from "../../src/config.js";
import {
  AIONIS_ADMISSION_CANDIDATE_POLICY_ID,
  AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION,
  resolveAdmissionCandidatePolicy,
} from "../../src/memory/admission-candidate-policy.js";
import {
  createLearningExternalExecutionPolicyRegistryEntry,
} from "../../src/memory/learning-external-execution-policy.js";
import { LearningExperimentApplicabilityManifestV1Schema } from "../../src/memory/learning-experiment-provisioning.js";
import {
  LEARNING_GATE_POLICY_ID,
  LEARNING_GATE_POLICY_VERSION,
  resolveLearningGatePolicy,
} from "../../src/memory/learning-gate-policy.js";
import {
  LEARNING_EXPERIMENT_PROVISION_AUTHORITY_SCOPE,
  LEARNING_EXPERIMENT_PROVISION_OPERATION_KIND,
  LearningExperimentProvisioningError,
  createLiteLearningExperimentProvisioner,
  type LearningExperimentProvisionInput,
  type LearningExperimentProvisioningDependencies,
  type LearningExperimentProvisioningRegistry,
} from "../../tools/learning-experiments/lite-learning-experiment-provisioning.js";
import { createLiteLearningEpisodeLedgerAccess } from "../../src/store/lite-learning-episode-ledger.js";
import {
  createLiteRuntimeDatabase,
  type LiteRuntimeDatabase,
  type LiteRuntimeDatabaseFaultInjector,
} from "../../src/store/lite-runtime-database.js";
import {
  createLiteWriteStoreFromDatabase,
  type LiteWriteStore,
} from "../../src/store/lite-write-store.js";
import { runLearningExperimentCli } from "../learning-experiment.js";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown) {
  const json = stableStringify(value);
  return { json, sha256: sha256(json) };
}

function tempDatabase(name: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `aionis-learning-provision-${name}-`));
  return { directory, path: path.join(directory, "runtime.sqlite") };
}

function externalExecutionPolicy(databaseInstanceId: string) {
  const attestorPublicKey = Buffer.alloc(32, 19);
  const launcherPublicKey = Buffer.alloc(32, 20);
  const attestorPublicKeyBase64 = attestorPublicKey.toString("base64");
  const attestorPublicKeySha256 = sha256(attestorPublicKey);
  const launcherPublicKeyBase64 = launcherPublicKey.toString("base64");
  const launcherPublicKeySha256 = sha256(launcherPublicKey);
  const launcher = {
    service_launcher_policy_sha256: sha256("provision-launcher-policy"),
    service_launcher_binary_sha256: sha256("provision-launcher-binary"),
    service_launcher_public_key_sha256: launcherPublicKeySha256,
    service_launcher_key_id: "provision-launcher-key-v1",
  };
  const role = (
    credentialSessionClass: "eligible_host_adapter" | "formal_tool_eval" | "immutable_paired_eval",
    suffix: string,
  ) => {
    const brokerPublicKey = createHash("sha256").update(`provision-broker-key:${suffix}`).digest();
    return {
      runner_principal_sha256: sha256(`provision-runner:${suffix}`),
      credential_session_class: credentialSessionClass,
      broker_policy_sha256: sha256(`provision-broker-policy:${suffix}`),
      broker_binary_sha256: sha256(`provision-broker-binary:${suffix}`),
      broker_public_key_base64: brokerPublicKey.toString("base64"),
      broker_public_key_sha256: sha256(brokerPublicKey),
      broker_key_id: `provision-broker-key-${suffix}`,
      ...launcher,
      supervisor_executable_sha256: sha256(`provision-supervisor-executable:${suffix}`),
      supervisor_argv_policy_sha256: sha256(`provision-supervisor-argv:${suffix}`),
      supervisor_sandbox_policy_sha256: sha256(`provision-supervisor-sandbox:${suffix}`),
      receipt_signature_algorithm: "ed25519-v1" as const,
      credential_scope_sha256: sha256(`provision-credential-scope:${suffix}`),
      supervisor_bind_ttl_seconds: 30,
      credential_session_hard_ttl_seconds: 3600,
      credential_session_heartbeat_seconds: 10,
      credential_session_max_calls: 100,
      per_call_capability_ttl_seconds: 60,
      post_quiesce_finalize_ttl_seconds: 600,
    };
  };
  return {
    policy_version: "external-execution-v1" as const,
    runtime_authority_attestor: {
      service_identity: "provision-runtime-authority-attestor-v1",
      attestor_binary_sha256: sha256("provision-attestor-binary"),
      attestor_policy_sha256: sha256("provision-attestor-policy"),
      attestor_public_key_base64: attestorPublicKeyBase64,
      attestor_public_key_sha256: attestorPublicKeySha256,
      attestor_key_id: "provision-attestor-key-v1",
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

function passedRegistry(): LearningExperimentProvisioningRegistry {
  const gate = resolveLearningGatePolicy(LEARNING_GATE_POLICY_ID, LEARNING_GATE_POLICY_VERSION);
  const calibration = canonical({
    contract_version: "aionis_test_gate_calibration_v1",
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
      assert.equal(policyId, gate.policy_id);
      assert.equal(policyVersion, gate.policy_version);
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

function integrityProfile(overrides: Record<string, unknown> = {}) {
  const allowedVerifiers = [{
    kind: "deterministic_scorer" as const,
    version: "provision-scorer-v1",
    config_sha256: sha256("provision-scorer-config-v1"),
  }];
  const verifierPolicySha256 = canonical({ allowed_verifiers: allowedVerifiers }).sha256;
  const [rule] = parseAdmissionCandidatePolicyProfileRules(stableStringify([{
    profile_id: "provision-shadow-profile",
    mode: "active",
    task_families: ["repository_change"],
    experiment: {
      experiment_id: "provision-integrity-experiment",
      revision: 1,
      serving_phase: "shadow",
      evidence_intent: "integrity_only",
      assignment_design: "diagnostic_hash_v1",
      candidate_policy_id: AIONIS_ADMISSION_CANDIDATE_POLICY_ID,
      candidate_policy_version: AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION,
      candidate_allocation_bps: 5000,
      gate_policy_id: LEARNING_GATE_POLICY_ID,
      gate_policy_version: LEARNING_GATE_POLICY_VERSION,
      required_evidence_series: {
        offline_paired: "provision-offline-v1",
        production_shadow: "provision-shadow-v1",
        tool_e2e: "provision-tool-v1",
        runtime_integrity: "provision-integrity-v1",
      },
      external_execution_policy_ref: { registry_key: "external-execution-v1" },
      collection_sources: [{
        principal_sha256: sha256("provision-principal-v1"),
        class: "eligible_host",
        collector_id: "provision-host-collector",
        collector_version: "provision-collector-v1",
        verifier_policy_sha256: verifierPolicySha256,
        allowed_verifiers: allowedVerifiers,
      }],
      safety_pause_mode: "automatic",
    },
    ...overrides,
  }]));
  assert.ok(rule);
  return rule;
}

function confirmatoryExternalInputs() {
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

function confirmatoryProfile() {
  const integrity = integrityProfile();
  assert.ok(integrity.experiment);
  const [rule] = parseAdmissionCandidatePolicyProfileRules(stableStringify([{
    ...integrity,
    profile_id: "provision-confirmatory-profile",
    experiment: {
      ...integrity.experiment,
      experiment_id: "provision-confirmatory-experiment",
      serving_phase: "active_control",
      evidence_intent: "confirmatory",
      assignment_design: "matched_pair_complete_randomization_v1",
      required_external_inputs: confirmatoryExternalInputs(),
    },
  }]));
  assert.ok(rule);
  return rule;
}

function confirmatoryNamespaceManifest() {
  const waveWindows = {
    1: ["2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z", "2026-08-03T00:00:00.000Z"],
    2: ["2026-08-04T00:00:00.000Z", "2026-08-05T00:00:00.000Z", "2026-08-06T00:00:00.000Z"],
    3: ["2026-08-07T00:00:00.000Z", "2026-08-08T00:00:00.000Z", "2026-08-09T00:00:00.000Z"],
  } as const;
  return {
    contract_version: "aionis_learning_memory_namespace_manifest_v1",
    tenant_id: "tenant-provision",
    task_family: "repository_change",
    experiment_id: "provision-confirmatory-experiment",
    experiment_revision: 1,
    pairs: Array.from({ length: 384 }, (_, index) => {
      const wave = index < 96 ? 1 : index < 192 ? 2 : 3;
      const times = waveWindows[wave];
      const ordinal = String(index).padStart(3, "0");
      return {
        members: [
          { tenant_id: "tenant-provision", public_scope: `confirmatory-${ordinal}-member-0` },
          { tenant_id: "tenant-provision", public_scope: `confirmatory-${ordinal}-member-1` },
        ],
        matching_covariates: {
          contract_version: "aionis_learning_matching_covariates_v1",
          host_adapter_sha256: sha256("confirmatory-host-adapter-v1"),
          provider_model_route_sha256: sha256("confirmatory-provider-route-v1"),
          region: "test-region",
          workload_stratum: `stratum-${String(index % 8)}`,
        },
        activation: {
          activation_wave_index: wave,
          activation_starts_at: times[0],
          index_window_ends_at: times[1],
          wave_analysis_at: times[2],
        },
      };
    }),
  };
}

function confirmatoryExternalInputSet() {
  return {
    contract_version: "aionis_learning_experiment_external_input_set_v1",
    tenant_id: "tenant-provision",
    task_family: "repository_change",
    experiment_id: "provision-confirmatory-experiment",
    experiment_revision: 1,
    roles: confirmatoryExternalInputs(),
  };
}

function provisionInput(
  profileRule: AionisAdmissionCandidatePolicyProfileRule = integrityProfile(),
): LearningExperimentProvisionInput {
  return {
    tenantId: "tenant-provision",
    actor: "experiment-provisioner",
    operationId: "provision-operation-1",
    profileRule,
    taskFamily: "repository_change",
    experimentId: "provision-integrity-experiment",
    experimentRevision: 1,
  };
}

function provisionRequestSha256(args: {
  actor: string;
  databaseInstanceId: string;
  profileRule: AionisAdmissionCandidatePolicyProfileRule;
}): string {
  return sha256(stableStringify({
    contract_version: "aionis_learning_experiment_provision_request_v1",
    tenant_id: "tenant-provision",
    actor: args.actor,
    database_instance_id: args.databaseInstanceId,
    task_family: "repository_change",
    experiment_id: "provision-integrity-experiment",
    experiment_revision: 1,
    profile_rule_sha256: admissionCandidatePolicyProfileRuleDigest(args.profileRule),
    profile_rule: args.profileRule,
  }));
}

async function openRuntime(
  databasePath: string,
  faultInjector?: LiteRuntimeDatabaseFaultInjector,
): Promise<{
  database: LiteRuntimeDatabase;
  writeStore: LiteWriteStore;
  close(): Promise<void>;
}> {
  const database = createLiteRuntimeDatabase(databasePath, { faultInjector });
  const writeStore = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
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

function count(db: SqliteDatabaseLike, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

type SqliteDatabaseLike = LiteRuntimeDatabase["db"];

test("production provisioning remains fail-control before entropy or authority rows", async () => {
  const temp = tempDatabase("production-fail-control");
  const runtime = await openRuntime(temp.path);
  let entropyCalls = 0;
  try {
    const provisioner = createLiteLearningExperimentProvisioner({
      database: runtime.database,
      writeStore: runtime.writeStore,
      dependencies: {
        randomBytes: () => {
          entropyCalls += 1;
          return new Uint8Array(32);
        },
      },
    });
    await assert.rejects(
      provisioner.provision(provisionInput()),
      (error: unknown) => {
        assert.ok(error instanceof LearningExperimentProvisioningError);
        assert.equal(error.code, "learning_experiment_gate_calibration_pending");
        assert.equal(error.statusCode, 409);
        return true;
      },
    );
    assert.equal(entropyCalls, 0);

    const registeredGateWithoutExternal: LearningExperimentProvisioningRegistry = {
      ...passedRegistry(),
      resolveExternalExecutionPolicy: () => null,
    };
    const externalFailControl = createLiteLearningExperimentProvisioner({
      database: runtime.database,
      writeStore: runtime.writeStore,
      dependencies: {
        registry: registeredGateWithoutExternal,
        randomBytes: () => {
          entropyCalls += 1;
          return new Uint8Array(32);
        },
      },
    });
    await assert.rejects(
      externalFailControl.provision(provisionInput()),
      (error: unknown) => {
        assert.ok(error instanceof LearningExperimentProvisioningError);
        assert.equal(error.code, "learning_experiment_external_execution_policy_unregistered");
        return true;
      },
    );
    assert.equal(entropyCalls, 0);

    const canonicalCandidate = resolveAdmissionCandidatePolicy(
      AIONIS_ADMISSION_CANDIDATE_POLICY_ID,
      AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION,
    );
    const tupleMismatchRegistry: LearningExperimentProvisioningRegistry = {
      ...passedRegistry(),
      resolveCandidatePolicy: (() => ({
        ...canonicalCandidate,
        policy_id: "wrong-candidate-policy",
      })) as unknown as LearningExperimentProvisioningRegistry["resolveCandidatePolicy"],
    };
    const tupleFailControl = createLiteLearningExperimentProvisioner({
      database: runtime.database,
      writeStore: runtime.writeStore,
      dependencies: {
        registry: tupleMismatchRegistry,
        randomBytes: () => {
          entropyCalls += 1;
          return new Uint8Array(32);
        },
      },
    });
    await assert.rejects(
      tupleFailControl.provision(provisionInput()),
      (error: unknown) => {
        assert.ok(error instanceof LearningExperimentProvisioningError);
        assert.equal(error.code, "learning_experiment_registry_tuple_mismatch");
        return true;
      },
    );
    assert.equal(entropyCalls, 0);
    assert.equal(count(runtime.database.db, "lite_learning_policy_versions"), 0);
    assert.equal(count(runtime.database.db, "lite_learning_collection_principal_bindings"), 0);
    assert.equal(count(runtime.database.db, "lite_learning_experiment_revisions"), 0);
    assert.equal(count(runtime.database.db, "lite_runtime_write_operations"), 0);
  } finally {
    await runtime.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("integrity provisioning atomically stores registry authority, one 32-byte seed, receipt, and safe manifest", async () => {
  const temp = tempDatabase("integrity-success");
  const runtime = await openRuntime(temp.path);
  const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 31);
  let entropyCalls = 0;
  try {
    const dependencies: LearningExperimentProvisioningDependencies = {
      registry: passedRegistry(),
      randomBytes: (size) => {
        assert.equal(size, 32);
        entropyCalls += 1;
        return seed;
      },
      now: () => "2026-07-14T08:00:00.000Z",
    };
    const provisioner = createLiteLearningExperimentProvisioner({
      database: runtime.database,
      writeStore: runtime.writeStore,
      dependencies,
    });
    const result = await provisioner.provision(provisionInput());
    assert.equal(result.replayed, false);
    assert.equal(entropyCalls, 1);
    assert.equal(count(runtime.database.db, "lite_learning_policy_versions"), 2);
    assert.equal(count(runtime.database.db, "lite_learning_collection_principal_bindings"), 1);
    assert.equal(count(runtime.database.db, "lite_learning_experiment_revisions"), 1);
    assert.equal(count(runtime.database.db, "lite_runtime_write_operations"), 1);

    const revision = runtime.database.db.prepare(
      `SELECT diagnostic_assignment_seed, diagnostic_assignment_seed_sha256,
              confirmatory_assignment_bits
       FROM lite_learning_experiment_revisions`,
    ).get() as {
      diagnostic_assignment_seed: Uint8Array;
      diagnostic_assignment_seed_sha256: string;
      confirmatory_assignment_bits: Uint8Array | null;
    };
    assert.deepEqual(Buffer.from(revision.diagnostic_assignment_seed), Buffer.from(seed));
    assert.equal(revision.diagnostic_assignment_seed_sha256, sha256(seed));
    assert.equal(revision.confirmatory_assignment_bits, null);
    assert.equal(result.applicabilityManifest.diagnostic_assignment_seed_sha256, sha256(seed));
    assert.equal(result.applicabilityManifest.cohort, null);
    assert.equal(result.applicabilityManifest.collection_sources.length, 1);
    assert.equal(result.receipt.applicability_manifest_sha256, sha256(result.applicabilityManifestJson));
    assert.equal(result.applicabilityManifestJson.includes(Buffer.from(seed).toString("hex")), false);
    assert.equal(result.applicabilityManifestJson.includes(Buffer.from(seed).toString("base64")), false);
    assert.doesNotMatch(result.applicabilityManifestJson, /assigned_arm|store_scope|assignment_bits/u);
    assert.throws(() => LearningExperimentApplicabilityManifestV1Schema.parse({
      ...result.applicabilityManifest,
      provisioned_at: "2026-07-14T16:00:00.000+08:00",
    }));
    assert.throws(() => LearningExperimentApplicabilityManifestV1Schema.parse({
      ...result.applicabilityManifest,
      assignment_design: "matched_pair_complete_randomization_v1",
    }));
    assert.throws(() => LearningExperimentApplicabilityManifestV1Schema.parse({
      ...result.applicabilityManifest,
      profile: { ...result.applicabilityManifest.profile, agent_roles: ["operator"] },
    }));

    const regenerated = await provisioner.regenerateApplicabilityManifest({
      tenantId: "tenant-provision",
      experimentId: "provision-integrity-experiment",
      experimentRevision: 1,
    });
    assert.equal(stableStringify(regenerated), result.applicabilityManifestJson);
    await createLiteLearningEpisodeLedgerAccess(runtime.database).verifyIntegrity();
  } finally {
    await runtime.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("operation receipt provides exact replay across restart and changed requests conflict", async () => {
  const temp = tempDatabase("exact-replay");
  let entropyCalls = 0;
  const dependencies: LearningExperimentProvisioningDependencies = {
    registry: passedRegistry(),
    randomBytes: (size) => {
      assert.equal(size, 32);
      entropyCalls += 1;
      return Uint8Array.from({ length: 32 }, (_, index) => index + 61);
    },
    now: () => "2026-07-14T08:01:00.000Z",
  };
  let firstReceiptJson = "";
  try {
    const firstRuntime = await openRuntime(temp.path);
    try {
      const provisioner = createLiteLearningExperimentProvisioner({
        database: firstRuntime.database,
        writeStore: firstRuntime.writeStore,
        dependencies,
      });
      const first = await provisioner.provision(provisionInput());
      firstReceiptJson = first.receiptJson;
      const inProcessReplay = await provisioner.provision(provisionInput());
      assert.equal(inProcessReplay.replayed, true);
      assert.equal(inProcessReplay.receiptJson, firstReceiptJson);
      assert.equal(entropyCalls, 1);
    } finally {
      await firstRuntime.close();
    }

    const reopened = await openRuntime(temp.path);
    try {
      const provisioner = createLiteLearningExperimentProvisioner({
        database: reopened.database,
        writeStore: reopened.writeStore,
        dependencies,
      });
      const replay = await provisioner.provision(provisionInput());
      assert.equal(replay.replayed, true);
      assert.equal(replay.receiptJson, firstReceiptJson);
      assert.equal(entropyCalls, 1);
      await assert.rejects(
        provisioner.provision({ ...provisionInput(), actor: "different-provisioner" }),
        (error: unknown) => {
          assert.ok(error instanceof LearningExperimentProvisioningError);
          assert.equal(error.code, "learning_experiment_operation_id_conflict");
          return true;
        },
      );
      assert.equal(entropyCalls, 1);
      assert.equal(count(reopened.database.db, "lite_learning_experiment_revisions"), 1);
      assert.equal(count(reopened.database.db, "lite_runtime_write_operations"), 1);
    } finally {
      await reopened.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("concurrent exact provision calls serialize before CSPRNG and return one receipt", async () => {
  const temp = tempDatabase("concurrent-replay");
  const runtime = await openRuntime(temp.path);
  let entropyCalls = 0;
  try {
    const provisioner = createLiteLearningExperimentProvisioner({
      database: runtime.database,
      writeStore: runtime.writeStore,
      dependencies: {
        registry: passedRegistry(),
        randomBytes: (size) => {
          assert.equal(size, 32);
          entropyCalls += 1;
          return Uint8Array.from({ length: 32 }, (_, index) => index + 91);
        },
        now: () => "2026-07-14T08:02:00.000Z",
      },
    });
    const [left, right] = await Promise.all([
      provisioner.provision(provisionInput()),
      provisioner.provision(provisionInput()),
    ]);
    assert.equal(entropyCalls, 1);
    assert.equal(left.receiptJson, right.receiptJson);
    assert.deepEqual([left.replayed, right.replayed].sort(), [false, true]);
    assert.equal(count(runtime.database.db, "lite_learning_experiment_revisions"), 1);
    assert.equal(count(runtime.database.db, "lite_runtime_write_operations"), 1);
  } finally {
    await runtime.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("commit faults roll revision, registrations, bindings, and receipt back together", async () => {
  const temp = tempDatabase("atomic-rollback");
  let failCommit = false;
  const runtime = await openRuntime(temp.path, (phase) => {
    if (failCommit && phase === "before_commit") throw new Error("injected-provision-before-commit");
  });
  let entropyCalls = 0;
  try {
    const provisioner = createLiteLearningExperimentProvisioner({
      database: runtime.database,
      writeStore: runtime.writeStore,
      dependencies: {
        registry: passedRegistry(),
        randomBytes: () => {
          entropyCalls += 1;
          return Uint8Array.from({ length: 32 }, (_, index) => index + entropyCalls);
        },
        now: () => "2026-07-14T08:03:00.000Z",
      },
    });
    failCommit = true;
    await assert.rejects(provisioner.provision(provisionInput()), /injected-provision-before-commit/u);
    assert.equal(entropyCalls, 1);
    assert.equal(count(runtime.database.db, "lite_learning_policy_versions"), 0);
    assert.equal(count(runtime.database.db, "lite_learning_collection_principal_bindings"), 0);
    assert.equal(count(runtime.database.db, "lite_learning_experiment_revisions"), 0);
    assert.equal(count(runtime.database.db, "lite_runtime_write_operations"), 0);

    failCommit = false;
    const result = await provisioner.provision(provisionInput());
    assert.equal(result.replayed, false);
    assert.equal(entropyCalls, 2);
    assert.equal(count(runtime.database.db, "lite_learning_experiment_revisions"), 1);
    assert.equal(count(runtime.database.db, "lite_runtime_write_operations"), 1);
  } finally {
    await runtime.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("strict profile matching and canonical receipt corruption fail closed", async () => {
  const temp = tempDatabase("strict-input-and-receipt");
  const runtime = await openRuntime(temp.path);
  let entropyCalls = 0;
  try {
    const provisioner = createLiteLearningExperimentProvisioner({
      database: runtime.database,
      writeStore: runtime.writeStore,
      dependencies: {
        registry: passedRegistry(),
        randomBytes: () => {
          entropyCalls += 1;
          return new Uint8Array(32).fill(7);
        },
        now: () => "2026-07-14T08:04:00.000Z",
      },
    });
    await assert.rejects(
      provisioner.provision({
        ...provisionInput(),
        taskFamily: "other-family",
      }),
      (error: unknown) => {
        assert.ok(error instanceof LearningExperimentProvisioningError);
        assert.equal(error.code, "learning_experiment_task_family_not_exact");
        return true;
      },
    );
    assert.equal(entropyCalls, 0);

    const originalInput = provisionInput();
    const provisioned = await provisioner.provision(originalInput);
    assert.equal(entropyCalls, 1);
    const forgedActor = "forged-experiment-provisioner";
    const databaseInstanceId = await createLiteLearningEpisodeLedgerAccess(
      runtime.database,
    ).databaseInstanceId();
    const forgedRequestSha256 = provisionRequestSha256({
      actor: forgedActor,
      databaseInstanceId,
      profileRule: originalInput.profileRule,
    });
    const forgedManifest = {
      ...provisioned.receipt.applicability_manifest,
      provision_request_sha256: forgedRequestSha256,
      provisioning_actor_sha256: sha256(forgedActor),
    };
    const tamperedReceipt = {
      ...provisioned.receipt,
      actor: forgedActor,
      request_sha256: forgedRequestSha256,
      applicability_manifest_sha256: sha256(stableStringify(forgedManifest)),
      applicability_manifest: forgedManifest,
    };
    runtime.database.db.prepare(
      `UPDATE lite_runtime_write_operations SET request_sha256 = ?, receipt_json = ?
       WHERE tenant_id = ? AND scope = ? AND operation_kind = ? AND operation_id = ?`,
    ).run(
      forgedRequestSha256,
      stableStringify(tamperedReceipt),
      "tenant-provision",
      LEARNING_EXPERIMENT_PROVISION_AUTHORITY_SCOPE,
      LEARNING_EXPERIMENT_PROVISION_OPERATION_KIND,
      "provision-operation-1",
    );
    await assert.rejects(provisioner.provision({ ...originalInput, actor: forgedActor }));
    assert.equal(entropyCalls, 1);

    runtime.database.db.prepare(
      `UPDATE lite_runtime_write_operations SET request_sha256 = ?, receipt_json = ?
       WHERE tenant_id = ? AND scope = ? AND operation_kind = ? AND operation_id = ?`,
    ).run(
      provisioned.receipt.request_sha256,
      provisioned.receiptJson,
      "tenant-provision",
      LEARNING_EXPERIMENT_PROVISION_AUTHORITY_SCOPE,
      LEARNING_EXPERIMENT_PROVISION_OPERATION_KIND,
      "provision-operation-1",
    );
    const forgedOperationId = "forged-provision-operation";
    const operationForgedManifest = {
      ...provisioned.receipt.applicability_manifest,
      provision_operation_id_sha256: sha256(forgedOperationId),
    };
    const operationForgedReceipt = {
      ...provisioned.receipt,
      operation_id: forgedOperationId,
      applicability_manifest_sha256: sha256(stableStringify(operationForgedManifest)),
      applicability_manifest: operationForgedManifest,
    };
    try {
      runtime.database.db.prepare(
        `UPDATE lite_runtime_write_operations SET operation_id = ?, receipt_json = ?
         WHERE tenant_id = ? AND scope = ? AND operation_kind = ? AND operation_id = ?`,
      ).run(
        forgedOperationId,
        stableStringify(operationForgedReceipt),
        "tenant-provision",
        LEARNING_EXPERIMENT_PROVISION_AUTHORITY_SCOPE,
        LEARNING_EXPERIMENT_PROVISION_OPERATION_KIND,
        "provision-operation-1",
      );
      await assert.rejects(provisioner.provision({
        ...originalInput,
        operationId: forgedOperationId,
      }));
    } finally {
      runtime.database.db.prepare(
        `UPDATE lite_runtime_write_operations
         SET operation_id = ?, request_sha256 = ?, receipt_json = ?
         WHERE tenant_id = ? AND scope = ? AND operation_kind = ? AND operation_id = ?`,
      ).run(
        "provision-operation-1",
        provisioned.receipt.request_sha256,
        provisioned.receiptJson,
        "tenant-provision",
        LEARNING_EXPERIMENT_PROVISION_AUTHORITY_SCOPE,
        LEARNING_EXPERIMENT_PROVISION_OPERATION_KIND,
        forgedOperationId,
      );
    }
    assert.equal(entropyCalls, 1);
    assert.equal(count(runtime.database.db, "lite_learning_experiment_revisions"), 1);
  } finally {
    await runtime.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

function provisionCliArgs(args: {
  databasePath: string;
  profilePath: string;
  outPath: string;
  extra?: readonly string[];
  tenantId?: string;
  taskFamily?: string;
  experimentId?: string;
  revision?: number;
}): string[] {
  return [
    "provision",
    "--db", args.databasePath,
    "--tenant", args.tenantId ?? "tenant-provision",
    "--actor", "experiment-provisioner",
    "--operation-id", "provision-operation-1",
    "--profile-rule-file", args.profilePath,
    "--task-family", args.taskFamily ?? "repository_change",
    "--experiment-id", args.experimentId ?? "provision-integrity-experiment",
    "--revision", String(args.revision ?? 1),
    "--out", args.outPath,
    ...(args.extra ?? []),
  ];
}

function confirmatoryCliArgs(args: {
  databasePath: string;
  profilePath: string;
  namespacePath?: string;
  externalInputPath?: string;
  outPath: string;
}): string[] {
  return provisionCliArgs({
    databasePath: args.databasePath,
    profilePath: args.profilePath,
    outPath: args.outPath,
    experimentId: "provision-confirmatory-experiment",
    extra: [
      ...(args.namespacePath === undefined
        ? []
        : ["--memory-namespace-manifest", args.namespacePath]),
      ...(args.externalInputPath === undefined
        ? []
        : ["--external-input-set", args.externalInputPath]),
    ],
  });
}

async function cliFailureCode(argv: readonly string[]): Promise<string> {
  const stderr: string[] = [];
  const exitCode = await runLearningExperimentCli(argv, {
    stdout: () => undefined,
    stderr: (value) => stderr.push(value),
  });
  assert.equal(exitCode, 1);
  assert.equal(stderr.length, 1);
  return (JSON.parse(stderr[0]!) as { code: string }).code;
}

test("CLI exact replay regenerates a 0600 canonical manifest after an output failure", async () => {
  const temp = tempDatabase("cli-output-recovery");
  const profilePath = path.join(temp.directory, "profile-rule.json");
  const blockedParent = path.join(temp.directory, "blocked-parent");
  const blockedOut = path.join(blockedParent, "manifest.json");
  const recoveredOut = path.join(temp.directory, "artifacts", "manifest.json");
  fs.writeFileSync(profilePath, `${JSON.stringify(integrityProfile(), null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(blockedParent, "not-a-directory", { mode: 0o600 });
  let entropyCalls = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const options = {
    stdout: (value: string) => stdout.push(value),
    stderr: (value: string) => stderr.push(value),
  };
  try {
    const authorityRuntime = await openRuntime(temp.path);
    try {
      const provisioner = createLiteLearningExperimentProvisioner({
        database: authorityRuntime.database,
        writeStore: authorityRuntime.writeStore,
        dependencies: {
          registry: passedRegistry(),
          randomBytes: (size: number) => {
            assert.equal(size, 32);
            entropyCalls += 1;
            return Uint8Array.from({ length: 32 }, (_, index) => index + 121);
          },
          now: () => "2026-07-14T08:05:00.000Z",
        },
      });
      await provisioner.provision(provisionInput());
    } finally {
      await authorityRuntime.close();
    }
    assert.equal(entropyCalls, 1);

    const failedOutputExit = await runLearningExperimentCli(provisionCliArgs({
      databasePath: temp.path,
      profilePath,
      outPath: blockedOut,
    }), options);
    assert.equal(failedOutputExit, 1);
    assert.equal(entropyCalls, 1);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length, 1);

    const committed = await openRuntime(temp.path);
    try {
      assert.equal(count(committed.database.db, "lite_learning_experiment_revisions"), 1);
      assert.equal(count(committed.database.db, "lite_runtime_write_operations"), 1);
    } finally {
      await committed.close();
    }

    stderr.length = 0;
    const recoveredExit = await runLearningExperimentCli(provisionCliArgs({
      databasePath: temp.path,
      profilePath,
      outPath: recoveredOut,
    }), options);
    assert.equal(recoveredExit, 0);
    assert.equal(entropyCalls, 1);
    assert.equal(stderr.length, 0);
    assert.equal(stdout.length, 1);
    assert.equal(fs.statSync(recoveredOut).mode & 0o777, 0o600);
    const manifestJson = fs.readFileSync(recoveredOut, "utf8");
    assert.equal(manifestJson, stableStringify(JSON.parse(manifestJson)));
    const receipt = JSON.parse(stdout[0]!.trim()) as Record<string, unknown>;
    assert.equal(
      manifestJson,
      stableStringify(receipt.applicability_manifest),
    );
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("CLI rejects caller randomness, duplicate flags, and integrity-only confirmatory inputs before opening the DB", async () => {
  const temp = tempDatabase("cli-strict-arguments");
  const profilePath = path.join(temp.directory, "profile-rule.json");
  const outPath = path.join(temp.directory, "manifest.json");
  fs.writeFileSync(profilePath, stableStringify(integrityProfile()), { mode: 0o600 });
  try {
    for (const testCase of [
      {
        extra: ["--diagnostic-assignment-seed", "caller-seed"],
        code: "learning_experiment_cli_assignment_authority_forbidden",
      },
      {
        extra: ["--tenant", "duplicate-tenant"],
        code: "learning_experiment_cli_duplicate_flag",
      },
      {
        extra: ["--memory-namespace-manifest", path.join(temp.directory, "namespaces.json")],
        code: "learning_experiment_cli_confirmatory_inputs_forbidden",
      },
      {
        extra: [],
        code: "learning_experiment_cli_path_collision",
        outPath: temp.path,
      },
    ] as const) {
      const stderr: string[] = [];
      const exitCode = await runLearningExperimentCli(provisionCliArgs({
        databasePath: temp.path,
        profilePath,
        outPath: "outPath" in testCase ? testCase.outPath : outPath,
        extra: testCase.extra,
      }), { stderr: (value) => stderr.push(value), stdout: () => undefined });
      assert.equal(exitCode, 1);
      assert.equal((JSON.parse(stderr[0]!) as { code: string }).code, testCase.code);
      assert.equal(fs.existsSync(temp.path), false);
    }

    const initialized = await openRuntime(temp.path);
    let databaseInstanceId: string;
    try {
      databaseInstanceId = await createLiteLearningEpisodeLedgerAccess(
        initialized.database,
      ).databaseInstanceId();
    } finally {
      await initialized.close();
    }
    const collisionErrors: string[] = [];
    const collisionExit = await runLearningExperimentCli(provisionCliArgs({
      databasePath: temp.path,
      profilePath,
      outPath: temp.path,
    }), { stderr: (value) => collisionErrors.push(value), stdout: () => undefined });
    assert.equal(collisionExit, 1);
    assert.equal(
      (JSON.parse(collisionErrors[0]!) as { code: string }).code,
      "learning_experiment_cli_path_collision",
    );
    const preserved = await openRuntime(temp.path);
    try {
      assert.equal(
        await createLiteLearningEpisodeLedgerAccess(preserved.database).databaseInstanceId(),
        databaseInstanceId,
      );
      await createLiteLearningEpisodeLedgerAccess(preserved.database).verifyIntegrity();
    } finally {
      await preserved.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("confirmatory CLI requires both strict reviewed input files before opening the DB", async () => {
  const temp = tempDatabase("cli-confirmatory-input-contract");
  const profilePath = path.join(temp.directory, "confirmatory-profile.json");
  const namespacePath = path.join(temp.directory, "namespaces.json");
  const externalInputPath = path.join(temp.directory, "external-inputs.json");
  const outPath = path.join(temp.directory, "manifest.json");
  fs.writeFileSync(profilePath, stableStringify(confirmatoryProfile()), { mode: 0o600 });
  fs.writeFileSync(namespacePath, stableStringify(confirmatoryNamespaceManifest()), { mode: 0o600 });
  fs.writeFileSync(externalInputPath, stableStringify(confirmatoryExternalInputSet()), { mode: 0o600 });
  try {
    for (const inputPaths of [
      {},
      { namespacePath },
      { externalInputPath },
    ] as const) {
      assert.equal(
        await cliFailureCode(confirmatoryCliArgs({
          databasePath: temp.path,
          profilePath,
          outPath,
          ...inputPaths,
        })),
        "learning_experiment_cli_confirmatory_inputs_required",
      );
      assert.equal(fs.existsSync(temp.path), false);
    }

    const relativeCode = await cliFailureCode(confirmatoryCliArgs({
      databasePath: temp.path,
      profilePath,
      namespacePath: "relative-namespaces.json",
      externalInputPath,
      outPath,
    }));
    assert.equal(relativeCode, "learning_experiment_cli_absolute_path_required");
    assert.equal(fs.existsSync(temp.path), false);
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("confirmatory CLI rejects tenant-prefixed store-scope overflow before opening the DB", async () => {
  const temp = tempDatabase("cli-confirmatory-scope-encoding");
  const profilePath = path.join(temp.directory, "confirmatory-profile.json");
  const namespacePath = path.join(temp.directory, "namespaces.json");
  const externalInputPath = path.join(temp.directory, "external-inputs.json");
  const outPath = path.join(temp.directory, "manifest.json");
  const namespaceManifest = confirmatoryNamespaceManifest();
  namespaceManifest.pairs[383]!.members[0]!.public_scope = `${"z".repeat(230)}0`;
  namespaceManifest.pairs[383]!.members[1]!.public_scope = `${"z".repeat(230)}1`;
  fs.writeFileSync(profilePath, stableStringify(confirmatoryProfile()), { mode: 0o600 });
  fs.writeFileSync(namespacePath, stableStringify(namespaceManifest), { mode: 0o600 });
  fs.writeFileSync(externalInputPath, stableStringify(confirmatoryExternalInputSet()), { mode: 0o600 });
  const priorDefaultTenant = process.env.MEMORY_TENANT_ID;
  process.env.MEMORY_TENANT_ID = "default";
  try {
    assert.equal(
      await cliFailureCode(confirmatoryCliArgs({
        databasePath: temp.path,
        profilePath,
        namespacePath,
        externalInputPath,
        outPath,
      })),
      "learning_experiment_cli_memory_namespace_scope_encoding_invalid",
    );
    for (const forbiddenPath of [temp.path, `${temp.path}-wal`, `${temp.path}-shm`, outPath]) {
      assert.equal(fs.existsSync(forbiddenPath), false);
    }
  } finally {
    if (priorDefaultTenant === undefined) delete process.env.MEMORY_TENANT_ID;
    else process.env.MEMORY_TENANT_ID = priorDefaultTenant;
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("confirmatory CLI rejects non-regular, oversized, non-UTF8, and non-contract input files", async () => {
  const temp = tempDatabase("cli-confirmatory-strict-files");
  const profilePath = path.join(temp.directory, "confirmatory-profile.json");
  const validNamespacePath = path.join(temp.directory, "valid-namespaces.json");
  const validExternalInputPath = path.join(temp.directory, "valid-external-inputs.json");
  const candidatePath = path.join(temp.directory, "candidate-input");
  const outPath = path.join(temp.directory, "manifest.json");
  fs.writeFileSync(profilePath, stableStringify(confirmatoryProfile()), { mode: 0o600 });
  fs.writeFileSync(validNamespacePath, stableStringify(confirmatoryNamespaceManifest()), { mode: 0o600 });
  fs.writeFileSync(validExternalInputPath, stableStringify(confirmatoryExternalInputSet()), { mode: 0o600 });
  try {
    const cases = [
      {
        code: "learning_experiment_cli_memory_namespace_manifest_invalid",
        write: () => fs.mkdirSync(candidatePath),
        args: () => ({ namespacePath: candidatePath, externalInputPath: validExternalInputPath }),
      },
      {
        code: "learning_experiment_cli_memory_namespace_manifest_invalid",
        write: () => fs.writeFileSync(candidatePath, Buffer.from([0xff, 0xfe]), { mode: 0o600 }),
        args: () => ({ namespacePath: candidatePath, externalInputPath: validExternalInputPath }),
      },
      {
        code: "learning_experiment_cli_memory_namespace_manifest_invalid",
        write: () => fs.writeFileSync(candidatePath, "[]", { mode: 0o600 }),
        args: () => ({ namespacePath: candidatePath, externalInputPath: validExternalInputPath }),
      },
      {
        code: "learning_experiment_cli_memory_namespace_manifest_too_large",
        write: () => fs.writeFileSync(candidatePath, Buffer.alloc((2 * 1024 * 1024) + 1, 0x20), { mode: 0o600 }),
        args: () => ({ namespacePath: candidatePath, externalInputPath: validExternalInputPath }),
      },
      {
        code: "learning_experiment_cli_external_input_set_invalid",
        write: () => fs.writeFileSync(candidatePath, stableStringify({
          ...confirmatoryExternalInputSet(),
          unexpected: true,
        }), { mode: 0o600 }),
        args: () => ({ namespacePath: validNamespacePath, externalInputPath: candidatePath }),
      },
      {
        code: "learning_experiment_cli_external_input_set_too_large",
        write: () => fs.writeFileSync(candidatePath, Buffer.alloc((512 * 1024) + 1, 0x20), { mode: 0o600 }),
        args: () => ({ namespacePath: validNamespacePath, externalInputPath: candidatePath }),
      },
    ] as const;
    for (const testCase of cases) {
      fs.rmSync(candidatePath, { recursive: true, force: true });
      testCase.write();
      assert.equal(
        await cliFailureCode(confirmatoryCliArgs({
          databasePath: temp.path,
          profilePath,
          outPath,
          ...testCase.args(),
        })),
        testCase.code,
      );
      assert.equal(fs.existsSync(temp.path), false);
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("confirmatory CLI protects every reviewed file from direct, inode, and symlink aliases", async () => {
  const temp = tempDatabase("cli-confirmatory-path-collisions");
  const profilePath = path.join(temp.directory, "confirmatory-profile.json");
  const namespacePath = path.join(temp.directory, "namespaces.json");
  const externalInputPath = path.join(temp.directory, "external-inputs.json");
  const ordinaryOut = path.join(temp.directory, "manifest.json");
  const namespaceBytes = stableStringify(confirmatoryNamespaceManifest());
  const externalInputBytes = stableStringify(confirmatoryExternalInputSet());
  fs.writeFileSync(profilePath, stableStringify(confirmatoryProfile()), { mode: 0o600 });
  fs.writeFileSync(namespacePath, namespaceBytes, { mode: 0o600 });
  fs.writeFileSync(externalInputPath, externalInputBytes, { mode: 0o600 });
  const namespaceHardLink = path.join(temp.directory, "namespace-hard-link.json");
  const externalInputSymlink = path.join(temp.directory, "external-input-symlink.json");
  fs.linkSync(namespacePath, namespaceHardLink);
  fs.symlinkSync(externalInputPath, externalInputSymlink);
  try {
    const collisionCases = [
      {
        namespacePath,
        externalInputPath,
        outPath: namespacePath,
      },
      {
        namespacePath,
        externalInputPath,
        outPath: namespaceHardLink,
      },
      {
        namespacePath,
        externalInputPath,
        outPath: externalInputSymlink,
      },
      {
        namespacePath,
        externalInputPath: namespaceHardLink,
        outPath: ordinaryOut,
      },
      {
        namespacePath: profilePath,
        externalInputPath,
        outPath: ordinaryOut,
      },
      {
        namespacePath: temp.path,
        externalInputPath,
        outPath: ordinaryOut,
      },
      {
        namespacePath: `${temp.path}-wal`,
        externalInputPath,
        outPath: ordinaryOut,
      },
      {
        namespacePath,
        externalInputPath: `${temp.path}-shm`,
        outPath: ordinaryOut,
      },
      ...((process.platform === "darwin" || process.platform === "win32")
        ? [{
            namespacePath,
            externalInputPath,
            outPath: namespacePath.toLocaleUpperCase("en-US"),
          }]
        : []),
    ];
    for (const testCase of collisionCases) {
      assert.equal(
        await cliFailureCode(confirmatoryCliArgs({
          databasePath: temp.path,
          profilePath,
          ...testCase,
        })),
        "learning_experiment_cli_path_collision",
      );
      assert.equal(fs.readFileSync(namespacePath, "utf8"), namespaceBytes);
      assert.equal(fs.readFileSync(externalInputPath, "utf8"), externalInputBytes);
      assert.equal(fs.existsSync(temp.path), false);
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("production confirmatory CLI remains calibration fail-control after strict input parsing", async () => {
  const temp = tempDatabase("cli-confirmatory-production-fail-control");
  const profilePath = path.join(temp.directory, "confirmatory-profile.json");
  const namespacePath = path.join(temp.directory, "namespaces.json");
  const externalInputPath = path.join(temp.directory, "external-inputs.json");
  const outPath = path.join(temp.directory, "manifest.json");
  fs.writeFileSync(profilePath, stableStringify(confirmatoryProfile()), { mode: 0o600 });
  fs.writeFileSync(namespacePath, stableStringify(confirmatoryNamespaceManifest()), { mode: 0o600 });
  fs.writeFileSync(externalInputPath, stableStringify(confirmatoryExternalInputSet()), { mode: 0o600 });
  try {
    assert.equal(
      await cliFailureCode(confirmatoryCliArgs({
        databasePath: temp.path,
        profilePath,
        namespacePath,
        externalInputPath,
        outPath,
      })),
      "learning_experiment_gate_calibration_pending",
    );
    assert.equal(fs.existsSync(outPath), false);
    const runtime = await openRuntime(temp.path);
    try {
      assert.equal(count(runtime.database.db, "lite_learning_policy_versions"), 0);
      assert.equal(count(runtime.database.db, "lite_learning_collection_principal_bindings"), 0);
      assert.equal(count(runtime.database.db, "lite_learning_experiment_revisions"), 0);
      assert.equal(count(runtime.database.db, "lite_learning_confirmatory_attempts"), 0);
      assert.equal(count(runtime.database.db, "lite_learning_randomization_pairs"), 0);
      assert.equal(count(runtime.database.db, "lite_learning_namespace_leases"), 0);
      assert.equal(count(runtime.database.db, "lite_runtime_write_operations"), 0);
    } finally {
      await runtime.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

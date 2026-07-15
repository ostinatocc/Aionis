import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import stableStringify from "fast-json-stable-stringify";

import {
  admissionCandidatePolicyExperimentDeclarationDigest,
  admissionCandidatePolicyProfileRuleDigest,
  parseAdmissionCandidatePolicyProfileRules,
} from "../../src/config.ts";
import {
  learningCollectionSourcePolicyProjection,
  resolveLearningExperimentForGuide,
  type LearningExperimentResolverRegistry,
} from "../../src/memory/learning-experiment-resolver.ts";
import {
  createLearningExternalExecutionPolicyRegistry,
  createLearningExternalExecutionPolicyRegistryEntry,
  LEARNING_EXTERNAL_EXECUTION_POLICY_KEY,
  PRODUCTION_LEARNING_EXTERNAL_EXECUTION_POLICY_REGISTRY,
} from "../../src/memory/learning-external-execution-policy.ts";
import {
  learningCollectionPrincipalSha256,
} from "../../src/memory/learning-episode-ledger.ts";
import {
  AIONIS_ADMISSION_CANDIDATE_POLICY_ID,
  AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION,
  resolveAdmissionCandidatePolicy,
} from "../../src/memory/admission-candidate-policy.ts";
import {
  LEARNING_GATE_POLICY_ID,
  LEARNING_GATE_POLICY_VERSION,
  resolveLearningGatePolicy,
} from "../../src/memory/learning-gate-policy.ts";
import {
  createLiteLearningEpisodeLedgerAccess,
  learningCollectionPrincipalBindingDigest,
  LITE_LEARNING_LEDGER_REQUIRED_COLUMNS,
  type LiteLearningAuthorityRow,
} from "../../src/store/lite-learning-episode-ledger.ts";
import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.ts";
import { createLiteWriteStoreFromDatabase } from "../../src/store/lite-write-store.ts";
import type { AuthPrincipal } from "../../src/util/auth.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): { json: string; sha256: string } {
  const json = stableStringify(value);
  return { json, sha256: sha256(json) };
}

function authorityRow(
  table: keyof typeof LITE_LEARNING_LEDGER_REQUIRED_COLUMNS,
  values: Record<string, string | number | Uint8Array | null>,
): LiteLearningAuthorityRow {
  return Object.assign(Object.fromEntries(
    LITE_LEARNING_LEDGER_REQUIRED_COLUMNS[table]
      .filter((column) => column !== "row_id")
      .map((column) => [column, null]),
  ), values) as LiteLearningAuthorityRow;
}

function externalExecutionPolicy(databaseInstanceId: string) {
  const publicKey = Buffer.alloc(32, 9);
  const publicKeyBase64 = publicKey.toString("base64");
  const publicKeySha256 = sha256(publicKey.toString("binary"));
  const launcher = {
    service_launcher_policy_sha256: sha256("resolver-launcher-policy"),
    service_launcher_binary_sha256: sha256("resolver-launcher-binary"),
    service_launcher_public_key_sha256: publicKeySha256,
    service_launcher_key_id: "resolver-launcher-key-v1",
  };
  const role = (credentialSessionClass: string, suffix: string) => ({
    runner_principal_sha256: sha256(`resolver-runner:${suffix}`),
    credential_session_class: credentialSessionClass,
    broker_policy_sha256: sha256(`resolver-broker-policy:${suffix}`),
    broker_binary_sha256: sha256(`resolver-broker-binary:${suffix}`),
    broker_public_key_sha256: sha256(`resolver-broker-key:${suffix}`),
    broker_key_id: `resolver-broker-key-${suffix}`,
    ...launcher,
    supervisor_executable_sha256: sha256(`resolver-supervisor:${suffix}`),
    supervisor_argv_policy_sha256: sha256(`resolver-argv:${suffix}`),
    supervisor_sandbox_policy_sha256: sha256(`resolver-sandbox:${suffix}`),
    receipt_signature_algorithm: "ed25519-v1",
    credential_scope_sha256: sha256(`resolver-scope:${suffix}`),
    supervisor_bind_ttl_seconds: 30,
    credential_session_hard_ttl_seconds: 3600,
    credential_session_heartbeat_seconds: 10,
    credential_session_max_calls: 100,
    per_call_capability_ttl_seconds: 60,
    post_quiesce_finalize_ttl_seconds: 600,
  });
  return {
    policy_version: "external-execution-v1",
    runtime_authority_attestor: {
      service_identity: "resolver-runtime-authority-attestor-v1",
      attestor_binary_sha256: sha256("resolver-attestor-binary"),
      attestor_policy_sha256: sha256("resolver-attestor-policy"),
      attestor_public_key_base64: publicKeyBase64,
      attestor_public_key_sha256: publicKeySha256,
      attestor_key_id: "resolver-attestor-key-v1",
      ...launcher,
      service_launcher_public_key_base64: publicKeyBase64,
      receipt_signature_algorithm: "ed25519-v1",
      expected_database_instance_id: databaseInstanceId,
    },
    roles: {
      offline_paired: role("immutable_paired_eval", "offline"),
      production_shadow: role("eligible_host_adapter", "shadow"),
      tool_e2e: role("formal_tool_eval", "tool"),
    },
  };
}

function tempDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-learning-resolver-"));
  return { directory, path: path.join(directory, "runtime.sqlite") };
}

test("immutable experiment resolver replays diagnostic assignment without exposing authority entropy", async () => {
  const temp = tempDatabase();
  let database = createLiteRuntimeDatabase(temp.path);
  let writeStore = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
  try {
    const ledger = createLiteLearningEpisodeLedgerAccess(database);
    const principalIdentity = {
      tenant_id: "tenant-resolver",
      agent_id: "eligible-agent",
      team_id: "eligible-team",
    };
    const principalSha256 = learningCollectionPrincipalSha256(principalIdentity);
    const allowedVerifiers = [{
      kind: "deterministic_scorer" as const,
      version: "resolver-scorer-v1",
      config_sha256: sha256("resolver-scorer-config"),
    }];
    const verifierPolicy = canonical({ allowed_verifiers: allowedVerifiers });
    const [rule] = parseAdmissionCandidatePolicyProfileRules(JSON.stringify([{
      profile_id: "resolver-shadow-profile",
      mode: "active",
      task_families: ["repository_change"],
      experiment: {
        experiment_id: "resolver-integrity-experiment",
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
          offline_paired: "resolver-offline-v1",
          production_shadow: "resolver-production-v1",
          tool_e2e: "resolver-tool-v1",
          runtime_integrity: "resolver-integrity-v1",
        },
        external_execution_policy_ref: { registry_key: "external-execution-v1" },
        collection_sources: [{
          principal_sha256: principalSha256,
          class: "eligible_host",
          collector_id: "resolver-host-collector",
          collector_version: "resolver-collector-v1",
          verifier_policy_sha256: verifierPolicy.sha256,
          allowed_verifiers: allowedVerifiers,
        }],
        safety_pause_mode: "automatic",
      },
    }]));
    assert.ok(rule?.experiment);

    const candidate = resolveAdmissionCandidatePolicy(
      AIONIS_ADMISSION_CANDIDATE_POLICY_ID,
      AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION,
    );
    const candidateConfig = canonical(candidate.config);
    const gate = resolveLearningGatePolicy(LEARNING_GATE_POLICY_ID, LEARNING_GATE_POLICY_VERSION);
    const gateCalibration = canonical({
      contract_version: "resolver-gate-calibration-v1",
      status: "passed",
      scenario_count: 96,
    });
    const gateConfig = canonical({
      ...gate.config,
      prospective_calibration_artifact_sha256: gateCalibration.sha256,
    });
    const databaseInstanceId = await ledger.databaseInstanceId();
    const externalPolicyEntry = createLearningExternalExecutionPolicyRegistryEntry({
      registryKey: LEARNING_EXTERNAL_EXECUTION_POLICY_KEY,
      databaseInstanceId,
      policy: externalExecutionPolicy(databaseInstanceId),
    });
    const externalPolicyRegistry = createLearningExternalExecutionPolicyRegistry([
      externalPolicyEntry,
    ]);
    const externalPolicy = canonical(externalPolicyEntry.policy);
    assert.equal(externalPolicyEntry.policy_sha256, externalPolicy.sha256);
    assert.equal(externalPolicyEntry.database_instance_id, databaseInstanceId);
    assert.equal(Object.isFrozen(externalPolicyEntry.policy), true);
    assert.equal(Object.isFrozen(externalPolicyEntry.policy.roles), true);
    assert.equal(externalPolicyRegistry.registry_status, "registered");
    assert.deepEqual(externalPolicyRegistry.resolve({
      registryKey: LEARNING_EXTERNAL_EXECUTION_POLICY_KEY,
      databaseInstanceId,
    }), externalPolicyEntry);
    assert.equal(externalPolicyRegistry.resolve({
      registryKey: LEARNING_EXTERNAL_EXECUTION_POLICY_KEY,
      databaseInstanceId: "f".repeat(64),
    }), null);
    assert.equal(PRODUCTION_LEARNING_EXTERNAL_EXECUTION_POLICY_REGISTRY.registry_status, "unregistered");
    assert.equal(PRODUCTION_LEARNING_EXTERNAL_EXECUTION_POLICY_REGISTRY.resolve({
      registryKey: LEARNING_EXTERNAL_EXECUTION_POLICY_KEY,
      databaseInstanceId,
    }), null);
    const sourcePolicy = canonical(learningCollectionSourcePolicyProjection(rule.experiment));
    const evidenceSeries = canonical(rule.experiment.required_evidence_series);
    const externalInputs = canonical({});
    const profileRuleSha256 = admissionCandidatePolicyProfileRuleDigest(rule);
    const declarationSha256 = admissionCandidatePolicyExperimentDeclarationDigest(rule.experiment);
    const revisionConfig = canonical({
      contract_version: "aionis_learning_experiment_config_v1",
      task_family: "repository_change",
      experiment_declaration_sha256: declarationSha256,
      profile_rule_sha256: profileRuleSha256,
      external_execution_policy_registry_key: "external-execution-v1",
      collection_source_policy_sha256: sourcePolicy.sha256,
      external_execution_policy_sha256: externalPolicy.sha256,
      gate_prospective_calibration_sha256: gateCalibration.sha256,
      required_evidence_series_sha256: evidenceSeries.sha256,
      required_external_inputs_sha256: externalInputs.sha256,
    });
    const diagnosticSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 11);
    const revision = authorityRow("lite_learning_experiment_revisions", {
      tenant_id: "tenant-resolver",
      experiment_id: rule.experiment.experiment_id,
      experiment_revision: rule.experiment.revision,
      profile_id: rule.profile_id,
      profile_rule_sha256: profileRuleSha256,
      serving_phase: "shadow",
      evidence_intent: "integrity_only",
      eligible_memory_namespace_set_sha256: null,
      eligible_memory_namespace_count: null,
      assignment_design: "diagnostic_hash_v1",
      randomization_pair_manifest_sha256: null,
      randomization_pair_count: null,
      activation_schedule_sha256: null,
      candidate_policy_id: candidate.policy_id,
      candidate_policy_version: candidate.policy_version,
      candidate_policy_implementation_sha256: candidate.implementation_contract_sha256,
      candidate_policy_config_sha256: candidate.policy_config_sha256,
      assignment_unit_kind: "store_memory_namespace_cluster",
      candidate_allocation_bps: 5000,
      diagnostic_assignment_seed: diagnosticSeed,
      diagnostic_assignment_seed_sha256: sha256(Buffer.from(diagnosticSeed).toString("binary")),
      confirmatory_assignment_bits: null,
      confirmatory_assignment_bit_count: null,
      confirmatory_assignment_bits_sha256: null,
      collection_source_policy_sha256: sourcePolicy.sha256,
      collection_source_policy_json: sourcePolicy.json,
      gate_policy_id: gate.policy_id,
      gate_policy_version: gate.policy_version,
      gate_policy_config_sha256: gateConfig.sha256,
      gate_prospective_calibration_sha256: gateCalibration.sha256,
      required_evidence_series_sha256: evidenceSeries.sha256,
      required_evidence_series_json: evidenceSeries.json,
      required_external_inputs_sha256: externalInputs.sha256,
      required_external_inputs_json: externalInputs.json,
      external_execution_policy_sha256: externalPolicy.sha256,
      external_execution_policy_json: externalPolicy.json,
      safety_pause_mode: "automatic",
      config_sha256: revisionConfig.sha256,
      config_json: revisionConfig.json,
      created_at: "2026-07-14T00:00:00.000Z",
    });
    const bindingBase = authorityRow("lite_learning_collection_principal_bindings", {
      tenant_id: "tenant-resolver",
      collection_principal_sha256: principalSha256,
      collection_class: "eligible_host",
      collector_id: "resolver-host-collector",
      collector_version: "resolver-collector-v1",
      verifier_policy_sha256: verifierPolicy.sha256,
      verifier_policy_json: verifierPolicy.json,
      binding_sha256: "0".repeat(64),
      created_at: "2026-07-14T00:00:00.000Z",
    });
    const binding = {
      ...bindingBase,
      binding_sha256: learningCollectionPrincipalBindingDigest(bindingBase),
    } satisfies LiteLearningAuthorityRow;
    await database.transaction.run(async () => {
      await ledger.insertPolicyVersion({
        tenant_id: "tenant-resolver",
        policy_kind: "candidate",
        policy_id: candidate.policy_id,
        policy_version: candidate.policy_version,
        policy_config_sha256: candidateConfig.sha256,
        policy_config_json: candidateConfig.json,
        implementation_contract_sha256: candidate.implementation_contract_sha256,
        prospective_calibration_sha256: null,
        prospective_calibration_json: null,
        created_at: "2026-07-14T00:00:00.000Z",
      });
      await ledger.insertPolicyVersion({
        tenant_id: "tenant-resolver",
        policy_kind: "gate",
        policy_id: gate.policy_id,
        policy_version: gate.policy_version,
        policy_config_sha256: gateConfig.sha256,
        policy_config_json: gateConfig.json,
        implementation_contract_sha256: gate.implementation_contract_sha256,
        prospective_calibration_sha256: gateCalibration.sha256,
        prospective_calibration_json: gateCalibration.json,
        created_at: "2026-07-14T00:00:00.000Z",
      });
      await ledger.insertCollectionPrincipalBinding(binding);
      await ledger.insertExperimentRevision(revision);
    });

    const resolverRegistry: LearningExperimentResolverRegistry = {
      resolveCandidatePolicy: () => candidate,
      resolveGatePolicy: () => ({
        policy_id: gate.policy_id,
        policy_version: gate.policy_version,
        registry_status: "registered",
        policy_config_sha256: gateConfig.sha256,
        implementation_contract_sha256: gate.implementation_contract_sha256,
        prospective_calibration_artifact_sha256: gateCalibration.sha256,
      }),
      resolveExternalExecutionPolicy: (registryKey, resolvedDatabaseInstanceId) =>
        externalPolicyRegistry.resolve({
          registryKey,
          databaseInstanceId: resolvedDatabaseInstanceId,
        }),
    };
    const envelope = {
      contract_version: "host_task_envelope_v1" as const,
      host_task_id: "resolver-host-task-1",
      collector_id: "resolver-host-collector",
      collector_version: "resolver-collector-v1",
      task_family: "repository_change",
      task_signature: "resolver-task-signature",
      repository_signature: "resolver-repository-signature",
      source_task_sha256: sha256("resolver-source-task"),
      source_event_sha256: sha256("resolver-source-event"),
      created_at: "2026-07-14T00:00:00.000Z",
    };
    const taskSources = [
      {
        source: "context" as const,
        task_family: envelope.task_family,
        task_signature: envelope.task_signature,
        repository_signature: envelope.repository_signature,
      },
      { source: "host_task_envelope_v1" as const, envelope },
    ];
    const apiKeyPrincipal: AuthPrincipal = {
      ...principalIdentity,
      role: "worker",
      default_scope: "resolver-scope",
      allowed_scopes: ["resolver-scope"],
      source: "api_key",
    };
    const baseInput = {
      globalMode: "off" as const,
      matchedRule: rule,
      tenantId: "tenant-resolver",
      publicScope: "resolver-scope",
      storeScope: "tenant:tenant-resolver::scope:resolver-scope",
      taskSources,
      taskIdentityInvalid: false,
      operationProtected: true,
      projectionComplete: true,
      now: "2026-07-14T01:00:00.000Z",
    };
    const first = await resolveLearningExperimentForGuide(
      { ...baseInput, principal: apiKeyPrincipal },
      { ledger, registry: resolverRegistry },
    );
    const jwt = await resolveLearningExperimentForGuide(
      { ...baseInput, principal: { ...apiKeyPrincipal, source: "jwt" } },
      { ledger, registry: resolverRegistry },
    );
    assert.equal(first.enrollment_state, "diagnostic");
    assert.equal(first.mode, "shadow");
    assert.equal(first.collection_class, "eligible_host");
    assert.equal(first.promotion_eligible, false);
    assert.deepEqual(jwt.assignment, first.assignment);
    assert.doesNotMatch(
      stableStringify(first),
      /diagnostic_assignment_seed|confirmatory_assignment_bits|assignment_random_bits/,
    );
    assert.doesNotMatch(
      stableStringify(first),
      /runtime_authority_attestor|runner_principal_sha256|broker_binary_sha256/,
    );

    const unprotected = await resolveLearningExperimentForGuide(
      { ...baseInput, operationProtected: false, principal: apiKeyPrincipal },
      { ledger, registry: resolverRegistry },
    );
    assert.equal(unprotected.serving_arm, "control");
    assert.equal(unprotected.promotion_eligible, false);
    assert.deepEqual(unprotected.reason_codes, ["protected_operation_required"]);

    const wrongCandidateRegistry: LearningExperimentResolverRegistry = {
      ...resolverRegistry,
      resolveCandidatePolicy: () => ({
        ...candidate,
        policy_id: "wrong-candidate-policy",
      }),
    };
    const wrongCandidate = await resolveLearningExperimentForGuide(
      { ...baseInput, principal: apiKeyPrincipal },
      { ledger, registry: wrongCandidateRegistry },
    );
    assert.equal(wrongCandidate.serving_arm, "control");
    assert.deepEqual(wrongCandidate.reason_codes, ["experiment_policy_registry_unresolved"]);

    const canonicalExternalEntry = externalPolicyRegistry.resolve({
      registryKey: "external-execution-v1",
      databaseInstanceId: await ledger.databaseInstanceId(),
    })!;
    const wrongExternalDigestRegistry: LearningExperimentResolverRegistry = {
      ...resolverRegistry,
      resolveExternalExecutionPolicy: () => ({
        ...canonicalExternalEntry,
        policy_sha256: "f".repeat(64),
      }),
    };
    const wrongExternalDigest = await resolveLearningExperimentForGuide(
      { ...baseInput, principal: apiKeyPrincipal },
      { ledger, registry: wrongExternalDigestRegistry },
    );
    assert.equal(wrongExternalDigest.serving_arm, "control");
    assert.deepEqual(wrongExternalDigest.reason_codes, ["experiment_policy_registry_unresolved"]);

    const productionFailControl = await resolveLearningExperimentForGuide(
      { ...baseInput, principal: apiKeyPrincipal },
      { ledger },
    );
    assert.equal(productionFailControl.serving_arm, "control");
    assert.deepEqual(productionFailControl.reason_codes, ["gate_prospective_calibration_unregistered"]);

    const fixedActive = await resolveLearningExperimentForGuide(
      { ...baseInput, globalMode: "active", principal: apiKeyPrincipal },
      { ledger, registry: resolverRegistry },
    );
    assert.equal(fixedActive.mode, "active");
    assert.equal(fixedActive.serving_authority, "fixed_active");
    assert.equal(fixedActive.enrollment_state, "not_enrolled");
    assert.equal(fixedActive.promotion_eligible, false);

    const driftedRule = parseAdmissionCandidatePolicyProfileRules(JSON.stringify([{
      ...rule,
      experiment: { ...rule.experiment, candidate_allocation_bps: 4500 },
    }]))[0]!;
    const drift = await resolveLearningExperimentForGuide(
      { ...baseInput, matchedRule: driftedRule, principal: apiKeyPrincipal },
      { ledger, registry: resolverRegistry },
    );
    assert.equal(drift.serving_arm, "control");
    assert.deepEqual(drift.reason_codes, ["experiment_revision_config_drift"]);

    const otherFamilyEnvelope = { ...envelope, task_family: "other_task_family" };
    const taskFamilyDrift = await resolveLearningExperimentForGuide(
      {
        ...baseInput,
        principal: apiKeyPrincipal,
        taskSources: [
          {
            source: "context" as const,
            task_family: otherFamilyEnvelope.task_family,
            task_signature: otherFamilyEnvelope.task_signature,
            repository_signature: otherFamilyEnvelope.repository_signature,
          },
          { source: "host_task_envelope_v1" as const, envelope: otherFamilyEnvelope },
        ],
      },
      { ledger, registry: resolverRegistry },
    );
    assert.equal(taskFamilyDrift.serving_arm, "control");
    assert.deepEqual(taskFamilyDrift.reason_codes, ["experiment_revision_config_drift"]);

    await writeStore.close();
    await database.close();
    database = createLiteRuntimeDatabase(temp.path);
    writeStore = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
    const reopened = await resolveLearningExperimentForGuide(
      { ...baseInput, principal: apiKeyPrincipal },
      {
        ledger: createLiteLearningEpisodeLedgerAccess(database),
        registry: resolverRegistry,
      },
    );
    assert.deepEqual(reopened.assignment, first.assignment);
    assert.equal(reopened.mode, "shadow");
  } finally {
    await writeStore.close().catch(() => {});
    await database.close().catch(() => {});
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

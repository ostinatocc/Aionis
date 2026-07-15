import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import stableStringify from "fast-json-stable-stringify";
import { stableUuid } from "../../src/util/uuid.ts";

import {
  assertLiteLearningEpisodeLedgerSchemaIntegrity,
  assertLiteLearningEpisodeLedgerIntegrity,
  assertLearningLookProposalAgainstDatabase,
  buildLearningOutcomeRedactedAuthorityProjection,
  createLiteLearningEpisodeLedgerAccess,
  deriveLiteLearningLookAuthorityContext,
  learningActivationScheduleDigest,
  learningCollectionPrincipalBindingDigest,
  learningConfirmatoryAttemptDigest,
  learningExternalRunReservationDigest,
  learningExternalTicketConsumptionDigest,
  learningFeedbackAttributionItemDigest,
  learningFeedbackAttributionSetDigest,
  learningGateArtifactMembershipDigest,
  learningGateArtifactSetDigest,
  learningGateDecisionDigest,
  learningGateLookScheduleDigest,
  learningGateLookReservationDigest,
  learningHostUseReceiptItemSetDigest,
  learningRandomizationPairIdentityDigest,
  learningRandomizationPairManifestDigest,
  learningRandomizationPairRecordDigest,
  learningRequiredArtifactHeadsDigest,
  LITE_LEARNING_LEDGER_REQUIRED_COLUMNS,
  LITE_LEARNING_LEDGER_REQUIRED_INDEX_NAMES,
  LITE_LEARNING_LEDGER_REQUIRED_TABLE_NAMES,
  LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS,
  LITE_LEARNING_LEDGER_REQUIRED_TRIGGER_NAMES,
  type LiteLearningAuthorityRow,
  type LiteLearningGateArtifactSetMember,
} from "../../src/store/lite-learning-episode-ledger.ts";
import {
  LITE_LEARNING_V3_ELIGIBLE_ACTIVE_LEASE_TRIGGER_SQL,
  migrateLiteLearningEpisodeLedgerV3ToV4,
} from
  "../../src/store/lite-learning-schema-migration.ts";
import { normalizeSqliteSchemaSql } from "../../src/store/sqlite-schema-sql.ts";
import {
  learningEpisodeEventDigest,
  learningEpisodeId,
  learningDecisionSurfaceDigest,
  learningItemSetDigest,
  hostTaskEnvelopeDigest,
  hostUseReceiptDigest,
  type EventWithoutDigest,
  type ExposureCommittedV1,
  type HostUseReceiptV1Body,
  type LearningLedgerItem,
} from "../../src/memory/learning-episode-ledger.ts";
import {
  LearningExperimentCloseApprovalV1Schema,
  learningLookProposalDigest,
  learningOutcomeRedactedAuthorityProjectionDigest,
} from "../../src/memory/learning-authority-approval.ts";
import {
  LearningExperimentCloseAuthorizationEnvelopeV1Schema,
  learningExperimentCloseApprovalMac,
} from "../../src/memory/learning-experiment-closing.ts";
import { AionisAgentContextSchema } from "../../src/memory/product-output-contract.ts";
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
import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.ts";
import { createLiteLearningExperimentCloser } from
  "../../src/store/lite-learning-experiment-closing.ts";
import {
  backupLiteRuntimeDatabase,
  restoreLiteRuntimeDatabase,
  verifyLiteRuntimeLearningArtifact,
  verifyLiteRuntimeDatabase,
} from "../../src/store/lite-runtime-data-operations.ts";
import {
  inspectLiteRuntimeSchema,
  LITE_RUNTIME_WRITE_SCHEMA_VERSION,
} from "../../src/store/lite-runtime-schema.ts";
import { createSqliteDatabase, type SqliteDatabase } from "../../src/store/sqlite.ts";
import {
  createLiteWriteStore,
  createLiteWriteStoreFromDatabase,
} from "../../src/store/lite-write-store.ts";

const MIGRATION_CRASH_CHILD = fileURLToPath(
  new URL("./support/lite-learning-v3-migration-crash-child.ts", import.meta.url),
);
const MIGRATION_CHILD = fileURLToPath(
  new URL("./support/lite-learning-v3-migration-child.ts", import.meta.url),
);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_OPS_CLI = path.join(ROOT, "scripts", "runtime-data-ops.ts");
const STORE_CLOSE_KEY_ID = "operator-key-v1";
const STORE_CLOSE_KEY = Buffer.from(
  "store-close-fixture-key-material-32-bytes-minimum",
  "utf8",
);

function storeCloseKeyring() {
  return {
    activeKeyId: STORE_CLOSE_KEY_ID,
    keys: new Map([[STORE_CLOSE_KEY_ID, STORE_CLOSE_KEY]]),
    configured: true,
    ephemeral: false,
    source: "keyring" as const,
  };
}

function runMigrationChild(dbPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", MIGRATION_CHILD, dbPath],
      { cwd: path.resolve(path.dirname(MIGRATION_CHILD), "../../.."), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`migration child failed code=${String(code)} signal=${String(signal)}: ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function tempDatabase(name: string): { directory: string; path: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `aionis-learning-store-${name}-`));
  return { directory, path: path.join(directory, "runtime.sqlite") };
}

function userSchemaNames(db: SqliteDatabase, type: "table" | "index" | "trigger"): string[] {
  return (db.prepare(
    `SELECT name
     FROM sqlite_schema
     WHERE type = ? AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  ).all(type) as Array<{ name: string }>).map((row) => row.name);
}

function tableColumns(db: SqliteDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table.replaceAll("'", "''")}')`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

const normalizeSchemaSql = normalizeSqliteSchemaSql;

function downgradeCurrentFixtureToLegacyV3(
  dbPath: string,
  triggerSql = LITE_LEARNING_V3_ELIGIBLE_ACTIVE_LEASE_TRIGGER_SQL,
): void {
  const db = createSqliteDatabase(dbPath);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DROP TRIGGER trg_lite_learning_eligible_active_lease");
    db.exec(triggerSql);
    const metadataUpdate = db.prepare(
      `UPDATE lite_runtime_schema_metadata
       SET version = 3, updated_at = ?
       WHERE component = 'write_projection'`,
    ).run("2026-07-14T00:00:00.000Z");
    assert.equal(Number(metadataUpdate.changes ?? 0), 1);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function legacyV3ActiveLeaseTriggerWithExteriorFormatting(): string {
  return LITE_LEARNING_V3_ELIGIBLE_ACTIVE_LEASE_TRIGGER_SQL
    .replace("CREATE TRIGGER", "create   trigger")
    .replace("BEFORE INSERT ON", "before\n  insert   on")
    .replace("WHEN NEW.event_kind", "when\n  NEW.event_kind")
    .replace("\nBEGIN\n", "\n  begin\n")
    .replace("\nEND;", "\nend;");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): { json: string; sha256: string } {
  const json = stableStringify(value);
  return { json, sha256: sha256(json) };
}

function mutateAppendOnlyTable(
  db: SqliteDatabase,
  table: keyof typeof LITE_LEARNING_LEDGER_REQUIRED_COLUMNS,
  mutate: () => void,
): void {
  const triggers = Object.entries(LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS)
    .filter(([, requirement]) => requirement.table === table);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [name] of triggers) db.exec(`DROP TRIGGER ${name}`);
    mutate();
    for (const [, requirement] of triggers) db.exec(requirement.sql);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function policyRow(args: {
  kind: "candidate" | "gate";
  id: string;
  version: string;
  implementation?: string;
  calibration?: Record<string, unknown> | null;
}) {
  const calibration = args.calibration == null ? null : canonicalJson(args.calibration);
  const configBody = args.kind === "gate"
    ? {
        contract_version: "test-gate-config-v1",
        prospective_calibration_artifact_sha256: calibration?.sha256 ?? null,
      }
    : { contract_version: "test-candidate-config-v1", behavior: "inspect-first" };
  const config = canonicalJson(configBody);
  return {
    tenant_id: "tenant-a",
    policy_kind: args.kind,
    policy_id: args.id,
    policy_version: args.version,
    policy_config_sha256: config.sha256,
    policy_config_json: config.json,
    implementation_contract_sha256: args.implementation ?? "a".repeat(64),
    prospective_calibration_sha256: calibration?.sha256 ?? null,
    prospective_calibration_json: calibration?.json ?? null,
    created_at: "2026-07-13T00:00:00.000Z",
  } as const;
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

function insertAuthorityRowDirect(
  db: SqliteDatabase,
  table: keyof typeof LITE_LEARNING_LEDGER_REQUIRED_COLUMNS,
  row: LiteLearningAuthorityRow,
): void {
  const columns = LITE_LEARNING_LEDGER_REQUIRED_COLUMNS[table]
    .filter((column) => column !== "row_id");
  db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((column) => row[column]));
}

function externalExecutionPolicy(databaseInstanceId: string) {
  const publicKey = Buffer.alloc(32, 7);
  const publicKeyBase64 = publicKey.toString("base64");
  const publicKeySha256 = createHash("sha256").update(publicKey).digest("hex");
  const launcher = {
    service_launcher_policy_sha256: "1".repeat(64),
    service_launcher_binary_sha256: "2".repeat(64),
    service_launcher_public_key_sha256: publicKeySha256,
    service_launcher_key_id: "launcher-key-v1",
  };
  const role = (credentialSessionClass: string, suffix: string) => ({
    runner_principal_sha256: sha256(`runner:${suffix}`),
    credential_session_class: credentialSessionClass,
    broker_policy_sha256: sha256(`broker-policy:${suffix}`),
    broker_binary_sha256: sha256(`broker-binary:${suffix}`),
    broker_public_key_sha256: sha256(`broker-key:${suffix}`),
    broker_key_id: `broker-key-${suffix}`,
    ...launcher,
    supervisor_executable_sha256: sha256(`supervisor-executable:${suffix}`),
    supervisor_argv_policy_sha256: sha256(`supervisor-argv:${suffix}`),
    supervisor_sandbox_policy_sha256: sha256(`supervisor-sandbox:${suffix}`),
    receipt_signature_algorithm: "ed25519-v1",
    credential_scope_sha256: sha256(`credential-scope:${suffix}`),
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
      service_identity: "runtime-authority-attestor-v1",
      attestor_binary_sha256: "3".repeat(64),
      attestor_policy_sha256: "4".repeat(64),
      attestor_public_key_base64: publicKeyBase64,
      attestor_public_key_sha256: publicKeySha256,
      attestor_key_id: "attestor-key-v1",
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

function confirmatoryFixture(databaseInstanceId: string) {
  const candidatePolicy = resolveAdmissionCandidatePolicy(
    AIONIS_ADMISSION_CANDIDATE_POLICY_ID,
    AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION,
  );
  const candidateConfig = canonicalJson(candidatePolicy.config);
  const candidate = {
    tenant_id: "tenant-a",
    policy_kind: "candidate",
    policy_id: candidatePolicy.policy_id,
    policy_version: candidatePolicy.policy_version,
    policy_config_sha256: candidateConfig.sha256,
    policy_config_json: candidateConfig.json,
    implementation_contract_sha256: candidatePolicy.implementation_contract_sha256,
    prospective_calibration_sha256: null,
    prospective_calibration_json: null,
    created_at: "2026-07-13T00:00:00.000Z",
  } as const;
  const gatePolicy = resolveLearningGatePolicy(
    LEARNING_GATE_POLICY_ID,
    LEARNING_GATE_POLICY_VERSION,
  );
  const gateCalibration = canonicalJson({
    contract_version: "gate-calibration-v1",
    status: "passed",
    scenario_count: 96,
  });
  const gateConfig = canonicalJson({
    ...gatePolicy.config,
    prospective_calibration_artifact_sha256: gateCalibration.sha256,
  });
  const gate = {
    tenant_id: "tenant-a",
    policy_kind: "gate",
    policy_id: gatePolicy.policy_id,
    policy_version: gatePolicy.policy_version,
    policy_config_sha256: gateConfig.sha256,
    policy_config_json: gateConfig.json,
    implementation_contract_sha256: gatePolicy.implementation_contract_sha256,
    prospective_calibration_sha256: gateCalibration.sha256,
    prospective_calibration_json: gateCalibration.json,
    created_at: "2026-07-13T00:00:00.000Z",
  } as const;
  const pairSeeds = Array.from({ length: 384 }, (_, index) => {
    const member0 = sha256(`confirmatory-namespace:${index}:0`);
    const member1 = sha256(`confirmatory-namespace:${index}:1`);
    const matching = canonicalJson({
      contract_version: "test-matching-covariate-v1",
      host_adapter: "adapter-v1",
      model_route: "route-v1",
      region: "test-region",
      workload_stratum: `stratum-${index % 8}`,
    });
    return {
      pairHash: learningRandomizationPairIdentityDigest({
        tenant_id: "tenant-a",
        member_0_memory_namespace_sha256: member0,
        member_1_memory_namespace_sha256: member1,
        matching_covariate_sha256: matching.sha256,
      }),
      member0,
      member1,
      matching,
    };
  }).sort((left, right) => left.pairHash.localeCompare(right.pairHash));
  const namespaces = pairSeeds.flatMap((pair) => [pair.member0, pair.member1]).sort();
  const namespaceSetSha256 = sha256(stableStringify(namespaces));
  const confirmatoryAttemptId = "attempt-confirmatory";
  const diagnosticSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const assignmentBits = Uint8Array.from({ length: 48 }, (_, index) => index);
  const pairs = pairSeeds.map((seed, ordinal) => {
    const wave = ordinal < 96 ? 1 : ordinal < 192 ? 2 : 3;
    const times = wave === 1
      ? ["2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z", "2026-08-03T00:00:00.000Z"]
      : wave === 2
        ? ["2026-08-04T00:00:00.000Z", "2026-08-05T00:00:00.000Z", "2026-08-06T00:00:00.000Z"]
        : ["2026-08-07T00:00:00.000Z", "2026-08-08T00:00:00.000Z", "2026-08-09T00:00:00.000Z"];
    const pairBase = authorityRow("lite_learning_randomization_pairs", {
      tenant_id: "tenant-a",
      confirmatory_attempt_id: confirmatoryAttemptId,
      randomization_pair_sha256: seed.pairHash,
      pair_ordinal: ordinal,
      member_0_memory_namespace_sha256: seed.member0,
      member_1_memory_namespace_sha256: seed.member1,
      matching_covariate_sha256: seed.matching.sha256,
      matching_covariate_json: seed.matching.json,
      activation_wave_index: wave,
      activation_starts_at: times[0]!,
      index_window_ends_at: times[1]!,
      wave_analysis_at: times[2]!,
      pair_record_sha256: "0".repeat(64),
      created_at: "2026-07-13T00:00:00.000Z",
    });
    return {
      ...pairBase,
      pair_record_sha256: learningRandomizationPairRecordDigest(pairBase),
    } satisfies LiteLearningAuthorityRow;
  });
  const pairManifestSha256 = learningRandomizationPairManifestDigest(pairs);
  const activationScheduleSha256 = learningActivationScheduleDigest(pairs);
  const sourcePolicy = canonicalJson({
    contract_version: "test-collection-source-policy-v1",
    principals: [],
  });
  const evidenceSeries = canonicalJson({
    offline_paired: "offline",
    production_shadow: "host",
    runtime_integrity: "runtime-integrity",
    tool_e2e: "tool",
  });
  const requiredExternalInputs = canonicalJson({
    offline_paired: {
      immutable_input_manifest_sha256: sha256("offline-input"),
      retry_policy_sha256: sha256("offline-retry"),
      planned_run_id: "offline-run-v1",
    },
    production_shadow: {
      immutable_input_manifest_sha256: sha256("shadow-input"),
      retry_policy_sha256: sha256("shadow-retry"),
      planned_run_id: "shadow-run-v1",
    },
    tool_e2e: {
      immutable_input_manifest_sha256: sha256("tool-input"),
      retry_policy_sha256: sha256("tool-retry"),
      planned_run_id: "tool-run-v1",
    },
  });
  const externalPolicy = canonicalJson(externalExecutionPolicy(databaseInstanceId));
  const config = canonicalJson({
    contract_version: "test-confirmatory-config-v1",
    task_family: "runtime-learning",
    provision_operation_id_sha256: sha256("operation-provision-confirmatory"),
    provisioning_actor_sha256: sha256("test-provisioner"),
    collection_source_policy_sha256: sourcePolicy.sha256,
    external_execution_policy_sha256: externalPolicy.sha256,
    gate_prospective_calibration_sha256: gate.prospective_calibration_sha256,
    namespace_set_sha256: namespaceSetSha256,
    pair_manifest_sha256: pairManifestSha256,
    required_evidence_series_sha256: evidenceSeries.sha256,
    required_external_inputs_sha256: requiredExternalInputs.sha256,
    activation_schedule_sha256: activationScheduleSha256,
  });
  const revision = authorityRow("lite_learning_experiment_revisions", {
    tenant_id: "tenant-a",
    experiment_id: "experiment-confirmatory",
    experiment_revision: 1,
    profile_id: "profile-confirmatory",
    profile_rule_sha256: "c".repeat(64),
    serving_phase: "active_control",
    evidence_intent: "confirmatory",
    eligible_memory_namespace_set_sha256: namespaceSetSha256,
    eligible_memory_namespace_count: 768,
    assignment_design: "matched_pair_complete_randomization_v1",
    randomization_pair_manifest_sha256: pairManifestSha256,
    randomization_pair_count: 384,
    activation_schedule_sha256: activationScheduleSha256,
    candidate_policy_id: candidate.policy_id,
    candidate_policy_version: candidate.policy_version,
    candidate_policy_implementation_sha256: candidate.implementation_contract_sha256,
    candidate_policy_config_sha256: candidate.policy_config_sha256,
    assignment_unit_kind: "store_memory_namespace_cluster",
    candidate_allocation_bps: 5000,
    diagnostic_assignment_seed: diagnosticSeed,
    diagnostic_assignment_seed_sha256: createHash("sha256").update(diagnosticSeed).digest("hex"),
    confirmatory_assignment_bits: assignmentBits,
    confirmatory_assignment_bit_count: 384,
    confirmatory_assignment_bits_sha256: createHash("sha256").update(assignmentBits).digest("hex"),
    collection_source_policy_sha256: sourcePolicy.sha256,
    collection_source_policy_json: sourcePolicy.json,
    gate_policy_id: gate.policy_id,
    gate_policy_version: gate.policy_version,
    gate_policy_config_sha256: gate.policy_config_sha256,
    gate_prospective_calibration_sha256: gate.prospective_calibration_sha256,
    required_evidence_series_sha256: evidenceSeries.sha256,
    required_evidence_series_json: evidenceSeries.json,
    required_external_inputs_sha256: requiredExternalInputs.sha256,
    required_external_inputs_json: requiredExternalInputs.json,
    external_execution_policy_sha256: externalPolicy.sha256,
    external_execution_policy_json: externalPolicy.json,
    safety_pause_mode: "automatic",
    config_sha256: config.sha256,
    config_json: config.json,
    created_at: "2026-07-13T00:00:00.000Z",
  });
  const attemptBase = authorityRow("lite_learning_confirmatory_attempts", {
    tenant_id: "tenant-a",
    confirmatory_attempt_id: confirmatoryAttemptId,
    task_family: "runtime-learning",
    candidate_policy_id: candidate.policy_id,
    candidate_policy_version: candidate.policy_version,
    candidate_policy_implementation_sha256: candidate.implementation_contract_sha256,
    experiment_id: revision.experiment_id,
    experiment_revision: revision.experiment_revision,
    gate_policy_id: gate.policy_id,
    gate_policy_version: gate.policy_version,
    gate_policy_config_sha256: gate.policy_config_sha256,
    eligible_memory_namespace_set_sha256: namespaceSetSha256,
    eligible_memory_namespace_count: 768,
    planned_candidate_namespace_count: 384,
    planned_control_namespace_count: 384,
    randomization_pair_manifest_sha256: pairManifestSha256,
    randomization_pair_count: 384,
    activation_schedule_sha256: activationScheduleSha256,
    attempt_sha256: "0".repeat(64),
    created_by: "test-provisioner",
    created_at: "2026-07-13T00:00:00.000Z",
  });
  const attempt = {
    ...attemptBase,
    attempt_sha256: learningConfirmatoryAttemptDigest(attemptBase),
  } satisfies LiteLearningAuthorityRow;
  const leases = pairs.flatMap((pair) => [0, 1].map((member) => {
    const ordinal = Number(pair.pair_ordinal);
    const byte = assignmentBits[Math.floor(ordinal / 8)] ?? 0;
    const candidateMember = (byte >> (7 - (ordinal % 8))) & 1;
    const namespace = String(pair[member === 0
      ? "member_0_memory_namespace_sha256"
      : "member_1_memory_namespace_sha256"]);
    return authorityRow("lite_learning_namespace_leases", {
      tenant_id: "tenant-a",
      namespace_lease_id: `lease-${String(ordinal).padStart(3, "0")}-${member}`,
      memory_namespace_sha256: namespace,
      randomization_pair_sha256: pair.randomization_pair_sha256,
      pair_member_ordinal: member,
      assigned_arm: member === candidateMember ? "candidate" : "control",
      activation_wave_index: pair.activation_wave_index,
      activation_starts_at: pair.activation_starts_at,
      index_window_ends_at: pair.index_window_ends_at,
      wave_analysis_at: pair.wave_analysis_at,
      lease_generation: 1,
      confirmatory_attempt_id: attempt.confirmatory_attempt_id,
      experiment_id: revision.experiment_id,
      experiment_revision: revision.experiment_revision,
      namespace_set_sha256: namespaceSetSha256,
      acquire_operation_id: "operation-provision-confirmatory",
      acquired_at: "2026-07-13T00:00:00.000Z",
      status: "active",
      release_operation_id: null,
      release_ref_kind: null,
      release_ref_id: null,
      released_at: null,
    });
  }));
  return {
    candidate,
    gate,
    revision,
    attempt,
    pairs,
    leases,
    namespaceSetSha256,
    databaseInstanceId,
  };
}

function experimentClosureFixture(args: {
  fixture: ReturnType<typeof confirmatoryFixture>;
  operationId: string;
  nonce: string;
  createdAt: string;
}) {
  const key = STORE_CLOSE_KEY;
  const authorizationNonce = createHash("sha256")
    .update(args.nonce)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
  const authorizationExpiresAt = new Date(
    new Date(args.createdAt).getTime() + 30 * 60 * 1000,
  ).toISOString();
  const approval = LearningExperimentCloseApprovalV1Schema.parse({
    contract_version: "learning_experiment_close_approval_v1",
    authorization_kind: "experiment_close",
    action: "close_experiment",
    runtime_authority_lineage_sha256: sha256(args.fixture.databaseInstanceId),
    tenant_id: "tenant-a",
    task_family: args.fixture.attempt.task_family,
    confirmatory_attempt_id: args.fixture.attempt.confirmatory_attempt_id,
    confirmatory_attempt_sha256: args.fixture.attempt.attempt_sha256,
    experiment_id: args.fixture.revision.experiment_id,
    experiment_revision: args.fixture.revision.experiment_revision,
    experiment_config_sha256: args.fixture.revision.config_sha256,
    namespace_set_sha256: args.fixture.namespaceSetSha256,
    close_reason: "evidence_complete",
    candidate_policy_implementation_sha256:
      args.fixture.candidate.implementation_contract_sha256,
    gate_policy_implementation_sha256: args.fixture.gate.implementation_contract_sha256,
    authority_scope: "learning-experiment-authority-v1",
    authority_operation_kind: "learning_experiment_close_v1",
    authority_operation_id: args.operationId,
    approved_by: "test-operator",
    authorization_key_id: STORE_CLOSE_KEY_ID,
    authorization_nonce: authorizationNonce,
    authorization_issued_at: args.createdAt,
    authorization_expires_at: authorizationExpiresAt,
  });
  const authorization = LearningExperimentCloseAuthorizationEnvelopeV1Schema.parse({
    contract_version: "learning_experiment_close_authorization_envelope_v1",
    approval,
    authorization_mac: learningExperimentCloseApprovalMac(approval, key),
  });
  return { approval, authorization, key };
}

function emptyEventRow(): Record<string, string | number | Uint8Array | null> {
  const columns = LITE_LEARNING_LEDGER_REQUIRED_COLUMNS.lite_learning_episode_events
    .filter((column) => column !== "row_id");
  return Object.fromEntries(columns.map((column) => [column, null]));
}

function episodeEventRow(
  event: EventWithoutDigest,
  payload: unknown,
  overrides: Record<string, string | number | Uint8Array | null> = {},
): LiteLearningAuthorityRow {
  const encoded = canonicalJson(payload);
  return authorityRow("lite_learning_episode_events", {
    tenant_id: event.tenant_id,
    scope: event.scope,
    event_id: event.event_id,
    episode_id: event.episode_id,
    episode_sequence: event.episode_sequence,
    event_kind: event.event_kind,
    source_kind: event.source_kind,
    source_id: event.source_id,
    source_sha256: event.source_sha256,
    previous_event_sha256: event.previous_event_sha256,
    event_sha256: learningEpisodeEventDigest(event),
    payload_sha256: encoded.sha256,
    payload_json: encoded.json,
    item_set_sha256: event.item_set_sha256,
    source_commit_id: event.source_commit_id,
    supersedes_event_id: event.supersedes_event_id,
    operation_id: event.operation_id,
    run_id: event.run_id,
    collection_class: event.collection_class,
    enrollment_state: "not_enrolled",
    serving_phase: "off",
    evidence_intent: null,
    assignment_mode: "unassigned",
    assignment_arm: "not_enrolled",
    served_arm: "control",
    policy_affected: 0,
    predecision_track: "unclassified",
    projection_complete: 0,
    promotion_eligible: 0,
    recorded_at: event.recorded_at,
    ...overrides,
  });
}

function legacyExposureFixture() {
  const digest = "d".repeat(64);
  const episodeId = learningEpisodeId({
    tenantId: "tenant-a",
    scope: "scope-a",
    guideTraceId: "guide-a",
  });
  const item: LearningLedgerItem = {
    decision_completeness: "legacy_served_only",
    memory_id: "memory-a",
    memory_type: null,
    source_backend: null,
    recorded_action: null,
    candidate_action: null,
    served_action: "inspect_before_use",
    policy_changed: null,
    hard_boundary_preserved: null,
    prior_supported_use_count: null,
    prior_contradicted_use_count: null,
    prior_rehydrate_requested_count: null,
    prior_effect_state: null,
    repeated_negative_posture: null,
    learning_track: "unclassified",
    track_reason: "legacy_unclassified",
  };
  const payload: ExposureCommittedV1 = {
    contract_version: "aionis_learning_exposure_v1",
    guide_trace_id: "guide-a",
    guide_receipt_sha256: digest,
    guide_commit_id: "commit-a",
    request_sha256: "c".repeat(64),
    operation_protection: "legacy_unprotected",
    collection_class: "unverified",
    collection_principal_sha256: null,
    collection_source_policy_sha256: null,
    collector_id: null,
    collector_version: null,
    host_task_id: null,
    host_task_envelope: null,
    host_task_envelope_sha256: null,
    profile_rule_sha256: null,
    experiment_config_sha256: null,
    evidence_intent: null,
    memory_namespace_sha256: null,
    namespace_set_sha256: null,
    namespace_lease_id: null,
    namespace_lease_generation: null,
    assignment_reason_codes: ["legacy_unprotected"],
    assignment_algorithm: "none",
    assignment_namespace_sha256: null,
    candidate_allocation_bps: null,
    assignment_bucket: null,
    randomization_pair_sha256: null,
    matching_covariate_sha256: null,
    pair_member_ordinal: null,
    activation_wave_index: null,
    activation_starts_at: null,
    index_window_ends_at: null,
    wave_analysis_at: null,
    assignment_arm: "not_enrolled",
    served_arm: "control",
    relevant_memory_ids: ["memory-a"],
    recorded_surface_sha256: "1".repeat(64),
    candidate_surface_sha256: "1".repeat(64),
    served_surface_sha256: "1".repeat(64),
    projection_complete: false,
    projection_incomplete_reason_codes: ["legacy_served_only"],
    hard_boundary_upgrade_count: 0,
  };
  const payloadEncoding = canonicalJson(payload);
  const event: EventWithoutDigest = {
    contract_version: "aionis_learning_episode_event_v1",
    tenant_id: "tenant-a",
    scope: "scope-a",
    event_id: "event-exposure-a",
    episode_id: episodeId,
    episode_sequence: 1,
    event_kind: "exposure_committed",
    source_kind: "guide_receipt",
    source_id: "guide-a",
    source_sha256: digest,
    previous_event_sha256: null,
    payload_sha256: payloadEncoding.sha256,
    item_set_sha256: learningItemSetDigest([item]),
    source_commit_id: "commit-a",
    supersedes_event_id: null,
    operation_id: null,
    run_id: null,
    collection_class: "unverified",
    recorded_at: "2026-07-13T00:00:00.000Z",
  };
  const row = Object.assign(emptyEventRow(), {
    tenant_id: event.tenant_id,
    scope: event.scope,
    event_id: event.event_id,
    episode_id: event.episode_id,
    episode_sequence: event.episode_sequence,
    event_kind: event.event_kind,
    source_kind: event.source_kind,
    source_id: event.source_id,
    source_sha256: event.source_sha256,
    previous_event_sha256: event.previous_event_sha256,
    event_sha256: learningEpisodeEventDigest(event),
    payload_sha256: event.payload_sha256,
    payload_json: payloadEncoding.json,
    item_set_sha256: event.item_set_sha256,
    source_commit_id: event.source_commit_id,
    supersedes_event_id: null,
    operation_id: null,
    run_id: null,
    collection_class: "unverified",
    enrollment_state: "not_enrolled",
    serving_phase: "off",
    evidence_intent: null,
    assignment_mode: "unassigned",
    assignment_arm: "not_enrolled",
    served_arm: "control",
    policy_affected: 0,
    predecision_track: "unclassified",
    projection_complete: 0,
    promotion_eligible: 0,
    recorded_at: event.recorded_at,
  });
  return { episodeId, event, item, payload, row };
}

function legacyExposureProbe(args: {
  suffix: string;
  memoryNamespaceSha256?: string | null;
  sourceCommitId?: string;
  memoryId?: string;
  collectionClass?: ExposureCommittedV1["collection_class"];
  evidenceIntent?: ExposureCommittedV1["evidence_intent"];
  operationProtection?: ExposureCommittedV1["operation_protection"];
  rowOverrides?: Record<string, string | number | Uint8Array | null>;
}) {
  const base = legacyExposureFixture();
  const guideTraceId = `guide-probe-${args.suffix}`;
  const sourceCommitId = args.sourceCommitId ?? `commit-probe-${args.suffix}`;
  const memoryId = args.memoryId ?? `memory-probe-${args.suffix}`;
  const memoryNamespaceSha256 = args.memoryNamespaceSha256 ?? null;
  const collectionClass = args.collectionClass ?? "unverified";
  const payload: ExposureCommittedV1 = {
    ...base.payload,
    guide_trace_id: guideTraceId,
    guide_receipt_sha256: sha256(`guide-receipt-probe:${args.suffix}`),
    guide_commit_id: sourceCommitId,
    request_sha256: sha256(`request-probe:${args.suffix}`),
    operation_protection: args.operationProtection ?? "legacy_unprotected",
    collection_class: collectionClass,
    evidence_intent: args.evidenceIntent ?? null,
    memory_namespace_sha256: memoryNamespaceSha256,
    relevant_memory_ids: [memoryId],
  };
  const item: LearningLedgerItem = {
    ...base.item,
    memory_id: memoryId,
  };
  const encoded = canonicalJson(payload);
  const event: EventWithoutDigest = {
    ...base.event,
    scope: `scope-probe-${args.suffix}`,
    event_id: `event-probe-${args.suffix}`,
    episode_id: learningEpisodeId({
      tenantId: "tenant-a",
      scope: `scope-probe-${args.suffix}`,
      guideTraceId,
    }),
    source_id: guideTraceId,
    source_sha256: payload.guide_receipt_sha256,
    payload_sha256: encoded.sha256,
    item_set_sha256: learningItemSetDigest([item]),
    source_commit_id: sourceCommitId,
    operation_id: payload.operation_protection === "protected"
      ? `operation-probe-${args.suffix}`
      : null,
    collection_class: collectionClass,
  };
  const row = episodeEventRow(event, payload, {
    memory_namespace_sha256: memoryNamespaceSha256,
    assignment_unit_sha256: memoryNamespaceSha256 === null
      ? null
      : sha256(stableStringify({
        tenant_id: "tenant-a",
        memory_namespace_sha256: memoryNamespaceSha256,
      })),
    evidence_intent: payload.evidence_intent,
    ...args.rowOverrides,
  });
  return { event, item, payload, row };
}

function confirmatoryPreTreatmentMembers(prefix: string) {
  return Array.from({ length: 768 }, (_, index) => {
    const storeScopeKey = `tenant:tenant-a::scope:${prefix}-${String(index).padStart(3, "0")}`;
    const memoryNamespaceSha256 = sha256(storeScopeKey);
    return {
      storeScopeKey,
      memoryNamespaceSha256,
      assignmentUnitSha256: sha256(stableStringify({
        tenant_id: "tenant-a",
        memory_namespace_sha256: memoryNamespaceSha256,
      })),
    };
  });
}

function seedPriorCommit(
  db: SqliteDatabase,
  args: { id: string; scope: string; createdAt?: string },
): void {
  db.prepare(
    `INSERT INTO lite_memory_commits
      (id, scope, parent_commit_id, input_sha256, diff_json, actor,
       model_version, prompt_version, commit_hash, created_at)
     VALUES (?, ?, NULL, ?, '{}', 'pre-treatment-test', NULL, NULL, ?, ?)`,
  ).run(
    args.id,
    args.scope,
    sha256(`input:${args.id}`),
    sha256(`commit:${args.id}`),
    args.createdAt ?? "2026-07-12T00:00:00.000Z",
  );
}

function seedPriorNode(
  db: SqliteDatabase,
  args: { id: string; scope: string; commitId: string; slots?: unknown; createdAt?: string },
): void {
  db.prepare(
    `INSERT INTO lite_memory_nodes
      (id, scope, client_id, type, tier, title, text_summary, slots_json,
       raw_ref, evidence_ref, embedding_vector_json, embedding_model,
       memory_lane, producer_agent_id, owner_agent_id, owner_team_id,
       embedding_status, embedding_last_error, salience, importance, confidence,
       redaction_version, commit_id, created_at)
     VALUES (?, ?, NULL, 'experience', 'hot', 'Prior node', 'Prior production state', ?,
             NULL, NULL, NULL, NULL, 'shared', 'pre-treatment-test',
             'pre-treatment-test', NULL, 'pending', NULL, 0.5, 0.5, 0.5,
             1, ?, ?)`,
  ).run(
    args.id,
    args.scope,
    stableStringify(args.slots ?? { source: "ordinary_production_prior" }),
    args.commitId,
    args.createdAt ?? "2026-07-12T00:00:00.000Z",
  );
}

function promotionEligibleGuideRootMaterial(args: {
  tenantId: string;
  scope: string;
  guideTraceId: string;
  runId: string | null;
  item: Extract<LearningLedgerItem, { decision_completeness: "complete" }>;
  memoryIds?: string[];
}) {
  const recordedMemoryIds = [args.item.memory_id];
  const exposedMemoryIds = args.memoryIds ?? [];
  const servedUseNowIds = args.item.served_action === "use_now" ? recordedMemoryIds : [];
  const servedInspectIds = args.item.served_action === "inspect_before_use" ? recordedMemoryIds : [];
  const servedDoNotUseIds = args.item.served_action === "do_not_use" ? recordedMemoryIds : [];
  const servedRehydrateIds = args.item.served_action === "rehydrate" ? recordedMemoryIds : [];
  const promptText = `Formal guide context for ${args.item.memory_id}`;
  const querySha256 = sha256(`query:${args.guideTraceId}`);
  const contextSha256 = sha256(`context:${args.guideTraceId}`);
  const agentContext = AionisAgentContextSchema.parse({
    contract_version: "aionis_agent_context_v1",
    tenant_id: args.tenantId,
    scope: args.scope,
    prompt_text: promptText,
    summary: `Formal guide context for ${args.item.memory_id}`,
    history_used: true,
    actionable_history_used: true,
    recommended_posture: args.item.served_action === "use_now"
      ? "reuse_supported_history"
      : args.item.served_action === "inspect_before_use"
        ? "inspect_before_use"
        : args.item.served_action === "rehydrate"
          ? "rehydrate_before_use"
          : "ignore_history",
    authority: "advisory",
    memory_ids: exposedMemoryIds,
    use_now_memory_ids: servedUseNowIds,
    inspect_before_use_memory_ids: servedInspectIds,
    do_not_use_memory_ids: servedDoNotUseIds,
    rehydrate_hints: servedRehydrateIds.map((memoryId) => ({
      memory_id: memoryId,
      reason: "Formal fixture requires archived evidence before use.",
      required: true,
    })),
    risk: {
      negative_transfer_risk: "low",
      blocked_authority_count: servedDoNotUseIds.length,
      stale_memory_count: 0,
      reasons: [],
    },
    evidence_refs: {
      memory_ids: exposedMemoryIds,
      workflow_ids: [],
      evidence_count: recordedMemoryIds.length,
    },
  });
  const ledger = {
    contract_version: "aionis_guide_exposure_v1",
    guide_trace_id: args.guideTraceId,
    tenant_id: args.tenantId,
    scope: args.scope,
    run_id: args.runId,
    consumer_agent_id: "formal-guide-agent",
    consumer_team_id: null,
    query_sha256: querySha256,
    context_sha256: contextSha256,
    task_binding_sha256: sha256(`task-binding:${args.guideTraceId}`),
    memory_ids: agentContext.memory_ids,
    use_now_memory_ids: servedUseNowIds,
    inspect_before_use_memory_ids: servedInspectIds,
    do_not_use_memory_ids: servedDoNotUseIds,
    rehydrate_memory_ids: servedRehydrateIds,
    prompt_char_count: promptText.length,
    history_used: true,
    actionable_history_used: true,
    recommended_posture: agentContext.recommended_posture,
    authority: agentContext.authority,
    tool_selection: null,
    runtime_verification_v1: null,
    effect_observation_v1: null,
    effect_observation_sha256: null,
  } as const;
  const ledgerJson = stableStringify(ledger);
  return {
    contextSha256,
    ledger,
    ledgerJson,
    ledgerSha256: sha256(ledgerJson),
    promptText,
    querySha256,
    agentContext,
  } as const;
}

function insertPromotionEligibleGuideRoots(
  db: SqliteDatabase,
  args: {
    event: EventWithoutDigest;
    payload: ExposureCommittedV1;
    row: LiteLearningAuthorityRow;
    item: Extract<LearningLedgerItem, { decision_completeness: "complete" }>;
    rootItem?: Extract<LearningLedgerItem, { decision_completeness: "complete" }>;
    rootMemoryIds?: string[];
    commitScope: string;
    operationRequestSha256?: string;
  },
): void {
  const material = promotionEligibleGuideRootMaterial({
    tenantId: args.event.tenant_id,
    scope: args.event.scope,
    guideTraceId: args.payload.guide_trace_id,
    runId: args.event.run_id,
    item: args.rootItem ?? args.item,
    memoryIds: args.rootMemoryIds,
  });
  const { agentContext, contextSha256, ledger, ledgerJson, querySha256 } = material;
  assert.equal(material.ledgerSha256, args.payload.guide_receipt_sha256);
  db.prepare(
    `INSERT INTO lite_memory_commits
      (id, scope, parent_commit_id, input_sha256, diff_json, actor,
       model_version, prompt_version, commit_hash, created_at)
     VALUES (?, ?, NULL, ?, ?, 'aionis-runtime', NULL, NULL, ?, ?)`,
  ).run(
    args.payload.guide_commit_id,
    args.commitScope,
    args.payload.guide_receipt_sha256,
    stableStringify({ guide_trace_id: args.payload.guide_trace_id }),
    sha256(`commit:${args.payload.guide_commit_id}`),
    args.event.recorded_at,
  );
  db.prepare(
    `INSERT INTO lite_memory_nodes
      (id, scope, client_id, type, tier, title, text_summary, slots_json,
       raw_ref, evidence_ref, embedding_vector_json, embedding_model,
       memory_lane, producer_agent_id, owner_agent_id, owner_team_id,
       embedding_status, embedding_last_error, salience, importance, confidence,
       redaction_version, commit_id, created_at)
     VALUES (?, ?, ?, 'evidence', 'archive', 'Guide exposure ledger', ?, ?,
             NULL, NULL, NULL, NULL, 'shared', 'aionis-runtime',
             'formal-guide-agent', NULL, 'pending', NULL, 0, 0, 1,
             1, ?, ?)`,
  ).run(
    `node-${args.payload.guide_trace_id}`,
    args.commitScope,
    args.payload.guide_trace_id,
    `Guide exposure ledger ${args.payload.guide_trace_id}`,
    JSON.stringify({ guide_exposure_v1: ledger, not_agent_facing: true }),
    args.payload.guide_commit_id,
    args.event.recorded_at,
  );
  db.prepare(
    `INSERT INTO lite_product_guide_receipts
      (tenant_id, scope, guide_trace_id, run_id, consumer_agent_id, consumer_team_id,
       query_sha256, context_sha256, ledger_sha256, ledger_json, commit_id, created_at)
     VALUES (?, ?, ?, ?, 'formal-guide-agent', NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.event.tenant_id,
    args.event.scope,
    args.payload.guide_trace_id,
    args.event.run_id,
    querySha256,
    contextSha256,
    args.payload.guide_receipt_sha256,
    ledgerJson,
    args.payload.guide_commit_id,
    args.event.recorded_at,
  );
  const operationReceipt = stableStringify({
    ok: true,
    statusCode: 200,
    body: {
      contract_version: "aionis_guide_result_v1",
      operation_id: args.event.operation_id,
      tenant_id: args.event.tenant_id,
      scope: args.event.scope,
      guide_trace_id: args.payload.guide_trace_id,
      agent_context: agentContext,
      source_map: {
        admission_candidate_policy: {
          mode: args.payload.served_arm === "candidate" ? "active" : "shadow",
          source: "profile_rule",
          profile_id: args.row.profile_id,
          serving_authority: "experiment",
          serving_arm: args.payload.served_arm,
          enrollment_state: "enrolled",
          promotion_eligible: true,
          collection_class: "eligible_host",
          experiment_id: args.row.experiment_id,
          experiment_revision: args.row.experiment_revision,
          experiment_config_sha256: args.payload.experiment_config_sha256,
          reason_codes: args.payload.assignment_reason_codes,
        },
      },
    },
  });
  db.prepare(
    `INSERT INTO lite_runtime_write_operations
      (tenant_id, scope, operation_kind, operation_id, request_sha256,
       receipt_json, commit_id, created_at)
     VALUES (?, ?, 'product_guide_v1', ?, ?, ?, ?, ?)`,
  ).run(
    args.event.tenant_id,
    args.event.scope,
    args.event.operation_id,
    args.operationRequestSha256 ?? args.payload.request_sha256,
    operationReceipt,
    args.payload.guide_commit_id,
    args.event.recorded_at,
  );
}

async function createV2Fixture(dbPath: string): Promise<void> {
  const initialized = createLiteWriteStore(dbPath, { annProjectionEnabled: false });
  await initialized.close();

  const db = createSqliteDatabase(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const table of [...LITE_LEARNING_LEDGER_REQUIRED_TABLE_NAMES].reverse()) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    for (const column of ["record_sha256", "after_episode_id", "baseline_episode_id"]) {
      db.exec(`ALTER TABLE lite_product_measurements DROP COLUMN ${column}`);
    }
    db.prepare(
      `UPDATE lite_runtime_schema_metadata
       SET version = 2, updated_at = ?
       WHERE component = 'write_projection'`,
    ).run("2026-07-13T00:00:00.000Z");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function seedV2PreservationRows(db: SqliteDatabase): void {
  const at = "2026-07-13T00:00:00.000Z";
  db.prepare(
    `INSERT INTO lite_memory_commits
      (id, scope, parent_commit_id, input_sha256, diff_json, actor,
       model_version, prompt_version, commit_hash, created_at)
     VALUES ('commit-preserved', 'scope-a', NULL, 'input-preserved', '{}',
             'migration-test', NULL, NULL, 'commit-hash-preserved', ?)`,
  ).run(at);
  db.prepare(
    `INSERT INTO lite_memory_nodes
      (id, scope, client_id, type, tier, title, text_summary, slots_json,
       raw_ref, evidence_ref, embedding_vector_json, embedding_model,
       memory_lane, producer_agent_id, owner_agent_id, owner_team_id,
       embedding_status, embedding_last_error, salience, importance, confidence,
       redaction_version, commit_id, created_at)
     VALUES ('node-preserved', 'scope-a', NULL, 'concept', 'hot', 'Preserved',
             'Preserved node', '{}', NULL, NULL, NULL, NULL, 'shared',
             'migration-test', 'migration-test', NULL, 'pending', NULL,
             0.5, 0.5, 0.5, 1, 'commit-preserved', ?)`,
  ).run(at);
  db.prepare(
    `INSERT INTO lite_memory_edges
      (id, scope, type, src_id, dst_id, weight, confidence, decay_rate,
       metadata_json, commit_id, created_at)
     VALUES ('edge-preserved', 'scope-a', 'related_to', 'node-preserved',
             'node-preserved-2', 0.5, 0.5, 0.1, '{}', 'commit-preserved', ?)`,
  ).run(at);
  db.prepare(
    `INSERT INTO lite_product_guide_receipts
      (tenant_id, scope, guide_trace_id, run_id, consumer_agent_id,
       consumer_team_id, query_sha256, context_sha256, ledger_sha256,
       ledger_json, commit_id, created_at)
     VALUES ('tenant-a', 'scope-a', 'guide-preserved', 'run-preserved',
             'agent-preserved', NULL, ?, ?, ?, '{}', 'commit-preserved', ?)`,
  ).run("1".repeat(64), "2".repeat(64), "3".repeat(64), at);
  db.prepare(
    `INSERT INTO lite_runtime_write_operations
      (tenant_id, scope, operation_kind, operation_id, request_sha256,
       receipt_json, commit_id, created_at)
     VALUES ('tenant-a', 'scope-a', 'test-preservation', 'operation-preserved',
             ?, '{}', 'commit-preserved', ?)`,
  ).run("4".repeat(64), at);
  db.prepare(
    `INSERT INTO lite_memory_rule_feedback
      (id, scope, rule_node_id, run_id, outcome, note, source,
       decision_id, commit_id, created_at)
     VALUES ('feedback-preserved', 'scope-a', 'rule-preserved', 'run-preserved',
             'neutral', NULL, 'rule_feedback', NULL, 'commit-preserved', ?)`,
  ).run(at);
  db.prepare(
    `INSERT INTO lite_product_measurements
      (measurement_id, tenant_id, scope, source, measurement_digest,
       effect_report_json, eligible_for_skill_export, evidence_status,
       runtime_evidence_ids_json, eligibility_reasons_json, created_by, created_at)
     VALUES ('measurement-preserved', 'tenant-a', 'scope-a', 'product_trace', ?,
             '{}', 0, 'insufficient', '[]', '[]', 'migration-test', ?)`,
  ).run("5".repeat(64), at);
  db.prepare(
    `INSERT INTO lite_skill_candidate_reviews
      (candidate_id, tenant_id, scope, review_status, skill_name, label,
       export_ready, promotion_status, reason, source_ids_json,
       source_trace_ids_json, source_signal_ids_json, applies_when_json,
       does_not_apply_when_json, procedure_steps_json, target_files_json,
       acceptance_checks_json, failure_counterexamples_json, evidence_refs_json,
       candidate_json, measurement_id, measurement_digest, candidate_digest,
       eligible_for_promotion, row_version, reviewer_id, review_reason,
       created_at, updated_at, reviewed_at)
     VALUES ('candidate-preserved', 'tenant-a', 'scope-a', 'pending_review',
             'Preserved candidate', 'positive', 0, 'needs_more_evidence',
             'preserve row', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]',
             '[]', '[]', '{}', 'measurement-preserved', ?, ?, 0, 1, NULL, NULL,
             ?, ?, NULL)`,
  ).run("5".repeat(64), "6".repeat(64), at, at);
}

test("gate artifact-set digest is the narrow role/ordinal/series/artifact/report projection", () => {
  const member = {
    artifact_role: "runtime_integrity",
    role_ordinal: 0,
    evidence_series_id: "series-runtime-v1",
    artifact_id: "artifact-runtime-look-1",
    report_sha256: "a".repeat(64),
  } as const;
  assert.equal(
    learningGateArtifactSetDigest([member]),
    "5a8f57efb58e32628e0ae2f42475dae4aa45c8de70b500c36e062c850e003a54",
  );
  assert.notEqual(
    learningGateArtifactSetDigest([member]),
    learningGateArtifactSetDigest([{ ...member, evidence_series_id: "series-runtime-v2" }]),
  );
});

test("randomization pair identity is server-derived from tenant, unordered members, and matching covariates", () => {
  const member0 = sha256("pair-identity-member-0");
  const member1 = sha256("pair-identity-member-1");
  const matchingCovariateSha256 = sha256("pair-identity-matching");
  const base: LiteLearningAuthorityRow = {
    tenant_id: "tenant-a",
    member_0_memory_namespace_sha256: member0,
    member_1_memory_namespace_sha256: member1,
    matching_covariate_sha256: matchingCovariateSha256,
    pair_ordinal: 7,
    assigned_arm: "candidate",
  };
  const identity = learningRandomizationPairIdentityDigest(base);
  assert.equal(identity, learningRandomizationPairIdentityDigest({
    ...base,
    member_0_memory_namespace_sha256: member1,
    member_1_memory_namespace_sha256: member0,
    pair_ordinal: 301,
    assigned_arm: "control",
  }));
  assert.notEqual(identity, learningRandomizationPairIdentityDigest({ ...base, tenant_id: "tenant-b" }));
  assert.notEqual(identity, learningRandomizationPairIdentityDigest({
    ...base,
    matching_covariate_sha256: sha256("pair-identity-other-matching"),
  }));
});

test("fresh Runtime initialization atomically installs the current v4 learning schema", async () => {
  const temp = tempDatabase("fresh-v4");
  try {
    const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await store.close();

    const db = createSqliteDatabase(temp.path);
    try {
      assert.equal(LITE_RUNTIME_WRITE_SCHEMA_VERSION, 4);
      const report = inspectLiteRuntimeSchema(db);
      assert.equal(report.classification, "current");
      assert.equal(report.detected_version, 4);
      assert.deepEqual(report.missing_tables, []);
      assert.deepEqual(report.missing_columns, {});
      assert.deepEqual(report.constraint_problems, []);
      assert.deepEqual(report.index_problems, []);
      assert.deepEqual(report.trigger_problems, []);

      const tables = new Set(userSchemaNames(db, "table"));
      for (const table of LITE_LEARNING_LEDGER_REQUIRED_TABLE_NAMES) {
        assert.equal(tables.has(table), true, `missing current table ${table}`);
      }
      const indexes = new Set(userSchemaNames(db, "index"));
      for (const index of LITE_LEARNING_LEDGER_REQUIRED_INDEX_NAMES) {
        assert.equal(indexes.has(index), true, `missing current index ${index}`);
      }
      const triggers = new Set(userSchemaNames(db, "trigger"));
      for (const trigger of LITE_LEARNING_LEDGER_REQUIRED_TRIGGER_NAMES) {
        assert.equal(triggers.has(trigger), true, `missing current trigger ${trigger}`);
      }

      assert.deepEqual(
        tableColumns(db, "lite_product_measurements").filter((column) => (
          column === "baseline_episode_id" || column === "after_episode_id" || column === "record_sha256"
        )),
        ["baseline_episode_id", "after_episode_id", "record_sha256"],
      );
      const identity = db.prepare(
        "SELECT singleton, database_instance_id FROM lite_runtime_authority_identity",
      ).get() as { singleton: number; database_instance_id: string };
      assert.equal(identity.singleton, 1);
      assert.match(identity.database_instance_id, /^[0-9a-f]{64}$/);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("schema SQL normalization preserves quoted literal bytes", () => {
  const expected = "CREATE TRIGGER sample BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT, 'owner''s active lease'); END;";
  const exteriorVariant = "create   trigger sample before update on records begin select raise(abort, 'owner''s active lease'); end";
  assert.equal(normalizeSqliteSchemaSql(exteriorVariant), normalizeSqliteSchemaSql(expected));
  assert.notEqual(
    normalizeSqliteSchemaSql(expected.replace("owner''s", "OWNER''s")),
    normalizeSqliteSchemaSql(expected),
  );
  assert.notEqual(
    normalizeSqliteSchemaSql(expected.replace("active lease", "active  lease")),
    normalizeSqliteSchemaSql(expected),
  );
});

test("schema SQL normalization follows SQLite whitespace, case, and comment boundaries", () => {
  assert.equal(
    normalizeSqliteSchemaSql("SELECT\t*\fFROM\r\nlease"),
    normalizeSqliteSchemaSql("select * from lease"),
  );
  assert.notEqual(
    normalizeSqliteSchemaSql("SELECT * FROM lease AS row"),
    normalizeSqliteSchemaSql("SELECT * FROM lease\u00a0AS row"),
  );
  assert.notEqual(
    normalizeSqliteSchemaSql("SELECT * FROM lease AS row"),
    normalizeSqliteSchemaSql("SELECT * FROM lease\u000bAS row"),
  );
  assert.notEqual(
    normalizeSqliteSchemaSql("SELECT NEW.event_kind"),
    normalizeSqliteSchemaSql("SELECT NEW.event_\u212Aind"),
  );
  assert.notEqual(
    normalizeSqliteSchemaSql("SELECT 1 -- boundary\n + 2"),
    normalizeSqliteSchemaSql("SELECT 1 -- boundary + 2\n"),
  );
  assert.notEqual(
    normalizeSqliteSchemaSql("SELECT 1 -- boundary\r + 2\n"),
    normalizeSqliteSchemaSql("SELECT 1 -- boundary\r\n + 2"),
  );
});

test("legacy v3 trigger with legal exterior formatting still migrates from sqlite_schema", async () => {
  const temp = tempDatabase("v3-active-lease-exterior-formatting");
  try {
    const initialized = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await initialized.close();
    const formattedLegacySql = legacyV3ActiveLeaseTriggerWithExteriorFormatting();
    assert.notEqual(formattedLegacySql, LITE_LEARNING_V3_ELIGIBLE_ACTIVE_LEASE_TRIGGER_SQL);
    downgradeCurrentFixtureToLegacyV3(temp.path, formattedLegacySql);

    const before = createSqliteDatabase(temp.path);
    try {
      const stored = before.prepare(
        `SELECT sql FROM sqlite_schema
         WHERE type = 'trigger' AND name = 'trg_lite_learning_eligible_active_lease'`,
      ).get() as { sql: string };
      assert.equal(
        normalizeSqliteSchemaSql(stored.sql),
        normalizeSqliteSchemaSql(LITE_LEARNING_V3_ELIGIBLE_ACTIVE_LEASE_TRIGGER_SQL),
      );
      assert.equal(inspectLiteRuntimeSchema(before).classification, "supported_previous_v3");
    } finally {
      before.close();
    }

    const migrated = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await migrated.close();
    const after = createSqliteDatabase(temp.path);
    try {
      assert.equal(inspectLiteRuntimeSchema(after).classification, "current");
    } finally {
      after.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("v3-to-v4 migration rejects a real active-lease literal-case tamper", async () => {
  const temp = tempDatabase("v3-active-lease-literal-case-tamper");
  try {
    const initialized = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await initialized.close();
    downgradeCurrentFixtureToLegacyV3(temp.path);

    const tamperedSql = LITE_LEARNING_V3_ELIGIBLE_ACTIVE_LEASE_TRIGGER_SQL.replace(
      "NEW.collection_class = 'eligible_host'",
      "NEW.collection_class = 'ELIGIBLE_HOST'",
    );
    assert.notEqual(tamperedSql, LITE_LEARNING_V3_ELIGIBLE_ACTIVE_LEASE_TRIGGER_SQL);
    const corrupting = createSqliteDatabase(temp.path);
    corrupting.exec("DROP TRIGGER trg_lite_learning_eligible_active_lease");
    corrupting.exec(tamperedSql);
    assert.equal(inspectLiteRuntimeSchema(corrupting).classification, "incompatible");
    corrupting.exec("BEGIN IMMEDIATE");
    try {
      assert.throws(
        () => migrateLiteLearningEpisodeLedgerV3ToV4(corrupting),
        /lite_runtime_v3_to_v4_active_lease_trigger_precondition_failed/,
      );
    } finally {
      corrupting.exec("ROLLBACK");
      corrupting.close();
    }

    assert.throws(
      () => createLiteWriteStore(temp.path, { annProjectionEnabled: false }),
      /lite_runtime_schema_preflight_failed/,
    );
    const unchanged = createSqliteDatabase(temp.path);
    try {
      assert.equal(
        (unchanged.prepare(
          "SELECT version FROM lite_runtime_schema_metadata WHERE component = 'write_projection'",
        ).get() as { version: number }).version,
        3,
      );
      const stored = unchanged.prepare(
        `SELECT sql FROM sqlite_schema
         WHERE type = 'trigger' AND name = 'trg_lite_learning_eligible_active_lease'`,
      ).get() as { sql: string };
      assert.notEqual(
        normalizeSqliteSchemaSql(stored.sql),
        normalizeSqliteSchemaSql(LITE_LEARNING_V3_ELIGIBLE_ACTIVE_LEASE_TRIGGER_SQL),
      );
      assert.match(stored.sql, /'ELIGIBLE_HOST'/);
    } finally {
      unchanged.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("schema contract and ledger integrity reject real literal-whitespace tampering", async () => {
  const temp = tempDatabase("schema-literal-whitespace-tamper");
  try {
    const initialized = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await initialized.close();
    const triggerName = "lite_runtime_authority_identity_no_update";
    const expected = LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS[triggerName];
    assert.ok(expected);
    const tamperedSql = expected.sql.replace(
      "'lite_runtime_authority_identity is append-only'",
      "'lite_runtime_authority_identity  is append-only'",
    );
    assert.notEqual(tamperedSql, expected.sql);

    const corrupting = createSqliteDatabase(temp.path);
    corrupting.exec(`DROP TRIGGER ${triggerName}`);
    corrupting.exec(tamperedSql);
    const stored = corrupting.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
    ).get(triggerName) as { sql: string };
    assert.match(stored.sql, /identity {2}is append-only/);
    const report = inspectLiteRuntimeSchema(corrupting);
    assert.equal(report.classification, "incompatible");
    assert.match(report.trigger_problems.join("\n"), /definition does not match/);
    assert.throws(
      () => assertLiteLearningEpisodeLedgerSchemaIntegrity(corrupting),
      /definition mismatch/,
    );
    corrupting.close();

    assert.throws(
      () => createLiteWriteStore(temp.path, { annProjectionEnabled: false }),
      /lite_runtime_schema_preflight_failed/,
    );
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("schema contract rejects real SQLite non-ASCII lexical tampering", async (t) => {
  for (const corruption of [
    {
      name: "non-breaking-space-identifier",
      from: "FROM lite_learning_namespace_leases AS lease",
      to: "FROM lite_learning_namespace_leases\u00a0AS lease",
    },
    {
      name: "unicode-case-fold-identifier",
      from: "NEW.event_kind",
      to: "NEW.event_\u212Aind",
    },
  ] as const) {
    await t.test(corruption.name, async () => {
      const temp = tempDatabase(`schema-${corruption.name}`);
      try {
        const initialized = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
        await initialized.close();
        const triggerName = "trg_lite_learning_eligible_active_lease";
        const expected = LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS[triggerName];
        assert.ok(expected);
        const tamperedSql = expected.sql.replace(corruption.from, corruption.to);
        assert.notEqual(tamperedSql, expected.sql);

        const corrupting = createSqliteDatabase(temp.path);
        corrupting.exec(`DROP TRIGGER ${triggerName}`);
        corrupting.exec(tamperedSql);
        const stored = corrupting.prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
        ).get(triggerName) as { sql: string };
        assert.ok(stored.sql.includes(corruption.to));
        const report = inspectLiteRuntimeSchema(corrupting);
        assert.equal(report.classification, "incompatible");
        assert.match(report.trigger_problems.join("\n"), /definition does not match/);
        assert.throws(
          () => assertLiteLearningEpisodeLedgerSchemaIntegrity(corrupting),
          /definition mismatch/,
        );
        corrupting.close();

        assert.throws(
          () => createLiteWriteStore(temp.path, { annProjectionEnabled: false }),
          /lite_runtime_schema_preflight_failed/,
        );
      } finally {
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });
  }
});

test("schema preflight rejects a real partial-index predicate comment spoof", async () => {
  const temp = tempDatabase("schema-partial-index-comment-spoof");
  try {
    const initialized = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await initialized.close();
    const indexName = "idx_lite_learning_namespace_one_active_lease";
    const corrupting = createSqliteDatabase(temp.path);
    corrupting.exec(`DROP INDEX ${indexName}`);
    corrupting.exec(`
      CREATE UNIQUE INDEX ${indexName}
      ON lite_learning_namespace_leases(tenant_id, memory_namespace_sha256)WHERE status='ACTIVE'
      -- where status = 'active'
    `);
    const stored = corrupting.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?",
    ).get(indexName) as { sql: string };
    assert.match(stored.sql, /\)WHERE status='ACTIVE'/);
    assert.match(stored.sql, /-- where status = 'active'/);
    const report = inspectLiteRuntimeSchema(corrupting);
    assert.equal(report.classification, "incompatible");
    assert.match(report.index_problems.join("\n"), /predicate mismatch/);
    assert.throws(
      () => assertLiteLearningEpisodeLedgerSchemaIntegrity(corrupting),
      /index idx_lite_learning_namespace_one_active_lease definition mismatch/,
    );
    corrupting.close();

    assert.throws(
      () => createLiteWriteStore(temp.path, { annProjectionEnabled: false }),
      /lite_runtime_schema_preflight_failed/,
    );
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("exact legacy v3 active-lease trigger migrates atomically to v4 on reopen", async () => {
  const temp = tempDatabase("v3-active-lease-trigger-upgrade");
  try {
    const initialized = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await initialized.close();
    const seeded = createSqliteDatabase(temp.path);
    seeded.prepare(
      `INSERT INTO lite_memory_commits
       (id, scope, parent_commit_id, input_sha256, diff_json, actor,
        model_version, prompt_version, commit_hash, created_at)
       VALUES (?, ?, NULL, ?, '{}', ?, NULL, NULL, ?, ?)`,
    ).run(
      "commit-v3-trigger-migration",
      "scope-v3-trigger-migration",
      sha256("input-v3-trigger-migration"),
      "migration-test",
      sha256("commit-v3-trigger-migration"),
      "2026-07-14T00:00:00.000Z",
    );
    const identityBefore = (seeded.prepare(
      "SELECT database_instance_id FROM lite_runtime_authority_identity WHERE singleton = 1",
    ).get() as { database_instance_id: string }).database_instance_id;
    seeded.close();
    downgradeCurrentFixtureToLegacyV3(temp.path);

    const before = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteRuntimeSchema(before);
      assert.equal(report.classification, "supported_previous_v3");
      assert.equal(report.detected_version, 3);
      assert.equal(report.current_version, 4);
      assert.equal(report.upgrade_required, true);
      const trigger = before.prepare(
        `SELECT sql FROM sqlite_schema
         WHERE type = 'trigger' AND name = 'trg_lite_learning_eligible_active_lease'`,
      ).get() as { sql: string };
      assert.equal(
        normalizeSchemaSql(trigger.sql),
        normalizeSchemaSql(LITE_LEARNING_V3_ELIGIBLE_ACTIVE_LEASE_TRIGGER_SQL),
      );
    } finally {
      before.close();
    }

    const migrated = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await migrated.close();
    const after = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteRuntimeSchema(after);
      assert.equal(report.classification, "current");
      assert.equal(report.detected_version, 4);
      assert.equal(report.upgrade_required, false);
      const trigger = after.prepare(
        `SELECT sql FROM sqlite_schema
         WHERE type = 'trigger' AND name = 'trg_lite_learning_eligible_active_lease'`,
      ).get() as { sql: string };
      assert.equal(
        normalizeSchemaSql(trigger.sql),
        normalizeSchemaSql(
          LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS.trg_lite_learning_eligible_active_lease.sql,
        ),
      );
      assert.equal(
        (after.prepare(
          "SELECT COUNT(*) AS count FROM lite_memory_commits WHERE id = 'commit-v3-trigger-migration'",
        ).get() as { count: number }).count,
        1,
      );
      assert.equal(
        (after.prepare(
          "SELECT database_instance_id FROM lite_runtime_authority_identity WHERE singleton = 1",
        ).get() as { database_instance_id: string }).database_instance_id,
        identityBefore,
      );
    } finally {
      after.close();
    }

    const idempotent = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await idempotent.close();
    const reopened = createSqliteDatabase(temp.path);
    try {
      assert.equal(inspectLiteRuntimeSchema(reopened).classification, "current");
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("v3-to-v4 migration rejects missing or substituted active-lease triggers", async (t) => {
  for (const corruption of ["missing", "substituted"] as const) {
    await t.test(corruption, async () => {
      const temp = tempDatabase(`v3-trigger-${corruption}`);
      try {
        const initialized = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
        await initialized.close();
        downgradeCurrentFixtureToLegacyV3(temp.path);
        const corrupting = createSqliteDatabase(temp.path);
        corrupting.exec("DROP TRIGGER trg_lite_learning_eligible_active_lease");
        if (corruption === "substituted") {
          corrupting.exec(`
            CREATE TRIGGER trg_lite_learning_eligible_active_lease
            BEFORE INSERT ON lite_learning_episode_events
            BEGIN
              SELECT RAISE(ABORT, 'substituted trigger must not be repaired');
            END;
          `);
        }
        const corruptSql = corruption === "substituted"
          ? (corrupting.prepare(
              `SELECT sql FROM sqlite_schema
               WHERE type = 'trigger' AND name = 'trg_lite_learning_eligible_active_lease'`,
            ).get() as { sql: string }).sql
          : null;
        const report = inspectLiteRuntimeSchema(corrupting);
        assert.equal(report.classification, "incompatible");
        assert.match(report.trigger_problems.join("\n"), corruption === "missing"
          ? /missing required trigger/
          : /definition does not match/);
        corrupting.close();

        assert.throws(
          () => createLiteWriteStore(temp.path, { annProjectionEnabled: false }),
          /lite_runtime_schema_preflight_failed/,
        );
        const unchanged = createSqliteDatabase(temp.path);
        try {
          assert.equal(
            (unchanged.prepare(
              "SELECT version FROM lite_runtime_schema_metadata WHERE component = 'write_projection'",
            ).get() as { version: number }).version,
            3,
          );
          const row = unchanged.prepare(
            `SELECT sql FROM sqlite_schema
             WHERE type = 'trigger' AND name = 'trg_lite_learning_eligible_active_lease'`,
          ).get() as { sql: string } | undefined;
          assert.equal(row?.sql ?? null, corruptSql);
        } finally {
          unchanged.close();
        }
      } finally {
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });
  }
});

test("process death cannot expose a partial v3-to-v4 trigger migration", async () => {
  const temp = tempDatabase("v3-trigger-kill-rollback");
  try {
    const initialized = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await initialized.close();
    downgradeCurrentFixtureToLegacyV3(temp.path);

    const child = spawnSync(
      process.execPath,
      [
        "--import", "tsx", MIGRATION_CRASH_CHILD, temp.path,
        "after_metadata_update_before_commit",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(child.status, null, child.stderr || child.stdout);
    assert.equal(child.signal, "SIGKILL");

    const rolledBack = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteRuntimeSchema(rolledBack);
      assert.equal(report.classification, "supported_previous_v3");
      assert.equal(report.detected_version, 3);
      const trigger = rolledBack.prepare(
        `SELECT sql FROM sqlite_schema
         WHERE type = 'trigger' AND name = 'trg_lite_learning_eligible_active_lease'`,
      ).get() as { sql: string };
      assert.equal(
        normalizeSchemaSql(trigger.sql),
        normalizeSchemaSql(LITE_LEARNING_V3_ELIGIBLE_ACTIVE_LEASE_TRIGGER_SQL),
      );
    } finally {
      rolledBack.close();
    }

    const retry = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await retry.close();
    const current = createSqliteDatabase(temp.path);
    try {
      assert.equal(inspectLiteRuntimeSchema(current).classification, "current");
      assert.equal(
        (current.prepare(
          "SELECT version FROM lite_runtime_schema_metadata WHERE component = 'write_projection'",
        ).get() as { version: number }).version,
        4,
      );
    } finally {
      current.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("database-lineage identity is immutable and stable across current-schema reopen", async () => {
  const temp = tempDatabase("identity");
  try {
    const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await store.close();

    const db = createSqliteDatabase(temp.path);
    const first = db.prepare(
      "SELECT database_instance_id FROM lite_runtime_authority_identity WHERE singleton = 1",
    ).get() as { database_instance_id: string };
    assert.throws(
      () => db.prepare(
        "UPDATE lite_runtime_authority_identity SET database_instance_id = ? WHERE singleton = 1",
      ).run("f".repeat(64)),
      /append-only/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM lite_runtime_authority_identity WHERE singleton = 1").run(),
      /append-only/,
    );
    assert.throws(
      () => db.prepare(
        "INSERT INTO lite_runtime_authority_identity (singleton, database_instance_id, created_at) VALUES (1, ?, ?)",
      ).run("e".repeat(64), "2026-07-13T00:00:00.000Z"),
      /UNIQUE|constraint/i,
    );
    db.close();

    const reopened = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await reopened.close();
    const verifyDb = createSqliteDatabase(temp.path);
    try {
      const second = verifyDb.prepare(
        "SELECT database_instance_id FROM lite_runtime_authority_identity WHERE singleton = 1",
      ).get() as { database_instance_id: string };
      assert.equal(second.database_instance_id, first.database_instance_id);
    } finally {
      verifyDb.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("backup and restore preserve lineage identity while independent databases do not share it", async () => {
  const source = tempDatabase("identity-backup-source");
  const independent = tempDatabase("identity-independent");
  try {
    const sourceStore = createLiteWriteStore(source.path, { annProjectionEnabled: false });
    await sourceStore.close();
    const independentStore = createLiteWriteStore(independent.path, { annProjectionEnabled: false });
    await independentStore.close();

    const backupPath = path.join(source.directory, "runtime.backup.sqlite");
    const restoredPath = path.join(source.directory, "runtime.restored.sqlite");
    const sourceVerification = await verifyLiteRuntimeDatabase(source.path);
    const backup = await backupLiteRuntimeDatabase({
      sourcePath: source.path,
      destinationPath: backupPath,
    });
    const restored = await restoreLiteRuntimeDatabase({
      backupPath,
      destinationPath: restoredPath,
    });
    const independentVerification = await verifyLiteRuntimeDatabase(independent.path);

    assert.match(sourceVerification.database_instance_id ?? "", /^[0-9a-f]{64}$/);
    assert.equal(backup.manifest.database_instance_id, sourceVerification.database_instance_id);
    assert.equal(backup.verification.database_instance_id, sourceVerification.database_instance_id);
    assert.equal(restored.verification.database_instance_id, sourceVerification.database_instance_id);
    assert.notEqual(independentVerification.database_instance_id, sourceVerification.database_instance_id);
  } finally {
    fs.rmSync(source.directory, { recursive: true, force: true });
    fs.rmSync(independent.directory, { recursive: true, force: true });
  }
});

test("structural ledger corruption fails closed on access, reopen, verify, backup, and close", async () => {
  const temp = tempDatabase("integrity-fail-closed");
  const database = createLiteRuntimeDatabase(temp.path);
  let writeStore: ReturnType<typeof createLiteWriteStoreFromDatabase> | null = null;
  try {
    writeStore = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
    database.db.exec("DROP TRIGGER trg_lite_learning_policy_versions_update");
    assert.throws(
      () => createLiteLearningEpisodeLedgerAccess(database),
      /lite_learning_schema_integrity_failed.*trg_lite_learning_policy_versions_update/,
    );
    await assert.rejects(
      writeStore.close(),
      /lite_learning_schema_integrity_failed.*trg_lite_learning_policy_versions_update/,
    );
    database.db.exec(
      LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS.trg_lite_learning_policy_versions_update.sql,
    );
    createLiteLearningEpisodeLedgerAccess(database);

    database.db.exec("DROP TRIGGER lite_runtime_authority_identity_no_delete");
    database.db.prepare("DELETE FROM lite_runtime_authority_identity WHERE singleton = 1").run();
    database.db.exec(
      LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS.lite_runtime_authority_identity_no_delete.sql,
    );

    assert.equal(inspectLiteRuntimeSchema(database.db).classification, "current");
    assert.throws(
      () => createLiteLearningEpisodeLedgerAccess(database),
      /runtime_authority_identity/,
    );

    const verification = await verifyLiteRuntimeDatabase(temp.path);
    assert.equal(verification.ok, false);
    assert.equal(verification.integrity_findings.learning_episode_ledger_invalid, 1);
    assert.equal(verification.warnings.includes("learning_episode_ledger_corrupt"), true);
    await assert.rejects(
      backupLiteRuntimeDatabase({
        sourcePath: temp.path,
        destinationPath: path.join(temp.directory, "corrupt.backup.sqlite"),
      }),
      /source_database_verification_failed/,
    );
    assert.equal(fs.existsSync(path.join(temp.directory, "corrupt.backup.sqlite")), false);

    const reopenedDatabase = createLiteRuntimeDatabase(temp.path);
    try {
      assert.throws(
        () => createLiteWriteStoreFromDatabase(reopenedDatabase, { annProjectionEnabled: false }),
        /runtime_authority_identity/,
      );
    } finally {
      await reopenedDatabase.close();
    }
    await assert.rejects(writeStore.close(), /runtime_authority_identity/);
    writeStore = null;
  } finally {
    await database.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("v2-to-v4 migration preserves all eight authority and semantic row families", async () => {
  const temp = tempDatabase("preservation");
  try {
    await createV2Fixture(temp.path);
    const v2 = createSqliteDatabase(temp.path);
    seedV2PreservationRows(v2);
    v2.close();

    const migratedStore = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await migratedStore.close();
    const db = createSqliteDatabase(temp.path);
    try {
      const tables = [
        "lite_memory_commits",
        "lite_memory_nodes",
        "lite_memory_edges",
        "lite_product_guide_receipts",
        "lite_runtime_write_operations",
        "lite_memory_rule_feedback",
        "lite_product_measurements",
        "lite_skill_candidate_reviews",
      ];
      for (const table of tables) {
        assert.equal(
          (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
          1,
          `${table} row was not preserved`,
        );
      }
      const measurement = db.prepare(
        `SELECT baseline_episode_id, after_episode_id, record_sha256
         FROM lite_product_measurements WHERE measurement_id = 'measurement-preserved'`,
      ).get() as Record<string, unknown>;
      assert.equal(measurement.baseline_episode_id, null);
      assert.equal(measurement.after_episode_id, null);
      assert.equal(measurement.record_sha256, null);
      assert.equal(inspectLiteRuntimeSchema(db).classification, "current");
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("v2-to-v4 migration fault rolls back every DDL group and metadata update", async () => {
  const temp = tempDatabase("fault-rollback");
  try {
    await createV2Fixture(temp.path);
    const before = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteRuntimeSchema(before);
      assert.equal(report.classification, "supported_previous_v2");
      assert.equal(report.detected_version, 2);
    } finally {
      before.close();
    }

    const database = createLiteRuntimeDatabase(temp.path);
    try {
      assert.throws(
        () => createLiteWriteStoreFromDatabase(database, {
          annProjectionEnabled: false,
          schemaMigrationFaultInjector(phase) {
            if (phase === "before_metadata_update") {
              throw new Error("injected v4 migration failure before metadata");
            }
          },
        }),
        /injected v4 migration failure before metadata/,
      );
    } finally {
      await database.close();
    }

    const rolledBack = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteRuntimeSchema(rolledBack);
      assert.equal(report.classification, "supported_previous_v2");
      assert.equal(report.detected_version, 2);
      const tables = new Set(userSchemaNames(rolledBack, "table"));
      for (const table of LITE_LEARNING_LEDGER_REQUIRED_TABLE_NAMES) {
        assert.equal(tables.has(table), false, `rolled-back migration leaked ${table}`);
      }
      assert.equal(tableColumns(rolledBack, "lite_product_measurements").includes("record_sha256"), false);
    } finally {
      rolledBack.close();
    }

    const retry = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await retry.close();
    const migrated = createSqliteDatabase(temp.path);
    try {
      assert.equal(inspectLiteRuntimeSchema(migrated).classification, "current");
      assert.equal(
        (migrated.prepare("SELECT COUNT(*) AS count FROM lite_runtime_authority_identity").get() as { count: number }).count,
        1,
      );
    } finally {
      migrated.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("policy-version store is transaction-bound, canonical, immutable, and conflict-safe", async () => {
  const temp = tempDatabase("policy-store");
  const database = createLiteRuntimeDatabase(temp.path);
  let writeStore: ReturnType<typeof createLiteWriteStoreFromDatabase> | null = null;
  try {
    writeStore = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
    const ledger = createLiteLearningEpisodeLedgerAccess(database);
    const candidate = policyRow({ kind: "candidate", id: "candidate-a", version: "v1" });

    await assert.rejects(
      ledger.insertPolicyVersion(candidate),
      /require the shared Runtime transaction/,
    );
    const first = await database.transaction.run(async () => await ledger.insertPolicyVersion(candidate));
    const replay = await database.transaction.run(async () => await ledger.insertPolicyVersion(candidate));
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);

    await assert.rejects(
      database.transaction.run(async () => await ledger.insertPolicyVersion({
        ...candidate,
        implementation_contract_sha256: "b".repeat(64),
      })),
      /replay_conflict/,
    );
    await assert.rejects(
      database.transaction.run(async () => await ledger.insertPolicyVersion({
        ...candidate,
        prospective_calibration_sha256: "c".repeat(64),
        prospective_calibration_json: stableStringify({ status: "passed" }),
      })),
      /candidate policy versions reject calibration fields/,
    );

    const failedCalibration = policyRow({
      kind: "gate",
      id: "gate-a",
      version: "v1",
      calibration: { contract_version: "gate-calibration-v1", status: "failed", scenario_count: 96 },
    });
    await assert.rejects(
      database.transaction.run(async () => await ledger.insertPolicyVersion(failedCalibration)),
      /requires a passing prospective calibration artifact/,
    );
    const gate = policyRow({
      kind: "gate",
      id: "gate-a",
      version: "v1",
      calibration: { contract_version: "gate-calibration-v1", status: "passed", scenario_count: 96 },
    });
    await database.transaction.run(async () => {
      const result = await ledger.insertPolicyVersion(gate);
      assert.equal(result.replayed, false);
    });

    assert.throws(
      () => database.db.prepare(
        "UPDATE lite_learning_policy_versions SET policy_version = 'v2' WHERE tenant_id = 'tenant-a' AND policy_kind = 'candidate'",
      ).run(),
      /update_forbidden/,
    );
    assert.throws(
      () => database.db.prepare(
        "DELETE FROM lite_learning_policy_versions WHERE tenant_id = 'tenant-a' AND policy_kind = 'candidate'",
      ).run(),
      /delete_forbidden/,
    );
  } finally {
    await writeStore?.close();
    await database.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("confirmatory provisioning freezes its cohort while protected close authority stays non-generic", async () => {
  const temp = tempDatabase("confirmatory-ledger");
  const database = createLiteRuntimeDatabase(temp.path);
  let writeStore: ReturnType<typeof createLiteWriteStoreFromDatabase> | null = null;
  try {
    writeStore = createLiteWriteStoreFromDatabase(database, {
      annProjectionEnabled: false,
      authorityReceiptKeyring: storeCloseKeyring(),
    });
    const ledger = createLiteLearningEpisodeLedgerAccess(database, {
      authorityReceiptKeyring: storeCloseKeyring(),
    });
    const fixture = confirmatoryFixture(await ledger.databaseInstanceId());
    await database.transaction.run(async () => {
      await ledger.insertPolicyVersion(fixture.candidate);
      await ledger.insertPolicyVersion(fixture.gate);
    });

    const legacySeriesArray = canonicalJson({
      contract_version: "legacy-series-array-v0",
      series_ids: ["offline", "host", "tool", "runtime-integrity"],
    });
    await assert.rejects(
      database.transaction.run(async () => await ledger.provisionConfirmatorySet({
        ...fixture,
        revision: {
          ...fixture.revision,
          required_evidence_series_sha256: legacySeriesArray.sha256,
          required_evidence_series_json: legacySeriesArray.json,
        },
      })),
      /exact four-role map/,
    );

    const forgedIdentityPairBase = {
      ...fixture.pairs[0]!,
      member_0_memory_namespace_sha256: sha256("forged-pair-member"),
      pair_record_sha256: "0".repeat(64),
    } satisfies LiteLearningAuthorityRow;
    const forgedIdentityPair = {
      ...forgedIdentityPairBase,
      pair_record_sha256: learningRandomizationPairRecordDigest(forgedIdentityPairBase),
    } satisfies LiteLearningAuthorityRow;
    await assert.rejects(
      database.transaction.run(async () => await ledger.provisionConfirmatorySet({
        ...fixture,
        pairs: [forgedIdentityPair, ...fixture.pairs.slice(1)],
      })),
      /randomization pair identity digest mismatch/,
    );

    const forgedPair = {
      ...fixture.pairs[0]!,
      pair_record_sha256: sha256("forged-pair-record"),
    } satisfies LiteLearningAuthorityRow;
    await assert.rejects(
      database.transaction.run(async () => await ledger.provisionConfirmatorySet({
        ...fixture,
        pairs: [forgedPair, ...fixture.pairs.slice(1)],
      })),
      /randomization pair record digest mismatch/,
    );

    const forgedManifestSha256 = sha256("forged-pair-manifest");
    const forgedConfig = canonicalJson({
      ...(JSON.parse(String(fixture.revision.config_json)) as Record<string, unknown>),
      pair_manifest_sha256: forgedManifestSha256,
    });
    const forgedRevision = {
      ...fixture.revision,
      randomization_pair_manifest_sha256: forgedManifestSha256,
      config_sha256: forgedConfig.sha256,
      config_json: forgedConfig.json,
    } satisfies LiteLearningAuthorityRow;
    const forgedAttemptBase = {
      ...fixture.attempt,
      randomization_pair_manifest_sha256: forgedManifestSha256,
      attempt_sha256: "0".repeat(64),
    } satisfies LiteLearningAuthorityRow;
    const forgedAttempt = {
      ...forgedAttemptBase,
      attempt_sha256: learningConfirmatoryAttemptDigest(forgedAttemptBase),
    } satisfies LiteLearningAuthorityRow;
    await assert.rejects(
      database.transaction.run(async () => await ledger.provisionConfirmatorySet({
        ...fixture,
        revision: forgedRevision,
        attempt: forgedAttempt,
      })),
      /confirmatory pair-manifest digest mismatch/,
    );

    await assert.rejects(
      database.transaction.run(async () => await ledger.provisionConfirmatorySet({
        ...fixture,
        leases: fixture.leases.slice(0, -1),
      })),
      /exactly 768 namespace leases/,
    );
    assert.equal(
      (database.db.prepare("SELECT COUNT(*) AS count FROM lite_learning_experiment_revisions").get() as { count: number }).count,
      0,
    );

    const wrongRevisionLease = {
      ...fixture.leases[0]!,
      experiment_id: "wrong-experiment",
    } satisfies LiteLearningAuthorityRow;
    await assert.rejects(
      database.transaction.run(async () => await ledger.provisionConfirmatorySet({
        ...fixture,
        leases: [wrongRevisionLease, ...fixture.leases.slice(1)],
      })),
      /experiment revision binding mismatch/,
    );
    assert.equal(
      (database.db.prepare("SELECT COUNT(*) AS count FROM lite_learning_confirmatory_attempts").get() as { count: number }).count,
      0,
    );

    const wrongOperationConfig = canonicalJson({
      ...(JSON.parse(String(fixture.revision.config_json)) as Record<string, unknown>),
      provision_operation_id_sha256: sha256("different-provision-operation"),
    });
    await assert.rejects(
      database.transaction.run(async () => await ledger.provisionConfirmatorySet({
        ...fixture,
        revision: {
          ...fixture.revision,
          config_sha256: wrongOperationConfig.sha256,
          config_json: wrongOperationConfig.json,
        },
      })),
      /protected operation binding mismatch/,
    );

    const wrongActorAttemptBase = {
      ...fixture.attempt,
      created_by: "different-provisioner",
      attempt_sha256: "0".repeat(64),
    } satisfies LiteLearningAuthorityRow;
    await assert.rejects(
      database.transaction.run(async () => await ledger.provisionConfirmatorySet({
        ...fixture,
        attempt: {
          ...wrongActorAttemptBase,
          attempt_sha256: learningConfirmatoryAttemptDigest(wrongActorAttemptBase),
        },
      })),
      /provisioning actor binding mismatch/,
    );

    await assert.rejects(
      database.transaction.run(async () => await ledger.provisionConfirmatorySet({
        ...fixture,
        leases: fixture.leases.map((lease) => ({
          ...lease,
          acquired_at: "2026-07-13T00:00:01.000Z",
        })),
      })),
      /one protected provision timestamp/,
    );

    await assert.rejects(
      database.transaction.run(async () => await ledger.provisionConfirmatorySet({
        ...fixture,
        revision: {
          ...fixture.revision,
          created_at: "2026-07-13T00:00:01.000Z",
        },
      })),
      /one protected provision timestamp/,
    );

    const inserted = await database.transaction.run(
      async () => await ledger.provisionConfirmatorySet(fixture),
    );
    assert.equal(inserted.replayed, false);
    const leasedPreTreatmentMembers = Array.from({ length: 384 }, (_, index) => [0, 1].map((member) => {
      const storeScopeKey = `confirmatory-namespace:${index}:${member}`;
      const memoryNamespaceSha256 = sha256(storeScopeKey);
      return {
        storeScopeKey,
        memoryNamespaceSha256,
        assignmentUnitSha256: sha256(stableStringify({
          tenant_id: "tenant-a",
          memory_namespace_sha256: memoryNamespaceSha256,
        })),
      };
    })).flat();
    await assert.rejects(
      database.transaction.run(async () => await ledger.scanConfirmatoryPreTreatmentLineage({
        tenantId: "tenant-a",
        experimentId: "experiment-competing-confirmatory",
        experimentRevision: 1,
        members: leasedPreTreatmentMembers,
      })),
      /learning_confirmatory_pre_treatment_lineage_conflict:active_namespace_lease/,
    );
    assert.equal(
      (database.db.prepare("SELECT COUNT(*) AS count FROM lite_learning_randomization_pairs").get() as { count: number }).count,
      384,
    );
    assert.deepEqual(
      (database.db.prepare(
        `SELECT assigned_arm, COUNT(*) AS count
         FROM lite_learning_namespace_leases GROUP BY assigned_arm ORDER BY assigned_arm`,
      ).all() as Array<{ assigned_arm: string; count: number }>).map((row) => ({ ...row })),
      [
        { assigned_arm: "candidate", count: 384 },
        { assigned_arm: "control", count: 384 },
      ],
    );
    const replayed = await database.transaction.run(
      async () => await ledger.provisionConfirmatorySet(fixture),
    );
    assert.equal(replayed.replayed, true);

    const verifierPolicy = canonicalJson({
      contract_version: "test-host-verifier-policy-v1",
      allowed_verifiers: [{
        kind: "instrumented_agent_trace",
        version: "verifier-v1",
        config_sha256: sha256("verifier-config-v1"),
      }],
    });
    const principalBindingBase = authorityRow("lite_learning_collection_principal_bindings", {
      tenant_id: "tenant-a",
      collection_principal_sha256: sha256("eligible-host-principal-a"),
      collection_class: "eligible_host",
      collector_id: "collector-a",
      collector_version: "collector-v1",
      verifier_policy_sha256: verifierPolicy.sha256,
      verifier_policy_json: verifierPolicy.json,
      binding_sha256: "0".repeat(64),
      created_at: "2026-07-13T00:00:00.000Z",
    });
    const principalBinding = {
      ...principalBindingBase,
      binding_sha256: learningCollectionPrincipalBindingDigest(principalBindingBase),
    } satisfies LiteLearningAuthorityRow;
    await database.transaction.run(async () => await ledger.insertCollectionPrincipalBinding(principalBinding));

    const candidateLease = fixture.leases.find((lease) => lease.assigned_arm === "candidate")!;
    const pair = fixture.pairs.find(
      (candidate) => candidate.randomization_pair_sha256 === candidateLease.randomization_pair_sha256,
    )!;
    const hostEnvelope = {
      contract_version: "host_task_envelope_v1",
      host_task_id: "host-task-confirmatory-a",
      collector_id: "collector-a",
      collector_version: "collector-v1",
      task_family: "runtime-learning",
      task_signature: "runtime-learning-task-signature-v1",
      repository_signature: "runtime-learning-repository-v1",
      source_task_sha256: sha256("source-task-confirmatory-a"),
      source_event_sha256: sha256("source-event-confirmatory-a"),
      created_at: "2026-07-14T00:00:00.000Z",
    } as const;
    const guideTraceId = "guide-confirmatory-a";
    const episodeId = learningEpisodeId({
      tenantId: "tenant-a",
      scope: "scope-confirmatory-a",
      guideTraceId,
    });
    const exposureItem: LearningLedgerItem = {
      decision_completeness: "complete",
      memory_id: "memory-confirmatory-a",
      memory_type: "experience",
      source_backend: "sqlite",
      recorded_action: "use_now",
      candidate_action: "inspect_before_use",
      served_action: "inspect_before_use",
      policy_changed: true,
      hard_boundary_preserved: true,
      prior_supported_use_count: 0,
      prior_contradicted_use_count: 0,
      prior_rehydrate_requested_count: 0,
      prior_effect_state: "no_prior",
      repeated_negative_posture: false,
      learning_track: "explore",
      track_reason: "no_prior",
    };
    const recordedAt = new Date(
      new Date(String(candidateLease.activation_starts_at)).getTime() + 12 * 60 * 60 * 1000,
    ).toISOString();
    const exposureRunId = "run-confirmatory-a";
    const guideRoot = promotionEligibleGuideRootMaterial({
      tenantId: "tenant-a",
      scope: "scope-confirmatory-a",
      guideTraceId,
      runId: exposureRunId,
      item: exposureItem,
    });
    const exposurePayload: ExposureCommittedV1 = {
      contract_version: "aionis_learning_exposure_v1",
      guide_trace_id: guideTraceId,
      guide_receipt_sha256: guideRoot.ledgerSha256,
      guide_commit_id: "commit-confirmatory-a",
      request_sha256: sha256("guide-request-confirmatory-a"),
      operation_protection: "protected",
      collection_class: "eligible_host",
      collection_principal_sha256: String(principalBinding.collection_principal_sha256),
      collection_source_policy_sha256: String(fixture.revision.collection_source_policy_sha256),
      collector_id: "collector-a",
      collector_version: "collector-v1",
      host_task_id: hostEnvelope.host_task_id,
      host_task_envelope: hostEnvelope,
      host_task_envelope_sha256: hostTaskEnvelopeDigest(hostEnvelope),
      profile_rule_sha256: String(fixture.revision.profile_rule_sha256),
      experiment_config_sha256: String(fixture.revision.config_sha256),
      evidence_intent: "confirmatory",
      memory_namespace_sha256: String(candidateLease.memory_namespace_sha256),
      namespace_set_sha256: fixture.namespaceSetSha256,
      namespace_lease_id: String(candidateLease.namespace_lease_id),
      namespace_lease_generation: Number(candidateLease.lease_generation),
      assignment_reason_codes: ["candidate_arm_served", "confirmatory_active_lease"],
      assignment_algorithm: "matched_pair_csprng_bit_v1",
      assignment_namespace_sha256: sha256("confirmatory-assignment-namespace-a"),
      candidate_allocation_bps: 5000,
      assignment_bucket: null,
      randomization_pair_sha256: String(candidateLease.randomization_pair_sha256),
      matching_covariate_sha256: String(pair.matching_covariate_sha256),
      pair_member_ordinal: Number(candidateLease.pair_member_ordinal),
      activation_wave_index: Number(candidateLease.activation_wave_index),
      activation_starts_at: String(candidateLease.activation_starts_at),
      index_window_ends_at: String(candidateLease.index_window_ends_at),
      wave_analysis_at: String(candidateLease.wave_analysis_at),
      assignment_arm: "candidate",
      served_arm: "candidate",
      relevant_memory_ids: [exposureItem.memory_id],
      recorded_surface_sha256: learningDecisionSurfaceDigest([{
        memory_id: exposureItem.memory_id,
        action: exposureItem.recorded_action,
      }]),
      candidate_surface_sha256: learningDecisionSurfaceDigest([{
        memory_id: exposureItem.memory_id,
        action: exposureItem.candidate_action,
      }]),
      served_surface_sha256: learningDecisionSurfaceDigest([{
        memory_id: exposureItem.memory_id,
        action: exposureItem.served_action,
      }]),
      projection_complete: true,
      projection_incomplete_reason_codes: [],
      hard_boundary_upgrade_count: 0,
    };
    const exposurePayloadEncoded = canonicalJson(exposurePayload);
    const exposureEvent: EventWithoutDigest = {
      contract_version: "aionis_learning_episode_event_v1",
      tenant_id: "tenant-a",
      scope: "scope-confirmatory-a",
      event_id: "event-confirmatory-exposure-a",
      episode_id: episodeId,
      episode_sequence: 1,
      event_kind: "exposure_committed",
      source_kind: "guide_receipt",
      source_id: guideTraceId,
      source_sha256: exposurePayload.guide_receipt_sha256,
      previous_event_sha256: null,
      payload_sha256: exposurePayloadEncoded.sha256,
      item_set_sha256: learningItemSetDigest([exposureItem]),
      source_commit_id: exposurePayload.guide_commit_id,
      supersedes_event_id: null,
      operation_id: "operation-guide-confirmatory-a",
      run_id: exposureRunId,
      collection_class: "eligible_host",
      recorded_at: recordedAt,
    };
    const exposureRowBindings = {
      collection_principal_sha256: principalBinding.collection_principal_sha256,
      collector_id: hostEnvelope.collector_id,
      collector_version: hostEnvelope.collector_version,
      host_task_id: hostEnvelope.host_task_id,
      host_source_task_sha256: hostEnvelope.source_task_sha256,
      host_source_event_sha256: hostEnvelope.source_event_sha256,
      host_task_envelope_created_at: hostEnvelope.created_at,
      host_task_envelope_sha256: exposurePayload.host_task_envelope_sha256,
      task_family: hostEnvelope.task_family,
      task_signature_sha256: sha256(hostEnvelope.task_signature),
      repo_signature_sha256: sha256(hostEnvelope.repository_signature),
      memory_namespace_sha256: exposurePayload.memory_namespace_sha256,
      namespace_set_sha256: exposurePayload.namespace_set_sha256,
      namespace_lease_id: exposurePayload.namespace_lease_id,
      namespace_lease_generation: exposurePayload.namespace_lease_generation,
      profile_id: fixture.revision.profile_id,
      experiment_id: fixture.revision.experiment_id,
      experiment_revision: fixture.revision.experiment_revision,
      enrollment_state: "enrolled",
      serving_phase: "active_control",
      evidence_intent: "confirmatory",
      assignment_mode: "matched_pair_randomized",
      assignment_unit_sha256: sha256(stableStringify({
        tenant_id: "tenant-a",
        memory_namespace_sha256: exposurePayload.memory_namespace_sha256,
      })),
      assignment_namespace_sha256: exposurePayload.assignment_namespace_sha256,
      assignment_bucket: null,
      randomization_pair_sha256: exposurePayload.randomization_pair_sha256,
      matching_covariate_sha256: exposurePayload.matching_covariate_sha256,
      pair_member_ordinal: exposurePayload.pair_member_ordinal,
      activation_wave_index: exposurePayload.activation_wave_index,
      activation_starts_at: exposurePayload.activation_starts_at,
      index_window_ends_at: exposurePayload.index_window_ends_at,
      wave_analysis_at: exposurePayload.wave_analysis_at,
      assignment_arm: "candidate",
      served_arm: "candidate",
      candidate_policy_id: fixture.candidate.policy_id,
      candidate_policy_version: fixture.candidate.policy_version,
      policy_affected: 1,
      predecision_track: "explore",
      projection_complete: 1,
      promotion_eligible: 1,
    } satisfies Record<string, string | number | Uint8Array | null>;
    const exposureRow = episodeEventRow(exposureEvent, exposurePayload, exposureRowBindings);
    const activeStoreScope = Array.from({ length: 384 }, (_, index) => [
      `confirmatory-namespace:${index}:0`,
      `confirmatory-namespace:${index}:1`,
    ]).flat().find((scope) => sha256(scope) === candidateLease.memory_namespace_sha256);
    assert.ok(activeStoreScope);
    await database.transaction.run(async () => {
      seedPriorCommit(database.db, {
        id: "commit-active-lease-probe",
        scope: activeStoreScope,
      });
      seedPriorNode(database.db, {
        id: "memory-active-lease-probe",
        scope: activeStoreScope,
        commitId: "commit-active-lease-probe",
      });
    });
    const activeLeaseProbes = [
      legacyExposureProbe({
        suffix: "active-unverified-direct",
        memoryNamespaceSha256: String(candidateLease.memory_namespace_sha256),
      }),
      legacyExposureProbe({
        suffix: "active-fixture-direct",
        memoryNamespaceSha256: String(candidateLease.memory_namespace_sha256),
        collectionClass: "fixture_pilot",
      }),
      legacyExposureProbe({
        suffix: "active-aa-direct",
        memoryNamespaceSha256: String(candidateLease.memory_namespace_sha256),
        collectionClass: "eligible_host",
        evidenceIntent: "integrity_only",
        operationProtection: "protected",
        rowOverrides: {
          enrollment_state: "enrolled",
          serving_phase: "aa",
          experiment_id: "experiment-aa-probe",
          experiment_revision: 1,
        },
      }),
      legacyExposureProbe({
        suffix: "active-other-experiment-direct",
        memoryNamespaceSha256: String(candidateLease.memory_namespace_sha256),
        collectionClass: "eligible_host",
        evidenceIntent: "confirmatory",
        operationProtection: "protected",
        rowOverrides: {
          enrollment_state: "enrolled",
          serving_phase: "active_control",
          experiment_id: "other-confirmatory-experiment",
          experiment_revision: 1,
        },
      }),
      legacyExposureProbe({
        suffix: "active-source-commit",
        sourceCommitId: "commit-active-lease-probe",
      }),
      legacyExposureProbe({
        suffix: "active-item-node",
        memoryId: "memory-active-lease-probe",
      }),
    ];
    for (const probe of activeLeaseProbes) {
      await assert.rejects(
        database.transaction.run(async () => await ledger.appendEpisodeEvent({
          row: probe.row,
          event: probe.event,
          payload: probe.payload,
          exposureItems: [probe.item],
        })),
        /learning_active_namespace_lease_isolation_violation/,
      );
    }
    const windowBoundaryExposure = (
      suffix: string,
      boundaryRecordedAt: string,
      servedArm: "control" | "candidate",
    ) => {
      const item: Extract<LearningLedgerItem, { decision_completeness: "complete" }> = servedArm === "candidate"
        ? exposureItem
        : {
            ...exposureItem,
            served_action: exposureItem.recorded_action!,
          };
      const guideTraceId = `guide-confirmatory-${suffix}`;
      const scope = `scope-confirmatory-${suffix}`;
      const runId = `run-confirmatory-${suffix}`;
      const guideRoot = promotionEligibleGuideRootMaterial({
        tenantId: "tenant-a",
        scope,
        guideTraceId,
        runId,
        item,
      });
      const boundaryHostEnvelope = {
        ...hostEnvelope,
        host_task_id: `host-task-confirmatory-${suffix}`,
        source_task_sha256: sha256(`source-task-confirmatory-${suffix}`),
        source_event_sha256: sha256(`source-event-confirmatory-${suffix}`),
      };
      const payload: ExposureCommittedV1 = {
        ...exposurePayload,
        guide_trace_id: guideTraceId,
        guide_receipt_sha256: servedArm === "candidate"
          ? guideRoot.ledgerSha256
          : sha256(`guide-receipt-confirmatory-${suffix}`),
        guide_commit_id: `commit-confirmatory-${suffix}`,
        request_sha256: sha256(`guide-request-confirmatory-${suffix}`),
        host_task_id: boundaryHostEnvelope.host_task_id,
        host_task_envelope: boundaryHostEnvelope,
        host_task_envelope_sha256: hostTaskEnvelopeDigest(boundaryHostEnvelope),
        assignment_reason_codes: servedArm === "candidate"
          ? ["candidate_arm_served", "confirmatory_active_lease"]
          : ["confirmatory_activation_window_inactive"],
        served_arm: servedArm,
        served_surface_sha256: learningDecisionSurfaceDigest([{
          memory_id: item.memory_id,
          action: item.served_action,
        }]),
      };
      const encoded = canonicalJson(payload);
      const event: EventWithoutDigest = {
        ...exposureEvent,
        scope,
        event_id: `event-confirmatory-${suffix}`,
        episode_id: learningEpisodeId({ tenantId: "tenant-a", scope, guideTraceId }),
        source_id: guideTraceId,
        source_sha256: payload.guide_receipt_sha256,
        payload_sha256: encoded.sha256,
        item_set_sha256: learningItemSetDigest([item]),
        source_commit_id: payload.guide_commit_id,
        operation_id: `operation-guide-confirmatory-${suffix}`,
        run_id: runId,
        recorded_at: boundaryRecordedAt,
      };
      return {
        event,
        item,
        payload,
        row: episodeEventRow(event, payload, {
          ...exposureRowBindings,
          host_task_id: boundaryHostEnvelope.host_task_id,
          host_source_task_sha256: boundaryHostEnvelope.source_task_sha256,
          host_source_event_sha256: boundaryHostEnvelope.source_event_sha256,
          host_task_envelope_sha256: payload.host_task_envelope_sha256,
          served_arm: servedArm,
          policy_affected: servedArm === "candidate" ? 1 : 0,
          predecision_track: servedArm === "candidate" ? "explore" : "unaffected",
          promotion_eligible: servedArm === "candidate" ? 1 : 0,
        }),
      };
    };
    const beforeActivation = new Date(
      new Date(String(candidateLease.activation_starts_at)).getTime() - 60 * 60 * 1000,
    ).toISOString();
    const afterIndexWindow = new Date(
      new Date(String(candidateLease.index_window_ends_at)).getTime() + 60 * 60 * 1000,
    ).toISOString();
    for (const boundary of [
      windowBoundaryExposure("early-control", beforeActivation, "control"),
      windowBoundaryExposure("late-control", afterIndexWindow, "control"),
    ]) {
      await database.transaction.run(async () => await ledger.appendEpisodeEvent({
        row: boundary.row,
        event: boundary.event,
        payload: boundary.payload,
        exposureItems: [boundary.item],
      }));
    }
    await ledger.verifyIntegrity();
    const earlyCandidate = windowBoundaryExposure("early-candidate", beforeActivation, "candidate");
    await assert.rejects(
      database.transaction.run(async () => {
        insertPromotionEligibleGuideRoots(database.db, {
          event: earlyCandidate.event,
          payload: earlyCandidate.payload,
          row: earlyCandidate.row,
          item: earlyCandidate.item,
          commitScope: activeStoreScope,
        });
        return await ledger.appendEpisodeEvent({
          row: earlyCandidate.row,
          event: earlyCandidate.event,
          payload: earlyCandidate.payload,
          exposureItems: [earlyCandidate.item],
        });
      }),
      /learning_active_namespace_lease_isolation_violation/,
    );
    const inWindowFallbackCandidate = windowBoundaryExposure(
      "in-window-fallback-candidate",
      recordedAt,
      "candidate",
    );
    const inWindowFallbackPayload: ExposureCommittedV1 = {
      ...inWindowFallbackCandidate.payload,
      assignment_reason_codes: ["safety_pause_required"],
    };
    const inWindowFallbackEncoding = canonicalJson(inWindowFallbackPayload);
    const inWindowFallbackEvent: EventWithoutDigest = {
      ...inWindowFallbackCandidate.event,
      payload_sha256: inWindowFallbackEncoding.sha256,
    };
    await assert.rejects(
      database.transaction.run(async () => await ledger.appendEpisodeEvent({
        row: {
          ...inWindowFallbackCandidate.row,
          event_sha256: learningEpisodeEventDigest(inWindowFallbackEvent),
          payload_sha256: inWindowFallbackEncoding.sha256,
          payload_json: inWindowFallbackEncoding.json,
          promotion_eligible: 0,
        },
        event: inWindowFallbackEvent,
        payload: inWindowFallbackPayload,
        exposureItems: [inWindowFallbackCandidate.item],
      })),
      /learning_active_namespace_lease_isolation_violation/,
    );
    await assert.rejects(
      database.transaction.run(async () => await ledger.appendEpisodeEvent({
        row: { ...exposureRow, memory_namespace_sha256: sha256("wrong-namespace") },
        event: exposureEvent,
        payload: exposurePayload,
        exposureItems: [exposureItem],
      })),
      /learning exposure row mismatch: memory_namespace_sha256/,
    );
    const substitutedRootItem = {
      ...exposureItem,
      memory_id: "memory-confirmatory-substituted-root",
    } satisfies Extract<LearningLedgerItem, { decision_completeness: "complete" }>;
    const substitutedGuideTraceId = "guide-confirmatory-substituted-root";
    const substitutedScope = "scope-confirmatory-substituted-root";
    const substitutedRunId = "run-confirmatory-substituted-root";
    const substitutedRoot = promotionEligibleGuideRootMaterial({
      tenantId: "tenant-a",
      scope: substitutedScope,
      guideTraceId: substitutedGuideTraceId,
      runId: substitutedRunId,
      item: substitutedRootItem,
    });
    const substitutedPayload: ExposureCommittedV1 = {
      ...exposurePayload,
      guide_trace_id: substitutedGuideTraceId,
      guide_receipt_sha256: substitutedRoot.ledgerSha256,
      guide_commit_id: "commit-confirmatory-substituted-root",
      request_sha256: sha256("guide-request-confirmatory-substituted-root"),
    };
    const substitutedPayloadEncoding = canonicalJson(substitutedPayload);
    const substitutedEvent: EventWithoutDigest = {
      ...exposureEvent,
      scope: substitutedScope,
      event_id: "event-confirmatory-substituted-root",
      episode_id: learningEpisodeId({
        tenantId: "tenant-a",
        scope: substitutedScope,
        guideTraceId: substitutedGuideTraceId,
      }),
      source_id: substitutedGuideTraceId,
      source_sha256: substitutedPayload.guide_receipt_sha256,
      payload_sha256: substitutedPayloadEncoding.sha256,
      source_commit_id: substitutedPayload.guide_commit_id,
      operation_id: "operation-guide-confirmatory-substituted-root",
      run_id: substitutedRunId,
    };
    const substitutedRow = episodeEventRow(
      substitutedEvent,
      substitutedPayload,
      exposureRowBindings,
    );
    await assert.rejects(
      database.transaction.run(async () => {
        insertPromotionEligibleGuideRoots(database.db, {
          event: substitutedEvent,
          payload: substitutedPayload,
          row: substitutedRow,
          item: exposureItem,
          rootItem: substitutedRootItem,
          commitScope: activeStoreScope,
        });
        return await ledger.appendEpisodeEvent({
          row: substitutedRow,
          event: substitutedEvent,
          payload: substitutedPayload,
          exposureItems: [exposureItem],
        });
      }),
      /learning_promotion_eligible_guide_root_mismatch:guide_served_surface_membership/,
    );
    const outsideMemoryId = "memory-confirmatory-outside-served-surface";
    const outsideGuideTraceId = "guide-confirmatory-outside-served-surface";
    const outsideScope = "scope-confirmatory-outside-served-surface";
    const outsideRunId = "run-confirmatory-outside-served-surface";
    const outsideRoot = promotionEligibleGuideRootMaterial({
      tenantId: "tenant-a",
      scope: outsideScope,
      guideTraceId: outsideGuideTraceId,
      runId: outsideRunId,
      item: exposureItem,
      memoryIds: [outsideMemoryId],
    });
    const outsidePayload: ExposureCommittedV1 = {
      ...exposurePayload,
      guide_trace_id: outsideGuideTraceId,
      guide_receipt_sha256: outsideRoot.ledgerSha256,
      guide_commit_id: "commit-confirmatory-outside-served-surface",
      request_sha256: sha256("guide-request-confirmatory-outside-served-surface"),
    };
    const outsidePayloadEncoding = canonicalJson(outsidePayload);
    const outsideEvent: EventWithoutDigest = {
      ...exposureEvent,
      scope: outsideScope,
      event_id: "event-confirmatory-outside-served-surface",
      episode_id: learningEpisodeId({
        tenantId: "tenant-a",
        scope: outsideScope,
        guideTraceId: outsideGuideTraceId,
      }),
      source_id: outsideGuideTraceId,
      source_sha256: outsidePayload.guide_receipt_sha256,
      payload_sha256: outsidePayloadEncoding.sha256,
      source_commit_id: outsidePayload.guide_commit_id,
      operation_id: "operation-guide-confirmatory-outside-served-surface",
      run_id: outsideRunId,
    };
    const outsideRow = episodeEventRow(outsideEvent, outsidePayload, exposureRowBindings);
    await assert.rejects(
      database.transaction.run(async () => {
        insertPromotionEligibleGuideRoots(database.db, {
          event: outsideEvent,
          payload: outsidePayload,
          row: outsideRow,
          item: exposureItem,
          rootMemoryIds: [outsideMemoryId],
          commitScope: activeStoreScope,
        });
        return await ledger.appendEpisodeEvent({
          row: outsideRow,
          event: outsideEvent,
          payload: outsidePayload,
          exposureItems: [exposureItem],
        });
      }),
      /learning_promotion_eligible_guide_root_mismatch:guide_memory_membership/,
    );
    await assert.rejects(
      database.transaction.run(async () => await ledger.appendEpisodeEvent({
        row: exposureRow,
        event: exposureEvent,
        payload: exposurePayload,
        exposureItems: [exposureItem],
      })),
      /learning_promotion_eligible_guide_root_mismatch:guide_receipt_binding/,
    );
    await assert.rejects(
      database.transaction.run(async () => {
        insertPromotionEligibleGuideRoots(database.db, {
          event: exposureEvent,
          payload: exposurePayload,
          row: exposureRow,
          item: exposureItem,
          commitScope: "forged-guide-root-scope",
        });
        return await ledger.appendEpisodeEvent({
          row: exposureRow,
          event: exposureEvent,
          payload: exposurePayload,
          exposureItems: [exposureItem],
        });
      }),
      /learning_promotion_eligible_guide_root_mismatch:memory_commit_namespace_binding/,
    );
    await assert.rejects(
      database.transaction.run(async () => {
        insertPromotionEligibleGuideRoots(database.db, {
          event: exposureEvent,
          payload: exposurePayload,
          row: exposureRow,
          item: exposureItem,
          commitScope: activeStoreScope,
          operationRequestSha256: sha256("forged-guide-operation-request"),
        });
        return await ledger.appendEpisodeEvent({
          row: exposureRow,
          event: exposureEvent,
          payload: exposurePayload,
          exposureItems: [exposureItem],
        });
      }),
      /learning_promotion_eligible_guide_root_mismatch:protected_operation_binding/,
    );
    assert.equal(
      (database.db.prepare(
        "SELECT COUNT(*) AS count FROM lite_product_guide_receipts WHERE guide_trace_id = ?",
      ).get(guideTraceId) as { count: number }).count,
      0,
    );
    const insertedExposure = await database.transaction.run(async () => {
      insertPromotionEligibleGuideRoots(database.db, {
        event: exposureEvent,
        payload: exposurePayload,
        row: exposureRow,
        item: exposureItem,
        commitScope: activeStoreScope,
      });
      return await ledger.appendEpisodeEvent({
        row: exposureRow,
        event: exposureEvent,
        payload: exposurePayload,
        exposureItems: [exposureItem],
      });
    });
    assert.equal(insertedExposure.replayed, false);
    const compactRootLedger = JSON.parse(String((database.db.prepare(
      `SELECT ledger_json FROM lite_product_guide_receipts
       WHERE tenant_id = ? AND scope = ? AND guide_trace_id = ?`,
    ).get(
      exposureEvent.tenant_id,
      exposureEvent.scope,
      exposurePayload.guide_trace_id,
    ) as { ledger_json: string }).ledger_json)) as { memory_ids: string[] };
    assert.deepEqual(compactRootLedger.memory_ids, []);
    await ledger.verifyIntegrity();
    const rootedExposureVerification = await verifyLiteRuntimeDatabase(temp.path);
    assert.equal(rootedExposureVerification.ok, true);
    assert.equal(rootedExposureVerification.integrity_findings.learning_episode_ledger_invalid, 0);
    const substitutedRestartRoot = promotionEligibleGuideRootMaterial({
      tenantId: exposureEvent.tenant_id,
      scope: exposureEvent.scope,
      guideTraceId: exposurePayload.guide_trace_id,
      runId: exposureEvent.run_id,
      item: substitutedRootItem,
    });
    const originalRootRows = {
      guideReceipt: database.db.prepare(
        `SELECT ledger_sha256, ledger_json FROM lite_product_guide_receipts
         WHERE tenant_id = ? AND scope = ? AND guide_trace_id = ?`,
      ).get(
        exposureEvent.tenant_id,
        exposureEvent.scope,
        exposurePayload.guide_trace_id,
      ) as { ledger_sha256: string; ledger_json: string },
      commit: database.db.prepare(
        "SELECT input_sha256 FROM lite_memory_commits WHERE id = ?",
      ).get(exposurePayload.guide_commit_id) as { input_sha256: string },
      node: database.db.prepare(
        "SELECT slots_json FROM lite_memory_nodes WHERE commit_id = ? AND client_id = ?",
      ).get(
        exposurePayload.guide_commit_id,
        exposurePayload.guide_trace_id,
      ) as { slots_json: string },
      operation: database.db.prepare(
        `SELECT receipt_json FROM lite_runtime_write_operations
         WHERE tenant_id = ? AND scope = ? AND operation_kind = 'product_guide_v1' AND operation_id = ?`,
      ).get(
        exposureEvent.tenant_id,
        exposureEvent.scope,
        exposureEvent.operation_id,
      ) as { receipt_json: string },
    };
    const substitutedOperationReceipt = JSON.parse(
      originalRootRows.operation.receipt_json,
    ) as { body: Record<string, unknown> };
    substitutedOperationReceipt.body.agent_context = substitutedRestartRoot.agentContext;
    const substitutedRestartPayload: ExposureCommittedV1 = {
      ...exposurePayload,
      guide_receipt_sha256: substitutedRestartRoot.ledgerSha256,
    };
    const substitutedRestartPayloadEncoding = canonicalJson(substitutedRestartPayload);
    const substitutedRestartEvent: EventWithoutDigest = {
      ...exposureEvent,
      source_sha256: substitutedRestartRoot.ledgerSha256,
      payload_sha256: substitutedRestartPayloadEncoding.sha256,
    };
    database.db.exec("DROP TRIGGER trg_lite_learning_episode_events_update");
    database.db.prepare(
      `UPDATE lite_product_guide_receipts SET ledger_sha256 = ?, ledger_json = ?
       WHERE tenant_id = ? AND scope = ? AND guide_trace_id = ?`,
    ).run(
      substitutedRestartRoot.ledgerSha256,
      substitutedRestartRoot.ledgerJson,
      exposureEvent.tenant_id,
      exposureEvent.scope,
      exposurePayload.guide_trace_id,
    );
    database.db.prepare("UPDATE lite_memory_commits SET input_sha256 = ? WHERE id = ?").run(
      substitutedRestartRoot.ledgerSha256,
      exposurePayload.guide_commit_id,
    );
    database.db.prepare(
      "UPDATE lite_memory_nodes SET slots_json = ? WHERE commit_id = ? AND client_id = ?",
    ).run(
      JSON.stringify({
        guide_exposure_v1: substitutedRestartRoot.ledger,
        not_agent_facing: true,
      }),
      exposurePayload.guide_commit_id,
      exposurePayload.guide_trace_id,
    );
    database.db.prepare(
      `UPDATE lite_runtime_write_operations SET receipt_json = ?
       WHERE tenant_id = ? AND scope = ? AND operation_kind = 'product_guide_v1' AND operation_id = ?`,
    ).run(
      stableStringify(substitutedOperationReceipt),
      exposureEvent.tenant_id,
      exposureEvent.scope,
      exposureEvent.operation_id,
    );
    database.db.prepare(
      `UPDATE lite_learning_episode_events
       SET source_sha256 = ?, payload_sha256 = ?, payload_json = ?, event_sha256 = ?
       WHERE tenant_id = ? AND scope = ? AND event_id = ?`,
    ).run(
      substitutedRestartRoot.ledgerSha256,
      substitutedRestartPayloadEncoding.sha256,
      substitutedRestartPayloadEncoding.json,
      learningEpisodeEventDigest(substitutedRestartEvent),
      exposureEvent.tenant_id,
      exposureEvent.scope,
      exposureEvent.event_id,
    );
    database.db.exec(LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS.trg_lite_learning_episode_events_update!.sql);
    await assert.rejects(
      ledger.verifyIntegrity(),
      (error: unknown) => {
        assert.match(
          String((error as { cause?: unknown }).cause),
          /learning_promotion_eligible_guide_root_mismatch:guide_served_surface_membership/,
        );
        return true;
      },
    );
    const substitutedSurfaceVerification = await verifyLiteRuntimeDatabase(temp.path);
    assert.equal(substitutedSurfaceVerification.ok, false);
    assert.equal(substitutedSurfaceVerification.integrity_findings.learning_episode_ledger_invalid, 1);
    database.db.exec("DROP TRIGGER trg_lite_learning_episode_events_update");
    database.db.prepare(
      `UPDATE lite_product_guide_receipts SET ledger_sha256 = ?, ledger_json = ?
       WHERE tenant_id = ? AND scope = ? AND guide_trace_id = ?`,
    ).run(
      originalRootRows.guideReceipt.ledger_sha256,
      originalRootRows.guideReceipt.ledger_json,
      exposureEvent.tenant_id,
      exposureEvent.scope,
      exposurePayload.guide_trace_id,
    );
    database.db.prepare("UPDATE lite_memory_commits SET input_sha256 = ? WHERE id = ?").run(
      originalRootRows.commit.input_sha256,
      exposurePayload.guide_commit_id,
    );
    database.db.prepare(
      "UPDATE lite_memory_nodes SET slots_json = ? WHERE commit_id = ? AND client_id = ?",
    ).run(
      originalRootRows.node.slots_json,
      exposurePayload.guide_commit_id,
      exposurePayload.guide_trace_id,
    );
    database.db.prepare(
      `UPDATE lite_runtime_write_operations SET receipt_json = ?
       WHERE tenant_id = ? AND scope = ? AND operation_kind = 'product_guide_v1' AND operation_id = ?`,
    ).run(
      originalRootRows.operation.receipt_json,
      exposureEvent.tenant_id,
      exposureEvent.scope,
      exposureEvent.operation_id,
    );
    database.db.prepare(
      `UPDATE lite_learning_episode_events
       SET source_sha256 = ?, payload_sha256 = ?, payload_json = ?, event_sha256 = ?
       WHERE tenant_id = ? AND scope = ? AND event_id = ?`,
    ).run(
      exposureEvent.source_sha256,
      exposureEvent.payload_sha256,
      exposurePayloadEncoded.json,
      learningEpisodeEventDigest(exposureEvent),
      exposureEvent.tenant_id,
      exposureEvent.scope,
      exposureEvent.event_id,
    );
    database.db.exec(LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS.trg_lite_learning_episode_events_update!.sql);
    const feedbackVerification = await verifyLiteRuntimeDatabase(temp.path);
    assert.equal(feedbackVerification.ok, true, String(feedbackVerification.learning.integrity_error));
    database.db.prepare(
      `UPDATE lite_runtime_write_operations
       SET request_sha256 = ?
       WHERE tenant_id = ? AND scope = ? AND operation_kind = 'product_guide_v1' AND operation_id = ?`,
    ).run(
      sha256("forged-restart-guide-operation-request"),
      exposureEvent.tenant_id,
      exposureEvent.scope,
      exposureEvent.operation_id,
    );
    const forgedRootVerification = await verifyLiteRuntimeDatabase(temp.path);
    assert.equal(forgedRootVerification.ok, false);
    assert.equal(forgedRootVerification.integrity_findings.learning_episode_ledger_invalid, 1);
    database.db.prepare(
      `UPDATE lite_runtime_write_operations
       SET request_sha256 = ?
       WHERE tenant_id = ? AND scope = ? AND operation_kind = 'product_guide_v1' AND operation_id = ?`,
    ).run(
      exposurePayload.request_sha256,
      exposureEvent.tenant_id,
      exposureEvent.scope,
      exposureEvent.operation_id,
    );
    assert.equal((await verifyLiteRuntimeDatabase(temp.path)).ok, true);
    const exposureReplay = await database.transaction.run(async () => await ledger.appendEpisodeEvent({
      row: exposureRow,
      event: exposureEvent,
      payload: exposurePayload,
      exposureItems: [exposureItem],
    }));
    assert.equal(exposureReplay.replayed, true);
    const replayAfterExposure = await database.transaction.run(
      async () => await ledger.provisionConfirmatorySet(fixture),
    );
    assert.equal(replayAfterExposure.replayed, true);

    const receiptItem = {
      memory_id: exposureItem.memory_id,
      used_surface: "inspect_before_use",
      outcome: "positive",
      action_outcome: "accepted_completed",
      verifier_kind: "instrumented_agent_trace",
      verifier_version: "verifier-v1",
      verifier_config_sha256: sha256("verifier-config-v1"),
      verifier_status: "passed",
      content_evidence_sha256: sha256("content-evidence-confirmatory-a"),
      evidence_ref_sha256: sha256("evidence-ref-confirmatory-a"),
    } as const;
    const receiptBody: HostUseReceiptV1Body = {
      contract_version: "host_use_receipt_v1",
      receipt_id: "host-receipt-confirmatory-a",
      guide_trace_id: guideTraceId,
      episode_id: episodeId,
      operation_id: "operation-feedback-confirmatory-a",
      run_id: "run-feedback-confirmatory-a",
      host_task_id: hostEnvelope.host_task_id,
      host_task_envelope_sha256: exposurePayload.host_task_envelope_sha256,
      collector_id: hostEnvelope.collector_id,
      collector_version: hostEnvelope.collector_version,
      host_trace_sha256: sha256("host-trace-confirmatory-a"),
      observed_at: recordedAt,
      items: [receiptItem],
    };
    const receiptSha256 = hostUseReceiptDigest(receiptBody);
    const closedAt = new Date(new Date(afterIndexWindow).getTime() + 30_000).toISOString();
    const feedbackRecordedAt = new Date(new Date(closedAt).getTime() + 60_000).toISOString();
    const feedbackRuntimeSignalRefs = ["runtime-signal-confirmatory-a"];
    const feedbackCommitParent = database.db.prepare(
      `SELECT id, commit_hash FROM lite_memory_commits
       WHERE scope = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(activeStoreScope) as { id: string; commit_hash: string } | undefined;
    assert.ok(feedbackCommitParent);
    const feedbackCommitInputSha256 = sha256("feedback-input-confirmatory-a");
    const feedbackCommitDiff = {
      job: "nodes_activate",
      started_at: feedbackRecordedAt,
      scope: activeStoreScope,
      actor: "formal-guide-agent",
      run_id: receiptBody.run_id,
      guide_trace_id: guideTraceId,
      learning_episode_id: episodeId,
      feedback_operation_id: receiptBody.operation_id,
      outcome: receiptItem.outcome,
      activate: true,
      feedback: {
        used_surface: receiptItem.used_surface,
        verifier_status: receiptItem.verifier_status,
        tool_status: null,
        runtime_signal_refs: feedbackRuntimeSignalRefs,
        boundary_ignored_memory_ids: [],
        verified_host_receipt: true,
        subjects: [{ memory_id: exposureItem.memory_id, boundary_ignored: false }],
      },
      reason: "Confirmatory host receipt feedback.",
      requested: { node_ids: [exposureItem.memory_id], client_ids: [] },
      resolved_by_client: [],
      found_node_ids: [exposureItem.memory_id],
      missing_node_ids: [],
      missing_client_ids: [],
    };
    const feedbackCommitDiffJson = stableStringify(feedbackCommitDiff);
    const feedbackCommitHash = sha256(stableStringify({
      parentHash: feedbackCommitParent.commit_hash,
      inputSha: feedbackCommitInputSha256,
      diffSha: sha256(feedbackCommitDiffJson),
      scope: activeStoreScope,
      actor: feedbackCommitDiff.actor,
      kind: "nodes_activate",
    }));
    const feedbackCommitId = stableUuid(`lite:commit:${feedbackCommitHash}`);
    const insertFeedbackCommit = () => {
      database.db.prepare(
        `INSERT INTO lite_memory_commits
          (id, scope, parent_commit_id, input_sha256, diff_json, actor,
           model_version, prompt_version, commit_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      ).run(
        feedbackCommitId,
        activeStoreScope,
        feedbackCommitParent.id,
        feedbackCommitInputSha256,
        feedbackCommitDiffJson,
        feedbackCommitDiff.actor,
        feedbackCommitHash,
        feedbackRecordedAt,
      );
    };
    const feedbackOperationReceipt = stableStringify({
      body: {
        contract_version: "aionis_feedback_result_v1",
        tenant_id: exposureEvent.tenant_id,
        scope: exposureEvent.scope,
        operation_id: receiptBody.operation_id,
        learning_attribution_status: "verified_host_receipt",
        learning_episode_id: episodeId,
        learning_feedback_event_id: "event-confirmatory-feedback-a",
        product_action: "feedback",
        operation: "activate",
        target: "memory",
        forget_effect: {
          action: "activate",
          target: "memory",
          reason: feedbackCommitDiff.reason,
          changed_count: 1,
          reversible: false,
          learning_attribution_status: "verified_host_receipt",
          affected_memory_ids: [exposureItem.memory_id],
          affected_client_ids: [],
          attribution: {
            learning_episode_id: episodeId,
            learning_feedback_event_id: "event-confirmatory-feedback-a",
            run_id: receiptBody.run_id,
            outcome: receiptItem.outcome,
            used_surface: receiptItem.used_surface,
            verifier_status: receiptItem.verifier_status,
            runtime_signal_refs: feedbackRuntimeSignalRefs,
          },
        },
        result: {
          scope: exposureEvent.scope,
          tenant_id: exposureEvent.tenant_id,
          commit_id: feedbackCommitId,
          commit_hash: feedbackCommitHash,
          activated: {
            requested_node_ids: 1,
            requested_client_ids: 0,
            resolved_node_ids: 1,
            found_nodes: 1,
            updated_nodes: 1,
            missing_node_ids: [],
            missing_client_ids: [],
            updated_ids: [exposureItem.memory_id],
            guide_trace_id: guideTraceId,
            learning_episode_id: episodeId,
            feedback_operation_id: receiptBody.operation_id,
            outcome: receiptItem.outcome,
            activate: true,
            feedback_attributions: [{
              memory_id: exposureItem.memory_id,
              guide_trace_id: guideTraceId,
              learning_episode_id: episodeId,
              feedback_operation_id: receiptBody.operation_id,
              run_id: receiptBody.run_id,
              outcome: receiptItem.outcome,
              used_surface: receiptItem.used_surface,
              verifier_status: receiptItem.verifier_status,
              tool_status: null,
              runtime_signal_refs: feedbackRuntimeSignalRefs,
              attribution_strength: "positive_attribution",
              boundary_outcome: "aligned",
              feedback_positive: 1,
              feedback_negative: 0,
              weak_counter_signal_count: 0,
              strong_counter_signal_count: 0,
            }],
          },
        },
      },
      ok: true,
      statusCode: 200,
    });
    const feedbackPayload = {
      contract_version: "aionis_learning_feedback_v1",
      feedback_kind: "memory",
      guide_trace_id: guideTraceId,
      request_sha256: sha256("feedback-request-confirmatory-a"),
      operation_protection: "protected",
      operation_receipt_sha256: sha256(feedbackOperationReceipt),
      run_id: receiptBody.run_id,
      source_commit_id: feedbackCommitId,
      host_use_receipt_sha256: receiptSha256,
      runtime_signal_refs: feedbackRuntimeSignalRefs,
      unused_exposure_ids: [exposureEvent.event_id],
    } as const;
    const hostUseReceipt = authorityRow("lite_learning_host_use_receipts", {
      tenant_id: "tenant-a",
      scope: exposureEvent.scope,
      receipt_id: receiptBody.receipt_id,
      episode_id: episodeId,
      feedback_event_id: "event-confirmatory-feedback-a",
      operation_id: receiptBody.operation_id,
      run_id: receiptBody.run_id,
      host_task_id: receiptBody.host_task_id,
      host_task_envelope_sha256: receiptBody.host_task_envelope_sha256,
      collection_principal_sha256: principalBinding.collection_principal_sha256,
      collector_id: receiptBody.collector_id,
      collector_version: receiptBody.collector_version,
      host_trace_sha256: receiptBody.host_trace_sha256,
      observed_at: receiptBody.observed_at,
      received_at: feedbackRecordedAt,
      item_count: 1,
      item_set_sha256: learningHostUseReceiptItemSetDigest(receiptBody.items),
      receipt_sha256: receiptSha256,
      receipt_payload_json: stableStringify(receiptBody),
      verifier_status: "passed",
    });
    const feedbackAttributionBase = authorityRow("lite_learning_feedback_attributions", {
      tenant_id: "tenant-a",
      scope: exposureEvent.scope,
      event_id: "event-confirmatory-feedback-a",
      episode_id: episodeId,
      subject_kind: "memory",
      subject_id: exposureItem.memory_id,
      outcome: receiptItem.outcome,
      action_outcome: receiptItem.action_outcome,
      used_surface: receiptItem.used_surface,
      exposure_action: exposureItem.served_action,
      boundary_outcome: "aligned",
      attribution_strength: "positive_attribution",
      evidence_class: "verified_host_receipt",
      host_use_receipt_id: receiptBody.receipt_id,
      host_use_receipt_sha256: receiptSha256,
      receipt_item_sha256: sha256(stableStringify(receiptItem)),
      host_task_envelope_sha256: receiptBody.host_task_envelope_sha256,
      collection_principal_sha256: principalBinding.collection_principal_sha256,
      collector_id: receiptBody.collector_id,
      collector_version: receiptBody.collector_version,
      content_evidence_sha256: receiptItem.content_evidence_sha256,
      verifier_kind: receiptItem.verifier_kind,
      verifier_version: receiptItem.verifier_version,
      verifier_config_sha256: receiptItem.verifier_config_sha256,
      verifier_status: receiptItem.verifier_status,
      tool_status: null,
      runtime_signal_refs_sha256: sha256(stableStringify([...feedbackPayload.runtime_signal_refs].sort())),
      item_sha256: "0".repeat(64),
    });
    const feedbackAttribution = {
      ...feedbackAttributionBase,
      item_sha256: learningFeedbackAttributionItemDigest(feedbackAttributionBase),
    } satisfies LiteLearningAuthorityRow;
    const feedbackPayloadEncoded = canonicalJson(feedbackPayload);
    const feedbackEvent: EventWithoutDigest = {
      contract_version: "aionis_learning_episode_event_v1",
      tenant_id: "tenant-a",
      scope: exposureEvent.scope,
      event_id: "event-confirmatory-feedback-a",
      episode_id: episodeId,
      episode_sequence: 2,
      event_kind: "feedback_attributed",
      source_kind: "memory_feedback_operation",
      source_id: receiptBody.operation_id,
      source_sha256: feedbackPayload.request_sha256,
      previous_event_sha256: learningEpisodeEventDigest(exposureEvent),
      payload_sha256: feedbackPayloadEncoded.sha256,
      item_set_sha256: learningFeedbackAttributionSetDigest([feedbackAttribution]),
      source_commit_id: feedbackPayload.source_commit_id,
      supersedes_event_id: null,
      operation_id: receiptBody.operation_id,
      run_id: receiptBody.run_id,
      collection_class: "eligible_host",
      recorded_at: String(hostUseReceipt.received_at),
    };
    const feedbackRow = episodeEventRow(feedbackEvent, feedbackPayload, {
      ...exposureRowBindings,
      promotion_eligible: 0,
    });
    const unapprovedReceiptItem = {
      ...receiptItem,
      verifier_config_sha256: sha256("unapproved-verifier-config"),
    };
    const unapprovedReceiptBody: HostUseReceiptV1Body = {
      ...receiptBody,
      items: [unapprovedReceiptItem],
    };
    const unapprovedReceiptSha256 = hostUseReceiptDigest(unapprovedReceiptBody);
    const unapprovedFeedbackPayload = {
      ...feedbackPayload,
      host_use_receipt_sha256: unapprovedReceiptSha256,
    };
    const unapprovedHostUseReceipt = {
      ...hostUseReceipt,
      item_set_sha256: learningHostUseReceiptItemSetDigest(unapprovedReceiptBody.items),
      receipt_sha256: unapprovedReceiptSha256,
      receipt_payload_json: stableStringify(unapprovedReceiptBody),
    } satisfies LiteLearningAuthorityRow;
    const unapprovedAttributionBase = {
      ...feedbackAttributionBase,
      host_use_receipt_sha256: unapprovedReceiptSha256,
      receipt_item_sha256: sha256(stableStringify(unapprovedReceiptItem)),
      verifier_config_sha256: unapprovedReceiptItem.verifier_config_sha256,
      item_sha256: "0".repeat(64),
    } satisfies LiteLearningAuthorityRow;
    const unapprovedAttribution = {
      ...unapprovedAttributionBase,
      item_sha256: learningFeedbackAttributionItemDigest(unapprovedAttributionBase),
    } satisfies LiteLearningAuthorityRow;
    const unapprovedFeedbackPayloadEncoded = canonicalJson(unapprovedFeedbackPayload);
    const unapprovedFeedbackEvent: EventWithoutDigest = {
      ...feedbackEvent,
      source_sha256: unapprovedFeedbackPayload.request_sha256,
      payload_sha256: unapprovedFeedbackPayloadEncoded.sha256,
      item_set_sha256: learningFeedbackAttributionSetDigest([unapprovedAttribution]),
    };
    const unapprovedFeedbackRow = episodeEventRow(
      unapprovedFeedbackEvent,
      unapprovedFeedbackPayload,
      {
        ...exposureRowBindings,
        promotion_eligible: 0,
      },
    );
    await assert.rejects(
      database.transaction.run(async () => {
        insertFeedbackCommit();
        return await ledger.appendEpisodeEvent({
          row: unapprovedFeedbackRow,
          event: unapprovedFeedbackEvent,
          payload: unapprovedFeedbackPayload,
          feedbackAttributions: [unapprovedAttribution],
          hostUseReceipt: unapprovedHostUseReceipt,
        });
      }),
      /host-use receipt verifier is not in the frozen principal policy/,
    );

    const closeAuthority = experimentClosureFixture({
      fixture,
      operationId: "operation-close-confirmatory",
      nonce: "nonce-close-confirmatory",
      createdAt: closedAt,
    });
    await assert.rejects(
      database.transaction.run(async () => await ledger.insertAuthorityFact(
        "lite_learning_authorization_nonces",
        {} as LiteLearningAuthorityRow,
      )),
      /authorization nonces require a protected signed-authority workflow/,
    );
    await assert.rejects(
      database.transaction.run(async () => await ledger.insertAuthorityFact(
        "lite_learning_experiment_closures",
        {} as LiteLearningAuthorityRow,
      )),
      /experiment closures require the protected Task 3\.0C close workflow/,
    );
    await assert.rejects(
      database.transaction.run(async () => await ledger.releaseNamespaceLeaseSet({
        tenantId: "tenant-a",
        confirmatoryAttemptId: String(fixture.attempt.confirmatory_attempt_id),
        releaseOperationId: "operation-close-confirmatory",
        releaseRefKind: "experiment_close" as never,
        releaseRefId: "close-confirmatory",
        releasedAt: closedAt,
        expectedLeaseIds: [],
      })),
      /experiment-close lease release requires the protected Task 3\.0C close workflow/,
    );
    assert.equal(
      (database.db.prepare(
        "SELECT COUNT(*) AS count FROM lite_learning_authorization_nonces",
      ).get() as { count: number }).count,
      0,
    );
    assert.equal(
      (database.db.prepare(
        "SELECT COUNT(*) AS count FROM lite_learning_experiment_closures",
      ).get() as { count: number }).count,
      0,
    );
    assert.equal(
      (database.db.prepare(
        "SELECT COUNT(*) AS count FROM lite_learning_namespace_leases WHERE status = 'active'",
      ).get() as { count: number }).count,
      768,
    );

    const closer = createLiteLearningExperimentCloser({
      database,
      writeStore,
      dependencies: {
        now: () => closedAt,
        resolveKeyring: storeCloseKeyring,
      },
    });
    const closeResult = await closer.close({
      tenantId: "tenant-a",
      actor: "test-operator",
      operationId: closeAuthority.approval.authority_operation_id,
      authorization: closeAuthority.authorization,
      experimentId: String(fixture.revision.experiment_id),
      experimentRevision: Number(fixture.revision.experiment_revision),
    });
    assert.equal(closeResult.replayed, false);

    const exposureReplayAfterClose = await database.transaction.run(
      async () => await ledger.appendEpisodeEvent({
        row: exposureRow,
        event: exposureEvent,
        payload: exposurePayload,
        exposureItems: [exposureItem],
      }),
    );
    assert.equal(exposureReplayAfterClose.replayed, true);

    const closedGuideTraceId = "guide-confirmatory-after-close";
    const closedRunId = "run-confirmatory-after-close";
    const closedGuideRoot = promotionEligibleGuideRootMaterial({
      tenantId: exposureEvent.tenant_id,
      scope: exposureEvent.scope,
      guideTraceId: closedGuideTraceId,
      runId: closedRunId,
      item: exposureItem,
    });
    const closedExposurePayload = {
      ...exposurePayload,
      guide_trace_id: closedGuideTraceId,
      guide_receipt_sha256: closedGuideRoot.ledgerSha256,
      guide_commit_id: "commit-confirmatory-after-close",
      request_sha256: sha256("guide-request-confirmatory-after-close"),
    } satisfies ExposureCommittedV1;
    const closedExposurePayloadEncoded = canonicalJson(closedExposurePayload);
    const closedExposureEvent: EventWithoutDigest = {
      ...exposureEvent,
      event_id: "event-confirmatory-exposure-after-close",
      episode_id: learningEpisodeId({
        tenantId: "tenant-a",
        scope: exposureEvent.scope,
        guideTraceId: closedGuideTraceId,
      }),
      source_id: closedGuideTraceId,
      source_sha256: closedExposurePayload.guide_receipt_sha256,
      payload_sha256: closedExposurePayloadEncoded.sha256,
      source_commit_id: closedExposurePayload.guide_commit_id,
      operation_id: "operation-guide-confirmatory-after-close",
      run_id: closedRunId,
      recorded_at: new Date(new Date(closedAt).getTime() + 1).toISOString(),
    };
    const closedExposureRow = episodeEventRow(
      closedExposureEvent,
      closedExposurePayload,
      exposureRowBindings,
    );
    await assert.rejects(
      database.transaction.run(async () => {
        insertPromotionEligibleGuideRoots(database.db, {
          event: closedExposureEvent,
          payload: closedExposurePayload,
          row: closedExposureRow,
          item: exposureItem,
          commitScope: activeStoreScope,
        });
        return await ledger.appendEpisodeEvent({
          row: closedExposureRow,
          event: closedExposureEvent,
          payload: closedExposurePayload,
          exposureItems: [exposureItem],
        });
      }),
      /learning_experiment_closed:promotion_eligible_exposure/,
    );
    const feedbackInserted = await database.transaction.run(async () => {
      insertFeedbackCommit();
      const appended = await ledger.appendEpisodeEvent({
        row: feedbackRow,
        event: feedbackEvent,
        payload: feedbackPayload,
        feedbackAttributions: [feedbackAttribution],
        hostUseReceipt,
      });
      await writeStore!.insertWriteOperation({
        tenantId: feedbackEvent.tenant_id,
        scope: feedbackEvent.scope,
        operationKind: "product_feedback_v1",
        operationId: String(feedbackEvent.operation_id),
        requestSha256: feedbackPayload.request_sha256,
        receiptJson: feedbackOperationReceipt,
        commitId: feedbackPayload.source_commit_id,
      });
      return appended;
    });
    assert.equal(feedbackInserted.replayed, false);
    assert.ok(String(feedbackRow.recorded_at) > closedAt);
    assert.equal((database.db.prepare(
      "SELECT COUNT(*) AS count FROM lite_learning_experiment_closures WHERE experiment_id = ?",
    ).get(fixture.revision.experiment_id) as { count: number }).count, 1);
    assert.equal((database.db.prepare(
      "SELECT COUNT(*) AS count FROM lite_learning_namespace_leases WHERE confirmatory_attempt_id = ? AND status = 'active'",
    ).get(fixture.attempt.confirmatory_attempt_id) as { count: number }).count, 0);
    const feedbackReplay = await database.transaction.run(async () => await ledger.appendEpisodeEvent({
      row: feedbackRow,
      event: feedbackEvent,
      payload: feedbackPayload,
      feedbackAttributions: [feedbackAttribution],
      hostUseReceipt,
    }));
    assert.equal(feedbackReplay.replayed, true);
    const storeForCorruption = writeStore;
    writeStore = null;
    const verifyClosedFeedback = () => assertLiteLearningEpisodeLedgerIntegrity(
      database.db,
      feedbackRecordedAt,
      { authorityReceiptKeyring: storeCloseKeyring() },
    );
    assert.doesNotThrow(verifyClosedFeedback);

    const persistedFeedbackOperation = database.db.prepare(
      `SELECT tenant_id, scope, operation_kind, operation_id, request_sha256,
              receipt_json, commit_id, created_at
       FROM lite_runtime_write_operations
       WHERE operation_kind = 'product_feedback_v1' AND operation_id = ?`,
    ).get(feedbackEvent.operation_id) as Record<string, string> | undefined;
    assert.ok(persistedFeedbackOperation);
    database.db.prepare(
      `DELETE FROM lite_runtime_write_operations
       WHERE operation_kind = 'product_feedback_v1' AND operation_id = ?`,
    ).run(feedbackEvent.operation_id);
    assert.throws(verifyClosedFeedback, /feedback_operation_receipt/u);
    database.db.prepare(
      `INSERT INTO lite_runtime_write_operations
        (tenant_id, scope, operation_kind, operation_id, request_sha256,
         receipt_json, commit_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      persistedFeedbackOperation.tenant_id,
      persistedFeedbackOperation.scope,
      persistedFeedbackOperation.operation_kind,
      persistedFeedbackOperation.operation_id,
      persistedFeedbackOperation.request_sha256,
      persistedFeedbackOperation.receipt_json,
      persistedFeedbackOperation.commit_id,
      persistedFeedbackOperation.created_at,
    );
    assert.doesNotThrow(verifyClosedFeedback);

    mutateAppendOnlyTable(database.db, "lite_learning_host_use_receipts", () => {
      database.db.prepare(
        "UPDATE lite_learning_host_use_receipts SET received_at = ? WHERE receipt_id = ?",
      ).run(new Date(new Date(feedbackRecordedAt).getTime() + 1).toISOString(), receiptBody.receipt_id);
    });
    let mismatchedReceiptTime: (Error & { cause?: unknown }) | null = null;
    try {
      verifyClosedFeedback();
    } catch (error) {
      mismatchedReceiptTime = error as Error & { cause?: unknown };
    }
    assert.ok(mismatchedReceiptTime);
    assert.match(String(mismatchedReceiptTime), /lite_learning_integrity_failed:semantic_replay/u);
    assert.match(String(mismatchedReceiptTime.cause), /host-use receipt|received_at/u);
    mutateAppendOnlyTable(database.db, "lite_learning_host_use_receipts", () => {
      database.db.prepare(
        "UPDATE lite_learning_host_use_receipts SET received_at = ? WHERE receipt_id = ?",
      ).run(feedbackRecordedAt, receiptBody.receipt_id);
    });
    assert.equal((database.db.prepare(
      "SELECT received_at FROM lite_learning_host_use_receipts WHERE receipt_id = ?",
    ).get(receiptBody.receipt_id) as { received_at: string }).received_at, feedbackRecordedAt);
    const reopenedAfterReceiptRestore = createSqliteDatabase(temp.path);
    try {
      assert.equal((reopenedAfterReceiptRestore.prepare(
        "SELECT received_at FROM lite_learning_host_use_receipts WHERE receipt_id = ?",
      ).get(receiptBody.receipt_id) as { received_at: string }).received_at, feedbackRecordedAt);
    } finally {
      reopenedAfterReceiptRestore.close();
    }
    assert.doesNotThrow(verifyClosedFeedback);
    const alias = policyRow({
      kind: "candidate",
      id: "candidate-confirmatory-alias",
      version: "v2",
      implementation: fixture.candidate.implementation_contract_sha256,
    });
    await database.transaction.run(async () => await ledger.insertPolicyVersion(alias));
    const aliasAttemptId = "attempt-confirmatory-alias";
    const aliasPairs = fixture.pairs.map((pair) => {
      const base = {
        ...pair,
        confirmatory_attempt_id: aliasAttemptId,
        pair_record_sha256: "0".repeat(64),
      } satisfies LiteLearningAuthorityRow;
      return {
        ...base,
        pair_record_sha256: learningRandomizationPairRecordDigest(base),
      } satisfies LiteLearningAuthorityRow;
    });
    const aliasPairManifestSha256 = learningRandomizationPairManifestDigest(aliasPairs);
    const aliasConfig = canonicalJson({
      ...(JSON.parse(String(fixture.revision.config_json)) as Record<string, unknown>),
      pair_manifest_sha256: aliasPairManifestSha256,
    });
    const aliasRevision = {
      ...fixture.revision,
      experiment_id: "experiment-confirmatory-alias",
      candidate_policy_id: alias.policy_id,
      candidate_policy_version: alias.policy_version,
      candidate_policy_config_sha256: alias.policy_config_sha256,
      randomization_pair_manifest_sha256: aliasPairManifestSha256,
      config_sha256: aliasConfig.sha256,
      config_json: aliasConfig.json,
    } satisfies LiteLearningAuthorityRow;
    const aliasAttemptBase = {
      ...fixture.attempt,
      confirmatory_attempt_id: aliasAttemptId,
      experiment_id: aliasRevision.experiment_id,
      candidate_policy_id: alias.policy_id,
      candidate_policy_version: alias.policy_version,
      randomization_pair_manifest_sha256: aliasPairManifestSha256,
      attempt_sha256: "0".repeat(64),
    } satisfies LiteLearningAuthorityRow;
    const aliasAttempt = {
      ...aliasAttemptBase,
      attempt_sha256: learningConfirmatoryAttemptDigest(aliasAttemptBase),
    } satisfies LiteLearningAuthorityRow;
    await assert.rejects(
      database.transaction.run(async () => await ledger.provisionConfirmatorySet({
        revision: aliasRevision,
        attempt: aliasAttempt,
        pairs: aliasPairs,
        leases: fixture.leases.map((lease) => ({
          ...lease,
          namespace_lease_id: `alias-${String(lease.namespace_lease_id)}`,
          confirmatory_attempt_id: aliasAttempt.confirmatory_attempt_id,
          experiment_id: aliasRevision.experiment_id,
          lease_generation: 2,
          acquire_operation_id: "operation-provision-alias",
        })),
      })),
      /UNIQUE constraint failed.*candidate_policy_implementation_sha256/,
    );
    assert.equal(
      (database.db.prepare(
        "SELECT COUNT(*) AS count FROM lite_learning_experiment_revisions WHERE experiment_id = ?",
      ).get(aliasRevision.experiment_id) as { count: number }).count,
      0,
    );

    assert.equal((database.db.prepare(
      "SELECT received_at FROM lite_learning_host_use_receipts WHERE receipt_id = ?",
    ).get(receiptBody.receipt_id) as { received_at: string }).received_at, feedbackRecordedAt);
    assert.equal((database.db.prepare(
      "SELECT recorded_at FROM lite_learning_episode_events WHERE event_id = ?",
    ).get(feedbackEvent.event_id) as { recorded_at: string }).recorded_at, feedbackRecordedAt);
    assert.equal((database.db.prepare(
      `SELECT COUNT(*) AS count
       FROM lite_learning_host_use_receipts AS receipt
       JOIN lite_learning_episode_events AS event
         ON event.tenant_id = receipt.tenant_id
        AND event.scope = receipt.scope
        AND event.event_id = receipt.feedback_event_id
       WHERE receipt.received_at <> event.recorded_at`,
    ).get() as { count: number }).count, 0);
    await ledger.verifyIntegrity();
    mutateAppendOnlyTable(database.db, "lite_learning_episode_events", () => {
      database.db.prepare(
        "UPDATE lite_learning_episode_events SET promotion_eligible = 0 WHERE event_id = ?",
      ).run(exposureEvent.event_id);
    });
    const corruptedEligibility = await verifyLiteRuntimeDatabase(temp.path);
    assert.equal(corruptedEligibility.ok, false);
    assert.equal(corruptedEligibility.integrity_findings.learning_episode_ledger_invalid, 1);
    await assert.rejects(storeForCorruption.close(), /lite_learning_integrity_failed:semantic_replay/);
  } finally {
    await writeStore?.close();
    await database.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("confirmatory pre-treatment lineage scan is transaction-only, canonical, bounded, and allows ordinary priors", async () => {
  const temp = tempDatabase("confirmatory-pre-treatment-snapshot");
  const database = createLiteRuntimeDatabase(temp.path);
  let writeStore: ReturnType<typeof createLiteWriteStoreFromDatabase> | null = null;
  try {
    writeStore = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
    const ledger = createLiteLearningEpisodeLedgerAccess(database);
    const members = confirmatoryPreTreatmentMembers("ordinary-prior");
    const scanArgs = {
      tenantId: "tenant-a",
      experimentId: "experiment-pre-treatment",
      experimentRevision: 1,
      members,
    } as const;
    await assert.rejects(
      ledger.scanConfirmatoryPreTreatmentLineage(scanArgs),
      /shared Runtime transaction/,
    );

    const snapshot = await database.transaction.run(async () => {
      await assert.rejects(
        ledger.scanConfirmatoryPreTreatmentLineage(scanArgs),
        /learning_confirmatory_pre_treatment_lineage_conflict:unknown_existing_scope/,
      );
      for (const [index, member] of members.entries()) {
        seedPriorCommit(database.db, {
          id: `commit-ordinary-prior-${index}`,
          scope: member.storeScopeKey,
        });
      }
      seedPriorNode(database.db, {
        id: "memory-ordinary-prior",
        scope: members[0]!.storeScopeKey,
        commitId: "commit-ordinary-prior-0",
      });
      const first = await ledger.scanConfirmatoryPreTreatmentLineage(scanArgs);
      const replay = await ledger.scanConfirmatoryPreTreatmentLineage({
        ...scanArgs,
        members: [...members].reverse(),
      });
      assert.deepEqual(replay, first);
      return first;
    });
    assert.equal(snapshot.member_count, 768);
    assert.equal(snapshot.members.length, 768);
    assert.equal(snapshot.prior_memory_node_count, 1);
    assert.equal(snapshot.prior_memory_commit_count, 768);
    const prior = snapshot.members.find(
      (member) => member.memory_namespace_sha256 === members[0]!.memoryNamespaceSha256,
    );
    assert.equal(prior?.prior_memory_node_count, 1);
    assert.equal(prior?.prior_memory_commit_count, 1);
    assert.match(snapshot.snapshot_sha256, /^[0-9a-f]{64}$/u);
    assert.match(snapshot.prior_memory_node_head_sha256, /^[0-9a-f]{64}$/u);
    assert.match(snapshot.prior_memory_commit_head_sha256, /^[0-9a-f]{64}$/u);
    assert.equal("storeScopeKey" in snapshot.members[0]!, false);

    await database.transaction.run(async () => {
      await assert.rejects(
        ledger.scanConfirmatoryPreTreatmentLineage({
          ...scanArgs,
          members: [
            { ...members[0]!, memoryNamespaceSha256: sha256("wrong-memory-namespace") },
            ...members.slice(1),
          ],
        }),
        /memory namespace mapping mismatch/,
      );
      const crossTenantScope = "tenant:tenant-b::scope:cross-tenant";
      const crossTenantNamespace = sha256(crossTenantScope);
      await assert.rejects(
        ledger.scanConfirmatoryPreTreatmentLineage({
          ...scanArgs,
          members: [
            {
              storeScopeKey: crossTenantScope,
              memoryNamespaceSha256: crossTenantNamespace,
              assignmentUnitSha256: sha256(stableStringify({
                tenant_id: "tenant-a",
                memory_namespace_sha256: crossTenantNamespace,
              })),
            },
            ...members.slice(1),
          ],
        }),
        /store scope tenant binding mismatch/,
      );
      const oversizedScope = "x".repeat(257);
      const oversizedNamespace = sha256(oversizedScope);
      await assert.rejects(
        ledger.scanConfirmatoryPreTreatmentLineage({
          ...scanArgs,
          members: [
            {
              storeScopeKey: oversizedScope,
              memoryNamespaceSha256: oversizedNamespace,
              assignmentUnitSha256: sha256(stableStringify({
                tenant_id: "tenant-a",
                memory_namespace_sha256: oversizedNamespace,
              })),
            },
            ...members.slice(1),
          ],
        }),
        /store scope must be exact and bounded/,
      );
    });
  } finally {
    await writeStore?.close();
    await database.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("confirmatory pre-treatment lineage scan rejects every historical experiment and guide lineage path", async (t) => {
  const cases = [
    "direct_exposure",
    "exposure_source_commit",
    "exposure_item_node",
    "legacy_guide_receipt_commit",
    "legacy_guide_node",
  ] as const;
  for (const conflictKind of cases) {
    await t.test(conflictKind, async () => {
      const temp = tempDatabase(`pre-treatment-${conflictKind}`);
      const database = createLiteRuntimeDatabase(temp.path);
      let writeStore: ReturnType<typeof createLiteWriteStoreFromDatabase> | null = null;
      try {
        writeStore = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
        const ledger = createLiteLearningEpisodeLedgerAccess(database);
        const members = confirmatoryPreTreatmentMembers(conflictKind);
        const scope = members[0]!.storeScopeKey;
        await database.transaction.run(async () => {
          if (conflictKind === "direct_exposure") {
            const probe = legacyExposureProbe({
              suffix: `lineage-${conflictKind}`,
              memoryNamespaceSha256: members[0]!.memoryNamespaceSha256,
            });
            await ledger.appendEpisodeEvent({
              row: probe.row,
              event: probe.event,
              payload: probe.payload,
              exposureItems: [probe.item],
            });
          } else if (conflictKind === "exposure_source_commit") {
            seedPriorCommit(database.db, { id: "commit-lineage-source", scope });
            const probe = legacyExposureProbe({
              suffix: `lineage-${conflictKind}`,
              sourceCommitId: "commit-lineage-source",
            });
            await ledger.appendEpisodeEvent({
              row: probe.row,
              event: probe.event,
              payload: probe.payload,
              exposureItems: [probe.item],
            });
          } else if (conflictKind === "exposure_item_node") {
            seedPriorCommit(database.db, { id: "commit-lineage-item", scope });
            seedPriorNode(database.db, {
              id: "memory-lineage-item",
              scope,
              commitId: "commit-lineage-item",
            });
            const probe = legacyExposureProbe({
              suffix: `lineage-${conflictKind}`,
              memoryId: "memory-lineage-item",
            });
            await ledger.appendEpisodeEvent({
              row: probe.row,
              event: probe.event,
              payload: probe.payload,
              exposureItems: [probe.item],
            });
          } else if (conflictKind === "legacy_guide_receipt_commit") {
            seedPriorCommit(database.db, { id: "commit-lineage-guide", scope });
            database.db.prepare(
              `INSERT INTO lite_product_guide_receipts
                (tenant_id, scope, guide_trace_id, run_id, consumer_agent_id,
                 consumer_team_id, query_sha256, context_sha256, ledger_sha256,
                 ledger_json, commit_id, created_at)
               VALUES ('tenant-a', 'receipt-scope', 'guide-lineage-receipt',
                       'run-lineage-receipt', 'agent-lineage-receipt', NULL,
                       ?, ?, ?, '{}', 'commit-lineage-guide',
                       '2026-07-12T00:00:00.000Z')`,
            ).run(sha256("guide-query"), sha256("guide-context"), sha256("guide-ledger"));
          } else {
            seedPriorCommit(database.db, { id: "commit-lineage-guide-node", scope });
            seedPriorNode(database.db, {
              id: "memory-lineage-guide-node",
              scope,
              commitId: "commit-lineage-guide-node",
              slots: { guide_exposure_v1: { guide_trace_id: "legacy-guide-node" } },
            });
          }
        });

        await assert.rejects(
          database.transaction.run(async () => await ledger.scanConfirmatoryPreTreatmentLineage({
            tenantId: "tenant-a",
            experimentId: "experiment-pre-treatment",
            experimentRevision: 1,
            members,
          })),
          new RegExp(`learning_confirmatory_pre_treatment_lineage_conflict:${conflictKind}`),
        );
      } finally {
        await writeStore?.close();
        await database.close();
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });
  }
});

test("experiment revisions require evidence-intent-specific external inputs", async () => {
  const temp = tempDatabase("experiment-external-input-intent");
  const database = createLiteRuntimeDatabase(temp.path);
  let writeStore: ReturnType<typeof createLiteWriteStoreFromDatabase> | null = null;
  try {
    writeStore = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
    const ledger = createLiteLearningEpisodeLedgerAccess(database);
    const fixture = confirmatoryFixture(await ledger.databaseInstanceId());
    await database.transaction.run(async () => {
      await ledger.insertPolicyVersion(fixture.candidate);
      await ledger.insertPolicyVersion(fixture.gate);
    });

    const emptyInputs = canonicalJson({});
    const integrityConfig = canonicalJson({
      ...(JSON.parse(String(fixture.revision.config_json)) as Record<string, unknown>),
      required_external_inputs_sha256: emptyInputs.sha256,
    });
    const integrityRevision = {
      ...fixture.revision,
      experiment_id: "experiment-integrity-only",
      serving_phase: "shadow",
      evidence_intent: "integrity_only",
      eligible_memory_namespace_set_sha256: null,
      eligible_memory_namespace_count: null,
      assignment_design: "diagnostic_hash_v1",
      randomization_pair_manifest_sha256: null,
      randomization_pair_count: null,
      activation_schedule_sha256: null,
      confirmatory_assignment_bits: null,
      confirmatory_assignment_bit_count: null,
      confirmatory_assignment_bits_sha256: null,
      required_external_inputs_sha256: emptyInputs.sha256,
      required_external_inputs_json: emptyInputs.json,
      config_sha256: integrityConfig.sha256,
      config_json: integrityConfig.json,
    } satisfies LiteLearningAuthorityRow;

    const inserted = await database.transaction.run(
      async () => await ledger.insertExperimentRevision(integrityRevision),
    );
    assert.equal(inserted.replayed, false);

    const integrityWithConfirmatoryInputsConfig = canonicalJson({
      ...(JSON.parse(String(integrityRevision.config_json)) as Record<string, unknown>),
      required_external_inputs_sha256: fixture.revision.required_external_inputs_sha256,
    });
    await assert.rejects(
      database.transaction.run(async () => await ledger.insertExperimentRevision({
        ...integrityRevision,
        experiment_id: "experiment-integrity-with-external-inputs",
        required_external_inputs_sha256: fixture.revision.required_external_inputs_sha256,
        required_external_inputs_json: fixture.revision.required_external_inputs_json,
        config_sha256: integrityWithConfirmatoryInputsConfig.sha256,
        config_json: integrityWithConfirmatoryInputsConfig.json,
      })),
      /unrecognized key|expected.*never/i,
    );

    const confirmatoryEmptyConfig = canonicalJson({
      ...(JSON.parse(String(fixture.revision.config_json)) as Record<string, unknown>),
      required_external_inputs_sha256: emptyInputs.sha256,
    });
    await assert.rejects(
      database.transaction.run(async () => await ledger.provisionConfirmatorySet({
        ...fixture,
        revision: {
          ...fixture.revision,
          required_external_inputs_sha256: emptyInputs.sha256,
          required_external_inputs_json: emptyInputs.json,
          config_sha256: confirmatoryEmptyConfig.sha256,
          config_json: confirmatoryEmptyConfig.json,
        },
      })),
      /offline_paired|production_shadow|tool_e2e/,
    );
  } finally {
    await writeStore?.close();
    await database.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("episode store appends a canonical exposure once and replays it after reopen", async () => {
  const temp = tempDatabase("episode-replay");
  const fixture = legacyExposureFixture();
  {
    const database = createLiteRuntimeDatabase(temp.path);
    const writeStore = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
    try {
      const ledger = createLiteLearningEpisodeLedgerAccess(database);
      await assert.rejects(
        ledger.appendEpisodeEvent({
          row: fixture.row,
          event: fixture.event,
          payload: fixture.payload,
          exposureItems: [fixture.item],
        }),
        /require the shared Runtime transaction/,
      );
      const inserted = await database.transaction.run(async () => await ledger.appendEpisodeEvent({
        row: fixture.row,
        event: fixture.event,
        payload: fixture.payload,
        exposureItems: [fixture.item],
      }));
      assert.equal(inserted.replayed, false);
      const replayed = await database.transaction.run(async () => await ledger.appendEpisodeEvent({
        row: fixture.row,
        event: fixture.event,
        payload: fixture.payload,
        exposureItems: [fixture.item],
      }));
      assert.equal(replayed.replayed, true);
      assert.throws(
        () => database.db.prepare(
          "UPDATE lite_learning_episode_events SET promotion_eligible = 1 WHERE event_id = ?",
        ).run(fixture.event.event_id),
        /update_forbidden/,
      );
      assert.throws(
        () => database.db.prepare(
          "DELETE FROM lite_learning_exposure_items WHERE event_id = ?",
        ).run(fixture.event.event_id),
        /delete_forbidden/,
      );
    } finally {
      await writeStore.close();
      await database.close();
    }
  }

  const reopenedDatabase = createLiteRuntimeDatabase(temp.path);
  const reopenedWriteStore = createLiteWriteStoreFromDatabase(reopenedDatabase, { annProjectionEnabled: false });
  try {
    const ledger = createLiteLearningEpisodeLedgerAccess(reopenedDatabase);
    await ledger.verifyIntegrity();
    const replayed = await reopenedDatabase.transaction.run(async () => await ledger.appendEpisodeEvent({
      row: fixture.row,
      event: fixture.event,
      payload: fixture.payload,
      exposureItems: [fixture.item],
    }));
    assert.equal(replayed.replayed, true);
    assert.equal(
      (reopenedDatabase.db.prepare(
        "SELECT COUNT(*) AS count FROM lite_learning_episode_events WHERE episode_id = ?",
      ).get(fixture.episodeId) as { count: number }).count,
      1,
    );
  } finally {
    await reopenedWriteStore.close();
    await reopenedDatabase.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("generic verification and backup replay canonical episode payload, event, item, and eligibility digests", async (t) => {
  const cases = [
    {
      name: "payload digest",
      table: "lite_learning_episode_events" as const,
      sql: "UPDATE lite_learning_episode_events SET payload_sha256 = ? WHERE event_id = ?",
      value: "0".repeat(64),
    },
    {
      name: "event digest",
      table: "lite_learning_episode_events" as const,
      sql: "UPDATE lite_learning_episode_events SET event_sha256 = ? WHERE event_id = ?",
      value: "1".repeat(64),
    },
    {
      name: "item-set digest",
      table: "lite_learning_episode_events" as const,
      sql: "UPDATE lite_learning_episode_events SET item_set_sha256 = ? WHERE event_id = ?",
      value: "2".repeat(64),
    },
    {
      name: "exposure item digest",
      table: "lite_learning_exposure_items" as const,
      sql: "UPDATE lite_learning_exposure_items SET item_sha256 = ? WHERE event_id = ?",
      value: "3".repeat(64),
    },
  ];

  for (const corruption of cases) {
    await t.test(corruption.name, async () => {
      const temp = tempDatabase(`episode-data-operations-${corruption.name.replaceAll(" ", "-")}`);
      const fixture = legacyExposureFixture();
      const backupPath = path.join(temp.directory, "corrupt.backup.sqlite");
      try {
        const database = createLiteRuntimeDatabase(temp.path);
        const writeStore = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
        try {
          const ledger = createLiteLearningEpisodeLedgerAccess(database);
          await database.transaction.run(async () => await ledger.appendEpisodeEvent({
            row: fixture.row,
            event: fixture.event,
            payload: fixture.payload,
            exposureItems: [fixture.item],
          }));
        } finally {
          await writeStore.close();
          await database.close();
        }

        const corrupt = createSqliteDatabase(temp.path);
        try {
          mutateAppendOnlyTable(corrupt, corruption.table, () => {
            corrupt.prepare(corruption.sql).run(corruption.value, fixture.event.event_id);
          });
        } finally {
          corrupt.close();
        }

        const verification = await verifyLiteRuntimeDatabase(temp.path);
        assert.equal(verification.ok, false);
        assert.equal(verification.integrity_findings.learning_episode_ledger_invalid, 1);
        await assert.rejects(
          backupLiteRuntimeDatabase({ sourcePath: temp.path, destinationPath: backupPath }),
          /source_database_verification_failed/,
        );
        assert.equal(fs.existsSync(backupPath), false);
      } finally {
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });
  }
});

test("feedback and effect rows stay atomic while legal control blockers fail learning artifacts", async () => {
  const temp = tempDatabase("episode-feedback-effect");
  const exposure = legacyExposureFixture();
  const database = createLiteRuntimeDatabase(temp.path);
  let writeStore: ReturnType<typeof createLiteWriteStoreFromDatabase> | null = null;
  try {
    writeStore = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
    const ledger = createLiteLearningEpisodeLedgerAccess(database);
    const gateFixture = confirmatoryFixture(await ledger.databaseInstanceId());
    await database.transaction.run(async () => {
      await ledger.insertPolicyVersion(gateFixture.candidate);
      await ledger.insertPolicyVersion(gateFixture.gate);
      await ledger.provisionConfirmatorySet(gateFixture);
    });
    await database.transaction.run(async () => await ledger.appendEpisodeEvent({
      row: exposure.row,
      event: exposure.event,
      payload: exposure.payload,
      exposureItems: [exposure.item],
    }));

    const feedbackPayload = {
      contract_version: "aionis_learning_feedback_v1",
      feedback_kind: "memory",
      guide_trace_id: "guide-a",
      request_sha256: "c".repeat(64),
      operation_protection: "legacy_unprotected",
      operation_receipt_sha256: null,
      run_id: "run-feedback-a",
      source_commit_id: "commit-feedback-a",
      host_use_receipt_sha256: null,
      runtime_signal_refs: [],
      unused_exposure_ids: [exposure.event.event_id],
    } as const;
    const feedbackAttributionBase = authorityRow("lite_learning_feedback_attributions", {
      tenant_id: "tenant-a",
      scope: "scope-a",
      event_id: "event-feedback-a",
      episode_id: exposure.episodeId,
      subject_kind: "memory",
      subject_id: "memory-a",
      outcome: "negative",
      action_outcome: null,
      used_surface: "inspect_before_use",
      exposure_action: "inspect_before_use",
      boundary_outcome: "aligned",
      attribution_strength: "weak_counter_signal",
      evidence_class: "legacy_unverified",
      host_use_receipt_id: null,
      host_use_receipt_sha256: null,
      receipt_item_sha256: null,
      host_task_envelope_sha256: null,
      collection_principal_sha256: null,
      collector_id: null,
      collector_version: null,
      content_evidence_sha256: null,
      verifier_kind: null,
      verifier_version: null,
      verifier_config_sha256: null,
      verifier_status: null,
      tool_status: null,
      runtime_signal_refs_sha256: null,
      item_sha256: "0".repeat(64),
    });
    const feedbackAttribution = {
      ...feedbackAttributionBase,
      item_sha256: learningFeedbackAttributionItemDigest(feedbackAttributionBase),
    } satisfies LiteLearningAuthorityRow;
    const feedbackPayloadEncoded = canonicalJson(feedbackPayload);
    const feedbackEvent: EventWithoutDigest = {
      contract_version: "aionis_learning_episode_event_v1",
      tenant_id: "tenant-a",
      scope: "scope-a",
      event_id: "event-feedback-a",
      episode_id: exposure.episodeId,
      episode_sequence: 2,
      event_kind: "feedback_attributed",
      source_kind: "memory_feedback_operation",
      source_id: "feedback-operation-a",
      source_sha256: sha256("feedback-source-a"),
      previous_event_sha256: learningEpisodeEventDigest(exposure.event),
      payload_sha256: feedbackPayloadEncoded.sha256,
      item_set_sha256: learningFeedbackAttributionSetDigest([feedbackAttribution]),
      source_commit_id: "commit-feedback-a",
      supersedes_event_id: null,
      operation_id: "feedback-operation-a",
      run_id: "run-feedback-a",
      collection_class: "unverified",
      recorded_at: "2026-07-13T01:00:00.000Z",
    };
    const feedbackRow = episodeEventRow(feedbackEvent, feedbackPayload);
    await assert.rejects(
      database.transaction.run(async () => await ledger.appendEpisodeEvent({
        row: feedbackRow,
        event: feedbackEvent,
        payload: feedbackPayload,
        feedbackAttributions: [feedbackAttribution],
        hostUseReceipt: authorityRow("lite_learning_host_use_receipts", {}),
      })),
      /legacy and tool feedback cannot persist a host receipt header/,
    );
    const feedbackInserted = await database.transaction.run(async () => await ledger.appendEpisodeEvent({
      row: feedbackRow,
      event: feedbackEvent,
      payload: feedbackPayload,
      feedbackAttributions: [feedbackAttribution],
    }));
    assert.equal(feedbackInserted.replayed, false);
    const feedbackReplay = await database.transaction.run(async () => await ledger.appendEpisodeEvent({
      row: feedbackRow,
      event: feedbackEvent,
      payload: feedbackPayload,
      feedbackAttributions: [feedbackAttribution],
    }));
    assert.equal(feedbackReplay.replayed, true);

    const correctionBase = {
      ...feedbackAttribution,
      event_id: "event-feedback-correction",
      outcome: "neutral",
      attribution_strength: "observed_feedback",
      item_sha256: "0".repeat(64),
    } satisfies LiteLearningAuthorityRow;
    const correction = {
      ...correctionBase,
      item_sha256: learningFeedbackAttributionItemDigest(correctionBase),
    } satisfies LiteLearningAuthorityRow;
    const correctionEvent: EventWithoutDigest = {
      ...feedbackEvent,
      event_id: "event-feedback-correction",
      episode_sequence: 3,
      source_id: "feedback-operation-correction",
      source_sha256: sha256("feedback-source-correction"),
      previous_event_sha256: learningEpisodeEventDigest(feedbackEvent),
      item_set_sha256: learningFeedbackAttributionSetDigest([correction]),
      supersedes_event_id: feedbackEvent.event_id,
      operation_id: "feedback-operation-correction",
      recorded_at: "2026-07-13T02:00:00.000Z",
    };
    const correctionPayload = {
      ...feedbackPayload,
      run_id: "run-feedback-a",
      source_commit_id: "commit-feedback-a",
    };
    const correctionPayloadEncoded = canonicalJson(correctionPayload);
    correctionEvent.payload_sha256 = correctionPayloadEncoded.sha256;
    const correctionRow = episodeEventRow(correctionEvent, correctionPayload);
    await assert.rejects(
      database.transaction.run(async () => await ledger.appendEpisodeEvent({
        row: correctionRow,
        event: correctionEvent,
        payload: correctionPayload,
        feedbackAttributions: [],
      })),
      /non-empty complete attribution set/,
    );
    await database.transaction.run(async () => await ledger.appendEpisodeEvent({
      row: correctionRow,
      event: correctionEvent,
      payload: correctionPayload,
      feedbackAttributions: [correction],
    }));

    const baselineEpisodeId = `lep_${"1".repeat(64)}`;
    const measurementRecordSha256 = sha256("measurement-record-a");
    database.db.prepare(
      `INSERT INTO lite_product_measurements
        (measurement_id, tenant_id, scope, source, measurement_digest,
         effect_report_json, eligible_for_skill_export, evidence_status,
         runtime_evidence_ids_json, eligibility_reasons_json, created_by,
         created_at, baseline_episode_id, after_episode_id, record_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "measurement-a",
      "tenant-a",
      "scope-a",
      "product_trace",
      sha256("measurement-digest-a"),
      stableStringify({ status: "sufficient" }),
      0,
      "sufficient",
      "[]",
      "[]",
      "test-measurement",
      "2026-07-13T03:00:00.000Z",
      baselineEpisodeId,
      exposure.episodeId,
      measurementRecordSha256,
    );
    const effectPayload = {
      contract_version: "aionis_learning_effect_v1",
      measurement_id: "measurement-a",
      measurement_record_sha256: measurementRecordSha256,
      baseline_episode_id: baselineEpisodeId,
      after_episode_id: exposure.episodeId,
      evidence_status: "sufficient",
      eligible_for_skill_export: false,
    } as const;
    const effectPayloadEncoded = canonicalJson(effectPayload);
    const effectEvent: EventWithoutDigest = {
      contract_version: "aionis_learning_episode_event_v1",
      tenant_id: "tenant-a",
      scope: "scope-a",
      event_id: "event-effect-a",
      episode_id: exposure.episodeId,
      episode_sequence: 4,
      event_kind: "effect_measured",
      source_kind: "product_measurement",
      source_id: "measurement-a",
      source_sha256: measurementRecordSha256,
      previous_event_sha256: learningEpisodeEventDigest(correctionEvent),
      payload_sha256: effectPayloadEncoded.sha256,
      item_set_sha256: sha256(stableStringify([])),
      source_commit_id: null,
      supersedes_event_id: null,
      operation_id: null,
      run_id: null,
      collection_class: "unverified",
      recorded_at: "2026-07-13T03:00:00.000Z",
    };
    const effectRow = episodeEventRow(effectEvent, effectPayload);
    const effectInserted = await database.transaction.run(async () => await ledger.appendEpisodeEvent({
      row: effectRow,
      event: effectEvent,
      payload: effectPayload,
    }));
    assert.equal(effectInserted.replayed, false);
    const effectReplay = await database.transaction.run(async () => await ledger.appendEpisodeEvent({
      row: effectRow,
      event: effectEvent,
      payload: effectPayload,
    }));
    assert.equal(effectReplay.replayed, true);

    const controlPayload = canonicalJson({
      contract_version: "unused_exposure_learning_control_v1",
      feedback_event_id: feedbackEvent.event_id,
      exposure_ids: [exposure.event.event_id],
    });
    const insertControlJob = database.db.prepare(
      `INSERT INTO lite_learning_control_jobs
        (tenant_id, scope, job_id, job_kind, operation_id, source_episode_id,
         source_feedback_event_id, source_commit_id, payload_sha256, payload_json,
         status, attempt_count, available_at, lease_owner, lease_expires_at,
         result_commit_id, last_error_code, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, 'unused_exposure_learning_control_v1', ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    );
    insertControlJob.run(
      "tenant-a", "scope-a", "control-dead-letter", "control-operation-dead-letter",
      exposure.episodeId, feedbackEvent.event_id, "commit-feedback-a",
      controlPayload.sha256, controlPayload.json, "dead_letter", 8,
      "2026-07-13T04:00:00.000Z", null, null, "retry_exhausted",
      "2026-07-13T04:00:00.000Z", "2026-07-13T05:00:00.000Z",
      "2026-07-13T05:00:00.000Z",
    );
    insertControlJob.run(
      "tenant-a", "scope-a", "control-expired-lease", "control-operation-expired-lease",
      exposure.episodeId, feedbackEvent.event_id, "commit-feedback-a",
      controlPayload.sha256, controlPayload.json, "leased", 1,
      "2026-07-13T04:00:00.000Z", "worker-a", "2026-07-13T05:00:00.000Z", null,
      "2026-07-13T04:00:00.000Z", "2026-07-13T04:30:00.000Z", null,
    );
    assert.throws(
      () => database.db.prepare(
        `UPDATE lite_learning_control_jobs
         SET status = 'pending', attempt_count = 8, lease_owner = NULL,
             lease_expires_at = NULL, last_error_code = NULL, completed_at = NULL
         WHERE job_id = 'control-dead-letter'`,
      ).run(),
      /learning_control_job_update_forbidden/,
    );
    assert.throws(
      () => database.db.prepare(
        "DELETE FROM lite_learning_control_jobs WHERE job_id = 'control-dead-letter'",
      ).run(),
      /learning_control_job_delete_forbidden/,
    );

    const verification = await verifyLiteRuntimeDatabase(temp.path);
    assert.equal(verification.ok, true);
    assert.equal(verification.counts.learning_control_jobs, 2);
    assert.equal(verification.counts.learning_control_dead_letters, 1);
    assert.equal(verification.learning.active_serving_blocked, true);
    assert.equal(verification.learning.promotion_blocked, true);
    assert.deepEqual(verification.learning.blockers, ["learning_control_dead_letters_present"]);
    assert.equal(verification.learning.reclaimable_expired_control_job_leases, 1);

    const lookContext = deriveLiteLearningLookAuthorityContext(database.db, {
      tenantId: "tenant-a",
      experimentId: String(gateFixture.revision.experiment_id),
      experimentRevision: Number(gateFixture.revision.experiment_revision),
      lookIndex: 1,
    });
    const proposalBase = {
      contract_version: "learning_look_proposal_v1" as const,
      tenant_id: "tenant-a",
      confirmatory_attempt_id: String(gateFixture.attempt.confirmatory_attempt_id),
      experiment_id: String(gateFixture.revision.experiment_id),
      experiment_revision: Number(gateFixture.revision.experiment_revision),
      experiment_config_sha256: String(gateFixture.revision.config_sha256),
      task_family: String(gateFixture.attempt.task_family),
      candidate_policy_id: String(gateFixture.candidate.policy_id),
      candidate_policy_version: String(gateFixture.candidate.policy_version),
      candidate_policy_config_sha256: String(gateFixture.candidate.policy_config_sha256),
      candidate_policy_implementation_sha256:
        String(gateFixture.candidate.implementation_contract_sha256),
      gate_policy_id: String(gateFixture.gate.policy_id),
      gate_policy_version: String(gateFixture.gate.policy_version),
      gate_policy_config_sha256: String(gateFixture.gate.policy_config_sha256),
      gate_policy_implementation_sha256:
        String(gateFixture.gate.implementation_contract_sha256),
      look_index: 1 as const,
      target_cumulative_pair_count: lookContext.target_cumulative_pair_count,
      checkpoint_kind: lookContext.checkpoint_kind,
      cutoff: lookContext.cutoff,
    };
    const outcomeRedactedAuthorityProjection =
      buildLearningOutcomeRedactedAuthorityProjection(database.db, proposalBase);
    const proposal = {
      ...proposalBase,
      outcome_redacted_authority_projection: outcomeRedactedAuthorityProjection,
      outcome_redacted_authority_projection_sha256:
        learningOutcomeRedactedAuthorityProjectionDigest(outcomeRedactedAuthorityProjection),
    };
    const learningArtifactVerification = await verifyLiteRuntimeLearningArtifact({
      path: temp.path,
      proposal,
    });
    assert.equal(learningArtifactVerification.verification.ok, true);
    assert.equal(learningArtifactVerification.report.integrity_status, "failed");
    assert.deepEqual(
      learningArtifactVerification.report.findings
        .filter((finding) => finding.count > 0)
        .map((finding) => [finding.code, finding.count, finding.severity]),
      [["control_plane_integrity", 1, "error"]],
    );

    const permutedAttributionBase = {
      ...feedbackAttribution,
      outcome: "neutral",
      attribution_strength: "observed_feedback",
      item_sha256: "0".repeat(64),
    } satisfies LiteLearningAuthorityRow;
    const permutedAttribution = {
      ...permutedAttributionBase,
      item_sha256: learningFeedbackAttributionItemDigest(permutedAttributionBase),
    } satisfies LiteLearningAuthorityRow;
    const permutedFeedbackEvent = {
      ...feedbackEvent,
      item_set_sha256: learningFeedbackAttributionSetDigest([permutedAttribution]),
    } satisfies EventWithoutDigest;
    const permutedCorrectionEvent = {
      ...correctionEvent,
      previous_event_sha256: learningEpisodeEventDigest(permutedFeedbackEvent),
    } satisfies EventWithoutDigest;
    const permutedEffectEvent = {
      ...effectEvent,
      previous_event_sha256: learningEpisodeEventDigest(permutedCorrectionEvent),
    } satisfies EventWithoutDigest;
    mutateAppendOnlyTable(database.db, "lite_learning_feedback_attributions", () => {
      database.db.prepare(
        `UPDATE lite_learning_feedback_attributions
         SET outcome = ?, attribution_strength = ?, item_sha256 = ?
         WHERE tenant_id = ? AND scope = ? AND event_id = ?
           AND subject_kind = ? AND subject_id = ?`,
      ).run(
        permutedAttribution.outcome,
        permutedAttribution.attribution_strength,
        permutedAttribution.item_sha256,
        permutedAttribution.tenant_id,
        permutedAttribution.scope,
        permutedAttribution.event_id,
        permutedAttribution.subject_kind,
        permutedAttribution.subject_id,
      );
    });
    mutateAppendOnlyTable(database.db, "lite_learning_episode_events", () => {
      for (const event of [permutedFeedbackEvent, permutedCorrectionEvent, permutedEffectEvent]) {
        database.db.prepare(
          `UPDATE lite_learning_episode_events
           SET previous_event_sha256 = ?, item_set_sha256 = ?, event_sha256 = ?
           WHERE tenant_id = ? AND scope = ? AND event_id = ?`,
        ).run(
          event.previous_event_sha256,
          event.item_set_sha256,
          learningEpisodeEventDigest(event),
          event.tenant_id,
          event.scope,
          event.event_id,
        );
      }
    });
    assert.equal((await verifyLiteRuntimeDatabase(temp.path)).ok, true);
    const labelPermutedArtifact = await verifyLiteRuntimeLearningArtifact({
      path: temp.path,
      proposal,
    });
    assert.deepEqual(labelPermutedArtifact.report, learningArtifactVerification.report);
    assert.equal(labelPermutedArtifact.report_sha256, learningArtifactVerification.report_sha256);

    const emptyControlPayload = canonicalJson({});
    mutateAppendOnlyTable(database.db, "lite_learning_control_jobs", () => {
      database.db.prepare(
        `UPDATE lite_learning_control_jobs
         SET payload_json = ?, payload_sha256 = ?
         WHERE job_id = 'control-expired-lease'`,
      ).run(emptyControlPayload.json, emptyControlPayload.sha256);
    });
    const invalidControlPayload = await verifyLiteRuntimeDatabase(temp.path);
    assert.equal(invalidControlPayload.ok, false);
    assert.equal(invalidControlPayload.integrity_findings.learning_episode_ledger_invalid, 1);
    mutateAppendOnlyTable(database.db, "lite_learning_control_jobs", () => {
      database.db.prepare(
        `UPDATE lite_learning_control_jobs
         SET payload_json = ?, payload_sha256 = ?
         WHERE job_id = 'control-expired-lease'`,
      ).run(controlPayload.json, controlPayload.sha256);
    });

    mutateAppendOnlyTable(database.db, "lite_learning_control_jobs", () => {
      database.db.prepare(
        `UPDATE lite_learning_control_jobs
         SET lease_expires_at = 'zzz'
         WHERE job_id = 'control-expired-lease'`,
      ).run();
    });
    const invalidControlLeaseTime = await verifyLiteRuntimeDatabase(temp.path);
    assert.equal(invalidControlLeaseTime.ok, false);
    assert.equal(invalidControlLeaseTime.integrity_findings.learning_episode_ledger_invalid, 1);
    mutateAppendOnlyTable(database.db, "lite_learning_control_jobs", () => {
      database.db.prepare(
        `UPDATE lite_learning_control_jobs
         SET lease_expires_at = '2026-07-13T05:00:00.000Z'
         WHERE job_id = 'control-expired-lease'`,
      ).run();
    });
    assert.equal((await verifyLiteRuntimeDatabase(temp.path)).ok, true);

    const backupPath = path.join(temp.directory, "learning-state.backup.sqlite");
    const restoredPath = path.join(temp.directory, "learning-state.restored.sqlite");
    const backup = await backupLiteRuntimeDatabase({
      sourcePath: temp.path,
      destinationPath: backupPath,
    });
    assert.equal(backup.verification.ok, true);
    assert.equal(backup.manifest.learning_table_counts?.lite_learning_control_jobs, 2);
    const restored = await restoreLiteRuntimeDatabase({
      backupPath,
      destinationPath: restoredPath,
    });
    assert.equal(restored.verification.counts.learning_control_dead_letters, 1);
    assert.equal(restored.verification.learning.reclaimable_expired_control_job_leases, 1);
    assert.equal(
      (database.db.prepare("SELECT COUNT(*) AS count FROM lite_learning_episode_events").get() as { count: number }).count,
      4,
    );
  } finally {
    await writeStore?.close();
    await database.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("external reservation and ticket consumption bind one runner while signed facts fail closed", async () => {
  const temp = tempDatabase("external-prefix");
  const database = createLiteRuntimeDatabase(temp.path);
  let writeStore: ReturnType<typeof createLiteWriteStoreFromDatabase> | null = null;
  try {
    writeStore = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
    const ledger = createLiteLearningEpisodeLedgerAccess(database);
    const retryPolicy = canonicalJson({ contract_version: "test-retry-policy-v1", max_attempts: 1 });
    const inputManifest = canonicalJson({ contract_version: "test-input-manifest-v1", source: "sealed" });
    const runnerPrincipalSha256 = sha256("external-runner-principal-a");
    const reservationBase = authorityRow("lite_learning_external_run_reservations", {
      tenant_id: "tenant-a",
      reservation_id: "reservation-external-a",
      artifact_kind: "production_shadow_gate",
      evidence_series_id: "series-external-a",
      task_family: "runtime-learning",
      candidate_policy_id: "candidate-a",
      candidate_policy_version: "v1",
      candidate_policy_implementation_sha256: sha256("candidate-implementation-a"),
      candidate_policy_config_sha256: sha256("candidate-config-a"),
      applicable_experiment_id: "experiment-a",
      applicable_experiment_revision: 1,
      gate_policy_id: "gate-a",
      gate_policy_version: "v1",
      gate_policy_config_sha256: sha256("gate-config-a"),
      applicability_manifest_sha256: sha256("applicability-a"),
      harness_bundle_sha256: sha256("harness-a"),
      source_snapshot_sha256: sha256("source-snapshot-a"),
      case_set_sha256: null,
      holdout_membership_projection_sha256: null,
      sealed_holdout_ref_sha256: null,
      sealed_holdout_ciphertext_sha256: null,
      execution_profile_sha256: sha256("execution-profile-a"),
      model_identity_sha256: sha256("model-identity-a"),
      immutable_model_snapshot_sha256: null,
      tool_manifest_sha256: null,
      execution_order_sha256: null,
      retry_policy_sha256: retryPolicy.sha256,
      retry_policy_json: retryPolicy.json,
      immutable_input_manifest_sha256: inputManifest.sha256,
      immutable_input_manifest_json: inputManifest.json,
      expected_runner_principal_sha256: runnerPrincipalSha256,
      credential_broker_policy_sha256: sha256("broker-policy-a"),
      service_launcher_policy_sha256: sha256("launcher-policy-a"),
      service_launcher_binary_sha256: sha256("launcher-binary-a"),
      service_launcher_key_id: "launcher-key-a",
      supervisor_executable_sha256: sha256("supervisor-executable-a"),
      supervisor_argv_policy_sha256: sha256("supervisor-argv-policy-a"),
      supervisor_sandbox_policy_sha256: sha256("supervisor-sandbox-a"),
      credential_session_class: "eligible_host_adapter",
      run_id: "run-external-a",
      reserve_operation_id: "operation-reserve-external-a",
      runner_ticket_sha256: sha256("runner-ticket-a"),
      reservation_sha256: "0".repeat(64),
      reserved_at: "2026-07-13T00:00:00.000Z",
    });
    const reservation = {
      ...reservationBase,
      reservation_sha256: learningExternalRunReservationDigest(reservationBase),
    } satisfies LiteLearningAuthorityRow;
    await assert.rejects(
      database.transaction.run(async () => await ledger.insertAuthorityFact(
        "lite_learning_external_run_reservations",
        { ...reservation, reservation_sha256: sha256("forged-reservation-record") },
      )),
      /reservation record digest mismatch/,
    );
    await database.transaction.run(async () => await ledger.insertAuthorityFact(
      "lite_learning_external_run_reservations",
      reservation,
    ));

    const consumptionBase = authorityRow("lite_learning_external_ticket_consumptions", {
      tenant_id: "tenant-a",
      consumption_id: "consumption-external-a",
      reservation_id: reservation.reservation_id,
      runner_ticket_sha256: reservation.runner_ticket_sha256,
      runner_principal_sha256: runnerPrincipalSha256,
      broker_process_nonce_sha256: sha256("broker-process-nonce-a"),
      consume_operation_id: "operation-consume-external-a",
      consumed_at: "2026-07-13T00:01:00.000Z",
      consumption_sha256: "0".repeat(64),
    });
    const consumption = {
      ...consumptionBase,
      consumption_sha256: learningExternalTicketConsumptionDigest(consumptionBase),
    } satisfies LiteLearningAuthorityRow;
    await assert.rejects(
      database.transaction.run(async () => await ledger.insertAuthorityFact(
        "lite_learning_external_ticket_consumptions",
        { ...consumption, runner_principal_sha256: sha256("wrong-runner") },
      )),
      /consumption reservation mismatch/,
    );
    await assert.rejects(
      database.transaction.run(async () => await ledger.insertAuthorityFact(
        "lite_learning_external_ticket_consumptions",
        { ...consumption, consumption_sha256: sha256("forged-consumption-record") },
      )),
      /consumption record digest mismatch/,
    );
    await database.transaction.run(async () => await ledger.insertAuthorityFact(
      "lite_learning_external_ticket_consumptions",
      consumption,
    ));

    const claim = authorityRow("lite_learning_external_run_claims", {
      tenant_id: "tenant-a",
      claim_id: "claim-external-a",
      reservation_id: reservation.reservation_id,
      ticket_consumption_id: consumption.consumption_id,
      ticket_consumption_sha256: consumption.consumption_sha256,
      runner_principal_sha256: runnerPrincipalSha256,
      runner_execution_nonce_sha256: sha256("runner-execution-nonce-a"),
      credential_broker_receipt_sha256: sha256("broker-claim-receipt-a"),
      credential_broker_policy_sha256: reservation.credential_broker_policy_sha256,
      credential_broker_binary_sha256: sha256("broker-binary-a"),
      credential_broker_key_id: "broker-key-a",
      credential_broker_receipt_json: stableStringify({ contract_version: "test-broker-claim-v1" }),
      credential_broker_receipt_signature: "s".repeat(64),
      credential_session_id_sha256: sha256("credential-session-a"),
      supervisor_bind_expires_at: "2026-07-13T00:06:00.000Z",
      credential_session_expires_at: "2026-07-13T01:01:00.000Z",
      credential_session_heartbeat_seconds: 10,
      credential_session_max_calls: 100,
      claim_operation_id: "operation-claim-external-a",
      claimed_at: "2026-07-13T00:02:00.000Z",
      claim_sha256: sha256("claim-record-a"),
    });
    await assert.rejects(
      database.transaction.run(async () => await ledger.insertAuthorityFact(
        "lite_learning_external_run_claims",
        claim,
      )),
      /protected Task 8 external receipt verifier/,
    );
    for (const table of [
      "lite_learning_external_preclaim_holds",
      "lite_learning_external_supervisor_bindings",
      "lite_learning_external_session_terminations",
    ] as const) {
      await assert.rejects(
        database.transaction.run(async () => await ledger.insertAuthorityFact(
          table,
          authorityRow(table, { tenant_id: "tenant-a" }),
        )),
        /protected Task 8 external receipt verifier/,
      );
    }
    const consumptionReplay = await database.transaction.run(
      async () => await ledger.insertAuthorityFact(
        "lite_learning_external_ticket_consumptions",
        consumption,
      ),
    );
    assert.equal(consumptionReplay.replayed, true);
    await ledger.verifyIntegrity();
    const claimColumns = LITE_LEARNING_LEDGER_REQUIRED_COLUMNS.lite_learning_external_run_claims
      .filter((column) => column !== "row_id");
    database.db.prepare(
      `INSERT INTO lite_learning_external_run_claims
       (${claimColumns.join(", ")})
       VALUES (${claimColumns.map(() => "?").join(", ")})`,
    ).run(...claimColumns.map((column) => claim[column]));
    await assert.rejects(
      ledger.verifyIntegrity(),
      /unverified_external_authority_fact/,
    );
    await assert.rejects(
      writeStore.close(),
      /unverified_external_authority_fact/,
    );
    writeStore = null;
  } finally {
    await writeStore?.close();
    await database.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("gate evaluation supersession is immediate and cannot cross an experiment series", async () => {
  const temp = tempDatabase("gate-predecessor");
  const database = createLiteRuntimeDatabase(temp.path);
  let writeStore: ReturnType<typeof createLiteWriteStoreFromDatabase> | null = null;
  try {
    writeStore = createLiteWriteStoreFromDatabase(database, {
      annProjectionEnabled: false,
      authorityReceiptKeyring: storeCloseKeyring(),
    });
    const ledger = createLiteLearningEpisodeLedgerAccess(database, {
      authorityReceiptKeyring: storeCloseKeyring(),
    });
    const fixture = confirmatoryFixture(await ledger.databaseInstanceId());
    await database.transaction.run(async () => {
      await ledger.insertPolicyVersion(fixture.candidate);
      await ledger.insertPolicyVersion(fixture.gate);
      await ledger.provisionConfirmatorySet(fixture);
    });
    const firstCutoff = legacyExposureFixture();
    await database.transaction.run(async () => await ledger.appendEpisodeEvent({
      row: firstCutoff.row,
      event: firstCutoff.event,
      payload: firstCutoff.payload,
      exposureItems: [firstCutoff.item],
    }));
    const secondItem = {
      ...firstCutoff.item,
      memory_id: "memory-gate-cutoff-b",
    } satisfies LearningLedgerItem;
    const secondPayload = {
      ...firstCutoff.payload,
      guide_trace_id: "guide-gate-cutoff-b",
      guide_receipt_sha256: sha256("guide-gate-cutoff-b"),
      guide_commit_id: "commit-gate-cutoff-b",
      request_sha256: sha256("request-gate-cutoff-b"),
      relevant_memory_ids: [secondItem.memory_id],
    } satisfies ExposureCommittedV1;
    const secondPayloadEncoded = canonicalJson(secondPayload);
    const secondEvent: EventWithoutDigest = {
      ...firstCutoff.event,
      event_id: "event-gate-cutoff-b",
      episode_id: learningEpisodeId({
        tenantId: "tenant-a",
        scope: "scope-a",
        guideTraceId: secondPayload.guide_trace_id,
      }),
      source_id: secondPayload.guide_trace_id,
      source_sha256: secondPayload.guide_receipt_sha256,
      payload_sha256: secondPayloadEncoded.sha256,
      item_set_sha256: learningItemSetDigest([secondItem]),
      source_commit_id: secondPayload.guide_commit_id,
      recorded_at: "2026-07-14T00:00:00.000Z",
    };
    await database.transaction.run(async () => await ledger.appendEpisodeEvent({
      row: episodeEventRow(secondEvent, secondPayload),
      event: secondEvent,
      payload: secondPayload,
      exposureItems: [secondItem],
    }));

    const buildGateBundle = async (args: {
      decisionId: string;
      lookIndex: 1 | 2;
      priorArtifactHeads?: readonly LiteLearningGateArtifactSetMember[];
      supersedesDecisionId: string | null;
      supersedesArtifactId: string | null;
    }) => {
      const lookContext = deriveLiteLearningLookAuthorityContext(database.db, {
        tenantId: "tenant-a",
        experimentId: String(fixture.revision.experiment_id),
        experimentRevision: Number(fixture.revision.experiment_revision),
        lookIndex: args.lookIndex,
      });
      const analysisAt = lookContext.cutoff.recorded_at;
      const evidenceScopeSetSha256 = sha256("evidence-scope-confirmatory-a");
      const artifactRow = { row_id: lookContext.cutoff.artifact_row_id + 1 };
      const priorArtifactHeads = args.priorArtifactHeads ?? [];
      const proposalBase = {
        contract_version: "learning_look_proposal_v1" as const,
        tenant_id: "tenant-a",
        confirmatory_attempt_id: String(fixture.attempt.confirmatory_attempt_id),
        experiment_id: String(fixture.revision.experiment_id),
        experiment_revision: Number(fixture.revision.experiment_revision),
        experiment_config_sha256: String(fixture.revision.config_sha256),
        task_family: String(fixture.attempt.task_family),
        candidate_policy_id: fixture.candidate.policy_id,
        candidate_policy_version: fixture.candidate.policy_version,
        candidate_policy_config_sha256: String(fixture.candidate.policy_config_sha256),
        candidate_policy_implementation_sha256: String(fixture.candidate.implementation_contract_sha256),
        gate_policy_id: fixture.gate.policy_id,
        gate_policy_version: fixture.gate.policy_version,
        gate_policy_config_sha256: String(fixture.gate.policy_config_sha256),
        gate_policy_implementation_sha256: String(fixture.gate.implementation_contract_sha256),
        look_index: args.lookIndex,
        target_cumulative_pair_count: lookContext.target_cumulative_pair_count,
        checkpoint_kind: lookContext.checkpoint_kind,
        cutoff: lookContext.cutoff,
      };
      const outcomeRedactedAuthorityProjection =
        buildLearningOutcomeRedactedAuthorityProjection(database.db, proposalBase);
      assert.equal(
        outcomeRedactedAuthorityProjection.required_artifact_heads_sha256,
        learningRequiredArtifactHeadsDigest(priorArtifactHeads),
      );
      const proposal = {
        ...proposalBase,
        outcome_redacted_authority_projection: outcomeRedactedAuthorityProjection,
        outcome_redacted_authority_projection_sha256:
          learningOutcomeRedactedAuthorityProjectionDigest(outcomeRedactedAuthorityProjection),
      };
      const proposalSha256 = learningLookProposalDigest(proposal);
      const generated = await verifyLiteRuntimeLearningArtifact({
        path: temp.path,
        proposal,
      });
      assert.equal(generated.report.integrity_status, "passed");
      assert.equal(generated.report.proposal_sha256, proposalSha256);
      const report = canonicalJson(generated.report);
      if (args.lookIndex === 1) {
        assert.equal(generated.report.verifier_id, "aionis_lite_learning_ledger_replay");
        assert.equal(generated.report.verifier_version, 1);
        assert.equal(generated.report.findings.length, 12);
        assert.equal(generated.report.findings.every((finding) => finding.count === 0), true);

        const proposalPath = path.join(temp.directory, "look-1.proposal.json");
        const artifactPath = path.join(temp.directory, "look-1.runtime-integrity.json");
        fs.writeFileSync(proposalPath, `${stableStringify(proposal)}\n`, { flag: "wx" });
        const cli = spawnSync(
          process.execPath,
          [
            "--import", "tsx", DATA_OPS_CLI, "verify", "--db", temp.path,
            "--learning-proposal", proposalPath,
            "--learning-artifact-out", artifactPath,
          ],
          { cwd: ROOT, encoding: "utf8" },
        );
        assert.equal(cli.status, 0, cli.stderr);
        const cliResult = JSON.parse(cli.stdout) as {
          report_sha256: string;
          report: Record<string, unknown>;
          artifact_path: string;
        };
        assert.equal(cliResult.report_sha256, generated.report_sha256);
        assert.deepEqual(cliResult.report, generated.report);
        assert.equal(cliResult.artifact_path, artifactPath);
        assert.equal(fs.readFileSync(artifactPath, "utf8"), stableStringify(generated.report));

        const replayToSamePath = spawnSync(
          process.execPath,
          [
            "--import", "tsx", DATA_OPS_CLI, "verify", "--db", temp.path,
            "--learning-proposal", proposalPath,
            "--learning-artifact-out", artifactPath,
          ],
          { cwd: ROOT, encoding: "utf8" },
        );
        assert.equal(replayToSamePath.status, 1);
        assert.match(replayToSamePath.stderr, /EEXIST/);

        const wrongProjection = {
          ...proposal.outcome_redacted_authority_projection,
          database_instance_id: sha256("wrong-runtime-integrity-database"),
        };
        const wrongProposal = {
          ...proposal,
          outcome_redacted_authority_projection: wrongProjection,
          outcome_redacted_authority_projection_sha256:
            learningOutcomeRedactedAuthorityProjectionDigest(wrongProjection),
        };
        const rejected = await verifyLiteRuntimeLearningArtifact({
          path: temp.path,
          proposal: wrongProposal,
        });
        assert.equal(rejected.report.integrity_status, "failed");
        assert.equal(
          rejected.report.findings.find((finding) => finding.code === "cutoff_projection_integrity")?.count,
          1,
        );
      }
      const artifact = authorityRow("lite_learning_evidence_artifacts", {
        tenant_id: "tenant-a",
        artifact_id: `runtime-integrity-artifact-${args.lookIndex}`,
        artifact_kind: "runtime_integrity_gate",
        evidence_series_id: "runtime-integrity",
        external_run_reservation_id: null,
        external_ticket_consumption_id: null,
        external_run_claim_id: null,
        external_supervisor_binding_id: null,
        external_session_termination_id: null,
        supersedes_artifact_id: args.supersedesArtifactId,
        artifact_status: "passed",
        task_family: fixture.attempt.task_family,
        candidate_policy_id: fixture.candidate.policy_id,
        candidate_policy_version: fixture.candidate.policy_version,
        candidate_policy_implementation_sha256: fixture.candidate.implementation_contract_sha256,
        candidate_policy_config_sha256: fixture.candidate.policy_config_sha256,
        applicable_experiment_id: fixture.revision.experiment_id,
        applicable_experiment_revision: fixture.revision.experiment_revision,
        source_experiment_id: fixture.revision.experiment_id,
        source_experiment_revision: fixture.revision.experiment_revision,
        source_serving_phase: "active_control",
        look_index: args.lookIndex,
        look_proposal_sha256: proposalSha256,
        gate_policy_id: fixture.gate.policy_id,
        gate_policy_version: fixture.gate.policy_version,
        gate_policy_config_sha256: fixture.gate.policy_config_sha256,
        evidence_scope_set_sha256: evidenceScopeSetSha256,
        source_bundle_sha256: sha256(`integrity-source-${args.lookIndex}`),
        harness_bundle_sha256: sha256(`integrity-harness-${args.lookIndex}`),
        report_sha256: report.sha256,
        report_json: report.json,
        source_ref: `runtime-integrity/look-${args.lookIndex}`,
        source_commit_id: null,
        collected_at: analysisAt,
        ingested_at: analysisAt,
        created_by: "test-gate",
      });

      const triggerBasis = canonicalJson({
        contract_version: "test-gate-trigger-basis-v1",
        look_index: args.lookIndex,
        outcome_redacted: true,
      });
      const targetPairCount = args.lookIndex === 1 ? 96 : 192;
      const artifactHead = {
        artifact_role: "runtime_integrity",
        role_ordinal: 0,
        evidence_series_id: String(artifact.evidence_series_id),
        artifact_id: String(artifact.artifact_id),
        report_sha256: String(artifact.report_sha256),
      } as const;
      const reservationBase = authorityRow("lite_learning_gate_look_reservations", {
        tenant_id: "tenant-a",
        reservation_id: `look-reservation-${args.lookIndex}`,
        operation_id: `operation-look-reservation-${args.lookIndex}`,
        task_family: fixture.attempt.task_family,
        candidate_policy_id: fixture.candidate.policy_id,
        candidate_policy_version: fixture.candidate.policy_version,
        candidate_policy_implementation_sha256: fixture.candidate.implementation_contract_sha256,
        experiment_id: fixture.revision.experiment_id,
        experiment_revision: fixture.revision.experiment_revision,
        gate_policy_id: fixture.gate.policy_id,
        gate_policy_version: fixture.gate.policy_version,
        gate_policy_config_sha256: fixture.gate.policy_config_sha256,
        look_schedule_sha256: learningGateLookScheduleDigest(),
        randomization_pair_manifest_sha256: fixture.revision.randomization_pair_manifest_sha256,
        activation_schedule_sha256: fixture.revision.activation_schedule_sha256,
        look_index: args.lookIndex,
        target_cumulative_pair_count: targetPairCount,
        analysis_at: analysisAt,
        evidence_cutoff_event_row_id: lookContext.cutoff.event_row_id,
        evidence_artifact_cutoff_row_id: artifactRow.row_id,
        candidate_scheduled_namespace_count: targetPairCount,
        control_scheduled_namespace_count: targetPairCount,
        candidate_index_exposure_count: 0,
        control_index_exposure_count: 0,
        candidate_no_index_count: targetPairCount,
        control_no_index_count: targetPairCount,
        candidate_verified_receipt_count: 0,
        control_verified_receipt_count: 0,
        runtime_integrity_artifact_id: artifact.artifact_id,
        runtime_integrity_report_sha256: artifact.report_sha256,
        runtime_integrity_run_bundle_sha256: artifact.source_bundle_sha256,
        required_artifact_heads_sha256: learningRequiredArtifactHeadsDigest([artifactHead]),
        trigger_basis_sha256: triggerBasis.sha256,
        trigger_basis_json: triggerBasis.json,
        reservation_sha256: "0".repeat(64),
        created_by: "test-gate",
        created_at: analysisAt,
      });
      const reservation = {
        ...reservationBase,
        reservation_sha256: learningGateLookReservationDigest(reservationBase),
      } satisfies LiteLearningAuthorityRow;
      if (args.lookIndex === 1) {
        await assert.rejects(
          database.transaction.run(async () => await ledger.insertAuthorityFact(
            "lite_learning_evidence_artifacts",
            artifact,
          )),
          /atomic reserveGateLook/,
        );
        await assert.rejects(
          database.transaction.run(async () => await ledger.insertAuthorityFact(
            "lite_learning_gate_look_reservations",
            reservation,
          )),
          /atomic reserveGateLook/,
        );
        await assert.rejects(
          database.transaction.run(async () => await ledger.reserveGateLook({
            artifact: { ...artifact, artifact_status: "failed" },
            reservation,
          })),
          /requires a passing artifact/,
        );
        const failedReport = canonicalJson({
          ...(JSON.parse(report.json) as Record<string, unknown>),
          integrity_status: "failed",
          findings: generated.report.findings.map((finding, index) => index === 0
            ? {
              ...finding,
              severity: "error",
              count: 1,
              evidence_sha256: sha256("failed-runtime-integrity-finding"),
            }
            : finding),
        });
        await assert.rejects(
          database.transaction.run(async () => await ledger.reserveGateLook({
            artifact: {
              ...artifact,
              report_sha256: failedReport.sha256,
              report_json: failedReport.json,
            },
            reservation,
          })),
          /requires a passing report/,
        );
        const wrongTaskFamily = "forged-task-family";
        const wrongTaskProposal = {
          ...proposal,
          task_family: wrongTaskFamily,
        };
        const wrongTaskProposalSha256 = learningLookProposalDigest(wrongTaskProposal);
        const {
          contract_version: _wrongTaskProposalContract,
          ...wrongTaskReportProposal
        } = wrongTaskProposal;
        const wrongTaskReport = canonicalJson({
          ...wrongTaskReportProposal,
          contract_version: "runtime_integrity_gate_report_v1",
          proposal_sha256: wrongTaskProposalSha256,
          verifier_id: "aionis_lite_learning_ledger_replay",
          verifier_version: 1,
          integrity_status: "passed",
          findings: generated.report.findings,
        });
        const wrongTaskArtifact = {
          ...artifact,
          artifact_id: `${String(artifact.artifact_id)}-wrong-task`,
          task_family: wrongTaskFamily,
          look_proposal_sha256: wrongTaskProposalSha256,
          report_sha256: wrongTaskReport.sha256,
          report_json: wrongTaskReport.json,
        } satisfies LiteLearningAuthorityRow;
        const wrongTaskReservationBase = {
          ...reservation,
          reservation_id: `${String(reservation.reservation_id)}-wrong-task`,
          operation_id: `${String(reservation.operation_id)}-wrong-task`,
          task_family: wrongTaskFamily,
          runtime_integrity_artifact_id: wrongTaskArtifact.artifact_id,
          runtime_integrity_report_sha256: wrongTaskArtifact.report_sha256,
          reservation_sha256: "0".repeat(64),
        } satisfies LiteLearningAuthorityRow;
        const wrongTaskReservation = {
          ...wrongTaskReservationBase,
          reservation_sha256: learningGateLookReservationDigest(wrongTaskReservationBase),
        } satisfies LiteLearningAuthorityRow;
        await assert.rejects(
          database.transaction.run(async () => await ledger.reserveGateLook({
            artifact: wrongTaskArtifact,
            reservation: wrongTaskReservation,
          })),
          /report authority binding mismatch/,
        );
        assert.equal(
          (database.db.prepare(
            "SELECT COUNT(*) AS count FROM lite_learning_evidence_artifacts WHERE artifact_id = ?",
          ).get(wrongTaskArtifact.artifact_id) as { count: number }).count,
          0,
        );
        assert.equal(
          (database.db.prepare(
            "SELECT COUNT(*) AS count FROM lite_learning_gate_look_reservations WHERE reservation_id = ?",
          ).get(wrongTaskReservation.reservation_id) as { count: number }).count,
          0,
        );
        const wrongReservationTaskBase = {
          ...reservation,
          task_family: wrongTaskFamily,
          reservation_sha256: "0".repeat(64),
        } satisfies LiteLearningAuthorityRow;
        const wrongReservationTask = {
          ...wrongReservationTaskBase,
          reservation_sha256: learningGateLookReservationDigest(wrongReservationTaskBase),
        } satisfies LiteLearningAuthorityRow;
        await assert.rejects(
          database.transaction.run(async () => await ledger.reserveGateLook({
            artifact,
            reservation: wrongReservationTask,
          })),
          /artifact binding mismatch/,
        );
        assert.equal(
          (database.db.prepare(
            "SELECT COUNT(*) AS count FROM lite_learning_evidence_artifacts WHERE artifact_id = ?",
          ).get(artifact.artifact_id) as { count: number }).count,
          0,
        );
        const currentEventHead = database.db.prepare(
          "SELECT COALESCE(MAX(row_id), 0) AS row_id FROM lite_learning_episode_events",
        ).get() as { row_id: number };
        const futureEventCutoff = currentEventHead.row_id + 1;
        const futureCutoffProjection = {
          ...outcomeRedactedAuthorityProjection,
          event_cutoff_row_id: futureEventCutoff,
        };
        const futureCutoffProposal = {
          ...proposal,
          cutoff: {
            ...proposal.cutoff,
            event_row_id: futureEventCutoff,
          },
          outcome_redacted_authority_projection: futureCutoffProjection,
          outcome_redacted_authority_projection_sha256:
            learningOutcomeRedactedAuthorityProjectionDigest(futureCutoffProjection),
        };
        const futureCutoffProposalSha256 = learningLookProposalDigest(futureCutoffProposal);
        const {
          contract_version: _futureCutoffProposalContract,
          ...futureCutoffReportProposal
        } = futureCutoffProposal;
        const futureCutoffReport = canonicalJson({
          ...futureCutoffReportProposal,
          contract_version: "runtime_integrity_gate_report_v1",
          proposal_sha256: futureCutoffProposalSha256,
          verifier_id: "aionis_lite_learning_ledger_replay",
          verifier_version: 1,
          integrity_status: "passed",
          findings: generated.report.findings,
        });
        const futureCutoffArtifact = {
          ...artifact,
          artifact_id: `${String(artifact.artifact_id)}-future-cutoff`,
          look_proposal_sha256: futureCutoffProposalSha256,
          report_sha256: futureCutoffReport.sha256,
          report_json: futureCutoffReport.json,
        } satisfies LiteLearningAuthorityRow;
        const futureCutoffArtifactHead = {
          ...artifactHead,
          artifact_id: String(futureCutoffArtifact.artifact_id),
          report_sha256: String(futureCutoffArtifact.report_sha256),
        };
        const futureCutoffReservationBase = {
          ...reservation,
          reservation_id: `${String(reservation.reservation_id)}-future-cutoff`,
          operation_id: `${String(reservation.operation_id)}-future-cutoff`,
          evidence_cutoff_event_row_id: futureEventCutoff,
          runtime_integrity_artifact_id: futureCutoffArtifact.artifact_id,
          runtime_integrity_report_sha256: futureCutoffArtifact.report_sha256,
          required_artifact_heads_sha256:
            learningRequiredArtifactHeadsDigest([futureCutoffArtifactHead]),
          reservation_sha256: "0".repeat(64),
        } satisfies LiteLearningAuthorityRow;
        const futureCutoffReservation = {
          ...futureCutoffReservationBase,
          reservation_sha256: learningGateLookReservationDigest(futureCutoffReservationBase),
        } satisfies LiteLearningAuthorityRow;
        await assert.rejects(
          database.transaction.run(async () => await ledger.reserveGateLook({
            artifact: futureCutoffArtifact,
            reservation: futureCutoffReservation,
          })),
          /cutoff exceeds the current event ledger head/,
        );
        assert.equal(
          (database.db.prepare(
            "SELECT COUNT(*) AS count FROM lite_learning_evidence_artifacts WHERE artifact_id = ?",
          ).get(futureCutoffArtifact.artifact_id) as { count: number }).count,
          0,
        );
        assert.equal(
          (database.db.prepare(
            "SELECT COUNT(*) AS count FROM lite_learning_gate_look_reservations WHERE reservation_id = ?",
          ).get(futureCutoffReservation.reservation_id) as { count: number }).count,
          0,
        );
        const staleEventCutoff = Number(proposal.cutoff.event_row_id) - 1;
        assert.equal(staleEventCutoff >= 1, true);
        const staleCutoffProjection = {
          ...outcomeRedactedAuthorityProjection,
          event_cutoff_row_id: staleEventCutoff,
        };
        const staleCutoffProposal = {
          ...proposal,
          cutoff: { ...proposal.cutoff, event_row_id: staleEventCutoff },
          outcome_redacted_authority_projection: staleCutoffProjection,
          outcome_redacted_authority_projection_sha256:
            learningOutcomeRedactedAuthorityProjectionDigest(staleCutoffProjection),
        };
        const staleCutoffProposalSha256 = learningLookProposalDigest(staleCutoffProposal);
        const { contract_version: _staleCutoffContract, ...staleCutoffReportProposal } =
          staleCutoffProposal;
        const staleCutoffReport = canonicalJson({
          ...staleCutoffReportProposal,
          contract_version: "runtime_integrity_gate_report_v1",
          proposal_sha256: staleCutoffProposalSha256,
          verifier_id: "aionis_lite_learning_ledger_replay",
          verifier_version: 1,
          integrity_status: "passed",
          findings: generated.report.findings,
        });
        const staleCutoffArtifact = {
          ...artifact,
          artifact_id: `${String(artifact.artifact_id)}-stale-cutoff`,
          look_proposal_sha256: staleCutoffProposalSha256,
          report_sha256: staleCutoffReport.sha256,
          report_json: staleCutoffReport.json,
        } satisfies LiteLearningAuthorityRow;
        const staleCutoffArtifactHead = {
          ...artifactHead,
          artifact_id: String(staleCutoffArtifact.artifact_id),
          report_sha256: String(staleCutoffArtifact.report_sha256),
        };
        const staleCutoffReservationBase = {
          ...reservation,
          reservation_id: `${String(reservation.reservation_id)}-stale-cutoff`,
          operation_id: `${String(reservation.operation_id)}-stale-cutoff`,
          evidence_cutoff_event_row_id: staleEventCutoff,
          runtime_integrity_artifact_id: staleCutoffArtifact.artifact_id,
          runtime_integrity_report_sha256: staleCutoffArtifact.report_sha256,
          required_artifact_heads_sha256:
            learningRequiredArtifactHeadsDigest([staleCutoffArtifactHead]),
          reservation_sha256: "0".repeat(64),
        } satisfies LiteLearningAuthorityRow;
        const staleCutoffReservation = {
          ...staleCutoffReservationBase,
          reservation_sha256: learningGateLookReservationDigest(staleCutoffReservationBase),
        } satisfies LiteLearningAuthorityRow;
        await assert.rejects(
          database.transaction.run(async () => await ledger.reserveGateLook({
            artifact: staleCutoffArtifact,
            reservation: staleCutoffReservation,
          })),
          /live authority projection mismatch/,
        );
        const forgedProjection = {
          ...outcomeRedactedAuthorityProjection,
          database_instance_id: sha256("wrong-database-instance"),
        };
        const forgedProposal = {
          ...proposal,
          outcome_redacted_authority_projection: forgedProjection,
          outcome_redacted_authority_projection_sha256:
            learningOutcomeRedactedAuthorityProjectionDigest(forgedProjection),
        };
        const forgedProposalSha256 = learningLookProposalDigest(forgedProposal);
        const { contract_version: _forgedProposalContract, ...forgedReportProposal } = forgedProposal;
        const forgedReport = canonicalJson({
          ...forgedReportProposal,
          contract_version: "runtime_integrity_gate_report_v1",
          proposal_sha256: forgedProposalSha256,
          verifier_id: "aionis_lite_learning_ledger_replay",
          verifier_version: 1,
          integrity_status: "passed",
          findings: generated.report.findings,
        });
        await assert.rejects(
          database.transaction.run(async () => await ledger.reserveGateLook({
            artifact: {
              ...artifact,
              look_proposal_sha256: forgedProposalSha256,
              report_sha256: forgedReport.sha256,
              report_json: forgedReport.json,
            },
            reservation,
          })),
          /live authority projection mismatch/,
        );
        const rebindReservation = (
          values: Partial<Record<string, string | number>>,
        ): LiteLearningAuthorityRow => {
          const reboundBase = {
            ...reservation,
            ...values,
            reservation_sha256: "0".repeat(64),
          } satisfies LiteLearningAuthorityRow;
          return {
            ...reboundBase,
            reservation_sha256: learningGateLookReservationDigest(reboundBase),
          } satisfies LiteLearningAuthorityRow;
        };
        for (const [values, expected] of [
          [{ look_index: 4 }, /look index is not registered/],
          [{ target_cumulative_pair_count: 192 }, /target or schedule digest/],
          [{ look_schedule_sha256: sha256("wrong-look-schedule") }, /target or schedule digest/],
          [{ analysis_at: "2026-08-04T00:00:00.000Z" }, /analysis time/],
        ] as const) {
          await assert.rejects(
            database.transaction.run(async () => await ledger.reserveGateLook({
              artifact,
              reservation: rebindReservation(values),
            })),
            expected,
          );
        }
        const invalidReservationBase = {
          ...reservation,
          evidence_artifact_cutoff_row_id: Number(reservation.evidence_artifact_cutoff_row_id) + 1,
          reservation_sha256: "0".repeat(64),
        } satisfies LiteLearningAuthorityRow;
        const invalidReservation = {
          ...invalidReservationBase,
          reservation_sha256: learningGateLookReservationDigest(invalidReservationBase),
        } satisfies LiteLearningAuthorityRow;
        await assert.rejects(
          database.transaction.run(async () => await ledger.reserveGateLook({
            artifact,
            reservation: invalidReservation,
          })),
          /artifact binding mismatch/,
        );
        await database.transaction.run(async () => {
          let caught = false;
          try {
            await ledger.reserveGateLook({ artifact, reservation: invalidReservation });
          } catch (error) {
            caught = true;
            assert.match(String(error), /artifact binding mismatch/);
          }
          assert.equal(caught, true);
        });
        assert.equal(
          (database.db.prepare(
            "SELECT COUNT(*) AS count FROM lite_learning_evidence_artifacts WHERE artifact_id = ?",
          ).get(artifact.artifact_id) as { count: number }).count,
          0,
        );
      }
      await database.transaction.run(async () => await ledger.reserveGateLook({ artifact, reservation }));

      const membershipBase = authorityRow("lite_learning_gate_artifact_memberships", {
        tenant_id: "tenant-a",
        decision_id: args.decisionId,
        artifact_id: artifact.artifact_id,
        artifact_role: "runtime_integrity",
        role_ordinal: 0,
        report_sha256: artifact.report_sha256,
        membership_sha256: "0".repeat(64),
      });
      const membership = {
        ...membershipBase,
        membership_sha256: learningGateArtifactMembershipDigest(membershipBase),
      } satisfies LiteLearningAuthorityRow;
      const evidenceSummary = canonicalJson({ look_index: args.lookIndex, verdict: "hold" });
      const decisionBase = authorityRow("lite_learning_gate_decisions", {
        tenant_id: "tenant-a",
        decision_id: args.decisionId,
        task_family: fixture.attempt.task_family,
        candidate_policy_id: fixture.candidate.policy_id,
        candidate_policy_version: fixture.candidate.policy_version,
        candidate_policy_implementation_sha256: fixture.candidate.implementation_contract_sha256,
        experiment_id: fixture.revision.experiment_id,
        experiment_revision: fixture.revision.experiment_revision,
        gate_policy_id: fixture.gate.policy_id,
        gate_policy_version: fixture.gate.policy_version,
        look_index: args.lookIndex,
        look_reservation_id: reservation.reservation_id,
        look_reservation_sha256: reservation.reservation_sha256,
        decision_kind: "evidence_evaluation",
        evidence_verdict: "hold",
        authority_action: null,
        authority_scope: "experiment_revision",
        analysis_at: reservation.analysis_at,
        evidence_cutoff_event_row_id: reservation.evidence_cutoff_event_row_id,
        evidence_artifact_cutoff_row_id: reservation.evidence_artifact_cutoff_row_id,
        evidence_artifact_count: 1,
        experiment_config_sha256: fixture.revision.config_sha256,
        evidence_scope_set_sha256: evidenceScopeSetSha256,
        evidence_cohort_sha256: sha256(`evidence-cohort-${args.lookIndex}`),
        evidence_artifact_set_sha256: learningGateArtifactSetDigest([artifactHead]),
        evidence_summary_sha256: evidenceSummary.sha256,
        evidence_summary_json: evidenceSummary.json,
        decision_sha256: "0".repeat(64),
        trigger_ref_kind: null,
        trigger_ref_id: null,
        trigger_episode_id: null,
        supersedes_decision_id: args.supersedesDecisionId,
        basis_evidence_decision_id: null,
        authority_mutation_id: null,
        source_commit_id: null,
        adjudication_observed_event_head_row_id: null,
        adjudication_observed_artifact_head_row_id: null,
        post_cutoff_safety_sha256: null,
        authorization_kind: "none",
        authorization_sha256: null,
        authorization_payload_json: null,
        authorization_mac: null,
        authorization_nonce: null,
        authorization_expires_at: null,
        authorization_key_id: null,
        approved_by: null,
        authority_operation_id: null,
        authority_operation_scope: null,
        authority_operation_kind: null,
        created_by: "test-gate",
        created_at: analysisAt,
      });
      const decision = {
        ...decisionBase,
        decision_sha256: learningGateDecisionDigest(decisionBase),
      } satisfies LiteLearningAuthorityRow;
      return {
        artifact,
        artifactHeads: [artifactHead] as const,
        decision,
        memberships: [membership] as const,
        proposal,
        reservation,
      };
    };

    const look1 = await buildGateBundle({
      decisionId: "decision-look-1",
      lookIndex: 1,
      supersedesDecisionId: null,
      supersedesArtifactId: null,
    });
    const repeatedLook1 = await verifyLiteRuntimeLearningArtifact({
      path: temp.path,
      proposal: look1.proposal,
    });
    assert.equal(repeatedLook1.report.integrity_status, "failed");
    assert.equal(
      repeatedLook1.report.findings.find((finding) => finding.code === "cutoff_projection_integrity")?.count,
      1,
    );
    const prematureLook2Context = deriveLiteLearningLookAuthorityContext(database.db, {
      tenantId: "tenant-a",
      experimentId: String(fixture.revision.experiment_id),
      experimentRevision: Number(fixture.revision.experiment_revision),
      lookIndex: 2,
    });
    const prematureLook2Base = {
      ...look1.proposal,
      look_index: 2 as const,
      target_cumulative_pair_count: prematureLook2Context.target_cumulative_pair_count,
      checkpoint_kind: prematureLook2Context.checkpoint_kind,
      cutoff: prematureLook2Context.cutoff,
    };
    const prematureLook2Projection = buildLearningOutcomeRedactedAuthorityProjection(
      database.db,
      prematureLook2Base,
    );
    const prematureLook2Proposal = {
      ...prematureLook2Base,
      outcome_redacted_authority_projection: prematureLook2Projection,
      outcome_redacted_authority_projection_sha256:
        learningOutcomeRedactedAuthorityProjectionDigest(prematureLook2Projection),
    };
    const prematureLook2 = await verifyLiteRuntimeLearningArtifact({
      path: temp.path,
      proposal: prematureLook2Proposal,
    });
    assert.equal(prematureLook2.report.integrity_status, "failed");
    assert.equal(
      prematureLook2.report.findings.find((finding) => finding.code === "cutoff_projection_integrity")?.count,
      1,
    );
    await assert.rejects(
      database.transaction.run(async () => await ledger.insertAuthorityFact(
        "lite_learning_gate_decisions",
        look1.decision,
      )),
      /require atomic insertGateEvidenceEvaluation/,
    );
    await assert.rejects(
      database.transaction.run(async () => await ledger.insertGateEvidenceEvaluation({
        decision: look1.decision,
        memberships: [],
      })),
      /exact bounded artifact membership count/,
    );
    const wrongRoleBase = {
      ...look1.memberships[0],
      artifact_role: "offline_primary",
      membership_sha256: "0".repeat(64),
    } satisfies LiteLearningAuthorityRow;
    const wrongRole = {
      ...wrongRoleBase,
      membership_sha256: learningGateArtifactMembershipDigest(wrongRoleBase),
    } satisfies LiteLearningAuthorityRow;
    await assert.rejects(
      database.transaction.run(async () => await ledger.insertGateEvidenceEvaluation({
        decision: look1.decision,
        memberships: [wrongRole],
      })),
      /preregistered cutoff head/,
    );
    const wrongSetBase = {
      ...look1.decision,
      evidence_artifact_set_sha256: sha256("wrong-artifact-set"),
      decision_sha256: "0".repeat(64),
    } satisfies LiteLearningAuthorityRow;
    const wrongSetDecision = {
      ...wrongSetBase,
      decision_sha256: learningGateDecisionDigest(wrongSetBase),
    } satisfies LiteLearningAuthorityRow;
    await assert.rejects(
      database.transaction.run(async () => await ledger.insertGateEvidenceEvaluation({
        decision: wrongSetDecision,
        memberships: look1.memberships,
      })),
      /artifact-set digest mismatch/,
    );
    const actionableBase = {
      ...look1.decision,
      evidence_verdict: "promotion_ready",
      decision_sha256: "0".repeat(64),
    } satisfies LiteLearningAuthorityRow;
    const actionableDecision = {
      ...actionableBase,
      decision_sha256: learningGateDecisionDigest(actionableBase),
    } satisfies LiteLearningAuthorityRow;
    await assert.rejects(
      database.transaction.run(async () => await ledger.insertGateEvidenceEvaluation({
        decision: actionableDecision,
        memberships: look1.memberships,
      })),
      /requires all four preregistered artifact heads/,
    );
    const look1ReservationReplay = await database.transaction.run(
      async () => await ledger.reserveGateLook({
        artifact: look1.artifact,
        reservation: look1.reservation,
      }),
    );
    assert.equal(look1ReservationReplay.replayed, true);
    await database.transaction.run(async () => await ledger.insertGateEvidenceEvaluation(look1));

    const look2 = await buildGateBundle({
      decisionId: "decision-look-2",
      lookIndex: 2,
      priorArtifactHeads: look1.artifactHeads,
      supersedesDecisionId: "decision-look-1",
      supersedesArtifactId: "runtime-integrity-artifact-1",
    });
    const rebindDecision = (
      source: typeof look2,
      values: Partial<Record<string, string | number | null>>,
    ) => {
      const decisionId = String(values.decision_id ?? source.decision.decision_id);
      const membershipBase = {
        ...source.memberships[0],
        decision_id: decisionId,
        membership_sha256: "0".repeat(64),
      } satisfies LiteLearningAuthorityRow;
      const membership = {
        ...membershipBase,
        membership_sha256: learningGateArtifactMembershipDigest(membershipBase),
      } satisfies LiteLearningAuthorityRow;
      const decisionBase = {
        ...source.decision,
        ...values,
        decision_id: decisionId,
        evidence_artifact_set_sha256: learningGateArtifactSetDigest(source.artifactHeads),
        decision_sha256: "0".repeat(64),
      } satisfies LiteLearningAuthorityRow;
      return {
        decision: {
          ...decisionBase,
          decision_sha256: learningGateDecisionDigest(decisionBase),
        } satisfies LiteLearningAuthorityRow,
        memberships: [membership] as const,
      };
    };
    await assert.rejects(
      database.transaction.run(async () => await ledger.insertGateEvidenceEvaluation(rebindDecision(look2, {
        decision_id: "decision-look-2-cross-experiment",
        experiment_id: "experiment-gate-b",
      }))),
      /immediate prior look/,
    );
    await database.transaction.run(async () => await ledger.insertGateEvidenceEvaluation(look2));
    await assert.rejects(
      database.transaction.run(async () => await ledger.insertGateEvidenceEvaluation(rebindDecision(look2, {
        decision_id: "decision-look-3-skips",
        look_index: 3,
        supersedes_decision_id: "decision-look-1",
      }))),
      /immediate prior look/,
    );

    const closedAt = "2026-08-10T00:00:00.000Z";
    const closeAuthority = experimentClosureFixture({
      fixture,
      operationId: "operation-close-gate-series",
      nonce: "nonce-close-gate-series",
      createdAt: closedAt,
    });
    const closer = createLiteLearningExperimentCloser({
      database,
      writeStore,
      dependencies: {
        now: () => closedAt,
        resolveKeyring: storeCloseKeyring,
      },
    });
    await closer.close({
      tenantId: "tenant-a",
      actor: "test-operator",
      operationId: closeAuthority.approval.authority_operation_id,
      authorization: closeAuthority.authorization,
      experimentId: String(fixture.revision.experiment_id),
      experimentRevision: Number(fixture.revision.experiment_revision),
    });

    assert.throws(
      () => assertLearningLookProposalAgainstDatabase(database.db, look2.proposal),
      /learning_experiment_closed:gate_look_proposal/,
    );
    const closedArtifact = {
      ...look2.artifact,
      artifact_id: "runtime-integrity-artifact-after-close",
    } satisfies LiteLearningAuthorityRow;
    const closedReservationBase = {
      ...look2.reservation,
      reservation_id: "look-reservation-after-close",
      operation_id: "operation-look-reservation-after-close",
      runtime_integrity_artifact_id: closedArtifact.artifact_id,
      reservation_sha256: "0".repeat(64),
    } satisfies LiteLearningAuthorityRow;
    const closedReservation = {
      ...closedReservationBase,
      reservation_sha256: learningGateLookReservationDigest(closedReservationBase),
    } satisfies LiteLearningAuthorityRow;
    await assert.rejects(
      database.transaction.run(async () => await ledger.reserveGateLook({
        artifact: closedArtifact,
        reservation: closedReservation,
      })),
      /learning_experiment_closed:gate_look_reservation/,
    );
    await assert.rejects(
      database.transaction.run(async () => await ledger.insertGateEvidenceEvaluation(
        rebindDecision(look2, { decision_id: "decision-after-close" }),
      )),
      /learning_experiment_closed:gate_evidence_evaluation/,
    );

    const look2ReservationReplay = await database.transaction.run(
      async () => await ledger.reserveGateLook({
        artifact: look2.artifact,
        reservation: look2.reservation,
      }),
    );
    assert.equal(look2ReservationReplay.replayed, true);
    const look2Replay = await database.transaction.run(
      async () => await ledger.insertGateEvidenceEvaluation(look2),
    );
    assert.equal(look2Replay.replayed, true);
    await ledger.verifyIntegrity();
    const danglingReport = canonicalJson({
      contract_version: "test-runtime-integrity-report-v1",
      look_index: 3,
      status: "passed",
    });
    const danglingArtifact = {
      ...look2.artifact,
      artifact_id: "runtime-integrity-artifact-3-dangling",
      supersedes_artifact_id: look2.artifact.artifact_id,
      look_index: 3,
      look_proposal_sha256: sha256("look-proposal-3-dangling"),
      source_bundle_sha256: sha256("integrity-source-3-dangling"),
      harness_bundle_sha256: sha256("integrity-harness-3-dangling"),
      report_sha256: danglingReport.sha256,
      report_json: danglingReport.json,
      source_ref: "runtime-integrity/look-3-dangling",
    } satisfies LiteLearningAuthorityRow;
    const artifactColumns = LITE_LEARNING_LEDGER_REQUIRED_COLUMNS.lite_learning_evidence_artifacts
      .filter((column) => column !== "row_id");
    database.db.prepare(
      `INSERT INTO lite_learning_evidence_artifacts
       (${artifactColumns.join(", ")})
       VALUES (${artifactColumns.map(() => "?").join(", ")})`,
    ).run(...artifactColumns.map((column) => danglingArtifact[column]));
    await assert.rejects(ledger.verifyIntegrity(), /invalid_runtime_gate_prefix/);
    await assert.rejects(writeStore.close(), /invalid_runtime_gate_prefix/);
    writeStore = null;
  } finally {
    await writeStore?.close();
    await database.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("v3 preflight rejects missing or substituted immutable triggers before repair DDL", async () => {
  for (const corruption of ["missing", "substituted"] as const) {
    const temp = tempDatabase(`trigger-${corruption}`);
    try {
      const initialized = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
      await initialized.close();
      const corruptingDb = createSqliteDatabase(temp.path);
      corruptingDb.exec("DROP TRIGGER lite_runtime_authority_identity_no_update");
      if (corruption === "substituted") {
        corruptingDb.exec(`
          CREATE TRIGGER lite_runtime_authority_identity_no_update
          BEFORE UPDATE ON lite_runtime_authority_identity
          BEGIN
            SELECT RAISE(ABORT, 'different trigger body');
          END;
        `);
      }
      const report = inspectLiteRuntimeSchema(corruptingDb);
      assert.equal(report.classification, "incompatible");
      assert.match(report.trigger_problems.join("\n"), corruption === "missing"
        ? /missing required trigger/
        : /definition does not match/);
      corruptingDb.close();

      const database = createLiteRuntimeDatabase(temp.path);
      try {
        assert.throws(
          () => createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false }),
          /lite_runtime_schema_preflight_failed/,
        );
      } finally {
        await database.close();
      }
    } finally {
      fs.rmSync(temp.directory, { recursive: true, force: true });
    }
  }
});

test("every v4 schema fault phase leaves a complete v2 database", async (t) => {
  const phases = [
    "after_v2_structures",
    "after_shared_measurement_structures",
    "after_authority_identity",
    "after_learning_ledger_structures",
    "after_v3_shape_verification",
    "before_metadata_update",
    "after_metadata_update_before_commit",
  ] as const;
  for (const phase of phases) {
    await t.test(phase, async () => {
      const temp = tempDatabase(`phase-${phase}`);
      try {
        await createV2Fixture(temp.path);
        const database = createLiteRuntimeDatabase(temp.path);
        try {
          assert.throws(
            () => createLiteWriteStoreFromDatabase(database, {
              annProjectionEnabled: false,
              schemaMigrationFaultInjector(current) {
                if (current === phase) throw new Error(`fault:${phase}`);
              },
            }),
            new RegExp(`fault:${phase}`),
          );
        } finally {
          await database.close();
        }
        const raw = createSqliteDatabase(temp.path);
        try {
          const report = inspectLiteRuntimeSchema(raw);
          assert.equal(report.classification, "supported_previous_v2");
          assert.equal(report.detected_version, 2);
          assert.equal(
            userSchemaNames(raw, "table").some((table) => (
              LITE_LEARNING_LEDGER_REQUIRED_TABLE_NAMES.includes(table)
            )),
            false,
          );
        } finally {
          raw.close();
        }
      } finally {
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });
  }
});

test("a real process kill cannot expose DDL or metadata from an uncommitted v4 migration", async (t) => {
  for (const phase of ["before_metadata_update", "after_metadata_update_before_commit"] as const) {
    await t.test(phase, async () => {
      const temp = tempDatabase(`kill-${phase}`);
      try {
        await createV2Fixture(temp.path);
        const child = spawnSync(
          process.execPath,
          ["--import", "tsx", MIGRATION_CRASH_CHILD, temp.path, phase],
          { cwd: path.resolve(path.dirname(MIGRATION_CRASH_CHILD), "../../.."), encoding: "utf8" },
        );
        assert.equal(child.status, null, child.stderr || child.stdout);
        assert.equal(child.signal, "SIGKILL");

        const raw = createSqliteDatabase(temp.path);
        try {
          const report = inspectLiteRuntimeSchema(raw);
          assert.equal(report.classification, "supported_previous_v2");
          assert.equal(report.detected_version, 2);
          assert.equal(tableColumns(raw, "lite_product_measurements").includes("record_sha256"), false);
          assert.equal(userSchemaNames(raw, "table").includes("lite_runtime_authority_identity"), false);
        } finally {
          raw.close();
        }

        const retry = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
        await retry.close();
        const migrated = createSqliteDatabase(temp.path);
        try {
          assert.equal(inspectLiteRuntimeSchema(migrated).classification, "current");
          assert.equal(
            (migrated.prepare("SELECT COUNT(*) AS count FROM lite_runtime_authority_identity").get() as { count: number }).count,
            1,
          );
        } finally {
          migrated.close();
        }
      } finally {
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });
  }
});

test("concurrent v2-to-v4 openers converge on one committed lineage identity", async () => {
  const temp = tempDatabase("concurrent-migration");
  try {
    await createV2Fixture(temp.path);
    const [left, right] = await Promise.all([
      runMigrationChild(temp.path),
      runMigrationChild(temp.path),
    ]);
    assert.match(left, /^[0-9a-f]{64}$/);
    assert.equal(right, left);

    const db = createSqliteDatabase(temp.path);
    try {
      assert.equal(inspectLiteRuntimeSchema(db).classification, "current");
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS count FROM lite_runtime_authority_identity").get() as { count: number }).count,
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

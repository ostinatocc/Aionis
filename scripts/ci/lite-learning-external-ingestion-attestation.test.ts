import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from "node:crypto";
import test from "node:test";

import stableStringify from "fast-json-stable-stringify";

import {
  LEARNING_EXTERNAL_ATTESTATION_ROLE_SPECS,
  LEARNING_RUNTIME_AUTHORITY_HEAD_V1_HASH_DOMAINS,
  LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC,
  LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS,
  LearningExternalIngestionAttestationBodyV1Schema,
  LearningExternalIngestionAttestationEnvelopeV1Schema,
  LearningExternalIngestionProjectionV1Schema,
  LearningExternalRequiredSeriesStatusV1Schema,
  LearningExternalTerminalCoverageIndexV1Schema,
  LearningRuntimeAuthorityHeadV1Schema,
  encodeLearningRuntimeAuthorityMessage,
  encodeLearningRuntimeAuthorityTypedValue,
  encodeLearningRuntimeAuthorityU64BE,
  learningExternalIngestionAttestationDigest,
  learningExternalIngestionProjectionDigest,
  learningExternalRequiredSeriesStatusDigest,
  learningExternalTerminalCoverageIndexDigest,
  learningRuntimeAuthorityExternalOperationClosureDigest,
  learningRuntimeAuthorityFrame,
  learningRuntimeAuthorityHeadRootDigestV1,
  learningRuntimeAuthorityRowContentDigest,
  learningRuntimeAuthorityTableRowsDigest,
  learningRuntimeAuthorityHeadTableManifestDigest,
  parseCanonicalLearningExternalIngestionAttestationJson,
  parseCanonicalLearningExternalIngestionProjectionJson,
  parseCanonicalLearningExternalRequiredSeriesStatusJson,
  parseCanonicalLearningExternalTerminalCoverageIndexJson,
  verifyLearningExternalIngestionAttestation,
} from "../../src/memory/learning-external-ingestion-attestation.js";
import { learningExternalEd25519PublicKeyDigest } from "../../src/memory/learning-external-authority.js";
import {
  ExternalExecutionPolicyV1Schema,
  externalExecutionPolicyDigest,
} from "../../src/memory/learning-episode-ledger.js";
import { LITE_LEARNING_LEDGER_REQUIRED_COLUMNS } from "../../src/store/lite-learning-episode-ledger.js";

function rawEd25519PublicKeyBase64(publicKey: KeyObject): string {
  const spki = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  assert.ok(spki.byteLength > 32);
  return spki.subarray(spki.byteLength - 32).toString("base64");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sha256(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function authorityRow(
  table: string,
  primaryKey: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const spec = LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS.find(
    (candidate) => candidate.table === table,
  );
  assert.ok(spec);
  return Object.fromEntries(spec.column_order.map((column) => [
    column,
    primaryKey[column] ?? { storage_class: "null", value: null },
  ]));
}

const ROLE_SPECS = [
  {
    role: "offline_paired",
    artifact_kind: "offline_paired_rerun",
    evidence_series_id: "series-offline",
  },
  {
    role: "production_shadow",
    artifact_kind: "production_shadow_gate",
    evidence_series_id: "series-shadow",
  },
  {
    role: "tool_e2e",
    artifact_kind: "tool_e2e_gate",
    evidence_series_id: "series-tool",
  },
] as const;

const DATABASE_LINEAGE = {
  database_instance_id: sha256("database-instance"),
  database_file_device: "101",
  database_file_inode: "202",
  checkpoint_generation: "3",
  database_main_file_byte_length: "4096",
  database_main_file_sha256: sha256("database-main-file"),
  wal_checkpointed_and_truncated: true as const,
};

const TEST_ATTESTOR_KEYS = generateKeyPairSync("ed25519");
const TEST_LAUNCHER_KEYS = generateKeyPairSync("ed25519");
const TEST_BROKER_KEYS = generateKeyPairSync("ed25519");

function externalExecutionPolicy() {
  const attestorPublicKeyBase64 = rawEd25519PublicKeyBase64(TEST_ATTESTOR_KEYS.publicKey);
  const launcherPublicKeyBase64 = rawEd25519PublicKeyBase64(TEST_LAUNCHER_KEYS.publicKey);
  const brokerPublicKeyBase64 = rawEd25519PublicKeyBase64(TEST_BROKER_KEYS.publicKey);
  const attestorPublicKeySha256 = learningExternalEd25519PublicKeyDigest(
    attestorPublicKeyBase64,
  );
  const launcherPublicKeySha256 = learningExternalEd25519PublicKeyDigest(
    launcherPublicKeyBase64,
  );
  const brokerPublicKeySha256 = learningExternalEd25519PublicKeyDigest(
    brokerPublicKeyBase64,
  );
  const role = (
    roleName: "offline_paired" | "production_shadow" | "tool_e2e",
    credentialSessionClass:
      | "immutable_paired_eval"
      | "eligible_host_adapter"
      | "formal_tool_eval",
  ) => ({
    runner_principal_sha256: sha256(`runner-principal:${roleName}`),
    credential_session_class: credentialSessionClass,
    broker_policy_sha256: sha256(`broker-policy:${roleName}`),
    broker_binary_sha256: sha256(`broker-binary:${roleName}`),
    broker_public_key_base64: brokerPublicKeyBase64,
    broker_public_key_sha256: brokerPublicKeySha256,
    broker_key_id: `broker-key-${roleName}`,
    service_launcher_policy_sha256: sha256("launcher-policy"),
    service_launcher_binary_sha256: sha256("launcher-binary"),
    service_launcher_public_key_sha256: launcherPublicKeySha256,
    service_launcher_key_id: "launcher-key-1",
    supervisor_executable_sha256: sha256(`supervisor-executable:${roleName}`),
    supervisor_argv_policy_sha256: sha256(`supervisor-argv:${roleName}`),
    supervisor_sandbox_policy_sha256: sha256(`supervisor-sandbox:${roleName}`),
    receipt_signature_algorithm: "ed25519-v1" as const,
    credential_scope_sha256: sha256(`credential-scope:${roleName}`),
    supervisor_bind_ttl_seconds: 60,
    credential_session_hard_ttl_seconds: 120,
    credential_session_heartbeat_seconds: 10,
    credential_session_max_calls: 100,
    per_call_capability_ttl_seconds: 5,
    post_quiesce_finalize_ttl_seconds: 300,
  });
  return ExternalExecutionPolicyV1Schema.parse({
    policy_version: "external-execution-v1",
    runtime_authority_attestor: {
      service_identity: "runtime-authority-attestor",
      attestor_binary_sha256: sha256("attestor-binary"),
      attestor_policy_sha256: sha256("attestor-policy"),
      attestor_public_key_base64: attestorPublicKeyBase64,
      attestor_public_key_sha256: attestorPublicKeySha256,
      attestor_key_id: "attestor-key-1",
      service_launcher_policy_sha256: sha256("launcher-policy"),
      service_launcher_binary_sha256: sha256("launcher-binary"),
      service_launcher_public_key_base64: launcherPublicKeyBase64,
      service_launcher_public_key_sha256: launcherPublicKeySha256,
      service_launcher_key_id: "launcher-key-1",
      receipt_signature_algorithm: "ed25519-v1",
      expected_database_instance_id: DATABASE_LINEAGE.database_instance_id,
    },
    roles: {
      offline_paired: role("offline_paired", "immutable_paired_eval"),
      production_shadow: role("production_shadow", "eligible_host_adapter"),
      tool_e2e: role("tool_e2e", "formal_tool_eval"),
    },
  });
}

const EXTERNAL_EXECUTION_POLICY = externalExecutionPolicy();
const EXTERNAL_EXECUTION_POLICY_SHA256 = sha256(stableStringify(EXTERNAL_EXECUTION_POLICY));
assert.equal(
  EXTERNAL_EXECUTION_POLICY_SHA256,
  externalExecutionPolicyDigest(EXTERNAL_EXECUTION_POLICY),
);
const REGISTERED_EVIDENCE_SERIES = {
  offline_paired: "series-offline",
  production_shadow: "series-shadow",
  tool_e2e: "series-tool",
  runtime_integrity: "series-runtime-integrity",
} as const;
const REGISTERED_EVIDENCE_SERIES_SHA256 = sha256(
  stableStringify(REGISTERED_EVIDENCE_SERIES),
);

function resultStatusEntries() {
  const statuses = ["passed", "failed", "inconclusive"] as const;
  return ROLE_SPECS.map((entry, index) => ({
    ...entry,
    branch_kind: "result" as const,
    artifact_status: statuses[index]!,
  }));
}

function zeroResultStatusEntries() {
  return [
    {
      ...ROLE_SPECS[0],
      branch_kind: "unstarted" as const,
    },
    {
      ...ROLE_SPECS[1],
      branch_kind: "termination_hold" as const,
      termination_reason: "runner_crash" as const,
    },
    {
      ...ROLE_SPECS[2],
      branch_kind: "preclaim_hold" as const,
      preclaim_hold_reason: "validation_failure" as const,
    },
  ];
}

function requiredSeriesStatus(zeroResult = false) {
  return {
    contract_version: "aionis_learning_external_required_series_status_v1" as const,
    tenant_id: "tenant-attestation",
    task_family: "runtime-learning",
    experiment_id: "experiment-attestation",
    experiment_revision: 7,
    required_evidence_series_sha256: REGISTERED_EVIDENCE_SERIES_SHA256,
    series: zeroResult ? zeroResultStatusEntries() : resultStatusEntries(),
  };
}

function resultCoverageBranches() {
  const statuses = ["passed", "failed", "inconclusive"] as const;
  return ROLE_SPECS.map((entry, index) => ({
    ...entry,
    branch_kind: "result" as const,
    artifact_status: statuses[index]!,
    reservation_id: `reservation-${entry.role}`,
    ticket_consumption_id: `consumption-${entry.role}`,
    claim_id: `claim-${entry.role}`,
    supervisor_binding_id: `binding-${entry.role}`,
    session_termination_id: `termination-${entry.role}`,
    session_termination_sha256: sha256(`termination:${entry.role}`),
    report_sha256: sha256(`report:${entry.role}`),
    public_run_authority_sha256: sha256(`public-authority:${entry.role}`),
    run_bundle_manifest_sha256: sha256(`bundle:${entry.role}`),
    run_bundle_archive_sha256: sha256(`bundle-archive:${entry.role}`),
    bundle_commit_id: sha256(`bundle-commit:${entry.role}`),
    artifact_count: 1 as const,
    ingest_operation_count: 1 as const,
    current_series_head_count: 1 as const,
  }));
}

function zeroResultCoverageBranches() {
  return [
    {
      ...ROLE_SPECS[0],
      branch_kind: "unstarted" as const,
      reservation_count: 0 as const,
      ticket_consumption_count: 0 as const,
      preclaim_hold_count: 0 as const,
      claim_count: 0 as const,
      supervisor_binding_count: 0 as const,
      session_termination_count: 0 as const,
      artifact_count: 0 as const,
      ingest_operation_count: 0 as const,
      current_series_head_count: 0 as const,
    },
    {
      ...ROLE_SPECS[1],
      branch_kind: "termination_hold" as const,
      reservation_id: "reservation-production-shadow",
      ticket_consumption_id: "consumption-production-shadow",
      claim_id: "claim-production-shadow",
      supervisor_binding_id: "binding-production-shadow",
      session_termination_id: "termination-production-shadow",
      session_termination_sha256: sha256("termination:production-shadow"),
      termination_reason: "runner_crash" as const,
      termination_hold_bundle_sha256: sha256("termination-hold-bundle:production-shadow"),
      artifact_count: 0 as const,
      ingest_operation_count: 0 as const,
      current_series_head_count: 0 as const,
    },
    {
      ...ROLE_SPECS[2],
      branch_kind: "preclaim_hold" as const,
      reservation_id: "reservation-tool-e2e",
      ticket_consumption_id: "consumption-tool-e2e",
      preclaim_hold_id: "preclaim-hold-tool-e2e",
      preclaim_hold_sha256: sha256("preclaim-hold:tool-e2e"),
      zero_effects_proof_sha256: sha256("zero-effects-proof:tool-e2e"),
      preclaim_hold_reason: "validation_failure" as const,
      preclaim_hold_bundle_sha256: sha256("preclaim-hold-bundle:tool-e2e"),
      claim_count: 0 as const,
      supervisor_binding_count: 0 as const,
      session_termination_count: 0 as const,
      artifact_count: 0 as const,
      ingest_operation_count: 0 as const,
      current_series_head_count: 0 as const,
    },
  ];
}

function terminalCoverageIndex(zeroResult = false) {
  return {
    contract_version: "aionis_learning_external_terminal_coverage_index_v1" as const,
    tenant_id: "tenant-attestation",
    task_family: "runtime-learning",
    experiment_id: "experiment-attestation",
    experiment_revision: 7,
    required_evidence_series_sha256: REGISTERED_EVIDENCE_SERIES_SHA256,
    branches: zeroResult ? zeroResultCoverageBranches() : resultCoverageBranches(),
    finalized_at: "2026-07-17T01:02:03.000Z",
  };
}

function authorityHead() {
  const operationRows = learningRuntimeAuthorityTableRowsDigest({
    table: "lite_runtime_write_operations",
    expectedRowCount: 0,
    rows: [],
  });
  const body = {
    contract_version: "aionis_learning_runtime_authority_head_body_v1" as const,
    schema_component: "write_projection" as const,
    schema_version: 4 as const,
    database_lineage: DATABASE_LINEAGE,
    table_manifest_sha256: learningRuntimeAuthorityHeadTableManifestDigest(),
    encoding_contract_version: "aionis_learning_runtime_authority_head_encoding_v1" as const,
    tables: LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS.map((spec) => ({
      table: spec.table,
      primary_key: [...spec.primary_key],
      primary_key_kinds: [...spec.primary_key_kinds],
      column_order: [...spec.column_order],
      ...learningRuntimeAuthorityTableRowsDigest({
        table: spec.table,
        expectedRowCount: 0,
        rows: [],
      }),
    })),
    external_scope_operations: {
      table: "lite_runtime_write_operations" as const,
      scope: "learning_external_authority_v1" as const,
      primary_key: ["tenant_id", "scope", "operation_kind", "operation_id"] as const,
      primary_key_kinds: ["text", "text", "text", "text"] as const,
      column_order: [
        "tenant_id",
        "scope",
        "operation_kind",
        "operation_id",
        "request_sha256",
        "receipt_json",
        "commit_id",
        "created_at",
      ] as const,
      closure: "all_rows_matching_selector" as const,
      row_count: operationRows.row_count,
      rows_sha256: operationRows.rows_sha256,
      closure_sha256: learningRuntimeAuthorityExternalOperationClosureDigest({
        rowCount: operationRows.row_count,
        rowsSha256: operationRows.rows_sha256,
      }),
    },
  };
  return {
    contract_version: "aionis_learning_runtime_authority_head_v1" as const,
    body,
    authority_head_sha256: learningRuntimeAuthorityHeadRootDigestV1(body),
  };
}

function resultTuples() {
  return resultCoverageBranches().map((branch, index) => ({
    role: branch.role,
    artifact_kind: branch.artifact_kind,
    evidence_series_id: branch.evidence_series_id,
    artifact_status: branch.artifact_status,
    reservation_id: branch.reservation_id,
    ticket_consumption_id: branch.ticket_consumption_id,
    claim_id: branch.claim_id,
    supervisor_binding_id: branch.supervisor_binding_id,
    session_termination_id: branch.session_termination_id,
    session_termination_sha256: branch.session_termination_sha256,
    report_sha256: branch.report_sha256,
    public_run_authority_sha256: branch.public_run_authority_sha256,
    run_bundle_manifest_sha256: branch.run_bundle_manifest_sha256,
    run_bundle_archive_sha256: branch.run_bundle_archive_sha256,
    bundle_commit_id: branch.bundle_commit_id,
    ingest_operation_scope: "learning_external_authority_v1" as const,
    ingest_operation_kind: "learning_evidence_ingest_v1" as const,
    ingest_operation_id: `ingest-${branch.role}`,
    ingest_operation_request_sha256: sha256(`ingest-request:${branch.role}`),
    ingest_operation_receipt_sha256: sha256(`ingest-receipt:${branch.role}`),
    ingest_operation_commit_id: branch.bundle_commit_id,
    ingest_operation_created_at: "2026-07-17T01:02:03.500Z",
    ingest_operation_row_sha256: sha256(`ingest-operation-row:${branch.role}`),
    post_transaction_projection_sha256: sha256(`post-projection:${branch.role}`),
    artifact_id: `artifact-${branch.role}`,
    artifact_row_id: index + 1,
    artifact_row_sha256: sha256(`artifact-row-json:${branch.role}`),
    artifact_authority_row_sha256: sha256(`artifact-row:${branch.role}`),
    series_head_artifact_id: `artifact-${branch.role}`,
    series_head_row_id: index + 1,
    series_head_artifact_row_sha256: sha256(`artifact-row-json:${branch.role}`),
    series_head_row_sha256: sha256(`artifact-row:${branch.role}`),
  }));
}

function projection(zeroResult = false) {
  const status = requiredSeriesStatus(zeroResult);
  const coverage = terminalCoverageIndex(zeroResult);
  const tuples = zeroResult ? [] : resultTuples();
  const head = authorityHead();
  return {
    contract_version: "aionis_learning_external_ingestion_projection_v1" as const,
    schema_component: "write_projection" as const,
    schema_version: 4 as const,
    ledger_verifier_id: "aionis_lite_learning_ledger_replay" as const,
    ledger_verifier_version: 1 as const,
    ledger_verification_sha256: sha256("ledger-verification"),
    tenant_id: "tenant-attestation",
    task_family: "runtime-learning",
    confirmatory_attempt_id: "confirmatory-attempt-attestation",
    experiment_id: "experiment-attestation",
    experiment_revision: 7,
    database_lineage: DATABASE_LINEAGE,
    database_binding_receipt_sha256: sha256("database-binding-receipt"),
    registered_revision: {
      revision_row_sha256: sha256("revision-row"),
      profile_rule_sha256: sha256("profile-rule"),
      experiment_config_sha256: sha256("experiment-config"),
      confirmatory_attempt_sha256: sha256("confirmatory-attempt"),
      candidate_policy_implementation_sha256: sha256("candidate-implementation"),
      candidate_policy_config_sha256: sha256("candidate-config"),
      collection_source_policy_sha256: sha256("collection-source-policy"),
      gate_policy_implementation_sha256: sha256("gate-implementation"),
      gate_policy_config_sha256: sha256("gate-config"),
      gate_prospective_calibration_sha256: sha256("gate-calibration"),
      required_evidence_series_sha256: REGISTERED_EVIDENCE_SERIES_SHA256,
      required_external_inputs_sha256: sha256("required-external-inputs"),
      external_execution_policy_sha256: EXTERNAL_EXECUTION_POLICY_SHA256,
    },
    registered_evidence_series: REGISTERED_EVIDENCE_SERIES,
    required_series_status: status,
    required_series_status_sha256: learningExternalRequiredSeriesStatusDigest(status),
    terminal_coverage_index: coverage,
    terminal_coverage_index_sha256: learningExternalTerminalCoverageIndexDigest(coverage),
    result_tuples: tuples,
    result_tuples_sha256: sha256(stableStringify(tuples)),
    authority_head: head,
  };
}

const EXPECTED_AUTHORITY_TABLES = [
  ["lite_learning_policy_versions", ["tenant_id", "policy_kind", "policy_id", "policy_version"]],
  ["lite_learning_collection_principal_bindings", ["tenant_id", "collection_principal_sha256"]],
  ["lite_learning_experiment_revisions", ["tenant_id", "experiment_id", "experiment_revision"]],
  ["lite_learning_confirmatory_attempts", ["tenant_id", "confirmatory_attempt_id"]],
  ["lite_learning_randomization_pairs", ["tenant_id", "confirmatory_attempt_id", "randomization_pair_sha256"]],
  ["lite_learning_experiment_closures", ["tenant_id", "experiment_close_id"]],
  ["lite_learning_authorization_nonces", ["tenant_id", "authorization_key_id", "authorization_nonce"]],
  ["lite_learning_episode_events", ["row_id"]],
  ["lite_learning_exposure_items", ["tenant_id", "scope", "event_id", "memory_id"]],
  ["lite_learning_feedback_attributions", ["tenant_id", "scope", "event_id", "subject_kind", "subject_id"]],
  ["lite_learning_host_use_receipts", ["tenant_id", "scope", "receipt_id"]],
  ["lite_learning_external_run_reservations", ["row_id"]],
  ["lite_learning_external_holdout_members", ["tenant_id", "reservation_id", "case_ordinal"]],
  ["lite_learning_external_ticket_consumptions", ["tenant_id", "consumption_id"]],
  ["lite_learning_external_preclaim_holds", ["tenant_id", "hold_id"]],
  ["lite_learning_external_run_claims", ["tenant_id", "claim_id"]],
  ["lite_learning_external_supervisor_bindings", ["tenant_id", "binding_id"]],
  ["lite_learning_external_session_terminations", ["tenant_id", "termination_id"]],
  ["lite_learning_evidence_artifacts", ["row_id"]],
  ["lite_learning_gate_look_reservations", ["row_id"]],
  ["lite_learning_gate_decisions", ["row_id"]],
  ["lite_learning_gate_artifact_memberships", ["tenant_id", "decision_id", "artifact_id"]],
] as const;

const INTEGER_AUTHORITY_PRIMARY_KEYS = new Set([
  "lite_learning_experiment_revisions.experiment_revision",
  "lite_learning_episode_events.row_id",
  "lite_learning_external_run_reservations.row_id",
  "lite_learning_external_holdout_members.case_ordinal",
  "lite_learning_evidence_artifacts.row_id",
  "lite_learning_gate_look_reservations.row_id",
  "lite_learning_gate_decisions.row_id",
]);

test("D1 authority-head manifest freezes all 22 learning authority tables and the external operation selector", () => {
  assert.equal(LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS.length, 22);
  assert.deepEqual(
    LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS.map((spec) => [
      spec.table,
      spec.primary_key,
    ]),
    EXPECTED_AUTHORITY_TABLES,
  );
  assert.equal(new Set(
    LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS.map((spec) => spec.table),
  ).size, 22);
  for (const spec of LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS) {
    assert.ok(spec.column_order.length > 0, `${spec.table} must freeze a non-empty column order`);
    assert.equal(new Set(spec.column_order).size, spec.column_order.length);
    assert.deepEqual(
      spec.column_order,
      LITE_LEARNING_LEDGER_REQUIRED_COLUMNS[spec.table],
      `${spec.table} must freeze its complete v4 column order`,
    );
    for (const key of spec.primary_key) {
      assert.ok(spec.column_order.includes(key), `${spec.table} omits primary-key column ${key}`);
    }
    assert.deepEqual(
      spec.primary_key_kinds,
      spec.primary_key.map((column) => INTEGER_AUTHORITY_PRIMARY_KEYS.has(
        `${spec.table}.${column}`,
      ) ? "integer" : "text"),
      `${spec.table} must freeze every primary-key SQLite storage class`,
    );
  }
  assert.deepEqual(LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC, {
    table: "lite_runtime_write_operations",
    column_order: [
      "tenant_id",
      "scope",
      "operation_kind",
      "operation_id",
      "request_sha256",
      "receipt_json",
      "commit_id",
      "created_at",
    ],
    primary_key: ["tenant_id", "scope", "operation_kind", "operation_id"],
    primary_key_kinds: ["text", "text", "text", "text"],
    selector: {
      column: "scope",
      equals: "learning_external_authority_v1",
    },
    closure: "all_rows_matching_selector",
  });
  assert.equal(
    learningRuntimeAuthorityHeadTableManifestDigest(),
    "3d0d57cb9e6ba9908fa650a78dbacb92d5b4ab3766b36e36471959db3c8b1d16",
  );
  assert.doesNotThrow(() => LearningRuntimeAuthorityHeadV1Schema.parse(authorityHead()));
});

test("D1 typed SQLite encoder freezes exact values, framing, and domain separation", () => {
  assert.deepEqual(LEARNING_RUNTIME_AUTHORITY_HEAD_V1_HASH_DOMAINS, {
    field: "aionis.learning.runtime.authority-head.v1/field",
    primary_key: "aionis.learning.runtime.authority-head.v1/primary-key",
    row_content: "aionis.learning.runtime.authority-head.v1/row-content",
    row_entry: "aionis.learning.runtime.authority-head.v1/row-entry",
    table_rows: "aionis.learning.runtime.authority-head.v1/table-rows",
    table_head: "aionis.learning.runtime.authority-head.v1/table-head",
    operation_rows: "aionis.learning.runtime.authority-head.v1/operation-rows",
    operation_closure: "aionis.learning.runtime.authority-head.v1/operation-closure",
    operation_head: "aionis.learning.runtime.authority-head.v1/operation-head",
    database_lineage: "aionis.learning.runtime.authority-head.v1/database-lineage",
    root: "aionis.learning.runtime.authority-head.v1/root",
  });
  assert.equal(hex(encodeLearningRuntimeAuthorityU64BE(0)), "0000000000000000");
  assert.equal(hex(learningRuntimeAuthorityFrame(new Uint8Array())), "0000000000000000");
  assert.equal(
    hex(learningRuntimeAuthorityFrame(Uint8Array.of(0xff))),
    "0000000000000001ff",
  );

  const vectors: ReadonlyArray<readonly [unknown, string]> = [
    [{ storage_class: "null", value: null }, "000000000000000000"],
    [{ storage_class: "text", value: Buffer.from("", "utf8") },
      "010000000000000000"],
    [{ storage_class: "text", value: Buffer.from("é", "utf8") },
      "010000000000000002c3a9"],
    [{ storage_class: "integer", value: 0 }, "02000000000000000130"],
    [{ storage_class: "integer", value: -12 }, "0200000000000000032d3132"],
    [{ storage_class: "blob", value: Uint8Array.of(0x00, 0xff) },
      "03000000000000000430306666"],
  ];
  for (const [value, expectedHex] of vectors) {
    assert.equal(hex(encodeLearningRuntimeAuthorityTypedValue(value)), expectedHex);
  }

  const message = encodeLearningRuntimeAuthorityMessage("test.domain.v1", [
    Uint8Array.of(0x01),
    Uint8Array.of(0x02, 0x03),
  ]);
  assert.equal(
    hex(message),
    "000000000000000e746573742e646f6d61696e2e76310000000000000002"
      + "00000000000000010100000000000000020203",
  );
  assert.notEqual(
    hex(message),
    hex(encodeLearningRuntimeAuthorityMessage("test.domain.v2", [
      Uint8Array.of(0x01),
      Uint8Array.of(0x02, 0x03),
    ])),
  );

  for (const rejected of [
    { storage_class: "real", value: 1 },
    { storage_class: "integer", value: 1.5 },
    { storage_class: "integer", value: -0 },
    { storage_class: "integer", value: Number.MAX_SAFE_INTEGER + 1 },
    { storage_class: "integer", value: 1n },
    { storage_class: "numeric", value: 1 },
    { storage_class: "text", value: Uint8Array.of(0xed, 0xa0, 0x80) },
    1,
  ]) {
    assert.throws(() => encodeLearningRuntimeAuthorityTypedValue(rejected));
  }
});

test("D1 authority-head root is reproducible and rejects every stale committed summary", () => {
  const head = LearningRuntimeAuthorityHeadV1Schema.parse(authorityHead());
  assert.equal(
    head.authority_head_sha256,
    "66c938c94aef1fcb4466325815fa164fbfe2243489380198a828e60d699b1fd6",
  );
  assert.equal(
    head.body.external_scope_operations.closure_sha256,
    "ae544d470f1a8950f9d96333a9f0010dbe8529a7bdf7d9d6d843b49e08d17c4e",
  );
  assert.equal(
    head.authority_head_sha256,
    learningRuntimeAuthorityHeadRootDigestV1(head.body),
  );
  assert.equal(
    learningRuntimeAuthorityHeadRootDigestV1(head.body),
    learningRuntimeAuthorityHeadRootDigestV1(clone(head.body)),
  );

  const tamperedHeads = [
    (() => {
      const tampered = clone(head);
      tampered.body.tables[0]!.row_count += 1;
      return tampered;
    })(),
    (() => {
      const tampered = clone(head);
      tampered.body.tables[0]!.rows_sha256 = sha256("tampered-table-rows");
      return tampered;
    })(),
    (() => {
      const tampered = clone(head);
      tampered.body.external_scope_operations.rows_sha256 = sha256("tampered-operations");
      return tampered;
    })(),
    (() => {
      const tampered = clone(head);
      tampered.body.external_scope_operations.closure_sha256 = sha256("tampered-closure");
      return tampered;
    })(),
    (() => {
      const tampered = clone(head);
      tampered.body.database_lineage.database_file_inode = "203";
      return tampered;
    })(),
  ];
  for (const tampered of tamperedHeads) {
    assert.throws(() => LearningRuntimeAuthorityHeadV1Schema.parse(tampered));
  }
});

test("D1 table hashing enforces composite typed primary-key order and row content", () => {
  const primaryKey = (caseOrdinal: number) => ({
    tenant_id: { storage_class: "text", value: Buffer.from("tenant-attestation") },
    reservation_id: { storage_class: "text", value: Buffer.from("reservation-order") },
    case_ordinal: { storage_class: "integer", value: caseOrdinal },
  });
  const row2 = authorityRow("lite_learning_external_holdout_members", primaryKey(2));
  const row10 = authorityRow("lite_learning_external_holdout_members", primaryKey(10));
  const firstDigest = learningRuntimeAuthorityRowContentDigest({
    table: "lite_learning_external_holdout_members",
    row: row2,
  });
  assert.equal(
    firstDigest,
    "ab2200b3e7696cd64ba4492f01e0db69428d66d914709b99e20b56ac832f3e96",
  );
  assert.equal(firstDigest, learningRuntimeAuthorityRowContentDigest({
    table: "lite_learning_external_holdout_members",
    row: clone(row2),
  }));
  const changed = clone(row2);
  changed.task_family = {
    storage_class: "text",
    value: Buffer.from("changed-task-family"),
  };
  assert.notEqual(firstDigest, learningRuntimeAuthorityRowContentDigest({
    table: "lite_learning_external_holdout_members",
    row: changed,
  }));

  const rows = learningRuntimeAuthorityTableRowsDigest({
    table: "lite_learning_external_holdout_members",
    expectedRowCount: 2,
    rows: [row2, row10],
  });
  assert.equal(rows.row_count, 2);
  assert.equal(
    rows.rows_sha256,
    "b6f7292c00a249613cde51712078a243bdf7cdb0d51c0d47c9d31c53a0bc6838",
  );
  assert.throws(() => learningRuntimeAuthorityTableRowsDigest({
    table: "lite_learning_external_holdout_members",
    expectedRowCount: 2,
    rows: [row10, row2],
  }), /primary_key_order_invalid/u);
  assert.throws(() => learningRuntimeAuthorityTableRowsDigest({
    table: "lite_learning_external_holdout_members",
    expectedRowCount: 2,
    rows: [row2, clone(row2)],
  }), /primary_key_order_invalid/u);

  const wrongStorageClass = authorityRow("lite_learning_external_holdout_members", {
    tenant_id: { storage_class: "text", value: Buffer.from("tenant-attestation") },
    reservation_id: { storage_class: "text", value: Buffer.from("reservation-order") },
    case_ordinal: { storage_class: "text", value: Buffer.from("2") },
  });
  assert.throws(() => learningRuntimeAuthorityTableRowsDigest({
    table: "lite_learning_external_holdout_members",
    expectedRowCount: 1,
    rows: [wrongStorageClass],
  }), /primary_key_storage_class/u);
});

test("D1 external operation closure hashes only non-empty rows matching the frozen scope selector", () => {
  const operationRow = {
    tenant_id: { storage_class: "text", value: Buffer.from("tenant-attestation") },
    scope: {
      storage_class: "text",
      value: Buffer.from("learning_external_authority_v1"),
    },
    operation_kind: {
      storage_class: "text",
      value: Buffer.from("learning_external_evidence_ingest"),
    },
    operation_id: { storage_class: "text", value: Buffer.from("operation-attestation") },
    request_sha256: { storage_class: "text", value: Buffer.from(sha256("request")) },
    receipt_json: {
      storage_class: "text",
      value: Buffer.from('{"receipt":"attested"}'),
    },
    commit_id: { storage_class: "integer", value: 41 },
    created_at: { storage_class: "text", value: Buffer.from("2026-07-17T01:02:03.000Z") },
  };
  const rows = learningRuntimeAuthorityTableRowsDigest({
    table: "lite_runtime_write_operations",
    expectedRowCount: 1,
    rows: [operationRow],
  });
  assert.deepEqual(rows, {
    row_count: 1,
    rows_sha256: "00d5538d7da3896bd4ecb6597b5c01cd4d79f9ef88f98c83ca5ff8849355b387",
  });
  assert.equal(
    learningRuntimeAuthorityExternalOperationClosureDigest({
      rowCount: rows.row_count,
      rowsSha256: rows.rows_sha256,
    }),
    "328f0a744a3efb10c4c33b45e2c4cde61b2eab83d07b438f822fc697f3c99d04",
  );

  const wrongScope = clone(operationRow);
  wrongScope.scope = { storage_class: "text", value: Buffer.from("other_scope") };
  assert.throws(() => learningRuntimeAuthorityTableRowsDigest({
    table: "lite_runtime_write_operations",
    expectedRowCount: 1,
    rows: [wrongScope],
  }), /operation_selector_mismatch:scope/u);

  const scopeAsBlob = clone(operationRow);
  scopeAsBlob.scope = {
    storage_class: "blob",
    value: Buffer.from("learning_external_authority_v1"),
  };
  assert.throws(() => learningRuntimeAuthorityTableRowsDigest({
    table: "lite_runtime_write_operations",
    expectedRowCount: 1,
    rows: [scopeAsBlob],
  }), /operation_selector_mismatch:scope/u);
});

test("D1 external roles are fixed, ordered, and unique", () => {
  assert.deepEqual(LEARNING_EXTERNAL_ATTESTATION_ROLE_SPECS, [
    { role: "offline_paired", artifact_kind: "offline_paired_rerun" },
    { role: "production_shadow", artifact_kind: "production_shadow_gate" },
    { role: "tool_e2e", artifact_kind: "tool_e2e_gate" },
  ]);
  assert.equal(new Set(
    LEARNING_EXTERNAL_ATTESTATION_ROLE_SPECS.map((entry) => entry.role),
  ).size, 3);
});

test("D1 canonical status and coverage contracts reject unknown fields, reordered bytes, and role drift", () => {
  const status = LearningExternalRequiredSeriesStatusV1Schema.parse(requiredSeriesStatus());
  const statusJson = stableStringify(status);
  assert.deepEqual(
    parseCanonicalLearningExternalRequiredSeriesStatusJson(statusJson),
    status,
  );
  assert.equal(learningExternalRequiredSeriesStatusDigest(status), sha256(statusJson));
  assert.throws(
    () => parseCanonicalLearningExternalRequiredSeriesStatusJson(JSON.stringify(status)),
    /noncanonical_json/u,
  );
  const duplicateKeyJson = statusJson.replace(
    '"tenant_id":"tenant-attestation"',
    '"tenant_id":"tenant-attestation","tenant_id":"tenant-attestation"',
  );
  assert.throws(
    () => parseCanonicalLearningExternalRequiredSeriesStatusJson(duplicateKeyJson),
    /noncanonical_json/u,
  );
  assert.throws(
    () => parseCanonicalLearningExternalRequiredSeriesStatusJson(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(statusJson, "utf8"),
    ])),
    /utf8_bom_forbidden/u,
  );
  assert.throws(
    () => parseCanonicalLearningExternalRequiredSeriesStatusJson(
      Uint8Array.from([0xff, 0xfe, 0xfd]),
    ),
    /invalid_utf8/u,
  );
  assert.throws(
    () => parseCanonicalLearningExternalRequiredSeriesStatusJson(stableStringify({
      ...status,
      release_verdict: "eligible",
    })),
  );
  const loneSurrogate = clone(status);
  loneSurrogate.tenant_id = "\ud800";
  assert.throws(
    () => parseCanonicalLearningExternalRequiredSeriesStatusJson(stableStringify(loneSurrogate)),
    /surrogate|identifier/u,
  );

  const swapped = clone(status);
  [swapped.series[0], swapped.series[1]] = [swapped.series[1]!, swapped.series[0]!];
  assert.throws(() => LearningExternalRequiredSeriesStatusV1Schema.parse(swapped));
  const duplicated = clone(status);
  duplicated.series[1] = clone(duplicated.series[0]!);
  assert.throws(() => LearningExternalRequiredSeriesStatusV1Schema.parse(duplicated));

  const coverage = LearningExternalTerminalCoverageIndexV1Schema.parse(
    terminalCoverageIndex(),
  );
  const coverageJson = stableStringify(coverage);
  assert.deepEqual(
    parseCanonicalLearningExternalTerminalCoverageIndexJson(coverageJson),
    coverage,
  );
  assert.equal(learningExternalTerminalCoverageIndexDigest(coverage), sha256(coverageJson));
  assert.throws(
    () => parseCanonicalLearningExternalTerminalCoverageIndexJson(JSON.stringify(coverage)),
    /noncanonical_json/u,
  );
  const duplicateCoverage = clone(coverage);
  duplicateCoverage.branches[2] = clone(duplicateCoverage.branches[0]!);
  assert.throws(() => LearningExternalTerminalCoverageIndexV1Schema.parse(duplicateCoverage));
});

test("D1 aggregate projection binds passed, failed, and inconclusive result branches exactly once", () => {
  const parsed = LearningExternalIngestionProjectionV1Schema.parse(projection());
  assert.equal(
    parsed.registered_revision.external_execution_policy_sha256,
    sha256(stableStringify(EXTERNAL_EXECUTION_POLICY)),
  );
  assert.equal(
    parsed.registered_revision.external_execution_policy_sha256,
    externalExecutionPolicyDigest(EXTERNAL_EXECUTION_POLICY),
  );
  assert.deepEqual(
    parsed.required_series_status.series.map((entry) => entry.branch_kind === "result"
      ? entry.artifact_status
      : null),
    ["passed", "failed", "inconclusive"],
  );
  assert.deepEqual(
    parsed.result_tuples.map(({ role }) => role),
    ["offline_paired", "production_shadow", "tool_e2e"],
  );
  assert.deepEqual(
    parsed.terminal_coverage_index.branches.map((branch) => branch.branch_kind === "result"
      ? [branch.artifact_count, branch.ingest_operation_count, branch.current_series_head_count]
      : null),
    [[1, 1, 1], [1, 1, 1], [1, 1, 1]],
  );
  const canonical = stableStringify(parsed);
  assert.deepEqual(parseCanonicalLearningExternalIngestionProjectionJson(canonical), parsed);
  assert.equal(learningExternalIngestionProjectionDigest(parsed), sha256(canonical));
  assert.throws(
    () => parseCanonicalLearningExternalIngestionProjectionJson(JSON.stringify(parsed)),
    /noncanonical_json/u,
  );

  const missing = clone(parsed);
  missing.result_tuples.pop();
  missing.result_tuples_sha256 = sha256(stableStringify(missing.result_tuples));
  assert.throws(() => LearningExternalIngestionProjectionV1Schema.parse(missing));

  const duplicate = clone(parsed);
  duplicate.result_tuples[1] = clone(duplicate.result_tuples[0]!);
  duplicate.result_tuples_sha256 = sha256(stableStringify(duplicate.result_tuples));
  assert.throws(() => LearningExternalIngestionProjectionV1Schema.parse(duplicate));

  const staleHead = clone(parsed);
  staleHead.result_tuples[0]!.series_head_artifact_id = "stale-artifact";
  staleHead.result_tuples_sha256 = sha256(stableStringify(staleHead.result_tuples));
  assert.throws(() => LearningExternalIngestionProjectionV1Schema.parse(staleHead));

  const wrongResultCount = clone(parsed.terminal_coverage_index);
  const firstBranch = wrongResultCount.branches[0];
  if (firstBranch?.branch_kind === "result") firstBranch.artifact_count = 0 as never;
  assert.throws(() => LearningExternalTerminalCoverageIndexV1Schema.parse(wrongResultCount));

  const changedRegisteredSeries = clone(parsed);
  changedRegisteredSeries.registered_evidence_series.runtime_integrity = "different-series";
  assert.throws(() => LearningExternalIngestionProjectionV1Schema.parse(changedRegisteredSeries));

  const missingRevisionRow = clone(parsed) as unknown as Record<string, unknown>;
  const registeredRevision = clone(parsed.registered_revision) as unknown as Record<string, unknown>;
  delete registeredRevision.revision_row_sha256;
  missingRevisionRow.registered_revision = registeredRevision;
  assert.throws(() => LearningExternalIngestionProjectionV1Schema.parse(missingRevisionRow));
});

test("D1 zero-result projection explicitly carries all three terminal roles and an empty tuple digest", () => {
  const parsed = LearningExternalIngestionProjectionV1Schema.parse(projection(true));
  assert.deepEqual(
    parsed.required_series_status.series.map(({ branch_kind }) => branch_kind),
    ["unstarted", "termination_hold", "preclaim_hold"],
  );
  assert.deepEqual(
    parsed.terminal_coverage_index.branches.map(({ branch_kind }) => branch_kind),
    ["unstarted", "termination_hold", "preclaim_hold"],
  );
  assert.deepEqual(parsed.result_tuples, []);
  assert.equal(parsed.result_tuples_sha256, sha256("[]"));

  const parsedPreclaim = parsed.terminal_coverage_index.branches[2];
  assert.equal(parsedPreclaim?.branch_kind, "preclaim_hold");
  if (parsedPreclaim?.branch_kind === "preclaim_hold") {
    assert.match(parsedPreclaim.zero_effects_proof_sha256, /^[0-9a-f]{64}$/u);
  }
  const missingZeroEffectsProof = clone(parsed.terminal_coverage_index) as unknown as {
    branches: Array<Record<string, unknown>>;
  };
  delete missingZeroEffectsProof.branches[2]!.zero_effects_proof_sha256;
  assert.throws(() => LearningExternalTerminalCoverageIndexV1Schema.parse(
    missingZeroEffectsProof,
  ));

  const preclaimWithEffect = clone(parsed.terminal_coverage_index);
  const preclaimBranch = preclaimWithEffect.branches[2];
  assert.equal(preclaimBranch?.branch_kind, "preclaim_hold");
  if (preclaimBranch?.branch_kind === "preclaim_hold") {
    preclaimBranch.artifact_count = 1 as never;
  }
  assert.throws(() => LearningExternalTerminalCoverageIndexV1Schema.parse(preclaimWithEffect));
});

test("D1 termination-hold reasons enforce their real supervisor-binding shape", () => {
  const base = terminalCoverageIndex(true);
  const termination = clone(base.branches[1]) as Record<string, unknown>;
  const parse = (terminationReason: string, supervisorBindingId: string | null) =>
    LearningExternalTerminalCoverageIndexV1Schema.parse({
      ...base,
      branches: [
        base.branches[0],
        {
          ...termination,
          termination_reason: terminationReason,
          supervisor_binding_id: supervisorBindingId,
        },
        base.branches[2],
      ],
    });

  assert.doesNotThrow(() => parse("launch_failure", null));
  assert.doesNotThrow(() => parse("binding_integrity_failure", null));
  assert.throws(() => parse("launch_failure", "unexpected-binding"));
  assert.throws(() => parse("binding_integrity_failure", "unexpected-binding"));

  for (const reason of ["runner_crash", "post_quiesce_revoke", "finalize_timeout"]) {
    assert.doesNotThrow(() => parse(reason, "required-binding"));
    assert.throws(() => parse(reason, null));
  }
  for (const reason of ["lease_expired", "operator_revoke"]) {
    assert.doesNotThrow(() => parse(reason, null));
    assert.doesNotThrow(() => parse(reason, "optional-binding"));
  }
});

test("D1 projection and attestation contracts contain factual evidence only, never a release verdict", () => {
  const parsedProjection = LearningExternalIngestionProjectionV1Schema.parse(projection());
  assert.equal("release_verdict" in parsedProjection, false);
  assert.doesNotMatch(stableStringify(parsedProjection), /release_verdict/u);
  assert.throws(() => LearningExternalIngestionProjectionV1Schema.parse({
    ...parsedProjection,
    release_verdict: "eligible",
  }));

  const keys = generateKeyPairSync("ed25519");
  const publicKeyBase64 = rawEd25519PublicKeyBase64(keys.publicKey);
  const body = LearningExternalIngestionAttestationBodyV1Schema.parse({
    contract_version: "aionis_learning_external_ingestion_attestation_v1",
    projection_sha256: learningExternalIngestionProjectionDigest(parsedProjection),
    database_binding_receipt_sha256: parsedProjection.database_binding_receipt_sha256,
    authority_head_sha256: parsedProjection.authority_head.authority_head_sha256,
    attestor_service_identity: "runtime-authority-attestor",
    attestor_binary_sha256: sha256("attestor-binary"),
    attestor_policy_sha256: sha256("attestor-policy"),
    attestor_public_key_sha256: learningExternalEd25519PublicKeyDigest(publicKeyBase64),
    attestor_key_id: "attestor-key-1",
    service_launcher_policy_sha256: sha256("launcher-policy"),
    service_launcher_binary_sha256: sha256("launcher-binary"),
    service_launcher_public_key_sha256: sha256("launcher-public-key"),
    service_launcher_key_id: "launcher-key-1",
    attested_at: "2026-07-17T01:02:05.000Z",
  });
  assert.equal("release_verdict" in body, false);
  assert.throws(() => LearningExternalIngestionAttestationBodyV1Schema.parse({
    ...body,
    release_verdict: "eligible",
  }));
});

test("D1 attestation verifies a real Ed25519 signature and rejects every frozen identity mismatch", () => {
  const keys = TEST_ATTESTOR_KEYS;
  const unrelatedKeys = generateKeyPairSync("ed25519");
  const runtimeAttestor = EXTERNAL_EXECUTION_POLICY.runtime_authority_attestor;
  const publicKeyBase64 = runtimeAttestor.attestor_public_key_base64;
  const unrelatedPublicKeyBase64 = rawEd25519PublicKeyBase64(unrelatedKeys.publicKey);
  const publicKeySha256 = learningExternalEd25519PublicKeyDigest(publicKeyBase64);
  const parsedProjection = LearningExternalIngestionProjectionV1Schema.parse(projection());
  const body = LearningExternalIngestionAttestationBodyV1Schema.parse({
    contract_version: "aionis_learning_external_ingestion_attestation_v1",
    projection_sha256: learningExternalIngestionProjectionDigest(parsedProjection),
    database_binding_receipt_sha256: parsedProjection.database_binding_receipt_sha256,
    authority_head_sha256: parsedProjection.authority_head.authority_head_sha256,
    attestor_service_identity: runtimeAttestor.service_identity,
    attestor_binary_sha256: runtimeAttestor.attestor_binary_sha256,
    attestor_policy_sha256: runtimeAttestor.attestor_policy_sha256,
    attestor_public_key_sha256: publicKeySha256,
    attestor_key_id: runtimeAttestor.attestor_key_id,
    service_launcher_policy_sha256: runtimeAttestor.service_launcher_policy_sha256,
    service_launcher_binary_sha256: runtimeAttestor.service_launcher_binary_sha256,
    service_launcher_public_key_sha256: runtimeAttestor.service_launcher_public_key_sha256,
    service_launcher_key_id: runtimeAttestor.service_launcher_key_id,
    attested_at: "2026-07-17T01:02:05.000Z",
  });
  const envelope = LearningExternalIngestionAttestationEnvelopeV1Schema.parse({
    body,
    signature_algorithm: "ed25519-v1",
    signature_base64: signMessage(
      null,
      Buffer.from(stableStringify(body), "utf8"),
      keys.privateKey,
    ).toString("base64"),
  });
  const signBody = (
    candidateBody: typeof body,
    privateKey: KeyObject = keys.privateKey,
  ) => LearningExternalIngestionAttestationEnvelopeV1Schema.parse({
    body: candidateBody,
    signature_algorithm: "ed25519-v1",
    signature_base64: signMessage(
      null,
      Buffer.from(stableStringify(candidateBody), "utf8"),
      privateKey,
    ).toString("base64"),
  });

  assert.deepEqual(
    verifyLearningExternalIngestionAttestation({
      envelope,
      projection: parsedProjection,
      externalExecutionPolicy: EXTERNAL_EXECUTION_POLICY,
      expectedAttestorServiceIdentity: runtimeAttestor.service_identity,
    }),
    envelope,
  );
  const canonicalAttestation = stableStringify(envelope);
  assert.deepEqual(
    parseCanonicalLearningExternalIngestionAttestationJson(canonicalAttestation),
    envelope,
  );
  assert.throws(
    () => parseCanonicalLearningExternalIngestionAttestationJson(JSON.stringify(envelope)),
    /noncanonical_json/u,
  );
  assert.match(learningExternalIngestionAttestationDigest(envelope), /^[0-9a-f]{64}$/u);
  assert.equal(
    learningExternalIngestionAttestationDigest(envelope),
    learningExternalIngestionAttestationDigest(clone(envelope)),
  );

  const mismatchCases = [
    { ...body, attestor_key_id: "wrong-key-id" },
    { ...body, attestor_service_identity: "wrong-service" },
    { ...body, attestor_policy_sha256: sha256("wrong-policy") },
    { ...body, service_launcher_policy_sha256: sha256("wrong-launcher-policy") },
  ];
  for (const mismatchedBody of mismatchCases) {
    assert.throws(() => verifyLearningExternalIngestionAttestation({
      envelope: signBody(LearningExternalIngestionAttestationBodyV1Schema.parse(mismatchedBody)),
      projection: parsedProjection,
      externalExecutionPolicy: EXTERNAL_EXECUTION_POLICY,
    }), /binding_mismatch/u);
  }

  const wrongSignature = signBody(body, unrelatedKeys.privateKey);
  assert.throws(() => verifyLearningExternalIngestionAttestation({
    envelope: wrongSignature,
    projection: parsedProjection,
    externalExecutionPolicy: EXTERNAL_EXECUTION_POLICY,
  }), /signature_invalid/u);

  const selfSignedBody = LearningExternalIngestionAttestationBodyV1Schema.parse({
    ...body,
    attestor_public_key_sha256:
      learningExternalEd25519PublicKeyDigest(unrelatedPublicKeyBase64),
  });
  assert.throws(() => verifyLearningExternalIngestionAttestation({
    envelope: signBody(selfSignedBody, unrelatedKeys.privateKey),
    projection: parsedProjection,
    externalExecutionPolicy: EXTERNAL_EXECUTION_POLICY,
  }), /binding_mismatch:attestor_public_key_sha256/u);

  const fakePolicyInput = clone(EXTERNAL_EXECUTION_POLICY);
  fakePolicyInput.runtime_authority_attestor.attestor_public_key_base64 =
    unrelatedPublicKeyBase64;
  fakePolicyInput.runtime_authority_attestor.attestor_public_key_sha256 =
    learningExternalEd25519PublicKeyDigest(unrelatedPublicKeyBase64);
  fakePolicyInput.runtime_authority_attestor.attestor_key_id = "self-signed-attacker-key";
  const fakePolicy = ExternalExecutionPolicyV1Schema.parse(fakePolicyInput);
  const fakePolicyBody = LearningExternalIngestionAttestationBodyV1Schema.parse({
    ...body,
    attestor_public_key_sha256:
      fakePolicy.runtime_authority_attestor.attestor_public_key_sha256,
    attestor_key_id: fakePolicy.runtime_authority_attestor.attestor_key_id,
  });
  assert.throws(() => verifyLearningExternalIngestionAttestation({
    envelope: signBody(fakePolicyBody, unrelatedKeys.privateKey),
    projection: parsedProjection,
    externalExecutionPolicy: fakePolicy,
  }), /external_execution_policy_digest_mismatch/u);

  const tampered = clone(envelope);
  tampered.body.attested_at = "2026-07-17T01:02:06.000Z";
  assert.throws(() => verifyLearningExternalIngestionAttestation({
    envelope: tampered,
    projection: parsedProjection,
    externalExecutionPolicy: EXTERNAL_EXECUTION_POLICY,
  }), /signature_invalid/u);

  const wrongPolicy = clone(EXTERNAL_EXECUTION_POLICY);
  wrongPolicy.roles.tool_e2e.broker_policy_sha256 = sha256("wrong-broker-policy");
  assert.throws(() => verifyLearningExternalIngestionAttestation({
    envelope,
    projection: parsedProjection,
    externalExecutionPolicy: wrongPolicy,
  }), /external_execution_policy_digest_mismatch/u);

  assert.throws(() => verifyLearningExternalIngestionAttestation({
    envelope,
    projection: parsedProjection,
    externalExecutionPolicy: EXTERNAL_EXECUTION_POLICY,
    expectedAttestorServiceIdentity: "wrong-service",
  }), /attestor_service_identity_mismatch/u);

  const tamperedProjection = clone(parsedProjection);
  tamperedProjection.ledger_verification_sha256 = sha256("tampered-ledger-verification");
  assert.throws(() => verifyLearningExternalIngestionAttestation({
    envelope,
    projection: tamperedProjection,
    externalExecutionPolicy: EXTERNAL_EXECUTION_POLICY,
  }), /binding_mismatch:projection_sha256/u);

  const wrongPolicyDigestProjection = clone(parsedProjection);
  wrongPolicyDigestProjection.registered_revision.external_execution_policy_sha256 =
    sha256("wrong-external-policy-digest");
  assert.throws(() => verifyLearningExternalIngestionAttestation({
    envelope,
    projection: wrongPolicyDigestProjection,
    externalExecutionPolicy: EXTERNAL_EXECUTION_POLICY,
  }), /external_execution_policy_digest_mismatch/u);

  assert.throws(() => LearningExternalIngestionAttestationEnvelopeV1Schema.parse({
    ...envelope,
    release_verdict: "eligible",
  }));
});

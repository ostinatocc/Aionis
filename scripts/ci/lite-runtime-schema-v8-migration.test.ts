import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  removeExecutionVerifierLaunchV8ObjectsForPreviousSchemaFixture,
  restoreExecutionSemanticEventsV8ForPreviousSchemaFixture,
} from "./schema-fixture-helpers.ts";
import {
  LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_COLUMNS,
  LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_CONSTRAINTS,
  LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_INDEX_NAMES,
  LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TABLE_NAMES,
  LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TRIGGER_NAMES,
  LITE_EXECUTION_VERIFIER_LAUNCH_V8_SCHEMA_SQL,
  migrateLiteExecutionVerifierLaunchV8,
} from "../../src/store/lite-execution-verifier-launch-schema.ts";
import {
  LITE_EXECUTION_SEMANTIC_EVENTS_V9_SCHEMA_SQL,
} from "../../src/store/lite-execution-semantic-event-schema.ts";
import {
  inspectLiteRuntimeSchema,
  LITE_RUNTIME_WRITE_SCHEMA_COMPONENT,
  LITE_RUNTIME_WRITE_SCHEMA_VERSION,
} from "../../src/store/lite-runtime-schema.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import {
  createSqliteDatabase,
  type SqliteDatabase,
} from "../../src/store/sqlite.ts";
import { normalizeSqliteSchemaSql } from
  "../../src/store/sqlite-schema-sql.ts";

const FIXTURE_AT = "2026-07-27T12:00:00.000Z";
const TENANT = "schema-v8-tenant";
const SCOPE = "tenant:schema-v8-tenant:project:migration";
const EPISODE_ID = "schema-v8-episode";
const INVOCATION_ID = "schema-v8-verifier-invocation";
const VERIFIER_DEFINITION_SHA256 = "1".repeat(64);
const VERIFIER_PROGRAM_DIGEST = "2".repeat(64);
const VERIFIER_CONFIG_DIGEST = "3".repeat(64);
const VERIFIER_ENVIRONMENT_DIGEST = "4".repeat(64);
const SUBJECT_IDENTITY_SHA256 = "5".repeat(64);
const INVOCATION_SHA256 = "6".repeat(64);
const OUTPUT_ARTIFACT_ID = "schema-v8-verifier-output";
const OUTPUT_BYTES = Buffer.from(
  "{\"result\":\"runtime-interrupted\"}",
  "utf8",
);
const OUTPUT_SHA256 = sha256(OUTPUT_BYTES);

type TempDatabase = Readonly<{
  directory: string;
  path: string;
}>;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tempDatabase(name: string): TempDatabase {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "aionis-runtime-schema-v8-"),
  );
  return {
    directory,
    path: path.join(directory, `${name}.sqlite`),
  };
}

function requiredV8ObjectNames(): Set<string> {
  return new Set([
    ...LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TABLE_NAMES,
    ...LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_INDEX_NAMES,
    ...LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TRIGGER_NAMES,
  ]);
}

function requiredV8ObjectSnapshot(
  db: SqliteDatabase,
): Array<Readonly<{
  type: string;
  name: string;
  table_name: string;
  sql: string;
}>> {
  const required = requiredV8ObjectNames();
  return (db.prepare(
    `SELECT type, name, tbl_name AS table_name, sql
     FROM sqlite_schema
     WHERE type IN ('table', 'index', 'trigger')
     ORDER BY type, name`,
  ).all() as Array<{
    type: string;
    name: string;
    table_name: string;
    sql: string | null;
  }>)
    .filter((row) => required.has(row.name))
    .map((row) => {
      assert.notEqual(row.sql, null, `${row.type} ${row.name} has no SQL`);
      return {
        type: row.type,
        name: row.name,
        table_name: row.table_name,
        sql: row.sql!,
      };
    });
}

function schemaMetadata(
  db: SqliteDatabase,
): Readonly<{ component: string; version: number; updated_at: string }> {
  const row = db.prepare(
    `SELECT component, version, updated_at
     FROM lite_runtime_schema_metadata
     WHERE component = ?`,
  ).get(LITE_RUNTIME_WRITE_SCHEMA_COMPONENT) as {
    component: string;
    version: number;
    updated_at: string;
  } | undefined;
  assert.ok(row, "write schema metadata is missing");
  return row;
}

async function createCurrentDatabase(dbPath: string): Promise<void> {
  const store = createLiteWriteStore(dbPath, {
    annProjectionEnabled: false,
  });
  await store.close();
}

function declareExactV7(dbPath: string): void {
  const db = createSqliteDatabase(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      removeExecutionVerifierLaunchV8ObjectsForPreviousSchemaFixture(db);
      const changed = db.prepare(
        `UPDATE lite_runtime_schema_metadata
         SET version = ?, updated_at = ?
         WHERE component = ?`,
      ).run(7, FIXTURE_AT, LITE_RUNTIME_WRITE_SCHEMA_COMPONENT);
      assert.equal(Number(changed.changes), 1);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function declareExactV8(dbPath: string): void {
  const db = createSqliteDatabase(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      restoreExecutionSemanticEventsV8ForPreviousSchemaFixture(db);
      const changed = db.prepare(
        `UPDATE lite_runtime_schema_metadata
         SET version = ?, updated_at = ?
         WHERE component = ?`,
      ).run(8, FIXTURE_AT, LITE_RUNTIME_WRITE_SCHEMA_COMPONENT);
      assert.equal(Number(changed.changes), 1);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function assertExactV7(dbPath: string): void {
  const db = createSqliteDatabase(dbPath);
  try {
    const report = inspectLiteRuntimeSchema(db);
    assert.equal(
      report.classification,
      "supported_previous_v7",
      JSON.stringify(report),
    );
    assert.equal(report.detected_version, 7);
    assert.equal(report.current_version, 9);
    assert.equal(report.upgrade_required, true);
    assert.deepEqual(report.problems, []);
    assert.deepEqual(requiredV8ObjectSnapshot(db), []);
  } finally {
    db.close();
  }
}

function insertEvidenceBlob(
  db: SqliteDatabase,
  bytes: Buffer,
  createdAt = FIXTURE_AT,
): string {
  const digest = sha256(bytes);
  db.prepare(
    `INSERT INTO lite_runtime_evidence_blobs
       (tenant_id, blob_sha256, byte_length, content_bytes, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(TENANT, digest, bytes.byteLength, bytes, createdAt);
  return digest;
}

function insertArtifact(
  db: SqliteDatabase,
  args: Readonly<{
    artifactId: string;
    kind:
      | "manifest"
      | "prompt"
      | "state_snapshot"
      | "verifier_input"
      | "verifier_output";
    bytes: Buffer;
  }>,
): string {
  const digest = insertEvidenceBlob(db, args.bytes);
  db.prepare(
    `INSERT INTO lite_runtime_evidence_artifacts
       (tenant_id, scope, artifact_id, episode_id, kind, sha256,
        storage_ref, byte_length, media_type, encoding, redaction_policy,
        retention_policy, retention_until, ingest_mode, source_upload_id,
        artifact_ref_sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
  ).run(
    TENANT,
    SCOPE,
    args.artifactId,
    EPISODE_ID,
    args.kind,
    digest,
    `sqlite-cas://sha256/${digest}`,
    args.bytes.byteLength,
    "application/octet-stream",
    "binary",
    "schema-v8-test-redaction",
    "schema-v8-test-retention",
    "bounded_inline_base64",
    sha256(`artifact-ref:${args.artifactId}:${digest}`),
    FIXTURE_AT,
  );
  return digest;
}

function seedVerifierInvocationFixture(db: SqliteDatabase): void {
  const taskEnvelopeId = "schema-v8-task-envelope";
  const taskManifestId = "schema-v8-task-manifest";
  const sourceTaskId = "schema-v8-source-task";
  const modelConfigId = "schema-v8-model-config";
  const snapshotArtifactId = "schema-v8-state";
  const verifierInputId = "schema-v8-verifier-input";
  const taskEnvelopeSha = insertArtifact(db, {
    artifactId: taskEnvelopeId,
    kind: "manifest",
    bytes: Buffer.from("task-envelope", "utf8"),
  });
  const taskManifestSha = insertArtifact(db, {
    artifactId: taskManifestId,
    kind: "manifest",
    bytes: Buffer.from("task-manifest", "utf8"),
  });
  const sourceTaskSha = insertArtifact(db, {
    artifactId: sourceTaskId,
    kind: "prompt",
    bytes: Buffer.from("source-task", "utf8"),
  });
  const modelConfigSha = insertArtifact(db, {
    artifactId: modelConfigId,
    kind: "manifest",
    bytes: Buffer.from("model-config", "utf8"),
  });
  const snapshotContentSha = insertArtifact(db, {
    artifactId: snapshotArtifactId,
    kind: "state_snapshot",
    bytes: Buffer.from("exact-state", "utf8"),
  });
  insertArtifact(db, {
    artifactId: verifierInputId,
    kind: "verifier_input",
    bytes: Buffer.from("verifier-input", "utf8"),
  });
  insertArtifact(db, {
    artifactId: OUTPUT_ARTIFACT_ID,
    kind: "verifier_output",
    bytes: OUTPUT_BYTES,
  });

  db.prepare(
    `INSERT INTO lite_execution_state_snapshots
       (tenant_id, scope, episode_id, snapshot_id, algorithm_id,
        algorithm_version, state_kind, environment_digest, content_digest,
        artifact_id, snapshot_sha256, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    TENANT,
    SCOPE,
    EPISODE_ID,
    "schema-v8-snapshot",
    "workspace-tree-sha256",
    "workspace-tree-sha256-v1",
    "workspace",
    VERIFIER_ENVIRONMENT_DIGEST,
    snapshotContentSha,
    snapshotArtifactId,
    sha256("snapshot-row"),
    FIXTURE_AT,
  );
  db.prepare(
    `INSERT INTO lite_execution_episodes
       (tenant_id, scope, episode_id, episode_contract_version,
        public_scope, task_id, task_cluster_id, task_cluster_policy_version,
        task_envelope_sha256, task_envelope_artifact_id,
        task_manifest_sha256, task_manifest_artifact_id,
        source_task_sha256, source_task_artifact_id, run_id, model_id,
        model_config_digest, model_config_artifact_id, environment_digest,
        subject_identity_json, subject_identity_sha256,
        required_verifier_id, required_verifier_definition_sha256,
        initial_state_snapshot_id, budget_max_steps, budget_max_tokens,
        budget_max_cost_micros, budget_deadline_ms, episode_sha256,
        opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    TENANT,
    SCOPE,
    EPISODE_ID,
    "decision_episode_v1",
    "project:migration",
    "schema-v8-task",
    "schema-v8-cluster",
    "task-cluster-v1",
    taskEnvelopeSha,
    taskEnvelopeId,
    taskManifestSha,
    taskManifestId,
    sourceTaskSha,
    sourceTaskId,
    "schema-v8-run",
    "schema-v8-model",
    modelConfigSha,
    modelConfigId,
    VERIFIER_ENVIRONMENT_DIGEST,
    "{\"contract_version\":\"execution_episode_subject_identity_v1\"}",
    SUBJECT_IDENTITY_SHA256,
    "schema-v8-verifier",
    VERIFIER_DEFINITION_SHA256,
    "schema-v8-snapshot",
    10,
    10_000,
    null,
    60_000,
    sha256("episode-row"),
    FIXTURE_AT,
  );
  db.prepare(
    `INSERT INTO lite_execution_verifier_invocations
       (tenant_id, scope, episode_id, verifier_invocation_id, verifier_id,
        verifier_definition_sha256, verifier_kind, verifier_version,
        verifier_issuer_id, verifier_runner_instance_id,
        launch_authority_kind, runtime_reservation_digest, principal_id,
        key_id, verifier_program_digest, verifier_config_digest,
        verifier_environment_digest, verified_state_snapshot_id,
        target_state_snapshot_algorithm_version, verifier_input_artifact_id,
        invocation_sha256, invoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?,
             ?, ?, ?)`,
  ).run(
    TENANT,
    SCOPE,
    EPISODE_ID,
    INVOCATION_ID,
    "schema-v8-verifier",
    VERIFIER_DEFINITION_SHA256,
    "independent_executable",
    "v1",
    "aionis-runtime",
    "schema-v8-runner",
    "runtime_launched",
    sha256("runtime-reservation"),
    VERIFIER_PROGRAM_DIGEST,
    VERIFIER_CONFIG_DIGEST,
    VERIFIER_ENVIRONMENT_DIGEST,
    "schema-v8-snapshot",
    "workspace-tree-sha256-v1",
    verifierInputId,
    INVOCATION_SHA256,
    FIXTURE_AT,
  );
}

function attemptValues(args: Readonly<{
  attemptId: string;
  ordinal: number;
  ownerInstanceId: string;
  ownerProcessId: number;
  preparedAt: string;
}>): readonly unknown[] {
  return [
    TENANT,
    SCOPE,
    EPISODE_ID,
    INVOCATION_ID,
    args.attemptId,
    "schema-v8-shared-outcome-operation",
    args.ordinal,
    args.ownerInstanceId,
    args.ownerProcessId,
    INVOCATION_SHA256,
    "7".repeat(64),
    "schema-v8-authority-channel",
    `materialization-${args.ordinal}`,
    `/tmp/schema-v8-subject-${args.ordinal}`,
    `/tmp/schema-v8-scratch-${args.ordinal}`,
    sha256("exact-state"),
    VERIFIER_ENVIRONMENT_DIGEST,
    SUBJECT_IDENTITY_SHA256,
    "8".repeat(64),
    "9".repeat(64),
    VERIFIER_DEFINITION_SHA256,
    VERIFIER_PROGRAM_DIGEST,
    VERIFIER_CONFIG_DIGEST,
    VERIFIER_ENVIRONMENT_DIGEST,
    "a".repeat(64),
    "b".repeat(64),
    "c".repeat(64),
    sha256(`prepared:${args.attemptId}`),
    args.preparedAt,
  ];
}

function insertAttempt(
  db: SqliteDatabase,
  args: Parameters<typeof attemptValues>[0],
): void {
  db.prepare(
    `INSERT INTO lite_execution_verifier_launch_attempts
       (tenant_id, scope, episode_id, verifier_invocation_id,
        launch_attempt_id, outcome_operation_id, attempt_ordinal,
        owner_instance_id, owner_process_id, invocation_sha256,
        invocation_authority_sha256, invocation_authority_channel_id,
        materialization_id, materialized_subject_root,
        materialized_scratch_root, source_content_digest,
        source_environment_digest, subject_identity_sha256,
        subject_view_content_digest, subject_view_environment_digest,
        verifier_definition_sha256, verifier_program_digest,
        verifier_config_digest, verifier_environment_digest,
        execution_pack_manifest_sha256, resolved_config_digest,
        resolved_environment_digest, prepared_sha256, prepared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(...attemptValues(args));
}

function insertLaunchCommitted(
  db: SqliteDatabase,
  args: Readonly<{
    attemptId: string;
    ownerInstanceId: string;
    ownerProcessId: number;
    eventSha256: string;
    recordedAt: string;
  }>,
): void {
  db.prepare(
    `INSERT INTO lite_execution_verifier_launch_attempt_events
       (tenant_id, scope, episode_id, verifier_invocation_id,
        launch_attempt_id, event_sequence, event_kind,
        event_owner_instance_id, event_owner_process_id,
        previous_event_sha256, event_sha256, spawned_process_id,
        verifier_output_artifact_id, verifier_output_sha256,
        runtime_launch_sha256, result_sha256, effective_status,
        infrastructure_failure_reasons_json,
        infrastructure_failure_attribution, recorded_at)
     VALUES (?, ?, ?, ?, ?, 0, 'launch_committed', ?, ?, NULL, ?, NULL,
             NULL, NULL, NULL, NULL, NULL, '[]', NULL, ?)`,
  ).run(
    TENANT,
    SCOPE,
    EPISODE_ID,
    INVOCATION_ID,
    args.attemptId,
    args.ownerInstanceId,
    args.ownerProcessId,
    args.eventSha256,
    args.recordedAt,
  );
}

test("fresh Runtime creates the exact two-table v8 contract and reopens idempotently", async () => {
  const temp = tempDatabase("fresh-current-v8");
  try {
    await createCurrentDatabase(temp.path);
    const firstDb = createSqliteDatabase(temp.path);
    let firstObjects: ReturnType<typeof requiredV8ObjectSnapshot>;
    let firstMetadata: ReturnType<typeof schemaMetadata>;
    try {
      const report = inspectLiteRuntimeSchema(firstDb);
      assert.equal(LITE_RUNTIME_WRITE_SCHEMA_VERSION, 9);
      assert.equal(report.classification, "current", JSON.stringify(report));
      assert.equal(report.detected_version, 9);
      assert.equal(report.current_version, 9);
      assert.equal(report.upgrade_required, false);
      assert.deepEqual(report.problems, []);
      assert.doesNotMatch(
        LITE_EXECUTION_VERIFIER_LAUNCH_V8_SCHEMA_SQL,
        /snapshot\.sequence/u,
      );
      assert.match(
        LITE_EXECUTION_VERIFIER_LAUNCH_V8_SCHEMA_SQL,
        /snapshot\.snapshot_id\s*=\s*invocation\.verified_state_snapshot_id/u,
      );
      assert.deepEqual(
        [...LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TABLE_NAMES],
        [
          "lite_execution_verifier_launch_attempt_events",
          "lite_execution_verifier_launch_attempts",
        ],
      );
      assert.equal(
        firstDb.prepare(
          `SELECT 1 AS present
           FROM sqlite_schema
           WHERE type = 'table'
             AND name = 'lite_execution_verifier_launch_terminals'`,
        ).get(),
        undefined,
      );
      const attemptColumns =
        LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_COLUMNS
          .lite_execution_verifier_launch_attempts ?? [];
      for (const column of [
        "outcome_operation_id",
        "attempt_ordinal",
        "invocation_authority_sha256",
        "subject_identity_sha256",
        "execution_pack_manifest_sha256",
        "resolved_config_digest",
        "resolved_environment_digest",
        "prepared_sha256",
      ]) {
        assert.ok(attemptColumns.includes(column), column);
      }
      const eventColumns =
        LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_COLUMNS
          .lite_execution_verifier_launch_attempt_events ?? [];
      for (const column of [
        "event_sequence",
        "event_kind",
        "event_owner_instance_id",
        "event_owner_process_id",
        "previous_event_sha256",
        "verifier_output_sha256",
      ]) {
        assert.ok(eventColumns.includes(column), column);
      }
      firstObjects = requiredV8ObjectSnapshot(firstDb);
      firstMetadata = schemaMetadata(firstDb);
      assert.equal(firstObjects.length, requiredV8ObjectNames().size);
    } finally {
      firstDb.close();
    }

    const reopened = createLiteWriteStore(temp.path, {
      annProjectionEnabled: false,
    });
    await reopened.close();
    const secondDb = createSqliteDatabase(temp.path);
    try {
      assert.deepEqual(requiredV8ObjectSnapshot(secondDb), firstObjects);
      assert.deepEqual(schemaMetadata(secondDb), firstMetadata);
    } finally {
      secondDb.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("an exact v8 database upgrades to the semantic-event v9 contract", async () => {
  const temp = tempDatabase("exact-v8-to-v9");
  try {
    await createCurrentDatabase(temp.path);
    declareExactV8(temp.path);
    const before = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteRuntimeSchema(before);
      assert.equal(
        report.classification,
        "supported_previous_v8",
        JSON.stringify(report),
      );
      assert.equal(report.detected_version, 8);
      const eventSql = (
        before.prepare(
          `SELECT sql
           FROM sqlite_schema
           WHERE type = 'table'
             AND name = 'lite_execution_episode_events'`,
        ).get() as { sql: string }
      ).sql;
      assert.doesNotMatch(
        eventSql,
        /semantic_observation_recorded/u,
      );
    } finally {
      before.close();
    }

    const migrated = createLiteWriteStore(temp.path, {
      annProjectionEnabled: false,
    });
    await migrated.close();

    const after = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteRuntimeSchema(after);
      assert.equal(report.classification, "current", JSON.stringify(report));
      assert.equal(report.detected_version, 9);
      const eventSql = (
        after.prepare(
          `SELECT sql
           FROM sqlite_schema
           WHERE type = 'table'
             AND name = 'lite_execution_episode_events'`,
        ).get() as { sql: string }
      ).sql;
      assert.equal(
        normalizeSqliteSchemaSql(eventSql),
        normalizeSqliteSchemaSql(
          LITE_EXECUTION_SEMANTIC_EVENTS_V9_SCHEMA_SQL,
        ),
      );
      assert.deepEqual(
        after.prepare("PRAGMA foreign_key_check").all(),
        [],
      );
    } finally {
      after.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("an exact v7 database upgrades to v8 without changing v7 evidence rows", async () => {
  const temp = tempDatabase("exact-v7-to-v8");
  const preservedBytes = Buffer.from("preserve-v7-evidence", "utf8");
  try {
    await createCurrentDatabase(temp.path);
    const seedDb = createSqliteDatabase(temp.path);
    let preservedDigest: string;
    try {
      preservedDigest = insertEvidenceBlob(seedDb, preservedBytes);
    } finally {
      seedDb.close();
    }
    declareExactV7(temp.path);
    assertExactV7(temp.path);

    const migrated = createLiteWriteStore(temp.path, {
      annProjectionEnabled: false,
    });
    await migrated.close();

    const afterDb = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteRuntimeSchema(afterDb);
      assert.equal(report.classification, "current", JSON.stringify(report));
      assert.equal(report.detected_version, 9);
      assert.equal(schemaMetadata(afterDb).version, 9);
      const preserved = afterDb.prepare(
        `SELECT byte_length, content_bytes
         FROM lite_runtime_evidence_blobs
         WHERE tenant_id = ? AND blob_sha256 = ?`,
      ).get(TENANT, preservedDigest) as {
        byte_length: number;
        content_bytes: Uint8Array;
      } | undefined;
      assert.ok(preserved);
      assert.equal(preserved.byte_length, preservedBytes.byteLength);
      assert.deepEqual(Buffer.from(preserved.content_bytes), preservedBytes);
      assert.equal(
        requiredV8ObjectSnapshot(afterDb).length,
        requiredV8ObjectNames().size,
      );
    } finally {
      afterDb.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("v8 attempt events allow ordinal retry only after an immutable interrupted terminal", async () => {
  const temp = tempDatabase("attempt-event-state-machine");
  try {
    await createCurrentDatabase(temp.path);
    const db = createSqliteDatabase(temp.path);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("BEGIN IMMEDIATE");
      seedVerifierInvocationFixture(db);
      const attemptOne = {
        attemptId: "schema-v8-attempt-1",
        ordinal: 1,
        ownerInstanceId: "runtime-owner-1",
        ownerProcessId: 41001,
        preparedAt: "2026-07-27T12:00:01.000Z",
      };
      insertAttempt(db, attemptOne);
      const launchOneSha = sha256("attempt-1-launch-committed");
      insertLaunchCommitted(db, {
        attemptId: attemptOne.attemptId,
        ownerInstanceId: attemptOne.ownerInstanceId,
        ownerProcessId: attemptOne.ownerProcessId,
        eventSha256: launchOneSha,
        recordedAt: attemptOne.preparedAt,
      });

      assert.throws(
        () => insertAttempt(db, {
          attemptId: "schema-v8-attempt-too-early",
          ordinal: 2,
          ownerInstanceId: "runtime-owner-2",
          ownerProcessId: 41002,
          preparedAt: "2026-07-27T12:00:02.000Z",
        }),
        /execution_verifier_launch_attempt_binding_invalid/u,
      );

      const interruptedSha = sha256("attempt-1-interrupted");
      db.prepare(
        `INSERT INTO lite_execution_verifier_launch_attempt_events
           (tenant_id, scope, episode_id, verifier_invocation_id,
            launch_attempt_id, event_sequence, event_kind,
            event_owner_instance_id, event_owner_process_id,
            previous_event_sha256, event_sha256, spawned_process_id,
            verifier_output_artifact_id, verifier_output_sha256,
            runtime_launch_sha256, result_sha256, effective_status,
            infrastructure_failure_reasons_json,
            infrastructure_failure_attribution, recorded_at)
         VALUES (?, ?, ?, ?, ?, 1, 'interrupted', ?, ?, ?, ?, NULL, ?, ?,
                 NULL, NULL, 'infrastructure_error', ?,
                 'arm_caused', ?)`,
      ).run(
        TENANT,
        SCOPE,
        EPISODE_ID,
        INVOCATION_ID,
        attemptOne.attemptId,
        "runtime-recovery-owner",
        42001,
        launchOneSha,
        interruptedSha,
        OUTPUT_ARTIFACT_ID,
        OUTPUT_SHA256,
        "[\"runtime_process_interrupted\"]",
        "2026-07-27T12:00:02.000Z",
      );

      const attemptTwo = {
        attemptId: "schema-v8-attempt-2",
        ordinal: 2,
        ownerInstanceId: "runtime-owner-2",
        ownerProcessId: 41002,
        preparedAt: "2026-07-27T12:00:03.000Z",
      };
      insertAttempt(db, attemptTwo);
      insertLaunchCommitted(db, {
        attemptId: attemptTwo.attemptId,
        ownerInstanceId: attemptTwo.ownerInstanceId,
        ownerProcessId: attemptTwo.ownerProcessId,
        eventSha256: sha256("attempt-2-launch-committed"),
        recordedAt: attemptTwo.preparedAt,
      });

      assert.throws(
        () => db.prepare(
          `INSERT INTO lite_execution_verifier_launch_attempt_events
             (tenant_id, scope, episode_id, verifier_invocation_id,
              launch_attempt_id, event_sequence, event_kind,
              event_owner_instance_id, event_owner_process_id,
              previous_event_sha256, event_sha256, spawned_process_id,
              verifier_output_artifact_id, verifier_output_sha256,
              runtime_launch_sha256, result_sha256, effective_status,
              infrastructure_failure_reasons_json,
              infrastructure_failure_attribution, recorded_at)
           VALUES (?, ?, ?, ?, ?, 1, 'completed', ?, ?, ?, ?, NULL, ?, ?, ?,
                   ?, 'passed', '[]', NULL, ?)`,
        ).run(
          TENANT,
          SCOPE,
          EPISODE_ID,
          INVOCATION_ID,
          attemptTwo.attemptId,
          attemptTwo.ownerInstanceId,
          attemptTwo.ownerProcessId,
          sha256("attempt-2-launch-committed"),
          sha256("attempt-2-pass-without-spawn"),
          OUTPUT_ARTIFACT_ID,
          OUTPUT_SHA256,
          sha256("attempt-2-runtime-launch-without-spawn"),
          sha256("attempt-2-result-without-spawn"),
          "2026-07-27T12:00:04.000Z",
        ),
        /execution_verifier_launch_attempt_event_sequence_invalid/u,
      );

      assert.throws(
        () => db.prepare(
          `INSERT INTO lite_execution_verifier_launch_attempt_events
             (tenant_id, scope, episode_id, verifier_invocation_id,
              launch_attempt_id, event_sequence, event_kind,
              event_owner_instance_id, event_owner_process_id,
              previous_event_sha256, event_sha256, spawned_process_id,
              verifier_output_artifact_id, verifier_output_sha256,
              runtime_launch_sha256, result_sha256, effective_status,
              infrastructure_failure_reasons_json,
              infrastructure_failure_attribution, recorded_at)
           VALUES (?, ?, ?, ?, ?, 1, 'spawn_observed', ?, ?, ?, ?, ?, NULL,
                   NULL, NULL, NULL, NULL, '[]', NULL, ?)`,
        ).run(
          TENANT,
          SCOPE,
          EPISODE_ID,
          INVOCATION_ID,
          attemptTwo.attemptId,
          "different-runtime-owner",
          49999,
          sha256("attempt-2-launch-committed"),
          sha256("attempt-2-wrong-owner-spawn"),
          45001,
          "2026-07-27T12:00:04.000Z",
        ),
        /execution_verifier_launch_attempt_event_sequence_invalid/u,
      );

      assert.throws(
        () => db.prepare(
          `INSERT INTO lite_execution_verifier_launch_attempt_events
             (tenant_id, scope, episode_id, verifier_invocation_id,
              launch_attempt_id, event_sequence, event_kind,
              event_owner_instance_id, event_owner_process_id,
              previous_event_sha256, event_sha256, spawned_process_id,
              verifier_output_artifact_id, verifier_output_sha256,
              runtime_launch_sha256, result_sha256, effective_status,
              infrastructure_failure_reasons_json,
              infrastructure_failure_attribution, recorded_at)
           VALUES (?, ?, ?, ?, ?, 2, 'completed', ?, ?, ?, ?, NULL, ?, ?, ?,
                   ?, 'failed', '[]', NULL, ?)`,
        ).run(
          TENANT,
          SCOPE,
          EPISODE_ID,
          INVOCATION_ID,
          attemptOne.attemptId,
          attemptOne.ownerInstanceId,
          attemptOne.ownerProcessId,
          interruptedSha,
          sha256("attempt-1-illegal-revival"),
          OUTPUT_ARTIFACT_ID,
          OUTPUT_SHA256,
          sha256("illegal-runtime-launch"),
          sha256("illegal-result"),
          "2026-07-27T12:00:04.000Z",
        ),
        /execution_verifier_launch_attempt_event_sequence_invalid/u,
      );

      const ordinals = db.prepare(
        `SELECT attempt_ordinal, outcome_operation_id
         FROM lite_execution_verifier_launch_attempts
         WHERE tenant_id = ? AND scope = ? AND episode_id = ?
           AND verifier_invocation_id = ?
         ORDER BY attempt_ordinal`,
      ).all(TENANT, SCOPE, EPISODE_ID, INVOCATION_ID) as Array<{
        attempt_ordinal: number;
        outcome_operation_id: string;
      }>;
      assert.deepEqual(ordinals.map((row) => ({ ...row })), [
        {
          attempt_ordinal: 1,
          outcome_operation_id: "schema-v8-shared-outcome-operation",
        },
        {
          attempt_ordinal: 2,
          outcome_operation_id: "schema-v8-shared-outcome-operation",
        },
      ]);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the first fixture failure.
      }
      throw error;
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("partial and conflicting v8 structures fail closed", async () => {
  const partial = tempDatabase("partial-v8");
  const conflict = tempDatabase("conflicting-v8");
  try {
    await createCurrentDatabase(partial.path);
    declareExactV7(partial.path);
    const partialDb = createSqliteDatabase(partial.path);
    try {
      const attemptTable =
        LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_CONSTRAINTS
          .lite_execution_verifier_launch_attempts;
      assert.ok(attemptTable);
      partialDb.exec(attemptTable.sql);
      const report = inspectLiteRuntimeSchema(partialDb);
      assert.equal(report.classification, "incompatible");
      assert.ok(
        report.problems.includes(
          "schema metadata is older than v8 but v8 verifier-launch objects already exist",
        ),
        JSON.stringify(report),
      );
    } finally {
      partialDb.close();
    }
    assert.throws(
      () => createLiteWriteStore(partial.path, {
        annProjectionEnabled: false,
      }),
      /lite_runtime_schema_preflight_failed/u,
    );

    await createCurrentDatabase(conflict.path);
    declareExactV7(conflict.path);
    const conflictDb = createSqliteDatabase(conflict.path);
    try {
      conflictDb.exec(LITE_EXECUTION_VERIFIER_LAUNCH_V8_SCHEMA_SQL);
      conflictDb.exec(
        `DROP TRIGGER
           trg_lite_execution_verifier_launch_attempts_no_update`,
      );
      conflictDb.exec(
        `CREATE TRIGGER
           trg_lite_execution_verifier_launch_attempts_no_update
         BEFORE UPDATE ON lite_execution_verifier_launch_attempts
         BEGIN
           SELECT RAISE(ABORT, 'wrong_v8_trigger_definition');
         END`,
      );
      assert.throws(
        () => migrateLiteExecutionVerifierLaunchV8(conflictDb),
        /lite_execution_verifier_launch_v8_schema_conflict/u,
      );
    } finally {
      conflictDb.close();
    }
  } finally {
    fs.rmSync(partial.directory, { recursive: true, force: true });
    fs.rmSync(conflict.directory, { recursive: true, force: true });
  }
});

test("a v8 migration fault rolls DDL and metadata back to exact v7", async () => {
  const temp = tempDatabase("v8-fault-rollback");
  const preservedBytes = Buffer.from("preserved-through-v8-fault", "utf8");
  try {
    await createCurrentDatabase(temp.path);
    const seedDb = createSqliteDatabase(temp.path);
    let preservedDigest: string;
    try {
      preservedDigest = insertEvidenceBlob(seedDb, preservedBytes);
    } finally {
      seedDb.close();
    }
    declareExactV7(temp.path);
    assertExactV7(temp.path);

    assert.throws(
      () => createLiteWriteStore(temp.path, {
        annProjectionEnabled: false,
        schemaMigrationFaultInjector: (phase) => {
          if (phase === "after_execution_verifier_launch_structures") {
            throw new Error("intentional_v8_migration_fault");
          }
        },
      }),
      /intentional_v8_migration_fault/u,
    );

    const rolledBackDb = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteRuntimeSchema(rolledBackDb);
      assert.equal(
        report.classification,
        "supported_previous_v7",
        JSON.stringify(report),
      );
      assert.equal(schemaMetadata(rolledBackDb).version, 7);
      assert.deepEqual(requiredV8ObjectSnapshot(rolledBackDb), []);
      const preserved = rolledBackDb.prepare(
        `SELECT content_bytes
         FROM lite_runtime_evidence_blobs
         WHERE tenant_id = ? AND blob_sha256 = ?`,
      ).get(TENANT, preservedDigest) as {
        content_bytes: Uint8Array;
      } | undefined;
      assert.ok(preserved);
      assert.deepEqual(Buffer.from(preserved.content_bytes), preservedBytes);
    } finally {
      rolledBackDb.close();
    }

    const recovered = createLiteWriteStore(temp.path, {
      annProjectionEnabled: false,
    });
    await recovered.close();
    const recoveredDb = createSqliteDatabase(temp.path);
    try {
      assert.equal(
        inspectLiteRuntimeSchema(recoveredDb).classification,
        "current",
      );
      assert.equal(schemaMetadata(recoveredDb).version, 9);
      assert.equal(
        requiredV8ObjectSnapshot(recoveredDb).length,
        requiredV8ObjectNames().size,
      );
    } finally {
      recoveredDb.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTINUATION_RUNTIME_V1_APPLICATION_ID,
  CONTINUATION_RUNTIME_V1_TABLES,
  CONTINUATION_RUNTIME_V1_USER_VERSION,
  assertContinuationRuntimeV1Schema,
  captureContinuationRuntimeV1SchemaManifest,
  loadContinuationRuntimeV1Ddl,
  loadContinuationRuntimeV1SchemaManifest,
  parseContinuationRuntimeV1SchemaManifest,
} from "../../src/store/continuation-runtime-v1-schema.ts";
import {
  checkContinuationRuntimeV1SchemaManifest,
  generateContinuationRuntimeV1SchemaManifest,
  writeContinuationRuntimeV1SchemaManifest,
} from "../../tools/generate-continuation-runtime-v1-manifest.ts";
import { createSqliteDatabase, type SqliteDatabase } from "../../src/store/sqlite.ts";
import { sha256Hex } from "../../src/util/crypto.ts";

const SQL_NOW = "2026-07-21T12:00:00.000Z";
const SQL_LATER = "2026-07-21T12:00:00.001Z";
const SQL_LEASE_EXPIRY = "2026-07-21T12:01:00.001Z";
const SQL_WINDOW_EVENT = "2026-07-21T10:30:00.000Z";
const SQL_WINDOW_OUTCOME = "2026-07-21T10:45:00.000Z";
const EMPTY_SET_SHA256 =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

function withBootstrappedDatabase(run: (db: SqliteDatabase) => void): void {
  const database = createSqliteDatabase(":memory:");
  try {
    database.exec(loadContinuationRuntimeV1Ddl());
    run(database);
  } finally {
    database.close();
  }
}

function insertRawOperation(database: SqliteDatabase, args: {
  tenant?: string;
  scope?: string;
  kind: "record_observations" | "create_continuation" | "record_outcome"
    | "authority_decision" | "worker_completion";
  id: string;
  requestSha256?: string;
  actorKind?: "trusted_host" | "operator" | "worker";
}): string {
  const requestSha256 = args.requestSha256 ?? sha256Hex(`request:${args.id}`);
  const expectedActor = args.kind === "authority_decision"
    ? "operator"
    : args.kind === "worker_completion" ? "worker" : "trusted_host";
  database.prepare(`INSERT INTO operations(
    tenant_id, scope, operation_kind, operation_id, actor_kind,
    actor_principal_sha256, request_sha256, request_json, receipt_sha256,
    receipt_json, completed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, '{}', ?)`)
    .run(
      args.tenant ?? "tenant",
      args.scope ?? "scope",
      args.kind,
      args.id,
      args.actorKind ?? expectedActor,
      "1".repeat(64),
      requestSha256,
      sha256Hex(`receipt:${args.id}`),
      SQL_NOW,
    );
  return requestSha256;
}

function insertMemoryCommit(database: SqliteDatabase, args: {
  revision: number;
  id: string;
  sha256: string;
  sourceOperationId: string;
  sourceRequestSha256: string;
  requestSha256?: string;
  actorPrincipalSha256?: string;
  parent?: Readonly<{ revision: number; id: string; sha256: string }>;
}): void {
  database.prepare(`INSERT INTO memory_commits(
    tenant_id, scope, revision, commit_id, commit_sha256, parent_revision,
    parent_commit_id, parent_commit_sha256, request_sha256,
    source_operation_kind, source_operation_id, source_request_sha256,
    mutation_sha256, mutation_json, actor_kind, actor_principal_sha256,
    created_at
  ) VALUES ('tenant', 'scope', ?, ?, ?, ?, ?, ?, ?, 'record_observations',
    ?, ?, ?, '{}', 'trusted_host', ?, ?)`)
    .run(
      args.revision,
      args.id,
      args.sha256,
      args.parent?.revision ?? null,
      args.parent?.id ?? null,
      args.parent?.sha256 ?? null,
      args.requestSha256 ?? args.sourceRequestSha256,
      args.sourceOperationId,
      args.sourceRequestSha256,
      sha256Hex(`mutation:${args.id}`),
      args.actorPrincipalSha256 ?? "1".repeat(64),
      SQL_NOW,
    );
}

function insertMemoryHead(database: SqliteDatabase, args: {
  commitId: string;
  commitSha256: string;
  sourceOperationId: string;
  sourceRequestSha256: string;
}): void {
  database.prepare(`INSERT INTO memory_scope_heads(
    tenant_id, scope, head_revision, head_commit_id, head_commit_sha256,
    head_sha256, source_operation_kind, source_operation_id,
    source_request_sha256, updated_at
  ) VALUES ('tenant', 'scope', 1, ?, ?, ?, 'record_observations', ?, ?, ?)`)
    .run(
      args.commitId,
      args.commitSha256,
      sha256Hex(`head:${args.commitId}`),
      args.sourceOperationId,
      args.sourceRequestSha256,
      SQL_NOW,
    );
}

type DecisionEpisodeKind = "contract_exposed" | "capsule_use_observed"
  | "outcome_observed" | "effect_certified";

type DecisionEventRef = Readonly<{
  episodeId: string;
  sequence: number;
  id: string;
  kind: DecisionEpisodeKind;
  sha256: string;
  createdAt: string;
}>;

function insertDecisionEpisodeEvent(database: SqliteDatabase, args: Readonly<{
  tenant?: string;
  scope?: string;
  episodeId?: string;
  eventSequence: number;
  eventId: string;
  eventKind: DecisionEpisodeKind;
  sourceOperationId: string;
  sourceRequestSha256?: string;
  previous?: DecisionEventRef;
  cause?: DecisionEventRef;
  decisionId?: string;
  renderResultSha256?: string | null;
  authoritySubjectSha256?: string;
  branchManifestSha256?: string;
  effectCertificateSha256?: string;
  effectMemberSequence?: number;
  capsuleFactCount?: number;
  capsuleFactSetSha256?: string;
  payloadJson?: string;
  createdAt?: string;
}>): DecisionEventRef {
  const tenant = args.tenant ?? "tenant";
  const scope = args.scope ?? "scope";
  const episodeId = args.episodeId ?? "episode-a";
  const decisionId = args.decisionId ?? "decision-a";
  const payloadJson = args.payloadJson ?? "{}";
  const eventSha256 = sha256Hex(`event:${args.eventId}`);
  const createdAt = args.createdAt ?? SQL_WINDOW_EVENT;
  const factBearing = args.eventKind === "contract_exposed"
    || args.eventKind === "capsule_use_observed";
  const factCount = factBearing ? args.capsuleFactCount ?? 0 : null;
  const factSetSha256 = factBearing
    ? args.capsuleFactSetSha256
      ?? (factCount === 0 ? EMPTY_SET_SHA256 : sha256Hex(`fact-set:${args.eventId}`))
    : null;
  const sourceOperationKind = args.eventKind === "contract_exposed"
    ? "create_continuation"
    : args.eventKind === "effect_certified" ? "worker_completion" : "record_outcome";
  database.prepare(`INSERT INTO episode_events(
    tenant_id, scope, episode_id, event_sequence, event_id, event_kind,
    source_operation_kind, source_operation_id, source_request_sha256,
    previous_event_sequence, previous_event_sha256,
    cause_event_sequence, cause_event_id, cause_event_kind, cause_event_sha256,
    effect_member_sequence, capsule_fact_count, capsule_fact_set_sha256,
    decision_id, run_id, host_task_envelope_sha256, contract_sha256,
    coverage_certificate_sha256, render_result_sha256,
    authority_subject_sha256, branch_manifest_sha256,
    serving_mode, experiment_cohort_artifact_sha256,
    experiment_cohort_payload_sha256, serving_assignment_receipt_sha256,
    effect_certificate_sha256, payload_sha256, payload_json, event_sha256,
    created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    tenant,
    scope,
    episodeId,
    args.eventSequence,
    args.eventId,
    args.eventKind,
    sourceOperationKind,
    args.sourceOperationId,
    args.sourceRequestSha256 ?? sha256Hex(`request:${args.sourceOperationId}`),
    args.previous?.sequence ?? null,
    args.previous?.sha256 ?? null,
    args.cause?.sequence ?? null,
    args.cause?.id ?? null,
    args.cause?.kind ?? null,
    args.cause?.sha256 ?? null,
    args.effectMemberSequence ?? null,
    factCount,
    factSetSha256,
    decisionId,
    `run:${decisionId}`,
    sha256Hex(`host-task:${decisionId}`),
    sha256Hex(`contract:${decisionId}`),
    sha256Hex(`coverage:${decisionId}`),
    args.renderResultSha256 === undefined
      ? sha256Hex(`render-result:${decisionId}`)
      : args.renderResultSha256,
    args.authoritySubjectSha256 ?? sha256Hex(`authority:${decisionId}`),
    args.branchManifestSha256 ?? sha256Hex(`branch:${decisionId}`),
    args.eventKind === "contract_exposed" ? "authoritative_unassigned" : null,
    null,
    null,
    null,
    args.effectCertificateSha256 ?? null,
    sha256Hex(payloadJson),
    payloadJson,
    eventSha256,
    createdAt,
  );
  return {
    episodeId,
    sequence: args.eventSequence,
    id: args.eventId,
    kind: args.eventKind,
    sha256: eventSha256,
    createdAt,
  };
}

function insertEpisodeCapsuleFact(database: SqliteDatabase, args: Readonly<{
  event: DecisionEventRef;
  sequence: number;
  capsuleId: string;
  useState: "used" | "not_used" | "unknown" | "invalid" | null;
  tenant?: string;
  scope?: string;
  surface?: "use_now" | "inspect_before_use" | "do_not_use" | "rehydrate";
}>): void {
  database.prepare(`INSERT INTO episode_capsule_facts(
    tenant_id, scope, episode_id, event_sequence, event_id, event_kind,
    event_sha256, fact_sequence, capsule_scope, capsule_id,
    capsule_revision, capsule_sha256, surface, use_state, fact_sha256
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(
    args.tenant ?? "tenant",
    args.scope ?? "scope",
    args.event.episodeId,
    args.event.sequence,
    args.event.id,
    args.event.kind,
    args.event.sha256,
    args.sequence,
    args.scope ?? "scope",
    args.capsuleId,
    sha256Hex(`capsule:${args.capsuleId}`),
    args.surface ?? "use_now",
    args.useState,
    sha256Hex(`fact:${args.event.id}:${args.sequence}:${args.capsuleId}`),
  );
}

function insertQueuedJob(database: SqliteDatabase, args: {
  id: string;
  sourceOperationId: string;
  sourceRequestSha256: string;
}): void {
  database.prepare(`INSERT INTO durable_jobs(
    tenant_id, scope, task_family, authority_subject_sha256,
    job_id, job_kind, dedupe_key, source_operation_kind,
    source_operation_id, source_request_sha256, state, priority,
    attempt_count, max_attempts, payload_sha256, payload_json,
    initial_available_at, available_at,
    created_at, updated_at
  ) VALUES ('tenant', 'scope', 'test-family', ?, ?, 'embedding', ?,
    'record_observations', ?, ?,
    'queued', 0, 0, 3, ?, '{}', ?, ?, ?, ?)`)
    .run(
      sha256Hex("authority:test-family"),
      args.id,
      `dedupe-${args.id}`,
      args.sourceOperationId,
      args.sourceRequestSha256,
      sha256Hex("{}"),
      SQL_NOW,
      SQL_NOW,
      SQL_NOW,
      SQL_NOW,
    );
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("continuation Runtime V1 manifest is generated from the sole DDL with real SQLite", () => {
  const generated = generateContinuationRuntimeV1SchemaManifest();
  const checkedIn = loadContinuationRuntimeV1SchemaManifest();

  assert.deepEqual(generated, checkedIn);
  assert.equal(generated.application_id, CONTINUATION_RUNTIME_V1_APPLICATION_ID);
  assert.equal(generated.user_version, CONTINUATION_RUNTIME_V1_USER_VERSION);
  assert.deepEqual(generated.tables, [...CONTINUATION_RUNTIME_V1_TABLES]);
  assert.equal(generated.tables.length, 17);
  assert.equal(generated.table_xinfo.length, 17);
  assert.equal(generated.foreign_key_list.length, 17);

  const autoindexes = generated.sqlite_schema.filter(
    (row) => row.type === "index" && row.name.startsWith("sqlite_autoindex_"),
  );
  assert.ok(autoindexes.length > 0, "the manifest must exercise SQLite autoindex capture");
  for (const autoindex of autoindexes) {
    assert.equal(autoindex.sql_sha256, null);
    assert.ok(
      generated.index_xinfo.some((entry) => entry.index_name === autoindex.name),
      `missing index_xinfo for ${autoindex.name}`,
    );
  }

  withBootstrappedDatabase((database) => {
    assert.deepEqual(captureContinuationRuntimeV1SchemaManifest(database), checkedIn);
    assert.doesNotThrow(() => assertContinuationRuntimeV1Schema(database, checkedIn));

    const columnNames = (table: string): Set<string> => {
      const rows = database.prepare(
        `PRAGMA table_xinfo(${quoteIdentifier(table)})`,
      ).all() as unknown as Array<{ name: string }>;
      return new Set(rows.map((row) => row.name));
    };
    const certificateColumns = columnNames("effect_certificates");
    for (const required of [
      "compiler_policy_artifact_sha256",
      "compiler_policy_payload_sha256",
      "compiler_policy_kind",
      "effect_verifier_contract_sha256",
      "statistical_contract_sha256",
      "eligible_decision_count",
      "eligible_decision_set_sha256",
      "effect_evaluation_sha256",
      "effect_evaluation_json",
      "experiment_cohort_artifact_sha256",
      "experiment_cohort_installation_receipt_sha256",
      "settlement_cutoff_at",
      "treatment_delta_count",
      "treatment_delta_set_sha256",
      "verifier_public_key_spki_base64url",
    ]) {
      assert.ok(certificateColumns.has(required), `missing effect certificate column ${required}`);
    }
    for (const removed of [
      "capsule_claim_count",
      "capsule_claim_set_sha256",
      "eligible_episode_count",
      "eligible_episodes_json",
      "uncertainty_json",
    ]) {
      assert.equal(certificateColumns.has(removed), false, `legacy certificate column ${removed}`);
    }

    const eventColumns = columnNames("episode_events");
    for (const required of [
      "cause_event_sequence",
      "cause_event_id",
      "cause_event_kind",
      "cause_event_sha256",
      "effect_member_sequence",
      "capsule_fact_count",
      "capsule_fact_set_sha256",
    ]) {
      assert.ok(eventColumns.has(required), `missing episode event column ${required}`);
    }
    for (const removed of [
      "exposure_event_sequence",
      "exposure_event_sha256",
      "use_event_sequence",
      "use_event_sha256",
      "memory_id",
    ]) {
      assert.equal(eventColumns.has(removed), false, `legacy episode event column ${removed}`);
    }

    const factColumns = columnNames("episode_capsule_facts");
    for (const required of ["event_sha256", "fact_sequence", "use_state"]) {
      assert.ok(factColumns.has(required), `missing capsule fact column ${required}`);
    }
    for (const removed of [
      "effect_certificate_sha256",
      "effect_claim",
      "contract_sha256",
      "coverage_certificate_sha256",
      "created_at",
    ]) {
      assert.equal(factColumns.has(removed), false, `legacy capsule fact column ${removed}`);
    }

    const foreignKeyRows = database.prepare(
      "PRAGMA foreign_key_list(effect_certificates)",
    ).all() as unknown as Array<{ table: string; from: string }>;
    const artifactForeignKeyColumns = new Set(foreignKeyRows
      .filter((row) => row.table === "authority_artifacts")
      .map((row) => row.from));
    assert.deepEqual(
      [...artifactForeignKeyColumns].sort(),
      [
        "compiler_policy_artifact_sha256",
        "compiler_policy_kind",
        "compiler_policy_payload_sha256",
        "experiment_cohort_artifact_sha256",
        "experiment_cohort_kind",
        "experiment_cohort_payload_sha256",
        "evidence_policy_artifact_sha256",
        "evidence_policy_kind",
        "evidence_policy_payload_sha256",
        "tenant_id",
        "trust_root_sha256",
      ].sort(),
    );
  });
});

test("manifest tool --write output is canonical and --check accepts only the generated snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "aionis-continuation-schema-"));
  const manifestPath = join(directory, "continuation-runtime-v1.manifest.json");
  try {
    const written = writeContinuationRuntimeV1SchemaManifest(manifestPath);
    assert.deepEqual(checkContinuationRuntimeV1SchemaManifest(manifestPath), written);

    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(manifestPath, `${JSON.stringify({ ...parsed, unexpected: true }, null, 2)}\n`);
    assert.throws(
      () => checkContinuationRuntimeV1SchemaManifest(manifestPath),
      /unrecognized key|unexpected/iu,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema assertion rejects extra and missing SQLite objects", () => {
  const manifest = loadContinuationRuntimeV1SchemaManifest();

  withBootstrappedDatabase((database) => {
    database.exec("CREATE TABLE unexpected_runtime_table (id INTEGER PRIMARY KEY) STRICT");
    assert.throws(
      () => assertContinuationRuntimeV1Schema(database, manifest),
      /continuation_runtime_v1_schema_mismatch:extra_schema_object:table:unexpected_runtime_table/u,
    );
  });

  const removableIndex = manifest.sqlite_schema.find(
    (row) => row.type === "index" && row.sql_sha256 !== null,
  );
  assert.ok(removableIndex, "the V1 schema must have an explicit index to exercise removal");
  withBootstrappedDatabase((database) => {
    database.exec(`DROP INDEX ${quoteIdentifier(removableIndex.name)}`);
    assert.throws(
      () => assertContinuationRuntimeV1Schema(database, manifest),
      new RegExp(
        `continuation_runtime_v1_schema_mismatch:missing_schema_object:index:${escapeRegExp(removableIndex.name)}`,
        "u",
      ),
    );
  });
});

test("schema assertion rejects changed objects and database identity pragmas", () => {
  const manifest = loadContinuationRuntimeV1SchemaManifest();
  const changeableIndex = manifest.sqlite_schema.find(
    (row) => row.type === "index" && row.sql_sha256 !== null,
  );
  assert.ok(changeableIndex, "the V1 schema must have an explicit index to exercise replacement");

  withBootstrappedDatabase((database) => {
    const column = database.prepare(
      `SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid LIMIT 1`,
    ).get(changeableIndex.table_name) as { name: string } | undefined;
    assert.ok(column, `no visible column for ${changeableIndex.table_name}`);
    database.exec(`
      DROP INDEX ${quoteIdentifier(changeableIndex.name)};
      CREATE INDEX ${quoteIdentifier(changeableIndex.name)}
      ON ${quoteIdentifier(changeableIndex.table_name)} (${quoteIdentifier(column.name)} DESC)
      WHERE 1 = 1;
    `);
    assert.throws(
      () => assertContinuationRuntimeV1Schema(database, manifest),
      new RegExp(
        `continuation_runtime_v1_schema_mismatch:changed_schema_object:index:${escapeRegExp(changeableIndex.name)}`,
        "u",
      ),
    );
  });

  withBootstrappedDatabase((database) => {
    database.exec(`PRAGMA application_id = ${CONTINUATION_RUNTIME_V1_APPLICATION_ID - 1}`);
    assert.throws(
      () => assertContinuationRuntimeV1Schema(database, manifest),
      /continuation_runtime_v1_schema_mismatch:changed_application_id/u,
    );
  });

  withBootstrappedDatabase((database) => {
    database.exec(`PRAGMA user_version = ${CONTINUATION_RUNTIME_V1_USER_VERSION + 1}`);
    assert.throws(
      () => assertContinuationRuntimeV1Schema(database, manifest),
      /continuation_runtime_v1_schema_mismatch:changed_user_version/u,
    );
  });
});

test("manifest parser rejects unknown fields and a forged canonical snapshot SHA", () => {
  const manifest = loadContinuationRuntimeV1SchemaManifest();
  assert.throws(
    () => parseContinuationRuntimeV1SchemaManifest({ ...manifest, unexpected: true }),
    /unrecognized key/iu,
  );
  assert.throws(
    () => parseContinuationRuntimeV1SchemaManifest({
      ...manifest,
      schema_sha256: "0".repeat(64),
    }),
    /continuation_runtime_v1_schema_manifest_invalid:schema_sha256/u,
  );
  assert.throws(
    () => parseContinuationRuntimeV1SchemaManifest({
      ...manifest,
      ddl_sha256: "0".repeat(64),
    }),
    /continuation_runtime_v1_schema_manifest_invalid:ddl_sha256/u,
  );
});

test("direct roots may precede their receipt in one transaction, but the receipt must exist at commit", () => {
  withBootstrappedDatabase((database) => {
    const operationId = "observation-child-first";
    const requestSha256 = sha256Hex(`request:${operationId}`);
    const commitSha256 = sha256Hex("commit:child-first");
    database.exec("BEGIN IMMEDIATE");
    insertMemoryCommit(database, {
      revision: 1,
      id: "commit-child-first",
      sha256: commitSha256,
      sourceOperationId: operationId,
      sourceRequestSha256: requestSha256,
    });
    insertMemoryHead(database, {
      commitId: "commit-child-first",
      commitSha256,
      sourceOperationId: operationId,
      sourceRequestSha256: requestSha256,
    });
    insertRawOperation(database, {
      kind: "record_observations",
      id: operationId,
      requestSha256,
    });
    assert.doesNotThrow(() => database.exec("COMMIT"));
    assert.equal(
      Number((database.prepare(
        "SELECT count(*) AS count FROM memory_commits",
      ).get() as { count: number }).count),
      1,
    );
  });

  withBootstrappedDatabase((database) => {
    database.exec("BEGIN IMMEDIATE");
    insertMemoryCommit(database, {
      revision: 1,
      id: "commit-no-receipt",
      sha256: sha256Hex("commit:no-receipt"),
      sourceOperationId: "missing-operation",
      sourceRequestSha256: sha256Hex("request:missing-operation"),
    });
    assert.throws(() => database.exec("COMMIT"), /FOREIGN KEY constraint failed/iu);
    assert.doesNotThrow(() => database.exec("ROLLBACK"));
  });
});

test("memory commits bind the exact source request and actor principal", () => {
  withBootstrappedDatabase((database) => {
    const operationId = "request-drift";
    const sourceRequestSha256 = sha256Hex(`request:${operationId}`);
    assert.throws(() => insertMemoryCommit(database, {
      revision: 1,
      id: "commit-request-drift",
      sha256: sha256Hex("commit:request-drift"),
      sourceOperationId: operationId,
      sourceRequestSha256,
      requestSha256: sha256Hex("different-commit-request"),
    }), /CHECK constraint failed|invalid branch_revisions transition/iu);
  });

  withBootstrappedDatabase((database) => {
    const operationId = "actor-drift";
    const requestSha256 = sha256Hex(`request:${operationId}`);
    database.exec("BEGIN IMMEDIATE");
    insertMemoryCommit(database, {
      revision: 1,
      id: "commit-actor-drift",
      sha256: sha256Hex("commit:actor-drift"),
      sourceOperationId: operationId,
      sourceRequestSha256: requestSha256,
      actorPrincipalSha256: "2".repeat(64),
    });
    insertRawOperation(database, {
      kind: "record_observations",
      id: operationId,
      requestSha256,
    });
    assert.throws(() => database.exec("COMMIT"), /FOREIGN KEY constraint failed/iu);
    assert.doesNotThrow(() => database.exec("ROLLBACK"));
  });
});

test("an unparented child commit fails at commit and a completed receipt cannot be borrowed", () => {
  withBootstrappedDatabase((database) => {
    const operationId = "unparented-child";
    const requestSha256 = sha256Hex(`request:${operationId}`);
    database.exec("BEGIN IMMEDIATE");
    insertMemoryCommit(database, {
      revision: 2,
      id: "commit-unparented",
      sha256: sha256Hex("commit:unparented"),
      sourceOperationId: operationId,
      sourceRequestSha256: requestSha256,
      parent: {
        revision: 1,
        id: "missing-parent",
        sha256: sha256Hex("commit:missing-parent"),
      },
    });
    insertRawOperation(database, {
      kind: "record_observations",
      id: operationId,
      requestSha256,
    });
    assert.throws(() => database.exec("COMMIT"), /FOREIGN KEY constraint failed/iu);
    assert.doesNotThrow(() => database.exec("ROLLBACK"));
  });

  withBootstrappedDatabase((database) => {
    const requestSha256 = insertRawOperation(database, {
      kind: "record_observations",
      id: "already-completed",
    });
    assert.throws(() => insertMemoryCommit(database, {
      revision: 1,
      id: "late-child",
      sha256: sha256Hex("commit:late-child"),
      sourceOperationId: "already-completed",
      sourceRequestSha256: requestSha256,
    }), /source operation is already completed/iu);
  });
});

test("memory heads reject source drift from the exact target commit", () => {
  withBootstrappedDatabase((database) => {
    const commitRequest = sha256Hex("request:commit-source");
    database.exec("BEGIN IMMEDIATE");
    insertMemoryCommit(database, {
      revision: 1,
      id: "commit-source",
      sha256: sha256Hex("commit:source"),
      sourceOperationId: "commit-source-operation",
      sourceRequestSha256: commitRequest,
    });
    assert.throws(() => insertMemoryHead(database, {
      commitId: "commit-source",
      commitSha256: sha256Hex("commit:source"),
      sourceOperationId: "different-head-operation",
      sourceRequestSha256: sha256Hex("request:different-head-operation"),
    }), /invalid memory_scope_heads initial target/iu);
    assert.doesNotThrow(() => database.exec("ROLLBACK"));
  });
});

test("operation actor roles are closed and fixed to operation kind", () => {
  withBootstrappedDatabase((database) => {
    assert.throws(() => insertRawOperation(database, {
      kind: "record_observations",
      id: "wrong-actor",
      actorKind: "operator",
    }), /CHECK constraint failed/iu);
    assert.throws(() => database.prepare(`INSERT INTO operations(
      tenant_id, scope, operation_kind, operation_id, actor_kind,
      actor_principal_sha256, request_sha256, request_json, receipt_sha256,
      receipt_json, completed_at
    ) VALUES ('tenant', 'scope', 'authority_decision', 'bad-principal',
      'operator', ?, ?, '{}', ?, '{}', ?)`)
      .run(
        "A".repeat(64),
        sha256Hex("request:bad-principal"),
        sha256Hex("receipt:bad-principal"),
        SQL_NOW,
      ), /CHECK constraint failed/iu);
  });
});

test("operation request evidence is required and kind-bounded at the schema boundary", () => {
  withBootstrappedDatabase((database) => {
    // Isolate the request_json CHECK from the independent worker/job
    // completion-lineage guard exercised by the durable-job schema tests.
    database.exec("DROP TRIGGER operations_worker_completion_job_guard");
    const insert = (
      kind: "record_observations" | "worker_completion",
      id: string,
      requestJson: string,
    ) => database.prepare(`INSERT INTO operations(
      tenant_id, scope, operation_kind, operation_id, actor_kind,
      actor_principal_sha256, request_sha256, request_json, receipt_sha256,
      receipt_json, completed_at
    ) VALUES ('tenant', 'scope', ?, ?, ?, ?, ?, ?, ?, '{}', ?)`)
      .run(
        kind,
        id,
        kind === "worker_completion" ? "worker" : "trusted_host",
        "1".repeat(64),
        sha256Hex(requestJson),
        requestJson,
        sha256Hex(`receipt:${id}`),
        SQL_NOW,
      );

    assert.throws(
      () => insert("record_observations", "invalid-json", "{"),
      /CHECK constraint failed/iu,
    );
    assert.throws(
      () => insert(
        "record_observations",
        "oversized-host",
        JSON.stringify({ body: "x".repeat(1_048_576) }),
      ),
      /CHECK constraint failed/iu,
    );
    assert.doesNotThrow(() => insert(
      "worker_completion",
      "bounded-worker",
      JSON.stringify({ body: "x".repeat(2_000_000) }),
    ));
    assert.throws(
      () => insert(
        "worker_completion",
        "oversized-worker",
        JSON.stringify({ body: "x".repeat(8_388_608) }),
      ),
      /CHECK constraint failed/iu,
    );
    assert.equal(Number((database.prepare(
      "SELECT count(*) AS count FROM operations",
    ).get() as { count: number }).count), 1);
  });
});

test("episode cause tuples and fact-closed receipts fail closed", () => {
  withBootstrappedDatabase((database) => {
    database.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys = ON;");
    assert.throws(() => insertDecisionEpisodeEvent(database, {
      episodeId: "episode-missing-render-result",
      eventSequence: 1,
      eventId: "missing-render-result",
      eventKind: "contract_exposed",
      sourceOperationId: "missing-render-result-operation",
      decisionId: "decision-missing-render-result",
      renderResultSha256: null,
    }), /CHECK constraint failed/iu);
    assert.throws(() => insertDecisionEpisodeEvent(database, {
      episodeId: "episode-too-many-facts",
      eventSequence: 1,
      eventId: "too-many-facts",
      eventKind: "contract_exposed",
      sourceOperationId: "too-many-facts-operation",
      decisionId: "decision-too-many-facts",
      capsuleFactCount: 257,
    }), /CHECK constraint failed/iu);

    const exposure = insertDecisionEpisodeEvent(database, {
      eventSequence: 1,
      eventId: "exposure-a",
      eventKind: "contract_exposed",
      sourceOperationId: "create-a",
      capsuleFactCount: 3,
      payloadJson: "{\"render_result\":{\"status\":\"not_renderable\"}}",
    });
    for (const [index, capsuleId] of [
      "capsule-used",
      "capsule-not-used",
      "capsule-unknown",
    ].entries()) {
      insertEpisodeCapsuleFact(database, {
        event: exposure,
        sequence: index + 1,
        capsuleId,
        useState: null,
      });
    }
    assert.throws(() => insertEpisodeCapsuleFact(database, {
      event: exposure,
      sequence: 257,
      capsuleId: "capsule-fact-257",
      useState: null,
    }), /exact event header|CHECK constraint failed/iu);
    assert.doesNotThrow(() => insertRawOperation(database, {
      kind: "create_continuation",
      id: "create-a",
    }));
    assert.throws(() => insertEpisodeCapsuleFact(database, {
      event: exposure,
      sequence: 1,
      capsuleId: "late-exposure-fact",
      useState: null,
    }), /cannot follow the operation receipt/iu);

    const forgedCause = { ...exposure, sha256: sha256Hex("forged-exposure") };
    assert.throws(() => insertDecisionEpisodeEvent(database, {
      eventSequence: 2,
      eventId: "use-forged-cause",
      eventKind: "capsule_use_observed",
      sourceOperationId: "record-a",
      previous: exposure,
      cause: forgedCause,
      capsuleFactCount: 3,
    }), /exact decision cause/iu);

    const crossEpisodeExposure = insertDecisionEpisodeEvent(database, {
      episodeId: "other-episode",
      eventSequence: 1,
      eventId: "other-exposure",
      eventKind: "contract_exposed",
      sourceOperationId: "other-create",
      decisionId: "other-decision",
      capsuleFactCount: 3,
    });
    assert.throws(() => insertDecisionEpisodeEvent(database, {
      eventSequence: 2,
      eventId: "use-cross-episode-cause",
      eventKind: "capsule_use_observed",
      sourceOperationId: "record-a",
      previous: exposure,
      cause: crossEpisodeExposure,
      capsuleFactCount: 3,
    }), /exact decision cause/iu);

    const use = insertDecisionEpisodeEvent(database, {
      eventSequence: 2,
      eventId: "use-a",
      eventKind: "capsule_use_observed",
      sourceOperationId: "record-a",
      previous: exposure,
      cause: exposure,
      capsuleFactCount: 3,
    });
    assert.throws(() => insertEpisodeCapsuleFact(database, {
      event: use,
      sequence: 1,
      capsuleId: "capsule-used",
      useState: "invalid",
    }), /CHECK constraint failed/iu);
    insertEpisodeCapsuleFact(database, {
      event: use,
      sequence: 1,
      capsuleId: "capsule-used",
      useState: "used",
    });

    const forgedUse = { ...use, id: "forged-use" };
    assert.throws(() => insertDecisionEpisodeEvent(database, {
      eventSequence: 3,
      eventId: "outcome-forged-cause",
      eventKind: "outcome_observed",
      sourceOperationId: "record-a",
      previous: use,
      cause: forgedUse,
      createdAt: SQL_WINDOW_OUTCOME,
    }), /exact decision cause/iu);

    const outcome = insertDecisionEpisodeEvent(database, {
      eventSequence: 3,
      eventId: "outcome-a",
      eventKind: "outcome_observed",
      sourceOperationId: "record-a",
      previous: use,
      cause: use,
      createdAt: SQL_WINDOW_OUTCOME,
    });
    assert.throws(() => insertRawOperation(database, {
      kind: "record_outcome",
      id: "record-a",
    }), /episode event or capsule fact set is incomplete/iu);

    insertEpisodeCapsuleFact(database, {
      event: use,
      sequence: 2,
      capsuleId: "capsule-not-used",
      useState: "not_used",
    });
    insertEpisodeCapsuleFact(database, {
      event: use,
      sequence: 3,
      capsuleId: "capsule-unknown",
      useState: "unknown",
    });
    assert.doesNotThrow(() => insertRawOperation(database, {
      kind: "record_outcome",
      id: "record-a",
    }));
    assert.throws(() => insertEpisodeCapsuleFact(database, {
      event: use,
      sequence: 2,
      capsuleId: "capsule-not-used",
      useState: "unknown",
    }), /cannot follow the operation receipt/iu);
    assert.throws(() => insertDecisionEpisodeEvent(database, {
      eventSequence: 4,
      eventId: "duplicate-outcome-a",
      eventKind: "outcome_observed",
      sourceOperationId: "record-duplicate-outcome",
      previous: outcome,
      cause: use,
      createdAt: SQL_NOW,
    }), /UNIQUE constraint failed/iu);
    database.exec("ROLLBACK");
  });

  for (const missing of ["both", "outcome"] as const) {
    withBootstrappedDatabase((database) => {
      database.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys = ON;");
      if (missing === "outcome") {
        const exposure = insertDecisionEpisodeEvent(database, {
          eventSequence: 1,
          eventId: "missing-outcome-exposure",
          eventKind: "contract_exposed",
          sourceOperationId: "missing-outcome-create",
          capsuleFactCount: 0,
        });
        insertDecisionEpisodeEvent(database, {
          eventSequence: 2,
          eventId: "missing-outcome-use",
          eventKind: "capsule_use_observed",
          sourceOperationId: "missing-outcome-operation",
          previous: exposure,
          cause: exposure,
          capsuleFactCount: 0,
        });
      }
      assert.throws(() => insertRawOperation(database, {
        kind: "record_outcome",
        id: missing === "both" ? "missing-both-operation" : "missing-outcome-operation",
      }), /episode event or capsule fact set is incomplete/iu);
      database.exec("ROLLBACK");
    });
  }

  withBootstrappedDatabase((database) => {
    database.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys = ON;");
    const exposure = insertDecisionEpisodeEvent(database, {
      eventSequence: 1,
      eventId: "fact-gap-exposure",
      eventKind: "contract_exposed",
      sourceOperationId: "fact-gap-create",
      capsuleFactCount: 2,
    });
    insertEpisodeCapsuleFact(database, {
      event: exposure,
      sequence: 2,
      capsuleId: "fact-gap-capsule",
      useState: null,
    });
    assert.throws(() => insertRawOperation(database, {
      kind: "create_continuation",
      id: "fact-gap-create",
    }), /episode event or capsule fact set is incomplete/iu);
    assert.throws(() => insertEpisodeCapsuleFact(database, {
      event: exposure,
      sequence: 3,
      capsuleId: "fact-extra-capsule",
      useState: null,
    }), /exact event header/iu);
    database.exec("ROLLBACK");
  });
});
test("effect schema persists exact treatment deltas without per-capsule effect claims", () => {
  withBootstrappedDatabase((database) => {
    const tables = new Set((database.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table'",
    ).all() as Array<{ name: string }>).map((row) => row.name));
    assert.equal(tables.has("effect_certificate_treatment_members"), true);
    assert.equal(tables.has("effect_certificate_capsule_claims"), false);

    const certificateColumns = new Set((database.prepare(
      "PRAGMA table_xinfo(effect_certificates)",
    ).all() as Array<{ name: string }>).map((row) => row.name));
    for (const column of [
      "experiment_cohort_artifact_sha256",
      "experiment_cohort_installation_receipt_sha256",
      "assignment_seed_commitment_sha256",
      "assignment_seed_reveal",
      "effect_evaluation_sha256",
      "effect_evaluation_json",
      "treatment_delta_count",
      "treatment_delta_set_sha256",
      "settlement_cutoff_at",
    ]) assert.equal(certificateColumns.has(column), true, column);
    for (const legacy of [
      "uncertainty_json",
      "capsule_claim_count",
      "capsule_claim_set_sha256",
    ]) assert.equal(certificateColumns.has(legacy), false, legacy);

    const treatmentColumns = new Set((database.prepare(
      "PRAGMA table_xinfo(effect_certificate_treatment_members)",
    ).all() as Array<{ name: string }>).map((row) => row.name));
    assert.deepEqual([...treatmentColumns].sort(), [
      "after_binding_json",
      "before_binding_json",
      "capsule_id",
      "capsule_scope",
      "certificate_sha256",
      "change_kind",
      "member_sequence",
      "member_sha256",
      "tenant_id",
      "treatment_delta_set_sha256",
    ]);

    database.exec("PRAGMA foreign_keys = OFF");
    const binding = JSON.stringify({
      admission_authority: "candidate",
      capsule: {
        capsule_id: "capsule-a",
        capsule_revision: 1,
        capsule_sha256: "a".repeat(64),
      },
      capsule_scope: "scope",
      disposition: "include",
    });
    const insert = database.prepare(`INSERT INTO effect_certificate_treatment_members(
      tenant_id, certificate_sha256, treatment_delta_set_sha256,
      member_sequence, capsule_scope, capsule_id, change_kind,
      before_binding_json, after_binding_json, member_sha256
    ) VALUES ('tenant', ?, ?, ?, 'scope', ?, ?, ?, ?, ?)`);
    assert.doesNotThrow(() => insert.run(
      "b".repeat(64),
      "c".repeat(64),
      1,
      "capsule-a",
      "added",
      null,
      binding,
      "d".repeat(64),
    ));
    assert.throws(() => insert.run(
      "e".repeat(64),
      "f".repeat(64),
      1,
      "capsule-a",
      "added",
      binding,
      binding,
      "1".repeat(64),
    ), /CHECK constraint failed/iu);
    assert.throws(() => insert.run(
      "2".repeat(64),
      "3".repeat(64),
      1,
      "capsule-other",
      "added",
      null,
      binding,
      "4".repeat(64),
    ), /CHECK constraint failed/iu);
    assert.throws(() => database.exec(
      "UPDATE effect_certificate_treatment_members SET change_kind='removed'",
    ), /immutable/iu);

    const guard = database.prepare(`SELECT sql FROM sqlite_schema
      WHERE type='trigger' AND name='operations_effect_certificate_sets_guard'`)
      .get() as { sql: string };
    assert.match(guard.sql, /effect_certificate_treatment_members/u);
    assert.match(guard.sql, /treatment_delta_count/u);
    assert.doesNotMatch(guard.sql, /capsule_claim/u);
  });
});
test("branch genesis, candidate identity, and exact same-branch revert rules fail closed", () => {
  withBootstrappedDatabase((database) => {
    type BranchArgs = Readonly<{
      sourceKind: "record_observations" | "authority_decision";
      sourceId: string;
      branchId: string;
      revision: number;
      manifestSha256: string;
      branchKind: "authoritative" | "candidate";
      state: "authoritative" | "draft";
      baseBranchId?: string;
      previousManifestSha256?: string;
      effectCertificateSha256?: string;
      revert?: Readonly<{ branchId: string; revision: number; manifestSha256: string }>;
    }>;
    const subject = sha256Hex("authority-subject");
    const compilerArtifact = sha256Hex("compiler-artifact");
    const compilerPayload = sha256Hex("compiler-payload");
    const evidenceArtifact = sha256Hex("evidence-artifact");
    const evidencePayload = sha256Hex("evidence-payload");
    const insertBranch = (args: BranchArgs): void => {
      const candidate = args.branchKind === "candidate";
      database.prepare(`INSERT INTO branch_revisions(
        tenant_id, source_operation_scope, source_operation_kind,
        source_operation_id, source_request_sha256,
        authority_subject_sha256, branch_id, branch_revision, manifest_sha256,
        branch_kind, state, base_branch_id, base_branch_revision,
        base_manifest_sha256, base_branch_kind, base_branch_state,
        previous_branch_revision, previous_revision_sha256,
        compiler_policy_artifact_sha256, compiler_policy_payload_sha256,
        compiler_policy_kind, evidence_policy_artifact_sha256,
        evidence_policy_payload_sha256, evidence_policy_kind,
        effect_certificate_sha256, reverts_branch_id,
        reverts_branch_revision, reverts_authority_revision_sha256,
        reverts_branch_kind, reverts_branch_state, manifest_json, created_at
      ) VALUES ('tenant', 'scope', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, 'compiler_policy', ?, ?, 'evidence_policy', ?, ?, ?, ?, ?,
        ?, '{}', ?)`)
        .run(
          args.sourceKind,
          args.sourceId,
          sha256Hex(`request:${args.sourceId}`),
          subject,
          args.branchId,
          args.revision,
          args.manifestSha256,
          args.branchKind,
          args.state,
          candidate ? args.baseBranchId ?? "base" : null,
          candidate ? 1 : null,
          candidate ? sha256Hex("base-manifest") : null,
          candidate ? "authoritative" : null,
          candidate ? "authoritative" : null,
          args.revision > 1 ? args.revision - 1 : null,
          args.revision > 1
            ? args.previousManifestSha256 ?? sha256Hex(`previous:${args.branchId}`)
            : null,
          compilerArtifact,
          compilerPayload,
          evidenceArtifact,
          evidencePayload,
          args.effectCertificateSha256 ?? null,
          args.revert?.branchId ?? null,
          args.revert?.revision ?? null,
          args.revert?.manifestSha256 ?? null,
          args.revert ? "authoritative" : null,
          args.revert ? "authoritative" : null,
          SQL_NOW,
        );
    };
    const beginDeferred = (): void => {
      database.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys = ON;");
    };
    const rollback = (): void => database.exec("ROLLBACK");

    beginDeferred();
    const genesisManifest = sha256Hex("genesis-manifest");
    assert.doesNotThrow(() => insertBranch({
      sourceKind: "record_observations",
      sourceId: "genesis-observation",
      branchId: "authoritative-main",
      revision: 1,
      manifestSha256: genesisManifest,
      branchKind: "authoritative",
      state: "authoritative",
    }));
    assert.doesNotThrow(() => database.prepare(`INSERT INTO authority_heads(
      tenant_id, source_operation_scope, source_operation_kind,
      source_operation_id, source_request_sha256, authority_subject_sha256,
      head_revision, branch_id, branch_revision, manifest_sha256, branch_kind,
      branch_state, head_sha256, updated_at
    ) VALUES ('tenant', 'scope', 'record_observations', 'genesis-observation',
      ?, ?, 1, 'authoritative-main', 1, ?, 'authoritative', 'authoritative',
      ?, ?)`)
      .run(
        sha256Hex("request:genesis-observation"),
        subject,
        genesisManifest,
        sha256Hex("authority-head:1"),
        SQL_NOW,
      ));
    assert.throws(() => database.prepare(`UPDATE authority_heads SET
      source_operation_kind = 'record_observations',
      source_operation_id = 'observation-cannot-upgrade',
      source_request_sha256 = ?, head_revision = 2, branch_revision = 2,
      manifest_sha256 = ?, head_sha256 = ?, updated_at = ?
      WHERE tenant_id = 'tenant' AND authority_subject_sha256 = ?`)
      .run(
        sha256Hex("request:observation-cannot-upgrade"),
        sha256Hex("manifest:forbidden-upgrade"),
        sha256Hex("authority-head:2"),
        SQL_LATER,
        subject,
      ), /invalid authority_heads advance/iu);
    rollback();

    beginDeferred();
    assert.throws(() => insertBranch({
      sourceKind: "authority_decision",
      sourceId: "operator-cannot-create-genesis",
      branchId: "operator-authoritative-genesis",
      revision: 1,
      manifestSha256: sha256Hex("operator-authoritative-genesis"),
      branchKind: "authoritative",
      state: "authoritative",
    }), /CHECK constraint failed|invalid branch_revisions transition/iu);
    rollback();

    beginDeferred();
    const prooflessGenesis = sha256Hex("proofless-genesis");
    insertBranch({
      sourceKind: "record_observations",
      sourceId: "proofless-genesis-observation",
      branchId: "proofless-main",
      revision: 1,
      manifestSha256: prooflessGenesis,
      branchKind: "authoritative",
      state: "authoritative",
    });
    assert.throws(() => insertBranch({
      sourceKind: "authority_decision",
      sourceId: "proofless-authority-update",
      branchId: "proofless-main",
      revision: 2,
      previousManifestSha256: prooflessGenesis,
      manifestSha256: sha256Hex("proofless-authority-update"),
      branchKind: "authoritative",
      state: "authoritative",
    }), /CHECK constraint failed/iu);
    assert.throws(() => insertBranch({
      sourceKind: "authority_decision",
      sourceId: "unadmitted-authority-update",
      branchId: "proofless-main",
      revision: 2,
      previousManifestSha256: prooflessGenesis,
      manifestSha256: sha256Hex("unadmitted-authority-update"),
      branchKind: "authoritative",
      state: "authoritative",
      effectCertificateSha256: sha256Hex("unadmitted-certificate"),
    }), /authoritative revision does not bind an admitted exact certificate/iu);
    rollback();

    for (const forbidden of [
      {
        sourceId: "observation-candidate",
        branchId: "candidate-a",
        revision: 1,
        manifestSha256: sha256Hex("observation-candidate"),
        branchKind: "candidate" as const,
        state: "draft" as const,
        baseBranchId: "authoritative-main",
      },
      {
        sourceId: "observation-later-authority",
        branchId: "authoritative-main",
        revision: 2,
        manifestSha256: sha256Hex("observation-later-authority"),
        branchKind: "authoritative" as const,
        state: "authoritative" as const,
      },
    ]) {
      beginDeferred();
      assert.throws(() => insertBranch({
        sourceKind: "record_observations",
        ...forbidden,
      }), /CHECK constraint failed|invalid branch_revisions transition/iu);
      rollback();
    }

    beginDeferred();
    assert.throws(() => insertBranch({
      sourceKind: "authority_decision",
      sourceId: "candidate-same-id",
      branchId: "authoritative-main",
      revision: 1,
      manifestSha256: sha256Hex("candidate-same-id"),
      branchKind: "candidate",
      state: "draft",
      baseBranchId: "authoritative-main",
    }), /CHECK constraint failed|invalid branch_revisions transition/iu);
    rollback();

    for (const [label, revert] of [
      ["cross-branch", {
        branchId: "other-branch", revision: 1,
        manifestSha256: sha256Hex("other-revision"),
      }],
      ["future-revision", {
        branchId: "authoritative-main", revision: 2,
        manifestSha256: sha256Hex("future-revision"),
      }],
    ] as const) {
      beginDeferred();
      const priorManifest = sha256Hex(`revert-prior:${label}`);
      insertBranch({
        sourceKind: "record_observations",
        sourceId: `revert-prior-observation-${label}`,
        branchId: "authoritative-main",
        revision: 1,
        manifestSha256: priorManifest,
        branchKind: "authoritative",
        state: "authoritative",
      });
      assert.throws(() => insertBranch({
        sourceKind: "authority_decision",
        sourceId: `revert-${label}`,
        branchId: "authoritative-main",
        revision: 2,
        previousManifestSha256: priorManifest,
        manifestSha256: sha256Hex(`revert-manifest:${label}`),
        branchKind: "authoritative",
        state: "authoritative",
        revert,
      }), /CHECK constraint failed/iu);
      rollback();
    }

    beginDeferred();
    const exclusivePriorManifest = sha256Hex("revert-effect-prior");
    insertBranch({
      sourceKind: "record_observations",
      sourceId: "revert-effect-prior-observation",
      branchId: "authoritative-main",
      revision: 1,
      manifestSha256: exclusivePriorManifest,
      branchKind: "authoritative",
      state: "authoritative",
    });
    assert.throws(() => insertBranch({
      sourceKind: "authority_decision",
      sourceId: "revert-effect-exclusive",
      branchId: "authoritative-main",
      revision: 2,
      previousManifestSha256: exclusivePriorManifest,
      manifestSha256: sha256Hex("revert-effect-exclusive"),
      branchKind: "authoritative",
      state: "authoritative",
      effectCertificateSha256: sha256Hex("effect-certificate"),
      revert: {
        branchId: "authoritative-main",
        revision: 1,
        manifestSha256: sha256Hex("prior-authority"),
      },
    }), /CHECK constraint failed|authoritative revision does not bind/iu);
    rollback();

    beginDeferred();
    const mainManifest = sha256Hex("head-main-genesis");
    const otherManifest = sha256Hex("head-other-genesis");
    const otherRevision = sha256Hex("head-other-revision-2");
    insertBranch({
      sourceKind: "record_observations",
      sourceId: "head-main-observation",
      branchId: "head-main",
      revision: 1,
      manifestSha256: mainManifest,
      branchKind: "authoritative",
      state: "authoritative",
    });
    database.prepare(`INSERT INTO authority_heads(
      tenant_id, source_operation_scope, source_operation_kind,
      source_operation_id, source_request_sha256, authority_subject_sha256,
      head_revision, branch_id, branch_revision, manifest_sha256, branch_kind,
      branch_state, head_sha256, updated_at
    ) VALUES ('tenant', 'scope', 'record_observations',
      'head-main-observation', ?, ?, 1, 'head-main', 1, ?, 'authoritative',
      'authoritative', ?, ?)`)
      .run(
        sha256Hex("request:head-main-observation"),
        subject,
        mainManifest,
        sha256Hex("head-main:1"),
        SQL_NOW,
      );
    insertBranch({
      sourceKind: "record_observations",
      sourceId: "head-other-observation",
      branchId: "head-other",
      revision: 1,
      manifestSha256: otherManifest,
      branchKind: "authoritative",
      state: "authoritative",
    });
    insertBranch({
      sourceKind: "authority_decision",
      sourceId: "head-other-authority",
      branchId: "head-other",
      revision: 2,
      previousManifestSha256: otherManifest,
      manifestSha256: otherRevision,
      branchKind: "authoritative",
      state: "authoritative",
      revert: {
        branchId: "head-other",
        revision: 1,
        manifestSha256: otherManifest,
      },
    });
    assert.throws(() => database.prepare(`UPDATE authority_heads SET
      source_operation_kind = 'authority_decision',
      source_operation_id = 'head-other-authority',
      source_request_sha256 = ?, head_revision = 2,
      branch_id = 'head-other', branch_revision = 2, manifest_sha256 = ?,
      head_sha256 = ?, updated_at = ?
      WHERE tenant_id = 'tenant' AND authority_subject_sha256 = ?`)
      .run(
        sha256Hex("request:head-other-authority"),
        otherRevision,
        sha256Hex("head-other:2"),
        SQL_LATER,
        subject,
      ), /invalid authority_heads advance/iu);
    rollback();
  });
});

test("policy rotation is explicit, policy-only, and preserves exact capsule semantics", () => {
  withBootstrappedDatabase((database) => {
    database.exec(`
      DROP TRIGGER branch_capsule_bindings_learning_only_guard;
      DROP TRIGGER branch_capsule_bindings_learning_capacity_guard;
    `);
    const subject = sha256Hex("rotation-authority-subject");
    const branchId = "rotation-main";
    const genesisManifest = sha256Hex("rotation-genesis");
    const rotatedManifest = sha256Hex("rotation-revision-2");
    const oldCompilerArtifact = sha256Hex("rotation-old-compiler-artifact");
    const oldCompilerPayload = sha256Hex("rotation-old-compiler-payload");
    const newCompilerArtifact = sha256Hex("rotation-new-compiler-artifact");
    const newCompilerPayload = sha256Hex("rotation-new-compiler-payload");
    const evidenceArtifact = sha256Hex("rotation-evidence-artifact");
    const evidencePayload = sha256Hex("rotation-evidence-payload");
    const rotationArtifact = sha256Hex("rotation-artifact");
    const rotationPayload = sha256Hex("rotation-payload");

    type BranchArgs = Readonly<{
      sourceKind: "record_observations" | "authority_decision";
      sourceId: string;
      branchId?: string;
      revision: number;
      manifestSha256: string;
      branchKind?: "authoritative" | "candidate";
      state?: "authoritative" | "draft";
      previousManifestSha256?: string;
      compilerArtifactSha256?: string;
      compilerPayloadSha256?: string;
      rotation?: Readonly<{ artifactSha256: string; payloadSha256: string }>;
      effectCertificateSha256?: string;
      revert?: Readonly<{
        branchId: string;
        revision: number;
        manifestSha256: string;
      }>;
    }>;
    const insertBranch = (args: BranchArgs): void => {
      const candidate = args.branchKind === "candidate";
      database.prepare(`INSERT INTO branch_revisions(
        tenant_id, source_operation_scope, source_operation_kind,
        source_operation_id, source_request_sha256,
        authority_subject_sha256, branch_id, branch_revision, manifest_sha256,
        branch_kind, state, base_branch_id, base_branch_revision,
        base_manifest_sha256, base_branch_kind, base_branch_state,
        previous_branch_revision, previous_revision_sha256,
        compiler_policy_artifact_sha256, compiler_policy_payload_sha256,
        compiler_policy_kind, evidence_policy_artifact_sha256,
        evidence_policy_payload_sha256, evidence_policy_kind,
        policy_rotation_artifact_sha256, policy_rotation_payload_sha256,
        policy_rotation_artifact_kind, effect_certificate_sha256,
        reverts_branch_id, reverts_branch_revision,
        reverts_authority_revision_sha256, reverts_branch_kind,
        reverts_branch_state, manifest_json, created_at
      ) VALUES ('tenant', 'scope', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, 'compiler_policy', ?, ?, 'evidence_policy', ?, ?, ?, ?, ?,
        ?, ?, ?, ?, '{}', ?)`).run(
        args.sourceKind,
        args.sourceId,
        sha256Hex(`request:${args.sourceId}`),
        subject,
        args.branchId ?? branchId,
        args.revision,
        args.manifestSha256,
        args.branchKind ?? "authoritative",
        args.state ?? "authoritative",
        candidate ? branchId : null,
        candidate ? 1 : null,
        candidate ? genesisManifest : null,
        candidate ? "authoritative" : null,
        candidate ? "authoritative" : null,
        args.revision > 1 ? args.revision - 1 : null,
        args.revision > 1 ? args.previousManifestSha256 ?? genesisManifest : null,
        args.compilerArtifactSha256 ?? oldCompilerArtifact,
        args.compilerPayloadSha256 ?? oldCompilerPayload,
        evidenceArtifact,
        evidencePayload,
        args.rotation?.artifactSha256 ?? null,
        args.rotation?.payloadSha256 ?? null,
        args.rotation ? "policy_rotation" : null,
        args.effectCertificateSha256 ?? null,
        args.revert?.branchId ?? null,
        args.revert?.revision ?? null,
        args.revert?.manifestSha256 ?? null,
        args.revert ? "authoritative" : null,
        args.revert ? "authoritative" : null,
        SQL_NOW,
      );
    };
    const insertGenesis = (): void => insertBranch({
      sourceKind: "record_observations",
      sourceId: "rotation-genesis-operation",
      revision: 1,
      manifestSha256: genesisManifest,
    });
    const insertRotationArtifact = (args: Readonly<{
      sourceId: string;
      artifactSha256?: string;
      payloadSha256?: string;
      authoritySubjectSha256?: string;
      expiresAt?: string | null;
    }>): void => {
      database.prepare(`INSERT INTO authority_artifacts(
        tenant_id, source_operation_scope, source_operation_kind,
        source_operation_id, source_request_sha256, artifact_id,
        artifact_revision, artifact_kind, artifact_schema,
        authority_subject_sha256, artifact_sha256, payload_sha256,
        payload_json, signer_principal_sha256, trust_root_sha256,
        signature_algorithm, signature, valid_from, expires_at, created_at
      ) VALUES ('tenant', 'scope', 'authority_decision', ?, ?, ?, 1,
        'policy_rotation', 'authority_policy_rotation_v1', ?, ?, ?, '{}', ?, ?,
        'ed25519', ?, '2026-07-21T10:00:00.000Z', ?,
        '2026-07-21T11:00:00.000Z')`).run(
        args.sourceId,
        sha256Hex(`request:${args.sourceId}`),
        `artifact:${args.sourceId}`,
        args.authoritySubjectSha256 ?? subject,
        args.artifactSha256 ?? rotationArtifact,
        args.payloadSha256 ?? rotationPayload,
        sha256Hex(`signer:${args.sourceId}`),
        sha256Hex(`trust-root:${args.sourceId}`),
        new Uint8Array(64),
        args.expiresAt === undefined
          ? "2026-07-21T13:00:00.000Z"
          : args.expiresAt,
      );
    };
    const insertHead = (): void => {
      database.prepare(`INSERT INTO authority_heads(
        tenant_id, source_operation_scope, source_operation_kind,
        source_operation_id, source_request_sha256, authority_subject_sha256,
        head_revision, branch_id, branch_revision, manifest_sha256, branch_kind,
        branch_state, head_sha256, updated_at
      ) VALUES ('tenant', 'scope', 'record_observations',
        'rotation-genesis-operation', ?, ?, 1, ?, 1, ?, 'authoritative',
        'authoritative', ?, ?)`).run(
        sha256Hex("request:rotation-genesis-operation"),
        subject,
        branchId,
        genesisManifest,
        sha256Hex("rotation-head:1"),
        SQL_NOW,
      );
    };
    const advanceHead = (sourceId: string): void => {
      database.prepare(`UPDATE authority_heads SET
        source_operation_scope = 'scope',
        source_operation_kind = 'authority_decision',
        source_operation_id = ?, source_request_sha256 = ?,
        head_revision = 2, branch_revision = 2, manifest_sha256 = ?,
        head_sha256 = ?, updated_at = ?
        WHERE tenant_id = 'tenant' AND authority_subject_sha256 = ?`).run(
        sourceId,
        sha256Hex(`request:${sourceId}`),
        rotatedManifest,
        sha256Hex(`rotation-head:${sourceId}`),
        SQL_LATER,
        subject,
      );
    };
    const insertBinding = (args: Readonly<{
      revision: 1 | 2;
      manifestSha256: string;
      capsuleId?: string;
      disposition?: "include" | "exclude" | "prohibit";
    }>): void => {
      const capsuleId = args.capsuleId ?? "rotation-capsule";
      database.prepare(`INSERT INTO branch_capsule_bindings(
        tenant_id, authority_subject_sha256, branch_id, branch_revision,
        branch_manifest_sha256, branch_kind, capsule_scope, capsule_id,
        capsule_revision, capsule_sha256, disposition, admission_authority,
        binding_sha256, created_at
      ) VALUES ('tenant', ?, ?, ?, ?, 'authoritative', 'scope', ?, 1, ?, ?,
        'candidate', ?, ?)`).run(
        subject,
        branchId,
        args.revision,
        args.manifestSha256,
        capsuleId,
        sha256Hex(`capsule:${capsuleId}`),
        args.disposition ?? "include",
        sha256Hex(`binding:${args.manifestSha256}:${capsuleId}`),
        SQL_NOW,
      );
    };
    const insertRotation = (sourceId: string): void => insertBranch({
      sourceKind: "authority_decision",
      sourceId,
      revision: 2,
      previousManifestSha256: genesisManifest,
      manifestSha256: rotatedManifest,
      compilerArtifactSha256: newCompilerArtifact,
      compilerPayloadSha256: newCompilerPayload,
      rotation: {
        artifactSha256: rotationArtifact,
        payloadSha256: rotationPayload,
      },
    });
    const begin = (): void => {
      database.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys = ON;");
    };
    const rollback = (): void => database.exec("ROLLBACK");

    begin();
    insertGenesis();
    insertHead();
    insertBinding({ revision: 1, manifestSha256: genesisManifest });
    insertRotationArtifact({ sourceId: "rotation-positive" });
    assert.doesNotThrow(() => insertRotation("rotation-positive"));
    assert.throws(
      () => advanceHead("rotation-positive"),
      /policy rotation must preserve exact capsule bindings/iu,
    );
    insertBinding({ revision: 2, manifestSha256: rotatedManifest });
    assert.doesNotThrow(() => advanceHead("rotation-positive"));
    assert.doesNotThrow(() => insertRawOperation(database, {
      kind: "authority_decision",
      id: "rotation-positive",
    }));
    assert.throws(() => insertBinding({
      revision: 2,
      manifestSha256: rotatedManifest,
      capsuleId: "late-capsule",
    }), /cannot follow the operation receipt/iu);
    rollback();

    begin();
    insertGenesis();
    insertBinding({ revision: 1, manifestSha256: genesisManifest });
    insertRotationArtifact({ sourceId: "rotation-incomplete-bindings" });
    insertRotation("rotation-incomplete-bindings");
    assert.throws(() => insertRawOperation(database, {
      kind: "authority_decision",
      id: "rotation-incomplete-bindings",
    }), /policy rotation must preserve exact capsule bindings/iu);
    rollback();

    begin();
    insertGenesis();
    insertRotationArtifact({ sourceId: "rotation-no-policy-change" });
    assert.throws(() => insertBranch({
      sourceKind: "authority_decision",
      sourceId: "rotation-no-policy-change",
      revision: 2,
      previousManifestSha256: genesisManifest,
      manifestSha256: rotatedManifest,
      rotation: {
        artifactSha256: rotationArtifact,
        payloadSha256: rotationPayload,
      },
    }), /invalid branch_revisions transition/iu);
    rollback();

    begin();
    insertGenesis();
    assert.throws(() => insertBranch({
      sourceKind: "authority_decision",
      sourceId: "revert-policy-drift",
      revision: 2,
      previousManifestSha256: genesisManifest,
      manifestSha256: rotatedManifest,
      compilerArtifactSha256: newCompilerArtifact,
      compilerPayloadSha256: newCompilerPayload,
      revert: {
        branchId,
        revision: 1,
        manifestSha256: genesisManifest,
      },
    }), /invalid branch_revisions transition/iu);
    rollback();

    begin();
    insertGenesis();
    assert.throws(() => insertBranch({
      sourceKind: "authority_decision",
      sourceId: "candidate-policy-drift",
      branchId: "rotation-candidate",
      revision: 1,
      manifestSha256: sha256Hex("rotation-candidate-policy-drift"),
      branchKind: "candidate",
      state: "draft",
      compilerArtifactSha256: newCompilerArtifact,
      compilerPayloadSha256: newCompilerPayload,
    }), /invalid branch_revisions transition/iu);
    rollback();

    begin();
    insertGenesis();
    insertRotationArtifact({ sourceId: "candidate-rotation" });
    assert.throws(() => insertBranch({
      sourceKind: "authority_decision",
      sourceId: "candidate-rotation",
      branchId: "rotation-candidate",
      revision: 1,
      manifestSha256: sha256Hex("rotation-candidate-with-artifact"),
      branchKind: "candidate",
      state: "draft",
      compilerArtifactSha256: newCompilerArtifact,
      compilerPayloadSha256: newCompilerPayload,
      rotation: {
        artifactSha256: rotationArtifact,
        payloadSha256: rotationPayload,
      },
    }), /CHECK constraint failed|invalid branch_revisions transition/iu);
    rollback();

    begin();
    insertGenesis();
    insertRotationArtifact({ sourceId: "rotation-and-revert" });
    assert.throws(() => insertBranch({
      sourceKind: "authority_decision",
      sourceId: "rotation-and-revert",
      revision: 2,
      previousManifestSha256: genesisManifest,
      manifestSha256: rotatedManifest,
      compilerArtifactSha256: newCompilerArtifact,
      compilerPayloadSha256: newCompilerPayload,
      rotation: {
        artifactSha256: rotationArtifact,
        payloadSha256: rotationPayload,
      },
      revert: {
        branchId,
        revision: 1,
        manifestSha256: genesisManifest,
      },
    }), /CHECK constraint failed/iu);
    rollback();

    begin();
    insertGenesis();
    insertRotationArtifact({
      sourceId: "rotation-wrong-subject",
      authoritySubjectSha256: sha256Hex("wrong-rotation-subject"),
    });
    assert.throws(
      () => insertRotation("rotation-wrong-subject"),
      /invalid or inactive policy rotation artifact/iu,
    );
    rollback();

    begin();
    insertGenesis();
    insertRotationArtifact({
      sourceId: "rotation-expired",
      expiresAt: "2026-07-21T11:59:59.999Z",
    });
    assert.throws(
      () => insertRotation("rotation-expired"),
      /invalid or inactive policy rotation artifact/iu,
    );
    rollback();
  });
});

test("durable jobs freeze definitions, uniquely own live tokens, and reject terminal fabrication", () => {
  withBootstrappedDatabase((database) => {
    const createJob = (jobId: string): void => {
      const operationId = `source-${jobId}`;
      const requestSha256 = sha256Hex(`request:${operationId}`);
      database.exec("BEGIN IMMEDIATE");
      insertQueuedJob(database, {
        id: jobId,
        sourceOperationId: operationId,
        sourceRequestSha256: requestSha256,
      });
      insertRawOperation(database, {
        kind: "record_observations",
        id: operationId,
        requestSha256,
      });
      database.exec("COMMIT");
    };
    const lease = (jobId: string, token: string): void => {
      database.prepare(`UPDATE durable_jobs SET
        state = 'leased', attempt_count = 1, lease_owner = 'worker',
        lease_token = ?, lease_acquired_at = ?, lease_expires_at = ?,
        updated_at = ?
        WHERE tenant_id = 'tenant' AND scope = 'scope' AND job_id = ?`)
        .run(token, SQL_LATER, SQL_LEASE_EXPIRY, SQL_LATER, jobId);
    };

    createJob("job-smuggle");
    assert.throws(() => database.prepare(`UPDATE durable_jobs SET
      state = 'leased', attempt_count = 1, priority = 99,
      lease_owner = 'worker', lease_token = ?, lease_acquired_at = ?,
      lease_expires_at = ?, updated_at = ?
      WHERE tenant_id = 'tenant' AND scope = 'scope' AND job_id = 'job-smuggle'`)
      .run("a".repeat(64), SQL_LATER, SQL_LEASE_EXPIRY, SQL_LATER),
    /invalid durable_jobs transition/iu);

    createJob("job-token-a");
    createJob("job-token-b");
    lease("job-token-a", "b".repeat(64));
    assert.throws(() => lease("job-token-b", "b".repeat(64)), /UNIQUE constraint failed/iu);

    createJob("job-early-requeue");
    lease("job-early-requeue", "d".repeat(64));
    assert.throws(() => database.prepare(`UPDATE durable_jobs SET
      state = 'queued', available_at = ?, lease_owner = NULL,
      lease_token = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
      last_error_json = '{}', updated_at = ?
      WHERE tenant_id = 'tenant' AND scope = 'scope'
        AND job_id = 'job-early-requeue'`)
      .run(
        SQL_LEASE_EXPIRY,
        "2026-07-21T12:00:00.002Z",
      ), /invalid durable_jobs transition/iu);

    assert.throws(() => database.prepare(`UPDATE durable_jobs SET
      state = 'succeeded', attempt_count = 1, completed_at = ?,
      terminal_reason = 'worker_succeeded',
      completion_operation_kind = 'worker_completion',
      completion_operation_id = 'fabricated-terminal',
      completion_request_sha256 = ?, updated_at = ?
      WHERE tenant_id = 'tenant' AND scope = 'scope' AND job_id = 'job-smuggle'`)
      .run(SQL_LATER, sha256Hex("request:fabricated-terminal"), SQL_LATER),
    /invalid durable_jobs transition|CHECK constraint failed/iu);

    createJob("job-terminal-owner");
    lease("job-terminal-owner", "c".repeat(64));
    const terminalRequest = sha256Hex("request:completed-worker");
    database.exec("BEGIN IMMEDIATE");
    database.prepare(`UPDATE durable_jobs SET
      state = 'succeeded', lease_owner = NULL, lease_token = NULL,
      lease_acquired_at = NULL, lease_expires_at = NULL, completed_at = ?,
      terminal_reason = 'worker_succeeded',
      completion_operation_kind = 'worker_completion',
      completion_operation_id = 'completed-worker', completion_request_sha256 = ?,
      last_error_json = NULL, updated_at = ?
      WHERE tenant_id = 'tenant' AND scope = 'scope'
        AND job_id = 'job-terminal-owner'`).run(
      "2026-07-21T12:00:00.002Z",
      terminalRequest,
      "2026-07-21T12:00:00.002Z",
    );
    insertRawOperation(database, {
      kind: "worker_completion",
      id: "completed-worker",
      requestSha256: terminalRequest,
    });
    database.exec("COMMIT");

    createJob("job-terminal-borrow");
    lease("job-terminal-borrow", "e".repeat(64));
    assert.throws(() => database.prepare(`UPDATE durable_jobs SET
      state = 'succeeded', lease_owner = NULL, lease_token = NULL,
      lease_acquired_at = NULL, lease_expires_at = NULL, completed_at = ?,
      terminal_reason = 'worker_succeeded',
      completion_operation_kind = 'worker_completion',
      completion_operation_id = 'completed-worker', completion_request_sha256 = ?,
      last_error_json = NULL, updated_at = ?
      WHERE tenant_id = 'tenant' AND scope = 'scope'
        AND job_id = 'job-terminal-borrow'`)
      .run("2026-07-21T12:00:00.002Z", terminalRequest,
        "2026-07-21T12:00:00.002Z"),
    /completion operation is already completed/iu);
  });
});

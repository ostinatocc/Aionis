import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import test from "node:test";

import {
  LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC,
  LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS,
  LearningExternalIngestionProjectionV1Schema,
  learningRuntimeAuthorityRowV1,
} from "../../src/memory/learning-external-ingestion-attestation.js";
import {
  LiteLearningExternalEvidenceIngestOperationReceiptV1Schema,
} from "../../packages/aionis-learning-authority/src/store/lite-learning-external-evidence-ingestion.js";
import {
  ingestLiteLearningExternalEvidence,
} from "../../packages/aionis-learning-authority/src/store/lite-learning-external-evidence-service.js";
import {
  LiteLearningExternalIngestionDatabaseProjectionDraftV1Schema,
  liteLearningExternalIngestionDatabaseProjectionDraftDigestV1,
  liteLearningExternalIngestionDatabaseProjectionDraftJsonV1,
  projectLiteLearningExternalIngestionDatabaseDraftV1,
} from "../../tools/learning-experiments/lite-learning-external-ingestion-projector.js";
import {
  readLiteLearningRuntimeAuthorityExactRows,
} from "../../tools/learning-experiments/lite-learning-runtime-authority-head.js";
import {
  createLiteRuntimeDatabase,
  type LiteRuntimeDatabase,
} from "../../src/store/lite-runtime-database.js";
import {
  inspectLiteRuntimeSchema,
  LITE_RUNTIME_WRITE_SCHEMA_COMPONENT,
  LITE_RUNTIME_WRITE_SCHEMA_VERSION,
} from "../../src/store/lite-runtime-schema.js";
import {
  cloneLearningExternalEvidenceIngestFixture,
  createLearningExternalEvidenceIngestFixture,
  type LearningExternalEvidenceIngestFixture,
} from "./support/learning-external-evidence-ingest-fixture.js";

const CONFIRMATORY_ATTEMPT_ID =
  "lca_bbb04778c778fb00edec61ad67ec084c14309b65e943fc28628b6c089ada7c7c";

type PersistedOperation = Readonly<{
  tenant_id: string;
  scope: string;
  operation_kind: string;
  operation_id: string;
  request_sha256: string;
  receipt_json: string;
  commit_id: string;
  created_at: string;
}>;

type PersistedArtifact = Readonly<{
  row_id: number;
  artifact_id: string;
  artifact_kind: string;
  evidence_series_id: string;
  artifact_status: string;
  report_sha256: string;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertRealCurrentWalDatabase(database: LiteRuntimeDatabase): void {
  assert.notEqual(database.path, ":memory:");
  const mode = database.db.prepare("PRAGMA journal_mode").get() as {
    journal_mode: string;
  };
  assert.equal(mode.journal_mode.toLowerCase(), "wal");
  const schema = inspectLiteRuntimeSchema(database.db);
  assert.equal(schema.classification, "current");
  assert.equal(schema.component, LITE_RUNTIME_WRITE_SCHEMA_COMPONENT);
  assert.equal(schema.detected_version, LITE_RUNTIME_WRITE_SCHEMA_VERSION);
}

function confirmatoryAttemptId(database: LiteRuntimeDatabase): string {
  const rows = database.db.prepare(
    `SELECT confirmatory_attempt_id
     FROM lite_learning_confirmatory_attempts
     ORDER BY confirmatory_attempt_id`,
  ).all() as Array<{ confirmatory_attempt_id: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.confirmatory_attempt_id, CONFIRMATORY_ATTEMPT_ID);
  return rows[0]!.confirmatory_attempt_id;
}

async function openFixtureDatabase<T>(
  fixture: LearningExternalEvidenceIngestFixture,
  run: (database: LiteRuntimeDatabase) => Promise<T>,
): Promise<T> {
  const database = createLiteRuntimeDatabase(fixture.databasePath);
  try {
    assertRealCurrentWalDatabase(database);
    return await run(database);
  } finally {
    await database.close();
  }
}

function exactAuthorityRow(args: Readonly<{
  database: LiteRuntimeDatabase;
  table: string;
  bindings: Readonly<Record<string, string | number | Uint8Array | null>>;
}>): Readonly<Record<string, unknown>> {
  const spec = args.table === LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC.table
    ? LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC
    : LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS.find(
      (candidate) => candidate.table === args.table,
    );
  assert.ok(spec, `missing frozen authority table spec for ${args.table}`);
  const rows = readLiteLearningRuntimeAuthorityExactRows({
    database: args.database,
    table: args.table,
    columns: spec.column_order,
    bindings: args.bindings,
  });
  assert.equal(rows.length, 1, `expected one ${args.table} authority row`);
  return rows[0]!;
}

function persistedResult(database: LiteRuntimeDatabase, operationId: string): Readonly<{
  operation: PersistedOperation;
  artifact: PersistedArtifact;
}> {
  const operation = database.db.prepare(
    `SELECT tenant_id, scope, operation_kind, operation_id, request_sha256,
            receipt_json, commit_id, created_at
     FROM lite_runtime_write_operations
     WHERE tenant_id = ? AND scope = 'learning_external_authority_v1'
       AND operation_kind = 'learning_evidence_ingest_v1' AND operation_id = ?`,
  ).get("tenant-confirmatory", operationId) as PersistedOperation | undefined;
  assert.ok(operation);
  const artifact = database.db.prepare(
    `SELECT row_id, artifact_id, artifact_kind, evidence_series_id,
            artifact_status, report_sha256
     FROM lite_learning_evidence_artifacts
     WHERE tenant_id = ? AND evidence_series_id = ?`,
  ).get(
    "tenant-confirmatory",
    "confirmatory-shadow-series-v1",
  ) as PersistedArtifact | undefined;
  assert.ok(artifact);
  return { operation, artifact };
}

function replaceProtectedDatabaseInstanceId(
  database: LiteRuntimeDatabase,
  databaseInstanceId: string,
): void {
  const triggers = database.db.prepare(
    `SELECT name, sql
     FROM sqlite_master
     WHERE type = 'trigger' AND tbl_name = 'lite_runtime_authority_identity'
     ORDER BY name`,
  ).all() as Array<{ name: string; sql: string }>;
  assert.equal(triggers.length, 2);
  for (const trigger of triggers) {
    assert.match(trigger.name, /^[a-z0-9_]+$/u);
    assert.ok(trigger.sql.startsWith("CREATE TRIGGER "));
    database.db.exec(`DROP TRIGGER ${trigger.name}`);
  }
  const changed = database.db.prepare(
    `UPDATE lite_runtime_authority_identity
     SET database_instance_id = ?
     WHERE singleton = 1`,
  ).run(databaseInstanceId);
  assert.equal(Number(changed.changes), 1);
  for (const trigger of triggers) database.db.exec(trigger.sql);
}

test("D2 external-ingestion projector reconstructs only a real same-snapshot current database draft", {
  timeout: 900_000,
}, async (t) => {
  const base = await createLearningExternalEvidenceIngestFixture();
  try {
    const ingested = cloneLearningExternalEvidenceIngestFixture(base, "projector-ingested");
    const ingestedResult = await ingestLiteLearningExternalEvidence(
      ingested.serviceInput,
      { now: () => new Date(ingested.recordedAt) },
    );
    assert.equal(ingestedResult.replayed, false);

    const projectRealToolBranch = async (
      name: string,
      branchKind:
        | "preclaim_hold"
        | "termination_hold_no_binding"
        | "termination_hold_with_binding",
    ) => {
      const fixture = cloneLearningExternalEvidenceIngestFixture(ingested, name);
      return await openFixtureDatabase(fixture, async (database) => {
        const terminal = await fixture.appendRealProjectorToolBranch({
          database,
          branchKind,
        });
        const draft = await database.transaction.run(async () =>
          await projectLiteLearningExternalIngestionDatabaseDraftV1({
            database,
            tenantId: fixture.serviceInput.tenantId,
            confirmatoryAttemptId: confirmatoryAttemptId(database),
          }));
        return { draft, terminal };
      });
    };

    await t.test("rejects projection outside an active Runtime transaction", async () => {
      await openFixtureDatabase(ingested, async (database) => {
        await assert.rejects(
          async () => projectLiteLearningExternalIngestionDatabaseDraftV1({
            database,
            tenantId: ingested.serviceInput.tenantId,
            confirmatoryAttemptId: confirmatoryAttemptId(database),
          }),
          /active_transaction_required/,
        );
      });
    });

    await t.test("rejects a normal terminal lifecycle until its real ingest pair exists", async () => {
      const fixture = cloneLearningExternalEvidenceIngestFixture(base, "projector-uningested");
      await openFixtureDatabase(fixture, async (database) => {
        await assert.rejects(
          database.transaction.run(async () =>
            projectLiteLearningExternalIngestionDatabaseDraftV1({
              database,
              tenantId: fixture.serviceInput.tenantId,
              confirmatoryAttemptId: confirmatoryAttemptId(database),
            })),
          /invalid_terminal_branch_vector:production_shadow:110111000:failed/,
        );
      });
    });

    await t.test("rejects a confirmatory-attempt identity outside the registered revision", async () => {
      await openFixtureDatabase(ingested, async (database) => {
        await assert.rejects(
          database.transaction.run(async () =>
            projectLiteLearningExternalIngestionDatabaseDraftV1({
              database,
              tenantId: ingested.serviceInput.tenantId,
              confirmatoryAttemptId: "lca_".concat("0".repeat(64)),
            })),
          /exactly_one_row_required:confirmatory_attempt:0/,
        );
      });
    });

    await t.test("rejects a real database whose Runtime metadata is no longer v5", async () => {
      const fixture = cloneLearningExternalEvidenceIngestFixture(base, "projector-non-v5");
      const database = createLiteRuntimeDatabase(fixture.databasePath);
      try {
        assertRealCurrentWalDatabase(database);
        database.db.prepare(
          `UPDATE lite_runtime_schema_metadata SET version = 3 WHERE component = ?`,
        ).run(LITE_RUNTIME_WRITE_SCHEMA_COMPONENT);
        await assert.rejects(
          database.transaction.run(async () =>
            projectLiteLearningExternalIngestionDatabaseDraftV1({
              database,
              tenantId: fixture.serviceInput.tenantId,
              confirmatoryAttemptId: CONFIRMATORY_ATTEMPT_ID,
            })),
          /current_v5_database_required/,
        );
      } finally {
        await database.close();
      }
    });

    await t.test("rejects a real database whose protected instance identity was replaced", async () => {
      const fixture = cloneLearningExternalEvidenceIngestFixture(
        ingested,
        "projector-wrong-database-identity",
      );
      await openFixtureDatabase(fixture, async (database) => {
        replaceProtectedDatabaseInstanceId(
          database,
          sha256("projector-tampered-database-instance"),
        );
        await assert.rejects(
          database.transaction.run(async () =>
            projectLiteLearningExternalIngestionDatabaseDraftV1({
              database,
              tenantId: fixture.serviceInput.tenantId,
              confirmatoryAttemptId: CONFIRMATORY_ATTEMPT_ID,
            })),
          /(?:database_instance|runtime_authority_identity|database lineage mismatch)/,
        );
      });
    });

    await t.test("projects a real signed tool preclaim hold without inventing a result", async () => {
      const { draft, terminal } = await projectRealToolBranch(
        "projector-preclaim-hold",
        "preclaim_hold",
      );
      assert.deepEqual(draft.required_series_status.series[2], {
        role: "tool_e2e",
        artifact_kind: "tool_e2e_gate",
        evidence_series_id: "confirmatory-tool-series-v1",
        branch_kind: "preclaim_hold",
        preclaim_hold_reason: "preclaim_timeout",
      });
      const branch = draft.terminal_coverage_database_draft.branches[2]!;
      assert.equal(branch.branch_kind, "preclaim_hold");
      if (branch.branch_kind !== "preclaim_hold") assert.fail("expected preclaim hold branch");
      assert.deepEqual({
        reservation_id: branch.reservation_id,
        ticket_consumption_id: branch.ticket_consumption_id,
        preclaim_hold_id: branch.preclaim_hold_id,
        preclaim_hold_sha256: branch.preclaim_hold_sha256,
        preclaim_hold_reason: branch.preclaim_hold_reason,
        claim_count: branch.claim_count,
        supervisor_binding_count: branch.supervisor_binding_count,
        session_termination_count: branch.session_termination_count,
        artifact_count: branch.artifact_count,
        ingest_operation_count: branch.ingest_operation_count,
        current_series_head_count: branch.current_series_head_count,
      }, {
        reservation_id: terminal.reservationId,
        ticket_consumption_id: terminal.ticketConsumptionId,
        preclaim_hold_id: terminal.preclaimHoldId,
        preclaim_hold_sha256: terminal.terminalFactSha256,
        preclaim_hold_reason: "preclaim_timeout",
        claim_count: 0,
        supervisor_binding_count: 0,
        session_termination_count: 0,
        artifact_count: 0,
        ingest_operation_count: 0,
        current_series_head_count: 0,
      });
      assert.equal(draft.terminal_coverage_database_draft.finalized_at, terminal.recordedAt);
      assert.deepEqual(draft.d3_capability_requirements.unstarted_roles, ["offline_paired"]);
      assert.deepEqual(draft.d3_capability_requirements.hold_bundles, [{
        role: "tool_e2e",
        evidence_series_id: "confirmatory-tool-series-v1",
        branch_kind: "preclaim_hold",
        terminal_fact_sha256: terminal.terminalFactSha256,
        capability: "d3_verified_tracked_preclaim_hold_bundle_capability_required",
      }]);
      assert.equal(draft.result_tuples.length, 1);
    });

    await t.test("projects real abnormal terminations with their exact binding semantics", async (t) => {
      const cases = [
        {
          name: "projector-termination-no-binding",
          branchKind: "termination_hold_no_binding" as const,
          terminationReason: "launch_failure" as const,
          bindingExpected: false,
        },
        {
          name: "projector-termination-with-binding",
          branchKind: "termination_hold_with_binding" as const,
          terminationReason: "runner_crash" as const,
          bindingExpected: true,
        },
      ];
      for (const scenario of cases) {
        await t.test(scenario.terminationReason, async () => {
          const { draft, terminal } = await projectRealToolBranch(
            scenario.name,
            scenario.branchKind,
          );
          assert.deepEqual(draft.required_series_status.series[2], {
            role: "tool_e2e",
            artifact_kind: "tool_e2e_gate",
            evidence_series_id: "confirmatory-tool-series-v1",
            branch_kind: "termination_hold",
            termination_reason: scenario.terminationReason,
          });
          const branch = draft.terminal_coverage_database_draft.branches[2]!;
          assert.equal(branch.branch_kind, "termination_hold");
          if (branch.branch_kind !== "termination_hold") {
            assert.fail("expected termination hold branch");
          }
          assert.deepEqual({
            reservation_id: branch.reservation_id,
            ticket_consumption_id: branch.ticket_consumption_id,
            claim_id: branch.claim_id,
            supervisor_binding_id: branch.supervisor_binding_id,
            session_termination_id: branch.session_termination_id,
            session_termination_sha256: branch.session_termination_sha256,
            termination_reason: branch.termination_reason,
            artifact_count: branch.artifact_count,
            ingest_operation_count: branch.ingest_operation_count,
            current_series_head_count: branch.current_series_head_count,
          }, {
            reservation_id: terminal.reservationId,
            ticket_consumption_id: terminal.ticketConsumptionId,
            claim_id: terminal.claimId,
            supervisor_binding_id: terminal.supervisorBindingId,
            session_termination_id: terminal.sessionTerminationId,
            session_termination_sha256: terminal.terminalFactSha256,
            termination_reason: scenario.terminationReason,
            artifact_count: 0,
            ingest_operation_count: 0,
            current_series_head_count: 0,
          });
          assert.equal(branch.supervisor_binding_id !== null, scenario.bindingExpected);
          assert.equal(draft.terminal_coverage_database_draft.finalized_at, terminal.recordedAt);
          assert.deepEqual(draft.d3_capability_requirements.unstarted_roles, ["offline_paired"]);
          assert.deepEqual(draft.d3_capability_requirements.hold_bundles, [{
            role: "tool_e2e",
            evidence_series_id: "confirmatory-tool-series-v1",
            branch_kind: "termination_hold",
            terminal_fact_sha256: terminal.terminalFactSha256,
            capability: "d3_verified_tracked_termination_hold_bundle_capability_required",
          }]);
          assert.equal(draft.result_tuples.length, 1);
        });
      }
    });

    await t.test("binds one real result and two unstarted roles into a deterministic unsigned draft", async () => {
      await openFixtureDatabase(ingested, async (database) => {
        const projected = await database.transaction.run(async () => {
          const args = {
            database,
            tenantId: ingested.serviceInput.tenantId,
            confirmatoryAttemptId: confirmatoryAttemptId(database),
          } as const;
          const first = await projectLiteLearningExternalIngestionDatabaseDraftV1(args);
          const second = await projectLiteLearningExternalIngestionDatabaseDraftV1(args);
          assert.deepEqual(second, first);

          const persisted = persistedResult(database, ingested.serviceInput.operationId);
          const revisionAuthority = exactAuthorityRow({
            database,
            table: "lite_learning_experiment_revisions",
            bindings: {
              tenant_id: ingested.serviceInput.tenantId,
              experiment_id: ingested.serviceInput.applicableExperimentId,
              experiment_revision: ingested.serviceInput.applicableExperimentRevision,
            },
          });
          const artifactAuthority = exactAuthorityRow({
            database,
            table: "lite_learning_evidence_artifacts",
            bindings: { row_id: persisted.artifact.row_id },
          });
          const operationAuthority = exactAuthorityRow({
            database,
            table: "lite_runtime_write_operations",
            bindings: {
              tenant_id: persisted.operation.tenant_id,
              scope: persisted.operation.scope,
              operation_kind: persisted.operation.operation_kind,
              operation_id: persisted.operation.operation_id,
            },
          });
          return { first, persisted, revisionAuthority, artifactAuthority, operationAuthority };
        });

        const draft = LiteLearningExternalIngestionDatabaseProjectionDraftV1Schema.parse(
          projected.first,
        );
        assert.equal(draft.contract_version, "unsigned_d2_database_projection_draft_v1");
        assert.equal(draft.signing_eligible, false);
        assert.equal(draft.schema_component, "write_projection");
        assert.equal(draft.schema_version, 6);
        assert.equal(draft.ledger_verification.schema_version, 6);
        assert.equal(draft.tenant_id, "tenant-confirmatory");
        assert.equal(draft.task_family, "repository_change");
        assert.equal(draft.confirmatory_attempt_id, CONFIRMATORY_ATTEMPT_ID);
        assert.equal(draft.experiment_id, "confirmatory-provision-experiment");
        assert.equal(draft.experiment_revision, 1);
        assert.deepEqual(draft.registered_evidence_series, {
          offline_paired: "confirmatory-offline-series-v1",
          production_shadow: "confirmatory-shadow-series-v1",
          runtime_integrity: "confirmatory-integrity-series-v1",
          tool_e2e: "confirmatory-tool-series-v1",
        });
        assert.deepEqual(
          draft.required_series_status.series.map((series) => ({
            role: series.role,
            artifact_kind: series.artifact_kind,
            evidence_series_id: series.evidence_series_id,
            branch_kind: series.branch_kind,
            ...series.branch_kind === "result"
              ? { artifact_status: series.artifact_status }
              : {},
          })),
          [
            {
              role: "offline_paired",
              artifact_kind: "offline_paired_rerun",
              evidence_series_id: "confirmatory-offline-series-v1",
              branch_kind: "unstarted",
            },
            {
              role: "production_shadow",
              artifact_kind: "production_shadow_gate",
              evidence_series_id: "confirmatory-shadow-series-v1",
              branch_kind: "result",
              artifact_status: "failed",
            },
            {
              role: "tool_e2e",
              artifact_kind: "tool_e2e_gate",
              evidence_series_id: "confirmatory-tool-series-v1",
              branch_kind: "unstarted",
            },
          ],
        );
        assert.deepEqual(
          draft.terminal_coverage_database_draft.branches.map((branch) => branch.branch_kind),
          ["unstarted", "result", "unstarted"],
        );
        assert.equal(
          draft.terminal_coverage_database_draft.finalized_at,
          ingested.recordedAt,
        );
        assert.equal(draft.ledger_verification.checked_at, ingested.recordedAt);
        assert.deepEqual(draft.d3_capability_requirements.unstarted_roles, [
          "offline_paired",
          "tool_e2e",
        ]);
        assert.deepEqual(draft.d3_capability_requirements.hold_bundles, []);
        assert.equal(draft.result_tuples.length, 1);

        const tuple = draft.result_tuples[0]!;
        const operation = projected.persisted.operation;
        const artifact = projected.persisted.artifact;
        const receipt = LiteLearningExternalEvidenceIngestOperationReceiptV1Schema.parse(
          JSON.parse(operation.receipt_json) as unknown,
        );
        assert.deepEqual({
          role: tuple.role,
          artifact_kind: tuple.artifact_kind,
          evidence_series_id: tuple.evidence_series_id,
          artifact_status: tuple.artifact_status,
          ingest_operation_scope: tuple.ingest_operation_scope,
          ingest_operation_kind: tuple.ingest_operation_kind,
          ingest_operation_id: tuple.ingest_operation_id,
          ingest_operation_request_sha256: tuple.ingest_operation_request_sha256,
          ingest_operation_commit_id: tuple.ingest_operation_commit_id,
          ingest_operation_created_at: tuple.ingest_operation_created_at,
          artifact_id: tuple.artifact_id,
          artifact_row_id: tuple.artifact_row_id,
          report_sha256: tuple.report_sha256,
        }, {
          role: "production_shadow",
          artifact_kind: artifact.artifact_kind,
          evidence_series_id: artifact.evidence_series_id,
          artifact_status: artifact.artifact_status,
          ingest_operation_scope: operation.scope,
          ingest_operation_kind: operation.operation_kind,
          ingest_operation_id: operation.operation_id,
          ingest_operation_request_sha256: operation.request_sha256,
          ingest_operation_commit_id: operation.commit_id,
          ingest_operation_created_at: operation.created_at,
          artifact_id: artifact.artifact_id,
          artifact_row_id: artifact.row_id,
          report_sha256: artifact.report_sha256,
        });
        assert.equal(tuple.ingest_operation_receipt_sha256, sha256(operation.receipt_json));
        assert.equal(
          tuple.post_transaction_projection_sha256,
          receipt.post_transaction_projection_sha256,
        );
        assert.equal(
          tuple.artifact_authority_row_sha256,
          learningRuntimeAuthorityRowV1({
            table: "lite_learning_evidence_artifacts",
            row: projected.artifactAuthority,
          }).authority_row_sha256,
        );
        assert.equal(
          tuple.ingest_operation_row_sha256,
          learningRuntimeAuthorityRowV1({
            table: "lite_runtime_write_operations",
            row: projected.operationAuthority,
          }).authority_row_sha256,
        );
        assert.equal(
          draft.registered_revision.revision_row_sha256,
          learningRuntimeAuthorityRowV1({
            table: "lite_learning_experiment_revisions",
            row: projected.revisionAuthority,
          }).authority_row_sha256,
        );
        assert.equal(tuple.series_head_artifact_id, tuple.artifact_id);
        assert.equal(tuple.series_head_row_id, tuple.artifact_row_id);
        assert.equal(tuple.series_head_row_sha256, tuple.artifact_authority_row_sha256);
        assert.equal(
          draft.database_instance_id,
          receipt.post_transaction_projection.database_instance_id,
        );

        const canonical = liteLearningExternalIngestionDatabaseProjectionDraftJsonV1(draft);
        assert.equal(canonical, liteLearningExternalIngestionDatabaseProjectionDraftJsonV1(
          JSON.parse(canonical) as unknown,
        ));
        assert.equal(
          liteLearningExternalIngestionDatabaseProjectionDraftDigestV1(draft),
          sha256(canonical),
        );
        const serializedKeys = [...canonical.matchAll(/"([^"]+)":/gu)].map((match) => match[1]);
        for (const forbiddenKey of [
          "database_lineage",
          "database_binding_receipt_sha256",
          "termination_hold_bundle_sha256",
          "preclaim_hold_bundle_sha256",
          "signature",
          "signature_algorithm",
          "signature_base64",
          "release_verdict",
        ]) {
          assert.equal(serializedKeys.includes(forbiddenKey), false, forbiddenKey);
        }
        assert.equal(canonical.includes('"database_binding_receipt":{'), false);
        assert.equal(canonical.includes('"authority_head":{'), false);
        assert.equal(
          draft.d3_capability_requirements.database_binding_receipt,
          "d3_launcher_database_binding_capability_required",
        );
        assert.equal(
          draft.d3_capability_requirements.authority_head,
          "d3_same_transaction_authority_head_required",
        );
        assert.throws(() => LearningExternalIngestionProjectionV1Schema.parse(draft));
      });
    });
  } finally {
    for (const directory of [base.evidenceRepositoryPath, base.rootDirectory])
      rmSync(directory, { recursive: true, force: true });
  }
});

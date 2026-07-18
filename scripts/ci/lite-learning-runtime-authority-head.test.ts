import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS,
  learningRuntimeAuthorityExternalOperationClosureDigest,
} from "../../src/memory/learning-external-ingestion-attestation.js";
import {
  buildLiteLearningRuntimeAuthorityHeadV1,
  readLiteLearningRuntimeAuthorityExactRows,
} from "../../tools/learning-experiments/lite-learning-runtime-authority-head.js";
import { assertLiteRuntimeAuthorityIdentity } from
  "../../src/store/lite-learning-episode-ledger.js";
import {
  createLiteRuntimeDatabase,
  type LiteRuntimeDatabase,
} from "../../src/store/lite-runtime-database.js";
import {
  inspectLiteRuntimeSchema,
  LITE_RUNTIME_WRITE_SCHEMA_COMPONENT,
  LITE_RUNTIME_WRITE_SCHEMA_VERSION,
} from "../../src/store/lite-runtime-schema.js";
import { createLiteWriteStoreFromDatabase } from "../../src/store/lite-write-store.js";

const EXTERNAL_SCOPE = "learning_external_authority_v1";

function sha256(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

const DATABASE_LINEAGE_BASE = Object.freeze({
  database_file_device: "1",
  database_file_inode: "2",
  checkpoint_generation: "0",
  database_main_file_byte_length: "4096",
  database_main_file_sha256: sha256("authority-head-test-main-file"),
  wal_checkpointed_and_truncated: true as const,
});

function databaseLineage(database: LiteRuntimeDatabase) {
  return Object.freeze({
    database_instance_id: assertLiteRuntimeAuthorityIdentity(database.db),
    ...DATABASE_LINEAGE_BASE,
  });
}

type RuntimeFixture = Readonly<{
  directory: string;
  database: LiteRuntimeDatabase;
  close(): Promise<void>;
}>;

function createFileBackedRuntime(name: string, initializeCurrent = true): RuntimeFixture {
  const directory = mkdtempSync(join(tmpdir(), `aionis-authority-head-${name}-`));
  const databasePath = join(directory, "runtime.sqlite");
  const database = createLiteRuntimeDatabase(databasePath);
  if (initializeCurrent) {
    createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
    const schema = inspectLiteRuntimeSchema(database.db);
    assert.equal(schema.classification, "current");
    assert.equal(schema.component, LITE_RUNTIME_WRITE_SCHEMA_COMPONENT);
    assert.equal(schema.detected_version, LITE_RUNTIME_WRITE_SCHEMA_VERSION);
  }
  const journalMode = database.db.prepare("PRAGMA journal_mode").get() as {
    journal_mode: string;
  };
  assert.equal(journalMode.journal_mode.toLowerCase(), "wal");
  assert.notEqual(database.path, ":memory:");
  return {
    directory,
    database,
    async close() {
      try {
        await database.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

function insertExternalOperation(args: Readonly<{
  database: LiteRuntimeDatabase;
  operationId: string;
  tenantId?: string;
  operationKind?: string;
  scope?: string | Uint8Array;
  receiptJson?: string;
}>): void {
  args.database.db.prepare(
    `INSERT INTO lite_runtime_write_operations (
       tenant_id,
       scope,
       operation_kind,
       operation_id,
       request_sha256,
       receipt_json,
       commit_id,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.tenantId ?? "tenant-authority-head",
    args.scope ?? EXTERNAL_SCOPE,
    args.operationKind ?? "evidence_ingest",
    args.operationId,
    sha256(`request:${args.operationId}`),
    args.receiptJson ?? JSON.stringify({ operation_id: args.operationId }),
    null,
    "2026-07-17T00:00:00.000Z",
  );
}

test("D2 authority head rejects reads outside an active Runtime transaction", async () => {
  const fixture = createFileBackedRuntime("outside-transaction");
  try {
    assert.throws(
      () => buildLiteLearningRuntimeAuthorityHeadV1({
        database: fixture.database,
        databaseLineage: databaseLineage(fixture.database),
      }),
      /lite_learning_runtime_authority_head_active_transaction_required/,
    );
    assert.throws(
      () => readLiteLearningRuntimeAuthorityExactRows({
        database: fixture.database,
        table: "lite_runtime_write_operations",
        columns: ["operation_id"],
        bindings: { scope: EXTERNAL_SCOPE, operation_id: "operation-outside" },
      }),
      /lite_learning_runtime_authority_head_active_transaction_required/,
    );
  } finally {
    await fixture.close();
  }
});

test("D2 authority head commits an empty 22-table current-schema snapshot inside one transaction", async () => {
  const fixture = createFileBackedRuntime("empty-current");
  try {
    const head = await fixture.database.withTx(async () =>
      buildLiteLearningRuntimeAuthorityHeadV1({
        database: fixture.database,
        databaseLineage: databaseLineage(fixture.database),
      }));

    assert.equal(LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS.length, 22);
    assert.equal(head.body.schema_version, 6);
    assert.equal(head.body.tables.length, 22);
    assert.deepEqual(
      head.body.tables.map((table) => [table.table, table.row_count]),
      LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS.map((table) => [table.table, 0]),
    );
    assert.equal(head.body.external_scope_operations.row_count, 0);
    assert.match(head.body.external_scope_operations.rows_sha256, /^[0-9a-f]{64}$/u);
    assert.match(head.authority_head_sha256, /^[0-9a-f]{64}$/u);
  } finally {
    await fixture.close();
  }
});

test("D2 authority head closes over every tenant and kind in the exact external scope only", async () => {
  const fixture = createFileBackedRuntime("external-operation");
  try {
    const emptyHead = await fixture.database.withTx(async () =>
      buildLiteLearningRuntimeAuthorityHeadV1({
        database: fixture.database,
        databaseLineage: databaseLineage(fixture.database),
      }));

    const firstProtectedHead = await fixture.database.withTx(async () => {
      insertExternalOperation({
        database: fixture.database,
        operationId: "operation-text-scope",
        tenantId: "tenant-authority-head-a",
        operationKind: "learning_evidence_ingest_v1",
      });
      return buildLiteLearningRuntimeAuthorityHeadV1({
        database: fixture.database,
        databaseLineage: databaseLineage(fixture.database),
      });
    });

    const allProtectedHead = await fixture.database.withTx(async () => {
      insertExternalOperation({
        database: fixture.database,
        operationId: "operation-other-tenant-kind",
        tenantId: "tenant-authority-head-b",
        operationKind: "learning_external_reserve_v1",
      });
      return buildLiteLearningRuntimeAuthorityHeadV1({
        database: fixture.database,
        databaseLineage: databaseLineage(fixture.database),
      });
    });

    const unrelatedScopeHead = await fixture.database.withTx(async () => {
      insertExternalOperation({
        database: fixture.database,
        operationId: "operation-unrelated-scope",
        tenantId: "tenant-authority-head-c",
        operationKind: "learning_evidence_ingest_v1",
        scope: "unrelated_runtime_scope_v1",
      });
      return buildLiteLearningRuntimeAuthorityHeadV1({
        database: fixture.database,
        databaseLineage: databaseLineage(fixture.database),
      });
    });

    const firstClosure = firstProtectedHead.body.external_scope_operations;
    const closure = allProtectedHead.body.external_scope_operations;
    assert.equal(firstClosure.row_count, 1);
    assert.equal(closure.row_count, 2);
    assert.notEqual(closure.rows_sha256, emptyHead.body.external_scope_operations.rows_sha256);
    assert.notEqual(closure.rows_sha256, firstClosure.rows_sha256);
    assert.equal(
      closure.closure_sha256,
      learningRuntimeAuthorityExternalOperationClosureDigest({
        rowCount: closure.row_count,
        rowsSha256: closure.rows_sha256,
      }),
    );
    assert.notEqual(firstProtectedHead.authority_head_sha256, emptyHead.authority_head_sha256);
    assert.notEqual(allProtectedHead.authority_head_sha256, firstProtectedHead.authority_head_sha256);
    assert.deepEqual(
      unrelatedScopeHead.body.external_scope_operations,
      allProtectedHead.body.external_scope_operations,
    );
    assert.equal(unrelatedScopeHead.authority_head_sha256, allProtectedHead.authority_head_sha256);
  } finally {
    await fixture.close();
  }
});

test("D2 authority head detects frozen-table insertion and the database forbids substitution", async () => {
  const fixture = createFileBackedRuntime("authority-table-substitution");
  try {
    const emptyHead = await fixture.database.withTx(async () =>
      buildLiteLearningRuntimeAuthorityHeadV1({
        database: fixture.database,
        databaseLineage: databaseLineage(fixture.database),
      }));

    const firstPolicyJson = "{\"mode\":\"first\"}";
    const insertedHead = await fixture.database.withTx(async () => {
      fixture.database.db.prepare(
        `INSERT INTO lite_learning_policy_versions (
           tenant_id,
           policy_kind,
           policy_id,
           policy_version,
           policy_config_sha256,
           policy_config_json,
           implementation_contract_sha256,
           prospective_calibration_sha256,
           prospective_calibration_json,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      ).run(
        "tenant-authority-head",
        "candidate",
        "candidate-authority-head",
        "1",
        sha256(firstPolicyJson),
        firstPolicyJson,
        sha256("candidate-authority-head-implementation"),
        "2026-07-17T00:00:00.000Z",
      );
      return buildLiteLearningRuntimeAuthorityHeadV1({
        database: fixture.database,
        databaseLineage: databaseLineage(fixture.database),
      });
    });

    const substitutedPolicyJson = "{\"mode\":\"substituted\"}";
    await assert.rejects(
      fixture.database.withTx(async () => {
        fixture.database.db.prepare(
          `UPDATE lite_learning_policy_versions
           SET policy_config_sha256 = ?, policy_config_json = ?
           WHERE tenant_id = ?
             AND policy_kind = ?
             AND policy_id = ?
             AND policy_version = ?`,
        ).run(
          sha256(substitutedPolicyJson),
          substitutedPolicyJson,
          "tenant-authority-head",
          "candidate",
          "candidate-authority-head",
          "1",
        );
      }),
      /lite_learning_policy_versions_update_forbidden/u,
    );

    const policyHead = (head: typeof insertedHead) => head.body.tables.find(
      ({ table }) => table === "lite_learning_policy_versions",
    )!;
    assert.equal(policyHead(emptyHead).row_count, 0);
    assert.equal(policyHead(insertedHead).row_count, 1);
    assert.notEqual(policyHead(insertedHead).rows_sha256, policyHead(emptyHead).rows_sha256);
    assert.notEqual(insertedHead.authority_head_sha256, emptyHead.authority_head_sha256);
  } finally {
    await fixture.close();
  }
});

test("D2 exact reader returns only the exact row with SQLite storage classes and bytes", async () => {
  const fixture = createFileBackedRuntime("exact-reader");
  try {
    const rows = await fixture.database.withTx(async () => {
      insertExternalOperation({
        database: fixture.database,
        operationId: "operation-exact-target",
        receiptJson: "{\"result\":\"✓\"}",
      });
      insertExternalOperation({
        database: fixture.database,
        operationId: "operation-exact-other",
      });
      return readLiteLearningRuntimeAuthorityExactRows({
        database: fixture.database,
        table: "lite_runtime_write_operations",
        columns: ["tenant_id", "scope", "operation_id", "receipt_json", "commit_id"],
        bindings: {
          tenant_id: "tenant-authority-head",
          scope: EXTERNAL_SCOPE,
          operation_kind: "evidence_ingest",
          operation_id: "operation-exact-target",
        },
      });
    });

    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]!), [
      "tenant_id",
      "scope",
      "operation_id",
      "receipt_json",
      "commit_id",
    ]);
    assert.deepEqual(rows[0], {
      tenant_id: {
        storage_class: "text",
        value: Buffer.from("tenant-authority-head", "utf8"),
      },
      scope: {
        storage_class: "text",
        value: Buffer.from(EXTERNAL_SCOPE, "utf8"),
      },
      operation_id: {
        storage_class: "text",
        value: Buffer.from("operation-exact-target", "utf8"),
      },
      receipt_json: {
        storage_class: "text",
        value: Buffer.from("{\"result\":\"✓\"}", "utf8"),
      },
      commit_id: { storage_class: "null", value: null },
    });
  } finally {
    await fixture.close();
  }
});

test("D2 authority head rejects a same-byte BLOB alias for the external scope", async () => {
  const fixture = createFileBackedRuntime("blob-scope-alias");
  try {
    await assert.rejects(
      fixture.database.withTx(async () => {
        insertExternalOperation({
          database: fixture.database,
          operationId: "operation-blob-scope",
          scope: Buffer.from(EXTERNAL_SCOPE, "utf8"),
        });
        const stored = fixture.database.db.prepare(
          `SELECT typeof(scope) AS storage_class
           FROM lite_runtime_write_operations
           WHERE operation_id = ?`,
        ).get("operation-blob-scope") as { storage_class: string };
        assert.equal(stored.storage_class, "blob");
        buildLiteLearningRuntimeAuthorityHeadV1({
          database: fixture.database,
          databaseLineage: databaseLineage(fixture.database),
        });
      }),
      /lite_learning_runtime_authority_head_operation_scope_storage_alias/,
    );
  } finally {
    await fixture.close();
  }
});

test("D2 authority head rejects invalid UTF-8 stored with SQLite TEXT class", async () => {
  const fixture = createFileBackedRuntime("invalid-utf8-text");
  try {
    await assert.rejects(
      fixture.database.withTx(async () => {
        fixture.database.db.prepare(
          `INSERT INTO lite_runtime_write_operations (
             tenant_id,
             scope,
             operation_kind,
             operation_id,
             request_sha256,
             receipt_json,
             commit_id,
             created_at
           ) VALUES (?, ?, ?, ?, ?, CAST(? AS TEXT), ?, ?)`,
        ).run(
          "tenant-authority-head",
          EXTERNAL_SCOPE,
          "evidence_ingest",
          "operation-invalid-utf8",
          sha256("request:operation-invalid-utf8"),
          Buffer.from([0x80]),
          null,
          "2026-07-17T00:00:00.000Z",
        );
        const stored = fixture.database.db.prepare(
          `SELECT typeof(receipt_json) AS storage_class
           FROM lite_runtime_write_operations
           WHERE operation_id = ?`,
        ).get("operation-invalid-utf8") as { storage_class: string };
        assert.equal(stored.storage_class, "text");
        buildLiteLearningRuntimeAuthorityHeadV1({
          database: fixture.database,
          databaseLineage: databaseLineage(fixture.database),
        });
      }),
      /lite_learning_runtime_authority_head_text_invalid_utf8:lite_runtime_write_operations\.receipt_json/,
    );
  } finally {
    await fixture.close();
  }
});

test("D2 authority head rejects lineage for a different Runtime database identity", async () => {
  const fixture = createFileBackedRuntime("wrong-database-lineage");
  try {
    await assert.rejects(
      fixture.database.withTx(async () => {
        buildLiteLearningRuntimeAuthorityHeadV1({
          database: fixture.database,
          databaseLineage: {
            database_instance_id: sha256("wrong-authority-head-database-instance"),
            ...DATABASE_LINEAGE_BASE,
          },
        });
      }),
      /lite_learning_runtime_authority_head_database_lineage_identity_mismatch/,
    );
  } finally {
    await fixture.close();
  }
});

test("D2 authority head rejects an uninitialized Runtime schema", async () => {
  const fixture = createFileBackedRuntime("uninitialized", false);
  try {
    await assert.rejects(
      fixture.database.withTx(async () => {
        buildLiteLearningRuntimeAuthorityHeadV1({
          database: fixture.database,
          databaseLineage: {
            database_instance_id: sha256("wrong-authority-head-database-instance"),
            ...DATABASE_LINEAGE_BASE,
          },
        });
      }),
      /lite_learning_runtime_authority_head_current_v5_database_required/,
    );
  } finally {
    await fixture.close();
  }
});

test("D2 authority head rejects a database labeled with a non-v5 Runtime schema", async () => {
  const fixture = createFileBackedRuntime("non-v5");
  try {
    fixture.database.db.prepare(
      `UPDATE lite_runtime_schema_metadata
       SET version = 3
       WHERE component = ?`,
    ).run(LITE_RUNTIME_WRITE_SCHEMA_COMPONENT);

    await assert.rejects(
      fixture.database.withTx(async () => {
        buildLiteLearningRuntimeAuthorityHeadV1({
          database: fixture.database,
          databaseLineage: databaseLineage(fixture.database),
        });
      }),
      /lite_learning_runtime_authority_head_current_v5_database_required/,
    );
  } finally {
    await fixture.close();
  }
});

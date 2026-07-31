import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeExecutionEpisodeV7ObjectsForPreviousSchemaFixture } from
  "./schema-fixture-helpers.ts";

import {
  inspectLiteMemoryCommitAuthority,
} from "../../src/store/lite-memory-commit-integrity.ts";
import {
  LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE,
  LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_OPERATION,
  LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE,
} from "../../src/store/lite-runtime-authority-adoption-contract.ts";
import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.ts";
import {
  inspectLiteRuntimeSchema,
  LITE_RUNTIME_WRITE_SCHEMA_VERSION,
} from "../../src/store/lite-runtime-schema.ts";
import {
  createLiteWriteStore,
  createLiteWriteStoreFromDatabase,
} from "../../src/store/lite-write-store.ts";
import { createSqliteDatabase, type SqliteDatabase } from "../../src/store/sqlite.ts";

const DELEGATED_OPERATION_KIND = "product_guide_v1";
const DELEGATED_OPERATION_SCOPE = "scope/authority-adoption";
const DELEGATED_OPERATION_ID = "delegated-operation-v5";
const DELEGATED_OPERATION_CREATED_AT = "2026-07-19T00:00:00.000Z";

function tempDatabase(name: string): { directory: string; path: string } {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `aionis-authority-adoption-${name}-`),
  );
  return { directory, path: path.join(directory, "runtime.sqlite") };
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(table) !== undefined;
}

function countRows(db: SqliteDatabase, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  }).count);
}

function seedDelegatedV5Operation(db: SqliteDatabase): void {
  db.prepare(
    `INSERT INTO lite_runtime_write_operations
      (tenant_id, scope, operation_kind, operation_id, request_sha256,
       receipt_json, commit_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    "tenant-authority-adoption",
    DELEGATED_OPERATION_SCOPE,
    DELEGATED_OPERATION_KIND,
    DELEGATED_OPERATION_ID,
    "a".repeat(64),
    JSON.stringify({
      contract_version: "authority_adoption_delegated_fixture_v1",
      ok: true,
    }),
    DELEGATED_OPERATION_CREATED_AT,
  );
}

async function prepareV5DelegatedFixture(name: string): Promise<{
  directory: string;
  path: string;
}> {
  const temp = tempDatabase(name);
  try {
    const initialized = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await initialized.close();

    const db = createSqliteDatabase(temp.path);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        removeExecutionEpisodeV7ObjectsForPreviousSchemaFixture(db);
        db.exec(`DROP TABLE ${LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE}`);
        db.exec(`DROP TABLE ${LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE}`);
        db.prepare(
          `UPDATE lite_runtime_schema_metadata
           SET version = 5, updated_at = ?
           WHERE component = 'write_projection'`,
        ).run(DELEGATED_OPERATION_CREATED_AT);
        seedDelegatedV5Operation(db);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      const schema = inspectLiteRuntimeSchema(db);
      assert.equal(schema.classification, "supported_previous_v5", JSON.stringify(schema));
      assert.equal(schema.detected_version, 5);
      const authority = inspectLiteMemoryCommitAuthority(db);
      assert.equal(authority.ok, true, JSON.stringify(authority.findings));
      assert.equal(authority.terminal_delegated_operation_row_count, 1);
      assert.equal(authority.terminal_adopted_row_count, 0);
    } finally {
      db.close();
    }
    return temp;
  } catch (error) {
    fs.rmSync(temp.directory, { recursive: true, force: true });
    throw error;
  }
}

async function migrateDelegatedFixture(name: string): Promise<{
  directory: string;
  path: string;
}> {
  const temp = await prepareV5DelegatedFixture(name);
  try {
    const migrated = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await migrated.close();
    return temp;
  } catch (error) {
    fs.rmSync(temp.directory, { recursive: true, force: true });
    throw error;
  }
}

test("fresh v6 authority adoption surface is sealed, empty, and authoritative", async () => {
  const temp = tempDatabase("fresh-v6");
  try {
    const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await store.close();

    const db = createSqliteDatabase(temp.path);
    try {
      const schema = inspectLiteRuntimeSchema(db);
      assert.equal(schema.classification, "current", JSON.stringify(schema));
      assert.equal(schema.detected_version, 8);
      assert.equal(LITE_RUNTIME_WRITE_SCHEMA_VERSION, 8);
      assert.equal(countRows(db, LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE), 0);
      assert.equal(countRows(db, LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE), 0);

      const authority = inspectLiteMemoryCommitAuthority(db);
      assert.equal(authority.ok, true, JSON.stringify(authority.findings));
      assert.equal(authority.adoption_manifest_count, 0);
      assert.equal(authority.adoption_binding_count, 0);
      assert.equal(authority.adoption_binding_verified_count, 0);
      assert.equal(authority.adoption_assurance, "not_applicable");
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("v5 delegated operation becomes an exact v6 binding claimed by a direct v2 commit", async () => {
  const temp = await migrateDelegatedFixture("delegated-v5-to-v6");
  try {
    const db = createSqliteDatabase(temp.path);
    try {
      const schema = inspectLiteRuntimeSchema(db);
      assert.equal(schema.classification, "current", JSON.stringify(schema));
      assert.equal(schema.detected_version, 8);

      const manifest = db.prepare(
        `SELECT scope, manifest_id, source_schema_version, target_schema_version,
                canonicalization_contract, binding_count, binding_set_sha256,
                commit_id, created_at
         FROM ${LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE}`,
      ).get() as Record<string, unknown> | undefined;
      const binding = db.prepare(
        `SELECT scope, manifest_id, authority_table, identity_json,
                identity_sha256, row_sha256, adoption_kind, created_at
         FROM ${LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE}`,
      ).get() as Record<string, unknown> | undefined;
      assert.ok(manifest);
      assert.ok(binding);
      assert.equal(countRows(db, LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE), 1);
      assert.equal(countRows(db, LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE), 1);
      assert.equal(manifest.scope, DELEGATED_OPERATION_SCOPE);
      assert.equal(manifest.source_schema_version, 5);
      assert.equal(manifest.target_schema_version, 6);
      assert.equal(manifest.binding_count, 1);
      assert.equal(binding.scope, DELEGATED_OPERATION_SCOPE);
      assert.equal(binding.manifest_id, manifest.manifest_id);
      assert.equal(binding.authority_table, "lite_runtime_write_operations");
      assert.equal(binding.adoption_kind, LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_OPERATION);
      assert.deepEqual(JSON.parse(String(binding.identity_json)), {
        operation_id: DELEGATED_OPERATION_ID,
        operation_kind: DELEGATED_OPERATION_KIND,
        scope: DELEGATED_OPERATION_SCOPE,
        tenant_id: "tenant-authority-adoption",
      });

      const commit = db.prepare(
        `SELECT id, scope, parent_commit_id, diff_json, digest_version, revision,
                legacy_anchor_commit_id
         FROM lite_memory_commits WHERE id = ?`,
      ).get(manifest.commit_id) as Record<string, unknown> | undefined;
      assert.ok(commit);
      assert.equal(commit.scope, DELEGATED_OPERATION_SCOPE);
      assert.equal(commit.parent_commit_id, null);
      assert.equal(commit.digest_version, 2);
      assert.equal(commit.revision, 1);
      assert.equal(commit.legacy_anchor_commit_id, null);
      const diff = JSON.parse(String(commit.diff_json)) as Record<string, unknown>;
      assert.equal(diff.contract, "aionis_applied_authority_mutation_v2");
      assert.equal(diff.authority_kind, "runtime_authority_adoption");
      const mutations = diff.mutations as Array<Record<string, unknown>>;
      assert.equal(mutations.length, 1);
      assert.equal(mutations[0]?.table, LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE);
      assert.equal(mutations[0]?.operation, "insert");
      assert.equal((mutations[0]?.after as Record<string, unknown>).commit_id, "$self");

      const head = db.prepare(
        `SELECT commit_id, revision FROM lite_memory_scope_heads WHERE scope = ?`,
      ).get(DELEGATED_OPERATION_SCOPE) as Record<string, unknown> | undefined;
      assert.ok(head);
      assert.equal(head.commit_id, manifest.commit_id);
      assert.equal(head.revision, 1);

      const authority = inspectLiteMemoryCommitAuthority(db);
      assert.equal(authority.ok, true, JSON.stringify(authority.findings));
      assert.equal(authority.v2_commit_count, 1);
      assert.equal(authority.terminal_delegated_operation_row_count, 0);
      assert.equal(authority.terminal_adopted_row_count, 1);
      assert.equal(authority.adoption_manifest_count, 1);
      assert.equal(authority.adoption_binding_count, 1);
      assert.equal(authority.adoption_binding_verified_count, 1);
      assert.equal(
        authority.adoption_assurance,
        "immutable_v5_authority_field_bindings_authenticated_by_v2_manifest",
      );
      assert.equal(
        authority.terminal_authority_assurance,
        "latest_v2_claims_match_with_authenticated_adoption",
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("v6 seals forbid every manifest and binding insert, update, and delete", async () => {
  const temp = await migrateDelegatedFixture("sealed");
  try {
    const db = createSqliteDatabase(temp.path);
    try {
      assert.throws(
        () => db.exec(
          `INSERT INTO ${LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE}
           SELECT * FROM ${LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE} LIMIT 1`,
        ),
        /authority adoption is sealed/u,
      );
      assert.throws(
        () => db.exec(
          `INSERT INTO ${LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE}
           SELECT * FROM ${LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE} LIMIT 1`,
        ),
        /authority adoption is sealed/u,
      );
      assert.throws(
        () => db.exec(
          `UPDATE ${LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE}
           SET created_at = created_at`,
        ),
        /authority adoption manifest is immutable/u,
      );
      assert.throws(
        () => db.exec(`DELETE FROM ${LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE}`),
        /authority adoption manifest is immutable/u,
      );
      assert.throws(
        () => db.exec(
          `UPDATE ${LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE}
           SET created_at = created_at`,
        ),
        /authority adoption binding is immutable/u,
      );
      assert.throws(
        () => db.exec(`DELETE FROM ${LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE}`),
        /authority adoption binding is immutable/u,
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("authority scanner rejects a post-adoption business-row tamper", async () => {
  const temp = await migrateDelegatedFixture("tamper");
  try {
    const db = createSqliteDatabase(temp.path);
    try {
      db.prepare(
        `UPDATE lite_runtime_write_operations
         SET receipt_json = ?
         WHERE scope = ? AND operation_kind = ? AND operation_id = ?`,
      ).run(
        JSON.stringify({ contract_version: "tampered_v1", ok: false }),
        DELEGATED_OPERATION_SCOPE,
        DELEGATED_OPERATION_KIND,
        DELEGATED_OPERATION_ID,
      );

      const authority = inspectLiteMemoryCommitAuthority(db);
      assert.equal(authority.ok, false);
      assert.equal(authority.terminal_adopted_row_count, 0);
      assert.equal(authority.terminal_unclaimed_row_count, 1);
      assert.equal(authority.adoption_binding_verified_count, 0);
      assert.equal(authority.adoption_assurance, "invalid");
      const findingCodes = new Set(authority.findings.map((finding) => finding.code));
      assert.equal(
        findingCodes.has("lite_memory_commit_authority_terminal_row_unclaimed"),
        true,
      );
      assert.equal(
        findingCodes.has("lite_memory_commit_authority_adoption_binding_unmatched"),
        true,
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("v5-to-v6 adoption failure rolls back bindings, manifest commit, head, and metadata", async () => {
  const temp = await prepareV5DelegatedFixture("rollback");
  try {
    const database = createLiteRuntimeDatabase(temp.path);
    try {
      assert.throws(
        () => createLiteWriteStoreFromDatabase(database, {
          annProjectionEnabled: false,
          schemaMigrationFaultInjector(phase) {
            if (phase === "after_authority_adoption_structures") {
              throw new Error("injected-authority-adoption-failure");
            }
          },
        }),
        /injected-authority-adoption-failure/u,
      );
    } finally {
      await database.close();
    }

    const rolledBack = createSqliteDatabase(temp.path);
    try {
      const schema = inspectLiteRuntimeSchema(rolledBack);
      assert.equal(schema.classification, "supported_previous_v5", JSON.stringify(schema));
      assert.equal(schema.detected_version, 5);
      assert.equal(tableExists(rolledBack, LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE), false);
      assert.equal(tableExists(rolledBack, LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE), false);
      assert.equal(countRows(rolledBack, "lite_memory_commits"), 0);
      assert.equal(countRows(rolledBack, "lite_memory_scope_heads"), 0);
      assert.equal(countRows(rolledBack, "lite_runtime_write_operations"), 1);
      const authority = inspectLiteMemoryCommitAuthority(rolledBack);
      assert.equal(authority.ok, true, JSON.stringify(authority.findings));
      assert.equal(authority.terminal_delegated_operation_row_count, 1);
    } finally {
      rolledBack.close();
    }

    const retry = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await retry.close();
    const recovered = createSqliteDatabase(temp.path);
    try {
      assert.equal(inspectLiteRuntimeSchema(recovered).classification, "current");
      const authority = inspectLiteMemoryCommitAuthority(recovered);
      assert.equal(authority.ok, true, JSON.stringify(authority.findings));
      assert.equal(authority.adoption_manifest_count, 1);
      assert.equal(authority.adoption_binding_verified_count, 1);
    } finally {
      recovered.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

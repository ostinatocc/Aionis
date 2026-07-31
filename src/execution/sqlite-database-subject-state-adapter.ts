import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  DatabaseSync,
  backup,
  type SQLOutputValue,
} from "node:sqlite";

import stableStringify from "fast-json-stable-stringify";

import {
  SqliteDatabaseSubjectStateSpecV1Schema,
  executionEpisodeSubjectIdentityDigest,
  executionEpisodeSubjectStateSpecDigest,
  type SqliteDatabaseSubjectStateSpecV1,
} from "../memory/execution-episode.js";
import {
  materializeVerifierFileSubjectFromSnapshot,
} from "./verifier-subject-materialization.js";
import {
  ExecutionSubjectV1Schema,
  StateDeltaV1Schema,
  StateSnapshotV2Schema,
  SubjectCapabilityDescriptorV1Schema,
  deterministicSubjectContractId,
  executionSubjectId,
  stateContentRef,
  stateDeltaContentRef,
  subjectCapabilityDescriptorDigest,
  subjectCapabilityDescriptorRef,
  type CapturedSubjectDeltaV1,
  type CapturedSubjectStateV2,
  type ExecutionSubjectV1,
  type SubjectStateAdapter,
} from "./subject-state-adapter.js";

export const SQLITE_DATABASE_SUBJECT_ADAPTER_ID =
  "sqlite_database_subject_v1";
export const SQLITE_DATABASE_SUBJECT_ADAPTER_VERSION = "1";
export const SQLITE_DATABASE_CAPTURE_ALGORITHM_ID =
  "aionis_sqlite_database_state_capture";
export const SQLITE_DATABASE_CAPTURE_ALGORITHM_VERSION = "1";
export const SQLITE_DATABASE_STATE_MEDIA_TYPE = "application/vnd.sqlite3";
export const SQLITE_DATABASE_DELTA_MEDIA_TYPE =
  "application/vnd.aionis.sqlite-database-delta.v1+json";

const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
const MAX_TABLE_ROWS = 2_000_000;

export type SqliteDatabaseSubjectAdapterInputV1 = Readonly<{
  database_path: string;
  subject_state_spec?: SqliteDatabaseSubjectStateSpecV1;
}>;

type SqliteSchemaEntryV1 = Readonly<{
  type: string;
  name: string;
  table_name: string;
  root_page: string;
  sql: string | null;
}>;

type SqliteLogicalViewV1 = Readonly<{
  schema: readonly SqliteSchemaEntryV1[];
  table_digests: Readonly<Record<string, string | null>>;
}>;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalInput(value: unknown): Readonly<{
  database_path: string;
  subject_state_spec: SqliteDatabaseSubjectStateSpecV1;
}> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new Error("sqlite_database_subject_adapter_input_invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length < 1
    || keys.length > 2
    || !Object.hasOwn(record, "database_path")
    || keys.some(
      (key) => key !== "database_path" && key !== "subject_state_spec",
    )
    || typeof record.database_path !== "string"
    || record.database_path.length === 0
    || record.database_path.includes("\u0000")
    || record.database_path.includes("\r")
    || record.database_path.includes("\n")
    || Buffer.byteLength(record.database_path, "utf8") > 4 * 1024
  ) {
    throw new Error("sqlite_database_subject_adapter_input_invalid");
  }
  let databasePath: string;
  try {
    databasePath = realpathSync.native(record.database_path);
    const stats = lstatSync(databasePath);
    if (
      !stats.isFile()
      || stats.isSymbolicLink()
      || stats.size > MAX_DATABASE_BYTES
    ) {
      throw new Error("not_bounded_regular_file");
    }
  } catch {
    throw new Error("sqlite_database_subject_adapter_path_unavailable");
  }
  const subjectStateSpec = SqliteDatabaseSubjectStateSpecV1Schema.parse(
    record.subject_state_spec ?? {
      contract_version: "sqlite_database_subject_state_spec_v1",
      capture_scope: "entire_database",
    },
  );
  return Object.freeze({
    database_path: databasePath,
    subject_state_spec: subjectStateSpec,
  });
}

const SQLITE_DATABASE_CAPABILITIES =
  SubjectCapabilityDescriptorV1Schema.parse({
    contract_version: "subject_capability_descriptor_v1",
    subject_kind: "database",
    capabilities: [
      "capture",
      "delta",
      "restore",
      "runtime_owned_capture",
      "verifier_materialization",
    ],
    snapshot_media_types: [SQLITE_DATABASE_STATE_MEDIA_TYPE],
    delta_media_types: [SQLITE_DATABASE_DELTA_MEDIA_TYPE],
  });

function subjectFromInput(input: ReturnType<typeof canonicalInput>) {
  const identityMaterial = {
    contract_version: "execution_episode_subject_identity_v1" as const,
    state_kind: "database" as const,
    canonical_root_sha256: sha256(
      Buffer.from(input.database_path, "utf8"),
    ),
    capture_algorithm_id: SQLITE_DATABASE_CAPTURE_ALGORITHM_ID,
    capture_algorithm_version: SQLITE_DATABASE_CAPTURE_ALGORITHM_VERSION,
    subject_state_spec: input.subject_state_spec,
    subject_state_spec_sha256:
      executionEpisodeSubjectStateSpecDigest(input.subject_state_spec),
  };
  const identitySha256 =
    executionEpisodeSubjectIdentityDigest(identityMaterial);
  const capabilitySha256 = subjectCapabilityDescriptorDigest(
    SQLITE_DATABASE_CAPABILITIES,
  );
  return ExecutionSubjectV1Schema.parse({
    contract_version: "execution_subject_v1",
    subject_id: executionSubjectId(identitySha256),
    kind: "database",
    adapter_id: SQLITE_DATABASE_SUBJECT_ADAPTER_ID,
    adapter_version: SQLITE_DATABASE_SUBJECT_ADAPTER_VERSION,
    identity_sha256: identitySha256,
    capability_descriptor_ref:
      subjectCapabilityDescriptorRef(capabilitySha256),
    capability_descriptor_sha256: capabilitySha256,
  });
}

function assertSubjectMatches(
  expected: ExecutionSubjectV1,
  actual: ExecutionSubjectV1,
): void {
  if (stableStringify(expected) !== stableStringify(actual)) {
    throw new Error("sqlite_database_subject_adapter_identity_mismatch");
  }
}

function openReadOnly(path: string): DatabaseSync {
  const database = new DatabaseSync(path, {
    readOnly: true,
    timeout: 30_000,
    enableForeignKeyConstraints: false,
  });
  database.exec("PRAGMA query_only = ON");
  return database;
}

function integrityCheck(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA quick_check").get();
  if (!row || Object.values(row)[0] !== "ok") {
    throw new Error("sqlite_database_subject_integrity_check_failed");
  }
}

async function snapshotDatabase(path: string): Promise<Buffer> {
  const parent = mkdtempSync(join(tmpdir(), "aionis-sqlite-capture-"));
  const target = join(parent, "snapshot.sqlite");
  let database: DatabaseSync | null = null;
  try {
    database = openReadOnly(path);
    integrityCheck(database);
    await backup(database, target);
    const bytes = readFileSync(target);
    if (bytes.byteLength > MAX_DATABASE_BYTES) {
      throw new Error("sqlite_database_subject_snapshot_too_large");
    }
    return bytes;
  } finally {
    database?.close();
    rmSync(parent, { recursive: true, force: true });
  }
}

function withSnapshotDatabase<T>(
  bytes: Uint8Array,
  inspect: (database: DatabaseSync) => T,
): T {
  if (bytes.byteLength > MAX_DATABASE_BYTES) {
    throw new Error("sqlite_database_subject_snapshot_too_large");
  }
  const parent = mkdtempSync(join(tmpdir(), "aionis-sqlite-inspect-"));
  const path = join(parent, "snapshot.sqlite");
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  let database: DatabaseSync | null = null;
  try {
    database = openReadOnly(path);
    integrityCheck(database);
    return inspect(database);
  } finally {
    database?.close();
    rmSync(parent, { recursive: true, force: true });
  }
}

function encodedSqlValue(value: SQLOutputValue): unknown {
  if (value === null) return { type: "null" };
  if (typeof value === "bigint") {
    return { type: "integer", value: value.toString(10) };
  }
  if (typeof value === "number") {
    return {
      type: Number.isInteger(value) ? "integer" : "real",
      value: Object.is(value, -0) ? "-0" : String(value),
    };
  }
  if (typeof value === "string") return { type: "text", value };
  return {
    type: "blob",
    value_base64: Buffer.from(value).toString("base64"),
  };
}

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function tableDigest(
  database: DatabaseSync,
  tableName: string,
): string | null {
  try {
    const statement = database.prepare(
      `SELECT * FROM ${quotedIdentifier(tableName)}`,
    );
    statement.setReadBigInts(true);
    const rowDigests: string[] = [];
    for (const row of statement.iterate()) {
      if (rowDigests.length >= MAX_TABLE_ROWS) {
        throw new Error("sqlite_database_subject_row_limit_exceeded");
      }
      const encoded = Object.keys(row).map((column) => [
        column,
        encodedSqlValue(row[column]!),
      ]);
      rowDigests.push(sha256(Buffer.from(stableStringify(encoded), "utf8")));
    }
    rowDigests.sort(compareUtf8);
    return sha256(Buffer.from(stableStringify({
      contract_version: "sqlite_table_multiset_digest_v1",
      table_name: tableName,
      row_digests: rowDigests,
    }), "utf8"));
  } catch (error) {
    if (
      error instanceof Error
      && error.message === "sqlite_database_subject_row_limit_exceeded"
    ) {
      throw error;
    }
    return null;
  }
}

function logicalView(bytes: Uint8Array): SqliteLogicalViewV1 {
  return withSnapshotDatabase(bytes, (database) => {
    const rows = database.prepare(`
      SELECT
        type,
        name,
        tbl_name AS table_name,
        rootpage AS root_page,
        sql
      FROM sqlite_schema
      ORDER BY type COLLATE BINARY, name COLLATE BINARY
    `).all();
    const schema = rows.map((row): SqliteSchemaEntryV1 => {
      if (
        typeof row.type !== "string"
        || typeof row.name !== "string"
        || typeof row.table_name !== "string"
        || (
          typeof row.root_page !== "number"
          && typeof row.root_page !== "bigint"
        )
        || (row.sql !== null && typeof row.sql !== "string")
      ) {
        throw new Error("sqlite_database_subject_schema_invalid");
      }
      return Object.freeze({
        type: row.type,
        name: row.name,
        table_name: row.table_name,
        root_page: String(row.root_page),
        sql: row.sql,
      });
    });
    const tableNames = schema
      .filter((entry) =>
        entry.type === "table" && !entry.name.startsWith("sqlite_"))
      .map((entry) => entry.name)
      .sort(compareUtf8);
    const tableDigests: Record<string, string | null> = {};
    for (const tableName of tableNames) {
      tableDigests[tableName] = tableDigest(database, tableName);
    }
    return Object.freeze({
      schema: Object.freeze(schema),
      table_digests: Object.freeze(tableDigests),
    });
  });
}

function changedReference(namespace: string, name: string): string {
  const plain = `${namespace}/${name}`;
  if (Buffer.byteLength(plain, "utf8") <= 2_048) return plain;
  return `${namespace}/sha256:${sha256(Buffer.from(name, "utf8"))}`;
}

function sqliteChangedFields(
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
): string[] {
  const before = logicalView(beforeBytes);
  const after = logicalView(afterBytes);
  const changed = new Set<string>();
  const beforeSchema = new Map(before.schema.map((entry) => [
    `${entry.type}\u0000${entry.name}`,
    stableStringify(entry),
  ]));
  const afterSchema = new Map(after.schema.map((entry) => [
    `${entry.type}\u0000${entry.name}`,
    stableStringify(entry),
  ]));
  for (const key of new Set([
    ...beforeSchema.keys(),
    ...afterSchema.keys(),
  ])) {
    if (beforeSchema.get(key) !== afterSchema.get(key)) {
      const [type, name] = key.split("\u0000");
      changed.add(changedReference(`schema/${type}`, name!));
    }
  }
  for (const tableName of new Set([
    ...Object.keys(before.table_digests),
    ...Object.keys(after.table_digests),
  ])) {
    if (
      before.table_digests[tableName]
      !== after.table_digests[tableName]
    ) {
      changed.add(changedReference("tables", tableName));
    }
  }
  if (
    changed.size === 0
    && !Buffer.from(beforeBytes).equals(Buffer.from(afterBytes))
  ) {
    changed.add("database:$physical");
  }
  return [...changed].sort(compareUtf8);
}

function capturedDatabase(
  captured: CapturedSubjectStateV2,
): Buffer {
  if (
    captured.snapshot.content_media_type !== SQLITE_DATABASE_STATE_MEDIA_TYPE
    || captured.snapshot.content_encoding !== "binary"
    || sha256(captured.artifact.bytes)
      !== captured.snapshot.content_sha256
  ) {
    throw new Error("sqlite_database_subject_snapshot_invalid");
  }
  withSnapshotDatabase(captured.artifact.bytes, () => undefined);
  return captured.artifact.bytes;
}

let environmentSha256: string | null = null;

function captureEnvironmentSha256(databasePath: string): string {
  if (environmentSha256 !== null) return environmentSha256;
  const database = openReadOnly(databasePath);
  try {
    const row = database.prepare("SELECT sqlite_version() AS version").get();
    if (!row || typeof row.version !== "string") {
      throw new Error("sqlite_database_subject_version_unavailable");
    }
    environmentSha256 = sha256(Buffer.from(stableStringify({
      contract_version: "sqlite_database_capture_environment_v1",
      algorithm_id: SQLITE_DATABASE_CAPTURE_ALGORITHM_ID,
      algorithm_version: SQLITE_DATABASE_CAPTURE_ALGORITHM_VERSION,
      sqlite_version: row.version,
      max_database_bytes: MAX_DATABASE_BYTES,
    }), "utf8"));
    return environmentSha256;
  } finally {
    database.close();
  }
}

export function createSqliteDatabaseSubjectStateAdapter():
SubjectStateAdapter {
  const adapter: SubjectStateAdapter = {
    adapterId: SQLITE_DATABASE_SUBJECT_ADAPTER_ID,
    adapterVersion: SQLITE_DATABASE_SUBJECT_ADAPTER_VERSION,
    capabilities: SQLITE_DATABASE_CAPABILITIES,

    supports(subjectKind) {
      return subjectKind === "database";
    },

    async identify(input) {
      return subjectFromInput(canonicalInput(input));
    },

    async capture(input) {
      const adapterInput = canonicalInput(input.adapter_input);
      const expectedSubject = subjectFromInput(adapterInput);
      assertSubjectMatches(input.subject, expectedSubject);
      const bytes = await snapshotDatabase(adapterInput.database_path);
      const contentSha256 = sha256(bytes);
      const environmentDigest = captureEnvironmentSha256(
        adapterInput.database_path,
      );
      const snapshot = StateSnapshotV2Schema.parse({
        contract_version: "state_snapshot_v2",
        snapshot_id: deterministicSubjectContractId("ess2", {
          contract_version: "state_snapshot_identity_v2",
          subject_id: input.subject.subject_id,
          snapshot_identity_seed: input.snapshot_identity_seed,
          algorithm_id: SQLITE_DATABASE_CAPTURE_ALGORITHM_ID,
          algorithm_version: SQLITE_DATABASE_CAPTURE_ALGORITHM_VERSION,
          environment_sha256: environmentDigest,
          content_sha256: contentSha256,
        }),
        subject: input.subject,
        captured_at: input.captured_at,
        algorithm_id: SQLITE_DATABASE_CAPTURE_ALGORITHM_ID,
        algorithm_version: SQLITE_DATABASE_CAPTURE_ALGORITHM_VERSION,
        environment_sha256: environmentDigest,
        content_ref: stateContentRef(contentSha256),
        content_sha256: contentSha256,
        content_media_type: SQLITE_DATABASE_STATE_MEDIA_TYPE,
        content_encoding: "binary",
        capture_authority: "runtime_adapter",
        attestation_ref: null,
      });
      return Object.freeze({
        snapshot,
        artifact: Object.freeze({
          bytes,
          declared_sha256: contentSha256,
          declared_byte_length: bytes.byteLength,
          media_type: SQLITE_DATABASE_STATE_MEDIA_TYPE,
          encoding: "binary",
        }),
      });
    },

    async diff(input): Promise<CapturedSubjectDeltaV1> {
      if (
        input.before.snapshot.subject.subject_id
          !== input.after.snapshot.subject.subject_id
      ) {
        throw new Error(
          "sqlite_database_subject_adapter_delta_subject_mismatch",
        );
      }
      const fields = sqliteChangedFields(
        capturedDatabase(input.before),
        capturedDatabase(input.after),
      );
      const contentBytes = Buffer.from(stableStringify({
        contract_version: "sqlite_database_delta_content_v1",
        subject_id: input.before.snapshot.subject.subject_id,
        before_snapshot_id: input.before.snapshot.snapshot_id,
        after_snapshot_id: input.after.snapshot.snapshot_id,
        before_content_sha256: input.before.snapshot.content_sha256,
        after_content_sha256: input.after.snapshot.content_sha256,
        changed_fields: fields,
      }), "utf8");
      const contentSha256 = sha256(contentBytes);
      const delta = StateDeltaV1Schema.parse({
        contract_version: "state_delta_v1",
        delta_id: deterministicSubjectContractId("esd1", {
          contract_version: "state_delta_identity_v1",
          subject_id: input.before.snapshot.subject.subject_id,
          before_snapshot_id: input.before.snapshot.snapshot_id,
          after_snapshot_id: input.after.snapshot.snapshot_id,
          content_sha256: contentSha256,
        }),
        subject_id: input.before.snapshot.subject.subject_id,
        before_snapshot_id: input.before.snapshot.snapshot_id,
        after_snapshot_id: input.after.snapshot.snapshot_id,
        changed_fields: fields,
        content_ref: stateDeltaContentRef(contentSha256),
        content_sha256: contentSha256,
        content_media_type: SQLITE_DATABASE_DELTA_MEDIA_TYPE,
        content_encoding: "utf-8",
      });
      return Object.freeze({
        delta,
        artifact: Object.freeze({
          bytes: contentBytes,
          declared_sha256: contentSha256,
          declared_byte_length: contentBytes.byteLength,
          media_type: SQLITE_DATABASE_DELTA_MEDIA_TYPE,
          encoding: "utf-8",
        }),
      });
    },

    async restoreSnapshot(input) {
      const adapterInput = canonicalInput(input.adapter_input);
      const expectedSubject = subjectFromInput(adapterInput);
      assertSubjectMatches(input.subject, expectedSubject);
      const bytes = Buffer.from(input.snapshot_artifact_bytes);
      if (
        stableStringify(input.snapshot.subject)
          !== stableStringify(input.subject)
        || input.snapshot.algorithm_id
          !== SQLITE_DATABASE_CAPTURE_ALGORITHM_ID
        || input.snapshot.algorithm_version
          !== SQLITE_DATABASE_CAPTURE_ALGORITHM_VERSION
        || input.snapshot.environment_sha256
          !== captureEnvironmentSha256(adapterInput.database_path)
        || input.snapshot.content_media_type
          !== SQLITE_DATABASE_STATE_MEDIA_TYPE
        || input.snapshot.content_encoding !== "binary"
        || input.snapshot.content_sha256 !== sha256(bytes)
      ) {
        throw new Error(
          "sqlite_database_subject_restore_snapshot_invalid",
        );
      }
      withSnapshotDatabase(bytes, () => undefined);
      const currentMode =
        lstatSync(adapterInput.database_path).mode & 0o777;
      const temporaryPath = join(
        dirname(adapterInput.database_path),
        `.${basename(adapterInput.database_path)}.aionis-restore-${
          randomUUID()
        }.tmp`,
      );
      try {
        writeFileSync(temporaryPath, bytes, {
          flag: "wx",
          mode: currentMode,
        });
        chmodSync(temporaryPath, currentMode);
        withSnapshotDatabase(
          readFileSync(temporaryPath),
          () => undefined,
        );
        for (
          const suffix of ["-wal", "-shm", "-journal"] as const
        ) {
          rmSync(`${adapterInput.database_path}${suffix}`, {
            force: true,
          });
        }
        renameSync(temporaryPath, adapterInput.database_path);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
      const restored = await snapshotDatabase(
        adapterInput.database_path,
      );
      if (
        sha256(restored) !== input.snapshot.content_sha256
        || !restored.equals(bytes)
      ) {
        throw new Error(
          "sqlite_database_subject_restore_verification_failed",
        );
      }
    },

    async materializeForVerifier(input) {
      if (
        input.snapshot.subject.adapter_id
          !== SQLITE_DATABASE_SUBJECT_ADAPTER_ID
      ) {
        throw new Error(
          "sqlite_database_subject_materialization_subject_mismatch",
        );
      }
      withSnapshotDatabase(input.snapshot_artifact_bytes, () => undefined);
      const native = materializeVerifierFileSubjectFromSnapshot({
        snapshotArtifactBytes: input.snapshot_artifact_bytes,
        sourceContentDigest: input.snapshot.content_sha256,
        sourceEnvironmentDigest: input.snapshot.environment_sha256,
        subjectStateSpec: {
          contract_version: "sqlite_database_subject_state_spec_v1",
          capture_scope: "entire_database",
        },
        stateKind: "database",
        algorithmId: input.snapshot.algorithm_id,
        algorithmVersion: input.snapshot.algorithm_version,
        subjectFileName: "database.sqlite",
      });
      return Object.freeze({
        contract_version: "subject_verifier_materialization_v1",
        subject: input.snapshot.subject,
        source_snapshot_id: input.snapshot.snapshot_id,
        source_content_sha256: input.snapshot.content_sha256,
        source_environment_sha256: input.snapshot.environment_sha256,
        materialization_id: native.materialization_id,
        subject_root: native.subject_root,
        scratch_root: native.scratch_root,
        native_handle: native,
        cleanup: native.cleanup,
      });
    },
  };
  return Object.freeze(adapter);
}

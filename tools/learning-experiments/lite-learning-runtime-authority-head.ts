import { TextDecoder } from "node:util";

import {
  assertLearningRuntimeAuthorityHeadV1,
  createLearningRuntimeAuthorityTableHasherV1,
  LEARNING_RUNTIME_AUTHORITY_HEAD_V1_ENCODING_CONTRACT,
  LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC,
  LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_MANIFEST_SHA256,
  LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS,
  LearningRuntimeAuthorityHeadBodyV1Schema,
  learningRuntimeAuthorityExternalOperationClosureDigest,
  learningRuntimeAuthorityHeadRootDigestV1,
  type LearningRuntimeAuthorityHeadV1,
  type LearningRuntimeAuthoritySqliteValueV1,
} from "../../src/memory/learning-external-ingestion-attestation.js";
import type { LiteRuntimeDatabase } from "../../src/store/lite-runtime-database.js";
import { assertLiteRuntimeAuthorityIdentity } from "../../src/store/lite-learning-episode-ledger.js";
import {
  inspectLiteRuntimeSchema,
  LITE_RUNTIME_WRITE_SCHEMA_COMPONENT,
  LITE_RUNTIME_WRITE_SCHEMA_VERSION,
} from "../../src/store/lite-runtime-schema.js";
import {
  requireSqliteStreamingStatement,
  type SqliteDatabase,
} from "../../src/store/sqlite.js";

type FrozenAuthorityTableSpec = Readonly<{
  table: string;
  primary_key: readonly string[];
  primary_key_kinds: readonly ("text" | "integer")[];
  column_order: readonly string[];
}>;

const EXTERNAL_OPERATION_SCOPE =
  LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC.selector.equals;
const EXTERNAL_OPERATION_SCOPE_BYTES = Buffer.from(EXTERNAL_OPERATION_SCOPE, "utf8");
const OPERATION_TABLE = LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC.table;
const INTEGER_DECIMAL_PATTERN = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/u;
const MAX_EXTERNAL_INGEST_RECEIPT_BYTES = 40 * 1024 * 1024;

const FROZEN_AUTHORITY_TABLE_SPECS: readonly FrozenAuthorityTableSpec[] = Object.freeze([
  ...LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS,
  LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC,
]);

export type LiteLearningRuntimeAuthorityExactBinding =
  | string
  | number
  | Uint8Array
  | null;

export type LiteLearningRuntimeAuthorityTypedRow = Readonly<
  Record<string, LearningRuntimeAuthoritySqliteValueV1>
>;

export type ReadLiteLearningRuntimeAuthorityExactRowsArgs = Readonly<{
  database: LiteRuntimeDatabase;
  table: string;
  columns?: readonly string[];
  bindings: Readonly<Record<string, LiteLearningRuntimeAuthorityExactBinding>>;
}>;

type VisitLiteLearningRuntimeAuthorityExactRowsArgs =
  ReadLiteLearningRuntimeAuthorityExactRowsArgs & Readonly<{
    visit: (row: LiteLearningRuntimeAuthorityTypedRow) => void;
  }>;

export type ReadLiteLearningRuntimeExternalIngestionOperationRowsV1Args = Readonly<{
  database: LiteRuntimeDatabase;
  tenantId: string;
  /** The complete registered external role set. D2 freezes exactly three roles. */
  evidenceSeriesIds: readonly [string, string, string];
}>;

export type BuildLiteLearningRuntimeAuthorityHeadV1Args = Readonly<{
  database: LiteRuntimeDatabase;
  /** Parsed by the D1 authority-head body schema before any head is returned. */
  databaseLineage: unknown;
}>;

function authorityHeadError(code: string, message: string): never {
  throw new Error(`lite_learning_runtime_authority_head_${code}:${message}`);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function resolveFrozenTableSpec(table: string): FrozenAuthorityTableSpec {
  const spec = FROZEN_AUTHORITY_TABLE_SPECS.find((candidate) => candidate.table === table);
  if (!spec) {
    return authorityHeadError(
      "table_not_in_frozen_manifest",
      "table must be present in the D1 authority-head manifest",
    );
  }
  return spec;
}

function assertCurrentV5Database(database: LiteRuntimeDatabase): void {
  const schema = inspectLiteRuntimeSchema(database.db);
  if (schema.classification !== "current"
    || schema.component !== LITE_RUNTIME_WRITE_SCHEMA_COMPONENT
    || schema.detected_version !== LITE_RUNTIME_WRITE_SCHEMA_VERSION) {
    return authorityHeadError(
      "current_v5_database_required",
      "authority reads require the exact current Runtime schema",
    );
  }
}

function activeTransactionIdentity(database: LiteRuntimeDatabase): symbol {
  if (!database.transaction.inTransaction()) {
    return authorityHeadError(
      "active_transaction_required",
      "authority reads must run inside the active Runtime database transaction",
    );
  }
  const identity = database.transaction.currentTransactionIdentity();
  if (identity === null) {
    return authorityHeadError(
      "transaction_identity_required",
      "active Runtime transaction did not expose a transaction identity",
    );
  }
  return identity;
}

function assertSameActiveTransaction(
  database: LiteRuntimeDatabase,
  expectedIdentity: symbol,
): void {
  if (!database.transaction.inTransaction()
    || database.transaction.currentTransactionIdentity() !== expectedIdentity) {
    return authorityHeadError(
      "transaction_identity_changed",
      "authority read did not finish in the transaction where it started",
    );
  }
}

function canonicalUtf8Bytes(value: Uint8Array, label: string): Uint8Array {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
  } catch {
    return authorityHeadError("text_invalid_utf8", label);
  }
  const encoded = Buffer.from(decoded, "utf8");
  if (Buffer.compare(encoded, Buffer.from(value)) !== 0) {
    return authorityHeadError("text_noncanonical_utf8", label);
  }
  return Buffer.from(value);
}

function exactTextBindingBytes(value: string, label: string): Uint8Array {
  const encoded = Buffer.from(value, "utf8");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded);
  } catch {
    return authorityHeadError("binding_text_invalid_utf8", label);
  }
  if (decoded !== value || Buffer.compare(Buffer.from(decoded, "utf8"), encoded) !== 0) {
    return authorityHeadError("binding_text_noncanonical_utf8", label);
  }
  return encoded;
}

function bytesFromSqlite(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    return authorityHeadError("raw_bytes_required", label);
  }
  return Buffer.from(value);
}

function safeIntegerFromCanonicalBytes(value: unknown, label: string): number {
  const bytes = bytesFromSqlite(value, label);
  let decimal: string;
  try {
    decimal = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return authorityHeadError("integer_decimal_invalid_utf8", label);
  }
  if (!INTEGER_DECIMAL_PATTERN.test(decimal)
    || Buffer.compare(Buffer.from(decimal, "utf8"), Buffer.from(bytes)) !== 0) {
    return authorityHeadError("integer_decimal_noncanonical", label);
  }
  const integer = BigInt(decimal);
  const numeric = Number(integer);
  if (!Number.isSafeInteger(numeric) || BigInt(numeric) !== integer || Object.is(numeric, -0)) {
    return authorityHeadError("integer_unsafe", label);
  }
  return numeric;
}

function typedColumnValue(args: Readonly<{
  storageClass: unknown;
  value: unknown;
  label: string;
}>): LearningRuntimeAuthoritySqliteValueV1 {
  if (args.storageClass === "null") {
    if (args.value !== null) return authorityHeadError("null_value_mismatch", args.label);
    return Object.freeze({ storage_class: "null", value: null });
  }
  if (args.storageClass === "text") {
    return Object.freeze({
      storage_class: "text",
      value: canonicalUtf8Bytes(bytesFromSqlite(args.value, args.label), args.label),
    });
  }
  if (args.storageClass === "integer") {
    return Object.freeze({
      storage_class: "integer",
      value: safeIntegerFromCanonicalBytes(args.value, args.label),
    });
  }
  if (args.storageClass === "blob") {
    return Object.freeze({ storage_class: "blob", value: bytesFromSqlite(args.value, args.label) });
  }
  if (args.storageClass === "real") {
    return authorityHeadError("real_storage_class_rejected", args.label);
  }
  return authorityHeadError("storage_class_unsupported", args.label);
}

function columnTypeAlias(index: number): string {
  return `__aionis_storage_class_${index}`;
}

function columnValueAlias(index: number): string {
  return `__aionis_raw_value_${index}`;
}

function rawProjectionSql(columns: readonly string[]): string {
  return columns.map((column, index) => {
    const quoted = quoteIdentifier(column);
    return [
      `typeof(${quoted}) AS ${quoteIdentifier(columnTypeAlias(index))}`,
      [
        `CASE typeof(${quoted})`,
        `WHEN 'text' THEN CAST(${quoted} AS BLOB)`,
        `WHEN 'integer' THEN CAST(${quoted} AS BLOB)`,
        `ELSE ${quoted} END AS ${quoteIdentifier(columnValueAlias(index))}`,
      ].join(" "),
    ].join(", ");
  }).join(", ");
}

function primaryKeyOrderSql(spec: FrozenAuthorityTableSpec): string {
  return spec.primary_key.map((column, index) => {
    const quoted = quoteIdentifier(column);
    return spec.primary_key_kinds[index] === "text"
      ? `${quoted} COLLATE BINARY ASC`
      : `${quoted} ASC`;
  }).join(", ");
}

function iterateTypedRows(args: Readonly<{
  db: SqliteDatabase;
  spec: FrozenAuthorityTableSpec;
  columns: readonly string[];
  whereSql?: string;
  params?: readonly unknown[];
  onRow: (row: LiteLearningRuntimeAuthorityTypedRow) => void;
}>): number {
  const statement = requireSqliteStreamingStatement(
    args.db.prepare(
      `SELECT ${rawProjectionSql(args.columns)}
       FROM ${quoteIdentifier(args.spec.table)}
       ${args.whereSql ? `WHERE ${args.whereSql}` : ""}
       ORDER BY ${primaryKeyOrderSql(args.spec)}`,
    ),
    `authority_rows:${args.spec.table}`,
  );
  statement.setReadBigInts(true);
  let rowCount = 0;
  for (const rawValue of statement.iterate(...(args.params ?? []))) {
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
      return authorityHeadError("row_shape_invalid", args.spec.table);
    }
    const raw = rawValue as Readonly<Record<string, unknown>>;
    const entries = args.columns.map((column, index) => [
      column,
      typedColumnValue({
        storageClass: raw[columnTypeAlias(index)],
        value: raw[columnValueAlias(index)],
        label: `${args.spec.table}.${column}`,
      }),
    ] as const);
    args.onRow(Object.freeze(Object.fromEntries(entries)));
    rowCount += 1;
    if (!Number.isSafeInteger(rowCount)) {
      return authorityHeadError("row_count_unsafe", args.spec.table);
    }
  }
  return rowCount;
}

function safeCountValue(value: unknown, label: string): number {
  if (typeof value === "bigint") {
    const numeric = Number(value);
    if (value < 0n || !Number.isSafeInteger(numeric) || BigInt(numeric) !== value) {
      return authorityHeadError("row_count_unsafe", label);
    }
    return numeric;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return authorityHeadError("row_count_invalid", label);
  }
  return value;
}

function countRows(args: Readonly<{
  db: SqliteDatabase;
  table: string;
  whereSql?: string;
  params?: readonly unknown[];
}>): number {
  const statement = requireSqliteStreamingStatement(
    args.db.prepare(
      `SELECT COUNT(*) AS ${quoteIdentifier("__aionis_row_count")}
       FROM ${quoteIdentifier(args.table)}
       ${args.whereSql ? `WHERE ${args.whereSql}` : ""}`,
    ),
    `authority_count:${args.table}`,
  );
  statement.setReadBigInts(true);
  const iterator = statement.iterate(...(args.params ?? []));
  const first = iterator.next();
  if (first.done || !first.value || typeof first.value !== "object" || Array.isArray(first.value)) {
    return authorityHeadError("row_count_missing", args.table);
  }
  const count = safeCountValue(
    (first.value as Readonly<Record<string, unknown>>).__aionis_row_count,
    args.table,
  );
  if (!iterator.next().done) {
    return authorityHeadError("row_count_ambiguous", args.table);
  }
  return count;
}

function operationSelectorWhere(storageClass: "text" | "non_text"): string {
  const operator = storageClass === "text" ? "=" : "<>";
  return `typeof(${quoteIdentifier("scope")}) ${operator} 'text'
    AND CAST(${quoteIdentifier("scope")} AS BLOB) = ?`;
}

function assertNoExternalScopeStorageAlias(db: SqliteDatabase): void {
  const aliasCount = countRows({
    db,
    table: OPERATION_TABLE,
    whereSql: operationSelectorWhere("non_text"),
    params: [EXTERNAL_OPERATION_SCOPE_BYTES],
  });
  if (aliasCount !== 0) {
    return authorityHeadError(
      "operation_scope_storage_alias",
      "external operation scope has a same-byte non-TEXT storage alias",
    );
  }
}

function tableRowsHead(db: SqliteDatabase, spec: FrozenAuthorityTableSpec): Readonly<{
  row_count: number;
  rows_sha256: string;
}> {
  const expectedRowCount = countRows({ db, table: spec.table });
  const hasher = createLearningRuntimeAuthorityTableHasherV1({
    table: spec.table,
    expectedRowCount,
  });
  const actualRowCount = iterateTypedRows({
    db,
    spec,
    columns: spec.column_order,
    onRow: (row) => { hasher.append(row); },
  });
  if (actualRowCount !== expectedRowCount) {
    return authorityHeadError("row_count_changed", spec.table);
  }
  return hasher.finish();
}

function externalOperationRowsHead(db: SqliteDatabase): Readonly<{
  row_count: number;
  rows_sha256: string;
}> {
  assertNoExternalScopeStorageAlias(db);
  const spec = resolveFrozenTableSpec(OPERATION_TABLE);
  const whereSql = operationSelectorWhere("text");
  const expectedRowCount = countRows({
    db,
    table: spec.table,
    whereSql,
    params: [EXTERNAL_OPERATION_SCOPE_BYTES],
  });
  const hasher = createLearningRuntimeAuthorityTableHasherV1({
    table: spec.table,
    expectedRowCount,
  });
  const actualRowCount = iterateTypedRows({
    db,
    spec,
    columns: spec.column_order,
    whereSql,
    params: [EXTERNAL_OPERATION_SCOPE_BYTES],
    onRow: (row) => { hasher.append(row); },
  });
  if (actualRowCount !== expectedRowCount) {
    return authorityHeadError("operation_row_count_changed", spec.table);
  }
  return hasher.finish();
}

function validatedProjectionColumns(
  spec: FrozenAuthorityTableSpec,
  requested: readonly string[] | undefined,
): readonly string[] {
  const columns = requested ?? spec.column_order;
  if (columns.length === 0 || new Set(columns).size !== columns.length) {
    return authorityHeadError(
      "projection_columns_invalid",
      "authority projection columns must be non-empty and unique",
    );
  }
  const allowed = new Set(spec.column_order);
  if (columns.some((column) => !allowed.has(column))) {
    return authorityHeadError(
      "projection_column_not_in_frozen_manifest",
      spec.table,
    );
  }
  return Object.freeze([...columns]);
}

function exactBindingWhere(args: Readonly<{
  spec: FrozenAuthorityTableSpec;
  bindings: Readonly<Record<string, LiteLearningRuntimeAuthorityExactBinding>>;
}>): Readonly<{ sql: string; params: readonly unknown[] }> {
  const bindingColumns = Object.keys(args.bindings);
  if (bindingColumns.length === 0) {
    return authorityHeadError(
      "exact_binding_required",
      "restricted authority reads require at least one exact binding",
    );
  }
  const manifestOrder = new Map(args.spec.column_order.map((column, index) => [column, index]));
  if (bindingColumns.some((column) => !manifestOrder.has(column))) {
    return authorityHeadError("binding_column_not_in_frozen_manifest", args.spec.table);
  }
  bindingColumns.sort((left, right) => manifestOrder.get(left)! - manifestOrder.get(right)!);
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const column of bindingColumns) {
    const quoted = quoteIdentifier(column);
    const value = args.bindings[column];
    if (value === null) {
      clauses.push(`typeof(${quoted}) = 'null'`);
      continue;
    }
    if (typeof value === "string") {
      clauses.push(`typeof(${quoted}) = 'text' AND CAST(${quoted} AS BLOB) = ?`);
      params.push(exactTextBindingBytes(value, `${args.spec.table}.${column}`));
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        return authorityHeadError("binding_integer_unsafe_or_real", `${args.spec.table}.${column}`);
      }
      clauses.push(`typeof(${quoted}) = 'integer' AND ${quoted} = ?`);
      params.push(value);
      continue;
    }
    if (value instanceof Uint8Array) {
      clauses.push(`typeof(${quoted}) = 'blob' AND ${quoted} = ?`);
      params.push(Buffer.from(value));
      continue;
    }
    return authorityHeadError("binding_value_unsupported", `${args.spec.table}.${column}`);
  }
  return Object.freeze({ sql: clauses.map((clause) => `(${clause})`).join(" AND "), params });
}

function assertOperationExactScopeBinding(args: ReadLiteLearningRuntimeAuthorityExactRowsArgs): void {
  if (args.table !== OPERATION_TABLE) return;
  if (args.bindings.scope !== EXTERNAL_OPERATION_SCOPE) {
    return authorityHeadError(
      "operation_scope_binding_required",
      "operation reads are restricted to the frozen external authority scope",
    );
  }
  assertNoExternalScopeStorageAlias(args.database.db);
}

/**
 * Reads rows without accepting SQL fragments or unregistered identifiers.
 * Every predicate is an exact SQLite storage-class-and-value binding, and rows
 * are returned in the frozen primary-key order for the selected D1 table.
 */
export function readLiteLearningRuntimeAuthorityExactRows(
  args: ReadLiteLearningRuntimeAuthorityExactRowsArgs,
): readonly LiteLearningRuntimeAuthorityTypedRow[] {
  const rows: LiteLearningRuntimeAuthorityTypedRow[] = [];
  visitLiteLearningRuntimeAuthorityExactRows({
    ...args,
    visit: (row) => { rows.push(row); },
  });
  return Object.freeze(rows);
}

/**
 * Streaming form of the restricted exact reader. The callback is synchronous,
 * rows never escape the active transaction unless the caller deliberately
 * copies them, and the Runtime transaction identity is rechecked on return.
 */
function visitLiteLearningRuntimeAuthorityExactRows(
  args: VisitLiteLearningRuntimeAuthorityExactRowsArgs,
): number {
  const transactionIdentity = activeTransactionIdentity(args.database);
  assertCurrentV5Database(args.database);
  const spec = resolveFrozenTableSpec(args.table);
  const columns = validatedProjectionColumns(spec, args.columns);
  assertOperationExactScopeBinding(args);
  const where = exactBindingWhere({ spec, bindings: args.bindings });
  const rowCount = iterateTypedRows({
    db: args.database.db,
    spec,
    columns,
    whereSql: where.sql,
    params: where.params,
    onRow: args.visit,
  });
  assertSameActiveTransaction(args.database, transactionIdentity);
  return rowCount;
}

function authorityTextString(
  row: LiteLearningRuntimeAuthorityTypedRow,
  column: string,
): string {
  const value = row[column];
  if (value?.storage_class !== "text" || !(value.value instanceof Uint8Array)) {
    return authorityHeadError(
      "external_ingest_receipt_text_required",
      `lite_runtime_write_operations.${column}`,
    );
  }
  if (column === "receipt_json" && value.value.byteLength > MAX_EXTERNAL_INGEST_RECEIPT_BYTES) {
    return authorityHeadError(
      "external_ingest_receipt_too_large",
      `receipt_json exceeds ${MAX_EXTERNAL_INGEST_RECEIPT_BYTES} bytes`,
    );
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value.value);
}

function externalIngestReceiptSeriesId(
  row: LiteLearningRuntimeAuthorityTypedRow,
): string {
  const raw = authorityTextString(row, "receipt_json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return authorityHeadError(
      "external_ingest_receipt_json_invalid",
      "lite_runtime_write_operations.receipt_json",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return authorityHeadError(
      "external_ingest_receipt_shape_invalid",
      "receipt root must be an object",
    );
  }
  const request = (parsed as Readonly<Record<string, unknown>>).request;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return authorityHeadError(
      "external_ingest_receipt_shape_invalid",
      "receipt.request must be an object",
    );
  }
  const evidenceSeriesId = (request as Readonly<Record<string, unknown>>).evidence_series_id;
  if (typeof evidenceSeriesId !== "string") {
    return authorityHeadError(
      "external_ingest_receipt_shape_invalid",
      "receipt.request.evidence_series_id must be text",
    );
  }
  exactTextBindingBytes(
    evidenceSeriesId,
    "lite_runtime_write_operations.receipt_json.request.evidence_series_id",
  );
  return evidenceSeriesId;
}

/**
 * D2's only streaming projection reader. It scans the frozen external-ingest
 * operation scope with a fixed in-module visitor and returns only rows for the
 * three registered evidence series. No caller callback can rotate or mutate
 * the transaction between streamed rows.
 */
export function readLiteLearningRuntimeExternalIngestionOperationRowsV1(
  args: ReadLiteLearningRuntimeExternalIngestionOperationRowsV1Args,
): readonly LiteLearningRuntimeAuthorityTypedRow[] {
  const transactionIdentity = activeTransactionIdentity(args.database);
  assertCurrentV5Database(args.database);
  if (new Set(args.evidenceSeriesIds).size !== 3) {
    return authorityHeadError(
      "external_ingest_series_set_invalid",
      "the registered external role set must contain exactly three distinct series",
    );
  }
  for (const evidenceSeriesId of args.evidenceSeriesIds) {
    exactTextBindingBytes(evidenceSeriesId, "evidence_series_id");
  }
  const relevantSeries = new Set(args.evidenceSeriesIds);
  const rows: LiteLearningRuntimeAuthorityTypedRow[] = [];
  const spec = resolveFrozenTableSpec(OPERATION_TABLE);
  assertNoExternalScopeStorageAlias(args.database.db);
  const where = exactBindingWhere({
    spec,
    bindings: {
      tenant_id: args.tenantId,
      scope: EXTERNAL_OPERATION_SCOPE,
      operation_kind: "learning_evidence_ingest_v1",
    },
  });
  iterateTypedRows({
    db: args.database.db,
    spec,
    columns: spec.column_order,
    whereSql: where.sql,
    params: where.params,
    onRow: (row) => {
      if (!relevantSeries.has(externalIngestReceiptSeriesId(row))) return;
      rows.push(row);
      if (rows.length > 3) {
        return authorityHeadError(
          "external_ingest_registered_series_operation_overflow",
          "more than three operations target the three registered evidence series",
        );
      }
    },
  });
  assertSameActiveTransaction(args.database, transactionIdentity);
  return Object.freeze(rows);
}

/**
 * Computes the complete D1 v1 head from one active Runtime transaction. D3 is
 * responsible for adding its stronger launcher/protected-database capability,
 * checkpoint, and descriptor lineage boundary around this pure DB projection.
 */
export function buildLiteLearningRuntimeAuthorityHeadV1(
  args: BuildLiteLearningRuntimeAuthorityHeadV1Args,
): LearningRuntimeAuthorityHeadV1 {
  const transactionIdentity = activeTransactionIdentity(args.database);
  assertCurrentV5Database(args.database);
  const tables = LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS.map((spec) => {
    const rows = tableRowsHead(args.database.db, spec);
    return Object.freeze({
      table: spec.table,
      primary_key: spec.primary_key,
      primary_key_kinds: spec.primary_key_kinds,
      column_order: spec.column_order,
      row_count: rows.row_count,
      rows_sha256: rows.rows_sha256,
    });
  });
  const operationRows = externalOperationRowsHead(args.database.db);
  const operationClosureSha256 = learningRuntimeAuthorityExternalOperationClosureDigest({
    rowCount: operationRows.row_count,
    rowsSha256: operationRows.rows_sha256,
  });
  const operationSpec = LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC;
  const body = LearningRuntimeAuthorityHeadBodyV1Schema.parse({
    contract_version: "aionis_learning_runtime_authority_head_body_v1",
    schema_component: LITE_RUNTIME_WRITE_SCHEMA_COMPONENT,
    schema_version: LITE_RUNTIME_WRITE_SCHEMA_VERSION,
    database_lineage: args.databaseLineage,
    table_manifest_sha256: LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_MANIFEST_SHA256,
    encoding_contract_version:
      LEARNING_RUNTIME_AUTHORITY_HEAD_V1_ENCODING_CONTRACT.contract_version,
    tables,
    external_scope_operations: {
      table: operationSpec.table,
      scope: operationSpec.selector.equals,
      primary_key: operationSpec.primary_key,
      primary_key_kinds: operationSpec.primary_key_kinds,
      column_order: operationSpec.column_order,
      closure: operationSpec.closure,
      row_count: operationRows.row_count,
      rows_sha256: operationRows.rows_sha256,
      closure_sha256: operationClosureSha256,
    },
  });
  const databaseInstanceId = assertLiteRuntimeAuthorityIdentity(args.database.db);
  if (body.database_lineage.database_instance_id !== databaseInstanceId) {
    return authorityHeadError(
      "database_lineage_identity_mismatch",
      "database lineage does not bind the active Runtime database identity",
    );
  }
  const head = assertLearningRuntimeAuthorityHeadV1({
    contract_version: "aionis_learning_runtime_authority_head_v1",
    body,
    authority_head_sha256: learningRuntimeAuthorityHeadRootDigestV1(body),
  });
  assertSameActiveTransaction(args.database, transactionIdentity);
  return head;
}

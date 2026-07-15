import { createHash } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";

import type { SqliteDatabase } from "./sqlite.js";
import type { SqliteTransactionRunner } from "./sqlite-transaction-runner.js";

const TENANT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;
const TENANT_SCOPE_ENCODING_ALGORITHM = "default_tenant_unprefixed_else_tenant_prefix_v1";

export const LITE_TENANT_SCOPE_ANCHOR_POLICY_ID =
  "aionis.runtime.tenant_scope_encoding_anchor";
export const LITE_TENANT_SCOPE_ANCHOR_POLICY_VERSION = "v1";

const LITE_TENANT_SCOPE_ANCHOR_IMPLEMENTATION_SHA256 = sha256Text(stableStringify({
  contract_version: "aionis_tenant_scope_encoding_anchor_implementation_v1",
  carrier: "lite_learning_policy_versions_reserved_candidate_v1",
  database_identity: "lite_runtime_authority_identity_v1",
  uniqueness: "reserved_policy_tuple_global_singleton_v1",
}));

export type LiteTenantScopeAuthorityErrorCode =
  | "lite_tenant_scope_anchor_corrupt"
  | "lite_tenant_scope_anchor_invalid_tenant"
  | "lite_tenant_scope_anchor_mismatch"
  | "lite_tenant_scope_anchor_missing_for_existing_unprefixed_memory"
  | "lite_tenant_scope_anchor_transaction_required";

export class LiteTenantScopeAuthorityError extends Error {
  readonly code: LiteTenantScopeAuthorityErrorCode;

  constructor(code: LiteTenantScopeAuthorityErrorCode, message: string) {
    super(message);
    this.name = "LiteTenantScopeAuthorityError";
    this.code = code;
  }
}

export type LiteTenantScopeEncodingAnchor = Readonly<{
  defaultTenantId: string;
  tenantScopeEncodingSha256: string;
  runtimeAuthorityLineageSha256: string;
}>;

type RuntimeAuthorityIdentityRow = Readonly<{
  database_instance_id: string;
  created_at: string;
}>;

type TenantScopeAnchorRow = Readonly<{
  tenant_id: string;
  policy_kind: string;
  policy_id: string;
  policy_version: string;
  policy_config_sha256: string;
  policy_config_json: string;
  implementation_contract_sha256: string;
  prospective_calibration_sha256: string | null;
  prospective_calibration_json: string | null;
  created_at: string;
}>;

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function authorityError(
  code: LiteTenantScopeAuthorityErrorCode,
  message: string,
): never {
  throw new LiteTenantScopeAuthorityError(code, message);
}

function exactTenantId(value: string): string {
  if (value !== value.trim() || !TENANT_ID_RE.test(value)) {
    authorityError(
      "lite_tenant_scope_anchor_invalid_tenant",
      "tenant-scope authority requires an exact valid default tenant ID",
    );
  }
  return value;
}

export function tenantScopeEncodingDigest(defaultTenantId: string): string {
  const tenantId = exactTenantId(defaultTenantId);
  return sha256Text(stableStringify({
    contract_version: "aionis_tenant_scope_encoding_v1",
    algorithm: TENANT_SCOPE_ENCODING_ALGORITHM,
    default_tenant_id_sha256: sha256Text(tenantId),
  }));
}

function runtimeAuthorityIdentity(db: SqliteDatabase): RuntimeAuthorityIdentityRow {
  const rows = db.prepare(
    `SELECT database_instance_id, created_at
     FROM lite_runtime_authority_identity
     WHERE singleton = 1`,
  ).all() as RuntimeAuthorityIdentityRow[];
  const identity = rows[0];
  if (rows.length !== 1
    || !identity
    || !/^[0-9a-f]{64}$/u.test(identity.database_instance_id)
    || typeof identity.created_at !== "string"
    || identity.created_at.length === 0) {
    authorityError(
      "lite_tenant_scope_anchor_corrupt",
      "tenant-scope authority cannot resolve the immutable Runtime database identity",
    );
  }
  return identity;
}

function anchorConfig(defaultTenantId: string, databaseInstanceId: string) {
  return {
    contract_version: "aionis_tenant_scope_encoding_anchor_v1",
    algorithm: TENANT_SCOPE_ENCODING_ALGORITHM,
    default_tenant_id_sha256: sha256Text(defaultTenantId),
    tenant_scope_encoding_sha256: tenantScopeEncodingDigest(defaultTenantId),
    runtime_authority_lineage_sha256: sha256Text(databaseInstanceId),
  } as const;
}

function anchorRows(db: SqliteDatabase): TenantScopeAnchorRow[] {
  return db.prepare(
    `SELECT tenant_id, policy_kind, policy_id, policy_version,
            policy_config_sha256, policy_config_json,
            implementation_contract_sha256,
            prospective_calibration_sha256, prospective_calibration_json,
            created_at
     FROM lite_learning_policy_versions
     WHERE policy_id = ?
     ORDER BY tenant_id, policy_kind`,
  ).all(
    LITE_TENANT_SCOPE_ANCHOR_POLICY_ID,
  ) as TenantScopeAnchorRow[];
}

function parseCanonicalConfig(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    authorityError(
      "lite_tenant_scope_anchor_corrupt",
      "tenant-scope authority anchor configuration is not valid JSON",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || stableStringify(parsed) !== raw) {
    authorityError(
      "lite_tenant_scope_anchor_corrupt",
      "tenant-scope authority anchor configuration is not a canonical object",
    );
  }
  return parsed as Record<string, unknown>;
}

export function assertLiteTenantScopeEncodingAnchorSetIntegrity(
  db: SqliteDatabase,
): LiteTenantScopeEncodingAnchor | null {
  const rows = anchorRows(db);
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    authorityError(
      "lite_tenant_scope_anchor_corrupt",
      "tenant-scope authority requires exactly one reserved database anchor",
    );
  }
  const row = rows[0]!;
  const defaultTenantId = exactTenantId(row.tenant_id);
  const identity = runtimeAuthorityIdentity(db);
  const expectedConfig = anchorConfig(defaultTenantId, identity.database_instance_id);
  const config = parseCanonicalConfig(row.policy_config_json);
  if (row.policy_kind !== "candidate"
    || row.policy_id !== LITE_TENANT_SCOPE_ANCHOR_POLICY_ID
    || row.policy_version !== LITE_TENANT_SCOPE_ANCHOR_POLICY_VERSION
    || row.policy_config_sha256 !== sha256Text(row.policy_config_json)
    || stableStringify(config) !== stableStringify(expectedConfig)
    || row.implementation_contract_sha256 !== LITE_TENANT_SCOPE_ANCHOR_IMPLEMENTATION_SHA256
    || row.prospective_calibration_sha256 !== null
    || row.prospective_calibration_json !== null
    || row.created_at !== identity.created_at) {
    authorityError(
      "lite_tenant_scope_anchor_corrupt",
      "tenant-scope authority anchor does not match its immutable database identity",
    );
  }
  const referenced = db.prepare(
    `SELECT 1 AS present
     FROM lite_learning_experiment_revisions
     WHERE candidate_policy_id = ?
     LIMIT 1`,
  ).get(
    LITE_TENANT_SCOPE_ANCHOR_POLICY_ID,
  );
  if (referenced !== undefined) {
    authorityError(
      "lite_tenant_scope_anchor_corrupt",
      "tenant-scope authority carrier must not be referenced as an experiment policy",
    );
  }
  return {
    defaultTenantId,
    tenantScopeEncodingSha256: expectedConfig.tenant_scope_encoding_sha256,
    runtimeAuthorityLineageSha256: expectedConfig.runtime_authority_lineage_sha256,
  };
}

export function assertLiteTenantScopeEncodingAnchor(
  db: SqliteDatabase,
  defaultTenantId: string,
): LiteTenantScopeEncodingAnchor {
  const tenantId = exactTenantId(defaultTenantId);
  const anchor = assertLiteTenantScopeEncodingAnchorSetIntegrity(db);
  if (!anchor) {
    authorityError(
      "lite_tenant_scope_anchor_corrupt",
      "tenant-scope authority anchor is missing",
    );
  }
  if (anchor.defaultTenantId !== tenantId
    || anchor.tenantScopeEncodingSha256 !== tenantScopeEncodingDigest(tenantId)) {
    authorityError(
      "lite_tenant_scope_anchor_mismatch",
      "configured default tenant does not match the immutable database scope encoding anchor",
    );
  }
  return anchor;
}

function hasExistingUnprefixedMemory(db: SqliteDatabase): boolean {
  for (const table of ["lite_memory_nodes", "lite_memory_commits"] as const) {
    const row = db.prepare(
      `SELECT 1 AS present FROM ${table}
       WHERE substr(scope, 1, 7) <> 'tenant:'
       LIMIT 1`,
    ).get();
    if (row !== undefined) return true;
  }
  return false;
}

export function ensureLiteTenantScopeEncodingAnchor(
  db: SqliteDatabase,
  transaction: SqliteTransactionRunner,
  defaultTenantId: string,
): { anchor: LiteTenantScopeEncodingAnchor; replayed: boolean } {
  if (!transaction.inTransaction()) {
    authorityError(
      "lite_tenant_scope_anchor_transaction_required",
      "tenant-scope authority anchor must be established inside the shared Runtime transaction",
    );
  }
  const tenantId = exactTenantId(defaultTenantId);
  const existing = assertLiteTenantScopeEncodingAnchorSetIntegrity(db);
  if (existing) {
    return {
      anchor: assertLiteTenantScopeEncodingAnchor(db, tenantId),
      replayed: true,
    };
  }
  if (hasExistingUnprefixedMemory(db)) {
    authorityError(
      "lite_tenant_scope_anchor_missing_for_existing_unprefixed_memory",
      "existing unprefixed memory has no immutable tenant-scope anchor and cannot be auto-claimed",
    );
  }
  const identity = runtimeAuthorityIdentity(db);
  const configJson = stableStringify(anchorConfig(tenantId, identity.database_instance_id));
  db.prepare(
    `INSERT INTO lite_learning_policy_versions
       (tenant_id, policy_kind, policy_id, policy_version,
        policy_config_sha256, policy_config_json,
        implementation_contract_sha256,
        prospective_calibration_sha256, prospective_calibration_json,
        created_at)
     VALUES (?, 'candidate', ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(
    tenantId,
    LITE_TENANT_SCOPE_ANCHOR_POLICY_ID,
    LITE_TENANT_SCOPE_ANCHOR_POLICY_VERSION,
    sha256Text(configJson),
    configJson,
    LITE_TENANT_SCOPE_ANCHOR_IMPLEMENTATION_SHA256,
    identity.created_at,
  );
  return {
    anchor: assertLiteTenantScopeEncodingAnchor(db, tenantId),
    replayed: false,
  };
}

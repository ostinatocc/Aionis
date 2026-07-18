import stableStringify from "fast-json-stable-stringify";

import { sha256Hex } from "../util/crypto.js";

export const LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE =
  "lite_runtime_authority_adoption_manifests" as const;
export const LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE =
  "lite_runtime_authority_adoption_bindings" as const;
export const LITE_RUNTIME_AUTHORITY_ADOPTION_CANONICALIZATION_CONTRACT =
  "aionis_runtime_authority_adoption_canonical_json_v1" as const;
export const LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_LEGACY =
  "legacy_v1_authority_row_v5" as const;
export const LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_OPERATION =
  "delegated_operation_v5" as const;

export const LITE_RUNTIME_AUTHORITY_ADOPTABLE_TABLES = [
  "lite_runtime_write_operations",
  "lite_memory_execution_decisions",
  "lite_memory_nodes",
  "lite_memory_rule_defs",
  "lite_memory_rule_feedback",
  "lite_memory_edges",
] as const;

export const LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_COLUMNS = [
  "scope",
  "manifest_id",
  "source_schema_version",
  "target_schema_version",
  "canonicalization_contract",
  "binding_count",
  "binding_set_sha256",
  "commit_id",
  "created_at",
] as const;

export const LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_COLUMNS = [
  "scope",
  "manifest_id",
  "authority_table",
  "identity_json",
  "identity_sha256",
  "row_sha256",
  "adoption_kind",
  "created_at",
] as const;

export type LiteRuntimeAuthorityAdoptionKind =
  | typeof LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_LEGACY
  | typeof LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_OPERATION;

export type LiteRuntimeAuthorityAdoptionBinding = Readonly<{
  scope: string;
  manifest_id: string;
  authority_table: string;
  identity_json: string;
  identity_sha256: string;
  row_sha256: string;
  adoption_kind: LiteRuntimeAuthorityAdoptionKind;
  created_at: string;
}>;

export type LiteRuntimeAuthorityAdoptionManifest = Readonly<{
  scope: string;
  manifest_id: string;
  source_schema_version: 5;
  target_schema_version: 6;
  canonicalization_contract:
    typeof LITE_RUNTIME_AUTHORITY_ADOPTION_CANONICALIZATION_CONTRACT;
  binding_count: number;
  binding_set_sha256: string;
  commit_id: string;
  created_at: string;
}>;

export const LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE_SQL =
  `CREATE TABLE lite_runtime_authority_adoption_manifests (
    scope TEXT PRIMARY KEY,
    manifest_id TEXT NOT NULL UNIQUE,
    source_schema_version INTEGER NOT NULL CHECK (source_schema_version = 5),
    target_schema_version INTEGER NOT NULL CHECK (target_schema_version = 6),
    canonicalization_contract TEXT NOT NULL
      CHECK (canonicalization_contract = '${LITE_RUNTIME_AUTHORITY_ADOPTION_CANONICALIZATION_CONTRACT}'),
    binding_count INTEGER NOT NULL CHECK (binding_count >= 1),
    binding_set_sha256 TEXT NOT NULL CHECK (
      length(binding_set_sha256) = 64
      AND binding_set_sha256 = lower(binding_set_sha256)
      AND binding_set_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    commit_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (scope, manifest_id)
  )` as const;

export const LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE_SQL =
  `CREATE TABLE lite_runtime_authority_adoption_bindings (
    scope TEXT NOT NULL,
    manifest_id TEXT NOT NULL,
    authority_table TEXT NOT NULL CHECK (authority_table IN (
      '${LITE_RUNTIME_AUTHORITY_ADOPTABLE_TABLES.join("', '")}'
    )),
    identity_json TEXT NOT NULL,
    identity_sha256 TEXT NOT NULL CHECK (
      length(identity_sha256) = 64
      AND identity_sha256 = lower(identity_sha256)
      AND identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    row_sha256 TEXT NOT NULL CHECK (
      length(row_sha256) = 64
      AND row_sha256 = lower(row_sha256)
      AND row_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    adoption_kind TEXT NOT NULL
      CHECK (adoption_kind IN ('${LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_LEGACY}', '${LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_OPERATION}')),
    created_at TEXT NOT NULL,
    CHECK (
      adoption_kind != '${LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_OPERATION}'
      OR authority_table = 'lite_runtime_write_operations'
    ),
    PRIMARY KEY (scope, authority_table, identity_sha256),
    UNIQUE (scope, authority_table, identity_json),
    FOREIGN KEY (scope, manifest_id)
      REFERENCES lite_runtime_authority_adoption_manifests(scope, manifest_id)
      DEFERRABLE INITIALLY DEFERRED
  )` as const;

export const LITE_RUNTIME_AUTHORITY_ADOPTION_TRIGGERS = {
  trg_lite_runtime_authority_adoption_manifest_sealed_after_v6:
    `CREATE TRIGGER trg_lite_runtime_authority_adoption_manifest_sealed_after_v6
     BEFORE INSERT ON lite_runtime_authority_adoption_manifests
     BEGIN SELECT RAISE(ABORT, 'authority adoption is sealed'); END`,
  trg_lite_runtime_authority_adoption_binding_sealed_after_v6:
    `CREATE TRIGGER trg_lite_runtime_authority_adoption_binding_sealed_after_v6
     BEFORE INSERT ON lite_runtime_authority_adoption_bindings
     BEGIN SELECT RAISE(ABORT, 'authority adoption is sealed'); END`,
  trg_lite_runtime_authority_adoption_manifest_no_update:
    `CREATE TRIGGER trg_lite_runtime_authority_adoption_manifest_no_update
     BEFORE UPDATE ON lite_runtime_authority_adoption_manifests
     BEGIN SELECT RAISE(ABORT, 'authority adoption manifest is immutable'); END`,
  trg_lite_runtime_authority_adoption_manifest_no_delete:
    `CREATE TRIGGER trg_lite_runtime_authority_adoption_manifest_no_delete
     BEFORE DELETE ON lite_runtime_authority_adoption_manifests
     BEGIN SELECT RAISE(ABORT, 'authority adoption manifest is immutable'); END`,
  trg_lite_runtime_authority_adoption_binding_no_update:
    `CREATE TRIGGER trg_lite_runtime_authority_adoption_binding_no_update
     BEFORE UPDATE ON lite_runtime_authority_adoption_bindings
     BEGIN SELECT RAISE(ABORT, 'authority adoption binding is immutable'); END`,
  trg_lite_runtime_authority_adoption_binding_no_delete:
    `CREATE TRIGGER trg_lite_runtime_authority_adoption_binding_no_delete
     BEFORE DELETE ON lite_runtime_authority_adoption_bindings
     BEGIN SELECT RAISE(ABORT, 'authority adoption binding is immutable'); END`,
  trg_lite_runtime_authority_adoption_binding_frozen_after_manifest:
    `CREATE TRIGGER trg_lite_runtime_authority_adoption_binding_frozen_after_manifest
     BEFORE INSERT ON lite_runtime_authority_adoption_bindings
     WHEN EXISTS (
       SELECT 1 FROM lite_runtime_authority_adoption_manifests
       WHERE scope = NEW.scope
     )
     BEGIN SELECT RAISE(ABORT, 'authority adoption binding set is frozen'); END`,
} as const;

export function canonicalAuthorityAdoptionIdentity(
  identity: Readonly<Record<string, unknown>>,
): Readonly<{ identity_json: string; identity_sha256: string }> {
  const identityJson = stableStringify(identity);
  return {
    identity_json: identityJson,
    identity_sha256: sha256Hex(identityJson),
  };
}

const AUTHORITY_ADOPTION_JSON_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  lite_runtime_write_operations: ["receipt_json"],
  lite_memory_execution_decisions: [
    "candidates_json", "source_rule_ids_json", "metadata_json",
  ],
  lite_memory_nodes: ["slots_json", "embedding_vector_json"],
  lite_memory_rule_defs: ["if_json", "then_json", "exceptions_json"],
  lite_memory_rule_feedback: [],
  lite_memory_edges: ["metadata_json"],
};

export function canonicalAuthorityAdoptionRowSha256(
  table: string,
  row: Readonly<Record<string, unknown>>,
): string {
  const normalized: Record<string, unknown> = { ...row };
  // These columns are owned by the asynchronous embedding projection worker
  // in schema v6. Their tuple is validated separately by the authority scan;
  // excluding them keeps an adopted authority-owned row stable across a
  // legitimate projection refresh and makes the remaining exception visible
  // through the projection-assurance counters.
  if (table === "lite_memory_nodes") {
    delete normalized.embedding_vector_json;
    delete normalized.embedding_model;
    delete normalized.embedding_status;
    delete normalized.embedding_last_error;
  }
  for (const column of AUTHORITY_ADOPTION_JSON_COLUMNS[table] ?? []) {
    const value = normalized[column];
    if (typeof value !== "string") continue;
    try {
      normalized[column] = JSON.parse(value) as unknown;
    } catch {
      // Invalid JSON remains exact text and will be rejected by the owning
      // authority verifier; hashing must never silently discard it.
    }
  }
  return sha256Hex(stableStringify(normalized));
}

export function canonicalAuthorityAdoptionBindingSetSha256(
  bindings: readonly Pick<
    LiteRuntimeAuthorityAdoptionBinding,
    "authority_table" | "identity_sha256" | "row_sha256" | "adoption_kind" | "created_at"
  >[],
): string {
  const canonical = [...bindings]
    .map((binding) => ({
      authority_table: binding.authority_table,
      identity_sha256: binding.identity_sha256,
      row_sha256: binding.row_sha256,
      adoption_kind: binding.adoption_kind,
      created_at: binding.created_at,
    }))
    .sort((left, right) => Buffer.compare(
      Buffer.from(`${left.authority_table}\0${left.identity_sha256}`, "utf8"),
      Buffer.from(`${right.authority_table}\0${right.identity_sha256}`, "utf8"),
    ));
  return sha256Hex(stableStringify(canonical));
}

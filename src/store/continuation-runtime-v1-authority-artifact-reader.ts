import type { KeyObject } from "node:crypto";

import {
  authorityArtifactPublicKeySha256,
  verifySignedAuthorityArtifactV1,
  type SignedAuthorityArtifactV1,
} from "../continuation/authority-artifact.js";
import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
} from "../continuation/contract.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import type { ContinuationRuntimeV1OperationLineageV1 } from
  "./continuation-runtime-v1-operation-store.js";

export type ReadAuthorityArtifactV1Args = Readonly<{
  tenant_id: string;
  artifact_id: string;
  artifact_revision: number;
}>;

export type ReadAuthorityArtifactByDigestV1Args = Readonly<{
  tenant_id: string;
  artifact_sha256: string;
}>;

export type InstalledAuthorityArtifactV1 = Readonly<{
  signed_artifact: SignedAuthorityArtifactV1;
  installation: ContinuationRuntimeV1OperationLineageV1;
}>;

export type ContinuationRuntimeV1AuthorityArtifactReader = Readonly<{
  read(
    args: ReadAuthorityArtifactV1Args,
  ): Promise<InstalledAuthorityArtifactV1 | null>;
  readByDigest(
    args: ReadAuthorityArtifactByDigestV1Args,
  ): Promise<InstalledAuthorityArtifactV1 | null>;
}>;

type AuthorityArtifactRow = Readonly<{
  tenant_id: unknown;
  artifact_id: unknown;
  artifact_revision: unknown;
  artifact_kind: unknown;
  artifact_schema: unknown;
  authority_subject_sha256: unknown;
  payload_sha256: unknown;
  artifact_sha256: unknown;
  payload_json: unknown;
  signer_principal_sha256: unknown;
  trust_root_sha256: unknown;
  signature_algorithm: unknown;
  signature: unknown;
  valid_from: unknown;
  expires_at: unknown;
  created_at: unknown;
  source_operation_scope: unknown;
  source_operation_kind: unknown;
  source_operation_id: unknown;
  source_request_sha256: unknown;
}>;

type DecodedAuthorityArtifactRow = Readonly<{
  signed_artifact: SignedAuthorityArtifactV1;
  source: Readonly<{
    tenant_id: string;
    scope: string;
    operation_kind: "authority_decision";
    operation_id: string;
    request_sha256: string;
  }>;
}>;

const AUTHORITY_ARTIFACT_SELECT = `SELECT
  tenant_id, artifact_id, artifact_revision, artifact_kind, artifact_schema,
  authority_subject_sha256, payload_sha256, artifact_sha256, payload_json,
  signer_principal_sha256, trust_root_sha256, signature_algorithm, signature,
  valid_from, expires_at, created_at, source_operation_scope,
  source_operation_kind, source_operation_id, source_request_sha256
FROM authority_artifacts`;

const READ_KEYS = Object.freeze([
  "artifact_id",
  "artifact_revision",
  "tenant_id",
] as const);
const READ_BY_DIGEST_KEYS = Object.freeze([
  "artifact_sha256",
  "tenant_id",
] as const);
const ARTIFACT_READER_DATABASES = new WeakMap<
  object,
  ContinuationRuntimeV1Database
>();

export function assertContinuationRuntimeV1AuthorityArtifactReader(
  value: unknown,
  database: ContinuationRuntimeV1Database,
): asserts value is ContinuationRuntimeV1AuthorityArtifactReader {
  if (value === null || typeof value !== "object"
    || ARTIFACT_READER_DATABASES.get(value) !== database) {
    throw new Error("continuation_runtime_v1_authority_artifact_reader_invalid");
  }
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`continuation_runtime_v1_authority_artifact_${field}_must_be_plain_object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`continuation_runtime_v1_authority_artifact_${field}_must_be_plain_object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new Error(`continuation_runtime_v1_authority_artifact_${field}_shape_invalid`);
  }
  const actual = keys as string[];
  const expected = new Set(expectedKeys);
  if (actual.length !== expectedKeys.length
    || actual.some((key) => !expected.has(key))) {
    throw new Error(`continuation_runtime_v1_authority_artifact_${field}_shape_invalid`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of actual) {
    assertUnicodeScalarString(key, `authority artifact ${field} key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`continuation_runtime_v1_authority_artifact_${field}_shape_invalid`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function canonicalText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`continuation_runtime_v1_authority_artifact_${field}_invalid`);
  }
  assertUnicodeScalarString(value, `authority artifact ${field}`);
  if (value.length === 0
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 256) {
    throw new Error(`continuation_runtime_v1_authority_artifact_${field}_invalid`);
  }
  return value;
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`continuation_runtime_v1_authority_artifact_${field}_invalid`);
  }
  assertSha256(value, `authority artifact ${field}`);
  return value;
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`continuation_runtime_v1_authority_artifact_${field}_invalid`);
  }
  return value as number;
}

function canonicalTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`continuation_runtime_v1_authority_artifact_${field}_invalid`);
  }
  assertCanonicalUtcMillis(value, `authority artifact ${field}`);
  return value;
}

function assertControlFreeCanonicalJson(value: unknown, field: string): void {
  if (typeof value === "string") {
    assertUnicodeScalarString(value, field);
    if (/[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error("continuation_runtime_v1_authority_artifact_payload_control_character");
    }
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value)) {
    for (const child of value) assertControlFreeCanonicalJson(child, field);
    return;
  }
  if (typeof value !== "object") {
    throw new Error("continuation_runtime_v1_authority_artifact_payload_invalid");
  }
  for (const [key, child] of Object.entries(value)) {
    assertUnicodeScalarString(key, `${field} key`);
    if (/[\u0000-\u001f\u007f]/u.test(key)) {
      throw new Error("continuation_runtime_v1_authority_artifact_payload_control_character");
    }
    assertControlFreeCanonicalJson(child, field);
  }
}

function signatureBytes(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 64) {
    throw new Error("continuation_runtime_v1_authority_artifact_corrupt:signature_type");
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function decodeRow(
  row: AuthorityArtifactRow,
  pinnedPublicKey: KeyObject,
): DecodedAuthorityArtifactRow {
  const tenantId = canonicalText(row.tenant_id, "persisted_tenant_id");
  const artifactId = canonicalText(row.artifact_id, "persisted_artifact_id");
  const artifactRevision = positiveSafeInteger(
    row.artifact_revision,
    "persisted_artifact_revision",
  );
  if (row.artifact_kind !== "compiler_policy"
    && row.artifact_kind !== "evidence_policy"
    && row.artifact_kind !== "experiment_cohort"
    && row.artifact_kind !== "policy_rotation") {
    throw new Error("continuation_runtime_v1_authority_artifact_corrupt:artifact_kind");
  }
  const artifactSchema = canonicalText(row.artifact_schema, "persisted_artifact_schema");
  const authoritySubjectSha256 = row.authority_subject_sha256 === null
    ? null
    : sha256(row.authority_subject_sha256, "persisted_authority_subject_sha256");
  const payloadSha256 = sha256(row.payload_sha256, "persisted_payload_sha256");
  const artifactSha256 = sha256(row.artifact_sha256, "persisted_artifact_sha256");
  const signerPrincipalSha256 = sha256(
    row.signer_principal_sha256,
    "persisted_signer_principal_sha256",
  );
  const trustRootSha256 = sha256(row.trust_root_sha256, "persisted_trust_root_sha256");
  if (row.signature_algorithm !== "ed25519") {
    throw new Error("continuation_runtime_v1_authority_artifact_corrupt:signature_algorithm");
  }
  if (typeof row.payload_json !== "string") {
    throw new Error("continuation_runtime_v1_authority_artifact_corrupt:payload_json_type");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    throw new Error("continuation_runtime_v1_authority_artifact_corrupt:payload_json_parse");
  }
  if (canonicalContinuationJson(payload) !== row.payload_json) {
    throw new Error("continuation_runtime_v1_authority_artifact_corrupt:payload_json_noncanonical");
  }
  assertControlFreeCanonicalJson(payload, "persisted authority artifact payload");
  const validFrom = canonicalTimestamp(row.valid_from, "persisted_valid_from");
  const expiresAt = row.expires_at === null
    ? null
    : canonicalTimestamp(row.expires_at, "persisted_expires_at");
  const createdAt = canonicalTimestamp(row.created_at, "persisted_created_at");
  const signature = signatureBytes(row.signature).toString("base64url");
  const verified = verifySignedAuthorityArtifactV1({
    tenant_id: tenantId,
    artifact_id: artifactId,
    artifact_revision: artifactRevision,
    artifact_kind: row.artifact_kind,
    artifact_schema: artifactSchema,
    authority_subject_sha256: authoritySubjectSha256,
    payload,
    payload_sha256: payloadSha256,
    artifact_sha256: artifactSha256,
    signer_principal_sha256: signerPrincipalSha256,
    trust_root_sha256: trustRootSha256,
    signature_algorithm: "ed25519",
    valid_from: validFrom,
    expires_at: expiresAt,
    created_at: createdAt,
    signature,
  }, pinnedPublicKey);
  const sourceOperationScope = canonicalText(
    row.source_operation_scope,
    "persisted_source_operation_scope",
  );
  if (row.source_operation_kind !== "authority_decision") {
    throw new Error("continuation_runtime_v1_authority_artifact_corrupt:source_operation_kind");
  }
  const sourceOperationId = canonicalText(
    row.source_operation_id,
    "persisted_source_operation_id",
  );
  const sourceRequestSha256 = sha256(
    row.source_request_sha256,
    "persisted_source_request_sha256",
  );
  return canonicalContinuationClone({
    signed_artifact: verified,
    source: {
      tenant_id: tenantId,
      scope: sourceOperationScope,
      operation_kind: "authority_decision",
      operation_id: sourceOperationId,
      request_sha256: sourceRequestSha256,
    },
  });
}

function parseReadArgs(value: unknown): ReadAuthorityArtifactV1Args {
  const record = exactRecord(value, READ_KEYS, "read_args");
  return {
    tenant_id: canonicalText(record.tenant_id, "tenant_id"),
    artifact_id: canonicalText(record.artifact_id, "artifact_id"),
    artifact_revision: positiveSafeInteger(record.artifact_revision, "artifact_revision"),
  };
}

function parseReadByDigestArgs(value: unknown): ReadAuthorityArtifactByDigestV1Args {
  const record = exactRecord(value, READ_BY_DIGEST_KEYS, "read_by_digest_args");
  return {
    tenant_id: canonicalText(record.tenant_id, "tenant_id"),
    artifact_sha256: sha256(record.artifact_sha256, "artifact_sha256"),
  };
}

export function createContinuationRuntimeV1AuthorityArtifactReader(
  database: ContinuationRuntimeV1Database,
  pinnedPublicKey: KeyObject,
): ContinuationRuntimeV1AuthorityArtifactReader {
  authorityArtifactPublicKeySha256(pinnedPublicKey);

  const hydrateInstallationSync = (
    decoded: DecodedAuthorityArtifactRow,
  ): InstalledAuthorityArtifactV1 => {
    const source = decoded.source;
    if (source.tenant_id !== decoded.signed_artifact.tenant_id) {
      throw new Error("continuation_runtime_v1_authority_artifact_corrupt:installation_identity");
    }
    const rows = database.db.prepare(`SELECT
      request_sha256, actor_kind, actor_principal_sha256
      FROM operations
      WHERE tenant_id = ? AND scope = ? AND operation_kind = ? AND operation_id = ?`).all(
      source.tenant_id,
      source.scope,
      source.operation_kind,
      source.operation_id,
    ) as Array<{
      request_sha256: unknown;
      actor_kind: unknown;
      actor_principal_sha256: unknown;
    }>;
    if (rows.length !== 1 || rows[0]?.actor_kind !== "operator") {
      throw new Error("continuation_runtime_v1_authority_artifact_corrupt:installation_operation_ref");
    }
    const lineage = canonicalContinuationClone({
      tenant_id: source.tenant_id,
      scope: source.scope,
      operation_kind: source.operation_kind,
      operation_id: source.operation_id,
      request_sha256: sha256(
        rows[0].request_sha256,
        "persisted_source_operation_request_sha256",
      ),
      actor_kind: "operator" as const,
      actor_principal_sha256: sha256(
        rows[0].actor_principal_sha256,
        "persisted_source_operation_actor_principal_sha256",
      ),
    });
    if (lineage.request_sha256 !== source.request_sha256) {
      throw new Error("continuation_runtime_v1_authority_artifact_corrupt:installation_operation_ref");
    }
    return canonicalContinuationClone({
      signed_artifact: decoded.signed_artifact,
      installation: lineage,
    });
  };

  const readExactSync = (
    tenantId: string,
    artifactId: string,
    artifactRevision: number,
  ): InstalledAuthorityArtifactV1 | null => {
    const row = database.db.prepare(
      `${AUTHORITY_ARTIFACT_SELECT}
       WHERE tenant_id = ? AND artifact_id = ? AND artifact_revision = ?`,
    ).get(tenantId, artifactId, artifactRevision) as AuthorityArtifactRow | undefined;
    if (!row) return null;
    const decoded = decodeRow(row, pinnedPublicKey);
    const artifact = decoded.signed_artifact;
    if (artifact.tenant_id !== tenantId
      || artifact.artifact_id !== artifactId
      || artifact.artifact_revision !== artifactRevision) {
      throw new Error("continuation_runtime_v1_authority_artifact_corrupt:exact_identity");
    }
    return hydrateInstallationSync(decoded);
  };

  const readDigestSync = (
    tenantId: string,
    artifactSha256: string,
  ): InstalledAuthorityArtifactV1 | null => {
    const rows = database.db.prepare(
      `${AUTHORITY_ARTIFACT_SELECT}
       WHERE tenant_id = ? AND artifact_sha256 = ?`,
    ).all(tenantId, artifactSha256) as AuthorityArtifactRow[];
    if (rows.length > 1) {
      throw new Error("continuation_runtime_v1_authority_artifact_corrupt:digest_cardinality");
    }
    if (rows.length === 0) return null;
    const decoded = decodeRow(rows[0]!, pinnedPublicKey);
    const artifact = decoded.signed_artifact;
    if (artifact.tenant_id !== tenantId || artifact.artifact_sha256 !== artifactSha256) {
      throw new Error("continuation_runtime_v1_authority_artifact_corrupt:digest_identity");
    }
    return hydrateInstallationSync(decoded);
  };

  const reader: ContinuationRuntimeV1AuthorityArtifactReader = Object.freeze({
    async read(args) {
      const parsed = parseReadArgs(args);
      return database.read(() => {
        const artifact = readExactSync(
          parsed.tenant_id,
          parsed.artifact_id,
          parsed.artifact_revision,
        );
        return artifact === null ? null : canonicalContinuationClone(artifact);
      });
    },

    async readByDigest(args) {
      const parsed = parseReadByDigestArgs(args);
      return database.read(() => {
        const artifact = readDigestSync(parsed.tenant_id, parsed.artifact_sha256);
        return artifact === null ? null : canonicalContinuationClone(artifact);
      });
    },
  });
  ARTIFACT_READER_DATABASES.set(reader, database);
  return reader;
}

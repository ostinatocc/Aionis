import type { KeyObject } from "node:crypto";

import {
  authorityArtifactPublicKeySha256,
  verifySignedAuthorityArtifactV1,
  type SignedAuthorityArtifactV1,
} from "../continuation/authority-artifact.js";
import {
  CONTINUATION_COMPILER_POLICY_SCHEMA_V1,
  verifyContinuationCompilerPolicyV1,
} from "../continuation/compiler-policy.js";
import {
  EXPERIMENT_COHORT_SCHEMA_V1,
  assertExperimentCohortArtifactWindowV1,
  verifyExperimentCohortV1,
} from "../continuation/experiment-cohort.js";
import { assignmentSeedCommitmentSha256V1 } from
  "../continuation/serving-assignment.js";
import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
} from "../continuation/contract.js";
import { verifyEffectEvidencePolicyV1 } from
  "../continuation/effect-certificate.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import { createContinuationRuntimeV1DurableJobEnqueuer } from
  "./continuation-runtime-v1-durable-job-enqueuer.js";
import { continuationRuntimeV1LearningPairMetrics } from
  "./continuation-runtime-v1-learning-pair.js";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  constrainContinuationRuntimeV1OperationCompletion,
  continuationRuntimeV1OperationLineage,
  type ContinuationRuntimeV1AuthorityWriteContext,
  type ContinuationRuntimeV1AuthorityWriteBinding,
  type ContinuationRuntimeV1OperationLineageV1,
} from "./continuation-runtime-v1-operation-store.js";

export type InstalledAuthorityArtifactV1 = Readonly<{
  signed_artifact: SignedAuthorityArtifactV1;
  installation: ContinuationRuntimeV1OperationLineageV1;
}>;

export type AuthorityPolicyProvisioningBundleV1 = Readonly<{
  schema_version: "authority_policy_provisioning_bundle_v1";
  tenant_id: string;
  authority_subject_sha256: string;
  compiler_policy: SignedAuthorityArtifactV1;
  evidence_policy: SignedAuthorityArtifactV1;
}>;

export type InstalledAuthorityPolicyBundleV1 = Readonly<{
  schema_version: "installed_authority_policy_bundle_v1";
  tenant_id: string;
  authority_subject_sha256: string;
  compiler_policy: InstalledAuthorityArtifactV1;
  evidence_policy: InstalledAuthorityArtifactV1;
}>;

export type ContinuationRuntimeV1AuthorityArtifactProvisioner = Readonly<{
  put(
    context: ContinuationRuntimeV1AuthorityWriteContext,
    signedArtifact: SignedAuthorityArtifactV1,
  ): Promise<InstalledAuthorityArtifactV1>;
  putBundle(
    context: ContinuationRuntimeV1AuthorityWriteContext,
    bundle: AuthorityPolicyProvisioningBundleV1,
  ): Promise<InstalledAuthorityPolicyBundleV1>;
  putExperimentCohort(
    context: ContinuationRuntimeV1AuthorityWriteContext,
    signedArtifact: SignedAuthorityArtifactV1,
    assignmentSeed: Uint8Array,
  ): Promise<InstalledAuthorityArtifactV1>;
}>;

export type ContinuationRuntimeV1AuthorityArtifactConflictCode =
  | "identity_conflict"
  | "digest_conflict";

export class ContinuationRuntimeV1AuthorityArtifactConflictError extends Error {
  constructor(readonly code: ContinuationRuntimeV1AuthorityArtifactConflictCode) {
    super(`continuation_runtime_v1_authority_artifact_${code}`);
    this.name = "ContinuationRuntimeV1AuthorityArtifactConflictError";
  }
}

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

const POLICY_BUNDLE_KEYS = Object.freeze([
  "authority_subject_sha256",
  "compiler_policy",
  "evidence_policy",
  "schema_version",
  "tenant_id",
] as const);
const ARTIFACT_MUTATION_CONTEXTS = new WeakSet<object>();
const ARTIFACT_PROVISIONER_DATABASES = new WeakMap<
  object,
  ContinuationRuntimeV1Database
>();

export function assertContinuationRuntimeV1AuthorityArtifactProvisioner(
  value: unknown,
  database: ContinuationRuntimeV1Database,
): asserts value is ContinuationRuntimeV1AuthorityArtifactProvisioner {
  if (value === null || typeof value !== "object"
    || ARTIFACT_PROVISIONER_DATABASES.get(value) !== database) {
    throw new Error("continuation_runtime_v1_authority_artifact_store_invalid");
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

/**
 * Policy JSON is executable authority, not display text. Refuse invisible C0
 * and DEL characters in both keys and string values so two reviewers cannot
 * be shown materially different-looking policy from the bytes Runtime applies.
 */
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

function artifactEqual(
  left: SignedAuthorityArtifactV1,
  right: SignedAuthorityArtifactV1,
): boolean {
  return canonicalContinuationJson(left) === canonicalContinuationJson(right);
}

function parsePolicyBundle(
  value: unknown,
  pinnedPublicKey: KeyObject,
): AuthorityPolicyProvisioningBundleV1 {
  const record = exactRecord(value, POLICY_BUNDLE_KEYS, "policy_bundle");
  if (record.schema_version !== "authority_policy_provisioning_bundle_v1") {
    throw new Error("continuation_runtime_v1_authority_artifact_policy_bundle_schema_invalid");
  }
  const tenantId = canonicalText(record.tenant_id, "policy_bundle_tenant_id");
  const authoritySubjectSha256 = sha256(
    record.authority_subject_sha256,
    "policy_bundle_authority_subject_sha256",
  );
  const compiler = verifySignedAuthorityArtifactV1(
    record.compiler_policy,
    pinnedPublicKey,
  );
  const evidence = verifySignedAuthorityArtifactV1(
    record.evidence_policy,
    pinnedPublicKey,
  );
  for (const artifact of [compiler, evidence]) {
    assertControlFreeCanonicalJson(artifact.payload, "authority policy bundle payload");
    if (artifact.tenant_id !== tenantId) {
      throw new Error("continuation_runtime_v1_authority_artifact_policy_bundle_tenant_mismatch");
    }
    if (artifact.authority_subject_sha256 !== authoritySubjectSha256) {
      throw new Error("continuation_runtime_v1_authority_artifact_policy_bundle_subject_mismatch");
    }
  }
  if (compiler.artifact_kind !== "compiler_policy"
    || compiler.artifact_schema !== CONTINUATION_COMPILER_POLICY_SCHEMA_V1) {
    throw new Error("continuation_runtime_v1_authority_artifact_policy_bundle_compiler_kind_invalid");
  }
  if (evidence.artifact_kind !== "evidence_policy"
    || evidence.artifact_schema !== "effect_evidence_policy_v1") {
    throw new Error("continuation_runtime_v1_authority_artifact_policy_bundle_evidence_kind_invalid");
  }
  const compilerPayload = verifyContinuationCompilerPolicyV1(compiler.payload);
  const evidencePayload = verifyEffectEvidencePolicyV1(evidence.payload);
  if (compilerPayload.tenant_id !== tenantId
    || compilerPayload.authority_subject_sha256 !== authoritySubjectSha256
    || canonicalContinuationJson(compilerPayload) !== canonicalContinuationJson(compiler.payload)) {
    throw new Error("continuation_runtime_v1_authority_artifact_policy_bundle_compiler_binding_invalid");
  }
  if (evidencePayload.tenant_id !== tenantId
    || evidencePayload.authority_subject_sha256 !== authoritySubjectSha256
    || canonicalContinuationJson(evidencePayload) !== canonicalContinuationJson(evidence.payload)) {
    throw new Error("continuation_runtime_v1_authority_artifact_policy_bundle_evidence_binding_invalid");
  }
  if (compiler.artifact_id === evidence.artifact_id
    && compiler.artifact_revision === evidence.artifact_revision) {
    throw new Error("continuation_runtime_v1_authority_artifact_policy_bundle_identity_collision");
  }
  return canonicalContinuationClone({
    schema_version: "authority_policy_provisioning_bundle_v1",
    tenant_id: tenantId,
    authority_subject_sha256: authoritySubjectSha256,
    compiler_policy: compiler,
    evidence_policy: evidence,
  });
}

export function createContinuationRuntimeV1AuthorityArtifactProvisioner(
  database: ContinuationRuntimeV1Database,
  pinnedPublicKey: KeyObject,
): ContinuationRuntimeV1AuthorityArtifactProvisioner {
  // Validate the trust root eagerly. Runtime never accepts a private key here
  // and therefore cannot manufacture its own governance authority.
  authorityArtifactPublicKeySha256(pinnedPublicKey);

  const readExactSync = (
    tenantId: string,
    artifactId: string,
    artifactRevision: number,
    pendingLineage: ContinuationRuntimeV1OperationLineageV1 | null = null,
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
    return hydrateInstallationSync(decoded, pendingLineage);
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
    return hydrateInstallationSync(decoded, null);
  };

  function hydrateInstallationSync(
    decoded: DecodedAuthorityArtifactRow,
    pendingLineage: ContinuationRuntimeV1OperationLineageV1 | null,
  ): InstalledAuthorityArtifactV1 {
    const source = decoded.source;
    if (source.tenant_id !== decoded.signed_artifact.tenant_id) {
      throw new Error("continuation_runtime_v1_authority_artifact_corrupt:installation_identity");
    }
    let lineage: ContinuationRuntimeV1OperationLineageV1;
    if (pendingLineage !== null) {
      lineage = pendingLineage;
    } else {
      const rows = database.db.prepare(`SELECT request_sha256, actor_kind, actor_principal_sha256
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
      lineage = canonicalContinuationClone({
        tenant_id: source.tenant_id,
        scope: source.scope,
        operation_kind: source.operation_kind,
        operation_id: source.operation_id,
        request_sha256: sha256(rows[0].request_sha256, "persisted_source_operation_request_sha256"),
        actor_kind: "operator",
        actor_principal_sha256: sha256(
          rows[0].actor_principal_sha256,
          "persisted_source_operation_actor_principal_sha256",
        ),
      });
    }
    if (lineage.tenant_id !== source.tenant_id
      || lineage.scope !== source.scope
      || lineage.operation_kind !== source.operation_kind
      || lineage.operation_id !== source.operation_id
      || lineage.request_sha256 !== source.request_sha256
      || lineage.actor_kind !== "operator") {
      throw new Error("continuation_runtime_v1_authority_artifact_corrupt:installation_operation_ref");
    }
    sha256(lineage.actor_principal_sha256, "installation_actor_principal_sha256");
    return canonicalContinuationClone({
      signed_artifact: decoded.signed_artifact,
      installation: lineage,
    });
  }

  const preflightArtifactSync = (
    tenantId: string,
    artifact: SignedAuthorityArtifactV1,
  ): void => {
    const existingIdentity = readExactSync(
      tenantId,
      artifact.artifact_id,
      artifact.artifact_revision,
    );
    if (existingIdentity) {
      throw new ContinuationRuntimeV1AuthorityArtifactConflictError("identity_conflict");
    }
    if (readDigestSync(tenantId, artifact.artifact_sha256)) {
      throw new ContinuationRuntimeV1AuthorityArtifactConflictError("digest_conflict");
    }
  };

  const assertExperimentCohortLearningPairSync = (
    tenantId: string,
    cohort: ReturnType<typeof verifyExperimentCohortV1>,
  ): void => {
    const installedCompiler = readDigestSync(
      tenantId,
      cohort.compiler_policy_ref.artifact_sha256,
    );
    if (!installedCompiler) {
      throw new Error(
        "continuation_runtime_v1_authority_artifact_experiment_cohort_compiler_policy_missing",
      );
    }
    const compilerArtifact = installedCompiler.signed_artifact;
    if (compilerArtifact.artifact_kind !== "compiler_policy"
      || compilerArtifact.artifact_schema !== CONTINUATION_COMPILER_POLICY_SCHEMA_V1
      || compilerArtifact.payload_sha256 !== cohort.compiler_policy_ref.payload_sha256
      || (compilerArtifact.authority_subject_sha256 !== null
        && compilerArtifact.authority_subject_sha256
          !== cohort.authority_subject_sha256)
      || compilerArtifact.valid_from > cohort.assignment_window_opened_at
      || (compilerArtifact.expires_at !== null
        && cohort.assignment_window_closed_at >= compilerArtifact.expires_at)) {
      throw new Error(
        "continuation_runtime_v1_authority_artifact_experiment_cohort_compiler_policy_invalid",
      );
    }
    const compilerPolicy = verifyContinuationCompilerPolicyV1(
      compilerArtifact.payload,
    );
    const installedEvidence = readDigestSync(
      tenantId,
      cohort.evidence_policy_ref.artifact_sha256,
    );
    if (!installedEvidence) {
      throw new Error(
        "continuation_runtime_v1_authority_artifact_experiment_cohort_evidence_policy_missing",
      );
    }
    const evidenceArtifact = installedEvidence.signed_artifact;
    if (evidenceArtifact.artifact_kind !== "evidence_policy"
      || evidenceArtifact.artifact_schema !== "effect_evidence_policy_v1"
      || evidenceArtifact.payload_sha256 !== cohort.evidence_policy_ref.payload_sha256
      || (evidenceArtifact.authority_subject_sha256 !== null
        && evidenceArtifact.authority_subject_sha256
          !== cohort.authority_subject_sha256)
      || evidenceArtifact.valid_from > cohort.assignment_window_opened_at
      || (evidenceArtifact.expires_at !== null
        && cohort.settlement_cutoff_at >= evidenceArtifact.expires_at)) {
      throw new Error(
        "continuation_runtime_v1_authority_artifact_experiment_cohort_evidence_policy_invalid",
      );
    }
    const evidencePolicy = verifyEffectEvidencePolicyV1(evidenceArtifact.payload);
    const pair = database.db.prepare(`SELECT
        control.compiler_policy_artifact_sha256 AS control_compiler_artifact,
        control.compiler_policy_payload_sha256 AS control_compiler_payload,
        control.evidence_policy_artifact_sha256 AS control_evidence_artifact,
        control.evidence_policy_payload_sha256 AS control_evidence_payload,
        candidate.compiler_policy_artifact_sha256 AS candidate_compiler_artifact,
        candidate.compiler_policy_payload_sha256 AS candidate_compiler_payload,
        candidate.evidence_policy_artifact_sha256 AS candidate_evidence_artifact,
        candidate.evidence_policy_payload_sha256 AS candidate_evidence_payload,
        candidate.base_branch_id AS candidate_base_id,
        candidate.base_branch_revision AS candidate_base_revision,
        candidate.base_manifest_sha256 AS candidate_base_manifest,
        (SELECT COUNT(*) FROM branch_capsule_bindings AS binding
          WHERE binding.tenant_id = control.tenant_id
            AND binding.authority_subject_sha256 = control.authority_subject_sha256
            AND binding.branch_id = control.branch_id
            AND binding.branch_revision = control.branch_revision
        ) AS control_binding_count,
        (SELECT COUNT(*) FROM branch_capsule_bindings AS binding
          WHERE binding.tenant_id = candidate.tenant_id
            AND binding.authority_subject_sha256 = candidate.authority_subject_sha256
            AND binding.branch_id = candidate.branch_id
            AND binding.branch_revision = candidate.branch_revision
        ) AS candidate_binding_count
      FROM authority_heads AS head
      JOIN branch_revisions AS control
        ON control.tenant_id = head.tenant_id
       AND control.authority_subject_sha256 = head.authority_subject_sha256
       AND control.branch_id = head.branch_id
       AND control.branch_revision = head.branch_revision
       AND control.manifest_sha256 = head.manifest_sha256
       AND control.branch_kind = 'authoritative'
       AND control.state = 'authoritative'
      JOIN branch_revisions AS candidate
        ON candidate.tenant_id = control.tenant_id
       AND candidate.authority_subject_sha256 = control.authority_subject_sha256
       AND candidate.branch_id = ?
       AND candidate.branch_revision = ?
       AND candidate.manifest_sha256 = ?
       AND candidate.branch_kind = 'candidate'
       AND candidate.state = 'active_candidate'
      WHERE head.tenant_id = ?
        AND head.authority_subject_sha256 = ?
        AND control.branch_id = ?
        AND control.branch_revision = ?
        AND control.manifest_sha256 = ?
        AND NOT EXISTS (
          SELECT 1 FROM branch_revisions AS newer
          WHERE newer.tenant_id = candidate.tenant_id
            AND newer.authority_subject_sha256 = candidate.authority_subject_sha256
            AND newer.branch_id = candidate.branch_id
            AND newer.branch_revision > candidate.branch_revision
        )`).get(
      cohort.candidate_learning_ref.branch_id,
      cohort.candidate_learning_ref.branch_revision,
      cohort.candidate_learning_ref.manifest_sha256,
      tenantId,
      cohort.authority_subject_sha256,
      cohort.control_learning_ref.branch_id,
      cohort.control_learning_ref.branch_revision,
      cohort.control_learning_ref.manifest_sha256,
    ) as Readonly<Record<string, unknown>> | undefined;
    const exact = (left: unknown, right: unknown) => left === right;
    const metrics = continuationRuntimeV1LearningPairMetrics(database, {
      tenant_id: tenantId,
      authority_subject_sha256: cohort.authority_subject_sha256,
      control_ref: cohort.control_learning_ref,
      candidate_ref: cohort.candidate_learning_ref,
    });
    if (!pair
      || !exact(pair.candidate_base_id, cohort.control_learning_ref.branch_id)
      || !exact(
        pair.candidate_base_revision,
        cohort.control_learning_ref.branch_revision,
      )
      || !exact(
        pair.candidate_base_manifest,
        cohort.control_learning_ref.manifest_sha256,
      )
      || !exact(
        pair.control_compiler_artifact,
        cohort.compiler_policy_ref.artifact_sha256,
      )
      || !exact(
        pair.control_compiler_payload,
        cohort.compiler_policy_ref.payload_sha256,
      )
      || !exact(pair.candidate_compiler_artifact, pair.control_compiler_artifact)
      || !exact(pair.candidate_compiler_payload, pair.control_compiler_payload)
      || !exact(
        pair.control_evidence_artifact,
        cohort.evidence_policy_ref.artifact_sha256,
      )
      || !exact(
        pair.control_evidence_payload,
        cohort.evidence_policy_ref.payload_sha256,
      )
      || !exact(pair.candidate_evidence_artifact, pair.control_evidence_artifact)
      || !exact(pair.candidate_evidence_payload, pair.control_evidence_payload)
      || pair.control_binding_count !== metrics.control_binding_count
      || pair.candidate_binding_count !== metrics.candidate_binding_count
      || metrics.control_binding_count > compilerPolicy.learning_candidate_limit
      || metrics.candidate_binding_count > compilerPolicy.learning_candidate_limit) {
      throw new Error(
        "continuation_runtime_v1_authority_artifact_experiment_cohort_learning_pair_invalid",
      );
    }
    if (metrics.treatment_delta_count < 1
      || metrics.treatment_delta_count > evidencePolicy.max_treatment_delta_count) {
      throw new Error(
        "continuation_runtime_v1_authority_artifact_experiment_cohort_treatment_delta_invalid",
      );
    }
  };

  const insertArtifactSync = (
    binding: ContinuationRuntimeV1AuthorityWriteBinding,
    artifact: SignedAuthorityArtifactV1,
    protectedSecret: Buffer | null = null,
  ): InstalledAuthorityArtifactV1 => {
    const payloadJson = canonicalContinuationJson(artifact.payload);
    const signature = Buffer.from(artifact.signature, "base64url");
    if (signature.byteLength !== 64 || signature.toString("base64url") !== artifact.signature) {
      throw new Error("continuation_runtime_v1_authority_artifact_signature_noncanonical");
    }
    database.db.prepare(`INSERT INTO authority_artifacts(
      tenant_id, artifact_id, artifact_revision, artifact_kind, artifact_schema,
      authority_subject_sha256, payload_sha256, artifact_sha256, payload_json,
      signer_principal_sha256, trust_root_sha256, signature_algorithm, signature,
      valid_from, expires_at, created_at, source_operation_scope,
      source_operation_kind, source_operation_id, source_request_sha256,
      protected_secret
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      binding.tenantId,
      artifact.artifact_id,
      artifact.artifact_revision,
      artifact.artifact_kind,
      artifact.artifact_schema,
      artifact.authority_subject_sha256,
      artifact.payload_sha256,
      artifact.artifact_sha256,
      payloadJson,
      artifact.signer_principal_sha256,
      artifact.trust_root_sha256,
      artifact.signature_algorithm,
      signature,
      artifact.valid_from,
      artifact.expires_at,
      artifact.created_at,
      binding.scope,
      binding.operationKind,
      binding.operationId,
      binding.requestSha256,
      protectedSecret,
    );
    const lineage = continuationRuntimeV1OperationLineage(binding);
    const persisted = readExactSync(
      binding.tenantId,
      artifact.artifact_id,
      artifact.artifact_revision,
      lineage,
    );
    if (!persisted
      || !artifactEqual(persisted.signed_artifact, artifact)
      || canonicalContinuationJson(persisted.installation) !== canonicalContinuationJson(lineage)) {
      throw new Error("continuation_runtime_v1_authority_artifact_postwrite_mismatch");
    }
    return persisted;
  };

  const provisioner: ContinuationRuntimeV1AuthorityArtifactProvisioner = Object.freeze({
    async put(
      context: ContinuationRuntimeV1AuthorityWriteContext,
      signedArtifact: SignedAuthorityArtifactV1,
    ): Promise<InstalledAuthorityArtifactV1> {
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(context, database);
      // Provisioning is itself a governance decision. A background worker may
      // verify or prepare a proposal, but cannot install authority merely by
      // completing a job.
      if (binding.operationKind !== "authority_decision") {
        throw new Error("continuation_runtime_v1_authority_artifact_operation_kind_forbidden");
      }
      const artifact = verifySignedAuthorityArtifactV1(signedArtifact, pinnedPublicKey);
      assertControlFreeCanonicalJson(artifact.payload, "authority artifact payload");
      if (artifact.tenant_id !== binding.tenantId) {
        throw new Error("continuation_runtime_v1_authority_artifact_tenant_mismatch");
      }
      if (artifact.artifact_kind === "experiment_cohort") {
        throw new Error(
          "continuation_runtime_v1_authority_artifact_experiment_cohort_requires_protected_provisioning",
        );
      }
      if (ARTIFACT_MUTATION_CONTEXTS.has(context)) {
        throw new Error("continuation_runtime_v1_authority_artifact_operation_context_already_used");
      }
      // One signed artifact is the complete authority payload for this
      // operation. Consume the capability before any conflict check so callers
      // cannot probe and then choose a different authority mutation in one op.
      ARTIFACT_MUTATION_CONTEXTS.add(context);

      preflightArtifactSync(binding.tenantId, artifact);
      return canonicalContinuationClone(insertArtifactSync(binding, artifact));
    },

    async putExperimentCohort(
      context: ContinuationRuntimeV1AuthorityWriteContext,
      signedArtifact: SignedAuthorityArtifactV1,
      assignmentSeed: Uint8Array,
    ): Promise<InstalledAuthorityArtifactV1> {
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(context, database);
      if (binding.operationKind !== "authority_decision") {
        throw new Error("continuation_runtime_v1_authority_artifact_operation_kind_forbidden");
      }
      const artifact = verifySignedAuthorityArtifactV1(signedArtifact, pinnedPublicKey);
      if (artifact.tenant_id !== binding.tenantId
        || artifact.artifact_kind !== "experiment_cohort"
        || artifact.artifact_schema !== EXPERIMENT_COHORT_SCHEMA_V1
        || artifact.authority_subject_sha256 === null) {
        throw new Error(
          "continuation_runtime_v1_authority_artifact_experiment_cohort_binding_invalid",
        );
      }
      const cohort = verifyExperimentCohortV1(artifact.payload);
      assertExperimentCohortArtifactWindowV1(
        cohort,
        artifact.valid_from,
        artifact.expires_at,
      );
      if (cohort.tenant_id !== artifact.tenant_id
        || cohort.scope !== binding.scope
        || cohort.authority_subject_sha256 !== artifact.authority_subject_sha256
        || cohort.assignment_window_opened_at <= artifact.created_at
        || canonicalContinuationJson(cohort) !== canonicalContinuationJson(artifact.payload)
        || assignmentSeedCommitmentSha256V1(assignmentSeed)
          !== cohort.assignment_protocol.assignment_seed_commitment_sha256) {
        throw new Error(
          "continuation_runtime_v1_authority_artifact_experiment_cohort_provisioning_invalid",
        );
      }
      assertExperimentCohortLearningPairSync(binding.tenantId, cohort);
      constrainContinuationRuntimeV1OperationCompletion(
        context,
        database,
        new Date(
          Date.parse(cohort.assignment_window_opened_at) - 1,
        ).toISOString(),
      );
      if (ARTIFACT_MUTATION_CONTEXTS.has(context)) {
        throw new Error("continuation_runtime_v1_authority_artifact_operation_context_already_used");
      }
      ARTIFACT_MUTATION_CONTEXTS.add(context);
      preflightArtifactSync(binding.tenantId, artifact);
      const seed = Buffer.from(assignmentSeed);
      const installed = insertArtifactSync(binding, artifact, seed);
      const durableJobs = createContinuationRuntimeV1DurableJobEnqueuer(database);
      await durableJobs.enqueue(context, {
        task_family: cohort.task_family,
        authority_subject_sha256: cohort.authority_subject_sha256,
        job_kind: "effect",
        dedupe_key: `experiment-cohort:${artifact.artifact_sha256}`,
        priority: 0,
        max_attempts: 8,
        payload: {
          schema_version: "effect_settlement_job_v1",
          experiment_cohort_ref: {
            artifact_sha256: artifact.artifact_sha256,
            payload_sha256: artifact.payload_sha256,
          },
          cohort_id: cohort.cohort_id,
          assignment_window_opened_at: cohort.assignment_window_opened_at,
          assignment_window_closed_at: cohort.assignment_window_closed_at,
          outcome_deadline: cohort.outcome_deadline,
          settlement_cutoff_at: cohort.settlement_cutoff_at,
          control_learning_ref: cohort.control_learning_ref,
          candidate_learning_ref: cohort.candidate_learning_ref,
          compiler_policy_ref: cohort.compiler_policy_ref,
          evidence_policy_ref: cohort.evidence_policy_ref,
        },
        available_at: cohort.settlement_cutoff_at,
      });
      return canonicalContinuationClone(installed);
    },

    async putBundle(
      context: ContinuationRuntimeV1AuthorityWriteContext,
      value: AuthorityPolicyProvisioningBundleV1,
    ): Promise<InstalledAuthorityPolicyBundleV1> {
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(context, database);
      if (binding.operationKind !== "authority_decision") {
        throw new Error("continuation_runtime_v1_authority_artifact_operation_kind_forbidden");
      }
      // Verify the complete externally signed bundle before consuming the
      // operation capability or consulting mutable database state.
      const bundle = parsePolicyBundle(value, pinnedPublicKey);
      if (bundle.tenant_id !== binding.tenantId) {
        throw new Error("continuation_runtime_v1_authority_artifact_policy_bundle_tenant_mismatch");
      }
      if (ARTIFACT_MUTATION_CONTEXTS.has(context)) {
        throw new Error("continuation_runtime_v1_authority_artifact_operation_context_already_used");
      }
      ARTIFACT_MUTATION_CONTEXTS.add(context);

      // Preflight both identities and digests before either INSERT. The outer
      // operation transaction also rolls back both rows on every later error.
      preflightArtifactSync(
        binding.tenantId,
        bundle.compiler_policy,
      );
      preflightArtifactSync(
        binding.tenantId,
        bundle.evidence_policy,
      );
      const compiler = insertArtifactSync(binding, bundle.compiler_policy);
      const evidence = insertArtifactSync(binding, bundle.evidence_policy);
      return canonicalContinuationClone({
        schema_version: "installed_authority_policy_bundle_v1",
        tenant_id: bundle.tenant_id,
        authority_subject_sha256: bundle.authority_subject_sha256,
        compiler_policy: compiler,
        evidence_policy: evidence,
      });
    },
  });
  ARTIFACT_PROVISIONER_DATABASES.set(provisioner, database);
  return provisioner;
}

import {
  EXPERIMENT_COHORT_SCHEMA_V1,
  experimentCohortEligibleV1,
  experimentCohortPayloadSha256V1,
  verifyExperimentCohortV1,
  type ExperimentCohortV1,
} from "../continuation/experiment-cohort.js";
import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  type AuthorityArtifactRefV1,
  type Sha256,
} from "../continuation/contract.js";
import {
  assignmentSeedCommitmentSha256V1,
  deriveServingAssignmentReceiptV1,
  type ServingAssignmentBasisV1,
  type ServingAssignmentReceiptV1,
} from "../continuation/serving-assignment.js";
import {
  assertContinuationRuntimeV1AuthorityArtifactReader,
  type ContinuationRuntimeV1AuthorityArtifactReader,
} from "./continuation-runtime-v1-authority-artifact-reader.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import { createContinuationRuntimeV1OperationStore } from
  "./continuation-runtime-v1-operation-store.js";
import { continuationRuntimeV1LearningPairMetrics } from
  "./continuation-runtime-v1-learning-pair.js";
import {
  assertContinuationRuntimeV1PolicyAuthority,
  type ContinuationRuntimeV1PolicyAuthority,
} from "./continuation-runtime-v1-policy-authority.js";

declare const VERIFIED_EXPERIMENT_COHORT_CAPABILITY: unique symbol;

export type VerifiedExperimentCohortCapabilityV1 = Readonly<{
  [VERIFIED_EXPERIMENT_COHORT_CAPABILITY]:
    "verified_experiment_cohort_capability_v1";
}>;

export type ResolveExperimentCohortV1Args = Readonly<{
  tenant_id: string;
  authority_subject_sha256: Sha256;
  experiment_cohort_ref: AuthorityArtifactRefV1;
  at: string;
}>;

export type ResolveActiveExperimentCohortV1Args = Readonly<{
  tenant_id: string;
  scope: string;
  authority_subject_sha256: Sha256;
  task_family: string;
  host_principal_sha256: Sha256;
  at: string;
}>;

export type ExperimentCohortAuthorityV1 = Readonly<{
  resolveExact(
    args: ResolveExperimentCohortV1Args,
  ): Promise<VerifiedExperimentCohortCapabilityV1>;
  resolveActive(
    args: ResolveActiveExperimentCohortV1Args,
  ): Promise<VerifiedExperimentCohortCapabilityV1 | null>;
  ref(capability: VerifiedExperimentCohortCapabilityV1): AuthorityArtifactRefV1;
  payload(capability: VerifiedExperimentCohortCapabilityV1): ExperimentCohortV1;
  installationReceiptSha256(
    capability: VerifiedExperimentCohortCapabilityV1,
  ): Sha256;
  deriveAssignment(
    capability: VerifiedExperimentCohortCapabilityV1,
    args: Readonly<{
      assignment_basis: ServingAssignmentBasisV1;
      assigned_at: string;
    }>,
  ): ServingAssignmentReceiptV1;
}>;

type CapabilityRecord = Readonly<{
  owner: ExperimentCohortAuthorityV1;
  ref: AuthorityArtifactRefV1;
  payload: ExperimentCohortV1;
  installationReceiptSha256: Sha256;
}>;

type ServiceRecord = Readonly<{
  database: ContinuationRuntimeV1Database;
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader;
  policyAuthority: ContinuationRuntimeV1PolicyAuthority;
}>;

const RESOLVE_KEYS = Object.freeze([
  "at", "authority_subject_sha256", "experiment_cohort_ref", "tenant_id",
] as const);
const ACTIVE_KEYS = Object.freeze([
  "at", "authority_subject_sha256", "host_principal_sha256", "scope",
  "task_family", "tenant_id",
] as const);
const REF_KEYS = Object.freeze(["artifact_sha256", "payload_sha256"] as const);
const CAPABILITIES = new WeakMap<object, CapabilityRecord>();
const SERVICES = new WeakMap<object, ServiceRecord>();

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_experiment_cohort_authority_${code}`);
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field}_must_be_plain_object`);
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  const expected = new Set(expectedKeys);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string")
    || keys.length !== expectedKeys.length
    || keys.some((key) => !expected.has(key as string))) {
    fail(`${field}_shape_invalid`);
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    assertUnicodeScalarString(key, `experiment cohort authority ${field} key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field}_shape_invalid`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertUnicodeScalarString(value, `experiment cohort authority ${field}`);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 256) fail(`${field}_invalid`);
  return value;
}

function sha(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertSha256(value, `experiment cohort authority ${field}`);
  return value;
}

function time(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertCanonicalUtcMillis(value, `experiment cohort authority ${field}`);
  return value;
}

function ref(value: unknown): AuthorityArtifactRefV1 {
  const record = exactRecord(value, REF_KEYS, "experiment_cohort_ref");
  return {
    artifact_sha256: sha(record.artifact_sha256, "artifact_sha256"),
    payload_sha256: sha(record.payload_sha256, "payload_sha256"),
  };
}

function resolveArgs(value: unknown): ResolveExperimentCohortV1Args {
  const record = exactRecord(value, RESOLVE_KEYS, "resolve_exact_args");
  return {
    tenant_id: text(record.tenant_id, "tenant_id"),
    authority_subject_sha256: sha(
      record.authority_subject_sha256,
      "authority_subject_sha256",
    ),
    experiment_cohort_ref: ref(record.experiment_cohort_ref),
    at: time(record.at, "at"),
  };
}

function activeArgs(value: unknown): ResolveActiveExperimentCohortV1Args {
  const record = exactRecord(value, ACTIVE_KEYS, "resolve_active_args");
  return {
    tenant_id: text(record.tenant_id, "tenant_id"),
    scope: text(record.scope, "scope"),
    authority_subject_sha256: sha(
      record.authority_subject_sha256,
      "authority_subject_sha256",
    ),
    task_family: text(record.task_family, "task_family"),
    host_principal_sha256: sha(
      record.host_principal_sha256,
      "host_principal_sha256",
    ),
    at: time(record.at, "at"),
  };
}

function capabilityRecord(
  owner: ExperimentCohortAuthorityV1,
  capability: unknown,
): CapabilityRecord {
  if (capability === null || typeof capability !== "object") fail("capability_invalid");
  const record = CAPABILITIES.get(capability);
  if (!record || record.owner !== owner) fail("capability_invalid");
  return record;
}

function withAssignmentSeed<T>(
  owner: ExperimentCohortAuthorityV1,
  capability: VerifiedExperimentCohortCapabilityV1,
  use: (seed: Buffer) => T,
): T {
  const record = capabilityRecord(owner, capability);
  const service = SERVICES.get(owner);
  if (!service) fail("service_invalid");
  const row = service.database.db.prepare(`SELECT protected_secret
    FROM authority_artifacts
    WHERE tenant_id = ? AND artifact_sha256 = ? AND payload_sha256 = ?
      AND artifact_kind = 'experiment_cohort'`).get(
    record.payload.tenant_id,
    record.ref.artifact_sha256,
    record.ref.payload_sha256,
  ) as Readonly<{ protected_secret: unknown }> | undefined;
  if (!row || !(row.protected_secret instanceof Uint8Array)
    || row.protected_secret.byteLength !== 32) {
    fail("protected_seed_missing");
  }
  const seed = Buffer.from(
    row.protected_secret.buffer,
    row.protected_secret.byteOffset,
    row.protected_secret.byteLength,
  );
  try {
    if (assignmentSeedCommitmentSha256V1(seed)
      !== record.payload.assignment_protocol.assignment_seed_commitment_sha256) {
      fail("protected_seed_commitment_mismatch");
    }
    return use(seed);
  } finally {
    seed.fill(0);
  }
}

export function assertContinuationRuntimeV1ExperimentCohortAuthority(
  value: unknown,
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
  policyAuthority: ContinuationRuntimeV1PolicyAuthority,
): asserts value is ExperimentCohortAuthorityV1 {
  if (value === null || typeof value !== "object") fail("service_invalid");
  const record = SERVICES.get(value);
  if (!record || record.database !== database || record.artifactStore !== artifactStore
    || record.policyAuthority !== policyAuthority) {
    fail("service_invalid");
  }
}

export function createContinuationRuntimeV1ExperimentCohortAuthority(
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
  policyAuthority: ContinuationRuntimeV1PolicyAuthority,
): ExperimentCohortAuthorityV1 {
  assertContinuationRuntimeV1AuthorityArtifactReader(artifactStore, database);
  assertContinuationRuntimeV1PolicyAuthority(
    policyAuthority,
    database,
    artifactStore,
  );
  const operations = createContinuationRuntimeV1OperationStore(database);
  let service!: ExperimentCohortAuthorityV1;

  const resolve = async (
    parsed: ResolveExperimentCohortV1Args,
  ): Promise<VerifiedExperimentCohortCapabilityV1> => {
    const installed = await artifactStore.readByDigest({
      tenant_id: parsed.tenant_id,
      artifact_sha256: parsed.experiment_cohort_ref.artifact_sha256,
    });
    if (!installed) fail("artifact_missing");
    const artifact = installed.signed_artifact;
    if (artifact.tenant_id !== parsed.tenant_id
      || artifact.artifact_kind !== "experiment_cohort"
      || artifact.artifact_schema !== EXPERIMENT_COHORT_SCHEMA_V1
      || artifact.artifact_sha256 !== parsed.experiment_cohort_ref.artifact_sha256
      || artifact.payload_sha256 !== parsed.experiment_cohort_ref.payload_sha256
      || artifact.valid_from > parsed.at
      || artifact.expires_at === null
      || parsed.at >= artifact.expires_at) fail("artifact_binding_invalid");
    const payload = verifyExperimentCohortV1(artifact.payload);
    if (payload.tenant_id !== artifact.tenant_id
      || payload.scope !== installed.installation.scope
      || payload.authority_subject_sha256 !== artifact.authority_subject_sha256
      || experimentCohortPayloadSha256V1(payload) !== artifact.payload_sha256
      || canonicalContinuationJson(payload) !== canonicalContinuationJson(artifact.payload)) {
      fail("payload_binding_invalid");
    }
    const installation = await operations.read({
      tenantId: installed.installation.tenant_id,
      scope: installed.installation.scope,
      operationKind: "authority_decision",
      operationId: installed.installation.operation_id,
    });
    if (!installation
      || installation.request_sha256 !== installed.installation.request_sha256
      || installation.receipt.actor_kind !== "operator"
      || installation.receipt.actor_principal_sha256
        !== installed.installation.actor_principal_sha256
      || installation.receipt.completed_at >= payload.assignment_window_opened_at) {
      fail("installation_receipt_invalid");
    }
    const result = installation.receipt.result as Readonly<Record<string, unknown>>;
    const resultRef = result.experiment_cohort_ref;
    if (result.schema_version !== "authority_decision_result_v1"
      || result.decision_kind !== "experiment_cohort_install"
      || canonicalContinuationJson(resultRef)
        !== canonicalContinuationJson(parsed.experiment_cohort_ref)) {
      fail("installation_receipt_artifact_mismatch");
    }
    const compilerCapability = await policyAuthority.resolveExact({
      tenant_id: parsed.tenant_id,
      authority_subject_sha256: parsed.authority_subject_sha256,
      artifact_kind: "compiler_policy",
      artifact_ref: payload.compiler_policy_ref,
      at: payload.assignment_window_opened_at,
    });
    const learningCandidateLimit = policyAuthority.payload(compilerCapability)
      .learning_candidate_limit;
    const evidenceCapability = await policyAuthority.resolveExact({
      tenant_id: parsed.tenant_id,
      authority_subject_sha256: parsed.authority_subject_sha256,
      artifact_kind: "evidence_policy",
      artifact_ref: payload.evidence_policy_ref,
      at: payload.settlement_cutoff_at,
    });
    const maximumTreatmentDelta = policyAuthority.payload(evidenceCapability)
      .max_treatment_delta_count;
    const authority = database.db.prepare(`SELECT
        control.compiler_policy_artifact_sha256 AS control_compiler_artifact,
        control.compiler_policy_payload_sha256 AS control_compiler_payload,
        control.evidence_policy_artifact_sha256 AS control_evidence_artifact,
        control.evidence_policy_payload_sha256 AS control_evidence_payload,
        candidate.base_branch_id AS candidate_base_id,
        candidate.base_branch_revision AS candidate_base_revision,
        candidate.base_manifest_sha256 AS candidate_base_manifest,
        candidate.compiler_policy_artifact_sha256 AS candidate_compiler_artifact,
        candidate.compiler_policy_payload_sha256 AS candidate_compiler_payload,
        candidate.evidence_policy_artifact_sha256 AS candidate_evidence_artifact,
        candidate.evidence_policy_payload_sha256 AS candidate_evidence_payload,
        artifact.protected_secret AS protected_secret,
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
      FROM branch_revisions AS control
      JOIN branch_revisions AS candidate
        ON candidate.tenant_id = control.tenant_id
       AND candidate.authority_subject_sha256 = control.authority_subject_sha256
       AND candidate.branch_id = ?
       AND candidate.branch_revision = ?
       AND candidate.manifest_sha256 = ?
       AND candidate.branch_kind = 'candidate'
       AND candidate.state = 'active_candidate'
      JOIN authority_artifacts AS artifact
        ON artifact.tenant_id = control.tenant_id
       AND artifact.artifact_sha256 = ?
       AND artifact.payload_sha256 = ?
       AND artifact.artifact_kind = 'experiment_cohort'
      WHERE control.tenant_id = ?
       AND control.authority_subject_sha256 = ?
       AND control.branch_id = ?
       AND control.branch_revision = ?
       AND control.manifest_sha256 = ?
       AND control.branch_kind = 'authoritative'
       AND control.state = 'authoritative'
      `).get(
        payload.candidate_learning_ref.branch_id,
        payload.candidate_learning_ref.branch_revision,
        payload.candidate_learning_ref.manifest_sha256,
        parsed.experiment_cohort_ref.artifact_sha256,
        parsed.experiment_cohort_ref.payload_sha256,
        parsed.tenant_id,
        parsed.authority_subject_sha256,
        payload.control_learning_ref.branch_id,
        payload.control_learning_ref.branch_revision,
        payload.control_learning_ref.manifest_sha256,
      ) as Readonly<Record<string, unknown>> | undefined;
    const exact = (left: unknown, right: unknown) => left === right;
    const metrics = continuationRuntimeV1LearningPairMetrics(database, {
      tenant_id: parsed.tenant_id,
      authority_subject_sha256: parsed.authority_subject_sha256,
      control_ref: payload.control_learning_ref,
      candidate_ref: payload.candidate_learning_ref,
    });
    if (!authority
      || !exact(authority.candidate_base_id, payload.control_learning_ref.branch_id)
      || !exact(authority.candidate_base_revision, payload.control_learning_ref.branch_revision)
      || !exact(authority.candidate_base_manifest, payload.control_learning_ref.manifest_sha256)
      || !exact(authority.control_compiler_artifact, payload.compiler_policy_ref.artifact_sha256)
      || !exact(authority.control_compiler_payload, payload.compiler_policy_ref.payload_sha256)
      || !exact(authority.control_evidence_artifact, payload.evidence_policy_ref.artifact_sha256)
      || !exact(authority.control_evidence_payload, payload.evidence_policy_ref.payload_sha256)
      || !exact(authority.candidate_compiler_artifact, payload.compiler_policy_ref.artifact_sha256)
      || !exact(authority.candidate_compiler_payload, payload.compiler_policy_ref.payload_sha256)
      || !exact(authority.candidate_evidence_artifact, payload.evidence_policy_ref.artifact_sha256)
      || !exact(authority.candidate_evidence_payload, payload.evidence_policy_ref.payload_sha256)
      || authority.control_binding_count !== metrics.control_binding_count
      || authority.candidate_binding_count !== metrics.candidate_binding_count
      || metrics.control_binding_count > learningCandidateLimit
      || metrics.candidate_binding_count > learningCandidateLimit
      || !(authority.protected_secret instanceof Uint8Array)
      || authority.protected_secret.byteLength !== 32) {
      fail("learning_pair_or_policy_drift");
    }
    if (metrics.treatment_delta_count < 1
      || metrics.treatment_delta_count > maximumTreatmentDelta) {
      fail("treatment_delta_outside_frozen_policy");
    }
    const seed = Buffer.from(
      authority.protected_secret.buffer,
      authority.protected_secret.byteOffset,
      authority.protected_secret.byteLength,
    );
    try {
      if (assignmentSeedCommitmentSha256V1(seed)
        !== payload.assignment_protocol.assignment_seed_commitment_sha256) {
        fail("protected_seed_commitment_mismatch");
      }
    } finally {
      seed.fill(0);
    }
    const capability = Object.freeze(Object.create(null)) as object;
    CAPABILITIES.set(capability, {
      owner: service,
      ref: canonicalContinuationClone(parsed.experiment_cohort_ref),
      payload,
      installationReceiptSha256: sha(
        installation.receipt_sha256,
        "installation_receipt_sha256",
      ),
    });
    return capability as VerifiedExperimentCohortCapabilityV1;
  };

  service = Object.freeze({
    async resolveExact(value: ResolveExperimentCohortV1Args) {
      return resolve(resolveArgs(value));
    },

    async resolveActive(value: ResolveActiveExperimentCohortV1Args) {
      const parsed = activeArgs(value);
      const rows = await database.read(() => database.db.prepare(`SELECT
          artifact_sha256, payload_sha256
        FROM authority_artifacts
        WHERE tenant_id = ? AND source_operation_scope = ?
          AND authority_subject_sha256 = ?
          AND artifact_kind = 'experiment_cohort'
          AND json_extract(payload_json, '$.assignment_window_opened_at') <= ?
          AND ? < json_extract(payload_json, '$.assignment_window_closed_at')
        ORDER BY artifact_id, artifact_revision`).all(
          parsed.tenant_id,
          parsed.scope,
          parsed.authority_subject_sha256,
          parsed.at,
          parsed.at,
        ) as Array<Readonly<Record<string, unknown>>>);
      if (rows.length > 1) fail("active_cohort_cardinality");
      if (rows.length === 0) return null;
      const capability = await resolve({
        tenant_id: parsed.tenant_id,
        authority_subject_sha256: parsed.authority_subject_sha256,
        experiment_cohort_ref: {
          artifact_sha256: sha(rows[0]!.artifact_sha256, "active_artifact_sha256"),
          payload_sha256: sha(rows[0]!.payload_sha256, "active_payload_sha256"),
        },
        at: parsed.at,
      });
      const payload = service.payload(capability);
      const currentPair = await database.read(() => database.db.prepare(`SELECT 1 AS present
        FROM authority_heads AS head
        JOIN branch_revisions AS candidate
          ON candidate.tenant_id = head.tenant_id
         AND candidate.authority_subject_sha256 = head.authority_subject_sha256
         AND candidate.branch_id = ?
         AND candidate.branch_revision = ?
         AND candidate.manifest_sha256 = ?
         AND candidate.branch_kind = 'candidate'
         AND candidate.state = 'active_candidate'
        WHERE head.tenant_id = ? AND head.authority_subject_sha256 = ?
          AND head.branch_id = ? AND head.branch_revision = ?
          AND head.manifest_sha256 = ?
          AND NOT EXISTS (
            SELECT 1 FROM branch_revisions AS newer_candidate
            WHERE newer_candidate.tenant_id = candidate.tenant_id
              AND newer_candidate.authority_subject_sha256 =
                candidate.authority_subject_sha256
              AND newer_candidate.branch_id = candidate.branch_id
              AND newer_candidate.branch_revision > candidate.branch_revision
          )`).get(
          payload.candidate_learning_ref.branch_id,
          payload.candidate_learning_ref.branch_revision,
          payload.candidate_learning_ref.manifest_sha256,
          parsed.tenant_id,
          parsed.authority_subject_sha256,
          payload.control_learning_ref.branch_id,
          payload.control_learning_ref.branch_revision,
          payload.control_learning_ref.manifest_sha256,
        ) as Readonly<Record<string, unknown>> | undefined);
      if (!currentPair) return null;
      return experimentCohortEligibleV1(
        payload,
        parsed.task_family,
        parsed.host_principal_sha256,
      ) ? capability : null;
    },

    ref(capability: VerifiedExperimentCohortCapabilityV1) {
      return canonicalContinuationClone(capabilityRecord(service, capability).ref);
    },

    payload(capability: VerifiedExperimentCohortCapabilityV1) {
      return canonicalContinuationClone(capabilityRecord(service, capability).payload);
    },

    installationReceiptSha256(capability: VerifiedExperimentCohortCapabilityV1) {
      return capabilityRecord(service, capability).installationReceiptSha256;
    },

    deriveAssignment(
      capability: VerifiedExperimentCohortCapabilityV1,
      args: Readonly<{
        assignment_basis: ServingAssignmentBasisV1;
        assigned_at: string;
      }>,
    ) {
      const record = capabilityRecord(service, capability);
      return withAssignmentSeed(service, capability, (assignmentSeed) =>
        deriveServingAssignmentReceiptV1({
          cohort: record.payload,
          experiment_cohort_ref: record.ref,
          assignment_seed: assignmentSeed,
          assignment_basis: args.assignment_basis,
          assigned_at: args.assigned_at,
        }));
    },

  });
  SERVICES.set(service, { database, artifactStore, policyAuthority });
  return service;
}

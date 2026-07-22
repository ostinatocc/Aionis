import type {
  AuthorityBranchRevisionRefV1,
  AuthoritativeBranchRevisionRefV1,
} from "./authority-branch.js";
import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  compareCanonicalUtf8,
  type AuthorityArtifactRefV1,
  type Sha256,
} from "./contract.js";
import { continuationAuthoritySubjectSha256V1 } from "./task-envelope.js";

export const EXPERIMENT_COHORT_SCHEMA_V1 = "experiment_cohort_v1" as const;

export const EXPERIMENT_ASSIGNMENT_ALGORITHM_CONTRACT_V1 =
  canonicalContinuationClone({
    schema_version: "hmac_sha256_threshold_algorithm_contract_v1" as const,
    prf: "hmac_sha256" as const,
    secret: "one_independent_32_byte_seed_per_cohort" as const,
    message: "canonical_json_utf8(serving_assignment_basis_v1)" as const,
    draw: "unsigned_big_endian_256_bit_integer" as const,
    candidate_rule: "draw*10000 < 2^256*candidate_allocation_bps" as const,
    control_rule: "otherwise" as const,
  });

export const EXPERIMENT_ASSIGNMENT_ALGORITHM_CONTRACT_SHA256_V1 =
  canonicalContinuationSha256(EXPERIMENT_ASSIGNMENT_ALGORITHM_CONTRACT_V1);

export type ActiveCandidateBranchRevisionRefV1 =
  AuthorityBranchRevisionRefV1 & Readonly<{
    branch_kind: "candidate";
    state: "active_candidate";
  }>;

export type ExperimentCohortV1 = Readonly<{
  schema_version: typeof EXPERIMENT_COHORT_SCHEMA_V1;
  tenant_id: string;
  scope: string;
  task_family: string;
  cohort_id: string;
  authority_subject_sha256: Sha256;
  control_learning_ref: AuthoritativeBranchRevisionRefV1;
  candidate_learning_ref: ActiveCandidateBranchRevisionRefV1;
  compiler_policy_ref: AuthorityArtifactRefV1;
  evidence_policy_ref: AuthorityArtifactRefV1;
  eligibility: Readonly<{
    host_principal_sha256s: readonly Sha256[] | null;
  }>;
  assignment_protocol: Readonly<{
    algorithm: "hmac_sha256_threshold_v1";
    algorithm_contract_sha256: Sha256;
    assignment_seed_commitment_sha256: Sha256;
    basis_schema: "serving_assignment_basis_v1";
    candidate_allocation_bps: number;
  }>;
  assignment_window_opened_at: string;
  assignment_window_closed_at: string;
  outcome_deadline: string;
  settlement_grace_ms: number;
  settlement_cutoff_at: string;
}>;

const COHORT_KEYS = Object.freeze([
  "assignment_protocol",
  "assignment_window_closed_at",
  "assignment_window_opened_at",
  "authority_subject_sha256",
  "candidate_learning_ref",
  "cohort_id",
  "compiler_policy_ref",
  "eligibility",
  "evidence_policy_ref",
  "outcome_deadline",
  "schema_version",
  "scope",
  "task_family",
  "settlement_cutoff_at",
  "settlement_grace_ms",
  "tenant_id",
  "control_learning_ref",
] as const);
const REVISION_REF_KEYS = Object.freeze([
  "branch_id", "branch_kind", "branch_revision", "manifest_sha256", "state",
] as const);
const ARTIFACT_REF_KEYS = Object.freeze([
  "artifact_sha256", "payload_sha256",
] as const);
const ELIGIBILITY_KEYS = Object.freeze(["host_principal_sha256s"] as const);
const PROTOCOL_KEYS = Object.freeze([
  "algorithm",
  "algorithm_contract_sha256",
  "assignment_seed_commitment_sha256",
  "basis_schema",
  "candidate_allocation_bps",
] as const);

const MAX_ELIGIBLE_HOST_PRINCIPALS = 4_096;
const MAX_SETTLEMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

export class ExperimentCohortError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`invalid_experiment_cohort_v1:${message}`, options);
    this.name = "ExperimentCohortError";
  }
}

function fail(message: string): never {
  throw new ExperimentCohortError(message);
}

function wrap<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ExperimentCohortError) throw error;
    throw new ExperimentCohortError(
      error instanceof Error ? error.message : "cohort validation failed",
      { cause: error },
    );
  }
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  const expected = new Set(expectedKeys);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string")
    || keys.length !== expectedKeys.length
    || keys.some((key) => !expected.has(key as string))) {
    fail(`${field} contains unknown or missing fields`);
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    assertUnicodeScalarString(key, `${field} key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field} must contain only enumerable data properties`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function exactArray(value: unknown, maximum: number, field: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length === 0 || value.length > maximum) {
    fail(`${field} must contain 1-${maximum} entries or be null`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1
    || keys.some((key) => typeof key !== "string")) {
    fail(`${field} must be a dense plain array`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field} must contain only enumerable data entries`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field} must be text`);
  assertUnicodeScalarString(value, field);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 256) {
    fail(`${field} is not canonical bounded text`);
  }
  return value;
}

function sha(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") fail(`${field} must be a SHA-256 digest`);
  assertSha256(value, field);
  return value;
}

function time(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field} must be a canonical timestamp`);
  assertCanonicalUtcMillis(value, field);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function artifactRef(value: unknown, field: string): AuthorityArtifactRefV1 {
  const record = exactRecord(value, ARTIFACT_REF_KEYS, field);
  return {
    artifact_sha256: sha(record.artifact_sha256, `${field}.artifact_sha256`),
    payload_sha256: sha(record.payload_sha256, `${field}.payload_sha256`),
  };
}

function revisionRef(
  value: unknown,
  field: string,
): AuthorityBranchRevisionRefV1 {
  const record = exactRecord(value, REVISION_REF_KEYS, field);
  const kind = record.branch_kind;
  const state = record.state;
  if ((kind !== "authoritative" && kind !== "candidate")
    || (kind === "authoritative" && state !== "authoritative")
    || (kind === "candidate" && state !== "active_candidate")) {
    fail(`${field} kind/state is invalid for an experiment cohort`);
  }
  return {
    branch_id: text(record.branch_id, `${field}.branch_id`),
    branch_revision: positiveInteger(record.branch_revision, `${field}.branch_revision`),
    manifest_sha256: sha(record.manifest_sha256, `${field}.manifest_sha256`),
    branch_kind: kind,
    state,
  } as AuthorityBranchRevisionRefV1;
}

function canonicalShaSet(
  value: unknown,
  maximum: number,
  field: string,
): readonly Sha256[] | null {
  if (value === null) return null;
  const values = exactArray(value, maximum, field).map((entry, index) =>
    sha(entry, `${field}[${index}]`)
  );
  if (values.some((entry, index) => index > 0
    && compareCanonicalUtf8(values[index - 1]!, entry) >= 0)) {
    fail(`${field} must be a canonical unique set`);
  }
  return values;
}

function parseCohort(value: unknown): ExperimentCohortV1 {
  const record = exactRecord(value, COHORT_KEYS, "experiment cohort");
  if (record.schema_version !== EXPERIMENT_COHORT_SCHEMA_V1) {
    fail("schema_version is invalid");
  }
  const control = revisionRef(record.control_learning_ref, "control_learning_ref");
  if (control.branch_kind !== "authoritative" || control.state !== "authoritative") {
    fail("control_learning_ref must be authoritative");
  }
  const candidate = revisionRef(record.candidate_learning_ref, "candidate_learning_ref");
  if (candidate.branch_kind !== "candidate" || candidate.state !== "active_candidate") {
    fail("candidate_learning_ref must be active_candidate");
  }
  const eligibility = exactRecord(
    record.eligibility,
    ELIGIBILITY_KEYS,
    "eligibility",
  );
  const protocol = exactRecord(
    record.assignment_protocol,
    PROTOCOL_KEYS,
    "assignment_protocol",
  );
  if (protocol.algorithm !== "hmac_sha256_threshold_v1"
    || protocol.basis_schema !== "serving_assignment_basis_v1") {
    fail("assignment protocol is not the closed V1 protocol");
  }
  const contractSha = sha(
    protocol.algorithm_contract_sha256,
    "assignment_protocol.algorithm_contract_sha256",
  );
  if (contractSha !== EXPERIMENT_ASSIGNMENT_ALGORITHM_CONTRACT_SHA256_V1) {
    fail("assignment algorithm contract digest is invalid");
  }
  const candidateAllocationBps = positiveInteger(
    protocol.candidate_allocation_bps,
    "assignment_protocol.candidate_allocation_bps",
  );
  if (candidateAllocationBps > 9_999) {
    fail("candidate_allocation_bps must be between 1 and 9999");
  }
  const openedAt = time(
    record.assignment_window_opened_at,
    "assignment_window_opened_at",
  );
  const closedAt = time(
    record.assignment_window_closed_at,
    "assignment_window_closed_at",
  );
  const outcomeDeadline = time(record.outcome_deadline, "outcome_deadline");
  const settlementGraceMs = nonNegativeInteger(
    record.settlement_grace_ms,
    "settlement_grace_ms",
  );
  if (settlementGraceMs > MAX_SETTLEMENT_GRACE_MS) {
    fail(`settlement_grace_ms exceeds ${MAX_SETTLEMENT_GRACE_MS}`);
  }
  const settlementCutoffAt = time(
    record.settlement_cutoff_at,
    "settlement_cutoff_at",
  );
  if (openedAt >= closedAt || closedAt > outcomeDeadline
    || Date.parse(outcomeDeadline) + settlementGraceMs
      !== Date.parse(settlementCutoffAt)) {
    fail("cohort assignment/outcome/settlement window is invalid");
  }
  const tenantId = text(record.tenant_id, "tenant_id");
  const scope = text(record.scope, "scope");
  const taskFamily = text(record.task_family, "task_family");
  const subject = sha(record.authority_subject_sha256, "authority_subject_sha256");
  if (continuationAuthoritySubjectSha256V1({
    tenant_id: tenantId,
    scope,
    task_family: taskFamily,
  }) !== subject) {
    fail("authority_subject_sha256 does not bind tenant, scope, and task_family");
  }
  return canonicalContinuationClone({
    schema_version: EXPERIMENT_COHORT_SCHEMA_V1,
    tenant_id: tenantId,
    scope,
    task_family: taskFamily,
    cohort_id: text(record.cohort_id, "cohort_id"),
    authority_subject_sha256: subject,
    control_learning_ref: control as AuthoritativeBranchRevisionRefV1,
    candidate_learning_ref: candidate as ActiveCandidateBranchRevisionRefV1,
    compiler_policy_ref: artifactRef(record.compiler_policy_ref, "compiler_policy_ref"),
    evidence_policy_ref: artifactRef(record.evidence_policy_ref, "evidence_policy_ref"),
    eligibility: {
      host_principal_sha256s: canonicalShaSet(
        eligibility.host_principal_sha256s,
        MAX_ELIGIBLE_HOST_PRINCIPALS,
        "eligibility.host_principal_sha256s",
      ),
    },
    assignment_protocol: {
      algorithm: "hmac_sha256_threshold_v1",
      algorithm_contract_sha256: contractSha,
      assignment_seed_commitment_sha256: sha(
        protocol.assignment_seed_commitment_sha256,
        "assignment_protocol.assignment_seed_commitment_sha256",
      ),
      basis_schema: "serving_assignment_basis_v1",
      candidate_allocation_bps: candidateAllocationBps,
    },
    assignment_window_opened_at: openedAt,
    assignment_window_closed_at: closedAt,
    outcome_deadline: outcomeDeadline,
    settlement_grace_ms: settlementGraceMs,
    settlement_cutoff_at: settlementCutoffAt,
  });
}

export function buildExperimentCohortV1(value: ExperimentCohortV1): ExperimentCohortV1 {
  return wrap(() => parseCohort(value));
}

export function verifyExperimentCohortV1(value: unknown): ExperimentCohortV1 {
  return wrap(() => parseCohort(value));
}

export function experimentCohortEligibleV1(
  cohort: ExperimentCohortV1,
  taskFamily: string,
  hostPrincipalSha256: Sha256,
): boolean {
  const verified = verifyExperimentCohortV1(cohort);
  text(taskFamily, "task_family");
  sha(hostPrincipalSha256, "host_principal_sha256");
  return verified.task_family === taskFamily
    && (verified.eligibility.host_principal_sha256s === null
      || verified.eligibility.host_principal_sha256s.includes(hostPrincipalSha256));
}

export function experimentCohortPayloadSha256V1(cohort: ExperimentCohortV1): Sha256 {
  return canonicalContinuationSha256(verifyExperimentCohortV1(cohort));
}

export function assertExperimentCohortArtifactWindowV1(
  cohort: ExperimentCohortV1,
  artifactValidFrom: string,
  artifactExpiresAt: string | null,
): void {
  const verified = verifyExperimentCohortV1(cohort);
  const validFrom = time(artifactValidFrom, "artifact.valid_from");
  const expiresAt = artifactExpiresAt === null
    ? null
    : time(artifactExpiresAt, "artifact.expires_at");
  if (validFrom > verified.assignment_window_opened_at
    || expiresAt === null
    || expiresAt < verified.settlement_cutoff_at) {
    fail("artifact validity must cover the full cohort settlement window");
  }
}

export function experimentCohortCanonicalJsonV1(cohort: ExperimentCohortV1): string {
  return canonicalContinuationJson(verifyExperimentCohortV1(cohort));
}

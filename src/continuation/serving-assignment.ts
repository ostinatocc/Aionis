import { createHash, createHmac } from "node:crypto";

import type { AuthoritativeBranchRevisionRefV1 } from "./authority-branch.js";
import {
  experimentCohortEligibleV1,
  experimentCohortPayloadSha256V1,
  verifyExperimentCohortV1,
  type ActiveCandidateBranchRevisionRefV1,
  type ExperimentCohortV1,
} from "./experiment-cohort.js";
import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  canonicalSha256Without,
  type AuthorityArtifactRefV1,
  type Sha256,
} from "./contract.js";

export const SERVING_ASSIGNMENT_BASIS_SCHEMA_V1 =
  "serving_assignment_basis_v1" as const;
export const SERVING_ASSIGNMENT_CLUSTER_SCHEMA_V1 =
  "serving_assignment_cluster_v1" as const;
export const SERVING_ASSIGNMENT_RECEIPT_SCHEMA_V1 =
  "serving_assignment_receipt_v1" as const;

export type ServingAssignmentBasisV1 = Readonly<{
  schema_version: typeof SERVING_ASSIGNMENT_BASIS_SCHEMA_V1;
  experiment_cohort_ref: AuthorityArtifactRefV1;
  create_continuation_operation_id: string;
  operation_request_sha256: Sha256;
  decision_id: string;
  episode_id: string;
  run_id: string;
  host_task_id: string;
  host_task_envelope_sha256: Sha256;
  host_principal_sha256: Sha256;
  task_family: string;
  source_task_sha256: Sha256;
  world_snapshot_ref: Readonly<{
    world_snapshot_id: string;
    world_snapshot_sha256: Sha256;
  }>;
  memory_scope_head_ref: Readonly<{
    revision: number;
    head_sha256: Sha256;
  }>;
}>;

export type ServingAssignmentReceiptV1 = Readonly<{
  schema_version: typeof SERVING_ASSIGNMENT_RECEIPT_SCHEMA_V1;
  tenant_id: string;
  scope: string;
  cohort_id: string;
  authority_subject_sha256: Sha256;
  experiment_cohort_ref: AuthorityArtifactRefV1;
  arm: "control" | "candidate";
  control_learning_ref: AuthoritativeBranchRevisionRefV1;
  candidate_learning_ref: ActiveCandidateBranchRevisionRefV1;
  served_learning_ref:
    | AuthoritativeBranchRevisionRefV1
    | ActiveCandidateBranchRevisionRefV1;
  compiler_policy_ref: AuthorityArtifactRefV1;
  evidence_policy_ref: AuthorityArtifactRefV1;
  assignment_basis: ServingAssignmentBasisV1;
  assignment_basis_sha256: Sha256;
  assignment_draw_sha256: Sha256;
  assigned_at: string;
  serving_assignment_receipt_sha256: Sha256;
}>;

const BASIS_KEYS = Object.freeze([
  "create_continuation_operation_id",
  "decision_id",
  "episode_id",
  "experiment_cohort_ref",
  "host_principal_sha256",
  "host_task_envelope_sha256",
  "host_task_id",
  "memory_scope_head_ref",
  "operation_request_sha256",
  "run_id",
  "schema_version",
  "source_task_sha256",
  "task_family",
  "world_snapshot_ref",
] as const);
const RECEIPT_KEYS = Object.freeze([
  "arm",
  "assigned_at",
  "assignment_basis",
  "assignment_basis_sha256",
  "assignment_draw_sha256",
  "authority_subject_sha256",
  "candidate_learning_ref",
  "cohort_id",
  "compiler_policy_ref",
  "control_learning_ref",
  "evidence_policy_ref",
  "experiment_cohort_ref",
  "schema_version",
  "scope",
  "served_learning_ref",
  "serving_assignment_receipt_sha256",
  "tenant_id",
] as const);
const REF_KEYS = Object.freeze(["artifact_sha256", "payload_sha256"] as const);
const BRANCH_REF_KEYS = Object.freeze([
  "branch_id", "branch_kind", "branch_revision", "manifest_sha256", "state",
] as const);
const SNAPSHOT_KEYS = Object.freeze([
  "world_snapshot_id", "world_snapshot_sha256",
] as const);
const MEMORY_HEAD_KEYS = Object.freeze(["head_sha256", "revision"] as const);
const UINT256_SPACE = 1n << 256n;

export class ServingAssignmentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`invalid_serving_assignment_v1:${message}`, options);
    this.name = "ServingAssignmentError";
  }
}

function fail(message: string): never {
  throw new ServingAssignmentError(message);
}

function wrap<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ServingAssignmentError) throw error;
    throw new ServingAssignmentError(
      error instanceof Error ? error.message : "assignment validation failed",
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

function artifactRef(value: unknown, field: string): AuthorityArtifactRefV1 {
  const record = exactRecord(value, REF_KEYS, field);
  return {
    artifact_sha256: sha(record.artifact_sha256, `${field}.artifact_sha256`),
    payload_sha256: sha(record.payload_sha256, `${field}.payload_sha256`),
  };
}

function branchRef(
  value: unknown,
  field: string,
): AuthoritativeBranchRevisionRefV1 | ActiveCandidateBranchRevisionRefV1 {
  const record = exactRecord(value, BRANCH_REF_KEYS, field);
  const kind = record.branch_kind;
  const state = record.state;
  if ((kind !== "authoritative" && kind !== "candidate")
    || (kind === "authoritative" && state !== "authoritative")
    || (kind === "candidate" && state !== "active_candidate")) {
    fail(`${field} kind/state is invalid`);
  }
  return {
    branch_id: text(record.branch_id, `${field}.branch_id`),
    branch_revision: positiveInteger(record.branch_revision, `${field}.branch_revision`),
    manifest_sha256: sha(record.manifest_sha256, `${field}.manifest_sha256`),
    branch_kind: kind,
    state,
  } as AuthoritativeBranchRevisionRefV1 | ActiveCandidateBranchRevisionRefV1;
}

function parseBasis(value: unknown): ServingAssignmentBasisV1 {
  const record = exactRecord(value, BASIS_KEYS, "assignment_basis");
  if (record.schema_version !== SERVING_ASSIGNMENT_BASIS_SCHEMA_V1) {
    fail("assignment basis schema_version is invalid");
  }
  const snapshot = exactRecord(
    record.world_snapshot_ref,
    SNAPSHOT_KEYS,
    "assignment_basis.world_snapshot_ref",
  );
  const memoryHead = exactRecord(
    record.memory_scope_head_ref,
    MEMORY_HEAD_KEYS,
    "assignment_basis.memory_scope_head_ref",
  );
  const basis = canonicalContinuationClone({
    schema_version: SERVING_ASSIGNMENT_BASIS_SCHEMA_V1,
    experiment_cohort_ref: artifactRef(
      record.experiment_cohort_ref,
      "assignment_basis.experiment_cohort_ref",
    ),
    create_continuation_operation_id: text(
      record.create_continuation_operation_id,
      "assignment_basis.create_continuation_operation_id",
    ),
    operation_request_sha256: sha(
      record.operation_request_sha256,
      "assignment_basis.operation_request_sha256",
    ),
    decision_id: text(record.decision_id, "assignment_basis.decision_id"),
    episode_id: text(record.episode_id, "assignment_basis.episode_id"),
    run_id: text(record.run_id, "assignment_basis.run_id"),
    host_task_id: text(record.host_task_id, "assignment_basis.host_task_id"),
    host_task_envelope_sha256: sha(
      record.host_task_envelope_sha256,
      "assignment_basis.host_task_envelope_sha256",
    ),
    host_principal_sha256: sha(
      record.host_principal_sha256,
      "assignment_basis.host_principal_sha256",
    ),
    task_family: text(record.task_family, "assignment_basis.task_family"),
    source_task_sha256: sha(
      record.source_task_sha256,
      "assignment_basis.source_task_sha256",
    ),
    world_snapshot_ref: {
      world_snapshot_id: text(
        snapshot.world_snapshot_id,
        "assignment_basis.world_snapshot_ref.world_snapshot_id",
      ),
      world_snapshot_sha256: sha(
        snapshot.world_snapshot_sha256,
        "assignment_basis.world_snapshot_ref.world_snapshot_sha256",
      ),
    },
    memory_scope_head_ref: {
      revision: positiveInteger(
        memoryHead.revision,
        "assignment_basis.memory_scope_head_ref.revision",
      ),
      head_sha256: sha(
        memoryHead.head_sha256,
        "assignment_basis.memory_scope_head_ref.head_sha256",
      ),
    },
  });
  if (basis.create_continuation_operation_id !== basis.decision_id) {
    fail("assignment basis operation id must equal decision id");
  }
  return basis;
}

function assignmentSeed(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    fail("assignment seed must contain exactly 32 bytes");
  }
  return Buffer.from(value);
}

export function assignmentSeedCommitmentSha256V1(value: Uint8Array): Sha256 {
  return wrap(() => createHash("sha256").update(assignmentSeed(value)).digest("hex"));
}

function assignmentDrawSha256(
  seed: Buffer,
  basis: ServingAssignmentBasisV1,
): Sha256 {
  const cluster = canonicalContinuationClone({
    schema_version: SERVING_ASSIGNMENT_CLUSTER_SCHEMA_V1,
    experiment_cohort_ref: basis.experiment_cohort_ref,
    task_family: basis.task_family,
    source_task_sha256: basis.source_task_sha256,
  });
  return createHmac("sha256", assignmentSeed(seed))
    .update(canonicalContinuationJson(cluster), "utf8")
    .digest("hex");
}

function assignedArm(draw: Sha256, candidateAllocationBps: number): "control" | "candidate" {
  const value = BigInt(`0x${draw}`);
  return value * 10_000n < UINT256_SPACE * BigInt(candidateAllocationBps)
    ? "candidate"
    : "control";
}

function receiptBody(
  value: Omit<ServingAssignmentReceiptV1, "serving_assignment_receipt_sha256">,
): Readonly<Record<string, unknown>> {
  return {
    schema_version: value.schema_version,
    tenant_id: value.tenant_id,
    scope: value.scope,
    cohort_id: value.cohort_id,
    authority_subject_sha256: value.authority_subject_sha256,
    experiment_cohort_ref: value.experiment_cohort_ref,
    arm: value.arm,
    control_learning_ref: value.control_learning_ref,
    candidate_learning_ref: value.candidate_learning_ref,
    served_learning_ref: value.served_learning_ref,
    compiler_policy_ref: value.compiler_policy_ref,
    evidence_policy_ref: value.evidence_policy_ref,
    assignment_basis: value.assignment_basis,
    assignment_basis_sha256: value.assignment_basis_sha256,
    assignment_draw_sha256: value.assignment_draw_sha256,
    assigned_at: value.assigned_at,
  };
}

function parseReceipt(value: unknown): ServingAssignmentReceiptV1 {
  const record = exactRecord(value, RECEIPT_KEYS, "serving assignment receipt");
  if (record.schema_version !== SERVING_ASSIGNMENT_RECEIPT_SCHEMA_V1
    || (record.arm !== "control" && record.arm !== "candidate")) {
    fail("receipt schema_version or arm is invalid");
  }
  const parsedWithoutDigest = {
    schema_version: SERVING_ASSIGNMENT_RECEIPT_SCHEMA_V1,
    tenant_id: text(record.tenant_id, "tenant_id"),
    scope: text(record.scope, "scope"),
    cohort_id: text(record.cohort_id, "cohort_id"),
    authority_subject_sha256: sha(
      record.authority_subject_sha256,
      "authority_subject_sha256",
    ),
    experiment_cohort_ref: artifactRef(
      record.experiment_cohort_ref,
      "experiment_cohort_ref",
    ),
    arm: record.arm,
    control_learning_ref: branchRef(
      record.control_learning_ref,
      "control_learning_ref",
    ) as AuthoritativeBranchRevisionRefV1,
    candidate_learning_ref: branchRef(
      record.candidate_learning_ref,
      "candidate_learning_ref",
    ) as ActiveCandidateBranchRevisionRefV1,
    served_learning_ref: branchRef(record.served_learning_ref, "served_learning_ref"),
    compiler_policy_ref: artifactRef(record.compiler_policy_ref, "compiler_policy_ref"),
    evidence_policy_ref: artifactRef(record.evidence_policy_ref, "evidence_policy_ref"),
    assignment_basis: parseBasis(record.assignment_basis),
    assignment_basis_sha256: sha(
      record.assignment_basis_sha256,
      "assignment_basis_sha256",
    ),
    assignment_draw_sha256: sha(
      record.assignment_draw_sha256,
      "assignment_draw_sha256",
    ),
    assigned_at: time(record.assigned_at, "assigned_at"),
  } as const;
  const supplied = sha(
    record.serving_assignment_receipt_sha256,
    "serving_assignment_receipt_sha256",
  );
  if (canonicalContinuationSha256(receiptBody(parsedWithoutDigest)) !== supplied
    || canonicalSha256Without(
      value as Readonly<Record<string, unknown>>,
      "serving_assignment_receipt_sha256",
    ) !== supplied) {
    fail("serving assignment receipt digest mismatch");
  }
  return canonicalContinuationClone({
    ...parsedWithoutDigest,
    serving_assignment_receipt_sha256: supplied,
  });
}

function assertReceiptAuthority(
  receipt: ServingAssignmentReceiptV1,
  cohort: ExperimentCohortV1,
  cohortRef: AuthorityArtifactRefV1,
  seed: Buffer,
): void {
  const verifiedCohort = verifyExperimentCohortV1(cohort);
  const verifiedRef = artifactRef(cohortRef, "experiment_cohort_ref");
  if (verifiedRef.payload_sha256 !== experimentCohortPayloadSha256V1(verifiedCohort)
    || createHash("sha256").update(seed).digest("hex")
      !== verifiedCohort.assignment_protocol.assignment_seed_commitment_sha256
    || canonicalContinuationJson(receipt.experiment_cohort_ref)
      !== canonicalContinuationJson(verifiedRef)
    || canonicalContinuationJson(receipt.assignment_basis.experiment_cohort_ref)
      !== canonicalContinuationJson(verifiedRef)
    || receipt.tenant_id !== verifiedCohort.tenant_id
    || receipt.scope !== verifiedCohort.scope
    || receipt.cohort_id !== verifiedCohort.cohort_id
    || receipt.authority_subject_sha256 !== verifiedCohort.authority_subject_sha256
    || canonicalContinuationJson(receipt.control_learning_ref)
      !== canonicalContinuationJson(verifiedCohort.control_learning_ref)
    || canonicalContinuationJson(receipt.candidate_learning_ref)
      !== canonicalContinuationJson(verifiedCohort.candidate_learning_ref)
    || canonicalContinuationJson(receipt.compiler_policy_ref)
      !== canonicalContinuationJson(verifiedCohort.compiler_policy_ref)
    || canonicalContinuationJson(receipt.evidence_policy_ref)
      !== canonicalContinuationJson(verifiedCohort.evidence_policy_ref)
    || receipt.assignment_basis_sha256
      !== canonicalContinuationSha256(receipt.assignment_basis)
    || !experimentCohortEligibleV1(
      verifiedCohort,
      receipt.assignment_basis.task_family,
      receipt.assignment_basis.host_principal_sha256,
    )
    || receipt.assigned_at < verifiedCohort.assignment_window_opened_at
    || receipt.assigned_at >= verifiedCohort.assignment_window_closed_at) {
    fail("receipt does not bind the exact eligible cohort authority");
  }
  const draw = assignmentDrawSha256(seed, receipt.assignment_basis);
  const arm = assignedArm(
    draw,
    verifiedCohort.assignment_protocol.candidate_allocation_bps,
  );
  const served = arm === "candidate"
    ? verifiedCohort.candidate_learning_ref
    : verifiedCohort.control_learning_ref;
  if (receipt.assignment_draw_sha256 !== draw
    || receipt.arm !== arm
    || canonicalContinuationJson(receipt.served_learning_ref)
      !== canonicalContinuationJson(served)) {
    fail("receipt draw, arm, or served learning ref is invalid");
  }
}

export function buildServingAssignmentBasisV1(
  value: ServingAssignmentBasisV1,
): ServingAssignmentBasisV1 {
  return wrap(() => parseBasis(value));
}

export function deriveServingAssignmentReceiptV1(args: Readonly<{
  cohort: ExperimentCohortV1;
  experiment_cohort_ref: AuthorityArtifactRefV1;
  assignment_seed: Uint8Array;
  assignment_basis: ServingAssignmentBasisV1;
  assigned_at: string;
}>): ServingAssignmentReceiptV1 {
  return wrap(() => {
    const seed = assignmentSeed(args.assignment_seed);
    const cohort = verifyExperimentCohortV1(args.cohort);
    const cohortRef = artifactRef(args.experiment_cohort_ref, "experiment_cohort_ref");
    const basis = parseBasis(args.assignment_basis);
    const assignedAt = time(args.assigned_at, "assigned_at");
    if (cohortRef.payload_sha256 !== experimentCohortPayloadSha256V1(cohort)
      || canonicalContinuationJson(basis.experiment_cohort_ref)
        !== canonicalContinuationJson(cohortRef)) {
      fail("cohort ref does not bind payload and assignment basis");
    }
    const draw = assignmentDrawSha256(seed, basis);
    const arm = assignedArm(
      draw,
      cohort.assignment_protocol.candidate_allocation_bps,
    );
    const withoutDigest = canonicalContinuationClone({
      schema_version: SERVING_ASSIGNMENT_RECEIPT_SCHEMA_V1,
      tenant_id: cohort.tenant_id,
      scope: cohort.scope,
      cohort_id: cohort.cohort_id,
      authority_subject_sha256: cohort.authority_subject_sha256,
      experiment_cohort_ref: cohortRef,
      arm,
      control_learning_ref: cohort.control_learning_ref,
      candidate_learning_ref: cohort.candidate_learning_ref,
      served_learning_ref: arm === "candidate"
        ? cohort.candidate_learning_ref
        : cohort.control_learning_ref,
      compiler_policy_ref: cohort.compiler_policy_ref,
      evidence_policy_ref: cohort.evidence_policy_ref,
      assignment_basis: basis,
      assignment_basis_sha256: canonicalContinuationSha256(basis),
      assignment_draw_sha256: draw,
      assigned_at: assignedAt,
    });
    const receipt = parseReceipt({
      ...withoutDigest,
      serving_assignment_receipt_sha256: canonicalContinuationSha256(
        receiptBody(withoutDigest),
      ),
    });
    assertReceiptAuthority(
      receipt,
      cohort,
      cohortRef,
      seed,
    );
    return receipt;
  });
}

export function verifyServingAssignmentReceiptV1(
  value: unknown,
  authority: Readonly<{
    cohort: ExperimentCohortV1;
    experiment_cohort_ref: AuthorityArtifactRefV1;
    assignment_seed: Uint8Array;
  }>,
): ServingAssignmentReceiptV1 {
  return wrap(() => {
    const seed = assignmentSeed(authority.assignment_seed);
    const receipt = parseReceipt(value);
    assertReceiptAuthority(
      receipt,
      authority.cohort,
      authority.experiment_cohort_ref,
      seed,
    );
    return receipt;
  });
}

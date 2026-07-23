import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalContinuationSha256,
  type AuthorityArtifactRefV1,
} from "../../src/continuation/contract.js";
import {
  EXPERIMENT_ASSIGNMENT_ALGORITHM_CONTRACT_SHA256_V1,
  buildExperimentCohortV1,
  experimentCohortPayloadSha256V1,
  type ExperimentCohortV1,
} from "../../src/continuation/experiment-cohort.js";
import {
  assignmentSeedCommitmentSha256V1,
  buildServingAssignmentBasisV1,
  deriveServingAssignmentReceiptV1,
  verifyServingAssignmentReceiptV1,
  type ServingAssignmentBasisV1,
} from "../../src/continuation/serving-assignment.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.js";

const TENANT = "tenant-assignment";
const SCOPE = "scope-assignment";
const TASK_FAMILY = "coding";
const SEED = Buffer.alloc(32, 0x5a);
const SUBJECT = continuationAuthoritySubjectSha256V1({
  tenant_id: TENANT,
  scope: SCOPE,
  task_family: TASK_FAMILY,
});

const COHORT = buildExperimentCohortV1({
  schema_version: "experiment_cohort_v1",
  tenant_id: TENANT,
  scope: SCOPE,
  task_family: TASK_FAMILY,
  cohort_id: "cohort-stable-cluster",
  authority_subject_sha256: SUBJECT,
  control_learning_ref: {
    branch_id: "authority-main",
    branch_revision: 1,
    manifest_sha256: "1".repeat(64),
    branch_kind: "authoritative",
    state: "authoritative",
  },
  candidate_learning_ref: {
    branch_id: "candidate-main",
    branch_revision: 2,
    manifest_sha256: "2".repeat(64),
    branch_kind: "candidate",
    state: "active_candidate",
  },
  compiler_policy_ref: {
    artifact_sha256: "3".repeat(64),
    payload_sha256: "4".repeat(64),
  },
  evidence_policy_ref: {
    artifact_sha256: "5".repeat(64),
    payload_sha256: "6".repeat(64),
  },
  eligibility: { host_principal_sha256s: null },
  assignment_protocol: {
    algorithm: "hmac_sha256_threshold_v1",
    algorithm_contract_sha256:
      EXPERIMENT_ASSIGNMENT_ALGORITHM_CONTRACT_SHA256_V1,
    assignment_seed_commitment_sha256:
      assignmentSeedCommitmentSha256V1(SEED),
    basis_schema: "serving_assignment_basis_v1",
    candidate_allocation_bps: 5_000,
  },
  assignment_window_opened_at: "2026-07-23T01:00:00.000Z",
  assignment_window_closed_at: "2026-07-23T02:00:00.000Z",
  outcome_deadline: "2026-07-23T03:00:00.000Z",
  settlement_grace_ms: 60_000,
  settlement_cutoff_at: "2026-07-23T03:01:00.000Z",
});

const COHORT_REF: AuthorityArtifactRefV1 = {
  artifact_sha256: "7".repeat(64),
  payload_sha256: experimentCohortPayloadSha256V1(COHORT),
};

function basis(
  overrides: Partial<ServingAssignmentBasisV1> = {},
): ServingAssignmentBasisV1 {
  return buildServingAssignmentBasisV1({
    schema_version: "serving_assignment_basis_v1",
    experiment_cohort_ref: COHORT_REF,
    create_continuation_operation_id: "decision-a",
    operation_request_sha256: "8".repeat(64),
    decision_id: "decision-a",
    episode_id: "episode-a",
    run_id: "run-a",
    host_task_id: "host-task-a",
    host_task_envelope_sha256: "9".repeat(64),
    host_principal_sha256: "a".repeat(64),
    task_family: TASK_FAMILY,
    source_task_sha256: "b".repeat(64),
    world_snapshot_ref: {
      world_snapshot_id: "snapshot-a",
      world_snapshot_sha256: "c".repeat(64),
    },
    memory_scope_head_ref: {
      revision: 1,
      head_sha256: "d".repeat(64),
    },
    ...overrides,
  });
}

function derive(
  assignmentBasis: ServingAssignmentBasisV1,
): ReturnType<typeof deriveServingAssignmentReceiptV1> {
  return deriveServingAssignmentReceiptV1({
    cohort: COHORT,
    experiment_cohort_ref: COHORT_REF,
    assignment_seed: SEED,
    assignment_basis: assignmentBasis,
    assigned_at: "2026-07-23T01:30:00.000Z",
  });
}

test("one source-task cluster stays on one arm across operation, decision, episode, run, and state changes", () => {
  const first = derive(basis());
  const rerun = derive(basis({
    create_continuation_operation_id: "decision-b",
    operation_request_sha256: "e".repeat(64),
    decision_id: "decision-b",
    episode_id: "episode-b",
    run_id: "run-b",
    host_task_id: "host-task-b",
    host_task_envelope_sha256: "f".repeat(64),
    host_principal_sha256: "0".repeat(64),
    world_snapshot_ref: {
      world_snapshot_id: "snapshot-b",
      world_snapshot_sha256: "1".repeat(64),
    },
    memory_scope_head_ref: {
      revision: 9,
      head_sha256: "2".repeat(64),
    },
  }));

  assert.equal(rerun.assignment_draw_sha256, first.assignment_draw_sha256);
  assert.equal(rerun.arm, first.arm);
  assert.notEqual(rerun.assignment_basis_sha256, first.assignment_basis_sha256);
  assert.notEqual(
    rerun.serving_assignment_receipt_sha256,
    first.serving_assignment_receipt_sha256,
  );
});

test("changing the source-task cluster changes the deterministic assignment draw", () => {
  const first = derive(basis());
  const differentCluster = derive(basis({
    source_task_sha256: "e".repeat(64),
  }));

  assert.notEqual(
    differentCluster.assignment_draw_sha256,
    first.assignment_draw_sha256,
  );
});

test("the full request basis remains tamper-evident even though only the stable cluster drives the draw", () => {
  const receipt = derive(basis());
  const changedBasis = {
    ...receipt.assignment_basis,
    source_task_sha256: "e".repeat(64),
  };
  const {
    serving_assignment_receipt_sha256: _receiptSha256,
    ...receiptWithoutDigest
  } = receipt;
  const forgedBody = {
    ...receiptWithoutDigest,
    assignment_basis: changedBasis,
    assignment_basis_sha256: canonicalContinuationSha256(changedBasis),
  };
  const forged = {
    ...forgedBody,
    serving_assignment_receipt_sha256:
      canonicalContinuationSha256(forgedBody),
  };

  assert.throws(
    () => verifyServingAssignmentReceiptV1(forged, {
      cohort: COHORT as ExperimentCohortV1,
      experiment_cohort_ref: COHORT_REF,
      assignment_seed: SEED,
    }),
    /receipt draw, arm, or served learning ref is invalid/u,
  );
});

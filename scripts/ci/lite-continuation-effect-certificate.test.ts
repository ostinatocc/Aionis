import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  EffectCertificateError,
  buildEffectEvidencePolicyV1,
  buildEffectTreatmentDeltaSetV1,
  buildSignedEffectCertificateV1,
  verifyEffectEvidencePolicyV1,
  verifyEffectTreatmentDeltaSetV1,
  verifySignedEffectCertificateV1,
  type EffectCertificateBuildInputV1,
  type EffectEvidencePolicyArtifactBindingV1,
} from "../../src/continuation/effect-certificate.js";
import {
  EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  EFFECT_VERIFIER_CONTRACT_SHA256_V1,
} from "../../src/continuation/effect-evaluation.js";
import {
  buildEffectEvidenceMemberSetV1,
  type EffectEvidenceMemberInputV1,
} from "../../src/continuation/episode.js";
import {
  EXPERIMENT_ASSIGNMENT_ALGORITHM_CONTRACT_SHA256_V1,
  buildExperimentCohortV1,
  experimentCohortPayloadSha256V1,
} from "../../src/continuation/experiment-cohort.js";
import { assignmentSeedCommitmentSha256V1 } from
  "../../src/continuation/serving-assignment.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.js";
import {
  canonicalContinuationJson,
  canonicalContinuationSha256,
} from "../../src/continuation/contract.js";

const VERIFIER_KEYS = generateKeyPairSync("ed25519");
const OTHER_VERIFIER_KEYS = generateKeyPairSync("ed25519");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const POLICY_ROOT = "e".repeat(64);
const TENANT_ID = "tenant-a";
const SCOPE = "scope-a";
const TASK_FAMILY = "coding";
const SUBJECT = continuationAuthoritySubjectSha256V1({
  tenant_id: TENANT_ID,
  scope: SCOPE,
  task_family: TASK_FAMILY,
});
const ASSIGNMENT_SEED = Buffer.alloc(32, 7);
const ASSIGNMENT_SEED_REVEAL = ASSIGNMENT_SEED.toString("base64url");

function principalFor(privateKey = VERIFIER_KEYS.privateKey): string {
  const publicKey = createPublicKey(privateKey);
  return createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
}

function policyBinding(
  trusted = [principalFor()],
  overrides: Readonly<Record<string, unknown>> = {},
): EffectEvidencePolicyArtifactBindingV1 {
  const payload = buildEffectEvidencePolicyV1({
    schema_version: "effect_evidence_policy_v1",
    tenant_id: TENANT_ID,
    authority_subject_sha256: SUBJECT,
    trusted_effect_verifier_principals: trusted,
    max_eligible_decisions: 4_096,
    max_treatment_delta_count: 8,
    min_evidence_window_ms: 60_000,
    max_evidence_window_ms: 86_400_000,
    min_control_exposures: 10,
    min_candidate_exposures: 10,
    max_missingness_bps: 0,
    harm_noninferiority_margin_bps: 0,
    utility_min_lift_bps: 1,
    confidence_bps: 9_000,
    effect_verifier_contract_sha256: EFFECT_VERIFIER_CONTRACT_SHA256_V1,
    statistical_contract_sha256: EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
    ...overrides,
  });
  return {
    artifact_ref: {
      artifact_sha256: SHA_C,
      payload_sha256: canonicalContinuationSha256(payload),
    },
    trust_root_sha256: POLICY_ROOT,
    payload,
  };
}

function cohort(binding = policyBinding()) {
  return buildExperimentCohortV1({
    schema_version: "experiment_cohort_v1",
    tenant_id: TENANT_ID,
    scope: SCOPE,
    task_family: TASK_FAMILY,
    cohort_id: "cohort-a",
    authority_subject_sha256: SUBJECT,
    control_learning_ref: {
      branch_id: "authority-main",
      branch_revision: 3,
      manifest_sha256: SHA_A,
      branch_kind: "authoritative",
      state: "authoritative",
    },
    candidate_learning_ref: {
      branch_id: "candidate-main",
      branch_revision: 4,
      manifest_sha256: SHA_B,
      branch_kind: "candidate",
      state: "active_candidate",
    },
    compiler_policy_ref: { artifact_sha256: SHA_A, payload_sha256: SHA_B },
    evidence_policy_ref: binding.artifact_ref,
    eligibility: { host_principal_sha256s: null },
    assignment_protocol: {
      algorithm: "hmac_sha256_threshold_v1",
      algorithm_contract_sha256:
        EXPERIMENT_ASSIGNMENT_ALGORITHM_CONTRACT_SHA256_V1,
      assignment_seed_commitment_sha256:
        assignmentSeedCommitmentSha256V1(ASSIGNMENT_SEED),
      basis_schema: "serving_assignment_basis_v1",
      candidate_allocation_bps: 5_000,
    },
    assignment_window_opened_at: "2026-07-21T10:00:00.000Z",
    assignment_window_closed_at: "2026-07-21T10:30:00.000Z",
    outcome_deadline: "2026-07-21T11:00:00.000Z",
    settlement_grace_ms: 60_000,
    settlement_cutoff_at: "2026-07-21T11:01:00.000Z",
  });
}

function member(index: number): EffectEvidenceMemberInputV1 {
  const decisionId = `decision-${index.toString().padStart(3, "0")}`;
  return {
    scope: SCOPE,
    episode_id: `episode-${index.toString().padStart(3, "0")}`,
    decision_id: decisionId,
    terminal_event: {
      event_sequence: 3,
      event_id: `outcome-${decisionId}`,
      event_kind: "outcome_observed",
      event_sha256: canonicalContinuationSha256({ decision_id: decisionId }),
    },
  };
}

function evidenceMembers(count = 40) {
  return buildEffectEvidenceMemberSetV1(
    Array.from({ length: count }, (_, index) => member(index)),
  );
}

function binding(
  authority: "candidate" | "authoritative",
  revision: number,
  digest: string,
) {
  return {
    capsule_scope: SCOPE,
    capsule: {
      capsule_id: "procedure-a",
      capsule_revision: revision,
      capsule_sha256: digest,
    },
    disposition: "include" as const,
    admission_authority: authority,
  };
}

function treatmentDelta() {
  return buildEffectTreatmentDeltaSetV1([{
    capsule_scope: SCOPE,
    capsule_id: "procedure-a",
    change_kind: "changed",
    before_binding: binding("authoritative", 1, SHA_A),
    after_binding: binding("candidate", 2, SHA_B),
  }]);
}

function buildInput(
  overrides: Partial<EffectCertificateBuildInputV1> = {},
): EffectCertificateBuildInputV1 {
  const evidencePolicy = overrides.evidence_policy ?? policyBinding();
  const experimentCohort = overrides.experiment_cohort ?? cohort(evidencePolicy);
  return {
    tenant_id: TENANT_ID,
    certificate_id: "effect-certificate-a",
    experiment_cohort_ref: {
      artifact_sha256: SHA_D,
      payload_sha256: experimentCohortPayloadSha256V1(experimentCohort),
    },
    experiment_cohort: experimentCohort,
    experiment_cohort_installation_receipt_sha256: SHA_C,
    assignment_seed_reveal_base64url: ASSIGNMENT_SEED_REVEAL,
    evidence_policy: evidencePolicy,
    eligible_decision_set: evidenceMembers(),
    arm_observations: {
      control: {
        assigned_exposure_count: 20,
        succeeded_count: 0,
        partial_count: 0,
        failed_count: 20,
        unknown_count: 0,
        missing_outcome_count: 0,
      },
      candidate: {
        assigned_exposure_count: 20,
        succeeded_count: 20,
        partial_count: 0,
        failed_count: 0,
        unknown_count: 0,
        missing_outcome_count: 0,
      },
    },
    treatment_delta_set: treatmentDelta(),
    created_at: "2026-07-21T11:01:00.000Z",
    ...overrides,
  };
}

function mutable<T>(value: T): any {
  return JSON.parse(JSON.stringify(value));
}

function assertEffectFailure(
  operation: () => unknown,
  code?: EffectCertificateError["code"],
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof EffectCertificateError);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

test("effect certificate binds root policy, cohort, seed and a derived A/B result", () => {
  const input = buildInput();
  const signed = buildSignedEffectCertificateV1(input, VERIFIER_KEYS.privateKey);
  const expectedPrincipal = principalFor();
  assert.equal(signed.verifier_principal_sha256, expectedPrincipal);
  assert.equal(signed.trust_root_sha256, POLICY_ROOT);
  assert.equal(signed.assignment_seed_reveal_base64url, ASSIGNMENT_SEED_REVEAL);
  assert.equal(signed.admission_state, "admitted");
  assert.equal(signed.harm_conclusion, "safe");
  assert.equal(signed.utility_conclusion, "beneficial");
  assert.equal(signed.treatment_delta_count, 1);
  assert.equal("eligible_decision_set" in signed, false);
  assert.equal("treatment_delta_set" in signed, false);
  assert.deepEqual(verifySignedEffectCertificateV1(
    signed,
    input.evidence_policy,
    input.eligible_decision_set,
    input.treatment_delta_set,
  ), signed);
});

test("treatment delta is canonical and exact before/after authority is authenticated", () => {
  const added = {
    capsule_scope: "scope-z",
    capsule_id: "procedure-z",
    change_kind: "added" as const,
    before_binding: null,
    after_binding: {
      capsule_scope: "scope-z",
      capsule: { capsule_id: "procedure-z", capsule_revision: 1, capsule_sha256: SHA_C },
      disposition: "include" as const,
      admission_authority: "candidate" as const,
    },
  };
  const changed = treatmentDelta().members[0]!;
  const first = buildEffectTreatmentDeltaSetV1([added, {
    capsule_scope: changed.capsule_scope,
    capsule_id: changed.capsule_id,
    change_kind: changed.change_kind,
    before_binding: changed.before_binding,
    after_binding: changed.after_binding,
  }]);
  const second = buildEffectTreatmentDeltaSetV1([{
    capsule_scope: changed.capsule_scope,
    capsule_id: changed.capsule_id,
    change_kind: changed.change_kind,
    before_binding: changed.before_binding,
    after_binding: changed.after_binding,
  }, added]);
  assert.deepEqual(first, second);
  assert.deepEqual(verifyEffectTreatmentDeltaSetV1(first), first);
  assert.equal(first.treatment_delta_set_sha256,
    canonicalContinuationSha256(first.members));

  assertEffectFailure(() => buildEffectTreatmentDeltaSetV1([{
    capsule_scope: SCOPE,
    capsule_id: "procedure-a",
    change_kind: "added",
    before_binding: binding("authoritative", 1, SHA_A),
    after_binding: binding("candidate", 2, SHA_B),
  }]));
  const tampered = mutable(first);
  tampered.members[0].after_binding.capsule.capsule_sha256 = SHA_D;
  assertEffectFailure(
    () => verifyEffectTreatmentDeltaSetV1(tampered),
    "treatment_delta_digest_mismatch",
  );
});

test("caller cannot choose conclusions and policy bounds the whole treatment", () => {
  const policy = policyBinding();
  assert.deepEqual(verifyEffectEvidencePolicyV1(policy.payload), policy.payload);
  assert.equal(policy.payload.effect_verifier_contract_sha256,
    EFFECT_VERIFIER_CONTRACT_SHA256_V1);
  assert.equal(policy.payload.statistical_contract_sha256,
    EFFECT_STATISTICAL_CONTRACT_SHA256_V1);

  const injected = mutable(buildInput());
  injected.admission_state = "rejected";
  assertEffectFailure(() => buildSignedEffectCertificateV1(
    injected,
    VERIFIER_KEYS.privateKey,
  ));

  const tooSmall = policyBinding([principalFor()], {
    max_treatment_delta_count: 1,
  });
  const two = buildEffectTreatmentDeltaSetV1([
    {
      capsule_scope: SCOPE,
      capsule_id: "procedure-a",
      change_kind: "changed",
      before_binding: binding("authoritative", 1, SHA_A),
      after_binding: binding("candidate", 2, SHA_B),
    },
    {
      capsule_scope: "scope-z",
      capsule_id: "procedure-z",
      change_kind: "added",
      before_binding: null,
      after_binding: {
        capsule_scope: "scope-z",
        capsule: { capsule_id: "procedure-z", capsule_revision: 1, capsule_sha256: SHA_C },
        disposition: "include",
        admission_authority: "candidate",
      },
    },
  ]);
  assertEffectFailure(() => buildSignedEffectCertificateV1(buildInput({
    evidence_policy: tooSmall,
    experiment_cohort: cohort(tooSmall),
    treatment_delta_set: two,
  }), VERIFIER_KEYS.privateKey), "policy_binding_mismatch");
});

test("verification rejects evidence, delta, key, signature and header substitution", () => {
  const input = buildInput();
  const signed = buildSignedEffectCertificateV1(input, VERIFIER_KEYS.privateKey);
  const changedEvidence = evidenceMembers(39);
  assertEffectFailure(() => verifySignedEffectCertificateV1(
    signed, input.evidence_policy, changedEvidence, input.treatment_delta_set,
  ), "evidence_member_digest_mismatch");

  const emptyDelta = buildEffectTreatmentDeltaSetV1([]);
  assertEffectFailure(() => verifySignedEffectCertificateV1(
    signed, input.evidence_policy, input.eligible_decision_set, emptyDelta,
  ), "treatment_delta_digest_mismatch");

  const signatureTamper = mutable(signed);
  const signature = Buffer.from(signatureTamper.signature, "base64url");
  signature[0] ^= 1;
  signatureTamper.signature = signature.toString("base64url");
  assertEffectFailure(() => verifySignedEffectCertificateV1(
    signatureTamper,
    input.evidence_policy,
    input.eligible_decision_set,
    input.treatment_delta_set,
  ), "signature_invalid");

  const keyTamper = mutable(signed);
  keyTamper.verifier_public_key_spki_base64url =
    createPublicKey(OTHER_VERIFIER_KEYS.privateKey)
      .export({ format: "der", type: "spki" }).toString("base64url");
  assertEffectFailure(() => verifySignedEffectCertificateV1(
    keyTamper,
    input.evidence_policy,
    input.eligible_decision_set,
    input.treatment_delta_set,
  ));

  const headerTamper = mutable(signed);
  headerTamper.effect_evaluation.admission_state = "rejected";
  assertEffectFailure(() => verifySignedEffectCertificateV1(
    headerTamper,
    input.evidence_policy,
    input.eligible_decision_set,
    input.treatment_delta_set,
  ));
  assert.equal(canonicalContinuationJson(signed).includes("effect_claim"), false);
});

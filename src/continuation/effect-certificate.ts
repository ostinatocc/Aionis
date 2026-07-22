import {
  createHash,
  createPublicKey,
  sign as signDetached,
  verify as verifyDetached,
  type KeyObject,
} from "node:crypto";

import type {
  AuthorityBranchCapsuleBindingV1,
  AuthoritativeBranchRevisionRefV1,
  AuthorityBranchRevisionRefV1,
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
import {
  verifyEffectEvidenceMemberSetV1,
  type EffectEvidenceMemberSetV1,
} from "./episode.js";
import {
  EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  EFFECT_VERIFIER_CONTRACT_SHA256_V1,
  evaluateEffectEvidenceV1,
  type EffectAdmissionPolicyV1,
  type EffectArmObservationCountsV1,
  type EffectEvidenceEvaluationV1,
} from "./effect-evaluation.js";
import {
  experimentCohortPayloadSha256V1,
  verifyExperimentCohortV1,
  type ExperimentCohortV1,
} from "./experiment-cohort.js";
import { assignmentSeedCommitmentSha256V1 } from "./serving-assignment.js";

export type EffectEvidencePolicyV1 = Readonly<{
  schema_version: "effect_evidence_policy_v1";
  tenant_id: string;
  authority_subject_sha256: Sha256 | null;
  trusted_effect_verifier_principals: readonly Sha256[];
  max_eligible_decisions: number;
  min_evidence_window_ms: number;
  max_evidence_window_ms: number;
  max_treatment_delta_count: number;
  min_control_exposures: number;
  min_candidate_exposures: number;
  max_missingness_bps: number;
  harm_noninferiority_margin_bps: number;
  utility_min_lift_bps: number;
  confidence_bps: EffectAdmissionPolicyV1["confidence_bps"];
  effect_verifier_contract_sha256: Sha256;
  statistical_contract_sha256: Sha256;
}>;

/**
 * Structural payload/ref projection supplied alongside an installed policy.
 * Possessing this plain DTO grants no authority. The store owns the private
 * verified capability after authenticating the root-signed artifact; this
 * module only rechecks that the expected installed payload and ref agree.
 */
export type EffectEvidencePolicyArtifactBindingV1 = Readonly<{
  artifact_ref: AuthorityArtifactRefV1;
  trust_root_sha256: Sha256;
  payload: EffectEvidencePolicyV1;
}>;

export type EffectTreatmentDeltaMemberInputV1 = Readonly<{
  capsule_scope: string;
  capsule_id: string;
  change_kind: "added" | "removed" | "changed";
  before_binding: AuthorityBranchCapsuleBindingV1 | null;
  after_binding: AuthorityBranchCapsuleBindingV1 | null;
}>;

export type EffectTreatmentDeltaMemberV1 = EffectTreatmentDeltaMemberInputV1 & Readonly<{
  member_sequence: number;
  member_sha256: Sha256;
}>;

export type EffectTreatmentDeltaSetV1 = Readonly<{
  schema_version: "effect_treatment_delta_set_v1";
  members: readonly EffectTreatmentDeltaMemberV1[];
  treatment_delta_count: number;
  treatment_delta_set_sha256: Sha256;
}>;

export type EffectCertificateBuildInputV1 = Readonly<{
  tenant_id: string;
  certificate_id: string;
  experiment_cohort_ref: AuthorityArtifactRefV1;
  experiment_cohort: ExperimentCohortV1;
  experiment_cohort_installation_receipt_sha256: Sha256;
  assignment_seed_reveal_base64url: string;
  evidence_policy: EffectEvidencePolicyArtifactBindingV1;
  eligible_decision_set: EffectEvidenceMemberSetV1;
  arm_observations: Readonly<{
    control: EffectArmObservationCountsV1;
    candidate: EffectArmObservationCountsV1;
  }>;
  treatment_delta_set: EffectTreatmentDeltaSetV1;
  created_at: string;
}>;

export type EffectCertificateEnvelopeV1 = Readonly<{
  schema_version: "effect_certificate_v1";
  tenant_id: string;
  certificate_id: string;
  authority_subject_sha256: Sha256;
  experiment_cohort_ref: AuthorityArtifactRefV1;
  experiment_cohort: ExperimentCohortV1;
  experiment_cohort_installation_receipt_sha256: Sha256;
  assignment_seed_reveal_base64url: string;
  assignment_seed_commitment_sha256: Sha256;
  control_branch_ref: AuthoritativeBranchRevisionRefV1;
  candidate_branch_ref: AuthorityBranchRevisionRefV1 & Readonly<{
    branch_kind: "candidate";
    state: "active_candidate";
  }>;
  compiler_policy_ref: AuthorityArtifactRefV1;
  evidence_policy_ref: AuthorityArtifactRefV1;
  evidence_window_sha256: Sha256;
  window_opened_at: string;
  window_closed_at: string;
  eligible_decision_count: number;
  eligible_decision_set_sha256: Sha256;
  missingness_bps: number;
  harm_conclusion: "safe" | "harmful" | "inconclusive";
  utility_conclusion: "beneficial" | "neutral" | "harmful" | "inconclusive";
  admission_state: "admitted" | "rejected";
  effect_evaluation: EffectEvidenceEvaluationV1;
  effect_evaluation_sha256: Sha256;
  treatment_delta_count: number;
  treatment_delta_set_sha256: Sha256;
  effect_verifier_contract_sha256: Sha256;
  statistical_contract_sha256: Sha256;
  verifier_principal_sha256: Sha256;
  verifier_public_key_spki_base64url: string;
  trust_root_sha256: Sha256;
  signature_algorithm: "ed25519";
  created_at: string;
  certificate_sha256: Sha256;
}>;

export type SignedEffectCertificateV1 = EffectCertificateEnvelopeV1 & Readonly<{
  signature: string;
}>;

export type EffectCertificateErrorCode =
  | "invalid_effect_certificate"
  | "invalid_effect_policy"
  | "invalid_ed25519_key"
  | "evidence_member_digest_mismatch"
  | "treatment_delta_digest_mismatch"
  | "certificate_digest_mismatch"
  | "policy_binding_mismatch"
  | "signature_invalid";

export class EffectCertificateError extends Error {
  readonly code: EffectCertificateErrorCode;

  constructor(code: EffectCertificateErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "EffectCertificateError";
    this.code = code;
  }
}

const MAX_TREATMENT_DELTA_MEMBERS = 256;
const MAX_ELIGIBLE_DECISIONS = 4_096;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const CANONICAL_SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;

const POLICY_KEYS = Object.freeze([
  "authority_subject_sha256",
  "confidence_bps",
  "effect_verifier_contract_sha256",
  "harm_noninferiority_margin_bps",
  "max_eligible_decisions",
  "max_evidence_window_ms",
  "max_missingness_bps",
  "max_treatment_delta_count",
  "min_candidate_exposures",
  "min_control_exposures",
  "min_evidence_window_ms",
  "schema_version",
  "statistical_contract_sha256",
  "tenant_id",
  "trusted_effect_verifier_principals",
  "utility_min_lift_bps",
] as const);
const VERIFIED_POLICY_KEYS = Object.freeze([
  "artifact_ref", "payload", "trust_root_sha256",
] as const);
const ARTIFACT_REF_KEYS = Object.freeze([
  "artifact_sha256", "payload_sha256",
] as const);
const TREATMENT_MEMBER_INPUT_KEYS = Object.freeze([
  "after_binding",
  "before_binding",
  "capsule_id",
  "capsule_scope",
  "change_kind",
] as const);
const TREATMENT_MEMBER_KEYS = Object.freeze([
  ...TREATMENT_MEMBER_INPUT_KEYS, "member_sequence", "member_sha256",
] as const);
const TREATMENT_SET_KEYS = Object.freeze([
  "members", "schema_version", "treatment_delta_count",
  "treatment_delta_set_sha256",
] as const);
const AUTHORITY_BINDING_KEYS = Object.freeze([
  "admission_authority", "capsule", "capsule_scope", "disposition",
] as const);
const CAPSULE_REF_KEYS = Object.freeze([
  "capsule_id", "capsule_revision", "capsule_sha256",
] as const);
const ARM_OBSERVATION_KEYS = Object.freeze([
  "assigned_exposure_count", "failed_count", "missing_outcome_count",
  "partial_count", "succeeded_count", "unknown_count",
] as const);
const ARM_OBSERVATIONS_KEYS = Object.freeze(["candidate", "control"] as const);
const BUILD_INPUT_KEYS = Object.freeze([
  "arm_observations",
  "assignment_seed_reveal_base64url",
  "certificate_id",
  "created_at",
  "eligible_decision_set",
  "evidence_policy",
  "experiment_cohort",
  "experiment_cohort_installation_receipt_sha256",
  "experiment_cohort_ref",
  "tenant_id",
  "treatment_delta_set",
] as const);
const ENVELOPE_KEYS = Object.freeze([
  "admission_state",
  "authority_subject_sha256",
  "assignment_seed_commitment_sha256",
  "assignment_seed_reveal_base64url",
  "candidate_branch_ref",
  "certificate_id",
  "certificate_sha256",
  "compiler_policy_ref",
  "control_branch_ref",
  "created_at",
  "effect_verifier_contract_sha256",
  "effect_evaluation",
  "effect_evaluation_sha256",
  "eligible_decision_count",
  "eligible_decision_set_sha256",
  "evidence_policy_ref",
  "evidence_window_sha256",
  "experiment_cohort",
  "experiment_cohort_installation_receipt_sha256",
  "experiment_cohort_ref",
  "harm_conclusion",
  "missingness_bps",
  "schema_version",
  "signature_algorithm",
  "statistical_contract_sha256",
  "tenant_id",
  "trust_root_sha256",
  "treatment_delta_count",
  "treatment_delta_set_sha256",
  "utility_conclusion",
  "verifier_principal_sha256",
  "verifier_public_key_spki_base64url",
  "window_closed_at",
  "window_opened_at",
] as const);
const SIGNED_KEYS = Object.freeze([...ENVELOPE_KEYS, "signature"] as const);

function fail(code: EffectCertificateErrorCode, message: string): never {
  throw new EffectCertificateError(code, message);
}

function wrapInvalid<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof EffectCertificateError) throw error;
    fail(
      "invalid_effect_certificate",
      error instanceof Error ? error.message : "effect certificate validation failed",
    );
  }
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_effect_certificate", `${field} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid_effect_certificate", `${field} must be a plain record`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    fail("invalid_effect_certificate", `${field} must contain only string-keyed data properties`);
  }
  const actual = ownKeys as string[];
  const expected = new Set(expectedKeys);
  if (actual.length !== expectedKeys.length
    || actual.some((key) => !expected.has(key))
    || expectedKeys.some((key) => !actual.includes(key))) {
    fail("invalid_effect_certificate", `${field} contains unknown or missing fields`);
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of actual) {
    assertUnicodeScalarString(key, `${field} key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("invalid_effect_certificate", `${field} must contain only enumerable data properties`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactArray(value: unknown, maximum: number, field: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail("invalid_effect_certificate", `${field} must be a plain array`);
  }
  if (value.length > maximum) {
    fail("invalid_effect_certificate", `${field} exceeds ${maximum} entries`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = new Set<string>(["length"]);
  for (let index = 0; index < value.length; index += 1) expected.add(String(index));
  if (keys.some((key) => typeof key !== "string" || !expected.has(key))
    || keys.length !== expected.size) {
    fail("invalid_effect_certificate", `${field} must be dense and contain no extra properties`);
  }
  const out: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("invalid_effect_certificate", `${field} must contain only enumerable data elements`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function text(value: unknown, field: string, maxBytes = 256): string {
  if (typeof value !== "string") fail("invalid_effect_certificate", `${field} must be text`);
  assertUnicodeScalarString(value, field);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    fail("invalid_effect_certificate", `${field} is not bounded canonical UTF-8 text`);
  }
  return value;
}

function sha256(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") fail("invalid_effect_certificate", `${field} must be a digest`);
  assertSha256(value, field);
  return value;
}

function nullableSha256(value: unknown, field: string): Sha256 | null {
  return value === null ? null : sha256(value, field);
}

function positiveInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    fail("invalid_effect_certificate", `${field} must be a positive bounded safe integer`);
  }
  return value as number;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value)
    || (value as number) < minimum || (value as number) > maximum) {
    fail("invalid_effect_certificate", `${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string") fail("invalid_effect_certificate", `${field} must be a timestamp`);
  assertCanonicalUtcMillis(value, field);
  return value;
}

function artifactRef(value: unknown, field: string): AuthorityArtifactRefV1 {
  const record = exactRecord(value, ARTIFACT_REF_KEYS, field);
  return {
    artifact_sha256: sha256(record.artifact_sha256, `${field}.artifact_sha256`),
    payload_sha256: sha256(record.payload_sha256, `${field}.payload_sha256`),
  };
}

function parsePolicy(value: unknown): EffectEvidencePolicyV1 {
  const record = exactRecord(value, POLICY_KEYS, "effect evidence policy");
  if (record.schema_version !== "effect_evidence_policy_v1") {
    fail("invalid_effect_policy", "effect evidence policy schema_version is invalid");
  }
  const principals = exactArray(
    record.trusted_effect_verifier_principals,
    64,
    "trusted_effect_verifier_principals",
  ).map((principal, index) => sha256(principal, `trusted verifier ${index}`));
  const sorted = [...principals].sort(compareCanonicalUtf8);
  if (sorted.some((principal, index) => index > 0 && principal === sorted[index - 1])) {
    fail("invalid_effect_policy", "trusted verifier principals contain duplicates");
  }
  if (canonicalContinuationJson(principals) !== canonicalContinuationJson(sorted)) {
    fail("invalid_effect_policy", "trusted verifier principals must be canonically ordered");
  }
  if (sorted.length === 0) {
    fail("invalid_effect_policy", "effect evidence policy requires a trusted verifier");
  }
  const minimumWindow = positiveInteger(
    record.min_evidence_window_ms,
    "min_evidence_window_ms",
    MAX_WINDOW_MS,
  );
  const maximumWindow = positiveInteger(
    record.max_evidence_window_ms,
    "max_evidence_window_ms",
    MAX_WINDOW_MS,
  );
  if (minimumWindow > maximumWindow) {
    fail("invalid_effect_policy", "minimum evidence window exceeds maximum");
  }
  const maximumDecisions = positiveInteger(
    record.max_eligible_decisions,
    "max_eligible_decisions",
    MAX_ELIGIBLE_DECISIONS,
  );
  const minControl = positiveInteger(
    record.min_control_exposures,
    "min_control_exposures",
    MAX_ELIGIBLE_DECISIONS,
  );
  const minCandidate = positiveInteger(
    record.min_candidate_exposures,
    "min_candidate_exposures",
    MAX_ELIGIBLE_DECISIONS,
  );
  if (minControl + minCandidate > maximumDecisions) {
    fail("invalid_effect_policy", "minimum arm exposures exceed maximum decisions");
  }
  const confidence = boundedInteger(record.confidence_bps, "confidence_bps", 9_000, 9_900);
  if (confidence !== 9_000 && confidence !== 9_500 && confidence !== 9_900) {
    fail("invalid_effect_policy", "confidence_bps is not a supported closed threshold");
  }
  const effectContract = sha256(
    record.effect_verifier_contract_sha256,
    "effect_verifier_contract_sha256",
  );
  const statisticalContract = sha256(
    record.statistical_contract_sha256,
    "statistical_contract_sha256",
  );
  if (effectContract !== EFFECT_VERIFIER_CONTRACT_SHA256_V1
    || statisticalContract !== EFFECT_STATISTICAL_CONTRACT_SHA256_V1) {
    fail("invalid_effect_policy", "effect policy must bind the built-in verifier contracts");
  }
  return canonicalContinuationClone({
    schema_version: "effect_evidence_policy_v1" as const,
    tenant_id: text(record.tenant_id, "policy.tenant_id"),
    authority_subject_sha256: nullableSha256(
      record.authority_subject_sha256,
      "policy.authority_subject_sha256",
    ),
    trusted_effect_verifier_principals: sorted,
    max_eligible_decisions: maximumDecisions,
    max_treatment_delta_count: positiveInteger(
      record.max_treatment_delta_count,
      "max_treatment_delta_count",
      MAX_TREATMENT_DELTA_MEMBERS,
    ),
    min_evidence_window_ms: minimumWindow,
    max_evidence_window_ms: maximumWindow,
    min_control_exposures: minControl,
    min_candidate_exposures: minCandidate,
    max_missingness_bps: boundedInteger(
      record.max_missingness_bps,
      "max_missingness_bps",
      0,
      10_000,
    ),
    harm_noninferiority_margin_bps: boundedInteger(
      record.harm_noninferiority_margin_bps,
      "harm_noninferiority_margin_bps",
      0,
      10_000,
    ),
    utility_min_lift_bps: boundedInteger(
      record.utility_min_lift_bps,
      "utility_min_lift_bps",
      0,
      10_000,
    ),
    confidence_bps: confidence,
    effect_verifier_contract_sha256: effectContract,
    statistical_contract_sha256: statisticalContract,
  });
}

export function buildEffectEvidencePolicyV1(value: EffectEvidencePolicyV1): EffectEvidencePolicyV1 {
  return wrapInvalid(() => parsePolicy(value));
}

export function verifyEffectEvidencePolicyV1(value: unknown): EffectEvidencePolicyV1 {
  return wrapInvalid(() => parsePolicy(value));
}

function policyArtifactBinding(value: unknown): EffectEvidencePolicyArtifactBindingV1 {
  const record = exactRecord(value, VERIFIED_POLICY_KEYS, "verified evidence policy");
  const ref = artifactRef(record.artifact_ref, "verified evidence policy artifact_ref");
  const payload = parsePolicy(record.payload);
  if (canonicalContinuationSha256(payload) !== ref.payload_sha256) {
    fail("policy_binding_mismatch", "evidence policy payload does not match its authenticated ref");
  }
  return canonicalContinuationClone({
    artifact_ref: ref,
    trust_root_sha256: sha256(record.trust_root_sha256, "policy trust_root_sha256"),
    payload,
  });
}

function treatmentBinding(
  value: unknown,
  field: string,
): AuthorityBranchCapsuleBindingV1 | null {
  if (value === null) return null;
  const record = exactRecord(value, AUTHORITY_BINDING_KEYS, field);
  const capsule = exactRecord(record.capsule, CAPSULE_REF_KEYS, `${field}.capsule`);
  if (record.disposition !== "include" && record.disposition !== "exclude"
    && record.disposition !== "prohibit") {
    fail("invalid_effect_certificate", `${field}.disposition is not closed`);
  }
  if (record.admission_authority !== "candidate"
    && record.admission_authority !== "authoritative") {
    fail("invalid_effect_certificate", `${field}.admission_authority is not closed`);
  }
  return canonicalContinuationClone({
    capsule_scope: text(record.capsule_scope, `${field}.capsule_scope`),
    capsule: {
      capsule_id: text(capsule.capsule_id, `${field}.capsule.capsule_id`),
      capsule_revision: positiveInteger(
        capsule.capsule_revision,
        `${field}.capsule.capsule_revision`,
      ),
      capsule_sha256: sha256(
        capsule.capsule_sha256,
        `${field}.capsule.capsule_sha256`,
      ),
    },
    disposition: record.disposition,
    admission_authority: record.admission_authority,
  });
}

function treatmentMemberInput(value: unknown): EffectTreatmentDeltaMemberInputV1 {
  const record = exactRecord(
    value,
    TREATMENT_MEMBER_INPUT_KEYS,
    "effect treatment delta member input",
  );
  const scope = text(record.capsule_scope, "treatment.capsule_scope");
  const capsuleId = text(record.capsule_id, "treatment.capsule_id");
  const before = treatmentBinding(record.before_binding, "treatment.before_binding");
  const after = treatmentBinding(record.after_binding, "treatment.after_binding");
  const kind = record.change_kind;
  if (kind !== "added" && kind !== "removed" && kind !== "changed") {
    fail("invalid_effect_certificate", "treatment change_kind is not closed");
  }
  if ((before !== null
      && (before.capsule_scope !== scope || before.capsule.capsule_id !== capsuleId))
    || (after !== null
      && (after.capsule_scope !== scope || after.capsule.capsule_id !== capsuleId))
    || (kind === "added" && (before !== null || after === null))
    || (kind === "removed" && (before === null || after !== null))
    || (kind === "changed" && (before === null || after === null
      || canonicalContinuationJson(before) === canonicalContinuationJson(after)))) {
    fail("invalid_effect_certificate", "treatment delta member binding is inconsistent");
  }
  return canonicalContinuationClone({
    capsule_scope: scope,
    capsule_id: capsuleId,
    change_kind: kind,
    before_binding: before,
    after_binding: after,
  });
}

function treatmentIdentity(value: EffectTreatmentDeltaMemberInputV1): string {
  return canonicalContinuationJson([value.capsule_scope, value.capsule_id]);
}

function assembleTreatmentDeltaSet(
  inputs: readonly EffectTreatmentDeltaMemberInputV1[],
): EffectTreatmentDeltaSetV1 {
  const sorted = [...inputs].sort((left, right) =>
    compareCanonicalUtf8(treatmentIdentity(left), treatmentIdentity(right))
  );
  for (let index = 1; index < sorted.length; index += 1) {
    if (treatmentIdentity(sorted[index - 1]!) === treatmentIdentity(sorted[index]!)) {
      fail("invalid_effect_certificate", "treatment delta contains a duplicate identity");
    }
  }
  const members = sorted.map((member, index): EffectTreatmentDeltaMemberV1 => {
    const body = { ...member, member_sequence: index + 1 };
    return { ...body, member_sha256: canonicalContinuationSha256(body) };
  });
  return canonicalContinuationClone({
    schema_version: "effect_treatment_delta_set_v1" as const,
    members,
    treatment_delta_count: members.length,
    treatment_delta_set_sha256: canonicalContinuationSha256(members),
  });
}

export function buildEffectTreatmentDeltaSetV1(
  values: readonly EffectTreatmentDeltaMemberInputV1[],
): EffectTreatmentDeltaSetV1 {
  return wrapInvalid(() => assembleTreatmentDeltaSet(
    exactArray(
      values,
      MAX_TREATMENT_DELTA_MEMBERS,
      "effect treatment delta members",
    ).map(treatmentMemberInput),
  ));
}

export function verifyEffectTreatmentDeltaSetV1(
  value: unknown,
): EffectTreatmentDeltaSetV1 {
  return wrapInvalid(() => {
    const record = exactRecord(value, TREATMENT_SET_KEYS, "effect treatment delta set");
    if (record.schema_version !== "effect_treatment_delta_set_v1") {
      fail("invalid_effect_certificate", "treatment delta set schema_version is invalid");
    }
    const rows = exactArray(
      record.members,
      MAX_TREATMENT_DELTA_MEMBERS,
      "effect treatment delta members",
    );
    const parsed = rows.map((row, index) => {
      const member = exactRecord(row, TREATMENT_MEMBER_KEYS, `treatment member ${index}`);
      const input = treatmentMemberInput(Object.fromEntries(
        TREATMENT_MEMBER_INPUT_KEYS.map((key) => [key, member[key]]),
      ));
      return {
        input,
        sequence: positiveInteger(member.member_sequence, `treatment ${index} sequence`),
        digest: sha256(member.member_sha256, `treatment ${index} digest`),
      };
    });
    const rebuilt = assembleTreatmentDeltaSet(parsed.map(({ input }) => input));
    const count = boundedInteger(
      record.treatment_delta_count,
      "treatment_delta_count",
      0,
      MAX_TREATMENT_DELTA_MEMBERS,
    );
    const digest = sha256(
      record.treatment_delta_set_sha256,
      "treatment_delta_set_sha256",
    );
    if (parsed.some(({ sequence, digest: rowDigest }, index) =>
      sequence !== index + 1
        || rowDigest !== rebuilt.members[index]?.member_sha256)
      || count !== rebuilt.treatment_delta_count
      || digest !== rebuilt.treatment_delta_set_sha256
      || canonicalContinuationJson(record.members)
        !== canonicalContinuationJson(rebuilt.members)) {
      fail(
        "treatment_delta_digest_mismatch",
        "treatment delta rows do not match their canonical set",
      );
    }
    return rebuilt;
  });
}

function privateEd25519Key(key: KeyObject): KeyObject {
  if (!(key instanceof Object) || key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    fail("invalid_ed25519_key", "effect certificate signing key must be Ed25519 private key");
  }
  return key;
}

function publicEd25519KeyFromSpki(value: unknown): Readonly<{
  key: KeyObject;
  spki_base64url: string;
  principal_sha256: Sha256;
}> {
  if (typeof value !== "string" || value.length === 0 || value.includes("=")) {
    fail("invalid_ed25519_key", "verifier public key must be canonical unpadded base64url SPKI");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0 || bytes.toString("base64url") !== value) {
    fail("invalid_ed25519_key", "verifier public key SPKI is not canonical base64url");
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  } catch (error) {
    throw new EffectCertificateError("invalid_ed25519_key", "verifier SPKI is invalid", { cause: error });
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    fail("invalid_ed25519_key", "verifier SPKI must contain an Ed25519 public key");
  }
  const canonical = key.export({ format: "der", type: "spki" }) as Buffer;
  if (!canonical.equals(bytes)) {
    fail("invalid_ed25519_key", "verifier SPKI is not canonical DER");
  }
  return {
    key,
    spki_base64url: value,
    principal_sha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

function signerIdentity(privateKey: KeyObject): Readonly<{
  private_key: KeyObject;
  public_key_spki_base64url: string;
  principal_sha256: Sha256;
}> {
  const signingKey = privateEd25519Key(privateKey);
  const publicKey = createPublicKey(signingKey);
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return {
    private_key: signingKey,
    public_key_spki_base64url: spki.toString("base64url"),
    principal_sha256: createHash("sha256").update(spki).digest("hex"),
  };
}

function signature(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_SIGNATURE.test(value)) {
    fail("invalid_effect_certificate", "signature must be canonical 64-byte base64url text");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 64 || decoded.toString("base64url") !== value) {
    fail("invalid_effect_certificate", "signature must decode canonically to 64 bytes");
  }
  return value;
}

function evidenceWindowSha256(value: Readonly<{
  experiment_cohort_ref: AuthorityArtifactRefV1;
  experiment_cohort_installation_receipt_sha256: Sha256;
  assignment_seed_commitment_sha256: Sha256;
  control_branch_ref: AuthoritativeBranchRevisionRefV1;
  candidate_branch_ref: EffectCertificateEnvelopeV1["candidate_branch_ref"];
  compiler_policy_ref: AuthorityArtifactRefV1;
  evidence_policy_ref: AuthorityArtifactRefV1;
  effect_verifier_contract_sha256: Sha256;
  statistical_contract_sha256: Sha256;
  window_opened_at: string;
  window_closed_at: string;
}>): Sha256 {
  return canonicalContinuationSha256({
    schema_version: "effect_evidence_window_v1",
    ...value,
  });
}

type ParsedBuildInput = Readonly<{
  tenant_id: string;
  certificate_id: string;
  experiment_cohort_ref: AuthorityArtifactRefV1;
  experiment_cohort: ExperimentCohortV1;
  experiment_cohort_installation_receipt_sha256: Sha256;
  assignment_seed_reveal_base64url: string;
  assignment_seed_commitment_sha256: Sha256;
  evidence_policy: EffectEvidencePolicyArtifactBindingV1;
  eligible_decision_set: EffectEvidenceMemberSetV1;
  evaluation: EffectEvidenceEvaluationV1;
  treatment_delta_set: EffectTreatmentDeltaSetV1;
  created_at: string;
}>;

function seedReveal(value: unknown): Readonly<{
  base64url: string;
  commitment_sha256: Sha256;
}> {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    fail("invalid_effect_certificate", "assignment seed reveal must be canonical base64url");
  }
  const seed = Buffer.from(value, "base64url");
  if (seed.byteLength !== 32 || seed.toString("base64url") !== value) {
    fail("invalid_effect_certificate", "assignment seed reveal must contain exactly 32 bytes");
  }
  return {
    base64url: value,
    commitment_sha256: assignmentSeedCommitmentSha256V1(seed),
  };
}

function armObservation(value: unknown, field: string): EffectArmObservationCountsV1 {
  const record = exactRecord(value, ARM_OBSERVATION_KEYS, field);
  return {
    assigned_exposure_count: boundedInteger(
      record.assigned_exposure_count,
      `${field}.assigned_exposure_count`,
      0,
      MAX_ELIGIBLE_DECISIONS,
    ),
    succeeded_count: boundedInteger(
      record.succeeded_count,
      `${field}.succeeded_count`,
      0,
      MAX_ELIGIBLE_DECISIONS,
    ),
    partial_count: boundedInteger(
      record.partial_count,
      `${field}.partial_count`,
      0,
      MAX_ELIGIBLE_DECISIONS,
    ),
    failed_count: boundedInteger(
      record.failed_count,
      `${field}.failed_count`,
      0,
      MAX_ELIGIBLE_DECISIONS,
    ),
    unknown_count: boundedInteger(
      record.unknown_count,
      `${field}.unknown_count`,
      0,
      MAX_ELIGIBLE_DECISIONS,
    ),
    missing_outcome_count: boundedInteger(
      record.missing_outcome_count,
      `${field}.missing_outcome_count`,
      0,
      MAX_ELIGIBLE_DECISIONS,
    ),
  };
}

function parseBuildInput(value: unknown): ParsedBuildInput {
  const record = exactRecord(value, BUILD_INPUT_KEYS, "effect certificate build input");
  const policy = policyArtifactBinding(record.evidence_policy);
  const eligibleSet = verifyEffectEvidenceMemberSetV1(record.eligible_decision_set);
  const treatmentDeltaSet = verifyEffectTreatmentDeltaSetV1(
    record.treatment_delta_set,
  );
  const tenantId = text(record.tenant_id, "tenant_id");
  const cohortRef = artifactRef(record.experiment_cohort_ref, "experiment_cohort_ref");
  const cohort = verifyExperimentCohortV1(record.experiment_cohort);
  const installationReceipt = sha256(
    record.experiment_cohort_installation_receipt_sha256,
    "experiment_cohort_installation_receipt_sha256",
  );
  const revealedSeed = seedReveal(record.assignment_seed_reveal_base64url);
  const armRecord = exactRecord(
    record.arm_observations,
    ARM_OBSERVATIONS_KEYS,
    "arm_observations",
  );
  const control = armObservation(armRecord.control, "arm_observations.control");
  const candidate = armObservation(armRecord.candidate, "arm_observations.candidate");
  const subject = cohort.authority_subject_sha256;
  if (policy.payload.tenant_id !== tenantId
    || (policy.payload.authority_subject_sha256 !== null
      && policy.payload.authority_subject_sha256 !== subject)) {
    fail("policy_binding_mismatch", "evidence policy tenant or authority subject does not match");
  }
  if (cohort.tenant_id !== tenantId
    || experimentCohortPayloadSha256V1(cohort) !== cohortRef.payload_sha256
    || cohort.assignment_protocol.assignment_seed_commitment_sha256
      !== revealedSeed.commitment_sha256
    || canonicalContinuationJson(cohort.evidence_policy_ref)
      !== canonicalContinuationJson(policy.artifact_ref)) {
    fail("policy_binding_mismatch", "experiment cohort or revealed seed binding does not match");
  }
  if (eligibleSet.eligible_decision_count > policy.payload.max_eligible_decisions) {
    fail("policy_binding_mismatch", "eligible decision count exceeds evidence policy");
  }
  if (treatmentDeltaSet.treatment_delta_count
    > policy.payload.max_treatment_delta_count) {
    fail("policy_binding_mismatch", "treatment delta count exceeds evidence policy");
  }
  const duration = Date.parse(cohort.outcome_deadline)
    - Date.parse(cohort.assignment_window_opened_at);
  if (duration < policy.payload.min_evidence_window_ms
    || duration > policy.payload.max_evidence_window_ms) {
    fail("policy_binding_mismatch", "evidence window is outside policy bounds");
  }
  const created = timestamp(record.created_at, "created_at");
  if (created < cohort.settlement_cutoff_at) {
    fail("invalid_effect_certificate", "certificate cannot be created before settlement cutoff");
  }
  const evaluation = evaluateEffectEvidenceV1({
    policy: {
      min_control_exposures: policy.payload.min_control_exposures,
      min_candidate_exposures: policy.payload.min_candidate_exposures,
      max_missingness_bps: policy.payload.max_missingness_bps,
      harm_noninferiority_margin_bps: policy.payload.harm_noninferiority_margin_bps,
      utility_min_lift_bps: policy.payload.utility_min_lift_bps,
      confidence_bps: policy.payload.confidence_bps,
    },
    control,
    candidate,
  });
  if (eligibleSet.eligible_decision_count !== evaluation.total_exposure_count) {
    fail("evidence_member_digest_mismatch", "arm counts do not equal eligible decision census");
  }
  return {
    tenant_id: tenantId,
    certificate_id: text(record.certificate_id, "certificate_id"),
    experiment_cohort_ref: cohortRef,
    experiment_cohort: cohort,
    experiment_cohort_installation_receipt_sha256: installationReceipt,
    assignment_seed_reveal_base64url: revealedSeed.base64url,
    assignment_seed_commitment_sha256: revealedSeed.commitment_sha256,
    evidence_policy: policy,
    eligible_decision_set: eligibleSet,
    evaluation,
    treatment_delta_set: treatmentDeltaSet,
    created_at: created,
  };
}

function assembleEnvelope(
  input: ParsedBuildInput,
  verifier: Readonly<{
    public_key_spki_base64url: string;
    principal_sha256: Sha256;
  }>,
): EffectCertificateEnvelopeV1 {
  const policy = input.evidence_policy;
  if (!policy.payload.trusted_effect_verifier_principals.includes(verifier.principal_sha256)) {
    fail("policy_binding_mismatch", "effect verifier is not trusted by the evidence policy");
  }
  const cohort = input.experiment_cohort;
  const body = {
    schema_version: "effect_certificate_v1" as const,
    tenant_id: input.tenant_id,
    certificate_id: input.certificate_id,
    authority_subject_sha256: cohort.authority_subject_sha256,
    experiment_cohort_ref: input.experiment_cohort_ref,
    experiment_cohort: cohort,
    experiment_cohort_installation_receipt_sha256:
      input.experiment_cohort_installation_receipt_sha256,
    assignment_seed_reveal_base64url: input.assignment_seed_reveal_base64url,
    assignment_seed_commitment_sha256: input.assignment_seed_commitment_sha256,
    control_branch_ref: cohort.control_learning_ref,
    candidate_branch_ref: cohort.candidate_learning_ref,
    compiler_policy_ref: cohort.compiler_policy_ref,
    evidence_policy_ref: policy.artifact_ref,
    evidence_window_sha256: evidenceWindowSha256({
      experiment_cohort_ref: input.experiment_cohort_ref,
      experiment_cohort_installation_receipt_sha256:
        input.experiment_cohort_installation_receipt_sha256,
      assignment_seed_commitment_sha256: input.assignment_seed_commitment_sha256,
      control_branch_ref: cohort.control_learning_ref,
      candidate_branch_ref: cohort.candidate_learning_ref,
      compiler_policy_ref: cohort.compiler_policy_ref,
      evidence_policy_ref: policy.artifact_ref,
      effect_verifier_contract_sha256: policy.payload.effect_verifier_contract_sha256,
      statistical_contract_sha256: policy.payload.statistical_contract_sha256,
      window_opened_at: cohort.assignment_window_opened_at,
      window_closed_at: cohort.outcome_deadline,
    }),
    window_opened_at: cohort.assignment_window_opened_at,
    window_closed_at: cohort.outcome_deadline,
    eligible_decision_count: input.eligible_decision_set.eligible_decision_count,
    eligible_decision_set_sha256: input.eligible_decision_set.eligible_decision_set_sha256,
    missingness_bps: input.evaluation.missingness_bps,
    harm_conclusion: input.evaluation.harm_conclusion,
    utility_conclusion: input.evaluation.utility_conclusion,
    admission_state: input.evaluation.admission_state,
    effect_evaluation: input.evaluation,
    effect_evaluation_sha256: input.evaluation.evaluation_sha256,
    treatment_delta_count: input.treatment_delta_set.treatment_delta_count,
    treatment_delta_set_sha256:
      input.treatment_delta_set.treatment_delta_set_sha256,
    effect_verifier_contract_sha256: policy.payload.effect_verifier_contract_sha256,
    statistical_contract_sha256: policy.payload.statistical_contract_sha256,
    verifier_principal_sha256: verifier.principal_sha256,
    verifier_public_key_spki_base64url: verifier.public_key_spki_base64url,
    trust_root_sha256: policy.trust_root_sha256,
    signature_algorithm: "ed25519" as const,
    created_at: input.created_at,
  };
  return canonicalContinuationClone({
    ...body,
    certificate_sha256: canonicalContinuationSha256(body),
  });
}

function signingBytes(value: EffectCertificateEnvelopeV1): Buffer {
  return Buffer.from(canonicalContinuationJson(value), "utf8");
}

export function buildSignedEffectCertificateV1(
  value: EffectCertificateBuildInputV1,
  privateKey: KeyObject,
): SignedEffectCertificateV1 {
  return wrapInvalid(() => {
    const input = parseBuildInput(value);
    const signer = signerIdentity(privateKey);
    const envelope = assembleEnvelope(input, signer);
    const signed = {
      ...envelope,
      signature: signDetached(null, signingBytes(envelope), signer.private_key).toString("base64url"),
    };
    signature(signed.signature);
    return canonicalContinuationClone(signed);
  });
}

function envelopeBuildProjection(
  record: Readonly<Record<string, unknown>>,
  policy: EffectEvidencePolicyArtifactBindingV1,
  eligibleSet: EffectEvidenceMemberSetV1,
  treatmentDeltaSet: EffectTreatmentDeltaSetV1,
): EffectCertificateBuildInputV1 {
  const evaluation = record.effect_evaluation as EffectEvidenceEvaluationV1;
  const armCounts = (
    arm: EffectEvidenceEvaluationV1["control"],
  ): EffectArmObservationCountsV1 => ({
    assigned_exposure_count: arm.assigned_exposure_count,
    succeeded_count: arm.succeeded_count,
    partial_count: arm.partial_count,
    failed_count: arm.failed_count,
    unknown_count: arm.unknown_count,
    missing_outcome_count: arm.missing_outcome_count,
  });
  return {
    tenant_id: record.tenant_id as string,
    certificate_id: record.certificate_id as string,
    experiment_cohort_ref: record.experiment_cohort_ref as AuthorityArtifactRefV1,
    experiment_cohort: record.experiment_cohort as ExperimentCohortV1,
    experiment_cohort_installation_receipt_sha256:
      record.experiment_cohort_installation_receipt_sha256 as Sha256,
    assignment_seed_reveal_base64url:
      record.assignment_seed_reveal_base64url as string,
    evidence_policy: policy,
    eligible_decision_set: eligibleSet,
    arm_observations: {
      control: armCounts(evaluation.control),
      candidate: armCounts(evaluation.candidate),
    },
    treatment_delta_set: treatmentDeltaSet,
    created_at: record.created_at as string,
  };
}

export function verifySignedEffectCertificateV1(
  value: unknown,
  expectedInstalledPolicyBinding: EffectEvidencePolicyArtifactBindingV1,
  eligibleDecisionSet: EffectEvidenceMemberSetV1,
  treatmentDeltaSet: EffectTreatmentDeltaSetV1,
): SignedEffectCertificateV1 {
  return wrapInvalid(() => {
    const record = exactRecord(value, SIGNED_KEYS, "signed effect certificate");
    if (record.schema_version !== "effect_certificate_v1"
      || record.signature_algorithm !== "ed25519") {
      fail("invalid_effect_certificate", "effect certificate schema or signature algorithm is invalid");
    }
    const policy = policyArtifactBinding(expectedInstalledPolicyBinding);
    const eligibleSet = verifyEffectEvidenceMemberSetV1(eligibleDecisionSet);
    const treatmentSet = verifyEffectTreatmentDeltaSetV1(treatmentDeltaSet);
    const input = parseBuildInput(envelopeBuildProjection(
      record,
      policy,
      eligibleSet,
      treatmentSet,
    ));
    const publicIdentity = publicEd25519KeyFromSpki(record.verifier_public_key_spki_base64url);
    const rebuilt = assembleEnvelope(input, {
      public_key_spki_base64url: publicIdentity.spki_base64url,
      principal_sha256: publicIdentity.principal_sha256,
    });
    const suppliedCertificateSha256 = sha256(record.certificate_sha256, "certificate_sha256");
    const suppliedSignature = signature(record.signature);

    if (record.eligible_decision_count !== eligibleSet.eligible_decision_count
      || record.eligible_decision_set_sha256 !== eligibleSet.eligible_decision_set_sha256) {
      fail("evidence_member_digest_mismatch", "certificate does not bind the supplied eligible decisions");
    }
    if (record.treatment_delta_count !== treatmentSet.treatment_delta_count
      || record.treatment_delta_set_sha256
        !== treatmentSet.treatment_delta_set_sha256) {
      fail(
        "treatment_delta_digest_mismatch",
        "certificate does not bind the supplied treatment delta",
      );
    }
    if (record.evidence_policy_ref === null
      || canonicalContinuationJson(record.evidence_policy_ref)
        !== canonicalContinuationJson(policy.artifact_ref)
      || record.trust_root_sha256 !== policy.trust_root_sha256
      || record.effect_verifier_contract_sha256
        !== policy.payload.effect_verifier_contract_sha256
      || record.statistical_contract_sha256 !== policy.payload.statistical_contract_sha256) {
      fail("policy_binding_mismatch", "certificate does not bind the verified evidence policy");
    }
    if (record.verifier_principal_sha256 !== publicIdentity.principal_sha256
      || rebuilt.certificate_sha256 !== suppliedCertificateSha256
      || canonicalContinuationJson(rebuilt)
        !== canonicalContinuationJson(Object.fromEntries(
          ENVELOPE_KEYS.map((key) => [key, record[key]]),
        ))) {
      fail("certificate_digest_mismatch", "certificate digest does not authenticate its exact header");
    }
    if (!verifyDetached(
      null,
      signingBytes(rebuilt),
      publicIdentity.key,
      Buffer.from(suppliedSignature, "base64url"),
    )) {
      fail("signature_invalid", "effect verifier proof-of-possession is invalid");
    }
    return canonicalContinuationClone({ ...rebuilt, signature: suppliedSignature });
  });
}

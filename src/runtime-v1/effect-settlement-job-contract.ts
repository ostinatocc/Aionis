import {
  assertSha256,
  canonicalContinuationClone,
  canonicalContinuationJson,
  type AuthorityArtifactRefV1,
  type CanonicalJson,
} from "../continuation/contract.js";
import type { ExperimentCohortV1 } from
  "../continuation/experiment-cohort.js";

export type ContinuationRuntimeV1EffectSettlementJobPayload = Readonly<{
  schema_version: "effect_settlement_job_v1";
  experiment_cohort_ref: AuthorityArtifactRefV1;
  cohort_id: string;
  assignment_window_opened_at: string;
  assignment_window_closed_at: string;
  outcome_deadline: string;
  settlement_cutoff_at: string;
  control_learning_ref: ExperimentCohortV1["control_learning_ref"];
  candidate_learning_ref: ExperimentCohortV1["candidate_learning_ref"];
  compiler_policy_ref: AuthorityArtifactRefV1;
  evidence_policy_ref: AuthorityArtifactRefV1;
}>;

const PAYLOAD_KEYS = Object.freeze([
  "assignment_window_closed_at",
  "assignment_window_opened_at",
  "candidate_learning_ref",
  "cohort_id",
  "compiler_policy_ref",
  "control_learning_ref",
  "evidence_policy_ref",
  "experiment_cohort_ref",
  "outcome_deadline",
  "schema_version",
  "settlement_cutoff_at",
] as const);
const REF_KEYS = Object.freeze(["artifact_sha256", "payload_sha256"] as const);

function invalid(): never {
  throw new Error("continuation_runtime_v1_effect_settlement_job_invalid");
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) invalid();
  const own = Reflect.ownKeys(value);
  const expected = new Set(keys);
  if (own.length !== keys.length
    || own.some((key) => typeof key !== "string" || !expected.has(key))) invalid();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of own as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function ref(value: unknown): AuthorityArtifactRefV1 {
  const record = exactRecord(value, REF_KEYS);
  if (typeof record.artifact_sha256 !== "string"
    || typeof record.payload_sha256 !== "string") invalid();
  try {
    assertSha256(record.artifact_sha256, "effect cohort artifact digest");
    assertSha256(record.payload_sha256, "effect cohort payload digest");
  } catch {
    invalid();
  }
  return canonicalContinuationClone({
    artifact_sha256: record.artifact_sha256,
    payload_sha256: record.payload_sha256,
  });
}

/**
 * Extracts only the cohort locator from an exact durable payload.  Every
 * redundant payload field is compared later with the root-signed cohort; none
 * of those fields becomes preparation authority.
 */
export function continuationRuntimeV1EffectCohortRefFromJobPayload(
  value: unknown,
): AuthorityArtifactRefV1 {
  const record = exactRecord(value, PAYLOAD_KEYS);
  if (record.schema_version !== "effect_settlement_job_v1") invalid();
  // Force the full payload through the canonical JSON domain before returning
  // its sole locator.  This rejects accessors, unsupported values and cycles.
  try {
    canonicalContinuationJson(record as Readonly<Record<string, CanonicalJson>>);
  } catch {
    invalid();
  }
  return ref(record.experiment_cohort_ref);
}

export function buildContinuationRuntimeV1EffectSettlementJobPayload(
  experimentCohortRef: AuthorityArtifactRefV1,
  cohort: ExperimentCohortV1,
): ContinuationRuntimeV1EffectSettlementJobPayload {
  return canonicalContinuationClone({
    schema_version: "effect_settlement_job_v1" as const,
    experiment_cohort_ref: experimentCohortRef,
    cohort_id: cohort.cohort_id,
    assignment_window_opened_at: cohort.assignment_window_opened_at,
    assignment_window_closed_at: cohort.assignment_window_closed_at,
    outcome_deadline: cohort.outcome_deadline,
    settlement_cutoff_at: cohort.settlement_cutoff_at,
    control_learning_ref: cohort.control_learning_ref,
    candidate_learning_ref: cohort.candidate_learning_ref,
    compiler_policy_ref: cohort.compiler_policy_ref,
    evidence_policy_ref: cohort.evidence_policy_ref,
  });
}

export function assertContinuationRuntimeV1EffectSettlementJobPayloadBinding(
  supplied: unknown,
  experimentCohortRef: AuthorityArtifactRefV1,
  cohort: ExperimentCohortV1,
): void {
  const parsedRef = continuationRuntimeV1EffectCohortRefFromJobPayload(supplied);
  const expected = buildContinuationRuntimeV1EffectSettlementJobPayload(
    experimentCohortRef,
    cohort,
  );
  if (canonicalContinuationJson(parsedRef)
      !== canonicalContinuationJson(experimentCohortRef)
    || canonicalContinuationJson(supplied)
      !== canonicalContinuationJson(expected)) invalid();
}

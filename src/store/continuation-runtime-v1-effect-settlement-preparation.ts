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
  type EffectEvidencePolicyArtifactBindingV1,
  type EffectTreatmentDeltaSetV1,
} from "../continuation/effect-certificate.js";
import {
  evaluateEffectEvidenceV1,
  type EffectEvidenceEvaluationV1,
} from "../continuation/effect-evaluation.js";
import type { EffectEvidenceMemberSetV1 } from
  "../continuation/episode.js";
import {
  experimentCohortPayloadSha256V1,
  verifyExperimentCohortV1,
} from "../continuation/experiment-cohort.js";
import { assignmentSeedCommitmentSha256V1 } from
  "../continuation/serving-assignment.js";
import {
  assertContinuationRuntimeV1AuthorityArtifactReader,
  type ContinuationRuntimeV1AuthorityArtifactReader,
} from "./continuation-runtime-v1-authority-artifact-reader.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import {
  deriveEffectTreatmentDeltaV1,
  readExactBranch,
  rebuildEffectSettlementCensusV1,
  type EffectSettlementAuthorityBindingV1,
} from "./continuation-runtime-v1-effect-certificate-support.js";
import { createContinuationRuntimeV1ExperimentCohortAuthority } from
  "./continuation-runtime-v1-experiment-cohort-authority.js";
import {
  assertContinuationRuntimeV1PolicyAuthority,
  type ContinuationRuntimeV1PolicyAuthority,
  type VerifiedEvidencePolicyCapabilityV1,
} from "./continuation-runtime-v1-policy-authority.js";

export type PrepareContinuationRuntimeV1EffectSettlementArgs = Readonly<{
  tenant_id: string;
  scope: string;
  authority_subject_sha256: Sha256;
  experiment_cohort_ref: AuthorityArtifactRefV1;
  created_at: string;
}>;

export type PreparedContinuationRuntimeV1EffectSettlement = Readonly<{
  schema_version: "prepared_effect_settlement_v1";
  authority_binding: EffectSettlementAuthorityBindingV1;
  experiment_cohort_installation_receipt_sha256: Sha256;
  assignment_seed_reveal_base64url: string;
  evidence_policy: EffectEvidencePolicyArtifactBindingV1;
  evidence_policy_capability: VerifiedEvidencePolicyCapabilityV1;
  eligible_decision_set: EffectEvidenceMemberSetV1;
  treatment_delta_set: EffectTreatmentDeltaSetV1;
  effect_evaluation: EffectEvidenceEvaluationV1;
  created_at: string;
}>;

export type ContinuationRuntimeV1EffectSettlementPreparation = Readonly<{
  prepare(
    args: PrepareContinuationRuntimeV1EffectSettlementArgs,
  ): Promise<PreparedContinuationRuntimeV1EffectSettlement>;
}>;

export type ContinuationRuntimeV1EffectSettlementPreparationInput = Readonly<{
  database: ContinuationRuntimeV1Database;
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader;
  policyAuthority: ContinuationRuntimeV1PolicyAuthority;
}>;

export type ContinuationRuntimeV1EffectSettlementFailureDisposition =
  | "retry"
  | "dead";

const PREPARATION_ERRORS = new WeakMap<object, Readonly<{
  code: string;
  disposition: ContinuationRuntimeV1EffectSettlementFailureDisposition;
}>>();

export class ContinuationRuntimeV1EffectSettlementPreparationError extends Error {
  constructor(
    code: string,
    disposition: ContinuationRuntimeV1EffectSettlementFailureDisposition,
  ) {
    super("continuation_runtime_v1_effect_settlement_preparation_failed");
    this.name = "ContinuationRuntimeV1EffectSettlementPreparationError";
    PREPARATION_ERRORS.set(this, { code, disposition });
  }

  get code(): string {
    return PREPARATION_ERRORS.get(this)?.code ?? "effect_preparation_failed";
  }

  get disposition(): ContinuationRuntimeV1EffectSettlementFailureDisposition {
    return PREPARATION_ERRORS.get(this)?.disposition ?? "retry";
  }
}

const INPUT_KEYS = Object.freeze([
  "artifactStore", "database", "policyAuthority",
] as const);
const PREPARE_KEYS = Object.freeze([
  "authority_subject_sha256", "created_at", "experiment_cohort_ref", "scope",
  "tenant_id",
] as const);
const REF_KEYS = Object.freeze(["artifact_sha256", "payload_sha256"] as const);
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;

function fail(
  code: string,
  disposition: ContinuationRuntimeV1EffectSettlementFailureDisposition = "dead",
): never {
  if (!SAFE_CODE.test(code)) {
    throw new Error("continuation_runtime_v1_effect_settlement_error_code_invalid");
  }
  throw new ContinuationRuntimeV1EffectSettlementPreparationError(code, disposition);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) {
    fail("effect_preparation_input_invalid");
  }
  const own = Reflect.ownKeys(value);
  const expected = new Set(keys);
  if (own.length !== keys.length
    || own.some((key) => typeof key !== "string" || !expected.has(key))) {
    fail("effect_preparation_input_invalid");
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of own as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("effect_preparation_input_invalid");
    }
    out[key] = descriptor.value;
  }
  return out;
}

function text(value: unknown): string {
  if (typeof value !== "string") fail("effect_preparation_input_invalid");
  assertUnicodeScalarString(value, "effect settlement preparation text");
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 256) {
    fail("effect_preparation_input_invalid");
  }
  return value;
}

function sha(value: unknown): Sha256 {
  if (typeof value !== "string") fail("effect_preparation_input_invalid");
  assertSha256(value, "effect settlement preparation digest");
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") fail("effect_preparation_input_invalid");
  assertCanonicalUtcMillis(value, "effect settlement preparation timestamp");
  return value;
}

function artifactRef(value: unknown): AuthorityArtifactRefV1 {
  const record = exactRecord(value, REF_KEYS);
  return {
    artifact_sha256: sha(record.artifact_sha256),
    payload_sha256: sha(record.payload_sha256),
  };
}

function parsePrepareArgs(
  value: PrepareContinuationRuntimeV1EffectSettlementArgs,
): PrepareContinuationRuntimeV1EffectSettlementArgs {
  const record = exactRecord(value, PREPARE_KEYS);
  return {
    tenant_id: text(record.tenant_id),
    scope: text(record.scope),
    authority_subject_sha256: sha(record.authority_subject_sha256),
    experiment_cohort_ref: artifactRef(record.experiment_cohort_ref),
    created_at: timestamp(record.created_at),
  };
}

function sqliteRetryable(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return !!descriptor && "value" in descriptor
    && typeof descriptor.value === "string"
    && /^(?:SQLITE_BUSY|SQLITE_LOCKED|SQLITE_IOERR)(?:_|$)/u.test(descriptor.value);
}

function withProtectedAssignmentSeed<T>(
  database: ContinuationRuntimeV1Database,
  binding: EffectSettlementAuthorityBindingV1,
  use: (seed: Buffer) => T,
): T {
  const row = database.db.prepare(`SELECT protected_secret
    FROM authority_artifacts
    WHERE tenant_id = ? AND artifact_sha256 = ? AND payload_sha256 = ?
      AND artifact_kind = 'experiment_cohort'`).get(
    binding.tenant_id,
    binding.experiment_cohort_ref.artifact_sha256,
    binding.experiment_cohort_ref.payload_sha256,
  ) as Readonly<{ protected_secret: unknown }> | undefined;
  if (!row || !(row.protected_secret instanceof Uint8Array)
    || row.protected_secret.byteLength !== 32) {
    fail("effect_seed_missing");
  }
  // Copy out of the SQLite driver's row buffer.  The worker owns this copy
  // only for the duration of the synchronous evidence rebuild callback.
  const seed = Buffer.from(row.protected_secret);
  try {
    if (assignmentSeedCommitmentSha256V1(seed)
      !== binding.experiment_cohort.assignment_protocol
        .assignment_seed_commitment_sha256) {
      fail("effect_seed_commitment_mismatch");
    }
    return use(seed);
  } finally {
    seed.fill(0);
  }
}

function evaluation(
  policy: EffectEvidencePolicyArtifactBindingV1,
  census: ReturnType<typeof rebuildEffectSettlementCensusV1>,
): EffectEvidenceEvaluationV1 {
  return evaluateEffectEvidenceV1({
    policy: {
      min_control_exposures: policy.payload.min_control_exposures,
      min_candidate_exposures: policy.payload.min_candidate_exposures,
      max_missingness_bps: policy.payload.max_missingness_bps,
      harm_noninferiority_margin_bps:
        policy.payload.harm_noninferiority_margin_bps,
      utility_min_lift_bps: policy.payload.utility_min_lift_bps,
      confidence_bps: policy.payload.confidence_bps,
    },
    control: census.control_observations,
    candidate: census.candidate_observations,
  });
}

export function createContinuationRuntimeV1EffectSettlementPreparation(
  value: ContinuationRuntimeV1EffectSettlementPreparationInput,
): ContinuationRuntimeV1EffectSettlementPreparation {
  const input = exactRecord(value, INPUT_KEYS);
  const database = input.database as ContinuationRuntimeV1Database;
  const artifactStore = input.artifactStore as
    ContinuationRuntimeV1AuthorityArtifactReader;
  const policyAuthority = input.policyAuthority as
    ContinuationRuntimeV1PolicyAuthority;
  assertContinuationRuntimeV1AuthorityArtifactReader(artifactStore, database);
  assertContinuationRuntimeV1PolicyAuthority(
    policyAuthority,
    database,
    artifactStore,
  );
  const cohortAuthority = createContinuationRuntimeV1ExperimentCohortAuthority(
    database,
    artifactStore,
    policyAuthority,
  );

  return Object.freeze({
    async prepare(
      supplied: PrepareContinuationRuntimeV1EffectSettlementArgs,
    ): Promise<PreparedContinuationRuntimeV1EffectSettlement> {
      const args = parsePrepareArgs(supplied);
      try {
        const installed = await artifactStore.readByDigest({
          tenant_id: args.tenant_id,
          artifact_sha256: args.experiment_cohort_ref.artifact_sha256,
        });
        if (!installed
          || installed.signed_artifact.artifact_kind !== "experiment_cohort"
          || installed.signed_artifact.artifact_schema !== "experiment_cohort_v1"
          || installed.signed_artifact.payload_sha256
            !== args.experiment_cohort_ref.payload_sha256
          || installed.signed_artifact.authority_subject_sha256
            !== args.authority_subject_sha256) {
          fail("effect_cohort_authority_invalid");
        }
        const projectedCohort = verifyExperimentCohortV1(
          installed.signed_artifact.payload,
        );
        if (projectedCohort.tenant_id !== args.tenant_id
          || projectedCohort.scope !== args.scope
          || projectedCohort.authority_subject_sha256
            !== args.authority_subject_sha256
          || experimentCohortPayloadSha256V1(projectedCohort)
            !== args.experiment_cohort_ref.payload_sha256
          || canonicalContinuationJson(projectedCohort)
            !== canonicalContinuationJson(installed.signed_artifact.payload)
          || args.created_at < projectedCohort.settlement_cutoff_at) {
          fail("effect_cohort_binding_invalid");
        }
        // Validate the protected seed through the worker-only path before the
        // broader cohort resolver so seed corruption has one stable, redacted
        // terminal classification instead of being collapsed into a generic
        // authority failure.
        withProtectedAssignmentSeed(database, {
          tenant_id: args.tenant_id,
          authority_subject_sha256: args.authority_subject_sha256,
          experiment_cohort_ref: args.experiment_cohort_ref,
          experiment_cohort: projectedCohort,
          control_branch_ref: projectedCohort.control_learning_ref,
          candidate_branch_ref: projectedCohort.candidate_learning_ref,
          compiler_policy_ref: projectedCohort.compiler_policy_ref,
          evidence_policy_ref: projectedCohort.evidence_policy_ref,
        }, () => undefined);
        const cohortCapability = await cohortAuthority.resolveExact({
          tenant_id: args.tenant_id,
          authority_subject_sha256: args.authority_subject_sha256,
          experiment_cohort_ref: args.experiment_cohort_ref,
          at: projectedCohort.settlement_cutoff_at,
        });
        const cohort = cohortAuthority.payload(cohortCapability);
        if (canonicalContinuationJson(cohort)
          !== canonicalContinuationJson(projectedCohort)) {
          fail("effect_cohort_capability_mismatch");
        }
        await policyAuthority.resolveExact({
          tenant_id: args.tenant_id,
          authority_subject_sha256: args.authority_subject_sha256,
          artifact_kind: "compiler_policy",
          artifact_ref: cohort.compiler_policy_ref,
          at: cohort.assignment_window_opened_at,
        });
        const evidenceCapability = await policyAuthority.resolveExact({
          tenant_id: args.tenant_id,
          authority_subject_sha256: args.authority_subject_sha256,
          artifact_kind: "evidence_policy",
          artifact_ref: cohort.evidence_policy_ref,
          at: cohort.settlement_cutoff_at,
        });
        const evidencePolicy = policyAuthority.evidenceBinding(
          evidenceCapability,
        );
        const authorityBinding: EffectSettlementAuthorityBindingV1 =
          canonicalContinuationClone({
            tenant_id: args.tenant_id,
            authority_subject_sha256: args.authority_subject_sha256,
            experiment_cohort_ref: args.experiment_cohort_ref,
            experiment_cohort: cohort,
            control_branch_ref: cohort.control_learning_ref,
            candidate_branch_ref: cohort.candidate_learning_ref,
            compiler_policy_ref: cohort.compiler_policy_ref,
            evidence_policy_ref: cohort.evidence_policy_ref,
          });
        const control = readExactBranch(database, authorityBinding, "control");
        const candidate = readExactBranch(database, authorityBinding, "candidate");
        if (control.created_at > cohort.assignment_window_opened_at
          || candidate.created_at > cohort.assignment_window_opened_at) {
          fail("effect_branch_created_after_window_opened");
        }
        const treatmentDelta = deriveEffectTreatmentDeltaV1(
          database,
          authorityBinding,
        );
        if (treatmentDelta.treatment_delta_count < 1
          || treatmentDelta.treatment_delta_count
            > evidencePolicy.payload.max_treatment_delta_count) {
          fail("effect_treatment_delta_outside_policy");
        }
        const material = withProtectedAssignmentSeed(
          database,
          authorityBinding,
          (seed) => {
            const census = rebuildEffectSettlementCensusV1(
              database,
              authorityBinding,
              args.scope,
              seed,
            );
            return {
              assignment_seed_reveal_base64url: seed.toString("base64url"),
              census,
            };
          },
        );
        if (material.census.member_set.eligible_decision_count
          > evidencePolicy.payload.max_eligible_decisions) {
          fail("effect_census_outside_policy");
        }
        return Object.freeze({
          schema_version: "prepared_effect_settlement_v1" as const,
          authority_binding: authorityBinding,
          experiment_cohort_installation_receipt_sha256:
            cohortAuthority.installationReceiptSha256(cohortCapability),
          assignment_seed_reveal_base64url:
            material.assignment_seed_reveal_base64url,
          evidence_policy: evidencePolicy,
          evidence_policy_capability: evidenceCapability,
          eligible_decision_set: material.census.member_set,
          treatment_delta_set: treatmentDelta,
          effect_evaluation: evaluation(evidencePolicy, material.census),
          created_at: args.created_at,
        });
      } catch (error) {
        if (error instanceof ContinuationRuntimeV1EffectSettlementPreparationError) {
          throw error;
        }
        if (sqliteRetryable(error)) {
          fail("effect_storage_temporarily_unavailable", "retry");
        }
        fail("effect_authority_or_ledger_invalid");
      }
    },
  });
}

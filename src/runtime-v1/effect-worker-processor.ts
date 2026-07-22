import { createHash, createPublicKey } from "node:crypto";

import {
  buildSignedEffectCertificateV1,
  type EffectTreatmentDeltaSetV1,
  type SignedEffectCertificateV1,
} from "../continuation/effect-certificate.js";
import type { EffectEvidenceMemberSetV1 } from
  "../continuation/episode.js";
import {
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
} from "../continuation/contract.js";
import {
  assertContinuationRuntimeV1AuthorityArtifactReader,
  type ContinuationRuntimeV1AuthorityArtifactReader,
} from "../store/continuation-runtime-v1-authority-artifact-reader.js";
import type { ContinuationRuntimeV1Database } from
  "../store/continuation-runtime-v1-database.js";
import {
  assertContinuationRuntimeV1EffectCertificateWriter,
  createContinuationRuntimeV1EffectCertificateWriter,
} from "../store/continuation-runtime-v1-effect-certificate-writer.js";
import { continuationRuntimeV1EffectStoreFailureCode } from
  "../store/continuation-runtime-v1-effect-certificate-support.js";
import {
  ContinuationRuntimeV1EffectSettlementPreparationError,
  createContinuationRuntimeV1EffectSettlementPreparation,
} from "../store/continuation-runtime-v1-effect-settlement-preparation.js";
import {
  assertContinuationRuntimeV1PolicyAuthority,
  type ContinuationRuntimeV1PolicyAuthority,
} from "../store/continuation-runtime-v1-policy-authority.js";
import type { ContinuationRuntimeV1EffectSigner } from "./effect-signer.js";
import {
  assertContinuationRuntimeV1EffectSettlementJobPayloadBinding,
  continuationRuntimeV1EffectCohortRefFromJobPayload,
} from "./effect-settlement-job-contract.js";
import {
  ContinuationRuntimeV1WorkerProcessorError,
  type ContinuationRuntimeV1PreparedWorkerSuccess,
  type ContinuationRuntimeV1WorkerAttemptJob,
  type ContinuationRuntimeV1WorkerProcessor,
  type ContinuationRuntimeV1WorkerProcessorInput,
  type ContinuationRuntimeV1WorkerSuccessOutput,
} from "./worker-service.js";

export type ContinuationRuntimeV1EffectWorkerProcessorInput = Readonly<{
  database: ContinuationRuntimeV1Database;
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader;
  policyAuthority: ContinuationRuntimeV1PolicyAuthority;
  signer: ContinuationRuntimeV1EffectSigner;
}>;

const FACTORY_KEYS = Object.freeze([
  "artifactStore", "database", "policyAuthority", "signer",
] as const);

function configurationFailure(): never {
  throw new Error("continuation_runtime_v1_effect_worker_processor_invalid");
}

function processorFailure(
  code: string,
  disposition: "retry" | "dead",
): never {
  throw new ContinuationRuntimeV1WorkerProcessorError({ code, disposition });
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) configurationFailure();
  const own = Reflect.ownKeys(value);
  const expected = new Set(keys);
  if (own.length !== keys.length
    || own.some((key) => typeof key !== "string" || !expected.has(key))) {
    configurationFailure();
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of own as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      configurationFailure();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function assertSigner(value: unknown): asserts value is ContinuationRuntimeV1EffectSigner {
  const signer = exactRecord(value, [
    "principalSha256", "privateKey", "publicKeySpkiBase64url",
  ]);
  const privateKey = signer.privateKey as ContinuationRuntimeV1EffectSigner["privateKey"];
  if (!privateKey || privateKey.type !== "private"
    || privateKey.asymmetricKeyType !== "ed25519"
    || typeof signer.principalSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(signer.principalSha256)
    || typeof signer.publicKeySpkiBase64url !== "string") configurationFailure();
  const spki = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  }) as Buffer;
  if (spki.toString("base64url") !== signer.publicKeySpkiBase64url
    || createHash("sha256").update(spki).digest("hex")
      !== signer.principalSha256) configurationFailure();
}

function sqliteRetryable(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return !!descriptor && "value" in descriptor
    && typeof descriptor.value === "string"
    && /^(?:SQLITE_BUSY|SQLITE_LOCKED|SQLITE_IOERR)(?:_|$)/u.test(descriptor.value);
}

function settlementCensusChangedDuringCommit(error: unknown): boolean {
  return continuationRuntimeV1EffectStoreFailureCode(error)
    === "evidence_member_set_not_complete_ledger_census";
}

function parseCohortRef(
  input: ContinuationRuntimeV1WorkerProcessorInput<"effect">,
) {
  try {
    if (input.job.job_kind !== "effect"
      || canonicalContinuationSha256(input.job.payload)
        !== input.job.payload_sha256) {
      processorFailure("effect_settlement_payload_invalid", "dead");
    }
    return continuationRuntimeV1EffectCohortRefFromJobPayload(
      input.job.payload,
    );
  } catch (error) {
    if (error instanceof ContinuationRuntimeV1WorkerProcessorError) throw error;
    processorFailure("effect_settlement_payload_invalid", "dead");
  }
}

function certificateId(job: ContinuationRuntimeV1WorkerAttemptJob<"effect">): string {
  return `effect-${canonicalContinuationSha256({
    schema_version: "effect_certificate_identity_v1",
    tenant_id: job.tenant_id,
    scope: job.scope,
    authority_subject_sha256: job.authority_subject_sha256,
    job_id: job.job_id,
    payload_sha256: job.payload_sha256,
  })}`;
}

function outputFor(
  certificate: SignedEffectCertificateV1,
  eligibleDecisionSet: EffectEvidenceMemberSetV1,
  treatmentDeltaSet: EffectTreatmentDeltaSetV1,
): ContinuationRuntimeV1WorkerSuccessOutput<"effect"> {
  return canonicalContinuationClone({
    kind: "effect" as const,
    signed_certificate: certificate,
    eligible_decision_set: eligibleDecisionSet,
    treatment_delta_set: treatmentDeltaSet,
  });
}

export function createContinuationRuntimeV1EffectWorkerProcessor(
  value: ContinuationRuntimeV1EffectWorkerProcessorInput,
): ContinuationRuntimeV1WorkerProcessor<"effect"> {
  const input = exactRecord(value, FACTORY_KEYS);
  const database = input.database as ContinuationRuntimeV1Database;
  const artifactStore = input.artifactStore as
    ContinuationRuntimeV1AuthorityArtifactReader;
  const policyAuthority = input.policyAuthority as
    ContinuationRuntimeV1PolicyAuthority;
  const signer = input.signer as ContinuationRuntimeV1EffectSigner;
  assertContinuationRuntimeV1AuthorityArtifactReader(artifactStore, database);
  assertContinuationRuntimeV1PolicyAuthority(
    policyAuthority,
    database,
    artifactStore,
  );
  assertSigner(signer);
  const preparation = createContinuationRuntimeV1EffectSettlementPreparation({
    database,
    artifactStore,
    policyAuthority,
  });
  const effectWriter = createContinuationRuntimeV1EffectCertificateWriter(
    database,
    artifactStore,
    policyAuthority,
  );
  assertContinuationRuntimeV1EffectCertificateWriter(
    effectWriter,
    database,
    artifactStore,
    policyAuthority,
  );

  return Object.freeze({
    worker_role: "effect" as const,
    async process(
      processorInput: ContinuationRuntimeV1WorkerProcessorInput<"effect">,
    ): Promise<ContinuationRuntimeV1PreparedWorkerSuccess<"effect">> {
      if (processorInput.signal.aborted) {
        processorFailure("effect_settlement_aborted", "retry");
      }
      const cohortRef = parseCohortRef(processorInput);
      let prepared: Awaited<ReturnType<typeof preparation.prepare>>;
      try {
        prepared = await preparation.prepare({
          tenant_id: processorInput.job.tenant_id,
          scope: processorInput.job.scope,
          authority_subject_sha256:
            processorInput.job.authority_subject_sha256,
          experiment_cohort_ref: cohortRef,
          created_at: processorInput.job.lease_acquired_at,
        });
      } catch (error) {
        if (error instanceof ContinuationRuntimeV1EffectSettlementPreparationError) {
          processorFailure(error.code, error.disposition);
        }
        if (sqliteRetryable(error)) {
          processorFailure("effect_settlement_storage_retry", "retry");
        }
        processorFailure("effect_settlement_authority_invalid", "dead");
      }
      try {
        assertContinuationRuntimeV1EffectSettlementJobPayloadBinding(
          processorInput.job.payload,
          prepared.authority_binding.experiment_cohort_ref,
          prepared.authority_binding.experiment_cohort,
        );
      } catch {
        processorFailure("effect_settlement_payload_invalid", "dead");
      }
      if (processorInput.signal.aborted) {
        processorFailure("effect_settlement_aborted", "retry");
      }
      let certificate: SignedEffectCertificateV1;
      try {
        certificate = buildSignedEffectCertificateV1({
          tenant_id: processorInput.job.tenant_id,
          certificate_id: certificateId(processorInput.job),
          experiment_cohort_ref:
            prepared.authority_binding.experiment_cohort_ref,
          experiment_cohort: prepared.authority_binding.experiment_cohort,
          experiment_cohort_installation_receipt_sha256:
            prepared.experiment_cohort_installation_receipt_sha256,
          assignment_seed_reveal_base64url:
            prepared.assignment_seed_reveal_base64url,
          evidence_policy: prepared.evidence_policy,
          eligible_decision_set: prepared.eligible_decision_set,
          arm_observations: {
            control: {
              assigned_exposure_count:
                prepared.effect_evaluation.control.assigned_exposure_count,
              succeeded_count: prepared.effect_evaluation.control.succeeded_count,
              partial_count: prepared.effect_evaluation.control.partial_count,
              failed_count: prepared.effect_evaluation.control.failed_count,
              unknown_count: prepared.effect_evaluation.control.unknown_count,
              missing_outcome_count:
                prepared.effect_evaluation.control.missing_outcome_count,
            },
            candidate: {
              assigned_exposure_count:
                prepared.effect_evaluation.candidate.assigned_exposure_count,
              succeeded_count:
                prepared.effect_evaluation.candidate.succeeded_count,
              partial_count: prepared.effect_evaluation.candidate.partial_count,
              failed_count: prepared.effect_evaluation.candidate.failed_count,
              unknown_count: prepared.effect_evaluation.candidate.unknown_count,
              missing_outcome_count:
                prepared.effect_evaluation.candidate.missing_outcome_count,
            },
          },
          treatment_delta_set: prepared.treatment_delta_set,
          created_at: prepared.created_at,
        }, signer.privateKey);
      } catch {
        processorFailure("effect_settlement_signer_invalid", "dead");
      }
      if (certificate.verifier_principal_sha256 !== signer.principalSha256
        || certificate.verifier_public_key_spki_base64url
          !== signer.publicKeySpkiBase64url
        || canonicalContinuationJson(certificate.effect_evaluation)
          !== canonicalContinuationJson(prepared.effect_evaluation)) {
        processorFailure("effect_settlement_signer_invalid", "dead");
      }
      const output = outputFor(
        certificate,
        prepared.eligible_decision_set,
        prepared.treatment_delta_set,
      );
      const processJobSha256 = canonicalContinuationSha256(processorInput.job);
      let commitConsumed = false;
      return Object.freeze({
        output,
        commitAuthority: async ({ context, job, output: commitOutput }) => {
          if (commitConsumed
            || canonicalContinuationSha256(job) !== processJobSha256
            || canonicalContinuationJson(commitOutput)
              !== canonicalContinuationJson(output)) {
            processorFailure("effect_settlement_commit_drift", "dead");
          }
          commitConsumed = true;
          try {
            await effectWriter.put(context, {
              signed_certificate: certificate,
              eligible_decision_set: prepared.eligible_decision_set,
              treatment_delta_set: prepared.treatment_delta_set,
              evidence_policy: prepared.evidence_policy_capability,
            });
          } catch (error) {
            if (sqliteRetryable(error)) {
              processorFailure("effect_settlement_commit_storage_retry", "retry");
            }
            if (settlementCensusChangedDuringCommit(error)) {
              // An outcome transaction completing exactly at the inclusive
              // cutoff may become visible after preparation but before this
              // write transaction.  No partial certificate exists; retry from
              // the now-closed ledger to preserve the complete ITT census.
              processorFailure("effect_settlement_commit_census_drift", "retry");
            }
            // This includes ledger/census/policy drift between preparation and
            // commit.  The enclosing operation transaction rolls back the
            // certificate, events and durable-job transition together.
            processorFailure("effect_settlement_commit_invalid", "dead");
          }
        },
      });
    },
  });
}

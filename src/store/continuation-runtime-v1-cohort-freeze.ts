import {
  canonicalContinuationJson,
  type AuthorityBranchRefV1,
  type Sha256,
} from "../continuation/contract.js";
import { verifyExperimentCohortV1 } from
  "../continuation/experiment-cohort.js";
import type { ContinuationRuntimeV1AuthorityArtifactReader } from
  "./continuation-runtime-v1-authority-artifact-reader.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";

export type ContinuationRuntimeV1CohortFreezeV1 = Readonly<{
  experiment_cohort_artifact_sha256: Sha256;
  experiment_cohort_payload_sha256: Sha256;
  candidate_ref: AuthorityBranchRefV1;
  assignment_window_opened_at: string;
  settlement_cutoff_at: string;
}>;

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_cohort_freeze_${code}`);
}

export async function continuationRuntimeV1ActiveCohortFreeze(
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
  args: Readonly<{
    tenant_id: string;
    authority_subject_sha256: Sha256;
    control_ref: AuthorityBranchRefV1;
    at: string;
  }>,
): Promise<ContinuationRuntimeV1CohortFreezeV1 | null> {
  const rows = database.db.prepare(`SELECT artifact_sha256
    FROM authority_artifacts
    WHERE tenant_id = ?
    ORDER BY artifact_id, artifact_revision`).all(args.tenant_id) as Array<
      Readonly<{ artifact_sha256: unknown }>
    >;
  const freezes: ContinuationRuntimeV1CohortFreezeV1[] = [];
  for (const row of rows) {
    if (typeof row.artifact_sha256 !== "string") fail("artifact_projection_corrupt");
    const installed = await artifactStore.readByDigest({
      tenant_id: args.tenant_id,
      artifact_sha256: row.artifact_sha256,
    });
    if (!installed) fail("artifact_projection_corrupt");
    const artifact = installed.signed_artifact;
    if (artifact.artifact_kind !== "experiment_cohort") continue;
    const cohort = verifyExperimentCohortV1(artifact.payload);
    if (cohort.tenant_id !== args.tenant_id
      || cohort.authority_subject_sha256 !== args.authority_subject_sha256
      || canonicalContinuationJson(cohort.control_learning_ref)
        !== canonicalContinuationJson(args.control_ref)
      || args.at < cohort.assignment_window_opened_at
      || args.at > cohort.settlement_cutoff_at) continue;
    const candidate = database.db.prepare(`SELECT 1 AS present
      FROM branch_revisions AS candidate
      WHERE candidate.tenant_id = ?
        AND candidate.authority_subject_sha256 = ?
        AND candidate.branch_id = ?
        AND candidate.branch_revision = ?
        AND candidate.manifest_sha256 = ?
        AND candidate.branch_kind = 'candidate'
        AND candidate.state = 'active_candidate'
        AND NOT EXISTS (
          SELECT 1 FROM branch_revisions AS newer_candidate
          WHERE newer_candidate.tenant_id = candidate.tenant_id
            AND newer_candidate.authority_subject_sha256 =
              candidate.authority_subject_sha256
            AND newer_candidate.branch_id = candidate.branch_id
            AND newer_candidate.branch_revision > candidate.branch_revision
        )`).get(
      args.tenant_id,
      args.authority_subject_sha256,
      cohort.candidate_learning_ref.branch_id,
      cohort.candidate_learning_ref.branch_revision,
      cohort.candidate_learning_ref.manifest_sha256,
    );
    if (!candidate) continue;
    const certified = database.db.prepare(`SELECT 1 AS present
      FROM effect_certificates
      WHERE tenant_id = ?
        AND experiment_cohort_artifact_sha256 = ?
        AND experiment_cohort_payload_sha256 = ?`).get(
      args.tenant_id,
      artifact.artifact_sha256,
      artifact.payload_sha256,
    );
    if (certified) continue;
    freezes.push(Object.freeze({
      experiment_cohort_artifact_sha256: artifact.artifact_sha256,
      experiment_cohort_payload_sha256: artifact.payload_sha256,
      candidate_ref: {
        branch_id: cohort.candidate_learning_ref.branch_id,
        branch_revision: cohort.candidate_learning_ref.branch_revision,
        manifest_sha256: cohort.candidate_learning_ref.manifest_sha256,
      },
      assignment_window_opened_at: cohort.assignment_window_opened_at,
      settlement_cutoff_at: cohort.settlement_cutoff_at,
    }));
  }
  if (freezes.length > 1) fail("cardinality_corrupt");
  return freezes[0] ?? null;
}

export async function assertContinuationRuntimeV1CohortHeadMutationAllowed(
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
  args: Parameters<typeof continuationRuntimeV1ActiveCohortFreeze>[2],
): Promise<void> {
  if (await continuationRuntimeV1ActiveCohortFreeze(
    database,
    artifactStore,
    args,
  ) !== null) {
    fail("head_mutation_frozen");
  }
}

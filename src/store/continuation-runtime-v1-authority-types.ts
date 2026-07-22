import type {
  AuthorityBranchManifestV1,
  AuthoritativeBranchRevisionRefV1,
} from "../continuation/authority-branch.js";
import type {
  AuthorityArtifactRefV1,
  AuthorityBranchRefV1,
  Sha256,
} from "../continuation/contract.js";
import type {
  ContinuationRuntimeV1AuthorityWriteContext,
  ContinuationRuntimeV1OperationLineageV1,
} from "./continuation-runtime-v1-operation-store.js";

export type AuthorityBranchRevisionRecordV1 = Readonly<{
  manifest: AuthorityBranchManifestV1;
  source_operation: ContinuationRuntimeV1OperationLineageV1;
}>;

export type AuthorityHeadV1 = Readonly<{
  schema_version: "authority_head_v1";
  tenant_id: string;
  authority_subject_sha256: Sha256;
  head_revision: number;
  target: AuthoritativeBranchRevisionRefV1;
  source_operation: ContinuationRuntimeV1OperationLineageV1;
  updated_at: string;
  head_sha256: Sha256;
}>;

export type EnsureAuthorityGenesisV1Result = Readonly<{
  created: boolean;
  revision: AuthorityBranchRevisionRecordV1;
  head: AuthorityHeadV1;
}>;

export type AppendAuthorityDecisionV1Result = Readonly<{
  revision: AuthorityBranchRevisionRecordV1;
  head: AuthorityHeadV1;
  head_advanced: boolean;
}>;

export type RotateAuthorityPoliciesV1Args = Readonly<{
  policy_rotation_artifact_ref: AuthorityArtifactRefV1;
  expected_head_revision: number;
  expected_head_sha256: Sha256;
}>;

export type CreateIsolatedCandidateDraftV1Args = Readonly<{
  expected_head_revision: number;
  expected_head_sha256: Sha256;
}>;

type AuthorityDecisionEvidenceV1 = Readonly<{
  reason_codes: readonly string[];
  evidence_sha256s: readonly Sha256[];
}>;

type AuthorityHeadCasV1 = Readonly<{
  expected_head_revision: number;
  expected_head_sha256: Sha256;
}>;

export type AdvanceAuthorityCandidateV1Args = AuthorityDecisionEvidenceV1
  & AuthorityHeadCasV1 & Readonly<{
    authority_subject_sha256: Sha256;
    candidate_ref: AuthorityBranchRefV1;
    target_state: "shadow" | "eligible" | "active_candidate";
  }>;

export type TerminateAuthorityCandidateV1Args = AuthorityDecisionEvidenceV1
  & AuthorityHeadCasV1 & Readonly<{
    authority_subject_sha256: Sha256;
    candidate_ref: AuthorityBranchRefV1;
    target_state: "rejected" | "quarantined" | "expired";
  }>;

export type MergeAuthorityCandidateV1Args = AuthorityHeadCasV1 & Readonly<{
    authority_subject_sha256: Sha256;
    candidate_ref: AuthorityBranchRefV1;
    effect_certificate_sha256: Sha256;
  }>;

export type MergeAuthorityCandidateV1Result = Readonly<{
  candidate_revision: AuthorityBranchRevisionRecordV1;
  authoritative_revision: AuthorityBranchRevisionRecordV1;
  head: AuthorityHeadV1;
}>;

export type RevertAuthorityV1Args = AuthorityDecisionEvidenceV1
  & AuthorityHeadCasV1 & Readonly<{
    authority_subject_sha256: Sha256;
    revert_to_authority_ref: AuthorityBranchRefV1;
  }>;

export type ReadAuthorityBranchRevisionV1Args = Readonly<{
  tenant_id: string;
  authority_subject_sha256: Sha256;
  branch_id: string;
  branch_revision: number;
}>;

export type ReadAuthorityHeadV1Args = Readonly<{
  tenant_id: string;
  authority_subject_sha256: Sha256;
}>;

export type ReadLatestAuthorityBranchRevisionV1Args = Readonly<{
  tenant_id: string;
  authority_subject_sha256: Sha256;
  branch_id: string;
}>;

export type ContinuationRuntimeV1AuthorityStore = Readonly<{
  ensureGenesis(
    context: ContinuationRuntimeV1AuthorityWriteContext,
  ): Promise<EnsureAuthorityGenesisV1Result>;
  rotatePolicies(
    context: ContinuationRuntimeV1AuthorityWriteContext,
    args: RotateAuthorityPoliciesV1Args,
  ): Promise<AppendAuthorityDecisionV1Result>;
  createIsolatedCandidateDraft(
    context: ContinuationRuntimeV1AuthorityWriteContext,
    args: CreateIsolatedCandidateDraftV1Args,
  ): Promise<AppendAuthorityDecisionV1Result | null>;
  advanceCandidate(
    context: ContinuationRuntimeV1AuthorityWriteContext,
    args: AdvanceAuthorityCandidateV1Args,
  ): Promise<AppendAuthorityDecisionV1Result>;
  terminateCandidate(
    context: ContinuationRuntimeV1AuthorityWriteContext,
    args: TerminateAuthorityCandidateV1Args,
  ): Promise<AppendAuthorityDecisionV1Result>;
  mergeCandidate(
    context: ContinuationRuntimeV1AuthorityWriteContext,
    args: MergeAuthorityCandidateV1Args,
  ): Promise<MergeAuthorityCandidateV1Result>;
  revertAuthority(
    context: ContinuationRuntimeV1AuthorityWriteContext,
    args: RevertAuthorityV1Args,
  ): Promise<AppendAuthorityDecisionV1Result>;
  readRevision(
    args: ReadAuthorityBranchRevisionV1Args,
  ): Promise<AuthorityBranchRevisionRecordV1 | null>;
  readLatestRevision(
    args: ReadLatestAuthorityBranchRevisionV1Args,
  ): Promise<AuthorityBranchRevisionRecordV1 | null>;
  readHead(args: ReadAuthorityHeadV1Args): Promise<AuthorityHeadV1 | null>;
}>;

export class ContinuationRuntimeV1AuthorityHeadConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number | null,
    readonly expectedSha256: string,
    readonly actualSha256: string | null,
  ) {
    super("continuation_runtime_v1_authority_head_conflict");
    this.name = "ContinuationRuntimeV1AuthorityHeadConflictError";
  }
}

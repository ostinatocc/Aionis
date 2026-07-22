import type {
  EffectTreatmentDeltaSetV1,
  SignedEffectCertificateV1,
} from "../continuation/effect-certificate.js";
import type {
  EffectEvidenceMemberSetV1,
  EpisodeEventRefV1,
} from "../continuation/episode.js";
import type { Sha256 } from "../continuation/contract.js";
import type {
  VerifiedEvidencePolicyCapabilityV1,
} from "./continuation-runtime-v1-policy-authority.js";
import type {
  ContinuationRuntimeV1AuthorityWriteContext,
  ContinuationRuntimeV1OperationLineageV1,
} from "./continuation-runtime-v1-operation-store.js";

export type PutEffectCertificateV1Args = Readonly<{
  signed_certificate: SignedEffectCertificateV1;
  eligible_decision_set: EffectEvidenceMemberSetV1;
  treatment_delta_set: EffectTreatmentDeltaSetV1;
  evidence_policy: VerifiedEvidencePolicyCapabilityV1;
}>;

export type EffectCertificatePersistResultV1 = Readonly<{
  schema_version: "effect_certificate_persist_result_v1";
  certificate_id: string;
  certificate_sha256: Sha256;
  admission_state: "admitted" | "rejected";
  eligible_decision_count: number;
  treatment_delta_count: number;
  effect_event_refs: readonly EpisodeEventRefV1[];
}>;

export type PersistedEffectCertificateV1 = Readonly<{
  signed_certificate: SignedEffectCertificateV1;
  eligible_decision_set: EffectEvidenceMemberSetV1;
  treatment_delta_set: EffectTreatmentDeltaSetV1;
  effect_event_refs: readonly EpisodeEventRefV1[];
  source_operation: ContinuationRuntimeV1OperationLineageV1;
}>;

declare const VERIFIED_ADMITTED_EFFECT_CERTIFICATE_CAPABILITY: unique symbol;

export type VerifiedAdmittedEffectCertificateCapabilityV1 = Readonly<{
  readonly [VERIFIED_ADMITTED_EFFECT_CERTIFICATE_CAPABILITY]:
    "verified_admitted_effect_certificate_capability_v1";
}>;

export type VerifiedAdmittedEffectCertificateProjectionV1 = Readonly<{
  schema_version: "verified_admitted_effect_certificate_projection_v1";
  tenant_id: string;
  authority_subject_sha256: Sha256;
  certificate_id: string;
  certificate_sha256: Sha256;
  control_branch_ref: SignedEffectCertificateV1["control_branch_ref"];
  candidate_branch_ref: SignedEffectCertificateV1["candidate_branch_ref"];
  compiler_policy_ref: SignedEffectCertificateV1["compiler_policy_ref"];
  evidence_policy_ref: SignedEffectCertificateV1["evidence_policy_ref"];
  treatment_delta_set_sha256: Sha256;
}>;

export type ReadEffectCertificateV1Args = Readonly<{
  tenant_id: string;
  certificate_sha256: Sha256;
}>;

export type ReadEffectCertificateResultV1 = Readonly<{
  record: PersistedEffectCertificateV1;
  admitted_capability: VerifiedAdmittedEffectCertificateCapabilityV1 | null;
}>;

export type ContinuationRuntimeV1EffectCertificateReader = Readonly<{
  read(
    args: ReadEffectCertificateV1Args,
  ): Promise<ReadEffectCertificateResultV1 | null>;
}>;

export type ContinuationRuntimeV1EffectCertificateWriter = Readonly<{
  put(
    context: ContinuationRuntimeV1AuthorityWriteContext,
    args: PutEffectCertificateV1Args,
  ): Promise<EffectCertificatePersistResultV1>;
}>;

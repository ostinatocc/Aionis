import {
  canonicalContinuationClone,
  canonicalContinuationJson,
} from "../continuation/contract.js";
import {
  verifyEffectTreatmentDeltaSetV1,
  verifySignedEffectCertificateV1,
  type EffectTreatmentDeltaSetV1,
  type EffectEvidencePolicyArtifactBindingV1,
  type SignedEffectCertificateV1,
} from "../continuation/effect-certificate.js";
import { evaluateEffectEvidenceV1 } from "../continuation/effect-evaluation.js";
import {
  buildEffectEvidenceMemberSetV1,
  episodeEventRefV1,
  verifyEffectEvidenceMemberSetV1,
  type EffectEvidenceMemberSetV1,
  type EpisodeEventV1,
} from "../continuation/episode.js";
import type { ContinuationRuntimeV1AuthorityArtifactReader } from
  "./continuation-runtime-v1-authority-artifact-reader.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import type { PersistedEffectCertificateV1 } from
  "./continuation-runtime-v1-effect-certificate-types.js";
import {
  canonicalText,
  canonicalTime,
  decodeEpisodeEventRow,
  effectStoreFail,
  parseCanonicalObject,
  readExactBranch,
  readTreatmentDelta,
  resolveEffectMembers,
  sha256,
  verifyCertificateSourceReceipt,
  verifyEventSourceReceipt,
  verifyTreatmentDelta,
  type SqlRow,
} from "./continuation-runtime-v1-effect-certificate-support.js";
import type {
  ContinuationRuntimeV1PolicyAuthority,
  VerifiedEvidencePolicyCapabilityV1,
} from "./continuation-runtime-v1-policy-authority.js";

export function effectEventsFromRows(
  database: ContinuationRuntimeV1Database,
  row: SqlRow,
): readonly EpisodeEventV1[] {
  const rows = database.db.prepare(`SELECT * FROM episode_events
    WHERE tenant_id = ? AND effect_certificate_sha256 = ?
      AND event_kind = 'effect_certified'
    ORDER BY effect_member_sequence`).all(
    row.tenant_id,
    row.certificate_sha256,
  ) as SqlRow[];
  return rows.map((eventRow) => decodeEpisodeEventRow(database, eventRow));
}

export function memberSetFromEffectEvents(
  events: readonly EpisodeEventV1[],
): EffectEvidenceMemberSetV1 {
  return buildEffectEvidenceMemberSetV1(events.map((event, index) => {
    if (event.event_kind !== "effect_certified"
      || event.effect_member_sequence !== index + 1
      || event.effect_certificate_sha256 === null
      || event.payload.payload_kind !== "effect_certified_v1"
      || event.payload.evidence_member.member_sequence !== index + 1
      || canonicalContinuationJson(event.payload.evidence_member.terminal_event)
        !== canonicalContinuationJson(event.cause_event_ref)) {
      effectStoreFail("corrupt:effect_member_event");
    }
    return {
      scope: event.payload.evidence_member.scope,
      episode_id: event.payload.evidence_member.episode_id,
      decision_id: event.payload.evidence_member.decision_id,
      terminal_event: event.payload.evidence_member.terminal_event,
    };
  }));
}

function signedCertificateJson(row: SqlRow): SignedEffectCertificateV1 {
  return parseCanonicalObject(
    row.certificate_json,
    "certificate_json",
  ) as unknown as SignedEffectCertificateV1;
}

function assertCertificateColumns(
  row: SqlRow,
  certificate: SignedEffectCertificateV1,
): void {
  const signature = row.signature;
  if (!(signature instanceof Uint8Array)
    || signature.byteLength !== 64
    || Buffer.from(signature).toString("base64url") !== certificate.signature
    || row.tenant_id !== certificate.tenant_id
    || row.certificate_id !== certificate.certificate_id
    || row.certificate_sha256 !== certificate.certificate_sha256
    || row.authority_subject_sha256 !== certificate.authority_subject_sha256
    || row.experiment_cohort_artifact_sha256
      !== certificate.experiment_cohort_ref.artifact_sha256
    || row.experiment_cohort_payload_sha256
      !== certificate.experiment_cohort_ref.payload_sha256
    || row.experiment_cohort_kind !== "experiment_cohort"
    || row.experiment_cohort_installation_receipt_sha256
      !== certificate.experiment_cohort_installation_receipt_sha256
    || row.assignment_seed_commitment_sha256
      !== certificate.assignment_seed_commitment_sha256
    || !(row.assignment_seed_reveal instanceof Uint8Array)
    || Buffer.from(row.assignment_seed_reveal).toString("base64url")
      !== certificate.assignment_seed_reveal_base64url
    || row.control_branch_id !== certificate.control_branch_ref.branch_id
    || row.control_branch_revision !== certificate.control_branch_ref.branch_revision
    || row.control_manifest_sha256 !== certificate.control_branch_ref.manifest_sha256
    || row.control_branch_kind !== certificate.control_branch_ref.branch_kind
    || row.control_branch_state !== certificate.control_branch_ref.state
    || row.candidate_branch_id !== certificate.candidate_branch_ref.branch_id
    || row.candidate_branch_revision !== certificate.candidate_branch_ref.branch_revision
    || row.candidate_manifest_sha256 !== certificate.candidate_branch_ref.manifest_sha256
    || row.candidate_branch_kind !== certificate.candidate_branch_ref.branch_kind
    || row.candidate_branch_state !== certificate.candidate_branch_ref.state
    || row.compiler_policy_artifact_sha256
      !== certificate.compiler_policy_ref.artifact_sha256
    || row.compiler_policy_payload_sha256
      !== certificate.compiler_policy_ref.payload_sha256
    || row.compiler_policy_kind !== "compiler_policy"
    || row.evidence_policy_artifact_sha256
      !== certificate.evidence_policy_ref.artifact_sha256
    || row.evidence_policy_payload_sha256
      !== certificate.evidence_policy_ref.payload_sha256
    || row.evidence_policy_kind !== "evidence_policy"
    || row.evidence_window_sha256 !== certificate.evidence_window_sha256
    || row.effect_verifier_contract_sha256
      !== certificate.effect_verifier_contract_sha256
    || row.statistical_contract_sha256 !== certificate.statistical_contract_sha256
    || row.eligible_decision_count !== certificate.eligible_decision_count
    || row.eligible_decision_set_sha256 !== certificate.eligible_decision_set_sha256
    || row.missingness_bps !== certificate.missingness_bps
    || row.harm_conclusion !== certificate.harm_conclusion
    || row.utility_conclusion !== certificate.utility_conclusion
    || row.admission_state !== certificate.admission_state
    || row.effect_evaluation_sha256 !== certificate.effect_evaluation_sha256
    || row.effect_evaluation_json
      !== canonicalContinuationJson(certificate.effect_evaluation)
    || row.treatment_delta_count !== certificate.treatment_delta_count
    || row.treatment_delta_set_sha256 !== certificate.treatment_delta_set_sha256
    || row.verifier_principal_sha256 !== certificate.verifier_principal_sha256
    || row.verifier_public_key_spki_base64url
      !== certificate.verifier_public_key_spki_base64url
    || row.trust_root_sha256 !== certificate.trust_root_sha256
    || row.signature_algorithm !== certificate.signature_algorithm
    || row.window_opened_at !== certificate.window_opened_at
    || row.window_closed_at !== certificate.window_closed_at
    || row.settlement_cutoff_at
      !== certificate.experiment_cohort.settlement_cutoff_at
    || row.created_at !== certificate.created_at
    || row.certificate_json !== canonicalContinuationJson(certificate)) {
    effectStoreFail("corrupt:certificate_column_projection");
  }
}

async function verifiedPolicyBinding(
  policyAuthority: ContinuationRuntimeV1PolicyAuthority,
  certificate: SignedEffectCertificateV1,
  suppliedCapability: VerifiedEvidencePolicyCapabilityV1 | null,
): Promise<EffectEvidencePolicyArtifactBindingV1> {
  const fresh = await policyAuthority.resolveExact({
    tenant_id: certificate.tenant_id,
    authority_subject_sha256: certificate.authority_subject_sha256,
    artifact_kind: "evidence_policy",
    artifact_ref: certificate.evidence_policy_ref,
    at: certificate.experiment_cohort.assignment_window_opened_at,
  });
  const binding = policyAuthority.evidenceBinding(fresh);
  if (suppliedCapability !== null
    && canonicalContinuationJson(policyAuthority.evidenceBinding(suppliedCapability))
      !== canonicalContinuationJson(binding)) {
    effectStoreFail("evidence_policy_capability_mismatch");
  }
  return binding;
}

async function verifyCompilerAtExposures(
  policyAuthority: ContinuationRuntimeV1PolicyAuthority,
  certificate: SignedEffectCertificateV1,
  exposures: readonly EpisodeEventV1[],
): Promise<void> {
  for (const exposure of exposures) {
    await policyAuthority.resolveExact({
      tenant_id: certificate.tenant_id,
      authority_subject_sha256: certificate.authority_subject_sha256,
      artifact_kind: "compiler_policy",
      artifact_ref: certificate.compiler_policy_ref,
      at: exposure.created_at,
    });
  }
}

async function verifyExperimentCohortAuthority(
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
  certificate: SignedEffectCertificateV1,
): Promise<void> {
  const installed = await artifactStore.readByDigest({
    tenant_id: certificate.tenant_id,
    artifact_sha256: certificate.experiment_cohort_ref.artifact_sha256,
  });
  if (!installed
    || installed.signed_artifact.artifact_kind !== "experiment_cohort"
    || installed.signed_artifact.artifact_schema !== "experiment_cohort_v1"
    || installed.signed_artifact.payload_sha256
      !== certificate.experiment_cohort_ref.payload_sha256
    || installed.signed_artifact.authority_subject_sha256
      !== certificate.authority_subject_sha256
    || canonicalContinuationJson(installed.signed_artifact.payload)
      !== canonicalContinuationJson(certificate.experiment_cohort)) {
    effectStoreFail("experiment_cohort_authority_binding_mismatch");
  }
  const operation = database.db.prepare(`SELECT receipt_sha256, receipt_json
    FROM operations WHERE tenant_id=? AND scope=? AND operation_kind='authority_decision'
      AND operation_id=? AND request_sha256=?`).get(
    installed.installation.tenant_id,
    installed.installation.scope,
    installed.installation.operation_id,
    installed.installation.request_sha256,
  ) as SqlRow | undefined;
  if (!operation
    || operation.receipt_sha256
      !== certificate.experiment_cohort_installation_receipt_sha256) {
    effectStoreFail("experiment_cohort_installation_receipt_mismatch");
  }
  const receipt = parseCanonicalObject(
    operation.receipt_json,
    "experiment_cohort_installation_receipt_json",
  );
  const result = receipt.result as Readonly<Record<string, unknown>> | undefined;
  if (receipt.schema_version !== "continuation_runtime_operation_receipt_v1"
    || receipt.actor_kind !== "operator"
    || result?.schema_version !== "authority_decision_result_v1"
    || result.decision_kind !== "experiment_cohort_install"
    || canonicalContinuationJson(result.experiment_cohort_ref)
      !== canonicalContinuationJson(certificate.experiment_cohort_ref)) {
    effectStoreFail("experiment_cohort_installation_receipt_invalid");
  }
}

export async function verifyEffectCertificateMaterialV1(
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
  policyAuthority: ContinuationRuntimeV1PolicyAuthority,
  certificate: SignedEffectCertificateV1,
  members: EffectEvidenceMemberSetV1,
  treatmentDelta: EffectTreatmentDeltaSetV1,
  operationScope: string,
  suppliedCapability: VerifiedEvidencePolicyCapabilityV1 | null,
): Promise<void> {
  await verifyExperimentCohortAuthority(database, artifactStore, certificate);
  const binding = await verifiedPolicyBinding(
    policyAuthority,
    certificate,
    suppliedCapability,
  );
  const verifiedMembers = verifyEffectEvidenceMemberSetV1(members);
  const verifiedDelta = verifyEffectTreatmentDeltaSetV1(treatmentDelta);
  verifySignedEffectCertificateV1(
    certificate,
    binding,
    verifiedMembers,
    verifiedDelta,
  );
  const control = readExactBranch(database, certificate, "control");
  const candidate = readExactBranch(database, certificate, "candidate");
  if (control.created_at > certificate.window_opened_at
    || candidate.created_at > certificate.window_opened_at) {
    effectStoreFail("branch_created_after_evidence_window_opened");
  }
  verifyTreatmentDelta(certificate, control, candidate, verifiedDelta);
  const resolved = resolveEffectMembers(
    database,
    certificate,
    verifiedMembers,
    operationScope,
  );
  if (resolved.missingness_bps !== certificate.missingness_bps) {
    effectStoreFail("missingness_bps_mismatch");
  }
  const derivedEvaluation = evaluateEffectEvidenceV1({
    policy: {
      min_control_exposures: binding.payload.min_control_exposures,
      min_candidate_exposures: binding.payload.min_candidate_exposures,
      max_missingness_bps: binding.payload.max_missingness_bps,
      harm_noninferiority_margin_bps:
        binding.payload.harm_noninferiority_margin_bps,
      utility_min_lift_bps: binding.payload.utility_min_lift_bps,
      confidence_bps: binding.payload.confidence_bps,
    },
    control: resolved.control_observations,
    candidate: resolved.candidate_observations,
  });
  if (canonicalContinuationJson(derivedEvaluation)
    !== canonicalContinuationJson(certificate.effect_evaluation)) {
    effectStoreFail("effect_evaluation_not_derived_from_exact_cohort_census");
  }
  await verifyCompilerAtExposures(policyAuthority, certificate, resolved.exposures);
}

export async function hydrateEffectCertificateRowV1(
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
  policyAuthority: ContinuationRuntimeV1PolicyAuthority,
  row: SqlRow,
): Promise<PersistedEffectCertificateV1> {
  const certificateJson = signedCertificateJson(row);
  const events = effectEventsFromRows(database, row);
  const members = memberSetFromEffectEvents(events);
  const treatmentDelta = readTreatmentDelta(
    database,
    canonicalText(row.tenant_id, "corrupt:certificate_tenant_id"),
    sha256(row.certificate_sha256, "corrupt:certificate_sha256"),
  );
  const binding = await verifiedPolicyBinding(policyAuthority, certificateJson, null);
  const certificate = verifySignedEffectCertificateV1(
    certificateJson,
    binding,
    members,
    treatmentDelta,
  );
  assertCertificateColumns(row, certificate);
  const operationScope = canonicalText(
    row.source_operation_scope,
    "corrupt:certificate_operation_scope",
  );
  await verifyEffectCertificateMaterialV1(
    database,
    artifactStore,
    policyAuthority,
    certificate,
    members,
    treatmentDelta,
    operationScope,
    null,
  );
  const source = verifyCertificateSourceReceipt(database, row);
  if (source.operation_kind !== "worker_completion") {
    effectStoreFail("corrupt:certificate_source_operation_kind");
  }
  const operationRows = database.db.prepare(`SELECT count(*) AS count
    FROM effect_certificates WHERE tenant_id = ?
      AND source_operation_scope = ? AND source_operation_kind = ?
      AND source_operation_id = ? AND source_request_sha256 = ?`).get(
    source.tenant_id,
    source.scope,
    source.operation_kind,
    source.operation_id,
    source.request_sha256,
  ) as SqlRow;
  if (operationRows.count !== 1) {
    effectStoreFail("corrupt:certificate_source_operation_cardinality");
  }
  const completedRow = database.db.prepare(`SELECT completed_at FROM operations
    WHERE tenant_id = ? AND scope = ? AND operation_kind = ?
      AND operation_id = ? AND request_sha256 = ?`).get(
    source.tenant_id,
    source.scope,
    source.operation_kind,
    source.operation_id,
    source.request_sha256,
  ) as SqlRow | undefined;
  if (!completedRow || canonicalTime(
    completedRow.completed_at,
    "corrupt:certificate_source_completed_at",
  ) < certificate.created_at) {
    effectStoreFail("corrupt:certificate_source_completed_before_certificate");
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const causeRow = database.db.prepare(`SELECT * FROM episode_events
      WHERE tenant_id = ? AND scope = ? AND episode_id = ?
        AND event_sequence = ? AND event_id = ? AND event_kind = ?
        AND event_sha256 = ?`).get(
      event.tenant_id,
      event.scope,
      event.episode_id,
      event.cause_event_ref!.event_sequence,
      event.cause_event_ref!.event_id,
      event.cause_event_ref!.event_kind,
      event.cause_event_ref!.event_sha256,
    ) as SqlRow | undefined;
    if (!causeRow) effectStoreFail("corrupt:effect_event_cause_missing");
    const cause = decodeEpisodeEventRow(database, causeRow);
    if (event.effect_certificate_sha256 !== certificate.certificate_sha256
      || event.effect_member_sequence !== index + 1
      || event.created_at !== certificate.created_at
      || event.source_operation.operation_kind !== source.operation_kind
      || event.source_operation.operation_id !== source.operation_id
      || event.source_operation.request_sha256 !== source.request_sha256
      || canonicalContinuationJson(event.context)
        !== canonicalContinuationJson(cause.context)
      || canonicalContinuationJson(event.cause_event_ref)
        !== canonicalContinuationJson(episodeEventRefV1(cause))) {
      effectStoreFail("corrupt:effect_event_projection");
    }
    const eventSource = verifyEventSourceReceipt(database, event);
    if (canonicalContinuationJson(eventSource) !== canonicalContinuationJson(source)) {
      effectStoreFail("corrupt:effect_event_source_operation");
    }
  }
  return canonicalContinuationClone({
    signed_certificate: certificate,
    eligible_decision_set: members,
    treatment_delta_set: treatmentDelta,
    effect_event_refs: events.map(episodeEventRefV1),
    source_operation: source,
  });
}

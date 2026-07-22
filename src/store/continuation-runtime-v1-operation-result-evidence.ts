import {
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
} from "../continuation/contract.js";
import { verifyClosedContinuationExposureProjectionV1 } from
  "../continuation/contract-verifier.js";
import {
  buildEffectTreatmentDeltaSetV1,
  verifyEffectEvidencePolicyV1,
  verifySignedEffectCertificateV1,
} from "../continuation/effect-certificate.js";
import {
  buildEffectEvidenceMemberSetV1,
  buildEpisodeCapsuleFactSetV1,
  buildEpisodeCapsuleFactV1,
  episodeEventRefV1,
  type EpisodeEventV1,
} from "../continuation/episode.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import {
  decodeContinuationRuntimeV1EpisodeEventRow as decodeEpisodeEventRow,
  type ContinuationRuntimeV1SqlRow as SqlRow,
} from "./continuation-runtime-v1-episode-row.js";
import type {
  ContinuationRuntimeV1OperationResultDerivationBinding,
  CreateContinuationOperationResultV1,
  EffectCertificateOperationRefV1,
  RecordOutcomeOperationResultV1,
} from "./continuation-runtime-v1-operation-result.js";
import {
  operationResultCanonicalJson,
  operationResultFail,
  operationResultInteger,
  operationResultSha256,
  operationResultText,
  type OperationResultRow,
} from "./continuation-runtime-v1-operation-result-support.js";

function sourceRows(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
): readonly SqlRow[] {
  return database.db.prepare(`SELECT * FROM episode_events
    WHERE tenant_id = ? AND scope = ? AND source_operation_kind = ?
      AND source_operation_id = ? AND source_request_sha256 = ?
    ORDER BY episode_id, event_sequence`).all(
      binding.tenantId,
      binding.scope,
      binding.operationKind,
      binding.operationId,
      binding.requestSha256,
    ) as SqlRow[];
}

function assertServingProjection(row: SqlRow, event: EpisodeEventV1): void {
  if (event.event_kind !== "contract_exposed") {
    if (row.serving_mode !== null
      || row.experiment_cohort_artifact_sha256 !== null
      || row.experiment_cohort_payload_sha256 !== null
      || row.serving_assignment_receipt_sha256 !== null) {
      operationResultFail("non_exposure_serving_projection_present");
    }
    return;
  }
  const payload = event.payload;
  if (payload.payload_kind !== "contract_exposed_v1") {
    operationResultFail("exposure_payload_kind_invalid");
  }
  const authority = verifyClosedContinuationExposureProjectionV1({
    contract: payload.continuation_contract,
    renderResult: payload.render_result,
  }).contract.authority;
  const cohort = authority.experiment_cohort_ref;
  const receipt = authority.serving_assignment_receipt;
  if (row.serving_mode !== authority.serving_mode) {
    operationResultFail("exposure_serving_mode_projection_mismatch");
  }
  if (cohort === null) {
    if (row.experiment_cohort_artifact_sha256 !== null
      || row.experiment_cohort_payload_sha256 !== null
      || row.serving_assignment_receipt_sha256 !== null
      || receipt !== null) {
      operationResultFail("unassigned_exposure_projection_mismatch");
    }
    return;
  }
  if (receipt === null
    || row.experiment_cohort_artifact_sha256 !== cohort.artifact_sha256
    || row.experiment_cohort_payload_sha256 !== cohort.payload_sha256
    || row.serving_assignment_receipt_sha256
      !== receipt.serving_assignment_receipt_sha256) {
    operationResultFail("assigned_exposure_projection_mismatch");
  }
}

function verifyFactSet(
  database: ContinuationRuntimeV1Database,
  row: SqlRow,
  event: EpisodeEventV1,
): void {
  const factRows = database.db.prepare(`SELECT * FROM episode_capsule_facts
    WHERE tenant_id = ? AND scope = ? AND episode_id = ? AND event_sequence = ?
    ORDER BY fact_sequence`).all(
      event.tenant_id,
      event.scope,
      event.episode_id,
      event.event_sequence,
    ) as SqlRow[];
  if (event.event_kind !== "contract_exposed"
    && event.event_kind !== "capsule_use_observed") {
    if (factRows.length !== 0 || row.capsule_fact_count !== null
      || row.capsule_fact_set_sha256 !== null) {
      operationResultFail("episode_non_fact_event_has_facts");
    }
    return;
  }
  const inputs = factRows.map((factRow, index) => {
    const input = {
      capsule_scope: operationResultText(
        factRow.capsule_scope,
        `fact_${index}_capsule_scope`,
      ),
      capsule_id: operationResultText(
        factRow.capsule_id,
        `fact_${index}_capsule_id`,
      ),
      capsule_revision: operationResultInteger(
        factRow.capsule_revision,
        `fact_${index}_capsule_revision`,
        1,
      ),
      capsule_sha256: operationResultSha256(
        factRow.capsule_sha256,
        `fact_${index}_capsule`,
      ),
      surface: factRow.surface,
      use_state: factRow.use_state,
    } as const;
    const persisted = buildEpisodeCapsuleFactV1({
      tenant_id: event.tenant_id,
      scope: event.scope,
      episode_id: event.episode_id,
      event_ref: episodeEventRefV1(event) as never,
      fact: {
        ...input,
        fact_sequence: operationResultInteger(
          factRow.fact_sequence,
          `fact_${index}_sequence`,
          1,
          256,
        ),
      } as never,
    });
    if (persisted.fact_sha256 !== factRow.fact_sha256
      || persisted.fact.fact_sequence !== index + 1) {
      operationResultFail("episode_fact_projection_mismatch");
    }
    return input;
  });
  const rebuilt = buildEpisodeCapsuleFactSetV1(
    event.event_kind,
    inputs as never,
  );
  if (rebuilt.capsule_fact_count !== row.capsule_fact_count
    || rebuilt.capsule_fact_set_sha256 !== row.capsule_fact_set_sha256) {
    operationResultFail("episode_fact_set_mismatch");
  }
}

function verifiedSourceEvents(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
): readonly EpisodeEventV1[] {
  const rows = sourceRows(database, binding);
  return rows.map((row) => {
    const event = decodeEpisodeEventRow(database, row);
    assertServingProjection(row, event);
    verifyFactSet(database, row, event);
    return event;
  });
}

export function deriveCreateContinuationOperationResultV1(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
): CreateContinuationOperationResultV1 {
  const events = verifiedSourceEvents(database, binding);
  if (events.length !== 1 || events[0]!.event_kind !== "contract_exposed") {
    operationResultFail("create_continuation_event_census_mismatch");
  }
  const event = events[0]!;
  return canonicalContinuationClone({
    schema_version: "create_continuation_result_v1" as const,
    episode_id: event.episode_id,
    decision_id: event.context.decision_id,
    event_refs: [episodeEventRefV1(event)],
  });
}

export function deriveRecordOutcomeOperationResultV1(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
): RecordOutcomeOperationResultV1 {
  const events = verifiedSourceEvents(database, binding);
  if (events.length !== 2
    || events[0]!.event_kind !== "capsule_use_observed"
    || events[1]!.event_kind !== "outcome_observed"
    || events[0]!.episode_id !== events[1]!.episode_id
    || events[0]!.context.decision_id !== events[1]!.context.decision_id) {
    operationResultFail("record_outcome_event_census_mismatch");
  }
  return canonicalContinuationClone({
    schema_version: "record_outcome_result_v1" as const,
    episode_id: events[0]!.episode_id,
    decision_id: events[0]!.context.decision_id,
    event_refs: events.map(episodeEventRefV1),
  });
}

function effectEvents(
  database: ContinuationRuntimeV1Database,
  tenantId: string,
  certificateSha256: string,
): readonly EpisodeEventV1[] {
  const rows = database.db.prepare(`SELECT * FROM episode_events
    WHERE tenant_id = ? AND effect_certificate_sha256 = ?
      AND event_kind = 'effect_certified'
    ORDER BY effect_member_sequence`).all(
      tenantId,
      certificateSha256,
    ) as SqlRow[];
  return rows.map((row) => {
    const event = decodeEpisodeEventRow(database, row);
    assertServingProjection(row, event);
    verifyFactSet(database, row, event);
    return event;
  });
}

function effectTreatmentDelta(
  database: ContinuationRuntimeV1Database,
  tenantId: string,
  certificateSha256: string,
) {
  const rows = database.db.prepare(`SELECT * FROM effect_certificate_treatment_members
    WHERE tenant_id = ? AND certificate_sha256 = ? ORDER BY member_sequence`).all(
      tenantId,
      certificateSha256,
    ) as OperationResultRow[];
  const binding = (value: unknown, field: string) => value === null
    ? null
    : operationResultCanonicalJson(value, field) as never;
  const set = buildEffectTreatmentDeltaSetV1(rows.map((row) => ({
    capsule_scope: operationResultText(row.capsule_scope, "treatment_capsule_scope"),
    capsule_id: operationResultText(row.capsule_id, "treatment_capsule_id"),
    change_kind: row.change_kind as "added" | "removed" | "changed",
    before_binding: binding(row.before_binding_json, "treatment_before_binding"),
    after_binding: binding(row.after_binding_json, "treatment_after_binding"),
  })));
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]!.member_sequence !== index + 1
      || rows[index]!.member_sha256 !== set.members[index]!.member_sha256
      || rows[index]!.treatment_delta_set_sha256
        !== set.treatment_delta_set_sha256) {
      operationResultFail("effect_treatment_delta_projection_mismatch");
    }
  }
  return set;
}

function evidencePolicyBinding(
  database: ContinuationRuntimeV1Database,
  row: OperationResultRow,
) {
  const artifact = database.db.prepare(`SELECT payload_json, payload_sha256,
      artifact_sha256, trust_root_sha256 FROM authority_artifacts
      WHERE tenant_id = ? AND artifact_kind = 'evidence_policy'
        AND artifact_sha256 = ? AND payload_sha256 = ?`).get(
        row.tenant_id,
        row.evidence_policy_artifact_sha256,
        row.evidence_policy_payload_sha256,
      ) as OperationResultRow | undefined;
  if (!artifact) operationResultFail("effect_evidence_policy_missing");
  const payload = verifyEffectEvidencePolicyV1(
    operationResultCanonicalJson(artifact.payload_json, "effect_evidence_policy"),
  );
  if (canonicalContinuationSha256(payload) !== artifact.payload_sha256) {
    operationResultFail("effect_evidence_policy_digest_mismatch");
  }
  return canonicalContinuationClone({
    artifact_ref: {
      artifact_sha256: operationResultSha256(artifact.artifact_sha256, "evidence_artifact"),
      payload_sha256: operationResultSha256(artifact.payload_sha256, "evidence_payload"),
    },
    trust_root_sha256: operationResultSha256(
      artifact.trust_root_sha256,
      "evidence_trust_root",
    ),
    payload,
  });
}

export function deriveEffectCertificateOperationRefV1(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
): EffectCertificateOperationRefV1 | null {
  const rows = database.db.prepare(`SELECT * FROM effect_certificates
    WHERE tenant_id = ? AND source_operation_scope = ?
      AND source_operation_kind = ? AND source_operation_id = ?
      AND source_request_sha256 = ?`).all(
        binding.tenantId,
        binding.scope,
        binding.operationKind,
        binding.operationId,
        binding.requestSha256,
      ) as OperationResultRow[];
  if (rows.length > 1) operationResultFail("effect_certificate_cardinality");
  const row = rows[0];
  if (!row) return null;
  const rawCertificate = operationResultCanonicalJson(
    row.certificate_json,
    "effect_certificate",
  );
  const certificateSha = operationResultSha256(
    row.certificate_sha256,
    "effect_certificate",
  );
  const events = effectEvents(database, binding.tenantId, certificateSha);
  const memberSet = buildEffectEvidenceMemberSetV1(events.map((event, index) => {
    if (event.effect_member_sequence !== index + 1
      || event.effect_certificate_sha256 !== certificateSha
      || event.payload.payload_kind !== "effect_certified_v1"
      || event.payload.evidence_member.member_sequence !== index + 1
      || canonicalContinuationJson(event.payload.evidence_member.terminal_event)
        !== canonicalContinuationJson(event.cause_event_ref)) {
      operationResultFail("effect_event_member_projection_mismatch");
    }
    return {
      scope: event.payload.evidence_member.scope,
      episode_id: event.payload.evidence_member.episode_id,
      decision_id: event.payload.evidence_member.decision_id,
      terminal_event: event.payload.evidence_member.terminal_event,
    };
  }));
  const treatmentDelta = effectTreatmentDelta(
    database,
    binding.tenantId,
    certificateSha,
  );
  const certificate = verifySignedEffectCertificateV1(
    rawCertificate,
    evidencePolicyBinding(database, row),
    memberSet,
    treatmentDelta,
  );
  const projectionChecks: readonly [unknown, unknown][] = [
    [row.certificate_id, certificate.certificate_id],
    [row.certificate_sha256, certificate.certificate_sha256],
    [row.authority_subject_sha256, certificate.authority_subject_sha256],
    [row.experiment_cohort_artifact_sha256,
      certificate.experiment_cohort_ref.artifact_sha256],
    [row.experiment_cohort_payload_sha256,
      certificate.experiment_cohort_ref.payload_sha256],
    [row.experiment_cohort_kind, "experiment_cohort"],
    [row.experiment_cohort_installation_receipt_sha256,
      certificate.experiment_cohort_installation_receipt_sha256],
    [row.assignment_seed_commitment_sha256,
      certificate.assignment_seed_commitment_sha256],
    [row.eligible_decision_count, certificate.eligible_decision_count],
    [row.eligible_decision_set_sha256, certificate.eligible_decision_set_sha256],
    [row.missingness_bps, certificate.missingness_bps],
    [row.harm_conclusion, certificate.harm_conclusion],
    [row.utility_conclusion, certificate.utility_conclusion],
    [row.admission_state, certificate.admission_state],
    [row.effect_evaluation_sha256, certificate.effect_evaluation_sha256],
    [row.effect_evaluation_json,
      canonicalContinuationJson(certificate.effect_evaluation)],
    [row.treatment_delta_count, certificate.treatment_delta_count],
    [row.treatment_delta_set_sha256, certificate.treatment_delta_set_sha256],
    [row.verifier_principal_sha256, certificate.verifier_principal_sha256],
    [row.trust_root_sha256, certificate.trust_root_sha256],
    [row.signature_algorithm, certificate.signature_algorithm],
    [row.window_opened_at, certificate.window_opened_at],
    [row.window_closed_at, certificate.window_closed_at],
    [row.settlement_cutoff_at,
      certificate.experiment_cohort.settlement_cutoff_at],
    [row.created_at, certificate.created_at],
  ];
  if (projectionChecks.some(([persisted, expected]) => persisted !== expected)
    || !(row.assignment_seed_reveal instanceof Uint8Array)
    || Buffer.from(row.assignment_seed_reveal).toString("base64url")
      !== certificate.assignment_seed_reveal_base64url
    || canonicalContinuationJson(certificate.control_branch_ref)
      !== canonicalContinuationJson({
        branch_id: row.control_branch_id,
        branch_revision: row.control_branch_revision,
        manifest_sha256: row.control_manifest_sha256,
        branch_kind: row.control_branch_kind,
        state: row.control_branch_state,
      })
    || canonicalContinuationJson(certificate.candidate_branch_ref)
      !== canonicalContinuationJson({
        branch_id: row.candidate_branch_id,
        branch_revision: row.candidate_branch_revision,
        manifest_sha256: row.candidate_manifest_sha256,
        branch_kind: row.candidate_branch_kind,
        state: row.candidate_branch_state,
      })) {
    operationResultFail("effect_certificate_projection_mismatch");
  }
  return canonicalContinuationClone({
    certificate_id: certificate.certificate_id,
    certificate_sha256: certificate.certificate_sha256,
    certificate_projection_sha256: canonicalContinuationSha256(certificate),
    admission_state: certificate.admission_state,
    eligible_decision_count: memberSet.eligible_decision_count,
    eligible_decision_set_sha256: memberSet.eligible_decision_set_sha256,
    treatment_delta_count: treatmentDelta.treatment_delta_count,
    treatment_delta_set_sha256: treatmentDelta.treatment_delta_set_sha256,
    effect_event_count: events.length,
    effect_event_set_sha256: canonicalContinuationSha256(
      events.map(episodeEventRefV1),
    ),
  });
}

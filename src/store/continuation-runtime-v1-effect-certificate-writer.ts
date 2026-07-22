import {
  canonicalContinuationClone,
  canonicalContinuationJson,
} from "../continuation/contract.js";
import {
  verifyEffectTreatmentDeltaSetV1,
  verifySignedEffectCertificateV1,
  type EffectTreatmentDeltaSetV1,
  type SignedEffectCertificateV1,
} from "../continuation/effect-certificate.js";
import {
  buildEpisodeEventV1,
  episodeEventRefV1,
  verifyEffectEvidenceMemberSetV1,
  type EpisodeEventV1,
} from "../continuation/episode.js";
import {
  assertContinuationRuntimeV1AuthorityArtifactReader,
  type ContinuationRuntimeV1AuthorityArtifactReader,
} from "./continuation-runtime-v1-authority-artifact-reader.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import {
  decodeEpisodeEventRow,
  effectStoreFail,
  exactRecord,
  readTreatmentDelta,
  resolveEffectMembers,
  type SqlRow,
} from "./continuation-runtime-v1-effect-certificate-support.js";
import type {
  ContinuationRuntimeV1EffectCertificateWriter,
  EffectCertificatePersistResultV1,
  PutEffectCertificateV1Args,
} from "./continuation-runtime-v1-effect-certificate-types.js";
import {
  effectEventsFromRows,
  memberSetFromEffectEvents,
  verifyEffectCertificateMaterialV1,
} from "./continuation-runtime-v1-effect-certificate-verification.js";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  continuationRuntimeV1OperationLineage,
  type ContinuationRuntimeV1AuthorityWriteContext,
  type ContinuationRuntimeV1OperationLineageV1,
} from "./continuation-runtime-v1-operation-store.js";
import {
  assertContinuationRuntimeV1PolicyAuthority,
  type ContinuationRuntimeV1PolicyAuthority,
  type VerifiedEvidencePolicyCapabilityV1,
} from "./continuation-runtime-v1-policy-authority.js";

export type {
  ContinuationRuntimeV1EffectCertificateWriter,
  EffectCertificatePersistResultV1,
  PutEffectCertificateV1Args,
} from "./continuation-runtime-v1-effect-certificate-types.js";

const MUTATION_CONTEXTS = new WeakSet<object>();
const EFFECT_CERTIFICATE_WRITERS = new WeakMap<object, Readonly<{
  database: ContinuationRuntimeV1Database;
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader;
  policyAuthority: ContinuationRuntimeV1PolicyAuthority;
}>>();
const PUT_KEYS = Object.freeze([
  "eligible_decision_set",
  "evidence_policy",
  "signed_certificate",
  "treatment_delta_set",
] as const);

function persistResult(
  certificate: SignedEffectCertificateV1,
  events: readonly EpisodeEventV1[],
): EffectCertificatePersistResultV1 {
  return canonicalContinuationClone({
    schema_version: "effect_certificate_persist_result_v1" as const,
    certificate_id: certificate.certificate_id,
    certificate_sha256: certificate.certificate_sha256,
    admission_state: certificate.admission_state,
    eligible_decision_count: certificate.eligible_decision_count,
    treatment_delta_count: certificate.treatment_delta_count,
    effect_event_refs: events.map(episodeEventRefV1),
  });
}

function eventId(
  lineage: ContinuationRuntimeV1OperationLineageV1,
  certificate: SignedEffectCertificateV1,
  memberSequence: number,
): string {
  return `effect-${certificate.certificate_sha256.slice(0, 20)}-${memberSequence}-${
    lineage.request_sha256.slice(0, 12)}`;
}

function episodeHead(
  database: ContinuationRuntimeV1Database,
  tenantId: string,
  scope: string,
  episodeId: string,
): EpisodeEventV1 | null {
  const row = database.db.prepare(`SELECT * FROM episode_events
    WHERE tenant_id = ? AND scope = ? AND episode_id = ?
    ORDER BY event_sequence DESC LIMIT 1`).get(
    tenantId,
    scope,
    episodeId,
  ) as SqlRow | undefined;
  return row ? decodeEpisodeEventRow(database, row) : null;
}

function insertEffectEvent(
  database: ContinuationRuntimeV1Database,
  event: EpisodeEventV1,
): void {
  const previous = event.previous_event_ref;
  const cause = event.cause_event_ref!;
  database.db.prepare(`INSERT INTO episode_events(
    tenant_id, scope, episode_id, event_sequence, event_id, event_kind,
    source_operation_kind, source_operation_id, source_request_sha256,
    previous_event_sequence, previous_event_sha256,
    cause_event_sequence, cause_event_id, cause_event_kind, cause_event_sha256,
    effect_member_sequence, capsule_fact_count, capsule_fact_set_sha256,
    decision_id, run_id, host_task_envelope_sha256, contract_sha256,
    coverage_certificate_sha256, render_result_sha256,
    authority_subject_sha256, branch_manifest_sha256,
    effect_certificate_sha256, payload_sha256, payload_json,
    event_sha256, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    event.tenant_id,
    event.scope,
    event.episode_id,
    event.event_sequence,
    event.event_id,
    event.event_kind,
    event.source_operation.operation_kind,
    event.source_operation.operation_id,
    event.source_operation.request_sha256,
    previous?.event_sequence ?? null,
    previous?.event_sha256 ?? null,
    cause.event_sequence,
    cause.event_id,
    cause.event_kind,
    cause.event_sha256,
    event.effect_member_sequence,
    null,
    null,
    event.context.decision_id,
    event.context.run_id,
    event.context.host_task_envelope_sha256,
    event.context.contract_sha256,
    event.context.coverage_certificate_sha256,
    event.render_result_sha256,
    event.context.authority_subject_sha256,
    event.context.branch_manifest_sha256,
    event.effect_certificate_sha256,
    event.payload_sha256,
    canonicalContinuationJson(event.payload),
    event.event_sha256,
    event.created_at,
  );
}

function insertCertificate(
  database: ContinuationRuntimeV1Database,
  lineage: ContinuationRuntimeV1OperationLineageV1,
  certificate: SignedEffectCertificateV1,
): void {
  const signature = Buffer.from(certificate.signature, "base64url");
  if (signature.byteLength !== 64
    || signature.toString("base64url") !== certificate.signature) {
    effectStoreFail("signature_noncanonical");
  }
  database.db.prepare(`INSERT INTO effect_certificates(
    tenant_id, source_operation_scope, source_operation_kind,
    source_operation_id, source_request_sha256, certificate_id,
    certificate_sha256, authority_subject_sha256,
    experiment_cohort_artifact_sha256, experiment_cohort_payload_sha256,
    experiment_cohort_kind, experiment_cohort_installation_receipt_sha256,
    assignment_seed_commitment_sha256, assignment_seed_reveal,
    control_branch_id, control_branch_revision, control_manifest_sha256,
    control_branch_kind, control_branch_state,
    candidate_branch_id, candidate_branch_revision, candidate_manifest_sha256,
    candidate_branch_kind, candidate_branch_state,
    compiler_policy_artifact_sha256, compiler_policy_payload_sha256,
    compiler_policy_kind, evidence_policy_artifact_sha256,
    evidence_policy_payload_sha256, evidence_policy_kind,
    evidence_window_sha256, effect_verifier_contract_sha256,
    statistical_contract_sha256, eligible_decision_count,
    eligible_decision_set_sha256, missingness_bps, harm_conclusion,
    utility_conclusion, admission_state, effect_evaluation_sha256,
    effect_evaluation_json,
    treatment_delta_count, treatment_delta_set_sha256, certificate_json,
    verifier_principal_sha256, verifier_public_key_spki_base64url,
    trust_root_sha256, signature_algorithm, signature,
    window_opened_at, window_closed_at, settlement_cutoff_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    certificate.tenant_id,
    lineage.scope,
    "worker_completion",
    lineage.operation_id,
    lineage.request_sha256,
    certificate.certificate_id,
    certificate.certificate_sha256,
    certificate.authority_subject_sha256,
    certificate.experiment_cohort_ref.artifact_sha256,
    certificate.experiment_cohort_ref.payload_sha256,
    "experiment_cohort",
    certificate.experiment_cohort_installation_receipt_sha256,
    certificate.assignment_seed_commitment_sha256,
    Buffer.from(certificate.assignment_seed_reveal_base64url, "base64url"),
    certificate.control_branch_ref.branch_id,
    certificate.control_branch_ref.branch_revision,
    certificate.control_branch_ref.manifest_sha256,
    certificate.control_branch_ref.branch_kind,
    certificate.control_branch_ref.state,
    certificate.candidate_branch_ref.branch_id,
    certificate.candidate_branch_ref.branch_revision,
    certificate.candidate_branch_ref.manifest_sha256,
    certificate.candidate_branch_ref.branch_kind,
    certificate.candidate_branch_ref.state,
    certificate.compiler_policy_ref.artifact_sha256,
    certificate.compiler_policy_ref.payload_sha256,
    "compiler_policy",
    certificate.evidence_policy_ref.artifact_sha256,
    certificate.evidence_policy_ref.payload_sha256,
    "evidence_policy",
    certificate.evidence_window_sha256,
    certificate.effect_verifier_contract_sha256,
    certificate.statistical_contract_sha256,
    certificate.eligible_decision_count,
    certificate.eligible_decision_set_sha256,
    certificate.missingness_bps,
    certificate.harm_conclusion,
    certificate.utility_conclusion,
    certificate.admission_state,
    certificate.effect_evaluation_sha256,
    canonicalContinuationJson(certificate.effect_evaluation),
    certificate.treatment_delta_count,
    certificate.treatment_delta_set_sha256,
    canonicalContinuationJson(certificate),
    certificate.verifier_principal_sha256,
    certificate.verifier_public_key_spki_base64url,
    certificate.trust_root_sha256,
    certificate.signature_algorithm,
    signature,
    certificate.window_opened_at,
    certificate.window_closed_at,
    certificate.experiment_cohort.settlement_cutoff_at,
    certificate.created_at,
  );
}

function insertTreatmentDelta(
  database: ContinuationRuntimeV1Database,
  certificate: SignedEffectCertificateV1,
  delta: EffectTreatmentDeltaSetV1,
): void {
  const statement = database.db.prepare(`INSERT INTO effect_certificate_treatment_members(
    tenant_id, certificate_sha256, treatment_delta_set_sha256, member_sequence,
    capsule_scope, capsule_id, change_kind, before_binding_json,
    after_binding_json, member_sha256
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const member of delta.members) {
    statement.run(
      certificate.tenant_id,
      certificate.certificate_sha256,
      delta.treatment_delta_set_sha256,
      member.member_sequence,
      member.capsule_scope,
      member.capsule_id,
      member.change_kind,
      member.before_binding === null
        ? null
        : canonicalContinuationJson(member.before_binding),
      member.after_binding === null
        ? null
        : canonicalContinuationJson(member.after_binding),
      member.member_sha256,
    );
  }
}

export function assertContinuationRuntimeV1EffectCertificateWriter(
  value: unknown,
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
  policyAuthority: ContinuationRuntimeV1PolicyAuthority,
): asserts value is ContinuationRuntimeV1EffectCertificateWriter {
  if (value === null || typeof value !== "object") {
    effectStoreFail("writer_unrecognized");
  }
  const record = EFFECT_CERTIFICATE_WRITERS.get(value);
  if (!record || record.database !== database
    || record.artifactStore !== artifactStore
    || record.policyAuthority !== policyAuthority) {
    effectStoreFail("writer_binding_mismatch");
  }
}

export function createContinuationRuntimeV1EffectCertificateWriter(
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
  policyAuthority: ContinuationRuntimeV1PolicyAuthority,
): ContinuationRuntimeV1EffectCertificateWriter {
  assertContinuationRuntimeV1AuthorityArtifactReader(artifactStore, database);
  assertContinuationRuntimeV1PolicyAuthority(policyAuthority, database, artifactStore);

  const writer: ContinuationRuntimeV1EffectCertificateWriter = Object.freeze({
    async put(
      context: ContinuationRuntimeV1AuthorityWriteContext,
      value: PutEffectCertificateV1Args,
    ): Promise<EffectCertificatePersistResultV1> {
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(context, database);
      if (binding.operationKind !== "worker_completion" || binding.actorKind !== "worker") {
        effectStoreFail("worker_completion_context_required");
      }
      if (MUTATION_CONTEXTS.has(context as object)) {
        effectStoreFail("operation_context_already_consumed");
      }
      MUTATION_CONTEXTS.add(context as object);
      const args = exactRecord(value, PUT_KEYS, "put_args");
      const policyCapability = args.evidence_policy as VerifiedEvidencePolicyCapabilityV1;
      const policyBinding = policyAuthority.evidenceBinding(policyCapability);
      const members = verifyEffectEvidenceMemberSetV1(args.eligible_decision_set);
      const treatmentDelta = verifyEffectTreatmentDeltaSetV1(
        args.treatment_delta_set,
      );
      const certificate = verifySignedEffectCertificateV1(
        args.signed_certificate,
        policyBinding,
        members,
        treatmentDelta,
      );
      if (certificate.tenant_id !== binding.tenantId) {
        effectStoreFail("certificate_tenant_operation_mismatch");
      }
      await verifyEffectCertificateMaterialV1(
        database,
        artifactStore,
        policyAuthority,
        certificate,
        members,
        treatmentDelta,
        binding.scope,
        policyCapability,
      );
      const resolved = resolveEffectMembers(
        database,
        certificate,
        members,
        binding.scope,
      );
      insertCertificate(
        database,
        continuationRuntimeV1OperationLineage(binding),
        certificate,
      );
      insertTreatmentDelta(database, certificate, treatmentDelta);
      const events: EpisodeEventV1[] = [];
      for (let index = 0; index < members.members.length; index += 1) {
        const member = members.members[index]!;
        const cause = resolved.causes[index]!;
        const previous = episodeHead(
          database,
          certificate.tenant_id,
          member.scope,
          member.episode_id,
        );
        if (previous === null || previous.created_at > certificate.created_at) {
          effectStoreFail("effect_event_episode_head_time_invalid");
        }
        const event = buildEpisodeEventV1({
          tenant_id: certificate.tenant_id,
          scope: member.scope,
          episode_id: member.episode_id,
          event_sequence: previous.event_sequence + 1,
          event_id: eventId(
            continuationRuntimeV1OperationLineage(binding),
            certificate,
            member.member_sequence,
          ),
          event_kind: "effect_certified",
          source_operation: {
            operation_kind: "worker_completion",
            operation_id: binding.operationId,
            request_sha256: binding.requestSha256,
          },
          previous_event_ref: episodeEventRefV1(previous),
          cause_event_ref: episodeEventRefV1(cause),
          context: cause.context,
          render_result_sha256: cause.render_result_sha256,
          effect_certificate_sha256: certificate.certificate_sha256,
          effect_member_sequence: member.member_sequence,
          capsule_fact_count: null,
          capsule_fact_set_sha256: null,
          payload: {
            payload_kind: "effect_certified_v1",
            evidence_member: member,
          },
          created_at: certificate.created_at,
        });
        insertEffectEvent(database, event);
        events.push(event);
      }
      const persistedTreatmentDelta = readTreatmentDelta(
        database,
        certificate.tenant_id,
        certificate.certificate_sha256,
      );
      const persistedMembers = memberSetFromEffectEvents(
        effectEventsFromRows(database, {
          tenant_id: certificate.tenant_id,
          certificate_sha256: certificate.certificate_sha256,
        }),
      );
      if (canonicalContinuationJson(persistedTreatmentDelta)
          !== canonicalContinuationJson(treatmentDelta)
        || canonicalContinuationJson(persistedMembers)
          !== canonicalContinuationJson(members)) {
        effectStoreFail("postwrite_set_mismatch");
      }
      return persistResult(certificate, events);
    },
  });
  EFFECT_CERTIFICATE_WRITERS.set(writer, { database, artifactStore, policyAuthority });
  return writer;
}

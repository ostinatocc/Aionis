import {
  verifyAuthorityBranchManifestV1,
  type AuthorityBranchCapsuleBindingV1,
  type AuthorityBranchManifestV1,
} from "../continuation/authority-branch.js";
import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type AuthorityArtifactRefV1,
  type CanonicalJson,
  type Sha256,
} from "../continuation/contract.js";
import {
  buildEffectTreatmentDeltaSetV1,
  type EffectTreatmentDeltaSetV1,
  type SignedEffectCertificateV1,
} from "../continuation/effect-certificate.js";
import type { EffectArmObservationCountsV1 } from
  "../continuation/effect-evaluation.js";
import {
  buildEffectEvidenceMemberSetV1,
  episodeEventRefV1,
  type EffectEvidenceMemberSetV1,
  type EpisodeEventV1,
} from "../continuation/episode.js";
import type { ExperimentCohortV1 } from
  "../continuation/experiment-cohort.js";
import { verifyClosedContinuationExposureProjectionV1 } from
  "../continuation/contract-verifier.js";
import { verifyOutcomeReceiptV1 } from "../continuation/outcome.js";
import { verifyServingAssignmentReceiptV1 } from
  "../continuation/serving-assignment.js";
import { assertExecutionCapsuleV1 } from "../continuation/validation.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import {
  decodeContinuationRuntimeV1EpisodeEventRow as decodeEpisodeEventRow,
  type ContinuationRuntimeV1SqlRow as SqlRow,
} from "./continuation-runtime-v1-episode-row.js";
import {
  deriveContinuationRuntimeV1OperationResultV1,
} from "./continuation-runtime-v1-operation-result-derivation.js";
import {
  assertContinuationRuntimeV1OperationResultDeclaration,
} from "./continuation-runtime-v1-operation-result-support.js";
import type { ContinuationRuntimeV1OperationLineageV1 } from
  "./continuation-runtime-v1-operation-store.js";

export {
  decodeContinuationRuntimeV1EpisodeEventRow as decodeEpisodeEventRow,
} from "./continuation-runtime-v1-episode-row.js";
export type {
  ContinuationRuntimeV1SqlRow as SqlRow,
} from "./continuation-runtime-v1-episode-row.js";

const EFFECT_STORE_FAILURES = new WeakMap<object, string>();

export function effectStoreFail(code: string): never {
  const error = new Error(`continuation_runtime_v1_effect_certificate_${code}`);
  EFFECT_STORE_FAILURES.set(error, code);
  throw error;
}

/** Internal stable classification; never parses or persists an Error message. */
export function continuationRuntimeV1EffectStoreFailureCode(
  error: unknown,
): string | null {
  return error !== null && typeof error === "object"
    ? EFFECT_STORE_FAILURES.get(error) ?? null
    : null;
}

/**
 * Authority-only projection used while preparing an effect settlement.  A
 * value of this type is not itself a capability: the worker-only preparation
 * facade constructs it from the pinned artifact and policy authorities.  The
 * signed certificate is structurally compatible so persistence can rerun the
 * same derivations independently.
 */
export type EffectSettlementAuthorityBindingV1 = Readonly<{
  tenant_id: string;
  authority_subject_sha256: Sha256;
  experiment_cohort_ref: AuthorityArtifactRefV1;
  experiment_cohort: ExperimentCohortV1;
  control_branch_ref: SignedEffectCertificateV1["control_branch_ref"];
  candidate_branch_ref: SignedEffectCertificateV1["candidate_branch_ref"];
  compiler_policy_ref: AuthorityArtifactRefV1;
  evidence_policy_ref: AuthorityArtifactRefV1;
}>;

export function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): SqlRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    effectStoreFail(`${field}_shape_invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  const own = Reflect.ownKeys(value);
  const expected = new Set(keys);
  if ((prototype !== Object.prototype && prototype !== null)
    || own.some((key) => typeof key !== "string")
    || own.length !== keys.length
    || own.some((key) => !expected.has(key as string))) {
    effectStoreFail(`${field}_shape_invalid`);
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of own as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      effectStoreFail(`${field}_shape_invalid`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

export function canonicalText(value: unknown, field: string): string {
  if (typeof value !== "string") effectStoreFail(`${field}_invalid`);
  assertUnicodeScalarString(value, `effect certificate ${field}`);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 256) effectStoreFail(`${field}_invalid`);
  return value;
}

export function sha256(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") effectStoreFail(`${field}_invalid`);
  assertSha256(value, `effect certificate ${field}`);
  return value;
}

export function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    effectStoreFail(`${field}_invalid`);
  }
  return value as number;
}

export function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value)
    || (value as number) < minimum || (value as number) > maximum) {
    effectStoreFail(`${field}_invalid`);
  }
  return value as number;
}

export function canonicalTime(value: unknown, field: string): string {
  if (typeof value !== "string") effectStoreFail(`${field}_invalid`);
  assertCanonicalUtcMillis(value, `effect certificate ${field}`);
  return value;
}

export function parseCanonicalObject(
  value: unknown,
  field: string,
): Readonly<Record<string, CanonicalJson>> {
  if (typeof value !== "string") effectStoreFail(`corrupt:${field}_type`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    effectStoreFail(`corrupt:${field}_json`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    || canonicalContinuationJson(parsed) !== value) {
    effectStoreFail(`corrupt:${field}_canonical`);
  }
  return parsed as Readonly<Record<string, CanonicalJson>>;
}

function verifyCanonicalReceipt(
  database: ContinuationRuntimeV1Database,
  lineage: Readonly<{
    tenant_id: string;
    scope: string;
    operation_kind: string;
    operation_id: string;
    request_sha256: Sha256;
  }>,
  expectedActor: "trusted_host" | "worker",
): Readonly<{
  lineage: ContinuationRuntimeV1OperationLineageV1;
  receipt: Readonly<Record<string, CanonicalJson>>;
}> {
  const rows = database.db.prepare(`SELECT actor_kind, actor_principal_sha256,
      request_sha256, request_json, receipt_sha256, receipt_json, completed_at
    FROM operations WHERE tenant_id = ? AND scope = ? AND operation_kind = ?
      AND operation_id = ?`).all(
    lineage.tenant_id,
    lineage.scope,
    lineage.operation_kind,
    lineage.operation_id,
  ) as SqlRow[];
  if (rows.length !== 1) effectStoreFail("corrupt:source_operation_cardinality");
  const row = rows[0]!;
  const actor = canonicalText(row.actor_kind, "corrupt:source_actor_kind");
  const principal = sha256(row.actor_principal_sha256, "corrupt:source_actor_principal");
  const request = sha256(row.request_sha256, "corrupt:source_request_sha256");
  if (typeof row.request_json !== "string"
    || Buffer.byteLength(row.request_json, "utf8") > (
      lineage.operation_kind === "worker_completion" ? 8_388_608 : 1_048_576
    )) {
    effectStoreFail("corrupt:source_request_json");
  }
  let requestValue: unknown;
  try {
    requestValue = JSON.parse(row.request_json) as unknown;
  } catch {
    effectStoreFail("corrupt:source_request_json");
  }
  if (canonicalContinuationJson(requestValue) !== row.request_json
    || canonicalContinuationSha256(requestValue) !== request) {
    effectStoreFail("corrupt:source_request_json");
  }
  const receiptDigest = sha256(row.receipt_sha256, "corrupt:source_receipt_sha256");
  const completed = canonicalTime(row.completed_at, "corrupt:source_completed_at");
  const receipt = parseCanonicalObject(row.receipt_json, "source_receipt_json");
  if (actor !== expectedActor || request !== lineage.request_sha256
    || canonicalContinuationSha256(receipt) !== receiptDigest
    || receipt.schema_version !== "continuation_runtime_operation_receipt_v1"
    || receipt.tenant_id !== lineage.tenant_id || receipt.scope !== lineage.scope
    || receipt.operation_kind !== lineage.operation_kind
    || receipt.operation_id !== lineage.operation_id
    || receipt.request_sha256 !== lineage.request_sha256
    || receipt.actor_kind !== actor || receipt.actor_principal_sha256 !== principal
    || receipt.completed_at !== completed) {
    effectStoreFail("corrupt:source_operation_receipt");
  }
  if (lineage.operation_kind !== "create_continuation"
    && lineage.operation_kind !== "record_outcome"
    && lineage.operation_kind !== "worker_completion") {
    effectStoreFail("corrupt:source_operation_kind");
  }
  try {
    const derived = deriveContinuationRuntimeV1OperationResultV1(database, {
      tenantId: lineage.tenant_id,
      scope: lineage.scope,
      operationKind: lineage.operation_kind,
      operationId: lineage.operation_id,
      requestSha256: lineage.request_sha256,
      actorKind: expectedActor,
      actorPrincipalSha256: principal,
    }, "replay", receipt.result);
    assertContinuationRuntimeV1OperationResultDeclaration(receipt.result, derived);
  } catch (error) {
    throw new Error(
      "continuation_runtime_v1_effect_certificate_corrupt:source_operation_result",
      { cause: error },
    );
  }
  return canonicalContinuationClone({
    lineage: {
      tenant_id: lineage.tenant_id,
      scope: lineage.scope,
      operation_kind: lineage.operation_kind as ContinuationRuntimeV1OperationLineageV1["operation_kind"],
      operation_id: lineage.operation_id,
      request_sha256: lineage.request_sha256,
      actor_kind: actor as ContinuationRuntimeV1OperationLineageV1["actor_kind"],
      actor_principal_sha256: principal,
    },
    receipt,
  });
}

export function verifyEventSourceReceipt(
  database: ContinuationRuntimeV1Database,
  event: EpisodeEventV1,
): ContinuationRuntimeV1OperationLineageV1 {
  const verified = verifyCanonicalReceipt(database, {
    tenant_id: event.tenant_id,
    scope: event.scope,
    operation_kind: event.source_operation.operation_kind,
    operation_id: event.source_operation.operation_id,
    request_sha256: event.source_operation.request_sha256,
  }, event.event_kind === "effect_certified" ? "worker" : "trusted_host");
  if (typeof verified.receipt.completed_at !== "string"
    || verified.receipt.completed_at < event.created_at) {
    effectStoreFail("corrupt:source_operation_completed_before_event");
  }
  return verified.lineage;
}

export function verifyCertificateSourceReceipt(
  database: ContinuationRuntimeV1Database,
  row: SqlRow,
): ContinuationRuntimeV1OperationLineageV1 {
  return verifyCanonicalReceipt(database, {
    tenant_id: canonicalText(row.tenant_id, "corrupt:certificate_tenant_id"),
    scope: canonicalText(row.source_operation_scope, "corrupt:certificate_operation_scope"),
    operation_kind: "worker_completion",
    operation_id: canonicalText(row.source_operation_id, "corrupt:certificate_operation_id"),
    request_sha256: sha256(row.source_request_sha256, "corrupt:certificate_request_sha256"),
  }, "worker").lineage;
}

function branchRef(manifest: AuthorityBranchManifestV1) {
  return {
    branch_id: manifest.branch_id,
    branch_revision: manifest.branch_revision,
    manifest_sha256: manifest.manifest_sha256,
    branch_kind: manifest.branch_kind,
    state: manifest.state,
  };
}

function bindingDigest(
  manifest: AuthorityBranchManifestV1,
  binding: AuthorityBranchCapsuleBindingV1,
): Sha256 {
  return canonicalContinuationSha256({
    schema_version: "authority_branch_capsule_binding_v1",
    tenant_id: manifest.tenant_id,
    authority_subject_sha256: manifest.authority_subject_sha256,
    branch: branchRef(manifest),
    binding,
    created_at: manifest.created_at,
  });
}

export function readExactBranch(
  database: ContinuationRuntimeV1Database,
  certificate: EffectSettlementAuthorityBindingV1,
  arm: "control" | "candidate",
): AuthorityBranchManifestV1 {
  const ref = arm === "control"
    ? certificate.control_branch_ref
    : certificate.candidate_branch_ref;
  const rows = database.db.prepare(`SELECT * FROM branch_revisions
    WHERE tenant_id = ? AND authority_subject_sha256 = ?
      AND branch_id = ? AND branch_revision = ?`).all(
    certificate.tenant_id,
    certificate.authority_subject_sha256,
    ref.branch_id,
    ref.branch_revision,
  ) as SqlRow[];
  if (rows.length !== 1) effectStoreFail(`${arm}_branch_missing`);
  const row = rows[0]!;
  const manifest = verifyAuthorityBranchManifestV1(
    parseCanonicalObject(row.manifest_json, `${arm}_branch_manifest_json`),
  );
  if (manifest.tenant_id !== certificate.tenant_id
    || manifest.authority_subject_sha256 !== certificate.authority_subject_sha256
    || canonicalContinuationJson(branchRef(manifest)) !== canonicalContinuationJson(ref)
    || row.manifest_sha256 !== manifest.manifest_sha256
    || row.branch_kind !== manifest.branch_kind || row.state !== manifest.state
    || row.compiler_policy_artifact_sha256
      !== manifest.compiler_policy_ref.artifact_sha256
    || row.compiler_policy_payload_sha256
      !== manifest.compiler_policy_ref.payload_sha256
    || row.evidence_policy_artifact_sha256
      !== manifest.evidence_policy_ref.artifact_sha256
    || row.evidence_policy_payload_sha256
      !== manifest.evidence_policy_ref.payload_sha256
    || canonicalContinuationJson(manifest.compiler_policy_ref)
      !== canonicalContinuationJson(certificate.compiler_policy_ref)
    || canonicalContinuationJson(manifest.evidence_policy_ref)
      !== canonicalContinuationJson(certificate.evidence_policy_ref)) {
    effectStoreFail(`${arm}_branch_binding_mismatch`);
  }
  const bindings = database.db.prepare(`SELECT binding.*, capsule.capsule_json
    FROM branch_capsule_bindings AS binding
    LEFT JOIN capsule_revisions AS capsule
      ON capsule.tenant_id = binding.tenant_id
     AND capsule.scope = binding.capsule_scope
     AND capsule.capsule_id = binding.capsule_id
     AND capsule.capsule_revision = binding.capsule_revision
     AND capsule.capsule_sha256 = binding.capsule_sha256
    WHERE binding.tenant_id = ? AND binding.authority_subject_sha256 = ?
      AND binding.branch_id = ? AND binding.branch_revision = ?
    ORDER BY binding.capsule_scope, binding.capsule_id,
      binding.capsule_revision, binding.disposition`).all(
    manifest.tenant_id,
    manifest.authority_subject_sha256,
    manifest.branch_id,
    manifest.branch_revision,
  ) as SqlRow[];
  if (bindings.length !== manifest.capsule_bindings.length) {
    effectStoreFail(`corrupt:${arm}_branch_binding_count`);
  }
  for (let index = 0; index < bindings.length; index += 1) {
    const persisted = bindings[index]!;
    const expected = manifest.capsule_bindings[index]!;
    const projection: AuthorityBranchCapsuleBindingV1 = {
      capsule_scope: canonicalText(persisted.capsule_scope, "corrupt:binding_scope"),
      capsule: {
        capsule_id: canonicalText(persisted.capsule_id, "corrupt:binding_capsule_id"),
        capsule_revision: positiveInteger(
          persisted.capsule_revision,
          "corrupt:binding_capsule_revision",
        ),
        capsule_sha256: sha256(
          persisted.capsule_sha256,
          "corrupt:binding_capsule_sha256",
        ),
      },
      disposition: persisted.disposition as AuthorityBranchCapsuleBindingV1["disposition"],
      admission_authority: persisted.admission_authority as
        AuthorityBranchCapsuleBindingV1["admission_authority"],
    };
    const capsule = parseCanonicalObject(persisted.capsule_json, "binding_capsule_json");
    assertExecutionCapsuleV1(capsule);
    if (canonicalContinuationJson(projection) !== canonicalContinuationJson(expected)
      || persisted.branch_manifest_sha256 !== manifest.manifest_sha256
      || persisted.branch_kind !== manifest.branch_kind
      || persisted.created_at !== manifest.created_at
      || persisted.binding_sha256 !== bindingDigest(manifest, projection)
      || capsule.applicability.tenant_id !== manifest.tenant_id
      || capsule.applicability.scope !== projection.capsule_scope
      || capsule.capsule_id !== projection.capsule.capsule_id
      || capsule.capsule_revision !== projection.capsule.capsule_revision
      || capsule.capsule_sha256 !== projection.capsule.capsule_sha256) {
      effectStoreFail(`corrupt:${arm}_branch_binding_projection`);
    }
  }
  return manifest;
}

function changedBindingKey(binding: AuthorityBranchCapsuleBindingV1): string {
  return canonicalContinuationJson([
    binding.capsule_scope,
    binding.capsule.capsule_id,
  ]);
}

function changedBindingMap(
  bindings: readonly AuthorityBranchCapsuleBindingV1[],
  arm: "control" | "candidate",
): Map<string, AuthorityBranchCapsuleBindingV1> {
  const result = new Map<string, AuthorityBranchCapsuleBindingV1>();
  for (const binding of bindings) {
    const key = changedBindingKey(binding);
    if (result.has(key)) effectStoreFail(`${arm}_branch_capsule_identity_ambiguous`);
    result.set(key, binding);
  }
  return result;
}

export function verifyTreatmentDelta(
  certificate: EffectSettlementAuthorityBindingV1,
  control: AuthorityBranchManifestV1,
  candidate: AuthorityBranchManifestV1,
  treatmentDelta: EffectTreatmentDeltaSetV1,
): void {
  const derived = deriveEffectTreatmentDeltaFromBranchesV1(
    certificate,
    control,
    candidate,
  );
  if (canonicalContinuationJson(derived)
    !== canonicalContinuationJson(treatmentDelta)) {
    effectStoreFail("treatment_delta_member_mismatch");
  }
}

function deriveEffectTreatmentDeltaFromBranchesV1(
  certificate: EffectSettlementAuthorityBindingV1,
  control: AuthorityBranchManifestV1,
  candidate: AuthorityBranchManifestV1,
): EffectTreatmentDeltaSetV1 {
  if (candidate.base_authoritative_ref === null
    || canonicalContinuationJson(candidate.base_authoritative_ref)
      !== canonicalContinuationJson(certificate.control_branch_ref)) {
    effectStoreFail("candidate_base_control_mismatch");
  }
  const controlByKey = changedBindingMap(control.capsule_bindings, "control");
  const candidateByKey = changedBindingMap(candidate.capsule_bindings, "candidate");
  const keys = [...new Set([...controlByKey.keys(), ...candidateByKey.keys()])].sort();
  const expected = keys.flatMap((key) => {
    const before = controlByKey.get(key) ?? null;
    const after = candidateByKey.get(key) ?? null;
    if (before !== null && after !== null
      && canonicalContinuationJson(before) === canonicalContinuationJson(after)) return [];
    return [{ before, after }];
  });
  return buildEffectTreatmentDeltaSetV1(expected.map((change) => {
    const binding = change.after ?? change.before!;
    const expectedKind = change.before === null
      ? "added"
      : change.after === null ? "removed" : "changed";
    return {
      capsule_scope: binding.capsule_scope,
      capsule_id: binding.capsule.capsule_id,
      change_kind: expectedKind,
      before_binding: change.before,
      after_binding: change.after,
    };
  }));
}

/** Rebuilds the whole treatment delta from the two exact immutable branches. */
export function deriveEffectTreatmentDeltaV1(
  database: ContinuationRuntimeV1Database,
  binding: EffectSettlementAuthorityBindingV1,
): EffectTreatmentDeltaSetV1 {
  return deriveEffectTreatmentDeltaFromBranchesV1(
    binding,
    readExactBranch(database, binding, "control"),
    readExactBranch(database, binding, "candidate"),
  );
}

function decisionRows(
  database: ContinuationRuntimeV1Database,
  tenantId: string,
  scope: string,
  decisionId: string,
): EpisodeEventV1[] {
  const rows = database.db.prepare(`SELECT * FROM episode_events
    WHERE tenant_id = ? AND scope = ? AND decision_id = ?
      AND event_kind IN ('contract_exposed', 'capsule_use_observed', 'outcome_observed')
    ORDER BY event_sequence`).all(tenantId, scope, decisionId) as SqlRow[];
  return rows.map((row) => decodeEpisodeEventRow(database, row));
}

export type ResolvedEffectMembersV1 = Readonly<{
  member_set: EffectEvidenceMemberSetV1;
  causes: readonly EpisodeEventV1[];
  exposures: readonly EpisodeEventV1[];
  control_count: number;
  candidate_count: number;
  missingness_bps: number;
  control_observations: EffectArmObservationCountsV1;
  candidate_observations: EffectArmObservationCountsV1;
}>;

export function rebuildEffectSettlementCensusV1(
  database: ContinuationRuntimeV1Database,
  certificate: EffectSettlementAuthorityBindingV1,
  operationScope: string,
  assignmentSeed: Uint8Array,
): ResolvedEffectMembersV1 {
  const cohort = certificate.experiment_cohort;
  if (operationScope !== cohort.scope) effectStoreFail("cohort_operation_scope_mismatch");
  if (!(assignmentSeed instanceof Uint8Array) || assignmentSeed.byteLength !== 32) {
    effectStoreFail("assignment_seed_invalid");
  }
  const exposureRows = database.db.prepare(`SELECT * FROM episode_events
    WHERE tenant_id = ? AND scope = ? AND event_kind = 'contract_exposed'
      AND authority_subject_sha256 = ?
      AND experiment_cohort_artifact_sha256 = ?
      AND experiment_cohort_payload_sha256 = ?
      AND serving_mode IN ('assigned_control', 'assigned_candidate')
      AND created_at >= ? AND created_at < ?
    ORDER BY scope, episode_id, decision_id`).all(
    certificate.tenant_id,
    operationScope,
    certificate.authority_subject_sha256,
    certificate.experiment_cohort_ref.artifact_sha256,
    certificate.experiment_cohort_ref.payload_sha256,
    cohort.assignment_window_opened_at,
    cohort.assignment_window_closed_at,
  ) as SqlRow[];
  const census: Array<Readonly<{
    exposure: EpisodeEventV1;
    cause: EpisodeEventV1;
    arm: "control" | "candidate";
  }>> = [];
  let controlCount = 0;
  let candidateCount = 0;
  let missing = 0;
  const observationCounts = {
    control: {
      assigned_exposure_count: 0,
      succeeded_count: 0,
      partial_count: 0,
      failed_count: 0,
      unknown_count: 0,
      missing_outcome_count: 0,
    },
    candidate: {
      assigned_exposure_count: 0,
      succeeded_count: 0,
      partial_count: 0,
      failed_count: 0,
      unknown_count: 0,
      missing_outcome_count: 0,
    },
  };
  for (const exposureRow of exposureRows) {
    const exposure = decodeEpisodeEventRow(database, exposureRow);
    const events = decisionRows(
      database,
      certificate.tenant_id,
      operationScope,
      exposure.context.decision_id,
    );
    const exposurePayload = exposure.payload as Extract<
      EpisodeEventV1["payload"],
      { payload_kind: "contract_exposed_v1" }
    >;
    const verifiedExposure = verifyClosedContinuationExposureProjectionV1({
      contract: exposurePayload.continuation_contract,
      renderResult: exposurePayload.render_result,
    });
    if (verifiedExposure.contract.identity.decision_id !== exposure.context.decision_id
      || verifiedExposure.contract.identity.episode_id !== exposure.episode_id
      || verifiedExposure.contract.identity.scope !== operationScope
      || verifiedExposure.contract.authority.authority_subject_sha256
        !== certificate.authority_subject_sha256
      || canonicalContinuationJson(verifiedExposure.contract.authority.compiler_policy_ref)
        !== canonicalContinuationJson(certificate.compiler_policy_ref)
      || canonicalContinuationJson(verifiedExposure.contract.authority.evidence_policy_ref)
        !== canonicalContinuationJson(certificate.evidence_policy_ref)
      || canonicalContinuationJson(
        verifiedExposure.contract.authority.experiment_cohort_ref,
      ) !== canonicalContinuationJson(certificate.experiment_cohort_ref)
      || verifiedExposure.contract.authority.serving_assignment_receipt === null) {
      effectStoreFail("evidence_member_contract_binding_mismatch");
    }
    const assignment = verifyServingAssignmentReceiptV1(
      verifiedExposure.contract.authority.serving_assignment_receipt,
      {
        cohort,
        experiment_cohort_ref: certificate.experiment_cohort_ref,
        assignment_seed: assignmentSeed,
      },
    );
    const arm = assignment.arm;
    const served = verifiedExposure.contract.authority.served_learning_branch;
    const expectedRef = arm === "control"
      ? certificate.control_branch_ref
      : certificate.candidate_branch_ref;
    const expectedContractRef = {
      branch_id: expectedRef.branch_id,
      branch_revision: expectedRef.branch_revision,
      manifest_sha256: expectedRef.manifest_sha256,
    };
    const expectedMode = arm === "control" ? "assigned_control" : "assigned_candidate";
    if (verifiedExposure.contract.authority.serving_mode !== expectedMode
      || exposureRow.serving_mode !== expectedMode
      || assignment.assignment_basis.decision_id !== exposure.context.decision_id
      || assignment.assignment_basis.episode_id !== exposure.episode_id
      || assignment.assigned_at < cohort.assignment_window_opened_at
      || assignment.assigned_at >= cohort.assignment_window_closed_at
      || canonicalContinuationJson(assignment.served_learning_ref)
        !== canonicalContinuationJson(expectedRef)
      || canonicalContinuationJson(served)
        !== canonicalContinuationJson(expectedContractRef)) {
      effectStoreFail("evidence_member_arm_mismatch");
    }
    observationCounts[arm].assigned_exposure_count += 1;
    if (arm === "control") controlCount += 1;
    else candidateCount += 1;
    const outcomes = events.filter((event) => event.event_kind === "outcome_observed");
    if (outcomes.length > 1) effectStoreFail("corrupt:decision_outcome_cardinality");
    const terminal = outcomes[0] ?? exposure;
    if (terminal.created_at < cohort.assignment_window_opened_at
      || terminal.created_at > cohort.settlement_cutoff_at) {
      effectStoreFail("evidence_member_terminal_mismatch");
    }
    if (terminal.event_kind === "contract_exposed") {
      observationCounts[arm].missing_outcome_count += 1;
      missing += 1;
    } else {
      const outcomePayload = terminal.payload as Extract<
        EpisodeEventV1["payload"],
        { payload_kind: "outcome_observed_v1" }
      >;
      const outcome = verifyOutcomeReceiptV1(outcomePayload.outcome_receipt);
      if (outcome.observed_at > cohort.outcome_deadline) {
        effectStoreFail("outcome_observed_after_deadline");
      }
      if (outcome.outcome === "unknown") {
        observationCounts[arm].unknown_count += 1;
        missing += 1;
      } else if (outcome.outcome === "succeeded") {
        observationCounts[arm].succeeded_count += 1;
      } else if (outcome.outcome === "partial") {
        observationCounts[arm].partial_count += 1;
      } else {
        observationCounts[arm].failed_count += 1;
      }
    }
    verifyEventSourceReceipt(database, exposure);
    if (terminal !== exposure) verifyEventSourceReceipt(database, terminal);
    census.push({ exposure, cause: terminal, arm });
  }
  const rebuilt = buildEffectEvidenceMemberSetV1(census.map(({ cause }) => ({
    scope: cause.scope,
    episode_id: cause.episode_id,
    decision_id: cause.context.decision_id,
    terminal_event: episodeEventRefV1(cause) as
      EffectEvidenceMemberSetV1["members"][number]["terminal_event"],
  })));
  const byIdentity = new Map(census.map((entry) => [canonicalContinuationJson([
    entry.cause.scope,
    entry.cause.episode_id,
    entry.cause.context.decision_id,
  ]), entry] as const));
  const ordered = rebuilt.members.map((member) => {
    const entry = byIdentity.get(canonicalContinuationJson([
      member.scope,
      member.episode_id,
      member.decision_id,
    ]));
    if (!entry) effectStoreFail("corrupt:effect_census_ordering");
    return entry;
  });
  const count = rebuilt.eligible_decision_count;
  const missingness = count === 0 ? 10_000 : Math.ceil((missing * 10_000) / count);
  return canonicalContinuationClone({
    member_set: rebuilt,
    causes: ordered.map((entry) => entry.cause),
    exposures: ordered.map((entry) => entry.exposure),
    control_count: controlCount,
    candidate_count: candidateCount,
    missingness_bps: missingness,
    control_observations: observationCounts.control,
    candidate_observations: observationCounts.candidate,
  });
}

export function resolveEffectMembers(
  database: ContinuationRuntimeV1Database,
  certificate: SignedEffectCertificateV1,
  supplied: EffectEvidenceMemberSetV1,
  operationScope: string,
): ResolvedEffectMembersV1 {
  const assignmentSeed = Buffer.from(
    certificate.assignment_seed_reveal_base64url,
    "base64url",
  );
  try {
    if (assignmentSeed.byteLength !== 32
      || assignmentSeed.toString("base64url")
        !== certificate.assignment_seed_reveal_base64url) {
      effectStoreFail("assignment_seed_reveal_invalid");
    }
    const rebuilt = rebuildEffectSettlementCensusV1(
      database,
      certificate,
      operationScope,
      assignmentSeed,
    );
    if (canonicalContinuationJson(rebuilt.member_set)
      !== canonicalContinuationJson(supplied)) {
      effectStoreFail("evidence_member_set_not_complete_ledger_census");
    }
    return rebuilt;
  } finally {
    assignmentSeed.fill(0);
  }
}

export function readTreatmentDelta(
  database: ContinuationRuntimeV1Database,
  tenantId: string,
  certificateSha256: Sha256,
): EffectTreatmentDeltaSetV1 {
  const rows = database.db.prepare(`SELECT * FROM effect_certificate_treatment_members
    WHERE tenant_id = ? AND certificate_sha256 = ? ORDER BY member_sequence`).all(
    tenantId,
    certificateSha256,
  ) as SqlRow[];
  const binding = (value: unknown, field: string) => value === null
    ? null
    : parseCanonicalObject(value, field) as never;
  const rebuilt = buildEffectTreatmentDeltaSetV1(rows.map((row) => ({
    capsule_scope: canonicalText(row.capsule_scope, "corrupt:treatment_capsule_scope"),
    capsule_id: canonicalText(row.capsule_id, "corrupt:treatment_capsule_id"),
    change_kind: row.change_kind as "added" | "removed" | "changed",
    before_binding: binding(row.before_binding_json, "treatment_before_binding_json"),
    after_binding: binding(row.after_binding_json, "treatment_after_binding_json"),
  })));
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const member = rebuilt.members[index]!;
    if (row.member_sequence !== member.member_sequence
      || row.member_sha256 !== member.member_sha256
      || row.treatment_delta_set_sha256 !== rebuilt.treatment_delta_set_sha256) {
      effectStoreFail("corrupt:treatment_delta_row_projection");
    }
  }
  return rebuilt;
}

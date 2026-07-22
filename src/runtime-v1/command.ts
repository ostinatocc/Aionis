import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  canonicalUniqueSet,
  type CapsuleRefV1,
  type ContinuationObligationV1,
  type HostObservationV1,
  type HostObservationValueV1,
  type Sha256,
  type TargetRefV1,
  type TypedPreconditionSpecV1,
} from "../continuation/contract.js";
import { verifyEffectTreatmentDeltaSetV1 } from
  "../continuation/effect-certificate.js";
import { isContinuationRehydrationRefV1 } from
  "../continuation/rehydration-ref.js";
import { verifyEffectEvidenceMemberSetV1 } from "../continuation/episode.js";
import { verifyHostUseReceiptV1, verifyOutcomeReceiptV1 } from
  "../continuation/outcome.js";
import { validatePreconditionSpecV1 } from "../continuation/observation.js";
import {
  buildAuthenticatedCollectorObservationV1,
  verifyHostObservationAttestationV1,
} from "../continuation/observation-attestation.js";
import {
  buildHostTaskEnvelopeFromAuthenticatedScopeV1,
  continuationAuthoritySubjectSha256V1,
  type HostTaskEnvelopeInputV1,
  type HostTaskEnvelopeV1,
} from "../continuation/task-envelope.js";
import type {
  AuthenticatedDecisionQueryV1,
  AuthenticatedMutationCommandV1,
  AuthenticatedRuntimeCommandBindingV1,
  AuthorityDecisionBodyV1,
  AuthorityDecisionCommandV1,
  CapsuleBranchRefV1,
  CollectorObservationCommandInputV1,
  CreateContinuationBodyV1,
  CreateContinuationCommandV1,
  DecisionQueryBodyV1,
  HostMemoryInputV1,
  RecordObservationsBodyV1,
  RecordObservationsCommandV1,
  RecordOutcomeBodyV1,
  RecordOutcomeCommandV1,
  RuntimeCommandScopeSelectorV1,
  RuntimeV1CanonicalObject,
  RuntimeV1CommandActorKind,
  RuntimeV1DurableJobKind,
  RuntimeV1MutationCommandKind,
  VerifiedAuthorityCommandBindingV1,
  VerifiedDecisionCommandBindingV1,
  VerifiedLeasedJobCommandBindingV1,
  VerifiedSnapshotCommandBindingV1,
  WorkerCompletionBodyV1,
  WorkerCompletionCommandV1,
} from "./command-contract.js";

export type * from "./command-contract.js";
const ID_BYTES = 256;
const LONG_TEXT_BYTES = 1_024;
const MAX_CANONICAL_OBJECT_BYTES = 4_096;
const MAX_COMMAND_BODY_BYTES = 1_048_576;
const MAX_WORKER_COMMAND_BODY_BYTES = 8_388_608;
const MAX_EMBEDDING_ARTIFACT_REF_BYTES = 262_144;
const MAX_EFFECT_CERTIFICATE_BYTES = 262_144;
const MAX_OBSERVATIONS = 2_048;
const MAX_MEMORY_INPUTS = 256;
const MAX_OBLIGATIONS = 64;
function fail(field: string, reason: string): never {
  throw new Error(`continuation_runtime_v1_command_${field}_${reason}`);
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(field, "must_be_plain_record");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(field, "must_be_plain_record");
  }
  const keys = Reflect.ownKeys(value);
  const expected = new Set(expectedKeys);
  if (keys.some((key) => typeof key !== "string")
    || keys.length !== expectedKeys.length
    || keys.some((key) => !expected.has(key as string))) {
    fail(field, "shape_invalid");
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    assertUnicodeScalarString(key, `${field} key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(field, "shape_invalid");
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactArray(value: unknown, maximum: number, field: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum) {
    fail(field, "array_invalid");
  }
  const keys = Reflect.ownKeys(value);
  const expected = new Set<string>(["length"]);
  for (let index = 0; index < value.length; index += 1) expected.add(String(index));
  if (keys.length !== expected.size
    || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
    fail(field, "array_invalid");
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(field, "array_invalid");
    }
    result.push(descriptor.value);
  }
  return result;
}

function text(value: unknown, field: string, maxBytes = ID_BYTES): string {
  if (typeof value !== "string") fail(field, "text_invalid");
  assertUnicodeScalarString(value, field);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    fail(field, "text_invalid");
  }
  return value;
}

function nullableText(value: unknown, field: string, maxBytes = ID_BYTES): string | null {
  return value === null ? null : text(value, field, maxBytes);
}

function sha256(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") fail(field, "sha256_invalid");
  try { assertSha256(value, field); } catch { fail(field, "sha256_invalid"); }
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string") fail(field, "timestamp_invalid");
  try { assertCanonicalUtcMillis(value, field); } catch { fail(field, "timestamp_invalid"); }
  return value;
}

function positiveInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    fail(field, "integer_invalid");
  }
  return value as number;
}

function canonicalObject(
  value: unknown,
  field: string,
  maxBytes = MAX_CANONICAL_OBJECT_BYTES,
): RuntimeV1CanonicalObject {
  const record = exactRecord(value, Object.keys(value as object), field);
  const json = canonicalContinuationJson(record);
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    fail(field, "too_large");
  }
  return canonicalContinuationClone(record) as RuntimeV1CanonicalObject;
}

function canonicalSet<T>(
  values: readonly T[],
  key: (value: T) => string,
  field: string,
): readonly T[] {
  try { return canonicalUniqueSet(values, key); } catch { fail(field, "duplicate"); }
}

function stringSet(value: unknown, maximum: number, field: string): readonly string[] {
  const values = exactArray(value, maximum, field).map((item) => text(item, field));
  return canonicalSet(values, (item) => item, field);
}

function parseScopeSelector(value: unknown): RuntimeCommandScopeSelectorV1 {
  const record = exactRecord(value, ["scope"], "scope_selector");
  return canonicalContinuationClone({ scope: text(record.scope, "scope") });
}

export function parseRuntimeCommandScopeSelectorV1(
  value: unknown,
): RuntimeCommandScopeSelectorV1 {
  return parseScopeSelector(value);
}

function parseBaseBinding(
  value: unknown,
  expectedActor: RuntimeV1CommandActorKind | readonly RuntimeV1CommandActorKind[],
  extraKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> & AuthenticatedRuntimeCommandBindingV1 {
  const record = exactRecord(value, [
    "actor_kind", "actor_principal_sha256", "scope", "tenant_id", ...extraKeys,
  ], "authenticated_binding");
  const allowed = Array.isArray(expectedActor) ? expectedActor : [expectedActor];
  if (typeof record.actor_kind !== "string" || !allowed.includes(
    record.actor_kind as RuntimeV1CommandActorKind,
  )) fail("authenticated_binding_actor_kind", "invalid");
  return {
    ...record,
    tenant_id: text(record.tenant_id, "authenticated_binding_tenant_id"),
    scope: text(record.scope, "authenticated_binding_scope"),
    actor_kind: record.actor_kind as RuntimeV1CommandActorKind,
    actor_principal_sha256: sha256(
      record.actor_principal_sha256,
      "authenticated_binding_actor_principal_sha256",
    ),
  };
}

function expectedSubject(binding: Readonly<{
  tenant_id: string;
  scope: string;
  task_family: string;
}>): Sha256 {
  return continuationAuthoritySubjectSha256V1(binding);
}

function parseSubjectBinding(
  value: unknown,
  actor: RuntimeV1CommandActorKind | readonly RuntimeV1CommandActorKind[],
  extraKeys: readonly string[],
): Readonly<Record<string, unknown>> & AuthenticatedRuntimeCommandBindingV1 & Readonly<{
  task_family: string;
  authority_subject_sha256: Sha256;
}> {
  const binding = parseBaseBinding(
    value,
    actor,
    ["authority_subject_sha256", "task_family", ...extraKeys],
  );
  const taskFamily = text(binding.task_family, "verified_binding_task_family");
  const subject = sha256(
    binding.authority_subject_sha256,
    "verified_binding_authority_subject_sha256",
  );
  if (subject !== expectedSubject({
    tenant_id: binding.tenant_id,
    scope: binding.scope,
    task_family: taskFamily,
  })) fail("verified_binding_authority_subject", "mismatch");
  return { ...binding, task_family: taskFamily, authority_subject_sha256: subject };
}

function hostTaskInput(envelope: HostTaskEnvelopeV1): HostTaskEnvelopeInputV1 {
  const {
    authority_subject_sha256: _authoritySubject,
    host_task_envelope_sha256: _envelopeSha,
    schema_version: _schema,
    scope: _scope,
    tenant_id: _tenant,
    ...input
  } = envelope;
  return input;
}

function parseCollectorObservation(
  value: unknown,
  envelope: HostTaskEnvelopeV1,
  operationId: string,
  principalSha256: Sha256,
): CollectorObservationCommandInputV1 {
  const record = exactRecord(value, [
    "evidence_sha256", "expires_at", "observation_id", "observed_at", "probe_id",
    "probe_spec_sha256", "schema_version", "value",
  ], "collector_observation");
  if (record.schema_version !== "collector_observation_v1") {
    fail("collector_observation_schema", "invalid");
  }
  const parsed = {
    schema_version: "collector_observation_v1" as const,
    observation_id: text(record.observation_id, "collector_observation_id"),
    probe_id: text(record.probe_id, "collector_probe_id"),
    probe_spec_sha256: sha256(record.probe_spec_sha256, "collector_probe_spec_sha256"),
    observed_at: timestamp(record.observed_at, "collector_observed_at"),
    expires_at: timestamp(record.expires_at, "collector_expires_at"),
    value: canonicalContinuationClone(record.value) as HostObservationValueV1,
    evidence_sha256: sha256(record.evidence_sha256, "collector_evidence_sha256"),
  };
  buildAuthenticatedCollectorObservationV1({
    schema_version: "host_observation_v1",
    observation_id: parsed.observation_id,
    probe_id: parsed.probe_id,
    probe_spec_sha256: parsed.probe_spec_sha256,
    host_task_envelope_sha256: envelope.host_task_envelope_sha256,
    world_snapshot_id: operationId,
    observed_at: parsed.observed_at,
    expires_at: parsed.expires_at,
    value: parsed.value,
    evidence_sha256: parsed.evidence_sha256,
  }, principalSha256);
  return canonicalContinuationClone(parsed);
}

function parseSignedObservation(
  value: unknown,
  envelopeSha256: Sha256,
  worldSnapshotId: string,
): HostObservationV1 {
  const observation = verifyHostObservationAttestationV1(value);
  if (observation.observer !== "external_verifier"
    || observation.host_task_envelope_sha256 !== envelopeSha256
    || observation.world_snapshot_id !== worldSnapshotId) {
    fail("signed_observation_binding", "invalid");
  }
  return observation;
}

function parseObservationSets(
  record: Readonly<Record<string, unknown>>,
  envelope: HostTaskEnvelopeV1,
  operationId: string,
  principalSha256: Sha256,
): Readonly<{
  collector_observations: readonly CollectorObservationCommandInputV1[];
  signed_observations: readonly HostObservationV1[];
}> {
  const collector = exactArray(
    record.collector_observations,
    MAX_OBSERVATIONS,
    "collector_observations",
  ).map((item) => parseCollectorObservation(item, envelope, operationId, principalSha256));
  const signed = exactArray(
    record.signed_observations,
    MAX_OBSERVATIONS,
    "signed_observations",
  ).map((item) => parseSignedObservation(
    item,
    envelope.host_task_envelope_sha256,
    operationId,
  ));
  return {
    collector_observations: canonicalSet(collector, (item) => item.observation_id, "collector_observations"),
    signed_observations: canonicalSet(signed, (item) => item.observation_id, "signed_observations"),
  };
}

function parseCapsuleRef(value: unknown, field: string): CapsuleRefV1 {
  const record = exactRecord(value, [
    "capsule_id", "capsule_revision", "capsule_sha256",
  ], field);
  return {
    capsule_id: text(record.capsule_id, `${field}_capsule_id`),
    capsule_revision: positiveInteger(record.capsule_revision, `${field}_capsule_revision`),
    capsule_sha256: sha256(record.capsule_sha256, `${field}_capsule_sha256`),
  };
}

function parseBranchRef(value: unknown, field: string): CapsuleBranchRefV1 {
  const record = exactRecord(value, [
    "branch_id", "branch_revision", "manifest_sha256",
  ], field);
  return {
    branch_id: text(record.branch_id, `${field}_branch_id`),
    branch_revision: positiveInteger(record.branch_revision, `${field}_branch_revision`),
    manifest_sha256: sha256(record.manifest_sha256, `${field}_manifest_sha256`),
  };
}

function parseTargetRef(value: unknown, field: string): TargetRefV1 {
  const record = exactRecord(value, ["kind", "ref"], field);
  const kinds = new Set<TargetRefV1["kind"]>([
    "artifact", "service", "capability", "memory", "workflow", "external_resource",
  ]);
  if (typeof record.kind !== "string" || !kinds.has(record.kind as TargetRefV1["kind"])) {
    fail(`${field}_kind`, "invalid");
  }
  return { kind: record.kind as TargetRefV1["kind"], ref: text(record.ref, `${field}_ref`, LONG_TEXT_BYTES) };
}

function parseObligation(value: unknown): ContinuationObligationV1 {
  const record = exactRecord(value, [
    "evidence_requirement", "kind", "obligation_id", "required_probe_ids",
    "requirement", "source_refs", "statement", "target_refs",
  ], "obligation");
  const kinds = ["active_goal", "required_state", "next_action", "must_hold", "prohibition", "verification"];
  const requirements = ["hard", "advisory"];
  const evidence = ["runtime_state", "trusted_host", "external_verifier"];
  if (!kinds.includes(record.kind as string)
    || !requirements.includes(record.requirement as string)
    || !evidence.includes(record.evidence_requirement as string)) {
    fail("obligation_enum", "invalid");
  }
  const targets = exactArray(record.target_refs, 16, "obligation_target_refs")
    .map((item) => parseTargetRef(item, "obligation_target_ref"));
  if (targets.length === 0) fail("obligation_target_refs", "empty");
  const requiredProbeIds = stringSet(
    record.required_probe_ids,
    16,
    "obligation_required_probe_ids",
  );
  if ((record.evidence_requirement === "runtime_state") !== (requiredProbeIds.length === 0)) {
    fail("obligation_required_probe_ids", "evidence_mismatch");
  }
  return canonicalContinuationClone({
    obligation_id: text(record.obligation_id, "obligation_id"),
    kind: record.kind,
    requirement: record.requirement,
    statement: text(record.statement, "obligation_statement", LONG_TEXT_BYTES),
    target_refs: canonicalSet(targets, (item) => `${item.kind}\0${item.ref}`, "obligation_target_refs"),
    required_probe_ids: requiredProbeIds,
    evidence_requirement: record.evidence_requirement,
    source_refs: stringSet(record.source_refs, 32, "obligation_source_refs"),
  }) as ContinuationObligationV1;
}

function exactApplicabilityValue(
  value: unknown,
  expected: string | null,
  field: string,
): string | null {
  const parsed = nullableText(value, field);
  if (parsed !== null && parsed !== expected) fail(field, "outside_task_envelope");
  return parsed;
}

function parseHostMemoryInput(
  value: unknown,
  envelope: HostTaskEnvelopeV1,
  observationsById: ReadonlyMap<string, Readonly<{ expires_at: string }>>,
): HostMemoryInputV1 {
  const record = exactRecord(value, [
    "applicability", "coverage_claims", "evidence_observation_ids", "expires_at",
    "kind", "memory_input_id", "precondition_specs", "projection",
  ], "memory_input");
  if (!["current_state", "verified_fact", "procedure", "constraint", "counter_evidence"]
    .includes(record.kind as string)) fail("memory_input_kind", "invalid");
  const applicability = exactRecord(record.applicability, [
    "task_signature", "workflow_signature", "workspace_signature",
  ], "memory_input_applicability");
  const projection = exactRecord(record.projection, [
    "acceptance_statements", "next_action", "summary", "target_refs", "workflow_steps",
  ], "memory_input_projection");
  const targets = exactArray(projection.target_refs, 16, "memory_input_target_refs")
    .map((item) => parseTargetRef(item, "memory_input_target_ref"));
  const preconditions = exactArray(record.precondition_specs, 16, "memory_input_preconditions")
    .map((item) => {
      const cloned = canonicalContinuationClone(item) as TypedPreconditionSpecV1;
      validatePreconditionSpecV1(cloned);
      return cloned;
    });
  const projectionTargetKeys = new Set(targets.map((target) => `${target.kind}\0${target.ref}`));
  const specsById = new Map(preconditions.map((spec) => [spec.probe_id, spec]));
  const coverageClaims = exactArray(
    record.coverage_claims,
    32,
    "memory_input_coverage_claims",
  ).map((raw) => {
    const claim = exactRecord(raw, [
      "evidence_requirement", "obligation_kind", "required_probe_ids", "target_refs",
    ], "memory_input_coverage_claim");
    if (![
      "active_goal", "required_state", "next_action", "must_hold", "prohibition",
      "verification",
    ].includes(claim.obligation_kind as string)) {
      fail("memory_input_coverage_claim_kind", "invalid");
    }
    if (!["runtime_state", "trusted_host", "external_verifier"]
      .includes(claim.evidence_requirement as string)) {
      fail("memory_input_coverage_claim_evidence", "invalid");
    }
    const claimTargets = exactArray(
      claim.target_refs,
      16,
      "memory_input_coverage_claim_targets",
    ).map((target) => parseTargetRef(target, "memory_input_coverage_claim_target"));
    if (claimTargets.length === 0
      || claimTargets.some((target) => !projectionTargetKeys.has(`${target.kind}\0${target.ref}`))) {
      fail("memory_input_coverage_claim_targets", "outside_projection");
    }
    const requiredProbeIds = stringSet(
      claim.required_probe_ids,
      16,
      "memory_input_coverage_claim_probe_ids",
    );
    if ((claim.evidence_requirement === "runtime_state") !== (requiredProbeIds.length === 0)) {
      fail("memory_input_coverage_claim_probes", "evidence_mismatch");
    }
    const expectedObserver = claim.evidence_requirement === "trusted_host"
      ? "trusted_host_collector"
      : claim.evidence_requirement === "external_verifier"
        ? "external_verifier"
        : null;
    if (requiredProbeIds.some((probeId) => {
      const spec = specsById.get(probeId);
      return !spec || spec.observer !== expectedObserver
        || (spec.required_for !== "admission" && spec.required_for !== "before_action");
    })) fail("memory_input_coverage_claim_probes", "not_serve_phase_preconditions");
    return {
      obligation_kind: claim.obligation_kind as ContinuationObligationV1["kind"],
      target_refs: canonicalSet(
        claimTargets,
        (target) => `${target.kind}\0${target.ref}`,
        "memory_input_coverage_claim_targets",
      ),
      evidence_requirement: claim.evidence_requirement as
        ContinuationObligationV1["evidence_requirement"],
      required_probe_ids: requiredProbeIds,
    };
  });
  if (coverageClaims.length === 0) fail("memory_input_coverage_claims", "empty");
  const evidenceObservationIds = stringSet(
    record.evidence_observation_ids,
    64,
    "memory_input_evidence_observation_ids",
  );
  if (evidenceObservationIds.length === 0
    || evidenceObservationIds.some((observationId) => !observationsById.has(observationId))) {
    fail("memory_input_evidence", "not_in_observation_batch");
  }
  const workflowSteps = exactArray(
    projection.workflow_steps,
    32,
    "memory_input_workflow_steps",
  ).map((item) => text(item, "memory_input_workflow_step", 512));
  const nextAction = nullableText(
    projection.next_action,
    "memory_input_next_action",
    LONG_TEXT_BYTES,
  );
  if (record.kind === "procedure" && nextAction === null && workflowSteps.length === 0) {
    fail("memory_input_procedure", "empty");
  }
  const expiresAt = record.expires_at === null
    ? null
    : timestamp(record.expires_at, "memory_input_expires_at");
  if (expiresAt !== null && expiresAt <= envelope.issued_at) {
    fail("memory_input_expires_at", "not_after_task_issue");
  }
  const evidenceExpiresAt = evidenceObservationIds.reduce<string>(
    (earliest, observationId) => {
      const expires = observationsById.get(observationId)!.expires_at;
      return expires < earliest ? expires : earliest;
    },
    envelope.expires_at,
  );
  const stateBoundKind = record.kind === "current_state"
    || record.kind === "verified_fact"
    || record.kind === "constraint"
    || record.kind === "counter_evidence";
  if (stateBoundKind && expiresAt === null) {
    fail("memory_input_expires_at", "required_for_state_bound_memory");
  }
  if (stateBoundKind && expiresAt! > evidenceExpiresAt) {
    fail("memory_input_expires_at", "outside_evidence_or_task_window");
  }
  return canonicalContinuationClone({
    memory_input_id: text(record.memory_input_id, "memory_input_id"),
    kind: record.kind,
    applicability: {
      task_signature: exactApplicabilityValue(
        applicability.task_signature,
        envelope.task_signature,
        "memory_input_task_signature",
      ),
      workflow_signature: exactApplicabilityValue(
        applicability.workflow_signature,
        envelope.workflow_signature,
        "memory_input_workflow_signature",
      ),
      workspace_signature: exactApplicabilityValue(
        applicability.workspace_signature,
        envelope.workspace_signature,
        "memory_input_workspace_signature",
      ),
    },
    projection: {
      summary: text(projection.summary, "memory_input_summary", 2_048),
      next_action: nextAction,
      target_refs: canonicalSet(
        targets,
        (item) => `${item.kind}\0${item.ref}`,
        "memory_input_target_refs",
      ),
      workflow_steps: workflowSteps,
      acceptance_statements: exactArray(
        projection.acceptance_statements,
        32,
        "memory_input_acceptance_statements",
      ).map((item) => text(item, "memory_input_acceptance_statement", LONG_TEXT_BYTES)),
    },
    coverage_claims: canonicalSet(
      coverageClaims,
      (claim) => canonicalContinuationSha256(claim),
      "memory_input_coverage_claims",
    ),
    precondition_specs: canonicalSet(
      preconditions,
      (item) => item.probe_id,
      "memory_input_preconditions",
    ),
    evidence_observation_ids: evidenceObservationIds,
    expires_at: expiresAt,
  }) as HostMemoryInputV1;
}

function buildCommand<K extends RuntimeV1MutationCommandKind, B>(args: Readonly<{
  operation_kind: K;
  operation_id: string;
  binding: AuthenticatedRuntimeCommandBindingV1;
  authority_subject_sha256: Sha256 | null;
  body: B;
}>): AuthenticatedMutationCommandV1<K, B> {
  const bodySha256 = canonicalContinuationSha256(args.body);
  if (Buffer.byteLength(canonicalContinuationJson(args.body), "utf8") > MAX_COMMAND_BODY_BYTES) {
    fail("body", "too_large");
  }
  const core = {
    schema_version: "authenticated_runtime_command_v1" as const,
    operation_kind: args.operation_kind,
    operation_id: text(args.operation_id, "operation_id"),
    tenant_id: args.binding.tenant_id,
    scope: args.binding.scope,
    actor_kind: args.binding.actor_kind,
    actor_principal_sha256: args.binding.actor_principal_sha256,
    authority_subject_sha256: args.authority_subject_sha256,
    body: args.body,
    body_sha256: bodySha256,
  };
  return canonicalContinuationClone({
    ...core,
    command_sha256: canonicalContinuationSha256(core),
  });
}

export function buildRecordObservationsCommandV1(
  operationId: string,
  value: unknown,
  authenticatedBinding: AuthenticatedRuntimeCommandBindingV1,
): RecordObservationsCommandV1 {
  const binding = parseBaseBinding(authenticatedBinding, "trusted_host");
  const record = exactRecord(value, [
    "collector_observations", "host_task", "memory_inputs", "schema_version",
    "signed_observations",
  ], "record_observations_body");
  if (record.schema_version !== "record_observations_body_v1") {
    fail("record_observations_schema", "invalid");
  }
  const envelope = buildHostTaskEnvelopeFromAuthenticatedScopeV1(
    record.host_task as HostTaskEnvelopeInputV1,
    { tenant_id: binding.tenant_id, scope: binding.scope },
  );
  const observations = parseObservationSets(record, envelope, operationId, binding.actor_principal_sha256);
  const observationsById = new Map<string, Readonly<{ expires_at: string }>>([
    ...observations.collector_observations.map(
      (item): readonly [string, Readonly<{ expires_at: string }>] => [
        item.observation_id,
        item,
      ],
    ),
    ...observations.signed_observations.map(
      (item): readonly [string, Readonly<{ expires_at: string }>] => [
        item.observation_id,
        item,
      ],
    ),
  ]);
  if (observationsById.size !== observations.collector_observations.length
      + observations.signed_observations.length) {
    fail("observation_ids", "duplicate_across_attestation_kinds");
  }
  const memoryInputs = exactArray(
    record.memory_inputs,
    MAX_MEMORY_INPUTS,
    "memory_inputs",
  ).map((item) => parseHostMemoryInput(item, envelope, observationsById));
  const body: RecordObservationsBodyV1 = canonicalContinuationClone({
    schema_version: "record_observations_body_v1",
    host_task: hostTaskInput(envelope),
    memory_inputs: canonicalSet(
      memoryInputs,
      (item) => item.memory_input_id,
      "memory_inputs",
    ),
    ...observations,
  });
  return buildCommand({
    operation_kind: "record_observations",
    operation_id: operationId,
    binding,
    authority_subject_sha256: envelope.authority_subject_sha256,
    body,
  });
}

export function buildCreateContinuationCommandV1(
  operationId: string,
  value: unknown,
  verifiedSnapshotBinding: VerifiedSnapshotCommandBindingV1,
): CreateContinuationCommandV1 {
  const binding = parseSubjectBinding(
    verifiedSnapshotBinding,
    "trusted_host",
    ["world_snapshot_id", "world_snapshot_sha256"],
  );
  const boundSnapshotId = text(binding.world_snapshot_id, "verified_snapshot_id");
  const boundSnapshotSha = sha256(binding.world_snapshot_sha256, "verified_snapshot_sha256");
  const record = exactRecord(value, [
    "obligations", "render_budget_bytes", "schema_version", "world_snapshot_ref",
  ], "create_continuation_body");
  if (record.schema_version !== "create_continuation_body_v1") {
    fail("create_continuation_schema", "invalid");
  }
  const snapshot = exactRecord(record.world_snapshot_ref, [
    "world_snapshot_id", "world_snapshot_sha256",
  ], "world_snapshot_ref");
  const snapshotId = text(snapshot.world_snapshot_id, "world_snapshot_id");
  const snapshotSha = sha256(snapshot.world_snapshot_sha256, "world_snapshot_sha256");
  if (snapshotId !== boundSnapshotId || snapshotSha !== boundSnapshotSha) {
    fail("world_snapshot_binding", "mismatch");
  }
  const obligations = exactArray(record.obligations, MAX_OBLIGATIONS, "obligations")
    .map(parseObligation);
  const renderBudgetBytes = positiveInteger(
    record.render_budget_bytes,
    "render_budget_bytes",
    65_536,
  );
  if (renderBudgetBytes < 1_024) fail("render_budget_bytes", "out_of_range");
  const body: CreateContinuationBodyV1 = canonicalContinuationClone({
    schema_version: "create_continuation_body_v1",
    world_snapshot_ref: { world_snapshot_id: snapshotId, world_snapshot_sha256: snapshotSha },
    obligations: canonicalSet(obligations, (item) => item.obligation_id, "obligations"),
    render_budget_bytes: renderBudgetBytes,
  });
  return buildCommand({
    operation_kind: "create_continuation",
    operation_id: operationId,
    binding,
    authority_subject_sha256: binding.authority_subject_sha256,
    body,
  });
}

export function buildRecordOutcomeCommandV1(
  operationId: string,
  value: unknown,
  verifiedDecisionBinding: VerifiedDecisionCommandBindingV1,
): RecordOutcomeCommandV1 {
  const binding = parseSubjectBinding(verifiedDecisionBinding, "trusted_host", [
    "contract_sha256", "decision_id", "exposure_receipt_sha256",
    "host_task_envelope_sha256", "render_result_sha256",
  ]);
  const boundDecisionId = text(binding.decision_id, "verified_decision_id");
  const boundContractSha = sha256(binding.contract_sha256, "verified_contract_sha256");
  const boundExposureSha = sha256(binding.exposure_receipt_sha256, "verified_exposure_receipt_sha256");
  const boundRenderSha = sha256(
    binding.render_result_sha256,
    "verified_render_result_sha256",
  );
  sha256(binding.host_task_envelope_sha256, "verified_host_task_envelope_sha256");
  const record = exactRecord(value, [
    "decision_ref", "outcome_receipt", "schema_version", "use_receipt",
  ], "record_outcome_body");
  if (record.schema_version !== "record_outcome_body_v1") fail("record_outcome_schema", "invalid");
  const decision = exactRecord(record.decision_ref, [
    "contract_sha256", "decision_id", "exposure_receipt_sha256",
  ], "outcome_decision_ref");
  const decisionId = text(decision.decision_id, "outcome_decision_id");
  const contractSha = sha256(decision.contract_sha256, "outcome_contract_sha256");
  const exposureSha = sha256(decision.exposure_receipt_sha256, "outcome_exposure_receipt_sha256");
  if (decisionId !== boundDecisionId || contractSha !== boundContractSha || exposureSha !== boundExposureSha) {
    fail("outcome_decision_binding", "mismatch");
  }
  const useReceipt = verifyHostUseReceiptV1(record.use_receipt);
  const outcomeReceipt = verifyOutcomeReceiptV1(record.outcome_receipt);
  if (useReceipt.decision_id !== decisionId
    || outcomeReceipt.decision_id !== decisionId
    || useReceipt.render_result_sha256 !== boundRenderSha
    || useReceipt.capsule_uses.some((use) => use.capsule_scope !== binding.scope)
    || outcomeReceipt.observed_at < useReceipt.observed_at) {
    fail("outcome_receipt_binding", "mismatch");
  }
  const body: RecordOutcomeBodyV1 = canonicalContinuationClone({
    schema_version: "record_outcome_body_v1",
    decision_ref: {
      decision_id: decisionId,
      contract_sha256: contractSha,
      exposure_receipt_sha256: exposureSha,
    },
    use_receipt: useReceipt,
    outcome_receipt: outcomeReceipt,
  }) as RecordOutcomeBodyV1;
  return buildCommand({
    operation_kind: "record_outcome",
    operation_id: operationId,
    binding,
    authority_subject_sha256: binding.authority_subject_sha256,
    body,
  });
}

function reasonCodes(value: unknown): readonly string[] {
  const reasons = stringSet(value, 32, "reason_codes");
  if (reasons.length === 0) fail("reason_codes", "empty");
  return reasons;
}

function evidenceSha256s(value: unknown, field: string): readonly Sha256[] {
  return canonicalSet(
    exactArray(value, 64, field).map((entry) => sha256(entry, field)),
    (entry) => entry,
    field,
  );
}

function expectedMemoryHead(value: unknown): Readonly<{
  revision: number;
  head_sha256: Sha256;
}> {
  const record = exactRecord(value, ["head_sha256", "revision"], "expected_memory_head");
  return canonicalContinuationClone({
    revision: positiveInteger(
      record.revision,
      "expected_memory_head_revision",
    ),
    head_sha256: sha256(
      record.head_sha256,
      "expected_memory_head_sha256",
    ),
  });
}

function parseAuthorityDecision(value: unknown): AuthorityDecisionBodyV1["decision"] {
  const discriminator = exactRecord(value, Object.keys(value as object), "authority_decision_action");
  const kind = discriminator.kind;
  if (kind === "lifecycle_suppress" || kind === "lifecycle_restore"
    || kind === "lifecycle_quarantine") {
    const record = exactRecord(value, [
      "expected_memory_head", "kind", "memory_id", "reason_codes",
    ], "authority_lifecycle_action");
    return canonicalContinuationClone({
      kind,
      memory_id: text(record.memory_id, "authority_memory_id"),
      expected_memory_head: expectedMemoryHead(record.expected_memory_head),
      reason_codes: reasonCodes(record.reason_codes),
    });
  }
  if (kind === "lifecycle_archive") {
    const record = exactRecord(value, [
      "expected_memory_head", "kind", "memory_id", "reason_codes",
      "rehydration_ref",
    ], "authority_lifecycle_archive_action");
    const rehydrationRef = text(
      record.rehydration_ref,
      "authority_rehydration_ref",
      79,
    );
    if (!isContinuationRehydrationRefV1(rehydrationRef)) {
      fail("authority_rehydration_ref", "invalid");
    }
    return canonicalContinuationClone({
      kind,
      memory_id: text(record.memory_id, "authority_memory_id"),
      expected_memory_head: expectedMemoryHead(record.expected_memory_head),
      rehydration_ref: rehydrationRef,
      reason_codes: reasonCodes(record.reason_codes),
    });
  }
  if (kind === "candidate_advance") {
    const record = exactRecord(value, [
      "candidate", "evidence_sha256s", "kind", "reason_codes", "target_state",
    ], "authority_candidate_advance_action");
    if (record.target_state !== "shadow"
      && record.target_state !== "eligible"
      && record.target_state !== "active_candidate") {
      fail("authority_candidate_target_state", "invalid");
    }
    const evidence = evidenceSha256s(
      record.evidence_sha256s,
      "authority_candidate_evidence_sha256s",
    );
    if (evidence.length === 0) {
      fail("authority_candidate_evidence_sha256s", "empty");
    }
    return canonicalContinuationClone({
      kind,
      candidate: parseBranchRef(record.candidate, "authority_candidate"),
      target_state: record.target_state,
      reason_codes: reasonCodes(record.reason_codes),
      evidence_sha256s: evidence,
    });
  }
  if (kind === "branch_merge") {
    const record = exactRecord(value, [
      "candidate", "effect_certificate_sha256", "kind",
    ], "authority_merge_action");
    return canonicalContinuationClone({
      kind,
      candidate: parseBranchRef(record.candidate, "authority_candidate"),
      effect_certificate_sha256: sha256(
        record.effect_certificate_sha256,
        "authority_effect_certificate_sha256",
      ),
    });
  }
  if (kind === "branch_reject" || kind === "branch_quarantine" || kind === "branch_expire") {
    const record = exactRecord(value, [
      "candidate", "evidence_sha256s", "kind", "reason_codes",
    ], "authority_branch_action");
    return canonicalContinuationClone({
      kind,
      candidate: parseBranchRef(record.candidate, "authority_candidate"),
      reason_codes: reasonCodes(record.reason_codes),
      evidence_sha256s: evidenceSha256s(
        record.evidence_sha256s,
        "authority_branch_evidence_sha256s",
      ),
    });
  }
  if (kind === "authority_revert") {
    const record = exactRecord(value, [
      "evidence_sha256s", "kind", "reason_codes", "target",
    ], "authority_revert_action");
    return canonicalContinuationClone({
      kind,
      target: parseBranchRef(record.target, "authority_revert_target"),
      reason_codes: reasonCodes(record.reason_codes),
      evidence_sha256s: evidenceSha256s(
        record.evidence_sha256s,
        "authority_revert_evidence_sha256s",
      ),
    });
  }
  if (kind === "policy_rotate") {
    const record = exactRecord(value, ["artifact_ref", "kind"], "authority_policy_rotate_action");
    const artifact = exactRecord(record.artifact_ref, [
      "artifact_sha256", "payload_sha256",
    ], "authority_policy_artifact_ref");
    return canonicalContinuationClone({
      kind,
      artifact_ref: {
        artifact_sha256: sha256(artifact.artifact_sha256, "authority_artifact_sha256"),
        payload_sha256: sha256(artifact.payload_sha256, "authority_payload_sha256"),
      },
    });
  }
  fail("authority_decision_kind", "invalid");
}

export function buildAuthorityDecisionCommandV1(
  operationId: string,
  value: unknown,
  verifiedAuthorityBinding: VerifiedAuthorityCommandBindingV1,
): AuthorityDecisionCommandV1 {
  const binding = parseSubjectBinding(verifiedAuthorityBinding, "operator", []);
  const record = exactRecord(value, [
    "decision", "expected_head", "schema_version",
  ], "authority_decision_body");
  if (record.schema_version !== "authority_decision_body_v1") {
    fail("authority_decision_schema", "invalid");
  }
  const head = exactRecord(record.expected_head, [
    "head_sha256", "revision",
  ], "authority_expected_head");
  const body: AuthorityDecisionBodyV1 = canonicalContinuationClone({
    schema_version: "authority_decision_body_v1",
    expected_head: {
      revision: positiveInteger(head.revision, "authority_expected_head_revision"),
      head_sha256: sha256(head.head_sha256, "authority_expected_head_sha256"),
    },
    decision: parseAuthorityDecision(record.decision),
  });
  const bodySha256 = canonicalContinuationSha256(body);
  if (Buffer.byteLength(canonicalContinuationJson(body), "utf8")
    > MAX_COMMAND_BODY_BYTES) fail("body", "too_large");
  const core = {
    schema_version: "authenticated_runtime_command_v1" as const,
    operation_kind: "authority_decision" as const,
    operation_id: text(operationId, "operation_id"),
    tenant_id: binding.tenant_id,
    scope: binding.scope,
    actor_kind: "operator" as const,
    actor_principal_sha256: binding.actor_principal_sha256,
    authority_subject_sha256: binding.authority_subject_sha256,
    task_family: binding.task_family,
    body,
    body_sha256: bodySha256,
  };
  return canonicalContinuationClone({
    ...core,
    command_sha256: canonicalContinuationSha256(core),
  });
}

function workerOutput(
  value: unknown,
  jobKind: RuntimeV1DurableJobKind,
): WorkerCompletionBodyV1["completion"] {
  const record = exactRecord(value, Object.keys(value as object), "worker_completion");
  if (record.status === "retry" || record.status === "dead") {
    const failed = exactRecord(value, ["error", "retry_at", "status"], "worker_failure");
    if ((record.status === "retry") !== (failed.retry_at !== null)) {
      fail("worker_retry_at", "invalid");
    }
    return canonicalContinuationClone({
      status: record.status,
      retry_at: failed.retry_at === null ? null : timestamp(failed.retry_at, "worker_retry_at"),
      error: canonicalObject(failed.error, "worker_error"),
    });
  }
  if (record.status !== "succeeded") fail("worker_status", "invalid");
  const succeeded = exactRecord(value, ["output", "status"], "worker_success");
  const output = exactRecord(succeeded.output, Object.keys(succeeded.output as object), "worker_output");
  if (output.kind !== jobKind) fail("worker_output_kind", "mismatch");
  if (jobKind === "embedding") {
    const typed = exactRecord(succeeded.output, ["artifact_ref", "kind"], "worker_embedding_output");
    return canonicalContinuationClone({ status: "succeeded", output: {
      kind: "embedding", artifact_ref: canonicalObject(
        typed.artifact_ref,
        "embedding_artifact_ref",
        MAX_EMBEDDING_ARTIFACT_REF_BYTES,
      ),
    } });
  }
  if (jobKind === "ann") {
    const typed = exactRecord(succeeded.output, ["index_receipt", "kind"], "worker_ann_output");
    return canonicalContinuationClone({ status: "succeeded", output: {
      kind: "ann", index_receipt: canonicalObject(typed.index_receipt, "ann_index_receipt"),
    } });
  }
  if (jobKind === "effect") {
    const typed = exactRecord(succeeded.output, [
      "eligible_decision_set", "kind", "signed_certificate", "treatment_delta_set",
    ], "worker_effect_output");
    return canonicalContinuationClone({ status: "succeeded", output: {
      kind: "effect",
      signed_certificate: canonicalObject(
        typed.signed_certificate,
        "effect_certificate",
        MAX_EFFECT_CERTIFICATE_BYTES,
      ),
      eligible_decision_set: verifyEffectEvidenceMemberSetV1(
        typed.eligible_decision_set,
      ),
      treatment_delta_set: verifyEffectTreatmentDeltaSetV1(
        typed.treatment_delta_set,
      ),
    } });
  }
  const typed = exactRecord(succeeded.output, ["kind", "result"], "worker_retention_output");
  return canonicalContinuationClone({ status: "succeeded", output: {
    kind: "retention", result: canonicalObject(typed.result, "retention_result"),
  } });
}

export function buildWorkerCompletionCommandV1(
  operationId: string,
  value: unknown,
  verifiedLeasedJobBinding: VerifiedLeasedJobCommandBindingV1,
): WorkerCompletionCommandV1 {
  const binding = parseBaseBinding(verifiedLeasedJobBinding, "worker", [
    "attempt_count", "authority_subject_sha256", "job_id", "job_kind",
    "job_payload_sha256", "lease_token_sha256", "task_family",
  ]);
  const jobId = text(binding.job_id, "verified_job_id");
  const attempt = positiveInteger(binding.attempt_count, "verified_job_attempt", 1_000);
  const payloadSha = sha256(binding.job_payload_sha256, "verified_job_payload_sha256");
  const leaseSha = sha256(binding.lease_token_sha256, "verified_job_lease_token_sha256");
  if (!["embedding", "ann", "effect", "retention"].includes(binding.job_kind as string)) {
    fail("verified_job_kind", "invalid");
  }
  const jobKind = binding.job_kind as RuntimeV1DurableJobKind;
  const taskFamily = text(binding.task_family, "verified_job_task_family");
  const subject = sha256(
    binding.authority_subject_sha256,
    "verified_job_authority_subject_sha256",
  );
  if (subject !== expectedSubject({
    tenant_id: binding.tenant_id,
    scope: binding.scope,
    task_family: taskFamily,
  })) fail("verified_job_authority_subject", "mismatch");
  const record = exactRecord(value, ["completion", "schema_version"], "worker_completion_body");
  if (record.schema_version !== "worker_completion_body_v1") {
    fail("worker_completion_schema", "invalid");
  }
  const body: WorkerCompletionBodyV1 = canonicalContinuationClone({
    schema_version: "worker_completion_body_v1",
    completion: workerOutput(record.completion, jobKind),
  });
  const bodySha256 = canonicalContinuationSha256(body);
  if (Buffer.byteLength(canonicalContinuationJson(body), "utf8")
      > MAX_WORKER_COMMAND_BODY_BYTES) {
    fail("body", "too_large");
  }
  const core = {
    schema_version: "authenticated_runtime_command_v1" as const,
    operation_kind: "worker_completion" as const,
    operation_id: text(operationId, "operation_id"),
    tenant_id: binding.tenant_id,
    scope: binding.scope,
    actor_kind: "worker" as const,
    actor_principal_sha256: binding.actor_principal_sha256,
    authority_subject_sha256: subject,
    leased_job_binding: {
      job_id: jobId,
      job_kind: jobKind,
      job_payload_sha256: payloadSha,
      attempt_count: attempt,
      lease_token_sha256: leaseSha,
    },
    body,
    body_sha256: bodySha256,
  };
  return canonicalContinuationClone({
    ...core,
    command_sha256: canonicalContinuationSha256(core),
  });
}

export function buildAuthenticatedDecisionQueryV1(
  decisionId: string,
  value: unknown,
  verifiedDecisionBinding: VerifiedDecisionCommandBindingV1,
): AuthenticatedDecisionQueryV1 {
  const binding = parseSubjectBinding(verifiedDecisionBinding, ["trusted_host", "operator"], [
    "contract_sha256", "decision_id", "exposure_receipt_sha256",
    "host_task_envelope_sha256", "render_result_sha256",
  ]);
  const boundDecisionId = text(binding.decision_id, "verified_decision_id");
  if (text(decisionId, "decision_query_id") !== boundDecisionId) {
    fail("decision_query_binding", "mismatch");
  }
  sha256(binding.contract_sha256, "verified_contract_sha256");
  sha256(binding.exposure_receipt_sha256, "verified_exposure_receipt_sha256");
  sha256(binding.host_task_envelope_sha256, "verified_host_task_envelope_sha256");
  sha256(binding.render_result_sha256, "verified_render_result_sha256");
  const record = exactRecord(value, [
    "exclude_capsule", "substitute_branch", "view",
  ], "decision_query_body");
  if (!["summary", "full", "counterfactual"].includes(record.view as string)) {
    fail("decision_query_view", "invalid");
  }
  const body: DecisionQueryBodyV1 = canonicalContinuationClone({
    view: record.view,
    exclude_capsule: record.exclude_capsule === null
      ? null : parseCapsuleRef(record.exclude_capsule, "decision_query_exclude_capsule"),
    substitute_branch: record.substitute_branch === null
      ? null : parseBranchRef(record.substitute_branch, "decision_query_substitute_branch"),
  }) as DecisionQueryBodyV1;
  if (body.view !== "counterfactual"
    && (body.exclude_capsule !== null || body.substitute_branch !== null)) {
    fail("decision_query_counterfactual_fields", "forbidden");
  }
  if (body.view === "counterfactual" && binding.actor_kind !== "operator") {
    fail("decision_query_counterfactual_actor", "forbidden");
  }
  const bodySha = canonicalContinuationSha256(body);
  const core = {
    schema_version: "authenticated_decision_query_v1" as const,
    tenant_id: binding.tenant_id,
    scope: binding.scope,
    actor_kind: binding.actor_kind as "trusted_host" | "operator",
    actor_principal_sha256: binding.actor_principal_sha256,
    authority_subject_sha256: binding.authority_subject_sha256,
    decision_id: boundDecisionId,
    body,
    body_sha256: bodySha,
  };
  return canonicalContinuationClone({
    ...core,
    query_sha256: canonicalContinuationSha256(core),
  });
}

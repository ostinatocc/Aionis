import {
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  canonicalUniqueSet,
  type CapsuleCoverageClaimV1,
  type CanonicalJson,
  type HostObservationV1,
  type Sha256,
} from "../continuation/contract.js";
import { buildAuthenticatedCollectorObservationV1 } from
  "../continuation/observation-attestation.js";
import {
  buildHostTaskEnvelopeFromAuthenticatedScopeV1,
  verifyHostTaskEnvelopeV1,
  type HostTaskEnvelopeV1,
} from "../continuation/task-envelope.js";
import {
  verifyWorldObservationSnapshotV1,
  type WorldObservationSnapshotV1,
} from "../continuation/world-snapshot.js";
import type {
  CapsuleMutationV1,
  MemoryItemMutationV1,
} from "../store/continuation-runtime-v1-memory-contract.js";
import {
  buildRecordObservationsCommandV1,
  type HostMemoryInputV1,
  type RecordObservationsCommandV1,
} from "./command.js";

export type MemoryEvidenceObservationRefV1 = Readonly<{
  observation_id: string;
  observation_sha256: Sha256;
  probe_id: string;
  probe_spec_sha256: Sha256;
  observer: HostObservationV1["observer"];
  observer_principal_sha256: Sha256;
  evidence_sha256: Sha256;
}>;

export type MemoryProposalMutationV1 = Readonly<{
  items: readonly MemoryItemMutationV1[];
  relations: readonly [];
  capsules: readonly CapsuleMutationV1[];
}>;

export type MemoryProposalAdmissionInputV1 = Readonly<{
  command: RecordObservationsCommandV1;
  host_task_envelope: HostTaskEnvelopeV1;
  world_snapshot: WorldObservationSnapshotV1;
}>;

export type MemoryProposalAdmissionV1 = Readonly<{
  schema_version: "memory_proposal_admission_v1";
  tenant_id: string;
  scope: string;
  authority_subject_sha256: Sha256;
  source_operation_id: string;
  source_command_sha256: Sha256;
  host_task_envelope_sha256: Sha256;
  world_snapshot_ref: Readonly<{
    world_snapshot_id: string;
    world_snapshot_sha256: Sha256;
  }>;
  mutation: MemoryProposalMutationV1;
  mutation_sha256: Sha256;
  continuity_memory_ids: readonly string[];
  continuity_capsule_ids: readonly string[];
  candidate_memory_ids: readonly string[];
  candidate_capsule_ids: readonly string[];
  admission_sha256: Sha256;
}>;

const INPUT_KEYS = Object.freeze([
  "command",
  "host_task_envelope",
  "world_snapshot",
] as const);

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_memory_proposal_admission_${code}`);
}

function exactInput(value: unknown): MemoryProposalAdmissionInputV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("input_must_be_plain_object");
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  const expected = new Set<string>(INPUT_KEYS);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string")
    || keys.length !== INPUT_KEYS.length
    || keys.some((key) => !expected.has(key as string))) fail("input_shape_invalid");
  const record = value as Readonly<Record<string, unknown>>;
  for (const key of INPUT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("input_shape_invalid");
    }
  }
  return {
    command: record.command as RecordObservationsCommandV1,
    host_task_envelope: record.host_task_envelope as HostTaskEnvelopeV1,
    world_snapshot: record.world_snapshot as WorldObservationSnapshotV1,
  };
}

function verifyCommand(value: RecordObservationsCommandV1): RecordObservationsCommandV1 {
  if (value?.schema_version !== "authenticated_runtime_command_v1"
    || value.operation_kind !== "record_observations"
    || value.actor_kind !== "trusted_host") fail("command_kind_invalid");
  const rebuilt = buildRecordObservationsCommandV1(
    value.operation_id,
    value.body,
    {
      tenant_id: value.tenant_id,
      scope: value.scope,
      actor_kind: value.actor_kind,
      actor_principal_sha256: value.actor_principal_sha256,
    },
  );
  if (canonicalContinuationJson(rebuilt) !== canonicalContinuationJson(value)) {
    fail("command_not_exact_verified_value");
  }
  return rebuilt;
}

function expectedSnapshotObservations(
  command: RecordObservationsCommandV1,
  envelope: HostTaskEnvelopeV1,
): readonly HostObservationV1[] {
  const collector = command.body.collector_observations.map((observation) =>
    buildAuthenticatedCollectorObservationV1({
      schema_version: "host_observation_v1",
      observation_id: observation.observation_id,
      probe_id: observation.probe_id,
      probe_spec_sha256: observation.probe_spec_sha256,
      host_task_envelope_sha256: envelope.host_task_envelope_sha256,
      world_snapshot_id: command.operation_id,
      observed_at: observation.observed_at,
      expires_at: observation.expires_at,
      value: observation.value,
      evidence_sha256: observation.evidence_sha256,
    }, command.actor_principal_sha256));
  return canonicalUniqueSet(
    [...collector, ...command.body.signed_observations],
    (observation) => observation.observation_id,
  );
}

function verifyBindings(args: MemoryProposalAdmissionInputV1): Readonly<{
  command: RecordObservationsCommandV1;
  envelope: HostTaskEnvelopeV1;
  snapshot: WorldObservationSnapshotV1;
}> {
  const command = verifyCommand(args.command);
  const envelope = verifyHostTaskEnvelopeV1(args.host_task_envelope);
  const expectedEnvelope = buildHostTaskEnvelopeFromAuthenticatedScopeV1(
    command.body.host_task,
    { tenant_id: command.tenant_id, scope: command.scope },
  );
  if (canonicalContinuationJson(envelope) !== canonicalContinuationJson(expectedEnvelope)
    || command.authority_subject_sha256 !== envelope.authority_subject_sha256) {
    fail("host_task_envelope_binding_mismatch");
  }
  const snapshot = verifyWorldObservationSnapshotV1(args.world_snapshot);
  if (snapshot.tenant_id !== command.tenant_id
    || snapshot.scope !== command.scope
    || snapshot.authority_subject_sha256 !== command.authority_subject_sha256
    || snapshot.world_snapshot_id !== command.operation_id
    || snapshot.collection_principal_sha256 !== command.actor_principal_sha256
    || canonicalContinuationJson(snapshot.host_task_envelope)
      !== canonicalContinuationJson(envelope)
    || canonicalContinuationJson(snapshot.observations)
      !== canonicalContinuationJson(expectedSnapshotObservations(command, envelope))) {
    fail("world_snapshot_binding_mismatch");
  }
  return { command, envelope, snapshot };
}

function stableId(
  prefix: "mem" | "cap",
  tenantId: string,
  scope: string,
  memoryInputId: string,
): string {
  return `${prefix}_${canonicalContinuationSha256({
    schema_version: prefix === "mem"
      ? "memory_proposal_memory_id_v1"
      : "memory_proposal_capsule_id_v1",
    tenant_id: tenantId,
    scope,
    memory_input_id: memoryInputId,
  })}`;
}

function coverageClaims(
  input: HostMemoryInputV1,
): readonly CapsuleCoverageClaimV1[] {
  return canonicalUniqueSet(input.coverage_claims.map((claim) => {
    const body = canonicalContinuationClone({
      obligation_kind: claim.obligation_kind,
      target_refs: claim.target_refs,
      evidence_requirement: claim.evidence_requirement,
      required_probe_ids: claim.required_probe_ids,
    });
    return canonicalContinuationClone({
      ...body,
      coverage_claim_sha256: canonicalContinuationSha256(body),
    });
  }), (claim) => claim.coverage_claim_sha256);
}

function evidenceRefs(
  input: HostMemoryInputV1,
  snapshot: WorldObservationSnapshotV1,
): readonly MemoryEvidenceObservationRefV1[] {
  const byId = new Map(snapshot.observations.map((observation) => [
    observation.observation_id,
    observation,
  ]));
  return canonicalUniqueSet(input.evidence_observation_ids.map((observationId) => {
    const observation = byId.get(observationId);
    if (!observation) fail("evidence_observation_missing_from_snapshot");
    return canonicalContinuationClone({
      observation_id: observation.observation_id,
      observation_sha256: observation.observation_sha256,
      probe_id: observation.probe_id,
      probe_spec_sha256: observation.probe_spec_sha256,
      observer: observation.observer,
      observer_principal_sha256: observation.observer_principal_sha256,
      evidence_sha256: observation.evidence_sha256,
    });
  }), (ref) => ref.observation_id);
}

function influence(kind: HostMemoryInputV1["kind"]): "use" | "block" {
  if (kind === "constraint" || kind === "counter_evidence") return "block";
  return "use";
}

function isContinuity(kind: HostMemoryInputV1["kind"]): boolean {
  return kind === "current_state" || kind === "verified_fact" || kind === "constraint";
}

function assertAdmissionFence(
  input: HostMemoryInputV1,
  envelope: HostTaskEnvelopeV1,
): void {
  const exactTaskWorkspace = input.applicability.task_signature === envelope.task_signature
    && input.applicability.workspace_signature === envelope.workspace_signature;
  if (isContinuity(input.kind)) {
    if (!exactTaskWorkspace
      || input.applicability.workflow_signature !== envelope.workflow_signature) {
      fail("continuity_applicability_must_be_exact");
    }
    if (input.kind === "current_state"
      && (input.expires_at === null || input.expires_at > envelope.expires_at)) {
      fail("current_state_expiry_outside_task_envelope");
    }
    return;
  }
  if (input.kind === "counter_evidence"
    && (!exactTaskWorkspace
      || input.expires_at === null
      || input.expires_at > envelope.expires_at)) {
    fail("counter_evidence_must_be_scoped_and_expiring");
  }
}

function translateOne(args: Readonly<{
  command: RecordObservationsCommandV1;
  envelope: HostTaskEnvelopeV1;
  snapshot: WorldObservationSnapshotV1;
  input: HostMemoryInputV1;
}>): Readonly<{
  item: MemoryItemMutationV1;
  capsule: CapsuleMutationV1;
  class: "continuity" | "candidate";
}> {
  assertAdmissionFence(args.input, args.envelope);
  const classification = isContinuity(args.input.kind) ? "continuity" : "candidate";
  const memoryId = stableId(
    "mem",
    args.command.tenant_id,
    args.command.scope,
    args.input.memory_input_id,
  );
  const capsuleId = stableId(
    "cap",
    args.command.tenant_id,
    args.command.scope,
    args.input.memory_input_id,
  );
  const observations = evidenceRefs(args.input, args.snapshot);
  const claims = coverageClaims(args.input);
  const observationSet = {
    schema_version: "memory_evidence_observation_ref_set_v1",
    refs: observations,
  } as const;
  const projection = canonicalContinuationClone({
    schema_version: "admitted_memory_projection_v1",
    memory_input_id: args.input.memory_input_id,
    host_task_envelope_sha256: args.envelope.host_task_envelope_sha256,
    world_snapshot_ref: {
      world_snapshot_id: args.snapshot.world_snapshot_id,
      world_snapshot_sha256: args.snapshot.world_snapshot_sha256,
    },
    evidence_observation_refs: observations,
    evidence_observation_set_sha256: canonicalContinuationSha256(observationSet),
    applicability: args.input.applicability,
    content: args.input.projection,
    coverage_claims: claims,
  }) as Readonly<{ readonly [key: string]: CanonicalJson }>;
  const item: MemoryItemMutationV1 = canonicalContinuationClone({
    memory_id: memoryId,
    memory_kind: args.input.kind,
    lifecycle: "active",
    authority: classification === "continuity" ? "verified" : "candidate",
    hydrated: true,
    projection,
    rehydration_ref: null,
    expires_at: args.input.expires_at,
  });
  const capsule: CapsuleMutationV1 = canonicalContinuationClone({
    memory_id: memoryId,
    draft: {
      capsule_id: capsuleId,
      kind: args.input.kind,
      proposed_influence: influence(args.input.kind),
      applicability: {
        task_family: args.envelope.task_family,
        task_signature: args.input.applicability.task_signature,
        workflow_signature: args.input.applicability.workflow_signature,
        workspace_signature: args.input.applicability.workspace_signature,
        producer_agent_id: args.command.actor_principal_sha256,
        owner_agent_id: args.envelope.consumer_agent_id,
        owner_team_id: args.envelope.consumer_team_id,
      },
      projection: args.input.projection,
      // The command boundary accepts only digest-free claim bodies and has
      // already validated their targets/probes. The capsule builder remains
      // the sole authority that canonicalizes and computes claim digests;
      // no host-supplied coverage_claim_sha256 is ever admitted here.
      coverage_claims: args.input.coverage_claims,
      precondition_specs: args.input.precondition_specs,
      evidence_refs: observations.map((observation) => observation.observation_sha256),
      verifier_refs: canonicalUniqueSet(
        observations
          .filter((observation) => observation.observer === "external_verifier")
          .map((observation) => observation.observer_principal_sha256),
        (principal) => principal,
      ),
      conflicts_with: [],
      supersedes: [],
      expires_at: args.input.expires_at,
    },
  });
  return { item, capsule, class: classification };
}

/**
 * Pure admission translator. It writes no database rows and issues no branch,
 * policy, or effect authority; consumers must submit its bounded mutations to
 * the separately authenticated memory and branch workflows.
 */
export function admitRecordObservationsMemoryProposalsV1(
  value: MemoryProposalAdmissionInputV1,
): MemoryProposalAdmissionV1 {
  const verified = verifyBindings(exactInput(value));
  const translated = verified.command.body.memory_inputs.map((input) => translateOne({
    ...verified,
    input,
  }));
  const mutation: MemoryProposalMutationV1 = canonicalContinuationClone({
    items: canonicalUniqueSet(translated.map((entry) => entry.item), (item) => item.memory_id),
    relations: [],
    capsules: canonicalUniqueSet(
      translated.map((entry) => entry.capsule),
      (capsule) => capsule.draft.capsule_id,
    ),
  });
  const continuity = translated.filter((entry) => entry.class === "continuity");
  const candidates = translated.filter((entry) => entry.class === "candidate");
  const body = {
    schema_version: "memory_proposal_admission_v1" as const,
    tenant_id: verified.command.tenant_id,
    scope: verified.command.scope,
    authority_subject_sha256: verified.envelope.authority_subject_sha256,
    source_operation_id: verified.command.operation_id,
    source_command_sha256: verified.command.command_sha256,
    host_task_envelope_sha256: verified.envelope.host_task_envelope_sha256,
    world_snapshot_ref: {
      world_snapshot_id: verified.snapshot.world_snapshot_id,
      world_snapshot_sha256: verified.snapshot.world_snapshot_sha256,
    },
    mutation,
    mutation_sha256: canonicalContinuationSha256(mutation),
    continuity_memory_ids: canonicalUniqueSet(
      continuity.map((entry) => entry.item.memory_id),
      (id) => id,
    ),
    continuity_capsule_ids: canonicalUniqueSet(
      continuity.map((entry) => entry.capsule.draft.capsule_id),
      (id) => id,
    ),
    candidate_memory_ids: canonicalUniqueSet(
      candidates.map((entry) => entry.item.memory_id),
      (id) => id,
    ),
    candidate_capsule_ids: canonicalUniqueSet(
      candidates.map((entry) => entry.capsule.draft.capsule_id),
      (id) => id,
    ),
  };
  return canonicalContinuationClone({
    ...body,
    admission_sha256: canonicalContinuationSha256(body),
  });
}

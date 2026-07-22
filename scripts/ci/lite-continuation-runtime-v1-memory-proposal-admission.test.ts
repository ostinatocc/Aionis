import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { buildExecutionCapsuleV1 } from "../../src/continuation/capsule.js";
import {
  canonicalContinuationSha256,
  type HostObservationV1,
  type Sha256,
} from "../../src/continuation/contract.js";
import {
  buildAuthenticatedCollectorObservationV1,
  buildSignedObserverObservationV1,
} from "../../src/continuation/observation-attestation.js";
import {
  buildHostTaskEnvelopeFromAuthenticatedScopeV1,
  type HostTaskEnvelopeInputV1,
} from "../../src/continuation/task-envelope.js";
import { buildWorldObservationSnapshotV1 } from
  "../../src/continuation/world-snapshot.js";
import {
  buildRecordObservationsCommandV1,
  type AuthenticatedRuntimeCommandBindingV1,
  type HostMemoryInputV1,
} from "../../src/runtime-v1/command.js";
import {
  admitRecordObservationsMemoryProposalsV1,
  type MemoryProposalAdmissionInputV1,
  type MemoryProposalAdmissionV1,
} from "../../src/runtime-v1/memory-proposal-admission.js";

const HOST = "1".repeat(64) as Sha256;
const SOURCE_TASK = "2".repeat(64) as Sha256;
const SOURCE_EVENT = "3".repeat(64) as Sha256;
const PROBE_SPEC_A = "4".repeat(64) as Sha256;
const PROBE_SPEC_B = "5".repeat(64) as Sha256;
const EXTERNAL_KEYS = generateKeyPairSync("ed25519");

function binding(
  tenant = "tenant-a",
  scope = "scope-a",
): AuthenticatedRuntimeCommandBindingV1 {
  return {
    tenant_id: tenant,
    scope,
    actor_kind: "trusted_host",
    actor_principal_sha256: HOST,
  };
}

function hostTask(
  overrides: Partial<HostTaskEnvelopeInputV1> = {},
): HostTaskEnvelopeInputV1 {
  return {
    host_task_id: "task-a",
    episode_id: "episode-a",
    run_id: "run-a",
    consumer_agent_id: "agent-a",
    consumer_team_id: "team-a",
    task_family: "repair",
    task_signature: "task-signature-a",
    workflow_signature: "workflow-signature-a",
    workspace_signature: "workspace-signature-a",
    source_task_sha256: SOURCE_TASK,
    source_event_sha256: SOURCE_EVENT,
    issued_at: "2026-07-21T10:00:00.000Z",
    expires_at: "2026-07-21T12:00:00.000Z",
    ...overrides,
  };
}

function collector(id: "a" | "b") {
  return {
    schema_version: "collector_observation_v1" as const,
    observation_id: `observation-${id}`,
    probe_id: `probe-${id}`,
    probe_spec_sha256: id === "a" ? PROBE_SPEC_A : PROBE_SPEC_B,
    observed_at: id === "a"
      ? "2026-07-21T10:01:00.000Z"
      : "2026-07-21T10:02:00.000Z",
    expires_at: "2026-07-21T11:30:00.000Z",
    value: {
      kind: "capability" as const,
      capability_id: `capability-${id}`,
      version: "1.0.0",
      presence: "present" as const,
    },
    evidence_sha256: (id === "a" ? "6" : "7").repeat(64) as Sha256,
  };
}

function memoryInput(
  id: string,
  kind: HostMemoryInputV1["kind"],
  overrides: Readonly<Record<string, unknown>> = {},
): HostMemoryInputV1 {
  const target = { kind: "capability" as const, ref: `capability-${id}` };
  return {
    memory_input_id: id,
    kind,
    applicability: {
      task_signature: "task-signature-a",
      workflow_signature: "workflow-signature-a",
      workspace_signature: "workspace-signature-a",
    },
    projection: {
      summary: `Remember ${id}.`,
      next_action: kind === "procedure" ? `Apply ${id}.` : null,
      target_refs: [target],
      workflow_steps: kind === "procedure" ? [`Apply ${id}.`] : [],
      acceptance_statements: [`${id} remains verified.`],
    },
    coverage_claims: [{
      obligation_kind: kind === "constraint" || kind === "counter_evidence"
        ? "prohibition"
        : "required_state",
      target_refs: [target],
      evidence_requirement: "runtime_state",
      required_probe_ids: [],
    }],
    precondition_specs: [],
    evidence_observation_ids: ["observation-a"],
    expires_at: "2026-07-21T11:00:00.000Z",
    ...overrides,
  } as HostMemoryInputV1;
}

function scenario(args: Readonly<{
  operationId?: string;
  tenant?: string;
  scope?: string;
  task?: HostTaskEnvelopeInputV1;
  memoryInputs: readonly HostMemoryInputV1[];
  collectors?: readonly ReturnType<typeof collector>[];
  includeExternal?: boolean;
}>): MemoryProposalAdmissionInputV1 {
  const operationId = args.operationId ?? "snapshot-a";
  const tenant = args.tenant ?? "tenant-a";
  const scope = args.scope ?? "scope-a";
  const task = args.task ?? hostTask();
  const authenticated = binding(tenant, scope);
  const envelope = buildHostTaskEnvelopeFromAuthenticatedScopeV1(task, {
    tenant_id: tenant,
    scope,
  });
  const external = args.includeExternal
    ? [buildSignedObserverObservationV1({
      schema_version: "host_observation_v1",
      observation_id: "observation-external",
      probe_id: "probe-external",
      probe_spec_sha256: "8".repeat(64),
      host_task_envelope_sha256: envelope.host_task_envelope_sha256,
      world_snapshot_id: operationId,
      observed_at: "2026-07-21T10:03:00.000Z",
      expires_at: "2026-07-21T11:30:00.000Z",
      value: {
        kind: "verifier",
        verifier_id: "external-verifier-a",
        config_sha256: "9".repeat(64),
        result: "passed",
        fresh_process: true,
        after_agent_exit: true,
      },
      evidence_sha256: "a".repeat(64),
      observer: "external_verifier",
    }, EXTERNAL_KEYS.privateKey)]
    : [];
  const command = buildRecordObservationsCommandV1(operationId, {
    schema_version: "record_observations_body_v1",
    host_task: task,
    memory_inputs: args.memoryInputs,
    collector_observations: args.collectors ?? [collector("a"), collector("b")],
    signed_observations: external,
  }, authenticated);
  const collectorObservations = command.body.collector_observations.map((observation) =>
    buildAuthenticatedCollectorObservationV1({
      schema_version: "host_observation_v1",
      observation_id: observation.observation_id,
      probe_id: observation.probe_id,
      probe_spec_sha256: observation.probe_spec_sha256,
      host_task_envelope_sha256: envelope.host_task_envelope_sha256,
      world_snapshot_id: operationId,
      observed_at: observation.observed_at,
      expires_at: observation.expires_at,
      value: observation.value,
      evidence_sha256: observation.evidence_sha256,
    }, HOST));
  const snapshot = buildWorldObservationSnapshotV1({
    tenant_id: tenant,
    scope,
    authority_subject_sha256: envelope.authority_subject_sha256,
    world_snapshot_id: operationId,
    host_task_envelope: envelope,
    collection_principal_sha256: HOST,
    observations: [...collectorObservations, ...external],
    created_at: "2026-07-21T10:05:00.000Z",
  });
  return { command, host_task_envelope: envelope, world_snapshot: snapshot };
}

function admit(input: MemoryProposalAdmissionInputV1): MemoryProposalAdmissionV1 {
  return admitRecordObservationsMemoryProposalsV1(input);
}

test("translation is deterministic, canonical-order independent, immutable, and store-compatible", () => {
  const current = memoryInput("current", "current_state");
  const constraint = memoryInput("constraint", "constraint");
  const procedure = memoryInput("procedure", "procedure", {
    applicability: {
      task_signature: null,
      workflow_signature: null,
      workspace_signature: null,
    },
    evidence_observation_ids: ["observation-b", "observation-a"],
  });
  const first = scenario({
    memoryInputs: [procedure, current, constraint],
    collectors: [collector("b"), collector("a")],
  });
  const second = scenario({
    memoryInputs: [constraint, procedure, current],
    collectors: [collector("a"), collector("b")],
  });
  const admitted = admit(first);
  assert.deepEqual(admitted, admit(second));
  assert.equal(Object.isFrozen(admitted), true);
  assert.equal(Object.isFrozen(admitted.mutation), true);
  assert.equal(Object.isFrozen(admitted.mutation.items[0]!.projection), true);
  assert.deepEqual(Object.keys(admitted).sort(), [
    "admission_sha256", "authority_subject_sha256", "candidate_capsule_ids",
    "candidate_memory_ids", "continuity_capsule_ids", "continuity_memory_ids",
    "host_task_envelope_sha256", "mutation", "mutation_sha256", "schema_version",
    "scope", "source_command_sha256", "source_operation_id", "tenant_id",
    "world_snapshot_ref",
  ].sort());
  assert.equal(admitted.continuity_memory_ids.length, 2);
  assert.equal(admitted.continuity_capsule_ids.length, 2);
  assert.equal(admitted.candidate_memory_ids.length, 1);
  assert.equal(admitted.candidate_capsule_ids.length, 1);
  assert.equal(admitted.mutation.relations.length, 0);
  for (const item of admitted.mutation.items) {
    assert.equal(item.lifecycle, "active");
    assert.equal(item.authority, item.memory_kind === "procedure" ? "candidate" : "verified");
  }
  const capsuleByKind = new Map(admitted.mutation.capsules.map((entry) => [
    entry.draft.kind,
    entry,
  ]));
  assert.equal(capsuleByKind.get("current_state")?.draft.proposed_influence, "use");
  assert.equal(capsuleByKind.get("constraint")?.draft.proposed_influence, "block");
  assert.equal(capsuleByKind.get("procedure")?.draft.proposed_influence, "use");
  for (const capsule of admitted.mutation.capsules) {
    const item = admitted.mutation.items.find((value) => value.memory_id === capsule.memory_id)!;
    const built = buildExecutionCapsuleV1({
      tenant_id: admitted.tenant_id,
      scope: admitted.scope,
      capsule_revision: 1,
      parent_capsule_sha256: null,
      source: {
        memory_id: item.memory_id,
        source_commit_id: "commit-a",
        source_projection_sha256: canonicalContinuationSha256(item.projection),
      },
      draft: { ...capsule.draft, created_at: first.world_snapshot.created_at },
    });
    assert.equal(built.source.memory_id, item.memory_id);
  }
  assert.equal(
    canonicalContinuationSha256(admitted.mutation),
    admitted.mutation_sha256,
  );
  const { admission_sha256: _digest, ...body } = admitted;
  assert.equal(canonicalContinuationSha256(body), admitted.admission_sha256);
});

test("IDs are namespace-derived and host ID injection is rejected", () => {
  const base = scenario({ memoryInputs: [memoryInput("host-chosen-id", "procedure")] });
  const admitted = admit(base);
  const item = admitted.mutation.items[0]!;
  const capsule = admitted.mutation.capsules[0]!;
  assert.match(item.memory_id, /^mem_[0-9a-f]{64}$/u);
  assert.match(capsule.draft.capsule_id, /^cap_[0-9a-f]{64}$/u);
  assert.notEqual(item.memory_id, "host-chosen-id");
  assert.notEqual(capsule.draft.capsule_id, "host-chosen-id");
  const otherScope = admit(scenario({
    scope: "scope-other",
    memoryInputs: [memoryInput("host-chosen-id", "procedure")],
  }));
  assert.notEqual(otherScope.mutation.items[0]!.memory_id, item.memory_id);
  assert.notEqual(
    otherScope.mutation.capsules[0]!.draft.capsule_id,
    capsule.draft.capsule_id,
  );

  const injected = JSON.parse(JSON.stringify(base.command)) as any;
  injected.body.memory_inputs[0].memory_id = "attacker-memory-id";
  injected.body.memory_inputs[0].capsule_id = "attacker-capsule-id";
  injected.body_sha256 = canonicalContinuationSha256(injected.body);
  const { command_sha256: _old, ...commandBody } = injected;
  injected.command_sha256 = canonicalContinuationSha256(commandBody);
  assert.throws(
    () => admit({ ...base, command: injected }),
    /memory_input_shape_invalid|command_not_exact_verified_value/u,
  );
  assert.throws(
    () => admit({ ...base, extra: true } as never),
    /input_shape_invalid/u,
  );
});

test("continuity is exact-scoped, current state is bounded, and procedure stays candidate", () => {
  const generalizedProcedure = admit(scenario({
    memoryInputs: [memoryInput("procedure", "procedure", {
      applicability: {
        task_signature: null,
        workflow_signature: null,
        workspace_signature: null,
      },
      expires_at: null,
    })],
  }));
  assert.equal(generalizedProcedure.mutation.items[0]!.authority, "candidate");
  assert.deepEqual(generalizedProcedure.continuity_memory_ids, []);
  assert.equal(generalizedProcedure.candidate_memory_ids.length, 1);

  for (const [name, input, pattern] of [
    ["task", memoryInput("fact", "verified_fact", {
      applicability: {
        task_signature: null,
        workflow_signature: "workflow-signature-a",
        workspace_signature: "workspace-signature-a",
      },
    }), /continuity_applicability_must_be_exact/u],
    ["workflow", memoryInput("constraint", "constraint", {
      applicability: {
        task_signature: "task-signature-a",
        workflow_signature: null,
        workspace_signature: "workspace-signature-a",
      },
    }), /continuity_applicability_must_be_exact/u],
    ["no expiry", memoryInput("state", "current_state", { expires_at: null }),
      /memory_input_expires_at_required_for_state_bound_memory/u],
    ["late expiry", memoryInput("state", "current_state", {
      expires_at: "2026-07-21T12:00:00.001Z",
    }), /memory_input_expires_at_outside_evidence_or_task_window/u],
  ] as const) {
    assert.throws(
      () => admit(scenario({ memoryInputs: [input] })),
      pattern,
      name,
    );
  }
});

test("counter-evidence can only be task/workspace exact, expiring candidate evidence", () => {
  const valid = admit(scenario({
    memoryInputs: [memoryInput("counter", "counter_evidence", {
      applicability: {
        task_signature: "task-signature-a",
        workflow_signature: null,
        workspace_signature: "workspace-signature-a",
      },
    })],
  }));
  assert.equal(valid.mutation.items[0]!.authority, "candidate");
  assert.equal(valid.mutation.capsules[0]!.draft.proposed_influence, "block");
  assert.equal(valid.candidate_memory_ids.length, 1);
  for (const [input, pattern] of [
    [memoryInput("counter", "counter_evidence", {
      applicability: {
        task_signature: null,
        workflow_signature: null,
        workspace_signature: "workspace-signature-a",
      },
    }), /counter_evidence_must_be_scoped_and_expiring/u],
    [memoryInput("counter", "counter_evidence", { expires_at: null }),
      /memory_input_expires_at_required_for_state_bound_memory/u],
    [memoryInput("counter", "counter_evidence", {
      expires_at: "2026-07-21T12:00:00.001Z",
    }), /memory_input_expires_at_outside_evidence_or_task_window/u],
  ] as const) {
    assert.throws(
      () => admit(scenario({ memoryInputs: [input] })),
      pattern,
    );
  }
});

test("projection binds exact snapshot, evidence ref set, coverage digests, and verifier identity", () => {
  const input = memoryInput("evidence", "verified_fact", {
    evidence_observation_ids: ["observation-external", "observation-a"],
  });
  const current = scenario({ memoryInputs: [input], includeExternal: true });
  const admitted = admit(current);
  const projection = admitted.mutation.items[0]!.projection as any;
  assert.deepEqual(projection.world_snapshot_ref, admitted.world_snapshot_ref);
  assert.deepEqual(
    projection.evidence_observation_refs.map((ref: any) => ref.observation_id),
    ["observation-a", "observation-external"],
  );
  assert.equal(projection.evidence_observation_refs[1].observer, "external_verifier");
  assert.equal(
    projection.evidence_observation_set_sha256,
    canonicalContinuationSha256({
      schema_version: "memory_evidence_observation_ref_set_v1",
      refs: projection.evidence_observation_refs,
    }),
  );
  assert.equal(
    projection.coverage_claims[0].coverage_claim_sha256,
    canonicalContinuationSha256({
      obligation_kind: projection.coverage_claims[0].obligation_kind,
      target_refs: projection.coverage_claims[0].target_refs,
      evidence_requirement: projection.coverage_claims[0].evidence_requirement,
      required_probe_ids: projection.coverage_claims[0].required_probe_ids,
    }),
  );
  assert.deepEqual(
    admitted.mutation.capsules[0]!.draft.verifier_refs,
    [projection.evidence_observation_refs[1].observer_principal_sha256],
  );

  const missingObservationSnapshot = scenario({
    operationId: current.command.operation_id,
    memoryInputs: [memoryInput("unrelated", "procedure")],
    collectors: [collector("a")],
  }).world_snapshot;
  assert.throws(
    () => admit({ ...current, world_snapshot: missingObservationSnapshot }),
    /world_snapshot_binding_mismatch/u,
  );
  const otherEnvelope = scenario({
    operationId: current.command.operation_id,
    task: hostTask({ host_task_id: "task-other" }),
    memoryInputs: [memoryInput("other", "procedure")],
  }).host_task_envelope;
  assert.throws(
    () => admit({ ...current, host_task_envelope: otherEnvelope }),
    /host_task_envelope_binding_mismatch/u,
  );
});

test("command validation rejects empty evidence and unbacked observed-evidence coverage probes", () => {
  assert.throws(
    () => scenario({
      memoryInputs: [memoryInput("empty-evidence", "procedure", {
        evidence_observation_ids: [],
      })],
    }),
    /memory_input_evidence_not_in_observation_batch/u,
  );
  for (const evidenceRequirement of ["trusted_host", "external_verifier"] as const) {
    assert.throws(
      () => scenario({
        memoryInputs: [memoryInput(`unbacked-${evidenceRequirement}`, "procedure", {
          coverage_claims: [{
            obligation_kind: "required_state",
            target_refs: [{
              kind: "capability",
              ref: `capability-unbacked-${evidenceRequirement}`,
            }],
            evidence_requirement: evidenceRequirement,
            required_probe_ids: ["probe-a"],
          }],
          precondition_specs: [],
        })],
      }),
      /memory_input_coverage_claim_probes_not_serve_phase_preconditions/u,
      evidenceRequirement,
    );
  }
});

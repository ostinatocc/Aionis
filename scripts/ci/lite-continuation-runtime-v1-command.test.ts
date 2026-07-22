import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalContinuationSha256,
  canonicalSha256Without,
} from "../../src/continuation/contract.ts";
import { buildEffectTreatmentDeltaSetV1 } from
  "../../src/continuation/effect-certificate.ts";
import { buildEffectEvidenceMemberSetV1 } from "../../src/continuation/episode.ts";
import {
  continuationAuthoritySubjectSha256V1,
  type HostTaskEnvelopeInputV1,
} from "../../src/continuation/task-envelope.ts";
import {
  buildAuthenticatedDecisionQueryV1,
  buildAuthorityDecisionCommandV1,
  buildCreateContinuationCommandV1,
  buildRecordObservationsCommandV1,
  buildRecordOutcomeCommandV1,
  buildWorkerCompletionCommandV1,
  parseRuntimeCommandScopeSelectorV1,
  type AuthenticatedRuntimeCommandBindingV1,
  type VerifiedAuthorityCommandBindingV1,
  type VerifiedDecisionCommandBindingV1,
  type VerifiedLeasedJobCommandBindingV1,
  type VerifiedSnapshotCommandBindingV1,
} from "../../src/runtime-v1/command.ts";
import { operationRequestFromVerifiedCommandV1 } from
  "../../src/runtime-v1/operation-request.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const TASK_FAMILY = "repair";

function subject(tenant = "tenant-a", scope = "scope-a", taskFamily = TASK_FAMILY) {
  return continuationAuthoritySubjectSha256V1({
    tenant_id: tenant,
    scope,
    task_family: taskFamily,
  });
}

function hostBinding(
  overrides: Partial<AuthenticatedRuntimeCommandBindingV1> = {},
): AuthenticatedRuntimeCommandBindingV1 {
  return {
    tenant_id: "tenant-a",
    scope: "scope-a",
    actor_kind: "trusted_host",
    actor_principal_sha256: SHA_A,
    ...overrides,
  };
}

function taskInput(): HostTaskEnvelopeInputV1 {
  return {
    host_task_id: "task-a",
    episode_id: "episode-a",
    run_id: "run-a",
    consumer_agent_id: "agent-a",
    consumer_team_id: null,
    task_family: TASK_FAMILY,
    task_signature: "task-signature-a",
    workflow_signature: null,
    workspace_signature: "workspace-a",
    source_task_sha256: SHA_B,
    source_event_sha256: SHA_C,
    issued_at: "2026-07-21T10:00:00.000Z",
    expires_at: "2026-07-21T12:00:00.000Z",
  };
}

function observationsBody() {
  return {
    schema_version: "record_observations_body_v1",
    host_task: taskInput(),
    memory_inputs: [],
    collector_observations: [],
    signed_observations: [],
  };
}

function collectorObservation() {
  return {
    schema_version: "collector_observation_v1",
    observation_id: "observation-a",
    probe_id: "probe-a",
    probe_spec_sha256: SHA_A,
    observed_at: "2026-07-21T10:01:00.000Z",
    expires_at: "2026-07-21T11:00:00.000Z",
    value: {
      kind: "capability",
      capability_id: "runtime-capability-a",
      version: "1.0.0",
      presence: "present",
    },
    evidence_sha256: SHA_B,
  };
}

function memoryInput() {
  return {
    memory_input_id: "memory-input-a",
    kind: "procedure",
    applicability: {
      task_signature: "task-signature-a",
      workflow_signature: null,
      workspace_signature: "workspace-a",
    },
    projection: {
      summary: "Use the verified runtime capability.",
      next_action: "Invoke runtime-capability-a.",
      target_refs: [{ kind: "capability", ref: "runtime-capability-a" }],
      workflow_steps: [],
      acceptance_statements: ["The capability remains present."],
    },
    coverage_claims: [{
      obligation_kind: "next_action",
      target_refs: [{ kind: "capability", ref: "runtime-capability-a" }],
      evidence_requirement: "runtime_state",
      required_probe_ids: [],
    }],
    precondition_specs: [],
    evidence_observation_ids: ["observation-a"],
    expires_at: "2026-07-21T11:00:00.000Z",
  };
}

function snapshotBinding(
  overrides: Partial<VerifiedSnapshotCommandBindingV1> = {},
): VerifiedSnapshotCommandBindingV1 {
  const tenant = overrides.tenant_id ?? "tenant-a";
  const scope = overrides.scope ?? "scope-a";
  const taskFamily = overrides.task_family ?? TASK_FAMILY;
  return {
    tenant_id: tenant,
    scope,
    actor_kind: "trusted_host",
    actor_principal_sha256: SHA_A,
    task_family: taskFamily,
    authority_subject_sha256: subject(tenant, scope, taskFamily),
    world_snapshot_id: "snapshot-a",
    world_snapshot_sha256: SHA_B,
    ...overrides,
  };
}

function continuationBody() {
  return {
    schema_version: "create_continuation_body_v1",
    world_snapshot_ref: {
      world_snapshot_id: "snapshot-a",
      world_snapshot_sha256: SHA_B,
    },
    obligations: [{
      obligation_id: "obligation-a",
      kind: "required_state",
      requirement: "hard",
      statement: "Preserve the verified current state",
      target_refs: [{ kind: "capability", ref: "runtime-capability-a" }],
      required_probe_ids: [],
      evidence_requirement: "runtime_state",
      source_refs: [],
    }],
    render_budget_bytes: 4_096,
  };
}

function decisionBinding(
  actor: "trusted_host" | "operator" = "trusted_host",
  overrides: Partial<VerifiedDecisionCommandBindingV1> = {},
): VerifiedDecisionCommandBindingV1 {
  const tenant = overrides.tenant_id ?? "tenant-a";
  const scope = overrides.scope ?? "scope-a";
  const taskFamily = overrides.task_family ?? TASK_FAMILY;
  return {
    tenant_id: tenant,
    scope,
    actor_kind: actor,
    actor_principal_sha256: SHA_A,
    task_family: taskFamily,
    authority_subject_sha256: subject(tenant, scope, taskFamily),
    decision_id: "decision-a",
    contract_sha256: SHA_B,
    render_result_sha256: SHA_D,
    exposure_receipt_sha256: SHA_C,
    host_task_envelope_sha256: SHA_D,
    ...overrides,
  };
}

function outcomeBody() {
  return {
    schema_version: "record_outcome_body_v1",
    decision_ref: {
      decision_id: "decision-a",
      contract_sha256: SHA_B,
      exposure_receipt_sha256: SHA_C,
    },
    use_receipt: {
      schema_version: "host_capsule_use_receipt_v1",
      decision_id: "decision-a",
      use_id: "use-a",
      observed_at: "2026-07-21T10:30:00.000Z",
      render_result_sha256: SHA_D,
      capsule_uses: [],
      evidence_sha256: SHA_A,
    },
    outcome_receipt: {
      schema_version: "host_outcome_receipt_v1",
      decision_id: "decision-a",
      observed_at: "2026-07-21T10:31:00.000Z",
      outcome: "succeeded",
      outcome_code: "completed",
      evidence_sha256: SHA_B,
      summary: null,
    },
  };
}

function authorityBinding(
  overrides: Partial<VerifiedAuthorityCommandBindingV1> = {},
): VerifiedAuthorityCommandBindingV1 {
  const tenant = overrides.tenant_id ?? "tenant-a";
  const scope = overrides.scope ?? "scope-a";
  const taskFamily = overrides.task_family ?? TASK_FAMILY;
  return {
    tenant_id: tenant,
    scope,
    actor_kind: "operator",
    actor_principal_sha256: SHA_A,
    task_family: taskFamily,
    authority_subject_sha256: subject(tenant, scope, taskFamily),
    ...overrides,
  };
}

function authorityBody() {
  return {
    schema_version: "authority_decision_body_v1",
    expected_head: { revision: 1, head_sha256: SHA_B },
    decision: {
      kind: "branch_reject",
      candidate: {
        branch_id: "candidate-a",
        branch_revision: 2,
        manifest_sha256: SHA_C,
      },
      reason_codes: ["verified_harm"],
      evidence_sha256s: [SHA_D],
    },
  };
}

function workerBinding(
  overrides: Partial<VerifiedLeasedJobCommandBindingV1> = {},
): VerifiedLeasedJobCommandBindingV1 {
  const tenant = overrides.tenant_id ?? "tenant-a";
  const scope = overrides.scope ?? "scope-a";
  const taskFamily = overrides.task_family ?? TASK_FAMILY;
  return {
    tenant_id: tenant,
    scope,
    actor_kind: "worker",
    actor_principal_sha256: SHA_A,
    task_family: taskFamily,
    authority_subject_sha256: subject(tenant, scope, taskFamily),
    job_id: "job-a",
    job_kind: "ann",
    job_payload_sha256: SHA_B,
    attempt_count: 1,
    lease_token_sha256: SHA_C,
    ...overrides,
  };
}

function workerBody() {
  return {
    schema_version: "worker_completion_body_v1",
    completion: {
      status: "succeeded",
      output: {
        kind: "ann",
        index_receipt: { index_id: "index-a", revision: 1 },
      },
    },
  };
}

test("five command parsers produce immutable self-digested authenticated commands", () => {
  const observationSource = observationsBody();
  const observationCommand = buildRecordObservationsCommandV1(
    "operation-observe",
    observationSource,
    hostBinding(),
  );
  const commands = [
    observationCommand,
    buildCreateContinuationCommandV1("operation-continue", continuationBody(), snapshotBinding()),
    buildRecordOutcomeCommandV1("operation-outcome", outcomeBody(), decisionBinding()),
    buildAuthorityDecisionCommandV1("operation-authority", authorityBody(), authorityBinding()),
    buildWorkerCompletionCommandV1("operation-worker", workerBody(), workerBinding()),
  ];
  assert.deepEqual(commands.map((command) => command.operation_kind), [
    "record_observations",
    "create_continuation",
    "record_outcome",
    "authority_decision",
    "worker_completion",
  ]);
  for (const command of commands) {
    assert.equal(command.body_sha256, canonicalContinuationSha256(command.body));
    assert.equal(command.command_sha256, canonicalSha256Without(command, "command_sha256"));
    assert.equal(Object.isFrozen(command), true);
    assert.equal(Object.isFrozen(command.body), true);
    const operationRequest = operationRequestFromVerifiedCommandV1(command);
    assert.equal(
      canonicalContinuationSha256(operationRequest),
      command.command_sha256,
    );
    assert.equal(Object.hasOwn(operationRequest, "command_sha256"), false);
    assert.equal(Object.isFrozen(operationRequest), true);
  }
  (observationSource as { host_task: { host_task_id: string } }).host_task.host_task_id =
    "caller-mutated";
  assert.equal(observationCommand.body.host_task.host_task_id, "task-a");
});

test("operation requests keep authenticated identity and reject forged command envelopes", () => {
  const command = buildRecordObservationsCommandV1(
    "operation-request",
    observationsBody(),
    hostBinding(),
  );
  const request = operationRequestFromVerifiedCommandV1(command);
  assert.equal(request.tenant_id, command.tenant_id);
  assert.equal(request.scope, command.scope);
  assert.equal(request.actor_principal_sha256, command.actor_principal_sha256);
  assert.equal(request.authority_subject_sha256, command.authority_subject_sha256);
  assert.deepEqual(request.body, command.body);

  assert.throws(
    () => operationRequestFromVerifiedCommandV1({
      ...command,
      actor_principal_sha256: SHA_D,
    }),
    /operation_request_command_digest_invalid/u,
  );
  assert.throws(
    () => operationRequestFromVerifiedCommandV1({
      ...command,
      hidden: true,
    } as never),
    /operation_request_command_shape_invalid/u,
  );
});

test("scope selector is a separate exact authorization input", () => {
  assert.deepEqual(parseRuntimeCommandScopeSelectorV1({ scope: "scope-a" }), {
    scope: "scope-a",
  });
  assert.throws(
    () => parseRuntimeCommandScopeSelectorV1({ scope: "scope-a", tenant_id: "tenant-a" }),
    /scope_selector_shape_invalid/u,
  );
});

test("command digests change across tenant, scope, actor, principal, and business body", () => {
  const baseline = buildRecordObservationsCommandV1(
    "same-operation",
    observationsBody(),
    hostBinding(),
  );
  const variants = [
    buildRecordObservationsCommandV1(
      "same-operation",
      observationsBody(),
      hostBinding({ tenant_id: "tenant-b" }),
    ),
    buildRecordObservationsCommandV1(
      "same-operation",
      observationsBody(),
      hostBinding({ scope: "scope-b" }),
    ),
    buildRecordObservationsCommandV1(
      "same-operation",
      observationsBody(),
      hostBinding({ actor_principal_sha256: SHA_D }),
    ),
    buildRecordObservationsCommandV1(
      "same-operation",
      { ...observationsBody(), host_task: { ...taskInput(), run_id: "run-b" } },
      hostBinding(),
    ),
  ];
  for (const variant of variants) {
    assert.notEqual(variant.command_sha256, baseline.command_sha256);
  }
  assert.throws(
    () => buildRecordObservationsCommandV1(
      "same-operation",
      observationsBody(),
      { ...hostBinding(), actor_kind: "operator" },
    ),
    /actor_kind_invalid/u,
  );
});

test("business bodies reject all authenticated-domain injection", () => {
  for (const [field, injected] of [
    ["tenant_id", "tenant-b"],
    ["scope", "scope-b"],
    ["actor_kind", "operator"],
    ["actor_principal_sha256", SHA_D],
    ["authority_subject_sha256", SHA_C],
    ["operation_kind", "authority_decision"],
  ] as const) {
    assert.throws(
      () => buildRecordObservationsCommandV1(
        `inject-${field}`,
        { ...observationsBody(), [field]: injected },
        hostBinding(),
      ),
      /record_observations_body_shape_invalid/u,
    );
  }
  assert.throws(
    () => buildRecordObservationsCommandV1("nested-domain", {
      ...observationsBody(),
      host_task: { ...taskInput(), tenant_id: "tenant-b" },
    }, hostBinding()),
    /unknown or missing fields/u,
  );
});

test("observation memory inputs are evidence-bound proposals, never direct authority mutations", () => {
  const command = buildRecordObservationsCommandV1("typed-memory", {
    ...observationsBody(),
    collector_observations: [collectorObservation()],
    memory_inputs: [memoryInput()],
  }, hostBinding());
  assert.equal(command.body.memory_inputs.length, 1);
  assert.equal("authority" in command.body.memory_inputs[0]!, false);
  assert.equal("lifecycle" in command.body.memory_inputs[0]!, false);
  assert.equal("capsule_id" in command.body.memory_inputs[0]!, false);

  assert.throws(() => buildRecordObservationsCommandV1("raw-mutation", {
    ...observationsBody(),
    memory_mutation: { items: [], relations: [], capsules: [] },
  }, hostBinding()), /record_observations_body_shape_invalid/u);
  assert.throws(() => buildRecordObservationsCommandV1("authority-injection", {
    ...observationsBody(),
    collector_observations: [collectorObservation()],
    memory_inputs: [{ ...memoryInput(), authority: "authoritative" }],
  }, hostBinding()), /memory_input_shape_invalid/u);
  assert.throws(() => buildRecordObservationsCommandV1("missing-evidence", {
    ...observationsBody(),
    collector_observations: [collectorObservation()],
    memory_inputs: [{ ...memoryInput(), evidence_observation_ids: ["not-in-batch"] }],
  }, hostBinding()), /memory_input_evidence_not_in_observation_batch/u);
  assert.throws(() => buildRecordObservationsCommandV1("cross-task-memory", {
    ...observationsBody(),
    collector_observations: [collectorObservation()],
    memory_inputs: [{
      ...memoryInput(),
      applicability: { ...memoryInput().applicability, task_signature: "other-task" },
    }],
  }, hostBinding()), /memory_input_task_signature_outside_task_envelope/u);
  assert.throws(() => buildRecordObservationsCommandV1("unbounded-fact", {
    ...observationsBody(),
    collector_observations: [collectorObservation()],
    memory_inputs: [{
      ...memoryInput(),
      kind: "verified_fact",
      expires_at: null,
    }],
  }, hostBinding()), /memory_input_expires_at_required_for_state_bound_memory/u);
  assert.throws(() => buildRecordObservationsCommandV1("stale-evidence-window", {
    ...observationsBody(),
    collector_observations: [collectorObservation()],
    memory_inputs: [{
      ...memoryInput(),
      kind: "constraint",
      expires_at: "2026-07-21T11:00:00.001Z",
    }],
  }, hostBinding()), /memory_input_expires_at_outside_evidence_or_task_window/u);
});

test("continuation accepts only snapshot refs, obligations, and render policy", () => {
  for (const field of ["authority", "candidates", "policy", "assignment", "effect", "lifecycle"] as const) {
    assert.throws(
      () => buildCreateContinuationCommandV1(
        `continuation-${field}`,
        { ...continuationBody(), [field]: {} },
        snapshotBinding(),
      ),
      /create_continuation_body_shape_invalid/u,
    );
  }
  assert.throws(
    () => buildCreateContinuationCommandV1(
      "wrong-snapshot",
      { ...continuationBody(), world_snapshot_ref: {
        world_snapshot_id: "snapshot-b",
        world_snapshot_sha256: SHA_B,
      } },
      snapshotBinding(),
    ),
    /world_snapshot_binding_mismatch/u,
  );
  assert.throws(
    () => buildCreateContinuationCommandV1(
      "wrong-subject",
      continuationBody(),
      { ...snapshotBinding(), authority_subject_sha256: SHA_D },
    ),
    /authority_subject_mismatch/u,
  );
  assert.throws(
    () => buildCreateContinuationCommandV1(
      "render-budget-too-small",
      { ...continuationBody(), render_budget_bytes: 1_023 },
      snapshotBinding(),
    ),
    /render_budget_bytes_out_of_range/u,
  );
});

test("authority decisions are semantic tagged actions, never caller manifests or policies", () => {
  assert.throws(
    () => buildAuthorityDecisionCommandV1("manifest-injection", {
      ...authorityBody(),
      decision: { kind: "branch_reject", manifest: {}, policy: {},
        candidate: authorityBody().decision.candidate, reason_codes: ["blocked"],
        evidence_sha256s: [SHA_D] },
    }, authorityBinding()),
    /authority_branch_action_shape_invalid/u,
  );
  assert.throws(
    () => buildAuthorityDecisionCommandV1("unknown-action", {
      ...authorityBody(),
      decision: { kind: "install_manifest", manifest: {} },
    }, authorityBinding()),
    /authority_decision_kind_invalid/u,
  );
});

test("authority lifecycle and learning transitions carry exact CAS and evidence", () => {
  const lifecycle = buildAuthorityDecisionCommandV1("lifecycle-cas", {
    schema_version: "authority_decision_body_v1",
    expected_head: { revision: 3, head_sha256: SHA_A },
    decision: {
      kind: "lifecycle_suppress",
      memory_id: "memory-a",
      expected_memory_head: { revision: 7, head_sha256: SHA_B },
      reason_codes: ["stale_world_state"],
    },
  }, authorityBinding());
  assert.deepEqual(lifecycle.body.decision, {
    kind: "lifecycle_suppress",
    memory_id: "memory-a",
    expected_memory_head: { revision: 7, head_sha256: SHA_B },
    reason_codes: ["stale_world_state"],
  });

  const archive = buildAuthorityDecisionCommandV1("lifecycle-archive", {
    schema_version: "authority_decision_body_v1",
    expected_head: { revision: 3, head_sha256: SHA_A },
    decision: {
      kind: "lifecycle_archive",
      memory_id: "memory-a",
      expected_memory_head: { revision: 7, head_sha256: SHA_B },
      rehydration_ref: `rehydration:v1:${"e".repeat(64)}`,
      reason_codes: ["retention_window_elapsed"],
    },
  }, authorityBinding());
  assert.equal(
    archive.body.decision.kind === "lifecycle_archive"
      ? archive.body.decision.rehydration_ref
      : null,
    `rehydration:v1:${"e".repeat(64)}`,
  );
  const quarantine = buildAuthorityDecisionCommandV1("lifecycle-quarantine", {
    schema_version: "authority_decision_body_v1",
    expected_head: { revision: 3, head_sha256: SHA_A },
    decision: {
      kind: "lifecycle_quarantine",
      memory_id: "memory-a",
      expected_memory_head: { revision: 7, head_sha256: SHA_B },
      reason_codes: ["poisoning_suspected"],
    },
  }, authorityBinding());
  assert.deepEqual(quarantine.body.decision, {
    kind: "lifecycle_quarantine",
    memory_id: "memory-a",
    expected_memory_head: { revision: 7, head_sha256: SHA_B },
    reason_codes: ["poisoning_suspected"],
  });
  assert.throws(() => buildAuthorityDecisionCommandV1("archive-without-ref", {
    schema_version: "authority_decision_body_v1",
    expected_head: { revision: 3, head_sha256: SHA_A },
    decision: {
      kind: "lifecycle_archive",
      memory_id: "memory-a",
      expected_memory_head: { revision: 7, head_sha256: SHA_B },
      reason_codes: ["retention_window_elapsed"],
    },
  }, authorityBinding()), /authority_lifecycle_archive_action_shape_invalid/u);
  assert.throws(() => buildAuthorityDecisionCommandV1("archive-secret-uri", {
    schema_version: "authority_decision_body_v1",
    expected_head: { revision: 3, head_sha256: SHA_A },
    decision: {
      kind: "lifecycle_archive",
      memory_id: "memory-a",
      expected_memory_head: { revision: 7, head_sha256: SHA_B },
      rehydration_ref: "https://cold-store.example/item?token=secret",
      reason_codes: ["retention_window_elapsed"],
    },
  }, authorityBinding()), /authority_rehydration_ref_invalid/u);

  const advance = buildAuthorityDecisionCommandV1("candidate-advance", {
    schema_version: "authority_decision_body_v1",
    expected_head: { revision: 3, head_sha256: SHA_A },
    decision: {
      kind: "candidate_advance",
      candidate: {
        branch_id: "candidate-a",
        branch_revision: 1,
        manifest_sha256: SHA_C,
      },
      target_state: "shadow",
      reason_codes: ["offline_replay_passed"],
      evidence_sha256s: [SHA_D],
    },
  }, authorityBinding());
  assert.equal(advance.body.decision.kind, "candidate_advance");
  assert.equal(advance.body.decision.target_state, "shadow");

  assert.throws(() => buildAuthorityDecisionCommandV1("candidate-no-evidence", {
    schema_version: "authority_decision_body_v1",
    expected_head: { revision: 3, head_sha256: SHA_A },
    decision: {
      kind: "candidate_advance",
      candidate: {
        branch_id: "candidate-a",
        branch_revision: 1,
        manifest_sha256: SHA_C,
      },
      target_state: "shadow",
      reason_codes: ["offline_replay_passed"],
      evidence_sha256s: [],
    },
  }, authorityBinding()), /authority_candidate_evidence_sha256s_empty/u);
});

test("leased-job binding, not worker body, owns job identity and kind", () => {
  const command = buildWorkerCompletionCommandV1("worker-bound", workerBody(), workerBinding());
  assert.deepEqual(command.leased_job_binding, {
    job_id: "job-a",
    job_kind: "ann",
    job_payload_sha256: SHA_B,
    attempt_count: 1,
    lease_token_sha256: SHA_C,
  });
  assert.throws(
    () => buildWorkerCompletionCommandV1(
      "worker-injection",
      { ...workerBody(), job_id: "job-b" },
      workerBinding(),
    ),
    /worker_completion_body_shape_invalid/u,
  );
  assert.throws(
    () => buildWorkerCompletionCommandV1(
      "worker-kind",
      workerBody(),
      workerBinding({ job_kind: "embedding" }),
    ),
    /worker_output_kind_mismatch/u,
  );
  assert.throws(
    () => buildWorkerCompletionCommandV1(
      "worker-null-family",
      workerBody(),
      {
        ...workerBinding(),
        task_family: null,
        authority_subject_sha256: null,
      } as unknown as VerifiedLeasedJobCommandBindingV1,
    ),
    /verified_job_task_family_text_invalid/u,
  );
  assert.throws(
    () => buildWorkerCompletionCommandV1(
      "worker-null-subject",
      workerBody(),
      {
        ...workerBinding(),
        authority_subject_sha256: null,
      } as unknown as VerifiedLeasedJobCommandBindingV1,
    ),
    /verified_job_authority_subject_sha256_sha256_invalid/u,
  );

  const effectBinding = workerBinding({ job_kind: "effect" });
  const effectPackage = {
    schema_version: "worker_completion_body_v1",
    completion: {
      status: "succeeded",
      output: {
        kind: "effect",
        signed_certificate: { schema_version: "effect_certificate_v1" },
        eligible_decision_set: buildEffectEvidenceMemberSetV1([]),
        treatment_delta_set: buildEffectTreatmentDeltaSetV1([]),
      },
    },
  };
  const effectCommand = buildWorkerCompletionCommandV1(
    "worker-effect",
    effectPackage,
    effectBinding,
  );
  assert.equal(effectCommand.body.completion.status, "succeeded");
  assert.throws(
    () => buildWorkerCompletionCommandV1("worker-effect-incomplete", {
      ...effectPackage,
      completion: {
        status: "succeeded",
        output: {
          kind: "effect",
          signed_certificate: { schema_version: "effect_certificate_v1" },
        },
      },
    }, effectBinding),
    /worker_effect_output_shape_invalid/u,
  );
});

test("outcome uses the shared evidence receipts and rejects unpersisted side channels", () => {
  assert.equal(
    buildRecordOutcomeCommandV1("outcome-shared", outcomeBody(), decisionBinding())
      .body.use_receipt.render_result_sha256,
    SHA_D,
  );
  assert.throws(
    () => buildRecordOutcomeCommandV1("outcome-terminal-extra", {
      ...outcomeBody(),
      terminal_observations: {
        schema_version: "terminal_observations_v1",
        collector_observations: [],
        signed_observations: [],
        expected_effect: "beneficial",
      },
    }, decisionBinding()),
    /record_outcome_body_shape_invalid/u,
  );
});

test("decision queries are authenticated, exact, and counterfactuals require operator authority", () => {
  const summary = buildAuthenticatedDecisionQueryV1("decision-a", {
    view: "summary",
    exclude_capsule: null,
    substitute_branch: null,
  }, decisionBinding());
  assert.equal(summary.body_sha256, canonicalContinuationSha256(summary.body));
  assert.equal(summary.query_sha256, canonicalSha256Without(summary, "query_sha256"));
  assert.throws(
    () => buildAuthenticatedDecisionQueryV1("decision-a", {
      view: "counterfactual",
      exclude_capsule: null,
      substitute_branch: null,
    }, decisionBinding()),
    /counterfactual_actor_forbidden/u,
  );
  assert.doesNotThrow(() => buildAuthenticatedDecisionQueryV1("decision-a", {
    view: "counterfactual",
    exclude_capsule: null,
    substitute_branch: null,
  }, decisionBinding("operator")));
});

test("unknown fields, symbols, accessors, and sparse arrays fail before authority parsing", () => {
  const symbolBody = observationsBody() as Record<PropertyKey, unknown>;
  symbolBody[Symbol("hidden")] = true;
  assert.throws(
    () => buildRecordObservationsCommandV1("symbol", symbolBody, hostBinding()),
    /shape_invalid/u,
  );

  let getterCalls = 0;
  const accessorBody = { ...observationsBody() } as Record<string, unknown>;
  Object.defineProperty(accessorBody, "host_task", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return taskInput();
    },
  });
  assert.throws(
    () => buildRecordObservationsCommandV1("accessor", accessorBody, hostBinding()),
    /shape_invalid/u,
  );
  assert.equal(getterCalls, 0);

  const sparse = continuationBody().obligations as unknown[];
  delete sparse[0];
  assert.throws(
    () => buildCreateContinuationCommandV1(
      "sparse",
      { ...continuationBody(), obligations: sparse },
      snapshotBinding(),
    ),
    /obligations_array_invalid/u,
  );
});
